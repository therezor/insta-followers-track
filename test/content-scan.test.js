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
/** A Storage-like object over a plain map, as the page's DOM storage. */
function storage(map = {}) {
  const keys = Object.keys(map);
  return {
    getItem: (k) => (k in map ? map[k] : null),
    key: (i) => keys[i] ?? null,
    get length() { return keys.length; }
  };
}

/**
 * @param page the tab's own state: html, localStorage, sessionStorage maps
 */
function harness(pages, page = {}) {
  const sent = [];
  const calls = [];
  const inits = [];
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
    document: { cookie: 'ds_user_id=42; csrftoken=tok', documentElement: { innerHTML: page.html ?? '' } },
    location: { origin: 'https://www.instagram.com' },
    localStorage: storage(page.localStorage),
    sessionStorage: storage({ 'www-claim-v2': 'hmac.claim', ...page.sessionStorage }),
    navigator: { maxTouchPoints: 0 },
    fetch: async (url, init) => {
      calls.push(url);
      inits.push(init);
      const parsed = new URL(url);

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

  return { listener, sent, calls, inits, sandbox };
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
  assert.deepEqual(done.data.followers.map((u) => u.username),
    ['user1', 'user2', 'user3']);
  assert.deepEqual(done.data.following.map((u) => u.username),
    ['user2', 'user9']);

  // Pagination really followed the cursor rather than stopping at page one.
  assert.ok(calls.some((u) => u.includes('max_id=1')), 'never followed next_max_id');
});

test('a scan only calls the endpoints instagram.com itself calls', async () => {
  // /users/<id>/info/ is a mobile-app endpoint that Instagram 429s at once
  // for a web session. The account id comes from the cookie instead.
  const { listener, sent, calls } = harness({
    followers: [{ users: [igUser(1)] }],
    following: [{ users: [igUser(2)] }]
  });

  listener({ type: 'FL_SCAN_START', settings: INSTANT }, {}, () => {});
  await settle();

  const done = sent.find((m) => m.type === 'FL_SCAN_DONE');
  assert.ok(done, 'scan did not finish');
  assert.strictEqual(done.data.profile.pk, '42');
  assert.deepEqual(
    calls.filter((u) => !new URL(u).pathname.startsWith('/api/v1/friendships/')),
    [],
    'the scan made a request outside the friendship lists'
  );
});

test('requests are shaped like instagram.com\'s own list requests', async () => {
  // Observed in Chrome on 2026-09-25 from the Followers / Following dialogs.
  const { listener, sent, calls, inits } = harness({
    followers: [{ users: [igUser(1)], next_max_id: '1' }, { users: [igUser(3)] }],
    following: [{ users: [igUser(2)] }]
  });

  listener({ type: 'FL_SCAN_START', settings: INSTANT }, {}, () => {});
  await settle();
  assert.ok(sent.find((m) => m.type === 'FL_SCAN_DONE'), 'scan did not finish');

  const params = calls.map((u) => [...new URL(u).searchParams.keys()].join(','));
  assert.deepEqual(params, [
    'count,search_surface',
    'count,max_id,search_surface',
    'count'
  ]);
  for (const u of calls) assert.strictEqual(new URL(u).searchParams.get('count'), '12');
  assert.strictEqual(new URL(calls[0]).searchParams.get('search_surface'), 'follow_list_page');

  const headers = inits[0].headers;
  assert.deepEqual(Object.keys(headers), [
    'x-csrftoken', 'x-ig-app-id', 'x-asbd-id', 'x-ig-www-claim',
    'x-web-session-id', 'x-ig-max-touch-points', 'accept', 'x-requested-with'
  ]);
  assert.strictEqual(headers['x-csrftoken'], 'tok');
  assert.strictEqual(headers['x-asbd-id'], '359341');
  assert.strictEqual(headers['x-ig-www-claim'], 'hmac.claim');
  assert.match(headers['x-web-session-id'], /^[a-z0-9]{6}:[a-z0-9]{6}:[a-z0-9]{6}$/);
  // One session id for the whole scan, as the web app keeps one per page.
  assert.ok(inits.every((i) => i.headers['x-web-session-id'] === headers['x-web-session-id']));
});

test('requests carry the tab\'s own session id, profile Referer and username', async () => {
  // Layout observed on instagram.com on 2026-09-25.
  const { listener, sent, inits } = harness({
    followers: [{ users: [igUser(1)] }],
    following: [{ users: [] }]
  }, {
    // Shape as served on 2026-09-25; a brace in the bio must not end it.
    html: '"user":{"pk":"77","username":"someone.else"}...' +
      '["PolarisViewer",[],{"data":{"biography":"a } b { \\" c","full_name":"Me Self",' +
      '"id":"42","username":"me.self"}},-1]',
    localStorage: {
      Session: 'aaaaaa:1790000000000',
      'bz:aaaaaa:bbbbbb:oldold.1000.1': '[]',
      'bz:aaaaaa:bbbbbb:newnew.2000.9': '[]',
      'bz:zzzzzz:bbbbbb:others.3000.1': '[]'
    },
    sessionStorage: { TabId: 'bbbbbb' }
  });

  listener({ type: 'FL_SCAN_START', settings: INSTANT }, {}, () => {});
  await settle();

  const done = sent.find((m) => m.type === 'FL_SCAN_DONE');
  assert.ok(done, 'scan did not finish');
  assert.strictEqual(done.data.profile.username, 'me.self');
  assert.strictEqual(done.data.profile.full_name, 'Me Self');
  for (const init of inits) {
    assert.strictEqual(init.headers['x-web-session-id'], 'aaaaaa:bbbbbb:newnew');
    assert.strictEqual(init.referrer, 'https://www.instagram.com/me.self/');
  }
});

test('a viewer record for another id is ignored', async () => {
  const { listener, sent, inits } = harness({
    followers: [{ users: [] }],
    following: [{ users: [] }]
  }, {
    html: '["PolarisViewer",[],{"data":{"id":"77","username":"someone.else"}},-1]'
  });

  listener({ type: 'FL_SCAN_START', settings: INSTANT }, {}, () => {});
  await settle();

  const done = sent.find((m) => m.type === 'FL_SCAN_DONE');
  assert.ok(done, 'scan did not finish');
  assert.strictEqual(done.data.profile.username, '');
  assert.strictEqual(inits[0].referrer, undefined);
});

test('without a logging key the session id keeps the page\'s first two groups', async () => {
  const { listener, sent, inits } = harness({
    followers: [{ users: [igUser(1)], next_max_id: '1' }, { users: [] }],
    following: [{ users: [] }]
  }, {
    localStorage: { Session: 'aaaaaa:1790000000000' },
    sessionStorage: { TabId: 'bbbbbb' }
  });

  listener({ type: 'FL_SCAN_START', settings: INSTANT }, {}, () => {});
  await settle();

  assert.ok(sent.find((m) => m.type === 'FL_SCAN_DONE'), 'scan did not finish');
  const id = inits[0].headers['x-web-session-id'];
  assert.match(id, /^aaaaaa:bbbbbb:[a-z0-9]{6}$/);
  assert.ok(inits.every((i) => i.headers['x-web-session-id'] === id));
  // No username on the page: no made-up Referer either.
  assert.strictEqual(inits[0].referrer, undefined);
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
