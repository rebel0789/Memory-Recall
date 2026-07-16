# MCP Server Reference

Memory Recall exposes local repository context over read-only MCP.

## Start The Server

```bash
recall mcp server --read-only --root . --sqlite .local/memory.sqlite --stdio
```

From a source checkout without global install:

```bash
npm run recall -- mcp server --read-only --root . --sqlite .local/memory.sqlite --stdio
```

## Tools

| Tool | Purpose | Writes |
| --- | --- | --- |
| `memory.recall` | Return reviewed active memory facts for a query. | No |
| `context.profile` | Return a compact profile selected under a context budget. | No |
| `context.pack` | Return a safe locator handoff for the current task. | No |
| `repo.map` | Return a bounded Recall Map of local source coverage, governed memory, and handoff readiness. | No |
| `repo.architecture` | Return bounded architecture groups, entry points, processes, structural hotspots, and evidence. | No |
| `repo.index_status` | Report whether the optional persistent source index is missing, ready, stale, or invalid. | No |
| `code.search` | Search symbols, files, modules, and relationships. | No |
| `code.context` | Return one symbol with bounded incoming and outgoing relationships. | No |
| `code.trace` | Trace bounded inbound or outbound call paths from a symbol. | No |
| `code.dependencies` | Walk a bounded dependency neighborhood for a file, module, or symbol. | No |
| `code.routes` | Discover HTTP method exports in route-like JS/TS files. | No |
| `code.impact` | Return bounded locator-safe impact for changed local source files. | No |

The server does not expose memory approval, config mutation, shell, or external
write tools.

All structural tools return safe labels, relationship metadata, and
`workspace://` locators. They do not return source bodies or absolute local
paths. Results are bounded to at most 50 requested rows and trace or dependency
depth is capped at 3.

`repo.map` accepts optional `changed`, `query`, and `limit` inputs. `changed`
uses safe workspace-relative source locators and `limit` is bounded to `1..50`.
`code.impact` requires a non-empty `changed` list and accepts `depth` `1`, `2`,
or `3` plus a `limit` of `1..50`. Both return safe labels and
`workspace://` locators only; neither records MCP delivery stats, cursors,
graph state, or memory state. The established Recall Map v1 response envelope
remains capped at 20 listed architecture, search, and impact items.

`code.search` accepts a query plus optional node kinds, edge kinds, locator
prefix, limit, and offset. `code.context` selects a symbol and reports its direct
incoming and outgoing relationships. `code.trace` follows call edges.
`code.dependencies` walks imports and related structural edges. `code.routes`
uses static HTTP-method exports in route-like paths; it does not execute a
framework or claim runtime route coverage.

## Persistent Source Index

The source index is optional and local:

```bash
recall graph index --status --root . --format summary
recall graph index --write --root . --format json
recall graph index --refresh --root . --format json
recall graph index --refresh --watch --root . --format summary
```

The default file is `.local/source-graph/index.v1.json`. It contains hashes,
locators, symbol metadata, per-file parse shards, and a bounded graph. It does
not contain source bodies or absolute paths. Writes are atomic and require the
explicit CLI command. Refresh reparses changed and added files, reuses unchanged
shards, and removes deleted files.

MCP checks index freshness but never writes the index. A current index is reused
across processes. A stale index is reported as stale and structural tools fall
back to a fresh bounded scan.

### Native preview index

After a local Rust release build, an isolated SQLite index is available only
when `--engine native-preview` is explicit:

```bash
recall graph index --write --engine native-preview --root . --format summary
recall graph index --query main --kind exact --engine native-preview --root . --format json
recall graph index --doctor --engine native-preview --root . --format summary
recall mcp server --read-only --engine native-preview --root . --stdio
```

Its fixed path is `.local/source-index/index.v1.sqlite`. The native MCP preview
queries that prebuilt index and fails clearly if it is unavailable; it never
builds, refreshes, repairs, or falls back to the JS engine. Normal MCP startup
continues to use the JS index behavior above.

Explicit automatic selection is available without changing that default:

```bash
recall mcp server --read-only --engine auto --root . --stdio
```

Before each structural tool call, auto mode checks the native binary and the
prebuilt index. It reads native results only when the index is healthy, ready,
current, and has a committed generation. Absent, stale, partial, invalid, or
unavailable native state uses the fresh bounded JS scan and reports the reason.
Auto mode never builds, refreshes, or repairs an index, and a native query error
after selection is returned instead of silently mixing engines.

In native preview, `repo.architecture` derives groups with
`label-propagation-v1` and entry-to-sink paths with `entry-path-v1`. Each
process references returned node and relationship IDs. Reads remain capped,
report truncation, and preserve the index bytes and modification time. These
projections are available through the existing twelve-tool MCP surface; no new
write or query-execution tool is exposed.

## Resource Catalog

```bash
recall mcp resources --read-only --format json
recall mcp resources --read-only --stdio
recall mcp inspect --read-only --root . --format summary
```

Useful resource families include workspace status, skill catalog, tool catalog,
memory refinement reports, and context-pack registry or use-plan resources.

## Client Install Preview

```bash
recall mcp install --client claude-code --dry-run --format json
recall mcp install --client cursor --dry-run --format json
recall mcp install --client codex --dry-run --format json
```

Apply only after reviewing the dry-run fingerprint:

```bash
recall mcp install --client claude-code --apply --confirm sha256:<plan-fingerprint> --format json
```

Remove only an exact package-owned entry with the same preview and confirmation
boundary:

```bash
recall mcp uninstall --client claude-code --dry-run --format json
recall mcp uninstall --client claude-code --apply --confirm sha256:<plan-fingerprint> --format json
```

## Safety Boundaries

- Local stdio only.
- Read-only MCP tools by default.
- No model calls.
- No network calls.
- No active memory creation.
- No raw source bodies in normal handoff output.
- No implicit source-index build or refresh.
- No hidden harness-history import.
- No config write without dry-run review and confirmation.
- No replacement or removal of drifted or unowned MCP entries.

The MCP server entry may be named `oaf` internally for compatibility. The public
package and CLI are `memory-recall` and `recall`.
