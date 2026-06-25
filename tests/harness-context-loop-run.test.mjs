import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DurableSQLiteWorkflowRuntime,
  DurableWorkflowHandlerRegistry
} from '../providers/native/workflow-durable-sqlite/src/index.mjs';
import {
  buildLoopPlan,
  createLoopRunWorkflowDefinition,
  runLoop
} from '../packages/harness-context/src/index.mjs';

function tempDir(t) {
  return mkdtemp(path.join(os.tmpdir(), 'oaf-loop-run-')).then((directory) => {
    t.after(() => rm(directory, { recursive: true, force: true }));
    return directory;
  });
}

function loopPlan({ maxIterations = 3, timeoutSeconds = 60 } = {}) {
  return buildLoopPlan({
    workspaceId: 'ws_loop',
    objective: 'Run a bounded loop',
    stopCondition: 'stop with proof',
    validationCommands: ['npm run check'],
    changedLocators: ['src/auth.ts'],
    contextBudget: {
      estimatedDeliveryTokens: 7,
      sourceBodyTokensExcluded: 11,
      deliveryReductionRatio: 0.5,
      basis: 'context-pack-measurement'
    },
    maxIterations,
    timeoutSeconds,
    clock: () => '2026-06-26T00:00:00.000Z'
  });
}

function registry() {
  const durableRegistry = new DurableWorkflowHandlerRegistry();
  for (const step of createLoopRunWorkflowDefinition().steps.filter((item) => item.handler)) {
    durableRegistry.register({
      id: step.handler.id,
      version: step.handler.version,
      capabilities: ['deterministic.local'],
      run: async ({ stepId }) => ({ stepId })
    });
  }
  return durableRegistry;
}

test('loop run bounds iterations, timeout, durable resume, budget, and human gate', async (t) => {
  const validationStop = await runLoop({
    loopPlan: loopPlan(),
    runId: 'run_loop_validation',
    verificationRunner: async () => ({ id: 'loopverify_failed', status: 'blocked', stopReason: 'validation_failed' }),
    clock: () => '2026-06-26T00:00:01.000Z'
  });
  assert.equal(validationStop.status, 'blocked');
  assert.equal(validationStop.stopReason, 'validation_failed');
  assert.equal(validationStop.iterations.length, 1);
  assert.equal(validationStop.tokenBudget.aggregatedEstimatedDeliveryTokens, 7);

  let attempts = 0;
  const maxed = await runLoop({
    loopPlan: loopPlan({ maxIterations: 2 }),
    runId: 'run_loop_max',
    terminalStopReasons: ['completed'],
    verificationRunner: async () => {
      attempts += 1;
      return { id: `loopverify_${attempts}`, status: 'blocked', stopReason: 'validation_failed' };
    },
    clock: () => '2026-06-26T00:00:02.000Z'
  });
  assert.equal(maxed.stopReason, 'max_iterations');
  assert.equal(maxed.iterations.length, 2);
  assert.equal(maxed.tokenBudget.aggregatedEstimatedDeliveryTokens, 14);

  const timedOut = await runLoop({
    loopPlan: loopPlan(),
    runId: 'run_loop_timeout',
    timeoutMs: 0,
    verificationRunner: async () => {
      throw new Error('should not run after timeout');
    },
    clock: () => '2026-06-26T00:00:03.000Z'
  });
  assert.equal(timedOut.stopReason, 'timeout');

  const gated = await runLoop({
    loopPlan: loopPlan(),
    runId: 'run_loop_gate',
    humanApprovalRequired: true,
    verificationRunner: async () => {
      throw new Error('human gate should stop before action');
    },
    clock: () => '2026-06-26T00:00:04.000Z'
  });
  assert.equal(gated.stopReason, 'blocked_needs_human');
  assert.equal(gated.safeguards.humanApprovalGateEnforced, true);

  const directory = await tempDir(t);
  let now = Date.parse('2026-06-26T00:00:00.000Z');
  const clock = () => new Date(now).toISOString();
  const firstRuntime = new DurableSQLiteWorkflowRuntime({ dataRoot: directory, registry: registry(), clock, leaseMs: 10 });
  await runLoop({
    loopPlan: loopPlan(),
    runId: 'run_loop_durable',
    durableRuntime: firstRuntime,
    workflowTicks: 1,
    verificationRunner: async () => ({ id: 'loopverify_ok', status: 'proposed', stopReason: 'completed' }),
    clock
  });
  firstRuntime.close();
  now += 20;

  const reopened = new DurableSQLiteWorkflowRuntime({ dataRoot: directory, registry: registry(), clock, leaseMs: 10 });
  const resumed = await runLoop({
    loopPlan: loopPlan(),
    runId: 'run_loop_durable',
    durableRuntime: reopened,
    workflowTicks: 10,
    verificationRunner: async () => ({ id: 'loopverify_ok', status: 'proposed', stopReason: 'completed' }),
    clock
  });
  assert.equal(resumed.durable.status, 'completed');
  assert.equal(resumed.durable.resumed, true);
  assert.equal(resumed.runLog.eventTypes.includes('run.resumed'), true);
  reopened.close();
});
