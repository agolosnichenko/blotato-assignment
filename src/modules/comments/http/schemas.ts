/**
 * Zod schemas for the read routes (T048, T050) — contracts/rest-api.md's `Comment` shape, the
 * shared pagination query and the mapping from a repository row to the wire representation.
 *
 * `toCommentResponse` is where `error` collapses to `{ code, message }` only when `status` is
 * `failed` (otherwise null, T048) and where a deleted comment's `author` reads back as `null`
 * (T050) — both follow directly from the columns already being null in that case (data-model.md
 * §2: `author_*`/`text` are nulled on deletion, `error_code`/`error_message` are set only when
 * `failed`), so this function states the rule rather than re-deciding it. Which *rows* reach this
 * mapping at all — the placeholder-vs-omit split for a deleted comment — is the repository's job
 * (`comment-repository.ts`'s `visibleInList`), not this file's.
 */

import { z } from 'zod';
import type { CommentRecord } from '#src/modules/comments/infrastructure/comment-repository.ts';
import type { SyncJobRecord } from '#src/modules/comments/application/request-sync.ts';
import type { PlatformCapabilities } from '#src/platforms/registry.ts';
import type { SortOrder } from '#src/shared/pagination.ts';

export const postIdParamsSchema = z.object({ postId: z.uuid() });
export const commentIdParamsSchema = z.object({ commentId: z.uuid() });
export const syncJobIdParamsSchema = z.object({ jobId: z.uuid() });

const DEFAULT_LIMIT = 20;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;

/** The shared `limit`/`cursor`/`order` query schema (T048) — `order`'s default varies by route. */
export function paginationQuerySchema(defaultOrder: SortOrder) {
  return z.object({
    limit: z.coerce.number().int().min(MIN_LIMIT).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    cursor: z.string().min(1).optional(),
    order: z.enum(['asc', 'desc']).default(defaultOrder),
  });
}

const commentAuthorSchema = z
  .object({
    platformId: z.string(),
    username: z.string().nullable(),
    displayName: z.string().nullable(),
  })
  .nullable();

const commentErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
  })
  .nullable();

export const commentSchema = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  platform: z.string(),
  postId: z.uuid().nullable(),
  platformPostId: z.string(),
  parentCommentId: z.uuid().nullable(),
  platformCommentId: z.string().nullable(),
  depth: z.number().int().nonnegative(),
  isOwn: z.boolean(),
  author: commentAuthorSchema,
  text: z.string().nullable(),
  status: z.enum(['queued', 'processing', 'posted', 'failed', 'deleted']),
  error: commentErrorSchema,
  replyCount: z.number().int().nonnegative(),
  occurredAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type CommentResponse = z.infer<typeof commentSchema>;

export const commentsPageSchema = z.object({
  items: z.array(commentSchema),
  nextCursor: z.string().nullable(),
});

export const postCommentsPageSchema = commentsPageSchema.extend({
  sync: z.object({
    lastSyncedAt: z.iso.datetime().nullable(),
    activeJobId: z.uuid().nullable(),
  }),
});

/** Request body shared by both write routes (contracts/rest-api.md `POST .../comments`, `.../replies`). */
export const createCommentBodySchema = z.object({ text: z.string().min(1) });

export type CreateCommentBody = z.infer<typeof createCommentBodySchema>;

/**
 * `PlatformCapabilities` (contracts/rest-api.md, T098) — the fields present depend on
 * `supportsComments`: a supported entry carries `canCreateTopLevel`/`canReply`/`maxReplyDepth`/
 * `textLimit`/`textUnit`/`ingestion`, an unsupported one carries only `unsupportedReason`.
 */
export const platformCapabilitiesSchema = z.object({
  platform: z.string(),
  supportsComments: z.boolean(),
  canCreateTopLevel: z.boolean().optional(),
  canReply: z.boolean().optional(),
  maxReplyDepth: z.number().int().nonnegative().nullable().optional(),
  textLimit: z.number().int().positive().optional(),
  textUnit: z.enum(['characters', 'graphemes']).optional(),
  ingestion: z.enum(['webhook+sync', 'sync']).optional(),
  unsupportedReason: z.string().optional(),
});

