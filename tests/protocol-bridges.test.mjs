import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildOafReadOnlyResourceCatalog, createMcpBridge } from '../packages/protocol-bridges/src/index.mjs';
import { buildContextPackUsePlan } from '../packages/harness-context/src/index.mjs';
import { assertJsonSchema } from '../packages/protocol/src/schema-validator.mjs';
import mcpReadOnlyResourceSchema from '../packages/protocol/schemas/mcp-readonly-resource.schema.json' with { type: 'json' };
import memoryRefineReport from '../examples/protocol/memory-refine-report.json' with { type: 'json' };

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

function skillLoadPlan(overrides = {}) {
  return {
    schemaVersion: '1.0.0',
    command: 'skill load-plan',
    generatedAt: '2026-07-05T00:00:00.000Z',
    workspaceId: 'ws_mcp',
    rootRef: 'workspace://.',
    skill: {
      id: 'skill:oaf-memory',
      name: 'OAF Memory Mapper',
      description: 'Map project decisions into proposal-gated OAF memory.',
      version: '0.1.0',
      advertised: true,
      directoryRef: 'workspace://skills/oaf-memory',
      manifestRef: 'workspace://skills/oaf-memory/manifest.json',
      skillRef: 'workspace://skills/oaf-memory/SKILL.md',
      sideEffectClass: 'reversible-write',
      triggers: ['/oaf-memory'],
      tools: ['tool:filesystem-read'],
      references: [],
      readiness: {
        state: 'review',
        approvalRequired: true,
        unreviewedToolIds: [],
        reasonCodes: ['write_skill_requires_approval']
      },
      manifestFingerprint: `sha256:${'a'.repeat(64)}`,
      checks: {
        manifestValid: true,
        skillDocumentPresent: true,
        referencesPresent: true
      }
    },
    requiredLocalReads: [
      { order: 1, kind: 'manifest', ref: 'workspace://skills/oaf-memory/manifest.json', reason: 'Validate skill metadata before reading instructions.' },
      { order: 2, kind: 'skill', ref: 'workspace://skills/oaf-memory/SKILL.md', reason: 'Read instructions only after the trigger matches.' }
    ],
    catalogFingerprint: `sha256:${'b'.repeat(64)}`,
    safeguards: {
      readOnly: true,
      canonicalStateMutated: false,
      localFilesWritten: 0,
      externalWritesEnabled: false,
      networkCalls: 0,
      modelCalls: 0,
      rawSkillTextIncluded: false,
      toolAuthorityGranted: false,
      absoluteFilesystemLocationsIncluded: false
    },
    loadPlanFingerprint: `sha256:${'c'.repeat(64)}`,
    ...overrides
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

function toolCatalog(overrides = {}) {
  return {
    state: 'ready',
    configured: true,
    summary: {
      toolCount: 1,
      enabledToolCount: 1,
      reviewedToolCount: 1,
      disabledToolCount: 0,
      operationCount: 1,
      sideEffectClassCounts: { 'read-only': 1 },
      writableOperationCount: 0,
      approvalRequiredOperationCount: 0,
      idempotencyRequiredOperationCount: 0,
      networkTargetCount: 0,
      credentialReferenceCount: 0
    },
    tools: [{
      id: 'tool:filesystem-read',
      name: 'Read bounded workspace files',
      version: '1.0.0',
      enabled: true,
      reviewStatus: 'reviewed',
      reviewVersion: 'OAF-015',
      manifestRef: 'workspace://tools/manifests/brokered-filesystem-read.json',
      reviewedManifestSha256: `sha256:${'c'.repeat(64)}`,
      manifestFingerprint: `sha256:${'d'.repeat(64)}`,
      operations: [{
        name: 'readFile',
        sideEffectClass: 'read-only',
        approvalRequired: false,
        idempotencyRequired: false,
        dataClasses: ['workspace-private'],
        filesystemReadScopes: ['workspace:root'],
        filesystemWriteScopes: [],
        networkTargetCount: 0,
        credentialReferenceCount: 0
      }]
    }],
    toolCatalogFingerprint: `sha256:${'e'.repeat(64)}`,
    reasonCodes: ['tool_catalog_validated'],
    safeguards: {
      readOnly: true,
      localFilesWritten: 0,
      networkCalls: 0,
      modelCalls: 0,
      toolAuthorityGranted: false,
      manifestTextIncluded: false,
      absoluteFilesystemLocationsIncluded: false,
      remoteEndpointDetailsIncluded: false
    },
    ...overrides
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
        evidenceIds: ['ev_mcp', '/Users/rebel/private.txt', 'OPENAI_API_KEY=abc123', 'token=secret-value'],
        supersedes: 'mem_/Users/rebel/old.txt',
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

function contextPackFixture() {
  const hash = `sha256:${'a'.repeat(64)}`;
  return {
    pack: {
      schemaVersion: '1.0.0',
      packVersion: '0.1.0',
      id: 'ctxpack_mcp',
      workspaceId: 'ws_mcp',
      createdAt: '2026-06-24T00:00:00.000Z',
      dryRun: true,
      targetHarness: 'codex',
      sourceHarnesses: ['codex'],
      requestedInputs: {
        sourceHarnesses: ['codex'],
        userSelectedLocators: ['user-selected://notes/handoff.md'],
        changedLocators: ['workspace://src/auth.ts'],
        userSelectedCount: 1,
        changedLocatorCount: 1
      },
      objective: 'Private MCP objective text should not appear.',
      step: 'Private MCP step text should not appear.',
      scannerVersion: 'harness-context@1.0.0',
      compilerVersion: 'context-compiler@1.0.0',
      preview: {
        id: 'ctxprev_mcp',
        previewFingerprint: hash,
        requestId: 'ctxreq_mcp',
        selectionPolicyFingerprint: hash,
        resultFingerprint: hash,
        budget: { available: 4096, used: 80 },
        selectedCount: 2,
        excludedCount: 1,
        candidateTokenCount: 200,
        selectedTokenCount: 80,
        selectedTokenRatio: 0.4
      },
      readFirst: [
        { id: 'ctx_agents', locator: 'workspace://AGENTS.md', harness: 'codex', sourceKind: 'instruction', tokens: 40, contentHash: hash, reasonCodes: ['required_context'] },
        { id: 'ctx_user', locator: 'user-selected://notes/handoff.md', harness: 'generic-mcp', sourceKind: 'user-selected', tokens: 40, contentHash: hash, reasonCodes: ['explicit_user_file'] }
      ],
      excluded: [
        { id: 'ctx_private', locator: 'workspace://Users/rebel/private.txt', harness: 'codex', sourceKind: 'private', tokens: 10, contentHash: hash, reasonCodes: ['private_path'] }
      ],
      delivery: {
        representation: 'locator-handoff',
        sourceCandidateTokenCount: 200,
        sourceSelectedTokenCount: 80,
        sourceSelectedTokenRatio: 0.4,
        deliveredTokenCount: 48,
        deliveredByteSize: 192,
        deliveredTokenRatio: 0.24,
        observedTokenReductionRatio: 0.76,
        sourceContentTokenCountIncluded: 0,
        sourceContentsIncluded: false
      },
      omissions: {
        excludedCount: 1,
        excludedTokenCount: 10,
        sourceGraphOmittedCount: 0,
        refs: [
          { id: 'omit_aaaaaaaaaaaaaaaa', locator: 'workspace://.local/state.json', harness: 'codex', sourceKind: 'private', tokens: 10, contentHash: hash, reasonCodes: ['private_path'], recoveryHint: 'Do not expose private state.' }
        ]
      },
      memoryPlan: {
        activeMemoryCreated: 0,
        items: [
          { sourceId: 'ctx_user', locator: 'user-selected://notes/handoff.md', harness: 'generic-mcp', sourceKind: 'user-selected', action: 'would_propose', reasonCodes: ['explicit_user_file'] }
        ]
      },
      sourceGraph: {
        status: 'available',
        sourceIndexFingerprint: hash,
        graphFingerprint: hash,
        queryFingerprint: hash,
        summary: { fileCount: 2, symbolCount: 1, nodeCount: 3, edgeCount: 2 },
        resultCount: 1,
        omittedCount: 0,
        results: [
          { resultType: 'node', kind: 'symbol', label: 'approveTokenReset', locator: 'workspace://src/auth.ts#L1-L3', score: 1, reasonCodes: ['query_match'], readHint: 'Raw read hint should not appear.' }
        ],
        impact: {
          changedLocators: ['workspace://src/auth.ts'],
          representedChangedLocators: ['workspace://src/auth.ts'],
          affectedSymbolCount: 1,
          omittedAffectedSymbolCount: 0,
          affectedSymbols: [
            { name: 'approveTokenReset', symbolKind: 'function', locator: 'workspace://src/auth.ts#L1-L3', depth: 0, reasonCodes: ['changed_locator_impact'], readHint: 'Raw impact hint should not appear.' }
          ]
        },
        warnings: ['raw_context_bodies_omitted'],
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
      },
      utility: {
        status: 'ready',
        requiredLocalReads: [
          { locator: 'workspace://AGENTS.md', role: 'selected_context', required: true, represented: true, contentHash: hash, reasonCodes: ['selected_context'], readHint: 'Read AGENTS.md' },
          { locator: 'workspace://src/auth.ts', role: 'changed_locator', required: true, represented: true, contentHash: hash, reasonCodes: ['changed_locator_supplied', 'content_hash_verified'], readHint: 'Read changed auth file' },
          { locator: 'workspace://src/auth.ts#L1-L3', role: 'source_graph_hint', required: false, represented: true, contentHash: null, reasonCodes: ['source_graph_hint'], readHint: 'Read graph hint' }
        ],
        changedLocatorCoverage: { total: 1, covered: 1, ratio: 1, status: 'covered' },
        graphHintCoverage: { total: 1, covered: 1, ratio: 1, status: 'covered' },
        sourceSelection: { candidateTokenCount: 200, selectedTokenCount: 80, selectedTokenRatio: 0.4, estimatedReductionRatio: 0.6 },
        delivery: { representation: 'locator-handoff', sourceContentsIncluded: false }
      },
      warnings: ['raw_context_bodies_omitted', 'external_writes_disabled'],
      files: [{ path: 'CONTEXT_PACK.md', role: 'agent-handoff', contentType: 'text/markdown', contentHash: hash, byteSize: 512 }],
      safeguards: {
        persisted: false,
        canonicalStateMutated: false,
        activeMemoryCreated: 0,
        sourceSnapshotsWritten: 0,
        modelCalls: 0,
        networkCalls: 0,
        externalAdaptersEnabled: 0,
        externalWritesEnabled: false,
        rawBodyIncluded: false,
        contextPackWritten: false,
        sourceGraphPreviewed: true
      },
      contextPackFingerprint: hash
    },
    markdown: '# Context Pack\n\nPrivate MCP objective text should not appear.\n\nRAW_MARKDOWN_SENTINEL'
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

function argumentsFingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

test('MCP bridge initializes and lists tools/resources only with trusted identity', async () => {
  const unauthenticated = createMcpBridge({ tools: [readTool()], resources: [resource()] });
  const denied = await unauthenticated.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(denied.error.data.code, 'mcp_identity_required');

  const bridge = createMcpBridge({ trustedContext, tools: [readTool()], resources: [resource()] });
  const init = await bridge.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.capabilities.tools.listChanged, false);
  assert.equal(init.result.capabilities.prompts.listChanged, false);
  const tools = await bridge.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(tools.result.tools.map((tool) => tool.name), ['oaf.readRun']);
  const resources = await bridge.handle({ jsonrpc: '2.0', id: 3, method: 'resources/list' });
  assert.deepEqual(resources.result.resources.map((item) => item.uri), ['oaf://workspace/ws_mcp/runs/run_demo']);
  assert.equal(resources.result.resources[0].title, 'run_demo');
  assert.deepEqual(resources.result.resources[0].annotations, { audience: ['assistant'], priority: 0.5 });
  const prompts = await bridge.handle({ jsonrpc: '2.0', id: 4, method: 'prompts/list' });
  assert.deepEqual(prompts.result, { prompts: [] });
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

test('MCP grant binds exact call arguments before handler invocation', async () => {
  let called = false;
  const bridge = createMcpBridge({
    trustedContext,
    tools: [readTool(async () => {
      called = true;
      return { content: [{ type: 'text', text: 'wrong' }] };
    })],
    clock: () => '2026-06-20T17:00:00Z'
  });
  bridge.registerGrant(allowGrant({
    argumentsFingerprint: argumentsFingerprint({ runId: 'run_safe' })
  }));

  const result = await bridge.handle({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'oaf.readRun', grantId: 'grant_read', arguments: { runId: 'run_changed' } }
  });

  assert.equal(result.error.data.code, 'mcp_grant_denied');
  assert.equal(called, false);
});

test('MCP side-effecting grants require exact argument fingerprints', () => {
  const bridge = createMcpBridge({
    trustedContext,
    tools: [writeTool()],
    clock: () => '2026-06-20T17:00:00Z'
  });

  assert.throws(
    () => bridge.registerGrant(allowGrant({
      grantId: 'grant_write',
      toolName: 'oaf.writeDraft',
      operation: 'drafts.write',
      sideEffectClass: 'reversible-write'
    })),
    (error) => error.code === 'mcp_grant_denied'
  );
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
    sideEffectClass: 'reversible-write',
    argumentsFingerprint: argumentsFingerprint({})
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

test('MCP bridge redacts untrusted request metadata in errors and events', async () => {
  const events = [];
  const bridge = createMcpBridge({
    trustedContext,
    tools: [readTool()],
    resources: [resource()],
    eventSink: async (event) => events.push(event)
  });
  const unknownResource = await bridge.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'resources/read',
    params: { uri: 'oaf://workspace/ws_mcp/runs//Users/rebel/private?token=secret-value' }
  });
  assert.equal(unknownResource.error.data.code, 'mcp_method_not_found');
  assert.equal(unknownResource.error.message, 'unknown MCP resource');

  const unknownTool = await bridge.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'oaf.secretTool./Users/rebel/token=secret-value', grantId: 'grant_missing', arguments: {} }
  });
  assert.equal(unknownTool.error.data.code, 'mcp_method_not_found');
  assert.equal(unknownTool.error.message, 'unknown MCP tool');

  const unsupported = await bridge.handle({
    jsonrpc: '2.0',
    id: 3,
    method: 'unsupported./Users/rebel/token=secret-value',
    params: {}
  });
  assert.equal(unsupported.error.data.code, 'mcp_method_not_found');
  assert.equal(unsupported.error.message, 'unsupported MCP method');

  const oversizedId = 'ID_SECRET_SENTINEL_'.repeat(16);
  const invalidId = await bridge.handle({
    jsonrpc: '2.0',
    id: oversizedId,
    method: 'resources/list'
  });
  assert.equal(invalidId.id, null);
  assert.equal(invalidId.error.data.code, 'mcp_invalid_request');
  assert.equal(invalidId.error.message, 'MCP bridge request id exceeds limit');

  for (const response of [unknownResource, unknownTool, unsupported, invalidId]) {
    const text = JSON.stringify(response);
    assert.equal(text.includes('/Users/rebel'), false);
    assert.equal(text.includes('secret-value'), false);
    assert.equal(text.includes('ID_SECRET_SENTINEL'), false);
    assert(Buffer.byteLength(text, 'utf8') < 512);
  }
  assert.deepEqual(events.map((event) => event.method), ['resources/read', 'tools/call', 'unsupported', 'resources/list']);
  assert.equal(JSON.stringify(events).includes('/Users/rebel'), false);
  assert.equal(JSON.stringify(events).includes('secret-value'), false);
});

test('MCP bridge bounds resource list and read envelopes', async () => {
  const largeResource = {
    uri: 'oaf://workspace/ws_mcp/large',
    name: 'large',
    description: 'large resource',
    mimeType: 'application/json',
    read: async () => [{ uri: 'oaf://workspace/ws_mcp/large', mimeType: 'application/json', text: 'LARGE_RESOURCE_SENTINEL_'.repeat(4096) }]
  };
  const largeRead = createMcpBridge({ trustedContext, resources: [largeResource] });
  const read = await largeRead.handle({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'oaf://workspace/ws_mcp/large' } });
  assert.equal(read.error.data.code, 'mcp_output_too_large');
  assert.equal(read.error.message, 'bridge result exceeded output limit');
  assert.equal(JSON.stringify(read).includes('LARGE_RESOURCE_SENTINEL'), false);

  const manyResources = Array.from({ length: 1400 }, (_, index) => ({
    uri: `oaf://workspace/ws_mcp/large-${index}`,
    name: `large-${index}`,
    description: 'MANY_RESOURCES_SENTINEL',
    mimeType: 'application/json',
    read: async () => []
  }));
  const largeList = createMcpBridge({ trustedContext, resources: manyResources });
  const listed = await largeList.handle({ jsonrpc: '2.0', id: 2, method: 'resources/list' });
  assert.equal(listed.error.data.code, 'mcp_output_too_large');
  assert.equal(listed.error.message, 'bridge result exceeded output limit');
  assert.equal(JSON.stringify(listed).includes('MANY_RESOURCES_SENTINEL'), false);
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
  const contextResource = listed.result.resources.find((item) => item.uri === 'oaf://workspace/ws_mcp/context/latest');
  assert.equal(contextResource.title, 'Latest context manifest summary');
  assert.deepEqual(contextResource.annotations, { audience: ['assistant'], priority: 0.9 });

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
  assert.equal(handoffPayload.data.memoryProposalSummary.state, 'review');
  assert.equal(handoffPayload.data.memoryProposalSummary.proposedCount, 1);
  assert.equal(handoffPayload.data.memoryProposalSummary.acceptedCount, 0);
  assert.equal(handoffPayload.data.memoryProposalSummary.quarantinedCount, 0);
  assert.match(handoffPayload.data.memoryProposalSummary.queueFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(handoffPayload.data.memoryProposalSummary.safeguards.readOnly, true);
  assert.equal(handoffPayload.data.memoryProposalSummary.safeguards.memoryTextVisible, false);
  assert.equal(handoffPayload.data.memoryProposalSummary.safeguards.sourceContentVisible, false);
  assert.equal(handoffPayload.data.memoryProposalSummary.safeguards.localLocationsVisible, false);
  assert.equal(handoffPayload.data.memoryProposalSummary.safeguards.activeMemoryCreated, 0);
  assert.deepEqual(handoffPayload.data.memoryProposalSummary.proposed[0].evidenceIds, ['ev_mcp']);
  assert.equal(handoffPayload.data.memoryProposalSummary.proposed[0].supersedes, null);
  const handoffText = JSON.stringify(handoffPayload);
  assert.equal(handoffText.includes('raw prompt body'), false);
  assert.equal(handoffText.includes('private model result'), false);
  assert.equal(handoffText.includes('private memory text'), false);
  assert.equal(handoffText.includes('/Users/rebel'), false);
  assert.equal(handoffText.includes('OPENAI_API_KEY'), false);
  assert.equal(handoffText.includes('token=secret-value'), false);
  assert.equal(handoffText.includes('run_other'), false);
  assert.equal(JSON.stringify(state), before);
});

test('OAF read-only MCP resource catalog exposes sanitized skill load plans', async () => {
  const resources = buildOafReadOnlyResourceCatalog({
    skillLoadPlans: [skillLoadPlan()],
    workspaceId: 'ws_mcp',
    generatedAt: '2026-07-05T00:00:00.000Z'
  });
  const bridge = createMcpBridge({ trustedContext, resources });
  const listed = await bridge.handle({ jsonrpc: '2.0', id: 1, method: 'resources/list' });
  assert(listed.result.resources.some((item) => item.uri === 'oaf://workspace/ws_mcp/skills/oaf-memory/load-plan'));

  const read = await bridge.handle({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'oaf://workspace/ws_mcp/skills/oaf-memory/load-plan' } });
  const payload = JSON.parse(read.result.contents[0].text);
  assertJsonSchema(mcpReadOnlyResourceSchema, payload, 'mcp skill load-plan resource payload');
  assert.equal(payload.resourceKind, 'skill-load-plan');
  assert.equal(payload.provenance.source, 'local-skill-load-plan');
  assert.equal(payload.data.skill.id, 'skill:oaf-memory');
  assert.deepEqual(payload.data.requiredLocalReads.map((item) => item.ref), [
    'workspace://skills/oaf-memory/manifest.json',
    'workspace://skills/oaf-memory/SKILL.md'
  ]);
  assert.equal(payload.data.safeguards.rawSkillTextIncluded, undefined);
  assert.equal(payload.data.safeguards.skillTextIncluded, false);
  assert.equal(payload.data.safeguards.toolAuthorityGranted, false);
  assert.equal(JSON.stringify(payload).includes('/Users/rebel'), false);
  assert.equal(JSON.stringify(payload).includes('Never auto-approve'), false);
});

test('OAF read-only MCP resource catalog exposes memory refine reports without writes', async () => {
  const resources = buildOafReadOnlyResourceCatalog({
    memoryRefineReport,
    workspaceId: 'ws_mcp',
    generatedAt: '2026-07-05T00:00:00.000Z'
  });
  const bridge = createMcpBridge({ trustedContext, resources });
  const listed = await bridge.handle({ jsonrpc: '2.0', id: 1, method: 'resources/list' });
  assert(listed.result.resources.some((item) => item.uri === 'oaf://workspace/ws_mcp/memory/refine'));

  const read = await bridge.handle({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'oaf://workspace/ws_mcp/memory/refine' } });
  const payload = JSON.parse(read.result.contents[0].text);
  assertJsonSchema(mcpReadOnlyResourceSchema, payload, 'mcp memory refine resource payload');
  assert.equal(payload.resourceKind, 'memory-refine-report');
  assert.equal(payload.provenance.source, 'local-memory-refine');
  assert.equal(payload.data.command, 'memory refine');
  assert.equal(payload.data.summary.lowConfidenceCandidateCount, 1);
  assert.equal(payload.data.safeguards.readOnly, true);
  assert.equal(payload.data.safeguards.canonicalStateMutated, false);
  assert.equal(payload.data.safeguards.networkCalls, 0);
  assert.equal(payload.data.safeguards.modelCalls, 0);
  assert.equal(JSON.stringify(payload).includes('/Users/rebel'), false);
  assert.equal(JSON.stringify(payload).includes('OPENAI_API_KEY'), false);
});

test('OAF read-only MCP resource catalog exposes reviewed tool catalog without grants', async () => {
  const resources = buildOafReadOnlyResourceCatalog({
    toolCatalog: toolCatalog(),
    workspaceId: 'ws_mcp',
    generatedAt: '2026-07-05T00:00:00.000Z'
  });
  const bridge = createMcpBridge({ trustedContext, resources });
  const listed = await bridge.handle({ jsonrpc: '2.0', id: 1, method: 'resources/list' });
  assert(listed.result.resources.some((item) => item.uri === 'oaf://workspace/ws_mcp/tools/catalog'));

  const read = await bridge.handle({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'oaf://workspace/ws_mcp/tools/catalog' } });
  const payload = JSON.parse(read.result.contents[0].text);
  assertJsonSchema(mcpReadOnlyResourceSchema, payload, 'mcp tool catalog resource payload');
  assert.equal(payload.resourceKind, 'tool-catalog-summary');
  assert.equal(payload.provenance.source, 'local-tool-catalog');
  assert.equal(payload.data.summary.toolCount, 1);
  assert.equal(payload.data.summary.operationCount, 1);
  assert.equal(payload.data.tools[0].id, 'tool:filesystem-read');
  assert.equal(payload.data.tools[0].operations[0].sideEffectClass, 'read-only');
  assert.equal(payload.data.safeguards.toolAuthorityGranted, false);
  assert.equal(payload.data.safeguards.manifestTextIncluded, false);
  assert.equal(JSON.stringify(payload).includes('/Users/rebel'), false);
  assert.equal(JSON.stringify(payload).includes('handler:'), false);
});

