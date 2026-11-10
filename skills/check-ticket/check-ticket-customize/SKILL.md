---
name: check-ticket-customize
description: Assess and test a Customize ticket after TS Elite 2 review, including temporary storefront CSS and a time-limited headless Playwright demo link.
---

# Customize ticket

Use the [shared workflow](../SKILL.md) first. Base feasibility on Elite findings and the actual requested behavior; CSS cannot implement missing business logic or change what an action does.

## Feasible customization — maximum 5 minutes

- Use the supplied isolated headless Playwright browser. The controller launches it with extensions disabled, so Jam is inactive there. Do not open a visible Chrome window or interact with the desktop. Do not disable the Andrew TS extension or edit the user's normal browser profile.
- Use the supplied browser endpoint and Playwright module. Inspect live DOM, existing CSS and current button actions before selecting rules. Inject candidate CSS only into this disposable page; never save app/theme settings.
- Use the initial Elite answer only; never ask a CSS follow-up or any second Elite question.
- Check the requested behavior at desktop and mobile sizes and relevant states. Record the exact CSS, URL and observations. When the deadline expires or access fails, discard unverified edits as the recommendation and use the saved Elite CSS/report, labelled as unverified.

## CSS writing rules (user order of 2026-10-14)

- Build every selector from a stable parent class of the app or theme down to the target class (`.AirReviews-Widget .AirReviews-Blocks__List`, `#shopify-section-header .header__icon`) or a stable data-attribute (`[data-block-type="reviews"] .stars`). That parent is what wins the specificity contest with the theme.
- Limit `!important`. Write the first version without it and try it on the headless storefront (the v2 `css_preview` tool prints the specificity of each selector and, per declared property, `✓` applied or `✗ bị ghi đè`). Add `!important` only to a property that is still overridden although the selector already carries a parent class, and write the reason next to the code (which parent class lost to which theme rule or inline style). Code with `!important` and no reason is refused by `submit_findings` in the automatic flow; in a manual report, state the reason in the same paragraph.
- Never use an id that is numeric or generated (`#1234545`, `#44492`, `#shopify-section-template--17283928__main`, ids carrying a product/variant id or a run of 5+ digits), a generated class (`.css-1a2b3c`, hashes, CSS-module names) or an id/class that exists only on one element. Real app names with a short number (`.AirReviews-Widget__V2`, `.Joy-Wishlist-BlockStack--Gap-400`) are fine. Helpers: `lintCss`/`unstableName` in `skills/check-ticket-v2/scripts/customize.mjs`; selector reference: `knowledge-base/memory/css-selectors-map.md`.

## Verify the final CSS with MCP/headless after writing it (user order of 2026-10-14)

- User order (verbatim): "Sau khi hoàn thành css thì bạn hãy dùng mcp để test lại xem có apply được đúng ko ( ko cần phải test trực tiếp cho tôi, chỉ cần test ở phía bạn để đảm bảo css đó work đúng như mong đợi )". Writing the CSS is not the end of the check: the exact final block is tried once more on the agent's side before it goes into the report.
- After the final block is written, inject exactly that block (not an earlier draft) into the isolated headless page — MCP Chrome DevTools (headless, isolated) or the v2 `css_preview` tool — on the page the ticket is about, at desktop width and at mobile width when the request involves phones or a layout that changes with the viewport. Nothing is saved to the shop or theme.
- Compare what the page shows with what the merchant asked for, not only with "the rule applied": hidden element → 0 visible / `display: none`; shown element → visible; position → offset from the parent's edges, `justify-content`, `text-align`; colour → computed `color`/`background-color`; size → font and box. Every declared property must land (`✓`); a property still overridden (`✗`) means the block is not final: fix it (stable parent class first, `!important` with a written reason only when that still loses) and try again. A property the engine cannot compare (`? không so được`) is not a failure.
- The block in the report is the block that was tried last and passed. If the two differ, try the final block again; never paste an untried edit under a result observed with a different block. In the automatic flow `submit_findings` refuses such a mismatch and prints the last tried block to copy (`skills/check-ticket-v2/scripts/customize.mjs`, `cssTrialProblems`).
- When the final block cannot be tried (password-protected storefront, page error, no element matches, no budget left), keep the code built on real selectors and write "chưa thử được trên storefront vì …" with the real reason next to it. Do not write that sentence when a trial was still possible.
- State the observed result in the comment in one or two plain sentences (which selector was hidden/moved/recoloured, at which width), taken from the trial of the final block.

## Demo URL — separate maximum 2 minutes

- Only for a completed, verified preview: reuse the supplied headless browser and the existing CSS preview page. Capture a Playwright page/element screenshot, preferably just the relevant storefront widget. Inspect the saved PNG before upload. Describe it accurately as a Playwright screenshot, not Flameshot; never capture the desktop or open a headed browser.
- The worker returns the inspected screenshot path; the controller uses the configured upload endpoint and verifies the returned HTTPS link within the same two-minute deadline. Do not return a local path or inline image as a demo link.
- Missing uploader, wrong page, failed capture/upload or timeout: skip the demo and include exactly `Chưa thể đưa ra Demo nhờ Andew tự custom lấy demo`.
- Headless screenshot capture replaces the former Flameshot-only demo rule. Keep the verified CSS even when only the demo step fails.

## Not feasible or uncertain — maximum 5 minutes

Review the ticket and Elite explanation. Identify the concrete product/DOM/permission limitation and any supported alternative. Do not spend this branch trying to force an unsupported customization. On timeout use the Elite explanation, preserving uncertainty.

## Report

Explain which CSS suits the merchant's request and why, include the CSS and verified demo link or exact fallback sentence. If not feasible, explain the cause and next practical option. Distinguish a proposed customization from one actually tested; scope selectors to the current widget and do not hide a remaining functional limitation.
