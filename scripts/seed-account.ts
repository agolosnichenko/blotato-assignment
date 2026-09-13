/* oxlint-disable no-console -- this script's entire purpose is printing the minted key and
   operator-facing status to stdout; every other script/module keeps no-console enabled. */
/**
 * Seeds a demo workspace end to end (T039, §7.3, §10, D25).
 *
 * `workspaces`, `social_accounts`, `posts` and `api_keys` are a read-only projection of another
 * service's data everywhere else in this codebase (D8, D29, Principle II) — nothing under `src/`
 * may write to them. This script is one of the two declared exceptions (the other is
 * `scripts/create-api-key.ts`): it stands in for the services that would own these rows in the
 * real platform (workspaces, accounts, publishing), so writing here is a stated exception, not a
 * precedent for writing to platform-core tables elsewhere.
 *
 * It creates a demo workspace, one connected account per comment-capable platform (Instagram,
 * Facebook, Bluesky) with encrypted placeholder credentials, one API key, and one published post
 * per account — each post registered through the `PostPublished` port rather than inserted
 * directly, because that port (not this script) is what turns a publish event into an active
 * `comment_sync_targets` row (§7.3). That is what the publishing service would do in the real
 * platform; standing in for it is the entire point of this script.
 *
 * No real secret is ever in source (D25): platform tokens, account ids, usernames and post ids
 * are all read from optional `SEED_*` env vars (see {@link DEMO_ACCOUNTS} for the exact names) and
 * fall back to an obviously-fake placeholder / demo value when unset, then the token is encrypted
 * with `CREDENTIALS_ENCRYPTION_KEY` before being written. With no variables set, nothing here is
 * suitable for calling a real platform API (see CLAUDE.md's "Meta constraints" and spikes
 * S1/S2/S5 for why that is out of scope by default); setting the real values turns this into the
 * seed for a live demo.
 *
 * Idempotency: the workspace, its three accounts and their three posts all use fixed demo ids and
 * are inserted with `ON CONFLICT DO NOTHING`, so re-running with the *same* values leaves them
 * untouched and reports "already exists" for each. Re-running with *different* values for a row
 * that already exists is refused, not silently ignored: `ON CONFLICT DO NOTHING` would otherwise
 * report success while the database kept the old row, which is indistinguishable from the seed
 * having worked. Before writing an account or post, this script reads the existing row (if any)
 * and compares the fields it owns; a mismatch stops the run with a `formatConflictMessage` error
 * naming the row, the field, the stored value and the supplied one. Clear the demo workspace and
 * re-run rather than trying to update a row this script does not know how to patch in place — a
 * post in particular is written through the `PostPublished` port, not a raw `posts` insert, so
 * changing `platform_post_id` behind that port's back would strand `comment_sync_targets`, which
 * is unique on `(social_account_id, platform_post_id)`. The API key is the one field with no such
 * check — like `create-api-key.ts`, every run mints a fresh, independent key, because a key's
 * secret cannot be recovered from the database once minted (D25) and a workspace legitimately
 * holding more than one key is normal.
 *
 * Split across three files to stay under the project's per-file line/dependency limits: this file
 * is the CLI entry point (account table, orchestration), `seed-account-checks.ts` holds the pure,
 * unit-tested decision functions (override resolution, conflict detection), and
 * `seed-account-writes.ts` holds the actual database calls.
 *
 * Usage:
 *   pnpm seed:account
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { loadConfig } from '#src/app/config.ts';
import { createSyncTargetRepository } from '#src/modules/comments/infrastructure/sync-target-repository.ts';
import { createLocalPostPublished } from '#src/modules/platform-core/local/post-published.ts';
import {
  formatAccountStatus,
  resolveAccountValues,
  type DemoAccount,
} from './seed-account-checks.ts';
import {
  checkAccountForConflicts,
  seedAccount,
  seedApiKey,
  seedPost,
  seedWorkspace,
  type Db,
} from './seed-account-writes.ts';
import { asWorkspaceId } from '#src/shared/ids.ts';
import { closeQuietly, reportFatal } from './script-failure.ts';

const DEMO_WORKSPACE_ID = asWorkspaceId('11111111-1111-4111-8111-111111111111');

// Two Meta auth variants (D28) are seeded deliberately, not just one: `instagram_login` and
// `facebook_login` exercise the two different `AccountCredentials`/Graph-client code paths the
// registry supports (§8.2) rather than leaving one of them untested by every local run.
const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  {
    id: '22222222-2222-4222-8222-222222222221',
    platform: 'instagram',
    authVariant: 'instagram_login',
    authVariantEnvVar: 'SEED_INSTAGRAM_AUTH_VARIANT',
    accountIdEnvVar: 'SEED_INSTAGRAM_ACCOUNT_ID',
    defaultAccountId: 'demo-instagram-account',
    usernameEnvVar: 'SEED_INSTAGRAM_USERNAME',
    defaultUsername: 'demo.instagram',
    tokenEnvVar: 'SEED_INSTAGRAM_TOKEN',
    placeholderToken: 'demo-placeholder-token-instagram',
    postId: '33333333-3333-4333-8333-333333333331',
    platformPostIdEnvVar: 'SEED_INSTAGRAM_POST_ID',
    defaultPlatformPostId: '17895600000000001',
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    platform: 'facebook',
    authVariant: 'facebook_login',
    authVariantEnvVar: 'SEED_FACEBOOK_AUTH_VARIANT',
    accountIdEnvVar: 'SEED_FACEBOOK_ACCOUNT_ID',
    defaultAccountId: 'demo-facebook-account',
    usernameEnvVar: 'SEED_FACEBOOK_USERNAME',
    defaultUsername: 'demo.facebook',
    tokenEnvVar: 'SEED_FACEBOOK_TOKEN',
    placeholderToken: 'demo-placeholder-token-facebook',
    postId: '33333333-3333-4333-8333-333333333332',
    platformPostIdEnvVar: 'SEED_FACEBOOK_POST_ID',
    defaultPlatformPostId: '122100000000000002',
  },
  {
    id: '22222222-2222-4222-8222-222222222223',
    platform: 'bluesky',
    authVariant: null,
    accountIdEnvVar: 'SEED_BLUESKY_ACCOUNT_ID',
    defaultAccountId: 'demo-bluesky-account',
    usernameEnvVar: 'SEED_BLUESKY_USERNAME',
    defaultUsername: 'demo.bsky.social',
    tokenEnvVar: 'SEED_BLUESKY_APP_PASSWORD',
    placeholderToken: 'demo-placeholder-app-password',
    postId: '33333333-3333-4333-8333-333333333333',
    platformPostIdEnvVar: 'SEED_BLUESKY_POST_ID',
    defaultPlatformPostId: 'at://did:plc:demo0000000000000000000003/app.bsky.feed.post/demo0003',
  },
];

/**
 * Resolves every account's overridable fields once, up front and env-only (pure), so both the
 * writes and the closing summary use exactly the same values.
 */
