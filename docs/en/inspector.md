# Session, agents and files

**English** · [Français](../inspector.md) · [← Back to README](../../README.md)

The panel button at the top right of the chat opens the workspace. It stays beside the conversation on desktop and fills the screen height on mobile. Closing the panel or a preview preserves the session and its draft.

## Session

Find the project, session status, active runs and conversation export. Tracking distinguishes response generation, tool execution, context compaction and waiting for subagents.

Chat status also distinguishes quota and provider errors. These indicators follow engine events; they change neither the selected model nor recovery limits.

Usage adds up Prime Agent’s recorded data on the conversation’s current branch: uncached input, output, cache read and cache write tokens. The **cache rate** is the share of input tokens served from the cache: read ÷ (input + read + write), excluding output tokens. Estimated cost appears only when the engine provides it; otherwise it stays **unknown**, not zero. It does not represent your subscription bill.

The total includes subagents: each request counts once, with its own usage, including a subagent that is still running. The main agent’s figures remain available in the details. The disclosure keeps its open or closed state across refreshes and when returning to the session. The total is marked **partial** when a subagent is missing, its history exceeds 16 MiB, or beyond 200 subagents. Compaction summary costs are not included here.

Below the composer, a quiet line shows **Context x % · Cache y %**, in every conversation tab and on mobile. During a run it uses the engine’s measurement and updates on each message, compaction or turn end, without periodic polling. When idle, it shows the size of the **last request** against the model’s window, as its tooltip says. It turns amber at 80 % and red at 95 %; it is hidden when the value is unknown, for example right after a compaction.

## Performance

Add **Performance** through the modular workspace’s **Add tab** menu. The tab follows the active conversation’s project; its lock keeps that project, even after the source conversation closes. In classic layout and on mobile, the **Performance** button in Session opens the same view in a dialog.

Choose **This project** or **All projects**, then Today, 7, 30 or 90 days. The default period is 7 days, using UTC days. The view shows estimated cost, all four token categories, cache rate, runs started, succeeded, failed and stopped, median duration and median time to first token. Older sessions without timing show **Not available**. Missing cost stays **Unknown**, with the number of affected messages.

The daily chart shows cost or tokens. The model table ranks your own work by cost or run count. Success rate is succeeded runs divided by succeeded plus failed runs. Manual stops and budget stops are excluded. Their count appears separately in the indicators and in the tables’ success-rate tooltip. With no succeeded or failed runs, the rate is **Not available**. Cost per completed run includes the period’s total cost. HTTP 4xx and 5xx errors are counted separately. **All projects** adds a table of project display names, without paths. A **Code lookup usefulness** block lists calls, useful share, fallback share, and sample size per tool (`studio_code_search`, `studio_code_symbols`, `studio_code_map`). A call counts as useful when a returned file is opened within the next five tool calls; it counts as fallback when a shell search (`grep`, `rg`, `findstr`, `Select-String`) or a manual read follows within the next three calls. Only counts are recorded, never paths or contents. Below five calls, rates show **sample too small** instead of a percentage.

Metrics load when the view opens, after a run finishes while it is visible, or with **Refresh**, without periodic polling. History backfill, incomplete reads and read limits show a notice with **Retry**. The ledger retains 90 days. Unlike the Session usage block, it includes recorded compaction summaries.

## Agents

Subagent settings are available as soon as a new conversation opens, before its first message. They depend on the selected project; changing them creates neither a Prime Agent session nor an agent.

At the top of the tab, **Project subagents** uses shared defaults from desktop preferences when **Global** is selected; model and reasoning selectors are hidden. Choose **This project** to show them and customize future delegations. The model selector uses the same catalog, search and favorites as conversations. Choices save automatically for all sessions in the project; returning to **Global** removes the override. Already-created agents keep their settings. This block works on desktop and on mobile with full control.

The main agent and its subagents appear in their hierarchy, with their model, **reasoning level**, status and latest available summary. The level comes from the active session or changes recorded on its current branch, never from Studio’s defaults. **Not specified** indicates missing data in an older session. Click a card to read its conversation, then use **Refresh** to retrieve the latest messages.

Notes sent through `rlm.progress_note(...)` appear on the subagent card alongside its last activity when the engine provides these values. Activity age uses the engine’s active-time measurement: putting the PC to sleep does not make agents appear inactive. While a tool executes, Studio does not infer inactivity from its duration. Notes are plain text, not success verdicts.

During a run launched by Studio, the list refreshes every few seconds while the panel is visible. An agent that completed one task may work again: its current activity takes priority over an older “done” status.

Outside a run, Studio displays delegations retained in Prime Agent’s native registry. **History** means exchanges were found but the agent’s current status is unknown. Some older sessions no longer have registered delegations. An unavailable tracking indicator triggers no restart.

Tracking uses Prime Agent **0.9.7**’s protocol. Viewing a card does not resume, stop or detach the agent. The list shows up to 200 subagents and each preview the latest 150 messages; internal reasoning is not expanded in that preview.

## Files

- **Changes** shows modified, added and deleted files in the Git project. Click to read additions in green and deletions in red, or switch to **Content**.
- **Browse** opens folders and their files. Breadcrumbs navigate to parent folders; **Show more** loads subsequent entries in pages of 100.
- **Open** launches the file’s associated application on the PC hosting Studio. From the PWA or another device, the button says **Open on PC**. Remote read-only mode keeps previews but cannot launch applications on the PC.

**Markdown** files (`.md`, `.markdown`, `.mdown`, `.mkd`) display headings, lists, tables, quotations and code blocks. JSON previews are indented while preserving original values. **Preview / Source** switches to the file’s exact text without reloading it. Other text files preserve indentation, and HTML files remain text without execution.

The diff compares current contents with the latest commit, including staged and working-tree changes. It covers **the entire project**: several sessions or manual edits may contribute to the same files. Changes are not automatically attributed to an agent. File browsing remains available without Git.

Markdown links to project documents and file references written as code in messages are clickable. They open a preview with the same **Open** button, without switching sessions or losing the draft. Relative, absolute and `file://` paths are recognized, including line references. A bare filename is searched for within the project; if several files share that name, Studio lets you choose.

Links are not limited to selected extensions: a binary file such as an `.exe` or `.zip` can open the panel without being executed. A link’s context menu offers **Open**, **Open folder**, and **Copy path**. The panel also includes **Open folder**, next to **Open**, to open the containing folder on the host PC.

**Open folder** is not limited to the project: an absolute path, a `file://` link or a relative path can identify any existing folder accessible to the PC. A file opens its parent folder; a folder opens directly. No project registration is required. This explicit action opens the host PC's file manager without transferring its contents to the browser. It remains unavailable in read-only mode and to public API tokens.

Previews accept UTF-8 text up to 512 KiB and PNG, JPEG, GIF or WebP images up to 8 MiB. Formatting affects display only: it does not modify project files. Deleted files have a diff but can no longer be opened. On Windows, scripts and code open as text in Notepad; this command does not launch executables or shortcuts. If a text file has no associated application, Studio uses Notepad.

Content browsing, previews and downloads remain restricted to registered projects and the usual remote access code. Technical folders (`.git`, `node_modules`, caches), private engine and Studio data, and links leaving the project are excluded. An explicit link into `.local` is accessible only when that folder is not Studio’s private data directory. Remote read-only mode allows these views without allowing agent commands.
