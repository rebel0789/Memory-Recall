import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  CODE_INTELLIGENCE_CAPABILITIES,
  CODE_INTELLIGENCE_TIER_1_LANGUAGES,
  auditCodeIntelligenceCapabilityMatrix
} from '../packages/protocol/src/code-intelligence-contract.mjs';
import { stableStringify } from '../packages/protocol/src/fingerprint.mjs';

const OUTPUT = 'evals/code-intelligence/results/phase2-tier1-summary.json';
const BATCHES = Object.freeze(['a', 'b', 'c', 'd', 'e']);
const PRIVATE_PATH = /(?:\/Users\/|\/home\/[A-Za-z0-9._-]+\/|\/private\/|\/var\/folders\/|[A-Za-z]:\\)/u;
const mode = parseMode(process.argv.slice(2));
const root = process.cwd();

const packageJson = await readJson('package.json');
const corpus = await readJson('evals/code-intelligence/corpus.v1.json');
const gates = await readJson('evals/code-intelligence/benchmark-gates.v1.json');
const currentMatrix = await readJson('evals/code-intelligence/capability-matrix.v1.json');
const batchReports = await Promise.all(BATCHES.map(async (batch) => {
  const reportPath = `evals/code-intelligence/results/phase2-batch-${batch}.json`;
  return { batch: batch.toUpperCase(), reportPath, report: await readJson(reportPath) };
}));

const failures = [];
const boundFingerprints = new Set(batchReports.map(({ report }) => stableStringify(report.inputs.bounds)));
if (boundFingerprints.size !== 1) failures.push({ code: 'batch_bounds_mismatch' });

const cases = batchReports.flatMap(({ batch, report }) => {
  if (report.gateDecision !== 'pass') failures.push({ code: 'batch_gate_failed', batch });
  if (report.failures.length > 0) failures.push({ code: 'batch_failures_present', batch, count: report.failures.length });
  return report.cases.map((item) => ({ batch, ...item }));
});

const caseIds = new Set();
for (const item of cases) {
  if (caseIds.has(item.id)) failures.push({ code: 'case_id_duplicate', caseId: item.id });
  caseIds.add(item.id);
  if (!Number.isInteger(item.measurements?.graphResponseBytes) || item.measurements.graphResponseBytes <= 0) {
    failures.push({ code: 'graph_response_bytes_missing', caseId: item.id });
  }
  if (item.sourceClass === 'real-repo') {
    const repository = corpus.repositories.find((candidate) => candidate.id === item.id);
    if (!repository) failures.push({ code: 'corpus_repository_missing', caseId: item.id });
    else {
      if (item.commit !== repository.commit) failures.push({ code: 'corpus_commit_mismatch', caseId: item.id });
      if (!item.sourceRef.startsWith(`corpus://${item.id}@${repository.commit}#`)) {
        failures.push({ code: 'corpus_source_ref_mismatch', caseId: item.id });
      }
    }
  }
}

const languages = CODE_INTELLIGENCE_TIER_1_LANGUAGES.map((language) => aggregateLanguage(language, cases, gates.languageFull));
for (const language of languages) {
  if (language.fixtureCount !== 1) failures.push({ code: 'language_fixture_count_invalid', language: language.language, count: language.fixtureCount });
  if (language.repositoryCount !== 3) failures.push({ code: 'language_repository_count_invalid', language: language.language, count: language.repositoryCount });
}
if (cases.filter((item) => item.sourceClass === 'fixture').length !== 14) failures.push({ code: 'fixture_count_invalid' });
if (cases.filter((item) => item.sourceClass === 'real-repo').length !== 42) failures.push({ code: 'repository_count_invalid' });

const safeCases = cases.map((item) => ({
  id: item.id,
  batch: item.batch,
  language: item.language,
  sourceClass: item.sourceClass,
  sourceRef: item.sourceRef,
  ...(item.commit ? { commit: item.commit } : {}),
  truthPath: item.truthPath,
  graph: item.graph,
  measurements: item.measurements,
  report: {
    reportFingerprint: item.report.reportFingerprint,
    metrics: item.report.metrics,
    capabilities: item.report.capabilities,
    failures: item.report.failures,
    gateDecision: item.report.gateDecision
  }
}));

