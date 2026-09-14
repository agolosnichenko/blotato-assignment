# Blotato Take Home — Comment System: Specification

> The working specification, and the source of truth for every numbered decision. Decisions are in
> §3 (D1–D31), assumptions in §16 (A1–A23), spikes and their results in §17. §18 records every change
> made to a decision or assumption after this document was first written — each entry states what
> changed and why, and is written before the code diverges.
>
> The reader-facing write-up is `DESIGN.md`; this document is deliberately more granular.

## 1. Original task

See `task.md`. Design and partially implement a comment system for a social media scheduling API:

- retrieve comments for a published post;
- reply to a comment;
- support multiple social platforms (including future ones);
- expose the functionality through a REST API.

Deliverables: database schema, API design, TypeScript code, explanation of major design decisions,
list of assumptions, description of AI tool usage. The answer is a link to a GitHub repository.

The brief states explicitly that reasoning is what's evaluated, not parity with Blotato's own
implementation. This specification therefore optimizes for explicit trade-offs, production-grade
reliability and a service that actually runs.

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
| D11 | Read shape | (narrowed → D31, §18) One collection `GET /comments`: hierarchy is a filter, not an address. `postId` + `topLevelOnly` gives a post's top level with `replyCount`, `parentCommentId` gives direct replies; one cursor shape at every level | One model for depth 1 and ∞, predictable response size; the address does not have to be known to read |
| D12 | Reply depth | Strict check against the `maxReplyDepth` capability → `422 REPLY_DEPTH_EXCEEDED` | No implicit change of request semantics |
| D13 | External posts | Comments on posts not published through Blotato are stored with `postId = null`, emit events, are available via `GET /comments?accountId=...` (D31), and can be replied to | Required for the "on any post" automation and the account inbox |
| D14 | Publish retries | Backoff only on retryable errors; on an uncertain outcome, reconcile first (look for our comment on the platform), then retry | A duplicate public reply on behalf of a brand is worse than a delay |
| D15 | Retention | 45 days (configurable), purge job. Partitioning is described in DESIGN.md as the next step | Mirrors the product, limits PII and table growth |
| D16 | Active contacts | A `ContactQuota` port reserves the contact before enqueueing; exceeding the limit → `422 QUOTA_EXCEEDED`. The limit is read through the port from the projected `workspaces.contact_limit_monthly` (in the real platform — billing entitlements) | A real business constraint behind a billing interface |
| D17 | Bluesky ingestion | Adaptive polling; Jetstream is described in DESIGN.md as the scaling path | One sync mechanism without a stateful WebSocket component |
| D18 | Documentation | English: README, DESIGN.md (mermaid), OpenAPI generated from Zod schemas. `spec.md` is the working specification, also in English | The founder reads the repository |
| D19 | Manual sync | `POST /posts/:postId/comments/sync` → `202` + sync job; `lastSyncedAt` reported on a read that names a post (D31) | A client or agent can request fresh data itself |
| D20 | Tenancy and auth | API key (only the hash is stored) → workspace; scoped by `workspace_id`; another workspace's resource → `404`; per-key rate limit in Redis | Team-friendly model that does not reveal other tenants' resources |
| D21 | Tooling and CI | pnpm, oxlint + oxfmt, `tsc --noEmit`, vitest + testcontainers, prek, GitHub Actions (SHA-pinned, zizmor), Dependabot | Guardrails from the first commit |
| D22 | How the result is evaluated | The reviewer won't run the code locally → public deployment with real accounts | Author's decision |
| D23 | Meta access | A real Meta App in Standard Access without App Review or Business Verification. IG/FB comments arrive through the sync job; the webhook path is exercised with test events from the App Dashboard and spike S1 for FB Page feed. The limitation is stated openly in DESIGN.md | Business verification and review take weeks and are outside our control |
| D24 | Hosting | Railway: `api` and `worker` services from one Dockerfile, managed Postgres and Redis, HTTPS domain, deploys from GitHub | Minimal ops while still running real HTTPS / worker / Postgres / Redis |
| D25 | Reviewer access | Public Swagger UI (`/docs`); the demo API key is sent in the email, not committed to the repository; the key is bound to a demo workspace, has a reduced rate limit and can be revoked; README contains a curl walkthrough | The reviewer can try a reply, but a random repository visitor cannot post on behalf of real accounts |
| D26 | Account tokens | Adapters obtain credentials through an `AccountCredentials` port, never from a table. The single implementation for this deployment reads the local projection and decrypts AES-256-GCM (key from env); a CLI seed script accepts manually obtained tokens (Meta long-lived Page token or Instagram user token, Bluesky app password) and subscribes the account to webhooks. In the platform the port is a call to the accounts service returning a short-lived token | Token custody belongs to the accounts service (D8); the port is the seam, and the demo needs exactly one implementation behind it |
| D27 | List ordering | The listing accepts `order=asc\|desc` and the cursor encodes the direction; a cursor replayed under the other direction is a `400`. The per-route defaults (`desc` for top-level and inbox, `asc` for replies) are superseded by D31 (§18): one collection has one default, `desc`, and a reply thread asks for `order=asc` | The client picks the scenario (inbox or reading a conversation); B-tree indexes are readable in both directions, so no extra indexes are needed |
| D28 | Instagram login | The IG adapter supports both variants: Facebook Login for Business (Page token, `graph.facebook.com`) and Instagram Login (Instagram user token, `graph.instagram.com`). The variant is stored in `social_accounts.auth_variant`; differences are isolated in the Graph client, and use cases do not depend on the variant | Instagram Login is how most modern creators connect without an FB Page; Facebook Login covers businesses with a linked Page |
| D29 | Data ownership | The service owns its schema. References to other services' entities (`workspace_id`, `social_account_id`, `post_id`) are plain `uuid` columns with no foreign key; only links inside the service (`parent_comment_id`, `root_comment_id`) keep foreign keys. Referential integrity comes from port validation on write and platform events on delete | A foreign key across a service boundary forces a shared database and blocks independent schema changes; the read contract (§6.2) needs no data from other services, so the boundary costs nothing |
| D30 | Account disconnection | "Disconnected" is a behaviour, not a write to `social_accounts`. On `AuthError` this service records `auth_failed` in its own `account_health` table and emits `account.auth_failed`; the `Accounts` port returns an **effective** status (`active` only if the projection says `active` and no local record exists). Cleared by a successful platform call, not by a projection read. Full rationale in §18 | Writing another service's table would make this service its second writer — the one boundary violation D8/D29 exist to avoid |
| D31 | Read shape | The three nested reads (`GET /posts/:id/comments`, `/comments/:id/replies`, `/accounts/:id/comments`) are **replaced** by one filtered collection `GET /v1/comments`; filters intersect, writes keep their addresses. Full rationale, and what it does not touch, in §18 | The moderation view the product is for — every comment across every account — had no address at all; hierarchy belongs in a filter, not in a path |

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
      application/          # use cases: ListComments (one filtered read, D31), CreateReply,
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
- `(workspace_id, occurred_at DESC, id DESC)` — the workspace-wide listing with no identifier filter
  (D31); this is what keeps its cost bound to the page rather than to the workspace's history.
