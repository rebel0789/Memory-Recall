import { createHash } from 'node:crypto';
import { estimateTokens } from '../../context-compiler/src/index.mjs';
import {
  normalizeSourceGraphWorkspaceLocator,
  SOURCE_GRAPH_WORKSPACE_ID_RE
} from '../../protocol/src/source-graph-locator.mjs';

export const NATIVE_INDEX_LANGUAGES = Object.freeze([
  'c', 'cpp', 'csharp', 'dart', 'go', 'java', 'javascript', 'kotlin',
  'php', 'python', 'ruby', 'rust', 'swift', 'typescript'
]);

export const DEFAULT_SOURCE_GRAPH_PREVIEW_MAX_FILE_BYTES = 512 * 1024;
export const DEFAULT_SOURCE_GRAPH_PREVIEW_MAX_FILES = 1000;

const PREVIEW_VERSION = 'oaf-source-graph-preview-1.0.0';
const INDEX_LOCATOR = 'workspace://.local/source-index/index.v1.sqlite';
const NODE_KINDS = new Set(['file', 'module', 'package', 'namespace']);
const SYMBOL_KINDS = new Set(['class', 'function', 'method', 'interface', 'type']);
const EDGE_KINDS = new Set(['contains', 'defined_in', 'imports', 'exports', 'references', 'calls']);
const PUBLIC_NODE_KINDS = new Set(['file', 'chunk', 'symbol', 'module']);
const TRACE_DIRECTIONS = new Set(['outbound', 'inbound', 'both']);
const MAX_CHANGED_LOCATORS = 16;
const SOURCE_GRAPH_EXTENSIONS = Object.freeze([
  '.bash', '.c', '.cc', '.cpp', '.cs', '.cjs', '.cxx', '.dart', '.go', '.h',
  '.hpp', '.java', '.jl', '.js', '.jsx', '.kt', '.kts', '.lua', '.m', '.mjs',
  '.mm', '.php', '.py', '.r', '.rb', '.rs', '.scala', '.sh', '.sql', '.swift',
  '.ts', '.tsx', '.zig'
]);

export function buildUnavailableSourceGraphPreview({
  workspaceId = 'ws_local',
  query = '',
  changedLocators = [],
  nodeKinds = null,
  edgeKinds = null,
  labelPattern = null,
  locatorPrefix = null,
  direction = 'outbound',
  limit = 20,
  offset = 0,
  depth = 2,
  sampleLimit = 12,
  errorCode = 'native_engine_unavailable',
  clock = () => new Date().toISOString()
} = {}) {
  const safeWorkspaceId = normalizeWorkspaceId(workspaceId);
  const boundedLimit = boundedInteger(limit, 1, 100, 'source_graph_preview_limit_invalid');
  const boundedOffset = boundedInteger(offset, 0, 10_000, 'source_graph_preview_offset_invalid');
  const boundedDepth = boundedInteger(depth, 1, 5, 'source_graph_preview_depth_invalid');
  const boundedSampleLimit = boundedInteger(sampleLimit, 1, 50, 'source_graph_preview_sample_limit_invalid');
  const normalizedChangedLocators = normalizeChangedLocators(changedLocators);
  const normalizedNodeKinds = normalizeKinds(nodeKinds, PUBLIC_NODE_KINDS, 'source_graph_preview_node_kind_invalid');
  const normalizedEdgeKinds = normalizeKinds(edgeKinds, EDGE_KINDS, 'source_graph_preview_edge_kind_invalid');
  const normalizedLocatorPrefix = locatorPrefix ? normalizeWorkspaceLocator(locatorPrefix) : null;
  if (!TRACE_DIRECTIONS.has(direction)) throw new Error(`source_graph_preview_direction_invalid:${direction}`);
  const generatedAt = clock();
  const code = safeDiagnosticCode(`source_graph_unavailable:${safeErrorCode(errorCode)}`);
  const graphFingerprint = fingerprint({ kind: 'source-graph-unavailable', workspaceId: safeWorkspaceId, code });
  const sourceIndexFingerprint = fingerprint({ kind: 'source-index-unavailable', workspaceId: safeWorkspaceId, code });
  const diagnostic = Object.freeze({ locator: 'workspace://__source_graph_preview__', code });
  const search = Object.freeze({
    schemaVersion: '1.0.0',
    workspaceId: safeWorkspaceId,
    graphFingerprint,
    retrievalMethod: 'source_graph_lexical',
    queryFingerprint: fingerprint({
      query: String(query ?? ''),
      nodeKinds: normalizedNodeKinds ?? [],
      edgeKinds: normalizedEdgeKinds ?? [],
      labelPattern,
      locatorPrefix: normalizedLocatorPrefix,
      limit: boundedLimit,
      offset: boundedOffset,
      unavailable: true
    }),
    total: 0,
    limit: boundedLimit,
    offset: boundedOffset,
    reachedOffset: boundedOffset,
    offsetIncomplete: false,
    continuationCursor: null,
    truncated: false,
    hasMore: false,
    omittedCount: 0,
    results: []
  });
  const impact = normalizedChangedLocators.length ? Object.freeze({
    schemaVersion: '1.0.0',
    workspaceId: safeWorkspaceId,
    graphFingerprint,
    changedLocators: normalizedChangedLocators,
    representedChangedLocators: [],
    depth: boundedDepth,
    impactedNodeIds: [],
    impactedEdgeIds: [],
    impactedEdgeKindCounts: {},
    affectedSymbols: []
  }) : null;
  const graph = Object.freeze({
    schemaVersion: '1.0.0',
    workspaceId: safeWorkspaceId,
    graphVersion: 'memory-recall-native-source-graph-unavailable-1.0.0',
    parserVersion: 'memory-recall-native-unavailable',
    builtAt: generatedAt,
    sourceIndexFingerprint,
    graphFingerprint,
    summary: Object.freeze({
      fileCount: 0,
      symbolCount: 0,
      moduleCount: 0,
      nodeCount: 0,
      edgeCount: 0,
      nodeKindCounts: Object.freeze({}),
      edgeKindCounts: Object.freeze({}),
      hotspots: [],
      entryPoints: []
    }),
    diagnostics: [diagnostic],
    sampleLimit: boundedSampleLimit,
    sampleNodes: [],
    sampleEdges: [],
    omittedNodes: 0,
    omittedEdges: 0
  });
  const snapshot = Object.freeze({
    status: 'unavailable',
    reuse: 'none',
    reason: code,
    generation: 0,
    validationMode: 'none',
    buildDurationMs: null,
    builtAt: null
  });
  const orientation = Object.freeze({ groups: Object.freeze([]), relations: Object.freeze([]) });
  const focus = Object.freeze({
    nodeLimit: 200,
    edgeLimit: 400,
    nodes: Object.freeze([]),
    edges: Object.freeze([]),
    omittedNodes: 0,
    omittedEdges: 0
  });
  const deliveredTokenEstimate = estimateTokens(JSON.stringify({ graph, search, trace: null, impact, orientation, focus, snapshot }));
  return Object.freeze({
    schemaVersion: '1.0.0',
    previewVersion: PREVIEW_VERSION,
    workspaceId: safeWorkspaceId,
    generatedAt,
    graph,
    search,
    trace: null,
    impact,
    orientation,
    focus,
    snapshot,
    measurements: Object.freeze({
      schemaVersion: '1.0.0',
      measurementScope: 'full graph nodes/edges/diagnostics versus delivered preview payload',
      fullGraphTokenEstimate: 0,
      deliveredTokenEstimate,
      omittedTokenEstimate: 0,
      reductionPercent: 0,
      sourceContentIncluded: false,
      providerBillingClaimed: false
    }),
    safeguards: sourceGraphSafeguards()
  });
}

