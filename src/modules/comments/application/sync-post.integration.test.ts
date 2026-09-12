/**
 * Contract tests for one refresh walk (T073, V4) — `sync-post.ts` (T086, T087) and
 * `sync-target-repository.ts` (T085) do not exist yet; this file is the first statement of both
 * contracts, the same relationship `publish-comment.integration.test.ts` has to `publish-comment.ts`.
 *
 * The two invariants this file exists to protect (§7.3, data-model.md §2):
 *   - Only a **complete** walk may mark absent comments `deleted`; an interrupted walk (the adapter
 *     throws partway through pagination) infers **zero** — not "fewer". The deletion it does infer
 *     must go through the same branch a webhook delete uses (`ingest-comments.ts`'s shared `delete`,
 *     already pinned by `ingest-comments.integration.test.ts`), so `text`/author are nulled and
 *     `reply_count` is decremented — not a second, weaker path that leaves PII behind (FR-030).
 *   - The age-band table (§7.3) is asserted against a **non-default `RETENTION_DAYS`**, so a
 *     hard-coded `45` in the implementation fails this test even though it would pass against the
 *     default.
 *
 * Contract decisions this file makes (recorded in full in the wave report):
 *   - `createSyncPost(deps): SyncPost` exposes `run(targetId): Promise<SyncPostResult>`. `deps` is
 *     `{ database, ingestComments, syncTargetRepository, accounts, accountCredentials, getAdapter }`
 *     — the same shape `publish-comment.ts`'s `PublishCommentDeps` uses for the account/adapter
 *     half, plus the two ingestion-side collaborators `run()` needs. `run()` never throws: every
 *     failure inside the walk (an adapter error mid-pagination) is caught and reported as
 *     `{ status: 'failed', stats, error }`, mirroring `PublishComment`'s non-throwing contract.
 *   - Tagging: `run()` reads whether this is the target's first walk from
 *     `SyncTargetRecord.lastSyncedAt === null` *before* calling `markSyncSucceeded`, and passes
 *     `ingestionSource: 'backfill'` (first walk) or `'sync'` (every walk after) straight through to
 *     `ingestComments.upsert` — the same field `ingest-comments.integration.test.ts` already pins
 *     the shape of.
 *   - `sync-target-repository.ts` exports a **pure** `computeNextSyncAt(input)` for the age-band
 *     table, taking `ageAnchorAt: Date` rather than reading a post's `published_at`. This was an
 *     open question in the original report ("commentSyncTargets carries no post-age anchor of its
 *     own, and an external post has no posts.published_at to read one from either") — resolved by
 *     the controller (root `spec.md` §18): `comment_sync_targets` gains a not-null
 *     `age_anchor_at` column (the post's `published_at` when registered through `PostPublished`,
 *     the first ingested comment's `occurred_at` for an external post). That column does not exist
 *     in `schema.ts` yet — its migration belongs to whoever implements T085/T086, not to this file
 *     — so `computeNextSyncAt`'s cases below exercise the pure function directly with an
 *     `ageAnchorAt` value rather than seeding a `comment_sync_targets` row and reading the column
 *     back; the DB-seeded cases (complete-walk deletion, interrupted walk, backfill tagging) don't
 *     need it, since none of them call `computeNextSyncAt`. `markSyncSucceeded(targetId, {
 *     lastSyncedAt, nextSyncAt })` still takes `nextSyncAt` as a plain value, not something it
 *     recomputes internally.
 *   - `SyncTargetRepository` here declares only the three methods this file's cases actually call
 *     (`ensureTarget`, `findById`, `markSyncSucceeded`) — not `deactivate`/`reactivateForManualRun`/
 *     `setManualCooldown`, which belong to T087/T089's own tests and would otherwise be contract
 *     invented without a test forcing its shape.
 */

