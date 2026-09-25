/*
 * Follower Tracker - content script
 *
 * Runs inside instagram.com so that requests are same-origin and carry the
 * session cookie the browser already has. Nothing here is sent anywhere
 * except back to the extension's own dashboard.
 */

(() => {
  'use strict';

  const api = globalThis.browser ?? globalThis.chrome;

  /*
   * The flag is set *after* the listener is installed, not on entry. Set on
   * entry, a script that died partway through would still look loaded, and a
   * later programmatic injection would bail out at this line and leave the
   * tab permanently unable to answer a ping.
   */
  if (window.__followTrackerReady) return;

  // ------------------------------------------------------------- messaging

  api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'FL_PING') {
      sendResponse({ ok: true, scanning });
      return;
    }

    if (message.type === 'FL_SCAN_CANCEL') {
      cancelRequested = true;
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'FL_SCAN_START') {
      if (scanning) {
        sendResponse({ ok: false, error: 'A scan is already running.' });
        return;
      }

      scanning = true;
      cancelRequested = false;
      sendResponse({ ok: true });

      runScan(message.settings)
        .then((data) => {
          broadcast({ type: 'FL_SCAN_DONE', data });
        })
        .catch((err) => {
          broadcast({
            type: 'FL_SCAN_ERROR',
            error: err?.message || String(err),
            code: err?.code || 'error'
          });
        })
        .finally(() => {
          scanning = false;
          cancelRequested = false;
        });

      return;
    }
  });

  window.__followTrackerReady = true;

  // ------------------------------------------------------------------ setup

  /*
   * The request shape below is copied from instagram.com itself, observed in
   * Chrome on 2026-09-25 by opening the Followers and Following dialogs:
   * page size, query parameters, and every header its own XHR sets. A request
   * that differs from the web app's is easy for Instagram to single out.
   */
  const DEFAULT_APP_ID = '936619743392459';
  const ASBD_ID = '359341';
  const PAGE_SIZE = 12;
  const MAX_PAGES = 4000;          // ~200k accounts, a hard runaway guard
  const RATE_LIMIT_BACKOFF_MS = 60000;
  const MAX_RETRIES = 3;
  const TICK_MS = 1000;            // granularity of interruptible waits

  let scanning = false;
  let cancelRequested = false;

  /*
   * src/settings.js is the authority on defaults and clamping, and the
   * dashboard normalises through it before asking for a scan. These values
   * are a last resort for the case where the scan was started without them.
   *
   * The content script deliberately does NOT load settings.js. Depending on a
   * second file's global made a scan fail outright whenever that file was
   * missing - which happens whenever the browser is still running a manifest
   * older than the files on disk, since content-script files are re-read from
   * disk but the manifest's file list is not.
   */
  const FALLBACK_SETTINGS = {
    minDelaySec: 1,
    maxDelaySec: 5,
    pauseEvery: 100,
    pauseMinMin: 1,
    pauseMaxMin: 3
  };

  let settings = FALLBACK_SETTINGS;

  /**
   * x-web-session-id is three six-character base-36 groups, and the scan
   * sends the tab's own so its requests carry the same identity as the page's.
   * As observed on 2026-09-25: the first group is the part of
   * localStorage['Session'] before its colon, the second is
   * sessionStorage['TabId'], and the third is per page load and lives only in
   * the name of the logging queue key localStorage['bz:<id>.<ms>.<n>'].
   * Newest bz: key for this browser and tab wins. Without one, the first two
   * groups are still the page's and only the third is made up; with neither,
   * all three are.
   */
  const SESSION_GROUP = /^[a-z0-9]{6}$/;
  let fallbackSessionId = '';

  function randomGroup() {
    let out = '';
    while (out.length < 6) out += Math.floor(Math.random() * 36).toString(36);
    return out;
  }

  function readStorage(area, key) {
    try {
      return globalThis[area].getItem(key) || '';
    } catch (_) {
      return '';
    }
  }

  function webSessionId() {
    const browserGroup = readStorage('localStorage', 'Session').split(':')[0];
    const tabGroup = readStorage('sessionStorage', 'TabId');
    const haveBoth = SESSION_GROUP.test(browserGroup) && SESSION_GROUP.test(tabGroup);

    if (haveBoth) {
      try {
        const prefix = 'bz:' + browserGroup + ':' + tabGroup + ':';
        let best = null;
        let bestTs = -1;
        for (let i = 0; i < localStorage.length; i += 1) {
          const key = localStorage.key(i) || '';
          if (!key.startsWith(prefix)) continue;
          const m = key.slice(3).match(/^([a-z0-9]{6}:[a-z0-9]{6}:[a-z0-9]{6})\.(\d+)/);
          if (m && Number(m[2]) > bestTs) {
            best = m[1];
            bestTs = Number(m[2]);
          }
        }
        if (best) return best;
      } catch (_) {
        /* fall through */
      }
    }

    if (!fallbackSessionId) {
      fallbackSessionId = haveBoth
        ? browserGroup + ':' + tabGroup + ':' + randomGroup()
        : [randomGroup(), randomGroup(), randomGroup()].join(':');
    }
    return fallbackSessionId;
  }

  /**
   * instagram.com sends its list requests from the profile page, so that is
   * the Referer here too. Null when the username is unknown, which leaves the
   * browser to send the tab's own URL as it would anyway.
   */
  let profileReferrer = null;

  /**
   * x-ig-www-claim is an HMAC Instagram hands out in the x-ig-set-www-claim
   * response header; the web app keeps it in sessionStorage as www-claim-v2
   * and echoes it on every request. Content scripts share that storage, so
   * the value is read from there, then from the last response, then '0',
   * which is what the web app itself sends before it has one.
   */
  let lastClaim = '';
  function wwwClaim() {
    return readStorage('sessionStorage', 'www-claim-v2') || lastClaim || '0';
  }

  /*
   * In Firefox a content script's own fetch goes out under the extension's
   * principal; content.fetch is the page's, so the request looks like one
   * instagram.com made. Chrome has no `content` and already sends content
   * script requests as the page.
   */
  const pageFetch = (() => {
    try {
      const page = globalThis.content;
      if (page && typeof page.fetch === 'function') return page.fetch.bind(page);
    } catch (_) {
      /* not Firefox */
    }
    return (...args) => fetch(...args);
  })();

  // ---------------------------------------------------------------- helpers

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Wait in one-second ticks so a cancel during a three-minute pause is acted
   * on immediately rather than after the pause expires. `onTick` receives the
   * seconds still to go, for the progress line.
   */
  async function waitFor(ms, onTick) {
    const until = Date.now() + ms;
    for (;;) {
      const left = until - Date.now();
      if (left <= 0) return;
      if (cancelRequested) throw new ScanError('Scan cancelled.', 'cancelled');
      if (onTick) onTick(Math.ceil(left / 1000));
      await sleep(Math.min(TICK_MS, left));
    }
  }

  /**
   * Paces every request to Instagram. Both the gap between requests and the
   * periodic long pause come from user settings; the counter spans the whole
   * scan, not one list, because Instagram rate limits the session.
   */
  const pacer = {
    completed: 0,

    async beforeRequest() {
      if (this.completed === 0) return;

      if (shouldLongPause(this.completed)) {
        const ms = longPauseMs();
        await waitFor(ms, (secondsLeft) => {
          // Every tick would be a storage write in the background for a
          // change nobody can read. Five-second steps, then every second
          // near zero where the countdown is actually being watched.
          if (secondsLeft > 5 && secondsLeft % 5 !== 0) return;
          broadcast({
            type: 'FL_PROGRESS',
            phase: 'waiting',
            note:
              'Cooling down after ' +
              this.completed +
              ' requests - resuming in ' +
              formatCountdown(secondsLeft)
          });
        });
        return;
      }

      await waitFor(requestDelayMs());
    },

    afterRequest() {
      this.completed += 1;
    }
  };

  function formatCountdown(totalSeconds) {
    if (totalSeconds < 60) return totalSeconds + 's';
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return m + 'm ' + String(s).padStart(2, '0') + 's';
  }

  /**
   * Accept whatever the scan request carried, guarding only against values
   * that would break pacing: a non-number, a negative, or an inverted range
   * (which yields a negative delay, sleeps for zero, and silently removes the
   * pacing altogether). Full clamping lives in settings.js.
   */
  function adoptSettings(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const num = (value, fallback) => {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 ? n : fallback;
    };

    const next = {
      minDelaySec: num(src.minDelaySec, FALLBACK_SETTINGS.minDelaySec),
      maxDelaySec: num(src.maxDelaySec, FALLBACK_SETTINGS.maxDelaySec),
      pauseEvery: num(src.pauseEvery, FALLBACK_SETTINGS.pauseEvery),
      pauseMinMin: num(src.pauseMinMin, FALLBACK_SETTINGS.pauseMinMin),
      pauseMaxMin: num(src.pauseMaxMin, FALLBACK_SETTINGS.pauseMaxMin)
    };

    if (next.maxDelaySec < next.minDelaySec) next.maxDelaySec = next.minDelaySec;
    if (next.pauseMaxMin < next.pauseMinMin) next.pauseMaxMin = next.pauseMinMin;

    settings = next;
  }

  const requestDelayMs = () =>
    (settings.minDelaySec +
      Math.random() * (settings.maxDelaySec - settings.minDelaySec)) *
    1000;

  const longPauseMs = () =>
    (settings.pauseMinMin +
      Math.random() * (settings.pauseMaxMin - settings.pauseMinMin)) *
    60000;

  const shouldLongPause = (completed) =>
    settings.pauseEvery > 0 && completed > 0 && completed % settings.pauseEvery === 0;

  function readCookie(name) {
    const match = document.cookie.match(
      new RegExp('(?:^|;\\s*)' + name + '=([^;]*)')
    );
    return match ? decodeURIComponent(match[1]) : null;
  }

  /**
   * The web app id is a public constant baked into Instagram's own frontend.
   * Prefer scraping the live value so we stay correct if they rotate it.
   */
  function findAppId() {
    try {
      const html = document.documentElement.innerHTML;
      const patterns = [
        /"X-IG-App-ID"\s*:\s*"(\d+)"/,
        /"APP_ID"\s*:\s*"(\d+)"/,
        /appId"\s*:\s*"(\d+)"/
      ];
      for (const re of patterns) {
        const m = html.match(re);
        if (m) return m[1];
      }
    } catch (_) {
      /* fall through to default */
    }
    return DEFAULT_APP_ID;
  }

  function broadcast(message) {
    try {
      const p = api.runtime.sendMessage(message);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) {
      /* dashboard may be closed; progress is best-effort */
    }
  }

  class ScanError extends Error {
    constructor(message, code) {
      super(message);
      this.code = code || 'error';
    }
  }

  // ------------------------------------------------------------ api requests

  async function igFetch(url, appId, csrfToken) {
    let attempt = 0;

    await pacer.beforeRequest();

    for (;;) {
      if (cancelRequested) throw new ScanError('Scan cancelled.', 'cancelled');

      let response;
      try {
        // Same headers, same order, as instagram.com's own list requests.
        const init = {
          method: 'GET',
          credentials: 'include',
          headers: {
            'x-csrftoken': csrfToken || '',
            'x-ig-app-id': appId,
            'x-asbd-id': ASBD_ID,
            'x-ig-www-claim': wwwClaim(),
            'x-web-session-id': webSessionId(),
            'x-ig-max-touch-points': String(globalThis.navigator?.maxTouchPoints || 0),
            accept: '*/*',
            'x-requested-with': 'XMLHttpRequest'
          }
        };
        if (profileReferrer) init.referrer = profileReferrer;
        response = await pageFetch(url, init);
      } catch (networkError) {
        attempt += 1;
        if (attempt > MAX_RETRIES) {
          throw new ScanError(
            'Network request failed. Check your connection and try again.',
            'network'
          );
        }
        await waitFor(RATE_LIMIT_BACKOFF_MS / 4);
        continue;
      }

      const claim = response.headers?.get?.('x-ig-set-www-claim');
      if (claim) lastClaim = claim;

      if (response.status === 429) {
        attempt += 1;
        if (attempt > MAX_RETRIES) {
          throw new ScanError(
            'Instagram is rate limiting this session. Wait a while before ' +
              'scanning again.',
            'rate_limited'
          );
        }
        // Waited in ticks like the long pause, so Cancel works during it and
        // the progress line counts down instead of sitting on one number.
        await waitFor(RATE_LIMIT_BACKOFF_MS * attempt, (secondsLeft) => {
          if (secondsLeft > 5 && secondsLeft % 5 !== 0) return;
          broadcast({
            type: 'FL_PROGRESS',
            phase: 'waiting',
            note:
              'Rate limited by Instagram (attempt ' + attempt + ' of ' +
              MAX_RETRIES + ') - retrying in ' + formatCountdown(secondsLeft)
          });
        });
        continue;
      }

      if (response.status === 401 || response.status === 403) {
        throw new ScanError(
          'Instagram rejected the request. Make sure you are logged in on ' +
            'instagram.com, then retry.',
          'auth'
        );
      }

      if (!response.ok) {
        throw new ScanError(
          'Instagram returned HTTP ' + response.status + '.',
          'http'
        );
      }

      let json;
      try {
        json = await response.json();
      } catch (_) {
        throw new ScanError(
          'Instagram returned a response that was not JSON. You may have hit ' +
            'a checkpoint - open instagram.com and clear it.',
          'parse'
        );
      }

      if (json.require_login || json.message === 'checkpoint_required') {
        throw new ScanError(
          'Instagram requires you to re-authenticate or clear a checkpoint.',
          'checkpoint'
        );
      }

      if (json.status && json.status !== 'ok') {
        throw new ScanError(
          'Instagram returned status "' + json.status + '".',
          'status'
        );
      }

      pacer.afterRequest();
      return json;
    }
  }

  /**
   * Only https URLs are kept. The value comes straight off Instagram's
   * response, so it is treated as untrusted input rather than piped into an
   * <img src> unchecked.
   */
  function safePicUrl(value) {
    if (typeof value !== 'string' || value.length > 2048) return '';
    try {
      const url = new URL(value);
      return url.protocol === 'https:' ? url.href : '';
    } catch (_) {
      return '';
    }
  }

  function compactUser(u) {
    return {
      pk: String(u.pk ?? u.id ?? ''),
      username: u.username || '',
      full_name: u.full_name || '',
      is_private: !!u.is_private,
      is_verified: !!u.is_verified,
      profile_pic_url: safePicUrl(u.profile_pic_url)
    };
  }

  /**
   * Walk one paginated friendship list to completion.
   */
  async function collectList(kind, userId, appId, csrfToken, onProgress) {
    const collected = [];
    const seen = new Set();
    let maxId = null;
    let page = 0;

    for (;;) {
      if (cancelRequested) throw new ScanError('Scan cancelled.', 'cancelled');

      const url = new URL(
        '/api/v1/friendships/' + userId + '/' + kind + '/',
        location.origin
      );
      // Parameter order as the web app sends it. Only the followers dialog
      // adds search_surface; the following dialog sends count alone.
      url.searchParams.set('count', String(PAGE_SIZE));
      if (maxId) url.searchParams.set('max_id', String(maxId));
      if (kind === 'followers') {
        url.searchParams.set('search_surface', 'follow_list_page');
      }

      const json = await igFetch(url.toString(), appId, csrfToken);
      const users = Array.isArray(json.users) ? json.users : [];

      for (const raw of users) {
        const user = compactUser(raw);
        if (!user.pk || seen.has(user.pk)) continue;
        seen.add(user.pk);
        collected.push(user);
      }

      page += 1;
      onProgress(collected.length, page);

      maxId = json.next_max_id ?? null;
      if (!maxId || users.length === 0 || page >= MAX_PAGES) break;
    }

    return collected;
  }

  /**
   * The account id comes from the session cookie, and the name from the
   * `PolarisViewer` config instagram.com embeds in every page it serves - the
   * logged-in user's own record, checked against that id so another
   * account's name can never be picked up. No request is made: the only
   * endpoint for it, /users/<id>/info/, is a mobile-app one that
   * instagram.com never calls and that Instagram 429s at once for a web
   * session. If the page has no such config, the background keeps the
   * username from an earlier scan.
   */
  function resolveSelf() {
    const userId = readCookie('ds_user_id');
    if (!userId) {
      throw new ScanError(
        'No Instagram session found. Log in at instagram.com first.',
        'auth'
      );
    }
    const viewer = findViewer(userId);
    return {
      pk: String(userId),
      username: viewer.username,
      full_name: viewer.full_name
    };
  }

  const USERNAME = /^[A-Za-z0-9._]{1,30}$/;
  const VIEWER_MARKER = '["PolarisViewer",[],{"data":';

  function findViewer(userId) {
    const none = { username: '', full_name: '' };
    try {
      const html = document.documentElement.innerHTML;
      const at = html.indexOf(VIEWER_MARKER);
      if (at < 0) return none;
      const text = jsonObjectAt(html, at + VIEWER_MARKER.length);
      if (!text) return none;
      const data = JSON.parse(text);
      if (String(data.id) !== String(userId)) return none;
      return {
        username: USERNAME.test(data.username) ? data.username : '',
        full_name: typeof data.full_name === 'string' ? data.full_name : ''
      };
    } catch (_) {
      return none;
    }
  }

  /**
   * The JSON object starting at `start`, found by matching braces outside
   * strings - the biography inside it can hold any character, braces too.
   */
  function jsonObjectAt(text, start) {
    if (text[start] !== '{') return '';
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length && i < start + 200000; i += 1) {
      const ch = text[i];
      if (inString) {
        if (ch === '\\') i += 1;
        else if (ch === '"') inString = false;
      } else if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return '';
  }

  // ----------------------------------------------------------------- driver

  async function runScan(requestedSettings) {
    adoptSettings(requestedSettings);
    pacer.completed = 0;
    fallbackSessionId = '';

    const appId = findAppId();
    const csrfToken = readCookie('csrftoken');

    broadcast({ type: 'FL_PROGRESS', phase: 'starting', note: 'Identifying account' });
    const profile = resolveSelf();
    profileReferrer = profile.username
      ? location.origin + '/' + profile.username + '/'
      : null;

    broadcast({
      type: 'FL_PROGRESS',
      phase: 'followers',
      count: 0,
      note: 'Collecting followers'
    });
    const followers = await collectList(
      'followers',
      profile.pk,
      appId,
      csrfToken,
      (count, page) =>
        broadcast({
          type: 'FL_PROGRESS',
          phase: 'followers',
          count,
          page,
          note: 'Collecting followers'
        })
    );

    broadcast({
      type: 'FL_PROGRESS',
      phase: 'following',
      count: 0,
      note: 'Collecting following'
    });
    const following = await collectList(
      'following',
      profile.pk,
      appId,
      csrfToken,
      (count, page) =>
        broadcast({
          type: 'FL_PROGRESS',
          phase: 'following',
          count,
          page,
          note: 'Collecting following'
        })
    );

    return { profile, followers, following };
  }

  // ------------------------------------------------------------- messaging

})();