export function nativeIndexReadyForAutomaticRead(result) {
  return result?.operation === 'index.status'
    && result.state === 'ready'
    && result.freshness === 'current'
    && result.health?.status === 'ready'
    && result.health.repairRequired === false
    && Number.isSafeInteger(result.activeGeneration)
    && result.activeGeneration >= 1
    && result.safeguards?.readOnly === true
    && result.safeguards.localFilesWritten === 0;
}

export function nativeIndexSource(result) {
  return {
    kind: 'native-persistent-index',
    engine: 'memory-recall-native',
    indexLocator: result.indexLocator,
    activeGeneration: result.activeGeneration,
    freshness: result.freshness
  };
}

export function nativeStructuralNode(item) {
  return {
    id: item.id,
    kind: item.kind,
    label: item.label,
    locator: item.locator,
    confidence: item.confidence,
    generation: item.generation
  };
}

export function nativeStructuralRelationship(item) {
  return {
    id: item.id,
    kind: item.kind,
    fromNodeId: item.fromNodeId,
    toNodeId: item.toNodeId,
    locator: item.locator,
    confidence: item.confidence,
    resolution: item.resolution,
    resolver: item.resolver,
    resolverVersion: item.resolverVersion,
    generation: item.generation,
    stale: item.stale
  };
}

export function buildNativeIndexArchitecture(communityResult, processResult, limit) {
  const mergedNodeCount = new Set([...processResult.results, ...communityResult.results].map((item) => item.id)).size;
  const processNodes = processResult.results.map(nativeStructuralNode);
  const communityNodes = communityResult.results.map(nativeStructuralNode);
  const nodes = uniqueById([...processNodes, ...communityNodes], 100);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const processRelationships = (processResult.relationships ?? []).map(nativeStructuralRelationship);
  const communityRelationships = (communityResult.relationships ?? []).map(nativeStructuralRelationship);
  const mergedRelationshipCount = new Set([...processRelationships, ...communityRelationships].map((item) => item.id)).size;
  const relationships = uniqueById([...processRelationships, ...communityRelationships], 100);
  const groups = (communityResult.communities ?? []).slice(0, limit).map((community) => ({
    id: community.id,
    label: community.label,
    pathPrefix: community.pathPrefix,
    nodeCount: community.representedNodeCount,
    relationshipCount: community.representedRelationshipCount,
    sampleNodeIds: community.nodeIds.filter((id) => nodeById.has(id)).slice(0, 3),
    algorithmVersion: community.algorithmVersion,
    truncated: community.truncated
  }));
  const processes = (processResult.processes ?? []).slice(0, limit).map((process) => ({
    id: process.id,
    label: process.label,
    entryNodeId: process.entryNodeId,
    entryRelationshipId: process.entryRelationshipId,
    sinkNodeId: process.sinkNodeId,
    sinkKind: process.sinkKind,
    nodeIds: process.nodeIds,
    relationshipIds: process.relationshipIds,
    confidence: process.confidence,
    algorithmVersion: process.algorithmVersion,
    truncated: process.truncated
  }));
  const entryPoints = uniqueById(
    processes.map((process) => nodeById.get(process.entryNodeId)).filter(Boolean),
    limit
  );
  const degree = nodeDegrees(communityRelationships);
  const hotspots = communityNodes
    .filter((node) => (degree.get(node.id)?.total ?? 0) > 0)
    .sort((left, right) => (degree.get(right.id)?.total ?? 0) - (degree.get(left.id)?.total ?? 0) || left.id.localeCompare(right.id))
    .slice(0, limit)
    .map((node) => ({ ...node, relationshipCount: degree.get(node.id).total }));
  const communityLocallyTruncated = communityResult.results.length > 100
    || (communityResult.communities ?? []).length > limit
    || communityRelationships.length > 100;
  const processLocallyTruncated = processResult.results.length > 100
    || (processResult.processes ?? []).length > limit
    || processRelationships.length > 100;
  const completeness = {
    communities: nativeResultCompleteness(communityResult, communityLocallyTruncated),
    processes: nativeResultCompleteness(processResult, processLocallyTruncated),
    merged: {
      truncated: mergedNodeCount > 100 || mergedRelationshipCount > 100,
      representedNodeLimit: 100,
      representedRelationshipLimit: 100
    }
  };
  return {
    schemaVersion: '1.0.0',
    retrievalMethod: 'native_index_architecture',
    summary: {
      representedNodeCount: nodes.length,
      representedRelationshipCount: relationships.length,
      totalNodeCount: communityResult.summary.nodeCount,
      fileCount: communityResult.summary.fileCount,
      edgeCount: communityResult.summary.edgeCount,
      communityCount: groups.length,
      processCount: processes.length
    },
    groups,
    entryPoints,
    hotspots,
    processes,
    nodes,
    relationships,
    completeness,
    truncated: completeness.communities.truncated
      || completeness.processes.truncated
      || completeness.merged.truncated
      || groups.some((group) => group.truncated)
      || processes.some((process) => process.truncated),
    source: nativeIndexSource(communityResult)
  };
}

