# Recall Developer-First Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a developer-first, local, trustworthy `recall map` experience that unifies existing source-graph, governed-memory, handoff, and readiness data; make it the public first win; and remove only verified junk or stale public truth.

**Architecture:** Add a provider-neutral `packages/recall-map` composer that reads existing bounded source-graph and SQLite-memory surfaces without changing canonical state. CLI, control API, static web, and later MCP consume one versioned `RecallMapReport` with a stable fingerprint. The source graph remains the Node JS/TS shipping engine; Rust remains clearly labelled experimental until a parity contract exists.

**Tech Stack:** Node 22 ESM, SQLite/FTS5 native memory provider, existing JS/TS static source graph, static browser UI, Node test runner, JSON Schema, npm package smoke tests.

## Global Constraints

- The public product name is **Memory Recall**; `oaf` stays only as an explicitly documented compatibility alias.
- `recall map` is read-only: no canonical-memory writes, network/model calls, external adapters, hooks, or raw source-body delivery.
- Version 1 supports **JS/TS static graph analysis only**. It must report partial/unsupported coverage rather than implying broad language support.
- ACTIVE facts, PENDING proposals, stale facts, and unavailable stores remain visibly separate.
- All quickstart and benchmark claims must be executable against the packed npm artifact, not only the source checkout.
- Do not import, vendor, or copy competitor source; feature behavior and documentation structure must be independently implemented.
- Keep existing `oaf://` resource URIs, `skill:oaf-memory`, and the `oaf` binary alias compatible through this release.
- Every production behavior starts with a focused failing test. Run `npm run ci` before a task is accepted.
- Never delete `.env`, `.local`, historical ADRs, or release evidence without an explicit migration and a passing reference audit.

---

### Task 1: Establish Memory Recall public truth and safe-cleanup guardrails

**Files:**
- Create: `docs/product/memory-recall-developer-first.md`
- Create: `docs/usage/oaf-compatibility.md`
- Modify: `README.md`
- Modify: `docs/usage/README.md`
- Modify: `docs/usage/local-agent-handoff.md`
- Modify: `docs/usage/security-model.md`
- Modify: `tests/docs.test.mjs`
- Delete: `scripts/rust-current-truth-conflicts-quality.mjs`
- Delete: `scripts/rust-inspectable-session-demo.mjs`
- Delete: `scripts/rust-routes-imports-quality.mjs`
- Delete: `scripts/rust-taint-policy-quality.mjs`

**Interfaces:**
- Produces the single public capability vocabulary used by README, CLI help, web, and benchmark documentation: `implemented`, `experimental`, `unsupported`.
- Produces `docs/usage/oaf-compatibility.md` as the only normal-user documentation location for legacy identifiers.
- Records the public-copy migration boundary: normal quickstarts use `recall`; compatibility identifiers remain documented but are not removed from protocol contracts.

- [ ] **Step 1: Write failing public-truth tests**

```js
test('public quickstart describes target-repository setup and Recall Map', async () => {
  const guide = await readFile('docs/usage/local-agent-handoff.md', 'utf8');
  assert.match(guide, /recall setup/);
  assert.doesNotMatch(guide, /memory-recall-1\.0\.3\.tgz/);
  assert.doesNotMatch(guide, /setup is checkout bootstrap/);
});
```

- [ ] **Step 2: Run the focused docs test and verify RED**

Run: `node --test tests/docs.test.mjs`

Expected: FAIL because stale tarball/setup copy still describes the source checkout instead of the target repository.

- [ ] **Step 3: Write the developer-first contract and repair public instructions**

```md
# Memory Recall: Developer-First Product Contract

## First win

`recall setup` initializes local Recall state in the current repository.
The developer-first Recall Map described here is implemented in the following release task; public quickstarts do not advertise it until its CLI test passes.

## Support contract

- Implemented: local JS/TS static graph, reviewed SQLite memory, read-only MCP.
- Experimental: Rust acceleration paths when explicitly invoked.
- Unsupported: automatic transcript capture, write-capable MCP, hosted sync, and non-JS/TS source graph analysis.
```

Update the quickstart to show the current tested `npm install -g memory-recall`, `recall setup`, and `recall handoff` path. Move normal-user references to `oaf` into `docs/usage/oaf-compatibility.md`; do not alter protocol identifiers or executable aliases. Task 4 adds `recall map` to the public quickstart after the command exists.

