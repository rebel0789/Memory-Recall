import { createHash } from 'node:crypto';

export const PROTOCOL_BRIDGES_VERSION = '0.1.0';
export const MCP_BRIDGE_PROTOCOL_VERSION = '2025-06-18';
export const OAF_READ_ONLY_MCP_RESOURCE_VERSION = '1.0.0';

export class ProtocolBridgeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProtocolBridgeError';
    this.code = code;
    this.details = details;
  }
}

const JSONRPC = '2.0';
const AUTHORITY_KEYS = /(^|\.)(trustedContext|principal|membership|role|owner|isOwner|grant|grantToken|token|authorization|cookie|externalWritesEnabled)($|\.)/i;
const PRIVATE_KEYS = /(^|\.)(raw|prompt|body|output|secret|token|cookie|authorization|localPath|providerUrl|hiddenReasoning|sql)/i;
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_CONTEXT_PACK_ITEMS = 2;
const MAX_CONTEXT_PACK_BULK_ITEMS = 1;

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function scanKeys(value, pattern, prefix = '') {
  if (!isPlainObject(value) && !Array.isArray(value)) return null;
  const entries = Array.isArray(value) ? value.entries() : Object.entries(value);
  for (const [key, child] of entries) {
    const childPath = prefix ? `${prefix}.${key}` : String(key);
    if (pattern.test(childPath)) return childPath;
    const found = scanKeys(child, pattern, childPath);
    if (found) return found;
  }
  return null;
}

function assertNoCallerAuthority(params) {
  const blocked = scanKeys(params, AUTHORITY_KEYS);
  if (blocked) {
    throw new ProtocolBridgeError('mcp_authority_injection', `caller supplied authority field ${blocked}`);
  }
}

function assertSafeResult(value) {
  const blocked = scanKeys(value, PRIVATE_KEYS);
  if (blocked) throw new ProtocolBridgeError('mcp_private_payload', `bridge result included private field ${blocked}`);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_RESULT_BYTES) {
    throw new ProtocolBridgeError('mcp_output_too_large', 'bridge result exceeded output limit');
  }
  return value;
}

function validateTrustedContext(context) {
  if (!isPlainObject(context?.principal) || context.principal.status !== 'active') {
    throw new ProtocolBridgeError('mcp_identity_required', 'active principal is required');
  }
  if (!isPlainObject(context?.membership) || context.membership.status !== 'active' || !context.membership.workspaceId) {
    throw new ProtocolBridgeError('mcp_workspace_membership_required', 'active workspace membership is required');
  }
  return context;
}

function jsonRpcResult(id, result) {
  return { jsonrpc: JSONRPC, id, result };
}

function jsonRpcError(id, code, message, data = {}) {
  return { jsonrpc: JSONRPC, id: id ?? null, error: { code, message, data } };
}

function errorToJsonRpc(id, error) {
  if (error instanceof ProtocolBridgeError) {
    const code = {
      mcp_invalid_request: -32600,
      mcp_method_not_found: -32601,
      mcp_invalid_params: -32602,
      mcp_identity_required: -32001,
      mcp_workspace_membership_required: -32001,
      mcp_disconnected: -32002,
      mcp_grant_denied: -32003,
      mcp_replay_side_effect_denied: -32004,
      mcp_authority_injection: -32005,
      mcp_private_payload: -32006,
      mcp_output_too_large: -32007
    }[error.code] ?? -32000;
    return jsonRpcError(id, code, error.message, { code: error.code, ...error.details });
  }
  return jsonRpcError(id, -32000, 'Internal bridge error', { code: 'mcp_internal_error' });
}

function validateMessage(message) {
  if (!isPlainObject(message) || message.jsonrpc !== JSONRPC || message.method === undefined) {
    throw new ProtocolBridgeError('mcp_invalid_request', 'MCP bridge request must be a JSON-RPC 2.0 object');
  }
  if (!['string', 'number'].includes(typeof message.id)) {
    throw new ProtocolBridgeError('mcp_invalid_request', 'MCP bridge request id is required');
  }
  if (message.params !== undefined && !isPlainObject(message.params)) {
    throw new ProtocolBridgeError('mcp_invalid_params', 'MCP bridge params must be an object');
  }
  return message;
}

function publicTool(tool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: {
      sideEffectClass: tool.sideEffectClass,
      oafOperation: tool.operation
    }
  };
}

function publicResource(resource) {
  return {
    uri: resource.uri,
    name: resource.name,
    description: resource.description,
    mimeType: resource.mimeType ?? 'application/json'
  };
}

function items(value) {
  return Array.isArray(value) ? value : [];
}

function workspaceScopedState(state = {}, workspaceId = 'ws_local') {
  return {
    runs: items(state.runs).filter((item) => item?.workspaceId === workspaceId),
    events: items(state.events).filter((item) => item?.workspaceId === workspaceId),
    memories: items(state.memories).filter((item) => (item?.workspaceId ?? workspaceId) === workspaceId),
    approvals: items(state.approvals).filter((item) => (item?.workspaceId ?? workspaceId) === workspaceId),
    artifacts: items(state.artifacts).filter((item) => (item?.workspaceId ?? workspaceId) === workspaceId)
  };
}

function latestContextManifest(scoped) {
  const eventManifest = [...scoped.events].reverse()
    .find((event) => event?.type === 'context.compiled')?.payload;
  if (eventManifest) return eventManifest.manifest ?? eventManifest;
  const latestRun = scoped.runs.at(-1);
  return latestRun?.contextManifest ?? latestRun?.result?.contextManifest ?? null;
}

function sortedCounts(values) {
  const counts = new Map();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([id, count]) => ({ id, count }));
}

function unsafeLocatorText(value) {
  if (typeof value !== 'string' || !value || value.length > 640) return true;
  if (/\s|\\|%/u.test(value)) return true;
  if (/(\.\.|\/Users(?:\/|$)|\/private(?:\/|$)|\/var\/folders(?:\/|$)|file:\/\/)/iu.test(value)) return true;
  return false;
}

