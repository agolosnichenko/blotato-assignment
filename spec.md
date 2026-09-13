# Blotato Take Home — Comment System: Specification

> Status: **FINAL** (2026-09-11). The contested assumptions (A3, A4, A9, A11, A16, A17) were reviewed
> with the author; decisions D27–D28 were added as a result. A later review of the system shape
> replaced the "modular monolith" framing with an explicit service boundary: D29 and A10a, with
> §4.1, §5.1, §5.2, D8 and D26 updated to match.
> This is the working specification. The deliverable documents (README, DESIGN.md, OpenAPI) are also
> in English (D18).
> All decisions are in section 3, all assumptions in section 16, risks and spikes in section 17.

## 1. Original task

See `task.md`. Design and partially implement a comment system for a social media scheduling API:

- retrieve comments for a published post;
- reply to a comment;
- support multiple social platforms (including future ones);
- expose the functionality through a REST API.

Deliverables: database schema, API design, TypeScript code, explanation of major design decisions,
list of assumptions, description of AI tool usage. The answer is a link to a GitHub repository.

The author's goal is to get hired by the founder. What matters is explicit trade-offs,
production-grade reliability and a working deployed service — not matching Blotato's implementation.

## 2. References

### 2.1. Blotato's documented functionality (as of 2026-09-11)

Sources: <https://www.blotato.com/>, <https://help.blotato.com/api/comments>,
<https://help.blotato.com/api/llm>.

- Publishing — 9 platforms: Instagram, Facebook, X, LinkedIn, TikTok, YouTube, Threads, Bluesky,
  Pinterest.
- Comments (read / post / reply) — **Instagram and Facebook only** (Page posts).
- No backfill: comments are captured from the moment the account is connected. Retention — 45 days.
- One level of nesting: replies are allowed only to top-level comments.
- Posting is asynchronous: `queued → processing → posted | failed` (+ `deleted`); the client polls
  `GET /comments/:id`. `POST /comments` returns `201`.
- Model: `id`, `accountId`, `platform`, `postId` (null for posts not published through Blotato),
  `parentCommentId`, `platformPostId`, `platformCommentId`, `authorId`, `isAuthor`, `text`, `status`,
  `errorCode`, `errorMessage`, `createdAt`.
- Flat `GET /comments` with filters `postId`, `parentCommentId`, `accountId`, `platform`, `since`,
  `until`; cursor pagination, `createdAt desc`, `limit` 1–250.
- Text limits: IG 2200 characters, FB 8000. Rate limit: 60/min for reads, 30/min for writes.
- Replying to a new audience member consumes the monthly "active contacts" limit (422, code `20101`);
  replying to one's own comment does not.

### 2.2. Related functionality: DM Automations

Sources: <https://help.blotato.com/features/dm-automations>, <https://help.blotato.com/api/dm-automations>.

- The `comment-received` trigger (a specific post or all posts of an account, with keywords) responds
  with a **private reply** via DM: once per comment, within 7 days.
- The account's own comments never trigger an automation → ingestion must reliably distinguish
  "own" comments.
- Takeaway: the inbound comment stream is a shared event source for platform modules (automations,
  inbox, analytics). Private replies belong to the messaging module.

### 2.3. Meta constraints for a real deployment (verified 2026-09-11)

Sources: <https://developers.facebook.com/docs/instagram-platform/webhooks>,
<https://developers.facebook.com/docs/graph-api/webhooks>,
<https://developers.facebook.com/docs/graph-api/overview/access-levels>,
<https://developers.facebook.com/docs/graph-api/webhooks/getting-started/webhooks-for-pages>.

- **Standard Access** is granted to Business apps automatically, without App Review, but applies only
  to users who have a role on the app (admin / developer / tester).
- **Advanced Access** requires Business Verification and App Review.
- **Instagram `comments` webhooks** require Live mode + Advanced Access + Business Verification.
  The media must belong to a public account. **Our deployment will not receive them.**
- **Facebook Page `feed` webhooks** require `pages_manage_metadata` + `pages_show_list` and
  `POST /{page-id}/subscribed_apps`. In development mode only test events from the App Dashboard and
  events initiated by people with a role on the app are delivered. Forum reports are contradictory →
  spike S1.
- Webhooks are signed with `X-Hub-Signature-256` (HMAC-SHA256 with the App Secret); redelivery lasts
  up to 36 hours → deduplication is mandatory. The endpoint must be HTTPS with a valid certificate.
- IG `GET /{media-id}/comments` returns only top-level comments (≤ 50 per page, no time filter);
  replies come through the `replies` field expansion.

