/**
 * Two-variant equivalence test for the Instagram read/write path (T097, A17).
 *
 * A17 claims the two D28 login variants (`facebook_login`, `instagram_login`) normalize
 * identically — i.e. the adapter never branches on `auth_variant` (Principle IV). The
 * `instagram_login` fixture does not exist: that variant needs a second Meta App and was not
 * attempted (spec.md §17 S2). Per spec.md §18 ("A17's two-variant equivalence test runs against
 * one live fixture"), this test therefore runs the **same** recorded body
 * (`__fixtures__/s2-facebook-login-comments.json`) through both arms, differing only in host
 * (`graph.facebook.com` vs `graph.instagram.com`) and credential, and asserts the two arms produce
 * identical results. That proves the adapter is variant-independent; it claims nothing about what
 * `graph.instagram.com` actually returns, since nobody has observed that — asserting a
 * hand-written second fixture would claim exactly the thing the spike gate exists to prevent.
 */

import { readFileSync } from 'node:fs';
import { http, HttpResponse, type JsonBodyType } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createInstagramAdapter } from '#src/platforms/meta/instagram-adapter.ts';
import type { AccountContext, ReconcileProbe } from '#src/platforms/types.ts';
import { asWorkspaceId } from '#src/shared/ids.ts';

const API_VERSION = 'v21.0';
const MEDIA_ID = 'media-1';
const OWN_ID = '1613543980513097';

// The verbatim S2 spike fixture (spec.md §17) — both D28 login variants below replay this exact
// body, proving the adapter is variant-independent without asserting anything about a response
// `graph.instagram.com` has never actually returned (spec.md §18).
const FIXTURE = JSON.parse(
  readFileSync(new URL('./__fixtures__/s2-facebook-login-comments.json', import.meta.url), 'utf8'),
) as JsonBodyType;

interface Variant {
  readonly authVariant: 'facebook_login' | 'instagram_login';
  readonly host: string;
}

const VARIANTS: readonly Variant[] = [
  { authVariant: 'facebook_login', host: 'https://graph.facebook.com' },
  { authVariant: 'instagram_login', host: 'https://graph.instagram.com' },
];

function contextFor(variant: Variant): AccountContext {
  return {
    workspaceId: asWorkspaceId('ws-1'),
    socialAccountId: 'account-1',
    platform: 'instagram',
    platformAccountId: OWN_ID,
    credentials: {
      platform: 'instagram',
      socialAccountId: 'account-1',
      authVariant: variant.authVariant,
      token: Buffer.from(`${variant.authVariant}-token`),
    },
  };
}

// Built after `server.listen()` patches the global `fetch` — `createGraphClient` captures
// whichever `fetch` is live at construction time, so building this eagerly at module scope would
// bind the real, unmocked implementation.
let adapter: ReturnType<typeof createInstagramAdapter>;

const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
  adapter = createInstagramAdapter({ apiVersion: API_VERSION });
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** The flattened shape `listComments` must normalize the S2 fixture into (observations 1-2, §17). */
const EXPECTED_COMMENTS = [
  expect.objectContaining({
    platformCommentId: '17910337956527168',
    platformParentId: null,
    authorPlatformId: '1613543980513097',
    authorUsername: 'agolosnichenko',
    authorDisplayName: null,
    text: '😻',
  }),
  expect.objectContaining({
    platformCommentId: '18089156657270757',
    platformParentId: '17910337956527168',
    authorPlatformId: '17841424426336279',
    authorUsername: 'blotato_demo',
    authorDisplayName: null,
    text: '🙌',
  }),
  expect.objectContaining({
    platformCommentId: '18125343199805950',
    platformParentId: null,
    authorPlatformId: '1613543980513097',
    authorUsername: 'agolosnichenko',
    authorDisplayName: null,
    text: 'Cuuuuuute!',
  }),
];

