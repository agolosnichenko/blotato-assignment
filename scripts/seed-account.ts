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
 * No real secret is ever in source (D25): platform tokens are read from optional
 * `SEED_*_TOKEN`/`SEED_BLUESKY_APP_PASSWORD` env vars and fall back to an obviously-fake
 * placeholder string when unset, then encrypted with `CREDENTIALS_ENCRYPTION_KEY` before being
 * written — nothing here is suitable for calling a real platform API (see CLAUDE.md's "Meta
 * constraints" and spikes S1/S2/S5 for why that is out of scope for this script).
 *
 * Idempotency: the workspace, its three accounts and their three posts all use fixed demo ids and
 * are inserted with `ON CONFLICT DO NOTHING`, so re-running leaves them untouched and reports
 * "already exists" for each. The API key is the one exception — like `create-api-key.ts`, every
 * run mints a fresh, independent key, because a key's secret cannot be recovered from the
 * database once minted (D25) and a workspace legitimately holding more than one key is normal.
 *
 * Usage:
 *   pnpm seed:account
 */

import { randomBytes } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { loadConfig } from '#src/app/config.ts';
import { createSyncTargetRepository } from '#src/modules/comments/infrastructure/sync-target-repository.ts';
import { encryptCredentials } from '#src/modules/platform-core/local/account-credentials.ts';
import { createLocalPostPublished } from '#src/modules/platform-core/local/post-published.ts';
import { apiKeys, socialAccounts, workspaces } from '#src/modules/platform-core/schema.ts';
import { hashSecret } from '#src/shared/crypto.ts';
import { generateId } from '#src/shared/ids.ts';

const SECRET_ENTROPY_BYTES = 32;
const PREFIX_BYTES = 6;

const DEMO_WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const DEMO_CONTACT_LIMIT_MONTHLY = 1000;

interface DemoAccount {
  readonly id: string;
  readonly platform: 'instagram' | 'facebook' | 'bluesky';
  readonly authVariant: 'facebook_login' | 'instagram_login' | null;
  readonly username: string;
  /** Env var an operator can set to supply a real token instead of the placeholder. */
  readonly tokenEnvVar: string;
  readonly placeholderToken: string;
  readonly postId: string;
  readonly platformPostId: string;
}

// Two Meta auth variants (D28) are seeded deliberately, not just one: `instagram_login` and
// `facebook_login` exercise the two different `AccountCredentials`/Graph-client code paths the
// registry supports (§8.2) rather than leaving one of them untested by every local run.
const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  {
    id: '22222222-2222-4222-8222-222222222221',
    platform: 'instagram',
    authVariant: 'instagram_login',
    username: 'demo.instagram',
    tokenEnvVar: 'SEED_INSTAGRAM_TOKEN',
    placeholderToken: 'demo-placeholder-token-instagram',
    postId: '33333333-3333-4333-8333-333333333331',
    platformPostId: '17895600000000001',
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    platform: 'facebook',
    authVariant: 'facebook_login',
    username: 'demo.facebook',
    tokenEnvVar: 'SEED_FACEBOOK_TOKEN',
    placeholderToken: 'demo-placeholder-token-facebook',
    postId: '33333333-3333-4333-8333-333333333332',
    platformPostId: '122100000000000002',
  },
  {
    id: '22222222-2222-4222-8222-222222222223',
    platform: 'bluesky',
    authVariant: null,
    username: 'demo.bsky.social',
    tokenEnvVar: 'SEED_BLUESKY_APP_PASSWORD',
    placeholderToken: 'demo-placeholder-app-password',
    postId: '33333333-3333-4333-8333-333333333333',
    platformPostId: 'at://did:plc:demo0000000000000000000003/app.bsky.feed.post/demo0003',
  },
];

type Db = ReturnType<typeof drizzle>;

async function seedWorkspace(db: Db): Promise<void> {
  const [inserted] = await db
    .insert(workspaces)
    .values({
      id: DEMO_WORKSPACE_ID,
      name: 'Demo workspace',
      contactLimitMonthly: DEMO_CONTACT_LIMIT_MONTHLY,
      createdAt: new Date(),
    })
    .onConflictDoNothing({ target: workspaces.id })
    .returning({ id: workspaces.id });

  console.log(
    inserted === undefined
      ? `Workspace ${DEMO_WORKSPACE_ID} already exists.`
      : `Created workspace ${DEMO_WORKSPACE_ID}.`,
  );
}

