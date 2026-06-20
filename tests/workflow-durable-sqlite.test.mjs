import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkflowRuntimePort, runProviderSmokeConformance } from '../packages/adapter-contracts/src/index.mjs';
import {
  DURABLE_SQLITE_WORKFLOW_PROVIDER_ID,
  DurableSQLiteWorkflowRuntime,
  DurableWorkflowHandlerRegistry,
  createDurableSmokeWorkflowDefinition
} from '../providers/native/workflow-durable-sqlite/src/index.mjs';
import { EmbeddedWorkflowRuntime } from '../providers/native/workflow-embedded/src/index.mjs';

function tempDir(t) {
  return mkdtemp(path.join(os.tmpdir(), 'oaf durable sqlite ')).then((directory) => {
    t.after(() => rm(directory, { recursive: true, force: true }));
    return directory;
  });
}

function createRegistry({ effectLog = [], retryState = { failures: 0 } } = {}) {
  const registry = new DurableWorkflowHandlerRegistry();
  registry.register({
    id: 'handler:smoke:activity',
    version: '1.0.0',
    capabilities: ['deterministic.local'],
    run: async ({ stepId, attempt, workflowInput }) => ({ stepId, attempt, objective: workflowInput.objective })
  });
  registry.register({
    id: 'handler:smoke:retry',
    version: '1.0.0',
    capabilities: ['deterministic.local'],
    run: async ({ attempt }) => {
      if (retryState.failures < 1) {
        retryState.failures += 1;
        const error = new Error('planned retry');
        error.code = 'planned_retry';
        error.retryable = true;
        throw error;
      }
      return { attempt, recovered: true };
    }
  });
  registry.register({
    id: 'handler:smoke:effect',
    version: '1.0.0',
    capabilities: ['local.effect-reference'],
    run: async ({ effect, idempotencyKey }) => effect({
      idempotencyKey,
      operationFingerprint: 'sha256:effect-smoke',
      execute: async () => {
        effectLog.push(idempotencyKey);
        return { effectCount: effectLog.length };
      }
    })
  });
  registry.register({
    id: 'handler:smoke:final',
    version: '1.0.0',
    capabilities: ['deterministic.local'],
    run: async ({ priorOutputs }) => ({
      completedSteps: Object.keys(priorOutputs).sort(),
      effectCount: priorOutputs.effect?.effectCount ?? 0
    })
  });
  return registry;
}

test('workflow port exposes additive durable contract while embedded remains honest', async (t) => {
  const directory = await tempDir(t);
  const embedded = new EmbeddedWorkflowRuntime();
  const embeddedReport = await runProviderSmokeConformance({
    provider: embedded,
    PortClass: WorkflowRuntimePort,
    providerId: 'provider:native:workflow:embedded',
    expectedCapabilities: ['workflow.start', 'workflow.cancel']
  });
  assert.equal(embeddedReport.passed, true);
  assert.equal(WorkflowRuntimePort.version, '1.1.0');
  assert.equal((await embedded.health()).details.processRecovery, false);
  assert.equal((await embedded.capabilities()).includes('workflow.process-recovery'), false);

  const runtime = new DurableSQLiteWorkflowRuntime({ dataRoot: directory, registry: createRegistry() });
  const report = await runProviderSmokeConformance({
    provider: runtime,
    PortClass: WorkflowRuntimePort,
    providerId: DURABLE_SQLITE_WORKFLOW_PROVIDER_ID,
    expectedCapabilities: ['workflow.process-recovery', 'workflow.durable-timer', 'workflow.approval-wait', 'workflow.idempotency']
  });
  assert.equal(report.passed, true);
  assert.equal((await runtime.health()).details.integrity, 'ok');
  runtime.close();
});

