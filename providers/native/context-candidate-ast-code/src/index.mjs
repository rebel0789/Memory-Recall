import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { estimateTokens, hashRef, stableStringify, terms } from '../../../../packages/context-compiler/src/index.mjs';

export const AST_CODE_PROVIDER_VERSION = '1.0.0';
export const AST_CODE_PARSER_VERSION = 'oaf-js-ts-static-1.0.0';

const SOURCE_ID = 'provider:native:context-candidate:ast-code';
const GRAPH_SOURCE_ID = 'provider:native:context-candidate:graph';
const EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', 'out', 'vendor']);
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_FILES = 1000;
const MAX_REFERENCES_PER_CHUNK = 80;
const MAX_CALLS_PER_CHUNK = 40;
const MAX_TARGETS_PER_SYMBOL_NAME = 8;
const MAX_REFERENCE_EDGES_PER_CHUNK = 200;
const MAX_CALL_EDGES_PER_CHUNK = 80;
const MAX_DIRECT_GRAPH_RESULTS_PER_FILE = 2;
const MAX_NEIGHBOR_GRAPH_RESULTS_PER_FILE = 1;
const MAX_REFERENCE_TARGETS_FOR_COMMON_NAME = 8;
const FIRST_ARGUMENT_CALLBACK_NAMES = new Set(['catch', 'every', 'filter', 'finally', 'find', 'findIndex', 'flatMap', 'forEach', 'map', 'reduce', 'reduceRight', 'some', 'sort', 'then']);
const CALLABLE_DECLARATION_KINDS = new Set(['function', 'method']);
const LOW_SIGNAL_REFERENCE_NAMES = new Set([
  'clock',
  'config',
  'content',
  'contentHash',
  'createdAt',
  'ctx',
  'data',
  'description',
  'edge',
  'edges',
  'error',
  'file',
  'files',
  'id',
  'index',
  'input',
  'item',
  'key',
  'name',
  'node',
  'nodes',
  'message',
  'options',
  'output',
  'path',
  'query',
  'record',
  'request',
  'response',
  'arg',
  'args',
  'argv',
  'body',
  'fixedNow',
  'now',
  'option',
  'payload',
  'reasonCodes',
  'resolve',
  'result',
  'results',
  'root',
  'runId',
  'split',
  'state',
  'status',
  'summary',
  'text',
  'type',
  'value',
  'values',
  'workspaceId'
]);
const WEAK_MEMBER_CALL_NAMES = new Set([
  'add',
  'catch',
  'clear',
  'delete',
  'entries',
  'every',
  'filter',
  'finally',
  'find',
  'findIndex',
  'forEach',
  'debug',
  'error',
  'get',
  'has',
  'includes',
  'info',
  'join',
  'keys',
  'log',
  'map',
  'match',
  'pop',
  'push',
  'reduce',
  'replace',
  'reverse',
  'set',
  'slice',
  'some',
  'sort',
  'splice',
  'split',
  'startsWith',
  'stringify',
  'test',
  'then',
  'toString',
  'trim',
  'values',
  'warn'
]);
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

export function createNativeSourceGraphCandidateSource({
  root = null,
  workspaceId = 'ws_local',
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
  clock = () => new Date().toISOString()
} = {}) {
  let cachedGraph = null;
  let cachedGraphKey = null;
  return Object.freeze({
    descriptor: () => ({
      schemaVersion: '1.0.0',
      id: GRAPH_SOURCE_ID,
      kind: 'graph',
      version: AST_CODE_PROVIDER_VERSION,
      enabled: true,
      methods: ['source_graph_lexical'],
      contractVersion: '1.0.0',
      description: 'Workspace-scoped dependency-free JS/TS source graph candidate source'
    }),
    health: async () => ({ status: 'healthy' }),
    async query(request, trustedContext = {}) {
      const workspaceRoot = root ?? trustedContext.workspaceRoot;
      if (!workspaceRoot) return { candidates: [] };
      const queryText = [
        request.objective,
        request.step,
        ...(request.requiredEntities ?? [])
      ].filter(Boolean).join(' ');
      const graphKey = stableStringify({ workspaceRoot, workspaceId: request.workspaceId ?? workspaceId, maxFileBytes, maxFiles });
      if (!cachedGraph || cachedGraphKey !== graphKey) {
        cachedGraph = await buildJsTsSourceGraph({
          root: workspaceRoot,
          workspaceId: request.workspaceId ?? workspaceId,
          maxFileBytes,
          maxFiles,
          clock
        });
        cachedGraphKey = graphKey;
      }
      const graph = cachedGraph;
      const resultLimit = trustedContext.sourceLimit ?? request.perSourceLimit ?? 10;
      const search = searchSourceGraph(graph, {
        query: queryText,
        limit: sourceGraphSearchLimit(resultLimit)
      });
      const results = sourceGraphCandidateResults(graph, search.results, {
        limit: resultLimit
      });
      return {
        candidates: results.map((result, index) => ({
          record: recordFromGraphResult({ result, graph, workspaceId: request.workspaceId ?? workspaceId, collectedAt: clock() }),
          sourceHit: {
            sourceId: GRAPH_SOURCE_ID,
            sourceKind: 'graph',
            sourceVersion: AST_CODE_PROVIDER_VERSION,
            retrievalMethod: search.retrievalMethod,
            localRank: index + 1,
            localScore: Number(Math.max(0, Math.min(1, result.score)).toFixed(6)),
            reasonCodes: [...new Set(['source_graph_match', ...(result.reasonCodes ?? [])])].sort(),
            queryFingerprint: trustedContext.queryFingerprint ?? search.queryFingerprint,
            accessDecisionRef: trustedContext.accessDecisionRef ?? 'poldet_unconfigured',
            retrievedAt: trustedContext.retrievedAt ?? clock()
          }
        }))
      };
    }
  });
}

function sourceGraphCandidateResults(graph, searchResults, { limit }) {
  const boundedLimit = boundedInteger(limit, 'source_graph_candidate_limit', 1, 100);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const edgesByNodeId = new Map();
  for (const edge of graph.edges) {
    for (const nodeId of [edge.fromNodeId, edge.toNodeId]) {
      const edges = edgesByNodeId.get(nodeId) ?? [];
      edges.push(edge);
      edgesByNodeId.set(nodeId, edges);
    }
  }
  const output = [];
  const seen = new Set();
  const directFileCounts = new Map();
  const neighborFileCounts = new Map();
  const directResults = [];
  const directQuota = Math.max(1, Math.min(boundedLimit, Math.ceil(boundedLimit * 0.75)));
  function add(result, { fileCounts, maxPerFile }) {
    if (!result?.locator || seen.has(result.id)) return;
    const fileLocator = fileLocatorFor(result.locator);
    const fileCount = fileCounts.get(fileLocator) ?? 0;
    if (fileCount >= maxPerFile) return;
    fileCounts.set(fileLocator, fileCount + 1);
    seen.add(result.id);
    output.push(result);
  }
  for (const result of searchResults) {
    const outputLengthBefore = output.length;
    add(result, {
      fileCounts: directFileCounts,
      maxPerFile: MAX_DIRECT_GRAPH_RESULTS_PER_FILE
    });
    if (output.length > outputLengthBefore) directResults.push(result);
    if (output.length >= directQuota) break;
  }
  if (output.length >= boundedLimit) return output;

  const neighborSeeds = [...directResults].sort(compareNeighborSeeds);
  for (const result of neighborSeeds) {
    for (const edge of neighborEdgesForResult(result, { edgesByNodeId, nodeById })) {
      const from = nodeById.get(edge.fromNodeId);
      const to = nodeById.get(edge.toNodeId);
      add({
        resultType: 'edge',
        id: edge.id,
        kind: edge.kind,
        label: `${from?.label ?? edge.fromNodeId} ${edge.kind} ${to?.label ?? edge.toNodeId}`,
        locator: edge.locator,
        fromNodeId: edge.fromNodeId,
        toNodeId: edge.toNodeId,
        score: Number((Math.max(0.01, result.score * 0.65)).toFixed(6)),
        reasonCodes: [...new Set(['source_graph_neighbor', ...(result.reasonCodes ?? [])])].sort()
      }, {
        fileCounts: neighborFileCounts,
        maxPerFile: MAX_NEIGHBOR_GRAPH_RESULTS_PER_FILE
      });
      if (output.length >= boundedLimit) break;
    }
    if (output.length >= boundedLimit) break;
  }
  return output;
}

function sourceGraphSearchLimit(resultLimit) {
  const boundedLimit = boundedInteger(resultLimit, 'source_graph_candidate_limit', 1, 100);
  return Math.min(100, Math.max(boundedLimit, boundedLimit * 4));
}

function compareNeighborEdges(left, right) {
  return neighborEdgePriority(left.kind) - neighborEdgePriority(right.kind) || left.id.localeCompare(right.id);
}

function compareNeighborSeeds(left, right) {
  return neighborSeedPriority(left) - neighborSeedPriority(right) || right.score - left.score || left.id.localeCompare(right.id);
}

function neighborEdgesForResult(result, { edgesByNodeId, nodeById }) {
  const nodeIds = result.resultType === 'node'
    ? [result.id]
    : [result.fromNodeId, result.toNodeId].filter(Boolean);
  const edges = [];
  const seen = new Set();
  function addEdge(edge) {
    if (!edge?.locator || seen.has(edge.id)) return;
    seen.add(edge.id);
    edges.push(edge);
  }
  for (const nodeId of nodeIds) {
    const firstHop = (edgesByNodeId.get(nodeId) ?? []).sort(compareNeighborEdges);
    for (const edge of firstHop) {
      addEdge(edge);
      const otherNodeId = edge.fromNodeId === nodeId ? edge.toNodeId : edge.fromNodeId;
      const otherNode = nodeById.get(otherNodeId);
      if (otherNode?.kind !== 'chunk' || !['contains', 'defined_in'].includes(edge.kind)) continue;
      for (const secondHop of (edgesByNodeId.get(otherNodeId) ?? []).sort(compareNeighborEdges)) {
        if (secondHop.id !== edge.id) addEdge(secondHop);
      }
    }
  }
  return edges;
}

function neighborSeedPriority(result) {
  if (result.resultType === 'node' && result.kind === 'file') return 0;
  if (result.resultType === 'node' && result.kind === 'symbol') return 1;
  if (result.resultType === 'edge' && result.kind === 'imports') return 2;
  if (['calls', 'references'].includes(result.kind)) return 3;
  return 4;
}

