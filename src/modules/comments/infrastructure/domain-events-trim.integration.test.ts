/**
 * The `domain-events` trim job (spec.md §18, "`domain-events` is trimmed on a schedule in this
 * deployment").
 *
 * Property under test: a job older than the TTL is dropped from `wait`, a job inside the TTL is
 * left alone, and the dropped count the job logs matches what was actually removed — including
 * zero, the case a silent trim would hide (see `domain-events-trim.ts`'s own docstring).
 *
 * `domain-events` jobs are never processed in this deployment (D9: no consumer), so they never
 * reach `completed`/`failed` and BullMQ's own "job submission time" (`timestamp`) is the only age
 * signal `Queue.clean` has to work with. This file backdates that field directly on the job's Redis
 * hash via `queue.toKey(jobId)` — the same key BullMQ's own `clean` command reads — because nothing
 * in the public API lets a test simulate "added a while ago" any other way.
 */

import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '#src/app/config.ts';
import { createDomainEventsTrim } from '#src/modules/comments/infrastructure/domain-events-trim.ts';
import { createRedis } from '#src/shared/queue.ts';
import { QUEUE_NAMES } from '#src/shared/queues.ts';
import { startTestContainers, type TestContainers } from '#src/shared/testing/containers.ts';
import { TEST_ENV } from '#src/shared/testing/test-env.ts';

const ONE_HOUR_MS = 60 * 60 * 1000;
const TTL_HOURS = 24;

interface Harness {
  containers: TestContainers;
  redis: Redis;
  domainEventsQueue: Queue;
}

async function setupHarness(): Promise<Harness> {
  const containers = await startTestContainers();
  const config = loadConfig({
    ...TEST_ENV,
    LOG_LEVEL: 'silent',
    DATABASE_URL: containers.databaseUrl,
    REDIS_URL: containers.redisUrl,
  });
  const redis = createRedis(config);
  const domainEventsQueue = new Queue(QUEUE_NAMES.domainEvents, { connection: redis });
  return { containers, redis, domainEventsQueue };
}

async function teardownHarness(harness: Harness): Promise<void> {
  await harness.domainEventsQueue.close();
  harness.redis.disconnect();
  await harness.containers.stop();
}

/** Adds a job, then backdates its `timestamp` field directly on the Redis hash `Queue.clean`
 * reads — the only way to simulate "added `ageMs` ago" without waiting `ageMs` for real. */
async function seedJobWithAge(
  queue: Queue,
  redis: Redis,
  jobId: string,
  ageMs: number,
): Promise<void> {
  await queue.add('event', { type: 'test.event' }, { jobId });
  await redis.hset(queue.toKey(jobId), 'timestamp', String(Date.now() - ageMs));
}

let harness: Harness;

beforeAll(async () => {
  harness = await setupHarness();
});

afterAll(async () => {
  await teardownHarness(harness);
});

beforeEach(async () => {
  await harness.domainEventsQueue.obliterate({ force: true });
});

describe('drops only jobs older than the TTL', () => {
  it('removes a stale job and keeps a fresh one, logging the exact dropped count', async () => {
    const { domainEventsQueue, redis } = harness;
    await seedJobWithAge(domainEventsQueue, redis, 'stale', TTL_HOURS * ONE_HOUR_MS + ONE_HOUR_MS);
    await seedJobWithAge(domainEventsQueue, redis, 'fresh', ONE_HOUR_MS);
    const logger = { info: vi.fn() };

    await createDomainEventsTrim({ domainEventsQueue, ttlHours: TTL_HOURS, logger }).run();

    expect(await domainEventsQueue.getJob('stale')).toBeUndefined();
    expect(await domainEventsQueue.getJob('fresh')).toBeDefined();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ droppedCount: 1, ttlHours: TTL_HOURS }),
      expect.any(String),
    );
  });
});

describe('drops nothing when every job is inside the TTL', () => {
  it('logs a dropped count of zero rather than staying silent', async () => {
    const { domainEventsQueue, redis } = harness;
    await seedJobWithAge(domainEventsQueue, redis, 'recent-1', ONE_HOUR_MS);
    await seedJobWithAge(domainEventsQueue, redis, 'recent-2', 2 * ONE_HOUR_MS);
    const logger = { info: vi.fn() };

    // A TTL nothing qualifies under — a trim that removes everything regardless of age would
    // still pass a test that only checks "the stale job is gone".
    await createDomainEventsTrim({
      domainEventsQueue,
      ttlHours: TTL_HOURS * 100,
      logger,
    }).run();

    expect(await domainEventsQueue.getJob('recent-1')).toBeDefined();
    expect(await domainEventsQueue.getJob('recent-2')).toBeDefined();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ droppedCount: 0 }),
      expect.any(String),
    );
  });
});
