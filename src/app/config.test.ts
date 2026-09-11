import { describe, expect, it } from 'vitest';
import { loadConfig } from '#src/app/config.ts';

const VALID_ENCRYPTION_KEY = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';

const validEnv = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/comments',
  REDIS_URL: 'redis://localhost:6379',
  CREDENTIALS_ENCRYPTION_KEY: VALID_ENCRYPTION_KEY,
  META_APP_SECRET: 'app-secret',
  META_APP_SECRET_INSTAGRAM: 'app-secret-ig',
  META_WEBHOOK_VERIFY_TOKEN: 'verify-token',
};

describe('loadConfig', () => {
  it('applies defaults for optional variables', () => {
    const config = loadConfig(validEnv);

    expect(config).toMatchObject({
      NODE_ENV: 'development',
      HOST: '0.0.0.0',
      PORT: 3000,
      LOG_LEVEL: 'info',
    });
  });

  it('coerces PORT from its string environment value', () => {
    expect(loadConfig({ ...validEnv, PORT: '8080' }).PORT).toBe(8080);
  });

  it('reports every problem at once instead of the first one', () => {
    expect(() => loadConfig({})).toThrowError(
      /Invalid environment configuration:[\s\S]*DATABASE_URL[\s\S]*REDIS_URL/u,
    );
  });

  it('rejects a database URL that is not Postgres', () => {
    expect(() =>
      loadConfig({ ...validEnv, DATABASE_URL: 'mysql://localhost:3306/db' }),
    ).toThrowError(
      /DATABASE_URL: must be a URL with one of the protocols: postgres:, postgresql:/u,
    );
  });

  it('rejects a port outside the valid range', () => {
    expect(() => loadConfig({ ...validEnv, PORT: '70000' })).toThrowError(/PORT/u);
  });
});

describe('loadConfig feature variables', () => {
  it('applies defaults for the feature variables', () => {
    const config = loadConfig(validEnv);

    expect(config).toMatchObject({
      CREDENTIALS_KEY_VERSION: 1,
      META_GRAPH_API_VERSION: 'v21.0',
      RETENTION_DAYS: 45,
      SYNC_INTERVALS_BLUESKY_UNDER_24H_MINUTES: 5,
      SYNC_INTERVALS_BLUESKY_1_TO_7_DAYS_MINUTES: 60,
      SYNC_INTERVALS_BLUESKY_7_DAYS_TO_RETENTION_MINUTES: 1440,
      SYNC_INTERVALS_META_UNDER_24H_MINUTES: 30,
      SYNC_INTERVALS_META_1_TO_7_DAYS_MINUTES: 360,
      SYNC_INTERVALS_META_7_DAYS_TO_RETENTION_MINUTES: 1440,
      SYNC_MANUAL_COOLDOWN_SECONDS: 60,
      RATE_LIMIT_READS_PER_MIN: 30,
      RATE_LIMIT_WRITES_PER_MIN: 5,
    });
  });

  it('reports a missing required variable, such as META_APP_SECRET', () => {
    const { META_APP_SECRET, ...envWithoutSecret } = validEnv;
    void META_APP_SECRET;

    expect(() => loadConfig(envWithoutSecret)).toThrowError(/META_APP_SECRET/u);
  });

  it('rejects an encryption key that does not decode to exactly 32 bytes', () => {
    // 16 bytes, valid base64, wrong length
    const shortKey = 'AQEBAQEBAQEBAQEBAQEBAQ==';

    expect(() => loadConfig({ ...validEnv, CREDENTIALS_ENCRYPTION_KEY: shortKey })).toThrowError(
      /CREDENTIALS_ENCRYPTION_KEY[\s\S]*32 bytes/u,
    );
  });

  it('rejects an encryption key that is not valid base64', () => {
    expect(() =>
      loadConfig({ ...validEnv, CREDENTIALS_ENCRYPTION_KEY: 'not-valid-base64!!' }),
    ).toThrowError(/CREDENTIALS_ENCRYPTION_KEY[\s\S]*32 bytes/u);
  });

  it('rejects RETENTION_DAYS when it is not a positive integer', () => {
    expect(() => loadConfig({ ...validEnv, RETENTION_DAYS: '0' })).toThrowError(/RETENTION_DAYS/u);
  });
});
