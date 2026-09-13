/**
 * The `webhook-process` worker end to end (T081, §7.2 steps 2-4) — short of T072's full HTTP ->
 * worker -> API walk, which lands in a later wave. This exercises `createWebhookWorker` as BullMQ
 * actually runs it: a real `webhook_deliveries` row, a real job on a real `webhook-process` queue,
 * the real `page.feed` normalizer, and the real Facebook adapter with only its Graph API HTTP call
 * intercepted (msw) — never the worker's own internal functions, which are not exported.
 *
 * One case per module docstring point, plus the ordinary path:
 *   - unknown account (§7.2 step 2): processed, no comment row, no adapter call.
 *   - a complete `page.feed` add: a comment row appears with the payload's own data.
 *   - a thin `page.feed` edit (A18): completed via `adapter.fetchComment` (msw), not stored empty.
 *   - a `page.feed` remove on an existing row: the shared delete branch runs (status `deleted`).
 *   - two accounts sharing one `platformAccountId`, different workspaces: both get their own row.
 *   - an undecryptable credential, and an adapter-rejected (401) credential (D30, point 5): both
 *     record `account_health`/outbox `account.auth_failed`, mark the delivery processed, and do
 *     not retry — plus one fan-out case proving a bad account does not abandon a good one.
 */

// oxlint-disable max-dependencies, max-lines -- this test wires a full harness (Postgres, Redis,
// the BullMQ queue the worker and the assertions share, msw for the one outbound Graph call,
// config/crypto helpers to seed a real account) plus four independent cases, each needing its own
// seed data; none of that can be dropped without weakening what the test proves (mirrors
// publish-comment.integration.test.ts's own exemption for the same reason).

import { eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { Queue, type Worker } from 'bullmq';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '#src/app/config.ts';
import { createIngestComments } from '#src/modules/comments/application/ingest-comments.ts';
import { createWebhookWorker } from '#src/modules/comments/infrastructure/webhook-worker.ts';
import {
  accountHealth,
  comments,
  outboxEvents,
  webhookDeliveries,
} from '#src/modules/comments/infrastructure/schema.ts';
import { createSyncTargetRepository } from '#src/modules/comments/infrastructure/sync-target-repository.ts';
import {
  createLocalAccountCredentials,
  encryptCredentials,
} from '#src/modules/platform-core/local/account-credentials.ts';
import { createLocalAccounts } from '#src/modules/platform-core/local/accounts.ts';
import { socialAccounts, workspaces } from '#src/modules/platform-core/schema.ts';
import { createMetaWebhookNormalizer } from '#src/platforms/meta/webhook-normalizer.ts';
import { createLogger } from '#src/shared/logger.ts';
import { generateId } from '#src/shared/ids.ts';
import { createRedis } from '#src/shared/queue.ts';
import { JOB_NAMES, QUEUE_NAMES } from '#src/shared/queues.ts';
import { startTestContainers, type TestContainers } from '#src/shared/testing/containers.ts';
import { TEST_ENV } from '#src/shared/testing/test-env.ts';

const GRAPH_VERSION = 'v21.0';
const POST_ID = '44444444_444444444';

// `server.listen()` must not start before `startTestContainers()` below: msw's node interceptors
// patch Node's http/https modules process-wide, and testcontainers talks to the Docker daemon over
// that same HTTP layer — listening first intercepts testcontainers' own Docker API calls instead of
// only the Graph API call this test means to mock. Both are wired into the single harness
// `beforeAll`/`afterAll` pair below, in that order, rather than as separate top-level hooks.
const server = setupServer();
afterEach(() => server.resetHandlers());

interface Harness {
  containers: TestContainers;
  pool: Pool;
  db: NodePgDatabase;
  redis: Redis;
  webhookQueue: Queue;
  worker: Worker;
}

async function setupHarness(): Promise<Harness> {
  const containers = await startTestContainers();
  // msw's interceptors must patch global `fetch` only after testcontainers is done using it for
  // the Docker API (module docstring) — and strictly before `createWebhookWorker` below builds its
  // Meta adapters, since `createGraphClient` captures whichever `fetch` is live at construction
  // time (facebook-adapter.test.ts's own docstring makes the same point for a plain unit test).
  server.listen({ onUnhandledRequest: 'error' });
  const pool = new Pool({ connectionString: containers.databaseUrl });
  const db = drizzle(pool);
  const config = loadConfig({
    ...TEST_ENV,
    LOG_LEVEL: 'silent',
    DATABASE_URL: containers.databaseUrl,
    REDIS_URL: containers.redisUrl,
  });
  const redis = createRedis(config);
  const webhookQueue = new Queue(QUEUE_NAMES.webhookProcess, { connection: redis });

  const syncTargetRepository = createSyncTargetRepository(db, config);
  const worker = createWebhookWorker({
    database: db,
    redis,
    config,
    accounts: createLocalAccounts(db),
    accountCredentials: createLocalAccountCredentials(db, {
      key: Buffer.from(TEST_ENV.CREDENTIALS_ENCRYPTION_KEY, 'base64'),
      keyVersion: 1,
    }),
    ingestComments: createIngestComments({ database: db, syncTargetRepository }),
    normalizer: createMetaWebhookNormalizer(),
    logger: createLogger(config, { role: 'test' }),
  });

  return { containers, pool, db, redis, webhookQueue, worker };
}

async function teardownHarness(harness: Harness): Promise<void> {
  await harness.worker.close();
  await harness.webhookQueue.close();
  harness.redis.disconnect();
  await harness.pool.end();
  await harness.containers.stop();
}

interface SeededAccount {
  readonly workspaceId: string;
  readonly socialAccountId: string;
  readonly platformAccountId: string;
}

interface SeedWorkspaceAndAccountOptions {
  readonly platformAccountId?: string;
  /**
   * Mismatches the stored column against the worker's real key material (`keyVersion: 1` in
   * `setupHarness`) to force a deterministic `KeyVersionMismatchError` inside `decrypt` — real
   * ciphertext, wrong declared version, no need to corrupt any bytes. `unpackCredentials` builds
   * its `EncryptedPayload.keyVersion` from this column, not from anything encoded in the blob
   * itself (`account-credentials.ts`'s own docstring), so this alone is enough to make the stored
   * credential undecryptable.
   */
  readonly credentialsKeyVersion?: number;
}

/**
 * A fresh `platformAccountId` per call by default — most tests want one account per delivery, not
 * the fan-out this port now explicitly allows (`listByPlatformAccount`, spec.md §18:
 * `social_accounts` carries no uniqueness on `(platform, platform_account_id)`, so two workspaces
 * may legitimately share one). Pass `platformAccountId` explicitly to seed a *second* account
 * sharing the first's id, as the fan-out test below does.
 */
async function seedWorkspaceAndAccount(
  db: NodePgDatabase,
  options: SeedWorkspaceAndAccountOptions = {},
): Promise<SeededAccount> {
  const workspaceId = generateId();
  const socialAccountId = generateId();
  const platformAccountId = options.platformAccountId ?? `page-${generateId()}`;
  const credentialsCiphertext = encryptCredentials(Buffer.from('page-token'), {
    key: Buffer.from(TEST_ENV.CREDENTIALS_ENCRYPTION_KEY, 'base64'),
    keyVersion: 1,
  });

  await db.insert(workspaces).values({
    id: workspaceId,
    name: 'Test workspace',
    contactLimitMonthly: 100,
    createdAt: new Date(),
  });
  await db.insert(socialAccounts).values({
    id: socialAccountId,
    workspaceId,
    platform: 'facebook',
    platformAccountId,
    username: 'demo-page',
    authVariant: null,
    credentialsCiphertext,
    credentialsKeyVersion: options.credentialsKeyVersion ?? 1,
    status: 'active',
    createdAt: new Date(),
  });

  return { workspaceId, socialAccountId, platformAccountId };
}

function pageFeedDelivery(
  platformAccountId: string,
  value: Record<string, unknown>,
): Record<string, unknown> {
  return {
    object: 'page',
    entry: [{ id: platformAccountId, time: 1_700_000_000, changes: [{ field: 'feed', value }] }],
  };
}

async function seedDelivery(db: NodePgDatabase, payload: Record<string, unknown>): Promise<string> {
  const [row] = await db
    .insert(webhookDeliveries)
    .values({ provider: 'meta', payload })
    .returning({ id: webhookDeliveries.id });
  if (row === undefined) {
    throw new Error('test: insert into webhook_deliveries returned no row');
  }
  return row.id;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Polling the one column that signals "the job finished" — each iteration's query depends on
 * whether the previous one found the row processed yet, so this cannot become a `Promise.all`.
 */
async function waitUntilProcessed(db: NodePgDatabase, deliveryId: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop
    const [row] = await db
      .select({ processedAt: webhookDeliveries.processedAt })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, deliveryId));
    if (row?.processedAt !== null && row?.processedAt !== undefined) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop
    await sleep(50);
  }
  throw new Error(`test: delivery ${deliveryId} was not processed within 5s`);
}

