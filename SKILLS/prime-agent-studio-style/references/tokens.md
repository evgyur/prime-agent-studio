# Tokens

Exact values of Prime Agent Studio 4.3. They are the CSS custom properties of `assets/studio.css`, with Studio's own names.
Never invent a new gray, blue or purple: pick the token whose role matches.

## Surfaces: from back to front

| Token | Dark | Light | Role |
|---|---|---|---|
| `--sidebar` | `#151618` | `#f1f0ec` | Sidebar, tab bars of panels, settings navigation. The deepest layer. |
| `--bg` | `#1b1c1e` | `#faf9f6` | App background, panel content, inputs placed inside dialogs. |
| `--surface` | `#222326` | `#fff` | Cards, composer, user message bubbles, hover of sidebar rows, header pill buttons. |
| `--surface-raised` | `#26272b` | `#fff` | Floating layers only: popover menus, dialogs, toasts. |
| `--surface-hover` | `#2b2c30` | `#eae9e5` | Hover of buttons, options and tabs; inline code background; user avatar tile. |
| `--code` | `#161719` | `#f0f0ed` | Code blocks. |

Depth comes from these steps plus 1 px lines. Shadows are reserved for floating layers.

## Lines

| Token | Dark | Light | Role |
|---|---|---|---|
| `--line` | `#303135` | `#deded8` | Default 1 px border, dividers, splitters, progress track, scrollbar thumb. |
| `--line-soft` | `#28292d` | `#e9e8e2` | Structural separators: sidebar edge, header bottom, sidebar footer, code bar. |
| `--composer-line` | `#414047` | `#414047` | Composer frame (Studio keeps this value in both themes). Focus: `#8f88a9`. |
| `--dialog-line` | `#77717f66` | `#77717f66` | Dialog border. |
| `--tinted-line` | `#79738e45` | `#79738e45` | Border of the tinted "New session" button. |

## Text

| Token | Dark | Light | Role | Contrast on `--bg` |
|---|---|---|---|---|
| `--text` | `#ededea` | `#28282e` | Primary text, titles, active items. | 14.54 / 13.92 |
| `--muted` | `#96979d` | `#6e707b` | Secondary text, idle controls, descriptions. | 5.86 / 4.67 |
| `--faint` | `#777983` | `#797b84` | Metadata only: counts, timestamps, kbd hints, separators. | 3.94 / 4.01 |
| `--picker-secondary` | `#9a9ba1` | `#656771` | Secondary text inside pickers and dialogs (model ids, group titles). | 5.38 / 5.63 (on raised) |

`--faint` is about 4:1. Never put information that matters only in `--faint`.

## Accent (lavender)

