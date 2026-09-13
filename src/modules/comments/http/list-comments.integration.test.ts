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
 * Nothing under `src/modules/comments/http` registers this route yet — `routes.ts` has no
 * `registerListCommentsRoute` and `api.ts` never calls one — so every request here 404s through
 * Fastify's own not-found handler (`app.setNotFoundHandler` in `src/app/api.ts`), which itself
 * answers `application/problem+json` with `code: NOT_FOUND`. That is why every assertion below
 * checks `statusCode`/`code` before anything else: a case that expects `400 VALIDATION_ERROR`
 * still fails today, but for a distinguishable reason (`404 NOT_FOUND`), not a coincidental match.
 *
 * `CommentRepository.list` and `CommentSelection` already exist (comment-repository.ts) — this
 * file drives the route, not the repository, per "test behaviour, not implementation" (brief).
 *
 * Filters (`postId`, `accountId`, `platforms`, …) are a later phase's tests (quickstart V3-V5);
 * this file only exercises the identifier-free form: `limit`/`cursor`/`order`.
 */

import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApi, type Api, type ApiDependencies } from '#src/app/api.ts';
import { loadConfig } from '#src/app/config.ts';
import { buildContainer } from '#src/app/container.ts';
import { comments } from '#src/modules/comments/infrastructure/schema.ts';
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
      const validCursor = encodeCursor({ occurredAt: new Date(), id: generateId(), order: 'desc' });
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
      const descCursor = encodeCursor({ occurredAt: new Date(), id: generateId(), order: 'desc' });
      const response = await fetchComments(harness, fixture.apiKey, {
        cursor: descCursor,
        order: 'asc',
      });
      assertProblem(response, 400, 'VALIDATION_ERROR');
    });
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
  registerDanglingPostReferenceTest(() => harness);
  registerNoSyncKeyTest(() => harness);
  registerExactPagingUnderConcurrentInsertsTest(() => harness);
  registerPagingValidationTests(() => harness);
});
