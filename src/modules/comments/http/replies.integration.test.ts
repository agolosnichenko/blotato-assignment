// oxlint-disable max-dependencies -- an integration test harness wires together the same set of
// modules the composition root does (config, db, redis, api, schema, crypto, ids, containers) —
// see the same justification on src/app/container.ts and src/app/api.ts.
// oxlint-disable max-lines -- three scenarios (default ordering + replyCount, the deleted-with-
// live-replies placeholder, the deleted-with-no-replies omission) each need their own seeded
// thread on top of the full harness; see the same justification on post-comments.integration.test.ts.

/**
 * Contract tests for the direct-replies-of-a-comment read, driven through the flat collection
 * (T019/T041, US2, quickstart.md V3, per D31): `GET /v1/comments?parentCommentId=:id&order=asc`
 * replaces `GET /v1/comments/:commentId/replies`. `order=asc` is explicit — the collection's own
 * default is `desc` for every selection (D31, research.md R-06), unlike the removed route.
 *
 * Every scenario asserts the page holds the parent's replies and nothing else, in the `asc` order it
 * asks for. Both halves matter: a `parentCommentId` accepted but dropped would answer the whole
 * workspace in `desc`, and both mistakes are invisible in a status code. The nested address is
 * asserted to be gone (`404`), so a replacement that left it answering would not pass.
 *
 * The placeholder rule (FR-005, A4) is a privacy control, not a display convenience: FR-030 nulls
 * a deleted comment's text and author, and a deleted comment is kept visible only while it still
 * has live replies hanging off it. Both halves are asserted here — the second (full omission) is
 * the one an implementation is likely to forget, since it is easy to stop at "null the fields" and
 * never add the "or omit the row" branch.
 */

import { randomBytes } from 'node:crypto';
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
  socialAccountId: string;
  postId: string;
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

interface SeededWorkspace {
  readonly workspaceId: WorkspaceId;
  readonly socialAccountId: string;
  readonly postId: string;
  readonly apiKey: string;
}

/** A fresh workspace, social account and published post, plus a minted API key for it. */
async function seedWorkspaceAndPost(database: Database): Promise<SeededWorkspace> {
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
  await database.drizzle.insert(posts).values({
    id: postId,
    workspaceId,
    socialAccountId,
    platform: 'instagram',
    platformPostId: `ig-post-${postId}`,
    publishedAt: new Date(),
    createdAt: new Date(),
  });
  const apiKey = await mintApiKey(database, workspaceId);
  return { workspaceId, socialAccountId, postId, apiKey };
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

  const seeded = await seedWorkspaceAndPost(database);

  return { containers, database, redis, publishQueue, app, ...seeded };
}

async function stopHarness(harness: Harness): Promise<void> {
  await harness.app.close();
  await harness.publishQueue.close();
  await harness.database.close();
  harness.redis.disconnect();
  await harness.containers.stop();
}

interface CommentSeed {
  readonly id?: string;
  readonly parentCommentId: string | null;
  readonly rootCommentId: string | null;
  readonly depth: number;
  readonly occurredAt: Date;
  readonly status?: 'posted' | 'deleted';
  readonly replyCount?: number;
  readonly text?: string | null;
  readonly authorUsername?: string | null;
}

/** Inserts one comment row, defaulting to a posted top-level comment. Returns its id. */
async function seedComment(harness: Harness, seed: CommentSeed): Promise<string> {
  const id = seed.id ?? generateId();
  const status = seed.status ?? 'posted';
  const deleted = status === 'deleted';
  await harness.database.drizzle.insert(comments).values({
    id,
    workspaceId: harness.workspaceId,
    socialAccountId: harness.socialAccountId,
    postId: harness.postId,
    platform: 'instagram',
    platformPostId: `ig-post-${harness.postId}`,
    parentCommentId: seed.parentCommentId,
    rootCommentId: seed.rootCommentId,
    depth: seed.depth,
    platformCommentId: `ig-comment-${id}`,
    isOwn: false,
    source: 'sync',
    authorPlatformId: deleted ? null : `author-${id}`,
    authorUsername: deleted ? null : (seed.authorUsername ?? `author-${id}`),
    authorDisplayName: null,
    text: deleted ? null : (seed.text ?? `text of ${id}`),
    status,
    replyCount: seed.replyCount ?? 0,
    lastActivityAt: seed.occurredAt,
    occurredAt: seed.occurredAt,
    createdAt: seed.occurredAt,
    updatedAt: seed.occurredAt,
    deletedAt: deleted ? seed.occurredAt : null,
  });
  return id;
}

