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

## Gates before any commit (D21)

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
VALIDATION_ERROR` when the cursor is replayed with the other `order`. Then delete one comment that
still has replies and one that has none: the first comes back as a placeholder with `text: null` and
a null author, its replies still reachable; the second is absent from the list entirely. Finally poll
one comment by id.
**Proves**: FR-001, FR-002, FR-003, FR-004, FR-005, FR-006, FR-007, SC-002, D27, A4.

### V2 — Publishing exactly once (US2)

`pnpm test:integration -- -t 'publish'`

Run the full failure matrix against the adapter double: success; timeout after send; connection drop
after send; 429 with `Retry-After`; permanent rejection; and the platform echoing our own reply back
through ingestion while the worker is still publishing. **Expect** exactly one comment on the
platform double and one row locally in every case; on timeout the worker reconciles through
`findPublishedComment` and settles on `posted` without a second send; on permanent rejection the
comment is `failed` and the quota reservation is released. Two further outcomes: an `AuthError`
leaves `failed` + `PLATFORM_AUTH_FAILED`, an `auth_failed` row in `account_health`, an outbox
`account.auth_failed` and `social_accounts` **unchanged** — the boundary holds even on the failure
path (D30); and a parent deleted after the child was queued settles the child `failed` +
`PARENT_DELETED` with the quota released and nothing sent.
**Proves**: FR-009, FR-011, FR-012, FR-014, SC-001, D14, D30, A19, §7.1 step 7.

### V3 — Write validation and idempotency (US2)

`pnpm test:integration -- -t 'create reply'`

Reply to a reply on Instagram → `422 REPLY_DEPTH_EXCEEDED` naming the top-level comment; the same
depth on Bluesky → `202`. Over-length text → `422 TEXT_TOO_LONG` with nothing sent. Same
`Idempotency-Key`, same body → the original comment; different body → `409`. Two concurrent replies
to the same new audience member → the allowance is consumed once; with the allowance already
exhausted, a reply to a *new* person → `422 QUOTA_EXCEEDED`, while a reply to someone already
counted this period → `202`. A write against a platform the registry marks unsupported →
`422 PLATFORM_NOT_SUPPORTED` with nothing sent. Every rejection above is checked to be
`application/problem+json` carrying its `code`.
**Proves**: FR-010, FR-013, FR-014, FR-032, D12, A8, SC-009 in miniature.

### V4 — Ingestion is idempotent (US3)

`pnpm test:integration -- -t 'webhook'` and `-t 'sync'`

Deliver a signed event, then redeliver it; run a refresh over the same post; tamper with the
signature. **Expect** one comment and one `comment.received` event regardless of redelivery; a
tampered signature rejected with nothing stored; a reply whose parent is unknown attached correctly
after the ancestor walk; an event arriving without `text` completed through `fetchComment` rather
than blanking the stored text (A18); a *complete* walk marking platform-side deletions — with `text`
and the author nulled exactly as a webhook delete does it, since both take the same path — and an
*interrupted* walk marking none; a post's first walk tagged `backfill`. Then the schedule itself: a
post under 24 h old,
one aged past a week and one past retention land in different age bands and the last is not polled at
all — checked against a non-default `RETENTION_DAYS`, because the top band is derived from it rather
than from a literal 45; an ingested comment on a post never published through the platform creates a
refresh target of its own. Then manual refresh — a second request inside the cooldown → `429 SYNC_COOLDOWN`, a request
while a job is running → `202` carrying that same job. Also assert one `comment.received`, one
`comment.posted`, one `comment.failed` and one `comment.deleted` reach the queue with the payload
fields the contract lists.
Freshness is asserted with the clock under test control: a pushed event is readable inside the
60-second budget, and a post with no push channel becomes fresh within its age band's interval.
**Proves**: FR-016, FR-017, FR-018, FR-019, FR-020, FR-021, FR-022, FR-024, FR-030, SC-003, SC-004,
SC-008, A18.

### V5 — Tenancy (all stories)

`pnpm test:integration -- -t 'tenancy'`

Every endpoint, called with a second workspace's key against the first workspace's resource.
**Expect** `404` everywhere — never `403`, never a leak of existence. Then the credential itself: a
missing key, an unrecognized one and a revoked one each → `401 UNAUTHORIZED`; a key driven past its
per-minute budget → `429 RATE_LIMITED` carrying `RateLimit-*` and `Retry-After`. The per-key column
`api_keys.rate_limit_per_min` is a ceiling, not a replacement: a key below the env default is cut off
at its own value, one above it is still cut off at the deployment's.
**Proves**: FR-026, FR-027, FR-028, SC-007, D20.

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
**Proves**: FR-029, SC-010, A9. (FR-030 belongs to the delete path, proven in V4, not to retention:
retention removes whole threads rather than redacting individual comments.)

### V8 — The account inbox (US4)

`pnpm test:integration -- -t 'inbox'`

Ingest comments for one account across two posts, one of them never published through the platform.
**Expect** both in the inbox newest first, the external one with `postId: null`; `since` / `until`
returning only what occurred inside the window; `isOwn` separating the account's own comments from
the audience's, including an own comment that arrived by ingestion rather than through this service;
a reply to the external post's comment accepted with `202`; and `POST /v1/posts/:postId/comments`
for a post with no internal id unreachable — `404`. Then make the `posts` row stop resolving: the
post-scoped list answers `404` while the same comments stay in the inbox.
**Proves**: FR-008, FR-015, FR-023, A2, A7, A10a, D13.

### V9 — The capability registry and the Instagram login variants (US5)

`pnpm test:integration -- -t 'platforms'` and `pnpm test:unit -- -t 'registry'`

`GET /v1/platforms` lists all nine publishing platforms — three supporting comments, six carrying an
`unsupportedReason` — and the depth, text limit and unit it reports for a platform are the same
values the write path enforces, so the registry cannot drift from behaviour. Separately, the
Instagram adapter runs against fixtures for **both** login variants: `facebook_login` on
`graph.facebook.com` and `instagram_login` on `graph.instagram.com` produce identical normalized
comments, identical publish results and identical "own" detection — the same parameterized test body
for both hosts.
**Proves**: FR-031, SC-009, D28, A17, §8.1.

### V10 — Performance budgets (SC-005, SC-006)

`pnpm test:integration -- -t 'benchmark'`

Seed a workspace with 100,000 comments across many posts, then measure the post-comments read and an
accepted write. **Expect** both at p95 under 300 ms, the write independent of how long the adapter
double stalls. This is a build-time budget that fails when a query plan degrades, not a deployed
service level — A21 designs no SLA and A22 puts metrics out of scope.
**Proves**: SC-005, SC-006.

### V11 — Breaking the code on purpose (Principle V)

For deduplication, reconciliation and tenancy, temporarily remove the guard and confirm the
corresponding test fails. A test that has never failed proves nothing; these three are the invariants
whose breakage is silent in production.

---

## Reviewer walkthrough (SC-012)

Against the live deployment, no local setup, with the demo API key delivered out of band — never
committed (D25). The reviewer is assumed not to run the code locally, which is why the deployment is
the deliverable surface (D22). Every step below must work from the documentation alone.

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
deployment facts are likewise unconfirmed and gate their own parts: whether Railway's managed Redis
accepts `maxmemory-policy noeviction` with persistence on (S3 — locally `docker-compose.yml` sets
both; the fallback is Redis from an image with a volume), and Bluesky's current rate limits, which
the §7.3 polling intervals were chosen without (S4 — the intervals are env-driven, but until the
spike runs, the freshness they promise is unverified).
