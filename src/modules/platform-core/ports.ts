/**
 * The whole service boundary in one file (D8, D29).
 *
 * `Workspaces`, `ApiKeys`, `Accounts`, `Posts` and `AccountCredentials` are outbound ports: this
 * service reads entities owned by other services in the platform (workspaces, accounts,
 * publishing) only through these, never with a direct query or a SQL join against their tables.
 * `PostPublished` is the one inbound port — the seam through which a published post, an event that
 * originates in the publishing service, reaches this service (§7.3).
 *
 * Every outbound port returns {@link Found} rather than throwing on a missing row: the local
 * projection can go stale (an account renamed or deleted upstream before the mirror catches up),
 * and that is an expected outcome every caller must handle, not an exceptional one. `Found<T>` is
 * the one "unknown entity" representation used across all six ports — chosen over plain `T | null`
 * because "no such row" and "the row exists but this field is null" must stay distinguishable, and
 * a stale projection makes that distinction real rather than theoretical.
 */

import type { Platform } from '#src/platforms/types.ts';

/** The result of looking up an entity that may not exist in the local projection. */
export type Found<T> = { readonly found: true; readonly value: T } | { readonly found: false };

export function found<T>(value: T): Found<T> {
  return { found: true, value };
}

export const NOT_FOUND: Found<never> = { found: false };

export interface WorkspaceRecord {
  readonly id: string;
  readonly name: string;
  readonly contactLimitMonthly: number;
}

export interface Workspaces {
  findById(workspaceId: string): Promise<Found<WorkspaceRecord>>;
}

export interface ApiKeyRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly keyHash: string;
  readonly rateLimitPerMin: number | null;
  readonly revokedAt: Date | null;
}

export interface ApiKeys {
  findByPrefix(prefix: string): Promise<Found<ApiKeyRecord>>;
}

export type SocialAccountStatus = 'active' | 'disconnected';

/**
 * `status` is the **effective** status (D30): `active` only when the `social_accounts` projection
 * row says `active` and this service's own `account_health` table (written by
 * `src/modules/comments/infrastructure/account-health.ts`) holds no `auth_failed` row for the
 * account. Every implementation of {@link Accounts} must compose the two on read — a caller must
 * never be able to reach the raw projection column instead.
 */
export interface SocialAccountRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly platform: string;
  readonly platformAccountId: string;
  readonly username: string;
  readonly status: SocialAccountStatus;
}

export interface Accounts {
  findById(socialAccountId: string): Promise<Found<SocialAccountRecord>>;
}

export interface PostRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly socialAccountId: string;
  readonly platform: string;
  readonly platformPostId: string;
  readonly publishedAt: Date;
}

export interface Posts {
  findById(postId: string): Promise<Found<PostRecord>>;
}

/** Fields every platform's credential record carries, regardless of what else it needs. */
interface AccountCredentialsBase {
  readonly socialAccountId: string;
  readonly token: Buffer;
}

/**
 * The Meta arm of {@link AccountCredentialsRecord} — the only one carrying `authVariant` (D28).
 * `src/platforms/meta/graph-client.ts` is the only adapter code allowed to read it; every other
 * platform's arm of the union has no such field to read in the first place.
 */
interface MetaAccountCredentials extends AccountCredentialsBase {
  readonly platform: 'instagram' | 'facebook';
  readonly authVariant: 'facebook_login' | 'instagram_login' | null;
}

/** Every platform besides Meta's two — no login-variant concept, so no such field. */
interface OtherAccountCredentials extends AccountCredentialsBase {
  readonly platform: Exclude<Platform, 'instagram' | 'facebook'>;
}

/**
 * A decrypted platform token, live only for the duration of the call that requested it (D26).
 * Nothing outside the `AccountCredentials` implementation may hold `credentials_ciphertext`; a
 * caller that needs it decrypted gets exactly this record and must not cache `token` beyond the
 * one call it was fetched for.
 *
 * Discriminated on `platform` rather than one flat shape with an Instagram-only field on every
 * arm (D28, Principle IV): a prior review removed the same field from `AccountContext` for the
 * same reason, and a flat `authVariant` here would have quietly put it back — every non-Meta
 * adapter, Bluesky included, would receive a struct carrying Instagram vocabulary it has no use
 * for and must not branch on.
 */
export type AccountCredentialsRecord = MetaAccountCredentials | OtherAccountCredentials;

export interface AccountCredentials {
  findBySocialAccountId(socialAccountId: string): Promise<Found<AccountCredentialsRecord>>;
}

/** The publish event this service reacts to — see {@link PostPublished}. */
export interface PublishedPostInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly socialAccountId: string;
  readonly platform: string;
  readonly platformPostId: string;
  readonly platformMeta?: Record<string, unknown>;
  readonly publishedAt: Date;
}

/**
 * The inbound seam through which a published post enters this service (§7.3). In the platform the
 * publishing service calls this when it publishes a post; in this deployment
 * `scripts/seed-account.ts` calls it instead, standing in for that service. The implementation
 * mirrors the event into the local `posts` projection — turning it into an active sync target is
 * `src/modules/comments/infrastructure/sync-target-repository.ts`'s job, not this port's.
 */
export interface PostPublished {
  notify(post: PublishedPostInput): Promise<void>;
}
