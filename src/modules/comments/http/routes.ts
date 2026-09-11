/**
 * Read routes (T049): `GET /v1/posts/:postId/comments`, `GET /v1/comments/:commentId/replies`,
 * `GET /v1/comments/:commentId`.
 *
 * Registered from `src/app/api.ts` as `app.register(registerCommentReadRoutes(deps))` — never as
 * bare `app.get()` calls on the shared instance. `@fastify/rate-limit` attaches through an
 * `onRoute` hook fired at route-*definition* time; only a route defined inside a plugin's own
 * (avvio-queued) registration is guaranteed to run after that hook is wired up (see
 * `src/app/api.ts`'s `registerRateLimit` doc comment).
 */

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getComment } from '#src/modules/comments/application/get-comment.ts';
import { listPostComments } from '#src/modules/comments/application/list-post-comments.ts';
import { listReplies } from '#src/modules/comments/application/list-replies.ts';
import type { CommentRepository } from '#src/modules/comments/infrastructure/comment-repository.ts';
import {
  commentIdParamsSchema,
  commentSchema,
  commentsPageSchema,
  paginationQuerySchema,
  postCommentsPageSchema,
  postIdParamsSchema,
  toCommentResponse,
} from '#src/modules/comments/http/schemas.ts';
import type { Posts } from '#src/modules/platform-core/ports.ts';
import { ApiError } from '#src/shared/errors.ts';
import {
  decodeCursor,
  encodeCursor,
  type KeysetCursor,
  type SortOrder,
} from '#src/shared/pagination.ts';

export interface CommentReadRoutesDeps {
  readonly repository: CommentRepository;
  readonly posts: Posts;
}

const postCommentsQuerySchema = paginationQuerySchema('desc');
const repliesQuerySchema = paginationQuerySchema('asc');

/**
 * Decodes a request's `cursor` query param, throwing the `400 VALIDATION_ERROR` (contracts/
 * rest-api.md) the shared pagination codec reports for a malformed or order-mismatched cursor.
 */
function parseCursor(raw: string | undefined, order: SortOrder): KeysetCursor | null {
  if (raw === undefined) {
    return null;
  }
  const decoded = decodeCursor(raw, order);
  if (!decoded.ok) {
    const detail =
      decoded.error === 'ORDER_MISMATCH'
        ? 'cursor was issued under a different order'
        : 'cursor is malformed';
    throw new ApiError('VALIDATION_ERROR', detail);
  }
  return decoded.cursor;
}

/** Builds the `GET /v1/posts/:postId/comments` route registered by {@link registerCommentReadRoutes}. */
function registerPostCommentsRoute(
  app: Parameters<FastifyPluginAsyncZod>[0],
  deps: CommentReadRoutesDeps,
): void {
  app.get(
    '/v1/posts/:postId/comments',
    {
      schema: {
        params: postIdParamsSchema,
        querystring: postCommentsQuerySchema,
        response: { 200: postCommentsPageSchema },
      },
    },
    async (request) => {
      const { limit, cursor: rawCursor, order } = request.query;
      const cursor = parseCursor(rawCursor, order);
      const result = await listPostComments(
        { repository: deps.repository, posts: deps.posts },
        { workspaceId: request.workspaceId, postId: request.params.postId, limit, cursor, order },
      );
      return {
        items: result.items.map(toCommentResponse),
        nextCursor: result.nextCursor === null ? null : encodeCursor(result.nextCursor),
        sync: {
          lastSyncedAt:
            result.sync.lastSyncedAt === null ? null : result.sync.lastSyncedAt.toISOString(),
          activeJobId: result.sync.activeJobId,
        },
      };
    },
  );
}

/** Builds the `GET /v1/comments/:commentId/replies` route registered by {@link registerCommentReadRoutes}. */
function registerRepliesRoute(
  app: Parameters<FastifyPluginAsyncZod>[0],
  deps: CommentReadRoutesDeps,
): void {
  app.get(
    '/v1/comments/:commentId/replies',
    {
      schema: {
        params: commentIdParamsSchema,
        querystring: repliesQuerySchema,
        response: { 200: commentsPageSchema },
      },
    },
    async (request) => {
      const { limit, cursor: rawCursor, order } = request.query;
      const cursor = parseCursor(rawCursor, order);
      const result = await listReplies(
        { repository: deps.repository },
        {
          workspaceId: request.workspaceId,
          parentCommentId: request.params.commentId,
          limit,
          cursor,
          order,
        },
      );
      return {
        items: result.items.map(toCommentResponse),
        nextCursor: result.nextCursor === null ? null : encodeCursor(result.nextCursor),
      };
    },
  );
}

/** Builds the `GET /v1/comments/:commentId` route registered by {@link registerCommentReadRoutes}. */
function registerGetCommentRoute(
  app: Parameters<FastifyPluginAsyncZod>[0],
  deps: CommentReadRoutesDeps,
): void {
  app.get(
    '/v1/comments/:commentId',
    { schema: { params: commentIdParamsSchema, response: { 200: commentSchema } } },
    async (request) => {
      const comment = await getComment(
        { repository: deps.repository },
        { workspaceId: request.workspaceId, commentId: request.params.commentId },
      );
      return toCommentResponse(comment);
    },
  );
}

/**
 * Builds the plugin `src/app/api.ts` registers for the three read routes.
 *
 * Args:
 *   deps: The read repository and the `Posts` port `listPostComments` resolves tenancy through.
 *
 * Returns:
 *   A Fastify plugin, meant to be passed to `app.register(...)`.
 */
export function registerCommentReadRoutes(deps: CommentReadRoutesDeps): FastifyPluginAsyncZod {
  return (app) => {
    registerPostCommentsRoute(app, deps);
    registerRepliesRoute(app, deps);
    registerGetCommentRoute(app, deps);
    return Promise.resolve();
  };
}
