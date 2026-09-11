/**
 * Bluesky {@link CommentPlatformAdapter} (spec.md §8.3, contracts/platform-adapter.md).
 *
 * `publishComment` and `findPublishedComment` are T065; `listComments` and `fetchComment` are a
 * later wave (T083) and are left throwing rather than stubbed — a stub that quietly returned an
 * empty page would let a sync walk conclude a post has no comments and mark everything `deleted`.
 */

import { AppBskyFeedDefs, AppBskyFeedPost, AtpAgent } from '@atproto/api';
import { classifyBlueskyFailure } from '#src/platforms/bluesky/errors.ts';
import { detectFacets } from '#src/platforms/bluesky/facets.ts';
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

const NOT_IMPLEMENTED_MESSAGE =
  'bluesky read path (listComments/fetchComment) is not implemented yet (T083)';

function listComments(
  _ctx: AccountContext,
  _target: PostTarget,
  _cursor?: string,
): Promise<CommentPage> {
  throw new Error(NOT_IMPLEMENTED_MESSAGE);
}

function fetchComment(
  _ctx: AccountContext,
  _platformCommentId: string,
): Promise<NormalizedComment | null> {
  throw new Error(NOT_IMPLEMENTED_MESSAGE);
}

export const blueskyAdapter: CommentPlatformAdapter = {
  platform: 'bluesky',
  listComments,
  publishComment,
  findPublishedComment,
  fetchComment,
};
