/* Unit tests for the pure derivation logic. Run: npm test */

const test = require('node:test');
const assert = require('node:assert');
const FLDiff = require('../src/diff.js');

const u = (pk, username, full_name = '') => ({
  pk: String(pk),
  username,
  full_name,
  is_private: false,
  is_verified: false,
  profile_pic_url: 'https://cdn.example/' + pk + '.jpg'
});

const names = (list) => list.map((x) => x.username).sort();
const ids = (list) => [...list].sort();

// alice + bob follow me; I follow bob + carol.
const latest = {
  ts: 2000,
  followers: [u(1, 'alice'), u(2, 'bob')],
  following: [u(2, 'bob'), u(3, 'carol')]
};

const directory = {
  1: { username: 'alice', full_name: 'Alice A' },
  2: { username: 'bob', full_name: 'Bob B' },
  3: { username: 'carol', full_name: 'Carol C' },
  4: { username: 'dave', full_name: 'Dave D', is_verified: true, is_private: true }
};

test('mutuals are the intersection', () => {
  assert.deepStrictEqual(names(FLDiff.listFor('mutuals', { latest })), ['bob']);
});

test('doesn\'t follow you back = following minus followers', () => {
  assert.deepStrictEqual(
    names(FLDiff.listFor('not_following_back', { latest })),
    ['carol']
  );
});

test('you don\'t follow back = followers minus following', () => {
  assert.deepStrictEqual(
    names(FLDiff.listFor('not_followed_back', { latest })),
    ['alice']
  );
});

test('change tabs are empty with fewer than two snapshots', () => {
  const store = { latest, snapshots: [{ ts: 1, followerIds: ['1'], followingIds: [] }] };
  for (const tab of ['new_followers', 'lost_followers', 'new_following', 'you_unfollowed']) {
    assert.deepStrictEqual(FLDiff.listFor(tab, store), [], tab);
  }
  assert.strictEqual(FLDiff.snapshotDelta(store.snapshots), null);
});

test('delta detects gained, lost, followed and unfollowed', () => {
  const snapshots = [
    { ts: 1000, followerIds: ['1', '4'], followingIds: ['2', '4'] },
    { ts: 2000, followerIds: ['1', '2'], followingIds: ['2', '3'] }
  ];

  const d = FLDiff.snapshotDelta(snapshots);
  assert.deepStrictEqual(ids(d.newFollowers), ['2']);   // bob started following
  assert.deepStrictEqual(ids(d.lostFollowers), ['4']);  // dave left
  assert.deepStrictEqual(ids(d.newFollowing), ['3']);   // I followed carol
  assert.deepStrictEqual(ids(d.youUnfollowed), ['4']);  // I dropped dave
  assert.strictEqual(d.since, 1000);
  assert.strictEqual(d.until, 2000);
});

test('lost followers resolve to names from the directory, not bare ids', () => {
  const snapshots = [
    { ts: 1000, followerIds: ['1', '4'], followingIds: [] },
    { ts: 2000, followerIds: ['1'], followingIds: [] }
  ];
  const lost = FLDiff.listFor('lost_followers', { latest, snapshots, directory });

  assert.strictEqual(lost.length, 1);
  assert.strictEqual(lost[0].username, 'dave');
  assert.strictEqual(lost[0].full_name, 'Dave D');
});

test('directory flags survive onto delta lists so pills still render', () => {
  const snapshots = [
    { ts: 1000, followerIds: ['1', '4'], followingIds: [] },
    { ts: 2000, followerIds: ['1'], followingIds: [] }
  ];
  const [dave] = FLDiff.listFor('lost_followers', { latest, snapshots, directory });

  assert.strictEqual(dave.is_verified, true);
  assert.strictEqual(dave.is_private, true);
});

test('unknown ids degrade gracefully instead of throwing', () => {
  const snapshots = [
    { ts: 1000, followerIds: ['999'], followingIds: [] },
    { ts: 2000, followerIds: [], followingIds: [] }
  ];
  const lost = FLDiff.listFor('lost_followers', { latest, snapshots, directory: {} });

  assert.strictEqual(lost.length, 1);
  assert.strictEqual(lost[0].pk, '999');
  assert.strictEqual(lost[0].username, '');
});

test('empty store yields empty lists everywhere', () => {
  const store = { latest: null, snapshots: [], directory: {} };
  for (const tab of ['mutuals', 'not_following_back', 'not_followed_back', 'new_followers']) {
    assert.deepStrictEqual(FLDiff.listFor(tab, store), [], tab);
  }
});

test('scale: 50k followers diff correctly and stay ordered', () => {
  const followers = [];
  for (let i = 0; i < 50000; i += 1) followers.push(u(i, 'user' + i));

  const big = { ts: 2, followers, following: followers.slice(0, 25000) };
  const fans = FLDiff.listFor('not_followed_back', { latest: big });

  assert.strictEqual(fans.length, 25000);
  assert.strictEqual(fans[0].username, 'user25000'); // scan order preserved
});


test('resolved users keep their picture so change lists render avatars', () => {
  // Every "since last scan" list goes through resolve(); dropping a field
  // here silently degrades those lists only, which is easy to miss.
  const directory = {
    '7': {
      username: 'gone',
      full_name: 'Gone',
      is_private: false,
      is_verified: false,
      profile_pic_url: 'https://cdn.example/7.jpg'
    }
  };

  assert.strictEqual(
    FLDiff.resolve(directory, '7').profile_pic_url,
    'https://cdn.example/7.jpg'
  );
  // An id the directory has never seen must not throw or invent a URL.
  assert.strictEqual(FLDiff.resolve(directory, '404').profile_pic_url, '');
  assert.strictEqual(FLDiff.resolve(undefined, '7').profile_pic_url, '');
});
