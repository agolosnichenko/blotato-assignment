/**
 * The shared ingestion upsert path (T076, T077; spec.md §7.2 steps 3-4, §7.3, FR-017, FR-022,
 * FR-030, SC-003) — the one place a Meta webhook delivery and a sync walk converge on a single
 * row per `(social_account_id, platform_comment_id)`, so a comment seen twice by two different
 * channels produces one row and exactly one `comment.received` (see the integration test's
 * docstring for why that count, not just the row count, is the invariant).
 *
 * `upsert` does three things, in order, per call:
 *   1. For a post this service did not publish (`target.postId === null`), ensures a
 *      `comment_sync_target` exists (FR-018) — the only other entry point besides the
 *      `PostPublished` port, per `sync-target-repository.ts`'s module docstring.
 *   2. Resolves where the comment attaches: a top-level comment attaches at depth 0 with no
 *      root; a reply whose parent is already a local row reads its placement directly; a reply
 *      whose parent is unknown locally walks up with `adapter.fetchComment` (T077) until a known
 *      ancestor or a top-level comment is found, inserting every hop discovered along the way so
 *      no orphan is ever written.
 *   3. Completes a thin payload's `text` via `adapter.fetchComment` (A18) before the `INSERT ...
 *      ON CONFLICT DO UPDATE` ever runs, and the `DO UPDATE SET text = coalesce(...)` clause
 *      keeps that promise even if completion itself comes up empty — an absent field is never
 *      written over stored text. That same `DO UPDATE` never restores `text`/author fields on a
 *      row already `deleted` (FR-030, §18) — a redelivery or a sync walk racing a platform-side
 *      removal must leave a privacy deletion's nulling permanent, not partially undo it.
 *
 * `is_own` (T095, FR-023, A2) is set from author identity, not from how a row entered the
 * system: `upsert` compares `authorPlatformId` against the connected account's own platform id
 * (`isOwnFor`) for every row it writes — the original comment and every ancestor the walk
 * backfills alike — rather than trusting a caller-supplied flag. The same comment read back
 * through a webhook delivery or a sync walk, or even seeded directly, still resolves to the same
 * `is_own`, because nothing about the channel enters the comparison.
 *
 * `delete` is FR-030's privacy control, not a status rename: `text` and the author fields are
 * nulled, the parent's `reply_count` decrements, and `comment.deleted` is written — the same
 * branch a sync walk's own deletions (T086) are meant to call, so that a deletion detected by a
 * webhook and one detected by a walk leave identical rows.
 *
 * Both entry points write their outbox events in the same transaction as the state change they
 * describe (D9) via `appendToOutbox` — never to BullMQ directly.
 */

// oxlint-disable max-lines -- one module implementing the upsert path (dedup, text completion)
// and the bounded ancestor walk it shares with it, plus the delete branch T086 reuses; splitting
// the walk/placement helpers from the row upsert they both call would duplicate `RowInput` and the
// new-comment side effects instead of removing any of them.

import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  appendToOutbox,
  type OutboxTransaction,
} from '#src/modules/comments/infrastructure/outbox.ts';
import { comments } from '#src/modules/comments/infrastructure/schema.ts';
import type { SyncTargetRepository } from '#src/modules/comments/infrastructure/sync-target-repository.ts';
import type {
  AccountContext,
  CommentPlatformAdapter,
  NormalizedComment,
  Platform,
} from '#src/platforms/types.ts';

/**
 * Bounds the ancestor walk (T077) against a cycle or a pathologically deep thread — neither the
 * platform nor a malfunctioning adapter double is trusted to terminate the walk on its own. No
 * real thread approaches this depth; hitting it means the walk failed, not that the parent
 * genuinely doesn't exist, and the caller must not receive a half-built chain either way.
 */
const MAX_ANCESTOR_WALK = 50;

/** A comment as carried by a webhook delivery or a sync listing, before it is stored. */
export interface IngestedComment {
  readonly platformCommentId: string;
  readonly platformParentId: string | null;
  readonly authorPlatformId: string;
  readonly authorUsername: string | null;
  readonly authorDisplayName: string | null;
  /** Absent, not `null`, on a thin webhook payload (A18) — `upsert` completes it via `fetchComment`. */
  readonly text: string | undefined;
  readonly platformCreatedAt: Date;
  readonly platformMeta: Record<string, unknown>;
  /**
   * Ignored by `upsert` (T095, FR-023, A2): `is_own` must mean "this author is the connected
   * account", not "whatever the ingestion channel asserted", so `upsert` derives it itself from
   * `authorPlatformId` via {@link isOwnFor} — the same derivation already used for every
   * ancestor row the walk backfills — rather than trusting this field either way.
   */
  readonly isOwn: boolean;
}

