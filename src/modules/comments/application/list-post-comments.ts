/**
 * `GET /v1/posts/:postId/comments` use case (T045, FR-001, FR-006).
 *
 * A post's top-level comments, plus the `sync` block reporting how fresh they are. The route is
 * `404 NOT_FOUND` for a `postId` this workspace cannot see — not just an unknown id, but one that
 * belongs to another workspace, or one that has never been published through the platform and so
 * has no internal `postId` to begin with (D13, contracts/rest-api.md). That check is what turns
 * "zero comments" and "no such post" into different responses; the repository alone cannot tell
 * them apart, since an empty `comments` result is valid for a real, quiet post.
 */

import type {
  CommentRecord,
  CommentRepository,
} from '#src/modules/comments/infrastructure/comment-repository.ts';
import type { Posts } from '#src/modules/platform-core/ports.ts';
import { ApiError } from '#src/shared/errors.ts';
import type { KeysetCursor, SortOrder } from '#src/shared/pagination.ts';

export interface ListPostCommentsDeps {
  readonly repository: CommentRepository;
  readonly posts: Posts;
}

export interface ListPostCommentsInput {
  readonly workspaceId: string;
  readonly postId: string;
  readonly limit: number;
  readonly cursor: KeysetCursor | null;
  readonly order: SortOrder;
}

export interface ListPostCommentsResult {
  readonly items: readonly CommentRecord[];
  readonly nextCursor: KeysetCursor | null;
  readonly sync: { readonly lastSyncedAt: Date | null; readonly activeJobId: string | null };
}

/**
 * Lists a post's top-level comments for its owning workspace.
 *
 * Args:
 *   deps: The read repository and the `Posts` port used only to resolve tenancy (never joined).
 *   input: The workspace, post and pagination parameters.
 *
 * Returns:
 *   The page plus the post's sync freshness.
 *
 * Raises:
 *   ApiError: `NOT_FOUND` when `postId` does not resolve to a post in `workspaceId`.
 */
export async function listPostComments(
  deps: ListPostCommentsDeps,
  input: ListPostCommentsInput,
): Promise<ListPostCommentsResult> {
  const post = await deps.posts.findById(input.postId);
  if (!post.found || post.value.workspaceId !== input.workspaceId) {
    throw new ApiError('NOT_FOUND', `no post ${input.postId} in this workspace`);
  }

  const [page, sync] = await Promise.all([
    deps.repository.listTopLevelByPost(input.workspaceId, input.postId, {
      limit: input.limit,
      cursor: input.cursor,
      order: input.order,
    }),
    deps.repository.getSyncStatus(input.workspaceId, input.postId),
  ]);

  return { items: page.items, nextCursor: page.nextCursor, sync };
}
