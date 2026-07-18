import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { stableStringify } from '../../protocol/src/index.mjs';
import {
  SOURCE_GRAPH_SAFE_LABEL_RE,
  SOURCE_GRAPH_WORKSPACE_LOCATOR_RE
} from '../../protocol/src/source-graph-locator.mjs';
import { inspectRepositoryIdentity } from '../../harness-context/src/index.mjs';
import {
  DEFAULT_SOURCE_GRAPH_PREVIEW_MAX_FILE_BYTES,
  DEFAULT_SOURCE_GRAPH_PREVIEW_MAX_FILES,
  NATIVE_INDEX_LANGUAGES,
  buildSourceGraphPreview
} from '../../source-graph/src/index.mjs';

const REPORT_VERSION = 'memory-recall-map-1.1.0';
const WORKSPACE_ID = /^[a-z][a-z0-9_-]{0,127}$/u;
const SAFE_REPOSITORY_NAME = /^[A-Za-z0-9._@+~(), -]{1,120}$/u;
const SQLITE_LOCATOR = '.local/memory.sqlite';
const MAX_FACTS = 20;
const MAX_PROPOSALS = 20;
const MAX_LOCATORS = 16;
const MAX_DIAGNOSTICS = 100;
const MAX_ARCHITECTURE_ITEMS = 20;
const MAX_MAP_REQUEST_LIMIT = 50;
const DEFAULT_MAP_DEPTH = 2;
const DEFAULT_MAP_LIMIT = 20;
const MAX_STALE_FACTS = 500;
const MAX_PROPOSAL_ATTEMPTS = 10;
const EDGE_KINDS = new Set(['contains', 'defined_in', 'imports', 'exports', 'references', 'calls']);
const SAFE_LOCATOR = SOURCE_GRAPH_WORKSPACE_LOCATOR_RE;
const SAFE_LABEL = SOURCE_GRAPH_SAFE_LABEL_RE;
const SAFE_GROUP_PREFIX = /^[A-Za-z0-9._~!$&'()*+,;=@%\[\]-]+(?:\/[A-Za-z0-9._~!$&'()*+,;=@%\[\]-]+){0,2}$/u;
const GROUP_ID = /^sggroup_[a-f0-9]{24}$/u;
const RELATION_ID = /^sgrelation_[a-f0-9]{24}$/u;
const NODE_ID = /^sgnode_[a-f0-9]{32}$/u;
const EDGE_ID = /^sgedge_[a-f0-9]{32}$/u;
const PROCESS_ID = /^sgprocess_[a-f0-9]{24}$/u;
const PROCESS_SINK_KIND = /^[a-z][a-z0-9_.-]{0,127}$/u;

function safeRepositoryName(root) {
  const candidate = path.basename(root).slice(0, 120);
  return SAFE_REPOSITORY_NAME.test(candidate) ? candidate : 'Local workspace';
}

function summarizeRepository(workspace, identity) {
  return {
    name: safeRepositoryName(workspace.root),
    branch: identity.branch,
    commitSha: identity.commitSha,
    dirtyCount: identity.dirtyCount,
    gitStatusAvailable: identity.gitStatusAvailable,
    reason: identity.reason
  };
}