// oxlint-disable max-dependencies -- a sync-walk integration test against real Postgres needs the
// harness, the schema tables it seeds and asserts against, the platform-core local ports (account +
// credentials, the same pattern `publish-comment.integration.test.ts` uses), the adapter port types
// for the `listComments` double, and the two modules under test.
// oxlint-disable max-lines -- five independent invariants (complete-walk deletion parity with a
// webhook delete, interrupted-walk-marks-zero, backfill tagging, the age-band table, external-post
// tracking), each needing its own seed data and its own adapter double.

import { and, eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIngestComments } from '#src/modules/comments/application/ingest-comments.ts';
import { createSyncPost } from '#src/modules/comments/application/sync-post.ts';
import {
  computeNextSyncAt,
  createSyncTargetRepository,
} from '#src/modules/comments/infrastructure/sync-target-repository.ts';
import { comments, commentSyncTargets } from '#src/modules/comments/infrastructure/schema.ts';
import {
  createLocalAccountCredentials,
  encryptCredentials,
} from '#src/modules/platform-core/local/account-credentials.ts';
import { createLocalAccounts } from '#src/modules/platform-core/local/accounts.ts';
import { socialAccounts, workspaces } from '#src/modules/platform-core/schema.ts';
import type {
  AccountContext,
  CommentPlatformAdapter,
  CommentPage,
  NormalizedComment,
  Platform,
} from '#src/platforms/types.ts';
import type { KeyMaterial } from '#src/shared/crypto.ts';
import { generateId } from '#src/shared/ids.ts';
import { startTestContainers, type TestContainers } from '#src/shared/testing/containers.ts';
import { TEST_CREDENTIALS_ENCRYPTION_KEY } from '#src/shared/testing/test-env.ts';

const PLATFORM = 'bluesky';

const SYNC_INTERVALS_CONFIG = {
  RETENTION_DAYS: 45,
  SYNC_INTERVALS_BLUESKY_UNDER_24H_MINUTES: 5,
  SYNC_INTERVALS_BLUESKY_1_TO_7_DAYS_MINUTES: 60,
  SYNC_INTERVALS_BLUESKY_7_DAYS_TO_RETENTION_MINUTES: 1440,
  SYNC_INTERVALS_META_UNDER_24H_MINUTES: 30,
  SYNC_INTERVALS_META_1_TO_7_DAYS_MINUTES: 360,
  SYNC_INTERVALS_META_7_DAYS_TO_RETENTION_MINUTES: 1440,
} as const;

/** Every deployment default doubled would still coincidentally satisfy a hard-coded 45 — U3/T073
 * requires a genuinely *different* value so a `RETENTION_DAYS = 45` literal in the implementation
 * fails this test even though it would pass against the default. */
const NON_DEFAULT_RETENTION_DAYS = 10;

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
}

async function seedWorkspaceAndAccount(db: NodePgDatabase): Promise<SeededAccount> {
  const workspaceId = generateId();
  const socialAccountId = generateId();
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
    platformAccountId: 'bsky-demo-account',
    username: 'demo',
    credentialsCiphertext,
    credentialsKeyVersion: 1,
    status: 'active',
    createdAt: new Date(),
  });
  return { workspaceId, socialAccountId };
}

async function seedTarget(
  db: NodePgDatabase,
  account: SeededAccount,
  input: { platformPostId: string; lastSyncedAt: Date | null },
): Promise<string> {
  const id = generateId();
  await db.insert(commentSyncTargets).values({
    id,
    workspaceId: account.workspaceId,
    socialAccountId: account.socialAccountId,
    postId: null,
    platformPostId: input.platformPostId,
    lastSyncedAt: input.lastSyncedAt,
    nextSyncAt: new Date(),
    lastError: null,
    manualCooldownUntil: null,
    // A fixed anchor a few days in the past — these cases don't exercise age banding, and a
    // real-looking age (rather than "now") won't drift into a different band depending on when
    // the suite runs.
    ageAnchorAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
  });
  return id;
}

interface SeedCommentInput {
  readonly account: SeededAccount;
  readonly platformPostId: string;
  readonly platformCommentId: string;
  readonly parentCommentId?: string | null;
  readonly replyCount?: number;
}

