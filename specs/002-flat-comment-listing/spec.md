# Feature Specification: Workspace-wide comment listing and authenticated API docs

**Feature Branch**: `002-flat-comment-listing`

**Created**: 2026-09-14

**Status**: Draft

**Citing requirements**: `FR-###` ids in this directory are numbered within *this* feature and
collide with 001's — 002's FR-005 ("an identifier-free read calls no port") and 001's FR-005 ("a
deleted comment is listed only while it has replies") are different requirements. Code comments cite
whichever feature introduced the rule they implement, so read an `FR-###` against the spec the
surrounding text names, not against this one by default.

**Input**: User description: "Comments as a flat read collection + a working Swagger Authorize button. Two independent problems: (a) the interactive docs page has no way to supply the API key, so every 'Try it out' answers 401; (b) there is no cross-account inbox — the moderation view 'every new comment across every account in the workspace' is not reachable from any route, because the only inbox is per account. Time, not post hierarchy, is the primary access path for comments, so hierarchy belongs in a filter rather than in the address. Reads become one collection with optional filters; writes stay addressed to their target (commands address, queries filter). Discoverability is explicitly *not* the justification — account and post identifiers legitimately come from platform-core (D8)."

## Clarifications

### Session 2026-09-14

- Q: Should the refresh-freshness block appear whenever a post filter is present, or only when the post filter is the sole filter in the request? → A: Whenever a post filter is present, regardless of which other filters accompany it.
- Q: What should the listing do when the caller asks for top-level entries only and filters by a parent comment — a combination no comment can ever satisfy? → A: Accept it and return an empty successful result; filters intersect, none overrides another.
- Q: How should SC-005 prove that the unfiltered listing stays bounded by page size rather than by workspace history? → A: As a ratio between two history sizes — p95 at ten times the history within 1.5x of the baseline — measured on demand rather than gated in continuous integration.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Moderate everything that arrived in the workspace (Priority: P1)

A social media manager looks after several connected accounts. They want one view answering "what
was said to us recently", newest first, without naming an account or a post, so they can work a
queue from the top and stop when they reach comments they have already handled.

**Why this priority**: this is the reason the feature exists. It is the one journey no current route
serves at all, and it delivers value on its own: with it alone, a caller holding nothing but an API
key can read the workspace's comment activity.

**Independent Test**: call the comment collection with no parameters using a workspace's API key;
the response holds that workspace's most recent comments across every connected account and every
post, and paging forward with the returned cursor walks the whole history without repeating or
skipping an entry.

**Acceptance Scenarios**:

1. **Given** a workspace with comments on two different accounts and on both platform-published and
   externally created posts, **When** the caller lists comments with no filters, **Then** all of
   them appear in one page ordered newest first, and comments belonging to other workspaces do not.
2. **Given** a result page that reports more data is available, **When** the caller repeats the
   request with the returned cursor, **Then** the next page continues exactly where the first ended,
   even if new comments arrived in between.
3. **Given** a workspace with no comments at all, **When** the caller lists comments, **Then** the
   response is an empty, successful result rather than an error.
4. **Given** a comment on a post that the platform-data projection no longer resolves, **When** the
   caller lists comments, **Then** that comment is still returned — a comment's readability never
   depends on data owned by another service.

---

### User Story 2 - Narrow the same view down to one thread, account, or platform (Priority: P2)

The same caller drills into a single published post to read its thread, opens the replies under one
comment, checks a single account's inbox, or restricts the queue to one platform and one time range.

**Why this priority**: it preserves every read the service offers today, but as filters on the P1
collection instead of separate addresses. It cannot be tested before P1 exists, and it is what lets
the three nested read routes be removed rather than kept alongside.

**Independent Test**: for each filter, seed data that partly matches and partly does not, then check
that exactly the matching comments come back — and that the previously nested routes now answer
"not found".

**Acceptance Scenarios**:

1. **Given** a published post with top-level comments and replies beneath them, **When** the caller
   filters by that post and asks for top-level entries only, **Then** only the top-level comments
   are returned, and the response additionally reports how fresh the post's comments are (when they
   were last refreshed, and whether a refresh is running).
