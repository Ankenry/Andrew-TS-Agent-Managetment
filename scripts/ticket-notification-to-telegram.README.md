# Helpdesk notification to Telegram

The notifier polls Avada Helpdesk notifications for Andrew and sends
only notifications created after its current Telegram connection starts. It
baselines existing notifications whenever the watcher starts, so notifications
from before the computer was turned on or the bot was connected are never sent.

## Telegram setup

1. Create a bot through BotFather and copy its token.
2. Open a direct chat with the bot and send /start.
3. Obtain your numeric chat ID from a getUpdates response, then save:

~~~env
API_AVADA_TICKET=avd_...
TELEGRAM_BOT_TOKEN=123456:telegram-bot-token
TELEGRAM_CHAT_ID=123456789
TELEGRAM_MENTION=@your_telegram_username
~~~

The bot can only send to a private chat after you have started that chat.

## Chat with the bot

Start a direct chat with the bot, or post in the configured Ticket
Notifications channel, and send a question. While the notifier runs with
`--watch`, it replies within about five seconds. Helpdesk notifications are
synchronized every five minutes; the configured
`TELEGRAM_CHAT_ID` is automatically approved for bot chat; its replies are
threaded to the message being answered.

## Ticket review skills and automatic operation

The notifier forwards general notifications to Telegram and starts the separate
`skills/check-ticket/scripts/service.mjs` review service. Its configuration is
`skills/check-ticket/workflow.json`; `CHECK_TICKET_AUTOMATION_ENABLED=false`
disables it for a process. Restart the notifier after changing configuration.

New ticket-created notifications received by Andrew and new Andrew assignments
trigger: TS Elite 2 → classification → matching Customize/Bug/Feature request/
Question skill → one Helpdesk report comment. The initial Elite message is
exactly `Check ticket <ticket URL>`. The worker uses the current Codex CLI login
and model configuration, without requiring an OpenAI API key.

For new automatic reviews, the review service owns the Telegram sequence:

1. `Đã nhận ticket` with its subject and link (creation and assignment share one receipt).
2. `Hachimi đang checking ticket` before analysis starts.
3. `Hachimi đã check xong ticket` and the exact posted report, only after Helpdesk confirms the comment.

The generic notifier suppresses its creation/assignment messages while the
review service is active, so the ticket receipt is not duplicated. Reports are
sent as plain text and split into parts of at most 3800 UTF-16 units without
truncating CSS, links or handoff. Provider names remain excluded from reports.
Notice progress and returned Telegram message IDs are persisted per ticket in
the review state. Known delivery rejections retry with backoff; unconfirmed
sends stop for attention instead of blindly duplicating messages. Failed checks
receive a failure notice. Telegram completion retries never rerun AI or repost
the Helpdesk comment. Previously existing jobs without this notice state are
not replayed. Manual previews do not send lifecycle notices.

Each review makes exactly one `Check ticket <URL>` request to TS Elite 2 and
saves its answer before synthesis. There are no follow-up requests for deeper
analysis, clarification, evidence, formatting repair or CSS help.
All bug cases skip Hachimi's independent diagnosis and verification and use
that initial answer directly. There is no evidence-clarification checklist.
Explicit `[bug]` titles use this flow even if the initial classification is a
product question. Synthesis has a five-minute deadline; failure retains
the initial fallback report. Theme bug subtypes follow
this same flow; Customize keeps its own browser preview.

Assignment snapshots and notifications are reconciled every five minutes; the
serialized review queue is checked every ten seconds. Existing tickets are
baselined on first activation. Creation and assignment share one internal-ticket
ID, so they cannot produce two reports. State lives in
`runtime/check-ticket/state.json`; the removed notifier review queue is never
imported. A restart resumes this new queue. Ambiguous comment delivery is
reconciled with Helpdesk and never blindly reposted.

Each investigation phase is limited to five minutes with an abort signal and
process-group termination. Customize demo capture/upload has its own two-minute
limit. Failures retain the saved Elite-derived report/CSS. The worker opens a
new isolated Playwright window with extensions disabled (including Jam); it
does not modify the user's normal Chrome extension settings or shop settings.

Comments use `scripts/helpdesk-comment-author.mjs` to fetch Andrew's current
member ID, name and avatar. Missing author data prevents posting. The workflow
does not change ticket status, tick Done, or send merchant/Dev messages.

Every report (including preview and Elite fallback) ends with
`Chờ @Andrew review kết quả`, tagging only Andrew by his stable member ID in
the Helpdesk `mentions` payload. His display name is resolved from his current
profile and refreshed before posting, independent of ticket CS/AI membership.
Missing Andrew profile/name prevents delivery. The saved posting content includes this
line so restart/retry reconciliation still prevents duplicate comments.

Preview the complete workflow without posting or uploading:

```sh
node skills/check-ticket/scripts/run.mjs https://helpdesk.avada.net/tickets/CB-260917-eY4Ugy --preview
```