test('durable definitions are immutable, serializable, and handler references are stable', async (t) => {
  const directory = await tempDir(t);
  const runtime = new DurableSQLiteWorkflowRuntime({ dataRoot: directory, registry: createRegistry() });
  const definition = createDurableSmokeWorkflowDefinition();
  const first = await runtime.registerWorkflow(definition);
  const second = await runtime.registerWorkflow(definition);
  assert.equal(second.fingerprint, first.fingerprint);

  await assert.rejects(
    runtime.registerWorkflow({ ...definition, description: `${definition.description} changed` }),
    /workflow_version_fingerprint_conflict/
  );
  await assert.rejects(
    runtime.registerWorkflow({
      ...definition,
      id: 'workflow:bad-function',
      version: '1.0.0',
      steps: [{ ...definition.steps[0], run: () => ({}) }]
    }),
    /workflow_definition_not_serializable/
  );
  await assert.rejects(
    runtime.start({ workspaceId: 'ws_local', workflowId: definition.id, workflowVersion: definition.version, runId: 'run_missing_handler', input: {}, overrideHandlerId: 'handler:missing' }),
    /handler_not_found/
  );
  runtime.close();
});

test('durable runtime persists timer, retry, approval, cancellation, idempotency, and canonical history', async (t) => {
  const directory = await tempDir(t);
  let now = Date.parse('2026-06-20T00:00:00.000Z');
  const clock = () => new Date(now).toISOString();
  const effectLog = [];
  const runtime = new DurableSQLiteWorkflowRuntime({
    dataRoot: directory,
    registry: createRegistry({ effectLog }),
    clock,
    leaseMs: 50
  });
  const definition = createDurableSmokeWorkflowDefinition();
  await runtime.registerWorkflow(definition);
  const started = await runtime.start({
    workspaceId: 'ws_local',
    workflowId: definition.id,
    workflowVersion: definition.version,
    runId: 'run_durable_smoke',
    input: { objective: 'prove durable workflow' },
    idempotencyKey: 'start-key-1'
  });
  assert.equal(started.status, 'queued');
  assert.equal((await runtime.start({
    workspaceId: 'ws_local',
    workflowId: definition.id,
    workflowVersion: definition.version,
    runId: 'run_durable_smoke',
    input: { objective: 'prove durable workflow' },
    idempotencyKey: 'start-key-1'
  })).runId, 'run_durable_smoke');
  await assert.rejects(
    runtime.start({
      workspaceId: 'ws_local',
      workflowId: definition.id,
      workflowVersion: definition.version,
      runId: 'run_durable_smoke',
      input: { objective: 'changed' },
      idempotencyKey: 'start-key-1'
    }),
    /start_idempotency_conflict/
  );

  await runtime.tick({ workerId: 'worker_a' });
  await runtime.tick({ workerId: 'worker_a' });
  let run = await runtime.get({ workspaceId: 'ws_local', runId: 'run_durable_smoke' });
  assert.equal(run.status, 'waiting_retry');
  assert.equal(run.steps.retry.attempt, 1);

  runtime.close();
  const reopened = new DurableSQLiteWorkflowRuntime({ dataRoot: directory, registry: createRegistry({ effectLog, retryState: { failures: 1 } }), clock, leaseMs: 50 });
  now += 100;
  await reopened.tick({ workerId: 'worker_b' });
  await reopened.tick({ workerId: 'worker_b' });
  run = await reopened.get({ workspaceId: 'ws_local', runId: 'run_durable_smoke' });
  assert.equal(run.status, 'waiting_timer');

  now += 1000;
  await reopened.tick({ workerId: 'worker_b' });
  run = await reopened.get({ workspaceId: 'ws_local', runId: 'run_durable_smoke' });
  assert.equal(run.status, 'waiting_approval');
  const approvalId = run.steps.approval.approvalId;
  await assert.rejects(
    reopened.resolveApproval({ workspaceId: 'ws_local', runId: 'run_durable_smoke', approvalId, actorId: 'usr_reviewer', decision: 'approved', operationFingerprint: 'sha256:edited' }),
    /approval_fingerprint_mismatch/
  );
  await reopened.resolveApproval({ workspaceId: 'ws_local', runId: 'run_durable_smoke', approvalId, actorId: 'usr_reviewer', decision: 'approved', operationFingerprint: 'sha256:approval-smoke' });
  await reopened.tick({ workerId: 'worker_b' });
  await reopened.tick({ workerId: 'worker_b' });
  await reopened.tick({ workerId: 'worker_b' });
  run = await reopened.get({ workspaceId: 'ws_local', runId: 'run_durable_smoke' });
  assert.equal(run.status, 'completed');
  assert.deepEqual(effectLog, ['idem:ws_local:run_durable_smoke:effect']);
  assert.equal((await reopened.get({ workspaceId: 'ws_other', runId: 'run_durable_smoke' })), null);
  assert.equal((await reopened.list({ workspaceId: 'ws_local', limit: 1 })).items.length, 1);
  const history = await reopened.history({ workspaceId: 'ws_local', runId: 'run_durable_smoke' });
  assert.deepEqual(history.events.map((event) => event.sequence), [...history.events.keys()]);
  for (const event of history.events) {
    assert.doesNotMatch(JSON.stringify(event.payload), /secret|\/tmp|SELECT|raw prompt/i);
  }
  assert.ok(history.events.some((event) => event.type === 'run.resumed'));
  assert.ok(history.events.some((event) => event.type === 'timer.scheduled'));
  assert.ok(history.events.some((event) => event.type === 'timer.fired'));
  assert.ok(history.events.some((event) => event.type === 'approval.resolved'));

  const cancelRun = await reopened.start({
    workspaceId: 'ws_local',
    workflowId: definition.id,
    workflowVersion: definition.version,
    runId: 'run_cancel_wait',
    input: { objective: 'cancel while queued' }
  });
  assert.equal(cancelRun.status, 'queued');
  const cancelled = await reopened.cancel({ workspaceId: 'ws_local', runId: 'run_cancel_wait', reason: 'operator stop' });
  assert.equal(cancelled.cancelled, true);
  assert.equal((await reopened.get({ workspaceId: 'ws_local', runId: 'run_cancel_wait' })).status, 'cancelled');
  reopened.close();
});

