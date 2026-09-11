# Quickstart & Validation: Multi-Platform Comment System

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

How to run the service and how to prove it does what the specification claims. Scenarios reference
the requirements and success criteria they validate; implementation detail belongs in `tasks.md`, not
here.

## Prerequisites

- Node 22.20+ and pnpm 10.26 (both pinned in `package.json`)
- A Docker daemon — for `docker compose` and for testcontainers
- `.env` copied from `.env.example`
- For the live platform paths only: a Meta App in Standard Access with an Instagram professional
  account and a linked Facebook Page, and a Bluesky account with an app password (D23, §12)

On Colima or any non-default Docker context, testcontainers needs to be told where the socket is:

```bash
export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
```

## Run it

```bash
pnpm install
docker compose up -d              # PostgreSQL + Redis
pnpm db:migrate                   # apply drizzle/ migrations
pnpm seed:account                 # scripts/seed-account.ts — demo workspace, api key, connected
                                  # accounts, and published posts registered as refresh targets
pnpm dev:api                      # http://localhost:3000/docs
pnpm dev:worker                   # in a second terminal
```

`GET /healthz` answers as soon as the process is up; `GET /readyz` answers `200` only once both
PostgreSQL and Redis respond.

## Gates before any commit

```bash
pnpm lint          # oxlint — warnings are failures
pnpm format:check  # oxfmt
pnpm typecheck     # tsc --noEmit
pnpm test:unit     # no containers
pnpm test:integration
```

CI additionally checks that the committed `openapi.json` matches the Zod schemas (D18).

---

## Validation scenarios

Each scenario is runnable and maps to what it proves. Platform HTTP is mocked at the boundary with
msw; PostgreSQL and Redis are real (testcontainers).

### V1 — Reading a conversation (US1)

`pnpm test:integration -- -t 'post comments'`

Seed 30 top-level comments, page with `limit=20` in both `order` directions, follow the cursor, then
insert 5 more comments between the two page requests and follow it again. **Expect** every
pre-existing comment exactly once, no gaps, correct `replyCount`, a `sync.lastSyncedAt`, and `400
VALIDATION_ERROR` when the cursor is replayed with the other `order`.
**Proves**: FR-001–FR-006, SC-002, D27.

### V2 — Publishing exactly once (US2)

`pnpm test:integration -- -t 'publish'`

Run the full failure matrix against the adapter double: success; timeout after send; connection drop
after send; 429 with `Retry-After`; permanent rejection; and the platform echoing our own reply back
through ingestion while the worker is still publishing. **Expect** exactly one comment on the
platform double and one row locally in every case; on timeout the worker reconciles through
`findPublishedComment` and settles on `posted` without a second send; on permanent rejection the
comment is `failed` and the quota reservation is released.
**Proves**: FR-011, FR-012, FR-014, SC-001, D14, §7.1 step 7.

### V3 — Write validation and idempotency (US2)

`pnpm test:integration -- -t 'create reply'`

Reply to a reply on Instagram → `422 REPLY_DEPTH_EXCEEDED` naming the top-level comment; the same
depth on Bluesky → `202`. Over-length text → `422 TEXT_TOO_LONG` with nothing sent. Same
`Idempotency-Key`, same body → the original comment; different body → `409`. Two concurrent replies
to the same new audience member → the allowance is consumed once.
**Proves**: FR-010, FR-013, FR-014, D12, A8, SC-009 in miniature.

### V4 — Ingestion is idempotent (US3)

`pnpm test:integration -- -t 'webhook'` and `-t 'sync'`

Deliver a signed event, then redeliver it; run a refresh over the same post; tamper with the
signature. **Expect** one comment and one `comment.received` event regardless of redelivery; a
tampered signature rejected with nothing stored; a reply whose parent is unknown attached correctly
after the ancestor walk; a *complete* walk marking platform-side deletions and an *interrupted* walk
marking none; a post's first walk tagged `backfill`.
**Proves**: FR-016–FR-022, SC-003, SC-008.

### V5 — Tenancy (all stories)

`pnpm test:integration -- -t 'tenancy'`

Every endpoint, called with a second workspace's key against the first workspace's resource.
**Expect** `404` everywhere — never `403`, never a leak of existence.
**Proves**: FR-026, SC-007, D20.

### V6 — Durability without Redis (US2, US3)

`pnpm test:integration -- -t 'outbox'` and `-t 'sweeper'`

An event appears only after the transaction commits and is published once. Then drop the queue
between acceptance and processing: the sweeper re-enqueues comments left `queued` with no active job,
and unprocessed webhook deliveries older than five minutes.
**Proves**: FR-025, FR-033, SC-011, D9.

### V7 — Retention (US1)

`pnpm test:integration -- -t 'retention'`

A thread whose last activity is 46 days old is removed whole; a thread with a comment on day 44 is
untouched, including its older comments.
**Proves**: FR-029, FR-030, SC-010, A9.

### V8 — Breaking the code on purpose (Principle V)

For deduplication, reconciliation and tenancy, temporarily remove the guard and confirm the
corresponding test fails. A test that has never failed proves nothing; these three are the invariants
whose breakage is silent in production.

---

## Reviewer walkthrough (SC-012)

Against the live deployment, no local setup, with the demo API key delivered out of band — never
committed (D25). Target: under 10 minutes.

1. `GET /v1/platforms` — nine platforms, three supporting comments, six with a stated reason.
2. `GET /v1/posts/:postId/comments` — the conversation, newest first, with freshness reported.
3. `POST /v1/comments/:commentId/replies` — `202` with `status: "queued"` and a `Location`.
4. `GET /v1/comments/:id` — poll until `posted`, then see the reply on the platform itself.
5. Reply to a reply on Instagram → `422 REPLY_DEPTH_EXCEEDED`; the same on Bluesky → `202`.
6. `POST /v1/posts/:postId/comments/sync` → `202`, then `GET /v1/comment-sync-jobs/:jobId` for the
   counts.

`scripts/smoke.ts` runs this same sequence against the deployment in CI.

## Known deployment limits

The Meta App runs in Standard Access, so Instagram comment webhooks will not arrive in this
deployment; Instagram and Facebook data comes through the refresh path, and the webhook path is
exercised with test events from the App Dashboard (D23). Three platform behaviours remain
unverified and gate the code that depends on them: S1, S2 and S5 (§17, research R-09). Two
deployment facts are likewise unconfirmed: whether Railway's managed Redis accepts
`maxmemory-policy noeviction` with persistence on (S3 — locally `docker-compose.yml` sets both), and
Bluesky's current rate limits, which the §7.3 polling intervals were chosen without (S4). Both are
configuration, not code: S3's fallback is Redis from an image with a volume, and the intervals are
env-driven.
