/**
 * `classifyBlueskyFailure` is the Bluesky half of D14's enforcement point — see the sibling
 * `meta/errors.test.ts` for why these cases exist rather than trusting the implementation to stay
 * correct through a later refactor of the retry logic.
 */

import { XRPCError } from '@atproto/api';
import { describe, expect, it } from 'vitest';
import { classifyBlueskyFailure } from '#src/platforms/bluesky/errors.ts';
import {
  AuthError,
  OutcomeUnknownError,
  PermanentError,
  RetryableError,
} from '#src/platforms/types.ts';

/** `ResponseType.Unknown` — `@atproto/xrpc` never got an HTTP response. */
const STATUS_NETWORK_FAILURE = 1;
/** `ResponseType.InvalidResponse` — the PDS answered 200 with a body that failed validation. */
const STATUS_INVALID_RESPONSE = 2;

function xrpcError(
  status: number,
  options: { cause?: unknown; headers?: Record<string, string> } = {},
): XRPCError {
  const error = new XRPCError(status, 'TestError', 'test failure', options.headers);
  if (options.cause !== undefined) {
    error.cause = options.cause;
  }
  return error;
}

function undiciCause(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe('a response the PDS did return', () => {
  it.each([401, 403])('maps %i to AuthError', (status) => {
    expect(classifyBlueskyFailure(xrpcError(status), 'write')).toBeInstanceOf(AuthError);
  });

  it.each(['read', 'write'] as const)('maps 429 on a %s to RetryableError', (operation) => {
    expect(classifyBlueskyFailure(xrpcError(429), operation)).toBeInstanceOf(RetryableError);
  });

  it('carries a numeric retry-after through', () => {
    const error = classifyBlueskyFailure(
      xrpcError(429, { headers: { 'retry-after': '12' } }),
      'read',
    );
    expect((error as RetryableError).retryAfter).toBe(12);
  });

  it.each([500, 502, 503])('maps %i on a read to RetryableError', (status) => {
    expect(classifyBlueskyFailure(xrpcError(status), 'read')).toBeInstanceOf(RetryableError);
  });

  it.each([500, 502, 503])('maps %i on a write to OutcomeUnknownError', (status) => {
    // The PDS received the write; the record may exist despite the error status.
    expect(classifyBlueskyFailure(xrpcError(status), 'write')).toBeInstanceOf(OutcomeUnknownError);
  });

  it.each([400, 404])('maps %i to PermanentError', (status) => {
    expect(classifyBlueskyFailure(xrpcError(status), 'write')).toBeInstanceOf(PermanentError);
  });

  it('treats a 200 whose body failed validation as an unknown outcome', () => {
    // The write may well have been applied — the adapter just cannot read back what was created.
    expect(classifyBlueskyFailure(xrpcError(STATUS_INVALID_RESPONSE), 'write')).toBeInstanceOf(
      OutcomeUnknownError,
    );
  });
});

describe('a transport failure that produced no response', () => {
  it.each(['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'])(
    'maps the pre-send code %s to RetryableError',
    (code) => {
      const error = xrpcError(STATUS_NETWORK_FAILURE, { cause: undiciCause(code) });
      expect(classifyBlueskyFailure(error, 'write')).toBeInstanceOf(RetryableError);
    },
  );

  it.each(['UND_ERR_HEADERS_TIMEOUT', 'ECONNRESET'])(
    'maps the post-send code %s to OutcomeUnknownError',
    (code) => {
      const error = xrpcError(STATUS_NETWORK_FAILURE, { cause: undiciCause(code) });
      expect(classifyBlueskyFailure(error, 'write')).toBeInstanceOf(OutcomeUnknownError);
    },
  );

  it('maps an unrecognised cause to OutcomeUnknownError rather than guessing', () => {
    const error = xrpcError(STATUS_NETWORK_FAILURE);
    expect(classifyBlueskyFailure(error, 'write')).toBeInstanceOf(OutcomeUnknownError);
  });
});

describe('an error that did not come from @atproto/xrpc', () => {
  it('treats it as an unknown outcome rather than assuming a retry is safe', () => {
    expect(classifyBlueskyFailure(new Error('boom'), 'write')).toBeInstanceOf(OutcomeUnknownError);
  });
});
