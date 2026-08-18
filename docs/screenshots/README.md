# Screenshots

Rendered from the real extension pages, not mocked up: `dist/chrome` served
over a local HTTP server with `storage.local` stubbed by a fixture, captured
in headless Chrome. Every number, list and layout is what the code produces.

The accounts shown are invented. `Date.now()` is pinned in the fixture so the
relative times ("1 hour ago") stay stable between captures.

To regenerate, see *Previewing the dashboard without installing* in
[TECHNICAL.md](../../TECHNICAL.md), add a fixture with several accounts, and
capture with:

```sh
chrome --headless --disable-gpu --hide-scrollbars --window-size=1240,700 \
  --virtual-time-budget=5000 --screenshot=out.png http://localhost:8732/dashboard.html
```
