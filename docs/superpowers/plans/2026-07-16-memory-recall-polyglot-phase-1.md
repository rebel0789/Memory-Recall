# Memory Recall Polyglot Leadership Phase 1 Implementation Plan

> **Execution mode:** Use `superpowers:executing-plans` and test-driven development. Complete tasks in order, check each step only after its command and artifact are verified, and keep the existing JS/TS engine as the public default throughout this phase.

**Goal:** Connect the Node product shell to the Rust code-intelligence engine through a versioned, bounded, provider-neutral subprocess port. Prove useful JS/TS compatibility, read-only behavior, deterministic fingerprints, cancellation, process isolation, stable errors, and packed-consumer behavior before exposing the native path as an explicit preview.

**Stop condition:** Phase 1 is complete only when all focused tests, Rust tests, protocol fixtures, consumer-package checks, full repository CI, handoff verification, and release-readiness checks pass. The native engine must not become the default in this phase.

**Architecture:** The Rust binary accepts JSON Lines requests on stdin and emits protocol frames only on stdout. Node owns process lifecycle, request validation, workspace containment, deadlines, cancellation, output bounds, response validation, and translation into the existing source-graph compatibility contract. The Rust result uses `code-intelligence-graph.schema.json`; the existing source graph remains the UI, CLI, API, and MCP compatibility shape until later migration gates pass.

**Safety boundary:** Scanning is local and read-only. No network, model, canonical-memory, index, configuration, or external writes are permitted. Absolute filesystem roots, source bodies, environment values, raw parser errors, provider IDs, and Tree-sitter implementation names must not cross the public protocol.

---

## Task 1: Define the native engine protocol

**Files:**

- Create: `packages/protocol/schemas/code-intelligence-engine-request.schema.json`
- Create: `packages/protocol/schemas/code-intelligence-engine-response.schema.json`
- Create: `examples/protocol/code-intelligence-engine-request.json`
- Create: `examples/protocol/code-intelligence-engine-response.json`
- Create: `examples/protocol/compatibility/invalid/code-intelligence-engine-request-absolute-root.json`
- Create: `examples/protocol/compatibility/invalid/code-intelligence-engine-response-raw-error.json`
- Modify: `examples/protocol/compatibility/fixtures.json`
- Modify: `packages/protocol/README.md`
- Modify: `rfcs/0001-protocol-contracts.md`
- Modify: `tests/code-intelligence-contract.test.mjs`

- [x] **Step 1: Add failing protocol tests**

Test a valid `graph.build` request and success response. Reject unknown major protocol versions, absolute or traversing roots, unbounded limits, additional properties, source bodies, raw error text, and absolute paths in error details.

Run: `node --test tests/code-intelligence-contract.test.mjs`

Expected: new assertions fail because the schemas and fixtures do not exist.

- [x] **Step 2: Add closed, additive v1 schemas and fixtures**

Use protocol version `1.0.0`, bounded request IDs, workspace IDs, relative root `.` only, operation `graph.build`, a deadline duration, optional cancellation token, requested graph schema version, and bounded graph arguments. Responses are a success frame containing the provider-neutral graph or a failure frame containing only a stable code, retryability, and bounded sanitized details.

- [x] **Step 3: Verify and commit the protocol**

Run: `node --test tests/code-intelligence-contract.test.mjs && npm run protocol:validate && git diff --check`

Commit: `feat: define native code intelligence protocol`

## Task 2: Implement the Rust JSON Lines engine

**Files:**

- Modify: `rust/oaf/src/main.rs`
- Modify: `rust/oaf-ingest/src/lib.rs` only if public structured extraction metadata is required
- Add focused Rust unit tests beside the implementation
- Create: `scripts/rust-code-intelligence-protocol-quality.mjs`
- Modify: `package.json`

- [x] **Step 1: Add failing Rust and process-level tests**

Cover one valid JS/TS workspace, deterministic generation and graph fingerprints, strict request parsing, unsupported operation/version, malformed JSON, bounded files and output, multiple JSON Lines requests, stdout protocol purity, sanitized stderr, and no local writes.

- [x] **Step 2: Add `code-intelligence serve --stdio`**

Translate existing Rust extraction facts into the provider-neutral graph. Emit stable repository, file, symbol, module, route, definition, import, call, and route-handler nodes/edges where evidence exists. Keep IDs content-derived, sort every collection, cap nodes/edges/diagnostics, and compute fingerprints from canonical structural content rather than timestamps.

