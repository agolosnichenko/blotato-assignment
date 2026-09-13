/**
 * Unit tests for the Bluesky read path (T083): `listComments` and `fetchComment` in `adapter.ts`,
 * backed by `thread.ts`'s walk. `@atproto/api` talks to `https://bsky.social` (the hardcoded
 * entryway `adapter.ts` proxies session creation through), mocked at the HTTP boundary with msw —
 * never a real PDS.
 */

import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createBlueskyAdapter } from '#src/platforms/bluesky/adapter.ts';
import { PermanentError, RetryableError, type AccountContext } from '#src/platforms/types.ts';

const SERVICE = 'https://bsky.social';
const OWNER_DID = 'did:plc:owner';
const ROOT_URI = 'at://did:plc:owner/app.bsky.feed.post/root';
// A real CIDv1 — the lexicon validator parses it, not just checks the shape of a string.
const FAKE_CID = 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e';

const server = setupServer(
  http.post(`${SERVICE}/xrpc/com.atproto.server.createSession`, () =>
    HttpResponse.json({
      accessJwt: 'access.jwt',
      refreshJwt: 'refresh.jwt',
      handle: 'owner.test',
      did: OWNER_DID,
      active: true,
    }),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// The depth that drives the pagination tests below — same value as `Config.BLUESKY_THREAD_DEPTH`'s
// default, not re-derived from it: this file tests `adapter.ts`'s pagination mechanics, not the
// default itself.
const adapter = createBlueskyAdapter({ threadDepth: 10 });

let nextAccountId = 0;

/** A fresh `socialAccountId` per test avoids reusing `adapter.ts`'s module-level session cache. */
function accountContext(): AccountContext {
  nextAccountId += 1;
  return {
    workspaceId: 'ws-1',
    socialAccountId: `account-${nextAccountId}`,
    platform: 'bluesky',
    platformAccountId: OWNER_DID,
    credentials: { token: Buffer.from('app-password') },
  };
}

interface PostOptions {
  readonly authorDid: string;
  readonly handle: string;
  readonly text: string;
  readonly parentUri?: string;
  readonly replyCount?: number;
}

/** A `postView`-shaped fixture, replying to `parentUri` (default: the thread root) or top-level. */
function post(uri: string, options: PostOptions): unknown {
  return {
    $type: 'app.bsky.feed.defs#postView',
    uri,
    cid: FAKE_CID,
    author: {
      $type: 'app.bsky.actor.defs#profileViewBasic',
      did: options.authorDid,
      handle: options.handle,
    },
    record: {
      $type: 'app.bsky.feed.post',
      text: options.text,
      createdAt: '2026-01-01T00:00:00.000Z',
      ...(options.parentUri === undefined
        ? {}
        : {
            reply: {
              root: { uri: ROOT_URI, cid: FAKE_CID },
              parent: { uri: options.parentUri, cid: FAKE_CID },
            },
          }),
    },
    indexedAt: '2026-01-01T00:00:00.000Z',
    replyCount: options.replyCount ?? 0,
  };
}

function threadOf(postFixture: unknown, replies?: readonly unknown[]): unknown {
  return {
    $type: 'app.bsky.feed.defs#threadViewPost',
    post: postFixture,
    ...(replies ? { replies } : {}),
  };
}

function notFoundPost(uri: string): unknown {
  return { $type: 'app.bsky.feed.defs#notFoundPost', uri, notFound: true };
}

/** The thread root itself; its own content is never a comment. */
function rootThread(replies: readonly unknown[]): unknown {
  return threadOf(
    post(ROOT_URI, { authorDid: OWNER_DID, handle: 'owner.test', text: '' }),
    replies,
  );
}

function mockThread(uri: string, thread: unknown): void {
  server.use(
    http.get(`${SERVICE}/xrpc/app.bsky.feed.getPostThread`, ({ request }) => {
      const requested = new URL(request.url).searchParams.get('uri');
      if (requested !== uri) {
        return HttpResponse.json(
          { error: 'InvalidRequest', message: 'unexpected uri' },
          { status: 400 },
        );
      }
      return HttpResponse.json({ thread });
    }),
  );
}

const BRANCH_URI = 'at://did:plc:owner/app.bsky.feed.post/branch';
const BRANCH_OPTIONS = { authorDid: 'did:plc:bob', handle: 'bob.test', text: 'branch' };

describe('blueskyAdapter.listComments — normalization', () => {
  it('normalizes a direct reply and reports a notFoundPost sibling as a deleted id, not a comment', async () => {
    const replyUri = 'at://did:plc:owner/app.bsky.feed.post/a';
    const goneUri = 'at://did:plc:owner/app.bsky.feed.post/gone';
    mockThread(
      ROOT_URI,
      rootThread([
        threadOf(
          post(replyUri, {
            authorDid: 'did:plc:alice',
            handle: 'alice.test',
            text: 'hello',
            parentUri: ROOT_URI,
          }),
        ),
        notFoundPost(goneUri),
      ]),
    );

    const page = await adapter.listComments(accountContext(), { platformPostId: ROOT_URI });

    expect(page.nextCursor).toBeNull();
    // The tombstone's id is never in `comments` — a consumer iterating it would otherwise upsert
    // the tombstone as an ordinary `posted` row (spec.md §18, extends §8.3).
    expect(page.comments).toEqual([
      expect.objectContaining({
        platformCommentId: replyUri,
        platformParentId: ROOT_URI,
        text: 'hello',
        platformMeta: { cid: FAKE_CID },
      }),
    ]);
    expect(page.deletedPlatformCommentIds).toEqual([goneUri]);
  });
});

describe('blueskyAdapter.listComments — pagination across truncated branches', () => {
  it('queues a branch getPostThread truncated, without emitting it as a comment yet', async () => {
    // `replies` omitted below the reply count: depth ran out here, not a real leaf.
    mockThread(
      ROOT_URI,
      rootThread([
        threadOf(post(BRANCH_URI, { ...BRANCH_OPTIONS, parentUri: ROOT_URI, replyCount: 1 })),
      ]),
    );

    const page = await adapter.listComments(accountContext(), { platformPostId: ROOT_URI });

    expect(page.comments.map((c) => c.platformCommentId)).toEqual([BRANCH_URI]);
    expect(page.deletedPlatformCommentIds).toEqual([]);
    expect(page.nextCursor).toBe(JSON.stringify([BRANCH_URI]));
  });

  it('reports a branch that vanished before its queued page ran as a deleted id, not a comment', async () => {
    mockThread(BRANCH_URI, notFoundPost(BRANCH_URI));

    const page = await adapter.listComments(
      accountContext(),
      { platformPostId: ROOT_URI },
      JSON.stringify([BRANCH_URI]),
    );

    expect(page.comments).toEqual([]);
    expect(page.deletedPlatformCommentIds).toEqual([BRANCH_URI]);
    expect(page.nextCursor).toBeNull();
  });
});

describe('blueskyAdapter.listComments — resuming a queued branch', () => {
  it('resumes a queued branch from its cursor without re-emitting the branch root', async () => {
    const leafUri = 'at://did:plc:owner/app.bsky.feed.post/leaf';
    mockThread(
      BRANCH_URI,
      threadOf(post(BRANCH_URI, BRANCH_OPTIONS), [
        threadOf(
          post(leafUri, {
            authorDid: 'did:plc:carol',
            handle: 'carol.test',
            text: 'leaf',
            parentUri: BRANCH_URI,
          }),
        ),
      ]),
    );

    const page = await adapter.listComments(
      accountContext(),
      { platformPostId: ROOT_URI },
      JSON.stringify([BRANCH_URI]),
    );

    // The branch root (`BRANCH_URI`) is not repeated — only its new child is.
    expect(page.comments.map((c) => c.platformCommentId)).toEqual([leafUri]);
    expect(page.deletedPlatformCommentIds).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});

describe('blueskyAdapter.listComments — failures never look like an empty complete page', () => {
  it('throws PermanentError when the anchor post itself is gone', async () => {
    mockThread(ROOT_URI, notFoundPost(ROOT_URI));

    await expect(
      adapter.listComments(accountContext(), { platformPostId: ROOT_URI }),
    ).rejects.toBeInstanceOf(PermanentError);
  });

  it('throws rather than returning a page when a transport failure interrupts the walk', async () => {
    server.use(
      http.get(`${SERVICE}/xrpc/app.bsky.feed.getPostThread`, () =>
        HttpResponse.json({ error: 'InternalServerError', message: 'boom' }, { status: 500 }),
      ),
    );

    await expect(
      adapter.listComments(accountContext(), { platformPostId: ROOT_URI }),
    ).rejects.toBeInstanceOf(RetryableError);
  });

  it('rejects a cursor it did not itself produce as a PermanentError', async () => {
    await expect(
      adapter.listComments(accountContext(), { platformPostId: ROOT_URI }, 'not-json'),
    ).rejects.toBeInstanceOf(PermanentError);
  });
});

describe('blueskyAdapter.fetchComment', () => {
  it('normalizes a found post, deriving platformParentId from its own record', async () => {
    const uri = 'at://did:plc:owner/app.bsky.feed.post/a';
    mockThread(
      uri,
      threadOf(
        post(uri, {
          authorDid: 'did:plc:alice',
          handle: 'alice.test',
          text: 'hello',
          parentUri: ROOT_URI,
        }),
      ),
    );

    const comment = await adapter.fetchComment(accountContext(), uri);

    expect(comment).toMatchObject({
      platformCommentId: uri,
      platformParentId: ROOT_URI,
      authorPlatformId: 'did:plc:alice',
    });
  });

  it('returns null for a deleted (notFoundPost) comment', async () => {
    const uri = 'at://did:plc:owner/app.bsky.feed.post/gone';
    mockThread(uri, notFoundPost(uri));

    const comment = await adapter.fetchComment(accountContext(), uri);

    expect(comment).toBeNull();
  });
});