function safeLocalLocator(value, scheme) {
  const prefix = `${scheme}://`;
  if (!value.startsWith(prefix) || unsafeLocatorText(value)) return null;
  const pathWithFragment = value.slice(prefix.length);
  if (!pathWithFragment || pathWithFragment.startsWith('/')) return null;
  const [pathname, fragment = null] = pathWithFragment.split('#', 2);
  if (!pathname || (fragment !== null && !/^L[0-9]+-L[0-9]+$/u.test(fragment))) return null;
  const segments = pathname.split('/');
  if (segments.some((segment) => !segment || ['.', '..', '.git', '.local', 'node_modules', 'Users', 'private'].includes(segment))) return null;
  if (segments.length >= 2 && segments[0] === 'var' && segments[1] === 'folders') return null;
  if (!/^[A-Za-z0-9._~!$&'()*+,;=:@/-]+$/u.test(pathname)) return null;
  return value;
}

function safeLocator(value) {
  if (typeof value !== 'string') return null;
  if (value.startsWith('workspace://')) return safeLocalLocator(value, 'workspace');
  if (value.startsWith('user-selected://')) return safeLocalLocator(value, 'user-selected');
  if (unsafeLocatorText(value)) return null;
  if (/^(artifact|evidence|memory|run|context|omit|oaf):\/\/[A-Za-z0-9._~!$&'()*+,;=:@/-]{1,512}$/u.test(value)) return value;
  if (/^(provider|adapter|workflow|tool|model|policy):[A-Za-z0-9._:/-]+$/.test(value)) return value;
  return null;
}

function safeId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:@/-]{1,160}$/.test(value) ? value : null;
}

function validateWorkspaceId(value) {
  if (typeof value === 'string' && /^ws_[A-Za-z0-9._:-]{1,120}$/.test(value)) return value;
  throw new ProtocolBridgeError('mcp_invalid_params', 'workspaceId must be a safe OAF workspace id');
}

function fingerprintFor(value) {
  return `sha256:${hash(value)}`;
}

function summarizeRun(run) {
  if (!run) return null;
  return {
    id: safeId(run.id) ?? 'run_unknown',
    workflowId: safeId(run.workflowId) ?? null,
    workflowVersion: typeof run.workflowVersion === 'string' ? run.workflowVersion : null,
    status: typeof run.status === 'string' ? run.status : 'unknown',
    residency: typeof run.residency === 'string' ? run.residency : 'local-only',
    createdAt: typeof run.createdAt === 'string' ? run.createdAt : null,
    completedAt: typeof run.completedAt === 'string' ? run.completedAt : null,
    objectiveFingerprint: typeof run.objective === 'string' ? fingerprintFor(run.objective) : null,
    objectiveLength: typeof run.objective === 'string' ? run.objective.length : 0,
    hasVerification: Boolean(run.verification),
    hasResultSummary: Boolean(run.result ?? run.output)
  };
}

function summarizeManifestDecision(item) {
  return {
    id: safeId(item?.id) ?? 'record_unknown',
    kind: typeof item?.kind === 'string' ? item.kind : 'unknown',
    category: typeof item?.category === 'string' ? item.category : null,
    rank: Number.isInteger(item?.order) ? item.order : null,
    score: Number.isFinite(item?.score) ? item.score : null,
    unitEstimate: Number.isFinite(item?.tokens) ? item.tokens : Number.isFinite(item?.estimatedTokens) ? item.estimatedTokens : null,
    reasonCodes: items(item?.reasonCodes).filter((code) => typeof code === 'string').slice(0, 12),
    locator: safeLocator(item?.locator ?? item?.sourceLocator ?? item?.source),
    contentFingerprint: typeof item?.contentHash === 'string' ? item.contentHash : typeof item?.sourceHash === 'string' ? item.sourceHash : null
  };
}

function summarizeContextManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return {
      present: false,
      selectedCount: 0,
      excludedCount: 0,
      reasonCodeCounts: [],
      selected: [],
      excluded: []
    };
  }
  const selected = items(manifest.selected ?? manifest.selectedRecords ?? manifest.selectedDecisions);
  const excluded = items(manifest.excluded ?? manifest.excludedRecords ?? manifest.excludedDecisions);
  const reasonCodeCounts = sortedCounts([
    ...selected.flatMap((item) => items(item?.reasonCodes)),
    ...excluded.flatMap((item) => items(item?.reasonCodes))
  ]);
  return {
    present: true,
    id: safeId(manifest.id ?? manifest.manifestId) ?? null,
    requestId: safeId(manifest.requestId) ?? null,
    compilerVersion: typeof manifest.compilerVersion === 'string' ? manifest.compilerVersion : null,
    createdAt: typeof manifest.createdAt === 'string' ? manifest.createdAt : null,
    fingerprint: typeof manifest.manifestFingerprint === 'string' ? manifest.manifestFingerprint : fingerprintFor({
      id: manifest.id ?? null,
      selected: selected.map((item) => item?.id ?? null),
      excluded: excluded.map((item) => item?.id ?? null),
      budget: manifest.budget ?? null
    }),
    budget: {
      available: Number.isFinite(manifest.budget?.available) ? manifest.budget.available : null,
      used: Number.isFinite(manifest.budget?.used) ? manifest.budget.used : null
    },
    selectedCount: selected.length,
    excludedCount: excluded.length,
    reasonCodeCounts,
    selected: selected.slice(0, 12).map(summarizeManifestDecision),
    excluded: excluded.slice(0, 12).map(summarizeManifestDecision),
    truncated: selected.length > 12 || excluded.length > 12
  };
}

function summarizeMemory(record) {
  return {
    id: safeId(record?.id) ?? 'mem_unknown',
    kind: typeof record?.kind === 'string' ? record.kind : 'unknown',
    status: typeof record?.status === 'string' ? record.status : 'unknown',
    decision: typeof record?.decision === 'string' ? record.decision : null,
    confidence: Number.isFinite(record?.confidence) ? record.confidence : null,
    evidenceIds: items(record?.evidenceIds).filter((id) => typeof id === 'string').slice(0, 12),
    supersedes: typeof record?.supersedes === 'string' ? record.supersedes : null,
    createdAt: typeof record?.createdAt === 'string' ? record.createdAt : null,
    updatedAt: typeof record?.updatedAt === 'string' ? record.updatedAt : null,
    recordFingerprint: fingerprintFor({
      id: record?.id ?? null,
      kind: record?.kind ?? null,
      status: record?.status ?? null,
      decision: record?.decision ?? null,
      evidenceIds: items(record?.evidenceIds)
    })
  };
}

