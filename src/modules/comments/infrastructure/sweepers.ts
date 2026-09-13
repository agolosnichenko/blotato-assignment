/**
 * The stuck-work sweeper (T064, §7.1 step 4, R-10; extended for `processing` by spec.md §18,
 * "The stuck-work sweeper also recovers `processing`").
 *
 * Selector and rationale are fixed by `sweeper.integration.test.ts` (read its module docstring
 * first — it derives the predicate from first principles): a `queued` comment whose
 * `COALESCE(last_attempt_started_at, created_at)` is more than a minute old is re-enqueued.
 *
 * A `processing` comment is normally left alone because a worker may still hold it (D14, no
 * concurrent publish). But a worker that dies between `markProcessing`'s `queued -> processing`
 * transition and settling the outcome leaves the row in `processing` forever — BullMQ's stalled-job
 * retry cannot rescue it, because that retry's own `markProcessing` finds the row no longer
 * `queued`, affects no row, and correctly stops. So a `processing` row whose
 * `last_attempt_started_at` is older than a threshold *comfortably* beyond the longest plausible
 * platform call is returned to `queued` for another attempt: `attempt_count` has already been
 * incremented, and reconciliation through `findPublishedComment` still gates any second send, so
 * this is exactly as safe as a retry after an unknown outcome. The threshold is deliberately
 * generous — sweeping a row that is genuinely still publishing costs one reconciliation read, while
 * leaving a row stuck costs the reply.
 *
 * Re-enqueueing is safe to run twice, and even safe against a job that is not actually stuck:
 * `publishQueue.add` uses `jobId = comment.id`, so a job already in flight for that comment makes
 * this a no-op, and `CommentRepository.markProcessing`'s conditional `UPDATE` is what makes a
 * second worker picking up a genuinely-not-stuck comment harmless — it loses the race and stops.
 * This sweeper adds no second mechanism on top of those two; it only decides *when* to enqueue.
 *
 * Also exports {@link createWebhookDeliverySweeper} (T082, §7.2 step 5): re-enqueues
 * `webhook_deliveries` rows still `processed_at is null` past a threshold. Meta redelivers for up
 * to 36 hours, but the normal path is `webhook-routes.ts`'s own enqueue on receipt — this sweeper
 * only exists for the one case that path cannot cover itself: a delivery whose enqueue was lost
 * (the process crashed between the insert and the `add`) or whose job failed without retrying
 * further. Same idempotent shape as the stuck-work sweeper above: `webhookQueue.add` uses
 * `jobId = delivery.id`, so a delivery still genuinely in flight makes re-enqueueing a no-op, and
 * the worker's own `processed_at` write (not this sweeper) is what stops a delivery from being
 * swept forever once it succeeds.
 */

import { eq, isNull, lt, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Queue } from 'bullmq';
import {
  createCommentRepository,
  type CommentRepository,
} from '#src/modules/comments/infrastructure/comment-repository.ts';
import { comments, webhookDeliveries } from '#src/modules/comments/infrastructure/schema.ts';
import { JOB_NAMES } from '#src/shared/queues.ts';

const STUCK_QUEUED_AFTER_MS = 60_000;
/** Generous on purpose (see module docstring) — minutes, not the seconds a platform call takes. */
const STUCK_PROCESSING_AFTER_MS = 5 * 60_000;
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

function stuckProcessingPredicate(cutoff: Date): SQL {
  // `markProcessing` always stamps `last_attempt_started_at`, so unlike the `queued` predicate
  // this one needs no `COALESCE` fallback to `created_at`.
  return sql`${eq(comments.status, 'processing')} and ${lt(comments.lastAttemptStartedAt, cutoff)}`;
}

async function findStuckCommentIds(db: NodePgDatabase, cutoff: Date): Promise<string[]> {
  const rows = await db
    .select({ id: comments.id })
    .from(comments)
    .where(stuckQueuedPredicate(cutoff))
    .limit(SWEEP_BATCH_SIZE);
  return rows.map((row) => row.id);
}

interface StuckProcessingRow {
  readonly id: string;
  readonly workspaceId: string;
}

function findStuckProcessingRows(db: NodePgDatabase, cutoff: Date): Promise<StuckProcessingRow[]> {
  return db
    .select({ id: comments.id, workspaceId: comments.workspaceId })
    .from(comments)
    .where(stuckProcessingPredicate(cutoff))
    .limit(SWEEP_BATCH_SIZE);
}

