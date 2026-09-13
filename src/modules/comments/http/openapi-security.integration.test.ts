// oxlint-disable max-dependencies -- this harness wires the same stack `api.integration.test.ts`
// does (config, both composition roots' ports, the publish queue) plus its own live-route
// collector — see the same justification on that file and the other integration tests in this
// module.

/**
 * The published OpenAPI document declares the `blotato-api-key` scheme the `onRequest` auth hook
 * already enforces, and only the routes {@link PUBLIC_ROUTES} marks `published` clear it (T033,
 * R-09, D31). The document and the enforced exempt list must be **one** list (FR-012): every
 * expectation here is computed from `PUBLIC_ROUTES` itself, never re-typed, and the "every route
 * is documented" sweep is computed from the app's own live route table (collected via an `onRoute`
 * hook added before `app.ready()` runs its boot queue) rather than a hand-written path list — a
 * second track is concurrently removing three read routes from `routes.ts`, and a hand-written
 * list would break the moment that merges.
 */

import type { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApi, type Api } from '#src/app/api.ts';
import { loadConfig } from '#src/app/config.ts';
import { buildContainer } from '#src/app/container.ts';
import { PUBLIC_ROUTES } from '#src/modules/comments/http/auth.ts';
import type { Database } from '#src/shared/db.ts';
import { startTestContainers, type TestContainers } from '#src/shared/testing/containers.ts';
import { TEST_ENV } from '#src/shared/testing/test-env.ts';

/** One (method, Fastify url template) pair, as reported by an `onRoute` hook. */
interface LiveRoute {
  readonly method: string;
  readonly url: string;
  readonly hide: boolean;
}

/** The subset of the generated OpenAPI document's shape this file's assertions need. */
interface OpenApiOperation {
  readonly security?: readonly Record<string, readonly string[]>[];
}

type OpenApiPathItem = Partial<Record<(typeof HTTP_METHOD_KEYS)[number], OpenApiOperation>>;

interface OpenApiDocument {
  readonly components?: {
    readonly securitySchemes?: Record<string, unknown>;
  };
  readonly security?: readonly Record<string, readonly string[]>[];
  readonly paths?: Record<string, OpenApiPathItem | undefined>;
}

interface Harness {
  containers: TestContainers;
  database: Database;
  publishQueue: Queue;
  app: Api;
  document: OpenApiDocument;
  liveRoutes: readonly LiveRoute[];
}

/**
 * Splits a possibly comma-joined or array-valued `onRoute` method field into individual HTTP
 * methods, so `"HEAD,GET"` (how Fastify reports some wildcard routes) and `['GET', 'HEAD']` are
 * both normalized the same way as a plain `'GET'`.
 */
function splitMethods(method: string | string[]): readonly string[] {
  return Array.isArray(method) ? method : method.split(',');
}

/**
 * Registers the collector before `app.ready()` runs Fastify's avvio boot queue, so it sees every
 * route registered through `app.register()` — which is every route in this app (T035's fix to
 * `registerHealthRoutes` in `api.ts` moved `/healthz`/`/readyz` into that category too, so
 * `@fastify/swagger`'s own `onRoute` hook, itself attached only once its `.register()`'d plugin
 * body runs, sees them as well). See `api.ts`'s comment on `registerHealthRoutes` for why a bare
 * `app.get()` call would be invisible to a hook attached this way.
 */
function collectLiveRoutes(app: Api): readonly LiveRoute[] {
  const collected: LiveRoute[] = [];
  app.addHook('onRoute', (route) => {
    const hide = Boolean((route.schema as { hide?: boolean } | undefined)?.hide);
    for (const method of splitMethods(route.method)) {
      collected.push({ method, url: route.url, hide });
    }
  });
  return collected;
}

async function startHarness(): Promise<Harness> {
  const containers = await startTestContainers();
  const config = loadConfig({
    ...TEST_ENV,
    LOG_LEVEL: 'silent',
    DATABASE_URL: containers.databaseUrl,
    REDIS_URL: containers.redisUrl,
  });
  const container = buildContainer({ config });
  const { database, publishQueue } = container;
  const app = buildApi(container);
  const liveRoutes = collectLiveRoutes(app);
  await app.ready();

  const document = app.swagger() as unknown as OpenApiDocument;
  return { containers, database, publishQueue, app, document, liveRoutes };
}

async function stopHarness(harness: Harness): Promise<void> {
  await harness.app.close();
  await harness.publishQueue.close();
  await harness.database.close();
  await harness.containers.stop();
}

/** `/v1/comments/:commentId` (Fastify) → `/v1/comments/{commentId}` (OpenAPI). */
function toOpenApiTemplate(fastifyUrl: string): string {
  return fastifyUrl.replaceAll(/:([A-Za-z0-9_]+)/gu, '{$1}');
}

const HTTP_METHOD_KEYS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const;

function operationsOf(document: OpenApiDocument): Record<string, OpenApiPathItem> {
  const entries = Object.entries(document.paths ?? {}).filter(
    (entry): entry is [string, OpenApiPathItem] => entry[1] !== undefined,
  );
  return Object.fromEntries(entries);
}

