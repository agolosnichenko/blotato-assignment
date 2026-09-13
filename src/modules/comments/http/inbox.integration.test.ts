// oxlint-disable max-dependencies -- an integration test harness wires together the same set of
// modules the composition root does (config, db, redis, api, schema, crypto, ids, containers) —
// see the same justification on src/app/container.ts and src/app/api.ts.
// oxlint-disable max-lines -- six independent scenarios (ordering across internal/external posts,
// the since/until window, isOwn including an ingested own comment, a reply to an external post's
// comment, the 404 for a postId with no internal row, and the stale-projection split) each seed
// their own account/post/comments against a real Postgres — the same shape that earns the same
// disable on post-comments.integration.test.ts and create-reply.integration.test.ts.

/**
 * Contract tests for the account-inbox read, driven through the flat collection (T019/T091, US2,
 * quickstart.md V3, per D31): `GET /v1/comments?accountId=:id` replaces
 * `GET /v1/accounts/:accountId/comments`.
 *
 * `GET /v1/comments` is registered and answers `200` unfiltered today, but `accountId` is not
 * accepted by `listCommentsQuerySchema` yet and `selectionPredicate` ignores every key of
 * `CommentSelection` it is given (comment-repository.ts) — every scenario below that relies on the
 * filter actually narrowing the result set fails today, seeing the *unfiltered* workspace listing
 * instead of just this account's comments; `since`/`until`/`isOwn` are likewise not yet accepted by
 * this schema. The old address's `404` assertion also fails today: the nested route is still
 * registered and still answers `200` — the same relationship `post-comments.integration.test.ts`
 * and `replies.integration.test.ts` have to their own removed routes.
 *
 * D13 is why this endpoint exists at all: a comment on a post never published through this
 * platform has `post_id: null` (data-model.md §2) because there is no `posts` row to reference,
 * not because of a special case — and it still belongs in the account's inbox, still emits events,
 * and can still be replied to (A7, FR-015). This file's job is to pin that the inbox is where
 * internal and external posts genuinely stop being different kinds of thing.
 *
 * Two contract decisions this file makes, because rest-api.md documents `since`/`until` by name
 * but not their boundary semantics:
 *   - `since` and `until` are both inclusive — a comment whose `occurredAt` equals either bound is
 *     "inside the window". This is the ordinary reading of "since X until Y" and the one every case
 *     here is built to distinguish from "outside" by a wide enough margin that an exclusive
 *     boundary would fail visibly rather than coincidentally pass.
 *   - Both parameters are ISO 8601 timestamps, the same wire format every other timestamp in this
 *     API already uses (`commentSchema`'s `occurredAt`/`createdAt`/`updatedAt`).
 * If the eventual implementation disagrees with either reading, that is a real divergence from
 * this test, not a bug in it — flag it rather than quietly loosening the assertions to match.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApi, type Api } from '#src/app/api.ts';
import { loadConfig } from '#src/app/config.ts';
import { buildContainer } from '#src/app/container.ts';
import { comments } from '#src/modules/comments/infrastructure/schema.ts';
import { apiKeys, posts, socialAccounts, workspaces } from '#src/modules/platform-core/schema.ts';
import { hashSecret } from '#src/shared/crypto.ts';
import type { Database } from '#src/shared/db.ts';
import type { CommentStatus } from '#src/modules/comments/domain/status.ts';
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
}

/**
 * Mints a fresh API key per call, same as `create-reply.integration.test.ts` — this file makes
 * more than five write and more-than-thirty read requests across all its cases combined, and a
 * shared key would run into `RATE_LIMIT_WRITES_PER_MIN`'s default of 5 well before the file ends.
 */
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

  const workspaceId = asWorkspaceId(generateId());
  await database.drizzle.insert(workspaces).values({
    id: workspaceId,
    name: 'Test workspace',
    contactLimitMonthly: 1000,
    createdAt: new Date(),
  });

  return { containers, database, redis, publishQueue, app, workspaceId };
}

