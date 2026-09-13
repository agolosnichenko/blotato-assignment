/**
 * The throttling half of spec.md §8.2: "parse `X-Business-Use-Case-Usage` / `X-App-Usage`; under
 * high usage, delay that account's jobs".
 *
 * Parsing was implemented in `graph-client.ts` and the result went nowhere — `GraphResponse.usage`
 * had no reader anywhere in the service, so the second half of the sentence did not exist. This
 * module is that half: the client reports what Meta said about an account, and the two workers ask
 * before they start more work for it.
 *
 * Redis, not Postgres: this is advisory, per-account and short-lived — losing it costs one
 * un-throttled call, which is exactly the kind of state §4.1 says Redis may hold. It is read on the
 * same path that already reads the per-account token bucket, so it adds no round trip the workers
 * were not already making.
 *
 * Why a delay rather than a hard stop: Meta's percentages are a rolling window, so the account
 * recovers on its own. Delaying the job returns it to the queue untouched (`moveToDelayed`, no
 * retry attempt spent), which is the same treatment an empty token bucket already gets.
 */

import type { Redis } from 'ioredis';

const USAGE_KEY_PREFIX = 'meta-usage:';

/**
 * How long a reading stays authoritative.
 *
 * Meta reports against a rolling hour, but a stale reading is worse than no reading: it would keep
 * throttling an account that has long since recovered. Five minutes is short enough to clear
 * quickly and long enough to cover the gap between two jobs for a quiet account.
 */
const USAGE_TTL_SECONDS = 300;

/** Records what Meta reported for this account. Advisory: a failed write must never fail a call. */
export async function recordGraphUsage(
  redis: Redis,
  socialAccountId: string,
  highestPercent: number,
): Promise<void> {
  try {
    await redis.set(
      `${USAGE_KEY_PREFIX}${socialAccountId}`,
      String(highestPercent),
      'EX',
      USAGE_TTL_SECONDS,
    );
  } catch {
    // Deliberately swallowed, and the only swallow in this module: this is a hint about how busy
    // an account is, and failing a publish because the hint could not be stored would trade a
    // real outcome for an advisory one.
  }
}

/** The most recent reading for this account, or `null` when there is none (or Redis is down). */
export async function readGraphUsage(
  redis: Redis,
  socialAccountId: string,
): Promise<number | null> {
  let raw: string | null;
  try {
    raw = await redis.get(`${USAGE_KEY_PREFIX}${socialAccountId}`);
  } catch {
    return null;
  }
  if (raw === null) {
    return null;
  }
  const percent = Number(raw);
  return Number.isFinite(percent) ? percent : null;
}

export interface UsageThrottleConfig {
  readonly META_USAGE_THROTTLE_PERCENT: number;
  readonly META_USAGE_THROTTLE_DELAY_MS: number;
}

/**
 * How long to hold this account's next job back, given the last usage reading.
 *
 * Args:
 *   percent: The highest percentage Meta reported, or `null` when nothing is known.
 *   config: The configured threshold and delay.
 *
 * Returns:
 *   The delay in milliseconds, or `0` when the account is not throttled — including when nothing
 *   is known, since the absence of a reading is not evidence of pressure.
 */
export function usageDelayMs(percent: number | null, config: UsageThrottleConfig): number {
  if (percent === null || percent < config.META_USAGE_THROTTLE_PERCENT) {
    return 0;
  }
  return config.META_USAGE_THROTTLE_DELAY_MS;
}
