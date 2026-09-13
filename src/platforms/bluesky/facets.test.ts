import { AtpAgent, AppBskyRichtextFacet } from '@atproto/api';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { detectFacets } from '#src/platforms/bluesky/facets.ts';

const SERVICE = 'https://bsky.facets-test.invalid';

// `detectFacets` resolves `@handle` mentions over the network (com.atproto.identity.resolveHandle)
// — mocked at the HTTP boundary per the run's convention, never hitting a real PDS.
const server = setupServer(
  http.get(`${SERVICE}/xrpc/com.atproto.identity.resolveHandle`, ({ request }) => {
    const handle = new URL(request.url).searchParams.get('handle');
    return HttpResponse.json({ did: `did:plc:${handle}` });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function byteSlice(text: string, byteStart: number, byteEnd: number): string {
  return new TextDecoder().decode(bytesOf(text).slice(byteStart, byteEnd));
}

describe('detectFacets', () => {
  it('finds a URL, a mention and a tag at correct UTF-8 byte offsets over multi-byte text', async () => {
    // "héllo" and "señor" each carry a two-byte UTF-8 character before the facets that follow,
    // so a UTF-16-code-unit implementation would compute offsets that land one byte early for
    // every facet after the first accented character — exactly the drift A5 is worried about.
    const text = 'héllo https://example.com/x, cc @alice.test — ¡bienvenido señor #saludos!';
    const agent = new AtpAgent({ service: SERVICE });

    const facets = await detectFacets(agent, text);

    const link = facets.find((facet) => facet.features.some(AppBskyRichtextFacet.isLink));
    const mention = facets.find((facet) => facet.features.some(AppBskyRichtextFacet.isMention));
    const tag = facets.find((facet) => facet.features.some(AppBskyRichtextFacet.isTag));

    expect(link).toBeDefined();
    expect(byteSlice(text, link!.index.byteStart, link!.index.byteEnd)).toBe(
      'https://example.com/x',
    );

    expect(mention).toBeDefined();
    expect(byteSlice(text, mention!.index.byteStart, mention!.index.byteEnd)).toBe('@alice.test');
    const mentionFeature = mention!.features.find(AppBskyRichtextFacet.isMention);
    expect(mentionFeature?.did).toBe('did:plc:alice.test');

    expect(tag).toBeDefined();
    expect(byteSlice(text, tag!.index.byteStart, tag!.index.byteEnd)).toBe('#saludos');
  });

  it('finds no facets in plain text carrying none of the three markers', async () => {
    const agent = new AtpAgent({ service: SERVICE });

    const facets = await detectFacets(agent, 'just a plain reply, nothing special here');

    expect(facets).toEqual([]);
  });
});

describe('an unresolvable mention', () => {
  it('is dropped instead of being published as an invalid DID', async () => {
    // An empty `did` fails the PDS's lexicon validation, so `createRecord` answers 400 — which
    // this service classifies as `PermanentError` and the customer's whole reply is discarded.
    // One unresolvable `@handle` must cost the mention's link, not the reply.
    server.use(
      http.get(`${SERVICE}/xrpc/com.atproto.identity.resolveHandle`, () =>
        HttpResponse.json(
          { error: 'InvalidRequest', message: 'Unable to resolve handle' },
          {
            status: 400,
          },
        ),
      ),
    );
    const agent = new AtpAgent({ service: SERVICE });

    const facets = await detectFacets(agent, 'thanks @nobody.invalid — see https://example.com/x');

    expect(facets.some((facet) => facet.features.some(AppBskyRichtextFacet.isMention))).toBe(false);
    // The rest of the markup survives: only the unresolvable feature is removed.
    expect(facets.some((facet) => facet.features.some(AppBskyRichtextFacet.isLink))).toBe(true);
  });
});
