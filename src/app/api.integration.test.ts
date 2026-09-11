import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApi, type Api } from '#src/app/api.ts';
import { loadConfig } from '#src/app/config.ts';
import { createDatabase, type Database } from '#src/shared/db.ts';
import { createRedis } from '#src/shared/queue.ts';

interface Harness {
  postgres: StartedPostgreSqlContainer;
  redisContainer: StartedRedisContainer;
  database: Database;
  redis: Redis;
  app: Api;
}

async function startHarness(): Promise<Harness> {
  const [postgres, redisContainer] = await Promise.all([
    new PostgreSqlContainer('postgres:18.6-alpine').start(),
    new RedisContainer('redis:8.10.1-alpine').start(),
  ]);
  const config = loadConfig({
    LOG_LEVEL: 'silent',
    DATABASE_URL: postgres.getConnectionUri(),
    REDIS_URL: redisContainer.getConnectionUrl(),
  });
  const database = createDatabase(config);
  const redis = createRedis(config);
  const app = buildApi({ config, database, redis });
  await app.ready();
  return { postgres, redisContainer, database, redis, app };
}

async function stopHarness(harness: Harness): Promise<void> {
  await harness.app.close();
  await harness.database.close();
  harness.redis.disconnect();
  await Promise.allSettled([harness.postgres.stop(), harness.redisContainer.stop()]);
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

  // The BullMQ connection retries forever, so an unbounded probe would hang here instead
  // of reporting the outage — the endpoint must bound the check itself.
  it('fails readiness within the check timeout when Redis is gone', async () => {
    await harness.redisContainer.stop();

    const startedAt = Date.now();
    const response = await harness.app.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(503);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(response.json()).toMatchObject({
      status: 'degraded',
      checks: { postgres: { ok: true }, redis: { ok: false } },
    });
  });
});
