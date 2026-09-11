# Feature Specification: Multi-Platform Comment System

**Feature Branch**: `001-multi-platform-comments`

**Created**: 2026-09-11

**Status**: Approved — quality checklist passed, plan and Phase 1 artifacts derived from this
document. It tracks `spec.md`, which is FINAL; a change here follows a change there, never precedes
it (Principle I).

**Input**: User description: "@spec.md — the working specification of the Blotato take-home comment
system (status FINAL, decisions D1–D29, assumptions A1–A23, spikes S1–S5)."

> This document is the outcome-level restatement of the engineering specification in the repository
> root `spec.md`. `spec.md` stays the source of truth for decisions (§3), assumptions (§16) and
> spikes (§17); this file expresses the same scope as user journeys, testable requirements and
> measurable outcomes, so that planning and task generation have a behavioural contract to work
> from. Where a requirement traces to a decision, the decision id is cited in parentheses. The scope
> boundary itself is inherited, not chosen here: it is the product's documented comment
> functionality (D2).
>
> **One term, two names.** This document says *refresh* because that is what the customer asks for;
> the plan, the data model, the contract and the code say *sync* — `comment_sync_targets`,
> `SyncJob`, `POST /v1/posts/:postId/comments/sync`, `SYNC_COOLDOWN`. They are the same thing, and
> the pair is recorded here so the drift is a translation rather than a discrepancy.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Read the conversation under a published post (Priority: P1)

A customer has published a post through the platform and wants to see what the audience is saying.
They ask for the post's comments and get the top-level comments, newest first, each carrying its
author, text, and how many direct replies it has. Opening one comment gives its replies, oldest
first, so the conversation reads in the order it happened. Long conversations are paged through a
cursor that never repeats or skips a comment, even while new comments keep arriving. The post's own
list states how fresh its data is and whether a refresh is under way.

**Why this priority**: Reading is the foundation. Without a trustworthy, complete, correctly ordered
read model there is nothing to reply to and nothing to automate. It is also the only story that
delivers value entirely on its own.

**Independent Test**: Connect an account, ingest a post's comments, and page through the top-level
list and one thread's replies in both orderings; verify no duplicates, no gaps, correct reply
counts, and a stated freshness timestamp — without ever writing to a platform.

**Acceptance Scenarios**:

1. **Given** a published post with 30 top-level comments, **When** the client requests the post's
   comments with a page size of 20, **Then** 20 comments are returned newest first with a cursor,
   and the cursor returns the remaining 10 with no overlap.
2. **Given** a comment with 3 direct replies, **When** the client requests that comment's replies,
   **Then** the 3 replies are returned oldest first and the parent reports a reply count of 3.
3. **Given** 5 new comments arrive between two page requests, **When** the client follows the
   cursor, **Then** no comment already returned appears again and no pre-existing comment is skipped.
4. **Given** a cursor obtained under newest-first ordering, **When** it is replayed asking for
   oldest-first, **Then** the request is rejected as invalid rather than silently re-ordered (D27).
5. **Given** a comment was deleted on the platform but still has live replies, **When** the list is
   requested, **Then** the deleted comment appears as a placeholder with no text and its replies
   remain reachable; a deleted comment with no replies is hidden (A4).
6. **Given** a post belonging to another customer, **When** its comments are requested, **Then** the
   response is "not found" and reveals nothing about the post's existence (D20).

---

### User Story 2 - Reply publicly, exactly once (Priority: P1)

A customer replies to a comment, or posts a top-level comment on their own post. The request is
accepted immediately and the reply is reported as queued; the customer polls the reply until it
reaches "posted" or "failed". Whatever happens between the service and the platform — a timeout, a
rate limit, a dropped connection — the audience never sees the same reply twice.

**Why this priority**: This is the write half of the product and the one irreversible action in the
system. A duplicate public reply on behalf of a brand cannot be taken back, so the single-delivery
guarantee is the feature's core promise (D14).

**Independent Test**: Submit a reply against a platform test double that times out after accepting
the write, then confirm the service reconciles, finds its own reply, and settles on "posted" with
exactly one comment visible on the platform and one row locally.

**Acceptance Scenarios**:

