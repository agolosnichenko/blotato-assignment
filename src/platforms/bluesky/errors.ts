/**
 * Maps Bluesky/AT Protocol transport failures onto the four typed adapter errors (T067,
 * contracts/platform-adapter.md).
 *
 * Every call this adapter makes goes through `@atproto/xrpc`'s `XrpcClient`, which funnels every
 * failure — a real HTTP error response or a transport failure that never got one — through
 * `XRPCError.from()`. A real HTTP status becomes `error.status`; a failure that never produced a
 * response (DNS, connect, timeout, a dropped connection) becomes `ResponseType.Unknown` (`1`)
 * with the original fetch-thrown error preserved on `error.cause`. That funnel is what makes the
 * mapping below a classification of what `@atproto/xrpc` actually observed, not a guess from
 * message text.
 */

import { XRPCError } from '@atproto/api';
import {
  AuthError,
  OutcomeUnknownError,
  PermanentError,
  RetryableError,
  type AdapterError,
  type AdapterOperation,
} from '#src/platforms/types.ts';

// `@atproto/xrpc`'s `ResponseType` enum, inlined: importing it would reach past `@atproto/api`
// into a package this project does not declare as a dependency. Its numeric values are the
// package's stable public contract (XRPCError.status), not an implementation detail.
// ResponseType.Unknown — no HTTP response was ever received.
const STATUS_NETWORK_FAILURE = 1;
// ResponseType.InvalidResponse — the PDS answered 200 but the body failed lexicon validation.
const STATUS_INVALID_RESPONSE = 2;
const STATUS_UNAUTHORIZED = 401;
const STATUS_FORBIDDEN = 403;
const STATUS_RATE_LIMITED = 429;

/**
 * Node/undici error codes that can only occur before any request bytes reached the wire:
 * - `UND_ERR_CONNECT_TIMEOUT`: TCP connect (or TLS handshake) did not complete in time.
 * - `ECONNREFUSED`: TCP connect refused by the remote host.
 * - `ENOTFOUND`: DNS resolution failed.
 * - `EAI_AGAIN`: DNS resolution timed out / temporary failure.
 */
const PRE_SEND_ERROR_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

function errorCode(cause: unknown): string | undefined {
  if (cause !== null && typeof cause === 'object' && 'code' in cause) {
    return String((cause as { code: unknown }).code);
  }
  return undefined;
}

/**
 * Classifies a failure that produced no HTTP response at all.
 *
 * A pre-send failure (DNS, refused connection, connect timeout) cannot have reached the server,
 * so it is always safe to retry. Anything else — a headers/body timeout after the request was
 * written, a socket dropped mid-flight, or a cause this adapter does not recognise — leaves the
 * outcome genuinely unknown: reconciliation costs one extra read, a blind retry risks a duplicate
 * reply, so the ambiguous case defaults to `OutcomeUnknownError` rather than being guessed.
 */
function classifyNetworkFailure(cause: unknown): RetryableError | OutcomeUnknownError {
  const code = errorCode(cause);
  if (code !== undefined && PRE_SEND_ERROR_CODES.has(code)) {
    return new RetryableError('bluesky request failed before it reached the server', { cause });
  }
  return new OutcomeUnknownError('bluesky request outcome unknown after a transport failure', {
    cause,
  });
}

function parseRetryAfter(
  headers: Record<string, string | undefined> | undefined,
): number | undefined {
  const value = headers?.['retry-after'];
  if (value === undefined) {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds : undefined;
}

/**
 * Maps any error thrown by an `@atproto/api` call to the four typed adapter errors.
 *
 * Args:
 *   error: The value caught from an `AtpAgent`/`XrpcClient` call.
 *   operation: Whether the failed call was writing to the PDS or reading from it — a 5xx answer to
 *     a write may have applied the record, the same status on a read cannot have.
 *
 * Returns:
 *   One of `RetryableError`, `OutcomeUnknownError`, `PermanentError` or `AuthError`, wrapping
 *   `error` as `cause` so the original failure is never discarded.
 */
export function classifyBlueskyFailure(error: unknown, operation: AdapterOperation): AdapterError {
  if (error instanceof XRPCError) {
    return classifyXrpcFailure(error, operation);
  }
  // Every call in this adapter goes through @atproto/xrpc, so this should be unreachable in
  // production; treat it as unknown outcome rather than assuming it is safe to retry.
  return new OutcomeUnknownError('bluesky request failed in an unrecognised way', { cause: error });
}

function classifyXrpcFailure(error: XRPCError, operation: AdapterOperation): AdapterError {
  if (error.status === STATUS_NETWORK_FAILURE) {
    return classifyNetworkFailure(error.cause);
  }
  if (error.status === STATUS_INVALID_RESPONSE) {
    // The PDS answered (write may have succeeded) but its body failed lexicon validation — the
    // adapter cannot read back what was created, so the outcome is unknown, not a hard failure.
    return new OutcomeUnknownError('bluesky returned a response this adapter could not validate', {
      cause: error,
    });
  }
  if (error.status >= 500 && operation === 'write') {
    // The write reached the PDS and may have been applied before it answered — reconciliation
    // must gate the next send (D14). A 429 stays retryable: a rejected request was never run.
    return new OutcomeUnknownError('bluesky write outcome unknown after a server error', {
      cause: error,
    });
  }
  if (error.status === STATUS_RATE_LIMITED || error.status >= 500) {
    const retryAfter = parseRetryAfter(error.headers);
    return new RetryableError('bluesky rate limit or server error', {
      cause: error,
      ...(retryAfter === undefined ? {} : { retryAfter }),
    });
  }
  if (error.status === STATUS_UNAUTHORIZED || error.status === STATUS_FORBIDDEN) {
    return new AuthError('bluesky rejected the session credential', { cause: error });
  }
  return new PermanentError(`bluesky rejected the request: ${error.error || error.message}`, {
    cause: error,
  });
}
