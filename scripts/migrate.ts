/* oxlint-disable no-console -- this script's entire purpose is printing migration progress and
   operator-facing status to stdout; every other script/module keeps no-console enabled. */
/**
 * Applies the committed `drizzle/` migrations against `DATABASE_URL` (T111, D24).
 *
 * Bundled to `dist/migrate.mjs` (see `tsdown.config.ts`) and run as Railway's pre-deploy command
 * for the `api` service, before the new release starts serving traffic — so this, not
 * `drizzle-kit migrate`, is what the deployed image runs. `drizzle-kit` is a CLI for *authoring*
 * migrations (`pnpm db:generate`) and stays a devDependency, absent from the production image
 * built by `Dockerfile`; applying already-generated migrations needs only `migrate()` from
 * `drizzle-orm/node-postgres/migrator`, and `drizzle-orm` is already a production dependency. This
 * is the same function `src/shared/testing/containers.ts` calls to set up every integration test,
 * so the deploy path exercises a code path the test suite already runs on every CI run.
 *
 * `migrate()` takes no lock against concurrent execution
 * (github.com/drizzle-team/drizzle-orm/issues/874), so only the `api` service's pre-deploy
 * declares this — see the comment on `api.preDeploy` in `.railway/railway.ts` for why `worker`
 * does not, and how the GitHub Actions deploy job orders the two services to stay safe without one.
 *
 * Usage:
 *   pnpm build && node dist/migrate.mjs
 */

import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../drizzle');

function loadDatabaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url.length === 0) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env and run `docker compose up -d`.',
    );
  }
  return url;
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: loadDatabaseUrl() });
  try {
    console.log(`Applying migrations from ${MIGRATIONS_DIR} ...`);
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
    console.log('Migrations applied.');
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
