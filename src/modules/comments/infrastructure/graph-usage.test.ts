/**
 * The throttling decision (spec.md §8.2).
 *
 * `usageDelayMs` is the whole policy: everything else in `graph-usage.ts` is storage. The case
 * that matters most is the `null` one — "nothing is known" must not read as "under pressure", or
 * an empty Redis would throttle every account in the deployment.
 */

import { describe, expect, it } from 'vitest';
import { usageDelayMs } from '#src/modules/comments/infrastructure/graph-usage.ts';

const CONFIG = { META_USAGE_THROTTLE_PERCENT: 90, META_USAGE_THROTTLE_DELAY_MS: 60_000 };

describe('usageDelayMs', () => {
  it('does not throttle when nothing is known about the account', () => {
    // A cold cache, an expired reading, or a Redis that would not answer: none of these is
    // evidence that Meta is throttling, and treating them as such would stall the whole service.
    expect(usageDelayMs(null, CONFIG)).toBe(0);
  });

  it.each([0, 45, 89])('does not throttle at %i%%', (percent) => {
    expect(usageDelayMs(percent, CONFIG)).toBe(0);
  });

  it('throttles exactly at the threshold', () => {
    expect(usageDelayMs(90, CONFIG)).toBe(60_000);
  });

  it.each([91, 99, 100])('throttles at %i%%', (percent) => {
    expect(usageDelayMs(percent, CONFIG)).toBe(60_000);
  });

  it('honours a deployment that tunes the threshold down', () => {
    const cautious = { META_USAGE_THROTTLE_PERCENT: 50, META_USAGE_THROTTLE_DELAY_MS: 5000 };
    expect(usageDelayMs(60, cautious)).toBe(5000);
    expect(usageDelayMs(40, cautious)).toBe(0);
  });
});
