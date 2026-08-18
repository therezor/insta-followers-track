/*
 * Follower Tracker - toolbar popup
 *
 * A small read-only view of the last scan, plus the two controls worth having
 * one click away: start a scan, and open the full dashboard. Like the
 * dashboard, this page makes no network requests of its own.
 *
 * The popup is torn down whenever it loses focus, so it owns no state. It
 * reads storage on open and asks the background for the live scan state,
 * which survives the popup closing mid-scan.
 */

'use strict';

const api = globalThis.browser ?? globalThis.chrome;

const $ = (sel) => document.querySelector(sel);
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

function showError(text) {
  const banner = $('#p-error');
  if (!text) {
    banner.hidden = true;
    return;
  }

  // Attach failures are a multi-line diagnostic. A 300px popup cannot show
  // that, so lead with the first line and keep the rest in the tooltip -
  // the dashboard renders it in full.
  const [first] = String(text).split('\n');
  $('#p-error-text').textContent = first;
  banner.title = text;
  banner.hidden = false;
}

function setScanning(running, note, count) {
  // Hidden rather than disabled: three buttons do not fit across 300px, and
  // Stop is the only useful control mid-scan anyway.
  $('#p-scan').hidden = running;
  $('#p-cancel').hidden = !running;
  $('#p-progress').hidden = !running;

  if (running) {
    $('#p-progress-note').textContent = note || 'Working';
    $('#p-progress-count').textContent = count ? fmt(count) + ' collected' : '';
  }
}

function renderSummary(store) {
  const latest = store.latest ?? null;
  const snapshots = Array.isArray(store.snapshots) ? store.snapshots : [];

  $('#p-profile').textContent = store.profile?.username
    ? '@' + store.profile.username + ' · ' + timeAgo(latest?.ts)
    : latest
      ? 'Last scan ' + timeAgo(latest.ts)
      : 'Not scanned yet';

  if (!latest) {
    $('#p-empty').hidden = false;
    $('#p-stats').hidden = true;
    return;
  }

  $('#p-empty').hidden = true;
  $('#p-stats').hidden = false;

  const { followers, following, followerIds } = FLDiff.currentLists(latest);
  const delta = FLDiff.snapshotDelta(snapshots);
  const lost = delta ? delta.lostFollowers.length : 0;

  $('#p-followers').textContent = fmt(followers.length);
  $('#p-following').textContent = fmt(following.length);
  $('#p-nfb').textContent = fmt(
    following.filter((u) => !followerIds.has(u.pk)).length
  );

  const lostEl = $('#p-lost');
  lostEl.textContent = fmt(lost);
  lostEl.classList.toggle('down', lost > 0);
}

async function load() {
  const store = await api.storage.local.get([
    'profile',
    'latest',
    'snapshots',
    'settings'
  ]);
  renderSummary(store);
  return store;
}

// ------------------------------------------------------------------ events

$('#p-open').addEventListener('click', async () => {
  await api.runtime.sendMessage({ type: 'FL_OPEN_DASHBOARD' });
  window.close();
});

$('#p-scan').addEventListener('click', async () => {
  showError('');
  setScanning(true, 'Starting');

  try {
    const store = await api.storage.local.get('settings');
    const res = await api.runtime.sendMessage({
      type: 'FL_REQUEST_SCAN',
      settings: FLSettings.normalizeSettings(store?.settings)
    });
    if (!res || !res.ok) {
      setScanning(false);
      showError(res?.error || 'Could not start the scan.');
    }
  } catch (err) {
    setScanning(false);
    showError(err?.message || String(err));
  }
});

$('#p-cancel').addEventListener('click', async () => {
  await api.runtime.sendMessage({ type: 'FL_CANCEL_SCAN' });
  setScanning(false);
});

api.runtime.onMessage.addListener((message) => {
  if (!message || typeof message.type !== 'string') return;

  if (message.type === 'FL_PROGRESS') {
    setScanning(true, message.note, message.count);
    return;
  }

  if (message.type === 'FL_SCAN_ERROR') {
    setScanning(false);
    showError(message.error || 'Scan failed.');
    return;
  }

  if (message.type === 'FL_STORE_UPDATED') {
    setScanning(false);
    load();
  }
});

(async () => {
  await load();

  try {
    const res = await api.runtime.sendMessage({ type: 'FL_GET_SCAN_STATE' });
    const state = res?.scanState;
    if (state?.running) setScanning(true, state.note, state.count);
    else if (state?.error) showError(state.error);
  } catch (_) {
    /* background may be asleep; the summary above still rendered */
  }
})();
