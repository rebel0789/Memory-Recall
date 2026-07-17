import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const readJson = async (file) => JSON.parse(await readFile(new URL(file, root), 'utf8'));

test('Phase 2 Tier 1 summary keeps every case, resource bound, and public boundary explicit', async () => {
  const summary = await readJson('evals/code-intelligence/results/phase2-tier1-summary.json');
  const baseline = await readJson('evals/code-intelligence/results/phase0-baseline.json');

  assert.equal(summary.phase, 2);
  assert.equal(summary.gateDecision, 'pass');
  assert.equal(summary.inputs.batchReports.length, 5);
  assert.equal(summary.summary.fixtureCount, 14);
  assert.equal(summary.summary.repositoryCount, 42);
  assert.equal(summary.cases.length, 56);
  assert.equal(summary.languages.length, 14);
  assert.equal(summary.languages.every((language) => language.fixtureCount === 1), true);
  assert.equal(summary.languages.every((language) => language.repositoryCount === 3), true);
  assert.equal(summary.languages.every((language) => language.accuracy.declarationRecall.value >= 0.95), true);
  assert.equal(summary.languages.every((language) => language.accuracy.relationshipRecall.value >= 0.95), true);
  assert.equal(summary.languages.every((language) => language.accuracy.reviewedCallPrecision.value >= 0.90), true);
  assert.equal(summary.cases.every((item) => item.measurements.graphResponseBytes > 0), true);
  assert.equal(summary.cases.every((item) => item.report.gateDecision === 'pass'), true);
  assert.equal(summary.summary.meetsFloorCapabilityCount, 49);
  assert.equal(summary.summary.doesNotMeetFloorCapabilityCount, 0);
  assert.equal(summary.summary.unmeasuredCapabilityCount, 105);
  assert.equal(
    summary.cases.filter((item) => item.graph.diagnostics.some((diagnostic) => diagnostic.code.endsWith('_budget_reached'))).length,
    6
  );
  assert.equal(summary.cases.every((item) => item.graph.diagnostics.every((diagnostic) => !Object.hasOwn(diagnostic, 'locator'))), true);
  const unmeasuredLanguages = summary.languages.filter((language) => language.language !== 'javascript');
  assert.deepEqual(
    summary.languages.filter((language) => language.benchmarkStatus === 'meets-floor').map((language) => language.language),
    ['javascript']
  );
  assert.equal(unmeasuredLanguages.every((language) => language.benchmarkStatus === 'unmeasured'), true);
  assert.equal(unmeasuredLanguages.every((language) => (
    language.capabilities.some((capability) => capability.applicable && capability.benchmarkStatus === 'unmeasured')
  )), true);
  assert.equal(summary.failures.length, 0);
  assert.equal(summary.publicDefault.engine, 'js');
  assert.equal(summary.publicDefault.changed, false);
  assert.equal(summary.claims.parity, false);
  assert.equal(summary.claims.leadership, false);
  assert.equal(summary.claims.allTier1CapabilitiesMeetFloor, false);
  assert.equal(baseline.competitors.gitnexus.status, 'unmeasured');
  assert.equal(baseline.competitors.codebaseMemoryMcp.status, 'unmeasured');
  assert.equal(baseline.claims.parity, false);
  assert.equal(baseline.claims.leadership, false);
  assert.equal(summary.safeguards.networkCalls, 0);
  assert.equal(summary.safeguards.modelCalls, 0);
  assert.equal(summary.safeguards.canonicalMemoryWrites, 0);
  assert.equal(summary.safeguards.workspaceWrites, 0);
  assert.doesNotMatch(JSON.stringify(summary), /\/Users\/|\/private\/|\/var\/folders\//u);
});

test('Tier 1 matrix benchmark cells match the worst-case summary decisions', async () => {
  const summary = await readJson('evals/code-intelligence/results/phase2-tier1-summary.json');
  const matrix = await readJson('evals/code-intelligence/capability-matrix.v1.json');

  for (const language of summary.languages) {
    const matrixLanguage = matrix.languages.find((item) => item.id === language.language);
    assert.ok(matrixLanguage, language.language);
    assert.equal(matrixLanguage.benchmarkStatus, language.benchmarkStatus, language.language);
    for (const capability of language.capabilities) {
      assert.equal(
        matrixLanguage.capabilities[capability.id].benchmarkStatus,
        capability.benchmarkStatus,
        `${language.language}:${capability.id}`
      );
    }
  }
});
