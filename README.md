# Blotato Comments Service

A comment system for a multi-platform social media scheduling API: read the conversation under a
published post, reply to a comment or start a new thread, and keep that data in sync with Instagram,
Facebook and Bluesky. Take-home for Blotato ([`task.md`](./task.md)).

One repository, one Docker image, two runtime roles: `api` (Fastify — REST, webhook intake, Swagger
UI) and `worker` (BullMQ — publishing, sync, outbox relay, retention).

- [`DESIGN.md`](./DESIGN.md) — the design write-up: architecture, schema, API, flows, decisions and
  trade-offs. **Start here if you want the reasoning.**
- [`spec.md`](./spec.md) — the working specification every decision (`D#`), assumption (`A#`) and
  spike (`S#`) is numbered in, and the changelog of everything that changed during implementation.

## For the reviewer

The service is deployed with three **real** connected accounts — an Instagram business account, a
Facebook Page and a Bluesky account — each with a real published post. Comments you create through
the API appear on those accounts; you can open them in a browser and check.

**https://api-production-6ef5.up.railway.app** — [`/docs`](https://api-production-6ef5.up.railway.app/docs)
(Swagger UI), [`/openapi.json`](https://api-production-6ef5.up.railway.app/openapi.json),
[`/readyz`](https://api-production-6ef5.up.railway.app/readyz) (pings Postgres and Redis).

The demo API key is in the email — never committed (D25). It is scoped to the demo workspace,
rate-limited and revocable.

```bash
export BASE=https://api-production-6ef5.up.railway.app
export API_KEY=blt_...   # from the email

export IG_POST=33333333-3333-4333-8333-333333333331
export FB_POST=33333333-3333-4333-8333-333333333332
export BSKY_POST=33333333-3333-4333-8333-333333333333
```

`pnpm smoke` runs steps 1–7 below with assertions instead of eyeballs
([`scripts/smoke.ts`](./scripts/smoke.ts); needs `SMOKE_BASE_URL`, `SMOKE_API_KEY`,
`SMOKE_INSTAGRAM_POST_ID`, `SMOKE_BLUESKY_POST_ID`).

### 1. The capability registry

Nine platforms, three of which support comments. Every depth and text-limit check in the service
reads this table — no use case contains a `switch (platform)`.

```bash
curl -s -H "blotato-api-key: $API_KEY" "$BASE/v1/platforms"
```

```json
{"items":[
  {"platform":"instagram","supportsComments":true,"maxReplyDepth":1,"textLimit":2200,"textUnit":"characters","ingestion":"webhook+sync"},
  {"platform":"facebook","supportsComments":true,"maxReplyDepth":1,"textLimit":8000,"textUnit":"characters","ingestion":"webhook+sync"},
  {"platform":"bluesky","supportsComments":true,"maxReplyDepth":null,"textLimit":300,"textUnit":"graphemes","ingestion":"sync"},
  {"platform":"threads","supportsComments":false,"unsupportedReason":"platform API access not in place"}
]}
```

(`x`, `linkedin`, `youtube`, `tiktok`, `pinterest` follow with the same `unsupportedReason`.)

### 2. The workspace inbox — no identifier at all

Every comment across every connected account, newest first. This is the read the three nested routes
could not serve, and the reason they were replaced by one filtered collection (D31).

```bash
curl -s -H "blotato-api-key: $API_KEY" "$BASE/v1/comments"
```

### 3. Drill into one thread

Same collection, filtered to a post's top level, each item carrying its `replyCount`:

```bash
curl -s -H "blotato-api-key: $API_KEY" "$BASE/v1/comments?postId=$IG_POST&topLevelOnly=true"
```

Take an `id` from `items[]` — call it `$COMMENT` — and read its replies oldest-first:

```bash
curl -s -H "blotato-api-key: $API_KEY" "$BASE/v1/comments?parentCommentId=$COMMENT&order=asc"
```

### 4. Reply to it

`202`, not `201`: the row exists, the platform call has not happened yet (A11). Note the `Location`
header.

```bash
curl -si -X POST "$BASE/v1/comments/$COMMENT/replies" \
  -H "blotato-api-key: $API_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: review-$RANDOM" \
  -d '{"text":"Reviewing the Blotato take-home 👋"}'
```

```
HTTP/1.1 202 Accepted
ratelimit-remaining: 4
location: /v1/comments/01a097f5-3345-789b-8ef7-836a2980bcbe

{"id":"01a097f5-...","platform":"instagram","parentCommentId":"...","platformCommentId":null,
 "depth":1,"isOwn":true,"status":"queued","error":null,"replyCount":0, ...}
```

Replaying that `Idempotency-Key` with a different body is `409 IDEMPOTENCY_KEY_REUSED`; with the
same body it returns the original comment, not a second one (A12).

### 5. Poll the `Location`

Until `status` goes `queued → processing → posted`. When it does, `platformCommentId` is the real
Instagram comment id — **open the Instagram post below and you will see the comment there.**

```bash
curl -s -H "blotato-api-key: $API_KEY" "$BASE/v1/comments/<id from Location>"
```

### 6. The depth limit

Instagram's `maxReplyDepth` is 1, so replying to a reply is refused up front rather than silently
re-parented (D12). Use a reply `id` from step 3:

```bash
curl -s -w '\n%{http_code}\n' -X POST "$BASE/v1/comments/$REPLY_ID/replies" \
  -H "blotato-api-key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"text":"one level too deep"}'
# {"code":"REPLY_DEPTH_EXCEEDED","detail":"reply would exceed maxReplyDepth 1 for thread ..."}
# 422
```

The identical request against a Bluesky reply (`maxReplyDepth: null`) is accepted and posts — same
code path, different capability row. That contrast is the point of the registry.

### 7. Refresh from the platform

```bash
curl -s -X POST "$BASE/v1/posts/$IG_POST/comments/sync" -H "blotato-api-key: $API_KEY"
curl -s -H "blotato-api-key: $API_KEY" "$BASE/v1/comment-sync-jobs/<jobId>"
```

### 8. Tenancy and auth

No key is `401`; another workspace's post is `404`, never `403`, so a key cannot use the status code
to learn whether a resource exists (D20):

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/v1/comments?postId=$IG_POST"
curl -s -o /dev/null -w '%{http_code}\n' -H "blotato-api-key: $API_KEY" \
  "$BASE/v1/comments?postId=00000000-0000-0000-0000-000000000000"
# 401
# 404
```

Step 8 stays a manual check: asserting it needs a second workspace's key, which the integration
suite mints for itself (`tenancy.integration.test.ts`) and a script pointed at a deployment cannot.

### Where to check the results

| account | profile | the post the demo runs against |
| --- | --- | --- |
| Instagram | [@blotato_demo](https://www.instagram.com/blotato_demo/) | [instagram.com/p/DdNhTg6Rylh](https://www.instagram.com/p/DdNhTg6Rylh/) |
| Bluesky | [@blotato-demo.bsky.social](https://bsky.app/profile/blotato-demo.bsky.social) | [the demo post](https://bsky.app/profile/blotato-demo.bsky.social/post/3mvfgblffyv2p) |
| Facebook | [Blotato-demo](https://www.facebook.com/1423986634121660) | [the demo post](https://www.facebook.com/1423986634121660/posts/122093382351485339) |

Comments appear under those posts within seconds of the status turning `posted`, and are visible
without a login on Instagram and Bluesky.

### Already run against that deployment

All three comment-capable platforms run live — real ingestion and real publishing, through the same
use cases and the same adapter port:

| | result |
| --- | --- |
| sync | Instagram `fetched 3, inserted 3`; Facebook `fetched 3, inserted 3`; Bluesky succeeded |
| publish | Instagram comment `18112975520094858`; Facebook `122093382351485339_936214829041858`; Bluesky `at://…/3mvfhkkaki72x` |
| depth limit | `422 REPLY_DEPTH_EXCEEDED` on Instagram, `202 → posted` for the same shape on Bluesky (D12) |
| auth / tenancy | no key `401`, another workspace's post `404` (D20); `/readyz` reports Postgres and Redis reachable |

## Run it locally

```bash
pnpm install
docker compose up -d               # PostgreSQL 18.6 + Redis 8.10.1
cp .env.example .env               # then fill in the secrets below
pnpm db:migrate
pnpm seed:account                  # workspace, API key, one account + post per platform
pnpm dev:api                       # http://localhost:3000/docs
pnpm dev:worker                    # second terminal — publishing, sync, purge
```

`pnpm seed:account` prints the post ids and the minted API key. It seeds no comments, so a local
`GET /v1/comments` is legitimately empty until a sync walk runs or you post one.

`.env.example` documents every variable. Those with no safe default fail config validation at
startup, naming the missing one: `CREDENTIALS_ENCRYPTION_KEY` (32 bytes base64,
`openssl rand -base64 32`), `META_APP_SECRET`, `META_APP_SECRET_INSTAGRAM`,
`META_WEBHOOK_VERIFY_TOKEN`. For a local run that never talks to a real Meta App, any non-empty
string works for the Meta secrets.

Gates before a commit, and what CI runs:

```bash
pnpm lint && pnpm format:check && pnpm typecheck
pnpm test:unit
pnpm test:integration   # needs a Docker daemon (testcontainers)
```

On Colima or another non-default Docker context, testcontainers needs the socket named explicitly:

```bash
export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
```

## Layout

```text
src/
  app/            composition: api.ts, worker.ts, Zod env config, the DI container
  shared/         db, queue, logger (pino, redacted), errors (RFC 9457), crypto (AES-256-GCM),
                  pagination (keyset cursor codec), ids (UUIDv7)
  modules/
    platform-core/  ports to the rest of the platform (workspaces, api keys, accounts, posts,
                    credentials) + a read-only projection of their data — the service boundary,
                    in one place
    comments/
      domain/       status state machine, reply-depth and text-limit rules — no database import
      application/  use cases: list/create/reply/sync/ingest/publish/reconcile/purge
      infrastructure/  Drizzle repositories, the transactional outbox + relay, contact quota,
                       BullMQ queues and workers
      http/         routes, Zod request/response schemas, error mapping
  platforms/
    registry.ts     capability registry — all 9 platforms, one source of truth for
                    `GET /v1/platforms` and every depth/text-limit check
    types.ts        CommentPlatformAdapter port, normalized types, the four typed adapter errors
    meta/           Graph API client (host/token by auth_variant), Instagram + Facebook adapters
    bluesky/        AT Protocol adapter
scripts/          create-api-key, seed-account, generate-openapi, the Meta spikes, smoke
drizzle/          SQL migrations (generated, committed, reviewed)
specs/            the planning artifacts this was built from (plan, data model, contracts, tasks)
```

## How I used AI tools

Claude Code ran most of this project, under my review at each step.

- **Spec.** I gave it `task.md` and had it interview me — scope, platforms, ingestion, retention —
  to produce `spec.md`, plus research into Blotato's public docs and Meta's Graph API and webhook
  documentation (cited in §2). Where I disagreed with its first pass — ordering defaults, the auth
  header name, the Instagram login variants — the disagreement is recorded as a decision (D27, A16,
  D28) rather than silently overwritten.
- **Planning and implementation.** Decisions resolved into `plan.md`, `data-model.md` and a
  dependency-ordered `tasks.md`; then a controller agent worked through it one wave at a time,
  dispatching implementer subagents, tests before implementation, a review pass after each wave. I
  read the summaries and spot-checked diffs rather than every line.
- **What review caught** — the four worth naming:
  - `ContactQuota.reserve` opened its own transaction. A crash between it and the comment insert
    would leak a permanent quota allowance with no way back, since `release` is keyed by a comment
    id that was never written. Fixed to join the caller's transaction.
  - A migration gave `comment_sync_targets.age_anchor_at` a `now()` default, which would silently
    put an untracked post in the most aggressive polling band instead of failing the insert.
    Rejected; the column stays `NOT NULL` with no default.
  - Log redaction stopped one level too shallow — a nested comment page, or `job.data.comment.text`,
    leaked comment text past the redactor.
  - An error-catalogue test imported its expected status table from the module under test, so a
    transposed status code would have been copied into the test and passed.
- **What I decided myself.** Which platforms to support, the service-boundary shape (no foreign key
  across services, ports only), what stays out of scope, and every amendment in `spec.md` §18 that
  changes stated behaviour — product and architecture calls, not implementation detail.
