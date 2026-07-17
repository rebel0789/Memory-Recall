import { estimateTokens, hashRef, stableStringify } from '../../context-compiler/src/index.mjs';
import { validateJsonSchema } from '../../protocol/src/schema-validator.mjs';
import {
  normalizeSourceGraphWorkspaceLocator,
  SOURCE_GRAPH_WORKSPACE_ID_RE
} from '../../protocol/src/source-graph-locator.mjs';
import sourceGraphSchema from '../../protocol/schemas/source-graph.schema.json' with { type: 'json' };
import {
  buildJsTsSourceGraph,
  mapSourceGraphDiffImpact,
  rankArchitectureNodes,
  searchSourceGraph,
  sanitizeSourceGraphPublicOutput,
  traceSourceGraph
} from '../../../providers/native/context-candidate-ast-code/src/index.mjs';
import { buildSourceGraphFocus, buildSourceGraphOrientation } from './orientation.mjs';

export { buildSourceGraphFocus, buildSourceGraphOrientation };
export { compareSourceGraphCompatibility, translateCodeIntelligenceGraph } from './native-compatibility.mjs';
export {
  NATIVE_INDEX_LANGUAGES,
  buildNativeIndexArchitecture,
  buildNativeIndexSourceGraphPreview,
  nativeIndexReadyForAutomaticRead,
  nativeIndexSource,
  nativeStructuralNode,
  nativeStructuralRelationship
} from './native-index-projection.mjs';
export { createSourceGraphSnapshotService } from './snapshot-service.mjs';
export {
  DEFAULT_SOURCE_GRAPH_INDEX_PATH,
  buildPersistentSourceGraphIndex,
  loadPersistentSourceGraphIndex,
  readPersistentSourceGraphIndexStatus,
  refreshPersistentSourceGraphIndex
} from './index-store.mjs';
export {
  buildArchitectureIntelligence,
  buildCodeContextIntelligence,
  buildCodeDependenciesIntelligence,
  buildCodeRoutesIntelligence,
  buildCodeSearchIntelligence,
  buildCodeTraceIntelligence,
  buildSourceGraphIntelligence,
  readSourceGraphIndexStatus
} from './intelligence.mjs';

const PREVIEW_VERSION = 'oaf-source-graph-preview-1.0.0';
export const DEFAULT_SOURCE_GRAPH_PREVIEW_MAX_FILE_BYTES = 512 * 1024;
export const DEFAULT_SOURCE_GRAPH_PREVIEW_MAX_FILES = 1000;
const MAX_CHANGED_LOCATORS = 16;
const NODE_KINDS = new Set(['file', 'chunk', 'symbol', 'module']);
const EDGE_KINDS = new Set(['contains', 'defined_in', 'imports', 'exports', 'references', 'calls']);
const TRACE_DIRECTIONS = new Set(['outbound', 'inbound', 'both']);
const VALIDATED_PUBLIC_GRAPHS = new WeakMap();
const PREVIEW_DERIVATIONS = new WeakMap();
const FULL_GRAPH_TOKEN_ESTIMATES = new WeakMap();
const MAX_DERIVATIONS_PER_GRAPH = 32;

