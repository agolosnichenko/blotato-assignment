/* oxlint-disable no-console -- this script's entire purpose is printing the seeded sizes, the two
   p95 figures and their ratio to stdout for a human (or DESIGN.md) to record; every other
   script/module keeps no-console enabled. */
/* oxlint-disable max-dependencies -- this harness wires together the same set of modules the
   composition root and the benchmark integration test do (config, container, api, db schema,
   crypto, ids) to seed data and issue in-process requests against a real app instance; see the
   same justification on src/app/container.ts and benchmark.integration.test.ts. */
/**
 * On-demand SC-005 harness: does `GET /v1/comments`'s cost follow the page, not the history?
 *
 * Seeds two workspaces whose comment histories differ by a factor of ten (research.md R-10),
 * issues the unfiltered listing against each at equal page size, and prints the p95 of each plus
 * their ratio. A listing genuinely bounded by the requested page measures a ratio near 1.0; one
 * that scans (part of) the workspace's history grows with it, so the ratio climbs with the history
 * size instead. `MAX_RATIO` is the pass line quickstart.md V7 sets.
 *
 * Deliberately not a vitest test and not a CI step (research.md R-10): timing on a shared runner is
 * too noisy to gate on, and this ratio is only meaningful measured on one quiet machine, on demand.
 *
 * The measured latencies are **in-process**: this script builds its own `Container`/`Api` and
 * calls `app.inject(...)` directly (no `pnpm dev:api`, no HTTP, no network layer) — the same
 * reasoning `benchmark.integration.test.ts` uses, and why the printed report says so explicitly.
 * It needs only the backing store: `docker compose up -d` and a populated `.env` (copy from
 * `.env.example`).
 *
 * **What this harness can and cannot catch.** Both workspaces share one table, so a plain
 * sequential scan (e.g. every index dropped) costs the same regardless of which workspace is
 * queried — a function of the table's total size, not the queried workspace's history — and this
 * ratio cannot separate that regression from noise. It does catch a regression whose cost scales
 * with the *queried workspace's own* history, which is what SC-005 actually compares and is not
 * hypothetical: the `NULLS LAST` pathkey mismatch this feature found and fixed. The deterministic
 * structural check for "which index" stays `benchmark.integration.test.ts`'s `EXPLAIN` assertions;
 * this script does not replace them.
 *
 * **Calibration**, verified once at 10,000/100,000: after `pnpm bench:listing` has seeded data,
 * find the two workspace ids (`SELECT workspace_id, count(*) FROM comments GROUP BY workspace_id
 * ORDER BY 2 DESC LIMIT 2`) and, per id, run the same predicate via `psql` with the `ORDER BY`
 * mismatched against the index's own `NULLS LAST` (no `src/` change needed — the mismatch is
 * entirely in the query text):
 *
 *   EXPLAIN ANALYZE SELECT id FROM comments WHERE workspace_id = '<id>'
 *     AND (status <> 'deleted' OR reply_count > 0)
 *     ORDER BY occurred_at DESC NULLS FIRST, id DESC NULLS FIRST LIMIT 21;
 *
 * The mismatch forces a `Sort` over the whole filtered set instead of the index supplying the
 * order, scaling with the queried workspace's row count — this moved the ratio from ~1.3 (matching
 * order) to ~4.5 (mismatched); see the report for the full run.
 *
 * Usage:
 *   pnpm bench:listing
 */

import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { buildApi, type Api } from '#src/app/api.ts';
import { loadConfig } from '#src/app/config.ts';
import { buildContainer, type Container } from '#src/app/container.ts';
import { comments } from '#src/modules/comments/infrastructure/schema.ts';
import { apiKeys, workspaces } from '#src/modules/platform-core/schema.ts';
import { hashSecret } from '#src/shared/crypto.ts';
import type { Database } from '#src/shared/db.ts';
import { asWorkspaceId, generateId, type WorkspaceId } from '#src/shared/ids.ts';
import { closeQuietly, reportFatal } from './script-failure.ts';

const PLATFORM = 'bluesky';
/**
 * 10,000/100,000, not 1,000/10,000: at the smaller scale a full unbounded scan of the larger
 * history sits near `app.inject`'s own fixed cost, making a regression indistinguishable from
 * noise — the same reason `benchmark.integration.test.ts` calibrates at 100,000 rows.
 */