- `(post_id, occurred_at DESC, id DESC) WHERE parent_comment_id IS NULL` — a post's top-level page
  (`postId` + `topLevelOnly`).
- `(parent_comment_id, occurred_at ASC, id ASC)` — a replies page (`parentCommentId`).
- `(social_account_id, occurred_at DESC, id DESC)` — one account's inbox (`accountId`).
- `(last_activity_at) WHERE parent_comment_id IS NULL` — retention purge.
- `(status, last_attempt_started_at) WHERE status IN ('queued', 'processing')` — finding stuck rows.
- List indexes serve both `order` values (D27): Postgres scans B-trees backwards. This holds only
  while each index and the listing's `ORDER BY` agree on NULL placement, so neither names one and
  both stay at Postgres's default for the direction. `benchmark.integration.test.ts` asserts the
  whole selection × direction matrix through `EXPLAIN` — see §18 for why that matrix, and not one
  case per index, is the guard.

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
| `GET /v1/comments` | The workspace's comments across every account and post (D31). All filters optional and combinable: `postId`, `parentCommentId`, `accountId`, `platform` (repeatable), `topLevelOnly`, `isOwn`, `since`, `until`; `order`, default `desc`; `limit` 1–100, default 20; `cursor` | `200 { items: Comment[], nextCursor, sync?: { lastSyncedAt, activeJobId } }` — `sync` present iff `postId` is among the filters |
| `GET /v1/comments/:commentId` | A single comment (status polling) | `200 Comment` |
| `POST /v1/posts/:postId/comments` | Top-level comment. Body `{ text }`, `Idempotency-Key` header | `202 Comment(status=queued)` + `Location` |
| `POST /v1/comments/:commentId/replies` | Public reply. Body `{ text }`, `Idempotency-Key` | `202 Comment(status=queued)` + `Location` |
| `POST /v1/posts/:postId/comments/sync` | Manual sync | `202 SyncJob` |
| `GET /v1/comment-sync-jobs/:jobId` | Sync status | `200 SyncJob` |
| `GET /v1/platforms` | Capability registry | `200 { items: PlatformCapabilities[] }` |
| `GET /webhooks/meta` | Subscription verification (`hub.challenge`) | `200 text` |
| `POST /webhooks/meta` | Meta event intake (IG and Page) | `200` |
| `GET /healthz`, `GET /readyz` | Liveness / readiness (Postgres + Redis) | `200` / `503` |
| `GET /docs`, `GET /openapi.json` | Swagger UI and the spec | |

