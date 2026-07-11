# Memory Recall Shell and Overview Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current fifteen-destination dashboard shell and card-heavy Recall Map home with the five-destination developer workbench and state-driven Overview defined in the approved product UI specification.

**Architecture:** Keep the dependency-free static HTML, CSS, and ESM shell. Add a small pure shell-model module for navigation ownership and deterministic primary-action selection, extend the existing read-only Recall Map report with bounded repository identity, and render setup and Overview from current Control API state. Preserve every existing deep link while removing secondary routes from primary navigation.

**Tech Stack:** Node.js 22 ESM, static HTML, CSS custom properties, loopback Control API, JSON Schema 2020-12, `node:test`, Playwright Chromium.

## Global Constraints

- Preserve the dependency-free static shell. Do not add a frontend framework or runtime dependency.
- Keep UI access behind the loopback Control API. The browser must not read SQLite or repository files directly.
- Desktop primary navigation has exactly five destinations: Overview, Map, Memory, Handoffs, Settings.
- Mobile primary navigation has exactly four destinations: Overview, Map, Memory, Handoffs.
- Preserve existing route URLs and legacy query compatibility.
- Use a native system sans stack for interface text and native monospace only for commands, paths, hashes, identifiers, and source excerpts.
- Use a warm off-white light canvas, neutral graphite dark canvas, and restrained cobalt blue primary accent.
- Do not add gradients, glowing borders, glass panels, decorative effects, ambient animation, or celebratory animation.
- Do not render the prohibited shell copy listed in the approved specification.
- Preserve explicit proposal approval, read-only MCP, local-only storage, and deterministic authority boundaries.
- All UI states must meet the current `DESIGN.md` WCAG 2.2 AA contract.

## Scope and follow-on plans

This is plan 1 of 4. It produces a complete, testable shell and Overview. It does not leave Map, Memory, or Handoffs unplanned; each receives its own implementation plan after this one lands:

1. Shell and Overview, this plan.
2. Map workspace and outline parity.
3. Memory review queue and temporal detail.
4. Handoffs workflow, secondary-route consolidation, and final cleanup.

## File responsibility map

- `packages/recall-map/src/index.mjs`: assemble bounded repository identity with the existing read-only map report.
- `packages/protocol/schemas/recall-map.schema.json`: validate the repository identity contract.
- `apps/web/shell-model.js`: own primary navigation, route ownership, and Overview primary-action selection as pure functions.
- `apps/web/index.html`: contain the workbench shell, repository bar, setup shell boundary, and mobile navigation mount.
- `apps/web/app.js`: map API state into the repository bar, setup screen, and Overview renderer.
- `apps/web/tokens.css`: contain the approved color, spacing, radius, typography, easing, and duration tokens.
- `apps/web/styles.css`: style the shell and Overview while retaining temporary compatibility rules for untouched routes.
- `tests/recall-map.test.mjs`: prove repository identity is bounded, local, and schema-valid.
- `tests/control-api.test.mjs`: prove the authenticated Recall Map API returns no absolute paths or remote data.
- `tests/web-shell.test.mjs`: prove navigation, route ownership, setup copy, Overview actions, and anti-slop constraints.
- `scripts/consumer-browser-smoke.mjs`: verify the new first-run and authenticated shell on desktop and mobile.
- `docs/implementation/OAF-022-production-web-shell-note.md`: describe the current shell rather than the removed fifteen-item navigation.
- `PROJECT_STATUS.json`: keep the web capability at `reference` while updating evidence and limitations.
- `CHANGELOG.md`: record the shell and Overview behavior without broad product claims.

---

### Task 1: Add bounded repository identity to Recall Map

**Files:**
- Modify: `packages/recall-map/src/index.mjs:1-101`
- Modify: `packages/protocol/schemas/recall-map.schema.json:1-70`
- Test: `tests/recall-map.test.mjs:98-125`
- Test: `tests/control-api.test.mjs:306-342`

**Interfaces:**
- Consumes: `inspectRepositoryIdentity({ root, clock })` from `packages/harness-context/src/index.mjs`.
- Produces: `report.repository` with `{ name, branch, commitSha, dirtyCount, gitStatusAvailable, reason }` and no absolute path, remote URL, changed path, or diff body.

- [ ] **Step 1: Write the failing Recall Map contract test**

Add these assertions to `Recall Map composes bounded architecture and governed-memory truth without writes`:

```js
assert.equal(report.reportVersion, 'memory-recall-map-1.1.0');
assert.equal(report.repository.name, path.basename(root));
assert.equal(typeof report.repository.gitStatusAvailable, 'boolean');
assert.equal(Number.isInteger(report.repository.dirtyCount), true);
assert.equal(Object.hasOwn(report.repository, 'root'), false);
assert.equal(Object.hasOwn(report.repository, 'remoteUrl'), false);
assert.equal(JSON.stringify(report.repository).includes(root), false);
```

Add these assertions to the authenticated API test:

```js
assert.equal(typeof report.repository.name, 'string');
assert.equal(Object.hasOwn(report.repository, 'root'), false);
assert.equal(Object.hasOwn(report.repository, 'changedPaths'), false);
assert.equal(Object.hasOwn(report.repository, 'diff'), false);
assert.equal(text.includes(sourceGraphRoot), false);
```

- [ ] **Step 2: Run the focused tests and verify the contract is missing**

Run:

```bash
node --test --test-name-pattern='Recall Map composes|recall map API returns' tests/recall-map.test.mjs tests/control-api.test.mjs
```

Expected: FAIL because `report.repository` is undefined and the schema does not permit it.

- [ ] **Step 3: Implement safe repository identity**

Import the existing inspector and add these helpers to `packages/recall-map/src/index.mjs`:

```js
import { inspectRepositoryIdentity } from '../../harness-context/src/index.mjs';

const SAFE_REPOSITORY_NAME = /^[A-Za-z0-9._@+~(), -]{1,120}$/u;

function safeRepositoryName(root) {
  const candidate = path.basename(root).slice(0, 120);
  return SAFE_REPOSITORY_NAME.test(candidate) ? candidate : 'Local workspace';
}

function summarizeRepository(workspace, identity) {
  return {
    name: safeRepositoryName(workspace.root),
    branch: identity.branch,
    commitSha: identity.commitSha,
    dirtyCount: identity.dirtyCount,
    gitStatusAvailable: identity.gitStatusAvailable,
    reason: identity.reason
  };
}
```

