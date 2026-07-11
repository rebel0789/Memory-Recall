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
| `code.impact` | Return bounded locator-safe impact for changed local source files. | No |

The server does not expose memory approval, config mutation, shell, or external
write tools.

`repo.map` accepts optional `changed`, `query`, and `limit` inputs. `changed`
uses safe workspace-relative source locators and `limit` is bounded to `1..50`.
`code.impact` requires a non-empty `changed` list and accepts `depth` `1`, `2`,
or `3` plus a `limit` of `1..50`. Both return safe labels and
`workspace://` locators only; neither records MCP delivery stats, cursors,
graph state, or memory state. The established Recall Map v1 response envelope
remains capped at 20 listed architecture, search, and impact items.

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

## Safety Boundaries

- Local stdio only.
- Read-only MCP tools by default.
- No model calls.
- No network calls.
- No active memory creation.
- No raw source bodies in normal handoff output.
- No hidden harness-history import.
- No config write without dry-run review and confirmation.

The MCP server entry may be named `oaf` internally for compatibility. The public
package and CLI are `memory-recall` and `recall`.
