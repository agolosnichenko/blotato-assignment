/* oxlint-disable no-console -- operator-facing status output; see seed-account.ts's own disable. */
/**
 * Database-writing half of `scripts/seed-account.ts` — see that file's module docstring for why
 * this script (and this file, by extension) is one of the two declared exceptions to "nothing
 * under `src/` writes the platform-core tables" (D8/D29). Split out only to keep
 * `seed-account.ts` under the project's per-file dependency and line limits; it has no logic of
 * its own that `seed-account.test.ts` needs to exercise directly (that lives in
 * `seed-account-checks.ts`).
 */

import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  createLocalAccountCredentials,
  encryptCredentials,
} from '#src/modules/platform-core/local/account-credentials.ts';
import type { createLocalPostPublished } from '#src/modules/platform-core/local/post-published.ts';
import { apiKeys, posts, socialAccounts, workspaces } from '#src/modules/platform-core/schema.ts';
import { AuthError } from '#src/platforms/types.ts';
import type { WorkspaceId } from '#src/shared/ids.ts';
import { hashSecret, type KeyMaterial } from '#src/shared/crypto.ts';
import { generateId } from '#src/shared/ids.ts';
import {
  credentialFingerprint,
  detectConflicts,
  formatConflictMessage,
  type DemoAccount,
  type ResolvedAccountValues,
} from './seed-account-checks.ts';

const SECRET_ENTROPY_BYTES = 32;
const PREFIX_BYTES = 6;

export type Db = NodePgDatabase;

export async function seedWorkspace(db: Db, workspaceId: WorkspaceId): Promise<void> {
  const [inserted] = await db
    .insert(workspaces)
    .values({
      id: workspaceId,
      name: 'Demo workspace',
      contactLimitMonthly: 1000,
      createdAt: new Date(),
    })
    .onConflictDoNothing({ target: workspaces.id })
    .returning({ id: workspaces.id });

  console.log(
    inserted === undefined
      ? `Workspace ${workspaceId} already exists.`
      : `Created workspace ${workspaceId}.`,
  );
}

/**
 * Reads the stored `social_accounts` row (if any) and refuses to continue when it disagrees with
 * what `resolved` is about to seed — see `seed-account.ts`'s module docstring for why an in-place
 * update is not an option here.
 */
async function storedCredentialFingerprint(
  db: Db,
  socialAccountId: string,
  keyMaterial: KeyMaterial,
): Promise<string> {
  try {
    const found = await createLocalAccountCredentials(db, keyMaterial).findBySocialAccountId(
      socialAccountId,
    );
    return found.found ? credentialFingerprint(found.value.token) : 'absent';
  } catch (error) {
    // Only a genuine decryption failure — `AccountCredentials` narrows those to `AuthError` — is
    // reported as a conflict rather than crashing the seed: the operator's next step is the same
    // either way, clear the row. Everything else here is a database problem (a dropped
    // connection, a statement timeout, a column missing after a partial migration), and reporting
    // one of those as a corrupt key would tell the operator to wipe the demo workspace over a
    // network blip.
    if (error instanceof AuthError) {
      return 'undecryptable';
    }
    throw error;
  }
}

export async function checkAccountForConflicts(
  db: Db,
  account: DemoAccount,
  resolved: ResolvedAccountValues,
  keyMaterial: KeyMaterial,
): Promise<void> {
  const [existing] = await db
    .select({
      platformAccountId: socialAccounts.platformAccountId,
      username: socialAccounts.username,
      authVariant: socialAccounts.authVariant,
    })
    .from(socialAccounts)
    .where(eq(socialAccounts.id, account.id));

  // Compared as fingerprints of the *decrypted* values, never as ciphertext: AES-256-GCM uses a
  // fresh IV per encryption, so identical tokens never produce identical bytes. Without this, a
  // re-run carrying a newly issued token would report success and leave the old one in place —
  // the exact silent divergence the rest of this check exists to prevent.
  const storedFingerprint =
    existing === undefined
      ? undefined
      : await storedCredentialFingerprint(db, account.id, keyMaterial);

  const conflicts = detectConflicts(
    existing === undefined
      ? undefined
      : {
          platformAccountId: existing.platformAccountId,
          username: existing.username,
          authVariant: String(existing.authVariant),
          credential: storedFingerprint ?? 'absent',
        },
    {
      platformAccountId: resolved.platformAccountId.value,
      username: resolved.username.value,
      authVariant: String(resolved.authVariant),
      credential: credentialFingerprint(Buffer.from(resolved.token.value, 'utf8')),
    },
  );
  if (conflicts.length > 0) {
    throw new Error(
      formatConflictMessage(`Social account ${account.id} (${account.platform})`, conflicts),
    );
  }
}

export async function seedAccount(
  db: Db,
  workspaceId: WorkspaceId,
  account: DemoAccount,
  resolved: ResolvedAccountValues,
  keyMaterial: KeyMaterial,
): Promise<void> {
  await checkAccountForConflicts(db, account, resolved, keyMaterial);

  const credentialsCiphertext = encryptCredentials(
    Buffer.from(resolved.token.value, 'utf8'),
    keyMaterial,
  );

  const [inserted] = await db
    .insert(socialAccounts)
    .values({
      id: account.id,
      workspaceId,
      platform: account.platform,
      platformAccountId: resolved.platformAccountId.value,
      username: resolved.username.value,
      authVariant: resolved.authVariant,
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
      : `Created social account ${account.id} (${account.platform}).`,
  );
}

/** Mints one fresh API key (see `seed-account.ts`'s module docstring: never reused, unlike the rest). */
export async function seedApiKey(db: Db, workspaceId: WorkspaceId): Promise<void> {
  const prefix = randomBytes(PREFIX_BYTES).toString('hex');
  const secret = randomBytes(SECRET_ENTROPY_BYTES).toString('base64url');
  const fullKey = `blt_${prefix}_${secret}`;

  await db.insert(apiKeys).values({
    id: generateId(),
    workspaceId,
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
 * active `comment_sync_targets` row (`seed-account.ts`'s module docstring, §7.3); `published_at`
 * becomes the target's `age_anchor_at`.
 */
export async function seedPost(
  db: Db,
  workspaceId: WorkspaceId,
  postPublished: ReturnType<typeof createLocalPostPublished>,
  account: DemoAccount,
  resolved: ResolvedAccountValues,
): Promise<void> {
  const [existing] = await db
    .select({ platformPostId: posts.platformPostId })
    .from(posts)
    .where(eq(posts.id, account.postId));

  const conflicts = detectConflicts(existing, { platformPostId: resolved.platformPostId.value });
  if (conflicts.length > 0) {
    throw new Error(
      formatConflictMessage(`Post ${account.postId} (${account.platform})`, conflicts),
    );
  }

  await postPublished.notify({
    id: account.postId,
    workspaceId,
    socialAccountId: account.id,
    platform: account.platform,
    platformPostId: resolved.platformPostId.value,
    // 2 hours old: lands in §7.3's "< 24h" sync band, so a freshly seeded target is due soon
    // rather than sitting in the slowest band until someone notices nothing is being polled.
    publishedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
  });

  console.log(`Registered post ${account.postId} (${account.platform}) as a sync target.`);
}
