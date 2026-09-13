/**
 * `SyncPost` — one refresh walk (T086, T087; spec.md §7.3, FR-018, FR-019, FR-020, FR-030, SC-008,
 * A10).
 *
 * `run(targetId)` is the one entry point the `comment-sync` queue's worker (`sync-scheduler.ts`)
 * calls, for both a scheduled tick and a manual request (D19) alike — this file knows nothing
 * about *why* it was asked to run, only which target. It never throws: every failure, whether a
 * typed adapter error or anything else raised mid-pagination, is caught and reported as
 * `{ status: 'failed', stats, error }`, mirroring `PublishComment`'s non-throwing contract.
 *
 * Two invariants this file exists to protect:
 *   - **Only a complete walk may mark anything deleted.** `walkAndIngest` throwing at any point
 *     — a typed adapter error or not — skips {@link inferDeletions} entirely; an interrupted walk
 *     infers zero deletions, not "fewer" (§7.3, SC-008). The deletion a complete walk *does* infer
 *     goes through `ingest-comments.ts`'s shared `delete` — the same branch a webhook delete uses
 *     — so `text`/author are nulled and `reply_count` decremented identically either way (FR-030).
 *   - **Deactivation is not evidence of deletion.** A `PermanentError` (the post is gone or no
 *     longer reachable) deactivates the target (`next_sync_at = null`, reason in `last_error`) but
 *     infers nothing: the walk that hit it did not complete either, so the first invariant already
 *     covers it. A `RetryableError`, and any other unexpected exception, leaves the schedule
 *     untouched — the scheduler's own `next_sync_at <= now()` selection picks the target up again.
 *     An `AuthError` is recorded in `account_health` plus outbox `account.auth_failed` (D30, §18)
 *     — the same place the publish path records it — and otherwise leaves the schedule untouched
 *     too, since the account's broken credential is not evidence the post itself is gone.
 *
 * An explicit tombstone (`CommentPage.deletedPlatformCommentIds`, §18, extends §8.3) is routed
 * through the same delete branch a webhook delete uses and is never added to `seen` — marking it
 * seen would suppress the absence-based fallback above for every comment this page did not also
 * happen to report back (see `ingestPageTombstones`).
 *
 * Tagging (A10, FR-020): whether this is the target's first walk is read from
 * `SyncTargetRecord.lastSyncedAt === null` *before* the walk runs, and passed straight through as
 * `ingestionSource: 'backfill' | 'sync'` to `ingestComments.upsert` — the same field a webhook
 * delivery passes `'webhook'` for.
 */

// oxlint-disable max-lines -- one use case implementing the walk, the shared-upsert wiring, the
// complete-walk-only deletion inference and the PermanentError/RetryableError lifecycle branch
// (T086, T087); splitting the walk from the lifecycle handling would separate two things that
// must agree on the same `target`/`stats` to stay correct, not remove any of the logic itself.

import { and, eq, lt } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type {
  IngestComments,
  IngestedComment,
  IngestTarget,
  IngestionSource,
} from '#src/modules/comments/application/ingest-comments.ts';
import type { AccountHealth } from '#src/modules/comments/infrastructure/account-health.ts';
import { appendToOutbox } from '#src/modules/comments/infrastructure/outbox.ts';
import { comments } from '#src/modules/comments/infrastructure/schema.ts';
import type {
  SyncTargetRecord,
  SyncTargetRepository,
} from '#src/modules/comments/infrastructure/sync-target-repository.ts';
import type { AccountCredentials, Accounts } from '#src/modules/platform-core/ports.ts';
import {
  AuthError,
  PermanentError,
  type AccountContext,
  type CommentPage,
  type CommentPlatformAdapter,
  type NormalizedComment,
  type Platform,
} from '#src/platforms/types.ts';

export interface SyncPostStats {
  readonly fetched: number;
  readonly inserted: number;
  readonly updated: number;
  readonly deleted: number;
}

/** The same fields as {@link SyncPostStats}, mutable while one walk is in progress. */
interface MutableSyncStats {
  fetched: number;
  inserted: number;
  updated: number;
  deleted: number;
}

export type SyncPostResult =
  | { readonly status: 'succeeded'; readonly stats: SyncPostStats }
  | { readonly status: 'failed'; readonly stats: SyncPostStats; readonly error: string };

export interface SyncPostDeps {
  readonly database: NodePgDatabase;
  readonly ingestComments: IngestComments;
  readonly syncTargetRepository: SyncTargetRepository;
  readonly accounts: Accounts;
  readonly accountCredentials: AccountCredentials;
  readonly accountHealth: AccountHealth;
  readonly getAdapter: (platform: Platform) => CommentPlatformAdapter;
}

export interface SyncPost {
  run(targetId: string): Promise<SyncPostResult>;
}

