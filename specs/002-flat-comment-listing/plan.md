# Implementation Plan: Workspace-wide comment listing and authenticated API docs

**Branch**: `002-flat-comment-listing` | **Date**: 2026-09-14 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-flat-comment-listing/spec.md`

> The repository-root `spec.md` remains the source of truth for decisions and assumptions. This
> feature introduces exactly one new decision — **D31** — which narrows root `spec.md`'s D11, D13,
> D27, A3, A10a and §6.1, and revises feature **001's** FR-001, FR-003, FR-006 and FR-008. It is
> recorded in `spec.md` §18 **before** any code diverges from it (Principle I, FR-014). Every other technical choice below is either carried over unchanged or
> recorded in [research.md](./research.md) with its rejected alternatives.

## Summary

Two independent problems, one change set.

The first is a missing journey: "every new comment across every account in the workspace" is the
moderation view the service is for, and no address reaches it — the only inbox is per account. Reads
are therefore collapsed into **one collection, `GET /v1/comments`**, where hierarchy is a filter
rather than an address, and the three nested read routes are removed outright. Writes are untouched
and stay addressed to their target: commands address, queries filter. The load-bearing requirement
is SC-001 — a caller holding nothing but an API key can read the workspace's comment activity in one
request — and the constraint that makes it real rather than cosmetic is FR-013/SC-005: that request's
cost must follow the requested page, not the workspace's history.

The second is that the interactive docs page has no way to supply a key, so every "Try it out"
answers `401`. The published OpenAPI document gains the API-key scheme the service already enforces,
applied globally and cleared on the handful of exempt operations — with the exempt list read from
the same array the authentication hook enforces, so the described and enforced lists cannot drift
(FR-012).

Approach: one repository method replaces three, building one `AND`ed predicate per present filter and
letting Postgres's planner choose the access path (R-04) — which is what keeps the three preserved
reads on the exact plans they have today. One new index, `(workspace_id, occurred_at DESC, id DESC)`,
serves the unfiltered listing. Tenancy for each identifier-shaped filter is resolved through the port
that owns it before the query runs, and with no such filter no port is called at all (FR-005).

## Technical Context

Unchanged from [001's plan](../001-multi-platform-comments/plan.md) except where stated; this section
records the deltas rather than repeating the stack.

**Language/Version**: TypeScript 7.0.2 on Node 22.20 LTS, ESM only, `strict` plus
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`. The last of these
is load-bearing here: FR-006's "absent, not null" `sync` block depends on `{}` and
`{ sync: undefined }` being different types (R-08).

**Primary Dependencies**: no addition and no removal. The feature is served by what is already
installed — Fastify 5, Drizzle 0.45, Zod 4, `fastify-type-provider-zod` 7, `@fastify/swagger` 9.8.1
(whose `transform` hook receives `{ schema, url, route }`, verified against the installed types) and
`@fastify/swagger-ui` 6.1.1.

**Storage**: PostgreSQL 18, unchanged schema plus **one** additive index
(`comments_workspace_idx`); one `drizzle-kit generate` migration. No table, no column, no foreign
key — in particular none across the service boundary (D8, D29). Redis is untouched.

**Testing**: vitest, same two projects. Three existing integration tests are rewritten to drive the
collection (`post-comments`, `replies`, `inbox`), `tenancy.integration.test.ts` swaps three
per-endpoint rows for the collection's three identifier filters, and
`benchmark.integration.test.ts` grows from **one** `EXPLAIN` assertion to four: the existing one
covers the post's top level only, and the replies read, the account inbox and the new unfiltered
listing each gain their own, every one of them naming the index it expects (R-04). One new
integration test covers the generated OpenAPI document's security annotations. One new on-demand
script, `scripts/bench-listing.ts`, measures SC-005 outside CI (R-10).

**Target Platform**: unchanged — Linux containers on Railway, `api` and `worker` from one image.

**Performance Goals**: SC-005 — at equal page size, the unfiltered listing's p95 on a history ten
times larger is at most 1.5× the smaller one's. Stated as a ratio because an absolute millisecond
figure is a property of the machine while the ratio is the property the requirement is about. The
three preserved reads must be no slower than today (FR-013). Their predicates are unchanged, which
is necessary but **not sufficient**: adding `comments_workspace_idx` gives the planner a new
candidate for exactly those queries, since it leads with the `workspace_id` equality every one of
them carries and already supplies their ordering. The claim is therefore asserted rather than
argued — one `EXPLAIN` per preserved read, each naming the index it expects (R-04).

**Constraints**: filters intersect and an unsatisfiable combination is an empty `200`, never a
`400` (FR-002); the refresh-freshness block appears iff a post is named (FR-006); a foreign
identifier in any filter is `404`, never `403` and never an empty success (FR-004, D20); with no
identifier filter, zero cross-service port calls (FR-005); a comment is readable even when its post
no longer resolves (FR-008); removal of the three routes leaves no reachable address (FR-009).