function nativeResultCompleteness(result, locallyTruncated = false) {
  return {
    truncated: Boolean(result?.truncated || result?.nextCursor || locallyTruncated),
    nextCursor: result?.nextCursor ?? null,
    locallyTruncated
  };
}

export async function buildNativeIndexSourceGraphPreview({
  provider,
  status,
  root,
  workspaceId = 'ws_local',
  query = '',
  startName = null,
  changedLocators = [],
  nodeKinds = null,
  edgeKinds = null,
  locatorPrefix = null,
  direction = 'outbound',
  limit = 20,
  offset = 0,
  depth = 2,
  sampleLimit = 12,
  clock = () => new Date().toISOString()
} = {}) {
  const boundedLimit = boundedInteger(limit, 1, 100, 'source_graph_preview_limit_invalid');
  const boundedOffset = boundedInteger(offset, 0, 10_000, 'source_graph_preview_offset_invalid');
  const boundedDepth = boundedInteger(depth, 1, 5, 'source_graph_preview_depth_invalid');
  const boundedSampleLimit = boundedInteger(sampleLimit, 1, 50, 'source_graph_preview_sample_limit_invalid');
  const normalizedQuery = String(query ?? '').trim();
  const normalizedChanged = [...new Set(changedLocators)].slice(0, 16);
  const normalizedNodeKinds = normalizeKinds(nodeKinds, PUBLIC_NODE_KINDS, 'source_graph_preview_node_kind_invalid');
  const normalizedEdgeKinds = normalizeKinds(edgeKinds, EDGE_KINDS, 'source_graph_preview_edge_kind_invalid');
  const generatedAt = clock();
  const [communityResult, processResult] = await Promise.all([
    provider.queryIndex({ root, workspaceId, kind: 'communities', limit: Math.min(50, Math.max(12, boundedLimit)) }),
    provider.queryIndex({ root, workspaceId, kind: 'processes', depth: 4, limit: Math.min(50, boundedLimit) })
  ]);
  const architecture = buildNativeIndexArchitecture(communityResult, processResult, boundedLimit);
  const focusSeed = normalizedQuery || startName || locatorPrefix || normalizedChanged[0] || null;
  const seedUsesLocator = Boolean(!normalizedQuery && !startName && (locatorPrefix || normalizedChanged[0]));
  const searchResult = focusSeed
    ? await queryNativeSearchPage({
      provider,
      root,
      workspaceId,
      limit: boundedLimit,
      offset: boundedOffset,
      locatorPrefix,
      ...(seedUsesLocator ? { locator: normalizeLocator(focusSeed) } : { query: String(focusSeed).slice(0, 160) })
    })
    : null;
  const selected = (searchResult?.results ?? []).find((item) => (
    !locatorPrefix || item.locator?.startsWith(normalizeLocator(locatorPrefix))
  )) ?? null;
  const neighborhood = selected
    ? await provider.queryIndex({ root, workspaceId, kind: 'neighborhood', locator: selected.locator, depth: boundedDepth, limit: boundedLimit })
    : null;
  const impactLimit = normalizedChanged.length ? Math.max(1, Math.floor(boundedLimit / normalizedChanged.length)) : boundedLimit;
  const impactResults = await Promise.all(normalizedChanged.filter(isSourceGraphLocator).map(async (locator) => ({
    locator: normalizeLocator(locator),
    result: await optionalNativeIndexQuery(() => provider.queryIndex({
      root,
      workspaceId,
      kind: 'impact',
      locator: normalizeLocator(locator),
      depth: boundedDepth,
      limit: impactLimit
    }))
  })));
  const traceResult = startName
    ? await optionalNativeIndexQuery(() => provider.queryIndex({
      root,
      workspaceId,
      kind: 'dependencies',
      query: String(startName).slice(0, 160),
      direction,
      depth: boundedDepth,
      limit: boundedLimit
    }))
    : null;
  return nativePreviewPayload({
    status: status ?? communityResult,
    communityResult,
    architecture,
    searchResult,
    neighborhood,
    impactResults,
    traceResult,
    startName,
    workspaceId,
    query: normalizedQuery,
    changedLocators: normalizedChanged.map(normalizeLocator),
    nodeKinds: normalizedNodeKinds,
    edgeKinds: normalizedEdgeKinds,
    locatorPrefix,
    direction,
    limit: boundedLimit,
    offset: boundedOffset,
    depth: boundedDepth,
    sampleLimit: boundedSampleLimit,
    generatedAt
  });
}

async function optionalNativeIndexQuery(query) {
  try {
    return await query();
  } catch (error) {
    if (error?.code === 'source_index_query_seed_not_found') return null;
    throw error;
  }
}

