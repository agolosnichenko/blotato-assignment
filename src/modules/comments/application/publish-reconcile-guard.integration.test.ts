/**
 * The reconciliation guard (`comments.needs_reconcile`, D14).
 *
 * `publish-comment.integration.test.ts` covers the failure matrix *within* one attempt. This file
 * covers the seam between attempts — the one the matrix cannot reach, because it opens when the
 * worker process disappears between the platform accepting a write and this service committing
 * `posted`. Nothing in memory or in Redis survives that; only the row does.
 *
 * The guard is what the stuck-work sweeper hands to the next attempt (`sweepers.ts`
 * `recoverStuckProcessingRow`), so these cases seed exactly what that sweeper leaves behind: a
 * `queued` row with `needs_reconcile = true` and `attempt_count` already advanced. The assertion
 * that matters in the first case is `sendsReceived() === 0` — the end state alone would look
 * identical if the service had published a second copy.
 */

// oxlint-disable max-dependencies -- an integration test seeds through the real schema and builds
// the real use case, so it imports both platform-core and comments tables plus every port
// `PublishComment` takes; the count reflects the use case's own fan-in, not an unfocused test.

import { eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublishComment } from '#src/modules/comments/application/publish-comment.ts';
import { createAccountHealth } from '#src/modules/comments/infrastructure/account-health.ts';
import { createCommentRepository } from '#src/modules/comments/infrastructure/comment-repository.ts';
import { createContactQuota } from '#src/modules/comments/infrastructure/contact-quota.ts';
import { comments } from '#src/modules/comments/infrastructure/schema.ts';
import {
  createLocalAccountCredentials,
  encryptCredentials,
} from '#src/modules/platform-core/local/account-credentials.ts';
import { createLocalAccounts } from '#src/modules/platform-core/local/accounts.ts';
import { createLocalWorkspaces } from '#src/modules/platform-core/local/workspaces.ts';
import { socialAccounts, workspaces } from '#src/modules/platform-core/schema.ts';
import {
  OutcomeUnknownError,
  type AccountContext,
  type CommentPlatformAdapter,
  type Platform,
  type PublishedComment,
  type PublishInput,
} from '#src/platforms/types.ts';
import { asWorkspaceId, generateId, type WorkspaceId } from '#src/shared/ids.ts';
import type { KeyMaterial } from '#src/shared/crypto.ts';
import { startTestContainers, type TestContainers } from '#src/shared/testing/containers.ts';
import { TEST_CREDENTIALS_ENCRYPTION_KEY } from '#src/shared/testing/test-env.ts';

const PLATFORM: Platform = 'bluesky';
const COMMENT_TEXT = 'a reply the customer only ever wrote once';

interface Harness {
  containers: TestContainers;
  pool: Pool;
  db: NodePgDatabase;
}

let harness: Harness;

function testKeyMaterial(): KeyMaterial {
  return { key: Buffer.from(TEST_CREDENTIALS_ENCRYPTION_KEY, 'base64'), keyVersion: 1 };
}

interface SeededAccount {
  readonly workspaceId: WorkspaceId;
  readonly socialAccountId: string;
  readonly platformAccountId: string;
}

async function seedWorkspaceAndAccount(db: NodePgDatabase): Promise<SeededAccount> {
  const workspaceId = asWorkspaceId(generateId());
  const socialAccountId = generateId();
  const platformAccountId = 'bsky-demo-account';
  const now = new Date();

  await db
    .insert(workspaces)
    .values({ id: workspaceId, name: 'guard', contactLimitMonthly: 1000, createdAt: now });
  await db.insert(socialAccounts).values({
    id: socialAccountId,
    workspaceId,
    platform: PLATFORM,
    platformAccountId,
    username: 'demo.bsky.social',
    credentialsCiphertext: encryptCredentials(Buffer.from('app-password'), testKeyMaterial()),
    credentialsKeyVersion: 1,
    status: 'active',
    createdAt: now,
  });

  return { workspaceId, socialAccountId, platformAccountId };
}

/** Seeds exactly what `recoverStuckProcessingRow` leaves behind for the next attempt. */
async function seedSweptRow(db: NodePgDatabase, account: SeededAccount): Promise<string> {
  const id = generateId();
  const now = new Date();
  // The earlier attempt started well before now; the reconciliation window has to reach back to it.
  const previousAttemptAt = new Date(now.getTime() - 6 * 60 * 1000);

  await db.insert(comments).values({
    id,
    workspaceId: account.workspaceId,
    socialAccountId: account.socialAccountId,
    platform: PLATFORM,
    postId: null,
    platformPostId: 'platform-post-1',
    parentCommentId: null,
    rootCommentId: null,
    depth: 0,
    platformCommentId: null,
    isOwn: true,
    source: 'api',
    authorPlatformId: account.platformAccountId,
    text: COMMENT_TEXT,
    status: 'queued',
    attemptCount: 1,
    lastAttemptStartedAt: previousAttemptAt,
    needsReconcile: true,
    replyCount: 0,
    lastActivityAt: now,
    occurredAt: now,
    createdAt: previousAttemptAt,
    updatedAt: now,
  });

  return id;
}

interface AdapterDouble {
  readonly adapter: CommentPlatformAdapter;
  sendsReceived(): number;
  findCalls(): number;
}

