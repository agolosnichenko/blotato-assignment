import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import type { Redis } from 'ioredis';
import { loadConfig, type Config } from '#src/app/config.ts';
import { createDatabase, type Database } from '#src/shared/db.ts';
import { createLogger } from '#src/shared/logger.ts';
import { createRedis } from '#src/shared/queue.ts';

export interface ApiDependencies {
  config: Config;
  database: Database;
  redis: Redis;
}

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
 * Builds the HTTP application with its dependencies injected so tests can
 * supply containers or fakes without touching the process environment.
 *
 * The return type is inferred: passing a pino instance narrows Fastify's logger
 * generic, which no longer matches the default `FastifyInstance`.
 */
export function buildApi({ config, database, redis }: ApiDependencies) {
  const app = Fastify({ loggerInstance: createLogger(config, { role: 'api' }) });

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
  const config = loadConfig();
  const database = createDatabase(config);
  const redis = createRedis(config);
  const app = buildApi({ config, database, redis });

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void (async () => {
        app.log.info({ signal }, 'shutting down');
        await app.close();
        await database.close();
        redis.disconnect();
      })();
    });
  }

  await app.listen({ host: config.HOST, port: config.PORT });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
