---
name: Andrew Brain
description: Dark personal workspace for reading notes and keeping selected sources beside a question.
colors:
  bg: '#111816'
  rail: '#14231d'
  reader: '#131d17'
  assistant: '#19261d'
  line: '#33443a'
  muted: '#a8b9ad'
  text: '#e9eee9'
  accent: '#e3b75a'
  focus: '#f1cb79'
  nav-text: '#c0cfc4'
  nav-hover: '#20352a'
  nav-active: '#344431'
  nav-active-text: '#f3ce87'
  icon-text: '#b9c9be'
  icon-hover: '#2a3b30'
  white: '#fff'
  search: '#19251e'
  search-line: '#45584a'
  search-muted: '#a8bcae'
  placeholder: '#a5b6aa'
  filter-text: '#b8c7bc'
  filter-hover: '#26362c'
  filter-active: '#38472e'
  filter-active-text: '#f2cb7e'
  row-reading: '#203025'
  row-selected: '#343722'
  row-selected-reading: '#3b3d24'
  row-hover: '#1c2a21'
  button: '#24352a'
  button-text: '#d0e0d3'
  button-selected: '#494328'
  button-selected-text: '#f2ce87'
  reader-text: '#d6dfd8'
  code: '#101913'
  code-line: '#3a4c40'
  code-text: '#cfe3cd'
  composer: '#111d14'
  composer-line: '#52664f'
  composer-text: '#e6efe6'
  composer-placeholder: '#a9bdad'
  disabled-send: '#344630'
  disabled-send-text: '#becbb2'
  disabled-send-line: '#53654a'
  source-line: '#374c3c'
  source-text: '#e7eee7'
  source-meta: '#adc2b2'
  stale-text: '#f4c275'
  provider: '#3b3524'
  provider-text: '#efd39a'
  error: '#362721'
  error-line: '#845c4c'
  error-text: '#f4cdbb'
typography:
  headline:
    fontFamily: Arial, Helvetica, sans-serif
    fontSize: 26px
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: -0.025em
  document-title:
    fontFamily: Arial, Helvetica, sans-serif
    fontSize: 25px
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: -0.025em
  document-section:
    fontFamily: Arial, Helvetica, sans-serif
    fontSize: 19px
    fontWeight: 600
    lineHeight: 1.75
  panel-title:
    fontFamily: Arial, Helvetica, sans-serif
    fontSize: 17px
    fontWeight: 600
    letterSpacing: -0.02em
  body:
    fontFamily: Arial, Helvetica, sans-serif
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.75
  ui:
    fontFamily: Arial, Helvetica, sans-serif
    fontSize: 12px
    fontWeight: 400
  label:
    fontFamily: Arial, Helvetica, sans-serif
    fontSize: 11px
    fontWeight: 400
  compact-action:
    fontFamily: Arial, Helvetica, sans-serif
    fontSize: 10px
    fontWeight: 400
  metadata:
    fontFamily: ui-monospace, SFMono-Regular, Consolas, monospace
    fontSize: 9px
    fontWeight: 400
    lineHeight: 1.6
  metadata-count:
    fontFamily: ui-monospace, SFMono-Regular, Consolas, monospace
    fontSize: 10px
    fontWeight: 400
  code:
    fontFamily: ui-monospace, SFMono-Regular, Consolas, monospace
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.75
rounded:
  inline-code: 3px
  badge: 4px
  compact-control: 5px
  control: 6px
  field: 7px
spacing:
  '4': 4px
  '5': 5px
  '6': 6px
  '7': 7px
  '8': 8px
  '9': 9px
  '10': 10px
  '11': 11px
  '12': 12px
  '13': 13px
  '14': 14px
  '15': 15px
  '17': 17px
  '18': 18px
  '20': 20px
  '22': 22px
  '23': 23px
  '24': 24px
  '25': 25px
  '26': 26px
  '28': 28px
  '30': 30px