## 3. Decisions

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| D1 | Implementation depth | A working service: REST API, migrations, platform adapters, background workers, tests | Engineering decisions are visible in code, not just on paper |
| D2 | Product scope | Based on Blotato's documented functionality (2.1, 2.2) | The design is grounded in real product and platform constraints |
| D3 | API contract | Own design within the same scope; resources follow the task wording. Differences from `/v2/comments` are explained in DESIGN.md | The reviewer evaluates independent reasoning |
| D4 | Ingestion | Webhooks are the primary channel (idempotent upsert). A sync job via the platform API handles backfill and reconciliation of missed events | Low latency + protection against lost events and the lack of backfill |
| D5 | Platforms | Instagram + Facebook (Meta Graph API) + a third platform with a different model; all 9 platforms are described in a capability registry | The abstraction is validated against two different models |
| D6 | Stack | Node 22, TypeScript strict (ESM), Fastify, PostgreSQL, Drizzle ORM, BullMQ on Redis | Production-grade path; Redis queues are standard platform infrastructure |
| D7 | Third platform | Bluesky (AT Protocol) | Arbitrary-depth trees, replies via root+parent (uri+cid), no webhooks, open API |
| D8 | Service boundaries | Workspaces, API keys, social accounts (+ tokens) and posts are owned by other services of the platform. The comments service reads them only through ports; it never writes them and never joins to them in SQL | Focus on comments; the service plugs into an existing platform |
| D9 | Domain events | Transactional outbox → relay → BullMQ. Consumers are not implemented; only the contract and a test | At-least-once delivery without dual writes |
| D10 | Write operations | Public reply to a comment + top-level comment on a post. Private reply is out of scope | Mirrors the product; DMs are a different domain |
| D11 | Read shape | `GET /posts/:postId/comments` — top-level comments with `replyCount`; `GET /comments/:commentId/replies` — direct replies; a cursor at each level | One model for depth 1 and ∞, predictable response size |
| D12 | Reply depth | Strict check against the `maxReplyDepth` capability → `422 REPLY_DEPTH_EXCEEDED` | No implicit change of request semantics |
| D13 | External posts | Comments on posts not published through Blotato are stored with `postId = null`, emit events, are available via `GET /accounts/:accountId/comments`, and can be replied to | Required for the "on any post" automation and the account inbox |
| D14 | Publish retries | Backoff only on retryable errors; on an uncertain outcome, reconcile first (look for our comment on the platform), then retry | A duplicate public reply on behalf of a brand is worse than a delay |
| D15 | Retention | 45 days (configurable), purge job. Partitioning is described in DESIGN.md as the next step | Mirrors the product, limits PII and table growth |
| D16 | Active contacts | A `ContactQuota` port reserves the contact before enqueueing; exceeding the limit → `422 QUOTA_EXCEEDED`. The limit is read through the port from the projected `workspaces.contact_limit_monthly` (in the real platform — billing entitlements) | A real business constraint behind a billing interface |
| D17 | Bluesky ingestion | Adaptive polling; Jetstream is described in DESIGN.md as the scaling path | One sync mechanism without a stateful WebSocket component |
| D18 | Documentation | English: README, DESIGN.md (mermaid), OpenAPI generated from Zod schemas. `spec.md` is the working specification, also in English | The founder reads the repository |
| D19 | Manual sync | `POST /posts/:postId/comments/sync` → `202` + sync job; `lastSyncedAt` in read responses | A client or agent can request fresh data itself |
| D20 | Tenancy and auth | API key (only the hash is stored) → workspace; scoped by `workspace_id`; another workspace's resource → `404`; per-key rate limit in Redis | Team-friendly model that does not reveal other tenants' resources |
| D21 | Tooling and CI | pnpm, oxlint + oxfmt, `tsc --noEmit`, vitest + testcontainers, prek, GitHub Actions (SHA-pinned, zizmor), Dependabot | Guardrails from the first commit |
| D22 | How the result is evaluated | The reviewer won't run the code locally → public deployment with real accounts | Author's decision |
| D23 | Meta access | A real Meta App in Standard Access without App Review or Business Verification. IG/FB comments arrive through the sync job; the webhook path is exercised with test events from the App Dashboard and spike S1 for FB Page feed. The limitation is stated openly in DESIGN.md | Business verification and review take weeks and are outside our control |
| D24 | Hosting | Railway: `api` and `worker` services from one Dockerfile, managed Postgres and Redis, HTTPS domain, deploys from GitHub | Minimal ops while still running real HTTPS / worker / Postgres / Redis |
| D25 | Reviewer access | Public Swagger UI (`/docs`); the demo API key is sent in the email, not committed to the repository; the key is bound to a demo workspace, has a reduced rate limit and can be revoked; README contains a curl walkthrough | The reviewer can try a reply, but a random repository visitor cannot post on behalf of real accounts |
| D26 | Account tokens | Adapters obtain credentials through an `AccountCredentials` port, never from a table. The single implementation for this deployment reads the local projection and decrypts AES-256-GCM (key from env); a CLI seed script accepts manually obtained tokens (Meta long-lived Page token or Instagram user token, Bluesky app password) and subscribes the account to webhooks. In the platform the port is a call to the accounts service returning a short-lived token | Token custody belongs to the accounts service (D8); the port is the seam, and the demo needs exactly one implementation behind it |
| D27 | List ordering | All list endpoints accept `order=asc\|desc`. Defaults: top-level and account inbox — `desc`, replies — `asc`. The cursor encodes the direction | The client picks the scenario (inbox or reading a conversation); B-tree indexes are readable in both directions, so no extra indexes are needed |
| D28 | Instagram login | The IG adapter supports both variants: Facebook Login for Business (Page token, `graph.facebook.com`) and Instagram Login (Instagram user token, `graph.instagram.com`). The variant is stored in `social_accounts.auth_variant`; differences are isolated in the Graph client, and use cases do not depend on the variant | Instagram Login is how most modern creators connect without an FB Page; Facebook Login covers businesses with a linked Page |
| D29 | Data ownership | The service owns its schema. References to other services' entities (`workspace_id`, `social_account_id`, `post_id`) are plain `uuid` columns with no foreign key; only links inside the service (`parent_comment_id`, `root_comment_id`) keep foreign keys. Referential integrity comes from port validation on write and platform events on delete | A foreign key across a service boundary forces a shared database and blocks independent schema changes; the read contract (§6.2) needs no data from other services, so the boundary costs nothing |

## 4. Architecture

### 4.1. System shape

One service among the platform's services, deployed on its own. It owns its schema and its Redis
(D29) and talks to the rest of the platform only through ports and domain events (D8, D9) — never
through a shared table or a cross-service join.

One repository, one Docker image, two runtime roles of the same service:

- **api** (Fastify): public REST API, webhook intake, Swagger UI, health checks.
- **worker** (BullMQ): comment publishing, sync, webhook delivery processing, outbox relay,
  retention purge, sync scheduler.

Splitting the roles into separate deployables is a queue-and-process detail, not a service boundary:
they share one schema, one release and one owner. Ingestion, publishing and reads are likewise not
split further — there is no independent scaling profile, availability requirement or team boundary to
justify it. The trigger that would change this: webhook bursts whose intake has to stay available
while publishing is degraded — then intake becomes its own deployable, writing to the same
`webhook_deliveries` table.

Postgres is the source of truth. Redis holds only queues, rate limiting and short-lived locks
(losing Redis does not lose data: see the outbox and `webhook_deliveries`).

### 4.2. Code layout

