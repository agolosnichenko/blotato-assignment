// oxlint-disable max-dependencies -- an integration test against real Postgres, real Redis and a
// second disposable Redis needs the harness, queue and modules under test all named here.
// oxlint-disable max-lines -- four independent failure scenarios (commit visibility, no
// double-relay, surviving a dropped queue, T075's four event-payload cases), each needing its own
// seed data and its own Redis/queue setup, is the file's actual scope — the same reasoning
// `publish-comment.integration.test.ts` and `create-reply.integration.test.ts` give for their length.

/**
 * The transactional outbox under failure (T054, FR-025, FR-033, SC-011, D9): (1) invisible
 * outside its writing transaction until commit, (2) not relayed twice even if re-selected, (3) an
 * unpublished event survives losing Redis, and a failed publish never stamps `published_at`. T075
 * adds the four event-payload assertions to `registerEventPayloadTests`.
 */

import { RedisContainer } from '@testcontainers/redis';
import { eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '#src/app/config.ts';
import { asWorkspaceId, generateId, type WorkspaceId } from '#src/shared/ids.ts';
import { createDatabase, type Database } from '#src/shared/db.ts';
import { startTestContainers, type TestContainers } from '#src/shared/testing/containers.ts';
import { TEST_ENV } from '#src/shared/testing/test-env.ts';
import {
  appendToOutbox,
  type OutboxTransaction,
} from '#src/modules/comments/infrastructure/outbox.ts';
import { relayOutboxBatch } from '#src/modules/comments/infrastructure/outbox-relay.ts';
import { comments, outboxEvents } from '#src/modules/comments/infrastructure/schema.ts';
import { QUEUE_NAMES } from '#src/shared/queues.ts';

interface Harness {
  containers: TestContainers;
  database: Database;
  /** A second, independent connection — reads through this see only committed data. */
  outsideDb: NodePgDatabase;
  outsidePool: Pool;
}

async function setupHarness(): Promise<Harness> {
  const containers = await startTestContainers();
  const config = loadConfig({
    ...TEST_ENV,
    LOG_LEVEL: 'silent',
    DATABASE_URL: containers.databaseUrl,
    REDIS_URL: containers.redisUrl,
  });
  const database = createDatabase(config);
  const outsidePool = new Pool({ connectionString: containers.databaseUrl });
  const outsideDb = drizzle(outsidePool);
  return { containers, database, outsideDb, outsidePool };
}

async function teardownHarness(harness: Harness): Promise<void> {
  await harness.database.close();
  await harness.outsidePool.end();
  await harness.containers.stop();
}

/** Tests assert exact counts against the whole table, so each needs a clean slate. */
async function resetTables(database: Database): Promise<void> {
  await database.drizzle.delete(outboxEvents);
  await database.drizzle.delete(comments);
}

/**
 * A minimal, valid `comments` row — the "state change" a `comment.received` event describes.
 * `posted` requires a real-shaped `platformCommentId` (comments_posted_has_platform_comment_id,
 * schema.ts): for Bluesky that's an AT URI, with its `cid` alongside in `platformMeta` (§8.3).
 */
function commentFixture() {
  const now = new Date();
  const rkey = generateId();
  return {
    id: generateId(),
    workspaceId: asWorkspaceId(generateId()),
    socialAccountId: generateId(),
    platform: 'bluesky',
    platformPostId: 'at://did:plc:test/app.bsky.feed.post/post-1',
    platformCommentId: `at://did:plc:test/app.bsky.feed.post/${rkey}`,
    platformMeta: { cid: `bafyrei${rkey}` },
    depth: 0,
    isOwn: false,
    source: 'sync',
    status: 'posted',
    lastActivityAt: now,
    occurredAt: now,
  } satisfies typeof comments.$inferInsert;
}

/** Inserts a `comments` row plus its `comment.received` outbox event in one transaction. */
async function commitCommentReceived(database: Database): Promise<string> {
  const comment = commentFixture();
  let eventId = '';
  await database.drizzle.transaction(async (tx: OutboxTransaction) => {
    await tx.insert(comments).values(comment);
    eventId = await appendToOutbox(tx, {
      workspaceId: comment.workspaceId,
      type: 'comment.received',
      aggregateId: comment.id,
      data: { commentId: comment.id },
    });
  });
  return eventId;
}

function buildQueue(redisUrl: string): { queue: Queue; connection: Redis } {
  // `maxRetriesPerRequest: null` matches src/shared/queue.ts's createRedis (required by BullMQ).
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue(QUEUE_NAMES.domainEvents, { connection });
  return { queue, connection };
}

async function fetchOutboxRow(db: NodePgDatabase, id: string) {
  const [row] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, id));
  return row;
}

