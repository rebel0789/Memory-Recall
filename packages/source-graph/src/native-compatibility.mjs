import { validateJsonSchema } from '../../protocol/src/schema-validator.mjs';
import { sha256Hex, stableStringify } from '../../protocol/src/fingerprint.mjs';
import codeIntelligenceGraphSchema from '../../protocol/schemas/code-intelligence-graph.schema.json' with { type: 'json' };
import sourceGraphSchema from '../../protocol/schemas/source-graph.schema.json' with { type: 'json' };

const SYMBOL_KINDS = new Map([
  ['class', 'class'],
  ['function', 'function'],
  ['method', 'method'],
  ['interface', 'interface'],
  ['struct', 'type'],
  ['enum', 'type'],
  ['trait', 'interface'],
  ['protocol', 'interface'],
  ['type_alias', 'type'],
  ['variable', 'type'],
  ['constant', 'type'],
  ['route', 'function'],
  ['framework_component', 'type'],
  ['configuration_resource', 'type']
]);
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']);

export function translateCodeIntelligenceGraph(nativeGraph) {
  if (!validateJsonSchema(codeIntelligenceGraphSchema, nativeGraph).valid) {
    throw new Error('source_graph_native_graph_invalid');
  }
  const workspaceId = nativeGraph.repository.workspaceId;
  const nativeToCompatibility = new Map();
  const translatedCandidates = [];
  for (const node of nativeGraph.nodes) {
    const translated = translateNode(node, workspaceId);
    if (!translated) continue;
    nativeToCompatibility.set(node.id, translated);
    translatedCandidates.push(translated);
  }
  translatedCandidates.sort(compareNodes);
  const nodes = translatedCandidates.map(({ nativeId: _nativeId, ...node }) => Object.freeze(node));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const fileByLocator = new Map(nodes.filter((node) => node.kind === 'file').map((node) => [fileLocator(node.locator), node]));
  const edgeCandidates = [];

  for (const node of nodes.filter((item) => item.kind === 'symbol')) {
    const file = fileByLocator.get(fileLocator(node.locator));
    if (file) edgeCandidates.push(compatibilityEdge({
      workspaceId,
      kind: 'defined_in',
      fromNodeId: node.id,
      toNodeId: file.id,
      locator: node.locator,
      confidence: 1
    }));
  }
  for (const node of nodes.filter((item) => item.kind === 'module' && item.locator)) {
    const file = fileByLocator.get(fileLocator(node.locator));
    if (file) edgeCandidates.push(compatibilityEdge({
      workspaceId,
      kind: 'contains',
      fromNodeId: file.id,
      toNodeId: node.id,
      locator: file.locator,
      confidence: 1
    }));
  }
  for (const edge of nativeGraph.edges) {
    const kind = compatibilityEdgeKind(edge.kind);
    if (!kind) continue;
    const from = nativeToCompatibility.get(edge.fromNodeId);
    const to = nativeToCompatibility.get(edge.toNodeId);
    if (!from || !to || !nodeById.has(from.id) || !nodeById.has(to.id)) continue;
    if (kind === 'defined_in') continue;
    edgeCandidates.push(compatibilityEdge({
      workspaceId,
      kind,
      fromNodeId: from.id,
      toNodeId: to.id,
      locator: edge.evidence?.locator,
      confidence: edge.confidence
    }));
  }
  edgeCandidates.sort(compareEdges);
  const edges = [...new Map(edgeCandidates.map((edge) => [edge.id, edge])).values()];
  const diagnostics = nativeGraph.diagnostics.slice(0, 1000).map((diagnostic) => Object.freeze({
    locator: stripLineSpan(diagnostic.locator ?? 'workspace://.'),
    code: compatibilityReason(diagnostic.code)
  }));
  const nodeKindCounts = countBy(nodes, (node) => node.kind);
  const edgeKindCounts = countBy(edges, (edge) => edge.kind);
  const omittedNativeNodeCount = Math.max(0, nativeGraph.nodes.length - nativeToCompatibility.size);
  const coverage = compatibilityCoverage({
    nativeGraph,
    nodes,
    edges,
    diagnostics,
    nodeKindCounts,
    edgeKindCounts,
    omittedNativeNodeCount
  });
  const structural = {
    schemaVersion: '1.0.0',
    workspaceId,
    graphVersion: 'memory-recall-native-compat-1',
    parserVersion: safeVersion(`memory-recall-native-${nativeGraph.engine.version}`),
    sourceIndexFingerprint: nativeGraph.repository.rootIdentityHash,
    summary: {
      fileCount: nodeKindCounts.file ?? 0,
      symbolCount: nodeKindCounts.symbol ?? 0,
      moduleCount: nodeKindCounts.module ?? 0,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      qualifiedSymbolCount: nodes.filter((node) => node.kind === 'symbol' && node.qualifiedLabel).length,
      ambiguousSymbolLabelCount: ambiguousLabels(nodes).length,
      ambiguousLabels: ambiguousLabels(nodes),
      nodeKindCounts,
      edgeKindCounts,
      coverage,
      hotspots: hotspots(nodes, edges),
      entryPoints: entryPoints(nodes, edges),
      deprioritized: []
    },
    nodes,
    edges,
    diagnostics
  };
  const graph = Object.freeze({
    ...structural,
    builtAt: nativeGraph.generation.builtAt,
    graphFingerprint: fingerprint(structural)
  });
  if (!validateJsonSchema(sourceGraphSchema, graph).valid) throw new Error('source_graph_native_translation_invalid');
  return graph;
}