const ZERO_STATS: SyncPostStats = { fetched: 0, inserted: 0, updated: 0, deleted: 0 };

/**
 * I1 (final-review.md): a walk's pages are fetched over several seconds, and this service's own
 * writes — a reply this walk's own account just published, a webhook delivery landing mid-walk —
 * can commit locally after the walk already paged past the platform's view of the thread, or
 * before the platform's read path has indexed them (ordinary eventual consistency on the Graph
 * API). Either way, `seen` never had a chance to include that comment, so treating its absence as
 * evidence of deletion is wrong: the walk wasn't "complete" *with respect to that write*. Five
 * minutes — the fastest configured cadence (Bluesky's under-24h band, `config.ts`) — bounds how
 * long a row this recently touched is held back from deletion inference; it is not a guess at
 * indexing lag specifically, just long enough that a write racing this walk is never mistaken for
 * a platform-side removal. Recorded for spec.md §18 (FR-019's "complete walk" reading).
 */
const DELETION_INFERENCE_GRACE_MS = 5 * 60_000;

/** Builds the account context a sync walk needs — the platform itself comes from `Accounts`, not
 * `SyncTargetRecord` (which carries no platform column of its own). Throws a plain `Error` (never
 * a typed adapter error) on a missing account or credentials — a local data problem, not a signal
 * from the platform, so {@link handleWalkFailure} must not mistake it for a `PermanentError`. */
async function loadAccountContext(
  deps: SyncPostDeps,
  target: SyncTargetRecord,
): Promise<AccountContext> {
  const account = await deps.accounts.findById(target.socialAccountId);
  if (!account.found) {
    throw new Error(`sync-post: social account ${target.socialAccountId} not found`);
  }
  const credentials = await deps.accountCredentials.findBySocialAccountId(target.socialAccountId);
  if (!credentials.found) {
    throw new Error(
      `sync-post: credentials for social account ${target.socialAccountId} not found`,
    );
  }
  return {
    workspaceId: target.workspaceId,
    socialAccountId: target.socialAccountId,
    platform: account.value.platform as Platform,
    platformAccountId: account.value.platformAccountId,
    credentials: credentials.value,
  };
}

function toIngestedComment(comment: NormalizedComment, ctx: AccountContext): IngestedComment {
  return {
    platformCommentId: comment.platformCommentId,
    platformParentId: comment.platformParentId,
    authorPlatformId: comment.authorPlatformId,
    authorUsername: comment.authorUsername,
    authorDisplayName: comment.authorDisplayName,
    text: comment.text,
    platformCreatedAt: comment.platformCreatedAt,
    platformMeta: comment.platformMeta,
    isOwn: comment.authorPlatformId === ctx.platformAccountId,
  };
}

/** Ingests one page's comments through the shared upsert path, updating `seen`/`stats` in place. */
async function ingestPageComments(
  deps: SyncPostDeps,
  ingestTarget: IngestTarget,
  ctx: AccountContext,
  adapter: CommentPlatformAdapter,
  ingestionSource: IngestionSource,
  page: CommentPage,
  seen: Set<string>,
  stats: MutableSyncStats,
): Promise<void> {
  for (const comment of page.comments) {
    seen.add(comment.platformCommentId);
    stats.fetched += 1;
    // A comment's ancestor chain (ingest-comments.ts) can depend on a sibling this same page
    // already inserted a few iterations ago — sequential by necessity, like that file's own walk.
    // oxlint-disable-next-line no-await-in-loop
    const result = await deps.ingestComments.upsert({
      target: ingestTarget,
      comment: toIngestedComment(comment, ctx),
      ingestionSource,
      ctx,
      adapter,
    });
    if (result.wasNew) {
      stats.inserted += 1;
    } else {
      stats.updated += 1;
    }
  }
}

/**
 * Routes a page's explicit tombstones (`CommentPage.deletedPlatformCommentIds`, spec.md §18,
 * extends §8.3) through the same delete branch a webhook delete uses — never the upsert path —
 * and deliberately does not add them to `seen`: a tombstone is not evidence a comment was
 * observed `posted`, so letting it into `seen` would suppress the absence-based fallback this
 * same walk still owes every other comment it never reports back.
 */
async function ingestPageTombstones(
  deps: SyncPostDeps,
  ingestTarget: IngestTarget,
  page: CommentPage,
  stats: MutableSyncStats,
): Promise<void> {
  for (const platformCommentId of page.deletedPlatformCommentIds) {
    // Each tombstone's delete is independent of the others; sequential only to keep
    // `stats.deleted` a plain running count instead of a Promise.all reduction.
    // oxlint-disable-next-line no-await-in-loop
    const result = await deps.ingestComments.delete({
      workspaceId: ingestTarget.workspaceId,
      socialAccountId: ingestTarget.socialAccountId,
      platform: ingestTarget.platform,
      platformCommentId,
    });
    if (result.wasDeleted) {
      stats.deleted += 1;
    }
  }
}

