# Memory Recall Integrity And Consumer Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make published Memory Recall return the right governed facts, preserve proposal-gate integrity, and give installed users a truthful Memory Recall-first flow.

**Architecture:** Keep OAF protocol identifiers as compatibility internals while making public CLI/MCP output use Memory Recall. Cursor persistence becomes a privacy-safe fingerprint of result-shaping arguments. Proposal approval constructs the fact from the claimed payload inside one SQLite transaction. Consumer commands act on the target repository, while maintainer verification remains an explicit source-checkout script.

**Tech Stack:** Node.js 22 ESM, built-in `node:sqlite`, Node test runner, existing npm-pack consumer smoke.

## Global Constraints

- Keep `oaf` binary and `oaf://` protocol identifiers as compatibility aliases.
- Never expose raw query/objective text in persisted cursor keys.
- Default MCP recall/profile must return ACTIVE facts only; proposals require an explicit opt-in.
- Proposal approval must atomically claim, apply, materialize the exact payload, and update FTS/entity/edge projections.
- No hosted service, model call, network call, or runtime dependency is added.
- Public measurements must fail when token efficiency regresses rather than treating negative reduction as valid.

---

### Task 1: Recall Cursor And Clock Correctness

**Files:**
- Modify: `apps/cli/oaf.mjs`
- Modify: `tests/cli.test.mjs`

**Interfaces:**
- Produces `mcpCursorStoreKey({ workspaceId, toolName, args })` keyed by a SHA-256 fingerprint of result-shaping arguments excluding `client` and `since`.
- Produces per-request timestamps for `memory.recall` and `context.profile` handlers.

- [ ] Add a test where one client queries `alpha`, then `beta`, and receives the current `beta` fact without an inherited delta cursor.
- [ ] Run the test and verify it fails because the current cursor key omits the query.
- [ ] Add a test where a running MCP server serves a fact approved after initialization.
- [ ] Run the test and verify it fails because the server captures `fixedNow()` at startup.
- [ ] Add `mcpCursorRequestFingerprint(args)` using `stableStringify` over all arguments except `client` and `since`; include that fingerprint in the cursor key and persisted metadata.
- [ ] Compute `generatedAt` inside each MCP tool handler and pass it to payload builders.
- [ ] Run `node --test tests/cli.test.mjs` and verify the new regressions pass.

### Task 2: Proposal-Gate Integrity And Recall Trust Contract

**Files:**
- Modify: `providers/native/memory-sqlite/src/index.mjs`
- Modify: `apps/cli/oaf.mjs`
- Modify: `tests/native-memory-sqlite.test.mjs`
- Modify: `tests/cli.test.mjs`
- Modify: `docs/usage/mcp-server-reference.md`

**Interfaces:**
- `approveProposalFact()` creates a fact only from its claimed queue payload in one transaction.
- `memory.recall` and `context.profile` accept `includeProposals: boolean`, defaulting to `false`.

- [ ] Add a failing provider test proving an applied proposal cannot be used to create a fact with different subject, predicate, object, text, or source.
- [ ] Add a failing provider test proving a failed fact write leaves the queue record pending/claimable rather than applied.
- [ ] Add a failing MCP test proving default recall returns no proposal facts and `includeProposals: true` returns labeled proposals.
- [ ] Run those tests and verify the current implementation fails each assertion.
- [ ] Move queue claim/result update, episode, fact, FTS, entity, and edge writes into one `BEGIN IMMEDIATE` transaction; derive all canonical fact fields from the queued payload.
- [ ] Reject `memory fact add --proposal` as an unsupported bypass; preserve explicit proposal approval as the write path.
- [ ] Add `includeProposals` to both tool schemas and use it to gate proposal records.
- [ ] Render review summaries as `subject predicate = object` with a compact source reference.
- [ ] Run the focused provider/CLI tests and protocol validation.

### Task 3: Shared Relevance And Honest Recall Evidence