/**
 * Returns one stuck `processing` row to `queued` so it can be re-enqueued. Reuses
 * `CommentRepository.markQueuedForRetry` — the same conditional `processing -> queued` transition
 * a `RetryableError` drives — rather than a second update path for the same state change.
 *
 * Returns the row's id when the transition applied, or `null` when it lost the race (the worker
 * that was actually holding it settled the outcome first) — in which case there is nothing left to
 * enqueue.
 */
async function recoverStuckProcessingRow(
  db: NodePgDatabase,
  commentRepository: CommentRepository,
  row: StuckProcessingRow,
): Promise<string | null> {
  const recovered = await db.transaction((tx) =>
    commentRepository.markQueuedForRetry(tx, row.workspaceId, row.id),
  );
  return recovered ? row.id : null;
}

/**
 * Creates the sweeper. Registered on the `scheduler` queue (`src/app/worker.ts`) as a repeatable
 * job running every minute, at the queue's required concurrency 1 (§9.2).
 */
export function createStuckWorkSweeper(deps: StuckWorkSweeperDeps): StuckWorkSweeper {
  return {
    async sweep(): Promise<void> {
      const queuedCutoff = new Date(Date.now() - STUCK_QUEUED_AFTER_MS);
      const processingCutoff = new Date(Date.now() - STUCK_PROCESSING_AFTER_MS);

      const stuckQueuedIds = await findStuckCommentIds(deps.database, queuedCutoff);
      const stuckProcessingRows = await findStuckProcessingRows(deps.database, processingCutoff);
      const commentRepository = createCommentRepository(deps.database);
      const recoveredIds = await Promise.all(
        stuckProcessingRows.map((row) =>
          recoverStuckProcessingRow(deps.database, commentRepository, row),
        ),
      );

      const commentIds = [
        ...stuckQueuedIds,
        ...recoveredIds.filter((id): id is string => id !== null),
      ];

      await Promise.all(
        commentIds.map((commentId) =>
          deps.publishQueue.add('publish', { commentId }, { jobId: commentId }),
        ),
      );
    },
  };
}

const UNPROCESSED_DELIVERY_AFTER_MS = 5 * 60_000;

export interface WebhookDeliverySweeperDeps {
  readonly database: NodePgDatabase;
  readonly webhookQueue: Queue;
}

export interface WebhookDeliverySweeper {
  sweep(): Promise<void>;
}

/** Unprocessed past the threshold: `processed_at is null` and `received_at` older than 5 minutes
 * (§7.2 step 5). No `COALESCE` needed — unlike the stuck-work predicate above, `received_at` is
 * set unconditionally at insert (`schema.ts`'s own `.defaultNow()`). */
function unprocessedDeliveryPredicate(cutoff: Date): SQL {
  return sql`${isNull(webhookDeliveries.processedAt)} and ${lt(webhookDeliveries.receivedAt, cutoff)}`;
}

async function findUnprocessedDeliveryIds(db: NodePgDatabase, cutoff: Date): Promise<string[]> {
  const rows = await db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(unprocessedDeliveryPredicate(cutoff))
    .limit(SWEEP_BATCH_SIZE);
  return rows.map((row) => row.id);
}

/**
 * Creates the webhook-delivery sweeper (T082). Registered on the `scheduler` queue
 * (`src/app/worker.ts`) as a repeatable job, at the queue's required concurrency 1 (§9.2) — same
 * reasoning as {@link createStuckWorkSweeper}: concurrency 1 is what keeps "re-enqueued once" true
 * across however many sweep ticks overlap a slow pass.
 */
export function createWebhookDeliverySweeper(
  deps: WebhookDeliverySweeperDeps,
): WebhookDeliverySweeper {
  return {
    async sweep(): Promise<void> {
      const cutoff = new Date(Date.now() - UNPROCESSED_DELIVERY_AFTER_MS);
      const deliveryIds = await findUnprocessedDeliveryIds(deps.database, cutoff);

      await Promise.all(
        deliveryIds.map((deliveryId) =>
          deps.webhookQueue.add(JOB_NAMES.processDelivery, { deliveryId }, { jobId: deliveryId }),
        ),
      );
    },
  };
}