Inside `buildRecallMap`, inspect the repository only after workspace canonicalization:

```js
const repositoryIdentity = workspace.status === 'available'
  ? await inspectRepositoryIdentity({ root: workspace.root, clock: () => generatedAt })
  : {
      branch: null,
      commitSha: null,
      dirtyCount: 0,
      gitStatusAvailable: false,
      reason: 'workspace_unavailable'
    };
```

Change the report constant and add the summary immediately after `generatedAt` in the report:

```js
const REPORT_VERSION = 'memory-recall-map-1.1.0';

repository: summarizeRepository(workspace, repositoryIdentity),
```

Keep `schemaVersion` at `1.0.0` and bump `reportVersion` to `memory-recall-map-1.1.0`. The strict schema gains a required field, so retaining the old report version would mislabel the contract.

- [ ] **Step 4: Extend the strict schema**

Change the schema `reportVersion` const to `memory-recall-map-1.1.0`, add `repository` to the top-level required list and properties, then add this definition:

```json
"repository": {
  "type": "object",
  "additionalProperties": false,
  "required": ["name", "branch", "commitSha", "dirtyCount", "gitStatusAvailable", "reason"],
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120,
      "pattern": "^[A-Za-z0-9._@+~(), -]+$"
    },
    "branch": {
      "type": ["string", "null"],
      "maxLength": 160,
      "pattern": "^[A-Za-z0-9._/@-]+$"
    },
    "commitSha": {
      "type": ["string", "null"],
      "pattern": "^[a-f0-9]{40}$"
    },
    "dirtyCount": { "type": "integer", "minimum": 0, "maximum": 200000 },
    "gitStatusAvailable": { "type": "boolean" },
    "reason": {
      "type": ["string", "null"],
      "pattern": "^[a-z][a-z0-9_]{0,63}$"
    }
  }
}
```

- [ ] **Step 5: Run protocol and focused tests**

Run:

```bash
npm run protocol:validate
node --test --test-name-pattern='Recall Map composes|recall map API returns' tests/recall-map.test.mjs tests/control-api.test.mjs
```

Expected: protocol validation passes and both focused tests pass.

- [ ] **Step 6: Commit the repository contract**

```bash
git add packages/recall-map/src/index.mjs packages/protocol/schemas/recall-map.schema.json tests/recall-map.test.mjs tests/control-api.test.mjs
git commit -m "feat: expose bounded repository identity"
```

### Task 2: Create the shell navigation and action model

**Files:**
- Create: `apps/web/shell-model.js`
- Modify: `tests/web-shell.test.mjs:1-85`

**Interfaces:**
- Consumes: normalized route IDs and the existing Recall Map home model.
- Produces: `PRIMARY_NAV`, `MOBILE_NAV`, `navigationOwner(routeId)`, `navigationItemsFor(mode)`, and `selectOverviewPrimaryAction(model)`.

- [ ] **Step 1: Write failing pure-model tests**

Import the new module in `tests/web-shell.test.mjs`:

```js
import {
  MOBILE_NAV,
  PRIMARY_NAV,
  navigationItemsFor,
  navigationOwner,
  selectOverviewPrimaryAction
} from '../apps/web/shell-model.js';
```

Add:

```js
test('workbench navigation has five desktop and four mobile destinations', () => {
  assert.deepEqual(PRIMARY_NAV.map((item) => item.label), ['Overview', 'Map', 'Memory', 'Handoffs', 'Settings']);
  assert.deepEqual(PRIMARY_NAV.map((item) => item.path), ['/', '/map', '/memory', '/handoffs', '/settings']);
  assert.deepEqual(MOBILE_NAV.map((item) => item.label), ['Overview', 'Map', 'Memory', 'Handoffs']);
  assert.equal(navigationItemsFor('rail'), PRIMARY_NAV);
  assert.equal(navigationItemsFor('bottom'), MOBILE_NAV);
});

test('secondary routes select the destination that owns them', () => {
  assert.equal(navigationOwner('source-graph'), 'map');
  assert.equal(navigationOwner('memory-graph'), 'memory');
  assert.equal(navigationOwner('context-pack'), 'handoffs');
  assert.equal(navigationOwner('runs'), 'overview');
  assert.equal(navigationOwner('agents'), 'settings');
});

test('Overview primary action is deterministic and state ordered', () => {
  assert.deepEqual(selectOverviewPrimaryAction({ state: 'empty' }), { label: 'Scan repository', route: '/', action: 'refresh-recall-map' });
  assert.deepEqual(selectOverviewPrimaryAction({ state: 'success', memory: { pendingCount: 3 }, handoff: { state: 'ready' } }), { label: 'Review 3 proposals', route: '/memory', routeId: 'memory' });
  assert.deepEqual(selectOverviewPrimaryAction({ state: 'stale', memory: { pendingCount: 0 }, handoff: { state: 'review' } }), { label: 'Update handoff', route: '/handoffs', routeId: 'context-pack' });
  assert.deepEqual(selectOverviewPrimaryAction({ state: 'success', memory: { pendingCount: 0 }, handoff: { state: 'ready' } }), { label: 'View current handoff', route: '/handoffs', routeId: 'context-pack' });
  assert.equal(selectOverviewPrimaryAction({ state: 'success', memory: { pendingCount: 0 }, handoff: { state: 'pending' } }), null);
});
```

- [ ] **Step 2: Run tests and verify the module is absent**

Run:

```bash
node --test --test-name-pattern='workbench navigation|secondary routes|Overview primary action' tests/web-shell.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `apps/web/shell-model.js`.

- [ ] **Step 3: Implement the pure shell model**

Create `apps/web/shell-model.js`:

```js
export const PRIMARY_NAV = Object.freeze([
  { id: 'overview', routeId: 'home', path: '/', label: 'Overview' },
  { id: 'map', routeId: 'source-graph', path: '/map', label: 'Map' },
  { id: 'memory', routeId: 'memory', path: '/memory', label: 'Memory' },
  { id: 'handoffs', routeId: 'context-pack', path: '/handoffs', label: 'Handoffs' },
  { id: 'settings', routeId: 'settings', path: '/settings', label: 'Settings' }
]);

export const MOBILE_NAV = Object.freeze(PRIMARY_NAV.filter((item) => item.id !== 'settings'));