- [x] **Step 3: Enforce the native boundary**

Resolve the workspace from the child process working directory, accept relative root `.` only, reject writes and network-requiring operations, check deadlines before and after extraction, emit stable error frames, and never print raw source, absolute paths, environment values, or parser internals.

- [x] **Step 4: Verify and commit the engine**

Run: `cd rust && cargo fmt --all -- --check && cd .. && cargo test --manifest-path rust/Cargo.toml && cargo build --release --manifest-path rust/Cargo.toml && node scripts/rust-code-intelligence-protocol-quality.mjs && git diff --check`

Commit: `feat: add bounded rust code intelligence engine`

## Task 3: Add the Node native provider port

**Files:**

- Create: `providers/native/code-intelligence-rust/provider.json`
- Create: `providers/native/code-intelligence-rust/src/index.mjs`
- Modify: `providers/native/catalog.json`
- Modify: `packages/protocol/src/index.mjs` as needed for shared validation exports
- Create: `tests/native-code-intelligence-provider.test.mjs`

- [x] **Step 1: Add failing provider-boundary tests**

Cover binary discovery, explicit override, request/response validation, workspace containment, timeout, abort signal, stdin closure, stdout/stderr byte caps, nonzero exit, malformed frames, duplicate terminal frames, request-ID mismatch, schema-invalid graph, missing binary, and child cleanup.

- [x] **Step 2: Implement the dependency-free subprocess wrapper**

Spawn one request per child for Phase 1. Set the child working directory to the verified workspace, pass only an allowlisted environment, close stdin after one JSON Line, validate the terminal frame and graph, terminate on timeout/cancel/overflow, and expose stable provider-neutral errors.

- [x] **Step 3: Register the provider without changing defaults**

Document it as local, read-only, preview-only, no-network, no-model, no-write, and dependent on a verified native binary. Do not silently compile Rust or silently choose a weaker engine when `native-preview` is explicitly requested.

- [x] **Step 4: Verify and commit the provider**

Run: `node --test tests/native-code-intelligence-provider.test.mjs tests/adapter-contracts.test.mjs tests/protocol-schema-validator.test.mjs && git diff --check`

Commit: `feat: add native code intelligence provider port`

## Task 4: Translate native graphs into the existing compatibility surface

**Files:**

- Create: `packages/source-graph/src/native-compatibility.mjs`
- Modify: `packages/source-graph/src/index.mjs`
- Modify: `packages/source-graph/src/intelligence.mjs`
- Create: `tests/source-graph-native-compatibility.test.mjs`

- [ ] **Step 1: Add failing translation and parity tests**

Use representative JS, TS, TSX, imports, exports, classes, methods, calls, routes, and malformed files. Compare stable developer-facing facts rather than provider-specific IDs: represented file locators, declared symbol names and locators, resolved import relationships, call relationships, route handlers, diagnostics, and coverage.

- [ ] **Step 2: Implement the pure compatibility translator**

Convert the provider-neutral graph to the closed `source-graph.schema.json` shape. Preserve locators and evidence, derive compatibility IDs and summary fields deterministically, map only supported kinds and edges, report omitted native constructs explicitly, and validate the translated graph before returning it.

- [ ] **Step 3: Add engine selection behind the source-graph port**

Support `js` as the unchanged default, `native-preview` as strict native execution, and `compatibility` as a test/evidence mode that runs both and returns the native graph plus an evidence-bearing comparison. Never silently fall back when strict native preview is selected.

- [ ] **Step 4: Verify and commit compatibility**

Run: `node --test tests/source-graph-native-compatibility.test.mjs tests/source-graph-preview.test.mjs tests/source-graph-index-store.test.mjs && git diff --check`

Commit: `feat: bridge native intelligence to source graph`

## Task 5: Expose a safe explicit preview and prove MCP read isolation

**Files:**

- Modify: `apps/cli/oaf.mjs`
- Modify: `apps/cli/help.mjs`
- Modify: `packages/recall-map/src/index.mjs` only if the preview can reuse its provider port without changing the default
- Modify: `tests/cli-graph-index.test.mjs`
- Modify: `tests/mcp-code-intelligence.test.mjs`
- Create or modify focused CLI tests for engine selection

- [ ] **Step 1: Add failing CLI and MCP tests**

Require `--engine js|native-preview|compatibility` on graph read commands with `js` as default. Prove explicit native preview works with a local verified binary, missing native binary fails clearly, invalid engine values return exit code 2, and MCP reads never build an index or mutate workspace state.

