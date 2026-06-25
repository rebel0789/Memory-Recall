import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { estimateTokens, hashRef, stableStringify, terms } from '../../../../packages/context-compiler/src/index.mjs';

export const AST_CODE_PROVIDER_VERSION = '1.0.0';
export const AST_CODE_PARSER_VERSION = 'oaf-js-ts-static-1.0.0';

const SOURCE_ID = 'provider:native:context-candidate:ast-code';
const EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', 'out', 'vendor']);
const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_FILES = 200;
const MAX_REFERENCES_PER_CHUNK = 80;
const MAX_CALLS_PER_CHUNK = 40;
const MAX_TARGETS_PER_SYMBOL_NAME = 8;
const MAX_REFERENCE_EDGES_PER_CHUNK = 200;
const MAX_CALL_EDGES_PER_CHUNK = 80;
const CONTROL_FLOW_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'function']);
const JS_KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'default', 'delete', 'do', 'else', 'export', 'extends', 'false', 'finally',
  'for', 'from', 'function', 'if', 'implements', 'import', 'in', 'instanceof',
  'interface', 'let', 'new', 'null', 'of', 'return', 'static', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined',
  'var', 'void', 'while', 'with', 'yield'
]);

export function createNativeAstCodeCandidateSource({
  root = null,
  workspaceId = 'ws_local',
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
  clock = () => new Date().toISOString()
} = {}) {
  return Object.freeze({
    descriptor: () => ({
      schemaVersion: '1.0.0',
      id: SOURCE_ID,
      kind: 'ast-code',
      version: AST_CODE_PROVIDER_VERSION,
      enabled: true,
      methods: ['js_ts_static_chunk'],
      contractVersion: '1.0.0',
      description: 'Workspace-scoped dependency-free JS/TS static code chunk candidate source'
    }),
    health: async () => ({ status: 'healthy' }),
    async query(request, trustedContext = {}) {
      const workspaceRoot = root ?? trustedContext.workspaceRoot;
      if (!workspaceRoot) return { candidates: [] };
      const scan = await scanAstCodeWorkspace({
        root: workspaceRoot,
        workspaceId: request.workspaceId ?? workspaceId,
        maxFileBytes,
        maxFiles,
        clock
      });
      const queryText = [
        request.objective,
        request.step,
        ...(request.requiredEntities ?? [])
      ].filter(Boolean).join(' ');
      const scored = scan.chunks
        .map((chunk) => ({ chunk, score: overlapScore(queryText, chunkSearchText(chunk)) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || a.chunk.locator.localeCompare(b.chunk.locator))
        .slice(0, trustedContext.sourceLimit ?? request.perSourceLimit ?? 10);
      return {
        candidates: scored.map(({ chunk, score }, index) => ({
          record: recordFromChunk(chunk, request.workspaceId ?? workspaceId),
          sourceHit: {
            sourceId: SOURCE_ID,
            sourceKind: 'ast-code',
            sourceVersion: AST_CODE_PROVIDER_VERSION,
            retrievalMethod: 'js_ts_static_chunk',
            localRank: index + 1,
            localScore: Number(Math.max(0, Math.min(1, score)).toFixed(6)),
            reasonCodes: ['ast_code_match'],
            queryFingerprint: trustedContext.queryFingerprint ?? hashRef(stableStringify({ queryText })),
            accessDecisionRef: trustedContext.accessDecisionRef ?? 'poldet_unconfigured',
            retrievedAt: trustedContext.retrievedAt ?? clock()
          }
        }))
      };
    }
  });
}

export async function scanAstCodeWorkspace({
  root,
  workspaceId = 'ws_local',
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
  clock = () => new Date().toISOString()
} = {}) {
  if (typeof root !== 'string' || !root) throw new Error('root is required');
  const rootReal = await realpath(root);
  const diagnostics = [];
  const chunks = [];
  const fileOutlines = [];
  let visitedFiles = 0;
  let maxFilesReached = false;

  function markMaxFilesReached() {
    if (maxFilesReached) return;
    maxFilesReached = true;
    diagnostics.push(diagnostic('workspace://__source_graph_scan__', 'max_files_reached'));
  }

  async function walk(relativeDirectory = '') {
    if (visitedFiles >= maxFiles) {
      markMaxFilesReached();
      return;
    }
    const absoluteDirectory = path.join(rootReal, relativeDirectory);
    const entries = (await readdir(absoluteDirectory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (visitedFiles >= maxFiles) {
        markMaxFilesReached();
        return;
      }
      const relativePath = normalizeRelative(path.join(relativeDirectory, entry.name));
      const absolutePath = path.join(rootReal, relativePath);
      const locator = locatorFor(relativePath);
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) {
        diagnostics.push(diagnostic(locator, 'symlink_skipped'));
        continue;
      }
      if (info.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) await walk(relativePath);
        continue;
      }
      if (!info.isFile() || !EXTENSIONS.has(path.extname(entry.name))) continue;
      const fileReal = await realpath(absolutePath);
      if (!insideRoot(rootReal, fileReal)) {
        diagnostics.push(diagnostic(locator, 'path_escape_skipped'));
        continue;
      }
      const size = info.size ?? (await stat(fileReal)).size;
      if (size > maxFileBytes) {
        diagnostics.push(diagnostic(locator, 'file_too_large'));
        continue;
      }
      visitedFiles += 1;
      const body = await readFile(fileReal, 'utf8');
      const collectedAt = clock();
      const fileChunks = chunksForFile({ relativePath, body, workspaceId, collectedAt });
      chunks.push(...fileChunks);
      fileOutlines.push(fileOutlineFor({ relativePath, body, workspaceId, collectedAt, chunks: fileChunks }));
    }
  }

  await walk();
  const sortedChunks = chunks.sort((a, b) => a.locator.localeCompare(b.locator));
  const sortedFileOutlines = fileOutlines.sort((a, b) => a.locator.localeCompare(b.locator));
  const symbolIndex = buildSymbolIndex({ workspaceId, chunks: sortedChunks, fileOutlines: sortedFileOutlines, indexedAt: clock() });
  const result = {
    schemaVersion: '1.0.0',
    workspaceId,
    parserVersion: AST_CODE_PARSER_VERSION,
    fileCount: visitedFiles,
    chunkCount: sortedChunks.length,
    chunks: sortedChunks,
    fileOutlines: sortedFileOutlines,
    repositoryOutline: repositoryOutlineFor({ workspaceId, fileOutlines: sortedFileOutlines, symbolIndex }),
    contentJournal: sortedFileOutlines.map((file) => ({
      locator: file.locator,
      contentHash: file.contentHash,
      symbolFingerprint: file.symbolFingerprint,
      collectedAt: file.collectedAt
    })),
    symbolIndex,
    diagnostics: diagnostics.sort((a, b) => a.locator.localeCompare(b.locator) || a.code.localeCompare(b.code))
  };
  return Object.freeze({ ...result, scanFingerprint: contentFingerprint(result) });
}

export async function buildJsTsSourceIndex(options = {}) {
  const scan = await scanAstCodeWorkspace(options);
  return Object.freeze({
    schemaVersion: '1.0.0',
    workspaceId: scan.workspaceId,
    parserVersion: scan.parserVersion,
    scanFingerprint: scan.scanFingerprint,
    repositoryOutline: scan.repositoryOutline,
    fileOutlines: scan.fileOutlines,
    contentJournal: scan.contentJournal,
    symbolIndex: scan.symbolIndex,
    diagnostics: scan.diagnostics,
    sourceIndexFingerprint: contentFingerprint({
      repositoryOutline: scan.repositoryOutline,
      fileOutlines: scan.fileOutlines,
      contentJournal: scan.contentJournal,
      symbolIndex: scan.symbolIndex,
      diagnostics: scan.diagnostics
    })
  });
}

export function querySourceIndex(index, { operation, name = null, module = null, locator = null } = {}) {
  if (!index?.symbolIndex) throw new Error('source index is required');
  const symbols = index.symbolIndex.symbols ?? [];
  const references = index.symbolIndex.references ?? [];
  const imports = index.symbolIndex.imports ?? [];
  const exports = index.symbolIndex.exports ?? [];
  const callEdges = index.symbolIndex.callEdges ?? [];
  const normalizedName = name ? safeTag(name) : null;
  const normalizedModule = module ? String(module) : null;
  switch (operation) {
    case 'definition':
    case 'declaration':
    case 'symbol-source':
      return symbols.filter((symbol) => !normalizedName || safeTag(symbol.name) === normalizedName);
    case 'references':
      return references.filter((reference) => !normalizedName || safeTag(reference.targetName) === normalizedName);
    case 'imports':
      return imports.filter((item) => !normalizedModule || item.module === normalizedModule);
    case 'exports':
      return exports.filter((item) => !normalizedName || safeTag(item.name) === normalizedName);
    case 'callers':
      return callEdges.filter((edge) => !normalizedName || safeTag(edge.calleeName) === normalizedName);
    case 'callees':
      return callEdges.filter((edge) => !normalizedName || safeTag(edge.callerName) === normalizedName);
    case 'file-outline':
      return (index.fileOutlines ?? []).filter((file) => !locator || file.locator === locator);
    case 'repository-outline':
      return index.repositoryOutline;
    default:
      throw new Error(`unsupported_source_index_operation:${operation}`);
  }
}

export async function buildJsTsSourceGraph(options = {}) {
  const index = await buildJsTsSourceIndex(options);
  return buildSourceGraphFromIndex(index, { builtAt: safeTimestamp(options.clock) });
}

export function buildSourceGraphFromIndex(index, { builtAt = new Date().toISOString() } = {}) {
  if (!index?.symbolIndex) throw new Error('source index is required');
  const workspaceId = index.workspaceId ?? index.symbolIndex.workspaceId;
  if (!workspaceId) throw new Error('source graph workspaceId is required');
  const nodesById = new Map();
  const edgesById = new Map();
  const fileOutlinesByLocator = new Map((index.fileOutlines ?? []).map((file) => [file.locator, file]));
  const symbolNodeBySymbolId = new Map();

  function addNode(node) {
    const frozen = Object.freeze(node);
    nodesById.set(frozen.id, frozen);
    return frozen;
  }

  function addEdge(edge) {
    if (!nodesById.has(edge.fromNodeId) || !nodesById.has(edge.toNodeId)) return null;
    const frozen = Object.freeze(edge);
    edgesById.set(frozen.id, frozen);
    return frozen;
  }

  function ensureFileNode(locator) {
    const fileLocator = fileLocatorFor(locator);
    const outline = fileOutlinesByLocator.get(fileLocator);
    const id = sourceGraphNodeId('file', fileLocator);
    if (nodesById.has(id)) return nodesById.get(id);
    return addNode(withDefined({
      id,
      workspaceId,
      kind: 'file',
      label: fileLocator.replace(/^workspace:\/\//u, ''),
      locator: fileLocator,
      contentHash: outline?.contentHash,
      sourceSnapshotId: outline?.sourceSnapshotId
    }));
  }

  function ensureChunkNode({ chunkId, locator, contentHash = null, sourceSnapshotId = null }) {
    if (!chunkId || !locator) return null;
    const id = sourceGraphNodeId('chunk', chunkId);
    if (nodesById.has(id)) return nodesById.get(id);
    const fileNode = ensureFileNode(locator);
    const chunkNode = addNode(withDefined({
      id,
      workspaceId,
      kind: 'chunk',
      label: locatorLabel(locator),
      locator,
      sourceRef: chunkId,
      contentHash,
      sourceSnapshotId
    }));
    addEdge(withDefined({
      id: sourceGraphEdgeId('contains', fileNode.id, chunkNode.id, chunkId),
      workspaceId,
      kind: 'contains',
      fromNodeId: fileNode.id,
      toNodeId: chunkNode.id,
      locator,
      sourceRef: chunkId,
      confidence: 1
    }));
    return chunkNode;
  }

  for (const locator of index.symbolIndex.fileLocators ?? index.repositoryOutline?.locators ?? []) ensureFileNode(locator);
  for (const file of index.fileOutlines ?? []) ensureFileNode(file.locator);

  for (const symbol of index.symbolIndex.symbols ?? []) {
    const chunkNode = ensureChunkNode({
      chunkId: symbol.chunkId,
      locator: symbol.locator,
      contentHash: symbol.contentHash,
      sourceSnapshotId: symbol.sourceSnapshotId
    });
    const node = addNode(withDefined({
      id: sourceGraphNodeId('symbol', symbol.id),
      workspaceId,
      kind: 'symbol',
      label: symbol.name,
      locator: symbol.locator,
      sourceRef: symbol.id,
      symbolKind: symbol.kind,
      contentHash: symbol.contentHash,
      sourceSnapshotId: symbol.sourceSnapshotId
    }));
    symbolNodeBySymbolId.set(symbol.id, node);
    if (chunkNode) {
      addEdge(withDefined({
        id: sourceGraphEdgeId('defined_in', node.id, chunkNode.id, symbol.id),
        workspaceId,
        kind: 'defined_in',
        fromNodeId: node.id,
        toNodeId: chunkNode.id,
        locator: symbol.locator,
        sourceRef: symbol.id,
        confidence: 1
      }));
    }
  }

  for (const item of index.symbolIndex.imports ?? []) {
    const chunkNode = ensureChunkNode({ chunkId: item.chunkId, locator: item.locator });
    const moduleNode = addNode(withDefined({
      id: sourceGraphNodeId('module', item.module),
      workspaceId,
      kind: 'module',
      label: item.module,
      sourceRef: item.moduleHash,
      moduleHash: item.moduleHash
    }));
    if (chunkNode) {
      addEdge(withDefined({
        id: sourceGraphEdgeId('imports', chunkNode.id, moduleNode.id, item.id),
        workspaceId,
        kind: 'imports',
        fromNodeId: chunkNode.id,
        toNodeId: moduleNode.id,
        locator: item.locator,
        sourceRef: item.id,
        confidence: 0.9
      }));
    }
  }

  for (const item of index.symbolIndex.exports ?? []) {
    const fileNode = ensureFileNode(item.locator);
    const targetSymbol = (index.symbolIndex.symbols ?? []).find((symbol) => symbol.chunkId === item.chunkId && symbol.name === item.name);
    const targetNode = targetSymbol ? symbolNodeBySymbolId.get(targetSymbol.id) : ensureChunkNode({ chunkId: item.chunkId, locator: item.locator });
    if (targetNode) {
      addEdge(withDefined({
        id: sourceGraphEdgeId('exports', fileNode.id, targetNode.id, item.id),
        workspaceId,
        kind: 'exports',
        fromNodeId: fileNode.id,
        toNodeId: targetNode.id,
        locator: item.locator,
        sourceRef: item.id,
        confidence: 1
      }));
    }
  }

  for (const item of index.symbolIndex.references ?? []) {
    const sourceChunk = ensureChunkNode({ chunkId: item.sourceChunkId, locator: item.sourceLocator });
    const targetNode = symbolNodeBySymbolId.get(item.targetSymbolId);
    if (sourceChunk && targetNode) {
      addEdge(withDefined({
        id: sourceGraphEdgeId('references', sourceChunk.id, targetNode.id, item.id),
        workspaceId,
        kind: 'references',
        fromNodeId: sourceChunk.id,
        toNodeId: targetNode.id,
        locator: item.sourceLocator,
        sourceRef: item.id,
        confidence: 0.75
      }));
    }
  }

  for (const item of index.symbolIndex.callEdges ?? []) {
    const callerNode = symbolNodeBySymbolId.get(item.callerSymbolId);
    const calleeNode = symbolNodeBySymbolId.get(item.calleeSymbolId);
    if (callerNode && calleeNode) {
      addEdge(withDefined({
        id: sourceGraphEdgeId('calls', callerNode.id, calleeNode.id, item.id),
        workspaceId,
        kind: 'calls',
        fromNodeId: callerNode.id,
        toNodeId: calleeNode.id,
        locator: item.sourceLocator,
        sourceRef: item.id,
        confidence: 0.7
      }));
    }
  }

  const nodes = [...nodesById.values()].sort((a, b) => a.id.localeCompare(b.id));
  const edges = [...edgesById.values()].sort((a, b) => a.id.localeCompare(b.id));
  const graph = {
    schemaVersion: '1.0.0',
    workspaceId,
    graphVersion: 'oaf-native-source-graph-1.0.0',
    parserVersion: index.parserVersion ?? index.symbolIndex.parserVersion ?? AST_CODE_PARSER_VERSION,
    builtAt,
    sourceIndexFingerprint: index.sourceIndexFingerprint ?? index.symbolIndex.symbolIndexFingerprint,
    summary: sourceGraphSummary({ nodes, edges }),
    nodes,
    edges,
    diagnostics: [...(index.diagnostics ?? [])].sort((a, b) => a.locator.localeCompare(b.locator) || a.code.localeCompare(b.code))
  };
  return Object.freeze({ ...graph, graphFingerprint: graphContentFingerprint(graph) });
}

export function searchSourceGraph(graph, {
  query = '',
  nodeKinds = null,
  edgeKinds = null,
  labelPattern = null,
  locatorPrefix = null,
  limit = 20,
  offset = 0
} = {}) {
  assertSourceGraph(graph);
  const boundedLimit = boundedInteger(limit, 'source_graph_search_limit', 1, 100);
  const boundedOffset = boundedInteger(offset, 'source_graph_search_offset', 0, 10_000);
  const nodeKindSet = nodeKinds ? new Set(nodeKinds) : null;
  const edgeKindSet = edgeKinds ? new Set(edgeKinds) : null;
  const pattern = labelPattern ? safeRegex(labelPattern, 'source_graph_label_pattern_invalid') : null;
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const queryText = String(query ?? '');
  const queryTerms = terms(queryText);
  const results = [];

  for (const node of graph.nodes) {
    if (nodeKindSet && !nodeKindSet.has(node.kind)) continue;
    if (locatorPrefix && !(node.locator ?? '').startsWith(locatorPrefix)) continue;
    if (pattern && !pattern.test(node.label)) continue;
    const score = graphSearchScore(queryTerms, sourceGraphNodeSearchText(node));
    if (queryTerms.size && score <= 0) continue;
    results.push({
      resultType: 'node',
      id: node.id,
      kind: node.kind,
      label: node.label,
      locator: node.locator,
      score,
      reasonCodes: sourceGraphSearchReasons({ score, pattern, locatorPrefix })
    });
  }

  for (const edge of graph.edges) {
    if (edgeKindSet && !edgeKindSet.has(edge.kind)) continue;
    if (locatorPrefix && !(edge.locator ?? '').startsWith(locatorPrefix)) continue;
    const from = nodeById.get(edge.fromNodeId);
    const to = nodeById.get(edge.toNodeId);
    const score = graphSearchScore(queryTerms, sourceGraphEdgeSearchText(edge, from, to));
    if (queryTerms.size && score <= 0) continue;
    results.push({
      resultType: 'edge',
      id: edge.id,
      kind: edge.kind,
      label: `${from?.label ?? edge.fromNodeId} ${edge.kind} ${to?.label ?? edge.toNodeId}`,
      locator: edge.locator,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      score,
      reasonCodes: sourceGraphSearchReasons({ score, pattern: null, locatorPrefix })
    });
  }

  const sorted = results.sort((a, b) => b.score - a.score || a.resultType.localeCompare(b.resultType) || a.id.localeCompare(b.id));
  const page = sorted.slice(boundedOffset, boundedOffset + boundedLimit);
  return Object.freeze({
    schemaVersion: '1.0.0',
    workspaceId: graph.workspaceId,
    graphFingerprint: graph.graphFingerprint,
    retrievalMethod: 'source_graph_lexical',
    queryFingerprint: hashRef(stableStringify({ query: queryText, nodeKinds: nodeKinds ?? [], edgeKinds: edgeKinds ?? [], labelPattern, locatorPrefix, limit: boundedLimit, offset: boundedOffset })),
    total: sorted.length,
    limit: boundedLimit,
    offset: boundedOffset,
    hasMore: boundedOffset + boundedLimit < sorted.length,
    omittedCount: Math.max(0, sorted.length - boundedOffset - page.length),
    results: page.map((item) => Object.freeze({ ...item, score: Number(item.score.toFixed(6)) }))
  });
}

export function traceSourceGraph(graph, {
  startName = null,
  startNodeId = null,
  edgeKinds = ['calls'],
  direction = 'outbound',
  depth = 2,
  limit = 20
} = {}) {
  assertSourceGraph(graph);
  const boundedDepth = boundedInteger(depth, 'source_graph_trace_depth', 1, 5);
  const boundedLimit = boundedInteger(limit, 'source_graph_trace_limit', 1, 100);
  if (!['outbound', 'inbound', 'both'].includes(direction)) throw new Error(`source_graph_trace_direction_invalid:${direction}`);
  const edgeKindSet = new Set(edgeKinds ?? ['calls']);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const starts = startNodeId
    ? graph.nodes.filter((node) => node.id === startNodeId)
    : graph.nodes.filter((node) => node.kind === 'symbol' && safeTag(node.label) === safeTag(startName));
  const outgoing = new Map();
  const incoming = new Map();
  for (const edge of graph.edges.filter((item) => edgeKindSet.has(item.kind)).sort((a, b) => a.id.localeCompare(b.id))) {
    const outValues = outgoing.get(edge.fromNodeId) ?? [];
    outValues.push(edge);
    outgoing.set(edge.fromNodeId, outValues);
    const inValues = incoming.get(edge.toNodeId) ?? [];
    inValues.push(edge);
    incoming.set(edge.toNodeId, inValues);
  }
  const queue = starts.map((node) => ({ nodeIds: [node.id], edgeIds: [], currentNodeId: node.id }));
  const paths = [];
  while (queue.length && paths.length < boundedLimit) {
    const item = queue.shift();
    if (item.edgeIds.length >= boundedDepth) continue;
    const nextEdges = [
      ...(['outbound', 'both'].includes(direction) ? (outgoing.get(item.currentNodeId) ?? []).map((edge) => ({ edge, nextNodeId: edge.toNodeId })) : []),
      ...(['inbound', 'both'].includes(direction) ? (incoming.get(item.currentNodeId) ?? []).map((edge) => ({ edge, nextNodeId: edge.fromNodeId })) : [])
    ].sort((a, b) => a.edge.id.localeCompare(b.edge.id));
    for (const { edge, nextNodeId } of nextEdges) {
      if (item.nodeIds.includes(nextNodeId)) continue;
      const nextPath = {
        nodeIds: [...item.nodeIds, nextNodeId],
        edgeIds: [...item.edgeIds, edge.id],
        currentNodeId: nextNodeId
      };
      const terminal = nodeById.get(nextNodeId);
      paths.push(Object.freeze({
        depth: nextPath.edgeIds.length,
        nodeIds: nextPath.nodeIds,
        edgeIds: nextPath.edgeIds,
        terminalNodeId: nextNodeId,
        terminalLabel: terminal?.label ?? nextNodeId
      }));
      if (paths.length >= boundedLimit) break;
      queue.push(nextPath);
    }
  }
  return Object.freeze({
    schemaVersion: '1.0.0',
    workspaceId: graph.workspaceId,
    graphFingerprint: graph.graphFingerprint,
    retrievalMethod: 'source_graph_trace',
    startNodeIds: starts.map((node) => node.id).sort(),
    direction,
    edgeKinds: [...edgeKindSet].sort(),
    depth: boundedDepth,
    limit: boundedLimit,
    paths
  });
}

export function mapSourceGraphDiffImpact(graph, { changedLocators = [], depth = 2, limit = 100 } = {}) {
  assertSourceGraph(graph);
  const boundedDepth = boundedInteger(depth, 'source_graph_diff_depth', 1, 5);
  const boundedLimit = boundedInteger(limit, 'source_graph_diff_limit', 1, 500);
  const changed = new Set(changedLocators.map(fileLocatorFor));
  const startNodes = graph.nodes.filter((node) => node.kind === 'file' && changed.has(node.locator));
  const representedChangedLocators = startNodes.map((node) => node.locator).sort();
  const adjacency = new Map();
  for (const edge of graph.edges) {
    const fromValues = adjacency.get(edge.fromNodeId) ?? [];
    fromValues.push({ edge, nextNodeId: edge.toNodeId });
    adjacency.set(edge.fromNodeId, fromValues);
    const toValues = adjacency.get(edge.toNodeId) ?? [];
    toValues.push({ edge, nextNodeId: edge.fromNodeId });
    adjacency.set(edge.toNodeId, toValues);
  }
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const impactedNodes = new Set(startNodes.map((node) => node.id));
  const impactedEdges = new Set();
  const queue = startNodes.map((node) => ({ nodeId: node.id, depth: 0 }));
  while (queue.length && impactedNodes.size < boundedLimit) {
    const item = queue.shift();
    if (item.depth >= boundedDepth) continue;
    for (const { edge, nextNodeId } of (adjacency.get(item.nodeId) ?? []).sort((a, b) => a.edge.id.localeCompare(b.edge.id))) {
      impactedEdges.add(edge.id);
      if (!impactedNodes.has(nextNodeId)) {
        impactedNodes.add(nextNodeId);
        queue.push({ nodeId: nextNodeId, depth: item.depth + 1 });
      }
      if (impactedNodes.size >= boundedLimit) break;
    }
  }
  const affectedSymbols = [...impactedNodes]
    .map((id) => nodeById.get(id))
    .filter((node) => node?.kind === 'symbol')
    .map((node) => ({ nodeId: node.id, name: node.label, locator: node.locator, symbolKind: node.symbolKind }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.nodeId.localeCompare(b.nodeId));
  return Object.freeze({
    schemaVersion: '1.0.0',
    workspaceId: graph.workspaceId,
    graphFingerprint: graph.graphFingerprint,
    changedLocators: [...changed].sort(),
    representedChangedLocators,
    depth: boundedDepth,
    impactedNodeIds: [...impactedNodes].sort(),
    impactedEdgeIds: [...impactedEdges].sort(),
    affectedSymbols
  });
}

export async function readAstCodeSlice({ root, chunk } = {}) {
  // Internal verification helper: provider query/protocol outputs expose only hashes and locators.
  if (typeof root !== 'string' || !root) throw new Error('root is required');
  if (!chunk?.locator || !chunk?.byteRange) throw new Error('chunk locator and byteRange are required');
  const rootReal = await realpath(root);
  const relativePath = relativeFromLocator(chunk.locator);
  const absolutePath = path.join(rootReal, relativePath);
  const fileReal = await realpath(absolutePath);
  if (!insideRoot(rootReal, fileReal)) throw new Error('ast_code_slice_outside_workspace');
  const buffer = await readFile(fileReal);
  return buffer.subarray(chunk.byteRange.start, chunk.byteRange.end).toString('utf8');
}

function chunksForFile({ relativePath, body, workspaceId, collectedAt }) {
  const language = languageFor(relativePath);
  const fileImports = importsFor(body).sort((a, b) => a.module.localeCompare(b.module));
  const lines = body.split('\n');
  const lineStartBytes = lineByteStarts(lines);
  const declarations = declarationsFor(lines);
  const chunks = [];
  for (const declaration of declarations) {
    const endLine = declarationEndLine(lines, declaration.startLine);
    const sourceSlice = lines.slice(declaration.startLine, endLine + 1).join('\n');
    const parseErrorState = bracesBalanced(sourceSlice) ? 'none' : 'unbalanced_braces';
    const lineRange = { start: declaration.startLine + 1, end: endLine + 1 };
    const byteRange = {
      start: lineStartBytes[declaration.startLine],
      end: lineStartBytes[endLine] + Buffer.byteLength(lines[endLine] ?? '', 'utf8')
    };
    const entities = entitiesForDeclaration(declaration, sourceSlice);
    const signature = signatureFor(declaration, sourceSlice);
    const calls = declaration.kind === 'class' ? [] : callsForDeclaration(declaration, sourceSlice).map((name) => ({ name, callHash: hashRef(`${relativePath}:${lineRange.start}:${name}`) }));
    const references = referencesForSource(sourceSlice).map((name) => ({ name, referenceHash: hashRef(`${relativePath}:${lineRange.start}:${name}`) }));
    const imports = declaration.kind === 'class' ? [] : importsForSlice(fileImports, sourceSlice).map(publicImport);
    const exports = declaration.exported ? [{ name: declaration.name, kind: declaration.kind, exportHash: hashRef(`${relativePath}:${declaration.name}:export`) }] : [];
    const chunk = {
      schemaVersion: '1.0.0',
      id: `astchunk_${sha256(`${relativePath}:${lineRange.start}:${lineRange.end}:${sourceSlice}`).slice(0, 32)}`,
      workspaceId,
      language,
      locator: `${locatorFor(relativePath)}#L${lineRange.start}-L${lineRange.end}`,
      parserVersion: AST_CODE_PARSER_VERSION,
      parseErrorState,
      byteRange,
      lineRange,
      scopeChain: declaration.scopeChain,
      entities,
      imports,
      exports,
      signatureHash: hashRef(signature),
      siblingLocators: [],
      sourceSnapshotId: `srcsnap_${sha256(`${relativePath}:${hashRef(body)}`).slice(0, 16)}`,
      exactSourceReconstructionHash: hashRef(sourceSlice),
      contentHash: hashRef(sourceSlice),
      calls,
      references,
      collectedAt
    };
    chunks.push(chunk);
  }
  return chunks.map((chunk, index) => {
    const siblingLocators = [chunks[index - 1]?.locator, chunks[index + 1]?.locator].filter(Boolean);
    const withSiblings = { ...chunk, siblingLocators };
    return Object.freeze({ ...withSiblings, chunkFingerprint: contentFingerprint(withSiblings) });
  });
}

function declarationsFor(lines) {
  const declarations = [];
  const scopeStack = [];
  let braceDepth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const trimmed = raw.trim();
    while (scopeStack.length && braceDepth < scopeStack[scopeStack.length - 1].depth) scopeStack.pop();
    const classMatch = trimmed.match(/^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/u);
    const functionMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/u);
    const arrowMatch = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/u);
    const interfaceMatch = trimmed.match(/^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/u);
    const typeMatch = trimmed.match(/^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/u);
    const methodMatch = scopeStack.length ? trimmed.match(/^(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{/u) : null;
    const exported = /^export\s+/u.test(trimmed);
    if (classMatch) {
      declarations.push({ kind: 'class', name: classMatch[1], startLine: index, scopeChain: scopeStack.map((item) => item.name), exported });
      scopeStack.push({ name: classMatch[1], depth: braceDepth + Math.max(1, braceDelta(raw)) });
    } else if (functionMatch) {
      declarations.push({ kind: 'function', name: functionMatch[1], startLine: index, scopeChain: scopeStack.map((item) => item.name), exported });
    } else if (arrowMatch) {
      declarations.push({ kind: 'function', name: arrowMatch[1], startLine: index, scopeChain: scopeStack.map((item) => item.name), exported });
    } else if (interfaceMatch) {
      declarations.push({ kind: 'interface', name: interfaceMatch[1], startLine: index, scopeChain: scopeStack.map((item) => item.name), exported });
    } else if (typeMatch) {
      declarations.push({ kind: 'type', name: typeMatch[1], startLine: index, scopeChain: scopeStack.map((item) => item.name), exported });
    } else if (methodMatch && !CONTROL_FLOW_NAMES.has(methodMatch[1])) {
      declarations.push({ kind: 'method', name: methodMatch[1], startLine: index, scopeChain: scopeStack.map((item) => item.name), exported: false });
    }
    braceDepth += braceDelta(raw);
  }
  return declarations;
}

function entitiesForDeclaration(declaration, sourceSlice) {
  const entities = [{ kind: declaration.kind, name: declaration.name }];
  if (declaration.kind === 'class') {
    const methodMatches = sourceSlice.matchAll(/^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gmu);
    for (const match of methodMatches) {
      if (!CONTROL_FLOW_NAMES.has(match[1])) entities.push({ kind: 'method', name: match[1] });
    }
  }
  return Object.freeze(entities.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)));
}

