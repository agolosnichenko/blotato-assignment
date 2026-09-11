/**
 * Facebook {@link CommentPlatformAdapter} (spec.md §8.2, contracts/platform-adapter.md).
 *
 * `publishComment` and `findPublishedComment` are T068's write path. `listComments` and
 * `fetchComment` are a later wave's read path (T084) and are left throwing rather than stubbed to
 * an empty result: a stub returning nothing would let a sync walk conclude a post has no comments
 * and mark everything `deleted`.
 *
 * The Instagram login-variant distinction (D28) does not apply to Facebook accounts at all —
 * `ctx.credentials` is still passed through to `graph-client.ts` opaquely, the same as the
 * Instagram adapter, so the two stay symmetric and neither ever needs to know it exists.
 */

import { classifyGraphFailure } from '#src/platforms/meta/errors.ts';
import { createGraphClient, type GraphClient } from '#src/platforms/meta/graph-client.ts';
import type { AccountCredentialsRecord } from '#src/modules/platform-core/ports.ts';
import {
  AuthError,
  type AccountContext,
  type CommentPage,
  type CommentPlatformAdapter,
  type NormalizedComment,
  type PostTarget,
  type PublishedComment,
  type PublishInput,
  type ReconcileProbe,
} from '#src/platforms/types.ts';

function credentialsFrom(ctx: AccountContext): AccountCredentialsRecord {
  const value = ctx.credentials;
  const hasToken =
    value !== null && typeof value === 'object' && 'token' in value && Buffer.isBuffer(value.token);
  if (!hasToken) {
    throw new AuthError('facebook adapter received credentials in an unrecognised shape');
  }
  // Trusted to be the full record the `AccountCredentials` port produced (D26) — this adapter
  // reads none of its fields itself, it only forwards the object to the Graph client.
  return value as AccountCredentialsRecord;
}

interface FbCommentNode {
  readonly id: string;
  readonly message: string;
  readonly created_time: string;
  readonly from?: { readonly id: string };
}

interface FbCommentListResponse {
  readonly data: readonly FbCommentNode[];
}

interface FbCreatedComment {
  readonly id: string;
}

async function publishComment(
  graphClient: GraphClient,
  ctx: AccountContext,
  input: PublishInput,
): Promise<PublishedComment> {
  const credentials = credentialsFrom(ctx);
  // Facebook uses the same `/comments` edge for a top-level comment (under the post) and a reply
  // (under the parent comment) — only the anchor id changes.
  const anchorId = input.platformParentId ?? input.platformPostId;
  try {
    const response = await graphClient.request<FbCreatedComment>(
      credentials,
      'POST',
      `/${anchorId}/comments`,
      { message: input.text },
    );
    // The Graph API does not echo a created-time on write, so the call's own clock stands in.
    return { platformCommentId: response.data.id, platformCreatedAt: new Date() };
  } catch (error) {
    throw classifyGraphFailure(error);
  }
}

function matchesProbe(comment: FbCommentNode, ownId: string, probe: ReconcileProbe): boolean {
  if (comment.from?.id !== ownId || comment.message !== probe.text) {
    return false;
  }
  return new Date(comment.created_time) >= probe.windowStartsAt;
}

async function findPublishedComment(
  graphClient: GraphClient,
  ctx: AccountContext,
  probe: ReconcileProbe,
): Promise<PublishedComment | null> {
  const credentials = credentialsFrom(ctx);
  const anchorId = probe.platformParentId ?? probe.platformPostId;

  let response;
  try {
    response = await graphClient.request<FbCommentListResponse>(
      credentials,
      'GET',
      `/${anchorId}/comments`,
      { filter: 'stream', fields: 'id,message,created_time,from' },
    );
  } catch (error) {
    // A search that fails must never be read as "not found" — that would let the caller retry a
    // publish that may already have succeeded.
    throw classifyGraphFailure(error);
  }

  const match = response.data.data.find((comment) =>
    matchesProbe(comment, ctx.platformAccountId, probe),
  );
  return match === undefined
    ? null
    : { platformCommentId: match.id, platformCreatedAt: new Date(match.created_time) };
}

const NOT_IMPLEMENTED_MESSAGE = 'facebook read path is not implemented yet (T084)';

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

/**
 * Builds the Facebook adapter over a Graph client bound to `options.apiVersion`.
 *
 * Args:
 *   options: `apiVersion` (from `Config.META_GRAPH_API_VERSION`) and an optional `fetchImpl` for
 *     tests.
 */
export function createFacebookAdapter(options: {
  readonly apiVersion: string;
  readonly fetchImpl?: typeof fetch;
}): CommentPlatformAdapter {
  const graphClient = createGraphClient(options);

  return {
    platform: 'facebook',
    listComments,
    publishComment: (ctx, input) => publishComment(graphClient, ctx, input),
    findPublishedComment: (ctx, probe) => findPublishedComment(graphClient, ctx, probe),
    fetchComment,
  };
}
