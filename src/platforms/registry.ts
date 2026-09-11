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
