# Changelog

## 1.1.0 — 2026-09-25

Scans that Instagram stopped at the first request now run. The extension now
sends every request the way instagram.com itself does.

### Fixed

- **Instant "Rate limited - pausing 60s before retry".** A scan opened with a
  call to `/api/v1/users/<id>/info/`, a mobile-app endpoint the website never
  uses, and Instagram answered it with an immediate HTTP 429. The scan then
  waited through three back-offs, about 6 minutes in all, and looked broken.
  The extension no longer makes that call. It reads your username from data
  instagram.com already puts in the page.
- **Cancel works during a rate-limit back-off.** It takes effect within a
  second, and the progress line counts down instead of showing a fixed
  number.
- **A rescan never blanks a known username.** If the page does not say who
  you are, the account keeps the name from its last scan.

### Changed

- **Requests match the web app's own.** They copy what instagram.com sends
  from its Followers and Following dialogs:
  - 12 accounts per page, with the same query parameters.
  - The same headers, in the same order: `x-asbd-id`, `x-ig-www-claim`,
    `x-web-session-id`, `x-ig-max-touch-points` and the existing ones.
- **Requests reuse the Instagram tab's session details.**
  - They send the page's own `x-web-session-id` and `x-ig-www-claim` values.
  - They send your profile page as the `Referer`, because instagram.com sends
    these requests from there.
  - In Firefox, they go through `content.fetch`, so Firefox sends them as the
    page's requests, not the extension's.
- **Faster default pacing.** Pages are smaller now, so the gap between
  requests drops to 1-5 s from 2-12 s, and the 1-3 minute pause comes every
  100 requests instead of every 200. A 10,000-follower account takes about an
  hour. If you saved your own values in Settings, they still apply.

No new permissions, and nothing new is stored or sent anywhere.

## 1.0.0 — 2026-08-18

First release. A local Instagram follower and unfollower tracker for Chrome,
Firefox and Safari.

### What it does

- **Who unfollowed you**, who doesn't follow you back, who you don't follow
  back, mutuals, new followers, and your own recent follow activity.
- **History** of every scan, with the follower gain or loss for each.
- **Search, sort and CSV export** on any list.
- **Toolbar popup** with a summary, a scan button with live progress, and a
  link to the dashboard.
- **Per-account tracking.** Each Instagram account you scan keeps its own
  history, so switching accounts never mixes their numbers.
- **Configurable scan speed** — the random interval between requests
  (2–12 s by default), and a longer pause after every N requests
  (200, for 1–3 minutes), with a live estimate of what your settings cost.
- **Icons at every size** Firefox, Chrome and addons.mozilla.org ask for: 16,
  32, 48, 64, 96 and 128. The 16px and 32px toolbar marks are redrawn rather
  than downscaled — the magnifier in the full logo merges into the head below
  about 40px, so 32px uses a bolder version of the same composition and 16px
  drops to the silhouette, which stays readable at that size.

### Privacy

- No account, no sign-in, no password, no follower limit, no paid tier.
- No analytics, telemetry, crash reporting or ads of any kind.
- Follower lists are stored only in your own browser. There is no server.
- The only hosts contacted are Instagram's own: instagram.com for your lists,
  and Instagram's image CDNs for profile pictures.
- The Firefox build declares `data_collection_permissions: ["none"]`.
- The privacy policy is in the repository as [PRIVACY.md](PRIVACY.md) and
  published at https://therezor.github.io/insta-followers-track/privacy.html
  — the URL the browser stores ask for.

### Known limits

- Instagram does not permit automated reading of follower lists in its terms
  of service, as is true of every tool in this category. Scans are paced
  deliberately slowly; scan occasionally rather than constantly.
- Safari's `declarativeNetRequest` has no `modifyHeaders`, so profile pictures
  fall back to initials there. The Safari build has not been run end to end.
- Instagram's private endpoints are undocumented and change without notice.
