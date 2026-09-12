/**
 * Contract tests for the shared ingestion upsert path (T071, V4) — `ingest-comments.ts` does not
 * exist yet (T076, T077); this file is the first statement of its contract, the same relationship
 * `publish-comment.integration.test.ts` has to `publish-comment.ts`.
 *
 * FR-017 / SC-003's whole claim is that push (webhook) and refresh (sync) share **one** upsert
 * target: `UNIQUE (social_account_id, platform_comment_id)`. So every case here counts the
 * `comment.received` outbox rows, not only the `comments` rows — a second notification for a
 * comment the consumer already knows about is the user-visible half of the bug (see T103, which
 * later breaks the dedup index specifically to prove this file screams).
 *
 * Contract decisions this file makes, because data-model.md and spec.md §7.2/§7.3 state the
 * behaviour but not the exact shapes (recorded in full in the wave report):
 *   - `createIngestComments(deps): IngestComments` exposes `upsert(input)` and `delete(input)`.
 *     `deps` is `{ database, syncTargetRepository }` — no `CommentRepository`, since ingestion
 *     writes comments already `posted` or moves `posted -> deleted` (both legal in
 *     `domain/status.ts`), neither of which is the API-write state machine
 *     `CommentRepository`'s write side encodes; `publish-comment.ts` sets the same precedent of
 *     querying `comments` directly rather than forcing every caller through one repository.
 *   - `IngestedComment.text` is `string | undefined`, not `NormalizedComment`'s non-optional
 *     `string` — a thin webhook payload is a distinct input shape from a full listing read, and
 *     `upsert` itself calls `adapter.fetchComment` to complete it (A18) when `text` is absent,
 *     before ever writing a row. This is also why `upsert` takes `ctx`/`adapter` directly rather
 *     than a `getAdapter(platform)` factory: T077's ancestor walk needs the same two for however
 *     many `fetchComment` calls the chain takes, and threading a factory through for that would
 *     only reconstruct what the caller already resolved once.
 *   - `upsert` also owns FR-018's "the only way an external post becomes tracked": when
 *     `target.postId` is `null`, it calls `syncTargetRepository.ensureTarget(...)` unconditionally
 *     (idempotent, `ON CONFLICT DO NOTHING`) rather than gating on "is this genuinely the first
 *     comment" — data-model.md's wording is about the *effect* (an external post ends up tracked),
 *     not a one-shot trigger. `sync-post.integration.test.ts` (T073) exercises this from the sync
 *     side of the same shared function.
 *   - `delete` takes `{ workspaceId, socialAccountId, platform, platformCommentId }` and returns
 *     `{ wasDeleted: boolean }` — `false` when no local row matches, mirroring `CommentRepository`'s
 *     "not found is not an error" convention rather than throwing.
 */

// oxlint-disable max-dependencies -- an ingestion integration test against real Postgres needs the
// harness, the schema tables it seeds and asserts against, the adapter port types for the
// `fetchComment` double, and the module under test — the same shape `publish-comment.integration.test.ts`
// already has for the equivalent reason.
// oxlint-disable max-lines -- five independent invariants (dedup across channels, edit-in-place,
// redelivery, ancestor resolution, text completion), each needing its own seed data and its own
// adapter double, mirrors why `publish-comment.integration.test.ts` and `create-reply.integration.test.ts`
// are the length they are.

import { and, eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createIngestComments,
  type IngestTarget,
} from '#src/modules/comments/application/ingest-comments.ts';
import { createSyncTargetRepository } from '#src/modules/comments/infrastructure/sync-target-repository.ts';
import {
  comments,
  commentSyncTargets,
  outboxEvents,
} from '#src/modules/comments/infrastructure/schema.ts';
import type {
  AccountContext,
  CommentPlatformAdapter,
  NormalizedComment,
} from '#src/platforms/types.ts';
import { generateId } from '#src/shared/ids.ts';
import { startTestContainers, type TestContainers } from '#src/shared/testing/containers.ts';

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

function buildIngestComments(db: NodePgDatabase) {
  return createIngestComments({
    database: db,
    syncTargetRepository: createSyncTargetRepository(db, SYNC_INTERVALS_CONFIG),
  });
}

interface SeededAccount {
  readonly workspaceId: string;
  readonly socialAccountId: string;
}

