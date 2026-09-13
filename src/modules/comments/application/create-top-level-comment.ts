/**
 * `POST /v1/posts/:postId/comments` use case (T059; spec.md §7.1 steps 1-4, FR-015, A7, D13).
 *
 * The same pre-flight and transaction shape as `create-reply.ts`, adapted for a top-level comment
 * on an internally published post: the "load the parent" step becomes "load the post" through the
 * `Posts` port, and there is no reply-depth check or contact-quota reservation — a top-level
 * comment has no parent to nest under and contacts no specific person (D16 scopes the monthly
 * allowance to replying to an audience member, not to posting under your own content). A `postId`
 * with no internal row is unreachable by construction: the route is keyed by the internal id, and
 * a post this service has never seen published simply has none (FR-015, A7, D13).
 *
 * `insertQueued` on `CommentRepository` (T056) now accepts `parentCommentId: null` for exactly
 * this case: depth 0, no parent to bump, and the row is its own root, so `last_activity_at` is set
 * on the row itself at insert — all derived by the repository, not repeated here.
 *
 * The enqueue of `comment-publish` happens strictly after the transaction commits, keyed on
 * `jobId = comment.id` (§7.1 step 4, A15); a failed enqueue is logged and swallowed, exactly as in
 * `create-reply.ts` — the stuck-work sweeper covers it.
 *
 * Two simultaneous requests carrying the same `Idempotency-Key` both pass `resolveIdempotency`
 * before either has committed, reach the insert together, and `comments_workspace_idempotency_
 * key_key` lets exactly one through — the loser's transaction fails with a unique violation rather
 * than returning the inserted row. This mirrors `create-reply.ts`: catch that violation
 * (`isUniqueViolation`, reused from `publish-comment.ts`) and re-read the winner by idempotency
 * key, so both callers get `202` with the same comment instead of one getting `500`.
 */

// oxlint-disable max-dependencies -- this use case wires every port its pre-flight and its
// transaction touch (the repository, `Posts`, `Accounts`, the outbox writer, the registry, the
// database and the publish queue); splitting the file would not reduce that, only hide it behind
// re-exports.

import { createHash } from 'node:crypto';
import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import { isUniqueViolation } from '#src/modules/comments/application/publish-comment.ts';
import { checkTextLength } from '#src/modules/comments/domain/limits.ts';
import type {
  CommentRecord,
  CommentRepository,
} from '#src/modules/comments/infrastructure/comment-repository.ts';
import { appendToOutbox } from '#src/modules/comments/infrastructure/outbox.ts';
import type {
  Accounts,
  Posts,
  PostRecord,
  SocialAccountRecord,
} from '#src/modules/platform-core/ports.ts';
import { lookupCapabilities, type PlatformCapabilities } from '#src/platforms/registry.ts';
import type { Database } from '#src/shared/db.ts';
import { ApiError } from '#src/shared/errors.ts';
import type { WorkspaceId } from '#src/shared/ids.ts';

type SupportedPlatformCapabilities = Extract<
  PlatformCapabilities,
  { readonly supportsComments: true }
>;

export interface CreateTopLevelCommentDeps {
  readonly database: Database;
  readonly repository: CommentRepository;
  readonly posts: Posts;
  readonly accounts: Accounts;
  readonly publishQueue: Queue;
  readonly logger: Logger;
}

export interface CreateTopLevelCommentInput {
  readonly workspaceId: WorkspaceId;
  readonly postId: string;
  readonly text: string;
  readonly idempotencyKey: string | null;
}

function hashRequestText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function loadPost(
  deps: CreateTopLevelCommentDeps,
  input: CreateTopLevelCommentInput,
): Promise<PostRecord> {
  const post = await deps.posts.findById(input.postId);
  if (!post.found || post.value.workspaceId !== input.workspaceId) {
    throw new ApiError('NOT_FOUND', `no post ${input.postId} in this workspace`);
  }
  return post.value;
}

