/**
 * Read side of the comments repository (T043, T044, T050).
 *
 * Every method takes `workspaceId` as a required parameter and puts it in the predicate — a row
 * belonging to another workspace is simply not found, never a `403` (D20, FR-026).
 *
 * `listTopLevelByPost` and `listRepliesByParent` share one keyset-paging implementation
 * ({@link listByPredicate}) driving `comments_post_top_level_idx` and `comments_replies_idx`
 * respectively (data-model.md §2): the `ORDER BY` matches each index's column order exactly, in
 * both directions, so Postgres can scan either index backwards instead of sorting. The keyset
 * comparison is a genuine Postgres row comparison, `(occurred_at, id) < (cursor)`, not the
 * `occurred_at < cursor OR (occurred_at = cursor AND id < cursor)` form that is easy to get
 * subtly wrong (R-02).
 *
 * The placeholder rule (FR-005, A4) is applied once, here, for both list methods: a `deleted`
 * comment is included only while `reply_count > 0` (it still has live replies hanging off it) —
 * `getById` is a direct lookup by id, not a list, and applies no such filter (T050).
 */

import { and, asc, desc, eq, gt, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  comments,
  commentSyncJobs,
  commentSyncTargets,
} from '#src/modules/comments/infrastructure/schema.ts';
import type { KeysetCursor, SortOrder } from '#src/shared/pagination.ts';

/** One comment row, as read back from `comments` — no API-shape mapping here (that's http/schemas.ts). */
export interface CommentRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly socialAccountId: string;
  readonly platform: string;
  readonly postId: string | null;
  readonly platformPostId: string;
  readonly parentCommentId: string | null;
  readonly platformCommentId: string | null;
  readonly depth: number;
  readonly isOwn: boolean;
  readonly authorPlatformId: string | null;
  readonly authorUsername: string | null;
  readonly authorDisplayName: string | null;
  readonly text: string | null;
  readonly status: string;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly replyCount: number;
  readonly occurredAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ListPagination {
  readonly limit: number;
  readonly cursor: KeysetCursor | null;
  readonly order: SortOrder;
}

export interface ListResult {
  readonly items: readonly CommentRecord[];
  readonly nextCursor: KeysetCursor | null;
}

/** `comment_sync_targets` / `comment_sync_jobs` for one post, as reported in a page's `sync` block. */
export interface SyncStatus {
  readonly lastSyncedAt: Date | null;
  readonly activeJobId: string | null;
}

export interface CommentRepository {
  listTopLevelByPost(
    workspaceId: string,
    postId: string,
    pagination: ListPagination,
  ): Promise<ListResult>;
  listRepliesByParent(
    workspaceId: string,
    parentCommentId: string,
    pagination: ListPagination,
  ): Promise<ListResult>;
  getById(workspaceId: string, commentId: string): Promise<CommentRecord | null>;
  getSyncStatus(workspaceId: string, postId: string): Promise<SyncStatus>;
}

const COMMENT_COLUMNS = {
  id: comments.id,
  workspaceId: comments.workspaceId,
  socialAccountId: comments.socialAccountId,
  platform: comments.platform,
  postId: comments.postId,
  platformPostId: comments.platformPostId,
  parentCommentId: comments.parentCommentId,
  platformCommentId: comments.platformCommentId,
  depth: comments.depth,
  isOwn: comments.isOwn,
  authorPlatformId: comments.authorPlatformId,
  authorUsername: comments.authorUsername,
  authorDisplayName: comments.authorDisplayName,
  text: comments.text,
  status: comments.status,
  errorCode: comments.errorCode,
  errorMessage: comments.errorMessage,
  replyCount: comments.replyCount,
  occurredAt: comments.occurredAt,
  createdAt: comments.createdAt,
  updatedAt: comments.updatedAt,
} as const;

/** A `deleted` comment is listed only while it still has live replies (FR-005, A4). */
function visibleInList(): SQL {
  return or(ne(comments.status, 'deleted'), gt(comments.replyCount, 0)) as SQL;
}

/**
 * The keyset predicate for one page, or `undefined` for the first page.
 *
 * The comparison is a Postgres row comparison over both cursor components together — `desc` scans
 * strictly-less, `asc` scans strictly-greater — which is what makes both directions correct across
 * a concurrent insert (SC-002): a row's position relative to the cursor never depends on which
 * component is compared first.
 */
