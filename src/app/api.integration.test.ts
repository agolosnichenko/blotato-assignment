// oxlint-disable max-dependencies -- this harness now builds the same dependency graph
// `buildContainer` does (config, both composition roots' ports, the publish queue) plus its own
// dedicated Redis container for the readiness-degrades case — see the same justification on
// container.ts and other integration tests in this module.

import { RedisContainer } from '@testcontainers/redis';
import type { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApi, type Api } from '#src/app/api.ts';
import { loadConfig } from '#src/app/config.ts';
import { buildContainer, type PlatformCorePorts } from '#src/app/container.ts';
import type { ContactQuota } from '#src/modules/comments/infrastructure/contact-quota.ts';
import type { Database } from '#src/shared/db.ts';
import { createRedis } from '#src/shared/queue.ts';
import { QUEUE_NAMES } from '#src/shared/queues.ts';
import { startTestContainers, type TestContainers } from '#src/shared/testing/containers.ts';
import { TEST_ENV } from '#src/shared/testing/test-env.ts';

interface Harness {
  containers: TestContainers;
  database: Database;
  redis: Redis;
  ports: PlatformCorePorts;
  contactQuota: ContactQuota;
  publishQueue: Queue;
  app: Api;
}

async function startHarness(): Promise<Harness> {
  const containers = await startTestContainers();
  const config = loadConfig({
    ...TEST_ENV,
    LOG_LEVEL: 'silent',
    DATABASE_URL: containers.databaseUrl,
    REDIS_URL: containers.redisUrl,
  });
  const container = buildContainer({ config });
  const app = buildApi(container);
  await app.ready();
  return {
    containers,
    database: container.database,
    redis: container.redis,
    ports: container.ports,
    contactQuota: container.contactQuota,
    publishQueue: container.publishQueue,
    app,
  };
}

async function stopHarness(harness: Harness): Promise<void> {
  await harness.app.close();
  await harness.publishQueue.close();
  await harness.database.close();
  harness.redis.disconnect();
  await harness.containers.stop();
}

/**
 * The BullMQ connection retries forever, so an unbounded probe would hang here instead of
 * reporting the outage — the endpoint must bound the check itself. Proving that needs a Redis
 * server that actually goes away mid-test, which `startTestContainers` (shared across this file
 * for its Postgres migrations) does not expose — so this gets its own dedicated, disposable Redis
 * container instead of the shared harness's.
 */
async function assertReadinessDegradesWhenRedisIsGone(harness: Harness): Promise<void> {
  const redisContainer = await new RedisContainer('redis:8.10.1-alpine').start();
  const config = loadConfig({
    ...TEST_ENV,
    LOG_LEVEL: 'silent',
    DATABASE_URL: harness.containers.databaseUrl,
    REDIS_URL: redisContainer.getConnectionUrl(),
  });
  const redis = createRedis(config);
  // A fresh queue handle on this test's own disposable Redis — `harness.ports`/`harness.contactQuota`
  // only ever touch Postgres, so they are safe to reuse against the shared `harness.database`.
  const publishQueue = new Queue(QUEUE_NAMES.commentPublish, { connection: redis });
  const app = buildApi({
    config,
    database: harness.database,
    redis,
    ports: harness.ports,
    contactQuota: harness.contactQuota,
    publishQueue,
  });
  await app.ready();

  try {
    await redisContainer.stop();

    const startedAt = Date.now();
    const response = await app.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(503);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(response.json()).toMatchObject({
      status: 'degraded',
      checks: { postgres: { ok: true }, redis: { ok: false } },
    });
  } finally {
    await app.close();
    await publishQueue.close();
    redis.disconnect();
  }
}

describe('health endpoints', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness();
  });

  afterAll(async () => {
    await stopHarness(harness);
  });

  it('reports liveness without touching dependencies', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('reports readiness only when Postgres and Redis both answer', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      checks: { postgres: { ok: true }, redis: { ok: true } },
    });
  });

  it('fails readiness within the check timeout when Redis is gone', async () => {
    await assertReadinessDegradesWhenRedisIsGone(harness);
  });
});