2. **Given** a comment with replies, **When** the caller filters by that comment as the parent and
   asks for oldest-first order, **Then** its direct replies are returned in the order they were
   written, and no deeper descendants appear.
3. **Given** comments on two platforms, **When** the caller filters by one platform value, **Then**
   only that platform's comments are returned; passing two platform values returns the union of both.
4. **Given** any listing request without a post filter, **When** the caller reads the response,
   **Then** the refresh-freshness block is absent — it describes a post, not a selection.
5. **Given** a post, account, or parent comment identifier belonging to a different workspace,
   **When** the caller filters by it, **Then** the response is "not found" — never "forbidden", and
   never an empty success that would confirm the identifier exists.
6. **Given** a caller still using one of the removed nested read addresses, **When** they call it,
   **Then** they receive "not found" — there is no alias, redirect, or compatibility shim.

---

### User Story 3 - Authenticate inside the interactive docs (Priority: P3)

A reviewer opens the service's interactive documentation page in a browser, pastes the demo API key
into it once, and exercises the endpoints from there without reaching for a terminal.

**Why this priority**: independent of the listing work and valuable on its own, but it changes no
behaviour of the service itself — only whether its published description tells the truth about how
to authenticate.

**Independent Test**: open the docs page, confirm an authorization control is offered, supply a
valid key, invoke the comment collection from the page, and receive data rather than an
authentication error.

**Acceptance Scenarios**:

1. **Given** the docs page, **When** the reviewer looks for a way to supply credentials, **Then** an
   authorization control is present and names the API key header the service actually requires.
2. **Given** a valid key entered there, **When** the reviewer invokes any authenticated endpoint
   from the page, **Then** the request carries the key and succeeds.
3. **Given** the health and readiness endpoints, **When** the reviewer inspects them in the docs,
   **Then** they are described as requiring no API key, matching how the service treats them. The
   webhook endpoints are deliberately absent from the published description — they are not a surface
   a reviewer invokes — so the description makes no authentication claim about them either way.
4. **Given** the published machine-readable description of the API, **When** it is compared to the
   service's actual routes and authentication, **Then** the two agree with no manual step required
   to keep them in sync.

---

### Edge Cases

- A cursor issued for one sort direction is replayed with the other → rejected as a validation
  error, not silently re-interpreted.
- A malformed or truncated cursor → rejected as a validation error.
- `limit` below 1 or above the documented maximum → rejected as a validation error.
- A time range whose start is later than its end → an empty successful result, not an error.
- A platform value that is not a known platform → rejected as a validation error; a known platform
  that does not support comments is accepted and simply matches nothing.
- Post filter and parent-comment filter supplied together → both applied (intersection), which for
  a parent on a different post legitimately yields an empty result.
- Top-level-only and a parent-comment filter supplied together → accepted, and the intersection is
  necessarily empty; the parent filter is neither ignored nor treated as an error.
- Post filter supplied alongside other filters (platform, time range, parent comment) → the
  refresh-freshness block is still reported; it depends on a post being named, not on the post
  filter standing alone.
- A deleted comment that still has replies beneath it remains listed, so a thread never loses its
  root; a deleted comment with no replies does not.
- A caller's own comment that is still queued, being processed, or failed is listed alongside
  comments ingested from the platform, so a write can be followed in the same view it was made from.
- The listing runs for a workspace with a large comment history and no filters at all — the request
  must stay bounded rather than degrade with the size of the workspace.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The service MUST expose one comment listing that, given only a workspace's API key and
  no other input, returns that workspace's comments across every connected account and every post,
  newest first.
- **FR-002**: The listing MUST accept every filter as optional and combinable: internal post, parent
  comment, connected account, platform (repeatable), top-level-only, authored-by-us, and a start and
  end of a time range over when the comment occurred. Filters MUST combine as an intersection: no
  filter overrides or disables another, and a combination that no comment can satisfy MUST be a
  valid request answered with an empty result rather than a validation error.
- **FR-003**: The listing MUST page with the service's existing cursor mechanism, keep the cursor
  opaque to callers, allow both sort directions, and reject a cursor replayed under a different
  direction as a validation error.
