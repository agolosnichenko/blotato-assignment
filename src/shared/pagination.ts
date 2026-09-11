import { z } from 'zod';

export type SortOrder = 'asc' | 'desc';

export interface KeysetCursor {
  readonly occurredAt: Date;
  readonly id: string;
  readonly order: SortOrder;
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
 *   cursor: The keyset position `(occurredAt, id)` plus the `order` it was minted under.
 *
 * Returns:
 *   A base64url string safe to hand back to clients as `nextCursor`/`prevCursor`.
 */
export function encodeCursor(cursor: KeysetCursor): string {
  const payload = {
    occurredAt: cursor.occurredAt.toISOString(),
    id: cursor.id,
    order: cursor.order,
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

  return { ok: true, cursor: { occurredAt, id: parsed.data.id, order: parsed.data.order } };
}
