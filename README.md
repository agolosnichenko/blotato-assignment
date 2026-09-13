# Blotato Comments Service

A comment system for a multi-platform social media scheduling API: read the conversation under a
published post, reply to a comment or start a new top-level thread, and keep that data in sync with
Instagram, Facebook and Bluesky. Built as a take-home for Blotato — the full reasoning behind every
decision below lives in [`spec.md`](./spec.md) (source of truth) and [`DESIGN.md`](./DESIGN.md)
(the write-up for a reader who doesn't want the whole spec).

One repository, one Docker image, two runtime roles: `api` (Fastify — REST, webhook intake, Swagger
UI) and `worker` (BullMQ — publishing, sync, webhook processing, the outbox relay, retention). See
[DESIGN.md §1–§2](./DESIGN.md) for why the roles are not split into separate services.

## For the reviewer — start here

Nothing to install and nothing to seed: the service is deployed, and its demo workspace holds three
**real** connected accounts — an Instagram business account, a Facebook Page and a Bluesky account —
each with a real published post registered as a sync target. Comments you create through the API
appear on those accounts, and you can open them in a browser to check.

**https://api-production-6ef5.up.railway.app** — Swagger UI at
[`/docs`](https://api-production-6ef5.up.railway.app/docs), the OpenAPI document at
[`/openapi.json`](https://api-production-6ef5.up.railway.app/openapi.json), health at
[`/healthz`](https://api-production-6ef5.up.railway.app/healthz) and `/readyz` (the latter pings
Postgres and Redis and reports each).

The demo API key is sent separately by email — never committed to this repository (D25). It is
scoped to the demo workspace, rate-limited, and revocable.

```bash
export BASE=https://api-production-6ef5.up.railway.app
export API_KEY=blt_...   # from the email

# the demo workspace's three posts, by the service's own id
export IG_POST=33333333-3333-4333-8333-333333333331
export FB_POST=33333333-3333-4333-8333-333333333332
export BSKY_POST=33333333-3333-4333-8333-333333333333
```

The platform's own id for each is in the `platformPostId` field of every comment response, so you can
always get from a row here back to the object on the platform.

### Seven requests

**1 — the capability registry.** Nine platforms, three of which support comments; the other six say
why not. Every depth and text-limit check in the service reads this same table.

```bash
curl -s -H "blotato-api-key: $API_KEY" "$BASE/v1/platforms"
```

**2 — read a real thread.** Instagram comments that were ingested from the platform, newest first
(D27), each with its `replyCount`:

```bash
curl -s -H "blotato-api-key: $API_KEY" "$BASE/v1/posts/$IG_POST/comments"
```

Take an `id` from `items[]` — call it `$COMMENT` — and read its replies (ascending, D27):

```bash
curl -s -H "blotato-api-key: $API_KEY" "$BASE/v1/comments/$COMMENT/replies"
```

**3 — reply to it.** The write is asynchronous: `202`, not `201`, because the row exists but the
platform call has not happened yet (A11). Note the `Location` header.

```bash
curl -si -X POST "$BASE/v1/comments/$COMMENT/replies" \
  -H "blotato-api-key: $API_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: review-$RANDOM" \
  -d '{"text":"Reviewing the Blotato take-home 👋"}'
```

**4 — poll the `Location`** until `status` goes `queued → processing → posted`. When it does,
`platformCommentId` is the real Instagram comment id — **open the Instagram post below and you will
see this comment there.**

```bash
curl -s -H "blotato-api-key: $API_KEY" "$BASE/v1/comments/<id from Location>"
```

**5 — the depth limit.** Instagram's `maxReplyDepth` is 1, so replying to a reply is refused up front
rather than silently re-parented (D12). Use one of the `id`s from the replies list in step 2:

```bash
curl -s -w '\n%{http_code}\n' -X POST "$BASE/v1/comments/$REPLY_ID/replies" \
  -H "blotato-api-key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"text":"one level too deep"}'
# 422 REPLY_DEPTH_EXCEEDED
```

The identical request against a Bluesky reply (`maxReplyDepth: null`) is accepted and posts — same
code path, different capability. That contrast is the point of the registry.

**6 — refresh from the platform.** Enqueues a sync walk; poll the returned job id:

```bash
curl -s -X POST "$BASE/v1/posts/$IG_POST/comments/sync" -H "blotato-api-key: $API_KEY"
curl -s -H "blotato-api-key: $API_KEY" "$BASE/v1/comment-sync-jobs/<jobId>"
```

**7 — tenancy and auth.** No key is `401`; another workspace's post is `404`, never `403`, so a key
cannot use the status code to learn whether a resource exists (D20):

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/v1/posts/$IG_POST/comments"
curl -s -o /dev/null -w '%{http_code}\n' -H "blotato-api-key: $API_KEY" \
  "$BASE/v1/posts/00000000-0000-0000-0000-000000000000/comments"
# 401
# 404
```

`pnpm smoke` runs exactly this sequence with assertions instead of eyeballs — see
[`scripts/smoke.ts`](./scripts/smoke.ts); it needs `SMOKE_BASE_URL`, `SMOKE_API_KEY`,
`SMOKE_INSTAGRAM_POST_ID` and `SMOKE_BLUESKY_POST_ID`.

### Where to check the results on the platform

| account | profile | the post the demo runs against |
| --- | --- | --- |
| Instagram | [@blotato_demo](https://www.instagram.com/blotato_demo/) | [instagram.com/p/DdNhTg6Rylh](https://www.instagram.com/p/DdNhTg6Rylh/) |
| Bluesky | [@blotato-demo.bsky.social](https://bsky.app/profile/blotato-demo.bsky.social) | [the demo post](https://bsky.app/profile/blotato-demo.bsky.social/post/3mvfgblffyv2p) |
| Facebook | [Blotato-demo](https://www.facebook.com/1423986634121660) | post `1423986634121660_122093382351485339` (read-blocked, see below) |

Comments posted through the API appear under those posts within seconds of the status turning
`posted`. They are visible to anyone — no login needed for Instagram or Bluesky.

### What was already verified there

The whole SC-012 walkthrough has been run against that URL with those accounts, not fixtures:

| step | what happened |
| --- | --- |
| `GET /v1/platforms` | nine platforms, three supporting comments |
| `GET /v1/posts/:postId/comments` | the post's real Instagram comments, newest first, one with a reply |
| `POST /v1/comments/:id/replies` | `202 queued` with a `Location` |
| poll to `posted` | Instagram comment `18112975520094858` — posted on the platform |
| reply to a reply (Instagram) | `422 REPLY_DEPTH_EXCEEDED`, `maxReplyDepth 1` (D12) |
| reply to a reply (Bluesky) | `202` → `posted`, `at://…/3mvfhkkaki72x` |
| `POST …/comments/sync` | Instagram `fetched: 3, inserted: 3`; Bluesky `succeeded` |

Also verified there: `/readyz` reports Postgres and Redis reachable, a request without a key is
`401`, and another workspace's post is `404` rather than `403` (D20).

**Facebook is read-blocked by Meta's access model, not by this code.** Its sync job fails with
`(#10) This endpoint requires the 'pages_read_user_content' permission or the 'Page Public Content
Access' feature` — and Meta's own login dialog rejects that permission as invalid
(`Invalid Scopes: pages_read_user_content`), because granting it needs App Review. The adapter,
the sync path and the error handling are the same code Instagram and Bluesky run; what is missing
is a Meta approval, which is exactly what D23 anticipates.

## Curl walkthrough (local run, with response bodies)

The section above is the fastest path and needs nothing but the key. This one shows the actual
response bodies, and is what a local run looks like when no real account is connected.

Every response below is real output from a local run of this exact code (PostgreSQL 18.6 + Redis
8.10.1 via `docker compose`, `pnpm dev:api` + `pnpm dev:worker`), not a hand-written example.

```bash
export API_KEY=blt_...            # from `pnpm create-api-key`, or the demo key
export BASE=http://localhost:3000 # or the deployment URL
```

**1. List what the registry supports** — nine platforms, six of them explicitly unsupported:

```bash
curl -s -H "blotato-api-key: $API_KEY" "$BASE/v1/platforms"
```

```json
{"items":[
  {"platform":"instagram","supportsComments":true,"canCreateTopLevel":true,"canReply":true,"maxReplyDepth":1,"textLimit":2200,"textUnit":"characters","ingestion":"webhook+sync"},
  {"platform":"facebook","supportsComments":true,"canCreateTopLevel":true,"canReply":true,"maxReplyDepth":1,"textLimit":8000,"textUnit":"characters","ingestion":"webhook+sync"},
  {"platform":"bluesky","supportsComments":true,"canCreateTopLevel":true,"canReply":true,"maxReplyDepth":null,"textLimit":300,"textUnit":"graphemes","ingestion":"sync"},
  {"platform":"threads","supportsComments":false,"unsupportedReason":"platform API access not in place"},
  {"platform":"x","supportsComments":false,"unsupportedReason":"platform API access not in place"},
  {"platform":"linkedin","supportsComments":false,"unsupportedReason":"platform API access not in place"},
  {"platform":"youtube","supportsComments":false,"unsupportedReason":"platform API access not in place"},
  {"platform":"tiktok","supportsComments":false,"unsupportedReason":"platform API access not in place"},
  {"platform":"pinterest","supportsComments":false,"unsupportedReason":"platform API access not in place"}
]}
```

**2. Read a post's top-level comments:**

```bash
curl -s -H "blotato-api-key: $API_KEY" "$BASE/v1/posts/$POST_ID/comments"
```

```json
{"items":[],"nextCursor":null,"sync":{"lastSyncedAt":null,"activeJobId":null}}
```

(An empty array on a freshly-seeded post is correct — nothing has been ingested yet. Against a post
with history you'd see each comment's `replyCount`, `status`, and a `nextCursor` once there are more
than `limit` rows.)

**3. Post a top-level comment** (`202`, not `201` — the row exists, the platform call hasn't
happened yet; A11):

```bash
curl -s -i -X POST "$BASE/v1/posts/$POST_ID/comments" \
  -H "blotato-api-key: $API_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: walkthrough-1" \
  -d '{"text":"Thanks for reading!"}'
```

```
HTTP/1.1 202 Accepted
ratelimit-limit: 5
ratelimit-remaining: 4
location: /v1/comments/01a097f5-3345-789b-8ef7-836a2980bcbe

{"id":"01a097f5-...","accountId":"...","platform":"bluesky","postId":"...",
 "parentCommentId":null,"platformCommentId":null,"depth":0,"isOwn":true,
 "text":"Thanks for reading!","status":"queued","error":null,"replyCount":0, ...}
```

**4. Poll the `Location` header until the worker settles it:**

```bash
curl -s -H "blotato-api-key: $API_KEY" "$BASE/v1/comments/01a097f5-3345-789b-8ef7-836a2980bcbe"
```

Against a real connected account this becomes `"status":"posted"` with a `platformCommentId`. In
this local run the account's credentials were dummy values (no real Bluesky session), so the worker
correctly gave up and the comment settled as `"status":"failed"` with
`"error":{"code":"PLATFORM_REJECTED","message":"..."}` — the same conditional-`UPDATE` state machine
either way (see [DESIGN.md](./DESIGN.md) "Never double-post").

**5. Replay the same `Idempotency-Key` with a different body → `409`, same body → the original
comment again, not a second one** (A12, FR-013):

```bash
curl -s -w '\n%{http_code}\n' -X POST "$BASE/v1/posts/$POST_ID/comments" \
  -H "blotato-api-key: $API_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: walkthrough-1" -d '{"text":"different text"}'
# {"...","code":"IDEMPOTENCY_KEY_REUSED",...}
# 409
```

**6. Reply past the depth limit on Instagram → `422 REPLY_DEPTH_EXCEEDED`** (D12; `maxReplyDepth` is
1 for Instagram, so replying to a reply is rejected):

```bash
curl -s -w '\n%{http_code}\n' -X POST "$BASE/v1/comments/$IG_REPLY_ID/replies" \
  -H "blotato-api-key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"text":"one level too deep"}'
# {"...","code":"REPLY_DEPTH_EXCEEDED","detail":"reply would exceed maxReplyDepth 1 for thread ...",...}
# 422
```

The same request against a Bluesky thread (`maxReplyDepth: null`) succeeds at any depth.

**7. Cross-workspace access is `404`, never `403`** (D20, so a key can't distinguish "not yours"
from "doesn't exist"):

```bash
curl -s -w '\n%{http_code}\n' -H "blotato-api-key: $API_KEY" \
  "$BASE/v1/posts/00000000-0000-0000-0000-000000000000/comments"
# {"...","code":"NOT_FOUND",...}
# 404
```

**8. Request a refresh** and poll the job:

```bash
curl -s -X POST "$BASE/v1/posts/$POST_ID/comments/sync" -H "blotato-api-key: $API_KEY"
curl -s "$BASE/v1/comment-sync-jobs/$JOB_ID" -H "blotato-api-key: $API_KEY"
```

`404 NOT_FOUND` with `"post ... has no refresh target yet"` is the correct answer for a post that
was never registered as a refresh target (via the `PostPublished` port, or by seeding) — not a bug.

### `$POST_ID`, `$IG_REPLY_ID`, `$JOB_ID` — where they come from

`pnpm seed:account` (task T039) is the one-command path for the workspace, an API key, one
connected account per comment-capable platform (Instagram, Facebook, Bluesky), and one published
post per account registered as a refresh target. It prints the `$POST_ID`s and the minted
`$API_KEY`. It does not insert any comments, though — to get a `$IG_REPLY_ID` to reply to without
running a worker against real Instagram credentials, seed two rows directly in `comments`
(`depth: 0` and `depth: 1`, `status: 'posted'`, `source: 'sync'`) against one of the seeded posts,
to represent an already-ingested thread. This is exactly how the walkthrough above was produced.

## Run it locally

```bash
pnpm install
docker compose up -d              # PostgreSQL 18.6 + Redis 8.10.1
cp .env.example .env               # then fill in the secrets below
pnpm db:migrate                    # applies drizzle/ migrations
pnpm create-api-key --workspace-id <uuid>   # after seeding a workspace (see above)
pnpm dev:api                       # http://localhost:3000/docs
pnpm dev:worker                    # in a second terminal — publishing, sync, purge
```

`.env.example` documents every variable; the ones with no safe default (`CREDENTIALS_ENCRYPTION_KEY`
— 32 bytes base64, `openssl rand -base64 32`; `META_APP_SECRET`, `META_APP_SECRET_INSTAGRAM`,
`META_WEBHOOK_VERIFY_TOKEN`) need a value before the process starts — config validation fails fast
and names exactly which one is missing. For a local run that never talks to a real Meta App, any
non-empty string for the Meta secrets is enough — they're only exercised by the
webhook path and by the Meta adapter's own HMAC helper.

Gates before any commit (also what CI runs):

```bash
pnpm lint && pnpm format:check && pnpm typecheck
pnpm test:unit
pnpm test:integration   # needs a Docker daemon (testcontainers)
```

On Colima or another non-default Docker context:

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
                    credentials) + a read-only local projection of their data — this module is the
                    entire service boundary, in one place
    comments/
      domain/       status state machine, reply-depth and text-limit rules — no database import
      application/  use cases: list/create/reply/sync/ingest/publish/reconcile/purge
      infrastructure/  Drizzle repositories, the transactional outbox + relay, contact quota,
                       BullMQ queues and workers
      http/         routes, Zod request/response schemas, error mapping
  platforms/
    registry.ts     capability registry — all 9 publishing platforms (one source of truth for
                    `GET /v1/platforms` and every depth/text-limit check)
    types.ts        CommentPlatformAdapter port, normalized types, the four typed adapter errors
    meta/           Graph API client (host/token by auth_variant), Instagram + Facebook adapters
    bluesky/        AT Protocol adapter
scripts/          create-api-key, seed-account, generate-openapi, the Meta spikes, and `smoke`
                  (T108) — the SC-012 walkthrough run against a deployment, with its assertions in
                  smoke-checks.ts so they are unit-tested without a server
drizzle/          SQL migrations (generated, committed, reviewed)
specs/            the spec-kit artifacts this was planned from (plan, data model, contracts, tasks)
```

See [DESIGN.md](./DESIGN.md) for the architecture diagram, the ER diagram, the sequence diagrams for
reply/webhook/sync, and the full decision log.

## How I used AI tools

Claude Code ran most of this project end to end, under my review at every step — not as a one-shot
generation, but as a process with its own checkpoints:

- **Requirements and spec.** I gave it `task.md` (the original brief) and had it interview me —
  asking about scope, platform choice, ingestion strategy, retention — to produce `spec.md`, the
  decision log this whole repository is built from. It also researched Blotato's public docs and
  Meta's Graph API / webhook documentation to ground the design in what those APIs actually allow
  (§2 of `spec.md` cites the specific pages). A few of its first-pass assumptions didn't survive
  review — I pushed back on ordering defaults, the auth header name, and the Instagram login-variant
  handling, and those disagreements are recorded as decisions (D27, A16, D28) rather than silently
  overwritten.
- **Planning.** `plan.md`, `data-model.md`, `research.md` and `tasks.md` came from a spec-kit-style
  planning pass: decisions from `spec.md` resolved into concrete files, tables, and a dependency-
  ordered task list, with anything not already decided written down with its rejected alternatives
  rather than picked silently.
- **Implementation.** A controller agent worked through `tasks.md` one wave at a time, dispatching
  implementer subagents per task (or per small group of related tasks) against a shared set of
  constraints, with tests written before the implementation they cover and a review pass after each
  wave. I read the controller's summaries and spot-checked the diffs rather than reviewing every
  line myself — the things I did catch personally are below.
- **What the review passes actually caught** — concrete, not a list of virtues:
  - `secureCompare` (the API-key comparison helper) hashes before comparing so the comparison itself
    is length-independent, but a reviewer pointed out the *hashing* step isn't — safe for fixed-
    length digests, not a general constant-time primitive — and the residual limitation is now
    stated in the code rather than left implicit.
  - Log redaction stopped one level too shallow: a comment page logged as a nested field, or a
    BullMQ job's `job.data.comment.text`, leaked comment text past the redactor. Caught by review,
    fixed by widening the redaction depth and adding a test that logs exactly that shape.
  - An error-catalogue test imported its "expected HTTP status per code" table from the same module
    it was testing — so a transposed status code in the implementation would have been copied
    into the test and passed. Fixed by re-deriving the expected table independently from the
    contract document instead of importing it.
  - `ContactQuota.reserve` originally opened its own database transaction. The spec requires the
    quota reservation, the comment insert, and the outbox write to commit together (so a crash
    between them can't leak a permanent allowance); a reservation with its own transaction could
    commit and then lose the comment insert, with no way back since `release` is keyed by a comment
    id that was never written. Fixed to join the caller's transaction instead of opening its own.
  - A schema migration for `comment_sync_targets.age_anchor_at` was drafted with a `now()` default
    for rows inserted without one. That default would have silently placed an untracked post in the
    most aggressive polling band (as if it had just been published) instead of failing the insert —
    a wrong guess that looks like success. Rejected in review; the column stays `NOT NULL` with no
    default, and the three places that insert a row were fixed to supply a real anchor instead.
  - One interface — the `ApiKeys` port — got its exact shape changed twice mid-implementation while
    two different tasks (the port definition and the auth hook that calls it) were in flight at the
    same time, settling on a discriminated `Found<T>` result used consistently across all six ports.
    The agent implementing the auth hook re-read the port file from disk before adapting to a
    paraphrased description of it, which is what caught that an earlier message had described an
    intermediate, not-yet-final state.
  - Before spike S2 ran, the Instagram read path was left **throwing** rather than stubbed to
    return nothing — a stub returning an empty page would make a sync walk conclude the post has no
    comments and mark an entire real thread `deleted`. The same instinct survives into the built
    version: a comment whose nested reply edge is truncated throws instead of reporting a complete
    walk, because an incomplete walk infers no deletions (FR-019). Refusing to answer is safe;
    answering "nothing" is not.
- **What I did myself.** I made the calls an agent shouldn't: which platforms to support, the
  service-boundary shape (no foreign key across services, ports only), what stays out of scope, and
  every point in `spec.md §18` where an amendment changes stated behavior — each of those went
  through me, not just the agent, because they're product and architecture decisions, not
  implementation detail.
