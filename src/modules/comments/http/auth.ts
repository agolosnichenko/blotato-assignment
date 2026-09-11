/**
 * API key authentication plugin (T033, A16, §10).
 *
 * Resolves the `blotato-api-key` header, looks the key up through the `ApiKeys` port (D8, D29 —
 * `api_keys` belongs to another service, so this module never queries it directly), and decorates
 * the request with the `workspaceId` every downstream repository call is scoped by (D20) and the
 * `apiKeyId` the rate limiter (T034) keys its buckets on.
 *
 * The three ways a request can fail — no header, an unrecognized prefix, a revoked key — all throw
 * the same `ApiError` with the same `detail`. Per D20's `404`-not-`403` reasoning, whether a key
 * exists is not something an unauthenticated caller gets to probe, so nothing here may vary the
 * response by which case occurred.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ApiKeys } from '#src/modules/platform-core/ports.ts';
import { hashSecret, secureCompare } from '#src/shared/crypto.ts';
import { ApiError } from '#src/shared/errors.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** The workspace the authenticated API key belongs to (D20). Set by {@link registerApiKeyAuth}. */
    workspaceId: string;
    /** The authenticated API key's id. Set by {@link registerApiKeyAuth}; T034 rate-limits on it. */
    apiKeyId: string;
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
 * Registers an `onRequest` hook that authenticates every request on `app` against `apiKeys`.
 *
 * Called directly on the root `FastifyInstance` (not via `app.register`) so the `workspaceId` and
 * `apiKeyId` decorators and the hook apply to every route, including ones registered as siblings
 * rather than children — Fastify's plugin encapsulation would otherwise hide them.
 */
export function registerApiKeyAuth(app: FastifyInstance, apiKeys: ApiKeys): void {
  app.decorateRequest('workspaceId', '');
  app.decorateRequest('apiKeyId', '');

  app.addHook('onRequest', async (request: FastifyRequest) => {
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
    if (!result.found) {
      throw unauthorized();
    }

    const record = result.value;
    if (record.revokedAt !== null || !verifySecret(secret, record.keyHash)) {
      throw unauthorized();
    }

    request.workspaceId = record.workspaceId;
    request.apiKeyId = record.id;
  });
}
