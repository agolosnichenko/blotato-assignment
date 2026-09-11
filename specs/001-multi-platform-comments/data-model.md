# Phase 1 Data Model: Multi-Platform Comment System

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Source**: `spec.md` §5

All ids are UUIDv7, generated in the application (R-06). All timestamps are `timestamptz`. The
service owns every table below; the four in §1 are a read-only projection of data owned elsewhere.

## 1. Read-only projection of other services' data (D8, D29)

These mirror data owned by the workspaces, accounts and publishing services so the hot paths —
authenticating a key, resolving a post, loading an account — make no network call per request. This
service **reads** them and never writes them; in this deployment they are filled by the seed script,
in the platform by events from their owners. A stale or missing row is a normal condition: the port
reports the entity as unknown, and the request becomes `404` or the job is parked.

| Table | Columns | Notes |
|-------|---------|-------|
| `workspaces` | `id`, `name`, `contact_limit_monthly`, `created_at` | `contact_limit_monthly` is read through the `ContactQuota` port; in the platform it comes from billing entitlements (D16) |
| `api_keys` | `id`, `workspace_id`, `prefix` (unique), `key_hash`, `name`, `rate_limit_per_min`, `revoked_at`, `created_at` | `key_hash` is `sha256(secret)`; lookup is by `prefix`, comparison is constant-time |
| `social_accounts` | `id`, `workspace_id`, `platform`, `platform_account_id`, `username`, `auth_variant`, `credentials_ciphertext` (bytea), `credentials_key_version`, `status`, `created_at` | `auth_variant` is `facebook_login` / `instagram_login` for Instagram, null elsewhere (D28); ciphertext is read only through the `AccountCredentials` port (D26); `status` is `active` / `disconnected` (A19) |
| `posts` | `id`, `workspace_id`, `social_account_id`, `platform`, `platform_post_id`, `platform_meta` (jsonb), `published_at`, `created_at` | a post is visible to this feature only once it has a `platform_post_id` (A1); `platform_meta` carries e.g. the Bluesky `cid` |

**Boundary rule**: no table in §2 or §3 has a foreign key into these, and no query joins across the
boundary (D29, Principle II). `workspace_id`, `social_account_id` and `post_id` are plain `uuid`
columns validated on write through ports.

## 2. `comments` — the central entity

Maps to the **Comment** and **Conversation thread** entities in the feature specification.

| Column | Type | Meaning |
|--------|------|---------|
| `id` | uuid PK | |
| `workspace_id` | uuid not null | external reference, no FK; denormalized so every query is scoped in one predicate (D20) |
| `social_account_id` | uuid not null | external reference, no FK |
| `platform` | text not null | |
| `post_id` | uuid null | external reference, no FK; null for posts not published through the platform (D13) |
| `platform_post_id` | text not null | the durable anchor — survives the `posts` row disappearing (A10a) |
| `parent_comment_id` | uuid null, FK → `comments` `ON DELETE CASCADE` | null means top-level |
| `root_comment_id` | uuid null, FK → `comments` | the top-level ancestor; null on the top-level comment itself |
| `depth` | smallint not null | 0 = top-level |
| `platform_comment_id` | text null | null until `posted` |
| `platform_meta` | jsonb not null default `{}` | e.g. the Bluesky `cid` needed to reply |
| `is_own` | boolean not null | the author is the connected account, decided by author identity, not by origin (A2) |
| `source` | text not null | `api` / `webhook` / `sync` |
| `author_platform_id`, `author_username`, `author_display_name` | text null | nulled on deletion |
| `text` | text null | nulled on deletion (PII) |
| `status` | text not null | `queued` / `processing` / `posted` / `failed` / `deleted` |
| `error_code`, `error_message` | text null | set only when `failed` |
| `attempt_count` | int not null default 0 | |
| `last_attempt_started_at` | timestamptz null | the lower bound of the reconciliation window (§7.1 step 6) |
| `idempotency_key` | text null | optional, lives as long as the comment (A12) |
| `reply_count` | int not null default 0 | direct replies whose status is not `deleted` |
| `last_activity_at` | timestamptz not null | on the root: the newest `occurred_at` in the thread; the retention key (A9) |
| `occurred_at` | timestamptz not null | the sort key — platform time when ingested, request time when created here |
| `created_at`, `updated_at`, `deleted_at` | timestamptz | |

### Constraints

| Constraint | Invariant it enforces |
|------------|----------------------|
| `UNIQUE (social_account_id, platform_comment_id) WHERE platform_comment_id IS NOT NULL` | one comment per platform identifier, whichever channel brought it — FR-017, SC-003, and the collision that resolves the webhook-echo race |
| `UNIQUE (workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL` | FR-013 — the same key cannot produce two comments |
| `CHECK (status <> 'posted' OR platform_comment_id IS NOT NULL)` | a comment cannot claim to be published without proof |
| `CHECK ((parent_comment_id IS NULL) = (depth = 0))` | depth and parenthood cannot disagree |

