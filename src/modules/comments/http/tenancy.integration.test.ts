// oxlint-disable max-dependencies -- an integration test harness wires together the same set of
// modules the composition root does (config, db, redis, api, schema, crypto, ids, containers) —
// see the same justification on src/app/container.ts and every other `http/*.integration.test.ts`
// file in this module.
// oxlint-disable max-lines -- this is the one file that sweeps every workspace-scoped endpoint
// (T102, V5) plus the three credential-rejection paths and both ceiling directions of the rate
// limit; splitting it by endpoint would scatter exactly the cross-endpoint comparison (identical
// 404 shape, identical 401 body) that is this file's entire reason to exist.

/**
 * Tenancy and credential sweep (T102, V5, D20, FR-026, FR-027, FR-028).
 *
 * D20 says cross-workspace access is indistinguishable from non-existence. That is a property of
 * the service, not of any one route, so it is checked here once per route rather than trusted from
 * each route's own test file: every endpoint that takes a workspace-scoped resource is called with
 * a second workspace's key against the first workspace's resource and must come back `404`, never
 * `403`, with a body no different in shape from a request for an id that was never seeded at all.
 *
 * `GET /v1/platforms` is the one authenticated endpoint with no workspace-scoped resource param
 * (T098) — the same registry, unfiltered, for every workspace — so it carries no tenancy case
 * here, only the credential ones. The four `PUBLIC_ROUTES` (`/healthz`, `/readyz`, `/openapi.json`,
 * `/docs*`, the Meta webhook) authenticate themselves a different way (or are public by D25) and
 * are out of scope for both sweeps.
 *
 * The credential section pins that "no header", "unrecognized prefix" and "revoked key" are truly
 * the same failure as far as a caller can tell (`auth.ts`'s single `unauthorized()` call site).
 *
 * The ceiling section pins T034's `min(envDefault, column)` rule in both directions: a key whose
 * own `rate_limit_per_min` is below the deployment default is cut off at the column; one whose
 * column is above the default is still cut off at the default — a per-key row must never raise
 * the budget. Every request in this file mints its own fresh API key (the convention every write
 * integration test in this module follows) so one test's calls never borrow another's bucket.
 */

import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApi, type Api } from '#src/app/api.ts';
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
import { startTestContainers, type TestContainers } from '#src/shared/testing/containers.ts';
import { TEST_ENV } from '#src/shared/testing/test-env.ts';

interface Harness {
  containers: TestContainers;
  database: Database;
  redis: Redis;
  publishQueue: Queue;
  app: Api;
}

interface MintOptions {
  readonly rateLimitPerMin?: number | null;
  readonly revokedAt?: Date | null;
}

async function mintApiKey(
  database: Database,
  workspaceId: WorkspaceId,
  options: MintOptions = {},
): Promise<string> {
  const prefix = randomBytes(6).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  await database.drizzle.insert(apiKeys).values({
    id: generateId(),
    workspaceId,
    prefix,
    keyHash: hashSecret(secret),
    name: 'test key',
    rateLimitPerMin: options.rateLimitPerMin ?? null,
    revokedAt: options.revokedAt ?? null,
    createdAt: new Date(),
  });
  return `blt_${prefix}_${secret}`;
}

/** Every workspace-scoped resource this file needs, each route's tenancy case draws one id from. */
interface SeededWorkspace {
  readonly workspaceId: WorkspaceId;
  readonly socialAccountId: string;
  readonly postId: string;
  readonly platformPostId: string;
  readonly topLevelCommentId: string;
  readonly syncJobId: string;
}

interface SeededAccountAndPost {
  readonly socialAccountId: string;
  readonly postId: string;
  readonly platformPostId: string;
}

/** Seeds a workspace, an active Instagram account under it, and a post it published. */
async function seedWorkspaceAndPost(database: Database): Promise<{
  workspaceId: WorkspaceId;
  post: SeededAccountAndPost;
}> {
  const workspaceId = asWorkspaceId(generateId());
  await database.drizzle.insert(workspaces).values({
    id: workspaceId,
    name: 'Test workspace',
    contactLimitMonthly: 1000,
    createdAt: new Date(),
  });

  const socialAccountId = generateId();
  await database.drizzle.insert(socialAccounts).values({
    id: socialAccountId,
    workspaceId,
    platform: 'instagram',
    platformAccountId: `ig-${generateId()}`,
    username: 'demo',
    credentialsCiphertext: Buffer.alloc(28),
    credentialsKeyVersion: 1,
    status: 'active',
    createdAt: new Date(),
  });

  const postId = generateId();
  const platformPostId = `ig-post-${postId}`;
  await database.drizzle.insert(posts).values({
    id: postId,
    workspaceId,
    socialAccountId,
    platform: 'instagram',
    platformPostId,
    publishedAt: new Date(),
    createdAt: new Date(),
  });

  return { workspaceId, post: { socialAccountId, postId, platformPostId } };
}

