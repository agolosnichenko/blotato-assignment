/**
 * The `webhook-process` BullMQ worker (T081, §7.2 steps 2-4, concurrency 10).
 *
 * Wires `webhook-normalizer.ts`'s `WebhookNormalizer` to `ingest-comments.ts`'s shared upsert/
 * delete path — the one place a Meta webhook delivery and a sync walk converge on the same row
 * per `(social_account_id, platform_comment_id)` (that file's own docstring). This worker adds no
 * second upsert/delete logic of its own; its job is turning one stored `webhook_deliveries` row
 * into the `AccountContext`/`IngestTarget` that path needs, plus the four decisions specific to
 * this channel:
 *
 *   1. **Every matching account, not just one** (spec.md §18 "`Accounts.listByPlatformAccount`").
 *      `social_accounts` carries no uniqueness on `(platform, platform_account_id)`: two
 *      workspaces may legitimately connect the same Page, and a delivery concerns both. This
 *      worker ingests the event once per account `listByPlatformAccount` returns, never just the
 *      first — the dedup key `UNIQUE (social_account_id, platform_comment_id)` keeps the
 *      resulting rows apart without any extra guard here.
 *   2. **Unknown account → processed, not retried** (§7.2 step 2). An *empty* list — the recorded
 *      S1 dashboard test send is exactly this case — can never succeed no matter how many times
 *      the delivery is retried; marking it processed after a warning log is what stops it from
 *      burning the queue for 36 hours (Meta's own redelivery window).
 *   3. **An incomplete event is completed before it ever reaches `ingestComments.upsert`** (A18).
 *      `webhook-normalizer.ts`'s `comment: undefined` means the raw payload omitted `text` or
 *      author identity — this worker calls `adapter.fetchComment` for exactly that case, and a
 *      `null` result (the comment is already gone) is handled as "nothing to ingest", never as an
 *      empty comment to store. `ingest-comments.ts`'s own `DO UPDATE SET text = coalesce(...)`
 *      protects an *update*; there is no stored row yet for a first-seen thin payload to fall back
 *      on, which is why this completion has to happen here, before the upsert, not inside it. Each
 *      matching account's adapter call is independent (a thin payload is completed once per
 *      account, since each may hold a different credential for the same platform id).
 *   4. **The internal `postId`, if any, is resolved from `comment_sync_targets`** — this table is
 *      owned by this module (`schema.ts`), so reading it directly is not the "no query of your
 *      own" violation D8/D29 forbids for *platform-core* tables (Principle II). Passing
 *      `postId: null` unconditionally, the way a never-seen post legitimately does, would silently
 *      drop the `post_id` association for a comment arriving by webhook on a post this service
 *      *did* publish — `ingest-comments.ts` trusts whatever `IngestTarget.postId` it is given
 *      verbatim, it does not re-derive it.
 *   5. **An `AuthError` for one account is that account's own terminal outcome, never a retry of
 *      the whole delivery** (D30, spec.md §18 "An undecryptable credential is an `AuthError`").
 *      It can surface two ways: `AccountCredentials.findBySocialAccountId` now raises it when the
 *      stored token will not decrypt (a botched key rotation, a corrupted row), and
 *      `adapter.fetchComment` raises it on a 401/403 while completing a thin payload (point 3).
 *      Either way, `processEventForAccount` catches it, records `account_health` plus outbox
 *      `account.auth_failed` (never a write to `social_accounts`, D8/D29), logs, and returns —
 *      the same classification `publish-comment.ts`'s `settleAuthFailed` and `sync-post.ts`'s
 *      `recordAuthFailure` already give it. Crucially this is caught *per account*, inside the
 *      fan-out loop (point 1), not around the whole delivery: one account's bad credential must
 *      not abandon another workspace's otherwise-good ingestion of the same delivery. Because the
 *      failure is recorded rather than rethrown, the delivery still reaches `markProcessed` at the
 *      end — an `AuthError` is exactly as unretryable as an unknown account (point 2), so leaving
 *      `processed_at` null here would only requeue a delivery no later attempt can resolve either.
 *      Any *other* exception (a database error, a transport failure, anything not classified as
 *      `AuthError`) still propagates uncaught out of the job processor: `processed_at` stays
 *      `null`, BullMQ retries the job under its own backoff, and the T082 sweeper is a second,
 *      independent backstop if the job itself is lost rather than merely slow. Re-running an
 *      account that already succeeded on a retried delivery is safe — `ingestComments.upsert`'s
 *      `ON CONFLICT DO UPDATE` is idempotent either way.
 */

// oxlint-disable max-dependencies, max-lines -- this worker wires every port `ingest-comments.ts`
// needs to build an `AccountContext` and an adapter (accounts, credentials, the Meta adapter
// registry) plus the normalizer and BullMQ itself, and covers the full delivery->event->ingest
// pipeline end to end (module docstring); splitting the file would not reduce any of that, only
// hide it behind re-exports.

