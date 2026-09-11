import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;

/** A key together with the version it is registered under (D25, §5.1). */
export interface KeyMaterial {
  readonly key: Buffer;
  readonly keyVersion: number;
}

/**
 * An AES-256-GCM ciphertext plus the fields needed to decrypt and authenticate it.
 *
 * `keyVersion` travels with the ciphertext so a caller reading it back from
 * `social_accounts.credentials_ciphertext` / `credentials_key_version` (data-model.md)
 * knows which key to fetch before it ever attempts decryption.
 */
export interface EncryptedPayload {
  readonly keyVersion: number;
  readonly iv: Buffer;
  readonly authTag: Buffer;
  readonly ciphertext: Buffer;
}

/**
 * Thrown by {@link decrypt} when the caller-supplied key material is not the one
 * the payload was encrypted with. Decryption must refuse explicitly rather than
 * silently attempt the only key it has (§10).
 */
export class KeyVersionMismatchError extends Error {
  constructor(
    readonly expectedKeyVersion: number,
    readonly actualKeyVersion: number,
  ) {
    super(
      `key_version mismatch: payload was encrypted with version ${actualKeyVersion}, ` +
        `but key material for version ${expectedKeyVersion} was supplied`,
    );
    this.name = 'KeyVersionMismatchError';
  }
}

/**
 * Encrypts `plaintext` with AES-256-GCM under `keyMaterial.key`, using a fresh
 * random 12-byte IV per call.
 *
 * The module never reads configuration itself — the caller resolves the key and
 * its version (e.g. from the `AccountCredentials` port, D26) and supplies both.
 */
export function encrypt(plaintext: Buffer, keyMaterial: KeyMaterial): EncryptedPayload {
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, keyMaterial.key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    keyVersion: keyMaterial.keyVersion,
    iv,
    authTag: cipher.getAuthTag(),
    ciphertext,
  };
}

/**
 * Decrypts `payload` with `keyMaterial`, verifying the GCM authentication tag.
 *
 * @throws {KeyVersionMismatchError} if `keyMaterial.keyVersion` does not match
 *   `payload.keyVersion` — checked before any decryption is attempted.
 * @throws {Error} if the authentication tag does not verify, e.g. because the
 *   ciphertext was tampered with.
 */
export function decrypt(payload: EncryptedPayload, keyMaterial: KeyMaterial): Buffer {
  if (payload.keyVersion !== keyMaterial.keyVersion) {
    throw new KeyVersionMismatchError(keyMaterial.keyVersion, payload.keyVersion);
  }
  const decipher = createDecipheriv(ALGORITHM, keyMaterial.key, payload.iv);
  decipher.setAuthTag(payload.authTag);
  return Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]);
}

/** Hex-encoded SHA-256 digest, used for the stored half of an API-key secret. */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * Constant-time equality check for secrets (API-key secrets, webhook HMAC
 * signatures), safe to use on inputs of different lengths.
 *
 * `crypto.timingSafeEqual` throws on a length mismatch, and returning `false`
 * from an early length check would leak the secret's length through timing. So
 * both inputs are first reduced to fixed-length SHA-256 digests — always 32
 * bytes regardless of the original length — and those digests are compared with
 * `crypto.timingSafeEqual` instead.
 */
export function secureCompare(a: Buffer | string, b: Buffer | string): boolean {
  const digestA = createHash('sha256').update(a).digest();
  const digestB = createHash('sha256').update(b).digest();
  return timingSafeEqual(digestA, digestB);
}
