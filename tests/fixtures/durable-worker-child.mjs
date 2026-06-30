import {
  DurableSQLiteWorkflowRuntime,
  createDurableSmokeWorkflowDefinition,
  createDurableSmokeWorkflowRegistry
} from '../../providers/native/workflow-durable-sqlite/src/index.mjs';

const dataRoot = process.env.OAF_DURABLE_DATA_ROOT;
const effectFile = process.env.OAF_DURABLE_EFFECT_FILE;
const runId = process.env.OAF_DURABLE_RUN_ID ?? 'run_process_kill';
const registry = createDurableSmokeWorkflowRegistry({
  effectFile,
  afterEffect: async () => {
    if (process.send) process.send({ type: 'effect-committed' });
    await new Promise(() => {});
  }
});
const runtime = new DurableSQLiteWorkflowRuntime({ dataRoot, registry, leaseMs: 10 });
await runtime.registerWorkflow(createDurableSmokeWorkflowDefinition({ includeWaits: false }));
await runtime.start({
  workspaceId: 'ws_local',
  workflowId: 'workflow:durable-smoke',
  workflowVersion: '1.0.0',
  runId,
  input: { objective: 'process kill recovery' },
  idempotencyKey: 'process-kill-start'
});
await runtime.runWorker({ workerId: 'worker_child', once: false, idleMs: 1 });
