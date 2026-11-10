# TS Management — Chrome Extension

This is a Manifest V3 extension with no build step. It loads Andrew's
`pending`, `doing`, `dev_fixing` and `feature_request` tickets from Avada Helpdesk.

- **Pending** is an expandable list. Each ticket opens Helpdesk and has a
  confirmation-gated **Move to doing** button.
- **Doing** is an expandable list. Each ticket has a confirmation-gated
  **Wait customer** button, plus **Move all → wait** for the entire list.
- **Wait customer** is an expandable list. It keeps tickets where Andrew is
  one of the assignees (including shared tickets), and shows each ticket's ID,
  member count/names, title, and description. Each ticket can move to
  **Done** or use **Keep Andrew** to remove its other assignees. Its bulk
  actions can move all visible tickets to Done or remove all other assignees
  while retaining Andrew.
- **Wait customer auto-close** runs every five minutes while Chrome is
  running. A ticket is eligible only when Andrew is assigned, its latest move
  to `waiting_customer` was at least one day (24 hours) ago, and it has no later ticket
  comment. Tickets without `slackLink` are changed atomically to Andrew-only
  and `done`. Tickets with `slackLink` stay unchanged and, after two days, appear once in the
  **Date Follow** notification section with the two-day confirmation warning.
- **Dev fix** is an expandable list. Its ticket links open the ticket's
  attached Slack thread; tickets without a Slack link are labelled as such.
- **Feature** (12/10/2026) sits under Dev fix and lists `feature_request`
  tickets the same way, plus the progress assessed by `skills/feature-follow`
  (read through the TS Management web on 127.0.0.1:5088: status label, progress,
  48-hour reminder, "Quét" preview scan that posts nothing). Flow doc:
  `docs/flows/tickets-feature (…).md`.
  At every full hour, the extension scans each assigned Dev-fix ticket through
  the local bridge and classifies the latest thread state (in progress,
  blocked, awaiting merge, awaiting verification, awaiting customer
  confirmation, or fixed and verified).
  It creates a concise report in **Dev báo done** only when the Slack thread
  has a new message or reaction; unchanged threads are silent. Hover a report
  for its summarized rationale, most recent update time, and the person whose
  response is awaited. A verified dev-done report automatically ticks the
  Helpdesk Done checkbox and saves a customer-email draft in the ticket comment,
  without moving the ticket to Dev done. A thread waiting for customer
  confirmation has a **Move to wait customer** button. A thread not marked done
  still gets a visible **Cần nhắc dev follow up** warning after two days,
  counted from its most recent Slack activity. A thread explicitly waiting for
  customer confirmation is excluded from that warning. For that state, the scan
  saves one clearly labelled Vietnamese customer-email draft in the ticket comment
  for each new Slack update; TS reviews the draft and contacts the customer
  manually. Public image/file links are included; private Slack assets are named
  and marked for manual attachment. Slack credentials remain in local `.env_my`,
  never in Chrome storage.
- **Skill SLA** is a fourth tab inside **Notifications**. Every two hours (and
  once when the extension starts), the local bridge reads the private
  `#avada-ts-vibe-working` channel for new daily-SLA announcements posted by
  Avada Bot. It is silent when there is no new SLA announcement or when the
  announcement does not explicitly identify Andrew with a violation. For a
  new Andrew violation, Hachimi extracts concrete prevention rules, stores
  them locally in `runtime/sla-skill-rules.json`, and adds one expandable
  **Skill SLA** notification listing the rules applicable to that new SLA and
  their evidence.
  These rules are included as prevention context in later Hachimi ticket
  reviews; they do not make any Helpdesk or Slack write. Set
  `SLACK_SLA_CHANNEL`, `SLACK_SLA_CHANNEL_ID`, `SLACK_SLA_BOT_NAME`, or
  `SLACK_SLA_BOT_ID` in `.env_my` only when this workspace changes channel or
  bot identity.

Status changes and labelled customer-email drafts are the only write capabilities.
All other requests are `GET`.

AI-generated reports and drafts never close a ticket or change its lifecycle
status. Only an explicit TS button can move a Dev-fix ticket. The separate
one-day Wait customer auto-close rule is deterministic (not AI-driven) and is
limited to its documented non-Slack eligibility.

