import { describe, expect, it } from 'vitest';
import {
  credentialFingerprint,
  detectConflicts,
  formatAccountStatus,
  formatConflictMessage,
  resolveAuthVariant,
  resolveAccountValues,
  resolveOverride,
} from './seed-account-checks.ts';

describe('resolveOverride', () => {
  it('uses the default when the variable is unset', () => {
    expect(resolveOverride({}, 'SEED_INSTAGRAM_ACCOUNT_ID', 'demo-instagram-account')).toEqual({
      value: 'demo-instagram-account',
      fromEnv: false,
    });
  });

  it('uses the default when the variable is set but empty', () => {
    const env = { SEED_INSTAGRAM_ACCOUNT_ID: '' };
    expect(resolveOverride(env, 'SEED_INSTAGRAM_ACCOUNT_ID', 'demo-instagram-account')).toEqual({
      value: 'demo-instagram-account',
      fromEnv: false,
    });
  });

  it('uses the environment value when set', () => {
    const env = { SEED_INSTAGRAM_ACCOUNT_ID: '17841400000000001' };
    expect(resolveOverride(env, 'SEED_INSTAGRAM_ACCOUNT_ID', 'demo-instagram-account')).toEqual({
      value: '17841400000000001',
      fromEnv: true,
    });
  });
});

describe('resolveAccountValues', () => {
  const keys = {
    accountIdEnvVar: 'SEED_INSTAGRAM_ACCOUNT_ID',
    defaultAccountId: 'demo-instagram-account',
    usernameEnvVar: 'SEED_INSTAGRAM_USERNAME',
    defaultUsername: 'demo.instagram',
    platformPostIdEnvVar: 'SEED_INSTAGRAM_POST_ID',
    defaultPlatformPostId: '17895600000000001',
    tokenEnvVar: 'SEED_INSTAGRAM_TOKEN',
    placeholderToken: 'demo-placeholder-token-instagram',
    authVariantEnvVar: 'SEED_INSTAGRAM_AUTH_VARIANT',
  };

  it('resolves every field to its default when nothing is set', () => {
    expect(resolveAccountValues({}, keys, 'instagram_login')).toEqual({
      platformAccountId: { value: 'demo-instagram-account', fromEnv: false },
      username: { value: 'demo.instagram', fromEnv: false },
      platformPostId: { value: '17895600000000001', fromEnv: false },
      token: { value: 'demo-placeholder-token-instagram', fromEnv: false },
      authVariant: 'instagram_login',
    });
  });

  it('resolves each field independently from its own variable', () => {
    const env = {
      SEED_INSTAGRAM_ACCOUNT_ID: '17841400000000001',
      SEED_INSTAGRAM_TOKEN: 'real-token',
    };
    const resolved = resolveAccountValues(env, keys, 'instagram_login');
    expect(resolved.platformAccountId).toEqual({ value: '17841400000000001', fromEnv: true });
    expect(resolved.token).toEqual({ value: 'real-token', fromEnv: true });
    // Fields with no matching env var stay at their default.
    expect(resolved.username).toEqual({ value: 'demo.instagram', fromEnv: false });
    expect(resolved.platformPostId).toEqual({ value: '17895600000000001', fromEnv: false });
  });
});

describe('resolveAuthVariant', () => {
  const keys = {
    accountIdEnvVar: 'A',
    defaultAccountId: 'a',
    usernameEnvVar: 'U',
    defaultUsername: 'u',
    platformPostIdEnvVar: 'P',
    defaultPlatformPostId: 'p',
    tokenEnvVar: 'T',
    placeholderToken: 't',
    authVariantEnvVar: 'SEED_INSTAGRAM_AUTH_VARIANT',
  };

  it('keeps the compiled-in variant when the variable is unset', () => {
    expect(resolveAuthVariant({}, keys, 'instagram_login')).toBe('instagram_login');
  });

  it('takes the variant from the environment', () => {
    const env = { SEED_INSTAGRAM_AUTH_VARIANT: 'facebook_login' };
    expect(resolveAuthVariant(env, keys, 'instagram_login')).toBe('facebook_login');
  });

  it('reads the literal null as no variant', () => {
    expect(
      resolveAuthVariant({ SEED_INSTAGRAM_AUTH_VARIANT: 'null' }, keys, 'facebook_login'),
    ).toBe(null);
  });

  it('refuses an unrecognised variant instead of falling back to the default', () => {
    const env = { SEED_INSTAGRAM_AUTH_VARIANT: 'instagram' };
    expect(() => resolveAuthVariant(env, keys, 'instagram_login')).toThrowError(
      /SEED_INSTAGRAM_AUTH_VARIANT="instagram" is not a known auth variant/u,
    );
  });

  it('ignores the environment for a platform with no variant variable', () => {
    const { authVariantEnvVar: _unused, ...noVariantKeys } = keys;
    const env = { SEED_INSTAGRAM_AUTH_VARIANT: 'facebook_login' };
    expect(resolveAuthVariant(env, noVariantKeys, null)).toBe(null);
  });
});

