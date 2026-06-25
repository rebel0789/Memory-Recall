import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLoopPlan,
  recordLoopObservation
} from '../packages/harness-context/src/index.mjs';

test('loop observation runs only plan validation commands and records redacted event data', async () => {
  const plan = buildLoopPlan({
    workspaceId: 'ws_loop',
    objective: 'Check loop observation',
    stopCondition: 'validation recorded',
    validationCommands: [
      'node --test tests/web-shell.test.mjs',
      'npm run check'
    ],
    clock: () => '2026-06-26T00:00:00.000Z'
  });
  const events = [];
  const ran = [];

  const observation = await recordLoopObservation({
    loopPlan: plan,
    runId: 'run_loop_observe',
    commandRunner: async (command) => {
      ran.push(command);
      return {
        exitCode: command === 'npm run check' ? 1 : 0,
        stdout: `ok ${command} token=secret-value /Users/rebel/private.txt ${'x'.repeat(1000)}`,
        stderr: command === 'npm run check' ? 'failed but bounded' : '',
        durationMs: 7
      };
    },
    appendEvent: async (event) => events.push(event),
    clock: () => '2026-06-26T00:00:01.000Z'
  });

  assert.deepEqual(ran, plan.validationCommands);
  assert.equal(observation.status, 'failed');
  assert.equal(observation.commands.length, 2);
  assert.equal(observation.commands[0].passed, true);
  assert.equal(observation.commands[1].passed, false);
  assert.match(observation.commands[0].outputHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(observation).includes('secret-value'), false);
  assert.equal(JSON.stringify(observation).includes('/Users/rebel/private.txt'), false);
  assert.equal(observation.commands[0].outputSummary.length <= 320, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'loop.observation_recorded');
  assert.equal(events[0].workspaceId, 'ws_loop');
  assert.equal(events[0].runId, 'run_loop_observe');
  assert.deepEqual(events[0].payload.commandExitCodes, [0, 1]);
  assert.equal(JSON.stringify(events).includes('secret-value'), false);
});

test('loop observation rejects commands not declared in the plan', async () => {
  const plan = buildLoopPlan({
    objective: 'Check loop observation',
    stopCondition: 'validation recorded',
    validationCommands: ['node --test tests/web-shell.test.mjs'],
    clock: () => '2026-06-26T00:00:00.000Z'
  });

  await assert.rejects(recordLoopObservation({
    loopPlan: plan,
    validationCommands: ['npm run ci'],
    commandRunner: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 0 })
  }), /loop_observation_command_not_in_plan/);
});
