import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as evaluationLab from '../packages/evaluation-lab/src/index.mjs';
import { validateJsonSchema } from '../packages/protocol/src/schema-validator.mjs';

const FIXED_TIME = '2026-06-23T00:00:00.000Z';
const sha = (char) => `sha256:${char.repeat(64)}`;

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function assertValid(schemaPath, instancePath) {
  const schema = await readJson(schemaPath);
  const instance = await readJson(instancePath);
  const result = validateJsonSchema(schema, instance);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
}

function benchmarkInput(overrides = {}) {
  return {
    id: 'evalds_benchmark_truth_floor',
    suite: 'benchmark-truth-floor',
    version: '1.0.0',
    owner: 'agent:evaluator',
    sourceRefs: ['evals/benchmark-truth-floor/cases.v1.json'],
    createdAt: FIXED_TIME,
    thresholds: {
      requiredEvidenceRecall: 1,
      distractorExclusionRate: 0.9,
      selectedTokenRatioMax: 0.7,
      deterministicMismatchCount: 0
    },
    cases: [
      {
        id: 'evalcase_benchmark_auth_incident',
        workspaceId: 'ws_benchmark',
        question: 'Which local-first auth incident evidence should be selected?',
        objective: 'auth incident token reset local-first evidence',
        step: 'select gold auth incident evidence and exclude noisy or secret records',
        expectedAnswer: 'Use the policy and runbook evidence, exclude noise and secret material.',
        abstainWhenMissing: true,
        tokenBudget: 160,
        requiredEntities: ['topic:auth', 'topic:incident'],
        requiredEvidenceIds: ['ev_auth_policy', 'ev_auth_runbook'],
        distractorIds: ['ev_marketing_noise'],
        forbiddenIds: ['ev_secret_credentials', 'ev_other_workspace'],
        records: [
          {
            id: 'ev_auth_policy',
            version: '1.0.0',
            kind: 'policy',
            workspaceId: 'ws_benchmark',
            text: 'Auth incident policy requires local-first evidence before a token reset.',
            tags: ['topic:auth', 'topic:incident'],
            relations: ['topic:auth'],
            scope: 'workspace-private',
            dataClass: 'workspace-private',
            trustClass: 'verified',
            status: 'active',
            source: 'fixture',
            tokens: 16,
            confidence: 1,
            authority: 1,
            updatedAt: FIXED_TIME,
            contentHash: sha('1')
          },
          {
            id: 'ev_auth_runbook',
            version: '1.0.0',
            kind: 'procedure',
            workspaceId: 'ws_benchmark',
            text: 'Auth incident runbook links token reset approval to verified audit evidence.',
            tags: ['topic:auth', 'topic:incident'],
            relations: ['topic:incident'],
            scope: 'workspace-private',
            dataClass: 'workspace-private',
            trustClass: 'verified',
            status: 'active',
            source: 'fixture',
            tokens: 18,
            confidence: 0.94,
            authority: 0.9,
            updatedAt: FIXED_TIME,
            contentHash: sha('2')
          },
          {
            id: 'ev_marketing_noise',
            version: '1.0.0',
            kind: 'observation',
            workspaceId: 'ws_benchmark',
            text: 'Marketing launch copy about colorful onboarding screens and unrelated announcements.',
            tags: ['topic:marketing'],
            relations: ['topic:marketing'],
            scope: 'workspace-private',
            dataClass: 'workspace-private',
            trustClass: 'observed',
            status: 'active',
            source: 'fixture',
            tokens: 80,
            confidence: 0.5,
            authority: 0.1,
            updatedAt: FIXED_TIME,
            contentHash: sha('3')
          },
          {
            id: 'ev_secret_credentials',
            version: '1.0.0',
            kind: 'observation',
            workspaceId: 'ws_benchmark',
            text: 'credential-sentinel-value and /Users/rebel/private/auth.txt must never leak.',
            tags: ['topic:auth'],
            relations: ['topic:auth'],
            scope: 'workspace-private',
            dataClass: 'secret',
            trustClass: 'verified',
            status: 'active',
            source: 'fixture',
            tokens: 12,
            confidence: 1,
            authority: 1,
            updatedAt: FIXED_TIME,
            contentHash: sha('4')
          },
          {
            id: 'ev_other_workspace',
            version: '1.0.0',
            kind: 'policy',
            workspaceId: 'ws_other',
            text: 'Other workspace auth policy must not cross the workspace boundary.',
            tags: ['topic:auth'],
            relations: ['topic:auth'],
            scope: 'workspace-private',
            dataClass: 'workspace-private',
            trustClass: 'verified',
            status: 'active',
            source: 'fixture',
            tokens: 14,
            confidence: 1,
            authority: 1,
            updatedAt: FIXED_TIME,
            contentHash: sha('5')
          }
        ],
        harnessContext: {
          harnesses: ['codex', 'claude-code'],
          files: [
            {
              path: 'AGENTS.md',
              body: 'Auth incident local-first evidence: select the policy and runbook locators, not credentials.'
            },
            {
              path: 'CLAUDE.md',
              body: 'Marketing launch copy and unrelated onboarding notes. '.repeat(30)
            },
            {
              path: '.codex/private.md',
              body: 'credential-sentinel-value\n/Users/rebel/private/auth.txt'
            }
          ],
          expect: {
            selectedLocators: ['workspace://AGENTS.md'],
            excludedLocators: ['workspace://CLAUDE.md', 'workspace://.codex/private.md'],
            forbiddenStrings: ['Auth incident local-first evidence', 'credential-sentinel-value', '/Users/rebel/private/auth.txt']
          }
        }
      }
    ],
    ...overrides
  };
}

