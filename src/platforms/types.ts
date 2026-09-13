/**
 * Platform adapter port (spec.md §4.3, §8; contracts/platform-adapter.md).
 *
 * Every publishing platform implements `CommentPlatformAdapter` against these types. Use cases
 * depend only on this file, never on a concrete platform or on the Instagram `auth_variant`
 * (D28) — that distinction is resolved inside the Meta Graph client alone (Principle IV).
 */

// oxlint-disable max-classes-per-file -- the contract requires the four typed errors below to
// live together in this file, alongside the ports they belong to; splitting them would fragment
// the port that later adapters and use cases import from.

import type { WorkspaceId } from '#src/shared/ids.ts';

/** The nine publishing platforms; only three currently support comments (registry.ts). */
export type Platform =
  | 'instagram'
  | 'facebook'
  | 'bluesky'
  | 'threads'
  | 'x'
  | 'linkedin'
  | 'youtube'
  | 'tiktok'
  | 'pinterest';

/**
 * The connected account an adapter call acts on, plus its decrypted credentials.
 *
 * Credentials are obtained through the `AccountCredentials` port (D26) — an adapter never reads
 * `social_accounts` itself. Their shape is platform-specific (a Meta token vs. a Bluesky session),
 * so this port carries them as `unknown`; each adapter narrows what it expects to receive. The
 * Instagram `auth_variant` (D28) is part of that Meta-specific credential shape, not this generic
 * struct — it must stay unreadable to every adapter except the Meta Graph client
 * (`src/platforms/meta/graph-client.ts`), Bluesky and the six unsupported platforms included.
 */
export interface AccountContext {
  readonly workspaceId: WorkspaceId;
  readonly socialAccountId: string;
  readonly platform: Platform;
  readonly platformAccountId: string;
  readonly credentials: unknown;
}

/** The platform-native post a comment thread hangs off. */
export interface PostTarget {
  readonly platformPostId: string;
}

/**
 * One page of a comment listing walk; a `null` cursor means the walk is complete.
 *
 * `deletedPlatformCommentIds` carries platform comment ids an adapter can tell are deleted by an
 * explicit signal (e.g. Bluesky's `notFoundPost` tombstone, §8.3) — kept apart from `comments`
 * rather than folded into it as a marked `NormalizedComment`. A consumer iterating `comments`
 * would otherwise upsert a tombstone as an ordinary `posted` row, and recording it as *seen* would
 * suppress the absence-based deletion a complete walk is meant to fall back to — the exact defect
 * this shape exists to make unreachable (spec.md §18, extends §8.3 and this contract). A platform
 * with no such signal (Facebook, Instagram) always returns this empty and relies solely on the
 * absence fallback.
 */
export interface CommentPage {
  readonly comments: readonly NormalizedComment[];
  readonly deletedPlatformCommentIds: readonly string[];
  readonly nextCursor: string | null;
}

/** What to publish: a top-level comment (`platformParentId: null`) or a reply. */
export interface PublishInput {
  readonly platformPostId: string;
  readonly platformParentId: string | null;
  readonly text: string;
}

/** The platform's confirmation that a comment now exists. */
export interface PublishedComment {
  readonly platformCommentId: string;
  readonly platformCreatedAt: Date;
}

/**
 * What `findPublishedComment` searches for after an `OutcomeUnknownError` (FR-011, SC-001):
 * our own comment, by author, parent, text and a time window opening at
 * `last_attempt_started_at − 2min`.
 */
export interface ReconcileProbe {
  readonly platformPostId: string;
  readonly platformParentId: string | null;
  readonly authorPlatformId: string;
  readonly text: string;
  readonly windowStartsAt: Date;
}

/** A comment as read back from a platform, independent of that platform's wire format. */
export interface NormalizedComment {
  readonly platformCommentId: string;
  readonly platformParentId: string | null;
  /**
   * `null` when the platform did not tell us who wrote it — a commenter the connected account
   * cannot see, which Meta signals by omitting `from` entirely.
   *
   * Distinct from the empty string an adapter used to substitute: every anonymous commenter then
   * shared one `contact_quota_usage` key, so a whole workspace's anonymous contacts consumed a
   * single unit of the monthly allowance between them (D16), and `create-reply.ts`'s explicit
   * "no author to reserve quota against" guard could never fire.
   */
  readonly authorPlatformId: string | null;
  readonly authorUsername: string | null;
  readonly authorDisplayName: string | null;
  readonly text: string;
  readonly platformCreatedAt: Date;
  /** Platform-specific extras an adapter needs later (e.g. the Bluesky `cid`). */
  readonly platformMeta: Record<string, unknown>;
}

/** The four methods every comment-capable platform must implement identically. */
export interface CommentPlatformAdapter {
  readonly platform: Platform;
  listComments(ctx: AccountContext, target: PostTarget, cursor?: string): Promise<CommentPage>;
  publishComment(ctx: AccountContext, input: PublishInput): Promise<PublishedComment>;
  findPublishedComment(
    ctx: AccountContext,
    probe: ReconcileProbe,
  ): Promise<PublishedComment | null>;
  fetchComment(ctx: AccountContext, platformCommentId: string): Promise<NormalizedComment | null>;
}

/**
 * Raised for 429s, 5xxs, or a network failure *before* the request reached the platform.
 *
 * The worker returns the job to `queued` and retries with backoff, honouring `retryAfter` (seconds)
 * when the platform supplied one.
 */
export class RetryableError extends Error {
  override readonly name = 'RetryableError';
  readonly retryAfter: number | undefined;

  constructor(message: string, options?: { retryAfter?: number; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.retryAfter = options?.retryAfter;
  }
}

/**
 * Raised on a timeout or connection drop *after* the write request was sent — the adapter cannot
 * tell whether the platform received it.
 *
 * This is the one error that forbids a blind retry (D14, Principle III): the worker must call
 * `findPublishedComment` first and only treat the job as retryable if it comes back empty.
 */
export class OutcomeUnknownError extends Error {
  override readonly name = 'OutcomeUnknownError';
}

/** Raised for a 4xx or an explicit platform rejection. The job fails and its quota is released. */
export class PermanentError extends Error {
  override readonly name = 'PermanentError';
}

/**
 * Raised when the credential itself is invalid.
 *
 * The failure is recorded in this service's own `account_health` table and announced via the
 * outbox as `account.auth_failed` (D30) — never as a write to the `social_accounts` projection,
 * which stays inside the platform-core service boundary (D8, D29).
 */
export class AuthError extends Error {
  override readonly name = 'AuthError';
}

/**
 * The closed set of errors an adapter is allowed to raise for a platform failure.
 *
 * Every classifier returns this union rather than `Error`, so a new branch that forgets to wrap
 * its failure in one of the four types fails to compile instead of falling through the
 * `instanceof` chain in `publish-comment.ts` and being rethrown unclassified.
 *
 * A programmer error (a bug in a client, a credential for the wrong platform) is deliberately not
 * a member: it never reached the platform, so it is rethrown untouched rather than classified.
 */
export type AdapterError = RetryableError | OutcomeUnknownError | PermanentError | AuthError;

/**
 * Whether a failed call was reading from the platform or writing to it.
 *
 * The distinction only matters for failures that prove the request arrived — a 5xx answer to a
 * write may have created the comment before failing, so it is an unknown outcome, while the same
 * status on a read is merely retryable (D14).
 */
export type AdapterOperation = 'read' | 'write';