```text
src/
  app/                      # composition: api.ts, worker.ts, config (zod env), DI container
  shared/                   # db (drizzle), queue (bullmq), logger (pino), errors (problem+json),
                            # crypto (AES-GCM), pagination (cursor codec), http helpers
  modules/
    platform-core/          # ports to other services + local projection of their data
                            # (workspaces, api keys, social accounts, posts)
    comments/
      domain/               # Comment, status state machine, reply rules, capability checks
      application/          # use cases: ListPostComments, ListReplies, CreateReply,
                            # CreateTopLevelComment, RequestSync, IngestComments, PublishComment
      infrastructure/       # drizzle repositories, outbox, contact quota, queues and workers
      http/                 # routes, Zod request/response schemas, error mapping
  platforms/
    registry.ts             # capability registry for all 9 platforms
    types.ts                # CommentPlatformAdapter port and normalized types
    meta/                   # Graph API client, IG and FB adapters, webhook verifier + normalizer
    bluesky/                # AT Protocol adapter (@atproto/api)
scripts/                    # seed-account, create-api-key, generate-openapi
drizzle/                    # SQL migrations
```

### 4.3. Platform adapter port

```ts
interface CommentPlatformAdapter {
  readonly platform: Platform;
  listComments(ctx: AccountContext, target: PostTarget, cursor?: string): Promise<CommentPage>;
  publishComment(ctx: AccountContext, input: PublishInput): Promise<PublishedComment>;
  findPublishedComment(ctx: AccountContext, probe: ReconcileProbe): Promise<PublishedComment | null>;
  fetchComment(ctx: AccountContext, platformCommentId: string): Promise<NormalizedComment | null>;
}
```

- `NormalizedComment`: `platformCommentId`, `platformParentId | null`, `authorPlatformId`,
  `authorUsername`, `authorDisplayName`, `text`, `platformCreatedAt`, `platformMeta` (jsonb:
  e.g. `cid` for Bluesky).
- Adapter errors are typed: `RetryableError` (429 / 5xx / network failure before sending, with
  `retryAfter`), `OutcomeUnknownError` (timeout or connection drop after sending), `PermanentError`
  (4xx, platform rejection), `AuthError` (invalid token).
- Webhooks use a separate `WebhookNormalizer` port (Meta only): raw payload → list of
  `IngestionEvent` (`upsert` / `delete`).

## 5. Data model

All ids are UUIDv7 (time-sortable). All timestamps are `timestamptz`.

### 5.1. Local projection of platform data (D8, D29)

These four tables mirror data owned by other services so that the hot paths — authenticating a key,
resolving a post, loading an account — do not make a network call per request. The service only reads
them; they are filled by the seed script in this deployment and by platform events in the real one.
A stale or missing row is a normal condition, not a corruption: the port reports the entity as
unknown and the request gets `404` or the job is parked.

| Table | Columns |
|-------|---------|
| `workspaces` | `id`, `name`, `contact_limit_monthly`, `created_at` |
| `api_keys` | `id`, `workspace_id`, `prefix` (unique), `key_hash` (sha256), `name`, `rate_limit_per_min`, `revoked_at`, `created_at` |
| `social_accounts` | `id`, `workspace_id`, `platform`, `platform_account_id` (IG user id / FB page id / Bluesky DID), `username`, `auth_variant` (for IG: `facebook_login` / `instagram_login`; otherwise null), `credentials_ciphertext` (bytea), `credentials_key_version`, `status` (`active` / `disconnected`), `created_at` |
| `posts` | `id`, `workspace_id`, `social_account_id`, `platform`, `platform_post_id`, `platform_meta` (jsonb, e.g. `cid`), `published_at`, `created_at` |

### 5.2. `comments`

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid PK | |
| `workspace_id` | uuid, not null | external reference, no FK (D29); denormalized for scoping (D20) |
| `social_account_id` | uuid, not null | external reference, no FK (D29) |
| `platform` | text, not null | |
| `post_id` | uuid, null | external reference, no FK (D29); null for external posts (D13) |
| `platform_post_id` | text, not null | |
| `parent_comment_id` | uuid FK → comments, null, `ON DELETE CASCADE` | null = top-level |
| `root_comment_id` | uuid FK → comments, null | top-level ancestor; null on the top-level comment itself |
| `depth` | smallint, not null | 0 = top-level |
| `platform_comment_id` | text, null | null until `posted` |
| `platform_meta` | jsonb, not null default `{}` | |
| `is_own` | boolean, not null | the author is the connected account |
| `source` | text, not null | `api` / `webhook` / `sync` |
| `author_platform_id`, `author_username`, `author_display_name` | text, null | |
| `text` | text, null | null after deletion (PII) |
| `status` | text, not null | `queued` / `processing` / `posted` / `failed` / `deleted` |
| `error_code`, `error_message` | text, null | only when `failed` |
| `attempt_count` | int, not null default 0 | |
| `last_attempt_started_at` | timestamptz, null | lower bound of the reconciliation window |
| `idempotency_key` | text, null | |
| `reply_count` | int, not null default 0 | direct replies with status ≠ `deleted` |
| `last_activity_at` | timestamptz, not null | on the root: max `occurred_at` in the thread; used for retention |
| `occurred_at` | timestamptz, not null | sort key: platform time for ingested comments, request time for API-created ones |
| `created_at`, `updated_at`, `deleted_at` | timestamptz | |

Constraints and indexes:

- `UNIQUE (social_account_id, platform_comment_id) WHERE platform_comment_id IS NOT NULL` — the
  deduplication key for webhooks and sync.
- `UNIQUE (workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL`.
- `CHECK (status <> 'posted' OR platform_comment_id IS NOT NULL)`.
- `CHECK ((parent_comment_id IS NULL) = (depth = 0))`.
- `(post_id, occurred_at DESC, id DESC) WHERE parent_comment_id IS NULL` — a post's top-level page.
- `(parent_comment_id, occurred_at ASC, id ASC)` — a replies page.
- `(social_account_id, occurred_at DESC, id DESC)` — the account inbox.
- `(last_activity_at) WHERE parent_comment_id IS NULL` — retention purge.
- `(status, last_attempt_started_at) WHERE status IN ('queued', 'processing')` — finding stuck rows.
- List indexes serve both `order` values (D27): Postgres scans B-trees backwards.

### 5.3. Module-internal tables

