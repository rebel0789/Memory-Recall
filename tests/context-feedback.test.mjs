import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTEXT_SELECTION_POLICY,
  compileContext,
  contextSelectionPolicyFingerprint,
  createDurableContextManifest,
  createSelectorExperiment,
  promoteSelectorDefault,
  recordContextUseFeedback,
  resolveSelectorExperimentPolicy,
  summarizeContextUseFeedback
} from '../packages/context-compiler/src/index.mjs';

const now = '2026-06-20T12:00:00.000Z';

function request(overrides = {}) {
  return {
    schemaVersion: '1.0.0',
    id: 'ctxreq_feedback',
    requestId: 'ctxreq_feedback',
    workspaceId: 'ws_feedback',
    actorId: 'usr_eval',
    taskId: 'task_feedback',
    step: 'answer with feedback evidence',
    objective: 'Explain context feedback',
    requiredIds: ['policy_feedback'],
    requiredEntities: ['context-feedback'],
    allowedScopes: ['workspace-private'],
    allowedDataClasses: ['workspace-private'],
    allowedTrustClasses: ['verified', 'observed'],
    tokenBudget: 80,
    now,
    trustedTimestamp: now,
    ...overrides
  };
}

function records() {
  return [
    {
      id: 'policy_feedback',
      kind: 'policy',
      workspaceId: 'ws_feedback',
      text: 'Context feedback requires selected record use and no causal overclaim.',
      tags: ['context-feedback'],
      relations: ['context-feedback'],
      scope: 'workspace-private',
      dataClass: 'workspace-private',
      trustClass: 'verified',
      status: 'active',
      source: 'test',
      tokens: 12,
      confidence: 1,
      authority: 1,
      outcomeEvidence: 0.7
    },
    {
      id: 'obs_feedback',
      kind: 'observation',
      workspaceId: 'ws_feedback',
      text: 'The selected context record was cited in the final answer.',
      tags: ['context-feedback'],
      relations: ['context-feedback'],
      scope: 'workspace-private',
      dataClass: 'workspace-private',
      trustClass: 'observed',
      status: 'active',
      source: 'test',
      tokens: 10,
      confidence: 0.8,
      authority: 0.7
    }
  ];
}

function manifest() {
  const req = request();
  const compiled = compileContext(req, records());
  return createDurableContextManifest({
    manifest: compiled,
    selection: compiled.selection,
    request: req,
    runId: 'run_feedback',
    createdAt: now
  });
}

test('context-use feedback records selected-record use against a manifest without raw output', () => {
  const compiled = manifest();
  const feedback = recordContextUseFeedback({
    id: 'ctxuse_feedback',
    manifest: compiled,
    runId: 'run_feedback',
    taskId: 'task_feedback',
    actorId: 'usr_eval',
    usedRecords: [
      { recordId: 'policy_feedback', evidenceRefs: ['claim_feedback'], outcomeRefs: ['out_success'] }
    ],
    outcomeReferences: [
      { outcomeId: 'out_success', kind: 'accepted', observedAt: now, metric: 'task_acceptance', direction: 'positive' }
    ],
    createdAt: now
  });

  assert.equal(feedback.contextManifest.id, compiled.id);
  assert.equal(feedback.contextManifest.manifestFingerprint, compiled.manifestFingerprint);
  assert.equal(feedback.contextManifest.selectionPolicyFingerprint, compiled.selectionPolicy.fingerprint);
  assert.equal(feedback.selectedRecordUse.find((item) => item.recordId === 'policy_feedback').useState, 'used');
  assert.equal(feedback.selectedRecordUse.find((item) => item.recordId === 'obs_feedback').useState, 'not_observed');
  assert.equal(feedback.causalClaim, 'none');
  assert.match(feedback.feedbackFingerprint, /^sha256:[a-f0-9]{64}$/);
  const serialized = JSON.stringify(feedback);
  assert(!serialized.includes('final answer'));
  assert(!serialized.includes('/Users/'));
  assert(!serialized.includes('SELECT '));
});