## Local services auto-start

When the background worker starts (Chrome launch, install/reload, or the
**Tự kết nối** switch turned on), it asks the native host to start the Telegram
notifier, the Codex ticket bridge, the Helpdesk webhook bridge, the Hachimi
Postgres database and the Hachimi tracing web (`http://andrewtstracing.localhost:5077`, i.e. `127.0.0.1:5077`, see
`scripts/hachimi-trace-web.README.md`). Each start is idempotent: a service
that is already running is left alone.

## Tracing links in the chat bot

Every tracing link in the widget opens `http://andrewtstracing.localhost:5077` (`TRACE_WEB_URL` in `widget.js`).
Chrome resolves `*.localhost` to this machine, so the name needs no hosts entry or sudo.

When the chat provider is **Hachimi** or **Hachimi + TS Elite 2**, the background worker also sends the
widget turn's trace id (`traceId`, an opaque UUID, no message content) to the local Codex bridge, so the
bridge can attach the knowledge-base documents, SLA skill rules, tool calls and cited sources of that turn
to the same timeline in the tracing web (tab **Nguồn dữ liệu**).

The chat `⋯` menu has a **Tracing** entry (below **History**) that opens the
local Hachimi tracing web (`http://andrewtstracing.localhost:5077`). Each saved conversation in
**History** also has one **Tracing** button: a conversation attached to a ticket
shows the ticket id and opens every trace of that ticket (`#ticket/<id>`,
automatic review plus all chats); a conversation without a ticket opens its own
chat traces (`#chat/<chatId>`). Widget traces carry only
the conversation id, never message content beyond the progress log.

## Automatic reviews in History

Automatic ticket reviews run in the local notifier, outside Chrome. The background worker copies them into
the chat bot's **History** (`syncAutomaticReviewHistory`, every 30 seconds and whenever History is opened)
from the local read-only route `GET http://127.0.0.1:39541/check-ticket/history`.

- Each review is one conversation `auto-<ticket id>` with the ticket attached: the `Check ticket <url>` request,
  the initial analysis and the report posted on Helpdesk. It is tagged **Auto check** with its state
  (`Đang check`, `Đã comment`, `Chưa xác nhận comment`, `Cần kiểm tra`) and is refreshed when the review changes.
- Its **Tracing** button opens the ticket's traces on the automatic session
  (`#ticket/<id>?open=automatic:<ticket id>`).
- Reviews of the last 10 days are listed, 30 at most, counted separately from the 30 manual conversations.
  Messages typed inside an automatic conversation are kept when the review is refreshed.
- The sync only writes `chrome.storage.local`. It never starts a review, calls AI or posts a comment.
  Merge rules live in `automatic-history.js`, shared with the TS Management web.

## Checking ticket page

The navigation has a **Checking** page between **Chat bot** and **Notifications**. It lists Hachimi's
check-ticket runs (automatic reviews and manual checks recorded in the tracing web), running ones first.

- Opening a run shows every recorded step (phase, tool, observation, the report, errors) and keeps adding new
  steps while the run is in progress. The background worker reads them from the local tracing web
  (`http://127.0.0.1:5077`, host permission added in 1.4.4); views are built in `checking-ticket.js`, shared
  with the TS Management web.
- The input below the steps is the normal chat bot with that run's ticket attached. An automatic run uses the
  same conversation `auto-<ticket id>` as **History**, so questions asked in either place stay together.
- Watching is read-only. Asking a question never re-runs the review and never posts a comment.
- The tracing web must be running (Settings → local services); otherwise the page shows why it cannot load.

## Analytics page

The navigation has an **Analytics** page between **Checking** and **Notifications** (version 1.4.5). It shows how
often the AI check was right, judged by the reaction the user leaves on each review comment the controller posted
(`Sau khi TS check thì thấy như sau:`): 👍 (or ❤️) = correct, 😢/😭 = incorrect, no reaction = not judged yet.

- Pie (donut) of correct vs incorrect, a column chart of the correct rate per day or week with 7-day / 30-day /
  custom ranges, a list of correct tickets, a list of incorrect tickets, and a **Train AI** feedback block.
