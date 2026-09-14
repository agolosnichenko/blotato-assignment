/**
 * Outbox relay (T032, D9, contracts/domain-events.md §"Delivery guarantees").
 *
 * Selects unpublished outbox rows, publishes each as a domain event envelope to the
 * `domain-events` queue, and stamps `published_at`. Nothing here treats the outbox row
 * as anything but the record of truth: the queue is delivery only, so losing Redis
 * loses no data (FR-033, SC-011) — a row that fails to publish simply stays unpublished
 * and is retried on the next pass.
 *
 * spec.md §18: a pass publishes the oldest batch in bulk — one locked `SELECT`, one `addBulk`, one
 * stamping `UPDATE` — and keeps taking batches while they come back full, so a backfill's
 * thousands of events leave in one pass rather than a hundred every ten seconds.
 *
 * The bulk path alone would bring back the failure the row-by-row path was built for: a row BullMQ
 * can never accept — a payload it rejects, a shape Redis refuses as part of a key — sits forever at
 * the front of the oldest-first selection, and a batch that includes it rolls back on every pass.
 * So a failed batch is retried row by row, each row publishing and stamping inside its *own*
 * transaction: a poison row's failure can no longer take its successors down with it, and
 * `outbox_events.attempts` is incremented so the row is visible (and eventually actionable) instead
 * of silently retried forever in the same spot. The pass then stops, so a poison row cannot make
 * it spin.
 */

import { eq, inArray, isNull, sql } from 'drizzle-orm';
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

type OutboxRow = typeof outboxEvents.$inferSelect;

/** The domain event envelope (contracts/domain-events.md) one outbox row is published as. */
function envelopeFor(row: OutboxRow) {
  return {
    name: row.type,
    data: {
      id: row.id,
      type: row.type,
      version: 1,
      occurredAt: row.createdAt.toISOString(),
      workspaceId: row.workspaceId,
      data: row.payload,
    },
    opts: { jobId: row.id },
  };
}

/**
 * Publishes and stamps the oldest unpublished batch in one transaction, returning how many rows it
 * published. Throws — rolling the whole batch back, stamps included — if the queue refuses any of
 * it; the caller then retries that batch row by row.
 */
function publishBatch(db: Database, domainEventsQueue: Queue): Promise<number> {
  return db.drizzle.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(outboxEvents)
      .where(isNull(outboxEvents.publishedAt))
      .orderBy(outboxEvents.createdAt)
      .limit(BATCH_SIZE)
      .for('update', { skipLocked: true });
    if (rows.length === 0) {
      return 0;
    }

    await domainEventsQueue.addBulk(rows.map((row) => envelopeFor(row)));
    await tx
      .update(outboxEvents)
      .set({ publishedAt: sql`now()` })
      .where(
        inArray(
          outboxEvents.id,
          rows.map((row) => row.id),
        ),
      );
    return rows.length;
  });
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

    const envelope = envelopeFor(row);
    await domainEventsQueue.add(envelope.name, envelope.data, envelope.opts);

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

interface RowByRowResult {
  readonly relayed: number;
  readonly failures: readonly unknown[];
}

/** The isolation path for a batch that failed in bulk: every row in its own transaction (I5). */
async function relayRowByRow(
  db: Database,
  domainEventsQueue: Queue,
  logger: RelayLogger,
): Promise<RowByRowResult> {
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
      // Sequential on purpose: a poison row must not race its cleanup against its successors'
      // publishes — not a candidate for Promise.all.
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
  return { relayed, failures };
}

/**
 * Relays every unpublished outbox row it can reach in one pass, batch by batch.
 *
 * Single-runner assumption: every batch and every row takes its own `FOR UPDATE SKIP LOCKED` lock,
 * so a second concurrent runner is safe from a data-corruption standpoint — but SKIP LOCKED means
 * it would simply claim whatever this pass has not yet reached, doubling delivery beyond what the
 * at-least-once contract already allows. The caller — the `scheduler` queue processor in
 * `src/app/worker.ts` (plan.md §9.2) — MUST run this at concurrency 1.
 *
 * Safe to re-run after a crash: a batch's (or a row's) publish and stamp commit together. If the
 * process dies after the queue accepted the jobs but before the transaction commits, the rows are
 * still unpublished when it rolls back, so the next pass picks them up and republishes them —
 * consumers de-duplicate on the event id, which is also the BullMQ `jobId` (R-06, A15), and BullMQ
 * itself is a no-op when a job with that id already exists.
 *
 * A batch that fails in bulk is retried row by row (I5), where a failing row has its `attempts`
 * incremented and the loop moves on; the pass ends there. If that pass relayed nothing and at least
 * one row failed, the whole call still rejects — with an `AggregateError` collecting every row's
 * failure — so a total outage (the case `outbox.integration.test.ts`'s dropped-queue test
 * exercises) is reported exactly as before: the caller sees a failed pass and nothing is mistaken
 * for relayed.
 *
 * Args:
 *   db: The database handle to select and stamp rows on.
 *   domainEventsQueue: The BullMQ queue to publish envelopes to.
 *   logger: Where row-level failures are reported.
 *
 * Returns:
 *   The number of rows relayed in this pass.
 */
export async function relayOutboxBatch(
  db: Database,
  domainEventsQueue: Queue,
  logger: RelayLogger = SILENT_RELAY_LOGGER,
): Promise<OutboxRelayResult> {
  let relayed = 0;
  let published: number;
  do {
    try {
      // Each batch must commit before the next is selected, or the next would select it again.
      // oxlint-disable-next-line no-await-in-loop
      published = await publishBatch(db, domainEventsQueue);
    } catch {
      // The batch rolled back as a whole; the row-by-row pass below reports each row's own error.
      // oxlint-disable-next-line no-await-in-loop
      const fallback = await relayRowByRow(db, domainEventsQueue, logger);
      relayed += fallback.relayed;
      if (relayed === 0 && fallback.failures.length > 0) {
        throw new AggregateError(
          fallback.failures,
          'outbox relay: every row in this batch failed to publish',
        );
      }
      return { relayed };
    }
    relayed += published;
  } while (published === BATCH_SIZE);

  return { relayed };
}
