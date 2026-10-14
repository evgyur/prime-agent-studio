# Icons and brand

## Icon style

- Studio draws its own line icons: 24 x 24 viewBox, `fill="none"`, `stroke="currentColor"`, `stroke-width="1.5"`, round caps and joins.
- Sizes (measured in Studio): 11 to 13 px for chevrons and small inline buttons, 14 px in tabs and menu items, 15 px in sidebar rows, search, breadcrumb, footer and toasts, 16 to 18 px in icon buttons and header buttons, 17 to 21 px in settings navigation, dialog icon tiles and composer tools.
- Color comes from the text color (`currentColor`): `--muted` at rest, `--text` on hover, `--accent` or `--accent-text` when active. Only folders (project color) and machines (device color) carry a palette color.
- Icons are decorative (`aria-hidden="true"`) when a text label is present. Icon-only buttons need an `aria-label` and a `title`.
- Do not mix in another icon family (Material, Font Awesome, filled emoji). If an icon is missing, draw it in the same style: simple strokes, 1.5 px, no fill, optical size of the others.

## The 56 icons in `assets/icons.js` and `assets/icons.svg`

| Group | Names |
|---|---|
| Actions | `plus`, `folder-plus`, `pencil`, `copy`, `download`, `upload`, `refresh`, `trash`, `archive`, `pin`, `star`, `x`, `stop`, `arrow-up`, `arrow-down`, `arrow-up-right`, `scan`, `image`, `paperclip` |
| Navigation and layout | `menu`, `more`, `grip`, `panel`, `layout`, `chevron`, `search`, `settings`, `bell`, `lock`, `unlock` |
| Objects | `folder`, `chat`, `branch`, `code`, `terminal`, `model`, `brain`, `tool`, `shield`, `map`, `compass`, `user`, `machine`, `monitor`, `bug`, `sparkles` |
| Panel tabs | `conversation`, `roadmap`, `session`, `agents`, `files`, `preferences` |
| Status and theme | `check`, `alert`, `moon`, `sun` |

Meaning of each one is commented in `icons.js` (for example `chevron`: disclosure, rotate 90 degrees when open; `machine`: a PC running Studio; `model`: model picker).

### Use

```html
<!-- 1. Classic script, like Studio (works from file:// too): -->
<button class="ps-icon-btn" aria-label="Refresh" title="Refresh"><span data-icon="refresh"></span></button>
<script src="icons.js"></script>
<script>StudioIcons.mountIcons();</script>

<!-- 2. SVG sprite, no JavaScript (external sprites load over http(s) only, not from file://): -->
<svg class="ps-icon" width="18" height="18" aria-hidden="true"><use href="icons.svg#ps-i-refresh"/></svg>
```

```js
// 3. ES modules and bundlers (React, Vue, Svelte...):
import { iconSvg, mountIcons, markSvg } from './icons.esm.js';
```

Opened on its own (browser, file preview), `icons.svg` shows a preview sheet of the 56 icons with their names. To paste the sprite inside a page instead of linking it, copy only its `<symbol>` elements into a hidden `<svg>`.

`iconSvg(name, { size, className, title })` returns the markup as a string for frameworks; `data-size` sets the size of a `data-icon` element.

## Brand

- Studio's lock-up: a 36 px lavender tile (`--accent`, radius 10) holding the "P" mark in `#292737`, the lowercase wordmark "prime" (26 px / 650, -1.1 px), the sub "Agent Studio" (8 px, 1.6 px tracking, uppercase through `.ps-brand-sub`) and a "Local" tag (uppercase through `.ps-tag`). Files: `assets/prime-agent-studio-logo.svg`, `MARK_PATH` and `markSvg()` in `icons.js`.
- Your app has its own name. Reuse the lock-up pattern (tile, lowercase wordmark, small uppercase sub) with your own glyph and name, in the same sizes and colors. `.ps-brand-mark svg` is 30 px (a mark drawn on a 32 px grid, like Studio's); for a 24 px line icon as glyph, set it to 24 px and keep the `#292737` ink.
- Use the Studio mark only to represent Studio itself (for example "Open in Studio" next to a machine), never as the logo of another product.
- No mascot, no gradient logo, no emoji in the interface.
