# Phase 1 Data Model: Workspace-wide comment listing and authenticated API docs

**Feature**: `002-flat-comment-listing` | **Date**: 2026-09-14 | **Plan**: [plan.md](./plan.md)

This feature adds no table and changes no column. The entity model of
[001's data-model.md](../001-multi-platform-comments/data-model.md) stands unchanged; what follows
is the delta — one index, one new in-memory value, and the repository interface that replaces three
methods with one.

---

## 1. `comments` — one new index, nothing else

The table's columns, constraints and checks are untouched. One index is added:

| Index | Definition | Serves |
|-------|------------|--------|
| `comments_workspace_idx` | `(workspace_id, occurred_at DESC, id DESC)` | the unfiltered and non-identifier-filtered listing (FR-001, FR-013, SC-005) |

The column order is the one the keyset scan needs: `workspace_id` is an equality predicate on every
query (D20), and `(occurred_at, id)` is the cursor's own tuple (D27), so `ORDER BY occurred_at DESC,
id DESC` and its `ASC` mirror are both served by scanning this index in one direction or the other —
no sort node, and the scan stops after `limit + 1` rows.

`status`/`reply_count` are deliberately absent from it; see [research.md](./research.md) R-05 for why
the visibility rule stays a residual filter, and for the filter combinations that have no leading
index by design.

### The five existing indexes, and what now reaches them

None changes. What changes is that all of them are now reached through one query builder rather than
three hand-written callers — the predicate a caller sends decides the plan (R-04):

| Index | Reached by the selection |
|-------|--------------------------|
| `comments_post_top_level_idx` `(post_id, occurred_at DESC, id DESC) WHERE parent_comment_id IS NULL` | `postId` + `topLevelOnly=true` — the read `GET /v1/posts/:postId/comments` used to serve |
| `comments_replies_idx` `(parent_comment_id, occurred_at ASC, id ASC)` | `parentCommentId` — the read `GET /v1/comments/:id/replies` used to serve |
| `comments_social_account_idx` `(social_account_id, occurred_at DESC, id DESC)` | `accountId` — the read `GET /v1/accounts/:id/comments` used to serve |
| `comments_workspace_idx` *(new)* | every other selection, including none at all |
| `comments_last_activity_idx`, `comments_stuck_work_idx` | unchanged; retention purge and the stuck-work sweeper, neither touched here |

This table is the concrete form of FR-013's second half: the three preserved reads keep the exact
predicates they had, so they keep the exact plans they had.

### Migration

One `drizzle-kit generate` run producing a single `CREATE INDEX` on `comments`. It is additive and
takes no lock worth planning around at this scale; nothing in the migration drops or rewrites data.

---

## 2. Comment listing selection — a value, not a table

The query the collection answers. It exists only in memory, as the input to one use case; it is
listed here because it is the entity the specification names and the place every validation rule
lands.

| Field | Type | Absent means | Rule |
|-------|------|--------------|------|
| `workspaceId` | `WorkspaceId` | — | never absent; comes from the API key alone (FR-005) |
| `postId` | `uuid?` | no post filter | resolved through the `Posts` port; foreign → `404` (FR-004) |
| `parentCommentId` | `uuid?` | no parent filter | resolved through `CommentRepository.getById`; foreign → `404` |
| `accountId` | `uuid?` | no account filter | resolved through the `Accounts` port; foreign → `404` |
| `platforms` | `string[]?` | every platform | each value must be a key of the platform registry; unknown → `400` (R-02) |
| `topLevelOnly` | `boolean?` | replies included | `true` ⇒ `parent_comment_id IS NULL` |
| `isOwn` | `boolean?` | both | exact match on `comments.is_own` |
| `since` / `until` | `timestamptz?` | unbounded | inclusive bounds on `occurred_at`; `since > until` is a valid, empty selection |
| `order` | `'asc' \| 'desc'` | — | defaults to `desc` for every selection (R-06) |
| `limit` | `1..100` | — | defaults to 20; outside the range → `400` |
| `cursor` | opaque | first page | decoded by the existing codec; a different `order` → `400` (D27) |

**Filters intersect.** Every present filter contributes one `AND`ed condition; none overrides,
disables or is overridden by another. A combination no row can satisfy — `topLevelOnly=true` with a
`parentCommentId`, or a `postId` with a parent that lives on another post — is a valid request
answered with an empty page, never a validation error (FR-002, clarification 2026-09-14). Only an
individually invalid *value* is a `400`.

The cursor encodes `(occurredAt, id, order)` and nothing about the filters, exactly as today (D27,
carried over verbatim). Replaying a cursor under a different filter set is therefore not detected;
the spec's edge cases require detection only for a direction mismatch, and adding filters to the
cursor would change a shape D27 fixes.

---

## 3. Refresh freshness — unchanged data, conditional reporting

`{ lastSyncedAt, activeJobId }` still comes from `comment_sync_targets` / `comment_sync_jobs` via
the existing `CommentRepository.getSyncStatus(workspaceId, postId)`, which is unchanged. What is new
is when it is read at all: **only when the selection names a post** (FR-006), whichever other
filters accompany it. With no post named the repository call does not happen and the field is absent
from the response — absent, not `null` (R-08).

---

## 4. Repository interface delta

```
- listTopLevelByPost(workspaceId, postId, pagination)
- listRepliesByParent(workspaceId, parentCommentId, pagination)
- listByAccount(workspaceId, socialAccountId, filters, pagination)
+ list(workspaceId, selection, pagination)
```

Everything else on `CommentRepository` is untouched: `getById`, `getSyncStatus`,
`findByIdempotencyKey`, `insertQueued` and the five conditional write transitions all keep their
signatures and their behaviour. The write side of this service is not in scope (spec Assumptions).

Two invariants the replacement inherits rather than restates, because they live in the shared
`listByPredicate` helper both old and new callers go through:

- **Visibility (FR-007)**: `status <> 'deleted' OR reply_count > 0` is applied to every list,
  unchanged — a deleted comment stays listed while replies still hang off it, so a thread never
  loses its root.
- **Keyset paging (D27, SC-003)**: the comparison is the Postgres row comparison
  `(occurred_at, id) < (cursor)` / `>` , which is what makes both directions correct across
  concurrent inserts. `limit + 1` rows are read to decide `nextCursor`.

`ListByAccountFilters` grows into the full selection type and moves with it; the `since`/`until`/
`isOwn` conditions it already builds are three of the eight the new builder assembles.

---

## 5. What this feature does **not** touch

Stated because each is a place a listing change could plausibly leak into, and none may:

- No new column, no new table, no foreign key — in particular none from `comments` to the
  platform-core projection (D8, D29, Principle II). `postId` staying resolvable is still not a
  condition of a comment being listed (acceptance 1.4).
- No change to the comment state machine, to the outbox, or to any write path — `POST` still returns
  `202 queued` and nothing in Principle III moves.
- No status filter. A caller's own `queued`/`processing`/`failed` comments are listed by the
  existing visibility rule alone (spec Assumptions).
- No change to the `Comment` wire representation (§6.2). The collection returns the same objects the
  removed routes returned.