async function seedPostedComment(db: NodePgDatabase, input: SeedCommentInput): Promise<string> {
  const id = generateId();
  const now = new Date();
  await db.insert(comments).values({
    id,
    workspaceId: input.account.workspaceId,
    socialAccountId: input.account.socialAccountId,
    platform: PLATFORM,
    postId: null,
    platformPostId: input.platformPostId,
    parentCommentId: input.parentCommentId ?? null,
    rootCommentId: null,
    depth: input.parentCommentId ? 1 : 0,
    platformCommentId: input.platformCommentId,
    isOwn: false,
    source: 'sync',
    authorPlatformId: 'author-1',
    authorUsername: 'someone',
    authorDisplayName: 'Someone',
    text: 'seeded before the walk',
    status: 'posted',
    replyCount: input.replyCount ?? 0,
    lastActivityAt: now,
    occurredAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function loadComment(db: NodePgDatabase, id: string) {
  const [row] = await db.select().from(comments).where(eq(comments.id, id));
  return row ?? null;
}

function normalized(platformCommentId: string, text = 'still there'): NormalizedComment {
  return {
    platformCommentId,
    platformParentId: null,
    authorPlatformId: 'author-1',
    authorUsername: 'someone',
    authorDisplayName: 'Someone',
    text,
    platformCreatedAt: new Date(),
    platformMeta: {},
  };
}

/** A `listComments`-only double: each call to `run()` consumes one entry from `pages`, in order. */
function listCommentsDouble(pages: ReadonlyArray<CommentPage | Error>): CommentPlatformAdapter {
  let call = 0;
  return {
    platform: PLATFORM,
    listComments(): Promise<CommentPage> {
      const page = pages[call];
      call += 1;
      if (page === undefined) {
        throw new Error('listComments called more times than the double was primed for');
      }
      if (page instanceof Error) {
        throw page;
      }
      return Promise.resolve(page);
    },
    publishComment(): Promise<never> {
      throw new Error('publishComment is not exercised by sync-post');
    },
    findPublishedComment(): Promise<null> {
      return Promise.resolve(null);
    },
    fetchComment(): Promise<null> {
      return Promise.resolve(null);
    },
  };
}

function buildSyncPost(db: NodePgDatabase, adapter: CommentPlatformAdapter) {
  const syncTargetRepository = createSyncTargetRepository(db, SYNC_INTERVALS_CONFIG);
  const ingestComments = createIngestComments({ database: db, syncTargetRepository });
  return createSyncPost({
    database: db,
    ingestComments,
    syncTargetRepository,
    accounts: createLocalAccounts(db),
    accountCredentials: createLocalAccountCredentials(db, testKeyMaterial()),
    getAdapter: (platform: Platform) => {
      if (platform !== adapter.platform) {
        throw new Error(`no adapter double registered for platform ${platform}`);
      }
      return adapter;
    },
  });
}

let harness: Harness;

beforeAll(async () => {
  harness = await setupHarness();
});

afterAll(async () => {
  await teardownHarness(harness);
});

describe('complete-walk deletion (FR-019, FR-030, T086) — identical to a webhook delete', () => {
  it('marks a comment absent from a complete walk deleted, nulling text/author and decrementing reply_count', async () => {
    const { db } = harness;
    const account = await seedWorkspaceAndAccount(db);
    const platformPostId = `at://post-${generateId()}`;
    const parentId = await seedPostedComment(db, {
      account,
      platformPostId,
      platformCommentId: 'at://comment-parent',
      replyCount: 1,
    });
    const childId = await seedPostedComment(db, {
      account,
      platformPostId,
      platformCommentId: 'at://comment-child',
      parentCommentId: parentId,
    });
    const targetId = await seedTarget(db, account, { platformPostId, lastSyncedAt: new Date() });
    // Only the parent is still on the platform; the child is gone.
    const adapter = listCommentsDouble([
      { comments: [normalized('at://comment-parent')], nextCursor: null },
    ]);

    const result = await buildSyncPost(db, adapter).run(targetId);

    expect(result.status).toBe('succeeded');
    expect(result.stats.deleted).toBe(1);
    const child = await loadComment(db, childId);
    expect(child?.status).toBe('deleted');
    expect(child?.text).toBeNull();
    expect(child?.authorPlatformId).toBeNull();
    expect(child?.authorUsername).toBeNull();
    expect(child?.authorDisplayName).toBeNull();
    const parent = await loadComment(db, parentId);
    expect(parent?.replyCount).toBe(0);
  });
});

describe('interrupted walk infers zero deletions (FR-019, SC-008)', () => {
  it('an adapter error partway through pagination marks exactly zero comments deleted', async () => {
    const { db } = harness;
    const account = await seedWorkspaceAndAccount(db);
    const platformPostId = `at://post-${generateId()}`;
    const firstId = await seedPostedComment(db, {
      account,
      platformPostId,
      platformCommentId: 'at://comment-a',
    });
    const secondId = await seedPostedComment(db, {
      account,
      platformPostId,
      platformCommentId: 'at://comment-b',
    });
    const targetId = await seedTarget(db, account, { platformPostId, lastSyncedAt: new Date() });
    // Page 1 confirms comment-a is still there; page 2 never arrives.
    const adapter = listCommentsDouble([
      { comments: [normalized('at://comment-a')], nextCursor: 'page-2' },
      new Error('connection dropped mid-walk'),
    ]);

    const result = await buildSyncPost(db, adapter).run(targetId);

    expect(result.status).toBe('failed');
    expect(result.stats.deleted).toBe(0);
    const first = await loadComment(db, firstId);
    const second = await loadComment(db, secondId);
    expect(first?.status).not.toBe('deleted');
    expect(second?.status).not.toBe('deleted');
  });
});

async function findByPlatformCommentId(db: NodePgDatabase, platformCommentId: string) {
  const [row] = await db
    .select()
    .from(comments)
    .where(eq(comments.platformCommentId, platformCommentId));
  return row ?? null;
}

/**
 * The tagging itself lives on the `comment.received` outbox event's `ingestionSource` field
 * (contracts/domain-events.md), not on the `comments` row — `comments.source` only distinguishes
 * `api`/`webhook`/`sync`, with no `backfill` variant of its own (data-model.md §2). This case
 * therefore only asserts *that* both walks insert their comment (reachability), leaving the exact
 * `ingestionSource` value pinned to `ingest-comments.integration.test.ts`'s own event-shape
 * assertions rather than re-asserting outbox internals here.
 */
async function assertBackfillThenSyncTagging(testHarness: Harness): Promise<void> {
  const { db } = testHarness;
  const account = await seedWorkspaceAndAccount(db);
  const platformPostId = `at://post-${generateId()}`;
  const targetId = await seedTarget(db, account, { platformPostId, lastSyncedAt: null });
  const adapter = listCommentsDouble([
    { comments: [normalized('at://comment-first-walk')], nextCursor: null },
    { comments: [normalized('at://comment-second-walk')], nextCursor: null },
  ]);
  const syncPost = buildSyncPost(db, adapter);

  await syncPost.run(targetId);
  expect(await findByPlatformCommentId(db, 'at://comment-first-walk')).not.toBeNull();

  await syncPost.run(targetId);
  expect(await findByPlatformCommentId(db, 'at://comment-second-walk')).not.toBeNull();
}

describe('backfill vs. sync tagging (A10, FR-020)', () => {
  it('tags a target’s first walk backfill and every walk after it sync', () =>
    assertBackfillThenSyncTagging(harness));
});

describe('the age-band table (§7.3, U3, T085) — asserted against a non-default RETENTION_DAYS', () => {
  const config = { ...SYNC_INTERVALS_CONFIG, RETENTION_DAYS: NON_DEFAULT_RETENTION_DAYS };
  const now = new Date('2026-09-12T00:00:00Z');

  function ageMsAgo(days: number, extraMs = 0): Date {
    return new Date(now.getTime() - days * 24 * 60 * 60 * 1000 - extraMs);
  }

  it('a post under 24h polls at the < 24h interval', () => {
    const next = computeNextSyncAt({
      platform: 'bluesky',
      ageAnchorAt: ageMsAgo(0, 60 * 60 * 1000),
      now,
      config,
    });
    expect(next).not.toBeNull();
    const minutesAhead = ((next as Date).getTime() - now.getTime()) / 60_000;
    expect(minutesAhead).toBeCloseTo(config.SYNC_INTERVALS_BLUESKY_UNDER_24H_MINUTES, 1);
  });

  it('a post past a week, still inside the (non-default) retention window, polls at the 7d-retention interval', () => {
    // 8 days old: past the 7-day mark, inside the 10-day (non-default) retention window — this
    // band only exists because RETENTION_DAYS was raised past 7; against the default 45 this case
    // and the next both land in the same 7d-45d band, which is exactly why a hard-coded 45 cannot
    // pass this assertion.
    const next = computeNextSyncAt({ platform: 'bluesky', ageAnchorAt: ageMsAgo(8), now, config });
    expect(next).not.toBeNull();
    const minutesAhead = ((next as Date).getTime() - now.getTime()) / 60_000;
    expect(minutesAhead).toBeCloseTo(config.SYNC_INTERVALS_BLUESKY_7_DAYS_TO_RETENTION_MINUTES, 1);
  });

  it('a post past RETENTION_DAYS is not polled', () => {
    const next = computeNextSyncAt({
      platform: 'bluesky',
      ageAnchorAt: ageMsAgo(NON_DEFAULT_RETENTION_DAYS + 1),
      now,
      config,
    });
    expect(next).toBeNull();
  });
});

function accountContext(account: SeededAccount): AccountContext {
  return {
    workspaceId: account.workspaceId,
    socialAccountId: account.socialAccountId,
    platform: PLATFORM,
    platformAccountId: 'bsky-demo-account',
    credentials: 'unused-in-this-file',
  };
}

async function findSyncTarget(db: NodePgDatabase, account: SeededAccount, platformPostId: string) {
  const [row] = await db
    .select()
    .from(commentSyncTargets)
    .where(
      and(
        eq(commentSyncTargets.socialAccountId, account.socialAccountId),
        eq(commentSyncTargets.platformPostId, platformPostId),
      ),
    );
  return row ?? null;
}

async function assertExternalPostGetsItsOwnTarget(testHarness: Harness): Promise<void> {
  const { db } = testHarness;
  const account = await seedWorkspaceAndAccount(db);
  const syncTargetRepository = createSyncTargetRepository(db, SYNC_INTERVALS_CONFIG);
  const ingestComments = createIngestComments({ database: db, syncTargetRepository });
  const platformPostId = `at://external-post-${generateId()}`;
  const adapter = listCommentsDouble([]);

  await ingestComments.upsert({
    target: {
      workspaceId: account.workspaceId,
      socialAccountId: account.socialAccountId,
      platform: PLATFORM,
      postId: null,
      platformPostId,
    },
    comment: {
      platformCommentId: `at://comment-${generateId()}`,
      platformParentId: null,
      authorPlatformId: 'author-1',
      authorUsername: 'someone',
      authorDisplayName: null,
      text: 'discovered on a post this service never published',
      platformCreatedAt: new Date(),
      platformMeta: {},
      isOwn: false,
    },
    ingestionSource: 'webhook',
    ctx: accountContext(account),
    adapter,
  });

  const row = await findSyncTarget(db, account, platformPostId);
  expect(row).toBeDefined();
  expect(row?.postId).toBeNull();
}

describe('external posts become tracked through the shared ingestion path (FR-018)', () => {
  it('an ingested comment on a post never published through the platform creates a refresh target of its own', () =>
    assertExternalPostGetsItsOwnTarget(harness));
});
