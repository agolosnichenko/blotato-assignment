/**
 * Every repeatable selector and the two request-path target lookups reach their own index (spec.md
 * §18 "Polling selectors, two request-path reads and the thread-root reference are indexed").
 *
 * These queries are cheap on a test-sized table whether or not an index serves them, so latency
 * proves nothing here. Instead the database runs with `enable_seqscan = off`, each case seeds
 * {@link NOISE_ROWS} rows its query must not need, drives the *real* code path, and reads
 * `pg_stat_user_indexes`: the index named for that path must have been scanned, and must have
 * handed back only a few entries.
 *
 * Both halves are needed. With sequential scans disabled the planner will read a whole index
 * rather than the table, and a full index scan moves the scan counter too — so a predicate that no
 * longer matches its index still "uses" it. Only the tuples-read bound tells a selective read from
 * a disguised full scan. No query text is copied into this file, so there is nothing to drift.
 */

// oxlint-disable max-dependencies, max-lines -- one integration test driving six independent code
// paths (scheduler, relay, sweeper, listing, walk, purge), each needing its own module, seed rows and
// noise rows; splitting it would duplicate the statistics harness each case depends on.

import { Queue } from 'bullmq';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Redis } from 'ioredis';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '#src/app/config.ts';
import { createIngestComments } from '#src/modules/comments/application/ingest-comments.ts';
import { createPurgeRetention } from '#src/modules/comments/application/purge-retention.ts';
import { createSyncPost, type SyncPost } from '#src/modules/comments/application/sync-post.ts';
import { createAccountHealth } from '#src/modules/comments/infrastructure/account-health.ts';
import { createCommentRepository } from '#src/modules/comments/infrastructure/comment-repository.ts';
import { relayOutboxBatch } from '#src/modules/comments/infrastructure/outbox-relay.ts';
import {
  comments,
  commentSyncTargets,
  outboxEvents,
  webhookDeliveries,
} from '#src/modules/comments/infrastructure/schema.ts';
import { createWebhookDeliverySweeper } from '#src/modules/comments/infrastructure/sweepers.ts';
import { createSyncScheduler } from '#src/modules/comments/infrastructure/sync-scheduler.ts';
import { createSyncTargetRepository } from '#src/modules/comments/infrastructure/sync-target-repository.ts';
import { found, type AccountCredentials, type Accounts } from '#src/modules/platform-core/ports.ts';
import type { CommentPlatformAdapter } from '#src/platforms/types.ts';
import { createDatabase, type Database } from '#src/shared/db.ts';
import { asWorkspaceId, generateId, type WorkspaceId } from '#src/shared/ids.ts';
import { createRedis } from '#src/shared/queue.ts';
import { QUEUE_NAMES } from '#src/shared/queues.ts';
import { startTestContainers, type TestContainers } from '#src/shared/testing/containers.ts';
import { TEST_ENV } from '#src/shared/testing/test-env.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

interface Harness {
  containers: TestContainers;
  database: Database;
  db: NodePgDatabase;
  statsPool: Pool;
  redis: Redis;
  config: ReturnType<typeof loadConfig>;
}

let harness: Harness;

beforeAll(async () => {
  const containers = await startTestContainers();
  const statsPool = new Pool({ connectionString: containers.databaseUrl });
  // Applies to every connection opened after this — the ones `createDatabase` opens below.
  await statsPool.query(
    `DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET enable_seqscan = off', current_database()); END $$`,
  );
  const config = loadConfig({
    ...TEST_ENV,
    LOG_LEVEL: 'silent',
    DATABASE_URL: containers.databaseUrl,
    REDIS_URL: containers.redisUrl,
  });
  const database = createDatabase(config);
  const redis = createRedis(config);
  harness = { containers, database, db: database.drizzle, statsPool, redis, config };
});

afterAll(async () => {
  harness.redis.disconnect();
  await harness.database.close();
  await harness.statsPool.end();
  await harness.containers.stop();
});

/** Rows each case seeds that its query must skip — far above {@link MAX_TUPLES_READ}. */
const NOISE_ROWS = 500;
/** Generous for a selective read here; a full scan over the noise reads {@link NOISE_ROWS}. */
const MAX_TUPLES_READ = 20;

interface IndexStats {
  readonly scans: number;
  readonly tuplesRead: number;
}

async function indexStats(indexName: string): Promise<IndexStats> {
  const result = await harness.statsPool.query<{ idx_scan: string; idx_tup_read: string }>(
    'select idx_scan, idx_tup_read from pg_stat_user_indexes where indexrelname = $1',
    [indexName],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`index ${indexName} does not exist`);
  }
  return { scans: Number(row.idx_scan), tuplesRead: Number(row.idx_tup_read) };
}

