/*
 * Follower Tracker - background
 *
 * Coordinates scans and owns persistence. All data stays in extension local
 * storage; there is no remote endpoint anywhere in this extension.
 */

'use strict';

const api = globalThis.browser ?? globalThis.chrome;

const MAX_SNAPSHOTS = 60;
const PING_INTERVAL_MS = 500;
// instagram.com is a heavy SPA and a background tab is throttled, so the old
// six-second budget expired before the content script ever ran.
const TAB_READY_TIMEOUT_MS = 25000;
const CONTENT_FILES = ['settings.js', 'content.js'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dashboardUrl = () => api.runtime.getURL('dashboard.html');

// -------------------------------------------------------------- scan state

let scanState = { running: false, phase: 'idle', count: 0, note: '', error: null };
let hydrated = null;

/**
 * The background context unloads when idle, taking scanState with it. Pull the
 * last persisted value back on wake so a reopened dashboard sees a live scan.
 */
function hydrateScanState() {
  if (!hydrated) {
    hydrated = api.storage.local
      .get('scanState')
      .then((store) => {
        if (store && store.scanState) scanState = store.scanState;
      })
      .catch(() => {});
  }
  return hydrated;
}

hydrateScanState();

async function setScanState(patch) {
  scanState = { ...scanState, ...patch };
  try {
    await api.storage.local.set({ scanState });
  } catch (_) {
    /* non-fatal */
  }
}

// ------------------------------------------------------------ tab plumbing

async function openDashboard() {
  const url = dashboardUrl();
  const existing = await api.tabs.query({ url });
  if (existing && existing.length) {
    await api.tabs.update(existing[0].id, { active: true });
    if (existing[0].windowId != null) {
      try {
        await api.windows.update(existing[0].windowId, { focused: true });
      } catch (_) {
        /* windows API may be unavailable in some contexts */
      }
    }
    return existing[0];
  }
  return api.tabs.create({ url });
}

async function pingTab(tabId) {
  try {
    const res = await api.tabs.sendMessage(tabId, { type: 'FL_PING' });
    return !!(res && res.ok);
  } catch (_) {
    return false;
  }
}

/** Resolve once the tab has finished loading, or false if it never does. */
async function waitForTabComplete(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    let tab;
    try {
      tab = await api.tabs.get(tabId);
    } catch (_) {
      return false; // tab closed underneath us
    }
    if (tab.status === 'complete') return true;
    await sleep(PING_INTERVAL_MS);
  }

  return false;
}

/**
 * Inject the content script by hand.
 *
 * A manifest content_scripts entry only applies to pages loaded *after* the
 * extension was installed or reloaded, so any instagram.com tab that was
 * already open has no content script and never will until it is reloaded.
 * That is the single most common reason a scan cannot find a usable tab, and
 * this is the fix for it. Both files go in, in order: content.js reads
 * FLSettings out of settings.js.
 */
async function injectContentScript(tabId) {
  if (!api.scripting?.executeScript) return false;
  try {
    await api.scripting.executeScript({
      target: { tabId },
      files: CONTENT_FILES
    });
    return true;
  } catch (_) {
    return false;
  }
}

/** Ping, and if nobody answers, inject and ping again. */
async function reachTab(tabId) {
  if (await pingTab(tabId)) return true;
  if (!(await injectContentScript(tabId))) return false;
  await sleep(PING_INTERVAL_MS);
  return pingTab(tabId);
}

/**
 * Find a logged-in instagram.com tab, creating one if the user has none open.
 * The content script must be live there for the scan to run same-origin.
 */
async function ensureInstagramTab() {
  const tabs = await api.tabs.query({ url: '*://*.instagram.com/*' });

  for (const tab of tabs) {
    if (await reachTab(tab.id)) return tab.id;
  }

  // Nothing usable - open one and wait for it to finish loading. Active,
  // because the user is sitting and waiting on it either way, and a
  // background tab is throttled hard enough to blow the timeout.
  const tab = await api.tabs.create({
    url: 'https://www.instagram.com/',
    active: true
  });

  const loaded = await waitForTabComplete(tab.id, TAB_READY_TIMEOUT_MS);

  if (!loaded) {
    throw new Error(
      'instagram.com did not finish loading within ' +
        Math.round(TAB_READY_TIMEOUT_MS / 1000) +
        ' seconds. Check the tab that just opened - a slow connection, or a ' +
        'login or checkpoint screen, will do this.'
    );
  }

  if (await reachTab(tab.id)) return tab.id;

  // Loaded fine, but nothing is answering. That is the extension's own
  // problem, not the user's, so say so rather than telling them to open a
  // tab they can plainly see is already open.
  throw new Error(
    'instagram.com loaded, but the extension could not attach to it. Reload ' +
      'the extension on the extensions page, then try again. If it keeps ' +
      'happening, the tab console will name the error.'
  );
}