function declarationEndLine(lines, startLine) {
  let depth = 0;
  let sawBrace = false;
  for (let index = startLine; index < lines.length; index += 1) {
    const delta = braceDelta(lines[index]);
    if (lines[index].includes('{')) sawBrace = true;
    depth += delta;
    if (sawBrace && depth <= 0) return index;
    if (!sawBrace && /;\s*$/u.test(lines[index].trim())) return index;
  }
  return lines.length - 1;
}

function importsFor(body) {
  const imports = [];
  for (const line of body.split('\n')) {
    const fromMatch = line.match(/^\s*import(?:\s+type)?\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/u);
    const bareMatch = line.match(/^\s*import\s+['"]([^'"]+)['"]/u);
    const requireMatch = line.match(/require\(\s*['"]([^'"]+)['"]\s*\)/u);
    const requireName = line.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/u)?.[1] ?? null;
    const rawModule = fromMatch?.[2] ?? bareMatch?.[1] ?? requireMatch?.[1] ?? null;
    if (rawModule) {
      const module = sanitizeModuleSpecifier(rawModule);
      imports.push({
        module,
        importHash: hashRef(rawModule),
        names: fromMatch ? importedNames(fromMatch[1]) : requireName ? [requireName] : []
      });
    }
  }
  return uniqueBy(imports, (item) => item.module);
}

