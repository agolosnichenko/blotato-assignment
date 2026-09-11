# Phase 0 Research: Multi-Platform Comment System

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Date**: 2026-09-11

The stack itself is not open: `spec.md` D6 fixes Node 22 / TypeScript / Fastify / PostgreSQL +
Drizzle / BullMQ on Redis, D7 fixes Bluesky as the third platform, D24 fixes Railway. This document
covers only what those decisions leave open — the libraries and mechanisms needed to implement them,
and the platform behaviours that remain unverified. Nothing here revises a decision; anything that
did would go to `spec.md` §18 first (Principle I).

Version note: `.npmrc` sets `minimum-release-age=1440`, so a release younger than 24 hours is
refused at install time. Versions below were the current stable ones on 2026-09-11; pin the exact
version at install time and drop to the previous one rather than lifting the setting.

---

## R-01: Migrations from the Drizzle schema

- **Decision**: `drizzle-kit` 0.31.10, with `db:generate` producing SQL into `drizzle/` and
  `db:migrate` applying it. Migrations are committed, reviewed and run as a Railway pre-deploy
  command; integration tests apply the same files to the testcontainer database.
- **Rationale**: generated-then-committed SQL is reviewable, which matters for the partial unique
  indexes and `CHECK` constraints that carry the deduplication and depth invariants — those are the
  schema-level half of Principle III and must be readable in a diff. Applying the identical files in
  tests removes the class of bug where the test schema and production schema drift.
- **Alternatives considered**: `drizzle-kit push` (fast, but no artifact to review and no ordered
  history — unusable for a deployed service); hand-written SQL with a thin runner (loses the
  TypeScript schema as the single source, inviting drift between types and tables).

## R-02: Cursor pagination that is stable under inserts

- **Decision**: keyset on `(occurred_at, id)` with both components in the comparison, encoded as a
  base64url JSON payload carrying the position *and* the `order` direction; a cursor presented with a
  different `order` fails with `400 VALIDATION_ERROR` (D27, A13). The codec lives in
  `src/shared/pagination.ts` and is covered by a fast-check round-trip property.
- **Rationale**: offset pagination shifts under concurrent inserts, which is exactly SC-002's failure
  mode. `occurred_at` alone is not unique, so ties would drop or repeat rows; adding `id` (UUIDv7,
  time-sortable) makes the key total. Encoding the direction turns a silent re-ordering bug into an
  explicit rejection.
- **Alternatives considered**: a signed or encrypted cursor (the position is not a secret and it is
  already validated against the request, so signing adds key management for no threat removed);
  `created_at` as the key (would order API-created comments by our clock and ingested ones by theirs
  — the two are not comparable, which is why `occurred_at` exists as a separate column).

## R-03: OpenAPI generated from the Zod schemas

- **Decision**: `fastify-type-provider-zod` 7.0.0 with `@fastify/swagger` 9.8.1 and
  `@fastify/swagger-ui` 6.1.1. Route schemas are Zod, the type provider gives request and response
  types, `@fastify/swagger` renders the document, and `scripts/generate-openapi.ts` writes
  `openapi.json`; CI fails if the committed file differs (D18).
- **Rationale**: D18 requires OpenAPI generated from Zod, and the type provider makes the same schema
  object serve validation, static types and documentation. A drift check in CI is what makes
  "generated" true rather than aspirational.
- **Alternatives considered**: `zod-openapi` 6.0.2 driven by a standalone script (works, but needs a
  second registration of every route schema, so the document can silently diverge from what the
  server validates); hand-maintained OpenAPI (contradicts D18 and rots immediately).

## R-04: Raw body for webhook signature verification

- **Decision**: verify `X-Hub-Signature-256` over the exact received bytes before any JSON parsing,
  using a Fastify content-type parser registered for the webhook route that keeps the raw `Buffer`
  alongside the parsed body, and `crypto.timingSafeEqual` for the comparison. The verifier accepts
  more than one configured signing secret so it can cover both Meta login variants (S5).
- **Rationale**: HMAC is over bytes. Re-serializing a parsed body changes key order, whitespace and
  number formatting, so a verifier that parses first is a verifier that rejects valid deliveries —
  or, worse, one that gets "fixed" by relaxing it. Parsing before verification also runs a parser on
  unauthenticated input.
- **Alternatives considered**: a global raw-body plugin (applies the cost to every route, including
  the hot read paths); verifying after parse by re-serializing (unsound, as above).

## R-05: Per-key rate limiting and the limit headers

- **Decision**: `@fastify/rate-limit` 11.2.0 with a Redis store, keyed by the api key id resolved
  during authentication rather than by IP, emitting `RateLimit-*` and `Retry-After`, and mapping the
  rejection to `429 RATE_LIMITED` in problem+json (FR-027, §6.3).
- **Rationale**: D20 puts the limit on the credential, so keying by IP would let one workspace exhaust
  another's budget from behind a shared NAT. Redis makes the counter survive a restart and stay
  correct if a second `api` instance is ever added.