Delete only the four verified unreferenced Rust quality scripts. Do not touch generated release evidence, backlog/status infrastructure, `.local`, `.env`, or historical plans in this task.

- [ ] **Step 4: Add the check rule and rerun focused tests**

Run: `node --test tests/docs.test.mjs`

Expected: PASS; stale tarball/setup copy is rejected and the compatibility page exists.

- [ ] **Step 5: Commit the self-contained truth/cleanup task**

```bash
git add README.md docs/product/memory-recall-developer-first.md docs/usage tests/docs.test.mjs scripts/rust-*.mjs
git commit -m "docs: establish developer-first Recall truth"
```

### Task 2: Define and test the read-only Recall Map report contract

**Files:**
- Create: `packages/recall-map/package.json`
- Create: `packages/recall-map/src/index.mjs`
- Create: `packages/protocol/schemas/recall-map.schema.json`
- Create: `examples/protocol/recall-map.json`
- Modify: `packages/protocol/schemas/index.mjs`
- Modify: `tests/protocol.test.mjs`
- Create: `tests/recall-map.test.mjs`

**Interfaces:**

```js
export async function buildRecallMap({
  root,
  workspaceId = 'ws_local',
  changedLocators = [],
  query = '',
  clock = () => new Date().toISOString()
} = {})
```

It returns:

```js
{
  schemaVersion: '1.0.0',
  reportVersion: 'memory-recall-map-1.0.0',
  workspaceId,
  generatedAt,
  support: { sourceGraph: { status, languages, coverage }, memory: { status } },
  architecture: { entryPoints, hotspots, search, impact, diagnostics },
  memory: { activeFacts, pendingProposals, staleFactCount, unavailableReason },
  readiness: { handoff, mcp, nextCommands },
  safeguards: { readOnly: true, canonicalStateMutated: false, networkCalls: 0, modelCalls: 0, rawSourceBodiesIncluded: false },
  fingerprint: 'sha256:...'
}
```

- [ ] **Step 1: Write a failing contract test**

```js
test('Recall Map composes bounded architecture and governed-memory truth without writes', async (t) => {
  const root = await fixtureWorkspace(t, { files: { 'src/index.ts': 'export function start() {}' } });
  const report = await buildRecallMap({ root, changedLocators: ['src/index.ts'], clock: () => '2026-07-10T00:00:00.000Z' });
  assertJsonSchema(recallMapSchema, report, 'Recall Map');
  assert.equal(report.safeguards.readOnly, true);
  assert.equal(report.safeguards.canonicalStateMutated, false);
  assert.equal(report.safeguards.rawSourceBodiesIncluded, false);
  assert.equal(report.architecture.impact.changedLocators[0], 'src/index.ts');
  assert.deepEqual(report.memory.activeFacts, []);
  assert.deepEqual(report.memory.pendingProposals, []);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test tests/recall-map.test.mjs`

Expected: FAIL because `packages/recall-map` and the protocol schema do not exist.

- [ ] **Step 3: Implement the smallest composer**

`buildRecallMap` must call existing `buildSourceGraphPreview` and SQLite provider read APIs. It must summarize only locator-safe values, calculate a deterministic SHA-256 fingerprint from the report excluding `generatedAt`, and return an explicit unavailable result if the graph or memory store is unavailable. It must not create a SQLite database when no store exists.

- [ ] **Step 4: Add schema and fixture validation**

The schema must reject raw source-body fields, `canonicalStateMutated: true`, external network/model calls, and pending proposals inside `activeFacts`.

- [ ] **Step 5: Verify GREEN**

Run: `node --test tests/recall-map.test.mjs tests/protocol.test.mjs`

Expected: PASS with valid and invalid Recall Map fixtures.

- [ ] **Step 6: Commit the report contract**

```bash
git add packages/recall-map packages/protocol/schemas examples/protocol tests/recall-map.test.mjs tests/protocol.test.mjs
git commit -m "feat: add read-only Recall Map report"
```

### Task 3: Improve source-graph architecture ranking before exposing Recall Map

