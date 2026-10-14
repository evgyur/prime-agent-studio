# Layout

Studio is an app shell, not a page: the window is divided into fixed regions, each region scrolls on its own, and the document never scrolls.
See `references/screenshots/studio-dark-workspace.png` and `studio-qhd-multi-pane.jpg`.

## App shell

```
+--------------+----------------------------------------------------------------+
| SIDEBAR      | HEADER  67 px  (breadcrumb ............ pill buttons, icons)   |
| 272 px       +-----------------------------------+----------------------------+
| --sidebar    | TAB BAR 35 px (--sidebar)         | TAB BAR 35 px              |
|              +-----------------------------------+----------------------------+
| brand 88 px  | PANE (--bg)                       | PANE (--bg)                |
| actions      |  scrolls on its own               |  tool panel, about 373 px  |
| search       |                                   |  at 1440 px                |
| WORKSPACE    |  composer at the bottom           |                            |
| tree         |                                   |                            |
| footer       |                                   |                            |
+--------------+-----------------------------------+----------------------------+
```

- `.ps-app`: `display: flex; height: 100dvh; overflow: hidden`.
- Sidebar: `--sidebar` background, `1px solid var(--line-soft)` on the right edge. Widths: 245 px under 1250 px, 272 px by default, 286 px from 1600 px.
- Header: 67 px, padding `0 27px` (35 px from 1600 px), bottom border `--line-soft`, breadcrumb on the left, actions on the right with 8 px gaps.
- Panes: `--bg`, separated by 1 px `--line` splitters that turn `--accent` on hover. Each pane starts with a 35 px tab bar on `--sidebar`.
- Detail column (when not docked): 276 px (235 / 300 px at the width steps).
- Nothing floats over the shell except menus, dialogs, toasts and the mobile drawer.

## Sidebar anatomy (top to bottom)

| Part | Values |
|---|---|
| Brand | height 88 px, padding `0 23px`, gap 11 px: mark 36 px (radius 10, `--accent` fill, `#292737` glyph), wordmark 26/650, sub 8 px tracking 1.6 px, tag pill pushed right |
| Actions | padding `0 16px 26px`: one tinted primary action (`.ps-btn--tinted`, 42 px high, kbd hint right), optional quiet outline action under it (8 px gap) |
| Search | 16 px under the actions: 15 px icon, borderless 11 px input, kbd hint right; the icon turns `--accent` on focus |
| Section heading | 28 px high, padding `0 21px 8px`: uppercase 10 px label left, two 23 px icon buttons right |
| Tree | scroll area, padding `0 10px 20px`. Group label (11 px, margin `16px 12px 7px`), project head 36 to 38 px (22 px disclosure + row), children indented 33 px, rows 38 px with 2 px gaps, 6 px after each project |
| Footer | top border `--line-soft`, padding `17px 20px 14px`: status line (5 px green dot, 10 px text, mono version right), then 12 px navigation links with 15 px icons |

## Panels

- Tab bar: 35 px, `--sidebar` background, bottom border `--line`. Tabs: 11 px, padding `10px 13px 9px`, 14 px icon, gap 7 px, max width 240 px.
  Active tab: `--bg` background (it merges with the pane) and a 2 px `--accent` line at the top, inset 12 px on both sides.
  The right end holds 26 px "⋯" and "×" chrome buttons. A lockable tool tab reserves 38 px on the right for its lock.
- Panel content padding: 18 px (docked) or 24 px (full-height overlay panel). A panel opens with a title (15 px / 600), a muted 13 px subtitle (the project), then its controls.
- Panel sections are separated by 1 px `--line` rules, not by cards. Cards are for repeated items (agents, machines, suggestions).

## Spacing

Studio uses an 8 px rhythm with optical adjustments. The values that come back everywhere:

- 2 to 3 px: gaps between stacked rows, tab gaps.
- 5 to 7 px: icon to label in small controls, padding inside menus (5 px).
- 8 to 10 px: gaps in toolbars and button groups (8, 9, 10).
- 11 to 13 px: control padding (buttons `9px 13px`, cards 13 px, rows `8px 5px` / `9px 10px`).
- 14 to 18 px: card and panel padding, section gaps.
- 24 to 28 px: dialog padding (28 px), header side padding (27 px), large section gaps (24 to 30 px).

Do not use 32/48/64 px marketing spacing inside the app. Density is part of the identity.

## Content widths

| Element | Max width |
|---|---|
| Message column | 880 px, padding `31px 39px 40px` |
| Composer area | 940 px, padding `0 32px 22px` |
| Welcome hero | 830 px |
| Dialog | 460 px (pickers 560 px), `max-width: calc(100vw - 32px)` |
| Popover menu | 248 px |
| Toast | 390 px |
| Machine list (mobile) | 520 px |

## Breakpoints

| Width | Studio behavior |
|---|---|
| >= 1600 px | Wider sidebar (286 px) and detail column (300 px), header padding 35 px. |
| <= 1250 px | Narrower sidebar (245 px), wordmark 24 px. |
| <= 1080 px | The docked multi-pane workspace switches to the classic single conversation layout. |
| <= 760 px | Mobile: the sidebar becomes a drawer (`translateX(-100%)`, backdrop `#0008` + blur 2 px), the header wraps on two rows (menu + breadcrumb, then actions), rows go 13 px. |
| <= 400 px | Tighter paddings. |

Panels also use container queries (640 px, 700 px) to stack their own content when they are narrow. Prefer container queries for components that live in resizable panes.

## Mobile and touch

- Touch targets: 44 px minimum for rows, menu items and icon buttons (`pointer: coarse`).
- Keep the desktop colors and type; only the structure changes (drawer, two-row header, full-height panels).
- Respect safe areas: `env(safe-area-inset-*)` on the shell and the drawer.
- A list of machines on a phone uses cards of the full width (max 520 px), see `references/multi-instance.md`.