function neighborEdgePriority(kind) {
  switch (kind) {
    case 'imports':
      return 0;
    case 'calls':
      return 1;
    case 'references':
      return 2;
    case 'exports':
      return 3;
    case 'defined_in':
      return 4;
    case 'contains':
      return 5;
    default:
      return 10;
  }
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
  const knownFileLocators = new Set(fileOutlinesByLocator.keys());
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
      qualifiedLabel: qualifiedSymbolLabel(symbol.name, symbol.scopeChain),
      locator: symbol.locator,
      sourceRef: symbol.id,
      symbolKind: symbol.kind,
      scopeChain: symbol.scopeChain?.length ? symbol.scopeChain : undefined,
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
      const importedFileLocator = resolveImportFileLocator(item.locator, item.module, knownFileLocators);
      const importedFileNode = importedFileLocator ? ensureFileNode(importedFileLocator) : null;
      if (importedFileNode) {
        addEdge(withDefined({
          id: sourceGraphEdgeId('imports', chunkNode.id, importedFileNode.id, `${item.id}:file`),
          workspaceId,
          kind: 'imports',
          fromNodeId: chunkNode.id,
          toNodeId: importedFileNode.id,
          locator: importedFileLocator,
          sourceRef: item.id,
          confidence: 0.85
        }));
      }
    }
  }

  for (const item of index.symbolIndex.exports ?? []) {
    const fileNode = ensureFileNode(item.locator);
    const chunkSymbols = (index.symbolIndex.symbols ?? []).filter((symbol) => symbol.chunkId === item.chunkId);
    const targetSymbol = chunkSymbols.find((symbol) => symbol.name === item.name) ?? chunkSymbols[0];
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
        exportName: item.name,
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
  const includeNodes = !edgeKindSet || Boolean(nodeKindSet);
  const includeEdges = !nodeKindSet || Boolean(edgeKindSet);
  const pattern = labelPattern ? safeRegex(labelPattern, 'source_graph_label_pattern_invalid') : null;
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const queryText = String(query ?? '');
  const queryTerms = terms(queryText);
  const results = [];

  for (const node of includeNodes ? graph.nodes : []) {
    if (nodeKindSet && !nodeKindSet.has(node.kind)) continue;
    if (locatorPrefix && !(node.locator ?? '').startsWith(locatorPrefix)) continue;
    if (pattern && !pattern.test(node.label) && !pattern.test(node.qualifiedLabel ?? '')) continue;
    const score = graphSearchScore(queryTerms, sourceGraphNodeSearchText(node)) * graphSearchPathWeight(node.locator, queryTerms, locatorPrefix) * graphSearchSymbolKindWeight(node.symbolKind);
    if (queryTerms.size && score <= 0) continue;
    results.push({
      resultType: 'node',
      id: node.id,
      kind: node.kind,
      label: node.label,
      qualifiedLabel: node.qualifiedLabel,
      locator: node.locator,
      symbolKind: node.symbolKind,
      scopeChain: node.scopeChain,
      score,
      reasonCodes: sourceGraphSearchReasons({ score, pattern, locatorPrefix })
    });
  }

  for (const edge of includeEdges ? graph.edges : []) {
    if (edgeKindSet && !edgeKindSet.has(edge.kind)) continue;
    if (locatorPrefix && !(edge.locator ?? '').startsWith(locatorPrefix)) continue;
    const from = nodeById.get(edge.fromNodeId);
    const to = nodeById.get(edge.toNodeId);
    const fromPathWeight = from?.locator ? graphSearchPathWeight(from.locator, queryTerms, locatorPrefix) : 1;
    const score = graphSearchScore(queryTerms, sourceGraphEdgeSearchText(edge, from, to)) * graphSearchPathWeight(edge.locator, queryTerms, locatorPrefix) * fromPathWeight * graphSearchEdgeKindWeight(edge.kind);
    if (queryTerms.size && score <= 0) continue;
    const fromLabel = from?.qualifiedLabel ?? from?.label ?? edge.fromNodeId;
    const toLabel = to?.qualifiedLabel ?? to?.label ?? edge.toNodeId;
    const exportLabel = edge.exportName && edge.exportName !== to?.label ? ` ${edge.exportName}` : '';
    results.push({
      resultType: 'edge',
      id: edge.id,
      kind: edge.kind,
      label: `${fromLabel} ${edge.kind}${exportLabel} ${toLabel}`,
      locator: edge.locator,
      exportName: edge.exportName,
      fromNodeId: edge.fromNodeId,
      fromLabel: from?.label,
      fromQualifiedLabel: from?.qualifiedLabel,
      fromLocator: from?.locator,
      fromKind: from?.kind,
      fromSymbolKind: from?.symbolKind,
      toNodeId: edge.toNodeId,
      toLabel: to?.label,
      toQualifiedLabel: to?.qualifiedLabel,
      toLocator: to?.locator,
      toKind: to?.kind,
      toSymbolKind: to?.symbolKind,
      score,
      reasonCodes: sourceGraphSearchReasons({ score, pattern: null, locatorPrefix })
    });
  }

  const sorted = sourceGraphSearchDeduplicateResults(results.sort((a, b) => (
    b.score - a.score ||
    graphSearchPathPriority(a.locator) - graphSearchPathPriority(b.locator) ||
    a.resultType.localeCompare(b.resultType) ||
    a.id.localeCompare(b.id)
  )));
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
    results: page.map((item) => Object.freeze(withDefined({ ...item, score: Number(item.score.toFixed(6)) })))
  });
}

function sourceGraphSearchDeduplicateResults(results) {
  const byKey = new Map();
  const order = [];
  for (const item of results) {
    const key = sourceGraphSearchResultDedupeKey(item);
    if (!key) {
      order.push(item);
      continue;
    }
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, item);
      order.push(key);
      continue;
    }
    if (sourceGraphSearchResultSpecificity(item) > sourceGraphSearchResultSpecificity(current)) byKey.set(key, item);
  }
  return order.map((item) => typeof item === 'string' ? byKey.get(item) : item);
}

function sourceGraphSearchResultDedupeKey(item) {
  if (item?.resultType === 'node' && item.kind === 'symbol' && item.id) return `symbol:${item.id}`;
  if (item?.resultType !== 'edge' || item.kind !== 'exports' || !item.fromNodeId || !item.toNodeId) return null;
  if ((!item.exportName || item.exportName === item.toLabel) && sourceGraphSameLocatorFile(item.locator, item.toLocator)) return `symbol:${item.toNodeId}`;
  return `exports:${item.fromNodeId}:${item.toNodeId}:${item.exportName ?? ''}`;
}

function sourceGraphSameLocatorFile(left, right) {
  return Boolean(left && right && String(left).split('#')[0] === String(right).split('#')[0]);
}

function sourceGraphSearchResultSpecificity(item) {
  if (item?.resultType === 'node') return 2;
  return String(item?.locator ?? '').includes('#L') ? 1 : 0;
}

