# Cursor Setup

Use this path when Cursor should read Memory Recall context for the current repository.

## Install

```bash
npm install -g memory-recall
recall setup
recall verify
```

## Preview Cursor MCP Setup

```bash
recall mcp install --client cursor --dry-run --format json
recall harness setup plan --client cursor --server oaf --dry-run --format json
recall harness setup status --client cursor --dry-run --format json
```

The preview shows the local read-only stdio server entry. It does not write
Cursor config until you apply a confirmed MCP install plan.

## Manual Server Command

Use this command if Cursor asks for a local MCP server command:

```bash
recall mcp server --read-only --root "$PWD" --sqlite "$PWD/.local/memory.sqlite" --stdio
```

Keep the server read-only. Memory Recall does not ship write-capable MCP tools
by default.

## Marketplace Position

Cursor has a public marketplace for plugins and MCP-backed workflows. The Memory
Recall listing should lead with:

- local repo memory and context for coding agents;
- no hosted account and no model API key;
- read-only MCP by default;
- proposal-gated memory, not silent transcript capture;
- measured context delivery reductions with reproducible commands.

Submit only after the GitHub repository, npm page, and screenshots are public
and consistent.

