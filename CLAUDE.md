# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Take-home for Blotato: design and partially implement a multi-platform comment system (original
brief in `task.md`). The repository is **pre-implementation** — only `task.md` and `spec.md` exist.

`spec.md` is the source of truth. Decisions live in §3 (D1–D28), assumptions in §16 (A1–A23),
spikes in §17. Any change to a decision or assumption is recorded in `spec.md` (§18) **before** the
code diverges from it. Cite decision ids (e.g. "per D14") in commits, PRs and DESIGN.md.

All deliverables (README, DESIGN.md, OpenAPI, code comments) are in English (D18).

## Tooling (decided in D21, not yet set up)

pnpm · Node 22 ESM · TypeScript strict · oxlint + oxfmt · `tsc --noEmit` · vitest with
testcontainers (Postgres + Redis) and msw for platform HTTP · fast-check · prek · GitHub Actions
(SHA-pinned, zizmor) · Dependabot. Runtime stack: Fastify, PostgreSQL, Drizzle ORM, BullMQ on Redis
(D6). Deployed to Railway as `api` + `worker` services from one Dockerfile (D24).

When `package.json` scripts are added, record the real commands here (dev, lint, typecheck, test,
single test, migrations, `scripts/` CLIs, OpenAPI generation — CI checks `openapi.json` is current).

## Commits

Conventional Commits: `type(scope): subject` — imperative mood, lowercase subject, no trailing
period, ≤72 chars. Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `build`, `perf`.
Scope is the module or area (`comments`, `platforms/meta`, `db`, `api`, `spec`); omit it when the
change is repo-wide. Breaking changes get a `!` before the colon and a `BREAKING CHANGE:` footer.

Reference the spec decision in the body when the change implements or diverges from one (`per D14`).

## Architecture (spec §4)

One service of the platform, deployed on its own, with two runtime roles from one image: `api`
(REST, webhook intake, Swagger UI, health) and `worker` (BullMQ: publish, sync, webhook processing,
outbox relay, sweepers, purge). Postgres is the source of truth; Redis holds only queues, rate limits
and locks — losing Redis must never lose data. Don't call this a monolith and don't split the roles
into separate services (§4.1).

Planned layout (§4.2): `src/app` (composition, Zod env config), `src/shared`,
`src/modules/platform-core` (ports to other services + a read-only local projection of their data:
workspaces, api keys, social accounts, posts — D8), `src/modules/comments/{domain,application,
infrastructure,http}`, `src/platforms/{registry.ts,types.ts,meta,bluesky}`, `scripts/`, `drizzle/`.

Platform abstraction: every platform implements `CommentPlatformAdapter` (§4.3) and has an entry in
the capability registry (all 9 platforms; only instagram, facebook, bluesky support comments).
Adding a platform must not change the DB schema or the API. Use cases never branch on platform or on
the IG `auth_variant` (D28) — differences stay inside adapters / the Graph client.

## Cross-cutting invariants

These are spread across the spec and are easy to break:

- **Service boundary (D8, D29):** no foreign key and no SQL join from `comments` to platform-core
  tables — `workspace_id`, `social_account_id` and `post_id` are external references. Other services'
  data is read through ports only, never written. Credentials come from the `AccountCredentials`
  port, never from a table read inside an adapter (D26).
- **Tenancy (D20):** every repository call takes `workspaceId`; another workspace's resource → `404`,
  never `403`. Integration tests assert this on every endpoint.
- **Dedup key:** `UNIQUE (social_account_id, platform_comment_id)`. Webhooks and sync share one
  idempotent upsert path; Meta redelivers for up to 36 h.
- **Writes are async:** `POST` returns `202` with `status=queued` (A11); state machine
  `queued → processing → posted | failed`, plus `deleted`. Transitions are conditional `UPDATE`s.
- **Never double-post (D14):** adapter errors are typed (`RetryableError`, `OutcomeUnknownError`,
  `PermanentError`, `AuthError`). On `OutcomeUnknownError`, reconcile via `findPublishedComment`
  before any retry. Handle the webhook-echo race (§7.1 step 7).
- **Events (D9):** domain events go through the transactional outbox in the same transaction as the
  state change — never publish to BullMQ directly from a use case.
- **Sync deletions:** only a *complete* walk may mark comments `deleted`; a partial walk never infers
  deletions. First walk of a post tags events `backfill`.
- **Reply depth (D12):** strict check against `maxReplyDepth` → `422 REPLY_DEPTH_EXCEEDED`; no
  silent re-parenting. Bluesky text limits count graphemes, Meta counts characters.
- **Pagination (D27, A13):** keyset on `(occurred_at, id)`; the opaque cursor encodes direction; a
  cursor used with a different `order` → `400`. Defaults: top-level and inbox `desc`, replies `asc`.
- **Errors:** RFC 9457 `application/problem+json` with a machine-readable `code` from §6.3.
- **Secrets:** API keys stored as prefix + sha256; platform tokens AES-256-GCM with `key_version`;
  webhook HMAC verified over the raw body before JSON parsing; pino redacts keys, tokens and comment
  text. The demo API key is never committed (D25).

## Meta constraints

The Meta App runs in Standard Access (D23): Instagram comment webhooks will not arrive in the
deployment; IG/FB data comes through the sync job. Spikes S1 (FB feed webhooks in dev mode),
S2 (IG comment reads per login variant) and S5 (webhook signing secret for Instagram Login) must be
run before implementing the parts they gate — don't build on unverified Meta behavior.
