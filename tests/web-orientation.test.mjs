import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildOrientationModel,
  layerOrientationGroups,
  selectOrientationGroup
} from '../apps/web/orientation-model.js';
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
  for (const intent of ['explain', 'trace', 'impact', 'handoff']) assert.match(html, new RegExp(`value="${intent}"`));
  assert.doesNotMatch(html, /chat|ask AI|thinking/iu);
});

test('repository truth bar names local and external-write state', async () => {
  const html = await readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="repository-boundary"/);
  assert.match(html, /Local only/);
  assert.match(html, /External writes off/);
});

test('orientation model is deterministic and bounded', () => {
  const report = orientationFixture({ groupCount: 16, entryPointCount: 8 });
  const first = buildOrientationModel({ report, gitChanges: changedFixture(), handoff: handoffFixture() });
  const second = buildOrientationModel({ report: structuredClone(report), gitChanges: changedFixture(), handoff: handoffFixture() });
  assert.deepEqual(first.groups, second.groups);
  assert.equal(first.groups.length, 12);
  assert.equal(first.relations.length <= 20, true);
  assert.equal(first.startHere.length, 3);
  assert.deepEqual(first.startHere, second.startHere);
});

test('orientation start points explain why each source matters', () => {
  const model = buildOrientationModel({
    report: orientationFixture({ groupCount: 16, entryPointCount: 8 }),
    gitChanges: changedFixture(),
    handoff: handoffFixture()
  });
  assert.deepEqual(model.startHere.map(({ reason }) => reason), [
    'application route',
    'package entry point',
    'changed central module'
  ]);
  assert.equal(model.repository.name, 'large-repository');
  assert.equal(model.repository.branch, 'main');
  assert.equal(model.coverage.status, 'partial');
  assert.equal(model.coverage.builtAt, '2026-07-15T09:59:00.000Z');
  assert.equal(model.impact.unrepresentedChangedCount, 1);
  assert.equal(model.trust.memory.status, 'pending');
  assert.equal(model.trust.handoff.status, 'verified');
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

test('Overview renders the exact native index recovery action', () => {
  const report = orientationFixture({ groupCount: 0, entryPointCount: 0 });
  report.support.sourceGraph.status = 'unavailable';
  report.support.sourceGraph.coverage.status = 'unavailable';
  report.support.sourceGraph.snapshot.status = 'unavailable';
  report.support.sourceGraph.snapshot.reason = 'source_graph_unavailable:source_index_build_required';
  const model = buildOrientationModel({ report });
  const html = renderOrientation(model);
  assert.equal(model.index.recoveryCommand, 'recall graph index --write --engine native --root . --format summary');
  assert.match(html, /Build the local source index/);
  assert.match(html, /recall graph index --write --engine native --root \. --format summary/);
  assert.match(html, /data-action="refresh-recall-map"/);
});

test('group layering collapses cycles and selection keeps the same bounded model', () => {
  const groups = [
    { id: 'a', prefix: 'apps/a' },
    { id: 'b', prefix: 'apps/b' },
    { id: 'c', prefix: 'packages/c' }
  ];
  const relations = [
    { sourceGroupId: 'a', targetGroupId: 'b' },
    { sourceGroupId: 'b', targetGroupId: 'a' },
    { sourceGroupId: 'b', targetGroupId: 'c' }
  ];
  const layered = layerOrientationGroups(groups, relations);
  assert.equal(layered.find(({ id }) => id === 'a').layer, layered.find(({ id }) => id === 'b').layer);
  assert.equal(layered.find(({ id }) => id === 'c').layer, 1);
  const selected = selectOrientationGroup({ groups: layered, selectedGroupId: null }, 'b');
  assert.equal(selected.selectedGroupId, 'b');
  assert.equal(Object.isFrozen(selected), true);
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