const report = {
  schemaVersion: '1.0.0',
  reportVersion: 'memory-recall-code-intelligence-phase2-tier1-summary-1',
  phase: 2,
  generatedAt: new Date().toISOString(),
  environment: {
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
    engineVersion: packageJson.version,
    protocolVersion: '1.0.0'
  },
  inputs: {
    corpusFingerprint: corpus.corpusFingerprint,
    bounds: batchReports[0].report.inputs.bounds,
    batchReports: batchReports.map(({ batch, reportPath, report: batchReport }) => ({
      batch,
      path: reportPath,
      reportFingerprint: batchReport.reportFingerprint,
      caseCount: batchReport.cases.length,
      languageCount: batchReport.languages.length
    }))
  },
  summary: {
    fixtureCount: safeCases.filter((item) => item.sourceClass === 'fixture').length,
    repositoryCount: safeCases.filter((item) => item.sourceClass === 'real-repo').length,
    languageCount: languages.length,
    caseCount: safeCases.length,
    graphNodeCount: sum(safeCases, (item) => item.graph.nodeCount),
    graphEdgeCount: sum(safeCases, (item) => item.graph.edgeCount),
    graphResponseBytes: sum(safeCases, (item) => item.measurements.graphResponseBytes),
    firstRunWallTimeMs: round(sum(safeCases, (item) => item.measurements.firstElapsedMs)),
    secondRunWallTimeMs: round(sum(safeCases, (item) => item.measurements.secondElapsedMs)),
    peakEvaluatorRssKb: Math.max(...safeCases.map((item) => item.measurements.evaluatorMaxRssKb)),
    meetsFloorCapabilityCount: languages.flatMap((item) => item.capabilities).filter((item) => item.benchmarkStatus === 'meets-floor').length,
    doesNotMeetFloorCapabilityCount: languages.flatMap((item) => item.capabilities).filter((item) => item.benchmarkStatus === 'does-not-meet-floor').length,
    unmeasuredCapabilityCount: languages.flatMap((item) => item.capabilities).filter((item) => item.benchmarkStatus === 'unmeasured').length
  },
  cases: safeCases,
  languages,
  failures,
  gateDecision: failures.length === 0 ? 'pass' : 'fail',
  publicDefault: { engine: 'js', changed: false },
  claims: {
    allBatchGatesPass: batchReports.every(({ report: batchReport }) => batchReport.gateDecision === 'pass'),
    allTier1CapabilitiesMeetFloor: languages.every((item) => item.benchmarkStatus === 'meets-floor'),
    parity: false,
    leadership: false,
    reason: 'Phase 2 records sampled Tier 1 native-preview evidence. Unmeasured capability rows, the JS public default, unbundled native binaries, and unmeasured competitors remain explicit.'
  },
  safeguards: {
    rawSourceStored: false,
    absoluteCheckoutPathsStored: false,
    environmentVariablesStored: false,
    networkCalls: 0,
    modelCalls: 0,
    canonicalMemoryWrites: 0,
    workspaceWrites: 0
  }
};
if (PRIVATE_PATH.test(JSON.stringify(report))) failures.push({ code: 'private_path_leak' });
const expectedMatrix = buildCapabilityMatrix(currentMatrix, report, cases, mode === 'check' ? currentMatrix.generatedAt : report.generatedAt);
for (const finding of await auditCodeIntelligenceCapabilityMatrix(expectedMatrix, { root })) {
  failures.push({ code: 'capability_matrix_invalid', finding });
}
report.gateDecision = failures.length === 0 ? 'pass' : 'fail';
report.reportFingerprint = fingerprint(comparableReport(report));

if (mode === 'check') {
  const stored = await readJson(OUTPUT);
  if (JSON.stringify(comparableReport(stored)) !== JSON.stringify(comparableReport(report))) {
    throw new Error('phase2_tier1_evidence_stale');
  }
  if (stored.reportFingerprint !== fingerprint(comparableReport(stored))) {
    throw new Error('phase2_tier1_report_fingerprint_invalid');
  }
  if (JSON.stringify(currentMatrix) !== JSON.stringify(expectedMatrix)) {
    throw new Error('phase2_tier1_capability_matrix_stale');
  }
  console.log(`Phase 2 Tier 1 evidence is current: ${report.summary.repositoryCount} repositories, ${report.summary.languageCount} languages.`);
} else {
  await atomicWrite(OUTPUT, report);
  await atomicWrite('evals/code-intelligence/capability-matrix.v1.json', expectedMatrix);
  console.log(`Phase 2 Tier 1 audit wrote ${OUTPUT}: ${report.summary.repositoryCount} repositories, ${report.summary.languageCount} languages.`);
}

