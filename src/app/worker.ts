import { pathToFileURL } from 'node:url';
import { Queue, Worker } from 'bullmq';
import { buildContainer, type Container } from '#src/app/container.ts';
import { createPublishWorker } from '#src/modules/comments/infrastructure/publish-worker.ts';
import { createStuckWorkSweeper } from '#src/modules/comments/infrastructure/sweepers.ts';
import { createLogger } from '#src/shared/logger.ts';
import type { Logger } from 'pino';
import { QUEUE_NAMES } from '#src/shared/queues.ts';

const SWEEP_STUCK_WORK_JOB = 'sweep-stuck-work';
const SWEEP_INTERVAL_MS = 60_000;

/**
 * Dispatches one `scheduler` queue job by name. Every job this queue will ever carry (this
 * sweeper today; the sync scheduler, the outbox relay and the purge job in later tasks) is added
 * here rather than as a separate `Worker`, because **`scheduler` runs at concurrency 1** — a
 * second `Worker` instance on the same queue would defeat that regardless of its own concurrency
 * setting. `FOR UPDATE SKIP LOCKED` (outbox relay) and `jobId = comment.id` (this sweeper) stop a
 * second runner from corrupting data, but not from doubling work a first runner already selected
 * and has not yet stamped — concurrency 1 is what actually keeps "published once" and "swept
 * once" true (D14, §9.2).
 */
async function processSchedulerJob(
  jobName: string | undefined,
  sweeper: ReturnType<typeof createStuckWorkSweeper>,
): Promise<void> {
  switch (jobName) {
    case SWEEP_STUCK_WORK_JOB:
      await sweeper.sweep();
      return;
    default:
      throw new Error(`worker: unknown scheduler job "${String(jobName)}"`);
  }
}

interface Runtime {
  readonly publishWorker: Worker;
  readonly schedulerWorker: Worker;
  readonly publishQueue: Queue;
  readonly schedulerQueue: Queue;
}

/** Builds and starts every BullMQ worker and queue this role owns. */
function buildRuntime(container: Container, logger: Logger): Runtime {
  const publishQueue = new Queue(QUEUE_NAMES.commentPublish, { connection: container.redis });
  const schedulerQueue = new Queue(QUEUE_NAMES.scheduler, { connection: container.redis });

  const publishWorker = createPublishWorker({
    database: container.database.drizzle,
    redis: container.redis,
    config: container.config,
    workspaces: container.ports.workspaces,
    accounts: container.ports.accounts,
    accountCredentials: container.ports.accountCredentials,
    logger,
  });

  const sweeper = createStuckWorkSweeper({
    database: container.database.drizzle,
    publishQueue,
  });

  const schedulerWorker = new Worker(
    QUEUE_NAMES.scheduler,
    (job) => processSchedulerJob(job.name, sweeper),
    { connection: container.redis, concurrency: 1 },
  );

  return { publishWorker, schedulerWorker, publishQueue, schedulerQueue };
}

async function shutdown(runtime: Runtime, container: Container, logger: Logger): Promise<void> {
  logger.info('shutting down');
  await Promise.all([
    runtime.publishWorker.close(),
    runtime.schedulerWorker.close(),
    runtime.publishQueue.close(),
    runtime.schedulerQueue.close(),
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
