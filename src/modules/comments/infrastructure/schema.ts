/**
 * Drizzle schema for everything this service's `comments` module owns (data-model.md §2, §3).
 *
 * `workspace_id`, `social_account_id` and `post_id` are external references to rows owned by the
 * workspaces, accounts and publishing services (D8, D29, Principle II). They are plain `uuid`
 * columns with no foreign key and no join back to those services' tables — the absence is
 * deliberate, not an omission a later migration should "fix". Every other relation below points at
 * a table this same file defines, so a real foreign key is used there.
 */

// oxlint-disable max-lines -- the module's six tables, with each table's columns, constraints and
// indexes in one place. Splitting it would separate a column from the CHECK that constrains it and
// from the index that serves it, which is where this file's correctness actually lives.
// oxlint-disable max-lines-per-function -- `pgTable`'s extra-config callback is a declaration list,
// not logic: `comments` declares eleven constraints and indexes, each one line to three. Breaking it
// into helpers would hide which table a constraint belongs to for no reduction in what to read.

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { COMMENT_STATUSES } from '#src/modules/comments/domain/status.ts';
import { generateId, type WorkspaceId } from '#src/shared/ids.ts';

// ---------------------------------------------------------------------------------------------
// comments — the central entity (data-model.md §2)
// ---------------------------------------------------------------------------------------------