const ROUTE_OWNERS = new Map([
  ['home', 'overview'],
  ['runs', 'overview'],
  ['workflows', 'overview'],
  ['loop-workbench', 'overview'],
  ['fabric-map', 'overview'],
  ['source-graph', 'map'],
  ['memory', 'memory'],
  ['memory-graph', 'memory'],
  ['context-pack', 'handoffs'],
  ['context', 'handoffs'],
  ['evidence', 'memory'],
  ['approvals', 'memory'],
  ['content', 'overview'],
  ['agents', 'settings'],
  ['settings', 'settings']
]);

export function navigationOwner(routeId) {
  return ROUTE_OWNERS.get(String(routeId ?? '')) ?? 'overview';
}

export function navigationItemsFor(mode) {
  return mode === 'bottom' ? MOBILE_NAV : PRIMARY_NAV;
}

export function selectOverviewPrimaryAction(model = {}) {
  if (model.state === 'loading' || model.state === 'error') return null;
  if (model.state === 'empty') return { label: 'Scan repository', route: '/', action: 'refresh-recall-map' };
  const pendingCount = Number(model.memory?.pendingCount ?? 0);
  if (pendingCount > 0) return { label: `Review ${pendingCount} proposal${pendingCount === 1 ? '' : 's'}`, route: '/memory', routeId: 'memory' };
  if (model.state === 'stale' || model.handoff?.state === 'review') return { label: 'Update handoff', route: '/handoffs', routeId: 'context-pack' };
  if (model.handoff?.state === 'ready') return { label: 'View current handoff', route: '/handoffs', routeId: 'context-pack' };
  return null;
}
```

- [ ] **Step 4: Run pure-model tests**

Run:

```bash
node --test --test-name-pattern='workbench navigation|secondary routes|Overview primary action' tests/web-shell.test.mjs
```

Expected: all three tests pass.

- [ ] **Step 5: Commit the model**

```bash
git add apps/web/shell-model.js tests/web-shell.test.mjs
git commit -m "feat: define workbench shell model"
```

### Task 3: Replace primary navigation and shell markup

**Files:**
- Modify: `apps/web/index.html:13-43`
- Modify: `apps/web/app.js:1-33,68-78,985-1050`
- Modify: `tests/web-shell.test.mjs:54-85`

**Interfaces:**
- Consumes: `navigationItemsFor(mode)` and `navigationOwner(routeId)` from Task 2.
- Produces: `/map` and `/handoffs` aliases, five-item rail, four-item mobile nav, and a repository bar with `#repository-name`, `#repository-branch`, `#repository-scan`, and `#repository-condition`.

- [ ] **Step 1: Replace route and shell expectations with failing tests**

Replace the existing fifteen-item navigation assertion with:

```js
test('web shell exposes primary aliases and preserves deep links', () => {
  assert.equal(resolveRoute('http://127.0.0.1:4310/map').id, 'source-graph');
  assert.equal(resolveRoute('http://127.0.0.1:4310/handoffs').id, 'context-pack');
  assert.equal(resolveRoute('http://127.0.0.1:4310/source-graph').id, 'source-graph');
  assert.equal(resolveRoute('http://127.0.0.1:4310/context-pack').id, 'context-pack');
  assert.equal(resolveRoute('http://127.0.0.1:4310/runs').id, 'runs');
  assert.equal(resolveRoute('http://127.0.0.1:4310/?view=evidence').id, 'evidence');
  assert.equal(resolveRoute('http://127.0.0.1:4310/not-a-route').id, 'home');
  assert.equal(legacyViewPath('design'), '/settings');
});
```

Add a static shell test:

```js
test('web shell markup uses a repository bar and no duplicated hero header', async () => {
  const html = await readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8');
  for (const id of ['repository-name', 'repository-branch', 'repository-scan', 'repository-condition']) assert.match(html, new RegExp(`id="${id}"`));
  assert.doesNotMatch(html, /id="page-eyebrow"/);
  assert.doesNotMatch(html, /Developer-first local recall/i);
  assert.doesNotMatch(html, /Next-Agent Handoff/);
});
```

- [ ] **Step 2: Run route and markup tests**

Run:

```bash
node --test --test-name-pattern='primary aliases|repository bar' tests/web-shell.test.mjs
```

Expected: FAIL because aliases and repository-bar elements do not exist.

- [ ] **Step 3: Add route aliases and use the shell model**

At the top of `apps/web/app.js`, import:

```js
import { navigationItemsFor, navigationOwner } from './shell-model.js';
```

Keep the existing `ROUTES` array for deep links, remove `navItems = ROUTES`, and add:

```js
const routeAliases = new Map([
  ['/map', 'source-graph'],
  ['/handoffs', 'context-pack']
]);
```

Update `resolveRoute` after path normalization:

```js
const aliasRouteId = routeAliases.get(normalized);
if (aliasRouteId) return routeById.get(aliasRouteId);
return routeByPath.get(normalized) ?? routeById.get('home');
```

Replace `renderNav` with:

```js
function renderNav(container, mode) {
  const currentOwner = navigationOwner(currentRoute().id);
  container.innerHTML = navigationItemsFor(mode).map((item) => `
    <a href="${item.path}" data-route="${item.routeId}"${currentOwner === item.id ? ' aria-current="page"' : ''}>
      <span class="nav-mark" aria-hidden="true"></span>
      <span>${item.label}</span>
    </a>`).join('');
  container.dataset.mode = mode;
}
```

- [ ] **Step 4: Replace the index shell**

In `apps/web/index.html`, retain the skip link, sidebar, `#primary-nav`, `#view-root`, live region, and mobile nav. Replace the current brand, local card, topbar, and status strip with:

```html
<a class="brand" href="/" data-route="home" aria-label="Memory Recall overview">
  <img src="/favicon.svg" alt="" width="28" height="28">
  <span><strong>Memory Recall</strong><small>Local workspace</small></span>
</a>
<nav id="primary-nav" aria-label="Primary navigation"></nav>
<div class="local-state">
  <span class="state-indicator" aria-hidden="true"></span>
  <span><strong>Local</strong><small>External writes off</small></span>
</div>
```

Use this repository bar inside `main`:

```html
<header class="repository-bar">
  <div class="repository-identity">
    <strong id="repository-name">Local workspace</strong>
    <span id="repository-branch">Branch unavailable</span>
    <span id="repository-scan">Not scanned</span>
  </div>
  <div class="repository-actions">
    <span id="repository-condition" class="condition" role="status">Loading</span>
    <a class="icon-link" href="/settings" data-route="settings">Settings</a>
  </div>
</header>
<div id="live-status" class="sr-only" aria-live="polite"></div>
<div id="view-root"><section class="state-panel state-loading"><h1>Loading workspace</h1><p>Reading local state.</p></section></div>
```

