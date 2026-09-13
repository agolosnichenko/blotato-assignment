/**
 * The reconciliation search both Meta adapters run after an ambiguous write (FR-011, D14).
 *
 * This is the one read in the service whose *negative* answer authorises a second publish, so its
 * contract is narrower than an ordinary listing: `null` means "a complete walk of this edge found
 * nothing", and every way of not finishing — a failed page, a `next` Graph gave no cursor for, the
 * page cap — raises instead. A search that quietly stopped early would be read as "not posted" and
 * duplicate a public comment.
 *
 * A Graph comment edge is returned oldest-first, so the comment published seconds ago is on the
 * *last* page; reading only the first (Graph's default of 25) answers "not found" for any thread
 * busier than that. Hence the walk, rather than a single request.
 */

import type { AccountCredentialsRecord } from '#src/modules/platform-core/ports.ts';
import { classifyGraphFailure } from '#src/platforms/meta/errors.ts';
import {
  RECONCILE_MAX_PAGES,
  RECONCILE_PAGE_SIZE,
  type GraphClient,
} from '#src/platforms/meta/graph-client.ts';
import { OutcomeUnknownError, type PublishedComment } from '#src/platforms/types.ts';

/** The paging envelope every Graph edge shares; only what the walk itself reads. */
interface EdgePaging {
  readonly cursors?: { readonly after?: string };
  /** Presence, not content, is what means "there is another page" (Graph API convention). */
  readonly next?: string;
}

interface EdgePage<TNode> {
  readonly data: readonly TNode[];
  readonly paging?: EdgePaging;
}

/** What one adapter has to supply for its own comment edge. */
export interface ReconcileEdge<TNode> {
  /** For error messages — `instagram` or `facebook`. */
  readonly platform: string;
  /** The edge to walk, e.g. `/{anchorId}/comments`. */
  readonly path: string;
  /** The `fields` parameter this adapter needs to evaluate its own matcher. */
  readonly fields: string;
  /** Extra query parameters, e.g. Facebook's `filter=stream`. */
  readonly params?: Record<string, string>;
  /** Returns the published comment when `node` is the one being searched for, else `null`. */
  readonly match: (node: TNode) => PublishedComment | null;
}

async function fetchPage<TNode>(
  graphClient: GraphClient,
  credentials: AccountCredentialsRecord,
  edge: ReconcileEdge<TNode>,
  cursor: string | undefined,
): Promise<EdgePage<TNode>> {
  try {
    const response = await graphClient.request<EdgePage<TNode>>(credentials, 'GET', edge.path, {
      ...edge.params,
      fields: edge.fields,
      limit: String(RECONCILE_PAGE_SIZE),
      ...(cursor === undefined ? {} : { after: cursor }),
    });
    return response.data;
  } catch (error) {
    // A search that fails must never be read as "not found" — that would let the caller retry a
    // publish that may already have succeeded.
    throw classifyGraphFailure(error, 'read');
  }
}

function nextCursor(paging: EdgePaging | undefined, describe: string): string | null {
  if (paging?.next === undefined) {
    return null;
  }
  if (paging.cursors?.after === undefined) {
    throw new OutcomeUnknownError(
      `${describe} cannot continue: paging.next present but paging.cursors.after missing`,
    );
  }
  return paging.cursors.after;
}

/**
 * Walks `edge` to its end looking for the comment `edge.match` recognises.
 *
 * Args:
 *   graphClient: The client to read through.
 *   credentials: What the `AccountCredentials` port supplied, forwarded unread (D26).
 *   edge: The edge to walk and how to recognise our own comment on it.
 *
 * Returns:
 *   The published comment, or `null` when — and only when — a complete walk found nothing.
 *
 * Raises:
 *   OutcomeUnknownError: If the walk could not be completed, so the publish outcome is still
 *     unknown and no second send may be authorised by this result.
 */
export async function findCommentOnEdge<TNode>(
  graphClient: GraphClient,
  credentials: AccountCredentialsRecord,
  edge: ReconcileEdge<TNode>,
): Promise<PublishedComment | null> {
  const describe = `${edge.platform} reconciliation for ${edge.path}`;
  let cursor: string | undefined;

  for (let page = 0; page < RECONCILE_MAX_PAGES; page += 1) {
    // oxlint-disable-next-line no-await-in-loop -- a keyset walk is sequential by construction
    const body = await fetchPage(graphClient, credentials, edge, cursor);
    for (const node of body.data) {
      const match = edge.match(node);
      if (match !== null) {
        return match;
      }
    }

    const next = nextCursor(body.paging, describe);
    if (next === null) {
      return null;
    }
    cursor = next;
  }

  throw new OutcomeUnknownError(`${describe} gave up after ${RECONCILE_MAX_PAGES} pages`);
}
