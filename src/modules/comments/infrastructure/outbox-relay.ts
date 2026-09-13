/**
 * Outbox relay (T032, D9, contracts/domain-events.md §"Delivery guarantees").
 *
 * Selects unpublished outbox rows, publishes each as a domain event envelope to the
 * `domain-events` queue, and stamps `published_at`. Nothing here treats the outbox row
 * as anything but the record of truth: the queue is delivery only, so losing Redis
 * loses no data (FR-033, SC-011) — a row that fails to publish simply stays unpublished
 * and is retried on the next pass.
 *
 * spec.md §18: each row publishes and stamps inside its *own* transaction, not one
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

/** Attempts after which a row stops being an ordinary retry and starts being an incident. */
const POISON_ATTEMPTS = 10;

/** The slice of pino this module needs; keeps the relay callable from tests without a logger. */
export interface RelayLogger {
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

const SILENT_RELAY_LOGGER: RelayLogger = {
  warn: () => {},
  error: () => {},
};

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
async function recordFailure(db: Database, rowId: string): Promise<number> {
  const [row] = await db.drizzle
    .update(outboxEvents)
    .set({ attempts: sql`${outboxEvents.attempts} + 1` })
    .where(eq(outboxEvents.id, rowId))
    .returning({ attempts: outboxEvents.attempts });
  return row?.attempts ?? 0;
}

/**
 * Reports one row's failure, loudly enough that a stuck event is noticed.
 *
 * `attempts` was already being incremented before this, but nothing read it and nothing logged —
 * so a row BullMQ would never accept was retried every 10 seconds, forever, while the relay pass
 * that carried it reported success. Past {@link POISON_ATTEMPTS} the level rises to `error`: the
 * row is still kept and still retried (D9 — the outbox is the only record of the event, and
 * dropping it would lose the event for good), but it stops being invisible.
 */
function reportFailure(logger: RelayLogger, rowId: string, attempts: number, error: unknown): void {
  const details = { outboxEventId: rowId, attempts, err: error };
  if (attempts >= POISON_ATTEMPTS) {
    logger.error(
      details,
      'outbox relay: event still unpublished after repeated attempts; it is being retried every ' +
        'pass and needs an operator',
    );
    return;
  }
  logger.warn(details, 'outbox relay: event failed to publish, will retry on the next pass');
}

/**
 * Relays one batch of unpublished outbox rows.
 *
 * Single-runner assumption: each row's `publishRow` call takes its own `FOR UPDATE SKIP LOCKED`
 * lock, so a second concurrent runner is safe from a data-corruption standpoint — but SKIP LOCKED
 * means it would simply claim whatever this pass has not yet reached, doubling delivery beyond
 * what the at-least-once contract already allows. The caller — the `scheduler` queue processor in
 * `src/app/worker.ts` (plan.md §9.2) — MUST run this at concurrency 1.
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
  logger: RelayLogger = SILENT_RELAY_LOGGER,
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
      const attempts = await recordFailure(db, row.id);
      reportFailure(logger, row.id, attempts, error);
    }
  }

  if (relayed === 0 && failures.length > 0) {
    throw new AggregateError(failures, 'outbox relay: every row in this batch failed to publish');
  }

  return { relayed };
}
