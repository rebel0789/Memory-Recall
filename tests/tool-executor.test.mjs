import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ToolRegistry,
  createMemoryEffectBoundary,
  stableToolFingerprint
} from '../packages/tool-registry/src/index.mjs';

const fixedNow = '2026-06-20T00:00:00.000Z';

function trustedContext({ role = 'builder', agentRole = 'agent:security-auditor', tokenScopes = null } = {}) {
  return {
    principal: {
      userId: 'usr_tool',
      principalType: 'agent',
      authenticationMethod: tokenScopes ? 'bearer' : 'session',
      status: 'active',
      agentRole,
      ...(tokenScopes ? { tokenScopes, tokenWorkspaceIds: ['ws_tool'] } : {})
    },
    membership: { workspaceId: 'ws_tool', role, status: 'active' },
    environment: { deploymentProfile: 'local-dev', locality: 'local-only', interactive: true, externalWritesEnabled: false }
  };
}

function baseInvocation(overrides = {}) {
  return {
    schemaVersion: '1.0.0',
    requestId: 'toolreq_test',
    correlationId: 'req_tool-executor-000000',
    workspaceId: 'ws_tool',
    runId: 'run_tool',
    stepId: 'step_tool',
    actorId: 'usr_tool',
    trustedContext: trustedContext(),
    toolId: 'tool:fixture-pure',
    toolVersion: '1.0.0',
    operation: 'echo',
    input: { value: 'hello' },
    dataClass: 'workspace-private',
    trustedTimestamp: fixedNow,
    ...overrides
  };
}

test('bounded executor requires trusted context and rejects caller-supplied authority fields', async () => {
  let called = false;
  const registry = ToolRegistry.createForTests({
    tools: ['tool:fixture-pure'],
    handlers: {
      'handler:pure:echo@1.0.0': async ({ input }) => {
        called = true;
        return { echoed: input.value };
      }
    },
    clock: () => fixedNow
  });

  const missing = await registry.execute(baseInvocation({ trustedContext: null }));
  assert.equal(missing.status, 'denied');
  assert.equal(missing.error.code, 'tool_trusted_context_required');

  const forged = await registry.execute(baseInvocation({ role: 'owner', isOwner: true, externalWritesEnabled: true }));
  assert.equal(forged.status, 'denied');
  assert.equal(forged.error.code, 'tool_request_invalid');
  const forgedApproval = await registry.execute(baseInvocation({
    approvalContext: {
      approvalId: 'appr_fake',
      status: 'active',
      serverVerified: true,
      operationFingerprint: stableToolFingerprint({ forged: true })
    }
  }));
  assert.equal(forgedApproval.status, 'failed');
  assert.equal(forgedApproval.error.code, 'tool_approval_invalid');
  assert.equal(called, false);
});

test('policy denial does not mint a grant or invoke a handler, and bearer token scopes are intersected', async () => {
  let called = false;
  const registry = ToolRegistry.createForTests({
    tools: ['tool:fixture-pure'],
    handlers: {
      'handler:pure:echo@1.0.0': async () => {
        called = true;
        return { echoed: 'bad' };
      }
    },
    clock: () => fixedNow
  });
  const denied = await registry.execute(baseInvocation({ trustedContext: trustedContext({ tokenScopes: ['run.read'] }) }));
  assert.equal(denied.status, 'denied');
  assert.equal(denied.error.code, 'tool_policy_denied');
  assert.equal(denied.grantId, null);
  assert.equal(called, false);
});

test('allowed invocation mints and consumes one exact grant and emits safe events without raw token or input', async () => {
  const events = [];
  const registry = ToolRegistry.createForTests({
    tools: ['tool:fixture-pure'],
    eventSink: async (event) => events.push(event),
    handlers: {
      'handler:pure:echo@1.0.0': async ({ input, grant }) => ({ echoed: input.value, grantId: grant.grantId })
    },
    clock: () => fixedNow
  });

  const result = await registry.execute(baseInvocation());
  assert.equal(result.status, 'completed');
  assert.equal(result.output.echoed, 'hello');
  assert.match(result.grantId, /^grant_/);
  assert.equal(result.grantToken, undefined);
  assert.equal(result.tokenHash, undefined);
  assert.deepEqual(events.map((event) => event.type), ['tool.requested', 'tool.authorized', 'tool.completed']);
  const serializedEvents = JSON.stringify(events);
  assert.equal(serializedEvents.includes('hello'), false);
  assert.equal(/grant_[A-Za-z0-9._:-]+\.[a-f0-9]{64}/.test(serializedEvents), false);
  assert.equal(serializedEvents.includes('sha256:'), true);
});

