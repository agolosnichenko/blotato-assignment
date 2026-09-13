/**
 * Contract tests for `POST /v1/comments/:commentId/replies` (T052, V3).
 *
 * `src/modules/comments/http/routes.ts` does not register this route yet (it is added by T069,
 * against the `CreateReply` use case T058 has not been written yet either) — this file is the
 * first statement of the route's write-validation contract (rest-api.md §Error codes, spec.md
 * §7.1 step 1). Every request here 404s through Fastify's own not-found handler today; once
 * T058/T069 land, the assertions below are the target, the same relationship
 * `post-comments.integration.test.ts` already has to `GET /v1/posts/:postId/comments`.
 *
 * Two things every case is really pinning:
 *   - The pairing of the depth check across Instagram (`maxReplyDepth: 1`) and Bluesky
 *     (`maxReplyDepth: null`) proves the check is registry-driven (Principle IV), not a platform
 *     branch — the same request shape must be rejected on one and accepted on the other.
 *   - "With nothing sent" (over-length text, an unsupported platform) is checked by asserting no
 *     `comment-publish` job was enqueued (`QUEUE_NAMES.commentPublish`, `src/shared/queues.ts`),
 *     not merely that the response was 422. This proves the narrower, earlier claim "no job was
 *     enqueued" rather than "no adapter call was made" — no adapter-injection path exists in the
 *     DI graph yet (that is T063), and for a pre-flight rejection the queue is the right place to
 *     look anyway: the HTTP layer never calls an adapter directly, only the worker consuming this
 *     queue does, so a rejection that left the queue empty could not have reached one. Do not
 *     "upgrade" this to an adapter mock without keeping this assertion — replacing it would weaken
 *     the claim to "the adapter wasn't called, though a job may be sitting in the queue".
 */

// oxlint-disable max-dependencies -- an integration test's import count reflects the surface it
// exercises (the HTTP app, the harness, the schema tables it seeds, the ports, the publish queue),
// not tangled design; see the same reasoning in container.ts and api.ts.
// oxlint-disable max-lines -- twelve write-validation cases, each seeding real rows against a
// real Postgres rather than a shared fixture, is the file's actual scope, not padding; splitting
// case groups into `registerXTests` functions (below) already keeps each function's own span
// small — what remains is the sum of twelve genuinely independent scenarios.

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApi, type Api } from '#src/app/api.ts';
import { loadConfig } from '#src/app/config.ts';
import { buildContainer } from '#src/app/container.ts';
import { accountHealth, comments } from '#src/modules/comments/infrastructure/schema.ts';
import { apiKeys, posts, socialAccounts, workspaces } from '#src/modules/platform-core/schema.ts';
import { hashSecret } from '#src/shared/crypto.ts';
import type { Database } from '#src/shared/db.ts';
import { generateId } from '#src/shared/ids.ts';
import { startTestContainers, type TestContainers } from '#src/shared/testing/containers.ts';
import { TEST_ENV } from '#src/shared/testing/test-env.ts';

interface Harness {
  containers: TestContainers;
  database: Database;
  redis: Redis;
  app: Api;
  publishQueue: Queue;
  workspaceId: string;
}

async function mintApiKey(database: Database, workspaceId: string): Promise<string> {
  const prefix = randomUUID().replaceAll('-', '');
  const secret = randomUUID();
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
  // `buildApi` now needs all of them, and this harness's own job-count queries reuse the same
  // `publishQueue` handle the write routes enqueue on, rather than a second instance of the same
  // named queue.
  const container = buildContainer({ config });
  const { database, redis, publishQueue } = container;
  const app = buildApi(container);
  await app.ready();

  const workspaceId = generateId();
  await database.drizzle.insert(workspaces).values({
    id: workspaceId,
    name: 'Test workspace',
    contactLimitMonthly: 1000,
    createdAt: new Date(),
  });

  return { containers, database, redis, app, publishQueue, workspaceId };
}

async function stopHarness(harness: Harness): Promise<void> {
  await harness.publishQueue.close();
  await harness.app.close();
  await harness.database.close();
  harness.redis.disconnect();
  await harness.containers.stop();
}