async function fetchComment(
  db: NodePgDatabase,
  id: string,
): Promise<typeof comments.$inferSelect | undefined> {
  const [row] = await db.select().from(comments).where(eq(comments.id, id));
  return row;
}

async function assertInvisibleUntilCommit(harness: Harness): Promise<void> {
  const comment = commentFixture();
  let eventId = '';
  // Observed from `harness.outsideDb` — a separate connection/pool — while the transaction is
  // still open.
  let sawDuringTransaction: {
    comment: typeof comments.$inferSelect | undefined;
    event: typeof outboxEvents.$inferSelect | undefined;
  } | null = null;

  await harness.database.drizzle.transaction(async (tx: OutboxTransaction) => {
    await tx.insert(comments).values(comment);
    eventId = await appendToOutbox(tx, {
      workspaceId: comment.workspaceId,
      type: 'comment.received',
      aggregateId: comment.id,
      data: { commentId: comment.id },
    });

    const outsideComment = await fetchComment(harness.outsideDb, comment.id);
    const outsideEvent = await fetchOutboxRow(harness.outsideDb, eventId);
    sawDuringTransaction = { comment: outsideComment, event: outsideEvent };
  });

  expect(sawDuringTransaction).toEqual({ comment: undefined, event: undefined });

  const committedComment = await fetchComment(harness.outsideDb, comment.id);
  const committedEvent = await fetchOutboxRow(harness.outsideDb, eventId);
  expect(committedComment?.id).toBe(comment.id);
  expect(committedEvent?.id).toBe(eventId);
  expect(committedEvent?.publishedAt).toBeNull();
}

function registerCommitVisibilityTests(getHarness: () => Harness): void {
  describe('commit visibility', () => {
    it('is invisible until commit, then visible', async () => {
      await assertInvisibleUntilCommit(getHarness());
    });
  });
}

async function assertNotRelayedTwice(harness: Harness): Promise<void> {
  const { queue, connection } = buildQueue(harness.containers.redisUrl);
  try {
    const eventId = await commitCommentReceived(harness.database);

    const first = await relayOutboxBatch(harness.database, queue);
    expect(first.relayed).toBe(1);

    // Simulates a row re-selected unpublished — e.g. after a crash rolled back a `published_at`
    // write the queue had accepted. `jobId` == event id is the second line of defence.
    await harness.database.drizzle
      .update(outboxEvents)
      .set({ publishedAt: null })
      .where(eq(outboxEvents.id, eventId));

    const second = await relayOutboxBatch(harness.database, queue);
    expect(second.relayed).toBe(1);

    expect(await queue.getWaitingCount()).toBe(1);
    const job = await queue.getJob(eventId);
    expect(job?.id).toBe(eventId);
  } finally {
    await queue.close();
    connection.disconnect();
  }
}

function registerRelayTests(getHarness: () => Harness): void {
  describe('relay', () => {
    it('does not relay an already-relayed row a second time, even if re-selected', async () => {
      await assertNotRelayedTwice(getHarness());
    });
  });
}

/**
 * A `Queue`-shaped double whose `add` rejects for one chosen job id and resolves for every other
 * — the minimal double needed for spec.md §18: no real BullMQ/Redis payload reliably
 * reproduces "a row BullMQ can never accept", so this stands in for that row directly instead.
 */
function poisonedQueueDouble(poisonedEventId: string): Queue {
  return {
    add(_name: string, _data: unknown, opts?: { jobId?: string }) {
      if (opts?.jobId === poisonedEventId) {
        return Promise.reject(new Error(`job rejected for poisoned event ${poisonedEventId}`));
      }
      return Promise.resolve();
    },
  } as unknown as Queue;
}

/**
 * I5: one row `domainEventsQueue.add` never accepts must not wedge its successors — before this
 * fix, the batch ran inside one shared transaction, so the poisoned row's rejection rolled back
 * the healthy row's publish too, and every later pass re-selected the same poisoned row first
 * (oldest by `created_at`) and aborted again, forever.
 */
