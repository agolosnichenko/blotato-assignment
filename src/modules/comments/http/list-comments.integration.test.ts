// oxlint-disable max-dependencies -- an integration test harness wires together the same set of
// modules the composition root does (config, db, redis, api, schema, crypto, ids, containers) —
// see the same justification on src/app/container.ts and every other `http/*.integration.test.ts`
// file in this module.
// oxlint-disable max-lines -- five independent US1 scenarios (T008-T012: the cross-account inbox,
// the port-spy behaviour, a dangling postId, the sync-block omission and exact paging under
// concurrent inserts in both orders plus four validation cases) each need their own seeded
// workspace against a real Postgres — the same shape that earns the same disable on
// post-comments.integration.test.ts and tenancy.integration.test.ts.

/**
 * Contract tests for `GET /v1/comments` (T008-T012, US1, quickstart.md V1-V2, per D31).
 *
 * Every assertion checks `code` alongside `statusCode`, never the status alone. Both the route's own
 * `400 VALIDATION_ERROR` and Fastify's not-found handler (`app.setNotFoundHandler` in
 * `src/app/api.ts`) answer `application/problem+json`, so a status-only assertion would accept a
 * request that never reached the route as though the route had rejected it.
 *
 * This file drives the route, not the repository — `CommentRepository.list` and `CommentSelection`
 * have their own coverage, per "test behaviour, not implementation" (brief).
 *
 * Filter semantics (T020, US2, quickstart.md V3-V4, per D31) are below the identifier-free US1
 * cases: `platforms` union/validation, `topLevelOnly`+`parentCommentId` and `postId`+
 * `parentCommentId` intersections, `since`/`until` inversion, `isOwn=false`, status visibility and
 * the `sync` block's presence rule (R-08). Each pins that the filter genuinely *narrows* the
 * result, which is the claim that fails if a key is accepted by the schema but dropped before the
 * predicate: the page would come back unfiltered, `200`, and plausible.
 */

import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApi, type Api, type ApiDependencies } from '#src/app/api.ts';
import { loadConfig } from '#src/app/config.ts';
import { buildContainer } from '#src/app/container.ts';
import {
  comments,
  commentSyncJobs,
  commentSyncTargets,
} from '#src/modules/comments/infrastructure/schema.ts';
import { apiKeys, posts, socialAccounts, workspaces } from '#src/modules/platform-core/schema.ts';
import { hashSecret } from '#src/shared/crypto.ts';
import type { Database } from '#src/shared/db.ts';
import { asWorkspaceId, generateId, type WorkspaceId } from '#src/shared/ids.ts';
import { encodeCursor } from '#src/shared/pagination.ts';
import { startTestContainers, type TestContainers } from '#src/shared/testing/containers.ts';
import { TEST_ENV } from '#src/shared/testing/test-env.ts';

interface Harness {
  containers: TestContainers;
  database: Database;
  redis: Redis;
  publishQueue: Queue;
  app: Api;
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
  const container = buildContainer({ config });
  const { database, redis, publishQueue } = container;
  const app = buildApi(container);
  await app.ready();

  return { containers, database, redis, publishQueue, app };
}

async function stopHarness(harness: Harness): Promise<void> {
  await harness.app.close();
  await harness.publishQueue.close();
  await harness.database.close();
  harness.redis.disconnect();
  await harness.containers.stop();
}

/** Seeds a workspace row and returns its id — every test scopes a fresh workspace so an
 * unfiltered listing's exact-set assertions can never see another test's rows (D31 has no filter
 * to isolate by). */
async function seedWorkspace(database: Database): Promise<WorkspaceId> {
  const workspaceId = asWorkspaceId(generateId());
  await database.drizzle.insert(workspaces).values({
    id: workspaceId,
    name: 'Test workspace',
    contactLimitMonthly: 1000,
    createdAt: new Date(),
  });
  return workspaceId;
}

async function seedSocialAccount(
  database: Database,
  workspaceId: WorkspaceId,
  platform: string,
): Promise<string> {
  const socialAccountId = generateId();
  await database.drizzle.insert(socialAccounts).values({
    id: socialAccountId,
    workspaceId,
    platform,
    platformAccountId: `${platform}-${generateId()}`,
    username: 'demo',
    credentialsCiphertext: Buffer.alloc(28),
    credentialsKeyVersion: 1,
    status: 'active',
    createdAt: new Date(),
  });
  return socialAccountId;
}

interface SeededPost {
  readonly postId: string;
  readonly platformPostId: string;
}

/** Seeds a `posts` projection row — the row T010 later deletes to go stale. */
async function seedPostRow(
  database: Database,
  workspaceId: WorkspaceId,
  socialAccountId: string,
  platform: string,
): Promise<SeededPost> {
  const postId = generateId();
  const platformPostId = `${platform}-post-${postId}`;
  await database.drizzle.insert(posts).values({
    id: postId,
    workspaceId,
    socialAccountId,
    platform,
    platformPostId,
    publishedAt: new Date(),
    createdAt: new Date(),
  });
  return { postId, platformPostId };
}

interface SeedCommentInput {
  readonly workspaceId: WorkspaceId;
  readonly socialAccountId: string;
  readonly platform: string;
  readonly postId?: string | null;
  readonly platformPostId: string;
  readonly occurredAt: Date;
}

/** Inserts one top-level, posted comment row directly — the read side under test, not a write path. */
async function seedComment(database: Database, input: SeedCommentInput): Promise<string> {
  const id = generateId();
  await database.drizzle.insert(comments).values({
    id,
    workspaceId: input.workspaceId,
    socialAccountId: input.socialAccountId,
    platform: input.platform,
    postId: input.postId ?? null,
    platformPostId: input.platformPostId,
    parentCommentId: null,
    rootCommentId: null,
    depth: 0,
    platformCommentId: `${input.platform}-comment-${id}`,
    isOwn: false,
    source: 'sync',
    authorPlatformId: `author-${id}`,
    authorUsername: `author-${id}`,
    authorDisplayName: null,
    text: `comment ${id}`,
    status: 'posted',
    replyCount: 0,
    lastActivityAt: input.occurredAt,
    occurredAt: input.occurredAt,
    createdAt: input.occurredAt,
    updatedAt: input.occurredAt,
  });
  return id;
}

interface CommentItem {
  id: string;
  postId: string | null;
  occurredAt: string;
}

interface CommentsPage {
  items: CommentItem[];
  nextCursor: string | null;
}

interface JsonResponse<TBody> {
  statusCode: number;
  headers: Record<string, string>;
  body: TBody;
}

async function fetchComments(
  harness: Harness,
  apiKey: string,
  query: Record<string, string> = {},
): Promise<JsonResponse<Record<string, unknown>>> {
  const search = new URLSearchParams(query).toString();
  const response = await harness.app.inject({
    method: 'GET',
    url: `/v1/comments${search === '' ? '' : `?${search}`}`,
    headers: { 'blotato-api-key': apiKey },
  });
  return {
    statusCode: response.statusCode,
    headers: response.headers as never,
    body: response.json() as Record<string, unknown>,
  };
}

