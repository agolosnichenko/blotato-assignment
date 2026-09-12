// oxlint-disable max-dependencies -- an integration test harness wires together the same set of
// modules the composition root does (config, db, redis, api, schema, crypto, ids, containers),
// plus the publish use case and an adapter double — see the same justification on
// src/app/container.ts and src/app/api.ts.
// oxlint-disable max-lines -- one seeded workspace, a bulk seed helper, a read benchmark and a
// write benchmark each need their own setup; splitting them would duplicate the harness instead
// of shrinking the real work (T104).

/**
 * The seeded performance budget (T104, SC-005, SC-006).
 *
 * A21 designs no SLA and A22 puts metrics out of scope, so nothing in production measures a
 * percentile — this file is a **build-time budget**, not a service level. Its only job is to fail
 * when a query plan degrades: someone drops `comments_post_top_level_idx`, or writes a predicate
 * the index cannot serve, and a post's comment page goes from an index scan over ~200 rows to a
 * sequential scan over the whole 100,000-row table. A wall-clock number on a shared CI machine is
 * the flakiest kind of assertion, so the read benchmark makes the real claim twice: once
 * structurally, via `EXPLAIN` on the exact predicate `listTopLevelByPost` runs (proving an index
 * scan is actually chosen), and once as a secondary, time-boxed signal (p95 under budget) for the
 * regression an `EXPLAIN` check alone could still miss — a chosen index that is itself bloated or
 * unusably large, say.
 *
 * SC-006's claim is different in kind: the write path is asynchronous (`POST` commits the row and
 * enqueues a job; the platform call happens later, in a worker), so "the write acknowledgement is
 * independent of platform latency" is a claim about the *architecture*, not about speed. Proving
 * it requires an adapter that actually stalls for multiple seconds while comments are being
 * posted — if the acknowledgement could be slowed by that stall, something has become
 * synchronous that SC-006 says must not be. `createPublishComment` (the same use case
 * `publish-comment.integration.test.ts` drives directly) is wired here to a small worker of this
 * file's own, processing the real `comment-publish` queue the HTTP route enqueues onto, so the
 * stall is genuinely in the path a production worker would run — just with a double standing in
 * for a platform call, the same substitution the failure-matrix test makes.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Worker, type Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApi, type Api } from '#src/app/api.ts';
import { loadConfig } from '#src/app/config.ts';
import { buildContainer, type Container } from '#src/app/container.ts';
import { createPublishComment } from '#src/modules/comments/application/publish-comment.ts';
import { createAccountHealth } from '#src/modules/comments/infrastructure/account-health.ts';
import { createCommentRepository } from '#src/modules/comments/infrastructure/comment-repository.ts';
import { createContactQuota } from '#src/modules/comments/infrastructure/contact-quota.ts';
import { comments } from '#src/modules/comments/infrastructure/schema.ts';
import {
  createLocalAccountCredentials,
  encryptCredentials,
} from '#src/modules/platform-core/local/account-credentials.ts';
import { createLocalAccounts } from '#src/modules/platform-core/local/accounts.ts';
import { apiKeys, posts, socialAccounts, workspaces } from '#src/modules/platform-core/schema.ts';
import type { CommentPlatformAdapter, Platform, PublishedComment } from '#src/platforms/types.ts';
import { hashSecret } from '#src/shared/crypto.ts';
import type { Database } from '#src/shared/db.ts';
import { generateId } from '#src/shared/ids.ts';
import { QUEUE_NAMES } from '#src/shared/queues.ts';
import { startTestContainers, type TestContainers } from '#src/shared/testing/containers.ts';
import { TEST_CREDENTIALS_ENCRYPTION_KEY, TEST_ENV } from '#src/shared/testing/test-env.ts';

const PLATFORM: Platform = 'bluesky';
const TOTAL_COMMENTS = 100_000;
const POST_COUNT = 500;
const COMMENTS_PER_POST = TOTAL_COMMENTS / POST_COUNT;
const SEED_CHUNK_SIZE = 1000;
const READ_BUDGET_MS = 300;
const WRITE_BUDGET_MS = 300;
/** Long enough that a synchronous write path would blow the budget many times over. */
const ADAPTER_STALL_MS = 3000;