function fileOutlineFor({ relativePath, body, workspaceId, collectedAt, chunks }) {
  const imports = importsFor(body).sort((a, b) => a.module.localeCompare(b.module));
  const exports = exportsFor({ body, chunks }).sort((a, b) => a.name.localeCompare(b.name));
  const contentHash = hashRef(body);
  const outline = {
    schemaVersion: '1.0.0',
    workspaceId,
    locator: locatorFor(relativePath),
    language: languageFor(relativePath),
    contentHash,
    sourceSnapshotId: `srcsnap_${sha256(`${relativePath}:${contentHash}`).slice(0, 16)}`,
    lineCount: body.split('\n').length,
    chunkIds: chunks.map((chunk) => chunk.id).sort(),
    symbols: chunks.flatMap((chunk) => chunk.entities.map((entity) => ({
      name: entity.name,
      kind: entity.kind,
      locator: chunk.locator,
      signatureHash: chunk.signatureHash
    }))).sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind)),
    imports: imports.map(publicImport),
    exports,
    collectedAt
  };
  return Object.freeze({ ...outline, symbolFingerprint: contentFingerprint(outline) });
}

function repositoryOutlineFor({ workspaceId, fileOutlines, symbolIndex }) {
  const outline = {
    schemaVersion: '1.0.0',
    workspaceId,
    fileCount: fileOutlines.length,
    symbolCount: symbolIndex.symbols.length,
    importCount: symbolIndex.imports.length,
    exportCount: symbolIndex.exports.length,
    callEdgeCount: symbolIndex.callEdges.length,
    locators: fileOutlines.map((file) => file.locator).sort(),
    languages: [...new Set(fileOutlines.map((file) => file.language))].sort()
  };
  return Object.freeze({ ...outline, outlineFingerprint: hashRef(stableStringify(outline)) });
}