function assertProblem(
  response: JsonResponse<Record<string, unknown>>,
  status: number,
  code: string,
): void {
  expect(response.statusCode).toBe(status);
  expect(response.headers['content-type']).toContain('application/problem+json');
  expect(response.body['code']).toBe(code);
}

interface CrossAccountFixture {
  readonly workspaceId: WorkspaceId;
  readonly oldestId: string;
  readonly middleId: string;
  readonly newestId: string;
  readonly foreignId: string;
}

/** Seeds two accounts in one workspace with staggered comments, plus one comment in a second
 * workspace — the fixture {@link registerCrossAccountInboxTest} asserts over. */
async function seedCrossAccountFixture(database: Database): Promise<CrossAccountFixture> {
  const workspaceId = await seedWorkspace(database);
  const igAccountId = await seedSocialAccount(database, workspaceId, 'instagram');
  const blueskyAccountId = await seedSocialAccount(database, workspaceId, 'bluesky');
  const base = Date.parse('2026-03-01T00:00:00.000Z');

  const oldestId = await seedComment(database, {
    workspaceId,
    socialAccountId: igAccountId,
    platform: 'instagram',
    platformPostId: `instagram-external-${generateId()}`,
    occurredAt: new Date(base),
  });
  const middleId = await seedComment(database, {
    workspaceId,
    socialAccountId: blueskyAccountId,
    platform: 'bluesky',
    platformPostId: `bluesky-external-${generateId()}`,
    occurredAt: new Date(base + 1000),
  });
  const newestId = await seedComment(database, {
    workspaceId,
    socialAccountId: igAccountId,
    platform: 'instagram',
    platformPostId: `instagram-external-${generateId()}`,
    occurredAt: new Date(base + 2000),
  });

  const otherWorkspaceId = await seedWorkspace(database);
  const otherAccountId = await seedSocialAccount(database, otherWorkspaceId, 'instagram');
  const foreignId = await seedComment(database, {
    workspaceId: otherWorkspaceId,
    socialAccountId: otherAccountId,
    platform: 'instagram',
    platformPostId: `instagram-external-${generateId()}`,
    occurredAt: new Date(base + 3000),
  });

  return { workspaceId, oldestId, middleId, newestId, foreignId };
}

/**
 * T008 (quickstart V1): the cross-account, cross-workspace-excluding inbox no route served
 * before. Two accounts in one workspace, both contributing comments to one unfiltered page,
 * newest first; a third workspace's comment never appears.
 */
function registerCrossAccountInboxTest(getHarness: () => Harness): void {
  it('lists comments from every account in the workspace, newest first, excluding other workspaces', async () => {
    const harness = getHarness();
    const fixture = await seedCrossAccountFixture(harness.database);

    const apiKey = await mintApiKey(harness.database, fixture.workspaceId);
    const response = await fetchComments(harness, apiKey);

    expect(response.statusCode).toBe(200);
    const body = response.body as unknown as CommentsPage;
    expect(body.items.map((item) => item.id)).toEqual([
      fixture.newestId,
      fixture.middleId,
      fixture.oldestId,
    ]);
    expect(body.items.map((item) => item.id)).not.toContain(fixture.foreignId);
  });

  it('answers 200 with an empty page for a workspace with no comments', async () => {
    const harness = getHarness();
    const workspaceId = await seedWorkspace(harness.database);
    const apiKey = await mintApiKey(harness.database, workspaceId);

    const response = await fetchComments(harness, apiKey);

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ items: [], nextCursor: null });
  });
}

/**
 * T009 (FR-005): a caller holding only an API key must be able to read the workspace's comments
 * without this service asking another service anything. `Posts`/`Accounts` are registered as
 * spies on top of their real implementations (so a route that does call them still behaves
 * correctly), and neither must be invoked for an identifier-free request.
 *
 * Builds its own app instance — `buildApi` reads `deps.ports` once at route-registration time
 * (`src/app/api.ts`'s `registerCommentRoutes`), so the spies must be wired in before `buildApi` is
 * called, not swapped in after.
 */
interface SpyApiHarness {
  readonly app: Api;
  readonly postsFindByIdSpy: ReturnType<typeof vi.fn>;
  readonly accountsFindByIdSpy: ReturnType<typeof vi.fn>;
  close(): Promise<void>;
}

/**
 * Builds a second app instance over the same testcontainer database, with `Posts.findById` and
 * `Accounts.findById` wrapped as spies around their real implementations. Separate from the
 * shared `harness.app` because `buildApi` reads `deps.ports` once at route-registration time
 * (`src/app/api.ts`'s `registerCommentRoutes`), so the spies must be wired in before `buildApi` is
 * called, not swapped in after.
 */
function startSpyApiHarness(containers: TestContainers): SpyApiHarness {
  const config = loadConfig({
    ...TEST_ENV,
    LOG_LEVEL: 'silent',
    DATABASE_URL: containers.databaseUrl,
    REDIS_URL: containers.redisUrl,
  });
  const container = buildContainer({ config });
  const postsFindByIdSpy = vi.fn(container.ports.posts.findById.bind(container.ports.posts));
  const accountsFindByIdSpy = vi.fn(
    container.ports.accounts.findById.bind(container.ports.accounts),
  );
  const deps: ApiDependencies = {
    ...container,
    ports: {
      ...container.ports,
      posts: { ...container.ports.posts, findById: postsFindByIdSpy },
      accounts: { ...container.ports.accounts, findById: accountsFindByIdSpy },
    },
  };
  const app = buildApi(deps);

  return {
    app,
    postsFindByIdSpy,
    accountsFindByIdSpy,
    async close() {
      await app.close();
      await container.close();
    },
  };
}

/**
 * T009 (FR-005): a caller holding only an API key must be able to read the workspace's comments
 * without this service asking another service anything. `Posts`/`Accounts` are registered as
 * spies on top of their real implementations (so a route that does call them still behaves
 * correctly), and neither must be invoked for an identifier-free request.
 */
function registerNoPortCallTest(getHarness: () => Harness): void {
  it('does not call the Posts or Accounts ports for an identifier-free request', async () => {
    const harness = getHarness();
    const workspaceId = await seedWorkspace(harness.database);
    const socialAccountId = await seedSocialAccount(harness.database, workspaceId, 'instagram');
    await seedComment(harness.database, {
      workspaceId,
      socialAccountId,
      platform: 'instagram',
      platformPostId: `instagram-external-${generateId()}`,
      occurredAt: new Date(),
    });
    const apiKey = await mintApiKey(harness.database, workspaceId);

    const spyHarness = startSpyApiHarness(harness.containers);
    await spyHarness.app.ready();

    try {
      const response = await spyHarness.app.inject({
        method: 'GET',
        url: '/v1/comments',
        headers: { 'blotato-api-key': apiKey },
      });

      expect(response.statusCode).toBe(200);
      expect(spyHarness.postsFindByIdSpy).not.toHaveBeenCalled();
      expect(spyHarness.accountsFindByIdSpy).not.toHaveBeenCalled();
    } finally {
      await spyHarness.close();
    }
  });
}

