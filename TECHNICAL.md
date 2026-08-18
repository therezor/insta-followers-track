# Follower Tracker — technical notes

Non-technical overview: [README.md](README.md).

Follower and unfollower tracking for Instagram, as a **Chrome, Firefox and
Safari** extension. Everything runs locally: no account, no sign-in, no
follower cap, no subscription, and no telemetry.

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
test/         unit tests: diff, pacing, content-script load and scan
dist/         build output (gitignored)
```

The three targets differ only in the manifest: Firefox gets an event page
(`background.scripts`) plus a gecko `browser_specific_settings`; Chrome gets an
MV3 `service_worker` and a `minimum_chrome_version`; Safari gets the same
service worker with a `safari` block pinning 16.4, the first version to run
them. All extension API calls go through
`globalThis.browser ?? globalThis.chrome`, so the logic is byte-identical.

```sh
npm run build     # -> dist/firefox, dist/chrome, dist/safari (no npm install needed)
npm test          # 33 unit tests: diff, pacing, content-script load and scan
npm run lint      # web-ext lint: 0 errors, 0 warnings, 0 notices
npm run package   # signed-ready zip of the Firefox build
```

## Install

**Firefox** — `about:debugging#/runtime/this-firefox` → *Load Temporary
Add-on…* → pick `dist/firefox/manifest.json`. Lasts until restart.

**Chrome** — `chrome://extensions` → enable *Developer mode* → *Load unpacked*
→ pick `dist/chrome`. Persists.

**Safari** — Safari cannot load an unpacked folder; the extension has to be
wrapped in a macOS app first. With Xcode installed:

```sh
npm run safari     # build, then xcrun safari-web-extension-converter
```

That writes an Xcode project to `dist/safari-xcode`. Open it, build and run
the app once, then enable the extension in Safari → Settings → Extensions and
give it access to instagram.com. For an unsigned local build, tick Develop →
*Allow Unsigned Extensions* first; that resets each time Safari restarts.
Distributing it to anyone else means an Apple Developer account and the App
Store, which is Apple's rule for all Safari extensions, not a choice made
here.

> **Untested.** `dist/safari` is generated and its manifest is Safari-shaped,
> but the machine this was written on has no Xcode, so the converter and the
> Xcode build have never been run. Treat the Safari path as unverified.

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
- A `content_scripts` entry only applies to pages loaded *after* the extension
  was installed or reloaded, so an instagram.com tab that was already open has
  no content script until it is reloaded. `background.js` therefore pings each
  candidate tab and, on silence, injects `content.js` with
  `scripting.executeScript` before giving up. That is what the `scripting`
  permission is for; it is the only reason it is requested.
- `content.js` is the **only** content script, and depends on no other file.
  It used to read `FLSettings` from `settings.js`, which broke every scan
  whenever the browser was running a manifest older than the files on disk —
  content-script files are re-read from disk on each injection, but the
  manifest's file list is not, so `content.js` would arrive alone and fail.
  The dashboard now normalises settings through `settings.js` (where that file
  is unambiguously loaded) and sends them on the scan request. `content.js`
  keeps a small fallback copy of the defaults for a scan started without them,
  and `test/content-load.test.js` fails if the dependency is ever reintroduced.
- It walks `/api/v1/friendships/<id>/followers/` and `.../following/`, 50 per
  page, following `next_max_id` to the end.
- `background.js` persists results to `storage.local` as the current scan plus
  a compact snapshot.
- `diff.js` derives every view as a set difference. It is free of DOM and
  extension APIs so the logic that matters is unit-testable under node.
- `dashboard.js` renders. This page makes no network requests at all.

### Not yet run end-to-end

Verified so far: the diff logic, pacing-settings clamping, and the content
script itself — it loads, answers a ping, and runs a complete scan against a
stubbed Instagram, including pagination, cancellation, a logged-out session
and profile-picture sanitising (33 unit tests);
the whole dashboard rendering in a real Chrome tab against stubbed extension
APIs — stats, grouped tabs, list rows, history, the Settings panel and the
first-run panel, with no console errors; `web-ext lint` clean; and — probed
live on
instagram.com — that `ds_user_id` and `csrftoken` are readable from
`document.cookie`, that `sessionid` is HttpOnly (so `credentials: 'include'`
is required, as used), and that the App ID is scrapeable and matches the
fallback constant.

**Not** verified: the fetch loop, content-script injection, message passing and
`storage.local` have never run in a real browser, and the REST response shape
is assumed rather than observed. The dashboard has only been driven against a
stub — real `storage.local` reads, live progress messages and the scan
lifecycle are still unexercised. Smoke test:

1. `chrome://extensions` → Developer mode → Load unpacked → `dist/chrome`
2. Open instagram.com, click the toolbar icon
3. **Scan now** — watch the counter go past 50. That's the real check: it
   proves pagination works, not just the first page.
4. Scan again later — New/Lost followers should populate.
5. If a scan reports that it could not attach to instagram.com, the error
   itself lists what was tried and what each step said — that list is the
   diagnosis. `Cannot access contents of the page` means the extension's site
   access is set to *on click*; `scripting.executeScript is unavailable` means
   the `scripting` permission has not been granted and the extension needs a
   full reload; `Receiving end does not exist` on every attempt means the
   content script is not running, and that tab's console will say why.