function buildSymbolIndex({ workspaceId, chunks, fileOutlines, indexedAt }) {
  const symbols = [];
  const imports = [];
  const exports = [];
  const references = [];
  const callEdges = [];
  const symbolsByName = new Map();
  for (const chunk of chunks) {
    for (const entity of chunk.entities) {
      const symbol = {
        id: `symbol_${sha256(`${chunk.locator}:${entity.kind}:${entity.name}`).slice(0, 32)}`,
        workspaceId,
        name: entity.name,
        kind: entity.kind,
        locator: chunk.locator,
        chunkId: chunk.id,
        scopeChain: chunk.scopeChain,
        signatureHash: chunk.signatureHash,
        contentHash: chunk.contentHash,
        sourceSnapshotId: chunk.sourceSnapshotId
      };
      symbols.push(symbol);
      const values = symbolsByName.get(entity.name) ?? [];
      values.push(symbol);
      symbolsByName.set(entity.name, values);
    }
    for (const item of chunk.imports) imports.push({
      id: `import_${sha256(`${chunk.locator}:${item.module}`).slice(0, 32)}`,
      workspaceId,
      module: item.module,
      moduleHash: item.importHash,
      locator: chunk.locator,
      chunkId: chunk.id
    });
    for (const item of chunk.exports ?? []) {
      exports.push({
        id: `export_${sha256(`${chunk.locator}:${item.name}`).slice(0, 32)}`,
        workspaceId,
        name: item.name,
        kind: item.kind,
        locator: chunk.locator,
        chunkId: chunk.id,
        exportHash: item.exportHash
      });
    }
  }

  for (const chunk of chunks) {
    const caller = chunk.entities.find((entity) => ['function', 'method'].includes(entity.kind)) ?? chunk.entities[0];
    let referenceEdgesForChunk = 0;
    for (const reference of (chunk.references ?? []).slice(0, MAX_REFERENCES_PER_CHUNK)) {
      if (referenceEdgesForChunk >= MAX_REFERENCE_EDGES_PER_CHUNK) break;
      if (!symbolsByName.has(reference.name)) continue;
      for (const target of symbolsByName.get(reference.name).slice(0, MAX_TARGETS_PER_SYMBOL_NAME)) {
        if (referenceEdgesForChunk >= MAX_REFERENCE_EDGES_PER_CHUNK) break;
        if (target.chunkId === chunk.id && target.name === caller?.name) continue;
        references.push({
          id: `ref_${sha256(`${chunk.locator}:${reference.name}:${target.id}`).slice(0, 32)}`,
          workspaceId,
          targetSymbolId: target.id,
          targetName: target.name,
          sourceLocator: chunk.locator,
          sourceChunkId: chunk.id,
          referenceHash: reference.referenceHash
        });
        referenceEdgesForChunk += 1;
      }
    }
    if (!caller) continue;
    const callerSymbol = symbols.find((symbol) => symbol.chunkId === chunk.id && symbol.name === caller.name);
    if (!callerSymbol) continue;
    let callEdgesForChunk = 0;
    for (const call of (chunk.calls ?? []).slice(0, MAX_CALLS_PER_CHUNK)) {
      if (callEdgesForChunk >= MAX_CALL_EDGES_PER_CHUNK) break;
      if (!symbolsByName.has(call.name)) continue;
      for (const callee of symbolsByName.get(call.name).slice(0, MAX_TARGETS_PER_SYMBOL_NAME)) {
        if (callEdgesForChunk >= MAX_CALL_EDGES_PER_CHUNK) break;
        if (callee.id === callerSymbol.id) continue;
        callEdges.push({
          id: `call_${sha256(`${callerSymbol.id}:${callee.id}:${chunk.locator}`).slice(0, 32)}`,
          workspaceId,
          callerSymbolId: callerSymbol.id,
          callerName: callerSymbol.name,
          calleeSymbolId: callee.id,
          calleeName: callee.name,
          sourceLocator: chunk.locator,
          callHash: call.callHash
        });
        callEdgesForChunk += 1;
      }
    }
  }

  const index = {
    schemaVersion: '1.0.0',
    workspaceId,
    parserVersion: AST_CODE_PARSER_VERSION,
    indexedAt,
    symbols: uniqueObjects(symbols, 'id').sort(byId),
    references: uniqueObjects(references, 'id').sort(byId),
    imports: uniqueObjects(imports, 'id').sort(byId),
    exports: uniqueObjects(exports, 'id').sort(byId),
    callEdges: uniqueObjects(callEdges, 'id').sort(byId),
    fileLocators: fileOutlines.map((file) => file.locator).sort()
  };
  return Object.freeze({ ...index, symbolIndexFingerprint: contentFingerprint(index) });
}

