/**
 * `GET /v1/comments/:commentId/replies` use case (T046, FR-002, FR-003, D11).
 *
 * Direct replies of one comment, as their own separately paged list (D11 — a reply thread is
 * never inlined into its parent's page). The parent is looked up first so an unknown or
 * foreign-workspace `commentId` is `404 NOT_FOUND` rather than a confusingly-empty page (D20).
 */

import type {
  CommentRecord,
  CommentRepository,
} from '#src/modules/comments/infrastructure/comment-repository.ts';
import { ApiError } from '#src/shared/errors.ts';
import type { KeysetCursor, SortOrder } from '#src/shared/pagination.ts';

export interface ListRepliesDeps {
  readonly repository: CommentRepository;
}

export interface ListRepliesInput {
  readonly workspaceId: string;
  readonly parentCommentId: string;
  readonly limit: number;
  readonly cursor: KeysetCursor | null;
  readonly order: SortOrder;
}

export interface ListRepliesResult {
  readonly items: readonly CommentRecord[];
  readonly nextCursor: KeysetCursor | null;
}

/**
 * Lists the direct replies of one comment, oldest first by default.
 *
 * Args:
 *   deps: The read repository.
 *   input: The workspace, parent comment and pagination parameters.
 *
 * Returns:
 *   The page of direct replies.
 *
 * Raises:
 *   ApiError: `NOT_FOUND` when `parentCommentId` does not resolve in `workspaceId`.
 */
export async function listReplies(
  deps: ListRepliesDeps,
  input: ListRepliesInput,
): Promise<ListRepliesResult> {
  const parent = await deps.repository.getById(input.workspaceId, input.parentCommentId);
  if (parent === null) {
    throw new ApiError('NOT_FOUND', `no comment ${input.parentCommentId} in this workspace`);
  }

  return deps.repository.listRepliesByParent(input.workspaceId, input.parentCommentId, {
    limit: input.limit,
    cursor: input.cursor,
    order: input.order,
  });
}
