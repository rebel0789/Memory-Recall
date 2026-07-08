# Open-Source Launch Plan

NPM is the primary install path. It is distribution, not discovery, so launch
needs the public surfaces below.

## Phase 1: NPM And GitHub

1. Publish `memory-recall` on npm.
2. Make the GitHub repository public after a final public-readiness scan.
3. Create a GitHub release with:
   - install command;
   - screenshot or README card;
   - compatibility matrix link;
   - verified local numbers;
   - safety defaults;
   - rollback and uninstall notes.

## Phase 2: Marketplace Listings

Prepare listing copy for:

- Cursor Marketplace plugins and MCP workflows;
- MCP directories or registries that accept local stdio servers;
- Claude Code docs-compatible MCP setup examples.

The listing angle should be narrow:

> Local repo memory and context for coding agents. No hosted account, no model
> API key, read-only MCP by default, proposal-gated memory, and reproducible
> context savings.

## Phase 3: App-Specific Installers

Document and harden:

- Codex CLI;
- Codex app;
- Claude Code;
- Claude Desktop when supported;
- Cursor.

Each installer should have dry-run, receipt, apply, and uninstall paths. No
installer should silently import transcripts, enable write tools, or broaden
permissions.

## Phase 4: Site And Visuals

Improve docs and visuals after the first public package is stable:

- public screenshots from the actual app;
- short terminal GIF or video;
- one-page docs hub;
- marketplace screenshots sized for each directory;
- public release notes with exact version and verification commands.

## Public Names

- Product: Memory Recall
- Package: `memory-recall`
- CLI: `recall`
- Compatibility MCP server key: `oaf`

