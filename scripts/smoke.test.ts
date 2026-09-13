import { describe, expect, it } from 'vitest';
import {
  assertDescendingOccurredAt,
  assertPlatformsCapabilities,
  commentPollOutcome,
  isReplyDepthExceededProblem,
  parseSmokeEnv,
  syncJobPollOutcome,
  type PlatformCapability,
} from './smoke-checks.ts';

const VALID_ENV = {
  SMOKE_BASE_URL: 'https://api-production-6ef5.up.railway.app',
  SMOKE_API_KEY: 'blt_demo_key',
  SMOKE_INSTAGRAM_POST_ID: '33333333-3333-4333-8333-333333333331',
  SMOKE_BLUESKY_POST_ID: '33333333-3333-4333-8333-333333333333',
};

describe('parseSmokeEnv', () => {
  it('accepts a fully populated environment', () => {
    expect(parseSmokeEnv(VALID_ENV)).toEqual(VALID_ENV);
  });

  it('names every missing variable in one error, not just the first', () => {
    let message = '';
    try {
      parseSmokeEnv({});
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toContain('SMOKE_BASE_URL');
    expect(message).toContain('SMOKE_API_KEY');
    expect(message).toContain('SMOKE_INSTAGRAM_POST_ID');
    expect(message).toContain('SMOKE_BLUESKY_POST_ID');
  });

  it('rejects a malformed SMOKE_BASE_URL', () => {
    expect(() => parseSmokeEnv({ ...VALID_ENV, SMOKE_BASE_URL: 'not-a-url' })).toThrowError(
      /SMOKE_BASE_URL/u,
    );
  });

  it('rejects a non-UUID post id', () => {
    expect(() =>
      parseSmokeEnv({ ...VALID_ENV, SMOKE_INSTAGRAM_POST_ID: 'not-a-uuid' }),
    ).toThrowError(/SMOKE_INSTAGRAM_POST_ID/u);
  });
});

describe('assertDescendingOccurredAt', () => {
  it('passes on a strictly descending page', () => {
    const items = [
      { occurredAt: '2026-09-13T12:00:00.000Z' },
      { occurredAt: '2026-09-13T11:00:00.000Z' },
      { occurredAt: '2026-09-13T10:00:00.000Z' },
    ];
    expect(() => assertDescendingOccurredAt(items)).not.toThrow();
  });

  it('fails on a single out-of-order pair', () => {
    const items = [
      { occurredAt: '2026-09-13T10:00:00.000Z' },
      { occurredAt: '2026-09-13T11:00:00.000Z' },
      { occurredAt: '2026-09-13T09:00:00.000Z' },
    ];
    expect(() => assertDescendingOccurredAt(items)).toThrowError(/not newest-first at index 1/u);
  });

  it('passes on an empty or single-item page', () => {
    expect(() => assertDescendingOccurredAt([])).not.toThrow();
    expect(() =>
      assertDescendingOccurredAt([{ occurredAt: '2026-09-13T10:00:00.000Z' }]),
    ).not.toThrow();
  });
});

describe('isReplyDepthExceededProblem', () => {
  it('is true for a 422 carrying the REPLY_DEPTH_EXCEEDED code', () => {
    const body = { code: 'REPLY_DEPTH_EXCEEDED', detail: 'top-level comment abc-123' };
    expect(isReplyDepthExceededProblem(422, body)).toBe(true);
  });

  it('is false for a 422 carrying a different code', () => {
    const body = { code: 'VALIDATION_ERROR', detail: 'text is required' };
    expect(isReplyDepthExceededProblem(422, body)).toBe(false);
  });

  it('is false for a non-422 status even with the right code', () => {
    expect(isReplyDepthExceededProblem(400, { code: 'REPLY_DEPTH_EXCEEDED' })).toBe(false);
  });

  it('is false for a malformed body', () => {
    expect(isReplyDepthExceededProblem(422, null)).toBe(false);
    expect(isReplyDepthExceededProblem(422, 'not an object')).toBe(false);
  });
});

describe('commentPollOutcome', () => {
  it.each([
    ['queued', 'continue'],
    ['processing', 'continue'],
    ['deleted', 'continue'],
    ['posted', 'posted'],
    ['failed', 'failed'],
  ] as const)('classifies %s as %s', (status, outcome) => {
    expect(commentPollOutcome(status)).toBe(outcome);
  });
});

describe('syncJobPollOutcome', () => {
  it.each([
    ['queued', 'continue'],
    ['running', 'continue'],
    ['succeeded', 'succeeded'],
    ['failed', 'failed'],
  ] as const)('classifies %s as %s', (status, outcome) => {
    expect(syncJobPollOutcome(status)).toBe(outcome);
  });
});

function makePlatforms(commentCapableCount: number): PlatformCapability[] {
  const items: PlatformCapability[] = [];
  for (let index = 0; index < 9; index += 1) {
    const supportsComments = index < commentCapableCount;
    items.push({
      platform: `platform-${index}`,
      supportsComments,
      ...(supportsComments ? {} : { unsupportedReason: 'not supported' }),
    });
  }
  return items;
}

describe('assertPlatformsCapabilities', () => {
  it('passes for 9 platforms with exactly 3 comment-capable and a reason on the rest', () => {
    expect(() => assertPlatformsCapabilities(makePlatforms(3))).not.toThrow();
  });

  it('fails when the total is not 9', () => {
    expect(() => assertPlatformsCapabilities(makePlatforms(3).slice(0, 8))).toThrowError(
      /9 platforms/u,
    );
  });

  it('fails when comment-capable count is not exactly 3', () => {
    expect(() => assertPlatformsCapabilities(makePlatforms(2))).toThrowError(/comment-capable/u);
  });

  it('fails when an unsupported platform has no stated reason', () => {
    const items = makePlatforms(3);
    const last = items[8];
    if (last !== undefined) {
      items[8] = { platform: last.platform, supportsComments: false };
    }
    expect(() => assertPlatformsCapabilities(items)).toThrowError(
      /without a stated unsupportedReason/u,
    );
  });
});