function exportsFor({ body, chunks }) {
  const output = [];
  for (const chunk of chunks) output.push(...(chunk.exports ?? []));
  for (const match of body.matchAll(/^\s*export\s+\{([^}]+)\}/gmu)) {
    for (const value of match[1].split(',')) {
      const name = value.trim().split(/\s+as\s+/u).pop()?.trim();
      if (name) output.push({ name, kind: 'export', exportHash: hashRef(`export:${name}`) });
    }
  }
  return uniqueBy(output, (item) => `${item.kind}:${item.name}`);
}

function signatureFor(declaration, sourceSlice) {
  const line = sourceSlice.split('\n')[0] ?? declaration.name;
  return stripStringsAndComments(line).replace(/\{.*$/u, '').replace(/\s+/gu, ' ').trim().slice(0, 240);
}

function referencesForSource(sourceSlice) {
  const names = [];
  for (const match of stripStringsAndComments(sourceSlice).matchAll(/\b[A-Za-z_$][\w$]*\b/gu)) {
    if (!JS_KEYWORDS.has(match[0])) names.push(match[0]);
  }
  return [...new Set(names)].sort();
}

function callsForDeclaration(declaration, sourceSlice) {
  return callsForSource(sourceSlice).filter((name) => name !== declaration.name);
}

function callsForSource(sourceSlice) {
  const names = [];
  for (const match of stripStringsAndComments(sourceSlice).matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/gu)) {
    if (!JS_KEYWORDS.has(match[1])) names.push(match[1]);
  }
  return [...new Set(names)].sort();
}

