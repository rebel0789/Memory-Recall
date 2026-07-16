# Memory Recall Polyglot Phase 3 Implementation Plan

> Status: approved under the active polyglot leadership goal. Routine local implementation, tests, evidence generation, and commits are pre-approved. Push, merge, publish, deploy, and public release remain outside this plan.

**Goal:** Replace the bounded JS/TS JSON runtime snapshot with a separate, versioned SQLite source index owned by the Rust engine. The index must persist all fourteen Tier 1 language graphs, refresh only affected scope, survive interruption and corruption, and serve bounded read-only queries without changing the public default before distribution gates pass.

**Architecture:** Add a dedicated `oaf-index` Rust crate. It owns source-index migrations, generation transactions, file manifests, normalized nodes, edges, unresolved relationships, evidence spans, coverage, and health records. `oaf-store` remains canonical governed memory and never imports source-index tables. The Rust code-intelligence subprocess gains closed index lifecycle and query operations; Node remains the bounded CLI/MCP/API facade. The existing JSON index stays available as a compatibility export during migration, but it is not the production storage model.

**Quality rule:** A no-change refresh writes zero database pages through the application path. A changed refresh reparses only added or content-changed files and re-resolves only their dependency closure. The previous committed generation remains queryable until the next generation commits. Corruption or schema mismatch never triggers silent deletion.

## Non-negotiable boundaries

- Canonical governed memory and derived source intelligence use separate SQLite files and schemas.
- Default CLI graph reads and all MCP reads remain on the current JS compatibility engine during Phase 3.
- Native index mutation requires an explicit local writer command; MCP, API reads, and web reads cannot create, migrate, refresh, repair, or delete an index.
- The npm package continues to bundle no native executable during Phase 3.
- Index records contain hashes, normalized locators, evidence spans, and bounded metadata, never raw source bodies, absolute checkout paths, credentials, environment values, or command output.
- File change detection uses content hashes. Size and modification time may avoid unnecessary hashing only when backed by a verified manifest state; they are not correctness evidence by themselves.
- Resolved records carry evidence and confidence. Unresolved relationships remain first-class records.
- Generation commits are atomic. Failed, cancelled, or killed refreshes cannot expose half-written graphs.
- Watch mode is opt-in, debounced, bounded, cancellable, and coalesces storms. It schedules the same explicit refresh pipeline and never changes memory.
- Doctor reports invalid, stale, migration-required, interrupted, and corrupt states. Repair is a plan until a separate explicit rebuild command is confirmed.
- Query responses are bounded and paginated. Full graph materialization remains a debug/export operation with fixed ceilings.
- No parity, leadership, multi-repository, or million-node claim changes in Phase 3.

## Storage layout

Default index path: `.local/source-index/index.v1.sqlite`

Required tables:

- `index_metadata`: schema version, engine version, repository identity, ignore fingerprint, active generation, created and updated timestamps;
- `index_migrations`: applied migration ID and checksum;
- `index_generations`: generation state, parent, reason, timestamps, counts, and structural fingerprint;
- `index_files`: generation, normalized locator, content hash, size, language, parse state, diagnostic count, and ownership identity;
- `index_nodes`: generation, canonical ID, kind, language kind, qualified name, locator, evidence span, content hash, and visibility;
- `index_edges`: generation, canonical ID, source, target, kind, locator, evidence span, resolver/version, confidence, resolution class, and stale state;
- `index_unresolved`: generation, source, relationship kind, target text hash, evidence span, resolver reason, and confidence class;
- `index_coverage`: generation, language, capability, represented/omitted/failed counts, and reason code;
- `index_health`: integrity result, interrupted generation evidence, last successful refresh, and repair recommendation;
- lexical search tables only after deterministic exact/path lookup is proven.

Historical generation retention is bounded. The active generation and one previous valid generation remain available by default; older generations are removed only inside a successful writer transaction.

## Task 1: Lock the Phase 3 storage and protocol contract

**Files:**

- Create: `docs/adr/0024-rust-sqlite-source-index.md`
- Create: `packages/protocol/schemas/code-intelligence-index-request.schema.json`
- Create: `packages/protocol/schemas/code-intelligence-index-response.schema.json`
- Create: valid and invalid protocol examples
- Modify: `examples/protocol/compatibility/fixtures.json`
- Modify: `packages/protocol/src/index.mjs`
- Modify: `packages/protocol/README.md`
- Create: `tests/code-intelligence-index-contract.test.mjs`

- [x] **Step 1: Write failing closed-schema tests**

Cover `index.build`, `index.refresh`, `index.status`, `index.doctor`, and bounded `index.query`. Reject absolute paths, source bodies, SQL text, unknown fields, unbounded limits, writer flags on read operations, and repair/delete authority in doctor requests.

- [x] **Step 2: Define safe lifecycle and query responses**

Responses expose repository identity hash, index locator, schema/engine versions, active generation, freshness, health, counts, timing, page cursor, bounded results, diagnostics, and safeguard counters. They never expose the local database path or raw SQLite errors.

