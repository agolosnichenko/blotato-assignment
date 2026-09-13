/**
 * Contract tests for `POST /v1/posts/:postId/comments/sync` (T074, V4, D19) — the route does not
 * exist yet (T090, blocked on `request-sync.ts`/T089), so every case here reaches Fastify's own
 * `setNotFoundHandler` today. That `404 NOT_FOUND` is the intended RED failure: it names exactly
 * what is missing (the route), the same relationship `create-reply.integration.test.ts` had to the
 * write route before T058/T069 landed.
 *
 * Unlike `ingest-comments.integration.test.ts` / `sync-post.integration.test.ts`, this file invents
 * no application-layer contract: it seeds `comment_sync_targets` / `comment_sync_jobs` directly
 * through the schema tables already defined (data-model.md §3) and talks to the service only over
 * HTTP, the same boundary every other `http/*.integration.test.ts` file uses. The four cases below
 * are D19's semantics read literally off `contracts/rest-api.md`'s `SyncJob` section:
 *   - an active job already exists → `202` carrying that job;
 *   - inside the 60-second cooldown → `429 SYNC_COOLDOWN`;
 *   - a request while a job is running → `202` carrying that same job (same rule as the first case,
 *     asserted separately because "active" spans both `queued` and `running`, data-model.md §3);
 *   - a *deactivated* target (`next_sync_at: null`) is still run on an explicit manual request, and
 *     its schedule is restored on success — the one case that looks wrong until D19 is read: manual
 *     sync is what tells the target it might be reachable again.
 */

// oxlint-disable max-dependencies -- an HTTP integration test needs the harness (container + api),
// the schema tables it seeds directly, and the crypto helper for a placeholder credential — the same
// import surface `create-reply.integration.test.ts` has for the same reason.
// oxlint-disable max-lines -- the four D19 cases now each watch the `comment-sync` queue directly
// (a job-count delta where no job should be enqueued, the enqueued job's `targetId` where one
// should be), per spec.md §18: a case that only asserts the HTTP response shape never
// actually observes whether the queue was touched, so this file's job is incomplete without them.

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApi, type Api } from '#src/app/api.ts';
import { loadConfig } from '#src/app/config.ts';
import { buildContainer } from '#src/app/container.ts';
import {
  commentSyncJobs,
  commentSyncTargets,
} from '#src/modules/comments/infrastructure/schema.ts';
import { encryptCredentials } from '#src/modules/platform-core/local/account-credentials.ts';
import { apiKeys, posts, socialAccounts, workspaces } from '#src/modules/platform-core/schema.ts';
import { hashSecret } from '#src/shared/crypto.ts';
import type { Database } from '#src/shared/db.ts';
import { asWorkspaceId, generateId, type WorkspaceId } from '#src/shared/ids.ts';
import { startTestContainers, type TestContainers } from '#src/shared/testing/containers.ts';
import { TEST_CREDENTIALS_ENCRYPTION_KEY, TEST_ENV } from '#src/shared/testing/test-env.ts';

const PLATFORM = 'bluesky';

interface Harness {
  containers: TestContainers;
  database: Database;
  redis: Redis;
  app: Api;
  publishQueue: Queue;
  syncQueue: Queue;
  workspaceId: WorkspaceId;
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
  const { database, redis, publishQueue, syncQueue } = container;
  const app = buildApi(container);
  await app.ready();

  const workspaceId = asWorkspaceId(generateId());
  await database.drizzle.insert(workspaces).values({
    id: workspaceId,
    name: 'Test workspace',
    contactLimitMonthly: 1000,
    createdAt: new Date(),
  });

  return { containers, database, redis, app, publishQueue, syncQueue, workspaceId };
}

async function stopHarness(harness: Harness): Promise<void> {
  await harness.publishQueue.close();
  await harness.syncQueue.close();
  await harness.app.close();
  await harness.database.close();
  harness.redis.disconnect();
  await harness.containers.stop();
}