Every endpoint above requires the API key except the two health probes and the two webhook
operations, which authenticate by their own means (`hub.verify_token`, HMAC over the raw body). The
published document declares the key scheme globally (A16) and clears it on the exempt operations it
contains — the health probes; the webhook operations and `GET /openapi.json` are `hide: true` and
`/docs` is plugin-served, so the document cannot annotate them. The exempt list has one source, the
array the authentication hook enforces, so what is described and what is enforced cannot drift.

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
  workspaces' resources on every endpoint that names one — and, on the listing, on every
  identifier-shaped filter it accepts (D31), which is where a foreign id can enter a read.
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
  - tenancy: 404 for other workspaces' resources on every endpoint that names one, and one case per
    identifier-shaped filter of the listing (`postId`, `parentCommentId`, `accountId` — D31);
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
- README walkthrough, in order: `GET /v1/platforms` → `GET /v1/comments` with no identifier at all
  (D31 — the reviewer holds only a key) → `GET /v1/comments?postId=:id&topLevelOnly=true` →
  `POST .../replies` → poll `GET /v1/comments/:id` until `posted` → reply to a reply on IG (422) and
  on Bluesky (202) → `POST .../comments/sync` → auth and tenancy (401 / 404). `pnpm smoke` runs
  steps 1–7 with assertions.

## 13. Deliverables

- `README.md`: what it is, the deployment and `/docs`, the walkthrough, local run, layout, and the
  "How I used AI tools" section the brief asks for.
- `DESIGN.md`: context and scope, architecture (mermaid) including the service boundary, data model
  (ER diagram), API, the three flows (reply / webhook / sync sequence diagrams), platforms and
  registry, key decisions with trade-offs and rejected alternatives, assumptions, implementation
  status and its gaps, differences from the current `/v2/comments`, evolution path.
- `openapi.json` generated from Zod schemas (CI checks the committed version is up to date).
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
- **A3.** (changed → D27, then → D31) Ordering is controlled by the `order` parameter. With one
  collection there is one default — newest first, the inbox semantics the cross-account view needs;
  reading a conversation oldest-first is `order=asc` on the request.
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
  only serves the `postId` filter. If the ports no longer resolve a `postId`, that filter answers
  `404` and the comments stay reachable through the unfiltered listing or an `accountId` filter —
  the same shape as an external post (D13). A comment is never withheld because its post reference
  has stopped resolving; only a request that *names* the vanished post fails. No cross-service cascade or `post.deleted`
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

## 17. Risks and spikes

Each spike gates the part of the implementation it answers: nothing is built on unverified platform
behaviour. All six ran on 2026-09-13.

**S1. FB Page `feed` webhooks in development mode.** Are comment events from a user with a role on
the app delivered?

- Setup verified: Page token valid (`expires_at=never`, all scopes), Page subscribed to `feed`
  (`subscribed_apps` reports our app and only ours), tunnelled receiver answered the `hub.challenge`
  handshake.
- **A dashboard `Test` send was delivered** — payload recorded, `object: "page"`,
  `entry[].changes[].field: "feed"`. The Meta → endpoint path works end to end.
- **A real comment was not.** Two comments on a real Page post — one by the app's own admin, one by
  an account with no role — produced no delivery, with the receiver verified live before and after
  by a direct `POST` through the same tunnel. The negative is about Meta, not the transport.
- **Consequence (confirms D23):** the webhook path is demonstrated with dashboard test events; real
  IG/FB data arrives through sync. Intake, signature check and normalizer are built and tested
  against the recorded payload, whose envelope is the one a real delivery carries.

**S2. Reading IG comments in Standard Access, both login variants.** The Meta forum reports empty
`data` for `/comments` under Instagram Login.

- **`facebook_login`: works.** `GET /{media-id}/comments` on `graph.facebook.com` returned HTTP 200
  with 2 top-level comments against a Standard Access app. Raw body committed as
  `src/platforms/meta/__fixtures__/s2-facebook-login-comments.json`. Three observations the adapter
  depends on: replies are **nested** under a comment's `replies.data`, not listed in `data`; `from`
  carries `{id, username}` and no `name`, so `author_display_name` is null for Instagram; there is
  **no `paging` key** when the result fits one page, so IG cursor handling is unexercised by this
  fixture — a known gap, not a resolved one.
- **`instagram_login`: not attempted.** It requires a second Meta App (the two variants cannot
  coexist in one) and its own OAuth flow. Recorded as distinct from "returned nothing": the latter
  would be a claim about Meta's behaviour, and this spike has not established it.

**S3. Railway Redis.** Can `maxmemory-policy noeviction` and persistence both be set?