// ------------------------------------------------------------- persistence

function toIdList(users) {
  return users.map((u) => u.pk);
}

function buildDirectory(existing, users) {
  const directory = { ...existing };
  for (const u of users) {
    directory[u.pk] = {
      username: u.username,
      full_name: u.full_name,
      is_private: u.is_private,
      is_verified: u.is_verified,
      // Instagram's CDN URLs are signed and expire, so a directory entry for
      // an account that has since left will usually 404. The dashboard falls
      // back to initials when the image fails, which is that case.
      profile_pic_url: u.profile_pic_url || ''
    };
  }
  return directory;
}

async function persistScan(data) {
  const store = await api.storage.local.get(['snapshots', 'directory']);
  const snapshots = Array.isArray(store.snapshots) ? store.snapshots : [];
  const directory = store.directory && typeof store.directory === 'object'
    ? store.directory
    : {};

  const ts = Date.now();

  const snapshot = {
    ts,
    followerIds: toIdList(data.followers),
    followingIds: toIdList(data.following)
  };

  snapshots.push(snapshot);
  while (snapshots.length > MAX_SNAPSHOTS) snapshots.shift();

  const merged = buildDirectory(
    directory,
    data.followers.concat(data.following)
  );

  await api.storage.local.set({
    profile: data.profile,
    latest: { ts, followers: data.followers, following: data.following },
    snapshots,
    directory: merged
  });

  return ts;
}

// --------------------------------------------------------------- messaging

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return;

  // Progress relayed from the content script. The dashboard listens for these
  // directly; we only mirror them into persisted state.
  if (message.type === 'FL_PROGRESS') {
    setScanState({
      running: true,
      phase: message.phase || 'working',
      count: message.count || 0,
      note: message.note || '',
      error: null
    });
    return;
  }

  if (message.type === 'FL_SCAN_DONE') {
    persistScan(message.data)
      .then((ts) => {
        setScanState({ running: false, phase: 'done', note: '', error: null });
        try {
          const p = api.runtime.sendMessage({ type: 'FL_STORE_UPDATED', ts });
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch (_) {
          /* dashboard may be closed */
        }
      })
      .catch((err) => {
        setScanState({
          running: false,
          phase: 'error',
          error: 'Failed to save results: ' + (err?.message || String(err))
        });
      });
    return;
  }

  if (message.type === 'FL_SCAN_ERROR') {
    setScanState({
      running: false,
      phase: 'error',
      error: message.error || 'Scan failed.'
    });
    return;
  }

  if (message.type === 'FL_REQUEST_SCAN') {
    (async () => {
      try {
        await setScanState({
          running: true,
          phase: 'starting',
          count: 0,
          note: 'Locating Instagram tab',
          error: null
        });

        const tabId = await ensureInstagramTab();
        const res = await api.tabs.sendMessage(tabId, { type: 'FL_SCAN_START' });

        if (!res || !res.ok) {
          throw new Error(res?.error || 'Instagram tab refused to start a scan.');
        }

        sendResponse({ ok: true });
      } catch (err) {
        const msg = err?.message || String(err);
        await setScanState({ running: false, phase: 'error', error: msg });
        try {
          const p = api.runtime.sendMessage({ type: 'FL_SCAN_ERROR', error: msg });
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch (_) {
          /* ignore */
        }
        sendResponse({ ok: false, error: msg });
      }
    })();
    return true; // async sendResponse
  }

  if (message.type === 'FL_CANCEL_SCAN') {
    (async () => {
      try {
        const tabs = await api.tabs.query({ url: '*://*.instagram.com/*' });
        for (const tab of tabs) {
          try {
            await api.tabs.sendMessage(tab.id, { type: 'FL_SCAN_CANCEL' });
          } catch (_) {
            /* tab may not have the content script */
          }
        }
        await setScanState({
          running: false,
          phase: 'idle',
          note: '',
          error: null
        });
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  if (message.type === 'FL_GET_SCAN_STATE') {
    hydrateScanState().then(() => sendResponse({ ok: true, scanState }));
    return true;
  }
});

api.action.onClicked.addListener(() => {
  openDashboard();
});
