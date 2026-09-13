/**
 * `computeNextSyncAt`'s age-band lookup (spec.md §18): the §7.3 schedule must be derivable
 * from `registry.ts` alone, the same invariant Principle IV states for every other capability
 * decision ("adding a platform must not change the DB schema or the API" — an adapter plus a
 * registry entry, nothing else). Before this fix, the lookup was a `platform` literal `switch`
 * inside this infrastructure file: a platform given comment support the documented way — only a
 * `registry.ts` entry plus an adapter — would still throw the first time a comment on its post
 * reached `ensureSyncTargetIfExternal` → `computeNextSyncAt`, inside the ingest transaction, so the
 * whole upsert would roll back. This file proves the opposite: mutating only the registry entry
 * for an otherwise-unsupported platform is enough to make it schedule correctly, with zero change
 * to this module.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  computeNextSyncAt,
  type SyncIntervalsConfig,
} from '#src/modules/comments/infrastructure/sync-target-repository.ts';
import { platformRegistry, type PlatformCapabilities } from '#src/platforms/registry.ts';
import type { Platform } from '#src/platforms/types.ts';

const CONFIG: SyncIntervalsConfig = {
  RETENTION_DAYS: 45,
  SYNC_INTERVALS_BLUESKY_UNDER_24H_MINUTES: 5,
  SYNC_INTERVALS_BLUESKY_1_TO_7_DAYS_MINUTES: 60,
  SYNC_INTERVALS_BLUESKY_7_DAYS_TO_RETENTION_MINUTES: 1440,
  SYNC_INTERVALS_META_UNDER_24H_MINUTES: 30,
  SYNC_INTERVALS_META_1_TO_7_DAYS_MINUTES: 360,
  SYNC_INTERVALS_META_7_DAYS_TO_RETENTION_MINUTES: 1440,
};

/** A mutable view onto the registry, for exactly the one entry this file temporarily overrides. */
const mutableRegistry = platformRegistry as Record<Platform, PlatformCapabilities>;

describe('computeNextSyncAt reads its age bands from registry.ts, not a platform switch here', () => {
  const originalThreads = mutableRegistry.threads;

  afterEach(() => {
    mutableRegistry.threads = originalThreads;
  });

  it('still throws for a platform the registry marks unsupported', () => {
    expect(() =>
      computeNextSyncAt({
        platform: 'threads',
        ageAnchorAt: new Date(),
        now: new Date(),
        config: CONFIG,
      }),
    ).toThrow(/threads/u);
  });

  it('schedules a newly comments-enabled platform via the registry entry alone — no change here', () => {
    // Exactly what "add an adapter plus a registry entry" looks like for threads (I3's own
    // scenario) — `syncIntervalGroup` is the only thing this module reads off the entry.
    mutableRegistry.threads = {
      platform: 'threads',
      supportsComments: true,
      supportsTopLevel: true,
      supportsReply: true,
      maxReplyDepth: null,
      textLimit: 500,
      textUnit: 'characters',
      ingestion: 'sync',
      syncIntervalGroup: 'bluesky',
    };

    const now = new Date();
    const next = computeNextSyncAt({ platform: 'threads', ageAnchorAt: now, now, config: CONFIG });

    expect(next).not.toBeNull();
    const minutesAhead = ((next as Date).getTime() - now.getTime()) / 60_000;
    expect(minutesAhead).toBeCloseTo(CONFIG.SYNC_INTERVALS_BLUESKY_UNDER_24H_MINUTES, 1);
  });
});
