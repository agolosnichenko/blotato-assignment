/**
 * Facebook {@link CommentPlatformAdapter} (spec.md §8.2, contracts/platform-adapter.md).
 *
 * `publishComment` and `findPublishedComment` are T068's write path. `listComments` and
 * `fetchComment` (T084) are the read path: `GET /{post-id}/comments?filter=stream`, paging on the
 * Graph API's own `paging.cursors.after` until `paging.next` stops appearing — a page that throws
 * is never read as an empty-but-complete one, since that would let a sync walk conclude the post
 * has no more comments and mark the rest `deleted`. `paging.next` present with `paging.cursors.
 * after` absent is the same hazard by another route (§18): `nextCursorFor` throws there too,
 * rather than reading "cannot continue" as "finished".
 *
 * The Instagram login-variant distinction (D28) does not apply to Facebook accounts at all —
 * `ctx.credentials` is still passed through to `graph-client.ts` opaquely, the same as the
 * Instagram adapter, so the two stay symmetric and neither ever needs to know it exists.
 */

import { classifyGraphFailure } from '#src/platforms/meta/errors.ts';
import {
  createGraphClient,
  GraphHttpError,
  type GraphClient,
} from '#src/platforms/meta/graph-client.ts';
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
  readonly from?: { readonly id: string; readonly name?: string };
  readonly parent?: { readonly id: string };
}

/** The fields this adapter reads on every comment lookup — read and reply-parent shape alike. */
const COMMENT_FIELDS = 'id,message,created_time,from{id,name},parent';

interface FbPaging {
  readonly cursors?: { readonly after?: string };
  /** Presence, not content, is what means "there is another page" (Graph API convention). */
  readonly next?: string;
}

interface FbCommentListResponse {
  readonly data: readonly FbCommentNode[];
  readonly paging?: FbPaging;
}

/** Meta's documented shape for "this object id does not exist" (or is not visible to us). */
function isMissingObjectError(error: GraphHttpError): boolean {
  const body = error.body;
  if (body === null || typeof body !== 'object' || !('error' in body)) {
    return false;
  }
  const graphError = (body as { error?: { code?: number; error_subcode?: number } }).error;
  return graphError?.code === 100 && graphError.error_subcode === 33;
}

function normalizeFbComment(comment: FbCommentNode): NormalizedComment {
  return {
    platformCommentId: comment.id,
    platformParentId: comment.parent?.id ?? null,
    authorPlatformId: comment.from?.id ?? '',
    authorUsername: null,
    authorDisplayName: comment.from?.name ?? null,
    text: comment.message,
    platformCreatedAt: new Date(comment.created_time),
    platformMeta: {},
  };
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

async function listComments(
  graphClient: GraphClient,
  ctx: AccountContext,
  target: PostTarget,
  cursor?: string,
): Promise<CommentPage> {
  const credentials = credentialsFrom(ctx);
  let response;
  try {
    response = await graphClient.request<FbCommentListResponse>(
      credentials,
      'GET',
      `/${target.platformPostId}/comments`,
      {
        filter: 'stream',
        fields: COMMENT_FIELDS,
        ...(cursor === undefined ? {} : { after: cursor }),
      },
    );
  } catch (error) {
    // A page that fails must never be read as an empty-but-complete one — that would let a sync
    // walk conclude the post has no more comments and mark the rest deleted.
    throw classifyGraphFailure(error);
  }

  const comments = response.data.data.map(normalizeFbComment);
  const nextCursor = nextCursorFor(response.data.paging, target);
  return { comments, deletedPlatformCommentIds: [], nextCursor };
}

/**
 * `paging.next`'s presence, not its content, means "there is another page" (Graph API
 * convention) — but the cursor to fetch it with is `paging.cursors.after`, a separate field.
 * `next` present with `cursors.after` absent is not "no more pages": it is this adapter being
 * unable to continue the walk, and conflating the two would let a sync walk read an interrupted
 * page as a complete one and infer deletions for every page it never fetched (§7.3, SC-008).
 */
function nextCursorFor(paging: FbPaging | undefined, target: PostTarget): string | null {
  if (paging?.next === undefined) {
    return null;
  }
  if (paging.cursors?.after !== undefined) {
    return paging.cursors.after;
  }
  throw new Error(
    `facebook listComments: paging.next present but paging.cursors.after missing for post ` +
      `${target.platformPostId}`,
  );
}

async function fetchComment(
  graphClient: GraphClient,
  ctx: AccountContext,
  platformCommentId: string,
): Promise<NormalizedComment | null> {
  const credentials = credentialsFrom(ctx);
  let response;
  try {
    response = await graphClient.request<FbCommentNode>(
      credentials,
      'GET',
      `/${platformCommentId}`,
      {
        fields: COMMENT_FIELDS,
      },
    );
  } catch (error) {
    if (error instanceof GraphHttpError && isMissingObjectError(error)) {
      // A deleted or never-existing id — the same "nothing here" the port's `null` already
      // means, not a failure `ingest-comments.ts` (T077) should be blocked by.
      return null;
    }
    throw classifyGraphFailure(error);
  }
  return normalizeFbComment(response.data);
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
    listComments: (ctx, target, cursor) => listComments(graphClient, ctx, target, cursor),
    publishComment: (ctx, input) => publishComment(graphClient, ctx, input),
    findPublishedComment: (ctx, probe) => findPublishedComment(graphClient, ctx, probe),
    fetchComment: (ctx, platformCommentId) => fetchComment(graphClient, ctx, platformCommentId),
  };
}
