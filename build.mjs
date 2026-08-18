#!/usr/bin/env node
/*
 * Emits dist/firefox/ and dist/chrome/ from the shared src/ tree.
 * The only per-browser difference is the manifest; all logic is identical.
 */

import { cp, mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, 'src');
const dist = join(root, 'dist');

const pkg = JSON.parse(
  await import('node:fs').then((fs) =>
    fs.promises.readFile(join(root, 'package.json'), 'utf8')
  )
);

const shared = {
  manifest_version: 3,
  name: 'Follower Tracker',
  version: pkg.version,
  description:
    'See who unfollowed you on Instagram. Free follower and unfollower ' +
    'tracker - no account, no limit, no telemetry.',
  permissions: ['storage', 'unlimitedStorage', 'tabs', 'scripting'],
  host_permissions: ['*://*.instagram.com/*'],
  content_scripts: [
    {
      matches: ['*://*.instagram.com/*'],
      js: ['content.js'],
      run_at: 'document_idle',
      all_frames: false
    }
  ],
  action: {
    default_title: 'Open Follower Tracker - see who unfollowed you',
    default_icon: { 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' }
  },
  icons: { 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' }
};

const targets = {
  // Firefox has no MV3 service worker; it uses an event page.
  firefox: {
    ...shared,
    browser_specific_settings: {
      gecko: {
        id: 'followlens@local.extension',
        strict_min_version: '142.0',
        data_collection_permissions: { required: ['none'] }
      }
    },
    background: { scripts: ['background.js'] }
  },
  // Chrome requires an MV3 service worker and rejects gecko settings.
  chrome: {
    ...shared,
    background: { service_worker: 'background.js' },
    minimum_chrome_version: '110'
  },
  /*
   * Safari runs the same MV3 bundle, but it cannot load an unpacked folder:
   * the output here is the input to `xcrun safari-web-extension-converter`,
   * which wraps it in an Xcode app project. Service workers need Safari 16.4,
   * hence the floor. No minimum_chrome_version, and no gecko block - Safari
   * rejects settings addressed to another browser.
   */
  safari: {
    ...shared,
    browser_specific_settings: {
      safari: { strict_min_version: '16.4' }
    },
    background: { service_worker: 'background.js' }
  }
};

await rm(dist, { recursive: true, force: true });

for (const [target, manifest] of Object.entries(targets)) {
  const out = join(dist, target);
  await mkdir(out, { recursive: true });

  for (const entry of await readdir(src)) {
    await cp(join(src, entry), join(out, entry), { recursive: true });
  }

  await writeFile(
    join(out, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n'
  );

  console.log('built dist/' + target);
}
