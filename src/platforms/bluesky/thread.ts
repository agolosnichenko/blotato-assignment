/**
 * Thread-walking helpers for the Bluesky read path (`adapter.ts`'s `listComments`/`fetchComment`,
 * T083, spec.md §8.3).
 *
 * Split out of `adapter.ts` the same way `facets.ts` holds the write path's rich-text detection
 * and `errors.ts` holds failure classification — each a self-contained concern the adapter
 * composes rather than inlines.
 */

import { AppBskyFeedDefs, AppBskyFeedPost } from '@atproto/api';
import { PermanentError, type NormalizedComment } from '#src/platforms/types.ts';

/**
 * Normalizes a fetched post into a comment.
 *
 * The reply parent comes from the post's own record (`reply.parent.uri`), not from where it sits
 * in whatever thread tree happened to be walked to find it — the same value regardless of
 * whether this post was reached via `listComments` or `fetchComment` (FR-022 depends on that).
 */
export function normalizePost(post: AppBskyFeedDefs.PostView): NormalizedComment {
  // `isRecord` narrows against the generic input type, which keeps `post.record`'s index
  // signature rather than `AppBskyFeedPost.Record`'s named fields — the cast recovers those once
  // the runtime check has confirmed the `$type`.
  const record = AppBskyFeedPost.isRecord(post.record)
    ? (post.record as unknown as AppBskyFeedPost.Record)
    : undefined;
  return {
    platformCommentId: post.uri,
    platformParentId: record?.reply?.parent.uri ?? null,
    authorPlatformId: post.author.did,
    authorUsername: post.author.handle,
    authorDisplayName: post.author.displayName ?? null,
    text: record?.text ?? '',
    platformCreatedAt: new Date(post.indexedAt),
    platformMeta: { cid: post.cid },
  };
}

/**
 * Builds the placeholder comment for a `notFoundPost` tombstone.
 *
 * A tombstone carries only the dead record's own URI — no author, text or timestamp survives
 * deletion — so every other field is an explicit, documented placeholder rather than a guess.
 * `platformParentId` is only known when the tombstone was found as a direct reply during this
 * same walk (the common case, from `walkThread`); when a URI that was queued from an earlier
 * page turns out to have vanished by the time it is re-fetched, its parent is not available here
 * and is recorded as `null` — the delete branch of `ingest-comments.ts` (T076) keys off
 * `platformCommentId` alone and does not need it.
 */
export function tombstoneFor(uri: string, parentUri: string | null): NormalizedComment {
  return {
    platformCommentId: uri,
    platformParentId: parentUri,
    authorPlatformId: '',
    authorUsername: null,
    authorDisplayName: null,
    text: '',
    // Not a real creation time — deletion scrubs it. Records when this walk observed the
    // tombstone, which is the only true fact this adapter has left about it.
    platformCreatedAt: new Date(),
    platformMeta: { tombstone: true },
  };
}

/**
 * Walks one already-fetched thread node's replies, collecting normalized comments and queuing
 * any branch `getPostThread` truncated for a later page.
 *
 * `pushSelf` is false only for the very top of a `getPostThread` response: that node is either
 * the anchor post itself (not a comment) or a branch root already emitted on the page that
 * queued it, so pushing it again would duplicate it.
 */
export function walkThread(
  node: AppBskyFeedDefs.ThreadViewPost,
  comments: NormalizedComment[],
  pendingFrontier: string[],
  pushSelf: boolean,
): void {
  if (pushSelf) {
    comments.push(normalizePost(node.post));
  }

  const replies = node.replies;
  if (replies === undefined) {
    // No `replies` field: either a real leaf (`replyCount` 0/absent) or the depth budget ran
    // out with children left unexpanded (`replyCount > 0`) — only the latter needs a later page.
    if ((node.post.replyCount ?? 0) > 0) {
      pendingFrontier.push(node.post.uri);
    }
    return;
  }

  for (const child of replies) {
    if (AppBskyFeedDefs.isThreadViewPost(child)) {
      walkThread(child, comments, pendingFrontier, true);
    } else if (AppBskyFeedDefs.isNotFoundPost(child)) {
      comments.push(tombstoneFor(child.uri, node.post.uri));
    }
    // `blockedPost` and any other typed variant: unreadable, but not an explicit deletion
    // signal (spec §8.3 names only `notFoundPost`) — skipped rather than reported either way.
  }
}

/**
 * Parses `listComments`'s opaque cursor back into the pending-URI queue it encodes.
 *
 * Args:
 *   cursor: What a previous `listComments` call returned as `nextCursor`, or `undefined` for the
 *     first page.
 *   rootUri: The post's own URI, the queue's sole starting entry when there is no cursor yet.
 *
 * Raises:
 *   PermanentError: `cursor` does not decode to the JSON array of strings this adapter itself
 *     produces — a caller error, not a platform failure, so it is not retryable.
 */
export function parseFrontier(cursor: string | undefined, rootUri: string): string[] {
  if (cursor === undefined) {
    return [rootUri];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor);
  } catch (error) {
    throw new PermanentError(`bluesky listComments received a malformed cursor: ${cursor}`, {
      cause: error,
    });
  }
  if (!Array.isArray(parsed) || !parsed.every((item): item is string => typeof item === 'string')) {
    throw new PermanentError(`bluesky listComments received a malformed cursor: ${cursor}`);
  }
  return parsed;
}
