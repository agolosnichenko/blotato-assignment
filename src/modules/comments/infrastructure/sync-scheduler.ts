/**
 * The `comment-sync` scheduler and worker (T088, §7.3, §9.2).
 *
 * Two halves, one file because they are the two ends of the same pipe (mirroring `sweepers.ts` /
 * `publish-worker.ts`'s split, just kept together here since the task names both at once):
 *
 * - {@link createSyncScheduler}: the repeatable job (`src/app/worker.ts` registers it on the
 *   `scheduler` queue, concurrency 1, every minute) that selects `next_sync_at <= now()` with
 *   `FOR UPDATE SKIP LOCKED` and turns each selected target into one `comment_sync_jobs` row
 *   (`trigger: scheduled`) plus one `comment-sync` queue job — racing the same partial unique
 *   index `request-sync.ts`'s manual path races, so a target a human just triggered manually is
 *   never double-enqueued by the next tick.
 * - {@link createSyncWorker}: the `comment-sync` queue's own `Worker`, with a per-account token
 *   bucket (BullMQ's built-in `limiter` throttles the whole queue, not per key — same reasoning
 *   as `publish-worker.ts`'s). It marks the job `running`, delegates to `SyncPost.run` (T086/T087,
 *   which never throws), and writes the outcome back onto the job row — `queued`/`running` are
 *   this file's own bookkeeping; `SyncPost` itself knows nothing about job rows.
 *
 * **The `FOR UPDATE SKIP LOCKED` selection and each target's job insert commit in one
 * transaction** (mirroring `outbox-relay.ts`): holding the lock across the insert is what stops a
 * hypothetical second concurrent tick from selecting the same due target while this tick's insert
 * for it is still pending. The `scheduler` queue's own concurrency-1 rule (`src/app/worker.ts`)
 * already rules that out in practice; the lock is defence in depth, not the only thing holding.
 */

// oxlint-disable max-dependencies -- this file wires the scheduler's own selection query and the
// comment-sync worker's full dependency graph (SyncPost's ports, the three adapters, the token
// bucket) — the same shape `publish-worker.ts` has for the same reason.
// oxlint-disable max-lines -- two halves of one pipe, the scheduler tick and the comment-sync
// worker (the task names both in one file); splitting them would duplicate the token bucket and
// the `comment_sync_jobs` conflict-racing helpers both already share.

