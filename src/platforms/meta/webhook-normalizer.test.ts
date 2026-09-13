/**
 * Unit tests for the Meta webhook normalizer (T080, A18).
 *
 * Every `page.feed` fixture below is `structuredClone`d from the one payload §17 S1 confirms Meta
 * actually delivers (`__fixtures__/s1-page-feed-test-delivery.json`) — a dashboard `Test` send
 * whose `item` is `"status"`, not a comment. Each test that exercises comment handling overrides
 * `item`/`verb`/`comment_id`/`parent_id`/`message`/`from` on the clone; everything it does not
 * touch (`object`, the `entry`/`changes` envelope, `post_id`, `created_time`'s numeric-seconds
 * shape) is the recorded delivery verbatim. The `instagram.comments` fixture has no recorded
 * delivery to clone — see the module docstring — and is built from scratch, marked as such.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMetaWebhookNormalizer } from '#src/platforms/meta/webhook-normalizer.ts';

const FIXTURE_PATH = fileURLToPath(
  new URL('./__fixtures__/s1-page-feed-test-delivery.json', import.meta.url),
);
const recordedDelivery: Record<string, unknown> = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

type EntryValue = [{ changes: [{ value: Record<string, unknown> }] }];

function pageFeedValue(overrides: Record<string, unknown>): Record<string, unknown> {
  const clone = structuredClone(recordedDelivery) as { entry: EntryValue };
  Object.assign(clone.entry[0].changes[0].value, overrides);
  return clone;
}

/** Deletes `key` from the cloned payload's `value` object after `pageFeedValue` built it —
 * `pageFeedValue`'s own `overrides` can only set keys, never remove one the fixture provided. */
function deletePageFeedKey(payload: Record<string, unknown>, key: string): void {
  const entry = payload['entry'] as EntryValue;
  delete entry[0].changes[0].value[key];
}

/** No recorded delivery exists for `instagram.comments` (§17 S2 only verified reading, not
 * webhooks) — the whole payload is synthesized from Meta's published Graph API webhook shape. */
function instagramPayload(value: Record<string, unknown>): Record<string, unknown> {
  return {
    object: 'instagram',
    entry: [{ id: 'ig-account-1', time: 1_700_000_000, changes: [{ field: 'comments', value }] }],
  };
}

const normalizer = createMetaWebhookNormalizer();

const baseComment = {
  item: 'comment',
  verb: 'add',
  comment_id: 'comment-1',
  post_id: '44444444_444444444',
  message: 'hello there',
  from: { id: 'author-1', name: 'Jane Doe' },
  created_time: 1_700_000_000,
};

describe('page.feed — recorded delivery', () => {
  it('ignores a change whose item is not "comment" (the actual S1 test send)', () => {
    const payload = structuredClone(recordedDelivery);
    expect(normalizer.normalize(payload)).toEqual([]);
  });
});

describe('page.feed — complete comment events', () => {
  it('normalizes a complete add into an upsert with comment data', () => {
    const payload = pageFeedValue(baseComment);

    expect(normalizer.normalize(payload)).toEqual([
      {
        type: 'upsert',
        platform: 'facebook',
        platformAccountId: '0',
        platformPostId: '44444444_444444444',
        platformCommentId: 'comment-1',
        platformParentId: null,
        comment: {
          authorPlatformId: 'author-1',
          authorUsername: null,
          authorDisplayName: 'Jane Doe',
          text: 'hello there',
          platformCreatedAt: new Date(1_700_000_000 * 1000),
          platformMeta: {},
        },
      },
    ]);
  });

  it('normalizes verb "edited" the same as "add" (still an upsert)', () => {
    const payload = pageFeedValue({ ...baseComment, verb: 'edited', message: 'edited text' });
    const [event] = normalizer.normalize(payload);
    expect(event?.type).toBe('upsert');
  });

  it('normalizes verb "remove" into a delete event, no comment data required', () => {
    const payload = pageFeedValue({
      item: 'comment',
      verb: 'remove',
      comment_id: 'comment-1',
      post_id: '44444444_444444444',
    });

    expect(normalizer.normalize(payload)).toEqual([
      {
        type: 'delete',
        platform: 'facebook',
        platformAccountId: '0',
        platformCommentId: 'comment-1',
      },
    ]);
  });
});

