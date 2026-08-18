/*
 * Loads the content script the way a browser does - settings.js first, then
 * content.js - and checks that it registers a message listener and answers a
 * ping. Run: npm test
 *
 * This exists because of two real failures, both caused by the content script
 * depending on settings.js. First a load-time reference to FLSettings sat
 * above the listener registration, so a missing settings.js killed the script
 * before it could answer anything and the tab looked permanently unreachable.
 * Then, hardened, it answered pings but refused every scan. The dependency is
 * gone now - the dashboard sends normalised settings with the scan request -
 * and these tests hold that line. Syntax checks cannot; executing the file
 * can.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src');

/** Minimal stand-ins for the surface content.js touches while loading. */
function loadContentScript({ withSettings = false } = {}) {
  let listener = null;

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    URL,
    document: { cookie: '', documentElement: { innerHTML: '' } },
    location: { origin: 'https://www.instagram.com' },
    chrome: {
      runtime: {
        onMessage: { addListener: (fn) => { listener = fn; } },
        sendMessage: () => Promise.resolve()
      },
      storage: { local: { get: () => Promise.resolve({}) } }
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  const files = withSettings ? ['settings.js', 'content.js'] : ['content.js'];

  for (const file of files) {
    vm.runInContext(fs.readFileSync(path.join(SRC, file), 'utf8'), context, {
      filename: file
    });
  }

  return { listener, sandbox };
}

test('content.js registers its listener and answers a ping', () => {
  const { listener, sandbox } = loadContentScript();

  assert.ok(listener, 'no onMessage listener was registered');
  assert.strictEqual(sandbox.window.__followTrackerReady, true);

  let response = null;
  listener({ type: 'FL_PING' }, {}, (r) => { response = r; });
  // Objects cross a vm realm boundary, so compare fields rather than
  // identity - deepStrictEqual would fail on the prototype alone.
  assert.strictEqual(response?.ok, true);
  assert.strictEqual(response?.scanning, false);
});

test('content.js loads with no settings.js present at all', () => {
  // The shipped manifest injects content.js alone. A browser still running an
  // older manifest may inject settings.js too, so both must work.
  const bare = loadContentScript({ withSettings: false });
  assert.ok(bare.listener, 'content.js did not register a listener on its own');

  const withExtra = loadContentScript({ withSettings: true });
  assert.ok(withExtra.listener, 'content.js broke when settings.js was present');
});

test('content.js does not reference FLSettings', () => {
  // The dependency this file exists to prevent. The dashboard normalises
  // settings and sends them with the scan request instead.
  const source = fs.readFileSync(path.join(SRC, 'content.js'), 'utf8');
  assert.ok(
    !source.includes('FLSettings'),
    'content.js reads FLSettings again - a stale manifest would break scans'
  );
});

test('the manifest injects only content.js as a content script', () => {
  const build = fs.readFileSync(path.join(SRC, '..', 'build.mjs'), 'utf8');
  assert.ok(
    /js: \['content\.js'\]/.test(build),
    'content_scripts lists more than content.js'
  );
});

test('an unknown message type is ignored without throwing', () => {
  const { listener } = loadContentScript();
  assert.doesNotThrow(() => listener({ type: 'NOT_OURS' }, {}, () => {}));
  assert.doesNotThrow(() => listener(null, {}, () => {}));
});
