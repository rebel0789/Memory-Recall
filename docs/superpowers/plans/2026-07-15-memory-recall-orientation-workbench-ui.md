# Memory Recall Orientation Workbench UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the rejected Overview, Map, and memory-graph presentation with a compact, orientation-first workbench that shows repository structure, starting points, change impact, and trusted context without AI-style slogans or generic dashboard design.

**Architecture:** Keep the existing static ESM shell and five-destination navigation. Split pure view models and route renderers out of `apps/web/app.js`, consume the bounded orientation/focus projections from the graph-foundation plan, run detailed graph layout in a worker, and provide semantic outlines as the canonical accessible representation.

**Tech Stack:** Browser-native ESM, semantic HTML, CSS custom properties, Canvas 2D for data visualization, Web Workers, Node test runner, Playwright consumer browser smoke.

## Prerequisite

Complete and verify `docs/superpowers/plans/2026-07-15-memory-recall-large-repository-graph-foundation.md` first. This UI plan consumes `report.architecture.groups`, `report.architecture.groupRelations`, `preview.orientation`, `preview.focus`, and `preview.snapshot` exactly as defined there.

## Global Constraints

- Follow `DESIGN.md` and the approved `2026-07-15-memory-recall-orientation-workbench-design.md` specification.
- Preserve the existing five destinations, stable deep links, local-only boundary, setup flow, Memory review queue, Handoffs flow, and Settings behavior.
- Add no frontend framework, graph library, icon library, runtime dependency, model call, network service, or new product route.
- Use the existing native system sans, native monospace, warm off-white, graphite, restrained cobalt, 6 px controls, and 8 px bounded panels.
- Use lists, rules, aligned rows, and disclosures before cards; do not add gradients, glow, glass, heavy shadows, decorative art, ambient motion, or a metric-card wall.
- Minimal means fewer elements, not empty space: related gaps are 8 to 16 px and primary-region gaps use only 24 or 32 px tokens.
- No hero, slogan, promotional subtitle, fake chat, typing indicator, sparkle mark, robot imagery, or intelligence theater.
- Visible copy names an object, state, reason, or action. AI/model/provider terms appear only for a real configured provider, operation, setting, or technical boundary.
- Overview shows at most 12 deterministic groups, at most 20 inter-group relations, and exactly three `Start here` items when three are available.
- Detailed graphs render only a focused bounded payload and perform no unbounded quadratic layout on the main thread.
- Every visual graph has a keyboard-reachable outline with identical selection and inspector state.
- Preserve query and scope through submit, success, partial result, failure, reload, back, and forward.
- Empty governed memory renders no canvas and no zero-value metric strip.
- Meet WCAG 2.2 AA, visible focus, 44 px primary touch targets, reduced motion, light/dark modes, and no horizontal overflow at 320, 375, 414, 768, and 1440 px.

---

## File Map

### Create

- `apps/web/api.js`: loopback JSON requests, CSRF handling, and bounded API errors.
- `apps/web/ui-primitives.js`: escaping, state panels, error recovery, date/fingerprint formatting, and status text.
- `apps/web/orientation-model.js`: pure Overview state, group layering, starting-point ranking, impact, and trust models.
- `apps/web/orientation-view.js`: Overview markup and selected-group interactions.
- `apps/web/source-map-view.js`: Map URL state, request payload, renderer, outline, inspector, and viewport controls.
- `apps/web/memory-graph-view.js`: governed-memory graph model, empty/populated rendering, outline, and inspector.
- `apps/web/graph-viewport.js`: shared canvas transform, hit testing, selection, outline parity, and worker lifecycle.
- `apps/web/graph-layout-worker.js`: deterministic bounded detailed-graph layout off the main thread.
- `tests/web-orientation.test.mjs`: Overview model and markup tests.
- `tests/web-source-map.test.mjs`: Map URL, focused graph, outline, and error-state tests.
- `tests/web-memory-graph.test.mjs`: empty/populated governed-memory graph tests.

### Modify

- `apps/web/app.js`: retain boot, routing, shared shell state, and delegation only for touched routes.
- `apps/web/index.html`: turn the existing repository search into the single deterministic command bar.
- `apps/web/styles.css`: add compact orientation, map, graph, outline, and responsive styles; remove obsolete touched-route styles.
- `apps/web/tokens.css`: reuse tokens; change only if a missing semantic alias is proven.
- `tests/web-shell.test.mjs`: update module imports and retain shell regression coverage.
- `scripts/consumer-browser-smoke.mjs`: exercise the new first-ten-seconds contract, Map, and memory graph across states and widths.
- `DESIGN.md`: change only if implementation finds an unrecorded canonical rule; do not weaken existing constraints.

---

### Task 1: Extract API and shared UI primitives without visual change

**Files:**
- Create: `apps/web/api.js`
- Create: `apps/web/ui-primitives.js`
- Modify: `apps/web/app.js`
- Modify: `tests/web-shell.test.mjs`

**Interfaces:**
- Produces: `requestJson(path, options): Promise<object>` and `ApiRequestError` from `api.js`.
- Produces: `escapeHtml`, `formatDate`, `shortFingerprint`, `buildApiErrorUiModel`, `renderApiErrorPanel`, and `statePanel` from `ui-primitives.js`.
- `app.js` imports and delegates to these functions; route behavior remains unchanged.

- [x] **Step 0: Capture the rejected UI as baseline evidence**

Before changing any visual markup or CSS, run the existing browser smoke and preserve the current Overview, Map, and Memory screenshots outside the files later runs overwrite:

```bash
mkdir -p .scratch/ui-redesign/before
npm run consumer:browser-smoke
cp .scratch/ui-redesign/overview-desktop-light-1440.png .scratch/ui-redesign/before/overview-desktop-light-1440.png
cp .scratch/ui-redesign/map-desktop-1440.png .scratch/ui-redesign/before/map-desktop-1440.png
cp .scratch/ui-redesign/memory-desktop-1440.png .scratch/ui-redesign/before/memory-desktop-1440.png
```

Expected: the three baseline files exist and remain uncommitted for the final visual comparison.

- [x] **Step 1: Write failing module-boundary tests**

Add to `tests/web-shell.test.mjs`:

```js
test('web API and UI primitives are focused modules', async () => {
  const apiSource = await readFile(new URL('../apps/web/api.js', import.meta.url), 'utf8');
  const primitiveSource = await readFile(new URL('../apps/web/ui-primitives.js', import.meta.url), 'utf8');
  const appSource = await readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8');
  assert.match(apiSource, /export async function requestJson/);
  assert.match(apiSource, /export class ApiRequestError/);
  assert.match(primitiveSource, /export function escapeHtml/);
  assert.match(primitiveSource, /export function statePanel/);
  assert.doesNotMatch(appSource, /async function api\(/);
  assert.doesNotMatch(appSource, /function statePanel\(/);
});
```

