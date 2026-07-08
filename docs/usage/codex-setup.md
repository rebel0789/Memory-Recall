# Codex Setup

Use this path when Codex should read Memory Recall context from the current repository.

## Install

```bash
npm install -g memory-recall
recall setup
recall verify
```

## Preview The Local Wiring

Start with a dry run. It prints the exact files and commands without changing
your Codex config.

```bash
recall connect codex --dry-run --format json
recall hook install --agent codex --dry-run --format json
recall mcp install --client codex --dry-run --format json
```

## Apply Only After Review

`connect --yes` is the opt-in writer for Memory Recall-owned Codex entries. It
creates backups and receipts, and it can be undone.

```bash
recall connect codex --yes --format json
recall disconnect codex --dry-run --format json
```

Use `disconnect --yes` only after reviewing the dry-run removal report.

## First Handoff

```bash
recall handoff
recall token-saver
recall context receive --read-only --root . --target codex --format summary
```

The MCP server key may still be named `oaf` for compatibility with existing
configs. The public CLI command is `recall`.

