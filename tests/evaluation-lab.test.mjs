import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createEvaluationDataset,
  createEvaluationExperiment,
  promoteTraceToEvaluationCase,
  recordEvaluationReport
} from '../packages/evaluation-lab/src/index.mjs';
import { validateJsonSchema } from '../packages/protocol/src/schema-validator.mjs';

const sha = (char) => `sha256:${char.repeat(64)}`;
const tokenLikeFixture = ['sk', 'abcdefghijklmnopqrstuvwxyz'].join('-');

async function assertValid(schemaPath, value) {
  const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
  const result = validateJsonSchema(schema, value);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
}

test('evaluation lab versions deterministic and model-quality datasets separately', async () => {
  const deterministic = createEvaluationDataset({
    id: 'evalds_context_regression',
    suite: 'deterministic-regression',
    version: '1.0.0',
    owner: 'agent:evaluator',
    sourceRefs: ['evals/context-selection/cases.json'],
    createdAt: '2026-06-20T00:00:00.000Z',
    cases: [{
      id: 'evalcase_required_recall',
      kind: 'context-selection',
      inputFingerprint: sha('1'),
      assertions: ['required_recall', 'distractor_exclusion'],
      tags: ['context', 'deterministic']
    }]
  });
  const modelQuality = createEvaluationDataset({
    id: 'evalds_model_quality_shadow',
    suite: 'model-quality-shadow',
    version: '1.0.0',
    owner: 'agent:evaluator',
    sourceRefs: ['evals/lab/datasets/model-quality-shadow.v1.json'],
    createdAt: '2026-06-20T00:00:00.000Z',
    cases: [{
      id: 'evalcase_model_schema_quality',
      kind: 'model-quality',
      inputFingerprint: sha('2'),
      assertions: ['schema_valid', 'evidence_use'],
      tags: ['model-quality']
    }]
  });

  assert.equal(deterministic.mergeGate, true);
  assert.equal(modelQuality.mergeGate, false);
  assert.match(deterministic.datasetFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(deterministic.datasetFingerprint, modelQuality.datasetFingerprint);
  await assertValid('packages/protocol/schemas/evaluation-dataset.schema.json', deterministic);
  await assertValid('packages/protocol/schemas/evaluation-dataset.schema.json', modelQuality);
});

test('evaluation experiments and reports are regression-gated without blocking shadow suites', async () => {
  const dataset = createEvaluationDataset({
    id: 'evalds_selector_regression',
    suite: 'deterministic-regression',
    version: '1.0.0',
    owner: 'agent:evaluator',
    sourceRefs: ['evals/context-selection/cases.json'],
    createdAt: '2026-06-20T00:00:00.000Z',
    cases: [{ id: 'evalcase_selector_budget', kind: 'context-selection', inputFingerprint: sha('3'), assertions: ['budget'], tags: ['selector'] }]
  });
  const experiment = createEvaluationExperiment({
    id: 'evalexp_selector_policy_v1',
    dataset,
    subject: { kind: 'selector', id: 'context.selection', version: '1.0.0', fingerprint: sha('4') },
    baseline: { id: 'selector-baseline', version: '1.0.0', fingerprint: sha('5') },
    candidate: { id: 'selector-candidate', version: '1.0.1', fingerprint: sha('6') },
    mode: 'deterministic',
    createdAt: '2026-06-20T00:01:00.000Z'
  });
  const report = recordEvaluationReport({
    id: 'evalrep_selector_policy_v1',
    experiment,
    commitSha: '7a7630903d27137a425536b1eee6a40d8b41fd1c',
    runner: { name: 'scripts/run-evals.mjs', version: '1.0.0' },
    versions: { compiler: '1.0.0', prompt: 'none', model: 'deterministic-v1', policy: '1.0.0' },
    results: [{ caseId: 'evalcase_selector_budget', status: 'passed', metrics: { budgetWithinLimit: 1 } }],
    generatedAt: '2026-06-20T00:02:00.000Z'
  });
  const shadowDataset = createEvaluationDataset({
    id: 'evalds_shadow_quality',
    suite: 'model-quality-shadow',
    version: '1.0.0',
    owner: 'agent:evaluator',
    sourceRefs: ['evals/lab/datasets/model-quality-shadow.v1.json'],
    createdAt: '2026-06-20T00:00:00.000Z',
    cases: [{ id: 'evalcase_shadow_quality', kind: 'model-quality', inputFingerprint: sha('7'), assertions: ['calibration'], tags: ['shadow'] }]
  });
  const shadowExperiment = createEvaluationExperiment({
    id: 'evalexp_shadow_quality',
    dataset: shadowDataset,
    subject: { kind: 'model', id: 'provider:native:model:deterministic', version: '1.0.0', fingerprint: sha('8') },
    baseline: { id: 'deterministic-v1', version: '1.0.0', fingerprint: sha('9') },
    candidate: { id: 'ollama-local-explicit', version: 'manual', fingerprint: sha('a') },
    mode: 'model-quality',
    createdAt: '2026-06-20T00:01:00.000Z'
  });
  const shadowReport = recordEvaluationReport({
    id: 'evalrep_shadow_quality',
    experiment: shadowExperiment,
    commitSha: '7a7630903d27137a425536b1eee6a40d8b41fd1c',
    runner: { name: 'manual-shadow', version: '0.0.0' },
    versions: { compiler: '1.0.0', prompt: 'content-intelligence.generate-angles.v1', model: 'explicit-local-only', policy: '1.0.0' },
    results: [{ caseId: 'evalcase_shadow_quality', status: 'failed', metrics: { calibration: 0.4 } }],
    generatedAt: '2026-06-20T00:02:00.000Z'
  });

  assert.equal(report.gateDecision, 'pass');
  assert.equal(report.counts.failed, 0);
  assert.equal(shadowReport.gateDecision, 'shadow_failed_non_blocking');
  assert.equal(shadowReport.mergeGate, false);
  await assertValid('packages/protocol/schemas/evaluation-experiment.schema.json', experiment);
  await assertValid('packages/protocol/schemas/evaluation-report.schema.json', report);
});

test('failed traces promote to sanitized regression cases with provenance review', async () => {
  const promoted = promoteTraceToEvaluationCase({
    id: 'evaltp_failed_model_trace',
    datasetId: 'evalds_context_regression',
    caseId: 'evalcase_promoted_failed_model_trace',
    sourceRunId: 'run_failed_trace',
    createdAt: '2026-06-20T00:03:00.000Z',
    review: {
      reviewedBy: 'usr_eval_reviewer',
      approved: true,
      dataClasses: ['workspace-private'],
      reason: 'Minimal reproduction after private body redaction.'
    },
    trace: {
      events: [{
        type: 'model.requested',
        occurredAt: '2026-06-20T00:00:00.000Z',
        payload: {
          prompt: `Raw prompt with ${tokenLikeFixture} and /Users/rebel/.env`,
          contextBody: 'private source body',
          contextManifestId: 'ctx_safe',
          output: 'raw model output'
        }
      }],
      spans: [{
        name: 'oaf.model.generate',
        attributes: {
          'model.provider': 'provider:native:model:deterministic',
          localPath: '/Users/rebel/project/file.txt',
          token: tokenLikeFixture
        }
      }]
    }
  });
  const serialized = JSON.stringify(promoted);
  assert.match(promoted.originalTraceFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(promoted.case.inputFingerprint, promoted.sanitizedTrace.traceFingerprint);
  assert(!serialized.includes('Raw prompt'));
  assert(!serialized.includes('private source body'));
  assert(!serialized.includes('raw model output'));
  assert(!serialized.includes('/Users/rebel'));
  assert(!serialized.includes(tokenLikeFixture));
  assert.throws(() => promoteTraceToEvaluationCase({
    id: 'evaltp_unreviewed',
    datasetId: 'evalds_context_regression',
    caseId: 'evalcase_unreviewed',
    sourceRunId: 'run_unreviewed',
    createdAt: '2026-06-20T00:03:00.000Z',
    review: { reviewedBy: 'usr_eval_reviewer', approved: false, dataClasses: ['workspace-private'], reason: 'not reviewed' },
    trace: { events: [] }
  }), /classification review/);
  await assertValid('packages/protocol/schemas/evaluation-trace-promotion.schema.json', promoted);
});