export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey().$defaultFn(generateId),

    // External references — no FK (D8, D29). Denormalized so every query is scoped in one
    // predicate (D20).
    workspaceId: uuid('workspace_id').notNull().$type<WorkspaceId>(),
    socialAccountId: uuid('social_account_id').notNull(),
    postId: uuid('post_id'),

    platform: text('platform').notNull(),
    platformPostId: text('platform_post_id').notNull(),

    // Self-references within this table: a real FK is appropriate here.
    parentCommentId: uuid('parent_comment_id').references((): AnyPgColumn => comments.id, {
      onDelete: 'cascade',
    }),
    rootCommentId: uuid('root_comment_id').references((): AnyPgColumn => comments.id),
    depth: smallint('depth').notNull(),

    platformCommentId: text('platform_comment_id'),
    platformMeta: jsonb('platform_meta').$type<Record<string, unknown>>().notNull().default({}),
    isOwn: boolean('is_own').notNull(),
    source: text('source').notNull(),

    authorPlatformId: text('author_platform_id'),
    authorUsername: text('author_username'),
    authorDisplayName: text('author_display_name'),
    text: text('text'),

    status: text('status', { enum: COMMENT_STATUSES }).notNull(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastAttemptStartedAt: timestamp('last_attempt_started_at', { withTimezone: true }),
    /**
     * Set before a send goes out and cleared only once the attempt settles: while it is true this
     * row may already exist on the platform, so the next attempt must reconcile before sending
     * again (D14).
     *
     * It lives in the row rather than in the worker's memory because the hazard it guards is the
     * worker *dying* — between the platform accepting the write and this service committing
     * `posted`, nothing in Redis or in a stack frame survives, and the sweeper would otherwise
     * requeue the row for a blind second send.
     */
    needsReconcile: boolean('needs_reconcile').notNull().default(false),
    idempotencyKey: text('idempotency_key'),

    replyCount: integer('reply_count').notNull().default(0),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull(),
    // `precision: 3` because this is the keyset column and `encodeCursor` writes `toISOString()`,
    // which is millisecond-precision. A stored microsecond the cursor cannot express makes paging
    // lossy: resuming `desc` after a row at `.123456` with a cursor reading `.123` skips every row
    // in that millisecond, and `asc` returns the cursor row a second time. Every writer passes a JS
    // `Date` today, so the column is what keeps that true for the next one.
    occurredAt: timestamp('occurred_at', { withTimezone: true, precision: 3 }).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    // Dedup: one comment per platform identifier, whichever channel brought it (webhook or
    // sync share this one upsert target) — FR-017, SC-003.
    uniqueIndex('comments_social_account_platform_comment_id_key')
      .on(table.socialAccountId, table.platformCommentId)
      .where(sql`${table.platformCommentId} is not null`),
    // FR-013: the same idempotency key cannot produce two comments in a workspace.
    uniqueIndex('comments_workspace_idempotency_key_key')
      .on(table.workspaceId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    // A comment cannot claim to be published without proof it exists on the platform.
    check(
      'comments_posted_has_platform_comment_id',
      sql`${table.status} <> 'posted' or ${table.platformCommentId} is not null`,
    ),
    // The state machine, enforced by the database too. `text('status', { enum })` only types the
    // column for drizzle's own callers; anything else writing this table — a migration, a fixture,
    // a psql session — could otherwise store a status no branch in `domain/status.ts` handles.
    check(
      'comments_status_valid',
      sql`${table.status} in ('queued', 'processing', 'posted', 'failed', 'deleted')`,
    ),
    // Depth and parenthood cannot disagree.
    check(
      'comments_depth_matches_parent',
      sql`(${table.parentCommentId} is null) = (${table.depth} = 0)`,
    ),
    // Each listing index declares the NULL placement Postgres defaults to for its direction, which
    // is what lets `orderByFor`'s clause-free `ORDER BY` read it in both — see that function for
    // why naming a placement on either side costs one direction its index.
    //
    // A post's top-level page, both scan directions (FR-001, D27).
    index('comments_post_top_level_idx')
      .on(table.postId, table.occurredAt.desc().nullsFirst(), table.id.desc().nullsFirst())
      .where(sql`${table.parentCommentId} is null`),
    // A replies page, both scan directions (FR-002, D27). Partial: no replies selection can match a
    // top-level row, and without the predicate every top-level comment sits under the NULL key.
    index('comments_replies_idx')
      .on(table.parentCommentId, table.occurredAt.asc(), table.id.asc())
      .where(sql`${table.parentCommentId} is not null`),
    // The account inbox (FR-008).
    index('comments_social_account_idx').on(
      table.socialAccountId,
      table.occurredAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    // One post's rows, for a complete walk's deletion inference (FR-019).
    index('comments_sync_post_idx').on(table.socialAccountId, table.platformPostId),
    // The `root_comment_id` foreign key's own lookup: without it, every row the retention purge
    // deletes makes Postgres scan the table for rows still naming it as their root.
    index('comments_root_comment_idx')
      .on(table.rootCommentId)
      .where(sql`${table.rootCommentId} is not null`),
    // The retention purge selector (FR-029).
    index('comments_last_activity_idx')
      .on(table.lastActivityAt)
      .where(sql`${table.parentCommentId} is null`),
    // The stuck-work sweeper's selector.
    index('comments_stuck_work_idx')
      .on(table.status, table.lastAttemptStartedAt)
      .where(sql`${table.status} in ('queued', 'processing')`),
    // The flat GET /v1/comments listing, both scan directions (D31).
    index('comments_workspace_idx').on(
      table.workspaceId,
      table.occurredAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
  ],
);

// ---------------------------------------------------------------------------------------------
// comment_sync_targets — the per-post refresh schedule (data-model.md §3, §7.3, FR-018)
// ---------------------------------------------------------------------------------------------

export const commentSyncTargets = pgTable(
  'comment_sync_targets',
  {
    id: uuid('id').primaryKey().$defaultFn(generateId),

    // External references — no FK (D8, D29).
    workspaceId: uuid('workspace_id').notNull().$type<WorkspaceId>(),
    socialAccountId: uuid('social_account_id').notNull(),
    postId: uuid('post_id'),

    platformPostId: text('platform_post_id').notNull(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    // Null means deactivated.
    nextSyncAt: timestamp('next_sync_at', { withTimezone: true }),
    lastError: text('last_error'),
    manualCooldownUntil: timestamp('manual_cooldown_until', { withTimezone: true }),
    // The instant §7.3's age bands are measured from — not `published_at`, because for a post
    // first seen through an ingested comment (never published through this service) it is only
    // that comment's `occurred_at`, a lower bound on the post's age, not a publication time
    // (spec.md §18). For a post registered through the `PostPublished` port it is that post's
    // real `published_at`. No default: a row with no real anchor should fail loudly at insert
    // rather than silently claim the post was just published (the most aggressive polling band) —
    // every write path (`ensureTarget`, and any fixture seeding this table directly) must supply
    // one explicitly.
    ageAnchorAt: timestamp('age_anchor_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('comment_sync_targets_social_account_platform_post_id_key').on(
      table.socialAccountId,
      table.platformPostId,
    ),
    // The scheduler's due selection, which reads it in `next_sync_at` order (spec.md §18).
    index('comment_sync_targets_due_idx')
      .on(table.nextSyncAt)
      .where(sql`${table.nextSyncAt} is not null`),
    // A post's `sync` block on the listing, and a manual refresh.
    index('comment_sync_targets_post_idx')
      .on(table.postId)
      .where(sql`${table.postId} is not null`),
  ],
);

// ---------------------------------------------------------------------------------------------
// comment_sync_jobs — one reconciliation attempt, exposed as the Refresh job resource (D19)
// ---------------------------------------------------------------------------------------------

export const commentSyncJobs = pgTable(
  'comment_sync_jobs',
  {
    id: uuid('id').primaryKey().$defaultFn(generateId),

    // External reference — no FK (D8, D29).
    workspaceId: uuid('workspace_id').notNull().$type<WorkspaceId>(),

    targetId: uuid('target_id')
      .notNull()
      .references(() => commentSyncTargets.id),

    trigger: text('trigger').notNull(),
    status: text('status').notNull(),
    stats: jsonb('stats').$type<{
      fetched: number;
      inserted: number;
      updated: number;
      deleted: number;
    }>(),
    error: text('error'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    // At most one active job per target.
    uniqueIndex('comment_sync_jobs_active_target_key')
      .on(table.targetId)
      .where(sql`${table.status} in ('queued', 'running')`),
  ],
);

// ---------------------------------------------------------------------------------------------
// webhook_deliveries — raw pushed payloads, stored before processing so nothing is lost
// ---------------------------------------------------------------------------------------------

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().$defaultFn(generateId),
    provider: text('provider').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
  },
  (table) => [
    // The delivery sweeper's selector — a healthy system has almost nothing in it.
    index('webhook_deliveries_unprocessed_idx')
      .on(table.receivedAt)
      .where(sql`${table.processedAt} is null`),
  ],
);

// ---------------------------------------------------------------------------------------------
// outbox_events — written in the state-change transaction, relayed afterwards (D9)
// ---------------------------------------------------------------------------------------------

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey().$defaultFn(generateId),

    // External reference — no FK (D8, D29).
    workspaceId: uuid('workspace_id').notNull(),

    type: text('type').notNull(),
    // The entity this event is about; may name a comment or another aggregate this module owns —
    // no FK, since which table it points to depends on `type`.
    aggregateId: uuid('aggregate_id').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
  },
  (table) => [
    // The relay's oldest-first selection of what it still owes (D9).
    index('outbox_events_unpublished_idx')
      .on(table.createdAt)
      .where(sql`${table.publishedAt} is null`),
  ],
);

