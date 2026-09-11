/**
 * Reconciliation after an unresolved publish attempt (T061; spec.md §7.1 step 6, D14, FR-011).
 *
 * `OutcomeUnknownError` means the write left this service but the response never came back — the
 * adapter cannot say whether the platform received it. The only safe next step is to ask the
 * platform itself, through `findPublishedComment`, and let its answer (not a guess) decide what
 * happens next. `publish-comment.ts` is the only caller: every `OutcomeUnknownError` path in this
 * feature routes through this function before it may touch `adapter.publishComment` again.
 *
 * This module deliberately does nothing beyond that one call. In particular it does not catch a
 * failure of the search itself and fold it into "not found" — the module docstring in
 * `publish-comment.integration.test.ts` calls that distinction out explicitly: treating a failed
 * search as "not found" would retry a comment that may already have been posted, producing the
 * exact duplicate D14 exists to prevent. A thrown error from `findPublishedComment` propagates to
 * the caller unchanged, so it can be told apart from a confirmed absence.
 */

import type {
  AccountContext,
  CommentPlatformAdapter,
  PublishedComment,
  ReconcileProbe,
} from '#src/platforms/types.ts';

export type ReconcileResult =
  | { readonly found: true; readonly published: PublishedComment }
  | { readonly found: false };

/**
 * Searches the platform for the comment an unresolved `publishComment` call may have created.
 *
 * Args:
 *   adapter: The platform adapter for the account the original attempt used.
 *   ctx: The same account context the original `publishComment` call was made with.
 *   probe: Our own author, the parent, the sent text, and the window `findPublishedComment` must
 *     search — built by the caller from `last_attempt_started_at - 2min` (§7.1 step 6).
 *
 * Returns:
 *   `{ found: true, published }` when the platform has our comment; `{ found: false }` when a
 *   completed search came back empty.
 *
 * Raises:
 *   Whatever `adapter.findPublishedComment` throws — a failed search, not a confirmed absence.
 */
export async function reconcileComment(
  adapter: CommentPlatformAdapter,
  ctx: AccountContext,
  probe: ReconcileProbe,
): Promise<ReconcileResult> {
  const published = await adapter.findPublishedComment(ctx, probe);
  return published === null ? { found: false } : { found: true, published };
}
