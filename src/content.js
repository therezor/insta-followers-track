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
  const MIN_DELAY_MS = 2000;
  const MAX_DELAY_MS = 4000;
  const MAX_PAGES = 4000;          // ~200k accounts, a hard runaway guard
  const RATE_LIMIT_BACKOFF_MS = 60000;
  const MAX_RETRIES = 3;

  let scanning = false;
  let cancelRequested = false;

  // ---------------------------------------------------------------- helpers

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const jitteredDelay = () =>
    MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);

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

      return json;
    }
  }

  function compactUser(u) {
    return {
      pk: String(u.pk ?? u.id ?? ''),
      username: u.username || '',
      full_name: u.full_name || '',
      is_private: !!u.is_private,
      is_verified: !!u.is_verified
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

      await sleep(jitteredDelay());
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

    await sleep(jitteredDelay());

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