function keysetPredicate(cursor: KeysetCursor | null, order: SortOrder): SQL | undefined {
  if (cursor === null) {
    return undefined;
  }
  const operator = order === 'desc' ? sql`<` : sql`>`;
  return sql`(${comments.occurredAt}, ${comments.id}) ${operator} (${cursor.occurredAt}, ${cursor.id})`;
}

function orderByFor(order: SortOrder): SQL[] {
  return order === 'desc'
    ? [desc(comments.occurredAt), desc(comments.id)]
    : [asc(comments.occurredAt), asc(comments.id)];
}

async function listByPredicate(
  db: NodePgDatabase,
  basePredicate: SQL,
  pagination: ListPagination,
): Promise<ListResult> {
  const keyset = keysetPredicate(pagination.cursor, pagination.order);
  const where =
    keyset === undefined
      ? and(basePredicate, visibleInList())
      : and(basePredicate, visibleInList(), keyset);

  const rows = await db
    .select(COMMENT_COLUMNS)
    .from(comments)
    .where(where)
    .orderBy(...orderByFor(pagination.order))
    .limit(pagination.limit + 1);

  const hasMore = rows.length > pagination.limit;
  const items = hasMore ? rows.slice(0, pagination.limit) : rows;
  const last = items.at(-1);
  const nextCursor =
    hasMore && last !== undefined
      ? { occurredAt: last.occurredAt, id: last.id, order: pagination.order }
      : null;

  return { items, nextCursor };
}

const ACTIVE_SYNC_JOB_STATUSES = ['queued', 'running'] as const;

function listTopLevelByPost(
  db: NodePgDatabase,
  workspaceId: string,
  postId: string,
  pagination: ListPagination,
): Promise<ListResult> {
  return listByPredicate(
    db,
    and(
      eq(comments.workspaceId, workspaceId),
      eq(comments.postId, postId),
      isNull(comments.parentCommentId),
    ) as SQL,
    pagination,
  );
}

function listRepliesByParent(
  db: NodePgDatabase,
  workspaceId: string,
  parentCommentId: string,
  pagination: ListPagination,
): Promise<ListResult> {
  return listByPredicate(
    db,
    and(
      eq(comments.workspaceId, workspaceId),
      eq(comments.parentCommentId, parentCommentId),
    ) as SQL,
    pagination,
  );
}

async function getById(
  db: NodePgDatabase,
  workspaceId: string,
  commentId: string,
): Promise<CommentRecord | null> {
  const [row] = await db
    .select(COMMENT_COLUMNS)
    .from(comments)
    .where(and(eq(comments.id, commentId), eq(comments.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

async function getSyncStatus(
  db: NodePgDatabase,
  workspaceId: string,
  postId: string,
): Promise<SyncStatus> {
  const [target] = await db
    .select({ id: commentSyncTargets.id, lastSyncedAt: commentSyncTargets.lastSyncedAt })
    .from(commentSyncTargets)
    .where(
      and(eq(commentSyncTargets.workspaceId, workspaceId), eq(commentSyncTargets.postId, postId)),
    )
    .limit(1);

  if (target === undefined) {
    return { lastSyncedAt: null, activeJobId: null };
  }

  const [job] = await db
    .select({ id: commentSyncJobs.id })
    .from(commentSyncJobs)
    .where(
      and(
        eq(commentSyncJobs.targetId, target.id),
        inArray(commentSyncJobs.status, ACTIVE_SYNC_JOB_STATUSES),
      ),
    )
    .limit(1);

  return { lastSyncedAt: target.lastSyncedAt, activeJobId: job?.id ?? null };
}

/** Backs {@link CommentRepository}; construct once per database handle (T043). */
export function createCommentRepository(db: NodePgDatabase): CommentRepository {
  return {
    listTopLevelByPost: (workspaceId, postId, pagination) =>
      listTopLevelByPost(db, workspaceId, postId, pagination),
    listRepliesByParent: (workspaceId, parentCommentId, pagination) =>
      listRepliesByParent(db, workspaceId, parentCommentId, pagination),
    getById: (workspaceId, commentId) => getById(db, workspaceId, commentId),
    getSyncStatus: (workspaceId, postId) => getSyncStatus(db, workspaceId, postId),
  };
}