import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { Config } from '#src/app/config.ts';
import type {
  IngestComments,
  IngestedComment,
  IngestTarget,
} from '#src/modules/comments/application/ingest-comments.ts';
import {
  createAccountHealth,
  type AccountHealth,
} from '#src/modules/comments/infrastructure/account-health.ts';
import { appendToOutbox } from '#src/modules/comments/infrastructure/outbox.ts';
import {
  commentSyncTargets,
  webhookDeliveries,
} from '#src/modules/comments/infrastructure/schema.ts';
import { createFacebookAdapter } from '#src/platforms/meta/facebook-adapter.ts';
import { createInstagramAdapter } from '#src/platforms/meta/instagram-adapter.ts';
import type {
  WebhookIngestionEvent,
  WebhookNormalizer,
} from '#src/platforms/meta/webhook-normalizer.ts';
import type {
  AccountCredentials,
  Accounts,
  SocialAccountRecord,
} from '#src/modules/platform-core/ports.ts';
import {
  AuthError,
  type AccountContext,
  type CommentPlatformAdapter,
} from '#src/platforms/types.ts';
import { forJob } from '#src/shared/logger.ts';
import { JOB_NAMES, QUEUE_NAMES } from '#src/shared/queues.ts';

const WORKER_CONCURRENCY = 10;

export interface WebhookWorkerDeps {
  readonly database: NodePgDatabase;
  readonly redis: Redis;
  readonly config: Config;
  readonly accounts: Accounts;
  readonly accountCredentials: AccountCredentials;
  readonly ingestComments: IngestComments;
  readonly normalizer: WebhookNormalizer;
  readonly logger: Logger;
}

/** Only the two webhook fields this port covers (§8.2) need an adapter — never Bluesky. */
type MetaPlatform = 'instagram' | 'facebook';
type MetaAdapterRegistry = Record<MetaPlatform, CommentPlatformAdapter>;

function buildMetaAdapterRegistry(config: Config): MetaAdapterRegistry {
  return {
    instagram: createInstagramAdapter({ apiVersion: config.META_GRAPH_API_VERSION }),
    facebook: createFacebookAdapter({ apiVersion: config.META_GRAPH_API_VERSION }),
  };
}

interface DeliveryRow {
  readonly id: string;
  readonly payload: Record<string, unknown>;
}

async function loadDelivery(db: NodePgDatabase, deliveryId: string): Promise<DeliveryRow | null> {
  const [row] = await db
    .select({ id: webhookDeliveries.id, payload: webhookDeliveries.payload })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.id, deliveryId))
    .limit(1);
  return row ?? null;
}

async function markProcessed(db: NodePgDatabase, deliveryId: string): Promise<void> {
  await db
    .update(webhookDeliveries)
    .set({ processedAt: new Date() })
    .where(eq(webhookDeliveries.id, deliveryId));
}

/**
 * The internal `postId` for `(socialAccountId, platformPostId)`, if this service has seen this
 * post before (via `PostPublished` or an earlier comment) — `comment_sync_targets` is this
 * module's own table (module docstring, point 3), queried directly rather than through
 * `SyncTargetRepository`, which exposes no lookup by platform post id. `null` when no target
 * exists yet: the post is genuinely external, and `ingest-comments.ts`'s own
 * `ensureSyncTargetIfExternal` creates the row.
 */
async function resolvePostId(
  db: NodePgDatabase,
  socialAccountId: string,
  platformPostId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ postId: commentSyncTargets.postId })
    .from(commentSyncTargets)
    .where(
      and(
        eq(commentSyncTargets.socialAccountId, socialAccountId),
        eq(commentSyncTargets.platformPostId, platformPostId),
      ),
    )
    .limit(1);
  return row?.postId ?? null;
}

/**
 * Builds one account's `AccountContext`, or raises `AuthError` if its credential will not decrypt
 * (module docstring point 5) — the caller's job to record and skip, never this function's.
 * Credentials missing *entirely* for a known account is a different, local data problem (the two
 * rows are supposed to be written together), so that case still throws a plain `Error`.
 */
async function buildAccountContext(
  deps: WebhookWorkerDeps,
  account: SocialAccountRecord,
  event: WebhookIngestionEvent,
): Promise<AccountContext> {
  const credentials = await deps.accountCredentials.findBySocialAccountId(account.id);
  if (!credentials.found) {
    throw new Error(`webhook-worker: social account ${account.id} has no credentials row`);
  }
  return {
    workspaceId: account.workspaceId,
    socialAccountId: account.id,
    platform: event.platform,
    platformAccountId: event.platformAccountId,
    credentials: credentials.value,
  };
}