function seedAccount(): SeededAccount {
  return { workspaceId: generateId(), socialAccountId: generateId() };
}

function accountContext(account: SeededAccount): AccountContext {
  return {
    workspaceId: account.workspaceId,
    socialAccountId: account.socialAccountId,
    platform: PLATFORM,
    platformAccountId: 'bsky-demo-account',
    credentials: 'unused-in-this-file',
  };
}

/** A minimal, valid `IngestedComment` (see the module docstring's contract decision). */
function ingestedComment(overrides: {
  platformCommentId: string;
  platformParentId?: string | null;
  text?: string | undefined;
  authorPlatformId?: string;
}) {
  return {
    platformCommentId: overrides.platformCommentId,
    platformParentId: overrides.platformParentId ?? null,
    authorPlatformId: overrides.authorPlatformId ?? 'author-1',
    authorUsername: 'someone',
    authorDisplayName: null,
    text: overrides.text,
    platformCreatedAt: new Date(),
    platformMeta: {},
    isOwn: false,
  };
}

function target(
  account: SeededAccount,
  platformPostId: string,
  postId: string | null = null,
): IngestTarget {
  return {
    workspaceId: account.workspaceId,
    socialAccountId: account.socialAccountId,
    platform: PLATFORM,
    postId,
    platformPostId,
  };
}

/** A double that only ever needs to answer `fetchComment` (ancestor walk, text completion). */
function fetchCommentDouble(byId: Record<string, NormalizedComment>): CommentPlatformAdapter {
  return {
    platform: PLATFORM,
    listComments(): Promise<never> {
      throw new Error('listComments is not exercised by ingest-comments');
    },
    publishComment(): Promise<never> {
      throw new Error('publishComment is not exercised by ingest-comments');
    },
    findPublishedComment(): Promise<null> {
      return Promise.resolve(null);
    },
    fetchComment(_ctx, platformCommentId): Promise<NormalizedComment | null> {
      return Promise.resolve(byId[platformCommentId] ?? null);
    },
  };
}

async function rowByPlatformCommentId(db: NodePgDatabase, platformCommentId: string) {
  const [row] = await db
    .select()
    .from(comments)
    .where(eq(comments.platformCommentId, platformCommentId));
  return row ?? null;
}

async function receivedEventCount(db: NodePgDatabase, commentId: string): Promise<number> {
  const rows = await db
    .select()
    .from(outboxEvents)
    .where(and(eq(outboxEvents.aggregateId, commentId), eq(outboxEvents.type, 'comment.received')));
  return rows.length;
}

async function assertPushThenRefreshDedup(harness: Harness): Promise<void> {
  const { db } = harness;
  const account = seedAccount();
  const t = target(account, `at://post-${generateId()}`);
  const adapter = fetchCommentDouble({});
  const ctx = accountContext(account);
  const ingest = buildIngestComments(db);
  const platformCommentId = `at://comment-${generateId()}`;

  const first = await ingest.upsert({
    target: t,
    comment: ingestedComment({ platformCommentId, text: 'hello' }),
    ingestionSource: 'webhook',
    ctx,
    adapter,
  });
  const second = await ingest.upsert({
    target: t,
    comment: ingestedComment({ platformCommentId, text: 'hello' }),
    ingestionSource: 'sync',
    ctx,
    adapter,
  });

  expect(first.wasNew).toBe(true);
  expect(second.wasNew).toBe(false);
  expect(first.commentId).toBe(second.commentId);

  const rows = await db
    .select()
    .from(comments)
    .where(eq(comments.platformCommentId, platformCommentId));
  expect(rows).toHaveLength(1);
  expect(await receivedEventCount(db, first.commentId)).toBe(1);
}