export async function buildRecallMap({
  root,
  workspaceId = 'ws_local',
  changedLocators = [],
  query = '',
  depth = DEFAULT_MAP_DEPTH,
  limit = DEFAULT_MAP_LIMIT,
  clock = () => new Date().toISOString(),
  sqliteLocator = SQLITE_LOCATOR,
  sourceGraphSnapshotService = null,
  sourceGraphPreviewBuilder = buildSourceGraphPreview,
  refreshSourceGraph = false
} = {}) {
  const requestedRoot = normalizeRoot(root);
  const workspace = await canonicalizeWorkspaceRoot(requestedRoot);
  const safeWorkspaceId = normalizeWorkspaceId(workspaceId);
  const generatedAt = normalizeTimestamp(clock());
  const repositoryIdentity = workspace.status === 'available'
    ? await inspectRepositoryIdentity({ root: workspace.root, clock: () => generatedAt })
    : {
        branch: null,
        commitSha: null,
        dirtyCount: 0,
        gitStatusAvailable: false,
        reason: 'workspace_unavailable'
      };
  const safeQuery = normalizeQuery(query);
  const safeDepth = normalizeMapBoundedInteger(depth, DEFAULT_MAP_DEPTH, 1, 5, 'recall_map_depth_invalid');
  const requestedLimit = normalizeMapBoundedInteger(limit, DEFAULT_MAP_LIMIT, 1, MAX_MAP_REQUEST_LIMIT, 'recall_map_limit_invalid');
  const safeLimit = Math.min(requestedLimit, MAX_ARCHITECTURE_ITEMS);
  const sqlitePath = resolveSqlitePath(workspace.root, sqliteLocator);
  const preview = await sourceGraphPreviewBuilder({
    root: workspace.status === 'available' ? workspace.root : requestedRoot,
    workspaceId: safeWorkspaceId,
    changedLocators,
    query: safeQuery,
    depth: safeDepth,
    limit: safeLimit,
    snapshotService: sourceGraphSnapshotService,
    refresh: Boolean(refreshSourceGraph),
    clock: () => generatedAt
  });
  const architecture = summarizeArchitecture(preview, { limit: safeLimit });
  const memory = await summarizeMemory({
    workspace,
    sqlitePath,
    workspaceId: safeWorkspaceId,
    generatedAt
  });
  const report = {
    schemaVersion: '1.0.0',
    reportVersion: REPORT_VERSION,
    workspaceId: safeWorkspaceId,
    generatedAt,
    repository: summarizeRepository(workspace, repositoryIdentity),
    support: summarizeSupport(preview, memory),
    architecture,
    memory,
    readiness: {
      handoff: {
        status: 'available',
        command: 'recall handoff'
      },
      mcp: {
        status: 'available',
        command: 'recall mcp inspect --read-only --root .'
      },
      nextCommands: [
        'recall handoff',
        'recall mcp inspect --read-only --root .',
        'recall graph stats --root . --format summary'
      ]
    },
    safeguards: {
      readOnly: true,
      localFilesWritten: 0,
      canonicalStateMutated: false,
      networkCalls: 0,
      modelCalls: 0,
      rawSourceBodiesIncluded: false,
      graphDatabaseUsed: false,
      externalAdaptersEnabled: 0
    }
  };
  return Object.freeze({
    ...report,
    fingerprint: fingerprintReport(report)
  });
}

export async function buildRecallMapMemorySummary({
  root,
  workspaceId = 'ws_local',
  clock = () => new Date().toISOString(),
  sqliteLocator = SQLITE_LOCATOR
} = {}) {
  const workspace = await canonicalizeWorkspaceRoot(normalizeRoot(root));
  const safeWorkspaceId = normalizeWorkspaceId(workspaceId);
  const generatedAt = normalizeTimestamp(clock());
  return summarizeMemory({
    workspace,
    sqlitePath: resolveSqlitePath(workspace.root, sqliteLocator),
    workspaceId: safeWorkspaceId,
    generatedAt
  });
}

function normalizeRoot(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('recall_map_root_required');
  return path.resolve(value);
}

async function canonicalizeWorkspaceRoot(root) {
  const inspected = await inspectPath(root);
  if (inspected.status !== 'available') return { root, status: inspected.status };
  if (!inspected.entry.isDirectory() && !inspected.entry.isSymbolicLink()) return { root, status: 'unavailable' };

  let canonicalRoot;
  try {
    canonicalRoot = await realpath(root);
  } catch (error) {
    return { root, status: inspected.entry.isSymbolicLink() ? 'unavailable' : pathStatus(error) };
  }

  const canonical = await inspectPath(canonicalRoot);
  if (canonical.status !== 'available' || !canonical.entry.isDirectory() || canonical.entry.isSymbolicLink()) {
    return { root, status: 'unavailable' };
  }
  return { root: canonicalRoot, status: 'available' };
}

