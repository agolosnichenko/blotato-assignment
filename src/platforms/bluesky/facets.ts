/**
 * Facet detection for Bluesky posts (spec.md §8.3, A5).
 *
 * A5 makes deriving link/mention/tag markup this service's job rather than the caller's — a
 * customer submits plain text, and this module turns it into the `app.bsky.richtext.facet`
 * annotations `com.atproto.repo.createRecord` expects. The indices those facets carry are UTF-8
 * *byte* offsets, not UTF-16 code-unit offsets (facets.test.ts pins this over a multi-byte
 * string), so detection is delegated entirely to `@atproto/api`'s `RichText` rather than
 * re-implemented by hand.
 */

import { AppBskyRichtextFacet, RichText, type AtpBaseClient, type Facet } from '@atproto/api';

function isUnresolvedMention(feature: Facet['features'][number]): boolean {
  return AppBskyRichtextFacet.isMention(feature) && feature.did.length === 0;
}

/**
 * Drops mention features whose handle did not resolve, and any facet left with no features.
 *
 * `RichText.detectFacets` emits a mention feature with an empty `did` when
 * `com.atproto.identity.resolveHandle` finds nothing — a typo'd handle, or one that no longer
 * exists. An empty `did` fails the PDS's lexicon validation, so the whole `createRecord` is
 * rejected as a 400, which this service classifies as a `PermanentError`: the customer's reply is
 * discarded for good because of one bad `@handle` in its text.
 *
 * Publishing the mention as plain text is the only outcome here that keeps the reply. It is also
 * what the reader sees anyway — an unresolvable handle has no account to link to.
 */
function withoutUnresolvedMentions(facets: Facet[]): Facet[] {
  const usable: Facet[] = [];
  for (const facet of facets) {
    const features = facet.features.filter((feature) => !isUnresolvedMention(feature));
    if (features.length > 0) {
      usable.push({ ...facet, features });
    }
  }
  return usable;
}

/**
 * Detects link, mention and tag facets in `text`, resolving `@handle` mentions to real DIDs
 * through `agent` so a published mention links to the account rather than embedding a bare
 * handle string.
 *
 * Args:
 *   agent: An authenticated client able to resolve handles
 *     (`com.atproto.identity.resolveHandle`) — the adapter's logged-in session.
 *   text: The comment text being published.
 *
 * Returns:
 *   The detected facets, or an empty array when `text` carries no links, mentions or tags. A
 *   mention whose handle did not resolve is left out rather than published as an invalid DID —
 *   see {@link withoutUnresolvedMentions} for why that trade is not close.
 */
export async function detectFacets(agent: AtpBaseClient, text: string): Promise<Facet[]> {
  const richText = new RichText({ text });
  await richText.detectFacets(agent);
  return withoutUnresolvedMentions(richText.facets ?? []);
}
