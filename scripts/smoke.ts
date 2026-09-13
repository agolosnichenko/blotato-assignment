/* oxlint-disable no-console -- this script's entire purpose is printing per-step pass/fail evidence
   to stdout for a human reviewer; every other script/module keeps no-console enabled. */
/**
 * Reviewer walkthrough (SC-012), run against a live deployment (T108).
 *
 * Automates `specs/001-multi-platform-comments/quickstart.md`'s "Reviewer walkthrough (SC-012)"
 * section step for step: platform capabilities, a post's conversation, a reply, polling it to
 * `posted`, the reply-depth check on both a platform that enforces it (Instagram) and one with
 * room to spare (Bluesky, D12), and a sync job. `openapi.json` is the authority on request and
 * response shapes. The pure assertions live in `scripts/smoke-checks.ts`.
 *
 * The Bluesky post drives steps 2-4 and 6 end to end: its step-3 reply (depth 1) is reused in step
 * 5 as the "reply to a reply" target, so the `202` case never depends on data already existing on
 * the account. The Instagram post only needs an existing reply (depth >= 1) for step 5's `422`
 * case — the depth check rejects the request before anything is posted, so no new Instagram
 * comment is created by that step.
 *
 * Usage:
 *   SMOKE_BASE_URL=... SMOKE_API_KEY=... SMOKE_INSTAGRAM_POST_ID=... SMOKE_BLUESKY_POST_ID=... \
 *     pnpm smoke
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import {
  assertDescendingOccurredAt,
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

const POLL_MAX_ATTEMPTS = 20;
const POLL_INTERVAL_MS = 1500;
const POLL_MAX_WALL_CLOCK_MS = 30_000;

/** One parsed HTTP response: status, headers and a JSON-or-null body. */
interface ApiResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
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
  const response = await fetch(new URL(path, env.SMOKE_BASE_URL), {
    method,
    headers: {
      'blotato-api-key': env.SMOKE_API_KEY,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const parsed = text.length === 0 ? null : JSON.parse(text);
  return { status: response.status, headers: response.headers, body: parsed };
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

async function stepConversation(env: SmokeEnv, postId: string): Promise<string> {
  const response = await callApi(env, 'GET', `/v1/posts/${postId}/comments`);
  if (response.status !== 200) {
    throw new SmokeFailure('2 conversation', '200', String(response.status), response.body);
  }
  const items = (response.body as { items: CommentRecord[] }).items;
  assertDescendingOccurredAt(items);
  const topLevel = items[0];
  if (topLevel === undefined) {
    throw new SmokeFailure('2 conversation', 'at least one comment', '0 comments');
  }
  logPass('2 conversation', `${items.length} comments, newest-first, top-level id ${topLevel.id}`);
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
  const step = '5 instagram depth';
  const topLevelId = await stepConversation(env, env.SMOKE_INSTAGRAM_POST_ID);
  const repliesResponse = await callApi(env, 'GET', `/v1/comments/${topLevelId}/replies`);
  const existingReply = (repliesResponse.body as { items: CommentRecord[] } | null)?.items[0];
  if (repliesResponse.status !== 200 || existingReply === undefined) {
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
  await stepCreateReply(env, '5 bluesky depth', replyCommentId);
}

async function stepSync(env: SmokeEnv, postId: string): Promise<void> {
  const step = '6 sync';
  const created = await callApi(env, 'POST', `/v1/posts/${postId}/comments/sync`);
  if (created.status !== 202) {
    throw new SmokeFailure(step, '202', String(created.status), created.body);
  }
  const jobId = (created.body as SyncJobRecord).id;

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

  const topLevelId = await stepConversation(env, env.SMOKE_BLUESKY_POST_ID);
  const replyId = await stepCreateReply(env, '3 create reply', topLevelId);
  await pollComment(env, '4 poll posted', replyId);

  await stepInstagramDepthExceeded(env);
  await stepBlueskyDepthAllowed(env, replyId);

  await stepSync(env, env.SMOKE_BLUESKY_POST_ID);

  console.log('\nAll smoke steps passed.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