export function compareSourceGraphCompatibility(baseline, native) {
  for (const graph of [baseline, native]) {
    if (!validateJsonSchema(sourceGraphSchema, graph).valid) throw new Error('source_graph_compatibility_graph_invalid');
  }
  const dimensions = [
    dimension('files', fileKeys(baseline), fileKeys(native)),
    dimension('symbols', symbolKeys(baseline), symbolKeys(native)),
    dimension('imports', relationshipKeys(baseline, 'imports'), relationshipKeys(native, 'imports')),
    dimension('calls', relationshipKeys(baseline, 'calls'), relationshipKeys(native, 'calls')),
    dimension('routes', routeKeys(baseline), routeKeys(native))
  ];
  const structural = {
    schemaVersion: '1.0.0',
    comparisonVersion: 'memory-recall-js-ts-native-preview-1',
    baselineGraphFingerprint: baseline.graphFingerprint,
    nativeGraphFingerprint: native.graphFingerprint,
    dimensions,
    parityClaimed: false,
    publicDefaultChanged: false
  };
  return Object.freeze({ ...structural, comparisonFingerprint: fingerprint(structural) });
}

function translateNode(node, workspaceId) {
  const kind = node.kind === 'file'
    ? 'file'
    : (node.kind === 'module' || node.kind === 'package' || node.kind === 'namespace')
      ? 'module'
      : SYMBOL_KINDS.has(node.kind)
        ? 'symbol'
        : null;
  if (!kind) return null;
  const label = compatibilityLabel(node.kind === 'route' ? routeMethod(node.name) : node.name);
  const qualifiedLabel = compatibilityLabel(node.qualifiedName || node.name);
  const locator = kind === 'symbol' ? node.locator : stripLineSpan(node.locator);
  const id = `sgnode_${sha256Hex(stableStringify({ kind, nativeId: node.id, workspaceId })).slice(0, 32)}`;
  return Object.freeze({
    id,
    workspaceId,
    kind,
    label,
    ...(qualifiedLabel === label ? {} : { qualifiedLabel }),
    ...(locator ? { locator } : {}),
    ...(kind === 'symbol' ? { symbolKind: SYMBOL_KINDS.get(node.kind) } : {}),
    ...(node.contentHash ? { contentHash: node.contentHash } : {}),
    nativeId: node.id
  });
}

function compatibilityEdge({ workspaceId, kind, fromNodeId, toNodeId, locator, confidence }) {
  const safeLocator = locator ? stripLineSpan(locator) : undefined;
  return Object.freeze({
    id: `sgedge_${sha256Hex(stableStringify({ workspaceId, kind, fromNodeId, toNodeId, locator: safeLocator })).slice(0, 32)}`,
    workspaceId,
    kind,
    fromNodeId,
    toNodeId,
    ...(safeLocator ? { locator: safeLocator } : {}),
    confidence
  });
}

function compatibilityEdgeKind(kind) {
  return ({
    contains: 'contains',
    defines: 'defined_in',
    imports: 'imports',
    exports: 'exports',
    re_exports: 'exports',
    references: 'references',
    calls: 'calls'
  })[kind] ?? null;
}

