/**
 * `POST /v1/comments/:commentId/replies` use case (T058; spec.md §7.1 steps 1-4).
 *
 * Pre-flight (step 1): load the parent inside the workspace scope (`404` otherwise), then check
 * platform capability (T099, FR-031), reply depth (D12, registry-driven), text length, that the
 * parent is `posted`, and that the account is effectively `active` (D30, through the `Accounts`
 * port, never the raw projection column). Idempotency (step 2) is resolved only after the
 * pre-flight passes, by hashing the request text against the comment the key already names (A12).
 * Step 3 is one transaction: `ContactQuota.reserve` (skipped when replying to yourself — D16), the
 * queued insert, the outbox write.
 *
 * `reserve` runs *after* `insertQueued`, not before as §7.1 step 3's prose lists them:
 * `insertQueued` generates the comment id `reserve`'s usage row must carry, so there is no way to
 * know it beforehand. Both share one transaction, so a rejected reservation rolls the insert back
 * regardless of order.
 *
 * `comment-publish` is enqueued strictly after commit, keyed on `jobId = comment.id` (§7.1 step 4,
 * A15). A failed enqueue is logged and swallowed — the row is already durable, and the stuck-work
 * sweeper re-enqueues any `queued` comment older than a minute with no active job.
 */

// oxlint-disable max-dependencies -- this use case wires every port its pre-flight and its
// transaction touch (the repository, `Accounts`, `ContactQuota`, the outbox writer, the registry,
// the database and the publish queue); splitting the file would not reduce that, only hide it
// behind re-exports.
// oxlint-disable max-lines -- each of the pre-flight checks (T058, T099) is already its own named
// helper function below, not one long function; after trimming every docstring that could be
// trimmed without losing the reasoning it records, the file still sits a handful of lines over the
// 300-line default. Splitting the checks across files would scatter one use case's contract rather
// than shrink it — the same trade `comment-repository.ts` makes for the same rule.

import { createHash } from 'node:crypto';
import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import { checkReplyDepth, checkTextLength } from '#src/modules/comments/domain/limits.ts';
import type {
  CommentRecord,
  CommentRepository,
} from '#src/modules/comments/infrastructure/comment-repository.ts';
import type { ContactQuota } from '#src/modules/comments/infrastructure/contact-quota.ts';
import {
  appendToOutbox,
  type OutboxTransaction,
} from '#src/modules/comments/infrastructure/outbox.ts';
import type { Accounts, SocialAccountRecord } from '#src/modules/platform-core/ports.ts';
import { platformRegistry, type PlatformCapabilities } from '#src/platforms/registry.ts';
import type { Platform } from '#src/platforms/types.ts';
import type { Database } from '#src/shared/db.ts';
import { ApiError } from '#src/shared/errors.ts';

type SupportedPlatformCapabilities = Extract<
  PlatformCapabilities,
  { readonly supportsComments: true }
>;

export interface CreateReplyDeps {
  readonly database: Database;
  readonly repository: CommentRepository;
  readonly accounts: Accounts;
  readonly contactQuota: ContactQuota;
  readonly publishQueue: Queue;
  readonly logger: Logger;
}

export interface CreateReplyInput {
  readonly workspaceId: string;
  readonly parentCommentId: string;
  readonly text: string;
  readonly idempotencyKey: string | null;
}

function hashRequestText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function loadParent(deps: CreateReplyDeps, input: CreateReplyInput): Promise<CommentRecord> {
  const parent = await deps.repository.getById(input.workspaceId, input.parentCommentId);
  if (parent === null) {
    throw new ApiError('NOT_FOUND', `no comment ${input.parentCommentId} in this workspace`);
  }
  return parent;
}

/**
 * Walks from `parent` to its top-level ancestor via `parentCommentId` (`CommentRecord` has no
 * `root_comment_id`), only once a depth violation is already known — `REPLY_DEPTH_EXCEEDED` names
 * the top-level comment, and the common, allowed case never pays for this walk.
 */
