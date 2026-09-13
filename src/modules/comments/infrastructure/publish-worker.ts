/**
 * The `comment-publish` BullMQ worker (T063, §7.1 steps 5-6, §9.2).
 *
 * Wires `PublishComment` (§7.1 steps 5-6, which itself reconciles through `ReconcileComment` on
 * `OutcomeUnknownError` — T061) to the queue a comment lands on once `create-reply.ts` /
 * `create-top-level-comment.ts` enqueue it. This file constructs the use case from the same ports
 * `publish-comment.integration.test.ts` builds it from (`buildPublishComment` there), plus a
 * platform-keyed adapter registry: `getAdapter` is `PublishComment`'s only way to reach a
 * concrete adapter (Principle IV — no platform branching in a use case), and the registry below is
 * a `Record`, not a `switch`, for the same reason.
 *
 * **The comment id comes from `job.id`, never `job.data`.** Spec §7.1 step 4 fixes
 * `jobId = comment.id` as the one thing every producer of this queue must do (the accept path and
 * the stuck-work sweeper alike); relying on that instead of a `job.data.commentId` field decouples
 * this worker from whatever shape a producer happens to attach as payload.
 *
 * **Per-account token bucket, not BullMQ's built-in limiter.** BullMQ's `limiter` option throttles
 * the whole queue; grouping a rate limit per key (per `social_account_id` here) is a Pro-only
 * feature. This worker implements a plain token bucket in Redis instead — one hash per account,
 * refilled lazily on each check via a Lua script so concurrent workers never read-then-write a
 * stale token count. When a job finds the bucket empty it does not fail or consume a retry
 * attempt: it calls `job.moveToDelayed` and throws `DelayedError`, BullMQ's documented way to
 * reschedule a job from inside its own processor without touching `attemptsMade`. Spike S4
 * (spec.md §17) measured the Bluesky side of the bucket's numbers; the Meta side is still a
 * conservative placeholder, since S1/S2 answered what Meta *returns*, not how often it may be
 * written to.
 *
 * **`publish()` returns a `PublishOutcome`, this worker does no arithmetic of its own.** The
 * `'retry'` outcome carries a `delayMs` the use case already computed as the longer of the
 * backoff ladder (1s/4s/16s/64s/256s) and the platform's `Retry-After` (§7.1 step 6) — this file
 * only calls `moveToDelayed` with it. Two independent reasons can move a job to `delayed`: our
 * own token bucket being empty, and the use case answering `'retry'`. Both use the same BullMQ
 * mechanism, so the log line is what keeps them distinguishable — "this account is saturated"
 * (ours) and "the platform said to back off" (theirs) call for a different response from whoever
 * reads the logs (A22: logs are the whole observability surface here), so each path logs under a
 * different message and a `reason` field rather than sharing one line.
 */

// oxlint-disable max-dependencies -- this worker wires every port `PublishComment` needs (the
// repository, contact quota, account health, the three platform adapters), plus BullMQ and the
// token-bucket primitives; splitting the file would not reduce that, only hide it behind re-exports.
// oxlint-disable max-lines -- the same reasoning: one worker, its Lua token bucket and the two
// independent reasons it delays a job (our own bucket, and Meta's reported usage, §8.2). Each is
// already its own named function; moving them apart would separate the bucket from its only
// caller rather than remove anything.

import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DelayedError, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { Config } from '#src/app/config.ts';
import {
  createPublishComment,
  type PublishOutcome,
} from '#src/modules/comments/application/publish-comment.ts';
import { createAccountHealth } from '#src/modules/comments/infrastructure/account-health.ts';
import { createCommentRepository } from '#src/modules/comments/infrastructure/comment-repository.ts';
import { createContactQuota } from '#src/modules/comments/infrastructure/contact-quota.ts';
import { comments } from '#src/modules/comments/infrastructure/schema.ts';
import { createBlueskyAdapter } from '#src/platforms/bluesky/adapter.ts';
import { createFacebookAdapter } from '#src/platforms/meta/facebook-adapter.ts';
import { createInstagramAdapter } from '#src/platforms/meta/instagram-adapter.ts';
import type { GraphUsage } from '#src/platforms/meta/graph-client.ts';
import {
  readGraphUsage,
  recordGraphUsage,
  usageDelayMs,
} from '#src/modules/comments/infrastructure/graph-usage.ts';
import type { AccountCredentials, Accounts, Workspaces } from '#src/modules/platform-core/ports.ts';
import type { CommentPlatformAdapter, Platform } from '#src/platforms/types.ts';
import { forJob } from '#src/shared/logger.ts';
import { QUEUE_NAMES } from '#src/shared/queues.ts';

