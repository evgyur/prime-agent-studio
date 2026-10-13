# Components

Every recipe below exists in `assets/studio.css` and is shown in `assets/components.html`.
Copy the markup from the gallery; adapt labels and data only.

## Buttons

| Class | Look | Use |
|---|---|---|
| `.ps-btn.ps-btn--primary` | `--accent` fill, `--accent-ink` text, 12 px / 500, padding `9px 13px`, radius 7, hover `--accent-strong` | The single main action of a view or dialog ("Add a plan", "Done", "Push"). |
| `.ps-btn.ps-btn--secondary` | transparent, 1 px `--line`, `--muted` text, hover `--surface-hover` + `--text` | Any other action next to it ("Cancel", "Pull", "Fetch"). |
| `.ps-btn.ps-btn--danger` | `--red` fill, `--bg` text | Confirming a destructive action inside a dialog. Elsewhere use red text. |
| `.ps-btn--compact` | min height 32 px, padding `6px 10px`, 10 px | Dense toolbars inside panels. |
| `.ps-btn.ps-btn--tinted` | `--accent-bg` fill, `--tinted-line` border, `--accent-text`, 550, full width, kbd hint at the right | The one creation action at the top of a sidebar ("New session"). |
| `.ps-btn.ps-btn--quiet` | full width outline, 11 px muted | A second sidebar action under the tinted one. |
| `.ps-text-btn` | no frame, 12 px `--muted`, hover `--text` | Inline actions: "Edit", "Add a milestone", "Remaining only". |
| `.ps-icon-btn` (32), `--sm` (23), `--header` (28) | transparent, `--muted` icon, hover `--surface-hover` + `--text`; `.is-active` = `--accent-bg` + `--accent` | Toolbars, headers, row actions. Always with `aria-label`. |
| `.ps-pill-btn` | `--surface`, 1 px `--line`, radius 8, 34 px, icon + label (+ accent number), hover border `--accent` | Header actions that open a tool ("Roadmap 42 %"). |
| `.ps-pill-btn--sm` | 28 px, 11 px muted, dot first; `.is-on` = `--accent-bg` + accent border | Header toggles with a state ("Computer Use"). |
| `.ps-send-btn` | 44 px square (30 px with `--sm`), radius 8, `--accent` fill, arrow-up icon | Send in a composer. Disabled (opacity 0.3) while the input is empty. |

Rules: at most one accent-filled button per pane or dialog (the primary, or the send button of a composer); the sidebar may also hold one `.ps-btn--tinted` creation action; disabled = `opacity: 0.4` and `cursor: not-allowed`; icons in buttons are 13 px (text buttons) to 18 px (icon buttons); never use pill-shaped (999 px) buttons.

## Small labels

- `.ps-kbd`: 9 px, `--faint`, 1 px `--line`, radius 4, padding `2px 4px`. Shortcut hints written "Ctrl N", "Ctrl K" (space, no plus sign).
- `.ps-tag`: 8 px / 600, uppercase, tracking 1 px, `--surface` fill, `--line` border, radius 4 ("LOCAL").
- `.ps-badge`: rounded (999 px) badge, 10 px, accent tint (`color-mix(accent 14%)` fill, 45% border, `--accent` text) for news ("Update available").
  `.ps-badge--solid`: `--accent-bg` fill, `--accent-text`, 11 px / 600 ("This address").
- `.ps-status-letter`: 20 x 22 px mono letter for file changes: M (`--accent-bg`), + (green tint), D (red tint).
- `.ps-count`: 10 px tabular `--faint`, pushed right in a row.

## Status

- `.ps-dot`: 6 px circle (5 px with `--sm`). Variants: `--running` (green, 3 px soft halo, pulse 1.7 s), `--unread` (blue, halo), `--connected` (green, no pulse), `--attention` (amber), `--error` (red); default `--faint` = idle or off.
- `.ps-status`: 11 px label preceded by a 6 px dot of its own color. `.is-working` (accent text), `.is-done` (soft green), `.is-failed` (soft red), `.is-connected` and `.is-attention` (green or amber dot with muted text, like "Engine connected"), default muted (waiting, queued, turn ended, offline).
- `.ps-spinner`: 14 px ring, `--line` with an `--accent` arc, 0.8 s.
- Status is never a big colored block. It is a dot, a short word, or a tinted icon.

## Inputs