For a published Flameshot demo URL, configure `TICKET_DEMO_UPLOAD_URL` in
`.env_my` (HTTPS endpoint accepting multipart field `file` and returning JSON
`{"url":"https://..."}` or `{"data":{"url":"https://..."}}`). Optional
`TICKET_DEMO_UPLOAD_TOKEN` is sent as Bearer auth. Uploads are restricted to
inspected PNGs under the current job's screenshots directory, and the returned
link must pass an HTTP HEAD check. With no uploader or a failed capture/upload,
the report includes: `Chưa thể đưa ra Demo nhờ Andew tự custom lấy demo`.

For a maintenance restart, `--watch --resume-session` retains the existing
notification cutoff. Ordinary `--watch` establishes a new notification baseline.
Add `--announce-workflow` to send one Telegram activation notice after the
review service starts. This sends a real message; omit it for silent maintenance.

Local read-only health:

```sh
curl -s -H 'X-TS-Management-Widget-Bridge: 1' http://127.0.0.1:39541/health
```

The response reports live `automaticTicketReview`, `automaticTicketComments`,
and `ticketReviewWorkflow` status/counters. A stopped/disabled service reports
false. Queue failures requiring attention are visible in the workflow counters
and state file.
Health also includes `telegramNotificationsEnabled`, `telegramPending` and
`telegramNeedsAttention` for the review lifecycle messages.

Run offline regression checks with
`node --test scripts/ticket-notification-to-telegram.test.mjs`.
The notifier's `--test` flag sends a real Telegram message and is not the
regression test command.

To respond to every message in one additional approved group without a bot
mention, set `TELEGRAM_CONVERSATION_CHAT_ID=-100...` to that group ID. Disable
Group Privacy Mode through BotFather, then remove and re-add the bot to the
group. For a channel, make the bot an administrator with permission to post
messages.

For the exact same TS Elite AI, knowledge base, and ticket-checking logic as
the Chrome widget, add a TS Elite extension token. Open `https://ts2.avada.net/ext-login`
while signed in, obtain the token through the extension login flow, and keep it
only in the gitignored `.env_my` file. The token follows the normal TS Elite
session lifetime, so repeat this step when it expires.

~~~env
TELEGRAM_OWNER_NAME=An
TS_ELITE_EXT_TOKEN=<extension-token>
TS_ELITE_BASE_URL=https://ts2.avada.net
~~~

As a fallback, the bot can call OpenAI directly. It still reads the full ticket
record and up to 100 Helpdesk comments, but it does not include TS Elite's
private knowledge base or agent tools:

~~~env
TELEGRAM_OWNER_NAME=An
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.2
~~~

Every message is sent to the configured AI immediately, including a user's
first question. When a Helpdesk URL or display ID (for example
`CHATTY-260819-hzWYJV`) appears in the message—or the user replies to a ticket
notification—the bot reloads that ticket and up to 100 comments before
answering. Ask, for example: `Check ticket CHATTY-260819-hzWYJV giúp mình`.

## Send to a channel and mention yourself

1. Add the bot to the channel as an administrator and allow it to post
   messages.
2. Make one post in the channel, then call
   `https://api.telegram.org/bot<BOT_TOKEN>/getUpdates`. Copy the negative
   ID at `channel_post.chat.id` (normally starts with `-100`) into
   `TELEGRAM_CHAT_ID`.
3. Set a Telegram username for yourself, join the channel, and set
   `TELEGRAM_MENTION=@your_username`. The notifier places that mention at the
   start of every ticket notification.

## Run

~~~bash
# Send one Telegram test message.
node scripts/ticket-notification-to-telegram.mjs --test

# First normal run: write a baseline without sending old notifications.
node scripts/ticket-notification-to-telegram.mjs --once

# Run continuously; Helpdesk notifications are polled every five minutes.
node scripts/ticket-notification-to-telegram.mjs --watch
~~~

## TS Elite 2 review from local Codex

With the notifier running in `--watch` mode and the Andrew Chrome extension
logged into TS Elite 2, a local process can request a read-only ticket review:

~~~bash
node scripts/review-ticket-via-ts-elite.mjs https://helpdesk.avada.net/t/JOY-260910-Bc5Xju
~~~

The default message is exactly `Check ticket <ticket URL>`. A bare ticket ID
is also accepted and expanded to `https://helpdesk.avada.net/t/<ID>`.
Optional trailing arguments replace the default message verbatim.
The local request goes to `127.0.0.1`; Chrome uses its own TS Elite login to
forward the message without appending ticket data, comments, or instructions.
TS Elite is responsible for retrieving the ticket using its own tools.
The existing `summaryOnly` transport flag skips context enrichment; it does
not instruct TS Elite to summarize. The local caller receives only the answer.
The script never posts a ticket comment.

This low-level script is the Elite-only step. The complete routed workflow is
defined in `skills/check-ticket/SKILL.md`; use its `scripts/run.mjs` for a manual
preview with the matching branch's checks. The former blanket skip of
independent verification has been replaced by the branch-specific deadlines.

State is stored in runtime/telegram-ticket-notifier-state.json. Each new
`--watch` run deliberately creates a new connection cutoff; notifications made
while it was stopped are ignored.
