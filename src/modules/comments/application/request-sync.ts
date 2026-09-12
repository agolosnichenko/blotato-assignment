/**
 * `RequestSync` — D19's manual refresh semantics (T089), plus the `SyncJob` read `routes.ts` (T090)
 * needs for `GET /v1/comment-sync-jobs/:jobId`.
 *
 * `request()` backs `POST /v1/posts/:postId/comments/sync` (contracts/rest-api.md `SyncJob`):
 *   1. An active job (`queued`/`running`) already exists for the post's target → return it,
 *      enqueueing nothing new (covers a request arriving while one is `queued` *or* `running` —
 *      "active" spans both).
 *   2. Otherwise, inside the 60-second cooldown (`manual_cooldown_until > now()`) →
 *      `429 SYNC_COOLDOWN`. The cooldown is checked *before* a job row is created, never after —
 *      a request that is about to be rejected must not also consume the cooldown window itself or
 *      create a row nobody asked to see.
 *   3. Otherwise, create a `comment_sync_jobs` row (`trigger: manual`), set the cooldown, and
 *      enqueue it on the `comment-sync` queue. This runs even for a *deactivated* target
 *      (`next_sync_at: null`) — D19's point being that a manual request is a human saying "try
 *      anyway"; `sync-post.ts`'s own success path is what restores the schedule, not this file.
 *
 * The partial unique index on `comment_sync_jobs (target_id) WHERE status IN ('queued','running')`
 * (data-model.md §3) is what actually prevents two active jobs for one target — step 3's insert
 * races a concurrent caller (another manual request, or the scheduler) the same way
 * `sync-target-repository.ts`'s `ensureTarget` races concurrent callers: lose the conflict, read
 * back whichever job won, and hand that one back rather than erroring.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Queue } from 'bullmq';
import type { SyncPostStats } from '#src/modules/comments/application/sync-post.ts';
import { commentSyncJobs } from '#src/modules/comments/infrastructure/schema.ts';
import type {
  SyncTargetRecord,
  SyncTargetRepository,
} from '#src/modules/comments/infrastructure/sync-target-repository.ts';
import type { Posts } from '#src/modules/platform-core/ports.ts';
import { ApiError } from '#src/shared/errors.ts';

export type SyncJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export type SyncJobTrigger = 'manual' | 'scheduled' | 'post_published';

export interface SyncJobRecord {
  readonly id: string;
  readonly status: SyncJobStatus;
  readonly trigger: SyncJobTrigger;
  readonly stats: SyncPostStats | null;
  readonly error: string | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
}

export interface RequestSyncDeps {
  readonly database: NodePgDatabase;
  readonly posts: Posts;
  readonly syncTargetRepository: SyncTargetRepository;
  /** The `comment-sync` queue (`QUEUE_NAMES.commentSync`) — `sync-scheduler.ts` owns its worker. */
  readonly syncQueue: Queue;
  /** `config.SYNC_MANUAL_COOLDOWN_SECONDS` (D19: 60s default) — injected, never a literal here. */
  readonly manualCooldownSeconds: number;
}

export interface RequestSyncInput {
  readonly workspaceId: string;
  readonly postId: string;
}

export interface GetSyncJobInput {
  readonly workspaceId: string;
  readonly jobId: string;
}

export interface RequestSync {
  request(input: RequestSyncInput): Promise<SyncJobRecord>;
  getJob(input: GetSyncJobInput): Promise<SyncJobRecord>;
}

const ACTIVE_JOB_STATUSES = ['queued', 'running'] as const;

const JOB_COLUMNS = {
  id: commentSyncJobs.id,
  trigger: commentSyncJobs.trigger,
  status: commentSyncJobs.status,
  stats: commentSyncJobs.stats,
  error: commentSyncJobs.error,
  createdAt: commentSyncJobs.createdAt,
  startedAt: commentSyncJobs.startedAt,
  finishedAt: commentSyncJobs.finishedAt,
} as const;

/** The shape `JOB_COLUMNS` actually selects — not the full `commentSyncJobs` row (no `targetId`/
 * `workspaceId`, neither of which this module's callers need). */
interface JobRow {
  readonly id: string;
  readonly trigger: string;
  readonly status: string;
  readonly stats: SyncPostStats | null;
  readonly error: string | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
}

