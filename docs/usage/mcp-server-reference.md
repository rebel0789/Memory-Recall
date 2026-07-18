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
| `repo.index_status` | Report local index status or list explicitly registered repositories. | No |
| `code.search` | Search local metadata or selected registered repository indexes. | No |
| `code.context` | Return one symbol with bounded, optionally filtered structural relationships. | No |
| `code.trace` | Trace bounded local call paths or one exact Go path across two repositories. | No |
| `code.dependencies` | Walk local dependencies or resolve one exact Go module boundary across two repositories. | No |
| `code.routes` | Discover HTTP method exports in route-like JS/TS files. | No |
| `code.impact` | Return local changed-file impact or reverse impact for one exact Go repository boundary. | No |

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
incoming and outgoing relationships. With a current native index, it also
accepts `direction`, depth `1..3`, and 1..16 unique canonical `edgeKinds` for a
filtered traversal. Supplying any constraint never falls back to the JS scanner;
a missing or stale native index returns a refresh instruction. `code.trace`
follows call edges.
`code.dependencies` walks imports and related structural edges. `code.routes`
uses static route evidence from the native index; it does not execute a
framework or claim runtime route coverage.

### Registered repository mode

Registered repository reads require the Rust engine and prebuilt indexes. Use
`repo.index_status` with `scope: "repositories"` to list repository IDs, and
pass `repositoryIds` to `code.search`. For `code.dependencies`, `code.trace`,
or `code.impact`, pass `crossRepository` with ordered client and service
repository IDs plus the selected client-entry and service-target native node
IDs. Local and cross-repository selectors cannot be mixed. Trace and impact are
capped at 25 results and the native request and subprocess share a two-second
deadline. This path currently supports exact Go module evidence only.

Register repositories from their shared fleet root after building each native
index:

```bash
recall graph repositories register --write --root . --repository repositories/client --name Client --format json
recall graph repositories list --read-only --root . --limit 10 --format json
recall graph repositories search --read-only --root . --query Service --repository-ids <client-id,service-id> --per-repository-limit 10 --limit 20 --format json
```

## Persistent Source Index

The source index is local and production code-intelligence reads require it:

```bash
recall graph index --status --root . --format summary
recall graph index --write --root . --format json
recall graph index --refresh --root . --format json
recall graph index --refresh --watch --root . --format summary
```

The native file is `.local/source-index/index.v1.sqlite`. It contains hashes,
locators, normalized structural metadata, evidence, and bounded indexes. It does
not contain source bodies or absolute paths. Writes are atomic and require an
explicit CLI command. Refresh reparses invalidated scope and reuses unchanged
files.

MCP checks index freshness but never writes the index. A current index is reused
across processes. A stale index returns the explicit refresh command.

### Native index

The packaged Rust engine is the default. Source checkouts may select an explicit
local release binary for development:

```bash
recall graph index --write --engine native --root . --format summary
recall graph index --query main --kind exact --engine native --root . --format json
recall graph index --doctor --engine native --root . --format summary
recall mcp server --read-only --engine native --root . --stdio
```

Its fixed path is `.local/source-index/index.v1.sqlite`. Native MCP
queries that prebuilt index and fails clearly if it is unavailable; it never
builds, refreshes, repairs, or falls back to the JS engine. Direct `mcp server`
commands without `--engine` use native selection.

The former `auto` spelling remains a strict native alias:

```bash
recall mcp server --read-only --engine auto --root . --stdio
```

Before each structural tool call, native mode checks the packaged binary and the
prebuilt index. It reads results only when the index is healthy, ready, current,
and has a committed generation. Absent, stale, invalid, or unavailable state
returns an actionable error. It never builds, refreshes, repairs, or silently
mixes engines. The temporary JS/TS path requires `--engine compatibility`.

In native mode, `repo.architecture` derives groups with
`label-propagation-v1` and entry-to-sink paths with `entry-path-v1`. Each
process references returned node and relationship IDs. Reads remain capped,
report truncation, and preserve the index bytes and modification time. These
projections are available through the existing twelve-tool MCP surface; no new
write or query-execution tool is exposed.

Constrained `code.context` reads use the same surface. Edge-kind filtering is
performed inside each SQLite traversal step, and returned relationships retain
source locators with both endpoints present in the bounded result.

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

The installer-generated server uses `--engine native`. Install preview and apply
never build or refresh a graph index. The report prints `indexBuildCommand` as
the separate explicit write needed to create the native index. Until that
command is run successfully, structural tools return the build instruction.
A healthy, current native index is then read without MCP writes.

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
