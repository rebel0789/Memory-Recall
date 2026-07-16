import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { estimateTokens, hashRef, stableStringify, terms } from '../../../../packages/context-compiler/src/index.mjs';
import {
  normalizeSourceGraphWorkspaceLocator,
  SOURCE_GRAPH_FINGERPRINT_RE,
  SOURCE_GRAPH_SAFE_LABEL_RE,
  SOURCE_GRAPH_WORKSPACE_ID_RE,
  SOURCE_GRAPH_WORKSPACE_LOCATOR_RE
} from '../../../../packages/protocol/src/source-graph-locator.mjs';
import {
  isIgnoredPath,
  loadIgnoreFile,
  loadRootRecallIgnore,
  normalizeIgnoreRelativePath
} from './ignore-rules.mjs';

export const AST_CODE_PROVIDER_VERSION = '1.0.0';
export const AST_CODE_PARSER_VERSION = 'oaf-js-ts-static-1.0.0';

const SOURCE_ID = 'provider:native:context-candidate:ast-code';
const GRAPH_SOURCE_ID = 'provider:native:context-candidate:graph';
const EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);
const EXCLUDED_DIRECTORY_POLICIES = new Map([
  ['.git', 'declared_out_of_scope_directory_excluded'],
  ['.worktrees', 'declared_out_of_scope_directory_excluded'],
  ['node_modules', 'declared_out_of_scope_directory_excluded'],
  ['.venv', 'declared_out_of_scope_directory_excluded'],
  ['venv', 'declared_out_of_scope_directory_excluded'],
  ['site-packages', 'declared_out_of_scope_directory_excluded'],
  ['.agents', 'declared_out_of_scope_directory_excluded'],
  ['.claude', 'declared_out_of_scope_directory_excluded'],
  ['.next', 'declared_out_of_scope_directory_excluded'],
  ['coverage', 'declared_out_of_scope_directory_excluded'],
  ['test-results', 'declared_out_of_scope_directory_excluded'],
  ['playwright-report', 'declared_out_of_scope_directory_excluded'],
  ['.cache', 'declared_out_of_scope_directory_excluded'],
  ['.pytest_cache', 'declared_out_of_scope_directory_excluded'],
  ['.turbo', 'declared_out_of_scope_directory_excluded'],
  ['.parcel-cache', 'declared_out_of_scope_directory_excluded'],
  ['dist', 'source_relevant_directory_excluded'],
  ['build', 'source_relevant_directory_excluded'],
  ['out', 'source_relevant_directory_excluded'],
  ['.generated', 'source_relevant_directory_excluded'],
  ['generated-output', 'source_relevant_directory_excluded'],
  ['vendor', 'source_relevant_directory_excluded']
]);
const NON_OVERRIDABLE_EXCLUDED_DIRECTORIES = new Set(['.git', '.worktrees']);
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_FILES = 1000;
export const DEFAULT_SOURCE_GRAPH_MAX_NODES = 20_000;
export const DEFAULT_SOURCE_GRAPH_MAX_EDGES = 50_000;
const EDGE_BUDGET_ORDER = Object.freeze(['contains', 'defined_in', 'imports', 'exports', 'calls', 'references']);
const MAX_COVERAGE_REPRESENTED_LOCATORS = 1000;
const MAX_COVERAGE_SKIPPED_LOCATORS = 100;
const MAX_COVERAGE_EXCLUDED_DIRECTORY_LOCATORS = 100;
const MAX_EXCLUDED_DIRECTORY_DIAGNOSTICS = 100;
const MAX_COVERAGE_UNSUPPORTED_EXTENSIONS = 32;
const MAX_COVERAGE_IGNORED_SAMPLES = 100;
const MAX_ARCHITECTURE_RANKING_RESULTS = 25;
const MAX_ARCHITECTURE_DEPRIORITIZED = 25;
const MAX_REFERENCES_PER_CHUNK = 80;
const MAX_CALLS_PER_CHUNK = 40;
const MAX_TARGETS_PER_SYMBOL_NAME = 8;
const MAX_REFERENCE_EDGES_PER_CHUNK = 200;
const MAX_CALL_EDGES_PER_CHUNK = 80;
const MAX_DIRECT_GRAPH_RESULTS_PER_FILE = 2;
const MAX_NEIGHBOR_GRAPH_RESULTS_PER_FILE = 1;
const MAX_REFERENCE_TARGETS_FOR_COMMON_NAME = 8;
const SOURCE_GRAPH_NODE_KINDS = new Set(['file', 'chunk', 'symbol', 'module']);
const SOURCE_GRAPH_EDGE_KINDS = new Set(['contains', 'defined_in', 'imports', 'exports', 'references', 'calls']);
const SOURCE_GRAPH_SYMBOL_KINDS = new Set(['class', 'function', 'method', 'interface', 'type']);
const SOURCE_GRAPH_NODE_ID_RE = /^sgnode_[a-f0-9]{32}$/u;
const SOURCE_GRAPH_EDGE_ID_RE = /^sgedge_[a-f0-9]{32}$/u;
const SOURCE_GRAPH_SOURCE_REF_RE = /^(?:(?:symbol|astchunk|import|export|call|ref|srcsnap)_[a-f0-9]{16,32}|sha256:[a-f0-9]{64})$/u;
const SOURCE_GRAPH_SNAPSHOT_ID_RE = /^srcsnap_[a-f0-9]{16}$/u;
const SOURCE_GRAPH_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SOURCE_GRAPH_DIAGNOSTIC_CODE_RE = /^[a-z][a-z0-9_:-]{0,63}$/u;
const SOURCE_GRAPH_PUBLIC_FALLBACK_WORKSPACE_ID = 'ws_source_graph';
const SOURCE_GRAPH_PUBLIC_FALLBACK_GRAPH_FINGERPRINT = hashRef('source-graph-public-fallback-graph');
const SOURCE_GRAPH_PUBLIC_FALLBACK_SOURCE_INDEX_FINGERPRINT = hashRef('source-graph-public-fallback-source-index');
const SOURCE_GRAPH_PUBLIC_FALLBACK_GRAPH_VERSION = 'oaf-source-graph-unavailable-1.0.0';
const SOURCE_GRAPH_PUBLIC_FALLBACK_PARSER_VERSION = 'oaf-source-graph-unavailable';
const SOURCE_GRAPH_PUBLIC_FALLBACK_BUILT_AT = '1970-01-01T00:00:00.000Z';
const SOURCE_GRAPH_PUBLIC_PROJECTIONS = new WeakSet();
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
const GENERIC_ARCHITECTURE_UTILITY_NAMES = new Set([
  'bytecount',
  'bytelength',
  'bytes',
  'count',
  'length',
  'noop',
  'size'
]);
const ARCHITECTURE_SIGNAL_TABLE = Object.freeze({
  route_locator: Object.freeze({ weight: 90, direction: 'promote' }),
  bin_locator: Object.freeze({ weight: 76, direction: 'promote' }),
  executable_script_locator: Object.freeze({ weight: 56, direction: 'promote' }),
  package_source_entry_locator: Object.freeze({ weight: 48, direction: 'promote' }),
  exported_symbol: Object.freeze({ weight: 44, direction: 'promote' }),
  changed_locator: Object.freeze({ weight: 28, direction: 'promote' }),
  query_match: Object.freeze({ weight: 12, direction: 'promote' }),
  inbound_behavior: Object.freeze({ perDegree: 3, maximum: 18, direction: 'promote' }),
  outbound_behavior: Object.freeze({ perDegree: 2, maximum: 12, direction: 'promote' }),
  test_locator_penalty: Object.freeze({ weight: -180, direction: 'deprioritize' }),
  private_symbol_penalty: Object.freeze({ weight: -160, direction: 'deprioritize' }),
  generic_utility_penalty: Object.freeze({ weight: -140, direction: 'deprioritize' })
});
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
      const resolvedWorkspaceId = sourceGraphCandidateWorkspaceId(request?.workspaceId, workspaceId);
      const scan = await scanAstCodeWorkspace({
        root: workspaceRoot,
        workspaceId: resolvedWorkspaceId,
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
          record: recordFromChunk(chunk, resolvedWorkspaceId),
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
      const resolvedWorkspaceId = sourceGraphCandidateWorkspaceId(request?.workspaceId, workspaceId);
      const queryText = [
        request.objective,
        request.step,
        ...(request.requiredEntities ?? [])
      ].filter(Boolean).join(' ');
      const graphKey = stableStringify({ workspaceRoot, workspaceId: resolvedWorkspaceId, maxFileBytes, maxFiles });
      if (!cachedGraph || cachedGraphKey !== graphKey) {
        cachedGraph = await buildJsTsSourceGraph({
          root: workspaceRoot,
          workspaceId: resolvedWorkspaceId,
          maxFileBytes,
          maxFiles,
          clock
        });
        cachedGraphKey = graphKey;
      }
      const graph = cachedGraph;
      const publicGraph = sanitizeSourceGraphPublicOutput(graph);
      const resultLimit = trustedContext.sourceLimit ?? request.perSourceLimit ?? 10;
      const search = searchSourceGraph(graph, {
        query: queryText,
        limit: sourceGraphSearchLimit(resultLimit)
      });
      const results = publicGraph.envelopeValid ? sourceGraphCandidateResults(publicGraph, search.results, {
        limit: resultLimit
      }) : [];
      return {
        candidates: results.map((result, index) => ({
          record: recordFromGraphResult({ result, graph: publicGraph, workspaceId: publicGraph.workspaceId, collectedAt: clock() }),
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

function sourceGraphCandidateResults(publicGraph, searchResults, { limit }) {
  const boundedLimit = boundedInteger(limit, 'source_graph_candidate_limit', 1, 100);
  const nodeById = new Map(publicGraph.nodes.map((node) => [node.id, node]));
  const edgesByNodeId = new Map();
  for (const edge of publicGraph.edges) {
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
  explicitIncludes = [],
  onlyIncludes = [],
  metadataOnly = false,
  clock = () => new Date().toISOString()
} = {}) {
  if (typeof root !== 'string' || !root) throw new Error('root is required');
  const normalizedExplicitIncludes = explicitIncludes.map(normalizeIgnoreRelativePath);
  const normalizedOnlyIncludes = onlyIncludes.map(normalizeIgnoreRelativePath);
  const rootReal = await realpath(root);
  const rootRecallRules = await loadRootRecallIgnore(rootReal);
  const diagnostics = [];
  const chunks = [];
  const fileOutlines = [];
  const discoveredFiles = [];
  const skippedLocators = new Set();
  const oversizedLocators = new Set();
  const excludedDirectoryLocators = new Set();
  const declaredOutOfScopeDirectoryLocators = new Set();
  const sourceRelevantExcludedDirectoryLocators = new Set();
  const excludedDirectoryCodes = new Map();
  const unsupportedExtensionCounts = new Map();
  const ignoredSamples = new Set();
  const ignoreFileLocators = new Set(rootRecallRules.length ? ['workspace://.recallignore'] : []);
  const normalizedIgnoreRules = [...rootRecallRules];
  let unsupportedFileCount = 0;
  let ignoredFileCount = 0;
  let ignoredDirectoryCount = 0;
  let excludedDirectoryCount = 0;
  let declaredOutOfScopeDirectoryCount = 0;
  let sourceRelevantExcludedDirectoryCount = 0;
  let excludedDirectoryDiagnosticCount = 0;
  let excludedDirectoryDiagnosticsTruncated = false;
  let visitedFiles = 0;
  let maxFilesReached = false;

  function markMaxFilesReached() {
    if (maxFilesReached) return;
    maxFilesReached = true;
    diagnostics.push(diagnostic('workspace://__source_graph_scan__', 'max_files_reached'));
  }

  function recordExcludedDirectory(locator, code) {
    if (excludedDirectoryCodes.has(locator)) return;
    excludedDirectoryCodes.set(locator, code);
    excludedDirectoryCount += 1;
    addBoundedLocator(excludedDirectoryLocators, locator, MAX_COVERAGE_EXCLUDED_DIRECTORY_LOCATORS);
    if (code === 'declared_out_of_scope_directory_excluded') {
      declaredOutOfScopeDirectoryCount += 1;
      addBoundedLocator(declaredOutOfScopeDirectoryLocators, locator, MAX_COVERAGE_EXCLUDED_DIRECTORY_LOCATORS);
    } else {
      sourceRelevantExcludedDirectoryCount += 1;
      addBoundedLocator(sourceRelevantExcludedDirectoryLocators, locator, MAX_COVERAGE_EXCLUDED_DIRECTORY_LOCATORS);
    }
    if (excludedDirectoryDiagnosticCount < MAX_EXCLUDED_DIRECTORY_DIAGNOSTICS) {
      diagnostics.push(diagnostic(locator, code));
      excludedDirectoryDiagnosticCount += 1;
    } else if (!excludedDirectoryDiagnosticsTruncated) {
      diagnostics.push(diagnostic('workspace://__source_graph_scan__', 'excluded_directory_diagnostics_truncated'));
      excludedDirectoryDiagnosticsTruncated = true;
    }
  }

  function recordUnreadableFile(locator) {
    skippedLocators.add(locator);
    diagnostics.push(diagnostic(locator, 'file_unreadable'));
  }

  function recordUnreadableDirectory(locator) {
    diagnostics.push(diagnostic(locator, 'directory_unreadable'));
  }

  function recordIgnored(locator, isDirectory) {
    if (isDirectory) ignoredDirectoryCount += 1;
    else ignoredFileCount += 1;
    addBoundedLocator(ignoredSamples, locator, MAX_COVERAGE_IGNORED_SAMPLES);
  }

  async function walk(relativeDirectory = '', ancestorGitRules = []) {
    const absoluteDirectory = path.join(rootReal, relativeDirectory);
    const gitIgnoreFile = path.join(absoluteDirectory, '.gitignore');
    let localGitRules = [];
    let gitIgnoreUnavailable = false;
    try {
      localGitRules = await loadIgnoreFile(gitIgnoreFile, { base: relativeDirectory });
    } catch {
      gitIgnoreUnavailable = true;
    }
    if (localGitRules.length) {
      const locator = safeWorkspaceLocatorFor(normalizeRelative(path.join(relativeDirectory, '.gitignore')));
      if (locator) addBoundedLocator(ignoreFileLocators, locator, MAX_COVERAGE_IGNORED_SAMPLES);
      normalizedIgnoreRules.push(...localGitRules);
    }
    const gitRules = [...ancestorGitRules, ...localGitRules];
    const activeRules = [...gitRules, ...rootRecallRules];
    let entries;
    try {
      entries = (await readdir(absoluteDirectory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      if (relativeDirectory === '' && error?.code === 'ENOTDIR') throw error;
      const locator = safeWorkspaceLocatorFor(relativeDirectory) ?? 'workspace://__source_graph_scan__';
      recordUnreadableDirectory(locator);
      return;
    }
    if (gitIgnoreUnavailable) {
      const locator = safeWorkspaceLocatorFor(normalizeRelative(path.join(relativeDirectory, '.gitignore')));
      if (locator) recordUnreadableFile(locator);
    }
    for (const entry of entries) {
      const relativePath = normalizeRelative(path.join(relativeDirectory, entry.name));
      if (normalizedOnlyIncludes.length) {
        const selected = entry.isDirectory()
          ? normalizedOnlyIncludes.some((item) => item.startsWith(`${relativePath}/`))
          : normalizedOnlyIncludes.includes(relativePath);
        if (!selected) continue;
      }
      const absolutePath = path.join(rootReal, relativePath);
      const locator = safeWorkspaceLocatorFor(relativePath);
      if (!locator) {
        diagnostics.push(diagnostic('workspace://__source_graph_scan__', 'path_escape_skipped'));
        continue;
      }
      const explicitlyIncluded = normalizedExplicitIncludes.some((item) => item === relativePath || item.startsWith(`${relativePath}/`));
      if (isIgnoredPath(relativePath, { isDirectory: entry.isDirectory(), rules: activeRules, explicitIncludes: normalizedExplicitIncludes })) {
        recordIgnored(locator, entry.isDirectory());
        continue;
      }
      if (entry.isDirectory()) {
        const exclusionCode = EXCLUDED_DIRECTORY_POLICIES.get(entry.name);
        if (exclusionCode && (!explicitlyIncluded || NON_OVERRIDABLE_EXCLUDED_DIRECTORIES.has(entry.name))) {
          recordExcludedDirectory(locator, exclusionCode);
          continue;
        }
      }
      let info;
      try {
        info = await lstat(absolutePath);
      } catch {
        if (entry.isDirectory()) recordUnreadableDirectory(locator);
        else recordUnreadableFile(locator);
        continue;
      }
      if (info.isSymbolicLink()) {
        skippedLocators.add(locator);
        diagnostics.push(diagnostic(locator, 'symlink_skipped'));
        continue;
      }
      if (info.isDirectory()) {
        if (await walk(relativePath, gitRules)) return true;
        continue;
      }
      if (!info.isFile()) continue;
      const extension = path.extname(entry.name).toLowerCase();
      if (!EXTENSIONS.has(extension)) {
        unsupportedFileCount += 1;
        if (extension) unsupportedExtensionCounts.set(extension, (unsupportedExtensionCounts.get(extension) ?? 0) + 1);
        continue;
      }
      if (visitedFiles >= maxFiles) {
        markMaxFilesReached();
        return true;
      }
      let fileReal;
      try {
        fileReal = await realpath(absolutePath);
      } catch {
        recordUnreadableFile(locator);
        continue;
      }
      if (!insideRoot(rootReal, fileReal)) {
        skippedLocators.add(locator);
        diagnostics.push(diagnostic(locator, 'path_escape_skipped'));
        continue;
      }
      let size;
      try {
        size = info.size ?? (await stat(fileReal)).size;
      } catch {
        recordUnreadableFile(locator);
        continue;
      }
      if (size > maxFileBytes) {
        skippedLocators.add(locator);
        oversizedLocators.add(locator);
        diagnostics.push(diagnostic(locator, 'file_too_large'));
        continue;
      }
      discoveredFiles.push(Object.freeze({
        relativePath,
        locator,
        size,
        mtimeMs: Number.isFinite(info.mtimeMs) ? Number(info.mtimeMs.toFixed(3)) : 0
      }));
      if (metadataOnly) {
        visitedFiles += 1;
        continue;
      }
      let body;
      try {
        body = await readFile(fileReal, 'utf8');
      } catch {
        recordUnreadableFile(locator);
        continue;
      }
      visitedFiles += 1;
      const collectedAt = clock();
      const fileChunks = chunksForFile({ relativePath, body, workspaceId, collectedAt });
      chunks.push(...fileChunks);
      fileOutlines.push(fileOutlineFor({ relativePath, body, workspaceId, collectedAt, chunks: fileChunks }));
    }
    return false;
  }

  await walk();
  const sortedChunks = chunks.sort((a, b) => a.locator.localeCompare(b.locator));
  const sortedFileOutlines = fileOutlines.sort((a, b) => a.locator.localeCompare(b.locator));
  const symbolIndex = buildSymbolIndex({ workspaceId, chunks: sortedChunks, fileOutlines: sortedFileOutlines, indexedAt: clock() });
  const publicCoverage = sourceGraphCoverage({
    representedJsTsLocators: sortedFileOutlines.map((file) => file.locator),
    skippedLocators: [...skippedLocators],
    oversizedLocators: [...oversizedLocators],
    excludedDirectoryCount,
    excludedDirectoryLocators: [...excludedDirectoryLocators],
    declaredOutOfScopeDirectoryCount,
    declaredOutOfScopeDirectoryLocators: [...declaredOutOfScopeDirectoryLocators],
    sourceRelevantExcludedDirectoryCount,
    sourceRelevantExcludedDirectoryLocators: [...sourceRelevantExcludedDirectoryLocators],
    unsupportedFileCount,
    unsupportedExtensions: [...unsupportedExtensionCounts.keys()],
    maxFilesReached,
    diagnosticCodes: diagnostics.map((item) => item.code)
  });
  const boundedUnsupportedExtensionCounts = Object.fromEntries(
    [...unsupportedExtensionCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, MAX_COVERAGE_UNSUPPORTED_EXTENSIONS)
  );
  const coverage = Object.freeze({
    ...publicCoverage,
    ignoredFileCount,
    ignoredDirectoryCount,
    ignoredSamples: [...ignoredSamples].sort(),
    unsupportedExtensionCounts: boundedUnsupportedExtensionCounts
  });
  const discoveryIdentity = Object.freeze({
    ignoreFileLocators: [...ignoreFileLocators].sort(),
    ignoreRuleFingerprint: contentFingerprint({
      rules: normalizedIgnoreRules.map(({ base, pattern, negated, directoryOnly }) => ({ base, pattern, negated, directoryOnly })),
      explicitIncludes: [...normalizedExplicitIncludes].sort(),
      onlyIncludes: [...normalizedOnlyIncludes].sort()
    })
  });
  const result = {
    schemaVersion: '1.0.0',
    workspaceId,
    parserVersion: AST_CODE_PARSER_VERSION,
    fileCount: visitedFiles,
    chunkCount: sortedChunks.length,
    chunks: sortedChunks,
    discoveredFiles: discoveredFiles.sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    fileOutlines: sortedFileOutlines,
    repositoryOutline: repositoryOutlineFor({ workspaceId, fileOutlines: sortedFileOutlines, symbolIndex }),
    contentJournal: sortedFileOutlines.map((file) => ({
      locator: file.locator,
      contentHash: file.contentHash,
      symbolFingerprint: file.symbolFingerprint,
      collectedAt: file.collectedAt
    })),
    symbolIndex,
    coverage,
    discoveryIdentity,
    diagnostics: diagnostics.sort((a, b) => a.locator.localeCompare(b.locator) || a.code.localeCompare(b.code))
  };
  return Object.freeze({ ...result, scanFingerprint: contentFingerprint(result) });
}

function sourceGraphCoverage({
  representedJsTsLocators = [],
  skippedLocators = [],
  oversizedLocators = [],
  excludedDirectoryCount = 0,
  excludedDirectoryLocators = [],
  declaredOutOfScopeDirectoryCount = 0,
  declaredOutOfScopeDirectoryLocators = [],
  sourceRelevantExcludedDirectoryCount = 0,
  sourceRelevantExcludedDirectoryLocators = [],
  unsupportedFileCount = 0,
  unsupportedExtensions = [],
  unsupportedExtensionCounts = {},
  ignoredFileCount = 0,
  ignoredDirectoryCount = 0,
  ignoredSamples = [],
  maxFilesReached = false,
  diagnosticCodes = []
} = {}) {
  const represented = uniqueSortedStrings(representedJsTsLocators).slice(0, MAX_COVERAGE_REPRESENTED_LOCATORS);
  const skipped = uniqueSortedStrings(skippedLocators).slice(0, MAX_COVERAGE_SKIPPED_LOCATORS);
  const oversized = uniqueSortedStrings(oversizedLocators).slice(0, MAX_COVERAGE_SKIPPED_LOCATORS);
  const excludedDirectories = uniqueSortedStrings(excludedDirectoryLocators).slice(0, MAX_COVERAGE_EXCLUDED_DIRECTORY_LOCATORS);
  const declaredOutOfScopeDirectories = uniqueSortedStrings(declaredOutOfScopeDirectoryLocators).slice(0, MAX_COVERAGE_EXCLUDED_DIRECTORY_LOCATORS);
  const sourceRelevantExcludedDirectories = uniqueSortedStrings(sourceRelevantExcludedDirectoryLocators).slice(0, MAX_COVERAGE_EXCLUDED_DIRECTORY_LOCATORS);
  const extensions = uniqueSortedStrings(unsupportedExtensions)
    .filter((extension) => /^\.[a-z0-9]{1,16}$/u.test(extension))
    .slice(0, MAX_COVERAGE_UNSUPPORTED_EXTENSIONS);
  const boundedUnsupportedExtensionCounts = Object.fromEntries(
    Object.entries(unsupportedExtensionCounts ?? {})
      .filter(([extension, count]) => /^\.[a-z0-9]{1,16}$/u.test(extension) && Number.isInteger(count) && count >= 0)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, MAX_COVERAGE_UNSUPPORTED_EXTENSIONS)
  );
  const ignored = uniqueSortedStrings(ignoredSamples)
    .filter((locator) => SOURCE_GRAPH_WORKSPACE_LOCATOR_RE.test(locator))
    .slice(0, MAX_COVERAGE_IGNORED_SAMPLES);
  const reasons = new Set();
  const partialReasons = new Set();
  if (oversizedLocators.length) partialReasons.add('file_too_large');
  if (unsupportedFileCount > 0) partialReasons.add('unsupported_extensions_skipped');
  if (maxFilesReached) partialReasons.add('max_files_reached');
  if (declaredOutOfScopeDirectoryCount > 0) reasons.add('declared_out_of_scope_directory_excluded');
  if (sourceRelevantExcludedDirectoryCount > 0) partialReasons.add('source_relevant_directory_excluded');
  for (const code of diagnosticCodes) {
    if (code === 'symlink_skipped' || code === 'path_escape_skipped' || code === 'file_unreadable' || code === 'directory_unreadable' || code === 'directory_discovery_unavailable' || code === 'directory_discovery_capped') partialReasons.add(code);
    if (code === 'excluded_directory_diagnostics_truncated') reasons.add(code);
  }
  for (const code of partialReasons) reasons.add(code);
  const reasonCodes = [...reasons].sort();
  return Object.freeze({
    status: partialReasons.size ? 'partial' : 'complete',
    representedFileCount: representedJsTsLocators.length,
    representedJsTsLocators: represented,
    skippedFileCount: skippedLocators.length,
    skippedLocators: skipped,
    oversizedFileCount: oversizedLocators.length,
    oversizedLocators: oversized,
    excludedDirectoryCount: Math.max(0, excludedDirectoryCount),
    excludedDirectoryLocators: excludedDirectories,
    declaredOutOfScopeDirectoryCount: Math.max(0, declaredOutOfScopeDirectoryCount),
    declaredOutOfScopeDirectoryLocators: declaredOutOfScopeDirectories,
    sourceRelevantExcludedDirectoryCount: Math.max(0, sourceRelevantExcludedDirectoryCount),
    sourceRelevantExcludedDirectoryLocators: sourceRelevantExcludedDirectories,
    unsupportedFileCount: Math.max(0, unsupportedFileCount),
    unsupportedExtensions: extensions,
    unsupportedExtensionCounts: boundedUnsupportedExtensionCounts,
    ignoredFileCount: Math.max(0, ignoredFileCount),
    ignoredDirectoryCount: Math.max(0, ignoredDirectoryCount),
    ignoredSamples: ignored,
    maxFilesReached: Boolean(maxFilesReached),
    reasonCodes
  });
}

function addBoundedLocator(locators, locator, maximum) {
  if (locators.size < maximum) locators.add(locator);
}

function uniqueSortedStrings(values) {
  return [...new Set((values ?? []).map((value) => String(value)).filter(Boolean))].sort();
}

export async function buildJsTsSourceIndex(options = {}) {
  const scan = await scanAstCodeWorkspace(options);
  const coverage = sourceGraphCoverage({
    ...scan.coverage,
    diagnosticCodes: scan.diagnostics.map((item) => item.code)
  });
  return Object.freeze({
    schemaVersion: '1.0.0',
    workspaceId: scan.workspaceId,
    parserVersion: scan.parserVersion,
    scanFingerprint: scan.scanFingerprint,
    repositoryOutline: scan.repositoryOutline,
    fileOutlines: scan.fileOutlines,
    contentJournal: scan.contentJournal,
    symbolIndex: scan.symbolIndex,
    coverage,
    discoveryIdentity: scan.discoveryIdentity,
    diagnostics: scan.diagnostics,
    sourceIndexFingerprint: contentFingerprint({
      repositoryOutline: scan.repositoryOutline,
      fileOutlines: scan.fileOutlines,
      contentJournal: scan.contentJournal,
      symbolIndex: scan.symbolIndex,
      coverage,
      discoveryIdentity: scan.discoveryIdentity,
      diagnostics: scan.diagnostics
    })
  });
}

export function buildJsTsSourceIndexFromShards({
  workspaceId = 'ws_local',
  parserVersion = AST_CODE_PARSER_VERSION,
  shards = [],
  coverage = {},
  discoveryIdentity = {},
  diagnostics = [],
  clock = () => new Date().toISOString()
} = {}) {
  const sortedShards = [...shards].sort((left, right) => left.locator.localeCompare(right.locator));
  const chunks = sortedShards.flatMap((shard) => shard.chunks ?? []).sort((left, right) => left.locator.localeCompare(right.locator));
  const fileOutlines = sortedShards.map((shard) => shard.fileOutline).filter(Boolean).sort((left, right) => left.locator.localeCompare(right.locator));
  const indexedAt = clock();
  const symbolIndex = buildSymbolIndex({ workspaceId, chunks, fileOutlines, indexedAt });
  const normalizedCoverage = sourceGraphCoverage({
    ...coverage,
    representedJsTsLocators: fileOutlines.map((file) => file.locator),
    diagnosticCodes: diagnostics.map((item) => item.code)
  });
  const repositoryOutline = repositoryOutlineFor({ workspaceId, fileOutlines, symbolIndex });
  const contentJournal = fileOutlines.map((file) => ({
    locator: file.locator,
    contentHash: file.contentHash,
    symbolFingerprint: file.symbolFingerprint,
    collectedAt: file.collectedAt
  }));
  const scanFingerprint = contentFingerprint({
    workspaceId,
    parserVersion,
    contentJournal,
    discoveryIdentity,
    diagnostics
  });
  const result = {
    schemaVersion: '1.0.0',
    workspaceId,
    parserVersion,
    scanFingerprint,
    repositoryOutline,
    fileOutlines,
    contentJournal,
    symbolIndex,
    coverage: normalizedCoverage,
    discoveryIdentity,
    diagnostics
  };
  return Object.freeze({
    ...result,
    sourceIndexFingerprint: contentFingerprint(result)
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
  return buildSourceGraphFromIndex(index, {
    builtAt: safeTimestamp(options.clock),
    maxNodes: options.maxNodes,
    maxEdges: options.maxEdges
  });
}

export function buildSourceGraphFromIndex(index, {
  builtAt = new Date().toISOString(),
  maxNodes = DEFAULT_SOURCE_GRAPH_MAX_NODES,
  maxEdges = DEFAULT_SOURCE_GRAPH_MAX_EDGES
} = {}) {
  if (!index?.symbolIndex) throw new Error('source index is required');
  const workspaceId = index.workspaceId ?? index.symbolIndex.workspaceId;
  if (!workspaceId) throw new Error('source graph workspaceId is required');
  const nodeLimit = boundedInteger(maxNodes, 'source_graph_max_nodes', 1, DEFAULT_SOURCE_GRAPH_MAX_NODES);
  const edgeLimit = boundedInteger(maxEdges, 'source_graph_max_edges', 1, DEFAULT_SOURCE_GRAPH_MAX_EDGES);
  const nodesById = new Map();
  const seenNodeIds = new Set();
  const seenEdgeIds = new Set();
  const candidateNodeKindCounts = {};
  const candidateEdgeKindCounts = {};
  const edgeCandidatesByKind = new Map(EDGE_BUDGET_ORDER.map((kind) => [kind, []]));
  const fileOutlinesByLocator = new Map((index.fileOutlines ?? []).map((file) => [file.locator, file]));
  const knownFileLocators = new Set(fileOutlinesByLocator.keys());
  const symbols = [...(index.symbolIndex.symbols ?? [])].sort((left, right) => left.id.localeCompare(right.id));
  const imports = [...(index.symbolIndex.imports ?? [])].sort((left, right) => left.id.localeCompare(right.id));
  const exports = [...(index.symbolIndex.exports ?? [])].sort((left, right) => left.id.localeCompare(right.id));
  const callEdges = [...(index.symbolIndex.callEdges ?? [])].sort((left, right) => left.id.localeCompare(right.id));
  const references = [...(index.symbolIndex.references ?? [])].sort((left, right) => left.id.localeCompare(right.id));

  function increment(counts, kind) {
    counts[kind] = (counts[kind] ?? 0) + 1;
  }

  function addNode(node) {
    if (seenNodeIds.has(node.id)) return nodesById.get(node.id) ?? null;
    seenNodeIds.add(node.id);
    increment(candidateNodeKindCounts, node.kind);
    if (nodesById.size >= nodeLimit) return null;
    const frozen = Object.freeze(node);
    nodesById.set(frozen.id, frozen);
    return frozen;
  }

  function stageEdge(edge) {
    if (seenEdgeIds.has(edge.id)) return;
    seenEdgeIds.add(edge.id);
    increment(candidateEdgeKindCounts, edge.kind);
    if (!nodesById.has(edge.fromNodeId) || !nodesById.has(edge.toNodeId)) return;
    const frozen = Object.freeze(edge);
    offerBoundedEdgeCandidate(edgeCandidatesByKind.get(frozen.kind), frozen, edgeLimit);
  }

  function addFileNode(locator) {
    const fileLocator = fileLocatorFor(locator);
    const outline = fileOutlinesByLocator.get(fileLocator);
    const id = sourceGraphNodeId('file', fileLocator);
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

  function rememberChunk(chunksById, { chunkId, locator, contentHash = null, sourceSnapshotId = null }) {
    if (!chunkId || !locator) return;
    const current = chunksById.get(chunkId);
    chunksById.set(chunkId, {
      chunkId,
      locator: current?.locator ?? locator,
      contentHash: current?.contentHash ?? contentHash,
      sourceSnapshotId: current?.sourceSnapshotId ?? sourceSnapshotId
    });
  }

  function offerBoundedEdgeCandidate(heap, edge, limit) {
    if (!heap) return;
    if (heap.length < limit) {
      heap.push(edge);
      let child = heap.length - 1;
      while (child > 0) {
        const parent = Math.floor((child - 1) / 2);
        if (heap[parent].id.localeCompare(heap[child].id) >= 0) break;
        [heap[parent], heap[child]] = [heap[child], heap[parent]];
        child = parent;
      }
      return;
    }
    if (edge.id.localeCompare(heap[0].id) >= 0) return;
    heap[0] = edge;
    let parent = 0;
    while (true) {
      const left = parent * 2 + 1;
      const right = left + 1;
      let largest = parent;
      if (left < heap.length && heap[left].id.localeCompare(heap[largest].id) > 0) largest = left;
      if (right < heap.length && heap[right].id.localeCompare(heap[largest].id) > 0) largest = right;
      if (largest === parent) break;
      [heap[parent], heap[largest]] = [heap[largest], heap[parent]];
      parent = largest;
    }
  }

  const fileLocators = new Set([
    ...(index.symbolIndex.fileLocators ?? []),
    ...(index.repositoryOutline?.locators ?? []),
    ...(index.fileOutlines ?? []).map((file) => file.locator),
    ...symbols.map((symbol) => symbol.locator),
    ...imports.map((item) => item.locator),
    ...exports.map((item) => item.locator),
    ...references.map((item) => item.sourceLocator),
    ...callEdges.map((item) => item.sourceLocator)
  ].filter(Boolean).map(fileLocatorFor));
  for (const locator of [...fileLocators].sort()) addFileNode(locator);

  const chunksById = new Map();
  for (const symbol of symbols) rememberChunk(chunksById, {
    chunkId: symbol.chunkId,
    locator: symbol.locator,
    contentHash: symbol.contentHash,
    sourceSnapshotId: symbol.sourceSnapshotId
  });
  for (const item of imports) rememberChunk(chunksById, { chunkId: item.chunkId, locator: item.locator });
  for (const item of references) rememberChunk(chunksById, { chunkId: item.sourceChunkId, locator: item.sourceLocator });
  for (const item of exports) rememberChunk(chunksById, { chunkId: item.chunkId, locator: item.locator });

  for (const chunk of [...chunksById.values()].sort((left, right) => left.chunkId.localeCompare(right.chunkId))) {
    const chunkNodeId = sourceGraphNodeId('chunk', chunk.chunkId);
    const fileNodeId = sourceGraphNodeId('file', fileLocatorFor(chunk.locator));
    addNode(withDefined({
      id: chunkNodeId,
      workspaceId,
      kind: 'chunk',
      label: locatorLabel(chunk.locator),
      locator: chunk.locator,
      sourceRef: chunk.chunkId,
      contentHash: chunk.contentHash,
      sourceSnapshotId: chunk.sourceSnapshotId
    }));
    stageEdge(withDefined({
      id: sourceGraphEdgeId('contains', fileNodeId, chunkNodeId, chunk.chunkId),
      workspaceId,
      kind: 'contains',
      fromNodeId: fileNodeId,
      toNodeId: chunkNodeId,
      locator: chunk.locator,
      sourceRef: chunk.chunkId,
      confidence: 1
    }));
  }

  const symbolsByChunkId = new Map();
  for (const symbol of symbols) {
    const chunkSymbols = symbolsByChunkId.get(symbol.chunkId) ?? [];
    chunkSymbols.push(symbol);
    symbolsByChunkId.set(symbol.chunkId, chunkSymbols);
    const symbolNodeId = sourceGraphNodeId('symbol', symbol.id);
    const chunkNodeId = sourceGraphNodeId('chunk', symbol.chunkId);
    addNode(withDefined({
      id: symbolNodeId,
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
    stageEdge(withDefined({
      id: sourceGraphEdgeId('defined_in', symbolNodeId, chunkNodeId, symbol.id),
      workspaceId,
      kind: 'defined_in',
      fromNodeId: symbolNodeId,
      toNodeId: chunkNodeId,
      locator: symbol.locator,
      sourceRef: symbol.id,
      confidence: 1
    }));
  }

  const firstImportByModule = new Map();
  for (const item of imports) if (!firstImportByModule.has(item.module)) firstImportByModule.set(item.module, item);
  for (const [moduleName, item] of [...firstImportByModule.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    addNode(withDefined({
      id: sourceGraphNodeId('module', item.module),
      workspaceId,
      kind: 'module',
      label: moduleName,
      sourceRef: item.moduleHash,
      moduleHash: item.moduleHash
    }));
  }

  for (const item of imports) {
    const chunkNodeId = sourceGraphNodeId('chunk', item.chunkId);
    const moduleNodeId = sourceGraphNodeId('module', item.module);
    stageEdge(withDefined({
      id: sourceGraphEdgeId('imports', chunkNodeId, moduleNodeId, item.id),
      workspaceId,
      kind: 'imports',
      fromNodeId: chunkNodeId,
      toNodeId: moduleNodeId,
      locator: item.locator,
      sourceRef: item.id,
      confidence: 0.9
    }));
    const importedFileLocator = resolveImportFileLocator(item.locator, item.module, knownFileLocators);
    if (importedFileLocator) {
      const importedFileNodeId = sourceGraphNodeId('file', importedFileLocator);
      stageEdge(withDefined({
        id: sourceGraphEdgeId('imports', chunkNodeId, importedFileNodeId, `${item.id}:file`),
        workspaceId,
        kind: 'imports',
        fromNodeId: chunkNodeId,
        toNodeId: importedFileNodeId,
        locator: importedFileLocator,
        sourceRef: item.id,
        confidence: 0.85
      }));
    }
  }

  for (const item of exports) {
    const fileNodeId = sourceGraphNodeId('file', fileLocatorFor(item.locator));
    const chunkSymbols = symbolsByChunkId.get(item.chunkId) ?? [];
    const targetSymbol = chunkSymbols.find((symbol) => symbol.name === item.name) ?? chunkSymbols[0];
    const targetNodeId = targetSymbol
      ? sourceGraphNodeId('symbol', targetSymbol.id)
      : sourceGraphNodeId('chunk', item.chunkId);
    stageEdge(withDefined({
      id: sourceGraphEdgeId('exports', fileNodeId, targetNodeId, item.id),
      workspaceId,
      kind: 'exports',
      fromNodeId: fileNodeId,
      toNodeId: targetNodeId,
      locator: item.locator,
      sourceRef: item.id,
      exportName: item.name,
      confidence: 1
    }));
  }

  for (const item of callEdges) {
    const callerNodeId = sourceGraphNodeId('symbol', item.callerSymbolId);
    const calleeNodeId = sourceGraphNodeId('symbol', item.calleeSymbolId);
    stageEdge(withDefined({
      id: sourceGraphEdgeId('calls', callerNodeId, calleeNodeId, item.id),
      workspaceId,
      kind: 'calls',
      fromNodeId: callerNodeId,
      toNodeId: calleeNodeId,
      locator: item.sourceLocator,
      sourceRef: item.id,
      confidence: 0.7
    }));
  }

  for (const item of references) {
    const sourceChunkNodeId = sourceGraphNodeId('chunk', item.sourceChunkId);
    const targetNodeId = sourceGraphNodeId('symbol', item.targetSymbolId);
    stageEdge(withDefined({
      id: sourceGraphEdgeId('references', sourceChunkNodeId, targetNodeId, item.id),
      workspaceId,
      kind: 'references',
      fromNodeId: sourceChunkNodeId,
      toNodeId: targetNodeId,
      locator: item.sourceLocator,
      sourceRef: item.id,
      confidence: 0.75
    }));
  }

  const edgesById = new Map();
  for (const kind of EDGE_BUDGET_ORDER) {
    const candidates = edgeCandidatesByKind.get(kind).sort((left, right) => left.id.localeCompare(right.id));
    for (const edge of candidates) {
      if (edgesById.size >= edgeLimit) break;
      edgesById.set(edge.id, edge);
    }
  }
  const nodes = [...nodesById.values()].sort((a, b) => a.id.localeCompare(b.id));
  const edges = [...edgesById.values()].sort((a, b) => a.id.localeCompare(b.id));
  const representedNodeKindCounts = countBy(nodes, (node) => node.kind);
  const representedEdgeKindCounts = countBy(edges, (edge) => edge.kind);
  const omittedNodeKindCounts = countDifference(candidateNodeKindCounts, representedNodeKindCounts);
  const omittedEdgeKindCounts = countDifference(candidateEdgeKindCounts, representedEdgeKindCounts);
  const candidateNodeCount = countTotal(candidateNodeKindCounts);
  const candidateEdgeCount = countTotal(candidateEdgeKindCounts);
  const omittedNodeCount = countTotal(omittedNodeKindCounts);
  const omittedEdgeCount = countTotal(omittedEdgeKindCounts);
  const budgetReasonCodes = [
    ...(omittedNodeCount ? ['node_budget_reached'] : []),
    ...(omittedEdgeCount ? ['edge_budget_reached'] : [])
  ];
  const reasonCodes = [...new Set([...budgetReasonCodes, ...(index.coverage?.reasonCodes ?? [])])]
    .slice(0, 16)
    .sort();
  const coverage = Object.freeze(withDefined({
    ...(index.coverage ?? {}),
    ignoreRuleFingerprint: index.discoveryIdentity?.ignoreRuleFingerprint,
    ignoreFileLocators: index.discoveryIdentity?.ignoreFileLocators,
    status: omittedNodeCount || omittedEdgeCount || index.coverage?.status === 'partial' ? 'partial' : 'complete',
    candidateNodeCount,
    representedNodeCount: nodes.length,
    omittedNodeCount,
    candidateNodeKindCounts: freezeCountMap(candidateNodeKindCounts),
    representedNodeKindCounts,
    omittedNodeKindCounts,
    candidateEdgeCount,
    representedEdgeCount: edges.length,
    omittedEdgeCount,
    candidateEdgeKindCounts: freezeCountMap(candidateEdgeKindCounts),
    representedEdgeKindCounts,
    omittedEdgeKindCounts,
    reasonCodes
  }));
  const graph = {
    schemaVersion: '1.0.0',
    workspaceId,
    graphVersion: 'oaf-native-source-graph-1.0.0',
    parserVersion: index.parserVersion ?? index.symbolIndex.parserVersion ?? AST_CODE_PARSER_VERSION,
    builtAt,
    sourceIndexFingerprint: index.sourceIndexFingerprint ?? index.symbolIndex.symbolIndexFingerprint,
    summary: sourceGraphSummary({ nodes, edges, coverage }),
    nodes,
    edges,
    diagnostics: [...(index.diagnostics ?? [])].sort((a, b) => a.locator.localeCompare(b.locator) || a.code.localeCompare(b.code))
  };
  return Object.freeze({ ...graph, graphFingerprint: graphContentFingerprint(graph) });
}

function freezeCountMap(counts) {
  return Object.freeze(Object.fromEntries(
    Object.entries(counts ?? {})
      .filter(([, count]) => Number.isInteger(count) && count > 0)
      .sort((left, right) => left[0].localeCompare(right[0]))
  ));
}

function countDifference(candidateCounts, representedCounts) {
  return freezeCountMap(Object.fromEntries(
    Object.entries(candidateCounts ?? {}).map(([kind, count]) => [kind, Math.max(0, count - (representedCounts?.[kind] ?? 0))])
  ));
}

function countTotal(counts) {
  return Object.values(counts ?? {}).reduce((total, count) => total + count, 0);
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
  const publicGraph = sanitizeSourceGraphPublicOutput(graph);
  const boundedLimit = boundedInteger(limit, 'source_graph_search_limit', 1, 100);
  const boundedOffset = boundedInteger(offset, 'source_graph_search_offset', 0, 10_000);
  const nodeKindSet = nodeKinds ? new Set(nodeKinds) : null;
  const edgeKindSet = edgeKinds ? new Set(edgeKinds) : null;
  const includeNodes = !edgeKindSet || Boolean(nodeKindSet);
  const includeEdges = !nodeKindSet || Boolean(edgeKindSet);
  const pattern = labelPattern ? safeRegex(labelPattern, 'source_graph_label_pattern_invalid') : null;
  const nodeById = new Map(publicGraph.nodes.map((node) => [node.id, node]));
  const queryText = String(query ?? '');
  const queryTerms = terms(queryText);
  const results = [];

  for (const node of includeNodes ? publicGraph.nodes : []) {
    if (!safeSourceGraphSearchNode(node)) continue;
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

  for (const edge of includeEdges ? publicGraph.edges : []) {
    const from = nodeById.get(edge.fromNodeId);
    const to = nodeById.get(edge.toNodeId);
    if (!safeSourceGraphSearchEdge(edge, { from, to })) continue;
    if (edgeKindSet && !edgeKindSet.has(edge.kind)) continue;
    if (locatorPrefix && !(edge.locator ?? '').startsWith(locatorPrefix)) continue;
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
    workspaceId: publicGraph.workspaceId,
    graphFingerprint: publicGraph.graphFingerprint,
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

// Direct graph inputs remain available for local inspection, but each public
// read surface consumes this projected envelope so unsafe metadata, labels, and
// locators never leave a result array.
export function sanitizeSourceGraphPublicOutput(graph) {
  assertSourceGraph(graph);
  if (SOURCE_GRAPH_PUBLIC_PROJECTIONS.has(graph)) return graph;
  const metadata = sourceGraphPublicMetadata(graph);
  if (!metadata.envelopeValid) {
    return rememberPublicSourceGraphProjection(Object.freeze({
      ...metadata,
      diagnosticsComplete: false,
      nodes: Object.freeze([]),
      edges: Object.freeze([]),
      diagnostics: Object.freeze([])
    }));
  }
  const nodes = graph.nodes
    .map((node) => publicSourceGraphNode(node, { workspaceId: metadata.workspaceId }))
    .filter(Boolean);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const edges = graph.edges
    .map((edge) => publicSourceGraphEdge(edge, {
      workspaceId: metadata.workspaceId,
      from: nodeById.get(edge?.fromNodeId),
      to: nodeById.get(edge?.toNodeId)
    }))
    .filter(Boolean);
  const rawDiagnostics = Array.isArray(graph.diagnostics) ? graph.diagnostics : [];
  const diagnostics = rawDiagnostics.map(publicSourceGraphDiagnostic).filter(Boolean);
  return rememberPublicSourceGraphProjection(Object.freeze({
    ...metadata,
    diagnosticsComplete: Array.isArray(graph.diagnostics) && diagnostics.length === graph.diagnostics.length,
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
    diagnostics: Object.freeze(diagnostics)
  }));
}

function rememberPublicSourceGraphProjection(graph) {
  SOURCE_GRAPH_PUBLIC_PROJECTIONS.add(graph);
  return graph;
}

function sourceGraphPublicMetadata(graph) {
  const workspaceId = safeSourceGraphWorkspaceId(graph.workspaceId)
    ? graph.workspaceId
    : SOURCE_GRAPH_PUBLIC_FALLBACK_WORKSPACE_ID;
  const graphFingerprint = safeSourceGraphFingerprint(graph.graphFingerprint)
    ? graph.graphFingerprint
    : SOURCE_GRAPH_PUBLIC_FALLBACK_GRAPH_FINGERPRINT;
  const sourceIndexFingerprint = safeSourceGraphFingerprint(graph.sourceIndexFingerprint)
    ? graph.sourceIndexFingerprint
    : SOURCE_GRAPH_PUBLIC_FALLBACK_SOURCE_INDEX_FINGERPRINT;
  const graphVersion = safeSourceGraphVersion(graph.graphVersion)
    ? graph.graphVersion
    : SOURCE_GRAPH_PUBLIC_FALLBACK_GRAPH_VERSION;
  const parserVersion = safeSourceGraphVersion(graph.parserVersion)
    ? graph.parserVersion
    : SOURCE_GRAPH_PUBLIC_FALLBACK_PARSER_VERSION;
  const builtAt = safeSourceGraphTimestamp(graph.builtAt)
    ? graph.builtAt
    : SOURCE_GRAPH_PUBLIC_FALLBACK_BUILT_AT;
  const providedMetadataIsSafe = [
    [graph.workspaceId, safeSourceGraphWorkspaceId],
    [graph.graphFingerprint, safeSourceGraphFingerprint],
    [graph.sourceIndexFingerprint, safeSourceGraphFingerprint],
    [graph.graphVersion, safeSourceGraphVersion],
    [graph.parserVersion, safeSourceGraphVersion],
    [graph.builtAt, safeSourceGraphTimestamp]
  ].every(([value, validator]) => value === undefined || value === null || validator(value));
  const completeEnvelope = providedMetadataIsSafe
    && safeSourceGraphWorkspaceId(graph.workspaceId)
    && safeSourceGraphFingerprint(graph.graphFingerprint)
    && safeSourceGraphFingerprint(graph.sourceIndexFingerprint)
    && safeSourceGraphVersion(graph.graphVersion)
    && safeSourceGraphVersion(graph.parserVersion)
    && safeSourceGraphTimestamp(graph.builtAt);
  return Object.freeze({
    schemaVersion: '1.0.0',
    workspaceId,
    graphFingerprint,
    sourceIndexFingerprint,
    graphVersion,
    parserVersion,
    builtAt,
    envelopeValid: providedMetadataIsSafe,
    completeEnvelope
  });
}

function publicSourceGraphNode(node, { workspaceId }) {
  if (node?.workspaceId !== undefined && node?.workspaceId !== null && node.workspaceId !== workspaceId) return null;
  const projected = withDefined({
    id: node?.id,
    workspaceId: node?.workspaceId ?? workspaceId,
    kind: node?.kind,
    label: node?.label,
    qualifiedLabel: node?.qualifiedLabel,
    locator: node?.locator,
    sourceRef: node?.sourceRef,
    symbolKind: node?.symbolKind,
    scopeChain: Array.isArray(node?.scopeChain) ? Object.freeze([...node.scopeChain]) : node?.scopeChain,
    moduleHash: node?.moduleHash,
    contentHash: node?.contentHash,
    sourceSnapshotId: node?.sourceSnapshotId
  });
  return safeSourceGraphPublicNode(projected) ? Object.freeze(projected) : null;
}

function publicSourceGraphEdge(edge, { workspaceId, from, to }) {
  if (edge?.workspaceId !== undefined && edge?.workspaceId !== null && edge.workspaceId !== workspaceId) return null;
  const projected = withDefined({
    id: edge?.id,
    workspaceId: edge?.workspaceId ?? workspaceId,
    kind: edge?.kind,
    fromNodeId: edge?.fromNodeId,
    toNodeId: edge?.toNodeId,
    locator: edge?.locator,
    sourceRef: edge?.sourceRef,
    exportName: edge?.exportName,
    confidence: edge?.confidence
  });
  return safeSourceGraphPublicEdge(projected, { from, to }) ? Object.freeze(projected) : null;
}

function publicSourceGraphDiagnostic(diagnostic) {
  const projected = withDefined({
    locator: diagnostic?.locator,
    code: diagnostic?.code
  });
  return safeSourceGraphPublicDiagnostic(projected) ? Object.freeze(projected) : null;
}

function safeSourceGraphPublicNode(node) {
  return Boolean(node)
    && SOURCE_GRAPH_NODE_ID_RE.test(String(node.id ?? ''))
    && safeSourceGraphWorkspaceId(node.workspaceId)
    && SOURCE_GRAPH_NODE_KINDS.has(node.kind)
    && safeArchitectureLabel(node.label)
    && (node.qualifiedLabel === undefined || safeArchitectureLabel(node.qualifiedLabel))
    && (node.locator === undefined || safeArchitectureLocator(node.locator))
    && (node.sourceRef === undefined || safeSourceGraphSourceRef(node.sourceRef))
    && (node.symbolKind === undefined || SOURCE_GRAPH_SYMBOL_KINDS.has(node.symbolKind))
    && (node.scopeChain === undefined || (Array.isArray(node.scopeChain) && node.scopeChain.length <= 16 && node.scopeChain.every(safeArchitectureLabel)))
    && (node.moduleHash === undefined || safeSourceGraphFingerprint(node.moduleHash))
    && (node.contentHash === undefined || safeSourceGraphFingerprint(node.contentHash))
    && (node.sourceSnapshotId === undefined || SOURCE_GRAPH_SNAPSHOT_ID_RE.test(String(node.sourceSnapshotId)));
}

function safeSourceGraphPublicEdge(edge, { from, to }) {
  return Boolean(edge)
    && SOURCE_GRAPH_EDGE_ID_RE.test(String(edge.id ?? ''))
    && safeSourceGraphWorkspaceId(edge.workspaceId)
    && SOURCE_GRAPH_EDGE_KINDS.has(edge.kind)
    && SOURCE_GRAPH_NODE_ID_RE.test(String(edge.fromNodeId ?? ''))
    && SOURCE_GRAPH_NODE_ID_RE.test(String(edge.toNodeId ?? ''))
    && safeSourceGraphPublicNode(from)
    && safeSourceGraphPublicNode(to)
    && (edge.locator === undefined || safeArchitectureLocator(edge.locator))
    && (edge.sourceRef === undefined || safeSourceGraphSourceRef(edge.sourceRef))
    && (edge.exportName === undefined || safeArchitectureLabel(edge.exportName))
    && (edge.confidence === undefined || (Number.isFinite(edge.confidence) && edge.confidence >= 0 && edge.confidence <= 1));
}

function safeSourceGraphPublicDiagnostic(diagnostic) {
  return Boolean(diagnostic)
    && safeArchitectureLocator(diagnostic.locator)
    && SOURCE_GRAPH_DIAGNOSTIC_CODE_RE.test(String(diagnostic.code ?? ''));
}

function safeSourceGraphWorkspaceId(value) {
  return typeof value === 'string' && SOURCE_GRAPH_WORKSPACE_ID_RE.test(value);
}

function sourceGraphCandidateWorkspaceId(requestedWorkspaceId, configuredWorkspaceId) {
  const configured = safeSourceGraphWorkspaceId(configuredWorkspaceId)
    ? configuredWorkspaceId
    : SOURCE_GRAPH_PUBLIC_FALLBACK_WORKSPACE_ID;
  return safeSourceGraphWorkspaceId(requestedWorkspaceId) ? requestedWorkspaceId : configured;
}

function safeSourceGraphFingerprint(value) {
  return typeof value === 'string' && SOURCE_GRAPH_FINGERPRINT_RE.test(value);
}

function safeSourceGraphSourceRef(value) {
  return typeof value === 'string' && SOURCE_GRAPH_SOURCE_REF_RE.test(value);
}

function safeSourceGraphVersion(value) {
  return typeof value === 'string' && SOURCE_GRAPH_VERSION_RE.test(value);
}

function safeSourceGraphTimestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
    && !Number.isNaN(Date.parse(value));
}

function safeSourceGraphSearchNode(node) {
  return safeSourceGraphPublicNode(node);
}

function safeSourceGraphSearchEdge(edge, { from, to }) {
  return safeSourceGraphPublicEdge(edge, { from, to });
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
  const publicGraph = sanitizeSourceGraphPublicOutput(graph);
  const boundedDepth = boundedInteger(depth, 'source_graph_trace_depth', 1, 5);
  const boundedLimit = boundedInteger(limit, 'source_graph_trace_limit', 1, 100);
  if (!['outbound', 'inbound', 'both'].includes(direction)) throw new Error(`source_graph_trace_direction_invalid:${direction}`);
  const requestedLocatorPrefix = locatorPrefix ? String(locatorPrefix) : null;
  const safeLocatorPrefix = requestedLocatorPrefix && safeArchitectureLocator(requestedLocatorPrefix) ? requestedLocatorPrefix : null;
  const invalidLocatorPrefix = Boolean(requestedLocatorPrefix && !safeLocatorPrefix);
  const edgeKindSet = new Set((edgeKinds ?? ['calls']).filter((kind) => SOURCE_GRAPH_EDGE_KINDS.has(kind)));
  const nodeById = new Map(publicGraph.nodes.map((node) => [node.id, node]));
  const starts = invalidLocatorPrefix
    ? []
    : sourceGraphTraceStartNodes(publicGraph, nodeById, { startName, startNodeId, locatorPrefix: safeLocatorPrefix });
  const outgoing = new Map();
  const incoming = new Map();
  for (const edge of publicGraph.edges.filter((item) => edgeKindSet.has(item.kind)).sort((a, b) => a.id.localeCompare(b.id))) {
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
    workspaceId: publicGraph.workspaceId,
    graphFingerprint: publicGraph.graphFingerprint,
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
  const publicGraph = sanitizeSourceGraphPublicOutput(graph);
  const boundedDepth = boundedInteger(depth, 'source_graph_diff_depth', 1, 5);
  const boundedLimit = boundedInteger(limit, 'source_graph_diff_limit', 1, 500);
  const changed = publicGraph.envelopeValid ? sourceGraphChangedLocatorSet(changedLocators) : new Set();
  const startNodes = publicGraph.nodes.filter((node) => node.kind === 'file' && changed.has(node.locator));
  const representedChangedLocators = startNodes.map((node) => node.locator).sort();
  const adjacency = new Map();
  const behaviorDegree = new Map(publicGraph.nodes.map((node) => [node.id, { inbound: 0, outbound: 0 }]));
  const exportedSymbolIds = new Set();
  for (const edge of publicGraph.edges) {
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
  const sameFileSymbolNodes = publicGraph.nodes
    .filter((node) => node.kind === 'symbol' && changed.has(fileLocatorFor(node.locator)))
    .sort((a, b) => sourceGraphImpactSymbolRank(b, behaviorDegree, exportedSymbolIds) - sourceGraphImpactSymbolRank(a, behaviorDegree, exportedSymbolIds) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  const seedNodes = (sameFileSymbolNodes.length ? sameFileSymbolNodes : startNodes).slice(0, boundedLimit);
  const nodeById = new Map(publicGraph.nodes.map((node) => [node.id, node]));
  const edgeById = new Map(publicGraph.edges.map((edge) => [edge.id, edge]));
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
    workspaceId: publicGraph.workspaceId,
    graphFingerprint: publicGraph.graphFingerprint,
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
  return `default-${safeTag(base ?? 'export').replace(/:/gu, '-')}`;
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
  if (!String(callName ?? '').startsWith('default-')) return [];
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
  return `default-${safeTag(base ?? 'export').replace(/:/gu, '-')}`;
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
  const normalized = value.replace(/\s+/gu, ' ').slice(0, 240);
  if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value) || /^file:/iu.test(value) || /(^|[\\/])(?:Users|private)([\\/]|$)/u.test(value) || /(^|[\\/])var[\\/]folders([\\/]|$)/u.test(value)) {
    return 'local:absolute-import';
  }
  return SOURCE_GRAPH_SAFE_LABEL_RE.test(normalized) ? normalized : 'external-module';
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
  const publicGraph = sanitizeSourceGraphPublicOutput(graph);
  const publicWorkspaceId = safeSourceGraphWorkspaceId(workspaceId)
    ? workspaceId
    : publicGraph.workspaceId;
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
    id: `graph_${sha256(`${result.id}:${result.locator ?? ''}:${publicGraph.graphFingerprint}`).slice(0, 32)}`,
    version: publicGraph.graphFingerprint,
    kind: 'observation',
    workspaceId: publicWorkspaceId,
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
    contentHash: hashRef(stableStringify({ graph: publicGraph.graphFingerprint, result })),
    metadata: {
      path: filePath,
      locator: result.locator ?? null,
      representation: 'source-graph-locator',
      retrieval: { candidateEligible: Boolean(result.locator) },
      sourceGraph: {
        graphFingerprint: publicGraph.graphFingerprint,
        sourceIndexFingerprint: publicGraph.sourceIndexFingerprint,
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
  return normalizeSourceGraphWorkspaceLocator(`workspace://${normalizeRelative(relativePath)}`);
}

function safeWorkspaceLocatorFor(relativePath) {
  try {
    return locatorFor(relativePath);
  } catch {
    return null;
  }
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

export function rankArchitectureNodes(graph, {
  changedLocators = [],
  query = '',
  limit = 20
} = {}) {
  assertSourceGraph(graph);
  const publicGraph = sanitizeSourceGraphPublicOutput(graph);
  const boundedLimit = boundedInteger(limit, 'source_graph_architecture_limit', 1, MAX_ARCHITECTURE_RANKING_RESULTS);
  const changed = sourceGraphChangedLocatorSet(changedLocators);
  const queryTerms = terms(String(query ?? '').slice(0, 512));
  const behaviorDegree = new Map(publicGraph.nodes.map((node) => [node.id, { inbound: 0, outbound: 0 }]));
  const exportedSymbolIds = new Set();
  for (const edge of publicGraph.edges) {
    if (edge.kind === 'exports') exportedSymbolIds.add(edge.toNodeId);
    if (!['calls', 'references'].includes(edge.kind)) continue;
    const from = behaviorDegree.get(edge.fromNodeId);
    const to = behaviorDegree.get(edge.toNodeId);
    if (from) from.outbound += 1;
    if (to) to.inbound += 1;
  }

  const candidates = publicGraph.nodes
    .filter((node) => architectureRankableSymbol(node))
    .map((node) => architectureCandidate({
      node,
      counts: behaviorDegree.get(node.id) ?? { inbound: 0, outbound: 0 },
      exported: exportedSymbolIds.has(node.id),
      changed: changed.has(fileLocatorFor(node.locator)),
      queryTerms
    }))
    .sort(compareArchitectureCandidates);
  const preferredCandidates = candidates.filter((candidate) => !candidate.deprioritized);
  const entryCandidates = preferredCandidates.filter((candidate) => candidate.entryEvidence || (candidate.inbound === 0 && candidate.outbound > 0));
  const hotspotCandidates = preferredCandidates.filter((candidate) => candidate.entryEvidence || candidate.total > 0);
  const entryPoints = (entryCandidates.length ? entryCandidates : preferredCandidates.length ? preferredCandidates : candidates)
    .slice(0, boundedLimit)
    .map(architectureNodeReference);
  const hotspots = (hotspotCandidates.length ? hotspotCandidates : preferredCandidates.length ? preferredCandidates : candidates)
    .slice(0, boundedLimit)
    .map(architectureHotspot);
  const deprioritized = candidates
    .filter((candidate) => candidate.deprioritized)
    .slice(0, Math.min(boundedLimit, MAX_ARCHITECTURE_DEPRIORITIZED))
    .map(architectureDeprioritizedDiagnostic);
  return Object.freeze({
    entryPoints: Object.freeze(entryPoints),
    hotspots: Object.freeze(hotspots),
    deprioritized: Object.freeze(deprioritized)
  });
}

function sourceGraphChangedLocatorSet(values) {
  const list = Array.isArray(values) ? values : values === null || values === undefined || values === '' ? [] : [values];
  const output = new Set();
  for (const value of list) {
    try {
      const locator = fileLocatorFor(String(value));
      if (safeArchitectureLocator(locator)) output.add(locator);
    } catch {
      // Public graph reads are read-only and fail closed for untrusted locators.
    }
  }
  return output;
}

function architectureRankableSymbol(node) {
  return node?.kind === 'symbol'
    && ['class', 'function', 'method', 'interface', 'type'].includes(node.symbolKind)
    && safeArchitectureLabel(node.label)
    && safeArchitectureLocator(node.locator);
}

function architectureCandidate({ node, counts, exported, changed, queryTerms }) {
  const signalCodes = [];
  let score = 0;
  function signal(code, multiplier = 1) {
    const definition = ARCHITECTURE_SIGNAL_TABLE[code];
    if (!definition) return;
    signalCodes.push(code);
    if (definition.weight !== undefined) score += definition.weight * multiplier;
    if (definition.perDegree !== undefined) score += Math.min(definition.maximum, definition.perDegree * multiplier);
  }
  const locatorSignals = architectureLocatorSignals(node.locator);
  for (const code of locatorSignals) signal(code);
  if (exported) signal('exported_symbol');
  if (changed) signal('changed_locator');
  if (architectureQueryMatches(node, queryTerms)) signal('query_match');
  if (counts.inbound > 0) signal('inbound_behavior', counts.inbound);
  if (counts.outbound > 0) signal('outbound_behavior', counts.outbound);
  if (architectureTestLocator(node.locator)) signal('test_locator_penalty');
  if (String(node.label).startsWith('#')) signal('private_symbol_penalty');
  if (architectureGenericUtilityName(node.label)) signal('generic_utility_penalty');
  const penaltyCodes = signalCodes.filter((code) => ARCHITECTURE_SIGNAL_TABLE[code]?.direction === 'deprioritize');
  return Object.freeze({
    node,
    inbound: counts.inbound,
    outbound: counts.outbound,
    total: counts.inbound + counts.outbound,
    score,
    reasonCodes: Object.freeze([...new Set(signalCodes)]),
    penaltyCodes: Object.freeze(penaltyCodes),
    deprioritized: penaltyCodes.length > 0,
    entryEvidence: ['class', 'function', 'method'].includes(node.symbolKind) && (locatorSignals.length > 0 || exported)
  });
}

function architectureLocatorSignals(locator) {
  const relative = relativeFromLocator(locator);
  const signals = [];
  if (/(?:^|\/)(?:route|handler|page|layout)\.[cm]?[jt]sx?$/u.test(relative) || /(?:^|\/)(?:api|routes?)(?:\/|$)/u.test(relative)) signals.push('route_locator');
  if (/(?:^|\/)bin\//u.test(relative)) signals.push('bin_locator', 'executable_script_locator');
  if (/^packages\/[^/]+\/(?:src\/)?(?:index|main|cli)\.[cm]?[jt]sx?$/u.test(relative)) signals.push('package_source_entry_locator');
  return signals;
}

function architectureQueryMatches(node, queryTerms) {
  if (!queryTerms.size) return false;
  const nodeTerms = terms(expandSearchText([node.label, node.qualifiedLabel, node.locator].filter(Boolean).join(' ')));
  for (const term of queryTerms) if (nodeTerms.has(term)) return true;
  return false;
}

function architectureTestLocator(locator) {
  const relative = relativeFromLocator(locator);
  return /(?:^|\/)(?:test|tests|__tests__|spec|fixtures|mocks?)(?:\/|$)/u.test(relative)
    || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(relative);
}

function architectureGenericUtilityName(label) {
  const normalized = String(label ?? '').replace(/^#/u, '').toLowerCase();
  return /^assert(?:[A-Z_$]|$)/u.test(String(label ?? ''))
    || GENERIC_ARCHITECTURE_UTILITY_NAMES.has(normalized)
    || LOW_SIGNAL_REFERENCE_NAMES.has(normalized);
}

function compareArchitectureCandidates(left, right) {
  return Number(left.deprioritized) - Number(right.deprioritized)
    || right.score - left.score
    || graphSearchPathPriority(left.node.locator) - graphSearchPathPriority(right.node.locator)
    || left.node.label.localeCompare(right.node.label)
    || left.node.id.localeCompare(right.node.id);
}

function architectureNodeReference(candidate) {
  return Object.freeze(withDefined({
    nodeId: candidate.node.id,
    label: candidate.node.label,
    qualifiedLabel: safeArchitectureLabel(candidate.node.qualifiedLabel) ? candidate.node.qualifiedLabel : undefined,
    locator: candidate.node.locator,
    symbolKind: candidate.node.symbolKind,
    reasonCodes: candidate.reasonCodes
  }));
}

function architectureHotspot(candidate) {
  return Object.freeze(withDefined({
    nodeId: candidate.node.id,
    label: candidate.node.label,
    qualifiedLabel: safeArchitectureLabel(candidate.node.qualifiedLabel) ? candidate.node.qualifiedLabel : undefined,
    locator: candidate.node.locator,
    symbolKind: candidate.node.symbolKind,
    inbound: candidate.inbound,
    outbound: candidate.outbound,
    total: candidate.total,
    reasonCodes: candidate.reasonCodes
  }));
}

function architectureDeprioritizedDiagnostic(candidate) {
  return Object.freeze(withDefined({
    nodeId: candidate.node.id,
    label: candidate.node.label,
    qualifiedLabel: safeArchitectureLabel(candidate.node.qualifiedLabel) ? candidate.node.qualifiedLabel : undefined,
    locator: candidate.node.locator,
    symbolKind: candidate.node.symbolKind,
    reasonCodes: candidate.penaltyCodes
  }));
}

function safeArchitectureLocator(value) {
  return SOURCE_GRAPH_WORKSPACE_LOCATOR_RE.test(String(value ?? ''));
}

function safeArchitectureLabel(value) {
  return SOURCE_GRAPH_SAFE_LABEL_RE.test(String(value ?? ''));
}

function sourceGraphSummary({ nodes, edges, coverage = undefined }) {
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
  return Object.freeze(withDefined({
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
    entryPoints,
    coverage
  }));
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