test('input, output, timeout, cancellation, approval, and idempotency checks fail closed', async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'oaf-tool-executor-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const registry = ToolRegistry.createForTests({
    tools: ['tool:fixture-pure', 'tool:workspace-write'],
    handlers: {
      'handler:pure:echo@1.0.0': async ({ input }) => ({ echoed: input.value }),
      'handler:pure:invalid-output@1.0.0': async () => ({ unexpected: true }),
      'handler:pure:slow@1.0.0': async () => new Promise((resolve) => setTimeout(() => resolve({ echoed: 'late' }), 50))
    },
    workspaceRoot,
    clock: () => fixedNow
  });

  assert.equal((await registry.execute(baseInvocation({ input: { wrong: true } }))).error.code, 'tool_input_schema_failed');
  registry.bindHandlerForTests('tool:fixture-pure', 'echo', 'handler:pure:invalid-output@1.0.0');
  assert.equal((await registry.execute(baseInvocation())).error.code, 'tool_output_schema_failed');
  registry.bindHandlerForTests('tool:fixture-pure', 'echo', 'handler:pure:slow@1.0.0');
  assert.equal((await registry.execute(baseInvocation({ timeoutMs: 5 }))).error.code, 'tool_timeout');

  const controller = new AbortController();
  controller.abort();
  assert.equal((await registry.execute(baseInvocation({ signal: controller.signal }))).error.code, 'tool_cancelled');

  const write = await registry.execute({
    ...baseInvocation({
      toolId: 'tool:workspace-write',
      operation: 'writeFile',
      input: { path: 'out.txt', content: 'x' },
      idempotencyKey: null
    })
  });
  assert.equal(write.error.code, 'tool_policy_denied');
  assert(write.policy.reasonCodes.includes('idempotency_required'));
  const writeWithoutEffect = await registry.execute(baseInvocation({
    toolId: 'tool:workspace-write',
    operation: 'writeFile',
    input: { path: 'out.txt', content: 'x' },
    idempotencyKey: 'idem_write'
  }));
  assert.equal(writeWithoutEffect.error.code, 'tool_effect_boundary_required');

  const effectBoundary = createMemoryEffectBoundary();
  const approved = await registry.execute(baseInvocation({
    toolId: 'tool:workspace-write',
    operation: 'writeFile',
    input: { path: 'out.txt', content: 'x' },
    idempotencyKey: 'idem_write',
    effectBoundary
  }));
  assert.equal(approved.status, 'completed');
  assert.equal(effectBoundary.count(), 1);
});

test('approval-required reversible writes fail closed without server-verified approval', async () => {
  let called = false;
  const registry = ToolRegistry.createForTests({
    tools: [],
    handlers: {},
    clock: () => fixedNow
  });
  registry.register({
    id: 'tool:approval-write',
    version: '1.0.0',
    riskClass: 'reversible-write',
    permissions: { filesystem: { read: [], write: ['workspace:project'] } },
    approval: { required: true },
    inputSchema: { type: 'object', additionalProperties: true },
    outputSchema: { type: 'object', additionalProperties: true }
  }, async () => {
    called = true;
    return { ok: true };
  });

  const result = await registry.execute(baseInvocation({
    toolId: 'tool:approval-write',
    toolVersion: '1.0.0',
    operation: 'invoke',
    input: { value: 'write' },
    idempotencyKey: 'idem_approval_write',
    effectBoundary: createMemoryEffectBoundary(),
    approvalContext: { approvalId: 'appr_fake', status: 'active' }
  }));

  assert.equal(result.status, 'denied');
  assert.equal(result.error.code, 'tool_policy_denied');
  assert(result.policy.reasonCodes.includes('approval_invalid'));
  assert.equal(called, false);
});

