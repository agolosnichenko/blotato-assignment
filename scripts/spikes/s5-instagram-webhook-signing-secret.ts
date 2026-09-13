/* oxlint-disable no-console -- this script's whole purpose is printing the spike's findings and
   verdict to stdout; every other script/module keeps no-console enabled. */
/**
 * S5 — which secret signs webhook deliveries for the `instagram_login` variant? (T070, spec.md
 * §17, §2.3, D28, research.md R-09)
 *
 * The verifier must carry both `META_APP_SECRET` and `META_APP_SECRET_INSTAGRAM` (.env.example)
 * because the two are candidates for signing an Instagram Login delivery's `X-Hub-Signature-256`
 * header, and only a captured real delivery can settle which one it is — the answer cannot be
 * derived from documentation, only observed.
 *
 * This script takes that captured delivery as input rather than inventing one: the exact raw
 * request body Meta sent (byte-for-byte — HMAC is sensitive to re-serialization) and the
 * `X-Hub-Signature-256` header value that came with it. It computes `hmac-sha256(body)` under
 * each configured secret and reports which one produces the signature Meta sent, using a
 * constant-time comparison (`secureCompare` from `src/shared/crypto.ts` — the same helper
 * `src/modules/comments/http/auth.ts` uses for its own secret comparison; the webhook verifier
 * this spike gates does not exist yet).
 *
 * Read-only: this only hashes local input; it makes no request to Meta at all.
 *
 * Usage:
 *   META_APP_SECRET=... META_APP_SECRET_INSTAGRAM=... \
 *     pnpm tsx scripts/spikes/s5-instagram-webhook-signing-secret.ts \
 *     --body-file <path to the exact raw request body> \
 *     --signature <the X-Hub-Signature-256 header value, with or without the "sha256=" prefix>
 *
 * See scripts/spikes/README.md for how to capture a delivery and what to paste back.
 */

import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { secureCompare } from '#src/shared/crypto.ts';
import { reportFatal } from '../script-failure.ts';

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

interface CliArgs {
  readonly bodyFile: string;
  readonly signature: string;
}

function parseCliArgs(argv: string[]): CliArgs {
  const usage =
    'Usage: pnpm tsx scripts/spikes/s5-instagram-webhook-signing-secret.ts ' +
    '--body-file <path> --signature <X-Hub-Signature-256 value>';

  const { values } = parseArgs({
    args: argv,
    options: { 'body-file': { type: 'string' }, signature: { type: 'string' } },
  });

  const bodyFile = values['body-file'];
  if (bodyFile === undefined) {
    throw new Error(`--body-file is required.\n${usage}`);
  }
  const signature = values.signature;
  if (signature === undefined) {
    throw new Error(`--signature is required.\n${usage}`);
  }
  return { bodyFile, signature };
}

/** Strips the `sha256=` prefix Meta sends the header with, if present. */
function normalizeSignature(headerValue: string): string {
  return headerValue.startsWith('sha256=') ? headerValue.slice('sha256='.length) : headerValue;
}

interface SecretCandidate {
  readonly envVar: string;
  readonly value: string;
}

function signatureMatches(rawBody: Buffer, expectedHex: string, secret: string): boolean {
  const digest = createHmac('sha256', secret).update(rawBody).digest('hex');
  return secureCompare(digest, expectedHex);
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const candidates: SecretCandidate[] = [
    { envVar: 'META_APP_SECRET', value: requireEnv('META_APP_SECRET') },
    { envVar: 'META_APP_SECRET_INSTAGRAM', value: requireEnv('META_APP_SECRET_INSTAGRAM') },
  ];

  for (const candidate of candidates) {
    console.log(`${candidate.envVar} fingerprint: ${fingerprint(candidate.value)}`);
  }

  const rawBody = await readFile(args.bodyFile);
  const expectedHex = normalizeSignature(args.signature.trim());
  if (!/^[0-9a-f]+$/iu.test(expectedHex)) {
    throw new Error(
      `--signature does not look like hex after stripping "sha256=": got "${args.signature}". ` +
        'Paste the exact X-Hub-Signature-256 header value.',
    );
  }

  console.log('');
  console.log(`Raw body: ${rawBody.length} bytes read from ${args.bodyFile}`);
  console.log(`Signature to match (fingerprint): ${fingerprint(expectedHex)}`);
  console.log('');

  const matches = candidates.filter((candidate) =>
    signatureMatches(rawBody, expectedHex, candidate.value),
  );

  for (const candidate of candidates) {
    const isMatch = matches.some((match) => match.envVar === candidate.envVar);
    console.log(`${candidate.envVar}: ${isMatch ? 'MATCH' : 'no match'}`);
  }

  console.log('');
  const verdict =
    matches.length === 1
      ? `signature matches ${matches[0]?.envVar} only`
      : matches.length === 0
        ? 'signature matches neither configured secret — capture may be stale or truncated'
        : `signature matches ${matches.map((match) => match.envVar).join(' and ')} (unexpected — the two secrets are equal)`;
  console.log(`SPIKE S5 VERDICT: ${verdict}`);
}

try {
  await main();
} catch (error) {
  reportFatal(error);
}