/**
 * Runs `action` on a database handle of its own and asserts `indexName` was scanned selectively.
 *
 * The handle is closed before reading: an idle backend flushes its statistics on a timer of up to
 * ten seconds, while one that exits flushes them on the way out — so closing it is what makes the
 * counters observable without sleeping.
 */
async function expectReadSelectively(
  indexName: string,
  action: (database: Database) => Promise<unknown>,
): Promise<void> {
  // Statistics as a deployed database has them. Without, two indexes sharing a leading column cost
  // the same to the planner, and an unrelated lookup in the same code path can pick this index and
  // read past its own rows — a test artifact the bound would report as this query's fault.
  await harness.statsPool.query('analyze');
  const before = await indexStats(indexName);
  const database = createDatabase(harness.config);
  try {
    await action(database);
  } finally {
    await database.close();
  }
  await expect
    .poll(async () => (await indexStats(indexName)).scans, { timeout: 5000, interval: 100 })
    .toBeGreaterThan(before.scans);
  const after = await indexStats(indexName);
  expect(after.tuplesRead - before.tuplesRead).toBeLessThanOrEqual(MAX_TUPLES_READ);
}

function noise<T>(build: (index: number) => T): T[] {
  return Array.from({ length: NOISE_ROWS }, (_, index) => build(index));
}

interface SeededTarget {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly socialAccountId: string;
  readonly postId: string;
  readonly platformPostId: string;
  readonly ageAnchorAt: Date;
  readonly nextSyncAt: Date;
}

function seedTarget(nextSyncAt = new Date(Date.now() - 60_000)): SeededTarget {
  const id = generateId();
  return {
    id,
    workspaceId: asWorkspaceId(generateId()),
    socialAccountId: generateId(),
    postId: generateId(),
    platformPostId: `at://post/${id}`,
    ageAnchorAt: new Date(),
    nextSyncAt,
  };
}

type CommentOverrides = Omit<Partial<typeof comments.$inferInsert>, 'id'>;

function commentRow(overrides: CommentOverrides = {}) {
  const now = new Date();
  return {
    workspaceId: asWorkspaceId(generateId()),
    socialAccountId: generateId(),
    platform: 'bluesky',
    platformPostId: 'at://post/indexed',
    platformCommentId: `at://comment/${generateId()}`,
    depth: 0,
    isOwn: false,
    source: 'sync',
    status: 'posted',
    lastActivityAt: now,
    occurredAt: now,
    ...overrides,
    id: generateId(),
  } satisfies typeof comments.$inferInsert;
}

function outboxEvent(publishedAt: Date | null = null) {
  return {
    workspaceId: generateId(),
    type: 'comment.received',
    aggregateId: generateId(),
    payload: {},
    publishedAt,
  } satisfies typeof outboxEvents.$inferInsert;
}

async function assertSchedulerReadsDueIndex(): Promise<void> {
  const future = new Date(Date.now() + DAY_MS);
  await harness.db
    .insert(commentSyncTargets)
    .values([seedTarget(), ...noise(() => seedTarget(future))]);
  const syncQueue = new Queue(QUEUE_NAMES.commentSync, { connection: harness.redis });
  try {
    await expectReadSelectively('comment_sync_targets_due_idx', (database) =>
      createSyncScheduler({ database: database.drizzle, syncQueue }).tick(),
    );
  } finally {
    await syncQueue.close();
  }
}

async function assertRelayReadsUnpublishedIndex(): Promise<void> {
  const publishedAt = new Date();
  await harness.db
    .insert(outboxEvents)
    .values([outboxEvent(), ...noise(() => outboxEvent(publishedAt))]);
  const queue = new Queue(QUEUE_NAMES.domainEvents, { connection: harness.redis });
  try {
    await expectReadSelectively('outbox_events_unpublished_idx', (database) =>
      relayOutboxBatch(database, queue),
    );
  } finally {
    await queue.close();
  }
}

async function assertSweeperReadsUnprocessedIndex(): Promise<void> {
  const receivedAt = new Date(Date.now() - DAY_MS);
  const delivery = { provider: 'meta', payload: {}, receivedAt };
  await harness.db
    .insert(webhookDeliveries)
    .values([delivery, ...noise(() => ({ ...delivery, processedAt: receivedAt }))]);
  const webhookQueue = new Queue(QUEUE_NAMES.webhookProcess, { connection: harness.redis });
  try {
    await expectReadSelectively('webhook_deliveries_unprocessed_idx', (database) =>
      createWebhookDeliverySweeper({ database: database.drizzle, webhookQueue }).sweep(),
    );
  } finally {
    await webhookQueue.close();
  }
}