/**
 * The mirror of {@link registerNoPortCallTest}: FR-005's other half, and the one that actually
 * proves tenancy is resolved through the port rather than some other mechanism (a SQL join, say)
 * that could produce the same `404`/`200` shape without ever asking `Posts`/`Accounts` anything
 * (fix round 1 — the spy above only ever asserted the identifier-free negative, so a join in place
 * of the port would leave both it and the tenancy test green). Split into two registrars, one per
 * port, since each seeds and asserts independently.
 */
function registerPostIdPortCallTest(getHarness: () => Harness): void {
  it('calls the Posts port when postId is present', async () => {
    const harness = getHarness();
    const workspaceId = await seedWorkspace(harness.database);
    const socialAccountId = await seedSocialAccount(harness.database, workspaceId, 'instagram');
    const seededPost = await seedPostRow(
      harness.database,
      workspaceId,
      socialAccountId,
      'instagram',
    );
    await seedComment(harness.database, {
      workspaceId,
      socialAccountId,
      platform: 'instagram',
      postId: seededPost.postId,
      platformPostId: seededPost.platformPostId,
      occurredAt: new Date(),
    });
    const apiKey = await mintApiKey(harness.database, workspaceId);

    const spyHarness = startSpyApiHarness(harness.containers);
    await spyHarness.app.ready();

    try {
      const response = await spyHarness.app.inject({
        method: 'GET',
        url: `/v1/comments?postId=${seededPost.postId}`,
        headers: { 'blotato-api-key': apiKey },
      });

      expect(response.statusCode).toBe(200);
      expect(spyHarness.postsFindByIdSpy).toHaveBeenCalledWith(seededPost.postId);
    } finally {
      await spyHarness.close();
    }
  });
}

function registerAccountIdPortCallTest(getHarness: () => Harness): void {
  it('calls the Accounts port when accountId is present', async () => {
    const harness = getHarness();
    const workspaceId = await seedWorkspace(harness.database);
    const socialAccountId = await seedSocialAccount(harness.database, workspaceId, 'bluesky');
    await seedComment(harness.database, {
      workspaceId,
      socialAccountId,
      platform: 'bluesky',
      platformPostId: `bluesky-external-${generateId()}`,
      occurredAt: new Date(),
    });
    const apiKey = await mintApiKey(harness.database, workspaceId);

    const spyHarness = startSpyApiHarness(harness.containers);
    await spyHarness.app.ready();

    try {
      const response = await spyHarness.app.inject({
        method: 'GET',
        url: `/v1/comments?accountId=${socialAccountId}`,
        headers: { 'blotato-api-key': apiKey },
      });

      expect(response.statusCode).toBe(200);
      expect(spyHarness.accountsFindByIdSpy).toHaveBeenCalledWith(socialAccountId);
    } finally {
      await spyHarness.close();
    }
  });
}

/**
 * T010 (FR-008, acceptance 1.4): a comment outlives its post reference. Seeded by deleting the
 * `posts` projection row (not by nulling the comment's own `postId`) — the point is that a
 * dangling reference stays readable, the same split `inbox.integration.test.ts`'s stale-projection
 * test pins for the account-scoped route.
 */
function registerDanglingPostReferenceTest(getHarness: () => Harness): void {
  it('returns a comment whose postId no longer resolves in the platform-core projection', async () => {
    const harness = getHarness();
    const workspaceId = await seedWorkspace(harness.database);
    const socialAccountId = await seedSocialAccount(harness.database, workspaceId, 'instagram');
    const seededPost = await seedPostRow(
      harness.database,
      workspaceId,
      socialAccountId,
      'instagram',
    );
    const commentId = await seedComment(harness.database, {
      workspaceId,
      socialAccountId,
      platform: 'instagram',
      postId: seededPost.postId,
      platformPostId: seededPost.platformPostId,
      occurredAt: new Date(),
    });

    await harness.database.drizzle.delete(posts).where(eq(posts.id, seededPost.postId));

    const apiKey = await mintApiKey(harness.database, workspaceId);
    const response = await fetchComments(harness, apiKey);

    expect(response.statusCode).toBe(200);
    const body = response.body as unknown as CommentsPage;
    expect(body.items.map((item) => item.id)).toContain(commentId);
  });
}

/**
 * T011 (FR-006 negative half): `sync` is absent — not `null` — from an identifier-free response.
 * `'sync' in body` is the assertion the brief requires; `body.sync === null` would pass against a
 * body that carries `sync: null`, which is a different (and wrong) contract.
 */
function registerNoSyncKeyTest(getHarness: () => Harness): void {
  it("omits 'sync' entirely from an identifier-free response", async () => {
    const harness = getHarness();
    const workspaceId = await seedWorkspace(harness.database);
    const socialAccountId = await seedSocialAccount(harness.database, workspaceId, 'instagram');
    await seedComment(harness.database, {
      workspaceId,
      socialAccountId,
      platform: 'instagram',
      platformPostId: `instagram-external-${generateId()}`,
      occurredAt: new Date(),
    });
    const apiKey = await mintApiKey(harness.database, workspaceId);

    const response = await fetchComments(harness, apiKey);

    expect(response.statusCode).toBe(200);
    expect('sync' in response.body).toBe(false);
  });
}

const SEED_BASE_MS = Date.parse('2026-01-05T00:00:00.000Z');

interface PagingFixture {
  readonly workspaceId: WorkspaceId;
  readonly apiKey: string;
  readonly socialAccountId: string;
}

async function setUpPagingFixture(database: Database): Promise<PagingFixture> {
  const workspaceId = await seedWorkspace(database);
  const socialAccountId = await seedSocialAccount(database, workspaceId, 'instagram');
  const apiKey = await mintApiKey(database, workspaceId);
  return { workspaceId, apiKey, socialAccountId };
}

async function seedComments(
  database: Database,
  fixture: PagingFixture,
  offsetsMs: readonly number[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const offsetMs of offsetsMs) {
    // Timestamps must be strictly increasing in insertion order for the ordering assertions
    // below, so these inserts are sequential rather than Promise.all'd.
    // oxlint-disable-next-line no-await-in-loop
    const id = await seedComment(database, {
      workspaceId: fixture.workspaceId,
      socialAccountId: fixture.socialAccountId,
      platform: 'instagram',
      platformPostId: `instagram-external-${generateId()}`,
      occurredAt: new Date(SEED_BASE_MS + offsetMs),
    });
    ids.push(id);
  }
  return ids;
}

async function fetchOnePage(
  harness: Harness,
  apiKey: string,
  order: 'asc' | 'desc',
  cursor?: string,
): Promise<CommentsPage> {
  const query: Record<string, string> = { limit: '5', order };
  if (cursor !== undefined) {
    query['cursor'] = cursor;
  }
  const response = await fetchComments(harness, apiKey, query);
  expect(response.statusCode).toBe(200);
  return response.body as unknown as CommentsPage;
}

