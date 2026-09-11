import { describe, expect, it } from 'vitest';
import { loadConfig } from '#src/app/config.ts';

const validEnv = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/comments',
  REDIS_URL: 'redis://localhost:6379',
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
