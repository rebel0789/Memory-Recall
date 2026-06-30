import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DurableSQLiteWorkflowRuntime,
  createDurableSmokeWorkflowDefinition,
  createDurableSmokeWorkflowRegistry
} from '../providers/native/workflow-durable-sqlite/src/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const childScript = path.join(here, 'fixtures', 'durable-worker-child.mjs');

function waitForMessage(child, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for child marker')), 5000);
    child.on('message', (message) => {
      if (predicate(message)) {
        clearTimeout(timer);
        resolve(message);
      }
    });
    child.on('exit', (code, signal) => {
      if (code && code !== 0) {
        clearTimeout(timer);
        reject(new Error(`child exited early code=${code} signal=${signal}`));
      }
    });
  });
}

test('durable workflow recovers after a real killed child process without repeating committed effect', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oaf durable crash '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const effectFile = path.join(directory, 'effect-count.json');
  const env = {
    ...process.env,
    OAF_DURABLE_DATA_ROOT: directory,
    OAF_DURABLE_EFFECT_FILE: effectFile,
    OAF_DURABLE_RUN_ID: 'run_process_kill',
    OAF_DURABLE_WORKER_MODE: 'kill-after-effect'
  };
  const child = fork(childScript, [], { env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  await waitForMessage(child, (message) => message?.type === 'effect-committed');
  child.kill(process.platform === 'win32' ? 'SIGTERM' : 'SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));

  const registry = createDurableSmokeWorkflowRegistry({ effectFile });
  const runtime = new DurableSQLiteWorkflowRuntime({ dataRoot: directory, registry, leaseMs: 10 });
  await runtime.registerWorkflow(createDurableSmokeWorkflowDefinition({ includeWaits: false }));
  await runtime.runWorker({ workerId: 'worker_recovery', once: false, idleMs: 1, maxTicks: 20 });
  const run = await runtime.get({ workspaceId: 'ws_local', runId: 'run_process_kill' });
  const effectRecord = JSON.parse(await readFile(effectFile, 'utf8'));
  const history = await runtime.history({ workspaceId: 'ws_local', runId: 'run_process_kill' });
  runtime.close();

  assert.equal(run.status, 'completed');
  assert.equal(effectRecord.count, 1);
  assert.ok(history.events.some((event) => event.type === 'run.resumed'));
  assert.deepEqual(history.events.map((event) => event.sequence), [...history.events.keys()]);
  assert.equal(history.events.filter((event) => event.type === 'step.completed' && event.payload.stepId === 'effect').length, 1);
});