- [x] **Step 3: Record the storage ADR and rollback boundary**

Document why source intelligence is not stored in `oaf-store`, why SQLite is owned by Rust, how the JSON compatibility index is retired later, and how a failed Phase 3 commit leaves JS public behavior intact.

- [x] **Step 4: Verify and commit**

Run focused protocol tests, full protocol validation, repository checks, and diff checks.

Commit: `feat: define sqlite source index contract`

## Task 2: Add the isolated Rust SQLite index and migrations

**Files:**

- Create: `rust/oaf-index/Cargo.toml`
- Create: `rust/oaf-index/src/lib.rs`
- Modify: `rust/Cargo.toml`
- Modify: `rust/Cargo.lock`
- Add focused crate tests

- [ ] **Step 1: Write failing creation, identity, and migration tests**

Prove secure parent/file permissions where supported, WAL and foreign-key settings, workspace identity binding, migration checksums, current/previous schema handling, and refusal of unknown newer schemas.

- [ ] **Step 2: Implement the schema and transactional migration runner**

Use bundled `rusqlite`. Apply ordered checksum-pinned migrations inside an exclusive transaction. Opening read-only never migrates or creates files.

- [ ] **Step 3: Implement health and integrity inspection**

Return stable health codes for absent, ready, stale, migration-required, interrupted, corrupt, wrong-repository, and unsupported-newer-schema states. Sanitize SQLite details.

- [ ] **Step 4: Prove interruption and corruption behavior**

Kill a writer before commit, corrupt a copy, and inject a partial generation. The active generation must remain valid or doctor must fail closed without deleting anything.

Commit: `feat: add isolated source index store`

## Task 3: Persist and query complete normalized generations

**Files:**

- Modify: `rust/oaf-index/src/lib.rs`
- Modify: `rust/oaf/src/code_intelligence.rs`
- Modify: `rust/oaf/Cargo.toml`
- Add Rust integration tests

- [ ] **Step 1: Write round-trip tests for every normalized record class**

Persist repository, file, declaration, node, resolved edge, unresolved relationship, evidence, coverage, diagnostic, and generation metadata. Reloading must reproduce the same structural fingerprint without source bodies.

- [ ] **Step 2: Implement atomic generation commits**

Write a staging generation, validate counts/references/duplicates, mark it committed, then switch `active_generation` in the same transaction. Keep one previous committed generation.

- [ ] **Step 3: Add bounded read-only queries**

Implement status, exact symbol/path lookup, neighborhood, dependency direction, trace, impact seed, route listing, and bounded graph summary. Enforce stable ordering, cursor validation, row/time/output limits, and read-only SQLite flags.

- [ ] **Step 4: Run all fourteen fixture graphs through SQLite**

The stored/reloaded graph fingerprint and exact sampled truth must match the in-memory Phase 2 graph for every language fixture.

Commit: `feat: persist normalized code intelligence generations`

## Task 4: Add content-hash incremental refresh and dependency invalidation

**Files:**

- Modify: `rust/oaf-ingest/src/lib.rs`
- Modify: `rust/oaf-index/src/lib.rs`
- Modify: `rust/oaf/src/code_intelligence.rs`
- Add mixed-language incremental fixtures and tests

- [ ] **Step 1: Write add/change/delete/rename/no-change tests**

Cover same-size same-mtime content changes, file rename, directory rename, ignore-rule changes, branch-like replacement, malformed changed files, and deleted dependency targets.

- [ ] **Step 2: Build a deterministic invalidation closure**

Start with changed file owners; include direct importers, callers with typed/exact targets, heritage dependents, re-exporters, route owners, and config/package dependents. Bound traversal and report omissions.

- [ ] **Step 3: Reparse and re-resolve only affected scope**

Reuse unchanged file records. Remove deleted ownership records. Preserve repository-level partial coverage if one file fails. A no-change refresh returns the current generation and performs no writer transaction.

- [ ] **Step 4: Prove incremental equals clean rebuild**

For mixed-language fixtures and selected pinned repositories, compare canonical nodes, edges, unresolved records, coverage, and structural fingerprint after incremental refresh versus a clean build.

Commit: `feat: add dependency aware incremental indexing`

## Task 5: Add bounded watch scheduling and concurrency control

**Files:**

- Create: `rust/oaf-index/src/watcher.rs`
- Modify: `rust/oaf-index/src/lib.rs`
- Modify: `rust/oaf/src/main.rs`
- Add watcher/concurrency tests

- [ ] **Step 1: Write debounce, storm, cancellation, and clean-shutdown tests**

Model editor temporary-file sequences, 10,000-event storms, overlapping refresh requests, rename pairs, directory replacement, watcher overflow, SIGINT, and killed workers.

- [ ] **Step 2: Implement one bounded coalescing queue per repository**

Use a fixed queue and debounce window. Coalesce paths and fall back to a bounded metadata/hash discovery after overflow. Only one writer runs per repository; readers continue using the active generation.

- [ ] **Step 3: Expose watcher state without write authority**

