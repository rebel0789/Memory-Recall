import path from 'node:path';
import { hashRef, stableStringify } from '../../context-compiler/src/index.mjs';
import {
  buildJsTsSourceGraph,
  mapSourceGraphDiffImpact,
  searchSourceGraph,
  traceSourceGraph
} from '../../../providers/native/context-candidate-ast-code/src/index.mjs';

const PREVIEW_VERSION = 'oaf-source-graph-preview-1.0.0';
export const DEFAULT_SOURCE_GRAPH_PREVIEW_MAX_FILE_BYTES = 256 * 1024;
const MAX_CHANGED_LOCATORS = 16;
const WORKSPACE_ID = /^[a-z][a-z0-9_-]{0,127}$/u;
const NODE_KINDS = new Set(['file', 'chunk', 'symbol', 'module']);
const EDGE_KINDS = new Set(['contains', 'defined_in', 'imports', 'exports', 'references', 'calls']);
const TRACE_DIRECTIONS = new Set(['outbound', 'inbound', 'both']);
const FORBIDDEN_LOCATOR_PARTS = new Set(['Users', 'private']);

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
  maxFiles = 200,
  maxFileBytes = DEFAULT_SOURCE_GRAPH_PREVIEW_MAX_FILE_BYTES,
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
  try {
    graph = await buildJsTsSourceGraph({
      root,
      workspaceId: safeWorkspaceId,
      maxFiles: boundedMaxFiles,
      maxFileBytes: boundedMaxFileBytes,
      clock: () => generatedAt
    });
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
  const search = searchSourceGraph(graph, {
    query,
    nodeKinds: normalizedNodeKinds,
    edgeKinds: normalizedEdgeKinds,
    labelPattern,
    locatorPrefix: normalizedLocatorPrefix,
    limit: boundedLimit,
    offset: boundedOffset
  });
  const trace = startName || startNodeId
    ? traceSourceGraph(graph, {
      startName,
      startNodeId,
      edgeKinds: normalizedEdgeKinds?.length ? normalizedEdgeKinds : ['calls'],
      direction,
      depth: boundedDepth,
      limit: boundedLimit
    })
    : null;
  const impact = normalizedChangedLocators.length
    ? mapSourceGraphDiffImpact(graph, {
      changedLocators: normalizedChangedLocators,
      depth: boundedDepth,
      limit: boundedLimit
    })
    : null;

  return Object.freeze({
    schemaVersion: '1.0.0',
    previewVersion: PREVIEW_VERSION,
    workspaceId: safeWorkspaceId,
    generatedAt,
    graph: compactGraph(graph, boundedSampleLimit),
    search,
    trace,
    impact,
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

function compactGraph(graph, sampleLimit) {
  return Object.freeze({
    schemaVersion: graph.schemaVersion,
    workspaceId: graph.workspaceId,
    graphVersion: graph.graphVersion,
    parserVersion: graph.parserVersion,
    builtAt: graph.builtAt,
    sourceIndexFingerprint: graph.sourceIndexFingerprint,
    graphFingerprint: graph.graphFingerprint,
    summary: graph.summary,
    diagnostics: graph.diagnostics,
    sampleLimit,
    sampleNodes: graph.nodes.slice(0, sampleLimit),
    sampleEdges: graph.edges.slice(0, sampleLimit),
    omittedNodes: Math.max(0, graph.nodes.length - sampleLimit),
    omittedEdges: Math.max(0, graph.edges.length - sampleLimit)
  });
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
      affectedSymbols: []
    })
    : null;
  return Object.freeze({
    schemaVersion: '1.0.0',
    previewVersion: PREVIEW_VERSION,
    workspaceId,
    generatedAt,
    graph: Object.freeze({
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
    }),
    search,
    trace: null,
    impact,
    safeguards: sourceGraphPreviewSafeguards()
  });
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
  if (!WORKSPACE_ID.test(normalized)) throw new Error('source_graph_preview_workspace_invalid');
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
  const locators = [...new Set(list.map((item) => normalizeWorkspaceLocator(item)).filter(Boolean))].sort();
  if (locators.length > MAX_CHANGED_LOCATORS) throw new Error('changed_context_too_many_locators');
  return locators;
}

function normalizeLocatorPrefix(value) {
  return normalizeWorkspaceLocator(value);
}

function normalizeWorkspaceLocator(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (raw.length > 512 || /\s/u.test(raw) || raw.includes('\\')) throw new Error('source_graph_preview_locator_invalid');
  const withoutHash = raw.split('#')[0];
  const relative = withoutHash.startsWith('workspace://')
    ? withoutHash.slice('workspace://'.length)
    : withoutHash.replace(/^\.\//u, '');
  const parts = relative.split('/').filter(Boolean);
  if (!relative || path.posix.isAbsolute(relative) || relative.startsWith('/') || parts.includes('..')) throw new Error('source_graph_preview_locator_invalid');
  if (parts.some((part) => FORBIDDEN_LOCATOR_PARTS.has(part)) || relative.startsWith('var/folders/')) throw new Error('source_graph_preview_locator_invalid');
  return `workspace://${parts.join('/')}`;
}

function boundedInteger(value, code, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${code}:${value}`);
  return parsed;
}