/** Walks every page for `order`, collecting every returned id, starting from `startCursor`. */
async function walkAllPages(
  harness: Harness,
  apiKey: string,
  order: 'asc' | 'desc',
  startCursor?: string,
): Promise<string[]> {
  const collected: string[] = [];
  let cursor = startCursor;
  for (let guard = 0; guard < 50; guard += 1) {
    // Each page's cursor is only known after the previous page responds.
    // oxlint-disable-next-line no-await-in-loop
    const page = await fetchOnePage(harness, apiKey, order, cursor);
    collected.push(...page.items.map((item) => item.id));
    if (page.nextCursor === null) {
      return collected;
    }
    cursor = page.nextCursor;
  }
  throw new Error('walkAllPages did not terminate — nextCursor never became null');
}

/**
 * T012 / SC-003 (quickstart V2): walks a seeded history to exhaustion at `limit=5`, inserting new
 * comments between pages, and asserts the multiset of returned ids equals the originally seeded
 * set — no duplicate, no gap — in both `order` directions.
 */
function registerExactPagingUnderConcurrentInsertsTest(getHarness: () => Harness): void {
  it.each(['desc', 'asc'] as const)(
    'pages every seeded comment exactly once across an insert (order=%s)',
    async (order) => {
      const harness = getHarness();
      const fixture = await setUpPagingFixture(harness.database);
      const seededOffsets = Array.from({ length: 12 }, (_unused, index) => index * 1000);
      const ids = await seedComments(harness.database, fixture, seededOffsets);

      const firstPage = await fetchOnePage(harness, fixture.apiKey, order);
      expect(firstPage.items).toHaveLength(5);
      expect(firstPage.nextCursor).not.toBeNull();

      // Interspersed before, inside and after the already-seeded range.
      await seedComments(harness.database, fixture, [-500, 4500, 8500, 20_000]);

      const rest = await walkAllPages(
        harness,
        fixture.apiKey,
        order,
        firstPage.nextCursor as string,
      );
      const allIds = [...firstPage.items.map((item) => item.id), ...rest];
      const originalIdsInOrder = allIds.filter((id) => ids.includes(id));

      for (const id of ids) {
        const occurrences = allIds.filter((candidate) => candidate === id).length;
        expect(occurrences, `comment ${id} should appear exactly once`).toBe(1);
      }
      expect(new Set(originalIdsInOrder).size).toBe(ids.length);
      expect(originalIdsInOrder).toEqual(order === 'desc' ? ids.toReversed() : ids);
    },
  );
}

/** T012's validation half: each of these is a `400 VALIDATION_ERROR`, not a `200` or a `404`. */
function registerPagingValidationTests(getHarness: () => Harness): void {
  describe('paging parameter validation (D27)', () => {
    it('rejects limit=0', async () => {
      const harness = getHarness();
      const fixture = await setUpPagingFixture(harness.database);
      const response = await fetchComments(harness, fixture.apiKey, { limit: '0' });
      assertProblem(response, 400, 'VALIDATION_ERROR');
    });

    it('rejects limit=101', async () => {
      const harness = getHarness();
      const fixture = await setUpPagingFixture(harness.database);
      const response = await fetchComments(harness, fixture.apiKey, { limit: '101' });
      assertProblem(response, 400, 'VALIDATION_ERROR');
    });

    it('rejects a truncated cursor', async () => {
      const harness = getHarness();
      const fixture = await setUpPagingFixture(harness.database);
      const validCursor = encodeCursor({ occurredAt: new Date(), id: generateId() }, 'desc');
      const truncated = validCursor.slice(0, Math.max(1, Math.floor(validCursor.length / 2)));
      const response = await fetchComments(harness, fixture.apiKey, {
        cursor: truncated,
        order: 'desc',
      });
      assertProblem(response, 400, 'VALIDATION_ERROR');
    });

    it('rejects a desc cursor replayed with order=asc', async () => {
      const harness = getHarness();
      const fixture = await setUpPagingFixture(harness.database);
      const descCursor = encodeCursor({ occurredAt: new Date(), id: generateId() }, 'desc');
      const response = await fetchComments(harness, fixture.apiKey, {
        cursor: descCursor,
        order: 'asc',
      });
      assertProblem(response, 400, 'VALIDATION_ERROR');
    });

    it('accepts the limit bounds themselves', async () => {
      const harness = getHarness();
      const fixture = await setUpPagingFixture(harness.database);
      for (const limit of ['1', '100']) {
        // oxlint-disable-next-line no-await-in-loop -- one shared fixture, two sequential reads.
        const response = await fetchComments(harness, fixture.apiKey, { limit });
        expect(response.statusCode, `limit=${limit} must be accepted`).toBe(200);
      }
    });
  });
}

/**
 * A value the schema cannot parse, and a key the schema does not define, are both
 * `400 VALIDATION_ERROR` (contracts/rest-api.md's failure table).
 *
 * The unknown-key half is the load-bearing one: Zod objects strip unrecognized keys by default, so
 * before `listCommentsQuerySchema` was made strict a request the client believed was narrowed to
 * one post (`?post_id=…`, snake_case, or `?platform[]=…`, the bracket-array convention) answered
 * `200` with the *entire* workspace's history. A filter silently not applied is the one failure
 * mode of this endpoint a client cannot detect from the response.
 */
function registerQueryRejectionTests(getHarness: () => Harness): void {
  describe('query parameter rejection', () => {
    const malformedValues: Readonly<Record<string, Record<string, string>>> = {
      'postId that is not a uuid': { postId: 'not-a-uuid' },
      'parentCommentId that is not a uuid': { parentCommentId: 'not-a-uuid' },
      'accountId that is not a uuid': { accountId: 'not-a-uuid' },
      'since that is not a timestamp': { since: 'not-a-date' },
      'until that is not a timestamp': { until: 'yesterday' },
      'order that is neither asc nor desc': { order: 'sideways' },
      'limit that is not a number': { limit: 'abc' },
      'topLevelOnly that is not a boolean': { topLevelOnly: 'yes' },
      'isOwn that is not a boolean': { isOwn: '1' },
    };

    const unknownKeys: Readonly<Record<string, Record<string, string>>> = {
      'a snake_case spelling of postId': { post_id: '01a09c8e-1fe0-7af5-b5c9-c4a1a2955376' },
      'a misspelled postId': { postid: '01a09c8e-1fe0-7af5-b5c9-c4a1a2955376' },
      'a bracket-array spelling of platform': { 'platform[]': 'bluesky' },
      'a key the schema does not define at all': { unsupported: 'whatever' },
    };

    for (const [name, query] of Object.entries({ ...malformedValues, ...unknownKeys })) {
      it(`rejects ${name}`, async () => {
        const harness = getHarness();
        const fixture = await setUpPagingFixture(harness.database);
        const response = await fetchComments(harness, fixture.apiKey, query);
        assertProblem(response, 400, 'VALIDATION_ERROR');
      });
    }
  });
}

/**
 * The two keyset boundaries a walk can get wrong without any test noticing (SC-003, D27).
 *
 * Ties: with several rows sharing one `occurred_at`, the page boundary falls *inside* the group, and
 * only the row comparison `(occurred_at, id) < (cursor)` resumes correctly there. The decomposed
 * form `occurred_at < c OR (occurred_at = c AND id < c)` is easy to write subtly wrong, and every
 * distinct-timestamp fixture agrees with it. Seeding a tie is what separates them.
 *
 * Exact multiples: `listByPredicate` asks for `limit + 1` rows and reports more pages when it gets
 * them. With exactly `limit` rows visible there is no extra row, so the page must be the last one.
 * A `>=` in place of that `>` yields one extra empty page — which `walkAllPages` still terminates on
 * and every "exactly once" assertion still passes, since an empty page contributes no ids.
 */