function summarizeApproval(approval) {
  return {
    id: safeId(approval?.id) ?? 'approval_unknown',
    status: typeof approval?.status === 'string' ? approval.status : 'unknown',
    riskClass: typeof approval?.riskClass === 'string' ? approval.riskClass : null,
    operation: typeof approval?.operation === 'string' ? approval.operation : null,
    createdAt: typeof approval?.createdAt === 'string' ? approval.createdAt : null,
    expiresAt: typeof approval?.expiresAt === 'string' ? approval.expiresAt : null
  };
}

function summarizeArtifact(artifact) {
  return {
    id: safeId(artifact?.id) ?? 'artifact_unknown',
    kind: typeof artifact?.kind === 'string' ? artifact.kind : typeof artifact?.type === 'string' ? artifact.type : 'unknown',
    runId: safeId(artifact?.runId) ?? null,
    contentType: typeof artifact?.contentType === 'string' ? artifact.contentType : null,
    fingerprint: typeof artifact?.sha256 === 'string' ? `sha256:${artifact.sha256.replace(/^sha256:/, '')}` : typeof artifact?.hash === 'string' ? artifact.hash : null,
    createdAt: typeof artifact?.createdAt === 'string' ? artifact.createdAt : null
  };
}

function commonSafeguards() {
  return {
    readOnly: true,
    canonicalStateMutated: false,
    externalWritesEnabled: false,
    externalAdaptersEnabled: 0,
    networkCalls: 0,
    modelCalls: 0,
    activeMemoryCreated: 0,
    sourceSnapshotsWritten: 0,
    privateContentIncluded: false,
    instructionTextIncluded: false,
    absoluteFilesystemLocationsIncluded: false,
    remoteEndpointDetailsIncluded: false
  };
}

function createResourcePayload({ resourceKind, workspaceId, generatedAt, data, provenanceSource = 'local-state' }) {
  const payload = {
    schemaVersion: OAF_READ_ONLY_MCP_RESOURCE_VERSION,
    resourceKind,
    workspaceId,
    generatedAt,
    provenance: {
      producer: 'open-agent-fabric.protocol-bridges',
      producerVersion: PROTOCOL_BRIDGES_VERSION,
      source: provenanceSource,
      sourceFingerprint: fingerprintFor(data)
    },
    safeguards: commonSafeguards(),
    data
  };
  const withFingerprint = { ...payload, resourceFingerprint: fingerprintFor(payload) };
  assertSafeResult(withFingerprint);
  return withFingerprint;
}

function safePublicString(value, maxLength = 240) {
  if (typeof value !== 'string' || !value) return null;
  if (unsafeLocatorText(value) && !/^[A-Za-z0-9._:@/-]+$/u.test(value)) return null;
  return value.slice(0, maxLength);
}

function safeStringList(values, limit = 12) {
  return items(values)
    .map((value) => safePublicString(value, 128))
    .filter(Boolean)
    .slice(0, limit);
}

function summarizeContextPackDecision(item) {
  return {
    id: safeId(item?.id) ?? 'ctx_item_unknown',
    locator: safeLocator(item?.locator),
    harness: safePublicString(item?.harness, 64),
    sourceKind: safePublicString(item?.sourceKind, 64),
    unitEstimate: Number.isFinite(item?.tokens) ? item.tokens : 0,
    contentHash: typeof item?.contentHash === 'string' ? item.contentHash : null,
    reasonCodes: safeStringList(item?.reasonCodes)
  };
}

function summarizeContextPackOmission(item) {
  return {
    id: safeId(item?.id) ?? 'omit_unknown',
    locator: safeLocator(item?.locator),
    harness: safePublicString(item?.harness, 64),
    sourceKind: safePublicString(item?.sourceKind, 64),
    unitEstimate: Number.isFinite(item?.tokens) ? item.tokens : 0,
    contentHash: typeof item?.contentHash === 'string' ? item.contentHash : null,
    reasonCodes: safeStringList(item?.reasonCodes)
  };
}

function summarizeContextPackSourceGraph(sourceGraph = {}) {
  return {
    status: safePublicString(sourceGraph.status, 64) ?? 'unavailable',
    sourceIndexFingerprint: typeof sourceGraph.sourceIndexFingerprint === 'string' ? sourceGraph.sourceIndexFingerprint : null,
    graphFingerprint: typeof sourceGraph.graphFingerprint === 'string' ? sourceGraph.graphFingerprint : null,
    queryFingerprint: typeof sourceGraph.queryFingerprint === 'string' ? sourceGraph.queryFingerprint : null,
    summary: sourceGraph.summary ? {
      fileCount: Number.isInteger(sourceGraph.summary.fileCount) ? sourceGraph.summary.fileCount : 0,
      symbolCount: Number.isInteger(sourceGraph.summary.symbolCount) ? sourceGraph.summary.symbolCount : 0,
      nodeCount: Number.isInteger(sourceGraph.summary.nodeCount) ? sourceGraph.summary.nodeCount : 0,
      edgeCount: Number.isInteger(sourceGraph.summary.edgeCount) ? sourceGraph.summary.edgeCount : 0
    } : null,
    resultCount: Number.isInteger(sourceGraph.resultCount) ? sourceGraph.resultCount : 0,
    omittedCount: Number.isInteger(sourceGraph.omittedCount) ? sourceGraph.omittedCount : 0,
    results: items(sourceGraph.results).slice(0, MAX_CONTEXT_PACK_BULK_ITEMS).map((item) => ({
      resultType: safePublicString(item?.resultType, 64),
      kind: safePublicString(item?.kind, 64),
      label: safePublicString(item?.label, 160),
      locator: safeLocator(item?.locator),
      score: Number.isFinite(item?.score) ? item.score : 0,
      reasonCodes: safeStringList(item?.reasonCodes)
    })),
    impact: {
      changedLocators: items(sourceGraph.impact?.changedLocators).map(safeLocator).filter(Boolean).slice(0, 16),
      representedChangedLocators: items(sourceGraph.impact?.representedChangedLocators).map(safeLocator).filter(Boolean).slice(0, 16),
      affectedSymbolCount: Number.isInteger(sourceGraph.impact?.affectedSymbolCount) ? sourceGraph.impact.affectedSymbolCount : 0,
      omittedAffectedSymbolCount: Number.isInteger(sourceGraph.impact?.omittedAffectedSymbolCount) ? sourceGraph.impact.omittedAffectedSymbolCount : 0,
      affectedSymbols: items(sourceGraph.impact?.affectedSymbols).slice(0, MAX_CONTEXT_PACK_BULK_ITEMS).map((item) => ({
        name: safePublicString(item?.name, 160),
        symbolKind: safePublicString(item?.symbolKind, 64),
        locator: safeLocator(item?.locator),
        depth: Number.isInteger(item?.depth) ? item.depth : 0,
        reasonCodes: safeStringList(item?.reasonCodes)
      }))
    },
    warnings: safeStringList(sourceGraph.warnings),
    safeguards: {
      dryRun: sourceGraph.safeguards?.dryRun === true,
      persisted: false,
      canonicalStateMutated: false,
      localFilesWritten: 0,
      modelCalls: 0,
      networkCalls: 0,
      externalAdaptersEnabled: 0,
      externalWritesEnabled: false,
      graphDatabaseUsed: false,
      privateBodiesIncluded: false,
      sourceSlicesRead: false
    }
  };
}

