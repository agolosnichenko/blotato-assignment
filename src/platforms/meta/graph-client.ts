/**
 * Meta Graph API client (spec.md §8.2, D28, contracts/platform-adapter.md).
 *
 * This is the only file in the codebase that resolves the Instagram `auth_variant`: a
 * `facebook_login` account is called against `graph.facebook.com` with its Page token, an
 * `instagram_login` account against `graph.instagram.com` with its Instagram user token. Every
 * other Meta file — including the two adapters built on top of this client — receives the
 * credentials the `AccountCredentials` port supplies (D26) and passes them through untouched;
 * neither adapter ever reads or branches on `auth_variant` itself (Principle IV).
 *
 * Every failure — an HTTP error response and a transport failure that never produced one — is
 * left for `src/platforms/meta/errors.ts` to classify. This client does not retry and does not
 * throw its own error type; it surfaces exactly what `fetch` (built on undici in Node 22) and the
 * Graph API gave it, since classifying a failure requires knowing what it actually was, not a
 * client-invented shape.
 */

import type { AccountCredentialsRecord } from '#src/modules/platform-core/ports.ts';

const FACEBOOK_HOST = 'https://graph.facebook.com';
const INSTAGRAM_HOST = 'https://graph.instagram.com';

/** Comments fetched per reconciliation page — 100 is the Graph API's cap for a comment edge. */
export const RECONCILE_PAGE_SIZE = 100;

/**
 * Pages a reconciliation search reads before it gives up.
 *
 * At {@link RECONCILE_PAGE_SIZE} per page this covers a thread of 2000 comments. Giving up is not
 * the same as "not found": the caller is told the outcome is still unknown (D14), so the bound
 * protects the worker from an unbounded walk without ever licensing a blind republish.
 */
export const RECONCILE_MAX_PAGES = 20;

/** A parsed `X-Business-Use-Case-Usage` / `X-App-Usage` reading (spec.md §8.2). */
export interface GraphUsage {
  /** The highest of the call-count / CPU-time / total-time percentages Meta reported, 0-100. */
  readonly highestPercent: number;
}

export interface GraphResponse<T> {
  readonly data: T;
  /** `null` when neither usage header was present or parseable — advisory only, never fatal. */
  readonly usage: GraphUsage | null;
}

/** A Graph API response body carrying `{"error": {...}}`, distinct from a transport failure. */
export class GraphHttpError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly body: unknown,
    readonly headers: Headers,
  ) {
    super(`graph api request failed with status ${httpStatus}`);
    this.name = 'GraphHttpError';
  }
}

export interface GraphClientOptions {
  readonly apiVersion: string;
  /** Injected in tests; defaults to the global `fetch` built into Node 22. */
  readonly fetchImpl?: typeof fetch;
  /**
   * Where the parsed throttling signal goes (spec.md §8.2).
   *
   * A sink rather than a field on the response: `usage` is a Meta-specific fact about an account,
   * and routing it up through `CommentPage` / `PublishedComment` would put a platform's vocabulary
   * into the platform-agnostic port every use case depends on. Reporting it sideways keeps the
   * port clean and still lets the workers act on it.
   */
  readonly onUsage?: (socialAccountId: string, usage: GraphUsage) => void;
}

export interface GraphClient {
  request<T>(
    credentials: AccountCredentialsRecord,
    method: 'GET' | 'POST',
    path: string,
    params: Record<string, string>,
  ): Promise<GraphResponse<T>>;
}

/**
 * Narrows the port's generic, platform-discriminated credential union to the Meta arm and
 * resolves it to a host + token — the one place in the codebase that reads `authVariant` (D28).
 *
 * Args:
 *   credentials: What the caller (an Instagram or Facebook adapter) received from the
 *     `AccountCredentials` port and forwarded through unread.
 *
 * Raises:
 *   Error: If `credentials` is for a platform this client does not serve — a programming error in
 *     the caller, not a Graph API failure, so it is not one of the four typed adapter errors.
 */
function resolveEndpoint(credentials: AccountCredentialsRecord): { host: string; token: string } {
  const token = credentials.token.toString('utf8');
  if (credentials.platform !== 'instagram' && credentials.platform !== 'facebook') {
    throw new Error(`meta graph client received credentials for platform: ${credentials.platform}`);
  }
  if (credentials.authVariant === 'instagram_login') {
    return { host: INSTAGRAM_HOST, token };
  }
  // `facebook_login`, and Facebook accounts themselves (the variant is Instagram-only, D28),
  // both call the Facebook host with the Page token.
  return { host: FACEBOOK_HOST, token };
}

