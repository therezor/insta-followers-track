# Privacy Policy — Follower Tracker

**Last updated: 18 August 2026** · Applies to Follower Tracker 1.0.0 for
Chrome, Firefox and Safari.

Follower Tracker does not collect, transmit, sell or share any personal
information. There is no server behind this extension, no account system, and
no analytics of any kind.

## What the extension stores

All of the following is stored using your browser's own extension storage, on
your own device. None of it is transmitted anywhere.

| Stored | Why |
| --- | --- |
| Your Instagram user id and username | To label which account a scan belongs to |
| Your follower and following lists | To show them, and to compare against the next scan |
| Up to 60 past scans (account ids only) | The history view and change detection |
| Usernames, display names and profile picture URLs of those accounts | So lists remain readable after someone leaves |
| Your scan speed preferences | To pace the next scan |

You can erase all of it at any time with **Delete all stored data** in the
dashboard footer, or remove a single Instagram account's data with **Delete
this account**. Uninstalling the extension also removes it.

## What the extension sends, and where

The extension contacts Instagram, and nothing else:

- **instagram.com** — to read your own follower and following lists, using the
  session you are already signed in with. It never asks for, receives or
  stores your password.
- **Instagram's image servers** (`cdninstagram.com`, `fbcdn.net`) — only to
  display profile pictures in the dashboard.

No data about you is sent to the developer or to any third party. There is
nowhere for it to be sent: the extension has no backend.

## What the extension does not do

- No analytics, telemetry, usage statistics or crash reporting.
- No advertising, and no advertising identifiers.
- No sign-in, no account creation, no email address collected.
- No data sold, rented or shared with anyone.
- No tracking across websites.

## Permissions, and why each is needed

| Permission | Purpose |
| --- | --- |
| `storage`, `unlimitedStorage` | Keep your scans on your device; large accounts exceed the default quota |
| `tabs` | Find your open instagram.com tab and open the dashboard |
| `scripting` | Attach the reader script to an Instagram tab that was already open before installation |
| `declarativeNetRequestWithHostAccess` | Set the `Referer` header on profile-picture requests, which Instagram's image servers require before they will serve an image to any page other than their own |
| Access to `instagram.com` | Read your own follower and following lists |
| Access to `cdninstagram.com`, `fbcdn.net` | Display profile pictures |

## Children

The extension is not directed at children and collects no information from
anyone.

## Changes

Any change to this policy will be published in the extension's repository with
a new date at the top.

## Contact

Questions or concerns: open an issue at
https://github.com/therezor/insta-followers-track/issues

## Source code

The full source is public at
https://github.com/therezor/insta-followers-track — every claim above can be
verified by reading it.

This policy is also published as a page at
https://therezor.github.io/insta-followers-track/privacy.html