function buildCapabilityMatrix(matrix, summary, allCases, generatedAt) {
  const languageSummary = new Map(summary.languages.map((item) => [item.language, item]));
  return {
    ...matrix,
    generatedAt,
    languages: matrix.languages.map((language) => {
      if (language.tier !== 1) return language;
      const measured = languageSummary.get(language.id);
      if (!measured) return language;
      const languageCases = allCases.filter((item) => item.language === language.id);
      const capabilities = Object.fromEntries(CODE_INTELLIGENCE_CAPABILITIES.map((id) => {
        const current = language.capabilities[id];
        const capability = measured.capabilities.find((item) => item.id === id);
        const sourceEvidence = languageCases.filter((item) => {
          const result = item.report.capabilities.find((candidate) => candidate.id === id);
          return id === 'parse' ? capability.applicable : (result?.itemCount ?? 0) > 0;
        });
        const evidence = current.evidence.filter((item) => matchesStableEvidence(item));
        if (capability.applicable) {
          evidence.push({ class: 'benchmark', path: OUTPUT });
          for (const item of sourceEvidence) {
            evidence.push({
              class: item.sourceClass === 'fixture' ? 'fixture' : 'real-repo',
              path: item.truthPath
            });
          }
        }
        return [id, {
          ...current,
          productStatus: capability.applicable && !['typescript', 'javascript'].includes(language.id)
            ? promoteExperimental(current.productStatus)
            : current.productStatus,
          benchmarkStatus: capability.benchmarkStatus,
          evidence: deduplicateEvidence(evidence),
          limitations: [matrixCapabilityLimitation(capability)]
        }];
      }));
      const meets = measured.capabilities.filter((item) => item.benchmarkStatus === 'meets-floor').length;
      const applicableUnmeasured = measured.capabilities.filter((item) => item.applicable && item.benchmarkStatus === 'unmeasured').length;
      return {
        ...language,
        benchmarkStatus: measured.benchmarkStatus,
        capabilities,
        limitations: [
          `Phase 2 native-preview evidence meets ${meets} capability floors; ${applicableUnmeasured} applicable rows remain unmeasured. Native is unbundled and JS remains the public default.`
        ]
      };
    })
  };
}

function matchesStableEvidence(item) {
  return item.class === 'implementation' || item.class === 'documentation';
}

function promoteExperimental(status) {
  return status === 'specified' || status === 'unsupported' ? 'experimental' : status;
}

