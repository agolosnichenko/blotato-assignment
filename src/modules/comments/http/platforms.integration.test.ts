// oxlint-disable max-dependencies -- an integration test harness wires together the same set of
// modules the composition root does (config, db, redis, api, schema, crypto, ids, containers) —
// see the same justification on src/app/container.ts and other integration tests in this module.
// oxlint-disable max-lines -- the boundary cases (T096 finding fix) now seed real accounts, posts
// and comments and drive them through the write path, the same shape
// `create-reply.integration.test.ts` uses for its own seeding helpers; splitting those helpers out
// would scatter one test file's fixtures across two rather than shrink either.

/**
 * `GET /v1/platforms` cannot drift from what the write path enforces (T096, T098, FR-031, SC-009).
 *
 * Listing nine platforms, three of them comment-capable, is the easy half and is pinned first.
 * The half that earns this test is the second describe block: the `maxReplyDepth`, `textLimit`
 * and `textUnit` the endpoint reports for a platform drive real requests through
 * `POST /v1/comments/:commentId/replies` — the actual write path, not the pure `checkReplyDepth`/
 * `checkTextLength` functions in isolation — at the boundary those values name and one step past
 * it. Nothing here compares the response to `src/platforms/registry.ts`: that would only prove
 * the endpoint serializes the file it serializes, and comparing to the pure domain functions with
 * the same numbers would only prove boundary arithmetic against a number sourced from the
 * endpoint under test. The advertised value comes from `GET /v1/platforms`; the enforced value
 * comes from whatever `create-reply.ts` reads for itself — two independent sources, so a registry
 * row edited without a matching change to enforcement fails this test, which is the point of
 * SC-009. Each boundary case mints its own API key (see `postReplyWithFreshKey`) so it lands in
 * its own write rate-limit bucket rather than sharing one with the other eleven write requests
 * this file now makes (`RATE_LIMIT_WRITES_PER_MIN` defaults to 5).
 */

import { randomBytes } from 'node:crypto';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApi, type Api } from '#src/app/api.ts';
import { loadConfig } from '#src/app/config.ts';
import { buildContainer } from '#src/app/container.ts';
import type { TextLengthLimit } from '#src/modules/comments/domain/limits.ts';
import { comments } from '#src/modules/comments/infrastructure/schema.ts';
import { apiKeys, posts, socialAccounts, workspaces } from '#src/modules/platform-core/schema.ts';
import { hashSecret } from '#src/shared/crypto.ts';
import type { Database } from '#src/shared/db.ts';
import { asWorkspaceId, generateId, type WorkspaceId } from '#src/shared/ids.ts';
import { startTestContainers, type TestContainers } from '#src/shared/testing/containers.ts';
import { TEST_ENV } from '#src/shared/testing/test-env.ts';

/** contracts/rest-api.md "`PlatformCapabilities`" — the wire shape, not registry.ts's field names. */
interface PlatformCapabilitiesResponseItem {
  readonly platform: string;
  readonly supportsComments: boolean;
  readonly canCreateTopLevel?: boolean;
  readonly canReply?: boolean;
  readonly maxReplyDepth?: number | null;
  readonly textLimit?: number;
  readonly textUnit?: 'characters' | 'graphemes';
  readonly ingestion?: string;
  readonly unsupportedReason?: string;
}

interface Harness {
  containers: TestContainers;
  database: Database;
  publishQueue: Queue;
  app: Api;
  workspaceId: WorkspaceId;
  apiKey: string;
}

/** Same minting pattern as post-comments.integration.test.ts's `mintApiKey`. */
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
  const { database, publishQueue } = container;
  const app = buildApi(container);
  await app.ready();

  // GET /v1/platforms is not workspace-scoped data, but auth.ts's PUBLIC_ROUTES is a fail-closed
  // allowlist that does not name it, so it still needs a valid key to pass the gate.
  const workspaceId = asWorkspaceId(generateId());
  await database.drizzle.insert(workspaces).values({
    id: workspaceId,
    name: 'Test workspace',
    contactLimitMonthly: 1000,
    createdAt: new Date(),
  });
  const apiKey = await mintApiKey(database, workspaceId);

  return { containers, database, publishQueue, app, workspaceId, apiKey };
}

async function stopHarness(harness: Harness): Promise<void> {
  await harness.app.close();
  await harness.publishQueue.close();
  await harness.database.close();
  await harness.containers.stop();
}

async function fetchPlatforms(harness: Harness): Promise<{
  statusCode: number;
  items: readonly PlatformCapabilitiesResponseItem[];
}> {
  const response = await harness.app.inject({
    method: 'GET',
    url: '/v1/platforms',
    headers: { 'blotato-api-key': harness.apiKey },
  });
  const body = response.json() as { items?: readonly PlatformCapabilitiesResponseItem[] };
  return { statusCode: response.statusCode, items: body.items ?? [] };
}