function summarizeContextPackDelivery(delivery = {}) {
  return {
    representation: 'locator-handoff',
    sourceCandidateTokenCount: Number.isInteger(delivery.sourceCandidateTokenCount) ? delivery.sourceCandidateTokenCount : 0,
    sourceSelectedTokenCount: Number.isInteger(delivery.sourceSelectedTokenCount) ? delivery.sourceSelectedTokenCount : 0,
    sourceSelectedTokenRatio: Number.isFinite(delivery.sourceSelectedTokenRatio) ? delivery.sourceSelectedTokenRatio : 0,
    deliveredTokenCount: Number.isInteger(delivery.deliveredTokenCount) ? delivery.deliveredTokenCount : 0,
    deliveredByteSize: Number.isInteger(delivery.deliveredByteSize) ? delivery.deliveredByteSize : 0,
    deliveredTokenRatio: Number.isFinite(delivery.deliveredTokenRatio) ? delivery.deliveredTokenRatio : 0,
    observedTokenReductionRatio: Number.isFinite(delivery.observedTokenReductionRatio) ? delivery.observedTokenReductionRatio : 0,
    sourceContentTokenCountIncluded: 0,
    sourceContentsIncluded: false
  };
}

function summarizeCoverageRatio(coverage = {}) {
  return {
    total: Number.isFinite(coverage.total) ? coverage.total : 0,
    covered: Number.isFinite(coverage.covered) ? coverage.covered : 0,
    ratio: Number.isFinite(coverage.ratio) ? coverage.ratio : 0,
    status: ['covered', 'partial', 'not_applicable'].includes(coverage.status) ? coverage.status : 'not_applicable'
  };
}

function summarizeContextPackUtility(utility = {}) {
  return {
    status: utility.status === 'ready' ? 'ready' : 'review',
    requiredLocalReadCount: items(utility.requiredLocalReads).length,
    changedLocatorCoverage: summarizeCoverageRatio(utility.changedLocatorCoverage),
    sourceSelection: {
      selectedUnitRatio: Number.isFinite(utility.sourceSelection?.selectedTokenRatio) ? utility.sourceSelection.selectedTokenRatio : 0,
      estimatedReductionRatio: Number.isFinite(utility.sourceSelection?.estimatedReductionRatio) ? utility.sourceSelection.estimatedReductionRatio : 0
    }
  };
}

function summarizeContextPackRequestedInputs(requestedInputs = {}) {
  const userSelectedLocators = safeStringList(requestedInputs.userSelectedLocators, 16)
    .map((locator) => safeLocator(locator))
    .filter(Boolean);
  const changedLocators = safeStringList(requestedInputs.changedLocators, 16)
    .map((locator) => safeLocator(locator))
    .filter(Boolean);
  return {
    userSelectedLocators,
    changedLocators,
    userSelectedCount: Number.isInteger(requestedInputs.userSelectedCount) ? requestedInputs.userSelectedCount : userSelectedLocators.length,
    changedLocatorCount: Number.isInteger(requestedInputs.changedLocatorCount) ? requestedInputs.changedLocatorCount : changedLocators.length
  };
}

