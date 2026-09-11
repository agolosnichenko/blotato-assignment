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
at-least-once infrastructure.

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

**Storage**: PostgreSQL 16 — the only source of truth. Owns `comments`, `comment_sync_targets`,
`comment_sync_jobs`, `webhook_deliveries`, `outbox_events`, `contact_quota_usage`, plus a read-only
local projection of four externally owned tables (§5.1). Redis 7 holds queues, per-account token
buckets, per-key rate limits and short-lived locks; losing it must lose no data (FR-033, SC-011).

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
poll-to-readable within one age-band interval, 5 minutes under 24 h (SC-004).

**Constraints**: exactly-once publishing under at-least-once queues (SC-001); cursor pagination
stable under concurrent inserts, in both directions (SC-002, D27); cross-workspace access
indistinguishable from non-existence (SC-007, D20); no schema or contract change when a platform is
added (SC-009, Principle IV); the Meta App runs in Standard Access, so Instagram comment webhooks
will not arrive in this deployment and IG/FB data comes through the refresh path (D23).

**Scale/Scope**: one region, one `api` and one `worker` instance (A21); nine platforms in the
registry, three with adapters; 45-day retention (D15); demo workspace rate-limited to 30 reads and 5
writes per minute (§10).

**Unresolved**: none blocking Phase 1. Three platform behaviours stay unverified and gate the parts
that depend on them — S1 (Facebook Page feed events under Standard Access), S2 (Instagram comment
reads per login variant), S5 (which secret signs events for the Instagram Login variant). See
Complexity Tracking and [research.md](./research.md) R-09.

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1 design. Constitution v1.0.0.*

| Principle | How this plan satisfies it | Verdict |
|-----------|---------------------------|---------|
| **I. Spec Is the Source of Truth** | Every technical choice cites its decision id; choices without one are new and recorded in `research.md`, not in code comments. No decision is revised here, so `spec.md` §18 stays "None". Spike-gated work is fenced off (below). | PASS |
| **II. Service Boundary Integrity** | `workspace_id`, `social_account_id`, `post_id` are plain `uuid` columns with no FK; only `parent_comment_id` and `root_comment_id` keep FKs. The projection tables in §5.1 are read-only and reachable only through `platform-core` ports. Adapters take credentials from the `AccountCredentials` port (D26). `data-model.md` states this per column. | PASS |
| **III. Never Double-Post** | Writes return `202 queued`; transitions are conditional `UPDATE`s; adapter errors are the four typed classes; `OutcomeUnknownError` reconciles via `findPublishedComment` before retry; ingestion upserts on `UNIQUE (social_account_id, platform_comment_id)`; events go through the outbox in the state-change transaction; only a complete walk marks deletions. All six are in `data-model.md` and `contracts/`. | PASS |
| **IV. Platform Differences Stay in Adapters** | One `CommentPlatformAdapter` port, one capability registry covering all nine platforms, zero platform or `auth_variant` branching in use cases — the IG Graph client resolves host and token from `auth_variant` (D28). Depth and text limits are enforced from registry data, so a new platform is an adapter plus a registry row. | PASS |
| **V. Tested Behavior, Verified Failures** | `quickstart.md` maps every invariant to the scenario that proves it, including the three where the code must be broken once to confirm the test fails (deduplication, reconciliation, tenancy). Platform HTTP is mocked at the boundary; Postgres and Redis run for real. | PASS |

**Security and tenancy constraints**: satisfied by design — API keys stored as `prefix` +
`sha256(secret)` with constant-time comparison; platform tokens AES-256-GCM with `key_version`;
webhook HMAC verified over the raw body *before* JSON parsing, with support for both Meta signing
secrets (S5); RFC 9457 error bodies with a code from §6.3; pino redaction; Zod-validated config that
fails fast. `research.md` R-04 records how the raw body is kept available to the verifier under
Fastify.

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
│   │   │                         # ContactQuota — the whole service boundary in one file
│   │   ├── schema.ts             # read-only projection tables (§5.1)
│   │   └── local/                # the single implementation reading the projection
│   └── comments/
│       ├── domain/               # status machine, reply rules, depth and text checks, thread rules
│       ├── application/          # ListPostComments, ListReplies, GetComment, ListAccountComments,
│       │                         # CreateReply, CreateTopLevelComment, RequestSync, IngestComments,
│       │                         # PublishComment, ReconcileComment, PurgeRetention
│       ├── infrastructure/       # Drizzle repositories, outbox writer and relay, quota, workers
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

**Structure Decision**: single service, two runtime roles from one image, modules split by domain
rather than by technical layer at the top level — `platform-core` holds everything that belongs to
other services, `comments` holds what this service owns, `platforms` holds what the outside world
imposes. The boundary between `comments` and `platform-core` is the compile-time expression of
Principle II: a repository in `comments/infrastructure` has no import path to another service's
tables, only to a port.

## Complexity Tracking

No constitutional violation requires justification. One conditional gate is recorded here because it
constrains sequencing rather than design:

| Item | Why it exists | What it blocks until resolved |
|------|---------------|-------------------------------|
| Spikes S1, S2, S5 unverified | Meta's behaviour under Standard Access is not documented in a way we can rely on (§2.3); Principle I forbids building on unverified platform behaviour | S1 gates the Facebook Page feed webhook subscription; S2 gates which Instagram login variant the live demo uses; S5 gates the signing-secret configuration in the webhook verifier. The Bluesky adapter, the whole read path, the publish path and the refresh path are unaffected and can proceed first |