async function stopHarness(harness: Harness): Promise<void> {
  await harness.app.close();
  await harness.publishQueue.close();
  await harness.database.close();
  harness.redis.disconnect();
  await harness.containers.stop();
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

async function seedInternalPost(
  harness: Harness,
  socialAccountId: string,
  platform: string,
): Promise<string> {
  const postId = generateId();
  await harness.database.drizzle.insert(posts).values({
    id: postId,
    workspaceId: harness.workspaceId,
    socialAccountId,
    platform,
    platformPostId: `${platform}-post-${postId}`,
    publishedAt: new Date(),
    createdAt: new Date(),
  });
  return postId;
}

interface SeedCommentInput {
  readonly socialAccountId: string;
  readonly platform: string;
  /** `null` for a comment on a post never published through this platform (D13). */
  readonly postId: string | null;
  readonly platformPostId: string;
  readonly occurredAt: Date;
  readonly isOwn?: boolean;
  readonly source?: 'api' | 'webhook' | 'sync';
  readonly status?: CommentStatus;
  readonly authorPlatformId?: string;
}

/** Inserts one top-level, posted comment row directly — the read side under test, not a write path. */
async function seedComment(harness: Harness, input: SeedCommentInput): Promise<string> {
  const id = generateId();
  await harness.database.drizzle.insert(comments).values({
    id,
    workspaceId: harness.workspaceId,
    socialAccountId: input.socialAccountId,
    platform: input.platform,
    postId: input.postId,
    platformPostId: input.platformPostId,
    parentCommentId: null,
    rootCommentId: null,
    depth: 0,
    platformCommentId: `${input.platform}-comment-${id}`,
    isOwn: input.isOwn ?? false,
    source: input.source ?? 'sync',
    authorPlatformId: input.authorPlatformId ?? `author-${id}`,
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

interface InboxItem {
  id: string;
  postId: string | null;
  isOwn: boolean;
  occurredAt: string;
}

interface InboxPage {
  items: InboxItem[];
  nextCursor: string | null;
}

interface JsonResponse<TBody> {
  statusCode: number;
  headers: Record<string, string>;
  body: TBody;
}

/**
 * Drives `GET /v1/comments?accountId=:id` (V3) — the collection selection that replaces
 * `GET /v1/accounts/:accountId/comments`. `accountId` merges with whatever `query` the caller
 * supplies (`since`/`until`/`isOwn`/pagination), so every existing case keeps driving those params
 * exactly as before.
 */
async function fetchInbox(
  harness: Harness,
  accountId: string,
  apiKey: string,
  query: Record<string, string>,
): Promise<JsonResponse<InboxPage>> {
  const search = new URLSearchParams({ accountId, ...query }).toString();
  const response = await harness.app.inject({
    method: 'GET',
    url: `/v1/comments?${search}`,
    headers: { 'blotato-api-key': apiKey },
  });
  return {
    statusCode: response.statusCode,
    headers: response.headers as never,
    body: response.json() as InboxPage,
  };
}

async function postJson(
  harness: Harness,
  url: string,
  apiKey: string,
  payload: Record<string, unknown>,
): Promise<JsonResponse<Record<string, unknown>>> {
  const response = await harness.app.inject({
    method: 'POST',
    url,
    headers: { 'blotato-api-key': apiKey },
    payload,
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

/**
 * Ordering (FR-008) plus the `postId` split (D13): an internal and an external post's comments
 * appear together, newest first by default, and only the external one carries `postId: null` — an
 * internal comment's `postId` is never null just because it sits on the same account.
 */
function registerOrderingAndExternalPostTest(getHarness: () => Harness): void {
  it('lists internal and external comments together, newest first, only the external one with postId null', async () => {
    const harness = getHarness();
    const socialAccountId = await seedSocialAccount(harness, 'instagram');
    const internalPostId = await seedInternalPost(harness, socialAccountId, 'instagram');
    const base = Date.parse('2026-03-01T00:00:00.000Z');

    const oldestInternalId = await seedComment(harness, {
      socialAccountId,
      platform: 'instagram',
      postId: internalPostId,
      platformPostId: `instagram-post-${internalPostId}`,
      occurredAt: new Date(base),
    });
    const externalPlatformPostId = `instagram-external-post-${generateId()}`;
    const middleExternalId = await seedComment(harness, {
      socialAccountId,
      platform: 'instagram',
      postId: null,
      platformPostId: externalPlatformPostId,
      occurredAt: new Date(base + 2000),
    });
    const newestInternalId = await seedComment(harness, {
      socialAccountId,
      platform: 'instagram',
      postId: internalPostId,
      platformPostId: `instagram-post-${internalPostId}`,
      occurredAt: new Date(base + 4000),
    });

    const apiKey = await mintApiKey(harness.database, harness.workspaceId);
    const { statusCode, body } = await fetchInbox(harness, socialAccountId, apiKey, {});

    expect(statusCode).toBe(200);
    expect(body.items.map((item) => item.id)).toEqual([
      newestInternalId,
      middleExternalId,
      oldestInternalId,
    ]);

    const externalItem = body.items.find((item) => item.id === middleExternalId);
    expect(externalItem?.postId).toBeNull();
    const newestInternalItem = body.items.find((item) => item.id === newestInternalId);
    expect(newestInternalItem?.postId).toBe(internalPostId);
    const oldestInternalItem = body.items.find((item) => item.id === oldestInternalId);
    expect(oldestInternalItem?.postId).toBe(internalPostId);
  });
}

/** `since`/`until` (FR-008): only comments whose occurredAt falls inside the closed window. */
function registerSinceUntilWindowTest(getHarness: () => Harness): void {
  it('returns only comments that occurred inside the since/until window', async () => {
    const harness = getHarness();
    const socialAccountId = await seedSocialAccount(harness, 'bluesky');
    const platformPostId = `bluesky-external-post-${generateId()}`;
    const base = Date.parse('2026-03-02T00:00:00.000Z');
    const offsetsMs = [0, 1000, 2000, 3000, 4000];
    const ids = await Promise.all(
      offsetsMs.map((offsetMs) =>
        seedComment(harness, {
          socialAccountId,
          platform: 'bluesky',
          postId: null,
          platformPostId,
          occurredAt: new Date(base + offsetMs),
        }),
      ),
    );
    const [, idAt1000, idAt2000, idAt3000] = ids;

    const apiKey = await mintApiKey(harness.database, harness.workspaceId);
    const { statusCode, body } = await fetchInbox(harness, socialAccountId, apiKey, {
      since: new Date(base + 1000).toISOString(),
      until: new Date(base + 3000).toISOString(),
      limit: '20',
    });

    expect(statusCode).toBe(200);
    expect(new Set(body.items.map((item) => item.id))).toEqual(
      new Set([idAt1000, idAt2000, idAt3000]),
    );
  });
}

interface IsOwnFixture {
  readonly socialAccountId: string;
  readonly audienceId: string;
  readonly ownViaApiId: string;
  readonly ownViaIngestionId: string;
}

/**
 * Seeds one audience comment and two own comments — one `source: 'api'`, one `source: 'webhook'`
 * (arrived by ingestion, not through the accept path) — so the read-side assertions below prove
 * `isOwn` is read from the stored `is_own` column, not inferred from `source`.
 */
async function seedIsOwnFixture(harness: Harness): Promise<IsOwnFixture> {
  const socialAccountId = await seedSocialAccount(harness, 'instagram');
  const platformPostId = `instagram-external-post-${generateId()}`;
  const base = Date.parse('2026-03-03T00:00:00.000Z');

  const audienceId = await seedComment(harness, {
    socialAccountId,
    platform: 'instagram',
    postId: null,
    platformPostId,
    occurredAt: new Date(base),
    isOwn: false,
    source: 'sync',
  });
  const ownViaApiId = await seedComment(harness, {
    socialAccountId,
    platform: 'instagram',
    postId: null,
    platformPostId,
    occurredAt: new Date(base + 1000),
    isOwn: true,
    source: 'api',
  });
  const ownViaIngestionId = await seedComment(harness, {
    socialAccountId,
    platform: 'instagram',
    postId: null,
    platformPostId,
    occurredAt: new Date(base + 2000),
    isOwn: true,
    source: 'webhook',
  });

  return { socialAccountId, audienceId, ownViaApiId, ownViaIngestionId };
}

/**
 * `isOwn` (FR-023, A2) is decided by author identity, not by how the row entered the system — an
 * implementation that only sets `isOwn` correctly for API-created rows passes every case above and
 * fails this one, since `ownViaIngestionId` never went through the accept path.
 */
function registerIsOwnSeparationTest(getHarness: () => Harness): void {
  it('separates own comments — including one that arrived by ingestion — from the audience', async () => {
    const harness = getHarness();
    const fixture = await seedIsOwnFixture(harness);

    const ownKey = await mintApiKey(harness.database, harness.workspaceId);
    const ownResponse = await fetchInbox(harness, fixture.socialAccountId, ownKey, {
      isOwn: 'true',
    });
    expect(ownResponse.statusCode).toBe(200);
    expect(new Set(ownResponse.body.items.map((item) => item.id))).toEqual(
      new Set([fixture.ownViaApiId, fixture.ownViaIngestionId]),
    );
    expect(ownResponse.body.items.every((item) => item.isOwn)).toBe(true);

    const audienceKey = await mintApiKey(harness.database, harness.workspaceId);
    const audienceResponse = await fetchInbox(harness, fixture.socialAccountId, audienceKey, {
      isOwn: 'false',
    });
    expect(audienceResponse.statusCode).toBe(200);
    expect(audienceResponse.body.items.map((item) => item.id)).toEqual([fixture.audienceId]);
  });
}

/** A reply to a comment on an external post is accepted the same as any other (A7, D13, FR-015). */
function registerReplyToExternalPostCommentTest(getHarness: () => Harness): void {
  it('accepts a reply to the external post comment with 202', async () => {
    const harness = getHarness();
    const socialAccountId = await seedSocialAccount(harness, 'instagram');
    const platformPostId = `instagram-external-post-${generateId()}`;
    const parentId = await seedComment(harness, {
      socialAccountId,
      platform: 'instagram',
      postId: null,
      platformPostId,
      occurredAt: new Date(),
      status: 'posted',
    });

    const apiKey = await mintApiKey(harness.database, harness.workspaceId);
    const response = await postJson(harness, `/v1/comments/${parentId}/replies`, apiKey, {
      text: 'a reply to a comment on a post this service never published',
    });

    expect(response.statusCode).toBe(202);
    expect(response.body['status']).toBe('queued');
    expect(response.headers['location']).toBeDefined();
  });
}

/** A `postId` with no internal row is unreachable by construction (A7, D13) — `404`, not `422`. */
function registerCreateTopLevelUnknownPostTest(getHarness: () => Harness): void {
  it('rejects POST /v1/posts/:postId/comments for a post with no internal id with 404', async () => {
    const harness = getHarness();
    const apiKey = await mintApiKey(harness.database, harness.workspaceId);
    const unknownPostId = randomUUID();

    const response = await postJson(harness, `/v1/posts/${unknownPostId}/comments`, apiKey, {
      text: 'this post was never published through the platform',
    });

    assertProblem(response, 404, 'NOT_FOUND');
  });
}

/**
 * A10a: the `posts` projection can go stale. When the row a comment's `postId` used to resolve to
 * stops resolving, the post-scoped list becomes 404 — but the same rows are this service's own,
 * never depended on the projection to exist, and stay reachable through the account inbox. Both
 * halves are asserted from the same seeded data, since the claim is about the pair, not either
 * response alone.
 */
function registerStaleProjectionSplitTest(getHarness: () => Harness): void {
  it('404s the post-scoped list while the same comments stay in the account inbox', async () => {
    const harness = getHarness();
    const socialAccountId = await seedSocialAccount(harness, 'instagram');
    // A postId the comment was stored with, but for which no `posts` row exists — data-model.md
    // §2's "the durable anchor survives the `posts` row disappearing" (A10a), reached here by never
    // inserting the row in the first place rather than by deleting one, since the effect on a read
    // is identical either way.
    const staleProjectionPostId = generateId();
    const commentId = await seedComment(harness, {
      socialAccountId,
      platform: 'instagram',
      postId: staleProjectionPostId,
      platformPostId: `instagram-post-${staleProjectionPostId}`,
      occurredAt: new Date(),
    });

    const postScopedKey = await mintApiKey(harness.database, harness.workspaceId);
    const postScopedResponse = await harness.app.inject({
      method: 'GET',
      url: `/v1/posts/${staleProjectionPostId}/comments`,
      headers: { 'blotato-api-key': postScopedKey },
    });
    expect(postScopedResponse.statusCode).toBe(404);
    expect(postScopedResponse.headers['content-type']).toContain('application/problem+json');
    expect((postScopedResponse.json() as { code: string }).code).toBe('NOT_FOUND');

    const inboxKey = await mintApiKey(harness.database, harness.workspaceId);
    const inboxResponse = await fetchInbox(harness, socialAccountId, inboxKey, {});
    expect(inboxResponse.statusCode).toBe(200);
    expect(inboxResponse.body.items.map((item) => item.id)).toContain(commentId);
  });
}

/**
 * T019/V3's negative-data half: `accountId` must exclude a comment belonging to a *different*
 * social account in the same workspace — a selection that silently ignores the filter would return
 * both accounts' comments and pass a positive-only fixture.
 */
function registerFilterExclusionTest(getHarness: () => Harness): void {
  it('excludes a comment belonging to a different social account', async () => {
    const harness = getHarness();
    const socialAccountId = await seedSocialAccount(harness, 'instagram');
    const otherAccountId = await seedSocialAccount(harness, 'bluesky');
    const base = Date.parse('2026-03-04T00:00:00.000Z');
    const ownId = await seedComment(harness, {
      socialAccountId,
      platform: 'instagram',
      postId: null,
      platformPostId: `instagram-external-post-${generateId()}`,
      occurredAt: new Date(base),
    });
    const otherId = await seedComment(harness, {
      socialAccountId: otherAccountId,
      platform: 'bluesky',
      postId: null,
      platformPostId: `bluesky-external-post-${generateId()}`,
      occurredAt: new Date(base + 1000),
    });

    const apiKey = await mintApiKey(harness.database, harness.workspaceId);
    const { statusCode, body } = await fetchInbox(harness, socialAccountId, apiKey, {});

    expect(statusCode).toBe(200);
    const ids = body.items.map((item) => item.id);
    expect(ids).toContain(ownId);
    expect(ids).not.toContain(otherId);
  });
}

/** T019/V3: the nested route this selection replaces no longer answers — `404 NOT_FOUND` (FR-009). */
function registerOldAddressGoneTest(getHarness: () => Harness): void {
  it('answers 404 NOT_FOUND at the old GET /v1/accounts/:accountId/comments address', async () => {
    const harness = getHarness();
    const socialAccountId = await seedSocialAccount(harness, 'instagram');
    const apiKey = await mintApiKey(harness.database, harness.workspaceId);

    const response = await harness.app.inject({
      method: 'GET',
      url: `/v1/accounts/${socialAccountId}/comments`,
      headers: { 'blotato-api-key': apiKey },
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect((response.json() as { code: string }).code).toBe('NOT_FOUND');
  });
}

describe('GET /v1/comments?accountId (was GET /v1/accounts/:accountId/comments)', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness();
  });

  afterAll(async () => {
    await stopHarness(harness);
  });

  registerOrderingAndExternalPostTest(() => harness);
  registerSinceUntilWindowTest(() => harness);
  registerIsOwnSeparationTest(() => harness);
  registerReplyToExternalPostCommentTest(() => harness);
  registerCreateTopLevelUnknownPostTest(() => harness);
  registerStaleProjectionSplitTest(() => harness);
  registerFilterExclusionTest(() => harness);
  registerOldAddressGoneTest(() => harness);
});