function summarizeContextPack(currentContextPack) {
  const pack = currentContextPack?.pack ?? currentContextPack;
  if (!isPlainObject(pack)) return null;
  const markdown = typeof currentContextPack?.markdown === 'string' ? currentContextPack.markdown : null;
  const readFirst = items(pack.readFirst).slice(0, MAX_CONTEXT_PACK_ITEMS).map(summarizeContextPackDecision);
  const excluded = items(pack.excluded).slice(0, MAX_CONTEXT_PACK_BULK_ITEMS).map(summarizeContextPackDecision);
  const omissionRefs = items(pack.omissions?.refs).slice(0, MAX_CONTEXT_PACK_BULK_ITEMS).map(summarizeContextPackOmission);
  return {
    id: safeId(pack.id) ?? 'ctxpack_unknown',
    packVersion: safePublicString(pack.packVersion, 64),
    targetHarness: safePublicString(pack.targetHarness, 64),
    sourceHarnesses: safeStringList(pack.sourceHarnesses, 3),
    requestedInputs: summarizeContextPackRequestedInputs(pack.requestedInputs),
    dryRun: pack.dryRun === true,
    createdAt: typeof pack.createdAt === 'string' ? pack.createdAt : null,
    objectiveFingerprint: typeof pack.objective === 'string' ? fingerprintFor(pack.objective) : null,
    objectiveLength: typeof pack.objective === 'string' ? pack.objective.length : 0,
    stepFingerprint: typeof pack.step === 'string' ? fingerprintFor(pack.step) : null,
    stepLength: typeof pack.step === 'string' ? pack.step.length : 0,
    scannerVersion: safePublicString(pack.scannerVersion, 80),
    compilerVersion: safePublicString(pack.compilerVersion, 80),
    contextPackFingerprint: typeof pack.contextPackFingerprint === 'string' ? pack.contextPackFingerprint : null,
    preview: {
      id: safeId(pack.preview?.id) ?? null,
      previewFingerprint: typeof pack.preview?.previewFingerprint === 'string' ? pack.preview.previewFingerprint : null,
      requestId: safeId(pack.preview?.requestId) ?? null,
      selectionPolicyFingerprint: typeof pack.preview?.selectionPolicyFingerprint === 'string' ? pack.preview.selectionPolicyFingerprint : null,
      resultFingerprint: typeof pack.preview?.resultFingerprint === 'string' ? pack.preview.resultFingerprint : null,
      budget: {
        available: Number.isFinite(pack.preview?.budget?.available) ? pack.preview.budget.available : null,
        used: Number.isFinite(pack.preview?.budget?.used) ? pack.preview.budget.used : null
      },
      selectedCount: Number.isInteger(pack.preview?.selectedCount) ? pack.preview.selectedCount : items(pack.readFirst).length,
      excludedCount: Number.isInteger(pack.preview?.excludedCount) ? pack.preview.excludedCount : items(pack.excluded).length,
      candidateUnitCount: Number.isFinite(pack.preview?.candidateTokenCount) ? pack.preview.candidateTokenCount : null,
      selectedUnitCount: Number.isFinite(pack.preview?.selectedTokenCount) ? pack.preview.selectedTokenCount : null,
      selectedUnitRatio: Number.isFinite(pack.preview?.selectedTokenRatio) ? pack.preview.selectedTokenRatio : null
    },
    delivery: summarizeContextPackDelivery(pack.delivery),
    readFirst,
    excluded,
    omissions: {
      excludedCount: Number.isInteger(pack.omissions?.excludedCount) ? pack.omissions.excludedCount : 0,
      excludedUnitCount: Number.isInteger(pack.omissions?.excludedTokenCount) ? pack.omissions.excludedTokenCount : 0,
      sourceGraphOmittedCount: Number.isInteger(pack.omissions?.sourceGraphOmittedCount) ? pack.omissions.sourceGraphOmittedCount : 0,
      refs: omissionRefs
    },
    memoryPlan: {
      activeMemoryCreated: Number.isInteger(pack.memoryPlan?.activeMemoryCreated) ? pack.memoryPlan.activeMemoryCreated : 0,
      proposedCount: items(pack.memoryPlan?.items).filter((item) => item?.action === 'would_propose').length,
      quarantinedCount: items(pack.memoryPlan?.items).filter((item) => item?.action === 'would_quarantine').length,
      items: items(pack.memoryPlan?.items).slice(0, MAX_CONTEXT_PACK_BULK_ITEMS).map((item) => ({
        sourceId: safeId(item?.sourceId) ?? 'source_unknown',
        locator: safeLocator(item?.locator),
        harness: safePublicString(item?.harness, 64),
        sourceKind: safePublicString(item?.sourceKind, 64),
        action: safePublicString(item?.action, 64),
        reasonCodes: safeStringList(item?.reasonCodes)
      }))
    },
    sourceGraph: summarizeContextPackSourceGraph(pack.sourceGraph),
    utility: summarizeContextPackUtility(pack.utility),
    warnings: safeStringList(pack.warnings, 24),
    files: items(pack.files).slice(0, 4).map((file) => ({
      path: safeLocator(`workspace://${file?.path ?? ''}`),
      role: safePublicString(file?.role, 80),
      contentType: safePublicString(file?.contentType, 80),
      contentHash: typeof file?.contentHash === 'string' ? file.contentHash : null,
      byteSize: Number.isInteger(file?.byteSize) ? file.byteSize : 0
    })),
    markdownArtifact: markdown ? {
      included: false,
      contentHash: fingerprintFor(markdown),
      byteSize: Buffer.byteLength(markdown, 'utf8')
    } : null,
    safeguards: {
      readOnly: true,
      canonicalStateMutated: false,
      externalWritesEnabled: false,
      externalAdaptersEnabled: 0,
      networkCalls: 0,
      modelCalls: 0,
      activeMemoryCreated: 0,
      sourceSnapshotsWritten: 0,
      contextPackWritten: false,
      sourceGraphPreviewed: pack.safeguards?.sourceGraphPreviewed === true,
      graphDatabaseUsed: false,
      sourceSlicesRead: false,
      privateBodiesIncluded: false
    },
    truncated: {
      readFirst: items(pack.readFirst).length > MAX_CONTEXT_PACK_ITEMS,
      excluded: items(pack.excluded).length > MAX_CONTEXT_PACK_ITEMS,
      omissions: items(pack.omissions?.refs).length > MAX_CONTEXT_PACK_ITEMS,
      sourceGraphResults: items(pack.sourceGraph?.results).length > MAX_CONTEXT_PACK_ITEMS,
      affectedSymbols: items(pack.sourceGraph?.impact?.affectedSymbols).length > MAX_CONTEXT_PACK_ITEMS,
      utilityReads: items(pack.utility?.requiredLocalReads).length > MAX_CONTEXT_PACK_ITEMS
    }
  };
}

function jsonResource(uri, name, description, readPayload) {
  return {
    uri,
    name,
    description,
    mimeType: 'application/json',
    read: async () => {
      const payload = readPayload();
      return [{ uri, mimeType: 'application/json', text: JSON.stringify(payload) }];
    }
  };
}

