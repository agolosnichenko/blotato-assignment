<!--
Sync Impact Report (scratch — remove before committing the amended file)
- Version change: none (unfilled template) → 1.0.0
- Bump rationale: initial ratification; the file previously contained only placeholder tokens.
- Modified principles: none (no prior principles existed)
- Added sections:
  - Core Principles I–V (Spec Is the Source of Truth; Service Boundary Integrity;
    Never Double-Post; Platform Differences Stay in Adapters; Tested Behavior, Verified Failures)
  - Security and Tenancy Constraints
  - Development Workflow and Quality Gates
  - Governance
- Removed sections: none
- Follow-up TODOs: none — every placeholder resolved.
-->

# Blotato Comment Service Constitution

## Core Principles

### I. Spec Is the Source of Truth (NON-NEGOTIABLE)

`spec.md` governs the implementation. Decisions live in §3 (D1–D29), assumptions in §16, spikes in
§17. Code MUST NOT diverge from a decision or an assumption until §18 records the change; the
record comes first, the diff second. Commits, PRs and `DESIGN.md` MUST cite the decision id they
implement or revise (for example `per D14`). Work that a spike gates — S1, S2, S5 for Meta
behavior — MUST NOT be implemented on unverified platform behavior; run the spike, write down the
result, then build. Deliverables are written in English (D18).

*Rationale:* the spec is what the reviewer reads alongside the code. An undocumented divergence
turns the spec into fiction and makes every other decision unverifiable.

### II. Service Boundary Integrity

The service owns its schema and nothing else. `workspace_id`, `social_account_id` and `post_id` are
plain `uuid` columns: no foreign key and no SQL join to platform-core tables (D8, D29). Other
services' data is read through ports and a read-only local projection, and is never written.
Adapters obtain platform credentials from the `AccountCredentials` port, never from a table read
(D26). Referential integrity comes from port validation on write and from platform events on delete.

*Rationale:* a foreign key across a service boundary forces a shared database and blocks
independent schema changes; the read contract (§6.2) needs no foreign data, so the boundary is free.

### III. Never Double-Post

A duplicate public reply on behalf of a brand is worse than a delay (D14). Therefore:

- Writes are asynchronous: `POST` returns `202` with `status=queued`; the state machine is
  `queued → processing → posted | failed` plus `deleted`, and every transition is a conditional
  `UPDATE`.
- Adapter failures MUST be typed as `RetryableError`, `OutcomeUnknownError`, `PermanentError` or
  `AuthError`. On `OutcomeUnknownError` the worker MUST reconcile through `findPublishedComment`
  before any retry. Backoff applies to retryable errors only.
- Ingestion is idempotent on `UNIQUE (social_account_id, platform_comment_id)`. Webhooks and sync
  share one upsert path; Meta redelivers for up to 36 h, and the webhook-echo race (§7.1 step 7) is
  handled explicitly.
- Domain events go through the transactional outbox in the same transaction as the state change
  (D9). A use case MUST NOT publish to BullMQ directly.
- Only a *complete* sync walk may mark comments `deleted`; a partial walk never infers deletion.

*Rationale:* every one of these rules is a place where at-least-once delivery would otherwise become
a visible, public, irreversible side effect.

### IV. Platform Differences Stay in Adapters

Every platform implements `CommentPlatformAdapter` (§4.3) and has an entry in the capability
registry covering all nine platforms. Use cases MUST NOT branch on platform or on the Instagram
`auth_variant` (D28); differences belong inside adapters and the Graph client. Adding a platform
MUST NOT change the database schema or the public API. Capability-driven rules are enforced
strictly: a reply beyond `maxReplyDepth` is `422 REPLY_DEPTH_EXCEEDED` with no silent re-parenting
(D12), and text limits count graphemes on Bluesky, characters on Meta.

*Rationale:* the abstraction is only proven if two genuinely different models — Meta's fixed-depth
trees and Bluesky's arbitrary-depth ones — fit behind it without leaking.