function compatibilityCoverage({ nativeGraph, nodes, edges, diagnostics, nodeKindCounts, edgeKindCounts, omittedNativeNodeCount }) {
  const representedLocators = nodes
    .filter((node) => node.kind === 'file' && ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'].some((extension) => node.locator.endsWith(extension)))
    .map((node) => node.locator)
    .sort()
    .slice(0, 1000);
  const failedFileCount = nativeGraph.coverage.reduce((sum, item) => sum + item.failedFileCount, 0);
  const omittedFileCount = nativeGraph.coverage.reduce((sum, item) => sum + (item.omittedFileCount ?? 0), 0);
  const skippedLocators = diagnostics.filter((item) => item.code === 'parse_failed').map((item) => item.locator).slice(0, 100);
  const oversizedLocators = diagnostics.filter((item) => item.code === 'file_too_large').map((item) => item.locator).slice(0, 100);
  const partial = nativeGraph.generation.freshness !== 'current'
    || failedFileCount > 0
    || omittedFileCount > 0
    || omittedNativeNodeCount > 0;
  const reasonCodes = ['native_compatibility_projection'];
  if (partial) reasonCodes.push('native_partial_coverage');
  if (omittedNativeNodeCount > 0) reasonCodes.push('native_constructs_omitted');
  return Object.freeze({
    status: partial ? 'partial' : 'complete',
    representedFileCount: representedLocators.length,
    representedJsTsLocators: representedLocators,
    skippedFileCount: failedFileCount,
    skippedLocators,
    oversizedFileCount: oversizedLocators.length,
    oversizedLocators,
    unsupportedFileCount: 0,
    unsupportedExtensions: [],
    unsupportedExtensionCounts: {},
    candidateNodeCount: nativeGraph.nodes.length,
    representedNodeCount: nodes.length,
    omittedNodeCount: omittedNativeNodeCount,
    candidateNodeKindCounts: nodeKindCounts,
    representedNodeKindCounts: nodeKindCounts,
    omittedNodeKindCounts: {},
    candidateEdgeCount: edges.length,
    representedEdgeCount: edges.length,
    omittedEdgeCount: 0,
    candidateEdgeKindCounts: edgeKindCounts,
    representedEdgeKindCounts: edgeKindCounts,
    omittedEdgeKindCounts: {},
    maxFilesReached: omittedFileCount > 0,
    reasonCodes
  });
}

function ambiguousLabels(nodes) {
  const byLabel = new Map();
  for (const node of nodes.filter((item) => item.kind === 'symbol')) {
    const values = byLabel.get(node.label) ?? [];
    values.push(node);
    byLabel.set(node.label, values);
  }
  return [...byLabel.entries()]
    .filter(([, values]) => values.length > 1)
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 25)
    .map(([label, values]) => Object.freeze({
      label,
      count: values.length,
      qualifiedLabels: [...new Set(values.map((item) => item.qualifiedLabel).filter(Boolean))].slice(0, 5),
      locators: [...new Set(values.map((item) => item.locator).filter(Boolean))].slice(0, 5)
    }));
}

function hotspots(nodes, edges) {
  const degree = new Map(nodes.map((node) => [node.id, { inbound: 0, outbound: 0 }]));
  for (const edge of edges) {
    if (degree.has(edge.fromNodeId)) degree.get(edge.fromNodeId).outbound += 1;
    if (degree.has(edge.toNodeId)) degree.get(edge.toNodeId).inbound += 1;
  }
  return nodes.filter((node) => node.kind === 'symbol').map((node) => {
    const counts = degree.get(node.id);
    return nodeReference(node, {
      inbound: counts.inbound,
      outbound: counts.outbound,
      total: counts.inbound + counts.outbound,
      reasonCodes: ['native_structural_degree']
    });
  }).filter((item) => item.total > 0)
    .sort((left, right) => right.total - left.total || left.label.localeCompare(right.label))
    .slice(0, 25);
}

function entryPoints(nodes, edges) {
  const inboundCalls = new Map();
  const outboundCalls = new Map();
  for (const edge of edges.filter((item) => item.kind === 'calls')) {
    inboundCalls.set(edge.toNodeId, (inboundCalls.get(edge.toNodeId) ?? 0) + 1);
    outboundCalls.set(edge.fromNodeId, (outboundCalls.get(edge.fromNodeId) ?? 0) + 1);
  }
  return nodes.filter((node) => node.kind === 'symbol')
    .filter((node) => HTTP_METHODS.has(node.label)
      || /^(?:main|start|run|serve|handler)$/iu.test(node.label)
      || ((inboundCalls.get(node.id) ?? 0) === 0 && (outboundCalls.get(node.id) ?? 0) > 0))
    .sort((left, right) => left.label.localeCompare(right.label) || (left.locator ?? '').localeCompare(right.locator ?? ''))
    .slice(0, 25)
    .map((node) => nodeReference(node, { reasonCodes: ['native_entry_point'] }));
}