interface Harness {
  containers: TestContainers;
  container: Container;
  database: Database;
  app: Api;
  workspaceId: string;
  socialAccountId: string;
  benchmarkPostId: string;
}

function keyMaterial() {
  return { key: Buffer.from(TEST_CREDENTIALS_ENCRYPTION_KEY, 'base64'), keyVersion: 1 };
}

async function mintApiKey(database: Database, workspaceId: string): Promise<string> {
  const prefix = randomBytes(6).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  await database.drizzle.insert(apiKeys).values({
    id: generateId(),
    workspaceId,
    prefix,
    keyHash: hashSecret(secret),
    name: 'benchmark key',
    rateLimitPerMin: null,
    revokedAt: null,
    createdAt: new Date(),
  });
  return `blt_${prefix}_${secret}`;
}

/** One social account with real, decryptable credentials — the write benchmark publishes through it. */
async function seedSocialAccount(database: Database, workspaceId: string): Promise<string> {
  const socialAccountId = generateId();
  const credentialsCiphertext = encryptCredentials(Buffer.from('app-password'), keyMaterial());
  await database.drizzle.insert(socialAccounts).values({
    id: socialAccountId,
    workspaceId,
    platform: PLATFORM,
    platformAccountId: 'bsky-benchmark-account',
    username: 'benchmark',
    credentialsCiphertext,
    credentialsKeyVersion: 1,
    status: 'active',
    createdAt: new Date(),
  });
  return socialAccountId;
}

async function seedPost(
  database: Database,
  workspaceId: string,
  socialAccountId: string,
  index: number,
) {
  const postId = generateId();
  await database.drizzle.insert(posts).values({
    id: postId,
    workspaceId,
    socialAccountId,
    platform: PLATFORM,
    platformPostId: `bsky-post-${index}`,
    publishedAt: new Date(),
    createdAt: new Date(),
  });
  return postId;
}

type CommentInsert = typeof comments.$inferInsert;