async function resolveRootCommentId(
  repository: CommentRepository,
  workspaceId: string,
  parent: CommentRecord,
): Promise<string> {
  let current = parent;
  while (current.parentCommentId !== null) {
    // Each hop depends on the previous one's result (the next ancestor to fetch is only known
    // once the current one comes back), so there is nothing here `Promise.all` could parallelize.
    // oxlint-disable-next-line no-await-in-loop
    const ancestor = await repository.getById(workspaceId, current.parentCommentId);
    if (ancestor === null) {
      throw new Error(`create-reply: ancestor ${current.parentCommentId} not found`);
    }
    current = ancestor;
  }
  return current.id;
}

function assertSupportsComments(platform: string): SupportedPlatformCapabilities {
  const capabilities = platformRegistry[platform as Platform];
  if (!capabilities.supportsComments) {
    throw new ApiError('PLATFORM_NOT_SUPPORTED', `${platform} does not support comments`);
  }
  return capabilities;
}

async function assertDepthAllowed(
  repository: CommentRepository,
  workspaceId: string,
  capabilities: SupportedPlatformCapabilities,
  parent: CommentRecord,
): Promise<void> {
  const result = checkReplyDepth(capabilities, parent.depth);
  if (result.allowed) {
    return;
  }
  const rootCommentId = await resolveRootCommentId(repository, workspaceId, parent);
  throw new ApiError(
    'REPLY_DEPTH_EXCEEDED',
    `reply would exceed maxReplyDepth ${result.maxReplyDepth} for thread ${rootCommentId}`,
  );
}

function assertTextAllowed(capabilities: SupportedPlatformCapabilities, text: string): void {
  const result = checkTextLength(capabilities, text);
  if (!result.allowed) {
    throw new ApiError(
      'TEXT_TOO_LONG',
      `text is ${result.length} ${capabilities.textUnit}, limit is ${result.limit}`,
    );
  }
}

function assertParentPosted(parent: CommentRecord): void {
  if (parent.status !== 'posted') {
    throw new ApiError(
      'PARENT_NOT_POSTED',
      `parent comment ${parent.id} is ${parent.status}, not posted`,
    );
  }
}

/** `parent.workspaceId` doubles as the caller's workspace — `getById` already scoped the lookup to it. */
async function assertAccountActive(
  accounts: Accounts,
  parent: CommentRecord,
): Promise<SocialAccountRecord> {
  const account = await accounts.findById(parent.socialAccountId);
  if (!account.found || account.value.workspaceId !== parent.workspaceId) {
    throw new ApiError(
      'ACCOUNT_DISCONNECTED',
      `account ${parent.socialAccountId} is not reachable`,
    );
  }
  if (account.value.status !== 'active') {
    throw new ApiError('ACCOUNT_DISCONNECTED', `account ${parent.socialAccountId} is disconnected`);
  }
  return account.value;
}

/**
 * Returns the previously-created comment on a matching idempotency key, `null` when there is no
 * key or no prior request, and throws `409` on a key reused with a different body (A12).
 */
async function resolveIdempotency(
  repository: CommentRepository,
  input: CreateReplyInput,
): Promise<CommentRecord | null> {
  if (input.idempotencyKey === null) {
    return null;
  }
  const existing = await repository.findByIdempotencyKey(input.workspaceId, input.idempotencyKey);
  if (existing === null) {
    return null;
  }
  if (hashRequestText(existing.text ?? '') !== hashRequestText(input.text)) {
    throw new ApiError(
      'IDEMPOTENCY_KEY_REUSED',
      `idempotency key ${input.idempotencyKey} was already used with a different request body`,
    );
  }
  return existing;
}

