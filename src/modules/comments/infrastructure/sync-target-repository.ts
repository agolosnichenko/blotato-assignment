/**
 * Refresh-target repository (T085, spec.md §7.3, FR-018).
 *
 * `comment_sync_targets` is the only table that decides which posts the scheduler refreshes, and
 * `ensureTarget` is the only way a row is created — from the `PostPublished` port for a post this
 * service published, and from `ingest-comments.ts`'s shared upsert path for the first comment seen
 * on a post it did not (data-model.md §3). `UNIQUE (social_account_id, platform_post_id)` is what
 * makes those two entry points converge on one row instead of racing: `ensureTarget` inserts with
 * `ON CONFLICT DO NOTHING` and reads back whichever row won, rather than checking for an existing
 * row before inserting — a check-then-insert has a gap two concurrent callers (e.g. two comments on
 * the same unknown post arriving together) can both pass through, producing two rows for one post.
 * Because Postgres makes a conflicting `INSERT` wait for the other transaction to commit before
 * evaluating `ON CONFLICT`, the read-back after a no-op insert is guaranteed to see the winner's row.
 *
 * `computeNextSyncAt` is the pure §7.3 age-band function, exported separately so
 * `sync-post.integration.test.ts` can exercise the table directly against a non-default
 * `RETENTION_DAYS` without seeding a database row. The top band comes from `config.RETENTION_DAYS`,
 * never a literal `45`: FR-018 ties "stop tracking" to the retention window, so a deployment that
 * shortens retention must stop polling posts whose threads the purge has already removed, not keep
 * spending rate limit on them forever.
 *
 * `nextSyncAt: null` means the target is deactivated (§7.3: a `PermanentError` from the platform,
 * or a manual reactivation not yet run) — a state the target itself carries. A target whose
 * `ageAnchorAt` has aged past `RETENTION_DAYS` is simply not selected by `computeNextSyncAt` the
 * next time it would be scheduled; nothing here writes `null` into `next_sync_at` for that reason,
 * because retention-driven silence is a fact about the post's age, not a recorded target state —
 * unlike deactivation, it needs no `last_error` and is not something a manual sync should reverse
 * by "restoring" a value that was never set.
 */

// oxlint-disable max-lines -- one repository implementing the age-band schedule (T085) plus the
// lifecycle writes T086/T087/T089 need (`deactivate`, `setManualCooldown`, `computeNextSyncAtFor`)
// — splitting the lifecycle methods out would duplicate `TARGET_COLUMNS` and the concurrency-safe
// `ensureTarget` pattern they all share instead of removing any of it.

import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { commentSyncTargets } from '#src/modules/comments/infrastructure/schema.ts';
import type { Platform } from '#src/platforms/types.ts';

/** The configurable §7.3 interval table, read from `src/app/config.ts`. */
export interface SyncIntervalsConfig {
  readonly RETENTION_DAYS: number;
  readonly SYNC_INTERVALS_BLUESKY_UNDER_24H_MINUTES: number;
  readonly SYNC_INTERVALS_BLUESKY_1_TO_7_DAYS_MINUTES: number;
  readonly SYNC_INTERVALS_BLUESKY_7_DAYS_TO_RETENTION_MINUTES: number;
  readonly SYNC_INTERVALS_META_UNDER_24H_MINUTES: number;
  readonly SYNC_INTERVALS_META_1_TO_7_DAYS_MINUTES: number;
  readonly SYNC_INTERVALS_META_7_DAYS_TO_RETENTION_MINUTES: number;
}

export interface ComputeNextSyncAtInput {
  readonly platform: Platform;
  /** The instant §7.3's age bands are measured from — `comment_sync_targets.age_anchor_at`. */
  readonly ageAnchorAt: Date;
  readonly now: Date;
  readonly config: SyncIntervalsConfig;
}

export interface SyncTargetRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly socialAccountId: string;
  readonly postId: string | null;
  readonly platformPostId: string;
  readonly lastSyncedAt: Date | null;
  readonly nextSyncAt: Date | null;
  readonly lastError: string | null;
  readonly manualCooldownUntil: Date | null;
  readonly ageAnchorAt: Date;
}

export interface EnsureTargetInput {
  readonly workspaceId: string;
  readonly socialAccountId: string;
  readonly platform: Platform;
  /** `null` for a post never published through this service (an external post, FR-018). */
  readonly postId: string | null;
  readonly platformPostId: string;
  /** The post's `published_at`, or the first ingested comment's `occurred_at` for an external post. */
  readonly ageAnchorAt: Date;
}

export interface MarkSyncSucceededInput {
  readonly lastSyncedAt: Date;
  readonly nextSyncAt: Date | null;
}

