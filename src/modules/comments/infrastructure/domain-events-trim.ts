/**
 * Trims stale `domain-events` jobs (spec.md §18, "`domain-events` is trimmed on a schedule in this
 * deployment", extends D9).
 *
 * The outbox relay (`outbox-relay.ts`) publishes every domain event onto this queue for consumers
 * in other services — and in this deployment there are none, so nothing ever moves a job out of
 * `wait`. Bounding `removeOnComplete`/`removeOnFail` (`src/shared/queue.ts`, C1/I4) does nothing
 * for a job that never completes, and D24 mandates Redis run `maxmemory-policy noeviction`, so an
 * untrimmed queue grows until Redis refuses writes and takes the publish and sync paths down with
 * it — a scheduled outage, not a nuisance.
 *
 * Dropping is safe because Redis is not where this event's durable record lives: the outbox relay
 * stamps `outbox_events.published_at` in the same transaction that publishes it, and those rows are
 * retained under the normal retention purge (§7.4) — a future consumer is backfilled from
 * **Postgres**, never from Redis. That is the D9 property that actually matters; this job is what
 * keeps "Redis holds no durable state" (§4.1) true rather than aspirational, instead of the other
 * two options considered (stop publishing, which would delete the D9 contract this service exists
 * to demonstrate, or let it grow, which is the scheduled outage above).
 *
 * Logs the dropped count at `info` on every run, including zero: an operator watching that number
 * climb is the signal that a consumer was never wired up for this queue, and a silent trim would
 * hide exactly the thing worth knowing.
 */

import type { Queue } from 'bullmq';
import type { Logger } from 'pino';

const MS_PER_HOUR = 60 * 60 * 1000;

export interface DomainEventsTrimDeps {
  readonly domainEventsQueue: Queue;
  /** `config.DOMAIN_EVENTS_TTL_HOURS` — how long an unconsumed job is kept before it is dropped. */
  readonly ttlHours: number;
  readonly logger: Pick<Logger, 'info'>;
}

export interface DomainEventsTrim {
  run(): Promise<void>;
}

/**
 * Creates the trim job. Registered on the `scheduler` queue (`src/app/worker.ts`) as a repeatable
 * job, at the queue's required concurrency 1 (§9.2) — same reasoning as the sweepers in
 * `sweepers.ts`, though concurrency here is only about not running two cleans concurrently, not
 * about a write race: `Queue.clean` only ever deletes jobs already past the grace period.
 */
export function createDomainEventsTrim(deps: DomainEventsTrimDeps): DomainEventsTrim {
  return {
    async run(): Promise<void> {
      const graceMs = deps.ttlHours * MS_PER_HOUR;
      // `type: 'wait'` — domain-events jobs are never processed, so they never reach
      // `completed`/`failed`; `limit: 0` means no cap, letting BullMQ's own internal batching
      // (`clean`'s own 10,000-per-call loop) drain however many have aged out since the last run.
      const droppedIds = await deps.domainEventsQueue.clean(graceMs, 0, 'wait');
      deps.logger.info(
        { droppedCount: droppedIds.length, ttlHours: deps.ttlHours },
        'trimmed unconsumed domain-events jobs past their TTL',
      );
    },
  };
}
