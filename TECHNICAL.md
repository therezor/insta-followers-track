# Follower Tracker — technical notes

Non-technical overview: [README.md](README.md).

Follower and unfollower tracking for Instagram, as a **Firefox and Chrome**
extension. Everything runs locally: no account, no sign-in, no follower cap,
no subscription, and no telemetry.

Written from scratch. It is not a patched build of anything — see
[ANALYSIS.md](ANALYSIS.md) for a teardown of the commercial
`bfjmkhnlifdfhcnmmhlocikaoipmfgkj` ("IG Track" 1.2.3) that motivated it, and
why patching that one was the wrong approach: its follower ceiling arrives
from a Parse backend as a per-account `isPro` response, not from a constant in
the bundle.

## Layout

```
src/          shared source — identical in both browsers
  manifest is generated, not stored here
build.mjs     emits dist/firefox and dist/chrome
test/         unit tests for the diff logic and pacing settings
dist/         build output (gitignored)
```

The two browsers differ only in the manifest: Firefox gets an event page
(`background.scripts`) plus `browser_specific_settings`; Chrome gets an MV3
`service_worker`. All extension API calls go through
`globalThis.browser ?? globalThis.chrome`, so the logic is byte-identical.

```sh
npm run build     # -> dist/firefox, dist/chrome (no npm install needed)
npm test          # 22 unit tests: diff logic + pacing settings
npm run lint      # web-ext lint: 0 errors, 0 warnings, 0 notices
npm run package   # signed-ready zip of the Firefox build
```

## Install

**Firefox** — `about:debugging#/runtime/this-firefox` → *Load Temporary
Add-on…* → pick `dist/firefox/manifest.json`. Lasts until restart.

**Chrome** — `chrome://extensions` → enable *Developer mode* → *Load unpacked*
→ pick `dist/chrome`. Persists.

For a permanent Firefox install you need a signed build
(`web-ext sign --channel=unlisted` with AMO credentials); unsigned permanent
installs only work on Developer Edition, Nightly, or ESR with
`xpinstall.signatures.required=false`.

## What it shows

| View | Definition |
| --- | --- |
| Doesn't follow you back | `following − followers` |
| You don't follow back | `followers − following` |
| Mutuals | `followers ∩ following` |
| New followers | `followers(now) − followers(prev scan)` |
| Lost followers | `followers(prev scan) − followers(now)` |
| Newly followed | `following(now) − following(prev scan)` |
| You unfollowed | `following(prev scan) − following(now)` |
| History | Every scan, with follower deltas |

Searchable, sortable, CSV-exportable. Default sort is the order Instagram
returned accounts in, which is roughly newest first. Change views need two
scans before they show anything.

## How it works

- `content.js` runs on instagram.com, so its requests are same-origin and
  carry the session cookie the browser already has. No password is ever
  entered, requested, or stored.
- It walks `/api/v1/friendships/<id>/followers/` and `.../following/`, 50 per
  page, following `next_max_id` to the end.
- `background.js` persists results to `storage.local` as the current scan plus
  a compact snapshot.
- `diff.js` derives every view as a set difference. It is free of DOM and
  extension APIs so the logic that matters is unit-testable under node.
- `dashboard.js` renders. This page makes no network requests at all.

### Not yet run end-to-end

Verified so far: the diff logic and pacing-settings clamping (22 unit tests),
the dashboard's list rendering (against stubbed data), `web-ext lint` clean,
and — probed live on
instagram.com — that `ds_user_id` and `csrftoken` are readable from
`document.cookie`, that `sessionid` is HttpOnly (so `credentials: 'include'`
is required, as used), and that the App ID is scrapeable and matches the
fallback constant.

**Not** verified: the fetch loop, content-script injection, message passing,
`storage.local`, and the Settings panel have never run in a real browser, and
the REST response shape is assumed rather than observed. The settings *logic*
is unit-tested; the panel that edits it has only been checked statically (every
`$('#id')` in `dashboard.js` resolves to an id in `dashboard.html`). Smoke
test:

1. `chrome://extensions` → Developer mode → Load unpacked → `dist/chrome`
2. Open instagram.com, click the toolbar icon
3. **Scan now** — watch the counter go past 50. That's the real check: it
   proves pagination works, not just the first page.
4. Scan again later — New/Lost followers should populate.
5. **Settings** → set *Pause after every* to `2`, Save, rescan. The progress
   line should switch to a cooling-down countdown, and **Cancel** should take
   effect within a second rather than at the end of the pause. At the default
   of 200 this path needs a very large account to reach, so this is the only
   cheap way to exercise it.

If step 3 shows 0 accounts and no error, the REST response shape is wrong and
`collectList()` in `src/content.js` needs adjusting to whatever
`/api/v1/friendships/<uid>/followers/` actually returns.

### Rate limiting

Pacing is user-configurable from **Settings** in the dashboard, and every
request in a scan goes through it — profile lookup, followers, and following
share one counter, because Instagram rate limits the session, not the list.

| Setting | Default | Range |
| --- | --- | --- |
| Random interval between requests | 2 – 12 s | 0 – 300 s |
| Pause after every N requests | 200 (0 disables) | 0 – 10,000 |
| Pause length | 1 – 3 min | 0 – 120 min |

Both ranges are sampled uniformly per request, so the traffic has no fixed
period. At the defaults a 10,000-follower account is 200 requests and takes
roughly 25 minutes; the Settings panel estimates this live from your last
scan size.

Independently of these settings, HTTP 429 backs the scan off 60 s and retries
up to three times before stopping with a clear message.

`src/settings.js` is pure — no DOM, no extension APIs — so the clamping is
unit-tested. It normalises **on read as well as on write**: a stored range
with `max < min` would otherwise yield a negative delay, which sleeps for
zero and silently removes the pacing entirely. Inverted ranges collapse to a
fixed value rather than being rejected.

Long pauses are waited out in one-second ticks, so **Cancel** takes effect
immediately instead of after the pause expires, and the progress line shows a
live countdown.

The pacing is deliberate: hammering these endpoints is the fastest way to get
rate-limited or checkpointed, and a scan that dies halfway looks exactly like
real follower loss.

## Storage

| Key | Contents |
| --- | --- |
| `profile` | Your user id and username |
| `latest` | Full follower/following lists from the most recent scan |
| `snapshots` | Up to 60 timestamped scans, ids only |
| `directory` | id → name/flags, so accounts that leave still render properly |
| `settings` | Your scan pacing settings |

`unlimitedStorage` is requested because a large account across 60 snapshots
exceeds the default quota. **Delete all stored data** in the footer wipes
everything, including your pacing settings, which return to defaults.

## Privacy

There is exactly one `fetch()` in this codebase, in `content.js`, and its URL
is built from `location.origin` — instagram.com. Check it:

```sh
grep -rnE "fetch\(|XMLHttpRequest|sendBeacon|WebSocket|navigator\.|eval\(" src/*.js
grep -rohE "https?://[^\"' ]+" src/*.js src/*.html | sort -u
```

No remote fonts, scripts, or images. Profile pictures are deliberately **not**
fetched — avatars render as initials — so opening your dashboard sends nothing
to Instagram's CDN. The Firefox manifest declares
`data_collection_permissions: { required: ["none"] }`.

For contrast, IG Track ships Mixpanel with thirteen tracked events bound to
your Google identity; see [ANALYSIS.md](ANALYSIS.md).

## Caveats

- Instagram's private endpoints are undocumented and change without notice. If
  scans start failing, check the response shape first.
- Automated reading of these endpoints is against Instagram's Terms of
  Service, as it is for every tool in this category. Scan occasionally rather
  than constantly.