function nativePreviewPayload(input) {
  const { architecture, communityResult, status, workspaceId, sampleLimit, generatedAt } = input;
  const nativeNodes = uniqueById([
    ...architecture.nodes,
    ...(input.searchResult?.results ?? []).map(nativeStructuralNode),
    ...(input.neighborhood?.results ?? []).map(nativeStructuralNode),
    ...(input.impactResults ?? []).flatMap(({ result }) => (result?.results ?? []).map(nativeStructuralNode)),
    ...(input.traceResult?.results ?? []).map(nativeStructuralNode)
  ], 200);
  const nativeRelationships = uniqueById([
    ...architecture.relationships,
    ...(input.neighborhood?.relationships ?? []).map(nativeStructuralRelationship),
    ...(input.impactResults ?? []).flatMap(({ result }) => (result?.relationships ?? []).map(nativeStructuralRelationship)),
    ...(input.traceResult?.relationships ?? []).map(nativeStructuralRelationship)
  ], 400);
  const ids = createIdMaps(nativeNodes, nativeRelationships);
  const nodes = nativeNodes.map((node) => sourceGraphNode(node, ids, workspaceId));
  const edges = nativeRelationships
    .filter((edge) => ids.node.has(edge.fromNodeId) && ids.node.has(edge.toNodeId))
    .map((edge) => sourceGraphEdge(edge, ids, workspaceId));
  const graphFingerprint = fingerprint({ generation: status.activeGeneration, nodes, edges });
  const sourceIndexFingerprint = fingerprint({
    locator: status.indexLocator ?? INDEX_LOCATOR,
    generation: status.activeGeneration,
    repository: status.repositoryIdentityHash
  });
  const orientation = orientationProjection({ architecture, ids, changedLocators: input.changedLocators });
  const degree = nodeDegrees(architecture.relationships);
  const entryPoints = architecture.entryPoints.slice(0, 25).map((node) => nodeReference(node, ids, ['entry_point']));
  const hotspots = architecture.hotspots
    .filter((node) => ids.node.has(node.id))
    .slice(0, 25)
    .map((node) => hotspotReference(node, ids, degree));
  const coverage = coverageProjection(status, communityResult);
  const diagnostics = diagnosticsProjection(status);
  const focusNativeIds = new Set([
    ...(input.neighborhood?.results ?? []),
    ...(input.impactResults ?? []).flatMap(({ result }) => result?.results ?? []),
    ...(input.traceResult?.results ?? [])
  ].map((node) => node.id));
  const focus = {
    nodeLimit: 200,
    edgeLimit: 400,
    nodes: nodes.filter((node) => focusNativeIds.has(ids.nodeReverse.get(node.id))).filter((node) => !input.locatorPrefix || node.locator?.startsWith(normalizeLocator(input.locatorPrefix))),
    edges: [],
    omittedNodes: diagnosticCount(status, 'source_index_nodes_omitted'),
    omittedEdges: diagnosticCount(status, 'source_index_edges_omitted')
  };
  const focusNodeIds = new Set(focus.nodes.map((node) => node.id));
  focus.edges = edges.filter((edge) => focusNodeIds.has(edge.fromNodeId) && focusNodeIds.has(edge.toNodeId));
  const search = searchProjection(input, ids, graphFingerprint);
  const impact = impactProjection(input, ids, graphFingerprint);
  const trace = traceProjection(input, ids, graphFingerprint);
  const summary = {
    fileCount: status.summary.fileCount,
    symbolCount: Math.max(0, status.summary.nodeCount - status.summary.fileCount),
    moduleCount: nativeNodes.filter((node) => ['module', 'package', 'namespace'].includes(node.kind)).length,
    nodeCount: status.summary.nodeCount,
    edgeCount: status.summary.edgeCount,
    nodeKindCounts: countBy(nodes, 'kind'),
    edgeKindCounts: countBy(edges, 'kind'),
    coverage,
    hotspots,
    entryPoints,
    deprioritized: []
  };
  const graph = {
    schemaVersion: '1.0.0',
    workspaceId,
    graphVersion: 'memory-recall-native-index-1.0.0',
    parserVersion: `memory-recall-native-${status.engineVersion}`,
    builtAt: status.health.lastSuccessfulRefreshAt ?? generatedAt,
    sourceIndexFingerprint,
    graphFingerprint,
    summary,
    diagnostics,
    sampleLimit,
    sampleNodes: nodes.slice(0, sampleLimit),
    sampleEdges: edges.slice(0, sampleLimit),
    omittedNodes: Math.max(coverage.omittedNodeCount ?? 0, status.summary.nodeCount - Math.min(nodes.length, sampleLimit)),
    omittedEdges: Math.max(coverage.omittedEdgeCount ?? 0, status.summary.edgeCount - Math.min(edges.length, sampleLimit))
  };
  const deliveredTokenEstimate = estimateTokens(JSON.stringify({ graph, search, trace, impact, orientation, focus }));
  const fullGraphTokenEstimate = Math.max(deliveredTokenEstimate, status.summary.nodeCount * 24 + status.summary.edgeCount * 18);
  return Object.freeze({
    schemaVersion: '1.0.0',
    previewVersion: PREVIEW_VERSION,
    workspaceId,
    generatedAt,
    graph,
    search,
    trace,
    impact,
    orientation,
    focus,
    snapshot: {
      status: 'fresh',
      reuse: 'cache',
      reason: null,
      generation: status.activeGeneration,
      validationMode: 'metadata-scan',
      buildDurationMs: status.measurements.durationMs,
      builtAt: status.health.lastSuccessfulRefreshAt
    },
    measurements: {
      schemaVersion: '1.0.0',
      measurementScope: 'full graph nodes/edges/diagnostics versus delivered preview payload',
      fullGraphTokenEstimate,
      deliveredTokenEstimate,
      omittedTokenEstimate: Math.max(0, fullGraphTokenEstimate - deliveredTokenEstimate),
      reductionPercent: fullGraphTokenEstimate ? Number((((fullGraphTokenEstimate - deliveredTokenEstimate) / fullGraphTokenEstimate) * 100).toFixed(2)) : 0,
      sourceContentIncluded: false,
      providerBillingClaimed: false
    },
    safeguards: {
      dryRun: true,
      persisted: false,
      canonicalStateMutated: false,
      localFilesWritten: 0,
      modelCalls: 0,
      networkCalls: 0,
      externalAdaptersEnabled: 0,
      externalWritesEnabled: false,
      graphDatabaseUsed: false,
      rawBodyIncluded: false,
      sourceSlicesRead: false
    }
  });
}