function registerKeysetBoundaryTests(getHarness: () => Harness): void {
  describe('keyset boundaries (SC-003, D27)', () => {
    const orders: readonly ('asc' | 'desc')[] = ['asc', 'desc'];

    for (const order of orders) {
      it(`walks tied occurred_at values exactly once in ${order} order`, async () => {
        const harness = getHarness();
        const fixture = await setUpPagingFixture(harness.database);
        // Twelve rows in four groups of three identical timestamps: with limit=5 the first page
        // ends in the middle of the second group and the second page in the middle of the third,
        // so two different page boundaries fall inside a tie.
        const ids = await seedComments(
          harness.database,
          fixture,
          [0, 0, 0, 1000, 1000, 1000, 2000, 2000, 2000, 3000, 3000, 3000],
        );

        const walked = await walkAllPages(harness, fixture.apiKey, order);

        expect(walked).toHaveLength(ids.length);
        expect(new Set(walked).size).toBe(ids.length);
        expect(walked.toSorted()).toEqual(ids.toSorted());
      });
    }

    it('reports no further page when the last one is exactly full', async () => {
      const harness = getHarness();
      const fixture = await setUpPagingFixture(harness.database);
      // Exactly the page size, so `limit + 1` returns no extra row.
      await seedComments(harness.database, fixture, [0, 1000, 2000, 3000, 4000]);

      const page = await fetchOnePage(harness, fixture.apiKey, 'desc');

      expect(page.items).toHaveLength(5);
      expect(page.nextCursor).toBeNull();
    });
  });
}

/**
 * `?postId=` alone selects every level of that post, and `topLevelOnly=true` is what narrows it to
 * the top (FR-002).
 *
 * Filters intersect and none is implied: an implementation that folded `parent_comment_id IS NULL`
 * into the `postId` condition — the shape the removed `GET /v1/posts/:postId/comments` route had,
 * where the two were one address — passes every other `postId` case in this suite, because every
 * one of them also sends `topLevelOnly=true`.
 */
function registerPostIdWithoutTopLevelOnlyTest(getHarness: () => Harness): void {
  it("returns a post's replies too when topLevelOnly is absent (FR-002)", async () => {
    const harness = getHarness();
    const fixture = await setUpPagingFixture(harness.database);
    const post = await seedPostRow(
      harness.database,
      fixture.workspaceId,
      fixture.socialAccountId,
      'instagram',
    );
    const seed = {
      workspaceId: fixture.workspaceId,
      socialAccountId: fixture.socialAccountId,
      platform: 'instagram',
      postId: post.postId,
      platformPostId: post.platformPostId,
    };
    const parentId = await seedCommentDetailed(harness.database, {
      ...seed,
      occurredAt: new Date(SEED_BASE_MS),
    });
    const replyId = await seedCommentDetailed(harness.database, {
      ...seed,
      occurredAt: new Date(SEED_BASE_MS + 1000),
      parentCommentId: parentId,
      rootCommentId: parentId,
      depth: 1,
    });

    const unnarrowed = await fetchComments(harness, fixture.apiKey, { postId: post.postId });
    const narrowed = await fetchComments(harness, fixture.apiKey, {
      postId: post.postId,
      topLevelOnly: 'true',
    });

    expect(unnarrowed.statusCode).toBe(200);
    const unnarrowedIds = (unnarrowed.body as unknown as CommentsPage).items.map((item) => item.id);
    expect(unnarrowedIds.toSorted()).toEqual([parentId, replyId].toSorted());
    expect(narrowed.statusCode).toBe(200);
    const narrowedIds = (narrowed.body as unknown as CommentsPage).items.map((item) => item.id);
    expect(narrowedIds).toEqual([parentId]);
  });
}

interface DetailedSeedInput {
  readonly workspaceId: WorkspaceId;
  readonly socialAccountId: string;
  readonly platform: string;
  readonly postId?: string | null;
  readonly platformPostId: string;
  readonly occurredAt: Date;
  readonly parentCommentId?: string | null;
  readonly rootCommentId?: string | null;
  readonly depth?: number;
  readonly isOwn?: boolean;
  readonly status?: 'queued' | 'processing' | 'posted' | 'failed' | 'deleted';
}

/** Like {@link seedComment}, with the extra columns T020's filter-semantics cases need to vary. */
async function seedCommentDetailed(database: Database, input: DetailedSeedInput): Promise<string> {
  const id = generateId();
  await database.drizzle.insert(comments).values({
    id,
    workspaceId: input.workspaceId,
    socialAccountId: input.socialAccountId,
    platform: input.platform,
    postId: input.postId ?? null,
    platformPostId: input.platformPostId,
    parentCommentId: input.parentCommentId ?? null,
    rootCommentId: input.rootCommentId ?? null,
    depth: input.depth ?? 0,
    platformCommentId: `${input.platform}-comment-${id}`,
    isOwn: input.isOwn ?? false,
    source: 'sync',
    authorPlatformId: `author-${id}`,
    authorUsername: `author-${id}`,
    authorDisplayName: null,
    text: `comment ${id}`,
    status: input.status ?? 'posted',
    replyCount: 0,
    lastActivityAt: input.occurredAt,
    occurredAt: input.occurredAt,
    createdAt: input.occurredAt,
    updatedAt: input.occurredAt,
  });
  return id;
}

/** T020/V3: `platform=instagram&platform=bluesky` returns the union, excluding a third platform. */
function registerPlatformUnionTest(getHarness: () => Harness): void {
  it('returns the union for repeated platform params, excluding an unlisted platform', async () => {
    const harness = getHarness();
    const workspaceId = await seedWorkspace(harness.database);
    const igAccountId = await seedSocialAccount(harness.database, workspaceId, 'instagram');
    const blueskyAccountId = await seedSocialAccount(harness.database, workspaceId, 'bluesky');
    const fbAccountId = await seedSocialAccount(harness.database, workspaceId, 'facebook');
    const now = new Date();
    const igId = await seedCommentDetailed(harness.database, {
      workspaceId,
      socialAccountId: igAccountId,
      platform: 'instagram',
      platformPostId: `instagram-external-${generateId()}`,
      occurredAt: now,
    });
    const blueskyId = await seedCommentDetailed(harness.database, {
      workspaceId,
      socialAccountId: blueskyAccountId,
      platform: 'bluesky',
      platformPostId: `bluesky-external-${generateId()}`,
      occurredAt: now,
    });
    const fbId = await seedCommentDetailed(harness.database, {
      workspaceId,
      socialAccountId: fbAccountId,
      platform: 'facebook',
      platformPostId: `facebook-external-${generateId()}`,
      occurredAt: now,
    });
    const apiKey = await mintApiKey(harness.database, workspaceId);

    const search = new URLSearchParams();
    search.append('platform', 'instagram');
    search.append('platform', 'bluesky');
    const raw = await harness.app.inject({
      method: 'GET',
      url: `/v1/comments?${search.toString()}`,
      headers: { 'blotato-api-key': apiKey },
    });

    expect(raw.statusCode).toBe(200);
    const body = raw.json() as CommentsPage;
    const ids = body.items.map((item) => item.id);
    expect(ids).toContain(igId);
    expect(ids).toContain(blueskyId);
    expect(ids).not.toContain(fbId);
  });
}