async function assertPoisonRowDoesNotBlockSuccessors(harness: Harness): Promise<void> {
  const poisonedId = await commitCommentReceived(harness.database);
  const healthyId = await commitCommentReceived(harness.database);
  const queue = poisonedQueueDouble(poisonedId);

  const result = await relayOutboxBatch(harness.database, queue);

  expect(result.relayed).toBe(1);
  const poisoned = await fetchOutboxRow(harness.database.drizzle, poisonedId);
  expect(poisoned?.publishedAt).toBeNull();
  expect(poisoned?.attempts).toBe(1);
  const healthy = await fetchOutboxRow(harness.database.drizzle, healthyId);
  expect(healthy?.publishedAt).not.toBeNull();
}

/** The counterpart to the poison-row case: if *every* row in the batch fails, the call still
 * rejects — I5's isolation must not quietly turn a total outage into a silent no-op. */
async function assertAllRowsFailingStillRejects(harness: Harness): Promise<void> {
  const onlyId = await commitCommentReceived(harness.database);
  const queue = poisonedQueueDouble(onlyId);

  await expect(relayOutboxBatch(harness.database, queue)).rejects.toThrow();

  const row = await fetchOutboxRow(harness.database.drizzle, onlyId);
  expect(row?.publishedAt).toBeNull();
  expect(row?.attempts).toBe(1);
}

function registerPoisonRowTests(getHarness: () => Harness): void {
  describe('a poisoned row (spec.md §18)', () => {
    it('does not block a healthy row in the same batch, and records the attempt', async () => {
      await assertPoisonRowDoesNotBlockSuccessors(getHarness());
    });

    it('still rejects the call when every row in the batch fails', async () => {
      await assertAllRowsFailingStillRejects(getHarness());
    });
  });
}

async function waitReady(connection: Redis, timeoutMs = 10_000): Promise<void> {
  if (connection.status === 'ready') {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`not ready within ${timeoutMs}ms`)), timeoutMs);
    connection.once('ready', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * The outage gets its own disposable container (precedent: src/app/api.integration.test.ts) so
 * the shared Redis stays up for other tests; `enableOfflineQueue: false` fails a command fast
 * instead of hanging once that container is down. "Bring it back" is deliberately a *different*
 * Redis (the shared one) rather than restarting this one: on this host's Docker runtime a
 * restarted container's port mapping does not reliably become reachable again (verified
 * separately), and a fresh Redis is the more faithful proof of FR-033 anyway — the row survives
 * even when the old queue's state, not just its availability, is gone.
 */
