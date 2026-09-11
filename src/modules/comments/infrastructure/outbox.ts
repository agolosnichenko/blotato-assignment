/**
 * Transactional outbox writer (D9, contracts/domain-events.md).
 *
 * A domain event is durable only if it commits atomically with the state change it
 * describes — a use case never publishes to BullMQ directly. `appendToOutbox` enforces
 * that at the type level: it accepts a transaction handle, not a plain database
 * connection, so there is no signature under which a caller can insert an event outside
 * a transaction.
 */

import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { NodePgTransaction } from 'drizzle-orm/node-postgres';
import { generateId } from '#src/shared/ids.ts';
import { outboxEvents } from '#src/modules/comments/infrastructure/schema.ts';

/**
 * The transaction handle yielded by `db.drizzle.transaction(async (tx) => ...)`.
 *
 * Naming this type — rather than accepting `NodePgDatabase` — is what makes
 * `appendToOutbox` impossible to call outside a transaction: a plain database handle
 * does not satisfy `OutboxTransaction`, only the object a `.transaction()` callback
 * receives does.
 */
export type OutboxTransaction = NodePgTransaction<
  Record<string, never>,
  ExtractTablesWithRelations<Record<string, never>>
>;

export interface OutboxEventInput {
  readonly workspaceId: string;
  /** One of the event types in contracts/domain-events.md, e.g. `comment.received`. */
  readonly type: string;
  /** The entity this event is about — a comment or another aggregate this module owns. */
  readonly aggregateId: string;
  /** The envelope's `data` field, per the payload shape for `type` in the contract. */
  readonly data: Record<string, unknown>;
}

/**
 * Appends a domain event to the transactional outbox.
 *
 * Must be called with the same transaction that performs the state change the event
 * describes (D9) — the outbox row and the change commit or roll back together. The id
 * generated here is reused as the published envelope's `id` and, later, as the BullMQ
 * `jobId` the relay publishes it under (R-06, A15), which is what lets consumers
 * de-duplicate an at-least-once delivery.
 *
 * The envelope's `version` (always `1`) and `occurredAt` are not stored on this row:
 * `occurredAt` is the row's `createdAt`, and both are filled in by the relay when it
 * builds the envelope for publishing.
 *
 * Args:
 *   tx: The caller's open transaction. See `OutboxTransaction` for why a plain database
 *     handle is not accepted.
 *   event: The event's workspace, type, aggregate id and `data` payload.
 *
 * Returns:
 *   The generated event id.
 */
export async function appendToOutbox(
  tx: OutboxTransaction,
  event: OutboxEventInput,
): Promise<string> {
  const id = generateId();
  await tx.insert(outboxEvents).values({
    id,
    workspaceId: event.workspaceId,
    type: event.type,
    aggregateId: event.aggregateId,
    payload: event.data,
  });
  return id;
}