function importsForSlice(imports, sourceSlice) {
  const referenceTerms = referencesForSource(sourceSlice);
  const referenced = new Set(referenceTerms);
  return imports.filter((item) => !item.names.length || item.names.some((name) => referenced.has(name)));
}

function importedNames(specifier) {
  const value = String(specifier ?? '').trim();
  if (!value) return [];
  const names = [];
  const namespaceMatch = value.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/u);
  if (namespaceMatch) names.push(namespaceMatch[1]);
  const leading = value.split('{')[0].trim().replace(/^type\s+/u, '').split(',')[0].trim();
  if (leading && /^[A-Za-z_$][\w$]*$/u.test(leading)) names.push(leading);
  const named = value.match(/\{([^}]+)\}/u)?.[1] ?? '';
  for (const part of named.split(',')) {
    const cleaned = part.trim().replace(/^type\s+/u, '');
    if (!cleaned) continue;
    const alias = cleaned.split(/\s+as\s+/u).pop()?.trim();
    if (alias && /^[A-Za-z_$][\w$]*$/u.test(alias)) names.push(alias);
  }
  return [...new Set(names)].sort();
}

function publicImport(item) {
  return { module: item.module, importHash: item.importHash };
}

function sanitizeModuleSpecifier(rawModule) {
  const value = String(rawModule ?? '').trim();
  if (!value) return 'invalid-module';
  if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value) || /(^|[\\/])(?:Users|private)([\\/]|$)/u.test(value) || /(^|[\\/])var[\\/]folders([\\/]|$)/u.test(value)) {
    return 'local:absolute-import';
  }
  return value.replace(/\s+/gu, ' ').slice(0, 240);
}

