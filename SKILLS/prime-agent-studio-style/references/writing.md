# Writing for the interface

Studio talks like a calm senior colleague: short, exact, never cute. The interface is bilingual (French and English) and every string lives in one translation table.

## Voice

- **Plain and factual.** Say what is there and what will happen. No hype ("amazing", "magic"), no apology loops, no exclamation marks.
- **Second person, active verbs.** "Choose the Studio to open." "Search for a model or pin your favorite models to the top of the list."
- **Short.** A label is 1 to 3 words. A help line is one sentence. A dialog description is at most two sentences.
- **Professional vocabulary.** Keep real technical terms: branch, commit, diff, fetch, pull, push, fast-forward, token, API, model, provider, run, session, roadmap. Explain them if needed; never replace them with vague words.
- **Calm about errors.** Say what failed and what to do next, in that order: "The server could not start. Retry from this window."

## Casing and punctuation

- Sentence case for every button, tab, title and menu item: "New session", "Add a plan", "Project knowledge", "Close others". Proper names keep their capitals: Prime Agent, Studio, Roadmap, Computer Use, Tailscale, Cloudflare R2.
- Write every string in sentence case, even the ones displayed in capitals. Uppercase comes from CSS on the micro styles only: section label, group title, tag pill and brand sub (`.ps-section-label`, `.ps-group-title`, `.ps-tag`, `.ps-brand-sub`). Studio itself sometimes types these few labels in capitals; letting CSS do it keeps translations and screen readers clean.
- Buttons, labels and titles have no final period. Sentences (help, toasts, errors, descriptions) end with a period.
- **No em dash** (the long dash). Use a period, a comma, a colon or parentheses. Ranges use "to" ("2 to 5 s").
- Metadata separator: the middle dot with spaces, " · " ("2 tool calls · 1 reflection", "Tailscale HTTPS · laptop.tail4c2a.ts.net", "4/7 · 57%").
- Breadcrumb separator: "/" between project and page.
- In-progress text ends with an ellipsis character: "Restarting the server…", "Waiting for the result…".
- Keyboard hints in a kbd: "Ctrl N", "Ctrl K" (no plus). In sentences: "Ctrl + Enter", "Shift Enter for a new line".
- French: no-break space before `: ; ? !` and before `%`; French quotes « » with no-break spaces.

## Labels

| Element | Pattern | Studio examples |
|---|---|---|
| Primary action | Verb + object | "New session", "Add a plan", "Install and relaunch", "Scan a QR code" |
| Secondary action | Verb (+ object) | "Cancel", "Refresh", "Copy path", "Open folder" |
| Destructive action | Explicit verb + object | "Remove from Studio", "Delete", "Forget", "Stop server and quit" |
| Tabs and panels | Noun | "Roadmap", "Session", "Agents", "Files", "Preferences" |
| Toggles and checkboxes | What is allowed | "Allow questions", "Allow Computer Use", "Enter to send" |
| Section titles | Noun phrase | "Appearance", "Models & agents", "Remote access", "Project direction" |
| Placeholders | A real question or example | "What would you like to build?", "Search sessions", "Commit message..." |

## Status words

Use these exact words, in this tone: "Working", "Running", "Running a tool", "Waiting", "Waiting for subagents", "Queued", "Done", "Ready", "Stopped", "History", "Engine connected", "Turn ended".
Pair a status word with a dot or a colored icon; never with a big colored box.

## Feedback messages

- **Toast** (success of a quick action): past participle, one sentence. "Folder color updated." "Project path copied." "Connection saved."
- **Error** (toast with the alert icon, or a red banner): what happened, then what to do. "Invalid search. Use up to 500 characters." "The work was sent, but its link could not be saved. You can repair links in the Roadmap."
- **Confirmation dialog**: a question as title, the consequence in one sentence, the explicit verb on the button. Title "Stop the server and quit Studio?", button "Stop server and quit".
- **Partial results**: say it plainly. "Some sources could not be read. Results may be incomplete."
- **Empty state**: one sentence that tells what to do. "Add your other PCs with the QR code of their remote access."

## Numbers, dates and units

- Counts as "5/12 tasks checked", "3 subagents · 3 active", "23 tool calls". Use plural rules (`Intl.PluralRules`), never "(s)".
- Percentages: "42%" in English text, "42 %" in French; in Studio's header button the value is written "42 %".
- Times: locale short time ("05:04 PM", "17:04"); today shows a time, older items show a short date ("Oct 13").
- Durations: "640 ms", "1.9 s", "5 min".

## Bilingual rules

- One table, one row per key, one value per language (French is the fallback). Plurals are objects with `one` and `other`.
- Never mix languages inside one view. Switching language replaces every visible string at once and keeps forms and drafts.
- Translate meaning, not words; keep the same length budget so layouts hold in both languages.
- Product names, Git terms and API terms stay untranslated.
