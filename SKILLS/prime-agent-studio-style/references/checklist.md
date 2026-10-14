# Review checklist

Run this list before you deliver a screen. Render it at 1440 x 900 in dark and light, and at 390 x 844, then compare with `references/screenshots/`.

## Color
- [ ] Every color is a token from `studio.css` (search the code for `#` and `rgb(`: only token definitions, palettes and documented one-offs may contain literals).
- [ ] Dark theme is the default; light theme works through `data-theme="light"` and was checked visually.
- [ ] The accent appears only on: at most one accent-filled button per pane or dialog, focus rings, the active tab line, the selected row, progress values, checked controls, accent numbers. The sidebar may add one tinted creation action.
- [ ] Status colors (green, blue, amber, red) only mean status. Palette colors (projects, plans, machines) only mean identity.
- [ ] No gradient, glow, glass effect or colored shadow. The app background is never pure black or pure white (white is only the light theme surface).

## Type
- [ ] Root 14 px, UI text 12 px, reading text 13 px with line height 1.8, metadata 10 to 11 px.
- [ ] Font stacks are exactly `--font-ui` and `--font-mono`; no web font was added.
- [ ] Weights are among 400, 500, 550, 600, 650 (700 only for card titles).
- [ ] Sentence case everywhere; uppercase only through the section label, group title and tag styles.
- [ ] Counts, percentages and timers use tabular numbers.

## Layout and components
- [ ] The app is a shell: sidebar 272 px on `--sidebar`, 67 px header, panes with 35 px tab bars; the page itself does not scroll.
- [ ] Components come from `studio.css` (`ps-` classes) and keep their markup. New components are built from tokens, 1 px lines and the radius scale.
- [ ] Surfaces are flat. Shadows only on menus, dialogs and toasts (and the faint composer shadow).
- [ ] Radii follow the scale: 7 px controls, 9 px menus, 12 px cards, 15 px dialogs; no pill buttons.
- [ ] Spacing is dense (rows 38 px, controls about 32 to 40 px); no marketing-size spacing inside the app.
- [ ] Long names truncate with an ellipsis; nothing overflows its row or tab.

## Icons
- [ ] Only the line icons of `icons.js` / `icons.svg` (or new icons drawn in the same 1.5 px style).
- [ ] Icon-only buttons have `aria-label` and `title`.

## Words
- [ ] Labels are short verbs or nouns in sentence case, without final period. Sentences end with a period.
- [ ] No em dash. Separators are " · ", "/" in breadcrumbs, and "…" for work in progress.
- [ ] Errors say what happened, then what to do. Toasts are one sentence in the past tense.
- [ ] Product names and technical terms are exact (Studio, Roadmap, Computer Use, branch, token, run).

## Behavior and accessibility
- [ ] Every focusable element shows a visible focus: the 2 px accent outline by default, or the frame style listed in `tokens.md` (Focus) for the composer, search fields, dialog fields and context menus.
- [ ] `prefers-reduced-motion` disables animations; transitions stay at 0.15 s otherwise.
- [ ] Touch: 44 px targets with `pointer: coarse`; the sidebar becomes a drawer at 760 px.
- [ ] Dialogs use `<dialog>` with a backdrop, close on Escape, and return focus.
- [ ] Multi-instance apps: the machine is always visible next to a project, tokens are never displayed in full, failures are shown and never retried silently (see `multi-instance.md`).
