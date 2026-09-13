/**
 * The comment status state machine (data-model.md §2, R-10).
 *
 * Pure domain: no database access, no imports from `infrastructure/`. Every legal move a
 * repository makes is one row of {@link ALLOWED_TRANSITIONS}, so a state change can always be
 * written as a conditional `UPDATE comments SET status = $next WHERE status = $expected`
 * (Principle III) — the affected-row count tells the caller whether it won the race.
 */

/**
 * The statuses, as a value — so the drizzle column, the Zod response schema and this type are all
 * derived from one list rather than three hand-kept copies of it.
 */
export const COMMENT_STATUSES = ['queued', 'processing', 'posted', 'failed', 'deleted'] as const;

export type CommentStatus = (typeof COMMENT_STATUSES)[number];

/**
 * `from -> to` pairs the repository may apply with a conditional `UPDATE`.
 *
 * `queued` and `posted` are also entered directly on insert (an API-created comment starts
 * `queued`; a webhook- or sync-ingested comment starts `posted`) — those inserts are not
 * transitions and are not listed here.
 */
const ALLOWED_TRANSITIONS: ReadonlyArray<readonly [CommentStatus, CommentStatus]> = [
  ['queued', 'processing'],
  ['processing', 'posted'],
  // Retry, bounded backoff honouring Retry-After.
  ['processing', 'queued'],
  // PermanentError / AuthError / attempts exhausted.
  ['processing', 'failed'],
  // Platform delete event, or a complete sync walk finding it gone.
  ['posted', 'deleted'],
];

/**
 * Reports whether `from -> to` is a legal transition.
 *
 * Args:
 *   from: The status a repository call expects the row to currently hold.
 *   to: The status the call would set.
 *
 * Returns:
 *   `true` if the pair appears in the allowed-transition table.
 */
export function canTransition(from: CommentStatus, to: CommentStatus): boolean {
  return ALLOWED_TRANSITIONS.some(([allowedFrom, allowedTo]) => {
    return allowedFrom === from && allowedTo === to;
  });
}