describe('repeatable selectors', () => {
  it('the scheduler reads comment_sync_targets_due_idx', assertSchedulerReadsDueIndex);
  it('the outbox relay reads outbox_events_unpublished_idx', assertRelayReadsUnpublishedIndex);
  it(
    'the webhook-delivery sweeper reads webhook_deliveries_unprocessed_idx',
    assertSweeperReadsUnprocessedIndex,
  );
});

describe('request-path target lookups', () => {
  it("a post's sync block reads comment_sync_targets_post_idx", async () => {
    const target = seedTarget();
    const future = new Date(Date.now() + DAY_MS);
    await harness.db
      .insert(commentSyncTargets)
      .values([target, ...noise(() => seedTarget(future))]);
    await expectReadSelectively('comment_sync_targets_post_idx', (database) =>
      createCommentRepository(database.drizzle).getSyncStatus(target.workspaceId, target.postId),
    );
  });
});

function emptyWalkAdapter(): CommentPlatformAdapter {
  return {
    listComments: () =>
      Promise.resolve({ comments: [], deletedPlatformCommentIds: [], nextCursor: null }),
  } as unknown as CommentPlatformAdapter;
}

/** A `SyncPost` whose ports answer for `target`'s account and whose walk finds no comments. */
function buildSyncPost(db: NodePgDatabase, target: SeededTarget): SyncPost {
  const syncTargetRepository = createSyncTargetRepository(db, harness.config);
  return createSyncPost({
    database: db,
    ingestComments: createIngestComments({ database: db, syncTargetRepository }),
    syncTargetRepository,
    accounts: {
      findById: () =>
        Promise.resolve(
          found({
            id: target.socialAccountId,
            workspaceId: target.workspaceId,
            platform: 'bluesky',
            platformAccountId: 'did:plc:indexed',
            username: 'indexed',
            status: 'active',
          }),
        ),
    } as unknown as Accounts,
    accountCredentials: {
      findBySocialAccountId: () =>
        Promise.resolve(
          found({
            socialAccountId: target.socialAccountId,
            platform: 'bluesky',
            token: Buffer.from('unused'),
          }),
        ),
    } as unknown as AccountCredentials,
    accountHealth: createAccountHealth(db),
    getAdapter: emptyWalkAdapter,
  });
}

async function assertDeletionInferenceReadsPostIndex(): Promise<void> {
  const target = seedTarget();
  await harness.db.insert(commentSyncTargets).values(target);
  const onThisAccount = {
    workspaceId: target.workspaceId,
    socialAccountId: target.socialAccountId,
  };
  // The noise shares the account: an index on the account alone would have to read all of it.
  await harness.db.insert(comments).values([
    commentRow({
      ...onThisAccount,
      platformPostId: target.platformPostId,
      updatedAt: new Date(Date.now() - DAY_MS),
    }),
    ...noise((index) => commentRow({ ...onThisAccount, platformPostId: `at://other/${index}` })),
  ]);
  await expectReadSelectively('comments_sync_post_idx', async (database) => {
    const result = await buildSyncPost(database.drizzle, target).run(target.id);
    expect(result.status).toBe('succeeded');
  });
}

/** A thread of `replies` replies under a fresh root, both inserted; returns the root row. */
async function seedThread(replies: number, activityAt: Date) {
  const root = commentRow({ lastActivityAt: activityAt, occurredAt: activityAt });
  await harness.db.insert(comments).values(root);
  const reply = () =>
    commentRow({
      workspaceId: root.workspaceId,
      socialAccountId: root.socialAccountId,
      parentCommentId: root.id,
      rootCommentId: root.id,
      depth: 1,
      lastActivityAt: activityAt,
      occurredAt: activityAt,
    });
  await harness.db.insert(comments).values(Array.from({ length: replies }, reply));
  return root;
}

async function assertPurgeReadsRootIndex(): Promise<void> {
  await seedThread(1, new Date(Date.now() - 400 * DAY_MS));
  // A live thread the purge keeps: its replies all name a root, just not the one being deleted.
  await seedThread(NOISE_ROWS, new Date());
  await expectReadSelectively('comments_root_comment_idx', (database) =>
    createPurgeRetention({ database: database.drizzle, retentionDays: 45 }).run(),
  );
}

describe('thread maintenance', () => {
  it(
    "a complete walk's deletion inference reads comments_sync_post_idx",
    assertDeletionInferenceReadsPostIndex,
  );
  it(
    "the retention purge's foreign-key check reads comments_root_comment_idx",
    assertPurgeReadsRootIndex,
  );
});
