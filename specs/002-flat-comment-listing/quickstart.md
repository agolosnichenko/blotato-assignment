# Quickstart & Validation: Workspace-wide comment listing and authenticated API docs

**Feature**: `002-flat-comment-listing` | **Date**: 2026-09-14 | **Plan**: [plan.md](./plan.md)

How to run the feature and how to prove each success criterion. Every scenario below names the
command that produces the evidence — this file is a validation guide, not an implementation guide;
the shape of the API is in [contracts/rest-api.md](./contracts/rest-api.md) and the storage delta in
[data-model.md](./data-model.md).

## Prerequisites

```bash
docker compose up -d                 # Postgres 18 + Redis 8
cp .env.example .env                 # then fill in what the Zod config requires
pnpm db:migrate                      # includes this feature's single CREATE INDEX
pnpm seed:account                    # demo workspace, accounts, posts and comments
pnpm create-api-key                  # prints the key once — it is never recoverable
pnpm dev:api                         # and, in another shell, pnpm dev:worker
```

On Colima or any non-default Docker context, integration tests need the socket override documented
in `CLAUDE.md`.

## Gates before any commit

```bash
pnpm lint && pnpm format:check && pnpm typecheck
pnpm test:unit
pnpm test:integration
pnpm generate-openapi && git diff --exit-code openapi.json   # what CI's drift step checks
```

---

## V1 — The cross-account inbox (US1, SC-001, FR-001, FR-005)

The journey no route served before: an identifier-free request.

```bash
curl -s -H "blotato-api-key: $API_KEY" "$BASE/v1/comments"
```

**Expect**: comments from *both* seeded accounts and from both platform-published and externally
created posts, newest first, in one page; nothing from another workspace; no `sync` key in the body.

**Prove it**, in `list-comments.integration.test.ts`:

- two accounts seeded, both appear in one page; a third workspace's comments do not;
- the `Posts` and `Accounts` ports are spies, and neither is called — FR-005 is a behaviour, so it
  is asserted, not assumed;
- an empty workspace answers `200 { items: [], nextCursor: null }`, not an error;
- a comment whose `postId` is absent from the projection is returned (acceptance 1.4). Seed it by
  deleting the projection row, not by nulling the comment's `postId` — the point is that a dangling
  reference is readable.

## V2 — Paging is exact under concurrent inserts (SC-003, D27)

```bash
curl -s -H "blotato-api-key: $API_KEY" "$BASE/v1/comments?limit=5"
curl -s -H "blotato-api-key: $API_KEY" "$BASE/v1/comments?limit=5&cursor=$NEXT"
```

**Prove it**: walk a seeded history to exhaustion, inserting new comments between pages; collect
every returned id and assert the multiset equals the seeded set — no duplicate, no gap. Run it in
both directions. This is the existing keyset machinery, so the test is guarding that the new
predicate builder did not break it.

The paging parameters' own validation lives here too, because US1 is what introduces them:
`limit=0`, `limit=101`, a truncated cursor, and a `desc` cursor replayed with `order=asc` are each
`400 VALIDATION_ERROR`.

## V3 — Every removed read, reproduced (US2, SC-002, FR-002)

| Old address | New selection |
|-------------|---------------|
| `GET /v1/posts/:id/comments` | `GET /v1/comments?postId=:id&topLevelOnly=true` |
| `GET /v1/comments/:id/replies` | `GET /v1/comments?parentCommentId=:id&order=asc` |
| `GET /v1/accounts/:id/comments` | `GET /v1/comments?accountId=:id` |

**Prove it**: the three rewritten integration tests (`post-comments`, `replies`, `inbox`) drive the
collection and keep their original assertions, and each gains one more — that its old address now
answers `404` with `code: NOT_FOUND` (acceptance 2.6, FR-009). Seed data that partly matches and
partly does not for every filter, so a filter that is silently ignored fails the test rather than
passing it.

Also assert, in the same file:

- `platform=instagram&platform=bluesky` returns the union; `platform=tiktok` is accepted and returns
  nothing; `platform=nonsense` is `400`;
- `topLevelOnly=true` together with `parentCommentId` is `200` with an empty page, not `400`
  (clarification 2026-09-14);
- `since` later than `until` is an empty `200`.

The paging parameters' validation is V2's, not this scenario's — asserted once, where the parameters
are introduced.

## V4 — Refresh freshness follows the post, not the request shape (FR-006)

```bash
curl -s -H "blotato-api-key: $API_KEY" "$BASE/v1/comments?postId=$POST&platform=instagram"
```

**Expect**: the `sync` block is present here — a post is named, other filters notwithstanding — and
**absent** from V1's response and from any selection naming no post. Assert absence as
`'sync' in body === false`, not `body.sync === null`; the two are different bodies and only one is
the contract.

Assert absence for a selection that names an *identifier other than a post* as well —
`?accountId=…` and `?parentCommentId=…` — not only for the identifier-free request. That is the case
that regresses if the condition is written as "an identifier filter is present" instead of "a post
is named", and V1's assertion alone would not catch it.

