import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileStateStore } from '../packages/storage/src/file-store.mjs';
import { WorkflowRuntimePort, runProviderSmokeConformance } from '../packages/adapter-contracts/src/index.mjs';
import { EmbeddedWorkflowRuntime } from '../providers/native/workflow-embedded/src/index.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('embedded workflow persists checkpoints and supports cancellation', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oaf-workflow-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const provider = new EmbeddedWorkflowRuntime({ store: new FileStateStore(directory) });
  const report = await runProviderSmokeConformance({ provider, PortClass: WorkflowRuntimePort, providerId: 'provider:native:workflow:embedded', expectedCapabilities: ['workflow.cancel'] });
  assert.equal(report.passed, true);

  const running = provider.start({
    runId: 'run_cancel_test',
    workspaceId: 'ws_local',
    workflowId: 'workflow:test',
    steps: [{ id: 'slow', kind: 'test', timeoutMs: 1000, run: async () => { await wait(200); return 'done'; } }]
  });
  await wait(20);
  const cancellation = await provider.cancel({ runId: 'run_cancel_test', workspaceId: 'ws_local', reason: 'operator stop' });
  assert.equal(cancellation.cancelled, true);
  const result = await running;
  assert.equal(result.status, 'cancelled');
  const record = await provider.get({ runId: 'run_cancel_test', workspaceId: 'ws_local' });
  assert.equal(record.status, 'cancelled');
  assert.ok(record.events.some((event) => event.type === 'run.cancelled'));
  assert.deepEqual(record.events.map((event) => event.sequence), [...record.events.keys()]);
});

test('embedded workflow inspection is workspace scoped', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oaf-workflow-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const provider = new EmbeddedWorkflowRuntime({ store: new FileStateStore(directory) });
  await provider.start({ runId: 'run_scope', workspaceId: 'ws_a', steps: [{ id: 'one', kind: 'test', run: () => ({ ok: true }) }] });
  assert.equal(await provider.get({ runId: 'run_scope', workspaceId: 'ws_b' }), null);
});