export interface SyncTargetRepository {
  /**
   * Creates the target if none exists yet for `(socialAccountId, platformPostId)`, or returns the
   * existing one unchanged — idempotent under concurrent callers (see the module docstring). The
   * initial `next_sync_at` is computed from `ageAnchorAt` at insert time; an already-existing
   * target's schedule is left as-is, since a second caller observing the same post is not evidence
   * its schedule needs recomputing.
   */
  ensureTarget(input: EnsureTargetInput): Promise<SyncTargetRecord>;
  findById(targetId: string): Promise<SyncTargetRecord | null>;
  /** Resolves the target for a post this service published (`request-sync.ts`, T089). */
  findByPostId(postId: string): Promise<SyncTargetRecord | null>;
  /** `lastSyncedAt`/`nextSyncAt` are supplied by the caller, not recomputed here (T086 owns that). */
  markSyncSucceeded(targetId: string, input: MarkSyncSucceededInput): Promise<void>;
  /**
   * §7.3: a `PermanentError` from the platform (the post is gone or no longer accessible)
   * deactivates the target — `next_sync_at = null`, `reason` recorded in `last_error` — without
   * touching `last_synced_at` (T087). A manual request (`request-sync.ts`) still runs against a
   * deactivated target; only a *successful* walk's own `markSyncSucceeded` call restores the
   * schedule, by computing a real `next_sync_at` again.
   */
  deactivate(targetId: string, reason: string): Promise<void>;
  /** D19's 60-second manual cooldown: the instant a second manual request starts being rejected. */
  setManualCooldown(targetId: string, manualCooldownUntil: Date): Promise<void>;
  /**
   * The §7.3 age-band schedule for one target, bound to this repository's own `config` — the seam
   * that lets `sync-post.ts` (T086) compute `markSyncSucceeded`'s `nextSyncAt` without needing a
   * `SyncIntervalsConfig` of its own in its dependency shape (the contract test's `deps` has none).
   * A thin wrapper over the exported pure {@link computeNextSyncAt}, not a second implementation.
   */
  computeNextSyncAtFor(platform: Platform, ageAnchorAt: Date, now: Date): Date | null;
}

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

interface BandMinutes {
  readonly under24h: number;
  readonly oneToSevenDays: number;
  readonly sevenDaysToRetention: number;
}

function bandMinutesFor(platform: Platform, config: SyncIntervalsConfig): BandMinutes {
  if (platform === 'bluesky') {
    return {
      under24h: config.SYNC_INTERVALS_BLUESKY_UNDER_24H_MINUTES,
      oneToSevenDays: config.SYNC_INTERVALS_BLUESKY_1_TO_7_DAYS_MINUTES,
      sevenDaysToRetention: config.SYNC_INTERVALS_BLUESKY_7_DAYS_TO_RETENTION_MINUTES,
    };
  }
  if (platform === 'instagram' || platform === 'facebook') {
    return {
      under24h: config.SYNC_INTERVALS_META_UNDER_24H_MINUTES,
      oneToSevenDays: config.SYNC_INTERVALS_META_1_TO_7_DAYS_MINUTES,
      sevenDaysToRetention: config.SYNC_INTERVALS_META_7_DAYS_TO_RETENTION_MINUTES,
    };
  }
  // The capability registry limits comment sync to instagram/facebook/bluesky (CLAUDE.md
  // "Architecture"); a caller reaching this with another platform is a bug upstream, not a case
  // to silently default.
  throw new Error(`computeNextSyncAt: platform '${platform}' does not support comment sync`);
}

/**
 * The §7.3 age-band schedule, as a pure function of a target's age anchor. `null` means "past
 * `config.RETENTION_DAYS` — not polled" (FR-018, D13, D15), derived from the config rather than a
 * literal `45` so a deployment that shortens retention stops polling posts the purge has removed.
 */
export function computeNextSyncAt(input: ComputeNextSyncAtInput): Date | null {
  const { platform, ageAnchorAt, now, config } = input;
  const ageDays = (now.getTime() - ageAnchorAt.getTime()) / MS_PER_DAY;

  if (ageDays >= config.RETENTION_DAYS) {
    return null;
  }

  const band = bandMinutesFor(platform, config);
  const intervalMinutes =
    ageDays < 1 ? band.under24h : ageDays < 7 ? band.oneToSevenDays : band.sevenDaysToRetention;

  return new Date(now.getTime() + intervalMinutes * MS_PER_MINUTE);
}

const TARGET_COLUMNS = {
  id: commentSyncTargets.id,
  workspaceId: commentSyncTargets.workspaceId,
  socialAccountId: commentSyncTargets.socialAccountId,
  postId: commentSyncTargets.postId,
  platformPostId: commentSyncTargets.platformPostId,
  lastSyncedAt: commentSyncTargets.lastSyncedAt,
  nextSyncAt: commentSyncTargets.nextSyncAt,
  lastError: commentSyncTargets.lastError,
  manualCooldownUntil: commentSyncTargets.manualCooldownUntil,
  ageAnchorAt: commentSyncTargets.ageAnchorAt,
} as const;

