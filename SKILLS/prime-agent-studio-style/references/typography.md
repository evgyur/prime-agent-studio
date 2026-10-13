# Typography

## Fonts

```css
--font-ui:   'Segoe UI Variable Text', 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif;
--font-mono: 'Cascadia Code', 'SFMono-Regular', Consolas, monospace;
html { font-family: var(--font-ui); font-size: 14px; font-synthesis: none; }
```

- Studio is a Windows-first app: on Windows 11 the UI renders in **Segoe UI Variable Text**, whose variable weights give the 550 and 650 steps used everywhere. On macOS and Linux the stack falls back to the system font; keep the same sizes and weights.
- Use system fonts only. Do not add Inter, Roboto, Geist or any web font, and never ship Segoe UI files (Microsoft license). Cascadia Code is open source (SIL OFL) and may be bundled if your app runs where it is missing.
- `font-synthesis: none` keeps the browser from faking bold or italic.
- Titles use the same family as body text. There is no display or serif face.

## Type scale (as rendered at 1440 px, root 14 px)

| Role | Size | Weight | Tracking | Line height | Color | Studio examples |
|---|---|---|---|---|---|---|
| Wordmark | 26 px | 650 | -1.1 px | 1 | `--text` | "prime" in the sidebar |
| Welcome title | clamp(32 px, 3.1vw, 45 px) | 490 | -1.6 px | 1.18 | `--text` | Empty conversation hero |
| Big number | 23 px | 500 | 0 | normal | `--text` | Roadmap "42%"; always tabular |
| Markdown h1 | 22 px | 600 | -0.5 px | 1.4 | `--text` | Agent answers |
| Settings section | 20 px | 550 | -0.5 px | 1.4 | `--text` | "Appearance" |
| Dialog title | 19 px | 550 | -0.6 px | 1.3 | `--text` | "Choose a model", "Preferences" |
| Markdown h2 | 18 px | 600 | 0 | 1.4 | `--text` | Agent answer headings |
| Panel title | 15 px | 600 | 0 | normal | `--text` | "Roadmap" in a docked panel |
| Heading | 14 px | 600 | 0 | 1.5 | `--text` | Plan names, "Project direction", milestone |
| Body (reading) | 13 px | 400 | 0 | 1.8 | `--text` | Agent messages, panel descriptions |
| Card title | 13 px | 700 | 0 | 1.5 | `--text` | Agent card name |
| Activity label | 13 px | 550 | 0 | normal | `--text` | "Agent activity" |
| UI (default) | 12 px | 400 | 0 | 1.4 | `--muted` or `--text` | Sidebar rows, menu items, user bubble, inputs, selects |
| UI strong | 12 px | 550 | 0 | normal | `--text` | Author names, option names, tinted button label |
| Button | 12 px | 500 | 0 | normal | per variant | Primary and secondary buttons |
| Meta | 11 px | 400 | 0 | 1.5 | `--muted` | Tab labels, activity counts, settings descriptions, header pill "Computer Use" |
| Group label | 11 px | 550 | 0 | 1.5 | `--faint` | "Pinned", "Projects" |
| Caption | 10 px | 400 | 0 | normal | `--faint` | Row counts, timestamps, "Engine connected", versions |
| Section label | 10 px | 650 | 1.2 px | normal | `--faint` | "WORKSPACE" (uppercase) |
| Micro | 9 px | 400 | 0 | normal | `--faint` or `--picker-secondary` | Message time, provider under a model name, composer hint, kbd |
| Group title | 9 px | 650 | 1 px | normal | `--picker-secondary` | "FAVORITES" in pickers (uppercase) |
| Brand sub and tag | 8 px | 550 / 600 | 1.6 px / 1 px | normal | `--muted` | "AGENT STUDIO", "LOCAL" |
| Code block | 11 px mono | 400 | 0 | 1.7 | `--text` | Code in answers |
| Inline code | 0.9 em mono | 400 | 0 | inherit | `--text` on `--surface-hover` | `429` |
| Ids and paths | 9 to 10 px mono | 400 | 0 | normal | `--picker-secondary` or `--faint` | `openai-codex/gpt-6-astra`, `v0.9.8` |

12 px is the workhorse. 13 px is for reading. 14 px is the root and the heading size. Anything above 15 px is a title or a number.

## Rules

1. **Small and dense on purpose.** Studio is a professional cockpit. Do not scale the UI up to "make it readable"; keep 12 px rows and 11 px metadata, and give reading text 13 px with line height 1.8.
2. **Sentence case everywhere** ("New session", "Add a plan", "Project knowledge"). Uppercase only for the two micro label styles (section label, group title) and the tag pill, always with letter spacing.
3. **Weights are 400, 500, 550, 600, 650.** 700 appears only on card titles. Never use 300 or 800+.
4. **Negative tracking only on large text** (wordmark -1.1 px, dialog titles -0.6 px, welcome -1.6 px). Body text keeps normal tracking.
5. **Numbers**: `font-variant-numeric: tabular-nums` for counts, percentages, progress and timers. Accent color for a number inside a button ("Roadmap 42 %").
6. **Monospace** for code, model ids, versions, Git branches in code contexts, addresses, file status letters. Never for labels or titles.
7. **One line, then ellipsis** for names in rows, tabs and breadcrumbs: `overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0`.
8. **Reading width**: messages sit in a column of max 880 px (padding 31 px 39 px); the composer is max 940 px wide.
9. **Hierarchy by weight and color, not size.** A row label is 12 px `--muted`; its active state is 12 px `--text` or `--accent-text` on `--accent-bg`, not bigger.
10. **Paragraph rhythm** in rich text: `p` margin bottom 13 px; headings margin 25 px 0 12 px; lists indent 23 px; blockquote 2 px accent left border.

## Responsive type

- At 760 px and below: sidebar rows and settings items go to 13 px, the composer input to 14 px, headers wrap on two rows.
- On touch screens (`pointer: coarse`): keep the font sizes, but make every tappable row and icon button at least 44 px high, and set search inputs to 16 px to avoid zoom on iOS.
- At 1250 px and below Studio narrows the sidebar (245 px) and the wordmark (24 px); at 1600 px and above it widens the sidebar (286 px).
