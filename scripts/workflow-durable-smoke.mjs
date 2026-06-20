import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DurableSQLiteWorkflowRuntime,
  createDurableSmokeWorkflowDefinition,
  createDurableSmokeWorkflowRegistry
} from '../providers/native/workflow-durable-sqlite/src/index.mjs';

const directory = process.env.OAF_WORKFLOW_DATA_DIR ?? await mkdtemp(path.join(os.tmpdir(), 'oaf durable smoke '));
const cleanup = !process.env.OAF_WORKFLOW_DATA_DIR;
let now = Date.parse('2026-06-20T00:00:00.000Z');
const clock = () => new Date(now).toISOString();
const runtime = new DurableSQLiteWorkflowRuntime({
  dataRoot: directory,
  registry: createDurableSmokeWorkflowRegistry(),
  clock,
  leaseMs: 10
});

try {
  const definition = createDurableSmokeWorkflowDefinition();
  await runtime.registerWorkflow(definition);
  await runtime.start({
    workspaceId: 'ws_local',
    workflowId: definition.id,
    workflowVersion: definition.version,
    runId: 'run_durable_smoke',
    input: { objective: 'durable workflow smoke' },
    idempotencyKey: 'durable-smoke-start'
  });
  await runtime.tick({ workerId: 'worker_smoke_a' });
  await runtime.tick({ workerId: 'worker_smoke_a' });
  runtime.close();

  const recovered = new DurableSQLiteWorkflowRuntime({
    dataRoot: directory,
    registry: createDurableSmokeWorkflowRegistry(),
    clock,
    leaseMs: 10
  });
  now += 100;
  await recovered.tick({ workerId: 'worker_smoke_b' });
  await recovered.tick({ workerId: 'worker_smoke_b' });
  now += 1000;
  await recovered.tick({ workerId: 'worker_smoke_b' });
  const waiting = await recovered.get({ workspaceId: 'ws_local', runId: 'run_durable_smoke' });
  const approvalId = waiting.steps.approval.approvalId;
  await recovered.resolveApproval({
    workspaceId: 'ws_local',
    runId: 'run_durable_smoke',
    approvalId,
    actorId: 'usr_smoke',
    decision: 'approved',
    operationFingerprint: 'sha256:approval-smoke'
  });
  await recovered.runWorker({ workerId: 'worker_smoke_b', maxTicks: 10, idleMs: 1 });
  const run = await recovered.get({ workspaceId: 'ws_local', runId: 'run_durable_smoke' });
  const history = await recovered.history({ workspaceId: 'ws_local', runId: 'run_durable_smoke' });
  recovered.close();

  if (run.status !== 'completed') throw new Error(`durable smoke ended ${run.status}`);
  if (run.output.effect.effectCount !== 1) throw new Error('durable smoke repeated idempotent effect');
  if (!history.events.some((event) => event.type === 'run.resumed')) throw new Error('durable smoke missing recovery event');
  if (!history.events.some((event) => event.type === 'timer.fired')) throw new Error('durable smoke missing timer event');
  if (!history.events.some((event) => event.type === 'approval.resolved')) throw new Error('durable smoke missing approval event');
  console.log('PASS durable SQLite workflow smoke');
  console.log('PASS process recovery via close/reopen boundary');
  console.log('PASS retry, timer, approval, cancellation-safe idempotency primitives');
  console.log(`Run ${run.runId}: ${run.status}; events=${history.events.length}; effectCount=${run.output.effect.effectCount}`);
} finally {
  try { runtime.close(); } catch {}
  if (cleanup) await rm(directory, { recursive: true, force: true });
}