**Files:**
- Modify: `providers/native/context-candidate-ast-code/src/index.mjs`
- Modify: `packages/source-graph/src/index.mjs`
- Modify: `tests/source-graph-preview.test.mjs`
- Create: `evals/recall-map/architecture-ranking.v1.json`
- Create: `tests/recall-map-ranking.test.mjs`

**Interfaces:**

```js
export function rankArchitectureNodes(graph, { changedLocators = [], query = '', limit = 20 } = {})
```

The function returns locator-safe `entryPoints`, `hotspots`, and `deprioritized` diagnostics. Exported route handlers, package entry points, executable scripts, and changed symbols score above private methods, generic assertion helpers, test-only nodes, and low-signal byte/count utilities.

- [ ] **Step 1: Write a failing ranking fixture**

```js
test('architecture ranking promotes exported entry points over generic helpers', async (t) => {
  const root = await fixtureWorkspace(t, {
    files: {
      'src/server.ts': 'export async function startServer() { return assertPlainObject({}); }',
      'src/assert.ts': 'export function assertPlainObject(value) { return value; }',
      'test/server.test.ts': 'function byteLength() { return 0; }'
    }
  });
  const report = await buildSourceGraphPreview({ root, query: 'where should I start' });
  assert.equal(report.graph.summary.entryPoints[0].label, 'startServer');
  assert.notEqual(report.graph.summary.entryPoints[0].label, 'assertPlainObject');
});
```

- [ ] **Step 2: Run the ranking test and verify RED**

Run: `node --test tests/recall-map-ranking.test.mjs`

Expected: FAIL because generic helpers can currently outrank entry points.

- [ ] **Step 3: Implement bounded deterministic ranking**

Add an explicit signal table, not an opaque heuristic: exported route/module entry point, package/bin entry, changed-file membership, inbound/outbound degree, test locator penalty, private label penalty, and generic utility-name penalty. Preserve all raw graph nodes internally; only change summary/ranked report order and report the reason codes.

- [ ] **Step 4: Add coverage and unsupported-language diagnostics**

Ensure graph summaries identify represented JS/TS files, skipped files, oversized files, and unsupported extensions. Do not claim a complete graph when input contains unsupported source files.

- [ ] **Step 5: Verify GREEN and the quality fixture**

Run: `node --test tests/source-graph-preview.test.mjs tests/recall-map-ranking.test.mjs`

Expected: PASS; `architecture-ranking.v1.json` has deterministic expected top entry points and impact coverage.

- [ ] **Step 6: Commit graph quality work**

```bash
git add providers/native/context-candidate-ast-code packages/source-graph tests evals/recall-map
git commit -m "feat: rank Recall Map architecture signals"
```

### Task 4: Ship `recall map` as the first developer command

**Files:**
- Modify: `apps/cli/oaf.mjs`
- Modify: `apps/cli/AGENTS.md`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/usage/README.md`
- Modify: `docs/usage/local-agent-handoff.md`
- Modify: `tests/cli.test.mjs`
- Modify: `tests/consumer-smoke.test.mjs` or `scripts/consumer-smoke.mjs`
- Create: `docs/usage/recall-map.md`

**Interfaces:**

```text
recall map [--root .] [--sqlite .local/memory.sqlite] [--changed-from-git]
           [--changed path/to/file] [--query text] [--format json|summary|markdown]
