/**
 * The publish failure matrix (T051) — the strongest test in this feature.
 *
 * SC-001 / FR-011 are the load-bearing claim of the whole design: a customer-authored reply
 * reaches the platform exactly once, across every way the publish attempt can go wrong. This file
 * is the first statement of `PublishComment`'s contract (T060/T060a/T061/T062 — `plan.md` names it
 * `PublishComment` and `ReconcileComment`; here the latter is reached only through the former, as
 * `publish()` is the one entry point a worker calls).
 *
 * The instrument that makes the matrix mean something is {@link createAdapterDouble}: every case
 * asserts not only the comment's final local state but how many times `publishComment` actually
 * reached the double, and — for the two `OutcomeUnknownError` cases — how many times
 * `findPublishedComment` was consulted. A test that checks only the end state would pass just as
 * happily if the service published the reply twice and the second write overwrote the first.
 *
 * Contract decisions this test file makes, because the design documents state the behaviour but
 * not the exact shapes (recorded in full in the wave report):
 *   - `createPublishComment(deps)` returns `{ publish(commentId): Promise<void> }`. `deps` are the
 *     ports and the `CommentRepository` (T056) — `markProcessing`, `markPosted`, `markFailed`,
 *     `markQueuedForRetry` are T056's own names; `findById` is this file's addition, needed for the
 *     T060a parent recheck.
 *   - `createContactQuota(db, workspaces)` exposes `release(commentId): Promise<void>` (T057);
 *     `reserve` is exercised by `create-reply.integration.test.ts` (T053), not here — this file
 *     seeds `contact_quota_usage` directly, per w6-common's "seed through the repository or a
 *     direct insert, whichever makes the test's intent clearest". `workspaces` is required by the
 *     constructor even though this file's `release`-only usage never reads it (T057, w8-1 report).
 *   - `getAdapter: (platform: Platform) => CommentPlatformAdapter` is `PublishComment`'s only way
 *     to reach a platform adapter; the real per-platform wiring is T063's job.
 *   - The webhook-echo race (§7.1 step 7) is asserted purely at the end state `publish()` leaves
 *     behind — this file makes no claim about which repository method inside `publish-comment.ts`
 *     catches the unique-index collision.
 */

// oxlint-disable max-dependencies -- the matrix exercises every port `PublishComment` depends on
// (repository, contact quota, accounts, credentials, account health, the adapter) plus the schema
// tables needed to seed and assert against them; splitting the file would not reduce that, only
// hide it behind re-exports.
// oxlint-disable max-lines -- eight independent failure-matrix cases (T051), each needing its own
// seed data and its own adapter double, cannot be split across files without either sharing
// mutable fixtures (blurring which case broke) or duplicating the seeding and assertion helpers.

import { eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublishComment } from '#src/modules/comments/application/publish-comment.ts';
import type { CommentStatus } from '#src/modules/comments/domain/status.ts';
import { createAccountHealth } from '#src/modules/comments/infrastructure/account-health.ts';
import { createCommentRepository } from '#src/modules/comments/infrastructure/comment-repository.ts';
import { createContactQuota } from '#src/modules/comments/infrastructure/contact-quota.ts';
import {
  accountHealth,
  comments,
  contactQuotaUsage,
  outboxEvents,
} from '#src/modules/comments/infrastructure/schema.ts';
import {
  createLocalAccountCredentials,
  encryptCredentials,
} from '#src/modules/platform-core/local/account-credentials.ts';
import { createLocalAccounts } from '#src/modules/platform-core/local/accounts.ts';
import { createLocalWorkspaces } from '#src/modules/platform-core/local/workspaces.ts';
import { socialAccounts, workspaces } from '#src/modules/platform-core/schema.ts';
import {
  AuthError,
  OutcomeUnknownError,
  PermanentError,
  RetryableError,
  type AccountContext,
  type CommentPlatformAdapter,
  type Platform,
  type PublishedComment,
  type PublishInput,
} from '#src/platforms/types.ts';
import { generateId } from '#src/shared/ids.ts';
import type { KeyMaterial } from '#src/shared/crypto.ts';
import { startTestContainers, type TestContainers } from '#src/shared/testing/containers.ts';
import { TEST_CREDENTIALS_ENCRYPTION_KEY } from '#src/shared/testing/test-env.ts';

const PLATFORM: Platform = 'bluesky';