- [x] **Step 2: Run the boundary test and verify missing modules**

Run:

```bash
node --test --test-name-pattern="focused modules" tests/web-shell.test.mjs
```

Expected: FAIL because `api.js` and `ui-primitives.js` do not exist.

- [x] **Step 3: Extract the API client**

Move the existing CSRF lookup, request headers, JSON parsing, correlation ID, issue list, and error mapping into `apps/web/api.js`. Keep the public shape small:

```js
export class ApiRequestError extends Error {
  constructor(message, { status = null, code = '', correlationId = '', issues = [] } = {}) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.correlationId = correlationId;
    this.issues = issues;
  }
}

export async function requestJson(path, { method = 'GET', body, signal } = {}) {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    signal,
    headers: requestHeaders(method),
    body
  });
  const payload = await readPayload(response);
  if (!response.ok) throw apiError(response, payload);
  return payload;
}

function csrfToken() {
  return /(?:^|;\s*)oaf_csrf=([^;]+)/u.exec(globalThis.document?.cookie ?? '')?.[1] ?? '';
}

function requestHeaders(method) {
  const headers = new Headers();
  if (!['GET', 'HEAD'].includes(method)) {
    headers.set('content-type', 'application/json');
    const token = csrfToken();
    if (token) headers.set('x-csrf-token', token);
  }
  return headers;
}

async function readPayload(response) {
  return response.clone().json().catch(() => null);
}

function apiError(response, payload) {
  const code = payload?.error?.code ?? '';
  const message = code === 'bootstrap_required'
    ? 'Local owner setup is required.'
    : code === 'invalid_credentials'
      ? 'Username or password is incorrect.'
      : response.status === 401
        ? 'Local authentication required.'
        : payload?.error?.message ?? `Request failed with ${response.status}`;
  return new ApiRequestError(message, {
    status: response.status,
    code,
    correlationId: payload?.error?.correlationId ?? response.headers.get('x-correlation-id') ?? '',
    issues: Array.isArray(payload?.error?.issues) ? payload.error.issues : []
  });
}
```

Do not read storage, change auth semantics, retry automatically, or log response bodies.

- [x] **Step 4: Extract safe shared render helpers**

Move only pure formatting, escaping, state-panel, and API-error rendering into `ui-primitives.js`. Use dependency injection for action markup instead of importing route state. The escaping implementation remains:

```js
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/gu, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}
```

Export legacy aliases from `app.js` temporarily if existing tests or untouched routes import them. Do not duplicate implementation.

- [x] **Step 5: Run shell regression tests**

Run:

```bash
node --test tests/web-shell.test.mjs tests/control-api-boundary.test.mjs
```

Expected: all existing shell and boundary tests pass with no visual behavior change.

- [x] **Step 6: Commit the extraction**

```bash
git add apps/web/api.js apps/web/ui-primitives.js apps/web/app.js tests/web-shell.test.mjs
git commit -m "refactor: extract web API and UI primitives"
```

### Task 2: Build the deterministic orientation model

**Files:**
- Create: `apps/web/orientation-model.js`
- Create: `tests/web-orientation.test.mjs`
- Modify: `apps/web/app.js`
- Modify: `apps/web/shell-model.js`

**Interfaces:**
- Produces: `buildOrientationModel(input): OrientationModel`.
- Produces: `layerOrientationGroups(groups, relations): LayeredGroup[]`.
- Produces: `selectOrientationGroup(model, groupId): OrientationModel`.
- Consumes graph-foundation fields `architecture.groups` and `architecture.groupRelations`.
- Input accepts `loading = false`, `error = null`, `gitChanges = null`, `handoff = null`, and an injected `now` timestamp for deterministic age labels.

- [x] **Step 1: Write failing first-ten-seconds model tests**

Create `tests/web-orientation.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOrientationModel } from '../apps/web/orientation-model.js';

test('orientation model is deterministic and bounded', () => {
  const report = orientationFixture({ groupCount: 16, entryPointCount: 8 });
  const first = buildOrientationModel({ report, gitChanges: changedFixture(), handoff: handoffFixture() });
  const second = buildOrientationModel({ report: structuredClone(report), gitChanges: changedFixture(), handoff: handoffFixture() });
  assert.deepEqual(first.groups, second.groups);
  assert.equal(first.groups.length, 12);
  assert.equal(first.relations.length <= 20, true);
  assert.equal(first.startHere.length, 3);
  assert.deepEqual(first.startHere.map(({ reason }) => reason), [
    'application route',
    'package entry point',
    'changed central module'
  ]);
  assert.equal(first.repository.name, 'large-repository');
  assert.equal(first.repository.branch, 'main');
  assert.equal(first.coverage.status, 'partial');
  assert.equal(first.coverage.builtAt, '2026-07-15T09:59:00.000Z');
  assert.equal(first.impact.unrepresentedChangedCount, 1);
  assert.equal(first.trust.memory.status, 'pending');
  assert.equal(first.trust.handoff.status, 'verified');
});

test('small repositories keep real groups and do not invent filler', () => {
  const model = buildOrientationModel({ report: orientationFixture({ groupCount: 3, entryPointCount: 2 }) });
  assert.equal(model.groups.length, 3);
  assert.equal(model.startHere.length, 2);
});

test('orientation model distinguishes loading, clean, stale, empty, and failure truth', () => {
  assert.equal(buildOrientationModel({ loading: true }).state, 'loading');
  assert.equal(buildOrientationModel({ report: null, loading: false }).state, 'empty');
  assert.equal(buildOrientationModel({ error: { message: 'Graph validation failed.' } }).state, 'failure');

  const cleanReport = orientationFixture({ groupCount: 3, entryPointCount: 3 });
  cleanReport.repository.dirtyCount = 0;
  const clean = buildOrientationModel({ report: cleanReport, gitChanges: { status: 'available', changedLocators: [], totalCount: 0, omittedCount: 0, truncated: false } });
  assert.equal(clean.impact.status, 'clean');
  assert.equal(clean.impact.label, 'No local changes detected');

  const staleReport = orientationFixture({ groupCount: 3, entryPointCount: 3 });
  staleReport.support.sourceGraph.snapshot.status = 'stale';
  staleReport.support.sourceGraph.snapshot.reason = 'source_graph_refresh_failed';
  const stale = buildOrientationModel({ report: staleReport, now: '2026-07-15T10:00:00.000Z' });
  assert.equal(stale.state, 'stale');
  assert.equal(stale.coverage.lastValidSnapshotShown, true);
});

const GROUP_PREFIXES = [
  'apps/web', 'apps/cli', 'packages/source-graph', 'packages/recall-map',
  'packages/protocol', 'services/control-api', 'providers/native/memory-sqlite',
  'providers/native/context-candidate-ast-code', 'scripts', 'tests', 'docs',
  'examples', 'evals', 'rfcs', 'deploy', 'planning'
];

function orientationFixture({ groupCount = 8, entryPointCount = 5 } = {}) {
  const groups = GROUP_PREFIXES.slice(0, groupCount).map((prefix, index) => ({
    id: `group_${index}`,
    label: prefix.split('/').at(-1),
    prefix,
    fileCount: 10 + index,
    symbolCount: 30 + index,
    changedFileCount: index === 0 ? 1 : 0,
    coverageStatus: index === groupCount - 1 ? 'partial' : 'complete',
    entryPoints: []
  }));
  const reasons = ['application_route', 'package_entry_point', 'changed_central_module', 'executable_command', 'inbound_dependency_hub'];
  const labels = ['route', 'createServer', 'renderOverview', 'recall', 'buildSourceGraphPreview'];
  const entryPoints = Array.from({ length: entryPointCount }, (_, index) => ({
    nodeId: `sgnode_${String(index).padStart(32, '0')}`,
    label: labels[index % labels.length],
    locator: `workspace://${groups[index % groups.length].prefix}/entry-${index}.js#L1-L4`,
    symbolKind: 'function',
    reasonCodes: [reasons[index % reasons.length]],
    score: 100 - index
  }));
  for (const item of entryPoints) {
    const group = groups.find(({ prefix }) => item.locator.startsWith(`workspace://${prefix}/`));
    if (group && group.entryPoints.length < 2) group.entryPoints.push(item);
  }
  return {
    schemaVersion: '1.0.0',
    workspaceId: 'ws_local',
    generatedAt: '2026-07-15T10:00:00.000Z',
    repository: { name: 'large-repository', branch: 'main', commitSha: 'a'.repeat(40), dirtyCount: 2, gitStatusAvailable: true, reason: null },
    support: {
      sourceGraph: {
        status: 'implemented',
        coverage: { status: 'partial', analyzedFileCount: 572, maxFiles: 1000, diagnosticCount: 2, reasonCodes: ['unsupported_extensions_skipped'] },
        snapshot: { status: 'fresh', reuse: 'cache', reason: null, builtAt: '2026-07-15T09:59:00.000Z', buildDurationMs: 15 }
      }
    },
    architecture: {
      groups,
      groupRelations: groups.slice(1).map((group, index) => ({ fromGroupId: groups[index].id, toGroupId: group.id, kind: 'imports', count: 2 })),
      entryPoints,
      hotspots: [],
      impact: { changedLocators: ['workspace://apps/web/app.js'], representedChangedLocators: ['workspace://apps/web/app.js'], affectedSymbols: [], depth: 2 }
    },
    memory: { status: 'available', activeFacts: [], pendingProposals: [{ id: 'mpq_1' }], staleFactCount: 0, conflictingFactCount: 0 },
    readiness: { handoff: { status: 'available', command: 'recall handoff' }, nextCommands: [] },
    safeguards: { readOnly: true, modelCalls: 0, networkCalls: 0, externalWritesEnabled: false }
  };
}

