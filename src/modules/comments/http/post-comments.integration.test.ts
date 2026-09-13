// oxlint-disable max-dependencies -- an integration test harness wires together the same set of
// modules the composition root does (config, db, redis, api, schema, crypto, ids, containers) —
// see the same justification on src/app/container.ts and src/app/api.ts.
// oxlint-disable max-lines -- SC-002's scenario (30 seeded comments, a page fetch, an insert
// between page requests, then following the cursor to the end, in both `order` directions) needs
// its own full harness plus that much setup; splitting the harness into a second file would
// violate the brief's one-file-per-task boundary (w6a-brief.md) without shrinking the real work.

/**
 * Contract tests for the top-level-comments-of-a-post read, driven through the flat collection
 * (T019/T040, US2, quickstart.md V3, per D31): `GET /v1/comments?postId=:id&topLevelOnly=true`
 * replaces `GET /v1/posts/:postId/comments`.
 *
 * `GET /v1/comments` is registered and answers `200` unfiltered today, but `postId`/`topLevelOnly`
 * are not accepted by `listCommentsQuerySchema` yet (schemas.ts) and `selectionPredicate` ignores
 * every key of `CommentSelection` it is given (comment-repository.ts) — every scenario below that
 * relies on the filter actually narrowing the result set fails today, seeing the *unfiltered*
 * workspace listing instead. The old address's `404` assertion also fails today: the nested route
 * is still registered and still answers `200`, removal is a later task.
 *
 * The load-bearing scenario is SC-002: keyset pagination must not repeat or skip a pre-existing
 * comment when rows are inserted between two page requests, in either `order` direction — the
 * failure mode `OFFSET` pagination has and keyset pagination on `(occurred_at, id)` does not
 * (D27, data-model.md §2 indexes).
 */

import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApi, type Api } from '#src/app/api.ts';
import { loadConfig } from '#src/app/config.ts';
import { buildContainer } from '#src/app/container.ts';
import { comments, commentSyncTargets } from '#src/modules/comments/infrastructure/schema.ts';
import { apiKeys, posts, socialAccounts, workspaces } from '#src/modules/platform-core/schema.ts';
import { hashSecret } from '#src/shared/crypto.ts';
import type { Database } from '#src/shared/db.ts';
import { asWorkspaceId, generateId, type WorkspaceId } from '#src/shared/ids.ts';
import { startTestContainers, type TestContainers } from '#src/shared/testing/containers.ts';
import { TEST_ENV } from '#src/shared/testing/test-env.ts';

interface Harness {
  containers: TestContainers;
  database: Database;
  redis: Redis;
  publishQueue: Queue;
  app: Api;
  workspaceId: WorkspaceId;
  apiKey: string;
}

async function mintApiKey(database: Database, workspaceId: WorkspaceId): Promise<string> {
  const prefix = randomBytes(6).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  await database.drizzle.insert(apiKeys).values({
    id: generateId(),
    workspaceId,
    prefix,
    keyHash: hashSecret(secret),
    name: 'test key',
    rateLimitPerMin: null,
    revokedAt: null,
    createdAt: new Date(),
  });
  return `blt_${prefix}_${secret}`;
}

async function startHarness(): Promise<Harness> {
  const containers = await startTestContainers();
  const config = loadConfig({
    ...TEST_ENV,
    LOG_LEVEL: 'silent',
    DATABASE_URL: containers.databaseUrl,
    REDIS_URL: containers.redisUrl,
  });
  // `buildContainer` builds `ports`/`contactQuota`/`publishQueue` alongside `database`/`redis` —
  // `buildApi` now needs all of them (T069's write routes).
  const container = buildContainer({ config });
  const { database, redis, publishQueue } = container;
  const app = buildApi(container);
  await app.ready();

  const workspaceId = asWorkspaceId(generateId());
  await database.drizzle.insert(workspaces).values({
    id: workspaceId,
    name: 'Test workspace',
    contactLimitMonthly: 1000,
    createdAt: new Date(),
  });
  const apiKey = await mintApiKey(database, workspaceId);

  return { containers, database, redis, publishQueue, app, workspaceId, apiKey };
}

async function stopHarness(harness: Harness): Promise<void> {
  await harness.app.close();
  await harness.publishQueue.close();
  await harness.database.close();
  harness.redis.disconnect();
  await harness.containers.stop();
}

