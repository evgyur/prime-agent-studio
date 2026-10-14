---
name: prime-agent-studio-style
description: Build or restyle a user interface so it looks, feels and reads like Prime Agent Studio, the desktop app for the Prime Agent coding agent. Gives the exact dark and light color tokens, the Segoe UI Variable and Cascadia Code type scale, the dense app shell, ready components (sidebar tree, IDE tabs, buttons, inputs, menus, dialogs, toasts, composer, agent questions, Roadmap plans), 56 line icons, interface copy rules and reference screenshots, plus patterns for apps that drive several Studio instances through the Studio public API v1. Use when building a companion app, dashboard, controller, extension or page that must match Studio, or when asked for the "Prime Agent Studio style", "Studio design system", "charte graphique Studio", "style Prime Agent Studio" or "même style que Studio".
license: MIT, see LICENSE.txt
metadata:
  source: Prime Agent Studio 4.3.2
  author: zerr0o
---

# Prime Agent Studio style

Make the app look like one more screen of Prime Agent Studio: a calm, dense, dark-first professional cockpit with a rare lavender accent.
Every value in this skill was measured in Studio 4.3.2 (stylesheets and computed styles of the running app). Use the values as they are; do not approximate them.

## Quick start

1. Copy `assets/studio.css`, `assets/icons.js` (plus `assets/icons.esm.js` for ES modules and bundlers, or the sprite `assets/icons.svg`) and `assets/theme.js` into the project.
2. Load them:
   ```html
   <html lang="en" data-theme="dark">
   <head>
     <script src="theme.js"></script>              <!-- dark by default; stored choice or ?theme=light|system -->
     <link rel="stylesheet" href="studio.css">
   </head>
   <body> ... <script src="icons.js"></script><script>StudioIcons.mountIcons();</script></body>
   ```
3. Open `assets/example-shell.html` (a complete workspace) and `assets/components.html` (every component) in a browser; they also work straight from disk. Add `?theme=light` for the light theme. This is the target.
4. Build the screens by copying markup from these two files and composing the `ps-` classes. Style anything new with the tokens only.
5. Write the interface text with `references/writing.md`. Finish with `references/checklist.md` and a side-by-side comparison with `references/screenshots/`.

Frameworks: import `studio.css` once at the root, keep the class names (React: `className`) and take the icons from `icons.esm.js` (`import { iconSvg } from './icons.esm.js'`). With Tailwind CSS or a component library, map the tokens as shown at the end of `references/tokens.md`; never keep a library's default colors, radii or font sizes.

## Read next (only what the task needs)

| Need | File |
|---|---|
| Colors, lines, shadows, radii, layers, motion | `references/tokens.md` |
| Fonts, sizes, weights, numbers | `references/typography.md` |
| App shell, sidebar, panels, spacing, breakpoints | `references/layout.md` |
| Component recipes (buttons to Roadmap plans) | `references/components.md` |
| Labels, messages, status words, French and English | `references/writing.md` |
| Icons and brand | `references/icons-and-brand.md` |
| An app that drives one or several Studios through the API | `references/multi-instance.md` |
| Final review | `references/checklist.md` |
| Target images of the real app | `references/screenshots/` |

## The Studio look in 12 rules

1. **Dark first.** Dark is the default theme; light is a full equivalent through `data-theme="light"`.
2. **Tokens only.** Use Studio's variables (`--bg`, `--surface`, `--line`, `--text`, `--muted`, `--accent`...). Never add a new gray or purple.
3. **Flat layers.** Depth goes `--sidebar` < `--bg` < `--surface` < `--surface-raised`, separated by 1 px lines. Shadows exist only on floating layers (menus, dialogs, toasts), plus the very faint `--shadow-composer` under the composer.
4. **Rare lavender accent.** `--accent` marks the one primary action, focus, the active tab line, the selection, progress and checked controls. Selected rows use `--accent-bg` with `--accent-text`.
5. **Small, exact type.** Root 14 px, UI text 12 px, reading text 13 px with line height 1.8, metadata 10 to 11 px. System fonts only: Segoe UI Variable Text and Cascadia Code stacks.
6. **Dense.** 38 px rows, 32 to 40 px controls, an 8 px rhythm, 67 px header, 35 px tab bars, 272 px sidebar.
7. **Measured radii.** 7 px controls, 9 px menus, 12 px cards, 15 px dialogs. No pill-shaped buttons.
8. **Status is small.** A 6 px dot and a short word (green running, blue unread, amber attention, red error). Identity colors (projects, plans, machines) only tint an icon, a dot or a 3 px border.
9. **Line icons.** 24 px grid, 1.5 px stroke, `currentColor`, from `assets/icons.js`.
10. **Quiet motion.** 0.15 s color transitions, 0.2 s toast entrance, a slow pulse on running dots, nothing that bounces or slides on desktop. Respect `prefers-reduced-motion`.
11. **Plain words.** Sentence case, short labels, exact technical terms, " · " as separator, no em dash, no exclamation mark, no emoji.
12. **Explicit actions.** At most one accent-filled button per pane or dialog (`.ps-btn--primary`, or the send button of a composer). The sidebar may also hold one tinted creation action (`.ps-btn--tinted`, like "New session"). Destructive or costly actions name their effect ("Stop server and quit") and ask for confirmation.

## Common drift to avoid

- A generic SaaS look: big hero sections, 16 px body text, gradient buttons, rounded-full pills, floating cards with large shadows.
- Pure black backgrounds, a blue default accent, Tailwind default grays (zinc, slate, neutral) or a web font such as Inter.
- Title Case or UPPERCASE buttons, emoji, illustrations, playful copy.
- Filled colored status pills. Studio shows status with a dot and a word.
- Hex values that are "close" to a token. Use the token.

## Faithful or stricter accessibility

The skill reproduces Studio as it is, including two known contrast limits: `--faint` text is about 4:1 (metadata only), and the light-theme primary button is 3.57:1. If your app must meet WCAG AA everywhere, apply the override documented in `references/tokens.md` and mention it in your delivery notes.

## Files

```
prime-agent-studio-style/
  SKILL.md                     this file
  LICENSE.txt                  MIT, (c) 2026 zerr0o
  assets/studio.css            tokens (dark and light) + all components, ps- prefix
  assets/icons.js              56 icons as a classic script: window.StudioIcons = { ICONS, iconSvg, mountIcons, markSvg }
  assets/icons.esm.js          the same API as ES module exports
  assets/icons.svg             the same icons as an SVG sprite (ids ps-i-<name>), with a preview sheet
  assets/theme.js              dark, light or system, like Studio
  assets/prime-agent-studio-logo.svg
  assets/example-shell.html    complete workspace (sidebar, header, tabs, thread, composer, Roadmap)
  assets/components.html       gallery of every component
  references/*.md              details, loaded on demand
  references/screenshots/      real Studio captures (dark, light, dialogs, menus, mobile, QHD)
```

Provenance: extracted from Prime Agent Studio 4.3.2 (MIT, (c) 2026 zerr0o): `public/*.css`, computed styles of the app at 1440 x 900 and 390 x 844, its icons and its translation table. Segoe UI is a Microsoft system font and is not included.
