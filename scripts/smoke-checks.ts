/**
 * Pure decision functions for `scripts/smoke.ts` (T108, SC-012).
 *
 * Everything here is transport-free: environment validation and the assertions the walkthrough
 * makes against already-fetched response bodies. Kept separate from `smoke.ts` so the decision
 * logic is testable without a server (see `scripts/smoke.test.ts`) and so `smoke.ts` itself stays
 * under the project's 300-line-per-file limit.
 */

import { z } from 'zod';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const smokeEnvSchema = z.object({
  SMOKE_BASE_URL: z.string().refine(
    (value) => {
      try {
        return ['http:', 'https:'].includes(new URL(value).protocol);
      } catch {
        return false;
      }
    },
    { message: 'must be an http(s) URL' },
  ),
  SMOKE_API_KEY: z.string().min(1, { message: 'must not be empty' }),
  SMOKE_INSTAGRAM_POST_ID: z.string().regex(UUID_PATTERN, { message: 'must be a UUID' }),
  SMOKE_BLUESKY_POST_ID: z.string().regex(UUID_PATTERN, { message: 'must be a UUID' }),
});

export type SmokeEnv = z.infer<typeof smokeEnvSchema>;

/**
 * Validates the smoke-test environment and fails fast with every problem listed.
 *
 * Args:
 *   env: Environment to read; defaults to `process.env`.
 *
 * Returns:
 *   The four validated smoke-test variables.
 *
 * Raises:
 *   Error: If any variable is missing or malformed, naming every offending variable at once.
 */
