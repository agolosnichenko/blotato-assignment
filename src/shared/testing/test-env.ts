/**
 * Placeholder environment variables for `loadConfig` in integration tests (D25).
 *
 * `CREDENTIALS_ENCRYPTION_KEY`, `META_APP_SECRET`, `META_APP_SECRET_INSTAGRAM` and
 * `META_WEBHOOK_VERIFY_TOKEN` are required with no default (T007), so every integration test needs
 * them regardless of whether the test exercises Meta or credentials at all. These values are never
 * real secrets — fixed placeholders, committed, used only against ephemeral testcontainers.
 */

/** 32 zero bytes, base64-encoded — satisfies `CREDENTIALS_ENCRYPTION_KEY`'s length check only. */
export const TEST_CREDENTIALS_ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/** The subset of `loadConfig`'s required-with-no-default variables every integration test needs. */
export const TEST_ENV = {
  CREDENTIALS_ENCRYPTION_KEY: TEST_CREDENTIALS_ENCRYPTION_KEY,
  META_APP_SECRET: 'test-meta-app-secret',
  META_APP_SECRET_INSTAGRAM: 'test-meta-app-secret-instagram',
  META_WEBHOOK_VERIFY_TOKEN: 'test-meta-webhook-verify-token',
} as const;