function testKeyMaterial(): KeyMaterial {
  return { key: Buffer.from(TEST_CREDENTIALS_ENCRYPTION_KEY, 'base64'), keyVersion: 1 };
}

interface Harness {
  containers: TestContainers;
  pool: Pool;
  db: NodePgDatabase;
}

async function setupHarness(): Promise<Harness> {
  const containers = await startTestContainers();
  const pool = new Pool({ connectionString: containers.databaseUrl });
  const db = drizzle(pool);
  return { containers, pool, db };
}

async function teardownHarness(harness: Harness): Promise<void> {
  await harness.pool.end();
  await harness.containers.stop();
}

interface SeededAccount {
  readonly workspaceId: string;
  readonly socialAccountId: string;
  readonly platformAccountId: string;
}

interface SeedWorkspaceAndAccountOptions {
  /**
   * Mismatches the stored column against `testKeyMaterial()`'s real `keyVersion: 1` to force a
   * deterministic `KeyVersionMismatchError` inside `decrypt` — real ciphertext, wrong declared
   * version, no need to corrupt any bytes (mirrors `webhook-worker.integration.test.ts`'s own
   * `seedWorkspaceAndAccount`, same reasoning).
   */
  readonly credentialsKeyVersion?: number;
}

async function seedWorkspaceAndAccount(
  db: NodePgDatabase,
  options: SeedWorkspaceAndAccountOptions = {},
): Promise<SeededAccount> {
  const workspaceId = generateId();
  const socialAccountId = generateId();
  const platformAccountId = 'bsky-demo-account';

  await db.insert(workspaces).values({
    id: workspaceId,
    name: 'Test workspace',
    contactLimitMonthly: 100,
    createdAt: new Date(),
  });

  const credentialsCiphertext = encryptCredentials(Buffer.from('app-password'), testKeyMaterial());

  await db.insert(socialAccounts).values({
    id: socialAccountId,
    workspaceId,
    platform: PLATFORM,
    platformAccountId,
    username: 'demo',
    credentialsCiphertext,
    credentialsKeyVersion: options.credentialsKeyVersion ?? 1,
    status: 'active',
    createdAt: new Date(),
  });

  return { workspaceId, socialAccountId, platformAccountId };
}

interface SeedCommentOptions {
  readonly workspaceId: string;
  readonly socialAccountId: string;
  readonly status?: CommentStatus;
  readonly parentCommentId?: string | null;
  readonly rootCommentId?: string | null;
  readonly platformCommentId?: string | null;
  readonly text?: string;
  readonly authorPlatformId?: string;
  readonly source?: string;
  readonly isOwn?: boolean;
}

async function seedComment(db: NodePgDatabase, opts: SeedCommentOptions): Promise<string> {
  const id = generateId();
  const now = new Date();
  const depth = opts.parentCommentId ? 1 : 0;

  await db.insert(comments).values({
    id,
    workspaceId: opts.workspaceId,
    socialAccountId: opts.socialAccountId,
    platform: PLATFORM,
    postId: null,
    platformPostId: 'platform-post-1',
    parentCommentId: opts.parentCommentId ?? null,
    rootCommentId: opts.parentCommentId ? (opts.rootCommentId ?? opts.parentCommentId) : null,
    depth,
    platformCommentId: opts.platformCommentId ?? null,
    isOwn: opts.isOwn ?? true,
    source: opts.source ?? 'api',
    authorPlatformId: opts.authorPlatformId ?? 'bsky-demo-account',
    text: opts.text ?? 'hello from the customer',
    status: opts.status ?? 'queued',
    attemptCount: 0,
    lastAttemptStartedAt: null,
    replyCount: 0,
    lastActivityAt: now,
    occurredAt: now,
    createdAt: now,
    updatedAt: now,
  });

  return id;
}

async function insertQuotaReservation(
  db: NodePgDatabase,
  input: { workspaceId: string; commentId: string; contactPlatformId: string },
): Promise<void> {
  await db.insert(contactQuotaUsage).values({
    workspaceId: input.workspaceId,
    period: '2026-09',
    platform: PLATFORM,
    contactPlatformId: input.contactPlatformId,
    commentId: input.commentId,
    createdAt: new Date(),
  });
}