- **FR-004**: The listing MUST resolve tenancy for every identifier-shaped filter it is given — post
  and account against the owning service's data, parent comment against the service's own records —
  and answer "not found" for anything outside the caller's workspace.
- **FR-005**: With no identifier-shaped filter, the listing MUST scope results by the workspace of
  the API key alone and MUST NOT call out to another service.
- **FR-006**: The listing MUST report a post's refresh freshness (last refreshed at, active refresh
  job) whenever the selection names a post, whichever other filters accompany it, and MUST omit it
  whenever the selection names no post.
- **FR-007**: The listing MUST apply the service's existing list-visibility rule unchanged: a
  deleted comment is listed only while it still has replies beneath it.
- **FR-008**: The listing MUST return comments whose referenced post is no longer present in the
  copy the service holds of another service's data; a comment's readability MUST NOT depend on that
  data being resolvable.
- **FR-009**: The three nested read routes the listing replaces — a post's comments, a comment's
  replies, and a single account's inbox — MUST be removed outright, with no alias, redirect, or
  deprecation period.
- **FR-010**: The reply-creation, comment-creation, refresh-request, single-comment, sync-job,
  capability-registry, webhook, health, readiness, and machine-readable-description endpoints MUST
  keep their current addresses and behaviour.
- **FR-011**: The published machine-readable API description MUST declare the API key scheme the
  service enforces, apply it to every authenticated endpoint, and mark the described endpoints that
  need no key as such, so the interactive docs page can authenticate and invoke them.
- **FR-012**: The list of endpoints exempt from API key authentication MUST have a single source of
  truth that also records, per endpoint, whether that endpoint is published in the description at
  all — so the enforced list and the described list cannot drift apart, and an endpoint that is
  exempt but unpublished is distinguishable from one that was forgotten.
- **FR-013**: The unfiltered listing's response time MUST be bounded by the requested page size
  rather than by how many comments the workspace has accumulated, and the filtered readings that the
  removed routes used to serve MUST be no slower than they are today.
- **FR-014**: The specification of record MUST carry the new decision and the requirements it
  revises before any code diverges from it, and the reasoning MUST be documented in the design
  write-up: why reads are flat (the missing cross-account inbox, explicitly not discoverability),
  why writes stay addressed to their target, why top-level-only exists as a filter, and why the
  refresh command stays addressed to a post.
- **FR-015**: The onboarding documentation and smoke checks MUST exercise the new listing, starting
  from a request that needs no identifier at all.

### Key Entities

- **Comment**: unchanged. A comment or reply the service owns, carrying its workspace, connected
  account, platform, optional internal post reference, parent and root references, depth, text,
  author, whether it is ours, its publication state, and when it occurred.
- **Comment listing selection**: a workspace plus any combination of the FR-002 filters, a sort
  direction, and a page size — the query the collection answers.
- **Refresh freshness**: when a post's comments were last refreshed and whether a refresh is
  currently running. A property of a post, reported only when the selection names one.
- **API key scheme description**: the published statement that requests carry a workspace API key in
  a named header, and which endpoints are exempt.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A caller holding only a workspace API key can retrieve that workspace's most recent
  comments across all accounts in a single request, with no identifier obtained from anywhere else.
- **SC-002**: Every read previously served by the three removed routes is reproducible through the
  single collection, and their removal leaves no reachable address behind.
- **SC-003**: Paging forward through a workspace's entire comment history returns every comment
  exactly once, with no duplicates and no gaps, while comments are being inserted concurrently.
- **SC-004**: Every filter that names a resource returns "not found" for a resource in another
  workspace, verified by one test per filter.
- **SC-005**: Measured across two workspaces whose comment histories differ by a factor of ten, at
  the same page size, the unfiltered listing's 95th-percentile response time on the larger history
  is at most 1.5 times the one on the smaller — demonstrated by a measurement that can be re-run on
  demand, not by inspection.
- **SC-006**: A reviewer who has never seen the service can authenticate in the interactive docs and
  successfully read comments from the browser, with no terminal and no instructions beyond the demo
  key.
