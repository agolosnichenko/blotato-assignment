// oxlint-disable max-dependencies -- this is the worker role's composition point for every
// `scheduler`-queue job (the two sweepers, the sync scheduler, the retention purge) plus the
// `comment-publish`/`comment-sync` workers; each job's own constructor is a separate import by
// design (§4.2), so the count rises whenever a job is added here rather than indicating the file
// itself has grown unfocused.

import { pathToFileURL } from 'node:url';
import { Queue, Worker } from 'bullmq';
import { buildContainer, type Container } from '#src/app/container.ts';
import { createPurgeRetention } from '#src/modules/comments/application/purge-retention.ts';
import { relayOutboxBatch } from '#src/modules/comments/infrastructure/outbox-relay.ts';
import { createPublishWorker } from '#src/modules/comments/infrastructure/publish-worker.ts';
import {
  createSyncScheduler,
  createSyncWorker,
  type SyncScheduler,
} from '#src/modules/comments/infrastructure/sync-scheduler.ts';
import { createSyncTargetRepository } from '#src/modules/comments/infrastructure/sync-target-repository.ts';
import { createStuckWorkSweeper } from '#src/modules/comments/infrastructure/sweepers.ts';
import { createLogger } from '#src/shared/logger.ts';
import type { Logger } from 'pino';
import { QUEUE_NAMES } from '#src/shared/queues.ts';

const SWEEP_STUCK_WORK_JOB = 'sweep-stuck-work';
const SWEEP_INTERVAL_MS = 60_000;
const SYNC_SCHEDULER_TICK_JOB = 'sync-due-targets';
const SYNC_SCHEDULER_TICK_INTERVAL_MS = 60_000;
const PURGE_RETENTION_JOB = 'purge-retention';
const PURGE_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Events are at-least-once by contract (D9) and the outbox is the only record of truth for them;
// this relay is the one thing draining it, so this interval is the latency floor between a use
// case committing a domain event and an external consumer seeing it. 10s keeps that floor well
// under human-perceptible "instant" for a webhook-ish consumer without running the relay's own
// `SELECT ... FOR UPDATE SKIP LOCKED` transaction (BATCH_SIZE 100) more often than the database
// needs to be asked — the other three scheduler jobs all poll once a minute or slower because
// their own work is not event delivery.
const OUTBOX_RELAY_JOB = 'relay-outbox';
const OUTBOX_RELAY_INTERVAL_MS = 10_000;

/**
 * Dispatches one `scheduler` queue job by name. Every job this queue carries (the two sweepers,
 * the sync scheduler tick, the retention purge, the outbox relay) is added here rather than as a
 * separate `Worker`, because **`scheduler` runs at concurrency 1** — a second `Worker` instance on
 * the same queue would defeat that regardless of its own concurrency setting. `FOR UPDATE SKIP
 * LOCKED` (the outbox relay, the sync scheduler tick) and `jobId = comment.id` (the stuck-work
 * sweeper) stop a second runner from corrupting data, but not from doubling work a first runner
 * already selected and has not yet stamped — concurrency 1 is what actually keeps "published
 * once", "swept once" and "relayed once" true (D14, §9.2, outbox-relay.ts's own docstring).
 */
async function processSchedulerJob(
  jobName: string | undefined,
  sweeper: ReturnType<typeof createStuckWorkSweeper>,
  syncScheduler: SyncScheduler,
  purgeRetention: ReturnType<typeof createPurgeRetention>,
  database: Container['database'],
  domainEventsQueue: Queue,
): Promise<void> {
  switch (jobName) {
    case SWEEP_STUCK_WORK_JOB:
      await sweeper.sweep();
      return;
    case SYNC_SCHEDULER_TICK_JOB:
      await syncScheduler.tick();
      return;
    case PURGE_RETENTION_JOB:
      await purgeRetention.run();
      return;
    case OUTBOX_RELAY_JOB:
      await relayOutboxBatch(database, domainEventsQueue);
      return;
    default:
      throw new Error(`worker: unknown scheduler job "${String(jobName)}"`);
  }
}

interface Runtime {
  readonly publishWorker: Worker;
  readonly syncWorker: Worker;
  readonly schedulerWorker: Worker;
  readonly publishQueue: Queue;
  readonly syncQueue: Queue;
  readonly schedulerQueue: Queue;
  readonly domainEventsQueue: Queue;
}

interface SchedulerJobDeps {
  readonly sweeper: ReturnType<typeof createStuckWorkSweeper>;
  readonly syncScheduler: SyncScheduler;
  readonly purgeRetention: ReturnType<typeof createPurgeRetention>;
}