test('OAF read-only MCP resource catalog rejects unsafe skill load plans', () => {
  assert.throws(
    () => buildOafReadOnlyResourceCatalog({
      skillLoadPlans: [skillLoadPlan({
        requiredLocalReads: [
          { order: 1, kind: 'manifest', ref: 'workspace://skills/oaf-memory/manifest.json', reason: 'ok' },
          { order: 2, kind: 'skill', ref: 'file:///Users/rebel/private/SKILL.md', reason: 'bad' }
        ]
      })],
      workspaceId: 'ws_mcp'
    }),
    /skill load plan failed schema validation|skill load plan contains unsafe/
  );
});

test('OAF read-only MCP resource catalog can expose an opt-in current context-pack summary', async () => {
  const state = oafState();
  const before = JSON.stringify(state);
  const resources = buildOafReadOnlyResourceCatalog({
    state,
    currentContextPack: contextPackFixture(),
    workspaceId: 'ws_mcp',
    generatedAt: '2026-06-24T00:00:00.000Z'
  });
  const bridge = createMcpBridge({ trustedContext, resources });
  const listed = await bridge.handle({ jsonrpc: '2.0', id: 1, method: 'resources/list' });
  assert.equal(listed.result.resources.length, 6);
  assert(listed.result.resources.some((item) => item.uri === 'oaf://workspace/ws_mcp/context-pack/current'));

  const first = await bridge.handle({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'oaf://workspace/ws_mcp/context-pack/current' } });
  const second = await bridge.handle({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'oaf://workspace/ws_mcp/context-pack/current' } });
  assert.equal(first.result.contents[0].text, second.result.contents[0].text);
  const payload = JSON.parse(first.result.contents[0].text);
  assert.equal(payload.resourceKind, 'context-pack-summary');
  assert.equal(payload.provenance.source, 'local-context-pack');
  assert.equal(payload.workspaceId, 'ws_mcp');
  assert.deepEqual(payload.data.sourceHarnesses, ['codex']);
  assert.deepEqual(payload.data.requestedInputs.userSelectedLocators, ['user-selected://notes/handoff.md']);
  assert.deepEqual(payload.data.requestedInputs.changedLocators, ['workspace://src/auth.ts']);
  assert.equal(payload.data.objectiveLength, 'Private MCP objective text should not appear.'.length);
  assert.match(payload.data.objectiveFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(payload.data.delivery.representation, 'locator-handoff');
  assert.equal(payload.data.delivery.sourceCandidateTokenCount, 200);
  assert.equal(payload.data.delivery.deliveredTokenCount, 48);
  assert.equal(payload.data.delivery.sourceContentTokenCountIncluded, 0);
  assert.equal(payload.data.delivery.sourceContentsIncluded, false);
  assert.equal(payload.data.readFirst.some((item) => item.locator === 'user-selected://notes/handoff.md'), true);
  assert.equal(payload.data.excluded[0].locator, null);
  assert.equal(payload.data.omissions.refs[0].locator, null);
  assert.deepEqual(payload.data.sourceGraph.impact.changedLocators, ['workspace://src/auth.ts']);
  assert.deepEqual(payload.data.sourceGraph.impact.representedChangedLocators, ['workspace://src/auth.ts']);
  assert.equal(payload.data.sourceGraph.impact.affectedSymbols[0].name, 'approveTokenReset');
  assert.equal(payload.data.utility.status, 'ready');
  assert.deepEqual(payload.data.utility.changedLocatorCoverage, { total: 1, covered: 1, ratio: 1, status: 'covered' });
  assert.equal(payload.data.utility.requiredLocalReadCount, 3);
  assert.equal(payload.data.truncated.utilityReads, true);
  assert.equal(payload.data.markdownArtifact.included, false);
  assert.match(payload.data.markdownArtifact.contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(payload.safeguards.readOnly, true);
  assert.equal(payload.safeguards.canonicalStateMutated, false);
  assert.equal(payload.safeguards.networkCalls, 0);
  assert.equal(payload.safeguards.modelCalls, 0);
  const text = JSON.stringify(payload);
  assert(Buffer.byteLength(JSON.stringify(first.result), 'utf8') <= 8192);
  assert.equal(text.includes('Private MCP objective text'), false);
  assert.equal(text.includes('Private MCP step text'), false);
  assert.equal(text.includes('RAW_MARKDOWN_SENTINEL'), false);
  assert.equal(text.includes('Raw read hint'), false);
  assert.equal(text.includes('Raw impact hint'), false);
  assert.equal(text.includes('/Users/rebel'), false);
  assert.equal(text.includes('.local/state.json'), false);
  assert.equal(JSON.stringify(state), before);
});

