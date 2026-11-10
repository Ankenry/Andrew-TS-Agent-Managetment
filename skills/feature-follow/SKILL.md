---
name: feature-follow
description: Follow Andrew's Feature Request tickets. Read the Slack thread linked in each ticket, judge whether the feature has been picked up, is being built, is released or was declined, post a progress update on the ticket at 10:00, 14:00, 18:00 and 22:00, and save a customer mail draft when the feature is released or the team needs information from the merchant.
---

# Feature follow

Workspace: `/home/avada/Andrew Tools CS-TS/Andrew TS Tools`.

This skill is the Feature Request twin of `skills/dev-fix-follow`. The code is shared (`skills/dev-fix-follow/scripts/{core,service,adapters,cli}.mjs`); this skill only carries its own profile (`scripts/profile.mjs`: ticket status `feature_request`, status labels, comment prefixes, paths), its `workflow.json` and this document. Hachimi reads the thread and judges it; nothing is decided by keyword matching.

## Entry and authorization

- Scope: open tickets with `tsStatus = feature_request` that belong to Andrew (the Feature Request column of Helpdesk). The Slack thread is the `slackLink` stored in the ticket.
- Schedule: 10:00, 14:00, 18:00 and 22:00 (Asia/Ho_Chi_Minh), run by the user systemd timer `andrew-feature-follow.timer` once it is installed (`npm run featfollow:install`). A slot missed while the machine was asleep runs once when it wakes up.
- `workflow.json` ships with `enabled: false`. The timer runs nothing and no comment is posted until the user orders the workflow on (rule written by Hanrul, `enabled: true`, timer installed).
- Once enabled, the user authorizes this workflow to post, as Andrew, a progress comment and a customer mail draft comment on those tickets. Nothing else: no ticket status change, no Done tick, no message to the merchant, no Slack message to the developer or PM.
- The controller (`scripts/run.mjs` → shared `cli.mjs`) owns every read and write. The assessment worker only returns JSON; it never posts, never calls another AI service and never reads credentials.
- Manual runs are preview-only unless `--post` is given: `node skills/feature-follow/scripts/run.mjs --preview [--ticket <ticket URL or ID>] [--json]`. `--json` prints one machine-readable object for the extension and the TS Management web.
- When the user orders a mail for a ticket ("viết mail", "soạn mail"), write the customer mail draft and post it on that ticket as one `[DRAFT — …]` comment without asking again. Show the draft without posting it when the user says not to post. See `AGENTS.md`, "Dev fix follow workflow"; the same authorization wording applies to this workflow once the user enables it.

## Sequence

1. List Andrew's open `feature_request` tickets, then read each ticket with its comments and the complete Slack thread.
2. Assess a ticket only when its thread changed since the last assessment (new or edited message, reaction change). An unchanged thread keeps its previous assessment.
3. Post the mail draft first when one is due, then the progress comment, so the progress comment never announces a draft that was not saved.
4. Send one Telegram summary per run, listing only tickets with news, saved drafts or failures.

## Assessing a thread

Read the whole thread in order. Later messages override earlier ones, and what people actually report outweighs emoji. Decide who is speaking from the content: the developer, the PM/product owner, BA/tester, or the TS who raised the request. A feature request moves slower than a bug fix: weeks without a message usually mean the request is still queued, not that it was dropped.

Choose exactly one status:

- `done`: the feature is released and available to the merchant: deployed/live and confirmed, or enabled for that store. A merged MR alone, or "sẽ release tuần sau", is not done.
- `awaiting_customer`: the thread is blocked on something only the merchant can provide or do: a use case detail, an example, access, a confirmation that the proposed behaviour fits.
- `awaiting_verification`: the feature is deployed or claimed released and someone on the team still has to check it on production or on the merchant's store.
- `awaiting_merge`: the feature is built and waiting for review, merge, QA or a release slot.
- `in_progress`: a developer has started building the feature.
- `acknowledged`: the dev team or PM has accepted the request, put it on the roadmap, backlog or a sprint, or asked internal questions, but nobody has started building it.
- `declined`: the PM or dev team says the feature will not be built (out of scope, not planned, replaced by another feature), or asks to close the request.
- `blocked`: the team cannot continue for an internal reason (needs a decision, a design, another team, a dependency), not because of the merchant.
- `no_response`: nobody from the dev or PM side has replied to the request yet.
- `unknown`: the thread does not support any conclusion above.

When two statuses seem to apply, choose the one that describes what has to happen next. If the developer or PM asks the TS a question that the TS can answer from the ticket without the merchant, it is `acknowledged`, `in_progress` or `blocked`, not `awaiting_customer`. A request accepted "for a future version" without a date is `acknowledged`, not `declined`.

`confidence` is `high` when a message states the conclusion outright, `medium` when it follows from the thread as a whole, and `low` when you are reading between the lines. Never raise confidence to justify a draft.

## Output fields