let harness: Harness;

beforeAll(async () => {
  harness = await setupHarness();
});

afterAll(async () => {
  server.close();
  await teardownHarness(harness);
});

beforeEach(async () => {
  await harness.db.delete(comments);
});

describe('unknown account (§7.2 step 2)', () => {
  it('processes the delivery, logs a warning, never ingests anything', async () => {
    const { db, webhookQueue } = harness;
    const deliveryId = await seedDelivery(
      db,
      pageFeedDelivery(`page-${generateId()}`, {
        item: 'comment',
        verb: 'add',
        comment_id: 'comment-unknown',
        post_id: POST_ID,
        message: 'hello',
        from: { id: 'author-1' },
        created_time: 1_700_000_000,
      }),
    );

    await webhookQueue.add(JOB_NAMES.processDelivery, { deliveryId }, { jobId: deliveryId });
    await waitUntilProcessed(db, deliveryId);

    const [row] = await db
      .select()
      .from(comments)
      .where(eq(comments.platformCommentId, 'comment-unknown'));
    expect(row).toBeUndefined();
  });
});

describe('a complete page.feed add', () => {
  it('inserts a comment row from the payload’s own data', async () => {
    const { db, webhookQueue } = harness;
    const account = await seedWorkspaceAndAccount(db);
    const deliveryId = await seedDelivery(
      db,
      pageFeedDelivery(account.platformAccountId, {
        item: 'comment',
        verb: 'add',
        comment_id: 'comment-complete',
        post_id: POST_ID,
        message: 'a real comment',
        from: { id: 'commenter-1', name: 'Jane Doe' },
        created_time: 1_700_000_000,
      }),
    );

    await webhookQueue.add(JOB_NAMES.processDelivery, { deliveryId }, { jobId: deliveryId });
    await waitUntilProcessed(db, deliveryId);

    const [row] = await db
      .select()
      .from(comments)
      .where(eq(comments.platformCommentId, 'comment-complete'));
    expect(row).toMatchObject({
      workspaceId: account.workspaceId,
      socialAccountId: account.socialAccountId,
      platform: 'facebook',
      text: 'a real comment',
      authorDisplayName: 'Jane Doe',
      status: 'posted',
      parentCommentId: null,
    });
  });
});

describe('a thin page.feed edit (A18)', () => {
  it('completes via adapter.fetchComment rather than storing blank text', async () => {
    server.use(
      http.get(`https://graph.facebook.com/${GRAPH_VERSION}/comment-thin`, () =>
        HttpResponse.json({
          id: 'comment-thin',
          message: 'fetched from the platform',
          created_time: '2026-01-01T00:00:00+0000',
          from: { id: 'commenter-2', name: 'Fetched Author' },
        }),
      ),
    );

    const { db, webhookQueue } = harness;
    const account = await seedWorkspaceAndAccount(db);
    const payload = pageFeedDelivery(account.platformAccountId, {
      item: 'comment',
      verb: 'edited',
      comment_id: 'comment-thin',
      post_id: POST_ID,
      from: { id: 'commenter-2' },
      created_time: 1_700_000_000,
    });
    const entry = payload['entry'] as [{ changes: [{ value: Record<string, unknown> }] }];
    const value = entry[0].changes[0].value;
    delete value['message'];
    const deliveryId = await seedDelivery(db, payload);

    await webhookQueue.add(JOB_NAMES.processDelivery, { deliveryId }, { jobId: deliveryId });
    await waitUntilProcessed(db, deliveryId);

    const [row] = await db
      .select()
      .from(comments)
      .where(eq(comments.platformCommentId, 'comment-thin'));
    expect(row).toMatchObject({
      workspaceId: account.workspaceId,
      text: 'fetched from the platform',
      authorDisplayName: 'Fetched Author',
    });
  });
});

