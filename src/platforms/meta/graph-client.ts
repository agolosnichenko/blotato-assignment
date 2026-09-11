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
 * `X-App-Usage` is a flat object of percentages; `X-Business-Use-Case-Usage` is an object keyed
 * by business-account id, each value an array of the same shape (one entry per use case) — this
 * takes the highest percentage across every entry in either shape.
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

  const entries = Object.values(parsed as Record<string, unknown>).flatMap((value) =>
    Array.isArray(value) ? value : [value],
  );
  const percents = entries
    .filter(
      (entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object',
    )
    .map((entry) => highestPercentFrom(entry))
    .filter((value): value is number => value !== undefined);

  return percents.length > 0 ? { highestPercent: Math.max(...percents) } : null;
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
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        throw new GraphHttpError(response.status, body, response.headers);
      }
      return { data: body as T, usage };
    },
  };
}

function withQuery(fetchImpl: typeof fetch, url: URL, search: URLSearchParams): Promise<Response> {
  url.search = search.toString();
  return fetchImpl(url, { method: 'GET' });
}