1. **Given** a posted comment on a supported platform, **When** the customer submits a reply,
   **Then** the request is accepted immediately with status "queued" and a location to poll (A11).
2. **Given** a queued reply, **When** the platform accepts it, **Then** the reply reaches "posted"
   and carries the platform's identifier for it.
3. **Given** the platform connection drops after the reply was sent, **When** the service retries,
   **Then** it first looks for its own already-published reply and, finding it, settles on "posted"
   without sending a second one.
4. **Given** the platform rejects the reply permanently, **When** the outcome is recorded, **Then**
   the reply is "failed" with an actionable error code, and any reserved audience-contact allowance
   is released.
5. **Given** the same submission is retried with the same idempotency key, **When** the body is
   identical, **Then** the original reply is returned; **When** the body differs, **Then** the
   request is rejected as a conflict.
6. **Given** a platform that allows only one level of nesting, **When** a reply to a reply is
   submitted, **Then** it is rejected with a depth error naming the top-level comment, and nothing
   is re-parented silently (D12).
7. **Given** the reply text exceeds the platform's limit, **When** it is submitted, **Then** it is
   rejected before anything is sent to the platform.
8. **Given** the monthly allowance for replying to new audience members is exhausted, **When** a
   reply to a new person is submitted, **Then** it is rejected as over quota, while a reply to
   someone already counted this month is accepted (D16, A8).

---

### User Story 3 - Comments arrive on their own and stay accurate (Priority: P1)

New comments, edits and deletions on connected accounts show up without anyone asking. Where the
platform pushes events, they are used immediately; where it does not, or where a push was missed,
a scheduled refresh reconciles the post. The same comment ingested twice — pushed once and found
again by a refresh — is one comment, never two.

**Why this priority**: Stories 1 and 2 are only as good as the data behind them. Ingestion is what
makes the read model true, and it is the path where at-least-once delivery would otherwise become
visible duplication.

**Independent Test**: Deliver the same platform event twice and run a refresh over the same post;
verify one stored comment, one emitted notification, and correct counts — then delete the comment on
the platform side and verify a complete refresh marks it deleted.

**Acceptance Scenarios**:

1. **Given** a signed platform event for a new comment, **When** it is delivered, **Then** the
   comment is stored and a "comment received" notification is emitted once; **Given** a later event
   says the author edited that comment, **When** it is processed, **Then** the stored text matches
   the edit and no second comment appears.
2. **Given** the same event is redelivered (platforms retry for up to 36 hours), **When** it is
   processed again, **Then** no second comment and no second notification appear.
3. **Given** an event whose signature does not verify, **When** it is received, **Then** it is
   rejected and nothing is stored.
4. **Given** a reply whose parent has never been seen locally, **When** it is ingested, **Then** the
   service walks up the chain until it finds a known ancestor or the top-level comment, so the reply
   is attached in the right place.
5. **Given** a refresh that walks every page successfully, **When** comments previously stored are
   absent on the platform, **Then** they are marked deleted; **Given** a refresh that fails midway,
   **When** it stops, **Then** no deletion is inferred.
6. **Given** a post is refreshed for the very first time, **When** its existing comments are found,
   **Then** they are tagged as backfill so downstream automations do not react to old conversations
   (A10).
7. **Given** the customer wants fresher data now, **When** they request a manual refresh, **Then** a
   refresh is started and reported back; a second request inside the cooldown is rejected with a
   retry hint, and a request while a refresh is running returns the running one (D19).

---

### User Story 4 - One inbox per connected account (Priority: P2)

A customer wants everything addressed to one connected account in one place — including comments on
posts that were not published through the platform. They filter by time window and by whether the
comment is their own, and they can reply from there.

**Why this priority**: It turns per-post reading into a workable daily surface and is what
"respond to any comment on any post" automations depend on (D13). It builds on Stories 1–3 rather
than standing before them.

**Independent Test**: Ingest comments for one account across two posts, one of them not published
through the platform, and confirm both appear in the account inbox, filterable by time and
ownership, and that a reply can be sent to the external post's comment.

**Acceptance Scenarios**:

1. **Given** comments on both an internally published post and an external one, **When** the account
   inbox is requested, **Then** both appear, newest first, with the external one carrying no
   internal post reference.
