# Local context engine

**English** · [Français](../context.md) · [← Back to README](../../README.md)

## Context tab

Open **Context** from the modular workspace's **Add tab** menu. In classic mode and on mobile, open it from **Session**. Like other tools, a Context tab follows the selected conversation unless you lock it.

The panel shows the dossier supplied to the agent, pinned files, the local index state, and project exclusions. Use **Pin to context** in Files or a context search result to keep a file in the next conversation's dossier. Pins are pointers, not copies of full files. Remove a pin in Context. Project and conversation switches control automatic context. They do not remove messages already sent to a provider. The panel updates from events, not a polling timer. Remote access to this source data requires authenticated full control; consultation mode does not expose it.

**Rebuild** recreates the derived index. Exclusions are project-relative patterns. Excluded files and sensitive filenames are not searchable. The index is local; there is no embedding service or semantic search in V1. An agent may send relevant excerpts to its configured provider as ordinary conversation context.

## What the agent receives

Before the first agent turn, a bounded dossier gives likely relevant files and line ranges, pins, detected test/build commands, and pointers to `AGENTS.md` or `CLAUDE.md`. It is a normal context message, not a replacement system prompt. This preserves the stable provider prompt prefix. The dossier is injected once per conversation, not on every user turn. A missing or unfinished index does not prevent the conversation from starting.

The native extension exposes three read-only, project-scoped tools:

| Tool | Result |
| --- | --- |
| `studio_code_search` | Ranked code blocks with file paths and line ranges; SQLite FTS5 BM25 ranking. |
| `studio_code_symbols` | Definitions and references for a symbol. |
| `studio_code_map` | Compact folder map with files, main symbols, and imports. |

Results are bounded. Symbols and imports use lightweight language heuristics for JavaScript/TypeScript, Python, C#, Rust, and Go. They are navigation aids, not compiler-accurate references or a language server. Git history provides recent-change and co-change signals. Verify the current source before editing.

Very large old tool results can be replaced in the request context by short references in stable tiers. Recent turns, user messages, and tool-call pairing are protected. The native conversation history is unchanged. Guided compaction retains file pointers, decisions, and open work within the engine's supported compaction hook.

## Storage and privacy

Derived data lives in `<Studio data directory>/code-index/<opaque project id>/`, never in the indexed project's source tree. The project id is a hash, not a folder name. SQLite WAL lets agent readers coexist with the index worker. Settings and dossier snapshots stay alongside the project index. Treat this directory as private local source data; unlike performance metrics, it contains code excerpts.

The worker indexes Git-tracked files and untracked files not ignored by Git. It skips binary files, files over 1 MiB, sensitive filenames such as `.env*`, credentials and private keys, and paths that escape the project. Updates are incremental and run outside the UI/server thread. File change events are debounced; there is no tight polling loop. Rebuild is useful after a large branch switch or when filesystem notifications were unavailable.

Source installs require **Node.js 22.13 or later** for `node:sqlite`. The bundled runtime already includes it. No engine installation files are modified: Studio loads its extensions through native `--extension`, including inherited RLM children.

### V1 limits

Secondary Git working directories do not yet receive automatic code context: launches explicitly disable it rather than search the main repository index. The primary project remains supported. The worker limits an index to 10,000 files and 64 MiB of source text; SQLite is capped at about 256 MiB. Results are bounded excerpts, not an exhaustive analysis of the repository.