- **SC-007**: The published API description and the running service agree on which routes are
  published and on how each published route authenticates, checked automatically rather than by
  reading; a route the service deliberately withholds from the description is recorded as withheld
  at the same single source, not merely missing.
- **SC-008**: A reader of the design write-up can state why reads are a filtered collection while
  writes remain addressed, without asking the author.

## Assumptions

- The new decision recorded in the specification of record is **D31** — `D30` is already taken (the
  account-disconnect clarification in §18 of the root `spec.md`). The root `spec.md` carries
  decisions and assumptions, not numbered requirements: the requirements D31 revises are **feature
  001's** FR-001 (a post's top-level comments), FR-003 (per-list default ordering), FR-006
  (post-scoped refresh reporting) and FR-008 (the per-account inbox). 001's FR-002 survives as the
  parent-comment filter, and FR-005's visibility rule is untouched.
- D27 splits in two. Its mechanism — keyset pagination, an opaque cursor over `(occurred_at, id)`
  with the direction encoded in it, and a direction mismatch answered as a validation error —
  carries over verbatim. Its *per-route defaults* do not survive the routes: one collection has one
  default. D31 records that change (see the ordering assumption below).
- Page-size bounds stay as they are today (1–100, default 20) rather than adopting any other
  product's limits. The default direction is newest-first for every selection; the replies read,
  which defaulted to oldest-first at its own address, now asks for oldest-first explicitly — a
  visible behaviour change, not a carry-over.
- `task.md`'s "retrieve comments for a published post" stays satisfied: it becomes a post filter
  with top-level-only, returning the same comments, the same reply counts and the same refresh
  freshness. Removing the nested address removes an address, not a capability.
- `topLevelOnly` is an addition of this service's own, not a borrowed parameter: it preserves the
  "a post's page is its top level" reading and keeps the existing partial index usable.
- Intersection semantics (FR-002) apply to every filter pair, including the two that can never match
  together — post plus a parent on another post, and top-level-only plus a parent. No combination of
  otherwise valid filter values is a validation error; only an individually invalid value is.
- Listing behaviour for a caller's own not-yet-published comments follows the existing visibility
  rule unchanged; this feature does not introduce a status filter.
- The two write routes, their idempotency handling, their asynchronous `202` contract, reply-depth
  enforcement and quota reservation are out of scope and are not touched.
- Account and post identifiers legitimately originate outside this service; this feature does not
  add, proxy, or mirror any listing of accounts or posts.
- The rate-limit contract is unchanged. The claim in the current route contract that limits are keyed
  by internal post identifier does not match the code, which keys by read/write bucket and API key;
  the document is corrected to the code, not the reverse.
- The authenticated docs page is a gap against what the service already promised (root `spec.md`
  A16 requires the published description to declare the key as a header scheme so the docs page can
  authorize), not a new decision. US3 closes that gap; it changes no behaviour of the service.
- The demo deployment's data is sufficient for the docs-page walkthrough; no new seeding is required.
- Four of the six authentication-exempt routes are not published operations, and this feature does
  not change that: the two webhook routes and the machine-readable description itself are registered
  as hidden, and the docs assets are served by the documentation plugin rather than as routes of the
  service. Publishing the webhook routes was considered and rejected — they carry no request schema a
  reviewer could exercise, they authenticate by signature rather than by key, and publishing them
  would widen feature 001's published surface for no reviewer benefit. The consequence for FR-012 is
  that the single source of truth records publication alongside exemption, rather than the described
  set being derivable from the exempt set alone.
- Known consequence for the planning phase: no existing storage access path is scoped by workspace
  first, so FR-013 implies adding one. Existing narrower access paths stay, because the filtered
  readings still use them.
- SC-005 is stated as a ratio rather than an absolute time because an absolute threshold is a
  property of the machine it runs on, while the ratio is the property the requirement is actually
  about — that the listing's cost follows the page, not the history. The 1.5 factor is headroom for
  measurement noise, not a target: a listing that is genuinely bounded measures near 1.0, and a
  result approaching the limit is itself the signal that it is not. The measurement is run on demand
  and its result recorded in the design write-up; it is deliberately not a continuous-integration
  gate, because timing on shared runners is too noisy to gate on.
