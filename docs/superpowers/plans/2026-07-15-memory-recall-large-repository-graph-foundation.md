# Memory Recall Large-Repository Graph Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Recall Map and Map return truthful, bounded, reusable source-graph results for large JavaScript and TypeScript repositories.

**Architecture:** Keep scanning and graph construction in the native AST provider, but split ignore matching into a focused module and put graph reuse behind an injected snapshot service. Bound nodes and edges before protocol validation, expose coverage and cache truth additively in the v1 schemas, and inject one snapshot service into the local Control API so Overview and Map share the same graph.

**Tech Stack:** Node.js 22 ESM, dependency-free JavaScript, JSON Schema, Node test runner, loopback Control API.

## Global Constraints

- Preserve local-only, read-only behavior; no network calls, model calls, external writes, or raw source bodies.
- Add no runtime dependency, graph database, persistent index, frontend framework, or graph library.
- Support JavaScript and TypeScript only: `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, and `.tsx`.
- Keep `maxFiles` at 1,000 supported files; excluded and unsupported files do not consume that budget.
- Keep the public graph within 20,000 nodes and 50,000 edges; exceeding candidates produce partial coverage instead of an unavailable graph.
- Preserve structural edges before low-signal references in this order: `contains`, `defined_in`, `imports`, `exports`, `calls`, `references`.
- Accept ordinary repository-relative directories named `users`, `Users`, or `private`; continue rejecting absolute paths, traversal, URI schemes, and encoded traversal.
- Honor root and descendant `.gitignore` files plus root `.recallignore`; explicit includes may override non-security exclusions only.
- Repeated Overview and Map requests against an unchanged root must reuse one in-process snapshot and one in-flight build.
- Protocol changes are additive within v1 and require RFC, OpenAPI, examples, and compatibility-fixture updates.
- Preserve the last valid snapshot when a refresh fails; surface it as stale rather than reporting a false empty success.

---

## File Map

### Create

- `providers/native/context-candidate-ast-code/src/ignore-rules.mjs`: parse and match dependency-free gitignore-style rules.
- `packages/source-graph/src/orientation.mjs`: build deterministic repository groups, inter-group relations, and bounded focus neighborhoods.
- `packages/source-graph/src/snapshot-service.mjs`: own cached graph snapshots, dirty generations, watchers, in-flight deduplication, and stale fallback.
- `tests/source-graph-discovery.test.mjs`: focused discovery, ignore, and supported-file budget tests.
- `tests/source-graph-snapshot-service.test.mjs`: focused cache, invalidation, concurrency, and stale fallback tests.
- `scripts/source-graph-large-repo-smoke.mjs`: generated and optional real-repository cold/cached smoke measurement.

### Modify

- `providers/native/context-candidate-ast-code/src/index.mjs`: apply discovery policy before accounting and enforce graph budgets.
- `packages/protocol/src/source-graph-locator.mjs`: separate relative locator safety from display-label safety.
- `packages/protocol/schemas/source-graph.schema.json`: add bounded omission and coverage fields.
- `packages/protocol/schemas/source-graph-preview.schema.json`: add snapshot state and bounded omission fields.
- `packages/protocol/schemas/recall-map.schema.json`: expose cache state and truthful coverage on Overview.
- `packages/source-graph/src/index.mjs`: query an injected snapshot and return fresh, cached, in-flight, stale, or unavailable state.
- `packages/recall-map/src/index.mjs`: consume the injected source-graph snapshot service.
- `services/control-api/src/server.mjs`: construct and close one snapshot service per server.
- `services/control-api/src/route-contracts.mjs`: keep route response validation aligned with additive schemas.
- `tests/source-graph-preview.test.mjs`: cover safe labels, bounded graphs, and stale diagnostics.
- `tests/recall-map.test.mjs`: cover cache and coverage projection.
- `tests/control-api-boundary.test.mjs`: prove Overview and Map share one graph build through the injectable server harness.
- `examples/protocol/source-graph.json`: include partial graph coverage fields.
- `examples/protocol/source-graph-preview.json`: include snapshot state.
- `examples/protocol/recall-map.json`: include source snapshot state.
- `examples/protocol/compatibility/invalid/source-graph-local-path.json`: retain an actually absolute invalid case.
- `examples/protocol/compatibility/invalid/source-graph-preview-local-path.json`: retain an actually absolute invalid case.
- `docs/api/openapi.yaml`: document additive snapshot and coverage fields.
- `docs/usage/recall-map.md`: document ignore rules, partial coverage, cache semantics, and refresh.
- `rfcs/0001-protocol-contracts.md`: record the additive v1 source-graph fields.
- `package.json`: add the large-repository smoke command.

---

### Task 1: Fix locator and display-label safety without weakening path containment

**Files:**
- Modify: `packages/protocol/src/source-graph-locator.mjs`
- Modify: `packages/protocol/src/index.mjs`
- Modify: `packages/protocol/schemas/source-graph.schema.json`
- Modify: `packages/protocol/schemas/source-graph-preview.schema.json`
- Modify: `examples/protocol/compatibility/invalid/source-graph-local-path.json`
- Modify: `examples/protocol/compatibility/invalid/source-graph-preview-local-path.json`
- Test: `tests/source-graph-preview.test.mjs`

**Interfaces:**
- Consumes: `normalizeSourceGraphWorkspaceLocator(value, { stripFragment })`.
- Produces: unchanged locator-normalization signature plus `isSafeSourceGraphDisplayLabel(value): boolean`.

- [x] **Step 1: Write the failing relative-directory regression tests**

Add these cases to `tests/source-graph-preview.test.mjs`:

```js
// Extend the existing node:fs/promises import with `rm` and import
// normalizeSourceGraphWorkspaceLocator from packages/protocol/src/source-graph-locator.mjs.
test('source graph accepts ordinary relative users and private directories', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recall-relative-users-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'apps', 'api', 'users', '[userRef]'), { recursive: true });
  await mkdir(path.join(root, 'src', 'private'), { recursive: true });
  await writeFile(path.join(root, 'apps', 'api', 'users', '[userRef]', 'route.ts'), 'export function GET(){ return "ok"; }\n');
  await writeFile(path.join(root, 'src', 'private', 'state.ts'), 'export const state = "local";\n');

  const preview = await buildSourceGraphPreview({ root, workspaceId: 'ws_local' });

  assert.equal(preview.graph.summary.fileCount, 2);
  assert.equal(preview.graph.diagnostics.some(({ code }) => code.startsWith('source_graph_unavailable')), false);
  assert(preview.graph.sampleNodes.some(({ locator }) => locator?.includes('/users/')));
  assert(preview.graph.sampleNodes.some(({ locator }) => locator?.includes('/private/')));
});