- `.ps-input`: full width, `--bg` fill (inside dialogs and cards on `--surface`), 1 px `--line`, radius 7, padding `11px 12px`, 13 px. Focus: the global 2 px accent outline.
- `.ps-label` (12 px / 500, 9 px gap) with optional `<small>` (9 px faint "optional"); `.ps-help` (11 px muted, line height 1.6) under the field or in settings rows.
- `.ps-search`: borderless search line for sidebars (icon, 11 px input, kbd). `.ps-search-box`: framed 44 px search for dialogs, `--bg` fill, radius 9; on focus the border and icon turn `--accent` with a 2 px accent ring at 18%.
- `.ps-select`: 40 px, radius 9, `--surface`, 1 px `--line`. `.ps-select--bare`: frameless 12 px muted select inside toolbars ("Maximum").
- `.ps-checkbox`: native checkbox (14 px) with `accent-color: var(--accent)`, 12 px muted label.
- `.ps-switch`: 31 x 18 px, track `--line`, knob 12 px `--muted`; checked: track `--accent`, knob white, moves 13 px.
- `.ps-segmented`: 3 to 4 equal options in a `--surface` frame (radius 10, padding 4); checked option `--accent-bg` + `--accent-text`, 40 px high.
- `.ps-choice-cards`: 3 visual choices (icon + label) in `--bg` cards; pressed: `--accent` border and text on `--accent-bg`.
- `.ps-settings-row`: label + help on the left, control on the right, 18 px vertical padding, 1 px `--line` on top. Settings pages are lists of these rows, grouped under a 20 px / 550 section title with an 11 px muted scope line.

## Navigation

- Tree (`.ps-tree` > `.ps-tree-head` + `.ps-tree-children`): a 22 px `.ps-disclosure` chevron (rotates 90 degrees when open) then a `.ps-row`. Children are `.ps-subrow`, indented 33 px.
- `.ps-row`: 38 px, radius 6, 12 px `--muted`; hover `--surface` + `--text`; `.is-active` `--text`. A colored folder icon (`.ps-folder` with `--row-color`), a label that truncates, optional dots, a pin, a count.
- `.ps-subrow`: 38 px, radius 7, 12 px `--muted`, hover `--surface`; `.is-active` = `--accent-bg` + `--accent-text`. Status dot at the end.
- `.ps-nav-item`: settings navigation item (42 px, radius 7, 17 px icon, gap 11); `aria-selected="true"` = `--accent-bg` + `--accent` text.
- Breadcrumb in the header: folder icon, parent in `--muted`, "/" in `--faint`, current page in `--text`, 12 px, everything truncates.

## Tabs

| Class | Look | Use |
|---|---|---|
| `.ps-tabbar` + `.ps-tab` | IDE tabs on `--sidebar`, 35 px; active tab `--bg` with a 2 px accent line on top | Panels that hold several documents or tools. |
| `.ps-tabs-underline` | 14 px text, 25 px gaps, active = `--text` + 2 px accent underline | Views inside a panel ("Project / Session / Backlog"). |
| `.ps-tabs-pill` | equal pills, 40 px, active `--accent-bg` | Switching sub-panels in a narrow column ("Session / Agents / Files"). |

Lockable tab: add `.has-lock` and a `.ps-tab-lock` with the `unlock` icon (55% opacity) or `lock` icon + `.is-locked` (`--accent-text`, full opacity).

## Cards and lists

- `.ps-card`: `--surface`, 1 px `--line`, radius 12, padding 13. `.ps-card--interactive`: column layout, gap 7, hover border `--accent` (no lift, no shadow). Inside: `.ps-card-eyebrow` (11 px muted role), `.ps-card-title` (13 px / 700), `.ps-status`, `.ps-card-meta` (10 px mono muted).
- `.ps-activity`: collapsible card (radius 11) for grouped background work: icon, 13 px / 550 label, 11 px count ("2 tool calls · 1 reflection"), state word at the right ("Done", "Running"), chevron.
- `.ps-option`: selectable option in pickers, 48 px, radius 9: name 12 px / 550 + detail 9 px mono `--picker-secondary`. Selected: `--accent-bg`, `--accent-text`, accent border at 35%. Group options under `.ps-group-title` ("FAVORITES").
- `.ps-starter`: suggestion card (radius 9) with an `.ps-icon-tile` (36 px, radius 10, `--accent-bg`, accent icon), a 13 px / 550 title and an 11 px muted line. Hover: border `#87809e`, `--surface-hover`.
- Lists in panels are separated by 1 px `--line` rules (plans, settings rows), not by gaps between floating cards.
- `.ps-kv`: key and value list (`<dl>`), two columns `1fr auto`, gap `12px 24px`, 12 px; keys `--muted`, values right aligned with tabular numbers. `.ps-kv--framed` puts it in a `--surface` box (padding 20, radius 9, gap 15 px). Studio uses it for versions, system information and counts; use it for machine details (address, version, scopes).
- `.ps-machine-list` + `.ps-machine`: the touch list of Studio's Machines screen (cards of radius 14 with a 38 px icon tile, 15.5 px names). For phones and touch-first pages only; see `multi-instance.md`.

## Floating layers

