# Contract: Domain Events

**Feature**: [../spec.md](../spec.md) | **Source**: `spec.md` §9.1

This is what the rest of the platform consumes — DM automations, the inbox UI, analytics. Consumers
are not implemented here (§14); the contract and a test for it are (D9).

## Envelope

```json
{ "id": "0191e2c4-...", "type": "comment.received", "version": 1,
  "occurredAt": "2026-09-11T12:34:56Z", "workspaceId": "...", "data": { } }
```

## Types and payloads

| Type | `data` |
|------|--------|
| `comment.received` | `commentId`, `socialAccountId`, `platform`, `postId`, `platformPostId`, `parentCommentId`, `isOwn`, `authorPlatformId`, `text`, `ingestionSource` (`webhook` / `sync` / `backfill`) |
| `comment.posted` | `commentId`, `socialAccountId`, `platform`, `postId`, `parentCommentId`, `platformCommentId` |
| `comment.failed` | `commentId`, `errorCode`, `errorMessage` |
| `comment.deleted` | `commentId`, `socialAccountId`, `platform` |

Each payload carries enough for a consumer to act without reading this service's storage (FR-024).

## Delivery guarantees

- **Written in the same transaction as the state change it describes** — an event exists only if the
  change was durably recorded, and a use case never publishes to the queue directly (D9, FR-025).
- **Relayed after commit**: a job runs every second, selects unpublished rows with
  `FOR UPDATE SKIP LOCKED` in batches of 100, publishes them and stamps `published_at`.
- **At least once**, with a stable identity — the queue job id is the event id, so consumers can
  de-duplicate on it and MUST be idempotent (FR-025).
- **Survives losing the queue**: an unpublished event lives in PostgreSQL, so restarting Redis
  replays rather than drops (FR-033, SC-011).

## Two distinctions consumers depend on

- `isOwn` — the account's own comments must never trigger an automation, and "own" is decided by
  author identity, not by whether the comment was created through this service (A2, §2.2).
- `ingestionSource: "backfill"` — comments found by a post's *first* refresh walk are history, not
  news. A consumer that ignores backfill will not reply to a month-old conversation the moment an
  account is connected (A10, FR-020).

## Versioning

`version` is `1`. A backward-compatible addition adds an optional field; anything else is a new
`type` or a bumped `version`, never a changed meaning for an existing field.