## V5 — Tenancy, one test per identifier filter (SC-004, FR-004, D20)

Seed a second workspace with its own post, account and comment. For each of `postId`, `accountId`
and `parentCommentId`, call the collection with the foreign identifier and assert `404`, body
`code: NOT_FOUND`. Never `403`, never an empty `200` — either would confirm the identifier exists.

The existing `tenancy.integration.test.ts` is where these live; its per-endpoint table loses three
rows and gains the collection's three filters.

## V6 — Authenticating inside the docs (US3, SC-006, SC-007, FR-011, FR-012)

Open `$BASE/docs` in a browser with no terminal open.

**Expect**: an **Authorize** button naming `blotato-api-key` as a header; after pasting the demo
key, "Try it out" on `GET /v1/comments` returns data, not `401`; `GET /healthz` and `GET /readyz`
show as requiring no key. The two `/webhooks/meta` operations are **not in the document at all** —
they are registered `hide: true`, are exercised by Meta rather than by a reviewer, and authenticate
by signature (spec Assumptions, R-09). Their absence is the expected result, not a gap.

**Prove the machine-readable half** without a browser, in an integration test over the generated
document:

- `components.securitySchemes.apiKey` is `{ type: apiKey, name: blotato-api-key, in: header }`;
- the document's global `security` requires it;
- the set of operations carrying `security: []` equals `PUBLIC_ROUTES.filter(r => r.published)` —
  computed from the exported array in the assertion, so adding a published exempt route without
  publishing its exemption fails the test (FR-012);
- **no** operation exists for any `PUBLIC_ROUTES` entry with `published: false`, so flipping a
  route's registration to visible without flipping its flag fails too — the drift runs both ways;
- every published route the app registers appears in the document, and every documented path is a
  registered route (SC-007). The exclusion list is not hand-written: a route is expected in the
  document unless a `PUBLIC_ROUTES` entry marks it unpublished or its schema sets `hide`.
  `pnpm generate-openapi` + `git diff --exit-code` is the CI half of the same claim;
- every endpoint FR-010 requires to keep its address is present in the document under that address,
  so the removal work cannot quietly take a neighbour with it.

## V7 — The listing's cost follows the page, not the history (SC-005, FR-013)

Two claims, measured two different ways — see [research.md](./research.md) R-10 for why they are
separate.

**Structural, in CI** — `benchmark.integration.test.ts` today holds **one** `EXPLAIN` assertion, on
the post's top-level read, and it checks only that *some* index node appears. That is not enough for
FR-013's second half: the new `comments_workspace_idx` competes with the narrower indexes on exactly
those queries (R-04, R-05), and a flip to it would keep an unnamed assertion green. So the file grows
to four `EXPLAIN` assertions, each naming its index and each requiring no sort node:

| Selection | Expected index |
|-----------|----------------|
| `postId` + `topLevelOnly=true` | `comments_post_top_level_idx` |
| `parentCommentId` | `comments_replies_idx` |
| `accountId` | `comments_social_account_idx` |
| no filter | `comments_workspace_idx` |

The file's existing absolute p95 budgets are feature 001's and are left alone (R-10).

**Timing, on demand** —

```bash
pnpm bench:listing        # scripts/bench-listing.ts
```

Seeds two workspaces whose histories differ by a factor of ten, issues the unfiltered listing at
equal page size, and prints the p95 of each and their ratio. **Pass: ratio ≤ 1.5.** A genuinely
bounded listing measures near 1.0; a result near the limit is itself the signal that it is not.
Record the number and the machine in `DESIGN.md`. Deliberately not a CI gate — timing on a shared
runner is too noisy to gate on, and a flaky gate gets disabled.

## V8 — Break it once, to prove the tests can fail (Principle V)

Three invariants are silent when broken, so each gets a deliberate break before the change is
considered done:

| Break | Test that must go red |
|-------|----------------------|
| drop `workspace_id` from the list predicate | V1's cross-workspace assertion and every V5 case |
| resolve `postId` through a join instead of the `Posts` port | V1's port-spy assertion (FR-005) and V5's post case |
| annotate `GET /readyz`'s `security` by hand instead of from `PUBLIC_ROUTES`, and separately flip one `published: false` entry to `true` | V6's two derived-set assertions, one per direction |

## V9 — The walkthrough a reviewer actually follows (FR-015, SC-008)

`README.md`'s curl walkthrough now **starts** at `GET /v1/comments` with no identifier, then drills
down with filters — an identifier-free first step is the property FR-015 names. `scripts/smoke.ts`
follows the same order and is what proves the deployed service does it too:

```bash
pnpm smoke
```

`DESIGN.md` carries the reasoning SC-008 measures: why reads are one filtered collection (the
missing cross-account inbox — explicitly *not* discoverability), why writes stay addressed to their
target, why `topLevelOnly` exists as a filter, and why the refresh command stays addressed to a
post. A reader must be able to state it without asking the author.
