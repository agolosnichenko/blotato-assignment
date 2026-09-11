import { pino, type Logger } from 'pino';
import type { Config } from '#src/app/config.ts';

const REDACTED_PATHS = [
  'req.headers["blotato-api-key"]',
  'req.headers.authorization',
  'req.headers.cookie',
];

export function createLogger(config: Config, bindings: Record<string, string> = {}): Logger {
  return pino({
    level: config.LOG_LEVEL,
    base: bindings,
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
  });
}
