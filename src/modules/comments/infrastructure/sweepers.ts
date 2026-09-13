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
 * `jobId = comment.id` means a job genuinely in flight for that comment is left alone by
 * {@link reenqueueStuckJob} below, and `CommentRepository.markProcessing`'s conditional `UPDATE`
 * is what makes a second worker picking up a genuinely-not-stuck comment harmless — it loses the
 * race and stops. Double-enqueue is therefore not a hazard this code has to engineer against: only
 * one worker can ever transition a row out of `queued`/`processing`, so a second job for the same
 * `jobId` finds the row already moved on and stops immediately (D14). This sweeper adds no second
 * mechanism on top of that; it only decides *when* to enqueue, and — see below — makes sure the
 * enqueue it decides to do actually happens.
 *
 * `jobId = comment.id` (like `jobId = delivery.id` for the webhook sweeper below) is also exactly
 * what makes a *stale* re-enqueue a silent no-op (C1): `Queue.add` with a `jobId` that already
 * names a job retained in a terminal state does not move it back to `wait` — it resolves
 * successfully and does nothing, which a sweeper cannot tell apart from a real schedule unless it
 * checks. {@link reenqueueStuckJob} does that check: a retained completed/failed job is removed
 * before re-adding, and the final state is asserted so a sweep that decided work was stuck but
 * could not actually schedule it is `warn`-logged rather than silent.
 *
 * Also exports {@link createWebhookDeliverySweeper} (T082, §7.2 step 5): re-enqueues
 * `webhook_deliveries` rows still `processed_at is null` past a threshold. Meta redelivers for up
 * to 36 hours, but the normal path is `webhook-routes.ts`'s own enqueue on receipt — this sweeper
 * only exists for the one case that path cannot cover itself: a delivery whose enqueue was lost
 * (the process crashed between the insert and the `add`) or whose job failed without retrying
 * further. Same idempotent shape as the stuck-work sweeper above, through the same
 * {@link reenqueueStuckJob} helper: a delivery still genuinely in flight makes re-enqueueing a
 * no-op, and the worker's own `processed_at` write (not this sweeper) is what stops a delivery
 * from being swept forever once it succeeds.
 */

// oxlint-disable max-lines -- two sweepers plus the shared `reenqueueStuckJob` helper they both go
// through; the helper's three outcome branches (in-flight, completed, failed, and the genuine
// "could not schedule" case) are each commented at the point of use rather than compressed, because
// the comments are what keeps a warning meant to signal a broken recovery path from also firing on
// the healthy path (see the function's own docstring).

