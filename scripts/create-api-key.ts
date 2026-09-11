/* oxlint-disable no-console -- this script's entire purpose is printing the minted key and
   operator-facing status to stdout; every other script/module keeps no-console enabled. */
/**
 * Mints an API key for an existing workspace (T038, D25, §10).
 *
 * `api_keys` is a read-only projection of another service's data everywhere else in this
 * codebase (D8, D29, Principle II) — nothing under `src/` may write to it. This script is one
 * of the two declared exceptions (the other is `scripts/seed-account.ts`): it stands in for the
 * service that would own these rows in the real platform, so writing here is a stated exception,
 * not a precedent for writing to platform-core tables elsewhere.
 *
 * The full key (`blt_<prefix>_<secret>`) exists only for the life of this process. The database
 * stores `prefix` and `sha256(secret)` only (D25), so the key cannot be recovered afterwards —
 * this script prints it to stdout exactly once and writes it nowhere else (no file, no log).
 *
 * Usage:
 *   pnpm create-api-key --workspace-id <uuid> [--name <name>] [--rate-limit-per-min <n>]
 *
 * Re-running mints a fresh, independent key (a new random prefix and secret each time) rather
 * than refusing or reusing anything — a workspace legitimately holding more than one API key is
 * the normal case, not a duplicate to guard against.
 */

import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { apiKeys, workspaces } from '#src/modules/platform-core/schema.ts';
import { hashSecret } from '#src/shared/crypto.ts';
import { generateId } from '#src/shared/ids.ts';

const SECRET_ENTROPY_BYTES = 32;
const PREFIX_BYTES = 6;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

interface CliArgs {
  readonly workspaceId: string;
  readonly name: string;
  readonly rateLimitPerMin: number | null;
}

function parseCliArgs(argv: string[]): CliArgs {
  const usage =
    'Usage: pnpm create-api-key --workspace-id <uuid> [--name <name>] [--rate-limit-per-min <n>]';

  const { values } = parseArgs({
    args: argv,
    options: {
      'workspace-id': { type: 'string' },
      name: { type: 'string', default: 'default' },
      'rate-limit-per-min': { type: 'string' },
    },
  });

  const workspaceId = values['workspace-id'];
  if (workspaceId === undefined) {
    throw new Error(`--workspace-id is required.\n${usage}`);
  }
  if (!UUID_PATTERN.test(workspaceId)) {
    throw new Error(`--workspace-id must be a UUID, got: ${workspaceId}`);
  }

  let rateLimitPerMin: number | null = null;
  const rateLimitPerMinRaw = values['rate-limit-per-min'];
  if (rateLimitPerMinRaw !== undefined) {
    rateLimitPerMin = Number(rateLimitPerMinRaw);
    if (!Number.isInteger(rateLimitPerMin) || rateLimitPerMin <= 0) {
      throw new Error(
        `--rate-limit-per-min must be a positive integer, got: ${rateLimitPerMinRaw}`,
      );
    }
  }

  return { workspaceId, name: values.name, rateLimitPerMin };
}

function loadDatabaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url.length === 0) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env and run `docker compose up -d`.',
    );
  }
  return url;
}

/**
 * Generates the key material.
 *
 * The prefix is hex, never base64url: `auth.ts`'s `blt_<prefix>_<secret>` parser splits on the
 * first `_`, so the prefix itself must never contain one. The secret carries the required ≥32
 * bytes of entropy (D25) and may safely contain `_` — it is everything after that first split.
 */
function generateKeyMaterial(): { prefix: string; secret: string; fullKey: string } {
  const prefix = randomBytes(PREFIX_BYTES).toString('hex');
  const secret = randomBytes(SECRET_ENTROPY_BYTES).toString('base64url');
  return { prefix, secret, fullKey: `blt_${prefix}_${secret}` };
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const pool = new Pool({ connectionString: loadDatabaseUrl() });
  const db = drizzle(pool);

  try {
    const [workspace] = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, args.workspaceId))
      .limit(1);
    if (workspace === undefined) {
      throw new Error(
        `No workspace with id ${args.workspaceId}. Create one (e.g. via \`pnpm seed:account\`) ` +
          'before minting a key for it.',
      );
    }

    const { prefix, secret, fullKey } = generateKeyMaterial();
    await db.insert(apiKeys).values({
      id: generateId(),
      workspaceId: args.workspaceId,
      prefix,
      keyHash: hashSecret(secret),
      name: args.name,
      rateLimitPerMin: args.rateLimitPerMin,
      revokedAt: null,
      createdAt: new Date(),
    });

    console.log(`Created API key "${args.name}" for workspace ${args.workspaceId}.`);
    console.log('This is shown once and cannot be recovered from the database — save it now:');
    console.log('');
    console.log(fullKey);
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