describe('a page.feed remove on an existing row', () => {
  it('runs the shared delete branch (status deleted, text nulled)', async () => {
    const { db, webhookQueue } = harness;
    const account = await seedWorkspaceAndAccount(db);
    const addDeliveryId = await seedDelivery(
      db,
      pageFeedDelivery(account.platformAccountId, {
        item: 'comment',
        verb: 'add',
        comment_id: 'comment-to-delete',
        post_id: POST_ID,
        message: 'will be deleted',
        from: { id: 'commenter-3' },
        created_time: 1_700_000_000,
      }),
    );
    await webhookQueue.add(
      JOB_NAMES.processDelivery,
      { deliveryId: addDeliveryId },
      { jobId: addDeliveryId },
    );
    await waitUntilProcessed(db, addDeliveryId);

    const removeDeliveryId = await seedDelivery(
      db,
      pageFeedDelivery(account.platformAccountId, {
        item: 'comment',
        verb: 'remove',
        comment_id: 'comment-to-delete',
        post_id: POST_ID,
      }),
    );
    await webhookQueue.add(
      JOB_NAMES.processDelivery,
      { deliveryId: removeDeliveryId },
      { jobId: removeDeliveryId },
    );
    await waitUntilProcessed(db, removeDeliveryId);

    const [row] = await db
      .select()
      .from(comments)
      .where(eq(comments.platformCommentId, 'comment-to-delete'));
    expect(row).toMatchObject({ workspaceId: account.workspaceId, status: 'deleted', text: null });
  });
});

interface TwoAccountsOnOnePage {
  readonly accountA: SeededAccount;
  readonly accountB: SeededAccount;
}

/** Two accounts, different workspaces, sharing one `platformAccountId` — the case this port's
 * `listByPlatformAccount` exists for (spec.md §18). */
async function seedTwoAccountsSharingOnePage(db: NodePgDatabase): Promise<TwoAccountsOnOnePage> {
  const platformAccountId = `page-${generateId()}`;
  const accountA = await seedWorkspaceAndAccount(db, { platformAccountId });
  const accountB = await seedWorkspaceAndAccount(db, { platformAccountId });
  return { accountA, accountB };
}

describe('two workspaces sharing one platformAccountId (spec.md §18 fan-out)', () => {
  it('ingests once per account, each into its own workspace, neither reading the other', async () => {
    const { db, webhookQueue } = harness;
    const { accountA, accountB } = await seedTwoAccountsSharingOnePage(db);
    expect(accountA.workspaceId).not.toBe(accountB.workspaceId);

    const deliveryId = await seedDelivery(
      db,
      pageFeedDelivery(accountA.platformAccountId, {
        item: 'comment',
        verb: 'add',
        comment_id: 'comment-shared-page',
        post_id: POST_ID,
        message: 'seen by both workspaces',
        from: { id: 'commenter-shared' },
        created_time: 1_700_000_000,
      }),
    );

    await webhookQueue.add(JOB_NAMES.processDelivery, { deliveryId }, { jobId: deliveryId });
    await waitUntilProcessed(db, deliveryId);

    const rows = await db
      .select()
      .from(comments)
      .where(eq(comments.platformCommentId, 'comment-shared-page'));
    expect(rows).toHaveLength(2);

    const rowForA = rows.find((row) => row.socialAccountId === accountA.socialAccountId);
    const rowForB = rows.find((row) => row.socialAccountId === accountB.socialAccountId);
    expect(rowForA).toMatchObject({
      workspaceId: accountA.workspaceId,
      text: 'seen by both workspaces',
    });
    expect(rowForB).toMatchObject({
      workspaceId: accountB.workspaceId,
      text: 'seen by both workspaces',
    });
    // Neither row is reachable under the other workspace — the dedup key
    // `UNIQUE (social_account_id, platform_comment_id)` keeps them as two distinct rows, not one
    // shared between workspaces, and a workspace-scoped read (any `WHERE workspace_id = ...`
    // query in the codebase) would see only its own.
    expect(rowForA?.workspaceId).not.toBe(rowForB?.workspaceId);
  });
});

/** Shared assertions for both `AuthError` cases below: `account_health` carries `auth_failed`,
 * the `account.auth_failed` outbox row exists, and the job completed on its first attempt (D30,
 * module docstring point 5 — the failure is recorded, not rethrown, so there is nothing to retry). */
async function expectAuthFailureRecorded(
  db: NodePgDatabase,
  webhookQueue: Queue,
  account: SeededAccount,
  deliveryId: string,
): Promise<void> {
  const [health] = await db
    .select()
    .from(accountHealth)
    .where(eq(accountHealth.socialAccountId, account.socialAccountId));
  expect(health).toMatchObject({ workspaceId: account.workspaceId, state: 'auth_failed' });

  const [outboxRow] = await db
    .select()
    .from(outboxEvents)
    .where(eq(outboxEvents.aggregateId, account.socialAccountId));
  expect(outboxRow).toMatchObject({
    workspaceId: account.workspaceId,
    type: 'account.auth_failed',
  });

  const job = await webhookQueue.getJob(deliveryId);
  expect(job?.attemptsMade).toBe(1);
}