describe('credentialFingerprint', () => {
  it('is stable for one token and different for another', () => {
    const one = credentialFingerprint(Buffer.from('token-a'));
    expect(credentialFingerprint(Buffer.from('token-a'))).toBe(one);
    expect(credentialFingerprint(Buffer.from('token-b'))).not.toBe(one);
  });

  it('reveals no part of the token', () => {
    const token = 'EAAWsupersecretvalue';
    expect(credentialFingerprint(Buffer.from(token))).not.toContain(token.slice(0, 6));
  });
});

describe('detectConflicts', () => {
  it('reports nothing for a row that does not exist yet', () => {
    expect(detectConflicts(undefined, { platformAccountId: '17841400000000001' })).toEqual([]);
  });

  it('reports nothing when the stored row matches what would be seeded', () => {
    const stored = { platformAccountId: 'demo-instagram-account', username: 'demo.instagram' };
    const desired = { platformAccountId: 'demo-instagram-account', username: 'demo.instagram' };
    expect(detectConflicts(stored, desired)).toEqual([]);
  });

  it('reports a single differing field', () => {
    const stored = { platformAccountId: 'demo-instagram-account', username: 'demo.instagram' };
    const desired = { platformAccountId: '17841400000000001', username: 'demo.instagram' };
    expect(detectConflicts(stored, desired)).toEqual([
      {
        field: 'platformAccountId',
        stored: 'demo-instagram-account',
        desired: '17841400000000001',
      },
    ]);
  });

  it('reports every differing field, not just the first', () => {
    const stored = { platformAccountId: 'demo-instagram-account', username: 'demo.instagram' };
    const desired = { platformAccountId: '17841400000000001', username: 'real.handle' };
    expect(detectConflicts(stored, desired)).toEqual([
      {
        field: 'platformAccountId',
        stored: 'demo-instagram-account',
        desired: '17841400000000001',
      },
      { field: 'username', stored: 'demo.instagram', desired: 'real.handle' },
    ]);
  });
});

describe('formatConflictMessage', () => {
  it('names the row, each field, the stored value and the supplied value', () => {
    const message = formatConflictMessage('Social account 222… (instagram)', [
      {
        field: 'platformAccountId',
        stored: 'demo-instagram-account',
        desired: '17841400000000001',
      },
    ]);
    expect(message).toContain('Social account 222… (instagram)');
    expect(message).toContain('platformAccountId');
    expect(message).toContain('demo-instagram-account');
    expect(message).toContain('17841400000000001');
    expect(message).toContain('clear the demo workspace first');
  });
});

describe('formatAccountStatus', () => {
  it('reports placeholder credential and default ids', () => {
    const resolved = {
      platformAccountId: { value: 'demo-instagram-account', fromEnv: false },
      username: { value: 'demo.instagram', fromEnv: false },
      platformPostId: { value: '17895600000000001', fromEnv: false },
      token: { value: 'demo-placeholder-token-instagram', fromEnv: false },
      authVariant: 'instagram_login' as const,
    };
    expect(formatAccountStatus('instagram', resolved)).toBe(
      '  instagram: credential from placeholder; ids default.',
    );
  });

  it('reports environment credential and overridden ids when any id field came from env', () => {
    const resolved = {
      platformAccountId: { value: '17841400000000001', fromEnv: true },
      username: { value: 'demo.instagram', fromEnv: false },
      platformPostId: { value: '17895600000000001', fromEnv: false },
      token: { value: 'real-token', fromEnv: true },
      authVariant: 'facebook_login' as const,
    };
    expect(formatAccountStatus('instagram', resolved)).toBe(
      '  instagram: credential from environment; ids overridden.',
    );
  });
});
