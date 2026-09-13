/**
 * The Graph client's two non-obvious readings: the throttling headers, and what a 2xx whose body
 * will not parse means.
 *
 * Both were previously untested, and both were wrong in the same direction — quietly returning a
 * value that looked fine (`null` usage, `null as T` data) instead of the signal the caller needed.
 */

import { describe, expect, it } from 'vitest';
import { createGraphClient, GraphHttpError } from '#src/platforms/meta/graph-client.ts';
import type { AccountCredentialsRecord } from '#src/modules/platform-core/ports.ts';

const CREDENTIALS = {
  socialAccountId: 'acc-1',
  platform: 'instagram',
  authVariant: 'instagram_login',
  token: Buffer.from('token'),
} as unknown as AccountCredentialsRecord;

function clientReturning(body: string, headers: Record<string, string> = {}, status = 200) {
  const fetchImpl = (() =>
    Promise.resolve(new Response(body, { status, headers }))) as unknown as typeof fetch;
  return createGraphClient({ apiVersion: 'v23.0', fetchImpl });
}

describe('the flat X-App-Usage header', () => {
  it('is read rather than filtered away', async () => {
    // What an `instagram_login` account's app-level calls actually return (D28) — the shape that
    // used to be discarded entirely, leaving the throttling signal permanently absent.
    const client = clientReturning('{"id":"1"}', {
      'x-app-usage': '{"call_count":28,"total_cputime":25,"total_time":30}',
    });

    const response = await client.request(CREDENTIALS, 'GET', '/1', {});

    expect(response.usage).toEqual({ highestPercent: 30 });
  });
});

describe('usage headers', () => {
  it('reads the nested X-Business-Use-Case-Usage shape', async () => {
    const client = clientReturning('{"id":"1"}', {
      'x-business-use-case-usage':
        '{"17841400000000000":[{"call_count":12,"total_cputime":4,"total_time":9},' +
        '{"call_count":55,"total_cputime":1,"total_time":2}]}',
    });

    const response = await client.request(CREDENTIALS, 'GET', '/1', {});

    expect(response.usage).toEqual({ highestPercent: 55 });
  });

  it('prefers the business header when both are present', async () => {
    const client = clientReturning('{"id":"1"}', {
      'x-business-use-case-usage': '{"acct":[{"call_count":10}]}',
      'x-app-usage': '{"call_count":90}',
    });

    const response = await client.request(CREDENTIALS, 'GET', '/1', {});

    expect(response.usage).toEqual({ highestPercent: 10 });
  });

  it('reports no usage rather than guessing when the header will not parse', async () => {
    const client = clientReturning('{"id":"1"}', { 'x-app-usage': 'not json' });

    const response = await client.request(CREDENTIALS, 'GET', '/1', {});

    expect(response.usage).toBeNull();
  });

  it('reports no usage when no header was sent', async () => {
    const client = clientReturning('{"id":"1"}');

    const response = await client.request(CREDENTIALS, 'GET', '/1', {});

    expect(response.usage).toBeNull();
  });
});

describe('the usage sink', () => {
  it('reports the parsed reading with the account it belongs to', async () => {
    // The half of spec.md §8.2 that was missing: parsing existed, but nothing consumed the result,
    // so "under high usage, delay that account's jobs" had no path to a delay.
    const seen: { socialAccountId: string; percent: number }[] = [];
    const fetchImpl = (() =>
      Promise.resolve(
        new Response('{"id":"1"}', {
          status: 200,
          headers: { 'x-app-usage': '{"call_count":95}' },
        }),
      )) as unknown as typeof fetch;
    const client = createGraphClient({
      apiVersion: 'v23.0',
      fetchImpl,
      onUsage: (socialAccountId, usage) =>
        seen.push({ socialAccountId, percent: usage.highestPercent }),
    });

    await client.request(CREDENTIALS, 'GET', '/1', {});

    expect(seen).toEqual([{ socialAccountId: 'acc-1', percent: 95 }]);
  });

  it('stays silent when the response carried no usage header', async () => {
    // Silence matters: a reported zero would look like a fresh "this account is idle" reading and
    // keep overwriting a real one.
    const seen: unknown[] = [];
    const fetchImpl = (() =>
      Promise.resolve(new Response('{"id":"1"}', { status: 200 }))) as unknown as typeof fetch;
    const client = createGraphClient({
      apiVersion: 'v23.0',
      fetchImpl,
      onUsage: () => seen.push(1),
    });

    await client.request(CREDENTIALS, 'GET', '/1', {});

    expect(seen).toEqual([]);
  });
});

describe('a 2xx whose body will not parse', () => {
  it('raises instead of handing back a null result', async () => {
    // Returning `null as T` deferred the failure to whichever property the caller read next,
    // which surfaced as a TypeError and was then misreported as a transport failure.
    const client = clientReturning('<html>not json</html>');

    await expect(client.request(CREDENTIALS, 'GET', '/1', {})).rejects.toThrow(GraphHttpError);
  });
});

describe('an error response', () => {
  it('carries the status, body and headers through for the classifier', async () => {
    const client = clientReturning('{"error":{"code":190}}', { 'retry-after': '7' }, 401);

    const error = await client.request(CREDENTIALS, 'GET', '/1', {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GraphHttpError);
    expect((error as GraphHttpError).httpStatus).toBe(401);
    expect((error as GraphHttpError).body).toEqual({ error: { code: 190 } });
    expect((error as GraphHttpError).headers.get('retry-after')).toBe('7');
  });

  it('still raises when the error body itself is unparseable', async () => {
    const client = clientReturning('gateway timeout', {}, 504);

    const error = await client.request(CREDENTIALS, 'GET', '/1', {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GraphHttpError);
    expect((error as GraphHttpError).httpStatus).toBe(504);
    expect((error as GraphHttpError).body).toBeNull();
  });
});
