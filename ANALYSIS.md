# IG Track (`bfjmkhnlifdfhcnmmhlocikaoipmfgkj`) — teardown

**Version analysed:** 1.2.3
**Source:** unpacked from the local Chrome profile
(`~/Library/Application Support/Google/Chrome/Default/Extensions/`).
The Chrome Web Store update endpoint returns **HTTP 204** for this id across
every `prodversion`/`acceptformat` combination tried, so the listing appears to
be withdrawn — the installed copy is the only obtainable source.

Everything below is quoted from the shipped bundle. Two clearly-labelled
inferences are marked as such.

## Manifest surface

| Field | Value |
| --- | --- |
| `manifest_version` | 3 |
| `permissions` | `storage`, `cookies`, `identity` |
| `host_permissions` | `*://*.instagram.com/*`, `*://*.converts.cc/*` |
| `oauth2.client_id` | `984571757481-seene603qp0oskucru8fk89ba2bnkk4q...` |
| `background` | `service-worker.js` (102 bytes — a stub) |

The `identity` permission plus `oauth2` scope `userinfo.email` is the forced
Google sign-in. `cookies` is what lets it read the Instagram session directly.

## Stack

Vue 2 + Buefy/Bulma, jQuery 3.5.1, the **Parse** JS SDK, SheetJS (`xlsx`
export), FontAwesome. `dashboard.js` is 890 KB and `popup.js` 578 KB, both
minified — the bulk is framework and SheetJS, not product logic.

## Backends

| Host | Role |
| --- | --- |
| `igtrack.infwiz.com/parse` | Parse Server — accounts, licence state |
| `converts.cc/paddle/checkout` | Paddle checkout |
| `igtrack.infwiz.com/stripe/redirect` | Stripe checkout |
| `api-js.mixpanel.com`, `cdn.mxpnl.com` | Analytics |
| `cdn.converts.workers.dev`, `social-tools.converts.workers.dev` | Cloudflare Workers assets |

Parse credentials are embedded in the client:

```js
SERVER_KEY: "rv2Ayu…IGTrack",   // truncated
JS_KEY:     "zB7gFa…IGTrack",   // truncated
SERVER_URL: "https://igtrack.infwiz.com/parse"
```

(Both keys ship in plaintext in the bundle; truncated here since the point is
that a client-side key exists, not what it is.)

## Telemetry — present, Mixpanel

```js
MP_TOKEN: "27a5966d…"   // truncated
mixpanel.init(APP.MP_TOKEN, { debug: APP.MP_DEBUG })
```

Tracked events found in `dashboard.js` / `popup.js`:

`mp_page_view`, `$identify`, `$create_alias`, `LOGIN_CLICK`, `LOGOUT_CLICK`,
`OPEN_DASHBOARD_CLICK`, `REFRESH_DATA_CLICK`, `FOLLOW_CLICK`,
`UNFOLLOW_CLICK`, `DASHBOARD_SELECT_TYPE`, `DASHBOARD_PRO_MODAL_SHOW`,
`DASHBOARD_SUBSCRIBE_CLICK`, `PRO_SUBSCRIBE_CLICK`.

`$identify` / `$create_alias` bind the Mixpanel distinct-id to the
Google-authenticated account, so the event stream is tied to a real identity
rather than being anonymous.

## How it reads follower data

The **legacy** GraphQL endpoint, not the `/api/v1/friendships/` REST route:

```js
retriveFollowers(id, page) {
  const params = {
    query_hash: APP.QueryHash.followed_by,
    variables: JSON.stringify({ id, after: page.end_cursor ?? "", first: 50 })
  };
  axios.get("https://www.instagram.com/graphql/query/", { params, headers });
  // walks data.user.edge_followed_by → page_info.has_next_page / end_cursor
}
```

`retriveFollowing` is identical against `QueryHash.follows` /
`edge_follow`. Follow and unfollow actions use
`https://www.instagram.com/web/friendships/{id}/follow|unfollow/`.

Pacing is a randomised 2–12 s gap (`REQUEST_INTERVAL_MIN: 2`,
`REQUEST_INTERVAL_MAX: 12`), user-adjustable via
`chrome.storage.local["request_interval_range"]`.

> **Inference, not verified:** `query_hash`-style GraphQL calls are widely
> reported to have been retired by Instagram — I did not verify that here. What
> *is* in the code is that an HTML response is treated as "not ready", which
> silently pauses the scan. A scan that stops early still renders, and a
> truncated follower list is indistinguishable from real follower loss — a
> plausible mechanism behind the "inaccurate data" reports, but I did not run
> the extension to confirm it.

## How the paywall actually works

**Server-authoritative.** The client asks the backend and is told its ceiling:

```js
Parse.Cloud.run("isPro", { uid }).then(n => {
  this.isPro = n.pro;
  const i = n.trial_count, r = n.pro_count;
  this.isPro ? this.extractMax = r : this.extractMax = i;
});
```

Enforcement is a truncation inside the pagination callback:

```js
this.enable_limit && items.length >= this.extractMax
  ? (this.finish = true,
     this.is_work = false,
     items.splice(this.extractMax),   // discard the overflow
     this.calcData())
  : page_info.has_next_page ? /* fetch next page */ : /* done */
```

`TRIAL_NUM: 500` and `PRO_TIP: 1e4` exist in the client config, but they are
defaults/copy — the operative numbers arrive as `trial_count` and `pro_count`
in the `isPro` response.

This is worth being precise about: the limit is **not** a local constant that
could be edited in place. The ceiling is handed down by a server that also
gates account state, so the gate is a network response, not a branch in the
bundle. Anything that removed it would be defeating a remote licence check.

## What this means for a reimplementation

Strip the Parse account layer, the Google OAuth requirement, Mixpanel, and the
Paddle/Stripe plumbing, and the remaining product is: paginate two lists,
diff them, persist a snapshot. That is what `src/` in this repo does — no
account, no ceiling, no analytics.

It targets the REST route (`/api/v1/friendships/<id>/followers/`, `max_id`
cursors) rather than the `query_hash` GraphQL route used here. To be explicit
about the limits of this teardown: the GraphQL usage above is quoted from
IG Track's bundle and is verified; the REST response shape this repo depends on
is **not** — an attempt to confirm it with a live request was blocked by a
browser-automation guard. See the smoke test in [TECHNICAL.md](TECHNICAL.md).
