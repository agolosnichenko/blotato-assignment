/**
 * Re-enqueueing work a sweeper found stuck, given BullMQ's `Queue.add` silently doing nothing when
 * the `jobId` already names a retained job (C1).
 *
 * Its own module because both sweepers in `sweepers.ts` need it and because the reasoning below is
 * about BullMQ's semantics, not about either sweeper's selector — the two concerns drifted into one
 * file and the file outgrew its line budget, which was the signal to split them.
 */

import type { Queue } from 'bullmq';
import type { Logger } from 'pino';

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
export type WarnLogger = Pick<Logger, 'warn'>;

export const SILENT_LOGGER: WarnLogger = { warn: () => {} };

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
 * `logger.warn` fires only on the states that mean the re-enqueue itself did not work — not on the
 * in-flight no-op (the common, healthy case on every tick), and not on `completed` (the freshly
 * added job ran to completion before this function checked, which the in-line comment below
 * explains). `failed` gets its own message: that job was scheduled and ran, which is a different
 * problem than "nothing is scheduled", and conflating the two would hide whichever is more urgent.
 */
export async function reenqueueStuckJob(
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
