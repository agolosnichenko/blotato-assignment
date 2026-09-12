/**
 * Read routes (T049, T094): `GET /v1/posts/:postId/comments`, `GET /v1/comments/:commentId/replies`,
 * `GET /v1/comments/:commentId`, `GET /v1/accounts/:accountId/comments`. Write routes (T069):
 * `POST /v1/posts/:postId/comments`, `POST /v1/comments/:commentId/replies`. Capability registry
 * route (T098): `GET /v1/platforms`. Sync routes (T090, D19): `POST /v1/posts/:postId/comments/sync`,
 * `GET /v1/comment-sync-jobs/:jobId`.
 *
 * Registered from `src/app/api.ts` as `app.register(registerCommentReadRoutes(deps))` /
 * `app.register(registerCommentWriteRoutes(deps))` / `app.register(registerPlatformRoutes())` —
 * never as bare `app.get()`/`app.post()` calls on the shared instance. `@fastify/rate-limit`
 * attaches through an `onRoute` hook fired at route-*definition* time; only a route defined inside
 * a plugin's own (avvio-queued) registration is guaranteed to run after that hook is wired up (see
 * `src/app/api.ts`'s `registerRateLimit` doc comment) — which is also what puts these `POST`
 * routes in the write rate-limit bucket (`isReadRequest` keys on HTTP method, not a route list).
 */

// oxlint-disable max-dependencies -- this file now registers all seven comment/platform HTTP
// routes (four read, two write, one capability listing), so it imports every use case, port and
// schema those routes call; splitting it would not reduce that fan-in, only hide it behind
// re-exports — the same trade `create-reply.ts` and `create-top-level-comment.ts` make for the
// same reason.
// oxlint-disable max-lines -- seven routes, each already factored into its own named
// `registerXRoute` function with its own docstring, is the file's actual scope, not padding.

import type { Queue } from 'bullmq';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Logger } from 'pino';
import { createReply } from '#src/modules/comments/application/create-reply.ts';
import { createTopLevelComment } from '#src/modules/comments/application/create-top-level-comment.ts';
import { getComment } from '#src/modules/comments/application/get-comment.ts';
import { listAccountComments } from '#src/modules/comments/application/list-account-comments.ts';
import { listPostComments } from '#src/modules/comments/application/list-post-comments.ts';
import { listReplies } from '#src/modules/comments/application/list-replies.ts';
import type { RequestSync } from '#src/modules/comments/application/request-sync.ts';
import type { CommentRepository } from '#src/modules/comments/infrastructure/comment-repository.ts';
import type { ContactQuota } from '#src/modules/comments/infrastructure/contact-quota.ts';
import {
  accountCommentsQuerySchema,
  accountIdParamsSchema,
  commentIdParamsSchema,
  commentSchema,
  commentsPageSchema,
  createCommentBodySchema,
  paginationQuerySchema,
  platformsPageSchema,
  postCommentsPageSchema,
  postIdParamsSchema,
  syncJobIdParamsSchema,
  syncJobSchema,
  toCommentResponse,
  toPlatformCapabilitiesResponse,
  toSyncJobResponse,
} from '#src/modules/comments/http/schemas.ts';
import type { Accounts, Posts } from '#src/modules/platform-core/ports.ts';
import { platformRegistry } from '#src/platforms/registry.ts';
import type { Database } from '#src/shared/db.ts';
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
  readonly accounts: Accounts;
}

export interface CommentWriteRoutesDeps {
  readonly database: Database;
  readonly repository: CommentRepository;
  readonly posts: Posts;
  readonly accounts: Accounts;
  readonly contactQuota: ContactQuota;
  readonly publishQueue: Queue;
  readonly logger: Logger;
}

