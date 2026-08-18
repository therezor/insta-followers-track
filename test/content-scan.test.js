/*
 * Drives a whole scan through the content script with a stubbed Instagram.
 * Run: npm test
 *
 * The scan path had never been executed anywhere before this - not by the
 * unit tests, not by the dashboard preview - so every fix to it shipped on
 * inspection alone. This runs it: pagination, the settings carried on the
 * scan request, cancellation, and the shape handed back for storage.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src');

const igUser = (i) => ({
  pk: 1000 + i,
  username: 'user' + i,
  full_name: 'User ' + i,
  is_private: false,
  is_verified: false,
  profile_pic_url: 'https://cdn.example/' + i + '.jpg'
});

/**
 * @param pages map of list kind -> array of pages, each { users, next_max_id }
 */
function harness(pages) {
  const sent = [];
  const calls = [];
  let listener = null;

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    URL,
    Math,
    Date,
    JSON,
    Promise,
    Number,
    Array,
    Set,
    String,
    Error,
    document: { cookie: 'ds_user_id=42; csrftoken=tok', documentElement: { innerHTML: '' } },
    location: { origin: 'https://www.instagram.com' },
    fetch: async (url) => {
      calls.push(url);
      const parsed = new URL(url);

      if (parsed.pathname.includes('/users/')) {
        return { ok: true, status: 200, json: async () => ({ user: { username: 'me', full_name: 'Me' } }) };
      }

      const kind = parsed.pathname.includes('/followers/') ? 'followers' : 'following';
      const cursor = parsed.searchParams.get('max_id');
      const index = cursor ? Number(cursor) : 0;
      const page = pages[kind][index] ?? { users: [] };

      return { ok: true, status: 200, json: async () => page };
    },
    chrome: {
      runtime: {
        onMessage: { addListener: (fn) => { listener = fn; } },
        sendMessage: (msg) => { sent.push(msg); return Promise.resolve(); }
      },
      storage: { local: { get: () => Promise.resolve({}) } }
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.runInContext(
    fs.readFileSync(path.join(SRC, 'content.js'), 'utf8'),
    vm.createContext(sandbox),
    { filename: 'content.js' }
  );

  return { listener, sent, calls, sandbox };
}

/** Settings that make pacing instant, so the tests do not sleep. */
const INSTANT = {
  minDelaySec: 0,
  maxDelaySec: 0,
  pauseEvery: 0,
  pauseMinMin: 0,
  pauseMaxMin: 0
};

// Objects built inside the vm have a different prototype, so deepStrictEqual
// fails on identity alone; deepEqual compares structure, which is the point.
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test('a scan paginates both lists and reports what it collected', async () => {
  const { listener, sent, calls } = harness({
    followers: [
      { users: [igUser(1), igUser(2)], next_max_id: '1' },
      { users: [igUser(3)] }
    ],
    following: [{ users: [igUser(2), igUser(9)] }]
  });

  listener({ type: 'FL_SCAN_START', settings: INSTANT }, {}, () => {});
  await settle();

  const done = sent.find((m) => m.type === 'FL_SCAN_DONE');
  assert.ok(done, 'scan never reported completion: ' +
    JSON.stringify(sent.filter((m) => m.type === 'FL_SCAN_ERROR')));

  assert.strictEqual(done.data.profile.pk, '42');
  assert.strictEqual(done.data.profile.username, 'me');
  assert.deepEqual(done.data.followers.map((u) => u.username),
    ['user1', 'user2', 'user3']);
  assert.deepEqual(done.data.following.map((u) => u.username),
    ['user2', 'user9']);

  // Pagination really followed the cursor rather than stopping at page one.
  assert.ok(calls.some((u) => u.includes('max_id=1')), 'never followed next_max_id');
});

test('profile pictures survive the scan, and non-https ones do not', async () => {
  const { listener, sent } = harness({
    followers: [{
      users: [
        { ...igUser(1), profile_pic_url: 'https://cdn.example/ok.jpg' },
        { ...igUser(2), profile_pic_url: 'javascript:alert(1)' },
        { ...igUser(3), profile_pic_url: 'http://cdn.example/insecure.jpg' }
      ]
    }],
    following: [{ users: [] }]
  });

  listener({ type: 'FL_SCAN_START', settings: INSTANT }, {}, () => {});
  await settle();

  const done = sent.find((m) => m.type === 'FL_SCAN_DONE');
  assert.ok(done, 'scan did not finish');

  const urls = done.data.followers.map((u) => u.profile_pic_url);
  assert.strictEqual(urls[0], 'https://cdn.example/ok.jpg');
  assert.strictEqual(urls[1], '', 'a javascript: URL was kept');
  assert.strictEqual(urls[2], '', 'a plain http URL was kept');
});

test('a scan runs without any settings on the message', async () => {
  // Falls back to the built-in defaults. Real pacing would make this slow, so
  // only assert that it starts and does not error out immediately.
  const { listener, sent } = harness({
    followers: [{ users: [igUser(1)] }],
    following: [{ users: [] }]
  });

  listener({ type: 'FL_SCAN_START' }, {}, () => {});
  await settle();

  const failed = sent.find((m) => m.type === 'FL_SCAN_ERROR');
  assert.strictEqual(failed, undefined, 'errored with no settings: ' + failed?.error);
});

test('cancelling stops the scan and reports it as cancelled', async () => {
  const { listener, sent } = harness({
    followers: [
      { users: [igUser(1)], next_max_id: '1' },
      { users: [igUser(2)], next_max_id: '2' },
      { users: [igUser(3)] }
    ],
    following: [{ users: [] }]
  });

  // A real gap between requests, so there is a wait to interrupt.
  listener({ type: 'FL_SCAN_START', settings: { ...INSTANT, minDelaySec: 5, maxDelaySec: 5 } }, {}, () => {});
  await settle();
  listener({ type: 'FL_SCAN_CANCEL' }, {}, () => {});
  // Waits are interruptible on a one-second tick, so a cancel lands within
  // roughly that, not instantly.
  await settle(1400);

  const failed = sent.find((m) => m.type === 'FL_SCAN_ERROR');
  assert.ok(failed, 'cancel produced no result');
  assert.strictEqual(failed.code, 'cancelled');
  assert.strictEqual(sent.find((m) => m.type === 'FL_SCAN_DONE'), undefined);
});

test('a logged-out session fails with a message that says so', async () => {
  const { listener, sent, sandbox } = harness({ followers: [], following: [] });
  sandbox.document.cookie = '';

  listener({ type: 'FL_SCAN_START', settings: INSTANT }, {}, () => {});
  await settle();

  const failed = sent.find((m) => m.type === 'FL_SCAN_ERROR');
  assert.ok(failed, 'a logged-out scan reported nothing');
  assert.strictEqual(failed.code, 'auth');
  assert.match(failed.error, /log in/i);
});