export function parseSmokeEnv(env: NodeJS.ProcessEnv = process.env): SmokeEnv {
  const result = smokeEnvSchema.safeParse(env);
  if (result.success) {
    return result.data;
  }
  const details = result.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid smoke-test environment configuration:\n${details}`);
}

/** One platform entry from `GET /v1/platforms` (openapi.json). */
export interface PlatformCapability {
  readonly platform: string;
  readonly supportsComments: boolean;
  readonly unsupportedReason?: string;
}

/** The subset of a comment's fields the walkthrough inspects (openapi.json `commentSchema`). */
export interface CommentRecord {
  readonly id: string;
  readonly status: string;
  readonly occurredAt: string;
  readonly depth: number;
  readonly error: { readonly code: string; readonly message: string } | null;
}

/** The subset of a sync job's fields the walkthrough inspects (openapi.json). */
export interface SyncJobRecord {
  readonly id: string;
  readonly status: string;
  readonly error: string | null;
  readonly stats: { fetched: number; inserted: number; updated: number; deleted: number } | null;
}

const EXPECTED_PLATFORM_COUNT = 9;
const EXPECTED_COMMENT_CAPABLE_COUNT = 3;

/**
 * Checks the `GET /v1/platforms` response against SC-012's step 1.
 *
 * Args:
 *   items: The `items` array of the platforms response.
 *
 * Raises:
 *   Error: If the total isn't 9, comment-capable isn't exactly 3, or any of the other 6 is
 *     missing a stated `unsupportedReason`.
 */
export function assertPlatformsCapabilities(items: readonly PlatformCapability[]): void {
  if (items.length !== EXPECTED_PLATFORM_COUNT) {
    throw new Error(`expected ${EXPECTED_PLATFORM_COUNT} platforms, got ${items.length}`);
  }
  const commentCapable = items.filter((item) => item.supportsComments);
  if (commentCapable.length !== EXPECTED_COMMENT_CAPABLE_COUNT) {
    const names = commentCapable.map((item) => item.platform).join(', ');
    throw new Error(
      `expected ${EXPECTED_COMMENT_CAPABLE_COUNT} comment-capable platforms, got ` +
        `${commentCapable.length} (${names})`,
    );
  }
  const unreasoned = items.filter(
    (item) => !item.supportsComments && (item.unsupportedReason?.length ?? 0) === 0,
  );
  if (unreasoned.length > 0) {
    const names = unreasoned.map((item) => item.platform).join(', ');
    throw new Error(`platform(s) without a stated unsupportedReason: ${names}`);
  }
}

/**
 * Checks that a comments page is sorted newest-first by `occurredAt`.
 *
 * Args:
 *   items: The page's comments, in response order.
 *
 * Raises:
 *   Error: On the first adjacent pair that is not strictly descending, naming both timestamps.
 */
export function assertDescendingOccurredAt(items: readonly { occurredAt: string }[]): void {
  for (let index = 1; index < items.length; index += 1) {
    const previous = items[index - 1];
    const current = items[index];
    if (previous === undefined || current === undefined) {
      continue;
    }
    const previousTime = new Date(previous.occurredAt).getTime();
    const currentTime = new Date(current.occurredAt).getTime();
    // An unparseable timestamp yields NaN, and every comparison against NaN is false — so without
    // this the ordering check would pass on a page it could not actually order.
    if (Number.isNaN(previousTime) || Number.isNaN(currentTime)) {
      // The value's *type* is correct, a string; what is wrong is its content, which is an
      // ordinary assertion failure. Every other failure here throws Error, and the caller catches
      // one kind.
      // oxlint-disable-next-line unicorn/prefer-type-error
      throw new Error(
        `unparseable occurredAt at index ${index}: ` +
          `${previous.occurredAt} / ${current.occurredAt}`,
      );
    }
    if (currentTime > previousTime) {
      throw new Error(
        `comments not newest-first at index ${index}: ` +
          `${previous.occurredAt} is before ${current.occurredAt}`,
      );
    }
  }
}

/**
 * Reports whether an HTTP response is the `422 REPLY_DEPTH_EXCEEDED` problem body (D12).
 *
 * The status code alone is not proof: a Zod validation failure is also a `422`, so the `code`
 * field of the RFC 9457 body is what actually distinguishes them.
 *
 * Args:
 *   status: The response's HTTP status.
 *   body: The parsed response body.
 *
 * Returns:
 *   `true` only if `status` is 422 and `body.code` is exactly `"REPLY_DEPTH_EXCEEDED"`.
 */
export function isReplyDepthExceededProblem(status: number, body: unknown): boolean {
  if (status !== 422 || typeof body !== 'object' || body === null) {
    return false;
  }
  return (body as { code?: unknown }).code === 'REPLY_DEPTH_EXCEEDED';
}

/** What a poll of `GET /v1/comments/:id` should do next. */
export type CommentPollOutcome = 'continue' | 'posted' | 'failed';

/**
 * Classifies a polled comment status into the next polling action.
 *
 * Args:
 *   status: The comment's current `status` field.
 *
 * Returns:
 *   `'posted'` or `'failed'` for the two terminal states this walkthrough recognizes, else
 *   `'continue'`.
 */
export function commentPollOutcome(status: string): CommentPollOutcome {
  if (status === 'posted') {
    return 'posted';
  }
  if (status === 'failed') {
    return 'failed';
  }
  return 'continue';
}

/** What a poll of `GET /v1/comment-sync-jobs/:jobId` should do next. */
export type SyncJobPollOutcome = 'continue' | 'succeeded' | 'failed';

/**
 * Classifies a polled sync job status into the next polling action.
 *
 * Args:
 *   status: The job's current `status` field.
 *
 * Returns:
 *   `'succeeded'` or `'failed'` for the two terminal states, else `'continue'`.
 */
export function syncJobPollOutcome(status: string): SyncJobPollOutcome {
  if (status === 'succeeded') {
    return 'succeeded';
  }
  if (status === 'failed') {
    return 'failed';
  }
  return 'continue';
}

/**
 * Checks that an identifier-free `GET /v1/comments` response carries no `sync` key (D31, FR-006, R-08; V4 of
 * `specs/002-flat-comment-listing/quickstart.md`): the block only exists when a post is named, and
 * its presence here would mean the collection is quietly treating the inbox as if one were.
 *
 * Args:
 *   body: The parsed response body of the identifier-free listing.
 *
 * Raises:
 *   Error: If `body` is an object carrying a `sync` key.
 */
export function assertInboxHasNoSyncBlock(body: unknown): void {
  if (typeof body === 'object' && body !== null && 'sync' in body) {
    throw new Error(
      `identifier-free listing must not carry a sync block, got: ${JSON.stringify(body)}`,
    );
  }
}

/** An assertion failure in one named step of the walkthrough, carrying the response as evidence. */
export class SmokeFailure extends Error {
  constructor(step: string, expected: string, actual: string, responseBody?: unknown) {
    const bodyLine =
      responseBody === undefined ? '' : `\n  response body: ${JSON.stringify(responseBody)}`;
    super(`[${step}] expected ${expected}, got ${actual}${bodyLine}`);
    this.name = 'SmokeFailure';
  }
}
