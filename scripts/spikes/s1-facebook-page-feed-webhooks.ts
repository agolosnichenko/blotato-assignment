/* oxlint-disable no-console -- this script's whole purpose is printing the spike's findings and
   verdict to stdout; every other script/module keeps no-console enabled. */
/**
 * S1 — do Facebook Page `feed` comment webhooks arrive under Standard Access? (T070, spec.md §17,
 * §2.3, §8.2, research.md R-09)
 *
 * A script cannot receive a webhook, so this does not answer S1 on its own. It establishes the
 * two things that *are* checkable without one:
 *
 *   1. That the Page access token is valid, unexpired, issued to this app, and carries the
 *      `pages_manage_metadata` / `pages_show_list` scopes the subscription call needs
 *      (`GET /debug_token`).
 *   2. That the Page is actually subscribed to this app for the `feed` field
 *      (`GET /{page-id}/subscribed_apps`) — §8.2's `item=comment`, `verb=add|edited|remove` events
 *      ride on that field.
 *
 * What it cannot establish: whether a real comment from an ordinary user (not one with a role on
 * the app) triggers a delivery to the deployed endpoint. §2.3 records forum reports as
 * contradictory on exactly this point — that is the reason S1 exists. Confirming it requires
 * posting a real comment and watching the deployed webhook endpoint receive (or not receive) the
 * event; this script cannot do that and does not pretend to.
 *
 * Read-only: `debug_token` and `subscribed_apps` (GET) never change a subscription or post
 * anything.
 *
 * Usage:
 *   META_APP_ID=... META_APP_SECRET=... META_PAGE_ID=... META_PAGE_ACCESS_TOKEN=... \
 *     pnpm tsx scripts/spikes/s1-facebook-page-feed-webhooks.ts
 *
 * See scripts/spikes/README.md for what each variable is and what to paste back.
 */

import { reportFatal } from '../script-failure.ts';

const DEFAULT_API_VERSION = 'v21.0';
/** Node's `fetch` has no default socket timeout; without this a hung host stalls the spike. */
const REQUEST_TIMEOUT_MS = 10_000;
const REQUIRED_SCOPES = ['pages_manage_metadata', 'pages_show_list'];

interface DebugTokenData {
  readonly is_valid?: boolean;
  readonly app_id?: string;
  readonly expires_at?: number;
  readonly scopes?: string[];
}

interface DebugTokenResponse {
  readonly data?: DebugTokenData;
}

interface SubscribedApp {
  readonly id?: string;
  readonly subscribed_fields?: string[];
}

interface SubscribedAppsResponse {
  readonly data?: SubscribedApp[];
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

/** First and last four characters only — the full value must never reach a pasted report. */
function fingerprint(secret: string): string {
  return secret.length <= 8
    ? '*'.repeat(secret.length)
    : `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

/**
 * Calls one Graph API GET endpoint and returns its status and parsed body regardless of outcome.
 *
 * Raises:
 *   Error: If the request never reached Meta at all (DNS, connection refused, timeout) — that is
 *     a setup problem, not a spike result, so it is not folded into the return value.
 */
async function callGraph(url: URL): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const body: unknown = await response.json().catch(() => null);
  return { status: response.status, body };
}

function graphErrorMessage(body: unknown): string | undefined {
  return body !== null && typeof body === 'object' && 'error' in body
    ? (body as GraphErrorBody).error?.message
    : undefined;
}

async function checkTokenValidity(
  apiVersion: string,
  pageToken: string,
  appId: string,
  appSecret: string,
): Promise<DebugTokenData | null> {
  const url = new URL(`https://graph.facebook.com/${apiVersion}/debug_token`);
  url.search = new URLSearchParams({
    input_token: pageToken,
    access_token: `${appId}|${appSecret}`,
  }).toString();

  const { status, body } = await callGraph(url);
  if (status !== 200) {
    console.log(`debug_token: HTTP ${status} — ${graphErrorMessage(body) ?? 'no message'}`);
    return null;
  }
  const data = (body as DebugTokenResponse).data ?? null;
  console.log(
    `debug_token: is_valid=${String(data?.is_valid)} app_id=${data?.app_id ?? '(missing)'} ` +
      `scopes=${(data?.scopes ?? []).join(',') || '(none)'} ` +
      `expires_at=${data?.expires_at === undefined || data.expires_at === 0 ? 'never' : new Date(data.expires_at * 1000).toISOString()}`,
  );
  return data;
}

async function checkFeedSubscription(
  apiVersion: string,
  pageId: string,
  pageToken: string,
  appId: string,
): Promise<boolean | null> {
  const url = new URL(`https://graph.facebook.com/${apiVersion}/${pageId}/subscribed_apps`);
  url.search = new URLSearchParams({
    fields: 'subscribed_fields',
    access_token: pageToken,
  }).toString();

  const { status, body } = await callGraph(url);
  if (status !== 200) {
    console.log(`subscribed_apps: HTTP ${status} — ${graphErrorMessage(body) ?? 'no message'}`);
    return null;
  }
  const apps = (body as SubscribedAppsResponse).data ?? [];
  const ours = apps.find((app) => app.id === appId);
  const fields = ours?.subscribed_fields ?? [];
  console.log(
    `subscribed_apps: ${apps.length} app(s) subscribed to this page; ours (${appId}) has ` +
      `fields=${fields.join(',') || '(none)'}`,
  );
  return fields.includes('feed');
}

async function main(): Promise<void> {
  const appId = requireEnv('META_APP_ID');
  const appSecret = requireEnv('META_APP_SECRET');
  const pageId = requireEnv('META_PAGE_ID');
  const pageToken = requireEnv('META_PAGE_ACCESS_TOKEN');
  const apiVersion = process.env['META_GRAPH_API_VERSION'] ?? DEFAULT_API_VERSION;

  console.log(`Page access token fingerprint: ${fingerprint(pageToken)}`);
  console.log(`App secret fingerprint: ${fingerprint(appSecret)}`);
  console.log('');

  const tokenData = await checkTokenValidity(apiVersion, pageToken, appId, appSecret);
  const missingScopes = REQUIRED_SCOPES.filter(
    (scope) => !(tokenData?.scopes ?? []).includes(scope),
  );
  const tokenOk =
    tokenData?.is_valid === true && tokenData.app_id === appId && missingScopes.length === 0;

  const feedSubscribed = await checkFeedSubscription(apiVersion, pageId, pageToken, appId);

  console.log('');
  console.log(
    'Delivery of a real (non-role) user comment to the deployed endpoint is NOT established by ' +
      'this script — only posting a real comment and observing the endpoint can answer that.',
  );

  const verdict =
    tokenOk === true && feedSubscribed === true
      ? 'token valid + feed subscribed (delivery from real users still unverified — see note above)'
      : `token_valid=${String(tokenOk)} feed_subscribed=${String(feedSubscribed)} ` +
        `missing_scopes=${missingScopes.join(',') || '(none)'}`;
  console.log(`SPIKE S1 VERDICT: ${verdict}`);

  if (tokenOk !== true || feedSubscribed !== true) {
    // These two are setup preconditions, not findings: an invalid token or an unsubscribed Page
    // means the spike could not ask its question at all. Exiting zero made that indistinguishable
    // from a successful run for anything reading the exit code. What the spike genuinely cannot
    // establish — delivery from a real user — stays in the verdict line above and does not fail
    // the run.
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  reportFatal(error);
}
