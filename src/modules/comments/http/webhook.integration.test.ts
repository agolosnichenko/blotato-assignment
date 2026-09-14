// oxlint-disable max-dependencies -- this harness wires the full stack both halves of the webhook
// path run on in production: `buildApi` (intake, the route-scoped raw-body parser, the rest of the
// API so the cross-contamination check has a second route to hit), a standalone `webhook-process`
// `Worker` built the same way `src/app/worker.ts` builds it, and every port/repository dependency
// that chain touches — see the same justification on `api.integration.test.ts` and
// `webhook-worker.integration.test.ts`.
// oxlint-disable max-lines -- five required assertions (T072) plus the one extra
// cross-contamination check, each needing its own signed fixture variant and its own seed data, is
// the file's actual scope (mirrors the same disable on `post-comments.integration.test.ts`).

/**
 * The Meta webhook path end to end (T072, FR-016, SC-004, §7.2).
 *
 * `webhook-routes.ts` (intake, signature check, handshake) and `webhook-worker.ts` (the
 * `webhook-process` consumer) were built by different agents who never shared code — only the
 * queue name and job name exported from `src/shared/queues.ts`, and the `{ deliveryId }` job
 * payload shape, were agreed through a relayed message. Every other integration test in this repo
 * proves one half or the other; this file is the first to run a real signed HTTP delivery through
 * intake, onto the real `webhook-process` queue, through a real worker, into a real upsert, and
 * back out through the read API — the one seam that fails if the two halves silently disagree.
 *
 * **Which bytes are real, which are synthesized.** `__fixtures__/s1-page-feed-test-delivery.json`
 * is the only payload §17 S1 confirmed Meta actually sends (a dashboard `Test` send, `item:
 * "status"`, not a comment — `webhook-normalizer.ts`'s own docstring makes the same point). The
 * signature-path assertions (valid delivery, tampered signature) sign and send that fixture's exact
 * recorded bytes, unmodified, read as a `Buffer` — never a re-serialized `JSON.stringify` of a
 * parsed copy, since the HMAC covers raw bytes (§17 S5) and a re-serialized body would only prove
 * the test agrees with itself. The two comment-bearing variants (unknown account, the one that must
 * actually reach the read API) `structuredClone` that fixture and synthesize `item: "comment"` plus
 * `comment_id`/`verb` — fields the real fixture does not carry, for the same reason
 * `webhook-worker.integration.test.ts`'s `pageFeedDelivery` helper synthesizes them — then
 * re-serialize *that* clone to a fresh buffer and sign the buffer actually sent, never the
 * original fixture bytes.
 */

import { createHmac } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApi, type Api } from '#src/app/api.ts';
import { loadConfig } from '#src/app/config.ts';
import { buildContainer, type Container } from '#src/app/container.ts';
import { createIngestComments } from '#src/modules/comments/application/ingest-comments.ts';
import { comments, webhookDeliveries } from '#src/modules/comments/infrastructure/schema.ts';
import { createSyncTargetRepository } from '#src/modules/comments/infrastructure/sync-target-repository.ts';
import { createWebhookWorker } from '#src/modules/comments/infrastructure/webhook-worker.ts';
import {
  createLocalAccountCredentials,
  encryptCredentials,
} from '#src/modules/platform-core/local/account-credentials.ts';
import { createLocalAccounts } from '#src/modules/platform-core/local/accounts.ts';
import { apiKeys, posts, socialAccounts, workspaces } from '#src/modules/platform-core/schema.ts';
import { createMetaWebhookNormalizer } from '#src/platforms/meta/webhook-normalizer.ts';
import { hashSecret } from '#src/shared/crypto.ts';
import type { Database } from '#src/shared/db.ts';
import { asWorkspaceId, generateId, type WorkspaceId } from '#src/shared/ids.ts';
import { createLogger } from '#src/shared/logger.ts';
import { createRedis } from '#src/shared/queue.ts';
import { startTestContainers, type TestContainers } from '#src/shared/testing/containers.ts';
import { TEST_ENV } from '#src/shared/testing/test-env.ts';