| Token | Dark | Light | Role |
|---|---|---|---|
| `--accent` | `#b7b2e7` | `#7771b2` | Primary button fill, focus ring, active tab indicator, progress value, checked switch, splitter hover, accent numbers ("42 %"). |
| `--accent-strong` | `#cbc7f3` | `#635b9f` | Hover of accent fills. |
| `--accent-bg` | `#302e40` | `#eae7f6` | Selected row, active settings item, active segmented option, tinted button, icon tiles, avatars. |
| `--accent-text` | `#d4d0f4` | `#5f568f` | Text on `--accent-bg`, links, "working" status. |
| `--accent-ink` | `#252132` | `#252132` | Text and icons on an `--accent` fill (Studio uses #24222f to #262337). |

Contrast: accent text on accent background 8.88:1 (dark) and 5.37:1 (light); ink on accent 7.85:1 (dark) and 3.57:1 (light).
The light primary button is below 4.5:1 in Studio itself. If your app needs strict WCAG AA there, keep the fill and use `--accent-strong` (`#635b9f`) as the button background in light theme with white text. Say so in your report; it is a deliberate deviation.

The accent is rare on purpose. One primary button per view, one selected row per list, one active indicator per tab bar.

## Status colors

| Token | Dark | Light | Meaning | Typical use |
|---|---|---|---|---|
| `--green` | `#96bca5` | `#4f8568` | Running, connected, success. | Running dot (pulses), "Engine connected", success toast icon, checked task box. |
| `--blue` | `#88b6f6` | `#286ac4` | Unread, new information. | Unread dot. |
| `--amber` | `#dab982` | `#947036` | Warning, attention, held by someone else. | Warning banner tint, "other owner" dot. |
| `--red` | `#e8a2a2` | `#ae4f50` | Error, destructive. | Danger menu items, danger button fill, error toast icon, failed status. |

Priority when several states apply to one item: question pending, then running (green), then unread (blue).
Inspector statuses: working `--accent-text`, completed `#9fc7b0`, failed `#e7a3a3` (dark).

## Palettes (vivid, identical in both themes)

Each palette has a default (transparent) choice first, then five colors.

| Palette | Colors | Used for |
|---|---|---|
| Projects | `#3b82f6` blue, `#16a34a` green, `#d97706` amber, `#dc2626` red, `#8b5cf6` violet | Folder icon fill and stroke, project pin, tab icons of that project. |
| Plans | `#0d9488` teal, `#db2777` pink, `#4f46e5` indigo, `#65a30d` lime, `#ea580c` orange | 3 px left border and 10 px dot of a roadmap plan. |
| Devices (PCs) | `#0891b2` cyan, `#ca8a04` yellow, `#c026d3` fuchsia, `#64748b` slate, `#92400e` brown | Color of a machine; monitor "origin" icon in that color. |

Palette colors mark identity, never state. A red project folder does not mean an error.

## Command chips

| Kind | Dark bg / line / text | Light bg / line / text |
|---|---|---|
| Command (blue) | `#26354b` / `#425d80` / `#afd2ff` | `#e8f1fc` / `#adc5e4` / `#24578e` |
| Skill (purple) | `#39304e` / `#695185` / `#dbccff` | `#f0e8fa` / `#cab4e4` / `#694298` |
| Prompt (green) | `#233e34` / `#426b59` / `#b0e1ca` | `#e6f4ed` / `#aed2bf` / `#2a654e` |

## Effects

| Token | Value | Use |
|---|---|---|
| `--shadow` | `0 20px 70px #0005` (light `#1c1c2820`) | Popover menus, dialogs, toasts, mobile drawer. |
| `--shadow-menu` | `0 8px 30px #0003` | Small context menus (tab menu). |
| `--shadow-composer` | `0 4px 16px #00000008` | Composer only. |
| `--backdrop` | `#0008` + `backdrop-filter: blur(4px)` | Behind dialogs (blur 2 px behind the mobile drawer). |
| Focus | `outline: 2px solid var(--accent); outline-offset: 3px` | Every focusable element by default (`-2px` offset inside tab bars and on splitters, `2px` on color swatches). See "Focus" below for the framed fields. |
| Selection | `--accent-bg` background, `--text` color | `::selection`. |
| Scrollbar | 6 px, thumb `--line`, radius 4 px, hover `--faint` | All scroll areas. |

No gradients, no glass panels, no glows, no colored shadows. The only blur is the dialog backdrop.

## Focus

Focus is always visible, but it is drawn where the person looks:

| Element | Focus style in Studio |
|---|---|
| Buttons, links, selects, checkboxes, summaries, standalone inputs | 2 px `--accent` outline, offset 3 px (the global rule of `studio.css`). |
| Tabs, splitter, lock button | Same outline with offset -2 px (drawn inside). |
| Composer | The textarea has no outline; the composer frame turns `--composer-line-focus` (`#8f88a9`). |
| Sidebar search | The input has no outline; the icon and the text turn `--accent` (`:focus-within`). |
| Framed search box, fields inside dialogs | Border `--accent` plus a 2 px ring of the accent at 17 to 18%. |
| Tab context menu items | Background `--accent-bg` and text `--accent-text`, no outline. |

Never remove an outline without one of these replacements.

## Radii

| Token | Value | Used by |
|---|---|---|
| `--r-xs` | 4 px | kbd, tag pill, chrome buttons, context menu items, inline code |
| `--r-sm` | 6 px | Sidebar project rows, banner buttons |
| `--r-control` | 7 px | Buttons, inputs, conversation rows, menu items, settings items |
| `--r-pill-button` | 8 px | Header pill buttons, send button, pill tabs |
| `--r-menu` | 9 px | Popover menus, options, framed search, code blocks, starter cards, select |
| `--r-md` | 10 px | Toasts, segmented control, brand mark, icon tiles |
| `--r-card` | 12 px | Cards (activity card uses 11 px) |
| `--r-composer` | 13 px | Composer |
| `--r-dialog` | 15 px | Dialogs |
| `--r-full` | 999 px | Rounded badges |

User message bubble: `3px 12px 12px 12px` (the corner near the avatar stays sharp).

## Layers (z-index)

Roadmap overlay 45, mobile backdrop 45, mobile drawer 50, popover menu 80, toasts 100, tab context menu 160.

## Motion

- `transition: background 0.15s, color 0.15s, border-color 0.15s, opacity 0.15s` on buttons; `0.15s` on switches and borders.
- Toast enter: `0.2s ease-out`, from `translateY(8px)` and transparent.
- Running dot: `opacity` pulse to 0.4, `1.7s ease-in-out infinite`.
- Mobile drawer: `transform 0.2s`.
- `prefers-reduced-motion: reduce` sets every duration to `0.01ms`. Keep that rule.
- Never animate layout size, never bounce, never slide large panels in the desktop layout.

## Using the tokens in a framework

`studio.css` is plain CSS: import it once at the root of any framework and keep the `ps-` classes.

### Tailwind CSS v4

Import `studio.css` without a layer so its tokens win over Tailwind's defaults, expose the tokens as utilities, and remove the default palette so nobody reaches for `zinc-900` or `indigo-500`:

```css
@import "tailwindcss";
@import "./studio.css";

@theme inline {
  --color-*: initial;              /* no default Tailwind colors */
  --color-transparent: transparent;
  --color-current: currentColor;
  --color-app: var(--bg);
  --color-sidebar: var(--sidebar);
  --color-surface: var(--surface);
  --color-raised: var(--surface-raised);
  --color-hover: var(--surface-hover);
  --color-code: var(--code);
  --color-line: var(--line);
  --color-line-soft: var(--line-soft);
  --color-fg: var(--text);
  --color-muted: var(--muted);
  --color-faint: var(--faint);
  --color-accent: var(--accent);
  --color-accent-strong: var(--accent-strong);
  --color-accent-bg: var(--accent-bg);
  --color-accent-text: var(--accent-text);
  --color-accent-ink: var(--accent-ink);
  --color-ok: var(--green);
  --color-info: var(--blue);
  --color-warn: var(--amber);
  --color-danger: var(--red);
  --radius-control: 7px;
  --radius-menu: 9px;
  --radius-card: 12px;
  --radius-dialog: 15px;
  --text-caption: 10px;
  --text-meta: 11px;
  --text-ui: 12px;
  --text-read: 13px;
  --font-sans: 'Segoe UI Variable Text', 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono: 'Cascadia Code', 'SFMono-Regular', Consolas, monospace;
}
```

Then write `bg-surface border border-line rounded-card text-ui text-fg`, `hover:bg-hover`, `text-muted`, `bg-accent text-accent-ink`.
`font-sans` and `font-mono` now give Studio's stacks, and `studio.css` already sets `html` to 14 px with `--font-ui`.

### Component libraries

If a library is required (shadcn/ui, Radix themes, MUI, Vuetify...), set its theme variables from the tokens: background `--bg`, card `--surface`, popover `--surface-raised`, border `--line`, foreground `--text`, muted foreground `--muted`, primary `--accent` with `--accent-ink` text, ring `--accent`, destructive `--red`, radius 7 px, base font size 12 px. Then compare with the screenshots; default library spacing is usually too loose for Studio.
