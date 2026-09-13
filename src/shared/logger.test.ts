import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, forJob, forRequest } from '#src/shared/logger.ts';
import type { Config } from '#src/app/config.ts';

const config = { LOG_LEVEL: 'info' } as Config;

function captureLogLines(): { destination: Writable; lines: () => unknown[] } {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return {
    destination,
    lines: () => chunks.map((chunk) => JSON.parse(chunk) as unknown),
  };
}

describe('createLogger redaction', () => {
  it('redacts the blotato-api-key header', () => {
    const { destination, lines } = captureLogLines();
    const logger = createLogger(config, {}, destination);

    logger.info({ req: { headers: { 'blotato-api-key': 'secret-key' } } }, 'request received');

    const [entry] = lines() as [{ req: { headers: Record<string, string> } }];
    expect(entry.req.headers['blotato-api-key']).toBe('[redacted]');
  });

  it('redacts comment text nested inside a request body', () => {
    const { destination, lines } = captureLogLines();
    const logger = createLogger(config, {}, destination);

    logger.info({ req: { body: { text: 'hello world' } } }, 'request received');

    const [entry] = lines() as [{ req: { body: { text: string } } }];
    expect(entry.req.body.text).toBe('[redacted]');
  });
});

describe('createLogger redaction, deeper nesting', () => {
  it('redacts comment text nested inside job data two levels deep', () => {
    const { destination, lines } = captureLogLines();
    const logger = createLogger(config, {}, destination);

    logger.info({ job: { data: { text: 'hello world' } } }, 'processing job');

    const [entry] = lines() as [{ job: { data: { text: string } } }];
    expect(entry.job.data.text).toBe('[redacted]');
  });

  it('redacts platform credentials from an adapter payload', () => {
    const { destination, lines } = captureLogLines();
    const logger = createLogger(config, {}, destination);

    logger.info(
      { account: { credentials: { accessToken: 'super-secret' } } },
      'calling platform api',
    );

    const [entry] = lines() as [{ account: { credentials: unknown } }];
    expect(entry.account.credentials).toBe('[redacted]');
  });

  it('leaves unrelated fields untouched', () => {
    const { destination, lines } = captureLogLines();
    const logger = createLogger(config, {}, destination);

    logger.info({ req: { body: { platform: 'bluesky' } } }, 'request received');

    const [entry] = lines() as [{ req: { body: { platform: string } } }];
    expect(entry.req.body.platform).toBe('bluesky');
  });
});

describe('createLogger redaction, depths beyond two levels', () => {
  it('redacts comment text nested inside job data three levels deep', () => {
    const { destination, lines } = captureLogLines();
    const logger = createLogger(config, {}, destination);

    logger.info({ job: { data: { comment: { text: 'hello world' } } } }, 'processing job');

    const [entry] = lines() as [{ job: { data: { comment: { text: string } } } }];
    expect(entry.job.data.comment.text).toBe('[redacted]');
  });

  it('redacts comment text inside a page of comments four levels deep', () => {
    const { destination, lines } = captureLogLines();
    const logger = createLogger(config, {}, destination);

    logger.info(
      { result: { page: { comments: [{ text: 'hello world' }] } } },
      'sync walk complete',
    );

    const [entry] = lines() as [{ result: { page: { comments: [{ text: string }] } } }];
    expect(entry.result.page.comments[0]?.text).toBe('[redacted]');
  });
});

describe('context stamping', () => {
  it('stamps requestId on every entry from a request-scoped logger', () => {
    const { destination, lines } = captureLogLines();
    const logger = createLogger(config, {}, destination);

    forRequest(logger, 'req-123').info('handling request');

    const [entry] = lines() as [{ requestId: string }];
    expect(entry.requestId).toBe('req-123');
  });

  it('stamps jobId on every entry from a job-scoped logger', () => {
    const { destination, lines } = captureLogLines();
    const logger = createLogger(config, {}, destination);

    forJob(logger, 'job-456').info('processing job');

    const [entry] = lines() as [{ jobId: string }];
    expect(entry.jobId).toBe('job-456');
  });
});
