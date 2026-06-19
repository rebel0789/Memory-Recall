import test from 'node:test';
import assert from 'node:assert/strict';
import { compareRunRecords, createLearningProposal, createReplayPlan } from '../packages/replay/src/index.mjs';

test('replay plans disable side effects and approvals', () => {
  const plan = createReplayPlan({ workspaceId: 'ws_local', sourceRunId: 'run_1', mode: 'shadow', reason: 'compare compiler versions' });
  assert.equal(plan.sideEffects, 'disabled');
  assert.equal(plan.approvalsReusable, false);
  assert.match(plan.fingerprint, /^sha256:/);
  assert.throws(() => createReplayPlan({ workspaceId: 'ws_local', sourceRunId: 'run_1', mode: 'exact', reason: 'unsafe', sideEffects: 'enabled' }), /disabled/);
});

test('replay modes require explicit overrides', () => {
  assert.throws(() => createReplayPlan({ workspaceId: 'ws_local', sourceRunId: 'run_1', mode: 'alternate-model', reason: 'test' }), /modelOverrides/);
  assert.throws(() => createReplayPlan({ workspaceId: 'ws_local', sourceRunId: 'run_1', mode: 'alternate-context', reason: 'test' }), /contextPolicyOverride/);
  assert.throws(() => createReplayPlan({ workspaceId: 'ws_local', sourceRunId: 'run_1', mode: 'fork-from-step', reason: 'test' }), /forkStepId/);
});

test('run comparison surfaces context and artifact differences', () => {
  const comparison = compareRunRecords(
    { id: 'run_a', status: 'completed', contextManifest: { selected: [{ id: 'mem_a' }], excluded: [{ id: 'mem_x' }], budget: { used: 100 } }, events: [{ type: 'run.started' }], artifacts: [{ hash: 'aaa' }] },
    { id: 'run_b', status: 'completed', contextManifest: { selected: [{ id: 'mem_b' }], excluded: [{ id: 'mem_x' }], budget: { used: 80 } }, events: [{ type: 'run.started' }], artifacts: [{ hash: 'bbb' }] }
  );
  assert.deepEqual(comparison.context.selected, { added: ['mem_b'], removed: ['mem_a'] });
  assert.equal(comparison.context.tokenDelta, -20);
  assert.deepEqual(comparison.artifacts, { added: ['bbb'], removed: ['aaa'] });
});

test('learning proposals require evidence, tests, and rollback', () => {
  const proposal = createLearningProposal({
    workspaceId: 'ws_local',
    observedFailure: 'The compiler selected a stale preference.',
    evidenceIds: ['evt_2', 'evt_1'],
    proposedChange: { type: 'context-policy', patch: { temporalWeight: 1.4 } },
    expectedBenefit: 'Reduce stale preference selection.',
    affectedComponents: ['context-compiler'],
    regressionTests: ['eval:stale-preference'],
    rollout: 'Shadow mode for 100 recorded runs.',
    rollback: 'Restore context policy v1.'
  });
  assert.equal(proposal.status, 'proposed');
  assert.deepEqual(proposal.evidenceIds, ['evt_1', 'evt_2']);
  assert.throws(() => createLearningProposal({ workspaceId: 'ws_local' }), /observedFailure/);
});