test('source graph still rejects absolute and encoded traversal locators', () => {
  for (const locator of [
    '/Users/rebel/project/src/app.js',
    'C:\\Users\\rebel\\project\\src\\app.js',
    'workspace:///Users/rebel/project/src/app.js',
    'workspace://src/%252e%252e/secret.js',
    'https://example.com/source.js'
  ]) {
    assert.throws(
      () => normalizeSourceGraphWorkspaceLocator(locator),
      /source_graph_workspace_locator_invalid/
    );
  }
});
```

- [x] **Step 2: Run the focused test and verify the current false rejection**

Run:

```bash
node --test --test-name-pattern="ordinary relative users|absolute and encoded" tests/source-graph-preview.test.mjs
```

Expected: the relative `users` or `private` test fails with an unavailable graph or invalid locator while absolute and traversal cases remain rejected.

- [x] **Step 3: Separate locator and label rules**

In `packages/protocol/src/source-graph-locator.mjs`, remove the blanket `Users`, `private`, and `var/folders` segment exclusions from `SOURCE_GRAPH_WORKSPACE_LOCATOR_PATTERN`. Keep the leading slash, drive, URI-scheme, traversal, percent-encoding, length, and fragment constraints. Replace the absolute-directory exclusions in `SOURCE_GRAPH_SAFE_LABEL_PATTERN` with structural checks only, then export a named predicate:

```js
export function isSafeSourceGraphDisplayLabel(value) {
  return typeof value === 'string' && SOURCE_GRAPH_SAFE_LABEL_RE.test(value);
}
```

The locator prefix must remain:

```js
String.raw`^workspace://(?!/)(?![^/]*%)(?![A-Za-z][A-Za-z0-9+.-]*:)(?!\.\.(?:/|$))(?!.*\/\.\.(?:/|$))`
```

Update the identical schema patterns in both source-graph schemas. Change the two invalid compatibility examples so they use `workspace:///Users/rebel/project/src/app.js`; do not keep a repository-relative `workspace://Users/...` example marked invalid.

- [x] **Step 4: Run focused protocol and source-graph verification**

Run:

```bash
node --test --test-name-pattern="ordinary relative users|absolute and encoded|locator" tests/source-graph-preview.test.mjs
npm run protocol:validate
```

Expected: focused tests pass and all protocol fixtures validate.

- [x] **Step 5: Commit the safety correction**

```bash
git add packages/protocol/src/source-graph-locator.mjs packages/protocol/src/index.mjs packages/protocol/schemas/source-graph.schema.json packages/protocol/schemas/source-graph-preview.schema.json examples/protocol/compatibility/invalid/source-graph-local-path.json examples/protocol/compatibility/invalid/source-graph-preview-local-path.json tests/source-graph-preview.test.mjs
git commit -m "fix: accept safe repository-relative graph paths"
```

### Task 2: Apply ignore rules before supported-file accounting

**Files:**
- Create: `providers/native/context-candidate-ast-code/src/ignore-rules.mjs`
- Create: `tests/source-graph-discovery.test.mjs`
- Modify: `providers/native/context-candidate-ast-code/src/index.mjs`

**Interfaces:**
- Produces: `parseIgnoreFile(text, { base = '' }): IgnoreRule[]`.
- Produces: `isIgnoredPath(relativePath, { isDirectory, rules, explicitIncludes }): boolean`.
- Produces: `loadRootRecallIgnore(root): Promise<IgnoreRule[]>`.
- `scanAstCodeWorkspace()` adds optional `explicitIncludes = []` and returns bounded ignore coverage.

- [x] **Step 1: Write failing ignore and accounting tests**

Create `tests/source-graph-discovery.test.mjs` with fixtures that prove exclusions happen before `maxFiles`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanAstCodeWorkspace } from '../providers/native/context-candidate-ast-code/src/index.mjs';

test('discovery honors nested gitignore and recallignore before maxFiles', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recall-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src', 'generated'), { recursive: true });
  await mkdir(path.join(root, '.worktrees', 'old', 'src'), { recursive: true });
  await mkdir(path.join(root, '.venv', 'lib'), { recursive: true });
  await writeFile(path.join(root, '.gitignore'), 'src/generated/\n');
  await writeFile(path.join(root, '.recallignore'), 'src/ignored.ts\n');
  await writeFile(path.join(root, 'src', '.gitignore'), 'nested.ts\n');
  await writeFile(path.join(root, 'src', 'entry.ts'), 'export function entry(){ return 1; }\n');
  await writeFile(path.join(root, 'src', 'nested.ts'), 'export const nested = 1;\n');
  await writeFile(path.join(root, 'src', 'ignored.ts'), 'export const ignored = 1;\n');
  await writeFile(path.join(root, 'src', 'generated', 'output.ts'), 'export const generated = 1;\n');
  await writeFile(path.join(root, '.worktrees', 'old', 'src', 'copy.ts'), 'export const copy = 1;\n');
  await writeFile(path.join(root, '.venv', 'lib', 'tool.js'), 'export const tool = 1;\n');

  const scan = await scanAstCodeWorkspace({ root, maxFiles: 1 });

  assert.equal(scan.fileCount, 1);
  assert.deepEqual(scan.coverage.representedJsTsLocators, ['workspace://src/entry.ts']);
  assert.equal(scan.coverage.maxFilesReached, false);
  assert.equal(scan.coverage.ignoredFileCount, 2);
  assert.equal(scan.coverage.ignoredDirectoryCount, 1);
  assert(scan.coverage.excludedDirectoryCount >= 2);
});

test('explicit include overrides non-security ignore but not root containment', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recall-include-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, '.recallignore'), 'src/kept.ts\n');
  await writeFile(path.join(root, 'src', 'kept.ts'), 'export const kept = true;\n');
  const scan = await scanAstCodeWorkspace({ root, explicitIncludes: ['src/kept.ts'] });
  assert.deepEqual(scan.coverage.representedJsTsLocators, ['workspace://src/kept.ts']);
  await assert.rejects(
    scanAstCodeWorkspace({ root, explicitIncludes: ['../outside.ts'] }),
    /source_graph_explicit_include_invalid/
  );
});
```

- [x] **Step 2: Run the tests and verify missing ignore behavior**

Run:

```bash
node --test tests/source-graph-discovery.test.mjs
```

Expected: FAIL because `.worktrees`, `.venv`, nested `.gitignore`, `.recallignore`, and `explicitIncludes` are not implemented.

- [x] **Step 3: Implement dependency-free ignore parsing**

Create `ignore-rules.mjs`. Parse blank lines, comments, escaped `#`/`!`, negation, root anchoring, directory-only suffixes, `*`, `?`, and `**`. Store the ignore-file base directory so descendant `.gitignore` rules are relative to their own directory:

```js
export function parseIgnoreFile(text, { base = '' } = {}) {
  return String(text ?? '').split(/\r?\n/u).flatMap((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return [];
    const negated = line.startsWith('!');
    const pattern = (negated ? line.slice(1) : line).replace(/\\([#!])/gu, '$1');
    if (!pattern) return [];
    return [{ base, pattern, negated, directoryOnly: pattern.endsWith('/'), index }];
  });
}

export function isIgnoredPath(relativePath, { isDirectory = false, rules = [], explicitIncludes = [] } = {}) {
  const normalized = normalizeRelativePath(relativePath);
  if (explicitIncludes.some((item) => item === normalized || item.startsWith(`${normalized}/`))) return false;
  let ignored = false;
  for (const rule of rules) {
    if (rule.directoryOnly && !isDirectory) continue;
    if (matchesIgnoreRule(normalized, rule)) ignored = !rule.negated;
  }
  return ignored;
}

export async function loadRootRecallIgnore(root) {
  try {
    return parseIgnoreFile(await readFile(path.join(root, '.recallignore'), 'utf8'), { base: '' });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function normalizeRelativePath(value) {
  const raw = String(value ?? '');
  const normalized = raw.replace(/^\.\//u, '');
  if (!normalized || raw.includes('\\') || normalized.startsWith('/') || /(?:^|\/)\.\.(?:\/|$)/u.test(normalized) || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(normalized)) {
    throw new Error('source_graph_explicit_include_invalid');
  }
  return normalized;
}

function matchesIgnoreRule(relativePath, rule) {
  const raw = rule.pattern.replace(/\/$/u, '');
  const anchored = raw.startsWith('/');
  const pattern = anchored ? raw.slice(1) : raw;
  const base = String(rule.base ?? '').replace(/\/$/u, '');
  const scoped = base ? `${base}/${pattern}` : pattern;
  const glob = anchored || pattern.includes('/')
    ? scoped
    : base ? `${base}/**/${pattern}` : `**/${pattern}`;
  return path.matchesGlob(relativePath, glob)
    || (!pattern.includes('/') && path.basename(relativePath) === pattern)
    || (rule.directoryOnly && (relativePath === scoped || relativePath.startsWith(`${scoped}/`)));
}
```

Import `readFile` from `node:fs/promises` and `path` from `node:path`. Use `path.matchesGlob()` only after normalization. Validate every explicit include with `normalizeRelativePath()` before scanning; security exclusions and root containment checks still run after a non-security ignore override.

- [x] **Step 4: Integrate discovery policy into the scanner**

In `scanAstCodeWorkspace()`:

1. Expand default exclusions to `.worktrees`, `.venv`, `venv`, `site-packages`, `.cache`, `.pytest_cache`, `.turbo`, `.parcel-cache`, `.agents`, `.claude`, `test-results`, and generated build directories.
2. Load root `.recallignore` once.
3. When entering a directory, load its `.gitignore` and append rules for descendants.
4. Evaluate default exclusions and ignore rules before `lstat()` recursion and before unsupported-file counting.
5. Increment `visitedFiles` only for supported files that are actually read.
6. Delete `discoverExcludedDirectoriesAfterCap()`; the scan must not traverse excluded trees after reaching the supported-file cap.
7. Add bounded `ignoredFileCount`, `ignoredDirectoryCount`, `ignoredSamples` (maximum 100), and `unsupportedExtensionCounts` (maximum 32 entries) to scan coverage. Keep these internal to the scan result until Task 3 extends the public graph schemas.
8. Keep an internal `index.discoveryIdentity` with the normalized relevant ignore-file locators (maximum 100) and a SHA-256 fingerprint of their normalized rules plus explicit includes. Do not project these new fields into the public graph until Task 3 extends the schema.

Keep coverage samples bounded with the existing `addBoundedLocator()` helper.

- [x] **Step 5: Verify discovery and existing AST behavior**

Run:

```bash
node --test tests/source-graph-discovery.test.mjs tests/ast-code-candidate-source.test.mjs tests/source-graph-preview.test.mjs
```

Expected: all focused tests pass and supported AST/source-graph behavior remains unchanged.

- [x] **Step 6: Commit discovery policy**

```bash
git add providers/native/context-candidate-ast-code/src/ignore-rules.mjs providers/native/context-candidate-ast-code/src/index.mjs tests/source-graph-discovery.test.mjs
git commit -m "feat: bound source discovery before file accounting"
```

### Task 3: Bound graph construction and report omitted candidates

**Files:**
- Modify: `providers/native/context-candidate-ast-code/src/index.mjs`
- Modify: `packages/protocol/schemas/source-graph.schema.json`
- Modify: `packages/protocol/schemas/source-graph-preview.schema.json`
- Modify: `examples/protocol/source-graph.json`
- Modify: `examples/protocol/source-graph-preview.json`
- Modify: `rfcs/0001-protocol-contracts.md`
- Modify: `docs/api/openapi.yaml`
- Test: `tests/source-graph-preview.test.mjs`

**Interfaces:**
- `buildSourceGraphFromIndex(index, options)` adds `maxNodes = 20_000` and `maxEdges = 50_000`.
- `graph.summary.coverage` adds represented, candidate, and omitted node/edge counts by kind.

- [x] **Step 1: Write a graph-budget regression test**

Add this generated dense-source test to `tests/source-graph-preview.test.mjs`. Extend the existing provider import with `buildJsTsSourceIndex` and `buildSourceGraphFromIndex`:

```js
test('graph budget preserves structural and call edges before references', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recall-dense-graph-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'), { recursive: true });
  const targets = Array.from({ length: 30 }, (_, index) => `export function target${index}(){ return ${index}; }`);
  const calls = Array.from({ length: 30 }, (_, caller) => (
    `export function caller${caller}(){ return ${Array.from({ length: 30 }, (_, target) => `target${target}()`).join(' + ')}; }`
  ));
  await writeFile(path.join(root, 'src', 'dense.js'), `${targets.join('\n')}\n${calls.join('\n')}\n`);

  const index = await buildJsTsSourceIndex({ root, workspaceId: 'ws_local' });
  const graph = buildSourceGraphFromIndex(index, {
    builtAt: '2026-07-15T10:00:00.000Z',
    maxNodes: 200,
    maxEdges: 300
  });

  assert(graph.nodes.length <= 200);
  assert(graph.edges.length <= 300);
  assert.equal(graph.summary.coverage.status, 'partial');
  assert(graph.summary.coverage.omittedEdgeCount > 0);
  assert(graph.summary.coverage.omittedEdgeKindCounts.references > 0);
  assert(graph.summary.edgeKindCounts.contains > 0);
  assert(graph.summary.edgeKindCounts.defined_in > 0);
  assert(graph.summary.edgeKindCounts.calls > 0);
  assert.equal(validateJsonSchema(sourceGraphSchema, graph).valid, true);
});
```

- [x] **Step 2: Run the budget test and verify schema overflow**

Run:

```bash
node --test --test-name-pattern="graph budget" tests/source-graph-preview.test.mjs
```

Expected: FAIL because `buildSourceGraphFromIndex` has no budgets and the schema has no omission fields.

- [x] **Step 3: Implement deterministic node and edge budgets**

Add constants and normalize options:

```js
export const DEFAULT_SOURCE_GRAPH_MAX_NODES = 20_000;
export const DEFAULT_SOURCE_GRAPH_MAX_EDGES = 50_000;
const EDGE_BUDGET_ORDER = Object.freeze(['contains', 'defined_in', 'imports', 'exports', 'calls', 'references']);
```

Build nodes in deterministic file, chunk, symbol, and module order. When the node budget is exhausted, count omitted nodes by kind and do not create edges to omitted nodes. Stage edge candidates by kind, sort each kind by `id`, then take them in `EDGE_BUDGET_ORDER` until `maxEdges`. Produce:

```js
coverage: {
  ...index.coverage,
  ignoreRuleFingerprint: index.discoveryIdentity.ignoreRuleFingerprint,
  ignoreFileLocators: index.discoveryIdentity.ignoreFileLocators,
  status: omittedNodeCount || omittedEdgeCount || index.coverage.status === 'partial' ? 'partial' : 'complete',
  candidateNodeCount,
  representedNodeCount: nodes.length,
  omittedNodeCount,
  omittedNodeKindCounts,
  candidateEdgeCount,
  representedEdgeCount: edges.length,
  omittedEdgeCount,
  omittedEdgeKindCounts,
  reasonCodes: uniqueSortedStrings([
    ...index.coverage.reasonCodes,
    ...(omittedNodeCount ? ['node_budget_reached'] : []),
    ...(omittedEdgeCount ? ['edge_budget_reached'] : [])
  ])
}
```

Do not truncate after graph construction. The returned graph itself must satisfy the public schema.

- [x] **Step 4: Extend additive schemas, examples, OpenAPI, and RFC**

Add optional bounded integer/count-map properties to the shared coverage definitions in both graph schemas. Also allow `ignoreRuleFingerprint` as a `sha256:` string and up to 100 safe workspace-relative `ignoreFileLocators`; these fields let the later snapshot service identify the discovery policy without exposing file bodies or absolute roots. Keep existing required fields and schema versions unchanged. Update `examples/protocol/source-graph.json` and `source-graph-preview.json` with a partial example. Add one paragraph to RFC 0001 explaining that additive v1 coverage fields report omitted candidates and never expand authority. Mirror the fields in `docs/api/openapi.yaml`.

- [x] **Step 5: Run graph and protocol verification**

Run:

```bash
node --test tests/source-graph-preview.test.mjs tests/ast-code-candidate-source.test.mjs
npm run protocol:validate
```

Expected: graph-budget tests, existing graph tests, and compatibility fixtures pass.

- [x] **Step 6: Commit bounded construction**

```bash
git add providers/native/context-candidate-ast-code/src/index.mjs packages/protocol/schemas/source-graph.schema.json packages/protocol/schemas/source-graph-preview.schema.json examples/protocol/source-graph.json examples/protocol/source-graph-preview.json docs/api/openapi.yaml rfcs/0001-protocol-contracts.md tests/source-graph-preview.test.mjs
git commit -m "feat: return bounded partial source graphs"
```

### Task 4: Add deterministic orientation and focused-neighborhood projections

**Files:**
- Create: `packages/source-graph/src/orientation.mjs`
- Modify: `packages/source-graph/src/index.mjs`
- Modify: `packages/recall-map/src/index.mjs`
- Modify: `packages/protocol/schemas/source-graph-preview.schema.json`
- Modify: `packages/protocol/schemas/recall-map.schema.json`
- Modify: `examples/protocol/source-graph-preview.json`
- Modify: `examples/protocol/recall-map.json`
- Test: `tests/source-graph-preview.test.mjs`
- Test: `tests/recall-map.test.mjs`

**Interfaces:**
- Produces: `buildSourceGraphOrientation(graph, options): { groups, relations }`.
- Produces: `buildSourceGraphFocus(graph, options): { nodes, edges, omittedNodes, omittedEdges }`.
- `buildSourceGraphPreview()` adds top-level `orientation` and `focus` projections.
- `buildRecallMap()` projects `orientation.groups` and `orientation.relations` under `architecture`.

- [x] **Step 1: Write failing deterministic orientation tests**

Extend the provider import with `buildJsTsSourceGraph` and `rankArchitectureNodes`, and import both new projection functions from `orientation.mjs`. Add this test and helper:

