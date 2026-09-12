/**
 * Comments repository — read side (T043, T044, T050) and write side (T056).
 *
 * Every method takes `workspaceId` as a required parameter and puts it in the predicate — a row
 * belonging to another workspace is simply not found, never a `403` (D20, FR-026).
 *
 * `listTopLevelByPost`, `listRepliesByParent` and `listByAccount` share one keyset-paging
 * implementation ({@link listByPredicate}) driving `comments_post_top_level_idx`,
 * `comments_replies_idx` and `comments_social_account_idx` respectively (data-model.md §2): the
 * `ORDER BY` matches each index's column order exactly, in both directions, so Postgres can scan
 * either index backwards instead of sorting. The keyset comparison is a genuine Postgres row
 * comparison, `(occurred_at, id) < (cursor)`, not the `occurred_at < cursor OR (occurred_at =
 * cursor AND id < cursor)` form that is easy to get subtly wrong (R-02).
 *
 * The placeholder rule (FR-005, A4) is applied once, here, for both list methods: a `deleted`
 * comment is included only while `reply_count > 0` (it still has live replies hanging off it) —
 * `getById` is a direct lookup by id, not a list, and applies no such filter (T050).
 *
 * The write side's four transitions (`markProcessing`, `markPosted`, `markFailed`,
 * `markQueuedForRetry`) are conditional `UPDATE ... WHERE status = <expected>` statements whose
 * affected-row count is returned to the caller (R-10, Principle III) — a `false` is not an error,
 * it means another worker already moved this row and the caller must stop, not retry the write.
 * `src/modules/comments/domain/status.ts` is consulted for legality rather than re-encoded here,
 * so there is exactly one place that decides which `from -> to` moves exist.
 *
 * Every write method takes the caller's open transaction ({@link OutboxTransaction}) rather than
 * opening its own, so a use case can append to the outbox (D9) in the same transaction as the
 * state change — the type itself refuses a plain database handle, the same enforcement
 * `appendToOutbox` uses.
 */

// oxlint-disable max-lines -- one workspace-scoped repository implementing one CommentRepository
// interface (read side T043/T044/T050, write side T056); splitting read and write across files
// would duplicate CommentRecord, COMMENT_COLUMNS and the workspace-scoping discipline documented
// above instead of removing any of it.

import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { canTransition, type CommentStatus } from '#src/modules/comments/domain/status.ts';
import type { OutboxTransaction } from '#src/modules/comments/infrastructure/outbox.ts';
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

/**
 * Predicates for the account inbox (T092, FR-008), on top of the `workspaceId`/`socialAccountId`
 * scope every call carries regardless — `since`/`until` are both inclusive bounds on `occurredAt`
 * and `isOwn` is an exact match, all optional so the first page of an unfiltered inbox is just the
 * scope alone.
 */
export interface ListByAccountFilters {
  readonly since?: Date;
  readonly until?: Date;
  readonly isOwn?: boolean;
}

/** `comment_sync_targets` / `comment_sync_jobs` for one post, as reported in a page's `sync` block. */
export interface SyncStatus {
  readonly lastSyncedAt: Date | null;
  readonly activeJobId: string | null;
}

/**
 * Fields needed to insert a `queued`, API-created comment (D12, A12) — a reply when
 * `parentCommentId` is given, a top-level comment when it is `null`. `depth` and the row's
 * `rootCommentId` are not inputs: `insertQueued` derives both from the parent row itself (reading
 * `comments_depth_matches_parent`'s invariant the same way the schema enforces it), so there is
 * one place, not two, that can get the depth/root pairing wrong.
 */
export interface InsertQueuedInput {
  readonly socialAccountId: string;
  readonly platform: string;
  readonly postId: string | null;
  readonly platformPostId: string;
  /** `null` for a top-level comment; the comment being replied to otherwise. */
  readonly parentCommentId: string | null;
  readonly authorPlatformId: string;
  readonly text: string;
  readonly idempotencyKey: string | null;
}

export interface MarkPostedInput {
  readonly platformCommentId: string;
}