const FIXTURE_URL = new URL(
  '../../../platforms/meta/__fixtures__/s1-page-feed-test-delivery.json',
  import.meta.url,
);
/** The fixture's recorded bytes, read once as a `Buffer` — signed as-is, never re-serialized. */
const FIXTURE_BYTES = readFileSync(FIXTURE_URL);
const FIXTURE_JSON = JSON.parse(FIXTURE_BYTES.toString('utf8')) as Record<string, unknown>;

const SIGNING_SECRET = TEST_ENV.META_APP_SECRET;
const VERIFY_TOKEN = TEST_ENV.META_WEBHOOK_VERIFY_TOKEN;
/** The fixture's own recorded `message` field — copied here as a literal rather than read back
 * through a cast, since `pageFeedCommentDelivery` leaves it untouched on every derived variant. */
const FIXTURE_MESSAGE = 'Example post content.';

function sign(body: Buffer): string {
  return `sha256=${createHmac('sha256', SIGNING_SECRET).update(body).digest('hex')}`;
}

interface Harness {
  containers: TestContainers;
  database: Database;
  redis: Redis;
  workerRedis: Redis;
  app: Api;
  worker: Worker;
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

/**
 * Builds the `webhook-process` worker the same way `src/app/worker.ts`'s `buildWebhookWorker`
 * does — its own Redis connection (never the `Container`'s, which the api role's own queue
 * producer already uses), so this is a second, independent BullMQ client talking to the same
 * queue over the same Redis server, exactly as the two runtime roles are in production.
 */
function buildWorker(container: Container, workerRedis: Redis): Worker {
  const syncTargetRepository = createSyncTargetRepository(
    container.database.drizzle,
    container.config,
  );
  const ingestComments = createIngestComments({
    database: container.database.drizzle,
    syncTargetRepository,
  });
  return createWebhookWorker({
    database: container.database.drizzle,
    redis: workerRedis,
    config: container.config,
    accounts: createLocalAccounts(container.database.drizzle),
    accountCredentials: createLocalAccountCredentials(container.database.drizzle, {
      key: Buffer.from(TEST_ENV.CREDENTIALS_ENCRYPTION_KEY, 'base64'),
      keyVersion: 1,
    }),
    ingestComments,
    normalizer: createMetaWebhookNormalizer(),
    logger: createLogger(container.config, { role: 'test' }),
  });
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
  const { database, redis } = container;
  const app = buildApi(container);
  await app.ready();

  const workerRedis = createRedis(config);
  const worker = buildWorker(container, workerRedis);

  const workspaceId = asWorkspaceId(generateId());
  await database.drizzle.insert(workspaces).values({
    id: workspaceId,
    name: 'Test workspace',
    contactLimitMonthly: 100,
    createdAt: new Date(),
  });
  const apiKey = await mintApiKey(database, workspaceId);

  return { containers, database, redis, workerRedis, app, worker, workspaceId, apiKey };
}

async function stopHarness(harness: Harness): Promise<void> {
  await harness.worker.close();
  await harness.app.close();
  await harness.database.close();
  harness.redis.disconnect();
  harness.workerRedis.disconnect();
  await harness.containers.stop();
}

interface SeededAccount {
  readonly socialAccountId: string;
  readonly platformAccountId: string;
}

/**
 * Seeds a `facebook` social account with a real encrypted credential, not a zeroed placeholder
 * (`get-comment.integration.test.ts`'s pattern, fine for routes that never decrypt it): the webhook
 * worker's `resolveAccountContexts` calls `accountCredentials.findBySocialAccountId` on every
 * matching account, and a ciphertext that fails its AES-256-GCM auth tag check throws rather than
 * returning "not found" — a placeholder here would make the worker job retry forever instead of
 * completing, which looks identical to the two halves disagreeing unless traced back to this seed.
 */
async function seedFacebookAccount(harness: Harness): Promise<SeededAccount> {
  const socialAccountId = generateId();
  const platformAccountId = `page-${generateId()}`;
  const credentialsCiphertext = encryptCredentials(Buffer.from('page-token'), {
    key: Buffer.from(TEST_ENV.CREDENTIALS_ENCRYPTION_KEY, 'base64'),
    keyVersion: 1,
  });
  await harness.database.drizzle.insert(socialAccounts).values({
    id: socialAccountId,
    workspaceId: harness.workspaceId,
    platform: 'facebook',
    platformAccountId,
    username: 'demo-page',
    authVariant: null,
    credentialsCiphertext,
    credentialsKeyVersion: 1,
    status: 'active',
    createdAt: new Date(),
  });
  return { socialAccountId, platformAccountId };
}

/** Builds a `page.feed` comment change on `entry[0].value`, synthesizing only the comment-specific
 * fields the real fixture does not carry (module docstring). */
function pageFeedCommentDelivery(
  platformAccountId: string,
  commentId: string,
  verb: 'add' | 'remove' = 'add',
): Buffer {
  const clone = structuredClone(FIXTURE_JSON) as {
    entry: [{ id: string; changes: [{ value: Record<string, unknown> }] }];
  };
  clone.entry[0].id = platformAccountId;
  const value = clone.entry[0].changes[0].value;
  value['item'] = 'comment';
  value['verb'] = verb;
  value['comment_id'] = commentId;
  // `post_id`/`message`/`from`/`created_time` are left as the fixture's own recorded values.
  return Buffer.from(JSON.stringify(clone));
}

function postWebhook(
  app: Api,
  body: Buffer,
  signatureHeader: string | undefined,
): Promise<{ statusCode: number }> {
  return app.inject({
    method: 'POST',
    url: '/webhooks/meta',
    headers: {
      'content-type': 'application/json',
      ...(signatureHeader === undefined ? {} : { 'x-hub-signature-256': signatureHeader }),
    },
    payload: body,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface InboxItem {
  platformCommentId: string | null;
  text: string | null;
}

/**
 * Waits for the worker's upsert to land, polling Postgres directly rather than
 * `GET /v1/comments?accountId=…` itself — `RATE_LIMIT_READS_PER_MIN` defaults to 30
 * (`src/app/config.ts`), and a poll tight enough to catch ingestion landing within milliseconds
 * would exhaust that budget long before any deadline worth testing. Once the row exists, exactly
 * one `GET` against the read API (the caller's job, not this function's) is what proves "readable
 * through the API" rather than merely "ingested" — the distinction assertion 5 is actually about.
 */
async function waitUntilIngested(
  database: Database,
  socialAccountId: string,
  platformCommentId: string,
  deadlineMs: number,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < deadlineMs) {
    // oxlint-disable-next-line no-await-in-loop
    const [row] = await database.drizzle
      .select({ id: comments.id })
      .from(comments)
      .where(
        and(
          eq(comments.socialAccountId, socialAccountId),
          eq(comments.platformCommentId, platformCommentId),
        ),
      );
    if (row !== undefined) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop
    await sleep(100);
  }
  throw new Error(`test: comment ${platformCommentId} was never ingested within ${deadlineMs}ms`);
}

let harness: Harness;

beforeAll(async () => {
  harness = await startHarness();
});

afterAll(async () => {
  await stopHarness(harness);
});

describe('POST /webhooks/meta — valid signed delivery', () => {
  it('is stored and acknowledged in under a second', async () => {
    const header = sign(FIXTURE_BYTES);
    const startedAt = Date.now();
    const response = await postWebhook(harness.app, FIXTURE_BYTES, header);
    const elapsedMs = Date.now() - startedAt;

    expect(response.statusCode).toBe(200);
    expect(elapsedMs).toBeLessThan(1000);

    const rows = await harness.database.drizzle
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.provider, 'meta'));
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('POST /webhooks/meta — tampered signature', () => {
  it('is rejected with nothing stored', async () => {
    const validHeader = sign(FIXTURE_BYTES);
    // Flips one hex character of an otherwise-valid signature — the body itself is the fixture's
    // own recorded bytes, unmodified; only the signature is tampered.
    const tamperedChar = validHeader.at(-1) === '0' ? '1' : '0';
    const tamperedHeader = `${validHeader.slice(0, -1)}${tamperedChar}`;

    const before = await harness.database.drizzle.select().from(webhookDeliveries);
    const response = await postWebhook(harness.app, FIXTURE_BYTES, tamperedHeader);
    const after = await harness.database.drizzle.select().from(webhookDeliveries);

    expect(response.statusCode).toBe(401);
    expect(after.length).toBe(before.length);
  });
});

/**
 * Polls every `webhook_deliveries` row until one whose payload carries `needle` (the synthesized
 * `comment_id`, unique per call) has a non-null `processedAt` — found by content rather than by
 * the insert's own id, since several deliveries accumulate in this table across this file's cases
 * and the route never hands the test the row id it inserted.
 */
async function waitUntilDeliveryProcessed(
  database: Database,
  needle: string,
  deadlineMs: number,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < deadlineMs) {
    // oxlint-disable-next-line no-await-in-loop
    const rows = await database.drizzle
      .select({ processedAt: webhookDeliveries.processedAt, payload: webhookDeliveries.payload })
      .from(webhookDeliveries);
    const row = rows.find((candidate) => JSON.stringify(candidate.payload).includes(needle));
    if (row?.processedAt !== null && row?.processedAt !== undefined) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop
    await sleep(100);
  }
  throw new Error(
    `test: no delivery carrying "${needle}" was marked processed within ${deadlineMs}ms`,
  );
}

describe('POST /webhooks/meta — unknown account', () => {
  it('is acknowledged and marked processed, never retried', async () => {
    const unknownPlatformAccountId = `page-unknown-${generateId()}`;
    const commentId = `comment-unknown-${generateId()}`;
    const body = pageFeedCommentDelivery(unknownPlatformAccountId, commentId);
    const header = sign(body);

    const response = await postWebhook(harness.app, body, header);
    expect(response.statusCode).toBe(200);

    await waitUntilDeliveryProcessed(harness.database, commentId, 5000);
  });
});

describe('GET /webhooks/meta — handshake', () => {
  it('echoes hub.challenge only when hub.verify_token matches', async () => {
    const ok = await harness.app.inject({
      method: 'GET',
      url:
        `/webhooks/meta?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}` +
        '&hub.challenge=challenge-123',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('challenge-123');
  });

  it('answers 403 echoing nothing when hub.verify_token does not match', async () => {
    const rejected = await harness.app.inject({
      method: 'GET',
      url:
        '/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong-token' +
        '&hub.challenge=challenge-123',
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.body).not.toContain('challenge-123');
  });
});

describe('the webhook path end to end (assertion 5, the point of this file)', () => {
  it('is readable through the read API within 60s of delivery', async () => {
    const account = await seedFacebookAccount(harness);
    const commentId = `comment-e2e-${generateId()}`;
    const body = pageFeedCommentDelivery(account.platformAccountId, commentId);
    const header = sign(body);

    const deliveredAt = Date.now();
    const response = await postWebhook(harness.app, body, header);
    expect(response.statusCode).toBe(200);

    await waitUntilIngested(harness.database, account.socialAccountId, commentId, 60_000);

    const inboxResponse = await harness.app.inject({
      method: 'GET',
      url: `/v1/comments?accountId=${account.socialAccountId}`,
      headers: { 'blotato-api-key': harness.apiKey },
    });
    const elapsedMs = Date.now() - deliveredAt;
    const inboxBody = inboxResponse.json() as { items: InboxItem[] };
    const item = inboxBody.items.find((candidate) => candidate.platformCommentId === commentId);

    expect(inboxResponse.statusCode).toBe(200);
    expect(elapsedMs).toBeLessThan(60_000);
    expect(item?.text).toBe(FIXTURE_MESSAGE);
  });
});

describe('cross-contamination guard', () => {
  it('a different JSON route on the same app instance still receives a parsed body', async () => {
    const account = await seedFacebookAccount(harness);
    const postId = generateId();
    await harness.database.drizzle.insert(posts).values({
      id: postId,
      workspaceId: harness.workspaceId,
      socialAccountId: account.socialAccountId,
      platform: 'facebook',
      platformPostId: `fb-post-${postId}`,
      publishedAt: new Date(),
      createdAt: new Date(),
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: `/v1/posts/${postId}/comments`,
      headers: { 'blotato-api-key': harness.apiKey, 'content-type': 'application/json' },
      payload: { text: 'still a parsed object, not a Buffer' },
    });

    expect(response.statusCode).toBe(202);
  });
});
