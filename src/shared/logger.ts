import { pino, type DestinationStream, type Logger } from 'pino';
import type { Config } from '#src/app/config.ts';

const REDACTED_HEADER_PATHS = [
  'req.headers["blotato-api-key"]',
  'req.headers.authorization',
  'req.headers.cookie',
];

/**
 * Field names that must never reach a log line as plaintext: comment text (nulled on deletion,
 * FR-030) and platform credentials reached through the `AccountCredentials` port (D26).
 */
const SENSITIVE_FIELD_NAMES = [
  'text',
  'token',
  'accessToken',
  'refreshToken',
  'appPassword',
  'credentials',
  'credentialsCiphertext',
];

/**
 * Pino's redact paths each match one exact depth — there is no recursive wildcard, so a
 * depth-unlimited guarantee would need walking the log object in a `hooks.logMethod` before
 * pino's own serializers (req/res/err) run, which is a bigger change than this module's scope.
 * Instead each name is redacted at the top level and up to four levels of nesting — enough for
 * the shapes this codebase actually logs (`req.body.text` at depth 2, a BullMQ
 * `job.data.comment.text` or a wrapped `result.page.comments[0].text` at depth 3–4). Under A22
 * these logs are the whole observability surface, so a *fifth*-level nesting is the point where
 * this guarantee stops; keep new call sites logging comment text no deeper than that, or extend
 * this list if one has to.
 */
const REDACTED_CONTENT_PATHS = ['', '*.', '*.*.', '*.*.*.', '*.*.*.*.'].flatMap((prefix) =>
  SENSITIVE_FIELD_NAMES.map((name) => `${prefix}${name}`),
);

const REDACTED_PATHS = [...REDACTED_HEADER_PATHS, ...REDACTED_CONTENT_PATHS];

/**
 * Creates the service logger.
 *
 * Args:
 *   config: Validated environment configuration; supplies the log level.
 *   bindings: Fields stamped on every entry (e.g. `role: 'api' | 'worker'`).
 *   destination: Where log lines are written; defaults to stdout. Overridable so tests can
 *     capture output without spawning a process.
 *
 * Returns:
 *   A pino logger with the service's redaction rules applied.
 */
export function createLogger(
  config: Config,
  bindings: Record<string, string> = {},
  destination?: DestinationStream,
): Logger {
  const options = {
    level: config.LOG_LEVEL,
    base: bindings,
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}

/**
 * Stamps `requestId` on every entry logged through the returned child logger.
 *
 * The API role has one request context per inbound HTTP call; wiring this into the Fastify
 * request lifecycle belongs to the route/plugin setup, not this module.
 */
export function forRequest(logger: Logger, requestId: string): Logger {
  return logger.child({ requestId });
}

/**
 * Stamps `jobId` on every entry logged through the returned child logger.
 *
 * The worker role has one job context per BullMQ job it processes; wiring this into the worker
 * lifecycle belongs to the queue processor setup, not this module.
 */
export function forJob(logger: Logger, jobId: string): Logger {
  return logger.child({ jobId });
}
