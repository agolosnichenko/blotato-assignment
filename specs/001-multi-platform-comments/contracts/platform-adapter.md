# Contract: Platform Adapter Port

**Feature**: [../spec.md](../spec.md) | **Source**: `spec.md` §4.3, §8

This is the seam that makes Principle IV testable. Every platform implements the same port; use cases
never branch on platform, and never on the Instagram `auth_variant` (D28) — the Graph client resolves
host and token from it internally.

## The port

```ts
interface CommentPlatformAdapter {
  readonly platform: Platform;
  listComments(ctx: AccountContext, target: PostTarget, cursor?: string): Promise<CommentPage>;
  publishComment(ctx: AccountContext, input: PublishInput): Promise<PublishedComment>;
  findPublishedComment(ctx: AccountContext, probe: ReconcileProbe): Promise<PublishedComment | null>;
  fetchComment(ctx: AccountContext, platformCommentId: string): Promise<NormalizedComment | null>;
}
```

- `AccountContext` carries the connected account and its credentials, obtained from the
  `AccountCredentials` port — never read from a table inside an adapter (D26).
- `NormalizedComment`: `platformCommentId`, `platformParentId | null`, `authorPlatformId`,
  `authorUsername`, `authorDisplayName`, `text`, `platformCreatedAt`, `platformMeta` (jsonb — e.g.
  the Bluesky `cid`).
- `fetchComment` is what lets ingestion walk up an unknown ancestry rather than store an orphan
  (FR-022).
- `findPublishedComment` is the exactly-once guarantee in method form: given an author, a text and a
  time window opening at `last_attempt_started_at − 2 min`, it answers whether our comment is already
  on the platform (FR-011, SC-001).

## Typed errors — the contract every adapter must honour

| Error | Raised when | What the worker does |
|-------|-------------|----------------------|
| `RetryableError` | 429, 5xx, or a network failure *before* the request was sent; may carry `retryAfter` | Back to `queued`, backoff 1s / 4s / 16s / 64s / 256s, up to 6 attempts, honouring `retryAfter` |
| `OutcomeUnknownError` | timeout or connection drop *after* the request was sent | `findPublishedComment` first; found → `posted`; not found → treat as retryable |
| `PermanentError` | 4xx, an explicit platform rejection | `failed` with a code; the quota reservation is released |
| `AuthError` | the credential is invalid | `failed` with a code; the quota reservation is released; the account is marked `disconnected` and its work stops (A19) |

Classifying a post-send failure as `RetryableError` is the one mistake that produces a duplicate
public reply. An adapter that cannot tell "not sent" from "sent, answer lost" must report
`OutcomeUnknownError`.

## Webhook normalization (Meta only)

A separate `WebhookNormalizer` port turns a verified raw payload into a list of `IngestionEvent`
(`upsert` or `delete`). Signature verification happens over the raw bytes before parsing and before
this port is reached (R-04). An event for an account this service does not know is recorded as
unprocessable and acknowledged, not retried.

## Capability registry

Every platform — including the six without comment support — has an entry (§8.1, FR-031):

| Platform | Comments | Top-level | Reply | `maxReplyDepth` | Text limit | Ingestion |
|----------|----------|-----------|-------|-----------------|------------|-----------|
| instagram | yes | yes | yes | 1 | 2200 characters | webhook + sync |
| facebook | yes | yes | yes | 1 | 8000 characters | webhook + sync |
| bluesky | yes | yes | yes | unbounded (`null`) | 300 graphemes | sync (polling) |
| threads, x, linkedin, youtube, tiktok, pinterest | no | — | — | — | — | — |

The registry is the *only* place a use case learns a platform difference: depth checks (D12), text
limits and their counting unit (R-07), and whether a write is possible at all all read from it.

## Adding a platform

An adapter implementing the four methods and the four error types, plus a registry entry. No database
migration, no change to the REST contract, no new branch in a use case (SC-009, Principle IV). The
third platform is the proof: Bluesky has unbounded nesting where Meta has one level, counts graphemes
where Meta counts characters, and has no push channel at all.

## Platform-specific notes

**Meta (Instagram + Facebook)** — two login variants (D28): `facebook_login` uses a long-lived Page
token against `graph.facebook.com`; `instagram_login` uses a long-lived Instagram user token against
`graph.instagram.com`. Read and write shapes are identical, so only the client's host and token
selection differ. Instagram reads top-level comments with a `replies` expansion; Facebook reads
`comments?filter=stream`. Rate-limit headers (`X-Business-Use-Case-Usage`, `X-App-Usage`) are parsed
and throttle that account's jobs. A comment is "own" when `from.id` matches the account.

**Bluesky** — session from handle plus app password, refreshed inside the adapter.
`platform_post_id` and `platform_comment_id` are AT URIs, with `cid` in `platform_meta`. Reads use
`getPostThread`, loading truncated branches; writes use `createRecord` with `reply: { root, parent }`.
Link and mention facets are detected automatically. A comment is "own" when the author DID matches.
Deletion has two signals, not one: a `notFoundPost` marker in the returned thread is an explicit
tombstone and may mark that comment deleted on its own, while absence still requires a complete walk
(FR-019). The explicit marker is the faster of the two and must not be discarded as noise.

**Unverified behaviour** — S1 (Facebook Page feed events under Standard Access), S2 (Instagram
comment reads per login variant) and S5 (which secret signs Instagram Login events) must be run
before the code they gate is written (Principle I, R-09).
