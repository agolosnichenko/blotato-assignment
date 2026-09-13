import { z } from 'zod';

const urlWithProtocol = (protocols: string[]) =>
  z.string().refine(
    (value) => {
      try {
        return protocols.includes(new URL(value).protocol);
      } catch {
        return false;
      }
    },
    { message: `must be a URL with one of the protocols: ${protocols.join(', ')}` },
  );

const positiveInt = () => z.coerce.number().int().positive();

/**
 * Checks that a string decodes to exactly 32 bytes of base64.
 *
 * Buffer.from(value, 'base64') silently ignores characters outside the base64 alphabet, so a
 * malformed string can decode to any length — the alphabet is checked first to catch that.
 */
const isBase64Of32Bytes = (value: string): boolean =>
  /^[A-Za-z0-9+/]+={0,2}$/u.test(value) &&
  value.length % 4 === 0 &&
  Buffer.from(value, 'base64').length === 32;

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: urlWithProtocol(['postgres:', 'postgresql:']),
  REDIS_URL: urlWithProtocol(['redis:', 'rediss:']),

  CREDENTIALS_ENCRYPTION_KEY: z
    .string()
    .refine(isBase64Of32Bytes, { message: 'must be exactly 32 bytes of base64' }),
  CREDENTIALS_KEY_VERSION: positiveInt().default(1),
  META_APP_SECRET: z.string().min(1),
  META_APP_SECRET_INSTAGRAM: z.string().min(1),
  META_WEBHOOK_VERIFY_TOKEN: z.string().min(1),
  META_GRAPH_API_VERSION: z.string().min(1).default('v21.0'),
  BLUESKY_THREAD_DEPTH: positiveInt().default(10),
  /**
   * The `X-App-Usage` / `X-Business-Use-Case-Usage` percentage at which an account's jobs start
   * being held back (spec.md §8.2). Meta throttles at 100; backing off before that is the point.
   */
  META_USAGE_THROTTLE_PERCENT: positiveInt().default(90),
  /** How long a throttled account's next job waits. The reading itself expires after 5 minutes. */
  META_USAGE_THROTTLE_DELAY_MS: positiveInt().default(60_000),

  RETENTION_DAYS: positiveInt().default(45),
  DOMAIN_EVENTS_TTL_HOURS: positiveInt().default(24),

  SYNC_INTERVALS_BLUESKY_UNDER_24H_MINUTES: positiveInt().default(5),
  SYNC_INTERVALS_BLUESKY_1_TO_7_DAYS_MINUTES: positiveInt().default(60),
  SYNC_INTERVALS_BLUESKY_7_DAYS_TO_RETENTION_MINUTES: positiveInt().default(1440),
  SYNC_INTERVALS_META_UNDER_24H_MINUTES: positiveInt().default(30),
  SYNC_INTERVALS_META_1_TO_7_DAYS_MINUTES: positiveInt().default(360),
  SYNC_INTERVALS_META_7_DAYS_TO_RETENTION_MINUTES: positiveInt().default(1440),

  SYNC_MANUAL_COOLDOWN_SECONDS: positiveInt().default(60),

  RATE_LIMIT_READS_PER_MIN: positiveInt().default(30),
  RATE_LIMIT_WRITES_PER_MIN: positiveInt().default(5),
});

export type Config = z.infer<typeof envSchema>;

/**
 * Validates the process environment and fails fast with every problem listed.
 *
 * Args:
 *   env: Environment to read; defaults to `process.env`.
 *
 * Returns:
 *   The parsed configuration with defaults applied.
 *
 * Raises:
 *   Error: If any variable is missing or malformed.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (result.success) {
    return result.data;
  }
  const details = result.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${details}`);
}
