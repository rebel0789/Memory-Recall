import { createHash } from 'node:crypto';
import { estimateTokens } from '../../context-compiler/src/index.mjs';

export const NATIVE_INDEX_LANGUAGES = Object.freeze([
  'c', 'cpp', 'csharp', 'dart', 'go', 'java', 'javascript', 'kotlin',
  'php', 'python', 'ruby', 'rust', 'swift', 'typescript'
]);

const PREVIEW_VERSION = 'oaf-source-graph-preview-1.0.0';
const INDEX_LOCATOR = 'workspace://.local/source-index/index.v1.sqlite';
const NODE_KINDS = new Set(['file', 'module', 'package', 'namespace']);
const SYMBOL_KINDS = new Set(['class', 'function', 'method', 'interface', 'type']);
const EDGE_KINDS = new Set(['contains', 'defined_in', 'imports', 'exports', 'references', 'calls']);

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
    kind: 'native-persistent-index-preview',
    engine: 'memory-recall-native',
    indexLocator: result.indexLocator,
    activeGeneration: result.activeGeneration,
    freshness: result.freshness,
    previewOnly: true,
    publicDefaultChanged: false
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
  const impactResult = normalizedChanged[0]
    ? await provider.queryIndex({ root, workspaceId, kind: 'impact', locator: normalizeLocator(normalizedChanged[0]), depth: boundedDepth, limit: boundedLimit })
    : null;
  return nativePreviewPayload({
    status: status ?? communityResult,
    communityResult,
    architecture,
    searchResult,
    neighborhood,
    impactResult,
    workspaceId,
    query: normalizedQuery,
    changedLocators: normalizedChanged.map(normalizeLocator),
    locatorPrefix,
    direction,
    limit: boundedLimit,
    offset: boundedOffset,
    depth: boundedDepth,
    sampleLimit: boundedSampleLimit,
    generatedAt
  });
}

function nativePreviewPayload(input) {
  const { architecture, communityResult, status, workspaceId, sampleLimit, generatedAt } = input;
  const nativeNodes = uniqueById([
    ...architecture.nodes,
    ...(input.searchResult?.results ?? []).map(nativeStructuralNode),
    ...(input.neighborhood?.results ?? []).map(nativeStructuralNode),
    ...(input.impactResult?.results ?? []).map(nativeStructuralNode)
  ], 200);
  const nativeRelationships = uniqueById([
    ...architecture.relationships,
    ...(input.neighborhood?.relationships ?? []).map(nativeStructuralRelationship),
    ...(input.impactResult?.relationships ?? []).map(nativeStructuralRelationship)
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
  const hotspots = architecture.hotspots.slice(0, 25).map((node) => hotspotReference(node, ids, degree));
  const coverage = coverageProjection(status, communityResult);
  const diagnostics = diagnosticsProjection(status);
  const focusNativeIds = new Set([
    ...(input.neighborhood?.results ?? []),
    ...(input.impactResult?.results ?? [])
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
  for (const community of processCommunities(architecture, ids, changedLocators)) {
    groupByCommunity.set(community.nativeId, community.group);
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
    groups: [...groupByCommunity.values()].slice(0, 12),
    processes: processProjection(architecture, ids),
    relations: [...relations.values()].sort((a, b) => b.count - a.count || `${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`)).slice(0, 20).map((relation) => {
      const source = groupByCommunity.get(relation.from);
      const target = groupByCommunity.get(relation.to);
      return {
        id: mappedId('sgrelation', `${relation.from}:${relation.to}`, 24),
        sourceGroupId: source.id,
        targetGroupId: target.id,
        sourcePrefix: source.prefix,
        targetPrefix: target.prefix,
        count: relation.count,
        edgeKindCounts: relation.edgeKindCounts
      };
    })
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
  return architecture.groups.slice(0, 12).map((community) => {
    const prefix = safeGroupPrefix(community.pathPrefix);
    const original = architecture.groups.find((item) => item.id === community.id);
    const nodeIds = original?.sampleNodeIds ?? [];
    const members = architecture.nodes.filter((node) => nodeIds.includes(node.id) || node.locator?.startsWith(`${normalizeLocator(prefix)}/`));
    const entryPoints = architecture.entryPoints
      .filter((node) => members.some((member) => member.id === node.id))
      .slice(0, 2)
      .map((node) => nodeReference(node, ids, ['entry_point']));
    return {
      nativeId: community.id,
      nodeIds: members.map((node) => node.id),
      group: {
        id: mappedId('sggroup', community.id, 24),
        prefix,
        fileCount: members.filter((node) => node.kind === 'file').length,
        symbolCount: members.filter((node) => !NODE_KINDS.has(node.kind)).length,
        changedFileCount: changedLocators.filter((locator) => locator.startsWith(`workspace://${prefix}`)).length,
        entryPoints
      }
    };
  });
}

function searchProjection(input, ids, graphFingerprint) {
  const results = (input.searchResult?.results ?? [])
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
    });
  const hasMore = input.searchResult?.hasMore === true;
  const reachedOffset = input.searchResult?.reachedOffset ?? input.offset;
  return {
    schemaVersion: '1.0.0',
    workspaceId: input.workspaceId,
    graphFingerprint,
    retrievalMethod: 'source_graph_lexical',
    queryFingerprint: fingerprint({ query: input.query, locatorPrefix: input.locatorPrefix, limit: input.limit, offset: input.offset }),
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
  const results = input.impactResult?.results ?? [];
  const relationships = input.impactResult?.relationships ?? [];
  return {
    schemaVersion: '1.0.0',
    workspaceId: input.workspaceId,
    graphFingerprint,
    changedLocators: input.changedLocators,
    representedChangedLocators: results.length ? [input.changedLocators[0]] : [],
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
  const startNodeIds = (input.searchResult?.results ?? []).slice(0, 1).map((item) => ids.node.get(item.id)).filter(Boolean);
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
    paths: []
  };
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

function boundedInteger(value, minimum, maximum, code) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new Error(code);
  return number;
}
