/**
 * The stuck-work sweeper (T055, §7.1 step 4, R-10).
 *
 * Property under test: **an accepted write is never silently abandoned**. §7.1 step 4 names one
 * concrete mechanism — "if enqueueing fails, a sweeper runs every minute and re-enqueues `queued`
 * comments older than 1 minute with no active job" — but that sentence alone under-determines the
 * sweeper's selector: a comment can be stuck in `queued` for two different reasons, and only one
 * of them leaves `last_attempt_started_at` set.
 *
 *   1. The BullMQ `comment-publish` job was never created — the enqueue call in `create-reply.ts`
 *      failed right after the insert commits. `last_attempt_started_at` is still `null`, because
 *      the worker never even started an attempt; only `created_at` says how long the row has
 *      waited.
 *   2. A `RetryableError` or an `OutcomeUnknownError` sent the comment back to `queued` with a
 *      delayed BullMQ retry job scheduled — and that job was then lost (Redis restarted, the
 *      worker died before the delay elapsed). Here `last_attempt_started_at` **is** set, from the
 *      attempt that failed, and is the only signal available that time has passed since.
 *
 * The w6b1 brief explicitly instructs simulating case 2 by writing `last_attempt_started_at` in
 * the past, which only makes sense as a sweeper input if the selector reads that column — so this
 * file takes the selector to be `status = 'queued' AND COALESCE(last_attempt_started_at,
 * created_at) < now() - 1 minute`, the only condition that covers both cases 1 and 2 the spec
 * names in the same clause. This is a contract decision the design documents do not spell out in
 * SQL; it is recorded here and in the wave report rather than only in this comment.
 *
 * `COALESCE` over either column alone, not `created_at` on its own: the retry backoff ladder is
 * 1s / 4s / 16s / 64s / 256s, so a comment on its fifth attempt legitimately sits `queued` for over
 * four minutes while it waits out its own scheduled BullMQ retry job — that row's `created_at` is
 * old, but its `last_attempt_started_at` is recent, and the sweeper must leave it alone rather than
 * re-enqueue a comment whose retry job is still pending. A selector on `created_at` alone would
 * sweep it regardless and risk the second concurrent publish D14 exists to prevent; reading
 * `last_attempt_started_at` first is what lets the sweeper tell "still backing off" apart from
 * "the job that was supposed to run is gone".
 *
 * (Controller ruling, recorded for T064's implementer: `comments_stuck_work_idx` —
 * `(status, last_attempt_started_at) WHERE status IN ('queued','processing')` — still narrows the
 * scan to the small set of in-flight rows even though it cannot serve the `COALESCE` term directly;
 * no expression index was added, since that set is empty in the healthy case and rows drain through
 * it in seconds.)
 *
 * `processing` rows are deliberately left alone: a stuck `queued` row has no worker holding it, so
 * re-enqueuing is safe, but a `processing` row may still have a worker attempt in flight — sweeping
 * it too would risk the second concurrent publish D14 exists to prevent.
 */

// oxlint-disable max-dependencies -- this test wires a full harness (Postgres, the BullMQ queue it
// asserts against, and the schema/config/id helpers needed to seed a realistic stuck comment) plus
// the module under test; none of that can be dropped without weakening what the test proves.

import { eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '#src/app/config.ts';
import type { CommentStatus } from '#src/modules/comments/domain/status.ts';
import { createStuckWorkSweeper } from '#src/modules/comments/infrastructure/sweepers.ts';
import { comments } from '#src/modules/comments/infrastructure/schema.ts';
import { socialAccounts, workspaces } from '#src/modules/platform-core/schema.ts';
import { asWorkspaceId, generateId, type WorkspaceId } from '#src/shared/ids.ts';
import { createRedis } from '#src/shared/queue.ts';
import { QUEUE_NAMES } from '#src/shared/queues.ts';
import { startTestContainers, type TestContainers } from '#src/shared/testing/containers.ts';
import { TEST_ENV } from '#src/shared/testing/test-env.ts';

const ONE_MINUTE_MS = 60_000;
const TWO_MINUTES_AGO = new Date(Date.now() - 2 * ONE_MINUTE_MS);
// Comfortably past the sweeper's 5-minute `processing` threshold (spec.md §18, "The stuck-work
// sweeper also recovers `processing`") — a worker that died mid-publish leaves exactly this trace.
const TEN_MINUTES_AGO = new Date(Date.now() - 10 * ONE_MINUTE_MS);

interface Harness {
  containers: TestContainers;
  pool: Pool;
  db: NodePgDatabase;
  redis: Redis;
  publishQueue: Queue;
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
  return { containers, pool, db, redis, publishQueue };
}

async function teardownHarness(harness: Harness): Promise<void> {
  await harness.publishQueue.close();
  harness.redis.disconnect();
  await harness.pool.end();
  await harness.containers.stop();
}

interface SeededAccount {
  readonly workspaceId: WorkspaceId;
  readonly socialAccountId: string;
}

async function seedWorkspaceAndAccount(db: NodePgDatabase): Promise<SeededAccount> {
  const workspaceId = asWorkspaceId(generateId());
  const socialAccountId = generateId();

  await db.insert(workspaces).values({
    id: workspaceId,
    name: 'Test workspace',
    contactLimitMonthly: 100,
    createdAt: new Date(),
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
    createdAt: new Date(),
  });

  return { workspaceId, socialAccountId };
}

interface SeedStuckCommentOptions {
  readonly workspaceId: WorkspaceId;
  readonly socialAccountId: string;
  readonly status?: CommentStatus;
  readonly createdAt?: Date;
  readonly lastAttemptStartedAt?: Date | null;
  readonly attemptCount?: number;
}

async function seedComment(db: NodePgDatabase, opts: SeedStuckCommentOptions): Promise<string> {
  const id = generateId();
  const createdAt = opts.createdAt ?? new Date();

  await db.insert(comments).values({
    id,
    workspaceId: opts.workspaceId,
    socialAccountId: opts.socialAccountId,
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
    text: 'a reply stuck waiting to publish',
    status: opts.status ?? 'queued',
    attemptCount: opts.attemptCount ?? 0,
    lastAttemptStartedAt: opts.lastAttemptStartedAt ?? null,
    replyCount: 0,
    lastActivityAt: createdAt,
    occurredAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  });

  return id;
}

let harness: Harness;

beforeAll(async () => {
  harness = await setupHarness();
});

afterAll(async () => {
  await teardownHarness(harness);
});

describe('re-enqueues genuinely stuck queued comments (§7.1 step 4)', () => {
  it('a comment whose retry job was lost (last_attempt_started_at set, stale)', async () => {
    const { db, publishQueue } = harness;
    const account = await seedWorkspaceAndAccount(db);
    const commentId = await seedComment(db, {
      ...account,
      status: 'queued',
      lastAttemptStartedAt: TWO_MINUTES_AGO,
      attemptCount: 1,
    });

    await createStuckWorkSweeper({ database: db, publishQueue }).sweep();

    const job = await publishQueue.getJob(commentId);
    expect(job).toBeDefined();
    expect(job?.id).toBe(commentId);
  });

  it('a comment whose initial enqueue never happened (last_attempt_started_at null, created_at stale)', async () => {
    const { db, publishQueue } = harness;
    const account = await seedWorkspaceAndAccount(db);
    const commentId = await seedComment(db, {
      ...account,
      status: 'queued',
      createdAt: TWO_MINUTES_AGO,
      lastAttemptStartedAt: null,
    });

    await createStuckWorkSweeper({ database: db, publishQueue }).sweep();

    const job = await publishQueue.getJob(commentId);
    expect(job).toBeDefined();
    expect(job?.id).toBe(commentId);
  });
});

describe("leaves comments alone that are not the sweeper's job", () => {
  it('a freshly queued comment — it has not been waiting a minute yet', async () => {
    const { db, publishQueue } = harness;
    const account = await seedWorkspaceAndAccount(db);
    const commentId = await seedComment(db, {
      ...account,
      status: 'queued',
      createdAt: new Date(),
      lastAttemptStartedAt: null,
    });

    await createStuckWorkSweeper({ database: db, publishQueue }).sweep();

    const job = await publishQueue.getJob(commentId);
    expect(job).toBeUndefined();
  });

  it('a 2-minute-old `processing` comment — under the 5-minute threshold, a worker may still hold it', async () => {
    const { db, publishQueue } = harness;
    const account = await seedWorkspaceAndAccount(db);
    const commentId = await seedComment(db, {
      ...account,
      status: 'processing',
      lastAttemptStartedAt: TWO_MINUTES_AGO,
      attemptCount: 1,
    });

    await createStuckWorkSweeper({ database: db, publishQueue }).sweep();

    const job = await publishQueue.getJob(commentId);
    expect(job).toBeUndefined();
  });
});

describe('recovers a processing row a dead worker abandoned (spec.md §18)', () => {
  it('a 10-minute-stale `processing` row is returned to `queued` and re-enqueued', async () => {
    const { db, publishQueue } = harness;
    const account = await seedWorkspaceAndAccount(db);
    const commentId = await seedComment(db, {
      ...account,
      status: 'processing',
      lastAttemptStartedAt: TEN_MINUTES_AGO,
      attemptCount: 1,
    });

    await createStuckWorkSweeper({ database: db, publishQueue }).sweep();

    const job = await publishQueue.getJob(commentId);
    expect(job).toBeDefined();
    expect(job?.id).toBe(commentId);

    const [row] = await db.select().from(comments).where(eq(comments.id, commentId));
    expect(row?.status).toBe('queued');
  });
});

describe('leaves a comment mid-backoff alone (1s/4s/16s/64s/256s ladder)', () => {
  it('old created_at, recent last_attempt_started_at — the retry job is still legitimately pending', async () => {
    const { db, publishQueue } = harness;
    const account = await seedWorkspaceAndAccount(db);
    // Fifth attempt on the ladder: `created_at` is old (the comment has been alive for several
    // minutes across four prior attempts) but the most recent attempt started seconds ago, and its
    // BullMQ retry job is still legitimately pending. Selecting on `created_at` alone — instead of
    // `COALESCE(last_attempt_started_at, created_at)` — would sweep this row and risk a second
    // concurrent publish (D14).
    const commentId = await seedComment(db, {
      ...account,
      status: 'queued',
      createdAt: TWO_MINUTES_AGO,
      lastAttemptStartedAt: new Date(),
      attemptCount: 4,
    });

    await createStuckWorkSweeper({ database: db, publishQueue }).sweep();

    const job = await publishQueue.getJob(commentId);
    expect(job).toBeUndefined();
  });
});