/** A fresh, independent-of-the-other-cases write-rate-limit bucket per boundary case (see module docstring). */
async function postReplyWithFreshKey(
  harness: Harness,
  parentCommentId: string,
  text: string,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const apiKey = await mintApiKey(harness.database, harness.workspaceId);
  const response = await harness.app.inject({
    method: 'POST',
    url: `/v1/comments/${parentCommentId}/replies`,
    headers: { 'blotato-api-key': apiKey },
    payload: { text },
  });
  return { statusCode: response.statusCode, body: response.json() as Record<string, unknown> };
}

/** Every rejection this boundary drives is `application/problem+json` carrying its `code`. */
function assertProblem(
  response: { statusCode: number; body: Record<string, unknown> },
  status: number,
  code: string,
): void {
  expect(response.statusCode).toBe(status);
  expect(response.body['code']).toBe(code);
}

async function seedSocialAccount(harness: Harness, platform: string): Promise<string> {
  const socialAccountId = generateId();
  await harness.database.drizzle.insert(socialAccounts).values({
    id: socialAccountId,
    workspaceId: harness.workspaceId,
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

interface SeedCommentInput {
  readonly socialAccountId: string;
  readonly platform: string;
  readonly postId: string;
  readonly platformPostId: string;
  readonly parentCommentId?: string | null;
  readonly depth?: number;
}

/**
 * Inserts one `posted` comment row directly — depth is taken as given rather than derived by
 * walking a real reply chain, the same shortcut `create-reply.integration.test.ts`'s
 * `registerDepthTests` takes: `checkReplyDepth` only ever reads `parent.depth`, so a row seeded at
 * an arbitrary depth is behaviourally identical to one reached by nesting that deep for real.
 */
async function seedComment(harness: Harness, input: SeedCommentInput): Promise<string> {
  const id = generateId();
  const now = new Date();
  await harness.database.drizzle.insert(comments).values({
    id,
    workspaceId: harness.workspaceId,
    socialAccountId: input.socialAccountId,
    platform: input.platform,
    postId: input.postId,
    platformPostId: input.platformPostId,
    parentCommentId: input.parentCommentId ?? null,
    rootCommentId: null,
    depth: input.depth ?? 0,
    platformCommentId: `${input.platform}-comment-${id}`,
    isOwn: false,
    source: 'sync',
    authorPlatformId: `author-${id}`,
    authorUsername: 'someone',
    authorDisplayName: null,
    text: 'seeded comment',
    status: 'posted',
    idempotencyKey: null,
    replyCount: 0,
    lastActivityAt: now,
    occurredAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

/** A fresh account + post + posted top-level comment on `platform`, ready to be replied to. */
interface SeededThread {
  readonly socialAccountId: string;
  readonly platform: string;
  readonly postId: string;
  readonly platformPostId: string;
  readonly topLevelId: string;
}

async function seedThread(harness: Harness, platform: string): Promise<SeededThread> {
  const socialAccountId = await seedSocialAccount(harness, platform);
  const postId = generateId();
  const platformPostId = `${platform}-post-${postId}`;
  await harness.database.drizzle.insert(posts).values({
    id: postId,
    workspaceId: harness.workspaceId,
    socialAccountId,
    platform,
    platformPostId,
    publishedAt: new Date(),
    createdAt: new Date(),
  });
  const topLevelId = await seedComment(harness, {
    socialAccountId,
    platform,
    postId,
    platformPostId,
  });
  return { socialAccountId, platform, postId, platformPostId, topLevelId };
}

/** Seeds a comment at exactly `depth` under `thread`'s top-level comment, to reply to next. */
function seedParentAtDepth(harness: Harness, thread: SeededThread, depth: number): Promise<string> {
  if (depth === 0) {
    return Promise.resolve(thread.topLevelId);
  }
  return seedComment(harness, {
    socialAccountId: thread.socialAccountId,
    platform: thread.platform,
    postId: thread.postId,
    platformPostId: thread.platformPostId,
    parentCommentId: thread.topLevelId,
    depth,
  });
}

// One grapheme, several UTF-16 code units (a ZWJ sequence) — see limits.test.ts.
const MULTI_UNIT_GRAPHEME = '👨‍👩‍👧‍👦';

function buildTextAtLimit(limit: TextLengthLimit): string {
  return limit.textUnit === 'graphemes'
    ? MULTI_UNIT_GRAPHEME.repeat(limit.textLimit)
    : 'a'.repeat(limit.textLimit);
}

function buildTextOneOverLimit(limit: TextLengthLimit): string {
  return limit.textUnit === 'graphemes'
    ? MULTI_UNIT_GRAPHEME.repeat(limit.textLimit) + MULTI_UNIT_GRAPHEME
    : 'a'.repeat(limit.textLimit + 1);
}

async function assertListsAllNinePlatforms(harness: Harness): Promise<void> {
  const { statusCode, items } = await fetchPlatforms(harness);

  expect(statusCode).toBe(200);
  expect(items).toHaveLength(9);

  const supported = items.filter((item) => item.supportsComments);
  expect(supported.map((item) => item.platform).toSorted()).toEqual([
    'bluesky',
    'facebook',
    'instagram',
  ]);

  const unsupported = items.filter((item) => !item.supportsComments);
  expect(unsupported).toHaveLength(6);
  for (const item of unsupported) {
    expect(item.unsupportedReason?.trim().length).toBeGreaterThan(0);
  }
}

function registerListingTests(getHarness: () => Harness): void {
  describe('listing', () => {
    it('lists all nine platforms, three supporting comments and six carrying unsupportedReason', async () => {
      await assertListsAllNinePlatforms(getHarness());
    });
  });
}

async function findAdvertisedPlatform(
  harness: Harness,
  platform: string,
): Promise<PlatformCapabilitiesResponseItem> {
  const { items } = await fetchPlatforms(harness);
  const item = items.find((entry) => entry.platform === platform);
  if (item === undefined) {
    throw new Error(`GET /v1/platforms did not list ${platform}`);
  }
  return item;
}

/**
 * Drives a real `POST /v1/comments/:commentId/replies` at the depth `GET /v1/platforms`
 * advertised for `platform`, and one past it — see the module docstring for why this must go
 * through the write path rather than calling `checkReplyDepth` directly.
 */
function registerDepthBoundaryTests(getHarness: () => Harness): void {
  it.each(['bluesky', 'facebook', 'instagram'] as const)(
    '%s: the reported maxReplyDepth is the depth the write path actually enforces',
    async (platform) => {
      const harness = getHarness();
      const item = await findAdvertisedPlatform(harness, platform);
      if (item.maxReplyDepth === undefined) {
        throw new Error(`GET /v1/platforms did not report maxReplyDepth for ${platform}`);
      }

      if (item.maxReplyDepth === null) {
        // Unbounded: there is no "one past it" to reject, so the only claim to check is that a
        // very deep reply is still accepted.
        const thread = await seedThread(harness, platform);
        const deepParent = await seedParentAtDepth(harness, thread, 1_000);
        const response = await postReplyWithFreshKey(harness, deepParent, 'a reply');
        expect(response.statusCode).toBe(202);
        return;
      }

      const atLimitThread = await seedThread(harness, platform);
      const atLimitParent = await seedParentAtDepth(harness, atLimitThread, item.maxReplyDepth - 1);
      const atLimitResponse = await postReplyWithFreshKey(harness, atLimitParent, 'a reply');
      expect(atLimitResponse.statusCode).toBe(202);

      const overLimitThread = await seedThread(harness, platform);
      const overLimitParent = await seedParentAtDepth(harness, overLimitThread, item.maxReplyDepth);
      const overLimitResponse = await postReplyWithFreshKey(harness, overLimitParent, 'a reply');
      assertProblem(overLimitResponse, 422, 'REPLY_DEPTH_EXCEEDED');
    },
  );
}

/**
 * Drives a real `POST /v1/comments/:commentId/replies` at the text length `GET /v1/platforms`
 * advertised for `platform`, in its advertised unit, and one grapheme/character past it.
 */
function registerTextLimitBoundaryTests(getHarness: () => Harness): void {
  it.each(['bluesky', 'facebook', 'instagram'] as const)(
    '%s: the reported textLimit and textUnit are what the write path actually enforces',
    async (platform) => {
      const harness = getHarness();
      const item = await findAdvertisedPlatform(harness, platform);
      if (item.textLimit === undefined || item.textUnit === undefined) {
        throw new Error(`GET /v1/platforms did not report a text limit for ${platform}`);
      }
      const limit: TextLengthLimit = { textLimit: item.textLimit, textUnit: item.textUnit };

      const atLimitThread = await seedThread(harness, platform);
      const atLimitResponse = await postReplyWithFreshKey(
        harness,
        atLimitThread.topLevelId,
        buildTextAtLimit(limit),
      );
      expect(atLimitResponse.statusCode).toBe(202);

      const overLimitThread = await seedThread(harness, platform);
      const overLimitResponse = await postReplyWithFreshKey(
        harness,
        overLimitThread.topLevelId,
        buildTextOneOverLimit(limit),
      );
      assertProblem(overLimitResponse, 422, 'TEXT_TOO_LONG');
    },
  );
}

function registerEnforcementTests(getHarness: () => Harness): void {
  describe('advertised limits match enforcement', () => {
    registerDepthBoundaryTests(getHarness);
    registerTextLimitBoundaryTests(getHarness);
  });
}

describe('GET /v1/platforms', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness();
  });

  afterAll(async () => {
    await stopHarness(harness);
  });

  registerListingTests(() => harness);
  registerEnforcementTests(() => harness);
});