async function assertEditUpdatesInPlace(harness: Harness): Promise<void> {
  const { db } = harness;
  const account = seedAccount();
  const t = target(account, `at://post-${generateId()}`);
  const adapter = fetchCommentDouble({});
  const ctx = accountContext(account);
  const ingest = buildIngestComments(db);
  const platformCommentId = `at://comment-${generateId()}`;

  const first = await ingest.upsert({
    target: t,
    comment: ingestedComment({ platformCommentId, text: 'original text' }),
    ingestionSource: 'webhook',
    ctx,
    adapter,
  });
  await ingest.upsert({
    target: t,
    comment: ingestedComment({ platformCommentId, text: 'edited text' }),
    ingestionSource: 'webhook',
    ctx,
    adapter,
  });

  const row = await rowByPlatformCommentId(db, platformCommentId);
  expect(row?.text).toBe('edited text');
  const rows = await db
    .select()
    .from(comments)
    .where(eq(comments.platformCommentId, platformCommentId));
  expect(rows).toHaveLength(1);
  expect(await receivedEventCount(db, first.commentId)).toBe(1);
}

/**
 * Meta redelivers unsigned-changed payloads for up to 36h; simulated here as repeated identical
 * deliveries rather than a fake clock, since the invariant under test is idempotency, not timing.
 * `Promise.all` over independent calls to the same upsert target is safe here — unlike the
 * push-then-refresh case, every delivery in this list is byte-identical, so the order they land in
 * cannot change which one is "first".
 */
async function assertRedeliveryIsIdempotent(harness: Harness): Promise<void> {
  const { db } = harness;
  const account = seedAccount();
  const t = target(account, `at://post-${generateId()}`);
  const adapter = fetchCommentDouble({});
  const ctx = accountContext(account);
  const ingest = buildIngestComments(db);
  const platformCommentId = `at://comment-${generateId()}`;
  const comment = ingestedComment({ platformCommentId, text: 'redelivered as-is' });

  const first = await ingest.upsert({
    target: t,
    comment,
    ingestionSource: 'webhook',
    ctx,
    adapter,
  });
  await Promise.all(
    Array.from({ length: 3 }, () =>
      ingest.upsert({ target: t, comment, ingestionSource: 'webhook', ctx, adapter }),
    ),
  );

  const rows = await db
    .select()
    .from(comments)
    .where(eq(comments.platformCommentId, platformCommentId));
  expect(rows).toHaveLength(1);
  expect(await receivedEventCount(db, first.commentId)).toBe(1);
}

async function assertAncestorResolution(harness: Harness): Promise<void> {
  const { db } = harness;
  const account = seedAccount();
  const platformPostId = `at://post-${generateId()}`;
  const t = target(account, platformPostId);
  const ctx = accountContext(account);
  const parentPlatformCommentId = `at://comment-parent-${generateId()}`;
  const replyPlatformCommentId = `at://comment-reply-${generateId()}`;

  const parentNormalized: NormalizedComment = {
    platformCommentId: parentPlatformCommentId,
    platformParentId: null,
    authorPlatformId: 'author-parent',
    authorUsername: 'parent-author',
    authorDisplayName: null,
    text: 'the parent, discovered only through the walk',
    platformCreatedAt: new Date(),
    platformMeta: {},
  };
  const adapter = fetchCommentDouble({ [parentPlatformCommentId]: parentNormalized });
  const ingest = buildIngestComments(db);

  const result = await ingest.upsert({
    target: t,
    comment: ingestedComment({
      platformCommentId: replyPlatformCommentId,
      platformParentId: parentPlatformCommentId,
      text: 'a reply to an unknown parent',
    }),
    ingestionSource: 'webhook',
    ctx,
    adapter,
  });

  const replyRow = await rowByPlatformCommentId(db, replyPlatformCommentId);
  const parentRow = await rowByPlatformCommentId(db, parentPlatformCommentId);
  expect(parentRow).not.toBeNull();
  expect(replyRow?.parentCommentId).toBe(parentRow?.id);
  expect(replyRow?.depth).toBe(1);
  expect(replyRow?.rootCommentId).toBe(parentRow?.id);
  expect(parentRow?.replyCount).toBe(1);
  expect(result.commentId).toBe(replyRow?.id);
}