const SMALL_HISTORY_COMMENTS = 10_000;
/** Ten times {@link SMALL_HISTORY_COMMENTS} — the factor-of-ten spread R-10 asks for. */
const LARGE_HISTORY_COMMENTS = SMALL_HISTORY_COMMENTS * 10;
const SEED_CHUNK_SIZE = 1_000;
const PAGE_SIZE = 20;
const WARMUP_REQUESTS = 5;
const SAMPLE_REQUESTS = 30;
/** quickstart.md V7's pass line: a genuinely page-bounded listing measures near 1.0. */
const MAX_RATIO = 1.5;

type CommentInsert = typeof comments.$inferInsert;

interface SeededWorkspace {
  readonly label: string;
  readonly workspaceId: WorkspaceId;
  readonly commentCount: number;
  readonly apiKey: string;
}

async function seedWorkspaceRow(database: Database, name: string): Promise<WorkspaceId> {
  const workspaceId = asWorkspaceId(generateId());
  await database.drizzle.insert(workspaces).values({
    id: workspaceId,
    name,
    contactLimitMonthly: 1_000_000,
    createdAt: new Date(),
  });
  return workspaceId;
}

async function mintApiKey(database: Database, workspaceId: WorkspaceId): Promise<string> {
  const prefix = randomBytes(6).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  await database.drizzle.insert(apiKeys).values({
    id: generateId(),
    workspaceId,
    prefix,
    keyHash: hashSecret(secret),
    name: 'bench-listing',
    rateLimitPerMin: null,
    revokedAt: null,
    createdAt: new Date(),
  });
  return `blt_${prefix}_${secret}`;
}