Change the document description to:

```html
<meta name="description" content="Local repository memory and context.">
```

- [ ] **Step 5: Render repository-bar values**

Add this function to `apps/web/app.js` and call it from `render()` after `renderNav`:

```js
function renderRepositoryBar(route) {
  const repository = recallMap?.repository ?? null;
  const condition = visibleShellState(route);
  document.querySelector('#repository-name').textContent = repository?.name ?? 'Local workspace';
  document.querySelector('#repository-branch').textContent = repository?.branch ?? 'Branch unavailable';
  document.querySelector('#repository-scan').textContent = recallMap?.generatedAt ? `Scanned ${date(recallMap.generatedAt)}` : 'Not scanned';
  const conditionNode = document.querySelector('#repository-condition');
  conditionNode.textContent = condition.kind;
  conditionNode.dataset.state = condition.kind;
}
```

Delete `renderStatusBar`, `#shell-status` writes, and `page-title`, `page-eyebrow`, and `page-description` writes. Each route renderer now owns its single visible heading.

- [ ] **Step 6: Run shell tests**

Run:

```bash
node --test --test-name-pattern='workbench navigation|primary aliases|repository bar' tests/web-shell.test.mjs
```

Expected: all matching tests pass.

- [ ] **Step 7: Commit shell markup and navigation**

```bash
git add apps/web/index.html apps/web/app.js tests/web-shell.test.mjs
git commit -m "feat: replace dashboard navigation with workbench shell"
```

### Task 4: Install the approved token and shell visual system

**Files:**
- Modify: `apps/web/tokens.css`
- Modify: `apps/web/styles.css:1-105,337-422`
- Test: `tests/web-shell.test.mjs`

**Interfaces:**
- Consumes: shell markup from Task 3.
- Produces: stable color, type, shape, motion, desktop, tablet, and mobile shell primitives.

- [ ] **Step 1: Write failing visual-contract tests**

Add:

```js
test('web tokens use the approved restrained workbench system', async () => {
  const css = await readFile(new URL('../apps/web/tokens.css', import.meta.url), 'utf8');
  assert.match(css, /--color-canvas:oklch\(/);
  assert.match(css, /--color-accent:oklch\(/);
  assert.match(css, /--radius-control:6px/);
  assert.match(css, /--radius-panel:8px/);
  assert.match(css, /--font-sans:ui-sans-serif/);
  assert.doesNotMatch(css, /#56e0c4|gradient|glow/i);
});

test('mobile shell exposes four fixed destinations without horizontal scrolling', async () => {
  const css = await readFile(new URL('../apps/web/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.bottom-nav\{[^}]*grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/s);
  assert.doesNotMatch(css, /\.bottom-nav\{[^}]*overflow-x:auto/s);
});
```

- [ ] **Step 2: Run visual-contract tests**

Run:

```bash
node --test --test-name-pattern='approved restrained|four fixed destinations' tests/web-shell.test.mjs
```

Expected: FAIL against the mint token set and horizontally scrolling mobile nav.

- [ ] **Step 3: Replace tokens**

Replace `apps/web/tokens.css` with:

```css
:root {
  color-scheme: light;
  --color-canvas: oklch(97.8% 0.006 80);
  --color-panel: oklch(99.2% 0.003 80);
  --color-panel-muted: oklch(95.5% 0.006 80);
  --color-ink: oklch(20% 0.012 255);
  --color-muted: oklch(48% 0.018 255);
  --color-rule: oklch(86% 0.01 255);
  --color-rule-strong: oklch(72% 0.018 255);
  --color-accent: oklch(52% 0.19 258);
  --color-accent-ink: oklch(98% 0.005 258);
  --color-success: oklch(55% 0.13 150);
  --color-warning: oklch(67% 0.14 78);
  --color-danger: oklch(56% 0.18 25);
  --font-sans: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;
  --space-7: 48px;
  --space-8: 64px;
  --radius-control: 6px;
  --radius-panel: 8px;
  --layout-rail: 216px;
  --layout-inspector: 360px;
  --layout-prose: 76ch;
  --ease-out: cubic-bezier(.16, 1, .3, 1);
  --ease-in: cubic-bezier(.7, 0, .84, 0);
  --ease-in-out: cubic-bezier(.65, 0, .35, 1);
  --duration-fast: 120ms;
  --duration-normal: 180ms;
}

@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --color-canvas: oklch(17% 0.008 255);
    --color-panel: oklch(20.5% 0.01 255);
    --color-panel-muted: oklch(24% 0.012 255);
    --color-ink: oklch(94% 0.006 80);
    --color-muted: oklch(68% 0.014 255);
    --color-rule: oklch(31% 0.014 255);
    --color-rule-strong: oklch(43% 0.018 255);
    --color-accent: oklch(67% 0.16 258);
    --color-accent-ink: oklch(17% 0.008 255);
  }
}
```

- [ ] **Step 4: Replace shell foundations and mobile navigation**

Refactor only the global, shell, button, state, and responsive blocks in `apps/web/styles.css`. Keep untouched route-specific selectors until Task 7. The new shell must include:

```css
* { box-sizing: border-box; }
html { background: var(--color-canvas); }
body { margin: 0; color: var(--color-ink); background: var(--color-canvas); font: 14px/1.5 var(--font-sans); }
.app-shell { min-height: 100vh; display: grid; grid-template-columns: var(--layout-rail) minmax(0, 1fr); }
.sidebar { position: sticky; top: 0; height: 100vh; display: grid; grid-template-rows: auto 1fr auto; gap: var(--space-5); padding: var(--space-5) var(--space-3); border-right: 1px solid var(--color-rule); background: var(--color-panel); }
.brand { display: flex; align-items: center; gap: var(--space-3); color: inherit; text-decoration: none; padding: 0 var(--space-2); }
.brand span { display: grid; line-height: 1.2; }
.brand small, .local-state small { color: var(--color-muted); }
#primary-nav { display: grid; align-content: start; gap: 2px; }
#primary-nav a { min-height: 40px; display: grid; grid-template-columns: 3px 1fr; align-items: center; gap: var(--space-3); padding: 0 var(--space-3); color: var(--color-muted); text-decoration: none; border-radius: var(--radius-control); }
#primary-nav a:hover { color: var(--color-ink); background: var(--color-panel-muted); }
#primary-nav a[aria-current="page"] { color: var(--color-ink); background: var(--color-panel-muted); font-weight: 650; }
.nav-mark { width: 3px; height: 16px; background: transparent; }
a[aria-current="page"] .nav-mark { background: var(--color-accent); }
.local-state { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3); border-top: 1px solid var(--color-rule); }
.state-indicator { width: 8px; height: 8px; border-radius: 50%; background: var(--color-success); }
main { min-width: 0; }
.repository-bar { min-height: 64px; display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); padding: var(--space-3) clamp(18px, 4vw, 48px); border-bottom: 1px solid var(--color-rule); background: color-mix(in oklch, var(--color-canvas) 94%, transparent); }
.repository-identity, .repository-actions { display: flex; align-items: center; gap: var(--space-3); min-width: 0; }
.repository-identity span { color: var(--color-muted); }
.condition { color: var(--color-muted); text-transform: capitalize; }
.condition[data-state="error"], .condition[data-state="denied"] { color: var(--color-danger); }
.condition[data-state="stale"], .condition[data-state="partial"] { color: var(--color-warning); }
.icon-link { min-height: 36px; display: inline-flex; align-items: center; color: var(--color-ink); }
#view-root { padding: var(--space-6) clamp(18px, 4vw, 48px) var(--space-8); }
.button { min-height: 40px; border: 1px solid var(--color-rule-strong); border-radius: var(--radius-control); padding: 9px 14px; color: var(--color-ink); background: var(--color-panel); font: inherit; font-weight: 650; cursor: pointer; }
.button.primary { color: var(--color-accent-ink); background: var(--color-accent); border-color: var(--color-accent); }
.button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 3px solid var(--color-accent); outline-offset: 3px; }
.bottom-nav { display: none; }

@media (max-width: 700px) {
  .app-shell { grid-template-columns: 1fr; grid-template-rows: minmax(0, 1fr) auto; height: 100dvh; overflow: hidden; }
  .sidebar { display: none; }
  main { min-height: 0; overflow: auto; }
  .repository-bar { min-height: 56px; padding: var(--space-2) var(--space-3); }
  .repository-identity span:not(#repository-branch) { display: none; }
  #view-root { padding: var(--space-5) var(--space-3) var(--space-7); }
  .bottom-nav { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-top: 1px solid var(--color-rule); background: var(--color-panel); }
  .bottom-nav a { min-width: 0; min-height: 60px; display: grid; justify-items: center; align-content: center; gap: 4px; color: var(--color-muted); text-decoration: none; font-size: 12px; }
  .bottom-nav a[aria-current="page"] { color: var(--color-ink); }
  .bottom-nav .nav-mark { width: 18px; height: 3px; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .001ms !important; animation-duration: .001ms !important; animation-iteration-count: 1 !important; }
}
```

- [ ] **Step 5: Run tests and inspect both color schemes**

Run:

```bash
node --test --test-name-pattern='approved restrained|four fixed destinations' tests/web-shell.test.mjs
```

Expected: both tests pass.

- [ ] **Step 6: Commit tokens and shell styles**

```bash
git add apps/web/tokens.css apps/web/styles.css tests/web-shell.test.mjs
git commit -m "style: install restrained workbench visual system"
```

### Task 5: Separate setup from the normal product shell

**Files:**
- Modify: `apps/web/app.js:985-1030,1157-1177,2585-2590`
- Modify: `apps/web/styles.css`
- Test: `tests/web-shell.test.mjs:70-90,1150-1170`
- Test: `scripts/consumer-browser-smoke.mjs:45-65`

**Interfaces:**
- Consumes: existing bootstrap and login API behavior and `shellState.kind`.
- Produces: `renderSetupScreen(mode, copy)` with workspace-security framing and no normal dashboard content behind it.

- [ ] **Step 1: Write failing setup-renderer tests**

Export `renderSetupScreen` from `apps/web/app.js` and add it to the web-shell test import. Add:

```js
test('setup is a focused workspace-security screen', () => {
  const html = renderSetupScreen('bootstrap', 'Create the first local owner.');
  assert.match(html, /Set up this workspace/);
  assert.match(html, /Workspace security/);
  assert.match(html, /Run the first scan after sign-in/);
  assert.match(html, /id="auth-form"/);
  assert.doesNotMatch(html, /Choose what you need first/);
  assert.doesNotMatch(html, /Create handoff/);
  assert.doesNotMatch(html, /Developer-first/i);
});
```

- [ ] **Step 2: Run the setup test**

Run:

```bash
node --test --test-name-pattern='focused workspace-security' tests/web-shell.test.mjs
```

Expected: FAIL because `renderSetupScreen` does not exist.

- [ ] **Step 3: Implement the setup screen**

Replace `authPanel` with this exported renderer while retaining the same form names, autocomplete values, length limits, and submit behavior:

```js
export function renderSetupScreen(mode, copy) {
  const isBootstrap = mode === 'bootstrap';
  const title = isBootstrap ? 'Set up this workspace' : 'Sign in';
  const submitLabel = isBootstrap ? 'Create local owner' : 'Sign in';
  const displayName = isBootstrap
    ? '<label class="field"><span>Display name</span><input name="displayName" autocomplete="name" value="Rebel" required maxlength="120"></label>'
    : '';
  return `<section class="setup-screen">
    <div class="setup-intro">
      <span class="setup-step">Workspace security</span>
      <h1>${title}</h1>
      <p>${esc(copy)}</p>
      <ol class="setup-sequence">
        <li aria-current="step">Secure local access</li>
        <li>Run the first scan after sign-in</li>
        <li>Connect a coding tool</li>
        <li>Review proposed memory</li>
      </ol>
    </div>
    <form id="auth-form" class="setup-form" data-mode="${mode}" autocomplete="on">
      <label class="field"><span>Username</span><input name="username" autocomplete="username" value="${isBootstrap ? 'rebel' : ''}" required maxlength="80" pattern="[A-Za-z0-9._:\\-]{1,80}"></label>
      ${displayName}
      <label class="field"><span>Password</span><input name="password" type="password" autocomplete="${isBootstrap ? 'new-password' : 'current-password'}" required minlength="12" maxlength="256"></label>
      <button class="button primary" type="submit">${submitLabel}</button>
      <p class="setup-note">Credentials stay in this workspace and are stored as a password hash.</p>
    </form>
  </section>`;
}
```

Update `renderRoute`:

```js
if (shellState.kind === 'setup') return renderSetupScreen('bootstrap', 'Create a local owner before this browser can read workspace state.');
if (shellState.kind === 'denied') return renderSetupScreen('login', 'Use the local owner account for this workspace.');
```

Update the bootstrap classification message so no removed product copy survives outside the renderer:

```js
if (value.error?.status === 503 && value.error?.code === 'bootstrap_required') return { kind: 'setup', message: 'Set up local access before reading workspace state.' };
```

When `shellState.kind` is `setup` or `denied`, add `data-setup="true"` to `.app-shell` and hide the normal rail and repository bar with CSS. Remove it for authenticated states.

- [ ] **Step 4: Add focused setup styles**

Add:

```css
.app-shell[data-setup="true"] { display: block; }
.app-shell[data-setup="true"] .sidebar,
.app-shell[data-setup="true"] .repository-bar,
.app-shell[data-setup="true"] .bottom-nav { display: none; }
.app-shell[data-setup="true"] #view-root { min-height: 100vh; display: grid; place-items: center; padding: var(--space-5); }
.setup-screen { width: min(880px, 100%); display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 380px); gap: var(--space-7); align-items: start; }
.setup-intro h1 { margin: var(--space-2) 0; font-size: clamp(32px, 5vw, 52px); line-height: 1.05; letter-spacing: -.035em; }
.setup-step { color: var(--color-muted); }
.setup-sequence { margin: var(--space-6) 0 0; padding: 0; list-style: none; border-top: 1px solid var(--color-rule); }
.setup-sequence li { padding: var(--space-3) 0; border-bottom: 1px solid var(--color-rule); color: var(--color-muted); }
.setup-sequence li[aria-current="step"] { color: var(--color-ink); font-weight: 650; }
.setup-form { display: grid; gap: var(--space-4); padding: var(--space-5); border: 1px solid var(--color-rule); border-radius: var(--radius-panel); background: var(--color-panel); }
.setup-note { margin: 0; color: var(--color-muted); font-size: 12px; }
@media (max-width: 700px) { .setup-screen { grid-template-columns: 1fr; gap: var(--space-5); } }
```

- [ ] **Step 5: Update the browser smoke setup assertions**

Before creating the owner, require:

```js
await waitForText(page, 'Set up this workspace');
await waitForText(page, 'Workspace security');
await waitForText(page, 'Run the first scan after sign-in');
await mustNotContain(page, 'Choose what you need first');
await mustNotContain(page, 'Developer-first');
```

Keep the existing form-fill and submit flow, changing the button name to `Create local owner`.

- [ ] **Step 6: Run setup tests and browser smoke**

Run:

```bash
node --test --test-name-pattern='focused workspace-security|shell defers protected' tests/web-shell.test.mjs
npm run consumer:browser-smoke
```

Expected: focused tests pass; browser smoke passes through owner creation and reaches authenticated Overview.

- [ ] **Step 7: Commit focused setup**

```bash
git add apps/web/app.js apps/web/styles.css tests/web-shell.test.mjs scripts/consumer-browser-smoke.mjs
git commit -m "feat: separate workspace setup from overview"
```

### Task 6: Rebuild Recall Map home as the daily Overview

**Files:**
- Modify: `apps/web/app.js:1179-1327`
- Modify: `apps/web/styles.css:220-264`
- Test: `tests/web-shell.test.mjs:87-130`
- Test: `scripts/consumer-browser-smoke.mjs:58-75,116-134`

**Interfaces:**
- Consumes: `buildRecallMapHomeModel`, bounded `report.repository`, pinned handoff status, and `selectOverviewPrimaryAction(model)`.
- Produces: `renderOverview(model)` with repository summary, state-derived action, changes, attention queue, impact preview, handoff verification, and recent evidence.

- [ ] **Step 1: Write failing Overview model and renderer assertions**

Import `selectOverviewPrimaryAction` into `app.js`, export `renderOverview`, and replace the old Recall Map renderer assertions with:

```js
const html = renderOverview(model);
for (const label of ['Changes', 'Needs attention', 'Impact', 'Current handoff', 'Recent activity']) assert.match(html, new RegExp(label));
assert.match(html, /Review 1 proposal/);
assert.match(html, /memory-recall-map-home/);
assert.match(html, /workspace:\/\/apps\/web\/app\.js/);
assert.match(html, /data-route="source-graph"/);
assert.match(html, /data-route="memory"/);
assert.doesNotMatch(html, /Developer-first/i);
assert.doesNotMatch(html, /Read the local picture/i);
assert.doesNotMatch(html, /recall-map-signals/);
assert.doesNotMatch(html, /<canvas\b/i);
```

Update the fixture report to include:

```js
repository: {
  name: 'memory-recall-map-home',
  branch: 'main',
  commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  dirtyCount: 1,
  gitStatusAvailable: true,
  reason: null
},
```

- [ ] **Step 2: Run the Overview test**

Run:

```bash
node --test --test-name-pattern='Recall Map home' tests/web-shell.test.mjs
```

Expected: FAIL because the old card grid and promotional copy still render.

- [ ] **Step 3: Extend the Overview model without changing authority**

Inside `buildRecallMapHomeModel`, carry through:

```js
repository: report.repository ?? {
  name: 'Local workspace',
  branch: null,
  commitSha: null,
  dirtyCount: 0,
  gitStatusAvailable: false,
  reason: 'repository_identity_unavailable'
},
recentActivity: [
  ...report.memory.pendingProposals.slice(0, 3).map((proposal) => ({
    kind: 'proposal',
    label: 'Memory proposed',
    detail: proposal.sourceLocator,
    at: proposal.enqueuedAt
  })),
  ...report.memory.activeFacts.slice(0, 3).map((fact) => ({
    kind: 'memory',
    label: 'Memory current',
    detail: fact.sourceLocator,
    at: fact.validFrom
  }))
].sort((left, right) => String(right.at).localeCompare(String(left.at))).slice(0, 5)
```

This is presentation-only. Do not infer new facts or write activity records.

- [ ] **Step 4: Implement the Overview renderer**

Replace `renderRecallMapHome` with `renderOverview` and keep a compatibility export:

```js
export function renderOverview(model) {
  if (model.state === 'loading') return `<section class="overview"><header class="page-heading"><h1>Overview</h1><button class="button" data-action="refresh-recall-map" type="button">Scan repository</button></header>${statePanel('loading', model.title, model.copy)}</section>`;
  if (model.state === 'error') return `<section class="overview"><header class="page-heading"><h1>Overview</h1><button class="button" data-action="refresh-recall-map" type="button">Retry scan</button></header>${renderApiErrorPanel(model.title, model.error)}</section>`;
  const action = selectOverviewPrimaryAction(model);
  const actionHtml = action?.action
    ? `<button class="button primary" data-action="${action.action}" type="button">${esc(action.label)}</button>`
    : action
      ? `<a class="button primary" href="${action.route}" data-route="${action.routeId}">${esc(action.label)}</a>`
      : '<span class="overview-current">No review required</span>';
  const changed = model.impact.changedLocators.length
    ? `<ul class="plain-list">${model.impact.changedLocators.map((locator) => `<li><code>${esc(locator)}</code></li>`).join('')}</ul>`
    : '<p class="muted">No changed files are selected.</p>';
  const attention = [
    model.memory.pendingCount ? `<a href="/memory" data-route="memory"><strong>${model.memory.pendingCount} pending</strong><span>Review proposed memory</span></a>` : '',
    model.memory.staleCount ? `<a href="/memory" data-route="memory"><strong>${model.memory.staleCount} stale</strong><span>Check source changes</span></a>` : '',
    model.coverage.diagnosticCount ? `<a href="/map" data-route="source-graph"><strong>${model.coverage.diagnosticCount} coverage note${model.coverage.diagnosticCount === 1 ? '' : 's'}</strong><span>Inspect supported files</span></a>` : ''
  ].filter(Boolean).join('') || '<p class="muted">Nothing needs review.</p>';
  const affected = model.impact.affectedSymbols.length
    ? `<ol class="plain-list">${model.impact.affectedSymbols.slice(0, 6).map((entry) => `<li><strong>${esc(entry.label)}</strong><code>${esc(entry.locator ?? 'locator unavailable')}</code></li>`).join('')}</ol>`
    : '<p class="muted">No focused impact set.</p>';
  const activity = model.recentActivity.length
    ? `<ol class="activity-list">${model.recentActivity.map((item) => `<li><span>${esc(item.label)}</span><code>${esc(item.detail ?? 'source unavailable')}</code><time>${esc(item.at ? date(item.at) : 'time unavailable')}</time></li>`).join('')}</ol>`
    : '<p class="muted">No memory activity recorded.</p>';
  return `<section class="overview">
    <header class="page-heading">
      <div><h1>${esc(model.repository.name)}</h1><p>${esc(model.repository.branch ?? 'Branch unavailable')} · ${model.repository.dirtyCount} changed · scanned ${esc(model.generatedAt ? date(model.generatedAt) : 'not yet')}</p></div>
      ${actionHtml}
    </header>
    <div class="overview-grid">
      <section class="overview-section"><header><h2>Changes</h2><a href="/map" data-route="source-graph">Open Map</a></header>${changed}</section>
      <section class="overview-section"><header><h2>Needs attention</h2><a href="/memory" data-route="memory">Open Memory</a></header><div class="attention-list">${attention}</div></section>
      <section class="overview-section overview-impact"><header><h2>Impact</h2><span>${model.impact.affectedCount} affected</span></header>${affected}</section>
      <section class="overview-section"><header><h2>Current handoff</h2><a href="/handoffs" data-route="context-pack">Open Handoffs</a></header><dl class="summary-list"><div><dt>State</dt><dd>${esc(model.handoff.state)}</dd></div><div><dt>Source check</dt><dd>${esc(model.handoff.copy)}</dd></div></dl></section>
      <section class="overview-section overview-activity"><header><h2>Recent activity</h2><span>${model.recentActivity.length}</span></header>${activity}</section>
    </div>
  </section>`;
}

export const renderRecallMapHome = renderOverview;
```

- [ ] **Step 5: Add restrained Overview styles**

Replace the `.recall-map-*` home blocks with:

```css
.overview { max-width: 1280px; margin: 0 auto; }
.page-heading { display: flex; align-items: end; justify-content: space-between; gap: var(--space-5); padding-bottom: var(--space-5); border-bottom: 1px solid var(--color-rule); }
.page-heading h1 { margin: 0; font-size: clamp(30px, 4vw, 46px); line-height: 1.05; letter-spacing: -.035em; }
.page-heading p { margin: var(--space-2) 0 0; color: var(--color-muted); }
.overview-current { color: var(--color-muted); }
.overview-grid { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(320px, .8fr); }
.overview-section { min-width: 0; padding: var(--space-5) 0; border-bottom: 1px solid var(--color-rule); }
.overview-section:nth-child(odd) { padding-right: var(--space-6); border-right: 1px solid var(--color-rule); }
.overview-section:nth-child(even) { padding-left: var(--space-6); }
.overview-section > header { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-4); }
.overview-section h2 { margin: 0; font-size: 16px; }
.overview-section header a, .overview-section header span { color: var(--color-muted); }
.overview-impact, .overview-activity { grid-column: 1 / -1; padding-left: 0 !important; padding-right: 0 !important; border-right: 0 !important; }
.plain-list, .activity-list { list-style: none; margin: 0; padding: 0; }
.plain-list li, .activity-list li { display: grid; grid-template-columns: minmax(120px, .7fr) minmax(0, 1.3fr) auto; gap: var(--space-3); padding: var(--space-3) 0; border-top: 1px solid var(--color-rule); }
.plain-list li:first-child, .activity-list li:first-child { border-top: 0; }
.plain-list code, .activity-list code { color: var(--color-muted); overflow-wrap: anywhere; }
.activity-list time { color: var(--color-muted); white-space: nowrap; }
.attention-list { display: grid; }
.attention-list a { display: grid; grid-template-columns: 90px 1fr; gap: var(--space-3); padding: var(--space-3) 0; border-top: 1px solid var(--color-rule); color: inherit; text-decoration: none; }
.attention-list a:first-child { border-top: 0; }
.attention-list span { color: var(--color-muted); }
@media (max-width: 900px) { .overview-grid { grid-template-columns: 1fr; } .overview-section { grid-column: 1; padding: var(--space-5) 0 !important; border-right: 0 !important; } }
@media (max-width: 700px) { .page-heading { align-items: start; } .plain-list li, .activity-list li { grid-template-columns: 1fr; gap: 2px; } }
```

- [ ] **Step 6: Update browser smoke assertions**

After authentication, require:

```js
for (const label of ['Changes', 'Needs attention', 'Impact', 'Current handoff', 'Recent activity']) await waitForText(page, label);
await mustNotContain(page, 'Developer-first');
await mustNotContain(page, 'Read the local picture before the next change');
await mustNotContain(page, 'Index health');
```

