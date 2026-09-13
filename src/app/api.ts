// oxlint-disable max-dependencies -- this is the HTTP composition root: its job is registering
// every cross-cutting plugin (auth, rate limiting, error mapping, docs) a route module will
// inherit, so a low fan-in here would mean one of those is being wired somewhere else instead.
// oxlint-disable max-lines -- the composition root's scope grows with every route module it
// wires (T090 adds the sync routes' own repository/use-case construction); splitting it would
// hide that wiring behind re-exports rather than remove any of it.

import { pathToFileURL } from 'node:url';
import { onShutdownSignal } from '#src/shared/shutdown.ts';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifySwagger, { type SwaggerTransform } from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { buildContainer, type Container } from '#src/app/container.ts';
import { createRequestSync } from '#src/modules/comments/application/request-sync.ts';
import { isPublicRoute, registerApiKeyAuth } from '#src/modules/comments/http/auth.ts';
import {
  registerCommentReadRoutes,
  registerCommentWriteRoutes,
  registerPlatformRoutes,
  registerSyncRoutes,
} from '#src/modules/comments/http/routes.ts';
import { registerMetaWebhookRoutes } from '#src/modules/comments/http/webhook-routes.ts';
import { createCommentRepository } from '#src/modules/comments/infrastructure/comment-repository.ts';
import { createSyncTargetRepository } from '#src/modules/comments/infrastructure/sync-target-repository.ts';
import type { Database } from '#src/shared/db.ts';
import { ApiError, toProblemDetails, type ProblemDetails } from '#src/shared/errors.ts';
import { createLogger } from '#src/shared/logger.ts';
import { createQueue } from '#src/shared/queue.ts';
import { QUEUE_NAMES } from '#src/shared/queues.ts';

/**
 * The subset of {@link Container} this app needs — `ports`, `contactQuota` and `publishQueue`
 * for the write routes on top of the three fields every role builds. The api role still needs no
 * BullMQ `Worker`/`Redis`-backed sweeper of its own, only the container's already-built ports and
 * the shared `ContactQuota`/queue handle — see `container.ts`'s doc comment on why those two are
 * built once, centrally, rather than a second time here.
 */
export type ApiDependencies = Pick<
  Container,
  'config' | 'database' | 'redis' | 'ports' | 'contactQuota' | 'publishQueue' | 'syncQueue'
>;

type CheckResult = { ok: true } | { ok: false; error: string };

/**
 * A dependency that is down does not necessarily answer with an error: the BullMQ Redis
 * connection is configured to retry forever, so an unbounded probe would hang the endpoint
 * instead of reporting the outage.
 */
const CHECK_TIMEOUT_MS = 2000;

