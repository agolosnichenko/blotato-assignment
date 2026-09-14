/**
 * API key authentication plugin (T033, A16, §10).
 *
 * Resolves the `blotato-api-key` header, looks the key up through the `ApiKeys` port (D8, D29 —
 * `api_keys` belongs to another service, so this module never queries it directly), and decorates
 * the request with the `workspaceId` every downstream repository call is scoped by (D20), the
 * `apiKeyId` the rate limiter (T034) keys its buckets on, and the key's own `rateLimitPerMin`
 * ceiling the rate limiter takes a `min()` against.
 *
 * The three ways a request can fail — no header, an unrecognized prefix, a revoked key — all throw
 * the same `ApiError` with the same `detail`, in the same time (see {@link verifySecret}'s call
 * site below). Per D20's `404`-not-`403` reasoning, whether a key exists is not something an
 * unauthenticated caller gets to probe, so nothing here may vary the response — including by
 * timing — by which case occurred.
 *
 * A short, explicit allowlist ({@link PUBLIC_ROUTES}) exempts the handful of routes that
 * authenticate themselves another way (the Meta webhook, via HMAC or `hub.verify_token`) or are
 * public by decision (D25 — `/docs` is the reviewer's way in; `/healthz`/`/readyz` are infra
 * probes). This fails closed by construction: everything not on the list requires the key, so a
 * future route registered without being added here answers `401` — loud and immediate — rather
 * than silently serving unauthenticated (the failure mode a `.register()`-scoped hook would allow
 * instead, one route module registered one scope too high).
 */

import type { FastifyBaseLogger, FastifyInstance, FastifyRequest, RawServerDefault } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiKeys } from '#src/modules/platform-core/ports.ts';
import { hashSecret, secureCompare } from '#src/shared/crypto.ts';
import { asWorkspaceId } from '#src/shared/ids.ts';
import { ApiError } from '#src/shared/errors.ts';
import type { WorkspaceId } from '#src/shared/ids.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** The workspace the authenticated API key belongs to (D20). Set by {@link registerApiKeyAuth}. */
    workspaceId: WorkspaceId;
    /** The authenticated API key's id. Set by {@link registerApiKeyAuth}; T034 rate-limits on it. */
    apiKeyId: string;
    /**
     * The key's own rate-limit ceiling, or `null` for none. Set by {@link registerApiKeyAuth}; T034
     * takes `min(envDefault, rateLimitPerMin)` — a per-key value may only lower the deployment's
     * default budget, never raise it.
     */
    rateLimitPerMin: number | null;
  }
}

const API_KEY_HEADER = 'blotato-api-key';

/** `blt_<prefix>_<secret>` (plan.md, data-model.md) — prefix has no underscores, secret may. */
const API_KEY_PATTERN = /^blt_([^_]+)_(.+)$/u;

const UNAUTHORIZED_DETAIL = 'missing, unrecognized, or revoked API key';

function unauthorized(): ApiError {
  return new ApiError('UNAUTHORIZED', UNAUTHORIZED_DETAIL);
}

function readHeader(request: FastifyRequest): string | undefined {
  const header = request.headers[API_KEY_HEADER];
  return Array.isArray(header) ? header[0] : header;
}

/**
 * Verifies the parsed secret against the record's stored hash.
 *
 * Both `hashSecret` outputs are fixed-length (32-byte) SHA-256 digests, which is exactly the case
 * `secureCompare` documents as safe: the digest step below is what makes the length-independent
 * `timingSafeEqual` inside it meaningful, so don't drop it as a redundant "optimization".
 */
function verifySecret(secret: string, keyHash: string): boolean {
  return secureCompare(hashSecret(secret), keyHash);
}

/**
 * A fixed, valid-shaped hash `verifySecret` compares against when no key record was found, so
 * the "no such prefix" and "wrong secret" paths pay the exact same hashing and comparison cost.
 * Its value is arbitrary — nothing is ever encrypted or verified against it for real — it only
 * needs to be a stable 32-byte SHA-256 digest so `secureCompare` runs its full length-independent
 * comparison instead of the caller skipping straight to `unauthorized()`. Computed once at import
 * time, not per request.
 */
const DUMMY_KEY_HASH = hashSecret('blt-dummy-key-hash-used-when-no-record-is-found');

/**
 * `published` answers a question the OpenAPI document (R-09, D31) cannot answer for itself: does
 * this exemption correspond to an operation the document actually contains? `matches` is applied
 * both to real request paths, by this module's own hook, and — in `api.ts`'s `transform` wrapper
 * — to OpenAPI path *templates*. Every current entry is a literal path, so the two coincide; a
 * future exempt route carrying a path parameter must write its entry to match `/v1/x/:id`, not a
 * concrete id, or the template comparison silently stops matching.
 *
 * Nothing at runtime reads `published`: `api.ts`'s `transform` clears `security` from whatever
 * {@link isPublicRoute} matches, and that function looks only at `method`/`matches`. Its one reader
 * is `openapi-security.integration.test.ts`, which uses it to assert both directions — every
 * published exemption appears in the document with `security: []`, and every unpublished one appears
 * nowhere in it. So the field does not *cause* the document and this array to agree; it is what lets
 * a test prove they do, and a hidden-but-exempt route previously passed every check in that file
 * (FR-012).
 *
 * Being required rather than defaulted is the point: a new entry cannot be added without stating
 * whether the document contains the operation, which is the fact the assertion needs.
 */
