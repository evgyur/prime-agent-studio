# Apps that drive several Studio instances

Use this file when the app talks to one or more Prime Agent Studio instances through the Studio public API v1
(for example a controller that follows runs on several PCs). Style first: the app must feel like one more Studio screen.

## Vocabulary (keep Studio's words)

| Word | Meaning | Where it comes from |
|---|---|---|
| Machine | One PC running Studio. It has a name, an address and its own access token. | `GET /api/v1/machine` returns `name`, `machineId`, `studioVersion`, `capabilities`. Studio's own list of PCs is the "Machines" screen. |
| Project | A folder on one machine. Its `id` is local to that machine; the same project on two machines shares a `syncId`. | `GET /api/v1/projects` |
| Conversation (session) | A thread with an agent inside a project. | Studio UI says "session" in actions ("New session") and "conversation" in prose. |
| Run | One agent execution, followed live through its events. | `/runs/{id}`, `/runs/{id}/events` (SSE) |
| Interaction | A question the agent asks and that a person must answer. | Run interactions |
| Roadmap | Plans, steps and backlog of a project, edited with an expected revision. | `/projects/{id}/roadmap` |
| Token and scopes | `read`, `runs:write`, `roadmaps:write`, `files:download`, `computer:write`. | Created and revoked in Studio, never by the API. |

Call the feature "API" or "Studio API". Do not invent other names for machines (no "nodes", "agents hosts" or "workers").

## Information architecture

Recommended shell, built with the same regions as Studio (see `layout.md`):

```
+--------------+----------------------------------------------------------------+
| SIDEBAR      | HEADER: Laptop / Nimbus API / Add rate limiting      [pills]  |
| brand        +----------------------------------------------------------------+
| [+ Add a     | TAB BAR: conversation, Roadmap, Files                         |
|  machine]    +-----------------------------------+----------------------------+
| search       | conversation thread               | Roadmap or run details     |
| MACHINES     | (live run, events)                |                            |
| ▾ Workstation|                                   |                            |
|   Nimbus API | composer (send to this machine)   |                            |
|   Orbit Web  |                                   |                            |
| ▸ Laptop     |                                   |                            |
| footer:      |                                   |                            |
| 3 machines   |                                   |                            |
+--------------+-----------------------------------+----------------------------+
```

- **Sidebar tree = machines, then projects, then conversations.** Reuse `.ps-tree`, `.ps-row`, `.ps-subrow` exactly. A machine row shows the `machine` (monitor) icon in the machine color, its name, a status dot and the number of running runs (`.ps-count`).
- **Breadcrumb = Machine / Project / Conversation.** The machine always appears: two machines can host projects with the same name.
- **Overview page (optional)**: one card per machine, styled like Studio's Machines screen (below), sorted by name, with live counts.
- **Detail panes**: reuse the conversation thread, composer, Roadmap and Files recipes. A pane always shows which machine it belongs to (panel subtitle or tab label).

## Machine cards

Two recipes, both built from tokens, so they work in dark and light.

**Desktop (overview pane, dashboard):** compose `.ps-card` with the machine color as a 3 px left border.

```html
<article class="ps-card" style="--machine-color: var(--device-yellow); border-left: 3px solid var(--machine-color)">
  <div style="display:flex; align-items:center; gap:9px">
    <span data-icon="machine" style="color: var(--machine-color)"></span>
    <h3 class="ps-card-title" style="margin:0">Laptop</h3>
    <span class="ps-status is-connected" style="margin-left:auto">Connected</span>
  </div>
  <p class="ps-card-meta">laptop.tail4c2a.ts.net</p>
  <dl class="ps-kv"><dt>Runs in progress</dt><dd>1</dd><dt>Projects</dt><dd>3</dd></dl>
</article>
```

**Touch list (phone, tablet, like Studio's Machines screen):** use `.ps-machine-list` and `.ps-machine` from `studio.css` (see `components.html`, "Machines", and `references/screenshots/studio-machines-mobile.png`).

```html
<ul class="ps-machine-list">
  <li><a class="ps-machine" href="..." style="--machine-color: var(--device-yellow)">
    <span class="ps-machine-icon"><span data-icon="machine"></span></span>
    <span class="ps-machine-body">
      <span class="ps-machine-name">Laptop</span>
      <span class="ps-machine-meta">Tailscale HTTPS · <code>laptop.tail4c2a.ts.net</code></span>
    </span>
  </a></li>
</ul>
```

- Studio's own Machines screen is a dark-only page with a few local values (hover `#27282c`, border `#575363`, icon tile `#2c2b38`). `.ps-machine` maps them to tokens (`--surface-hover`, accent mixed into `--line`, `--accent-bg`); keep the tokens.
- The touch sizes (15.5 px names, 12.5 px meta, radius 14, 48 px buttons with radius 12 on that screen) are for touch-first pages only. In a desktop sidebar keep the 12 px rows of `components.md`.
- Badge after the name: `.ps-badge--solid` ("This address", "Read-only").

## Machine colors

- Assign each machine a color from the device palette, in order: cyan `#0891b2`, yellow `#ca8a04`, fuchsia `#c026d3`, slate `#64748b`, brown `#92400e`; let the person change it with `.ps-swatches`.
- Show the color as a small mark only: the tinted monitor icon (Studio's "origin" marker), a 10 px dot, or a 3 px left border on a card. Never as a background fill or a colored header.
- A machine color is identity. Connection state stays on the status dot.

## States to show

| State | Visual | Text |
|---|---|---|
| Connected | `.ps-dot--connected`, or `.ps-status.is-connected` with its word | "Connected" or nothing |
| Run in progress | `.ps-dot--running` on the conversation and the machine | "Working", "Running a tool", "Waiting for subagents" |
| Unread result | `.ps-dot--unread` | none |
| Question waiting for an answer | amber attention dot and a "Question" status on top of the list | "1 question to answer" |
| Machine unreachable | default faint dot, muted name | "Offline. Last seen 10:24." |
| Token rejected (401), scope missing (403), incompatible version | `.ps-dot--attention` + quiet or warning banner in that machine's pane | "This token can read only. Ask for runs:write to send messages." |
| Revision conflict (409) on a Roadmap | `.ps-banner--warning` | "The Roadmap changed on Laptop. Reload it before saving again." |
| Action failed | `.ps-toast.is-error` | What failed, then what to do |

Read-only access is not an error: show the quiet banner (`.ps-banner--quiet` with the `shield` icon) and disable write controls; keep everything readable.

## Behavior that the style must support

- **Explicit actions.** Starting a run or editing a Roadmap has real effects and can cost money. Use a primary button with an explicit label ("Send to Laptop", "Start work on this plan") and confirm in a dialog when it is not the obvious next step.
- **No silent retry, no fallback to another machine.** Show the failure and offer a "Retry" secondary button. A machine that does not answer stays "Offline"; never move its work elsewhere automatically.
- **Answer questions on purpose.** Show agent questions with the `.ps-question` recipe (options, free-text answer, "Send answer" and "Skip") in the conversation of that machine, and list pending questions at the top of the sidebar or overview. Never auto-confirm.
- **Secrets.** Never display a token in full. Store it once, show at most its last 4 characters ("•••• 7f2a"), and never put it in URLs, logs or screenshots.
- **Live data.** Streamed text appears in place without layout jumps; statuses change color, not position. Lists keep a stable order (pinned first, then manual order), they do not jump on every message.
- **Identity across machines.** Match the same project across machines only by `syncId`, never by folder name. Show the machine name next to every project name where two machines could be confused.