**Scale/Scope**: one region, unchanged; the new read spans a whole workspace rather than one post or
account, which is the reason the index and SC-005 exist at all.

**Unresolved**: none blocking implementation. One item needs verification *during* implementation
rather than assumption: how `fastify-type-provider-zod@7` renders the repeated-`platform`
normalization into the OpenAPI document, with a named fallback if it renders the input type (R-02).
No spike gates any part of this feature — nothing here touches Meta behaviour.

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1 design. Constitution v1.0.0.*

| Principle | How this plan satisfies it | Verdict |
|-----------|---------------------------|---------|
| **I. Spec Is the Source of Truth** | D31 is written into root `spec.md` §18, and §6.1's endpoint table updated, as the **first** change — before the route moves. The commit body cites it. Choices D31 does not fix are in `research.md`, not in code comments. No spike gates this work. | PASS |
| **II. Service Boundary Integrity** | No foreign key and no join is added; the collection reads only `comments`. `postId` and `accountId` filters resolve through the `Posts` and `Accounts` ports exactly as the removed routes did, and FR-005 makes the *absence* of a port call on the unfiltered path a tested behaviour. FR-008's "a comment outlives its post reference" is unchanged and re-asserted (quickstart V1). | PASS |
| **III. Never Double-Post** | Untouched. No write path, no queue, no state transition and no outbox usage is in scope; `POST` still returns `202 queued`. The listing gains no status filter, so pending writes remain visible under the existing rule alone. | PASS |
| **IV. Platform Differences Stay in Adapters** | The `platform` filter is a value match on this service's own column, validated against the **keys of the capability registry** rather than a hand-written union (R-02) — so adding a platform still changes no schema and no API. Nothing branches on platform or on `auth_variant`; the "known but comment-less platform matches nothing" edge case falls out of the data, not out of a case statement. | PASS |
| **V. Tested Behavior, Verified Failures** | `quickstart.md` maps every success criterion to the scenario that proves it, one tenancy test per identifier filter (SC-004), exact paging under concurrent inserts (SC-003), and three deliberate breaks (V8) — including one for the FR-012 exempt-list derivation, whose failure mode is silent by construction. Keyset paging and the direction-mismatch `400` are unchanged (D27). | PASS |

**Security and tenancy controls this feature touches**:

| Control | What it means concretely here |
|---------|-------------------------------|
| Tenancy (D20) | `workspace_id` is in the predicate of every list, and each identifier-shaped filter is resolved against its owner before the query. One test per filter, asserting `404` and not `403` or an empty `200` |
| Published auth | The OpenAPI document declares `blotato-api-key` as an `apiKey` header scheme, applied globally, cleared only on the **published** operations `PUBLIC_ROUTES` exempts — `GET /healthz` and `GET /readyz`. The other four exempt entries are not operations the document contains (the webhooks and `/openapi.json` are `hide: true`, `/docs` is plugin-served), so each entry carries a `published` flag, and the integration test uses it to assert both directions rather than a re-typed list (FR-012) — the flag is what makes the agreement checkable, not what produces it. The annotation direction is global-plus-exemptions, so a route added without thought is published as authenticated, matching how the hook itself fails closed |
| Demo key | Unchanged (D25) — the docs page is where the reviewer pastes it, and it is still delivered out of band and never committed |
| Rate limiting | Unchanged. The 001 contract's claim that limits are keyed by internal post id is corrected to the code (two buckets, read and write, keyed on the resolved API key id) |
| Logging | Unchanged; pino still redacts keys, tokens and comment text |

**Post-Phase 1 re-evaluation**: unchanged — PASS on all five. Phase 1 added no table, no
cross-boundary read, no platform branch and no synchronous write path. The one structural addition
is an index.

## Project Structure

### Documentation (this feature)

```text
specs/002-flat-comment-listing/
├── plan.md                       # This file
├── spec.md                       # Feature specification (outcome level)
├── research.md                   # Phase 0: R-01…R-11, choices with rejected alternatives
├── data-model.md                 # Phase 1: the index, the selection value, the repository delta
├── quickstart.md                 # Phase 1: how to run it and how each criterion is proven
├── contracts/
│   └── rest-api.md               # Phase 1: the REST delta against 001 and root spec.md §6.1
├── checklists/
│   └── requirements.md           # Specification quality checklist (passed)
└── tasks.md                      # Phase 2 output — created by /speckit-tasks, not here
```

### Source Code (repository root)

§4.2's directory layout does not change; this feature edits files inside it. Its one enumeration
that does change is the use-case list, where three reads collapse into `ListComments` — updated in
the root `spec.md` with D31, so the layout and this plan name the same use cases. Marked `+` added,
`~` modified, `−` deleted:

```text
src/
├── app/
│   └── api.ts                                    ~ securitySchemes + the transform wrapping
│                                                   jsonSchemaTransform (R-09)
├── modules/comments/
│   ├── application/
│   │   ├── list-comments.ts                      + the one read use case
│   │   ├── list-post-comments.ts                 − replaced
│   │   ├── list-replies.ts                       − replaced
│   │   └── list-account-comments.ts              − replaced
│   ├── http/
│   │   ├── auth.ts                               ~ PUBLIC_ROUTES exported, each entry gaining a
│   │   │                                           `published` flag — the single source of the
│   │   │                                           exempt list and of what is published (FR-012)
│   │   ├── routes.ts                             ~ one GET /v1/comments; three registrations gone
│   │   ├── schemas.ts                            ~ the selection query schema; postCommentsPageSchema
│   │   │                                           folded into an optional `sync` (R-08)
│   │   ├── list-comments.integration.test.ts     + US1, filters, edge cases
│   │   ├── openapi-security.integration.test.ts  + US3's machine-readable half
│   │   ├── post-comments|replies|inbox.*.test.ts ~ rewritten against the collection, each
│   │   │                                           asserting its old address is now 404
│   │   ├── tenancy.integration.test.ts           ~ three per-endpoint rows → three filters
│   │   └── benchmark.integration.test.ts         ~ one EXPLAIN becomes four, each naming its index
│   └── infrastructure/
│       ├── comment-repository.ts                 ~ three list methods → one `list`
│       └── schema.ts                             ~ comments_workspace_idx
├── drizzle/                                      + one CREATE INDEX migration
└── scripts/
    ├── bench-listing.ts                          + SC-005, on demand (R-10)
    └── smoke.ts, smoke-checks.ts                 ~ walkthrough starts identifier-free (FR-015)
```

Repository-root documents that move with the code, listed because three of them are the only place
some of this reasoning is ever written for a reader:

| File | What changes | Why it cannot be skipped |
|------|--------------|--------------------------|
| `spec.md` | §18 records **D31**; §6.1's table loses three rows and gains one. **Done first.** | Principle I: the record comes first, the diff second |
| `README.md` | the curl walkthrough starts at `GET /v1/comments` with no identifier | FR-015 names it |
| `DESIGN.md` | why reads are flat (the missing cross-account inbox, explicitly *not* discoverability), why writes stay addressed, why `topLevelOnly` is a filter, why refresh stays addressed to a post; plus the R-10 measurement | FR-014 and SC-008 — a reader must be able to state it without asking |
| `openapi.json` | regenerated; CI's drift step is the check | FR-011, D18 |
| `specs/001-…/contracts/rest-api.md` | the three removed reads; the rate-limit-keying correction | it currently describes routes that will not exist |

**Structure Decision**: unchanged — one service, two runtime roles from one image, modules split by
domain. This feature is contained within `modules/comments` plus the HTTP composition root, and the
boundary that matters is the one it does *not* cross: the collection reads `comments` only, and the
`platform-core` ports stay the sole route to another service's data.

Two points where this plan resolves something the layout states more briefly:

- **`list-comments.ts` is one use case, not a dispatcher.** It resolves whichever identifier-shaped
  filters are present, calls `repository.list` once, and reads sync status only when a post is
  named. It contains no branch that chooses a query shape — that is the predicate builder's job in
  the repository, and the index choice is the planner's (R-04).
- **`PUBLIC_ROUTES` becomes a published fact, not an internal one.** Exporting it, and adding a
  `published` flag per entry, makes the authentication module the single source of truth both for
  what the document says about authentication and for which exempt routes the document contains at
  all (FR-012). The coupling it introduces — the `matches` predicates are now applied to OpenAPI
  path templates as well as request paths — is recorded in R-09, because it is easy to break
  silently when a future exempt route carries a path parameter.

## Complexity Tracking

No constitutional violation requires justification. Two items are recorded because they are
deliberate costs a reviewer should see stated rather than discover:

| Item | Why it is accepted | Simpler alternative rejected because |
|------|--------------------|--------------------------------------|
| A breaking API change with no shim — three routes removed outright | FR-009 and the constitution's "replace, don't deprecate". The service has one documented consumer surface and a demo deployment; keeping both shapes means two read paths for one read, which is exactly the drift the removal exists to end | An alias or redirect period leaves the nested addresses reachable, so SC-002's "no reachable address behind" cannot be tested, and the removal never actually happens |
| Filter combinations with no leading index (a post's full thread, `platform`-only, `isOwn`-only) degrade to an ordered walk of `comments_workspace_idx` with a residual filter | FR-013 states a performance requirement for the unfiltered listing and for the three preserved reads; none of these is either. An index per combination is a power set, and the trigger for adding one is named and cheap — the R-10 harness measures any selection | Adding an index per plausible filter now is the premature optimization the project's guidelines forbid, and each one is a write cost paid on every insert for a read nobody has asked for yet |