Status reports running/stopped/degraded, queued path count, overflow count, last convergence duration, and last safe reason code. MCP reads status only.

- [ ] **Step 4: Prove convergence**

After every tested storm, the final active fingerprint must equal a clean rebuild and the queue must drain within the documented bound.

Commit: `feat: add bounded source index watcher`

## Task 6: Add doctor, migrations, and explicit repair planning

**Files:**

- Modify: Rust index/store and protocol adapters
- Modify: Node CLI help and command routing
- Add doctor/repair fixtures and tests

- [ ] **Step 1: Add failure fixtures**

Cover corrupt header/pages, failed integrity check, missing tables, checksum mismatch, interrupted staging generation, wrong repository identity, stale engine version, and unsupported future schema.

- [ ] **Step 2: Implement read-only doctor**

Doctor never creates or mutates the database. It emits a sanitized diagnosis, whether the last valid generation is readable, and an exact repair plan fingerprint.

- [ ] **Step 3: Implement explicit rebuild repair**

Repair requires a prior doctor plan and matching confirmation. It renames the invalid database to a bounded local backup, builds a new database, verifies it, and only then offers backup cleanup as a separate action.

- [ ] **Step 4: Prove rollback and backup behavior**

Failed repair restores the prior path; successful repair leaves a readable backup and current index. No memory database is touched.

Commit: `feat: add source index diagnosis and repair`

## Task 7: Bridge the native index through Node without promoting defaults

**Files:**

- Modify: engine request/response schemas and Rust stdio server
- Modify: native provider and provider port
- Modify: CLI graph index lifecycle
- Modify: MCP structural tools to read an explicitly selected native index in preview tests only
- Add packed-consumer and zero-write tests

- [ ] **Step 1: Add bounded provider lifecycle methods**

Node sends closed lifecycle/query frames and enforces timeout, cancellation, stdout/stderr byte limits, workspace containment, protocol version, and safe errors.

- [ ] **Step 2: Add explicit preview CLI commands**

Build, refresh, status, doctor, watch, and query require `--engine native-preview`; writer commands require explicit write/confirmation flags. Existing JS JSON index commands remain compatible.

- [ ] **Step 3: Prove twelve MCP tools are read-only**

Run every structural MCP tool against a prebuilt native SQLite index. Database hashes/mtime and governed memory remain unchanged. MCP never falls back to building or refreshing.

- [ ] **Step 4: Prove packed-package behavior**

The npm tarball contains protocols and wrappers but no binary. With an explicit verified local binary, restart/build/refresh/query work in an isolated repository. Without it, preview fails closed and JS stays default.

Commit: `feat: bridge persistent native source index`

## Task 8: Benchmark and close Phase 3

**Files:**

- Create: reproducible Phase 3 benchmark script and evidence report
- Modify: capability/support docs, benchmarks, status, changelog, release evidence, handoff, and manifest
- Modify: this plan

- [ ] **Step 1: Run migration, corruption, concurrency, and restart gates**

Run focused Rust/Node suites plus full repository, protocol, evaluation, package, release, and handoff gates.

- [ ] **Step 2: Run bounded repository performance cases**

Measure cold build, warm open, no-change refresh, one-file refresh, dependency-closure refresh, exact lookup, neighborhood, trace, impact seed, database size, RSS, and response bytes on fixtures and selected pinned repositories.

- [ ] **Step 3: Publish exact limits and failures**

Name platform, commits/scopes, file/node/edge counts, generation counts, percentiles, queue bounds, omissions, and failure recovery. Keep million-node, multi-repository, parity, and leadership unmeasured.

- [ ] **Step 4: Close Phase 3 on a clean additive commit**

Commit: `docs: close polyglot phase three`

## Full Phase 3 gate

```bash
npm run check
npm run protocol:validate
npm test
npm run eval
cargo fmt --manifest-path rust/Cargo.toml --all -- --check
cargo test --manifest-path rust/Cargo.toml
cargo clippy -p oaf-index --all-targets --no-deps -- -D warnings
cargo clippy -p oaf-ingest --all-targets --no-deps -- -D warnings
node scripts/native-code-intelligence-consumer-smoke.mjs
node scripts/code-intelligence-phase2-tier1.mjs --check
node scripts/code-intelligence-phase3-index.mjs --check
npm run verify:handoff
npm run release:readiness:check
git diff --check
```

Workspace-wide Clippy debt outside the changed crates remains separately reported until fixed; no Phase 3 code may add new warnings.

## Rollback

Phase 3 remains additive and preview-only. Revert the failing task commit. The current JS graph, JSON compatibility index, MCP behavior, governed memory, and packed npm path remain available. Never delete or overwrite a corrupt index during rollback; preserve it for doctor evidence and rebuild only through the explicit repair flow.

## Phase 4 handoff

Phase 4 begins only after SQLite generations, incremental invalidation, watch convergence, migrations, corruption recovery, packed preview behavior, and bounded query performance are proven. It builds hybrid search, communities, execution processes, richer routes/impact, and constrained graph-query operations on the persistent query layer rather than loading the full graph into Node.
