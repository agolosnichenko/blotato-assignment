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
import { ApiError } from '#src/shared/errors.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** The workspace the authenticated API key belongs to (D20). Set by {@link registerApiKeyAuth}. */
    workspaceId: string;
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

interface PublicRoute {
  readonly method: string;
  readonly matches: (path: string) => boolean;
}

/**
 * Routes this hook must never gate (contracts/rest-api.md, root spec.md §6.1, D25): each either
 * authenticates itself another way or is public by decision. Deliberately a named list of exact
 * checks, not a regex — widening it is meant to be a reviewable, one-line diff, and the `/docs`
 * check is anchored to the whole `/docs` path segment so it can never accidentally widen to match
 * a route under `/v1` that happens to start with the same characters.
 */
const PUBLIC_ROUTES: readonly PublicRoute[] = [
  { method: 'GET', matches: (path) => path === '/healthz' },
  { method: 'GET', matches: (path) => path === '/readyz' },
  { method: 'GET', matches: (path) => path === '/openapi.json' },
  // Swagger UI serves several asset paths beneath /docs (the page itself, /docs/json, /docs/static/*).
  { method: 'GET', matches: (path) => path === '/docs' || path.startsWith('/docs/') },
  { method: 'GET', matches: (path) => path === '/webhooks/meta' },
  { method: 'POST', matches: (path) => path === '/webhooks/meta' },
];

function isPublicRoute(method: string, path: string): boolean {
  return PUBLIC_ROUTES.some((route) => route.method === method && route.matches(path));
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
  app.decorateRequest('workspaceId', '');
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