### Indexes

| Index | Serves |
|-------|--------|
| `(post_id, occurred_at DESC, id DESC) WHERE parent_comment_id IS NULL` | a post's top-level page (FR-001) |
| `(parent_comment_id, occurred_at ASC, id ASC)` | a replies page (FR-002) |
| `(social_account_id, occurred_at DESC, id DESC)` | the account inbox (FR-008) |
| `(last_activity_at) WHERE parent_comment_id IS NULL` | the retention purge (FR-029) |
| `(status, last_attempt_started_at) WHERE status IN ('queued','processing')` | the stuck-work sweeper |

Each list index serves both `order` values: PostgreSQL scans a B-tree backwards, so D27 costs no
extra index.

### Status state machine

```text
                      ┌──────────────► deleted   (platform delete event, or a complete refresh
                      │                           finding it gone; text and author nulled)
  (api)   queued ─► processing ─► posted
             ▲            │
             └── retry ───┤        (RetryableError, bounded backoff, honouring Retry-After)
                          └─────► failed         (PermanentError / AuthError / attempts exhausted;
                                                  quota reservation released)

  (webhook | sync) ─────────────► posted         (ingested comments enter already published)
```

Rules that make the machine safe (Principle III):

- Every transition is a conditional `UPDATE ... WHERE status = <expected>`; the affected-row count
  decides the next step, so a second worker's attempt is a no-op rather than a second publish.
- `processing → posted` after an unknown outcome is only reached through `findPublishedComment`,
  searched no earlier than `last_attempt_started_at − 2 min` (FR-011, SC-001).
- Only a *complete* refresh walk may move a comment to `deleted`; an interrupted walk infers nothing
  (FR-019, SC-008).
- `reply_count` on the parent and `last_activity_at` on the root move in the same transaction as the
  insert or the delete that causes them.

## 3. Module-internal tables

| Table | Purpose | Columns |
|-------|---------|---------|
| `comment_sync_targets` | The per-post refresh schedule (**Refresh target**) | `id`, `workspace_id`, `social_account_id`, `post_id` (null for external posts), `platform_post_id`, `last_synced_at`, `next_sync_at` (null = deactivated), `last_error`, `manual_cooldown_until`. `UNIQUE (social_account_id, platform_post_id)` |
| `comment_sync_jobs` | One reconciliation attempt, exposed as an API resource (**Refresh job**, D19) | `id`, `workspace_id`, `target_id`, `trigger` (`manual` / `scheduled` / `post_published`), `status` (`queued` / `running` / `succeeded` / `failed`), `stats` jsonb (`fetched`, `inserted`, `updated`, `deleted`), `error`, `created_at`, `started_at`, `finished_at`. A partial unique index allows at most one active job per target |
| `webhook_deliveries` | Raw pushed payloads, stored before processing so nothing is lost | `id`, `provider`, `payload` jsonb, `received_at`, `processed_at`, `attempts`, `error`. Purged after 7 days |
| `outbox_events` | **Notification** — written in the state-change transaction, relayed afterwards (D9) | `id`, `workspace_id`, `type`, `aggregate_id`, `payload` jsonb, `created_at`, `published_at`, `attempts`. Purged 7 days after publication |
| `contact_quota_usage` | **Audience-contact usage** — one row per person per month per platform (D16, A8) | `workspace_id`, `period` (`YYYY-MM`), `platform`, `contact_platform_id`, `comment_id`, `created_at`. PK `(workspace_id, period, platform, contact_platform_id)`. Purged after two periods |

`webhook_deliveries` and `outbox_events` are what make FR-033 / SC-011 true: an accepted write lives
in `comments`, a received event in `webhook_deliveries` and an unsent notification in `outbox_events`
— all in PostgreSQL, none in Redis. Losing Redis loses scheduling, not data.

## 4. Platform capability entry (not a table)

The **Platform capability entry** is code, not data: a literal registry in `src/platforms/registry.ts`
covering all nine publishing platforms (§8.1, FR-031).

| Field | Meaning |
|-------|---------|
| `platform` | the platform key |
| `supportsComments` | false for six of the nine |
| `canCreateTopLevel`, `canReply` | allowed write operations |
| `maxReplyDepth` | 1 for Instagram and Facebook, `null` (unbounded) for Bluesky (A20) |
| `textLimit`, `textUnit` | 2200 / 8000 characters for Meta, 300 graphemes for Bluesky (R-07) |
| `ingestion` | `webhook+sync` for Meta, `sync` for Bluesky |
| `unsupportedReason` | required when `supportsComments` is false |

It is a registry rather than a table because it changes with a release, not with data — and because
Principle IV requires that adding a platform touch no migration.
