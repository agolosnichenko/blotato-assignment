/**
 * Outbox relay (T032, D9, contracts/domain-events.md §"Delivery guarantees").
 *
 * Selects unpublished outbox rows, publishes each as a domain event envelope to the
 * `domain-events` queue, and stamps `published_at`. Nothing here treats the outbox row
 * as anything but the record of truth: the queue is delivery only, so losing Redis
 * loses no data (FR-033, SC-011) — a row that fails to publish simply stays unpublished
 * and is retried on the next pass.
 *
 * I5 (final-review.md): each row publishes and stamps inside its *own* transaction, not one
 * shared transaction for the whole batch. A row BullMQ can never accept — a payload it rejects,
 * a shape Redis refuses as part of a key — used to sit forever at the front of the oldest-100
 * selection and abort every pass behind it, since one `Promise.all` rejection rolled back the
 * single transaction the whole batch ran inside. Isolating each row means a poison row's failure
 * can no longer take its successors down with it; `outbox_events.attempts` is incremented so the
 * row is visible (and eventually actionable) instead of silently retried forever in the same spot.
 */

import { eq, isNull, sql } from 'drizzle-orm';
import type { Queue } from 'bullmq';
import type { Database } from '#src/shared/db.ts';
import { outboxEvents } from '#src/modules/comments/infrastructure/schema.ts';

const BATCH_SIZE = 100;

export interface OutboxRelayResult {
  readonly relayed: number;
}

/**
 * Publishes and stamps one row inside its own transaction, re-reading it under `FOR UPDATE SKIP
 * LOCKED` first — the lock now lives at the row level rather than on the batch `SELECT`, since
 * each row is its own transaction. `SKIP LOCKED` returning nothing (another runner already
 * claimed it) and an already-`published_at` row (it was relayed between this pass's batch
 * `SELECT` and this row's turn) both mean "nothing to do here", not a failure.
 *
 * Returns whether this call is the one that published the row — never throws for either of the
 * two "nothing to do" cases above, only for a publish that genuinely failed.
 */
function publishRow(db: Database, domainEventsQueue: Queue, rowId: string): Promise<boolean> {
  return db.drizzle.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.id, rowId))
      .for('update', { skipLocked: true });
    if (row === undefined || row.publishedAt !== null) {
      return false;
    }

    await domainEventsQueue.add(
      row.type,
      {
        id: row.id,
        type: row.type,
        version: 1,
        occurredAt: row.createdAt.toISOString(),
        workspaceId: row.workspaceId,
        data: row.payload,
      },
      { jobId: row.id },
    );

    await tx
      .update(outboxEvents)
      .set({ publishedAt: sql`now()` })
      .where(eq(outboxEvents.id, row.id));
    return true;
  });
}

/** Bumps `attempts` for a row whose publish just failed — its own tiny statement, since the
 * failed `publishRow` transaction already rolled back and cannot carry this write itself. */
async function recordFailure(db: Database, rowId: string): Promise<void> {
  await db.drizzle
    .update(outboxEvents)
    .set({ attempts: sql`${outboxEvents.attempts} + 1` })
    .where(eq(outboxEvents.id, rowId));
}

/**
 * Relays one batch of unpublished outbox rows.
 *
 * Single-runner assumption: each row's `publishRow` call takes its own `FOR UPDATE SKIP LOCKED`
 * lock, so a second concurrent runner is safe from a data-corruption standpoint — but SKIP LOCKED
 * means it would simply claim whatever this pass has not yet reached, doubling delivery beyond
 * what the at-least-once contract already allows. The caller (the `scheduler` queue processor,
 * wired in a later task per plan.md §9.2) MUST run this at concurrency 1.
 *
 * Safe to re-run after a crash: a row's publish and stamp commit together. If the process dies
 * after `domainEventsQueue.add` but before that row's transaction commits, the row is still
 * unpublished when it rolls back, so the next pass picks it up and republishes it — consumers
 * de-duplicate on the event id, which is also the BullMQ `jobId` (R-06, A15), and BullMQ itself is
 * a no-op when a job with that id already exists.
 *
 * A row that fails to publish no longer aborts the rest of the batch (I5): its `attempts` column
 * is incremented and the loop moves on. If every row in the batch failed, the whole call still
 * rejects — with an `AggregateError` collecting every row's failure — so a total outage (the case
 * `outbox.integration.test.ts`'s dropped-queue test exercises) is reported exactly as before: the
 * caller sees a failed pass and nothing in this batch is mistaken for relayed.
 *
 * Args:
 *   db: The database handle to select and stamp rows on.
 *   domainEventsQueue: The BullMQ queue to publish envelopes to.
 *
 * Returns:
 *   The number of rows relayed in this pass.
 */
export async function relayOutboxBatch(
  db: Database,
  domainEventsQueue: Queue,
): Promise<OutboxRelayResult> {
  const rows = await db.drizzle
    .select({ id: outboxEvents.id })
    .from(outboxEvents)
    .where(isNull(outboxEvents.publishedAt))
    .orderBy(outboxEvents.createdAt)
    .limit(BATCH_SIZE);

  let relayed = 0;
  const failures: unknown[] = [];
  for (const row of rows) {
    try {
      // Each row's publish is independent and now runs in its own transaction (see the module
      // docstring) — genuinely sequential only in the sense that a poison row must not be allowed
      // to race its cleanup against its successors' publishes; not a candidate for Promise.all.
      // oxlint-disable-next-line no-await-in-loop
      const published = await publishRow(db, domainEventsQueue, row.id);
      if (published) {
        relayed += 1;
      }
    } catch (error) {
      failures.push(error);
      // oxlint-disable-next-line no-await-in-loop
      await recordFailure(db, row.id);
    }
  }

  if (relayed === 0 && failures.length > 0) {
    throw new AggregateError(failures, 'outbox relay: every row in this batch failed to publish');
  }

  return { relayed };
}
