/**
 * The stuck sync-job sweeper.
 *
 * `comment_sync_jobs` carries a partial unique index — `comment_sync_jobs_active_target_key` on
 * `(target_id) WHERE status in ('queued','running')` — which is what keeps one target from being
 * walked twice at once. The cost of that guarantee is that an abandoned row holds the target
 * hostage: every later scheduler tick's `onConflictDoNothing` skips it without a word,
 * `request-sync.ts` keeps handing the caller the dead job as though it were active, and the post
 * stops synchronising permanently while every log stays clean.
 *
 * A row is abandoned in three ways, and this sweeper is the only thing that covers all three:
 * the scheduler committed the row and died before `syncQueue.add`; the runner was killed between
 * `markJobRunning` and `finalizeJob`; or Redis was lost, which §4.1 explicitly permits and
 * requires not to cost data. Ordering the scheduler's `add` after its commit narrows the first
 * window but cannot close it, which is why this exists rather than that ordering alone.
 *
 * It lives apart from `sweepers.ts` because it sweeps a different thing in a different way: the
 * comment and webhook sweepers only ever *re-enqueue*, while a `running` row here has to be
 * finalised instead — re-enqueueing it would be a no-op against `markJobRunning`'s
 * `WHERE status = 'queued'`.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Queue } from 'bullmq';
import {
  reenqueueStuckJob,
  SILENT_LOGGER,
  type WarnLogger,
} from '#src/modules/comments/infrastructure/reenqueue.ts';
import { commentSyncJobs } from '#src/modules/comments/infrastructure/schema.ts';

/** Bounds one sweep pass; a healthy system finds nothing here. */
const SWEEP_BATCH_SIZE = 500;

/** A `queued` sync job whose enqueue was lost; the row is committed, BullMQ never heard of it. */
const STUCK_SYNC_QUEUED_AFTER_MS = 5 * 60_000;
/**
 * A `running` sync job whose runner disappeared.
 *
 * Generous on purpose: a walk over a busy thread legitimately takes minutes, and sweeping a job
 * that is still running costs a duplicate walk (harmless — ingestion is idempotent on the dedup
 * key), while leaving one stuck costs the target its synchronisation forever.
 */
const STUCK_SYNC_RUNNING_AFTER_MS = 15 * 60_000;

export interface StuckSyncJobSweeperDeps {
  readonly database: NodePgDatabase;
  readonly syncQueue: Queue;
  /** Defaults to a no-op (see {@link WarnLogger}) — only `src/app/worker.ts` needs the real one. */
  readonly logger?: WarnLogger;
}

export interface StuckSyncJobSweeper {
  sweep(): Promise<void>;
}

interface StuckSyncJob {
  readonly id: string;
  readonly targetId: string;
}

async function findStuckSyncJobs(
  db: NodePgDatabase,
  status: 'queued' | 'running',
  cutoff: Date,
): Promise<StuckSyncJob[]> {
  const anchor = status === 'queued' ? commentSyncJobs.createdAt : commentSyncJobs.startedAt;
  return await db
    .select({ id: commentSyncJobs.id, targetId: commentSyncJobs.targetId })
    .from(commentSyncJobs)
    .where(
      sql`${eq(commentSyncJobs.status, status)} and coalesce(${anchor}, ${
        commentSyncJobs.createdAt
      }) < ${cutoff}`,
    )
    .limit(SWEEP_BATCH_SIZE);
}

/**
 * Fails one abandoned `running` job so its target can be scheduled again.
 *
 * A `running` row cannot simply be re-enqueued: `markJobRunning`'s `WHERE status = 'queued'` would
 * match nothing and the new job would exit immediately, leaving the row — and the partial unique
 * index built on it — exactly as stuck. Finalising it as `failed` is what releases the index, and
 * the first scheduler tick after the target's lease lapses creates a fresh job, because the
 * abandoned walk never replaced that lease with a real `next_sync_at`.
 *
 * The `WHERE status = 'running'` predicate means a runner that is alive after all, and finishes
 * between this sweep's select and its update, keeps its own result: this update affects no row.
 */
async function failAbandonedSyncJob(db: NodePgDatabase, jobId: string): Promise<boolean> {
  const result = await db
    .update(commentSyncJobs)
    .set({
      status: 'failed',
      error: 'the runner holding this job disappeared; swept so the target can be scheduled again',
      finishedAt: new Date(),
    })
    .where(and(eq(commentSyncJobs.id, jobId), eq(commentSyncJobs.status, 'running')));
  return (result.rowCount ?? 0) > 0;
}

/**
 * Creates the stuck sync-job sweeper. Registered on the `scheduler` queue (`src/app/worker.ts`)
 * alongside the other two, at the queue's required concurrency 1 (§9.2).
 *
 * Without it a `comment_sync_jobs` row left `queued` or `running` — the scheduler committed a row
 * and died before `syncQueue.add`, a runner was killed mid-walk, or Redis was lost (§4.1 permits
 * losing Redis; it must not cost data) — blocks its target through the
 * `comment_sync_jobs_active_target_key` partial unique index. Every later tick's
 * `onConflictDoNothing` then skips that target silently, `request-sync` keeps reporting the dead
 * job as active, and the post stops syncing for good without a single error being logged.
 */
export function createStuckSyncJobSweeper(deps: StuckSyncJobSweeperDeps): StuckSyncJobSweeper {
  return {
    async sweep(): Promise<void> {
      const now = Date.now();
      const queued = await findStuckSyncJobs(
        deps.database,
        'queued',
        new Date(now - STUCK_SYNC_QUEUED_AFTER_MS),
      );
      const running = await findStuckSyncJobs(
        deps.database,
        'running',
        new Date(now - STUCK_SYNC_RUNNING_AFTER_MS),
      );
      const logger = deps.logger ?? SILENT_LOGGER;

      await Promise.allSettled(
        queued.map((job) =>
          reenqueueStuckJob(deps.syncQueue, 'sync', { targetId: job.targetId }, job.id, logger),
        ),
      );
      await Promise.allSettled(running.map((job) => failAbandonedSyncJob(deps.database, job.id)));
    },
  };
}
