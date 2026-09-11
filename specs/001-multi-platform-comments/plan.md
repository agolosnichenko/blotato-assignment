# Implementation Plan: Multi-Platform Comment System

**Branch**: `001-multi-platform-comments` | **Date**: 2026-09-11 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-multi-platform-comments/spec.md`

> The repository-root `spec.md` remains the source of truth for decisions (§3, D1–D29), assumptions
> (§16, A1–A23) and spikes (§17, S1–S5). This plan resolves that specification into buildable
> structure; every technical choice below cites the decision it implements. A choice not covered by a
> decision is recorded in [research.md](./research.md) with its rationale and rejected alternatives.

## Summary

Build one deployable service that reads, publishes and ingests comments across Instagram, Facebook
and Bluesky, exposing a REST API scoped per workspace and publishing domain events for the rest of
the platform. The load-bearing requirement is FR-011 / SC-001: a customer-authored reply reaches the
platform exactly once across the whole failure matrix. Everything else in the design — asynchronous
writes with a conditional state machine, reconciliation before retry, one idempotent upsert path
shared by push and refresh, a transactional outbox — exists to make that guarantee hold under
at-least-once infrastructure. Ingestion follows D4: push is the primary channel where it exists, and
the refresh job covers backfill and anything push missed; the write surface is the public reply and
the top-level comment, with private replies out of scope (D10).

Approach: Node 22 / TypeScript ESM, Fastify for the `api` role and BullMQ for the `worker` role out
of one image (D6, §4.1); PostgreSQL via Drizzle as the source of truth and Redis for queues, rate
limits and locks only; platform differences confined behind `CommentPlatformAdapter` plus a
capability registry covering all nine publishing platforms (D5, Principle IV); references to
workspaces, accounts and posts kept as plain uuids read through ports, with no foreign key and no
SQL join across the service boundary (D8, D29).

## Technical Context

**Language/Version**: TypeScript 7.0.2 on Node 22.20 LTS, ESM only (`"type": "module"`), `strict`
plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`

**Primary Dependencies**: Fastify 5 (HTTP, webhook intake, Swagger UI), Drizzle ORM 0.45 +
`drizzle-kit` (schema and SQL migrations), BullMQ 6 on ioredis 6 (queues, repeatable jobs), Zod 4
(env config, request/response schemas, OpenAPI source), pino 10 (structured logs with redaction),
`@atproto/api` (Bluesky), `undici` (built into Node) for the Meta Graph client. Additions this plan
introduces and their rationale are in [research.md](./research.md): `drizzle-kit`,
`@fastify/rate-limit`, `@fastify/swagger` + `@fastify/swagger-ui`, `fastify-type-provider-zod`,
`uuidv7`.

**Storage**: PostgreSQL 18 — the only source of truth. Owns `comments`, `comment_sync_targets`,
`comment_sync_jobs`, `webhook_deliveries`, `outbox_events`, `contact_quota_usage`, `account_health`
(D30), plus a read-only local projection of four externally owned tables (§5.1). Redis 8 holds queues, per-account token
buckets, per-key rate limits and short-lived locks; losing it must lose no data (FR-033, SC-011).
Both versions match `docker-compose.yml` (`postgres:18.6-alpine`, `redis:8.10.1-alpine`), and the
same major versions are what the Railway services must provision.

**Testing**: vitest with two projects — `unit` (no containers) and `integration` (testcontainers
Postgres + Redis, `fastify.inject`, platform HTTP mocked at the boundary with msw); fast-check for
the cursor codec and the webhook normalizer; a smoke script that runs the README walkthrough against
the live deployment.

**Target Platform**: Linux containers on Railway — `api` (public HTTPS domain) and `worker` from one
multi-stage `node:22-slim` image, managed Postgres and Redis, migrations as a pre-deploy step (D24).

**Project Type**: Backend web service, two runtime roles, one schema, one release (§4.1).

**Performance Goals**: read p95 < 300 ms at 100 000 comments in a workspace (SC-005); write
acknowledgement p95 < 300 ms independent of platform latency (SC-006); webhook intake acknowledged
in under 1 second so Meta does not treat delivery as failed (FR-016); push-to-readable within 60 s,
poll-to-readable within one age-band interval, 5 minutes under 24 h (SC-004). The two percentile
figures are build-time budgets checked by a seeded benchmark, not deployed service levels — A21
designs no SLA and A22 puts metrics out of scope, so nothing in production measures them.