```js
test('source graph orientation is deterministic and bounded', async (t) => {
  const root = await writeOrientationRepository(t);
  const graph = await buildJsTsSourceGraph({ root, workspaceId: 'ws_local' });
  const ranking = rankArchitectureNodes(graph, { changedLocators: ['workspace://apps/web/app.js'], limit: 12 });
  const options = {
    changedLocators: ['workspace://apps/web/app.js'],
    entryPoints: ranking.entryPoints,
    maxGroups: 12,
    maxRelations: 20
  };
  const orientation = buildSourceGraphOrientation(graph, options);
  assert.deepEqual(orientation.groups.map(({ prefix }) => prefix), [
    'apps/web',
    'packages/source-graph',
    'providers/native/context-candidate-ast-code',
    'scripts',
    'services/control-api',
    'tests'
  ]);
  assert.equal(orientation.groups.find(({ prefix }) => prefix === 'apps/web').changedFileCount, 1);
  assert.equal(orientation.groups.every(({ entryPoints }) => entryPoints.length <= 2), true);
  assert.equal(orientation.relations.length <= 20, true);
  assert.deepEqual(orientation, buildSourceGraphOrientation(structuredClone(graph), options));
});

async function writeOrientationRepository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recall-orientation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new Map([
    ['apps/web/app.js', 'import { build } from "../../packages/source-graph/index.js";\nexport function renderOverview(){ return build(); }\n'],
    ['packages/source-graph/index.js', 'import { serve } from "../../services/control-api/server.js";\nexport function build(){ return serve(); }\n'],
    ['services/control-api/server.js', 'import { parse } from "../../providers/native/context-candidate-ast-code/index.js";\nexport function serve(){ return parse(); }\n'],
    ['providers/native/context-candidate-ast-code/index.js', 'export function parse(){ return "ready"; }\n'],
    ['scripts/smoke.js', 'import { renderOverview } from "../apps/web/app.js";\nexport const smoke = renderOverview();\n'],
    ['tests/web.test.js', 'import { renderOverview } from "../apps/web/app.js";\nexport const expected = typeof renderOverview;\n']
  ]);
  for (const [relative, body] of files) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), body);
  }
  return root;
}
```

- [x] **Step 2: Write failing focused-neighborhood tests**

For a query result inside `apps/web`, reuse `writeOrientationRepository()` and assert the focus projection contains seed nodes and bounded adjacent edges but not the full graph:

```js
test('source graph focus returns a bounded neighborhood', async (t) => {
  const root = await writeOrientationRepository(t);
  const graph = await buildJsTsSourceGraph({ root, workspaceId: 'ws_local' });
  const seed = graph.nodes.find(({ label }) => label === 'renderOverview');
  assert(seed);
  const focus = buildSourceGraphFocus(graph, {
    seedNodeIds: [seed.id],
    locatorPrefix: 'workspace://apps/web',
    nodeLimit: 50,
    edgeLimit: 100
  });
  assert(focus.nodes.some(({ id }) => id === seed.id));
  assert(focus.nodes.every(({ locator }) => !locator || locator.startsWith('workspace://apps/web')));
  assert(focus.nodes.length <= 50);
  assert(focus.edges.length <= 100);
  assert(focus.omittedNodes > 0 || focus.nodes.length < graph.nodes.length);
});
```

- [x] **Step 3: Run the projection tests and verify missing exports**

Run:

```bash
node --test --test-name-pattern="deterministic orientation|focused neighborhood" tests/source-graph-preview.test.mjs
```

Expected: FAIL because `orientation.mjs`, `buildSourceGraphOrientation`, and `buildSourceGraphFocus` do not exist.

- [x] **Step 4: Implement deterministic group derivation**

Create `orientation.mjs`. Convert node locators to repository-relative paths. Use two segments for known workspace roots (`apps`, `packages`, `services`, `plugins`, `examples`, `tests`, and `scripts`), three for `providers/<kind>/<name>` when available, and one segment otherwise. Never invent a group.

```js
function groupPrefix(locator) {
  const parts = relativeLocator(locator).split('/').filter(Boolean);
  if (!parts.length) return null;
  if (parts[0] === 'providers') return parts.slice(0, Math.min(3, parts.length - 1 || 1)).join('/');
  if (new Set(['apps', 'packages', 'services', 'plugins', 'examples', 'tests', 'scripts']).has(parts[0])) {
    return parts.slice(0, Math.min(2, parts.length - 1 || 1)).join('/');
  }
  return parts[0];
}

function relativeLocator(locator) {
  const value = String(locator ?? '').split('#', 1)[0];
  return value.startsWith('workspace://') ? value.slice('workspace://'.length) : '';
}
```

Count unique files and symbols per group. Assign up to two ranked entry points by locator prefix. Aggregate only inter-group `imports` and `calls` relations, sort by descending count then source/target prefix, and cap at 20. Create stable IDs with the existing hash helper; do not expose package-manager metadata or absolute paths.

- [x] **Step 5: Implement a bounded one-hop focus projection**

Start from query/search/trace/impact seed IDs. If `locatorPrefix` is present, include matching file and symbol nodes first. Add one-hop edges in priority order `calls`, `imports`, `exports`, `defined_in`, `contains`, `references`. Add the opposite endpoint only while under the node limit. Sort returned nodes/edges by ID and report omitted counts from the eligible neighborhood.

```js
return Object.freeze({
  nodeLimit,
  edgeLimit,
  nodes: Object.freeze(selectedNodes),
  edges: Object.freeze(selectedEdges),
  omittedNodes: Math.max(0, eligibleNodeIds.size - selectedNodes.length),
  omittedEdges: Math.max(0, eligibleEdges.length - selectedEdges.length)
});
```

- [x] **Step 6: Wire projections into preview and Recall Map**

Build `orientation` from the validated public graph. Build focus seeds from search result node IDs, trace path node IDs, and impact node IDs. For an unscoped empty query, return an empty focus so Overview uses groups rather than a raw file graph. Project the same group/relations objects into Recall Map:

```js
architecture: {
  ...existingArchitecture,
  groups: preview.orientation.groups,
  groupRelations: preview.orientation.relations
}
```

Add optional strict bounded definitions to both schemas: 12 groups, 20 relations, 200 focus nodes, and 400 focus edges. The producer always emits them, while the optional schema fields preserve additive v1 reader compatibility. Update both examples.

- [x] **Step 7: Verify projection and protocol behavior**

Run:

```bash
node --test tests/source-graph-preview.test.mjs tests/recall-map.test.mjs
npm run protocol:validate
```

Expected: orientation, focus, Recall Map, and protocol tests pass.

- [x] **Step 8: Commit orientation data**

```bash
git add packages/source-graph/src/orientation.mjs packages/source-graph/src/index.mjs packages/recall-map/src/index.mjs packages/protocol/schemas/source-graph-preview.schema.json packages/protocol/schemas/recall-map.schema.json examples/protocol/source-graph-preview.json examples/protocol/recall-map.json tests/source-graph-preview.test.mjs tests/recall-map.test.mjs
git commit -m "feat: project bounded repository orientation data"
```

### Task 5: Add the injected in-process snapshot service

