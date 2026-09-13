/**
 * Registry-driven reply-depth and text-length checks (spec.md D12, A20; Principle IV, R-07).
 *
 * Both checks read only the two capability fields the caller passes in — never a platform name.
 * A tenth platform needs no change here, only a new `registry.ts` row. `textUnit` is the one
 * legitimate discriminant; there is no branch on platform anywhere in this file.
 *
 * Pure domain: no database access, no HTTP, no imports from `infrastructure/` or `http/`. A
 * rejection is returned as a plain result object, not thrown — building the `422
 * REPLY_DEPTH_EXCEEDED` / `TEXT_TOO_LONG` problem+json body (including naming the top-level
 * comment) is the HTTP layer's job.
 */

/** The subset of a registry entry the depth check needs. */
export interface ReplyDepthLimit {
  /** Deepest allowed reply nesting; `null` means unbounded (A20). */
  readonly maxReplyDepth: number | null;
}

export type ReplyDepthCheckResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly maxReplyDepth: number };

/**
 * Checks whether a reply may be attached under a parent at `parentDepth`.
 *
 * Strict per D12: a violation is reported, never silently re-parented to a shallower depth.
 *
 * Args:
 *   limit: The target platform's `maxReplyDepth`, taken from the capability registry.
 *   parentDepth: The depth of the comment being replied to (0 for a top-level comment).
 *
 * Returns:
 *   `{ allowed: true }` when `parentDepth + 1` fits within `maxReplyDepth`, or unbounded;
 *   otherwise `{ allowed: false, maxReplyDepth }` so the caller can build the rejection.
 */
export function checkReplyDepth(
  limit: ReplyDepthLimit,
  parentDepth: number,
): ReplyDepthCheckResult {
  if (limit.maxReplyDepth === null) {
    return { allowed: true };
  }

  const nextDepth = parentDepth + 1;
  if (nextDepth <= limit.maxReplyDepth) {
    return { allowed: true };
  }

  return { allowed: false, maxReplyDepth: limit.maxReplyDepth };
}

/** The subset of a registry entry the text-length check needs. */
export interface TextLengthLimit {
  readonly textLimit: number;
  readonly textUnit: 'characters' | 'graphemes';
}

export type TextLengthCheckResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly length: number; readonly limit: number };

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * Counts the grapheme clusters in `text`, so a multi-code-unit emoji (including ZWJ sequences)
 * counts once — the unit Bluesky itself counts against its 300-character limit.
 *
 * Args:
 *   text: The string to measure.
 *
 * Returns:
 *   The number of user-perceived characters in `text`.
 */
function countGraphemes(text: string): number {
  return [...graphemeSegmenter.segment(text)].length;
}

/**
 * Checks `text` against a platform's length limit, in whichever unit that platform counts in.
 *
 * Args:
 *   limit: The target platform's `textLimit` and `textUnit`, from the capability registry.
 *   text: The comment text to measure.
 *
 * Returns:
 *   `{ allowed: true }` when the text fits; otherwise `{ allowed: false, length, limit }` so
 *   the caller can build the rejection.
 */
export function checkTextLength(limit: TextLengthLimit, text: string): TextLengthCheckResult {
  const length = limit.textUnit === 'graphemes' ? countGraphemes(text) : text.length;

  if (length <= limit.textLimit) {
    return { allowed: true };
  }

  return { allowed: false, length, limit: limit.textLimit };
}