export function traceSourceGraph(graph, {
  startName = null,
  startNodeId = null,
  edgeKinds = ['calls'],
  locatorPrefix = null,
  direction = 'outbound',
  depth = 2,
  limit = 20
} = {}) {
  assertSourceGraph(graph);
  const boundedDepth = boundedInteger(depth, 'source_graph_trace_depth', 1, 5);
  const boundedLimit = boundedInteger(limit, 'source_graph_trace_limit', 1, 100);
  if (!['outbound', 'inbound', 'both'].includes(direction)) throw new Error(`source_graph_trace_direction_invalid:${direction}`);
  const safeLocatorPrefix = locatorPrefix ? String(locatorPrefix) : null;
  const edgeKindSet = new Set(edgeKinds ?? ['calls']);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const starts = sourceGraphTraceStartNodes(graph, nodeById, { startName, startNodeId, locatorPrefix: safeLocatorPrefix });
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
  const queue = starts.map((node) => ({ nodeIds: [node.id], edgeIds: [], edgeKinds: [], edgeLocators: [], currentNodeId: node.id }));
  const paths = starts
    .filter((node) => !safeLocatorPrefix || (node.locator ?? '').startsWith(safeLocatorPrefix))
    .slice(0, boundedLimit)
    .map((node) => Object.freeze(withDefined({
      depth: 0,
      nodeIds: [node.id],
      edgeIds: [],
      edgeKinds: [],
      edgeLocators: [],
      terminalNodeId: node.id,
      terminalLabel: node.label,
      terminalQualifiedLabel: node.qualifiedLabel,
      terminalLocator: node.locator,
      terminalKind: node.kind,
      terminalSymbolKind: node.symbolKind,
      terminalScopeChain: node.scopeChain
    })));
  while (queue.length && paths.length < boundedLimit) {
    const item = queue.shift();
    if (item.edgeIds.length >= boundedDepth) continue;
    const nextEdges = [
      ...(['outbound', 'both'].includes(direction) ? (outgoing.get(item.currentNodeId) ?? []).map((edge) => ({ edge, nextNodeId: edge.toNodeId })) : []),
      ...(['inbound', 'both'].includes(direction) ? (incoming.get(item.currentNodeId) ?? []).map((edge) => ({ edge, nextNodeId: edge.fromNodeId })) : [])
    ].sort((a, b) => sourceGraphTraceNextPriority(a, nodeById) - sourceGraphTraceNextPriority(b, nodeById) || a.edge.id.localeCompare(b.edge.id));
    for (const { edge, nextNodeId } of nextEdges) {
      if (item.nodeIds.includes(nextNodeId)) continue;
      const nextPath = {
        nodeIds: [...item.nodeIds, nextNodeId],
        edgeIds: [...item.edgeIds, edge.id],
        edgeKinds: [...item.edgeKinds, edge.kind],
        edgeLocators: [...item.edgeLocators, edge.locator],
        currentNodeId: nextNodeId
      };
      const terminal = nodeById.get(nextNodeId);
      if (safeLocatorPrefix && !(terminal?.locator ?? '').startsWith(safeLocatorPrefix)) continue;
      paths.push(Object.freeze(withDefined({
        depth: nextPath.edgeIds.length,
        nodeIds: nextPath.nodeIds,
        edgeIds: nextPath.edgeIds,
        edgeKinds: nextPath.edgeKinds,
        edgeLocators: nextPath.edgeLocators,
        terminalNodeId: nextNodeId,
        terminalLabel: terminal?.label ?? nextNodeId,
        terminalQualifiedLabel: terminal?.qualifiedLabel,
        terminalLocator: terminal?.locator,
        terminalKind: terminal?.kind,
        terminalSymbolKind: terminal?.symbolKind,
        terminalScopeChain: terminal?.scopeChain
      })));
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

function sourceGraphTraceNextPriority(item, nodeById) {
  const node = nodeById.get(item.nextNodeId);
  return graphSearchPathPriority(node?.locator ?? item.edge.locator);
}

function sourceGraphTraceStartNodes(graph, nodeById, { startName = null, startNodeId = null, locatorPrefix = null } = {}) {
  if (startNodeId) return graph.nodes.filter((node) => node.id === startNodeId);
  const startTag = safeTag(startName);
  if (!startTag) return [];
  const startsById = new Map();
  for (const node of graph.nodes) {
    if (node.kind === 'symbol' && (safeTag(node.label) === startTag || safeTag(node.qualifiedLabel) === startTag)) {
      startsById.set(node.id, node);
    }
  }
  for (const edge of graph.edges) {
    if (edge.kind !== 'exports' || safeTag(edge.exportName) !== startTag) continue;
    const target = nodeById.get(edge.toNodeId);
    if (target?.kind === 'symbol') startsById.set(target.id, target);
  }
  const ranked = [...startsById.values()]
    .filter((node) => !locatorPrefix || (node.locator ?? '').startsWith(locatorPrefix))
    .sort((a, b) => graphSearchPathPriority(a.locator) - graphSearchPathPriority(b.locator) || a.locator.localeCompare(b.locator) || a.id.localeCompare(b.id));
  const sourceRanked = locatorPrefix ? [] : ranked.filter((node) => graphSearchPathPriority(node.locator) <= 1);
  return sourceRanked.length ? sourceRanked : ranked;
}

export function mapSourceGraphDiffImpact(graph, { changedLocators = [], depth = 2, limit = 100 } = {}) {
  assertSourceGraph(graph);
  const boundedDepth = boundedInteger(depth, 'source_graph_diff_depth', 1, 5);
  const boundedLimit = boundedInteger(limit, 'source_graph_diff_limit', 1, 500);
  const changed = new Set(changedLocators.map(fileLocatorFor));
  const startNodes = graph.nodes.filter((node) => node.kind === 'file' && changed.has(node.locator));
  const representedChangedLocators = startNodes.map((node) => node.locator).sort();
  const adjacency = new Map();
  const behaviorDegree = new Map(graph.nodes.map((node) => [node.id, { inbound: 0, outbound: 0 }]));
  const exportedSymbolIds = new Set();
  for (const edge of graph.edges) {
    if (edge.kind === 'exports') exportedSymbolIds.add(edge.toNodeId);
    if (edge.kind === 'calls' || edge.kind === 'references') {
      const from = behaviorDegree.get(edge.fromNodeId);
      const to = behaviorDegree.get(edge.toNodeId);
      if (from) from.outbound += 1;
      if (to) to.inbound += 1;
    }
    const fromValues = adjacency.get(edge.fromNodeId) ?? [];
    fromValues.push({ edge, nextNodeId: edge.toNodeId });
    adjacency.set(edge.fromNodeId, fromValues);
    const toValues = adjacency.get(edge.toNodeId) ?? [];
    toValues.push({ edge, nextNodeId: edge.fromNodeId });
    adjacency.set(edge.toNodeId, toValues);
  }
  const sameFileSymbolNodes = graph.nodes
    .filter((node) => node.kind === 'symbol' && changed.has(fileLocatorFor(node.locator)))
    .sort((a, b) => sourceGraphImpactSymbolRank(b, behaviorDegree, exportedSymbolIds) - sourceGraphImpactSymbolRank(a, behaviorDegree, exportedSymbolIds) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  const seedNodes = (sameFileSymbolNodes.length ? sameFileSymbolNodes : startNodes).slice(0, boundedLimit);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const edgeById = new Map(graph.edges.map((edge) => [edge.id, edge]));
  const impactedNodes = new Set(seedNodes.map((node) => node.id));
  const impactedEdges = new Set();
  const queue = seedNodes.filter((node) => impactedNodes.has(node.id)).map((node) => ({ nodeId: node.id, depth: 0 }));
  while (queue.length) {
    const item = queue.shift();
    if (item.depth >= boundedDepth) continue;
    for (const { edge, nextNodeId } of (adjacency.get(item.nodeId) ?? []).sort((a, b) => a.edge.id.localeCompare(b.edge.id))) {
      impactedEdges.add(edge.id);
      if (!impactedNodes.has(nextNodeId) && impactedNodes.size < boundedLimit) {
        impactedNodes.add(nextNodeId);
        queue.push({ nodeId: nextNodeId, depth: item.depth + 1 });
      }
    }
  }
  const affectedSymbols = [...impactedNodes]
    .map((id) => nodeById.get(id))
    .filter((node) => node?.kind === 'symbol')
    .sort((a, b) => sourceGraphImpactSymbolRank(b, behaviorDegree, exportedSymbolIds) - sourceGraphImpactSymbolRank(a, behaviorDegree, exportedSymbolIds) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
    .map((node) => withDefined({ nodeId: node.id, name: node.label, qualifiedName: node.qualifiedLabel, locator: node.locator, symbolKind: node.symbolKind }));
  const impactedEdgeKindCounts = countBy([...impactedEdges].map((id) => edgeById.get(id)).filter(Boolean), (edge) => edge.kind);
  return Object.freeze({
    schemaVersion: '1.0.0',
    workspaceId: graph.workspaceId,
    graphFingerprint: graph.graphFingerprint,
    changedLocators: [...changed].sort(),
    representedChangedLocators,
    depth: boundedDepth,
    impactedNodeIds: [...impactedNodes].sort(),
    impactedEdgeIds: [...impactedEdges].sort(),
    impactedEdgeKindCounts,
    affectedSymbols
  });
}

function sourceGraphImpactSymbolRank(node, behaviorDegree, exportedSymbolIds) {
  const pathPriority = graphSearchPathPriority(node.locator);
  const counts = behaviorDegree.get(node.id) ?? { inbound: 0, outbound: 0 };
  const behaviorTotal = counts.inbound + counts.outbound;
  const scopeChain = Array.isArray(node.scopeChain) ? node.scopeChain.filter(Boolean) : [];
  let score = pathPriority === 1 ? 4 : pathPriority === 2 ? 2 : pathPriority === 3 ? -24 : -30;
  if (exportedSymbolIds.has(node.id)) score += ['type', 'interface'].includes(node.symbolKind) ? 16 : 40;
  if (!scopeChain.length) score += 18;
  else if (/^[A-Z]/u.test(scopeChain[0] ?? '')) score += 12;
  else score -= 8;
  if (node.qualifiedLabel) score += 6;
  if (node.symbolKind === 'class') score += 22;
  else if (['function', 'method'].includes(node.symbolKind)) score += 10;
  else if (['interface', 'type'].includes(node.symbolKind)) score += 2;
  if (highSignalReferenceName(node.label, [])) score += 4;
  else score -= 12;
  return score + (node.symbolKind === 'class' ? Math.min(40, counts.inbound) : Math.min(8, behaviorTotal));
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
  const declarations = declarationsFor(lines, relativePath);
  const chunks = [];
  for (const declaration of declarations) {
    const endLine = declaration.endLine ?? declarationEndLineForDeclaration(lines, declaration);
    const sourceSlice = lines.slice(declaration.startLine, endLine + 1).join('\n');
    const parseErrorState = bracesBalanced(sourceSlice) ? 'none' : 'unbalanced_braces';
    const lineRange = { start: declaration.startLine + 1, end: endLine + 1 };
    const byteRange = {
      start: lineStartBytes[declaration.startLine],
      end: lineStartBytes[endLine] + Buffer.byteLength(lines[endLine] ?? '', 'utf8')
    };
    const entities = entitiesForDeclaration(declaration, sourceSlice);
    const signature = signatureFor(declaration, sourceSlice);
    const declarationCalls = declaration.kind === 'class' ? inheritanceCallsForDeclaration(declaration, sourceSlice, fileImports) : CALLABLE_DECLARATION_KINDS.has(declaration.kind) ? callsForDeclaration(declaration, sourceSlice, fileImports) : [];
    const calls = declarationCalls.map((call) => withDefined({ ...call, callHash: hashRef(`${relativePath}:${lineRange.start}:${call.receiver ? `${call.receiver}.` : ''}${call.name}`) }));
    const references = referencesForSource(sourceSlice).map((name) => ({ name, referenceHash: hashRef(`${relativePath}:${lineRange.start}:${name}`) }));
    const imports = declaration.kind === 'class' && !declarationCalls.length ? [] : importsForSlice(fileImports, sourceSlice).map(publicImport);
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

function declarationsFor(lines, relativePath = '') {
  const declarations = [];
  const scopeStack = [];
  let braceDepth = 0;
  const defaultName = defaultExportName(relativePath);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const trimmed = raw.trim();
    while (scopeStack.length && scopeEnded(scopeStack[scopeStack.length - 1], { index, braceDepth, raw, trimmed })) scopeStack.pop();
    const classMatch = trimmed.match(/^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/u);
    const functionMatch = trimmed.match(/^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/u);
    const anonymousDefaultClassMatch = trimmed.match(/^export\s+default\s+class(?:\s+extends\b|\s*\{)/u);
    const anonymousDefaultFunctionMatch = trimmed.match(/^export\s+default\s+(?:async\s+)?function\s*\(/u);
    const defaultWrapperFunctionMatch = trimmed.match(/^export\s+default\s+(?:React\.)?(?:memo|forwardRef)\s*\(\s*(?:async\s+)?function(?:\s+([A-Za-z_$][\w$]*))?\s*\(/u);
    const defaultWrapperArrowMatch = trimmed.match(/^export\s+default\s+(?:React\.)?(?:memo|forwardRef)\s*\(\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)(?:\s*:\s*[^=]+)?\s*=>/u);
    const anonymousDefaultArrowMatch = trimmed.match(/^export\s+default\s+(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)(?:\s*:\s*[^=]+)?\s*=>/u);
    const variableFunctionMatch = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?function(?:\s+[A-Za-z_$][\w$]*)?\s*\(/u);
    const arrowMatch = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)(?:\s*:\s*[^=]+)?\s*=>/u);
    const wrapperFunctionMatch = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:React\.)?(?:memo|forwardRef)\s*\(\s*(?:async\s+)?function(?:\s+[A-Za-z_$][\w$]*)?\s*\(/u);
    const arrowStartMatch = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\(\s*$|[A-Za-z_$][\w$]*(?:\s*:\s*[^=]+)?\s*$|$)/u);
    const objectScopeMatch = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*\{\s*$/u);
    const defaultObjectScopeMatch = trimmed.match(/^export\s+default\s+\{\s*$/u);
    const commonJsObjectScopeMatch = trimmed.match(/^((?:module\.)?exports(?:\.[A-Za-z_$][\w$]*)?)\s*=\s*\{\s*$/u);
    const propertyObjectScopeMatch = scopeStack.length ? trimmed.match(/^([A-Za-z_$][\w$]*)\s*:\s*\{\s*$/u) : null;
    const interfaceMatch = trimmed.match(/^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/u);
    const typeMatch = trimmed.match(/^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/u);
    const assignmentFunctionMatch = trimmed.match(/^(?:(?:module\.)?exports|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function(?:\s+([A-Za-z_$][\w$]*))?\s*\(/u);
    const assignmentArrowMatch = trimmed.match(/^(?:(?:module\.)?exports|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)(?:\s*:\s*[^=]+)?\s*=>/u);
    const objectFunctionMatch = trimmed.match(/^([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?function(?:\s+([A-Za-z_$][\w$]*))?\s*\(/u);
    const objectArrowMatch = trimmed.match(/^([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)(?:\s*:\s*[^=]+)?\s*=>/u);
    const classFieldFunctionMatch = scopeStack.length ? trimmed.match(/^(?:(?:public|private|protected|readonly|override|static)\s+)*(#?[A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function(?:\s+[A-Za-z_$][\w$]*)?\s*\(/u) : null;
    const classFieldArrowMatch = scopeStack.length ? trimmed.match(/^(?:(?:public|private|protected|readonly|override|static)\s+)*(#?[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)(?:\s*:\s*[^=]+)?\s*=>/u) : null;
    const callableClassPropertyMatch = scopeStack.length ? trimmed.match(/^(?:(?:public|private|protected|readonly|override|static)\s+)*(#?[A-Za-z_$][\w$]*)!?\s*:\s*([^=;]+);?$/u) : null;
    const methodMatch = trimmed.match(/^(?:static\s+)?(?:(?:get|set)\s+)?(?:async\s+)?(#?[A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{/u);
    const exported = /^export\s+/u.test(trimmed);
    if (classMatch) {
      declarations.push({ kind: 'class', name: classMatch[1], startLine: index, scopeChain: scopeStack.map((item) => item.name), exported });
      scopeStack.push(classScope(classMatch[1], lines, index, braceDepth));
    } else if (functionMatch) {
      declarations.push({ kind: 'function', name: functionMatch[1], startLine: index, scopeChain: scopeStack.map((item) => item.name), exported });
      pushFunctionScope(scopeStack, functionMatch[1], lines, index);
    } else if (anonymousDefaultClassMatch) {
      declarations.push({ kind: 'class', name: defaultName, startLine: index, scopeChain: scopeStack.map((item) => item.name), exported: true });
      scopeStack.push(classScope(defaultName, lines, index, braceDepth));
    } else if (anonymousDefaultFunctionMatch) {
      declarations.push({ kind: 'function', name: defaultName, startLine: index, scopeChain: scopeStack.map((item) => item.name), exported: true });
    } else if (defaultWrapperFunctionMatch) {
      declarations.push({ kind: 'function', name: defaultWrapperFunctionMatch[1] ?? defaultName, startLine: index, scopeChain: scopeStack.map((item) => item.name), exported: true });
    } else if (defaultWrapperArrowMatch) {
      declarations.push({ kind: 'function', name: defaultName, startLine: index, scopeChain: scopeStack.map((item) => item.name), exported: true });
    } else if (anonymousDefaultArrowMatch) {
      declarations.push({ kind: 'function', name: defaultName, startLine: index, scopeChain: scopeStack.map((item) => item.name), exported: true });
    } else if (variableFunctionMatch) {
      declarations.push({ kind: 'function', name: variableFunctionMatch[1], startLine: index, scopeChain: scopeStack.map((item) => item.name), exported });
      pushFunctionScope(scopeStack, variableFunctionMatch[1], lines, index);
    } else if (wrapperFunctionMatch) {
      declarations.push({ kind: 'function', name: wrapperFunctionMatch[1], startLine: index, scopeChain: scopeStack.map((item) => item.name), exported });
    } else if (defaultObjectScopeMatch) {
      scopeStack.push({ name: defaultName, depth: braceDepth + Math.max(1, braceDelta(raw)) });
    } else if (commonJsObjectScopeMatch) {
      scopeStack.push({ name: commonJsObjectScopeMatch[1], depth: braceDepth + Math.max(1, braceDelta(raw)) });
    } else if (objectScopeMatch) {
      scopeStack.push({ name: objectScopeMatch[1], depth: braceDepth + Math.max(1, braceDelta(raw)) });
    } else if (propertyObjectScopeMatch) {
      scopeStack.push({ name: propertyObjectScopeMatch[1], depth: braceDepth + Math.max(1, braceDelta(raw)) });
    } else if (arrowMatch || (arrowStartMatch && arrowDeclarationHasArrow(lines, index))) {
      declarations.push({ kind: 'function', name: (arrowMatch ?? arrowStartMatch)[1], startLine: index, scopeChain: scopeStack.map((item) => item.name), exported });
      pushFunctionScope(scopeStack, (arrowMatch ?? arrowStartMatch)[1], lines, index);
    } else if (interfaceMatch) {
      declarations.push({ kind: 'interface', name: interfaceMatch[1], startLine: index, scopeChain: scopeStack.map((item) => item.name), exported });
    } else if (typeMatch) {
      declarations.push({ kind: 'type', name: typeMatch[1], startLine: index, scopeChain: scopeStack.map((item) => item.name), exported });
    } else if (assignmentFunctionMatch) {
      declarations.push({ kind: 'function', name: assignmentFunctionMatch[1] || assignmentFunctionMatch[2], startLine: index, scopeChain: assignmentScopeChain(trimmed) ?? scopeStack.map((item) => item.name), exported: assignmentExports(trimmed) });
    } else if (assignmentArrowMatch) {
      declarations.push({ kind: 'function', name: assignmentArrowMatch[1], startLine: index, scopeChain: assignmentScopeChain(trimmed) ?? scopeStack.map((item) => item.name), exported: assignmentExports(trimmed) });
    } else if (objectFunctionMatch) {
      declarations.push({ kind: 'method', name: objectFunctionMatch[1] || objectFunctionMatch[2], startLine: index, scopeChain: scopeStack.map((item) => item.name), exported: false });
    } else if (objectArrowMatch) {
      declarations.push({ kind: 'method', name: objectArrowMatch[1], startLine: index, scopeChain: scopeStack.map((item) => item.name), exported: false });
    } else if (classFieldFunctionMatch) {
      declarations.push({ kind: 'method', name: classFieldFunctionMatch[1], startLine: index, scopeChain: scopeStack.map((item) => item.name), exported: false });
    } else if (classFieldArrowMatch) {
      declarations.push({ kind: 'method', name: classFieldArrowMatch[1], startLine: index, scopeChain: scopeStack.map((item) => item.name), exported: false });
    } else if (callableClassPropertyMatch && callableClassPropertyType(callableClassPropertyMatch[2])) {
      declarations.push({ kind: 'method', name: callableClassPropertyMatch[1], startLine: index, endLine: index, scopeChain: scopeStack.map((item) => item.name), exported: false });
    } else if (methodMatch && !CONTROL_FLOW_NAMES.has(methodMatch[1])) {
      declarations.push({ kind: 'method', name: methodMatch[1], startLine: index, scopeChain: scopeStack.map((item) => item.name), exported: false });
    }
    braceDepth += braceDelta(raw);
  }
  return declarations;
}

function scopeEnded(scope, { index, braceDepth, raw, trimmed }) {
  if (Number.isInteger(scope.pendingUntil) && index <= scope.pendingUntil) return false;
  if (Number.isInteger(scope.indent)) return index > scope.startLine && trimmed && leadingWhitespace(raw) <= scope.indent;
  return braceDepth < scope.depth;
}

function classScope(name, lines, index, braceDepth) {
  const openLine = openingBraceLine(lines, index);
  return { name, depth: braceDepth + Math.max(1, braceDelta(lines[openLine] ?? lines[index] ?? '')), pendingUntil: openLine };
}

function openingBraceLine(lines, startLine) {
  const limit = Math.min(lines.length, startLine + 30);
  for (let index = startLine; index < limit; index += 1) {
    const line = String(lines[index] ?? '');
    if (braceDelta(line) > 0 || (index === startLine && line.includes('{'))) return index;
  }
  return startLine;
}

function pushFunctionScope(scopeStack, name, lines, index) {
  if (declarationEndLine(lines, index) > index) scopeStack.push({ name, startLine: index, indent: leadingWhitespace(lines[index] ?? '') });
}

function leadingWhitespace(value) {
  return String(value ?? '').match(/^\s*/u)?.[0]?.length ?? 0;
}

function callableClassPropertyType(typeText) {
  return /\b(?:HandlerInterface|MiddlewareHandlerInterface|OnHandlerInterface|GetPath|ErrorHandler|NotFoundHandler)\b/u.test(String(typeText ?? ''));
}

function defaultExportName(relativePath) {
  const withoutExtension = String(relativePath ?? '').replace(/\.[^.]+$/u, '');
  const parts = withoutExtension.split('/').filter(Boolean);
  const base = parts.at(-1) === 'index' ? parts.at(-2) : parts.at(-1);
  return `default:${safeTag(base ?? 'export')}`;
}

function arrowDeclarationHasArrow(lines, startLine) {
  const limit = Math.min(lines.length, startLine + 30);
  for (let index = startLine; index < limit; index += 1) {
    const line = stripStringsAndComments(lines[index]);
    if (line.includes('=>')) return true;
    if (/;\s*$/u.test(line.trim())) return false;
  }
  return false;
}

function assignmentExports(trimmed) {
  return /^(?:(?:module\.)?exports)\./u.test(String(trimmed ?? ''));
}

function assignmentScopeChain(trimmed) {
  const lhs = String(trimmed ?? '').split('=')[0]?.trim() ?? '';
  const parts = lhs.split('.').filter(Boolean);
  if (parts.length < 3 || parts[1] !== 'prototype') return null;
  return [`${parts[0]}.prototype`];
}

function entitiesForDeclaration(declaration, sourceSlice) {
  const entities = [{ kind: declaration.kind, name: declaration.name }];
  return Object.freeze(entities.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)));
}

function declarationEndLineForDeclaration(lines, declaration) {
  if (['type', 'interface'].includes(declaration?.kind)) return typeLikeDeclarationEndLine(lines, declaration.startLine);
  return declarationEndLine(lines, declaration.startLine);
}

function typeLikeDeclarationEndLine(lines, startLine) {
  let depth = 0;
  let sawBrace = false;
  let lastContentLine = startLine;
  const state = { inBlockComment: false };
  for (let index = startLine; index < lines.length; index += 1) {
    const cleaned = stripDeclarationBoundaryCommentsAndStrings(lines[index], state);
    const trimmed = cleaned.trim();
    const delta = braceDeltaFromCleaned(cleaned);
    if (trimmed) lastContentLine = index;
    if (delta > 0 || (index === startLine && cleaned.includes('{'))) sawBrace = true;
    depth += delta;
    if (sawBrace && depth <= 0) return index;
    if (!sawBrace && /;\s*$/u.test(trimmed)) return index;
    if (!sawBrace && index === startLine && typeAliasLooksComplete(trimmed)) return index;
    if (!sawBrace && index > startLine && trimmed && !typeAliasContinuationLine(trimmed)) return Math.max(startLine, index - 1);
    if (!sawBrace && index > startLine && !trimmed && lastContentLine > startLine) return lastContentLine;
  }
  return lines.length - 1;
}

function typeAliasLooksComplete(trimmed) {
  return /^export\s+interface\b/u.test(trimmed)
    || (/^(?:export\s+)?type\b/u.test(trimmed) && /=/u.test(trimmed) && !/[=|&({,]\s*$/u.test(trimmed));
}

function typeAliasContinuationLine(trimmed) {
  return /^[|&})\],]/u.test(trimmed)
    || /^[A-Za-z_$][\w$]*\??\s*:/u.test(trimmed)
    || /^(?:readonly\s+)?[A-Za-z_$][\w$]*\s*\(/u.test(trimmed);
}

function stripDeclarationBoundaryCommentsAndStrings(text, state = { inBlockComment: false }) {
  const input = String(text ?? '');
  let output = '';
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];
    if (state.inBlockComment) {
      if (char === '*' && next === '/') {
        state.inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (char === '/' && next === '*') {
      state.inBlockComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '/') break;
    if (char === '\'' || char === '"' || char === '`') {
      const quote = char;
      index += 1;
      while (index < input.length) {
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

function braceDeltaFromCleaned(text) {
  let delta = 0;
  for (const char of String(text ?? '')) {
    if (char === '{') delta += 1;
    else if (char === '}') delta -= 1;
  }
  return delta;
}

function declarationEndLine(lines, startLine) {
  let depth = 0;
  let sawBrace = false;
  for (let index = startLine; index < lines.length; index += 1) {
    const delta = braceDelta(lines[index]);
    if (delta > 0 || (index === startLine && lines[index].includes('{'))) sawBrace = true;
    depth += delta;
    if (sawBrace && depth <= 0) return index;
    if (!sawBrace && /;\s*$/u.test(lines[index].trim())) return index;
  }
  return lines.length - 1;
}

function importsFor(body) {
  const imports = [];
  for (const match of String(body ?? '').matchAll(/^\s*import(?!\s*['"])(?:\s+type)?\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gmu)) {
    const rawModule = match[2];
    const module = sanitizeModuleSpecifier(rawModule);
    imports.push({
      module,
      rawModule,
      syntax: 'static',
      importHash: hashRef(rawModule),
      names: importedNames(match[1]),
      namespace: namespaceImportedName(match[1]),
      aliases: { ...importedAliases(match[1]), ...defaultImportedAliases(match[1], rawModule) }
    });
  }
  for (const line of body.split('\n')) {
    const trimmedLine = line.trim();
    const bareMatch = line.match(/^\s*import\s+['"]([^'"]+)['"]/u);
    const dynamicImportMatch = /^(?:\/[/*]|\*)/u.test(trimmedLine) ? null : line.match(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/u);
    const requireMatch = line.match(/require\(\s*['"]([^'"]+)['"]\s*\)/u);
    const requireBinding = line.match(/\b(?:const|let|var)\s+(.+?)\s*=\s*require\(/u)?.[1]?.trim() ?? null;
    const requireName = requireBinding?.match(/^[A-Za-z_$][\w$]*$/u)?.[0] ?? null;
    const rawModule = bareMatch?.[1] ?? dynamicImportMatch?.[1] ?? requireMatch?.[1] ?? null;
    if (rawModule) {
      const module = sanitizeModuleSpecifier(rawModule);
      imports.push({
        module,
        rawModule,
        syntax: dynamicImportMatch ? 'dynamic' : requireMatch ? 'require' : 'static',
        importHash: hashRef(rawModule),
        names: requireName ? [requireName] : importedRequireNames(requireBinding),
        aliases: importedRequireAliases(requireBinding)
      });
    }
  }
  return mergeImports(imports);
}

function mergeImports(imports) {
  const byKey = new Map();
  for (const item of imports) {
    const key = `${item.syntax}:${item.module}`;
    const existing = byKey.get(key);
    byKey.set(key, existing ? {
      ...existing,
      names: [...new Set([...(existing.names ?? []), ...(item.names ?? [])])].sort(),
      namespace: existing.namespace ?? item.namespace,
      aliases: { ...(existing.aliases ?? {}), ...(item.aliases ?? {}) }
    } : item);
  }
  return [...byKey.values()];
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
  const symbolsByChunkId = new Map();
  const knownFileLocators = new Set(fileOutlines.map((file) => file.locator));
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
      const chunkValues = symbolsByChunkId.get(chunk.id) ?? [];
      chunkValues.push(symbol);
      symbolsByChunkId.set(chunk.id, chunkValues);
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
  const defaultExportTargetByFileLocator = defaultExportTargetsForFiles(fileOutlines, symbols);
  const fileOutlineByLocator = new Map(fileOutlines.map((file) => [file.locator, file]));
  for (const file of fileOutlines) {
    for (const item of file.exports ?? []) {
      const reExportFileLocator = item.module ? resolveImportFileLocator(file.locator, item.module, knownFileLocators) : null;
      if (item.namespace && reExportFileLocator) {
        const target = symbols.find((symbol) => fileLocatorFor(symbol.locator) === reExportFileLocator);
        const chunkId = target?.chunkId ?? file.chunkIds?.[0];
        if (!chunkId) continue;
        exports.push({
          id: `export_${sha256(`${file.locator}:namespace:${item.name}:${target?.id ?? chunkId}`).slice(0, 32)}`,
          workspaceId,
          name: item.name,
          kind: item.kind,
          locator: file.locator,
          chunkId,
          exportHash: item.exportHash
        });
        continue;
      }
      if (item.star && reExportFileLocator) {
        for (const target of symbols.filter((symbol) => fileLocatorFor(symbol.locator) === reExportFileLocator)) {
          exports.push({
            id: `export_${sha256(`${file.locator}:star:${target.id}`).slice(0, 32)}`,
            workspaceId,
            name: target.name,
            kind: target.kind,
            locator: file.locator,
            chunkId: target.chunkId,
            exportHash: item.exportHash
          });
        }
        continue;
      }
      const targetName = reExportFileLocator && item.targetName === 'default'
        ? defaultExportTargetByFileLocator.get(reExportFileLocator) ?? defaultExportName(relativeFromLocator(reExportFileLocator))
        : item.targetName ?? item.name;
      const target = symbols.find((symbol) => symbol.name === targetName && fileLocatorFor(symbol.locator) === (reExportFileLocator ?? file.locator));
      const chunkId = target?.chunkId ?? file.chunkIds?.[0];
      if (!chunkId) continue;
      exports.push({
        id: `export_${sha256(`${file.locator}:${item.name}:${targetName}:${target?.id ?? chunkId}`).slice(0, 32)}`,
        workspaceId,
        name: item.name,
        kind: target?.kind ?? item.kind,
        locator: file.locator,
        chunkId,
        exportHash: item.exportHash
      });
    }
  }
  const exportsByFileAndName = exportsByFileName(exports);

  for (const chunk of chunks) {
    const caller = chunk.entities.find((entity) => entity.kind === 'class') ?? chunk.entities.find((entity) => ['function', 'method'].includes(entity.kind)) ?? chunk.entities[0];
    let referenceEdgesForChunk = 0;
    for (const reference of (chunk.references ?? []).slice(0, MAX_REFERENCES_PER_CHUNK)) {
      if (referenceEdgesForChunk >= MAX_REFERENCE_EDGES_PER_CHUNK) break;
      const targets = symbolsByName.get(reference.name) ?? [];
      if (!targets.length || !highSignalReferenceName(reference.name, targets)) continue;
      for (const target of targets.slice(0, MAX_TARGETS_PER_SYMBOL_NAME)) {
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
    const importedFileLocators = new Set((chunk.imports ?? [])
      .map((item) => resolveImportFileLocator(chunk.locator, item.module, knownFileLocators))
      .filter(Boolean));
    for (const item of chunk.imports ?? []) {
      const fileLocator = resolveImportFileLocator(chunk.locator, item.module, knownFileLocators);
      if (!fileLocator) continue;
      for (const exported of exports.filter((candidate) => fileLocatorFor(candidate.locator) === fileLocator)) {
        const targetSymbol = symbolsByChunkId.get(exported.chunkId)?.[0];
        if (targetSymbol) importedFileLocators.add(fileLocatorFor(targetSymbol.locator));
      }
    }
    let callEdgesForChunk = 0;
    for (const call of (chunk.calls ?? []).slice(0, MAX_CALLS_PER_CHUNK)) {
      if (callEdgesForChunk >= MAX_CALL_EDGES_PER_CHUNK) break;
      const namedImportTargets = importedNamedCallTargets(call, { chunk, knownFileLocators, exportsByFileAndName, symbolsByChunkId, fileOutlineByLocator }) ?? [];
      const defaultImportTargets = namedImportTargets.length ? [] : importedDefaultCallTargets(call.name, { importedFileLocators, defaultExportTargetByFileLocator, symbolsByName });
      const importedTargets = namedImportTargets.length ? namedImportTargets : defaultImportTargets;
      const fallbackTargets = symbolsByName.get(call.name) ?? [];
      const matchingSymbols = importedTargets?.length
        ? importedTargets
        : LOW_SIGNAL_REFERENCE_NAMES.has(call.name) ? [] : fallbackTargets;
      if (!matchingSymbols.length) continue;
      const targets = prioritizeCallTargets(matchingSymbols, { sourceLocator: chunk.locator, importedFileLocators });
      for (const callee of targets.slice(0, MAX_TARGETS_PER_SYMBOL_NAME)) {
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

function prioritizeCallTargets(targets = [], { sourceLocator, importedFileLocators }) {
  const sourceFile = fileLocatorFor(sourceLocator);
  const sourcePathPriority = graphSearchPathPriority(sourceLocator);
  const sorted = [...targets].sort((left, right) => (
    callTargetRank(left, sourceFile, importedFileLocators) - callTargetRank(right, sourceFile, importedFileLocators) ||
    left.locator.localeCompare(right.locator) ||
    left.id.localeCompare(right.id)
  ));
  const bestRank = sorted.length ? callTargetRank(sorted[0], sourceFile, importedFileLocators) : 0;
  const bestPriority = sorted.length ? callTargetPriority(sorted[0], sourceFile, importedFileLocators) : 0;
  const bestPathPriority = sorted.length ? graphSearchPathPriority(sorted[0].locator) : 0;
  if (sourcePathPriority === 1 && bestPriority === 2 && bestPathPriority >= 3) return [];
  return sorted.filter((target) => callTargetRank(target, sourceFile, importedFileLocators) === bestRank);
}

function callTargetRank(symbol, sourceFile, importedFileLocators) {
  return (callTargetPriority(symbol, sourceFile, importedFileLocators) * 10) + graphSearchPathPriority(symbol.locator);
}

function callTargetPriority(symbol, sourceFile, importedFileLocators) {
  const targetFile = fileLocatorFor(symbol.locator);
  if (targetFile === sourceFile) return 0;
  if (importedFileLocators?.has(targetFile)) return 1;
  return 2;
}

function qualifiedSymbolLabel(name, scopeChain = []) {
  const scope = Array.isArray(scopeChain) ? scopeChain.filter(Boolean).join('.') : '';
  return scope ? `${scope}.${name}` : undefined;
}

function highSignalReferenceName(name, targets = []) {
  const normalized = String(name ?? '');
  if (!normalized || JS_KEYWORDS.has(normalized) || LOW_SIGNAL_REFERENCE_NAMES.has(normalized)) return false;
  if (/^[a-z_$]{1,3}$/u.test(normalized)) return false;
  if (targets.length > MAX_REFERENCE_TARGETS_FOR_COMMON_NAME && !/[A-Z]/u.test(normalized) && normalized.length < 12) return false;
  return true;
}

function defaultExportTargetsForFiles(fileOutlines, symbols) {
  const symbolsByFileAndName = new Set(symbols.map((symbol) => `${fileLocatorFor(symbol.locator)}:${symbol.name}`));
  return new Map(fileOutlines.map((file) => {
    const explicit = file.exports?.find((item) => item.name === 'default' && item.targetName)?.targetName;
    const fallback = defaultExportName(relativeFromLocator(file.locator));
    const targetName = explicit ?? (symbolsByFileAndName.has(`${file.locator}:${fallback}`) ? fallback : null);
    return targetName ? [file.locator, targetName] : null;
  }).filter(Boolean));
}

function importedDefaultCallTargets(callName, { importedFileLocators, defaultExportTargetByFileLocator, symbolsByName }) {
  if (!String(callName ?? '').startsWith('default:')) return [];
  const targets = [];
  for (const fileLocator of importedFileLocators ?? []) {
    if (defaultExportName(relativeFromLocator(fileLocator)) !== callName) continue;
    const targetName = defaultExportTargetByFileLocator.get(fileLocator);
    targets.push(...(symbolsByName.get(targetName) ?? []).filter((symbol) => fileLocatorFor(symbol.locator) === fileLocator));
  }
  return targets;
}

function importedNamedCallTargets(call, { chunk, knownFileLocators, exportsByFileAndName, symbolsByChunkId, fileOutlineByLocator }) {
  const targets = [];
  for (const item of chunk.imports ?? []) {
    const fileLocator = resolveImportFileLocator(chunk.locator, item.module, knownFileLocators);
    if (!fileLocator) continue;
    if (call.receiver && call.receiver !== item.namespace) {
      const importedReceiver = item.aliases?.[call.receiver] ?? call.receiver;
      if (!item.names?.includes(call.receiver) && !Object.values(item.aliases ?? {}).includes(call.receiver)) continue;
      const namespaceExport = fileOutlineByLocator.get(fileLocator)?.exports?.find((candidate) => candidate.namespace && candidate.name === importedReceiver);
      const namespaceFileLocator = namespaceExport?.module ? resolveImportFileLocator(fileLocator, namespaceExport.module, knownFileLocators) : null;
      const exported = namespaceFileLocator ? exportsByFileAndName.get(`${namespaceFileLocator}:${call.name}`) : null;
      if (exported?.chunkId) targets.push(...(symbolsByChunkId.get(exported.chunkId) ?? []));
      continue;
    }
    const importedName = call.receiver === item.namespace ? call.name : item.aliases?.[call.name] ?? call.name;
    if (!call.receiver && !item.names?.includes(call.name) && !Object.values(item.aliases ?? {}).includes(call.name) && importedName === call.name && !item.names?.includes(importedName)) continue;
    const exported = fileLocator ? exportsByFileAndName.get(`${fileLocator}:${importedName}`) : null;
    if (exported?.chunkId) targets.push(...(symbolsByChunkId.get(exported.chunkId) ?? []));
  }
  return targets.length ? targets : null;
}

function exportsByFileName(exports) {
  const output = new Map();
  for (const item of exports) output.set(`${fileLocatorFor(item.locator)}:${item.name}`, item);
  return output;
}

function exportsFor({ body, chunks }) {
  const output = [];
  for (const chunk of chunks) output.push(...(chunk.exports ?? []));
  for (const match of body.matchAll(/^\s*export\s+\{([^}]+)\}(?:\s+from\s+['"]([^'"]+)['"])?/gmu)) {
    const module = match[2] ? sanitizeModuleSpecifier(match[2]) : null;
    for (const item of namedExportItems(match[1])) {
      output.push({
        name: item.name,
        kind: 'export',
        exportHash: hashRef(`${module ? 're-export' : 'export'}:${item.targetName}:${item.name}:${module ?? ''}`),
        targetName: item.targetName,
        ...(module ? { module } : {})
      });
    }
  }
  for (const match of body.matchAll(/^\s*export\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/gmu)) {
    const module = sanitizeModuleSpecifier(match[2]);
    output.push({ name: match[1], kind: 'export', module, namespace: true, exportHash: hashRef(`re-export-namespace:${match[1]}:${module}`) });
  }
  for (const match of body.matchAll(/^\s*export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/gmu)) {
    output.push({ name: 'default', kind: 'export', targetName: match[1], exportHash: hashRef(`default-export:${match[1]}`) });
  }
  for (const match of body.matchAll(/^\s*export\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gmu)) {
    output.push({ name: 'default', kind: 'export', targetName: match[1], exportHash: hashRef(`default-export:${match[1]}`) });
  }
  for (const match of body.matchAll(/^\s*export\s+default\s+class\s+([A-Za-z_$][\w$]*)/gmu)) {
    output.push({ name: 'default', kind: 'export', targetName: match[1], exportHash: hashRef(`default-export:${match[1]}`) });
  }
  for (const match of body.matchAll(/^\s*export\s+\*\s+from\s+['"]([^'"]+)['"]/gmu)) {
    const module = sanitizeModuleSpecifier(match[1]);
    output.push({ name: '*', kind: 'export', module, star: true, exportHash: hashRef(`re-export-star:${module}`) });
  }
  for (const match of body.matchAll(/^\s*module\.exports\.([A-Za-z_$][\w$]*)\s*=/gmu)) {
    output.push({ name: match[1], kind: 'export', exportHash: hashRef(`commonjs:${match[1]}`) });
  }
  for (const match of body.matchAll(/^\s*module\.exports\s*=\s*(?:async\s*)?function\s+([A-Za-z_$][\w$]*)\s*\(/gmu)) {
    output.push({ name: match[1], kind: 'export', exportHash: hashRef(`commonjs:${match[1]}`) });
  }
  for (const match of body.matchAll(/^\s*module\.exports\s*=\s*([A-Za-z_$][\w$]*)\s*;?\s*$/gmu)) {
    output.push({ name: match[1], kind: 'export', exportHash: hashRef(`commonjs:${match[1]}`) });
  }
  for (const match of body.matchAll(/^\s*module\.exports\s*=\s*\{([\s\S]*?)^\s*\}/gmu)) {
    for (const value of commonJsObjectExportNames(match[1])) {
      output.push({ name: value, kind: 'export', exportHash: hashRef(`commonjs:${value}`) });
    }
  }
  return uniqueBy(output, (item) => `${item.kind}:${item.name}`);
}

function namedExportItems(body) {
  return String(body ?? '').split(',').map((value) => {
    const [targetName, exportedName] = value.trim().split(/\s+as\s+/u).map((item) => item?.trim()).filter(Boolean);
    if (!targetName || !/^[A-Za-z_$][\w$]*$/u.test(targetName)) return null;
    const name = exportedName && /^[A-Za-z_$][\w$]*$/u.test(exportedName) ? exportedName : targetName;
    return { name, targetName };
  }).filter(Boolean);
}

function commonJsObjectExportNames(body) {
  const names = [];
  for (const line of String(body ?? '').split('\n')) {
    const cleaned = stripStringsAndComments(line).trim().replace(/,$/u, '');
    if (!cleaned || cleaned.includes('{') || cleaned.includes('}')) continue;
    const name = (
      cleaned.match(/^([A-Za-z_$][\w$]*)$/u) ??
      cleaned.match(/^([A-Za-z_$][\w$]*)\s*\(/u) ??
      cleaned.match(/^([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/u) ??
      cleaned.match(/^[A-Za-z_$][\w$]*\s*:\s*([A-Za-z_$][\w$]*)$/u)
    )?.[1];
    if (name) names.push(name);
  }
  return [...new Set(names)].sort();
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

function callsForDeclaration(declaration, sourceSlice, imports = []) {
  const calls = callsForSource(sourceSlice).filter((call) => call.name !== declaration.name);
  return expandCallAliases(calls, imports);
}

function inheritanceCallsForDeclaration(declaration, sourceSlice, imports = []) {
  const calls = [];
  const stripped = stripStringsAndComments(sourceSlice);
  const match = stripped.match(/\bclass\s+[A-Za-z_$][\w$]*\s+extends\s+([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*))?/u);
  if (match) calls.push(match[2] ? { receiver: match[1], name: match[2] } : { name: match[1] });
  const implementsMatch = stripped.match(/\bimplements\s+([^{]+)/u);
  for (const item of implementsMatch?.[1]?.split(',') ?? []) {
    const value = item.trim().match(/^([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*))?/u);
    if (value) calls.push(value[2] ? { receiver: value[1], name: value[2] } : { name: value[1] });
  }
  return expandCallAliases(calls.filter((call) => call.name !== declaration.name), imports);
}

function expandCallAliases(calls, imports = []) {
  const aliases = new Map(imports.flatMap((item) => Object.entries(item.aliases ?? {})));
  return uniqueBy(calls.flatMap((call) => {
    const original = call.receiver ? null : aliases.get(call.name);
    return original && original !== call.name ? [call, { name: original }] : [call];
  }), (call) => `${call.receiver ?? ''}:${call.name}`).sort((a, b) => a.name.localeCompare(b.name) || String(a.receiver ?? '').localeCompare(String(b.receiver ?? '')));
}

function callsForSource(sourceSlice) {
  const calls = [];
  const stripped = stripStringsAndComments(sourceSlice);
  for (const match of stripped.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/gu)) {
    if (previousNonWhitespace(stripped, match.index) === '.') continue;
    if (!JS_KEYWORDS.has(match[1])) calls.push({ name: match[1] });
  }
  for (const match of stripped.matchAll(/\b([A-Za-z_$][\w$]*)\s*\.\s*(#?[A-Za-z_$][\w$]*)\s*\(/gu)) {
    if (!WEAK_MEMBER_CALL_NAMES.has(match[2])) calls.push({ receiver: match[1], name: match[2] });
  }
  for (const call of callbackReferencesForSource(stripped)) {
    calls.push(call);
  }
  for (const match of stripped.matchAll(/\b(?:[A-Za-z_$][\w$]*\s*\.\s*)?createElement\s*\(\s*([A-Z][\w$]*)(?:\s*\.\s*([A-Z][\w$]*))?/gu)) {
    calls.push(match[2] ? { receiver: match[1], name: match[2] } : { name: match[1] });
  }
  for (const match of stripped.matchAll(/<\s*([A-Z][\w$]*)\.([A-Z][\w$]*)(?=[\s/>])/gu)) {
    calls.push({ receiver: match[1], name: match[2] });
  }
  for (const match of stripped.matchAll(/<\s*([A-Z][\w$]*)(?=[\s/>])/gu)) {
    calls.push({ name: match[1] });
  }
  return uniqueBy(calls, (call) => `${call.receiver ?? ''}:${call.name}`).sort((a, b) => a.name.localeCompare(b.name) || String(a.receiver ?? '').localeCompare(String(b.receiver ?? '')));
}

function callbackReferencesForSource(stripped) {
  const calls = [];
  for (const match of stripped.matchAll(/\b(?:[A-Za-z_$][\w$]*\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(([^()]*)\)/gu)) {
    if (/\bfunction\s*$/u.test(stripped.slice(0, match.index))) continue;
    if (nextNonWhitespace(stripped, match.index + match[0].length) === '{') continue;
    const args = match[2].split(',');
    const callbackArgs = FIRST_ARGUMENT_CALLBACK_NAMES.has(match[1]) ? args : args.slice(1);
    for (const value of callbackArgs) {
      pushCallbackReference(calls, value.trim());
    }
  }
  return calls;
}

function pushCallbackReference(calls, item) {
  const member = item.match(/^([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)$/u);
  if (member && !JS_KEYWORDS.has(member[1]) && !JS_KEYWORDS.has(member[2]) && !WEAK_MEMBER_CALL_NAMES.has(member[2])) {
    calls.push({ receiver: member[1], name: member[2] });
    return;
  }
  if (/^[A-Za-z_$][\w$]*$/u.test(item) && !JS_KEYWORDS.has(item)) {
    calls.push({ name: item });
  }
}

function previousNonWhitespace(value, index) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (!/\s/u.test(value[cursor])) return value[cursor];
  }
  return '';
}

function nextNonWhitespace(value, index) {
  for (let cursor = index; cursor < value.length; cursor += 1) {
    if (!/\s/u.test(value[cursor])) return value[cursor];
  }
  return '';
}

function importsForSlice(imports, sourceSlice) {
  const referenceTerms = referencesForSource(sourceSlice);
  const referenced = new Set(referenceTerms);
  return imports.filter((item) => {
    if (item.syntax === 'dynamic') return dynamicImportPattern(item.rawModule).test(sourceSlice);
    return !item.names.length || item.names.some((name) => referenced.has(name));
  }).map((item) => withDefined({
    ...item,
    aliases: item.namespace ? { ...(item.aliases ?? {}), ...destructuredNamespaceAliases(sourceSlice, item.namespace) } : item.aliases
  }));
}

function dynamicImportPattern(rawModule) {
  return new RegExp(`\\bimport\\(\\s*['"]${escapeRegExp(rawModule)}['"]\\s*\\)`, 'u');
}

function escapeRegExp(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
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

function namespaceImportedName(specifier) {
  return String(specifier ?? '').match(/\*\s+as\s+([A-Za-z_$][\w$]*)/u)?.[1] ?? null;
}

function importedAliases(specifier) {
  const aliases = {};
  const named = String(specifier ?? '').match(/\{([^}]+)\}/u)?.[1] ?? '';
  for (const part of named.split(',')) {
    const [imported, local] = part.trim().replace(/^type\s+/u, '').split(/\s+as\s+/u).map((item) => item?.trim()).filter(Boolean);
    if (imported && local && /^[A-Za-z_$][\w$]*$/u.test(imported) && /^[A-Za-z_$][\w$]*$/u.test(local)) aliases[local] = imported;
  }
  return aliases;
}

function destructuredNamespaceAliases(sourceSlice, namespace) {
  const aliases = {};
  const pattern = new RegExp(`\\b(?:const|let|var)\\s*\\{([^}]+)\\}\\s*=\\s*${escapeRegExp(namespace)}\\b`, 'gu');
  for (const match of stripStringsAndComments(sourceSlice).matchAll(pattern)) {
    for (const part of match[1].split(',')) {
      const [imported, local] = part.trim().split(/\s*:\s*/u).map((item) => item?.trim()).filter(Boolean);
      if (imported && local && /^[A-Za-z_$][\w$]*$/u.test(imported) && /^[A-Za-z_$][\w$]*$/u.test(local)) aliases[local] = imported;
    }
  }
  return aliases;
}

function defaultImportedAliases(specifier, rawModule) {
  const leading = String(specifier ?? '').split('{')[0].trim().replace(/^type\s+/u, '').split(',')[0].trim();
  if (!leading || !/^[A-Za-z_$][\w$]*$/u.test(leading)) return {};
  return { [leading]: defaultExportNameFromModule(rawModule) };
}

function defaultExportNameFromModule(rawModule) {
  const parts = String(rawModule ?? '').split('/').filter((part) => part && part !== '.');
  const last = parts.at(-1)?.replace(/\.[^.]+$/u, '');
  const base = last === 'index' ? parts.at(-2)?.replace(/\.[^.]+$/u, '') : last;
  return `default:${safeTag(base ?? 'export')}`;
}

function importedRequireNames(binding) {
  const value = String(binding ?? '').trim();
  const named = value.match(/^\{([^}]+)\}$/u)?.[1] ?? '';
  if (!named) return [];
  return [...new Set(named.split(',').map((part) => {
    const pieces = part.trim().split(/\s*:\s*/u).map((item) => item.trim()).filter(Boolean);
    return pieces.at(-1);
  }).filter((name) => /^[A-Za-z_$][\w$]*$/u.test(name)))].sort();
}

function importedRequireAliases(binding) {
  const aliases = {};
  const named = String(binding ?? '').trim().match(/^\{([^}]+)\}$/u)?.[1] ?? '';
  for (const part of named.split(',')) {
    const [imported, local] = part.trim().split(/\s*:\s*/u).map((item) => item?.trim()).filter(Boolean);
    if (imported && local && /^[A-Za-z_$][\w$]*$/u.test(imported) && /^[A-Za-z_$][\w$]*$/u.test(local)) aliases[local] = imported;
  }
  return aliases;
}

function publicImport(item) {
  return withDefined({
    module: item.module,
    importHash: item.importHash,
    names: item.names?.length ? [...item.names].sort() : undefined,
    namespace: item.namespace ?? undefined,
    aliases: Object.keys(item.aliases ?? {}).length ? Object.fromEntries(Object.entries(item.aliases).sort(([left], [right]) => left.localeCompare(right))) : undefined
  });
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
  const filePath = relativeFromLocator(chunk.locator);
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
      path: filePath,
      locator: chunk.locator,
      representation: 'source-locator-summary',
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

function recordFromGraphResult({ result, graph, workspaceId, collectedAt }) {
  const filePath = result.locator ? relativeFromLocator(result.locator) : null;
  const text = [
    `Source graph ${result.resultType} ${result.kind} ${result.label}.`,
    result.locator ? `Locator ${result.locator}.` : '',
    'Use this locator to recover the tracked source file.'
  ].filter(Boolean).join(' ');
  const tagValues = [
    'code',
    'source-graph',
    `graph-kind:${safeTag(result.kind)}`,
    `graph-result:${safeTag(result.resultType)}`,
    result.label,
    result.locator,
    filePath
  ].filter(Boolean);
  const tags = [...new Set(tagValues.flatMap((value) => [...terms(value)].slice(0, 16)))].sort();
  return {
    id: `graph_${sha256(`${result.id}:${result.locator ?? ''}:${graph.graphFingerprint}`).slice(0, 32)}`,
    version: graph.graphFingerprint,
    kind: 'observation',
    workspaceId,
    text,
    tags,
    relations: tags,
    scope: 'workspace-private',
    dataClass: 'workspace-private',
    trustClass: 'observed',
    status: 'active',
    source: result.locator ?? `workspace://__source_graph__#${result.id}`,
    tokens: estimateTokens(text),
    confidence: result.resultType === 'node' ? 0.8 : 0.72,
    authority: 0.6,
    updatedAt: collectedAt,
    contentHash: hashRef(stableStringify({ graph: graph.graphFingerprint, result })),
    metadata: {
      path: filePath,
      locator: result.locator ?? null,
      representation: 'source-graph-locator',
      retrieval: { candidateEligible: Boolean(result.locator) },
      sourceGraph: {
        graphFingerprint: graph.graphFingerprint,
        sourceIndexFingerprint: graph.sourceIndexFingerprint,
        resultId: result.id,
        resultType: result.resultType,
        kind: result.kind,
        score: result.score,
        reasonCodes: result.reasonCodes ?? []
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

function resolveImportFileLocator(sourceLocator, moduleSpecifier, knownFileLocators) {
  const moduleValue = String(moduleSpecifier ?? '');
  if (!moduleValue.startsWith('.') && !moduleValue.startsWith('@/')) return null;
  const sourcePath = relativeFromLocator(fileLocatorFor(sourceLocator));
  const basePath = moduleValue.startsWith('@/')
    ? path.posix.normalize(moduleValue.slice(2))
    : path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), moduleValue));
  if (!basePath || basePath.startsWith('../') || path.posix.isAbsolute(basePath)) return null;
  const withoutExtension = basePath.replace(/\.(?:[cm]?js|jsx|tsx?)$/u, '');
  const candidates = [
    basePath,
    `${withoutExtension}.ts`,
    `${withoutExtension}.tsx`,
    `${withoutExtension}.js`,
    `${withoutExtension}.jsx`,
    `${withoutExtension}.mjs`,
    `${withoutExtension}.cjs`,
    `${withoutExtension}/index.ts`,
    `${withoutExtension}/index.tsx`,
    `${withoutExtension}/index.js`,
    `${withoutExtension}/index.mjs`
  ];
  for (const candidate of candidates) {
    const locator = locatorFor(candidate);
    if (knownFileLocators.has(locator)) return locator;
  }
  return null;
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
  const symbolNodes = nodes.filter((node) => node.kind === 'symbol');
  const symbolLabelCounts = countBy(symbolNodes, (node) => node.label);
  const symbolsByLabel = new Map();
  for (const node of symbolNodes) {
    const values = symbolsByLabel.get(node.label) ?? [];
    values.push(node);
    symbolsByLabel.set(node.label, values);
  }
  const ambiguousSymbolLabelCount = Object.values(symbolLabelCounts).filter((count) => count > 1).length;
  const qualifiedSymbolCount = symbolNodes.filter((node) => node.qualifiedLabel).length;
  const degree = new Map(nodes.map((node) => [node.id, { inbound: 0, outbound: 0 }]));
  const hotspotDegree = new Map(nodes.map((node) => [node.id, { inbound: 0, outbound: 0 }]));
  const callDegree = new Map(nodes.map((node) => [node.id, { inbound: 0, outbound: 0 }]));
  for (const edge of edges) {
    const from = degree.get(edge.fromNodeId);
    const to = degree.get(edge.toNodeId);
    if (from) from.outbound += 1;
    if (to) to.inbound += 1;
    if (edge.kind === 'calls' || edge.kind === 'references') {
      const hotspotFrom = hotspotDegree.get(edge.fromNodeId);
      const hotspotTo = hotspotDegree.get(edge.toNodeId);
      if (hotspotFrom) hotspotFrom.outbound += 1;
      if (hotspotTo) hotspotTo.inbound += 1;
    }
    if (edge.kind === 'calls') {
      const callFrom = callDegree.get(edge.fromNodeId);
      const callTo = callDegree.get(edge.toNodeId);
      if (callFrom) callFrom.outbound += 1;
      if (callTo) callTo.inbound += 1;
    }
  }
  const behaviorHotspots = sourceGraphHotspots(nodes, hotspotDegree);
  const structuralHotspots = behaviorHotspots.length ? [] : sourceGraphHotspots(nodes, degree);
  const hotspots = (behaviorHotspots.length ? behaviorHotspots : structuralHotspots).slice(0, 10);
  const entryPoints = nodes
    .filter((node) => node.kind === 'symbol')
    .map((node) => {
      const counts = callDegree.get(node.id) ?? { inbound: 0, outbound: 0 };
      return { node, counts };
    })
    .filter(({ counts }) => counts.inbound === 0 && counts.outbound > 0)
    .map(({ node, counts }) => withDefined({ nodeId: node.id, label: node.label, qualifiedLabel: node.qualifiedLabel, locator: node.locator, symbolKind: node.symbolKind, outbound: counts.outbound }))
    .sort((a, b) => graphSearchPathPriority(a.locator) - graphSearchPathPriority(b.locator) || b.outbound - a.outbound || a.label.localeCompare(b.label) || a.nodeId.localeCompare(b.nodeId))
    .map(({ outbound: _outbound, ...item }) => item)
    .slice(0, 10);
  const ambiguousLabels = [...symbolsByLabel.entries()]
    .map(([label, values]) => sourceGraphAmbiguousLabelSample(label, values, hotspotDegree))
    .filter(Boolean)
    .sort((a, b) => b.signalScore - a.signalScore || b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, 10);
  return Object.freeze({
    fileCount: nodeKindCounts.file ?? 0,
    symbolCount: nodeKindCounts.symbol ?? 0,
    moduleCount: nodeKindCounts.module ?? 0,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    qualifiedSymbolCount,
    ambiguousSymbolLabelCount,
    ambiguousLabels: ambiguousLabels.map(({ signalScore: _signalScore, ...item }) => item),
    nodeKindCounts,
    edgeKindCounts,
    hotspots,
    entryPoints
  });
}

function sourceGraphAmbiguousLabelSample(label, values, behaviorDegree) {
  if (values.length < 2 || !highSignalReferenceName(label, values)) return null;
  const candidates = values
    .map((node) => ({ node, signalScore: sourceGraphAmbiguousSymbolSignal(node, behaviorDegree) }))
    .filter((item) => item.signalScore > 0)
    .sort((a, b) => b.signalScore - a.signalScore || graphSearchPathPriority(a.node.locator) - graphSearchPathPriority(b.node.locator) || a.node.locator.localeCompare(b.node.locator));
  if (candidates.length < 2) return null;
  return {
    label,
    count: values.length,
    qualifiedLabels: [...new Set(candidates.map(({ node }) => node.qualifiedLabel).filter(Boolean))].slice(0, 5),
    locators: candidates.map(({ node }) => node.locator).filter(Boolean).slice(0, 3),
    signalScore: candidates[0].signalScore
  };
}

function sourceGraphAmbiguousSymbolSignal(node, behaviorDegree) {
  const pathPriority = graphSearchPathPriority(node.locator);
  if (pathPriority > 2) return 0;
  const counts = behaviorDegree.get(node.id) ?? { inbound: 0, outbound: 0 };
  const behaviorTotal = counts.inbound + counts.outbound;
  let score = pathPriority === 1 ? 2 : 1;
  if (node.qualifiedLabel) score += 8;
  if (['class', 'interface', 'type'].includes(node.symbolKind)) score += 4;
  if (['method', 'function'].includes(node.symbolKind)) score += 2;
  if (behaviorTotal > 0) score += 2;
  if (!node.qualifiedLabel && !behaviorTotal && !/[A-Z]/u.test(node.label ?? '')) return 0;
  return score;
}

function sourceGraphHotspots(nodes, degree) {
  const ranked = nodes
    .filter((node) => node.kind === 'symbol' && highSignalReferenceName(node.label, []))
    .map((node) => {
      const counts = degree.get(node.id) ?? { inbound: 0, outbound: 0 };
      return withDefined({ nodeId: node.id, label: node.label, qualifiedLabel: node.qualifiedLabel, locator: node.locator, inbound: counts.inbound, outbound: counts.outbound, total: counts.inbound + counts.outbound });
    })
    .filter((item) => item.total > 0)
    .sort((a, b) => graphSearchPathPriority(a.locator) - graphSearchPathPriority(b.locator) || b.total - a.total || a.label.localeCompare(b.label) || a.nodeId.localeCompare(b.nodeId));
  const sourceRanked = ranked.filter((item) => graphSearchPathPriority(item.locator) <= 1);
  return sourceRanked.length ? sourceRanked : ranked;
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

function graphSearchSymbolKindWeight(symbolKind) {
  if (['class', 'function', 'method'].includes(symbolKind)) return 1.18;
  if (['type', 'interface'].includes(symbolKind)) return 0.82;
  return 1;
}

function graphSearchEdgeKindWeight(kind) {
  if (['defined_in', 'contains'].includes(kind)) return 0.35;
  return 1;
}

function sourceGraphNodeSearchText(node) {
  return expandSearchText([
    node.kind,
    node.label,
    node.qualifiedLabel,
    node.symbolKind,
    ...(node.scopeChain ?? []),
    node.locator,
    node.sourceRef,
    node.moduleHash
  ].filter(Boolean).join(' '));
}

function sourceGraphEdgeSearchText(edge, from, to) {
  return expandSearchText([
    edge.kind,
    edge.exportName,
    edge.locator,
    edge.sourceRef,
    from?.kind,
    from?.label,
    from?.qualifiedLabel,
    from?.locator,
    to?.kind,
    to?.label,
    to?.qualifiedLabel,
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

function graphSearchPathPriority(locator = '') {
  const relative = String(locator ?? '').replace(/^workspace:\/\//u, '').split('#')[0];
  if (!relative) return 2;
  if (/(^|\/)(?:test|tests|__tests__|spec|fixtures|mocks?)(?:\/|$)/u.test(relative) || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(relative)) return 3;
  if (/(^|\/)scripts\//u.test(relative)) return 2;
  if (isTypeDeclarationPath(relative)) return 2;
  if (/(^|\/)(?:node_modules|vendor|dist|build|coverage|generated)(?:\/|$)/u.test(relative)) return 4;
  return 1;
}

function graphSearchPathWeight(locator = '', queryTerms = new Set(), locatorPrefix = null) {
  const relative = String(locator ?? '').replace(/^workspace:\/\//u, '').split('#')[0];
  if (!relative) return 0.45;
  if (locatorPrefix) return 1;
  if ([...queryTerms].some((term) => ['type', 'types', 'interface', 'interfaces', 'declaration', 'declarations'].includes(term))) return 1;
  if (isTypeDeclarationPath(relative)) return 0.8;
  if ([...queryTerms].some((term) => ['script', 'scripts', 'eval', 'evals', 'benchmark', 'benchmarks', 'bench'].includes(term))) return 1;
  if (/(^|\/)scripts\//u.test(relative)) return 0.7;
  if ([...queryTerms].some((term) => ['test', 'tests', 'spec', 'fixture', 'fixtures', 'mock', 'mocks'].includes(term))) return 1;
  if (/(^|\/)(?:test|tests|__tests__|spec|fixtures|mocks?)(?:\/|$)/u.test(relative) || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(relative)) return 0.55;
  if (/(^|\/)(?:node_modules|vendor|dist|build|coverage|generated)(?:\/|$)/u.test(relative)) return 0.35;
  return 1;
}

function isTypeDeclarationPath(relative = '') {
  return /\.d\.[cm]?ts$/u.test(relative) || /(^|\/)types\//u.test(relative);
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
