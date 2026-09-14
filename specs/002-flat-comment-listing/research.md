# Phase 0 Research: Workspace-wide comment listing and authenticated API docs

**Feature**: `002-flat-comment-listing` | **Date**: 2026-09-14 | **Plan**: [plan.md](./plan.md)

The feature specification fixes the observable behaviour; this file records the choices it leaves
open, each with the alternatives that were rejected and why. Nothing here re-decides a root
`spec.md` decision: the one decision this feature introduces is **D31**, and it is recorded in
`spec.md` §18 before any code moves (Principle I, FR-014).

Entries are referenced from `plan.md`, `data-model.md` and `contracts/rest-api.md` as `R-01` … `R-11`.

---

## R-01 — The collection's address and its relationship to the existing `/v1/comments/:id`

**Decision**: `GET /v1/comments`, all filters in the query string. The single-comment route
`GET /v1/comments/:commentId` (FR-010) keeps its address unchanged and does not collide: Fastify's
radix router treats `/v1/comments` and `/v1/comments/:commentId` as distinct nodes, a static path
and a parametric child.

**Rationale**: the resource being addressed is "the workspace's comments", and the workspace is
already carried by the API key — so the address needs no path segment at all, which is exactly
what US1 requires (a caller holding only a key, SC-001). Filters that narrow a set belong in the
query string; identifiers that name a write target stay in the path (`POST /v1/posts/:postId/comments`,
`POST /v1/comments/:commentId/replies`, `POST /v1/posts/:postId/comments/sync` — all unchanged by
FR-010). Commands address, queries filter.

**Alternatives rejected**:

- `GET /v1/workspaces/:workspaceId/comments` — the workspace id in the path would be a second,
  spoofable source of tenancy alongside the key, and D20 answers a mismatch with `404`, so the
  segment could only ever repeat what the key already said or produce an error. Pure ceremony.
- `GET /v1/inbox` — a second name for the same collection, differing only by default filters. It
  would make the "one collection" claim false the first time the two drifted.
- Keeping the three nested routes alongside the collection — forbidden by FR-009 and by the
  constitution's "replace, don't deprecate"; two code paths for one read is exactly the drift the
  removal exists to prevent.

---

## R-02 — The repeatable `platform` filter: parsing it, and publishing it honestly

**Decision**: `platform` is a repeatable query parameter (`?platform=instagram&platform=bluesky`),
normalized to an array before validation, and validated against the **keys of
`src/platforms/registry.ts`** rather than a hand-written literal union.

Fastify's default query parser is `node:querystring.parse`, which yields a `string` for one
occurrence and a `string[]` for several. The Zod schema therefore normalizes first and validates
second, so a single value and a repeated value take the same path.

Validating against the registry keys is what keeps Principle IV intact. The edge case the spec
names — an unknown platform is `400`, a *known but comment-less* platform (e.g. `tiktok`) is
accepted and matches nothing — falls out of this for free: membership in the registry decides
validity, `supportsComments` decides nothing here, and no use case learns a platform's name.

**Verification required during implementation** (not an assumption to build on): how
`fastify-type-provider-zod@7` renders the normalization step into the OpenAPI document. Zod 4's
`toJSONSchema` may describe a `z.preprocess` by its input rather than its output type, which would
publish a parameter shape the docs page cannot exercise — and US3's whole point is that the
published description tells the truth. If it renders wrongly, the fallback is an explicit
`.meta({ ... })` override on that one field declaring `type: array` with `style: form`,
`explode: true`; the Zod schema keeps its runtime behaviour either way.

**Alternatives rejected**:

- Comma-separated single value (`?platform=instagram,bluesky`) — renders cleanly in OpenAPI but
  invents an encoding for a thing the query string already encodes, and puts a split-and-trim
  parser in the request path that then has its own edge cases (empty segments, whitespace).
- A hand-written `z.enum([...])` of the three comment-capable platforms — it would have to be
  edited every time a platform is added, which is precisely the "adding a platform must not change
  the API" rule (Principle IV; feature 001's SC-009) being broken by a literal.

---

## R-03 — Boolean query parameters (`topLevelOnly`, `isOwn`)

**Decision**: `'true'` / `'false'` string enums transformed to booleans, following the precedent
`accountCommentsQuerySchema.isOwn` already sets and for the same documented reason —
`z.coerce.boolean()` treats every non-empty string as `true`, so the literal string `'false'`
would read as `true`. Absent means "no filter", not `false`.

`topLevelOnly=true` maps to `parent_comment_id IS NULL`. It is this service's own parameter, not a
borrowed one (spec Assumptions): it preserves the "a post's page is its top level" reading that
`GET /v1/posts/:postId/comments` used to give for free, and it is the predicate that keeps the
existing partial index `comments_post_top_level_idx` reachable from the collection.

