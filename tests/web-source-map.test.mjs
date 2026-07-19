import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildMapRequest,
  parseMapUrl,
  renderSourceMap,
  serializeMapUrl
} from '../apps/web/source-map-view.js';
import { layoutFocusedGraph } from '../apps/web/graph-layout-worker.js';
import { graphLabelBoxesOverlap, graphLabelPlacement, visibleGraphLabelIds } from '../apps/web/graph-viewport.js';

test('Map query state round-trips through the URL', () => {
  const state = parseMapUrl('http://127.0.0.1:4318/map?query=copytrading&group=apps%2Fterminal&start=execute&changed=src%2Ftrade.ts&depth=3&limit=24&offset=48');
  assert.deepEqual(state, {
    query: 'copytrading', group: 'apps/terminal', startName: 'execute',
    changedLocator: 'src/trade.ts', depth: 3, limit: 24, offset: 48, advanced: true
  });
  assert.equal(serializeMapUrl(state), '/map?query=copytrading&group=apps%2Fterminal&start=execute&changed=src%2Ftrade.ts&depth=3&limit=24&offset=48');
});

test('Map request is exact, bounded, and cache-aware by default', () => {
  assert.deepEqual(buildMapRequest(parseMapUrl('/map?group=apps%2Fweb&changed=src%2Fapp.js')), {
    locatorPrefix: 'apps/web', changedLocators: ['src/app.js'], depth: 2, limit: 20, offset: 0, sampleLimit: 50
  });
});

test('Map distinguishes query pagination from focused graph omissions', () => {
  const report = mapPreviewFixture();
  report.search = {
    offset: 20,
    limit: 20,
    hasMore: true,
    omittedCount: 1,
    results: [{ id: 'sgnode_router', resultType: 'node', kind: 'symbol', label: 'router' }]
  };
  report.focus.omittedNodes = 7;
  report.focus.omittedEdges = 9;
  const html = renderSourceMap({ state: parseMapUrl('/map?query=router&offset=20'), report });
  assert.match(html, /Query matches 21-21 on this page\. More matches are available\./u);
  assert.match(html, /data-map-offset="0">Previous results/u);
  assert.match(html, /data-map-offset="40">Next results/u);
  assert.match(html, /7 nodes omitted/u);
  assert.match(html, /9 relationships omitted/u);
  assert.match(html, /focused map expands relationships separately/iu);
});

test('Map names an incomplete offset walk without presenting a false empty page', () => {
  const report = mapPreviewFixture();
  report.search = {
    offset: 10_000,
    reachedOffset: 8,
    offsetIncomplete: true,
    continuationCursor: `idxcur_${'a'.repeat(32)}`,
    limit: 20,
    hasMore: true,
    results: []
  };
  const html = renderSourceMap({ state: parseMapUrl('/map?query=router&offset=10000'), report });
  assert.match(html, /Query page incomplete/u);
  assert.match(html, /requested offset 10,000 was not reached/u);
  assert.match(html, /walk reached 8; this is not an empty result page/u);
  assert.match(html, /Previous results/u);
  assert.doesNotMatch(html, /Next results/u);
  assert.doesNotMatch(html, /No query matches on this page/u);

  report.search = {
    offset: 0,
    reachedOffset: 0,
    offsetIncomplete: false,
    continuationCursor: null,
    truncated: true,
    limit: 20,
    hasMore: false,
    results: [{ id: 'sgnode_router', resultType: 'node', kind: 'symbol', label: 'router' }]
  };
  const partialHtml = renderSourceMap({ state: parseMapUrl('/map?query=router'), report });
  assert.match(partialHtml, /Query results partial/u);
  assert.match(partialHtml, /omitted additional evidence/u);
  assert.match(partialHtml, /no continuation cursor is available/u);
  assert.doesNotMatch(partialHtml, /Next results/u);
});

test('Map failure keeps submitted values and diagnostic truth', () => {
  const state = parseMapUrl('/map?query=copytrading&group=apps%2Fterminal');
  const html = renderSourceMap({ state, error: { message: 'Graph validation failed.', correlationId: 'req_map_1' } });
  assert.match(html, /value="copytrading"/);
  assert.match(html, /value="apps\/terminal"/);
  assert.match(html, /Graph validation failed/);
  assert.match(html, /req_map_1/);
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
  assert.match(html, /File limit reached/);
  assert.match(html, /Relationship limit reached/);
  assert.doesNotMatch(html, /preview ready/iu);
});

test('Map names an unavailable native index instead of presenting an empty complete graph', () => {
  const report = mapPreviewFixture();
  report.snapshot = { status: 'unavailable', reason: 'source_graph_unavailable:source_index_build_required' };
  const html = renderSourceMap({ state: parseMapUrl('/map'), report });
  assert.match(html, /Source index unavailable/u);
  assert.match(html, /Build the local source index, then run the map again/u);
  assert.match(html, /recall graph index --write --engine native --root \. --format summary/u);
  assert.doesNotMatch(html, /0 represented files/u);
  assert.doesNotMatch(html, /No supported groups/u);
});

test('Map renders architecture graph before focus and keeps an accessible outline', () => {
  const html = renderSourceMap({ state: parseMapUrl('/map'), report: mapPreviewFixture() });
  assert.match(html, /Repository architecture/);
  assert.match(html, /id="source-map-canvas"/);
  assert.match(html, /Interactive repository architecture graph/);
  assert.match(html, /aria-label="Source map outline"/);
});

