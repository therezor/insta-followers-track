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

const TABS = [
  { id: 'not_following_back', label: "Doesn't follow you back" },
  { id: 'not_followed_back', label: "You don't follow back" },
  { id: 'mutuals', label: 'Mutuals' },
  { id: 'new_followers', label: 'New followers' },
  { id: 'lost_followers', label: 'Lost followers' },
  { id: 'new_following', label: 'Newly followed' },
  { id: 'you_unfollowed', label: 'You unfollowed' },
  { id: 'history', label: 'History' }
];

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
      k: "Doesn't follow back",
      n: following.filter((u) => !followerIds.has(u.pk)).length
    },
    {
      k: 'Fans (you skip)',
      n: followers.filter((u) => !followingIds.has(u.pk)).length
    },
    {
      k: 'Mutuals',
      n: followers.filter((u) => followingIds.has(u.pk)).length
    }
  ];

  if (delta) {
    tiles.push({ k: 'Lost since last scan', n: delta.lostFollowers.length });
  }

  const stats = $('#stats');
  stats.textContent = '';

  for (const t of tiles) {
    const card = document.createElement('div');
    card.className = 'stat';

    const n = document.createElement('div');
    n.className = 'n';
    n.textContent = fmt(t.n);
    card.appendChild(n);

    const k = document.createElement('div');
    k.className = 'k';
    k.textContent = t.k;
    card.appendChild(k);

    stats.appendChild(card);
  }
}

function renderTabs() {
  const container = $('#tabs');
  container.textContent = '';

  for (const tab of TABS) {
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

    container.appendChild(btn);
  }
}

function userRow(user) {
  const row = document.createElement('div');
  row.className = 'row';

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = initials(user);
  row.appendChild(avatar);

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
    const delta = snapshotDelta();
    const needsTwo = [
      'new_followers',
      'lost_followers',
      'new_following',
      'you_unfollowed'
    ].includes(state.activeTab);

    container.appendChild(
      emptyState(
        needsTwo && !delta
          ? 'Run at least two scans to see changes over time.'
          : 'Nothing here.'
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

  $('#history').hidden = !isHistory;
  $('#list').hidden = isHistory;
  document.querySelector('.toolbar').hidden = isHistory;

  renderStats();
  renderTabs();

  if (isHistory) renderHistory();
  else renderList();

  const profile = state.profile;
  $('#profile-line').textContent = profile?.username
    ? '@' + profile.username + ' - last scan ' + timeAgo(state.latest?.ts)
    : state.latest
      ? 'Last scan ' + timeAgo(state.latest.ts)
      : 'Not scanned yet';
}

// ------------------------------------------------------------------ export

function exportCsv() {
  const users = applyFilters(listFor(state.activeTab));
  if (!users.length) return;

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
  el.textContent = text;
  el.className = 'banner' + (kind ? ' ' + kind : '');
  el.hidden = !text;
}

function setScanning(running, note, count) {
  $('#scan-btn').disabled = running;
  $('#scan-btn').textContent = running ? 'Scanning...' : 'Scan now';
  $('#cancel-btn').hidden = !running;
  $('#progress').hidden = !running;

  if (running) {
    $('#progress-note').textContent = note || 'Working';
    $('#progress-count').textContent = count ? ' - ' + fmt(count) + ' collected' : '';
  }
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
  const label = accounts > 0 ? 'your last scan size' : 'a 10,000-account example';

  $('#settings-estimate').textContent =
    'Estimated scan time for ' +
    label +
    ' (' +
    fmt(sample) +
    ' accounts): about ' +
    (minutes < 1 ? 'under a minute' : Math.round(minutes) + ' minutes') +
    '.';
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
    const res = await api.runtime.sendMessage({ type: 'FL_REQUEST_SCAN' });
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
  if (!panel.hidden) {
    fillSettingsForm(state.settings);
    setSettingsStatus('');
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