`topLevelOnly=true` combined with `parentCommentId` is accepted and yields an empty page
(clarification session 2026-09-14, FR-002): filters intersect, and an intersection that no row can
satisfy is a valid question with an empty answer. Implementing it as an intersection rather than
special-casing it is also what makes this true without a branch — the two predicates are simply
`AND`ed, and Postgres returns nothing.

---

## R-04 — One repository method, one predicate builder, a planner-chosen index

**Decision**: `CommentRepository`'s three list methods (`listTopLevelByPost`,
`listRepliesByParent`, `listByAccount`) are replaced by one `list(workspaceId, filters,
pagination)`. The existing shared `listByPredicate` keyset machinery is kept verbatim; what changes
is that its `basePredicate` is now built by appending one condition per present filter instead of
by three hand-written callers.

No code chooses an index. `workspace_id = $1` is always in the predicate (D20 — every repository
call is workspace-scoped), the other conditions are added only when their filter is present, and
Postgres's planner picks the access path. The predicate a caller sends for the post's top level is
character-for-character the one `listTopLevelByPost` sent.

**Predicate identity is necessary but not sufficient for plan identity**, and FR-013's second half
is about the plan. This change adds `comments_workspace_idx (workspace_id, occurred_at DESC,
id DESC)`, which is a new candidate for precisely the three preserved reads: each carries the
`workspace_id` equality it leads with, and each orders by the tuple it already supplies, so the
planner may prefer it — most easily on the small datasets an integration test seeds, where a
narrower index's advantage is within noise of the statistics. Nothing here is broken by that; it is
simply not something to assume. Each preserved read therefore gets an `EXPLAIN` assertion naming the
index it expects (`comments_post_top_level_idx`, `comments_replies_idx`,
`comments_social_account_idx`), and the unfiltered listing one naming `comments_workspace_idx`. A
flip becomes a red test and a conscious decision rather than a silent regression.

**Rationale**: a hand-written "if `postId` and `topLevelOnly` then use the post index" dispatch is
a second copy of the planner's job that goes stale the moment an index is added or a filter is
introduced, and it cannot be tested other than by checking the plan — which is what an `EXPLAIN`
assertion does directly and better.

**Alternatives rejected**:

- Keeping three repository methods and choosing between them in the use case — the combination
  matrix (post × parent × account × platform × topLevelOnly × time × isOwn) has no three-way split;
  any such dispatch would have a fall-through case that is the general builder anyway.
- A database view or a materialized projection per filter — new storage to keep in sync for a read
  that one index already serves.

---

## R-05 — The index set: one new index, and one gap deliberately left open

**Decision**: add exactly one index —

```
comments_workspace_idx  ON comments (workspace_id, occurred_at DESC, id DESC)
```

— and change none of the five that exist. It is what makes the unfiltered listing's cost follow the
requested page rather than the workspace's history (FR-013, SC-005): the `ORDER BY` matches the
index's column order exactly in both directions, so the scan stops after `limit + 1` rows instead
of sorting the workspace.

**The visibility predicate is deliberately not in the index.** `visibleInList()` —
`status <> 'deleted' OR reply_count > 0` (FR-007) — is applied as a residual filter on the rows the
index scan produces. A partial index carrying that predicate was considered and rejected: it would
couple the index to a visibility rule that is a product decision rather than a storage one, and the
rows it would exclude are deleted comments with no replies, which the retention purge removes
anyway. If a workspace ever accumulates enough of them to matter, the SC-005 harness (R-10) is what
would show it, and the fix is a one-line schema change made on evidence.

**The gap, stated rather than hidden**: filtering by `postId` *without* `topLevelOnly` — a post's
whole thread, replies included — has no index leading on `post_id`, because
`comments_post_top_level_idx` is partial on `parent_comment_id IS NULL`. That read degrades to an
ordered walk of `comments_workspace_idx` with `post_id` as a residual filter. The same is true of a
`platform`-only or `isOwn`-only filter. This is left as it is on purpose:

- FR-013 states a performance requirement for the unfiltered listing and for the three reads the
  removed routes served. None of these is either.
- An index per filter combination is the premature optimization the project's own guidelines
  forbid, and the combinations are a power set.
- The trigger for revisiting is named and cheap: the R-10 harness measures any selection, so a
  future index is added against a measurement rather than an intuition.

**What adding an index costs the reads that already had one.** `comments_workspace_idx` is not inert
for the three preserved reads: it leads with the `workspace_id` equality each of them carries and
supplies the ordering each of them asks for, so it competes with their narrower indexes rather than
ignoring them. The write cost of one more index on `comments` is accepted as the price of FR-001;
the read risk is not accepted on trust but asserted, one `EXPLAIN` per preserved read naming the
index it expects (R-04).

