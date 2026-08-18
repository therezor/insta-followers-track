/*
 * Loads background.js the way the browser does and exercises its storage:
 * migration from the old flat keys, and per-account scan filing. Run: npm test
 *
 * The bug this pins: one flat set of keys held whatever was scanned last, so
 * scanning a second Instagram account overwrote the first and the next diff
 * compared two different people - reporting a smaller account's follower
 * count as a mass unfollowing.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src');

/** An in-memory storage.local, close enough to the real contract. */
function memoryStorage(seed = {}) {
  const data = { ...seed };

  return {
    data,
    local: {
      get: async (keys) => {
        if (keys == null) return { ...data };
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of list) if (k in data) out[k] = data[k];
        return out;
      },
      set: async (patch) => { Object.assign(data, patch); },
      remove: async (keys) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
      },
      clear: async () => { for (const k of Object.keys(data)) delete data[k]; }
    }
  };
}

function loadBackground(seed) {
  const storage = memoryStorage(seed);
  const listeners = [];

  const sandbox = {
    console, setTimeout, clearTimeout, URL, Math, Date, JSON, Promise,
    Number, Array, Set, String, Object, Error, Boolean,
    chrome: {
      runtime: {
        onMessage: { addListener: (fn) => listeners.push(fn) },
        sendMessage: () => Promise.resolve(),
        getURL: (p) => p,
        getManifest: () => ({ permissions: ['scripting'] })
      },
      storage,
      tabs: { query: async () => [], create: async () => ({ id: 1 }), sendMessage: async () => ({ ok: true }), get: async () => ({ status: 'complete' }), update: async () => {} },
      action: { onClicked: { addListener: () => {} } },
      permissions: { contains: async () => true },
      scripting: { executeScript: async () => {} }
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  vm.runInContext(
    fs.readFileSync(path.join(SRC, 'background.js'), 'utf8'),
    vm.createContext(sandbox),
    { filename: 'background.js' }
  );

  /** Send a message and await whatever the listener passes to sendResponse. */
  const send = (message) =>
    new Promise((resolve) => {
      for (const fn of listeners) {
        const handled = fn(message, {}, resolve);
        if (handled === true) return;
      }
      resolve(undefined);
    });

  return { storage, send, sandbox };
}

const scan = (pk, username, followers, following) => ({
  profile: { pk, username, full_name: username },
  followers: followers.map((n) => ({
    pk: String(n), username: 'u' + n, full_name: 'U ' + n,
    is_private: false, is_verified: false, profile_pic_url: ''
  })),
  following: following.map((n) => ({
    pk: String(n), username: 'u' + n, full_name: 'U ' + n,
    is_private: false, is_verified: false, profile_pic_url: ''
  }))
});

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test('background.js loads without throwing', () => {
  // It calls ensureMigrated() at load; placed above the `let` it closes over,
  // that is a TDZ error and the whole background context dies silently.
  assert.doesNotThrow(() => loadBackground({}));
});

test('a fresh install gets an empty account index', async () => {
  const { storage } = loadBackground({});
  await settle();

  assert.deepEqual(storage.data.accounts, {});
  assert.strictEqual(storage.data.activeAccount, null);
});

test('old flat storage migrates into the first account bucket', async () => {
  const { storage } = loadBackground({
    profile: { pk: '111', username: 'alice', full_name: 'Alice' },
    latest: { ts: 500, followers: [{ pk: '1' }], following: [{ pk: '2' }] },
    snapshots: [{ ts: 500, followerIds: ['1'], followingIds: ['2'] }],
    directory: { 1: { username: 'u1' } }
  });
  await settle();

  assert.deepEqual(Object.keys(storage.data.accounts), ['111']);
  assert.strictEqual(storage.data.accounts['111'].username, 'alice');
  assert.strictEqual(storage.data.activeAccount, '111');

  const bucket = storage.data['acct:111'];
  assert.strictEqual(bucket.latest.ts, 500);
  assert.strictEqual(bucket.snapshots.length, 1);
  assert.deepEqual(Object.keys(bucket.directory), ['1']);

  // Legacy keys are gone, and only after the new ones were written.
  for (const key of ['profile', 'latest', 'snapshots', 'directory']) {
    assert.ok(!(key in storage.data), key + ' survived migration');
  }
});

test('migration does not run twice over already-migrated storage', async () => {
  const seed = {
    accounts: { 111: { pk: '111', username: 'alice' } },
    activeAccount: '111',
    'acct:111': { latest: { ts: 9 }, snapshots: [], directory: {} }
  };
  const { storage } = loadBackground(seed);
  await settle();

  assert.deepEqual(Object.keys(storage.data.accounts), ['111']);
  assert.strictEqual(storage.data['acct:111'].latest.ts, 9);
});

test('scan data with no account id is dropped rather than crashing', async () => {
  const { storage } = loadBackground({
    latest: { ts: 1, followers: [], following: [] },
    snapshots: [{ ts: 1, followerIds: [], followingIds: [] }]
  });
  await settle();

  assert.deepEqual(storage.data.accounts, {});
  assert.ok(!('latest' in storage.data));
});

test('scanning a second account leaves the first untouched', async () => {
  const { storage, send } = loadBackground({});
  await settle();

  await send({ type: 'FL_SCAN_DONE', data: scan('111', 'alice', [1, 2, 3], [1]) });
  await settle();
  await send({ type: 'FL_SCAN_DONE', data: scan('222', 'bob', [9], [9]) });
  await settle();

  // The reported bug: bob's single follower must not land in alice's history.
  assert.deepEqual(Object.keys(storage.data.accounts).sort(), ['111', '222']);
  assert.strictEqual(storage.data['acct:111'].latest.followers.length, 3);
  assert.strictEqual(storage.data['acct:222'].latest.followers.length, 1);
  assert.strictEqual(storage.data['acct:111'].snapshots.length, 1);
  assert.strictEqual(storage.data['acct:222'].snapshots.length, 1);

  // And the view follows the account that was actually scanned.
  assert.strictEqual(storage.data.activeAccount, '222');
});

test('rescanning the same account appends to its own history', async () => {
  const { storage, send } = loadBackground({});
  await settle();

  await send({ type: 'FL_SCAN_DONE', data: scan('111', 'alice', [1, 2], [1]) });
  await settle();
  await send({ type: 'FL_SCAN_DONE', data: scan('111', 'alice', [1], [1]) });
  await settle();

  assert.strictEqual(storage.data['acct:111'].snapshots.length, 2);
  assert.strictEqual(storage.data.accounts['111'].followers, 1);
});

test('deleting an account removes its bucket and picks a new active one', async () => {
  const { storage, send } = loadBackground({});
  await settle();

  await send({ type: 'FL_SCAN_DONE', data: scan('111', 'alice', [1], [1]) });
  await settle();
  await send({ type: 'FL_SCAN_DONE', data: scan('222', 'bob', [9], [9]) });
  await settle();

  const res = await send({ type: 'FL_DELETE_ACCOUNT', pk: '222' });
  assert.strictEqual(res.ok, true);
  assert.ok(!('acct:222' in storage.data), "bob's data survived deletion");
  assert.deepEqual(Object.keys(storage.data.accounts), ['111']);
  assert.strictEqual(storage.data.activeAccount, '111');
});

test('FL_GET_ACCOUNTS reports the index and the active account', async () => {
  const { send } = loadBackground({});
  await settle();

  await send({ type: 'FL_SCAN_DONE', data: scan('111', 'alice', [1], [1]) });
  await settle();

  const res = await send({ type: 'FL_GET_ACCOUNTS' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.activeAccount, '111');
  assert.strictEqual(res.accounts['111'].username, 'alice');
});

test('the active account can be switched without touching scan data', async () => {
  const { storage, send } = loadBackground({});
  await settle();

  await send({ type: 'FL_SCAN_DONE', data: scan('111', 'alice', [1], [1]) });
  await settle();
  await send({ type: 'FL_SCAN_DONE', data: scan('222', 'bob', [9], [9]) });
  await settle();

  const res = await send({ type: 'FL_SET_ACTIVE_ACCOUNT', pk: '111' });
  assert.strictEqual(res.activeAccount, '111');
  assert.strictEqual(storage.data['acct:222'].latest.followers.length, 1);
});

test('the avatar rule file is a valid DNR ruleset', () => {
  // Rules are validated by the browser at install time, and a rule the schema
  // rejects disables the whole ruleset silently - the failure looks like
  // "profile pictures just do not load", which is where this started.
  const rules = JSON.parse(
    fs.readFileSync(path.join(SRC, 'rules.json'), 'utf8')
  );

  assert.ok(Array.isArray(rules) && rules.length === 1);

  const [rule] = rules;
  assert.deepEqual(Object.keys(rule).sort(), ['action', 'condition', 'id', 'priority']);
  assert.strictEqual(rule.action.type, 'modifyHeaders');

  const [header] = rule.action.requestHeaders;
  assert.strictEqual(header.header, 'referer');
  assert.strictEqual(header.operation, 'set');
  // The exact value the CDN checks for. Anything else - including no referer,
  // and including https://instagram.com without the www - gets
  // Cross-Origin-Resource-Policy: same-origin, which blocks the image.
  assert.strictEqual(header.value, 'https://www.instagram.com/');

  assert.deepEqual(rule.condition.resourceTypes, ['image']);
  assert.deepEqual(rule.condition.requestDomains.sort(), ['cdninstagram.com', 'fbcdn.net']);
});

test('the manifest ships the ruleset and the hosts it needs', () => {
  const build = fs.readFileSync(path.join(SRC, '..', 'build.mjs'), 'utf8');

  // A rule that fires on a host the extension has no permission for is a
  // no-op under declarativeNetRequestWithHostAccess.
  assert.ok(build.includes("'*://*.cdninstagram.com/*'"), 'cdninstagram host missing');
  assert.ok(build.includes("'*://*.fbcdn.net/*'"), 'fbcdn host missing');
  assert.ok(build.includes('declarativeNetRequestWithHostAccess'), 'DNR permission missing');
  assert.ok(build.includes("path: 'rules.json'"), 'ruleset not registered');
});

test('the dashboard does not suppress the referer on avatars', () => {
  // referrerPolicy = 'no-referrer' guarantees the blocked CORP variant.
  const source = fs.readFileSync(path.join(SRC, 'dashboard.js'), 'utf8');
  assert.ok(
    !/referrerPolicy\s*=\s*'no-referrer'/.test(source),
    "no-referrer is back - profile pictures will be blocked by the CDN"
  );
});