function buildComment(
  workspaceId: string,
  socialAccountId: string,
  postId: string,
  occurredAt: Date,
): CommentInsert {
  const id = generateId();
  return {
    id,
    workspaceId,
    socialAccountId,
    platform: PLATFORM,
    postId,
    platformPostId: `bsky-post-of-${postId}`,
    parentCommentId: null,
    rootCommentId: null,
    depth: 0,
    platformCommentId: `bsky-comment-${id}`,
    isOwn: false,
    source: 'sync',
    authorPlatformId: `author-${id}`,
    authorUsername: `author-${id}`,
    authorDisplayName: null,
    text: `seeded comment ${id}`,
    status: 'posted',
    replyCount: 0,
    lastActivityAt: occurredAt,
    occurredAt,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
}

/**
 * Bulk-seeds `POST_COUNT` posts and `TOTAL_COMMENTS` comments spread evenly across them, in
 * chunked multi-row inserts rather than one round trip per row — a 100,000-row seed that took
 * minutes would protect nothing, because nobody would run the file. Returns the id of one post to
 * run the read benchmark against.
 */
async function seedManyPostsAndComments(
  database: Database,
  workspaceId: string,
  socialAccountId: string,
): Promise<string> {
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  let benchmarkPostId = '';
  let pending: CommentInsert[] = [];

  for (let postIndex = 0; postIndex < POST_COUNT; postIndex += 1) {
    // Posts are few enough (500) to insert one at a time without a second bulk path; the bulk
    // seed this function exists for is the 100,000-row comments table.
    // oxlint-disable-next-line no-await-in-loop
    const postId = await seedPost(database, workspaceId, socialAccountId, postIndex);
    if (postIndex === 0) {
      benchmarkPostId = postId;
    }
    for (let commentIndex = 0; commentIndex < COMMENTS_PER_POST; commentIndex += 1) {
      const occurredAt = new Date(base + postIndex * COMMENTS_PER_POST + commentIndex);
      pending.push(buildComment(workspaceId, socialAccountId, postId, occurredAt));
      if (pending.length >= SEED_CHUNK_SIZE) {
        // oxlint-disable-next-line no-await-in-loop
        await database.drizzle.insert(comments).values(pending);
        pending = [];
      }
    }
  }
  if (pending.length > 0) {
    await database.drizzle.insert(comments).values(pending);
  }

  return benchmarkPostId;
}

async function startHarness(): Promise<Harness> {
  const containers = await startTestContainers();
  const config = loadConfig({
    ...TEST_ENV,
    LOG_LEVEL: 'silent',
    DATABASE_URL: containers.databaseUrl,
    REDIS_URL: containers.redisUrl,
    // The benchmark issues far more requests per minute than the production defaults (30
    // reads / 5 writes) allow from one API key — raising the limit here is how this file avoids
    // minting hundreds of keys just to stay under a budget unrelated to what it measures.
    RATE_LIMIT_READS_PER_MIN: '100000',
    RATE_LIMIT_WRITES_PER_MIN: '100000',
  });
  const container = buildContainer({ config });
  const { database } = container;
  const app = buildApi(container);
  await app.ready();

  const workspaceId = generateId();
  await database.drizzle.insert(workspaces).values({
    id: workspaceId,
    name: 'Benchmark workspace',
    contactLimitMonthly: 1_000_000,
    createdAt: new Date(),
  });
  const socialAccountId = await seedSocialAccount(database, workspaceId);
  const benchmarkPostId = await seedManyPostsAndComments(database, workspaceId, socialAccountId);

  return { containers, container, database, app, workspaceId, socialAccountId, benchmarkPostId };
}

async function stopHarness(harness: Harness): Promise<void> {
  await harness.app.close();
  await harness.container.close();
  await harness.containers.stop();
}

function percentile(samplesMs: readonly number[], p: number): number {
  const sorted = [...samplesMs].toSorted((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

async function measureReadLatencies(
  harness: Harness,
  apiKey: string,
  count: number,
): Promise<number[]> {
  const samplesMs: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const startedAt = performance.now();
    // Sequential, not Promise.all: a p95 over concurrent requests measures queueing under load,
    // not the query plan this file exists to pin — see the module docstring.
    // oxlint-disable-next-line no-await-in-loop
    const response = await harness.app.inject({
      method: 'GET',
      url: `/v1/posts/${harness.benchmarkPostId}/comments?limit=20`,
      headers: { 'blotato-api-key': apiKey },
    });
    samplesMs.push(performance.now() - startedAt);
    expect(response.statusCode).toBe(200);
  }
  return samplesMs;
}

/**
 * `EXPLAIN (FORMAT JSON)` on exactly the predicate `listTopLevelByPost` runs (workspace + post +
 * top-level + the `visibleInList` placeholder filter, ordered and limited the same way) — the
 * structural half of the read budget (module docstring). Returns the root plan node.
 */
async function explainTopLevelQuery(
  db: NodePgDatabase,
  workspaceId: string,
  postId: string,
): Promise<Record<string, unknown>> {
  const rows = await db.execute<{ 'QUERY PLAN': [{ Plan: Record<string, unknown> }] }>(sql`
    EXPLAIN (FORMAT JSON)
    SELECT id FROM comments
    WHERE workspace_id = ${workspaceId}
      AND post_id = ${postId}
      AND parent_comment_id IS NULL
      AND (status <> 'deleted' OR reply_count > 0)
    ORDER BY occurred_at DESC, id DESC
    LIMIT 21
  `);
  const [row] = rows.rows;
  if (row === undefined) {
    throw new Error('explainTopLevelQuery: EXPLAIN returned no row');
  }
  return row['QUERY PLAN'][0].Plan;
}

/** Walks the plan tree looking for any node whose name matches `predicate`. */
function planContains(
  plan: Record<string, unknown>,
  predicate: (nodeType: string) => boolean,
): boolean {
  const nodeType = plan['Node Type'];
  if (typeof nodeType === 'string' && predicate(nodeType)) {
    return true;
  }
  const children = plan['Plans'];
  if (!Array.isArray(children)) {
    return false;
  }
  return children.some((child: unknown) =>
    planContains(child as Record<string, unknown>, predicate),
  );
}

// oxlint-disable require-await -- `listComments`/`findPublishedComment`/`fetchComment` implement
// an async port interface but are never called by the write benchmark; only `publishComment`
// needs the real stall.
/** A publish adapter that stalls every call for `ADAPTER_STALL_MS` before succeeding. */
function createStallingAdapter(): CommentPlatformAdapter {
  let sendCount = 0;
  return {
    platform: PLATFORM,
    async listComments(): Promise<never> {
      throw new Error('listComments is not exercised by the write benchmark');
    },
    async publishComment(): Promise<PublishedComment> {
      await sleep(ADAPTER_STALL_MS);
      sendCount += 1;
      return { platformCommentId: `platform-comment-${sendCount}`, platformCreatedAt: new Date() };
    },
    async findPublishedComment(): Promise<null> {
      return null;
    },
    async fetchComment(): Promise<null> {
      throw new Error('fetchComment is not exercised by the write benchmark');
    },
  };
}

/**
 * A minimal `comment-publish` worker, wired the same way `publish-worker.ts` wires
 * `createPublishComment` (database, repository, contact quota, accounts, credentials, account
 * health) but pointed at {@link createStallingAdapter} instead of the real per-platform registry —
 * the same substitution `publish-comment.integration.test.ts`'s double makes, here driven through
 * the real queue rather than called directly, so the stall sits in the path a production worker
 * would run.
 */
function startStallingPublishWorker(harness: Harness): Worker {
  const db = harness.database.drizzle;
  const publishComment = createPublishComment({
    database: db,
    commentRepository: createCommentRepository(db),
    contactQuota: createContactQuota(db, harness.container.ports.workspaces),
    accounts: createLocalAccounts(db),
    accountCredentials: createLocalAccountCredentials(db, keyMaterial()),
    accountHealth: createAccountHealth(db),
    getAdapter: () => createStallingAdapter(),
  });

  return new Worker(
    QUEUE_NAMES.commentPublish,
    async (job: Job) => {
      await publishComment.publish(job.id as string);
    },
    { connection: harness.container.redis, concurrency: 10 },
  );
}

/** A fresh, posted top-level comment the write benchmark replies to, so every POST is a reply. */
async function seedReplyTarget(harness: Harness): Promise<string> {
  const id = generateId();
  const now = new Date();
  await harness.database.drizzle.insert(comments).values({
    id,
    workspaceId: harness.workspaceId,
    socialAccountId: harness.socialAccountId,
    platform: PLATFORM,
    postId: null,
    platformPostId: 'bsky-post-write-benchmark',
    parentCommentId: null,
    rootCommentId: null,
    depth: 0,
    platformCommentId: `bsky-comment-${id}`,
    isOwn: false,
    source: 'sync',
    authorPlatformId: `author-${id}`,
    authorUsername: `author-${id}`,
    authorDisplayName: null,
    text: 'reply target',
    status: 'posted',
    replyCount: 0,
    lastActivityAt: now,
    occurredAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function measureWriteLatencies(
  harness: Harness,
  apiKey: string,
  parentCommentId: string,
  count: number,
): Promise<number[]> {
  const samplesMs: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const startedAt = performance.now();
    // Sequential for the same reason the read loop is: this measures one request's
    // acknowledgement latency at a time, not queueing across concurrent requests.
    // oxlint-disable-next-line no-await-in-loop
    const response = await harness.app.inject({
      method: 'POST',
      url: `/v1/comments/${parentCommentId}/replies`,
      headers: { 'blotato-api-key': apiKey },
      payload: { text: `benchmark reply ${i}` },
    });
    samplesMs.push(performance.now() - startedAt);
    expect(response.statusCode).toBe(202);
  }
  return samplesMs;
}

/** Asserts the plan used an index and, separately, that it used no sequential scan. */
function assertPlanUsesIndex(plan: Record<string, unknown>): void {
  expect(
    planContains(plan, (nodeType) => nodeType.includes('Index')),
    `expected an index scan in the plan, got: ${JSON.stringify(plan)}`,
  ).toBe(true);
  expect(
    planContains(plan, (nodeType) => nodeType === 'Seq Scan'),
    `expected no sequential scan in the plan, got: ${JSON.stringify(plan)}`,
  ).toBe(false);
}

/**
 * The read half of the budget (SC-005): an index scan on `comments_post_top_level_idx` (the
 * structural claim), and a secondary p95-under-budget timing over a post with real company among
 * 100,000 rows (module docstring).
 */
function registerReadBenchmarkTest(getHarness: () => Harness): void {
  it('reads a post page via an index scan, p95 under budget at 100,000 comments (SC-005)', async () => {
    const harness = getHarness();
    const apiKey = await mintApiKey(harness.database, harness.workspaceId);

    const plan = await explainTopLevelQuery(
      harness.database.drizzle,
      harness.workspaceId,
      harness.benchmarkPostId,
    );
    assertPlanUsesIndex(plan);

    // Warm up the connection pool and query plan cache before timing — the first request on a
    // fresh pool measures connection setup, not the query (module docstring).
    await measureReadLatencies(harness, apiKey, 5);

    const samplesMs = await measureReadLatencies(harness, apiKey, 30);
    const p95 = percentile(samplesMs, 95);
    expect(
      p95,
      `read p95 ${p95.toFixed(1)}ms over samples ${JSON.stringify(samplesMs)}`,
    ).toBeLessThan(READ_BUDGET_MS);
  }, 60_000);
}

/**
 * The write half of the budget (SC-006): the acknowledgement's p95 while a real worker, wired to
 * an adapter double that stalls every call for `ADAPTER_STALL_MS`, is actively draining the same
 * queue the `POST` route just enqueued onto (module docstring).
 */
function registerWriteBenchmarkTest(getHarness: () => Harness): void {
  it('acknowledges a write at p95 under budget while the adapter double stalls (SC-006)', async () => {
    const harness = getHarness();
    const worker = startStallingPublishWorker(harness);
    await worker.waitUntilReady();
    try {
      const apiKey = await mintApiKey(harness.database, harness.workspaceId);
      const parentCommentId = await seedReplyTarget(harness);

      // Warm up for the same reason the read benchmark does, and to get a few jobs flowing
      // through the stalling worker before the timed run starts.
      await measureWriteLatencies(harness, apiKey, parentCommentId, 3);

      const samplesMs = await measureWriteLatencies(harness, apiKey, parentCommentId, 20);
      const p95 = percentile(samplesMs, 95);
      expect(
        p95,
        `write p95 ${p95.toFixed(1)}ms over samples ${JSON.stringify(samplesMs)} — the adapter ` +
          `double stalls ${ADAPTER_STALL_MS}ms per call, so this failing means the ` +
          `acknowledgement started waiting on it`,
      ).toBeLessThan(WRITE_BUDGET_MS);
    } finally {
      await worker.close();
    }
  }, 60_000);
}

describe('seeded performance budget (T104, SC-005, SC-006)', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness();
  }, 180_000);

  afterAll(async () => {
    await stopHarness(harness);
  });

  registerReadBenchmarkTest(() => harness);
  registerWriteBenchmarkTest(() => harness);
});
