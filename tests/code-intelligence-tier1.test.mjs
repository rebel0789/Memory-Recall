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
  assert.equal(summary.summary.repositoryCount, 43);
  assert.equal(summary.cases.length, 59);
  assert.equal(summary.languages.length, 14);
  assert.equal(summary.languages.every((language) => language.fixtureCount === 1), true);
  assert.equal(summary.languages.every((language) => language.repositoryCount >= 3), true);
  assert.equal(summary.languages.find((language) => language.language === 'python').repositoryCount, 4);
  assert.equal(summary.languages.every((language) => language.accuracy.declarationRecall.value >= 0.95), true);
  assert.equal(summary.languages.every((language) => language.accuracy.relationshipRecall.value >= 0.95), true);
  assert.equal(summary.languages.every((language) => language.accuracy.reviewedCallPrecision.value >= 0.90), true);
  assert.equal(summary.cases.every((item) => item.measurements.graphResponseBytes > 0), true);
  assert.equal(summary.cases.every((item) => item.report.gateDecision === 'pass'), true);
  assert.equal(summary.summary.meetsFloorCapabilityCount, 73);
  assert.equal(summary.summary.doesNotMeetFloorCapabilityCount, 0);
  assert.equal(summary.summary.unmeasuredCapabilityCount, 80);
  assert.equal(summary.summary.notApplicableCapabilityCount, 1);
  const pythonConfig = summary.languages
    .find((language) => language.language === 'python')
    .capabilities.find((capability) => capability.id === 'config');
  assert.equal(pythonConfig.benchmarkStatus, 'meets-floor');
  assert.deepEqual(pythonConfig.metrics.reviewedTruth, { numerator: 8, denominator: 8, value: 1 });
  const pythonFrameworks = summary.languages
    .find((language) => language.language === 'python')
    .capabilities.find((capability) => capability.id === 'frameworks');
  assert.equal(pythonFrameworks.benchmarkStatus, 'meets-floor');
  assert.equal(pythonFrameworks.repositoryEvidenceCount, 3);
  assert.deepEqual(pythonFrameworks.metrics.reviewedTruth, { numerator: 5, denominator: 5, value: 1 });
  const javaImports = summary.languages
    .find((language) => language.language === 'java')
    .capabilities.find((capability) => capability.id === 'imports');
  assert.equal(javaImports.benchmarkStatus, 'meets-floor');
  assert.equal(javaImports.fixtureEvidenceCount, 1);
  assert.equal(javaImports.repositoryEvidenceCount, 3);
  assert.deepEqual(javaImports.metrics.reviewedTruth, { numerator: 4, denominator: 4, value: 1 });
  const goImports = summary.languages
    .find((language) => language.language === 'go')
    .capabilities.find((capability) => capability.id === 'imports');
  assert.equal(goImports.benchmarkStatus, 'meets-floor');
  assert.equal(goImports.fixtureEvidenceCount, 1);
  assert.equal(goImports.repositoryEvidenceCount, 3);
  assert.deepEqual(goImports.metrics.reviewedTruth, { numerator: 8, denominator: 8, value: 1 });
  for (const language of ['go', 'rust', 'dart']) {
    const exports = summary.languages
      .find((item) => item.language === language)
      .capabilities.find((capability) => capability.id === 'exports');
    assert.equal(exports.benchmarkStatus, 'meets-floor', language);
    assert.equal(exports.fixtureEvidenceCount, 1, language);
    assert.equal(exports.repositoryEvidenceCount, 3, language);
    assert.deepEqual(exports.metrics.reviewedTruth, { numerator: 8, denominator: 8, value: 1 }, language);
  }
  const dartCalls = summary.languages
    .find((item) => item.language === 'dart')
    .capabilities.find((capability) => capability.id === 'calls');
  assert.equal(dartCalls.benchmarkStatus, 'meets-floor');
  assert.equal(dartCalls.fixtureEvidenceCount, 1);
  assert.equal(dartCalls.repositoryEvidenceCount, 3);
  assert.deepEqual(dartCalls.metrics.reviewedTruth, { numerator: 4, denominator: 4, value: 1 });
  const kotlinCalls = summary.languages
    .find((item) => item.language === 'kotlin')
    .capabilities.find((capability) => capability.id === 'calls');
  assert.equal(kotlinCalls.benchmarkStatus, 'meets-floor');
  assert.equal(kotlinCalls.fixtureEvidenceCount, 1);
  assert.equal(kotlinCalls.repositoryEvidenceCount, 3);
  assert.deepEqual(kotlinCalls.metrics.reviewedTruth, { numerator: 5, denominator: 5, value: 1 });
  const kotlinTypes = summary.languages
    .find((item) => item.language === 'kotlin')
    .capabilities.find((capability) => capability.id === 'types');
  assert.equal(kotlinTypes.benchmarkStatus, 'meets-floor');
  assert.equal(kotlinTypes.fixtureEvidenceCount, 1);
  assert.equal(kotlinTypes.repositoryEvidenceCount, 3);
  assert.deepEqual(kotlinTypes.metrics.reviewedTruth, { numerator: 6, denominator: 6, value: 1 });
  for (const language of ['rust', 'kotlin', 'csharp']) {
    const imports = summary.languages
      .find((item) => item.language === language)
      .capabilities.find((capability) => capability.id === 'imports');
    assert.equal(imports.benchmarkStatus, 'meets-floor', language);
    assert.equal(imports.fixtureEvidenceCount, 1, language);
    assert.equal(imports.repositoryEvidenceCount, 3, language);
    assert.deepEqual(imports.metrics.reviewedTruth, { numerator: 8, denominator: 8, value: 1 }, language);
  }
  for (const language of ['php', 'ruby', 'swift', 'c']) {
    const imports = summary.languages
      .find((item) => item.language === language)
      .capabilities.find((capability) => capability.id === 'imports');
    assert.equal(imports.benchmarkStatus, 'meets-floor', language);
    assert.equal(imports.fixtureEvidenceCount, 1, language);
    assert.equal(imports.repositoryEvidenceCount, 3, language);
    assert.deepEqual(imports.metrics.reviewedTruth, { numerator: 8, denominator: 8, value: 1 }, language);
  }
  const cppImports = summary.languages
    .find((item) => item.language === 'cpp')
    .capabilities.find((capability) => capability.id === 'imports');
  assert.equal(cppImports.benchmarkStatus, 'meets-floor');
  assert.equal(cppImports.fixtureEvidenceCount, 1);
  assert.equal(cppImports.repositoryEvidenceCount, 3);
  assert.deepEqual(cppImports.metrics.reviewedTruth, { numerator: 9, denominator: 9, value: 1 });
  const cppTypes = summary.languages
    .find((item) => item.language === 'cpp')
    .capabilities.find((capability) => capability.id === 'types');
  assert.equal(cppTypes.benchmarkStatus, 'meets-floor');
  assert.equal(cppTypes.fixtureEvidenceCount, 1);
  assert.equal(cppTypes.repositoryEvidenceCount, 3);
  assert.deepEqual(cppTypes.metrics.reviewedTruth, { numerator: 5, denominator: 5, value: 1 });
  assert.equal(
    summary.cases.filter((item) => item.graph.diagnostics.some((diagnostic) => diagnostic.code.endsWith('_budget_reached'))).length,
    5
  );
  assert.equal(summary.cases.every((item) => item.graph.diagnostics.every((diagnostic) => !Object.hasOwn(diagnostic, 'locator'))), true);
  const unmeasuredLanguages = summary.languages.filter((language) => !['typescript', 'javascript', 'python'].includes(language.language));
  assert.deepEqual(summary.languages.filter((language) => language.benchmarkStatus === 'meets-floor'), []);
  const cHeritage = summary.languages
    .find((language) => language.language === 'c')
    .capabilities.find((capability) => capability.id === 'heritage');
  assert.equal(cHeritage.applicability, 'not-applicable');
  assert.equal(cHeritage.benchmarkStatus, 'not-applicable');
  assert.equal(summary.languages.every((language) => language.capabilities.every((capability) => (
    typeof capability.applicabilityRationale === 'string' && capability.applicabilityRationale.length > 0
  ))), true);
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
