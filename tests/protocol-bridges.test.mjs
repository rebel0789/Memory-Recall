import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOafReadOnlyResourceCatalog, createMcpBridge } from '../packages/protocol-bridges/src/index.mjs';

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

function oafState() {
  return {
    schemaVersion: '1.0.0',
    runs: [
      {
        id: 'run_mcp',
        workspaceId: 'ws_mcp',
        workflowId: 'workflow:content-intelligence',
        workflowVersion: '0.1.0',
        objective: 'Private objective should be fingerprinted only.',
        status: 'completed',
        residency: 'local-only',
        createdAt: '2026-06-24T00:00:00.000Z',
        completedAt: '2026-06-24T00:00:01.000Z',
        output: { text: 'private model result should not leave state' }
      },
      {
        id: 'run_other',
        workspaceId: 'ws_other',
        workflowId: 'workflow:content-intelligence',
        objective: 'Other workspace objective',
        status: 'failed'
      }
    ],
    events: [
      {
        id: 'evt_1',
        workspaceId: 'ws_mcp',
        runId: 'run_mcp',
        sequence: 1,
        type: 'context.compiled',
        occurredAt: '2026-06-24T00:00:00.500Z',
        payload: {
          id: 'ctx_mcp',
          compilerVersion: 'context-compiler@1.0.0',
          createdAt: '2026-06-24T00:00:00.500Z',
          budget: { available: 200, used: 42 },
          selected: [{
            id: 'doc_safe',
            kind: 'instruction',
            category: 'governance',
            order: 1,
            score: 1,
            tokens: 42,
            reasonCodes: ['explicit_requirement'],
            source: '/Users/rebel/private.txt',
            text: 'raw prompt body with token=secret should never be included'
          }],
          excluded: [{
            id: 'doc_noise',
            kind: 'note',
            tokens: 18,
            reasonCodes: ['insufficient_relevance'],
            source: 'workspace://notes/noise.md',
            text: 'excluded raw body should not be included'
          }]
        }
      },
      {
        id: 'evt_other',
        workspaceId: 'ws_other',
        runId: 'run_other',
        sequence: 1,
        type: 'run.started',
        occurredAt: '2026-06-24T00:00:00.000Z',
        payload: { text: 'other workspace payload' }
      }
    ],
    memories: [
      {
        id: 'mem_proposed',
        workspaceId: 'ws_mcp',
        kind: 'decision',
        status: 'proposed',
        decision: 'review',
        confidence: 0.7,
        evidenceIds: ['ev_mcp'],
        createdAt: '2026-06-24T00:00:00.000Z',
        text: 'private memory text'
      },
      {
        id: 'mem_other',
        workspaceId: 'ws_other',
        kind: 'decision',
        status: 'proposed',
        text: 'other workspace memory'
      }
    ],
    approvals: [
      {
        id: 'approval_mcp',
        workspaceId: 'ws_mcp',
        status: 'pending',
        riskClass: 'reversible-write',
        operation: 'draft.write',
        createdAt: '2026-06-24T00:00:00.000Z'
      }
    ],
    artifacts: [
      {
        id: 'artifact_mcp',
        workspaceId: 'ws_mcp',
        kind: 'handoff',
        runId: 'run_mcp',
        contentType: 'text/markdown',
        hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        createdAt: '2026-06-24T00:00:00.000Z',
        localPath: '/Users/rebel/private/handoff.md'
      }
    ]
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

test('OAF read-only MCP resource catalog exposes sanitized workspace-scoped resources', async () => {
  const state = oafState();
  const before = JSON.stringify(state);
  const resources = buildOafReadOnlyResourceCatalog({
    state,
    projectStatus: {
      release: '0.2.0-dev',
      phase: 'local-test',
      nextTask: 'OAF-031',
      defaults: { network: 'deny', externalWrites: false, modelMode: 'deterministic', dataResidency: 'local-only', adapters: 'disabled' }
    },
    workspaceId: 'ws_mcp',
    generatedAt: '2026-06-24T00:00:00.000Z'
  });
  const bridge = createMcpBridge({ trustedContext, resources });
  const listed = await bridge.handle({ jsonrpc: '2.0', id: 1, method: 'resources/list' });
  assert.deepEqual(listed.result.resources.map((item) => item.uri), [
    'oaf://workspace/ws_mcp/status',
    'oaf://workspace/ws_mcp/context/latest',
    'oaf://workspace/ws_mcp/runs/latest',
    'oaf://workspace/ws_mcp/memory/proposals',
    'oaf://workspace/ws_mcp/handoff/latest'
  ]);

  const first = await bridge.handle({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'oaf://workspace/ws_mcp/context/latest' } });
  const second = await bridge.handle({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'oaf://workspace/ws_mcp/context/latest' } });
  assert.equal(first.result.contents[0].text, second.result.contents[0].text);
  const payload = JSON.parse(first.result.contents[0].text);
  assert.equal(payload.resourceKind, 'context-manifest-summary');
  assert.equal(payload.workspaceId, 'ws_mcp');
  assert.equal(payload.data.contextManifest.selectedCount, 1);
  assert.equal(payload.data.contextManifest.excludedCount, 1);
  assert.equal(payload.data.contextManifest.selected[0].locator, null);
  assert.match(payload.resourceFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(payload.safeguards.readOnly, true);
  assert.equal(payload.safeguards.canonicalStateMutated, false);
  assert.equal(payload.safeguards.networkCalls, 0);
  assert.equal(payload.safeguards.modelCalls, 0);
  const text = JSON.stringify(payload);
  assert.equal(text.includes('raw prompt body'), false);
  assert.equal(text.includes('private model result'), false);
  assert.equal(text.includes('private memory text'), false);
  assert.equal(text.includes('/Users/rebel'), false);
  assert.equal(text.includes('run_other'), false);

  const handoff = await bridge.handle({ jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'oaf://workspace/ws_mcp/handoff/latest' } });
  const handoffPayload = JSON.parse(handoff.result.contents[0].text);
  assert.equal(handoffPayload.resourceKind, 'handoff-bundle-summary');
  assert.equal(handoffPayload.workspaceId, 'ws_mcp');
  assert.match(handoffPayload.resourceFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(handoffPayload.safeguards.readOnly, true);
  assert.equal(handoffPayload.safeguards.canonicalStateMutated, false);
  const handoffText = JSON.stringify(handoffPayload);
  assert.equal(handoffText.includes('raw prompt body'), false);
  assert.equal(handoffText.includes('private model result'), false);
  assert.equal(handoffText.includes('private memory text'), false);
  assert.equal(handoffText.includes('/Users/rebel'), false);
  assert.equal(handoffText.includes('run_other'), false);
  assert.equal(JSON.stringify(state), before);
});
