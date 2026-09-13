/**
 * The stuck sync-job sweeper.
 *
 * What makes this worth testing is the *silence* of the failure it repairs: an abandoned
 * `comment_sync_jobs` row produces no error anywhere. The scheduler's `onConflictDoNothing` skips
 * the target, the log stays clean, and the post simply stops syncing. So each case here asserts
 * the thing that is actually load-bearing — that the partial unique index
 * `comment_sync_jobs_active_target_key` is free again afterwards, proved by inserting the row the
 * next scheduler tick would insert.
 */

// oxlint-disable max-dependencies -- an integration test wiring the real schema, the real
// queue and the real config loader; the count reflects the sweeper's own fan-in.

import { eq, inArray, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  commentSyncJobs,
  commentSyncTargets,
} from '#src/modules/comments/infrastructure/schema.ts';
import { createStuckSyncJobSweeper } from '#src/modules/comments/infrastructure/sync-job-sweeper.ts';
import { asWorkspaceId, generateId, type WorkspaceId } from '#src/shared/ids.ts';
import { startTestContainers, type TestContainers } from '#src/shared/testing/containers.ts';
import { loadConfig } from '#src/app/config.ts';
import { createRedis } from '#src/shared/queue.ts';
import { QUEUE_NAMES } from '#src/shared/queues.ts';
import { TEST_ENV } from '#src/shared/testing/test-env.ts';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

const MINUTE = 60_000;

interface Harness {
  containers: TestContainers;
  pool: Pool;
  db: NodePgDatabase;
  queue: Queue;
  redis: Redis;
}

let harness: Harness;

async function seedTarget(
  db: NodePgDatabase,
): Promise<{ targetId: string; workspaceId: WorkspaceId }> {
  const targetId = generateId();
  const workspaceId = asWorkspaceId(generateId());
  const now = new Date();

  await db.insert(commentSyncTargets).values({
    id: targetId,
    workspaceId,
    socialAccountId: generateId(),
    postId: null,
    platformPostId: `at://post/${targetId}`,
    ageAnchorAt: now,
    nextSyncAt: now,
  });

  return { targetId, workspaceId };
}

interface SeedJobOptions {
  readonly status: 'queued' | 'running';
  readonly ageMs: number;
}

async function seedJob(
  db: NodePgDatabase,
  target: { targetId: string; workspaceId: WorkspaceId },
  options: SeedJobOptions,
): Promise<string> {
  const id = generateId();
  const at = new Date(Date.now() - options.ageMs);

  await db.insert(commentSyncJobs).values({
    id,
    workspaceId: target.workspaceId,
    targetId: target.targetId,
    trigger: 'scheduled',
    status: options.status,
    stats: null,
    error: null,
    createdAt: at,
    startedAt: options.status === 'running' ? at : null,
  });

  return id;
}

async function loadJob(db: NodePgDatabase, id: string) {
  const [row] = await db.select().from(commentSyncJobs).where(eq(commentSyncJobs.id, id));
  return row ?? null;
}

/**
 * Whether a fresh job can be scheduled for this target — i.e. whether the partial unique index
 * still considers an active job to exist. This is the user-visible consequence of the whole
 * mechanism, so it is asserted directly rather than inferred from the swept row's status.
 */
async function targetCanBeScheduledAgain(
  db: NodePgDatabase,
  target: { targetId: string; workspaceId: WorkspaceId },
): Promise<boolean> {
  const [inserted] = await db
    .insert(commentSyncJobs)
    .values({
      id: generateId(),
      workspaceId: target.workspaceId,
      targetId: target.targetId,
      trigger: 'scheduled',
      status: 'queued',
      stats: null,
      error: null,
    })
    .onConflictDoNothing({
      target: [commentSyncJobs.targetId],
      where: sql`${commentSyncJobs.status} in ('queued', 'running')`,
    })
    .returning({ id: commentSyncJobs.id });
  return inserted !== undefined;
}

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

function buildSweeper() {
  return createStuckSyncJobSweeper({ database: harness.db, syncQueue: harness.queue });
}

describe('a job abandoned in running (the runner was killed mid-walk)', () => {
  it('fails it so the target can be scheduled again', async () => {
    const { db } = harness;
    const target = await seedTarget(db);
    const jobId = await seedJob(db, target, { status: 'running', ageMs: 20 * MINUTE });

    await buildSweeper().sweep();

    const row = await loadJob(db, jobId);
    expect(row?.status).toBe('failed');
    expect(row?.finishedAt).not.toBeNull();
    expect(await targetCanBeScheduledAgain(db, target)).toBe(true);
  });

  it('leaves a job that is still plausibly running alone', async () => {
    const { db } = harness;
    const target = await seedTarget(db);
    // Two minutes in: well within the window a real walk over a busy thread takes.
    const jobId = await seedJob(db, target, { status: 'running', ageMs: 2 * MINUTE });

    await buildSweeper().sweep();

    expect((await loadJob(db, jobId))?.status).toBe('running');
  });
});

describe('a job whose enqueue was lost (committed, never handed to BullMQ)', () => {
  it('re-enqueues it and leaves the row queued for the runner to claim', async () => {
    const { db, queue } = harness;
    const target = await seedTarget(db);
    const jobId = await seedJob(db, target, { status: 'queued', ageMs: 10 * MINUTE });

    await buildSweeper().sweep();

    // The row stays `queued` — it is the *job* that was missing, not the row.
    expect((await loadJob(db, jobId))?.status).toBe('queued');
    const job = await queue.getJob(jobId);
    expect(job?.data).toEqual({ targetId: target.targetId });
  });

  it('leaves a freshly queued job alone', async () => {
    const { db } = harness;
    const target = await seedTarget(db);
    const jobId = await seedJob(db, target, { status: 'queued', ageMs: 30_000 });

    await buildSweeper().sweep();

    expect(await harness.queue.getJob(jobId)).toBeUndefined();
  });
});

describe('one failing row', () => {
  it('does not stop the others from being swept', async () => {
    const { db } = harness;
    const targets = await Promise.all([seedTarget(db), seedTarget(db), seedTarget(db)]);
    const jobIds = await Promise.all(
      targets.map((target) => seedJob(db, target, { status: 'running', ageMs: 20 * MINUTE })),
    );

    await buildSweeper().sweep();

    const rows = await db.select().from(commentSyncJobs).where(inArray(commentSyncJobs.id, jobIds));
    expect(rows.map((row) => row.status)).toEqual(['failed', 'failed', 'failed']);
  });
});
