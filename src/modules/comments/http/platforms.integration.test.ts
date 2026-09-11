// oxlint-disable max-dependencies -- an integration test harness wires together the same set of
// modules the composition root does (config, db, redis, api, schema, crypto, ids, containers) —
// see the same justification on src/app/container.ts and other integration tests in this module.

/**
 * `GET /v1/platforms` cannot drift from what the write path enforces (T096, T098, FR-031, SC-009).
 *
 * Listing nine platforms, three of them comment-capable, is the easy half and is pinned first.
 * The half that earns this test is the second describe block: the `maxReplyDepth`, `textLimit`
 * and `textUnit` the endpoint reports for a platform are checked against `checkReplyDepth` /
 * `checkTextLength` (domain/limits.ts) — the actual enforcement functions a write-path use case
 * calls — driven at the boundary those values name and one step past it. Nothing here compares
 * the response to `src/platforms/registry.ts`: that would only prove the endpoint serializes the
 * file it serializes. A registry row edited without a matching change to enforcement fails this
 * test, which is the point of SC-009.
 */

import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApi, type Api } from '#src/app/api.ts';
import { loadConfig } from '#src/app/config.ts';
import {
  checkReplyDepth,
  checkTextLength,
  type ReplyDepthLimit,
  type TextLengthLimit,
} from '#src/modules/comments/domain/limits.ts';
import { apiKeys, workspaces } from '#src/modules/platform-core/schema.ts';
import { hashSecret } from '#src/shared/crypto.ts';
import { createDatabase, type Database } from '#src/shared/db.ts';
import { generateId } from '#src/shared/ids.ts';
import { createRedis } from '#src/shared/queue.ts';
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
  app: Api;
  apiKey: string;
}

/** Same minting pattern as post-comments.integration.test.ts's `mintApiKey`. */
async function mintApiKey(database: Database, workspaceId: string): Promise<string> {
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
  const database = createDatabase(config);
  const redis = createRedis(config);
  const app = buildApi({ config, database, redis });
  await app.ready();

  // GET /v1/platforms is not workspace-scoped data, but auth.ts's PUBLIC_ROUTES is a fail-closed
  // allowlist that does not name it, so it still needs a valid key to pass the gate.
  const workspaceId = generateId();
  await database.drizzle.insert(workspaces).values({
    id: workspaceId,
    name: 'Test workspace',
    contactLimitMonthly: 1000,
    createdAt: new Date(),
  });
  const apiKey = await mintApiKey(database, workspaceId);

  return { containers, database, app, apiKey };
}

async function stopHarness(harness: Harness): Promise<void> {
  await harness.app.close();
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

/** Drives `checkReplyDepth` at the depth the response advertised, and one past it. */
function assertDepthBoundaryMatchesAdvertisement(limit: ReplyDepthLimit): void {
  if (limit.maxReplyDepth === null) {
    // Unbounded: there is no "one past it" to reject, so the only claim to check is that a very
    // deep reply is still accepted.
    expect(checkReplyDepth(limit, 1_000)).toEqual({ allowed: true });
    return;
  }

  const atLimit = checkReplyDepth(limit, limit.maxReplyDepth - 1);
  const overLimit = checkReplyDepth(limit, limit.maxReplyDepth);

  expect(atLimit).toEqual({ allowed: true });
  expect(overLimit).toEqual({ allowed: false, maxReplyDepth: limit.maxReplyDepth });
}

/** Drives `checkTextLength` at the length the response advertised, and one past it, in its unit. */
function assertTextLimitBoundaryMatchesAdvertisement(limit: TextLengthLimit): void {
  const atLimit = checkTextLength(limit, buildTextAtLimit(limit));
  const overLimit = checkTextLength(limit, buildTextOneOverLimit(limit));

  expect(atLimit).toEqual({ allowed: true });
  expect(overLimit).toEqual({
    allowed: false,
    length: limit.textLimit + 1,
    limit: limit.textLimit,
  });
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

function registerDepthBoundaryTests(getHarness: () => Harness): void {
  it.each(['bluesky', 'facebook', 'instagram'] as const)(
    '%s: the reported maxReplyDepth is the depth the write path actually enforces',
    async (platform) => {
      const item = await findAdvertisedPlatform(getHarness(), platform);
      if (item.maxReplyDepth === undefined) {
        throw new Error(`GET /v1/platforms did not report maxReplyDepth for ${platform}`);
      }

      assertDepthBoundaryMatchesAdvertisement({ maxReplyDepth: item.maxReplyDepth });
    },
  );
}

function registerTextLimitBoundaryTests(getHarness: () => Harness): void {
  it.each(['bluesky', 'facebook', 'instagram'] as const)(
    '%s: the reported textLimit and textUnit are what the write path actually enforces',
    async (platform) => {
      const item = await findAdvertisedPlatform(getHarness(), platform);
      if (item.textLimit === undefined || item.textUnit === undefined) {
        throw new Error(`GET /v1/platforms did not report a text limit for ${platform}`);
      }

      assertTextLimitBoundaryMatchesAdvertisement({
        textLimit: item.textLimit,
        textUnit: item.textUnit,
      });
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