2. **Given** a time window filter, **When** the inbox is requested, **Then** only comments that
   occurred inside the window are returned.
3. **Given** an "own comments" filter, **When** the inbox is requested, **Then** comments authored by
   the connected account are separated from audience comments regardless of whether they were created
   through this service (A2).
4. **Given** a comment on an external post, **When** a reply is submitted to it, **Then** it is
   accepted; **Given** an external post, **When** a top-level comment is submitted on it, **Then** it
   is rejected (A7).
5. **Given** the post a comment belongs to is no longer resolvable, **When** the post-scoped list is
   requested, **Then** it returns "not found", while the comment stays reachable through the account
   inbox (A10a).

---

### User Story 5 - Know what each platform can do, and add one without a migration (Priority: P3)

A customer — or an agent acting for one — asks which platforms support comments and under what
limits, and gets a machine-readable answer: whether comments are supported, whether top-level
comments and replies are allowed, the maximum reply depth, the text limit, and how comments are
ingested. Platforms that do not support comments state why.

**Why this priority**: It makes the abstraction visible and testable, and it is what lets a client
avoid a rejected write. It is the smallest slice, and the last that must exist for the system to be
complete.

**Independent Test**: Request the capability registry and verify all nine publishing platforms are
listed with accurate capabilities, then verify that a write to an unsupported platform is rejected
with the same reason the registry gives.

**Acceptance Scenarios**:

1. **Given** the registry is requested, **When** it responds, **Then** all nine publishing platforms
   appear, three of them supporting comments and six carrying a stated reason why they do not.
2. **Given** a platform marked as not supporting comments, **When** a write is attempted against it,
   **Then** it is rejected as unsupported before anything leaves the service.
3. **Given** a new commenting platform is added, **When** it ships, **Then** no change to the stored
   data shape and no change to the public contract is required (Principle IV).

---

### Edge Cases

- **A reply's parent stops being repliable.** Parent still queued, already failed, or deleted → the
  reply is rejected up front (A6); a parent deleted after the child was queued → the child settles as
  failed with a parent-deleted reason.
- **The platform echoes back our own reply while we are still publishing it.** Ingestion and
  publication converge on one comment: the ingested duplicate is discarded and the customer's
  original queued comment becomes the posted one (§7.1 step 7).
- **The connected account's authorization stops working.** The account is marked disconnected, its
  pending work stops, and further writes to it are rejected with a clear reason rather than retried
  forever (A19).
- **The post is gone on the platform.** The scheduled refresh stops rescheduling that post and
  records why; it infers no deletions from an unanswerable walk, and a manual refresh can revive the
  schedule if the post becomes reachable again.
- **Queueing fails after the reply was accepted.** A recovery pass picks up replies that stayed
  queued with no work in flight and resumes them; an accepted reply is never silently abandoned.
- **Two replies to the same new audience member are submitted at once.** The monthly allowance is
  consumed once, not twice, and only one of the concurrent requests can be the one that consumes it.
- **A conversation goes quiet, then gets a new comment on day 44.** Retention is measured from the
  thread's last activity, so the thread is never truncated mid-conversation (A9).
- **An event arrives for an account this service does not know.** It is acknowledged and recorded as
  unprocessable rather than retried or failed loudly.
- **Text that is legal on one platform and not another.** Limits are counted the way the platform
  counts them — graphemes where the platform counts graphemes, characters where it counts characters.

## Requirements *(mandatory)*

### Functional Requirements

**Reading**

- **FR-001**: The system MUST return a published post's top-level comments with, for each, its
  author, text, status, and count of direct replies.
- **FR-002**: The system MUST return the direct replies of a given comment as a separately paged
  list, so that response size stays predictable at any conversation depth (D11).
- **FR-003**: The system MUST let the caller choose newest-first or oldest-first ordering on every
  list, defaulting to newest-first for post lists and inboxes and oldest-first for replies (D27).
- **FR-004**: The system MUST page lists with an opaque cursor that remains correct while rows are
  inserted, and MUST reject a cursor replayed under a different ordering (A13).
- **FR-005**: The system MUST include comments in every status except deleted, so customers see
  their own queued and failed replies; a deleted comment with surviving replies MUST be returned as
  a text-less placeholder (A4).