/** Reserves the monthly contact allowance, skipping it when the parent's author is the account itself. */
async function reserveQuotaIfNeeded(
  tx: OutboxTransaction,
  deps: CreateReplyDeps,
  workspaceId: string,
  parent: CommentRecord,
  account: SocialAccountRecord,
  commentId: string,
): Promise<void> {
  if (parent.authorPlatformId === account.platformAccountId) {
    return;
  }
  if (parent.authorPlatformId === null) {
    throw new Error(`create-reply: parent ${parent.id} has no author to reserve quota against`);
  }

  const reservation = await deps.contactQuota.reserve(tx, {
    workspaceId,
    platform: parent.platform as Platform,
    contactPlatformId: parent.authorPlatformId,
    commentId,
  });
  if (!reservation.ok) {
    throw new ApiError(
      'QUOTA_EXCEEDED',
      `workspace ${workspaceId} has no contact allowance left this period`,
    );
  }
}

function insertReplyTransactionally(
  deps: CreateReplyDeps,
  input: CreateReplyInput,
  parent: CommentRecord,
  account: SocialAccountRecord,
): Promise<CommentRecord> {
  return deps.database.drizzle.transaction(async (tx) => {
    const comment = await deps.repository.insertQueued(tx, input.workspaceId, {
      socialAccountId: parent.socialAccountId,
      platform: parent.platform,
      postId: parent.postId,
      platformPostId: parent.platformPostId,
      parentCommentId: parent.id,
      authorPlatformId: account.platformAccountId,
      text: input.text,
      idempotencyKey: input.idempotencyKey,
    });

    await reserveQuotaIfNeeded(tx, deps, input.workspaceId, parent, account, comment.id);

    await appendToOutbox(tx, {
      workspaceId: input.workspaceId,
      type: 'comment.received',
      aggregateId: comment.id,
      data: {
        commentId: comment.id,
        socialAccountId: comment.socialAccountId,
        platform: comment.platform,
        postId: comment.postId,
        platformPostId: comment.platformPostId,
        parentCommentId: comment.parentCommentId,
        isOwn: true,
        authorPlatformId: comment.authorPlatformId,
        text: comment.text,
        ingestionSource: 'api',
      },
    });

    return comment;
  });
}

/** Enqueues `comment-publish`; a failure is logged, not thrown — see the module docstring. */
async function enqueuePublish(deps: CreateReplyDeps, comment: CommentRecord): Promise<void> {
  try {
    await deps.publishQueue.add('publish', { commentId: comment.id }, { jobId: comment.id });
  } catch (error) {
    deps.logger.error(
      { err: error, commentId: comment.id },
      'failed to enqueue comment-publish job; the stuck-work sweeper will retry it',
    );
  }
}

/**
 * Accepts a reply to an existing, posted comment.
 *
 * Returns the `queued` comment — freshly inserted, or the one a matching idempotency key already
 * named. Raises `ApiError` with one of `NOT_FOUND`, `PLATFORM_NOT_SUPPORTED`,
 * `REPLY_DEPTH_EXCEEDED`, `TEXT_TOO_LONG`, `PARENT_NOT_POSTED`, `ACCOUNT_DISCONNECTED`,
 * `IDEMPOTENCY_KEY_REUSED` or `QUOTA_EXCEEDED`.
 */
export async function createReply(
  deps: CreateReplyDeps,
  input: CreateReplyInput,
): Promise<CommentRecord> {
  const parent = await loadParent(deps, input);
  const capabilities = assertSupportsComments(parent.platform);

  await assertDepthAllowed(deps.repository, input.workspaceId, capabilities, parent);
  assertTextAllowed(capabilities, input.text);
  assertParentPosted(parent);
  const account = await assertAccountActive(deps.accounts, parent);

  const existing = await resolveIdempotency(deps.repository, input);
  if (existing !== null) {
    return existing;
  }

  const comment = await insertReplyTransactionally(deps, input, parent, account);
  await enqueuePublish(deps, comment);
  return comment;
}
