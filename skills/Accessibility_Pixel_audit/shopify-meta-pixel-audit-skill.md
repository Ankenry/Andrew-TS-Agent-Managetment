---
description: Audit a Shopify storefront for browser-side Meta Pixel
  installation and event activity using Chrome DevTools (CDP/DevTools
  tools), without Playwright. Use when an agent needs to inspect a store
  URL, identify Meta Pixel IDs, verify browser network events, inspect
  cookies/scripts/frames, and produce an evidence-based report.
name: shopify-meta-pixel-audit
---

# Shopify Meta Pixel Audit

## 1. Purpose

Use this skill to determine whether a Shopify storefront shows evidence
of Meta Pixel tracking in the browser, which Pixel IDs are observed, and
which browser events are sent during a controlled test.

**Do not use Playwright or install a Playwright browser for this
workflow.** Use the available Chrome DevTools interface, Chrome DevTools
MCP server, or another explicitly available CDP-backed browser tool.

This audit only establishes what is observable in the tested browser
session. It does not prove that a Pixel is absent from every page, every
visitor session, Shopify Admin, or server-side Conversions API (CAPI).

## 2. Tool selection and constraints

Before browsing:

1.  Inspect the tools/skills available to you and identify the actual
    Chrome DevTools or CDP actions.
2.  Use only documented tools and their real schemas. Do not invent tool
    names, parameters, or commands.
3.  Prefer a persistent browser tab/session so Network evidence is
    collected across navigation and interactions.
4.  If no Chrome DevTools/CDP-capable tool is available, stop and report
    that limitation. Do not silently switch to Playwright.
5.  Do not request Shopify Admin credentials, Meta credentials, customer
    data, or checkout/payment details.
6.  Test only public storefront pages and use harmless interactions. Do
    not place a real order.

Chrome DevTools capabilities commonly useful for this task:

-   Network: requests, response status, request headers, query
    parameters, payload, initiator, frame
-   Console: JavaScript inspection and runtime errors
-   Application: cookies, local storage, session storage
-   Sources / execution contexts: inspect page and frame contexts where
    supported
-   Performance or Issues: optional supporting evidence

The exact controls depend on the installed DevTools tool. Use the
equivalent documented operation rather than assuming a particular
interface.

## 3. What counts as evidence

Use multiple independent signals. Never classify a Pixel as installed
solely because a cookie exists or a script URL appears in HTML.

### Strong evidence

-   A browser request to a Meta Pixel collection endpoint (commonly
    `https://www.facebook.com/tr/` or a relevant Meta-owned equivalent),
    with a Pixel ID such as the `id` query parameter.
-   A successfully observed event request with an event name such as
    `PageView`, `ViewContent`, or `AddToCart`.
-   A Meta Pixel SDK request (commonly
    `connect.facebook.net/.../fbevents.js`) together with an observed
    Pixel initialization or collection request.

### Supporting evidence

-   `window.fbq` or `window._fbq` exists in the top-level page context.
-   Page source or loaded scripts contain Meta Pixel initialization code
    or `fbq('init', ...)`.
-   Meta-related cookies such as `_fbp` and `_fbc`.
-   A Shopify Web Pixel sandbox or custom-pixel frame/context is present
    and associated network requests are observed.

### Weak or inconclusive evidence

-   A Meta script URL exists but no collection request is observed.
-   `_fbp` or `_fbc` exists without a corresponding event request.
-   A Meta script or request appears in a blocked/failed state.
-   A request is seen only in an extension, browser tooling, or
    unrelated embedded content and cannot be attributed to the
    storefront.

Record the exact evidence and its source. Do not turn weak evidence into
a definitive positive result.

## 4. Shopify-specific considerations

Shopify storefront tracking may be implemented in several ways:

-   Theme code or manually added scripts.
-   A third-party app.
-   Shopify Customer Events / Web Pixels, including app pixels.
-   Custom pixels.
-   Server-side integrations such as Meta Conversions API.

Important implications:

