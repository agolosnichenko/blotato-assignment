import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

// Same images and tags as docker-compose.yml, so the test environment matches local development
// and Railway.
const POSTGRES_IMAGE = 'postgres:18.6-alpine';
const REDIS_IMAGE = 'redis:8.10.1-alpine';
const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../../../drizzle');

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
      await Promise.all([postgres.stop(), redis.stop()]);
    },
  };
}