interface RepliesPage {
  items: {
    id: string;
    status: string;
    text: string | null;
    author: { platformId: string; username: string; displayName: string | null } | null;
    occurredAt: string;
  }[];
  nextCursor: string | null;
}

interface CommentBody {
  id: string;
  replyCount: number;
}

/**
 * Drives `GET /v1/comments?parentCommentId=:id&order=asc` (V3) — the collection selection that
 * replaces `GET /v1/comments/:commentId/replies`. `order=asc` is explicit (D31, research.md
 * R-06): the collection's own default is `desc` for every selection, unlike the removed route.
 */
async function fetchReplies(
  harness: Harness,
  commentId: string,
): Promise<{ statusCode: number; body: RepliesPage }> {
  const response = await harness.app.inject({
    method: 'GET',
    url: `/v1/comments?parentCommentId=${commentId}&order=asc`,
    headers: { 'blotato-api-key': harness.apiKey },
  });
  return { statusCode: response.statusCode, body: response.json() as RepliesPage };
}

async function fetchComment(
  harness: Harness,
  commentId: string,
): Promise<{ statusCode: number; body: CommentBody }> {
  const response = await harness.app.inject({
    method: 'GET',
    url: `/v1/comments/${commentId}`,
    headers: { 'blotato-api-key': harness.apiKey },
  });
  return { statusCode: response.statusCode, body: response.json() as CommentBody };
}

function registerOrderAndReplyCountTest(getHarness: () => Harness): void {
  it('returns direct replies oldest first by default and reports the parent replyCount', async () => {
    const harness = getHarness();
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    const parentId = await seedComment(harness, {
      parentCommentId: null,
      rootCommentId: null,
      depth: 0,
      occurredAt: new Date(base),
      replyCount: 3,
    });
    // Seeded out of chronological order to prove the response is actually sorted, not just
    // returned in insertion order.
    const secondReplyId = await seedComment(harness, {
      parentCommentId: parentId,
      rootCommentId: parentId,
      depth: 1,
      occurredAt: new Date(base + 20),
    });
    const firstReplyId = await seedComment(harness, {
      parentCommentId: parentId,
      rootCommentId: parentId,
      depth: 1,
      occurredAt: new Date(base + 10),
    });
    const thirdReplyId = await seedComment(harness, {
      parentCommentId: parentId,
      rootCommentId: parentId,
      depth: 1,
      occurredAt: new Date(base + 30),
    });

    const { statusCode, body } = await fetchReplies(harness, parentId);

    expect(statusCode).toBe(200);
    expect(body.items.map((item) => item.id)).toEqual([firstReplyId, secondReplyId, thirdReplyId]);

    const parent = await fetchComment(harness, parentId);
    expect(parent.statusCode).toBe(200);
    expect(parent.body.replyCount).toBe(3);
  });
}

function registerDeletedWithLiveRepliesTest(getHarness: () => Harness): void {
  it('shows a deleted comment with live replies as a text/author-null placeholder', async () => {
    const harness = getHarness();
    const base = Date.parse('2026-01-02T00:00:00.000Z');
    const grandparentId = await seedComment(harness, {
      parentCommentId: null,
      rootCommentId: null,
      depth: 0,
      occurredAt: new Date(base),
    });
    const deletedWithChildId = await seedComment(harness, {
      parentCommentId: grandparentId,
      rootCommentId: grandparentId,
      depth: 1,
      occurredAt: new Date(base + 10),
      status: 'deleted',
      replyCount: 1,
    });
    await seedComment(harness, {
      parentCommentId: deletedWithChildId,
      rootCommentId: grandparentId,
      depth: 2,
      occurredAt: new Date(base + 20),
    });

    const { statusCode, body } = await fetchReplies(harness, grandparentId);

    expect(statusCode).toBe(200);
    const placeholder = body.items.find((item) => item.id === deletedWithChildId);
    expect(placeholder).toBeDefined();
    expect(placeholder?.status).toBe('deleted');
    expect(placeholder?.text).toBeNull();
    expect(placeholder?.author).toBeNull();
  });
}