// ---------------------------------------------------------------------------------------------
// contact_quota_usage — one row per person per month per platform (D16, A8)
// ---------------------------------------------------------------------------------------------

export const contactQuotaUsage = pgTable(
  'contact_quota_usage',
  {
    // External reference — no FK (D8, D29).
    workspaceId: uuid('workspace_id').notNull().$type<WorkspaceId>(),
    // `YYYY-MM`.
    period: text('period').notNull(),
    platform: text('platform').notNull(),
    contactPlatformId: text('contact_platform_id').notNull(),

    // Provenance, not ownership — no FK. The comment can be purged (45-day retention, T101) on
    // a different clock than this row (two-period retention, ~60 days); a `RESTRICT` FK here
    // would fail retention purges and, worse, a cascading one would quietly reopen a spent
    // monthly contact allowance when the comment it names is deleted.
    commentId: uuid('comment_id').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.period, table.platform, table.contactPlatformId],
    }),
  ],
);

// ---------------------------------------------------------------------------------------------
// account_health — what this service has observed about a connected account (D30)
// ---------------------------------------------------------------------------------------------

export const accountHealth = pgTable('account_health', {
  // External reference — no FK (D8, D29). One row per failing account; removed when a successful
  // platform call proves the credential works again (spec.md §18's clarification of D30 — this
  // service cannot see a reconnect in `social_accounts`, which it never writes).
  socialAccountId: uuid('social_account_id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),

  state: text('state').notNull(),
  reason: text('reason'),
  detectedAt: timestamp('detected_at', { withTimezone: true }).notNull(),
});