Update selectors that navigate to Map and Handoffs to use the primary aliases while keeping existing deep-link checks elsewhere.

- [ ] **Step 7: Run Overview and browser tests**

Run:

```bash
node --test --test-name-pattern='Recall Map home|Overview primary action' tests/web-shell.test.mjs
npm run consumer:browser-smoke
```

Expected: focused tests pass; browser smoke passes on desktop and 390 px mobile without overflow or console errors.

- [ ] **Step 8: Commit the Overview**

```bash
git add apps/web/app.js apps/web/styles.css tests/web-shell.test.mjs scripts/consumer-browser-smoke.mjs
git commit -m "feat: rebuild home as daily Overview"
```

### Task 7: Remove obsolete shell code and verify the first slice

**Files:**
- Modify: `apps/web/app.js`
- Modify: `apps/web/styles.css`
- Modify: `tests/web-shell.test.mjs`
- Modify: `docs/implementation/OAF-022-production-web-shell-note.md`
- Modify: `PROJECT_STATUS.json`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: completed shell and Overview behavior from Tasks 1-6.
- Produces: no orphaned shell selectors, no prohibited product-shell copy, current documentation, and a verified release candidate for this slice.

- [ ] **Step 1: Add an anti-slop regression test**

Add:

```js
test('product shell omits prohibited marketing and removed dashboard patterns', async () => {
  const sources = await Promise.all([
    readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8')
  ]);
  const shell = sources.join('\n');
  for (const phrase of ['developer-first', 'nervous system', 'unlock this workspace', 'supercharge', 'AI-powered', 'next-generation']) {
    assert.doesNotMatch(shell, new RegExp(phrase, 'i'));
  }
  for (const selector of ['page-eyebrow', 'recall-map-signals', 'nav-code']) assert.doesNotMatch(shell, new RegExp(selector));
});
```

Keep compatibility documentation strings in `OAF_COMPATIBILITY_URL`; the test targets product shell source only, not historical docs.

- [ ] **Step 2: Run the anti-slop test and list remaining matches**

Run:

```bash
node --test --test-name-pattern='product shell omits' tests/web-shell.test.mjs
rg -n 'developer-first|nervous system|unlock this workspace|supercharge|AI-powered|next-generation|page-eyebrow|recall-map-signals|nav-code' apps/web
```

Expected: the test fails or `rg` lists remaining obsolete shell strings and selectors.

- [ ] **Step 3: Remove obsolete code and styles**

Delete:

- `CONSUMER_START_ACTIONS` and `renderConsumerStartActions`; their only current callers are the setup panel and Recall Map home, both replaced in Tasks 5 and 6;
- old page-title, eyebrow, description, status-strip, nav-code, Recall Map hero, five-signal grid, auth-start, and consumer-start render paths;
- unused `eyebrow` fields from `ROUTES` and the old `Developer-first / local` home metadata;
- CSS selectors used only by those removed paths;
- compatibility tests that assert the removed presentation rather than preserved behavior.

Do not delete route renderers, API calls, or deep-link mappings for Runs, Workflows, Context, Evidence, Approvals, Content Lab, Agents & Tools, Fabric Map, Loop Workbench, Source Graph, Memory Graph, or Context Pack.

- [ ] **Step 4: Update product truth documents**

In `docs/implementation/OAF-022-production-web-shell-note.md`, state:

```markdown
The primary workbench exposes Overview, Map, Memory, Handoffs, and Settings. Existing operational routes remain deep-linkable and are selected under their owning destination. The shell stays dependency-free and uses the loopback Control API only.
```

In the `bootstrap.web` capability notes in `PROJECT_STATUS.json`, replace the fifteen-route primary-navigation statement with:

```json
"Five-destination desktop workbench and four-destination mobile navigation with preserved operational deep links",
"Focused workspace-security setup is separate from the authenticated Overview",
"Overview selects one deterministic next action from bounded Recall Map, memory, and pinned-handoff state"
```

Add a concrete bullet under the current version in `CHANGELOG.md`:

```markdown
- Replaced the fifteen-item dashboard navigation with a five-destination workbench, separated local workspace setup from Overview, and made Overview choose one deterministic scan, review, or handoff action from current local state.
```

- [ ] **Step 5: Run narrow verification**

Run:

```bash
npm run protocol:validate
node --test tests/recall-map.test.mjs tests/control-api.test.mjs tests/web-shell.test.mjs
npm run consumer:browser-smoke
```

Expected: all commands pass; browser smoke reports no desktop/mobile overflow, console errors, or missing first-run flow.

- [ ] **Step 6: Run full verification**

Run:

```bash
npm run ci
npm run consumer:smoke
npm run release:readiness
```

Expected: CI, installed consumer smoke, and release readiness pass without capability-label drift.

- [ ] **Step 7: Capture visual proof**

Start the local server using the consumer browser fixture or an isolated temporary workspace. Capture:

```text
.scratch/ui-redesign/shell-overview-desktop-light.png
.scratch/ui-redesign/shell-overview-desktop-dark.png
.scratch/ui-redesign/shell-overview-mobile.png
.scratch/ui-redesign/setup-desktop.png
.scratch/ui-redesign/setup-mobile.png
```

Inspect each image for duplicated headings, card grids, clipped text, horizontal scrolling, weak focus, accidental pill walls, and promotional copy. Keep `.scratch/` untracked.

- [ ] **Step 8: Commit cleanup and truth updates**

```bash
git add apps/web/app.js apps/web/styles.css tests/web-shell.test.mjs docs/implementation/OAF-022-production-web-shell-note.md PROJECT_STATUS.json CHANGELOG.md
git commit -m "chore: remove obsolete dashboard shell"
```

- [ ] **Step 9: Review the slice against the approved specification**

Confirm all of the following from rendered output and test evidence:

```text
[ ] Five desktop destinations
[ ] Four mobile destinations
[ ] Setup separate from Overview
[ ] Repository name, branch, changed count, and last scan visible
[ ] Deterministic state-derived primary action
[ ] Changes, attention, impact, handoff, and activity present
[ ] Existing deep links still resolve
[ ] No prohibited shell phrases
[ ] No card-heavy five-metric home
[ ] Light, dark, desktop, and mobile proof captured
[ ] Full CI, consumer smoke, browser smoke, and release readiness pass
```

If any item is not proven, keep the slice open and fix it before starting the Map plan.