/** The post a comment hangs off, as known to this service. */
export interface IngestTarget {
  readonly workspaceId: string;
  readonly socialAccountId: string;
  readonly platform: Platform;
  /** `null` for a post never published through this service (FR-018). */
  readonly postId: string | null;
  readonly platformPostId: string;
}

export type IngestionSource = 'webhook' | 'sync' | 'backfill';

export interface UpsertInput {
  readonly target: IngestTarget;
  readonly comment: IngestedComment;
  readonly ingestionSource: IngestionSource;
  readonly ctx: AccountContext;
  readonly adapter: CommentPlatformAdapter;
}

export interface UpsertResult {
  readonly commentId: string;
  readonly wasNew: boolean;
}

export interface DeleteInput {
  readonly workspaceId: string;
  readonly socialAccountId: string;
  readonly platform: Platform;
  readonly platformCommentId: string;
}

export interface DeleteResult {
  readonly wasDeleted: boolean;
}

export interface IngestComments {
  upsert(input: UpsertInput): Promise<UpsertResult>;
  delete(input: DeleteInput): Promise<DeleteResult>;
}

export interface IngestCommentsDeps {
  readonly database: NodePgDatabase;
  readonly syncTargetRepository: SyncTargetRepository;
}

/** Where a comment attaches: `parentCommentId: null` and `rootCommentId: null` means top-level. */
interface Placement {
  readonly parentCommentId: string | null;
  readonly depth: number;
  readonly rootCommentId: string | null;
}

interface LocalRow {
  readonly id: string;
  readonly depth: number;
  readonly rootCommentId: string | null;
}

/** The fields one row's upsert needs, independent of whether it's the target or a resolved ancestor. */
interface RowInput {
  readonly platformCommentId: string;
  readonly placement: Placement;
  readonly authorPlatformId: string | null;
  readonly authorUsername: string | null;
  readonly authorDisplayName: string | null;
  /** `undefined` means "unknown" — preserved on update, written as `null` only on insert. */
  readonly resolvedText: string | undefined;
  readonly platformCreatedAt: Date;
  readonly platformMeta: Record<string, unknown>;
  readonly isOwn: boolean;
}

function isOwnFor(ctx: AccountContext, authorPlatformId: string): boolean {
  return authorPlatformId === ctx.platformAccountId;
}