- **Half negative.** The managed instance returned `noeviction` and `appendonly no`, and the
  `redis()` helper exposes no way to pass server flags. Its start command is `redis-server
  --requirepass … --save 60 1 --dir …`, so that database is RDB-snapshotted once a minute rather
  than unpersisted — the gap is bounded, not total: a crash loses up to a minute of queue state.
- **Fallback applied** (pre-committed, deployment configuration only, no code moved): Redis runs
  from `redis:8.10.1-alpine` — the image `docker-compose.yml` already uses — with a volume at
  `/data`. Confirmed on the deployment: `CONFIG GET appendonly maxmemory-policy` returns `yes` and
  `noeviction`, and `/readyz` reports Redis reachable.
- **One non-declarative gap, recorded rather than hidden.** Railway's IaC types let a database carry
  image, output, mount path and region — not a start command; declaring it as a plain service
  instead makes Railway reclassify it and every later plan wants to recreate the running instance.
  The flags therefore live on the resource, not in the file, and an apply into a *fresh* environment
  produces image defaults with no AOF. `.railway/railway.ts` carries the same warning.
- **Why AOF matters here.** Postgres is the source of truth and the sweepers re-enqueue lost work, so
  a Redis restart loses no comment — but every in-flight job waits for a sweeper, and
  `domain-events`, which has no consumer (D9), would be emptied outright. `noeviction` protects the
  queue from a full memory buffer, not from a restart.

**S4. Bluesky rate limits**, to tune the polling intervals.

- **Writes are per DID, by points.** A record CREATE costs 3 points against 5,000/hour and
  35,000/day — 1,666 creates an hour. The publish worker's placeholder refill of 0.5/s allowed 1,800
  an hour and so **exceeded the hourly ceiling**; lowered to 0.25/s (900/hour, 54% of budget). The
  daily ceiling is left unguarded deliberately: a bucket sized for it would throttle an ordinary
  day's bursts, and crossing it degrades to a `429` that arrives as `RetryableError` with
  `Retry-After`.
- **Reads are per IP, not per account** — ~3,000 requests per 5 minutes against the public appview.
  The per-account token bucket does **not** protect this: every sync target draws on one shared
  budget. At the §7.3 `<24h` interval that covers ~3,000 concurrently-fresh posts, well beyond this
  deployment. Recorded because the mitigation would be a longer interval, not another per-account
  bucket, which cannot bind on a per-IP limit.
- `BLUESKY_THREAD_DEPTH` stays at 10: depth costs no extra requests, since `getPostThread` returns
  the whole requested depth in one call.

**S5. Which secret signs webhooks for the `instagram_login` variant?**

- **Confirmed for `page`:** on a captured delivery, `X-Hub-Signature-256` matched
  `HMAC-SHA256(META_APP_SECRET, <raw body bytes>)` exactly — establishing both the secret and that
  the digest is over the unparsed body, not a re-serialization.
- **The `instagram_login` half stays open**, needing a second Meta App. What is unresolved is a
  *configuration value*, not a code shape: the verifier takes the secret per variant from config
  either way, so the webhook path is built. `META_APP_SECRET_INSTAGRAM` is set to the one app's
  secret in this deployment — a separate variable rather than a fallback, so that a second app, when
  it exists, is a variable change and not a code change.

**S6 (unplanned). Facebook Page comments: an access-model dead end that was not one.**

- **Symptom.** Sync failed with `(#10) This endpoint requires the 'pages_read_user_content'
  permission`, publishing with `(#200) You do not have sufficient permissions`, and Meta's login
  dialog answered `Invalid Scopes: pages_read_user_content`.
- **First conclusion, wrong, kept because the error is the useful part:** "no longer grantable
  without App Review." `Invalid Scopes` was read as a statement about *authorization* — Meta
  refusing — when it is a statement about *existence*. Under the use-case model a permission is only
  requestable once it has been added to one of the app's use cases *and* enabled on the Facebook
  Login for Business configuration; unadded, it reports as invalid, which is indistinguishable from
  denied by message alone. Three dialog attempts were spent before the difference was noticed.
- **What located the gap.** `debug_token` showed a correct Page token — type `PAGE`, never expiring,
  granular `pages_read_engagement`, `pages_show_list`, `pages_manage_metadata` — missing exactly two
  permissions. Reading the post object succeeded while every comment read failed, placing the gap on
  the comments edge rather than on the token, object id or host.
- **The fix: two dashboard edits, no App Review and no Business Verification.**
  `pages_read_user_content` and `pages_manage_engagement` are optional permissions of the *Manage
  everything on your Page* use case, covered by Standard Access for a Page the app admin owns. Add
  them to the use case, enable them on the Login for Business configuration, then mint a fresh token.
