# Memory Recall Polyglot Phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freeze the production code-intelligence boundary, publish an evidence-bearing language capability matrix, define the provider-neutral protocol contract, pin the benchmark corpus, and record the current Memory Recall baseline before Node/Rust integration begins.

**Architecture:** Phase 0 adds contracts and measurement infrastructure only. The current JS/TS provider and experimental Rust runtime remain behaviorally unchanged. New JSON Schemas define bounded provider-neutral graph output, language capability claims, and benchmark corpus inputs; small Node scripts validate evidence and run the current local baseline.

**Tech Stack:** Node.js 22 ESM, JSON Schema 2020-12, existing dependency-free schema validator, Rust workspace and existing quality harnesses, Git, Markdown, Node test runner.

## Global Constraints

- The public package remains `memory-recall`; existing OAF identifiers remain compatibility internals.
- No source body, absolute filesystem path, user name, credential, or provider-native identity may enter protocol fixtures or reports.
- Protocol additions are additive within v1 and require valid plus invalid compatibility fixtures.
- MCP remains read-only; Phase 0 adds no index mutation through MCP.
- Current product claims remain JS/TS-only until later phases pass their gates.
- `full` language support requires symbol recall at least 95 percent and resolved-call precision at least 90 percent on the approved corpus.
- Loading a grammar is not language support.
- No push, merge, npm publish, deploy, or external release occurs in this plan.
- The worktree must be clean after each task commit.

---

### Task 1: Record the approved architecture decision

**Files:**
- Modify: `docs/superpowers/specs/2026-07-16-memory-recall-polyglot-leadership-design.md:1-6`
- Create: `docs/adr/0023-production-rust-code-intelligence-engine.md`
- Test: `tests/usage-docs.test.mjs`

**Interfaces:**
- Consumes: approved polyglot leadership specification at commit `34f8b67`.
- Produces: accepted ADR 0023 and a stable link used by later provider, storage, distribution, and release work.

- [ ] **Step 1: Write the failing documentation test**

Add this test to `tests/usage-docs.test.mjs`:

```js
test('polyglot leadership contract is approved and owns the native engine boundary', () => {
  const design = read('docs/superpowers/specs/2026-07-16-memory-recall-polyglot-leadership-design.md');
  const adr = read('docs/adr/0023-production-rust-code-intelligence-engine.md');
  assert.match(design, /\*\*Status:\*\* Approved for implementation/);
  assert.match(adr, /## Status\s+Accepted/);
  assert.match(adr, /Rust.*production code-intelligence engine/s);
  assert.match(adr, /Node\.js.*CLI.*Control API.*memory.*MCP.*web/s);
  assert.match(adr, /JSON Lines/);
  assert.match(adr, /derived local state/);
  assert.match(adr, /no local Rust toolchain/i);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test tests/usage-docs.test.mjs`

Expected: FAIL because ADR 0023 does not exist and the design status is still proposed.

- [ ] **Step 3: Accept the design and write ADR 0023**

Change the design header to:

```markdown
**Status:** Approved for implementation
```

ADR 0023 must record these decisions verbatim in substance:

```markdown
# ADR 0023: Production Rust Code Intelligence Engine

## Status

Accepted.

## Decision

Memory Recall promotes the existing Rust Tree-sitter runtime into the production code-intelligence engine. Node.js continues to own the public CLI, loopback Control API, governed memory, read-only MCP facade, and web workbench.

Node and Rust communicate through a versioned JSON Lines subprocess protocol. The graph and index remain derived local state, not canonical memory. The public npm installation selects a verified platform binary and does not require a local Rust toolchain.
```

The ADR must also cover alternatives rejected, failure boundaries, compatibility, security, distribution, and reversal.

- [ ] **Step 4: Run the focused test and documentation hygiene checks**

Run: `node --test tests/usage-docs.test.mjs && git diff --check`

Expected: all usage-document tests pass and `git diff --check` prints nothing.

- [ ] **Step 5: Commit the accepted decision**

```bash
git add docs/superpowers/specs/2026-07-16-memory-recall-polyglot-leadership-design.md docs/adr/0023-production-rust-code-intelligence-engine.md tests/usage-docs.test.mjs
git commit -m "docs: accept production code intelligence engine"
```

### Task 2: Add the provider-neutral graph contract

