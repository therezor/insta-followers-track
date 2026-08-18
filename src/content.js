/*
 * Follower Tracker - content script
 *
 * Runs inside instagram.com so that requests are same-origin and carry the
 * session cookie the browser already has. Nothing here is sent anywhere
 * except back to the extension's own dashboard.
 */

(() => {
  'use strict';

  if (window.__followLensLoaded) return;
  window.__followLensLoaded = true;

  const api = globalThis.browser ?? globalThis.chrome;

  const DEFAULT_APP_ID = '936619743392459';
  const PAGE_SIZE = 50;
  const MAX_PAGES = 4000;          // ~200k accounts, a hard runaway guard
  const RATE_LIMIT_BACKOFF_MS = 60000;
  const MAX_RETRIES = 3;
  const TICK_MS = 1000;            // granularity of interruptible waits

  let scanning = false;
  let cancelRequested = false;
  let settings = FLSettings.DEFAULTS;

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

      if (FLSettings.shouldLongPause(settings, this.completed)) {
        const ms = FLSettings.longPauseMs(settings);
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

      await waitFor(FLSettings.requestDelayMs(settings));
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

  async function loadSettings() {
    try {
      const store = await api.storage.local.get('settings');
      settings = FLSettings.normalizeSettings(store?.settings);
    } catch (_) {
      settings = FLSettings.DEFAULTS;
    }
  }

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
        response = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          headers: {
            'x-ig-app-id': appId,
            'x-csrftoken': csrfToken || '',
            'x-requested-with': 'XMLHttpRequest',
            accept: '*/*'
          }
        });
      } catch (networkError) {
        attempt += 1;
        if (attempt > MAX_RETRIES) {
          throw new ScanError(
            'Network request failed. Check your connection and try again.',
            'network'
          );
        }
        await sleep(RATE_LIMIT_BACKOFF_MS / 4);
        continue;
      }

      if (response.status === 429) {
        attempt += 1;
        if (attempt > MAX_RETRIES) {
          throw new ScanError(
            'Instagram is rate limiting this session. Wait a while before ' +
              'scanning again.',
            'rate_limited'
          );
        }
        const wait = RATE_LIMIT_BACKOFF_MS * attempt;
        broadcast({
          type: 'FL_PROGRESS',
          phase: 'waiting',
          note:
            'Rate limited - pausing ' + Math.round(wait / 1000) + 's before retry'
        });
        await sleep(wait);
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
      url.searchParams.set('count', String(PAGE_SIZE));
      if (maxId) url.searchParams.set('max_id', String(maxId));

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

  async function resolveSelf(appId, csrfToken) {
    const userId = readCookie('ds_user_id');
    if (!userId) {
      throw new ScanError(
        'No Instagram session found. Log in at instagram.com first.',
        'auth'
      );
    }

    let username = '';
    let fullName = '';
    try {
      const info = await igFetch(
        location.origin + '/api/v1/users/' + userId + '/info/',
        appId,
        csrfToken
      );
      username = info?.user?.username || '';
      fullName = info?.user?.full_name || '';
    } catch (_) {
      /* username is cosmetic; proceed without it */
    }

    return { pk: String(userId), username, full_name: fullName };
  }

  // ----------------------------------------------------------------- driver

  async function runScan() {
    await loadSettings();
    pacer.completed = 0;

    const appId = findAppId();
    const csrfToken = readCookie('csrftoken');

    broadcast({ type: 'FL_PROGRESS', phase: 'starting', note: 'Identifying account' });
    const profile = await resolveSelf(appId, csrfToken);

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

      runScan()
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
})();