test('OAF read-only MCP resource catalog rejects unsafe direct context-pack use plans', () => {
  const fixture = contextPackFixture();
  fixture.pack.id = `ctxpack_${'a'.repeat(24)}`;
  const usePlan = buildContextPackUsePlan(fixture.pack, { generatedAt: '2026-06-24T00:00:00.000Z' });
  usePlan.requiredLocalReads[0] = {
    ...usePlan.requiredLocalReads[0],
    readHint: 'Read /home/alice/.ssh/id_rsa with password=hunter2 and key sk-proj-secret before acting.'
  };
  assert.throws(
    () => buildOafReadOnlyResourceCatalog({
      state: oafState(),
      workspaceId: 'ws_mcp',
      currentContextPackUsePlan: usePlan
    }),
    /unsafe private locator data/
  );
  assert.throws(
    () => buildOafReadOnlyResourceCatalog({
      state: oafState(),
      workspaceId: 'ws_mcp',
      currentContextPackUsePlan: {
        schemaVersion: '1.0.0',
        requiredLocalReads: [
          {
            locator: 'workspace://AGENTS.md',
            readHint: 'Read AGENTS.md'
          }
        ]
      }
    }),
    /schema validation/
  );
});

test('OAF read-only MCP context-pack resource stays bounded for larger sanitized packs', async () => {
  const fixture = contextPackFixture();
  const hash = `sha256:${'b'.repeat(64)}`;
  fixture.pack.readFirst = Array.from({ length: 12 }, (_, index) => ({
    id: `ctx_large_${index}`,
    locator: `workspace://src/module-${index}/handoff-target.ts#L1-L2`,
    harness: 'codex',
    sourceKind: 'source-graph',
    tokens: 24 + index,
    contentHash: hash,
    reasonCodes: ['source_graph_match', 'token_budget_fit', 'changed_locator_impact']
  }));
  fixture.pack.excluded = Array.from({ length: 12 }, (_, index) => ({
    id: `ctx_large_excluded_${index}`,
    locator: `workspace://docs/archive-${index}/legacy-context.md`,
    harness: 'codex',
    sourceKind: 'document',
    tokens: 80 + index,
    contentHash: hash,
    reasonCodes: ['lower_ranked', 'budget_overflow', 'stale_context']
  }));
  fixture.pack.omissions.refs = Array.from({ length: 12 }, (_, index) => ({
    id: `omit_large_${index}`,
    locator: `workspace://docs/omitted-${index}/legacy-context.md`,
    harness: 'codex',
    sourceKind: 'document',
    tokens: 80 + index,
    contentHash: hash,
    reasonCodes: ['lower_ranked', 'budget_overflow', 'stale_context']
  }));
  fixture.pack.memoryPlan.items = Array.from({ length: 12 }, (_, index) => ({
    sourceId: `ctx_large_${index}`,
    locator: `workspace://src/module-${index}/handoff-target.ts#L1-L2`,
    harness: 'codex',
    sourceKind: 'source-graph',
    action: 'would_propose',
    reasonCodes: ['explicit_user_file', 'proposal_only']
  }));
  fixture.pack.sourceGraph.results = Array.from({ length: 12 }, (_, index) => ({
    resultType: 'node',
    kind: 'symbol',
    label: `handoffTarget${index}`,
    locator: `workspace://src/module-${index}/handoff-target.ts#L1-L2`,
    score: 0.9,
    reasonCodes: ['query_match', 'changed_locator_impact']
  }));
  fixture.pack.sourceGraph.impact.affectedSymbols = Array.from({ length: 12 }, (_, index) => ({
    name: `handoffTarget${index}`,
    symbolKind: 'function',
    locator: `workspace://src/module-${index}/handoff-target.ts#L1-L2`,
    depth: index % 3,
    reasonCodes: ['changed_locator_impact']
  }));
  fixture.pack.utility.requiredLocalReads = Array.from({ length: 12 }, (_, index) => ({
    locator: `workspace://src/module-${index}/handoff-target.ts#L1-L2`,
    role: index % 2 ? 'source_graph_hint' : 'changed_locator',
    required: index % 2 === 0,
    represented: true,
    contentHash: hash,
    reasonCodes: ['changed_locator_impact']
  }));
  fixture.pack.preview.selectedCount = 12;
  fixture.pack.preview.excludedCount = 12;
  fixture.pack.omissions.excludedCount = 12;
  fixture.pack.omissions.sourceGraphOmittedCount = 8;
  fixture.pack.sourceGraph.resultCount = 12;
  fixture.pack.sourceGraph.impact.affectedSymbolCount = 12;

  const resources = buildOafReadOnlyResourceCatalog({
    state: oafState(),
    currentContextPack: fixture,
    workspaceId: 'ws_mcp',
    generatedAt: '2026-06-24T00:00:00.000Z'
  });
  const bridge = createMcpBridge({ trustedContext, resources });
  const read = await bridge.handle({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'oaf://workspace/ws_mcp/context-pack/current' } });
  assert.equal(read.error, undefined);
  assert(Buffer.byteLength(JSON.stringify(read.result), 'utf8') <= 8192);
  const payload = JSON.parse(read.result.contents[0].text);
  assert.equal(payload.data.readFirst.length, 2);
  assert.equal(payload.data.utility.requiredLocalReadCount, 12);
  assert.equal(payload.data.sourceGraph.results.length, 1);
  assert.equal(payload.data.sourceGraph.impact.affectedSymbols.length, 1);
  assert.equal(payload.data.truncated.readFirst, true);
  assert.equal(payload.data.truncated.sourceGraphResults, true);
  assert.equal(payload.data.truncated.affectedSymbols, true);
  assert.equal(payload.data.truncated.utilityReads, true);
});
