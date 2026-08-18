# FollowLens — a free Instagram follower tracker that runs on your own computer

**See who unfollowed you on Instagram, who never followed you back, and who
your real mutuals are.** FollowLens is a browser extension for **Chrome** and
**Firefox**. It is **100% free**, **open source**, and it contains **no
telemetry** — nothing about you or your account is ever sent anywhere.

> **Status: early build.** The maths behind the reports is tested and working.
> The part that reads your follower list from Instagram has not yet been run
> against a live account, so treat this as a preview rather than a finished
> product.

## What you get

- **Who unfollowed me** — a plain list of accounts that left since your last check.
- **Who doesn't follow me back** — everyone you follow who doesn't follow you.
- **Who I don't follow back** — the reverse.
- **Mutuals** — the people you both follow.
- **New followers** and **people you recently followed** or unfollowed.
- **History** — every check you've run, with the gain or loss for each.

Every list is searchable, sortable, and exports to a spreadsheet (CSV).

## Why this exists

Most Instagram follower trackers and "unfollowers" apps look free, then stop
working at 500 followers and ask for a subscription. Many also require you to
sign in with Google, which links your Instagram activity to your real identity,
and then quietly report what you click to an analytics company.

FollowLens has none of that.

| | Typical follower tracker | FollowLens |
| --- | --- | --- |
| Price | Free trial, then a monthly fee | **Free, forever** |
| Follower limit | Usually capped until you pay | **No limit** |
| Sign-up | Google or email account required | **None** |
| Your password | — | **Never asked for** |
| Analytics / tracking | Common | **None** |
| Where your data lives | The vendor's servers | **Your own browser** |

## 100% free — what that actually means

There is no paid tier, no trial, no follower cap, no upsell, and no account to
create. The code is published under the MIT licence, which means anyone can
read it, use it, and check that these claims are true. Nobody is billed and
there is nothing to cancel.

## No telemetry — what that actually means

The extension makes exactly **one** kind of network request, and it goes to
instagram.com — the same place your browser is already talking to when you use
Instagram normally. There are no analytics services, no crash reporters, no
external fonts or images, and no hidden calls home.

Your follower lists are stored **only in your own browser**, on your own
machine. There is no server in this product. A **Delete all stored data**
button wipes everything instantly. The Firefox version formally declares that
it collects no data at all.

Because it's open source, you don't have to take our word for any of this —
the exact commands to verify it yourself are in
[TECHNICAL.md](TECHNICAL.md).

## Two things to know before you use it

1. **It needs a build step first.** This repository holds the source code, not
   a ready-to-click download. Anyone technical can produce an installable
   version in about a minute — it is a single command, with nothing to
   install first. The instructions are in [TECHNICAL.md](TECHNICAL.md).
2. **Instagram doesn't officially allow tools like this.** Automatically
   reading your own follower list is against Instagram's terms of service —
   that's true of every product in this category, paid ones included. The
   extension deliberately works slowly to stay unobtrusive (a large account
   takes 10–15 minutes to check), but the sensible advice is to check
   occasionally, not constantly.

## How it works, in one paragraph

When you press **Scan now**, the extension reads your own follower and
following lists from Instagram using the session you're already logged into —
it never asks for your password. It saves those lists on your computer, then
compares each new check against the previous one. Everything you see in the
dashboard is that comparison. No account, no server, no subscription.

## For your technical team

- [TECHNICAL.md](TECHNICAL.md) — how to build and install it, what's tested,
  what isn't, how data is stored, and how to verify the privacy claims.
- [ANALYSIS.md](ANALYSIS.md) — a teardown of a commercial competitor,
  explaining why this was written from scratch rather than patched.

Licence: [MIT](LICENSE).
