# Claude Code Setup

Memory Recall works with Claude Code as a local stdio MCP server. Claude Code's
documented flow registers local servers with `claude mcp add ... -- <command>`.
Memory Recall also provides a preview-then-confirm installer.

## Install

```bash
npm install -g memory-recall
recall setup
recall verify
```

## Preview Memory Recall's Installer

```bash
recall mcp install --client claude-code --dry-run --format json
recall connect claude-code --dry-run --format json
recall hook install --agent claude-code --dry-run --format json
```

The dry run writes nothing. If you choose to apply the MCP installer, use the
printed `--apply --confirm <fingerprint>` command from the dry-run output.

## Native Claude Code Command

If you prefer Claude Code's own MCP CLI, register Memory Recall as a local
server from the repository you want to work in:

```bash
claude mcp add memory-recall -- recall mcp server --read-only --root "$PWD" --sqlite "$PWD/.local/memory.sqlite" --stdio
claude mcp list
```

Claude Code stores servers by scope. Its default local scope is private to the
current project; project scope writes `.mcp.json`; user scope applies across
projects. Keep Memory Recall local unless your team explicitly wants a shared
project entry.

## Use

```bash
recall memory ingest --root . --sqlite .local/memory.sqlite --format json
recall memory review --root . --sqlite .local/memory.sqlite --format summary
recall handoff
```

Memory ingest creates proposals only. Claude Code receives active reviewed facts
and context-pack locators through read-only MCP tools.

