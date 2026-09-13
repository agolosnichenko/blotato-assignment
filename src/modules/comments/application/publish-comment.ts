/**
 * `PublishComment` — the worker-side publish attempt (T060, T060a, T062; spec.md §7.1 steps 5-7).
 *
 * `publish(commentId)` is the one entry point the `comment-publish` queue's worker calls; this
 * file owns every state transition that decides whether a customer's reply reached the platform
 * once, never twice (D14, SC-001), and returns a {@link PublishOutcome} telling the worker what
 * happened. It does not own re-enqueuing itself — the worker calls `moveToDelayed` for a `'retry'`
 * outcome — but it does own computing *how long*, since `delayMs` needs both the backoff ladder
 * (from `attempt_count`, which only this file's transactions touch) and the platform's own
 * `Retry-After` (from the adapter error only this file catches); splitting that arithmetic across
 * the boundary would leave neither side able to compute it alone.
 *
 * The four adapter error classes are already resolved by the platform adapter before this file
 * sees them (`src/platforms/types.ts`): `RetryableError` means nothing reached the platform,
 * `OutcomeUnknownError` means it might have, `PermanentError`/`AuthError` are final. This file's
 * only job is to honour that classification, never re-derive it — in particular,
 * `OutcomeUnknownError` never leads to a second `adapter.publishComment` call in the same attempt;
 * it leads to `reconcile-comment.ts`, and only that function's answer decides what happens next.
 *
 * The job payload carries only `commentId` (§7.1 step 4: `jobId = comment.id`), so `publish` has
 * no `workspaceId` to scope its first lookup with — `findTargetRow` reads the row directly by id,
 * once, to learn it. Every write after that goes through `CommentRepository`'s `workspaceId`-
 * scoped, conditional-`UPDATE` methods (D20, Principle III), the same as every other caller.
 */

// oxlint-disable max-lines -- one use case implementing every branch of §7.1 steps 5-7 (the
// success/retryable/outcome-unknown/permanent/auth-error/echo-race matrix the integration test
// exercises); splitting the settle* helpers across files would hide which of them share the
// conditional-UPDATE-then-outbox pattern instead of making that pattern easier to verify.
// oxlint-disable max-dependencies -- this use case is exactly the seam where the repository, the
// contact quota, both service-boundary ports, account health and the adapter registry meet;
// that is the shape of the publish path (§7.1), not something a refactor here would reduce.

import { and, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { reconcileComment } from '#src/modules/comments/application/reconcile-comment.ts';
import type { CommentRepository } from '#src/modules/comments/infrastructure/comment-repository.ts';
import type { AccountHealth } from '#src/modules/comments/infrastructure/account-health.ts';
import type { ContactQuota } from '#src/modules/comments/infrastructure/contact-quota.ts';
import {
  appendToOutbox,
  type OutboxEventInput,
  type OutboxTransaction as OutboxTx,
} from '#src/modules/comments/infrastructure/outbox.ts';
import { comments, outboxEvents } from '#src/modules/comments/infrastructure/schema.ts';
import type { AccountCredentials, Accounts } from '#src/modules/platform-core/ports.ts';
import type { AsyncErrorCode } from '#src/shared/errors.ts';
import {
  AuthError,
  OutcomeUnknownError,
  PermanentError,
  RetryableError,
  type AccountContext,
  type CommentPlatformAdapter,
  type Platform,
  type PublishedComment,
  type PublishInput,
  type ReconcileProbe,
} from '#src/platforms/types.ts';

/** §7.1 step 6: back to `queued` a bounded number of times before giving up for good. */
const MAX_PUBLISH_ATTEMPTS = 6;
/** §7.1 step 6's backoff ladder, indexed by the attempt ordinal (1-based) that just failed. */
const BACKOFF_SCHEDULE_MS = [1000, 4000, 16000, 64000, 256000] as const;
/** §7.1 step 6: `findPublishedComment`'s search window opens this far before the attempt. */
const RECONCILE_WINDOW_MS = 2 * 60 * 1000;
/** Postgres error code for a unique-index violation — the webhook-echo race's signature (§7.1.7). */
const UNIQUE_VIOLATION = '23505';

export interface PublishCommentDeps {
  readonly database: NodePgDatabase;
  readonly commentRepository: CommentRepository;
  readonly contactQuota: ContactQuota;
  readonly accounts: Accounts;
  readonly accountCredentials: AccountCredentials;
  readonly accountHealth: AccountHealth;
  readonly getAdapter: (platform: Platform) => CommentPlatformAdapter;
}

/**
 * What one `publish()` call decided, for the worker to act on.
 *
 * `'retry'` carries `delayMs` already resolved against both the backoff ladder and the platform's
 * `Retry-After` — the worker calls `moveToDelayed(delayMs)` and does no arithmetic of its own.
 * `'skipped'` is not an error: a conditional transition found the row already moved by another
 * worker, and there is nothing left for this attempt to do.
 */
export type PublishOutcome =
  | { readonly kind: 'posted' }
  | { readonly kind: 'failed'; readonly code: AsyncErrorCode }
  | { readonly kind: 'retry'; readonly attempt: number; readonly delayMs: number }
  | { readonly kind: 'skipped' };

export interface PublishComment {
  publish(commentId: string): Promise<PublishOutcome>;
}

/** The row fields one publish attempt needs — a local addition, not part of `CommentRepository`. */
interface TargetRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly socialAccountId: string;
  readonly platform: string;
  readonly postId: string | null;
  readonly platformPostId: string;
  readonly parentCommentId: string | null;
  readonly text: string | null;
  readonly attemptCount: number;
}