export type PlatformCapabilitiesResponse = z.infer<typeof platformCapabilitiesSchema>;

export const platformsPageSchema = z.object({ items: z.array(platformCapabilitiesSchema) });

/** `SyncJob` (contracts/rest-api.md, D19, T090) — the `POST .../sync` and `GET .../comment-sync-jobs/:jobId` response body. */
const syncJobStatsSchema = z
  .object({
    fetched: z.number().int().nonnegative(),
    inserted: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    deleted: z.number().int().nonnegative(),
  })
  .nullable();

export const syncJobSchema = z.object({
  id: z.uuid(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  trigger: z.enum(['manual', 'scheduled', 'post_published']),
  stats: syncJobStatsSchema,
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
});

export type SyncJobResponse = z.infer<typeof syncJobSchema>;

/**
 * Maps one `RequestSync` job record to the `SyncJob` wire shape.
 *
 * Args:
 *   record: The job as read by `request-sync.ts`.
 *
 * Returns:
 *   The `SyncJob` representation contracts/rest-api.md documents.
 */
export function toSyncJobResponse(record: SyncJobRecord): SyncJobResponse {
  return {
    id: record.id,
    status: record.status,
    trigger: record.trigger,
    stats: record.stats,
    error: record.error,
    createdAt: record.createdAt.toISOString(),
    startedAt: record.startedAt === null ? null : record.startedAt.toISOString(),
    finishedAt: record.finishedAt === null ? null : record.finishedAt.toISOString(),
  };
}

/**
 * Maps one `platformRegistry` entry to the `PlatformCapabilities` wire shape (T098) — serialized
 * straight from `src/platforms/registry.ts`, no second source of truth (data-model.md §4).
 *
 * Args:
 *   capabilities: One entry from `platformRegistry`.
 *
 * Returns:
 *   The `PlatformCapabilities` representation contracts/rest-api.md documents.
 */
export function toPlatformCapabilitiesResponse(
  capabilities: PlatformCapabilities,
): PlatformCapabilitiesResponse {
  if (!capabilities.supportsComments) {
    return {
      platform: capabilities.platform,
      supportsComments: false,
      unsupportedReason: capabilities.unsupportedReason,
    };
  }
  return {
    platform: capabilities.platform,
    supportsComments: true,
    canCreateTopLevel: capabilities.supportsTopLevel,
    canReply: capabilities.supportsReply,
    maxReplyDepth: capabilities.maxReplyDepth,
    textLimit: capabilities.textLimit,
    textUnit: capabilities.textUnit,
    ingestion: capabilities.ingestion,
  };
}

/**
 * Maps one repository row to the `Comment` wire shape.
 *
 * Args:
 *   record: The row as read by `comment-repository.ts`.
 *
 * Returns:
 *   The `Comment` representation contracts/rest-api.md documents.
 */
export function toCommentResponse(record: CommentRecord): CommentResponse {
  return {
    id: record.id,
    accountId: record.socialAccountId,
    platform: record.platform,
    postId: record.postId,
    platformPostId: record.platformPostId,
    parentCommentId: record.parentCommentId,
    platformCommentId: record.platformCommentId,
    depth: record.depth,
    isOwn: record.isOwn,
    author:
      record.authorPlatformId === null
        ? null
        : {
            platformId: record.authorPlatformId,
            username: record.authorUsername,
            displayName: record.authorDisplayName,
          },
    text: record.text,
    status: record.status as CommentResponse['status'],
    error:
      record.status === 'failed' && record.errorCode !== null
        ? { code: record.errorCode, message: record.errorMessage ?? '' }
        : null,
    replyCount: record.replyCount,
    occurredAt: record.occurredAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