- **Result.** `GET /{post-id}/comments` returns the Page post's comments with `paging.cursors.after`
  and no `paging.next` — the terminal-page shape the adapter must read as "walk complete", exercised
  for real for the first time. Through the deployment: sync `fetched: 3, inserted: 3`, a published
  reply (`122093382351485339_936214829041858`), `422 REPLY_DEPTH_EXCEEDED` on the second level.
- **No code changed**, and D23's remaining consequence is narrower than it looked: Standard Access
  blocks *webhook delivery* (S1), not Page reads. The failure had surfaced as a typed platform
  rejection carrying the platform's own message, which is what §6.3 asks of it. What was wrong was a
  document.
- **One shape difference worth keeping.** Facebook's `from` carries `{id, name}` and no username;
  Instagram's `{id, username}` and no name (S2). Two platforms from one vendor disagree on the author
  field, so `author_username` is null for Facebook and `author_display_name` null for Instagram —
  both normalizations are load-bearing, neither is defensive.

## 18. Recorded changes

No open questions outstanding. Every change to a decision (§3) or assumption (§16) is recorded here
before the code diverges from it, grouped below by what kind of change it is.

### Decisions added after the first draft

- **D30 — account disconnection is a behaviour, not a write (amends §7.1 step 6 and A19).**
  "The account is marked `disconnected`" must not become `UPDATE social_accounts SET status`: that
  table is a read-only projection of the accounts service (D8, D29), and writing it would make this
  service its second writer — the one boundary the design exists to demonstrate. Instead this service
  owns `account_health` (§5.3): on `AuthError` the worker records `auth_failed`, emits outbox
  `account.auth_failed`, and stops the account's jobs. The `Accounts` port returns an **effective**
  status — `active` only when the projection says `active` *and* no local record exists — so §6.3's
  `ACCOUNT_DISCONNECTED` and A19 behave exactly as specified while the boundary holds.
- **D30's clear trigger is a successful platform call, not a projection read (clarifies D30).** D30
  first said a projection row flipping back to `active` clears the record, which cannot be
  implemented: this service never writes `social_accounts.status`, so that column reads `active`
  throughout an auth failure — "projection active plus a local record" is the *normal* broken state,
  indistinguishable from recovery. The implementable trigger is evidence: a **successful** platform
  call proves the credential works again, so `AccountHealth.clear` is called from a successful sync
  walk. Sync keeps running for an account marked `auth_failed` — the calls are read-only and cost
  nothing when they fail — which is what makes the clear reachable at all.
- **D31 — reads are one filtered collection; writes stay addressed (narrows D11, D13, D27, A3, A10a
  and §6.1).** The moderation view the product is for — "every new comment across every account in
  the workspace" — was reachable from no address: the three reads §6.1 used to carry are each keyed
  to an identifier the caller must already hold, and the only inbox was per account. Time, not post
  hierarchy, is the primary access path for comments, so hierarchy belongs in a filter.
  `GET /v1/posts/:postId/comments`, `GET /v1/comments/:commentId/replies` and
  `GET /v1/accounts/:accountId/comments` are **replaced** by `GET /v1/comments`, whose filters
  (`postId`, `parentCommentId`, `accountId`, `platform`, `topLevelOnly`, `isOwn`, `since`, `until`)
  intersect: no filter overrides another, and a combination no comment can satisfy is a valid request
  answered with an empty page. The removal is outright — no alias, no redirect, no deprecation —
  because two read paths for one read is the drift the change exists to end.
  - **Untouched:** writes keep their addresses (a command names its target, a query describes a set),
    so D19's refresh stays post-addressed, and the `202` contract, idempotency, reply-depth (D12) and
    quota reservation (D16) are unchanged. So are the `Comment` representation (§6.2), the error
    catalogue (§6.3), tenancy (D20 — a foreign identifier in any filter is `404`, never `403` and
    never an empty success) and the keyset half of D27.
  - **Two visible behaviour changes.** (1) One collection has one default direction, `desc`; the
    replies read, which defaulted to `asc` at its own address, now asks for `order=asc` explicitly —
    a default that depended on which filter was present would silently flip direction when an
    unrelated filter was added, and since the cursor carries its direction, the caller's next page
    would then fail as a mismatch. (2) `sync: { lastSyncedAt, activeJobId }` is reported iff the
    selection names a post, and is **absent** rather than `null` otherwise: refresh freshness is a
    property of a post, and a selection spanning many posts has no single answer.
  - **`topLevelOnly` is this service's own filter.** It preserves the "a post's page is its top
    level" reading the removed route gave for free, and it is the predicate that keeps
    `(post_id, occurred_at DESC, id DESC) WHERE parent_comment_id IS NULL` reachable from the
    collection.
  - **The task-level requirement is preserved.** `task.md`'s "retrieve comments for a published post"
    is `GET /v1/comments?postId=…&topLevelOnly=true` — the same rows, `replyCount` and `sync` block,
    reached by a filter instead of a path. That this coincides with Blotato's own flat `GET /comments`
    (§2.1) is corroboration, not the argument; the argument is the missing cross-account inbox.
    Discoverability is explicitly **not** the justification — account and post identifiers originate
    outside this service (D8), and this feature adds no listing of either.
  - **Cost.** The workspace-wide listing is the one read not bounded by an identifier, so it gets one
    additive index, `(workspace_id, occurred_at DESC, id DESC)`, and one measurable claim: at equal
    page size its p95 on a ten-times-larger history stays within 1.5×. Measured on demand by a script
    rather than gated in CI, because timing on a shared runner is too noisy to gate on and a flaky
    gate gets disabled. Filter combinations with no leading index degrade to an ordered walk with a
    residual filter; an index per combination is a power set, and the trigger to add one is a
    measurement, not an intuition.
  - **Scope.** In feature 001 this revises FR-001, FR-003, FR-006 and FR-008 — each becomes a
    selection over the collection rather than its own address. FR-002's "replies are a separately
    paged list" survives as the `parentCommentId` filter; FR-005's visibility rule (A4) is unchanged.
  - **Not part of this decision: the docs page.** A16 already requires OpenAPI to describe the key as
    an `apiKey` header scheme so Swagger UI can authorize; the document did not, so every "Try it
    out" answered `401`. Publishing the scheme globally and clearing it on the exempt operations the
    document contains — from the *same* array the authentication hook enforces — implements A16
    rather than changing it.