components:
  button-small:
    backgroundColor: '{colors.button}'
    textColor: '{colors.button-text}'
    typography: '{typography.compact-action}'
    rounded: '{rounded.compact-control}'
    padding: 7px 9px
  button-small-selected:
    backgroundColor: '{colors.button-selected}'
    textColor: '{colors.button-selected-text}'
    typography: '{typography.compact-action}'
    rounded: '{rounded.compact-control}'
    padding: 7px 9px
  button-icon:
    textColor: '{colors.icon-text}'
    rounded: '{rounded.compact-control}'
  button-icon-hover:
    backgroundColor: '{colors.icon-hover}'
    textColor: '{colors.white}'
  search-field:
    backgroundColor: '{colors.search}'
    textColor: '{colors.text}'
    rounded: '{rounded.field}'
    padding: 0 12px
  filter:
    textColor: '{colors.filter-text}'
    typography: '{typography.label}'
    rounded: '{rounded.compact-control}'
    padding: 7px 9px
  filter-active:
    backgroundColor: '{colors.filter-active}'
    textColor: '{colors.filter-active-text}'
    rounded: '{rounded.compact-control}'
    padding: 7px 9px
  nav-item:
    textColor: '{colors.nav-text}'
    rounded: '{rounded.control}'
    padding: 11px 12px
  nav-item-active:
    backgroundColor: '{colors.nav-active}'
    textColor: '{colors.nav-active-text}'
    rounded: '{rounded.control}'
    padding: 11px 12px
  code-block:
    backgroundColor: '{colors.code}'
    textColor: '{colors.code-text}'
    typography: '{typography.code}'
    rounded: '{rounded.field}'
    padding: 17px
  question-field:
    backgroundColor: '{colors.composer}'
    textColor: '{colors.composer-text}'
    rounded: '{rounded.field}'
    padding: 12px
    width: 100%
    height: 100px
  button-send-disabled:
    backgroundColor: '{colors.disabled-send}'
    textColor: '{colors.disabled-send-text}'
    typography: '{typography.ui}'
    rounded: '{rounded.control}'
    padding: 11px
    width: 100%
  chosen-source:
    textColor: '{colors.source-text}'
    padding: 13px 0
  provider-status:
    backgroundColor: '{colors.provider}'
    textColor: '{colors.provider-text}'
    typography: '{typography.label}'
    rounded: '{rounded.control}'
    padding: 5px 8px 5px 12px
  error-notice:
    backgroundColor: '{colors.error}'
    textColor: '{colors.error-text}'
    rounded: '{rounded.control}'
    padding: 12px
---

# Design System: Andrew Brain

## Overview

**Creative North Star: "Nguồn cạnh câu hỏi"**

“Nguồn cạnh câu hỏi” is the confirmed direction for this personal web workspace. Its dark default combines green-charcoal task panels, warm amber selection and readable working text. Familiar table, reading and form controls express the developer-oriented brief without a simulated terminal or decorative neon.

The reusable identity is selected-source continuity: a note stays recognizable in the library, reader and question context through its title, checked state and revision metadata. Reading remains useful while AI is unconnected. The source body and assistant area retain separate visual roles; no generated answer or connected-provider treatment is implied by a draft field.

**Key Characteristics:**
- Dark green-charcoal panels separated by fine rules.
- Compact working controls with a calmer, longer-line-height reader.
- Amber selection paired with checkboxes, labels and source counts.
- Sans UI and prose; monospace paths, revisions, counts and code.
- Truthful read-only, unconnected, empty, stale and recovery states.

This is the implemented, code-led system at this app boundary. [PRODUCT.md](PRODUCT.md) carries product constraints; [.impeccable/surfaces/src-app-tsx.md](.impeccable/surfaces/src-app-tsx.md) carries the selected surface composition. “Andrew Brain” remains a working name. The earlier light concept was superseded by the explicit dark brief; there is no approved raster comp to reproduce.

## Colors

The palette is muted green-charcoal with warm amber for selected work and a distinct warm error treatment. The frontmatter is normative; token names below refer to it rather than creating a second palette.

### Primary

- **Warm amber** (`accent`): native checkbox selection and caret. Related `focus` is the keyboard outline, not a glow or surface wash.
- **Olive amber selection** (`row-selected`, `row-selected-reading`, `button-selected`, `filter-active`, `nav-active`): region-specific fills that retain legible text. Their accompanying text tokens preserve the distinctions already in the UI.
- **Provider amber** (`provider`, `provider-text`): unconnected status, always paired with the explicit “AI chưa kết nối” label.

### Neutral

- **Green charcoal** (`bg`): library and workspace ground.
- **Deep green rail** (`rail`): navigation; `reader` is the quiet reading ground and `assistant` the question-context surface.
- **Fine green rule** (`line`): structural separators. Field, code, selected-source and error borders have their own observed tokens.
- **Pale green text** (`text`, `reader-text`): working UI and reading prose. `muted` and metadata variants support secondary information.
- **Recessed field tones** (`search`, `composer`, `code`): editable question, search and code regions remain distinct from their surrounding panel.

### State colors

`row-reading` and `row-hover` distinguish reading and hover from source selection. `stale-text` marks a changed revision with explanatory text. `error`, `error-line` and `error-text` carry the readable offline/retry notice. These are semantic states, not additional brand accents.

**The Selection Continuity Rule.** Use amber with explicit checked or selected labels across the source table, reader action and question-source count; color alone is not the source identity.

## Typography

