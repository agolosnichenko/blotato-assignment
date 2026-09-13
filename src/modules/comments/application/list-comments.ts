/**
 * `GET /v1/comments` use case (T015, T026, T027, US1, US2, D31).
 *
 * The workspace-wide moderation inbox: one call to `repository.list`, no branch that picks a
 * query shape or an index — that is `selectionPredicate`'s job (comment-repository.ts) and the
 * index choice is Postgres's planner's (research.md R-04). Every identifier-shaped filter
 * (`postId`, `accountId`, `parentCommentId`) is resolved against its owning port *before* the
 * query runs and only when that filter is present (R-07) — an identifier-free request answers
 * from the API key alone (FR-005), asking no other service anything.
 *
 * `sync` is reported iff the selection names a post (R-08): the condition is "a post is named",
 * not "some identifier filter is present" — an `accountId`- or `parentCommentId`-only selection
 * gets no `sync` block either.
 */

import type {
  CommentRecord,
  CommentRepository,
  CommentSelection,
} from '#src/modules/comments/infrastructure/comment-repository.ts';
import type { Accounts, Posts } from '#src/modules/platform-core/ports.ts';
import { ApiError } from '#src/shared/errors.ts';
import type { KeysetCursor, SortOrder } from '#src/shared/pagination.ts';
import type { WorkspaceId } from '#src/shared/ids.ts';

export interface ListCommentsDeps {
  readonly repository: CommentRepository;
  readonly posts: Posts;
  readonly accounts: Accounts;
}

export interface ListCommentsInput {
  readonly workspaceId: WorkspaceId;
  readonly selection: CommentSelection;
  readonly limit: number;
  readonly cursor: KeysetCursor | null;
  readonly order: SortOrder;
}

export interface ListCommentsResult {
  readonly items: readonly CommentRecord[];
  readonly nextCursor: KeysetCursor | null;
  readonly sync?: { readonly lastSyncedAt: Date | null; readonly activeJobId: string | null };
}

/** Resolves `postId` through the `Posts` port; `404 NOT_FOUND` outside this workspace (D20). */
async function resolvePostId(
  deps: ListCommentsDeps,
  workspaceId: WorkspaceId,
  postId: string,
): Promise<void> {
  const post = await deps.posts.findById(postId);
  if (!post.found || post.value.workspaceId !== workspaceId) {
    throw new ApiError('NOT_FOUND', `no post ${postId} in this workspace`);
  }
}

/** Resolves `accountId` through the `Accounts` port; `404 NOT_FOUND` outside this workspace (D20). */
async function resolveAccountId(
  deps: ListCommentsDeps,
  workspaceId: WorkspaceId,
  accountId: string,
): Promise<void> {
  const account = await deps.accounts.findById(accountId);
  if (!account.found || account.value.workspaceId !== workspaceId) {
    throw new ApiError('NOT_FOUND', `no account ${accountId} in this workspace`);
  }
}

/** Resolves `parentCommentId` through this service's own repository; `404 NOT_FOUND` outside this
 * workspace (D20) — a comment is this service's own row, never a port call (R-07). */
async function resolveParentCommentId(
  deps: ListCommentsDeps,
  workspaceId: WorkspaceId,
  parentCommentId: string,
): Promise<void> {
  const parent = await deps.repository.getById(workspaceId, parentCommentId);
  if (parent === null) {
    throw new ApiError('NOT_FOUND', `no comment ${parentCommentId} in this workspace`);
  }
}

/**
 * Resolves tenancy for every identifier-shaped filter actually present in `selection` — and calls
 * no port at all when none is (T026, R-07, FR-005).
 */
async function resolveIdentifierFilters(
  deps: ListCommentsDeps,
  workspaceId: WorkspaceId,
  selection: CommentSelection,
): Promise<void> {
  const resolutions: Promise<void>[] = [];
  if (selection.postId !== undefined) {
    resolutions.push(resolvePostId(deps, workspaceId, selection.postId));
  }
  if (selection.accountId !== undefined) {
    resolutions.push(resolveAccountId(deps, workspaceId, selection.accountId));
  }
  if (selection.parentCommentId !== undefined) {
    resolutions.push(resolveParentCommentId(deps, workspaceId, selection.parentCommentId));
  }
  await Promise.all(resolutions);
}

/**
 * Lists the workspace's comments across every connected account and every post.
 *
 * Args:
 *   deps: The read repository and the `Posts`/`Accounts` ports used only to resolve tenancy
 *     (never joined).
 *   input: The workspace, selection and pagination parameters.
 *
 * Returns:
 *   The page of comments the selection and pagination parameters describe, plus `sync` iff the
 *   selection names a post.
 *
 * Raises:
 *   ApiError: `NOT_FOUND` when a present identifier filter does not resolve in `workspaceId`.
 */
export async function listComments(
  deps: ListCommentsDeps,
  input: ListCommentsInput,
): Promise<ListCommentsResult> {
  // Tenancy must be resolved before either query below runs (a foreign postId/accountId/
  // parentCommentId must 404, never leak a page or a sync block) — but once it has, the list read
  // and the sync lookup are independent and belong in the same round trip, the same concurrency
  // listPostComments (the use case this one replaces) gave them (FR-013).
  await resolveIdentifierFilters(deps, input.workspaceId, input.selection);

  const postId = input.selection.postId;
  const [page, sync] = await Promise.all([
    deps.repository.list(input.workspaceId, input.selection, {
      limit: input.limit,
      cursor: input.cursor,
      order: input.order,
    }),
    postId === undefined ? undefined : deps.repository.getSyncStatus(input.workspaceId, postId),
  ]);

  return {
    items: page.items,
    nextCursor: page.nextCursor,
    ...(sync !== undefined && { sync }),
  };
}
