# REST Contract Delta: Workspace-wide comment listing and authenticated API docs

**Feature**: `002-flat-comment-listing` | **Date**: 2026-09-14

A delta against [001's `contracts/rest-api.md`](../../001-multi-platform-comments/contracts/rest-api.md)
and root `spec.md` §6.1. Everything not named here is unchanged — including the `Comment`
representation (§6.2), the error catalogue (§6.3), the `202`/`Location` write contract, the
`Idempotency-Key` handling, and the rate-limit headers.

`openapi.json` is generated from the Zod route schemas and is the machine-readable form of this
document; CI fails if the committed file drifts from the routes (FR-011, D18).

---

## 1. Removed — no alias, no redirect, no deprecation period (FR-009)

| Method and path | Was | Now |
|-----------------|-----|-----|
| `GET /v1/posts/:postId/comments` | a post's top-level comments + `sync` | `404 NOT_FOUND` |
| `GET /v1/comments/:commentId/replies` | direct replies | `404 NOT_FOUND` |
| `GET /v1/accounts/:accountId/comments` | one account's inbox | `404 NOT_FOUND` |

The `404` is the service's existing `setNotFoundHandler` answering an unregistered route, in
`application/problem+json` with `code: NOT_FOUND`, like any other unknown path.

`POST /v1/posts/:postId/comments` and `POST /v1/comments/:commentId/replies` keep their addresses —
the two path collisions are method-level only, and writes stay addressed to their target (D31).

## 2. Unchanged (FR-010)

**Published operations** — present in `openapi.json` under these exact addresses:
`POST /v1/posts/:postId/comments`, `POST /v1/comments/:commentId/replies`,
`POST /v1/posts/:postId/comments/sync`, `GET /v1/comment-sync-jobs/:jobId`,
`GET /v1/comments/:commentId`, `GET /v1/platforms`, `GET /healthz`, `GET /readyz`.

**Served but not published** — reachable, and unchanged, but not operations in the document:
`GET|POST /webhooks/meta` and `GET /openapi.json` are registered `hide: true`; `GET /docs` and its
assets are served by the Swagger UI plugin. §4 explains why this distinction is load-bearing rather
than incidental.

---

## 3. Added — `GET /v1/comments`

The workspace's comments across every connected account and every post. Authenticated with
`blotato-api-key`; the workspace is the key's, and is never a parameter.

### Query parameters — all optional, all combinable

| Parameter | Type | Default | Meaning |
|-----------|------|---------|---------|
| `postId` | uuid | — | comments on one internal post |
| `parentCommentId` | uuid | — | direct replies to one comment |
| `accountId` | uuid | — | one connected account |
| `platform` | string, **repeatable** | — | one or more platforms; several occurrences are a union |
| `topLevelOnly` | `true` \| `false` | — | `true` selects comments with no parent |
| `isOwn` | `true` \| `false` | — | authored by us, or not |
| `since` | ISO 8601 | — | inclusive lower bound on `occurredAt` |
| `until` | ISO 8601 | — | inclusive upper bound on `occurredAt` |
| `order` | `asc` \| `desc` | `desc` | scan direction |
| `limit` | integer 1–100 | `20` | page size |
| `cursor` | opaque string | — | from a previous response's `nextCursor` |

**Filters intersect.** No filter overrides another. A combination no comment can satisfy —
`topLevelOnly=true` with `parentCommentId`, or a `postId` with a parent on a different post — is a
valid request answered with an empty page, not a `400` (FR-002).

**`order` defaults to `desc` for every selection.** The replies read, which defaulted to `asc` at
its own address (D27 as first written), now asks for `order=asc` explicitly — D31 supersedes that
half of D27 and leaves its cursor mechanism untouched (research R-06).

### Response `200`

```json
{
  "items": [ { "...": "Comment, §6.2, unchanged" } ],
  "nextCursor": "eyJvY2N1cnJlZEF0Ijoi... | null",
  "sync": { "lastSyncedAt": "2026-09-14T09:12:00Z | null", "activeJobId": "uuid | null" }
}
```

`sync` is present **if and only if `postId` is among the filters**, whichever other filters
accompany it. With no post named the key is absent from the body — not `null` (FR-006).

`nextCursor` is `null` on the last page. Paging forward with it walks the whole history exactly once
under concurrent inserts (SC-003, D27).

### Failures

| HTTP | `code` | When |
|------|--------|------|
| `400` | `VALIDATION_ERROR` | malformed or truncated cursor; cursor minted under the other `order`; `limit` outside 1–100; a `platform` value that is not a key of the capability registry; a malformed uuid or timestamp |
| `401` | `UNAUTHORIZED` | missing, unrecognized or revoked key |
| `404` | `NOT_FOUND` | `postId`, `accountId` or `parentCommentId` that does not exist **or belongs to another workspace** — never `403`, never an empty `200` (D20, FR-004) |
| `429` | `RATE_LIMITED` | the per-key read budget |

Values that are individually valid never produce a `400`, however they combine. A `since` later than
`until` is an empty `200`.

### Behaviour worth stating because it is testable

- With no identifier-shaped filter, the service calls **no** other service's port (FR-005). The
  workspace of the key is the entire scope.
- A comment whose `postId` no longer resolves in the local projection of the publishing service's
  data is still returned (FR-008, acceptance 1.4). There is no join and no existence check.
- A `deleted` comment is listed only while it still has replies beneath it (FR-007) — unchanged from
  the removed routes.
- A caller's own `queued` / `processing` / `failed` comments appear alongside ingested ones, so a
  write can be followed in the view it was made from.
- A known platform that does not support comments (say `tiktok`) is an accepted `platform` value
  that simply matches nothing.

---

## 4. Authentication, as published (US3, FR-011, FR-012)

The OpenAPI document declares the scheme the service actually enforces, so the Swagger UI at
`/docs` can authorize and invoke:

```yaml
components:
  securitySchemes:
    apiKey: { type: apiKey, name: blotato-api-key, in: header }
security:
  - apiKey: []          # applies to every operation …
```

… except the routes that authenticate another way or are public by decision. The authentication hook
exempts six; the document can annotate only the two that are operations in it, and each entry records
which it is:

| Exempt route | Why exempt | Published? | In the document |
|--------------|------------|------------|-----------------|
| `GET /healthz` | infrastructure probe | yes | operation with `security: []` |
| `GET /readyz` | infrastructure probe | yes | operation with `security: []` |
| `GET /webhooks/meta` | `hub.verify_token` handshake | no (`hide: true`) | absent |
| `POST /webhooks/meta` | HMAC over the raw body | no (`hide: true`) | absent |
| `GET /openapi.json` | the document itself | no (`hide: true`) | absent |
| `GET /docs`, `/docs/*` | plugin-served UI assets | no (not a service route) | absent |

The exempt list has **one** source: the `PUBLIC_ROUTES` array the authentication hook enforces, each
entry carrying a `published` flag. The document's `security: []` annotations are derived from the
published entries, and the test asserts both directions — a published entry must have a cleared
operation, an unpublished one must have no operation at all — so neither the described list nor the
published surface can drift from what is enforced (FR-012, SC-007).

Publishing the webhook operations was considered and rejected: they carry no request schema a
reviewer could exercise, they authenticate by signature rather than by key, and publishing them would
widen feature 001's published surface for no reviewer benefit. Acceptance scenario 3.3 names the two
probes accordingly.

---

## 5. Corrections to the 001 contract carried by this change

- **Rate limiting.** The 001 document says limits are keyed by internal post identifier. They are
  not: the service keys two buckets, read and write, on the resolved API key id, the bucket chosen
  by HTTP method. The document is corrected to the code (spec Assumptions).
- **Root `spec.md` §6.1** loses the three removed rows and gains `GET /v1/comments`; §18 records
  **D31**, which narrows D11, D13, D27, A3 and A10a there, and revises feature 001's FR-001, FR-003,
  FR-006 and FR-008. Both edits land **before** the code diverges (Principle I, FR-014) — done, so
  the root document and this delta now describe the same API.