**Body and UI Font:** Arial, Helvetica, sans-serif.
**Label/Mono Font:** ui-monospace, SFMono-Regular, Consolas, monospace.
**Display Font:** None established. Arial is the accepted workhorse UI font for this Operate surface, not an expressive display identity.

### Hierarchy

- **Headline:** `headline` for the library title; its restrained negative tracking does not introduce a hero display scale.
- **Document title and section:** `document-title` and `document-section`; third-level headings are 16px and inherit the reader's line height.
- **Panel title:** `panel-title` for the assistant heading. Supporting UI uses the `ui`, `label` and `compact-action` roles.
- **Body:** `body` for Markdown, capped at 72ch and centered within the reader. It has more line spacing than table metadata.
- **Metadata:** `metadata` for document provenance; `metadata-count` for counters and paths where used. The list path adds a 9px/1.6 treatment, while document and chosen-source revision lines have their own context.
- **Code:** `code`; inline code has a small tinted background, and multiline code uses the bordered block component with horizontal overflow.

The source uses a practical role-based ramp, not a fixed mathematical ratio. Desktop metadata spans 9–11px, compact actions 10–12px, and primary reading text 14px. These small roles are secondary; do not reduce the reader to their scale. Mobile title and field adjustments are documented under Layout.

**The Metadata Separation Rule.** Keep paths, hashes, counts and code in monospace; keep reading prose and working controls in the sans stack.

## Layout

The current desktop surface is a fixed viewport workspace: a 208px rail next to a flexible main region, with a 60px topbar. The remaining work grid pairs a flexible library/reader column with a 320px assistant. The shell uses `100dvh`, a 600px minimum height and contained overflow. The library sits above the reader with a 56% maximum height and 260px minimum height; its table scrolls independently. The reader and assistant have their own overflow regions. This is the current surface expression, not a mandate that every future screen repeat these columns.

Library padding is 20px 26px 0; reader content is 25px 30px 48px; assistant padding is 26px 21px 20px. The reader toolbar is 48px high. Chosen sources have a 240px maximum-height scrolling region. Spacing is compact and role-specific: small gaps of 4–12px, working-region insets generally 17–30px. There is no universal four-pixel grid or generic card gutter in the code.

| Exact query | Implemented change |
| --- | --- |
| `min-width: 1700px` | Assistant expands to 370px; library side padding becomes 36px, assistant 28px and reader 50px. |
| `max-width: 1100px` and `min-width: 701px` | Rail becomes 176px, assistant 276px; library uses 22px 17px 0, assistant 22px 16px, reader 22px and topbar sides 17px. Date column and illustration badge are hidden. |
| `max-width: 700px` | Rail becomes a fixed 240px drawer; topbar becomes 55px, then a 49px task-tab strip. Only the selected Nguồn, Đọc or Trợ lý surface is visible. The workspace remains `100dvh`; shell minimum height is 500px, body minimum width is 320px. |

Mobile library padding is 23px 17px 0, reader 23px 19px 40px and assistant 24px 23px 20px. The library title becomes 25px, Markdown title 24px, Markdown second heading 18px, assistant heading 20px, chosen-source title 13px and composer text 14px. The table hides the date column and uses 13px 5px cell padding. Search shortcut hint is hidden. Opening a note selects Đọc; source handoff selects Trợ lý. Source selection and the draft are shared across these tabs, not remade per panel.

## Elevation & Depth

There are no box shadows in the implementation. Depth comes from near-dark surface differences, one-pixel separators, inset fields and explicit hover/selection fills. The mobile drawer uses stacking and a translucent black backdrop (`#0008`), not a shadow. Code and notices are bordered in place; panels do not float above the workspace.

**The Tonal Panel Rule.** Separate working regions through dark surface tones and thin borders, without adding drop shadows.

The drawer moves with a transform transition (0.18s ease-out). The refresh icon rotates while loading (1.4s linear, infinite). There are no ornamental entrance animations. Reduced-motion preference removes animations and transitions and restores automatic scroll behavior. These extensions live in the sidecar, not the YAML token groups.

## Shapes

Rectangular panels and table rows establish the structure. Smaller controls soften locally: `compact-control` for small actions and filters, `control` for navigation/status/notice treatments, and `field` for search, textarea and code blocks. Inline code and illustration badges use the smaller radius tokens. Do not convert the rows into rounded cards; the selection field belongs to the table geometry.

Controls and metadata use Lucide line icons rendered as SVG, not Unicode glyph substitutions. Native source checkboxes are 14px square with an accent color. The sidecar preserves representative line icons as inline SVG and keeps interactive names in HTML.

## Components

### Buttons