async function findExistingTarget(
  db: NodePgDatabase,
  socialAccountId: string,
  platformPostId: string,
): Promise<SyncTargetRecord | null> {
  const [row] = await db
    .select(TARGET_COLUMNS)
    .from(commentSyncTargets)
    .where(
      and(
        eq(commentSyncTargets.socialAccountId, socialAccountId),
        eq(commentSyncTargets.platformPostId, platformPostId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function ensureTarget(
  db: NodePgDatabase,
  config: SyncIntervalsConfig,
  input: EnsureTargetInput,
): Promise<SyncTargetRecord> {
  const now = new Date();
  const nextSyncAt = computeNextSyncAt({
    platform: input.platform,
    ageAnchorAt: input.ageAnchorAt,
    now,
    config,
  });

  const [inserted] = await db
    .insert(commentSyncTargets)
    .values({
      workspaceId: input.workspaceId,
      socialAccountId: input.socialAccountId,
      postId: input.postId,
      platformPostId: input.platformPostId,
      lastSyncedAt: null,
      nextSyncAt,
      lastError: null,
      manualCooldownUntil: null,
      ageAnchorAt: input.ageAnchorAt,
    })
    .onConflictDoNothing({
      target: [commentSyncTargets.socialAccountId, commentSyncTargets.platformPostId],
    })
    .returning(TARGET_COLUMNS);

  if (inserted !== undefined) {
    return inserted;
  }

  // Lost the race: another caller's insert committed first. Postgres blocks a conflicting insert
  // until that transaction commits, so the row is guaranteed visible here (module docstring).
  const existing = await findExistingTarget(db, input.socialAccountId, input.platformPostId);
  if (existing === null) {
    throw new Error(
      `ensureTarget: conflicted on (${input.socialAccountId}, ${input.platformPostId}) but no row was found on read-back`,
    );
  }
  return existing;
}

async function findById(db: NodePgDatabase, targetId: string): Promise<SyncTargetRecord | null> {
  const [row] = await db
    .select(TARGET_COLUMNS)
    .from(commentSyncTargets)
    .where(eq(commentSyncTargets.id, targetId))
    .limit(1);
  return row ?? null;
}

async function findByPostId(db: NodePgDatabase, postId: string): Promise<SyncTargetRecord | null> {
  const [row] = await db
    .select(TARGET_COLUMNS)
    .from(commentSyncTargets)
    .where(eq(commentSyncTargets.postId, postId))
    .limit(1);
  return row ?? null;
}

async function markSyncSucceeded(
  db: NodePgDatabase,
  targetId: string,
  input: MarkSyncSucceededInput,
): Promise<void> {
  await db
    .update(commentSyncTargets)
    .set({
      lastSyncedAt: input.lastSyncedAt,
      nextSyncAt: input.nextSyncAt,
      // A successful walk supersedes whatever reason a previous one failed for.
      lastError: null,
    })
    .where(eq(commentSyncTargets.id, targetId));
}

/** §7.3: deactivates a target — `next_sync_at = null`, `reason` recorded — without touching `last_synced_at`. */
async function deactivate(db: NodePgDatabase, targetId: string, reason: string): Promise<void> {
  await db
    .update(commentSyncTargets)
    .set({ nextSyncAt: null, lastError: reason })
    .where(eq(commentSyncTargets.id, targetId));
}

async function setManualCooldown(
  db: NodePgDatabase,
  targetId: string,
  manualCooldownUntil: Date,
): Promise<void> {
  await db
    .update(commentSyncTargets)
    .set({ manualCooldownUntil })
    .where(eq(commentSyncTargets.id, targetId));
}

/** Backs {@link SyncTargetRepository}; construct once per database handle and config (T085). */
export function createSyncTargetRepository(
  db: NodePgDatabase,
  config: SyncIntervalsConfig,
): SyncTargetRepository {
  return {
    ensureTarget: (input) => ensureTarget(db, config, input),
    findById: (targetId) => findById(db, targetId),
    findByPostId: (postId) => findByPostId(db, postId),
    markSyncSucceeded: (targetId, input) => markSyncSucceeded(db, targetId, input),
    deactivate: (targetId, reason) => deactivate(db, targetId, reason),
    setManualCooldown: (targetId, manualCooldownUntil) =>
      setManualCooldown(db, targetId, manualCooldownUntil),
    computeNextSyncAtFor: (platform, ageAnchorAt, now) =>
      computeNextSyncAt({ platform, ageAnchorAt, now, config }),
  };
}