/** Total jobs in the `comment-publish` queue, across every state — used as a delta, not a total. */
async function publishJobCount(harness: Harness): Promise<number> {
  const counts = await harness.publishQueue.getJobCounts(
    'waiting',
    'active',
    'delayed',
    'completed',
    'failed',
  );
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

/**
 * Asserts that whatever ran between capturing `before` and calling this enqueued no
 * `comment-publish` job — the "nothing sent" half of a pre-flight rejection (T052).
 */
async function assertNothingSent(harness: Harness, before: number): Promise<void> {
  expect(await publishJobCount(harness)).toBe(before);
}

interface SeedAccountInput {
  readonly platform: string;
  readonly status?: 'active' | 'disconnected';
}

async function seedSocialAccount(harness: Harness, input: SeedAccountInput): Promise<string> {
  const socialAccountId = generateId();
  await harness.database.drizzle.insert(socialAccounts).values({
    id: socialAccountId,
    workspaceId: harness.workspaceId,
    platform: input.platform,
    platformAccountId: `${input.platform}-${generateId()}`,
    username: 'demo',
    credentialsCiphertext: Buffer.alloc(28),
    credentialsKeyVersion: 1,
    status: input.status ?? 'active',
    createdAt: new Date(),
  });
  return socialAccountId;
}

async function seedPost(
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
  readonly postId: string;
  readonly platformPostId: string;
  readonly parentCommentId?: string | null;
  readonly rootCommentId?: string | null;
  readonly depth?: number;
  readonly status?: string;
  readonly authorPlatformId?: string;
  readonly idempotencyKey?: string | null;
}

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
    rootCommentId: input.rootCommentId ?? null,
    depth: input.depth ?? 0,
    platformCommentId: `${input.platform}-comment-${id}`,
    isOwn: false,
    source: 'sync',
    authorPlatformId: input.authorPlatformId ?? `author-${id}`,
    authorUsername: 'someone',
    authorDisplayName: null,
    text: 'seeded comment',
    status: input.status ?? 'posted',
    idempotencyKey: input.idempotencyKey ?? null,
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
  readonly postId: string;
  readonly platformPostId: string;
  readonly topLevelId: string;
}

async function seedPostedTopLevel(
  harness: Harness,
  platform: string,
  accountOverrides: Omit<SeedAccountInput, 'platform'> = {},
): Promise<SeededThread> {
  const socialAccountId = await seedSocialAccount(harness, { platform, ...accountOverrides });
  const postId = await seedPost(harness, socialAccountId, platform);
  const platformPostId = `${platform}-post-${postId}`;
  const topLevelId = await seedComment(harness, {
    socialAccountId,
    platform,
    postId,
    platformPostId,
    status: 'posted',
  });
  return { socialAccountId, postId, platformPostId, topLevelId };
}

interface ReplyRequest {
  readonly parentCommentId: string;
  readonly text?: string;
  readonly idempotencyKey?: string;
}

interface ReplyResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

/**
 * Mints a fresh API key per call so each request lands in its own write rate-limit bucket
 * (`RATE_LIMIT_WRITES_PER_MIN` defaults to 5, and this file makes more than five write requests
 * total) rather than the single key `startHarness` used to mint once for the whole file. The
 * `Idempotency-Key` header is unrelated to which API key authenticates a request, and idempotency
 * resolution is scoped by workspace, not by key — so the two calls in an idempotency case landing
 * on different keys changes nothing about what either call resolves to.
 */
async function postReply(harness: Harness, request: ReplyRequest): Promise<ReplyResponse> {
  const apiKey = await mintApiKey(harness.database, harness.workspaceId);
  const headers: Record<string, string> = { 'blotato-api-key': apiKey };
  if (request.idempotencyKey !== undefined) {
    headers['idempotency-key'] = request.idempotencyKey;
  }
  const response = await harness.app.inject({
    method: 'POST',
    url: `/v1/comments/${request.parentCommentId}/replies`,
    headers,
    payload: { text: request.text ?? 'a reply' },
  });
  return {
    statusCode: response.statusCode,
    headers: response.headers as never,
    body: response.json(),
  };
}

/** Every rejection this contract defines is `application/problem+json` carrying its `code`. */
function assertProblem(response: ReplyResponse, status: number, code: string): void {
  expect(response.statusCode).toBe(status);
  expect(response.headers['content-type']).toContain('application/problem+json');
  expect(response.body['code']).toBe(code);
}

/**
 * Each group below is a standalone top-level function, called once from the outer `describe`
 * (same shape as `local-ports.integration.test.ts`'s `registerUnknownEntityTests` etc.) — not
 * nested inline — so the outer `describe` callback stays a short list of registrations instead of
 * one function whose line span covers every case in the file.
 */

