import { uuidv7 } from 'uuidv7';

/**
 * Generates a new UUIDv7 identifier.
 *
 * Ids are generated in the application, not the database, because the outbox row,
 * the BullMQ `jobId` and the HTTP `Location` header of a `202 queued` response all
 * need the id before the insert returns (R-06, A15).
 */
export function generateId(): string {
  return uuidv7();
}