**Files:**
- Create: `packages/protocol/schemas/code-intelligence-graph.schema.json`
- Create: `examples/protocol/code-intelligence-graph.json`
- Create: `examples/protocol/compatibility/invalid/code-intelligence-graph-raw-body.json`
- Create: `examples/protocol/compatibility/invalid/code-intelligence-graph-absolute-path.json`
- Modify: `examples/protocol/compatibility/fixtures.json`
- Modify: `packages/protocol/README.md`
- Modify: `rfcs/0001-protocol-contracts.md`
- Create: `tests/code-intelligence-contract.test.mjs`

**Interfaces:**
- Consumes: workspace-locator rules from `packages/protocol/src/source-graph-locator.mjs` and the node/edge vocabulary approved in the design.
- Produces: schema ID `https://openagentfabric.dev/schemas/code-intelligence-graph.schema.json`, graph version `memory-recall-code-intelligence-1`, node IDs matching `^cinode_[a-f0-9]{32}$`, and edge IDs matching `^ciedge_[a-f0-9]{32}$`.

- [ ] **Step 1: Write failing valid and invalid fixture tests**

Create `tests/code-intelligence-contract.test.mjs`:

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateJsonSchema } from '../packages/protocol/src/schema-validator.mjs';

const readJson = async (file) => JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));

test('provider-neutral code intelligence graph validates', async () => {
  const schema = await readJson('packages/protocol/schemas/code-intelligence-graph.schema.json');
  const graph = await readJson('examples/protocol/code-intelligence-graph.json');
  assert.equal(validateJsonSchema(schema, graph).valid, true);
  assert.equal(graph.nodes.every((node) => !Object.hasOwn(node, 'body') && !Object.hasOwn(node, 'sourceText')), true);
});

