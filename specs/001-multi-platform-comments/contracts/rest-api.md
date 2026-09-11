# Contract: Public REST API

**Feature**: [../spec.md](../spec.md) | **Source**: `spec.md` §6 | **Generated form**: `openapi.json`,
produced from the Zod route schemas and drift-checked in CI (D18, R-03).

Base path `/v1`. JSON, `camelCase`. Authentication: the `blotato-api-key` header (A16), resolved to a
workspace; every read and write is scoped to it, and another workspace's resource is `404`, never
`403` (D20, FR-026). Errors are RFC 9457 `application/problem+json` carrying a machine-readable
`code` (FR-032). Responses carry `RateLimit-*` and, on rejection, `Retry-After` (FR-027).

## Endpoints

| Method and path | Purpose | Success response |
|-----------------|---------|------------------|
| `GET /v1/posts/:postId/comments` | A post's top-level comments. Query: `limit` 1–100 (default 20), `cursor`, `order` (default `desc`) | `200 { items: Comment[], nextCursor, sync: { lastSyncedAt, activeJobId } }` |
| `GET /v1/comments/:commentId/replies` | Direct replies. Query: `limit`, `cursor`, `order` (default `asc`) | `200 { items: Comment[], nextCursor }` |
| `GET /v1/comments/:commentId` | One comment — the polling target for a pending write | `200 Comment` |
| `GET /v1/accounts/:accountId/comments` | Account inbox across internal and external posts. Query: `limit`, `cursor`, `since`, `until`, `isOwn`, `order` (default `desc`) | `200 { items: Comment[], nextCursor }` |
| `POST /v1/posts/:postId/comments` | Top-level comment. Body `{ text }`, optional `Idempotency-Key` | `202 Comment` with `status: "queued"` + `Location` |
| `POST /v1/comments/:commentId/replies` | Public reply. Body `{ text }`, optional `Idempotency-Key` | `202 Comment` with `status: "queued"` + `Location` |
| `POST /v1/posts/:postId/comments/sync` | Request an immediate refresh | `202 SyncJob` |
| `GET /v1/comment-sync-jobs/:jobId` | Refresh job status | `200 SyncJob` |
| `GET /v1/platforms` | Capability registry, all nine platforms | `200 { items: PlatformCapabilities[] }` |
| `GET /webhooks/meta` | Subscription verification: `hub.verify_token` is compared against the configured value first, and only then is `hub.challenge` echoed; a wrong or missing token is `403` and echoes nothing | `200 text/plain` |
| `POST /webhooks/meta` | Event intake, signature verified over the raw body first | `200` |
| `GET /healthz`, `GET /readyz` | Liveness / readiness (PostgreSQL + Redis) | `200` / `503` |
| `GET /docs`, `GET /openapi.json` | Swagger UI and the document | |

`202` rather than `201` is deliberate: the row exists, the platform action has not happened yet
(A11, FR-009).

A top-level comment on a post not published through the platform is unreachable by construction, not
by a special rule: both `POST` and `GET /v1/posts/:postId/...` are keyed by the internal `postId`,
which such a post does not have, so the request is `404 NOT_FOUND`. Replies to comments on those
posts are addressed by `commentId` and remain available (A7, D13, FR-015).

## `Comment`

```json
{
  "id": "0191e2c4-...",
  "accountId": "...",
  "platform": "instagram",
  "postId": "... | null",
  "platformPostId": "17851234567890",
  "parentCommentId": "... | null",
  "platformCommentId": "17899876543210 | null",
  "depth": 0,
  "isOwn": false,
  "author": { "platformId": "1784000000", "username": "jane", "displayName": null },
  "text": "Love this!",
  "status": "posted",
  "error": null,
  "replyCount": 2,
  "occurredAt": "2026-09-11T12:34:56Z",
  "createdAt": "2026-09-11T12:35:01Z",
  "updatedAt": "2026-09-11T12:35:01Z"
}
```

- `error` is `{ "code": "...", "message": "..." }` when `status` is `failed`, otherwise null.
- A deleted comment that still has live replies appears with `status: "deleted"`, `text: null` and a
  null author; a deleted comment with no replies is omitted entirely (A4, FR-005).
- `postId` is null for comments on posts not published through the platform (D13), and only then. If
  the `posts` row stops resolving, `postId` keeps the value it was stored with: the service does not
  track the other service's deletions, and a read never calls a port per comment to find out (A10a,
  §5.1). What changes is the route — `GET /v1/posts/:postId/comments` becomes `404` while the
  comments stay reachable through the account inbox.

## `SyncJob`

`{ id, status, trigger, stats: { fetched, inserted, updated, deleted }, error, createdAt, startedAt, finishedAt }`.

Manual refresh semantics (D19, FR-021): an active job exists → `202` carrying that job; inside the
60-second cooldown → `429 SYNC_COOLDOWN`; a deactivated target is run anyway and its schedule is
restored on success.

## `PlatformCapabilities`

`{ platform, supportsComments, canCreateTopLevel, canReply, maxReplyDepth, textLimit, textUnit,
ingestion, unsupportedReason }` — see [data-model.md](../data-model.md) §4. All nine publishing
platforms are listed; the six without comment support carry a `unsupportedReason` (FR-031).

## Pagination

`nextCursor` is an opaque base64url string encoding the keyset position `(occurredAt, id)` and the
ordering direction. It is stable while rows are inserted, and replaying it with a different `order`
is `400 VALIDATION_ERROR` rather than a silent re-order (A13, D27, FR-004, SC-002).

## Error codes

| HTTP | `code` | When |
|------|--------|------|
| 400 | `VALIDATION_ERROR` | Invalid body, query or cursor — including a cursor replayed under a different `order` |
| 401 | `UNAUTHORIZED` | Missing, unrecognized or revoked key |
| 404 | `NOT_FOUND` | The resource does not exist, or belongs to another workspace |
| 409 | `IDEMPOTENCY_KEY_REUSED` | The same `Idempotency-Key` with a different body |
| 422 | `PLATFORM_NOT_SUPPORTED` | The platform does not support comments |
| 422 | `REPLY_DEPTH_EXCEEDED` | Deeper than `maxReplyDepth`; `detail` names the top-level comment |
| 422 | `TEXT_TOO_LONG` | Over the platform's limit, counted in the platform's unit |
| 422 | `PARENT_NOT_POSTED` | The parent is `queued`, `processing`, `failed` or `deleted` |
| 422 | `ACCOUNT_DISCONNECTED` | The connected account is disconnected |
| 422 | `QUOTA_EXCEEDED` | The monthly audience-contact allowance is exhausted |
| 429 | `RATE_LIMITED` | Per-key rate limit |
| 429 | `SYNC_COOLDOWN` | Manual refresh requested inside the cooldown |

Asynchronous failure codes carried on a `failed` comment: `PLATFORM_REJECTED`,
`PLATFORM_AUTH_FAILED`, `PLATFORM_RATE_LIMITED`, `PARENT_DELETED`, `OUTCOME_UNKNOWN`.

## Contract stability

Adding a platform adds rows to `GET /v1/platforms` and nothing else — no new endpoint, no new field,
no migration (SC-009, Principle IV). Breaking changes go behind a new path prefix (A14).
