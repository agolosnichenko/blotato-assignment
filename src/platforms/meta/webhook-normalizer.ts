/**
 * Meta webhook payload normalizer (T080, spec.md §7.2 step 2, §8.2, §17 S1, A18).
 *
 * Turns an already-verified, already-parsed Meta webhook body into events the webhook worker
 * (T081) feeds through `ingest-comments.ts`'s shared upsert/delete path. Covers `instagram.comments`
 * and `page.feed` (`item=comment`, `verb=add|edited|remove`) per §8.2.
 *
 * **Why this file does not literally return `src/platforms/types.ts`'s `IngestionEvent`.** That
 * type's `upsert` variant carries `comment: NormalizedComment`, whose `text` is a required
 * `string` — there is no value that type can hold to mean "the payload did not say". A18 requires
 * a payload missing `text` or author fields to be normalized as *incomplete*, not as empty, as a
 * type fact rather than a convention the worker has to remember. So `WebhookIngestionEvent` below
 * defines its own `upsert` variant whose `comment` is `WebhookUpsertComment | undefined` —
 * `undefined` exactly when the raw payload omitted `message`/`from` (or sent either with the wrong
 * shape), `{ text: '', ... }` when the platform genuinely sent blank text. A caller cannot reach
 * `comment.text` without first narrowing away `undefined`, which makes completing a thin payload
 * via `adapter.fetchComment` (T081) unavoidable rather than merely documented. Both this type and
 * `IngestionEvent` are Meta-only (the port's own docstring) and structurally close by design —
 * this is a refinement of that contract for the one case it cannot express, not a divergent one.
 *
 * **Provenance of the field names below.** `__fixtures__/s1-page-feed-test-delivery.json` is the
 * only payload anyone here has seen Meta actually deliver (§17 S1): a dashboard `Test` send for
 * `page`/`feed` with `item: "status"`, not a comment. Its *envelope* —
 * `{ object, entry: [{ id, time, changes: [{ field, value }] }] }`, `value` carrying
 * `verb`/`post_id`/`created_time`/`message`/`from` — is confirmed real and is what every test below
 * clones via `structuredClone`. The comment-specific fields this module also reads
 * (`item: "comment"`, `comment_id`, `parent_id`) are not in that fixture — they come from Meta's
 * published Graph API webhook reference, used only because §17 S1 found no real comment delivery
 * to check them against. `instagram.comments`' shape (`id`/`text`/`from.username`/`media.id`/
 * `parent_id`) is likewise from the Graph docs, not a spike — S2 only verified reading comments
 * over `facebook_login`, not any Instagram webhook delivery.
 */

// oxlint-disable max-lines -- one module covering both webhook fields this port names
// (`instagram.comments`, `page.feed`) end to end: parsing the shared envelope, the A18
// completeness check, and each field's own comment/verb vocabulary. Splitting the two fields into
// separate files would duplicate the envelope parser and the `WebhookIngestionEvent` type they
// both produce instead of removing any of the logic itself.

import type { Platform } from '#src/platforms/types.ts';

/**
 * The comment-bearing fields available only when the raw payload carried both `text` and author
 * identity (A18). Present on a `WebhookIngestionEvent.comment` only when the payload was complete.
 */
export interface WebhookUpsertComment {
  readonly authorPlatformId: string;
  readonly authorUsername: string | null;
  readonly authorDisplayName: string | null;
  readonly text: string;
  readonly platformCreatedAt: Date;
  readonly platformMeta: Record<string, unknown>;
}

/** One normalized change coming out of a verified Meta webhook payload (Meta only). */
export type WebhookIngestionEvent =
  | {
      readonly type: 'upsert';
      readonly platform: Platform;
      readonly platformAccountId: string;
      readonly platformPostId: string;
      readonly platformCommentId: string;
      readonly platformParentId: string | null;
      /**
       * `undefined` means the payload was thin (A18): the worker must complete it via
       * `adapter.fetchComment` before any upsert runs, never insert blank text or author fields.
       * Distinct from a defined `comment` whose `text` happens to be `''` — that is a real edit to
       * blank, not a thin payload, and must be stored as written.
       */
      readonly comment: WebhookUpsertComment | undefined;
    }
  | {
      readonly type: 'delete';
      readonly platform: Platform;
      readonly platformAccountId: string;
      readonly platformCommentId: string;
    };

