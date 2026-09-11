/**
 * Outbox relay (T032, D9, contracts/domain-events.md §"Delivery guarantees").
 *
 * Selects unpublished outbox rows, publishes each as a domain event envelope to the
 * `domain-events` queue, and stamps `published_at`. Nothing here treats the outbox row
 * as anything but the record of truth: the queue is delivery only, so losing Redis
 * loses no data (FR-033, SC-011) — a row that fails to publish simply stays unpublished
 * and is retried on the next pass.
 */

import { eq, isNull, sql } from 'drizzle-orm';
import type { Queue } from 'bullmq';
import type { Database } from '#src/shared/db.ts';
import type { OutboxTransaction } from '#src/modules/comments/infrastructure/outbox.ts';
import { outboxEvents } from '#src/modules/comments/infrastructure/schema.ts';

const BATCH_SIZE = 100;
export const DOMAIN_EVENTS_QUEUE_NAME = 'domain-events';

export interface OutboxRelayResult {
  readonly relayed: number;
}

/**
 * Relays one batch of unpublished outbox rows.
 *
 * Single-runner assumption: this function selects rows with `FOR UPDATE SKIP LOCKED`
 * and holds that lock for the duration of the transaction, which makes a second
 * concurrent call safe from a data-corruption standpoint — but SKIP LOCKED means a
 * second runner would simply select the *next* unlocked batch and publish it
 * independently, doubling delivery beyond what the at-least-once contract already
 * allows. The caller (the `scheduler` queue processor, wired in a later task per
 * plan.md §9.2) MUST run this at concurrency 1.
 *
 * Safe to re-run after a crash: selecting, publishing and stamping all happen inside
 * one transaction. If the process dies after `domainEventsQueue.add` but before the
 * transaction commits, the row is still unpublished when the transaction rolls back,
 * so the next pass picks it up and republishes it — consumers de-duplicate on the
 * event id, which is also the BullMQ `jobId` (R-06, A15), and BullMQ itself is a no-op
 * when a job with that id already exists. A queue failure (the `.add` call rejecting)
 * aborts the transaction before any `published_at` is written, so a failed publish is
 * never mistaken for a successful one.
 *
 * Args:
 *   db: The database handle to select and stamp rows on.
 *   domainEventsQueue: The BullMQ queue to publish envelopes to.
 *
 * Returns:
 *   The number of rows relayed in this pass.
 */
export function relayOutboxBatch(
  db: Database,
  domainEventsQueue: Queue,
): Promise<OutboxRelayResult> {
  return db.drizzle.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(outboxEvents)
      .where(isNull(outboxEvents.publishedAt))
      .orderBy(outboxEvents.createdAt)
      .limit(BATCH_SIZE)
      .for('update', { skipLocked: true });

    await Promise.all(rows.map((row) => publishAndStamp(tx, domainEventsQueue, row)));

    return { relayed: rows.length };
  });
}

async function publishAndStamp(
  tx: OutboxTransaction,
  domainEventsQueue: Queue,
  row: typeof outboxEvents.$inferSelect,
): Promise<void> {
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
}