test('benchmark truth-floor protocol fixtures validate and reject raw bodies', async () => {
  await assertValid('packages/protocol/schemas/benchmark-dataset.schema.json', 'examples/protocol/benchmark-dataset.json');
  await assertValid('packages/protocol/schemas/benchmark-phase-artifact.schema.json', 'examples/protocol/benchmark-phase-artifact.json');
  await assertValid('packages/protocol/schemas/benchmark-comparison-report.schema.json', 'examples/protocol/benchmark-comparison-report.json');

  const schema = await readJson('packages/protocol/schemas/benchmark-comparison-report.schema.json');
  const invalid = await readJson('examples/protocol/compatibility/invalid/benchmark-comparison-report-raw-body.json');
  const result = validateJsonSchema(schema, invalid);
  assert.equal(result.valid, false);
  assert(result.errors.some((error) => error.keyword === 'additionalProperties' || error.keyword === 'required'));
});

test('benchmark dataset creation is deterministic and rejects ambiguous gold evidence', () => {
  assert.equal(typeof evaluationLab.createBenchmarkDataset, 'function');
  const first = evaluationLab.createBenchmarkDataset(benchmarkInput());
  const second = evaluationLab.createBenchmarkDataset(benchmarkInput());

  assert.equal(first.mergeGate, true);
  assert.match(first.datasetFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.datasetFingerprint, second.datasetFingerprint);
  assert.throws(() => evaluationLab.createBenchmarkDataset(benchmarkInput({
    cases: [{
      ...benchmarkInput().cases[0],
      distractorIds: ['ev_auth_policy']
    }]
  })), /overlap/i);
});