**Constraints**: exactly-once publishing under at-least-once queues (SC-001); cursor pagination
stable under concurrent inserts, in both directions (SC-002, D27); cross-workspace access
indistinguishable from non-existence (SC-007, D20); no schema or contract change when a platform is
added (SC-009, Principle IV); the Meta App runs in Standard Access, so Instagram comment webhooks
will not arrive in this deployment and IG/FB data comes through the refresh path (D23).

**Scale/Scope**: one region, one `api` and one `worker` instance (A21); nine platforms in the
registry, three with adapters; 45-day retention (D15); demo workspace rate-limited to 30 reads and 5
writes per minute (§10).

**Unresolved**: none blocking Phase 1. All five spikes of §17 stay open and gate the parts that
depend on them — three platform behaviours, S1 (Facebook Page feed events under Standard Access),
S2 (Instagram comment reads per login variant) and S5 (which secret signs events for the Instagram
Login variant), covered in [research.md](./research.md) R-09; and two infrastructure facts, S3
(whether Railway's managed Redis accepts `maxmemory-policy noeviction` with persistence enabled) and
S4 (Bluesky's current `createRecord` and `getPostThread` rate limits). See Complexity Tracking.

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1 design. Constitution v1.0.0.*

| Principle | How this plan satisfies it | Verdict |
|-----------|---------------------------|---------|
| **I. Spec Is the Source of Truth** | Every technical choice cites its decision id; choices without one are new and recorded in `research.md`, not in code comments. No decision is revised here, so `spec.md` §18 stays "None". Spike-gated work is fenced off (below). | PASS |
| **II. Service Boundary Integrity** | `workspace_id`, `social_account_id`, `post_id` are plain `uuid` columns with no FK; only `parent_comment_id` and `root_comment_id` keep FKs. The projection tables in §5.1 are read-only and reachable only through `platform-core` ports — including on `AuthError`, which writes this service's own `account_health` rather than `social_accounts.status` (D30). Adapters take credentials from the `AccountCredentials` port (D26). `data-model.md` states this per column. | PASS |
| **III. Never Double-Post** | Writes return `202 queued`; transitions are conditional `UPDATE`s; adapter errors are the four typed classes; `OutcomeUnknownError` reconciles via `findPublishedComment` before retry; ingestion upserts on `UNIQUE (social_account_id, platform_comment_id)`; events go through the outbox in the state-change transaction; only a complete walk marks deletions. All six are in `data-model.md` and `contracts/`. | PASS |
| **IV. Platform Differences Stay in Adapters** | One `CommentPlatformAdapter` port, one capability registry covering all nine platforms, zero platform or `auth_variant` branching in use cases — the IG Graph client resolves host and token from `auth_variant` (D28). Depth and text limits are enforced from registry data, so a new platform is an adapter plus a registry row. | PASS |
| **V. Tested Behavior, Verified Failures** | `quickstart.md` maps every invariant to the scenario that proves it, including the three where the code must be broken once to confirm the test fails (deduplication, reconciliation, tenancy). Platform HTTP is mocked at the boundary; Postgres and Redis run for real. | PASS |

**Security and tenancy constraints** (§10, §12), each with the control stated rather than implied —
these are the ones that are easy to leave half-built:

| Control | What it means concretely |
|---------|--------------------------|
| API key format | `blt_<prefix>_<secret>` with at least 32 bytes of entropy in the secret; the database stores `prefix` + `sha256(secret)`; lookup by `prefix`, comparison constant-time. `scripts/create-api-key` prints the full key **once** and never again — it cannot be recovered from the row |
| Platform tokens | AES-256-GCM with `key_version` for rotation, decrypted only inside the adapter for the duration of one call, reached only through the `AccountCredentials` port (D26) |
| Webhook intake | HMAC over the raw bytes *before* JSON parsing (R-04), accepting either configured Meta signing secret (S5). The `GET` half of the handshake checks `hub.verify_token` against the configured value before echoing `hub.challenge` — echoing it unconditionally would let anyone confirm the subscription |
| Logging | pino redaction covering the `blotato-api-key` header, platform tokens **and comment text** — the last is the PII control that pairs with nulling `text` on deletion (FR-030). Every entry carries `requestId` or `jobId`; under A22 these logs are the entire observability surface, so an unattributable line is a real loss |
| Container and deploy | One multi-stage `node:22-slim` image running as a **non-root** user; GitHub Actions runs lint, typecheck and tests on pull requests and deploys to Railway from `main`, with migrations as a pre-deploy step |
| Everything else | RFC 9457 error bodies with a code from §6.3; per-key rate limiting (R-05); Zod-validated config that fails fast on a missing variable |

### Queues and their limits (§9.2)

Redis carries five BullMQ queues. The concurrency figures are not tuning — one of them is load-bearing:

| Queue | Purpose | Concurrency |
|-------|---------|-------------|
| `comment-publish` | publishing a comment (§7.1) | per-account token bucket |
| `webhook-process` | processing a stored delivery (§7.2) | 10 |
| `comment-sync` | refreshing one target (§7.3) | per-account token bucket |
| `scheduler` | repeatable jobs: the sync scheduler, both sweepers, the outbox relay, the retention purge | **1** |
| `domain-events` | external consumers, not implemented here | — |

`scheduler` at concurrency 1 is what keeps the relay's "published once" true (SC-011, quickstart V6):
the relay selects with `FOR UPDATE SKIP LOCKED`, so a second runner would not corrupt data, but it
would double-publish events that the first has selected and not yet stamped, and double-run the purge
and the sweepers. Redis itself runs `maxmemory-policy noeviction` with AOF on — a queue that may
evict a job is a queue that silently drops accepted work (S3).

**Post-Phase 1 re-evaluation**: unchanged — PASS on all five. Phase 1 added no table that crosses the
service boundary, no use case that branches on platform, and no synchronous publish path.

## Project Structure

### Documentation (this feature)

```text
specs/001-multi-platform-comments/
├── plan.md                       # This file
├── spec.md                       # Feature specification (outcome level)
├── research.md                   # Phase 0: choices not fixed by spec.md, with alternatives
├── data-model.md                 # Phase 1: tables, constraints, indexes, state machine
├── quickstart.md                 # Phase 1: how to run and validate the feature end to end
├── contracts/
│   ├── rest-api.md               # Public REST contract (§6) and error codes (§6.3)
│   ├── platform-adapter.md       # CommentPlatformAdapter + capability registry (§4.3, §8.1)
│   └── domain-events.md          # Outbox event envelope and payloads (§9.1)
├── checklists/
│   └── requirements.md           # Specification quality checklist (passed)
└── tasks.md                      # Phase 2 output — created by /speckit-tasks, not here
```

### Source Code (repository root)

Existing today: `src/app/{api,worker,config}.ts`, `src/shared/{db,logger,queue}.ts`, tooling and CI.
This feature fills in the rest of §4.2:

```text
src/
├── app/
│   ├── api.ts                    # exists — Fastify composition, route registration, Swagger UI
│   ├── worker.ts                 # exists — BullMQ workers and repeatable jobs
│   ├── config.ts                 # exists — Zod-validated env
│   └── container.ts              # dependency wiring shared by both roles
├── shared/
│   ├── db.ts                     # exists — pool and Drizzle instance
│   ├── logger.ts                 # exists — pino with redaction
│   ├── queue.ts                  # exists — BullMQ connection and queue handles
│   ├── errors.ts                 # problem+json mapping, the §6.3 code catalogue
│   ├── crypto.ts                 # AES-256-GCM with key_version, constant-time compare
│   ├── pagination.ts             # opaque keyset cursor codec (occurred_at, id, order)
│   └── ids.ts                    # UUIDv7 generation
├── modules/
│   ├── platform-core/
│   │   ├── ports.ts              # Workspaces, ApiKeys, Accounts, Posts, AccountCredentials,
│   │   │                         # PostPublished — the whole service boundary in one file
│   │   ├── schema.ts             # read-only projection tables (§5.1)
│   │   └── local/                # the single implementation reading the projection
│   └── comments/
│       ├── domain/               # status machine, reply rules, depth and text checks, thread rules
│       ├── application/          # ListPostComments, ListReplies, GetComment, ListAccountComments,
│       │                         # CreateReply, CreateTopLevelComment, RequestSync, IngestComments,
│       │                         # PublishComment, ReconcileComment, PurgeRetention
│       ├── infrastructure/       # Drizzle repositories, outbox writer and relay, ContactQuota,
│       │                         # queues and workers
│       └── http/                 # routes, Zod schemas, error mapping
└── platforms/
    ├── registry.ts               # capability registry — all nine platforms (§8.1)
    ├── types.ts                  # CommentPlatformAdapter, normalized types, typed errors
    ├── meta/                     # Graph client (host/token by auth_variant), IG and FB adapters,
    │                             # webhook verifier and normalizer
    └── bluesky/                  # AT Protocol adapter

drizzle/                          # SQL migrations generated by drizzle-kit
scripts/                          # seed-account, create-api-key, generate-openapi, smoke
```

Tests live beside the code as `*.test.ts` (unit) and `*.integration.test.ts` (testcontainers), the
convention already established by `src/app/api.integration.test.ts`.

### Deliverables (§13)

Three of the four deliverables are documents, and they are the only place several decisions are ever
written down for the reader — so they are build output, not a postscript:

| Deliverable | What it must carry | Why it cannot be dropped |
|-------------|--------------------|--------------------------|
| `README.md` | What the service is, the deployment link and `/docs`, the curl walkthrough (D25), local run via docker compose, the layout, and a "How I used AI tools" section | §1 makes the AI-usage description part of the original task, and §15 makes the README its home |
| `DESIGN.md` | Context and scope; architecture in mermaid including the service boundary and why the roles are not split further (§4.1); the ER diagram; the API; reply / webhook / sync sequence diagrams; platforms and registry with what it takes to add one (§8.1); key decisions with trade-offs and alternatives; assumptions; the Meta Standard Access limitation (D23); differences from the current `/v2/comments` (D3); evolution path — Jetstream (D17), partitioning (D15), the remaining platforms, private replies | It is the sole carrier of D3, D15, D17, D23 and §8.1's "how to add a platform": nothing else in the repository states them for a reader |
| `openapi.json` | Generated from the Zod route schemas, committed, drift-checked in CI | D18, R-03 |
| Code, migrations, tests, CI | — | — |

**Structure Decision**: single service, two runtime roles from one image, modules split by domain
rather than by technical layer at the top level — `platform-core` holds everything that belongs to
other services, `comments` holds what this service owns, `platforms` holds what the outside world
imposes. The boundary between `comments` and `platform-core` is the compile-time expression of
Principle II: a repository in `comments/infrastructure` has no import path to another service's
tables, only to a port.

Three points where this layout resolves something §4.2 states more briefly:

- **`ContactQuota` is implemented in `comments/infrastructure`**, where §4.2 places it, rather than
  listed among the boundary ports in `platform-core/ports.ts`. It is still a port in D16's sense —
  the seam a use case calls to reserve a contact — and it is the port that reads the limit from the
  projected `workspaces.contact_limit_monthly` (billing entitlements in the real platform, D16). What
  keeps it out of the boundary file is that the *usage* it records is this service's own
  `contact_quota_usage` table (§5.3) and the reservation is a local transaction with an advisory lock
  (R-08); only the limit value originates elsewhere.
- **`PostPublished` is an inbound port**, the one §7.3 names for creating a refresh target when a
  post is published; in this deployment the seed script calls it instead of the publishing service.
  It is on the boundary list because the event originates outside the service.
- **The use-case list extends §4.2** with `GetComment`, `ListAccountComments`, `ReconcileComment` and
  `PurgeRetention`. These are the endpoints and jobs §6.1, §7.1 and §7.4 already require, named here
  for the first time; no decision changes, so `spec.md` §18 stays "None" (Principle I).

## Complexity Tracking

No constitutional violation requires justification. The conditional gates below are recorded because
they constrain sequencing rather than design — they are the five spikes of §17, none of which may be
built on before it is run (Principle I):

| Item | Why it exists | What it blocks until resolved |
|------|---------------|-------------------------------|
| Spikes S1, S2, S5 unverified | Meta's behaviour under Standard Access is not documented in a way we can rely on (§2.3); Principle I forbids building on unverified platform behaviour | S1 gates the Facebook Page feed webhook subscription; S2 gates which Instagram login variant the live demo uses; S5 gates the signing-secret configuration in the webhook verifier. The Bluesky adapter, the whole read path, the publish path and the refresh path are unaffected and can proceed first |
| Spike S3 unverified | FR-033 / SC-011 promise that losing Redis loses no data, but an evicting Redis breaks a weaker promise first — a dropped BullMQ job is work the sweepers must then recover. `docker-compose.yml` sets `noeviction` and AOF locally; whether Railway's managed Redis allows both is untested | Gates the Redis provisioning step of the Railway deployment (D24, §9.2). The fallback — Redis from a Docker image with a volume — changes deployment configuration only, not code, so implementation proceeds meanwhile |
| Spike S4 unverified | The §7.3 polling intervals, which FR-018 and SC-004 measure freshness against, were chosen without confirming Bluesky's current `createRecord` and `getPostThread` limits | Gates the interval values in config, not the scheduler that reads them. The intervals are configurable by design, so the spike tunes a value rather than blocking the refresh path |
