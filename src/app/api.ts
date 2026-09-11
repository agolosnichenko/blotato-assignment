// oxlint-disable max-dependencies -- this is the HTTP composition root: its job is registering
// every cross-cutting plugin (auth, rate limiting, error mapping, docs) a route module will
// inherit, so a low fan-in here would mean one of those is being wired somewhere else instead.

import { pathToFileURL } from 'node:url';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { buildContainer, type Container } from '#src/app/container.ts';
import { registerApiKeyAuth } from '#src/modules/comments/http/auth.ts';
import { registerCommentReadRoutes } from '#src/modules/comments/http/routes.ts';
import { createCommentRepository } from '#src/modules/comments/infrastructure/comment-repository.ts';
import { createLocalApiKeys } from '#src/modules/platform-core/local/api-keys.ts';
import { createLocalPosts } from '#src/modules/platform-core/local/posts.ts';
import { ApiError, toProblemDetails, type ProblemDetails } from '#src/shared/errors.ts';
import { createLogger } from '#src/shared/logger.ts';

/** The subset of {@link Container} this app needs — same three fields the api role always builds. */
export type ApiDependencies = Pick<Container, 'config' | 'database' | 'redis'>;

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
 * Registers `@fastify/swagger` + `@fastify/swagger-ui` at `/docs`, driven by the Zod schemas
 * routes declare via `ZodTypeProvider` (T036, R-03) — one schema object serves request
 * validation, static types and this document. `/openapi.json` is a plain route rather than
 * swagger-ui's own `/docs/json`, to match the path spec.md §6.1 documents.
 */
function registerDocs(app: Api): void {
  // `.register()` queues the plugin for Fastify's own boot sequence (resolved by `.ready()`/
  // `.listen()`), so it is not awaited here — the route below only calls `app.swagger()` inside a
  // handler, by which point boot has already completed.
  app.register(fastifySwagger, {
    openapi: {
      info: { title: 'Blotato Comments API', version: '0.1.0' },
    },
    transform: jsonSchemaTransform,
  });
  app.register(fastifySwaggerUi, { routePrefix: '/docs' });
  app.get('/openapi.json', { schema: { hide: true } }, () => app.swagger());
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
 * Builds the HTTP application with its dependencies injected so tests can
 * supply containers or fakes without touching the process environment.
 *
 * The return type is inferred: passing a pino instance narrows Fastify's logger
 * generic, which no longer matches the default `FastifyInstance`.
 */
export function buildApi({ config, database, redis }: ApiDependencies) {
  const app = Fastify({
    loggerInstance: createLogger(config, { role: 'api' }),
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  registerErrorHandler(app);
  registerDocs(app);

  // Built directly from `database` (not `container.ports.apiKeys`) so `ApiDependencies` stays the
  // same three fields `src/app/api.integration.test.ts` already constructs — the api role needs
  // only this one port, not the whole `PlatformCorePorts` bag `container.ts` builds for `worker.ts`.
  registerApiKeyAuth(app, createLocalApiKeys(database.drizzle));
  registerRateLimit(app, config, redis);

  app.register(
    registerCommentReadRoutes({
      repository: createCommentRepository(database.drizzle),
      posts: createLocalPosts(database.drizzle),
    }),
  );

  app.get('/healthz', () => ({ status: 'ok' }));

  app.get('/readyz', async (_request, reply) => {
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

  return app;
}

export type Api = ReturnType<typeof buildApi>;

async function main(): Promise<void> {
  const container = buildContainer();
  const app = buildApi({
    config: container.config,
    database: container.database,
    redis: container.redis,
  });

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void (async () => {
        app.log.info({ signal }, 'shutting down');
        await app.close();
        await container.close();
      })();
    });
  }

  await app.listen({ host: container.config.HOST, port: container.config.PORT });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
