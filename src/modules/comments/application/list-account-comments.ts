/**
 * `GET /v1/accounts/:accountId/comments` use case (T093, FR-008, D13).
 *
 * The account inbox: every comment on the account, spanning posts published through this
 * platform and posts that never were, together in one page, newest first by default. It is the
 * one read path that does not resolve tenancy through the `posts` projection — that is exactly
 * the point (A10a): a comment's `postId` can stop resolving without taking the comment with it,
 * because `comments` carries no foreign key to `posts` (D8, D29) and `listByAccount` never joins
 * it. Tenancy here is resolved through the `Accounts` port instead, the same "other workspace's
 * resource is 404, never 403" rule `listPostComments` applies to `Posts` (D20).
 */

import type {
  CommentRecord,
  CommentRepository,
  ListByAccountFilters,
} from '#src/modules/comments/infrastructure/comment-repository.ts';
import type { Accounts } from '#src/modules/platform-core/ports.ts';
import { ApiError } from '#src/shared/errors.ts';
import type { KeysetCursor, SortOrder } from '#src/shared/pagination.ts';
import type { WorkspaceId } from '#src/shared/ids.ts';

export interface ListAccountCommentsDeps {
  readonly repository: CommentRepository;
  readonly accounts: Accounts;
}

export interface ListAccountCommentsInput {
  readonly workspaceId: WorkspaceId;
  readonly accountId: string;
  readonly limit: number;
  readonly cursor: KeysetCursor | null;
  readonly order: SortOrder;
  readonly since: Date | null;
  readonly until: Date | null;
  readonly isOwn: boolean | null;
}

export interface ListAccountCommentsResult {
  readonly items: readonly CommentRecord[];
  readonly nextCursor: KeysetCursor | null;
}

/**
 * Builds {@link ListByAccountFilters} from the input's nullable fields, omitting each key rather
 * than setting it `undefined` — `exactOptionalPropertyTypes` treats the two differently, and the
 * repository's filters are meant to be absent, not present-but-empty, when unfiltered.
 */
function toRepositoryFilters(input: ListAccountCommentsInput): ListByAccountFilters {
  return {
    ...(input.since !== null && { since: input.since }),
    ...(input.until !== null && { until: input.until }),
    ...(input.isOwn !== null && { isOwn: input.isOwn }),
  };
}

/**
 * Lists one account's inbox for its owning workspace.
 *
 * Args:
 *   deps: The read repository and the `Accounts` port used only to resolve tenancy (never joined).
 *   input: The workspace, account, filter and pagination parameters.
 *
 * Returns:
 *   The page of comments.
 *
 * Raises:
 *   ApiError: `NOT_FOUND` when `accountId` does not resolve to an account in `workspaceId`.
 */
export async function listAccountComments(
  deps: ListAccountCommentsDeps,
  input: ListAccountCommentsInput,
): Promise<ListAccountCommentsResult> {
  const account = await deps.accounts.findById(input.accountId);
  if (!account.found || account.value.workspaceId !== input.workspaceId) {
    throw new ApiError('NOT_FOUND', `no account ${input.accountId} in this workspace`);
  }

  const page = await deps.repository.listByAccount(
    input.workspaceId,
    input.accountId,
    toRepositoryFilters(input),
    { limit: input.limit, cursor: input.cursor, order: input.order },
  );

  return { items: page.items, nextCursor: page.nextCursor };
}
