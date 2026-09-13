// oxlint-disable max-dependencies -- this is the worker role's composition point for every
// `scheduler`-queue job (the stuck-work sweeper, the webhook-delivery sweeper, the sync scheduler,
// the retention purge, the outbox relay, the domain-events trim) plus the
// `comment-publish`/`comment-sync`/`webhook-process` workers; each job's own constructor is a
// separate import by design (§4.2), so the count rises whenever a job is added here rather than
// indicating the file itself has grown unfocused.
// oxlint-disable max-lines -- same reasoning: this file's length tracks the number of scheduler
// jobs and worker roles it composes (six jobs, three queue-workers), each already factored into
// its own named constructor; splitting it would hide the wiring behind re-exports rather than
// remove any of it (mirrors `src/app/api.ts`'s own exemption).

import { pathToFileURL } from 'node:url';
import { Worker, type Queue } from 'bullmq';
import { buildContainer, type Container } from '#src/app/container.ts';
import { createIngestComments } from '#src/modules/comments/application/ingest-comments.ts';
import { createPurgeRetention } from '#src/modules/comments/application/purge-retention.ts';
import { createDomainEventsTrim } from '#src/modules/comments/infrastructure/domain-events-trim.ts';
import { relayOutboxBatch } from '#src/modules/comments/infrastructure/outbox-relay.ts';
import { createPublishWorker } from '#src/modules/comments/infrastructure/publish-worker.ts';
import {
  createSyncScheduler,
  createSyncWorker,
  type SyncScheduler,
} from '#src/modules/comments/infrastructure/sync-scheduler.ts';
import { createSyncTargetRepository } from '#src/modules/comments/infrastructure/sync-target-repository.ts';
import {
  createStuckWorkSweeper,
  createWebhookDeliverySweeper,
} from '#src/modules/comments/infrastructure/sweepers.ts';
import { createWebhookWorker } from '#src/modules/comments/infrastructure/webhook-worker.ts';
import { createMetaWebhookNormalizer } from '#src/platforms/meta/webhook-normalizer.ts';
import { createLogger } from '#src/shared/logger.ts';
import type { Logger } from 'pino';
import { createQueue } from '#src/shared/queue.ts';
import { QUEUE_NAMES } from '#src/shared/queues.ts';

const SWEEP_STUCK_WORK_JOB = 'sweep-stuck-work';
const SWEEP_INTERVAL_MS = 60_000;
/** §7.2 step 5: the threshold itself (5 minutes) lives in `sweepers.ts`; this tick only decides
 * how often to check for it, same cadence as the stuck-work sweeper. */
const SWEEP_WEBHOOK_DELIVERIES_JOB = 'sweep-webhook-deliveries';
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
/** Hourly, matching the TTL's own unit (spec.md §18, "domain-events is trimmed on a schedule") —
 * no data is at risk between runs (Postgres is authoritative), so there is no reason to poll more
 * often than the TTL resolution itself. */