| Table | Purpose and columns |
|-------|---------------------|
| `comment_sync_targets` | Per-post sync schedule: `id`, `workspace_id`, `social_account_id`, `post_id` (null for external posts), `platform_post_id`, `last_synced_at`, `next_sync_at` (null = inactive, §7.3), `last_error`, `manual_cooldown_until`, `age_anchor_at` (§18). `UNIQUE (social_account_id, platform_post_id)` |
| `comment_sync_jobs` | API resource (D19): `id`, `workspace_id`, `target_id`, `trigger` (`manual` / `scheduled` / `post_published`), `status` (`queued` / `running` / `succeeded` / `failed`), `stats` (jsonb: fetched / inserted / updated / deleted), `error`, `created_at`, `started_at`, `finished_at`. At most one active job per target (partial unique index) |
| `webhook_deliveries` | Raw deliveries: `id`, `provider` (`meta`), `payload` (jsonb), `received_at`, `processed_at`, `attempts`, `error`. Retention 7 days |
| `outbox_events` | `id`, `workspace_id`, `type`, `aggregate_id`, `payload` (jsonb), `created_at`, `published_at`, `attempts` |
| `contact_quota_usage` | `workspace_id`, `period` (`YYYY-MM`), `platform`, `contact_platform_id`, `comment_id`, `created_at`. PK `(workspace_id, period, platform, contact_platform_id)` |

## 6. REST API

Base path `/v1`. Auth: `blotato-api-key: <api key>` header (A16). JSON, `camelCase`. Errors use RFC 9457
`application/problem+json` with a machine-readable `code`. Rate-limit headers `RateLimit-*` + `Retry-After`.

### 6.1. Endpoints

| Method and path | Purpose | Response |
|-----------------|---------|----------|
| `GET /v1/posts/:postId/comments` | A post's top-level comments (`limit` 1–100, default 20; `cursor`; `order`, default `desc`) | `200 { items: Comment[], nextCursor, sync: { lastSyncedAt, activeJobId } }` |
| `GET /v1/comments/:commentId/replies` | Direct replies (`limit`, `cursor`; `order`, default `asc`) | `200 { items: Comment[], nextCursor }` |
| `GET /v1/comments/:commentId` | A single comment (status polling) | `200 Comment` |
| `GET /v1/accounts/:accountId/comments` | Account inbox, including external posts (`limit`, `cursor`, `since`, `until`, `isOwn`; `order`, default `desc`) | `200 { items, nextCursor }` |
| `POST /v1/posts/:postId/comments` | Top-level comment. Body `{ text }`, `Idempotency-Key` header | `202 Comment(status=queued)` + `Location` |
| `POST /v1/comments/:commentId/replies` | Public reply. Body `{ text }`, `Idempotency-Key` | `202 Comment(status=queued)` + `Location` |
| `POST /v1/posts/:postId/comments/sync` | Manual sync | `202 SyncJob` |
| `GET /v1/comment-sync-jobs/:jobId` | Sync status | `200 SyncJob` |
| `GET /v1/platforms` | Capability registry | `200 { items: PlatformCapabilities[] }` |
| `GET /webhooks/meta` | Subscription verification (`hub.challenge`) | `200 text` |
| `POST /webhooks/meta` | Meta event intake (IG and Page) | `200` |
| `GET /healthz`, `GET /readyz` | Liveness / readiness (Postgres + Redis) | `200` / `503` |
| `GET /docs`, `GET /openapi.json` | Swagger UI and the spec | |

### 6.2. `Comment` representation

```json
{
  "id": "0191e2c4-...",
  "accountId": "...",
  "platform": "instagram",
  "postId": "... | null",
  "platformPostId": "17851234567890",
  "parentCommentId": "... | null",
  "platformCommentId": "17899876543210 | null",
  "depth": 0,
  "isOwn": false,
  "author": { "platformId": "1784000000", "username": "jane", "displayName": null },
  "text": "Love this!",
  "status": "posted",
  "error": null,
  "replyCount": 2,
  "occurredAt": "2026-09-11T12:34:56Z",
  "createdAt": "2026-09-11T12:35:01Z",
  "updatedAt": "2026-09-11T12:35:01Z"
}
```

`error` when `failed`: `{ "code": "PLATFORM_REJECTED", "message": "..." }`.

### 6.3. Error codes

| HTTP | `code` | When |
|------|--------|------|
| 400 | `VALIDATION_ERROR` | Invalid body, query or cursor |
| 401 | `UNAUTHORIZED` | Missing, invalid or revoked key |
| 404 | `NOT_FOUND` | Resource does not exist or belongs to another workspace |
| 409 | `IDEMPOTENCY_KEY_REUSED` | Same `Idempotency-Key` with a different body |
| 422 | `PLATFORM_NOT_SUPPORTED` | The platform does not support comments (registry) |
| 422 | `REPLY_DEPTH_EXCEEDED` | Reply deeper than `maxReplyDepth`; `detail` contains the top-level comment id |
| 422 | `TEXT_TOO_LONG` | Platform limit exceeded (characters or graphemes) |
| 422 | `PARENT_NOT_POSTED` | Parent is `queued` / `processing` / `failed` / `deleted` |
| 422 | `ACCOUNT_DISCONNECTED` | Account status is `disconnected` |
| 422 | `QUOTA_EXCEEDED` | Monthly active contacts limit reached |
| 429 | `RATE_LIMITED` | Per-key rate limit |
| 429 | `SYNC_COOLDOWN` | Manual sync requested more often than the cooldown allows |
| 500 | `INTERNAL_ERROR` | An unhandled failure in the service; `detail` carries no internal text (§18) |

Asynchronous `error.code` values on a comment: `PLATFORM_REJECTED`, `PLATFORM_AUTH_FAILED`,
`PLATFORM_RATE_LIMITED` (retries exhausted), `PARENT_DELETED`, `OUTCOME_UNKNOWN` (reconciliation and
retries exhausted).

## 7. Flows

### 7.1. Replying to a comment (and posting a top-level comment)

1. `api`: auth → load the parent within the workspace scope (otherwise 404) → checks: platform
   capability, `depth + 1 ≤ maxReplyDepth`, text length, `status = posted`, account `active`.
