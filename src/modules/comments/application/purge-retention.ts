/**
 * The retention purge (T101, §7.4, D15, A9).
 *
 * A thread is a unit: the root's `last_activity_at` is the newest `occurred_at` anywhere in the
 * thread (A9), so a reply today keeps a two-year-old root alive. The purge therefore selects on
 * the **root's** `last_activity_at`, never on an individual comment's own age — otherwise it
 * would delete the older half of a live conversation, and the surviving replies would read as
 * though they answered nothing. Once a root is selected, its replies go with it by cascade
 * (`comments.parent_comment_id` is `ON DELETE CASCADE` — see `schema.ts`); this job never
 * recurses into a thread itself.
 *
 * Three other, independent clocks are purged in the same run:
 *   - `webhook_deliveries` older than 7 days (raw pushed payloads, already processed into
 *     `comments`/the outbox by then).
 *   - **Published** `outbox_events` older than 7 days — an unpublished row is work the relay
 *     still owes; deleting it would lose a domain event permanently, so the predicate always
 *     includes `published_at is not null`.
 *   - `contact_quota_usage` for periods (`YYYY-MM`) more than two months in the past. Its
 *     `comment_id` is deliberately not a foreign key (see the column comment in `schema.ts`)
 *     precisely because this clock outlives the comments' own 45-day one.
 *
 * Registered on the `scheduler` queue (`src/app/worker.ts`) as a repeatable job running daily, at
 * the queue's required concurrency 1 (§9.2) — the same reasoning `sweepers.ts` and
 * `sync-scheduler.ts` document for why that queue must stay single-worker.
 */

import { and, inArray, isNotNull, isNull, lt } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  comments,
  contactQuotaUsage,
  outboxEvents,
  webhookDeliveries,
} from '#src/modules/comments/infrastructure/schema.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const THREAD_PURGE_BATCH_SIZE = 1000;
const WEBHOOK_DELIVERY_RETENTION_DAYS = 7;
const OUTBOX_EVENT_RETENTION_DAYS = 7;
const CONTACT_QUOTA_RETENTION_MONTHS = 2;

export interface PurgeRetentionDeps {
  readonly database: NodePgDatabase;
  /** `Config.RETENTION_DAYS` (default 45, D15) — the caller reads it from config, not this
   * module, so a single source of truth for the number stays in `src/app/config.ts`. */
  readonly retentionDays: number;
}

export interface PurgeRetention {
  run(): Promise<void>;
}

/**
 * Deletes one batch of inactive roots, returning how many it removed. A root's replies are not
 * selected here — the cascade on `parent_comment_id` removes them when the root row goes.
 */
async function purgeThreadBatch(db: NodePgDatabase, cutoff: Date): Promise<number> {
  const stale = await db
    .select({ id: comments.id })
    .from(comments)
    .where(and(isNull(comments.parentCommentId), lt(comments.lastActivityAt, cutoff)))
    .limit(THREAD_PURGE_BATCH_SIZE);
  if (stale.length === 0) {
    return 0;
  }

  const ids = stale.map((row) => row.id);
  await db.delete(comments).where(inArray(comments.id, ids));
  return stale.length;
}

/** Loops until a full pass finds nothing left to purge, so one run never leaves the rest for the
 * next day's job (a backlog would otherwise never catch up under steady write volume). */
async function purgeInactiveThreads(db: NodePgDatabase, retentionDays: number): Promise<void> {
  const cutoff = new Date(Date.now() - retentionDays * DAY_MS);
  let removed = await purgeThreadBatch(db, cutoff);
  // Each batch's size decides whether another pass is needed; there is nothing to parallelize a
  // sequential drain against.
  while (removed === THREAD_PURGE_BATCH_SIZE) {
    // oxlint-disable-next-line no-await-in-loop
    removed = await purgeThreadBatch(db, cutoff);
  }
}

async function purgeWebhookDeliveries(db: NodePgDatabase): Promise<void> {
  const cutoff = new Date(Date.now() - WEBHOOK_DELIVERY_RETENTION_DAYS * DAY_MS);
  await db.delete(webhookDeliveries).where(lt(webhookDeliveries.receivedAt, cutoff));
}

async function purgePublishedOutboxEvents(db: NodePgDatabase): Promise<void> {
  const cutoff = new Date(Date.now() - OUTBOX_EVENT_RETENTION_DAYS * DAY_MS);
  await db
    .delete(outboxEvents)
    .where(and(isNotNull(outboxEvents.publishedAt), lt(outboxEvents.publishedAt, cutoff)));
}

/** `YYYY-MM`, lexicographically comparable — `contactQuotaUsage.period`'s own format. */
function periodMonthsAgo(months: number): string {
  const now = new Date();
  const anchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1));
  const year = anchor.getUTCFullYear();
  const month = String(anchor.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

async function purgeOldContactQuotaUsage(db: NodePgDatabase): Promise<void> {
  const cutoffPeriod = periodMonthsAgo(CONTACT_QUOTA_RETENTION_MONTHS);
  await db.delete(contactQuotaUsage).where(lt(contactQuotaUsage.period, cutoffPeriod));
}

/**
 * Creates the retention purge job (T101).
 *
 * Args:
 *   deps: The database handle and `RETENTION_DAYS` from config.
 *
 * Returns:
 *   The job. `run()` is the body of the repeatable `scheduler`-queue job `src/app/worker.ts`
 *   registers (daily, concurrency 1).
 */
export function createPurgeRetention(deps: PurgeRetentionDeps): PurgeRetention {
  return {
    async run(): Promise<void> {
      await purgeInactiveThreads(deps.database, deps.retentionDays);
      await purgeWebhookDeliveries(deps.database);
      await purgePublishedOutboxEvents(deps.database);
      await purgeOldContactQuotaUsage(deps.database);
    },
  };
}