async function expectFixtureNormalizesCorrectly(variant: Variant): Promise<void> {
  server.use(
    http.get(`${variant.host}/${API_VERSION}/${MEDIA_ID}/comments`, () =>
      HttpResponse.json(FIXTURE),
    ),
  );

  const page = await adapter.listComments(contextFor(variant), { platformPostId: MEDIA_ID });

  expect(page.deletedPlatformCommentIds).toEqual([]);
  expect(page.nextCursor).toBeNull();
  expect(page.comments).toEqual(EXPECTED_COMMENTS);
}

async function expectPublishReturnsCreatedId(variant: Variant): Promise<void> {
  server.use(
    http.post(`${variant.host}/${API_VERSION}/${MEDIA_ID}/comments`, () =>
      HttpResponse.json({ id: 'new-comment-1' }),
    ),
  );

  const published = await adapter.publishComment(contextFor(variant), {
    platformPostId: MEDIA_ID,
    platformParentId: null,
    text: 'hello',
  });

  expect(published.platformCommentId).toBe('new-comment-1');
}

/** A17's "own" detection: `findPublishedComment` matches `ctx.platformAccountId` against `from.id`. */
async function expectOwnCommentIsFound(variant: Variant): Promise<void> {
  const probe: ReconcileProbe = {
    platformPostId: MEDIA_ID,
    platformParentId: null,
    authorPlatformId: OWN_ID,
    text: '😻',
    windowStartsAt: new Date('2020-01-01T00:00:00Z'),
  };
  server.use(
    http.get(`${variant.host}/${API_VERSION}/${MEDIA_ID}/comments`, () =>
      HttpResponse.json(FIXTURE),
    ),
  );

  const found = await adapter.findPublishedComment(contextFor(variant), probe);

  expect(found).toEqual({
    platformCommentId: '17910337956527168',
    platformCreatedAt: new Date('2026-09-13T02:49:30+0000'),
  });
}

/**
 * Derives a truncated-replies body from the recorded `FIXTURE` (fix round 1) rather than
 * hand-writing one: only the first comment's `replies` gains a `paging.next`, simulating Meta
 * capping the nested edge (25 replies by default) — the comment data itself is still the verbatim
 * S2 body, never an invented shape nobody has observed.
 */
function buildTruncatedRepliesFixture(): JsonBodyType {
  const clone = structuredClone(FIXTURE) as {
    data: Array<{ replies?: { data: unknown[]; paging?: { next: string } } }>;
  };
  const first = clone.data[0];
  if (first?.replies === undefined) {
    throw new Error('test assumption violated: FIXTURE[0] has no replies to truncate');
  }
  first.replies = { ...first.replies, paging: { next: 'https://graph.facebook.com/next-page' } };
  return clone as JsonBodyType;
}

/** Fix round 1: a truncated nested reply edge must abort the walk, not silently drop replies. */
async function expectTruncatedRepliesToThrow(variant: Variant): Promise<void> {
  server.use(
    http.get(`${variant.host}/${API_VERSION}/${MEDIA_ID}/comments`, () =>
      HttpResponse.json(buildTruncatedRepliesFixture()),
    ),
  );

  await expect(
    adapter.listComments(contextFor(variant), { platformPostId: MEDIA_ID }),
  ).rejects.toThrow(/17910337956527168/u);
}

describe.each(VARIANTS)('instagram adapter — $authVariant', (variant) => {
  it('normalizes the S2 fixture into the expected flattened comments', () =>
    expectFixtureNormalizesCorrectly(variant));

  it('publishes a comment and returns the created id', () =>
    expectPublishReturnsCreatedId(variant));

  it('finds its own published comment (A17)', () => expectOwnCommentIsFound(variant));

  it('throws, naming the comment id, when a reply edge is truncated past one page', () =>
    expectTruncatedRepliesToThrow(variant));
});

describe('instagram adapter — cross-variant equivalence', () => {
  it('produces byte-identical normalized comments for both D28 login variants', async () => {
    server.use(http.get(/\/v21\.0\/media-1\/comments$/u, () => HttpResponse.json(FIXTURE)));

    const pages = await Promise.all(
      VARIANTS.map((variant) =>
        adapter.listComments(contextFor(variant), { platformPostId: MEDIA_ID }),
      ),
    );

    expect(pages[0]).toEqual(pages[1]);
  });
});
