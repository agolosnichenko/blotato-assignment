/**
 * `classifyGraphFailure` is the enforcement point of D14: every decision about whether a failed
 * publish may be retried blindly is made here. These cases exist so that a later "let's fix the
 * retries" refactor cannot quietly turn an ambiguous write outcome back into a blind retry.
 */

import { describe, expect, it } from 'vitest';
import { classifyGraphFailure } from '#src/platforms/meta/errors.ts';
import { GraphHttpError } from '#src/platforms/meta/graph-client.ts';
import {
  AuthError,
  OutcomeUnknownError,
  PermanentError,
  RetryableError,
} from '#src/platforms/types.ts';

function httpError(
  status: number,
  body: unknown = {},
  headers: Record<string, string> = {},
): GraphHttpError {
  return new GraphHttpError(status, body, new Headers(headers));
}

/** What a failed `fetch` looks like in Node 22: a `TypeError` carrying undici's error as cause. */
function transportFailure(code: string): TypeError {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
}

describe('an HTTP response the Graph API did return', () => {
  it('maps the OAuth error code to AuthError whatever the status is', () => {
    const error = classifyGraphFailure(httpError(400, { error: { code: 190 } }), 'write');
    expect(error).toBeInstanceOf(AuthError);
  });

  it.each([401, 403])('maps %i to AuthError', (status) => {
    expect(classifyGraphFailure(httpError(status), 'read')).toBeInstanceOf(AuthError);
  });

  it.each(['read', 'write'] as const)('maps 429 on a %s to RetryableError', (operation) => {
    // A rate-limit rejection is not executed, so it stays safe to retry in both directions.
    expect(classifyGraphFailure(httpError(429), operation)).toBeInstanceOf(RetryableError);
  });

  it('carries a numeric retry-after through', () => {
    const error = classifyGraphFailure(httpError(429, {}, { 'retry-after': '30' }), 'read');
    expect(error).toBeInstanceOf(RetryableError);
    expect((error as RetryableError).retryAfter).toBe(30);
  });

  it('drops an unparseable retry-after rather than passing NaN on', () => {
    const error = classifyGraphFailure(httpError(429, {}, { 'retry-after': 'soon' }), 'read');
    expect((error as RetryableError).retryAfter).toBeUndefined();
  });

  it.each([500, 502, 503, 504])('maps %i on a read to RetryableError', (status) => {
    expect(classifyGraphFailure(httpError(status), 'read')).toBeInstanceOf(RetryableError);
  });

  it.each([500, 502, 503, 504])('maps %i on a write to OutcomeUnknownError', (status) => {
    // The request reached Meta, so the comment may already exist: retrying blindly is the
    // double-post D14 forbids. Reconciliation must gate the next send.
    expect(classifyGraphFailure(httpError(status), 'write')).toBeInstanceOf(OutcomeUnknownError);
  });

  it.each([400, 404, 422])('maps %i to PermanentError', (status) => {
    expect(classifyGraphFailure(httpError(status), 'write')).toBeInstanceOf(PermanentError);
  });

  it('puts the Graph error message into a PermanentError', () => {
    const error = classifyGraphFailure(httpError(400, { error: { message: 'bad param' } }), 'read');
    expect(error.message).toContain('bad param');
  });
});

describe('a success status whose body could not be read', () => {
  it('is an unknown outcome on a write, not a rejection', () => {
    // Meta accepted the request; the comment may exist even though its id is unreadable.
    expect(classifyGraphFailure(httpError(200, null), 'write')).toBeInstanceOf(OutcomeUnknownError);
  });

  it('is merely retryable on a read', () => {
    expect(classifyGraphFailure(httpError(200, null), 'read')).toBeInstanceOf(RetryableError);
  });
});

describe('a transport failure that produced no HTTP response', () => {
  it.each(['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'])(
    'maps the pre-send code %s to RetryableError',
    (code) => {
      // These cannot have reached Meta, so even a write is safe to repeat.
      expect(classifyGraphFailure(transportFailure(code), 'write')).toBeInstanceOf(RetryableError);
    },
  );

  it.each(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ECONNRESET'])(
    'maps the post-send code %s to OutcomeUnknownError',
    (code) => {
      expect(classifyGraphFailure(transportFailure(code), 'write')).toBeInstanceOf(
        OutcomeUnknownError,
      );
    },
  );

  it('maps a cause it cannot recognise to OutcomeUnknownError rather than guessing', () => {
    expect(classifyGraphFailure(new TypeError('fetch failed'), 'write')).toBeInstanceOf(
      OutcomeUnknownError,
    );
  });

  it('preserves the original failure as cause', () => {
    const original = transportFailure('ECONNRESET');
    expect(classifyGraphFailure(original, 'write').cause).toBe(original.cause);
  });
});

describe('a programmer error raised before the request went out', () => {
  it('rethrows it untouched instead of classifying it', () => {
    // `resolveEndpoint`'s platform guard throws a plain Error before any fetch. Classifying it as
    // OutcomeUnknownError would make a configuration bug demand a reconciliation read that cannot
    // find anything, and would stamp `error_code = 'OUTCOME_UNKNOWN'` on the row.
    const bug = new Error('meta graph client received credentials for platform: bluesky');
    expect(() => classifyGraphFailure(bug, 'write')).toThrow(bug);
  });

  it('does not mistake a transport TypeError for a programmer error', () => {
    expect(() => classifyGraphFailure(transportFailure('ECONNRESET'), 'write')).not.toThrow();
  });
});