function assertSupportsComments(platform: string): SupportedPlatformCapabilities {
  // A platform this service has no entry for is the same answer as one whose entry says "no":
  // the caller cannot comment on it. Indexing the registry with a cast instead produced
  // `undefined` and a `TypeError`, i.e. a 500 where 422 is the truthful status.
  const capabilities = lookupCapabilities(platform);
  if (capabilities === undefined || !capabilities.supportsComments) {
    throw new ApiError('PLATFORM_NOT_SUPPORTED', `${platform} does not support comments`);
  }
  return capabilities;
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

async function assertAccountActive(
  accounts: Accounts,
  workspaceId: WorkspaceId,
  socialAccountId: string,
): Promise<SocialAccountRecord> {
  const account = await accounts.findById(socialAccountId);
  if (!account.found || account.value.workspaceId !== workspaceId) {
    throw new ApiError('ACCOUNT_DISCONNECTED', `account ${socialAccountId} is not reachable`);
  }
  if (account.value.status !== 'active') {
    throw new ApiError('ACCOUNT_DISCONNECTED', `account ${socialAccountId} is disconnected`);
  }
  return account.value;
}

/** Same idempotency resolution as `create-reply.ts`: match → return existing, mismatch → `409` (A12). */
async function resolveIdempotency(
  repository: CommentRepository,
  workspaceId: WorkspaceId,
  idempotencyKey: string | null,
  text: string,
): Promise<CommentRecord | null> {
  if (idempotencyKey === null) {
    return null;
  }
  const existing = await repository.findByIdempotencyKey(workspaceId, idempotencyKey);
  if (existing === null) {
    return null;
  }
  if (hashRequestText(existing.text ?? '') !== hashRequestText(text)) {
    throw new ApiError(
      'IDEMPOTENCY_KEY_REUSED',
      `idempotency key ${idempotencyKey} was already used with a different request body`,
    );
  }
  return existing;
}

function insertTopLevelTransactionally(
  deps: CreateTopLevelCommentDeps,
  input: CreateTopLevelCommentInput,
  post: PostRecord,
  account: SocialAccountRecord,
): Promise<CommentRecord> {
  return deps.database.drizzle.transaction(async (tx) => {
    // `parentCommentId: null` is what makes this a top-level insert (depth 0, own root,
    // `last_activity_at` set on itself) — `insertQueued` derives the rest (see module docstring).
    const comment = await deps.repository.insertQueued(tx, input.workspaceId, {
      socialAccountId: post.socialAccountId,
      platform: post.platform,
      postId: post.id,
      platformPostId: post.platformPostId,
      parentCommentId: null,
      authorPlatformId: account.platformAccountId,
      text: input.text,
      idempotencyKey: input.idempotencyKey,
    });

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

/**
 * Recovers from a concurrent insert under the same idempotency key: the conflicting request
 * committed first, so its row is read back and returned in place of retrying the insert — re-runs
 * the same mismatch check `resolveIdempotency` would have made had it arrived a moment later.
 */
async function resolveIdempotencyConflict(
  repository: CommentRepository,
  workspaceId: WorkspaceId,
  idempotencyKey: string | null,
  text: string,
): Promise<CommentRecord | null> {
  if (idempotencyKey === null) {
    return null;
  }
  const winner = await repository.findByIdempotencyKey(workspaceId, idempotencyKey);
  if (winner === null) {
    return null;
  }
  if (hashRequestText(winner.text ?? '') !== hashRequestText(text)) {
    throw new ApiError(
      'IDEMPOTENCY_KEY_REUSED',
      `idempotency key ${idempotencyKey} was already used with a different request body`,
    );
  }
  return winner;
}

/** Enqueues `comment-publish`; a failure is logged, not thrown — see the module docstring. */
async function enqueuePublish(
  deps: CreateTopLevelCommentDeps,
  comment: CommentRecord,
): Promise<void> {
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
 * Accepts a top-level comment on an internally published post.
 *
 * Args:
 *   deps: The repository, the `Posts` and `Accounts` ports, the publish queue and a logger.
 *   input: The workspace, the post id, the comment text and an optional idempotency key.
 *
 * Returns:
 *   The `queued` comment — freshly inserted, or the one a matching idempotency key already named.
 *
 * Raises:
 *   ApiError: `NOT_FOUND`, `PLATFORM_NOT_SUPPORTED`, `TEXT_TOO_LONG`, `ACCOUNT_DISCONNECTED` or
 *     `IDEMPOTENCY_KEY_REUSED`.
 */
export async function createTopLevelComment(
  deps: CreateTopLevelCommentDeps,
  input: CreateTopLevelCommentInput,
): Promise<CommentRecord> {
  const post = await loadPost(deps, input);
  const capabilities = assertSupportsComments(post.platform);
  assertTextAllowed(capabilities, input.text);
  const account = await assertAccountActive(deps.accounts, input.workspaceId, post.socialAccountId);

  const existing = await resolveIdempotency(
    deps.repository,
    input.workspaceId,
    input.idempotencyKey,
    input.text,
  );
  if (existing !== null) {
    return existing;
  }

  let comment: CommentRecord;
  try {
    comment = await insertTopLevelTransactionally(deps, input, post, account);
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
    const winner = await resolveIdempotencyConflict(
      deps.repository,
      input.workspaceId,
      input.idempotencyKey,
      input.text,
    );
    if (winner === null) {
      throw error;
    }
    return winner;
  }
  await enqueuePublish(deps, comment);
  return comment;
}
