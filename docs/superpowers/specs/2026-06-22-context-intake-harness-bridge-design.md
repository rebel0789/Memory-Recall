# OAF Context Intake Harness Bridge Design

Date: 2026-06-22
Status: proposed
Scope: OAF-031 candidate design; not implemented in the current release candidate

## Goal

Add a local-first context intake layer that lets OAF discover context already
maintained by developer harnesses such as Codex, Claude Code, Cursor, OpenCode,
Windsurf, and similar MCP-capable clients.

The feature should make setup simple for users without weakening OAF's core
guarantees:

- context remains manifest-backed and inspectable;
- imported memories become reviewable proposals, not active memory;
- hidden app state is not scraped;
- raw conversations, secrets, local paths, and credentials are not logged;
- external adapters, cloud memory, network access, and external writes remain
  disabled by default.

## Prior Art Checked

The GitHub search found useful harness-specific and memory-MCP prior art, but
not an existing project that provides OAF's full target: portable context
normalization, manifest-backed model calls, deterministic policy, reviewable
memory lifecycle, and side-effect-free handoff across harnesses.

Reference repositories:

| Project | Useful pattern | OAF boundary |
| --- | --- | --- |
| `supermemoryai/codex-supermemory` | Codex hook-based recall and capture, per-user and per-project tags, fallback commands | Do not send OAF context to Supermemory by default; use hooks as an optional disabled adapter reference |
| `supermemoryai/claude-supermemory` | Claude Code plugin shape, project config, command surface, signal extraction | Do not make Claude or Supermemory the authority for memory activation |
| `supermemoryai/cursor-supermemory` | Cursor plugin layout, MCP tools, session hooks, always-on rule, project config | Treat Cursor rules and memories as source candidates, not trusted policy |
| `supermemoryai/opencode-supermemory` | First-message context injection, keyword detection, codebase indexing, compaction handling | OAF should emit explicit manifests instead of invisible context injection |
| `supermemoryai/supermemory-mcp` | Universal memory MCP idea and simple client setup | OAF's read path can expose MCP resources, but write tools remain policy-gated |
| `supermemoryai/memorybench` | Provider comparison pipeline and separate quality, latency, token metrics | Use the benchmark shape for OAF memory/context regression tests, not as a runtime dependency |
| `supermemoryai/code-chunk` | AST-aware code chunking | Consider later as an optional candidate-source provider after license and checksum review |
| `supermemoryai/llm-bridge` | Cross-provider message conversion and observability | Useful reference for format adapters; OAF keeps canonical domain schemas |
| `supermemoryai/smfs` | Agent-oriented file and retrieval substrate | Research-only for now; no filesystem layer replacement in OAF core |
| `petabridge/memorizer`, `ipiton/agent-memory-mcp`, `jordanaftermidnight/localmem`, and similar MCP memory repos | Local MCP memory server patterns | Useful comparison set; most do not provide OAF's policy, approval, manifest, replay, and evidence guarantees |

## User Experience

The first public-beta experience should be read-only and preview-first:

```bash
npm run oaf -- context scan --from codex --dry-run
npm run oaf -- context scan --from claude --dry-run
npm run oaf -- context scan --from cursor --dry-run
npm run oaf -- context import --from codex --proposal-only
npm run oaf -- handoff export --for codex
```

The scan report shows:

- detected harnesses;
- files or config locations considered;
- items accepted, skipped, or redacted;
- data classes and scopes;
- secret and local-path redaction counts;
- proposed memory records;
- proposed evidence records;
- generated context manifest reference;
- disabled external adapter assertion.

The default mode writes nothing. Import mode writes only OAF-native records and
memory proposals after schema validation.

## Harness Sources

Scanners should use documented or user-visible files only. They must never read
private SQLite databases, app caches, hidden transcripts, browser storage,
cookies, tokens, or cloud account data unless a later reviewed adapter explicitly
permits that behavior.

Initial source map:

| Harness | Read-only sources | Output |
| --- | --- | --- |
| Codex | `AGENTS.md` chain, optional user-selected `~/.codex/memories` files, local skills metadata | governance candidates, project conventions, memory proposals |
| Claude Code | `CLAUDE.md`, `.claude/` project config, user-selected skill or command metadata | governance candidates, project conventions, memory proposals |
| Cursor | `.cursor/rules/*.mdc`, `.cursorrules`, `.cursor/mcp.json`, user-selected project config | governance candidates, MCP capability declarations, memory proposals |
| OpenCode | `opencode.jsonc`, project commands, plugin metadata, user-selected memory config | governance candidates, project conventions, memory proposals |
| Windsurf or Devin Desktop | documented rules and MCP config files only | governance candidates and capability declarations |
| Generic MCP client | user-provided MCP config file | capability declarations only |

## Domain Model

Add a provider-neutral `HarnessContextSource` schema with:

- `sourceId`: stable OAF ID;
- `harness`: enum such as `codex`, `claude-code`, `cursor`, `opencode`,
  `windsurf`, `generic-mcp`;
- `sourceKind`: `instruction`, `rule`, `memory`, `skill`, `mcp-config`,
  `command`, `profile`, `handoff`;
