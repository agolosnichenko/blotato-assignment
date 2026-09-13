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
import { sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Worker, type Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApi, type Api } from '#src/app/api.ts';
import { loadConfig } from '#src/app/config.ts';
import { buildContainer, type Container } from '#src/app/container.ts';
import { createPublishComment } from '#src/modules/comments/application/publish-comment.ts';
import { createAccountHealth } from '#src/modules/comments/infrastructure/account-health.ts';
import {
  createCommentRepository,
  orderByFor,
} from '#src/modules/comments/infrastructure/comment-repository.ts';
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
import { asWorkspaceId, generateId, type WorkspaceId } from '#src/shared/ids.ts';
import type { SortOrder } from '#src/shared/pagination.ts';
import { QUEUE_NAMES } from '#src/shared/queues.ts';
import { startTestContainers, type TestContainers } from '#src/shared/testing/containers.ts';
import { TEST_CREDENTIALS_ENCRYPTION_KEY, TEST_ENV } from '#src/shared/testing/test-env.ts';

const PLATFORM: Platform = 'bluesky';
const TOTAL_COMMENTS = 100_000;
/**
 * The distribution across workspaces/accounts/posts (T017 fix round 2, research.md R-04/R-05): a
 * single workspace and a single social account owning the whole table made `workspace_id` and
 * `social_account_id` both match 100% of rows, so once their pathkeys agreed with the indexes
 * (fix round 1), the planner's choice between `comments_workspace_idx` and
 * `comments_social_account_idx` for the account read was an arbitrary tie at equal cost. Five
 * workspaces of five accounts each makes `workspace_id` a 1-in-5 filter and `social_account_id` a
 * 1-in-25 filter — selective the way they would be in a real deployment, where a workspace holds
 * several accounts and the whole table holds many workspaces. `POSTS_PER_ACCOUNT` keeps
 * `COMMENTS_PER_POST` identical to before this change, so the pre-existing top-level assertion's
 * own selectivity is unaffected.
 */
const WORKSPACE_COUNT = 5;
const ACCOUNTS_PER_WORKSPACE = 5;
const POSTS_PER_ACCOUNT = 20;
const POST_COUNT = WORKSPACE_COUNT * ACCOUNTS_PER_WORKSPACE * POSTS_PER_ACCOUNT;
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
  workspaceId: WorkspaceId;
  socialAccountId: string;
  benchmarkPostId: string;
}

function keyMaterial() {
  return { key: Buffer.from(TEST_CREDENTIALS_ENCRYPTION_KEY, 'base64'), keyVersion: 1 };
}

