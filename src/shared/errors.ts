/**
 * RFC 9457 `application/problem+json` error catalogue (§6.3).
 *
 * The catalogue has two disjoint groups. `SyncErrorCode` is returned as an HTTP response body
 * through {@link ApiError} and {@link toProblemDetails}. `AsyncErrorCode` is recorded on a
 * `failed` comment's `error_code` column and never leaves the service as a response — it has no
 * HTTP status and no path through `ApiError`, so a use case cannot return it by accident.
 */

const SYNC_ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  IDEMPOTENCY_KEY_REUSED: 409,
  PLATFORM_NOT_SUPPORTED: 422,
  REPLY_DEPTH_EXCEEDED: 422,
  TEXT_TOO_LONG: 422,
  PARENT_NOT_POSTED: 422,
  ACCOUNT_DISCONNECTED: 422,
  QUOTA_EXCEEDED: 422,
  RATE_LIMITED: 429,
  SYNC_COOLDOWN: 429,
} as const satisfies Record<string, number>;

const SYNC_ERROR_TITLE = {
  VALIDATION_ERROR: 'Validation Error',
  UNAUTHORIZED: 'Unauthorized',
  NOT_FOUND: 'Not Found',
  IDEMPOTENCY_KEY_REUSED: 'Idempotency Key Reused',
  PLATFORM_NOT_SUPPORTED: 'Platform Not Supported',
  REPLY_DEPTH_EXCEEDED: 'Reply Depth Exceeded',
  TEXT_TOO_LONG: 'Text Too Long',
  PARENT_NOT_POSTED: 'Parent Not Posted',
  ACCOUNT_DISCONNECTED: 'Account Disconnected',
  QUOTA_EXCEEDED: 'Quota Exceeded',
  RATE_LIMITED: 'Rate Limited',
  SYNC_COOLDOWN: 'Sync Cooldown',
} as const satisfies Record<SyncErrorCode, string>;

/** Codes a REST endpoint can return in a response body (contracts/rest-api.md §Error codes). */
export type SyncErrorCode = keyof typeof SYNC_ERROR_STATUS;

/**
 * Codes recorded on a `failed` comment's `error_code`/`error_message` columns, produced by an
 * adapter or the publish pipeline after the `202 queued` response has already been sent. Never
 * mapped to an HTTP status.
 */
export type AsyncErrorCode =
  | 'PLATFORM_REJECTED'
  | 'PLATFORM_AUTH_FAILED'
  | 'PLATFORM_RATE_LIMITED'
  | 'PARENT_DELETED'
  | 'OUTCOME_UNKNOWN';

/** The RFC 9457 body shape, with the project's machine-readable `code` extension. */
export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly code: SyncErrorCode;
  readonly instance?: string;
}

/**
 * The one error type a use case or route handler throws for a synchronous failure.
 *
 * `detail` is a per-instance human explanation, not a constant — callers must say which resource
 * or value was the problem (e.g. `REPLY_DEPTH_EXCEEDED` names the top-level comment).
 */
export class ApiError extends Error {
  readonly code: SyncErrorCode;
  readonly detail: string;
  readonly status: number;

  constructor(code: SyncErrorCode, detail: string, options?: ErrorOptions) {
    super(`${code}: ${detail}`, options);
    this.name = 'ApiError';
    this.code = code;
    this.detail = detail;
    this.status = SYNC_ERROR_STATUS[code];
  }
}

/**
 * Builds the RFC 9457 response body for an `ApiError`.
 *
 * Args:
 *   error: The error to render.
 *   instance: Optional URI identifying the specific request/resource, per RFC 9457 §3.1.6.
 *
 * Returns:
 *   A `ProblemDetails` object suitable for an `application/problem+json` response body.
 */
export function toProblemDetails(error: ApiError, instance?: string): ProblemDetails {
  return {
    type: 'about:blank',
    title: SYNC_ERROR_TITLE[error.code],
    status: error.status,
    detail: error.detail,
    code: error.code,
    ...(instance === undefined ? {} : { instance }),
  };
}