### V. Tested Behavior, Verified Failures

Tests assert what the service does, not how it is built. Every invariant in this constitution MUST
have a test: idempotent redelivery, reconciliation after an unknown outcome, outbox-after-commit,
complete-versus-partial sync walks, quota reservation under concurrency, and tenancy isolation on
every endpoint. Pagination is keyset on `(occurred_at, id)` with an opaque cursor encoding
direction; a cursor reused with a different `order` MUST fail with `400` (D27). Platform HTTP is
mocked at the boundary (msw); Postgres and Redis run for real under testcontainers. For the key
invariants — deduplication, reconciliation, tenancy — the code MUST be broken once to confirm the
test fails.

*Rationale:* a test that never failed proves nothing. The invariants above are the ones whose
breakage is silent in production.

## Security and Tenancy Constraints

- **Tenancy (D20):** every repository call takes `workspaceId`. Another workspace's resource
  returns `404`, never `403` — a `403` would confirm the resource exists.
- **API keys:** stored as `prefix` + `sha256(secret)` with constant-time comparison; shown once at
  creation. The demo key is delivered out of band and is never committed (D25).
- **Platform tokens:** AES-256-GCM with `key_version` for rotation, decrypted only inside the
  adapter for the duration of a call.
- **Webhooks:** HMAC verified over the raw body *before* JSON parsing. The verifier supports both
  Meta signing secrets (S5).
- **Logs:** pino with redaction for API keys, tokens and comment text; `requestId` / `jobId` on
  every entry.
- **Config:** validated with Zod at startup; a missing variable fails fast with an actionable
  message.
- **Errors:** RFC 9457 `application/problem+json` carrying a machine-readable `code` from §6.3.
- **Retention:** 45 days by default, enforced by the purge job (D15).

## Development Workflow and Quality Gates

- **Runtime shape:** one service, one image, two roles — `api` and `worker` (§4.1). The roles are
  not split into separate services and the system is not described as a monolith.
- **Storage roles:** Postgres is the source of truth; Redis holds queues, rate limits and locks
  only. Losing Redis MUST NOT lose data.
- **Gates before every commit:** `pnpm lint` (warnings are failures), `pnpm format:check`,
  `pnpm typecheck`, and the relevant tests. CI additionally verifies that the committed
  `openapi.json` matches the Zod schemas.
- **Dependencies:** versions pinned exactly; `.npmrc` sets `minimum-release-age=1440`, so a release
  younger than 24 h is pinned to the previous version rather than lifting the setting. GitHub
  Actions are SHA-pinned and scanned with `zizmor`.
- **Commits:** Conventional Commits — `type(scope): subject`, imperative, lowercase, ≤72 chars, one
  logical change each. The body cites the decision id when the change implements or revises one.
- **Replace, don't deprecate:** a new implementation removes the old one. No compatibility shims,
  dual config formats or dead code left behind.

## Governance

This constitution supersedes other practices for this repository. Where it and `CLAUDE.md` overlap,
they MUST agree; if they conflict, this document wins and `CLAUDE.md` is corrected in the same
change.

**Amendment procedure.** An amendment is a single change that states the principle affected, the
rationale, and the version bump. When the amendment also changes a specification decision or
assumption, `spec.md` §18 is updated in the same change — the specification and the constitution
never disagree at rest.

**Versioning policy.** Semantic versioning of governance: MAJOR for removing or redefining a
principle in a backward-incompatible way, MINOR for a new principle or materially expanded
guidance, PATCH for clarifications and wording that carry no new obligation.

**Compliance review.** Every PR verifies compliance with the principles it touches; a reviewer may
reject on a principle alone. Added complexity MUST be justified against Principle IV (does it stay
inside an adapter?) and Principle II (does it cross the service boundary?). `CLAUDE.md` remains the
runtime guidance file for day-to-day development.

**Version**: 1.0.0 | **Ratified**: 2026-09-11 | **Last Amended**: 2026-09-11