---

## R-06 — One default sort direction, which changes the replies default

**Decision**: the collection's `order` defaults to `desc` for every selection. There is no
filter-dependent default.

**This is a visible behaviour change and D31 records it**: `GET /v1/comments/:commentId/replies`
defaulted to `asc` (D27, §6.1), because a reply thread reads oldest-first. The collection has one
default because it has one address, and `desc` is the one US1 needs — "what was said to us
recently" is the journey the feature exists for. A caller reading a thread asks for `order=asc`
explicitly, which is exactly what the spec's own acceptance scenario 2.2 describes.

**Alternative rejected**: defaulting to `asc` when `parentCommentId` is present. It would make the
default depend on a filter, so the same cursor-bearing client would silently change direction by
adding or removing an unrelated filter — and D27's cursor carries its `order`, so the next page
would then fail as an order mismatch. A default that can invalidate the caller's own cursor is
worse than an explicit parameter.

---

## R-07 — Resolving tenancy for identifier-shaped filters

**Decision**: each identifier-shaped filter is resolved before the query runs, against the owner of
that identifier, and a resolution that lands outside the caller's workspace is `404 NOT_FOUND`
(D20, FR-004):

| Filter | Resolved through | Why there |
|--------|------------------|-----------|
| `postId` | `Posts` port (platform-core) | posts belong to the publishing service (D8) |
| `accountId` | `Accounts` port (platform-core) | accounts belong to the accounts service (D8) |
| `parentCommentId` | this service's own `CommentRepository.getById` | comments are this service's own rows |

Resolution is a port call, never a join (Principle II, D29) — the same shape `listPostComments` and
`listAccountComments` already use.

**With no identifier-shaped filter present, no port is called at all** (FR-005). This is not an
optimization, it is the property that makes US1 reachable: a caller holding only an API key must be
able to read the workspace's comments without this service asking another service anything. It is
observable, so it is tested with a spy on the ports rather than asserted in prose.

**Why `404` and not an empty page**: an empty success for a foreign identifier would confirm that
the identifier is well-formed and merely empty, which is the information D20's `404`-not-`403` rule
exists to withhold (spec acceptance 2.5).

---

## R-08 — The `sync` block appears exactly when a post is named

**Decision**: the response carries `sync: { lastSyncedAt, activeJobId }` if and only if the
selection includes `postId`, whichever other filters accompany it (FR-006, clarification session
2026-09-14). The field is **absent**, not `null`, when no post is named.

**Rationale**: refresh freshness is a property of a post, and a selection spanning many posts has no
single answer to report. Keying it to "a post is named" rather than to "the post filter stands
alone" makes it a biconditional: adding a future filter cannot reopen the question.

**Implementation note**: absent-not-null means the response schema declares the field optional and
the handler builds the object with a conditional spread — under
`exactOptionalPropertyTypes`, `{ sync: undefined }` and `{}` are different types, and only the
latter serializes to an absent key.

**Alternative rejected**: always present, `null` when no post is named. It reads as "this post has
never been refreshed" for a selection that names no post — a false statement rather than a missing
one.

---

## R-09 — Publishing the API-key scheme, with one source of truth for the exemptions

**Decision**: the OpenAPI document declares one security scheme and applies it globally; the
exempt routes clear it per-operation, and the exempt list is read from **`PUBLIC_ROUTES` in
`src/modules/comments/http/auth.ts`** — the same array the `onRequest` hook enforces (FR-012).

```
components.securitySchemes.apiKey = { type: 'apiKey', name: 'blotato-api-key', in: 'header' }
security = [{ apiKey: [] }]                       // global default
```

The per-operation override is wired through `@fastify/swagger`'s `transform` hook, which receives
`{ schema, url, route }` — `route.method` plus `url` is exactly the `(method, path)` pair
`isPublicRoute` already takes. The existing `jsonSchemaTransform` from `fastify-type-provider-zod`
is wrapped rather than replaced, so Zod remains the single source of the schemas (R-03 of the 001
plan) and the exempt list remains the single source of the exemptions.

**Four of the six exempt routes are not operations at all.** `PUBLIC_ROUTES` holds six entries, but
`GET /webhooks/meta`, `POST /webhooks/meta` and `GET /openapi.json` are registered with
`schema: { hide: true }`, and `/docs` is served by the Swagger UI plugin — none of them reaches the
`transform` hook, and none appears in the document. The operations this actually clears are
`GET /healthz` and `GET /readyz`.