function orientationProjection({ architecture, ids, changedLocators }) {
  const communityByNode = new Map();
  const groupByCommunity = new Map();
  const groupsById = new Map();
  for (const community of processCommunities(architecture, ids, changedLocators)) {
    groupByCommunity.set(community.nativeId, community.group);
    groupsById.set(community.group.id, community.group);
    for (const nodeId of community.nodeIds) communityByNode.set(nodeId, community.nativeId);
  }
  const relations = new Map();
  for (const edge of architecture.relationships) {
    const from = communityByNode.get(edge.fromNodeId);
    const to = communityByNode.get(edge.toNodeId);
    if (!from || !to || from === to) continue;
    const kind = sourceGraphEdgeKind(edge.kind);
    if (!['imports', 'calls'].includes(kind)) continue;
    const key = `${from}:${to}`;
    const current = relations.get(key) ?? { from, to, count: 0, edgeKindCounts: {} };
    current.count += 1;
    current.edgeKindCounts[kind] = (current.edgeKindCounts[kind] ?? 0) + 1;
    relations.set(key, current);
  }
  return {
    groups: [...groupsById.values()].slice(0, 12),
    processes: processProjection(architecture, ids),
    relations: [...relations.values()].sort((a, b) => b.count - a.count || `${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`)).map((relation) => {
      const source = groupByCommunity.get(relation.from);
      const target = groupByCommunity.get(relation.to);
      if (!source || !target || source.id === target.id) return null;
      return {
        id: mappedId('sgrelation', `${relation.from}:${relation.to}`, 24),
        sourceGroupId: source.id,
        targetGroupId: target.id,
        sourcePrefix: source.prefix,
        targetPrefix: target.prefix,
        count: relation.count,
        edgeKindCounts: relation.edgeKindCounts
      };
    }).filter(Boolean).slice(0, 20)
  };
}

function processProjection(architecture, ids) {
  const nodeById = new Map(architecture.nodes.map((node) => [node.id, node]));
  return architecture.processes.slice(0, 12).map((process) => {
    const entry = nodeById.get(process.entryNodeId);
    const sink = nodeById.get(process.sinkNodeId);
    const nodeIds = process.nodeIds.map((id) => ids.node.get(id)).filter(Boolean);
    const relationshipIds = process.relationshipIds.map((id) => ids.edge.get(id)).filter(Boolean);
    if (
      !entry?.locator
      || !sink?.locator
      || nodeIds.length !== process.nodeIds.length
      || relationshipIds.length !== process.relationshipIds.length
      || relationshipIds.length < 2
    ) return null;
    return {
      id: mappedId('sgprocess', process.id, 24),
      label: safeLabel(process.label),
      entryPoint: nodeReference(entry, ids, ['entry_point']),
      sink: nodeReference(sink, ids, ['process_sink']),
      sinkKind: process.sinkKind,
      nodeIds,
      relationshipIds,
      confidence: process.confidence,
      algorithmVersion: process.algorithmVersion,
      truncated: process.truncated
    };
  }).filter(Boolean);
}

function processCommunities(architecture, ids, changedLocators) {
  const groupsByPrefix = new Map();
  const communities = [];
  for (const community of architecture.groups) {
    const prefix = safeGroupPrefix(community.pathPrefix);
    if (!groupsByPrefix.has(prefix) && groupsByPrefix.size >= 12) continue;
    const original = architecture.groups.find((item) => item.id === community.id);
    const nodeIds = original?.sampleNodeIds ?? [];
    const members = architecture.nodes.filter((node) => nodeIds.includes(node.id) || node.locator?.startsWith(`${normalizeLocator(prefix)}/`));
    const entryPoints = architecture.entryPoints
      .filter((node) => members.some((member) => member.id === node.id))
      .slice(0, 2)
      .map((node) => nodeReference(node, ids, ['entry_point']));
    const group = groupsByPrefix.get(prefix) ?? {
      id: mappedId('sggroup', prefix, 24),
      prefix,
      fileCount: members.filter((node) => node.kind === 'file').length,
      symbolCount: members.filter((node) => !NODE_KINDS.has(node.kind)).length,
      changedFileCount: changedLocators.filter((locator) => locator.startsWith(`workspace://${prefix}`)).length,
      entryPoints
    };
    groupsByPrefix.set(prefix, group);
    communities.push({
      nativeId: community.id,
      nodeIds: members.map((node) => node.id),
      group
    });
  }
  return communities;
}

function searchProjection(input, ids, graphFingerprint) {
  const matchedNodes = (input.searchResult?.results ?? [])
    .map((item) => {
      const node = sourceGraphNode(nativeStructuralNode(item), ids, input.workspaceId);
      return {
        resultType: 'node',
        id: node.id,
        kind: node.kind,
        label: node.label,
        ...(node.locator ? { locator: node.locator } : {}),
        ...(node.symbolKind ? { symbolKind: node.symbolKind } : {}),
        score: item.confidence,
        reasonCodes: ['native_index_match']
      };
    })
    .filter((item) => !input.nodeKinds || input.nodeKinds.includes(item.kind));
  const nativeNodes = new Map([
    ...(input.searchResult?.results ?? []),
    ...(input.neighborhood?.results ?? [])
  ].map((item) => [item.id, item]));
  const relationshipResults = (input.neighborhood?.relationships ?? [])
    .filter((relationship) => input.edgeKinds?.includes(sourceGraphEdgeKind(relationship.kind)))
    .map((relationship) => relationshipSearchResult(relationship, nativeNodes, ids, input.workspaceId))
    .filter(Boolean)
    .slice(0, input.limit);
  const results = input.edgeKinds ? relationshipResults : matchedNodes;
  const hasMore = input.searchResult?.hasMore === true;
  const reachedOffset = input.searchResult?.reachedOffset ?? input.offset;
  return {
    schemaVersion: '1.0.0',
    workspaceId: input.workspaceId,
    graphFingerprint,
    retrievalMethod: 'source_graph_lexical',
    queryFingerprint: fingerprint({
      query: input.query,
      nodeKinds: input.nodeKinds ?? [],
      edgeKinds: input.edgeKinds ?? [],
      locatorPrefix: input.locatorPrefix,
      limit: input.limit,
      offset: input.offset
    }),
    total: reachedOffset + results.length + (hasMore ? 1 : 0),
    limit: input.limit,
    offset: input.offset,
    reachedOffset,
    offsetIncomplete: input.searchResult?.offsetIncomplete === true,
    continuationCursor: input.searchResult?.continuationCursor ?? null,
    truncated: input.searchResult?.truncated === true,
    hasMore,
    omittedCount: hasMore ? 1 : 0,
    results
  };
}

