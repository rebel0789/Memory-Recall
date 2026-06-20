import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpBridge } from '../packages/protocol-bridges/src/index.mjs';

const trustedContext = {
  principal: {
    userId: 'usr_mcp',
    principalType: 'agent',
    authenticationMethod: 'session',
    status: 'active'
  },
  membership: {
    workspaceId: 'ws_mcp',
    role: 'builder',
    status: 'active'
  },
  environment: {
    deploymentProfile: 'local-dev',
    locality: 'local-only',
    externalWritesEnabled: false
  }
};

function readTool(handler = async ({ arguments: args }) => ({ content: [{ type: 'text', text: `run:${args.runId}` }] })) {
  return {
    name: 'oaf.readRun',
    description: 'Read a sanitized OAF run summary.',
    operation: 'runs.read',
    sideEffectClass: 'read-only',
    inputSchema: {
      type: 'object',
      required: ['runId'],
      properties: { runId: { type: 'string' } }
    },
    handler
  };
}

function writeTool() {
  return {
    name: 'oaf.writeDraft',
    description: 'Write a local draft.',
    operation: 'drafts.write',
    sideEffectClass: 'reversible-write',
    inputSchema: { type: 'object' },
    handler: async () => ({ content: [{ type: 'text', text: 'written' }] })
  };
}

function resource() {
  return {
    uri: 'oaf://workspace/ws_mcp/runs/run_demo',
    name: 'run_demo',
    description: 'Sanitized run summary',
    mimeType: 'application/json',
    read: async () => [{ uri: 'oaf://workspace/ws_mcp/runs/run_demo', mimeType: 'application/json', text: '{"status":"completed"}' }]
  };
}

function allowGrant(overrides = {}) {
  return {
    decision: 'allow',
    grantId: 'grant_read',
    workspaceId: 'ws_mcp',
    toolName: 'oaf.readRun',
    operation: 'runs.read',
    sideEffectClass: 'read-only',
    expiresAt: '2026-06-20T18:00:00Z',
    ...overrides
  };
}

test('MCP bridge initializes and lists tools/resources only with trusted identity', async () => {
  const unauthenticated = createMcpBridge({ tools: [readTool()], resources: [resource()] });
  const denied = await unauthenticated.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(denied.error.data.code, 'mcp_identity_required');

  const bridge = createMcpBridge({ trustedContext, tools: [readTool()], resources: [resource()] });
  const init = await bridge.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.capabilities.tools.listChanged, false);
  const tools = await bridge.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(tools.result.tools.map((tool) => tool.name), ['oaf.readRun']);
  const resources = await bridge.handle({ jsonrpc: '2.0', id: 3, method: 'resources/list' });
  assert.deepEqual(resources.result.resources.map((item) => item.uri), ['oaf://workspace/ws_mcp/runs/run_demo']);
});

test('MCP tool calls require exact server-side grants and reject caller authority', async () => {
  const bridge = createMcpBridge({
    trustedContext,
    tools: [readTool()],
    clock: () => '2026-06-20T17:00:00Z'
  });
  bridge.registerGrant(allowGrant());
  const injected = await bridge.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'oaf.readRun',
      grantId: 'grant_read',
      arguments: { runId: 'run_demo', role: 'owner' }
    }
  });
  assert.equal(injected.error.data.code, 'mcp_authority_injection');

  const wrongGrant = createMcpBridge({ trustedContext, tools: [readTool()], clock: () => '2026-06-20T17:00:00Z' });
  wrongGrant.registerGrant(allowGrant({ operation: 'runs.delete' }));
  const denied = await wrongGrant.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'oaf.readRun', grantId: 'grant_read', arguments: { runId: 'run_demo' } }
  });
  assert.equal(denied.error.data.code, 'mcp_grant_denied');

  const allowed = createMcpBridge({ trustedContext, tools: [readTool()], clock: () => '2026-06-20T17:00:00Z' });
  allowed.registerGrant(allowGrant());
  const result = await allowed.handle({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'oaf.readRun', grantId: 'grant_read', arguments: { runId: 'run_demo' } }
  });
  assert.equal(result.result.content[0].text, 'run:run_demo');
  assert.equal(JSON.stringify(result).includes('grant_secret'), false);
});

test('MCP bridge replay mode denies side-effecting tools before invocation', async () => {
  let called = false;
  const tool = writeTool();
  tool.handler = async () => {
    called = true;
    return { content: [{ type: 'text', text: 'written' }] };
  };
  const bridge = createMcpBridge({
    trustedContext,
    replayMode: true,
    tools: [tool],
    clock: () => '2026-06-20T17:00:00Z'
  });
  bridge.registerGrant(allowGrant({
    grantId: 'grant_write',
    toolName: 'oaf.writeDraft',
    operation: 'drafts.write',
    sideEffectClass: 'reversible-write'
  }));
  const result = await bridge.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'oaf.writeDraft', grantId: 'grant_write', arguments: {} }
  });
  assert.equal(result.error.data.code, 'mcp_replay_side_effect_denied');
  assert.equal(called, false);
});

test('MCP bridge disconnect cancels in-flight calls and rejects later requests', async () => {
  let sawAbort = false;
  const bridge = createMcpBridge({
    trustedContext,
    tools: [readTool(async ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        sawAbort = true;
        reject(new Error('aborted'));
      }, { once: true });
      setTimeout(() => resolve({ content: [{ type: 'text', text: 'late' }] }), 50);
    }))],
    clock: () => '2026-06-20T17:00:00Z'
  });
  bridge.registerGrant(allowGrant());
  const pending = bridge.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'oaf.readRun', grantId: 'grant_read', arguments: { runId: 'run_demo' } }
  });
  bridge.disconnect('test');
  const result = await pending;
  assert.equal(sawAbort, true);
  assert.equal(result.error.data.code, 'mcp_disconnected');
  const later = await bridge.handle({ jsonrpc: '2.0', id: 2, method: 'ping' });
  assert.equal(later.error.data.code, 'mcp_disconnected');
});

test('MCP bridge rejects malformed messages and private result payloads', async () => {
  const bridge = createMcpBridge({
    trustedContext,
    tools: [readTool(async () => ({ content: [{ type: 'json', json: { rawPrompt: 'blocked' } }] }))],
    clock: () => '2026-06-20T17:00:00Z'
  });
  const malformed = await bridge.handle({ id: 1, method: 'tools/list' });
  assert.equal(malformed.error.data.code, 'mcp_invalid_request');
  bridge.registerGrant(allowGrant());
  const privatePayload = await bridge.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'oaf.readRun', grantId: 'grant_read', arguments: { runId: 'run_demo' } }
  });
  assert.equal(privatePayload.error.data.code, 'mcp_private_payload');
});