function toSyncJobRecord(row: JobRow): SyncJobRecord {
  return {
    id: row.id,
    status: row.status as SyncJobStatus,
    trigger: row.trigger as SyncJobTrigger,
    stats: row.stats ?? null,
    error: row.error,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

async function findActiveJob(db: NodePgDatabase, targetId: string): Promise<JobRow | null> {
  const [row] = await db
    .select(JOB_COLUMNS)
    .from(commentSyncJobs)
    .where(
      and(
        eq(commentSyncJobs.targetId, targetId),
        inArray(commentSyncJobs.status, ACTIVE_JOB_STATUSES),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Inserts a `manual` job row, racing the partial unique index against a concurrent caller the
 * same way `sync-target-repository.ts`'s `ensureTarget` does — `null` means this insert lost.
 */
async function insertManualJob(
  db: NodePgDatabase,
  target: SyncTargetRecord,
): Promise<JobRow | null> {
  const [inserted] = await db
    .insert(commentSyncJobs)
    .values({
      workspaceId: target.workspaceId,
      targetId: target.id,
      trigger: 'manual',
      status: 'queued',
      stats: null,
      error: null,
    })
    .onConflictDoNothing({
      target: [commentSyncJobs.targetId],
      where: sql`${commentSyncJobs.status} in ('queued', 'running')`,
    })
    .returning(JOB_COLUMNS);
  return inserted ?? null;
}

/** Creates the manual job and sets the cooldown — or, on a lost race, returns the winner's job. */
async function createManualJob(deps: RequestSyncDeps, target: SyncTargetRecord): Promise<JobRow> {
  const inserted = await insertManualJob(deps.database, target);
  if (inserted !== null) {
    const cooldownUntil = new Date(Date.now() + deps.manualCooldownSeconds * 1000);
    await deps.syncTargetRepository.setManualCooldown(target.id, cooldownUntil);
    return inserted;
  }

  const active = await findActiveJob(deps.database, target.id);
  if (active === null) {
    throw new Error(
      `request-sync: conflicted creating a job for target ${target.id} but found none on read-back`,
    );
  }
  return active;
}

function isInCooldown(target: SyncTargetRecord): boolean {
  return target.manualCooldownUntil !== null && target.manualCooldownUntil.getTime() > Date.now();
}

/**
 * Resolves `input.postId` to its refresh target, scoped to `input.workspaceId` (D20: another
 * workspace's post, or one with no target yet, is `404 NOT_FOUND`, never `403`).
 */
async function resolveTarget(
  deps: RequestSyncDeps,
  input: RequestSyncInput,
): Promise<SyncTargetRecord> {
  const post = await deps.posts.findById(input.postId);
  if (!post.found || post.value.workspaceId !== input.workspaceId) {
    throw new ApiError('NOT_FOUND', `no post ${input.postId} in this workspace`);
  }
  const target = await deps.syncTargetRepository.findByPostId(input.postId);
  if (target === null) {
    throw new ApiError('NOT_FOUND', `post ${input.postId} has no refresh target yet`);
  }
  return target;
}

async function request(deps: RequestSyncDeps, input: RequestSyncInput): Promise<SyncJobRecord> {
  const target = await resolveTarget(deps, input);

  const activeJob = await findActiveJob(deps.database, target.id);
  if (activeJob !== null) {
    return toSyncJobRecord(activeJob);
  }

  if (isInCooldown(target)) {
    throw new ApiError('SYNC_COOLDOWN', 'a manual refresh was requested too recently');
  }

  const job = await createManualJob(deps, target);
  await deps.syncQueue.add('sync', { targetId: target.id }, { jobId: job.id });
  return toSyncJobRecord(job);
}

async function getJob(deps: RequestSyncDeps, input: GetSyncJobInput): Promise<SyncJobRecord> {
  const [row] = await deps.database
    .select(JOB_COLUMNS)
    .from(commentSyncJobs)
    .where(
      and(eq(commentSyncJobs.id, input.jobId), eq(commentSyncJobs.workspaceId, input.workspaceId)),
    )
    .limit(1);
  if (row === undefined) {
    throw new ApiError('NOT_FOUND', `no sync job ${input.jobId} in this workspace`);
  }
  return toSyncJobRecord(row);
}

/** Backs {@link RequestSync}; construct once per container with the ports and queue it needs. */
export function createRequestSync(deps: RequestSyncDeps): RequestSync {
  return {
    request: (input) => request(deps, input),
    getJob: (input) => getJob(deps, input),
  };
}