describe('page.feed — parent resolution', () => {
  it('treats a reply (parent_id different from post_id) as such', () => {
    const payload = pageFeedValue({
      ...baseComment,
      comment_id: 'reply-1',
      parent_id: 'comment-1',
    });
    const [event] = normalizer.normalize(payload);
    expect(event).toMatchObject({ platformParentId: 'comment-1' });
  });

  it('treats parent_id equal to post_id as top-level', () => {
    const payload = pageFeedValue({ ...baseComment, parent_id: baseComment.post_id });
    const [event] = normalizer.normalize(payload);
    expect(event).toMatchObject({ platformParentId: null });
  });

  it('treats an absent parent_id as top-level', () => {
    const payload = pageFeedValue(baseComment);
    const [event] = normalizer.normalize(payload);
    expect(event).toMatchObject({ platformParentId: null });
  });
});

// A18: the load-bearing distinction. A payload missing `message` or `from` entirely must not
// normalize the same way as one that explicitly sent `message: ''`.
describe('page.feed — A18 absent vs. empty', () => {
  it('flags a payload with no "message" key as incomplete (comment undefined)', () => {
    const payload = pageFeedValue(baseComment);
    deletePageFeedKey(payload, 'message');

    const [event] = normalizer.normalize(payload);
    expect(event).toMatchObject({ type: 'upsert', comment: undefined });
  });

  it('treats an explicit empty "message" as complete, not thin', () => {
    const payload = pageFeedValue({ ...baseComment, message: '' });

    const [event] = normalizer.normalize(payload);
    expect(event?.type).toBe('upsert');
    if (event?.type === 'upsert') {
      expect(event.comment).not.toBeUndefined();
      expect(event.comment?.text).toBe('');
    }
  });

  it('flags a payload with no "from" key as incomplete, even with text present', () => {
    const payload = pageFeedValue(baseComment);
    deletePageFeedKey(payload, 'from');

    const [event] = normalizer.normalize(payload);
    expect(event).toMatchObject({ type: 'upsert', comment: undefined });
  });

  it('the missing-key and explicit-empty-string payloads do not normalize the same way', () => {
    const missingKey = pageFeedValue(baseComment);
    deletePageFeedKey(missingKey, 'message');
    const emptyString = pageFeedValue({ ...baseComment, message: '' });

    const [missingEvent] = normalizer.normalize(missingKey);
    const [emptyEvent] = normalizer.normalize(emptyString);
    expect(missingEvent).not.toEqual(emptyEvent);
  });
});

describe('instagram.comments — upsert', () => {
  it('normalizes a complete add into an upsert', () => {
    const payload = instagramPayload({
      id: 'ig-comment-1',
      text: 'nice post',
      from: { id: 'ig-author-1', username: 'jane' },
      media: { id: 'ig-media-1' },
    });

    const [event] = normalizer.normalize(payload);
    expect(event).toMatchObject({
      type: 'upsert',
      platform: 'instagram',
      platformPostId: 'ig-media-1',
      platformCommentId: 'ig-comment-1',
      platformParentId: null,
    });
    if (event?.type === 'upsert') {
      expect(event.comment).toMatchObject({
        authorPlatformId: 'ig-author-1',
        authorUsername: 'jane',
      });
    }
  });
});

describe('instagram.comments — incomplete and delete', () => {
  it('flags a payload with no "text" key as incomplete', () => {
    const payload = instagramPayload({
      id: 'ig-comment-1',
      from: { id: 'ig-author-1', username: 'jane' },
      media: { id: 'ig-media-1' },
    });

    const [event] = normalizer.normalize(payload);
    expect(event).toMatchObject({ type: 'upsert', comment: undefined });
  });

  it('normalizes an explicit verb "remove" into a delete event', () => {
    const payload = instagramPayload({ id: 'ig-comment-1', verb: 'remove' });

    expect(normalizer.normalize(payload)).toEqual([
      {
        type: 'delete',
        platform: 'instagram',
        platformAccountId: 'ig-account-1',
        platformCommentId: 'ig-comment-1',
      },
    ]);
  });
});

describe('malformed payloads', () => {
  it('throws on a payload with no "object" field', () => {
    expect(() => normalizer.normalize({ entry: [] })).toThrow(/object/u);
  });

  it('throws on a non-object payload', () => {
    expect(() => normalizer.normalize('not an object')).toThrow();
  });

  it('skips an entry with no usable id rather than throwing', () => {
    expect(normalizer.normalize({ object: 'page', entry: [{ changes: [] }] })).toEqual([]);
  });
});
