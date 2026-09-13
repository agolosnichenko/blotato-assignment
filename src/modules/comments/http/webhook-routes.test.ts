/**
 * Unit tests for the Meta webhook signature check (T078, §17 S5).
 *
 * Signs the committed S1 fixture's exact bytes — not a hand-written payload — since the whole
 * point of verifying over raw bytes is that re-serialization changes them; a fixture invented for
 * the test would not exercise that.
 */

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Queue } from 'bullmq';
import Fastify from 'fastify';
import type { Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  registerMetaWebhookRoutes,
  verifySignature,
  type MetaWebhookSecrets,
} from '#src/modules/comments/http/webhook-routes.ts';
import type { Database } from '#src/shared/db.ts';

const FIXTURE_BYTES = readFileSync(
  new URL('../../../platforms/meta/__fixtures__/s1-page-feed-test-delivery.json', import.meta.url),
);

const SECRETS: MetaWebhookSecrets = {
  appSecret: 'test-app-secret',
  appSecretInstagram: 'test-app-secret-instagram',
  verifyToken: 'test-verify-token',
};

function sign(secret: string, body: Buffer): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('verifySignature', () => {
  it('accepts a body signed with META_APP_SECRET', () => {
    const header = sign(SECRETS.appSecret, FIXTURE_BYTES);
    expect(verifySignature(FIXTURE_BYTES, header, SECRETS)).toBe(true);
  });

  it('accepts a body signed with META_APP_SECRET_INSTAGRAM', () => {
    const header = sign(SECRETS.appSecretInstagram, FIXTURE_BYTES);
    expect(verifySignature(FIXTURE_BYTES, header, SECRETS)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const header = sign(SECRETS.appSecret, FIXTURE_BYTES);
    const tampered = Buffer.concat([FIXTURE_BYTES, Buffer.from(' ')]);
    expect(verifySignature(tampered, header, SECRETS)).toBe(false);
  });

  it('rejects a truncated signature without throwing', () => {
    const header = sign(SECRETS.appSecret, FIXTURE_BYTES).slice(0, 20);
    expect(() => verifySignature(FIXTURE_BYTES, header, SECRETS)).not.toThrow();
    expect(verifySignature(FIXTURE_BYTES, header, SECRETS)).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(verifySignature(FIXTURE_BYTES, undefined, SECRETS)).toBe(false);
  });

  it('rejects a header with no sha256= prefix', () => {
    const header = createHmac('sha256', SECRETS.appSecret).update(FIXTURE_BYTES).digest('hex');
    expect(verifySignature(FIXTURE_BYTES, header, SECRETS)).toBe(false);
  });

  it('rejects a signature computed under an unconfigured secret', () => {
    const header = sign('some-other-secret', FIXTURE_BYTES);
    expect(verifySignature(FIXTURE_BYTES, header, SECRETS)).toBe(false);
  });
});

/**
 * `database`/`webhookQueue` are test doubles, not a real Postgres/BullMQ connection — the route
 * under test calls exactly these two dependency seams (`database.drizzle.insert(...)` and
 * `webhookQueue.add(...)`), so asserting on the doubles directly proves "nothing was inserted or
 * enqueued" without the vacuous-pass risk a hardcoded queue name would carry: there is no second,
 * differently-named queue for the route to have written to instead.
 */
function buildTestApp(logger: Logger) {
  const insert = vi.fn();
  const add = vi.fn();
  const database = { drizzle: { insert } } as unknown as Database;
  const webhookQueue = { add } as unknown as Queue;

  const app = Fastify();
  app.register(registerMetaWebhookRoutes({ database, webhookQueue, secrets: SECRETS, logger }));

  return { app, insert, add };
}

describe('POST /webhooks/meta', () => {
  let app: ReturnType<typeof buildTestApp>['app'] | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('rejects a signature-valid but unparseable body with 400, storing and enqueueing nothing', async () => {
    // Truncated mid-object: the signature covers exactly these bytes, so it verifies, but the
    // result is not valid JSON.
    const truncated = FIXTURE_BYTES.subarray(0, FIXTURE_BYTES.length - 5);
    const header = sign(SECRETS.appSecret, truncated);
    const warn = vi.fn();
    const built = buildTestApp({ warn } as unknown as Logger);
    app = built.app;

    const response = await built.app.inject({
      method: 'POST',
      url: '/webhooks/meta',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': header },
      payload: truncated,
    });

    expect(response.statusCode).toBe(400);
    expect(built.insert).not.toHaveBeenCalled();
    expect(built.add).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const [logFields] = warn.mock.calls[0] as [Record<string, unknown>];
    expect(logFields['byteLength']).toBe(truncated.length);
    expect(typeof logFields['signaturePreview']).toBe('string');
  });
});