import { and, eq, isNotNull, lte, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DelayedError, Worker, type Job, type Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { Config } from '#src/app/config.ts';
import { createIngestComments } from '#src/modules/comments/application/ingest-comments.ts';
import {
  createSyncPost,
  type SyncPost,
  type SyncPostResult,
} from '#src/modules/comments/application/sync-post.ts';
import { createAccountHealth } from '#src/modules/comments/infrastructure/account-health.ts';
import type { OutboxTransaction } from '#src/modules/comments/infrastructure/outbox.ts';
import {
  commentSyncJobs,
  commentSyncTargets,
} from '#src/modules/comments/infrastructure/schema.ts';
import type { SyncTargetRepository } from '#src/modules/comments/infrastructure/sync-target-repository.ts';
import { createBlueskyAdapter } from '#src/platforms/bluesky/adapter.ts';
import { createFacebookAdapter } from '#src/platforms/meta/facebook-adapter.ts';
import { createInstagramAdapter } from '#src/platforms/meta/instagram-adapter.ts';
import type { AccountCredentials, Accounts } from '#src/modules/platform-core/ports.ts';
import type { CommentPlatformAdapter, Platform } from '#src/platforms/types.ts';
import { forJob } from '#src/shared/logger.ts';
import { QUEUE_NAMES } from '#src/shared/queues.ts';

const SCHEDULE_BATCH_SIZE = 100;

// ---------------------------------------------------------------------------------------------
// Scheduler: select due targets, enqueue one job each
// ---------------------------------------------------------------------------------------------

export interface SyncSchedulerDeps {
  readonly database: NodePgDatabase;
  readonly syncQueue: Queue;
}

export interface SyncScheduler {
  tick(): Promise<void>;
}

interface DueTarget {
  readonly id: string;
  readonly workspaceId: string;
}

async function selectDueTargets(tx: OutboxTransaction): Promise<DueTarget[]> {
  return await tx
    .select({ id: commentSyncTargets.id, workspaceId: commentSyncTargets.workspaceId })
    .from(commentSyncTargets)
    .where(
      and(isNotNull(commentSyncTargets.nextSyncAt), lte(commentSyncTargets.nextSyncAt, new Date())),
    )
    .limit(SCHEDULE_BATCH_SIZE)
    .for('update', { skipLocked: true });
}

/**
 * Creates a `scheduled` job row for `target`, racing the partial unique index against a
 * concurrent manual request or a previous tick's still-active job. On a lost race, nothing is
 * enqueued — the existing job will run to completion and advance `next_sync_at` on its own.
 */
async function enqueueScheduledJob(
  tx: OutboxTransaction,
  syncQueue: Queue,
  target: DueTarget,
): Promise<void> {
  const [inserted] = await tx
    .insert(commentSyncJobs)
    .values({
      workspaceId: target.workspaceId,
      targetId: target.id,
      trigger: 'scheduled',
      status: 'queued',
      stats: null,
      error: null,
    })
    .onConflictDoNothing({
      target: [commentSyncJobs.targetId],
      where: sql`${commentSyncJobs.status} in ('queued', 'running')`,
    })
    .returning({ id: commentSyncJobs.id });

  if (inserted === undefined) {
    return;
  }
  await syncQueue.add('sync', { targetId: target.id }, { jobId: inserted.id });
}

/**
 * Creates and returns the `comment-sync` scheduler (T088).
 *
 * `tick()` is the body of the repeatable `scheduler`-queue job `src/app/worker.ts` registers
 * (every minute, concurrency 1) — it selects every target whose `next_sync_at` is due and
 * enqueues one `comment-sync` job per target.
 */
export function createSyncScheduler(deps: SyncSchedulerDeps): SyncScheduler {
  return {
    async tick(): Promise<void> {
      await deps.database.transaction(async (tx) => {
        const due = await selectDueTargets(tx);
        for (const target of due) {
          // Each target's job insert is independent of the others; sequential only because it
          // runs inside one transaction alongside the `FOR UPDATE SKIP LOCKED` select above — see
          // the module docstring for why that lock must span the insert.
          // oxlint-disable-next-line no-await-in-loop
          await enqueueScheduledJob(tx, deps.syncQueue, target);
        }
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Worker: run one job, per-account token bucket
// ---------------------------------------------------------------------------------------------

const WORKER_CONCURRENCY = 10;

const BUCKET_KEY_PREFIX = 'sync-worker:bucket:';
/** Max burst per account before the bucket must refill — conservative placeholders, not a
 * published Meta or Bluesky rate limit (the Meta spikes have not run against Standard Access;
 * see `publish-worker.ts`'s docstring for the same caveat). */
const BUCKET_CAPACITY = 2;
const BUCKET_REFILL_PER_SECOND = 0.5;
const BUCKET_TTL_SECONDS = 120;

const TOKEN_BUCKET_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillPerSecond = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttlSeconds = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then
  tokens = capacity
  ts = now
end

local elapsedMs = now - ts
if elapsedMs < 0 then
  elapsedMs = 0
end
tokens = math.min(capacity, tokens + (elapsedMs / 1000) * refillPerSecond)

local allowed = 0
local retryAfterMs = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retryAfterMs = math.ceil(((1 - tokens) / refillPerSecond) * 1000)
end

redis.call('HMSET', key, 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('EXPIRE', key, ttlSeconds)

return {allowed, retryAfterMs}
`;

interface TokenBucketResult {
  readonly allowed: boolean;
  readonly retryAfterMs: number;
}

async function tryAcquireToken(redis: Redis, socialAccountId: string): Promise<TokenBucketResult> {
  const raw = (await redis.eval(
    TOKEN_BUCKET_SCRIPT,
    1,
    `${BUCKET_KEY_PREFIX}${socialAccountId}`,
    BUCKET_CAPACITY,
    BUCKET_REFILL_PER_SECOND,
    Date.now(),
    BUCKET_TTL_SECONDS,
  )) as [number, number];
  const [allowed, retryAfterMs] = raw;
  return { allowed: allowed === 1, retryAfterMs };
}

/** Builds the `platform -> adapter` lookup `SyncPost.getAdapter` needs — a `Record`, not a
 * `switch`, same as `publish-worker.ts`'s own registry (Principle IV). */
function buildAdapterRegistry(config: Config): (platform: Platform) => CommentPlatformAdapter {
  const adapters: Partial<Record<Platform, CommentPlatformAdapter>> = {
    instagram: createInstagramAdapter({ apiVersion: config.META_GRAPH_API_VERSION }),
    facebook: createFacebookAdapter({ apiVersion: config.META_GRAPH_API_VERSION }),
    bluesky: createBlueskyAdapter({ threadDepth: config.BLUESKY_THREAD_DEPTH }),
  };

  return (platform: Platform): CommentPlatformAdapter => {
    const adapter = adapters[platform];
    if (adapter === undefined) {
      throw new Error(`sync-scheduler: no adapter registered for platform "${platform}"`);
    }
    return adapter;
  };
}

async function delaySyncJob(
  job: Job,
  token: string | undefined,
  delayMs: number,
  jobLogger: Logger,
): Promise<never> {
  if (token === undefined) {
    throw new Error('sync-scheduler: missing lock token, cannot delay for account-rate-limited');
  }
  jobLogger.debug({ delayMs }, 'sync-scheduler: delaying job, account rate-limited');
  await job.moveToDelayed(Date.now() + delayMs, token);
  throw new DelayedError();
}

/** `queued -> running`. `false` means another runner already claimed this job — normal, not an
 * error, the same reasoning `CommentRepository`'s conditional transitions use (D14). */
async function markJobRunning(db: NodePgDatabase, jobId: string): Promise<boolean> {
  const result = await db
    .update(commentSyncJobs)
    .set({ status: 'running', startedAt: new Date() })
    .where(and(eq(commentSyncJobs.id, jobId), eq(commentSyncJobs.status, 'queued')));
  return (result.rowCount ?? 0) > 0;
}

async function finalizeJob(
  db: NodePgDatabase,
  jobId: string,
  result: SyncPostResult,
): Promise<void> {
  await db
    .update(commentSyncJobs)
    .set({
      status: result.status,
      stats: result.stats,
      error: result.status === 'failed' ? result.error : null,
      finishedAt: new Date(),
    })
    .where(eq(commentSyncJobs.id, jobId));
}

function readTargetId(job: Job): string {
  const targetId = (job.data as { targetId?: unknown }).targetId;
  if (typeof targetId !== 'string') {
    throw new TypeError(`sync-scheduler: job ${String(job.id)} has no targetId in its payload`);
  }
  return targetId;
}

export interface SyncWorkerDeps {
  readonly database: NodePgDatabase;
  readonly redis: Redis;
  readonly config: Config;
  readonly accounts: Accounts;
  readonly accountCredentials: AccountCredentials;
  readonly syncTargetRepository: SyncTargetRepository;
  readonly logger: Logger;
}

async function processSyncJob(
  deps: SyncWorkerDeps,
  syncPost: SyncPost,
  job: Job,
  token: string | undefined,
): Promise<void> {
  const jobId = job.id;
  if (jobId === undefined) {
    throw new Error('sync-scheduler: job has no id (jobId must be the comment_sync_jobs id)');
  }
  const targetId = readTargetId(job);
  const jobLogger = forJob(deps.logger, jobId);

  const target = await deps.syncTargetRepository.findById(targetId);
  if (target === null) {
    jobLogger.warn('sync-scheduler: target not found, skipping');
    return;
  }

  const bucket = await tryAcquireToken(deps.redis, target.socialAccountId);
  if (!bucket.allowed) {
    await delaySyncJob(job, token, bucket.retryAfterMs, jobLogger);
  }

  const claimed = await markJobRunning(deps.database, jobId);
  if (!claimed) {
    jobLogger.debug('sync-scheduler: job already running or finished, skipping');
    return;
  }

  const result = await syncPost.run(targetId);
  await finalizeJob(deps.database, jobId, result);
  if (result.status === 'succeeded') {
    jobLogger.info({ stats: result.stats }, 'sync-scheduler: walk succeeded');
  } else {
    jobLogger.warn({ stats: result.stats, error: result.error }, 'sync-scheduler: walk failed');
  }
}

/**
 * Creates and starts the `comment-sync` worker (T088).
 *
 * Args:
 *   deps: The database handle, Redis connection, config (for the Meta Graph API version and the
 *     Bluesky thread depth), the platform-core ports and `SyncTargetRepository` `SyncPost` needs,
 *     and a logger to stamp each job's id onto.
 *
 * Returns:
 *   The running `Worker`. The caller owns its lifecycle (`close()` on shutdown).
 */
export function createSyncWorker(deps: SyncWorkerDeps): Worker {
  const ingestComments = createIngestComments({
    database: deps.database,
    syncTargetRepository: deps.syncTargetRepository,
  });
  const syncPost = createSyncPost({
    database: deps.database,
    ingestComments,
    syncTargetRepository: deps.syncTargetRepository,
    accounts: deps.accounts,
    accountCredentials: deps.accountCredentials,
    accountHealth: createAccountHealth(deps.database),
    getAdapter: buildAdapterRegistry(deps.config),
  });

  return new Worker(
    QUEUE_NAMES.commentSync,
    (job: Job, token?: string): Promise<void> => processSyncJob(deps, syncPost, job, token),
    { connection: deps.redis, concurrency: WORKER_CONCURRENCY },
  );
}