export async function buildSourceGraphPreview({
  root,
  workspaceId = 'ws_local',
  query = '',
  startName = null,
  startNodeId = null,
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
  maxFiles = DEFAULT_SOURCE_GRAPH_PREVIEW_MAX_FILES,
  maxFileBytes = DEFAULT_SOURCE_GRAPH_PREVIEW_MAX_FILE_BYTES,
  sourceGraph = null,
  snapshotService = null,
  refresh = false,
  clock = () => new Date().toISOString()
} = {}) {
  if (typeof root !== 'string' || !root) throw new Error('source_graph_preview_root_required');
  const safeWorkspaceId = normalizeWorkspaceId(workspaceId);
  const boundedLimit = boundedInteger(limit, 'source_graph_preview_limit_invalid', 1, 100);
  const boundedOffset = boundedInteger(offset, 'source_graph_preview_offset_invalid', 0, 10_000);
  const boundedDepth = boundedInteger(depth, 'source_graph_preview_depth_invalid', 1, 5);
  const boundedSampleLimit = boundedInteger(sampleLimit, 'source_graph_preview_sample_limit_invalid', 1, 50);
  const boundedMaxFiles = boundedInteger(maxFiles, 'source_graph_preview_max_files_invalid', 1, 1000);
  const boundedMaxFileBytes = boundedInteger(maxFileBytes, 'source_graph_preview_max_file_bytes_invalid', 1024, 1024 * 1024);
  const normalizedChangedLocators = normalizeChangedLocators(changedLocators);
  const normalizedLocatorPrefix = locatorPrefix ? normalizeLocatorPrefix(locatorPrefix) : null;
  const normalizedNodeKinds = normalizeKinds(nodeKinds, NODE_KINDS, 'source_graph_preview_node_kind_invalid');
  const normalizedEdgeKinds = normalizeKinds(edgeKinds, EDGE_KINDS, 'source_graph_preview_edge_kind_invalid');
  if (!TRACE_DIRECTIONS.has(direction)) throw new Error(`source_graph_preview_direction_invalid:${direction}`);

  const generatedAt = clock();
  let graph;
  let publicGraph;
  let snapshot;
  try {
    snapshot = sourceGraph
      ? {
          graph: sourceGraph,
          status: 'fresh',
          reuse: 'cold',
          reason: null,
          generation: 0,
          validationMode: 'none',
          buildDurationMs: null,
          builtAt: sourceGraph.builtAt
        }
      : snapshotService
      ? await snapshotService.getSnapshot({
          root,
          workspaceId: safeWorkspaceId,
          maxFiles: boundedMaxFiles,
          maxFileBytes: boundedMaxFileBytes,
          refresh: Boolean(refresh)
        })
      : {
          graph: await buildJsTsSourceGraph({
            root,
            workspaceId: safeWorkspaceId,
            maxFiles: boundedMaxFiles,
            maxFileBytes: boundedMaxFileBytes,
            clock: () => generatedAt
          }),
          status: 'fresh',
          reuse: 'cold',
          reason: null,
          generation: 0,
          validationMode: 'none',
          buildDurationMs: null,
          builtAt: generatedAt
        };
    graph = snapshot.graph;
    publicGraph = assertFacadeSafeSourceGraph(graph);
  } catch (error) {
    return unavailableSourceGraphPreview({
      workspaceId: safeWorkspaceId,
      generatedAt,
      query,
      normalizedChangedLocators,
      normalizedNodeKinds,
      normalizedEdgeKinds,
      labelPattern,
      normalizedLocatorPrefix,
      limit: boundedLimit,
      offset: boundedOffset,
      depth: boundedDepth,
      sampleLimit: boundedSampleLimit,
      errorCode: safeSourceGraphErrorCode(error)
    });
  }
  const derivationKey = stableStringify({
    query: String(query ?? ''),
    startName,
    startNodeId,
    changedLocators: normalizedChangedLocators,
    nodeKinds: normalizedNodeKinds,
    edgeKinds: normalizedEdgeKinds,
    labelPattern,
    locatorPrefix: normalizedLocatorPrefix,
    direction,
    limit: boundedLimit,
    offset: boundedOffset,
    depth: boundedDepth,
    sampleLimit: boundedSampleLimit
  });
  const derivations = previewDerivationsFor(graph);
  let derived = derivations.get(derivationKey);
  if (!derived) {
    const ranking = rankArchitectureNodes(publicGraph, {
      changedLocators: normalizedChangedLocators,
      query,
      limit: 25
    });
    const search = searchSourceGraph(publicGraph, {
      query,
      nodeKinds: normalizedNodeKinds,
      edgeKinds: normalizedEdgeKinds,
      labelPattern,
      locatorPrefix: normalizedLocatorPrefix,
      limit: boundedLimit,
      offset: boundedOffset
    });
    const trace = startName || startNodeId
      ? traceSourceGraph(publicGraph, {
        startName,
        startNodeId,
        edgeKinds: normalizedEdgeKinds?.length ? normalizedEdgeKinds : ['calls'],
        locatorPrefix: normalizedLocatorPrefix,
        direction,
        depth: boundedDepth,
        limit: boundedLimit
      })
      : null;
    const impact = normalizedChangedLocators.length
      ? mapSourceGraphDiffImpact(publicGraph, {
        changedLocators: normalizedChangedLocators,
        depth: boundedDepth,
        limit: boundedLimit
      })
      : null;
    const orientation = buildSourceGraphOrientation(publicGraph, {
      changedLocators: normalizedChangedLocators,
      entryPoints: ranking.entryPoints
    });
    const focusRequested = Boolean(
      String(query ?? '').trim()
      || startName
      || startNodeId
      || normalizedChangedLocators.length
      || normalizedLocatorPrefix
    );
    const focus = buildSourceGraphFocus(publicGraph, {
      seedNodeIds: focusRequested ? sourceGraphFocusSeedIds({ search, trace, impact }) : [],
      locatorPrefix: focusRequested ? normalizedLocatorPrefix : null
    });
    derived = Object.freeze({
      search,
      trace,
      impact,
      orientation,
      focus,
      compact: compactGraph(graph, boundedSampleLimit, ranking, publicGraph)
    });
    rememberPreviewDerivation(derivations, derivationKey, derived);
  }
  const { search, trace, impact, orientation, focus, compact } = derived;

  return Object.freeze({
    schemaVersion: '1.0.0',
    previewVersion: PREVIEW_VERSION,
    workspaceId: safeWorkspaceId,
    generatedAt,
    graph: compact,
    search,
    trace,
    impact,
    orientation,
    focus,
    snapshot: sourceGraphPreviewSnapshot(snapshot),
    measurements: sourceGraphPreviewMeasurements({ graph, compact, search, trace, impact, orientation, focus, snapshot }),
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

function compactGraph(graph, sampleLimit, ranking = null, publicGraph = sanitizeSourceGraphPublicOutput(graph)) {
  const summary = ranking
    ? Object.freeze({
      ...graph.summary,
      entryPoints: ranking.entryPoints,
      hotspots: ranking.hotspots,
      deprioritized: ranking.deprioritized
    })
    : graph.summary;
  return Object.freeze({
    schemaVersion: publicGraph.schemaVersion,
    workspaceId: publicGraph.workspaceId,
    graphVersion: publicGraph.graphVersion,
    parserVersion: publicGraph.parserVersion,
    builtAt: publicGraph.builtAt,
    sourceIndexFingerprint: publicGraph.sourceIndexFingerprint,
    graphFingerprint: publicGraph.graphFingerprint,
    summary,
    diagnostics: publicGraph.diagnostics,
    sampleLimit,
    sampleNodes: publicGraph.nodes.slice(0, sampleLimit),
    sampleEdges: publicGraph.edges.slice(0, sampleLimit),
    omittedNodes: Math.max(0, publicGraph.nodes.length - sampleLimit),
    omittedEdges: Math.max(0, publicGraph.edges.length - sampleLimit)
  });
}

function assertFacadeSafeSourceGraph(graph) {
  const cached = VALIDATED_PUBLIC_GRAPHS.get(graph);
  if (cached) return cached;
  if (!validateJsonSchema(sourceGraphSchema, graph).valid) throw new Error('source_graph_preview_graph_invalid');
  const publicOutput = sanitizeSourceGraphPublicOutput(graph);
  if (!publicOutput.completeEnvelope || !publicOutput.diagnosticsComplete) throw new Error('source_graph_preview_graph_invalid');
  if (publicOutput.workspaceId !== graph.workspaceId
    || publicOutput.graphFingerprint !== graph.graphFingerprint
    || publicOutput.sourceIndexFingerprint !== graph.sourceIndexFingerprint
    || publicOutput.nodes.length !== graph.nodes.length
    || publicOutput.edges.length !== graph.edges.length
    || publicOutput.diagnostics.length !== graph.diagnostics.length) throw new Error('source_graph_preview_graph_invalid');
  VALIDATED_PUBLIC_GRAPHS.set(graph, publicOutput);
  return publicOutput;
}

function unavailableSourceGraphPreview({
  workspaceId,
  generatedAt,
  query,
  normalizedChangedLocators,
  normalizedNodeKinds,
  normalizedEdgeKinds,
  labelPattern,
  normalizedLocatorPrefix,
  limit,
  offset,
  depth,
  sampleLimit,
  errorCode
}) {
  const code = safeDiagnosticCode(`source_graph_unavailable:${errorCode}`);
  const graphFingerprint = hashRef(stableStringify({ kind: 'source-graph-unavailable', workspaceId, code }));
  const sourceIndexFingerprint = hashRef(stableStringify({ kind: 'source-index-unavailable', workspaceId, code }));
  const diagnostic = Object.freeze({ locator: 'workspace://__source_graph_preview__', code });
  const search = Object.freeze({
    schemaVersion: '1.0.0',
    workspaceId,
    graphFingerprint,
    retrievalMethod: 'source_graph_lexical',
    queryFingerprint: hashRef(stableStringify({
      query: String(query ?? ''),
      nodeKinds: normalizedNodeKinds ?? [],
      edgeKinds: normalizedEdgeKinds ?? [],
      labelPattern,
      locatorPrefix: normalizedLocatorPrefix,
      limit,
      offset,
      unavailable: true
    })),
    total: 0,
    limit,
    offset,
    hasMore: false,
    omittedCount: 0,
    results: []
  });
  const impact = normalizedChangedLocators.length
    ? Object.freeze({
      schemaVersion: '1.0.0',
      workspaceId,
      graphFingerprint,
      changedLocators: normalizedChangedLocators,
      representedChangedLocators: [],
      depth,
      impactedNodeIds: [],
      impactedEdgeIds: [],
      impactedEdgeKindCounts: {},
      affectedSymbols: []
    })
    : null;
  const compact = Object.freeze({
    schemaVersion: '1.0.0',
    workspaceId,
    graphVersion: 'oaf-native-source-graph-unavailable-1.0.0',
    parserVersion: 'oaf-js-ts-static-unavailable',
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
    sampleLimit,
    sampleNodes: [],
    sampleEdges: [],
    omittedNodes: 0,
    omittedEdges: 0
  });
  const unavailableSnapshot = Object.freeze({
    status: 'unavailable',
    reuse: 'none',
    reason: code,
    generation: 0,
    validationMode: 'none',
    buildDurationMs: null,
    builtAt: null
  });
  return Object.freeze({
    schemaVersion: '1.0.0',
    previewVersion: PREVIEW_VERSION,
    workspaceId,
    generatedAt,
    graph: compact,
    search,
    trace: null,
    impact,
    orientation: Object.freeze({ groups: Object.freeze([]), relations: Object.freeze([]) }),
    focus: Object.freeze({ nodeLimit: 200, edgeLimit: 400, nodes: Object.freeze([]), edges: Object.freeze([]), omittedNodes: 0, omittedEdges: 0 }),
    snapshot: unavailableSnapshot,
    measurements: sourceGraphPreviewMeasurements({
      graph: null,
      compact,
      search,
      trace: null,
      impact,
      orientation: { groups: [], relations: [] },
      focus: { nodeLimit: 200, edgeLimit: 400, nodes: [], edges: [], omittedNodes: 0, omittedEdges: 0 },
      snapshot: unavailableSnapshot
    }),
    safeguards: sourceGraphPreviewSafeguards()
  });
}

function sourceGraphPreviewMeasurements({ graph, compact, search, trace, impact, orientation, focus, snapshot }) {
  const fullGraphTokenEstimate = graph ? fullGraphTokenEstimateFor(graph) : 0;
  const deliveredTokenEstimate = estimateTokens(JSON.stringify({ graph: compact, search, trace, impact, orientation, focus, snapshot: sourceGraphPreviewSnapshot(snapshot) }));
  const omittedTokenEstimate = Math.max(0, fullGraphTokenEstimate - deliveredTokenEstimate);
  return Object.freeze({
    schemaVersion: '1.0.0',
    measurementScope: 'full graph nodes/edges/diagnostics versus delivered preview payload',
    fullGraphTokenEstimate,
    deliveredTokenEstimate,
    omittedTokenEstimate,
    reductionPercent: fullGraphTokenEstimate ? Number(((omittedTokenEstimate / fullGraphTokenEstimate) * 100).toFixed(2)) : 0,
    sourceContentIncluded: false,
    providerBillingClaimed: false
  });
}

function previewDerivationsFor(graph) {
  const cached = PREVIEW_DERIVATIONS.get(graph);
  if (cached) return cached;
  const derivations = new Map();
  PREVIEW_DERIVATIONS.set(graph, derivations);
  return derivations;
}

function rememberPreviewDerivation(derivations, key, value) {
  if (derivations.size >= MAX_DERIVATIONS_PER_GRAPH) derivations.delete(derivations.keys().next().value);
  derivations.set(key, value);
}

function fullGraphTokenEstimateFor(graph) {
  const cached = FULL_GRAPH_TOKEN_ESTIMATES.get(graph);
  if (cached !== undefined) return cached;
  const estimate = estimateTokens(JSON.stringify({
    nodes: graph.nodes,
    edges: graph.edges,
    diagnostics: graph.diagnostics
  }));
  FULL_GRAPH_TOKEN_ESTIMATES.set(graph, estimate);
  return estimate;
}

function sourceGraphPreviewSnapshot(snapshot) {
  const status = ['fresh', 'stale'].includes(snapshot?.status) ? snapshot.status : 'unavailable';
  const reuse = ['cold', 'cache', 'inflight'].includes(snapshot?.reuse) ? snapshot.reuse : 'none';
  const validationMode = ['watcher', 'metadata-scan'].includes(snapshot?.validationMode) ? snapshot.validationMode : 'none';
  const generation = Number.isInteger(snapshot?.generation) && snapshot.generation >= 0 ? snapshot.generation : 0;
  const buildDurationMs = Number.isFinite(snapshot?.buildDurationMs) && snapshot.buildDurationMs >= 0
    ? snapshot.buildDurationMs
    : null;
  const builtAt = snapshot?.builtAt && !Number.isNaN(Date.parse(snapshot.builtAt)) ? snapshot.builtAt : null;
  return Object.freeze({
    status,
    reuse,
    reason: snapshot?.reason ? safeDiagnosticCode(snapshot.reason) : null,
    generation,
    validationMode,
    buildDurationMs,
    builtAt
  });
}

function sourceGraphFocusSeedIds({ search, trace, impact }) {
  const ids = [];
  for (const result of search?.results ?? []) {
    if (result.resultType === 'node') ids.push(result.id);
    else ids.push(result.fromNodeId, result.toNodeId);
  }
  ids.push(...(trace?.startNodeIds ?? []));
  for (const path of trace?.paths ?? []) ids.push(...(path.nodeIds ?? []));
  ids.push(...(impact?.impactedNodeIds ?? []));
  return [...new Set(ids.filter(Boolean))].sort();
}

function sourceGraphPreviewSafeguards() {
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

function safeSourceGraphErrorCode(error) {
  const code = String(error?.message ?? 'source_graph_unavailable')
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

function normalizeWorkspaceId(value) {
  const normalized = String(value ?? '').trim();
  if (!SOURCE_GRAPH_WORKSPACE_ID_RE.test(normalized)) throw new Error('source_graph_preview_workspace_invalid');
  return normalized;
}

function normalizeKinds(values, allowed, code) {
  if (values === null || values === undefined || values === '') return null;
  const list = Array.isArray(values) ? values : String(values).split(',');
  const normalized = list.map((item) => String(item).trim()).filter(Boolean);
  for (const item of normalized) if (!allowed.has(item)) throw new Error(`${code}:${item}`);
  return normalized.length ? normalized : null;
}

function normalizeChangedLocators(values) {
  if (values === null || values === undefined || values === '') return [];
  const list = Array.isArray(values) ? values : String(values).split(',');
  const locators = [...new Set(list.map((item) => normalizeWorkspaceLocator(item, { stripFragment: true })).filter(Boolean))].sort();
  if (locators.length > MAX_CHANGED_LOCATORS) throw new Error('changed_context_too_many_locators');
  return locators;
}

function normalizeLocatorPrefix(value) {
  return normalizeWorkspaceLocator(value);
}

function normalizeWorkspaceLocator(value, options = undefined) {
  try {
    return normalizeSourceGraphWorkspaceLocator(value, options);
  } catch {
    throw new Error('source_graph_preview_locator_invalid');
  }
}

function boundedInteger(value, code, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${code}:${value}`);
  return parsed;
}
