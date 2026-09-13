/**
 * `POST /webhooks/meta` and `GET /webhooks/meta` (T078, T079, §7.2, §17 S1/S5).
 *
 * Both are on `auth.ts`'s `PUBLIC_ROUTES` allowlist: Meta authenticates the `POST` itself via
 * `X-Hub-Signature-256` and the `GET` handshake via `hub.verify_token`, so the api-key hook must
 * never gate them.
 *
 * The `POST` handler needs the exact bytes Meta signed, not Fastify's re-serializable parsed
 * object — §17 S5 confirmed `X-Hub-Signature-256` is `HMAC-SHA256(secret, <raw body bytes>)`, so a
 * signature check over a re-serialized body would pass on a fixture and reject every real
 * delivery. {@link registerMetaWebhookRoutes} therefore overrides the `application/json` content
 * type parser inside its own plugin scope (`app.register` starts a new Fastify encapsulation
 * context) — every other route keeps Fastify's default parsed-object behaviour.
 *
 * §17 S5 also left the `instagram_login` signing secret as an open configuration question, not a
 * code question: the verifier accepts either `META_APP_SECRET` or `META_APP_SECRET_INSTAGRAM`,
 * which is what makes "the verifier supports both secrets from config" true regardless of which
 * one Meta turns out to use for that variant.
 */

import { createHmac } from 'node:crypto';
import type { Queue } from 'bullmq';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { webhookDeliveries } from '#src/modules/comments/infrastructure/schema.ts';
import { secureCompare } from '#src/shared/crypto.ts';
import type { Database } from '#src/shared/db.ts';
import { JOB_NAMES } from '#src/shared/queues.ts';

const SIGNATURE_HEADER = 'x-hub-signature-256';
const SIGNATURE_PREFIX = 'sha256=';
const WEBHOOK_PATH = '/webhooks/meta';

/** The two secrets §17 S5 requires the verifier to accept, plus the `GET` handshake token. */
export interface MetaWebhookSecrets {
  readonly appSecret: string;
  readonly appSecretInstagram: string;
  readonly verifyToken: string;
}

export interface WebhookRoutesDeps {
  readonly database: Database;
  readonly webhookQueue: Queue;
  readonly secrets: MetaWebhookSecrets;
  readonly logger: Logger;
}

function hmacHex(secret: string, body: Buffer): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Verifies `body` against `header` under either configured secret.
 *
 * `secureCompare` reduces both sides to a fixed-length digest before calling
 * `timingSafeEqual`, so a malformed or truncated header — which would make the raw hex strings
 * different lengths — comes back `false` rather than throwing (crypto.ts's own doc comment on
 * why the digest step precedes the compare).
 */
export function verifySignature(
  body: Buffer,
  header: string | undefined,
  secrets: MetaWebhookSecrets,
): boolean {
  if (header === undefined || !header.startsWith(SIGNATURE_PREFIX)) {
    return false;
  }
  const provided = header.slice(SIGNATURE_PREFIX.length);
  return (
    secureCompare(hmacHex(secrets.appSecret, body), provided) ||
    secureCompare(hmacHex(secrets.appSecretInstagram, body), provided)
  );
}

function readSignatureHeader(request: FastifyRequest): string | undefined {
  const header = request.headers[SIGNATURE_HEADER];
  return Array.isArray(header) ? header[0] : header;
}

const SIGNATURE_PREVIEW_LENGTH = 8;

/**
 * The first {@link SIGNATURE_PREVIEW_LENGTH} characters of the signature's hex digest (never the
 * full signature, never the body) — enough to correlate a logged warning with a specific Meta
 * delivery without logging anything that would let a reader forge or replay it.
 */
function signaturePreview(header: string | undefined): string {
  if (header === undefined) {
    return '';
  }
  const digest = header.startsWith(SIGNATURE_PREFIX)
    ? header.slice(SIGNATURE_PREFIX.length)
    : header;
  return digest.slice(0, SIGNATURE_PREVIEW_LENGTH);
}

/**
 * Overrides Fastify's default `application/json` parser for this plugin's own encapsulation
 * scope only, handing the handler the untouched raw bytes instead of a parsed object.
 */