async function ingestPage(
  deps: SyncPostDeps,
  ingestTarget: IngestTarget,
  ctx: AccountContext,
  adapter: CommentPlatformAdapter,
  ingestionSource: IngestionSource,
  page: CommentPage,
  seen: Set<string>,
  stats: MutableSyncStats,
): Promise<void> {
  await ingestPageComments(deps, ingestTarget, ctx, adapter, ingestionSource, page, seen, stats);
  await ingestPageTombstones(deps, ingestTarget, page, stats);
}

/**
 * Walks every page through `adapter.listComments`, ingesting each as it arrives. Throws — rather
 * than returning a partial result — the moment a page fails, so the caller cannot mistake an
 * interrupted walk for a complete one (the adapters are built to make exactly this honest: a
 * pagination failure throws instead of returning a short page).
 */
async function walkAndIngest(
  deps: SyncPostDeps,
  target: SyncTargetRecord,
  ctx: AccountContext,
  adapter: CommentPlatformAdapter,
  ingestionSource: IngestionSource,
  stats: MutableSyncStats,
): Promise<Set<string>> {
  const seen = new Set<string>();
  const ingestTarget: IngestTarget = {
    workspaceId: target.workspaceId,
    socialAccountId: target.socialAccountId,
    platform: ctx.platform,
    postId: target.postId,
    platformPostId: target.platformPostId,
  };

  let cursor: string | undefined;
  do {
    // Each page's cursor is only known once the previous page came back — genuinely sequential,
    // not a candidate for Promise.all.
    // oxlint-disable-next-line no-await-in-loop
    const page = await adapter.listComments(ctx, { platformPostId: target.platformPostId }, cursor);
    // oxlint-disable-next-line no-await-in-loop
    await ingestPage(deps, ingestTarget, ctx, adapter, ingestionSource, page, seen, stats);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);

  return seen;
}

/**
 * FR-019, FR-030: marks every locally-`posted` comment on this post absent from `seen` `deleted`,
 * through `ingestComments.delete` — the same branch a webhook delete uses, so `text`/author are
 * nulled and `reply_count` decremented identically either way. Only reached after a complete walk.
 *
 * Excludes any row updated at or after `walkStartedAt - DELETION_INFERENCE_GRACE_MS` (I1,
 * final-review.md): a row this recently touched could be a write that raced this very walk rather
 * than evidence the platform removed it, and {@link run} is explicit that "complete" is read
 * relative to what the walk *could* have seen.
 */
async function inferDeletions(
  deps: SyncPostDeps,
  target: SyncTargetRecord,
  ctx: AccountContext,
  seen: ReadonlySet<string>,
  stats: MutableSyncStats,
  walkStartedAt: Date,
): Promise<void> {
  const cutoff = new Date(walkStartedAt.getTime() - DELETION_INFERENCE_GRACE_MS);
  const existing = await deps.database
    .select({ platformCommentId: comments.platformCommentId })
    .from(comments)
    .where(
      and(
        eq(comments.socialAccountId, target.socialAccountId),
        eq(comments.platformPostId, target.platformPostId),
        eq(comments.status, 'posted'),
        lt(comments.updatedAt, cutoff),
      ),
    );

  for (const row of existing) {
    if (row.platformCommentId === null || seen.has(row.platformCommentId)) {
      continue;
    }
    // Each row's delete is independent of the others; sequential only to keep `stats.deleted` a
    // plain running count instead of a Promise.all reduction.
    // oxlint-disable-next-line no-await-in-loop
    const result = await deps.ingestComments.delete({
      workspaceId: target.workspaceId,
      socialAccountId: target.socialAccountId,
      platform: ctx.platform,
      platformCommentId: row.platformCommentId,
    });
    if (result.wasDeleted) {
      stats.deleted += 1;
    }
  }
}

/** §7.3: a successful walk's schedule, recomputed from the target's own `age_anchor_at` — this is
 * also what "restores" a manually-run, previously-deactivated target's schedule (D19): nothing
 * here reads the target's prior `next_sync_at`, so a `null` before this call is no different from
 * any other value.
 *
 * I2 (final-review.md, D30 §18): also clears this account's `account_health` row, if any.
 * `run()` reaching here means `loadAccountContext` decrypted a credential and `adapter.listComments`
 * used it successfully for the whole walk — direct evidence the account works again, and the only
 * such evidence this module can observe on its own. `AccountHealth.clear` had no caller anywhere in
 * the service before this, so a reconnected account stayed `disconnected` forever (D30's own text,
 * "a projection row that flips back to `active` clears it", cannot be read from `social_accounts`
 * alone: the publish path's own `AuthError` test records `auth_failed` while leaving
 * `social_accounts.status` at `active` the whole time, so "projection active + a local record"
 * describes an *ongoing* failure just as often as a resolved one — a successful call is the
 * unambiguous signal). A no-op when there was no stale record to begin with.
 */