async function assertThinPayloadCompleted(harness: Harness): Promise<void> {
  const { db } = harness;
  const account = seedAccount();
  const t = target(account, `at://post-${generateId()}`);
  const ctx = accountContext(account);
  const platformCommentId = `at://comment-${generateId()}`;

  const full: NormalizedComment = {
    platformCommentId,
    platformParentId: null,
    authorPlatformId: 'author-1',
    authorUsername: 'someone',
    authorDisplayName: null,
    text: 'the full text only fetchComment knows',
    platformCreatedAt: new Date(),
    platformMeta: {},
  };
  const adapter = fetchCommentDouble({ [platformCommentId]: full });
  const ingest = buildIngestComments(db);

  // `text: undefined` — a thin payload, not an edit to blank (A18).
  await ingest.upsert({
    target: t,
    comment: ingestedComment({ platformCommentId, text: undefined }),
    ingestionSource: 'webhook',
    ctx,
    adapter,
  });

  const row = await rowByPlatformCommentId(db, platformCommentId);
  expect(row?.text).toBe('the full text only fetchComment knows');
  expect(row?.text).not.toBeNull();
}

/** Confirms the completion path runs even on a row that already exists, not only on first insert. */
async function assertThinRedeliveryDoesNotBlank(harness: Harness): Promise<void> {
  const { db } = harness;
  const account = seedAccount();
  const t = target(account, `at://post-${generateId()}`);
  const ctx = accountContext(account);
  const platformCommentId = `at://comment-${generateId()}`;

  const full: NormalizedComment = {
    platformCommentId,
    platformParentId: null,
    authorPlatformId: 'author-1',
    authorUsername: 'someone',
    authorDisplayName: null,
    text: 'stored on the first, full delivery',
    platformCreatedAt: new Date(),
    platformMeta: {},
  };
  const adapter = fetchCommentDouble({ [platformCommentId]: full });
  const ingest = buildIngestComments(db);

  await ingest.upsert({
    target: t,
    comment: ingestedComment({ platformCommentId, text: full.text }),
    ingestionSource: 'webhook',
    ctx,
    adapter,
  });
  await ingest.upsert({
    target: t,
    comment: ingestedComment({ platformCommentId, text: undefined }),
    ingestionSource: 'webhook',
    ctx,
    adapter,
  });

  const row = await rowByPlatformCommentId(db, platformCommentId);
  expect(row?.text).toBe('stored on the first, full delivery');
}

async function assertExternalPostCreatesTarget(harness: Harness): Promise<void> {
  const { db } = harness;
  const account = seedAccount();
  const platformPostId = `at://post-${generateId()}`;
  // `postId: null` — a post not published through the platform (D13).
  const t = target(account, platformPostId, null);
  const ctx = accountContext(account);
  const adapter = fetchCommentDouble({});
  const ingest = buildIngestComments(db);

  await ingest.upsert({
    target: t,
    comment: ingestedComment({
      platformCommentId: `at://comment-${generateId()}`,
      text: 'first comment ever seen on this external post',
    }),
    ingestionSource: 'webhook',
    ctx,
    adapter,
  });

  const [row] = await db
    .select()
    .from(commentSyncTargets)
    .where(
      and(
        eq(commentSyncTargets.socialAccountId, account.socialAccountId),
        eq(commentSyncTargets.platformPostId, platformPostId),
      ),
    );
  expect(row).toBeDefined();
  expect(row?.postId).toBeNull();
}

let harness: Harness;

beforeAll(async () => {
  harness = await setupHarness();
});

afterAll(async () => {
  await teardownHarness(harness);
});

describe('dedup across channels (FR-017, SC-003) — one row, one notification', () => {
  it('push then refresh: exists once, produces exactly one comment.received', () =>
    assertPushThenRefreshDedup(harness));

  it('a later event with edited text updates the stored comment, inserting no second row', () =>
    assertEditUpdatesInPlace(harness));

  it('redelivery over a 36-hour window changes neither the row count nor the event count', () =>
    assertRedeliveryIsIdempotent(harness));
});

describe('ancestor resolution (FR-022, T077)', () => {
  it('attaches a reply whose parent is unknown locally after walking the chain', () =>
    assertAncestorResolution(harness));
});

describe('a thin payload is completed, never blanked (A18, T081)', () => {
  it('an event arriving without text is completed through fetchComment', () =>
    assertThinPayloadCompleted(harness));

  it('a later thin redelivery does not blank text an earlier full event already stored', () =>
    assertThinRedeliveryDoesNotBlank(harness));
});

describe('external posts become tracked through ingestion (FR-018)', () => {
  it('creates a sync target of its own for a comment on a post never published through the platform', () =>
    assertExternalPostCreatesTarget(harness));
});