- `.ps-menu` (popover, 248 px): `--surface-raised`, 1 px `--line`, radius 9, padding 5, `--shadow`. Items: 40 px min (44 px on touch), 12 px `--muted` with a 14 px icon, hover `--surface-hover` + `--text`. Sections: `.ps-menu-divider` (1 px, margin 4), `.ps-menu-label` (11 px faint). Destructive item last, `.is-danger` red text.
- Color choice inside a menu: `.ps-swatches` with 28 px `.ps-swatch` circles (16 px color dot, dashed circle for "default", 1 px `--text` ring when checked).
- `.ps-context-menu` (tab or row menu, 210 px min): `--surface`, radius 7, `--shadow-menu`; items 12 px `--text`, hover `--accent-bg` + `--accent-text`; `hr` separators.
- `.ps-dialog` (use a real `<dialog>` with `showModal()`): 460 px (560 px for pickers), `--surface-raised`, 1 px `--dialog-line`, radius 15, padding 28, `--shadow`, backdrop `#0008` + blur 4 px. Head: `.ps-icon-tile` + `.ps-dialog-title` (19 px / 550, -0.6 px) + `.ps-dialog-desc` (11 to 12 px muted) + close icon button. Actions right aligned, secondary then primary, 9 px gap.
- `.ps-toasts` + `.ps-toast`: bottom right (24 px), `--surface-raised`, radius 10, padding `13px 15px`, 12 px, 15 px icon (green check, red alert for `.is-error`), enters in 0.2 s. One short sentence ending with a period ("Folder color updated.").

## Banners

Full-width strips under the header, 1 px bottom border, 11 to 12 px text, one short sentence + one small button:
- `.ps-banner` (information, update): `--accent-bg` + `--accent-text`.
- `.ps-banner--warning`: amber tint (`color-mix(amber 9%, bg)`), `--text`.
- `.ps-banner--error`: red tint `#bc656512`, `--red`.
- `.ps-banner--quiet`: no fill, muted text, accent icon (read-only access, remote view).

## Progress and numbers

- `.ps-progress`: 4 px bar, radius 3, track `--line`, value `--accent`.
- `.ps-progress-label`: 12 px muted label ("5/12 tasks checked") with a `.ps-stat` (23 px / 500 tabular) at the right.
- Percentages next to labels: 11 px muted tabular ("4/7 · 57%").

## Conversation

- `.ps-thread`: column of max 880 px. `.ps-msg` blocks 30 px apart.
- Head (`.ps-msg-head`): 25 px `.ps-avatar` (radius 7, `--accent-bg` for the agent, `--surface-hover` for the user), 12 px / 550 author, 9 px mono model, 9 px faint time at the right.
- Agent body: 13 px, line height 1.8, indented 34 px, rich text with `.ps-prose`.
- User body (`.ps-msg--user`): `--surface` bubble, 1 px `--line-soft`, radius `3px 12px 12px 12px`, padding `15px 18px`, 12 px, pre-wrapped; the head is mirrored (avatar on the right).
- `.ps-composer-area`: wraps the composer and its hint under the thread: max width 940 px, centered, padding `0 32px 22px` (25/19 px under 1250 px, 28 px bottom from 1600 px, 14/16 px on mobile).
- `.ps-composer`: `--surface`, 1 px `#414047` in both themes (focus `#8f88a9`), radius 13, padding `16px 16px 11px`, faint shadow. 14 px textarea in the classic layout (13 px inside docked panes; line height 22 px, min 51 px), tool buttons (36 px: "/", photo, attachment) at the top right, toolbar under it (model button, separator, bare select, checkboxes) and the send button at the right. Hint line under the composer: 9 px faint "Enter to send · Shift Enter for a new line".
- `.ps-question` (agent question): inline in the thread, aligned with the agent text (34 px indent), never a modal and never a card. 12 px muted label "Agent question", 16 px / 600 question, radio rows (`.ps-question-option`, padding `10px 12px`, radius 8, hover and checked `--surface-hover`), an optional free-text `.ps-question-input` ("Or write another answer…"), then "Send answer" (primary) and "Skip" (secondary) with 18 px between them, and a 12 px muted status line ("The agent is waiting for your answer."). Text inside the question is 14 px.

## Rich text and code

- `.ps-prose`: see typography rules; tables are 11 px with 1 px `--line` cells, padding `9px 12px`, header cells `--surface` / 550.
- `.ps-code`: `--code` background, 1 px `--line`, radius 9, 11 px mono with line height 1.7, top padding 44 px for the `.ps-code-bar` (31 px: language at the left, "Copy" with an 11 px icon at the right, 9 px).
- Inline code: mono 0.9 em on `--surface-hover`, radius 4, padding `2px 5px`.

## Plans and tasks (Roadmap)

- `.ps-plan`: 1 px `--line` on top, padding 17 px 0. With a color: `.has-color` + `--plan-color` (3 px left border, 12 px padding) and a 10 px `.ps-plan-dot`.
- Head: `.ps-plan-title` (14 px / 600 with a "›" disclosure that rotates), `.ps-inline-count` (11 px muted tabular) at the right, `.ps-plan-meta` (11 px muted, indented 18 px) under it.
- `.ps-steps` > `.ps-step`: 16 px native checkbox (accent; green once checked), 13 px text with line height 1.55; `.is-done` = muted text with a faint line-through. Sub-steps indent 22 px.

## Empty states

One icon tile, one short title, one helpful sentence, at most one primary action. Studio's empty conversation shows a large light title (clamp 32 to 45 px, weight 490) and four `.ps-starter` suggestions in a 2 x 2 grid. Keep it calm: no illustration, no emoji.
