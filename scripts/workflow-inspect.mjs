import {
  DurableSQLiteWorkflowRuntime,
  createDurableSmokeWorkflowRegistry
} from '../providers/native/workflow-durable-sqlite/src/index.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}
const workspaceId = args.get('--workspace');
const runId = args.get('--run');
if (!workspaceId || !runId) {
  console.error('Usage: npm run workflow:inspect -- --workspace ws_local --run run_example');
  process.exit(1);
}
const runtime = new DurableSQLiteWorkflowRuntime({
  dataRoot: process.env.OAF_WORKFLOW_DATA_DIR ?? '.local',
  registry: createDurableSmokeWorkflowRegistry()
});
const run = await runtime.get({ workspaceId, runId });
const history = await runtime.history({ workspaceId, runId, limit: 100 });
runtime.close();
if (!run) {
  console.log(JSON.stringify({ schemaVersion: '1.0.0', workspaceId, runId, found: false }, null, 2));
} else {
  console.log(JSON.stringify({
    schemaVersion: '1.0.0',
    workspaceId,
    runId,
    found: true,
    status: run.status,
    workflowId: run.workflowId,
    workflowVersion: run.workflowVersion,
    eventCount: history.events.length,
    stepStates: Object.fromEntries(Object.entries(run.steps).map(([id, step]) => [id, { status: step.status, attempt: step.attempt }]))
  }, null, 2));
}
