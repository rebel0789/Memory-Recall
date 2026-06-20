import { createHash } from 'node:crypto';

export const PROTOCOL_BRIDGES_VERSION = '0.1.0';
export const MCP_BRIDGE_PROTOCOL_VERSION = '2025-06-18';

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