interface SeededPost {
  postId: string;
  socialAccountId: string;
}

/** Seeds a social account and a post it published, so `postId` resolves for the route under test. */
async function seedPost(harness: Harness): Promise<SeededPost> {
  const socialAccountId = generateId();
  await harness.database.drizzle.insert(socialAccounts).values({
    id: socialAccountId,
    workspaceId: harness.workspaceId,
    platform: 'instagram',
    platformAccountId: `ig-${generateId()}`,
    username: 'demo',
    credentialsCiphertext: Buffer.alloc(28),
    credentialsKeyVersion: 1,
    status: 'active',
    createdAt: new Date(),
  });

  const postId = generateId();
  await harness.database.drizzle.insert(posts).values({
    id: postId,
    workspaceId: harness.workspaceId,
    socialAccountId,
    platform: 'instagram',
    platformPostId: `ig-post-${postId}`,
    publishedAt: new Date(),
    createdAt: new Date(),
  });

  return { postId, socialAccountId };
}

type CommentInsert = typeof comments.$inferInsert;

/** Builds (without inserting) a top-level, posted comment row `offsetMs` after `base`. */
function buildTopLevelComment(
  harness: Harness,
  seeded: SeededPost,
  base: number,
  offsetMs: number,
  replyCount = 0,
): CommentInsert {
  const id = generateId();
  const occurredAt = new Date(base + offsetMs);
  return {
    id,
    workspaceId: harness.workspaceId,
    socialAccountId: seeded.socialAccountId,
    postId: seeded.postId,
    platform: 'instagram',
    platformPostId: `ig-post-${seeded.postId}`,
    parentCommentId: null,
    rootCommentId: null,
    depth: 0,
    platformCommentId: `ig-comment-${id}`,
    isOwn: false,
    source: 'sync',
    authorPlatformId: `author-${id}`,
    authorUsername: `author-${id}`,
    authorDisplayName: null,
    text: `comment ${id}`,
    status: 'posted',
    replyCount,
    lastActivityAt: occurredAt,
    occurredAt,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
}

const SEED_BASE_MS = Date.parse('2026-01-01T00:00:00.000Z');

/** Seeds `count` top-level comments on a post, one millisecond apart, oldest first. Returns their ids. */
async function seedTopLevelComments(
  harness: Harness,
  seeded: SeededPost,
  count: number,
  replyCountByIndex: Record<number, number> = {},
): Promise<string[]> {
  const rows = Array.from({ length: count }, (_unused, index) =>
    buildTopLevelComment(harness, seeded, SEED_BASE_MS, index, replyCountByIndex[index] ?? 0),
  );
  await harness.database.drizzle.insert(comments).values(rows);
  return rows.map((row) => row.id as string);
}

/** Builds (without inserting) a reply row under `parentId` — `topLevelOnly=true`'s negative case. */
function buildReplyComment(
  harness: Harness,
  seeded: SeededPost,
  parentId: string,
  base: number,
  offsetMs: number,
): CommentInsert {
  const id = generateId();
  const occurredAt = new Date(base + offsetMs);
  return {
    id,
    workspaceId: harness.workspaceId,
    socialAccountId: seeded.socialAccountId,
    postId: seeded.postId,
    platform: 'instagram',
    platformPostId: `ig-post-${seeded.postId}`,
    parentCommentId: parentId,
    rootCommentId: parentId,
    depth: 1,
    platformCommentId: `ig-comment-${id}`,
    isOwn: false,
    source: 'sync',
    authorPlatformId: `author-${id}`,
    authorUsername: `author-${id}`,
    authorDisplayName: null,
    text: `reply ${id}`,
    status: 'posted',
    replyCount: 0,
    lastActivityAt: occurredAt,
    occurredAt,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
}

async function seedSyncTarget(
  harness: Harness,
  seeded: SeededPost,
  lastSyncedAt: Date,
): Promise<void> {
  await harness.database.drizzle.insert(commentSyncTargets).values({
    id: generateId(),
    workspaceId: harness.workspaceId,
    socialAccountId: seeded.socialAccountId,
    postId: seeded.postId,
    platformPostId: `ig-post-${seeded.postId}`,
    lastSyncedAt,
    nextSyncAt: new Date(Date.now() + 60_000),
    lastError: null,
    manualCooldownUntil: null,
    // A fixed anchor a few days in the past — this case doesn't exercise age banding, and a
    // real-looking age (rather than "now") won't drift into a different band depending on when
    // the suite runs.
    ageAnchorAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
  });
}

interface CommentItem {
  id: string;
  occurredAt: string;
  replyCount: number;
}

interface CommentsPage {
  items: CommentItem[];
  nextCursor: string | null;
  sync?: { lastSyncedAt: string | null; activeJobId: string | null };
}

/**
 * Drives `GET /v1/comments?postId=:id&topLevelOnly=true` (V3) — the collection selection that
 * replaces `GET /v1/posts/:postId/comments`. `postId`/`topLevelOnly` merge with whatever `query`
 * the caller supplies, so a test can still control `limit`/`cursor`/`order` freely.
 */
async function fetchPage(
  harness: Harness,
  postId: string,
  query: Record<string, string>,
): Promise<{ statusCode: number; body: unknown; headers: Record<string, string> }> {
  const search = new URLSearchParams({ postId, topLevelOnly: 'true', ...query }).toString();
  const response = await harness.app.inject({
    method: 'GET',
    url: `/v1/comments?${search}`,
    headers: { 'blotato-api-key': harness.apiKey },
  });
  return {
    statusCode: response.statusCode,
    body: response.json(),
    headers: response.headers as never,
  };
}

async function fetchOnePage(
  harness: Harness,
  postId: string,
  order: 'asc' | 'desc',
  cursor?: string,
): Promise<CommentsPage> {
  const query: Record<string, string> = { limit: '20', order };
  if (cursor !== undefined) {
    query['cursor'] = cursor;
  }
  const { statusCode, body } = await fetchPage(harness, postId, query);
  expect(statusCode).toBe(200);
  return body as CommentsPage;
}

/**
 * Walks every page for `order` starting from `startCursor` (the first page if omitted), collecting
 * every returned item (not just its id) in order.
 */
async function walkAllPages(
  harness: Harness,
  postId: string,
  order: 'asc' | 'desc',
  startCursor?: string,
): Promise<CommentItem[]> {
  const collected: CommentItem[] = [];
  let cursor = startCursor;
  for (let guard = 0; guard < 50; guard += 1) {
    // Each page's cursor is only known after the previous page responds — this walk is
    // inherently sequential, not a case Promise.all can parallelize.
    // oxlint-disable-next-line no-await-in-loop
    const page = await fetchOnePage(harness, postId, order, cursor);
    collected.push(...page.items);
    if (page.nextCursor === null) {
      return collected;
    }
    cursor = page.nextCursor;
  }
  throw new Error('walkAllPages did not terminate — nextCursor never became null');
}

function assertExactlyOnce(expectedIds: readonly string[], collected: readonly string[]): void {
  for (const id of expectedIds) {
    const occurrences = collected.filter((candidate) => candidate === id).length;
    expect(
      occurrences,
      `comment ${id} should appear exactly once, appeared ${occurrences} times`,
    ).toBe(1);
  }
}

async function insertInterspersedComments(
  harness: Harness,
  seeded: SeededPost,
  offsetsMs: readonly number[],
): Promise<void> {
  const rows = offsetsMs.map((offsetMs) =>
    buildTopLevelComment(harness, seeded, SEED_BASE_MS, offsetMs),
  );
  await harness.database.drizzle.insert(comments).values(rows);
}

async function assertCursorRejectedUnderOtherOrder(
  harness: Harness,
  postId: string,
  order: 'asc' | 'desc',
  cursor: string,
): Promise<void> {
  const otherOrder = order === 'desc' ? 'asc' : 'desc';
  const { statusCode, body, headers } = await fetchPage(harness, postId, {
    limit: '2',
    order: otherOrder,
    cursor,
  });
  expect(statusCode).toBe(400);
  expect(headers['content-type']).toContain('application/problem+json');
  expect((body as { code: string }).code).toBe('VALIDATION_ERROR');
}

/**
 * One combined scenario per `order`, matching T040/V1 exactly: seed 30, fetch page 1, insert 5
 * more comments between page requests, then follow the cursor to the end. Filtering the walked
 * items down to the original 30 and comparing against `ids` (or its reverse) proves gap-free,
 * exactly-once and correctly-ordered all from the same post-insertion walk that SC-002 requires —
 * a walk taken entirely *before* the insert would not exercise the race SC-002 is about. The same
 * first-page cursor also carries the `order`-mismatch check (FR-004), since re-seeding a second
 * post just to mint another cursor would test nothing new.
 */
function registerPagingScenario(getHarness: () => Harness): void {
  it.each(['desc', 'asc'] as const)(
    'pages every comment exactly once across an insert, with correct replyCount, sync freshness ' +
      'and order-mismatch rejection (order=%s)',
    async (order) => {
      const harness = getHarness();
      const seeded = await seedPost(harness);
      const flaggedIndex = 5;
      const flaggedReplyCount = 3;
      const ids = await seedTopLevelComments(harness, seeded, 30, {
        [flaggedIndex]: flaggedReplyCount,
      });
      const lastSyncedAt = new Date('2026-02-01T00:00:00.000Z');
      await seedSyncTarget(harness, seeded, lastSyncedAt);

      const firstPage = await fetchOnePage(harness, seeded.postId, order);
      expect(firstPage.items).toHaveLength(20);
      expect(firstPage.sync?.lastSyncedAt).toBe(lastSyncedAt.toISOString());
      expect(firstPage.nextCursor).not.toBeNull();
      const cursor = firstPage.nextCursor as string;

      await assertCursorRejectedUnderOtherOrder(harness, seeded.postId, order, cursor);

      // Interspersed before, inside and after the already-seeded range — so both the
      // already-issued cursor position and every later page boundary are exercised.
      await insertInterspersedComments(harness, seeded, [-10, 7, 15, 22, 1000]);

      const rest = await walkAllPages(harness, seeded.postId, order, cursor);
      const allItems = [...firstPage.items, ...rest];
      const allIds = allItems.map((item) => item.id);
      const originalIdsInOrder = allIds.filter((id) => ids.includes(id));

      assertExactlyOnce(ids, allIds);
      expect(new Set(originalIdsInOrder).size).toBe(30);
      expect(originalIdsInOrder).toEqual(order === 'desc' ? ids.toReversed() : ids);

      const flagged = allItems.find((item) => item.id === ids[flaggedIndex]);
      expect(flagged?.replyCount).toBe(flaggedReplyCount);
    },
  );
}

/**
 * T019/V3's negative-data half: `postId` must exclude a comment seeded on a *different* post, and
 * `topLevelOnly=true` must exclude a reply seeded under the matching post — a selection that
 * silently ignores either filter would return both extra rows and pass a positive-only fixture.
 */
function registerFilterExclusionTest(getHarness: () => Harness): void {
  it('excludes another post and excludes a reply on the same post', async () => {
    const harness = getHarness();
    const seeded = await seedPost(harness);
    const [topLevelId] = await seedTopLevelComments(harness, seeded, 1);
    const replyRow = buildReplyComment(harness, seeded, topLevelId as string, SEED_BASE_MS, 500);
    await harness.database.drizzle.insert(comments).values(replyRow);

    const otherSeeded = await seedPost(harness);
    const [otherPostTopLevelId] = await seedTopLevelComments(harness, otherSeeded, 1);

    const { statusCode, body } = await fetchPage(harness, seeded.postId, { limit: '20' });

    expect(statusCode).toBe(200);
    const ids = (body as CommentsPage).items.map((item) => item.id);
    expect(ids).toContain(topLevelId);
    expect(ids).not.toContain(replyRow.id);
    expect(ids).not.toContain(otherPostTopLevelId);
  });
}

/** T019/V3: the nested route this selection replaces no longer answers — `404 NOT_FOUND` (FR-009). */
function registerOldAddressGoneTest(getHarness: () => Harness): void {
  it('answers 404 NOT_FOUND at the old GET /v1/posts/:postId/comments address', async () => {
    const harness = getHarness();
    const seeded = await seedPost(harness);

    const response = await harness.app.inject({
      method: 'GET',
      url: `/v1/posts/${seeded.postId}/comments`,
      headers: { 'blotato-api-key': harness.apiKey },
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect((response.json() as { code: string }).code).toBe('NOT_FOUND');
  });
}

describe('GET /v1/comments?postId&topLevelOnly=true (was GET /v1/posts/:postId/comments)', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness();
  });

  afterAll(async () => {
    await stopHarness(harness);
  });

  registerPagingScenario(() => harness);
  registerFilterExclusionTest(() => harness);
  registerOldAddressGoneTest(() => harness);
});
