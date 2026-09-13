/**
 * The webhook-delivery sweeper (T082, §7.2 step 5).
 *
 * Property under test: a `webhook_deliveries` row whose `processed_at` is still `null` past the
 * 5-minute threshold gets a `process-delivery` job re-enqueued, `jobId = delivery.id`. A row
 * already processed, or one still comfortably inside the threshold, is left alone.
 */

// oxlint-disable max-dependencies -- this test wires a full harness (Postgres, the BullMQ queue it
// asserts against, config/Redis helpers) plus the module under test; none of that can be dropped
// without weakening what the test proves (mirrors sweeper.integration.test.ts's own exemption).

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '#src/app/config.ts';
import { createWebhookDeliverySweeper } from '#src/modules/comments/infrastructure/sweepers.ts';
import { webhookDeliveries } from '#src/modules/comments/infrastructure/schema.ts';
import { createRedis } from '#src/shared/queue.ts';
import { QUEUE_NAMES } from '#src/shared/queues.ts';
import { startTestContainers, type TestContainers } from '#src/shared/testing/containers.ts';
import { TEST_ENV } from '#src/shared/testing/test-env.ts';

const ONE_MINUTE_MS = 60_000;
const TEN_MINUTES_AGO = new Date(Date.now() - 10 * ONE_MINUTE_MS);

interface Harness {
  containers: TestContainers;
  pool: Pool;
  db: NodePgDatabase;
  redis: Redis;
  webhookQueue: Queue;
}

async function setupHarness(): Promise<Harness> {
  const containers = await startTestContainers();
  const pool = new Pool({ connectionString: containers.databaseUrl });
  const db = drizzle(pool);
  const config = loadConfig({
    ...TEST_ENV,
    LOG_LEVEL: 'silent',
    DATABASE_URL: containers.databaseUrl,
    REDIS_URL: containers.redisUrl,
  });
  const redis = createRedis(config);
  const webhookQueue = new Queue(QUEUE_NAMES.webhookProcess, { connection: redis });
  return { containers, pool, db, redis, webhookQueue };
}

async function teardownHarness(harness: Harness): Promise<void> {
  await harness.webhookQueue.close();
  harness.redis.disconnect();
  await harness.pool.end();
  await harness.containers.stop();
}

interface SeedDeliveryOptions {
  readonly receivedAt: Date;
  readonly processedAt?: Date | null;
}

async function seedDelivery(db: NodePgDatabase, opts: SeedDeliveryOptions): Promise<string> {
  const [row] = await db
    .insert(webhookDeliveries)
    .values({
      provider: 'meta',
      payload: { object: 'page', entry: [] },
      receivedAt: opts.receivedAt,
      processedAt: opts.processedAt ?? null,
    })
    .returning({ id: webhookDeliveries.id });
  if (row === undefined) {
    throw new Error('test: insert into webhook_deliveries returned no row');
  }
  return row.id;
}

let harness: Harness;

beforeAll(async () => {
  harness = await setupHarness();
});

afterAll(async () => {
  await teardownHarness(harness);
});

describe('re-enqueues unprocessed deliveries past the 5-minute threshold (§7.2 step 5)', () => {
  it('a delivery received 10 minutes ago with no processed_at', async () => {
    const { db, webhookQueue } = harness;
    const deliveryId = await seedDelivery(db, { receivedAt: TEN_MINUTES_AGO });

    await createWebhookDeliverySweeper({ database: db, webhookQueue }).sweep();

    const job = await webhookQueue.getJob(deliveryId);
    expect(job).toBeDefined();
    expect(job?.id).toBe(deliveryId);
    expect(job?.data).toEqual({ deliveryId });
  });
});

describe("leaves deliveries alone that are not the sweeper's job", () => {
  it('a delivery received moments ago — under the 5-minute threshold', async () => {
    const { db, webhookQueue } = harness;
    const deliveryId = await seedDelivery(db, { receivedAt: new Date() });

    await createWebhookDeliverySweeper({ database: db, webhookQueue }).sweep();

    const job = await webhookQueue.getJob(deliveryId);
    expect(job).toBeUndefined();
  });

  it('an old delivery that was already processed', async () => {
    const { db, webhookQueue } = harness;
    const deliveryId = await seedDelivery(db, {
      receivedAt: TEN_MINUTES_AGO,
      processedAt: new Date(),
    });

    await createWebhookDeliverySweeper({ database: db, webhookQueue }).sweep();

    const job = await webhookQueue.getJob(deliveryId);
    expect(job).toBeUndefined();
  });
});

describe('re-sweeping is idempotent', () => {
  it('sweeping the same stale delivery twice does not error and the job still resolves', async () => {
    const { db, webhookQueue } = harness;
    const deliveryId = await seedDelivery(db, { receivedAt: TEN_MINUTES_AGO });
    const sweeper = createWebhookDeliverySweeper({ database: db, webhookQueue });

    await sweeper.sweep();
    await sweeper.sweep();

    const job = await webhookQueue.getJob(deliveryId);
    expect(job).toBeDefined();
    expect(job?.id).toBe(deliveryId);
  });
});