2. Idempotency: if `(workspace_id, idempotency_key)` already exists, compare the request hash;
   match → return the existing comment; mismatch → 409.
3. A single transaction: `ContactQuota.reserve` (if the parent's author ≠ the account) → insert
   `comments(status=queued, is_own=true, source=api)` → `reply_count + 1` on the parent and
   `last_activity_at` on the root.
4. After commit, enqueue `comment-publish` with `jobId = comment.id`. If enqueueing fails, a sweeper
   runs every minute and re-enqueues `queued` comments older than 1 minute with no active job.
5. `worker`: conditional transition `queued → processing` (`WHERE status = 'queued'`), records
   `last_attempt_started_at`, calls `adapter.publishComment`.
6. Outcome:
   - success → `posted` + `platform_comment_id`; outbox `comment.posted`;
   - `RetryableError` → back to `queued`, backoff (1s, 4s, 16s, 64s, 256s; up to 6 attempts; honor
     `Retry-After`);
   - `OutcomeUnknownError` → `adapter.findPublishedComment` (own author + same text + created no
     earlier than `last_attempt_started_at − 2 min`, among the parent's replies or the post's
     comments): found → `posted`; not found → retry as retryable;
   - `PermanentError` / `AuthError` → `failed` + code; on `AuthError` the account becomes
     `disconnected` — recorded in `account_health` and announced as outbox `account.auth_failed`,
     not written into the `social_accounts` projection (see D30 in §18); the quota reservation is
     released; outbox `comment.failed`.
7. Race with the webhook echo: if ingestion has already inserted our own comment, the worker's
   `UPDATE` hits the unique index → within one transaction the ingested duplicate is deleted, and the
   API-created comment gets `platform_comment_id` and status `posted`.

### 7.2. Webhook ingestion (Meta)

1. `POST /webhooks/meta`: verify `X-Hub-Signature-256` over the raw body (`timingSafeEqual`); invalid
   signature → 401 with nothing stored. Valid → insert into `webhook_deliveries` → enqueue
   `webhook-process` → `200` (target < 1 s; Meta retries for up to 36 hours).
2. `worker`: `WebhookNormalizer` turns the payload into `upsert` / `delete` events. Unknown account
   (e.g. a test event from the dashboard) → the delivery is marked processed with a warning log.
3. `upsert`: `INSERT ... ON CONFLICT (social_account_id, platform_comment_id) DO UPDATE` (text may
   have been edited). If the parent is unknown locally → `adapter.fetchComment` walks up the chain
   until a known ancestor or a top-level comment is found. New comment → `reply_count` on the parent,
   `last_activity_at` on the root, outbox `comment.received`.
4. `delete`: `status = deleted`, `text` and author fields are nulled, `reply_count − 1` on the parent,
   outbox `comment.deleted`.
5. A sweeper re-enqueues unprocessed deliveries older than 5 minutes.

### 7.3. Sync (backfill, reconciliation, Bluesky polling)

- Targets are created on the post-published event (a port from the publishing service; in the demo —
  the seed script) and on the first ingested comment for an external post.
- The scheduler (a repeatable job every minute) selects `next_sync_at ≤ now()` using
  `FOR UPDATE SKIP LOCKED` and enqueues `comment-sync` jobs.
- Intervals (configurable):

  | Post age | Bluesky (no push) | Meta (reconciliation) |
  |----------|-------------------|-----------------------|
  | < 24 h | 5 min | 30 min |
  | 1–7 days | 1 h | 6 h |
  | 7–45 days | 24 h | 24 h |
  | > 45 days | not polled | not polled |

- A job walks all pages (IG: `comments` + `replies` expansion; FB: `comments?filter=stream`;
  Bluesky: `getPostThread` with loading of truncated branches) and performs the same upsert as the
  webhook path.
- After a **complete** successful walk, comments no longer present on the platform are marked
  `deleted`. A partial walk (error midway) never infers deletions.
- A `PermanentError` from the platform (the post was deleted or is no longer accessible) deactivates
  the target — `next_sync_at = null`, the reason in `last_error` — instead of rescheduling it; the
  thread is left to retention. Deactivation infers no deletions: a post that is gone answers nothing,
  so the walk is not complete (previous rule). `RetryableError` keeps the schedule.
- Manual sync (D19): an active job already exists → `202` with that job;
  `manual_cooldown_until > now()` → `429 SYNC_COOLDOWN` (60 s cooldown). A manual request runs a job
  for a deactivated target too and restores its schedule on success — the client may know the post is
  reachable again.
- Events from sync carry `ingestionSource: "sync"`; comments found by a post's first backfill walk are
  tagged `"backfill"` so that consumers (DM automations) don't react to old comments.

### 7.4. Retention purge

A daily job deletes top-level comments with `last_activity_at < now() − 45d` in batches of 1000;
replies are removed by cascade. A thread lives as long as it has activity. Separately, the job purges
`webhook_deliveries` (7 days), published `outbox_events` (7 days) and `contact_quota_usage` for past
periods (> 2 months).

## 8. Platforms

### 8.1. Capability registry

| Platform | Comments | Top-level | Reply | `maxReplyDepth` | Text limit | Ingestion |
|----------|----------|-----------|-------|-----------------|------------|-----------|
| instagram | ✅ | ✅ | ✅ | 1 | 2200 characters | webhook + sync |
| facebook | ✅ | ✅ | ✅ | 1 | 8000 characters | webhook + sync |
| bluesky | ✅ | ✅ | ✅ | ∞ (`null`) | 300 graphemes | sync (polling) |
| threads, x, linkedin, youtube, tiktok, pinterest | ❌ | — | — | — | — | — |

Unsupported platforms have a `reason` in the registry (e.g. "platform API access not in place").
DESIGN.md describes what it takes to add a platform: an adapter + a registry entry; the database
schema and API stay unchanged.

### 8.2. Meta (Instagram + Facebook)

- Login (D28):
  - `facebook_login`: a long-lived Page access token covers the FB Page and the linked IG
    professional account; host `graph.facebook.com`;
  - `instagram_login` (IG only): a long-lived Instagram user token (60 days, refreshed via
    `refresh_access_token`); host `graph.instagram.com`, permission
    `instagram_business_manage_comments`.
  - Read and write endpoints have the same shape; the Graph client picks host and token by
    `auth_variant`. The API version is configurable.
- IG: read `GET /{media-id}/comments?fields=id,text,timestamp,from,replies{...}`; top-level
  `POST /{media-id}/comments`; reply `POST /{ig-comment-id}/replies`.
- FB: read `GET /{post-id}/comments?filter=stream&fields=id,message,created_time,from,parent`;
  top-level `POST /{post-id}/comments`; reply `POST /{comment-id}/comments`.
- Webhooks: `instagram.comments` and `page.feed` (`item=comment`, `verb=add|edited|remove`).
- Rate limits: parse `X-Business-Use-Case-Usage` / `X-App-Usage`; under high usage, delay that
  account's jobs.
- "Own" comment: `from.id` matches the account's IG user id / Page id.

### 8.3. Bluesky

- Auth: handle + app password → `createSession` (access / refresh JWT; session refresh inside the
  adapter).
- `platform_post_id` / `platform_comment_id` are AT URIs; `cid` is stored in `platform_meta`.
- Read: `app.bsky.feed.getPostThread` (`depth` from config), loading truncated branches.
- Write: `com.atproto.repo.createRecord` (`app.bsky.feed.post`) with
  `reply: { root: {uri, cid}, parent: {uri, cid} }`; `root` is the post, `parent` is the comment or
  the post.
- Text: link and mention facets via `RichText.detectFacets`; the limit is counted in graphemes.
- "Own" comment: the author's DID matches the account's DID.
- Deletions: `notFoundPost` in the thread or absence after a complete walk → `deleted`.

## 9. Events and queues

### 9.1. Domain events (outbox → BullMQ `domain-events`)

Envelope: `{ id, type, version: 1, occurredAt, workspaceId, data }`; BullMQ `jobId = event.id`
(deduplication), at-least-once delivery, consumers must be idempotent.

| Type | `data` |
|------|--------|
| `comment.received` | `commentId`, `socialAccountId`, `platform`, `postId`, `platformPostId`, `parentCommentId`, `isOwn`, `authorPlatformId`, `text`, `ingestionSource` (`webhook` / `sync` / `backfill`) |
| `comment.posted` | `commentId`, `socialAccountId`, `platform`, `postId`, `parentCommentId`, `platformCommentId` |
| `comment.failed` | `commentId`, `errorCode`, `errorMessage` |
| `comment.deleted` | `commentId`, `socialAccountId`, `platform` |

Relay: a repeatable job runs every second, selects unpublished events (`FOR UPDATE SKIP LOCKED`,
batch of 100), publishes them and sets `published_at`.

### 9.2. BullMQ queues

| Queue | Purpose | Concurrency and limits |
|-------|---------|------------------------|
| `comment-publish` | comment publishing (7.1) | per-account token bucket in Redis |
| `webhook-process` | delivery processing (7.2) | 10 |
| `comment-sync` | target sync (7.3) | per-account token bucket |
| `scheduler` | repeatable: sync scheduler, stuck-work sweeper, outbox relay, purge. The webhook-delivery sweeper of §7.2 step 5 joins this queue when it is built (Meta spike gate) | 1 |
| `domain-events` | external consumers (not implemented) | — |

Redis for BullMQ: `maxmemory-policy noeviction`, persistence enabled (AOF).

## 10. Security

- API keys: format `blt_<prefix>_<secret>` (≥ 32 bytes of entropy); the database stores `prefix` +
  `sha256(secret)`; constant-time comparison. Keys are created by a CLI script and shown once.
- Platform tokens: AES-256-GCM, key `CREDENTIALS_ENCRYPTION_KEY` from env, `key_version` for
  rotation; decrypted only inside the adapter for the duration of a call.
- Webhooks: HMAC verification over the raw body before JSON parsing; `verify_token` from env.
- Logs: pino with redaction for `blotato-api-key`, tokens and comment text; `requestId` / `jobId` on
  every entry.
- Tenancy: every repository call takes `workspaceId`; integration tests assert 404 for other
  workspaces' resources on every endpoint.
- Per-key rate limit: `@fastify/rate-limit` with a Redis store; the demo key gets 30 reads and 5
  writes per minute.
- Config is validated with Zod at startup; a missing variable fails fast with a clear message.

## 11. Testing

- **Unit**: status state machine, reply rules (depth / text / parent status), cursor codec, grapheme
  counting, HMAC verification, webhook payload and platform response normalizers on fixtures,
  registry.
- **Property-based** (fast-check): cursor codec round-trip; the Meta normalizer never crashes on
  arbitrary JSON and rejects invalid input.
- **Integration** (testcontainers Postgres + Redis, `fastify.inject`, platform HTTP mocked with msw):
  - GET: pagination without duplicates or gaps when rows are inserted between pages, for both
    `order` values; a cursor with a different `order` → 400; `replyCount`; placeholder for a deleted
    comment with live replies;
  - IG adapter: identical behavior for `facebook_login` and `instagram_login` (parameterized tests on
    fixtures for both hosts);
  - reply: happy path to `posted`; idempotency (repeat → same comment, different body → 409);
    `REPLY_DEPTH_EXCEEDED` for IG; deep reply on Bluesky; `QUOTA_EXCEEDED` and no double reservation
    under concurrent requests;
  - timeout → reconciliation finds the comment → no duplicate; doesn't find it → retry;
  - webhook: invalid signature → 401; redelivery → one row and one event; race between the webhook
    echo and the worker (7.1, step 7);
  - sync: a complete walk marks deletions; a partial walk doesn't; manual sync cooldown;
  - outbox: an event appears only after commit and is published once;
  - tenancy: 404 for other workspaces' resources on every endpoint;
  - retention: purge removes inactive threads and keeps active ones.
- **Smoke against the deployment**: a script runs the README walkthrough against real accounts.
- Verifying tests catch failures: for key invariants (deduplication, reconciliation, tenancy) the
  code is temporarily broken to confirm the test fails.

## 12. Deployment and demo

- Railway: `api` (public domain) and `worker` services from one Dockerfile (multi-stage,
  `node:22-slim`, non-root), managed Postgres and Redis. Migrations run as a pre-deploy command.
- GitHub Actions: lint / typecheck / test on PRs; deploy to Railway from `main`.
- Meta App (Business type, Standard Access): roles for the author's account; an IG professional
  account linked to an FB Page; webhooks configured at `https://<domain>/webhooks/meta`.
- Bluesky: a dedicated test account with an app password.
- Seed (D26): workspace + demo API key + 3 social accounts + several published posts as sync targets.
- README walkthrough: `GET /v1/platforms` → `GET /v1/posts/:id/comments` → `POST .../replies` → poll
  `GET /v1/comments/:id` until `posted` → reply to a reply on IG (422) and on Bluesky (202) →
  `POST .../comments/sync`.

## 13. Deliverables

- `README.md`: what it is, link to the deployment and `/docs`, walkthrough, local run (docker
  compose), layout, "How I used AI tools" section.
- `DESIGN.md`: context and scope, architecture (mermaid) including the service boundary — what the
  service owns, what it reads through ports, and why it is not split further (§4.1),
  database schema (ER diagram), API, flows
  (reply / webhook / sync sequence diagrams), platforms and registry, key decisions with trade-offs and
  alternatives, assumptions, Meta deployment constraints, differences from the current
  `/v2/comments`, evolution path (Jetstream, partitioning, remaining platforms, private replies).
- `openapi.json` generated from Zod schemas (CI checks that the committed version is up to date).
- Code, migrations, tests, CI.

## 14. Out of scope

- OAuth connect flow, account management and post publishing (other services).
- Private replies and DMs; implementing event consumers (DM automations, inbox UI).
- Moderation: hide / unhide, likes, deleting and editing comments through our API.
- Media attachments in comments.
- Adapters for the remaining 6 platforms.
- Jetstream, table partitioning, OpenTelemetry tracing, multi-region.
- Outbound webhooks to customers; admin UI.

## 15. AI usage

Claude Code was used to run the requirements interview and produce this specification, to research
Blotato and Meta documentation, and then for implementation under the author's review. The README
describes this briefly and factually.

## 16. Assumptions

Product and domain:

- **A1.** A "published post" is a row in `posts` with a `platform_post_id`; posts in other states
  belong to the publishing service and are not visible to the comments service.
- **A2.** An "own" comment is determined by the author id matching the connected account id, not by
  whether it was created through our API.
- **A3.** (changed → D27) Ordering is controlled by the `order` parameter; by default top-level
  comments and the inbox go newest first (inbox semantics, as in Blotato), replies go oldest first
  (reading a conversation).
- **A4.** (confirmed) Lists include comments in every status except `deleted`: clients see their own
  `queued` and `failed` replies. A deleted comment with live replies is returned as a placeholder
  (`status: deleted`, `text: null`); otherwise it is hidden.
- **A5.** Comment text is plain text only; for Bluesky, link and mention facets are built
  automatically.
- **A6.** Only comments in status `posted` can be replied to.
- **A7.** Top-level comments on external posts (no `postId`) are not supported; replying to a comment
  on an external post is supported (D13).
- **A8.** The active contacts quota is reserved at enqueue time and released on a final `failed`.
  The same person on the same platform within a month counts once. Concurrent reservations are
  serialized with an advisory lock on `(workspace_id, period)`.
- **A9.** (confirmed) Retention is measured from the thread's last activity (`last_activity_at` on the
  root), not from the age of an individual comment: a thread is never cut in the middle.
