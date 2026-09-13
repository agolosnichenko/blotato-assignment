# Getting the credentials the spikes need

Step-by-step companion to [README.md](README.md), which says *what* each variable is. This says
*where it comes from*. Meta renames dashboard sections regularly, so section names below are what
to look for, not a guarantee of the exact label you will see.

Nothing here is needed by the service itself — these are one-off reads against your own Meta App to
answer S1, S2 and S5 (`spec.md` §17). None of these values belong in a commit.

## 0. Keep the secrets out of the repo

Put them in `.env.spike` at the repo root (`.gitignore` covers `.env.*`, and only `.env.example` is
exempt), then load it for one command:

```bash
set -a; source .env.spike; set +a
pnpm tsx scripts/spikes/s2-instagram-comment-reads.ts
```

`set -a` exports every assignment that follows, so the script inherits them without you pasting
tokens onto a command line — where they land in `~/.zsh_history` and in every `ps` listing on the
machine. Skeleton:

```bash
META_APP_ID=
META_APP_SECRET=
META_APP_SECRET_INSTAGRAM=
META_PAGE_ID=
META_PAGE_ACCESS_TOKEN=
META_IG_MEDIA_ID=
META_FACEBOOK_LOGIN_TOKEN=
META_INSTAGRAM_LOGIN_TOKEN=
```

## 1. What you need to exist before any of this

- A Facebook **Page** you administer.
- An Instagram **professional** account (Business or Creator — a personal account has no comments
  API), linked to that Page. Instagram app → Settings → Account type and tools.
- At least one Instagram post on that account **with a real comment on it**. Post something and
  comment on it from a second account; a post with zero comments makes S2's result ambiguous.
- A Meta App of type **Business** at <https://developers.facebook.com/apps>, with the products
  **Facebook Login**, **Instagram** and **Webhooks** added.

## 2. `META_APP_ID`, `META_APP_SECRET` — the app's own identity

App Dashboard → **App settings → Basic**.

- `META_APP_ID` is the numeric **App ID** at the top.
- `META_APP_SECRET` is **App secret** → *Show* (asks for your password).

## 3. `META_APP_SECRET_INSTAGRAM` — the Instagram product's secret

App Dashboard → **Instagram → API setup with Instagram login**. That panel has its own **Instagram
app secret** next to the Instagram app ID.

If the panel shows no separate secret (the app only uses Instagram API with Facebook Login), set
`META_APP_SECRET_INSTAGRAM` to the same value as `META_APP_SECRET`. S5 then reports that both
candidates match, which is itself the answer: there is one signing secret, not two.

> **Why S5 exists at all.** Meta documents `X-Hub-Signature-256` as being computed with "your app
> secret", but an app wired for Instagram Login has *two* secrets, and the docs do not say which one
> signs those deliveries. Guessing wrong produces a verifier that rejects every real delivery while
> passing its own unit tests — which is exactly the class of bug the gate on this spike prevents.

## 4. `META_PAGE_ID`

Page → **About**, or the **Page ID** shown in Meta Business Suite. Via the API, after step 5:
`GET /me/accounts` returns `id` alongside `name` for every Page you administer.

## 5. `META_PAGE_ACCESS_TOKEN` — a long-lived Page token

This is the one people get wrong, because the Graph API Explorer hands out a **short-lived user**
token by default and it expires in about an hour.

### 5a. A user token with the right scopes

<https://developers.facebook.com/tools/explorer> → pick your app → **User token** → add permissions:

| Scope | Needed for |
|---|---|
| `pages_show_list` | S1's `debug_token` check |
| `pages_manage_metadata` | S1's `subscribed_apps` read |
| `pages_read_engagement` | reading Page content |
| `instagram_basic` | the linked IG account (S2, `facebook_login`) |
| `instagram_manage_comments` | IG comment reads (S2, `facebook_login`) |

Click **Generate Access Token** and approve the dialog.

### 5b. Exchange it for a long-lived user token (~60 days)

```bash
curl -sG 'https://graph.facebook.com/v21.0/oauth/access_token' \
  --data-urlencode 'grant_type=fb_exchange_token' \
  --data-urlencode "client_id=$META_APP_ID" \
  --data-urlencode "client_secret=$META_APP_SECRET" \
  --data-urlencode 'fb_exchange_token=<short-lived token from 5a>'
```

### 5c. Derive the Page token from it

```bash
curl -sG 'https://graph.facebook.com/v21.0/me/accounts' \
  --data-urlencode 'access_token=<long-lived user token from 5b>' | jq '.data[] | {id, name}'
```

Add `access_token` to that `jq` selection to read the Page tokens themselves. A Page token derived
from a **long-lived** user token does not expire on a timer — which is why 5b cannot be skipped.
That value is `META_PAGE_ACCESS_TOKEN`.

Verify before running S1:

```bash
curl -sG 'https://graph.facebook.com/v21.0/debug_token' \
  --data-urlencode "input_token=$META_PAGE_ACCESS_TOKEN" \
  --data-urlencode "access_token=$META_APP_ID|$META_APP_SECRET" | jq '.data | {type, expires_at, scopes}'
```

`type: "PAGE"` and `expires_at: 0` is what you want. S1 runs this same check itself — doing it by
hand first separates "the token is wrong" from "the script is wrong".

### 5d. Subscribe the Page to the `feed` field

S1 only *reads* the subscription; it never creates one, so this is a manual step. App Dashboard →
**Webhooks → Page** → subscribe to **feed**. Or:

