# Meta spikes (T070)

These three scripts answer S1, S2 and S5 (spec.md §17) — the three Meta behaviours §2.3 leaves
unverified and that the webhook intake, its normalizer, its worker, and the Instagram read path
are not safely written against until they are answered (research.md R-09). They run against your
own Meta App; the credentials never pass through the Claude session that wrote them, so **you run
these yourself** and paste the verdict lines (and any surprising output) back into the report.

Each script is read-only against Meta — no post, no subscription change, no mutation — and prints
one line starting with `SPIKE S<n> VERDICT:` at the end. Grep for that line if you only want the
answer; the lines above it are what the answer is based on.

No script prints a token, secret, or signature in full — only a fingerprint (first/last four
characters). Full command output is still safe to paste into a report.

## Before you run any of them

```bash
pnpm typecheck   # scripts/**/*.ts is included
pnpm exec oxlint  # unscoped
```

Run each script once with no environment set first — the failure should name exactly which
variable is missing and point at this file. That's what "actionable" means here; if a script ever
fails some other way (a stack trace, an unclear message), that's a bug in the script, not a spike
result.

## S1 — Facebook Page feed webhooks under Standard Access

**Answers:** is the Page access token valid for this app with the right scopes, and is the Page
actually subscribed to the `feed` field for this app. **Does not answer:** whether a real
(non-role) user's comment is delivered to the deployed endpoint — only posting one and watching
the endpoint can. The script says this in its own output; it is not hidden in this README.

| Variable | What it is |
|---|---|
| `META_APP_ID` | The Meta App's numeric ID (App Dashboard → Settings → Basic). |
| `META_APP_SECRET` | The App Secret (same page). Used only to build the inspecting token for `debug_token`; never sent anywhere but graph.facebook.com. |
| `META_PAGE_ID` | The Facebook Page under test. |
| `META_PAGE_ACCESS_TOKEN` | A long-lived Page access token for that Page, with `pages_manage_metadata` and `pages_show_list`. |
| `META_GRAPH_API_VERSION` | Optional, defaults to `v21.0`. |

```bash
META_APP_ID=... META_APP_SECRET=... META_PAGE_ID=... META_PAGE_ACCESS_TOKEN=... \
  pnpm tsx scripts/spikes/s1-facebook-page-feed-webhooks.ts
```

**Pass** looks like:

```
SPIKE S1 VERDICT: token valid + feed subscribed (delivery from real users still unverified — see note above)
```

**Fail** (token invalid, wrong app, missing scopes, or `feed` not subscribed) prints the specific
gap instead, e.g. `token_valid=true feed_subscribed=false missing_scopes=(none)`.

**Paste back:** the full output (both `debug_token` and `subscribed_apps` lines plus the verdict).
If the verdict is a pass, S1 is still incomplete until you separately post a real comment from an
account with no role on the app and confirm (or don't) a delivery at the deployed endpoint — note
whether you did that and what happened.

## S2 — Instagram comment reads per login variant

**Answers:** whether `GET /{media-id}/comments` returns data for `facebook_login`
(`graph.facebook.com`) and for `instagram_login` (`graph.instagram.com`), against the same media.
An HTTP 200 with an empty `data` array is a **result** (the call works, nothing came back), not a
failure — the verdict line says which one happened, don't conflate them when you paste this back.

| Variable | What it is |
|---|---|
| `META_IG_MEDIA_ID` | An Instagram media ID with at least one comment, ideally more (so an empty result is informative rather than expected). Read via the media's `id` field or the Graph API Explorer. |
| `META_FACEBOOK_LOGIN_TOKEN` | The long-lived Page access token that also covers the linked IG professional account (D28's `facebook_login` variant). |
| `META_INSTAGRAM_LOGIN_TOKEN` | A long-lived Instagram user token with `instagram_business_manage_comments` (D28's `instagram_login` variant). |
| `META_GRAPH_API_VERSION` | Optional, defaults to `v21.0`. |

```bash
META_IG_MEDIA_ID=... META_FACEBOOK_LOGIN_TOKEN=... META_INSTAGRAM_LOGIN_TOKEN=... \
  pnpm tsx scripts/spikes/s2-instagram-comment-reads.ts
```

This writes the raw response body from each call to
`src/platforms/meta/__fixtures__/s2-facebook-login-comments.json` and
`s2-instagram-login-comments.json` — verbatim, pretty-printed only. **Commit these two files** with
your `spec.md` update; T097 replays them as fixtures for a parameterized test, so they need to be
what Meta actually returned, not a hand-written shape.

**Pass** (at least one variant readable) looks like:

```
SPIKE S2 VERDICT: facebook_login → 7 comments (HTTP 200), instagram_login → 0 comments (HTTP 200)
```

**Both empty** is a valid, documented outcome — per §17, it means Instagram stays fixture-tested
and the live demo relies on Facebook and Bluesky. The script prints that framing explicitly; carry
it into `spec.md` §17 and `DESIGN.md` (T110) rather than reporting it as "S2 failed".

**HTTP error** (bad token, wrong media ID, permission denied) reports the status and Meta's error
message instead of a comment count — that is a genuine failure to investigate, unlike an empty
`data` array.

**Paste back:** the full output and confirmation the two fixture files were written (the script
prints their paths).

## S5 — which secret signs Instagram Login webhook deliveries

**Answers:** whether `META_APP_SECRET` or `META_APP_SECRET_INSTAGRAM` produces the
`X-Hub-Signature-256` on a delivery you actually received for an `instagram_login` account. This
needs a real captured delivery — there is no way to derive the answer without one.

### Capturing a delivery

You need the exact raw request body your webhook receiver got, and the `X-Hub-Signature-256`
header that came with it, for one delivery to an `instagram_login`-linked subscription. Options:

- If you already have a webhook receiver running (even a throwaway one, e.g.
  `pnpm dlx localtunnel` + a one-line HTTP server that dumps the raw body and headers to disk),
  trigger a test event from the App Dashboard's Webhooks page for the Instagram product and let it
  land there.
- Any capture tool that preserves the exact bytes (not a re-serialized JSON copy — the HMAC is
  computed over the raw body, so re-indenting or re-ordering keys breaks the match) works equally
  well.

Save the raw body to a file (any path) and copy the header value.

| Variable | What it is |
|---|---|
| `META_APP_SECRET` | From `.env.example` / the App Dashboard. |
| `META_APP_SECRET_INSTAGRAM` | From `.env.example` / the App Dashboard (Instagram product's own secret, if configured separately). |

```bash
META_APP_SECRET=... META_APP_SECRET_INSTAGRAM=... \
  pnpm tsx scripts/spikes/s5-instagram-webhook-signing-secret.ts \
  --body-file ./captured-delivery-body.json \
  --signature 'sha256=<the header value>'
```

**Pass** looks like:

```
SPIKE S5 VERDICT: signature matches META_APP_SECRET_INSTAGRAM only
```

**No match** means the captured body or signature is stale, was re-serialized somewhere along the
way, or truncated — recapture rather than treating it as "neither secret works".

**Paste back:** the full output (both `MATCH` / `no match` lines and the verdict). Whichever secret
matches is what the webhook verifier (not yet built) must use for `instagram_login` deliveries;
carry that into `spec.md` §17.