/**
 * D30: records an `AuthError` against `account.id` the same way `publish-comment.ts`'s
 * `settleAuthFailed` and `sync-post.ts`'s `recordAuthFailure` already do — outbox first (inside
 * its own transaction), then `account_health` (`AccountHealth.markAuthFailed` does not accept a
 * transaction handle to join) — never a write to `social_accounts` (D8, D29, Principle II).
 */
async function recordAuthFailure(
  deps: WebhookWorkerDeps,
  accountHealth: AccountHealth,
  account: Pick<SocialAccountRecord, 'id' | 'workspaceId'>,
  reason: string,
): Promise<void> {
  await deps.database.transaction((tx) =>
    appendToOutbox(tx, {
      workspaceId: account.workspaceId,
      type: 'account.auth_failed',
      aggregateId: account.id,
      data: { socialAccountId: account.id, reason },
    }),
  );
  await accountHealth.markAuthFailed({
    socialAccountId: account.id,
    workspaceId: account.workspaceId,
    reason,
  });
}

/**
 * Resolves one `upsert` event's comment data (A18, module docstring point 2): the payload's own
 * data if it was complete, or `adapter.fetchComment`'s result if it was thin. `null` means the
 * comment no longer exists on the platform — nothing for the caller to ingest.
 */
async function resolveIngestedComment(
  adapter: CommentPlatformAdapter,
  ctx: AccountContext,
  event: Extract<WebhookIngestionEvent, { type: 'upsert' }>,
): Promise<IngestedComment | null> {
  if (event.comment !== undefined) {
    const { comment } = event;
    return {
      platformCommentId: event.platformCommentId,
      platformParentId: event.platformParentId,
      authorPlatformId: comment.authorPlatformId,
      authorUsername: comment.authorUsername,
      authorDisplayName: comment.authorDisplayName,
      text: comment.text,
      platformCreatedAt: comment.platformCreatedAt,
      platformMeta: comment.platformMeta,
      isOwn: comment.authorPlatformId === ctx.platformAccountId,
    };
  }

  const fetched = await adapter.fetchComment(ctx, event.platformCommentId);
  if (fetched === null) {
    return null;
  }
  return {
    platformCommentId: fetched.platformCommentId,
    platformParentId: fetched.platformParentId,
    authorPlatformId: fetched.authorPlatformId,
    authorUsername: fetched.authorUsername,
    authorDisplayName: fetched.authorDisplayName,
    text: fetched.text,
    platformCreatedAt: fetched.platformCreatedAt,
    platformMeta: fetched.platformMeta,
    isOwn: fetched.authorPlatformId === ctx.platformAccountId,
  };
}

async function processUpsert(
  deps: WebhookWorkerDeps,
  adapters: MetaAdapterRegistry,
  ctx: AccountContext,
  event: Extract<WebhookIngestionEvent, { type: 'upsert' }>,
  jobLogger: Logger,
): Promise<void> {
  const adapter = adapters[event.platform as MetaPlatform];
  const comment = await resolveIngestedComment(adapter, ctx, event);
  if (comment === null) {
    jobLogger.debug(
      { platformCommentId: event.platformCommentId },
      'webhook-worker: thin payload completed to nothing, comment no longer exists',
    );
    return;
  }

  const postId = await resolvePostId(deps.database, ctx.socialAccountId, event.platformPostId);
  const target: IngestTarget = {
    workspaceId: ctx.workspaceId,
    socialAccountId: ctx.socialAccountId,
    platform: event.platform,
    postId,
    platformPostId: event.platformPostId,
  };

  await deps.ingestComments.upsert({ target, comment, ingestionSource: 'webhook', ctx, adapter });
}

async function processDelete(
  deps: WebhookWorkerDeps,
  ctx: AccountContext,
  event: Extract<WebhookIngestionEvent, { type: 'delete' }>,
): Promise<void> {
  await deps.ingestComments.delete({
    workspaceId: ctx.workspaceId,
    socialAccountId: ctx.socialAccountId,
    platform: event.platform,
    platformCommentId: event.platformCommentId,
  });
}

/**
 * Ingests one event for one matching account — the fan-out target of {@link processEvent}.
 * Catches `AuthError` from *either* `buildAccountContext` (an undecryptable credential) or the
 * upsert path (`adapter.fetchComment` on a 401/403) and handles it as this account's own terminal
 * outcome (module docstring point 5): recorded, logged, never rethrown. Rethrowing would fail the
 * whole job and, with it, every *other* account this same delivery also named — exactly the
 * fan-out isolation this function exists to preserve.
 */