**Files:**
- Modify: `providers/native/memory-sqlite/src/index.mjs`
- Modify: `apps/cli/oaf.mjs`
- Modify: `tests/native-memory-hybrid-retrieval.test.mjs`
- Modify: `tests/cli.test.mjs`
- Modify: `evals/locomo/smoke.v1.json`

**Interfaces:**
- `searchTemporalMemory()` and MCP recall share a deterministic ranking order.
- BM25 normalization favors stronger FTS matches; confidence and token coverage are explicit ranking signals.

- [ ] Add a failing ranking test with strong and weak lexical matches asserting the strong match ranks first.
- [ ] Add a failing MCP test asserting MCP recall returns the same ordered fact IDs as the provider search for the same query.
- [ ] Add a failing LoCoMo smoke assertion requiring non-negative reduction for the bundled fixture.
- [ ] Run focused tests and verify each fails with current behavior.
- [ ] Normalize FTS ranks by ordered candidate position, combine lexical coverage, graph relation, temporal recency, and fact confidence, and expose the same ranker to MCP recall.
- [ ] Suppress generic `has_doc` and source-graph count proposals from normal ingest; retain only actionable structured facts and hotspots.
- [ ] Tighten the bundled LoCoMo fixture/gate so it fails on token inflation.
- [ ] Run focused ranking, CLI, and evaluation tests.

### Task 4: Installed CLI And MCP Identity

**Files:**
- Modify: `apps/cli/oaf.mjs`
- Modify: `scripts/bootstrap.mjs`
- Modify: `scripts/status.mjs`
- Modify: `packages/protocol-bridges/src/index.mjs`
- Modify: `tests/cli.test.mjs`
- Modify: `tests/usage-docs.test.mjs`

**Interfaces:**
- `recall setup` initializes target-repository `.local` state only.
- `recall verify` is a fast target-repository handoff check; `npm run verify:handoff` remains the maintainer suite.
- MCP initialize reports `memory-recall` and package version.

- [ ] Add failing packaged-install tests proving setup writes only under the target repository, verify does not invoke package CI, and MCP initialize returns Memory Recall identity.
- [ ] Add failing tests proving generated installed follow-up commands begin with `recall`, while source checkout commands use `npm run recall --`.
- [ ] Implement target-root setup without copying package `.env` or creating files in `node_modules`.
- [ ] Implement fast consumer verify as read-only handoff/MCP preflight; leave internal `verify-handoff.mjs` reachable only through npm scripts.
- [ ] Pass public name/version into `createMcpBridge` from the CLI.
- [ ] Update command emitters and status to use package metadata for public identity.
- [ ] Run packaged-install and focused CLI tests.

### Task 5: Public Surface And Evidence Cleanup

**Files:**
- Modify: `README.md`
- Modify: `docs/usage/local-agent-handoff.md`
- Modify: `docs/usage/mcp-server-reference.md`
- Modify: `PROJECT_STATUS.json`
- Modify: `apps/web/index.html`
- Modify: `apps/web/app.js`
- Modify: `services/control-api/src/server.mjs`
- Modify: `tests/web-shell.test.mjs`
- Modify: `tests/usage-docs.test.mjs`

**Interfaces:**
- Public quickstart is `npm install -g memory-recall` then `recall handoff`.
- Installed browser copy actions emit `recall`; source checkout actions emit `npm run recall --`.

- [ ] Add failing web/docs tests for stale Open Agent Fabric public copy, stale tarball version, and installed-mode `npm run oaf` commands.
- [ ] Update public title, server banner, copied commands, default filenames/objectives, status metadata, and release statements to Memory Recall 1.0.5 truth.
- [ ] Keep compatibility identifiers only where wire compatibility requires them.
- [ ] Run web-shell, usage-docs, consumer smoke, and browser smoke.

### Task 6: Final Verification

- [ ] Run `npm run check`.
- [ ] Run `npm run protocol:validate`.
- [ ] Run `npm test`.
- [ ] Run `npm run eval`.
- [ ] Run `npm run consumer:smoke` and `npm run consumer:browser-smoke`.
- [ ] Run `npm pack --dry-run` and confirm public files contain no stale first-use commands.