**Files:**
- Create: `packages/source-graph/src/snapshot-service.mjs`
- Create: `tests/source-graph-snapshot-service.test.mjs`
- Modify: `packages/source-graph/src/index.mjs`
- Modify: `packages/protocol/schemas/source-graph-preview.schema.json`
- Modify: `examples/protocol/source-graph-preview.json`

**Interfaces:**
- Produces: `createSourceGraphSnapshotService(options): SourceGraphSnapshotService`.
- Produces methods `getSnapshot(request)`, `markDirty(root, reason)`, `inspect(root)`, and `close()`.
- `buildSourceGraphPreview(options)` adds optional `snapshotService` and `refresh = false`.
- Snapshot identity is SHA-256 over canonical root, graph/parser version, ignore-rule fingerprint, and source-index fingerprint.

- [x] **Step 1: Write failing cache, concurrency, invalidation, and stale tests**

Create `tests/source-graph-snapshot-service.test.mjs` using an injected `buildGraph` counter and injected watcher:

```js
test('snapshot service reuses, deduplicates, invalidates, and preserves last valid graph', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recall-snapshot-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let builds = 0;
  let fail = false;
  let onChange = null;
  const graph = fixtureGraph();
  const service = createSourceGraphSnapshotService({
    buildGraph: async () => {
      builds += 1;
      await Promise.resolve();
      if (fail) throw new Error('fixture_build_failed');
      return graph;
    },
    watchRoot: (_root, listener) => {
      onChange = listener;
      return { close() {} };
    },
    clock: () => 1000
  });
  t.after(() => service.close());

  const request = { root, workspaceId: 'ws_local', maxFiles: 1000, maxFileBytes: 524288 };
  const [first, concurrent] = await Promise.all([service.getSnapshot(request), service.getSnapshot(request)]);
  assert.equal(builds, 1);
  assert.equal(first.reuse, 'cold');
  assert.equal(concurrent.reuse, 'inflight');

  const cached = await service.getSnapshot(request);
  assert.equal(cached.reuse, 'cache');
  assert.equal(builds, 1);
  assert.match(service.inspect(root).identity, /^sha256:[a-f0-9]{64}$/u);

  onChange('change', 'src/app.js');
  fail = true;
  const stale = await service.getSnapshot(request);
  assert.equal(stale.status, 'stale');
  assert.equal(stale.graph.graphFingerprint, graph.graphFingerprint);
  assert.equal(builds, 2);
});

test('snapshot service falls back to a bounded metadata scan when recursive watch is unavailable', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recall-snapshot-fallback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let builds = 0;
  let manifest = 'manifest:a';
  const unavailable = Object.assign(new Error('recursive watch unavailable'), { code: 'ERR_FEATURE_UNAVAILABLE' });
  const service = createSourceGraphSnapshotService({
    buildGraph: async () => {
      builds += 1;
      return fixtureGraph();
    },
    watchRoot: () => { throw unavailable; },
    freshnessProbe: async () => manifest,
    clock: () => 1000
  });
  t.after(() => service.close());
  const request = { root, workspaceId: 'ws_local', maxFiles: 1000, maxFileBytes: 524288 };

  await service.getSnapshot(request);
  const cached = await service.getSnapshot(request);
  assert.equal(cached.reuse, 'cache');
  assert.equal(cached.validationMode, 'metadata-scan');
  assert.equal(builds, 1);

  manifest = 'manifest:b';
  const rebuilt = await service.getSnapshot(request);
  assert.equal(rebuilt.reuse, 'cold');
  assert.equal(builds, 2);
});

function fixtureGraph() {
  return Object.freeze({
    schemaVersion: '1.0.0',
    workspaceId: 'ws_local',
    graphVersion: 'memory-recall-test-1.0.0',
    parserVersion: 'memory-recall-test-parser',
    builtAt: '2026-07-15T10:00:00.000Z',
    sourceIndexFingerprint: `sha256:${'a'.repeat(64)}`,
    graphFingerprint: `sha256:${'b'.repeat(64)}`,
    summary: {
      fileCount: 1,
      symbolCount: 0,
      moduleCount: 0,
      nodeCount: 0,
      edgeCount: 0,
      nodeKindCounts: {},
      edgeKindCounts: {},
      hotspots: [],
      entryPoints: [],
      coverage: {
        ignoreRuleFingerprint: `sha256:${'c'.repeat(64)}`,
        ignoreFileLocators: []
      }
    },
    nodes: [],
    edges: [],
    diagnostics: []
  });
}
```

Import `mkdtemp` and `rm` from `node:fs/promises`, plus `os` and `path`; the request root must be canonicalized by the service.

- [x] **Step 2: Run the service test and verify the missing module**

Run:

```bash
node --test tests/source-graph-snapshot-service.test.mjs
```

Expected: FAIL with module-not-found for `snapshot-service.mjs`.

- [x] **Step 3: Implement the snapshot service**

Create `snapshot-service.mjs` with one entry per canonical root plus graph options. Use `node:fs.watch` recursively by default. Relevant supported-source, `.gitignore`, and `.recallignore` events increment `dirtyGeneration`; ignored/cache/build output events do not. The service result shape is:

```js
Object.freeze({
  graph,
  status: 'fresh', // or 'stale'
  reuse: 'cold',   // or 'cache' or 'inflight'
  reason: null,
  generation,
  buildDurationMs,
  builtAt: graph.builtAt
})
```

Use a `Map` of entries with `{ graph, identity, manifest, dirty, generation, inFlight, watcher, validationMode, lastBuildDurationMs }`. Compute identity with `node:crypto` SHA-256 over canonical root, `graphVersion`, `parserVersion`, `graph.summary.coverage.ignoreRuleFingerprint`, and `sourceIndexFingerprint`. Set `inFlight` before awaiting the build. Clear it in `finally`. Replace `graph`, identity, and manifest only after a successful build. On failure with a last valid graph, return `status: 'stale'`, `reason: safe error code`, and the old graph. On first-build failure, rethrow. `close()` closes every watcher and clears the map.

The default watcher uses `fs.watch(root, { recursive: true })`. If recursive watching reports `ERR_FEATURE_UNAVAILABLE` or `ERR_INVALID_ARG_VALUE`, set `validationMode` to `metadata-scan`. The default bounded freshness probe stats the canonical root, safe file-node locators, every directory prefix derived from those locators, and `ignoreFileLocators`, capped by the existing 1,000-file/100-ignore-file bounds; sort `{ locator, size, mtimeMs }` tuples and hash them. Before returning a cached result in this mode, compare the manifest and mark dirty on change. This fallback may scan metadata but must not read source bodies or walk outside the canonical root.