/**
 * Parses one usage-percentage field out of an `X-App-Usage`-shaped JSON object.
 *
 * Args:
 *   raw: The decoded header value, expected to carry numeric `call_count` / `total_cputime` /
 *     `total_time` percentages.
 *
 * Returns:
 *   The highest of the three percentages found, or `undefined` if none parsed as a number.
 */
function highestPercentFrom(raw: Record<string, unknown>): number | undefined {
  const values = [raw['call_count'], raw['total_cputime'], raw['total_time']]
    .filter((value): value is number => typeof value === 'number')
    .filter((value) => Number.isFinite(value));
  return values.length > 0 ? Math.max(...values) : undefined;
}

/**
 * Parses the throttling signal out of whichever usage header the response carried.
 *
 * The two headers have genuinely different shapes, and the flat one is the important case for
 * `instagram_login` accounts (D28): app-level calls against `graph.instagram.com` return
 * `X-App-Usage`, a flat `{"call_count":28,"total_cputime":25,"total_time":25}`.
 * `X-Business-Use-Case-Usage` instead maps a business-account id to an array of that same flat
 * object, one entry per use case. Treating the flat object as a container of entries — as an
 * earlier version did — filtered its numeric values away as "not objects" and reported no usage
 * at all for exactly the login variant that only ever sends it.
 */
function parseUsageHeaders(headers: Headers): GraphUsage | null {
  const raw = headers.get('x-business-use-case-usage') ?? headers.get('x-app-usage');
  if (raw === null) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return null;
  }

  const percents = usageEntries(parsed as Record<string, unknown>)
    .map((entry) => highestPercentFrom(entry))
    .filter((value): value is number => value !== undefined);

  return percents.length > 0 ? { highestPercent: Math.max(...percents) } : null;
}

/**
 * The flat percentage objects to read, whichever header shape `parsed` came from.
 *
 * A flat `X-App-Usage` object *is* the single entry; a `X-Business-Use-Case-Usage` object holds
 * its entries in per-account arrays.
 */
function usageEntries(parsed: Record<string, unknown>): Record<string, unknown>[] {
  const nested = Object.values(parsed).filter((value): value is unknown[] => Array.isArray(value));
  if (nested.length === 0) {
    return [parsed];
  }
  return nested
    .flat()
    .filter(
      (entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object',
    );
}

/**
 * Builds a Graph API client bound to one app's API version.
 *
 * Args:
 *   options: `apiVersion` (from `Config.META_GRAPH_API_VERSION`) and an optional `fetchImpl` for
 *     tests.
 *
 * Returns:
 *   A {@link GraphClient} whose `request` resolves host and token per-call from the credentials
 *   it is given — a client is not bound to one account.
 */
export function createGraphClient(options: GraphClientOptions): GraphClient {
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async request<T>(
      credentials: AccountCredentialsRecord,
      method: 'GET' | 'POST',
      path: string,
      params: Record<string, string>,
    ): Promise<GraphResponse<T>> {
      const { host, token } = resolveEndpoint(credentials);
      const url = new URL(`${host}/${options.apiVersion}${path}`);
      const search = new URLSearchParams({ ...params, access_token: token });

      const response =
        method === 'GET'
          ? await withQuery(fetchImpl, url, search)
          : await fetchImpl(url, {
              method: 'POST',
              body: search,
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
            });

      const usage = parseUsageHeaders(response.headers);
      if (usage !== null) {
        options.onUsage?.(credentials.socialAccountId, usage);
      }
      // An error body that will not parse is still a usable error — the status carries the
      // meaning, and `errors.ts` reads the body only to refine it.
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        throw new GraphHttpError(response.status, body, response.headers);
      }
      if (body === null) {
        // A 2xx whose body did not parse is a different thing entirely: there is no result to
        // hand back. Returning `null as T` used to defer that to whatever read `data` next, which
        // surfaced as a `TypeError` the classifier then reported as a transport failure that never
        // happened. On a write path that mislabels the outcome of a request Meta did answer.
        throw new GraphHttpError(response.status, null, response.headers);
      }
      return { data: body as T, usage };
    },
  };
}

function withQuery(fetchImpl: typeof fetch, url: URL, search: URLSearchParams): Promise<Response> {
  url.search = search.toString();
  return fetchImpl(url, { method: 'GET' });
}