import { eq, isNull, lt, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
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

/**
 * States BullMQ reports for a job that is genuinely in flight: waiting its turn, scheduled for a
 * backoff retry, actively running, waiting on a flow-producer parent, or held by priority
 * ordering. A row a sweeper's own SQL predicate selected as stuck but whose job is in one of these
 * states is not actually stuck — a worker (or a pending retry) already owns it, and re-enqueueing
 * on top would risk the second concurrent publish D14 exists to prevent. `completed`, `failed` and
 * anything {@link reenqueueStuckJob} cannot classify are the states that mean "nothing is actually
 * working on this" — those are the ones it must act on.
 */
const IN_FLIGHT_JOB_STATES = new Set([
  'waiting',
  'active',
  'delayed',
  'waiting-children',
  'prioritized',
]);

/** What {@link reenqueueStuckJob} needs from a logger — just `warn` — so a caller that has no
 * real one (a unit test exercising the selector logic, not the observability) can pass a no-op
 * rather than wiring up pino. Every production caller (`src/app/worker.ts`) passes the real
 * per-role `Logger`, which is a structural subtype of this. */
type WarnLogger = Pick<Logger, 'warn'>;

const SILENT_LOGGER: WarnLogger = { warn: () => {} };

/**
 * Re-enqueues one stuck job, working around `Queue.add`'s own silent no-op when `jobId` already
 * names a job BullMQ has retained in a terminal state (C1): `addStandardJob`'s Lua script treats
 * an existing job key as a duplicate and resolves the caller's promise without moving anything
 * back to `wait`, regardless of whether that job is still in flight or long settled. Reusing the
 * accept path's own stable entity id (`comment.id`, `delivery.id`) is correct idempotency for
 * *that* job; it becomes a permanent stall for a sweeper, whose entire purpose is to re-enqueue
 * after the first job is gone.
 *
 * A job genuinely in flight ({@link IN_FLIGHT_JOB_STATES}) is left alone — that is the legitimate
 * no-op described in this module's docstring. A job retained in a terminal state is removed first,
 * then re-added. Either way the caller asserts the outcome rather than trusting `add()`'s resolved
 * promise: `add()` resolves the same way whether it scheduled new work or silently found the key
 * already taken, which is exactly the ambiguity that let C1 survive unnoticed.
 *
 * `logger.warn` fires only on the states that mean the re-enqueue itself did not work, never on the
 * in-flight no-op or on a job that was scheduled and actually ran (`completed`, `failed` — see the
 * inline comments below for why each is excluded, and why `failed` gets its own message).
 */
async function reenqueueStuckJob(
  queue: Queue,
  jobName: string,
  data: Record<string, unknown>,
  jobId: string,
  logger: WarnLogger,
): Promise<void> {
  const existing = await queue.getJob(jobId);
  if (existing !== undefined) {
    const state = await existing.getState();
    if (IN_FLIGHT_JOB_STATES.has(state)) {
      return;
    }
    await existing.remove();
  }

  const job = await queue.add(jobName, data, { jobId });
  const state = await job.getState();
  if (IN_FLIGHT_JOB_STATES.has(state)) {
    return;
  }
  // `completed` here counts as success, and reads like a bug until you see the race: the publish
  // queue runs at concurrency 10 and is usually idle when a sweep fires, so a worker can pick this
  // job up and finish it between the `add` above and this `getState`. Any stale job of the same id
  // was removed a few lines up, so nothing else could be reporting that state — the work was
  // scheduled and ran. Warning here anyway would fire on the healthy path, and this line is the
  // *only* signal that the recovery path is broken (C1 was invisible precisely because it had
  // none). An alert that also fires on success teaches an operator to scroll past the one that
  // matters.
  if (state === 'completed') {
    return;
  }
  if (state === 'failed') {
    // A job that failed this fast was scheduled and ran — it is not the "nothing is scheduled"
    // case the warning below means. It still went through `publishComment`/reconciliation (D14)
    // before failing, so this is a platform/adapter problem worth its own signal, not evidence the
    // re-enqueue itself didn't work.
    logger.warn(
      { jobId, jobName, state },
      'sweeper re-enqueued stuck work but the job failed immediately',
    );
    return;
  }
  logger.warn(
    { jobId, jobName, state },
    'sweeper decided work was stuck but could not schedule a job for it',
  );
}

export interface StuckWorkSweeperDeps {
  readonly database: NodePgDatabase;
  readonly publishQueue: Queue;
  /** Defaults to a no-op (see {@link WarnLogger}) — only `src/app/worker.ts` needs the real one. */
  readonly logger?: WarnLogger;
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

      const logger = deps.logger ?? SILENT_LOGGER;
      await Promise.all(
        commentIds.map((commentId) =>
          reenqueueStuckJob(deps.publishQueue, 'publish', { commentId }, commentId, logger),
        ),
      );
    },
  };
}

const UNPROCESSED_DELIVERY_AFTER_MS = 5 * 60_000;

export interface WebhookDeliverySweeperDeps {
  readonly database: NodePgDatabase;
  readonly webhookQueue: Queue;
  /** Defaults to a no-op (see {@link WarnLogger}) — only `src/app/worker.ts` needs the real one. */
  readonly logger?: WarnLogger;
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
      const logger = deps.logger ?? SILENT_LOGGER;

      await Promise.all(
        deliveryIds.map((deliveryId) =>
          reenqueueStuckJob(
            deps.webhookQueue,
            JOB_NAMES.processDelivery,
            { deliveryId },
            deliveryId,
            logger,
          ),
        ),
      );
    },
  };
}
