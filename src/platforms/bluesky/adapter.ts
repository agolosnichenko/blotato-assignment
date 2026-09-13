/**
 * Bluesky {@link CommentPlatformAdapter} (spec.md §8.3, contracts/platform-adapter.md).
 *
 * `publishComment` and `findPublishedComment` are T065. `listComments` and `fetchComment` (T083)
 * walk `app.bsky.feed.getPostThread`.
 *
 * **Paging a tree, not a list.** `getPostThread` returns a whole subtree up to `depth` levels
 * (`Config.BLUESKY_THREAD_DEPTH`, spec §8.3) in one call, not a flat page. `listComments`'s
 * cursor is therefore a JSON-encoded queue of AT URIs still to expand, not a platform cursor: the
 * initial call anchors on the post, and any reply node whose `replies` field came back empty
 * *because the depth budget ran out* (`post.replyCount > 0` with no `replies` array — a real leaf
 * has `replyCount: 0`) is queued for a later call to re-anchor on and keep descending ("loading
 * truncated branches"). `nextCursor` is `null` only once that queue is empty, so a walk
 * interrupted by a thrown error never looks complete.
 *
 * **Two deletion signals, kept apart.** A `notFoundPost` in the thread is the AT Protocol's
 * explicit tombstone, independent of whether this walk ever finishes. Its id goes on
 * `CommentPage.deletedPlatformCommentIds`, never inside `comments` (spec.md §18, extends §8.3) —
 * folding it into an ordinary `NormalizedComment` would both upsert a phantom `posted` row and,
 * by marking it *seen*, suppress the absence-based fallback it was meant to pre-empt.
 * `fetchComment` folds the same signal into the plain `null` the port already defines for
 * "nothing here". A `blockedPost` is not a tombstone (unreadable ≠ deleted) and is skipped.
 */

// oxlint-disable max-lines -- one adapter implementing all four `CommentPlatformAdapter` methods
// plus the two deletion-signal read paths documented above (`listComments`/`fetchComment`, T083);
// splitting read from write would separate pieces that must agree on the same session and error
// classification (`classifyBlueskyFailure`), not reduce what the adapter actually does.

import { AppBskyFeedDefs, AppBskyFeedPost, AtpAgent } from '@atproto/api';
import { classifyBlueskyFailure } from '#src/platforms/bluesky/errors.ts';
import { detectFacets } from '#src/platforms/bluesky/facets.ts';
import { normalizePost, parseFrontier, walkThread } from '#src/platforms/bluesky/thread.ts';
import {
  AuthError,
  PermanentError,
  RetryableError,
  type AccountContext,
  type CommentPage,
  type CommentPlatformAdapter,
  type NormalizedComment,
  type PostTarget,
  type PublishedComment,
  type PublishInput,
  type ReconcileProbe,
} from '#src/platforms/types.ts';

/** The public entryway; it proxies unauthenticated session creation to the account's real PDS. */
const BLUESKY_SERVICE = 'https://bsky.social';

/** The credential shape the `AccountCredentials` port supplies for a Bluesky account (D26). */
interface BlueskyCredentials {
  readonly token: Buffer;
}

function isBlueskyCredentials(value: unknown): value is BlueskyCredentials {
  return (
    value !== null &&
    typeof value === 'object' &&
    'token' in value &&
    Buffer.isBuffer((value as { token: unknown }).token)
  );
}

/**
 * Logged-in sessions, cached per social account for the life of this process.
 *
 * `AtpAgent`'s `CredentialSession` refreshes its access JWT itself before each request once it
 * has a session — "session refreshed inside the adapter" (spec.md §8.3) falls out of reusing one
 * agent rather than something this module implements by hand.
 */
const sessions = new Map<string, AtpAgent>();

