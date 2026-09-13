/**
 * Instagram {@link CommentPlatformAdapter} (spec.md §8.2, §17 S2, contracts/platform-adapter.md).
 *
 * `publishComment` and `findPublishedComment` are T068's write path. `listComments` and
 * `fetchComment` (T084) are the read path, built against spike S2's `facebook_login` fixture
 * (`__fixtures__/s2-facebook-login-comments.json`) rather than the Graph docs — see
 * `flattenIgComments`, `normalizeIgComment` and `nextCursorFor` for what that fixture established
 * and what it did not. `deletedPlatformCommentIds` is always empty: Instagram has no tombstone
 * signal, so deletions rely solely on the absence fallback of a complete walk (FR-019).
 *
 * **Limitation:** a comment with more than one page of replies is not syncable yet (see
 * `flattenIgComments`) until a spike verifies the nested reply edge's own pager.
 *
 * This file never reads or branches on the Instagram login-variant distinction (D28) —
 * `ctx.credentials` is passed through to `graph-client.ts` opaquely, which is the only place that
 * distinction is resolved.
 */

import { classifyGraphFailure } from '#src/platforms/meta/errors.ts';
import { findCommentOnEdge } from '#src/platforms/meta/reconcile.ts';
import {
  createGraphClient,
  GraphHttpError,
  type GraphClient,
  type GraphUsage,
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
    throw new AuthError('instagram adapter received credentials in an unrecognised shape');
  }
  // Trusted to be the full record the `AccountCredentials` port produced (D26) — this adapter
  // reads none of its fields itself, it only forwards the object to the Graph client.
  return value as AccountCredentialsRecord;
}

interface IgFrom {
  readonly id: string;
  readonly username?: string;
}

interface IgPaging {
  readonly cursors?: { readonly after?: string };
  /** Presence, not content, is what means "there is another page" (Graph API convention). */
  readonly next?: string;
}

interface IgCommentNode {
  readonly id: string;
  readonly text: string;
  readonly timestamp: string;
  readonly from?: IgFrom;
  /** The nested reply edge's own pager, distinct from the top-level one — see `flattenIgComments`. */
  readonly replies?: { readonly data: readonly IgCommentNode[]; readonly paging?: IgPaging };
  /** Only requested by `fetchComment`; `listComments`'s own fields (verbatim from S2) omit it. */
  readonly parent_id?: string;
}

/** The fields `listComments` reads on every page (verbatim from the S2 spike, §17). */
const LIST_FIELDS = 'id,text,timestamp,from,replies{id,text,timestamp,from}';

/** The fields a single-comment `fetchComment` lookup reads; unexercised by S2 (see module docs). */
const FETCH_FIELDS = 'id,text,timestamp,from,parent_id';

interface IgCommentListResponse {
  readonly data: readonly IgCommentNode[];
  readonly paging?: IgPaging;
}

interface IgCreatedComment {
  readonly id: string;
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

function normalizeIgComment(
  node: IgCommentNode,
  platformParentId: string | null,
): NormalizedComment {
  return {
    platformCommentId: node.id,
    platformParentId,
    authorPlatformId: node.from?.id ?? null,
    authorUsername: node.from?.username ?? null,
    authorDisplayName: null,
    text: node.text,
    platformCreatedAt: new Date(node.timestamp),
    platformMeta: {},
  };
}

/**
 * Flattens one page's top-level comments and their nested replies (§17 S2) into the flat list the
 * port expects, each reply carrying the id of the comment it was nested under.
 *
 * Refuses rather than follows a truncated reply edge: Meta caps the nested `replies` edge (25 by
 * default), and a comment with more replies returns `replies.data` plus `replies.paging.next` for
 * the rest. Reading `replies.data` alone as the whole set would report this page complete while
 * having dropped replies — the hazard `nextCursorFor` already refuses for the top-level pager
 * (§18), one nesting level over and unexercised by any spike — so this throws instead of guessing
 * how to follow it; a thrown page aborts the walk, and FR-019 infers no deletions from it.
 */
function flattenIgComments(nodes: readonly IgCommentNode[]): NormalizedComment[] {
  const flattened: NormalizedComment[] = [];
  for (const node of nodes) {
    flattened.push(normalizeIgComment(node, null));
    if (node.replies?.paging?.next !== undefined) {
      throw new Error(
        `instagram listComments: comment ${node.id} has more replies than one page (` +
          `replies.paging.next present) — following a nested pager is unverified by any spike`,
      );
    }
    for (const reply of node.replies?.data ?? []) {
      flattened.push(normalizeIgComment(reply, node.id));
    }
  }
  return flattened;
}

/**
 * Mirrors `facebook-adapter.ts`'s `nextCursorFor`: `paging.next`'s presence, not its content,
 * means "there is another page", but the cursor to fetch it with is the separate
 * `paging.cursors.after` field. `next` present with `cursors.after` absent is this adapter being
 * unable to continue the walk, not "no more pages" — reading it as the latter would let a sync
 * walk conclude the post has no more comments and mark the rest deleted (§18).
 */
function nextCursorFor(paging: IgPaging | undefined, target: PostTarget): string | null {
  if (paging?.next === undefined) {
    return null;
  }
  if (paging.cursors?.after !== undefined) {
    return paging.cursors.after;
  }
  throw new Error(
    `instagram listComments: paging.next present but paging.cursors.after missing for post ` +
      `${target.platformPostId}`,
  );
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
    throw classifyGraphFailure(error, 'write');
  }
}