/** A `deleted` parent with a `queued` reply on it — the T060a setup for every case that needs one. */
async function seedDeletedParentWithQueuedChild(
  db: NodePgDatabase,
  account: SeededAccount,
): Promise<{ parentId: string; childId: string }> {
  const parentId = await seedComment(db, {
    ...account,
    status: 'deleted',
    platformCommentId: 'p1',
  });
  const childId = await seedComment(db, {
    ...account,
    status: 'queued',
    parentCommentId: parentId,
  });
  return { parentId, childId };
}

async function quotaRowExists(db: NodePgDatabase, commentId: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(contactQuotaUsage)
    .where(eq(contactQuotaUsage.commentId, commentId));
  return rows.length > 0;
}

async function loadComment(db: NodePgDatabase, id: string) {
  const [row] = await db.select().from(comments).where(eq(comments.id, id));
  return row ?? null;
}

function outboxRowsFor(db: NodePgDatabase, aggregateId: string, type: string) {
  return db
    .select()
    .from(outboxEvents)
    .where(eq(outboxEvents.aggregateId, aggregateId))
    .then((rows) => rows.filter((row) => row.type === type));
}

/**
 * Every outcome `publishComment` can produce, expressed so the double can distinguish "the
 * request reached me" from "it never did" (see the module docstring). `outcome-unknown-found` and
 * `outcome-unknown-not-found` both throw {@link OutcomeUnknownError}, but only the first actually
 * records a comment on the double — modelling a lost response after a real write, versus a
 * connection dropped before the write ever landed.
 */
type AdapterOutcome =
  | { readonly kind: 'success' }
  | { readonly kind: 'retryable'; readonly retryAfter?: number }
  | { readonly kind: 'outcome-unknown-found' }
  | { readonly kind: 'outcome-unknown-not-found' }
  | { readonly kind: 'permanent' }
  | { readonly kind: 'auth-error' }
  | { readonly kind: 'webhook-echo'; readonly platformCommentId: string };

interface AdapterDouble {
  readonly adapter: CommentPlatformAdapter;
  /** Calls to `publishComment` where the request is modelled as having reached the platform. */
  sendsReceived(): number;
  findCalls(): number;
  receivedInputs(): readonly PublishInput[];
}

interface OutcomeState {
  sendsReceived: number;
  readonly stored: PublishedComment[];
}

/**
 * Applies one {@link AdapterOutcome}, mutating `state` exactly the way a real platform call would:
 * `sendsReceived` only advances when the request is modelled as having reached the platform, and
 * `stored` only grows when the platform actually created something a later `findPublishedComment`
 * could discover.
 */
function applyOutcome(outcome: AdapterOutcome, state: OutcomeState): PublishedComment {
  switch (outcome.kind) {
    case 'success':
    case 'webhook-echo': {
      state.sendsReceived += 1;
      const platformCommentId =
        outcome.kind === 'webhook-echo'
          ? outcome.platformCommentId
          : `platform-comment-${state.sendsReceived}`;
      const published: PublishedComment = { platformCommentId, platformCreatedAt: new Date() };
      state.stored.push(published);
      return published;
    }
    case 'retryable':
      // Nothing reached the platform — a retry cannot duplicate anything.
      throw new RetryableError(
        'rate limited',
        outcome.retryAfter === undefined ? {} : { retryAfter: outcome.retryAfter },
      );
    case 'outcome-unknown-found':
      // The write actually landed; only the response was lost.
      state.sendsReceived += 1;
      state.stored.push({
        platformCommentId: `platform-comment-${state.sendsReceived}`,
        platformCreatedAt: new Date(),
      });
      throw new OutcomeUnknownError('connection dropped after the write landed');
    case 'outcome-unknown-not-found':
      // The request reached the platform but the connection died before it committed.
      state.sendsReceived += 1;
      throw new OutcomeUnknownError('timed out waiting for a response');
    case 'permanent':
      state.sendsReceived += 1;
      throw new PermanentError('the platform rejected the comment');
    case 'auth-error':
      throw new AuthError('the stored credential is no longer valid');
  }
}

