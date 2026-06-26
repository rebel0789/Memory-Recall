import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildLoopPlan } from '../packages/harness-context/src/index.mjs';

function cli(args, cwd = process.cwd()) {
  return spawnSync(process.execPath, ['apps/cli/oaf.mjs', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, OAF_FIXED_NOW: '2026-06-26T00:00:00.000Z' }
  });
}

function writePlan(root, validationCommands) {
  const plan = buildLoopPlan({
    objective: 'Exercise loop CLI command gate',
    stopCondition: 'commands are gated',
    validationCommands,
    clock: () => '2026-06-26T00:00:00.000Z'
  });
  writeFileSync(path.join(root, 'loop-plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
}

function fixtureRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaf-loop-cli-'));
  mkdirSync(path.join(root, 'tests'), { recursive: true });
  writeFileSync(path.join(root, 'tests', 'pass.test.mjs'), "import test from 'node:test';\ntest('pass', () => {});\n");
  execFileSync('git', ['-C', root, 'init'], { encoding: 'utf8' });
  execFileSync('git', ['-C', root, 'add', '.'], { encoding: 'utf8' });
  execFileSync('git', ['-C', root, '-c', 'user.name=OAF', '-c', 'user.email=oaf@example.invalid', 'commit', '-m', 'initial'], { encoding: 'utf8' });
  return root;
}

test('loop CLI gates command execution and rejects unsafe invocation modes', () => {
  const root = fixtureRepo();
  writePlan(root, ['node --test tests/pass.test.mjs']);

  const observeNoOptIn = cli(['loop', 'observe', '--root', root, '--plan', 'loop-plan.json', '--format', 'json']);
  assert.equal(observeNoOptIn.status, 2);
  assert.match(observeNoOptIn.stderr, /loop_observation_command_execution_not_enabled/);

  const observeReadOnly = cli(['loop', 'observe', '--read-only', '--root', root, '--plan', 'loop-plan.json', '--format', 'json']);
  assert.equal(observeReadOnly.status, 2);
  assert.match(observeReadOnly.stderr, /unsupported option: --read-only/);

  const observeAllowed = cli(['loop', 'observe', '--root', root, '--plan', 'loop-plan.json', '--execute-commands', '--format', 'json']);
  assert.equal(observeAllowed.status, 0, observeAllowed.stderr);
  assert.equal(JSON.parse(observeAllowed.stdout).status, 'passed');

  const verifyNoOptIn = cli(['loop', 'verify', '--root', root, '--plan', 'loop-plan.json', '--worktree', root, '--format', 'json']);
  assert.equal(verifyNoOptIn.status, 2);
  assert.match(verifyNoOptIn.stderr, /loop_observation_command_execution_not_enabled/);

  const runNoOptIn = cli(['loop', 'run', '--root', root, '--plan', 'loop-plan.json', '--worktree', root, '--format', 'json']);
  assert.equal(runNoOptIn.status, 2);
  assert.match(runNoOptIn.stderr, /loop_observation_command_execution_not_enabled/);

  writePlan(root, ['node -e "console.log(1)"']);
  const arbitrary = cli(['loop', 'observe', '--root', root, '--plan', 'loop-plan.json', '--execute-commands', '--format', 'json']);
  assert.equal(arbitrary.status, 2);
  assert.match(arbitrary.stderr, /loop_observation_command_not_allowed/);

  const scheduledWrite = cli(['loop', 'schedule', '--read-only', '--root', root, '--plan', 'loop-plan.json', '--write', '--format', 'json']);
  assert.equal(scheduledWrite.status, 2);
  assert.match(scheduledWrite.stderr, /does not merge|opt-in prompt/);

  const scheduledMerge = cli(['loop', 'schedule', '--read-only', '--root', root, '--plan', 'loop-plan.json', '--merge', '--format', 'json']);
  assert.equal(scheduledMerge.status, 2);
  assert.match(scheduledMerge.stderr, /does not merge|opt-in prompt/);
});
