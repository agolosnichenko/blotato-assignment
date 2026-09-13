// oxlint-disable max-dependencies -- an integration test harness wires together the same set of
// modules the composition root does (config, db, redis, api, schema, crypto, ids, containers) —
// see the same justification on src/app/container.ts and src/app/api.ts.

/**
 * Contract tests for `GET /v1/comments/:commentId` (T042).
 *
 * Fails today the same way its siblings do: no route is registered at this path, so every request
 * 404s through Fastify's own not-found handler rather than the assertions below.
 *
 * The tenancy assertion (D20, FR-026) is the point of this file: a comment belonging to another
 * workspace must come back exactly like a comment that does not exist at all — `404 NOT_FOUND`,
 * never `403`, and nothing in the body distinguishing the two cases. The two workspaces here use
 * separate API keys so the only variable between the "own" and "other" requests is which key is
 * presented, not which comment id.
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

interface Workspace {
  workspaceId: WorkspaceId;
  socialAccountId: string;
  postId: string;
  apiKey: string;
}

interface Harness {
  containers: TestContainers;
  database: Database;
  redis: Redis;
  publishQueue: Queue;
  app: Api;
  ownWorkspace: Workspace;
  otherWorkspace: Workspace;
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

async function seedWorkspace(database: Database): Promise<Workspace> {
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

  const ownWorkspace = await seedWorkspace(database);
  const otherWorkspace = await seedWorkspace(database);

  return { containers, database, redis, publishQueue, app, ownWorkspace, otherWorkspace };
}

async function stopHarness(harness: Harness): Promise<void> {
  await harness.app.close();
  await harness.publishQueue.close();
  await harness.database.close();
  harness.redis.disconnect();
  await harness.containers.stop();
}

async function seedComment(database: Database, workspace: Workspace): Promise<string> {
  const id = generateId();
  const occurredAt = new Date('2026-01-01T00:00:00.000Z');
  await database.drizzle.insert(comments).values({
    id,
    workspaceId: workspace.workspaceId,
    socialAccountId: workspace.socialAccountId,
    postId: workspace.postId,
    platform: 'instagram',
    platformPostId: `ig-post-${workspace.postId}`,
    parentCommentId: null,
    rootCommentId: null,
    depth: 0,
    platformCommentId: `ig-comment-${id}`,
    isOwn: false,
    source: 'sync',
    authorPlatformId: 'author-1',
    authorUsername: 'author1',
    authorDisplayName: null,
    text: 'hello world',
    status: 'posted',
    replyCount: 0,
    lastActivityAt: occurredAt,
    occurredAt,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  });
  return id;
}

async function getComment(
  harness: Harness,
  commentId: string,
  apiKey: string,
): Promise<{ statusCode: number; headers: Record<string, string>; body: unknown }> {
  const response = await harness.app.inject({
    method: 'GET',
    url: `/v1/comments/${commentId}`,
    headers: { 'blotato-api-key': apiKey },
  });
  return {
    statusCode: response.statusCode,
    headers: response.headers as never,
    body: response.json(),
  };
}

function registerOwnWorkspaceTest(getHarness: () => Harness): void {
  it('returns a single comment by id for its own workspace', async () => {
    const harness = getHarness();
    const commentId = await seedComment(harness.database, harness.ownWorkspace);

    const { statusCode, body } = await getComment(harness, commentId, harness.ownWorkspace.apiKey);

    expect(statusCode).toBe(200);
    expect(body).toMatchObject({
      id: commentId,
      accountId: harness.ownWorkspace.socialAccountId,
      postId: harness.ownWorkspace.postId,
      text: 'hello world',
      status: 'posted',
    });
  });
}

function registerTenancyTest(getHarness: () => Harness): void {
  it("returns 404 NOT_FOUND, not 403, for another workspace's comment", async () => {
    const harness = getHarness();
    const otherCommentId = await seedComment(harness.database, harness.otherWorkspace);

    const asOwner = await getComment(harness, otherCommentId, harness.otherWorkspace.apiKey);
    expect(asOwner.statusCode).toBe(200);

    const asOtherWorkspace = await getComment(harness, otherCommentId, harness.ownWorkspace.apiKey);
    expect(asOtherWorkspace.statusCode).toBe(404);
    expect(asOtherWorkspace.statusCode).not.toBe(403);
    expect(asOtherWorkspace.headers['content-type']).toContain('application/problem+json');
    expect((asOtherWorkspace.body as { code: string }).code).toBe('NOT_FOUND');

    const missingCommentId = generateId();
    const asMissing = await getComment(harness, missingCommentId, harness.ownWorkspace.apiKey);
    expect(asMissing.statusCode).toBe(404);
    expect((asMissing.body as { code: string }).code).toBe('NOT_FOUND');

    // The two 404 bodies must be indistinguishable in shape — nothing in either response may leak
    // that one commentId belongs to a real (but foreign) row and the other never existed at all.
    expect(Object.keys(asOtherWorkspace.body as object).toSorted()).toEqual(
      Object.keys(asMissing.body as object).toSorted(),
    );
  });
}

describe('GET /v1/comments/:commentId', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness();
  });

  afterAll(async () => {
    await stopHarness(harness);
  });

  registerOwnWorkspaceTest(() => harness);
  registerTenancyTest(() => harness);
});
