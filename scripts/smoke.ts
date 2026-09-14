/* oxlint-disable no-console -- this script's entire purpose is printing per-step pass/fail evidence
   to stdout for a human reviewer; every other script/module keeps no-console enabled. */
/**
 * Reviewer walkthrough (SC-012), run against a live deployment (T108).
 *
 * Automates `specs/001-multi-platform-comments/quickstart.md`'s "Reviewer walkthrough (SC-012)"
 * section step for step, in the order `specs/002-flat-comment-listing/quickstart.md` V9 requires:
 * platform capabilities, the identifier-free workspace inbox (FR-015), a post's conversation, a
 * reply, polling it to `posted`, the reply-depth check on both a platform that enforces it
 * (Instagram) and one with room to spare (Bluesky, D12), and a sync job. `openapi.json` is the
 * authority on request and response shapes. The pure assertions live in `scripts/smoke-checks.ts`.
 *
 * The Bluesky post drives steps 3-5 and 7 end to end: its step-4 reply (depth 1) is reused in step
 * 6 as the "reply to a reply" target, so the `202` case never depends on data already existing on
 * the account. The Instagram post only needs an existing reply (depth >= 1) for step 6's `422`
 * case — the depth check rejects the request before anything is posted, so no new Instagram
 * comment is created by that step.
 *
 * Usage:
 *   SMOKE_BASE_URL=... SMOKE_API_KEY=... SMOKE_INSTAGRAM_POST_ID=... SMOKE_BLUESKY_POST_ID=... \
 *     pnpm smoke
 */
// oxlint-disable max-lines -- one end-to-end walkthrough, whose steps run in a fixed order and
// share the seeded state each previous step leaves behind. Splitting it across files would hide that
// ordering, which is the script's only real structure.

import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import {
  assertDescendingOccurredAt,
  assertInboxHasNoSyncBlock,
  assertPlatformsCapabilities,
  commentPollOutcome,
  isReplyDepthExceededProblem,
  parseSmokeEnv,
  SmokeFailure,
  syncJobPollOutcome,
  type CommentRecord,
  type PlatformCapability,
  type SmokeEnv,
  type SyncJobRecord,
} from './smoke-checks.ts';
import { reportFatal } from './script-failure.ts';

const POLL_MAX_ATTEMPTS = 20;
const POLL_INTERVAL_MS = 1500;
const POLL_MAX_WALL_CLOCK_MS = 30_000;
/**
 * Per-request deadline.
 *
 * Node's `fetch` has no default socket timeout, so a deployment that accepts the connection and
 * never answers hangs this script forever. The poll budgets above bound the *loops*, not a single
 * request — without this a stuck deploy is reported by CI as a job timeout, with no output after
 * the last PASS line and nothing saying which call hung.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/** One parsed HTTP response: status, headers and a JSON-or-null body. */
interface ApiResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
}

