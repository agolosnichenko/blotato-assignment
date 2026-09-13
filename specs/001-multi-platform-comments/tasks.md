---
description: "Task list for the multi-platform comment system"
---

# Tasks: Multi-Platform Comment System

**Input**: Design documents from `/specs/001-multi-platform-comments/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: Included. The root `spec.md` §11, the feature `quickstart.md` (V1–V11) and Constitution
Principle V all require them, and three invariants — deduplication, reconciliation, tenancy — must be
broken once to prove the test fails (T103).

**Organization**: Grouped by user story so each is independently implementable and testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel — different files, no dependency on an incomplete task
- **[Story]**: `US1`–`US5`, matching the user stories in `spec.md`
- Every task names the exact file path it touches

## Path Conventions

Single backend service at the repository root: `src/`, `scripts/`, `drizzle/`. Tests live beside the
code as `*.test.ts` (unit, no containers) and `*.integration.test.ts` (testcontainers), the
convention already set by `src/app/api.integration.test.ts`.

**Already in place** (do not recreate): `src/app/{api,worker,config}.ts`,
`src/shared/{db,logger,queue}.ts`, `docker-compose.yml`, `Dockerfile`, `vitest.config.ts`,
`tsconfig.json`, `.github/`, oxlint/oxfmt configuration.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: bring the toolchain up to what the plan requires before any code is written.

- [X] T001 Add the exact-pinned dependencies from research.md to `package.json`: `drizzle-kit`
      0.31.10 (R-01), `fastify-type-provider-zod` 7.0.0 + `@fastify/swagger` 9.8.1 +
      `@fastify/swagger-ui` 6.1.1 (R-03), `@fastify/rate-limit` 11.2.0 (R-05), `uuidv7` 1.2.1
      (R-06). No `^` or `~`; `.npmrc` `minimum-release-age=1440` means a release younger than 24 h
      is pinned to the previous version rather than lifting the setting
- [X] T002 Create `drizzle.config.ts` at the repository root pointing at the schema files and
      `drizzle/` output, and add `db:generate` / `db:migrate` scripts to `package.json` (R-01)
- [X] T003 [P] Add `seed:account`, `create-api-key`, `generate-openapi` and `smoke` script entries to
      `package.json`, each invoking the matching file under `scripts/` through `tsx`. The entries
      point at files created later (T038, T039, T107, T108); nothing runs them until then, so this is
      declaration, not a broken build
- [X] T004 [P] Extend `.env.example` with every variable the feature introduces:
      `CREDENTIALS_ENCRYPTION_KEY`, `CREDENTIALS_KEY_VERSION`, `META_APP_SECRET`,
      `META_APP_SECRET_INSTAGRAM`, `META_WEBHOOK_VERIFY_TOKEN`, `META_GRAPH_API_VERSION`,
      `RETENTION_DAYS` (default 45), `SYNC_INTERVALS_*` for the age bands per platform family (§7.3)
      — the bands' **upper edge is `RETENTION_DAYS`, not a separate variable**, so the two cannot
      drift apart (T085) — `SYNC_MANUAL_COOLDOWN_SECONDS` (60), `RATE_LIMIT_READS_PER_MIN` (30) and
      `RATE_LIMIT_WRITES_PER_MIN` (5), the last two being defaults that `api_keys.rate_limit_per_min`
      may lower but never raise (T034). No real secret value — the demo key is never committed (D25)
- [X] T005 [P] Add an `openapi-drift` step to `.github/workflows/` that runs `pnpm generate-openapi`
      and fails if the committed `openapi.json` differs (D18, R-03). **Commit it in the same change
      as T107**, which creates `scripts/generate-openapi.ts` and the first `openapi.json`: a CI step
      calling a script that does not exist yet fails every pull request until Phase 8, and a
      permanently red gate is a gate nobody reads
- [X] T006 [P] Add a testcontainers helper in `src/shared/testing/containers.ts` that starts
      PostgreSQL + Redis and applies the committed `drizzle/` migrations, so the test schema and the
      deployed schema cannot drift (R-01)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the schema, the service boundary, the shared primitives and the HTTP plumbing that every
user story sits on.

**⚠️ CRITICAL**: no user story work begins until this phase is complete.

### Shared primitives

- [X] T007 Extend the Zod schema in `src/app/config.ts` with every variable added in T004, failing
      fast with all problems listed; `CREDENTIALS_ENCRYPTION_KEY` must validate as exactly 32 bytes
      of base64, `RETENTION_DAYS` as a positive integer defaulting to 45
- [X] T008 [P] Add cases to `src/app/config.test.ts` covering a missing required variable, a
      malformed encryption key and applied defaults
- [X] T009 [P] Create `src/shared/ids.ts` exporting a UUIDv7 generator over the `uuidv7` package —
      ids are generated in the application because the outbox row, the BullMQ `jobId` and the
      `Location` header all need the id before the insert returns (R-06, A15)
- [X] T010 [P] Create `src/shared/crypto.ts`: AES-256-GCM encrypt/decrypt carrying `key_version`,
      `sha256` hashing for API-key secrets, and a constant-time comparison wrapper over
      `crypto.timingSafeEqual` that tolerates length mismatch without leaking timing (§10)
- [X] T011 [P] Create `src/shared/crypto.test.ts`: round-trip encryption, decryption failure on a
      tampered ciphertext, and rejection of a wrong `key_version`
- [X] T012 [P] Create `src/shared/pagination.ts`: the opaque base64url keyset cursor codec encoding
      `(occurredAt, id)` **and** the `order` direction, with a decode that rejects a cursor presented
      under a different `order` (D27, A13, R-02)
- [X] T013 [P] Create `src/shared/pagination.test.ts` with a fast-check round-trip property plus
      explicit cases: malformed base64, a truncated payload, and a `desc` cursor replayed as `asc`
- [X] T014 [P] Create `src/shared/errors.ts`: an RFC 9457 `application/problem+json` mapper and the
      complete §6.3 code catalogue as a typed union — `VALIDATION_ERROR`, `UNAUTHORIZED`,
      `NOT_FOUND`, `IDEMPOTENCY_KEY_REUSED`, `PLATFORM_NOT_SUPPORTED`, `REPLY_DEPTH_EXCEEDED`,
      `TEXT_TOO_LONG`, `PARENT_NOT_POSTED`, `ACCOUNT_DISCONNECTED`, `QUOTA_EXCEEDED`,
      `RATE_LIMITED`, `SYNC_COOLDOWN`, plus the asynchronous `PLATFORM_REJECTED`,
      `PLATFORM_AUTH_FAILED`, `PLATFORM_RATE_LIMITED`, `PARENT_DELETED`, `OUTCOME_UNKNOWN`
      (contracts/rest-api.md)
- [X] T015 [P] Extend `src/shared/logger.ts` redaction to cover the `blotato-api-key` header,
      platform tokens and **comment text**, and to stamp `requestId` or `jobId` on every entry —
      under A22 these logs are the whole observability surface (§10)

### Schema and migrations

- [X] T016 Create `src/modules/platform-core/schema.ts` — the read-only projection of §5.1:
      `workspaces` (`id`, `name`, `contact_limit_monthly`, `created_at`), `api_keys` (`id`,
      `workspace_id`, `prefix` unique, `key_hash`, `name`, `rate_limit_per_min`, `revoked_at`,
      `created_at`), `social_accounts` (`id`, `workspace_id`, `platform`, `platform_account_id`,
      `username`, `auth_variant` — `facebook_login`/`instagram_login` for Instagram, null elsewhere,
      `credentials_ciphertext` bytea, `credentials_key_version`, `status` — `active`/`disconnected`,
      `created_at`), `posts` (`id`, `workspace_id`, `social_account_id`, `platform`,
      `platform_post_id`, `platform_meta` jsonb, `published_at`, `created_at`)
- [X] T017 Create `src/modules/comments/infrastructure/schema.ts` with the `comments` table exactly
      as data-model.md §2 specifies. Not-null: `workspace_id`, `social_account_id`, `platform`,
      `platform_post_id`, `depth` (smallint, 0 = top-level), `platform_meta` (jsonb default `{}`),
      `is_own`, `source` (`api`/`webhook`/`sync`), `status`
      (`queued`/`processing`/`posted`/`failed`/`deleted`), `attempt_count` (int default 0),
      `reply_count` (int default 0), `last_activity_at`, `occurred_at`. Nullable: `post_id`,
      `parent_comment_id` (FK → `comments` `ON DELETE CASCADE`), `root_comment_id` (FK →
      `comments`), `platform_comment_id`, `author_platform_id`, `author_username`,
      `author_display_name`, `text`, `error_code`, `error_message`, `last_attempt_started_at`,
      `idempotency_key`, `deleted_at`. **No FK on `workspace_id`, `social_account_id`, `post_id`**
      (D8, D29, Principle II)
- [X] T018 Add the four `comments` constraints from data-model.md to
      `src/modules/comments/infrastructure/schema.ts`:
      `UNIQUE (social_account_id, platform_comment_id) WHERE platform_comment_id IS NOT NULL`,
      `UNIQUE (workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL`,
      `CHECK (status <> 'posted' OR platform_comment_id IS NOT NULL)`,
      `CHECK ((parent_comment_id IS NULL) = (depth = 0))`
- [X] T019 Add the five `comments` indexes from data-model.md:
      `(post_id, occurred_at DESC, id DESC) WHERE parent_comment_id IS NULL`,
      `(parent_comment_id, occurred_at ASC, id ASC)`,
      `(social_account_id, occurred_at DESC, id DESC)`,
      `(last_activity_at) WHERE parent_comment_id IS NULL`,
      `(status, last_attempt_started_at) WHERE status IN ('queued','processing')`
- [X] T020 Add the module-internal tables of data-model.md §3 to
      `src/modules/comments/infrastructure/schema.ts`: `comment_sync_targets` (with
      `UNIQUE (social_account_id, platform_post_id)`, `next_sync_at` nullable where null means
      deactivated, `manual_cooldown_until`), `comment_sync_jobs` (`trigger`
      `manual`/`scheduled`/`post_published`, `status` `queued`/`running`/`succeeded`/`failed`,
      `stats` jsonb with `fetched`/`inserted`/`updated`/`deleted`, plus a partial unique index
      allowing at most one active job per target), `webhook_deliveries`, `outbox_events`,
      `contact_quota_usage` with PK `(workspace_id, period, platform, contact_platform_id)`, and
      `account_health` (`social_account_id` PK — external reference, **no FK**, `workspace_id`,
      `state` `auth_failed`, `reason`, `detected_at`), which is how an `AuthError` is recorded
      without writing the read-only `social_accounts` projection (D30, Principle II)
- [X] T021 Run `pnpm db:generate` and commit the resulting SQL under `drizzle/`, reading the diff to
      confirm the partial unique indexes and `CHECK` constraints appear verbatim — they are the
      schema-level half of Principle III (R-01)

### Service boundary

- [X] T022 Create `src/modules/platform-core/ports.ts` declaring the whole boundary in one file:
      `Workspaces`, `ApiKeys`, `Accounts`, `Posts`, `AccountCredentials`, `PostPublished` (D8, D29)
- [X] T023 Implement the ports against the projection in `src/modules/platform-core/local/` — one
      file per port, each returning "unknown entity" for a stale or missing row rather than throwing.
      `AccountCredentials` decrypts through `src/shared/crypto.ts` and is the **only** path to a
      platform token (D26). `Accounts` returns an **effective** status: `active` only when the
      projection row says `active` **and** `account_health` holds no `auth_failed` row for it — the
      read is what makes D30 work, and every caller sees the composed value, never the raw column
- [X] T023a Create `src/modules/comments/infrastructure/account-health.ts`: `markAuthFailed`
      (upsert `account_health` with the reason) and `clear` (called when the projection row returns
      to `active`). **This module never issues an `UPDATE` against `social_accounts`** — the
      projection stays read-only and the accounts service remains the owner of the status (D30)
- [X] T024 [P] Create `src/modules/platform-core/local/local-ports.integration.test.ts` asserting
      that a missing projection row reports the entity as unknown, that no query in this module
      joins a `comments` table, and that an `auth_failed` row in `account_health` makes `Accounts`
      report the account disconnected while `social_accounts.status` is left untouched (D30, A19)

### Platform abstraction

- [X] T025 [P] Create `src/platforms/types.ts`: the `CommentPlatformAdapter` interface with
      `listComments`, `publishComment`, `findPublishedComment`, `fetchComment`; the `AccountContext`,
      `PostTarget`, `CommentPage`, `PublishInput`, `PublishedComment`, `ReconcileProbe` and
      `NormalizedComment` types; the `WebhookNormalizer` port with its `IngestionEvent`
      (`upsert`/`delete`); and the four typed errors `RetryableError` (optional `retryAfter`),
      `OutcomeUnknownError`, `PermanentError`, `AuthError` (contracts/platform-adapter.md)
- [X] T026 [P] Create `src/platforms/registry.ts` with all nine publishing platforms (§8.1, FR-031):
      `instagram` (comments yes, top-level yes, reply yes, `maxReplyDepth` 1, `textLimit` 2200,
      `textUnit` characters, `ingestion` `webhook+sync`), `facebook` (same but `textLimit` 8000),
      `bluesky` (`maxReplyDepth` null = unbounded per A20, `textLimit` 300, `textUnit` graphemes,
      `ingestion` `sync`), and `threads`, `x`, `linkedin`, `youtube`, `tiktok`, `pinterest` with
      `supportsComments: false` and a required `unsupportedReason`
- [X] T027 [P] Create `src/platforms/registry.test.ts`: every entry with `supportsComments: false`
      carries a non-empty `unsupportedReason`, exactly nine entries exist, and exactly three support
      comments

### Domain rules

- [X] T028 [P] Create `src/modules/comments/domain/status.ts`: the
      `queued → processing → posted | failed` machine plus `deleted`, expressed as allowed
      transitions, so every repository move can be a conditional `UPDATE ... WHERE status =
      <expected>` (data-model.md §2, R-10)
- [X] T029 [P] Create `src/modules/comments/domain/limits.ts`: a registry-driven depth check
      (`depth + 1 ≤ maxReplyDepth`, unbounded when null) and text-length check counting UTF-16
      characters where `textUnit` is characters and graphemes via `Intl.Segmenter` with
      `granularity: 'grapheme'` where it is graphemes. **No platform `switch` anywhere in this file**
      (R-07, Principle IV)
- [X] T030 [P] Create `src/modules/comments/domain/limits.test.ts`: Instagram depth 1 accepted /
      depth 2 rejected, Bluesky depth 5 accepted, a 300-grapheme Bluesky string with emoji accepted
      where its UTF-16 length exceeds 300, and a 2201-character Instagram string rejected

### Outbox

- [X] T031 Create `src/modules/comments/infrastructure/outbox.ts` with a writer that inserts an
      `outbox_events` row **inside a caller-supplied transaction** — the signature must make it
      impossible to call outside one — and the envelope shape
      `{ id, type, version: 1, occurredAt, workspaceId, data }` (D9, contracts/domain-events.md)
- [X] T032 Create `src/modules/comments/infrastructure/outbox-relay.ts`: a job selecting unpublished
      rows with `FOR UPDATE SKIP LOCKED` in batches of 100, publishing to the `domain-events` queue
      with `jobId = event.id`, then stamping `published_at` (§9.1)

### HTTP plumbing

- [X] T033 Create `src/modules/comments/http/auth.ts`: a Fastify plugin resolving the
      `blotato-api-key` header — parse `blt_<prefix>_<secret>`, look up by `prefix`, compare
      `sha256(secret)` in constant time, reject a revoked key — and decorating the request with the
      resolved `workspaceId` (A16, §10). Missing, unrecognized or revoked → `401 UNAUTHORIZED`
- [X] T034 Register `@fastify/rate-limit` in `src/app/api.ts` with a Redis store keyed by the
      resolved api key id (never by IP), emitting `RateLimit-*` and `Retry-After`, and mapping the
      rejection to `429 RATE_LIMITED` in problem+json (R-05, FR-027). Two buckets per key, read and
      write, and **one rule for which limit applies**: `RATE_LIMIT_READS_PER_MIN` /
      `RATE_LIMIT_WRITES_PER_MIN` give the defaults, and `api_keys.rate_limit_per_min`, when
      non-null, is a per-key **ceiling** over both — effective read is `min(env read, column)`,
      effective write is `min(env write, column)`. A ceiling rather than a replacement is what keeps
      the §10 demo figures intact (column 30 → 30 reads and still 5 writes) and makes a per-key value
      unable to raise a budget above the deployment's own
- [X] T035 Register a global error handler in `src/app/api.ts` that serializes every failure through
      `src/shared/errors.ts` as `application/problem+json`, including Zod validation failures as
      `400 VALIDATION_ERROR` (FR-032)
- [X] T036 Register `@fastify/swagger`, `@fastify/swagger-ui` at `/docs` and
      `fastify-type-provider-zod` in `src/app/api.ts`, so one Zod schema object serves validation,
      static types and the OpenAPI document (R-03)
- [X] T037 Create `src/app/container.ts` wiring config, database, redis, ports, repositories,
      adapters and use cases, shared by both the `api` and `worker` roles, and consume it from
      `src/app/api.ts` and `src/app/worker.ts`

### Scripts

- [X] T038 [P] Create `scripts/create-api-key.ts`: generate a secret with ≥ 32 bytes of entropy,
      store `prefix` + `sha256(secret)`, print the full `blt_<prefix>_<secret>` **once** and never
      again — it cannot be recovered from the row (§10, D25)
- [X] T039 [P] Create `scripts/seed-account.ts`: a demo workspace with `contact_limit_monthly`, an
      api key, connected Instagram / Facebook / Bluesky accounts with encrypted credentials, and
      published posts — calling the `PostPublished` port for each so they are registered as refresh
      targets, which is what the publishing service would do in the platform (§7.3)

**Checkpoint**: schema migrated, boundary enforced, registry populated, API authenticates and
rate-limits. User stories can now proceed.

---

## Phase 3: User Story 1 - Read the conversation under a published post (Priority: P1) 🎯 MVP

**Goal**: a trustworthy, correctly ordered, gap-free read model over a post's comments and one
thread's replies, with stated freshness.

**Independent Test**: ingest a post's comments, page through the top-level list and one thread's
replies in both orderings, and verify no duplicates, no gaps, correct reply counts and a stated
freshness timestamp — without ever writing to a platform.

### Tests for User Story 1 ⚠️

> Write these first and confirm they fail before implementing.

- [X] T040 [P] [US1] Create `src/modules/comments/http/post-comments.integration.test.ts` (V1): seed
      30 top-level comments, page with `limit=20` in both `order` directions, follow the cursor, then
      insert 5 more comments between two page requests and follow it again — every pre-existing
      comment exactly once, no gaps, correct `replyCount`, a `sync.lastSyncedAt`, and `400
      VALIDATION_ERROR` when the cursor is replayed with the other `order` (FR-001, FR-003, FR-004,
      FR-006, SC-002, D27)
- [X] T041 [P] [US1] Create `src/modules/comments/http/replies.integration.test.ts` (V1): a comment
      with 3 direct replies returns them oldest first by default, the parent reports `replyCount: 3`,
      and a deleted comment with live replies comes back as a placeholder with `text: null` and a
      null author while a deleted comment with no replies is absent entirely (FR-002, FR-005, A4)
- [X] T042 [P] [US1] Create `src/modules/comments/http/get-comment.integration.test.ts`: a single
      comment fetched by id, and another workspace's comment returning `404 NOT_FOUND` rather than
      `403` (FR-007, D20)

### Implementation for User Story 1

- [X] T043 [US1] Create `src/modules/comments/infrastructure/comment-repository.ts` with the read
      side: `listTopLevelByPost`, `listRepliesByParent`, `getById`. **Every method takes
      `workspaceId` as a required parameter** and scopes its predicate on it; a row belonging to
      another workspace is simply not found (D20, FR-026)
- [X] T044 [US1] Implement keyset paging in `src/modules/comments/infrastructure/comment-repository.ts`
      using `(occurred_at, id)` with both components in the comparison and the direction taken from
      the decoded cursor, so the query drives the index of T019 in either scan direction (R-02)
- [X] T045 [P] [US1] Create `src/modules/comments/application/list-post-comments.ts` — top-level
      comments for a post, defaulting to `desc`, and the `sync` block reporting `lastSyncedAt` and
      the active job id from `comment_sync_targets` / `comment_sync_jobs` (FR-001, FR-006)
- [X] T046 [P] [US1] Create `src/modules/comments/application/list-replies.ts` — direct replies of one
      comment as a separately paged list, defaulting to `asc` (FR-002, FR-003, D11)
- [X] T047 [P] [US1] Create `src/modules/comments/application/get-comment.ts` — one comment by id,
      the polling target for a pending write (FR-007)
- [X] T048 [US1] Create `src/modules/comments/http/schemas.ts` with the Zod schemas for the `Comment`
      representation of contracts/rest-api.md — including `error` as `{ code, message }` only when
      `status` is `failed` and null otherwise, and `postId` nullable — plus the shared `limit` (1–100,
      default 20), `cursor` and `order` query schema. The placeholder rule for deleted comments is
      T050's alone, so the two tasks do not each half-own it
- [X] T049 [US1] Create `src/modules/comments/http/routes.ts` registering
      `GET /v1/posts/:postId/comments`, `GET /v1/comments/:commentId/replies` and
      `GET /v1/comments/:commentId` against the use cases, and register it from `src/app/api.ts`
- [X] T050 [US1] Apply the placeholder rule in `src/modules/comments/http/schemas.ts` and the
      repository: lists include every status except `deleted`; a `deleted` comment with surviving
      replies is returned with `text: null` and a null author, one with no replies is omitted
      (FR-005, A4)

**Checkpoint**: US1 is independently functional — the read model can be demonstrated end to end
against seeded data with no platform involved.

---

## Phase 4: User Story 2 - Reply publicly, exactly once (Priority: P1)

**Goal**: an accepted write that reaches the platform exactly once across the whole failure matrix.

**Independent Test**: submit a reply against a platform double that times out after accepting the
write, then confirm the service reconciles, finds its own reply and settles on `posted` with exactly
one comment on the platform and one row locally.

### Tests for User Story 2 ⚠️

- [X] T051 [P] [US2] Create `src/modules/comments/application/publish-comment.integration.test.ts`
      (V2) covering the full failure matrix against an adapter double: success; timeout after send;
      connection drop after send; `429` with `Retry-After`; permanent rejection; and the platform
      echoing our own reply back through ingestion while the worker is still publishing. Expect
      exactly one comment on the double and one row locally in every case; on an unknown outcome the
      worker reconciles through `findPublishedComment` and settles on `posted` without a second send;
      on permanent rejection the comment is `failed` and the quota reservation is released. Two more
      cases: an `AuthError` → `failed` + `PLATFORM_AUTH_FAILED`, an `auth_failed` row in
      `account_health`, an outbox `account.auth_failed`, the account reported disconnected by the
      port and **`social_accounts` byte-for-byte unchanged** (D30, A19); and a parent deleted *after*
      the child was queued → `failed` + `PARENT_DELETED` with the quota released and nothing sent to
      the platform (T060a) (FR-009, FR-011, FR-012, FR-014, SC-001, D14, §7.1 step 7)
- [X] T052 [P] [US2] Create `src/modules/comments/http/create-reply.integration.test.ts` (V3): reply
      to a reply on Instagram → `422 REPLY_DEPTH_EXCEEDED` whose `detail` names the top-level
      comment, the same depth on Bluesky → `202`; over-length text → `422 TEXT_TOO_LONG` with nothing
      sent; same `Idempotency-Key` with the same body → the original comment, with a different body →
      `409 IDEMPOTENCY_KEY_REUSED`; a write against a platform the registry marks unsupported →
      `422 PLATFORM_NOT_SUPPORTED` with nothing sent; a parent that is `queued`, `processing`,
      `failed` or `deleted` → `422 PARENT_NOT_POSTED` (all four states the contract lists, not three);
      a disconnected account → `422 ACCOUNT_DISCONNECTED`, asserted **both** for a projection row set
      to `disconnected` and for an active row carrying an `auth_failed` record, since the port
      composes the two (D30). Every
      rejection asserted to be `application/problem+json` carrying its `code` (FR-010, FR-013,
      FR-032, D12, A6, A19)
- [X] T053 [P] [US2] Create `src/modules/comments/infrastructure/contact-quota.integration.test.ts`
      (V3): two concurrent replies to the same new audience member consume the allowance once; with
      the allowance exhausted, a reply to a *new* person → `422 QUOTA_EXCEEDED` while a reply to
      someone already counted this period → `202`; a final failure releases the reservation (FR-014,
      D16, A8)
- [X] T054 [P] [US2] Create `src/modules/comments/infrastructure/outbox.integration.test.ts` (V6):
      an event appears only after the transaction commits, is relayed exactly once, and survives the
      queue being dropped between acceptance and relay (FR-025, FR-033, SC-011, D9)
- [X] T055 [P] [US2] Create `src/modules/comments/infrastructure/sweeper.integration.test.ts` (V6):
      a comment left `queued` for more than a minute with no active job is re-enqueued, and an
      accepted write is never silently abandoned (§7.1 step 4, R-10)

### Implementation for User Story 2

- [X] T056 [US2] Extend `src/modules/comments/infrastructure/comment-repository.ts` with the write
      side: `insertQueued` (incrementing the parent's `reply_count` and the root's `last_activity_at`
      in the same transaction), `findByIdempotencyKey`, and the conditional transitions
      `markProcessing`, `markPosted`, `markFailed`, `markQueuedForRetry` — each an
      `UPDATE ... WHERE status = <expected>` whose affected-row count decides the next step (R-10)
- [X] T057 [P] [US2] Create `src/modules/comments/infrastructure/contact-quota.ts` implementing the
      `ContactQuota` port: `pg_advisory_xact_lock` on `(workspace_id, period)` inside the inserting
      transaction, then the `contact_quota_usage` insert and the count check against
      `workspaces.contact_limit_monthly` read through the port, plus `release` on final failure
      (R-08, D16, A8)
- [X] T058 [US2] Create `src/modules/comments/application/create-reply.ts` implementing §7.1 steps
      1–4: load the parent inside the workspace scope (otherwise `404`); check platform capability,
      depth, text length, `status = posted` and account `active`; resolve idempotency by comparing
      the request hash; one transaction doing `ContactQuota.reserve` (only when the parent's author
      is not the account) → insert `comments(status=queued, is_own=true, source=api)` → `reply_count`
      and `last_activity_at` → outbox write; enqueue `comment-publish` with `jobId = comment.id`
      **after commit**
- [X] T059 [P] [US2] Create `src/modules/comments/application/create-top-level-comment.ts` — the same
      pre-flight and transaction for a top-level comment on an internally published post. A post with
      no internal id is unreachable by construction because the route is keyed by `postId` (FR-015,
      A7, D13)
- [X] T060 [US2] Create `src/modules/comments/application/publish-comment.ts` implementing §7.1 steps
      5–6: conditional `queued → processing` recording `last_attempt_started_at`, call
      `adapter.publishComment`, then branch on the typed error — success → `posted` +
      `platform_comment_id` + outbox `comment.posted`; `RetryableError` → back to `queued` with
      backoff 1s/4s/16s/64s/256s up to 6 attempts honouring `retryAfter`; `PermanentError` /
      `AuthError` → `failed` + code, quota released, outbox `comment.failed`. On `AuthError` the work
      for the account stops and its state is recorded through `account-health.ts` (T023a) plus outbox
      `account.auth_failed` — **never** an `UPDATE` on the `social_accounts` projection; the
      `Accounts` port then reports the account disconnected (D30, A19, Principle II)
- [X] T060a [US2] Re-check the parent in `src/modules/comments/application/publish-comment.ts`
      before calling the adapter: a parent that became `deleted` after the child was queued settles
      the child as `failed` with `PARENT_DELETED`, releasing the quota reservation and emitting
      outbox `comment.failed` — the pre-flight check of §7.1 step 1 ran at acceptance time and cannot
      cover a deletion that happened since (spec.md Edge Cases, contracts/rest-api.md §Error codes)
- [X] T061 [US2] Create `src/modules/comments/application/reconcile-comment.ts`: on
      `OutcomeUnknownError`, call `adapter.findPublishedComment` with our author, the same text and a
      window opening at `last_attempt_started_at − 2 min`; found → `posted`; not found → treat as
      retryable. **No retry path may bypass this** (FR-011, SC-001, D14)
- [X] T062 [US2] Handle the webhook-echo race in
      `src/modules/comments/application/publish-comment.ts` (§7.1 step 7): when the `posted` update
      collides with `UNIQUE (social_account_id, platform_comment_id)` because ingestion already
      inserted our own comment, delete the ingested duplicate and promote the API-created comment to
      `posted` with the platform id — **in one transaction**. In that same transaction delete the
      still-unpublished `comment.received` row the ingestion wrote for the duplicate: the comment it
      names is about to stop existing, so relaying it would tell consumers about a comment they can
      never read. If the relay already published it, leave it and let `comment.posted` follow —
      consumers de-duplicate on the aggregate, and events are at-least-once by contract (D9, FR-025)
- [X] T063 [US2] Create `src/modules/comments/infrastructure/publish-worker.ts`: the
      `comment-publish` BullMQ worker with a per-account Redis token bucket for concurrency, wiring
      the publish and reconcile use cases (§9.2)
- [X] T064 [US2] Create `src/modules/comments/infrastructure/sweepers.ts` with the stuck-work
      sweeper re-enqueueing comments left `queued` for more than a minute with no active job, and
      register it on the `scheduler` queue in `src/app/worker.ts` — **concurrency 1**, which is what
      keeps the relay's "published once" true (§9.2)
- [X] T065 [US2] Implement `publishComment` and `findPublishedComment` in
      `src/platforms/bluesky/adapter.ts`: session from handle + app password refreshed inside the
      adapter, `com.atproto.repo.createRecord` for `app.bsky.feed.post` with
      `reply: { root: {uri, cid}, parent: {uri, cid} }` where `root` is the post, facets detected via
      `RichText.detectFacets`, AT URIs as `platform_comment_id` and `cid` in `platform_meta` (§8.3)
- [X] T065a [P] [US2] Create `src/platforms/bluesky/facets.test.ts`: plain text carrying a URL, an
      `@handle` and a `#tag` produces the corresponding facets with correct byte offsets, and text
      with none produces an empty facet list. A5 makes deriving the markup this service's job rather
      than the caller's, so it is behaviour worth pinning — byte offsets over a multi-byte string are
      exactly where a hand-rolled version would drift
- [X] T066 [US2] Create `src/platforms/meta/graph-client.ts` over `undici`, resolving host and token
      from `auth_variant` — `graph.facebook.com` with a Page token for `facebook_login`,
      `graph.instagram.com` with an Instagram user token for `instagram_login` — with the API version
      from config, parsing `X-Business-Use-Case-Usage` / `X-App-Usage` to throttle that account's
      jobs. **This is the only file that knows `auth_variant` exists** (D28)
- [X] T067 [US2] Map Meta and Bluesky transport failures onto the four typed errors in
      `src/platforms/meta/errors.ts` and `src/platforms/bluesky/errors.ts`: 429/5xx/pre-send network
      failure → `RetryableError`; timeout or connection drop **after** the request was sent →
      `OutcomeUnknownError`; 4xx/explicit rejection → `PermanentError`; invalid credential →
      `AuthError`. Classifying a post-send failure as retryable is the one mistake that produces a
      duplicate public reply (contracts/platform-adapter.md)
- [X] T068 [US2] Implement `publishComment` and `findPublishedComment` in
      `src/platforms/meta/instagram-adapter.ts` and `src/platforms/meta/facebook-adapter.ts` over the
      shared Graph client: IG top-level `POST /{media-id}/comments`, IG reply
      `POST /{ig-comment-id}/replies`; FB top-level `POST /{post-id}/comments`, FB reply
      `POST /{comment-id}/comments` (§8.2)
- [X] T069 [US2] Add `POST /v1/posts/:postId/comments` and `POST /v1/comments/:commentId/replies` to
      `src/modules/comments/http/routes.ts`, both returning `202` with `status: "queued"` and a
      `Location` header pointing at `GET /v1/comments/:id` — `202` rather than `201` because the row
      exists and the platform action has not happened (A11, FR-009)

**Checkpoint**: US1 and US2 both work independently. The exactly-once guarantee is demonstrable.

---

## Phase 5: User Story 3 - Comments arrive on their own and stay accurate (Priority: P1)

**Goal**: push and refresh both feed one idempotent upsert path; a complete walk detects deletions and
an interrupted one infers none.

**Independent Test**: deliver the same platform event twice and run a refresh over the same post —
one stored comment, one emitted notification, correct counts — then delete the comment on the
platform side and verify a complete refresh marks it deleted.

### Spike gate ⚠️

> Principle I forbids building on unverified Meta behaviour, so the gate is per spike, not per phase:
> **S1 and S5 block T078–T081** (the webhook intake, its handshake, the normalizer and its worker);
> **S2 blocks T084** — Instagram comment reads are exactly what it verifies, and Meta's forum reports
> empty `data` for `/comments` in Standard Access via Instagram Login, so building the read path
> before the spike is building on a guess. Everything else in this phase, all of US1/US2, and the
> whole Bluesky path proceed without it (R-09).

- [X] T070 [US3] Run spikes S1, S2 and S5 as scripts under `scripts/spikes/` against the real Meta
      App and record the outcomes in `spec.md` §17 **before** writing the code they gate: S1 whether
      Facebook Page feed comment events are delivered under Standard Access, S2 whether Instagram
      comments are readable under each login variant, S5 which signing secret authenticates events
      for the Instagram Login variant. Save the raw responses S2 returns under
      `src/platforms/meta/__fixtures__/` — they are what T097 replays, so the fixtures are recorded
      platform behaviour rather than invented shapes. If S2 shows neither variant returns data,
      Instagram stays fixture-tested, the live demo relies on Facebook and Bluesky, and the
      limitation goes into `DESIGN.md` (T110) — that fallback is S2's documented outcome, not a
      failure of the gate

### Tests for User Story 3 ⚠️

- [X] T071 [P] [US3] Create `src/modules/comments/application/ingest-comments.integration.test.ts`
      (V4): the same comment arriving by push and then by refresh exists once and produces one
      `comment.received`; a later event carrying edited text updates the stored comment rather than
      inserting a second; redelivery over a 36-hour window changes neither count; a reply whose
      parent is unknown is attached correctly after the ancestor walk; and an event arriving **without
      `text`** is completed through `fetchComment` instead of blanking the stored text (A18, T081)
      (FR-017, FR-022, SC-003)
- [X] T072 [P] [US3] Create `src/modules/comments/http/webhook.integration.test.ts` (V4): a valid
      signed delivery is stored and acknowledged in under a second; a tampered signature is rejected
      with nothing stored; an event for an unknown account is acknowledged and marked processed with
      a warning rather than retried; the `GET` handshake echoes `hub.challenge` only after
      `hub.verify_token` matches, and answers `403` echoing nothing otherwise. Then the other half of
      SC-004, which acknowledgement latency does not cover: with the clock under test control,
      a delivered event is **readable through the API within 60 seconds** of delivery — intake plus
      `webhook-process` plus the upsert, end to end, not just the `200` (FR-016, SC-004, §7.2)
- [X] T073 [P] [US3] Create `src/modules/comments/application/sync-post.integration.test.ts` (V4): a
      complete walk marks platform-side deletions **with `text` and the author fields nulled and the
      parent's `reply_count` decremented, identical to a webhook delete** (FR-030, T086); a walk
      interrupted midway marks **zero**; a post's first walk tags its comments `backfill`; a post
      under 24 h, one past a week and one past retention land in different age bands and the last is
      not polled — asserted against a non-default `RETENTION_DAYS` so a hard-coded 45 fails the test
      (U3, T085); an ingested comment on a post never published through the platform creates a
      refresh target of its own (FR-018, FR-019, FR-020, FR-030, SC-004, SC-008)
- [X] T074 [P] [US3] Create `src/modules/comments/http/sync-request.integration.test.ts` (V4): a
      manual refresh returns `202` with a trackable job; a second request inside the 60-second
      cooldown → `429 SYNC_COOLDOWN`; a request while a job is running → `202` carrying that same
      job; a deactivated target is run anyway and its schedule restored on success (FR-021, D19)
- [X] T075 [P] [US3] Assert in `src/modules/comments/infrastructure/outbox.integration.test.ts` that
      one `comment.received`, one `comment.posted`, one `comment.failed` and one `comment.deleted`
      reach the queue carrying exactly the fields contracts/domain-events.md lists, including
      `isOwn` and `ingestionSource` (FR-024, D9)

### Implementation for User Story 3

- [X] T076 [US3] Create `src/modules/comments/application/ingest-comments.ts` — **the single upsert
      path shared by push and refresh**: `INSERT ... ON CONFLICT (social_account_id,
      platform_comment_id) DO UPDATE` so an edit updates the text; on a new comment increment the
      parent's `reply_count` and the root's `last_activity_at` and write outbox `comment.received`;
      on a delete event set `status = deleted`, null `text` and the author fields, decrement the
      parent's `reply_count` and write outbox `comment.deleted` (§7.2 steps 3–4, FR-017, FR-030)
- [X] T077 [US3] Implement ancestor resolution in
      `src/modules/comments/application/ingest-comments.ts`: when the parent is unknown locally, walk
      up with `adapter.fetchComment` until a known ancestor or the top-level comment is found, rather
      than storing an orphan; set `depth` and `root_comment_id` from the resolved chain (FR-022)
- [X] T078 [US3] Create `src/modules/comments/http/webhook-routes.ts` with `POST /webhooks/meta`
      registering a route-scoped Fastify content-type parser that keeps the raw `Buffer`, verifying
      `X-Hub-Signature-256` over those exact bytes with `timingSafeEqual` **before any JSON
      parsing**, accepting either configured signing secret; valid → insert `webhook_deliveries` →
      enqueue `webhook-process` → `200`; invalid → `401` with nothing stored (R-04, S5) *(blocked by
      T070)*
- [X] T079 [US3] Add `GET /webhooks/meta` to `src/modules/comments/http/webhook-routes.ts`: compare
      `hub.verify_token` against the configured value first and only then echo `hub.challenge`; a
      wrong or missing token is `403` and echoes nothing — echoing unconditionally would let anyone
      confirm the subscription *(blocked by T070)*
- [X] T080 [US3] Create `src/platforms/meta/webhook-normalizer.ts` implementing `WebhookNormalizer`:
      turn a verified payload for `instagram.comments` and `page.feed` (`item=comment`,
      `verb=add|edited|remove`) into `upsert` / `delete` `IngestionEvent`s (§8.2). Subscriptions ask
      for values included, but a payload that arrives without `text` or author fields is normalized
      as **incomplete** rather than as empty — an absent field is not an edit to blank (A18)
      *(blocked by T070)*
- [X] T081 [US3] Create `src/modules/comments/infrastructure/webhook-worker.ts`: the
      `webhook-process` worker at concurrency 10 running the normalizer and the shared upsert path,
      marking a delivery for an unknown account processed with a warning log rather than retrying it.
      An event the normalizer flagged incomplete is completed through `adapter.fetchComment` before
      the upsert, so a thin payload never overwrites stored text with null (§7.2 step 2, A18)
      *(blocked by T070)*
- [X] T082 [P] [US3] Add the unprocessed-delivery sweeper to
      `src/modules/comments/infrastructure/sweepers.ts`: re-enqueue `webhook_deliveries` unprocessed
      for more than five minutes (§7.2 step 5)
- [X] T083 [US3] Implement `listComments` and `fetchComment` in
      `src/platforms/bluesky/adapter.ts`: `app.bsky.feed.getPostThread` with the configured depth,
      loading truncated branches, normalizing AT URIs and `cid`, deciding "own" by matching the
      author DID, and surfacing a `notFoundPost` marker as an **explicit tombstone** that may mark
      that comment deleted on its own — while absence still requires a complete walk (§8.3, FR-019)
- [X] T084 [US3] Implement `listComments` and `fetchComment` in
      `src/platforms/meta/instagram-adapter.ts` (`GET /{media-id}/comments` with the `replies`
      expansion) and `src/platforms/meta/facebook-adapter.ts`
      (`GET /{post-id}/comments?filter=stream`), paging to exhaustion and deciding "own" by matching
      `from.id` against the account (§8.2). *(S2 ran against a real Meta App (§17); the Instagram half
      is built against the recorded `facebook_login` fixture, not the Graph docs. The Facebook half was
      already done and is unchanged.)*
- [X] T085 [US3] Create `src/modules/comments/infrastructure/sync-target-repository.ts`:
      create-or-get a target from the `PostPublished` port and from the first ingested comment on an
      external post — **the only way an external post becomes tracked** — plus the age-band
      `next_sync_at` computation reading the configurable §7.3 intervals (< 24 h, 1–7 d,
      7 d–`RETENTION_DAYS`, beyond `RETENTION_DAYS` = not polled). The top band is **derived from
      `RETENTION_DAYS`, never from a literal 45**: FR-018 ties "stop tracking" to the retention
      window, so a deployment that shortens retention would otherwise keep polling posts whose
      threads the purge has already removed (FR-018, D13, D15)
- [X] T086 [US3] Create `src/modules/comments/application/sync-post.ts`: walk every page through the
      adapter, run each item through the shared upsert path, and only after a **complete** successful
      walk mark absent comments `deleted`; an interrupted walk infers nothing. Tag everything found
      by a target's first walk `backfill`, and everything later `sync`. The deletion goes through the
      **same delete branch of `ingest-comments.ts` that a webhook delete uses** — so `text` and the
      author fields are nulled, the parent's `reply_count` is decremented and outbox
      `comment.deleted` is written here exactly as there. A deletion detected by refresh must not be
      a second, weaker code path that leaves PII behind (FR-019, FR-020, FR-030, SC-008, A10)
- [X] T087 [US3] Handle target lifecycle in `src/modules/comments/application/sync-post.ts`: a
      `PermanentError` deactivates the target (`next_sync_at = null`, reason in `last_error`) without
      inferring deletions, while a `RetryableError` keeps the schedule (§7.3)
- [X] T088 [US3] Create `src/modules/comments/infrastructure/sync-scheduler.ts`: a repeatable job
      running every minute that selects `next_sync_at <= now()` with `FOR UPDATE SKIP LOCKED` and
      enqueues `comment-sync`, plus the `comment-sync` worker with a per-account token bucket;
      register both in `src/app/worker.ts` (§7.3, §9.2)
- [X] T089 [US3] Create `src/modules/comments/application/request-sync.ts` implementing D19: an
      active job exists → return that job; `manual_cooldown_until > now()` → `429 SYNC_COOLDOWN`;
      otherwise create a `comment_sync_jobs` row with `trigger: manual`, set the cooldown, and run a
      deactivated target too, restoring its schedule on success
- [X] T090 [US3] Add `POST /v1/posts/:postId/comments/sync` (`202 SyncJob`) and
      `GET /v1/comment-sync-jobs/:jobId` (`200 SyncJob` with `stats` carrying `fetched`, `inserted`,
      `updated`, `deleted`) to `src/modules/comments/http/routes.ts`

**Checkpoint**: ingestion is idempotent through both channels; the read model of US1 is now fed by
real platform data.

---

## Phase 6: User Story 4 - One inbox per connected account (Priority: P2)

**Goal**: everything addressed to one connected account in one place, including comments on posts not
published through the platform.

**Independent Test**: ingest comments for one account across two posts, one of them external, and
confirm both appear in the inbox, filterable by time and ownership, and that a reply can be sent to
the external post's comment.

### Tests for User Story 4 ⚠️

- [X] T091 [P] [US4] Create `src/modules/comments/http/inbox.integration.test.ts` (V8): comments on
      an internal and an external post both appear newest first, the external one with
      `postId: null`; `since` / `until` return only what occurred inside the window; `isOwn`
      separates the account's own comments from the audience's, **including an own comment that
      arrived by ingestion rather than through this service**; a reply to the external post's comment
      is accepted with `202`; `POST /v1/posts/:postId/comments` for a post with no internal id is
      `404`; and when the `posts` row stops resolving the post-scoped list answers `404` while the
      same comments stay in the inbox (FR-008, FR-015, FR-023, A2, A7, A10a, D13)

### Implementation for User Story 4

- [X] T092 [US4] Add `listByAccount` to `src/modules/comments/infrastructure/comment-repository.ts`
      driving the `(social_account_id, occurred_at DESC, id DESC)` index, with optional `since`,
      `until` and `isOwn` predicates, still scoped by `workspaceId`
- [X] T093 [US4] Create `src/modules/comments/application/list-account-comments.ts` spanning internal
      and external posts, defaulting to `desc` (FR-008, D13)
- [X] T094 [US4] Add `GET /v1/accounts/:accountId/comments` with its `limit`, `cursor`, `since`,
      `until`, `isOwn` and `order` query schema to `src/modules/comments/http/routes.ts` and
      `src/modules/comments/http/schemas.ts`
- [X] T095 [US4] Set `is_own` from author identity in
      `src/modules/comments/application/ingest-comments.ts` — the author matching the connected
      account, independent of whether the comment was created through this service (FR-023, A2)

**Checkpoint**: the daily working surface exists; US1–US4 all work independently.

---

## Phase 7: User Story 5 - Know what each platform can do (Priority: P3)

**Goal**: a machine-readable capability registry that the write path provably enforces.

**Independent Test**: request the registry and verify all nine publishing platforms are listed with
accurate capabilities, then verify that a write to an unsupported platform is rejected with the same
reason the registry gives.

### Tests for User Story 5 ⚠️

- [X] T096 [P] [US5] Create `src/modules/comments/http/platforms.integration.test.ts` (V9):
      `GET /v1/platforms` lists all nine platforms — three supporting comments, six carrying an
      `unsupportedReason` — and **the depth, text limit and unit it reports for a platform are the
      same values the write path enforces**, so the registry cannot drift from behaviour (FR-031,
      SC-009)
- [X] T097 [P] [US5] Create `src/platforms/meta/instagram-adapter.integration.test.ts` (V9): one
      parameterized test body run against **both** login variants — `facebook_login` on
      `graph.facebook.com` and `instagram_login` on `graph.instagram.com` — asserting identical
      normalized comments, identical publish results and identical "own" detection (D28, A17).
      *(Per spec.md §18, both arms replay the same recorded `facebook_login` body — the
      `instagram_login` fixture was never attempted (§17 S2) — so the test proves variant
      independence without asserting a response nobody has observed.)*

### Implementation for User Story 5

- [X] T098 [US5] Add `GET /v1/platforms` to `src/modules/comments/http/routes.ts` returning
      `{ items: PlatformCapabilities[] }` — `platform`, `supportsComments`, `canCreateTopLevel`,
      `canReply`, `maxReplyDepth`, `textLimit`, `textUnit`, `ingestion`, `unsupportedReason` —
      serialized straight from `src/platforms/registry.ts` with no second source of truth
- [X] T099 [US5] Reject a write against a platform whose registry entry has
      `supportsComments: false` with `422 PLATFORM_NOT_SUPPORTED` before anything leaves the service,
      in `src/modules/comments/application/create-reply.ts` and
      `src/modules/comments/application/create-top-level-comment.ts`

**Checkpoint**: all five user stories are independently functional.

---

## Phase 8: Polish & Cross-Cutting Concerns

### Retention (FR-029, SC-010, A9, D15)

> FR-030 — nulling a deleted comment's text and author — belongs to the delete path (T076, T086),
> not here: retention removes whole threads rather than redacting individual comments.

- [X] T100 [P] Create `src/modules/comments/application/purge-retention.integration.test.ts` (V7): a
      thread whose last activity is 46 days old is removed whole; a thread with a comment on day 44
      is untouched **including its older comments**
- [X] T101 Create `src/modules/comments/application/purge-retention.ts`: a daily job deleting
      top-level comments with `last_activity_at < now() - RETENTION_DAYS` in batches of 1000, replies
      following by cascade, plus purging `webhook_deliveries` older than 7 days, published
      `outbox_events` older than 7 days and `contact_quota_usage` for periods older than two months;
      register it on the `scheduler` queue in `src/app/worker.ts` (§7.4)

### Tenancy and credentials (SC-007, D20)

- [X] T102 [P] Create `src/modules/comments/http/tenancy.integration.test.ts` (V5): **every**
      endpoint called with a second workspace's key against the first workspace's resource returns
      `404` — never `403`, never a leak of existence. Then the credential itself: a missing key, an
      unrecognized one and a revoked one each → `401 UNAUTHORIZED`; a key driven past its per-minute
      budget → `429 RATE_LIMITED` carrying `RateLimit-*` and `Retry-After`. Pin the ceiling rule of
      T034 with two keys: one whose `rate_limit_per_min` is below the env default is cut off at the
      column, one whose value is above it is still cut off at the env default — a per-key row must
      not be able to raise a budget (FR-026, FR-027, FR-028)
- [X] T103 Run the V11 exercise (Principle V): temporarily remove the deduplication unique index, the
      `findPublishedComment` reconciliation call and the `workspaceId` predicate **one at a time**,
      confirm T071, T051 and T102 fail respectively, and restore each. A test that has never failed
      proves nothing

### Performance budgets

- [X] T104 [P] Create `src/modules/comments/http/benchmark.integration.test.ts` (V10): seed a
      workspace with 100,000 comments across many posts, then measure the post-comments read and an
      accepted write at p95 under 300 ms, the write independent of how long the adapter double
      stalls. This is a build-time budget that fails when a query plan degrades, not a service level
      (SC-005, SC-006, A21, A22)

### Remaining spikes

- [X] T105 [P] Run spike S3 — whether Railway's managed Redis accepts `maxmemory-policy noeviction`
      with AOF persistence — and record the outcome in `spec.md` §17. If it does not, provision Redis
      from a Docker image with a volume instead; this changes deployment configuration only, not code
      (FR-033, §9.2)
- [X] T106 [P] Run spike S4 — Bluesky's current `createRecord` and `getPostThread` rate limits — and
      tune the §7.3 interval values in `.env.example` and the Railway configuration accordingly,
      recording the result in `spec.md` §17 (FR-018, SC-004)

### Deliverables (§13)

- [X] T107 Create `scripts/generate-openapi.ts` writing `openapi.json` from the registered Zod route
      schemas, and commit the generated `openapi.json` at the repository root (D18, R-03)
- [X] T108 [P] Create `scripts/smoke.ts` running the SC-012 reviewer walkthrough against the
      deployment: list platforms → read a post's comments → post a reply → poll to `posted` → hit
      `422 REPLY_DEPTH_EXCEEDED` on Instagram and succeed on Bluesky → request a refresh and read the
      job counts
- [X] T109 [P] Write `README.md`: what the service is, the deployment link and `/docs`, the curl
      walkthrough, the local run via docker compose, the layout, and the **"How I used AI tools"**
      section that §1 makes part of the original task (§15)
- [X] T110 [P] Write `DESIGN.md` — the sole carrier of several decisions for the reader: context and
      scope; architecture in mermaid including the service boundary and why the roles are not split
      further (§4.1); the ER diagram; the API; reply / webhook / sync sequence diagrams; platforms and
      the registry with what it takes to add one (§8.1); key decisions with trade-offs and rejected
      alternatives; assumptions; the Meta Standard Access limitation (D23); differences from the
      current `/v2/comments` (D3); and the evolution path — Jetstream (D17), partitioning (D15), the
      remaining platforms, private replies
- [X] T111 Configure the Railway deployment (D24): `api` and `worker` services from the one
      multi-stage `node:22-slim` image running as a **non-root** user, managed Postgres 18 and Redis
      8, migrations as a pre-deploy command, and deployment from `main` in `.github/workflows/`
- [X] T112 Run the full gate — `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test:unit`,
      `pnpm test:integration` — and fix everything; oxlint warnings count as failures (D21)

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (Phase 1)**: no dependencies
- **Foundational (Phase 2)**: depends on Setup — **blocks every user story**
- **US1 (Phase 3)**: depends on Foundational only. Delivers value alone
- **US2 (Phase 4)**: depends on Foundational. Independent of US1 — it writes and polls its own rows
- **US3 (Phase 5)**: depends on Foundational. The T070 spike gate blocks T078–T081 (S1, S5) and the
  Instagram half of T084 (S2); T097 replays the fixtures T070 records, so it follows T070 too
- **US4 (Phase 6)**: depends on Foundational; T095 touches the US3 ingestion file, so schedule it
  after T076 if both are in flight
- **US5 (Phase 7)**: depends on Foundational. T099 touches the US2 use cases, so schedule it after
  T058/T059
- **Polish (Phase 8)**: T102 needs every endpoint to exist; T103 needs T051, T071 and T102; T104
  needs the read and write paths; T107 needs every route registered, and **T005 ships with T107** —
  the drift check and the script it calls are one change

### Within Phase 2

T007 → T008. T016–T020 → T021 (the migration is generated from all of them). T022 → T023 → T024,
with T023a alongside T023 (the `Accounts` port composes the projection with `account_health`, so the
table's writer and its reader land together). T033 → T034 (the limiter keys on the api key the auth
plugin resolves). T037 depends on T023, T023a, T026 and T031.

### Within each user story

Tests are written first and confirmed failing. Then: repository → use case → HTTP route. In US2 the
adapter work (T065–T068) may proceed in parallel with the use cases, since they meet only at the
port defined in T025.

### File-conflict notes (why some tasks lack `[P]`)

- `comment-repository.ts` is touched by T043, T044, T056 and T092 — sequential
- `routes.ts` is touched by T049, T069, T090, T094 and T098 — sequential
- `ingest-comments.ts` is touched by T076, T077 and T095 — sequential
- `sweepers.ts` is touched by T064 and T082; `schema.ts` by T017–T020
- The Meta adapters are touched by T068 (publish side) and T084 (read side) — sequential
- `publish-comment.ts` is touched by T060, T060a and T062 — sequential
- `sync-post.ts` is touched by T086 and T087 — sequential

### Parallel opportunities

- Setup: T003, T004, T006 together (T005 waits for T107)
- Foundational shared primitives: T009–T015 are seven independent files
- Foundational trio: platform abstraction (T025–T027), domain rules (T028–T030) and the projection
  ports (T022–T024) are three independent tracks
- Every user story's test tasks are parallel with each other
- Once Foundational is done, US1, US2 and US3 can be staffed simultaneously
- Polish: T100, T102, T104, T105, T106, T108, T109, T110 are all independent

---

## Parallel Example: User Story 2

```bash
# All five test files first, in parallel — then confirm they fail:
Task: "Publish failure matrix in src/modules/comments/application/publish-comment.integration.test.ts"
Task: "Write validation and idempotency in src/modules/comments/http/create-reply.integration.test.ts"
Task: "Quota under concurrency in src/modules/comments/infrastructure/contact-quota.integration.test.ts"
Task: "Outbox after commit in src/modules/comments/infrastructure/outbox.integration.test.ts"
Task: "Stuck-work sweeper in src/modules/comments/infrastructure/sweeper.integration.test.ts"

# Then two tracks that meet only at the adapter port:
Track A (use cases): T056 → T057 → T058 → T060 → T060a → T061 → T062
Track B (adapters):  T065, T065a, T066 → T067 → T068
```

---

## Implementation Strategy

### MVP (User Story 1 only)

1. Phase 1 Setup
2. Phase 2 Foundational — **blocks everything**
3. Phase 3 US1
4. **Stop and validate**: run V1 and confirm paging, ordering, reply counts and placeholders
5. Demo the read model against seeded data, with no platform call anywhere

### Incremental delivery

1. Setup + Foundational → the schema, the boundary and the registry exist
2. + US1 → the read model (MVP)
3. + US2 → the exactly-once write, the load-bearing guarantee of the whole feature
4. + US3 → real data flows in through push and refresh
5. + US4 → the account inbox
6. + US5 → the capability registry endpoint
7. + Polish → retention, tenancy sweep, budgets, deployment and the three documents

### Parallel team strategy

After Foundational: developer A takes US1 then US4 (both pure read paths), developer B takes US2
(the write path and the adapters' publish side), developer C takes US3 (ingestion and the adapters'
read side), starting with the spike gate T070 and the Bluesky path so the Meta work is unblocked by
the time they reach it. US5 is a half-day and fits anywhere after Foundational.

---

## Notes

- `[P]` means a different file with no dependency on incomplete work
- Every commit cites the decision it implements (`per D14`); a divergence updates `spec.md` §18
  **before** the code diverges (Principle I)
- Gates before every commit: `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, the relevant tests
- The three invariants that must be broken once to prove their tests fail are deduplication,
  reconciliation and tenancy — T103