- `scope`: `user`, `workspace`, `repository`, `team`, or `unknown`;
- `trust`: `user-authored`, `tool-generated`, `external`, or `unknown`;
- `dataClass`: OAF data classification;
- `provenance`: sanitized locator and content hash;
- `reviewStatus`: `scan-only`, `proposed`, `accepted`, `rejected`,
  `quarantined`;
- `retention`: `session`, `workspace`, `durable`, or `unknown`;
- `bodyHash`: content hash;
- `summary`: bounded, sanitized summary for reports;
- `redactions`: counts and reason codes, not raw secret text.

The body itself should live in existing source snapshot or artifact providers
only when import is explicit. Reports and events must not include raw private
content.

## Data Flow

1. Resolve workspace and harness scanner.
2. Enumerate allowed files from documented paths.
3. Reject symlink escapes, oversized files, binary files, secret-like files, and
   unsupported extensions.
4. Parse structured formats with parsers where available.
5. Normalize each item into `HarnessContextSource`.
6. Classify data class, scope, trust, retention, and source kind.
7. Redact secrets and private local paths from report fields.
8. Convert accepted items into OAF context candidates.
9. Run the existing Context Compiler for a preview manifest.
10. If import is explicit, write OAF-native source snapshots, evidence records,
    and memory proposals only.
11. Emit sanitized events with counts, fingerprints, and schema versions.

## Authority Rules

Imported context cannot:

- change OAF policy;
- grant filesystem, network, model, tool, or secret access;
- activate permanent memory;
- enable adapters;
- enable external writes;
- start model calls by itself;
- mutate Agent Packs;
- publish, sync, or upload data.

Imported rules can be selected into model context as candidate governance
records, but OAF's policy evaluator remains the only source of authority.

## MCP Surface

Add a read-only OAF MCP bridge wrapper after the scanner exists:

- `resources/list`: context manifests, handoff bundles, status summaries;
- `resources/read`: sanitized manifest and report documents;
- `tools/list`: `oaf_context_scan`, `oaf_handoff_export`, and later
  `oaf_memory_proposal_create`;
- `tools/call`: disabled for writes unless an exact OAF grant exists.

The MCP surface must use the existing protocol bridge authority model and must
not start a public network listener.

## Supermemory Strategy

Supermemory should be treated as three things:

1. prior art for hook UX, container tags, explicit commands, and memory
   benchmark shape;
2. an optional future memory adapter target;
3. a comparison provider for evaluation, not the default memory layer.

Before any Supermemory adapter can be enabled, OAF needs:

- exact upstream commit pin;
- license and third-party notice review;
- checksum-verified package or source boundary;
- secret handling review;
- no raw prompt, output, transcript, credential, or local path logging;
- conformance fixtures;
- disabled-by-default catalog state;
- tests proving standard CI stays offline.

## Implementation Slices

### Slice 1: Read-only scanner and schema

- Add `harness-context-source.schema.json`.
- Add scanners for Codex, Claude Code, and Cursor documented files.
- Add dry-run CLI command.
- Add tests for missing files, symlink escape, secret redaction, oversized files,
  unknown formats, and deterministic fingerprints.

### Slice 2: Proposal-only import

- Convert scanner output into OAF context candidates.
- Create memory proposals, not active memories.
- Persist source snapshots only on explicit import.
- Add events with fingerprints and counts only.

### Slice 3: Handoff generation

- Export `.oaf/handoffs/<id>/HANDOFF.md`, `STATUS.json`,
  `CONTEXT_MANIFEST.json`, `EVENTS.jsonl`, and `CHECKS.sha256`.
- Generate harness snippets for Codex, Claude Code, and Cursor that point back
  to the OAF handoff instead of duplicating large context bodies.

### Slice 4: Read-only MCP wrapper

- Wrap `packages/protocol-bridges` with a stdio composition.
- Expose read-only resources first.
- Require exact grants before any future write tool.

### Slice 5: Evaluation and Supermemory comparison

- Add memory/context evaluation cases inspired by MemoryBench's separated
  quality, latency, and token reporting.
- Compare native OAF SQLite/FTS5 memory against optional adapters only outside
  default CI.

## Acceptance Criteria

- `npm run ci` passes with network disabled.
- `npm run protocol:validate` passes.
- Scanner tests prove no raw secrets, raw transcripts, raw prompts, raw outputs,
  credentials, provider URLs, private local paths, or hidden reasoning enter
  events or reports.
- Imported memories remain `proposed`, never `active`.
- Generated context manifests are schema-valid and reference imported source
  fingerprints.
- External adapters remain disabled.
- External writes remain false.
- Default model mode remains deterministic.
- The feature works without Supermemory, hosted models, cloud API keys,
  embeddings, vector databases, graph databases, browser automation, or
  publishing.

## Non-Goals

- No automatic upload to Supermemory or any cloud memory service.
- No broad app-data scraping.
- No private transcript ingestion by default.
- No hosted MCP server.
- No public network listener.
- No browser automation.
- No adapter activation.
- No production authentication changes.
- No claim that external harness memories are trusted OAF policy.

## Open Decisions

1. Whether user-level Codex memory files should be included by default or only
   through an explicit file allowlist. Recommended: explicit allowlist.
2. Whether generated harness snippets should live under `.oaf/harnesses/` or be
   printed to stdout only. Recommended: stdout first, file write later.
3. Whether the first CLI should be under the existing npm script surface or a
   new package binary. Recommended: existing npm script surface until package
   publishing is approved.
