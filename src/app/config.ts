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

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: urlWithProtocol(['postgres:', 'postgresql:']),
  REDIS_URL: urlWithProtocol(['redis:', 'rediss:']),
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