Deriving the annotation from the exempt array alone would therefore produce a set the document can
never match, and re-typing the two published names next to the array would recreate the drift FR-012
exists to remove. So each entry gains a **`published: boolean`** field: the annotation and the test
both derive from `PUBLIC_ROUTES.filter(r => r.published)`, and hiding or publishing a route is one
reviewable edit in one place. Publishing the webhook operations was considered and rejected — they
carry no request schema a reviewer could exercise, they authenticate by signature rather than by
key, and publishing them would widen feature 001's surface for no reviewer benefit; acceptance
scenario 3.3 is narrowed to the two probes to match (spec Assumptions).

**Constraint this places on `PUBLIC_ROUTES`**: its `matches` predicates are applied to OpenAPI path
templates as well as to request paths. Every current entry is a literal path, so the two coincide.
A future exempt route carrying a path parameter would need its entry to match `/v1/x/:id` rather
than a concrete id — noted here because the coupling is easy to break silently.

**Alternatives rejected**:

- Writing `security: []` by hand into each exempt route's schema — three hand-kept copies of the
  exempt list, which is the drift FR-012 names.
- `transformObject`, post-processing the rendered document — it works, but it matches on the
  rendered path strings instead of on the route's own `(method, url)`, adding a second translation
  step between the enforced list and the described one for no gain.
- Marking the whole document `security: []` and annotating only the authenticated routes — the
  failure mode inverts: a route added without an annotation would be published as public while
  being enforced as authenticated. Global-plus-exemptions fails closed, the same way the auth hook
  itself does.

---

## R-10 — Measuring SC-005 on demand, not in CI

**Decision**: a standalone script, `scripts/bench-listing.ts`, seeds two workspaces whose comment
histories differ by a factor of ten, issues the unfiltered listing against both at equal page size,
and reports the p95 of each plus the ratio. Its result is recorded in `DESIGN.md`. It is **not** a
CI step and **not** a vitest assertion.

**Rationale**: the spec's own Assumptions say why the criterion is a ratio and not a millisecond
threshold — an absolute time is a property of the machine, while the ratio is the property the
requirement is about. The same reasoning excludes it from CI: timing on a shared runner is too
noisy to gate on, and a flaky gate gets disabled, after which nothing measures anything.

**Relationship to the existing benchmark**: `src/modules/comments/http/benchmark.integration.test.ts`
makes a different claim — a *structural* one, via `EXPLAIN`, that a specific predicate still chooses
a specific index — and that claim is cheap and deterministic enough to gate on. The new script
complements it by measuring the thing `EXPLAIN` cannot see: that the chosen plan's cost really does
follow the page and not the history. The `EXPLAIN` assertions belong in the existing test; the
timing ratio belongs in the script.

**The one thing that file already gates on and this reasoning does not endorse**: it also asserts
`p95 < READ_BUDGET_MS` and `p95 < WRITE_BUDGET_MS`, absolute thresholds, in CI — exactly what the
paragraph above rejects. Those are feature 001's and stay, because they are generous
single-machine budgets sized to catch a collapse rather than a regression, and removing a working
guard is not this feature's business. They are not a precedent: SC-005 is a *ratio between two runs*,
which is only meaningful if both runs happen on the same machine under comparable load, and a shared
CI runner guarantees neither. That difference, not squeamishness about timing, is why the new
measurement is a script.

---

## R-11 — What happens to the replaced code

**Decision**: the three use cases (`list-post-comments.ts`, `list-replies.ts`,
`list-account-comments.ts`), the three repository methods, the three route registrations and the
per-route query schemas are **deleted**, and one `list-comments.ts` use case takes their place. No
re-export, no thin wrapper, no `@deprecated` marker (constitution: replace, don't deprecate; FR-009).

Their integration tests (`post-comments.integration.test.ts`, `replies.integration.test.ts`,
`inbox.integration.test.ts`) are rewritten to drive the collection rather than deleted — each one
already encodes a behaviour FR-002 preserves, and rewriting them is how SC-002 ("every read
previously served is reproducible") is demonstrated rather than asserted. Each also gains the
assertion that its old address now answers `404`, which Fastify's existing `setNotFoundHandler`
provides with no new code (acceptance 2.6).

`benchmark.integration.test.ts` references `listTopLevelByPost`'s predicate directly and is updated
in the same change.

Downstream documents that name the removed addresses and must move with them: `README.md` (the
reviewer walkthrough, which FR-015 requires to start from an identifier-free request),
`scripts/smoke.ts` + `scripts/smoke-checks.ts`, `openapi.json` (regenerated),
`specs/001-multi-platform-comments/contracts/rest-api.md`, and `DESIGN.md` (FR-014's reasoning, and
the R-10 measurement). The root `spec.md` §6.1 table and §18 are updated **first**, before the code
(Principle I).

One correction rides along, recorded in the spec's Assumptions: the 001 route contract claims rate
limits are keyed by internal post identifier. The code keys them by read/write bucket and API key
(`src/app/api.ts`, `keyGenerator`). The document is corrected to the code.
