/**
 * C1 regression: a sweeper's `jobId` collides with a job BullMQ has already retained in a
 * terminal state.
 *
 * `sweeper.integration.test.ts` and `webhook-delivery-sweeper.integration.test.ts` both seed a row
 * with no prior job for that `jobId` — the process-crashed-before-enqueue case. That is not the
 * production-normal case: `jobId = comment.id` / `jobId = delivery.id` means the *first* job ever
 * added for an entity almost always still exists in Redis (completed or failed) by the time a
 * sweeper decides the same entity is stuck again. `Queue.add` with an existing `jobId` resolves
 * successfully without moving anything back to `wait` (BullMQ's `addStandardJob` Lua script), so
 * that prior run was, until this fix, a silent permanent no-op. This file seeds exactly that state
 * — a retained completed job, and a retained failed job — for both sweepers, and asserts the
 * re-enqueue actually schedules a fresh job rather than resolving into the stale one.
 */

// oxlint-disable max-dependencies -- this test wires a full harness (Postgres, Redis, both queues
// it drives jobs through to a terminal state, and the config/id helpers needed to seed realistic
// rows) plus both modules under test; none of that can be dropped without weakening what the test
// proves (mirrors sweeper.integration.test.ts's own exemption).

import { eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '#src/app/config.ts';
import {
  createStuckWorkSweeper,
  createWebhookDeliverySweeper,
} from '#src/modules/comments/infrastructure/sweepers.ts';
import { comments, webhookDeliveries } from '#src/modules/comments/infrastructure/schema.ts';
import { socialAccounts, workspaces } from '#src/modules/platform-core/schema.ts';
import { asWorkspaceId, generateId, type WorkspaceId } from '#src/shared/ids.ts';
import { createRedis } from '#src/shared/queue.ts';
import { JOB_NAMES, QUEUE_NAMES } from '#src/shared/queues.ts';
import { startTestContainers, type TestContainers } from '#src/shared/testing/containers.ts';
import { TEST_ENV } from '#src/shared/testing/test-env.ts';

const ONE_MINUTE_MS = 60_000;
const TWO_MINUTES_AGO = new Date(Date.now() - 2 * ONE_MINUTE_MS);
const TEN_MINUTES_AGO = new Date(Date.now() - 10 * ONE_MINUTE_MS);

interface Harness {
  containers: TestContainers;
  pool: Pool;
  db: NodePgDatabase;
  redis: Redis;
  publishQueue: Queue;
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
  const publishQueue = new Queue(QUEUE_NAMES.commentPublish, { connection: redis });
  const webhookQueue = new Queue(QUEUE_NAMES.webhookProcess, { connection: redis });
  return { containers, pool, db, redis, publishQueue, webhookQueue };
}

async function teardownHarness(harness: Harness): Promise<void> {
  await harness.publishQueue.close();
  await harness.webhookQueue.close();
  harness.redis.disconnect();
  await harness.pool.end();
  await harness.containers.stop();
}

/**
 * Drives a job already added under `jobId` to a terminal state the way a real attempt would, so a
 * later sweep finds exactly the retained-job collision C1 describes.
 */
async function settleJobTerminally(
  queue: Queue,
  redis: Redis,
  jobId: string,
  outcome: 'completed' | 'failed',
): Promise<void> {
  // The processor type requires a Promise-returning function; this one only ever throws
  // synchronously (or resolves immediately) on purpose.
  // oxlint-disable-next-line require-await
  const settleProcessor = async (): Promise<void> => {
    if (outcome === 'failed') {
      throw new Error('test: forced failure to settle the job terminally');
    }
  };
  const worker = new Worker(queue.name, settleProcessor, { connection: redis, concurrency: 1 });
  try {
    await new Promise<void>((resolve, reject) => {
      worker.on('completed', (job) => job.id === jobId && resolve());
      worker.on('failed', (job) => job?.id === jobId && resolve());
      worker.on('error', reject);
    });
  } finally {
    await worker.close();
  }
}

interface SeededAccount {
  readonly workspaceId: WorkspaceId;
  readonly socialAccountId: string;
}

async function seedWorkspaceAndAccount(db: NodePgDatabase, now: Date): Promise<SeededAccount> {
  const workspaceId = asWorkspaceId(generateId());
  const socialAccountId = generateId();

  await db.insert(workspaces).values({
    id: workspaceId,
    name: 'Test workspace',
    contactLimitMonthly: 100,
    createdAt: now,
  });
  await db.insert(socialAccounts).values({
    id: socialAccountId,
    workspaceId,
    platform: 'bluesky',
    platformAccountId: 'bsky-demo-account',
    username: 'demo',
    credentialsCiphertext: Buffer.alloc(28),
    credentialsKeyVersion: 1,
    status: 'active',
    createdAt: now,
  });

  return { workspaceId, socialAccountId };
}

async function seedStuckComment(
  db: NodePgDatabase,
  status: 'queued' | 'processing',
): Promise<string> {
  const id = generateId();
  const now = new Date();
  const { workspaceId, socialAccountId } = await seedWorkspaceAndAccount(db, now);

  await db.insert(comments).values({
    id,
    workspaceId,
    socialAccountId,
    platform: 'bluesky',
    postId: null,
    platformPostId: 'platform-post-1',
    parentCommentId: null,
    rootCommentId: null,
    depth: 0,
    platformCommentId: null,
    isOwn: true,
    source: 'api',
    authorPlatformId: 'bsky-demo-account',
    text: 'a reply stuck behind a retained job',
    status,
    attemptCount: 1,
    lastAttemptStartedAt: status === 'queued' ? TWO_MINUTES_AGO : TEN_MINUTES_AGO,
    replyCount: 0,
    lastActivityAt: now,
    occurredAt: now,
    createdAt: now,
    updatedAt: now,
  });

  return id;
}

async function seedUnprocessedDelivery(db: NodePgDatabase): Promise<string> {
  const [row] = await db
    .insert(webhookDeliveries)
    .values({
      provider: 'meta',
      payload: { object: 'page', entry: [] },
      receivedAt: TEN_MINUTES_AGO,
      processedAt: null,
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

describe('stuck-work sweeper: a retained job under the stuck comment’s jobId', () => {
  it('a completed job does not make the sweep a no-op', async () => {
    const { db, publishQueue, redis } = harness;
    const commentId = await seedStuckComment(db, 'queued');

    await publishQueue.add('publish', { commentId }, { jobId: commentId });
    await settleJobTerminally(publishQueue, redis, commentId, 'completed');
    expect(await (await publishQueue.getJob(commentId))?.getState()).toBe('completed');

    await createStuckWorkSweeper({ database: db, publishQueue }).sweep();

    const job = await publishQueue.getJob(commentId);
    expect(job).toBeDefined();
    expect(await job?.getState()).not.toBe('completed');
  });

  it('a failed job on a stuck `processing` row does not make the sweep a no-op', async () => {
    const { db, publishQueue, redis } = harness;
    const commentId = await seedStuckComment(db, 'processing');

    await publishQueue.add('publish', { commentId }, { jobId: commentId });
    await settleJobTerminally(publishQueue, redis, commentId, 'failed');
    expect(await (await publishQueue.getJob(commentId))?.getState()).toBe('failed');

    await createStuckWorkSweeper({ database: db, publishQueue }).sweep();

    const job = await publishQueue.getJob(commentId);
    expect(job).toBeDefined();
    expect(await job?.getState()).not.toBe('failed');

    const [row] = await db.select().from(comments).where(eq(comments.id, commentId));
    expect(row?.status).toBe('queued');
  });
});

describe('webhook-delivery sweeper: a retained job under the delivery’s jobId', () => {
  it('a completed job does not make the sweep a no-op', async () => {
    const { db, webhookQueue, redis } = harness;
    const deliveryId = await seedUnprocessedDelivery(db);

    await webhookQueue.add(JOB_NAMES.processDelivery, { deliveryId }, { jobId: deliveryId });
    await settleJobTerminally(webhookQueue, redis, deliveryId, 'completed');
    expect(await (await webhookQueue.getJob(deliveryId))?.getState()).toBe('completed');

    await createWebhookDeliverySweeper({ database: db, webhookQueue }).sweep();

    const job = await webhookQueue.getJob(deliveryId);
    expect(job).toBeDefined();
    expect(await job?.getState()).not.toBe('completed');
  });

  it('a failed job does not make the sweep a no-op', async () => {
    const { db, webhookQueue, redis } = harness;
    const deliveryId = await seedUnprocessedDelivery(db);

    await webhookQueue.add(JOB_NAMES.processDelivery, { deliveryId }, { jobId: deliveryId });
    await settleJobTerminally(webhookQueue, redis, deliveryId, 'failed');
    expect(await (await webhookQueue.getJob(deliveryId))?.getState()).toBe('failed');

    await createWebhookDeliverySweeper({ database: db, webhookQueue }).sweep();

    const job = await webhookQueue.getJob(deliveryId);
    expect(job).toBeDefined();
    expect(await job?.getState()).not.toBe('failed');
  });
});
