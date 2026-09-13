import { describe, expect, it } from 'vitest';

import { platformRegistry } from '#src/platforms/registry.ts';

describe('platformRegistry', () => {
  const entries = Object.values(platformRegistry);

  it('has exactly nine entries', () => {
    expect(entries).toHaveLength(9);
  });

  it('supports comments on exactly three platforms', () => {
    const supported = entries.filter((entry) => entry.supportsComments);
    expect(supported).toHaveLength(3);
    expect(supported.map((entry) => entry.platform).toSorted()).toEqual([
      'bluesky',
      'facebook',
      'instagram',
    ]);
  });

  it('gives every unsupported entry a non-empty unsupportedReason', () => {
    const unsupported = entries.filter((entry) => !entry.supportsComments);
    expect(unsupported).toHaveLength(6);
    for (const entry of unsupported) {
      expect(entry.unsupportedReason.trim().length).toBeGreaterThan(0);
    }
  });
});
