# Telegram local widget AI bridge

## Purpose

The Telegram notifier uses the same selected AI provider as the Andrew Chrome
widget without changing or deploying ELITE2. Telegram sends a ticket question
to a local bridge; the Chrome extension then uses TS Elite 2, Hachimi local,
or the combined Hachimi + TS Elite 2 flow. The notifier replies to the original
Telegram message while mentioning the
configured owner.

## Files changed

### Andrew TS Tools

- `scripts/ticket-notification-to-telegram.mjs`
  - Starts a loopback-only bridge at `http://127.0.0.1:39541` while running
    with `--watch`.
  - Queues Telegram ticket questions and waits for the extension's completed
    AI response.
  - Replies in a group or channel with `TELEGRAM_MENTION` before the answer.
  - Does not receive, save, or log the widget's AI token.

- `chrome-extension/background.js`
  - Polls only the local bridge and runs the existing widget AI request with
    the token already held in Chrome storage.
  - Sends only the final AI answer back to the local notifier.

- `chrome-extension/manifest.json`
  - Permits the extension to access the loopback bridge and use a Chrome alarm
    to wake the local polling loop.

### TS Elite/elite2

No source files are changed. The bridge calls AI through the already-running
Andrew extension, so ELITE2 does not need a local code change, Git commit, or
deployment.

## Required local configuration

Keep this in `Andrew TS Tools/.env_my` (the default is already `true`):

~~~env
TELEGRAM_MENTION=@your_username
TELEGRAM_USE_WIDGET_AI=true
~~~

The extension must be loaded in Chrome. In Widget Settings, select the provider
to use for Telegram too. For TS Elite 2, its token stays in Chrome storage; it
does not need to be copied to `.env_my` for the local bridge. `TS_ELITE_EXT_TOKEN` may be removed from
`.env_my` unless you intentionally set `TELEGRAM_USE_WIDGET_AI=false` to use
the older direct integration.

## Deployment and Git safety

All bridge code is inside Andrew TS Tools, which is not a Git repository in
this workspace. ELITE2 remains untouched, so future ELITE2 bug fixes cannot
accidentally include this local bridge. `.env_my` remains local-only.
