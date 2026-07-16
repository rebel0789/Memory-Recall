# Support Matrix

This matrix separates what works today from what requires a manual experiment.
`Implemented` means the path has current in-repository behavior and tests.
`Experimental` means it needs a manual configuration or local build and is not
an installer-backed client promise. `Unsupported` means Memory Recall does not
provide that surface.

For per-language code-intelligence evidence and benchmark status, see
[Code-intelligence language support](code-intelligence-support.md).

## Choose the MCP path deliberately

There are two different local MCP paths:

- `recall mcp install` installs `recall mcp server --read-only` for Codex,
  Claude Code, or Cursor. It exposes twelve tools: `memory.recall`,
  `context.profile`, `context.pack`, `repo.map`, `repo.architecture`,
  `repo.index_status`, `code.search`, `code.context`, `code.trace`,
  `code.dependencies`, `code.routes`, and `code.impact`.
- `recall connect` is only for Codex and Claude Code. It writes a separate
  `mcp resources --read-only --stdio` resource bridge plus optional hooks. Its
  MCP `tools/list` is empty, so it does not expose Recall Map tools.

Do not use `disconnect` to remove a tool-server install: it only recognizes
the connect-owned resource bridge. See [Uninstall](uninstall.md) for the exact
reversal path.

## Client and surface matrix

| Client or surface | Install mode | Config write behavior | Hook behavior | Graph coverage | Status |
| --- | --- | --- | --- | --- | --- |
| Codex tool server | `recall mcp install --client codex --dry-run --format json`, then the printed `--apply --confirm` command; reverse with `mcp uninstall` | Writes or removes only the exact entry in `$HOME/.codex/config.toml` after matching confirmation; backs up existing config | None from this install | Twelve read-only memory, context, and bounded JS/TS structural tools | Implemented |
| Claude Code tool server | `recall mcp install --client claude-code --dry-run --format json`, then confirmed apply; reverse with `mcp uninstall` | Same exact-entry confirmation and backup boundary for `$HOME/.claude/mcp.json` | None from this install | Same bounded JS/TS graph tools | Implemented |
| Cursor tool server | `recall mcp install --client cursor --dry-run --format json`, then confirmed apply; reverse with `mcp uninstall` | Same exact-entry confirmation and backup boundary for `$HOME/.cursor/mcp.json` | No hook writer | Same bounded JS/TS graph tools | Implemented |
| Codex resource bridge | `recall connect codex --dry-run --format json`, then `--yes` | `connect --yes` writes only matching resource-bridge entries and creates backups when it changes existing home config | Connect-owned `SessionStart`, `UserPromptSubmit`, and `PreCompact` hook entries | Resources only; no MCP graph tools | Implemented |
| Claude Code resource bridge | `recall connect claude-code --dry-run --format json`, then `--yes` | Same narrow connect-owned writer and backup behavior | Same three connect-owned hook events | Resources only; no MCP graph tools | Implemented |
| OpenCode, OpenClaw, Gemini CLI, Zed, Aider, Goose, VS Code, Cline, Roo, Windsurf, Generic MCP | `recall harness setup plan --client <client> --server oaf --dry-run --format json`, then copy the shown snippet yourself | Preview and manual snippet only; `harness setup` never writes config | No writer; use the read-only MCP server manually if the client supports it | No installer-backed graph-tool proof for each client | Experimental |
| Other clients or marketplaces | None | No installer or runtime proof | None | None | Unsupported |
| Local Rust graph preview | Build locally, set `MEMORY_RECALL_NATIVE_BINARY`, then add `--engine native-preview` to a graph read command | No client config writer | None | Explicit bounded preview for the 14 Tier 1 languages; 46 capability rows meet the sampled Phase 2 floor, while every language retains applicable unmeasured rows; npm ships source, not a binary; JS remains the default | Experimental |
| Local Rust persistent index preview | Build locally, set `MEMORY_RECALL_NATIVE_BINARY`, then use `graph index` with `--engine native-preview`; writer modes remain explicit | Writes only `.local/source-index/index.v1.sqlite` for explicit build, refresh, or confirm-gated repair | None | SQLite generations, bounded invalidation refresh, doctor, repair, bounded query, exact no-op refresh across 14 reviewed fixtures, and a clean 781-file Phase 3 receipt | Experimental |
| Local Rust MCP preview | Start `recall mcp server --read-only --engine native-preview` after building the index | No client config writer and no index or memory writes | None | Twelve-tool server; structural tools read the prebuilt native index, while governed memory tools keep their existing read-only behavior | Experimental |
| Tier 2 and other source graph analysis | None | None | None | Lua, Bash, SQL, Objective-C, Scala, R, Julia, Zig, and languages outside Tier 1 have no promoted static graph support | Unsupported |
| Automatic transcript capture, write-capable MCP, hosted sync | None | None | None | None | Unsupported |

## Graph boundary

The implemented graph is static and bounded: it scans supported JS/TS-family
files only, up to 1,000 files and 512 KiB per file, and reports skipped or
partial coverage. It is not a language server, semantic graph database, or
universal code index.

`recall graph index --write` creates an optional local structural index under
`.local/source-graph/`. `--refresh` reparses changed and added files, reuses
unchanged shards, and removes deleted files. `--refresh --watch` keeps it
current while the process runs. Index writes are explicit; MCP only reads a
current index and falls back to a fresh bounded scan when it is stale.

`recall graph stats`, `search`, `trace`, `dependencies`, `routes`, and `impact`
also accept `--engine native-preview` or `--engine compatibility` after a local
Rust build. Native preview can parse the 14 Tier 1 languages. The Phase 2 audit
covers one fixture and three pinned repositories per language, but it promotes
only the 46 capability rows with qualifying evidence. Every language still has
applicable unmeasured rows. These modes are read-only and explicit; neither
changes the public default or creates an installer-backed polyglot promise.

## Config and data boundary

`mcp install` is dry-run by default and requires `--apply --confirm
sha256:<plan-fingerprint>` before it changes a home config file. `mcp uninstall`
uses the same exact-preimage confirmation, backs up the config, and removes only
an exact Memory Recall-owned entry. Drifted entries are left unchanged. `harness
setup` and `hook install` are previews/manual snippets only. Normal
`memory.recall` and `context.profile` calls can persist local cursor and
delivery telemetry; structural map, search, trace, route, dependency, impact,
architecture, and index-status tools do not record that telemetry.

For current commands and limitations, see the [MCP server reference](mcp-server-reference.md)
and [developer-first contract](../product/memory-recall-developer-first.md).