const TRIM_DOMAIN_EVENTS_JOB = 'trim-domain-events';
const TRIM_DOMAIN_EVENTS_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Dispatches one `scheduler` queue job by name. Every job this queue carries (the stuck-work
 * sweeper, the webhook-delivery sweeper, the sync scheduler tick, the retention purge, the outbox
 * relay) is added here rather than as a separate `Worker`, because **`scheduler` runs at
 * concurrency 1** — a second `Worker` instance on the same queue would defeat that regardless of
 * its own concurrency setting. `FOR UPDATE SKIP LOCKED` (the outbox relay, the sync scheduler
 * tick) and `jobId = comment.id` / `jobId = delivery.id` (the two sweepers) stop a second runner
 * from corrupting data, but not from doubling work a first runner already selected and has not yet
 * stamped — concurrency 1 is what actually keeps "published once", "swept once" and "relayed once"
 * true (D14, §9.2, outbox-relay.ts's own docstring).
 */
async function processSchedulerJob(
  jobName: string | undefined,
  jobDeps: SchedulerJobDeps,
  database: Container['database'],
  domainEventsQueue: Queue,
): Promise<void> {
  switch (jobName) {
    case SWEEP_STUCK_WORK_JOB:
      await jobDeps.sweeper.sweep();
      return;
    case SWEEP_WEBHOOK_DELIVERIES_JOB:
      await jobDeps.webhookDeliverySweeper.sweep();
      return;
    case SYNC_SCHEDULER_TICK_JOB:
      await jobDeps.syncScheduler.tick();
      return;
    case PURGE_RETENTION_JOB:
      await jobDeps.purgeRetention.run();
      return;
    case OUTBOX_RELAY_JOB:
      await relayOutboxBatch(database, domainEventsQueue);
      return;
    case TRIM_DOMAIN_EVENTS_JOB:
      await jobDeps.domainEventsTrim.run();
      return;
    default:
      throw new Error(`worker: unknown scheduler job "${String(jobName)}"`);
  }
}

interface Runtime {
  readonly publishWorker: Worker;
  readonly syncWorker: Worker;
  readonly webhookWorker: Worker;
  readonly schedulerWorker: Worker;
  readonly publishQueue: Queue;
  readonly syncQueue: Queue;
  readonly webhookQueue: Queue;
  readonly schedulerQueue: Queue;
  readonly domainEventsQueue: Queue;
}

interface SchedulerJobDeps {
  readonly sweeper: ReturnType<typeof createStuckWorkSweeper>;
  readonly webhookDeliverySweeper: ReturnType<typeof createWebhookDeliverySweeper>;
  readonly syncScheduler: SyncScheduler;
  readonly purgeRetention: ReturnType<typeof createPurgeRetention>;
  readonly domainEventsTrim: ReturnType<typeof createDomainEventsTrim>;
}

/** Builds the six jobs `schedulerWorker` dispatches between — see `processSchedulerJob`. */
function buildSchedulerJobDeps(
  container: Container,
  syncQueue: Queue,
  webhookQueue: Queue,
  domainEventsQueue: Queue,
  logger: Logger,
): SchedulerJobDeps {
  const sweeper = createStuckWorkSweeper({
    database: container.database.drizzle,
    publishQueue: container.publishQueue,
    logger,
  });
  const webhookDeliverySweeper = createWebhookDeliverySweeper({
    database: container.database.drizzle,
    webhookQueue,
    logger,
  });
  const syncScheduler = createSyncScheduler({ database: container.database.drizzle, syncQueue });
  const purgeRetention = createPurgeRetention({
    database: container.database.drizzle,
    retentionDays: container.config.RETENTION_DAYS,
  });
  const domainEventsTrim = createDomainEventsTrim({
    domainEventsQueue,
    ttlHours: container.config.DOMAIN_EVENTS_TTL_HOURS,
    logger,
  });
  return { sweeper, webhookDeliverySweeper, syncScheduler, purgeRetention, domainEventsTrim };
}

/** Builds the `webhook-process` worker (T081) — `IngestComments` wired the same way
 * `sync-post.ts` wires it (same `syncTargetRepository`, same database handle), plus the Meta
 * normalizer and the two platform-core ports it needs to resolve an `AccountContext`. */
function buildWebhookWorker(container: Container, logger: Logger): Worker {
  const syncTargetRepository = createSyncTargetRepository(
    container.database.drizzle,
    container.config,
  );
  const ingestComments = createIngestComments({
    database: container.database.drizzle,
    syncTargetRepository,
  });

  return createWebhookWorker({
    database: container.database.drizzle,
    redis: container.redis,
    config: container.config,
    accounts: container.ports.accounts,
    accountCredentials: container.ports.accountCredentials,
    ingestComments,
    normalizer: createMetaWebhookNormalizer(),
    logger,
  });
}

/** The `comment-publish` and `comment-sync` workers — two of the three non-`scheduler` queues this
 * role runs (the third, `webhook-process`, is {@link buildWebhookWorker}). */
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

/** Logs every job failure and connection-level error a `Worker` emits (C2) — without these,
 * a failure disappears into BullMQ's failed set with no log line, and an unhandled `'error'`
 * event is an uncaught exception that kills the process; this is why C1 went unnoticed. */
function attachWorkerObservability(worker: Worker, logger: Logger): void {
  worker.on('failed', (job, error) => {
    logger.error(
      { jobId: job?.id, jobName: job?.name, attemptsMade: job?.attemptsMade, err: error },
      'job failed',
    );
  });
  worker.on('error', (error: Error) => {
    logger.error({ err: error }, 'worker error');
  });
}

/** Builds and starts every BullMQ worker this role owns, on the container's queues. */
function buildRuntime(container: Container, logger: Logger): Runtime {
  const { config, redis, publishQueue, syncQueue } = container;
  const webhookQueue = createQueue(QUEUE_NAMES.webhookProcess, config, redis);
  const schedulerQueue = createQueue(QUEUE_NAMES.scheduler, config, redis);
  // Delivery only (D9, outbox-relay.ts's docstring) — losing Redis loses no data, since the
  // outbox row stays unpublished and the next relay pass republishes it.
  const domainEventsQueue = createQueue(QUEUE_NAMES.domainEvents, config, redis);

  const { publishWorker, syncWorker } = buildQueueWorkers(container, logger);
  const webhookWorker = buildWebhookWorker(container, logger);
  const jobDeps = buildSchedulerJobDeps(
    container,
    syncQueue,
    webhookQueue,
    domainEventsQueue,
    logger,
  );
  const schedulerWorker = new Worker(
    QUEUE_NAMES.scheduler,
    (job) => processSchedulerJob(job.name, jobDeps, container.database, domainEventsQueue),
    { connection: container.redis, concurrency: 1 },
  );

  for (const worker of [publishWorker, syncWorker, webhookWorker, schedulerWorker]) {
    attachWorkerObservability(worker, logger);
  }

  return {
    publishWorker,
    syncWorker,
    webhookWorker,
    schedulerWorker,
    publishQueue,
    syncQueue,
    webhookQueue,
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
    runtime.webhookWorker.close(),
    runtime.schedulerWorker.close(),
    runtime.webhookQueue.close(),
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
  await runtime.schedulerQueue.upsertJobScheduler(SWEEP_WEBHOOK_DELIVERIES_JOB, {
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
  await runtime.schedulerQueue.upsertJobScheduler(TRIM_DOMAIN_EVENTS_JOB, {
    every: TRIM_DOMAIN_EVENTS_INTERVAL_MS,
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