interface PublicRoute {
  readonly method: string;
  readonly matches: (path: string) => boolean;
  readonly published: boolean;
}

/**
 * Routes this hook must never gate (contracts/rest-api.md, root spec.md §6.1, D25): each either
 * authenticates itself another way or is public by decision. Deliberately a named list of exact
 * checks, not a regex — widening it is meant to be a reviewable, one-line diff, and the `/docs`
 * check is anchored to the whole `/docs` path segment so it can never accidentally widen to match
 * a route under `/v1` that happens to start with the same characters.
 *
 * `GET /healthz` and `GET /readyz` are the only two entries the OpenAPI document contains as
 * operations, so they are the only two marked `published`; the other four are registered with
 * `schema: { hide: true }` or served entirely outside `fastify-type-provider-zod` (the `/docs`
 * assets), so no `transform` call ever sees them (see `api.ts`'s `registerDocs`).
 */
export const PUBLIC_ROUTES: readonly PublicRoute[] = [
  { method: 'GET', matches: (path) => path === '/healthz', published: true },
  { method: 'GET', matches: (path) => path === '/readyz', published: true },
  { method: 'GET', matches: (path) => path === '/openapi.json', published: false },
  // Swagger UI serves several asset paths beneath /docs (the page itself, /docs/json, /docs/static/*).
  {
    method: 'GET',
    matches: (path) => path === '/docs' || path.startsWith('/docs/'),
    published: false,
  },
  { method: 'GET', matches: (path) => path === '/webhooks/meta', published: false },
  { method: 'POST', matches: (path) => path === '/webhooks/meta', published: false },
];

export function isPublicRoute(method: string, path: string): boolean {
  return PUBLIC_ROUTES.some((route) => route.method === method && route.matches(path));
}

/**
 * Whether *every* method a route answers is exempt — what the OpenAPI `transform` must ask.
 *
 * `@fastify/swagger` calls `transform` once per route, not once per operation, so clearing
 * `security` there clears it for every method that route declares. Asking about one method (the
 * first, say) would publish a route whose `GET` is exempt and whose `POST` is not as
 * unauthenticated on both, contradicting the `onRequest` hook, which decides per method. An empty
 * method list is not exempt: there is no method to have checked.
 *
 * Args:
 *   method: The route's `method`, one string or the array Fastify allows.
 *   path: The request path, or the OpenAPI path template for a published operation.
 *
 * Returns:
 *   Whether the auth hook exempts every method named.
 */
export function isFullyPublicRoute(method: string | readonly string[], path: string): boolean {
  const methods = typeof method === 'string' ? [method] : method;
  return methods.length > 0 && methods.every((one) => isPublicRoute(one, path));
}

/** `request.url` includes the query string; only the path is checked against {@link PUBLIC_ROUTES}. */
function pathOf(request: FastifyRequest): string {
  return request.url.split('?')[0] ?? request.url;
}

/**
 * Registers an `onRequest` hook that authenticates every request on `app` against `apiKeys`,
 * except {@link PUBLIC_ROUTES}.
 *
 * Called directly on the root `FastifyInstance` (not via `app.register`) so the `workspaceId`,
 * `apiKeyId` and `rateLimitPerMin` decorators and the hook apply to every route, including ones
 * registered as siblings rather than children — Fastify's plugin encapsulation would otherwise
 * hide them.
 *
 * `app`'s `Logger` type parameter is generic rather than the default `FastifyBaseLogger`: the api
 * role builds its instance with `.withTypeProvider<ZodTypeProvider>()` over a pino logger, which
 * narrows that generic away from the default and would otherwise make this function's declared
 * parameter type reject the very instance it is meant to be called on.
 */
export function registerApiKeyAuth<Logger extends FastifyBaseLogger = FastifyBaseLogger>(
  app: FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse, Logger>,
  apiKeys: ApiKeys,
): void {
  // The placeholder every request starts with; the pre-handler below replaces it with the key's
  // real workspace before any route runs.
  app.decorateRequest('workspaceId', asWorkspaceId(''));
  app.decorateRequest('apiKeyId', '');
  app.decorateRequest('rateLimitPerMin', null);

  app.addHook('onRequest', async (request: FastifyRequest) => {
    if (isPublicRoute(request.method, pathOf(request))) {
      return;
    }

    const headerValue = readHeader(request);
    const match = headerValue === undefined ? null : API_KEY_PATTERN.exec(headerValue);
    if (match === null) {
      throw unauthorized();
    }

    const [, prefix, secret] = match;
    if (prefix === undefined || secret === undefined) {
      throw unauthorized();
    }

    const result = await apiKeys.findByPrefix(prefix);
    const record = result.found ? result.value : undefined;

    // Run the same comparison whether or not a record was found, so "no such prefix" and "wrong
    // secret for a real prefix" take the same time — see DUMMY_KEY_HASH.
    const verified = verifySecret(secret, record?.keyHash ?? DUMMY_KEY_HASH);
    if (record === undefined || record.revokedAt !== null || !verified) {
      throw unauthorized();
    }

    request.workspaceId = record.workspaceId;
    request.apiKeyId = record.id;
    request.rateLimitPerMin = record.rateLimitPerMin;
  });
}
