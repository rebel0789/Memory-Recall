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

test('memory graph query preserves controls and filters visible nodes', () => {
  const model = buildMemoryGraphViewModel(memoryGraphFixture(), { history: false, query: 'provider' });
  assert.equal(model.nodes.length, 2);
  assert.equal(model.edges.length, 1);
  const html = renderMemoryGraphView(model);
  assert.match(html, /value="provider"/);
  assert.doesNotMatch(html, /legacy-view/);
  assert.doesNotMatch(html, /checked[^>]*name="history"/);
});

test('memory graph stays inside the shared viewport bounds', () => {
  const nodes = Array.from({ length: 205 }, (_, index) => ({
    id: `node-${index}`, name: `node-${index}`, type: 'entity', current: true,
    governedDecision: false, degree: index, size: 10, community: index % 4
  }));
  const edges = Array.from({ length: 405 }, (_, index) => ({
    id: `edge-${index}`, from: `node-${index % 205}`, to: `node-${(index + 1) % 205}`,
    predicate: 'links', current: true, status: 'active'
  }));
  const model = buildMemoryGraphViewModel(memoryGraphFixture({ nodes, edges }), { history: true });
  assert.equal(model.nodes.length, 200);
  assert.equal(model.edges.length, 400);
  assert.equal(model.omittedNodeCount, 5);
  assert.equal(model.omittedEdgeCount, 5);
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
