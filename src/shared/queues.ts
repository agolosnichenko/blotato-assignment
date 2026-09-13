/**
 * The five BullMQ queue names (plan.md §9.2), declared once.
 *
 * These are runtime strings shared by producers, workers and tests. A test that asserts "nothing was
 * enqueued" by counting jobs on a queue it names with its own literal goes **vacuously green** the
 * moment the producer spells the name differently — it observes an empty queue that nobody was ever
 * going to write to. Importing the name from here is what keeps that assertion honest.
 *
 * `scheduler` runs at concurrency 1 (see `outbox-relay.ts`): `FOR UPDATE SKIP LOCKED` stops a second
 * runner from corrupting data, but not from double-publishing rows the first has selected and not yet
 * stamped, nor from double-running the purge and the stuck-work sweeper.
 */
export const QUEUE_NAMES = {
  /** Publishing one comment to its platform (§7.1). Per-account token bucket. */
  commentPublish: 'comment-publish',
  /** Processing one stored webhook delivery (§7.2). Concurrency 10. */
  webhookProcess: 'webhook-process',
  /** Refreshing one sync target (§7.3). Per-account token bucket. */
  commentSync: 'comment-sync',
  /**
   * Repeatable jobs: the sync scheduler, the stuck-work sweeper, the webhook-delivery sweeper
   * (§7.2 step 5), the outbox relay, the retention purge.
   */
  scheduler: 'scheduler',
  /** Domain events for external consumers; not consumed inside this service (D9). */
  domainEvents: 'domain-events',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * Job names, for the one queue where more than one producer/consumer pair needs to agree on a
 * spelling. `POST /webhooks/meta` (`webhook-routes.ts`) adds this job to `QUEUE_NAMES.webhookProcess`
 * on every accepted delivery; the webhook-delivery sweeper (`sweepers.ts`) re-adds it under the same
 * name for a delivery it re-enqueues. A literal would have the same vacuous-green failure mode the
 * module docstring describes for a queue name — a worker listening for one spelling never sees a
 * job added under another.
 */
export const JOB_NAMES = {
  processDelivery: 'process-delivery',
} as const;
