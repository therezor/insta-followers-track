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
  permissions: [
    'storage',
    'unlimitedStorage',
    'tabs',
    'scripting',
    // Sets Referer on profile-picture requests; see src/rules.json for why.
    'declarativeNetRequestWithHostAccess'
  ],
  host_permissions: [
    '*://*.instagram.com/*',
    // Instagram's image CDNs. Reached only to display profile pictures.
    '*://*.cdninstagram.com/*',
    '*://*.fbcdn.net/*'
  ],
  /*
   * One rule, in src/rules.json: set Referer to https://www.instagram.com/ on
   * profile-picture requests to Instagram's CDNs.
   *
   * Those CDNs answer with 'Cross-Origin-Resource-Policy: same-origin', which
   * stops any page but instagram.com from displaying the image. With that
   * referer they answer 'cross-origin' plus 'Access-Control-Allow-Origin: *'.
   * A page cannot set its own Referer, so it is set here.
   *
   * Nothing is added to the request - no cookies, no identifiers, no user
   * data. It is the same header instagram.com sends for the same picture.
   * The rule file takes no comments; the DNR rule schema rejects unknown
   * keys, and a rejected file disables the whole ruleset.
   */
  declarative_net_request: {
    rule_resources: [{ id: 'avatars', enabled: true, path: 'rules.json' }]
  },
  content_scripts: [
    {
      matches: ['*://*.instagram.com/*'],
      js: ['content.js'],
      run_at: 'document_idle',
      all_frames: false
    }
  ],
  action: {
    default_title: 'Follower Tracker - see who unfollowed you',
    default_popup: 'popup.html',
    // The toolbar draws at 16 and 32. Left to downscale a 48, the magnifier
    // in the full mark blurs into the head; icon-16 and icon-32 are redrawn
    // for those sizes.
    default_icon: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png'
    }
  },
  // 32/64/128 are the sizes addons.mozilla.org asks for; 48 and 96 are what
  // Firefox's own add-ons manager draws at 1x and 2x.
  icons: {
    16: 'icons/icon-16.png',
    32: 'icons/icon-32.png',
    48: 'icons/icon-48.png',
    64: 'icons/icon-64.png',
    96: 'icons/icon-96.png',
    128: 'icons/icon-128.png'
  }
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