function registerDeletedChildlessOmittedTest(getHarness: () => Harness): void {
  it('omits a deleted comment with no replies entirely', async () => {
    const harness = getHarness();
    const base = Date.parse('2026-01-03T00:00:00.000Z');
    const parentId = await seedComment(harness, {
      parentCommentId: null,
      rootCommentId: null,
      depth: 0,
      occurredAt: new Date(base),
    });
    const deletedChildlessId = await seedComment(harness, {
      parentCommentId: parentId,
      rootCommentId: parentId,
      depth: 1,
      occurredAt: new Date(base + 10),
      status: 'deleted',
      replyCount: 0,
    });
    const survivingReplyId = await seedComment(harness, {
      parentCommentId: parentId,
      rootCommentId: parentId,
      depth: 1,
      occurredAt: new Date(base + 20),
    });

    const { statusCode, body } = await fetchReplies(harness, parentId);

    expect(statusCode).toBe(200);
    expect(body.items.map((item) => item.id)).not.toContain(deletedChildlessId);
    expect(body.items.map((item) => item.id)).toContain(survivingReplyId);
  });
}

/**
 * T019/V3's negative-data half: `parentCommentId` must exclude a reply that belongs to a
 * *sibling* thread's parent — a selection that silently ignores the filter would return both
 * parents' replies and pass a positive-only fixture.
 */
function registerFilterExclusionTest(getHarness: () => Harness): void {
  it('excludes a reply belonging to a different parent', async () => {
    const harness = getHarness();
    const base = Date.parse('2026-01-04T00:00:00.000Z');
    const parentId = await seedComment(harness, {
      parentCommentId: null,
      rootCommentId: null,
      depth: 0,
      occurredAt: new Date(base),
    });
    const ownReplyId = await seedComment(harness, {
      parentCommentId: parentId,
      rootCommentId: parentId,
      depth: 1,
      occurredAt: new Date(base + 10),
    });
    const siblingParentId = await seedComment(harness, {
      parentCommentId: null,
      rootCommentId: null,
      depth: 0,
      occurredAt: new Date(base + 20),
    });
    const siblingReplyId = await seedComment(harness, {
      parentCommentId: siblingParentId,
      rootCommentId: siblingParentId,
      depth: 1,
      occurredAt: new Date(base + 30),
    });

    const { statusCode, body } = await fetchReplies(harness, parentId);

    expect(statusCode).toBe(200);
    const ids = body.items.map((item) => item.id);
    expect(ids).toContain(ownReplyId);
    expect(ids).not.toContain(siblingReplyId);
    expect(ids).not.toContain(siblingParentId);
  });
}

/**
 * T019/V3: the nested route this selection replaces no longer answers — `404 NOT_FOUND` (FR-009).
 */
function registerOldAddressGoneTest(getHarness: () => Harness): void {
  it('answers 404 NOT_FOUND at the old GET /v1/comments/:commentId/replies address', async () => {
    const harness = getHarness();
    const parentId = await seedComment(harness, {
      parentCommentId: null,
      rootCommentId: null,
      depth: 0,
      occurredAt: new Date(),
    });

    const response = await harness.app.inject({
      method: 'GET',
      url: `/v1/comments/${parentId}/replies`,
      headers: { 'blotato-api-key': harness.apiKey },
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect((response.json() as { code: string }).code).toBe('NOT_FOUND');
  });
}

describe('GET /v1/comments?parentCommentId&order=asc (was /v1/comments/:commentId/replies)', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness();
  });

  afterAll(async () => {
    await stopHarness(harness);
  });

  registerOrderAndReplyCountTest(() => harness);
  registerDeletedWithLiveRepliesTest(() => harness);
  registerDeletedChildlessOmittedTest(() => harness);
  registerFilterExclusionTest(() => harness);
  registerOldAddressGoneTest(() => harness);
});
