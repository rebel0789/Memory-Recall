import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DurableSQLiteWorkflowRuntime,
  DurableWorkflowHandlerRegistry
} from '../providers/native/workflow-durable-sqlite/src/index.mjs';
import { ToolRegistry } from '../packages/tool-registry/src/index.mjs';

const fixedNow = '2026-06-20T00:00:00.000Z';

test('durable tool workflow obtains fresh grants after retry while committed local effect remains one', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oaf durable tool '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspaceRoot = path.join(directory, 'workspace with spaces');
  const events = [];
  const grants = [];
  let attempts = 0;
  const toolRegistry = ToolRegistry.createForTests({
    tools: ['tool:workspace-write'],
    workspaceRoot,
    eventSink: async (event) => {
      events.push(event);
      if (event.type === 'tool.authorized') grants.push(event.payload.grantId);
    },
    clock: () => fixedNow
  });
  const trustedContext = {
    principal: { userId: 'usr_tool', principalType: 'agent', authenticationMethod: 'session', status: 'active', agentRole: 'agent:security-auditor' },
    membership: { workspaceId: 'ws_tool', role: 'builder', status: 'active' },
    environment: { deploymentProfile: 'local-dev', locality: 'local-only', interactive: true, externalWritesEnabled: false }
  };
  const handlers = new DurableWorkflowHandlerRegistry();
  handlers.register({
    id: 'handler:tool-write',
    version: '1.0.0',
    capabilities: ['tool.bounded-execution'],
    run: async ({ effect, signal }) => {
      attempts += 1;
      const result = await toolRegistry.execute({
        schemaVersion: '1.0.0',
        requestId: `toolreq_durable_${attempts}`,
        correlationId: 'req_tool-durable-000000',
        workspaceId: 'ws_tool',
        runId: 'run_durable_tool',
        stepId: 'step_tool_write',
        actorId: 'usr_tool',
        trustedContext,
        toolId: 'tool:workspace-write',
        toolVersion: '1.0.0',
        operation: 'writeFile',
        input: { path: 'out/result.txt', content: 'durable write' },
        dataClass: 'workspace-private',
        idempotencyKey: 'idem_durable_tool_write',
        effectBoundary: { effect },
        trustedTimestamp: fixedNow,
        signal
      });
      if (result.status !== 'completed') throw new Error(result.error.code);
      if (attempts === 1) {
        const error = new Error('retry after committed effect');
        error.code = 'planned_retry';
        error.retryable = true;
        throw error;
      }
      return result.output;
    }
  });

  const definition = {
    schemaVersion: '1.0.0',
    id: 'workflow:durable-tool',
    version: '1.0.0',
    name: 'Durable tool workflow',
    description: 'Proves fresh grants and OAF-014 effect reconciliation.',
    steps: [{
      id: 'tool-write',
      kind: 'activity',
      handler: { id: 'handler:tool-write', version: '1.0.0' },
      timeoutMs: 1000,
      retry: { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 10 },
      approval: { required: false },
      idempotency: { required: false },
      riskClass: 'reversible-write',
      inputSchema: {},
      outputSchema: {}
    }]
  };
  let now = Date.parse(fixedNow);
  const runtime = new DurableSQLiteWorkflowRuntime({ dataRoot: directory, registry: handlers, clock: () => new Date(now).toISOString(), leaseMs: 10 });
  await runtime.registerWorkflow(definition);
  await runtime.start({ workspaceId: 'ws_tool', workflowId: definition.id, workflowVersion: definition.version, runId: 'run_durable_tool', input: {} });
  await runtime.tick({ workerId: 'worker_a' });
  runtime.close();

  const reopened = new DurableSQLiteWorkflowRuntime({ dataRoot: directory, registry: handlers, clock: () => new Date(now).toISOString(), leaseMs: 10 });
  now += 20;
  await reopened.runWorker({ workerId: 'worker_b', maxTicks: 5, idleMs: 1 });
  const run = await reopened.get({ workspaceId: 'ws_tool', runId: 'run_durable_tool' });
  const history = await reopened.history({ workspaceId: 'ws_tool', runId: 'run_durable_tool' });
  reopened.close();

  assert.equal(run.status, 'completed');
  assert.equal(await readFile(path.join(workspaceRoot, 'out', 'result.txt'), 'utf8'), 'durable write');
  assert.equal(attempts, 2);
  assert.equal(new Set(grants).size, 2);
  assert.equal(events.filter((event) => event.type === 'tool.completed').length, 2);
  assert.equal(events.some((event) => JSON.stringify(event).includes('durable write')), false);
  assert.deepEqual(history.events.map((event) => event.sequence), [...history.events.keys()]);
  assert.equal(history.events.filter((event) => event.type === 'step.completed' && event.payload.stepId === 'tool-write').length, 1);
});
