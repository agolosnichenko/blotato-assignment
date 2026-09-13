/**
 * Maps Meta Graph API transport failures onto the four typed adapter errors (T067,
 * contracts/platform-adapter.md).
 *
 * `graph-client.ts` surfaces three shapes of failure: a {@link GraphHttpError} when the Graph API
 * answered with a non-2xx status (the request definitely reached Meta); whatever `fetch` itself
 * throws when no response was ever received; and a plain `Error` the client raises before any
 * request goes out (`resolveEndpoint`'s platform guard). `fetch` in Node 22 is built on undici,
 * and a failed `fetch` is a `TypeError` whose `.cause` carries undici's own error object — that
 * `.cause` is what tells "never sent" apart from "sent, then the connection died", rather than any
 * guess from a message string. The third shape is a bug in the caller, not a platform failure, and
 * is rethrown untouched instead of being given one of the four types.
 */

import { GraphHttpError } from '#src/platforms/meta/graph-client.ts';
import {
  AuthError,
  OutcomeUnknownError,
  PermanentError,
  RetryableError,
  type AdapterError,
  type AdapterOperation,
} from '#src/platforms/types.ts';

/** The Graph API's own code for an invalid, expired or revoked access token. */
const OAUTH_ERROR_CODE = 190;

/** Node/undici error codes that can only occur before any request bytes reached the wire. */
const PRE_SEND_ERROR_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

interface GraphErrorBody {
  readonly error?: {
    readonly code?: number;
    readonly message?: string;
  };
}

function isGraphErrorBody(body: unknown): body is GraphErrorBody {
  return body !== null && typeof body === 'object' && 'error' in body;
}

function errorCode(cause: unknown): string | undefined {
  if (cause !== null && typeof cause === 'object' && 'code' in cause) {
    return String((cause as { code: unknown }).code);
  }
  return undefined;
}

/**
 * Classifies a `fetch` failure that produced no HTTP response at all.
 *
 * A pre-send failure (DNS, refused connection, connect timeout) cannot have reached Meta, so it
 * is always safe to retry. Anything else — a headers/body timeout after the request was written,
 * a socket dropped mid-flight, or a cause this client does not recognise — leaves the outcome
 * genuinely unknown, and an unknown outcome must never be retried blindly.
 */
function classifyNetworkFailure(error: unknown): RetryableError | OutcomeUnknownError {
  const cause = error instanceof Error ? error.cause : undefined;
  const code = errorCode(cause);
  if (code !== undefined && PRE_SEND_ERROR_CODES.has(code)) {
    return new RetryableError('meta request failed before it reached the platform', { cause });
  }
  return new OutcomeUnknownError('meta request outcome unknown after a transport failure', {
    cause,
  });
}

function parseRetryAfter(headers: Headers): number | undefined {
  const value = headers.get('retry-after');
  if (value === null) {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds : undefined;
}

function classifyHttpFailure(error: GraphHttpError, operation: AdapterOperation): AdapterError {
  const body = error.body;
  if (error.httpStatus < 400) {
    // A success status whose body the client could not read (`graph-client.ts`). Meta accepted the
    // request, so a write may well have created the comment even though its id is unreadable —
    // that is an unknown outcome, not a rejection. A read has nothing at stake and can be retried.
    return operation === 'write'
      ? new OutcomeUnknownError('meta accepted the write but its response could not be read', {
          cause: error,
        })
      : new RetryableError('meta returned a success response this client could not read', {
          cause: error,
        });
  }
  const oauthFailure = isGraphErrorBody(body) && body.error?.code === OAUTH_ERROR_CODE;
  if (oauthFailure) {
    return new AuthError('meta rejected the access token', { cause: error });
  }
  if (error.httpStatus >= 500 && operation === 'write') {
    // The request reached Meta — the comment may already exist behind that 5xx. A blind retry is
    // exactly the double post D14 forbids, so the outcome is unknown and reconciliation must run
    // before any second send. A 429 is different: a rate-limit rejection was never executed.
    return new OutcomeUnknownError('meta write outcome unknown after a server error', {
      cause: error,
    });
  }
  if (error.httpStatus === 429 || error.httpStatus >= 500) {
    const retryAfter = parseRetryAfter(error.headers);
    return new RetryableError('meta rate limit or server error', {
      cause: error,
      ...(retryAfter === undefined ? {} : { retryAfter }),
    });
  }
  if (error.httpStatus === 401 || error.httpStatus === 403) {
    return new AuthError('meta rejected the credential', { cause: error });
  }
  const message = isGraphErrorBody(body) ? body.error?.message : undefined;
  return new PermanentError(`meta rejected the request: ${message ?? error.httpStatus}`, {
    cause: error,
  });
}

/**
 * Recognises the shape a failed `fetch` has, as opposed to an error raised before it ran.
 *
 * Node 22 rejects a failed `fetch` with a `TypeError`, carrying undici's own error as `cause`.
 * `graph-client.ts` also raises plain `Error`s of its own — `resolveEndpoint`'s platform guard —
 * synchronously, before any request goes out; those have neither shape.
 */
function isTransportFailure(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error && error.cause !== undefined);
}

/**
 * Maps any error thrown by a `graph-client.ts` call to the four typed adapter errors.
 *
 * Args:
 *   error: The value caught from a `GraphClient.request` call.
 *   operation: Whether the failed call was writing to Meta or reading from it — a 5xx answer to a
 *     write may have created the comment, the same status on a read cannot have.
 *
 * Returns:
 *   One of `RetryableError`, `OutcomeUnknownError`, `PermanentError` or `AuthError`, wrapping
 *   `error` as `cause` so the original failure is never discarded.
 *
 * Raises:
 *   The original error, unchanged, when it was raised before the request reached the wire — a bug
 *   in this client rather than a platform failure. Classifying it would stamp a real comment row
 *   with `OUTCOME_UNKNOWN` and buy a reconciliation read that cannot find anything, corrupting the
 *   one signal the publish path uses to decide whether a second send is safe.
 */
export function classifyGraphFailure(error: unknown, operation: AdapterOperation): AdapterError {
  if (error instanceof GraphHttpError) {
    return classifyHttpFailure(error, operation);
  }
  if (!isTransportFailure(error)) {
    throw error;
  }
  return classifyNetworkFailure(error);
}