async function runCheck(probe: () => Promise<unknown>): Promise<CheckResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${CHECK_TIMEOUT_MS}ms`)),
      CHECK_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([probe(), timeout]);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The response body for a failure this service never caught more specifically (spec.md §6.3
 * `INTERNAL_ERROR`, added for exactly this case — the one `SyncErrorCode` no caller ever
 * constructs deliberately). `detail` is a fixed string, never the caught error's own message, so
 * an unexpected exception cannot leak internal text (a query, a stack fragment, a file path) into
 * a response body; `requestId` is what a report correlates back to the full error already logged
 * server-side via `request.log.error`.
 */
function internalProblem(request: FastifyRequest): ProblemDetails & { requestId: string } {
  const error = new ApiError('INTERNAL_ERROR', 'An unexpected error occurred.');
  return { ...toProblemDetails(error, request.url), requestId: request.id };
}

/**
 * Turns a Zod request-validation failure (thrown by `validatorCompiler`, T036) into the one
 * `ApiError` §6.3 has for bad input. `error.validation` entries are about the client's own
 * request shape, so — unlike the unexpected-exception path — echoing them back in `detail` is
 * exactly what the client needs to fix the request, not an internal-text leak.
 */
function fromValidationError(error: { validation: readonly { message?: string }[] }): ApiError {
  const detail = error.validation.map((issue) => issue.message ?? 'invalid value').join('; ');
  return new ApiError('VALIDATION_ERROR', detail || 'request failed validation');
}

/**
 * Registers the global error handler (T035, FR-032).
 *
 * Every failure — a thrown `ApiError`, a Zod request-validation failure, a Zod response
 * serialization failure, or anything else — is serialized as `application/problem+json`
 * (spec.md §6). `ApiError` and request validation are safe to describe precisely because both
 * describe a problem with the caller's own request; a response serialization failure is this
 * service's own bug (the handler returned something its declared schema rejects), so it is logged
 * in full but reported to the caller as the same generic {@link internalProblem} as any other
 * unclassified exception — never with the schema or the data that failed to serialize.
 */
function registerErrorHandler(app: Api): void {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof ApiError) {
      const problem = toProblemDetails(error, request.url);
      return reply.code(problem.status).type('application/problem+json').send(problem);
    }

    if (hasZodFastifySchemaValidationErrors(error)) {
      const problem = toProblemDetails(fromValidationError(error), request.url);
      return reply.code(problem.status).type('application/problem+json').send(problem);
    }

    if (isResponseSerializationError(error)) {
      request.log.error({ err: error }, 'response failed schema serialization');
      return reply.code(500).type('application/problem+json').send(internalProblem(request));
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).type('application/problem+json').send(internalProblem(request));
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const problem = toProblemDetails(new ApiError('NOT_FOUND', 'no such route'), request.url);
    return reply.code(problem.status).type('application/problem+json').send(problem);
  });
}

/**
 * Wraps `jsonSchemaTransform` (T036, R-09, D31) to clear `security` on the two operations
 * {@link PUBLIC_ROUTES} exempts from the `onRequest` auth hook and that actually reach this
 * transform — `GET /healthz` and `GET /readyz`. The other four exempt entries never call this
 * function at all: the webhook and `/openapi.json` routes are registered with
 * `schema: { hide: true }`, so `@fastify/swagger` skips them before `transform` runs, and the
 * `/docs` assets are served entirely by `@fastify/swagger-ui`, outside this document.
 *
 * Wraps rather than replaces `jsonSchemaTransform`, so Zod remains the single source of the
 * request/response schemas (R-03 of the 001 plan); reads {@link isPublicRoute} rather than
 * re-checking `PUBLIC_ROUTES` itself, so the exempt list stays the one the auth hook enforces
 * (FR-012) — this function only decides whether to *publish* that exemption, never redefines it.
 */
const transformWithPublicRoutes: SwaggerTransform = (input) => {
  const { schema, url } = jsonSchemaTransform(input);
  const method = Array.isArray(input.route.method) ? input.route.method[0] : input.route.method;
  if (method !== undefined && isPublicRoute(method, url)) {
    return { schema: { ...schema, security: [] }, url };
  }
  return { schema, url };
};

/**
 * Registers `@fastify/swagger` + `@fastify/swagger-ui` at `/docs`, driven by the Zod schemas
 * routes declare via `ZodTypeProvider` (T036, R-03) — one schema object serves request
 * validation, static types and this document.
 *
 * The `apiKey` security scheme (T035, R-09, D31) mirrors what `auth.ts`'s `onRequest` hook
 * already enforces: applied globally (`security: [{ apiKey: [] }]`) with per-operation
 * exemptions, never the inverse — a route added without thought is published as authenticated,
 * the same way the hook itself fails closed for a route added without being exempted.
 *
 * `/openapi.json` itself is registered separately, by {@link registerOpenApiDocRoute} — see that
 * function's doc comment for why it must not be a bare route defined here.
 */
function registerDocs(app: Api): void {
  // `.register()` queues the plugin for Fastify's own boot sequence (resolved by `.ready()`/
  // `.listen()`), so it is not awaited here.
  app.register(fastifySwagger, {
    openapi: {
      info: { title: 'Blotato Comments API', version: '0.1.0' },
      components: {
        securitySchemes: {
          apiKey: { type: 'apiKey', name: 'blotato-api-key', in: 'header' },
        },
      },
      security: [{ apiKey: [] }],
    },
    transform: transformWithPublicRoutes,
  });
  app.register(fastifySwaggerUi, { routePrefix: '/docs' });
}

/**
 * Registers `GET /openapi.json` (spec.md §6.1 — a plain route, not swagger-ui's own `/docs/json`),
 * the same category of fix `registerHealthRoutes` (T035) applied to `/healthz`/`/readyz` (fix
 * round 2): registered through `app.register()`, deferred to avvio's boot queue, rather than as a
 * bare `app.get()` call on `app` directly. A bare call fires synchronously — before `registerDocs`'s
 * own `fastifySwagger` plugin has even started its deferred boot, let alone before
 * `registerRateLimit`'s `onRoute` hook exists — so the route would vanish from every tool that
 * observes routes via `onRoute` (this repository's own OpenAPI-security test harness included,
 * `openapi-security.integration.test.ts`'s `collectLiveRoutes`) while `schema: { hide: true }`
 * still correctly keeps it out of the *published document* either way (`@fastify/swagger` reads
 * `hide` off the final route table when `app.swagger()` is called, not off `onRoute` events, so
 * that guarantee never depended on registration timing).
 *
 * Called last in {@link buildApi}, after {@link registerRateLimit}, so that hook has already
 * finished wiring `onRoute` up by the time this route is defined — same ordering
 * `registerHealthRoutes` relies on, and the same `allowList` coupling: `/openapi.json` is
 * `published: false` in {@link PUBLIC_ROUTES}, so the auth hook never sets `apiKeyId` for it, and
 * `registerRateLimit`'s `allowList: (request) => request.apiKeyId === ''` exempts it from rate
 * limiting the same way it exempts `/healthz`/`/readyz` — see that function's `allowList` line for
 * the other half of this coupling.
 */
function registerOpenApiDocRoute(app: Api): void {
  app.register((instance, _opts, done) => {
    instance.get('/openapi.json', { schema: { hide: true } }, () => instance.swagger());
    done();
  });
}

const READ_METHODS = new Set(['GET', 'HEAD']);

/** Read/write bucket is derived from the HTTP method, not an enumeration of routes — a route list
 * goes stale the moment a route is added; the method never does. */
function isReadRequest(method: string): boolean {
  return READ_METHODS.has(method);
}

/**
 * Registers `@fastify/rate-limit` (T034, R-05, FR-027): two buckets per api key, read and write,
 * keyed on the resolved `apiKeyId` (never IP — `auth.ts`'s decorator is the only source of
 * identity here). `max` is always `min(envDefault, key.rateLimitPerMin)`, computed in one place
 * (not two branches), so a per-key `rate_limit_per_min` can only ever lower the deployment's own
 * `RATE_LIMIT_READS_PER_MIN` / `RATE_LIMIT_WRITES_PER_MIN` budget, never raise it — a `null`
 * column value means no per-key ceiling, so the env default alone applies.
 *
 * Must be registered *after* {@link registerApiKeyAuth} (same root instance, same `onRequest`
 * phase, so hook order is registration order): a request that fails auth never reaches this hook,
 * and one that is on {@link PUBLIC_ROUTES} carries no `apiKeyId` at all, so `allowList` exempts it
 * rather than pooling every public-route hit into one shared, meaningless "empty key" bucket.
 *
 * Redis unavailability must lose no data (FR-033) — a rate limit budget is not data, so this fails
 * *open* (`skipOnError: true`, i.e. requests are allowed through) rather than 500ing every
 * request or 500ing none silently. `redis`'s own `error` events are logged at `warn` so an outage
 * is still visible in the structured logs even though nothing is rejected because of it.
 *
 * `@fastify/rate-limit` attaches itself per-route via an `onRoute` hook fired when a route is
 * *defined*, not a global `onRequest` hook — so a route added with a plain `app.get()`/`app.post()`
 * call before this plugin's own (deferred, avvio-queued) registration has actually run will never
 * be rate-limited. A future route module registered the normal Fastify way, via
 * `app.register(routesPlugin)`, is unaffected: avvio runs registrations in queue order, so by the
 * time that plugin's body executes and defines its routes, this one has already finished wiring
 * `onRoute` up. Verified with a throwaway route module registered the same way T049 and friends
 * will (see the report) — do not "simplify" a future route module to a bare `app.get()` on the
 * shared instance, or it silently loses both rate limiting and this ceiling rule.
 */
function registerRateLimit(app: Api, config: Container['config'], redis: Container['redis']): void {
  redis.on('error', (error: Error) => {
    app.log.warn(
      { err: error },
      'redis error — rate limiting fails open and /readyz will report degraded',
    );
  });

  app.register(fastifyRateLimit, {
    redis,
    skipOnError: true,
    enableDraftSpec: true,
    keyGenerator: (request) =>
      `${isReadRequest(request.method) ? 'read' : 'write'}:${request.apiKeyId}`,
    // `registerHealthRoutes`'s /healthz and /readyz, and `registerOpenApiDocRoute`'s
    // /openapi.json, all rely on this exact predicate to stay unlimited — see those functions'
    // doc comments for the coupling.
    allowList: (request) => request.apiKeyId === '',
    max: (request) => {
      const envDefault = isReadRequest(request.method)
        ? config.RATE_LIMIT_READS_PER_MIN
        : config.RATE_LIMIT_WRITES_PER_MIN;
      return request.rateLimitPerMin === null
        ? envDefault
        : Math.min(envDefault, request.rateLimitPerMin);
    },
    errorResponseBuilder: (_request, context) =>
      new ApiError('RATE_LIMITED', `retry after ${context.after}`),
  });
}

/**
 * Registers the two read routes, the two write routes, the two sync routes and
 * `GET /v1/platforms` (T049, T069, T090, T098).
 */
function registerCommentRoutes(
  app: ReturnType<typeof Fastify>,
  deps: ApiDependencies,
  logger: ReturnType<typeof createLogger>,
): void {
  const repository = createCommentRepository(deps.database.drizzle);
  const syncTargetRepository = createSyncTargetRepository(deps.database.drizzle, deps.config);
  const requestSync = createRequestSync({
    database: deps.database.drizzle,
    posts: deps.ports.posts,
    syncTargetRepository,
    syncQueue: deps.syncQueue,
    manualCooldownSeconds: deps.config.SYNC_MANUAL_COOLDOWN_SECONDS,
  });

  app.register(
    registerCommentReadRoutes({
      repository,
      posts: deps.ports.posts,
      accounts: deps.ports.accounts,
    }),
  );
  app.register(
    registerCommentWriteRoutes({
      database: deps.database,
      repository,
      posts: deps.ports.posts,
      accounts: deps.ports.accounts,
      contactQuota: deps.contactQuota,
      publishQueue: deps.publishQueue,
      logger,
    }),
  );
  app.register(registerSyncRoutes({ requestSync }));
  app.register(registerPlatformRoutes());
}

/**
 * Registers the Meta webhook intake (T078, T079) with its own `webhook-process` queue handle.
 *
 * The queue is built here rather than in `container.ts`: unlike `publishQueue`/`syncQueue`, the
 * api role is the only one producing onto it — the worker role consumes through its own `Worker`,
 * a separate BullMQ object over the same `QUEUE_NAMES.webhookProcess` name and Redis connection
 * (bullmq.md's producer/consumer split), so there is no second role here to share a container
 * singleton with.
 */
function registerWebhookRoutes(
  app: Api,
  deps: ApiDependencies,
  logger: ReturnType<typeof createLogger>,
): void {
  const webhookQueue = createQueue(QUEUE_NAMES.webhookProcess, deps.config, deps.redis);
  app.addHook('onClose', async () => {
    await webhookQueue.close();
  });
  app.register(
    registerMetaWebhookRoutes({
      database: deps.database,
      webhookQueue,
      logger,
      secrets: {
        appSecret: deps.config.META_APP_SECRET,
        appSecretInstagram: deps.config.META_APP_SECRET_INSTAGRAM,
        verifyToken: deps.config.META_WEBHOOK_VERIFY_TOKEN,
      },
    }),
  );
}

/**
 * Registers `GET /healthz` (liveness) and `GET /readyz` (Postgres + Redis, T035).
 *
 * Registered through `app.register()` rather than as bare `app.get()` calls on `app` directly, so
 * that Fastify's avvio queue defers route registration to boot time — same as every other route
 * module here. `@fastify/swagger` (`registerDocs`) attaches its own `onRoute` hook only once its
 * own `.register()`'d plugin body runs; a bare `app.get()` call fires synchronously, immediately,
 * outside avvio's queue, so it would run — and add its route to the router — before that hook
 * exists, silently vanishing from the published document (T035, R-09: `GET /healthz` and
 * `GET /readyz` are meant to be the two operations the exemption actually clears).
 *
 * Side effect: `@fastify/rate-limit`'s `onRoute` hook (`registerRateLimit`, registered earlier)
 * now sees these two routes too, and attaches its `preHandler` to them — before this change they
 * were bare `app.get()` calls that ran before that hook existed, so it never saw them at all.
 * They stay unlimited today only because `registerRateLimit`'s `allowList` exempts any request
 * with `apiKeyId === ''`, which both routes always have ({@link PUBLIC_ROUTES} skips the auth hook
 * before it sets `apiKeyId`). If `allowList`'s predicate ever changes to key on something else,
 * these two liveness/readiness probes could start getting rate-limited with no warning — see the
 * `allowList` line in `registerRateLimit` for the other half of this coupling.
 */
function registerHealthRoutes(app: Api, database: Database, redis: Redis): void {
  app.register((instance, _opts, done) => {
    instance.get('/healthz', () => ({ status: 'ok' }));

    instance.get('/readyz', async (_request, reply) => {
      const [postgres, redisCheck] = await Promise.all([
        runCheck(() => database.ping()),
        runCheck(() => redis.ping()),
      ]);
      const ready = postgres.ok && redisCheck.ok;
      return reply.code(ready ? 200 : 503).send({
        status: ready ? 'ok' : 'degraded',
        checks: { postgres, redis: redisCheck },
      });
    });

    done();
  });
}

/**
 * Builds the HTTP application with its dependencies injected so tests can
 * supply containers or fakes without touching the process environment.
 *
 * The return type is inferred: passing a pino instance narrows Fastify's logger
 * generic, which no longer matches the default `FastifyInstance`.
 */
export function buildApi(deps: ApiDependencies) {
  const logger = createLogger(deps.config, { role: 'api' });
  const app = Fastify({ loggerInstance: logger }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  registerErrorHandler(app);
  registerDocs(app);
  registerApiKeyAuth(app, deps.ports.apiKeys);
  registerRateLimit(app, deps.config, deps.redis);
  registerCommentRoutes(app, deps, logger);
  registerWebhookRoutes(app, deps, logger);
  registerHealthRoutes(app, deps.database, deps.redis);
  registerOpenApiDocRoute(app);

  return app;
}

export type Api = ReturnType<typeof buildApi>;

async function main(): Promise<void> {
  const container = buildContainer();
  const app = buildApi(container);

  onShutdownSignal(async () => {
    await app.close();
    await container.close();
  }, app.log);

  await app.listen({ host: container.config.HOST, port: container.config.PORT });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