function registerDepthTests(getHarness: () => Harness): void {
  describe('reply depth (D12, A20) — registry-driven, not a platform branch', () => {
    it('rejects a reply to a reply on Instagram (maxReplyDepth: 1) with 422 REPLY_DEPTH_EXCEEDED naming the top-level comment', async () => {
      const harness = getHarness();
      const thread = await seedPostedTopLevel(harness, 'instagram');
      const depthOneReply = await seedComment(harness, {
        socialAccountId: thread.socialAccountId,
        platform: 'instagram',
        postId: thread.postId,
        platformPostId: thread.platformPostId,
        parentCommentId: thread.topLevelId,
        rootCommentId: thread.topLevelId,
        depth: 1,
        status: 'posted',
      });

      const response = await postReply(harness, { parentCommentId: depthOneReply });

      assertProblem(response, 422, 'REPLY_DEPTH_EXCEEDED');
      expect(response.body['detail']).toContain(thread.topLevelId);
    });

    it('accepts the same nesting on Bluesky (maxReplyDepth: null) with 202', async () => {
      const harness = getHarness();
      const thread = await seedPostedTopLevel(harness, 'bluesky');
      const depthOneReply = await seedComment(harness, {
        socialAccountId: thread.socialAccountId,
        platform: 'bluesky',
        postId: thread.postId,
        platformPostId: thread.platformPostId,
        parentCommentId: thread.topLevelId,
        rootCommentId: thread.topLevelId,
        depth: 1,
        status: 'posted',
      });

      const response = await postReply(harness, { parentCommentId: depthOneReply });

      expect(response.statusCode).toBe(202);
      expect(response.body['status']).toBe('queued');
      expect(response.headers['location']).toBeDefined();
    });
  });
}

function registerTextLengthTests(getHarness: () => Harness): void {
  describe('text length (R-07) — nothing sent on rejection', () => {
    it('rejects text over the Instagram limit with 422 TEXT_TOO_LONG and enqueues no publish job', async () => {
      const harness = getHarness();
      const thread = await seedPostedTopLevel(harness, 'instagram');
      const before = await publishJobCount(harness);
      const overLong = 'a'.repeat(2201);

      const response = await postReply(harness, {
        parentCommentId: thread.topLevelId,
        text: overLong,
      });

      assertProblem(response, 422, 'TEXT_TOO_LONG');
      await assertNothingSent(harness, before);
    });
  });
}

function registerIdempotencySameBodyTest(getHarness: () => Harness): void {
  describe('idempotency (A12) — same key, same body', () => {
    it('returns the original comment, inserting no second row', async () => {
      const harness = getHarness();
      const thread = await seedPostedTopLevel(harness, 'instagram');
      const idempotencyKey = randomUUID();

      const first = await postReply(harness, {
        parentCommentId: thread.topLevelId,
        text: 'idempotent body',
        idempotencyKey,
      });
      expect(first.statusCode).toBe(202);

      const second = await postReply(harness, {
        parentCommentId: thread.topLevelId,
        text: 'idempotent body',
        idempotencyKey,
      });

      expect(second.statusCode).toBe(202);
      expect(second.body['id']).toBe(first.body['id']);

      const rows = await harness.database.drizzle
        .select({ id: comments.id })
        .from(comments)
        .where(eq(comments.idempotencyKey, idempotencyKey));
      expect(rows).toHaveLength(1);
    });
  });
}

function registerIdempotencyConflictTest(getHarness: () => Harness): void {
  describe('idempotency (A12) — same key, different body', () => {
    it('rejects with 409 IDEMPOTENCY_KEY_REUSED', async () => {
      const harness = getHarness();
      const thread = await seedPostedTopLevel(harness, 'instagram');
      const idempotencyKey = randomUUID();

      const first = await postReply(harness, {
        parentCommentId: thread.topLevelId,
        text: 'original body',
        idempotencyKey,
      });
      expect(first.statusCode).toBe(202);

      const second = await postReply(harness, {
        parentCommentId: thread.topLevelId,
        text: 'a different body',
        idempotencyKey,
      });

      assertProblem(second, 409, 'IDEMPOTENCY_KEY_REUSED');
    });
  });
}

