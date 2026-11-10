---
name: check-ticket-bug
description: Review reported Avada bugs from one TS Elite 2 answer, using MCP Playwright only for storefront/theme/frontend/layout failures, customer-facing error codes or missing storefront blocks; internal-only app bugs need no browser.
---

# Bug ticket

Use the [shared workflow](../SKILL.md). This applies to Bug tickets and explicit `[bug]` titles, including those initially classified as a product question or limitation.

## One request, then route by impact — maximum 5 minutes

1. The controller sends exactly `Check ticket <ticket URL>` once and saves the answer and fallback. Never request deeper analysis, clarification, missing evidence, formatting repair or CSS help from Elite again.
2. Route from the initial answer and ticket subject/description/CS comments:
   - Use **MCP Playwright** for reported storefront/theme/frontend/layout failures, a customer-facing page returning an error code, or an expected storefront block not showing. `ui_theme` and `logic_theme` require this branch; `browserCheck=storefront|error_code|block_missing` also selects it unless the issue is internal-only.
   - **No MCP Playwright** for internal app settings/admin/sync/data/business-logic issues with no storefront/theme/layout impact. Set `bugType=logic_internal` and `browserCheck=none`, even if the report mentions an error code or a block inside the app.
   - Mixed tickets check only the affected storefront portion. Do not classify a mixed case as internal-only. Unknown scope without a qualifying symptom uses synthesis only; a generic word such as error, frontend or block does not establish storefront impact.
3. Summarize only the initial answer using the shared report format, at least 30% shorter. Preserve material causes, conditions, steps and qualifications; keep required code/flags exact. Remove repetition, formal headings and Sources/citation audits. Ticket metadata informs routing, not invented report commentary.

## Qualifying browser check

- The worker uses the configured MCP Playwright tools in an isolated headless Chrome browser (`--headless --isolated`), with no visible window. Do not launch a headed browser or interact with the desktop. Never attach to the normal Chrome profile, log into an app, or disable the Andrew TS extension.
- Inspect only the reported storefront issue: relevant live DOM/visibility, desktop/mobile states when needed, and console/network errors where relevant. Do not save app/theme changes, inject fixes, submit orders or perform unrelated API/code/log investigations.
- Use supplied ticket URLs/domains. If the target is missing, access is blocked, MCP is unavailable or the phase expires, return the saved fallback with `verified=false`; do not invent a live check.
- A completed relevant browser check may return `verified=true` even if the symptom was not reproduced. Put the exact inspected URL, actual observations and reproduction limits in `verificationNotes`. This verifies the observation, not the proposed root cause. The report preserves the meaning and certainty of the source explanation; the controller appends the brief browser notes separately.
- Close the MCP browser before returning. No demo/upload for Bug checks; keep `css` and `screenshotPath` empty and `screenshotVerified=false`.

## Internal-only or unknown-scope bug

Summarize only the initial answer using the shared concise report format. No browser, screenshot/link/API/code/log checks, reproduction or additional verification checklist. Do not execute suggested handling steps. Keep `verified=false`, `screenshotVerified=false` and `verificationNotes`, `screenshotPath`, `css` empty.

## Failure and report

The controller enforces a five-minute branch deadline including subprocess termination. Failed/incomplete browser verification or failed synthesis uses the saved concise fallback, without another Elite request. Initial Elite failure remains a failure; do not invent findings.

Never name TS Elite 2, TS Elite or Elite in the report/draft/fallback. Retain the original uncertainty without strengthening or weakening the explanation. New verified browser observations stay separate from proposed causes. No formal headings; use the shared opening/category lines and no closing handoff. Apply the shared author, opening/category format and preview-only rules.