/** Builds the four jobs `schedulerWorker` dispatches between — see `processSchedulerJob`. */
function buildSchedulerJobDeps(container: Container, syncQueue: Queue): SchedulerJobDeps {
  const sweeper = createStuckWorkSweeper({
    database: container.database.drizzle,
    publishQueue: container.publishQueue,
  });
  const syncScheduler = createSyncScheduler({ database: container.database.drizzle, syncQueue });
  const purgeRetention = createPurgeRetention({
    database: container.database.drizzle,
    retentionDays: container.config.RETENTION_DAYS,
  });
  return { sweeper, syncScheduler, purgeRetention };
}

/** The `comment-publish` and `comment-sync` workers — the two non-`scheduler` queues this role runs. */
function buildQueueWorkers(
  container: Container,
  logger: Logger,
): { publishWorker: Worker; syncWorker: Worker } {
  const publishWorker = createPublishWorker({
    database: container.database.drizzle,
    redis: container.redis,
    config: container.config,
    workspaces: container.ports.workspaces,
    accounts: container.ports.accounts,
    accountCredentials: container.ports.accountCredentials,
    logger,
  });

  // `container.config` carries every `SyncIntervalsConfig` field (plus others this repository
  // does not read) — see `src/app/config.ts`'s `SYNC_INTERVALS_*`/`RETENTION_DAYS` keys.
  const syncTargetRepository = createSyncTargetRepository(
    container.database.drizzle,
    container.config,
  );
  const syncWorker = createSyncWorker({
    database: container.database.drizzle,
    redis: container.redis,
    config: container.config,
    accounts: container.ports.accounts,
    accountCredentials: container.ports.accountCredentials,
    syncTargetRepository,
    logger,
  });

  return { publishWorker, syncWorker };
}

/** Builds and starts every BullMQ worker this role owns, on the container's queues. */
function buildRuntime(container: Container, logger: Logger): Runtime {
  const publishQueue = container.publishQueue;
  const syncQueue = container.syncQueue;
  const schedulerQueue = new Queue(QUEUE_NAMES.scheduler, { connection: container.redis });
  // Delivery only (D9, outbox-relay.ts's docstring) — losing Redis loses no data, since the
  // outbox row stays unpublished and the next relay pass republishes it.
  const domainEventsQueue = new Queue(QUEUE_NAMES.domainEvents, { connection: container.redis });

  const { publishWorker, syncWorker } = buildQueueWorkers(container, logger);
  const { sweeper, syncScheduler, purgeRetention } = buildSchedulerJobDeps(container, syncQueue);
  const schedulerWorker = new Worker(
    QUEUE_NAMES.scheduler,
    (job) =>
      processSchedulerJob(
        job.name,
        sweeper,
        syncScheduler,
        purgeRetention,
        container.database,
        domainEventsQueue,
      ),
    { connection: container.redis, concurrency: 1 },
  );

  return {
    publishWorker,
    syncWorker,
    schedulerWorker,
    publishQueue,
    syncQueue,
    schedulerQueue,
    domainEventsQueue,
  };
}

async function shutdown(runtime: Runtime, container: Container, logger: Logger): Promise<void> {
  logger.info('shutting down');
  // `runtime.publishQueue`/`runtime.syncQueue` are `container.publishQueue`/`container.syncQueue`
  // (see `buildRuntime`) — `container.close()` below closes both, so neither is closed twice.
  await Promise.all([
    runtime.publishWorker.close(),
    runtime.syncWorker.close(),
    runtime.schedulerWorker.close(),
    runtime.schedulerQueue.close(),
    runtime.domainEventsQueue.close(),
  ]);
  await container.close();
}

async function main(): Promise<void> {
  const container = buildContainer();
  const logger = createLogger(container.config, { role: 'worker' });

  await container.database.ping();
  await container.redis.ping();

  const runtime = buildRuntime(container, logger);
  // `upsertJobScheduler`, not `add` with a `repeat` option — BullMQ 6 moved repeatable jobs to a
  // dedicated scheduler API; `add`'s `JobsOptions` no longer accepts `repeat` at all.
  await runtime.schedulerQueue.upsertJobScheduler(SWEEP_STUCK_WORK_JOB, {
    every: SWEEP_INTERVAL_MS,
  });
  await runtime.schedulerQueue.upsertJobScheduler(SYNC_SCHEDULER_TICK_JOB, {
    every: SYNC_SCHEDULER_TICK_INTERVAL_MS,
  });
  await runtime.schedulerQueue.upsertJobScheduler(PURGE_RETENTION_JOB, {
    every: PURGE_RETENTION_INTERVAL_MS,
  });
  await runtime.schedulerQueue.upsertJobScheduler(OUTBOX_RELAY_JOB, {
    every: OUTBOX_RELAY_INTERVAL_MS,
  });

  logger.info('worker ready');

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void shutdown(runtime, container, logger);
    });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