- [x] **Step 4: Query the snapshot from the preview facade**

In `buildSourceGraphPreview()`:

```js
const snapshot = snapshotService
  ? await snapshotService.getSnapshot({ root, workspaceId: safeWorkspaceId, maxFiles: boundedMaxFiles, maxFileBytes: boundedMaxFileBytes, refresh })
  : { graph: await buildJsTsSourceGraph({ root, workspaceId: safeWorkspaceId, maxFiles: boundedMaxFiles, maxFileBytes: boundedMaxFileBytes, clock: () => generatedAt }), status: 'fresh', reuse: 'cold', reason: null, generation: 0, buildDurationMs: null };
graph = snapshot.graph;
```

Add a `snapshot` object to every preview response with `status`, `reuse`, `reason`, `generation`, `validationMode`, `buildDurationMs`, and `builtAt`. Define it as an optional additive field in the v1 schema so older valid producers remain readable. The unavailable response uses `{ status: 'unavailable', reuse: 'none', reason: code, generation: 0, validationMode: 'none', buildDurationMs: null, builtAt: null }`. The UI may label `metadata-scan` as a scan; it must not describe it as watcher-backed reuse.

- [x] **Step 5: Verify snapshot and facade behavior**

Run:

```bash
node --test tests/source-graph-snapshot-service.test.mjs tests/source-graph-preview.test.mjs
npm run protocol:validate
```

Expected: service, facade, and protocol tests pass.

- [x] **Step 6: Commit snapshot service**

```bash
git add packages/source-graph/src/snapshot-service.mjs packages/source-graph/src/index.mjs packages/protocol/schemas/source-graph-preview.schema.json examples/protocol/source-graph-preview.json tests/source-graph-snapshot-service.test.mjs tests/source-graph-preview.test.mjs
git commit -m "feat: reuse source graph snapshots"
```

### Task 6: Share one snapshot across Recall Map and Map API operations

**Files:**
- Modify: `packages/recall-map/src/index.mjs`
- Modify: `packages/protocol/schemas/recall-map.schema.json`
- Modify: `examples/protocol/recall-map.json`
- Modify: `services/control-api/src/server.mjs`
- Modify: `services/control-api/src/route-contracts.mjs`
- Modify: `tests/recall-map.test.mjs`
- Modify: `tests/control-api-boundary.test.mjs`

**Interfaces:**
- `buildRecallMap(options)` adds `sourceGraphSnapshotService` and `refreshSourceGraph = false`.
- `createControlApiServer(options)` adds injectable `sourceGraphSnapshotService`.

- [x] **Step 1: Write the failing shared-build Control API test**

In `tests/control-api-boundary.test.mjs`, import `buildJsTsSourceGraph` and `createSourceGraphSnapshotService`. Use the existing `startServer()` injectable harness so the test exercises both authenticated routes against the same real service and temporary repository:

```js
test('Recall Map and source preview share one source snapshot', async (t) => {
  const sourceGraphRoot = await mkdtemp(path.join(os.tmpdir(), 'oaf-shared-source-snapshot-'));
  t.after(async () => rm(sourceGraphRoot, { recursive: true, force: true }));
  await mkdir(path.join(sourceGraphRoot, 'src'), { recursive: true });
  await writeFile(path.join(sourceGraphRoot, 'src', 'app.js'), 'export const sharedSnapshotFixture = true;\n');

  let buildCount = 0;
  const sourceGraphSnapshotService = createSourceGraphSnapshotService({
    buildGraph: async (options) => {
      buildCount += 1;
      return buildJsTsSourceGraph(options);
    }
  });
  t.after(() => sourceGraphSnapshotService.close());
  const api = await startServer(t, { sourceGraphRoot, sourceGraphSnapshotService });
  const authHeaders = { cookie: api.auth.cookie, origin: api.base };

  const recall = await request(api.base, '/api/recall/map?workspaceId=ws_local', {
    headers: authHeaders
  });
  const map = await request(api.base, '/api/context/graph/preview', {
    method: 'POST',
    headers: {
      ...authHeaders,
      'content-type': 'application/json',
      'x-csrf-token': api.auth.csrf
    },
    body: JSON.stringify({ workspaceId: 'ws_local', sampleLimit: 3 })
  });

  assert.equal(recall.status, 200, recall.text);
  assert.equal(map.status, 200, map.text);
  assert.equal(buildCount, 1);
  assert.equal(recall.body.support.sourceGraph.snapshot.reuse, 'cold');
  assert.equal(map.body.snapshot.reuse, 'cache');
  assert.equal(map.body.graph.summary.fileCount > 0, true);
});
```

The test owns and closes its injected service. The server must never close a caller-owned service.

Also add a stale fixture to `tests/recall-map.test.mjs` and assert `support.sourceGraph.coverage.status === 'stale'`, not `unavailable` and not a zero-result ready state.

- [x] **Step 2: Run focused tests and verify duplicate construction**

Run:

```bash
node --test --test-name-pattern="share one source snapshot|stale source snapshot" tests/control-api-boundary.test.mjs tests/recall-map.test.mjs
```

Expected: FAIL because Recall Map and preview build independently and Recall Map has no snapshot projection.

- [x] **Step 3: Inject the service into Recall Map**

Call `buildSourceGraphPreview({ snapshotService: sourceGraphSnapshotService, refresh: refreshSourceGraph, ... })`. Project snapshot truth under `support.sourceGraph.snapshot`:

```js
snapshot: {
  status: preview.snapshot.status,
  reuse: preview.snapshot.reuse,
  reason: preview.snapshot.reason,
  validationMode: preview.snapshot.validationMode,
  builtAt: preview.snapshot.builtAt,
  buildDurationMs: preview.snapshot.buildDurationMs
}
```

Set coverage to `stale` when the last valid snapshot is shown after a failed refresh, `partial` for bounded omission, `complete` only for complete current coverage, and `unavailable` only when no graph exists.

- [x] **Step 4: Own one service in the Control API server**

Import `createSourceGraphSnapshotService`. In `createControlApiServer()`, use the injected service or create one:

```js
const sourceSnapshots = sourceGraphSnapshotService ?? createSourceGraphSnapshotService();
const ownsSourceSnapshots = !sourceGraphSnapshotService;
server.once('close', () => {
  if (ownsSourceSnapshots) sourceSnapshots.close();
});
```

