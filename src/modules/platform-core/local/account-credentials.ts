/**
 * {@link AccountCredentials} against the local projection — the only path to a platform token
 * (D26, T023).
 *
 * `social_accounts.credentials_ciphertext` is a single `bytea` column, while
 * `src/shared/crypto.ts`'s `EncryptedPayload` carries `iv`, `authTag` and `ciphertext` as separate
 * fields. Neither the schema nor `crypto.ts` (both out of scope for this task) define how those
 * three are packed into one column, so this module owns that convention and is the only place
 * that packs or unpacks it: `iv (12 bytes) || authTag (16 bytes) || ciphertext`. Anything that
 * writes `credentials_ciphertext` — today only `scripts/seed-account.ts` — must use
 * {@link packCredentials} so this reads back correctly.
 */

import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { decrypt, encrypt, type EncryptedPayload, type KeyMaterial } from '#src/shared/crypto.ts';
import { socialAccounts } from '#src/modules/platform-core/schema.ts';
import {
  found,
  NOT_FOUND,
  type AccountCredentials,
  type AccountCredentialsRecord,
  type Found,
} from '#src/modules/platform-core/ports.ts';
import type { Platform } from '#src/platforms/types.ts';

const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;

interface SocialAccountRow {
  readonly socialAccountId: string;
  readonly platform: string;
  readonly authVariant: 'facebook_login' | 'instagram_login' | null;
}

/**
 * Builds the platform-discriminated {@link AccountCredentialsRecord} this port promises (D28):
 * only the Meta arm carries `authVariant` — every other platform's record has no such field, so
 * an adapter that is not the Meta Graph client cannot read it even by accident.
 */
function toCredentialsRecord(row: SocialAccountRow, token: Buffer): AccountCredentialsRecord {
  if (row.platform === 'instagram' || row.platform === 'facebook') {
    return {
      socialAccountId: row.socialAccountId,
      platform: row.platform,
      authVariant: row.authVariant,
      token,
    };
  }
  return {
    socialAccountId: row.socialAccountId,
    // `social_accounts.platform` is an unconstrained text column (this service does not own that
    // table, D8/D29) — every value besides Instagram/Facebook is narrowed to the shared `Platform`
    // union here, the one place this record is built.
    platform: row.platform as Exclude<Platform, 'instagram' | 'facebook'>,
    token,
  };
}

/** Packs an {@link EncryptedPayload} into the single blob stored in `credentials_ciphertext`. */
export function packCredentials(payload: EncryptedPayload): Buffer {
  return Buffer.concat([payload.iv, payload.authTag, payload.ciphertext]);
}

function unpackCredentials(blob: Buffer, keyVersion: number): EncryptedPayload {
  return {
    keyVersion,
    iv: blob.subarray(0, IV_LENGTH_BYTES),
    authTag: blob.subarray(IV_LENGTH_BYTES, IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES),
    ciphertext: blob.subarray(IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES),
  };
}

/** Encrypts `plaintext` and packs it ready for `credentials_ciphertext` (seed script use only). */
export function encryptCredentials(plaintext: Buffer, keyMaterial: KeyMaterial): Buffer {
  return packCredentials(encrypt(plaintext, keyMaterial));
}

export function createLocalAccountCredentials(
  db: NodePgDatabase,
  keyMaterial: KeyMaterial,
): AccountCredentials {
  return {
    async findBySocialAccountId(socialAccountId: string): Promise<Found<AccountCredentialsRecord>> {
      const [row] = await db
        .select({
          socialAccountId: socialAccounts.id,
          platform: socialAccounts.platform,
          authVariant: socialAccounts.authVariant,
          credentialsCiphertext: socialAccounts.credentialsCiphertext,
          credentialsKeyVersion: socialAccounts.credentialsKeyVersion,
        })
        .from(socialAccounts)
        .where(eq(socialAccounts.id, socialAccountId))
        .limit(1);
      if (row === undefined) {
        return NOT_FOUND;
      }

      const payload = unpackCredentials(row.credentialsCiphertext, row.credentialsKeyVersion);
      const token = decrypt(payload, keyMaterial);

      return found(toCredentialsRecord(row, token));
    },
  };
}