function parseBody(text: string): unknown {
  if (text.length === 0) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Calls the deployment's REST API. Never logs the API key.
 *
 * Args:
 *   env: The validated smoke-test environment.
 *   method: HTTP method.
 *   path: Request path, relative to `env.SMOKE_BASE_URL`.
 *   body: Optional JSON request body.
 *
 * Returns:
 *   The response's status, headers, and parsed body (`null` for an empty body).
 */
async function callApi(
  env: SmokeEnv,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse> {
  const url = new URL(path, env.SMOKE_BASE_URL);
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        'blotato-api-key': env.SMOKE_API_KEY,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // Named so the failure says which call hung, rather than surfacing as a bare AbortError.
    throw new SmokeFailure(
      `${method} ${path}`,
      `a response within ${REQUEST_TIMEOUT_MS}ms`,
      error instanceof Error ? error.name : 'a transport failure',
    );
  }
  const text = await response.text();
  // Not every response on this path comes from the service: a platform proxy answering 502 sends
  // HTML, and `JSON.parse` would then throw a bare SyntaxError that loses the status — the one
  // fact a smoke failure exists to report. The undecodable body is carried through as a string so
  // the failing step still prints it as evidence.
  return { status: response.status, headers: response.headers, body: parseBody(text) };
}

function smokeCommentText(): string {
  const timestamp = new Date().toISOString();
  return `[smoke-test] automated T108 reviewer walkthrough artifact, posted ${timestamp}`;
}

function logPass(step: string, detail: string): void {
  console.log(`PASS ${step}: ${detail}`);
}

async function stepPlatforms(env: SmokeEnv): Promise<void> {
  const response = await callApi(env, 'GET', '/v1/platforms');
  if (response.status !== 200) {
    throw new SmokeFailure('1 platforms', '200', String(response.status), response.body);
  }
  const items = (response.body as { items: PlatformCapability[] }).items;
  assertPlatformsCapabilities(items);
  logPass('1 platforms', `${items.length} platforms, 3 comment-capable`);
}

/** FR-015: the first comment read names no identifier — `GET /v1/comments` with no filters. */
async function stepInbox(env: SmokeEnv): Promise<void> {
  const step = '2 inbox';
  const response = await callApi(env, 'GET', '/v1/comments');
  if (response.status !== 200) {
    throw new SmokeFailure(step, '200', String(response.status), response.body);
  }
  const body = response.body as { items?: CommentRecord[] };
  const items = body.items;
  // An empty page satisfies `assertDescendingOccurredAt` vacuously, printing PASS over exactly the
  // regressions this step catches. Step 3 needs a comment here anyway, so requiring one is free.
  if (items === undefined || items.length === 0) {
    throw new SmokeFailure(step, 'at least one comment', 'an empty page', response.body);
  }
  assertDescendingOccurredAt(items);
  assertInboxHasNoSyncBlock(response.body);
  logPass(step, `${items.length} comments across the workspace, newest-first, no sync block`);
}

/** `step` is a parameter because step 6 reads a conversation too, and a line labelled "3
 * conversation" while step 6 is running would misreport which check passed. */
async function stepConversation(env: SmokeEnv, step: string, postId: string): Promise<string> {
  const response = await callApi(env, 'GET', `/v1/comments?postId=${postId}&topLevelOnly=true`);
  if (response.status !== 200) {
    throw new SmokeFailure(step, '200', String(response.status), response.body);
  }
  const items = (response.body as { items: CommentRecord[] }).items;
  assertDescendingOccurredAt(items);
  const topLevel = items[0];
  if (topLevel === undefined) {
    throw new SmokeFailure(step, 'at least one comment', '0 comments');
  }
  logPass(step, `${items.length} comments, newest-first, top-level id ${topLevel.id}`);
  return topLevel.id;
}

async function stepCreateReply(env: SmokeEnv, step: string, parentId: string): Promise<string> {
  const response = await callApi(env, 'POST', `/v1/comments/${parentId}/replies`, {
    text: smokeCommentText(),
  });
  const status = (response.body as { status?: unknown } | null)?.status;
  const location = response.headers.get('location');
  if (response.status !== 202 || status !== 'queued' || location === null) {
    const actual = `${response.status} ${String(status)}`;
    throw new SmokeFailure(step, '202 queued with Location', actual, response.body);
  }
  const id = (response.body as { id: string }).id;
  logPass(step, `queued reply ${id}, Location ${location}`);
  return id;
}

async function pollComment(env: SmokeEnv, step: string, commentId: string): Promise<void> {
  const deadline = Date.now() + POLL_MAX_WALL_CLOCK_MS;
  for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS && Date.now() < deadline; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each attempt needs the last one's result first.
    const response = await callApi(env, 'GET', `/v1/comments/${commentId}`);
    if (response.status !== 200) {
      throw new SmokeFailure(step, '200', String(response.status), response.body);
    }
    const comment = response.body as CommentRecord;
    const outcome = commentPollOutcome(comment.status);
    if (outcome === 'posted') {
      logPass(step, `comment ${commentId} posted after ${attempt} attempt(s)`);
      return;
    }
    if (outcome === 'failed') {
      throw new SmokeFailure(step, 'status posted', 'status failed', comment.error);
    }
    // oxlint-disable-next-line no-await-in-loop -- bounded poll backoff, inherently sequential.
    await sleep(POLL_INTERVAL_MS);
  }
  throw new SmokeFailure(step, 'status posted within poll budget', 'still not posted');
}