interface ParentSnapshot {
  readonly status: string;
  readonly platformCommentId: string | null;
}

function hasPgCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

/**
 * `pg` reports a unique-index violation as `code: '23505'` on the error it throws, but
 * drizzle-orm wraps that in its own `DrizzleQueryError` and moves the original onto `.cause`
 * (`node_modules/drizzle-orm/errors.js`) — so both the error and its cause must be checked.
 *
 * Exported so `create-reply.ts` and `create-top-level-comment.ts` can reuse it to recover from a
 * concurrent `comments_workspace_idempotency_key_key` violation, rather than duplicating the
 * `DrizzleQueryError` unwrapping a second time.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (hasPgCode(error, UNIQUE_VIOLATION)) {
    return true;
  }
  const cause = error instanceof Error ? error.cause : undefined;
  return hasPgCode(cause, UNIQUE_VIOLATION);
}

/**
 * The delay before the next attempt, honouring whichever of the ladder or `Retry-After` is
 * longer: the ladder is our own politeness toward the platform, `Retry-After` is the platform's
 * explicit instruction, and picking one over the other in either direction is wrong — a shorter
 * ladder delay would ignore what the platform just told us, and a shorter `Retry-After` would
 * ignore that we already hit it once on our own schedule.
 *
 * `attemptOrdinal` is always in `1..MAX_PUBLISH_ATTEMPTS - 1` here — the caller only reaches this
 * once it has already decided the run is *not* exhausted — so the ladder index is always in
 * bounds; the fallback exists only to satisfy `noUncheckedIndexedAccess`, not because it can fire.
 */
function backoffDelayMs(attemptOrdinal: number, retryAfterSeconds: number | undefined): number {
  const ladderDelayMs = BACKOFF_SCHEDULE_MS[attemptOrdinal - 1] ?? BACKOFF_SCHEDULE_MS.at(-1) ?? 0;
  const retryAfterMs = retryAfterSeconds === undefined ? 0 : retryAfterSeconds * 1000;
  return Math.max(ladderDelayMs, retryAfterMs);
}

/** Reads one comment by id, with no workspace to scope by yet — see the module docstring. */
async function findTargetRow(db: NodePgDatabase, commentId: string): Promise<TargetRow | null> {
  const [row] = await db
    .select({
      id: comments.id,
      workspaceId: comments.workspaceId,
      socialAccountId: comments.socialAccountId,
      platform: comments.platform,
      postId: comments.postId,
      platformPostId: comments.platformPostId,
      parentCommentId: comments.parentCommentId,
      text: comments.text,
      attemptCount: comments.attemptCount,
    })
    .from(comments)
    .where(eq(comments.id, commentId))
    .limit(1);
  return row ?? null;
}

async function findParentSnapshot(
  db: NodePgDatabase,
  parentCommentId: string,
): Promise<ParentSnapshot | null> {
  const [row] = await db
    .select({ status: comments.status, platformCommentId: comments.platformCommentId })
    .from(comments)
    .where(eq(comments.id, parentCommentId))
    .limit(1);
  return row ?? null;
}

