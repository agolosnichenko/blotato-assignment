# Tasks: Workspace-wide comment listing and authenticated API docs

**Feature**: `002-flat-comment-listing` | **Date**: 2026-09-14

**Input**: Design documents from `/specs/002-flat-comment-listing/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/rest-api.md](./contracts/rest-api.md),
[quickstart.md](./quickstart.md)

**Tests**: included. The constitution's Principle V ("Tested Behavior, Verified Failures") and
`quickstart.md` V1–V8 require them; every invariant this feature adds is silent when broken.

**Organization**: grouped by user story. US1 and US2 share one route and one repository method, so
they are split by **predicate**: US1 builds the collection with the workspace scope and the keyset
alone (its Independent Test is a request carrying no identifier at all); US2 grows the predicate
builder by the eight remaining conditions — the seven filters of FR-002, with the time range
contributing a bound at each end — and removes the three nested routes. US3 touches neither and can
start as soon as Phase 1 is done.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: `US1`, `US2`, `US3` — maps to the user stories in `spec.md`

## Path Conventions

Single project, repository root: `src/`, `scripts/`, `drizzle/`. Tests are colocated
(`*.integration.test.ts` next to the code they cover), per the existing layout.

---

## Phase 1: Setup

**Purpose**: the record comes first (Principle I, FR-014).

- [ ] T001 Verify root `spec.md` carries **D31** in §18 and the revised endpoint table in §6.1
      (three nested read rows removed, `GET /v1/comments` added), and commit that edit **on its own,
      before any source change**, with `per D31` in the commit body — Principle I, FR-014. The
      working tree already holds these edits; this task is to confirm they are complete and land
      them as the first commit of the feature.

**Checkpoint**: the specification of record describes the API the code is about to implement.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the storage access path and the repository seam both US1 and US2 build on.

**⚠️ CRITICAL**: US1 and US2 cannot begin until this phase is complete. **US3 does not depend on it**
and may start immediately after Phase 1.

- [ ] T003 Add `index('comments_workspace_idx').on(table.workspaceId, table.occurredAt.desc(),
      table.id.desc())` to the `comments` table definition in
      `src/modules/comments/infrastructure/schema.ts`, next to the five existing indexes. Exactly
      `(workspace_id, occurred_at DESC, id DESC)` — the column order the keyset scan needs
      (data-model.md §1). Add no column, no table and no foreign key.
- [ ] T004 Generate the migration with `pnpm db:generate` and commit the resulting single
      `CREATE INDEX` file under `drizzle/` plus its `drizzle/meta/` snapshot. Verify the generated
      SQL contains only `CREATE INDEX` — no `DROP`, no `ALTER TABLE ... ADD COLUMN`, no rewrite.
- [ ] T005 Define the selection value type in
      `src/modules/comments/infrastructure/comment-repository.ts`, replacing `ListByAccountFilters`:
      `CommentSelection` with all-optional `postId?: string`, `parentCommentId?: string`,
      `accountId?: string`, `platforms?: readonly string[]`, `topLevelOnly?: boolean`,
      `isOwn?: boolean`, `since?: Date`, `until?: Date`. Each key is **omitted** when the filter is
      absent, never set to `undefined` — `exactOptionalPropertyTypes` is on (plan.md Technical
      Context). `workspaceId` is not a field: it is the method's own first parameter (D20).
- [ ] T006 Add `list(workspaceId: WorkspaceId, selection: CommentSelection, pagination:
      ListPagination): Promise<ListResult>` to the `CommentRepository` interface in
      `src/modules/comments/infrastructure/comment-repository.ts`. Leave
      `listTopLevelByPost`/`listRepliesByParent`/`listByAccount` in place for now — US2 removes them
      once every caller is gone (data-model.md §4).
- [ ] T007 Implement a `selectionPredicate(workspaceId, selection): SQL` helper in
      `src/modules/comments/infrastructure/comment-repository.ts` that starts from
      `eq(comments.workspaceId, workspaceId)` and `AND`s one condition per **present** key, then
      wire `list` to pass it to the existing `listByPredicate`. In this phase handle the workspace
      scope only; US2's T02x extends the same function. No branch may choose an index or a query
      shape — the planner picks the access path (R-04). `visibleInList()` and the keyset comparison
      stay inside `listByPredicate`, untouched (FR-007, D27).

**Checkpoint**: one workspace-scoped list method exists on the repository; no route uses it yet.

---

## Phase 3: User Story 1 — Moderate everything that arrived in the workspace (Priority: P1) 🎯 MVP

**Goal**: `GET /v1/comments` answers with the workspace's comments across every connected account
and every post, newest first, for a caller holding nothing but an API key.

**Independent Test**: call the collection with no parameters using a workspace's API key; the
response holds that workspace's most recent comments across every account and post, and paging
forward with the returned cursor walks the whole history without repeating or skipping an entry.

### Tests for User Story 1 ⚠️

> Write these first and confirm they fail before implementing T013–T016.

- [ ] T008 [P] [US1] Create `src/modules/comments/http/list-comments.integration.test.ts` covering
      quickstart V1: two seeded accounts both appear in one unfiltered page; a third workspace's
      comments never do; the page is ordered newest first; an empty workspace answers
      `200 { items: [], nextCursor: null }` rather than an error.
- [ ] T009 [P] [US1] In the same file, assert FR-005 as a behaviour: register the `Posts` and
      `Accounts` ports as spies and assert **neither is called** on an identifier-free request.
- [ ] T010 [P] [US1] In the same file, assert FR-008 / acceptance 1.4: seed a comment whose `postId`
      is absent from the platform-core projection **by deleting the projection row**, not by nulling
      the comment's `postId`, and assert the comment is still returned.
- [ ] T011 [P] [US1] In the same file, assert FR-006's negative half: `'sync' in body === false` for
      an identifier-free request — absent, not `null` (R-08).
- [ ] T012 [P] [US1] In the same file, assert SC-003 (quickstart V2): walk a seeded history to
      exhaustion at `limit=5`, inserting new comments between pages, and assert the multiset of
      returned ids equals the seeded set — no duplicate, no gap. Run it for `order=desc` and
      `order=asc`. Assert `limit=0`, `limit=101`, a truncated cursor, and a `desc` cursor replayed
      with `order=asc` are each `400 VALIDATION_ERROR`.

### Implementation for User Story 1

- [ ] T013 [US1] Add `listCommentsQuerySchema` to `src/modules/comments/http/schemas.ts`, built on
      `paginationQuerySchema('desc')` — `limit` integer `1..100` default `20`, `cursor` optional
      opaque string, `order` `'asc' | 'desc'` **default `desc` for every selection** (R-06, D31).
      Filters arrive in US2's T021; this task establishes the schema and its default.
- [ ] T014 [US1] Extend `commentsPageSchema` in `src/modules/comments/http/schemas.ts` with an
      **optional** `sync: { lastSyncedAt: string | null, activeJobId: string | null }`, and leave
      `postCommentsPageSchema` in place until US2 removes its last caller. The field must be
      optional in the Zod schema so the serialized body can omit the key entirely (R-08).
- [ ] T015 [US1] Create `src/modules/comments/application/list-comments.ts`: one use case that takes
      `{ workspaceId, selection, limit, cursor, order }`, calls `repository.list` **once**, and
      returns `{ items, nextCursor }`. It contains no branch that chooses a query shape (plan.md
      "list-comments.ts is one use case, not a dispatcher"). Port resolution and the `sync` block
      arrive in US2.
- [ ] T016 [US1] Register `GET /v1/comments` in `src/modules/comments/http/routes.ts` as a
      `registerListCommentsRoute` function inside `registerCommentReadRoutes`, using
      `listCommentsQuerySchema` and `commentsPageSchema`, reusing the existing `parseCursor` helper
      and `encodeCursor`. Leave the three nested read routes registered — US2 removes them. Confirm
      it does not collide with `GET /v1/comments/:commentId` (R-01).
- [ ] T017 [US1] Rework the structural half of
      `src/modules/comments/http/benchmark.integration.test.ts` (quickstart V7). The file today holds
      **one** `EXPLAIN` assertion — `explainTopLevelQuery`, the post's top level — and its
      `assertPlanUsesIndex` helper checks only that *some* node type contains `Index`, without
      naming which. That is not enough once `comments_workspace_idx` exists: it leads with the
      `workspace_id` equality all four selections carry and supplies their ordering, so it is a new
      candidate for the three preserved reads and a flip to it would leave an unnamed assertion
      green (R-04, R-05). Therefore:
      (a) generalize `explainTopLevelQuery` into a helper taking a predicate, and tighten
      `assertPlanUsesIndex` to take the **expected index name**, asserting that name appears on an
      index node, that no `Seq Scan` appears, and that no `Sort` node appears;
      (b) keep the existing post assertion, now pinned to `comments_post_top_level_idx`;
      (c) add three more, over the exact predicates the collection runs, pinned to
      `comments_replies_idx` (`parentCommentId`), `comments_social_account_idx` (`accountId`) and
      `comments_workspace_idx` (no filter at all — `workspace_id` plus the `visibleInList` residual).
      The file's existing absolute p95 budgets are feature 001's and stay untouched (R-10).
- [ ] T018 [P] [US1] Create `scripts/bench-listing.ts`: seed two workspaces whose comment histories
      differ by a factor of ten, issue the unfiltered listing against both at equal page size, print
      the p95 of each and their ratio, and exit non-zero when the ratio exceeds **1.5** (SC-005,
      R-10). Follow the existing `scripts/smoke.ts` + `scripts/script-failure.ts` conventions. It is
      **not** a vitest test and **not** a CI step.
- [ ] T002 [P] [US1] Add the `bench:listing` script (`tsx scripts/bench-listing.ts`) to the `scripts`
      block of `package.json`, alongside the existing `smoke` entry — the on-demand SC-005 harness
      (R-10). Listed here, out of numeric order, because a committed script entry must not precede
      the file it points at: do it with T018, not in Phase 1.

**Checkpoint**: US1 is fully functional and demonstrable — a caller with only an API key reads the
workspace's comment activity. The three nested routes still work; nothing is removed yet.

---

## Phase 4: User Story 2 — Narrow the same view to one thread, account, or platform (Priority: P2)

**Goal**: every read the three removed routes served is reproducible as a filter on the P1
collection, and those three addresses answer `404`.

**Independent Test**: for each filter, seed data that partly matches and partly does not, then check
that exactly the matching comments come back — and that the previously nested routes now answer
"not found".

### Tests for User Story 2 ⚠️

- [ ] T019 [P] [US2] Rewrite `src/modules/comments/http/post-comments.integration.test.ts`,
      `replies.integration.test.ts` and `inbox.integration.test.ts` to drive the collection
      (`?postId=:id&topLevelOnly=true`, `?parentCommentId=:id&order=asc`, `?accountId=:id`), keeping
      every original assertion, and add to each the assertion that its **old** address now answers
      `404` with `code: NOT_FOUND` in `application/problem+json` (quickstart V3, acceptance 2.6,
      FR-009). Seed data that partly matches and partly does not for every filter, so a silently
      ignored filter fails the test rather than passing it. Three files, one per old route.
- [ ] T020 [P] [US2] Extend `src/modules/comments/http/list-comments.integration.test.ts` with the
      filter semantics: `platform=instagram&platform=bluesky` returns the union;
      `platform=tiktok` is accepted and returns nothing; `platform=nonsense` is `400`;
      `topLevelOnly=true` together with `parentCommentId` is an empty `200`, **not** `400`
      (clarification 2026-09-14, FR-002); a `postId` with a parent on a different post is an empty
      `200`; `since` later than `until` is an empty `200`; `isOwn=false` is honoured as `false` and
      not coerced to `true`; a caller's own `queued`/`processing`/`failed` comments appear; and
      `sync` is **present** for `?postId=…&platform=instagram` (quickstart V4, FR-006).
      Assert the negative half on an identifier-shaped selection too: `'sync' in body === false` for
      `?accountId=…` and for `?parentCommentId=…`. T011 only covers the identifier-free request, and
      a condition written as "an identifier filter is present" rather than "a post is named" passes
      T011 and fails FR-006 (acceptance 2.4, R-08).
- [ ] T021 [P] [US2] Update `src/modules/comments/http/tenancy.integration.test.ts`: drop the three
      per-endpoint rows for the removed routes and add one case per identifier-shaped filter
      (`postId`, `accountId`, `parentCommentId`) asserting `404` with `code: NOT_FOUND` for a
      resource in another workspace — never `403`, never an empty `200` (SC-004, FR-004, D20,
      quickstart V5).

### Implementation for User Story 2

- [X] T022 [US2] Extend `listCommentsQuerySchema` in `src/modules/comments/http/schemas.ts` with
      every filter, all optional: `postId` `z.uuid()`, `parentCommentId` `z.uuid()`, `accountId`
      `z.uuid()`, `since`/`until` `z.iso.datetime()` (inclusive bounds on `occurredAt`),
      `topLevelOnly` and `isOwn` as `z.enum(['true','false']).transform(v => v === 'true')` — **not**
      `z.coerce.boolean()`, which reads the literal `'false'` as `true` (R-03).
- [X] T023 [US2] Add the repeatable `platform` parameter to the same schema: normalize
      `string | string[]` to an array before validation (Fastify's `node:querystring` parser yields
      one or the other), then validate each value against **the keys of
      `src/platforms/registry.ts`**, never a hand-written literal union — an unknown platform is
      `400`, a known but comment-less platform (`tiktok`) is accepted and matches nothing (R-02,
      Principle IV).
- [X] T024 [US2] **Verify, do not assume** (plan.md "Unresolved"): run `pnpm generate-openapi` and
      inspect how `fastify-type-provider-zod@7` renders T023's normalization. If the parameter is
      published by its *input* type rather than as an array, apply the named fallback — an explicit
      `.meta({ type: 'array', style: 'form', explode: true })` override on that one field, leaving
      the Zod runtime behaviour unchanged (R-02). Record which branch was taken in `DESIGN.md`.
- [X] T025 [US2] Extend `selectionPredicate` in
      `src/modules/comments/infrastructure/comment-repository.ts` with one `AND`ed condition per
      present key: `eq(postId)`, `eq(parentCommentId)`, `eq(socialAccountId)`,
      `inArray(platform, platforms)`, `isNull(parentCommentId)` for `topLevelOnly === true`,
      `eq(isOwn)`, `gte(occurredAt, since)`, `lte(occurredAt, until)`. Filters intersect: no
      condition overrides, disables or special-cases another, and an unsatisfiable combination
      returns an empty page rather than an error (FR-002, R-03).
- [X] T026 [US2] Add identifier resolution to
      `src/modules/comments/application/list-comments.ts`, **before** the query runs and only for
      the filters actually present: `postId` through the `Posts` port, `accountId` through the
      `Accounts` port, `parentCommentId` through `repository.getById`. Anything outside the caller's
      workspace throws `404 NOT_FOUND` — never `403`, never an empty success (R-07, FR-004, D20).
      A port call is never a join (Principle II, D29).
- [X] T027 [US2] Add the conditional `sync` block to the same use case: call
      `repository.getSyncStatus(workspaceId, postId)` **if and only if the selection names a post**,
      whichever other filters accompany it, and build the response object with a conditional spread
      so `{}` — not `{ sync: undefined }` — is produced when no post is named (FR-006, R-08).
- [X] T028 [US2] Wire the filters through `GET /v1/comments` in
      `src/modules/comments/http/routes.ts`: map the validated query to `CommentSelection`, omitting
      each absent key rather than passing `undefined`, and convert `since`/`until` to `Date`.
- [X] T029 [US2] Remove the three nested read route registrations from
      `src/modules/comments/http/routes.ts` — `registerPostCommentsRoute`, `registerRepliesRoute`,
      `registerAccountCommentsRoute` — with no alias, no redirect and no compatibility shim
      (FR-009, R-11). `POST /v1/posts/:postId/comments` and `POST /v1/comments/:commentId/replies`
      keep their addresses; the collisions are method-level only. Also drop the now-unused
      `postCommentsQuerySchema` / `repliesQuerySchema` locals.
- [X] T030 [US2] Delete `src/modules/comments/application/list-post-comments.ts`,
      `list-replies.ts` and `list-account-comments.ts`, and remove their imports from `routes.ts`.
      No re-export, no thin wrapper, no `@deprecated` marker (R-11, constitution: replace, don't
      deprecate).
- [X] T031 [US2] Delete `listTopLevelByPost`, `listRepliesByParent` and `listByAccount` — interface
      declarations and implementations — plus the `accountCommentsQuerySchema` and
      `postCommentsPageSchema` exports in `src/modules/comments/http/schemas.ts`, once T029 and T030
      leave them with no caller. Update the repository's file-header doc comment, which currently
      names the three methods and their indexes, to describe the one `list` and the planner-chosen
      access path (R-04).
- [X] T032 [P] [US2] Update `specs/001-multi-platform-comments/contracts/rest-api.md`: remove the
      three read routes it still documents and correct its rate-limiting claim — limits are keyed by
      read/write bucket and resolved API key id (`src/app/api.ts`, `keyGenerator`), not by internal
      post identifier (spec Assumptions, R-11).

**Checkpoint**: every read the service offered is reachable through the one collection, the three
nested addresses are gone, and tenancy holds on each filter.

---

## Phase 5: User Story 3 — Authenticate inside the interactive docs (Priority: P3)

**Goal**: the published OpenAPI document declares the API-key scheme the service enforces, so the
Swagger UI at `/docs` can authorize and invoke.

**Independent Test**: open the docs page, confirm an authorization control is offered, supply a
valid key, invoke the comment collection from the page, and receive data rather than `401`.

**Dependency note**: independent of Phases 2–4. It may start as soon as Phase 1 is done.

### Tests for User Story 3 ⚠️

- [ ] T033 [P] [US3] Create `src/modules/comments/http/openapi-security.integration.test.ts`
      (quickstart V6, machine-readable half): `components.securitySchemes.apiKey` equals
      `{ type: 'apiKey', name: 'blotato-api-key', in: 'header' }`; the document's global `security`
      requires it; the set of operations carrying `security: []` is **computed in the assertion from
      `PUBLIC_ROUTES.filter(r => r.published)`** rather than re-typed, so adding a published exempt
      route without publishing its exemption fails the test (FR-012). Assert the other direction as
      well: **no** operation exists for any entry with `published: false` — four of the six entries
      are unpublished (both webhooks and `/openapi.json` are `hide: true`, `/docs` is plugin-served),
      so a route flipped to visible without flipping its flag fails too. Finally, every published
      registered route appears in the document and every documented path is a registered route
      (SC-007), and every endpoint FR-010 requires to keep its address is present under that address.

### Implementation for User Story 3

- [ ] T034 [US3] Export `PUBLIC_ROUTES` and `isPublicRoute` from
      `src/modules/comments/http/auth.ts`, and add a required `published: boolean` field to the
      `PublicRoute` type and to all six entries: `true` for `GET /healthz` and `GET /readyz`, `false`
      for `GET|POST /webhooks/meta` and `GET /openapi.json` (registered `schema: { hide: true }`) and
      for the `/docs` assets (served by the Swagger UI plugin). Making the field required is the
      point — a new exempt route cannot be added without answering the question, which is what keeps
      the enforced and the described lists one list (FR-012, R-09). Document the other constraint
      R-09 names: the `matches` predicates are now applied to **OpenAPI path templates** as well as
      request paths. Every current entry is a literal path, so the two coincide; a future exempt
      route carrying a path parameter must match `/v1/x/:id` rather than a concrete id.
- [ ] T035 [US3] In `src/app/api.ts`, add to the `@fastify/swagger` registration:
      `components.securitySchemes.apiKey = { type: 'apiKey', name: 'blotato-api-key', in: 'header' }`
      and a global `security: [{ apiKey: [] }]`. Global-plus-exemptions, never the inverse — a route
      added without thought is then published as authenticated, matching how the auth hook itself
      fails closed (R-09).
- [ ] T036 [US3] In the same file, replace `transform: jsonSchemaTransform` with a wrapper that
      calls `jsonSchemaTransform` first and then sets `security: []` on the operation when
      `isPublicRoute(route.method, url)` is true. `@fastify/swagger`'s `transform` hook receives
      `{ schema, url, route }`, so `route.method` plus `url` is exactly the pair `isPublicRoute`
      takes. Wrap, never replace — Zod stays the single source of the schemas (R-09). The operations
      this actually clears are `GET /healthz` and `GET /readyz` — and only those two: the hook never
      sees the other four exempt routes, because both `/webhooks/meta` operations and
      `/openapi.json` are registered `schema: { hide: true }` and the `/docs` assets are served by
      the UI plugin (acceptance 3.3, spec Assumptions). `isPublicRoute` may therefore stay as it is;
      it is T033 that reads the `published` flag, since only the test needs to know which exempt
      routes the document should be missing.
- [ ] T037 [US3] Manually walk quickstart V6 in a browser with no terminal open: `$BASE/docs` offers
      an **Authorize** control naming `blotato-api-key` as a header; after pasting the demo key,
      "Try it out" on `GET /v1/comments` returns data rather than `401`; `GET /healthz` and
      `GET /readyz` show as requiring no key, and the two `/webhooks/meta` operations are absent from
      the page altogether — the expected result, not a gap (acceptance 3.3). The demo key is
      delivered out of band and never committed (D25).

**Checkpoint**: a reviewer who has never seen the service can authenticate in the docs and read
comments from the browser.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T038 [P] Rewrite the `README.md` curl walkthrough to **start** at
      `GET /v1/comments` with no identifier at all, then drill down with filters — an identifier-free
      first step is the property FR-015 names.
- [ ] T039 [P] Update `scripts/smoke.ts` and `scripts/smoke-checks.ts` to follow the same order:
      the identifier-free listing first, then the filtered reads that replace the removed routes
      (FR-015, quickstart V9). Update `scripts/smoke.test.ts` alongside them.
- [ ] T040 [P] Write the reasoning FR-014 and SC-008 require into `DESIGN.md`: why reads are one
      filtered collection (the missing cross-account inbox — explicitly **not** discoverability),
      why writes stay addressed to their target, why `topLevelOnly` exists as a filter, and why the
      refresh command stays addressed to a post. A reader must be able to state it without asking
      the author.
- [ ] T041 Run `pnpm bench:listing` and record the two p95 figures, their ratio and the machine in
      `DESIGN.md` (SC-005, R-10). Pass is ratio ≤ 1.5; a genuinely bounded listing measures near
      1.0, and a result near the limit is itself the signal that it is not.
- [ ] T042 Perform the three deliberate breaks of quickstart V8 and confirm each turns a test red
      before reverting: (a) drop `workspace_id` from the list predicate → T008's cross-workspace
      assertion and every T021 case; (b) resolve `postId` through a join instead of the `Posts` port
      → T009's port-spy assertion and T021's post case; (c) hand-annotate `GET /readyz`'s
      `security: []` instead of deriving it from `PUBLIC_ROUTES`, and separately flip one
      `published: false` entry to `true` → T033's two derived-set assertions, one per direction.
- [ ] T043 Regenerate and commit the published description: `pnpm generate-openapi`, then
      `git diff --exit-code openapi.json` must be clean — the check CI runs (FR-011, D18).
- [ ] T044 Run the full gate before the final commit: `pnpm lint && pnpm format:check &&
      pnpm typecheck`, `pnpm test:unit`, `pnpm test:integration`. Warnings count as failures; fix
      every one rather than suppressing it.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies, and T001 is all of it — it must land as its **own commit,
  first** (Principle I). T002 keeps its id but is executed in Phase 3, beside the file it names.
- **Foundational (Phase 2)**: depends on Phase 1. Blocks US1 and US2. Does **not** block US3.
- **US1 (Phase 3)**: depends on Phase 2.
- **US2 (Phase 4)**: depends on US1 — it extends the schema, the predicate builder, the use case and
  the route that US1 creates.
- **US3 (Phase 5)**: depends on Phase 1 only. Can run concurrently with Phases 2–4.
- **Polish (Phase 6)**: depends on US1, US2 and US3.

### Within Each User Story

- Tests are written first and confirmed failing before the implementation tasks they cover.
- Schema → repository → use case → route. T031's deletions come last, once no caller remains.

### Parallel Opportunities

- **Across stories**: US3 (T033–T037) runs start to finish alongside Phases 2–4 — it shares no file
  with them (`src/app/api.ts` and `http/auth.ts` versus `http/routes.ts`, `http/schemas.ts` and the
  repository).
- **Phase 3**: T008–T012 all extend one new test file — write them together, in one pass, but they
  are one file, so they are marked `[P]` only in the sense of being independent of each other's
  implementation. T018 (`scripts/bench-listing.ts`) and T002 (its `package.json` entry) are
  genuinely separate files and run in parallel with T013–T017 — T002 after T018, never before.
- **Phase 4**: T019 touches three separate test files and T021 a fourth; T032 is a document. All
  four are independent of each other and of T022–T031.
- **Phase 6**: T038, T039 and T040 are three separate files.

### Parallel Example: User Story 2's test pass

```bash
Task: "Rewrite post-comments.integration.test.ts against ?postId=…&topLevelOnly=true, + 404 on the old address"
Task: "Rewrite replies.integration.test.ts against ?parentCommentId=…&order=asc, + 404 on the old address"
Task: "Rewrite inbox.integration.test.ts against ?accountId=…, + 404 on the old address"
Task: "Swap tenancy.integration.test.ts's three per-endpoint rows for the three identifier filters"
```

---

## Implementation Strategy

### MVP First (US1 only)

1. Phase 1 — the spec record lands first, on its own commit.
2. Phase 2 — the index, the migration, the repository seam.
3. Phase 3 — `GET /v1/comments`, unfiltered.
4. **Stop and validate**: quickstart V1 and V2 pass; the cross-account inbox, the journey the
   feature exists for, is reachable. The three nested routes still work, so nothing is broken for an
   existing caller.

### Incremental Delivery

1. MVP as above — demonstrable on its own.
2. US2 — filters land, the three routes are removed. This is the **breaking** increment (FR-009):
   it must ship as one change, since removing the routes and adding their replacement filters cannot
   be separated without leaving a reachable address behind.
3. US3 — the docs page authorizes. Independent of both; can ship before, between or after.
4. Polish — documentation, the SC-005 measurement, the deliberate breaks, the gates.

---

## Notes

- `[P]` means different files and no dependency on an incomplete task.
- Every commit cites its decision in the body (`per D31`); the commit that removes the three routes
  carries a `!` and a `BREAKING CHANGE:` footer.
- No task adds a table, a column, a foreign key or a SQL join across the service boundary (D8, D29).
  The only structural addition in the whole feature is one index.
- No task touches a write path, the outbox, the state machine or a platform adapter. No spike gates
  any part of this feature.