- **FR-006**: The system MUST report, on post-scoped reads, when the post's comments were last
  refreshed and whether a refresh is currently running.
- **FR-007**: The system MUST expose a single comment by id so a caller can poll a pending write to
  completion.
- **FR-008**: The system MUST expose a per-account inbox spanning all of that account's posts,
  including posts not published through the platform, filterable by time window and by whether the
  comment is the account's own (D13).

**Writing**

- **FR-009**: The system MUST accept a reply to a comment and a top-level comment on a published
  post, acknowledge both immediately as queued, and settle each to posted or failed asynchronously
  (A11).
- **FR-010**: The system MUST validate, before accepting a write: that the platform supports
  comments, that the resulting depth is within the platform's maximum, that the text is within the
  platform's limit, that the parent is in the posted state, and that the account is connected —
  each failing with its own machine-readable reason (§6.3).
- **FR-011**: The system MUST never publish the same customer-authored comment to a platform twice.
  When an attempt's outcome is unknown, it MUST search the platform for its own comment before any
  retry, and treat a match as success (D14).
- **FR-012**: The system MUST retry only failures that are known to be retryable, with increasing
  backoff, honouring any retry delay the platform states, and MUST stop after a bounded number of
  attempts with a recorded reason.
- **FR-013**: The system MUST honour an optional idempotency key per customer: the same key with the
  same body returns the original comment, the same key with a different body is a conflict (A12).
- **FR-014**: The system MUST reserve the customer's monthly audience-contact allowance before
  queueing a reply to a person not yet counted this period, release it if the reply ultimately fails,
  and count the same person once per period per platform (D16, A8).
- **FR-015**: The system MUST reject a top-level comment on a post not published through the
  platform, while allowing replies to comments on such posts (A7).

**Ingestion and freshness**

- **FR-016**: The system MUST accept comment events pushed by platforms that offer them, verifying
  their authenticity before interpreting them, and MUST acknowledge them fast enough that the
  platform does not consider delivery failed.
- **FR-017**: The system MUST treat a comment identified by the same platform identifier on the same
  account as one comment, regardless of how many times or through which channel it arrives. When a
  later arrival carries different content — the author edited the comment — the stored comment MUST
  be updated to match rather than kept at its first-seen text or stored a second time.
- **FR-018**: The system MUST refresh each tracked post on a schedule that tightens for recent posts
  and relaxes as they age, and MUST stop tracking posts past the retention window. A post becomes
  tracked either when it is published through the platform or when the first comment on a post not
  published through the platform is ingested — so external posts stay as fresh as internal ones
  (D13, §7.3).
- **FR-019**: The system MUST mark comments deleted only after a refresh that walked the post
  completely; a refresh interrupted by an error MUST infer no deletions.
- **FR-020**: The system MUST tag comments found by a post's first refresh as backfill, distinctly
  from comments observed as they happen, so consumers can ignore history (A10).
- **FR-021**: The system MUST let a customer request an immediate refresh of a post, report it as a
  trackable job, enforce a cooldown between manual requests, and return the running job if one
  already exists (D19).
- **FR-022**: The system MUST resolve an ingested reply's parent, fetching ancestors from the
  platform when the parent is not known locally, rather than storing an orphan.
- **FR-023**: The system MUST record a comment as the account's own when the author is the connected
  account, independently of whether it was created through this service (A2).

**Notifications to the rest of the platform**

- **FR-024**: The system MUST emit a notification when a comment is received, posted, failed, or
  deleted, carrying enough context for a consumer to act without reading this service's storage.
- **FR-025**: The system MUST emit a notification only if the state change it describes was durably
  recorded, and MUST deliver it at least once, with a stable identity so consumers can de-duplicate
  (D9).

**Access, tenancy and lifecycle**

- **FR-026**: The system MUST authenticate every request as a specific customer workspace and scope
  every read and write to it; another workspace's resource MUST be indistinguishable from one that
  does not exist (D20).
- **FR-027**: The system MUST rate-limit each credential and tell the caller its limits and when to
  retry.