async function findLocalRow(
  tx: OutboxTransaction,
  socialAccountId: string,
  platformCommentId: string,
): Promise<LocalRow | null> {
  const [row] = await tx
    .select({ id: comments.id, depth: comments.depth, rootCommentId: comments.rootCommentId })
    .from(comments)
    .where(
      and(
        eq(comments.socialAccountId, socialAccountId),
        eq(comments.platformCommentId, platformCommentId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** A known row's placement for whatever attaches to it next — mirrors `comment-repository.ts`. */
function placementBelow(row: LocalRow): Placement {
  return {
    parentCommentId: row.id,
    depth: row.depth + 1,
    rootCommentId: row.rootCommentId ?? row.id,
  };
}

interface AncestorWalkResult {
  readonly base: Placement;
  /** Innermost (closest to the original reply) first — reversed before being persisted. */
  readonly chain: readonly NormalizedComment[];
}

/**
 * Walks up from `startPlatformParentId` until a locally-known ancestor or a top-level comment is
 * found, fetching every unknown hop along the way (T077). Throws rather than returning a partial
 * result when a hop is missing on the platform too, or when the walk exceeds
 * {@link MAX_ANCESTOR_WALK} — either way, nothing is stored for an unresolved chain.
 */
async function walkAncestorChain(
  tx: OutboxTransaction,
  ctx: AccountContext,
  adapter: CommentPlatformAdapter,
  socialAccountId: string,
  startPlatformParentId: string,
): Promise<AncestorWalkResult> {
  const chain: NormalizedComment[] = [];
  let currentId: string | null = startPlatformParentId;

  for (let hop = 0; hop < MAX_ANCESTOR_WALK; hop += 1) {
    if (currentId === null) {
      return { base: { parentCommentId: null, depth: 0, rootCommentId: null }, chain };
    }

    // Each hop depends on the previous one's result — the next id to look up is only known
    // once this one comes back — so there is nothing here `Promise.all` could parallelize.
    // oxlint-disable-next-line no-await-in-loop
    const known = await findLocalRow(tx, socialAccountId, currentId);
    if (known !== null) {
      return { base: placementBelow(known), chain };
    }

    // oxlint-disable-next-line no-await-in-loop
    const fetched = await adapter.fetchComment(ctx, currentId);
    if (fetched === null) {
      throw new Error(
        `ingest-comments: ancestor ${currentId} was not found locally or on the platform`,
      );
    }
    chain.push(fetched);
    currentId = fetched.platformParentId;
  }

  throw new Error(
    `ingest-comments: ancestor walk from ${startPlatformParentId} exceeded ` +
      `${MAX_ANCESTOR_WALK} hops — likely a cycle`,
  );
}

/**
 * Inserts every hop {@link walkAncestorChain} discovered, outermost first, so each one's parent
 * already exists by the time it is written — never an orphan. Returns the placement the original
 * reply attaches at.
 */
async function persistAncestorChain(
  tx: OutboxTransaction,
  ctx: AccountContext,
  target: IngestTarget,
  ingestionSource: IngestionSource,
  walk: AncestorWalkResult,
): Promise<Placement> {
  let placement = walk.base;
  for (const ancestor of walk.chain.toReversed()) {
    // Each ancestor's placement depends on the previous one's freshly-assigned id, so the
    // inserts must run in order, outermost first — not something `Promise.all` could parallelize.
    // oxlint-disable-next-line no-await-in-loop
    const { id } = await upsertRow(tx, target, ingestionSource, {
      platformCommentId: ancestor.platformCommentId,
      placement,
      authorPlatformId: ancestor.authorPlatformId,
      authorUsername: ancestor.authorUsername,
      authorDisplayName: ancestor.authorDisplayName,
      resolvedText: ancestor.text,
      platformCreatedAt: ancestor.platformCreatedAt,
      platformMeta: ancestor.platformMeta,
      isOwn: isOwnFor(ctx, ancestor.authorPlatformId),
    });
    placement = placementBelow({
      id,
      depth: placement.depth,
      rootCommentId: placement.rootCommentId,
    });
  }
  return placement;
}

async function resolveParentPlacement(
  tx: OutboxTransaction,
  ctx: AccountContext,
  adapter: CommentPlatformAdapter,
  target: IngestTarget,
  ingestionSource: IngestionSource,
  platformParentId: string | null,
): Promise<Placement> {
  if (platformParentId === null) {
    return { parentCommentId: null, depth: 0, rootCommentId: null };
  }
  const walk = await walkAncestorChain(tx, ctx, adapter, target.socialAccountId, platformParentId);
  return persistAncestorChain(tx, ctx, target, ingestionSource, walk);
}

/** `undefined` when text is unknown even after completion — {@link upsertRow} then preserves it. */
async function resolveText(
  ctx: AccountContext,
  adapter: CommentPlatformAdapter,
  comment: IngestedComment,
): Promise<string | undefined> {
  if (comment.text !== undefined) {
    return comment.text;
  }
  const fetched = await adapter.fetchComment(ctx, comment.platformCommentId);
  return fetched?.text;
}

const ROW_RETURNING = {
  id: comments.id,
  wasNew: sql<boolean>`(xmax = 0)`,
} as const;

/**
 * `INSERT ... ON CONFLICT (social_account_id, platform_comment_id) DO UPDATE` — the one upsert
 * target push and refresh share (FR-017). `xmax = 0` on the returned row is the standard Postgres
 * tell for "this statement inserted, not updated" (the row has never been touched by another
 * command), which is how {@link upsertRow} decides whether to run the new-comment side effects
 * without a separate existence check racing the insert itself.
 */
/** The `INSERT` values for one row — a brand-new comment, should the conflict target miss. */
function insertValuesFor(target: IngestTarget, ingestionSource: IngestionSource, input: RowInput) {
  return {
    workspaceId: target.workspaceId,
    socialAccountId: target.socialAccountId,
    platform: target.platform,
    postId: target.postId,
    platformPostId: target.platformPostId,
    parentCommentId: input.placement.parentCommentId,
    rootCommentId: input.placement.rootCommentId,
    depth: input.placement.depth,
    platformCommentId: input.platformCommentId,
    platformMeta: input.platformMeta,
    isOwn: input.isOwn,
    source: ingestionSource === 'backfill' ? 'sync' : ingestionSource,
    authorPlatformId: input.authorPlatformId,
    authorUsername: input.authorUsername,
    authorDisplayName: input.authorDisplayName,
    text: input.resolvedText ?? null,
    status: 'posted',
    replyCount: 0,
    lastActivityAt: input.platformCreatedAt,
    occurredAt: input.platformCreatedAt,
  };
}

async function insertOrUpdateRow(
  tx: OutboxTransaction,
  target: IngestTarget,
  ingestionSource: IngestionSource,
  input: RowInput,
): Promise<{ id: string; wasNew: boolean }> {
  const insertedText = input.resolvedText ?? null;
  // FR-030: a `deleted` row's text and author fields were nulled for privacy, and that nulling
  // must be permanent. Meta redelivers a webhook for up to 36h, and a sync walk can still read a
  // comment's old content from the platform inside that same window (the delete event and the
  // platform's own removal do not land atomically) — either path re-running this upsert on an
  // already-`deleted` row must leave it exactly as the delete left it, not restore what it erased.
  const liveRow = sql`${comments.status} != 'deleted'`;

  const [row] = await tx
    .insert(comments)
    .values(insertValuesFor(target, ingestionSource, input))
    .onConflictDoUpdate({
      target: [comments.socialAccountId, comments.platformCommentId],
      targetWhere: sql`${comments.platformCommentId} is not null`,
      set: {
        text: sql`CASE WHEN ${liveRow} THEN coalesce(${insertedText}, ${comments.text}) ELSE ${comments.text} END`,
        authorUsername: sql`CASE WHEN ${liveRow} THEN ${input.authorUsername} ELSE ${comments.authorUsername} END`,
        authorDisplayName: sql`CASE WHEN ${liveRow} THEN ${input.authorDisplayName} ELSE ${comments.authorDisplayName} END`,
        // Not guarded by `liveRow` like the three fields above — FR-030 is about PII-bearing
        // fields, and `platformMeta` carries none: for Bluesky it is only the record `cid`, a
        // non-identifying pointer, so there is nothing here for a redelivery to revive.
        platformMeta: input.platformMeta,
        updatedAt: new Date(),
      },
    })
    .returning(ROW_RETURNING);

  if (row === undefined) {
    throw new Error('ingest-comments: upsert returned no row');
  }
  return row;
}

/**
 * The bookkeeping that must commit with a genuinely new comment (data-model.md §2): the parent's
 * `reply_count` increments and the root's `last_activity_at` moves to whichever is newer — the
 * thread's existing activity or this comment's own `platformCreatedAt` — since a sync walk can
 * surface history older than what the thread already shows. A top-level comment has no parent to
 * bump and set its own `last_activity_at` at insert already, so both updates are skipped.
 */
async function bumpParentReplyCount(
  tx: OutboxTransaction,
  target: IngestTarget,
  placement: Placement,
  now: Date,
): Promise<void> {
  if (placement.parentCommentId === null) {
    return;
  }
  await tx
    .update(comments)
    .set({ replyCount: sql`${comments.replyCount} + 1`, updatedAt: now })
    .where(
      and(eq(comments.id, placement.parentCommentId), eq(comments.workspaceId, target.workspaceId)),
    );
}

async function bumpRootLastActivity(
  tx: OutboxTransaction,
  target: IngestTarget,
  placement: Placement,
  platformCreatedAt: Date,
  now: Date,
): Promise<void> {
  if (placement.rootCommentId === null) {
    return;
  }
  await tx
    .update(comments)
    .set({
      lastActivityAt: sql`greatest(${comments.lastActivityAt}, ${platformCreatedAt})`,
      updatedAt: now,
    })
    .where(
      and(eq(comments.id, placement.rootCommentId), eq(comments.workspaceId, target.workspaceId)),
    );
}

async function applyNewCommentSideEffects(
  tx: OutboxTransaction,
  target: IngestTarget,
  ingestionSource: IngestionSource,
  commentId: string,
  input: RowInput,
): Promise<void> {
  const now = new Date();
  await bumpParentReplyCount(tx, target, input.placement, now);
  await bumpRootLastActivity(tx, target, input.placement, input.platformCreatedAt, now);
  await appendToOutbox(tx, {
    workspaceId: target.workspaceId,
    type: 'comment.received',
    aggregateId: commentId,
    data: {
      commentId,
      socialAccountId: target.socialAccountId,
      platform: target.platform,
      postId: target.postId,
      platformPostId: target.platformPostId,
      parentCommentId: input.placement.parentCommentId,
      isOwn: input.isOwn,
      authorPlatformId: input.authorPlatformId,
      text: input.resolvedText ?? null,
      ingestionSource,
    },
  });
}

async function upsertRow(
  tx: OutboxTransaction,
  target: IngestTarget,
  ingestionSource: IngestionSource,
  input: RowInput,
): Promise<{ id: string; wasNew: boolean }> {
  const row = await insertOrUpdateRow(tx, target, ingestionSource, input);
  if (row.wasNew) {
    await applyNewCommentSideEffects(tx, target, ingestionSource, row.id, input);
  }
  return row;
}

async function runUpsert(tx: OutboxTransaction, input: UpsertInput): Promise<UpsertResult> {
  const { target, comment, ingestionSource, ctx, adapter } = input;
  const placement = await resolveParentPlacement(
    tx,
    ctx,
    adapter,
    target,
    ingestionSource,
    comment.platformParentId,
  );
  const resolvedText = await resolveText(ctx, adapter, comment);

  const { id, wasNew } = await upsertRow(tx, target, ingestionSource, {
    platformCommentId: comment.platformCommentId,
    placement,
    authorPlatformId: comment.authorPlatformId,
    authorUsername: comment.authorUsername,
    authorDisplayName: comment.authorDisplayName,
    resolvedText,
    platformCreatedAt: comment.platformCreatedAt,
    platformMeta: comment.platformMeta,
    isOwn: isOwnFor(ctx, comment.authorPlatformId),
  });

  return { commentId: id, wasNew };
}

/** FR-018: the first comment ever seen on a post this service did not publish tracks it. */
async function ensureSyncTargetIfExternal(
  deps: IngestCommentsDeps,
  input: UpsertInput,
): Promise<void> {
  if (input.target.postId !== null) {
    return;
  }
  await deps.syncTargetRepository.ensureTarget({
    workspaceId: input.target.workspaceId,
    socialAccountId: input.target.socialAccountId,
    platform: input.target.platform,
    postId: null,
    platformPostId: input.target.platformPostId,
    ageAnchorAt: input.comment.platformCreatedAt,
  });
}

async function upsert(deps: IngestCommentsDeps, input: UpsertInput): Promise<UpsertResult> {
  await ensureSyncTargetIfExternal(deps, input);
  return deps.database.transaction((tx) => runUpsert(tx, input));
}

interface DeleteTargetRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly parentCommentId: string | null;
}

async function findRowToDelete(
  tx: OutboxTransaction,
  input: DeleteInput,
): Promise<DeleteTargetRow | null> {
  const [row] = await tx
    .select({
      id: comments.id,
      workspaceId: comments.workspaceId,
      parentCommentId: comments.parentCommentId,
    })
    .from(comments)
    .where(
      and(
        eq(comments.workspaceId, input.workspaceId),
        eq(comments.socialAccountId, input.socialAccountId),
        eq(comments.platformCommentId, input.platformCommentId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * FR-030: nulls `text` and the author fields and decrements the parent's `reply_count` — the
 * branch a sync walk's own deletions are meant to call too, so a push- and a walk-detected
 * deletion leave identical rows.
 */
async function runDelete(tx: OutboxTransaction, input: DeleteInput): Promise<DeleteResult> {
  const row = await findRowToDelete(tx, input);
  if (row === null) {
    return { wasDeleted: false };
  }

  const now = new Date();
  const result = await tx
    .update(comments)
    .set({
      status: 'deleted',
      text: null,
      authorPlatformId: null,
      authorUsername: null,
      authorDisplayName: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(comments.id, row.id),
        eq(comments.workspaceId, row.workspaceId),
        eq(comments.status, 'posted'),
      ),
    );
  if ((result.rowCount ?? 0) === 0) {
    return { wasDeleted: false };
  }

  if (row.parentCommentId !== null) {
    await tx
      .update(comments)
      .set({ replyCount: sql`${comments.replyCount} - 1`, updatedAt: now })
      .where(and(eq(comments.id, row.parentCommentId), eq(comments.workspaceId, row.workspaceId)));
  }

  await appendToOutbox(tx, {
    workspaceId: row.workspaceId,
    type: 'comment.deleted',
    aggregateId: row.id,
    data: {
      commentId: row.id,
      socialAccountId: input.socialAccountId,
      platform: input.platform,
    },
  });
  return { wasDeleted: true };
}

/** Backs {@link IngestComments}; construct once per database handle and its ports (T076, T077). */
export function createIngestComments(deps: IngestCommentsDeps): IngestComments {
  return {
    upsert: (input) => upsert(deps, input),
    delete: (input) => deps.database.transaction((tx) => runDelete(tx, input)),
  };
}