test('Map heading and actions avoid template-like chrome', () => {
  const html = renderSourceMap({ state: parseMapUrl('/map?query=router'), report: mapPreviewFixture() });
  assert.doesNotMatch(html, /class="eyebrow"/);
  assert.match(html, /class="button primary" type="submit">Run map/);
  assert.match(html, /class="button quiet" type="button" data-action="refresh-source-map">Reload map/);
  assert.match(html, /data-graph-action="fit">Fit selection/);
  assert.match(html, /class="button quiet" type="button" data-graph-action="reset">Reset view/);
});

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

test('focused layout is deterministic and enforces display bounds', () => {
  const nodes = [{ id: 'b' }, { id: 'a' }, { id: 'c' }];
  const edges = [{ fromNodeId: 'a', toNodeId: 'b' }, { fromNodeId: 'b', toNodeId: 'c' }];
  const first = layoutFocusedGraph(nodes, edges, 640, 400);
  assert.deepEqual(first, layoutFocusedGraph(structuredClone(nodes), structuredClone(edges), 640, 400));
  assert.deepEqual(Object.keys(first.positions).sort(), ['a', 'b', 'c']);
  assert.throws(() => layoutFocusedGraph(Array.from({ length: 201 }, (_, index) => ({ id: String(index) })), []), /graph_layout_bounds_exceeded/);
});

test('graph labels stay inside the visible canvas edge', () => {
  assert.deepEqual(graphLabelPlacement({ pointX: 600, labelWidth: 80, scale: 1, panX: 0, viewportWidth: 640 }), { align: 'right', offset: -10 });
  assert.deepEqual(graphLabelPlacement({ pointX: 80, labelWidth: 80, scale: 1, panX: 0, viewportWidth: 640 }), { align: 'left', offset: 10 });
});

test('graph label collision check preserves breathing room', () => {
  const placed = [{ left: 20, right: 120, top: 40, bottom: 54 }];
  assert.equal(graphLabelBoxesOverlap({ left: 80, right: 160, top: 46, bottom: 60 }, placed), true);
  assert.equal(graphLabelBoxesOverlap({ left: 80, right: 160, top: 70, bottom: 84 }, placed), false);
});

test('graph labels use a bounded progressive disclosure policy', () => {
  const nodes = Array.from({ length: 70 }, (_, index) => ({ id: `node_${index}`, label: `node ${index}` }));
  const edges = [
    { fromNodeId: 'node_0', toNodeId: 'node_1' },
    { fromNodeId: 'node_2', toNodeId: 'node_0' },
    { fromNodeId: 'node_3', toNodeId: 'node_4' }
  ];
  const visible = visibleGraphLabelIds({ nodes, edges, selectedNodeId: 'node_0', hoveredNodeId: 'node_3', scale: 1, budget: 8 });
  assert.deepEqual([...visible].sort(), ['node_0', 'node_1', 'node_2', 'node_3', 'node_4', 'node_5', 'node_6', 'node_7'].sort());
  assert.equal(visible.size, 8);
});

test('source map outline separates labels from locators for readable overflow', async () => {
  const html = renderSourceMap({ state: parseMapUrl('/map?query=router'), report: mapPreviewFixture() });
  const css = await readFile(new URL('../apps/web/styles.css', import.meta.url), 'utf8');
  assert.match(html, /class="source-map-outline-copy"/);
  assert.match(html, /class="source-map-outline-label"/);
  assert.match(html, /class="source-map-outline-locator"/);
  assert.match(css, /\.source-map-outline-copy\{[^}]*min-width:0/);
  assert.match(css, /\.source-map-outline-locator\{[^}]*overflow:hidden[^}]*text-overflow:ellipsis/);
});

test('focused Map renders a real canvas with outline parity', () => {
  const report = mapPreviewFixture();
  const html = renderSourceMap({ state: parseMapUrl('/map?query=router'), report });
  assert.match(html, /id="source-map-canvas"/);
  assert.match(html, /Fit selection/);
  assert.equal((html.match(/data-node-id="sgnode_/g) ?? []).length, 1);
  assert.match(html, /aria-label="Source map outline"/);
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
      groups: [
        { id: 'group_apps_web', label: 'web', prefix: 'apps/web', fileCount: 1, symbolCount: 1, changedFileCount: 0, coverageStatus: resolvedCoverage.status, entryPoints: [node] },
        { id: 'group_packages_core', label: 'core', prefix: 'packages/core', fileCount: 2, symbolCount: 4, changedFileCount: 0, coverageStatus: resolvedCoverage.status, entryPoints: [] }
      ],
      groupRelations: [{ sourceGroupId: 'group_apps_web', targetGroupId: 'group_packages_core', count: 2 }],
      omittedGroupCount: 0,
      omittedRelationCount: 0
    },
    focus: { nodes: [node], edges: [], omittedNodeCount: 0, omittedEdgeCount: 0 },
    graph: { summary: { fileCount: 1, nodeCount: 1, edgeCount: 0, coverage: resolvedCoverage }, sampleNodes: [node], sampleEdges: [], diagnostics: [] },
    diagnostics: [],
    safeguards: { persisted: false, modelCalls: 0, networkCalls: 0, externalWritesEnabled: false }
  };
}