/** Every (method, path) pair the document actually carries as an operation. */
function documentedOperationKeys(document: OpenApiDocument): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const [path, item] of Object.entries(operationsOf(document))) {
    for (const method of HTTP_METHOD_KEYS) {
      if (item[method] !== undefined) {
        keys.add(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  return keys;
}

/** Every (method, path) pair whose operation object carries an explicit `security: []`. */
function operationsWithClearedSecurity(document: OpenApiDocument): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const [path, item] of Object.entries(operationsOf(document))) {
    for (const method of HTTP_METHOD_KEYS) {
      const operation = item[method];
      if (operation?.security !== undefined && operation.security.length === 0) {
        keys.add(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  return keys;
}

/**
 * The (method, OpenAPI-template path) pairs `PUBLIC_ROUTES` exempts, restricted to `published`
 * entries and to methods/paths that survive the given predicate — used both to compute the
 * expected `security: []` set (against every path template `PUBLIC_ROUTES.matches` accepts) and to
 * compute what a published exempt route should look like among registered, non-hidden routes.
 */
function publicRouteKeys(
  published: boolean,
  candidateUrls: readonly string[],
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const route of PUBLIC_ROUTES) {
    if (route.published !== published) {
      continue;
    }
    for (const url of candidateUrls) {
      if (route.matches(url)) {
        keys.add(`${route.method} ${url}`);
      }
    }
  }
  return keys;
}

/** Deduplicated (method, OpenAPI-template) keys for every non-`HEAD` route Fastify registered. */
function registeredRouteKeys(liveRoutes: readonly LiveRoute[]): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const route of liveRoutes) {
    if (route.method === 'HEAD') {
      continue;
    }
    keys.add(`${route.method} ${toOpenApiTemplate(route.url)}`);
  }
  return keys;
}

/** Registered, non-hidden route keys that are not an unpublished `PUBLIC_ROUTES` exemption. */
function expectedDocumentedKeys(liveRoutes: readonly LiveRoute[]): ReadonlySet<string> {
  const visible = liveRoutes.filter((route) => route.method !== 'HEAD' && !route.hide);
  const templates = visible.map((route) => toOpenApiTemplate(route.url));
  const unpublishedExempt = publicRouteKeys(false, templates);

  const keys = new Set<string>();
  for (const route of visible) {
    const key = `${route.method} ${toOpenApiTemplate(route.url)}`;
    if (!unpublishedExempt.has(key)) {
      keys.add(key);
    }
  }
  return keys;
}

function registerSchemeTests(getHarness: () => Harness): void {
  describe('the apiKey scheme', () => {
    it('declares the blotato-api-key scheme the auth hook enforces', () => {
      const { document } = getHarness();
      expect(document.components?.securitySchemes?.['apiKey']).toEqual({
        type: 'apiKey',
        name: 'blotato-api-key',
        in: 'header',
      });
    });

    it('requires the scheme by default, globally', () => {
      expect(getHarness().document.security).toEqual([{ apiKey: [] }]);
    });
  });
}

function registerExemptionTests(getHarness: () => Harness): void {
  describe('PUBLIC_ROUTES exemptions', () => {
    it('clears security on exactly the published entries, no more and no fewer', () => {
      const { document } = getHarness();
      const documentPaths = Object.keys(operationsOf(document));
      const expected = publicRouteKeys(true, documentPaths);
      const actual = operationsWithClearedSecurity(document);

      expect(actual).toEqual(expected);
      // Sanity: the expectation is not vacuously empty (a bug that would make the equality above
      // meaningless) — GET /healthz and GET /readyz must both be in it.
      expect(expected.size).toBeGreaterThan(0);
    });

    it('publishes no operation for any unpublished entry', () => {
      const { document } = getHarness();
      const documentPaths = Object.keys(operationsOf(document));
      const unpublished = publicRouteKeys(false, documentPaths);

      expect(unpublished.size).toBe(0);
    });
  });
}

function registerRouteCoverageTests(getHarness: () => Harness): void {
  describe('route coverage', () => {
    it('documents exactly the registered, non-hidden, published-or-not-exempt routes', () => {
      const { document, liveRoutes } = getHarness();
      const expected = expectedDocumentedKeys(liveRoutes);
      const actual = documentedOperationKeys(document);

      expect(actual).toEqual(expected);
    });

    it('documents every registered route under the same address it is registered at', () => {
      const { document, liveRoutes } = getHarness();
      const registered = registeredRouteKeys(liveRoutes);
      const documented = documentedOperationKeys(document);

      for (const key of documented) {
        expect(registered.has(key)).toBe(true);
      }
    });

    it.each([
      'GET /v1/comments/{commentId}',
      'POST /v1/posts/{postId}/comments',
      'POST /v1/comments/{commentId}/replies',
      'POST /v1/posts/{postId}/comments/sync',
      'GET /v1/platforms',
    ])('keeps %s documented at its contract address', (key) => {
      expect(documentedOperationKeys(getHarness().document).has(key)).toBe(true);
    });
  });
}

describe('published OpenAPI security document (D31)', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness();
  });

  afterAll(async () => {
    await stopHarness(harness);
  });

  registerSchemeTests(() => harness);
  registerExemptionTests(() => harness);
  registerRouteCoverageTests(() => harness);
});