-   Shopify app pixels can execute in an isolated/strict sandbox and may
    not expose `fbq` on the storefront's top-level `window`.
-   Custom pixels can execute in a sandboxed frame.
-   A top-level `window.fbq` check is useful but is not a complete
    Shopify Pixel detector.
-   Inspect all available frames/execution contexts when DevTools
    supports it, but do not assume every sandbox is visible through
    every tool.
-   Browser Network requests are often the most useful
    cross-implementation evidence.
-   Server-side CAPI events are not necessarily visible in browser
    Network traffic. A browser-only audit cannot confirm or rule out
    CAPI.

## 5. Audit workflow

### Step 1 --- Validate the target

1.  Accept a complete public storefront URL.
2.  Normalize it to HTTPS only when safe and appropriate; preserve the
    supplied host and path.
3.  Navigate to the homepage.
4.  Record:
    -   Final URL after redirects
    -   Page title
    -   Navigation outcome
    -   Timestamp and timezone if available
    -   Any access, bot-protection, consent, or navigation errors

If the site cannot be reached, report `INCONCLUSIVE` rather than
`NOT_DETECTED`.

### Step 2 --- Start Network capture before navigation

If the tool allows it:

1.  Open/enable Network monitoring before loading the target page.
2.  Preserve the log across navigation if supported.
3.  Enable capture of requests from all frames/contexts if the DevTools
    tool offers that option.
4.  Do not filter so narrowly that relevant requests are hidden.
    Search/filter after capture.

If monitoring starts only after the page has loaded, reload once with
Network capture active and record that a reload was performed.

### Step 3 --- Inspect initial page load

Allow the page to settle for a short period (typically 3--8 seconds,
adjusted for slow stores).

Inspect:

-   Requests containing `fbevents.js`
-   Requests to `/tr/` on Meta-owned domains
-   Other Meta-owned tracking endpoints, if clearly identifiable
-   Request status, method, URL, query parameters, payload, initiator,
    and frame/context where available

For each candidate collection request, extract:

-   Pixel ID: usually query parameter `id`
-   Event name: usually query parameter `ev`
-   Event ID: commonly `eid`, when present
-   Page URL: commonly `dl`, when present
-   Browser ID: commonly `fbp`, when present
-   Click ID: commonly `fbc`, when present
-   HTTP status / failure reason
-   Initiator and frame/context, if available

Treat parameter names as common patterns, not guaranteed fields.
Preserve the raw request URL or a sanitized evidence record.

### Step 4 --- Inspect JavaScript and page resources

In the top-level page context, run read-only checks if Console
evaluation is supported:

``` javascript
({
  fbqType: typeof window.fbq,
  fbqIsFunction: typeof window.fbq === "function",
  fbqQueueType: typeof window._fbq,
  metaScripts: [...document.scripts]
    .map(script => script.src)
    .filter(src => /facebook\.net|facebook\.com/i.test(src))
})
```

Optional: inspect visible script text or loaded resources for patterns
such as:

``` javascript
fbq('init', 'PIXEL_ID')
fbq('track', 'PageView')
```

Rules:

-   Do not call undocumented `fbq` methods.
-   Do not modify the site's JavaScript state.
-   Do not inject a Pixel or manually trigger tracking events.
-   A missing `window.fbq` is not proof that Shopify has no Pixel.
-   Record the execution context in which the check ran (top frame or
    another frame).

### Step 5 --- Inspect cookies and storage

Read cookies for the storefront domain and, where available, relevant
Meta domains.

Look for:

-   `_fbp`
-   `_fbc`

Record cookie name, domain, path, expiry/session status, SameSite and
Secure attributes when available. Do not expose full cookie values in
the report; mask values or record only presence.

Rules:

-   Cookies are supporting evidence only.
-   Consent settings, browser privacy protections, or lack of an ad
    click may explain why a cookie is absent.
-   A cookie alone does not establish that events are being sent.

### Step 6 --- Check consent behavior