/**
 * T020/V3: `platform=tiktok` is accepted (a known, comment-less platform) and answers an empty
 * page.
 */
function registerKnownCommentlessPlatformTest(getHarness: () => Harness): void {
  it('accepts platform=tiktok and returns an empty page', async () => {
    const harness = getHarness();
    const workspaceId = await seedWorkspace(harness.database);
    const igAccountId = await seedSocialAccount(harness.database, workspaceId, 'instagram');
    await seedCommentDetailed(harness.database, {
      workspaceId,
      socialAccountId: igAccountId,
      platform: 'instagram',
      platformPostId: `instagram-external-${generateId()}`,
      occurredAt: new Date(),
    });
    const apiKey = await mintApiKey(harness.database, workspaceId);

    const response = await fetchComments(harness, apiKey, { platform: 'tiktok' });

    expect(response.statusCode).toBe(200);
    expect((response.body as unknown as CommentsPage).items).toEqual([]);
  });
}

/**
 * T020/V3: `platform=nonsense` — not one of the nine registry keys — is `400 VALIDATION_ERROR`.
 */
function registerUnknownPlatformRejectedTest(getHarness: () => Harness): void {
  it('rejects platform=nonsense with 400 VALIDATION_ERROR', async () => {
    const harness = getHarness();
    const workspaceId = await seedWorkspace(harness.database);
    const apiKey = await mintApiKey(harness.database, workspaceId);

    const response = await fetchComments(harness, apiKey, { platform: 'nonsense' });

    assertProblem(response, 400, 'VALIDATION_ERROR');
  });
}

/**
 * T020/V3 (clarification 2026-09-14): `topLevelOnly=true` together with `parentCommentId` is an
 * empty `200`, not `400` — the two predicates (`parent_comment_id IS NULL` and `parent_comment_id
 * = :id`) simply intersect to nothing, which is a valid question with an empty answer.
 */
function registerTopLevelOnlyWithParentIntersectionTest(getHarness: () => Harness): void {
  it('answers 200 with an empty page for topLevelOnly=true plus parentCommentId', async () => {
    const harness = getHarness();
    const workspaceId = await seedWorkspace(harness.database);
    const socialAccountId = await seedSocialAccount(harness.database, workspaceId, 'instagram');
    const parentId = await seedCommentDetailed(harness.database, {
      workspaceId,
      socialAccountId,
      platform: 'instagram',
      platformPostId: `instagram-external-${generateId()}`,
      occurredAt: new Date(),
    });
    const apiKey = await mintApiKey(harness.database, workspaceId);

    const response = await fetchComments(harness, apiKey, {
      topLevelOnly: 'true',
      parentCommentId: parentId,
    });

    expect(response.statusCode).toBe(200);
    expect((response.body as unknown as CommentsPage).items).toEqual([]);
  });
}

/**
 * T020/V3: a `postId` combined with a `parentCommentId` whose parent lives on a *different* post is
 * an empty `200` — no reply row can carry both `postId: A` and `parentCommentId: <a parent stored
 * under B>`, since a reply's own `postId` follows its parent's post.
 */
function registerPostIdWithMismatchedParentPostTest(getHarness: () => Harness): void {
  it('answers 200 for a postId with a parentCommentId from a different post', async () => {
    const harness = getHarness();
    const workspaceId = await seedWorkspace(harness.database);
    const socialAccountId = await seedSocialAccount(harness.database, workspaceId, 'instagram');
    const postA = await seedPostRow(harness.database, workspaceId, socialAccountId, 'instagram');
    const postB = await seedPostRow(harness.database, workspaceId, socialAccountId, 'instagram');
    await seedCommentDetailed(harness.database, {
      workspaceId,
      socialAccountId,
      platform: 'instagram',
      postId: postA.postId,
      platformPostId: postA.platformPostId,
      occurredAt: new Date(),
    });
    const parentOnB = await seedCommentDetailed(harness.database, {
      workspaceId,
      socialAccountId,
      platform: 'instagram',
      postId: postB.postId,
      platformPostId: postB.platformPostId,
      occurredAt: new Date(),
    });
    await seedCommentDetailed(harness.database, {
      workspaceId,
      socialAccountId,
      platform: 'instagram',
      postId: postB.postId,
      platformPostId: postB.platformPostId,
      parentCommentId: parentOnB,
      rootCommentId: parentOnB,
      depth: 1,
      occurredAt: new Date(),
    });
    const apiKey = await mintApiKey(harness.database, workspaceId);

    const response = await fetchComments(harness, apiKey, {
      postId: postA.postId,
      parentCommentId: parentOnB,
    });

    expect(response.statusCode).toBe(200);
    expect((response.body as unknown as CommentsPage).items).toEqual([]);
  });
}

/** T020/V3: `since` later than `until` is an empty `200`, not `400` — an unsatisfiable window is
 * still a well-formed question. */
function registerSinceAfterUntilTest(getHarness: () => Harness): void {
  it('answers 200 with an empty page when since is later than until', async () => {
    const harness = getHarness();
    const workspaceId = await seedWorkspace(harness.database);
    const socialAccountId = await seedSocialAccount(harness.database, workspaceId, 'instagram');
    await seedCommentDetailed(harness.database, {
      workspaceId,
      socialAccountId,
      platform: 'instagram',
      platformPostId: `instagram-external-${generateId()}`,
      occurredAt: new Date('2026-04-01T00:00:00.000Z'),
    });
    const apiKey = await mintApiKey(harness.database, workspaceId);

    const response = await fetchComments(harness, apiKey, {
      since: '2026-04-02T00:00:00.000Z',
      until: '2026-04-01T00:00:00.000Z',
    });

    expect(response.statusCode).toBe(200);
    expect((response.body as unknown as CommentsPage).items).toEqual([]);
  });
}

/**
 * M-5: `since`/`until` are documented as inclusive at both ends (contracts/rest-api.md), and
 * `comment-repository.ts` implements that with `gte`/`lte`. Before this test, the only time-range
 * coverage was {@link registerSinceAfterUntilTest}'s empty-page case, which stays green whether
 * the repository compares with `gte`/`lte` or `gt`/`lt` — a boundary comment is included either
 * way it is missing there. This asserts a comment exactly on each boundary is returned.
 */