### Corrections: stated behaviour that was wrong

- **A 5xx answer to a write is an unknown outcome, not a retryable one (corrects §4.3).** §4.3 listed
  `RetryableError` as covering "429 / 5xx" — right for a read, wrong for a write: a 5xx means the
  request reached the platform, so the comment may already exist behind it, and `RetryableError` is
  retried without reconciliation. That is the double post D14 exists to prevent. Classifiers now take
  the operation kind: `>= 500` maps to `OutcomeUnknownError` on a write, stays `RetryableError` on a
  read. A 429 stays retryable in both directions — a rate-limit rejection was never executed. D14
  itself is unchanged.
- **A complete walk excludes rows written in the last five minutes (narrows FR-019).** "Complete" was
  read as "the walk finished", which is not enough: a comment inserted *while* the walk ran — a reply
  this service just published, a webhook delivery, a comment the platform had not yet indexed — is
  absent from the page through no fault of the platform, and absence is what marks it `deleted`. The
  revive guard then makes that deletion permanent, so the race costs data rather than a retry.
  `inferDeletions` now excludes rows whose last write falls inside a five-minute grace window before
  the walk started. The cost falls the safe way: a genuinely deleted comment also edited in that
  window survives until the next walk — a delay, against an irreversible false deletion.
- **Both `order` values are indexed only while neither the index nor the `ORDER BY` names a NULL
  placement (implements D27, §5.2).** D27's "B-tree indexes are readable in both directions" is true
  of the index and false of a query that disagrees with it about where nulls sort: a Postgres pathkey
  includes NULL placement, and the planner does not use a column's `NOT NULL` to match one. Naming
  `NULLS LAST` on the ordering clause cost `order=asc` its index on all three `DESC` listing indexes,
  and cost a `parentCommentId` selection its own — each planning a full `Sort`. Both sides now stay
  at Postgres's default for the direction (migration `0005`), and `benchmark.integration.test.ts`
  asserts the whole selection × direction matrix. An implementation fact about D27, not a change to
  it.
- **`comments.occurred_at` is `timestamptz(3)` (implements D27).** The keyset cursor encodes
  `toISOString()`, which is millisecond-precision, while the column accepted microseconds. A stored
  value the cursor cannot express makes paging lossy in both directions — `desc` skips the rest of
  that millisecond, `asc` repeats the cursor row — and it is invisible from TypeScript, since the
  driver parses timestamps into a millisecond-precision `Date`. Every writer passes a JS `Date`, so
  nothing stored microseconds; pinning the column (migration `0006`) makes that the database's
  guarantee rather than a convention each new writer must know.
- **An unrecognized query parameter on `GET /v1/comments` is a `400` (clarifies D31, §6.3).** D31
  said filters intersect and an unsatisfiable *combination* is an empty `200`, but said nothing about
  a parameter name the schema does not define — and a Zod object strips one by default, so
  `?post_id=…` in snake_case, or `?platform[]=…`, answered `200` with the whole workspace's history.
  The filter was never applied and no field of the response says so; on a read where every parameter
  narrows the result, that is indistinguishable from a wrong answer. The query schema is strict. A
  combination of *recognized* filters still produces an empty page, so this narrows nothing D31
  promised.

### Additions the implementation required