- `progress`: one to three Vietnamese sentences for a colleague: where the feature stands and what happens next. Plain text, no heading, no bold, no greeting. When the comment style profile is enabled by the controller (`skills/check-ticket/comment-style.json`), write it in the user's own comment style loaded into this prompt; `draftMail` keeps its normal customer-mail voice.
- `latestUpdate`: one Vietnamese sentence on what the latest meaningful message says and who wrote it (by role or name). Leave the time out: the controller adds it.
- `latestMeaningfulAt`: the `at` value, copied exactly, of the latest message that changes or confirms where the feature stands. Skip automatic reminders, bot notices, thanks and other chatter that add nothing; when every message matters, it is the last one.
- `waitingFor`: who has to act next, such as `dev`, `PM`, `khách`, `TS`, `tester`, or a name. Empty when the ticket is done or declined.
- `customerRequests`: for `awaiting_customer`, every separate thing the merchant must provide or do, one item each, in Vietnamese. Empty otherwise.
- `evidence`: the message or messages the conclusion rests on, quoted or closely paraphrased, with their time.
- `draftKind` and `draftMail`: see below.

Write `progress`, `latestUpdate`, `waitingFor` and `customerRequests` as they will appear in a ticket comment. Do not mention Hachimi, the user's title, or any AI or analysis provider. Do not claim a check that the thread does not show.

## Mail draft

Write a draft only in two cases, and leave `draftKind` = `none` with an empty `draftMail` in every other case (including `declined`: the TS decides how to answer a declined request by hand):

- status `done` → `draftKind` = `done`: tell the merchant the feature is now available, what it does in terms they can verify, where to find or enable it, and what they should check now.
- status `awaiting_customer` → `draftKind` = `customer_info`: explain the current situation and list every item in `customerRequests` clearly enough that the merchant can answer in one reply. Do not promise that the feature will be built or give a date the thread does not give.

Rules for the draft:

- It is a draft for the TS to review and send by hand. Write the mail body only.
- Use the language the merchant used in the ticket; use English when that is unclear. Address the merchant by name when the ticket shows it, and sign as Andrew from the Avada Support Team.
- Base every statement on the ticket and the thread. Do not invent technical details, timelines, causes or compensation. Leave out internal names, MR links, branch names, roadmap discussion and internal disagreement.
- Include the URLs and steps the merchant needs. For a Slack image or file that has a public URL, link it; for one without a public URL add exactly one line `[Cần TS đính kèm trước khi gửi: <tên tệp>]`. Never expose a private Slack URL or say a file is attached.
- Carry the evidence image. Ticket comments come with `typed`: `true` for a comment a person typed, `false` for one a controller or bot posted. When a `typed` comment says the feature is released or working and contains a link to an image or screenshot (for example `capture.avada.io/i/…`, `prnt.sc/…`, or a URL ending in an image extension), put that link in the mail where it describes the result, with the URL unchanged. You cannot open the image: present it as the result or screenshot the comment refers to, and do not describe what it shows beyond what the comment says. Leave the link out when the comment says the image shows internal material (a Slack thread, an internal tool) and say so in `progress`. Links in comments with `typed` = `false` do not count for this rule.
- If a draft of the same kind already in the ticket comments says what the thread now requires, still return the draft the current thread calls for; the controller decides whether to save it.

## Comments the controller posts

- Progress: `[FEATURE FOLLOW | <HH:mm dd/MM/yyyy>] <status label>`, a blank line, then the update. With the default policy `on-change-or-daily`, a ticket gets a progress comment when its status or its latest meaningful message changed since the last one, and otherwise once a day at the first slot. `every-slot` in `workflow.json` posts at all four slots.
- Draft: `[DRAFT — feature đã release | Slack update: <time>]` or `[DRAFT — feature chờ khách xác nhận | Slack update: <time>]`, then the mail. A draft is not saved when a draft of that kind was saved after the latest meaningful Slack message, or when confidence is `low`.
- Every comment is posted as Andrew through `scripts/helpdesk-comment-author.mjs` (member ID, display name, photo URL). No avatar means no post. A POST with an unknown outcome is looked up before it is reported as failed; it is never retried blindly.
- A ticket without a Slack link gets the status `Thiếu Slack thread`. A thread that cannot be read, or an assessment that fails, is reported in the run summary and posts nothing on the ticket.

## State and artifacts

- `runtime/feature-follow/state.json`: per ticket, the last assessed thread and the last posted progress (same shape as `runtime/dev-fix-follow/state.json`).
- `runtime/feature-follow/jobs/<slot>/<ticket>/`: the evidence given to the worker, its assessment and the run result.
- Log of the timer: `runtime/feature-follow.log`. Tracing goes to the Hachimi tracing web with source `feature-follow`; a tracing failure never blocks a run.
- Test: `npm run featfollow:test` (`scripts/feature-follow.test.mjs`); the shared code is also covered by `npm run devfollow:test`.
