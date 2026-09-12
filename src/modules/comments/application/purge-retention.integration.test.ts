/**
 * Contract test for the retention purge (T100, V7, §7.4, A9).
 *
 * The purge key is the **root's** `last_activity_at`, not any individual comment's own age
 * (A9) — a thread is a unit, and only a complete, inactive thread is removed whole. The two
 * cases below are the minimal pair that proves the implementation reads the right column:
 *
 *   1. A root whose own `last_activity_at` is 46 days old (past the 45-day default) is purged,
 *      and its reply goes with it by cascade (`parent_comment_id` has `ON DELETE CASCADE`).
 *   2. A root whose `last_activity_at` is 44 days old (inside the window — a recent reply bumped
 *      it) is untouched, **and so is an older reply underneath it**. An implementation that
 *      purged per-comment by each row's own age would delete that older reply even though the
 *      thread as a whole is still alive — this case is what would catch that bug.
 */

import { eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPurgeRetention } from '#src/modules/comments/application/purge-retention.ts';
import { comments } from '#src/modules/comments/infrastructure/schema.ts';
import { socialAccounts, workspaces } from '#src/modules/platform-core/schema.ts';
import { generateId } from '#src/shared/ids.ts';
import { startTestContainers, type TestContainers } from '#src/shared/testing/containers.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 45;

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
  await db.insert(socialAccounts).values({
    id: socialAccountId,
    workspaceId,
    platform: 'bluesky',
    platformAccountId: 'bsky-demo-account',
    username: 'demo',
    credentialsCiphertext: Buffer.alloc(28),
    credentialsKeyVersion: 1,
    status: 'active',
    createdAt: new Date(),
  });

  return { workspaceId, socialAccountId };
}

interface SeedRootOptions {
  readonly workspaceId: string;
  readonly socialAccountId: string;
  readonly platformCommentId: string;
  readonly createdAt: Date;
  readonly lastActivityAt: Date;
}

async function seedRoot(db: NodePgDatabase, opts: SeedRootOptions): Promise<string> {
  const id = generateId();
  await db.insert(comments).values({
    id,
    workspaceId: opts.workspaceId,
    socialAccountId: opts.socialAccountId,
    platform: 'bluesky',
    postId: null,
    platformPostId: 'platform-post-1',
    parentCommentId: null,
    rootCommentId: null,
    depth: 0,
    platformCommentId: opts.platformCommentId,
    isOwn: false,
    source: 'sync',
    authorPlatformId: 'someone',
    text: 'a root comment',
    status: 'posted',
    replyCount: 0,
    lastActivityAt: opts.lastActivityAt,
    occurredAt: opts.createdAt,
    createdAt: opts.createdAt,
    updatedAt: opts.createdAt,
  });
  return id;
}

interface SeedReplyOptions {
  readonly workspaceId: string;
  readonly socialAccountId: string;
  readonly rootId: string;
  readonly platformCommentId: string;
  readonly createdAt: Date;
}

async function seedReply(db: NodePgDatabase, opts: SeedReplyOptions): Promise<string> {
  const id = generateId();
  await db.insert(comments).values({
    id,
    workspaceId: opts.workspaceId,
    socialAccountId: opts.socialAccountId,
    platform: 'bluesky',
    postId: null,
    platformPostId: 'platform-post-1',
    parentCommentId: opts.rootId,
    rootCommentId: opts.rootId,
    depth: 1,
    platformCommentId: opts.platformCommentId,
    isOwn: false,
    source: 'sync',
    authorPlatformId: 'someone-else',
    text: 'a reply',
    status: 'posted',
    replyCount: 0,
    lastActivityAt: opts.createdAt,
    occurredAt: opts.createdAt,
    createdAt: opts.createdAt,
    updatedAt: opts.createdAt,
  });
  return id;
}

async function commentExists(db: NodePgDatabase, id: string): Promise<boolean> {
  const rows = await db.select({ id: comments.id }).from(comments).where(eq(comments.id, id));
  return rows.length > 0;
}

let harness: Harness;

beforeAll(async () => {
  harness = await setupHarness();
});

afterAll(async () => {
  await teardownHarness(harness);
});

describe('removes a thread whole past retention (§7.4, A9)', () => {
  it('removes a thread whole when its last activity is 46 days old', async () => {
    const { db } = harness;
    const account = await seedWorkspaceAndAccount(db);
    const fortySixDaysAgo = new Date(Date.now() - 46 * DAY_MS);
    const rootId = await seedRoot(db, {
      ...account,
      platformCommentId: 'root-old',
      createdAt: fortySixDaysAgo,
      lastActivityAt: fortySixDaysAgo,
    });
    const replyId = await seedReply(db, {
      ...account,
      rootId,
      platformCommentId: 'reply-old',
      createdAt: fortySixDaysAgo,
    });

    await createPurgeRetention({ database: db, retentionDays: RETENTION_DAYS }).run();

    expect(await commentExists(db, rootId)).toBe(false);
    expect(await commentExists(db, replyId)).toBe(false);
  });
});

describe('leaves an active thread untouched, including its older comments (§7.4, A9)', () => {
  it('leaves a thread untouched, including an older reply, when last activity is 44 days old', async () => {
    const { db } = harness;
    const account = await seedWorkspaceAndAccount(db);
    const ninetyDaysAgo = new Date(Date.now() - 90 * DAY_MS);
    const fortyFourDaysAgo = new Date(Date.now() - 44 * DAY_MS);
    // The root itself is old, but a recent reply bumped its `last_activity_at` to 44 days ago —
    // inside the 45-day window.
    const rootId = await seedRoot(db, {
      ...account,
      platformCommentId: 'root-active',
      createdAt: ninetyDaysAgo,
      lastActivityAt: fortyFourDaysAgo,
    });
    // This reply is itself 90 days old — older than the retention window on its own — and must
    // survive anyway, because the thread it belongs to is still active.
    const replyId = await seedReply(db, {
      ...account,
      rootId,
      platformCommentId: 'reply-old-but-thread-active',
      createdAt: ninetyDaysAgo,
    });

    await createPurgeRetention({ database: db, retentionDays: RETENTION_DAYS }).run();

    expect(await commentExists(db, rootId)).toBe(true);
    expect(await commentExists(db, replyId)).toBe(true);
  });
});