- **Feedback** on a ticket row fills the ticket field; the description plus **Train AI** stores the feedback in
  the local database (`ai_check_feedback`), from where the check-ticket worker loads lessons for later reviews.
- The view is `analytics-view.js`, shared with the TS Management web; the background forwards the requests to the
  local tracing web (`/api/analytics/*`), which reads the reactions from Helpdesk (read-only, every 10 minutes, every
  minute for the last 3 days while the page is open, or with **Đồng bộ reaction**); the page repaints every 15 s. Nothing here reacts, posts comments or changes ticket state.

## Read aloud in the chat bot

Version 1.4.6. In the chat bot, `đọc <số>` shows Hanlead's numbered report and reads it aloud, `đọc` reads the latest
answer, `dừng` stops; every answer also has a **🔊 Đọc** button. These commands never call the AI.

- The background asks the TS Management web on this machine (`http://127.0.0.1:5088`, host permission added in 1.4.6)
  for the spoken text and the audio of each segment, synthesized with the offline Piper voice; the widget plays them
  with Web Audio (`speech-player.js`, shared with the web). The TS Management web service must be running.
- When the audio cannot be fetched the browser's own Vietnamese voice is used instead.

## NEWS (daily technology, AI model and Claude bulletin)

Version 1.4.9 (1.4.7 added the view; 1.4.8 added the daily sections "10 mẹo dùng AI" and "10 tính năng hay của Claude và Codex" under the news groups, collapsible, from `bulletin.tips`; 1.4.9 adds "10 tool/extension hay dùng với AI" with a verified download/home link per tool). The Tickets page header has a **NEWS** button left of the close button (no navigation entry). It opens
the day's bulletin in three groups — Claude, new AI models, technology — with the original title, source, time, a link
and a short Vietnamese summary. A red dot marks a bulletin this device has not opened yet.

- The TS Management web on this machine builds the bulletin at 08:00 or on the first request of the day, from the
  sources in `scripts/news-sources.json`; summaries come from the local Codex worker. The background fetches
  `/api/news/*` on `127.0.0.1:5088` and keeps the latest bulletin in `chrome.storage` for when the server is down.
- The view is `news-view.js`, shared with the web. Flow: `docs/flows/news (tin tức công nghệ, model AI và Claude hằng ngày).md`.

## Load it unpacked

1. In Chrome, open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this `chrome-extension` folder (not the project root).
5. Pin **TS Management** from Chrome's Extensions menu, then click
   its icon to show the ticket widget on the current tab.
6. In the widget, open **Settings** in the bottom navigation to paste the API
   key and choose the widget position.

## Widget

Click the extension icon to show or hide the ticket widget on the current
website tab. The bottom navigation switches between **Tickets**, **Chat bot**,
**Notifications**, and **Settings**. Notifications is the third section and
lists Andrew's Helpdesk updates; clicking an item opens its related ticket.
The **Tickets** screen and **Notifications** refresh immediately when the
local Helpdesk webhook bridge relays a verified ticket event. Its **Refresh**
button remains available for an immediate manual synchronization. The widget
keeps one 30-minute reconciliation fetch only to recover an event missed while
Chrome or the local bridge was disconnected.
Settings supports bottom-left and bottom-right placement. Its **Kết nối
Telegram** button starts the local ticket notifier without requiring a Terminal
command; it shows whether the notifier is running. A **Copy lệnh dự phòng**
button remains available if the local launcher is unavailable.
Reloading a web page removes the widget; click the extension icon again to put
it back.

When **Tự kết nối local** is enabled (the default), the extension also starts
the loopback webhook bridge. The bridge still needs a stable HTTPS tunnel to
receive Helpdesk deliveries; a temporary `loca.lt` URL must not be treated as
a permanent endpoint.

Settings also stores the selected **Light mode** or **Dark mode** theme.
It also includes a **Giữ màn hình luôn bật** toggle. When enabled, the
extension asks Chrome to keep the display awake while Chrome is running; when
disabled, the device returns to its normal screen-timeout setting.