If a consent banner is displayed:

1.  Record the initial state before interacting.
2.  If the interface provides a clear **Accept all** or equivalent
    consent action, it may be selected for the audit.
3.  Do not select optional marketing consent if the user has not
    authorized that test or the interface is ambiguous.
4.  If consent is declined or not granted, record that state and
    interpret missing tracking cautiously.
5.  If possible, run a separate consent-granted test in a fresh session,
    clearly labeling it as a separate run.

Never bypass a consent mechanism or browser privacy control.

### Step 7 --- Test storefront events

Use harmless, ordinary storefront interactions. After each action,
inspect newly captured Network requests.

Recommended test sequence:

  Action                             Expected event to look for
  ---------------------------------- --------------------------------------------------
  Load homepage                      `PageView`
  Open a product page                `PageView`, possibly `ViewContent`
  Use storefront search              `Search`, if configured
  Add an available product to cart   `AddToCart`
  Open checkout                      `InitiateCheckout`, if configured and observable

For AddToCart:

1.  Choose an in-stock product and a valid variant if needed.
2.  Click the normal Add to cart control once.
3.  Wait for the cart operation to complete.
4.  Inspect requests generated immediately after the action.
5.  Do not repeat the action unnecessarily.

For checkout:

-   Do not submit payment or personal information.
-   Do not create an order.
-   Only inspect the transition into checkout if it is safe and does not
    require sensitive data.
-   Some checkout events may not be observable from the storefront page.

Do not assume every store is configured to send every standard event.
Report only events actually observed.

### Step 8 --- Correlate and deduplicate

Group requests by Pixel ID and event name.

-   Deduplicate identical requests only for summary counts; retain
    evidence of repeated sends.
-   If multiple Pixel IDs appear, report each separately.
-   Do not assume multiple IDs are duplicates or errors.
-   If an event request is sent more than once, report the observed
    count and possible duplicate behavior without declaring a defect
    unless the evidence supports it.
-   Distinguish a request initiated by the storefront from unrelated
    third-party embeds where possible.

### Step 9 --- Assess failures and blockers

Check whether candidate requests are:

-   Successful (2xx where a response status is available)
-   Redirected
-   Failed at the network layer
-   Blocked by client/browser policy
-   Blocked by an extension or content blocker
-   Pending or canceled
-   Not inspectable due to tool limitations

A request visible in Network but marked blocked/failed is evidence of an
attempted request, not successful delivery.

If the browser environment may have an ad blocker, tracking protection,
or restrictive network policy, mention that limitation. Do not disable
protections without authorization.

## 6. Detection decision rules

Use one of these overall outcomes:

### `CONFIRMED_ACTIVE`

Use when at least one Meta Pixel collection request is observed with a
Pixel ID and event name, and the request is not reported as
blocked/failed. State which events were observed. This confirms
browser-side event transmission was attempted and accepted at the
browser/network layer; it does not prove Meta processed or attributed
the event.

### `PIXEL_PRESENT_EVENTS_NOT_CONFIRMED`

Use when there is credible installation evidence (for example, Meta SDK
plus initialization evidence) but no collection event request is
observed.

### `ATTEMPTED_BUT_BLOCKED`

Use when a Meta collection request is observed but blocked, failed, or
canceled. Include the failure evidence.

### `NOT_DETECTED`

Use only when the tested pages and actions produced no credible Meta
Pixel evidence and the audit had adequate coverage. Phrase this as "No
browser-side Meta Pixel evidence detected in this test," not "The store
does not have Meta Pixel."

### `INCONCLUSIVE`

Use when the site could not be loaded, consent prevented a meaningful
test, DevTools capture was unavailable/incomplete, bot protection
interfered, or the tool could not inspect relevant frames/network
activity.

## 7. Evidence and report format

Return a concise summary plus structured JSON. Do not include raw cookie
values, customer data, checkout details, or unnecessary personal
information.

### Human-readable report

Include:

