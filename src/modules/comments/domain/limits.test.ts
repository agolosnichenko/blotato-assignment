import { describe, expect, it } from 'vitest';

import { checkReplyDepth, checkTextLength } from '#src/modules/comments/domain/limits.ts';
import { platformRegistry } from '#src/platforms/registry.ts';

const instagram = platformRegistry.instagram;
const bluesky = platformRegistry.bluesky;

if (!instagram.supportsComments || !bluesky.supportsComments) {
  throw new Error('fixture platforms must support comments');
}

describe('checkReplyDepth', () => {
  it('accepts an Instagram reply landing at depth 1', () => {
    const result = checkReplyDepth(instagram, 0);

    expect(result).toEqual({ allowed: true });
  });

  it('rejects an Instagram reply landing at depth 2', () => {
    const result = checkReplyDepth(instagram, 1);

    expect(result).toEqual({ allowed: false, maxReplyDepth: 1 });
  });

  it('accepts a Bluesky reply landing at depth 5, since Bluesky has no depth limit', () => {
    const result = checkReplyDepth(bluesky, 4);

    expect(result).toEqual({ allowed: true });
  });
});

describe('checkTextLength', () => {
  it('accepts a 300-grapheme Bluesky string whose UTF-16 length exceeds 300', () => {
    // A family emoji is a ZWJ sequence: one grapheme, several UTF-16 code units.
    const familyEmoji = '👨‍👩‍👧‍👦';
    const text = familyEmoji.repeat(300);
    expect(text.length).toBeGreaterThan(300);

    const result = checkTextLength(bluesky, text);

    expect(result).toEqual({ allowed: true });
  });

  it('rejects a 2201-character Instagram string', () => {
    const text = 'a'.repeat(2201);

    const result = checkTextLength(instagram, text);

    expect(result).toEqual({ allowed: false, length: 2201, limit: 2200 });
  });
});
