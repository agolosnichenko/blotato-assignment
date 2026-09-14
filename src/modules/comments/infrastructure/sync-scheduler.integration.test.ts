/**
 * The sync scheduler's tick (§7.3, spec.md §18 "The scheduler leases the targets it selects").
 *
 * The failure this guards against is silent starvation: a due target whose job is still queued or
 * running stays due, and once more of those exist than one tick's batch, a selection that does not
 * move them out of the way re-selects the same ones forever — each losing to its own active job on
 * the partial unique index — and never reaches the targets behind them.
 */

// oxlint-disable max-dependencies -- an integration test wiring the real schema, the real queue
// and the real config loader around the one module under test.

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '#src/app/config.ts';
import {
  commentSyncJobs,
  commentSyncTargets,
} from '#src/modules/comments/infrastructure/schema.ts';
import { createSyncScheduler } from '#src/modules/comments/infrastructure/sync-scheduler.ts';
import { asWorkspaceId, generateId } from '#src/shared/ids.ts';
import { createRedis } from '#src/shared/queue.ts';
import { QUEUE_NAMES } from '#src/shared/queues.ts';
import { startTestContainers, type TestContainers } from '#src/shared/testing/containers.ts';
import { TEST_ENV } from '#src/shared/testing/test-env.ts';

const MINUTE = 60_000;

interface Harness {
  containers: TestContainers;
  pool: Pool;
  db: NodePgDatabase;
  queue: Queue;
  redis: Redis;
}

let harness: Harness;

beforeAll(async () => {
  const containers = await startTestContainers();
  const pool = new Pool({ connectionString: containers.databaseUrl });
  const config = loadConfig({
    ...TEST_ENV,
    LOG_LEVEL: 'silent',
    DATABASE_URL: containers.databaseUrl,
    REDIS_URL: containers.redisUrl,
  });
  const redis = createRedis(config);
  const queue = new Queue(QUEUE_NAMES.commentSync, { connection: redis });
  harness = { containers, pool, db: drizzle(pool), queue, redis };
});

afterAll(async () => {
  await harness.queue.close();
  harness.redis.disconnect();
  await harness.pool.end();
  await harness.containers.stop();
});

beforeEach(async () => {
  await harness.db.delete(commentSyncJobs);
  await harness.db.delete(commentSyncTargets);
  await harness.queue.obliterate({ force: true });
});

/** Inserts `count` targets, in order, due at `dueAt` plus one millisecond per position. */
async function seedTargets(count: number, dueAt: Date | null): Promise<string[]> {
  const rows = Array.from({ length: count }, (_, index) => {
    const id = generateId();
    return {
      id,
      workspaceId: asWorkspaceId(generateId()),
      socialAccountId: generateId(),
      postId: null,
      platformPostId: `at://post/${id}`,
      ageAnchorAt: new Date(),
      nextSyncAt: dueAt === null ? null : new Date(dueAt.getTime() + index),
    };
  });
  await harness.db.insert(commentSyncTargets).values(rows);
  return rows.map((row) => row.id);
}

/** An active job per target — what a tick finds for a target whose walk has not finished yet. */
async function seedActiveJobs(targetIds: readonly string[]): Promise<void> {
  const targets = await harness.db
    .select({ id: commentSyncTargets.id, workspaceId: commentSyncTargets.workspaceId })
    .from(commentSyncTargets)
    .where(inArray(commentSyncTargets.id, [...targetIds]));
  await harness.db.insert(commentSyncJobs).values(
    targets.map((target) => ({
      workspaceId: target.workspaceId,
      targetId: target.id,
      trigger: 'scheduled',
      status: 'running',
    })),
  );
}

async function targetsWithQueuedJob(targetIds: readonly string[]): Promise<Set<string>> {
  const rows = await harness.db
    .select({ targetId: commentSyncJobs.targetId })
    .from(commentSyncJobs)
    .where(
      and(inArray(commentSyncJobs.targetId, [...targetIds]), eq(commentSyncJobs.status, 'queued')),
    );
  return new Set(rows.map((row) => row.targetId));
}

function buildScheduler() {
  return createSyncScheduler({ database: harness.db, syncQueue: harness.queue });
}

describe('a backlog of due targets whose walks are still in flight', () => {
  it('does not starve the targets behind them', async () => {
    const longAgo = new Date(Date.now() - 60 * MINUTE);
    // Seeded first and due first: both heap order and due order put them at the front.
    const inFlight = await seedTargets(150, longAgo);
    await seedActiveJobs(inFlight);
    const waiting = await seedTargets(50, new Date(Date.now() - MINUTE));

    await buildScheduler().tick();

    const scheduled = await targetsWithQueuedJob(waiting);
    expect(scheduled.size).toBe(waiting.length);
    expect(await harness.queue.getJobCountByTypes('waiting')).toBe(waiting.length);
  });
});

async function assertLeasedTargetIsNotReselected(): Promise<void> {
  const [targetId] = await seedTargets(1, new Date(Date.now() - MINUTE));
  if (targetId === undefined) {
    throw new Error('seedTargets returned no id');
  }
  const scheduler = buildScheduler();

  await scheduler.tick();
  const [afterFirst] = await harness.db
    .select({ nextSyncAt: commentSyncTargets.nextSyncAt })
    .from(commentSyncTargets)
    .where(eq(commentSyncTargets.id, targetId));
  await harness.db
    .update(commentSyncJobs)
    .set({ status: 'succeeded' })
    .where(eq(commentSyncJobs.targetId, targetId));
  await scheduler.tick();

  expect(afterFirst?.nextSyncAt?.getTime()).toBeGreaterThan(Date.now());
  const jobs = await harness.db
    .select({ id: commentSyncJobs.id })
    .from(commentSyncJobs)
    .where(eq(commentSyncJobs.targetId, targetId));
  expect(jobs).toHaveLength(1);
}

describe('a single tick', () => {
  it('schedules every due target, not only the first batch', async () => {
    const targetIds = await seedTargets(250, new Date(Date.now() - MINUTE));

    await buildScheduler().tick();

    expect((await targetsWithQueuedJob(targetIds)).size).toBe(targetIds.length);
    expect(await harness.queue.getJobCountByTypes('waiting')).toBe(targetIds.length);
  });

  it(
    'leases what it selected, so the next tick does not select it again',
    assertLeasedTargetIsNotReselected,
  );

  it('leaves deactivated and not-yet-due targets alone', async () => {
    const deactivated = await seedTargets(3, null);
    const future = new Date(Date.now() + 30 * MINUTE);
    const notDue = await seedTargets(3, future);

    await buildScheduler().tick();

    expect((await targetsWithQueuedJob([...deactivated, ...notDue])).size).toBe(0);
    const stillDeactivated = await harness.db
      .select({ id: commentSyncTargets.id })
      .from(commentSyncTargets)
      .where(isNull(commentSyncTargets.nextSyncAt));
    expect(stillDeactivated).toHaveLength(deactivated.length);
    const [firstNotDue] = await harness.db
      .select({ nextSyncAt: commentSyncTargets.nextSyncAt })
      .from(commentSyncTargets)
      .where(eq(commentSyncTargets.id, notDue[0] ?? ''));
    expect(firstNotDue?.nextSyncAt?.getTime()).toBe(future.getTime());
  });
});