async function seedAccount(
  db: Db,
  account: DemoAccount,
  keyMaterial: Parameters<typeof encryptCredentials>[1],
): Promise<void> {
  const token = process.env[account.tokenEnvVar] ?? account.placeholderToken;
  const credentialsCiphertext = encryptCredentials(Buffer.from(token, 'utf8'), keyMaterial);

  const [inserted] = await db
    .insert(socialAccounts)
    .values({
      id: account.id,
      workspaceId: DEMO_WORKSPACE_ID,
      platform: account.platform,
      platformAccountId: `demo-${account.platform}-account`,
      username: account.username,
      authVariant: account.authVariant,
      credentialsCiphertext,
      credentialsKeyVersion: keyMaterial.keyVersion,
      status: 'active',
      createdAt: new Date(),
    })
    .onConflictDoNothing({ target: socialAccounts.id })
    .returning({ id: socialAccounts.id });

  console.log(
    inserted === undefined
      ? `Social account ${account.id} (${account.platform}) already exists.`
      : `Created social account ${account.id} (${account.platform}), credentials from ` +
          `${process.env[account.tokenEnvVar] === undefined ? 'placeholder' : account.tokenEnvVar}.`,
  );
}

/** Mints one fresh API key (see module docstring: unlike the workspace/accounts/posts, never reused). */
async function seedApiKey(db: Db): Promise<void> {
  const prefix = randomBytes(PREFIX_BYTES).toString('hex');
  const secret = randomBytes(SECRET_ENTROPY_BYTES).toString('base64url');
  const fullKey = `blt_${prefix}_${secret}`;

  await db.insert(apiKeys).values({
    id: generateId(),
    workspaceId: DEMO_WORKSPACE_ID,
    prefix,
    keyHash: hashSecret(secret),
    name: 'seed-account demo key',
    rateLimitPerMin: null,
    revokedAt: null,
    createdAt: new Date(),
  });

  console.log('Minted a new API key for the demo workspace (shown once, not recoverable):');
  console.log('');
  console.log(fullKey);
}

/**
 * Publishes one demo post through the `PostPublished` port, the same way the publishing service
 * would in the real platform — not a direct `posts` insert. That is what turns the post into an
 * active `comment_sync_targets` row (module docstring, §7.3); `published_at` becomes the target's
 * `age_anchor_at`. Both the `posts` row and the target are inserted `ON CONFLICT DO NOTHING`, so
 * this is safe to call again on a re-run.
 */
async function seedPost(
  postPublished: ReturnType<typeof createLocalPostPublished>,
  account: DemoAccount,
): Promise<void> {
  await postPublished.notify({
    id: account.postId,
    workspaceId: DEMO_WORKSPACE_ID,
    socialAccountId: account.id,
    platform: account.platform,
    platformPostId: account.platformPostId,
    // 2 hours old: lands in §7.3's "< 24h" sync band, so a freshly seeded target is due soon
    // rather than sitting in the slowest band until someone notices nothing is being polled.
    publishedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
  });

  console.log(`Registered post ${account.postId} (${account.platform}) as a sync target.`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const keyMaterial = {
    key: Buffer.from(config.CREDENTIALS_ENCRYPTION_KEY, 'base64'),
    keyVersion: config.CREDENTIALS_KEY_VERSION,
  };
  const pool = new Pool({ connectionString: config.DATABASE_URL });
  const db = drizzle(pool);

  try {
    await seedWorkspace(db);

    // Each account writes a different row by id, so running them concurrently is safe (and
    // satisfies the project's no-await-in-loop lint, which is otherwise just noise here).
    await Promise.all(DEMO_ACCOUNTS.map((account) => seedAccount(db, account, keyMaterial)));

    await seedApiKey(db);

    const syncTargetRepository = createSyncTargetRepository(db, config);
    const postPublished = createLocalPostPublished(db, syncTargetRepository);
    await Promise.all(DEMO_ACCOUNTS.map((account) => seedPost(postPublished, account)));

    console.log('');
    console.log(`Demo workspace ready: ${DEMO_WORKSPACE_ID}`);
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
