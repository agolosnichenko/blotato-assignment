/**
 * Writes `openapi.json` from the Zod route schemas `buildApi()` registers (T107, D18, R-03).
 *
 * One Zod schema object already serves request validation, static types and the document (T036) —
 * this script does not re-declare any of that. It builds the real app via `buildApi()` so the
 * committed file can only ever describe routes that actually exist, then asks Fastify for the same
 * document `GET /openapi.json` serves (`app.swagger()`, registered in `src/app/api.ts`), and writes
 * it to the repository root. `.github/workflows/ci.yml`'s `openapi-drift` step runs this script and
 * fails the build if the committed file differs — `pnpm generate-openapi` is how a contributor who
 * added or changed a route regenerates it.
 *
 * No request is ever sent through the app — only `app.ready()` is awaited and `app.swagger()` is
 * called directly, the same call the route handler makes — so nothing here needs a live Postgres or
 * Redis (CI runs this step without containers):
 *   - `database` uses the real `pg.Pool`-backed factory: `pg.Pool` opens no socket until a query
 *     runs, and no query ever runs here.
 *   - `redis` is a stand-in implementing only what gets touched during *registration*
 *     (`@fastify/rate-limit`'s own error listener, and `RedisStore`'s `defineCommand` calls) —
 *     verified by reading `@fastify/rate-limit`'s `RedisStore` constructor, which calls nothing
 *     else before a request arrives.
 *   - `publishQueue`/`syncQueue` are stored by route registration for a handler to call later and
 *     are never touched before that, so a plain stand-in satisfies the type without connecting.
 */

// oxlint-disable max-dependencies -- this script's whole job is assembling the same dependency
// graph `src/app/container.ts` builds, minus the two members (`redis`, the queues) it stands in
// for rather than connects; splitting it would hide that wiring behind re-exports, not remove it.

import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Redis } from 'ioredis';
import type { Queue } from 'bullmq';
import type { Config } from '#src/app/config.ts';
import { buildApi, type ApiDependencies } from '#src/app/api.ts';
import { createContactQuota } from '#src/modules/comments/infrastructure/contact-quota.ts';
import { createSyncTargetRepository } from '#src/modules/comments/infrastructure/sync-target-repository.ts';
import { createLocalAccountCredentials } from '#src/modules/platform-core/local/account-credentials.ts';
import { createLocalAccounts } from '#src/modules/platform-core/local/accounts.ts';
import { createLocalApiKeys } from '#src/modules/platform-core/local/api-keys.ts';
import { createLocalPostPublished } from '#src/modules/platform-core/local/post-published.ts';
import { createLocalPosts } from '#src/modules/platform-core/local/posts.ts';
import { createLocalWorkspaces } from '#src/modules/platform-core/local/workspaces.ts';
import type { PlatformCorePorts } from '#src/app/container.ts';
import { createDatabase } from '#src/shared/db.ts';

const OUTPUT_PATH = fileURLToPath(new URL('../openapi.json', import.meta.url));

const execFileAsync = promisify(execFile);

/**
 * A config satisfying every field `envSchema` requires, built in-process rather than read from
 * `.env` — this script runs in CI with no environment configured and must not depend on one: the
 * document's content comes entirely from route schemas, never from a config value.
 */
function buildGeneratorConfig(): Config {
  return {
    NODE_ENV: 'development',
    HOST: '0.0.0.0',
    PORT: 3000,
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgres://generate-openapi:unused@127.0.0.1:5432/unused',
    REDIS_URL: 'redis://127.0.0.1:6379',
    CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
    CREDENTIALS_KEY_VERSION: 1,
    META_APP_SECRET: 'unused',
    META_APP_SECRET_INSTAGRAM: 'unused',
    META_WEBHOOK_VERIFY_TOKEN: 'unused',
    META_GRAPH_API_VERSION: 'v21.0',
    BLUESKY_THREAD_DEPTH: 10,
    RETENTION_DAYS: 45,
    SYNC_INTERVALS_BLUESKY_UNDER_24H_MINUTES: 5,
    SYNC_INTERVALS_BLUESKY_1_TO_7_DAYS_MINUTES: 60,
    SYNC_INTERVALS_BLUESKY_7_DAYS_TO_RETENTION_MINUTES: 1440,
    SYNC_INTERVALS_META_UNDER_24H_MINUTES: 30,
    SYNC_INTERVALS_META_1_TO_7_DAYS_MINUTES: 360,
    SYNC_INTERVALS_META_7_DAYS_TO_RETENTION_MINUTES: 1440,
    SYNC_MANUAL_COOLDOWN_SECONDS: 60,
    RATE_LIMIT_READS_PER_MIN: 30,
    RATE_LIMIT_WRITES_PER_MIN: 5,
  };
}

/**
 * A Redis stand-in carrying only the two members registration touches (see module docstring) —
 * never a real connection, so this script needs no Redis instance to run.
 */
function buildGeneratorRedis(): Redis {
  const redis = {
    on: () => redis,
    defineCommand: () => {},
  };
  return redis as unknown as Redis;
}

/** A BullMQ queue stand-in: route registration stores it for a handler to call later, and no
 * handler ever runs here, so no member of it is ever invoked. */
function buildGeneratorQueue(): Queue {
  return {} as unknown as Queue;
}

function buildGeneratorPorts(
  database: ApiDependencies['database'],
  config: Config,
): PlatformCorePorts {
  const keyMaterial = { key: Buffer.alloc(32), keyVersion: 1 };
  const syncTargetRepository = createSyncTargetRepository(database.drizzle, config);
  return {
    workspaces: createLocalWorkspaces(database.drizzle),
    apiKeys: createLocalApiKeys(database.drizzle),
    accounts: createLocalAccounts(database.drizzle),
    posts: createLocalPosts(database.drizzle),
    accountCredentials: createLocalAccountCredentials(database.drizzle, keyMaterial),
    postPublished: createLocalPostPublished(database.drizzle, syncTargetRepository),
  };
}

function buildGeneratorDependencies(): ApiDependencies {
  const config = buildGeneratorConfig();
  const database = createDatabase(config);
  const redis = buildGeneratorRedis();
  const ports = buildGeneratorPorts(database, config);
  return {
    config,
    database,
    redis,
    ports,
    contactQuota: createContactQuota(database.drizzle, ports.workspaces),
    publishQueue: buildGeneratorQueue(),
    syncQueue: buildGeneratorQueue(),
  };
}

async function main(): Promise<void> {
  const deps = buildGeneratorDependencies();
  const app = buildApi(deps);
  try {
    await app.ready();
    const document = app.swagger();
    await writeFile(OUTPUT_PATH, `${JSON.stringify(document, null, 2)}\n`);
    // `oxfmt` decides the committed shape (e.g. collapsing short arrays onto one line) — running
    // it here, rather than duplicating its formatting rules, is what keeps this output always
    // `format:check`-clean even if those rules change.
    await execFileAsync('pnpm', ['exec', 'oxfmt', OUTPUT_PATH]);
  } finally {
    await app.close();
    await deps.database.close();
  }
}

await main();