async function sessionFor(ctx: AccountContext): Promise<AtpAgent> {
  const cached = sessions.get(ctx.socialAccountId);
  if (cached?.hasSession === true) {
    return cached;
  }

  if (!isBlueskyCredentials(ctx.credentials)) {
    throw new AuthError('bluesky adapter received credentials in an unrecognised shape');
  }

  const agent = new AtpAgent({ service: BLUESKY_SERVICE });
  try {
    // `identifier` accepts the account DID directly, so this needs no separate stored handle.
    await agent.login({
      identifier: ctx.platformAccountId,
      password: ctx.credentials.token.toString('utf8'),
    });
  } catch (error) {
    throw classifyBlueskyFailure(error);
  }

  sessions.set(ctx.socialAccountId, agent);
  return agent;
}

interface PostRef {
  readonly uri: string;
  readonly cid: string;
}

/**
 * Resolves the `cid` for the post and the reply target, and detects the outgoing text's facets —
 * every read `publishComment` needs before it is safe to write. Nothing is written to Bluesky
 * during this step, so however it fails, retrying it can never create a duplicate reply.
 */
async function prepareReply(
  agent: AtpAgent,
  input: PublishInput,
): Promise<{ root: PostRef; parent: PostRef; facets: Awaited<ReturnType<typeof detectFacets>> }> {
  const parentUri = input.platformParentId ?? input.platformPostId;
  try {
    const uris = Array.from(new Set([input.platformPostId, parentUri]));
    const { data } = await agent.getPosts({ uris });
    const byUri = new Map(data.posts.map((post) => [post.uri, post] as const));
    const rootPost = byUri.get(input.platformPostId);
    const parentPost = byUri.get(parentUri);
    if (rootPost === undefined || parentPost === undefined) {
      throw new PermanentError('bluesky reply target no longer exists');
    }
    const facets = await detectFacets(agent, input.text);
    return {
      root: { uri: rootPost.uri, cid: rootPost.cid },
      parent: { uri: parentPost.uri, cid: parentPost.cid },
      facets,
    };
  } catch (error) {
    if (error instanceof PermanentError) {
      throw error;
    }
    throw new RetryableError('failed to resolve the bluesky reply target before publishing', {
      cause: error,
    });
  }
}

async function publishComment(ctx: AccountContext, input: PublishInput): Promise<PublishedComment> {
  const agent = await sessionFor(ctx);
  const { root, parent, facets } = await prepareReply(agent, input);

  const createdAt = new Date();
  try {
    const { data } = await agent.com.atproto.repo.createRecord({
      repo: ctx.platformAccountId,
      collection: 'app.bsky.feed.post',
      record: {
        $type: 'app.bsky.feed.post',
        text: input.text,
        facets,
        reply: { root, parent },
        createdAt: createdAt.toISOString(),
      },
    });
    return { platformCommentId: data.uri, platformCreatedAt: createdAt };
  } catch (error) {
    // This is the one call that may have reached the platform before failing — every outcome
    // from here on goes through the full classifier, `OutcomeUnknownError` included.
    throw classifyBlueskyFailure(error);
  }
}

function matchesProbe(
  post: AppBskyFeedDefs.PostView,
  ownDid: string,
  probe: ReconcileProbe,
): PublishedComment | null {
  if (post.author.did !== ownDid || !AppBskyFeedPost.isRecord(post.record)) {
    return null;
  }
  if (post.record['text'] !== probe.text) {
    return null;
  }
  const createdAt = new Date(post.indexedAt);
  if (createdAt < probe.windowStartsAt) {
    return null;
  }
  return { platformCommentId: post.uri, platformCreatedAt: createdAt };
}

async function findPublishedComment(
  ctx: AccountContext,
  probe: ReconcileProbe,
): Promise<PublishedComment | null> {
  const agent = await sessionFor(ctx);
  const anchorUri = probe.platformParentId ?? probe.platformPostId;

  let response: Awaited<ReturnType<typeof agent.getPostThread>>;
  try {
    // The reply we are looking for, if it exists, is a direct child of `anchorUri` — depth 1 is
    // enough regardless of how deep `anchorUri` itself sits in the wider thread.
    response = await agent.getPostThread({ uri: anchorUri, depth: 1 });
  } catch (error) {
    // A search that fails must never be read as "not found" — that would let the caller retry a
    // publish that may already have succeeded.
    throw classifyBlueskyFailure(error);
  }
  const { thread } = response.data;

  if (!AppBskyFeedDefs.isThreadViewPost(thread)) {
    // The parent itself is gone or blocked — no reply of ours could exist under it.
    return null;
  }

  for (const reply of thread.replies ?? []) {
    if (!AppBskyFeedDefs.isThreadViewPost(reply)) {
      continue;
    }
    const match = matchesProbe(reply.post, ctx.platformAccountId, probe);
    if (match !== null) {
      return match;
    }
  }
  return null;
}

