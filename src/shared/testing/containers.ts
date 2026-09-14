import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client, Pool } from 'pg';

// Same images and tags as docker-compose.yml, so the test environment matches local development
// and Railway.
const POSTGRES_IMAGE = 'postgres:18.6-alpine';
const REDIS_IMAGE = 'redis:8.10.1-alpine';
const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../../../drizzle');
const DISCONNECT_TIMEOUT_MS = 10_000;
const DISCONNECT_POLL_MS = 50;

export interface TestContainers {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  stop(): Promise<void>;
}

/**
 * Confirms the committed `drizzle/` migrations exist before a container is started.
 *
 * An integration test run against an empty schema passes for the wrong reason and hides real
 * failures, so this fails loudly instead (R-01).
 *
 * Raises:
 *   Error: If `drizzle/` is missing or has no `.sql` migration files.
 */
async function assertMigrationsExist(): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(MIGRATIONS_DIR);
  } catch {
    throw new Error(
      `No migrations directory at ${MIGRATIONS_DIR}. Run \`pnpm db:generate\` first — ` +
        'integration tests apply the same committed migrations as the deployed schema.',
    );
  }
  const hasMigration = entries.some((entry) => entry.endsWith('.sql'));
  if (!hasMigration) {
    throw new Error(
      `${MIGRATIONS_DIR} has no .sql migrations. Run \`pnpm db:generate\` first — ` +
        'integration tests apply the same committed migrations as the deployed schema.',
    );
  }
}

/**
 * Waits until Postgres has no client session left besides the one asking.
 *
 * `Pool.end()` resolves once its clients are *asked* to close, not once they have: each client's
 * Terminate may still be in flight. Stopping the container in that window makes Postgres send
 * `57P01 terminating connection due to administrator command` to those sockets, and `pg` emits an
 * ErrorResponse that arrives with no query active as an `'error'` event even on a client that is
 * ending — which surfaces as an uncaught exception that fails the whole run after every test
 * passed. Waiting for the server side to drain closes that window for every caller at once.
 *
 * Raises:
 *   Error: If sessions remain after {@link DISCONNECT_TIMEOUT_MS} — a test left a connection open,
 *     and stopping now would produce the same uncaught error without saying which test caused it.
 */
async function waitForClientsToDisconnect(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const deadline = Date.now() + DISCONNECT_TIMEOUT_MS;
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- polling one server-side count until it drains
      const result = await client.query<{ open: number }>(
        `select count(*)::int as open from pg_stat_activity
         where backend_type = 'client backend' and pid <> pg_backend_pid()`,
      );
      const open = result.rows[0]?.open ?? 0;
      if (open === 0) {
        return;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `${open} Postgres session(s) still open ${DISCONNECT_TIMEOUT_MS}ms after teardown began — ` +
            'end every pool and client the test opened before calling containers.stop()',
        );
      }
      // oxlint-disable-next-line no-await-in-loop -- see above
      await delay(DISCONNECT_POLL_MS);
    }
  } finally {
    await client.end();
  }
}

/**
 * Starts PostgreSQL + Redis testcontainers and applies the committed `drizzle/` migrations.
 *
 * Returns:
 *   Connection URLs for the started containers and a `stop` function to tear them down.
 *
 * Raises:
 *   Error: If the `drizzle/` migrations directory is missing or empty.
 */
export async function startTestContainers(): Promise<TestContainers> {
  await assertMigrationsExist();

  const postgres = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const redis = await new RedisContainer(REDIS_IMAGE).start();

  const databaseUrl = postgres.getConnectionUri();
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await pool.end();
  }

  return {
    databaseUrl,
    redisUrl: redis.getConnectionUrl(),
    async stop() {
      try {
        await waitForClientsToDisconnect(databaseUrl);
      } finally {
        await Promise.all([postgres.stop(), redis.stop()]);
      }
    },
  };
}