/** Global BullMQ concurrency; the per-account bucket below is the real limiter. */
const WORKER_CONCURRENCY = 10;

const BUCKET_KEY_PREFIX = 'publish-worker:bucket:';
/** Max burst per account before the bucket must refill. */
const BUCKET_CAPACITY = 2;
/**
 * Sustained rate per account once the burst is spent — one publish every four seconds.
 *
 * Set from spike S4 (spec.md §17, which carries the arithmetic): Bluesky allows 1,666 record
 * creates an hour per DID, and the previous placeholder of 0.5/s allowed 1,800 — over the ceiling.
 * 0.25/s is 900 an hour. The separate daily ceiling is deliberately unguarded: a bucket sized for
 * it would throttle an ordinary day's bursts, and crossing it degrades to a `429` carrying
 * `Retry-After`, which `PublishOutcome`'s `delayMs` already honours (§7.1 step 6).
 */
const BUCKET_REFILL_PER_SECOND = 0.25;
/** Idle accounts' bucket rows expire instead of accumulating forever in Redis. */
const BUCKET_TTL_SECONDS = 120;

/**
 * Lazily refills `KEYS[1]` by elapsed time, then takes one token if available.
 *
 * `HMGET`/`HMSET` inside one `EVAL` is what keeps "read the bucket, compute, write it back"
 * atomic across concurrent workers checking the same account — two workers racing on the same
 * key never both see the pre-refill token count.
 */
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

/**
 * The account a queued comment belongs to, read directly rather than through
 * `CommentRepository` — every repository method is workspace-scoped (D20), but the worker has
 * only the `commentId` `job.id` carries and no workspace to scope by yet. `PublishComment` does
 * its own workspace-scoped work once it loads the comment; this is only for the bucket key.
 */
async function loadSocialAccountId(db: NodePgDatabase, commentId: string): Promise<string | null> {
  const [row] = await db
    .select({ socialAccountId: comments.socialAccountId })
    .from(comments)
    .where(eq(comments.id, commentId))
    .limit(1);
  return row?.socialAccountId ?? null;
}

/**
 * Builds the `platform -> adapter` lookup `PublishComment.getAdapter` needs. A `Record`, not a
 * `switch`, keeps platform dispatch data-driven (Principle IV) — the same shape `registry.ts`
 * already uses for capabilities.
 */
function buildAdapterRegistry(
  config: Config,
  onUsage: (socialAccountId: string, usage: GraphUsage) => void,
): (platform: Platform) => CommentPlatformAdapter {
  const adapters: Partial<Record<Platform, CommentPlatformAdapter>> = {
    instagram: createInstagramAdapter({ apiVersion: config.META_GRAPH_API_VERSION, onUsage }),
    facebook: createFacebookAdapter({ apiVersion: config.META_GRAPH_API_VERSION, onUsage }),
    bluesky: createBlueskyAdapter({ threadDepth: config.BLUESKY_THREAD_DEPTH }),
  };

  return (platform: Platform): CommentPlatformAdapter => {
    const adapter = adapters[platform];
    if (adapter === undefined) {
      throw new Error(`publish-worker: no adapter registered for platform "${platform}"`);
    }
    return adapter;
  };
}

/**
 * Moves `job` to `delayed` and throws `DelayedError` — BullMQ's documented way for a processor to
 * reschedule itself without spending a retry attempt (`attemptsMade` untouched). Shared by the two
 * independent reasons this worker delays a job: the token bucket being empty (ours) and the use
 * case answering `'retry'` (the platform's `Retry-After` or our own backoff ladder, §7.1 step 6) —
 * `reason` keeps those distinguishable in the log line, per A22 (logs are the whole observability
 * surface here).
 */
async function delayJob(
  job: Job,
  token: string | undefined,
  delayMs: number,
  jobLogger: Logger,
  reason: 'account-rate-limited' | 'platform-retry' | 'platform-usage-high',
  extra: Record<string, unknown>,
): Promise<never> {
  if (token === undefined) {
    throw new Error(`publish-worker: missing lock token, cannot delay for ${reason}`);
  }
  jobLogger.debug({ reason, delayMs, ...extra }, 'publish-worker: delaying job');
  await job.moveToDelayed(Date.now() + delayMs, token);
  throw new DelayedError();
}

