/**
 * Read-only local projection of platform-core data (spec.md §5.1, D8, D29).
 *
 * `workspaces`, `api_keys`, `social_accounts` and `posts` are owned by other services in the
 * platform (workspaces, accounts, publishing). This service mirrors them here only so its hot
 * paths — authenticating a key, resolving a post, loading an account — avoid a network call per
 * request; it is filled by the seed script in this deployment and by platform events in the real
 * one. This file exists so Drizzle can read the tables and so the seed/test path can create them.
 *
 * Nothing in this service writes these tables except the seed script, which stands in for the
 * services that actually own the rows. No table in `src/modules/comments` may declare a foreign
 * key or SQL join against any table below (D29) — reach them only through the ports in
 * `platform-core` (`AccountCredentials`, `ContactQuota`, etc.), never with a query of your own.
 */

import { customType, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { WorkspaceId } from '#src/shared/ids.ts';

/**
 * `bytea` — drizzle-orm 0.45.2's `pg-core` has no built-in bytea column, so it is declared as a
 * custom type mapped to `Buffer` (matches what `node-postgres` returns for `bytea`).
 */
const bytea = customType<{ data: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().$type<WorkspaceId>(),
  name: text('name').notNull(),
  contactLimitMonthly: integer('contact_limit_monthly').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull().$type<WorkspaceId>(),
  prefix: text('prefix').notNull().unique(),
  keyHash: text('key_hash').notNull(),
  name: text('name').notNull(),
  rateLimitPerMin: integer('rate_limit_per_min'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

/**
 * `authVariant` is Instagram-only (D28): `facebook_login` / `instagram_login` for Instagram, null
 * for every other platform. Exactly one file is allowed to read it —
 * `src/platforms/meta/graph-client.ts` (T066); everywhere else, platform differences stay inside
 * adapters (Principle IV), and this column must not leak into use-case branching.
 *
 * `credentialsCiphertext` / `credentialsKeyVersion` pair together (see `src/shared/crypto.ts`) and
 * are reachable only through the `AccountCredentials` port (D26) — never read directly off this
 * table outside that port's implementation.
 */
export const socialAccounts = pgTable('social_accounts', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull().$type<WorkspaceId>(),
  platform: text('platform').notNull(),
  platformAccountId: text('platform_account_id').notNull(),
  username: text('username').notNull(),
  authVariant: text('auth_variant', { enum: ['facebook_login', 'instagram_login'] }),
  credentialsCiphertext: bytea('credentials_ciphertext').notNull(),
  credentialsKeyVersion: integer('credentials_key_version').notNull(),
  status: text('status', { enum: ['active', 'disconnected'] }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const posts = pgTable('posts', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull().$type<WorkspaceId>(),
  socialAccountId: uuid('social_account_id').notNull(),
  platform: text('platform').notNull(),
  platformPostId: text('platform_post_id').notNull(),
  platformMeta: jsonb('platform_meta'),
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});