/**
 * A node `getPostThread` answered with something other than a thread: the anchor post itself
 * gone/blocked (throws; `sync-post.ts` deactivates on the `PermanentError` rather than inferring
 * deletions), or a queued branch that vanished since — only `notFoundPost` is the explicit
 * tombstone (§8.3); a `blockedPost` is skipped, not reported deleted.
 */
function missingNodePage(
  uri: string,
  target: PostTarget,
  rest: string[],
  thread: unknown,
): CommentPage {
  if (uri === target.platformPostId) {
    throw new PermanentError(`bluesky post ${uri} is unavailable (not found or blocked)`);
  }
  const deletedPlatformCommentIds = AppBskyFeedDefs.isNotFoundPost(thread) ? [uri] : [];
  return {
    comments: [],
    deletedPlatformCommentIds,
    nextCursor: rest.length > 0 ? JSON.stringify(rest) : null,
  };
}

async function listComments(
  threadDepth: number,
  ctx: AccountContext,
  target: PostTarget,
  cursor?: string,
): Promise<CommentPage> {
  const agent = await sessionFor(ctx);
  const [uri, ...rest] = parseFrontier(cursor, target.platformPostId);
  if (uri === undefined) {
    // An empty queue would mean this call should never have happened — the previous page's
    // `nextCursor` was already `null` — but returning an empty, complete page is still correct.
    return { comments: [], deletedPlatformCommentIds: [], nextCursor: null };
  }

  let response: Awaited<ReturnType<typeof agent.getPostThread>>;
  try {
    response = await agent.getPostThread({ uri, depth: threadDepth });
  } catch (error) {
    // A page that fails must never be read as an empty-but-complete one — that would let the
    // caller conclude this branch, or the whole post, has no comments.
    throw classifyBlueskyFailure(error);
  }
  const { thread } = response.data;

  if (!AppBskyFeedDefs.isThreadViewPost(thread)) {
    return missingNodePage(uri, target, rest, thread);
  }

  const comments: NormalizedComment[] = [];
  const deletedPlatformCommentIds: string[] = [];
  const pendingFrontier: string[] = [];
  walkThread(thread, comments, deletedPlatformCommentIds, pendingFrontier, false);

  const remaining = [...rest, ...pendingFrontier];
  return {
    comments,
    deletedPlatformCommentIds,
    nextCursor: remaining.length > 0 ? JSON.stringify(remaining) : null,
  };
}

async function fetchComment(
  ctx: AccountContext,
  platformCommentId: string,
): Promise<NormalizedComment | null> {
  const agent = await sessionFor(ctx);

  let response: Awaited<ReturnType<typeof agent.getPostThread>>;
  try {
    response = await agent.getPostThread({ uri: platformCommentId, depth: 0 });
  } catch (error) {
    throw classifyBlueskyFailure(error);
  }
  const { thread } = response.data;

  if (!AppBskyFeedDefs.isThreadViewPost(thread)) {
    // `notFoundPost` (deleted) and `blockedPost` (inaccessible) both mean "no comment to hand
    // back" for a single lookup — the port's `null` already carries that, so ancestor resolution
    // (T077) needs no separate tombstone case here the way `listComments`'s page shape does.
    return null;
  }
  return normalizePost(thread.post);
}

/** Builds the Bluesky adapter. `options.threadDepth` is `Config.BLUESKY_THREAD_DEPTH` (see above). */
export function createBlueskyAdapter(options: {
  readonly threadDepth: number;
}): CommentPlatformAdapter {
  return {
    platform: 'bluesky',
    listComments: (ctx, target, cursor) => listComments(options.threadDepth, ctx, target, cursor),
    publishComment,
    findPublishedComment,
    fetchComment,
  };
}
