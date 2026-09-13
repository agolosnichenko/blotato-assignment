/**
 * `GET /v1/comments` use case (T015, US1, D31).
 *
 * The workspace-wide moderation inbox: one call to `repository.list`, no branch that picks a
 * query shape or an index — that is `selectionPredicate`'s job (comment-repository.ts) and the
 * index choice is Postgres's planner's (research.md R-04). Unlike `listPostComments` and
 * `listReplies`, this use case resolves no identifier through a port before reading: an
 * identifier-free request must answer from the API key alone (FR-005), and an identifier-shaped
 * filter's tenancy resolution is a later phase's addition, not this one's.
 */

import type {
  CommentRecord,
  CommentRepository,
  CommentSelection,
} from '#src/modules/comments/infrastructure/comment-repository.ts';
import type { KeysetCursor, SortOrder } from '#src/shared/pagination.ts';
import type { WorkspaceId } from '#src/shared/ids.ts';

export interface ListCommentsDeps {
  readonly repository: CommentRepository;
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
}

/**
 * Lists the workspace's comments across every connected account and every post.
 *
 * Args:
 *   deps: The read repository.
 *   input: The workspace, selection and pagination parameters.
 *
 * Returns:
 *   The page of comments the selection and pagination parameters describe.
 */
export function listComments(
  deps: ListCommentsDeps,
  input: ListCommentsInput,
): Promise<ListCommentsResult> {
  return deps.repository.list(input.workspaceId, input.selection, {
    limit: input.limit,
    cursor: input.cursor,
    order: input.order,
  });
}
