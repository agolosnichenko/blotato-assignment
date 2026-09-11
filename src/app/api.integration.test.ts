import { RedisContainer } from '@testcontainers/redis';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApi, type Api } from '#src/app/api.ts';
import { loadConfig } from '#src/app/config.ts';
import { createDatabase, type Database } from '#src/shared/db.ts';
import { createRedis } from '#src/shared/queue.ts';
import { startTestContainers, type TestContainers } from '#src/shared/testing/containers.ts';
import { TEST_ENV } from '#src/shared/testing/test-env.ts';

interface Harness {
  containers: TestContainers;
  database: Database;
  redis: Redis;
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
  const database = createDatabase(config);
  const redis = createRedis(config);
  const app = buildApi({ config, database, redis });
  await app.ready();
  return { containers, database, redis, app };
}

async function stopHarness(harness: Harness): Promise<void> {
  await harness.app.close();
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
  const app = buildApi({ config, database: harness.database, redis });
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