/** One synthetic, already-`posted` comment — shape mirrors `benchmark.integration.test.ts`'s. */
function buildComment(
  workspaceId: WorkspaceId,
  socialAccountId: string,
  postId: string,
  occurredAt: Date,
): CommentInsert {
  const id = generateId();
  return {
    id,
    workspaceId,
    socialAccountId,
    platform: PLATFORM,
    postId,
    platformPostId: `bench-post-of-${postId}`,
    parentCommentId: null,
    rootCommentId: null,
    depth: 0,
    platformCommentId: `bench-comment-${id}`,
    isOwn: false,
    source: 'sync',
    authorPlatformId: `author-${id}`,
    authorUsername: `author-${id}`,
    authorDisplayName: null,
    text: `seeded comment ${id}`,
    status: 'posted',
    replyCount: 0,
    lastActivityAt: occurredAt,
    occurredAt,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
}

/** Bulk-inserts `count` comments in `SEED_CHUNK_SIZE` chunks — one round trip per row would be too slow. */
async function seedComments(
  database: Database,
  workspaceId: WorkspaceId,
  count: number,
): Promise<void> {
  const socialAccountId = generateId();
  const postId = generateId();
  const base = Date.now();
  let pending: CommentInsert[] = [];

  for (let index = 0; index < count; index += 1) {
    const occurredAt = new Date(base + index);
    pending.push(buildComment(workspaceId, socialAccountId, postId, occurredAt));
    if (pending.length >= SEED_CHUNK_SIZE) {
      // oxlint-disable-next-line no-await-in-loop -- chunked to bound insert size, inherently sequential.
      await database.drizzle.insert(comments).values(pending);
      pending = [];
    }
  }
  if (pending.length > 0) {
    await database.drizzle.insert(comments).values(pending);
  }
}

/** One workspace with a real API key and `commentCount` seeded comments, statistics refreshed. */
async function seedWorkspaceWithHistory(
  database: Database,
  label: string,
  commentCount: number,
): Promise<SeededWorkspace> {
  const workspaceId = await seedWorkspaceRow(database, `bench-listing ${label}`);
  const apiKey = await mintApiKey(database, workspaceId);
  await seedComments(database, workspaceId, commentCount);
  return { label, workspaceId, commentCount, apiKey };
}

function percentile(samplesMs: readonly number[], p: number): number {
  const sorted = [...samplesMs].toSorted((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

/**
 * Issues `count` sequential, unfiltered `GET /v1/comments` requests and returns their latencies.
 * Sequential, not concurrent: concurrent requests would measure queueing under load, not the
 * per-request cost this script compares (same reasoning as `benchmark.integration.test.ts`'s).
 */
async function measureListingLatencies(app: Api, apiKey: string, count: number): Promise<number[]> {
  const samplesMs: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const startedAt = performance.now();
    // oxlint-disable-next-line no-await-in-loop -- each sample must be timed on its own request.
    const response = await app.inject({
      method: 'GET',
      url: `/v1/comments?limit=${PAGE_SIZE}`,
      headers: { 'blotato-api-key': apiKey },
    });
    if (response.statusCode !== 200) {
      throw new Error(
        `GET /v1/comments against ${apiKey.slice(0, 10)}… returned ${response.statusCode}, ` +
          `expected 200: ${response.body}`,
      );
    }
    samplesMs.push(performance.now() - startedAt);
  }
  return samplesMs;
}

async function measureP95(app: Api, workspace: SeededWorkspace): Promise<number> {
  await measureListingLatencies(app, workspace.apiKey, WARMUP_REQUESTS);
  const samplesMs = await measureListingLatencies(app, workspace.apiKey, SAMPLE_REQUESTS);
  return percentile(samplesMs, 95);
}

function buildContainerWithHeadroom(): Container {
  // This issues far more requests/min than the production default (30 reads/min per key) allows —
  // raised here so a limit unrelated to what it measures doesn't force minting one key per sample.
  const config = loadConfig({ ...process.env, RATE_LIMIT_READS_PER_MIN: '100000' });
  return buildContainer({ config });
}

async function main(): Promise<void> {
  const container = buildContainerWithHeadroom();
  const app = buildApi(container);
  await app.ready();

  try {
    console.log(
      `Seeding ${SMALL_HISTORY_COMMENTS} and ${LARGE_HISTORY_COMMENTS} comments across two workspaces…`,
    );
    const small = await seedWorkspaceWithHistory(
      container.database,
      'small',
      SMALL_HISTORY_COMMENTS,
    );
    const large = await seedWorkspaceWithHistory(
      container.database,
      'large',
      LARGE_HISTORY_COMMENTS,
    );
    // Without this the planner works off the empty-table defaults autovacuum has not yet
    // replaced with real statistics, and picks a plan no production-sized table would run — a
    // seed artifact, not a claim about the listing itself (same reasoning as T017's benchmark fix).
    await container.database.drizzle.execute(sql`ANALYZE ${comments}`);

    console.log(`Measuring ${WARMUP_REQUESTS + SAMPLE_REQUESTS} requests per workspace…`);
    const smallP95 = await measureP95(app, small);
    const largeP95 = await measureP95(app, large);
    reportResult(small, smallP95, large, largeP95);
  } finally {
    await closeQuietly('the Fastify app', () => app.close());
    await closeQuietly('the container', () => container.close());
  }
}

function reportResult(
  small: SeededWorkspace,
  smallP95: number,
  large: SeededWorkspace,
  largeP95: number,
): void {
  // `Math.max(…, 1)` is a divide-by-zero guard, not a smoothing factor — below ~1ms it biases the
  // ratio toward "pass" exactly when the measurement is least trustworthy; call that out, don't hide it.
  const ratio = Math.max(smallP95, largeP95) / Math.max(Math.min(smallP95, largeP95), 1);
  console.log('');
  console.log(
    'Latencies below are in-process (app.inject, no HTTP/network layer) — not end-to-end ' +
      'deployed-API figures.',
  );
  console.log(`${small.label} (${small.commentCount} comments): p95 = ${smallP95.toFixed(2)}ms`);
  console.log(`${large.label} (${large.commentCount} comments): p95 = ${largeP95.toFixed(2)}ms`);
  console.log(`ratio (max/min) = ${ratio.toFixed(2)} (pass: <= ${MAX_RATIO})`);

  if (ratio > MAX_RATIO) {
    throw new Error(
      `SC-005 violated: p95 ratio ${ratio.toFixed(2)} exceeds ${MAX_RATIO}. ` +
        `A 10x larger history should cost roughly the same, not scale with it — ` +
        `check that the unfiltered listing still chooses comments_workspace_idx (research.md R-10).`,
    );
  }
  console.log('\nSC-005 holds: the listing’s cost tracks the page, not the history.');
}

try {
  await main();
} catch (error) {
  reportFatal(error);
}