-   Store URL and final URL
-   Audit timestamp
-   Overall outcome
-   Pixel IDs
-   Observed events
-   Evidence by layer (Network, SDK/JS, cookies, frames/sandbox)
-   Failed or blocked requests
-   Pages and interactions tested
-   Consent state
-   Limitations and confidence

### JSON schema example

``` json
{
  "store_url": "https://example-store.com",
  "final_url": "https://example-store.com/",
  "platform": "Shopify (user-supplied or independently verified)",
  "audit_timestamp": "ISO-8601 timestamp",
  "overall_status": "CONFIRMED_ACTIVE",
  "confidence": "high",
  "pixels": [
    {
      "pixel_id": "123456789",
      "sdk_detected": true,
      "events": [
        {
          "event_name": "PageView",
          "page": "https://example-store.com/",
          "request_status": "observed",
          "http_status": 200,
          "source_context": "top-frame or unknown"
        },
        {
          "event_name": "AddToCart",
          "page": "https://example-store.com/products/example",
          "request_status": "observed",
          "http_status": 200,
          "source_context": "frame or unknown"
        }
      ]
    }
  ],
  "cookies": {
    "_fbp_present": true,
    "_fbc_present": false,
    "values_redacted": true
  },
  "tests": {
    "homepage": true,
    "product_page": true,
    "search": false,
    "add_to_cart": true,
    "checkout_opened": false,
    "consent_state": "accepted"
  },
  "blocked_or_failed_requests": [],
  "limitations": [
    "Browser inspection cannot confirm server-side Conversions API events."
  ],
  "evidence": [
    {
      "type": "network_request",
      "description": "Meta collection request observed with id and ev parameters",
      "url_redacted": "https://www.facebook.com/tr/?id=123456789&ev=PageView"
    }
  ]
}
```

The example is illustrative. Use `null`, empty arrays, or omit fields
when values are unavailable. Never fabricate an HTTP status, Pixel ID,
event, platform identification, timestamp, or consent state.

## 8. Confidence rubric

-   **High:** One or more non-blocked Meta collection requests with
    Pixel ID and event name; ideally corroborated by SDK or additional
    event requests.
-   **Medium:** SDK and initialization evidence, or a collection request
    whose attribution/status is partially unclear.
-   **Low:** Only cookies, script references, or indirect indicators.
-   **None / Inconclusive:** Insufficient evidence or the audit could
    not be completed.

Confidence describes the quality of browser evidence, not the store's
full server-side tracking configuration.

## 9. Common mistakes to avoid

-   Do not rely only on `typeof window.fbq`.
-   Do not treat `_fbp` as proof of an active Pixel.
-   Do not treat loading `fbevents.js` as proof that an event was sent.
-   Do not assume every Shopify Pixel runs in the top-level page
    context.
-   Do not assume absence of browser requests means absence of
    server-side CAPI.
-   Do not claim Meta received, processed, attributed, or displayed an
    event based only on a browser request.
-   Do not infer Shopify Admin configuration from storefront behavior.
-   Do not report a Pixel ID unless it was actually observed in
    evidence.
-   Do not trigger Purchase by placing a real order.
-   Do not expose cookie values, access tokens, personal data, or
    payment data.

## 10. Final response template

Use this structure when reporting to the user:

``` text
Meta Pixel audit: [OUTCOME]

Store: [URL]
Pixel ID(s): [IDs or Not detected]
Observed events: [event list or None]
SDK: [Detected / Not detected / Not inspected]
Cookies: [_fbp present/absent; _fbc present/absent]
Shopify sandbox/frame evidence: [Found / Not found / Not inspectable]
Consent state: [state / unknown]

Evidence:
- [Concrete network or runtime evidence]
- [Pages/actions tested]

Limitations:
- [Relevant limitations, especially browser-only visibility and CAPI]

Conclusion:
[Carefully worded conclusion matching the decision rules.]
```

Always distinguish **not detected** from **not installed**. The audit's
conclusion must be traceable to the evidence collected in the current
browser session.