async function loadAccountContext(
  deps: PublishCommentDeps,
  target: TargetRow,
): Promise<AccountContext> {
  const account = await deps.accounts.findById(target.socialAccountId);
  if (!account.found) {
    throw new PermanentError(`social account ${target.socialAccountId} not found`);
  }
  const credentials = await deps.accountCredentials.findBySocialAccountId(target.socialAccountId);
  if (!credentials.found) {
    throw new PermanentError(`credentials for social account ${target.socialAccountId} not found`);
  }
  return {
    workspaceId: target.workspaceId,
    socialAccountId: target.socialAccountId,
    platform: target.platform as Platform,
    platformAccountId: account.value.platformAccountId,
    credentials: credentials.value,
  };
}

/**
 * `processing -> failed`, releasing the quota reservation on success. A `false` from
 * `markFailed` means another worker already moved the row — the reservation stays whatever that
 * worker's own settlement left it as, so the release is skipped rather than run blind.
 */
async function settleFailed(
  deps: PublishCommentDeps,
  target: TargetRow,
  code: AsyncErrorCode,
  message: string,
): Promise<PublishOutcome> {
  const settled = await deps.database.transaction(async (tx) => {
    const updated = await deps.commentRepository.markFailed(tx, target.workspaceId, target.id, {
      errorCode: code,
      errorMessage: message,
    });
    if (!updated) {
      return false;
    }
    await appendToOutbox(tx, {
      workspaceId: target.workspaceId,
      type: 'comment.failed',
      aggregateId: target.id,
      data: { commentId: target.id, errorCode: code, errorMessage: message },
    });
    return true;
  });
  if (!settled) {
    return { kind: 'skipped' };
  }
  await deps.contactQuota.release({ workspaceId: target.workspaceId, commentId: target.id });
  return { kind: 'failed', code };
}

/**
 * `processing -> failed` for an `AuthError` (D30, A19, Principle II): the comment fails like any
 * other terminal error, but the account's state is recorded in `account_health` and announced as
 * `account.auth_failed` — never a write to `social_accounts`, which belongs to another service.
 * `account_health` is written through its own port after the transaction commits, since
 * `AccountHealth.markAuthFailed` does not accept a transaction handle to join.
 */
async function settleAuthFailed(
  deps: PublishCommentDeps,
  target: TargetRow,
  reason: string,
): Promise<PublishOutcome> {
  const settled = await deps.database.transaction(async (tx) => {
    const updated = await deps.commentRepository.markFailed(tx, target.workspaceId, target.id, {
      errorCode: 'PLATFORM_AUTH_FAILED',
      errorMessage: reason,
    });
    if (!updated) {
      return false;
    }
    await appendToOutbox(tx, {
      workspaceId: target.workspaceId,
      type: 'comment.failed',
      aggregateId: target.id,
      data: { commentId: target.id, errorCode: 'PLATFORM_AUTH_FAILED', errorMessage: reason },
    });
    await appendToOutbox(tx, {
      workspaceId: target.workspaceId,
      type: 'account.auth_failed',
      aggregateId: target.socialAccountId,
      data: { socialAccountId: target.socialAccountId, platform: target.platform, reason },
    });
    return true;
  });
  if (!settled) {
    return { kind: 'skipped' };
  }
  await deps.contactQuota.release({ workspaceId: target.workspaceId, commentId: target.id });
  await deps.accountHealth.markAuthFailed({
    socialAccountId: target.socialAccountId,
    workspaceId: target.workspaceId,
    reason,
  });
  return { kind: 'failed', code: 'PLATFORM_AUTH_FAILED' };
}

/**
 * `processing -> queued` for a bounded retry, or a terminal failure once `MAX_PUBLISH_ATTEMPTS`
 * is reached (§7.1 step 6, FR-012). `exhaustedCode` lets the caller record *why* the retries ran
 * out — rate limiting for `RetryableError`, an unresolved outcome for `OutcomeUnknownError` — in
 * the same `AsyncErrorCode` vocabulary `shared/errors.ts` already defines for this feature.
 * `retryAfterSeconds`, present only for a `RetryableError`, feeds {@link backoffDelayMs}.
 */
async function settleRetryOrExhausted(
  deps: PublishCommentDeps,
  target: TargetRow,
  exhaustedCode: AsyncErrorCode,
  retryAfterSeconds?: number,
): Promise<PublishOutcome> {
  const attemptOrdinal = target.attemptCount + 1;
  if (attemptOrdinal >= MAX_PUBLISH_ATTEMPTS) {
    return settleFailed(deps, target, exhaustedCode, `gave up after ${attemptOrdinal} attempts`);
  }
  const requeued = await deps.database.transaction((tx) =>
    deps.commentRepository.markQueuedForRetry(tx, target.workspaceId, target.id),
  );
  if (!requeued) {
    return { kind: 'skipped' };
  }
  return {
    kind: 'retry',
    attempt: attemptOrdinal,
    delayMs: backoffDelayMs(attemptOrdinal, retryAfterSeconds),
  };
}

