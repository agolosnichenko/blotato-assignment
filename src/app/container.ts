/**
 * Composition root (T037).
 *
 * Both runtime roles — `api` (src/app/api.ts) and `worker` (src/app/worker.ts) — build the same
 * dependency graph from this one place and differ only in what they *start*: the api role serves
 * HTTP, the worker role runs BullMQ workers and repeatable jobs. Keeping the graph in one function
 * is what makes "adding a platform never touches the schema or the API" (spec.md §4.3) mechanical
 * to check — there is exactly one place a new port implementation or adapter gets wired in.
 *
 * Construction here must stay free of side effects beyond opening the Postgres pool and the Redis
 * connection — both already required just to answer `/healthz`/`/readyz` — so a test can build a
 * container against a testcontainer database without pulling in a real BullMQ worker or an HTTP
 * listener.
 */

// oxlint-disable max-dependencies -- the composition root's entire job is wiring together every
// port implementation and shared module the two runtime roles need; a low fan-in here would mean
// something that should be wired centrally is being constructed ad hoc elsewhere instead.

import type { Redis } from 'ioredis';
import { loadConfig, type Config } from '#src/app/config.ts';
import { createLocalAccountCredentials } from '#src/modules/platform-core/local/account-credentials.ts';
import { createLocalAccounts } from '#src/modules/platform-core/local/accounts.ts';
import { createLocalApiKeys } from '#src/modules/platform-core/local/api-keys.ts';
import { createLocalPostPublished } from '#src/modules/platform-core/local/post-published.ts';
import { createLocalPosts } from '#src/modules/platform-core/local/posts.ts';
import { createLocalWorkspaces } from '#src/modules/platform-core/local/workspaces.ts';
import type {
  AccountCredentials,
  Accounts,
  ApiKeys,
  PostPublished,
  Posts,
  Workspaces,
} from '#src/modules/platform-core/ports.ts';
import type { KeyMaterial } from '#src/shared/crypto.ts';
import { createDatabase, type Database } from '#src/shared/db.ts';
import { createRedis } from '#src/shared/queue.ts';

/** The service-boundary ports (D8, D29), backed by the local projection (src/modules/platform-core/local). */
export interface PlatformCorePorts {
  readonly workspaces: Workspaces;
  readonly apiKeys: ApiKeys;
  readonly accounts: Accounts;
  readonly posts: Posts;
  readonly accountCredentials: AccountCredentials;
  readonly postPublished: PostPublished;
}

export interface Container {
  readonly config: Config;
  readonly database: Database;
  readonly redis: Redis;
  readonly ports: PlatformCorePorts;
  /** Closes the Postgres pool and disconnects Redis. Neither role owns these beyond its own lifetime. */
  close(): Promise<void>;
}

export interface BuildContainerOptions {
  /** Overrides `loadConfig()` — tests inject a config pointed at testcontainer URLs. */
  readonly config?: Config;
}

function toKeyMaterial(config: Config): KeyMaterial {
  return {
    key: Buffer.from(config.CREDENTIALS_ENCRYPTION_KEY, 'base64'),
    keyVersion: config.CREDENTIALS_KEY_VERSION,
  };
}

function buildPorts(database: Database, keyMaterial: KeyMaterial): PlatformCorePorts {
  return {
    workspaces: createLocalWorkspaces(database.drizzle),
    apiKeys: createLocalApiKeys(database.drizzle),
    accounts: createLocalAccounts(database.drizzle),
    posts: createLocalPosts(database.drizzle),
    accountCredentials: createLocalAccountCredentials(database.drizzle, keyMaterial),
    postPublished: createLocalPostPublished(database.drizzle),
  };
}

/**
 * Builds the dependency graph shared by both runtime roles.
 *
 * Args:
 *   options: `config` overrides `loadConfig()` — used by tests that point at testcontainer URLs
 *     instead of the process environment.
 *
 * Returns:
 *   The container. Callers are responsible for calling `close()` on shutdown.
 */
export function buildContainer(options: BuildContainerOptions = {}): Container {
  const config = options.config ?? loadConfig();
  const database = createDatabase(config);
  const redis = createRedis(config);
  const ports = buildPorts(database, toKeyMaterial(config));

  return {
    config,
    database,
    redis,
    ports,
    async close() {
      await database.close();
      redis.disconnect();
    },
  };
}