function resolveAllAccounts(): ReadonlyMap<string, ReturnType<typeof resolveAccountValues>> {
  return new Map(
    DEMO_ACCOUNTS.map((account) => [
      account.id,
      resolveAccountValues(process.env, account, account.authVariant),
    ]),
  );
}

function resolvedFor(
  resolved: ReadonlyMap<string, ReturnType<typeof resolveAccountValues>>,
  account: DemoAccount,
): ReturnType<typeof resolveAccountValues> {
  const values = resolved.get(account.id);
  if (values === undefined) {
    throw new Error(`no resolved values for account ${account.id}`);
  }
  return values;
}

/**
 * Awaits every task and, if any rejected, throws one error carrying all their messages.
 *
 * `Promise.all` surfaces the first rejection and attaches-and-discards the rest — silently, with
 * no unhandled-rejection warning — so an operator fixing conflicts one run at a time never sees
 * how many there are.
 */
async function assertAllSettled(tasks: readonly Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(tasks);
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length === 0) {
    return;
  }
  const messages = failures.map((failure) => {
    const reason: unknown = failure.reason;
    return reason instanceof Error ? reason.message : String(reason);
  });
  throw new Error(messages.join('\n\n'));
}

/** The closing summary: which values came from the environment and which are placeholders. */
function reportSources(
  resolved: ReadonlyMap<string, ReturnType<typeof resolveAccountValues>>,
): void {
  console.log('');
  console.log('Credential and id sources for this run:');
  for (const account of DEMO_ACCOUNTS) {
    console.log(formatAccountStatus(account.platform, resolvedFor(resolved, account)));
  }

  console.log('');
  console.log(`Demo workspace ready: ${DEMO_WORKSPACE_ID}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const keyMaterial = {
    key: Buffer.from(config.CREDENTIALS_ENCRYPTION_KEY, 'base64'),
    keyVersion: config.CREDENTIALS_KEY_VERSION,
  };
  // Resolved before the pool exists: `resolveAllAccounts` throws by design on an unrecognised
  // `SEED_*_AUTH_VARIANT`, and doing it after would leak a pool that the `finally` below never
  // reaches. (It happens to exit today only because `pg.Pool` connects lazily.)
  const resolved = resolveAllAccounts();
  const pool = new Pool({ connectionString: config.DATABASE_URL });
  const db = drizzle(pool);

  try {
    await seedEverything(db, config, resolved, keyMaterial);
    reportSources(resolved);
  } finally {
    await closeQuietly('the database pool', () => pool.end());
  }
}

/**
 * The write sequence, with every conflict check completed first.
 *
 * Checks and writes used to interleave, so a conflict on the second account left the first
 * account's row already committed — "the seed failed" and "the database is unchanged" stopped
 * being the same statement. {@link assertAllSettled} also reports *all* the conflicts rather than
 * the first, which matters when the operator is deciding whether to wipe the demo workspace.
 */
async function seedEverything(
  db: Db,
  config: ReturnType<typeof loadConfig>,
  resolved: ReadonlyMap<string, ReturnType<typeof resolveAccountValues>>,
  keyMaterial: { key: Buffer; keyVersion: number },
): Promise<void> {
  await assertAllSettled(
    DEMO_ACCOUNTS.map((account) =>
      checkAccountForConflicts(db, account, resolvedFor(resolved, account), keyMaterial),
    ),
  );

  await seedWorkspace(db, DEMO_WORKSPACE_ID);

  // Each account writes a different row by id, so running them concurrently is safe (and
  // satisfies the project's no-await-in-loop lint, which is otherwise just noise here).
  await assertAllSettled(
    DEMO_ACCOUNTS.map((account) =>
      seedAccount(db, DEMO_WORKSPACE_ID, account, resolvedFor(resolved, account), keyMaterial),
    ),
  );

  await seedApiKey(db, DEMO_WORKSPACE_ID);

  const syncTargetRepository = createSyncTargetRepository(db, config);
  const postPublished = createLocalPostPublished(db, syncTargetRepository);
  await assertAllSettled(
    DEMO_ACCOUNTS.map((account) =>
      seedPost(db, DEMO_WORKSPACE_ID, postPublished, account, resolvedFor(resolved, account)),
    ),
  );
}

try {
  await main();
} catch (error) {
  reportFatal(error);
}