export interface WebhookNormalizer {
  normalize(payload: unknown): readonly WebhookIngestionEvent[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** `tsconfig`'s `noPropertyAccessFromIndexSignature` forbids `value.foo` on a `Record<string,
 * unknown>` — every read below goes through this one bracketed accessor instead. */
function field(value: Record<string, unknown>, key: string): unknown {
  return value[key];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return asString(field(value, key));
}

function recordField(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const raw = field(value, key);
  return isRecord(raw) ? raw : undefined;
}

interface WebhookChange {
  readonly field: string;
  readonly value: Record<string, unknown>;
}

interface WebhookEntry {
  readonly id: string;
  readonly changes: readonly WebhookChange[];
}

function parseChange(raw: unknown): WebhookChange | null {
  if (!isRecord(raw)) {
    return null;
  }
  const changeField = stringField(raw, 'field');
  const value = recordField(raw, 'value');
  if (changeField === undefined || value === undefined) {
    return null;
  }
  return { field: changeField, value };
}

function parseEntry(raw: unknown): WebhookEntry | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = stringField(raw, 'id');
  const rawChanges = field(raw, 'changes');
  if (id === undefined || !Array.isArray(rawChanges)) {
    return null;
  }
  const changes = rawChanges
    .map((rawChange) => parseChange(rawChange))
    .filter((change): change is WebhookChange => change !== null);
  return { id, changes };
}

/** `entry[].id` is the id of the object the change is about — the Page or the IG user (Meta's own
 * webhook convention), which is exactly `AccountContext.platformAccountId`. */
function parseEntries(payload: Record<string, unknown>): readonly WebhookEntry[] {
  const rawEntries = field(payload, 'entry');
  if (!Array.isArray(rawEntries)) {
    throw new TypeError('meta webhook-normalizer: payload has no "entry" array');
  }
  return rawEntries
    .map((raw) => parseEntry(raw))
    .filter((entry): entry is WebhookEntry => entry !== null);
}

/** `from.id` present as a string is the one field A18 treats as load-bearing on its own — without
 * it there is no `authorPlatformId` to write, complete or not. */
function fromId(value: Record<string, unknown>): string | undefined {
  const from = recordField(value, 'from');
  return from === undefined ? undefined : stringField(from, 'id');
}

/**
 * Builds the `comment` snapshot for a `page.feed` change, or `undefined` when `message` or `from`
 * was absent from the payload (A18) — checked by key presence and shape, not truthiness, so
 * `message: ''` still counts as present.
 */
function pageFeedComment(value: Record<string, unknown>): WebhookUpsertComment | undefined {
  const text = stringField(value, 'message');
  const authorPlatformId = fromId(value);
  const createdTime = asNumber(field(value, 'created_time'));
  if (text === undefined || authorPlatformId === undefined || createdTime === undefined) {
    return undefined;
  }
  // `fromId` above already established `from` is a record carrying a string `id`.
  const from = recordField(value, 'from') as Record<string, unknown>;
  return {
    authorPlatformId,
    authorUsername: null,
    authorDisplayName: stringField(from, 'name') ?? null,
    text,
    platformCreatedAt: new Date(createdTime * 1000),
    platformMeta: {},
  };
}

/** `parent_id` equal to `post_id` means top-level (Meta's page-feed convention); absent also means
 * top-level, since a reply always carries its immediate parent's id. */
function pageFeedParentId(value: Record<string, unknown>): string | null {
  const parentId = stringField(value, 'parent_id');
  const postId = stringField(value, 'post_id');
  if (parentId === undefined || parentId === postId) {
    return null;
  }
  return parentId;
}

function normalizePageFeedChange(
  platformAccountId: string,
  value: Record<string, unknown>,
): WebhookIngestionEvent | null {
  if (field(value, 'item') !== 'comment') {
    return null;
  }
  const commentId = stringField(value, 'comment_id');
  const postId = stringField(value, 'post_id');
  const verb = stringField(value, 'verb');
  if (commentId === undefined || postId === undefined || verb === undefined) {
    return null;
  }

  if (verb === 'remove') {
    return {
      type: 'delete',
      platform: 'facebook',
      platformAccountId,
      platformCommentId: commentId,
    };
  }
  if (verb !== 'add' && verb !== 'edited') {
    return null;
  }
  return {
    type: 'upsert',
    platform: 'facebook',
    platformAccountId,
    platformPostId: postId,
    platformCommentId: commentId,
    platformParentId: pageFeedParentId(value),
    comment: pageFeedComment(value),
  };
}

/**
 * Builds the `comment` snapshot for an `instagram.comments` change. `from.username`, not a
 * display name, is S2's own finding for Instagram's `from` shape (§17) — carried here too even
 * though this path is unverified by any webhook spike, for the same reason the read path uses it.
 */
function instagramComment(value: Record<string, unknown>): WebhookUpsertComment | undefined {
  const text = stringField(value, 'text');
  const authorPlatformId = fromId(value);
  if (text === undefined || authorPlatformId === undefined) {
    return undefined;
  }
  // `fromId` above already established `from` is a record carrying a string `id`.
  const from = recordField(value, 'from') as Record<string, unknown>;
  return {
    authorPlatformId,
    authorUsername: stringField(from, 'username') ?? null,
    authorDisplayName: null,
    text,
    platformCreatedAt: new Date(),
    platformMeta: {},
  };
}

/**
 * §17 S2 found no Instagram webhook delivery to verify against (only the `facebook_login` read
 * path); this mirrors the documented Graph API shape (`id`, `text`, `from`, `media.id`,
 * `parent_id`), with an optional `verb` defaulting to `add` since IG's documented webhook does not
 * distinguish edit/remove the way `page.feed` does.
 */
function normalizeInstagramCommentsChange(
  platformAccountId: string,
  value: Record<string, unknown>,
): WebhookIngestionEvent | null {
  const commentId = stringField(value, 'id');
  if (commentId === undefined) {
    return null;
  }
  const verb = stringField(value, 'verb') ?? 'add';

  if (verb === 'remove') {
    return {
      type: 'delete',
      platform: 'instagram',
      platformAccountId,
      platformCommentId: commentId,
    };
  }
  if (verb !== 'add' && verb !== 'edited') {
    return null;
  }
  const media = recordField(value, 'media');
  const postId = media === undefined ? undefined : stringField(media, 'id');
  if (postId === undefined) {
    return null;
  }
  return {
    type: 'upsert',
    platform: 'instagram',
    platformAccountId,
    platformPostId: postId,
    platformCommentId: commentId,
    platformParentId: stringField(value, 'parent_id') ?? null,
    comment: instagramComment(value),
  };
}

function normalizeChange(
  objectType: string,
  platformAccountId: string,
  change: WebhookChange,
): WebhookIngestionEvent | null {
  if (objectType === 'page' && change.field === 'feed') {
    return normalizePageFeedChange(platformAccountId, change.value);
  }
  if (objectType === 'instagram' && change.field === 'comments') {
    return normalizeInstagramCommentsChange(platformAccountId, change.value);
  }
  return null;
}

function normalize(payload: unknown): readonly WebhookIngestionEvent[] {
  if (!isRecord(payload)) {
    throw new TypeError('meta webhook-normalizer: payload is not an object');
  }
  const objectType = stringField(payload, 'object');
  if (objectType === undefined) {
    throw new Error('meta webhook-normalizer: payload has no "object" field');
  }

  const events: WebhookIngestionEvent[] = [];
  for (const entry of parseEntries(payload)) {
    for (const change of entry.changes) {
      const event = normalizeChange(objectType, entry.id, change);
      if (event !== null) {
        events.push(event);
      }
    }
  }
  return events;
}

/** Builds the normalizer (T080). Stateless — safe to construct once and share across jobs. */
export function createMetaWebhookNormalizer(): WebhookNormalizer {
  return { normalize };
}