export function buildOafReadOnlyResourceCatalog({
  state = {},
  projectStatus = {},
  currentContextPack = null,
  currentContextPackUsePlan = null,
  workspaceId = 'ws_local',
  generatedAt = new Date().toISOString()
} = {}) {
  const safeWorkspaceId = validateWorkspaceId(workspaceId);
  const scoped = workspaceScopedState(state, safeWorkspaceId);
  const base = `oaf://workspace/${safeWorkspaceId}`;
  const contextPackSummary = summarizeContextPack(currentContextPack);
  const buildData = () => {
    const latestRun = scoped.runs.at(-1) ?? null;
    const manifest = latestContextManifest(scoped);
    const statuses = sortedCounts(scoped.runs.map((run) => run?.status));
    const recentEvents = scoped.events.slice(-30).map((event) => ({
      id: safeId(event?.id) ?? null,
      runId: safeId(event?.runId) ?? null,
      sequence: Number.isInteger(event?.sequence) ? event.sequence : null,
      type: typeof event?.type === 'string' ? event.type : 'unknown',
      occurredAt: typeof event?.occurredAt === 'string' ? event.occurredAt : null
    }));
    return {
      latestRun,
      manifest,
      statuses,
      recentEvents,
      proposedMemories: scoped.memories.filter((memory) => ['proposed', 'quarantined', 'pending'].includes(memory?.status)),
      acceptedMemories: scoped.memories.filter((memory) => ['active', 'verified'].includes(memory?.status)),
      pendingApprovals: scoped.approvals.filter((approval) => approval?.status === 'pending'),
      artifacts: scoped.artifacts
    };
  };

  const resources = [
    jsonResource(`${base}/status`, 'OAF workspace status', 'Sanitized local OAF workspace status and default safety posture.', () => {
      const data = buildData();
      return createResourcePayload({
        resourceKind: 'status-summary',
        workspaceId: safeWorkspaceId,
        generatedAt,
        data: {
          release: projectStatus?.release ?? null,
          phase: projectStatus?.phase ?? null,
          nextTask: projectStatus?.nextTask ?? null,
          defaults: {
            network: projectStatus?.defaults?.network ?? 'deny',
            externalWrites: projectStatus?.defaults?.externalWrites === true,
            modelMode: projectStatus?.defaults?.modelMode ?? 'deterministic',
            dataResidency: projectStatus?.defaults?.dataResidency ?? 'local-only',
            adapters: projectStatus?.defaults?.adapters ?? 'disabled'
          },
          counts: {
            runs: scoped.runs.length,
            completedRuns: scoped.runs.filter((run) => run?.status === 'completed').length,
            events: scoped.events.length,
            memoryRecords: scoped.memories.length,
            proposedMemories: data.proposedMemories.length,
            acceptedMemories: data.acceptedMemories.length,
            pendingApprovals: data.pendingApprovals.length,
            artifacts: scoped.artifacts.length
          },
          runStatusCounts: data.statuses,
          latestRun: summarizeRun(data.latestRun),
          latestContextManifest: summarizeContextManifest(data.manifest)
        }
      });
    }),
    jsonResource(`${base}/context/latest`, 'Latest context manifest summary', 'Sanitized selected and excluded context manifest summary.', () => {
      const data = buildData();
      return createResourcePayload({
        resourceKind: 'context-manifest-summary',
        workspaceId: safeWorkspaceId,
        generatedAt,
        data: {
          latestRun: summarizeRun(data.latestRun),
          contextManifest: summarizeContextManifest(data.manifest)
        }
      });
    }),
    jsonResource(`${base}/runs/latest`, 'Latest run summary', 'Sanitized latest run and recent event timeline without event bodies.', () => {
      const data = buildData();
      return createResourcePayload({
        resourceKind: 'run-summary',
        workspaceId: safeWorkspaceId,
        generatedAt,
        data: {
          latestRun: summarizeRun(data.latestRun),
          recentRuns: scoped.runs.slice(-8).reverse().map(summarizeRun),
          recentEvents: data.recentEvents,
          eventTypeCounts: sortedCounts(scoped.events.map((event) => event?.type))
        }
      });
    }),
    jsonResource(`${base}/memory/proposals`, 'Memory proposal summary', 'Proposal-only memory queue summary without memory text.', () => {
      const data = buildData();
      return createResourcePayload({
        resourceKind: 'memory-proposal-summary',
        workspaceId: safeWorkspaceId,
        generatedAt,
        data: {
          proposedCount: data.proposedMemories.length,
          acceptedCount: data.acceptedMemories.length,
          proposed: data.proposedMemories.slice(-20).reverse().map(summarizeMemory),
          acceptedSummary: data.acceptedMemories.slice(-20).reverse().map(summarizeMemory)
        }
      });
    }),
    jsonResource(`${base}/handoff/latest`, 'Handoff bundle summary', 'Sanitized handoff and artifact summary for local agent review.', () => {
      const data = buildData();
      return createResourcePayload({
        resourceKind: 'handoff-bundle-summary',
        workspaceId: safeWorkspaceId,
        generatedAt,
        data: {
          latestRun: summarizeRun(data.latestRun),
          latestContextManifest: summarizeContextManifest(data.manifest),
          pendingApprovals: data.pendingApprovals.slice(-20).reverse().map(summarizeApproval),
          artifacts: data.artifacts.slice(-20).reverse().map(summarizeArtifact)
        }
      });
    })
  ];
  if (contextPackSummary) {
    resources.push(jsonResource(`${base}/context-pack/current`, 'Current context pack summary', 'Sanitized current context-pack handoff summary for local agent review.', () => createResourcePayload({
      resourceKind: 'context-pack-summary',
      workspaceId: safeWorkspaceId,
      generatedAt,
      provenanceSource: 'local-context-pack',
      data: contextPackSummary
    })));
  }
  if (isPlainObject(currentContextPackUsePlan)) {
    resources.push(jsonResource(`${base}/context-pack/use-plan/current`, 'Current context pack use plan', 'Sanitized complete local read plan for an explicitly exported context pack.', () => createResourcePayload({
      resourceKind: 'context-pack-use-plan',
      workspaceId: safeWorkspaceId,
      generatedAt,
      provenanceSource: 'local-context-pack-use-plan',
      data: currentContextPackUsePlan
    })));
  }
  return resources;
}

