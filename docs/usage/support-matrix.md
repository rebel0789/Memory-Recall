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

- `recall mcp install` installs `recall mcp server --read-only --engine native` for Codex,
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
| Codex tool server | `recall mcp install --client codex --dry-run --format json`, then the printed `--apply --confirm` command; reverse with `mcp uninstall` | Writes or removes only the exact entry in `$HOME/.codex/config.toml` after matching confirmation; backs up existing config | None from this install | Twelve read-only tools; installed native mode requires a verified platform package and a current local index, and returns the matching recovery command otherwise | Implemented |
| Claude Code tool server | `recall mcp install --client claude-code --dry-run --format json`, then confirmed apply; reverse with `mcp uninstall` | Same exact-entry confirmation and backup boundary for `$HOME/.claude/mcp.json` | None from this install | Same strict native selection; no silent JS fallback | Implemented |
| Cursor tool server | `recall mcp install --client cursor --dry-run --format json`, then confirmed apply; reverse with `mcp uninstall` | Same exact-entry confirmation and backup boundary for `$HOME/.cursor/mcp.json` | No hook writer | Same strict native selection; no silent JS fallback | Implemented |
| Codex resource bridge | `recall connect codex --dry-run --format json`, then `--yes` | `connect --yes` writes only matching resource-bridge entries and creates backups when it changes existing home config | Connect-owned `SessionStart`, `UserPromptSubmit`, and `PreCompact` hook entries | Resources only; no MCP graph tools | Implemented |
| Claude Code resource bridge | `recall connect claude-code --dry-run --format json`, then `--yes` | Same narrow connect-owned writer and backup behavior | Same three connect-owned hook events | Resources only; no MCP graph tools | Implemented |
| OpenCode, OpenClaw, Gemini CLI, Zed, Aider, Goose, VS Code, Cline, Roo, Windsurf, Generic MCP | `recall harness setup plan --client <client> --server oaf --dry-run --format json`, then copy the shown snippet yourself | Preview and manual snippet only; `harness setup` never writes config | No writer; use the read-only MCP server manually if the client supports it | No installer-backed graph-tool proof for each client | Experimental |
| Other clients or marketplaces | None | No installer or runtime proof | None | None | Unsupported |
| Packaged Rust graph reads | Install a matching optional platform package or set `MEMORY_RECALL_NATIVE_BINARY`; omit `--engine` or use `--engine native` | No client config writer | None | A healthy current native index uses verified Rust by default; the compiler-free installed path represents all 14 Tier 1 fixtures, while full capability and cross-platform release gates remain open | Experimental |
| Local Rust persistent index | Build locally, set `MEMORY_RECALL_NATIVE_BINARY`, then use `graph index` with `--engine native`; writer modes remain explicit | Writes only `.local/source-index/index.v1.sqlite` for explicit build, refresh, or confirm-gated repair | None | SQLite generations, bounded invalidation refresh, doctor, repair, bounded query, exact no-op refresh across 14 reviewed fixtures, and a clean Phase 3 receipt | Experimental |
| Local Rust MCP | Start `recall mcp server --read-only --engine native` after building the indexes and registering repositories explicitly | No client config writer and no index or memory writes | None | Twelve-tool server; structural tools read prebuilt native indexes and expose bounded repository listing/search plus exact two-repository Go dependencies, trace, and reverse impact; governed memory tools keep their existing read-only behavior | Experimental |
| Tier 2 and other source graph analysis | None | None | None | Lua, Bash, SQL, Objective-C, Scala, R, Julia, Zig, and languages outside Tier 1 have no promoted static graph support | Unsupported |
| Automatic transcript capture, write-capable MCP, hosted sync | None | None | None | None | Unsupported |

## Graph boundary

Both graph engines are static and bounded. The compatibility engine scans
supported JS/TS-family files only; the Rust engine has fixture-backed parsing
across 14 Tier 1 languages but still carries unmeasured capability rows. Both
report skipped or partial coverage. Neither is a language server, semantic
graph database, or universal code index.

`recall graph index --write` creates an optional JS/TS structural index under
`.local/source-graph/`. `--refresh` reparses changed and added files, reuses
unchanged shards, and removes deleted files. `--refresh --watch` keeps it
current while the process runs. Graph reads, direct MCP startup, and installed
MCP servers default to `native`: they require a verified Rust engine and a
healthy current SQLite index. Missing, unavailable, absent, stale, corrupt, or
incompatible state returns a specific recovery action and never selects JS.
`auto` and `native-preview` remain strict native aliases. Every
build, refresh, and repair remains explicit.

`recall graph stats`, `recall graph search`, `recall graph trace`, and
`recall graph impact` accept `--engine native` or `--engine
compatibility` after a local Rust build. Dependency and route reads are exposed
through MCP as `code.dependencies` and `code.routes`; there are no `recall graph
dependencies` or `recall graph routes` CLI subcommands.

Native code intelligence can parse the 14 Tier 1 languages. The Phase 2 audit covers one
fixture and three pinned repositories per language, but it promotes only the 46
capability rows with qualifying evidence. Every language still has applicable
unmeasured rows. These modes are read-only. Production-default native selection
does not establish full language parity or a cross-platform published promise.

The experimental repository registry is explicit. Build each repository index,
then use `recall graph repositories register --write` from their shared fleet
root. `list` and `search` require `--read-only`. The existing MCP tools expose
repository discovery and bounded search; `code.dependencies`, `code.trace`, and
`code.impact` accept an exact two-repository Go selector. This does not claim
general cross-repository or cross-language resolution.

## Config and data boundary

`mcp install` is dry-run by default and requires `--apply --confirm
sha256:<plan-fingerprint>` before it changes a home config file. `mcp uninstall`
uses the same exact-preimage confirmation, backs up the config, and removes only
an exact Memory Recall-owned entry. Drifted entries are left unchanged. `harness
setup` and `hook install` are previews/manual snippets only. Normal
`memory.recall` and `context.profile` calls can persist local cursor and
delivery telemetry; structural map, search, trace, route, dependency, impact,
architecture, and index-status tools do not record that telemetry.
Here, read-only means no canonical-memory, source-index, client-config, network,
or external writes; it does not mean that optional local cursor and statistics
files are disabled.

For current commands and limitations, see the [MCP server reference](mcp-server-reference.md)
and [developer-first contract](../product/memory-recall-developer-first.md).