function changedFixture() {
  return { status: 'available', changedLocators: ['apps/web/app.js'], totalCount: 2, omittedCount: 1, truncated: false };
}

function handoffFixture() {
  return { status: 'verified', createdAt: '2026-07-15T09:58:00.000Z' };
}
```

Define fixture helpers in the same test file with complete repository, support, architecture, memory, safeguards, and readiness fields.

- [x] **Step 2: Run the model test and verify the missing module**

Run:

```bash
node --test tests/web-orientation.test.mjs
```

Expected: FAIL with module-not-found for `orientation-model.js`.

- [x] **Step 3: Implement bounded group and start-point selection**

In `orientation-model.js`, normalize every external string and array. Cap groups at 12 and relations at 20. Rank start points with explicit reason priority:

```js
const START_REASON_PRIORITY = new Map([
  ['application_route', 0],
  ['package_entry_point', 1],
  ['changed_central_module', 2],
  ['executable_command', 3],
  ['inbound_dependency_hub', 4]
]);
const START_REASON_LABEL = new Map([
  ['application_route', 'application route'],
  ['executable_command', 'executable command'],
  ['package_entry_point', 'package entry point'],
  ['changed_central_module', 'changed central module'],
  ['inbound_dependency_hub', 'inbound dependency hub']
]);

function rankStartHere(items) {
  return [...items]
    .filter(({ locator = '' }) => !/(?:^|\/)(?:test|tests|fixtures|generated|vendor)(?:\/|$)/iu.test(locator))
    .sort((left, right) => (
      (START_REASON_PRIORITY.get(left.reasonCode) ?? 99) - (START_REASON_PRIORITY.get(right.reasonCode) ?? 99)
      || right.score - left.score
      || left.locator.localeCompare(right.locator)
    ))
    .slice(0, 3)
    .map((item) => ({ ...item, reason: START_REASON_LABEL.get(item.reasonCode) ?? 'ranked source entry point' }));
}
```

Collapse strongly connected group components before assigning left-to-right topological layers. Sort groups inside a layer by repository-relative prefix. Do not use randomness, measured DOM size, or force layout.

- [x] **Step 4: Build truthful impact and trust models**

Expose represented and unrepresented changed counts separately. Map graph snapshot states to `complete`, `partial`, `stale`, `failed`, or `not scanned`. Keep memory counts as active, pending, stale, and conflicting. Include token reduction only when the report contains a measured baseline and `providerBillingClaimed === false`; otherwise set it to `null`.

Return a frozen model with:

```js
{
  state,
  repository,
  coverage,
  groups,
  relations,
  selectedGroupId,
  startHere,
  impact,
  trust: { memory, handoff, source, deliveryReduction },
  primaryAction
}
```

- [x] **Step 5: Delegate Overview modeling from `app.js`**

Replace `buildRecallMapHomeModel()` internals with an import/delegation to `buildOrientationModel()`. Keep a named re-export from `app.js` for compatibility until `tests/web-shell.test.mjs` imports the new module directly. Update `selectOverviewPrimaryAction()` only to consume the new model fields; keep its current route IDs and actions.

- [x] **Step 6: Verify model and shell behavior**

Run:

```bash
node --test tests/web-orientation.test.mjs tests/web-shell.test.mjs
```

Expected: deterministic orientation tests and existing shell state tests pass.

- [x] **Step 7: Commit orientation modeling**

```bash
git add apps/web/orientation-model.js apps/web/app.js apps/web/shell-model.js tests/web-orientation.test.mjs tests/web-shell.test.mjs
git commit -m "feat: model repository orientation deterministically"
```

### Task 3: Render the compact Overview workbench

**Files:**
- Create: `apps/web/orientation-view.js`
- Modify: `apps/web/index.html`
- Modify: `apps/web/app.js`
- Modify: `apps/web/styles.css`
- Modify: `tests/web-orientation.test.mjs`
- Modify: `tests/web-shell.test.mjs`

**Interfaces:**
- Produces: `renderOrientation(model): string`.
- Produces: `bindOrientation(root, { onSelectGroup, onRefresh }): () => void`.
- Consumes: `OrientationModel` from Task 2 and primitives from Task 1.

- [x] **Step 1: Write failing minimalist Overview markup tests**

Add to `tests/web-orientation.test.mjs`:

```js
import { readFile } from 'node:fs/promises';
import { renderOrientation } from '../apps/web/orientation-view.js';