test('context-use feedback rejects unselected records and raw outcome bodies', () => {
  const compiled = manifest();
  assert.throws(
    () => recordContextUseFeedback({
      manifest: compiled,
      runId: 'run_feedback',
      usedRecords: [{ recordId: 'not_selected' }],
      outcomeReferences: [{ outcomeId: 'out_bad', kind: 'accepted', observedAt: now, metric: 'task_acceptance' }],
      createdAt: now
    }),
    /context_use_unselected_record/
  );

  assert.throws(
    () => recordContextUseFeedback({
      manifest: compiled,
      runId: 'run_feedback',
      usedRecords: [],
      outcomeReferences: [{ outcomeId: 'out_raw', kind: 'accepted', observedAt: now, metric: 'task_acceptance', rawOutput: 'private output' }],
      createdAt: now
    }),
    /context_outcome_raw_field/
  );
});

test('feedback summary measures use and outcomes without causal overclaiming', () => {
  const compiled = manifest();
  const one = recordContextUseFeedback({
    manifest: compiled,
    runId: 'run_feedback_a',
    usedRecords: [{ recordId: 'policy_feedback', outcomeRefs: ['out_success'] }],
    outcomeReferences: [{ outcomeId: 'out_success', kind: 'accepted', observedAt: now, metric: 'task_acceptance', direction: 'positive' }],
    createdAt: now
  });
  const two = recordContextUseFeedback({
    manifest: compiled,
    runId: 'run_feedback_b',
    usedRecords: [{ recordId: 'obs_feedback' }],
    outcomeReferences: [{ outcomeId: 'out_revision', kind: 'needs_revision', observedAt: now, metric: 'task_acceptance', direction: 'negative' }],
    createdAt: now
  });

  const summary = summarizeContextUseFeedback([one, two]);
  assert.equal(summary.totalFeedbackRecords, 2);
  assert.equal(summary.recordUse.policy_feedback.usedCount, 1);
  assert.equal(summary.recordUse.obs_feedback.usedCount, 1);
  assert.equal(summary.outcomes.positive, 1);
  assert.equal(summary.outcomes.negative, 1);
  assert.equal(summary.causalClaim, 'none');
});

test('selector experiments are reversible and do not change defaults by assignment alone', () => {
  const variant = {
    ...CONTEXT_SELECTION_POLICY,
    policyVersion: '1.0.1',
    thresholds: { ...CONTEXT_SELECTION_POLICY.thresholds, marginalUtility: 0.25 }
  };
  const experiment = createSelectorExperiment({
    id: 'ctxexp_feedback',
    workspaceId: 'ws_feedback',
    baselinePolicy: CONTEXT_SELECTION_POLICY,
    variantPolicy: variant,
    createdAt: now,
    evaluationReport: {
      reportId: 'eval_feedback_selector',
      passed: true,
      evaluationCount: 4,
      regressionCount: 0,
      metrics: { requiredRecall: 1, contextUseFeedbackCount: 2 },
      rollbackPlan: 'Return to baseline policy fingerprint.'
    }
  });

  assert.equal(experiment.reversible, true);
  assert.equal(resolveSelectorExperimentPolicy(experiment, { arm: 'baseline' }).policyFingerprint, contextSelectionPolicyFingerprint(CONTEXT_SELECTION_POLICY));
  assert.equal(resolveSelectorExperimentPolicy(experiment, { arm: 'variant' }).policyFingerprint, contextSelectionPolicyFingerprint(variant));
  assert.equal(resolveSelectorExperimentPolicy(experiment, { arm: 'rollback' }).policyFingerprint, contextSelectionPolicyFingerprint(CONTEXT_SELECTION_POLICY));
});

test('selector default promotion requires evaluation evidence and returns a reviewable plan', () => {
  const variant = {
    ...CONTEXT_SELECTION_POLICY,
    policyVersion: '1.0.1',
    thresholds: { ...CONTEXT_SELECTION_POLICY.thresholds, minimumUtility: 0.4 }
  };

  assert.throws(
    () => promoteSelectorDefault({ candidatePolicy: variant, evaluationReport: { reportId: 'eval_empty', passed: false } }),
    /selector_default_requires_passing_evaluation/
  );

  const plan = promoteSelectorDefault({
    candidatePolicy: variant,
    evaluationReport: {
      reportId: 'eval_feedback_default',
      passed: true,
      evaluationCount: 5,
      regressionCount: 0,
      metrics: { requiredRecall: 1, contextUseFeedbackCount: 2 },
      rollbackPlan: 'Restore the baseline selector fingerprint.'
    },
    createdAt: now
  });
  assert.equal(plan.status, 'review_required');
  assert.equal(plan.defaultChanged, false);
  assert.equal(plan.requiresHumanApproval, true);
  assert.equal(plan.evaluationReportId, 'eval_feedback_default');
});