The API key is stored with `chrome.storage.local` in the current Chrome
profile. It is not read from `.env_my`, not committed in the extension, and
not logged. Replace it from the widget's **Settings** tab.

The **Chat bot** provider is selected independently in Settings:

- **TS Elite 2** sends the question and any selected-ticket evidence directly
  to the signed-in TS Elite 2 session, then streams its answer in the widget.
- **Hachimi local (máy này)** sends the same evidence to the read-only local
  bridge at `127.0.0.1:39542`. Hachimi retrieves relevant Markdown from the
  project's `knowledge-base/knowledge/` and `knowledge-base/app-guides/` directories and cites
  those paths under `### Sources` when used. It does not call TS Elite 2.
- **Hachimi + TS Elite 2** first asks TS Elite 2, then sends that result and
  the ticket evidence to Hachimi for its final answer. This option requires
  both the TS Elite 2 login and the local Hachimi bridge.

The extension starts the local Hachimi bridge through Native Messaging whenever
it starts, without changing the saved AI provider. If that launcher is
unavailable, use **Copy lệnh Hachimi local**, paste it into a Terminal, and
press Enter. The local corpus is read-only and does not access ELITE2's
production database or API tokens. Set `ELITE2_KNOWLEDGE_ROOT` before starting
the bridge to use a different ELITE2 checkout.

The extension also asks the same Native Messaging host to bring up the Hachimi
PostgreSQL stack (`db/docker-compose.yml`: tracing + docs search) whenever it
starts. The request is idempotent; a healthy stack is left untouched, and a
missing Docker daemon only logs a warning.

In **Settings**, **Tự kết nối khi mở extension** controls automatic startup of
the Telegram notifier, Hachimi local bridge and Hachimi database. It is enabled by default.
Turning it off prevents future automatic starts but does not stop a process
that is already running; the manual connection controls remain available.

For every question the extension reloads the ticket and its Helpdesk
action/comment history immediately before the selected provider is asked. You can
also paste a Helpdesk ticket link or a display ID such as
`CHATTY-260819-hzWYJV` into a general chat question. Every ticket in the
**Doing** column also has a **Check** button. It opens Chat bot, starts a new
conversation, and immediately sends `Check ticket <ticket ID>` with that ticket
selected.

Chat bot keeps its bottom navigation visible. Its header includes **Clear
conversations** to start a fresh chat and **History** to reopen a locally saved
conversation. Conversations are saved only in `chrome.storage.local` in the
current Chrome profile. Doing-ticket controls are displayed in a horizontal row
below the title; hover a ticket to view its title, app, description, and members.

The Dev-fix follow workflow is the exception to the read-only review flow: it
reads Slack thread activity automatically and can post a Slack reminder when
TS chooses **Nhắc dev**. The hourly scan never changes Helpdesk status. When
dev explicitly reports a verified fix, it ticks the independent Helpdesk Done
checkbox (`dueDateDone: true`) and saves a `[DRAFT — dev báo done]` customer
email comment; it never moves the ticket to `dev_done`. TS may still use
**Move to wait customer** when the developer is waiting for customer
confirmation.
For a customer-confirmation state, the hourly scan writes a `[DRAFT — dev chờ
khách xác nhận]` comment once per latest Slack update. It never sends a customer
message; TS reviews the draft, adds any flagged private Slack attachment, then
contacts the customer manually.

The Tickets screen has a **Web local** button that opens the LAN web version
of this extension (`http://andrewtsmanagement.com:5088`, a local name mapped to `127.0.0.1` in `/etc/hosts`; see `scripts/ts-management-web.README.md`),
and a **Ticket Management** button beside Refresh. It opens
a separate, non-navigation screen with a TS1/TS2 filter, per-member assignment
counts, and the corresponding open `pending`/`doing` ticket list including
status, members, creation time, and level.

The popup and on-page widget use a fixed white and purple-gradient theme. The
color controls are intentionally not configurable.

## Development

After changing `manifest.json`, `popup.html`, `popup.css`, `popup.js`,
`background.js`, or `widget.js`, go
back to `chrome://extensions` and click Reload on the extension card. The
first Dev-fix follow run restarts the local bridge automatically so bridge
changes take effect too.