export interface MarkFailedInput {
  readonly errorCode: string;
  readonly errorMessage: string;
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
  /**
   * The account inbox, driving `comments_social_account_idx` (`social_account_id, occurred_at
   * DESC, id DESC`) — no join to the `posts` projection and no filter on a post resolving (A10a,
   * D8, D29): a comment is this service's own row, never dependent on the projection to be
   * listed. Spans every post on the account, internal and external alike (D13) — including
   * replies, since the index carries no `parent_comment_id` predicate the way
   * `comments_post_top_level_idx` does.
   */
  listByAccount(
    workspaceId: string,
    socialAccountId: string,
    filters: ListByAccountFilters,
    pagination: ListPagination,
  ): Promise<ListResult>;
  getById(workspaceId: string, commentId: string): Promise<CommentRecord | null>;
  getSyncStatus(workspaceId: string, postId: string): Promise<SyncStatus>;
  findByIdempotencyKey(workspaceId: string, idempotencyKey: string): Promise<CommentRecord | null>;
  /**
   * Inserts a `queued`, API-created comment. With a `parentCommentId`, this is a reply: depth and
   * root are derived from the parent row, and — in the same transaction — the parent's
   * `reply_count` increments and the root's `last_activity_at` moves. With `parentCommentId:
   * null`, this is a top-level comment: depth 0, no parent to bump, and the row is its own root,
   * so `last_activity_at` is set on itself at insert. Either way `last_activity_at` on the root is
   * the retention key (A9): a thread that just received activity must not be purged as stale.
   */
  insertQueued(
    tx: OutboxTransaction,
    workspaceId: string,
    input: InsertQueuedInput,
  ): Promise<CommentRecord>;
  /**
   * `queued -> processing`. Bumps `attemptCount` and stamps `lastAttemptStartedAt` — the anchor
   * the stuck-work sweeper's `COALESCE(last_attempt_started_at, created_at)` selector reads.
   * Returns `false`, not an error, when the row was not `queued` (another worker already claimed
   * it) — the caller must stop, not proceed to publish.
   */
  markProcessing(tx: OutboxTransaction, workspaceId: string, commentId: string): Promise<boolean>;
  /**
   * `processing -> posted`. Also clears `errorCode`/`errorMessage`: a row can re-enter
   * `processing` after an earlier attempt failed and was retried (`markQueuedForRetry`), and
   * `rest-api.md`'s `Comment.error` is present only while `status = 'failed'` — clearing it here
   * keeps that invariant in the data itself rather than relying on the serializer to suppress a
   * stale error on every other status. Returns `false`, not an error, when the row was not
   * `processing` — the caller must not treat this as a successful publish.
   */
  markPosted(
    tx: OutboxTransaction,
    workspaceId: string,
    commentId: string,
    input: MarkPostedInput,
  ): Promise<boolean>;
  /**
   * `processing -> failed`, terminal (D14: `PermanentError`, `AuthError`, or attempts exhausted).
   * Returns `false`, not an error, when the row was not `processing`.
   */
  markFailed(
    tx: OutboxTransaction,
    workspaceId: string,
    commentId: string,
    input: MarkFailedInput,
  ): Promise<boolean>;
  /**
   * `processing -> queued`, for a bounded retry (`RetryableError` / `OutcomeUnknownError` with no
   * reconciled outcome). Leaves `lastAttemptStartedAt` untouched — it stays the sweeper's anchor
   * for "how long has this retry been pending" until the next `markProcessing` call updates it.
   * Returns `false`, not an error, when the row was not `processing`.
   */
  markQueuedForRetry(
    tx: OutboxTransaction,
    workspaceId: string,
    commentId: string,
  ): Promise<boolean>;
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

function listByAccount(
  db: NodePgDatabase,
  workspaceId: string,
  socialAccountId: string,
  filters: ListByAccountFilters,
  pagination: ListPagination,
): Promise<ListResult> {
  const conditions: SQL[] = [
    eq(comments.workspaceId, workspaceId),
    eq(comments.socialAccountId, socialAccountId),
  ];
  if (filters.since !== undefined) {
    conditions.push(gte(comments.occurredAt, filters.since));
  }
  if (filters.until !== undefined) {
    conditions.push(lte(comments.occurredAt, filters.until));
  }
  if (filters.isOwn !== undefined) {
    conditions.push(eq(comments.isOwn, filters.isOwn));
  }
  return listByPredicate(db, and(...conditions) as SQL, pagination);
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

async function findByIdempotencyKey(
  db: NodePgDatabase,
  workspaceId: string,
  idempotencyKey: string,
): Promise<CommentRecord | null> {
  const [row] = await db
    .select(COMMENT_COLUMNS)
    .from(comments)
    .where(and(eq(comments.workspaceId, workspaceId), eq(comments.idempotencyKey, idempotencyKey)))
    .limit(1);
  return row ?? null;
}

interface ParentForInsert {
  readonly id: string;
  readonly depth: number;
  readonly rootCommentId: string | null;
}

/** The parent row's `depth` and `rootCommentId`, scoped by workspace — {@link insertQueued}'s only read. */
async function loadParentForInsert(
  tx: OutboxTransaction,
  workspaceId: string,
  parentCommentId: string,
): Promise<ParentForInsert | null> {
  const [row] = await tx
    .select({ id: comments.id, depth: comments.depth, rootCommentId: comments.rootCommentId })
    .from(comments)
    .where(and(eq(comments.id, parentCommentId), eq(comments.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

interface Placement {
  readonly parent: ParentForInsert | null;
  readonly depth: number;
  readonly rootCommentId: string | null;
}

/**
 * Resolves where a new comment sits: `null` in, `parentCommentId` means top-level (depth 0, no
 * root). Otherwise depth and root come from the parent row — a depth-1 reply's parent is itself
 * the root (its own `rootCommentId` is null, being top-level); any deeper reply inherits the
 * parent's `rootCommentId` directly.
 */
async function resolvePlacement(
  tx: OutboxTransaction,
  workspaceId: string,
  parentCommentId: string | null,
): Promise<Placement> {
  if (parentCommentId === null) {
    return { parent: null, depth: 0, rootCommentId: null };
  }

  const parent = await loadParentForInsert(tx, workspaceId, parentCommentId);
  if (parent === null) {
    throw new Error(`insertQueued: parent comment ${parentCommentId} not found`);
  }

  return { parent, depth: parent.depth + 1, rootCommentId: parent.rootCommentId ?? parent.id };
}

/**
 * The thread bookkeeping that must commit with the insert (data-model.md §2): the parent's
 * `reply_count` increments and the root's `last_activity_at` moves. A top-level comment has no
 * parent to bump and is its own root, whose `last_activity_at` the insert itself already set — a
 * no-op here.
 */
async function bumpParentAndRoot(
  tx: OutboxTransaction,
  workspaceId: string,
  placement: Placement,
  now: Date,
): Promise<void> {
  if (placement.parent === null || placement.rootCommentId === null) {
    return;
  }

  await tx
    .update(comments)
    .set({ replyCount: sql`${comments.replyCount} + 1`, updatedAt: now })
    .where(and(eq(comments.id, placement.parent.id), eq(comments.workspaceId, workspaceId)));

  await tx
    .update(comments)
    .set({ lastActivityAt: now, updatedAt: now })
    .where(and(eq(comments.id, placement.rootCommentId), eq(comments.workspaceId, workspaceId)));
}

async function insertQueued(
  tx: OutboxTransaction,
  workspaceId: string,
  input: InsertQueuedInput,
): Promise<CommentRecord> {
  const now = new Date();
  const placement = await resolvePlacement(tx, workspaceId, input.parentCommentId);

  const [row] = await tx
    .insert(comments)
    .values({
      workspaceId,
      socialAccountId: input.socialAccountId,
      platform: input.platform,
      postId: input.postId,
      platformPostId: input.platformPostId,
      parentCommentId: input.parentCommentId,
      rootCommentId: placement.rootCommentId,
      depth: placement.depth,
      isOwn: true,
      source: 'api',
      authorPlatformId: input.authorPlatformId,
      text: input.text,
      status: 'queued',
      idempotencyKey: input.idempotencyKey,
      replyCount: 0,
      lastActivityAt: now,
      occurredAt: now,
    })
    .returning(COMMENT_COLUMNS);

  if (row === undefined) {
    throw new Error('insertQueued: insert returned no row');
  }

  // Same transaction as the insert — a crash between the two would otherwise leave a reply the
  // parent's reply_count does not know about, or a root whose last_activity_at understates how
  // fresh the thread actually is.
  await bumpParentAndRoot(tx, workspaceId, placement, now);

  return row;
}

/**
 * Applies one conditional transition, consulting {@link canTransition} rather than re-deciding
 * legality here. Throws on an illegal pair — that is a caller bug, not a lost race — and returns
 * whether the `UPDATE` actually matched a row for a legal one.
 */
async function applyTransition(
  tx: OutboxTransaction,
  workspaceId: string,
  commentId: string,
  from: CommentStatus,
  to: CommentStatus,
  set: Record<string, unknown>,
): Promise<boolean> {
  if (!canTransition(from, to)) {
    throw new Error(`comment-repository: illegal transition ${from} -> ${to}`);
  }

  const result = await tx
    .update(comments)
    .set({ status: to, updatedAt: new Date(), ...set })
    .where(
      and(
        eq(comments.id, commentId),
        eq(comments.workspaceId, workspaceId),
        eq(comments.status, from),
      ),
    );

  return (result.rowCount ?? 0) > 0;
}

function markProcessing(
  tx: OutboxTransaction,
  workspaceId: string,
  commentId: string,
): Promise<boolean> {
  return applyTransition(tx, workspaceId, commentId, 'queued', 'processing', {
    attemptCount: sql`${comments.attemptCount} + 1`,
    lastAttemptStartedAt: new Date(),
  });
}

function markPosted(
  tx: OutboxTransaction,
  workspaceId: string,
  commentId: string,
  input: MarkPostedInput,
): Promise<boolean> {
  return applyTransition(tx, workspaceId, commentId, 'processing', 'posted', {
    platformCommentId: input.platformCommentId,
    errorCode: null,
    errorMessage: null,
  });
}

function markFailed(
  tx: OutboxTransaction,
  workspaceId: string,
  commentId: string,
  input: MarkFailedInput,
): Promise<boolean> {
  return applyTransition(tx, workspaceId, commentId, 'processing', 'failed', {
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
  });
}

function markQueuedForRetry(
  tx: OutboxTransaction,
  workspaceId: string,
  commentId: string,
): Promise<boolean> {
  return applyTransition(tx, workspaceId, commentId, 'processing', 'queued', {});
}

/** Backs {@link CommentRepository}; construct once per database handle (T043). */
export function createCommentRepository(db: NodePgDatabase): CommentRepository {
  return {
    listTopLevelByPost: (workspaceId, postId, pagination) =>
      listTopLevelByPost(db, workspaceId, postId, pagination),
    listRepliesByParent: (workspaceId, parentCommentId, pagination) =>
      listRepliesByParent(db, workspaceId, parentCommentId, pagination),
    listByAccount: (workspaceId, socialAccountId, filters, pagination) =>
      listByAccount(db, workspaceId, socialAccountId, filters, pagination),
    getById: (workspaceId, commentId) => getById(db, workspaceId, commentId),
    getSyncStatus: (workspaceId, postId) => getSyncStatus(db, workspaceId, postId),
    findByIdempotencyKey: (workspaceId, idempotencyKey) =>
      findByIdempotencyKey(db, workspaceId, idempotencyKey),
    insertQueued: (tx, workspaceId, input) => insertQueued(tx, workspaceId, input),
    markProcessing: (tx, workspaceId, commentId) => markProcessing(tx, workspaceId, commentId),
    markPosted: (tx, workspaceId, commentId, input) =>
      markPosted(tx, workspaceId, commentId, input),
    markFailed: (tx, workspaceId, commentId, input) =>
      markFailed(tx, workspaceId, commentId, input),
    markQueuedForRetry: (tx, workspaceId, commentId) =>
      markQueuedForRetry(tx, workspaceId, commentId),
  };
}