/** Branches on `PublishOutcome` — the worker does no arithmetic, only what each `kind` dictates. */
async function applyOutcome(
  outcome: PublishOutcome,
  job: Job,
  token: string | undefined,
  jobLogger: Logger,
): Promise<void> {
  switch (outcome.kind) {
    case 'posted':
      jobLogger.info('publish-worker: comment posted');
      return;
    case 'failed':
      jobLogger.info({ code: outcome.code }, 'publish-worker: comment failed terminally');
      return;
    case 'skipped':
      // Another worker already moved this comment — a conditional UPDATE lost the race. Normal,
      // not an error (D14, Principle III): nothing to retry, nothing to log above debug.
      jobLogger.debug('publish-worker: transition lost the race, skipping');
      return;
    case 'retry':
      await delayJob(job, token, outcome.delayMs, jobLogger, 'platform-retry', {
        attempt: outcome.attempt,
      });
      return;
    default: {
      const exhaustive: never = outcome;
      throw new Error(`publish-worker: unknown publish outcome ${JSON.stringify(exhaustive)}`);
    }
  }
}

export interface PublishWorkerDeps {
  readonly database: NodePgDatabase;
  readonly redis: Redis;
  readonly config: Config;
  readonly workspaces: Workspaces;
  readonly accounts: Accounts;
  readonly accountCredentials: AccountCredentials;
  readonly logger: Logger;
}

/**
 * Creates and starts the `comment-publish` worker.
 *
 * Args:
 *   deps: The database handle, the Redis connection BullMQ and the token bucket share, config
 *     (for the Meta Graph API version), the platform-core ports `PublishComment` needs, and a
 *     logger to stamp each job's id onto.
 *
 * Returns:
 *   The running `Worker`. The caller owns its lifecycle (`close()` on shutdown).
 */
function buildPublishComment(deps: PublishWorkerDeps): ReturnType<typeof createPublishComment> {
  return createPublishComment({
    database: deps.database,
    commentRepository: createCommentRepository(deps.database),
    contactQuota: createContactQuota(deps.database, deps.workspaces),
    accounts: deps.accounts,
    accountCredentials: deps.accountCredentials,
    accountHealth: createAccountHealth(deps.database),
    getAdapter: buildAdapterRegistry(deps.config, (socialAccountId, usage) => {
      // Fire-and-forget by design: recording is advisory, and awaiting it inside an adapter call
      // would put a Redis round trip on the publish path for a hint. `recordGraphUsage` never
      // rejects, so there is no floating rejection here.
      void recordGraphUsage(deps.redis, socialAccountId, usage.highestPercent);
    }),
  });
}

export function createPublishWorker(deps: PublishWorkerDeps): Worker {
  const publishComment = buildPublishComment(deps);

  return new Worker(
    QUEUE_NAMES.commentPublish,
    async (job: Job, token?: string): Promise<void> => {
      const commentId = job.id;
      if (commentId === undefined) {
        throw new Error('publish-worker: job has no id (jobId must be the comment id)');
      }
      const jobLogger = forJob(deps.logger, commentId);

      const socialAccountId = await loadSocialAccountId(deps.database, commentId);
      if (socialAccountId === null) {
        // Nothing to publish and nothing to retry. A soft-deleted comment (FR-030 nulls fields,
        // it does not remove the row — `purge-retention.ts` is the only hard delete, and only
        // after the retention window, long after any pending publish job) still has a row here,
        // so a missing row means a stale or malformed jobId, not a race worth reconciling.
        jobLogger.warn('publish-worker: comment not found, skipping');
        return;
      }

      // Meta's own view of how hard this account is being worked (spec.md §8.2). Checked before
      // the token bucket because it is the platform's limit rather than ours, and spending a
      // token on a call Meta is about to throttle helps nobody.
      const usageDelay = usageDelayMs(
        await readGraphUsage(deps.redis, socialAccountId),
        deps.config,
      );
      if (usageDelay > 0) {
        await delayJob(job, token, usageDelay, jobLogger, 'platform-usage-high', {
          socialAccountId,
        });
      }

      const bucket = await tryAcquireToken(deps.redis, socialAccountId);
      if (!bucket.allowed) {
        await delayJob(job, token, bucket.retryAfterMs, jobLogger, 'account-rate-limited', {});
      }

      const outcome = await publishComment.publish(commentId);
      await applyOutcome(outcome, job, token, jobLogger);
    },
    { connection: deps.redis, concurrency: WORKER_CONCURRENCY },
  );
}