// oxlint-disable require-await -- this double implements an async port with no real I/O; every
// method either throws synchronously or returns a value already in hand.
function createAdapterDouble(outcome: AdapterOutcome): AdapterDouble {
  const state: OutcomeState = { sendsReceived: 0, stored: [] };
  let findCalls = 0;
  const receivedInputs: PublishInput[] = [];

  const adapter: CommentPlatformAdapter = {
    platform: PLATFORM,

    async listComments(): Promise<never> {
      throw new Error('listComments is not exercised by the publish flow');
    },

    async publishComment(_ctx: AccountContext, input: PublishInput): Promise<PublishedComment> {
      receivedInputs.push(input);
      return applyOutcome(outcome, state);
    },

    async findPublishedComment(): Promise<PublishedComment | null> {
      findCalls += 1;
      return state.stored.at(0) ?? null;
    },

    async fetchComment(): Promise<null> {
      throw new Error('fetchComment is not exercised by the publish flow');
    },
  };

  return {
    adapter,
    sendsReceived: () => state.sendsReceived,
    findCalls: () => findCalls,
    receivedInputs: () => receivedInputs,
  };
}
// oxlint-enable require-await

function buildPublishComment(db: NodePgDatabase, adapter: CommentPlatformAdapter) {
  return createPublishComment({
    database: db,
    commentRepository: createCommentRepository(db),
    contactQuota: createContactQuota(db, createLocalWorkspaces(db)),
    accounts: createLocalAccounts(db),
    accountCredentials: createLocalAccountCredentials(db, testKeyMaterial()),
    accountHealth: createAccountHealth(db),
    getAdapter: (platform: Platform) => {
      if (platform !== adapter.platform) {
        throw new Error(`no adapter double registered for platform ${platform}`);
      }
      return adapter;
    },
  });
}

async function selectSocialAccountRow(db: NodePgDatabase, socialAccountId: string) {
  const [row] = await db
    .select()
    .from(socialAccounts)
    .where(eq(socialAccounts.id, socialAccountId));
  return row;
}

async function expectFailedWithCode(db: NodePgDatabase, id: string, code: string): Promise<void> {
  const row = await loadComment(db, id);
  expect(row?.status).toBe('failed');
  expect(row?.errorCode).toBe(code);
}

async function expectAccountEffectivelyDisconnected(
  db: NodePgDatabase,
  socialAccountId: string,
): Promise<void> {
  const effective = await createLocalAccounts(db).findById(socialAccountId);
  expect(effective).toEqual({
    found: true,
    value: expect.objectContaining({ status: 'disconnected' }),
  });
}

let harness: Harness;

beforeAll(async () => {
  harness = await setupHarness();
});

afterAll(async () => {
  await teardownHarness(harness);
});

describe('success and retryable-before-send (SC-001)', () => {
  it('success: posts once, records the exact input sent, no reconciliation needed', async () => {
    const { db } = harness;
    const account = await seedWorkspaceAndAccount(db);
    const commentId = await seedComment(db, account);
    await insertQuotaReservation(db, {
      workspaceId: account.workspaceId,
      commentId,
      contactPlatformId: 'audience-member-1',
    });
    const double = createAdapterDouble({ kind: 'success' });

    await buildPublishComment(db, double.adapter).publish(commentId);

    const row = await loadComment(db, commentId);
    expect(row?.status).toBe('posted');
    expect(row?.platformCommentId).toBe('platform-comment-1');
    expect(double.sendsReceived()).toBe(1);
    expect(double.findCalls()).toBe(0);
    expect(double.receivedInputs()).toEqual([
      {
        platformPostId: 'platform-post-1',
        platformParentId: null,
        text: 'hello from the customer',
      },
    ]);
    expect(await outboxRowsFor(db, commentId, 'comment.posted')).toHaveLength(1);
    // Success releases nothing — the reservation stands for the rest of the period.
    expect(await quotaRowExists(db, commentId)).toBe(true);
  });

  it('429 with Retry-After: retryable before the request reached the platform', async () => {
    const { db } = harness;
    const account = await seedWorkspaceAndAccount(db);
    const commentId = await seedComment(db, account);
    const double = createAdapterDouble({ kind: 'retryable', retryAfter: 30 });

    await buildPublishComment(db, double.adapter).publish(commentId);

    const row = await loadComment(db, commentId);
    expect(row?.status).toBe('queued');
    expect(row?.attemptCount).toBe(1);
    // Nothing reached the platform, so there is nothing to reconcile.
    expect(double.sendsReceived()).toBe(0);
    expect(double.findCalls()).toBe(0);
    expect(await outboxRowsFor(db, commentId, 'comment.posted')).toHaveLength(0);
    expect(await outboxRowsFor(db, commentId, 'comment.failed')).toHaveLength(0);
  });
});