async function stepInstagramDepthExceeded(env: SmokeEnv): Promise<void> {
  const step = '6 instagram depth';
  const topLevelId = await stepConversation(env, step, env.SMOKE_INSTAGRAM_POST_ID);
  const repliesResponse = await callApi(
    env,
    'GET',
    `/v1/comments?parentCommentId=${topLevelId}&order=asc`,
  );
  // Status first: `parseBody` deliberately hands back a raw string for a non-JSON response (a
  // proxy's HTML 502), and reaching into `.items[0]` on that threw a TypeError *before* this
  // check ran — losing the status and body that are the whole point of a smoke failure.
  if (repliesResponse.status !== 200) {
    throw new SmokeFailure(step, '200', String(repliesResponse.status), repliesResponse.body);
  }
  const existingReply = (repliesResponse.body as { items?: CommentRecord[] } | null)?.items?.[0];
  if (existingReply === undefined) {
    const expected = 'an existing reply to reply to';
    throw new SmokeFailure(step, expected, 'no reply found', repliesResponse.body);
  }
  const response = await callApi(env, 'POST', `/v1/comments/${existingReply.id}/replies`, {
    text: smokeCommentText(),
  });
  if (!isReplyDepthExceededProblem(response.status, response.body)) {
    const expected = '422 REPLY_DEPTH_EXCEEDED';
    throw new SmokeFailure(step, expected, String(response.status), response.body);
  }
  logPass(step, `reply to reply ${existingReply.id} rejected with REPLY_DEPTH_EXCEEDED`);
}

async function stepBlueskyDepthAllowed(env: SmokeEnv, replyCommentId: string): Promise<void> {
  await stepCreateReply(env, '6 bluesky depth', replyCommentId);
}

async function stepSync(env: SmokeEnv, postId: string): Promise<void> {
  const step = '7 sync';
  const created = await callApi(env, 'POST', `/v1/posts/${postId}/comments/sync`);
  if (created.status !== 202) {
    throw new SmokeFailure(step, '202', String(created.status), created.body);
  }
  const jobId = (created.body as Partial<SyncJobRecord> | null)?.id;
  if (typeof jobId !== 'string') {
    // Without this the cast yields `undefined` and the poll below spends its whole 30-second
    // budget asking for `/v1/comment-sync-jobs/undefined`, then reports a timeout instead of the
    // malformed response that actually caused it.
    throw new SmokeFailure(step, 'a sync job id in the response', 'none', created.body);
  }

  const deadline = Date.now() + POLL_MAX_WALL_CLOCK_MS;
  for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS && Date.now() < deadline; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each attempt needs the last one's result first.
    const response = await callApi(env, 'GET', `/v1/comment-sync-jobs/${jobId}`);
    if (response.status !== 200) {
      throw new SmokeFailure(step, '200', String(response.status), response.body);
    }
    const job = response.body as SyncJobRecord;
    const outcome = syncJobPollOutcome(job.status);
    if (outcome === 'succeeded') {
      const stats = JSON.stringify(job.stats);
      logPass(step, `job ${jobId} succeeded after ${attempt} attempt(s): ${stats}`);
      return;
    }
    if (outcome === 'failed') {
      throw new SmokeFailure(step, 'status succeeded', 'status failed', job.error);
    }
    // oxlint-disable-next-line no-await-in-loop -- bounded poll backoff, inherently sequential.
    await sleep(POLL_INTERVAL_MS);
  }
  throw new SmokeFailure(step, 'status succeeded within poll budget', 'still not succeeded');
}

async function main(): Promise<void> {
  const env = parseSmokeEnv();

  await stepPlatforms(env);
  await stepInbox(env);

  const topLevelId = await stepConversation(env, '3 conversation', env.SMOKE_BLUESKY_POST_ID);
  const replyId = await stepCreateReply(env, '4 create reply', topLevelId);
  await pollComment(env, '5 poll posted', replyId);

  await stepInstagramDepthExceeded(env);
  await stepBlueskyDepthAllowed(env, replyId);

  await stepSync(env, env.SMOKE_BLUESKY_POST_ID);

  console.log('\nAll smoke steps passed.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await main();
  } catch (error) {
    reportFatal(error);
  }
}