function relationshipSearchResult(relationship, nativeNodes, ids, workspaceId) {
  const source = nativeNodes.get(relationship.fromNodeId);
  const target = nativeNodes.get(relationship.toNodeId);
  if (!source || !target) return null;
  const edge = sourceGraphEdge(nativeStructuralRelationship(relationship), ids, workspaceId);
  const sourceNode = sourceGraphNode(nativeStructuralNode(source), ids, workspaceId);
  const targetNode = sourceGraphNode(nativeStructuralNode(target), ids, workspaceId);
  return {
    resultType: 'edge',
    id: edge.id,
    kind: edge.kind,
    locator: edge.locator,
    fromNodeId: edge.fromNodeId,
    toNodeId: edge.toNodeId,
    fromLabel: sourceNode.label,
    toLabel: targetNode.label,
    toLocator: targetNode.locator,
    toSymbolKind: targetNode.symbolKind,
    score: relationship.confidence,
    reasonCodes: ['native_index_relationship_match']
  };
}

async function queryNativeSearchPage({ provider, root, workspaceId, query, locator, locatorPrefix, limit, offset }) {
  const targetCount = offset + limit + 1;
  const matches = [];
  const seenCursors = new Set();
  const maxPageCalls = 8;
  const controller = new AbortController();
  const deadlineTimer = setTimeout(() => controller.abort(), 1_500);
  let pageCalls = 0;
  let cursor = null;
  let lastResult = null;
  try {
    while (matches.length < targetCount && pageCalls < maxPageCalls && !controller.signal.aborted) {
      const remaining = targetCount - matches.length;
      pageCalls += 1;
      let result;
      try {
        result = await provider.queryIndex({
          root,
          workspaceId,
          kind: 'search',
          limit: Math.min(100, Math.max(limit, remaining)),
          ...(query ? { query } : {}),
          ...(locator ? { locator } : {}),
          ...(cursor ? { cursor } : {}),
          signal: controller.signal
        });
      } catch (error) {
        if (controller.signal.aborted) break;
        throw error;
      }
      lastResult = result;
      matches.push(...(result.results ?? []).filter((item) => (
        !locatorPrefix || item.locator?.startsWith(normalizeLocator(locatorPrefix))
      )));
      if (!result.nextCursor || seenCursors.has(result.nextCursor)) break;
      seenCursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
  } finally {
    clearTimeout(deadlineTimer);
  }
  const walkStopped = controller.signal.aborted
    || (pageCalls >= maxPageCalls && Boolean(lastResult?.nextCursor));
  const offsetIncomplete = matches.length <= offset
    && Boolean(lastResult?.truncated || lastResult?.nextCursor || walkStopped);
  const page = matches.slice(offset, offset + limit);
  const hasMore = matches.length > offset + page.length || Boolean(lastResult?.nextCursor) || (walkStopped && matches.length < targetCount);
  return {
    ...(lastResult ?? {}),
    results: page,
    truncated: Boolean(lastResult?.truncated || hasMore),
    hasMore,
    offsetIncomplete,
    reachedOffset: Math.min(offset, matches.length),
    continuationCursor: offsetIncomplete ? lastResult?.nextCursor ?? cursor : null
  };
}

function impactProjection(input, ids, graphFingerprint) {
  if (!input.changedLocators.length) return null;
  const entries = input.impactResults ?? [];
  const results = uniqueById(entries.flatMap(({ result }) => result?.results ?? []), input.limit);
  const relationships = uniqueById(entries.flatMap(({ result }) => result?.relationships ?? []), input.limit);
  return {
    schemaVersion: '1.0.0',
    workspaceId: input.workspaceId,
    graphFingerprint,
    changedLocators: input.changedLocators,
    representedChangedLocators: entries
      .filter(({ result }) => (result?.results ?? []).length > 0)
      .map(({ locator }) => locator),
    depth: input.depth,
    impactedNodeIds: results.map((item) => ids.node.get(item.id)).filter(Boolean),
    impactedEdgeIds: relationships.map((item) => ids.edge.get(item.id)).filter(Boolean),
    impactedEdgeKindCounts: countBy(relationships.map((item) => ({ kind: sourceGraphEdgeKind(item.kind) })), 'kind'),
    affectedSymbols: results.filter((item) => !NODE_KINDS.has(item.kind)).map((item) => {
      const node = sourceGraphNode(nativeStructuralNode(item), ids, input.workspaceId);
      return { nodeId: node.id, name: node.label, locator: node.locator, symbolKind: node.symbolKind ?? 'function' };
    })
  };
}

function traceProjection(input, ids, graphFingerprint) {
  if (!input.startName) return null;
  const nativeNodes = input.traceResult?.results ?? [];
  const nativeRelationships = input.traceResult?.relationships ?? [];
  const start = nativeNodes.find((node) => node.label === input.startName) ?? nativeNodes[0] ?? null;
  const startNodeIds = start ? [ids.node.get(start.id)].filter(Boolean) : [];
  return {
    schemaVersion: '1.0.0',
    workspaceId: input.workspaceId,
    graphFingerprint,
    retrievalMethod: 'source_graph_trace',
    startNodeIds,
    direction: ['inbound', 'outbound', 'both'].includes(input.direction) ? input.direction : 'outbound',
    edgeKinds: ['calls'],
    depth: input.depth,
    limit: input.limit,
    paths: start ? tracePaths({
      start,
      nodes: nativeNodes,
      relationships: nativeRelationships,
      ids,
      direction: input.direction,
      depth: input.depth,
      limit: input.limit,
      locatorPrefix: input.locatorPrefix
    }) : []
  };
}

function tracePaths({ start, nodes, relationships, ids, direction, depth, limit, locatorPrefix = null }) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const adjacency = new Map();
  for (const relationship of relationships) {
    if (!['calls', 'references'].includes(sourceGraphEdgeKind(relationship.kind))) continue;
    if (direction === 'outbound' || direction === 'both') {
      const items = adjacency.get(relationship.fromNodeId) ?? [];
      items.push({ relationship, nextId: relationship.toNodeId });
      adjacency.set(relationship.fromNodeId, items);
    }
    if (direction === 'inbound' || direction === 'both') {
      const items = adjacency.get(relationship.toNodeId) ?? [];
      items.push({ relationship, nextId: relationship.fromNodeId });
      adjacency.set(relationship.toNodeId, items);
    }
  }
  const queue = [{ nodeIds: [start.id], relationships: [] }];
  const paths = [];
  const seen = new Set([`${start.id}:0`]);
  while (queue.length && paths.length < limit) {
    const current = queue.shift();
    if (current.relationships.length >= depth) continue;
    const currentId = current.nodeIds.at(-1);
    for (const step of adjacency.get(currentId) ?? []) {
      if (current.nodeIds.includes(step.nextId)) continue;
      const terminal = nodeById.get(step.nextId);
      if (!terminal) continue;
      if (locatorPrefix && !terminal.locator?.startsWith(normalizeLocator(locatorPrefix))) continue;
      const nodeIds = [...current.nodeIds, step.nextId];
      const pathRelationships = [...current.relationships, step.relationship];
      const key = `${step.nextId}:${pathRelationships.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      paths.push({
        depth: pathRelationships.length,
        nodeIds: nodeIds.map((id) => ids.node.get(id)).filter(Boolean),
        edgeIds: pathRelationships.map((relationship) => ids.edge.get(relationship.id)).filter(Boolean),
        edgeKinds: pathRelationships.map((relationship) => sourceGraphEdgeKind(relationship.kind)),
        edgeLocators: pathRelationships.map((relationship) => relationship.locator).filter(Boolean),
        terminalNodeId: ids.node.get(terminal.id),
        terminalLabel: safeLabel(terminal.label),
        ...(terminal.locator ? { terminalLocator: terminal.locator } : {}),
        terminalKind: sourceGraphNodeKind(terminal.kind),
        ...(sourceGraphNodeKind(terminal.kind) === 'symbol' ? { terminalSymbolKind: sourceGraphSymbolKind(terminal.kind) } : {})
      });
      queue.push({ nodeIds, relationships: pathRelationships });
      if (paths.length >= limit) break;
    }
  }
  return paths;
}

function coverageProjection(status, result) {
  const omittedFiles = diagnosticCount(status, 'source_index_files_omitted');
  const omittedNodes = diagnosticCount(status, 'source_index_nodes_omitted');
  const omittedEdges = diagnosticCount(status, 'source_index_edges_omitted');
  const reasonCodes = [
    ...(omittedFiles ? ['file_budget_reached'] : []),
    ...(omittedNodes ? ['node_budget_reached'] : []),
    ...(omittedEdges ? ['edge_budget_reached'] : [])
  ];
  return {
    status: reasonCodes.length || result.state === 'partial' ? 'partial' : 'complete',
    representedFileCount: status.summary.fileCount,
    representedJsTsLocators: [],
    skippedFileCount: omittedFiles,
    skippedLocators: [],
    oversizedFileCount: 0,
    oversizedLocators: [],
    unsupportedFileCount: 0,
    unsupportedExtensions: [],
    representedNodeCount: Math.min(20_000, status.summary.nodeCount),
    omittedNodeCount: omittedNodes,
    representedEdgeCount: Math.min(50_000, status.summary.edgeCount),
    omittedEdgeCount: omittedEdges,
    maxFilesReached: omittedFiles > 0,
    reasonCodes
  };
}

function diagnosticsProjection(result) {
  return (result.diagnostics ?? []).slice(0, 32).map((diagnostic) => ({
    locator: INDEX_LOCATOR,
    code: diagnostic.code
  }));
}

function sourceGraphNode(node, ids, workspaceId) {
  const kind = sourceGraphNodeKind(node.kind);
  const symbolKind = kind === 'symbol' ? sourceGraphSymbolKind(node.kind) : null;
  return {
    id: ids.node.get(node.id),
    workspaceId,
    kind,
    label: safeLabel(node.label),
    ...(node.locator ? { locator: node.locator } : {}),
    ...(symbolKind ? { symbolKind } : {})
  };
}

function sourceGraphEdge(edge, ids, workspaceId) {
  return {
    id: ids.edge.get(edge.id),
    workspaceId,
    kind: sourceGraphEdgeKind(edge.kind),
    fromNodeId: ids.node.get(edge.fromNodeId),
    toNodeId: ids.node.get(edge.toNodeId),
    ...(edge.locator ? { locator: edge.locator } : {}),
    confidence: edge.confidence
  };
}

function nodeReference(node, ids, reasonCodes = []) {
  const mapped = sourceGraphNode(node, ids, 'ws_local');
  return {
    nodeId: mapped.id,
    label: mapped.label,
    locator: mapped.locator,
    symbolKind: mapped.symbolKind ?? 'function',
    reasonCodes
  };
}

function hotspotReference(node, ids, degree) {
  const mapped = sourceGraphNode(node, ids, 'ws_local');
  const counts = degree.get(node.id) ?? { inbound: 0, outbound: 0, total: 0 };
  return {
    nodeId: mapped.id,
    label: mapped.label,
    locator: mapped.locator,
    symbolKind: mapped.symbolKind ?? 'function',
    inbound: counts.inbound,
    outbound: counts.outbound,
    total: counts.total,
    reasonCodes: ['relationship_hub']
  };
}

function createIdMaps(nodes, edges) {
  const node = new Map(nodes.map((item) => [item.id, mappedId('sgnode', item.id, 32)]));
  const edge = new Map(edges.map((item) => [item.id, mappedId('sgedge', item.id, 32)]));
  return { node, edge, nodeReverse: new Map([...node].map(([nativeId, publicId]) => [publicId, nativeId])) };
}

function nodeDegrees(relationships) {
  const degree = new Map();
  for (const relationship of relationships) {
    const from = degree.get(relationship.fromNodeId) ?? { inbound: 0, outbound: 0, total: 0 };
    from.outbound += 1;
    from.total += 1;
    degree.set(relationship.fromNodeId, from);
    const to = degree.get(relationship.toNodeId) ?? { inbound: 0, outbound: 0, total: 0 };
    to.inbound += 1;
    to.total += 1;
    degree.set(relationship.toNodeId, to);
  }
  return degree;
}

function uniqueById(items, limit) {
  const unique = new Map();
  for (const item of items) {
    if (!item || unique.has(item.id)) continue;
    unique.set(item.id, item);
    if (unique.size >= limit) break;
  }
  return [...unique.values()];
}

function diagnosticCount(result, code) {
  return result?.diagnostics?.find((item) => item.code === code)?.count ?? 0;
}

function countBy(items, key) {
  const counts = {};
  for (const item of items) counts[item[key]] = (counts[item[key]] ?? 0) + 1;
  return counts;
}

function sourceGraphNodeKind(kind) {
  if (kind === 'file') return 'file';
  if (['module', 'package', 'namespace'].includes(kind)) return 'module';
  return 'symbol';
}

function sourceGraphSymbolKind(kind) {
  return SYMBOL_KINDS.has(kind) ? kind : 'function';
}

function sourceGraphEdgeKind(kind) {
  return EDGE_KINDS.has(kind) ? kind : 'references';
}

function safeGroupPrefix(value) {
  const parts = String(value ?? '').replace(/^workspace:\/\//u, '').split('/').filter(Boolean).slice(0, 3);
  return parts.join('/') || 'workspace';
}

function safeLabel(value) {
  const normalized = String(value ?? '')
    .replace(/sentinel/giu, 'marker')
    .replace(/[^A-Za-z0-9_$@~./#*+,\[\]-]+/gu, '_')
    .slice(0, 240);
  return normalized || 'unknown';
}

function normalizeLocator(value) {
  const normalized = String(value ?? '').trim();
  return normalized.startsWith('workspace://') ? normalized : `workspace://${normalized.replace(/^\/+|\/+$/gu, '')}`;
}

function mappedId(prefix, value, length) {
  return `${prefix}_${createHash('sha256').update(String(value)).digest('hex').slice(0, length)}`;
}

function fingerprint(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function normalizeWorkspaceId(value) {
  const normalized = String(value ?? '').trim();
  if (!SOURCE_GRAPH_WORKSPACE_ID_RE.test(normalized)) throw new Error('source_graph_preview_workspace_invalid');
  return normalized;
}

function normalizeChangedLocators(values) {
  const list = values === null || values === undefined || values === ''
    ? []
    : Array.isArray(values) ? values : String(values).split(',');
  const locators = [...new Set(list.map((value) => normalizeWorkspaceLocator(value, { stripFragment: true })))].sort();
  if (locators.length > MAX_CHANGED_LOCATORS) throw new Error('changed_context_too_many_locators');
  return locators;
}

function normalizeKinds(values, allowed, code) {
  if (values === null || values === undefined || values === '') return null;
  const list = Array.isArray(values) ? values : String(values).split(',');
  const normalized = list.map((item) => String(item).trim()).filter(Boolean);
  for (const item of normalized) if (!allowed.has(item)) throw new Error(`${code}:${item}`);
  return normalized.length ? normalized : null;
}

function normalizeWorkspaceLocator(value, options = undefined) {
  try {
    return normalizeSourceGraphWorkspaceLocator(value, options);
  } catch {
    throw new Error('source_graph_preview_locator_invalid');
  }
}

function isSourceGraphLocator(locator) {
  const source = String(locator).replace(/^workspace:\/\//u, '').split('#', 1)[0].toLowerCase();
  const name = source.split('/').at(-1);
  return name === 'pyproject.toml' || name === 'cmakelists.txt' || SOURCE_GRAPH_EXTENSIONS.some((extension) => source.endsWith(extension));
}

function safeErrorCode(value) {
  const code = String(typeof value === 'string' ? value : value?.message ?? 'source_graph_unavailable')
    .split(':')[0]
    .replace(/[^A-Za-z0-9_]/gu, '_')
    .replace(/_+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .toLowerCase();
  return /^[a-z][a-z0-9_]{0,35}$/u.test(code) ? code : 'source_graph_unavailable';
}

function safeDiagnosticCode(value) {
  const normalized = String(value ?? 'source_graph_unavailable')
    .replace(/[^A-Za-z0-9_:-]/gu, '_')
    .replace(/_+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .toLowerCase()
    .slice(0, 64);
  return /^[a-z][a-z0-9_:-]*$/u.test(normalized) ? normalized : 'source_graph_unavailable';
}

function sourceGraphSafeguards() {
  return {
    dryRun: true,
    persisted: false,
    canonicalStateMutated: false,
    localFilesWritten: 0,
    modelCalls: 0,
    networkCalls: 0,
    externalAdaptersEnabled: 0,
    externalWritesEnabled: false,
    graphDatabaseUsed: false,
    rawBodyIncluded: false,
    sourceSlicesRead: false
  };
}

function boundedInteger(value, minimum, maximum, code) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new Error(code);
  return number;
}
