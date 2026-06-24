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
const MAX_RESULT_BYTES = 8192;

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

function safeLocator(value) {
  if (typeof value !== 'string') return null;
  if (/^(workspace|artifact|evidence|memory|run|context|user-selected|omit|oaf):\/\//.test(value)) return value;
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

function createResourcePayload({ resourceKind, workspaceId, generatedAt, data }) {
  const payload = {
    schemaVersion: OAF_READ_ONLY_MCP_RESOURCE_VERSION,
    resourceKind,
    workspaceId,
    generatedAt,
    provenance: {
      producer: 'open-agent-fabric.protocol-bridges',
      producerVersion: PROTOCOL_BRIDGES_VERSION,
      source: 'local-state',
      sourceFingerprint: fingerprintFor(data)
    },
    safeguards: commonSafeguards(),
    data
  };
  const withFingerprint = { ...payload, resourceFingerprint: fingerprintFor(payload) };
  assertSafeResult(withFingerprint);
  return withFingerprint;
}

function jsonResource(uri, name, description, readPayload) {
  return {
    uri,
    name,
    description,
    mimeType: 'application/json',
    read: async () => {
      const payload = readPayload();
      return [{ uri, mimeType: 'application/json', text: JSON.stringify(payload, null, 2) }];
    }
  };
}

export function buildOafReadOnlyResourceCatalog({
  state = {},
  projectStatus = {},
  workspaceId = 'ws_local',
  generatedAt = new Date().toISOString()
} = {}) {
  const safeWorkspaceId = validateWorkspaceId(workspaceId);
  const scoped = workspaceScopedState(state, safeWorkspaceId);
  const base = `oaf://workspace/${safeWorkspaceId}`;
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

  return [
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
