/**
 * The stuck-work sweeper (T064, §7.1 step 4, R-10).
 *
 * Selector and rationale are fixed by `sweeper.integration.test.ts` (read its module docstring
 * first — it derives the predicate from first principles): a `queued` comment whose
 * `COALESCE(last_attempt_started_at, created_at)` is more than a minute old is re-enqueued;
 * `processing` rows are left alone because a worker may still hold one (D14, no concurrent
 * publish).
 *
 * Re-enqueueing is safe to run twice, and even safe against a job that is not actually stuck:
 * `publishQueue.add` uses `jobId = comment.id`, so a job already in flight for that comment makes
 * this a no-op, and `CommentRepository.markProcessing`'s conditional `UPDATE` is what makes a
 * second worker picking up a genuinely-not-stuck comment harmless — it loses the race and stops.
 * This sweeper adds no second mechanism on top of those two; it only decides *when* to enqueue.
 */

import { eq, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Queue } from 'bullmq';
import { comments } from '#src/modules/comments/infrastructure/schema.ts';

const STUCK_AFTER_MS = 60_000;
/** Bounds one sweep pass; a healthy system has an empty result here (see the test's docstring). */
const SWEEP_BATCH_SIZE = 500;

export interface StuckWorkSweeperDeps {
  readonly database: NodePgDatabase;
  readonly publishQueue: Queue;
}

export interface StuckWorkSweeper {
  sweep(): Promise<void>;
}

/**
 * Finds `queued` comments stuck past the threshold. `comments_stuck_work_idx` on
 * `(status, last_attempt_started_at) WHERE status IN ('queued','processing')` narrows the scan to
 * in-flight rows even though it cannot serve the `COALESCE` term directly (controller ruling,
 * `sweeper.integration.test.ts`) — the set it narrows to is empty in the healthy case.
 */
function stuckQueuedPredicate(cutoff: Date): SQL {
  return sql`${eq(comments.status, 'queued')} and coalesce(${comments.lastAttemptStartedAt}, ${
    comments.createdAt
  }) < ${cutoff}`;
}

async function findStuckCommentIds(db: NodePgDatabase, cutoff: Date): Promise<string[]> {
  const rows = await db
    .select({ id: comments.id })
    .from(comments)
    .where(stuckQueuedPredicate(cutoff))
    .limit(SWEEP_BATCH_SIZE);
  return rows.map((row) => row.id);
}

/**
 * Creates the sweeper. Registered on the `scheduler` queue (`src/app/worker.ts`) as a repeatable
 * job running every minute, at the queue's required concurrency 1 (§9.2).
 */
export function createStuckWorkSweeper(deps: StuckWorkSweeperDeps): StuckWorkSweeper {
  return {
    async sweep(): Promise<void> {
      const cutoff = new Date(Date.now() - STUCK_AFTER_MS);
      const stuckIds = await findStuckCommentIds(deps.database, cutoff);

      await Promise.all(
        stuckIds.map((commentId) =>
          deps.publishQueue.add('publish', { commentId }, { jobId: commentId }),
        ),
      );
    },
  };
}
