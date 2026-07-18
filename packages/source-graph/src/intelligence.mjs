import {
  buildJsTsSourceGraph,
  rankArchitectureNodes,
  sanitizeSourceGraphPublicOutput,
  searchSourceGraph,
  traceSourceGraph
} from '../../../providers/native/context-candidate-ast-code/src/index.mjs';
import {
  loadPersistentSourceGraphIndex,
  readPersistentSourceGraphIndexStatus
} from './index-store.mjs';
import { buildSourceGraphOrientation } from './orientation.mjs';
import { compareSourceGraphCompatibility, translateCodeIntelligenceGraph } from './native-compatibility.mjs';

const RELATIONSHIP_KINDS = new Set(['contains', 'defined_in', 'imports', 'exports', 'references', 'calls']);
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']);

export async function buildSourceGraphIntelligence({
  root,
  workspaceId = 'ws_local',
  maxFiles = 1000,
  maxFileBytes = 512 * 1024,
  engine = 'native',
  codeIntelligenceProvider = null,
  clock = () => new Date().toISOString()
} = {}) {
  if (!['js', 'native', 'native-preview', 'compatibility'].includes(engine)) throw new Error('source_graph_engine_invalid');
  if (engine !== 'js') {
    if (!codeIntelligenceProvider || typeof codeIntelligenceProvider.buildGraph !== 'function') {
      throw new Error('source_graph_native_provider_required');
    }
    const nativeGraph = await codeIntelligenceProvider.buildGraph({
      root,
      workspaceId,
      maxFiles,
      maxFileBytes,
      maxNodes: 5000,
      maxEdges: 10000,
      languages: ['javascript', 'typescript']
    });
    const graph = translateCodeIntelligenceGraph(nativeGraph);
    const source = Object.freeze({
      kind: 'native',
      freshness: nativeGraph.generation.freshness,
      persisted: false,
      reason: 'native_engine'
    });
    if (engine === 'native' || engine === 'native-preview') return Object.freeze({ graph, source });
    const baseline = await buildJsTsSourceGraph({ root, workspaceId, maxFiles, maxFileBytes, clock });
    return Object.freeze({
      graph,
      source,
      compatibility: compareSourceGraphCompatibility(baseline, graph)
    });
  }
  let fallbackReason = 'index_not_built';
  try {
    const persisted = await loadPersistentSourceGraphIndex({ root, workspaceId, maxFiles, maxFileBytes, clock });
    if (persisted.source.freshness === 'current') return persisted;
    fallbackReason = 'persistent_index_stale';
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'source_graph_index_invalid') throw error;
    if (error?.code === 'source_graph_index_invalid') fallbackReason = 'persistent_index_invalid';
  }
  const graph = await buildJsTsSourceGraph({ root, workspaceId, maxFiles, maxFileBytes, clock });
  return Object.freeze({
    graph: sanitizeSourceGraphPublicOutput(graph),
    source: Object.freeze({ kind: 'bounded-scan', freshness: 'fresh', persisted: false, reason: fallbackReason })
  });
}

export function buildArchitectureIntelligence(graph, { limit = 20 } = {}) {
  const boundedLimit = boundedInteger(limit, 1, 50, 'source_graph_architecture_limit_invalid');
  const ranking = rankArchitectureNodes(graph, { limit: boundedLimit });
  const orientation = buildSourceGraphOrientation(graph, { entryPoints: ranking.entryPoints });
  return Object.freeze({
    schemaVersion: '1.0.0',
    retrievalMethod: 'source_graph_architecture',
    graphFingerprint: graph.graphFingerprint,
    groups: orientation.groups,
    relationships: orientation.relations,
    entryPoints: ranking.entryPoints,
    hotspots: ranking.hotspots,
    deprioritized: ranking.deprioritized
  });
}

export function buildCodeSearchIntelligence(graph, options = {}) {
  return searchSourceGraph(graph, options);
}

export function buildCodeContextIntelligence(graph, { query, limit = 20 } = {}) {
  const boundedLimit = boundedInteger(limit, 1, 50, 'source_graph_context_limit_invalid');
  const search = searchSourceGraph(graph, { query, nodeKinds: ['symbol'], limit: boundedLimit });
  const selectedResult = search.results.find((item) => item.resultType === 'node') ?? null;
  const selected = selectedResult ? nodeReference(selectedResult) : null;
  if (!selected) {
    return Object.freeze({
      schemaVersion: '1.0.0',
      retrievalMethod: 'source_graph_context',
      selected: null,
      candidates: search.results,
      incoming: Object.freeze([]),
      outgoing: Object.freeze([])
    });
  }
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const incoming = graph.edges
    .filter((edge) => edge.toNodeId === selected.id)
    .map((edge) => relationshipReference(edge, nodeById))
    .filter(Boolean)
    .slice(0, boundedLimit);
  const outgoing = graph.edges
    .filter((edge) => edge.fromNodeId === selected.id)
    .map((edge) => relationshipReference(edge, nodeById))
    .filter(Boolean)
    .slice(0, boundedLimit);
  return Object.freeze({
    schemaVersion: '1.0.0',
    retrievalMethod: 'source_graph_context',
    selected: Object.freeze(selected),
    candidates: Object.freeze(search.results.slice(1, boundedLimit)),
    incoming: Object.freeze(incoming),
    outgoing: Object.freeze(outgoing)
  });
}