- **A10.** A post's first sync walk tags the comments it finds as `backfill`, so event consumers don't
  react to old comments.
- **A10a.** (added with D29) A comment can outlive the `posts` row it references, and the service does
  not track that: comments are anchored to `platform_post_id`, which the adapters use, while `post_id`
  only serves the post-scoped route. If the ports no longer resolve a `postId`,
  `GET /v1/posts/:postId/comments` returns `404` and the comments stay reachable through the account
  inbox — the same shape as an external post (D13). No cross-service cascade or `post.deleted`
  subscription is needed; retention bounds the dangling rows. A post deleted on the **platform** is a
  different case and is handled by sync (§7.3).

API:

- **A11.** (confirmed) `POST` returns `202 Accepted` (not `201` as in Blotato): the resource is
  created, but the action on the platform hasn't happened yet.
- **A12.** `Idempotency-Key` is optional but recommended; the key is stored with the comment and lives
  as long as the comment.
- **A13.** The cursor is an opaque base64url string encoding the keyset position `(occurred_at, id)`
  and the `order` direction; it is stable under inserts; a cursor passed with a different `order` →
  `400 VALIDATION_ERROR`.
- **A14.** Versioning via the `/v1` path prefix.
- **A15.** Ids are UUIDv7 without type prefixes.
- **A16.** (changed by the author) The auth header is `blotato-api-key`, as in Blotato's public API:
  the service reads as part of the existing platform, and clients (n8n, Make, MCP) can reuse their
  settings. OpenAPI describes it as an `apiKey` header scheme, so Swagger UI supports it.