- **FR-028**: The system MUST reject a request whose credential is missing, unrecognized or revoked.
- **FR-029**: The system MUST delete conversations whose last activity is older than the retention
  window (45 days by default, configurable), removing whole threads rather than individual comments
  (D15, A9).
- **FR-030**: The system MUST remove a deleted comment's text and author details while keeping the
  thread's structure intact.
- **FR-031**: The system MUST publish a machine-readable capability registry for all nine publishing
  platforms, stating comment support, allowed operations, maximum reply depth, text limit, ingestion
  method, and — where unsupported — the reason (§8.1).
- **FR-032**: The system MUST return failures as structured problems carrying a stable,
  machine-readable code, distinct from human-readable text (§6.3).
- **FR-033**: The system MUST survive the loss of its queueing and rate-limiting infrastructure
  without losing an accepted write, a received event, or an unsent notification.

### Key Entities

- **Comment**: One comment or reply on one platform post. Carries the owning workspace, connected
  account, platform, the post it belongs to (internal reference optional), its parent and top-level
  ancestor, depth, the platform's identifier once published, author identity, text, whether it is the
  account's own, how it entered the system (customer request, pushed event, or refresh), its status
  in the publishing lifecycle, failure reason if any, direct reply count, the time it occurred on the
  platform, and the thread's last activity time.
- **Conversation thread**: A top-level comment together with its descendants. It is the unit of
  retention: activity anywhere in it keeps all of it alive.
- **Connected account**: An account on a platform that the workspace has authorized, owned by
  another service and read here only. Determines which comments are "own", which credentials are
  used, and whether work for it proceeds at all.
- **Post**: A published post, owned by another service. Comments attach to the platform's identifier
  for it; the internal reference exists only to serve post-scoped requests and may be absent for
  posts not published through the platform.
- **Workspace**: The tenancy boundary and the owner of credentials, rate limits and the monthly
  audience-contact allowance.
- **Refresh target and refresh job**: The per-post schedule for reconciling with the platform, and
  the trackable record of one reconciliation attempt with its counts and outcome.
- **Audience-contact usage**: The record that a given person on a given platform was replied to in a
  given month by a given workspace, so the allowance is consumed once.
- **Platform capability entry**: What one platform supports — comments, top-level comments, replies,
  maximum reply depth, text limit and unit, ingestion method, and a reason when unsupported.
- **Notification**: A durable record of something that happened to a comment, awaiting delivery to
  other services.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A customer-authored reply appears on the platform exactly once in 100% of runs across
  the failure matrix — success, timeout after send, connection drop after send, rate limit, platform
  rejection, and a platform echo racing the publish.
- **SC-002**: Paging through a 500-comment conversation while new comments are being written returns
  every pre-existing comment exactly once, in both ordering directions, with zero duplicates and zero
  gaps.
- **SC-003**: A comment delivered by push and then found again by a refresh exists once and produces
  one notification; redelivery of the same platform event over a 36-hour window changes neither
  count.
- **SC-004**: Where a push channel is actually delivering, a comment is readable through the API
  within a minute of the platform delivering the event. Otherwise freshness is bounded by the post's
  age band for that platform — the intervals in §7.3, which differ per platform and are configurable
  (5 minutes under 24 h where there is no push at all, 30 minutes where polling only reconciles a
  push channel). This deployment runs under Standard Access, so Instagram and Facebook are reconciled
  by refresh rather than push (D23), and their freshness is the age-band figure, not the minute.
- **SC-005**: A read request for a post's comments returns within 300 ms at the 95th percentile on a
  workspace seeded with 100,000 comments.
- **SC-006**: An accepted write is acknowledged within 300 ms at the 95th percentile, independently of
  how long the platform takes to accept it.

SC-005 and SC-006 are **design budgets measured by a seeded benchmark against the local stack**, not
production service levels: A21 states that no SLA is designed and A22 puts metrics and tracing out of
scope, so nothing in the running deployment measures a percentile. Their purpose is to fail the build
if a query plan degrades — which the keyset indexes and the asynchronous write path are what make
achievable — not to promise a number to a customer.
- **SC-007**: No request can read or affect another workspace's data: every endpoint returns "not
  found" for a resource belonging to another workspace, asserted by test on 100% of endpoints.