describe('reconciliation after an unknown outcome (D14, T061)', () => {
  it('timeout after send: reconciliation finds the write — settles posted, no second send', async () => {
    const { db } = harness;
    const account = await seedWorkspaceAndAccount(db);
    const commentId = await seedComment(db, account);
    const double = createAdapterDouble({ kind: 'outcome-unknown-found' });

    await buildPublishComment(db, double.adapter).publish(commentId);

    const row = await loadComment(db, commentId);
    expect(row?.status).toBe('posted');
    expect(row?.platformCommentId).toBe('platform-comment-1');
    // Exactly one send reached the double, and reconciliation — not a second send — is what
    // resolved the outcome.
    expect(double.sendsReceived()).toBe(1);
    expect(double.findCalls()).toBe(1);
    expect(await outboxRowsFor(db, commentId, 'comment.posted')).toHaveLength(1);
  });

  it('connection drop after send: reconciliation finds nothing — retries, no second send', async () => {
    const { db } = harness;
    const account = await seedWorkspaceAndAccount(db);
    const commentId = await seedComment(db, account);
    const double = createAdapterDouble({ kind: 'outcome-unknown-not-found' });

    await buildPublishComment(db, double.adapter).publish(commentId);

    const row = await loadComment(db, commentId);
    expect(row?.status).toBe('queued');
    expect(double.sendsReceived()).toBe(1);
    expect(double.findCalls()).toBe(1);
    // The reconciliation search came back empty, so this must not be a second send in the same
    // call — the only safe move is to hand it back to the retry path.
    expect(await outboxRowsFor(db, commentId, 'comment.posted')).toHaveLength(0);
    expect(await outboxRowsFor(db, commentId, 'comment.failed')).toHaveLength(0);
  });
});

describe('terminal failures (FR-012, FR-014, D30, T060a)', () => {
  it('permanent rejection: fails, releases the quota reservation, never retries', async () => {
    const { db } = harness;
    const account = await seedWorkspaceAndAccount(db);
    const commentId = await seedComment(db, account);
    await insertQuotaReservation(db, {
      workspaceId: account.workspaceId,
      commentId,
      contactPlatformId: 'audience-member-2',
    });
    const double = createAdapterDouble({ kind: 'permanent' });

    await buildPublishComment(db, double.adapter).publish(commentId);

    await expectFailedWithCode(db, commentId, 'PLATFORM_REJECTED');
    expect(double.sendsReceived()).toBe(1);
    expect(double.findCalls()).toBe(0);
    expect(await quotaRowExists(db, commentId)).toBe(false);
    expect(await outboxRowsFor(db, commentId, 'comment.failed')).toHaveLength(1);
  });

  it('parent deleted after queueing: fails with PARENT_DELETED, nothing sent (T060a)', async () => {
    const { db } = harness;
    const account = await seedWorkspaceAndAccount(db);
    const { childId } = await seedDeletedParentWithQueuedChild(db, account);
    await insertQuotaReservation(db, {
      workspaceId: account.workspaceId,
      commentId: childId,
      contactPlatformId: 'audience-member-4',
    });
    const double = createAdapterDouble({ kind: 'success' });

    await buildPublishComment(db, double.adapter).publish(childId);

    await expectFailedWithCode(db, childId, 'PARENT_DELETED');
    // The pre-flight check at acceptance time cannot see a deletion that happened after —
    // the adapter must never be reached at all.
    expect(double.sendsReceived()).toBe(0);
    expect(await quotaRowExists(db, childId)).toBe(false);
    expect(await outboxRowsFor(db, childId, 'comment.failed')).toHaveLength(1);
  });
});