function registerIdempotencyConcurrentTest(getHarness: () => Harness): void {
  describe('idempotency (A12) — concurrent requests, same key', () => {
    it('both return 202 naming the same comment, with exactly one row inserted', async () => {
      const harness = getHarness();
      const thread = await seedPostedTopLevel(harness, 'instagram');
      const idempotencyKey = randomUUID();

      // Genuinely concurrent — Promise.all, not two sequential awaits. A sequential version would
      // pass even against an implementation with no unique-violation handling at all: the second
      // call would simply find the first one's already-committed row through the normal
      // resolveIdempotency read path. Firing both at once forces them through insertQueued
      // together, so only the unique-violation catch in createReply can make both resolve to the
      // same comment.
      const [first, second] = await Promise.all([
        postReply(harness, {
          parentCommentId: thread.topLevelId,
          text: 'concurrent idempotent body',
          idempotencyKey,
        }),
        postReply(harness, {
          parentCommentId: thread.topLevelId,
          text: 'concurrent idempotent body',
          idempotencyKey,
        }),
      ]);

      expect(first.statusCode).toBe(202);
      expect(second.statusCode).toBe(202);
      expect(second.body['id']).toBe(first.body['id']);

      const rows = await harness.database.drizzle
        .select({ id: comments.id })
        .from(comments)
        .where(eq(comments.idempotencyKey, idempotencyKey));
      expect(rows).toHaveLength(1);
    });
  });
}

function registerPlatformCapabilityTests(getHarness: () => Harness): void {
  describe('platform capability (FR-031) — nothing sent on rejection', () => {
    it('rejects a write against a platform the registry marks unsupported with 422 PLATFORM_NOT_SUPPORTED', async () => {
      const harness = getHarness();
      const thread = await seedPostedTopLevel(harness, 'threads');
      const before = await publishJobCount(harness);

      const response = await postReply(harness, { parentCommentId: thread.topLevelId });

      assertProblem(response, 422, 'PLATFORM_NOT_SUPPORTED');
      await assertNothingSent(harness, before);
    });
  });
}

function registerParentStatusTests(getHarness: () => Harness): void {
  describe('parent status (§7.1 step 1) — all four non-posted states', () => {
    it.each(['queued', 'processing', 'failed', 'deleted'] as const)(
      'rejects a reply to a parent that is %s with 422 PARENT_NOT_POSTED',
      async (status) => {
        const harness = getHarness();
        const socialAccountId = await seedSocialAccount(harness, { platform: 'instagram' });
        const postId = await seedPost(harness, socialAccountId, 'instagram');
        const parentId = await seedComment(harness, {
          socialAccountId,
          platform: 'instagram',
          postId,
          platformPostId: `instagram-post-${postId}`,
          status,
        });

        const response = await postReply(harness, { parentCommentId: parentId });

        assertProblem(response, 422, 'PARENT_NOT_POSTED');
      },
    );
  });
}

function registerAccountDisconnectedTests(getHarness: () => Harness): void {
  describe('account disconnected (D30) — composed from two sources', () => {
    it('rejects when the projection row itself is disconnected', async () => {
      const harness = getHarness();
      const thread = await seedPostedTopLevel(harness, 'instagram', { status: 'disconnected' });

      const response = await postReply(harness, { parentCommentId: thread.topLevelId });

      assertProblem(response, 422, 'ACCOUNT_DISCONNECTED');
    });

    it('rejects an active projection row carrying an auth_failed account_health record', async () => {
      const harness = getHarness();
      const thread = await seedPostedTopLevel(harness, 'instagram');
      await harness.database.drizzle.insert(accountHealth).values({
        socialAccountId: thread.socialAccountId,
        workspaceId: harness.workspaceId,
        state: 'auth_failed',
        reason: 'token revoked upstream',
        detectedAt: new Date(),
      });

      const response = await postReply(harness, { parentCommentId: thread.topLevelId });

      assertProblem(response, 422, 'ACCOUNT_DISCONNECTED');
    });
  });
}

describe('POST /v1/comments/:commentId/replies', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness();
  });

  afterAll(async () => {
    await stopHarness(harness);
  });

  registerDepthTests(() => harness);
  registerTextLengthTests(() => harness);
  registerIdempotencySameBodyTest(() => harness);
  registerIdempotencyConflictTest(() => harness);
  registerIdempotencyConcurrentTest(() => harness);
  registerPlatformCapabilityTests(() => harness);
  registerParentStatusTests(() => harness);
  registerAccountDisconnectedTests(() => harness);
});