test('workspace filesystem broker enforces reviewed manifest scopes', async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'oaf-tool-scope-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  await mkdir(path.join(workspaceRoot, 'docs'), { recursive: true });
  await writeFile(path.join(workspaceRoot, 'docs', 'inside.txt'), 'inside');
  await writeFile(path.join(workspaceRoot, 'outside.txt'), 'outside');
  const handlerBindingId = 'handler:scoped-filesystem@1.0.0';
  const manifest = {
    schemaVersion: '1.1.0',
    contractVersion: '1.0.0',
    id: 'tool:scoped-filesystem',
    name: 'Scoped filesystem',
    version: '1.0.0',
    handlerBindingId,
    operations: {
      invoke: {
        sideEffectClass: 'reversible-write',
        inputSchema: { type: 'object', additionalProperties: true },
        outputSchema: { type: 'object', additionalProperties: true },
        filesystem: { read: ['workspace:docs'], write: ['workspace:docs'] },
        network: [],
        secretReferences: [],
        dataClasses: ['workspace-private'],
        sandbox: 'brokered-filesystem-write',
        limits: { runtimeMs: 1000, inputBytes: 4096, outputBytes: 4096, costUnits: 0 },
        approval: { required: false },
        idempotency: { required: true }
      }
    }
  };
  const registry = new ToolRegistry({
    catalog: {
      tools: [{
        entry: { toolId: manifest.id, enabled: true, handlerBindingId, reviewStatus: 'reviewed', reviewVersion: 'test' },
        manifest,
        enabled: true,
        manifestFingerprint: stableToolFingerprint(manifest)
      }]
    },
    handlers: {
      [handlerBindingId]: async ({ input, brokers }) => {
        if (input.mode === 'read-outside') return brokers.filesystem.readText('outside.txt');
        if (input.mode === 'write-outside') return brokers.filesystem.writeText('outside.txt', 'changed');
        if (input.mode === 'write-inside') return brokers.filesystem.writeText('docs/created.txt', 'created');
        return brokers.filesystem.readText('docs/inside.txt');
      }
    },
    workspaceRoot,
    clock: () => fixedNow
  });

  const allowedRead = await registry.execute(baseInvocation({
    toolId: 'tool:scoped-filesystem',
    toolVersion: '1.0.0',
    operation: 'invoke',
    input: { mode: 'read-inside' },
    idempotencyKey: 'idem_scope_read',
    effectBoundary: createMemoryEffectBoundary()
  }));
  assert.equal(allowedRead.status, 'completed');
  assert.equal(allowedRead.output.path, 'docs/inside.txt');

  const allowedWrite = await registry.execute(baseInvocation({
    toolId: 'tool:scoped-filesystem',
    toolVersion: '1.0.0',
    operation: 'invoke',
    input: { mode: 'write-inside' },
    idempotencyKey: 'idem_scope_write',
    effectBoundary: createMemoryEffectBoundary()
  }));
  assert.equal(allowedWrite.status, 'completed');
  assert.equal(allowedWrite.output.path, 'docs/created.txt');

  const deniedRead = await registry.execute(baseInvocation({
    toolId: 'tool:scoped-filesystem',
    toolVersion: '1.0.0',
    operation: 'invoke',
    input: { mode: 'read-outside' },
    idempotencyKey: 'idem_scope_read_outside',
    effectBoundary: createMemoryEffectBoundary()
  }));
  assert.equal(deniedRead.status, 'failed');
  assert.equal(deniedRead.error.code, 'tool_filesystem_denied');

  const deniedWrite = await registry.execute(baseInvocation({
    toolId: 'tool:scoped-filesystem',
    toolVersion: '1.0.0',
    operation: 'invoke',
    input: { mode: 'write-outside' },
    idempotencyKey: 'idem_scope_write_outside',
    effectBoundary: createMemoryEffectBoundary()
  }));
  assert.equal(deniedWrite.status, 'failed');
  assert.equal(deniedWrite.error.code, 'tool_filesystem_denied');
});
