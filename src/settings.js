/*
 * Follower Tracker - scan pacing settings
 *
 * Pure like diff.js: no DOM, no extension APIs, so it can be unit tested
 * under node and loaded identically by the content script and the dashboard.
 *
 * Normalisation runs on read as well as on write. A stored object with
 * max < min would otherwise produce a negative delay, which sleeps for zero
 * and silently removes the pacing this module exists to provide.
 */

(function (root) {
  'use strict';

  const DEFAULTS = {
    minDelaySec: 2,      // random gap between requests, lower bound
    maxDelaySec: 12,     // random gap between requests, upper bound
    pauseEvery: 200,     // long pause after this many requests; 0 disables
    pauseMinMin: 1,      // long pause length, lower bound, minutes
    pauseMaxMin: 3       // long pause length, upper bound, minutes
  };

  const LIMITS = {
    minDelaySec: { min: 0, max: 300 },
    maxDelaySec: { min: 0, max: 300 },
    pauseEvery: { min: 0, max: 10000 },
    pauseMinMin: { min: 0, max: 120 },
    pauseMaxMin: { min: 0, max: 120 }
  };

  function clampNumber(value, fallback, bounds) {
    const n = typeof value === 'string' ? Number(value.trim()) : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(bounds.max, Math.max(bounds.min, n));
  }

  /**
   * Coerce anything at all into a usable settings object. Ranges are ordered
   * rather than rejected: a max below its min is raised to the min, so the
   * range degrades to a fixed value instead of an inverted one.
   */
  function normalizeSettings(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const out = {};

    for (const key of Object.keys(DEFAULTS)) {
      out[key] = clampNumber(input[key], DEFAULTS[key], LIMITS[key]);
    }

    out.minDelaySec = Math.round(out.minDelaySec * 10) / 10;
    out.maxDelaySec = Math.round(out.maxDelaySec * 10) / 10;
    out.pauseEvery = Math.round(out.pauseEvery);
    out.pauseMinMin = Math.round(out.pauseMinMin * 10) / 10;
    out.pauseMaxMin = Math.round(out.pauseMaxMin * 10) / 10;

    if (out.maxDelaySec < out.minDelaySec) out.maxDelaySec = out.minDelaySec;
    if (out.pauseMaxMin < out.pauseMinMin) out.pauseMaxMin = out.pauseMinMin;

    return out;
  }

  /** Milliseconds to wait between two consecutive requests. */
  function requestDelayMs(settings, rand) {
    const s = normalizeSettings(settings);
    const r = typeof rand === 'function' ? rand : Math.random;
    return (s.minDelaySec + r() * (s.maxDelaySec - s.minDelaySec)) * 1000;
  }

  /** Milliseconds to wait for one of the periodic long pauses. */
  function longPauseMs(settings, rand) {
    const s = normalizeSettings(settings);
    const r = typeof rand === 'function' ? rand : Math.random;
    return (s.pauseMinMin + r() * (s.pauseMaxMin - s.pauseMinMin)) * 60000;
  }

  /** True when `completed` requests should be followed by a long pause. */
  function shouldLongPause(settings, completed) {
    const s = normalizeSettings(settings);
    if (s.pauseEvery <= 0) return false;
    if (!Number.isFinite(completed) || completed <= 0) return false;
    return completed % s.pauseEvery === 0;
  }

  /**
   * Rough wall-clock estimate for a scan, in minutes. Used only to show the
   * user what their settings cost before they commit to them.
   */
  function estimateMinutes(settings, accounts) {
    const s = normalizeSettings(settings);
    const n = Number.isFinite(accounts) && accounts > 0 ? accounts : 0;
    const requests = Math.ceil(n / 50);
    if (requests <= 1) return 0;

    const gaps = requests - 1;
    const avgDelay = (s.minDelaySec + s.maxDelaySec) / 2;
    const pauses = s.pauseEvery > 0 ? Math.floor(requests / s.pauseEvery) : 0;
    const avgPause = ((s.pauseMinMin + s.pauseMaxMin) / 2) * 60;

    return (gaps * avgDelay + pauses * avgPause) / 60;
  }

  const FLSettings = {
    DEFAULTS,
    LIMITS,
    normalizeSettings,
    requestDelayMs,
    longPauseMs,
    shouldLongPause,
    estimateMinutes
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = FLSettings;
  else root.FLSettings = FLSettings;
})(typeof globalThis !== 'undefined' ? globalThis : this);
