/*
 * Follower Tracker - pure derivation logic
 *
 * Deliberately free of DOM and extension APIs so it can be unit tested
 * directly under node. Everything the dashboard shows is a set difference
 * over these two inputs: the latest scan, and the snapshot history.
 */

(function (root) {
  'use strict';

  /** Split the latest scan into lists plus id sets for O(1) membership. */
  function currentLists(latest) {
    const followers = latest?.followers ?? [];
    const following = latest?.following ?? [];
    return {
      followers,
      following,
      followerIds: new Set(followers.map((u) => u.pk)),
      followingIds: new Set(following.map((u) => u.pk))
    };
  }

  /** Fill in whatever we know about an id from previous scans. */
  function resolve(directory, pk) {
    const known = directory?.[pk];
    return {
      pk,
      username: known?.username || '',
      full_name: known?.full_name || '',
      is_private: !!known?.is_private,
      is_verified: !!known?.is_verified
    };
  }

  /** Change between the two most recent snapshots, or null if only one. */
  function snapshotDelta(snapshots) {
    if (!Array.isArray(snapshots) || snapshots.length < 2) return null;

    const prev = snapshots[snapshots.length - 2];
    const cur = snapshots[snapshots.length - 1];

    const prevFollowers = new Set(prev.followerIds);
    const curFollowers = new Set(cur.followerIds);
    const prevFollowing = new Set(prev.followingIds);
    const curFollowing = new Set(cur.followingIds);

    const diff = (a, b) => [...a].filter((id) => !b.has(id));

    return {
      since: prev.ts,
      until: cur.ts,
      newFollowers: diff(curFollowers, prevFollowers),
      lostFollowers: diff(prevFollowers, curFollowers),
      newFollowing: diff(curFollowing, prevFollowing),
      youUnfollowed: diff(prevFollowing, curFollowing)
    };
  }

  /**
   * Resolve one tab id to the accounts it should show.
   * store = { latest, snapshots, directory }
   */
  function listFor(tabId, store) {
    const { followers, following, followerIds, followingIds } = currentLists(
      store.latest
    );
    const delta = snapshotDelta(store.snapshots);
    const via = (ids) => ids.map((pk) => resolve(store.directory, pk));

    switch (tabId) {
      case 'not_following_back':
        return following.filter((u) => !followerIds.has(u.pk));
      case 'not_followed_back':
        return followers.filter((u) => !followingIds.has(u.pk));
      case 'mutuals':
        return followers.filter((u) => followingIds.has(u.pk));
      case 'new_followers':
        return delta ? via(delta.newFollowers) : [];
      case 'lost_followers':
        return delta ? via(delta.lostFollowers) : [];
      case 'new_following':
        return delta ? via(delta.newFollowing) : [];
      case 'you_unfollowed':
        return delta ? via(delta.youUnfollowed) : [];
      default:
        return [];
    }
  }

  const FLDiff = { currentLists, resolve, snapshotDelta, listFor };

  if (typeof module !== 'undefined' && module.exports) module.exports = FLDiff;
  else root.FLDiff = FLDiff;
})(typeof globalThis !== 'undefined' ? globalThis : this);
