/* oxlint-disable no-console -- this script's whole purpose is printing the spike's findings and
   verdict to stdout; every other script/module keeps no-console enabled. */
/**
 * S2 — are Instagram comments readable under each login variant? (T070, spec.md §17, §8.2, D28,
 * research.md R-09)
 *
 * Runs the same `GET /{media-id}/comments` read twice against the same media, once per D28
 * variant:
 *
 *   - `facebook_login` — `graph.facebook.com`, the long-lived Page access token that also covers
 *     the linked IG professional account.
 *   - `instagram_login` — `graph.instagram.com`, a long-lived Instagram user token.
 *
 * §2.3 records the Meta forum reporting empty `data` for this call under Standard Access via
 * Instagram Login. An empty array with HTTP 200 is a *result* — the variant works but the account
 * has nothing to return, or Meta silently returns nothing under this access level — and this
 * script reports it as `0 comments (HTTP 200)`, distinct from an HTTP error, rather than treating
 * both as "it doesn't work". If neither variant returns data, IG stays fixture-tested and the live
 * demo relies on Facebook and Bluesky (§17) — that is a documented outcome of this spike, not a
 * failure of it.
 *
 * The raw response body from each call is saved verbatim under
 * `src/platforms/meta/__fixtures__/` (pretty-printed, structure untouched) — T097 replays them as
 * the two halves of one parameterized test, so they must be what Meta actually returned, including
 * fields not requested.
 *
 * Read-only: `GET /comments` never posts, edits or deletes anything.
 *
 * Usage:
 *   META_IG_MEDIA_ID=... META_FACEBOOK_LOGIN_TOKEN=... META_INSTAGRAM_LOGIN_TOKEN=... \
 *     pnpm tsx scripts/spikes/s2-instagram-comment-reads.ts
 *
 * See scripts/spikes/README.md for what each variable is and what to paste back.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_API_VERSION = 'v21.0';
const FIXTURES_DIR = path.join(import.meta.dirname, '../../src/platforms/meta/__fixtures__');
const COMMENT_FIELDS = 'id,text,timestamp,from,replies{id,text,timestamp,from}';

interface Variant {
  readonly name: 'facebook_login' | 'instagram_login';
  readonly host: string;
  readonly token: string;
  readonly fixtureFile: string;
}

interface CommentsResponse {
  readonly data?: unknown[];
}

interface GraphErrorBody {
  readonly error?: { readonly message?: string; readonly code?: number };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(
      `${name} is not set. See scripts/spikes/README.md for what it is and where to get it.`,
    );
  }
  return value;
}

function fingerprint(secret: string): string {
  return secret.length <= 8
    ? '*'.repeat(secret.length)
    : `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

function graphErrorMessage(body: unknown): string | undefined {
  return body !== null && typeof body === 'object' && 'error' in body
    ? (body as GraphErrorBody).error?.message
    : undefined;
}

interface VariantResult {
  readonly variant: Variant['name'];
  readonly status: number;
  readonly commentCount: number | null;
  readonly fixturePath: string;
}

/**
 * Reads one variant's comments, saves the raw body to its fixture file, and summarizes the
 * outcome.
 *
 * Raises:
 *   Error: If the request never reached Meta at all (DNS, connection refused, timeout) — a setup
 *     problem, not a spike result.
 */
async function readVariant(
  apiVersion: string,
  mediaId: string,
  variant: Variant,
): Promise<VariantResult> {
  const url = new URL(`https://${variant.host}/${apiVersion}/${mediaId}/comments`);
  url.search = new URLSearchParams({
    fields: COMMENT_FIELDS,
    access_token: variant.token,
  }).toString();

  const response = await fetch(url);
  const body: unknown = await response.json().catch(() => null);

  await mkdir(FIXTURES_DIR, { recursive: true });
  const fixturePath = path.join(FIXTURES_DIR, variant.fixtureFile);
  await writeFile(fixturePath, `${JSON.stringify(body, null, 2)}\n`, 'utf8');

  if (response.status !== 200) {
    console.log(
      `${variant.name}: HTTP ${response.status} — ${graphErrorMessage(body) ?? 'no message'} ` +
        `(raw body saved to ${fixturePath})`,
    );
    return { variant: variant.name, status: response.status, commentCount: null, fixturePath };
  }

  const commentCount = (body as CommentsResponse).data?.length ?? 0;
  console.log(
    `${variant.name}: HTTP 200, ${commentCount} comment(s) (raw body saved to ${fixturePath})`,
  );
  return { variant: variant.name, status: 200, commentCount, fixturePath };
}

function describe(result: VariantResult): string {
  return result.status === 200
    ? `${result.variant} → ${result.commentCount} comments (HTTP 200)`
    : `${result.variant} → HTTP ${result.status} error`;
}

async function main(): Promise<void> {
  const mediaId = requireEnv('META_IG_MEDIA_ID');
  const facebookLoginToken = requireEnv('META_FACEBOOK_LOGIN_TOKEN');
  const instagramLoginToken = requireEnv('META_INSTAGRAM_LOGIN_TOKEN');
  const apiVersion = process.env['META_GRAPH_API_VERSION'] ?? DEFAULT_API_VERSION;

  console.log(`Facebook Login token fingerprint: ${fingerprint(facebookLoginToken)}`);
  console.log(`Instagram Login token fingerprint: ${fingerprint(instagramLoginToken)}`);
  console.log('');

  const variants: Variant[] = [
    {
      name: 'facebook_login',
      host: 'graph.facebook.com',
      token: facebookLoginToken,
      fixtureFile: 's2-facebook-login-comments.json',
    },
    {
      name: 'instagram_login',
      host: 'graph.instagram.com',
      token: instagramLoginToken,
      fixtureFile: 's2-instagram-login-comments.json',
    },
  ];

  // The two variants are independent reads against unrelated hosts — run them concurrently.
  const results = await Promise.all(
    variants.map((variant) => readVariant(apiVersion, mediaId, variant)),
  );

  console.log('');
  const bothEmpty = results.every((result) => result.status === 200 && result.commentCount === 0);
  if (bothEmpty) {
    console.log(
      'Both variants returned HTTP 200 with 0 comments. Per §17, if this holds, IG stays ' +
        'fixture-tested and the live demo relies on Facebook and Bluesky — record that in ' +
        'DESIGN.md (T110), not as a failure of this spike.',
    );
  }

  console.log(`SPIKE S2 VERDICT: ${results.map((result) => describe(result)).join(', ')}`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
