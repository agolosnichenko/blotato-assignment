import { describe, expect, it } from 'vitest';
import { ApiError, toProblemDetails, type SyncErrorCode } from '#src/shared/errors.ts';

/**
 * Independently re-derived from contracts/rest-api.md §Error codes / spec.md §6.3 — not copied
 * from `errors.ts`, so a transposed status (`422` where `429` belongs) fails this test instead of
 * compiling cleanly. `Record<SyncErrorCode, number>` also forces this table to grow or shrink with
 * the union, pinning the catalogue's membership.
 */
const EXPECTED_STATUS = {
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
  INTERNAL_ERROR: 500,
} as const satisfies Record<SyncErrorCode, number>;

describe('ApiError / toProblemDetails', () => {
  it.each(Object.entries(EXPECTED_STATUS))('maps %s to HTTP %i', (code, expectedStatus) => {
    const error = new ApiError(code as SyncErrorCode, 'test detail');

    expect(error.status).toBe(expectedStatus);
    expect(toProblemDetails(error).status).toBe(expectedStatus);
  });

  it('carries the code through to the problem body', () => {
    const error = new ApiError('NOT_FOUND', 'workspace does not own this comment');

    expect(toProblemDetails(error).code).toBe('NOT_FOUND');
  });

  it('uses the per-instance detail rather than a constant per code', () => {
    const first = new ApiError('REPLY_DEPTH_EXCEEDED', 'top-level comment abc-123');
    const second = new ApiError('REPLY_DEPTH_EXCEEDED', 'top-level comment xyz-789');

    expect(toProblemDetails(first).detail).toBe('top-level comment abc-123');
    expect(toProblemDetails(second).detail).toBe('top-level comment xyz-789');
  });

  it('omits instance when none is given, and includes it when one is', () => {
    const error = new ApiError('VALIDATION_ERROR', 'text is required');

    expect(toProblemDetails(error).instance).toBeUndefined();
    expect(toProblemDetails(error, '/v1/comments/abc-123').instance).toBe('/v1/comments/abc-123');
  });
});