async function processEventForAccount(
  deps: WebhookWorkerDeps,
  adapters: MetaAdapterRegistry,
  accountHealth: AccountHealth,
  account: SocialAccountRecord,
  event: WebhookIngestionEvent,
  jobLogger: Logger,
): Promise<void> {
  try {
    const ctx = await buildAccountContext(deps, account, event);
    if (event.type === 'delete') {
      await processDelete(deps, ctx, event);
      return;
    }
    await processUpsert(deps, adapters, ctx, event, jobLogger);
  } catch (error) {
    if (!(error instanceof AuthError)) {
      throw error;
    }
    await recordAuthFailure(deps, accountHealth, account, error.message);
    jobLogger.warn(
      { socialAccountId: account.id, workspaceId: account.workspaceId },
      'webhook-worker: account auth failed, recorded and skipped',
    );
  }
}

async function processEvent(
  deps: WebhookWorkerDeps,
  adapters: MetaAdapterRegistry,
  accountHealth: AccountHealth,
  event: WebhookIngestionEvent,
  jobLogger: Logger,
): Promise<void> {
  const accounts = await deps.accounts.listByPlatformAccount(
    event.platform,
    event.platformAccountId,
  );
  if (accounts.length === 0) {
    // §7.2 step 2: never retried — a delivery about an account no workspace connected cannot
    // succeed on a later attempt either.
    jobLogger.warn(
      { platform: event.platform, platformAccountId: event.platformAccountId },
      'webhook-worker: unknown account, skipping event',
    );
    return;
  }

  for (const account of accounts) {
    // One event, ingested once per matching account (module docstring point 1) — each account's
    // own transaction, and its own `AuthError` handling, is independent, and
    // `UNIQUE (social_account_id, platform_comment_id)` keeps the resulting rows apart, so
    // sequential here only keeps one delivery's log order readable.
    // oxlint-disable-next-line no-await-in-loop
    await processEventForAccount(deps, adapters, accountHealth, account, event, jobLogger);
  }
}

async function processDelivery(
  deps: WebhookWorkerDeps,
  adapters: MetaAdapterRegistry,
  accountHealth: AccountHealth,
  deliveryId: string,
  jobLogger: Logger,
): Promise<void> {
  const delivery = await loadDelivery(deps.database, deliveryId);
  if (delivery === null) {
    jobLogger.warn('webhook-worker: delivery not found, skipping');
    return;
  }

  const events = deps.normalizer.normalize(delivery.payload);
  for (const event of events) {
    // Each event's account/adapter resolution is independent, but sequential keeps one delivery's
    // processing simple to reason about and to log — deliveries are not high-volume enough for
    // this to matter (Meta redelivers over 36h, not per-second).
    // oxlint-disable-next-line no-await-in-loop
    await processEvent(deps, adapters, accountHealth, event, jobLogger);
  }
  // Reached even when one or more accounts hit `AuthError` above (module docstring point 5) —
  // that outcome is recorded and terminal, not a reason to leave this delivery unprocessed.
  await markProcessed(deps.database, deliveryId);
}

/**
 * Reads `deliveryId` off the job this queue's one producer and one re-enqueuer (`webhook-routes.ts`,
 * the T082 sweeper) both agree to add under `JOB_NAMES.processDelivery` — checked against the
 * shared constant, not assumed, so a future rename on either side fails loudly here instead of
 * silently processing a job shaped for some other purpose.
 */
function deliveryIdFromJob(job: Job): string {
  if (job.name !== JOB_NAMES.processDelivery) {
    throw new TypeError(`webhook-worker: unexpected job name "${job.name}"`);
  }
  const data = job.data as { deliveryId?: unknown };
  if (typeof data.deliveryId !== 'string') {
    throw new TypeError('webhook-worker: job data has no string "deliveryId"');
  }
  return data.deliveryId;
}

/**
 * Creates and starts the `webhook-process` worker (T081).
 *
 * Args:
 *   deps: The database handle, Redis connection, config (for the Meta Graph API version), the
 *     platform-core ports needed to build an `AccountContext`, the shared `IngestComments` use
 *     case, the Meta normalizer, and a logger to stamp each job's id onto.
 *
 * Returns:
 *   The running `Worker`. The caller owns its lifecycle (`close()` on shutdown).
 */
export function createWebhookWorker(deps: WebhookWorkerDeps): Worker {
  const adapters = buildMetaAdapterRegistry(deps.config);
  // Only needs `deps.database` (module docstring point 5) — built here rather than added to
  // `WebhookWorkerDeps`, since every other caller already owns exactly the handle this needs.
  const accountHealth = createAccountHealth(deps.database);

  return new Worker(
    QUEUE_NAMES.webhookProcess,
    async (job: Job): Promise<void> => {
      const deliveryId = deliveryIdFromJob(job);
      const jobLogger = forJob(deps.logger, deliveryId);
      await processDelivery(deps, adapters, accountHealth, deliveryId, jobLogger);
    },
    { connection: deps.redis, concurrency: WORKER_CONCURRENCY },
  );
}