```

Exit behavior: `0` for a complete or partial safe report, `2` for invalid arguments, and no workspace mutation in every mode.

- [ ] **Step 1: Write failing CLI tests**

```js
test('recall map is a read-only first-run report', () => {
  const result = runRecall(['map', '--root', root, '--changed', 'src/index.ts', '--format', 'json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assertJsonSchema(recallMapSchema, report, 'Recall Map JSON report');
  assert.equal(Object.hasOwn(report, 'command'), false);
  assert.equal(report.safeguards.readOnly, true);
  assert.equal(report.safeguards.localFilesWritten, 0);
  assert.equal(report.architecture.impact.changedLocators[0], 'src/index.ts');
});

test('recall setup followed by recall map works from a packed npm install', () => {
  // Reuse the existing temp HOME/prefix package fixture.
  assert.match(runInstalledRecall(['map']).stdout, /Recall Map/);
});
```

- [ ] **Step 2: Run the CLI tests and verify RED**

Run: `node --test tests/cli.test.mjs`

Expected: FAIL because `map` is not a command.

- [ ] **Step 3: Implement command parsing and renderers**

Use `buildRecallMap` once per invocation. JSON returns the full schema object; summary returns heading, support/coverage, top entry points, changed impact, memory split, and next commands; Markdown is a safe report without source bodies. `--changed-from-git` reuses the existing safe git locator detector.

- [ ] **Step 4: Make setup lead to the first win without scanning silently**

Update `setupConsumerWorkspace()` output to state that setup created only local state and to print `recall map --root . --sqlite .local/memory.sqlite --format summary` as the next explicit command. Do not run map from setup.

- [ ] **Step 5: Verify package truth**

Run: `node --test tests/cli.test.mjs tests/release-readiness.test.mjs && npm run consumer:smoke`

Expected: PASS; a packed package initializes and maps the target repository, never its installed package directory.

- [ ] **Step 6: Commit the CLI first win**

```bash
git add apps/cli/oaf.mjs apps/cli/AGENTS.md package.json README.md docs/usage/README.md docs/usage/local-agent-handoff.md tests/cli.test.mjs tests/release-readiness.test.mjs scripts/consumer-smoke.mjs docs/usage/recall-map.md
git commit -m "feat: add Recall Map CLI first win"
```

### Task 5: Add one Recall Map API and make web onboarding developer-first

**Files:**
- Modify: `services/control-api/src/server.mjs`
- Modify: `apps/web/index.html`
- Modify: `apps/web/app.js`
- Modify: `apps/web/styles.css`
- Modify: `tests/control-api.test.mjs`
- Modify: `tests/web-shell.test.mjs`
- Modify: `scripts/consumer-browser-smoke.mjs`

**Interfaces:**

```text
GET /api/recall/map?changed=apps%2Fweb%2Fapp.js&query=auth
```

Response is the exact strict `RecallMapReport` schema object without a
transport command envelope. It rejects absolute paths, raw-body requests,
write-capable flags, and unsupported query values.

- [ ] **Step 1: Write failing API and web-model tests**

```js
test('Recall Map API returns the same read-only report contract as the CLI composer', async () => {
  const response = await requestJson('/api/recall/map?changed=apps/web/app.js');
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.safeguards.readOnly, true);
  assert.equal(response.body.safeguards.networkCalls, 0);
});

test('home route prioritizes Recall Map and Next-Agent Handoff', () => {
  const html = renderRoute({ id: 'home' });
  assert.match(html, /Recall Map/);
  assert.match(html, /Next-Agent Handoff/);
  assert.doesNotMatch(html, /Open Agent Fabric/);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test tests/control-api.test.mjs tests/web-shell.test.mjs`

Expected: FAIL because `/api/recall/map` and the developer-first home composition do not exist.

- [ ] **Step 3: Implement API delegation and safe validation**

Call `buildRecallMap` from a narrow API handler. Reuse existing root/path validators; no direct web-to-storage access. Preserve the existing `/api/context/graph/preview` route for compatibility.

- [ ] **Step 4: Implement the real first screen**

Replace generic home copy with a live map overview: index health, supported coverage, entry points, changed impact, active/pending memory counters, handoff readiness, and copyable next commands. Use structured lists/cards and explicit empty/partial/stale/error states. Do not add a force-directed canvas in this task.

- [ ] **Step 5: Run browser proof**

Run: `node --test tests/web-shell.test.mjs tests/control-api.test.mjs && npm run consumer:browser-smoke`

Expected: PASS; desktop/mobile first-use screen has no console errors, no horizontal overflow, and renders real API state.

- [ ] **Step 6: Commit the developer-first web surface**

```bash
git add services/control-api/src/server.mjs apps/web tests/control-api.test.mjs tests/web-shell.test.mjs scripts/consumer-browser-smoke.mjs
git commit -m "feat: make Recall Map the developer-first home"
```

### Task 6: Add read-only MCP map and impact tools after CLI/API proof

**Files:**
- Modify: `apps/cli/oaf.mjs`
- Modify: `docs/usage/mcp-server-reference.md`
- Modify: `tests/cli.test.mjs`
- Modify: `tests/memory-recall-integrity.test.mjs`

**Interfaces:**

```text
repo.map({ client?, changed?, query?, limit? }) -> RecallMapReport subset
code.impact({ changed: string[], depth?: 1|2|3, limit?: 1..50 }) -> locator-safe impact subset
```

Both tools use the same map composer, persist no new graph/memory state, and return only workspace-relative locators/safe labels.

- [ ] **Step 1: Write failing stdio MCP tests**

```js
test('MCP repo.map separates active facts from proposals and never returns source bodies', () => {
  const response = callMcp('repo.map', { changed: ['src/index.ts'] });
  assert.equal(response.data.safeguards.readOnly, true);
  assert.equal(response.data.memory.pendingProposals.length, 1);
  assert.equal(response.data.memory.activeFacts.length, 0);
  assert.doesNotMatch(JSON.stringify(response), /function secretImplementation/);
});
```

- [ ] **Step 2: Run the MCP tests and verify RED**

Run: `node --test tests/memory-recall-integrity.test.mjs tests/cli.test.mjs`

Expected: FAIL because `repo.map` and `code.impact` are absent.

- [ ] **Step 3: Implement tool schemas and handlers**

Add the tools to the existing read-only bridge only. Bound `changed` to safe relative locators, normalize `depth`/`limit`, and reuse map/report serializers. Do not change proposal default behavior for `memory.recall`.

- [ ] **Step 4: Update MCP reference and verify GREEN**

Run: `node --test tests/memory-recall-integrity.test.mjs tests/cli.test.mjs && npm run protocol:validate`

Expected: PASS; tool catalog, tool schemas, and docs describe only implemented read-only behavior.

- [ ] **Step 5: Commit MCP map access**

```bash
git add apps/cli/oaf.mjs docs/usage/mcp-server-reference.md tests/cli.test.mjs tests/memory-recall-integrity.test.mjs
git commit -m "feat: expose Recall Map through read-only MCP"
```

### Task 7: Publish support, safety, and benchmark proof pages

**Files:**
- Create: `docs/usage/support-matrix.md`
- Create: `docs/benchmarks.md`
- Create: `docs/usage/uninstall.md`
- Modify: `README.md`
- Modify: `docs/usage/README.md`
- Modify: `docs/usage/token-savings.md`
- Modify: `docs/usage/troubleshooting.md`
- Modify: `tests/docs.test.mjs`
- Modify: `scripts/check.mjs`

**Interfaces:**
- `docs/benchmarks.md` lists each public claim with `metric`, `dataset`, `baseline`, `command`, `result artifact`, `limitations`, and `pass condition`.
- `docs/usage/support-matrix.md` lists client, install mode, config write behavior, hook behavior, graph coverage, and status (`implemented`, `experimental`, `unsupported`).
- `docs/usage/uninstall.md` has preview/remove/data-preservation steps and explicitly never deletes `.local` without a named confirmation command.
- The public-copy audit checks only `README.md`, `docs/usage/`, and `apps/web/`; it permits protocol examples such as `oaf://` only when a nearby compatibility link explains the identifier.

- [ ] **Step 1: Write failing documentation integrity tests**

```js
test('public benchmark documentation makes each claim reproducible', async () => {
  const page = await readFile('docs/benchmarks.md', 'utf8');
  for (const heading of ['Dataset', 'Baseline', 'Command', 'Pass condition', 'Limitations']) {
    assert.match(page, new RegExp(`## ${heading}`));
  }
});