async function markSucceeded(
  deps: SyncPostDeps,
  targetId: string,
  target: SyncTargetRecord,
  platform: Platform,
): Promise<void> {
  const now = new Date();
  const nextSyncAt = deps.syncTargetRepository.computeNextSyncAtFor(
    platform,
    target.ageAnchorAt,
    now,
  );
  await deps.syncTargetRepository.markSyncSucceeded(targetId, { lastSyncedAt: now, nextSyncAt });
  await deps.accountHealth.clear(target.socialAccountId);
}

/**
 * D30, §18: an `AuthError` observed mid-walk is the same fact the publish path already records
 * through `account_health` — the credential is invalid — and must land the same way: this
 * service's own `account_health` table plus outbox `account.auth_failed`, never a write to the
 * `social_accounts` projection (D8, D29, Principle II). Without this, the effective account
 * status a refresh-only failure leaves behind stays `active` while the publish path's equivalent
 * failure would have disconnected it.
 *
 * `platform` is `undefined` only if the credential was unreadable before {@link loadAccountContext}
 * could resolve it — that function never itself throws `AuthError`, so this guard is defensive
 * against a future adapter change rather than a path reachable today.
 */
async function recordAuthFailure(
  deps: SyncPostDeps,
  target: SyncTargetRecord,
  platform: Platform,
  reason: string,
): Promise<void> {
  await deps.database.transaction((tx) =>
    appendToOutbox(tx, {
      workspaceId: target.workspaceId,
      type: 'account.auth_failed',
      aggregateId: target.socialAccountId,
      data: { socialAccountId: target.socialAccountId, platform, reason },
    }),
  );
  await deps.accountHealth.markAuthFailed({
    socialAccountId: target.socialAccountId,
    workspaceId: target.workspaceId,
    reason,
  });
}

/**
 * §7.3, T087: an `AuthError` is recorded in `account_health` (above); a `PermanentError`
 * deactivates the target; a `RetryableError` — and anything else the walk raised, typed or not —
 * leaves the schedule exactly as it was.
 */
async function handleWalkFailure(
  deps: SyncPostDeps,
  targetId: string,
  target: SyncTargetRecord,
  platform: Platform | undefined,
  error: unknown,
): Promise<void> {
  if (error instanceof AuthError) {
    if (platform !== undefined) {
      await recordAuthFailure(deps, target, platform, error.message);
    }
    return;
  }
  if (error instanceof PermanentError) {
    await deps.syncTargetRepository.deactivate(targetId, error.message);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs one refresh walk for `targetId` (§7.3).
 *
 * Args:
 *   deps: The ports and collaborators this use case is built from.
 *   targetId: The `comment_sync_targets` row to refresh.
 *
 * Returns:
 *   The {@link SyncPostResult} this walk settled on. Never throws.
 */
async function run(deps: SyncPostDeps, targetId: string): Promise<SyncPostResult> {
  const target = await deps.syncTargetRepository.findById(targetId);
  if (target === null) {
    return {
      status: 'failed',
      stats: ZERO_STATS,
      error: `sync-post: target ${targetId} not found`,
    };
  }

  const stats: MutableSyncStats = { fetched: 0, inserted: 0, updated: 0, deleted: 0 };
  // Read by the `catch` below if an `AuthError` lands after the account context resolved but
  // before the walk finishes — `handleWalkFailure` needs the platform to record it correctly.
  let resolvedPlatform: Platform | undefined;
  try {
    const ctx = await loadAccountContext(deps, target);
    resolvedPlatform = ctx.platform;
    const adapter = deps.getAdapter(ctx.platform);
    const ingestionSource: IngestionSource = target.lastSyncedAt === null ? 'backfill' : 'sync';

    // Captured before paging starts: I1 needs the instant the walk could not yet have observed
    // anything written after, not when it happened to finish.
    const walkStartedAt = new Date();
    const seen = await walkAndIngest(deps, target, ctx, adapter, ingestionSource, stats);
    await inferDeletions(deps, target, ctx, seen, stats, walkStartedAt);
    await markSucceeded(deps, targetId, target, ctx.platform);

    return { status: 'succeeded', stats: { ...stats } };
  } catch (error) {
    await handleWalkFailure(deps, targetId, target, resolvedPlatform, error);
    return { status: 'failed', stats: { ...stats }, error: errorMessage(error) };
  }
}

/** Backs {@link SyncPost}; construct once per worker with a database handle and its ports (T086). */
export function createSyncPost(deps: SyncPostDeps): SyncPost {
  return { run: (targetId: string) => run(deps, targetId) };
}