/**
 * `processing -> posted` (§7.1 step 6). `markPosted`'s conditional `UPDATE` is also where the
 * webhook-echo race (§7.1 step 7) announces itself: if ingestion already inserted our own comment
 * under this `platform_comment_id`, the `UPDATE` collides with `comments`' unique index and
 * Postgres raises rather than returning zero rows, so it is caught here and handed to
 * {@link resolveWebhookEcho} rather than treated as an ordinary failed transition.
 */
async function settlePosted(
  deps: PublishCommentDeps,
  target: TargetRow,
  published: PublishedComment,
): Promise<PublishOutcome> {
  try {
    const updated = await deps.database.transaction(async (tx) => {
      const posted = await deps.commentRepository.markPosted(tx, target.workspaceId, target.id, {
        platformCommentId: published.platformCommentId,
      });
      if (!posted) {
        return false;
      }
      await appendToOutbox(tx, postedEvent(target, published));
      return true;
    });
    return updated ? { kind: 'posted' } : { kind: 'skipped' };
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
    return resolveWebhookEcho(deps, target, published);
  }
}

/**
 * §7.1 step 7, in one transaction: the ingested duplicate is deleted, its still-unpublished
 * `comment.received` row goes with it (relaying it would announce a comment nobody can ever read
 * — FR-025), and the API-created comment is promoted to `posted` in its place. A `comment.received`
 * row already relayed (`published_at` set) is left alone — consumers de-duplicate on the
 * aggregate, and `comment.posted` following it is expected at-least-once delivery, not a bug.
 */
async function resolveWebhookEcho(
  deps: PublishCommentDeps,
  target: TargetRow,
  published: PublishedComment,
): Promise<PublishOutcome> {
  await deps.database.transaction(async (tx) => {
    await deleteEchoedDuplicate(tx, target.socialAccountId, published.platformCommentId);

    const promoted = await deps.commentRepository.markPosted(tx, target.workspaceId, target.id, {
      platformCommentId: published.platformCommentId,
    });
    if (!promoted) {
      throw new Error(`publish-comment: failed to promote ${target.id} after the webhook echo`);
    }
    await appendToOutbox(tx, postedEvent(target, published));
  });
  return { kind: 'posted' };
}

/**
 * Deletes the comment ingestion already inserted under `platformCommentId`, and — only if it
 * hasn't been relayed yet — the `comment.received` outbox row that named it.
 */
async function deleteEchoedDuplicate(
  tx: OutboxTx,
  socialAccountId: string,
  platformCommentId: string,
): Promise<void> {
  const [duplicate] = await tx
    .select({ id: comments.id })
    .from(comments)
    .where(
      and(
        eq(comments.socialAccountId, socialAccountId),
        eq(comments.platformCommentId, platformCommentId),
      ),
    )
    .limit(1);
  if (duplicate === undefined) {
    throw new Error(
      `publish-comment: unique violation on ${platformCommentId} with no duplicate row`,
    );
  }

  await tx
    .delete(outboxEvents)
    .where(
      and(
        eq(outboxEvents.aggregateId, duplicate.id),
        eq(outboxEvents.type, 'comment.received'),
        isNull(outboxEvents.publishedAt),
      ),
    );
  await tx.delete(comments).where(eq(comments.id, duplicate.id));
}

/** The `comment.posted` outbox payload (contracts/domain-events.md) — shared by both settle paths. */
function postedEvent(target: TargetRow, published: PublishedComment): OutboxEventInput {
  return {
    workspaceId: target.workspaceId,
    type: 'comment.posted',
    aggregateId: target.id,
    data: {
      commentId: target.id,
      socialAccountId: target.socialAccountId,
      platform: target.platform,
      postId: target.postId,
      parentCommentId: target.parentCommentId,
      platformCommentId: published.platformCommentId,
    },
  };
}

/**
 * `OutcomeUnknownError` (T061, D14): the one path that must never repeat `adapter.publishComment`
 * without going through `reconcile-comment.ts` first. A search failure (the function throws)
 * propagates rather than being treated as "not found" — the comment is left `processing` for a
 * later attempt to reconcile again, since neither a send nor a blind retry is safe without an
 * answer.
 */