```bash
curl -X POST "https://graph.facebook.com/v21.0/$META_PAGE_ID/subscribed_apps" \
  -d 'subscribed_fields=feed' -d "access_token=$META_PAGE_ACCESS_TOKEN"
```

The Webhooks product needs a callback URL that answers the `hub.challenge` handshake before it
accepts a subscription. Our intake endpoint is unbuilt (that is what S1 unblocks), so use a
throwaway receiver — see §7.

## 6. `META_FACEBOOK_LOGIN_TOKEN`, `META_INSTAGRAM_LOGIN_TOKEN`, `META_IG_MEDIA_ID`

D28 says an Instagram account reaches us through one of two login variants, and the spec does not
assume they read comments identically. S2 calls the **same media** through both so the difference is
observed, not assumed.

### `META_FACEBOOK_LOGIN_TOKEN`

The Page token from step 5 — provided the scopes in 5a included `instagram_basic` and
`instagram_manage_comments`. Same string as `META_PAGE_ACCESS_TOKEN`; the variable is separate
because the two are conceptually different credentials that happen to coincide here.

### `META_IG_MEDIA_ID`

```bash
# the IG professional account linked to the Page
curl -sG "https://graph.facebook.com/v21.0/$META_PAGE_ID" \
  --data-urlencode 'fields=instagram_business_account' \
  --data-urlencode "access_token=$META_PAGE_ACCESS_TOKEN"

# its recent media, newest first
curl -sG "https://graph.facebook.com/v21.0/<ig-user-id>/media" \
  --data-urlencode 'fields=id,permalink,comments_count' \
  --data-urlencode "access_token=$META_PAGE_ACCESS_TOKEN" | jq '.data[:5]'
```

Pick an `id` whose `comments_count` is greater than zero.

### `META_INSTAGRAM_LOGIN_TOKEN` — Instagram API with Instagram Login

A different OAuth flow, against `api.instagram.com` / `graph.instagram.com` rather than Facebook.

1. App Dashboard → **Instagram → API setup with Instagram login → Business login settings**. Add a
   redirect URI; `https://localhost/` is fine since you copy the `code` out of the URL bar by hand.
2. Same panel, *Generate token* against your IG account is the short path — if it is offered, use it
   and skip to step 5.
3. Otherwise open the **Embed URL** from that panel with
   `scope=instagram_business_basic,instagram_business_manage_comments`, authorize, and copy `code`
   from the redirect URL (it is single-use and expires in about an hour).
4. Exchange the code, then upgrade to long-lived (60 days):

```bash
curl -X POST 'https://api.instagram.com/oauth/access_token' \
  -d 'client_id=<instagram app id>' \
  -d 'client_secret=<instagram app secret>' \
  -d 'grant_type=authorization_code' \
  -d 'redirect_uri=https://localhost/' \
  -d 'code=<code, minus any trailing #_>'

curl -sG 'https://graph.instagram.com/access_token' \
  --data-urlencode 'grant_type=ig_exchange_token' \
  --data-urlencode 'client_secret=<instagram app secret>' \
  --data-urlencode 'access_token=<short-lived token>'
```

5. The long-lived token is `META_INSTAGRAM_LOGIN_TOKEN`.

**If this variant is more trouble than it is worth:** say so and stop. An empty `data` array, or
even "I could not obtain an instagram_login token", is a recordable §17 outcome — it means
Instagram stays fixture-tested and the live demo leans on Facebook and Bluesky. What is *not*
acceptable is building the read path on a guess about which variant works.

## 7. S5 — capturing a real delivery

S5 cannot be answered without the exact bytes Meta sent, because the HMAC is over the raw body.
Re-serializing the JSON anywhere in the chain (a proxy that pretty-prints, a copy through a UI that
reorders keys) changes the bytes and breaks the match.

A receiver that preserves them:

```bash
cat > /tmp/capture.mjs <<'EOF'
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
createServer((req, res) => {
  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    res.writeHead(200).end(url.searchParams.get('hub.challenge') ?? 'ok');
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    writeFileSync('/tmp/delivery-body.json', Buffer.concat(chunks));
    console.log('signature:', req.headers['x-hub-signature-256']);
    res.writeHead(200).end('ok');
  });
}).listen(3100);
EOF
node /tmp/capture.mjs
pnpm dlx localtunnel --port 3100   # in a second shell; gives you an https URL
```

`writeFileSync(Buffer.concat(chunks))` is the load-bearing detail: the buffer is written unparsed.
The `GET` branch echoes `hub.challenge` so the dashboard accepts the callback URL — the same
handshake our own intake will implement once this spike answers how to verify it.

Point the webhook callback at the tunnel URL (verify token can be anything), then trigger a **Test**
send for an Instagram field from the dashboard's Webhooks panel. Then:

```bash
pnpm tsx scripts/spikes/s5-instagram-webhook-signing-secret.ts \
  --body-file /tmp/delivery-body.json \
  --signature 'sha256=<the value printed by the capture server>'
```

A dashboard *Test* send is signed like a real delivery, which is all S5 needs. A real comment event
is better if you can produce one — note in your paste-back which you used.

## 8. Order of work

S2 first: it is the only spike that produces committed artifacts (the two fixture files T097
replays), and it unblocks the most code. S1 and S5 together unblock the webhook path. Tear down the
tunnel and the subscription afterwards if you do not want deliveries arriving at a dead URL.

Paste back the `SPIKE S<n> VERDICT:` lines and the output above them. No script prints a full token
or signature — only first/last four characters — so the output is safe to paste verbatim.