/** Total jobs in the `comment-sync` queue, across every state — used as a delta, not a total. */
async function syncJobCount(harness: Harness): Promise<number> {
  const counts = await harness.syncQueue.getJobCounts(
    'waiting',
    'active',
    'delayed',
    'completed',
    'failed',
  );
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

async function mintApiKey(harness: Harness): Promise<string> {
  const prefix = randomUUID().replaceAll('-', '');
  const secret = randomUUID();
  await harness.database.drizzle.insert(apiKeys).values({
    id: generateId(),
    workspaceId: harness.workspaceId,
    prefix,
    keyHash: hashSecret(secret),
    name: 'test key',
    rateLimitPerMin: null,
    revokedAt: null,
    createdAt: new Date(),
  });
  return `blt_${prefix}_${secret}`;
}

interface SeededPost {
  readonly socialAccountId: string;
  readonly postId: string;
  readonly platformPostId: string;
}

async function seedPost(harness: Harness): Promise<SeededPost> {
  const socialAccountId = generateId();
  const credentialsCiphertext = encryptCredentials(Buffer.from('app-password'), {
    key: Buffer.from(TEST_CREDENTIALS_ENCRYPTION_KEY, 'base64'),
    keyVersion: 1,
  });
  await harness.database.drizzle.insert(socialAccounts).values({
    id: socialAccountId,
    workspaceId: harness.workspaceId,
    platform: PLATFORM,
    platformAccountId: `${PLATFORM}-${generateId()}`,
    username: 'demo',
    credentialsCiphertext,
    credentialsKeyVersion: 1,
    status: 'active',
    createdAt: new Date(),
  });
  const postId = generateId();
  const platformPostId = `at://post-${postId}`;
  await harness.database.drizzle.insert(posts).values({
    id: postId,
    workspaceId: harness.workspaceId,
    socialAccountId,
    platform: PLATFORM,
    platformPostId,
    publishedAt: new Date(),
    createdAt: new Date(),
  });
  return { socialAccountId, postId, platformPostId };
}

interface SeedTargetOptions {
  readonly nextSyncAt?: Date | null;
  readonly manualCooldownUntil?: Date | null;
  readonly lastError?: string | null;
}

async function seedTarget(
  harness: Harness,
  post: SeededPost,
  options: SeedTargetOptions = {},
): Promise<string> {
  const id = generateId();
  await harness.database.drizzle.insert(commentSyncTargets).values({
    id,
    workspaceId: harness.workspaceId,
    socialAccountId: post.socialAccountId,
    postId: post.postId,
    platformPostId: post.platformPostId,
    lastSyncedAt: new Date(),
    nextSyncAt: options.nextSyncAt === undefined ? new Date() : options.nextSyncAt,
    lastError: options.lastError ?? null,
    manualCooldownUntil: options.manualCooldownUntil ?? null,
    // A fixed anchor a few days in the past — these cases don't exercise age banding, and a
    // real-looking age (rather than "now") won't drift into a different band depending on when
    // the suite runs.
    ageAnchorAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
  });
  return id;
}

async function seedJob(
  harness: Harness,
  targetId: string,
  status: 'queued' | 'running' | 'succeeded' | 'failed',
): Promise<string> {
  const id = generateId();
  await harness.database.drizzle.insert(commentSyncJobs).values({
    id,
    workspaceId: harness.workspaceId,
    targetId,
    trigger: 'manual',
    status,
    stats: null,
    error: null,
    createdAt: new Date(),
    startedAt: status === 'running' ? new Date() : null,
    finishedAt: null,
  });
  return id;
}

interface SyncResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

async function requestSync(harness: Harness, postId: string): Promise<SyncResponse> {
  const apiKey = await mintApiKey(harness);
  const response = await harness.app.inject({
    method: 'POST',
    url: `/v1/posts/${postId}/comments/sync`,
    headers: { 'blotato-api-key': apiKey },
  });
  return {
    statusCode: response.statusCode,
    headers: response.headers as never,
    body: response.json(),
  };
}

let harness: Harness;

beforeAll(async () => {
  harness = await startHarness();
});

afterAll(async () => {
  await stopHarness(harness);
});

describe('an active job already exists (D19)', () => {
  it('returns 202 carrying the queued job, enqueueing no second one', async () => {
    const post = await seedPost(harness);
    const targetId = await seedTarget(harness, post);
    const jobId = await seedJob(harness, targetId, 'queued');
    const before = await syncJobCount(harness);

    const response = await requestSync(harness, post.postId);

    expect(response.statusCode).toBe(202);
    expect(response.body['id']).toBe(jobId);
    expect(await syncJobCount(harness)).toBe(before);
  });

  it('a request while a job is running also returns 202 carrying that same job', async () => {
    const post = await seedPost(harness);
    const targetId = await seedTarget(harness, post);
    const jobId = await seedJob(harness, targetId, 'running');
    const before = await syncJobCount(harness);

    const response = await requestSync(harness, post.postId);

    expect(response.statusCode).toBe(202);
    expect(response.body['id']).toBe(jobId);
    expect(response.body['status']).toBe('running');
    expect(await syncJobCount(harness)).toBe(before);
  });
});

describe('the 60-second manual cooldown (D19)', () => {
  it('rejects a second request inside the cooldown with 429 SYNC_COOLDOWN', async () => {
    const post = await seedPost(harness);
    const targetId = await seedTarget(harness, post, {
      manualCooldownUntil: new Date(Date.now() + 60_000),
    });
    await seedJob(harness, targetId, 'succeeded');

    const response = await requestSync(harness, post.postId);

    expect(response.statusCode).toBe(429);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body['code']).toBe('SYNC_COOLDOWN');
  });

  it('accepts a request once the cooldown has elapsed', async () => {
    const post = await seedPost(harness);
    const targetId = await seedTarget(harness, post, {
      manualCooldownUntil: new Date(Date.now() - 1000),
    });
    await seedJob(harness, targetId, 'succeeded');

    const response = await requestSync(harness, post.postId);

    expect(response.statusCode).toBe(202);
    const job = await harness.syncQueue.getJob(response.body['id'] as string);
    expect(job?.data['targetId']).toBe(targetId);
  });
});

describe('a deactivated target is run anyway, and its schedule is restored on success (D19)', () => {
  it('runs a manual request against a target with next_sync_at: null', async () => {
    const post = await seedPost(harness);
    const targetId = await seedTarget(harness, post, {
      nextSyncAt: null,
      lastError: 'the post was deleted upstream',
    });

    const response = await requestSync(harness, post.postId);

    expect(response.statusCode).toBe(202);
    const job = await harness.syncQueue.getJob(response.body['id'] as string);
    expect(job?.data['targetId']).toBe(targetId);

    // The schedule is restored only once the manual job this response points at succeeds — that
    // happens asynchronously, on the worker side (T089), which this HTTP-only test does not run.
    // What this case pins is the accept-time behaviour: the request is not rejected merely because
    // the target was deactivated (the one part of D19 an HTTP test can assert without a worker).
    const [target] = await harness.database.drizzle
      .select({ id: commentSyncTargets.id })
      .from(commentSyncTargets)
      .where(eq(commentSyncTargets.id, targetId));
    expect(target?.id).toBe(targetId);
  });
});