test('support matrix distinguishes implemented experimental and unsupported surfaces', async () => {
  const matrix = await readFile('docs/usage/support-matrix.md', 'utf8');
  assert.match(matrix, /Implemented/);
  assert.match(matrix, /Experimental/);
  assert.match(matrix, /Unsupported/);
});
```

- [ ] **Step 2: Run docs tests and verify RED**

Run: `node --test tests/docs.test.mjs`

Expected: FAIL because the pages and integrity checks do not exist.

- [ ] **Step 3: Write proof-oriented public documentation**

Use the actual `recall map`, handoff, graph, memory, and benchmark commands. Every metric must state whether it is a local delivery estimate, retrieval coverage, correctness result, or provider billing claim (the latter is never claimed).

- [ ] **Step 4: Add safe uninstall guidance and run the check**

Run: `node --test tests/docs.test.mjs && npm run check`

Expected: PASS; links, command names, client matrix statuses, and public naming are validated.

- [ ] **Step 5: Commit docs and proof pages**

```bash
git add README.md docs/usage docs/benchmarks.md tests/docs.test.mjs scripts/check.mjs
git commit -m "docs: publish Recall support and benchmark proof"
```

### Task 8: Finish safe cleanup, validate release evidence, and prepare merge

**Files:**
- Modify: `Makefile`
- Modify: `docs/usage/uninstall.md`
- Modify: `PROJECT_STATUS.json`
- Modify: `docs/release/1.0-READINESS-REPORT.md`
- Modify: `docs/release/1.0-REPRODUCIBILITY.md`
- Modify: `docs/release/1.0-PROVENANCE.json`
- Modify: `tests/release-readiness.test.mjs`
- Modify: `scripts/release-readiness.mjs`
- Modify: `scripts/release-readiness-check.mjs`

**Interfaces:**
- `make clean` removes rebuildable caches only and never removes `.env` or `.local`.
- An explicit documented command is required before any local Recall state deletion.
- Release evidence is regenerated from current tests and the public support/benchmark pages; it does not describe old OAF release semantics as Memory Recall behavior.

- [ ] **Step 1: Write failing cleanup and evidence tests**

```js
test('make clean target does not remove local state or environment files', async () => {
  const makefile = await readFile('Makefile', 'utf8');
  const cleanTarget = makefile.match(/^clean:\n((?:\t.*\n?)*)/m)?.[1] ?? '';
  assert.doesNotMatch(cleanTarget, /\.env/);
  assert.doesNotMatch(cleanTarget, /\.local/);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test tests/release-readiness.test.mjs`

Expected: FAIL if the current clean target still removes `.env` or `.local`.

- [ ] **Step 3: Split cache cleanup from state removal**

Implement `make clean` for `node_modules`-adjacent/rebuildable cache artifacts only. Add a separately documented `recall uninstall --dry-run` path before any future state deletion; this task does not silently delete state.

- [ ] **Step 4: Regenerate release evidence**

Run: `npm run release:readiness && npm run release:readiness:check`

Expected: PASS with test count, product name, package evidence, and reproducibility artifacts synchronized.

- [ ] **Step 5: Move local Rust build output to Trash only after all verification**

Run: `test -d rust/target && mv rust/target ~/.Trash/memory-recall-rust-target-$(date +%Y%m%d%H%M%S) || true`

Expected: source worktree remains valid; Cargo can regenerate build output when needed. Do not remove any tracked Rust source.

- [ ] **Step 6: Run the final gates**

Run: `npm run ci && npm run consumer:smoke && npm run consumer:browser-smoke && git diff --check`

Expected: all pass; worktree has only intentional tracked changes.

- [ ] **Step 7: Commit release-safe cleanup**

```bash
git add Makefile docs/usage/uninstall.md PROJECT_STATUS.json docs/release tests/release-readiness.test.mjs scripts/release-readiness.mjs scripts/release-readiness-check.mjs
git commit -m "chore: make Recall cleanup and release evidence safe"
```

## Deferred, migration-gated work

- Replacing the completed OAF backlog/status/task system with a small Memory Recall roadmap model.
- Moving generated root evidence into an ignored artifacts directory.
- Archiving historical OAF product plans and broad control-plane documents after inbound-reference checks.
- Trimming catalog-only adapter stubs after extracting them into a separately versioned integrations roadmap.
- Force-directed graph visualization, semantic embeddings, non-JS/TS parsing, shared HTTP map hosting, automatic hooks, and broad document/media ingest.

These are intentionally not mixed into this foundation release because each changes user data, compatibility, packaging, or public support claims.

## Final verification checklist

- [ ] `npm run ci`
- [ ] `npm run consumer:smoke`
- [ ] `npm run consumer:browser-smoke`
- [ ] `npm run release:readiness:check`
- [ ] `git diff --check`
- [ ] Fresh npm install proves `recall setup`, `recall map`, and `recall handoff` in a target repo.
- [ ] Every public claim links to a reproducible command and labels its limitations.
- [ ] No automatic state capture, model/network call, hook installation, or destructive cleanup was introduced.