function registerInclusiveBoundsTest(getHarness: () => Harness): void {
  it('includes comments exactly on the since and until boundaries', async () => {
    const harness = getHarness();
    const workspaceId = await seedWorkspace(harness.database);
    const socialAccountId = await seedSocialAccount(harness.database, workspaceId, 'instagram');
    const since = '2026-04-01T00:00:00.000Z';
    const until = '2026-04-03T00:00:00.000Z';
    const onSinceId = await seedCommentDetailed(harness.database, {
      workspaceId,
      socialAccountId,
      platform: 'instagram',
      platformPostId: `instagram-external-${generateId()}`,
      occurredAt: new Date(since),
    });
    const onUntilId = await seedCommentDetailed(harness.database, {
      workspaceId,
      socialAccountId,
      platform: 'instagram',
      platformPostId: `instagram-external-${generateId()}`,
      occurredAt: new Date(until),
    });
    const apiKey = await mintApiKey(harness.database, workspaceId);

    const response = await fetchComments(harness, apiKey, { since, until });

    expect(response.statusCode).toBe(200);
    const ids = (response.body as unknown as CommentsPage).items.map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining([onSinceId, onUntilId]));
  });
}

/**
 * M-4: `contracts/rest-api.md` promises plain ISO 8601 for `since`/`until`, which includes a
 * numeric timezone offset, not only `Z` — `listCommentsQuerySchema` used to reject one with a
 * `400` (`z.iso.datetime()` defaults to `Z`-only). Asserts an offset-bearing `since` both parses
 * (no `400`) and filters correctly against a UTC-stamped row, so the fix is in the comparison, not
 * only in what the validator accepts.
 */
function registerTimezoneOffsetTest(getHarness: () => Harness): void {
  it('accepts a since with a numeric timezone offset and filters by it', async () => {
    const harness = getHarness();
    const workspaceId = await seedWorkspace(harness.database);
    const socialAccountId = await seedSocialAccount(harness.database, workspaceId, 'instagram');
    // 2026-04-01T00:00:00+02:00 is 2026-03-31T22:00:00Z.
    const beforeId = await seedCommentDetailed(harness.database, {
      workspaceId,
      socialAccountId,
      platform: 'instagram',
      platformPostId: `instagram-external-${generateId()}`,
      occurredAt: new Date('2026-03-31T21:00:00.000Z'),
    });
    const afterId = await seedCommentDetailed(harness.database, {
      workspaceId,
      socialAccountId,
      platform: 'instagram',
      platformPostId: `instagram-external-${generateId()}`,
      occurredAt: new Date('2026-03-31T23:00:00.000Z'),
    });
    const apiKey = await mintApiKey(harness.database, workspaceId);

    const response = await fetchComments(harness, apiKey, { since: '2026-04-01T00:00:00+02:00' });

    expect(response.statusCode).toBe(200);
    const ids = (response.body as unknown as CommentsPage).items.map((item) => item.id);
    expect(ids).toEqual([afterId]);
    expect(ids).not.toContain(beforeId);
  });
}

/** T020: `isOwn=false` is honoured as `false`, not coerced to `true` — the negative case both an
 * absent filter and a broken coercion would pass. */
function registerIsOwnFalseHonouredTest(getHarness: () => Harness): void {
  it('honours isOwn=false, excluding the workspace own comment', async () => {
    const harness = getHarness();
    const workspaceId = await seedWorkspace(harness.database);
    const socialAccountId = await seedSocialAccount(harness.database, workspaceId, 'instagram');
    const audienceId = await seedCommentDetailed(harness.database, {
      workspaceId,
      socialAccountId,
      platform: 'instagram',
      platformPostId: `instagram-external-${generateId()}`,
      occurredAt: new Date(),
      isOwn: false,
    });
    const ownId = await seedCommentDetailed(harness.database, {
      workspaceId,
      socialAccountId,
      platform: 'instagram',
      platformPostId: `instagram-external-${generateId()}`,
      occurredAt: new Date(),
      isOwn: true,
    });
    const apiKey = await mintApiKey(harness.database, workspaceId);

    const response = await fetchComments(harness, apiKey, { isOwn: 'false' });

    expect(response.statusCode).toBe(200);
    const ids = (response.body as unknown as CommentsPage).items.map((item) => item.id);
    expect(ids).toContain(audienceId);
    expect(ids).not.toContain(ownId);
  });
}

/** T020: there is no status filter — a caller's own queued/processing/failed comments appear
 * alongside posted ones, governed only by the existing visibility rule. */
function registerNonPostedStatusesVisibleTest(getHarness: () => Harness): void {
  it('lists queued, processing and failed comments alongside posted ones', async () => {
    const harness = getHarness();
    const workspaceId = await seedWorkspace(harness.database);
    const socialAccountId = await seedSocialAccount(harness.database, workspaceId, 'instagram');
    const now = new Date();
    const statuses = ['queued', 'processing', 'posted', 'failed'] as const;
    const idsByStatus = new Map<string, string>();
    for (const status of statuses) {
      // Distinct statuses inserted sequentially so a later `occurredAt` reliably distinguishes
      // them if the assertion ever needs order — the seed itself has no ordering requirement.
      // oxlint-disable-next-line no-await-in-loop
      const id = await seedCommentDetailed(harness.database, {
        workspaceId,
        socialAccountId,
        platform: 'instagram',
        platformPostId: `instagram-external-${generateId()}`,
        occurredAt: now,
        status,
      });
      idsByStatus.set(status, id);
    }
    const apiKey = await mintApiKey(harness.database, workspaceId);

    const response = await fetchComments(harness, apiKey, { limit: '20' });

    expect(response.statusCode).toBe(200);
    const ids = (response.body as unknown as CommentsPage).items.map((item) => item.id);
    for (const status of statuses) {
      expect(ids, `status ${status} should be visible`).toContain(idsByStatus.get(status));
    }
  });
}

interface SeededSyncTarget {
  readonly workspaceId: WorkspaceId;
  readonly targetId: string;
  readonly postId: string;
  readonly apiKey: string;
}

/** A workspace with one Instagram account, a post and that post's `comment_sync_targets` row. */
async function seedSyncTarget(
  database: Database,
  lastSyncedAt: Date | null,
): Promise<SeededSyncTarget> {
  const workspaceId = await seedWorkspace(database);
  const socialAccountId = await seedSocialAccount(database, workspaceId, 'instagram');
  const seededPost = await seedPostRow(database, workspaceId, socialAccountId, 'instagram');
  const targetId = generateId();
  await database.drizzle.insert(commentSyncTargets).values({
    id: targetId,
    workspaceId,
    socialAccountId,
    postId: seededPost.postId,
    platformPostId: seededPost.platformPostId,
    lastSyncedAt,
    nextSyncAt: new Date(Date.now() + 60_000),
    lastError: null,
    manualCooldownUntil: null,
    ageAnchorAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
  });
  const apiKey = await mintApiKey(database, workspaceId);
  return { workspaceId, targetId, postId: seededPost.postId, apiKey };
}

/** Inserts one `comment_sync_jobs` row for `target`, and returns its id. */
async function seedSyncJob(
  database: Database,
  target: SeededSyncTarget,
  status: string,
): Promise<string> {
  const id = generateId();
  await database.drizzle.insert(commentSyncJobs).values({
    id,
    workspaceId: target.workspaceId,
    targetId: target.targetId,
    trigger: 'manual',
    status,
    finishedAt: status === 'succeeded' ? new Date() : null,
  });
  return id;
}

