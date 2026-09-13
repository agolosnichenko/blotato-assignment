# Specification Quality Checklist: Workspace-wide comment listing and authenticated API docs

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-14
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- Items marked incomplete require spec updates before `/speckit-clarify` or `/speckit-plan`.

### Validation iteration 1 — issues found and fixed

- **No implementation details**: FR-003 named the sort columns (`occurred_at`, `id`) and the paging
  technique; FR-004/FR-005 named the architectural ports; FR-008 named a SQL join; FR-013 prescribed
  an index. All four were restated as observable behaviour. The storage consequence of FR-013 is
  recorded in Assumptions as a planning note instead of as a requirement.
- **Success criteria are technology-agnostic**: SC-005 required "no index-less scan"; restated as a
  repeatable timing comparison across history sizes.

### Validation iteration 2 — after `/speckit-clarify` (2026-09-14)

- **Success criteria are measurable**: SC-005 asked the unfiltered listing to answer "in the same
  time" at ten times the history, naming neither a threshold nor a method, so nothing could pass or
  fail it. Restated as a ratio between two history sizes — p95 on the larger within 1.5x of the
  smaller at equal page size — measured on demand. The reasoning for a ratio over an absolute
  millisecond threshold, and for keeping it out of continuous integration, is in Assumptions.
- Two filter-combination ambiguities were closed in the same session: FR-002 now states that filters
  intersect and that an unsatisfiable combination is an empty result rather than a validation error,
  and FR-006 now keys the refresh-freshness block to a post being named rather than to the post
  filter standing alone. Both are biconditionals, so a future filter does not reopen them.

### Validation iteration 3 — after `/speckit-analyze` (2026-09-14)

Three claims in the artifacts were checked against the code rather than against each other, and did
not survive:

- **FR-012 / acceptance 3.3 were unimplementable as written.** `PUBLIC_ROUTES` holds six entries,
  but four of them are not operations in the published document (both webhooks and `/openapi.json`
  are `hide: true`, `/docs` is plugin-served), so "the set of operations carrying `security: []`
  equals the exempt list" can never hold. FR-012 now requires the single source to record
  publication per entry, acceptance 3.3 is narrowed to the two probes, and the rejected alternative
  — publishing the webhook operations — is recorded in Assumptions.
- **SC-007 assumed every route is published.** Restated so a deliberately withheld route is recorded
  as withheld at the same source rather than merely missing.
- **FR-013's second half was asserted for one read, not three**, and by an `EXPLAIN` helper that does
  not name the index it expects — while the feature adds an index that competes for exactly those
  queries. The plan, quickstart V7 and T017 now say so and pin each read to its index.

None of these changed a requirement's intent; each removed a statement that could not be tested.

### Deliberate judgement calls (no clarification requested)

- Page-size bounds, default direction, and list-visibility behaviour are carried over from the
  existing service rather than re-decided, so no reasonable-default question remains.
- Post filter combined with parent-comment filter is defined as an intersection; recorded in
  Assumptions.
- Status filtering for pending writes is explicitly out of scope; the existing visibility rule
  applies unchanged.
- The new decision id is **D31**, not D30 — D30 is already used in the root `spec.md` §18 for the
  account-disconnect clarification.
