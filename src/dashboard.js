/*
 * Follower Tracker - dashboard
 *
 * Reads what the content script collected out of local storage and derives
 * every view from set differences. No network access happens on this page.
 */

'use strict';

const api = globalThis.browser ?? globalThis.chrome;

const $ = (sel) => document.querySelector(sel);

const state = {
  profile: null,
  latest: null,
  snapshots: [],
  directory: {},
  activeTab: 'not_following_back',
  query: '',
  sort: 'found',
  settings: FLSettings.DEFAULTS
};

/*
 * Grouped so the two-scan requirement is visible up front. Everything under
 * "Since your last scan" is empty until a second scan exists, which used to
 * read as a bug rather than as a fact about how change detection works.
 */
const TAB_GROUPS = [
  {
    label: 'Right now',
    tabs: [
      { id: 'not_following_back', label: "Doesn't follow you back" },
      { id: 'not_followed_back', label: "You don't follow back" },
      { id: 'mutuals', label: 'Mutuals' }
    ]
  },
  {
    label: 'Since your last scan',
    needsTwoScans: true,
    tabs: [
      { id: 'lost_followers', label: 'Unfollowed you' },
      { id: 'new_followers', label: 'New followers' },
      { id: 'new_following', label: 'You followed' },
      { id: 'you_unfollowed', label: 'You unfollowed' }
    ]
  },
  {
    label: 'Over time',
    tabs: [{ id: 'history', label: 'History' }]
  }
];

const TABS = TAB_GROUPS.flatMap((g) => g.tabs);

const CHANGE_TABS = new Set(
  TAB_GROUPS.filter((g) => g.needsTwoScans).flatMap((g) => g.tabs.map((t) => t.id))
);

// ------------------------------------------------------------------- utils

const fmt = (n) => n.toLocaleString();

function timeAgo(ts) {
  if (!ts) return 'never';
  const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return mins + (mins === 1 ? ' minute ago' : ' minutes ago');
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
  const days = Math.floor(hours / 24);
  if (days < 30) return days + (days === 1 ? ' day ago' : ' days ago');
  return new Date(ts).toLocaleDateString();
}