interface DoubleOptions {
  /** What a reconciliation search finds — the comment the lost attempt already published, or none. */
  readonly alreadyOnPlatform: boolean;
  /** Makes the search itself fail, modelling a platform that will not answer the question. */
  readonly searchFails?: boolean;
}

// oxlint-disable require-await -- an async port double with no real I/O
function createAdapterDouble(options: DoubleOptions): AdapterDouble {
  let sendsReceived = 0;
  let findCalls = 0;

  const adapter: CommentPlatformAdapter = {
    platform: PLATFORM,

    async listComments(): Promise<never> {
      throw new Error('listComments is not exercised by the publish flow');
    },

    async publishComment(_ctx: AccountContext, _input: PublishInput): Promise<PublishedComment> {
      sendsReceived += 1;
      return {
        platformCommentId: `platform-comment-${sendsReceived}`,
        platformCreatedAt: new Date(),
      };
    },

    async findPublishedComment(): Promise<PublishedComment | null> {
      findCalls += 1;
      if (options.searchFails === true) {
        throw new OutcomeUnknownError('the platform would not answer the reconciliation read');
      }
      return options.alreadyOnPlatform
        ? { platformCommentId: 'platform-comment-from-lost-attempt', platformCreatedAt: new Date() }
        : null;
    },

    async fetchComment(): Promise<null> {
      throw new Error('fetchComment is not exercised by the publish flow');
    },
  };

  return { adapter, sendsReceived: () => sendsReceived, findCalls: () => findCalls };
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
    getAdapter: () => adapter,
  });
}

async function loadComment(db: NodePgDatabase, id: string) {
  const [row] = await db.select().from(comments).where(eq(comments.id, id));
  return row ?? null;
}

beforeAll(async () => {
  const containers = await startTestContainers();
  const pool = new Pool({ connectionString: containers.databaseUrl });
  harness = { containers, pool, db: drizzle(pool) };
});

afterAll(async () => {
  await harness.pool.end();
  await harness.containers.stop();
});

describe('a row the sweeper requeued after a worker died mid-send', () => {
  it('adopts the comment the lost attempt published instead of publishing a second one', async () => {
    const { db } = harness;
    const account = await seedWorkspaceAndAccount(db);
    const commentId = await seedSweptRow(db, account);
    const double = createAdapterDouble({ alreadyOnPlatform: true });

    const outcome = await buildPublishComment(db, double.adapter).publish(commentId);

    // The load-bearing assertion: the customer's reply reached the platform exactly once, and the
    // once was the attempt this service lost track of.
    expect(double.sendsReceived()).toBe(0);
    expect(double.findCalls()).toBe(1);
    expect(outcome).toEqual({ kind: 'posted' });

    const row = await loadComment(db, commentId);
    expect(row?.status).toBe('posted');
    expect(row?.platformCommentId).toBe('platform-comment-from-lost-attempt');
    expect(row?.needsReconcile).toBe(false);
  });

  it('sends once, and only once, when the search proves nothing was published', async () => {
    const { db } = harness;
    const account = await seedWorkspaceAndAccount(db);
    const commentId = await seedSweptRow(db, account);
    const double = createAdapterDouble({ alreadyOnPlatform: false });

    const outcome = await buildPublishComment(db, double.adapter).publish(commentId);

    expect(double.findCalls()).toBe(1);
    expect(double.sendsReceived()).toBe(1);
    expect(outcome).toEqual({ kind: 'posted' });

    const row = await loadComment(db, commentId);
    expect(row?.status).toBe('posted');
    expect(row?.needsReconcile).toBe(false);
  });
});

describe('a reconciliation search that cannot answer', () => {
  it('keeps the guard armed rather than letting the next attempt send blind', async () => {
    const { db } = harness;
    const account = await seedWorkspaceAndAccount(db);
    const commentId = await seedSweptRow(db, account);
    const double = createAdapterDouble({ alreadyOnPlatform: true, searchFails: true });

    const outcome = await buildPublishComment(db, double.adapter).publish(commentId);

    expect(double.sendsReceived()).toBe(0);
    expect(outcome).toMatchObject({ kind: 'retry' });

    const row = await loadComment(db, commentId);
    expect(row?.status).toBe('queued');
    // Still unknown, so the next attempt must ask again rather than send.
    expect(row?.needsReconcile).toBe(true);
  });
});

describe('an ordinary first attempt', () => {
  it('arms the guard before sending and clears it on success', async () => {
    const { db } = harness;
    const account = await seedWorkspaceAndAccount(db);
    const commentId = await seedSweptRow(db, account);
    // A fresh comment: no earlier attempt, so nothing to reconcile against.
    await db.update(comments).set({ needsReconcile: false }).where(eq(comments.id, commentId));
    const double = createAdapterDouble({ alreadyOnPlatform: false });

    const outcome = await buildPublishComment(db, double.adapter).publish(commentId);

    // No reconciliation read is paid for on the happy path.
    expect(double.findCalls()).toBe(0);
    expect(double.sendsReceived()).toBe(1);
    expect(outcome).toEqual({ kind: 'posted' });
    expect((await loadComment(db, commentId))?.needsReconcile).toBe(false);
  });
});