- [ ] **Step 2: Wire the preview through the provider port**

Pass engine selection only to read-only graph preview/intelligence calls. Surface engine, compatibility status, coverage, and safe diagnostics in JSON. Keep summary output short and do not claim parity from one fixture.

- [ ] **Step 3: Verify and commit the preview**

Run: `node --test tests/cli-graph-index.test.mjs tests/mcp-code-intelligence.test.mjs tests/cli.test.mjs && git diff --check`

Commit: `feat: expose native graph preview`

## Task 6: Prove isolated packed-consumer behavior

**Files:**

- Create: `scripts/native-code-intelligence-consumer-smoke.mjs`
- Modify: `scripts/consumer-smoke.mjs` or release-readiness checks only where the new proof belongs
- Modify: `package.json` package allowlist only if Phase 1 runtime files are missing
- Modify: `tests/release-regressions.test.mjs`

- [ ] **Step 1: Add a failing packed-product test**

Pack the npm tarball, install it into an isolated temporary home and repository, provide the locally built native binary only through the documented preview override, run one native preview, verify the graph contract, then remove the override and verify a clear unavailable error. Prove no network, model, canonical-memory, config, or unexpected workspace writes.

- [ ] **Step 2: Make the smallest package-boundary correction**

Include only the provider, protocol, translator, and runtime files required by Phase 1. Do not ship checkout-only corpus, benchmark results, Rust build output, or toolchain dependencies. Signed platform binary distribution remains Phase 6.

- [ ] **Step 3: Verify and commit the consumer proof**

Run: `node scripts/native-code-intelligence-consumer-smoke.mjs && node --test tests/release-regressions.test.mjs && npm pack --dry-run --json`

Commit: `test: prove packed native intelligence preview`

## Task 7: Record honest Phase 1 evidence and close the milestone

**Files:**

- Create: `evals/code-intelligence/results/phase1-js-ts-compatibility.json`
- Create: `scripts/code-intelligence-phase1-compatibility.mjs`
- Modify: `evals/code-intelligence/capability-matrix.v1.json`
- Modify: `docs/usage/code-intelligence-support.md`
- Modify: `docs/usage/support-matrix.md`
- Modify: `docs/usage/rust-acceleration.md`
- Modify: `docs/benchmarks.md`
- Modify: `PROJECT_STATUS.json`
- Modify: `CHANGELOG.md`
- Modify: `HANDOFF_VERIFICATION.json`
- Modify: `REPOSITORY_MANIFEST.json`
- Modify: this plan

- [ ] **Step 1: Add the reproducible compatibility evidence runner**

Run both engines on deterministic local fixtures and at least two pinned real JS/TS repositories from the Phase 0 corpus. Record exact commit, platform, engine versions, graph fingerprints, bounded capability counts, compatibility dimensions, failures, and thresholds. Do not store raw source, checkout paths, environment values, or competitor claims.

- [ ] **Step 2: Update claims only from passing evidence**

Mark only the JS/TS native-preview capabilities actually demonstrated. Keep the JS/TS public default unchanged, every other language experimental or unmeasured as appropriate, and parity/leadership false until later gates prove them.

- [ ] **Step 3: Run the complete Phase 1 gate**

Run:

```bash
npm run check
npm run protocol:validate
npm test
npm run eval
cargo test --manifest-path rust/Cargo.toml
node scripts/rust-code-intelligence-protocol-quality.mjs
node scripts/native-code-intelligence-consumer-smoke.mjs
node scripts/code-intelligence-phase1-compatibility.mjs --check
npm run verify:handoff
npm run release:readiness:check
git diff --check
```

Expected: every command passes with the native engine still preview-only and the JS/TS engine still the public default.

- [ ] **Step 4: Commit Phase 1 closure and verify a clean boundary**

Commit: `docs: close polyglot phase one`

Run: `git status --short --branch && git log -12 --oneline`

Expected: clean worktree on `codex/memory-recall-orientation-workbench`.

## Rollback

Every task is an additive commit. Before Phase 1 closes, rollback is a commit-level revert. Runtime rollback is immediate because `js` remains the default and the preview flag is opt-in. Delete any derived preview output; canonical memory and the existing source-graph index are untouched.

## Phase 2 handoff

Phase 2 may begin only after this plan is fully checked and committed. Its first work is language-batch fixture evidence against the provider-neutral graph, not changing the public default or claiming all-language parity.