async function assertSurvivesDroppedQueue(harness: Harness): Promise<void> {
  const outage = await new RedisContainer('redis:8.10.1-alpine').start();
  const outageConnection = new Redis(outage.getConnectionUrl(), {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  const outageQueue = new Queue(QUEUE_NAMES.domainEvents, { connection: outageConnection });

  try {
    await waitReady(outageConnection);
    const eventId = await commitCommentReceived(harness.database);

    await outage.stop();

    await expect(relayOutboxBatch(harness.database, outageQueue)).rejects.toThrow();

    const rowDuringOutage = await fetchOutboxRow(harness.database.drizzle, eventId);
    expect(rowDuringOutage?.publishedAt).toBeNull();

    const { queue: recoveryQueue, connection: recoveryConnection } = buildQueue(
      harness.containers.redisUrl,
    );
    try {
      const afterRecovery = await relayOutboxBatch(harness.database, recoveryQueue);
      expect(afterRecovery.relayed).toBe(1);

      const rowAfterRecovery = await fetchOutboxRow(harness.database.drizzle, eventId);
      expect(rowAfterRecovery?.publishedAt).not.toBeNull();
      const job = await recoveryQueue.getJob(eventId);
      expect(job?.id).toBe(eventId);
    } finally {
      await recoveryQueue.close();
      recoveryConnection.disconnect();
    }
  } finally {
    // Stopping an already-stopped container is a no-op; this only matters if an earlier
    // assertion threw before the deliberate `outage.stop()` above ran.
    await outageQueue.close();
    outageConnection.disconnect();
    await outage.stop();
  }
}

function registerDroppedQueueTests(getHarness: () => Harness): void {
  describe('surviving a dropped queue', () => {
    it('survives the outage and never stamps published_at without a successful publish', async () => {
      await assertSurvivesDroppedQueue(getHarness());
    }, 30_000);
  });
}

/**
 * T075: one `it` per event type in contracts/domain-events.md's payload table, each appending an
 * outbox row carrying every field that type's row documents, relaying it, and asserting the
 * envelope the queue receives — `{ id, type, version, occurredAt, workspaceId, data }` — matches
 * exactly, `data` included. This pins the relay's own contract (it must not drop, rename or add a
 * field between the outbox row and the queue envelope); whether a *producer* like
 * `publish-comment.ts` fills `data` correctly for its own event types is that producer's own test
 * (`publish-comment.integration.test.ts` already asserts `comment.posted`/`comment.failed` land
 * with one row each — this file adds the exact-shape assertion those tests don't make).
 */
/** Appends one outbox row of `type`/`data`, relays it, and returns the envelope the queue received. */
async function relayAndFetchEnvelope(
  harness: Harness,
  type: string,
  aggregateId: string,
  data: Record<string, unknown>,
): Promise<unknown> {
  const { queue, connection } = buildQueue(harness.containers.redisUrl);
  try {
    const workspaceId = asWorkspaceId(generateId());
    let eventId = '';
    await harness.database.drizzle.transaction(async (tx: OutboxTransaction) => {
      eventId = await appendToOutbox(tx, { workspaceId, type, aggregateId, data });
    });

    await relayOutboxBatch(harness.database, queue);
    const job = await queue.getJob(eventId);

    return { job, eventId, workspaceId };
  } finally {
    await queue.close();
    connection.disconnect();
  }
}

/**
 * Asserts the envelope the queue received for one event `type` matches `data` exactly — the
 * `{ id, type, version, occurredAt, workspaceId, data }` shape contracts/domain-events.md defines,
 * `data` field for field, nothing dropped and nothing added.
 */
async function assertEnvelopeMatchesContract(
  harness: Harness,
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  const result = (await relayAndFetchEnvelope(harness, type, generateId(), data)) as {
    job?: { data: unknown };
    eventId: string;
    workspaceId: WorkspaceId;
  };
  expect(result.job?.data).toEqual({
    id: result.eventId,
    type,
    version: 1,
    occurredAt: expect.any(String),
    workspaceId: result.workspaceId,
    data,
  });
}

/** T075's four cases — one payload per `contracts/domain-events.md` row, asserted exactly. */
const EVENT_PAYLOAD_CASES: ReadonlyArray<{
  readonly type: string;
  readonly description: string;
  readonly data: Record<string, unknown>;
}> = [
  {
    type: 'comment.received',
    description:
      'carries every field contracts/domain-events.md lists, including isOwn and ingestionSource',
    data: {
      commentId: generateId(),
      socialAccountId: generateId(),
      platform: 'bluesky',
      postId: generateId(),
      platformPostId: 'at://did:plc:test/app.bsky.feed.post/post-1',
      parentCommentId: null,
      isOwn: false,
      authorPlatformId: 'author-1',
      text: 'a comment discovered by ingestion',
      ingestionSource: 'sync',
    },
  },
  {
    type: 'comment.posted',
    description: 'carries every field contracts/domain-events.md lists',
    data: {
      commentId: generateId(),
      socialAccountId: generateId(),
      platform: 'bluesky',
      postId: generateId(),
      parentCommentId: null,
      platformCommentId: 'at://did:plc:test/app.bsky.feed.post/comment-1',
    },
  },
  {
    type: 'comment.failed',
    description: 'carries every field contracts/domain-events.md lists',
    data: {
      commentId: generateId(),
      errorCode: 'PLATFORM_REJECTED',
      errorMessage: 'the platform rejected the comment',
    },
  },
  {
    type: 'comment.deleted',
    description: 'carries every field contracts/domain-events.md lists',
    data: { commentId: generateId(), socialAccountId: generateId(), platform: 'bluesky' },
  },
];

function registerEventPayloadTests(getHarness: () => Harness): void {
  describe('event payloads (FR-024, D9) — the envelope the queue receives, field for field', () => {
    it.each(EVENT_PAYLOAD_CASES)('$type $description', async ({ type, data }) => {
      await assertEnvelopeMatchesContract(getHarness(), type, data);
    });
  });
}

describe('outbox under failure', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await setupHarness();
  });

  afterAll(async () => {
    await teardownHarness(harness);
  });

  beforeEach(async () => {
    await resetTables(harness.database);
  });

  registerCommitVisibilityTests(() => harness);
  registerRelayTests(() => harness);
  registerPoisonRowTests(() => harness);
  registerDroppedQueueTests(() => harness);
  registerEventPayloadTests(() => harness);
});
