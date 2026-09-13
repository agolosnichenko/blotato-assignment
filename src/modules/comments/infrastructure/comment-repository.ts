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
 * The placeholder rule (FR-005, A4) is applied once, here, for all three list methods: a `deleted`
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

import { and, eq, gt, gte, inArray, isNull, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { canTransition, type CommentStatus } from '#src/modules/comments/domain/status.ts';
import type { OutboxTransaction } from '#src/modules/comments/infrastructure/outbox.ts';
import {
  comments,
  commentSyncJobs,
  commentSyncTargets,
} from '#src/modules/comments/infrastructure/schema.ts';
import type { KeysetCursor, SortOrder } from '#src/shared/pagination.ts';
import type { WorkspaceId } from '#src/shared/ids.ts';

/** One comment row, as read back from `comments` — no API-shape mapping here (that's http/schemas.ts). */
export interface CommentRecord {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
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
  readonly status: CommentStatus;
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

/**
 * Filters for the flat `GET /v1/comments` listing (D31), on top of the `workspaceId` scope every
 * `list` call carries regardless. Every key is optional and, when the filter is absent, omitted
 * rather than set to `undefined` — `exactOptionalPropertyTypes` treats `{ x: undefined }` and `{}`
 * as different types, and {@link selectionPredicate} relies on that to decide which conditions to
 * `AND` in.
 */
export interface CommentSelection {
  readonly postId?: string;
  readonly parentCommentId?: string;
  readonly accountId?: string;
  readonly platforms?: readonly string[];
  readonly topLevelOnly?: boolean;
  readonly isOwn?: boolean;
  readonly since?: Date;
  readonly until?: Date;
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

export interface MarkQueuedForRetryInput {
  /**
   * Whether the next attempt must reconcile before it sends.
   *
   * `true` when this attempt ended without learning whether the platform accepted the write,
   * `false` when the failure proves nothing was sent.
   */
  readonly needsReconcile: boolean;
}

export interface CommentRepository {
  listTopLevelByPost(
    workspaceId: WorkspaceId,
    postId: string,
    pagination: ListPagination,
  ): Promise<ListResult>;
  listRepliesByParent(
    workspaceId: WorkspaceId,
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
    workspaceId: WorkspaceId,
    socialAccountId: string,
    filters: ListByAccountFilters,
    pagination: ListPagination,
  ): Promise<ListResult>;
  /**
   * The flat `GET /v1/comments` listing (D31), driving `comments_workspace_idx` (`workspace_id,
   * occurred_at DESC, id DESC`) via {@link selectionPredicate}. Replaces `listTopLevelByPost`,
   * `listRepliesByParent` and `listByAccount` for callers migrated to the flat route; those three
   * stay in place until every caller has moved.
   */
  list(
    workspaceId: WorkspaceId,
    selection: CommentSelection,
    pagination: ListPagination,
  ): Promise<ListResult>;
  getById(workspaceId: WorkspaceId, commentId: string): Promise<CommentRecord | null>;
  getSyncStatus(workspaceId: WorkspaceId, postId: string): Promise<SyncStatus>;
  findByIdempotencyKey(
    workspaceId: WorkspaceId,
    idempotencyKey: string,
  ): Promise<CommentRecord | null>;
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
    workspaceId: WorkspaceId,
    input: InsertQueuedInput,
  ): Promise<CommentRecord>;
  /**
   * `queued -> processing`. Bumps `attemptCount` and stamps `lastAttemptStartedAt` — the anchor
   * the stuck-work sweeper's `COALESCE(last_attempt_started_at, created_at)` selector reads.
   * Returns `false`, not an error, when the row was not `queued` (another worker already claimed
   * it) — the caller must stop, not proceed to publish.
   */
  markProcessing(
    tx: OutboxTransaction,
    workspaceId: WorkspaceId,
    commentId: string,
  ): Promise<boolean>;
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
    workspaceId: WorkspaceId,
    commentId: string,
    input: MarkPostedInput,
  ): Promise<boolean>;
  /**
   * `processing -> failed`, terminal (D14: `PermanentError`, `AuthError`, or attempts exhausted).
   * Returns `false`, not an error, when the row was not `processing`.
   */
  markFailed(
    tx: OutboxTransaction,
    workspaceId: WorkspaceId,
    commentId: string,
    input: MarkFailedInput,
  ): Promise<boolean>;
  /**
   * `processing -> queued`, for a bounded retry (`RetryableError` / `OutcomeUnknownError` with no
   * reconciled outcome). Leaves `lastAttemptStartedAt` untouched — it stays the sweeper's anchor
   * for "how long has this retry been pending" until the next `markProcessing` call updates it.
   * Carries `needsReconcile` forward so an unresolved outcome is not forgotten between attempts.
   * Returns `false`, not an error, when the row was not `processing`.
   */
  markQueuedForRetry(
    tx: OutboxTransaction,
    workspaceId: WorkspaceId,
    commentId: string,
    input: MarkQueuedForRetryInput,
  ): Promise<boolean>;
  /**
   * Arms the D14 reconciliation guard on a `processing` row, committed before the send goes out.
   *
   * Returns `false` when the row is no longer `processing` — another worker settled it, and this
   * attempt must not send.
   */
  markSendAttempted(
    tx: OutboxTransaction,
    workspaceId: WorkspaceId,
    commentId: string,
  ): Promise<boolean>;
  /**
   * Clears the guard after a reconciliation search completed and found nothing — the one piece of
   * evidence that makes a fresh send safe again.
   */
  clearReconcileGuard(
    tx: OutboxTransaction,
    workspaceId: WorkspaceId,
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

/**
 * The `ORDER BY` for one page, matching the `NULLS LAST` every `occurred_at`/`id` index carries
 * (schema.ts's `.desc()`/`.asc()` on an `IndexedColumn` default to it). drizzle-orm's own
 * `desc()`/`asc()` query-builder helpers emit a bare `DESC`/`ASC` with no `NULLS` clause, which
 * Postgres defaults to `NULLS FIRST` for `DESC` — a pathkey none of the `DESC` indexes
 * (`comments_post_top_level_idx`, `comments_social_account_idx`, `comments_workspace_idx`) supply,
 * so the planner falls back to an explicit `Sort`, or a full `Seq Scan` once the predicate stops
 * being selective, instead of an index scan a `LIMIT` can terminate early. `occurred_at`/`id` are
 * both `NOT NULL`, so no row's position changes — only whether the index can supply the
 * ordering — but the coupling is stated explicitly here rather than left to two defaults that
 * happen to agree for `ASC` (which is why `comments_replies_idx` alone was never affected) and
 * disagree for `DESC`.
 */
function orderByFor(order: SortOrder): SQL[] {
  return order === 'desc'
    ? [sql`${comments.occurredAt} DESC NULLS LAST`, sql`${comments.id} DESC NULLS LAST`]
    : [sql`${comments.occurredAt} ASC NULLS LAST`, sql`${comments.id} ASC NULLS LAST`];
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
  workspaceId: WorkspaceId,
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
  workspaceId: WorkspaceId,
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

/**
 * The `AND`-of-present-conditions predicate for the flat `GET /v1/comments` listing (D31). Starts
 * from the workspace scope every repository call carries (D20) and adds one condition per present
 * `selection` key — this phase wires the workspace scope only; a later task extends the `if`
 * ladder below with the remaining eight `CommentSelection` keys, each its own addition here rather
 * than a rewrite of this function.
 *
 * No branch here picks an index or a query shape — Postgres's planner does that from the resulting
 * predicate against `comments_workspace_idx` and the other four comment indexes.
 */
function selectionPredicate(workspaceId: WorkspaceId, selection: CommentSelection): SQL {
  const conditions: SQL[] = [eq(comments.workspaceId, workspaceId)];
  // Unused until the follow-up task adds the remaining eight conditions.
  void selection;

  return and(...conditions) as SQL;
}

function list(
  db: NodePgDatabase,
  workspaceId: WorkspaceId,
  selection: CommentSelection,
  pagination: ListPagination,
): Promise<ListResult> {
  return listByPredicate(db, selectionPredicate(workspaceId, selection), pagination);
}

function listByAccount(
  db: NodePgDatabase,
  workspaceId: WorkspaceId,
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
  workspaceId: WorkspaceId,
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
  workspaceId: WorkspaceId,
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
  workspaceId: WorkspaceId,
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
  workspaceId: WorkspaceId,
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
  workspaceId: WorkspaceId,
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
  workspaceId: WorkspaceId,
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
  workspaceId: WorkspaceId,
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
  workspaceId: WorkspaceId,
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
  workspaceId: WorkspaceId,
  commentId: string,
): Promise<boolean> {
  return applyTransition(tx, workspaceId, commentId, 'queued', 'processing', {
    attemptCount: sql`${comments.attemptCount} + 1`,
    lastAttemptStartedAt: new Date(),
  });
}

function markPosted(
  tx: OutboxTransaction,
  workspaceId: WorkspaceId,
  commentId: string,
  input: MarkPostedInput,
): Promise<boolean> {
  return applyTransition(tx, workspaceId, commentId, 'processing', 'posted', {
    platformCommentId: input.platformCommentId,
    errorCode: null,
    errorMessage: null,
    needsReconcile: false,
  });
}

function markFailed(
  tx: OutboxTransaction,
  workspaceId: WorkspaceId,
  commentId: string,
  input: MarkFailedInput,
): Promise<boolean> {
  return applyTransition(tx, workspaceId, commentId, 'processing', 'failed', {
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
    needsReconcile: false,
  });
}

/**
 * Writes the reconciliation guard on a row that is still `processing`.
 *
 * Not a status transition — the status does not move — so it does not go through
 * {@link applyTransition}; the `status = 'processing'` predicate is there so a row another worker
 * has already settled is left alone rather than being re-armed behind that worker's back.
 */
async function setReconcileGuard(
  tx: OutboxTransaction,
  workspaceId: WorkspaceId,
  commentId: string,
  needsReconcile: boolean,
): Promise<boolean> {
  const result = await tx
    .update(comments)
    .set({ needsReconcile, updatedAt: new Date() })
    .where(
      and(
        eq(comments.id, commentId),
        eq(comments.workspaceId, workspaceId),
        eq(comments.status, 'processing'),
      ),
    );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Arms the reconciliation guard for the send that is about to go out (D14).
 *
 * Committed *before* `adapter.publishComment` is called, so that a worker killed mid-send leaves
 * behind a row that says "a send may have happened here". Without it the sweeper's
 * `processing -> queued` recovery would hand the next attempt a row indistinguishable from one
 * that never reached the platform, and that attempt would publish a second copy.
 */
function markSendAttempted(
  tx: OutboxTransaction,
  workspaceId: WorkspaceId,
  commentId: string,
): Promise<boolean> {
  return setReconcileGuard(tx, workspaceId, commentId, true);
}

/**
 * `processing -> queued` for another attempt.
 *
 * `needsReconcile` carries forward what this attempt learned: `false` when the failure proves
 * nothing was sent (a rate-limit rejection), `true` when the outcome stayed unknown. Clearing it
 * unconditionally — as an empty `set` did — is what let an unresolved `OutcomeUnknownError` be
 * forgotten between attempts.
 */
function markQueuedForRetry(
  tx: OutboxTransaction,
  workspaceId: WorkspaceId,
  commentId: string,
  input: MarkQueuedForRetryInput,
): Promise<boolean> {
  return applyTransition(tx, workspaceId, commentId, 'processing', 'queued', {
    needsReconcile: input.needsReconcile,
  });
}

/** Clears the guard once reconciliation has proved the comment is not on the platform. */
function clearReconcileGuard(
  tx: OutboxTransaction,
  workspaceId: WorkspaceId,
  commentId: string,
): Promise<boolean> {
  return setReconcileGuard(tx, workspaceId, commentId, false);
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
    list: (workspaceId, selection, pagination) => list(db, workspaceId, selection, pagination),
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
    markQueuedForRetry: (tx, workspaceId, commentId, input) =>
      markQueuedForRetry(tx, workspaceId, commentId, input),
    markSendAttempted: (tx, workspaceId, commentId) =>
      markSendAttempted(tx, workspaceId, commentId),
    clearReconcileGuard: (tx, workspaceId, commentId) =>
      clearReconcileGuard(tx, workspaceId, commentId),
  };
}
