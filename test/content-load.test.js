/*
 * Loads the content script the way a browser does - settings.js first, then
 * content.js - and checks that it registers a message listener and answers a
 * ping. Run: npm test
 *
 * This exists because of a real failure: a load-time reference to FLSettings
 * sat above the listener registration, so if settings.js was ever missing the
 * script died before it could answer anything. The tab then looked
 * permanently unreachable, with no error the user could see. Syntax checks
 * cannot catch that; executing the file can.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src');

/** Minimal stand-ins for the surface content.js touches while loading. */
function loadContentScript({ withSettings = true } = {}) {
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

test('the listener survives settings.js being absent', () => {
  // Not a supported configuration, but it must degrade to "answers the ping
  // and fails later with a clear message" rather than "tab is unreachable".
  const { listener } = loadContentScript({ withSettings: false });

  assert.ok(listener, 'a missing settings.js took the listener down with it');

  let response = null;
  listener({ type: 'FL_PING' }, {}, (r) => { response = r; });
  assert.strictEqual(response?.ok, true);
});

test('an unknown message type is ignored without throwing', () => {
  const { listener } = loadContentScript();
  assert.doesNotThrow(() => listener({ type: 'NOT_OURS' }, {}, () => {}));
  assert.doesNotThrow(() => listener(null, {}, () => {}));
});