test('code intelligence graph rejects source bodies and absolute paths', async () => {
  const schema = await readJson('packages/protocol/schemas/code-intelligence-graph.schema.json');
  for (const file of [
    'examples/protocol/compatibility/invalid/code-intelligence-graph-raw-body.json',
    'examples/protocol/compatibility/invalid/code-intelligence-graph-absolute-path.json'
  ]) {
    assert.equal(validateJsonSchema(schema, await readJson(file)).valid, false, file);
  }
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test tests/code-intelligence-contract.test.mjs`

Expected: FAIL because the schema and fixtures do not exist.

- [ ] **Step 3: Create the bounded graph schema**

The top-level schema must require:

```json
{
  "schemaVersion": "1.0.0",
  "graphVersion": "memory-recall-code-intelligence-1",
  "repository": {
    "id": "repo_0123456789abcdef0123456789abcdef",
    "workspaceId": "ws_local",
    "rootIdentityHash": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  },
  "engine": {
    "name": "memory-recall-native",
    "version": "0.1.0",
    "protocolVersion": "1.0.0"
  },
  "generation": {
    "id": "cigen_0123456789abcdef0123456789abcdef",
    "builtAt": "2026-07-16T00:00:00.000Z",
    "freshness": "current"
  },
  "coverage": [],
  "nodes": [],
  "edges": [],
  "diagnostics": [],
  "graphFingerprint": "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
}
```

Use closed objects. Bound nodes to 5,000, edges to 10,000, coverage rows to 64, and diagnostics to 1,000. Use the exact node, edge, resolution, evidence, language, and freshness enums from the approved design. Locators must be workspace-relative and may include `#Lx-Ly`; no `body`, `sourceText`, arbitrary metadata, absolute path, URI, or provider-native ID property is permitted.

- [ ] **Step 4: Add one valid example and two invalid fixtures**

The valid example contains one TypeScript file node, one function node, and one exact `defines` edge with a bounded evidence span. The raw-body fixture copies the valid example and adds `sourceText`. The absolute-path fixture replaces the file locator with `/Users/example/private.ts`.

Register all three in `examples/protocol/compatibility/fixtures.json` with expected validity `true`, `false`, and `false`.

- [ ] **Step 5: Document the additive protocol**

Add a concise section to `packages/protocol/README.md` and `rfcs/0001-protocol-contracts.md` stating that the new contract is provider-neutral, bounded, additive within v1, and separate from canonical memory. Keep `source-graph.schema.json` as the current JS/TS compatibility schema until Phase 1 migration.

- [ ] **Step 6: Run protocol verification**

Run: `node --test tests/code-intelligence-contract.test.mjs tests/protocol-schema-validator.test.mjs && npm run protocol:validate`

Expected: focused tests pass and the compatibility fixture total increases by three with zero failures.

- [ ] **Step 7: Commit the graph contract**

```bash
git add packages/protocol/schemas/code-intelligence-graph.schema.json packages/protocol/README.md rfcs/0001-protocol-contracts.md examples/protocol/code-intelligence-graph.json examples/protocol/compatibility/invalid/code-intelligence-graph-raw-body.json examples/protocol/compatibility/invalid/code-intelligence-graph-absolute-path.json examples/protocol/compatibility/fixtures.json tests/code-intelligence-contract.test.mjs
git commit -m "feat: define provider-neutral code intelligence graph"
```

### Task 3: Publish the evidence-bearing language capability matrix

**Files:**
- Create: `packages/protocol/schemas/code-intelligence-capability-matrix.schema.json`
- Create: `evals/code-intelligence/capability-matrix.v1.json`
- Create: `packages/protocol/src/code-intelligence-contract.mjs`
- Modify: `packages/protocol/src/index.mjs`
- Modify: `examples/protocol/compatibility/fixtures.json`
- Create: `examples/protocol/compatibility/invalid/code-intelligence-capability-matrix-false-full.json`
- Modify: `tests/code-intelligence-contract.test.mjs`
- Create: `docs/usage/code-intelligence-support.md`
- Modify: `docs/usage/support-matrix.md`

**Interfaces:**
- Consumes: fourteen Tier 1 language IDs and eleven capability IDs from the approved specification.
- Produces: `CODE_INTELLIGENCE_TIER_1_LANGUAGES`, `CODE_INTELLIGENCE_TIER_2_LANGUAGES`, `CODE_INTELLIGENCE_CAPABILITIES`, and `auditCodeIntelligenceCapabilityMatrix(matrix, { root })`.

- [ ] **Step 1: Add failing matrix tests**

Append to `tests/code-intelligence-contract.test.mjs`:

```js
import {
  CODE_INTELLIGENCE_CAPABILITIES,
  CODE_INTELLIGENCE_TIER_1_LANGUAGES,
  auditCodeIntelligenceCapabilityMatrix
} from '../packages/protocol/src/code-intelligence-contract.mjs';

test('capability matrix covers every Tier 1 language and capability honestly', async () => {
  const matrix = await readJson('evals/code-intelligence/capability-matrix.v1.json');
  assert.deepEqual(matrix.languages.filter((item) => item.tier === 1).map((item) => item.id).sort(), [...CODE_INTELLIGENCE_TIER_1_LANGUAGES].sort());
  assert.equal(matrix.languages.every((item) => CODE_INTELLIGENCE_CAPABILITIES.every((capability) => Object.hasOwn(item.capabilities, capability))), true);
  assert.deepEqual(await auditCodeIntelligenceCapabilityMatrix(matrix, { root: new URL('..', import.meta.url) }), []);
  assert.equal(matrix.languages.every((item) => item.benchmarkStatus !== 'meets-floor'), true);
});

test('matrix audit rejects unsupported full claims without fixture and real-repo evidence', async () => {
  const invalid = await readJson('examples/protocol/compatibility/invalid/code-intelligence-capability-matrix-false-full.json');
  const findings = await auditCodeIntelligenceCapabilityMatrix(invalid, { root: new URL('..', import.meta.url) });
  assert.equal(findings.some((item) => item.code === 'full_claim_missing_fixture_evidence'), true);
  assert.equal(findings.some((item) => item.code === 'full_claim_missing_real_repo_evidence'), true);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test tests/code-intelligence-contract.test.mjs`

Expected: FAIL because the contract module and matrix do not exist.

- [ ] **Step 3: Implement constants and evidence audit**

Create `packages/protocol/src/code-intelligence-contract.mjs` with frozen arrays for:

```js
export const CODE_INTELLIGENCE_TIER_1_LANGUAGES = Object.freeze([
  'typescript', 'javascript', 'python', 'java', 'kotlin', 'csharp', 'go',
  'rust', 'php', 'ruby', 'swift', 'c', 'cpp', 'dart'
]);

export const CODE_INTELLIGENCE_TIER_2_LANGUAGES = Object.freeze([
  'lua', 'bash', 'sql', 'objective-c', 'scala', 'r', 'julia', 'zig'
]);

export const CODE_INTELLIGENCE_CAPABILITIES = Object.freeze([
  'parse', 'structure', 'imports', 'exports', 'heritage', 'types',
  'calls', 'config', 'frameworks', 'impact', 'processes'
]);
```

`auditCodeIntelligenceCapabilityMatrix` must return stable findings for duplicate/missing languages, missing capabilities, evidence paths that are absolute, escape the repository, or do not exist, and any `meets-floor` capability without both `fixture` and `real-repo` evidence classes. It performs no network calls and writes no files.

- [ ] **Step 4: Create the schema and initial matrix**

The matrix includes all fourteen Tier 1 and eight Tier 2 languages. Each capability has:

```json
{
  "productStatus": "implemented",
  "benchmarkStatus": "unmeasured",
  "evidence": [
    { "class": "implementation", "path": "providers/native/context-candidate-ast-code/src/index.mjs" }
  ],
  "limitations": ["Public production path remains bounded JS/TS static analysis."]
}
```

Use `implemented` only for behavior on the public Node path, `experimental` for existing Rust-only behavior, `specified` for absent target behavior, and `unsupported` where no implementation exists. Use `unmeasured` for every Phase 0 benchmark status. No language or capability is marked `meets-floor` in the initial matrix.

Register the matrix as a valid protocol fixture and create one invalid fixture that marks a capability `meets-floor` without fixture or real-repository evidence.

- [ ] **Step 5: Publish the readable support page**

`docs/usage/code-intelligence-support.md` must explain Tier 1, Tier 2, product status, benchmark status, evidence requirements, and the current JS/TS versus experimental Rust boundary. Link it from `docs/usage/support-matrix.md`. Do not hand-copy every matrix cell into Markdown; the JSON file remains authoritative.

- [ ] **Step 6: Verify the matrix**

Run: `node --test tests/code-intelligence-contract.test.mjs && npm run protocol:validate`

Expected: tests pass, the valid matrix fixture validates, the false-full fixture is rejected by the schema or evidence audit, and no current capability claims `meets-floor`.

- [ ] **Step 7: Commit the capability contract**

```bash
git add packages/protocol/schemas/code-intelligence-capability-matrix.schema.json packages/protocol/src/code-intelligence-contract.mjs packages/protocol/src/index.mjs evals/code-intelligence/capability-matrix.v1.json examples/protocol/compatibility/fixtures.json examples/protocol/compatibility/invalid/code-intelligence-capability-matrix-false-full.json tests/code-intelligence-contract.test.mjs docs/usage/code-intelligence-support.md docs/usage/support-matrix.md
git commit -m "feat: add evidence-bearing language capability matrix"
```

### Task 4: Pin the benchmark corpus and thresholds

**Files:**
- Create: `packages/protocol/schemas/code-intelligence-benchmark-manifest.schema.json`
- Create: `evals/code-intelligence/corpus-candidates.v1.json`
- Create: `evals/code-intelligence/benchmark-gates.v1.json`
- Create: `scripts/pin-code-intelligence-corpus.mjs`
- Create: `evals/code-intelligence/corpus.v1.json`
- Modify: `tests/code-intelligence-contract.test.mjs`

**Interfaces:**
- Consumes: exact Tier 1 language constants and public Git repository URLs.
- Produces: a deterministic corpus with three pinned real repositories per Tier 1 language and explicit small, medium, or large size class.

- [ ] **Step 1: Add failing corpus tests**

Append:

```js
test('benchmark corpus has three pinned real repositories per Tier 1 language', async () => {
  const corpus = await readJson('evals/code-intelligence/corpus.v1.json');
  for (const language of CODE_INTELLIGENCE_TIER_1_LANGUAGES) {
    const repos = corpus.repositories.filter((item) => item.primaryLanguage === language);
    assert.equal(repos.length, 3, language);
    assert.equal(repos.every((item) => /^[a-f0-9]{40}$/.test(item.commit)), true, language);
    assert.equal(new Set(repos.map((item) => item.url)).size, 3, language);
  }
});

test('benchmark gates preserve the approved accuracy floors', async () => {
  const gates = await readJson('evals/code-intelligence/benchmark-gates.v1.json');
  assert.equal(gates.languageFull.symbolRecallMinimum, 0.95);
  assert.equal(gates.languageFull.resolvedCallPrecisionMinimum, 0.90);
  assert.equal(gates.languageFull.duplicateCanonicalSymbolMaximum, 0);
  assert.equal(gates.claims.parityRequiresAllTier1Languages, true);
  assert.equal(gates.claims.leadershipRequiresRelevantCompetitorWin, true);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test tests/code-intelligence-contract.test.mjs`

Expected: FAIL because the corpus and gate files do not exist.

- [ ] **Step 3: Create the candidate list**

Use these exact repository groups:

```text
typescript: microsoft/TypeScript, microsoft/vscode, vercel/next.js
javascript: expressjs/express, lodash/lodash, axios/axios
python: pallets/flask, psf/requests, fastapi/fastapi
java: spring-projects/spring-petclinic, google/gson, google/guava
kotlin: ktorio/ktor, Kotlin/kotlinx.coroutines, android/nowinandroid
csharp: dotnet/aspnetcore, dotnet/runtime, JamesNK/Newtonsoft.Json
go: gin-gonic/gin, go-chi/chi, hashicorp/go-multierror
rust: dtolnay/itoa, tokio-rs/axum, serde-rs/json
php: laravel/framework, symfony/symfony, slimphp/Slim
ruby: rails/rails, sinatra/sinatra, ruby/rake
swift: vapor/vapor, Alamofire/Alamofire, apple/swift-nio
c: antirez/kilo, redis/redis, curl/curl
cpp: fmtlib/fmt, catchorg/Catch2, nlohmann/json
dart: dart-lang/http, dart-lang/shelf, flutter/samples
```

Each candidate includes repository ID, HTTPS Git URL, primary language, size class, role, SPDX license expression, and an authoritative license URL. Candidate entries contain no commit field.

- [ ] **Step 4: Implement deterministic pinning**

`scripts/pin-code-intelligence-corpus.mjs --write` reads the candidates, runs `git ls-remote <url> HEAD`, validates one 40-character commit per repository, sorts by language and ID, and atomically writes `evals/code-intelligence/corpus.v1.json`. It must fail on non-HTTPS Git URLs, duplicate URLs, missing commits, extra output, missing license evidence, or fewer/more than three repositories per Tier 1 language.

`--check` is offline. It validates that the committed corpus exactly matches the candidate identities and metadata, contains immutable 40-character pins, and satisfies the schema without comparing pins to a moving remote branch. A later `--refresh` mode may resolve new HEAD commits, but it must print the proposed pin changes and require a separate explicit `--write` invocation to replace the corpus.

- [ ] **Step 5: Pin the corpus**

Run: `node scripts/pin-code-intelligence-corpus.mjs --write`

Expected: 42 repositories pinned with 40-character commits and one local file written.

- [ ] **Step 6: Verify schema and gates**

Run: `node --test tests/code-intelligence-contract.test.mjs && node scripts/pin-code-intelligence-corpus.mjs --check`

Expected: tests pass and the committed corpus matches its candidate identities, license metadata, cardinality, and immutable-pin schema without a network call.

- [ ] **Step 7: Commit the corpus contract**

```bash
git add packages/protocol/schemas/code-intelligence-benchmark-manifest.schema.json evals/code-intelligence/corpus-candidates.v1.json evals/code-intelligence/corpus.v1.json evals/code-intelligence/benchmark-gates.v1.json scripts/pin-code-intelligence-corpus.mjs tests/code-intelligence-contract.test.mjs
git commit -m "test: pin polyglot benchmark corpus"
```

### Task 5: Record the current Memory Recall baseline

**Files:**
- Create: `scripts/code-intelligence-phase0-baseline.mjs`
- Create: `evals/code-intelligence/results/phase0-baseline.json`
- Modify: `tests/code-intelligence-contract.test.mjs`
- Modify: `docs/benchmarks.md`

**Interfaces:**
- Consumes: current Node JS/TS tests, current Rust quality harnesses, corpus manifest, and benchmark gates.
- Produces: an immutable current-state report that separates public Node behavior, experimental Rust behavior, missing competitive measurements, and commands executed.

- [ ] **Step 1: Add a failing report-truth test**

Append:

```js
test('Phase 0 baseline separates public, experimental, and unmeasured evidence', async () => {
  const report = await readJson('evals/code-intelligence/results/phase0-baseline.json');
  assert.equal(report.phase, 0);
  assert.equal(report.publicEngine.languageIds.join(','), 'javascript,typescript');
  assert.equal(report.experimentalEngine.languageIds.includes('python'), true);
  assert.equal(report.competitors.gitnexus.status, 'unmeasured');
  assert.equal(report.competitors.codebaseMemoryMcp.status, 'unmeasured');
  assert.equal(report.claims.parity, false);
  assert.equal(report.claims.leadership, false);
  assert.equal(report.commands.every((item) => item.exitCode === 0), true);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test tests/code-intelligence-contract.test.mjs`

Expected: FAIL because the baseline report does not exist.

- [ ] **Step 3: Implement the baseline runner**

The runner executes these commands in order and records command, exit code, duration, and SHA-256 of stdout and stderr without embedding raw output:

```js
const COMMANDS = [
  ['node', ['--test', 'tests/ast-code-candidate-source.test.mjs', 'tests/source-graph-index-store.test.mjs', 'tests/mcp-code-intelligence.test.mjs']],
  ['cargo', ['build', '--release', '--manifest-path', 'rust/Cargo.toml']],
  ['cargo', ['test', '--manifest-path', 'rust/Cargo.toml']],
  ['node', ['scripts/rust-ingest-quality.mjs']],
  ['node', ['scripts/rust-typed-calls-quality.mjs']],
  ['node', ['scripts/rust-incremental-quality.mjs']]
];
```

The report records platform, architecture, Node version, Rust version, current commit, dirty state before the generated report, public language IDs, experimental language IDs, matrix fingerprint, corpus fingerprint, gate values, command receipts, and explicit false parity/leadership claims. Competitor measurements remain `unmeasured` until the Phase 8 harness runs them on identical pinned clones.

Support `--out evals/code-intelligence/results/phase0-baseline.json`. Write through a same-directory temporary file and rename. Do not include source bodies, absolute repository roots, environment variables, command stdout, or command stderr.

- [ ] **Step 4: Run the baseline**

Run: `node scripts/code-intelligence-phase0-baseline.mjs --out evals/code-intelligence/results/phase0-baseline.json`

Expected: all six commands exit zero and the report is written once.

- [ ] **Step 5: Document the baseline honestly**

Add a Phase 0 section to `docs/benchmarks.md` with the report path, command, what was measured, and what remains unmeasured. State that the public product remains JS/TS-only and that experimental Rust parser/harness success is not GitNexus or Codebase Memory MCP parity.

- [ ] **Step 6: Verify the report**

Run: `node --test tests/code-intelligence-contract.test.mjs && git diff --check`

Expected: tests pass, the report claims no parity or leadership, and diff hygiene passes.

- [ ] **Step 7: Commit the current baseline**

```bash
git add scripts/code-intelligence-phase0-baseline.mjs evals/code-intelligence/results/phase0-baseline.json tests/code-intelligence-contract.test.mjs docs/benchmarks.md
git commit -m "test: record polyglot phase zero baseline"
```

### Task 6: Close the Phase 0 gate

**Files:**
- Modify: `PROJECT_STATUS.json`
- Modify: `CHANGELOG.md`
- Modify: `docs/usage/code-intelligence-support.md`
- Modify: `docs/superpowers/plans/2026-07-16-memory-recall-polyglot-phase-0.md`

**Interfaces:**
- Consumes: accepted ADR, graph schema, capability matrix, pinned corpus, gates, and baseline report.
- Produces: machine-readable Phase 0 status and the clean handoff into Phase 1.

- [ ] **Step 1: Add Phase 0 evidence to project status**

Add a specified capability named `code-intelligence.polyglot-production-engine` whose evidence lists the approved spec, ADR, schemas, capability matrix, corpus, gates, baseline, and contract tests. Its limitations must state that the public runtime remains JS/TS-only, the Rust engine remains experimental, competitors remain unmeasured, and no parity claim exists.

- [ ] **Step 2: Update support and changelog truth**

Add one changelog entry under Unreleased describing contracts and baseline only. Update the support page with the baseline report link and next phase. Do not change README language support claims.

- [ ] **Step 3: Mark every completed plan checkbox**

Change each executed `- [ ]` in this file to `- [x]`. Leave no checked item whose command or artifact was not completed.

- [ ] **Step 4: Run the complete Phase 0 gate**

Run:

```bash
npm run check
npm run protocol:validate
npm test
npm run eval
npm run verify:handoff
npm run release:readiness:check
git diff --check
git status --short
```

Expected: every command passes. `git status --short` lists only the intended Phase 0 status, changelog, support-page, and checked-plan changes before the final commit.

- [ ] **Step 5: Commit Phase 0 closure**

```bash
git add PROJECT_STATUS.json CHANGELOG.md docs/usage/code-intelligence-support.md docs/superpowers/plans/2026-07-16-memory-recall-polyglot-phase-0.md HANDOFF_VERIFICATION.json REPOSITORY_MANIFEST.json docs/release
git commit -m "docs: close polyglot phase zero"
```

- [ ] **Step 6: Verify the clean milestone boundary**

Run: `git status --short --branch && git log -6 --oneline`

Expected: clean `codex/memory-recall-orientation-workbench` worktree with the six Phase 0 commits visible. No push, merge, publish, or deployment occurred.
