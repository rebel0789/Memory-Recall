# OAF Rust Source Graph Spec

Status: design reference for a future Rust source-graph engine. The verified Node OAF
runtime remains the conformance oracle until the Rust implementation reaches parity.

## Goal

Build a local-first, single-binary source graph that strengthens OAF's existing governed
memory, context compiler, loop governance, and replay surfaces. The Rust engine must make
repository structure cheaper to ingest and safer to query without changing OAF's authority
model.

Non-negotiable invariants:

- no network calls or model calls by default;
- proposal-gated writes for any durable memory or decision change;
- append-only history with validity intervals and supersession links;
- no hard deletes of user data;
- scoped repository access only;
- deterministic IDs and JSON-serializable events;
- safe Rust by default, with any `unsafe` block requiring a written justification and test.

## Core Capabilities

### Storage and Search

- SQLite-backed store with tables for projects, file hashes, entities, edges, facts,
  proposals, episodes, and content-addressed artifacts.
- FTS5 index over source symbols, fact text, repository paths, routes, and architecture
  summaries.
- Tokenization that preserves the original identifier and also indexes useful splits:
  camelCase, PascalCase, snake_case, digit boundaries, and colon-separated OAF IDs.
- Per-record provenance, source locator, trust label, lifecycle state, `validFrom`,
  optional `validUntil`, and optional `supersedes` links.

### Ingestion

- Bounded memory use with streaming buffers and a configurable memory ceiling.
- Incremental indexing through file hashes and git change detection.
- Language passes start narrow and proven: JavaScript/TypeScript first, then Python, Rust,
  and Go only after conformance fixtures exist.
- Repository manifests, package maps, route discovery, function/class/module extraction,
  imports, call edges, test ownership, and config/IaC references.
- Skipped files are reported with reason codes. A partial index never reports success
  without an explicit shortfall summary.

### Retrieval

- BM25 symbol and fact search.
- Graph neighborhood and path queries.
- Impact queries from changed files, touched symbols, route ownership, tests, and known
  decisions.
- Small temporal query subset with an `asOf` filter so superseded facts do not leak into
  current-truth answers.
- Optional semantic ranking may be added later, but it must remain disabled by default and
  cannot require network access.

### OAF Governance

The source graph is evidence for OAF. It is not authority.

- Model output never writes canonical graph or memory state directly.
- Retrieved content is untrusted data until policy evaluates it.
- Any durable memory, decision, or adapter change routes through proposal review.
- Tool calls carry policy receipts with side-effect class, matched rule, approval status,
  and selected/excluded context manifest.
- Replays and shadows disable consequential writes and never reuse approvals.

## Architecture

Keep the Rust workspace inside this repository so the Node oracle, protocol fixtures, and
real-repo scenarios can verify both implementations together.

Suggested crates:

- `oaf-store`: SQLite schema, migrations, FTS tokenization, governance lifecycle, and
  temporal records.
- `oaf-ingest`: repository discovery, language passes, package maps, route extraction, and
  bounded work queues.
- `oaf-search`: BM25, graph traversal, temporal filtering, and impact ranking.
- `oaf-brain`: context deltas, architecture overview, loop-governance evidence, and
  decision recall.
- `oaf-mcp`: stdio JSON-RPC server exposing read-only graph/context tools plus
  proposal-routed write tools.
- `oaf`: CLI and single-binary entry point.

The Node implementation stays the shipping product until parity is proven.

## Tool Surface

- `memory.recall`: current truth plus session delta.
- `memory.remember`: proposed write, never direct durable mutation.
- `memory.review`: pending proposal review.
- `memory.approve`: approval-routed activation.
- `context.profile`: repository/context profile.
- `context.pack`: budgeted context pack with selected and excluded records.
- `architecture.overview`: source-grounded architecture map.
- `graph.path`: path between entities.
- `graph.explain`: why a record or symbol was selected.
- `graph.query`: small, documented temporal graph query subset.
- `detect.changes`: impact evidence from changed files.
- `loop.verify`: check a proposed change against governed decisions.
- `manage.decision`: proposal-gated decision or ADR fact.

Every write-capable tool must be explicit about side effects and policy.

## Milestones

- M0: read-only store spike with deterministic IDs and FTS tokenization.
- M1: governed memory parity for remember, approve, supersede, and recall.
- M2: MCP server parity for the current OAF local handoff flow.
- M3: JavaScript/TypeScript ingestion with conformance fixtures and partial-index reporting.
- M4: graph path, impact query, temporal filter, and context-pack integration.
- M5: loop-governance evidence and architecture overview.
- M6: single-binary packaging, install receipts, checksums, and offline UI proof.
- M7: large-repo scale proof with real memory ceiling, skipped-file accounting, and honest
  token/context measurements.

## Failure Classes To Design Out

- Unbounded memory growth on large repositories.
- Silent partial indexing.
- Database corruption after process kill or lock contention.
- Scope escape outside the selected repository root.
- Ignoring `.gitignore` or `.git/info/exclude`.
- Unsafe temporary files.
- Runtime CDN or network calls in local UI.
- Shell injection in generated commands.
- Duplicate or low-confidence symbols silently treated as certain.
- Query syntax returning blank or wrong results instead of a clear unsupported-query error.

## Verification

Each milestone needs:

- schema validation;
- success and failure tests;
- workspace isolation tests;
- cancellation and timeout behavior;
- event and policy receipt assertions;
- real-repo measurement with exact commands;
- reproducible token/context savings report;
- docs that distinguish implemented behavior from design intent.

The stop condition for flipping the default from Node to Rust is byte-equivalent behavior
for overlapping outputs, passing protocol fixtures, passing real-repo scenarios, and a
checked-in readiness report that names remaining limitations.