function deduplicateEvidence(evidence) {
  const seen = new Set();
  return evidence.filter((item) => {
    const key = `${item.class}|${item.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function matrixCapabilityLimitation(capability) {
  if (capability.benchmarkStatus === 'meets-floor') {
    return 'Sampled native-preview evidence from the fixture and all three pinned repositories meets the Phase 2 floor; public defaults are unchanged.';
  }
  if (capability.applicable) {
    return 'Phase 2 has reviewed native-preview evidence, but not qualifying coverage from the fixture and all three pinned repositories for this capability.';
  }
  return 'Phase 2 did not measure this capability; no accuracy claim is made.';
}

function aggregateLanguage(language, allCases, thresholds) {
  const selected = allCases.filter((item) => item.language === language);
  const capabilities = CODE_INTELLIGENCE_CAPABILITIES.map((id) => aggregateCapability(id, selected, thresholds));
  const applicable = capabilities.filter((item) => item.applicable);
  const benchmarkStatus = applicable.some((item) => item.benchmarkStatus === 'does-not-meet-floor')
    ? 'does-not-meet-floor'
    : applicable.some((item) => item.benchmarkStatus === 'unmeasured')
      ? 'unmeasured'
      : applicable.length > 0 ? 'meets-floor' : 'unmeasured';
  return {
    language,
    fixtureCount: selected.filter((item) => item.sourceClass === 'fixture').length,
    repositoryCount: selected.filter((item) => item.sourceClass === 'real-repo').length,
    caseCount: selected.length,
    benchmarkStatus,
    accuracy: {
      declarationRecall: ratio(
        sum(selected, (item) => item.report.metrics.declarationRecall.numerator),
        sum(selected, (item) => item.report.metrics.declarationRecall.denominator)
      ),
      relationshipRecall: ratio(
        sum(selected, (item) => item.report.metrics.relationshipRecall.numerator),
        sum(selected, (item) => item.report.metrics.relationshipRecall.denominator)
      ),
      reviewedCallPrecision: ratio(
        sum(selected, (item) => item.report.metrics.reviewedCallPrecision.numerator),
        sum(selected, (item) => item.report.metrics.reviewedCallPrecision.denominator)
      ),
      duplicateCanonicalSymbolCount: sum(selected, (item) => item.report.metrics.duplicateCanonicalSymbolCount),
      parseFailureCount: sum(selected, (item) => item.report.metrics.parseFailureCount),
      deterministicGraphFingerprint: selected.every((item) => item.report.metrics.deterministicGraphFingerprint)
    },
    capabilities
  };
}

function aggregateCapability(id, cases, thresholds) {
  const entries = cases.map((item) => ({
    item,
    capability: item.report.capabilities.find((candidate) => candidate.id === id)
  }));
  const applicable = entries.some(({ capability }) => capability?.claim !== 'unmeasured');
  const hasEvidence = ({ item, capability }) => id === 'parse'
    ? item.graph.coverage.some((coverage) => coverage.language === item.language)
    : (capability?.itemCount ?? 0) > 0;
  const fixtureEvidenceCount = entries.filter((entry) => entry.item.sourceClass === 'fixture' && hasEvidence(entry)).length;
  const repositoryEvidenceCount = entries.filter((entry) => entry.item.sourceClass === 'real-repo' && hasEvidence(entry)).length;
  const sourceCoverageMet = fixtureEvidenceCount >= 1 && repositoryEvidenceCount >= 3;
  const duplicateCanonicalSymbolCount = sum(cases, (item) => item.report.metrics.duplicateCanonicalSymbolCount);
  const parseFailureCount = sum(cases, (item) => item.report.metrics.parseFailureCount);
  const deterministic = cases.every((item) => item.report.metrics.deterministicGraphFingerprint);
  const truthItemCount = sum(entries, ({ capability }) => capability?.itemCount ?? 0);
  const matchedTruthItemCount = sum(entries, ({ capability }) => capability?.matchedItemCount ?? 0);
  const ratioMetric = id === 'calls'
    ? ratio(
      sum(cases, (item) => item.report.metrics.reviewedCallPrecision.numerator),
      sum(cases, (item) => item.report.metrics.reviewedCallPrecision.denominator)
    )
    : ratio(matchedTruthItemCount, truthItemCount);
  const capabilityMismatch = matchedTruthItemCount !== truthItemCount;
  const hardFailure = duplicateCanonicalSymbolCount > thresholds.duplicateCanonicalSymbolMaximum
    || parseFailureCount > thresholds.malformedFileRepositoryFailureMaximum
    || !deterministic;
  const minimum = id === 'calls' ? thresholds.resolvedCallPrecisionMinimum : thresholds.symbolRecallMinimum;
  let benchmarkStatus = 'unmeasured';
  if (applicable && (hardFailure || capabilityMismatch || (ratioMetric.value !== null && ratioMetric.value < minimum))) {
    benchmarkStatus = 'does-not-meet-floor';
  } else if (applicable && sourceCoverageMet && (id === 'parse' || ratioMetric.value !== null)) {
    benchmarkStatus = 'meets-floor';
  }
  return {
    id,
    applicable,
    benchmarkStatus,
    fixtureEvidenceCount,
    repositoryEvidenceCount,
    sourceCoverageMet,
    metrics: {
      reviewedTruth: ratioMetric,
      duplicateCanonicalSymbolCount,
      parseFailureCount,
      deterministicGraphFingerprint: deterministic
    },
    limitations: benchmarkStatus === 'meets-floor'
      ? ['Sampled fixture and all three pinned repository sources meet the published Phase 2 floor. Native remains preview-only.']
      : applicable
        ? ['The capability lacks qualifying reviewed evidence from the fixture and all three pinned repositories, or a measured sample missed a floor.']
        : ['This capability was not evaluated in Phase 2.']
  };
}

function ratio(numerator, denominator) {
  return { numerator, denominator, value: denominator === 0 ? null : round(numerator / denominator, 6) };
}

function sum(items, select) {
  return items.reduce((total, item) => total + select(item), 0);
}

function round(value, digits = 3) {
  return Number(value.toFixed(digits));
}

function comparableReport(value) {
  const { generatedAt: _generatedAt, reportFingerprint: _reportFingerprint, ...comparable } = value;
  return comparable;
}

function fingerprint(value) {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

async function readJson(file) {
  return JSON.parse(await readFile(path.resolve(root, file), 'utf8'));
}

async function atomicWrite(file, value) {
  const target = path.resolve(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, target);
}

function parseMode(args) {
  if (args.length === 0) return 'write';
  if (args.length === 1 && args[0] === '--check') return 'check';
  throw new Error('usage: node scripts/code-intelligence-phase2-tier1.mjs [--check]');
}