export async function buildContextPackReadbackProof({
  currentContextPack,
  workspaceId = 'ws_local',
  targetHarness = null,
  trustedContext,
  generatedAt = new Date().toISOString(),
  clock = () => generatedAt
} = {}) {
  const safeWorkspaceId = validateWorkspaceId(workspaceId);
  const resourceUri = `oaf://workspace/${safeWorkspaceId}/context-pack/current`;
  const resources = buildOafReadOnlyResourceCatalog({
    state: {},
    projectStatus: {},
    currentContextPack,
    workspaceId: safeWorkspaceId,
    generatedAt
  });
  const bridge = createMcpBridge({ trustedContext, resources, tools: [], clock });
  const messages = [
    { jsonrpc: JSONRPC, id: 1, method: 'initialize' },
    { jsonrpc: JSONRPC, id: 2, method: 'resources/list' },
    { jsonrpc: JSONRPC, id: 3, method: 'tools/list' },
    { jsonrpc: JSONRPC, id: 4, method: 'resources/read', params: { uri: resourceUri } }
  ];
  const started = globalThis.performance?.now?.() ?? Date.now();
  const responses = [];
  for (const message of messages) responses.push(await bridge.handle(message));
  const durationMs = Math.max(0, Math.round((globalThis.performance?.now?.() ?? Date.now()) - started));
  const errors = responses.filter((response) => response.error);
  if (errors.length) {
    const code = errors[0].error?.data?.code ?? 'mcp_readback_failed';
    throw new ProtocolBridgeError('mcp_readback_failed', `context-pack readback failed: ${code}`);
  }
  const listed = responses.find((response) => response.id === 2)?.result?.resources ?? [];
  const tools = responses.find((response) => response.id === 3)?.result?.tools ?? [];
  const read = responses.find((response) => response.id === 4)?.result?.contents?.[0];
  if (!read?.text) throw new ProtocolBridgeError('mcp_readback_failed', 'context-pack readback returned no resource body');
  const payload = JSON.parse(read.text);
  const pack = currentContextPack?.pack ?? currentContextPack;
  const candidateUnitCount = Number(payload.data?.preview?.candidateUnitCount ?? 0);
  const selectedUnitCount = Number(payload.data?.preview?.selectedUnitCount ?? 0);
  const selectedUnitRatio = Number(payload.data?.preview?.selectedUnitRatio ?? 0);
  const observedReductionRatio = candidateUnitCount > 0 ? Number(Math.max(0, 1 - selectedUnitCount / candidateUnitCount).toFixed(6)) : 0;
  const deliveredUnitCount = Number(payload.data?.delivery?.deliveredTokenCount ?? 0);
  const deliveredUnitRatio = Number(payload.data?.delivery?.deliveredTokenRatio ?? 0);
  const observedDeliveryReductionRatio = Number(payload.data?.delivery?.observedTokenReductionRatio ?? 0);
  const contextPackFingerprint = payload.data?.contextPackFingerprint ?? null;
  const expectedFingerprint = typeof pack?.contextPackFingerprint === 'string' ? pack.contextPackFingerprint : null;
  const report = {
    schemaVersion: '1.0.0',
    command: 'mcp readback context-pack',
    generatedAt,
    workspaceId: safeWorkspaceId,
    transport: 'in-process',
    resourceUri,
    targetHarness: targetHarness ?? pack?.targetHarness ?? 'generic',
    measurementScope: 'single local in-process bridge read',
    bridge: {
      invocation: 'createMcpBridge read-only context-pack resource',
      jsonRpcMessageCount: messages.length,
      responseCount: responses.length,
      resourcesListed: listed.length,
      toolsExposed: tools.length
    },
    resource: {
      resourceKind: payload.resourceKind,
      resourceFingerprint: payload.resourceFingerprint,
      contextPackFingerprint,
      markdownArtifactHash: payload.data?.markdownArtifact?.contentHash ?? null,
      readFirstCount: Number(payload.data?.preview?.selectedCount ?? 0),
      omittedRefCount: Number(payload.data?.omissions?.excludedCount ?? 0),
      changedLocatorCount: Number(payload.data?.sourceGraph?.impact?.changedLocators?.length ?? 0),
      affectedSymbolCount: Number(payload.data?.sourceGraph?.impact?.affectedSymbolCount ?? 0),
      readFirstLocators: items(payload.data?.readFirst).map((item) => item.locator).filter(Boolean).slice(0, 8),
      changedLocators: items(payload.data?.sourceGraph?.impact?.changedLocators).slice(0, 16)
    },
    measurements: {
      durationMs,
      resourceByteSize: Buffer.byteLength(read.text, 'utf8'),
      candidateUnitCount,
      selectedUnitCount,
      selectedUnitRatio,
      observedReductionRatio,
      deliveredUnitCount,
      deliveredUnitRatio,
      observedDeliveryReductionRatio
    },
    checks: {
      initialized: responses[0]?.result?.protocolVersion === MCP_BRIDGE_PROTOCOL_VERSION,
      resourceListed: listed.some((resource) => resource.uri === resourceUri),
      resourceRead: payload.resourceKind === 'context-pack-summary',
      noToolsExposed: tools.length === 0,
      noMarkdownBody: payload.data?.markdownArtifact?.included === false,
      contextPackFingerprintMatches: Boolean(expectedFingerprint && contextPackFingerprint === expectedFingerprint)
    },
    safeguards: {
      readOnly: true,
      canonicalStateMutated: false,
      localFilesWritten: 0,
      externalWritesEnabled: false,
      externalAdaptersEnabled: 0,
      networkCalls: 0,
      modelCalls: 0,
      activeMemoryCreated: 0,
      sourceSnapshotsWritten: 0,
      privateBodiesIncluded: false,
      objectiveTextIncluded: false,
      stepTextIncluded: false,
      markdownBodyIncluded: false,
      absoluteFilesystemLocationsIncluded: false
    },
    reportFingerprint: 'sha256:0000000000000000000000000000000000000000000000000000000000000000'
  };
  if (!Object.values(report.checks).every(Boolean)) {
    throw new ProtocolBridgeError('mcp_readback_failed', 'context-pack readback checks failed');
  }
  report.reportFingerprint = fingerprintFor({ ...report, reportFingerprint: null });
  assertSafeResult(report);
  return report;
}

