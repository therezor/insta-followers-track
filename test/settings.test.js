/* Unit tests for scan pacing settings. Run: npm test */

const test = require('node:test');
const assert = require('node:assert');
const FLSettings = require('../src/settings.js');

const { DEFAULTS, normalizeSettings } = FLSettings;

test('defaults are the documented 2-12s interval and 200-request pause', () => {
  assert.deepStrictEqual(DEFAULTS, {
    minDelaySec: 2,
    maxDelaySec: 12,
    pauseEvery: 200,
    pauseMinMin: 1,
    pauseMaxMin: 3
  });
});

test('missing, null and junk input all fall back to defaults', () => {
  for (const input of [undefined, null, {}, 'nonsense', 42, []]) {
    assert.deepStrictEqual(normalizeSettings(input), DEFAULTS);
  }
});

test('per-field junk falls back without discarding the valid fields', () => {
  const out = normalizeSettings({ minDelaySec: 'abc', maxDelaySec: 20 });
  assert.strictEqual(out.minDelaySec, DEFAULTS.minDelaySec);
  assert.strictEqual(out.maxDelaySec, 20);
});

test('numeric strings from form inputs are accepted', () => {
  const out = normalizeSettings({ minDelaySec: ' 5 ', pauseEvery: '150' });
  assert.strictEqual(out.minDelaySec, 5);
  assert.strictEqual(out.pauseEvery, 150);
});

test('an inverted range is ordered, never left negative', () => {
  const out = normalizeSettings({ minDelaySec: 9, maxDelaySec: 1 });
  assert.strictEqual(out.minDelaySec, 9);
  assert.strictEqual(out.maxDelaySec, 9);
  assert.ok(FLSettings.requestDelayMs(out, () => 0) >= 0);

  const pause = normalizeSettings({ pauseMinMin: 5, pauseMaxMin: 2 });
  assert.strictEqual(pause.pauseMaxMin, 5);
});

test('out-of-range values clamp instead of throwing', () => {
  const out = normalizeSettings({
    minDelaySec: -10,
    maxDelaySec: 99999,
    pauseEvery: -1,
    pauseMinMin: -3,
    pauseMaxMin: 9999
  });
  assert.strictEqual(out.minDelaySec, 0);
  assert.strictEqual(out.maxDelaySec, 300);
  assert.strictEqual(out.pauseEvery, 0);
  assert.strictEqual(out.pauseMinMin, 0);
  assert.strictEqual(out.pauseMaxMin, 120);
});

test('request delay spans the configured range and never goes negative', () => {
  const s = normalizeSettings({ minDelaySec: 2, maxDelaySec: 12 });
  assert.strictEqual(FLSettings.requestDelayMs(s, () => 0), 2000);
  assert.strictEqual(FLSettings.requestDelayMs(s, () => 1), 12000);
  assert.strictEqual(FLSettings.requestDelayMs(s, () => 0.5), 7000);

  for (let i = 0; i < 500; i += 1) {
    const ms = FLSettings.requestDelayMs(s);
    assert.ok(ms >= 2000 && ms <= 12000, 'delay out of range: ' + ms);
  }
});

test('long pause spans the configured minutes', () => {
  const s = normalizeSettings({ pauseMinMin: 1, pauseMaxMin: 3 });
  assert.strictEqual(FLSettings.longPauseMs(s, () => 0), 60000);
  assert.strictEqual(FLSettings.longPauseMs(s, () => 1), 180000);
});

test('a pause fires on every multiple of the configured count', () => {
  const s = normalizeSettings({ pauseEvery: 200 });
  assert.strictEqual(FLSettings.shouldLongPause(s, 0), false);
  assert.strictEqual(FLSettings.shouldLongPause(s, 199), false);
  assert.strictEqual(FLSettings.shouldLongPause(s, 200), true);
  assert.strictEqual(FLSettings.shouldLongPause(s, 400), true);
  assert.strictEqual(FLSettings.shouldLongPause(s, 401), false);
});

test('pauseEvery 0 disables pausing without dividing by zero', () => {
  const s = normalizeSettings({ pauseEvery: 0 });
  for (const n of [0, 1, 200, 5000]) {
    assert.strictEqual(FLSettings.shouldLongPause(s, n), false);
  }
});

test('estimate reflects both the interval and the pauses', () => {
  const noPause = normalizeSettings({
    minDelaySec: 2,
    maxDelaySec: 12,
    pauseEvery: 0
  });
  // 10k accounts -> 200 requests -> 199 gaps at 7s average.
  assert.strictEqual(
    Math.round(FLSettings.estimateMinutes(noPause, 10000)),
    Math.round((199 * 7) / 60)
  );

  const withPause = normalizeSettings(DEFAULTS);
  assert.ok(
    FLSettings.estimateMinutes(withPause, 10000) >
      FLSettings.estimateMinutes(noPause, 10000)
  );
  assert.strictEqual(FLSettings.estimateMinutes(DEFAULTS, 0), 0);
});

test('normalize is idempotent', () => {
  const once = normalizeSettings({ minDelaySec: '7.44', maxDelaySec: 3 });
  assert.deepStrictEqual(normalizeSettings(once), once);
});