function contentFingerprint(value) {
  return hashRef(stableStringify(stripVolatileTimestamps(value)));
}

function stripVolatileTimestamps(value) {
  if (Array.isArray(value)) return value.map(stripVolatileTimestamps);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (['collectedAt', 'indexedAt'].includes(key)) continue;
    output[key] = stripVolatileTimestamps(item);
  }
  return output;
}

function recordFromChunk(chunk, workspaceId) {
  const entityNames = chunk.entities.map((entity) => entity.name);
  const importNames = chunk.imports.map((item) => item.module);
  const text = [
    `Code chunk ${entityNames.join(' ')} in ${chunk.locator}.`,
    importNames.length ? `Imports ${importNames.join(' ')}.` : '',
    `Parse ${chunk.parseErrorState}.`
  ].filter(Boolean).join(' ');
  const tags = [
    'code',
    `language:${chunk.language}`,
    ...entityNames.map((name) => `symbol:${safeTag(name)}`),
    ...importNames.map((name) => `import:${safeTag(importAlias(name))}`)
  ].sort();
  return {
    id: `ast_${sha256(`${chunk.locator}:${chunk.contentHash}`).slice(0, 32)}`,
    version: chunk.chunkFingerprint,
    kind: 'code_chunk',
    workspaceId,
    text,
    tags,
    relations: tags,
    scope: 'workspace-private',
    dataClass: 'workspace-private',
    trustClass: 'observed',
    status: chunk.parseErrorState === 'none' ? 'active' : 'quarantined',
    source: chunk.locator,
    tokens: estimateTokens(text),
    confidence: chunk.parseErrorState === 'none' ? 0.82 : 0.25,
    authority: 0.55,
    updatedAt: chunk.collectedAt,
    contentHash: chunk.contentHash,
    metadata: {
      astCode: {
        parserVersion: chunk.parserVersion,
        parseErrorState: chunk.parseErrorState,
        byteRange: chunk.byteRange,
        lineRange: chunk.lineRange,
        scopeChain: chunk.scopeChain,
        entities: chunk.entities,
        imports: chunk.imports.map((item) => ({ moduleHash: item.importHash }))
      }
    }
  };
}

function chunkSearchText(chunk) {
  return [
    chunk.locator,
    chunk.language,
    chunk.parseErrorState,
    ...chunk.scopeChain,
    ...chunk.entities.map((entity) => `${entity.kind} ${entity.name} symbol:${entity.name}`),
    ...chunk.imports.map((item) => `${item.module} import:${importAlias(item.module)}`)
  ].join(' ');
}

function overlapScore(query, text) {
  const queryTerms = terms(query);
  const textTerms = terms(text);
  if (!queryTerms.size || !textTerms.size) return 0;
  let matches = 0;
  for (const term of queryTerms) if (textTerms.has(term)) matches += 1;
  return matches / Math.sqrt(queryTerms.size * textTerms.size);
}

function diagnostic(locator, code) {
  return Object.freeze({ locator, code });
}

function locatorFor(relativePath) {
  return `workspace://${normalizeRelative(relativePath)}`;
}

function fileLocatorFor(locator) {
  if (typeof locator !== 'string') return '';
  const value = locator.split('#')[0];
  if (!value.startsWith('workspace://')) throw new Error('source_graph_locator_invalid');
  return value;
}

