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

The server does not expose memory approval, config mutation, shell, or external
write tools.

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

