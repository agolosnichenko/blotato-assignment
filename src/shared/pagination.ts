import { z } from 'zod';

export type SortOrder = 'asc' | 'desc';

/**
 * A decoded keyset position — where a page resumes, and nothing about which way it scans.
 *
 * The *encoded* cursor carries the direction it was minted under (D27) and {@link decodeCursor}
 * rejects one replayed under the other, so by the time a caller holds a `KeysetCursor` the direction
 * is already agreed. Keeping a second copy of it here would let a caller build
 * `{ cursor: { order: 'asc', … }, order: 'desc' }` — a state with no correct behaviour, which the
 * repository would resolve silently by preferring one of the two. There is one `order` in the
 * repository's pagination argument, and this type does not hold a second.
 */
export interface KeysetCursor {
  readonly occurredAt: Date;
  readonly id: string;
}

export type CursorDecodeError = 'MALFORMED' | 'ORDER_MISMATCH';

export type CursorDecodeResult =
  | { readonly ok: true; readonly cursor: KeysetCursor }
  | { readonly ok: false; readonly error: CursorDecodeError };

const cursorPayloadSchema = z.object({
  occurredAt: z.string(),
  id: z.uuid(),
  order: z.enum(['asc', 'desc']),
});

/**
 * Encodes a keyset position and its ordering direction as an opaque cursor.
 *
 * The cursor is not a documented client format (R-02): it carries no version and needs no
 * encryption, only a shape that `decodeCursor` can reject cleanly when tampered with.
 *
 * Args:
 *   cursor: The keyset position `(occurredAt, id)` the next page resumes from.
 *   order: The direction this page was scanned under, which `decodeCursor` will require back.
 *
 * Returns:
 *   A base64url string safe to hand back to clients as `nextCursor`/`prevCursor`.
 */
export function encodeCursor(cursor: KeysetCursor, order: SortOrder): string {
  const payload = {
    occurredAt: cursor.occurredAt.toISOString(),
    id: cursor.id,
    order,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decodes an opaque cursor, rejecting it if malformed or minted under a different `order`.
 *
 * Never throws: hostile input (invalid base64url, non-JSON payload, wrong field types, a
 * truncated string) is reported as `{ ok: false, error: 'MALFORMED' }` instead of crashing the
 * process. A structurally valid cursor minted under a different `order` (D27, A13) is reported
 * as `{ ok: false, error: 'ORDER_MISMATCH' }` for the HTTP layer to map to `400
 * VALIDATION_ERROR`.
 *
 * Args:
 *   raw: The base64url cursor string presented by the client.
 *   order: The `order` the current request is scanning under.
 *
 * Returns:
 *   The decoded keyset position on success, or a typed failure the caller maps to an error.
 */
export function decodeCursor(raw: string, order: SortOrder): CursorDecodeResult {
  let json: unknown;
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    json = JSON.parse(decoded);
  } catch {
    return { ok: false, error: 'MALFORMED' };
  }

  const parsed = cursorPayloadSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: 'MALFORMED' };
  }

  const occurredAt = new Date(parsed.data.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) {
    return { ok: false, error: 'MALFORMED' };
  }

  if (parsed.data.order !== order) {
    return { ok: false, error: 'ORDER_MISMATCH' };
  }

  return { ok: true, cursor: { occurredAt, id: parsed.data.id } };
}