function locatorLabel(locator) {
  return String(locator ?? '').replace(/^workspace:\/\//u, '');
}

function relativeFromLocator(locator) {
  if (!locator.startsWith('workspace://')) throw new Error('ast_code_locator_invalid');
  const withoutScheme = locator.slice('workspace://'.length).split('#')[0];
  if (!withoutScheme || path.isAbsolute(withoutScheme) || withoutScheme.split('/').includes('..')) throw new Error('ast_code_locator_invalid');
  return withoutScheme;
}

function normalizeRelative(value) {
  return String(value).split(path.sep).join('/').replace(/^\/+/u, '');
}

function insideRoot(rootReal, candidateReal) {
  const relative = path.relative(rootReal, candidateReal);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function lineByteStarts(lines) {
  const starts = [];
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    starts.push(offset);
    offset += Buffer.byteLength(lines[index] ?? '', 'utf8');
    if (index < lines.length - 1) offset += 1;
  }
  return starts;
}

function bracesBalanced(text) {
  return braceDelta(text) === 0;
}

function braceDelta(text) {
  const stripped = stripStringsAndComments(text);
  let delta = 0;
  for (const char of stripped) {
    if (char === '{') delta += 1;
    else if (char === '}') delta -= 1;
  }
  return delta;
}

function stripStringsAndComments(text) {
  const input = String(text);
  let output = '';
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];
    if (char === '/' && next === '/') {
      index += 2;
      while (index < input.length && input[index] !== '\n') index += 1;
      if (input[index] === '\n') output += '\n';
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < input.length && !(input[index] === '*' && input[index + 1] === '/')) {
        if (input[index] === '\n') output += '\n';
        index += 1;
      }
      if (index < input.length) index += 1;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      const quote = char;
      index += 1;
      while (index < input.length) {
        if (input[index] === '\n') output += '\n';
        if (input[index] === '\\') {
          index += 2;
          continue;
        }
        if (input[index] === quote) break;
        index += 1;
      }
      continue;
    }
    output += char;
  }
  return output;
}

function languageFor(relativePath) {
  const extension = path.extname(relativePath);
  if (['.ts', '.tsx'].includes(extension)) return 'typescript';
  return 'javascript';
}

function importAlias(moduleName) {
  const parts = String(moduleName).split('/').filter(Boolean);
  return parts[parts.length - 1] ?? moduleName;
}

function safeTag(value) {
  return String(value).normalize('NFKC').replace(/[^A-Za-z0-9_:-]+/gu, '-').replace(/^-|-$/gu, '') || 'unknown';
}

function safeTimestamp(clock) {
  const value = typeof clock === 'function' ? clock() : new Date().toISOString();
  return value instanceof Date ? value.toISOString() : String(value);
}

function sourceGraphNodeId(kind, value) {
  return `sgnode_${sha256(`${kind}:${value}`).slice(0, 32)}`;
}

function sourceGraphEdgeId(kind, fromNodeId, toNodeId, sourceRef = '') {
  return `sgedge_${sha256(`${kind}:${fromNodeId}:${toNodeId}:${sourceRef}`).slice(0, 32)}`;
}

function withDefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

function sourceGraphSummary({ nodes, edges }) {
  const nodeKindCounts = countBy(nodes, (node) => node.kind);
  const edgeKindCounts = countBy(edges, (edge) => edge.kind);
  const degree = new Map(nodes.map((node) => [node.id, { inbound: 0, outbound: 0 }]));
  for (const edge of edges) {
    const from = degree.get(edge.fromNodeId);
    const to = degree.get(edge.toNodeId);
    if (from) from.outbound += 1;
    if (to) to.inbound += 1;
  }
  const hotspots = nodes
    .filter((node) => node.kind === 'symbol')
    .map((node) => {
      const counts = degree.get(node.id) ?? { inbound: 0, outbound: 0 };
      return { nodeId: node.id, label: node.label, inbound: counts.inbound, outbound: counts.outbound, total: counts.inbound + counts.outbound };
    })
    .filter((item) => item.total > 0)
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label) || a.nodeId.localeCompare(b.nodeId))
    .slice(0, 10);
  const entryPoints = nodes
    .filter((node) => node.kind === 'symbol')
    .map((node) => {
      const counts = degree.get(node.id) ?? { inbound: 0, outbound: 0 };
      return { node, counts };
    })
    .filter(({ counts }) => counts.inbound === 0 && counts.outbound > 0)
    .map(({ node }) => ({ nodeId: node.id, label: node.label, locator: node.locator, symbolKind: node.symbolKind }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.nodeId.localeCompare(b.nodeId))
    .slice(0, 10);
  return Object.freeze({
    fileCount: nodeKindCounts.file ?? 0,
    symbolCount: nodeKindCounts.symbol ?? 0,
    moduleCount: nodeKindCounts.module ?? 0,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodeKindCounts,
    edgeKindCounts,
    hotspots,
    entryPoints
  });
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.freeze(Object.fromEntries(Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0]))));
}

function graphContentFingerprint(value) {
  return hashRef(stableStringify(stripGraphVolatile(value)));
}

function stripGraphVolatile(value) {
  if (Array.isArray(value)) return value.map(stripGraphVolatile);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (['builtAt', 'graphFingerprint'].includes(key)) continue;
    output[key] = stripGraphVolatile(item);
  }
  return output;
}

function assertSourceGraph(graph) {
  if (!graph || graph.schemaVersion !== '1.0.0' || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new Error('source graph is required');
  }
}

function boundedInteger(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name}:invalid`);
  return value;
}

function safeRegex(pattern, errorCode) {
  try {
    return new RegExp(String(pattern), 'u');
  } catch {
    throw new Error(errorCode);
  }
}

function graphSearchScore(queryTerms, text) {
  if (!queryTerms.size) return 1;
  const graphTerms = terms(text);
  if (!graphTerms.size) return 0;
  let matches = 0;
  for (const term of queryTerms) if (graphTerms.has(term)) matches += 1;
  return matches / Math.sqrt(queryTerms.size * graphTerms.size);
}

function sourceGraphNodeSearchText(node) {
  return expandSearchText([
    node.kind,
    node.label,
    node.symbolKind,
    node.locator,
    node.sourceRef,
    node.moduleHash
  ].filter(Boolean).join(' '));
}

function sourceGraphEdgeSearchText(edge, from, to) {
  return expandSearchText([
    edge.kind,
    edge.locator,
    edge.sourceRef,
    from?.kind,
    from?.label,
    from?.locator,
    to?.kind,
    to?.label,
    to?.locator
  ].filter(Boolean).join(' '));
}

function expandSearchText(value) {
  const raw = String(value ?? '');
  const expanded = raw
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/[_:./#-]+/gu, ' ');
  return `${raw} ${expanded}`;
}

function sourceGraphSearchReasons({ score, pattern, locatorPrefix }) {
  return [
    score > 0 ? 'lexical_match' : 'unfiltered_match',
    pattern ? 'label_pattern_match' : null,
    locatorPrefix ? 'locator_prefix_match' : null
  ].filter(Boolean);
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(Object.freeze(item));
  }
  return output;
}

function uniqueObjects(items, key) {
  return uniqueBy(items, (item) => item[key]);
}

function byId(a, b) {
  return a.id.localeCompare(b.id);
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}