function normalizeWorkspaceId(value) {
  const normalized = String(value ?? '').trim();
  if (!WORKSPACE_ID.test(normalized)) throw new Error('recall_map_workspace_invalid');
  return normalized;
}

function normalizeTimestamp(value) {
  const parsed = Date.parse(String(value ?? ''));
  if (Number.isNaN(parsed)) throw new Error('recall_map_clock_invalid');
  return new Date(parsed).toISOString();
}

function normalizeQuery(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' || value.length > 512) throw new Error('recall_map_query_invalid');
  return value;
}

function normalizeMapBoundedInteger(value, fallback, minimum, maximum, errorCode) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(errorCode);
  return parsed;
}

function resolveSqlitePath(root, value) {
  const locator = value ?? SQLITE_LOCATOR;
  if (
    typeof locator !== 'string'
    || !locator
    || locator.length > 512
    || locator.includes('\\')
    || locator.includes('\0')
    || /[\s?#]/u.test(locator)
  ) {
    throw new Error('recall_map_sqlite_locator_invalid');
  }
  const normalized = locator.replace(/^\.\//u, '');
  const parts = normalized.split('/');
  if (
    path.posix.isAbsolute(normalized)
    || normalized.startsWith('/')
    || parts.some((part) => !part || part === '.' || part === '..')
    || normalized.startsWith('workspace://')
    || /^[A-Za-z]:/u.test(normalized)
  ) {
    throw new Error('recall_map_sqlite_locator_invalid');
  }
  const filename = path.resolve(root, normalized);
  const relative = path.relative(root, filename);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('recall_map_sqlite_locator_invalid');
  }
  return { parts };
}

async function inspectSqliteStore({ workspace, sqlitePath }) {
  if (workspace.status !== 'available') return { status: workspace.status };

  const root = await inspectPath(workspace.root);
  if (root.status !== 'available') return { status: root.status };
  if (!root.entry.isDirectory() || root.entry.isSymbolicLink()) return { status: 'unavailable' };

  let current = workspace.root;
  for (const [index, part] of sqlitePath.parts.entries()) {
    current = path.join(current, part);
    const inspected = await inspectPath(current);
    if (inspected.status !== 'available') return { status: inspected.status };
    if (inspected.entry.isSymbolicLink()) return { status: 'unavailable' };
    const isFilename = index === sqlitePath.parts.length - 1;
    if ((isFilename && !inspected.entry.isFile()) || (!isFilename && !inspected.entry.isDirectory())) {
      return { status: 'unavailable' };
    }
  }

  let canonicalFilename;
  try {
    canonicalFilename = await realpath(current);
  } catch (error) {
    return { status: pathStatus(error) };
  }
  if (!isInsideRoot(workspace.root, canonicalFilename)) return { status: 'unavailable' };

  const finalEntry = await inspectPath(canonicalFilename);
  if (finalEntry.status !== 'available' || !finalEntry.entry.isFile() || finalEntry.entry.isSymbolicLink()) {
    return { status: finalEntry.status === 'missing' ? 'missing' : 'unavailable' };
  }
  return { status: 'available', filename: canonicalFilename };
}

async function inspectPath(filename) {
  try {
    return { status: 'available', entry: await lstat(filename) };
  } catch (error) {
    return { status: pathStatus(error) };
  }
}

function pathStatus(error) {
  return error?.code === 'ENOENT' ? 'missing' : 'unavailable';
}

function isInsideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function summarizeSupport(preview, memory) {
  const diagnostics = preview.graph?.diagnostics ?? [];
  const unavailable = preview.snapshot?.status === 'unavailable'
    || diagnostics.some((item) => item.code?.startsWith('source_graph_unavailable'));
  const summary = preview.graph?.summary ?? {};
  const native = String(preview.graph?.parserVersion ?? '').startsWith('memory-recall-native-');
  const representedFileCount = boundedInteger(summary.coverage?.representedFileCount ?? summary.fileCount, 0, DEFAULT_SOURCE_GRAPH_PREVIEW_MAX_FILES);
  const omittedFileCount = boundedInteger(summary.coverage?.skippedFileCount, 0, DEFAULT_SOURCE_GRAPH_PREVIEW_MAX_FILES);
  const coverageStatus = unavailable
    ? 'unavailable'
    : preview.snapshot?.status === 'stale'
      ? 'stale'
      : summary.coverage?.status === 'complete' ? 'complete' : 'partial';
  return {
    sourceGraph: {
      status: unavailable ? 'unavailable' : 'implemented',
      languages: native ? NATIVE_INDEX_LANGUAGES : ['javascript', 'typescript'],
      coverage: {
        status: coverageStatus,
        analyzedFileCount: representedFileCount,
        maxFiles: native ? Math.max(1, representedFileCount + omittedFileCount) : DEFAULT_SOURCE_GRAPH_PREVIEW_MAX_FILES,
        maxFileBytes: DEFAULT_SOURCE_GRAPH_PREVIEW_MAX_FILE_BYTES,
        diagnosticCount: boundedInteger(diagnostics.length, 0, 5000),
        reasonCodes: unavailable
          ? ['source_graph_unavailable']
          : native ? ['native_persistent_index', 'bounded_index_read'] : ['static_js_ts_only', 'bounded_file_scan']
      },
      snapshot: summarizeSnapshot(preview.snapshot)
    },
    memory: {
      status: memory.status
    }
  };
}

function summarizeSnapshot(snapshot) {
  return {
    status: ['fresh', 'stale', 'unavailable'].includes(snapshot?.status) ? snapshot.status : 'unavailable',
    reuse: ['cold', 'cache', 'inflight', 'none'].includes(snapshot?.reuse) ? snapshot.reuse : 'none',
    reason: snapshot?.reason ? safeCode(snapshot.reason, 'source_graph_snapshot_unavailable') : null,
    validationMode: ['watcher', 'metadata-scan', 'none'].includes(snapshot?.validationMode) ? snapshot.validationMode : 'none',
    builtAt: snapshot?.builtAt && !Number.isNaN(Date.parse(snapshot.builtAt)) ? normalizeTimestamp(snapshot.builtAt) : null,
    buildDurationMs: Number.isFinite(snapshot?.buildDurationMs) && snapshot.buildDurationMs >= 0
      ? Math.min(snapshot.buildDurationMs, 3_600_000)
      : null
  };
}

function summarizeArchitecture(preview, { limit = DEFAULT_MAP_LIMIT } = {}) {
  const graph = preview.graph ?? {};
  const summary = graph.summary ?? {};
  const impact = preview.impact;
  const unavailable = (graph.diagnostics ?? []).some((item) => item.code?.startsWith('source_graph_unavailable'));
  const safeLimit = boundedInteger(limit, 1, MAX_ARCHITECTURE_ITEMS);
  return {
    entryPoints: (summary.entryPoints ?? []).slice(0, safeLimit).map(summarizeNodeReference),
    hotspots: (summary.hotspots ?? []).slice(0, safeLimit).map(summarizeHotspot),
    groups: (preview.orientation?.groups ?? []).slice(0, 12).map(summarizeOrientationGroup).filter(Boolean),
    groupRelations: (preview.orientation?.relations ?? []).slice(0, 20).map(summarizeOrientationRelation).filter(Boolean),
    processes: (preview.orientation?.processes ?? []).slice(0, 12).map(summarizeOrientationProcess).filter(Boolean),
    search: {
      status: unavailable ? 'unavailable' : 'available',
      queryFingerprint: safeFingerprint(preview.search?.queryFingerprint),
      total: boundedInteger(preview.search?.total),
      hasMore: preview.search?.hasMore === true,
      omittedCount: boundedInteger(preview.search?.omittedCount),
      results: (preview.search?.results ?? []).slice(0, safeLimit).map(summarizeSearchResult)
    },
    impact: {
      changedLocators: safeLocatorList(impact?.changedLocators),
      representedChangedLocators: safeLocatorList(impact?.representedChangedLocators),
      affectedSymbols: (impact?.affectedSymbols ?? []).slice(0, safeLimit).map(summarizeAffectedSymbol),
      affectedEdgeKindCounts: safeCountMap(impact?.impactedEdgeKindCounts),
      depth: boundedInteger(impact?.depth, 0, 5)
    },
    diagnostics: (graph.diagnostics ?? []).slice(0, MAX_DIAGNOSTICS).map(summarizeDiagnostic)
  };
}

function summarizeOrientationGroup(group) {
  if (!GROUP_ID.test(String(group?.id ?? '')) || !SAFE_GROUP_PREFIX.test(String(group?.prefix ?? ''))) return null;
  return {
    id: group.id,
    prefix: group.prefix,
    fileCount: boundedInteger(group.fileCount),
    symbolCount: boundedInteger(group.symbolCount),
    changedFileCount: boundedInteger(group.changedFileCount),
    entryPoints: (group.entryPoints ?? []).slice(0, 2).map((entryPoint) => {
      if (!NODE_ID.test(String(entryPoint?.nodeId ?? ''))) return null;
      return {
        nodeId: entryPoint.nodeId,
        ...summarizeNodeReference(entryPoint)
      };
    }).filter(Boolean)
  };
}

function summarizeOrientationRelation(relation) {
  if (
    !RELATION_ID.test(String(relation?.id ?? ''))
    || !GROUP_ID.test(String(relation?.sourceGroupId ?? ''))
    || !GROUP_ID.test(String(relation?.targetGroupId ?? ''))
    || !SAFE_GROUP_PREFIX.test(String(relation?.sourcePrefix ?? ''))
    || !SAFE_GROUP_PREFIX.test(String(relation?.targetPrefix ?? ''))
  ) return null;
  const edgeKindCounts = Object.fromEntries(
    Object.entries(relation.edgeKindCounts ?? {})
      .filter(([kind]) => ['imports', 'calls'].includes(kind))
      .map(([kind, count]) => [kind, boundedInteger(count)])
  );
  return {
    id: relation.id,
    sourceGroupId: relation.sourceGroupId,
    targetGroupId: relation.targetGroupId,
    sourcePrefix: relation.sourcePrefix,
    targetPrefix: relation.targetPrefix,
    count: boundedInteger(relation.count),
    edgeKindCounts
  };
}

function summarizeOrientationProcess(process) {
  const nodeIds = [...new Set(process?.nodeIds ?? [])].filter((id) => NODE_ID.test(String(id))).slice(0, 5);
  const relationshipIds = [...new Set(process?.relationshipIds ?? [])].filter((id) => EDGE_ID.test(String(id))).slice(0, 5);
  const entryPoint = summarizeProcessNode(process?.entryPoint);
  const sink = summarizeProcessNode(process?.sink);
  if (
    !PROCESS_ID.test(String(process?.id ?? ''))
    || !entryPoint
    || !sink
    || nodeIds.length < 2
    || relationshipIds.length !== nodeIds.length
    || nodeIds[0] !== entryPoint.nodeId
    || nodeIds.at(-1) !== sink.nodeId
    || !PROCESS_SINK_KIND.test(String(process?.sinkKind ?? ''))
    || process?.algorithmVersion !== 'entry-path-v1'
  ) return null;
  return {
    id: process.id,
    label: safeLabel(process.label),
    entryPoint,
    sink,
    sinkKind: process.sinkKind,
    nodeIds,
    relationshipIds,
    confidence: boundedScore(process.confidence),
    algorithmVersion: process.algorithmVersion,
    truncated: process.truncated === true
  };
}

function summarizeProcessNode(node) {
  if (!NODE_ID.test(String(node?.nodeId ?? ''))) return null;
  return {
    nodeId: node.nodeId,
    ...summarizeNodeReference(node)
  };
}

async function summarizeMemory({ workspace, sqlitePath, workspaceId, generatedAt }) {
  const store = await inspectSqliteStore({ workspace, sqlitePath });
  if (store.status !== 'available') {
    return unavailableMemory(
      store.status === 'missing' ? 'missing' : 'unavailable',
      store.status === 'missing' ? 'memory_store_missing' : 'memory_store_unavailable'
    );
  }
  let provider;
  try {
    const { SQLiteMemoryProvider } = await import('../../../providers/native/memory-sqlite/src/index.mjs');
    provider = new SQLiteMemoryProvider({
      filename: store.filename,
      clock: () => generatedAt,
      migrate: false,
      readOnly: true
    });
    const [currentFacts, allFacts, proposals] = await Promise.all([
      provider.getTemporalFacts({ workspaceId, scope: 'workspace', at: generatedAt, limit: MAX_FACTS }),
      provider.listTemporalFacts({ workspaceId, scope: 'workspace', limit: 500 }),
      provider.listProposalQueue({ workspaceId, limit: 500 })
    ]);
    const activeFacts = currentFacts
      .filter((fact) => fact.status === 'active' && !fact.supersededBy)
      .slice(0, MAX_FACTS)
      .map(summarizeActiveFact);
    const pendingProposals = proposals
      .filter((proposal) => proposal.status === 'pending' || proposal.status === 'claimed')
      .slice(0, MAX_PROPOSALS)
      .map(summarizePendingProposal);
    return {
      status: 'available',
      activeFacts,
      pendingProposals,
      staleFactCount: boundedInteger(allFacts.filter((fact) => isStaleFact(fact, generatedAt)).length, 0, MAX_STALE_FACTS),
      unavailableReason: null
    };
  } catch {
    return unavailableMemory('unavailable', 'memory_store_unavailable');
  } finally {
    try {
      provider?.close();
    } catch {
      // A read-only report must remain bounded if provider teardown observes a local I/O failure.
    }
  }
}

function unavailableMemory(status, unavailableReason) {
  return {
    status,
    activeFacts: [],
    pendingProposals: [],
    staleFactCount: 0,
    unavailableReason
  };
}

function isStaleFact(fact, generatedAt) {
  return fact.status !== 'active'
    || Boolean(fact.supersededBy)
    || (fact.validUntil !== null && Date.parse(fact.validUntil) <= Date.parse(generatedAt));
}

function summarizeNodeReference(node) {
  return compactSymbol({
    label: node.label,
    qualifiedLabel: node.qualifiedLabel,
    locator: node.locator,
    symbolKind: node.symbolKind
  });
}

function summarizeHotspot(node) {
  return {
    ...compactSymbol({
      label: node.label,
      qualifiedLabel: node.qualifiedLabel,
      locator: node.locator,
      symbolKind: 'function'
    }),
    inbound: boundedInteger(node.inbound),
    outbound: boundedInteger(node.outbound),
    total: boundedInteger(node.total)
  };
}

function summarizeSearchResult(item) {
  return {
    resultType: item.resultType === 'edge' ? 'edge' : 'node',
    kind: safeCode(item.kind, 'unknown'),
    label: safeLabel(item.label),
    locator: safeNullableLocator(item.locator),
    score: boundedScore(item.score),
    reasonCodes: (item.reasonCodes ?? []).slice(0, 16).map((code) => safeCode(code, 'unknown'))
  };
}

function summarizeAffectedSymbol(item) {
  return {
    label: safeLabel(item.name),
    qualifiedLabel: safeOptionalLabel(item.qualifiedName),
    locator: safeNullableLocator(item.locator),
    symbolKind: safeSymbolKind(item.symbolKind)
  };
}

function summarizeDiagnostic(item) {
  return {
    locator: safeNullableLocator(item.locator),
    code: safeCode(item.code, 'source_graph_unavailable')
  };
}

function summarizeActiveFact(fact) {
  return {
    id: safeFactId(fact.id),
    scope: safeScope(fact.scope),
    status: 'active',
    sourceLocator: safeNullableLocator(fact.source),
    validFrom: normalizeTimestamp(fact.validFrom),
    validUntil: fact.validUntil === null ? null : normalizeTimestamp(fact.validUntil),
    confidence: boundedScore(fact.confidence)
  };
}

function summarizePendingProposal(proposal) {
  return {
    id: safeProposalId(proposal.id),
    status: proposal.status === 'claimed' ? 'claimed' : 'pending',
    sourceLocator: safeNullableLocator(proposal.sourceLocator),
    attempts: boundedInteger(proposal.attempts, 0, MAX_PROPOSAL_ATTEMPTS),
    maxAttempts: boundedInteger(proposal.maxAttempts, 1, MAX_PROPOSAL_ATTEMPTS),
    enqueuedAt: normalizeTimestamp(proposal.enqueuedAt)
  };
}

function compactSymbol({ label, qualifiedLabel, locator, symbolKind }) {
  return {
    label: safeLabel(label),
    qualifiedLabel: safeOptionalLabel(qualifiedLabel),
    locator: safeNullableLocator(locator),
    symbolKind: safeSymbolKind(symbolKind)
  };
}

function safeLocatorList(values) {
  return [...new Set((values ?? []).map(safeNullableLocator).filter(Boolean))].sort().slice(0, MAX_LOCATORS);
}

function safeCountMap(value) {
  const entries = Object.entries(value && typeof value === 'object' ? value : {})
    .filter(([key]) => EDGE_KINDS.has(key))
    .slice(0, 16)
    .map(([key, count]) => [key, boundedInteger(count)]);
  return Object.fromEntries(entries);
}

function safeFingerprint(value) {
  return /^sha256:[a-f0-9]{64}$/u.test(String(value ?? ''))
    ? value
    : `sha256:${'0'.repeat(64)}`;
}

function safeFactId(value) {
  return /^memfact_[A-Za-z0-9._-]{1,128}$/u.test(String(value ?? '')) ? value : 'memfact_unavailable';
}

function safeProposalId(value) {
  return /^mpq_[A-Za-z0-9._-]{1,128}$/u.test(String(value ?? '')) ? value : 'mpq_unavailable';
}

function safeScope(value) {
  return ['workspace', 'session', 'agent', 'user'].includes(value) ? value : 'workspace';
}

function safeSymbolKind(value) {
  return ['class', 'function', 'method', 'interface', 'type'].includes(value) ? value : 'function';
}

function safeNullableLocator(value) {
  const locator = String(value ?? '');
  return locator.length <= 512 && SAFE_LOCATOR.test(locator) ? locator : null;
}

function safeLabel(value) {
  const label = String(value ?? '');
  return label && label.length <= 240 && SAFE_LABEL.test(label) ? label : 'unavailable';
}

function safeOptionalLabel(value) {
  if (value === undefined || value === null || value === '') return null;
  return safeLabel(value);
}

function safeCode(value, fallback) {
  const code = String(value ?? '').toLowerCase();
  return /^[a-z][a-z0-9_]{0,63}$/u.test(code) ? code : fallback;
}

function boundedInteger(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? Math.min(maximum, Math.max(minimum, number)) : minimum;
}

function boundedScore(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function fingerprintReport(report) {
  return `sha256:${createHash('sha256').update(stableStringify(withoutVolatileTimestamps(report))).digest('hex')}`;
}

function withoutVolatileTimestamps(value) {
  if (Array.isArray(value)) return value.map(withoutVolatileTimestamps);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'generatedAt' && key !== 'builtAt' && key !== 'fingerprint')
    .map(([key, child]) => [key, withoutVolatileTimestamps(child)]));
}