- **`comment_sync_targets.age_anchor_at` (extends §5.3 and §7.3).** §7.3 schedules a refresh by post
  age, but the table carried no timestamp to measure age from, and both alternatives fail: reading
  `posts.published_at` through the `Posts` port is one cross-boundary call per due target on every
  scheduler tick, and for a post never published through the platform there is no projection row at
  all — while §7.3 requires exactly those posts to be tracked. Added as `not null`: for a post
  registered through the `PostPublished` port it is that post's `published_at`; for an external post
  first seen through an ingested comment it is that comment's `occurred_at`, a lower bound. Named for
  its use rather than `published_at`, because a name implying publication time would invite a reader
  to treat a lower bound as one.
- **`comments.needs_reconcile` (extends D14, §7.1 step 6).** D14 requires `findPublishedComment` to
  gate any second send after an unknown outcome, and the implementation held that fact only in the
  failing attempt's own stack. A worker killed between the platform accepting the write and this
  service committing `posted` therefore left a row the sweeper returned to `queued` with nothing
  recorded about the send that may have gone out, and the next attempt published a second copy. The
  column records it instead: set in its own committed transaction immediately before the adapter
  call, carried forward when an attempt ends without learning the outcome, set unconditionally by the
  sweeper, and cleared only by a settled outcome or a completed search that found nothing. Cost: one
  extra `UPDATE` per publish attempt. D14 itself is unchanged.
- **`Accounts.listByPlatformAccount` (extends the `Accounts` port, D8).** A webhook delivery
  identifies its account only by the platform's own id — a Page id or IG user id — while every
  existing lookup is keyed by our internal `social_account_id`, so the webhook worker cannot resolve
  a delivery at all with the port as specified; the one forbidden alternative is a direct `SELECT`
  against the projection from inside `comments` (D8, D29). It returns a **list**, not a `Found<T>`,
  because the projection carries no uniqueness on `(platform, platform_account_id)` and none can be
  assumed: two workspaces may legitimately connect the same Page, and a delivery concerns both. A
  single-record lookup would silently serve one and drop the other's comments — a tenancy-shaped data
  loss no test keyed to one workspace would catch. An empty list is the "unknown account" case §7.2
  marks processed with a warning; the dedup key keeps fan-out rows apart.
- **`CommentPage` carries deleted ids separately from comments (extends §8.3 and the adapter
  contract).** §8.3 says a Bluesky `notFoundPost` marker is an explicit tombstone. Returning it
  inside `CommentPage.comments` as an ordinary `NormalizedComment` made that unachievable: a consumer
  iterating the page upserts it as `posted` and — worse — recording it as *seen* suppresses the
  absence-based deletion the complete walk would otherwise detect, so the tombstone actively prevents
  the fallback it was meant to pre-empt. `CommentPage` therefore gains a separate field; adapters put
  tombstones only there, and the walk routes them through the same delete branch a webhook delete
  uses, without adding them to the seen set. The signal has to live outside `NormalizedComment`
  because otherwise every future consumer of `listComments` must remember it exists — which is
  exactly the mistake that occurred.
- **`INTERNAL_ERROR` (extends §6.3).** FR-032 requires every failure to be `application/problem+json`
  carrying a machine-readable `code`, but §6.3 listed only failures a client can cause — no entry for
  an unhandled exception. Both alternatives were worse: a `500` with no `code` breaks FR-032 for the
  one case a client cannot anticipate, and reusing an existing code would misreport a bug as a client
  error. Added as a synchronous code that never appears as a comment's `error.code`; `detail` carries
  no internal text.
- **An undecryptable credential is an `AuthError` (extends D26/D30).** `AccountCredentials` decrypts
  on every read, and a ciphertext that will not decrypt — a botched key rotation, a corrupted row —
  raised a bare crypto error. Nothing typed it, so nothing handled it: the webhook worker retried
  such a delivery under backoff **forever**, and the publish path had no case for it. Typed as
  `AuthError` it flows into machinery that already exists (D30), and that is also the honest
  classification — the credential is unusable and only a reconnection fixes it. Found by an
  integration test hanging for its full 60-second budget rather than failing; the hang, not the
  failure, was the symptom worth chasing.
- **The age-band group is a registry property, not a per-platform branch (extends §7.3, D28).**
  Branching on `platform` inside the scheduler would put platform knowledge back into a use case.
  Each registry entry instead carries a `syncIntervalGroup` naming which configured band table
  applies; the minutes stay in `SyncIntervalsConfig` so a deployment can retune without a code
  change. Adding a platform adds a registry entry, not a branch.

### Operational behaviour under this deployment

