import {
  DurableSQLiteWorkflowRuntime,
  createDurableSmokeWorkflowDefinition,
  createDurableSmokeWorkflowRegistry
} from '../providers/native/workflow-durable-sqlite/src/index.mjs';

const dataRoot = process.env.OAF_WORKFLOW_DATA_DIR ?? '.local';
const runtime = new DurableSQLiteWorkflowRuntime({
  dataRoot,
  registry: createDurableSmokeWorkflowRegistry()
});
const controller = new AbortController();
process.once('SIGINT', () => controller.abort(new Error('SIGINT')));
process.once('SIGTERM', () => controller.abort(new Error('SIGTERM')));
await runtime.registerWorkflow(createDurableSmokeWorkflowDefinition());
const result = await runtime.runWorker({
  workerId: process.env.OAF_WORKFLOW_WORKER_ID ?? 'worker_local',
  signal: controller.signal,
  idleMs: 50,
  maxTicks: Number(process.env.OAF_WORKFLOW_MAX_TICKS ?? 1)
});
runtime.close();
console.log(`Workflow worker stopped after ${result.ticks} tick(s).`);
