<h1 align="center">Follower Tracker</h1>

<p align="center">
  <b>See who unfollowed you on Instagram.</b><br>
  Free Instagram follower tracker for Chrome and Firefox.<br>
  No account. No limit. No telemetry.
</p>

<p align="center">
  <a href="TECHNICAL.md">Install</a> ·
  <a href="#what-it-shows">Features</a> ·
  <a href="#100-free">Pricing</a> ·
  <a href="#no-telemetry">Privacy</a> ·
  <a href="LICENSE">MIT</a>
</p>

---

## Who unfollowed me on Instagram?

That's the question this answers. Press **Scan now**, and you get a plain list
of every account that unfollowed you since your last check.

No sign-up. No password. No monthly fee. Nothing leaves your computer.

> **Early build.** The reports are tested. The part that reads your follower
> list has not been run against a live Instagram account yet.

## What it shows

| | |
| --- | --- |
| **Who unfollowed you** | Accounts that left since your last scan |
| **Who doesn't follow you back** | People you follow who don't follow you |
| **Who you don't follow back** | The reverse |
| **Mutuals** | People you both follow |
| **New followers** | Accounts that arrived since your last scan |
| **Recently followed / unfollowed** | Your own follow activity |
| **History** | Every scan, with the gain or loss |

Search, sort, and export any list to a spreadsheet (CSV).

**Settings** lets you control how fast a scan runs — the gap between requests
and how often it takes a longer break — so you can trade speed for staying
under Instagram's radar.

## 100% free

No trial. No paid tier. No follower cap. No account. No upsell.

Most Instagram unfollower apps stop at 500 followers and ask for a
subscription. This one doesn't stop.

| | Typical unfollowers app | Follower Tracker |
| --- | --- | --- |
| Price | Free trial, then monthly | **Free forever** |
| Follower limit | Capped until you pay | **None** |
| Sign-up | Google or email | **None** |
| Your password | — | **Never asked** |
| Tracking | Common | **None** |
| Your data | Their servers | **Your browser** |

## No telemetry

- No analytics. No crash reporting. No calls home.
- One network request, to instagram.com — the site you're already using.
- Your lists are stored in your own browser. There is no server.
- One button deletes everything.
- The Firefox build formally declares that it collects zero data.

Open source, so you can check all of that yourself. Commands are in
[TECHNICAL.md](TECHNICAL.md).

## Install

This repo holds the source. Your developer runs one command — no install step
first — and loads the result into Chrome or Firefox. Takes about a minute:
[TECHNICAL.md](TECHNICAL.md).

## Good to know

Instagram doesn't officially allow tools like this — true of every follower
tracker, paid ones included. Scans run slowly on purpose — about 25 minutes
for a 10,000-follower account — and you can make them slower or faster under
**Settings**. Scan occasionally, not constantly.

## How it works

It reads your own follower and following lists using the Instagram session
you're already logged into, saves them on your computer, and compares each
scan to the last one. That comparison is everything you see.

## Docs

- [TECHNICAL.md](TECHNICAL.md) — build, install, storage, privacy checks
- [ANALYSIS.md](ANALYSIS.md) — why this was written from scratch

MIT licensed.

---

<sub>Keywords: instagram follower tracker, who unfollowed me on instagram,
instagram unfollowers, unfollow tracker, ghost followers, non followers,
free instagram tracker, chrome extension, firefox add-on, no telemetry,
open source, privacy.</sub>
