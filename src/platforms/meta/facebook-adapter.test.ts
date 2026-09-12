/**
 * Unit tests for the Facebook read path (T084): `listComments` and `fetchComment` in
 * `facebook-adapter.ts`. The Graph API is mocked at the HTTP boundary with msw — never a real
 * `graph.facebook.com` call.
 */

import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createFacebookAdapter } from '#src/platforms/meta/facebook-adapter.ts';
import { RetryableError, type AccountContext } from '#src/platforms/types.ts';

const API_VERSION = 'v21.0';
const GRAPH = `https://graph.facebook.com/${API_VERSION}`;
const POST_ID = 'post-1';
const OWN_ID = 'page-1';

// Built after `server.listen()` patches the global `fetch` — `createGraphClient` captures
// whichever `fetch` is live at construction time, so building this eagerly at module scope would
// bind the real, unmocked implementation.
let adapter: ReturnType<typeof createFacebookAdapter>;

const ctx: AccountContext = {
  workspaceId: 'ws-1',
  socialAccountId: 'account-1',
  platform: 'facebook',
  platformAccountId: OWN_ID,
  credentials: { platform: 'facebook', authVariant: null, token: Buffer.from('page-token') },
};

const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
  adapter = createFacebookAdapter({ apiVersion: API_VERSION });
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

interface CommentFixture {
  readonly id: string;
  readonly message: string;
  readonly fromId?: string;
  readonly fromName?: string;
  readonly parentId?: string;
}

function commentNode(fixture: CommentFixture): Record<string, unknown> {
  return {
    id: fixture.id,
    message: fixture.message,
    created_time: '2026-01-01T00:00:00+0000',
    ...(fixture.fromId === undefined
      ? {}
      : { from: { id: fixture.fromId, name: fixture.fromName } }),
    ...(fixture.parentId === undefined ? {} : { parent: { id: fixture.parentId } }),
  };
}

function mockCommentsPage(): void {
  server.use(
    http.get(`${GRAPH}/${POST_ID}/comments`, ({ request }) => {
      const after = new URL(request.url).searchParams.get('after');
      if (after === null) {
        return HttpResponse.json({
          data: [commentNode({ id: 'c1', message: 'top', fromId: 'user-1', fromName: 'User One' })],
          paging: {
            cursors: { after: 'cursor-1' },
            next: `${GRAPH}/${POST_ID}/comments?after=cursor-1`,
          },
        });
      }
      expect(after).toBe('cursor-1');
      return HttpResponse.json({
        data: [commentNode({ id: 'c2', message: 'reply', fromId: OWN_ID, parentId: 'c1' })],
        paging: { cursors: { after: 'cursor-2' } },
      });
    }),
  );
}

describe('createFacebookAdapter().listComments', () => {
  it('normalizes a page and follows the Graph API paging cursor to the last page', async () => {
    mockCommentsPage();

    const firstPage = await adapter.listComments(ctx, { platformPostId: POST_ID });
    expect(firstPage.comments).toEqual([
      expect.objectContaining({
        platformCommentId: 'c1',
        platformParentId: null,
        authorPlatformId: 'user-1',
        authorDisplayName: 'User One',
        text: 'top',
      }),
    ]);
    expect(firstPage.nextCursor).toBe('cursor-1');

    const secondPage = await adapter.listComments(
      ctx,
      { platformPostId: POST_ID },
      firstPage.nextCursor ?? undefined,
    );
    expect(secondPage.comments).toEqual([
      expect.objectContaining({
        platformCommentId: 'c2',
        platformParentId: 'c1',
        authorPlatformId: OWN_ID,
      }),
    ]);
    // No `paging.next` on the second response: this is the last page.
    expect(secondPage.nextCursor).toBeNull();
  });

  it('throws rather than returning a page when a transport failure interrupts paging', async () => {
    server.use(
      http.get(`${GRAPH}/${POST_ID}/comments`, () =>
        HttpResponse.json({ error: { message: 'boom' } }, { status: 500 }),
      ),
    );

    await expect(adapter.listComments(ctx, { platformPostId: POST_ID })).rejects.toBeInstanceOf(
      RetryableError,
    );
  });
});

describe('createFacebookAdapter().fetchComment', () => {
  it('normalizes a found comment', async () => {
    server.use(
      http.get(`${GRAPH}/c1`, () =>
        HttpResponse.json(commentNode({ id: 'c1', message: 'hello', fromId: 'user-1' })),
      ),
    );

    const comment = await adapter.fetchComment(ctx, 'c1');

    expect(comment).toMatchObject({
      platformCommentId: 'c1',
      text: 'hello',
      authorPlatformId: 'user-1',
    });
  });

  it('returns null for a deleted comment (Graph "object does not exist")', async () => {
    server.use(
      http.get(`${GRAPH}/gone`, () =>
        HttpResponse.json(
          { error: { message: 'Unsupported get request.', code: 100, error_subcode: 33 } },
          { status: 400 },
        ),
      ),
    );

    const comment = await adapter.fetchComment(ctx, 'gone');

    expect(comment).toBeNull();
  });

  it('still throws for an unrelated 400 rather than treating it as not-found', async () => {
    server.use(
      http.get(`${GRAPH}/bad`, () =>
        HttpResponse.json({ error: { message: 'invalid parameter', code: 100 } }, { status: 400 }),
      ),
    );

    await expect(adapter.fetchComment(ctx, 'bad')).rejects.toThrow();
  });
});
