/**
 * `GET /v1/comments/:commentId` use case (T047, FR-007).
 *
 * One comment by id — the polling target a client hits after a `202 queued` write to watch it
 * move to `posted`/`failed`. A direct lookup, not a list: the placeholder rule (FR-005) does not
 * apply here, since it exists to keep a deleted-but-referenced comment's thread navigable, not to
 * hide a comment the caller already has the id for.
 */

import type {
  CommentRecord,
  CommentRepository,
} from '#src/modules/comments/infrastructure/comment-repository.ts';
import { ApiError } from '#src/shared/errors.ts';

export interface GetCommentDeps {
  readonly repository: CommentRepository;
}

export interface GetCommentInput {
  readonly workspaceId: string;
  readonly commentId: string;
}

/**
 * Fetches one comment by id, scoped to its workspace.
 *
 * Args:
 *   deps: The read repository.
 *   input: The workspace and comment id.
 *
 * Returns:
 *   The comment.
 *
 * Raises:
 *   ApiError: `NOT_FOUND` when `commentId` does not resolve in `workspaceId`.
 */
export async function getComment(
  deps: GetCommentDeps,
  input: GetCommentInput,
): Promise<CommentRecord> {
  const comment = await deps.repository.getById(input.workspaceId, input.commentId);
  if (comment === null) {
    throw new ApiError('NOT_FOUND', `no comment ${input.commentId} in this workspace`);
  }
  return comment;
}