describe('an undecryptable credential (D30, spec.md §18 "An undecryptable credential is an AuthError")', () => {
  it('records account_health + outbox, marks the delivery processed, does not retry, ingests nothing', async () => {
    const { db, webhookQueue } = harness;
    const account = await seedWorkspaceAndAccount(db, { credentialsKeyVersion: 999 });
    const deliveryId = await seedDelivery(
      db,
      pageFeedDelivery(account.platformAccountId, {
        item: 'comment',
        verb: 'add',
        comment_id: 'comment-undecryptable',
        post_id: POST_ID,
        message: 'never reaches ingestComments',
        from: { id: 'author-undecryptable' },
        created_time: 1_700_000_000,
      }),
    );

    await webhookQueue.add(JOB_NAMES.processDelivery, { deliveryId }, { jobId: deliveryId });
    await waitUntilProcessed(db, deliveryId);
    await expectAuthFailureRecorded(db, webhookQueue, account, deliveryId);

    const [row] = await db
      .select()
      .from(comments)
      .where(eq(comments.platformCommentId, 'comment-undecryptable'));
    expect(row).toBeUndefined();
  });
});

describe('the adapter rejecting the credential while completing a thin payload (401)', () => {
  it('records account_health + outbox, marks the delivery processed, does not retry, ingests nothing', async () => {
    server.use(
      http.get(`https://graph.facebook.com/${GRAPH_VERSION}/comment-unauthorized`, () =>
        HttpResponse.json({ error: { message: 'Invalid OAuth access token' } }, { status: 401 }),
      ),
    );

    const { db, webhookQueue } = harness;
    const account = await seedWorkspaceAndAccount(db);
    const payload = pageFeedDelivery(account.platformAccountId, {
      item: 'comment',
      verb: 'edited',
      comment_id: 'comment-unauthorized',
      post_id: POST_ID,
      from: { id: 'author-unauthorized' },
      created_time: 1_700_000_000,
    });
    const entry = payload['entry'] as [{ changes: [{ value: Record<string, unknown> }] }];
    delete entry[0].changes[0].value['message'];
    const deliveryId = await seedDelivery(db, payload);

    await webhookQueue.add(JOB_NAMES.processDelivery, { deliveryId }, { jobId: deliveryId });
    await waitUntilProcessed(db, deliveryId);
    await expectAuthFailureRecorded(db, webhookQueue, account, deliveryId);

    const [row] = await db
      .select()
      .from(comments)
      .where(eq(comments.platformCommentId, 'comment-unauthorized'));
    expect(row).toBeUndefined();
  });
});

interface MixedAccounts {
  readonly goodAccount: SeededAccount;
  readonly badAccount: SeededAccount;
}

/** One good account and one whose credential will not decrypt, sharing a `platformAccountId`. */
async function seedMixedAccounts(db: NodePgDatabase): Promise<MixedAccounts> {
  const sharedPlatformAccountId = `page-${generateId()}`;
  const goodAccount = await seedWorkspaceAndAccount(db, {
    platformAccountId: sharedPlatformAccountId,
  });
  const badAccount = await seedWorkspaceAndAccount(db, {
    platformAccountId: sharedPlatformAccountId,
    credentialsKeyVersion: 999,
  });
  return { goodAccount, badAccount };
}

describe('fan-out: one account’s AuthError does not abandon another account in the same delivery', () => {
  it('the good account still gets its comment row; the bad one is recorded and skipped', async () => {
    const { db, webhookQueue } = harness;
    const { goodAccount, badAccount } = await seedMixedAccounts(db);

    const deliveryId = await seedDelivery(
      db,
      pageFeedDelivery(goodAccount.platformAccountId, {
        item: 'comment',
        verb: 'add',
        comment_id: 'comment-one-bad-one-good',
        post_id: POST_ID,
        message: 'one workspace gets this, the other gets a recorded failure',
        from: { id: 'author-mixed' },
        created_time: 1_700_000_000,
      }),
    );

    await webhookQueue.add(JOB_NAMES.processDelivery, { deliveryId }, { jobId: deliveryId });
    await waitUntilProcessed(db, deliveryId);

    const rows = await db
      .select()
      .from(comments)
      .where(eq(comments.platformCommentId, 'comment-one-bad-one-good'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspaceId: goodAccount.workspaceId });

    const [health] = await db
      .select()
      .from(accountHealth)
      .where(eq(accountHealth.socialAccountId, badAccount.socialAccountId));
    expect(health).toMatchObject({ state: 'auth_failed' });

    const job = await webhookQueue.getJob(deliveryId);
    expect(job?.attemptsMade).toBe(1);
  });
});