async function mintApiKey(database: Database, workspaceId: WorkspaceId): Promise<string> {
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

/**
 * One social account with real, decryptable credentials. Every seeded account gets real
 * credentials, not just the primary one the write benchmark publishes through — the accounts this
 * file adds purely to give `social_account_id` genuine selectivity (T017 fix round 2) are cheap
 * enough (25 total) that a second, credential-less code path would only be more code to keep in
 * sync with this one.
 */
async function seedSocialAccount(
  database: Database,
  workspaceId: WorkspaceId,
  label: string,
): Promise<string> {
  const socialAccountId = generateId();
  const credentialsCiphertext = encryptCredentials(Buffer.from('app-password'), keyMaterial());
  await database.drizzle.insert(socialAccounts).values({
    id: socialAccountId,
    workspaceId,
    platform: PLATFORM,
    platformAccountId: `bsky-account-${label}`,
    username: label,
    credentialsCiphertext,
    credentialsKeyVersion: 1,
    status: 'active',
    createdAt: new Date(),
  });
  return socialAccountId;
}

async function seedWorkspace(database: Database, name: string): Promise<WorkspaceId> {
  const workspaceId = asWorkspaceId(generateId());
  await database.drizzle.insert(workspaces).values({
    id: workspaceId,
    name,
    contactLimitMonthly: 1_000_000,
    createdAt: new Date(),
  });
  return workspaceId;
}

/** The `workspaceIndex`th workspace — index 0 is the caller's already-seeded primary workspace. */
function resolveWorkspace(
  database: Database,
  primaryWorkspaceId: WorkspaceId,
  workspaceIndex: number,
): Promise<WorkspaceId> {
  if (workspaceIndex === 0) {
    return Promise.resolve(primaryWorkspaceId);
  }
  return seedWorkspace(database, `Benchmark workspace ${workspaceIndex}`);
}

/**
 * The `accountIndex`th account of `workspaceId` — workspace 0's account 0 is the caller's
 * already-seeded, already-credentialed primary account, the one the write benchmark publishes
 * through and the read benchmark/top-level `EXPLAIN` assertion reads through.
 */
function resolveSocialAccount(
  database: Database,
  workspaceId: WorkspaceId,
  primarySocialAccountId: string,
  workspaceIndex: number,
  accountIndex: number,
): Promise<string> {
  if (workspaceIndex === 0 && accountIndex === 0) {
    return Promise.resolve(primarySocialAccountId);
  }
  return seedSocialAccount(database, workspaceId, `${workspaceIndex}-${accountIndex}`);
}

/**
 * Buffers comment rows and flushes them in `SEED_CHUNK_SIZE` multi-row inserts — one round trip
 * per row would make a 100,000-row seed too slow for anyone to actually run this file. Pulled out
 * of `seedDistributedComments` so pushing a row doesn't add another level of nesting there.
 */
interface CommentBuffer {
  push(row: CommentInsert): Promise<void>;
  flush(): Promise<void>;
}

function createCommentBuffer(database: Database): CommentBuffer {
  let pending: CommentInsert[] = [];
  return {
    async push(row) {
      pending.push(row);
      if (pending.length >= SEED_CHUNK_SIZE) {
        await database.drizzle.insert(comments).values(pending);
        pending = [];
      }
    },
    async flush() {
      if (pending.length > 0) {
        await database.drizzle.insert(comments).values(pending);
        pending = [];
      }
    },
  };
}

/**
 * Seeds `POSTS_PER_ACCOUNT` posts for one account, starting the post-numbering (used only for
 * `platformPostId` uniqueness and spacing `occurredAt`) at `startPostIndex`, pushing every comment
 * into `buffer` rather than returning them — keeps `seedDistributedComments`'s own nesting within
 * the project's depth limit. Returns the account's first post's id, so the caller can note it as
 * the `benchmarkPostId` when this is workspace 0's account 0.
 */
async function seedAccountPostsAndComments(
  database: Database,
  workspaceId: WorkspaceId,
  socialAccountId: string,
  startPostIndex: number,
  base: number,
  buffer: CommentBuffer,
): Promise<string> {
  let firstPostId = '';
  for (let postSlot = 0; postSlot < POSTS_PER_ACCOUNT; postSlot += 1) {
    const postIndex = startPostIndex + postSlot;
    // oxlint-disable-next-line no-await-in-loop
    const postId = await seedPost(database, workspaceId, socialAccountId, postIndex);
    if (postSlot === 0) {
      firstPostId = postId;
    }
    for (let commentIndex = 0; commentIndex < COMMENTS_PER_POST; commentIndex += 1) {
      const occurredAt = new Date(base + postIndex * COMMENTS_PER_POST + commentIndex);
      // oxlint-disable-next-line no-await-in-loop
      await buffer.push(buildComment(workspaceId, socialAccountId, postId, occurredAt));
    }
  }
  return firstPostId;
}

async function seedPost(
  database: Database,
  workspaceId: WorkspaceId,
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
  workspaceId: WorkspaceId,
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

interface DistributionResult {
  readonly benchmarkPostId: string;
}

/**
 * Bulk-seeds `WORKSPACE_COUNT` workspaces, `ACCOUNTS_PER_WORKSPACE` accounts each,
 * `POSTS_PER_ACCOUNT` posts per account and `TOTAL_COMMENTS` comments spread evenly across every
 * post, in chunked multi-row inserts rather than one round trip per row — a 100,000-row seed that
 * took minutes would protect nothing, because nobody would run the file. `primaryWorkspaceId`/
 * `primarySocialAccountId` are workspace 0's account 0 (T017 fix round 2) — already seeded by the
 * caller with real credentials, and reused here rather than re-created, so the harness's read/write
 * benchmarks and the `EXPLAIN` assertions all run against the same slice. Returns the id of that
 * account's first post, to run the read benchmark and the top-level `EXPLAIN` assertion against.
 */
async function seedDistributedComments(
  database: Database,
  primaryWorkspaceId: WorkspaceId,
  primarySocialAccountId: string,
): Promise<DistributionResult> {
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  const buffer = createCommentBuffer(database);
  let benchmarkPostId = '';
  let globalPostIndex = 0;

  for (let workspaceIndex = 0; workspaceIndex < WORKSPACE_COUNT; workspaceIndex += 1) {
    // oxlint-disable-next-line no-await-in-loop
    const workspaceId = await resolveWorkspace(database, primaryWorkspaceId, workspaceIndex);

    for (let accountIndex = 0; accountIndex < ACCOUNTS_PER_WORKSPACE; accountIndex += 1) {
      // oxlint-disable-next-line no-await-in-loop
      const socialAccountId = await resolveSocialAccount(
        database,
        workspaceId,
        primarySocialAccountId,
        workspaceIndex,
        accountIndex,
      );
      // oxlint-disable-next-line no-await-in-loop
      const firstPostId = await seedAccountPostsAndComments(
        database,
        workspaceId,
        socialAccountId,
        globalPostIndex,
        base,
        buffer,
      );
      globalPostIndex += POSTS_PER_ACCOUNT;
      if (workspaceIndex === 0 && accountIndex === 0) {
        benchmarkPostId = firstPostId;
      }
    }
  }

  await buffer.flush();

  // Without this, the planner works off the empty-table defaults autovacuum has not yet
  // replaced with real statistics, and picks bitmap/sort plans no production table this size
  // would run — a seed artifact, not a claim about the indexes themselves (T017).
  await database.drizzle.execute(sql`ANALYZE ${comments}`);

  return { benchmarkPostId };
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

  const workspaceId = await seedWorkspace(database, 'Benchmark workspace');
  const socialAccountId = await seedSocialAccount(database, workspaceId, 'benchmark');
  const { benchmarkPostId } = await seedDistributedComments(database, workspaceId, socialAccountId);

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

/** The `visibleInList` placeholder filter (`comment-repository.ts`), spelled out as raw SQL. */
const VISIBLE_IN_LIST_SQL = sql`(status <> 'deleted' OR reply_count > 0)`;

/** The predicate `listTopLevelByPost` runs — workspace + post + top-level, plus the placeholder filter. */
function topLevelPredicate(workspaceId: WorkspaceId, postId: string): SQL {
  return sql`workspace_id = ${workspaceId}
    AND post_id = ${postId}
    AND parent_comment_id IS NULL
    AND ${VISIBLE_IN_LIST_SQL}`;
}

/** The predicate `listRepliesByParent` runs — workspace + parent, plus the placeholder filter. */
function repliesPredicate(workspaceId: WorkspaceId, parentCommentId: string): SQL {
  return sql`workspace_id = ${workspaceId}
    AND parent_comment_id = ${parentCommentId}
    AND ${VISIBLE_IN_LIST_SQL}`;
}

/**
 * The predicate `listByAccount` runs with its own optional `since`/`until`/`isOwn` filters absent —
 * workspace + account, plus the placeholder filter.
 */
function accountPredicate(workspaceId: WorkspaceId, socialAccountId: string): SQL {
  return sql`workspace_id = ${workspaceId}
    AND social_account_id = ${socialAccountId}
    AND ${VISIBLE_IN_LIST_SQL}`;
}

/** The predicate `list` runs for the unfiltered `GET /v1/comments` selection — workspace scope alone (D31). */
function workspacePredicate(workspaceId: WorkspaceId): SQL {
  return sql`workspace_id = ${workspaceId} AND ${VISIBLE_IN_LIST_SQL}`;
}

/**
 * The `ORDER BY` for one direction, built from `orderByFor` (`comment-repository.ts`) itself
 * rather than a second, hand-typed copy of its `NULLS LAST` column list (T017 fix round 3) — a
 * hand-typed copy agrees with `orderByFor` only until one side's column reference changes, and
 * nothing but a human re-reading both would catch the drift; calling the same function the
 * repository calls makes that impossible instead of merely unlikely.
 */
function explainOrderBy(order: SortOrder): SQL {
  return sql.join(orderByFor(order), sql`, `);
}

/**
 * `EXPLAIN (FORMAT JSON)` on one predicate/order pair, limited the same way `listByPredicate`
 * limits its own query (`limit + 1`, here a fixed 21 to match the harness's `limit=20` reads) —
 * the structural half of the read budget (module docstring). Returns the root plan node.
 */
async function explainQuery(
  db: NodePgDatabase,
  predicate: SQL,
  order: SQL,
): Promise<Record<string, unknown>> {
  const rows = await db.execute<{ 'QUERY PLAN': [{ Plan: Record<string, unknown> }] }>(sql`
    EXPLAIN (FORMAT JSON)
    SELECT id FROM comments
    WHERE ${predicate}
    ORDER BY ${order}
    LIMIT 21
  `);
  const [row] = rows.rows;
  if (row === undefined) {
    throw new Error('explainQuery: EXPLAIN returned no row');
  }
  return row['QUERY PLAN'][0].Plan;
}

/** Flattens a plan tree into every node it contains, root first. */
function planNodes(plan: Record<string, unknown>): Record<string, unknown>[] {
  const nodes = [plan];
  const children = plan['Plans'];
  if (Array.isArray(children)) {
    for (const child of children) {
      nodes.push(...planNodes(child as Record<string, unknown>));
    }
  }
  return nodes;
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

/**
 * Asserts the plan scans `indexName` by name (T017) — not just *some* index, which a flip to
 * `comments_workspace_idx` on one of the three preserved reads would satisfy just as well
 * (research.md R-04) — and that it does so with no `Seq Scan` and no `Sort` node: the index must
 * supply both the rows and the ordering, not just one of the two.
 */
function assertPlanUsesIndex(plan: Record<string, unknown>, indexName: string): void {
  const nodes = planNodes(plan);
  expect(
    nodes.some((node) => node['Index Name'] === indexName),
    `expected index ${indexName} in the plan, got: ${JSON.stringify(plan)}`,
  ).toBe(true);
  expect(
    nodes.some((node) => node['Node Type'] === 'Seq Scan'),
    `expected no sequential scan in the plan, got: ${JSON.stringify(plan)}`,
  ).toBe(false);
  expect(
    nodes.some((node) => node['Node Type'] === 'Sort'),
    `expected no sort node in the plan, got: ${JSON.stringify(plan)}`,
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

    const plan = await explainQuery(
      harness.database.drizzle,
      topLevelPredicate(harness.workspaceId, harness.benchmarkPostId),
      explainOrderBy('desc'),
    );
    assertPlanUsesIndex(plan, 'comments_post_top_level_idx');

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

/**
 * T017 (FR-013, research.md R-04, quickstart.md V7): the three EXPLAIN assertions the preserved
 * reads gained once `comments_workspace_idx` became a candidate for them too — each pinned to the
 * narrower index it had before the flat listing's index was added, not just to "some" index.
 */
function registerPreservedReadPlanTests(getHarness: () => Harness): void {
  it('lists replies via an index scan on comments_replies_idx', async () => {
    const harness = getHarness();
    const plan = await explainQuery(
      harness.database.drizzle,
      repliesPredicate(harness.workspaceId, generateId()),
      explainOrderBy('asc'),
    );
    assertPlanUsesIndex(plan, 'comments_replies_idx');
  });

  it('lists an account inbox via an index scan on comments_social_account_idx', async () => {
    const harness = getHarness();
    const plan = await explainQuery(
      harness.database.drizzle,
      accountPredicate(harness.workspaceId, harness.socialAccountId),
      explainOrderBy('desc'),
    );
    assertPlanUsesIndex(plan, 'comments_social_account_idx');
  });
}

/**
 * T017 (FR-013, D31, research.md R-05, quickstart.md V7): the unfiltered `GET /v1/comments`
 * selection — no filter beyond the workspace scope — via `comments_workspace_idx`.
 */
function registerFlatListingPlanTest(getHarness: () => Harness): void {
  it('lists the unfiltered workspace collection via an index scan on comments_workspace_idx', async () => {
    const harness = getHarness();
    const plan = await explainQuery(
      harness.database.drizzle,
      workspacePredicate(harness.workspaceId),
      explainOrderBy('desc'),
    );
    assertPlanUsesIndex(plan, 'comments_workspace_idx');
  });
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
  registerPreservedReadPlanTests(() => harness);
  registerFlatListingPlanTest(() => harness);
});
