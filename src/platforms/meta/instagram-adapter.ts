/**
 * Instagram {@link CommentPlatformAdapter} (spec.md §8.2, contracts/platform-adapter.md).
 *
 * `publishComment` and `findPublishedComment` are T068's write path. `listComments` and
 * `fetchComment` are the read path — gated behind spike S2 (Instagram comment reads per login
 * variant), which has not run — and are left throwing rather than stubbed to an empty result: a
 * stub returning nothing would let a sync walk conclude a post has no comments and mark
 * everything `deleted`.
 *
 * This file never reads or branches on the Instagram login-variant distinction (D28) —
 * `ctx.credentials` is passed through to `graph-client.ts` opaquely, which is the only place that
 * distinction is resolved.
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
    throw new AuthError('instagram adapter received credentials in an unrecognised shape');
  }
  // Trusted to be the full record the `AccountCredentials` port produced (D26) — this adapter
  // reads none of its fields itself, it only forwards the object to the Graph client.
  return value as AccountCredentialsRecord;
}

interface IgCommentNode {
  readonly id: string;
  readonly text: string;
  readonly timestamp: string;
  readonly from?: { readonly id: string };
}

interface IgCommentListResponse {
  readonly data: readonly IgCommentNode[];
}

interface IgCreatedComment {
  readonly id: string;
}

async function publishComment(
  graphClient: GraphClient,
  ctx: AccountContext,
  input: PublishInput,
): Promise<PublishedComment> {
  const credentials = credentialsFrom(ctx);
  const anchorId = input.platformParentId ?? input.platformPostId;
  const edge = input.platformParentId === null ? 'comments' : 'replies';
  try {
    const response = await graphClient.request<IgCreatedComment>(
      credentials,
      'POST',
      `/${anchorId}/${edge}`,
      { message: input.text },
    );
    // The Graph API does not echo a created-time on write, so the call's own clock stands in.
    return { platformCommentId: response.data.id, platformCreatedAt: new Date() };
  } catch (error) {
    throw classifyGraphFailure(error);
  }
}

function matchesProbe(comment: IgCommentNode, ownId: string, probe: ReconcileProbe): boolean {
  if (comment.from?.id !== ownId || comment.text !== probe.text) {
    return false;
  }
  return new Date(comment.timestamp) >= probe.windowStartsAt;
}

async function findPublishedComment(
  graphClient: GraphClient,
  ctx: AccountContext,
  probe: ReconcileProbe,
): Promise<PublishedComment | null> {
  const credentials = credentialsFrom(ctx);
  const anchorId = probe.platformParentId ?? probe.platformPostId;
  const edge = probe.platformParentId === null ? 'comments' : 'replies';

  let response;
  try {
    response = await graphClient.request<IgCommentListResponse>(
      credentials,
      'GET',
      `/${anchorId}/${edge}`,
      { fields: 'id,text,timestamp,from' },
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
    : { platformCommentId: match.id, platformCreatedAt: new Date(match.timestamp) };
}

const NOT_IMPLEMENTED_MESSAGE = 'instagram read path is gated behind spike S2 (T084)';

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
 * Builds the Instagram adapter over a Graph client bound to `options.apiVersion`.
 *
 * Args:
 *   options: `apiVersion` (from `Config.META_GRAPH_API_VERSION`) and an optional `fetchImpl` for
 *     tests.
 */
export function createInstagramAdapter(options: {
  readonly apiVersion: string;
  readonly fetchImpl?: typeof fetch;
}): CommentPlatformAdapter {
  const graphClient = createGraphClient(options);

  return {
    platform: 'instagram',
    listComments,
    publishComment: (ctx, input) => publishComment(graphClient, ctx, input),
    findPublishedComment: (ctx, probe) => findPublishedComment(graphClient, ctx, probe),
    fetchComment,
  };
}