test('Overview renders the first-ten-seconds contract without dashboard slop', () => {
  const html = renderOrientation(buildOrientationModel({ report: orientationFixture({ groupCount: 8, entryPointCount: 5 }) }));
  for (const label of ['Architecture', 'Start here', 'Current impact', 'Trusted context']) assert.match(html, new RegExp(label));
  assert.equal((html.match(/class="orientation-group/g) ?? []).length, 8);
  assert.equal((html.match(/class="start-item/g) ?? []).length, 3);
  assert.match(html, /aria-label="Repository architecture outline"/);
  assert.doesNotMatch(html, /class="metric-strip"/);
  assert.doesNotMatch(html, /hero|tagline|AI-powered|intelligent|smart|magical|seamless|unlock|supercharge|next-generation/iu);
});

test('repository command bar exposes four deterministic intents', async () => {
  const html = await readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8');
  for (const intent of ['explain', 'trace', 'impact', 'handoff']) {
    assert.match(html, new RegExp(`value="${intent}"`));
  }
  assert.doesNotMatch(html, /chat|ask AI|thinking/iu);
});

test('repository truth bar names local and external-write state', async () => {
  const html = await readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="repository-boundary"/);
  assert.match(html, /Local only/);
  assert.match(html, /External writes off/);
});
```

- [x] **Step 2: Run the test and verify the missing renderer**

Run:

```bash
node --test --test-name-pattern="first-ten-seconds" tests/web-orientation.test.mjs
```

Expected: FAIL because `renderOrientation` does not exist.

- [x] **Step 3: Implement semantic orientation markup**

Render this macrostructure, with no wrapper cards around the three secondary sections:

```html
<section class="orientation-workbench" aria-labelledby="orientation-title">
  <header class="orientation-heading">
    <h1 id="orientation-title">Overview</h1>
    <span class="coverage-label">Partial · scanned 2 minutes ago</span>
  </header>
  <div class="orientation-layout">
    <section class="architecture-region" aria-labelledby="architecture-title">…</section>
    <aside class="orientation-inspector">…</aside>
  </div>
</section>
```

Group nodes are `<button type="button" class="orientation-group">` elements positioned by CSS grid columns from `layer`. Visual relationship lines are generated from actual relation data and marked `aria-hidden="true"`; the always-present outline contains links/buttons with the same `data-group-id`. The inspector contains three sections separated by `border-top` rules.

Keep repository name, branch, scan age, and textual coverage in the existing truth bar. Add one compact `<span id="repository-boundary">Local only · External writes off</span>`. In `renderRepositoryBar()`, derive `External writes on/off` from `recallMap.safeguards.externalWritesEnabled`, retain the `Local only` label, and set a warning state when writes are on. Do not represent either state with color alone.

- [x] **Step 4: Add compact workbench styling**

Use the existing tokens only. Required declarations include:

```css
.orientation-workbench{max-width:1440px;margin:0 auto}
.orientation-heading{display:flex;align-items:baseline;justify-content:space-between;gap:var(--space-sm);padding-bottom:var(--space-sm);border-bottom:1px solid var(--color-rule)}
.orientation-heading h1{font-size:24px;letter-spacing:-.02em}
.orientation-layout{display:grid;grid-template-columns:minmax(0,7fr) minmax(280px,3fr);gap:var(--space-lg);padding-top:var(--space-md)}
.orientation-group{min-height:44px;border:1px solid var(--color-rule);border-radius:var(--radius-control);background:var(--color-panel);box-shadow:none}
.orientation-inspector section{padding:var(--space-sm) 0;border-top:1px solid var(--color-rule)}
.orientation-inspector section:first-child{padding-top:0;border-top:0}
```

Do not use `.surface-primary`, fixed/minimum content heights, gradients, decorative shadows, or `metric-strip`. At 1440 × 900, the Overview title, architecture groups, three start items, impact state, and trust state must fit without scrolling.

- [x] **Step 5: Bind selection and delegate render from `app.js`**

`renderHome()` calls `renderOrientation()`. After each route render, call `bindOrientation()` and return/replace its cleanup callback before rebinding. Selecting a group updates the model and inspector without re-fetching; `Open in Map` navigates to `/map?group=<encoded-prefix>`.

- [x] **Step 6: Upgrade the existing global search into the single command bar**

Add a compact, labeled intent select to the existing `#global-search-form`; do not add a second input:

```html
<select id="global-search-intent" name="intent" aria-label="Command intent">
  <option value="explain">Explain module</option>
  <option value="trace">Trace symbol</option>
  <option value="impact">Inspect changed-file impact</option>
  <option value="handoff">Prepare handoff</option>
</select>
```

Route deterministically in `app.js`:

```js
const commandTargets = {
  explain: (value) => `/map?query=${encodeURIComponent(value)}`,
  trace: (value) => `/map?query=${encodeURIComponent(value)}&start=${encodeURIComponent(value)}`,
  impact: (value) => `/map?query=${encodeURIComponent(value)}&changed=${encodeURIComponent(value)}`,
  handoff: (value) => `/handoffs?objective=${encodeURIComponent(value)}`
};
```

On Handoffs, use the bounded `objective` URL value only to prefill the existing form. Do not submit, write, or call a model automatically. On empty input, keep focus in the field and announce `Enter a file, symbol, concept, or path.`

- [x] **Step 7: Verify Overview markup and responsive shell**

Run:

```bash
node --test tests/web-orientation.test.mjs tests/web-shell.test.mjs
```

Expected: all Overview and shell tests pass with no retired markup.

- [ ] **Step 8: Commit the Overview workbench**

```bash
git add apps/web/orientation-view.js apps/web/index.html apps/web/app.js apps/web/styles.css tests/web-orientation.test.mjs tests/web-shell.test.mjs
git commit -m "feat: render the orientation-first Overview"
```

### Task 4: Make Map URL state and failure behavior deterministic

**Files:**
- Create: `apps/web/source-map-view.js`
- Create: `tests/web-source-map.test.mjs`
- Modify: `apps/web/app.js`
- Modify: `apps/web/styles.css`

**Interfaces:**
- Produces: `parseMapUrl(input): MapQueryState`.
- Produces: `serializeMapUrl(state): string`.
- Produces: `buildMapRequest(state): object`.
- Produces: `renderSourceMap({ state, report, error }): string`.
- Produces: `bindSourceMap(root, handlers): () => void`.

- [x] **Step 1: Write failing URL round-trip and failure tests**

Create `tests/web-source-map.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseMapUrl, renderSourceMap, serializeMapUrl } from '../apps/web/source-map-view.js';

test('Map query state round-trips through the URL', () => {
  const state = parseMapUrl('http://127.0.0.1:4318/map?query=copytrading&group=apps%2Fterminal&start=execute&changed=src%2Ftrade.ts&depth=3&limit=24');
  assert.deepEqual(state, {
    query: 'copytrading', group: 'apps/terminal', startName: 'execute',
    changedLocator: 'src/trade.ts', depth: 3, limit: 24, advanced: true
  });
  assert.equal(serializeMapUrl(state), '/map?query=copytrading&group=apps%2Fterminal&start=execute&changed=src%2Ftrade.ts&depth=3&limit=24');
});

test('Map failure keeps submitted values and diagnostic truth', () => {
  const state = parseMapUrl('/map?query=copytrading&group=apps%2Fterminal');
  const html = renderSourceMap({ state, error: { message: 'Graph validation failed.', correlationId: 'req_map_1' } });
  assert.match(html, /value="copytrading"/);
  assert.match(html, /value="apps\/terminal"/);
  assert.match(html, /Graph validation failed/);
  assert.doesNotMatch(html, /preview ready|No map results/iu);
});

test('Map partial state keeps useful results and names omitted coverage', () => {
  const state = parseMapUrl('/map?query=router');
  const report = mapPreviewFixture({
    coverage: { status: 'partial', representedFileCount: 572, omittedFileCount: 428, omittedEdgeCount: 39012, reasonCodes: ['file_budget_reached', 'edge_budget_reached'] }
  });
  const html = renderSourceMap({ state, report });
  assert.match(html, /572 represented files/);
  assert.match(html, /428 omitted files/);
  assert.match(html, /39,012 omitted relationships/);
  assert.match(html, /File limit reached|Relationship limit reached/);
  assert.doesNotMatch(html, /preview ready/iu);
});

function mapPreviewFixture({ coverage } = {}) {
  const resolvedCoverage = coverage ?? {
    status: 'complete', representedFileCount: 1, omittedFileCount: 0,
    omittedEdgeCount: 0, reasonCodes: []
  };
  const node = {
    id: `sgnode_${'1'.repeat(32)}`,
    kind: 'symbol',
    label: 'router',
    locator: 'workspace://apps/web/router.js#L1-L8'
  };
  return {
    snapshot: {
      status: 'fresh', reuse: 'cache', reason: null, generation: 1,
      validationMode: 'watch', builtAt: '2026-07-15T10:00:00.000Z', buildDurationMs: 12
    },
    coverage: resolvedCoverage,
    orientation: {
      groups: [{ id: 'group_apps_web', label: 'web', prefix: 'apps/web', fileCount: 1, symbolCount: 1, changedFileCount: 0, coverageStatus: resolvedCoverage.status, entryPoints: [node] }],
      groupRelations: [],
      omittedGroupCount: 0,
      omittedRelationCount: 0
    },
    focus: { nodes: [node], edges: [], omittedNodeCount: 0, omittedEdgeCount: 0 },
    graph: { summary: { fileCount: 1, nodeCount: 1, edgeCount: 0, coverage: resolvedCoverage }, sampleNodes: [node], sampleEdges: [], diagnostics: [] },
    diagnostics: [],
    safeguards: { persisted: false, modelCalls: 0, networkCalls: 0, externalWritesEnabled: false }
  };
}
```

- [x] **Step 2: Run the tests and verify the missing module**

Run:

```bash
node --test tests/web-source-map.test.mjs
```

Expected: FAIL with module-not-found for `source-map-view.js`.

- [x] **Step 3: Implement bounded URL state and request mapping**

Normalize strings to existing API maxima. `buildMapRequest()` maps `group` to `locatorPrefix`, a single `changedLocator` to `changedLocators`, and returns `sampleLimit: 50`. Default state is an empty query, depth 2, limit 20; do not inject `where should I start` into the field. `advanced` is true only when start, changed, depth other than 2, or limit other than 20 is present.

- [x] **Step 4: Render query, disclosure, truth state, and outline**

`Query` remains visible. Put group, trace, changed locator, depth, and limit inside `<details class="map-advanced">`. Render snapshot/coverage state as text. Render grouped orientation before a focus exists; render `preview.focus` when a query/group/trace/impact exists. Always render a semantic outline and inspector. A failure uses `renderApiErrorPanel()` and never renders an empty-success message.

- [x] **Step 5: Delegate Map submit and history handling from `app.js`**

On submit:

1. Serialize form state into `/map?...`.
2. Call `history.pushState()` only when the URL changes.
3. Fetch with the exact state-derived request.
4. Keep the submitted state object through error or partial response.
5. On `popstate`, parse the URL and refetch.

Global search must navigate to `/map?query=<value>` and use the same path. Remove the old default query substitution. The visible `Refresh` action repeats the current request with `{ refresh: true }`; ordinary submit, reload, back, and forward use the cache-aware default.

- [x] **Step 6: Verify URL, shell, and API behavior**

Run:

```bash
node --test tests/web-source-map.test.mjs tests/web-shell.test.mjs tests/control-api.test.mjs
```

Expected: Map state tests, existing shell tests, and Control API tests pass.

- [ ] **Step 7: Commit deterministic Map state**

```bash
git add apps/web/source-map-view.js apps/web/app.js apps/web/styles.css tests/web-source-map.test.mjs tests/web-shell.test.mjs
git commit -m "feat: preserve Map query and failure state"
```

### Task 5: Move detailed graph layout off the main thread

**Files:**
- Create: `apps/web/graph-viewport.js`
- Create: `apps/web/graph-layout-worker.js`
- Modify: `apps/web/source-map-view.js`
- Modify: `apps/web/app.js`
- Modify: `apps/web/styles.css`
- Modify: `tests/web-source-map.test.mjs`

**Interfaces:**
- Worker consumes `{ requestId, nodes, edges, width, height }`.
- Worker produces `{ requestId, positions, bounds }`.
- `graph-viewport.js` exports `createGraphViewport(canvas, outline, inspector, options)` with `fit`, `reset`, `focus`, `destroy` methods.

- [ ] **Step 1: Write failing worker and outline-parity tests**

Add:

```js
test('focused graph uses a worker and keeps outline selection canonical', async () => {
  const source = await readFile(new URL('../apps/web/source-map-view.js', import.meta.url), 'utf8');
  const viewport = await readFile(new URL('../apps/web/graph-viewport.js', import.meta.url), 'utf8');
  const worker = await readFile(new URL('../apps/web/graph-layout-worker.js', import.meta.url), 'utf8');
  assert.match(viewport, /new Worker\(new URL\('\.\/graph-layout-worker\.js'/);
  assert.match(source, /data-node-id/);
  assert.match(source, /Fit selection/);
  assert.match(source, /Reset view/);
  assert.doesNotMatch(source, /for \(let tick = 0; tick < 90/);
  assert.match(worker, /postMessage\(\{ requestId, positions, bounds \}\)/);
});
```

- [ ] **Step 2: Run the test and verify no worker exists**

Run:

```bash
node --test --test-name-pattern="focused graph uses a worker" tests/web-source-map.test.mjs
```

Expected: FAIL with missing worker file or missing Worker construction.

- [ ] **Step 3: Implement deterministic bounded layout**

The worker rejects more than 200 nodes or 400 edges. Use a deterministic breadth-first layered layout, avoiding force simulation entirely. Return plain serializable objects. Do not read the DOM or use randomness.

```js
self.onmessage = ({ data }) => {
  const { requestId, nodes = [], edges = [], width = 960, height = 560 } = data ?? {};
  if (nodes.length > 200 || edges.length > 400) {
    self.postMessage({ requestId, error: 'graph_layout_bounds_exceeded' });
    return;
  }
  const { positions, bounds } = layoutFocusedGraph(nodes, edges, width, height);
  self.postMessage({ requestId, positions, bounds });
};

function layoutFocusedGraph(nodes, edges, width, height) {
  const ordered = [...nodes].sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const adjacency = new Map(ordered.map(({ id }) => [id, new Set()]));
  for (const { fromNodeId, toNodeId } of edges) {
    if (!adjacency.has(fromNodeId) || !adjacency.has(toNodeId)) continue;
    adjacency.get(fromNodeId).add(toNodeId);
    adjacency.get(toNodeId).add(fromNodeId);
  }
  const roots = [...ordered].sort((left, right) => (
    adjacency.get(right.id).size - adjacency.get(left.id).size || left.id.localeCompare(right.id)
  ));
  const layerById = new Map();
  let componentOffset = 0;
  for (const root of roots) {
    if (layerById.has(root.id)) continue;
    const queue = [{ id: root.id, layer: componentOffset }];
    let cursor = 0;
    let componentMax = componentOffset;
    while (cursor < queue.length) {
      const current = queue[cursor++];
      if (layerById.has(current.id)) continue;
      layerById.set(current.id, current.layer);
      componentMax = Math.max(componentMax, current.layer);
      for (const neighbor of [...adjacency.get(current.id)].sort()) {
        if (!layerById.has(neighbor)) queue.push({ id: neighbor, layer: current.layer + 1 });
      }
    }
    componentOffset = componentMax + 2;
  }
  const layers = new Map();
  for (const node of ordered) {
    const layer = layerById.get(node.id) ?? 0;
    if (!layers.has(layer)) layers.set(layer, []);
    layers.get(layer).push(node.id);
  }
  const layerIds = [...layers.keys()].sort((left, right) => left - right);
  const xStep = (width - 96) / Math.max(1, layerIds.length - 1);
  const positions = {};
  layerIds.forEach((layer, column) => {
    const ids = layers.get(layer);
    const yStep = (height - 96) / Math.max(1, ids.length - 1);
    ids.forEach((id, row) => {
      positions[id] = { x: 48 + column * xStep, y: ids.length === 1 ? height / 2 : 48 + row * yStep };
    });
  });
  return { positions, bounds: { minX: 48, minY: 48, maxX: width - 48, maxY: height - 48 } };
}
```

- [ ] **Step 4: Implement viewport controls and shared selection**

Use one `selectedNodeId` inside `createGraphViewport()`. Canvas hit testing and outline clicks both call the injected `onSelect(nodeId)`, update `aria-current`, render the same inspector through the route callback, and call `focus()` only when requested. Add pointer pan, wheel zoom clamped to `0.5..2.5`, fit-to-selection, reset, and resize handling. `destroy()` terminates the worker and removes listeners. `source-map-view.js` owns the outline and inspector markup, then passes their elements and route callbacks to the viewport.

- [ ] **Step 5: Style the detailed graph without fake visual assets**

The graph is a real data view drawn from response nodes and edges. Use no decorative SVG, CSS illustration, glow, or gradient. The canvas and outline sit in a flat split region. Status is visible in text, not color alone. Hide the canvas entirely when focus has no nodes.

- [ ] **Step 6: Verify worker and Map tests**

Run:

```bash
node --test tests/web-source-map.test.mjs tests/web-shell.test.mjs
```

Expected: worker, viewport contract, outline parity, and shell tests pass.

- [ ] **Step 7: Commit focused graph interaction**

```bash
git add apps/web/graph-viewport.js apps/web/graph-layout-worker.js apps/web/source-map-view.js apps/web/app.js apps/web/styles.css tests/web-source-map.test.mjs
git commit -m "feat: add bounded interactive Map graph"
```

### Task 6: Replace the governed-memory graph’s empty canvas and main-thread layout

**Files:**
- Create: `apps/web/memory-graph-view.js`
- Create: `tests/web-memory-graph.test.mjs`
- Modify: `apps/web/app.js`
- Modify: `apps/web/styles.css`
- Modify: `tests/web-shell.test.mjs`

**Interfaces:**
- Produces: `buildMemoryGraphViewModel(report, options)`.
- Produces: `renderMemoryGraphView(model)`.
- Produces: `bindMemoryGraph(root, handlers): () => void`.
- Reuses `graph-viewport.js` and `graph-layout-worker.js` from Task 5.

- [ ] **Step 1: Write failing empty and populated tests**

Create `tests/web-memory-graph.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMemoryGraphViewModel, renderMemoryGraphView } from '../apps/web/memory-graph-view.js';

test('empty governed memory renders no canvas or zero metrics', () => {
  const model = buildMemoryGraphViewModel(memoryGraphFixture({ nodes: [], edges: [] }), {});
  const html = renderMemoryGraphView(model);
  assert.match(html, /No governed memory yet/);
  assert.match(html, /Checked workspace/);
  assert.doesNotMatch(html, /<canvas\b/);
  assert.doesNotMatch(html, /metric-strip|Nodes<\/|Edges<\//);
});

test('populated governed memory has graph and equivalent outline', () => {
  const model = buildMemoryGraphViewModel(memoryGraphFixture(), { history: true, query: 'provider' });
  const html = renderMemoryGraphView(model);
  assert.match(html, /id="memory-graph-canvas"/);
  assert.match(html, /aria-label="Governed memory outline"/);
  assert.match(html, /data-node-id="provider:native:memory:sqlite"/);
  assert.match(html, /Current|Superseded/);
  assert.doesNotMatch(html, /Community colors/);
});

function memoryGraphFixture({ nodes, edges } = {}) {
  const defaultNodes = [
    { id: 'provider:native:memory:sqlite', name: 'provider:native:memory:sqlite', type: 'provider', current: true, governedDecision: false, degree: 1, size: 14, community: 1 },
    { id: 'MemoryBackendPort', name: 'MemoryBackendPort', type: 'port', current: true, governedDecision: false, degree: 1, size: 14, community: 1 },
    { id: 'legacy-view', name: 'legacy-view', type: 'decision', current: false, governedDecision: true, degree: 1, size: 13, community: 2 }
  ];
  const defaultEdges = [
    { id: 'medge_current', from: 'provider:native:memory:sqlite', to: 'MemoryBackendPort', predicate: 'implements_port', factId: 'memfact_current', current: true, status: 'active', validFrom: '2026-07-15T08:00:00.000Z', validUntil: null, supersededBy: null, source: 'workspace://providers/native/memory-sqlite/provider.json' },
    { id: 'medge_history', from: 'legacy-view', to: 'MemoryBackendPort', predicate: 'replaced_by', factId: 'memfact_history', current: false, status: 'superseded', validFrom: '2026-07-14T08:00:00.000Z', validUntil: '2026-07-15T08:00:00.000Z', supersededBy: 'memfact_current', source: 'workspace://docs/decisions.md' }
  ];
  const graphNodes = nodes ?? defaultNodes;
  const graphEdges = edges ?? defaultEdges;
  return {
    schemaVersion: '1.0.0',
    workspaceId: 'ws_local',
    generatedAt: '2026-07-15T10:00:00.000Z',
    provider: 'provider:native:memory:sqlite',
    mode: 'history',
    communityMethod: 'label-propagation',
    summary: {
      nodeCount: graphNodes.length,
      edgeCount: graphEdges.length,
      currentNodeCount: graphNodes.filter(({ current }) => current).length,
      currentEdgeCount: graphEdges.filter(({ current }) => current).length,
      historyNodeCount: graphNodes.filter(({ current }) => !current).length,
      historyEdgeCount: graphEdges.filter(({ current }) => !current).length,
      communityCount: new Set(graphNodes.map(({ community }) => community)).size
    },
    graph: { nodes: graphNodes, edges: graphEdges },
    focus: null,
    safeguards: { readOnly: true, modelCalls: 0, networkCalls: 0, externalWritesEnabled: false },
    reportFingerprint: `sha256:${'e'.repeat(64)}`
  };
}
```

- [ ] **Step 2: Run tests and verify current empty-canvas behavior**

Run:

```bash
node --test tests/web-memory-graph.test.mjs
```

Expected: FAIL because the current renderer always emits metrics and a fixed canvas.

- [ ] **Step 3: Implement empty, populated, and selected states**

Empty state shows workspace/provider check, read-only state, and one factual next action. Populated state uses compact search/history controls, a real bounded canvas, an always-present outline, and one inspector. Replace `Community colors` with `Group related facts`; status labels include text such as `Current`, `Superseded`, and `Historical` so color is never the only channel.

- [ ] **Step 4: Remove old memory layout and delegate from `app.js`**

Delete `layoutMemoryGraph()` and `drawMemoryGraphCanvas()` from `app.js`. Delegate rendering and binding to `memory-graph-view.js`. Reuse the worker; do not create a second layout implementation. Keep proposal approval exclusively on the Memory review route.

- [ ] **Step 5: Remove fixed empty-canvas styling**

Replace `.memory-graph-canvas-wrap{height:clamp(...)}` with a populated-only aspect/viewport rule and no minimum height in the empty state. Remove the four-column metric strip and legend pills from this route. Preserve dark/light contrast with current tokens.

- [ ] **Step 6: Verify memory and shell tests**

Run:

```bash
node --test tests/web-memory-graph.test.mjs tests/web-shell.test.mjs tests/memory-recall-integrity.test.mjs
```

Expected: empty/populated graph tests, shell tests, and memory integrity tests pass.

- [ ] **Step 7: Commit the governed-memory graph**

```bash
git add apps/web/memory-graph-view.js apps/web/app.js apps/web/styles.css tests/web-memory-graph.test.mjs tests/web-shell.test.mjs
git commit -m "feat: simplify the governed memory graph"
```

### Task 7: Audit all visible web copy and touched-route CSS for AI slop

**Files:**
- Modify: `apps/web/app.js`
- Modify: `apps/web/index.html`
- Modify: `apps/web/orientation-view.js`
- Modify: `apps/web/source-map-view.js`
- Modify: `apps/web/memory-graph-view.js`
- Modify: `apps/web/styles.css`
- Modify: `tests/web-shell.test.mjs`

**Interfaces:**
- Produces no new runtime interface; locks the canonical copy and visual constraints in tests.

- [ ] **Step 1: Expand the prohibited-copy test**

In `tests/web-shell.test.mjs`, scan all web HTML/JS view files and assert that promotional terms are absent outside a small technical allowlist:

```js
test('visible web copy is factual and contains no intelligence theater', async () => {
  const files = [
    'apps/web/index.html', 'apps/web/app.js', 'apps/web/orientation-view.js',
    'apps/web/source-map-view.js', 'apps/web/memory-graph-view.js'
  ];
  const source = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');
  for (const phrase of [
    'AI-powered', 'intelligent workspace', 'smart insights', 'magical', 'seamless',
    'unlock', 'supercharge', 'revolutionary', 'next-generation', 'nervous system',
    'mission control', 'command center', 'content intelligence'
  ]) assert.doesNotMatch(source, new RegExp(phrase, 'iu'));
  assert.doesNotMatch(source, /[✨🤖🪄]/u);
});
```

- [ ] **Step 2: Run the copy test and inventory failures**

Run:

```bash
node --test --test-name-pattern="visible web copy" tests/web-shell.test.mjs
rg -n -i '\b(ai|intelligent|intelligence|smart|magical|seamless|unlock|supercharge|revolutionary|next-generation)\b|mission control|command center' apps/web
```

Expected: any current visible violations, including `Content Intelligence`, are listed. Technical workflow IDs such as `workflow:content-intelligence` may remain internal and must not be renamed in this task.

- [ ] **Step 3: Replace visible hype with object, state, reason, or action labels**

Examples:

```text
Content Intelligence -> Content analysis
Local agent fabric -> Local process map
Node conversation -> Connections
Refresh graph -> Refresh
Run map -> Search map
```

Keep technical IDs, compatibility URIs, model/provider settings, and explicit boundary statements where accurate. Do not replace precise language with vague synonyms.

- [ ] **Step 4: Audit touched-route CSS mechanically**

Run:

```bash
rg -n 'gradient|backdrop-filter|filter:blur|box-shadow|border-radius:999|metric-strip|surface-primary|min-height:[3-9][0-9]{2}px' apps/web/styles.css
```

For Overview, Map, and memory graph selectors, remove decorative shadows, pills, fixed empty height, nested rounded panels, and metric strips. Keep small status chips on untouched routes only when they communicate state.

- [ ] **Step 5: Run copy and visual-contract unit tests**

Run:

```bash
node --test tests/web-orientation.test.mjs tests/web-source-map.test.mjs tests/web-memory-graph.test.mjs tests/web-shell.test.mjs
```

Expected: all tests pass and the prohibited-copy scan is clean except allowlisted technical IDs/settings.

- [ ] **Step 6: Commit the anti-slop sweep**

```bash
git add apps/web/index.html apps/web/app.js apps/web/orientation-view.js apps/web/source-map-view.js apps/web/memory-graph-view.js apps/web/styles.css tests/web-shell.test.mjs
git commit -m "refactor: remove AI-style copy and dashboard chrome"
```

### Task 8: Prove the complete browser experience with realistic states

**Files:**
- Modify: `scripts/consumer-browser-smoke.mjs`
- Modify: `tests/web-shell.test.mjs`
- Verify: `apps/web/*.js`
- Verify: `apps/web/*.css`

**Interfaces:**
- Produces inspected screenshots under `.scratch/ui-redesign/` without committing generated files.
- Produces browser-smoke assertions for Overview, Map, populated memory graph, and empty memory graph.

- [ ] **Step 1: Update the browser fixture for six real groups**

Create realistic fixture directories under `apps`, `packages`, `services`, `providers`, `scripts`, and `tests`; include imports between them, three ranked entry points, represented and unrepresented changes, active/pending/stale memory, and a verified handoff. Do not use Lorem Ipsum, fake customers, or invented metrics.

- [ ] **Step 2: Assert the first-ten-seconds contract at 1440 × 900**

After login, assert repository name, branch, coverage, 6 to 12 groups, exactly three start items, current impact, and trusted context are visible. Use bounding boxes to prove each required region ends above 900 px:

```js
for (const selector of ['.orientation-heading', '.architecture-region', '.start-here', '.current-impact', '.trusted-context']) {
  const box = await page.locator(selector).boundingBox();
  must(box && box.y + box.height <= 900, `${selector} is outside the first desktop viewport`);
}
```

Assert there is no `.metric-strip`, `.fabric-hero`, content-free height, horizontal overflow, or prohibited copy.

Then assert layout and screen-reader status at every required width:

```js
for (const width of [320, 375, 414, 768, 1440]) {
  await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
  must(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `horizontal overflow at ${width}px`);
}
must(await page.locator('[role="status"]').count() > 0, 'missing screen-reader status');
```

- [ ] **Step 3: Exercise Overview group selection and Map deep link**

Select a group by keyboard, verify the inspector changes, activate `Open in Map`, and assert the encoded `group` remains in the URL and form. Submit a query, trigger a mocked recoverable failure, reload, go back, and go forward; the exact query/group/scope must survive every transition.

- [ ] **Step 4: Exercise detailed graph controls and outline parity**

Assert focus nodes are bounded, then use `Fit selection`, wheel zoom, reset, canvas selection, and outline selection. Verify both selection paths produce the same inspector node ID. Emulate reduced motion and ensure no transition/animation exceeds 1 ms.

- [ ] **Step 5: Exercise populated and empty memory graph states**

For populated memory, assert canvas, outline, current/superseded labels, and provenance. For an intercepted empty response, assert `No governed memory yet`, checked workspace/provider state, and absence of `<canvas>` and `.metric-strip`.

- [ ] **Step 6: Capture and inspect desktop/mobile/light/dark screenshots**

Capture:

```text
overview-desktop-light-1440.png
overview-desktop-dark-1440.png
overview-mobile-390.png
map-focused-desktop-1440.png
map-focused-mobile-390.png
memory-graph-populated-1440.png
memory-graph-empty-1440.png
```

Inspect each screenshot for clipped text, excessive gaps, wrong font weight, nested cards, broken borders, inconsistent radii, horizontal overflow, poor focus treatment, and AI-style copy. Compare the same viewport/state before and after when assessing visible improvement.

- [ ] **Step 7: Run browser smoke**

```bash
npm run consumer:browser-smoke
```

Expected: the script exits 0 with no browser console/page errors and all screenshots are present.

- [ ] **Step 8: Commit browser proof**

```bash
git add scripts/consumer-browser-smoke.mjs tests/web-shell.test.mjs
git commit -m "test: verify orientation workbench in browser"
```

### Task 9: Run the full product and package release gate

**Files:**
- Verify only; fix a failure in the task that owns it before rerunning.

**Interfaces:**
- Produces a clean implementation branch ready for review, not npm publication or merge.

- [ ] **Step 1: Run focused UI and graph verification**

```bash
node --test tests/source-graph-discovery.test.mjs tests/source-graph-snapshot-service.test.mjs tests/source-graph-preview.test.mjs tests/recall-map-ranking.test.mjs tests/recall-map.test.mjs tests/control-api.test.mjs tests/control-api-boundary.test.mjs tests/web-orientation.test.mjs tests/web-source-map.test.mjs tests/web-memory-graph.test.mjs tests/web-shell.test.mjs
npm run source-graph:large-smoke
MEMORY_RECALL_LARGE_REPO_ROOT=/Users/rebel/Desktop/polychads-clean npm run source-graph:large-smoke
npm run consumer:browser-smoke
```

Expected: every command exits 0.

- [ ] **Step 2: Run full repository gates**

```bash
npm run ci
npm run consumer:smoke
npm run release:readiness
npm pack --dry-run
```

Expected: CI, consumer smoke, release readiness, and package manifest checks pass.

- [ ] **Step 3: Test the packed artifact in a fresh repository**

```bash
SOURCE_ROOT="/Users/rebel/Downloads/memoryforge-launch"
PACK_FILE="$(npm pack --silent)"
TEMP_REPO="$(mktemp -d)"
trap 'rm -rf "$TEMP_REPO"; rm -f "$SOURCE_ROOT/$PACK_FILE"' EXIT
cd "$TEMP_REPO"
npm init -y >/dev/null
npm install "$SOURCE_ROOT/$PACK_FILE"
npx recall --version
npx recall verify --root . --format summary
```

Expected: the installed package reports the intended version and verifies the fresh consumer repository without relying on the source checkout.

- [ ] **Step 4: Confirm implementation truth**

```bash
git status --short
git log --oneline -15
find .scratch/ui-redesign/before -maxdepth 1 -type f -name '*.png' -print
find .scratch/ui-redesign -maxdepth 1 -type f -name '*.png' -print
```

Expected: clean worktree; focused commits for foundation, UI, copy, browser, and package proof; baseline/current screenshots and cold/cached timing output are present for handoff. Do not publish, merge, delete branches, or rewrite history.
