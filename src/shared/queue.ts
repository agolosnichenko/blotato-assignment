import { Redis } from 'ioredis';
import { Queue, type JobsOptions } from 'bullmq';
import type { Config } from '#src/app/config.ts';
import { createLogger } from '#src/shared/logger.ts';
import type { QueueName } from '#src/shared/queues.ts';

/**
 * Bounds how long BullMQ keeps a completed/failed job's Redis hash (C1, I4).
 *
 * Two problems share this one fix. First, §9.2 mandates `maxmemory-policy noeviction`, so with no
 * queue ever configuring `removeOnComplete`/`removeOnFail` every job this service has ever run
 * stays in Redis forever — the endpoint of that growth is every Redis write failing (publishing,
 * rate limiting, locks, all four queues at once), not degraded performance. Second, and sharper:
 * `Queue.add` with an explicit `jobId` that already names a retained job — any state, including
 * completed/failed — does not re-queue. BullMQ's `addStandardJob` Lua script treats an existing
 * job key as a duplicate and resolves the caller's promise without moving anything back to `wait`.
 * Both sweepers in `sweepers.ts` reuse the same stable entity id (`comment.id`, `delivery.id`) the
 * accept path used for its own job, which is legitimate idempotency for *that* job — but once it
 * settles and is retained, every later re-enqueue attempt for the same entity is a silent no-op for
 * as long as the key survives. Bounding retention closes that window once a job ages out; it does
 * not close the window *inside* the retention period, which is why `sweepers.ts` also checks a
 * retained job's state before re-adding rather than relying on this alone.
 *
 * The bounds themselves: a generous hour/1000-job window for completed jobs (room to inspect a
 * recently-finished job in the BullMQ dashboard or via `getJob`), a day for failed ones (room to
 * notice and investigate before the evidence is gone).
 */
/**
 * How many times BullMQ retries a job whose processor threw.
 *
 * This is *not* the publish path's retry ladder: that one is the use case's own (§7.1 step 6), and
 * it reaches BullMQ through `moveToDelayed` + `DelayedError`, which deliberately leaves
 * `attemptsMade` untouched (`publish-worker.ts`). What this covers is the other kind of failure —
 * the processor itself throwing, on a dropped database connection or a transient Redis error.
 * BullMQ's own default is a single attempt, so before this every such throw was terminal, and
 * `webhook-worker.ts`'s "BullMQ retries the job under its own backoff" described a retry that did
 * not exist. The sweepers remain the backstop for what even these attempts do not recover.
 */
const JOB_ATTEMPTS = 3;
const JOB_BACKOFF_MS = 5000;

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 86400 },
  attempts: JOB_ATTEMPTS,
  backoff: { type: 'exponential', delay: JOB_BACKOFF_MS },
};

/**
 * Creates the Redis connection shared by BullMQ queues and workers.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ: blocking commands must wait instead of
 * failing after a fixed number of retries.
 *
 * Attaches an `'error'` listener here, in the one factory every role calls, rather than in either
 * role separately (C2): an ioredis client that emits `'error'` with no listener raises an
 * unhandled-error exception and kills the process — so without this, a Railway Redis restart or a
 * transient network reset crash-loops whichever role has no listener of its own, which on this
 * branch was every role except `api` (and `api`'s own listener, in `registerRateLimit`, logs a
 * rate-limit-specific message — it does not change the fact that this listener needs to exist
 * centrally so *no* role can ship without one).
 */
export function createRedis(config: Config): Redis {
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const logger = createLogger(config, { component: 'redis' });
  redis.on('error', (error: Error) => {
    logger.warn({ err: error }, 'redis connection error');
  });
  return redis;
}

/**
 * Creates a BullMQ `Queue` with this service's shared defaults (C1, C2, I4): bounded job
 * retention ({@link DEFAULT_JOB_OPTIONS}) and an `'error'` listener, so every queue this service
 * constructs gets both without each call site repeating them. Centralizing this is what makes "a
 * queue someone adds later forgets the retention bound" impossible by construction rather than by
 * convention.
 */
export function createQueue(name: QueueName, config: Config, connection: Redis): Queue {
  const queue = new Queue(name, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
  const logger = createLogger(config, { component: 'queue', queue: name });
  queue.on('error', (error: Error) => {
    logger.error({ err: error }, 'queue error');
  });
  return queue;
}