Platforms and integrations:

- **A17.** (changed → D28) IG supports both login variants. The same IG account connected through
  different variants is a separate `social_accounts` row (the variants' id spaces may differ); no
  merging across variants. Refreshing the 60-day Instagram user token is the accounts service's job;
  the token lifetime is sufficient for the demo, and the README states the expiry date.
- **A18.** Meta webhooks are subscribed with values included (the payload contains text and author);
  if data is missing, it is fetched through the API.
- **A19.** An invalid token (`AuthError`) moves the account to `disconnected` and stops its jobs;
  reconnecting is the accounts service's job. How the status moves without writing another service's
  table is D30 in §18.
- **A20.** Bluesky reply depth is not limited at the service level; UI limits are the client's concern.

Infrastructure:

- **A21.** A single Railway region; SLAs and scaling beyond one `api` instance and one `worker` are
  not designed.
- **A22.** Observability is structured pino logs + health checks; metrics and tracing are out of scope.
- **A23.** Local run via docker compose is supported for development and CI, but the reviewer uses the
  deployment (D22).

## 17. Risks and spikes (run before implementing the corresponding parts)

- **S1. FB Page `feed` webhooks in development mode.** Check whether comment events from a user with a
  role on the app are delivered. If not, the webhook path is demoed only with test events from the
  dashboard, and real data arrives through sync (D23).
- **S2. Reading IG comments in Standard Access for both login variants.** The Meta forum has reports of
  empty `data` for `/comments` in Standard Access via Instagram Login. Test both variants and use
  whichever works for the live demo. If neither works, IG is covered by fixture-based tests, the live
  demo relies on FB and Bluesky, and the limitation is described in DESIGN.md.
- **S3. Railway Redis.** Confirm that `maxmemory-policy noeviction` can be set and persistence enabled;
  otherwise run Redis from a Docker image with a volume.
- **S4. Bluesky limits.** Check current rate limits for `createRecord` and `getPostThread` and tune the
  polling intervals.
- **S5. Webhook signing secret for Instagram Login.** Check which secret (Meta App Secret or Instagram
  App Secret) signs webhooks for the `instagram_login` variant. The verifier must support both secrets
  from config.

## 18. Open questions

None outstanding. Any change to decisions in sections 3 and 16 is recorded here before
implementation.

### Recorded changes

- **D30 (amends §7.1 step 6 and A19).** "The account is marked `disconnected`" is kept as a
  *behaviour*, not as a write to `social_accounts`. That table is a read-only projection of the
  accounts service (D8, D29, Constitution Principle II), and writing its `status` column would make
  this service a second writer of another service's data — the one boundary the design exists to
  demonstrate. Instead this service owns `account_health` (§5.3): on `AuthError` the worker records
  `auth_failed` there, emits outbox `account.auth_failed` for the accounts service, and stops the
  account's jobs. The `Accounts` port returns an **effective** status — `active` only when the
  projection says `active` *and* no local `auth_failed` record exists — so §6.3
  `ACCOUNT_DISCONNECTED` and A19 behave exactly as specified, while the boundary holds. Clearing the
  record remains the accounts service's job (reconnection), and a projection row that flips back to
  `active` clears it.
- **`INTERNAL_ERROR` (extends §6.3).** FR-032 requires every failure to be
  `application/problem+json` carrying a machine-readable `code`, but the §6.3 catalogue lists only
  the failures a client can cause: it has no entry for an unhandled exception. The global error
  handler therefore needs a code the catalogue does not provide, and the alternatives were both
  worse — a `500` body with no `code` breaks FR-032 for the one case a client cannot anticipate, and
  reusing an existing code would misreport a bug as a client error. Added: `500` `INTERNAL_ERROR`,
  "An unhandled failure in the service; `detail` carries no internal text." It is a synchronous code
  and never appears as a comment's `error.code`. This extends the catalogue rather than revising any
  decision, so no D-number changes.
- **`comment_sync_targets.age_anchor_at` (extends §5.3 and §7.3).** §7.3 schedules a refresh by
  **post age**, but the table as specified carries no timestamp to measure that age from, and the
  alternatives both fail: reading `posts.published_at` through the `Posts` port would be one
  cross-boundary call per due target on every scheduler tick (an N+1 across a service boundary, every
  minute), and for a post never published through the platform there is no projection row to read at
  all — while §7.3 requires exactly those posts to be tracked. Added: `age_anchor_at timestamptz not
  null` — the instant the age bands are measured from. For a post registered through the
  `PostPublished` port it is that post's `published_at`; for an external post first seen through an
  ingested comment it is that comment's `occurred_at`, which establishes only that the post existed by
  then. The column is named for what it is used for rather than `published_at`, because for an
  external post it is a lower bound and not a publication time, and a name that implied otherwise
  would invite a reader to treat it as one. This adds a column; it revises no decision, so no
  D-number changes.
- **The stuck-work sweeper also recovers `processing` (extends §7.1 step 4).** Step 4 describes the
  sweeper as re-enqueueing `queued` comments older than a minute with no active job, which leaves one
  state with no way out: a worker that dies between the conditional `queued → processing` transition
  and settling the outcome leaves the row in `processing` forever. BullMQ's stalled-job retry does not
  recover it, because the retry's own `markProcessing` finds the row no longer `queued`, affects no row
  and correctly stops. Nothing double-publishes — the conditional updates still hold — but the comment
  never reaches a terminal state and the customer's reply is neither posted nor failed.
  The sweeper therefore also selects `status = 'processing'` rows whose `last_attempt_started_at` is
  older than a threshold comfortably beyond the longest plausible platform call, and returns them to
  `queued` for another attempt. That attempt is safe for the same reason a retry after an unknown
  outcome is safe: `attempt_count` has already been incremented, and reconciliation through
  `findPublishedComment` still gates any second send. The threshold is deliberately generous, because
  returning a row that is genuinely still being published costs a reconciliation read, while leaving it
  stuck costs the reply. The index `(status, last_attempt_started_at) WHERE status IN ('queued',
  'processing')` already covers this selector — it was specified for both states from the start, which
  is itself evidence the omission was in the prose rather than the design. This extends a step; it
  revises no decision, so no D-number changes.
- **`CommentPage` carries deleted ids separately from comments (extends §8.3 and the adapter
  contract).** §8.3 says a Bluesky `notFoundPost` marker is an explicit tombstone that may mark that
  comment deleted on its own. Returning it inside `CommentPage.comments` as an ordinary
  `NormalizedComment` made that unachievable in practice: a consumer iterating the page upserts it as
  `posted`, and — worse — recording it as *seen* suppresses the absence-based deletion the complete
  walk would otherwise have detected, so the tombstone actively prevents the fallback it was meant to
  pre-empt. `CommentPage` therefore gains a separate field for the platform comment ids a page reports
  as deleted; adapters put tombstones only there, and the refresh walk routes them through the same
  delete branch a webhook delete uses, without adding them to the seen set. The signal has to live
  outside `NormalizedComment` because otherwise every future consumer of `listComments` must remember
  it exists — which is exactly the mistake that occurred. This changes a contract shape; it revises no
  decision, so no D-number changes.