test('benchmark truth floor compares native baselines without leaking raw context', async () => {
  assert.equal(typeof evaluationLab.runBenchmarkTruthFloor, 'function');
  const dataset = evaluationLab.createBenchmarkDataset(benchmarkInput());
  const report = await evaluationLab.runBenchmarkTruthFloor(dataset, {
    clock: () => FIXED_TIME,
    commitSha: '7a7630903d27137a425536b1eee6a40d8b41fd1c',
    runner: { name: 'tests/benchmark-truth-floor.test.mjs', version: '1.0.0' },
    subject: { kind: 'context-benchmark', id: 'native-context-baselines', version: '1.0.0', fingerprint: sha('a') }
  });
  const rerun = await evaluationLab.runBenchmarkTruthFloor(dataset, {
    clock: () => FIXED_TIME,
    commitSha: '7a7630903d27137a425536b1eee6a40d8b41fd1c',
    runner: { name: 'tests/benchmark-truth-floor.test.mjs', version: '1.0.0' },
    subject: { kind: 'context-benchmark', id: 'native-context-baselines', version: '1.0.0', fingerprint: sha('a') }
  });

  assert.deepEqual(report.baselines.map((item) => item.name).sort(), ['current-harness', 'exact', 'full', 'lexical']);
  assert.equal(report.gateDecision, 'pass');
  assert.equal(report.metrics.requiredEvidenceRecall, 1);
  assert.equal(report.metrics.distractorExclusionRate, 1);
  assert.equal(report.metrics.secretLeakageCount, 0);
  assert.equal(report.metrics.localPathLeakageCount, 0);
  assert.equal(report.metrics.rawPromptLeakageCount, 0);
  assert.equal(report.metrics.rawContextLeakageCount, 0);
  assert.equal(report.metrics.rawOutputLeakageCount, 0);
  assert.equal(report.metrics.deterministicMismatchCount, 0);
  assert.equal(report.safeguards.modelCalls, 0);
  assert.equal(report.safeguards.networkCalls, 0);
  assert.equal(report.safeguards.externalAdaptersEnabled, 0);
  assert.equal(report.safeguards.externalWritesEnabled, false);

  const exact = report.baselines.find((item) => item.name === 'exact');
  const full = report.baselines.find((item) => item.name === 'full');
  const lexical = report.baselines.find((item) => item.name === 'lexical');
  assert.equal(exact.metrics.requiredEvidenceRecall, 1);
  assert.equal(full.metrics.requiredEvidenceRecall, 1);
  assert.equal(lexical.metrics.recallAt10, 1);
  assert(lexical.metrics.mrrAt10 > 0);
  assert(lexical.metrics.ndcgAt10 > 0);
  assert.equal(report.reportFingerprint, rerun.reportFingerprint);
  assert.match(report.phaseArtifacts[0].artifactFingerprint, /^sha256:[a-f0-9]{64}$/);

  const resumed = await evaluationLab.runBenchmarkTruthFloor(dataset, {
    clock: () => FIXED_TIME,
    commitSha: '7a7630903d27137a425536b1eee6a40d8b41fd1c',
    runner: { name: 'tests/benchmark-truth-floor.test.mjs', version: '1.0.0' },
    subject: { kind: 'context-benchmark', id: 'native-context-baselines', version: '1.0.0', fingerprint: sha('a') },
    resumeFromPhaseArtifacts: report.phaseArtifacts
  });
  assert.equal(resumed.reportFingerprint, report.reportFingerprint);

  const serialized = JSON.stringify(report);
  assert(!serialized.includes('Auth incident policy requires'));
  assert(!serialized.includes('Auth incident local-first evidence'));
  assert(!serialized.includes('credential-sentinel-value'));
  assert(!serialized.includes('/Users/rebel'));

  const redactedRunnerReport = await evaluationLab.runBenchmarkTruthFloor(dataset, {
    clock: () => FIXED_TIME,
    commitSha: '7a7630903d27137a425536b1eee6a40d8b41fd1c',
    runner: { name: '/Users/rebel/private/run-evals.mjs', version: '1.0.0' },
    subject: { kind: 'context-benchmark', id: 'native-context-baselines', version: '1.0.0', fingerprint: sha('a') }
  });
  assert.equal(redactedRunnerReport.runner.name, '[redacted]');
  assert.equal(redactedRunnerReport.metrics.localPathLeakageCount, 0);
  assert(!JSON.stringify(redactedRunnerReport).includes('/Users/rebel'));
});

test('benchmark truth floor fails when forbidden evidence is selected', async () => {
  const input = benchmarkInput();
  const forbiddenCase = structuredClone(input.cases[0]);
  forbiddenCase.requiredEvidenceIds = ['ev_auth_policy'];
  forbiddenCase.forbiddenIds = ['ev_auth_runbook'];
  const dataset = evaluationLab.createBenchmarkDataset({ ...input, cases: [forbiddenCase] });

  const report = await evaluationLab.runBenchmarkTruthFloor(dataset, {
    clock: () => FIXED_TIME,
    commitSha: '7a7630903d27137a425536b1eee6a40d8b41fd1c',
    runner: { name: 'tests/benchmark-truth-floor.test.mjs', version: '1.0.0' },
    subject: { kind: 'context-benchmark', id: 'native-context-baselines', version: '1.0.0', fingerprint: sha('a') }
  });

  assert.equal(report.gateDecision, 'fail');
  assert(report.metrics.forbiddenInclusionCount > 0);
  assert(report.metrics.workspaceLeakageCount > 0);
  assert(report.baselines.some((baseline) => baseline.status === 'failed' && baseline.metrics.forbiddenInclusionCount > 0));
});

test('benchmark truth floor applies dataset thresholds to each baseline status', async () => {
  const input = benchmarkInput({
    thresholds: {
      requiredEvidenceRecall: 1,
      distractorExclusionRate: 0.9,
      selectedTokenRatioMax: 0.01,
      deterministicMismatchCount: 0
    }
  });
  const dataset = evaluationLab.createBenchmarkDataset(input);
  const report = await evaluationLab.runBenchmarkTruthFloor(dataset, {
    clock: () => FIXED_TIME,
    commitSha: '7a7630903d27137a425536b1eee6a40d8b41fd1c',
    runner: { name: 'tests/benchmark-truth-floor.test.mjs', version: '1.0.0' },
    subject: { kind: 'context-benchmark', id: 'native-context-baselines', version: '1.0.0', fingerprint: sha('a') }
  });

  assert.equal(report.gateDecision, 'fail');
  assert(report.baselines.some((baseline) => baseline.metrics.selectedTokenRatio > 0.01));
  assert(report.baselines.every((baseline) => baseline.metrics.selectedTokenRatio <= 0.01 || baseline.status === 'failed'));
});