describe('AuthError: account_health, not social_accounts (D30, A19)', () => {
  it('fails, records account_health, emits account.auth_failed, leaves social_accounts untouched', async () => {
    const { db } = harness;
    const account = await seedWorkspaceAndAccount(db);
    const commentId = await seedComment(db, account);
    await insertQuotaReservation(db, {
      workspaceId: account.workspaceId,
      commentId,
      contactPlatformId: 'audience-member-3',
    });
    const rawAccountBefore = await selectSocialAccountRow(db, account.socialAccountId);
    const double = createAdapterDouble({ kind: 'auth-error' });

    await buildPublishComment(db, double.adapter).publish(commentId);

    await expectFailedWithCode(db, commentId, 'PLATFORM_AUTH_FAILED');
    expect(await quotaRowExists(db, commentId)).toBe(false);
    expect(await outboxRowsFor(db, commentId, 'comment.failed')).toHaveLength(1);
    expect(await outboxRowsFor(db, account.socialAccountId, 'account.auth_failed')).toHaveLength(1);

    const [healthRow] = await db
      .select()
      .from(accountHealth)
      .where(eq(accountHealth.socialAccountId, account.socialAccountId));
    expect(healthRow).toMatchObject({
      socialAccountId: account.socialAccountId,
      state: 'auth_failed',
    });
    await expectAccountEffectivelyDisconnected(db, account.socialAccountId);

    // The literal instruction from the brief: compare the whole row, not one column — D30
    // exists precisely because a write to any other column here would also be a boundary
    // violation, and a narrower assertion would not notice it.
    const rawAccountAfter = await selectSocialAccountRow(db, account.socialAccountId);
    expect(rawAccountAfter).toEqual(rawAccountBefore);
  });
});

describe('AuthError from loadAccountContext itself (D30, an undecryptable credential)', () => {
  it('settles failed via settleAuthFailed, records account_health, never reaches the adapter', async () => {
    const { db } = harness;
    const account = await seedWorkspaceAndAccount(db, { credentialsKeyVersion: 999 });
    const commentId = await seedComment(db, account);
    // Never settled on ('success' is simplest) — the point of this case is that `attemptSend`'s
    // first `catch`, around `loadAccountContext`, must settle this before the adapter is ever
    // reached; `sendsReceived()` below is this test's proof that it really didn't.
    const double = createAdapterDouble({ kind: 'success' });

    await buildPublishComment(db, double.adapter).publish(commentId);

    await expectFailedWithCode(db, commentId, 'PLATFORM_AUTH_FAILED');
    expect(double.sendsReceived()).toBe(0);
    expect(await outboxRowsFor(db, account.socialAccountId, 'account.auth_failed')).toHaveLength(1);

    const [healthRow] = await db
      .select()
      .from(accountHealth)
      .where(eq(accountHealth.socialAccountId, account.socialAccountId));
    expect(healthRow).toMatchObject({
      socialAccountId: account.socialAccountId,
      state: 'auth_failed',
    });
  });
});

describe('the webhook-echo race (§7.1 step 7)', () => {
  it('ingestion wins first: worker deletes the duplicate and promotes itself, exactly one send', async () => {
    const { db } = harness;
    const account = await seedWorkspaceAndAccount(db);
    const apiCreatedId = await seedComment(db, { ...account, status: 'queued' });
    const echoedPlatformCommentId = 'echoed-platform-comment';

    // Ingestion beat the worker to it: our own reply arrived back through the webhook path and
    // was inserted as an already-`posted` comment before the worker's `UPDATE` runs.
    const ingestedDuplicateId = await seedComment(db, {
      ...account,
      status: 'posted',
      source: 'webhook',
      platformCommentId: echoedPlatformCommentId,
    });
    await db.insert(outboxEvents).values({
      id: generateId(),
      workspaceId: account.workspaceId,
      type: 'comment.received',
      aggregateId: ingestedDuplicateId,
      payload: { commentId: ingestedDuplicateId },
      createdAt: new Date(),
      publishedAt: null,
    });
    const double = createAdapterDouble({
      kind: 'webhook-echo',
      platformCommentId: echoedPlatformCommentId,
    });

    await buildPublishComment(db, double.adapter).publish(apiCreatedId);

    // Exactly one row now claims that platform identifier.
    const survivors = await db
      .select()
      .from(comments)
      .where(eq(comments.platformCommentId, echoedPlatformCommentId));
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.id).toBe(apiCreatedId);
    expect(survivors[0]?.status).toBe('posted');
    expect(await loadComment(db, ingestedDuplicateId)).toBeNull();
    // The still-unpublished `comment.received` row for the deleted duplicate must not survive —
    // relaying it would announce a comment nobody can ever read.
    expect(await outboxRowsFor(db, ingestedDuplicateId, 'comment.received')).toHaveLength(0);
    expect(double.sendsReceived()).toBe(1);
  });
});