function initials(user) {
  const src = (user.full_name || user.username || '?').trim();
  const parts = src.split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Profile picture with an initials fallback. Instagram signs and expires these
 * CDN URLs, so a stored one for an account from an older scan will often 404 -
 * that is the case `error` handles, not an exceptional one.
 */
function avatar(user) {
  const el = document.createElement('div');
  el.className = 'avatar';

  const fallback = document.createElement('span');
  fallback.className = 'avatar-initials';
  fallback.textContent = initials(user);
  el.appendChild(fallback);

  const src = user.profile_pic_url;
  if (typeof src !== 'string' || !src.startsWith('https://')) return el;

  const img = document.createElement('img');
  img.className = 'avatar-img';
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  // Initials stay underneath and simply show through if the image never
  // arrives, so an expired URL degrades instead of leaving a blank circle.
  img.addEventListener('error', () => img.remove());
  img.src = src;
  el.appendChild(img);

  return el;
}

function emptyState(text) {
  const el = document.createElement('div');
  el.className = 'empty';
  el.textContent = text;
  return el;
}

// -------------------------------------------------------------- derivation

function currentLists() {
  return FLDiff.currentLists(state.latest);
}

function snapshotDelta() {
  return FLDiff.snapshotDelta(state.snapshots);
}

function listFor(tabId) {
  return FLDiff.listFor(tabId, state);
}

function applyFilters(users) {
  let out = users;

  const q = state.query.trim().toLowerCase();
  if (q) {
    out = out.filter(
      (u) =>
        u.username.toLowerCase().includes(q) ||
        u.full_name.toLowerCase().includes(q)
    );
  }

  if (state.sort === 'username') {
    out = [...out].sort((a, b) => a.username.localeCompare(b.username));
  } else if (state.sort === 'fullname') {
    out = [...out].sort((a, b) =>
      (a.full_name || a.username).localeCompare(b.full_name || b.username)
    );
  }

  return out;
}

// ---------------------------------------------------------------- rendering

function renderStats() {
  const { followers, following, followerIds, followingIds } = currentLists();
  const delta = snapshotDelta();

  const tiles = [
    { k: 'Followers', n: followers.length },
    { k: 'Following', n: following.length },
    {
      k: "Doesn't follow you back",
      n: following.filter((u) => !followerIds.has(u.pk)).length,
      tab: 'not_following_back'
    },
    {
      k: "You don't follow back",
      n: followers.filter((u) => !followingIds.has(u.pk)).length,
      tab: 'not_followed_back'
    },
    {
      k: 'Mutuals',
      n: followers.filter((u) => followingIds.has(u.pk)).length,
      tab: 'mutuals'
    },
    {
      k: 'Unfollowed you',
      n: delta ? delta.lostFollowers.length : 0,
      tab: 'lost_followers',
      tone: delta && delta.lostFollowers.length ? 'down' : '',
      // Shown at zero rather than hidden: "no tile" and "nobody left" look
      // identical otherwise, and this is the number people came for.
      hint: delta ? '' : 'after your second scan'
    }
  ];

  const stats = $('#stats');
  stats.textContent = '';

  for (const t of tiles) {
    // Only tiles that lead somewhere are focusable; the rest stay plain text.
    const card = document.createElement(t.tab ? 'button' : 'div');
    card.className = 'stat' + (t.tab ? ' is-link' : '');

    if (t.tab) {
      card.type = 'button';
      card.addEventListener('click', () => {
        state.activeTab = t.tab;
        render();
        $('#tabs').scrollIntoView({ block: 'nearest' });
      });
    }

    const n = document.createElement('div');
    n.className = 'n' + (t.tone ? ' ' + t.tone : '');
    n.textContent = fmt(t.n);
    card.appendChild(n);

    const k = document.createElement('div');
    k.className = 'k';
    k.textContent = t.k;
    card.appendChild(k);

    if (t.hint) {
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = t.hint;
      card.appendChild(hint);
    }

    stats.appendChild(card);
  }
}

function renderTabs() {
  const container = $('#tabs');
  container.textContent = '';

  const hasDelta = !!snapshotDelta();

  for (const group of TAB_GROUPS) {
    const wrap = document.createElement('div');
    wrap.className = 'tabgroup';

    const label = document.createElement('span');
    label.className = 'tabgroup-label';
    label.textContent =
      group.needsTwoScans && !hasDelta
        ? group.label + ' (needs 2 scans)'
        : group.label;
    wrap.appendChild(label);

    const row = document.createElement('div');
    row.className = 'tabgroup-row';
    row.setAttribute('role', 'tablist');

    for (const tab of group.tabs) {
      const btn = document.createElement('button');
      btn.className = 'tab';
      btn.type = 'button';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', String(state.activeTab === tab.id));
      btn.textContent = tab.label;

      if (tab.id !== 'history') {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = fmt(listFor(tab.id).length);
        btn.appendChild(badge);
      }

      btn.addEventListener('click', () => {
        state.activeTab = tab.id;
        render();
      });

      row.appendChild(btn);
    }

    wrap.appendChild(row);
    container.appendChild(wrap);
  }
}

function userRow(user) {
  const row = document.createElement('div');
  row.className = 'row';

  row.appendChild(avatar(user));

  const who = document.createElement('div');
  who.className = 'who';

  const link = document.createElement('a');
  link.target = '_blank';
  link.rel = 'noreferrer noopener';

  if (user.username) {
    link.href = 'https://www.instagram.com/' + encodeURIComponent(user.username) + '/';
    link.textContent = '@' + user.username;
  } else {
    link.href = 'https://www.instagram.com/';
    link.textContent = 'account ' + user.pk;
  }

  who.appendChild(link);

  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = user.full_name || ' ';
  who.appendChild(name);

  row.appendChild(who);

  if (user.is_verified) {
    const pill = document.createElement('span');
    pill.className = 'pill verified';
    pill.textContent = 'verified';
    row.appendChild(pill);
  }

  if (user.is_private) {
    const pill = document.createElement('span');
    pill.className = 'pill private';
    pill.textContent = 'private';
    row.appendChild(pill);
  }

  return row;
}

function renderHistory() {
  const container = $('#history');
  container.textContent = '';

  if (!state.snapshots.length) {
    container.appendChild(emptyState('No scans recorded yet.'));
    return;
  }

  const rows = [...state.snapshots].reverse();

  rows.forEach((snap, i) => {
    const prev = rows[i + 1];
    const row = document.createElement('div');
    row.className = 'hrow';

    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = new Date(snap.ts).toLocaleString();
    row.appendChild(when);

    const counts = document.createElement('span');
    counts.className = 'muted';
    counts.textContent =
      fmt(snap.followerIds.length) +
      ' followers, ' +
      fmt(snap.followingIds.length) +
      ' following';
    row.appendChild(counts);

    if (prev) {
      const d = snap.followerIds.length - prev.followerIds.length;
      const delta = document.createElement('span');
      delta.className = 'delta ' + (d >= 0 ? 'up' : 'down');
      delta.textContent = (d >= 0 ? '+' : '') + fmt(d) + ' followers';
      row.appendChild(delta);
    }

    container.appendChild(row);
  });
}

function renderList() {
  const container = $('#list');
  container.textContent = '';

  const users = applyFilters(listFor(state.activeTab));
  $('#result-count').textContent =
    fmt(users.length) + (users.length === 1 ? ' account' : ' accounts');

  if (!users.length) {
    const needsTwo = CHANGE_TABS.has(state.activeTab) && !snapshotDelta();
    const filtered = state.query.trim().length > 0;

    container.appendChild(
      emptyState(
        needsTwo
          ? 'This fills in from your second scan onwards. Scan again in a few days.'
          : filtered
            ? 'No accounts match "' + state.query.trim() + '".'
            : 'Nothing here — this list is empty.'
      )
    );
    return;
  }

  const frag = document.createDocumentFragment();
  for (const user of users) frag.appendChild(userRow(user));
  container.appendChild(frag);
}

function render() {
  const isHistory = state.activeTab === 'history';

  renderStats();
  renderTabs();

  if (isHistory) renderHistory();
  else renderList();

  // Visibility last: updateWelcome owns every panel's hidden flag, so letting
  // it run after the renderers keeps one place responsible for the layout.
  updateWelcome(!$('#progress').hidden);

  const profile = state.profile;
  $('#profile-line').textContent = profile?.username
    ? '@' + profile.username + ' \u00b7 last scan ' + timeAgo(state.latest?.ts)
    : state.latest
      ? 'Last scan ' + timeAgo(state.latest.ts)
      : 'Not scanned yet';
}

// ------------------------------------------------------------------ export

function exportCsv() {
  const users = applyFilters(listFor(state.activeTab));
  if (!users.length) {
    // Silently doing nothing reads as a broken button.
    showBanner('Nothing to export - this list is empty.', '');
    return;
  }

  const escape = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';

  const lines = [['username', 'full_name', 'profile_url', 'user_id'].join(',')];
  for (const u of users) {
    lines.push(
      [
        escape(u.username),
        escape(u.full_name),
        escape(u.username ? 'https://www.instagram.com/' + u.username + '/' : ''),
        escape(u.pk)
      ].join(',')
    );
  }

  const blob = new Blob([lines.join('\n')], {
    type: 'text/csv;charset=utf-8'
  });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = 'followlens-' + state.activeTab + '.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ------------------------------------------------------------------- shell

function showBanner(text, kind) {
  const el = $('#banner');
  // textContent on the banner itself would delete the icon element.
  $('#banner-text').textContent = text;
  $('#banner-icon')
    .querySelector('use')
    .setAttribute('href', kind === 'error' ? '#i-alert' : '#i-check');
  el.className = 'banner' + (kind ? ' ' + kind : '');
  el.hidden = !text;
}

function setScanning(running, note, count) {
  $('#scan-btn').disabled = running;
  // Writing to the label span, not the button: textContent on the button
  // would remove the icon along with the text.
  $('#scan-label').textContent = running ? 'Scanning' : 'Scan now';
  $('#scan-btn').classList.toggle('is-busy', running);
  $('#cancel-btn').hidden = !running;
  $('#progress').hidden = !running;

  if (running) {
    $('#progress-note').textContent = note || 'Working';
    $('#progress-count').textContent = count ? fmt(count) + ' collected so far' : '';
  }

  updateWelcome(running);
}

/**
 * Before the first scan there is nothing to show but a screen of zeroes, so
 * swap the whole results area for instructions. Hidden again the moment a
 * scan starts, so the progress line is not competing with a call to action.
 */
function updateWelcome(scanning) {
  const firstRun = !state.latest && !scanning;

  $('#welcome').hidden = !firstRun;
  $('#stats').hidden = firstRun;
  $('#tabs').hidden = firstRun;
  $('#list').hidden = firstRun || state.activeTab === 'history';
  $('#history').hidden = firstRun || state.activeTab !== 'history';
  document.querySelector('.toolbar').hidden =
    firstRun || state.activeTab === 'history';
}

async function loadStore() {
  const store = await api.storage.local.get([
    'profile',
    'latest',
    'snapshots',
    'directory',
    'settings'
  ]);

  state.profile = store.profile ?? null;
  state.latest = store.latest ?? null;
  state.snapshots = Array.isArray(store.snapshots) ? store.snapshots : [];
  state.directory =
    store.directory && typeof store.directory === 'object' ? store.directory : {};
  state.settings = FLSettings.normalizeSettings(store.settings);

  fillSettingsForm(state.settings);
  render();
}

// ---------------------------------------------------------------- settings

const SETTING_FIELDS = {
  minDelaySec: '#min-delay',
  maxDelaySec: '#max-delay',
  pauseEvery: '#pause-every',
  pauseMinMin: '#pause-min',
  pauseMaxMin: '#pause-max'
};

function fillSettingsForm(settings) {
  for (const [key, sel] of Object.entries(SETTING_FIELDS)) {
    $(sel).value = String(settings[key]);
  }
  renderEstimate(settings);
}

function readSettingsForm() {
  const raw = {};
  for (const [key, sel] of Object.entries(SETTING_FIELDS)) {
    raw[key] = $(sel).value;
  }
  return FLSettings.normalizeSettings(raw);
}

/**
 * Show what the current numbers cost in wall-clock time, using the size of
 * the last scan so the figure means something to this account.
 */
function renderEstimate(settings) {
  const accounts =
    (state.latest?.followers?.length ?? 0) + (state.latest?.following?.length ?? 0);
  const sample = accounts > 0 ? accounts : 10000;
  const minutes = FLSettings.estimateMinutes(settings, sample);
  const duration =
    minutes < 1
      ? 'under a minute'
      : minutes < 90
        ? 'about ' + Math.round(minutes) + ' minutes'
        : 'about ' + (Math.round((minutes / 60) * 10) / 10) + ' hours';

  $('#settings-estimate').textContent =
    accounts > 0
      ? 'At these settings your last scan size (' +
        fmt(sample) +
        ' accounts) would take ' +
        duration +
        '.'
      : 'At these settings a 10,000-account profile would take ' + duration + '.';
}

function setSettingsStatus(text) {
  $('#settings-status').textContent = text || '';
}

async function saveSettings(settings) {
  state.settings = settings;
  fillSettingsForm(settings);
  await api.storage.local.set({ settings });
}

async function startScan() {
  showBanner('', '');
  setScanning(true, 'Starting');

  try {
    // Normalised here, where settings.js is guaranteed loaded, and carried to
    // the content script - which no longer loads settings.js itself.
    const res = await api.runtime.sendMessage({
      type: 'FL_REQUEST_SCAN',
      settings: FLSettings.normalizeSettings(state.settings)
    });
    if (!res || !res.ok) {
      setScanning(false);
      showBanner(res?.error || 'Could not start the scan.', 'error');
    }
  } catch (err) {
    setScanning(false);
    showBanner(err?.message || String(err), 'error');
  }
}

api.runtime.onMessage.addListener((message) => {
  if (!message || typeof message.type !== 'string') return;

  if (message.type === 'FL_PROGRESS') {
    setScanning(true, message.note, message.count);
    return;
  }

  if (message.type === 'FL_SCAN_ERROR') {
    setScanning(false);
    showBanner(message.error || 'Scan failed.', 'error');
    return;
  }

  if (message.type === 'FL_STORE_UPDATED') {
    setScanning(false);
    showBanner('Scan complete.', 'ok');
    loadStore();
  }
});

$('#scan-btn').addEventListener('click', startScan);

$('#cancel-btn').addEventListener('click', async () => {
  await api.runtime.sendMessage({ type: 'FL_CANCEL_SCAN' });
  setScanning(false);
  showBanner('Scan cancelled.', '');
});

$('#search').addEventListener('input', (e) => {
  state.query = e.target.value;
  renderList();
});

$('#sort').addEventListener('change', (e) => {
  state.sort = e.target.value;
  renderList();
});

$('#export-btn').addEventListener('click', exportCsv);

$('#settings-btn').addEventListener('click', () => {
  const panel = $('#settings-panel');
  panel.hidden = !panel.hidden;
  $('#settings-btn').setAttribute('aria-expanded', String(!panel.hidden));
  if (!panel.hidden) {
    fillSettingsForm(state.settings);
    setSettingsStatus('');
    $('#min-delay').focus();
  }
});

$('#settings-save').addEventListener('click', async () => {
  const settings = readSettingsForm();
  await saveSettings(settings);
  setSettingsStatus('Saved. Applies to the next scan.');
});

$('#settings-reset').addEventListener('click', async () => {
  await saveSettings({ ...FLSettings.DEFAULTS });
  setSettingsStatus('Reset to defaults.');
});

for (const sel of Object.values(SETTING_FIELDS)) {
  $(sel).addEventListener('input', () => {
    renderEstimate(readSettingsForm());
    setSettingsStatus('Unsaved changes.');
  });
}

/*
 * "/" to jump to the filter and Escape to clear it: with lists this long,
 * reaching for the mouse to filter is the main friction in the page.
 */
document.addEventListener('keydown', (e) => {
  const search = $('#search');
  const typing =
    e.target instanceof HTMLInputElement ||
    e.target instanceof HTMLSelectElement ||
    e.target instanceof HTMLTextAreaElement;

  if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    search.focus();
    search.select();
    return;
  }

  if (e.key === 'Escape') {
    if (e.target === search && search.value) {
      search.value = '';
      state.query = '';
      renderList();
      return;
    }
    if (!$('#settings-panel').hidden) {
      $('#settings-panel').hidden = true;
      $('#settings-btn').setAttribute('aria-expanded', 'false');
      $('#settings-btn').focus();
    }
  }
});

$('#wipe-btn').addEventListener('click', async () => {
  await api.storage.local.clear();
  state.profile = null;
  state.latest = null;
  state.snapshots = [];
  state.directory = {};
  state.settings = FLSettings.DEFAULTS;
  fillSettingsForm(state.settings);
  setSettingsStatus('');
  showBanner('All stored data deleted.', 'ok');
  render();
});

(async () => {
  await loadStore();
  try {
    const res = await api.runtime.sendMessage({ type: 'FL_GET_SCAN_STATE' });
    if (res?.scanState?.running) {
      setScanning(true, res.scanState.note, res.scanState.count);
    }
  } catch (_) {
    /* background may be asleep */
  }
})();