Compact and task-specific. Reader source actions use `button-small` and `button-small-selected`, carrying their label and check/link icon. Icon actions use a transparent default, `button-icon-hover`, and a minimum 32px target; selected-source removal and provider-settings controls reduce the target to 24px in their compact rows. These are observed dimensions, not a new universal accessibility target.

The send control uses `button-send-disabled`, a one-pixel state border and a not-allowed cursor. It is disabled because AI is unconnected; no enabled primary-send variant exists to document. No speculative enabled, hover or active state should be inherited from this placeholder.

### Chips and filters

Category filters are real buttons with `aria-pressed`, transparent default, `filter-hover` and the selected `filter-active` fill. They use compact text and do not adopt pill shapes. The provider status is a compact rectangular capsule with a dot, literal unconnected label and a settings action. The illustration badge labels fixture data rather than claiming provenance for private notes.

### Cards and containers

Task panels use tonal depth and dividing rules. The code block is a bordered, gently rounded container with 17px padding on desktop and 13px on mobile. It preserves whitespace, scrolls horizontally and is keyboard-focusable. Markdown blocks remain reading content; no generic elevated card abstraction is established. The configuration disclosure uses the small-action surface tone with 14px padding and the field radius.

### Inputs and focus

The search field is at least 43px high, with a one-pixel border, 12px horizontal inset and a 13px desktop input. Its `focus-within` state changes the border to amber; the inner input suppresses its outline. Other buttons, input controls, textareas, links and code blocks use a two-pixel `focus` outline with a three-pixel offset on `:focus-visible`.

The question textarea is 100px high, vertically resizable between 80px and 220px, with 12px text at 1.65 line height on desktop and 14px on mobile. Draft length is displayed against the 4000-character limit, with tab-local retention explicitly labeled. Source handoff focuses the programmatically focusable source heading and scrolls it into view; that heading has a two-pixel focus outline offset by six pixels.

Ctrl/Cmd+K selects the sources view and focuses search after the pane switch. Escape closes the navigation drawer and configuration disclosure. Mobile task tabs use `role=tab`, `aria-selected` and roving tabindex: Left/Right cycle through the three tabs; Home/End select the first/last tab. These keys update both the selected view and keyboard focus.

### Navigation

A left rail groups note folders and exposes a single active selection with `nav-item-active`; the hover variant lightens the surface and text. Counts use monospace. Mobile replaces the persistent rail with the drawer and a backdrop close action. The three task tabs switch workspace visibility; the assistant tab shows a selected-source count when nonzero.

### Selected-source continuity

This is the signature component relationship. Table selection, current reading and combined reading/selection have separate fills. Checkbox, reader button and question-source tray refer to the same selected note. The tray shows its title and shortened revision, allows removal or reopening, and exposes an explicit stale-source message when needed. Selection is capped at eight. The source-heading count and handoff focus make the destination visible on desktop and mobile.

### Empty, unconnected and recovery states

Library, reader and selected-source empty states explain the next useful action without invented content. Unconnected AI is stated before the composer and again alongside the disabled send action. The error notice carries a visible retry action; the offline capture names the unavailable note service, its local startup command and port. Stale sources offer a new-version read instead of silently presenting the previous revision as current. Functional note/search/reader/selection controls remain distinct from the unimplemented AI response capability.

## Do's and Don'ts

### Do:

- **Do** carry the selected note title, revision and selection state between library, reader and assistant.
- **Do** keep dark as the default, and use the existing green-charcoal surfaces with restrained amber states.
- **Do** keep a visible focus indicator, a labeled control and a concrete destination for a source handoff.
- **Do** preserve selected sources and the question draft while changing the mobile task tab.
- **Do** distinguish actual note content, labeled illustration data, unconnected AI and stale source revisions.
- **Do** let the note reader and code blocks scroll independently inside the available viewport.

### Don't:

- **Don't** turn the developer brief into a fake terminal, decorative neon or fabricated metrics.
- **Don't** present the disabled send control as an available AI action or invent a provider/model choice.
- **Don't** use source-category or revision metadata as a decorative heading pattern on unrelated surfaces.
- **Don't** apply monospace to all prose or treat Arial as a distinctive brand display face.
- **Don't** replace the current tonal depth with decorative shadows or floating cards.
- **Don't** treat the superseded light concept sketch as color authority.

Documentation evidence: [App.tsx](src/App.tsx), [styles.css](src/styles.css), all five existing desktop/mobile/offline captures in [.impeccable/review](.impeccable/review/), and the scoped [ship verdict](.impeccable/review/verdict-pass.md). The review accepted Arial for working UI; it is not promoted into an expressive display rule. Decorative brand microcopy is not canonized as a reusable eyebrow component. This documentation does not add a new UI audit or claim fresh browser validation.
