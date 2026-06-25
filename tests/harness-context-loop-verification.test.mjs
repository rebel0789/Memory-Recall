import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildLoopPlan,
  runLoopVerification
} from '../packages/harness-context/src/index.mjs';

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
}

function fixtureRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaf-loop-verify-'));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'auth.ts'), 'export const value = 1;\n');
  git(root, ['init']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=OAF', '-c', 'user.email=oaf@example.invalid', 'commit', '-m', 'initial']);
  return root;
}

test('loop verification checks validation and blocks unrelated worktree diffs without auto-merge', async () => {
  const root = fixtureRepo();
  const initialBranch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const plan = buildLoopPlan({
    workspaceId: 'ws_loop',
    objective: 'Change auth safely',
    stopCondition: 'validation passes',
    validationCommands: ['npm run check'],
    changedLocators: ['src/auth.ts'],
    clock: () => '2026-06-26T00:00:00.000Z'
  });
  const events = [];

  const report = await runLoopVerification({
    loopPlan: plan,
    runId: 'run_loop_verify',
    worktreePath: root,
    implementer: async ({ worktreePath }) => {
      writeFileSync(path.join(worktreePath, 'src', 'auth.ts'), 'export const value = 2;\n');
      writeFileSync(path.join(worktreePath, 'README.md'), 'unrelated\n');
    },
    commandRunner: async () => ({ exitCode: 0, stdout: 'ok token=secret-value /Users/rebel/private.txt', stderr: '', durationMs: 5 }),
    appendEvent: async (event) => events.push(event),
    clock: () => '2026-06-26T00:00:01.000Z'
  });

  assert.equal(report.status, 'blocked');
  assert.equal(report.scope.status, 'blocked');
  assert.deepEqual(report.scope.unrelatedLocators, ['workspace://README.md']);
  assert.equal(report.proposal.status, 'blocked');
  assert.equal(report.proposal.autoMerge, false);
  assert.equal(report.proposal.approvalRequired, true);
  assert.equal(report.checker.observation.status, 'passed');
  assert.equal(events.some((event) => event.type === 'loop.implementer_completed'), true);
  assert.equal(events.some((event) => event.type === 'loop.checker_completed'), true);
  assert.equal(events.some((event) => event.type === 'loop.verification_reported'), true);
  assert.equal(JSON.stringify(report).includes('secret-value'), false);
  assert.equal(JSON.stringify(report).includes('/Users/rebel/private.txt'), false);
  assert.equal(git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), initialBranch);
});

test('loop verification replay mode disables implementer and checker side effects', async () => {
  const root = fixtureRepo();
  const plan = buildLoopPlan({
    objective: 'Replay safely',
    stopCondition: 'no side effects',
    validationCommands: ['npm run check'],
    changedLocators: ['src/auth.ts'],
    clock: () => '2026-06-26T00:00:00.000Z'
  });
  let implementerCalled = false;
  let checkerCalled = false;

  const report = await runLoopVerification({
    loopPlan: plan,
    runId: 'run_loop_replay',
    worktreePath: root,
    replayMode: true,
    implementer: async () => { implementerCalled = true; },
    commandRunner: async () => {
      checkerCalled = true;
      return { exitCode: 0, stdout: '', stderr: '', durationMs: 0 };
    },
    clock: () => '2026-06-26T00:00:01.000Z'
  });

  assert.equal(implementerCalled, false);
  assert.equal(checkerCalled, false);
  assert.equal(report.status, 'blocked');
  assert.equal(report.stopReason, 'blocked_needs_human');
  assert.equal(report.replay.sideEffects, 'disabled');
  assert.equal(report.replay.approvalsReusable, false);
  assert.equal(report.safeguards.replaySideEffectsDisabled, true);
});
