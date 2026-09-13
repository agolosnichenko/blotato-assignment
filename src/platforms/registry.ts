/**
 * Capability registry (spec.md §8.1, FR-031).
 *
 * The single source of truth for what a platform can do: `GET /v1/platforms` serialises this
 * directly (T096, T098), and depth/text-limit checks read it instead of branching on platform
 * (Principle IV). Adding a platform never touches the schema or the API — only this file plus an
 * adapter (contracts/platform-adapter.md, "Adding a platform").
 */

import type { Platform } from '#src/platforms/types.ts';

interface SupportedCapabilities {
  readonly platform: Platform;
  readonly supportsComments: true;
  readonly supportsTopLevel: true;
  readonly supportsReply: true;
  /** Deepest allowed reply nesting; `null` means unbounded (A20), not "unknown". */
  readonly maxReplyDepth: number | null;
  readonly textLimit: number;
  readonly textUnit: 'characters' | 'graphemes';
  readonly ingestion: 'webhook+sync' | 'sync';
  /**
   * Which `config.ts` `SYNC_INTERVALS_*` group this platform's refresh schedule reads — Meta's two
   * comment-capable platforms (instagram, facebook) share one configured band, Bluesky has its own.
   * Not the resolved minutes themselves: those still come from `SyncIntervalsConfig` at call time,
   * so a deployment can retune them without a code change.
   */
  readonly syncIntervalGroup: 'meta' | 'bluesky';
}

interface UnsupportedCapabilities {
  readonly platform: Platform;
  readonly supportsComments: false;
  /**
   * Required so an entry omitting it does not compile — the invariant is unrepresentable rather
   * than merely tested (registry.test.ts pins it at runtime too, for API consumers).
   */
  readonly unsupportedReason: string;
}

export type PlatformCapabilities = SupportedCapabilities | UnsupportedCapabilities;

const UNSUPPORTED_REASON = 'platform API access not in place';

export const platformRegistry: Readonly<Record<Platform, PlatformCapabilities>> = {
  instagram: {
    platform: 'instagram',
    supportsComments: true,
    supportsTopLevel: true,
    supportsReply: true,
    maxReplyDepth: 1,
    textLimit: 2200,
    textUnit: 'characters',
    ingestion: 'webhook+sync',
    syncIntervalGroup: 'meta',
  },
  facebook: {
    platform: 'facebook',
    supportsComments: true,
    supportsTopLevel: true,
    supportsReply: true,
    maxReplyDepth: 1,
    textLimit: 8000,
    textUnit: 'characters',
    ingestion: 'webhook+sync',
    syncIntervalGroup: 'meta',
  },
  bluesky: {
    platform: 'bluesky',
    supportsComments: true,
    supportsTopLevel: true,
    supportsReply: true,
    maxReplyDepth: null,
    textLimit: 300,
    textUnit: 'graphemes',
    ingestion: 'sync',
    syncIntervalGroup: 'bluesky',
  },
  threads: { platform: 'threads', supportsComments: false, unsupportedReason: UNSUPPORTED_REASON },
  x: { platform: 'x', supportsComments: false, unsupportedReason: UNSUPPORTED_REASON },
  linkedin: {
    platform: 'linkedin',
    supportsComments: false,
    unsupportedReason: UNSUPPORTED_REASON,
  },
  youtube: { platform: 'youtube', supportsComments: false, unsupportedReason: UNSUPPORTED_REASON },
  tiktok: { platform: 'tiktok', supportsComments: false, unsupportedReason: UNSUPPORTED_REASON },
  pinterest: {
    platform: 'pinterest',
    supportsComments: false,
    unsupportedReason: UNSUPPORTED_REASON,
  },
};

/**
 * Narrows a platform string that came from outside this service.
 *
 * `social_accounts.platform` and `posts.platform` belong to other services (D8), so their values
 * are whatever those services wrote — including a platform added there before this service's
 * registry learned about it, which CLAUDE.md describes as the normal way the platform grows.
 */
export function isPlatform(value: string): value is Platform {
  return Object.hasOwn(platformRegistry, value);
}

/**
 * The capabilities registered for `platform`, or `undefined` if this service does not know it.
 *
 * Use this rather than indexing {@link platformRegistry} with a cast. `Record<Platform, ...>` is a
 * mapped type over a closed union, so `noUncheckedIndexedAccess` does *not* add `| undefined` to
 * its index signature — a `platform as Platform` cast therefore produces a value typed
 * `PlatformCapabilities` that is actually `undefined` at runtime, and the next property read
 * throws a `TypeError`. That surfaced to the client as `500 INTERNAL_ERROR` where the honest
 * answer is `422 PLATFORM_NOT_SUPPORTED`.
 */
export function lookupCapabilities(platform: string): PlatformCapabilities | undefined {
  return isPlatform(platform) ? platformRegistry[platform] : undefined;
}