function matchesProbe(comment: IgCommentNode, ownId: string, probe: ReconcileProbe): boolean {
  if (comment.from?.id !== ownId || comment.text !== probe.text) {
    return false;
  }
  return new Date(comment.timestamp) >= probe.windowStartsAt;
}

/**
 * Searches the anchor's comment (or reply) edge for our own comment (FR-011, D14).
 *
 * The walk itself — and why an unfinished one must raise rather than answer "not found" — lives in
 * `reconcile.ts`; this only describes Instagram's edge and what counts as a match on it.
 */
function findPublishedComment(
  graphClient: GraphClient,
  ctx: AccountContext,
  probe: ReconcileProbe,
): Promise<PublishedComment | null> {
  const anchorId = probe.platformParentId ?? probe.platformPostId;
  return findCommentOnEdge(graphClient, credentialsFrom(ctx), {
    platform: 'instagram',
    path: `/${anchorId}/${probe.platformParentId === null ? 'comments' : 'replies'}`,
    fields: 'id,text,timestamp,from',
    match: (node: IgCommentNode) =>
      matchesProbe(node, ctx.platformAccountId, probe)
        ? { platformCommentId: node.id, platformCreatedAt: new Date(node.timestamp) }
        : null,
  });
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
    response = await graphClient.request<IgCommentListResponse>(
      credentials,
      'GET',
      `/${target.platformPostId}/comments`,
      {
        fields: LIST_FIELDS,
        ...(cursor === undefined ? {} : { after: cursor }),
      },
    );
  } catch (error) {
    // A page that fails must never be read as an empty-but-complete one — that would let a sync
    // walk conclude the post has no more comments and mark the rest deleted.
    throw classifyGraphFailure(error, 'read');
  }

  const comments = flattenIgComments(response.data.data);
  const nextCursor = nextCursorFor(response.data.paging, target);
  // Instagram has no tombstone signal; deletions rely solely on the absence fallback of a
  // complete walk (FR-019) — this field exists only so a platform that does have one (Bluesky)
  // cannot smuggle tombstones through `comments` (§18).
  return { comments, deletedPlatformCommentIds: [], nextCursor };
}

async function fetchComment(
  graphClient: GraphClient,
  ctx: AccountContext,
  platformCommentId: string,
): Promise<NormalizedComment | null> {
  const credentials = credentialsFrom(ctx);
  let response;
  try {
    response = await graphClient.request<IgCommentNode>(
      credentials,
      'GET',
      `/${platformCommentId}`,
      { fields: FETCH_FIELDS },
    );
  } catch (error) {
    if (error instanceof GraphHttpError && isMissingObjectError(error)) {
      // A deleted or never-existing id — the same "nothing here" the port's `null` already
      // means, not a failure `ingest-comments.ts` (T077) should be blocked by.
      return null;
    }
    throw classifyGraphFailure(error, 'read');
  }
  return normalizeIgComment(response.data, response.data.parent_id ?? null);
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
  /** Forwarded to the Graph client; see `GraphClientOptions.onUsage` (spec.md §8.2). */
  readonly onUsage?: (socialAccountId: string, usage: GraphUsage) => void;
}): CommentPlatformAdapter {
  const graphClient = createGraphClient(options);

  return {
    platform: 'instagram',
    listComments: (ctx, target, cursor) => listComments(graphClient, ctx, target, cursor),
    publishComment: (ctx, input) => publishComment(graphClient, ctx, input),
    findPublishedComment: (ctx, probe) => findPublishedComment(graphClient, ctx, probe),
    fetchComment: (ctx, platformCommentId) => fetchComment(graphClient, ctx, platformCommentId),
  };
}