/**
 * `occurred_at` must not hold more precision than the cursor can carry (SC-003, D27).
 *
 * `encodeCursor` writes `toISOString()`, which is millisecond-precision. A column storing
 * microseconds would therefore make a cursor un-representable: resuming `desc` after a row at
 * `.123456` with a cursor reading `.123` skips every row in `.123000`–`.123999`, and `asc` returns
 * the cursor row again. Every current writer passes a JS `Date`, so nothing stores microseconds
 * today — this pins the column, so the guarantee is the database's rather than a convention every
 * future writer has to know.
 */
function registerOccurredAtPrecisionTest(getHarness: () => Harness): void {
  it("stores occurred_at at millisecond precision, the cursor's own resolution", async () => {
    const harness = getHarness();
    const fixture = await setUpPagingFixture(harness.database);
    const commentId = await seedComment(harness.database, {
      workspaceId: fixture.workspaceId,
      socialAccountId: fixture.socialAccountId,
      platform: 'instagram',
      platformPostId: `instagram-external-${generateId()}`,
      occurredAt: new Date(SEED_BASE_MS),
    });
    // Written as raw SQL because a JS `Date` cannot express sub-millisecond time at all: the point
    // is what the column does with a value that can.
    await harness.database.drizzle.execute(
      sql`UPDATE comments SET occurred_at = '2026-01-05T00:00:00.123456+00'::timestamptz WHERE id = ${commentId}`,
    );

    // Read as text, not through the column mapper: node-postgres parses a timestamp into a JS
    // `Date`, which is itself millisecond-precision, so any stored microseconds are invisible from
    // TypeScript — and invisible is exactly the problem. The keyset comparison runs in Postgres,
    // against the stored value, so that is the value this must assert.
    const stored = await harness.database.drizzle.execute<{ text: string }>(
      sql`SELECT occurred_at::text AS text FROM comments WHERE id = ${commentId}`,
    );

    expect(stored.rows[0]?.text).toBe('2026-01-05 00:00:00.123+00');
  });
}

/** T020/V4 (R-08): `sync` is present when a post is named, other filters notwithstanding. */
function registerSyncPresentForPostIdTest(getHarness: () => Harness): void {
  it("includes 'sync' for ?postId=…&platform=instagram", async () => {
    const harness = getHarness();
    const lastSyncedAt = new Date('2026-04-03T00:00:00.000Z');
    const target = await seedSyncTarget(harness.database, lastSyncedAt);

    const response = await fetchComments(harness, target.apiKey, {
      postId: target.postId,
      platform: 'instagram',
    });

    expect(response.statusCode).toBe(200);
    expect('sync' in response.body).toBe(true);
    // The block's contents, not only its presence: `getSyncStatus` returning a constant
    // `{ lastSyncedAt: null, activeJobId: null }` satisfies `'sync' in body` for every case here.
    expect(response.body['sync']).toEqual({
      lastSyncedAt: lastSyncedAt.toISOString(),
      activeJobId: null,
    });
  });
}

/**
 * `activeJobId` names the running job, which is the half of FR-006 that answers "is a refresh
 * happening right now" (acceptance 2.1). Only a `queued` or `running` job counts: a finished one
 * must read back `null`, or a client would poll a job that is already over.
 */
function registerActiveSyncJobTest(getHarness: () => Harness): void {
  it('reports a queued sync job as the active one, and a finished one as none', async () => {
    const harness = getHarness();
    const target = await seedSyncTarget(harness.database, null);
    await seedSyncJob(harness.database, target, 'succeeded');

    const finished = await fetchComments(harness, target.apiKey, { postId: target.postId });
    expect(finished.statusCode).toBe(200);
    expect(finished.body['sync']).toEqual({ lastSyncedAt: null, activeJobId: null });

    const queuedJobId = await seedSyncJob(harness.database, target, 'queued');

    const active = await fetchComments(harness, target.apiKey, { postId: target.postId });
    expect(active.statusCode).toBe(200);
    expect(active.body['sync']).toEqual({ lastSyncedAt: null, activeJobId: queuedJobId });
  });
}

/**
 * T020/V4: `'sync' in body === false` for a selection that names an identifier *other than a
 * post* — asserted for both `accountId` and `parentCommentId` (not only the identifier-free
 * case), since a condition written as "an identifier filter is present" instead of "a post is
 * named" would pass the identifier-free assertion and still violate the contract.
 */
function registerSyncAbsentForNonPostIdentifiersTest(getHarness: () => Harness): void {
  it("omits 'sync' for ?accountId=… and for ?parentCommentId=…", async () => {
    const harness = getHarness();
    const workspaceId = await seedWorkspace(harness.database);
    const socialAccountId = await seedSocialAccount(harness.database, workspaceId, 'instagram');
    const parentId = await seedCommentDetailed(harness.database, {
      workspaceId,
      socialAccountId,
      platform: 'instagram',
      platformPostId: `instagram-external-${generateId()}`,
      occurredAt: new Date(),
    });
    const apiKey = await mintApiKey(harness.database, workspaceId);

    const byAccount = await fetchComments(harness, apiKey, { accountId: socialAccountId });
    expect(byAccount.statusCode).toBe(200);
    expect('sync' in byAccount.body).toBe(false);

    const byParent = await fetchComments(harness, apiKey, { parentCommentId: parentId });
    expect(byParent.statusCode).toBe(200);
    expect('sync' in byParent.body).toBe(false);
  });
}

describe('GET /v1/comments', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness();
  });

  afterAll(async () => {
    await stopHarness(harness);
  });

  registerCrossAccountInboxTest(() => harness);
  registerNoPortCallTest(() => harness);
  registerPostIdPortCallTest(() => harness);
  registerAccountIdPortCallTest(() => harness);
  registerDanglingPostReferenceTest(() => harness);
  registerNoSyncKeyTest(() => harness);
  registerExactPagingUnderConcurrentInsertsTest(() => harness);
  registerPagingValidationTests(() => harness);
  registerQueryRejectionTests(() => harness);
  registerKeysetBoundaryTests(() => harness);
  registerPostIdWithoutTopLevelOnlyTest(() => harness);

  describe('filter semantics (T020, quickstart.md V3-V4)', () => {
    registerPlatformUnionTest(() => harness);
    registerKnownCommentlessPlatformTest(() => harness);
    registerUnknownPlatformRejectedTest(() => harness);
    registerTopLevelOnlyWithParentIntersectionTest(() => harness);
    registerPostIdWithMismatchedParentPostTest(() => harness);
    registerSinceAfterUntilTest(() => harness);
    registerInclusiveBoundsTest(() => harness);
    registerTimezoneOffsetTest(() => harness);
    registerIsOwnFalseHonouredTest(() => harness);
    registerNonPostedStatusesVisibleTest(() => harness);
    registerOccurredAtPrecisionTest(() => harness);
    registerSyncPresentForPostIdTest(() => harness);
    registerActiveSyncJobTest(() => harness);
    registerSyncAbsentForNonPostIdentifiersTest(() => harness);
  });
});
