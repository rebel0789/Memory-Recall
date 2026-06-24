import path from 'node:path';
import {
  buildJsTsSourceGraph,
  mapSourceGraphDiffImpact,
  searchSourceGraph,
  traceSourceGraph
} from '../../../providers/native/context-candidate-ast-code/src/index.mjs';

const PREVIEW_VERSION = 'oaf-source-graph-preview-1.0.0';
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
  maxFileBytes = 128 * 1024,
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
  const graph = await buildJsTsSourceGraph({
    root,
    workspaceId: safeWorkspaceId,
    maxFiles: boundedMaxFiles,
    maxFileBytes: boundedMaxFileBytes,
    clock: () => generatedAt
  });
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
  return [...new Set(list.map((item) => normalizeWorkspaceLocator(item)).filter(Boolean))].sort();
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