export function buildCodeTraceIntelligence(graph, {
  symbol,
  direction = 'outbound',
  depth = 2,
  limit = 20,
  locatorPrefix = null
} = {}) {
  return traceSourceGraph(graph, {
    startName: symbol,
    edgeKinds: ['calls'],
    locatorPrefix,
    direction,
    depth,
    limit
  });
}

export function buildCodeDependenciesIntelligence(graph, {
  query,
  direction = 'outbound',
  depth = 2,
  limit = 20
} = {}) {
  const boundedDepth = boundedInteger(depth, 1, 3, 'source_graph_dependencies_depth_invalid');
  const boundedLimit = boundedInteger(limit, 1, 50, 'source_graph_dependencies_limit_invalid');
  const search = searchSourceGraph(graph, { query, limit: Math.min(20, boundedLimit) });
  const firstNode = search.results.find((item) => item.resultType === 'node');
  if (!firstNode) {
    return Object.freeze({
      schemaVersion: '1.0.0',
      retrievalMethod: 'source_graph_dependencies',
      selected: null,
      direction,
      depth: boundedDepth,
      relationships: Object.freeze([])
    });
  }
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const selected = nodeById.get(firstNode.id) ?? firstNode;
  const seeds = new Set([selected.id]);
  if (selected.kind === 'file') {
    for (const edge of graph.edges) {
      if (edge.kind === 'contains' && edge.fromNodeId === selected.id) seeds.add(edge.toNodeId);
    }
  }
  const frontier = [...seeds].map((nodeId) => ({ nodeId, depth: 0 }));
  const visited = new Set(seeds);
  const relationships = [];
  const seenEdges = new Set();
  while (frontier.length && relationships.length < boundedLimit) {
    const current = frontier.shift();
    if (current.depth >= boundedDepth) continue;
    const matches = graph.edges.filter((edge) => (
      (direction !== 'inbound' && edge.fromNodeId === current.nodeId)
      || (direction !== 'outbound' && edge.toNodeId === current.nodeId)
    ));
    for (const edge of matches) {
      if (!RELATIONSHIP_KINDS.has(edge.kind) || seenEdges.has(edge.id)) continue;
      seenEdges.add(edge.id);
      const projected = relationshipReference(edge, nodeById);
      if (projected) relationships.push(projected);
      if (relationships.length >= boundedLimit) break;
      const nextId = edge.fromNodeId === current.nodeId ? edge.toNodeId : edge.fromNodeId;
      if (!visited.has(nextId)) {
        visited.add(nextId);
        frontier.push({ nodeId: nextId, depth: current.depth + 1 });
      }
    }
  }
  return Object.freeze({
    schemaVersion: '1.0.0',
    retrievalMethod: 'source_graph_dependencies',
    selected: Object.freeze(nodeReference(selected)),
    direction,
    depth: boundedDepth,
    relationships: Object.freeze(relationships)
  });
}

export function buildCodeRoutesIntelligence(graph, { query = '', limit = 20 } = {}) {
  const boundedLimit = boundedInteger(limit, 1, 50, 'source_graph_routes_limit_invalid');
  const terms = String(query ?? '').trim().toLowerCase().split(/\s+/u).filter(Boolean);
  const routes = graph.nodes
    .filter((node) => node.kind === 'symbol' && HTTP_METHODS.has(node.label))
    .filter((node) => routeLikeLocator(node.locator))
    .map((node) => Object.freeze({
      method: node.label,
      label: node.qualifiedLabel ?? node.label,
      locator: node.locator,
      symbolKind: node.symbolKind,
      evidence: Object.freeze(['http_method_export', 'route_locator'])
    }))
    .filter((route) => !terms.length || terms.every((term) => `${route.method} ${route.label} ${route.locator}`.toLowerCase().includes(term)))
    .sort((left, right) => left.locator.localeCompare(right.locator) || left.method.localeCompare(right.method))
    .slice(0, boundedLimit);
  return Object.freeze({
    schemaVersion: '1.0.0',
    retrievalMethod: 'source_graph_route_discovery',
    routes: Object.freeze(routes),
    omittedCount: Math.max(0, graph.nodes.filter((node) => node.kind === 'symbol' && HTTP_METHODS.has(node.label) && routeLikeLocator(node.locator)).length - routes.length)
  });
}

export async function readSourceGraphIndexStatus({ root, relativePath = '.local/source-graph/index.v1.json' } = {}) {
  return readPersistentSourceGraphIndexStatus({ root, relativePath });
}

function relationshipReference(edge, nodeById) {
  const from = nodeById.get(edge.fromNodeId);
  const to = nodeById.get(edge.toNodeId);
  if (!from || !to) return null;
  return Object.freeze({
    id: edge.id,
    kind: edge.kind,
    locator: edge.locator,
    from: Object.freeze(nodeReference(from)),
    to: Object.freeze(nodeReference(to))
  });
}

function nodeReference(node) {
  return Object.fromEntries(Object.entries({
    id: node.id,
    kind: node.kind,
    label: node.label,
    qualifiedLabel: node.qualifiedLabel,
    locator: node.locator,
    symbolKind: node.symbolKind
  }).filter(([, value]) => value !== undefined && value !== null));
}

function routeLikeLocator(locator) {
  return /(?:^|\/)(?:routes?|api)(?:\/|\.|$)/iu.test(String(locator ?? ''));
}

function boundedInteger(value, minimum, maximum, code) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(code);
  return value;
}