- **Alternatives considered**: an in-memory limiter (resets on deploy, wrong the moment there are two
  instances); a hand-rolled Redis token bucket for HTTP as well as for platform calls (the platform
  buckets genuinely need custom behaviour — per-account, driven by Meta's usage headers — but HTTP
  limiting does not, and one fewer hand-rolled primitive is one fewer place to be subtly wrong).

## R-06: UUIDv7 generation

- **Decision**: the `uuidv7` package (1.2.1) in `src/shared/ids.ts`, generating ids in the
  application, not the database (A15).
- **Rationale**: ids are needed before the insert — the outbox event references the comment id, the
  BullMQ `jobId` is the comment id, and the `Location` header is built from it. Node 22's
  `crypto.randomUUID` is v4, which is random-ordered and would defeat the `(occurred_at, id)` keyset
  tie-break and scatter index writes.
- **Alternatives considered**: a database default — PostgreSQL 18 does ship `uuidv7()` and the
  deployment runs 18.6, so availability is not the objection; the objection is that the id would
  exist only after the insert returns, which is too late for all three uses above and would force a
  round trip or a second statement to learn it. ULIDs as text (same ordering property, but loses the
  native `uuid` type and every tool that understands it).

## R-07: Counting text the way each platform counts it

- **Decision**: the capability registry carries a text limit *and* its unit; Meta counts UTF-16
  characters (`String.length`), Bluesky counts graphemes via `Intl.Segmenter` with
  `granularity: 'grapheme'`, built into Node 22. The check is a registry-driven function in
  `comments/domain`, never a platform `switch`.
- **Rationale**: Principle IV — the difference is data in the registry, so a fourth platform that
  counts code points adds a unit, not a branch. Using the platform's own unit is what keeps FR-010's
  pre-flight rejection accurate instead of merely approximate.
- **Alternatives considered**: a grapheme-splitter dependency (`Intl.Segmenter` is standard and
  needs no supply-chain surface); counting characters everywhere (would reject valid Bluesky posts
  containing emoji and accept invalid ones, defeating the point of checking before sending).

## R-08: Serializing the monthly audience-contact reservation

- **Decision**: `pg_advisory_xact_lock` on `(workspace_id, period)` taken inside the same transaction
  that inserts the comment, followed by the `contact_quota_usage` insert and the count check (A8,
  D16). The lock is released by the transaction, successfully or not.
- **Rationale**: the quota is a count across rows, so it cannot be enforced by a unique constraint
  alone — two concurrent replies to two *different* new contacts can each see room for one and both
  commit. A transaction-scoped advisory lock serializes only the workspace's own reservations and
  cannot leak on a crashed connection. The primary key on
  `(workspace_id, period, platform, contact_platform_id)` still handles the same-contact race
  directly.
- **Alternatives considered**: `SELECT ... FOR UPDATE` on a workspace counter row (adds a row whose
  only purpose is to be locked, and turns a read of the projection into a write across the service
  boundary); a Redis lock (Redis may be lost by design — FR-033 — so a correctness invariant must not
  depend on it).

## R-09: The three unverified Meta behaviours

- **Decision**: run S1, S2 and S5 as small scripts against the real Meta App before implementing what
  they gate, write the result into `spec.md`, and build after that. Ordering: the Bluesky adapter and
  the whole read, publish and refresh path do not depend on any of them and go first.
- **Rationale**: Principle I is explicit, and §2.3 shows why — Standard Access is documented per
  product, the forum reports contradict each other, and the failure mode is discovering after the
  adapter is written that the deployment receives nothing. Each spike has a stated fallback in §17,
  so none of them can block delivery: the webhook path is demonstrable with dashboard test events, IG
  is coverable by fixtures, and the verifier can carry both secrets.
- **Alternatives considered**: implementing both login variants and both webhook paths speculatively
  (doubles the surface that has to be maintained on a guess); dropping Instagram from the live demo
  up front (throws away the more interesting half of D28 before the evidence is in).

## R-10: Keeping the publish worker honest about state

- **Decision**: every lifecycle move is a conditional `UPDATE ... WHERE status = <expected>` whose
  affected-row count decides what happens next; BullMQ carries `jobId = comment.id` so a duplicate
  enqueue is collapsed by the queue; a sweeper re-enqueues comments left `queued` for more than a
  minute with no active job, and another re-enqueues `webhook_deliveries` unprocessed for five
  minutes (§7.1 step 4, §7.2 step 5).
- **Rationale**: BullMQ delivers at least once and a worker can die between the platform call and the
  status write. A conditional update makes a second worker's attempt a no-op instead of a second
  publish, and the sweepers close the gap where a job was never created — the one failure mode a
  queue cannot fix, because the queue never heard about the work.
- **Alternatives considered**: an advisory lock per comment for the duration of the publish (holds a
  connection across a network call to a third party); trusting BullMQ's deduplication alone (the row
  is the source of truth, not the queue — and FR-033 requires the system to survive losing the queue
  entirely).

---

## Resolved unknowns

No `NEEDS CLARIFICATION` items remain. The feature specification carried none, `spec.md` §18 records
no open questions, and the ten items above close every choice the plan needed that a decision did not
already fix. The three spike-gated behaviours (R-09) are not unknowns in the design sense — the
design states what happens in each outcome; they are sequencing constraints.