- **SC-008**: An interrupted refresh marks zero comments as deleted; a complete refresh detects 100%
  of comments removed on the platform since the previous complete refresh.
- **SC-009**: Adding a new commenting platform requires no change to the stored data shape and no
  change to the public contract — demonstrated by the third platform, whose model differs from the
  first two in nesting depth, text counting and ingestion method.
- **SC-010**: Conversations inactive beyond the retention window are fully removed within 24 hours of
  crossing it, and no conversation with activity inside the window is partially removed.
- **SC-011**: Losing the queueing infrastructure and restarting loses zero accepted writes, zero
  received events and zero undelivered notifications.
- **SC-012**: A reviewer can complete every step of the documented walkthrough — list platforms, read
  a post's comments, post a reply, poll it to "posted", hit the depth limit on one platform and
  succeed past it on another, and request a refresh — against the live deployment, with no local
  setup and no step that the documentation does not cover.

## Assumptions

Carried from `spec.md` §16; the identifiers are the ones used there.

- **A1**: A post is visible to this feature only once it has a platform identifier; earlier states
  belong to the publishing service.
- **A2**: "Own" is decided by author identity matching the connected account, not by origin.
- **A3**: Ordering is the caller's choice; the defaults follow the use — newest first for a post's
  comments and for the inbox, oldest first for reading a thread of replies (superseded by D27, which
  made the direction an explicit parameter and part of the cursor).
- **A4**: Lists show every status except deleted; a deleted comment with live replies is a
  placeholder.
- **A5**: Comment text is plain text; where a platform needs markup to make links and mentions live
  (Bluesky facets), the service derives it rather than asking the caller for it.
- **A6**: Only a comment in the posted state can be replied to.
- **A7**: Replies to comments on external posts are supported; top-level comments on them are not.
- **A8**: The audience-contact allowance is reserved at acceptance and released on final failure;
  the same person counts once per month per platform.
- **A9**: Retention runs from the thread's last activity, not from each comment's own age.
- **A10**: A post's first refresh walk is history, not news: what it finds is tagged backfill so
  consumers can ignore it.
- **A10a**: A comment may outlive the post record it references; it stays reachable through the
  account inbox, and retention bounds the dangling rows. No cross-service cascade is assumed.
- **A11**: Writes are acknowledged as accepted-for-processing, not as created-and-done.
- **A12**: Idempotency keys are optional, recommended, and live as long as the comment.
- **A13**: Cursors are opaque, encode the ordering direction, and are stable under inserts.
- **A14**: The contract is versioned by a path prefix; a breaking change becomes a new version
  rather than a changed meaning inside the current one.
- **A15**: Identifiers are opaque and time-sortable, with no type prefix.
- **A16**: Authentication reuses the platform's existing API-key header so existing clients and
  automation tools need no new configuration.
- **A17**: The same Instagram account connected through two different login variants is two
  connections, not one; no cross-variant merging is attempted.
- **A18**: Pushed events include the comment's content; anything missing is fetched from the platform.
- **A19**: Authorization failure disconnects the account and stops its work; reconnection belongs to
  the accounts service.
- **A20**: Where a platform allows unlimited nesting, this feature imposes no depth limit of its own.
- **A21**: One deployment region; no service level and no scaling beyond a single instance of each
  role is designed.
- **A22**: Structured logs plus health checks are the whole observability surface; metrics and
  tracing are out of scope.
- **A23**: A local run is supported for development and continuous integration, but the reviewer
  uses the deployment rather than a local checkout.

**Dependencies on other services** (D8, D29): workspaces, API credentials, connected accounts with
their platform tokens, and posts are owned elsewhere and are read through ports only — never written,
never joined to. Three Meta behaviours remain unverified and gate the parts that depend on them:
delivery of Facebook Page comment events under the app's current access level (S1), readability of
Instagram comments under each login variant (S2), and which signing secret authenticates events for
the Instagram login variant (S5). Two further unknowns gate their own parts just as strictly: which
eviction and persistence settings the managed queueing infrastructure will actually accept, which
bears on FR-033 (S3), and Bluesky's current rate limits, against which the refresh intervals behind
FR-018 and SC-004 must be tuned before those intervals can be trusted (S4).