function registerRawBodyParser(app: Parameters<FastifyPluginAsyncZod>[0]): void {
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });
}

/**
 * Parses `raw` as JSON, or returns `null` after logging a warning that carries only the byte
 * length and a short {@link signaturePreview} — never the body and never the full signature.
 *
 * A body that fails to parse despite a valid signature will never parse on a retry either, so
 * this is reported as a `400` (see {@link handlePost}) rather than the `500` an uncaught
 * `JSON.parse` throw would produce: Meta retries non-`200` deliveries for up to 36h and can
 * eventually disable the subscription over it, which is the right cost for a transient failure
 * and pure waste for a payload that can never succeed.
 */
function parseVerifiedBody(
  raw: Buffer,
  signatureHeader: string | undefined,
  logger: Logger,
): Record<string, unknown> | null {
  try {
    return JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
  } catch {
    logger.warn(
      { byteLength: raw.length, signaturePreview: signaturePreview(signatureHeader) },
      'webhook-routes: signature-valid body failed to parse as JSON',
    );
    return null;
  }
}

/**
 * `POST /webhooks/meta` (T078). An invalid signature answers `401` with nothing stored — the
 * signature is checked, and only on success is the body parsed, stored and enqueued (§17 S5: the
 * parser in {@link registerRawBodyParser} is what keeps "parse after verifying" true). A body
 * that parses as something other than JSON despite a valid signature answers `400`, also with
 * nothing stored — see {@link parseVerifiedBody}.
 */
async function handlePost(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: WebhookRoutesDeps,
): Promise<void> {
  const raw = request.body as Buffer;
  const signatureHeader = readSignatureHeader(request);
  if (!verifySignature(raw, signatureHeader, deps.secrets)) {
    await reply.code(401).send();
    return;
  }

  const payload = parseVerifiedBody(raw, signatureHeader, deps.logger);
  if (payload === null) {
    await reply.code(400).send();
    return;
  }

  const [inserted] = await deps.database.drizzle
    .insert(webhookDeliveries)
    .values({ provider: 'meta', payload })
    .returning({ id: webhookDeliveries.id });
  if (inserted === undefined) {
    throw new Error('webhook-routes: insert into webhook_deliveries returned no row');
  }

  await deps.webhookQueue.add(
    JOB_NAMES.processDelivery,
    { deliveryId: inserted.id },
    { jobId: inserted.id },
  );
  await reply.code(200).send();
}

function stringParam(query: unknown, key: string): string | undefined {
  if (typeof query !== 'object' || query === null) {
    return undefined;
  }
  const value = (query as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * `GET /webhooks/meta` (T079). The verify token is checked *before* the challenge is ever read
 * back — echoing `hub.challenge` unconditionally would let anyone confirm a subscription against
 * this endpoint, so a wrong or missing token answers `403` echoing nothing.
 */
async function handleGet(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: WebhookRoutesDeps,
): Promise<void> {
  const token = stringParam(request.query, 'hub.verify_token');
  if (token === undefined || !secureCompare(token, deps.secrets.verifyToken)) {
    await reply.code(403).send();
    return;
  }

  const challenge = stringParam(request.query, 'hub.challenge') ?? '';
  await reply.code(200).send(challenge);
}

/**
 * Builds the plugin `src/app/api.ts` registers for the Meta webhook intake.
 *
 * Args:
 *   deps: The database (to insert `webhook_deliveries`), the `webhook-process` queue handle, and
 *     the configured signing/verify secrets.
 *
 * Returns:
 *   A Fastify plugin, meant to be passed to `app.register(...)`.
 */
export function registerMetaWebhookRoutes(deps: WebhookRoutesDeps): FastifyPluginAsyncZod {
  return (app) => {
    registerRawBodyParser(app);
    app.post(WEBHOOK_PATH, { schema: { hide: true } }, (request, reply) =>
      handlePost(request, reply, deps),
    );
    app.get(WEBHOOK_PATH, { schema: { hide: true } }, (request, reply) =>
      handleGet(request, reply, deps),
    );
    return Promise.resolve();
  };
}