6. **Settings** → set *Pause after every* to `2`, Save, rescan. The progress
   line should switch to a cooling-down countdown, and **Cancel** should take
   effect within a second rather than at the end of the pause. At the default
   of 200 this path needs a very large account to reach, so this is the only
   cheap way to exercise it.

If step 3 shows 0 accounts and no error, the REST response shape is wrong and
`collectList()` in `src/content.js` needs adjusting to whatever
`/api/v1/friendships/<uid>/followers/` actually returns.

### Attaching to a tab

`content_scripts` only covers pages loaded after the extension was installed
or reloaded, so `background.js` cannot assume a content script is present. It
pings each candidate tab four times, injects `content.js` with
`scripting.executeScript` if nothing answers, then pings four more times —
`status === 'complete'` does not mean a `document_idle` script has run, and
`executeScript` resolves before the script has finished executing.

Every step appends to an attach log, and the log is what the failure message
contains. An error that only says "could not attach" is unactionable; one that
says which of ping, injection or permission failed is a diagnosis.

When attaching fails the message also leads with a cause, worked out from what
the *running* extension reports rather than what `src/` declares:

| Check | Meaning |
| --- | --- |
| `runtime.getManifest().permissions` lacks `scripting` | the extension was never reloaded after the rebuild — editing files on disk does not re-register a manifest |
| manifest is current but `permissions.contains({origins})` is false | site access is restricted to on-click, which blocks declared content scripts *and* `executeScript` |
| both fine | the content script is failing inside the page; its console will say why |

The first is by far the most common, and it is invisible otherwise: the
extensions page shows the extension as loaded and enabled, the source on disk
is correct, and only `getManifest()` disagrees.

`test/content-load.test.js` executes `content.js` in a `vm` context with
stubbed browser globals and asserts a listener is registered and answers
`FL_PING`, with and without `settings.js` alongside it, and that the source
never mentions `FLSettings` again.

`test/content-scan.test.js` goes further and drives a whole scan: a stubbed
`fetch` serves paginated friendship responses, and the test asserts the cursor
is followed, both lists come back in order, a cancel mid-wait reports
`cancelled` rather than completing, a logged-out session fails with an `auth`
code, and non-https picture URLs are dropped. Until this existed the scan path
had never run anywhere — every fix to it shipped on inspection alone.

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

Permissions: `storage` and `unlimitedStorage` to keep scans; `tabs` to find
your instagram.com tab and open the dashboard; `scripting` to attach the
content script to a tab that predates the install; and host access to
instagram.com only.

Directory entries and the latest scan each carry a `profile_pic_url`, which is
why those two keys are the bulk of the stored bytes for a large account.

`unlimitedStorage` is requested because a large account across 60 snapshots
exceeds the default quota. **Delete all stored data** in the footer wipes
everything, including your pacing settings, which return to defaults.

## Icons

The logo and the UI glyphs are [Tabler Icons](https://tabler.io/icons) (MIT),
vendored inline rather than linked — nothing in this extension loads from a
remote host. `src/icons/icon.svg` is the logo source (`user-search` on a
gradient tile); the PNGs beside it are rendered from it with
`rsvg-convert -w 128 -h 128 src/icons/icon.svg -o src/icons/icon-128.png`.
Tabler is deliberately *not* a dependency in `package.json`, so `npm run
build` still needs no `npm install`.

The dashboard's sprite carries no `xmlns` attribute: HTML parses inline SVG
without one, and adding it would put a URL into the output of the privacy
grep below.

## Previewing the dashboard without installing

`dashboard.html` only needs `storage.local`, so it renders in a plain tab once
that is stubbed. Copy `dist/chrome` somewhere scratch, add a script that
defines `globalThis.chrome.storage.local.get/set` over a fixture plus no-op
`runtime.sendMessage`/`onMessage`, load it before `settings.js`, and serve the
directory over `python3 -m http.server`. That is how the rendering claims
above were checked.

## Privacy

There is exactly one `fetch()` in this codebase, in `content.js`, and its URL
is built from `location.origin` — instagram.com. Check it:

```sh
grep -rnE "fetch\(|XMLHttpRequest|sendBeacon|WebSocket|navigator\.|eval\(" src/*.js
grep -rohE "https?://[^\"' ]+" src/*.js src/*.html | sort -u
```

No remote fonts, scripts, or ads, and no third-party hosts of any kind. The
only remote images are Instagram profile pictures, served by Instagram, and
the dashboard falls back to initials whenever one does not load — those URLs
are signed and expire, so entries from older scans routinely will not. The
Firefox manifest declares `data_collection_permissions: { required: ["none"] }`.

For contrast, IG Track ships Mixpanel with thirteen tracked events bound to
your Google identity; see [ANALYSIS.md](ANALYSIS.md).

## Caveats

- Instagram's private endpoints are undocumented and change without notice. If
  scans start failing, check the response shape first.
- Automated reading of these endpoints is against Instagram's Terms of
  Service, as it is for every tool in this category. Scan occasionally rather
  than constantly.