/** Seeds a posted top-level comment on `post`, ready to be read, replied to, or fetched by id. */
async function seedTopLevelComment(
  database: Database,
  workspaceId: WorkspaceId,
  post: SeededAccountAndPost,
): Promise<string> {
  const topLevelCommentId = generateId();
  const now = new Date();
  await database.drizzle.insert(comments).values({
    id: topLevelCommentId,
    workspaceId,
    socialAccountId: post.socialAccountId,
    postId: post.postId,
    platform: 'instagram',
    platformPostId: post.platformPostId,
    parentCommentId: null,
    rootCommentId: null,
    depth: 0,
    platformCommentId: `ig-comment-${topLevelCommentId}`,
    isOwn: false,
    source: 'sync',
    authorPlatformId: 'author-1',
    authorUsername: 'author1',
    authorDisplayName: null,
    text: 'hello world',
    status: 'posted',
    replyCount: 0,
    lastActivityAt: now,
    occurredAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return topLevelCommentId;
}

/** Seeds a sync target for `post` and a `succeeded` job against it, ready to be fetched by id. */
async function seedSyncJob(
  database: Database,
  workspaceId: WorkspaceId,
  post: SeededAccountAndPost,
): Promise<string> {
  const now = new Date();
  const syncTargetId = generateId();
  await database.drizzle.insert(commentSyncTargets).values({
    id: syncTargetId,
    workspaceId,
    socialAccountId: post.socialAccountId,
    postId: post.postId,
    platformPostId: post.platformPostId,
    lastSyncedAt: now,
    nextSyncAt: new Date(now.getTime() + 60_000),
    lastError: null,
    manualCooldownUntil: null,
    ageAnchorAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000),
  });

  const syncJobId = generateId();
  await database.drizzle.insert(commentSyncJobs).values({
    id: syncJobId,
    workspaceId,
    targetId: syncTargetId,
    trigger: 'manual',
    status: 'succeeded',
    stats: null,
    error: null,
    createdAt: now,
    startedAt: now,
    finishedAt: now,
  });
  return syncJobId;
}

/** Every workspace-scoped resource this file's tenancy sweep draws a single id from (T102). */
async function seedWorkspace(database: Database): Promise<SeededWorkspace> {
  const { workspaceId, post } = await seedWorkspaceAndPost(database);
  const topLevelCommentId = await seedTopLevelComment(database, workspaceId, post);
  const syncJobId = await seedSyncJob(database, workspaceId, post);

  return {
    workspaceId,
    socialAccountId: post.socialAccountId,
    postId: post.postId,
    platformPostId: post.platformPostId,
    topLevelCommentId,
    syncJobId,
  };
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

interface RawResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

async function request(
  harness: Harness,
  method: 'GET' | 'POST',
  path: string,
  apiKey?: string,
  body?: Record<string, unknown>,
): Promise<RawResponse> {
  const headers: Record<string, string> = apiKey === undefined ? {} : { 'blotato-api-key': apiKey };
  const response = await harness.app.inject({
    method,
    url: path,
    headers,
    ...(body === undefined ? {} : { payload: body }),
  });
  return {
    statusCode: response.statusCode,
    headers: response.headers as never,
    body: response.json() as Record<string, unknown>,
  };
}

/** A workspace-scoped endpoint this sweep covers (every `routes.ts` route but `/v1/platforms`). */
interface TenancyEndpoint {
  readonly label: string;
  readonly method: 'GET' | 'POST';
  readonly path: (resourceId: string) => string;
  readonly body?: Record<string, unknown>;
  /** Resolves this endpoint's resource id from an already-seeded workspace. */
  readonly resourceId: (seeded: SeededWorkspace) => string;
  readonly successStatus: number;
}

const TENANCY_ENDPOINTS: readonly TenancyEndpoint[] = [
  {
    label: 'GET /v1/posts/:postId/comments',
    method: 'GET',
    path: (id) => `/v1/posts/${id}/comments`,
    resourceId: (seeded) => seeded.postId,
    successStatus: 200,
  },
  {
    label: 'GET /v1/comments/:commentId/replies',
    method: 'GET',
    path: (id) => `/v1/comments/${id}/replies`,
    resourceId: (seeded) => seeded.topLevelCommentId,
    successStatus: 200,
  },
  {
    label: 'GET /v1/comments/:commentId',
    method: 'GET',
    path: (id) => `/v1/comments/${id}`,
    resourceId: (seeded) => seeded.topLevelCommentId,
    successStatus: 200,
  },
  {
    label: 'GET /v1/accounts/:accountId/comments',
    method: 'GET',
    path: (id) => `/v1/accounts/${id}/comments`,
    resourceId: (seeded) => seeded.socialAccountId,
    successStatus: 200,
  },
  {
    label: 'POST /v1/posts/:postId/comments',
    method: 'POST',
    path: (id) => `/v1/posts/${id}/comments`,
    body: { text: 'a fresh top-level comment' },
    resourceId: (seeded) => seeded.postId,
    successStatus: 202,
  },
  {
    label: 'POST /v1/comments/:commentId/replies',
    method: 'POST',
    path: (id) => `/v1/comments/${id}/replies`,
    body: { text: 'a fresh reply' },
    resourceId: (seeded) => seeded.topLevelCommentId,
    successStatus: 202,
  },
  {
    label: 'POST /v1/posts/:postId/comments/sync',
    method: 'POST',
    path: (id) => `/v1/posts/${id}/comments/sync`,
    resourceId: (seeded) => seeded.postId,
    successStatus: 202,
  },
  {
    label: 'GET /v1/comment-sync-jobs/:jobId',
    method: 'GET',
    path: (id) => `/v1/comment-sync-jobs/${id}`,
    resourceId: (seeded) => seeded.syncJobId,
    successStatus: 200,
  },
];

function assertNotFoundIndistinguishable(crossWorkspace: RawResponse, missing: RawResponse): void {
  expect(crossWorkspace.statusCode).toBe(404);
  expect(crossWorkspace.statusCode).not.toBe(403);
  expect(missing.statusCode).toBe(404);
  expect(crossWorkspace.headers['content-type']).toContain('application/problem+json');
  expect(crossWorkspace.body['code']).toBe('NOT_FOUND');
  expect(missing.body['code']).toBe('NOT_FOUND');
  // Shapes must match exactly, not merely both be "some 404" — nothing may leak that one id
  // belongs to a real (but foreign) row and the other never existed.
  expect(Object.keys(crossWorkspace.body).toSorted()).toEqual(Object.keys(missing.body).toSorted());
}

type WorkspacePair = readonly [own: SeededWorkspace, other: SeededWorkspace];

function registerTenancySweep(getHarness: () => Harness, getWorkspaces: () => WorkspacePair): void {
  describe.each(TENANCY_ENDPOINTS)('$label', (endpoint) => {
    it('is 404, never 403 — indistinguishable from a missing resource', async () => {
      const harness = getHarness();
      const [own, other] = getWorkspaces();
      const ownResourceId = endpoint.resourceId(own);

      const ownKey = await mintApiKey(harness.database, own.workspaceId);
      const ownPath = endpoint.path(ownResourceId);
      const asOwner = await request(harness, endpoint.method, ownPath, ownKey, endpoint.body);
      expect(asOwner.statusCode).toBe(endpoint.successStatus);

      const crossKey = await mintApiKey(harness.database, other.workspaceId);
      const crossWorkspace = await request(
        harness,
        endpoint.method,
        endpoint.path(ownResourceId),
        crossKey,
        endpoint.body,
      );

      const missingKey = await mintApiKey(harness.database, other.workspaceId);
      const missing = await request(
        harness,
        endpoint.method,
        endpoint.path(generateId()),
        missingKey,
        endpoint.body,
      );

      assertNotFoundIndistinguishable(crossWorkspace, missing);
    });
  });
}

const PLATFORMS_PATH = '/v1/platforms';

/** A well-formed but unseeded key — the "unrecognized prefix" half of the credential sweep. */
function buildBogusKey(): string {
  return `blt_${randomBytes(6).toString('hex')}_${randomBytes(16).toString('base64url')}`;
}

function registerCredentialTests(
  getHarness: () => Harness,
  getOwnWorkspaceId: () => WorkspaceId,
): void {
  describe('credential rejection (D20, FR-026)', () => {
    it('rejects a request with no API key header as 401 UNAUTHORIZED', async () => {
      const harness = getHarness();
      const response = await request(harness, 'GET', PLATFORMS_PATH);
      expect(response.statusCode).toBe(401);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.body['code']).toBe('UNAUTHORIZED');
    });

    it('rejects an unrecognized key prefix as 401 UNAUTHORIZED', async () => {
      const harness = getHarness();
      const bogusKey = buildBogusKey();
      const response = await request(harness, 'GET', PLATFORMS_PATH, bogusKey);
      expect(response.statusCode).toBe(401);
      expect(response.body['code']).toBe('UNAUTHORIZED');
    });

    it('rejects a revoked key as 401 UNAUTHORIZED', async () => {
      const harness = getHarness();
      const revokedKey = await mintApiKey(harness.database, getOwnWorkspaceId(), {
        revokedAt: new Date(),
      });
      const response = await request(harness, 'GET', PLATFORMS_PATH, revokedKey);
      expect(response.statusCode).toBe(401);
      expect(response.body['code']).toBe('UNAUTHORIZED');
    });

    it('answers all three rejection paths with exactly the same body', async () => {
      const harness = getHarness();
      const bogusKey = buildBogusKey();
      const revokedKey = await mintApiKey(harness.database, getOwnWorkspaceId(), {
        revokedAt: new Date(),
      });

      const missing = await request(harness, 'GET', PLATFORMS_PATH);
      const unrecognized = await request(harness, 'GET', PLATFORMS_PATH, bogusKey);
      const revoked = await request(harness, 'GET', PLATFORMS_PATH, revokedKey);

      expect(missing.body).toEqual(unrecognized.body);
      expect(missing.body).toEqual(revoked.body);
    });
  });
}

/** Sequentially fires `count` requests against the same key, returning each response in order. */
async function fireSequentially(
  harness: Harness,
  apiKey: string,
  method: 'GET' | 'POST',
  path: string,
  body: Record<string, unknown>,
  count: number,
): Promise<RawResponse[]> {
  const responses: RawResponse[] = [];
  for (let index = 0; index < count; index += 1) {
    // The ceiling rule is a per-key counter: requests must land in the order asserted below, so
    // firing them concurrently (and letting Redis racily interleave the increments) would make
    // "the Nth request is the one that 429s" non-deterministic.
    // oxlint-disable-next-line no-await-in-loop
    responses.push(await request(harness, method, path, apiKey, body));
  }
  return responses;
}

function assertRateLimited(response: RawResponse): void {
  expect(response.statusCode).toBe(429);
  expect(response.headers['content-type']).toContain('application/problem+json');
  expect(response.body['code']).toBe('RATE_LIMITED');
  expect(response.headers['ratelimit-limit']).toBeDefined();
  expect(response.headers['ratelimit-remaining']).toBeDefined();
  expect(response.headers['ratelimit-reset']).toBeDefined();
  expect(response.headers['retry-after']).toBeDefined();
}

/**
 * `RATE_LIMIT_WRITES_PER_MIN` defaults to 5 (T007, config.ts) — both cases below exercise the
 * write bucket so each needs only a handful of requests rather than the 30+ the read bucket's
 * default would take. Both post against `POST /v1/posts/:postId/comments`, which enqueues real
 * publish jobs but does not otherwise collide between the two keys: each key has its own bucket
 * (`keyGenerator` in `api.ts` keys on `apiKeyId`), so the two cases need no ordering between them.
 */
function registerCeilingTests(
  getHarness: () => Harness,
  getWorkspace: () => SeededWorkspace,
): void {
  const envDefault = 5;
  const body = { text: 'ceiling probe' };

  describe('the per-key ceiling is min(envDefault, column), never column alone (T034)', () => {
    it('a column below the env default cuts the key off at the column', async () => {
      const harness = getHarness();
      const seeded = getWorkspace();
      const belowDefault = 2;
      const apiKey = await mintApiKey(harness.database, seeded.workspaceId, {
        rateLimitPerMin: belowDefault,
      });
      const path = `/v1/posts/${seeded.postId}/comments`;

      const responses = await fireSequentially(
        harness,
        apiKey,
        'POST',
        path,
        body,
        belowDefault + 1,
      );

      responses.slice(0, belowDefault).forEach((response) => {
        expect(response.statusCode).toBe(202);
      });
      assertRateLimited(responses[belowDefault] as RawResponse);
    });

    it('a column above the env default is still cut off at the default', async () => {
      const harness = getHarness();
      const seeded = getWorkspace();
      const aboveDefault = envDefault * 10;
      const apiKey = await mintApiKey(harness.database, seeded.workspaceId, {
        rateLimitPerMin: aboveDefault,
      });
      const path = `/v1/posts/${seeded.postId}/comments`;

      const responses = await fireSequentially(harness, apiKey, 'POST', path, body, envDefault + 1);

      responses.slice(0, envDefault).forEach((response) => {
        expect(response.statusCode).toBe(202);
      });
      assertRateLimited(responses[envDefault] as RawResponse);
    });
  });
}

describe('tenancy and credential sweep (T102)', () => {
  let harness: Harness;
  let ownWorkspace: SeededWorkspace;
  let otherWorkspace: SeededWorkspace;
  let rateLimitWorkspace: SeededWorkspace;

  beforeAll(async () => {
    harness = await startHarness();
    ownWorkspace = await seedWorkspace(harness.database);
    otherWorkspace = await seedWorkspace(harness.database);
    rateLimitWorkspace = await seedWorkspace(harness.database);
  });

  afterAll(async () => {
    await stopHarness(harness);
  });

  registerTenancySweep(
    () => harness,
    () => [ownWorkspace, otherWorkspace],
  );
  registerCredentialTests(
    () => harness,
    () => ownWorkspace.workspaceId,
  );
  registerCeilingTests(
    () => harness,
    () => rateLimitWorkspace,
  );
});