export function createMcpBridge({
  name = 'open-agent-fabric',
  version = PROTOCOL_BRIDGES_VERSION,
  trustedContext = null,
  replayMode = false,
  tools = [],
  resources = [],
  eventSink = async () => {},
  clock = () => new Date().toISOString()
} = {}) {
  const state = {
    initialized: false,
    disconnected: false,
    active: new Set(),
    grants: new Map()
  };

  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const resourcesByUri = new Map(resources.map((resource) => [resource.uri, resource]));

  async function emit(event) {
    await eventSink({
      schemaVersion: '1.0.0',
      bridge: 'mcp',
      bridgeVersion: version,
      replayMode,
      occurredAt: clock(),
      ...event
    });
  }

  function requireConnected() {
    if (state.disconnected) throw new ProtocolBridgeError('mcp_disconnected', 'MCP bridge connection is disconnected');
  }

  function requireIdentity() {
    return validateTrustedContext(trustedContext);
  }

  function registerGrant(grant) {
    if (!isPlainObject(grant) || grant.decision !== 'allow' || !grant.grantId) {
      throw new ProtocolBridgeError('mcp_grant_denied', 'grant must be an allow decision with an id');
    }
    if (grant.rawToken || grant.token || grant.grantToken) {
      throw new ProtocolBridgeError('mcp_grant_denied', 'raw grant token is not accepted by the bridge');
    }
    state.grants.set(grant.grantId, { ...grant, consumed: false });
    return { grantId: grant.grantId, fingerprint: hash({ ...grant, consumed: undefined }) };
  }

  function consumeGrant({ grantId, tool, context }) {
    const grant = state.grants.get(grantId);
    if (!grant || grant.consumed) throw new ProtocolBridgeError('mcp_grant_denied', 'grant is missing or already consumed');
    if (grant.expiresAt && grant.expiresAt <= clock()) throw new ProtocolBridgeError('mcp_grant_denied', 'grant is expired');
    if (grant.workspaceId !== context.membership.workspaceId) throw new ProtocolBridgeError('mcp_grant_denied', 'grant workspace mismatch');
    if (grant.toolName !== tool.name || grant.operation !== tool.operation) throw new ProtocolBridgeError('mcp_grant_denied', 'grant operation mismatch');
    if (grant.sideEffectClass !== tool.sideEffectClass) throw new ProtocolBridgeError('mcp_grant_denied', 'grant side-effect mismatch');
    grant.consumed = true;
    return grant;
  }

  async function handleToolCall(message, params) {
    const context = requireIdentity();
    const tool = toolsByName.get(params.name);
    if (!tool) throw new ProtocolBridgeError('mcp_method_not_found', `unknown MCP tool ${params.name}`);
    if (replayMode && tool.sideEffectClass !== 'read-only') {
      throw new ProtocolBridgeError('mcp_replay_side_effect_denied', 'replay mode permits read-only MCP tools only');
    }
    const args = params.arguments ?? {};
    if (!isPlainObject(args)) throw new ProtocolBridgeError('mcp_invalid_params', 'tool arguments must be an object');
    assertNoCallerAuthority(args);
    const grant = consumeGrant({ grantId: params.grantId, tool, context });
    const controller = new AbortController();
    state.active.add(controller);
    try {
      const output = await tool.handler({
        arguments: args,
        trustedContext: context,
        grant: { grantId: grant.grantId, operation: grant.operation },
        replayMode,
        signal: controller.signal
      });
      requireConnected();
      const result = assertSafeResult({
        content: output.content ?? [{ type: 'json', json: output }],
        isError: false,
        _meta: {
          oaf: {
            toolName: tool.name,
            operation: tool.operation,
            sideEffectClass: tool.sideEffectClass,
            grantId: grant.grantId
          }
        }
      });
      await emit({ type: 'mcp.tool.completed', method: message.method, toolName: tool.name, grantId: grant.grantId, inputFingerprint: hash(args) });
      return result;
    } finally {
      state.active.delete(controller);
    }
  }

  async function handle(message) {
    let requestId = null;
    try {
      validateMessage(message);
      requestId = message.id;
      requireConnected();
      const params = message.params ?? {};
      assertNoCallerAuthority(params);
      if (message.method === 'initialize') {
        state.initialized = true;
        return jsonRpcResult(message.id, {
          protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
          serverInfo: { name, version },
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false }
          }
        });
      }
      if (message.method === 'ping') return jsonRpcResult(message.id, {});
      if (message.method === 'tools/list') {
        requireIdentity();
        return jsonRpcResult(message.id, { tools: [...toolsByName.values()].map(publicTool) });
      }
      if (message.method === 'resources/list') {
        requireIdentity();
        return jsonRpcResult(message.id, { resources: [...resourcesByUri.values()].map(publicResource) });
      }
      if (message.method === 'resources/read') {
        requireIdentity();
        const resource = resourcesByUri.get(params.uri);
        if (!resource) throw new ProtocolBridgeError('mcp_method_not_found', `unknown MCP resource ${params.uri}`);
        const contents = await resource.read({ trustedContext, replayMode });
        return jsonRpcResult(message.id, assertSafeResult({ contents }));
      }
      if (message.method === 'tools/call') return jsonRpcResult(message.id, await handleToolCall(message, params));
      throw new ProtocolBridgeError('mcp_method_not_found', `unsupported MCP method ${message.method}`);
    } catch (error) {
      if (state.disconnected && !(error instanceof ProtocolBridgeError)) {
        error = new ProtocolBridgeError('mcp_disconnected', 'MCP bridge connection disconnected during request');
      }
      await emit({ type: 'mcp.request.failed', method: message?.method ?? 'unknown', errorCode: error.code ?? 'mcp_internal_error' });
      return errorToJsonRpc(requestId, error);
    }
  }

  function disconnect(reason = 'closed') {
    state.disconnected = true;
    for (const controller of state.active) controller.abort(reason);
    state.active.clear();
  }

  return Object.freeze({
    handle,
    registerGrant,
    disconnect,
    state: () => ({
      initialized: state.initialized,
      disconnected: state.disconnected,
      activeInvocations: state.active.size,
      grantCount: state.grants.size
    })
  });
}
