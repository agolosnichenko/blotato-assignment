import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decrypt,
  encrypt,
  hashSecret,
  KeyVersionMismatchError,
  secureCompare,
  type KeyMaterial,
} from '#src/shared/crypto.ts';

const keyV1: KeyMaterial = { key: randomBytes(32), keyVersion: 1 };
const keyV2: KeyMaterial = { key: randomBytes(32), keyVersion: 2 };

describe('encrypt/decrypt', () => {
  it('round-trips plaintext through AES-256-GCM', () => {
    const plaintext = Buffer.from('super-secret-access-token');

    const payload = encrypt(plaintext, keyV1);
    const decrypted = decrypt(payload, keyV1);

    expect(decrypted.equals(plaintext)).toBe(true);
    expect(payload.keyVersion).toBe(1);
    expect(payload.iv).toHaveLength(12);
  });

  it('fails to decrypt a tampered ciphertext', () => {
    const payload = encrypt(Buffer.from('super-secret-access-token'), keyV1);
    const tampered = { ...payload, ciphertext: Buffer.from(payload.ciphertext) };
    tampered.ciphertext[0] = tampered.ciphertext[0]! ^ 0xff;

    expect(() => decrypt(tampered, keyV1)).toThrowError();
  });

  it('rejects decryption with the wrong key_version', () => {
    const payload = encrypt(Buffer.from('super-secret-access-token'), keyV1);

    expect(() => decrypt(payload, keyV2)).toThrowError(KeyVersionMismatchError);
  });

  it('uses a fresh random IV on every call', () => {
    const plaintext = Buffer.from('same-plaintext');

    const first = encrypt(plaintext, keyV1);
    const second = encrypt(plaintext, keyV1);

    expect(first.iv.equals(second.iv)).toBe(false);
  });
});

describe('hashSecret', () => {
  it('returns a stable, hex-encoded SHA-256 digest', () => {
    const digest = hashSecret('a-plaintext-secret');

    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(digest).toBe(hashSecret('a-plaintext-secret'));
  });

  it('produces different digests for different inputs', () => {
    expect(hashSecret('secret-a')).not.toBe(hashSecret('secret-b'));
  });
});

describe('secureCompare', () => {
  it('returns true for equal values', () => {
    expect(secureCompare('same-value', 'same-value')).toBe(true);
  });

  it('returns false for different values of the same length', () => {
    expect(secureCompare('value-aaaa', 'value-bbbb')).toBe(false);
  });

  it('returns false for values of different lengths, without throwing', () => {
    expect(() => secureCompare('short', 'a-much-longer-value')).not.toThrow();
    expect(secureCompare('short', 'a-much-longer-value')).toBe(false);
  });

  it('works on Buffers as well as strings', () => {
    expect(secureCompare(Buffer.from('abc'), Buffer.from('abc'))).toBe(true);
    expect(secureCompare(Buffer.from('abc'), Buffer.from('xyz'))).toBe(false);
  });
});