function nodeReference(node, extra = {}) {
  return Object.freeze({
    nodeId: node.id,
    label: node.label,
    ...(node.qualifiedLabel ? { qualifiedLabel: node.qualifiedLabel } : {}),
    locator: node.locator,
    symbolKind: node.symbolKind,
    ...extra
  });
}

function dimension(name, baselineKeys, nativeKeys) {
  const matchedCount = [...baselineKeys].filter((key) => nativeKeys.has(key)).length;
  return Object.freeze({
    name,
    baselineCount: baselineKeys.size,
    nativeCount: nativeKeys.size,
    matchedCount,
    recall: baselineKeys.size ? Number((matchedCount / baselineKeys.size).toFixed(4)) : 1
  });
}

function fileKeys(graph) {
  return new Set(graph.nodes.filter((node) => node.kind === 'file').map((node) => fileLocator(node.locator)));
}

function symbolKeys(graph) {
  return new Set(graph.nodes.filter((node) => node.kind === 'symbol').map((node) => (
    `${normalizedSymbolLabel(node)}|${fileLocator(node.locator)}`
  )));
}

function routeKeys(graph) {
  return new Set(graph.nodes.filter((node) => node.kind === 'symbol' && HTTP_METHODS.has(node.label) && routeLike(node.locator)).map((node) => (
    `${node.label}|${fileLocator(node.locator)}`
  )));
}

function relationshipKeys(graph, kind) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  return new Set(graph.edges.filter((edge) => edge.kind === kind).map((edge) => {
    const from = nodes.get(edge.fromNodeId);
    const to = nodes.get(edge.toNodeId);
    if (!from || !to) return null;
    if (kind === 'imports') return `${fileLocator(from.locator ?? edge.locator)}=>${normalizedModuleLabel(to)}`;
    return `${normalizedSymbolLabel(from)}|${fileLocator(from.locator)}=>${normalizedSymbolLabel(to)}|${fileLocator(to.locator)}`;
  }).filter(Boolean));
}

function normalizedSymbolLabel(node) {
  const label = String(node?.label ?? '').toLowerCase();
  return node?.symbolKind === 'method' ? label.split('_').at(-1) : label;
}

function normalizedModuleLabel(node) {
  const label = String(node?.label ?? '').replace(/^\.\//u, '').replace(/\.(?:[cm]?[jt]sx?)$/u, '');
  return label.split(/[\/_]/u).filter(Boolean).at(-1)?.toLowerCase() ?? label.toLowerCase();
}

function routeLike(locator) {
  return /(?:^|\/)(?:routes?|api)(?:\/|\.|$)/iu.test(String(locator ?? ''));
}

function routeMethod(name) {
  const method = String(name).split('_', 1)[0].toUpperCase();
  return HTTP_METHODS.has(method) ? method : name;
}

function compatibilityLabel(value) {
  const label = String(value ?? '')
    .replace(/[^A-Za-z0-9_$@~./#*+,\[\]-]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 240);
  return label || 'unknown';
}

function compatibilityReason(value) {
  const reason = String(value ?? 'native_diagnostic')
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 64);
  return reason || 'native_diagnostic';
}

function stripLineSpan(locator) {
  return String(locator ?? '').replace(/#L[0-9]+-L[0-9]+$/u, '');
}

function fileLocator(locator) {
  return stripLineSpan(locator);
}

function countBy(items, key) {
  const result = {};
  for (const item of items) result[key(item)] = (result[key(item)] ?? 0) + 1;
  return Object.freeze(result);
}

function compareNodes(left, right) {
  return (left.locator ?? '').localeCompare(right.locator ?? '')
    || left.kind.localeCompare(right.kind)
    || left.label.localeCompare(right.label)
    || left.id.localeCompare(right.id);
}

function compareEdges(left, right) {
  return left.kind.localeCompare(right.kind)
    || left.fromNodeId.localeCompare(right.fromNodeId)
    || left.toNodeId.localeCompare(right.toNodeId)
    || left.id.localeCompare(right.id);
}

function safeVersion(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/gu, '-').slice(0, 64);
}

function fingerprint(value) {
  return `sha256:${sha256Hex(stableStringify(value))}`;
}