async function handleOutcomeUnknown(
  deps: PublishCommentDeps,
  target: TargetRow,
  ctx: AccountContext,
  adapter: CommentPlatformAdapter,
  parentPlatformCommentId: string | null,
  attemptStartedAt: Date,
): Promise<PublishOutcome> {
  const probe: ReconcileProbe = {
    platformPostId: target.platformPostId,
    platformParentId: parentPlatformCommentId,
    authorPlatformId: ctx.platformAccountId,
    text: target.text ?? '',
    windowStartsAt: new Date(attemptStartedAt.getTime() - RECONCILE_WINDOW_MS),
  };
  const result = await reconcileComment(adapter, ctx, probe);
  if (result.found) {
    return settlePosted(deps, target, result.published);
  }
  return settleRetryOrExhausted(deps, target, 'OUTCOME_UNKNOWN');
}

function handlePublishError(
  deps: PublishCommentDeps,
  target: TargetRow,
  ctx: AccountContext,
  adapter: CommentPlatformAdapter,
  parentPlatformCommentId: string | null,
  attemptStartedAt: Date,
  error: unknown,
): Promise<PublishOutcome> {
  if (error instanceof RetryableError) {
    return settleRetryOrExhausted(deps, target, 'PLATFORM_RATE_LIMITED', error.retryAfter);
  }
  if (error instanceof OutcomeUnknownError) {
    return handleOutcomeUnknown(
      deps,
      target,
      ctx,
      adapter,
      parentPlatformCommentId,
      attemptStartedAt,
    );
  }
  if (error instanceof PermanentError) {
    return settleFailed(deps, target, 'PLATFORM_REJECTED', error.message);
  }
  if (error instanceof AuthError) {
    return settleAuthFailed(deps, target, error.message);
  }
  throw error;
}

/**
 * One publish attempt: loads the account context, calls the adapter exactly once, and settles
 * the outcome. Loading the context (account + credentials) can itself fail before the adapter is
 * ever reached — that is handled the same as `PermanentError`, since nothing was sent either way.
 */
async function attemptSend(
  deps: PublishCommentDeps,
  target: TargetRow,
  parentPlatformCommentId: string | null,
  attemptStartedAt: Date,
): Promise<PublishOutcome> {
  let ctx: AccountContext;
  let adapter: CommentPlatformAdapter;
  try {
    ctx = await loadAccountContext(deps, target);
    adapter = deps.getAdapter(target.platform as Platform);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return settleFailed(deps, target, 'PLATFORM_REJECTED', message);
  }

  const input: PublishInput = {
    platformPostId: target.platformPostId,
    platformParentId: parentPlatformCommentId,
    text: target.text ?? '',
  };

  try {
    const published = await adapter.publishComment(ctx, input);
    return await settlePosted(deps, target, published);
  } catch (error) {
    return handlePublishError(
      deps,
      target,
      ctx,
      adapter,
      parentPlatformCommentId,
      attemptStartedAt,
      error,
    );
  }
}

/**
 * Runs one publish attempt for `commentId` (§7.1 steps 5-7).
 *
 * Args:
 *   deps: The ports and repository this use case is built from.
 *   commentId: The comment to publish — the `comment-publish` job's whole payload (`jobId =
 *     comment.id`), so this is also the first place `workspaceId` becomes known.
 *
 * Returns:
 *   The {@link PublishOutcome} this attempt settled on, for the worker to act on (in particular,
 *   to schedule a `'retry'`'s delay — this function does not enqueue anything itself).
 */
async function publish(deps: PublishCommentDeps, commentId: string): Promise<PublishOutcome> {
  const target = await findTargetRow(deps.database, commentId);
  if (target === null) {
    return { kind: 'skipped' };
  }

  const attemptStartedAt = new Date();
  const claimed = await deps.database.transaction((tx) =>
    deps.commentRepository.markProcessing(tx, target.workspaceId, commentId),
  );
  if (!claimed) {
    return { kind: 'skipped' };
  }

  let parentPlatformCommentId: string | null = null;
  if (target.parentCommentId !== null) {
    const parent = await findParentSnapshot(deps.database, target.parentCommentId);
    if (parent === null || parent.status === 'deleted') {
      return settleFailed(
        deps,
        target,
        'PARENT_DELETED',
        'the parent comment was deleted after this reply was queued',
      );
    }
    parentPlatformCommentId = parent.platformCommentId;
  }

  return attemptSend(deps, target, parentPlatformCommentId, attemptStartedAt);
}

/** Backs {@link PublishComment}; construct once per worker with a database handle and its ports. */
export function createPublishComment(deps: PublishCommentDeps): PublishComment {
  return { publish: (commentId: string) => publish(deps, commentId) };
}