- **`domain-events` is trimmed on a schedule (extends D9).** The relay publishes to a BullMQ queue
  for consumers in other services — and here there are none, so nothing moves a job out of `wait`.
  Bounded `removeOnComplete` does not help a job that never completes, and D24 mandates `noeviction`,
  so the queue grows until Redis refuses writes and takes the publish and sync paths down with it.
  Of the three options — stop publishing (deleting the D9 contract this service exists to
  demonstrate), let it grow (a scheduled outage), or expire what nobody collected — the last is what
  a real broker does. A scheduled job drops jobs older than `DOMAIN_EVENTS_TTL_HOURS` (default 24)
  and logs the count, so an operator sees a number rather than a silent loss. Postgres keeps the
  authoritative record: `outbox_events` rows are marked published and retained under the normal
  purge, so a future consumer is backfilled from the table rather than from Redis.
- **The outbox relay publishes one row per transaction (extends D9).** Relaying a whole batch inside
  one transaction means a single row BullMQ will never accept rolls the batch back on every pass —
  and it sits at the front of the oldest-100 selection, blocking every event behind it indefinitely,
  so one poison event stops domain-event delivery for the whole service. Each row therefore publishes
  and stamps in its own transaction under `FOR UPDATE SKIP LOCKED`; a failing row increments
  `attempts` and is logged. The row is never deleted — the outbox is the only record of the event —
  but past ten attempts the log level rises to `error`, which makes a stuck event an incident rather
  than an invisible retry. A pass in which *every* row failed still rejects, so a total outage is
  still reported as a failed pass.
- **The stuck-work sweeper also recovers `processing` (extends §7.1 step 4).** Step 4 described the
  sweeper as re-enqueueing `queued` comments, which leaves one state with no way out: a worker that
  dies between the conditional `queued → processing` transition and settling the outcome leaves the
  row in `processing` forever. BullMQ's stalled-job retry does not recover it, because its own
  `markProcessing` finds the row no longer `queued` and correctly stops. Nothing double-publishes,
  but the comment never reaches a terminal state and the customer's reply is neither posted nor
  failed. The sweeper therefore also returns `processing` rows whose `last_attempt_started_at` is
  older than a threshold comfortably beyond the longest plausible platform call. That retry is safe
  for the same reason any post-unknown retry is: reconciliation still gates a second send. The
  threshold is deliberately generous — returning a row genuinely still publishing costs a
  reconciliation read, while leaving it stuck costs the reply. The index
  `(status, last_attempt_started_at) WHERE status IN ('queued', 'processing')` already covered both
  states, which is itself evidence the omission was in the prose rather than the design.
- **An abandoned `comment_sync_jobs` row is swept (extends §7.3).** The partial unique index on
  `(target_id) WHERE status IN ('queued','running')` keeps one target from being walked twice at
  once, and its cost is that a row nobody will finish holds that target forever: every scheduler
  tick's `onConflictDoNothing` skips it silently, `POST /refresh` keeps reporting the dead job as
  active, and the post stops syncing with nothing logged. Three things produce such a row — the
  scheduler committing and dying before `syncQueue.add`, a runner killed between `markJobRunning` and
  `finalizeJob`, and losing Redis, which §4.1 explicitly permits. A sweeper re-enqueues `queued` rows
  past a threshold and finalises abandoned `running` rows as `failed`. The scheduler also moves its
  `syncQueue.add` after commit, which narrows the first case but cannot close it.
- **The Meta usage signal is reported sideways and acted on by the workers (implements §8.2).** §8.2
  requires parsing `X-Business-Use-Case-Usage` / `X-App-Usage` and delaying an account's jobs under
  high usage. Only the parsing existed: `GraphResponse.usage` had no reader, so the throttling half
  was absent while looking implemented. Routing it up through the adapter port was rejected — `usage`
  is a Meta fact, and `CommentPage` / `PublishedComment` are the platform-agnostic types every use
  case depends on. The Graph client reports it through an injected sink
  (`GraphClientOptions.onUsage`), which the workers wire to a short-lived per-account Redis key; past
  `META_USAGE_THROTTLE_PERCENT` a worker calls `moveToDelayed`, the same treatment an empty token
  bucket gets, spending no retry attempt. "Nothing known" is deliberately not "throttled", so an
  empty cache never stalls the deployment.

### Test narrowings

- **A17's two-variant equivalence test runs against one live fixture (narrows T097).** A17 asserts
  the two D28 login variants normalize identically, specified as one parameterized body over a
  fixture per variant. S2 produced the `facebook_login` fixture; the `instagram_login` one does not
  exist. The test therefore runs both arms over the **same** recorded body, differing only in host
  and credential — which still proves the property A17 is about (the adapter does not branch on
  variant) while making no claim about what `graph.instagram.com` returns. Hand-writing the second
  fixture would assert a response shape nobody observed, the exact failure the spike gate prevents.
- **A refresh-request test asserts the job row, not only the HTTP response (narrows §7.3).** A case
  checking only the response shape passes whether or not a `comment_sync_jobs` row was created and
  whether or not the target's cooldown moved — the two things the endpoint exists to do.
