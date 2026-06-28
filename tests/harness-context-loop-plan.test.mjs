import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  buildLoopPlan
} from '../packages/harness-context/src/index.mjs';

test('loop plan builds deterministically without executing validation commands', () => {
  const clock = () => '2026-06-26T00:00:00.000Z';
  const contextPack = {
    id: 'ctxpack_demo',
    fingerprint: 'sha256:1111111111111111111111111111111111111111111111111111111111111111'
  };
  const usePlan = {
    id: 'ctxuse_demo',
    fingerprint: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    requiredLocalReads: [
      {
        locator: 'workspace://AGENTS.md',
        role: 'selected_context',
        required: true,
        contentHash: 'sha256:3333333333333333333333333333333333333333333333333333333333333333'
      }
    ]
  };
  const sourceGraph = {
    status: 'available',
    graphFingerprint: 'sha256:4444444444444444444444444444444444444444444444444444444444444444',
    sourceIndexFingerprint: 'sha256:5555555555555555555555555555555555555555555555555555555555555555',
    results: [{ locator: 'workspace://src/auth.ts', contentHash: null }]
  };
  const contextBudget = {
    estimatedDeliveryTokens: 123,
    sourceBodyTokensExcluded: 456,
    deliveryReductionRatio: 0.75,
    basis: 'context-pack-measurement'
  };
  const input = {
    workspaceId: 'ws_loop',
    objective: 'Fix source graph report filtering',
    stopCondition: 'focused tests pass and no unrelated diff',
    nonGoals: ['do not build the UI'],
    validationCommands: ['node --test tests/web-shell.test.mjs'],
    governanceAssertions: [
      { subject: 'auth', predicate: 'token_expiry', probe: { file: 'src/auth.ts', capture: 'TOKEN_EXPIRY_MINUTES\\s*=\\s*(\\d+)', valueTemplate: '$1 minutes' } }
    ],
    changedLocators: ['src/auth.ts'],
    userSelectedFiles: ['notes/handoff.md'],
    contextPack,
    usePlan,
    sourceGraph,
    contextBudget,
    clock
  };

  const first = buildLoopPlan(input);
  const second = buildLoopPlan(input);

  assert.deepEqual(first, second);
  assert.match(first.id, /^loopplan_[a-f0-9]{24}$/);
  assert.match(first.loopPlanFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.sideEffectClass, 'read-only');
  assert.equal(first.approvalRequired, false);
  assert.deepEqual(first.validationCommands, ['node --test tests/web-shell.test.mjs']);
  assert.deepEqual(first.governanceAssertions, input.governanceAssertions);
  assert.equal(first.stopReasons.includes('governance-violation'), true);
  assert.deepEqual(first.contextBudget, contextBudget);
  assert.equal(first.safeguards.commandsExecuted, 0);
  assert.equal(first.safeguards.modelCalls, 0);
  assert.equal(first.safeguards.networkCalls, 0);
  assert.equal(first.safeguards.localFilesWritten, 0);
  assert.equal(first.safeguards.externalWritesEnabled, false);
  assert.equal(first.requiredLocalReads.some((item) => item.locator === 'workspace://AGENTS.md'), true);
  assert.equal(first.requiredLocalReads.some((item) => item.locator === 'workspace://src/auth.ts'), true);
  assert.equal(first.requiredLocalReads.some((item) => item.locator === 'user-selected://notes/handoff.md'), true);
  assert.equal(existsSync('tests/should-not-run-loop-plan.txt'), false);
});

test('loop plan rejects unsafe intent and reference fields', () => {
  assert.throws(() => buildLoopPlan({
    objective: 'fix token=secret-value',
    stopCondition: 'done'
  }), /loop_plan_objective_unsafe/);

  assert.throws(() => buildLoopPlan({
    objective: 'fix report',
    stopCondition: 'read \/Users\/rebel\/private.txt'
  }), /loop_plan_stopCondition_unsafe/);

  assert.throws(() => buildLoopPlan({
    objective: 'fix report',
    stopCondition: 'done',
    changedLocators: ['https://example.com/private.ts']
  }), /changed_context_locator_invalid/);
});

test('loop plan falls back to context-pack reads and normalizes upstream reason codes', () => {
  const plan = buildLoopPlan({
    objective: 'Use context-pack reads',
    stopCondition: 'plan validates',
    contextPack: {
      utility: {
        requiredLocalReads: [
          {
            locator: 'workspace://AGENTS.md',
            role: 'selected_context',
            required: true,
            reasonCodes: ['Selected Context', '9 bad/code']
          }
        ]
      }
    },
    usePlan: { requiredLocalReads: [] },
    clock: () => '2026-06-26T00:00:00.000Z'
  });

  const read = plan.requiredLocalReads.find((item) => item.locator === 'workspace://AGENTS.md');
  assert(read);
  assert.deepEqual(read.reasonCodes, ['reason_9_bad_code', 'selected_context']);
});

test('loop plan CLI is read-only and emits JSON', () => {
  const result = spawnSync(process.execPath, [
    'apps/cli/oaf.mjs',
    'loop',
    'plan',
    '--read-only',
    '--root',
    '.',
    '--workspace-id',
    'ws_loop',
    '--objective',
    'Fix source graph report filtering',
    '--stop-condition',
    'focused tests pass',
    '--validation',
    'node --test tests/web-shell.test.mjs',
    '--changed-locator',
    'apps/web/app.js',
    '--include-file',
    'docs/product/loop-workbench.md',
    '--format',
    'json'
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      OAF_FIXED_NOW: '2026-06-26T00:00:00.000Z'
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.command, 'loop plan');
  assert.equal(plan.workspaceId, 'ws_loop');
  assert.equal(plan.sideEffectClass, 'read-only');
  assert.deepEqual(plan.validationCommands, ['node --test tests/web-shell.test.mjs']);
  assert.equal(plan.contextBudget.basis, 'unestimated');
  assert.equal(plan.safeguards.commandsExecuted, 0);
  assert.equal(plan.safeguards.localFilesWritten, 0);
});
