import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMapRequest,
  parseMapUrl,
  renderSourceMap,
  serializeMapUrl
} from '../apps/web/source-map-view.js';

test('Map query state round-trips through the URL', () => {
  const state = parseMapUrl('http://127.0.0.1:4318/map?query=copytrading&group=apps%2Fterminal&start=execute&changed=src%2Ftrade.ts&depth=3&limit=24');
  assert.deepEqual(state, {
    query: 'copytrading', group: 'apps/terminal', startName: 'execute',
    changedLocator: 'src/trade.ts', depth: 3, limit: 24, advanced: true
  });
  assert.equal(serializeMapUrl(state), '/map?query=copytrading&group=apps%2Fterminal&start=execute&changed=src%2Ftrade.ts&depth=3&limit=24');
});

test('Map request is exact, bounded, and cache-aware by default', () => {
  assert.deepEqual(buildMapRequest(parseMapUrl('/map?group=apps%2Fweb&changed=src%2Fapp.js')), {
    locatorPrefix: 'apps/web', changedLocators: ['src/app.js'], depth: 2, limit: 20, sampleLimit: 50
  });
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

test('Map renders architecture before focus and keeps an accessible outline', () => {
  const html = renderSourceMap({ state: parseMapUrl('/map'), report: mapPreviewFixture() });
  assert.match(html, /Repository groups/);
  assert.match(html, /aria-label="Source map outline"/);
  assert.doesNotMatch(html, /<canvas/);
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