test('durable leases prevent concurrent execution and stale commits', async (t) => {
  const directory = await tempDir(t);
  let release;
  const registry = new DurableWorkflowHandlerRegistry();
  registry.register({
    id: 'handler:slow',
    version: '1.0.0',
    capabilities: ['deterministic.local'],
    run: async ({ signal }) => {
      await new Promise((resolve, reject) => {
        release = resolve;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      return { ok: true };
    }
  });
  const definition = {
    schemaVersion: '1.0.0',
    id: 'workflow:slow',
    version: '1.0.0',
    name: 'Slow workflow',
    description: 'Slow lease workflow',
    steps: [{
      id: 'slow',
      kind: 'deterministic',
      handler: { id: 'handler:slow', version: '1.0.0' },
      timeoutMs: 500,
      retry: { maxAttempts: 1 },
      approval: { required: false },
      idempotency: { required: false },
      riskClass: 'read-only',
      inputSchema: {},
      outputSchema: {}
    }]
  };
  const first = new DurableSQLiteWorkflowRuntime({ dataRoot: directory, registry, leaseMs: 1000 });
  const second = new DurableSQLiteWorkflowRuntime({ dataRoot: directory, registry, leaseMs: 1000 });
  await first.registerWorkflow(definition);
  await first.start({ workspaceId: 'ws_local', workflowId: definition.id, workflowVersion: definition.version, runId: 'run_lease', input: {} });
  const active = first.tick({ workerId: 'worker_one' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const blocked = await second.tick({ workerId: 'worker_two' });
  assert.equal(blocked.claimed, false);
  await first.cancel({ workspaceId: 'ws_local', runId: 'run_lease', reason: 'operator stop' });
  release();
  await active;
  assert.equal((await first.get({ workspaceId: 'ws_local', runId: 'run_lease' })).status, 'cancelled');
  first.close();
  second.close();
});