export interface SyncRoutesDeps {
  readonly requestSync: RequestSync;
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

/** Builds the `GET /v1/accounts/:accountId/comments` route registered by {@link registerCommentReadRoutes}. */
function registerAccountCommentsRoute(
  app: Parameters<FastifyPluginAsyncZod>[0],
  deps: CommentReadRoutesDeps,
): void {
  app.get(
    '/v1/accounts/:accountId/comments',
    {
      schema: {
        params: accountIdParamsSchema,
        querystring: accountCommentsQuerySchema,
        response: { 200: commentsPageSchema },
      },
    },
    async (request) => {
      const { limit, cursor: rawCursor, order, since, until, isOwn } = request.query;
      const cursor = parseCursor(rawCursor, order);
      const result = await listAccountComments(
        { repository: deps.repository, accounts: deps.accounts },
        {
          workspaceId: request.workspaceId,
          accountId: request.params.accountId,
          limit,
          cursor,
          order,
          since: since === undefined ? null : new Date(since),
          until: until === undefined ? null : new Date(until),
          isOwn: isOwn ?? null,
        },
      );
      return {
        items: result.items.map(toCommentResponse),
        nextCursor: result.nextCursor === null ? null : encodeCursor(result.nextCursor),
      };
    },
  );
}

/**
 * The `Idempotency-Key` header (A12) — Fastify lower-cases incoming header names, so this is the
 * one place both write routes read it. `null` means "no key sent", not "empty key sent".
 */
function readIdempotencyKey(request: { headers: Record<string, unknown> }): string | null {
  const header = request.headers['idempotency-key'];
  return typeof header === 'string' && header.length > 0 ? header : null;
}

/** The `Location` header both write routes point at — the polling target (A11, rest-api.md). */
function locationForComment(commentId: string): string {
  return `/v1/comments/${commentId}`;
}

/** Builds the `POST /v1/posts/:postId/comments` route registered by {@link registerCommentWriteRoutes}. */
function registerCreateTopLevelCommentRoute(
  app: Parameters<FastifyPluginAsyncZod>[0],
  deps: CommentWriteRoutesDeps,
): void {
  app.post(
    '/v1/posts/:postId/comments',
    {
      schema: {
        params: postIdParamsSchema,
        body: createCommentBodySchema,
        response: { 202: commentSchema },
      },
    },
    async (request, reply) => {
      const comment = await createTopLevelComment(
        {
          database: deps.database,
          repository: deps.repository,
          posts: deps.posts,
          accounts: deps.accounts,
          publishQueue: deps.publishQueue,
          logger: deps.logger,
        },
        {
          workspaceId: request.workspaceId,
          postId: request.params.postId,
          text: request.body.text,
          idempotencyKey: readIdempotencyKey(request),
        },
      );
      return reply
        .code(202)
        .header('location', locationForComment(comment.id))
        .send(toCommentResponse(comment));
    },
  );
}

/** Builds the `POST /v1/comments/:commentId/replies` route registered by {@link registerCommentWriteRoutes}. */
function registerCreateReplyRoute(
  app: Parameters<FastifyPluginAsyncZod>[0],
  deps: CommentWriteRoutesDeps,
): void {
  app.post(
    '/v1/comments/:commentId/replies',
    {
      schema: {
        params: commentIdParamsSchema,
        body: createCommentBodySchema,
        response: { 202: commentSchema },
      },
    },
    async (request, reply) => {
      const comment = await createReply(
        {
          database: deps.database,
          repository: deps.repository,
          accounts: deps.accounts,
          contactQuota: deps.contactQuota,
          publishQueue: deps.publishQueue,
          logger: deps.logger,
        },
        {
          workspaceId: request.workspaceId,
          parentCommentId: request.params.commentId,
          text: request.body.text,
          idempotencyKey: readIdempotencyKey(request),
        },
      );
      return reply
        .code(202)
        .header('location', locationForComment(comment.id))
        .send(toCommentResponse(comment));
    },
  );
}

/**
 * Builds the `POST /v1/posts/:postId/comments/sync` route (T090, D19) — `request-sync.ts`'s own
 * `RequestSync.request` already decides `202` (active job, or a freshly created one) vs.
 * `429 SYNC_COOLDOWN`; this handler only maps its result/thrown `ApiError` onto the response.
 */
function registerRequestSyncRoute(
  app: Parameters<FastifyPluginAsyncZod>[0],
  deps: SyncRoutesDeps,
): void {
  app.post(
    '/v1/posts/:postId/comments/sync',
    { schema: { params: postIdParamsSchema, response: { 202: syncJobSchema } } },
    async (request, reply) => {
      const job = await deps.requestSync.request({
        workspaceId: request.workspaceId,
        postId: request.params.postId,
      });
      return reply.code(202).send(toSyncJobResponse(job));
    },
  );
}

/** Builds the `GET /v1/comment-sync-jobs/:jobId` route (T090). */
function registerGetSyncJobRoute(
  app: Parameters<FastifyPluginAsyncZod>[0],
  deps: SyncRoutesDeps,
): void {
  app.get(
    '/v1/comment-sync-jobs/:jobId',
    { schema: { params: syncJobIdParamsSchema, response: { 200: syncJobSchema } } },
    async (request) => {
      const job = await deps.requestSync.getJob({
        workspaceId: request.workspaceId,
        jobId: request.params.jobId,
      });
      return toSyncJobResponse(job);
    },
  );
}

/**
 * Builds the plugin `src/app/api.ts` registers for the two sync routes (T090, D19) — registered
 * inside its own plugin, not as bare `app.post()`/`app.get()` calls, for the same rate-limit-hook
 * ordering reason the module docstring gives for the write routes.
 *
 * Returns:
 *   A Fastify plugin, meant to be passed to `app.register(...)`.
 */
export function registerSyncRoutes(deps: SyncRoutesDeps): FastifyPluginAsyncZod {
  return (app) => {
    registerRequestSyncRoute(app, deps);
    registerGetSyncJobRoute(app, deps);
    return Promise.resolve();
  };
}

/**
 * Builds the plugin `src/app/api.ts` registers for the two write routes (T069).
 *
 * Args:
 *   deps: Everything `createTopLevelComment` and `createReply` need — the repository, the `Posts`
 *     and `Accounts` ports, `ContactQuota`, the publish queue and a logger.
 *
 * Returns:
 *   A Fastify plugin, meant to be passed to `app.register(...)`.
 */
export function registerCommentWriteRoutes(deps: CommentWriteRoutesDeps): FastifyPluginAsyncZod {
  return (app) => {
    registerCreateTopLevelCommentRoute(app, deps);
    registerCreateReplyRoute(app, deps);
    return Promise.resolve();
  };
}

/**
 * Builds the plugin `src/app/api.ts` registers for `GET /v1/platforms` (T098) — serialized
 * straight from `src/platforms/registry.ts`, no second source of truth (SC-009).
 *
 * Returns:
 *   A Fastify plugin, meant to be passed to `app.register(...)`.
 */
export function registerPlatformRoutes(): FastifyPluginAsyncZod {
  return (app) => {
    app.get('/v1/platforms', { schema: { response: { 200: platformsPageSchema } } }, () => ({
      items: Object.values(platformRegistry).map((capabilities) =>
        toPlatformCapabilitiesResponse(capabilities),
      ),
    }));
    return Promise.resolve();
  };
}

/**
 * Builds the plugin `src/app/api.ts` registers for the four read routes.
 *
 * Args:
 *   deps: The read repository, the `Posts` port `listPostComments` resolves tenancy through, and
 *     the `Accounts` port `listAccountComments` resolves tenancy through.
 *
 * Returns:
 *   A Fastify plugin, meant to be passed to `app.register(...)`.
 */
export function registerCommentReadRoutes(deps: CommentReadRoutesDeps): FastifyPluginAsyncZod {
  return (app) => {
    registerPostCommentsRoute(app, deps);
    registerRepliesRoute(app, deps);
    registerGetCommentRoute(app, deps);
    registerAccountCommentsRoute(app, deps);
    return Promise.resolve();
  };
}