Pass `sourceSnapshots` to both `buildRecallMap()` cases and `buildSourceGraphPreview()` in `previewContextGraph`. Add an optional boolean `refresh` to the POST Recall Map and graph-preview request schemas. Pass it as `refreshSourceGraph` or `refresh`; a true value marks the root dirty before the request. GET remains cache-aware and read-only. Preserve all auth, rate-limit, validation, and side-effect behavior.

- [x] **Step 5: Extend Recall Map schema and examples additively**

Allow coverage states `complete`, `partial`, `stale`, and `unavailable`. Add the bounded snapshot object and optional request `refresh` flag. Update the example and route contract fixtures. Do not rename existing source-graph or readiness fields.

- [x] **Step 6: Verify shared API behavior**

Run:

```bash
node --test tests/recall-map.test.mjs tests/control-api.test.mjs tests/control-api-boundary.test.mjs
npm run protocol:validate
```

Expected: all focused API, boundary, and protocol tests pass with one shared graph build.

- [x] **Step 7: Commit Control API reuse**

```bash
git add packages/recall-map/src/index.mjs packages/protocol/schemas/recall-map.schema.json examples/protocol/recall-map.json services/control-api/src/server.mjs services/control-api/src/route-contracts.mjs tests/recall-map.test.mjs tests/control-api-boundary.test.mjs
git commit -m "feat: share graph snapshots across local map routes"
```

### Task 7: Add generated and real-repository performance proof

**Files:**
- Create: `scripts/source-graph-large-repo-smoke.mjs`
- Modify: `package.json`
- Modify: `docs/usage/recall-map.md`
- Test: `tests/source-graph-preview.test.mjs`

**Interfaces:**
- Produces command: `npm run source-graph:large-smoke`.
- Optional environment: `MEMORY_RECALL_LARGE_REPO_ROOT=/absolute/read-only/repository`.
- Emits one JSON object with cold/cached timings, counts, coverage, cache reuse, and validation state.

- [x] **Step 1: Write the smoke script assertions before implementation**

Create the script entry with these terminal assertions:

```js
must(first.graph.summary.fileCount > 0, 'large_repo_graph_empty');
must(!first.graph.diagnostics.some(({ code }) => code.startsWith('source_graph_unavailable')), 'large_repo_graph_unavailable');
must(first.graph.summary.nodeCount <= 20_000, 'large_repo_node_budget_exceeded');
must(first.graph.summary.edgeCount <= 50_000, 'large_repo_edge_budget_exceeded');
must(second.snapshot.reuse === 'cache', 'large_repo_snapshot_not_reused');
must(cachedMs <= coldMs * 0.2, `large_repo_cache_not_80_percent_faster:${coldMs}:${cachedMs}`);
```

The generated fixture must include at least 1,100 supported files, more than 50,000 candidate relations, ordinary `users` paths, `.worktrees`, `.venv`, generated output, nested `.gitignore`, and `.recallignore`. Use bounded file bodies and remove the temporary fixture in `finally`.

- [x] **Step 2: Add the package command and run it red**

Add:

```json
"source-graph:large-smoke": "node scripts/source-graph-large-repo-smoke.mjs"
```

Run:

```bash
npm run source-graph:large-smoke
```

Expected before the preceding tasks are complete: FAIL on unavailable graph, edge budget, ignored-tree traversal, or cache reuse.

- [x] **Step 3: Finish generated and optional real-repository measurement**

Use one `createSourceGraphSnapshotService()` for both preview calls. When `MEMORY_RECALL_LARGE_REPO_ROOT` is present, run the same read-only checks against that canonical root without creating or editing files there. Emit:

```js
console.log(JSON.stringify({
  schemaVersion: '1.0.0',
  rootKind: configuredRoot ? 'configured' : 'generated',
  coldMs,
  cachedMs,
  cacheReductionPercent: Number(((1 - cachedMs / coldMs) * 100).toFixed(2)),
  snapshot: second.snapshot,
  summary: first.graph.summary,
  diagnostics: first.graph.diagnostics.map(({ code }) => code),
  protocolValid: validateJsonSchema(sourceGraphPreviewSchema, first).valid
}, null, 2));
```

- [x] **Step 4: Document operator behavior**

Update `docs/usage/recall-map.md` with default exclusions, `.recallignore`, supported-file budgeting, partial coverage reason codes, automatic invalidation, explicit refresh, and the large-repository command. State that timings are local measurements, not universal claims.

- [x] **Step 5: Run foundation verification**

Run:

```bash
npm run source-graph:large-smoke
MEMORY_RECALL_LARGE_REPO_ROOT=/Users/rebel/Desktop/polychads-clean npm run source-graph:large-smoke
node --test tests/source-graph-discovery.test.mjs tests/source-graph-snapshot-service.test.mjs tests/source-graph-preview.test.mjs tests/recall-map.test.mjs tests/control-api.test.mjs tests/control-api-boundary.test.mjs
npm run protocol:validate
```

Expected: both smoke modes return non-empty valid results, the cached path is at least 80% faster, and all focused tests pass.

- [x] **Step 6: Commit performance proof**

```bash
git add scripts/source-graph-large-repo-smoke.mjs package.json docs/usage/recall-map.md tests/source-graph-preview.test.mjs
git commit -m "test: prove large repository graph performance"
```

### Task 8: Run the graph-foundation release gate

**Files:**
- Verify only; fix failures in the owning task before continuing.

**Interfaces:**
- Produces a clean, independently testable graph foundation for the UI plan.

- [x] **Step 1: Run all source, map, protocol, and consumer checks**

```bash
npm run check
npm run protocol:validate
node --test tests/ast-code-candidate-source.test.mjs tests/source-graph-discovery.test.mjs tests/source-graph-snapshot-service.test.mjs tests/source-graph-preview.test.mjs tests/recall-map-ranking.test.mjs tests/recall-map.test.mjs tests/control-api.test.mjs tests/control-api-boundary.test.mjs
npm run source-graph:large-smoke
npm run consumer:smoke
```

Expected: every command exits 0.

- [x] **Step 2: Confirm no security or side-effect drift**

Inspect both generated and real-repository smoke JSON. Confirm:

```text
networkCalls = 0
modelCalls = 0
externalWritesEnabled = false
rawBodyIncluded = false
graphDatabaseUsed = false
protocolValid = true
```

- [x] **Step 3: Record the foundation checkpoint**

```bash
git status --short
git log --oneline -7
```

Expected: clean worktree and one focused commit per task. Do not squash before the UI plan is verified.
