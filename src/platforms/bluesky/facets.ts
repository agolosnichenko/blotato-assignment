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

import { RichText, type AtpBaseClient, type Facet } from '@atproto/api';

/**
 * Detects link, mention and tag facets in `text`, resolving `@handle` mentions to real DIDs
 * through `agent` so a published mention links to the account rather than embedding a bare
 * handle string (an unresolved mention's `did` field is not a valid DID and would fail the
 * PDS's lexicon validation on write).
 *
 * Args:
 *   agent: An authenticated client able to resolve handles
 *     (`com.atproto.identity.resolveHandle`) — the adapter's logged-in session.
 *   text: The comment text being published.
 *
 * Returns:
 *   The detected facets, or an empty array when `text` carries no links, mentions or tags.
 */
export async function detectFacets(agent: AtpBaseClient, text: string): Promise<Facet[]> {
  const richText = new RichText({ text });
  await richText.detectFacets(agent);
  return richText.facets ?? [];
}
