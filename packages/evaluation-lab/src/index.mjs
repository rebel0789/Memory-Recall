import { createHash } from 'node:crypto';
import { stableStringify } from '../../protocol/src/index.mjs';
import {
  compileContext,
  compileContextFromSources,
  createCandidateSourceRegistry,
  createFixtureRecordReader,
  createNativeExactCandidateSource,
  createNativeLexicalCandidateSource,
  generateContextCandidates
} from '../../context-compiler/src/index.mjs';
import { runHarnessContextBenchmarks } from '../../harness-context/src/index.mjs';

export const EVALUATION_LAB_VERSION = '1.0.0';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const COMMIT = /^[a-f0-9]{40}$/;
const BENCHMARK_SUITES = new Set(['benchmark-truth-floor']);
const BENCHMARK_BASELINES = Object.freeze(['exact', 'full', 'lexical', 'current-harness']);
const DATASET_SUITES = new Set(['deterministic-regression', 'model-quality-shadow']);
const EXPERIMENT_MODES = new Set(['deterministic', 'model-quality']);
const RESULT_STATUSES = new Set(['passed', 'failed', 'skipped']);
const REDACTED = '[redacted]';
const BLOCKED_KEY_SEGMENTS = new Set([
  'authorization',
  'body',
  'content',
  'cookie',
  'credential',
  'credentials',
  'database',
  'dsn',
  'header',
  'headers',
  'hidden',
  'localpath',
  'output',
  'password',
  'path',
  'prompt',
  'reasoning',
  'secret',
  'secrets',
  'sql',
  'text',
  'token',
  'tokens',
  'url',
  'urls'
]);
const SECRET_VALUE = /sk-[A-Za-z0-9_-]{12,}|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|AKIA[0-9A-Z]{16}|gh[op]_[A-Za-z0-9_]{12,}/;
const LOCAL_PATH = /(?:^|[\s"'=])\/Users\/|(?:^|[\s"'=])\/private\/|(?:^|[\s"'=])\/var\/folders\//;

function fingerprint(value) {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function assertString(value, field, pattern = null) {
  if (typeof value !== 'string' || !value.length) throw new Error(`${field} is required`);
  if (pattern && !pattern.test(value)) throw new Error(`${field} has invalid format`);
  return value;
}

function assertDate(value, field) {
  assertString(value, field);
  if (Number.isNaN(Date.parse(value))) throw new Error(`${field} must be an ISO date-time`);
  return value;
}

function sortedUnique(values = [], field) {
  if (!Array.isArray(values)) throw new Error(`${field} must be an array`);
  return Object.freeze([...new Set(values.map((item) => assertString(item, field)))].sort());
}

function assertObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value;
}

function normalizeRef(input, field) {
  const ref = assertObject(input, field);
  return Object.freeze({
    id: assertString(ref.id, `${field}.id`),
    version: assertString(ref.version, `${field}.version`),
    fingerprint: assertString(ref.fingerprint, `${field}.fingerprint`, SHA256)
  });
}

function normalizeSubject(input) {
  const subject = assertObject(input, 'subject');
  return Object.freeze({
    kind: assertString(subject.kind, 'subject.kind'),
    id: assertString(subject.id, 'subject.id'),
    version: assertString(subject.version, 'subject.version'),
    fingerprint: assertString(subject.fingerprint, 'subject.fingerprint', SHA256)
  });
}

function normalizeCase(input) {
  const item = assertObject(input, 'case');
  return Object.freeze({
    id: assertString(item.id, 'case.id', /^evalcase_[A-Za-z0-9._:-]+$/),
    kind: assertString(item.kind, 'case.kind'),
    inputFingerprint: assertString(item.inputFingerprint, 'case.inputFingerprint', SHA256),
    assertions: sortedUnique(item.assertions, 'case.assertions'),
    tags: sortedUnique(item.tags ?? [], 'case.tags')
  });
}

export function createEvaluationDataset({
  id,
  suite,
  version,
  owner,
  sourceRefs,
  cases,
  createdAt,
  description = ''
} = {}) {
  assertString(id, 'id', /^evalds_[A-Za-z0-9._:-]+$/);
  if (!DATASET_SUITES.has(suite)) throw new Error('suite must be deterministic-regression or model-quality-shadow');
  assertString(version, 'version', SEMVER);
  assertString(owner, 'owner');
  assertDate(createdAt, 'createdAt');
  const normalizedCases = (Array.isArray(cases) ? cases : []).map(normalizeCase);
  if (!normalizedCases.length) throw new Error('dataset cases are required');
  const dataset = {
    schemaVersion: '1.0.0',
    id,
    suite,
    version,
    owner,
    description: String(description ?? '').slice(0, 240),
    mergeGate: suite === 'deterministic-regression',
    sourceRefs: sortedUnique(sourceRefs, 'sourceRefs'),
    cases: normalizedCases,
    createdAt,
    labVersion: EVALUATION_LAB_VERSION
  };
  return Object.freeze({ ...dataset, datasetFingerprint: fingerprint(dataset) });
}

export function createBenchmarkDataset({
  id,
  suite,
  version,
  owner,
  sourceRefs,
  cases,
  createdAt,
  thresholds = {},
  description = ''
} = {}) {
  assertString(id, 'id', /^evalds_[A-Za-z0-9._:-]+$/);
  if (!BENCHMARK_SUITES.has(suite)) throw new Error('suite must be benchmark-truth-floor');
  assertString(version, 'version', SEMVER);
  assertString(owner, 'owner');
  assertDate(createdAt, 'createdAt');
  const normalizedCases = (Array.isArray(cases) ? cases : []).map(normalizeBenchmarkCase);
  if (!normalizedCases.length) throw new Error('benchmark cases are required');
  const dataset = {
    schemaVersion: '1.0.0',
    id,
    suite,
    version,
    owner,
    description: String(description ?? '').slice(0, 240),
    mergeGate: true,
    sourceRefs: sortedUnique(sourceRefs, 'sourceRefs'),
    thresholds: normalizeBenchmarkThresholds(thresholds),
    cases: normalizedCases,
    createdAt,
    labVersion: EVALUATION_LAB_VERSION
  };
  return Object.freeze({ ...dataset, datasetFingerprint: fingerprint(dataset) });
}

function normalizeBenchmarkThresholds(thresholds) {
  const value = assertObject(thresholds, 'thresholds');
  return Object.freeze({
    requiredEvidenceRecall: boundedNumber(value.requiredEvidenceRecall ?? 1, 'thresholds.requiredEvidenceRecall', 0, 1),
    distractorExclusionRate: boundedNumber(value.distractorExclusionRate ?? 0.9, 'thresholds.distractorExclusionRate', 0, 1),
    selectedTokenRatioMax: boundedNumber(value.selectedTokenRatioMax ?? 0.7, 'thresholds.selectedTokenRatioMax', 0, 1),
    deterministicMismatchCount: boundedInteger(value.deterministicMismatchCount ?? 0, 'thresholds.deterministicMismatchCount', 0, 10_000)
  });
}

function normalizeBenchmarkCase(input) {
  const item = assertObject(input, 'benchmark case');
  const requiredEvidenceIds = sortedUnique(item.requiredEvidenceIds, 'case.requiredEvidenceIds');
  const distractorIds = sortedUnique(item.distractorIds ?? [], 'case.distractorIds');
  const forbiddenIds = sortedUnique(item.forbiddenIds ?? [], 'case.forbiddenIds');
  assertNoOverlap(requiredEvidenceIds, distractorIds, 'requiredEvidenceIds', 'distractorIds');
  assertNoOverlap(requiredEvidenceIds, forbiddenIds, 'requiredEvidenceIds', 'forbiddenIds');
  assertNoOverlap(distractorIds, forbiddenIds, 'distractorIds', 'forbiddenIds');
  const normalized = {
    id: assertString(item.id, 'case.id', /^evalcase_[A-Za-z0-9._:-]+$/),
    workspaceId: assertString(item.workspaceId, 'case.workspaceId'),
    question: safeString(item.question, 240),
    objective: assertString(item.objective, 'case.objective'),
    step: assertString(item.step, 'case.step'),
    expectedAnswer: safeString(item.expectedAnswer ?? '', 240),
    abstainWhenMissing: item.abstainWhenMissing === true,
    tokenBudget: boundedInteger(item.tokenBudget, 'case.tokenBudget', 1, 1_000_000),
    requiredEntities: sortedUnique(item.requiredEntities ?? [], 'case.requiredEntities'),
    requiredEvidenceIds,
    distractorIds,
    forbiddenIds,
    records: (Array.isArray(item.records) ? item.records : []).map(normalizeBenchmarkRecord).sort((a, b) => a.id.localeCompare(b.id))
  };
  if (!normalized.records.length) throw new Error('case.records are required');
  if (item.harnessContext) normalized.harnessContext = normalizeHarnessBenchmarkCase(item.harnessContext, normalized);
  return Object.freeze(normalized);
}

function normalizeBenchmarkRecord(input) {
  const record = assertObject(input, 'case.record');
  return Object.freeze({
    id: assertString(record.id, 'record.id', /^[a-z][a-z0-9_.:-]*$/),
    version: assertString(record.version ?? '1.0.0', 'record.version'),
    kind: assertString(record.kind, 'record.kind'),
    workspaceId: assertString(record.workspaceId, 'record.workspaceId'),
    text: assertString(record.text, 'record.text'),
    tags: sortedUnique(record.tags ?? [], 'record.tags'),
    relations: sortedUnique(record.relations ?? [], 'record.relations'),
    scope: assertString(record.scope ?? 'workspace-private', 'record.scope'),
    dataClass: assertString(record.dataClass ?? 'workspace-private', 'record.dataClass'),
    trustClass: assertString(record.trustClass ?? 'observed', 'record.trustClass'),
    status: assertString(record.status ?? 'active', 'record.status'),
    source: assertString(record.source ?? 'fixture', 'record.source'),
    tokens: boundedInteger(record.tokens ?? 1, 'record.tokens', 1, 1_000_000),
    confidence: boundedNumber(record.confidence ?? 0.5, 'record.confidence', 0, 1),
    authority: boundedNumber(record.authority ?? 0.5, 'record.authority', 0, 1),
    updatedAt: assertDate(record.updatedAt, 'record.updatedAt'),
    contentHash: assertString(record.contentHash, 'record.contentHash', SHA256)
  });
}

function normalizeHarnessBenchmarkCase(input, benchmarkCase) {
  const value = assertObject(input, 'case.harnessContext');
  const expect = assertObject(value.expect ?? {}, 'case.harnessContext.expect');
  return Object.freeze({
    harnesses: sortedUnique(value.harnesses ?? ['all'], 'case.harnessContext.harnesses'),
    objective: String(value.objective ?? benchmarkCase.objective),
    step: String(value.step ?? benchmarkCase.step),
    tokenBudget: Number.isInteger(value.tokenBudget) ? value.tokenBudget : benchmarkCase.tokenBudget,
    files: (Array.isArray(value.files) ? value.files : []).map((file) => {
      const item = assertObject(file, 'case.harnessContext.file');
      return Object.freeze({
        path: assertString(item.path, 'case.harnessContext.file.path'),
        body: assertString(item.body, 'case.harnessContext.file.body')
      });
    }),
    expect: Object.freeze({
      selectedLocators: sortedUnique(expect.selectedLocators ?? [], 'case.harnessContext.expect.selectedLocators'),
      excludedLocators: sortedUnique(expect.excludedLocators ?? [], 'case.harnessContext.expect.excludedLocators'),
      forbiddenStrings: sortedUnique(expect.forbiddenStrings ?? [], 'case.harnessContext.expect.forbiddenStrings')
    })
  });
}

export async function runBenchmarkTruthFloor(datasetInput, {
  clock = () => new Date().toISOString(),
  commitSha = '0000000000000000000000000000000000000000',
  runner = { name: 'benchmark-truth-floor', version: EVALUATION_LAB_VERSION },
  subject = {
    kind: 'context-benchmark',
    id: 'native-context-baselines',
    version: EVALUATION_LAB_VERSION,
    fingerprint: fingerprint({ kind: 'context-benchmark', id: 'native-context-baselines', version: EVALUATION_LAB_VERSION })
  },
  resumeFromPhaseArtifacts = []
} = {}) {
  const dataset = datasetInput?.datasetFingerprint ? datasetInput : createBenchmarkDataset(datasetInput);
  if (dataset.suite !== 'benchmark-truth-floor') throw new Error('unsupported suite: benchmark-truth-floor expected');
  assertString(commitSha, 'commitSha', COMMIT);
  const generatedAt = clock();
  assertDate(generatedAt, 'generatedAt');
  const normalizedRunner = normalizeRunner(runner);
  const normalizedSubject = normalizeSubject(subject);
  if (!Array.isArray(resumeFromPhaseArtifacts)) throw new Error('resumeFromPhaseArtifacts must be an array');
  const caseResults = [];

  for (const testCase of dataset.cases) {
    const baselines = [];
    baselines.push(await runEvidenceBaseline('exact', testCase, { clock, thresholds: dataset.thresholds }));
    baselines.push(await runEvidenceBaseline('full', testCase, { clock, thresholds: dataset.thresholds }));
    baselines.push(await runEvidenceBaseline('lexical', testCase, { clock, thresholds: dataset.thresholds }));
    baselines.push(await runHarnessBaseline(testCase, { clock, thresholds: dataset.thresholds }));
    const caseMetrics = aggregateBaselineMetrics(baselines);
    const passed = baselinePasses(caseMetrics, dataset.thresholds) && baselines.every((item) => item.status === 'passed');
    const summary = {
      caseId: testCase.id,
      status: passed ? 'passed' : 'failed',
      requiredEvidenceCount: testCase.requiredEvidenceIds.length,
      distractorCount: testCase.distractorIds.length,
      forbiddenCount: testCase.forbiddenIds.length,
      baselines,
      metrics: caseMetrics
    };
    caseResults.push(Object.freeze({ ...summary, caseFingerprint: fingerprint(summary) }));
  }

  const baselineSummaries = BENCHMARK_BASELINES.map((name) => {
    const baselineCases = caseResults.map((item) => item.baselines.find((baseline) => baseline.name === name)).filter(Boolean);
    const metrics = aggregateBaselineMetrics(baselineCases);
    const passed = baselinePasses(metrics, dataset.thresholds) && baselineCases.every((item) => item.status === 'passed');
    const summary = {
      name,
      status: passed ? 'passed' : 'failed',
      caseCount: baselineCases.length,
      metrics,
      resultFingerprint: fingerprint(baselineCases.map((item) => ({
        caseId: item.caseId,
        status: item.status,
        metrics: item.metrics,
        selectedEvidenceIds: item.selectedEvidenceIds,
        selectedLocatorIds: item.selectedLocatorIds,
        errorCode: item.errorCode
      })))
    };
    return Object.freeze(summary);
  });
  const baselineMetrics = aggregateBaselineMetrics(baselineSummaries);
  const counts = {
    passed: caseResults.filter((item) => item.status === 'passed').length,
    failed: caseResults.filter((item) => item.status === 'failed').length,
    caseCount: caseResults.length,
    baselineCount: baselineSummaries.length
  };
  const initialGateDecision = counts.failed === 0 && baselineSummaries.every((item) => item.status === 'passed') && baselinePasses(baselineMetrics, dataset.thresholds) ? 'pass' : 'fail';
  const initialPhaseArtifacts = buildPhaseArtifacts({ dataset, metrics: baselineMetrics, caseResults, baselineSummaries, generatedAt });
  const reportBase = {
    schemaVersion: '1.0.0',
    id: `evalrep_${dataset.id.replace(/^evalds_/, '')}`,
    suite: dataset.suite,
    dataset: {
      id: dataset.id,
      version: dataset.version,
      datasetFingerprint: dataset.datasetFingerprint,
      caseCount: dataset.cases.length
    },
    subject: normalizedSubject,
    commitSha,
    runner: normalizedRunner,
    generatedAt,
    thresholds: dataset.thresholds,
    metrics: baselineMetrics,
    baselines: baselineSummaries,
    cases: caseResults,
    counts,
    gateDecision: initialGateDecision,
    safeguards: benchmarkSafeguards(baselineMetrics),
    phaseArtifacts: initialPhaseArtifacts,
    labVersion: EVALUATION_LAB_VERSION
  };
  const reportExposureLeakage = leakageMetricsForReport(reportBase, dataset);
  const metrics = mergeLeakageMetrics(baselineMetrics, reportExposureLeakage);
  const safeguards = benchmarkSafeguards(metrics);
  const gateDecision = counts.failed === 0 && baselineSummaries.every((item) => item.status === 'passed') && baselinePasses(metrics, dataset.thresholds) ? 'pass' : 'fail';
  const phaseArtifacts = reportExposureLeakage.hasLeakage
    ? buildPhaseArtifacts({ dataset, metrics, caseResults, baselineSummaries, generatedAt })
    : initialPhaseArtifacts;
  const report = { ...reportBase, metrics, gateDecision, safeguards, phaseArtifacts };
  return Object.freeze({ ...report, reportFingerprint: fingerprint(reportFingerprintPayload(report)) });
}

async function runEvidenceBaseline(name, testCase, { clock, thresholds }) {
  const request = benchmarkRequestFor(testCase, name, clock());
  try {
    let manifest;
    let selection;
    let candidateGeneration = null;
    let rankedIds = [];
    let candidateTokenCount = visibleRecordTokenCount(testCase);
    if (name === 'exact') {
      const result = await compileContextFromSources(request, {
        registry: createCandidateSourceRegistry([createNativeExactCandidateSource()]),
        recordReader: createFixtureRecordReader(testCase.records),
        clock
      });
      ({ manifest, selection, candidateGeneration } = result);
      rankedIds = rankIdsFromCandidateGeneration(candidateGeneration, 'exact');
      candidateTokenCount = Math.max(visibleRecordTokenCount(testCase), tokenCountFromCandidateGeneration(candidateGeneration));
    } else if (name === 'lexical') {
      const lexicalRequest = {
        ...request,
        requiredIds: [],
        sourcePlan: [{ kind: 'lexical', required: false, limit: 10, timeoutMs: 1000 }]
      };
      candidateGeneration = await generateContextCandidates(lexicalRequest, {
        registry: createCandidateSourceRegistry([createNativeLexicalCandidateSource()]),
        recordReader: createFixtureRecordReader(testCase.records),
        clock
      });
      const selected = compileContext(lexicalRequest, candidateGeneration.candidates);
      manifest = selected;
      selection = selected.selection;
      rankedIds = rankIdsFromCandidateGeneration(candidateGeneration, 'lexical');
      candidateTokenCount = Math.max(visibleRecordTokenCount(testCase), tokenCountFromCandidateGeneration(candidateGeneration));
    } else {
      manifest = compileContext(request, testCase.records);
      selection = manifest.selection;
      rankedIds = testCase.records
        .filter((record) => record.workspaceId === testCase.workspaceId && record.dataClass !== 'secret')
        .map((record) => record.id);
    }
    const selectedEvidenceIds = selectedSafeIds(manifest.selected ?? []);
    const excludedEvidenceIds = selectedSafeIds(manifest.excluded ?? []);
    const selectedTokenCount = (manifest.selected ?? []).reduce((sum, item) => sum + Number(item.tokens ?? 0), 0);
    const metrics = scoreEvidenceBaseline({
      testCase,
      selectedEvidenceIds,
      excludedEvidenceIds,
      rankedIds,
      selectedTokenCount,
      candidateTokenCount,
      deterministicMismatchCount: 0
    });
    const status = baselinePasses(metrics, thresholds) ? 'passed' : 'failed';
    const summary = {
      name,
      caseId: testCase.id,
      status,
      selectedEvidenceIds,
      excludedEvidenceIds,
      selectedLocatorIds: [],
      metrics,
      resultFingerprint: selection?.resultFingerprint ?? fingerprint({ name, selectedEvidenceIds, excludedEvidenceIds, metrics })
    };
    return Object.freeze(summary);
  } catch (error) {
    return failedBaseline(name, testCase, error);
  }
}

async function runHarnessBaseline(testCase, { clock, thresholds }) {
  if (!testCase.harnessContext) return failedBaseline('current-harness', testCase, new Error('harness_context_missing'));
  try {
    const harnessDataset = {
      schemaVersion: '1.0.0',
      name: 'benchmark-truth-floor-current-harness',
      thresholds: {
        requiredLocatorRecall: 1,
        distractorExclusionRate: 0.9,
        selectedTokenRatioMax: 0.7,
        caseDurationMsMax: 60_000,
        suiteDurationMsMax: 60_000
      },
      cases: [{
        id: testCase.id,
        workspaceId: testCase.workspaceId,
        harnesses: testCase.harnessContext.harnesses,
        objective: testCase.harnessContext.objective,
        step: testCase.harnessContext.step,
        tokenBudget: testCase.harnessContext.tokenBudget,
        files: testCase.harnessContext.files,
        expect: testCase.harnessContext.expect
      }]
    };
    const result = await runHarnessContextBenchmarks(harnessDataset, { clock });
    const firstCase = result.cases[0] ?? {};
    const metrics = normalizeBenchmarkMetrics({
      requiredEvidenceRecall: result.metrics.requiredLocatorRecall,
      distractorExclusionRate: result.metrics.distractorExclusionRate,
      selectedTokenRatio: result.metrics.selectedTokenRatio,
      secretLeakageCount: result.metrics.secretLeakageCount,
      localPathLeakageCount: result.metrics.localPathLeakageCount,
      rawContextLeakageCount: result.metrics.rawBodyLeakageCount,
      deterministicMismatchCount: result.metrics.deterministicMismatchCount,
      recallAt10: result.metrics.requiredLocatorRecall,
      mrrAt10: result.metrics.requiredLocatorRecall,
      ndcgAt10: result.metrics.requiredLocatorRecall
    });
    const status = result.passed && baselinePasses(metrics, thresholds) ? 'passed' : 'failed';
    return Object.freeze({
      name: 'current-harness',
      caseId: testCase.id,
      status,
      selectedEvidenceIds: [],
      excludedEvidenceIds: [],
      selectedLocatorIds: sortedUnique(firstCase.selectedLocators ?? [], 'selectedLocatorIds'),
      metrics,
      resultFingerprint: firstCase.previewFingerprint ?? fingerprint({ name: 'current-harness', metrics })
    });
  } catch (error) {
    return failedBaseline('current-harness', testCase, error);
  }
}

function failedBaseline(name, testCase, error) {
  return Object.freeze({
    name,
    caseId: testCase.id,
    status: 'failed',
    selectedEvidenceIds: [],
    excludedEvidenceIds: [],
    selectedLocatorIds: [],
    errorCode: safeErrorCode(error),
    metrics: normalizeBenchmarkMetrics({
      requiredEvidenceRecall: 0,
      distractorExclusionRate: 0,
      selectedTokenRatio: 0,
      deterministicMismatchCount: 0
    }),
    resultFingerprint: fingerprint({ name, caseId: testCase.id, errorCode: safeErrorCode(error) })
  });
}

function benchmarkRequestFor(testCase, name, now) {
  return {
    schemaVersion: '1.0.0',
    id: `ctxreq_${testCase.id}_${name}`.replaceAll('-', '_'),
    requestId: `ctxreq_${testCase.id}_${name}`.replaceAll('-', '_'),
    correlationId: `corr_${testCase.id}_${name}`.replaceAll('-', '_'),
    workspaceId: testCase.workspaceId,
    actorId: 'usr_benchmark',
    taskId: 'task_benchmark_truth_floor',
    objective: testCase.objective,
    step: testCase.step,
    requiredIds: name === 'lexical' ? [] : testCase.requiredEvidenceIds,
    requiredEntities: testCase.requiredEntities,
    allowedDataClasses: ['public', 'workspace-private'],
    allowedTrustClasses: ['verified', 'trusted', 'observed'],
    allowedScopes: ['public', 'workspace-private'],
    sourcePlan: name === 'exact'
      ? [{ kind: 'exact', required: true, limit: 10, timeoutMs: 1000 }]
      : [{ kind: 'lexical', required: false, limit: 10, timeoutMs: 1000 }],
    perSourceLimit: 10,
    totalCandidateLimit: 20,
    trustedTimestamp: now,
    now,
    tokenBudget: testCase.tokenBudget
  };
}

function scoreEvidenceBaseline({
  testCase,
  selectedEvidenceIds,
  rankedIds,
  selectedTokenCount,
  candidateTokenCount,
  deterministicMismatchCount
}) {
  const selected = new Set(selectedEvidenceIds);
  const required = testCase.requiredEvidenceIds;
  const distractors = testCase.distractorIds;
  const forbidden = testCase.forbiddenIds;
  const requiredHits = required.filter((id) => selected.has(id)).length;
  const distractorExcluded = distractors.filter((id) => !selected.has(id)).length;
  const forbiddenIncluded = forbidden.filter((id) => selected.has(id)).length;
  return normalizeBenchmarkMetrics({
    requiredEvidenceRecall: required.length ? requiredHits / required.length : 1,
    distractorExclusionRate: distractors.length ? distractorExcluded / distractors.length : 1,
    selectedTokenRatio: candidateTokenCount ? selectedTokenCount / candidateTokenCount : 0,
    secretLeakageCount: 0,
    localPathLeakageCount: 0,
    rawPromptLeakageCount: 0,
    rawContextLeakageCount: 0,
    rawOutputLeakageCount: 0,
    deterministicMismatchCount,
    recallAt10: recallAtK(rankedIds, required, 10),
    mrrAt10: mrrAtK(rankedIds, required, 10),
    ndcgAt10: ndcgAtK(rankedIds, required, 10),
    forbiddenInclusionCount: forbiddenIncluded,
    workspaceLeakageCount: forbiddenIncluded
  });
}

function aggregateBaselineMetrics(items) {
  const list = items.filter(Boolean);
  if (!list.length) return normalizeBenchmarkMetrics({});
  const metrics = {
    requiredEvidenceRecall: average(list, 'requiredEvidenceRecall'),
    distractorExclusionRate: average(list, 'distractorExclusionRate'),
    selectedTokenRatio: average(list, 'selectedTokenRatio'),
    secretLeakageCount: sum(list, 'secretLeakageCount'),
    localPathLeakageCount: sum(list, 'localPathLeakageCount'),
    rawPromptLeakageCount: sum(list, 'rawPromptLeakageCount'),
    rawContextLeakageCount: sum(list, 'rawContextLeakageCount'),
    rawOutputLeakageCount: sum(list, 'rawOutputLeakageCount'),
    forbiddenInclusionCount: sum(list, 'forbiddenInclusionCount'),
    workspaceLeakageCount: sum(list, 'workspaceLeakageCount'),
    deterministicMismatchCount: sum(list, 'deterministicMismatchCount'),
    durationMs: 0,
    recallAt10: average(list, 'recallAt10'),
    mrrAt10: average(list, 'mrrAt10'),
    ndcgAt10: average(list, 'ndcgAt10')
  };
  return normalizeBenchmarkMetrics(metrics);
}

function normalizeBenchmarkMetrics(metrics) {
  return Object.freeze({
    requiredEvidenceRecall: roundMetric(metrics.requiredEvidenceRecall ?? 0),
    distractorExclusionRate: roundMetric(metrics.distractorExclusionRate ?? 0),
    selectedTokenRatio: roundMetric(metrics.selectedTokenRatio ?? 0),
    secretLeakageCount: boundedInteger(metrics.secretLeakageCount ?? 0, 'metrics.secretLeakageCount', 0, 1_000_000),
    localPathLeakageCount: boundedInteger(metrics.localPathLeakageCount ?? 0, 'metrics.localPathLeakageCount', 0, 1_000_000),
    rawPromptLeakageCount: boundedInteger(metrics.rawPromptLeakageCount ?? 0, 'metrics.rawPromptLeakageCount', 0, 1_000_000),
    rawContextLeakageCount: boundedInteger(metrics.rawContextLeakageCount ?? 0, 'metrics.rawContextLeakageCount', 0, 1_000_000),
    rawOutputLeakageCount: boundedInteger(metrics.rawOutputLeakageCount ?? 0, 'metrics.rawOutputLeakageCount', 0, 1_000_000),
    forbiddenInclusionCount: boundedInteger(metrics.forbiddenInclusionCount ?? 0, 'metrics.forbiddenInclusionCount', 0, 1_000_000),
    workspaceLeakageCount: boundedInteger(metrics.workspaceLeakageCount ?? 0, 'metrics.workspaceLeakageCount', 0, 1_000_000),
    deterministicMismatchCount: boundedInteger(metrics.deterministicMismatchCount ?? 0, 'metrics.deterministicMismatchCount', 0, 1_000_000),
    durationMs: 0,
    recallAt10: roundMetric(metrics.recallAt10 ?? metrics.requiredEvidenceRecall ?? 0),
    mrrAt10: roundMetric(metrics.mrrAt10 ?? 0),
    ndcgAt10: roundMetric(metrics.ndcgAt10 ?? 0)
  });
}

function benchmarkSafeguards(metrics) {
  return Object.freeze({
    rawPromptsIncluded: false,
    rawContextIncluded: false,
    rawOutputsIncluded: false,
    rawPathsIncluded: false,
    secretsIncluded: false,
    modelCalls: 0,
    networkCalls: 0,
    activeMemoryCreated: 0,
    sourceSnapshotsWritten: 0,
    externalAdaptersEnabled: 0,
    externalWritesEnabled: false,
    leakageCounts: {
      secret: metrics.secretLeakageCount,
      localPath: metrics.localPathLeakageCount,
      rawPrompt: metrics.rawPromptLeakageCount,
      rawContext: metrics.rawContextLeakageCount,
      rawOutput: metrics.rawOutputLeakageCount,
      forbiddenInclusion: metrics.forbiddenInclusionCount,
      workspace: metrics.workspaceLeakageCount
    }
  });
}

function baselinePasses(metrics, thresholds) {
  const limits = thresholds ?? defaultBenchmarkThresholds();
  return metrics.requiredEvidenceRecall >= limits.requiredEvidenceRecall &&
    metrics.distractorExclusionRate >= limits.distractorExclusionRate &&
    metrics.selectedTokenRatio <= limits.selectedTokenRatioMax &&
    metrics.secretLeakageCount === 0 &&
    metrics.localPathLeakageCount === 0 &&
    metrics.rawPromptLeakageCount === 0 &&
    metrics.rawContextLeakageCount === 0 &&
    metrics.rawOutputLeakageCount === 0 &&
    metrics.forbiddenInclusionCount === 0 &&
    metrics.workspaceLeakageCount === 0 &&
    metrics.deterministicMismatchCount <= limits.deterministicMismatchCount;
}

function defaultBenchmarkThresholds() {
  return {
    requiredEvidenceRecall: 1,
    distractorExclusionRate: 0.9,
    selectedTokenRatioMax: 0.7,
    deterministicMismatchCount: 0
  };
}

function buildPhaseArtifacts({ dataset, metrics, caseResults, baselineSummaries, generatedAt }) {
  return ['retrieval', 'assembly', 'comparison'].map((phase) => {
    const artifact = {
      schemaVersion: '1.0.0',
      id: `evalphase_${dataset.id.replace(/^evalds_/, '')}_${phase}`,
      suite: dataset.suite,
      phase,
      dataset: {
        id: dataset.id,
        version: dataset.version,
        datasetFingerprint: dataset.datasetFingerprint,
        caseCount: dataset.cases.length
      },
      generatedAt,
      baselineNames: baselineSummaries.map((item) => item.name).sort(),
      caseCount: caseResults.length,
      metrics
    };
    return Object.freeze({ ...artifact, artifactFingerprint: fingerprint(artifact) });
  });
}

function reportFingerprintPayload(report) {
  return {
    schemaVersion: report.schemaVersion,
    id: report.id,
    suite: report.suite,
    dataset: report.dataset,
    subject: report.subject,
    commitSha: report.commitSha,
    runner: report.runner,
    generatedAt: report.generatedAt,
    thresholds: report.thresholds,
    metrics: report.metrics,
    baselines: report.baselines,
    cases: report.cases,
    counts: report.counts,
    gateDecision: report.gateDecision,
    safeguards: report.safeguards,
    phaseArtifacts: report.phaseArtifacts.map((item) => ({
      id: item.id,
      phase: item.phase,
      artifactFingerprint: item.artifactFingerprint
    })),
    labVersion: report.labVersion
  };
}

function leakageMetricsForReport(report, dataset) {
  const serialized = stableStringify(report);
  const rawContextNeedles = [];
  const rawPromptNeedles = [];
  const rawOutputNeedles = [];
  const secretNeedles = [];
  for (const testCase of dataset.cases ?? []) {
    rawPromptNeedles.push(testCase.question, testCase.objective, testCase.step);
    rawOutputNeedles.push(testCase.expectedAnswer);
    for (const record of testCase.records ?? []) {
      rawContextNeedles.push(record.text);
      if (record.dataClass === 'secret') secretNeedles.push(record.text);
    }
    for (const file of testCase.harnessContext?.files ?? []) {
      rawContextNeedles.push(file.body);
    }
  }
  const metrics = {
    secretLeakageCount: countPattern(serialized, SECRET_VALUE) + countNeedles(serialized, secretNeedles),
    localPathLeakageCount: countPattern(serialized, LOCAL_PATH),
    rawPromptLeakageCount: countNeedles(serialized, rawPromptNeedles),
    rawContextLeakageCount: countNeedles(serialized, rawContextNeedles),
    rawOutputLeakageCount: countNeedles(serialized, rawOutputNeedles)
  };
  return Object.freeze({ ...metrics, hasLeakage: Object.values(metrics).some((count) => count > 0) });
}

function mergeLeakageMetrics(metrics, leakage) {
  return normalizeBenchmarkMetrics({
    ...metrics,
    secretLeakageCount: metrics.secretLeakageCount + leakage.secretLeakageCount,
    localPathLeakageCount: metrics.localPathLeakageCount + leakage.localPathLeakageCount,
    rawPromptLeakageCount: metrics.rawPromptLeakageCount + leakage.rawPromptLeakageCount,
    rawContextLeakageCount: metrics.rawContextLeakageCount + leakage.rawContextLeakageCount,
    rawOutputLeakageCount: metrics.rawOutputLeakageCount + leakage.rawOutputLeakageCount,
    forbiddenInclusionCount: metrics.forbiddenInclusionCount,
    workspaceLeakageCount: metrics.workspaceLeakageCount
  });
}

function countNeedles(serialized, values) {
  let count = 0;
  for (const value of values) {
    const needle = String(value ?? '').trim();
    if (needle.length >= 16 && serialized.includes(needle)) count += 1;
  }
  return count;
}

function countPattern(serialized, pattern) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return [...serialized.matchAll(new RegExp(pattern.source, flags))].length;
}

function rankIdsFromCandidateGeneration(candidateGeneration, kind) {
  return (candidateGeneration?.candidates ?? [])
    .map((candidate) => {
      const hit = (candidate.hits ?? []).find((item) => item.sourceKind === kind) ?? candidate.hits?.[0] ?? null;
      return { id: candidate.record.id, rank: hit?.localRank ?? Number.MAX_SAFE_INTEGER };
    })
    .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id))
    .map((item) => item.id);
}

function tokenCountFromCandidateGeneration(candidateGeneration) {
  return (candidateGeneration?.candidates ?? []).reduce((sum, candidate) => sum + Number(candidate.record?.tokens ?? 0), 0);
}

function visibleRecordTokenCount(testCase) {
  return testCase.records
    .filter((record) => record.workspaceId === testCase.workspaceId && record.dataClass !== 'secret' && ['public', 'workspace-private'].includes(record.scope))
    .reduce((sum, record) => sum + Number(record.tokens ?? 0), 0);
}

function selectedSafeIds(items) {
  return sortedUnique(items.map((item) => item.id).filter(Boolean), 'selected ids');
}

function recallAtK(rankedIds, requiredIds, k) {
  if (!requiredIds.length) return 1;
  const top = new Set(rankedIds.slice(0, k));
  return roundMetric(requiredIds.filter((id) => top.has(id)).length / requiredIds.length);
}

function mrrAtK(rankedIds, requiredIds, k) {
  const required = new Set(requiredIds);
  for (let index = 0; index < Math.min(k, rankedIds.length); index += 1) {
    if (required.has(rankedIds[index])) return roundMetric(1 / (index + 1));
  }
  return 0;
}

function ndcgAtK(rankedIds, requiredIds, k) {
  if (!requiredIds.length) return 1;
  const required = new Set(requiredIds);
  let dcg = 0;
  for (let index = 0; index < Math.min(k, rankedIds.length); index += 1) {
    if (required.has(rankedIds[index])) dcg += 1 / Math.log2(index + 2);
  }
  let ideal = 0;
  for (let index = 0; index < Math.min(k, requiredIds.length); index += 1) ideal += 1 / Math.log2(index + 2);
  return roundMetric(ideal ? dcg / ideal : 0);
}

function sum(items, field) {
  return items.reduce((total, item) => total + Number(item.metrics?.[field] ?? 0), 0);
}

function average(items, field) {
  if (!items.length) return 0;
  return items.reduce((total, item) => total + Number(item.metrics?.[field] ?? 0), 0) / items.length;
}

function roundMetric(value) {
  return Number((Number.isFinite(Number(value)) ? Number(value) : 0).toFixed(6));
}

function boundedNumber(value, field, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new Error(`${field} must be between ${min} and ${max}`);
  return number;
}

function boundedInteger(value, field, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${field} must be an integer between ${min} and ${max}`);
  return number;
}

function assertNoOverlap(left, right, leftName, rightName) {
  const overlap = left.filter((item) => right.includes(item));
  if (overlap.length) throw new Error(`${leftName}/${rightName} overlap: ${overlap.join(',')}`);
}

function safeErrorCode(error) {
  return safeString(error?.code ?? error?.message ?? 'benchmark_failed', 120).replace(/[^a-zA-Z0-9_:-]+/g, '_');
}

export function createEvaluationExperiment({
  id,
  dataset,
  subject,
  baseline,
  candidate,
  mode,
  createdAt,
  status = 'planned'
} = {}) {
  assertString(id, 'id', /^evalexp_[A-Za-z0-9._:-]+$/);
  const datasetRef = normalizeDatasetRef(dataset);
  if (!EXPERIMENT_MODES.has(mode)) throw new Error('mode must be deterministic or model-quality');
  if (datasetRef.suite === 'deterministic-regression' && mode !== 'deterministic') throw new Error('deterministic datasets require deterministic experiments');
  if (datasetRef.suite === 'model-quality-shadow' && mode !== 'model-quality') throw new Error('model-quality datasets require model-quality experiments');
  assertDate(createdAt, 'createdAt');
  const experiment = {
    schemaVersion: '1.0.0',
    id,
    status,
    mode,
    mergeGate: datasetRef.mergeGate,
    dataset: datasetRef,
    subject: normalizeSubject(subject),
    baseline: normalizeRef(baseline, 'baseline'),
    candidate: normalizeRef(candidate, 'candidate'),
    createdAt,
    labVersion: EVALUATION_LAB_VERSION
  };
  return Object.freeze({ ...experiment, experimentFingerprint: fingerprint(experiment) });
}

function normalizeDatasetRef(dataset) {
  const value = assertObject(dataset, 'dataset');
  return Object.freeze({
    id: assertString(value.id, 'dataset.id', /^evalds_[A-Za-z0-9._:-]+$/),
    suite: assertString(value.suite, 'dataset.suite'),
    version: assertString(value.version, 'dataset.version', SEMVER),
    mergeGate: value.mergeGate === true,
    datasetFingerprint: assertString(value.datasetFingerprint, 'dataset.datasetFingerprint', SHA256)
  });
}

export function recordEvaluationReport({
  id,
  experiment,
  commitSha,
  runner,
  versions,
  results,
  generatedAt
} = {}) {
  assertString(id, 'id', /^evalrep_[A-Za-z0-9._:-]+$/);
  const exp = normalizeExperimentRef(experiment);
  assertString(commitSha, 'commitSha', COMMIT);
  assertDate(generatedAt, 'generatedAt');
  const normalizedRunner = normalizeRunner(runner);
  const normalizedVersions = normalizeVersions(versions);
  const normalizedResults = (Array.isArray(results) ? results : []).map(normalizeResult);
  if (!normalizedResults.length) throw new Error('report results are required');
  const counts = {
    passed: normalizedResults.filter((item) => item.status === 'passed').length,
    failed: normalizedResults.filter((item) => item.status === 'failed').length,
    skipped: normalizedResults.filter((item) => item.status === 'skipped').length
  };
  const gateDecision = decisionFor(exp.mergeGate, counts);
  const report = {
    schemaVersion: '1.0.0',
    id,
    experiment: exp,
    mergeGate: exp.mergeGate,
    commitSha,
    runner: normalizedRunner,
    versions: normalizedVersions,
    results: normalizedResults,
    counts,
    gateDecision,
    generatedAt,
    labVersion: EVALUATION_LAB_VERSION
  };
  return Object.freeze({ ...report, reportFingerprint: fingerprint(report) });
}

function normalizeExperimentRef(experiment) {
  const value = assertObject(experiment, 'experiment');
  return Object.freeze({
    id: assertString(value.id, 'experiment.id', /^evalexp_[A-Za-z0-9._:-]+$/),
    mode: assertString(value.mode, 'experiment.mode'),
    mergeGate: value.mergeGate === true,
    experimentFingerprint: assertString(value.experimentFingerprint, 'experiment.experimentFingerprint', SHA256),
    dataset: normalizeDatasetRef(value.dataset)
  });
}

function normalizeRunner(runner) {
  const value = assertObject(runner, 'runner');
  return Object.freeze({
    name: sanitizeString(assertString(value.name, 'runner.name')),
    version: sanitizeString(assertString(value.version, 'runner.version'))
  });
}

function normalizeVersions(versions) {
  const value = assertObject(versions, 'versions');
  return Object.freeze({
    compiler: assertString(value.compiler, 'versions.compiler'),
    prompt: assertString(value.prompt, 'versions.prompt'),
    model: assertString(value.model, 'versions.model'),
    policy: assertString(value.policy, 'versions.policy')
  });
}

function normalizeResult(result) {
  const value = assertObject(result, 'result');
  if (!RESULT_STATUSES.has(value.status)) throw new Error('result.status is invalid');
  return Object.freeze({
    caseId: assertString(value.caseId, 'result.caseId', /^evalcase_[A-Za-z0-9._:-]+$/),
    status: value.status,
    metrics: sanitizeMetricMap(value.metrics ?? {})
  });
}

function sanitizeMetricMap(metrics) {
  const value = assertObject(metrics, 'metrics');
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (blockedAttributeKey(key)) continue;
    if (typeof item === 'number' && Number.isFinite(item)) output[key] = item;
    else if (typeof item === 'boolean') output[key] = item;
    else if (typeof item === 'string' && !SECRET_VALUE.test(item) && !LOCAL_PATH.test(item)) output[key] = item.slice(0, 120);
  }
  return Object.freeze(output);
}

function decisionFor(mergeGate, counts) {
  if (mergeGate) return counts.failed === 0 ? 'pass' : 'fail';
  return counts.failed === 0 ? 'shadow_passed' : 'shadow_failed_non_blocking';
}

export function promoteTraceToEvaluationCase({
  id,
  datasetId,
  caseId,
  sourceRunId,
  trace,
  review,
  createdAt
} = {}) {
  assertString(id, 'id', /^evaltp_[A-Za-z0-9._:-]+$/);
  assertString(datasetId, 'datasetId', /^evalds_[A-Za-z0-9._:-]+$/);
  assertString(caseId, 'caseId', /^evalcase_[A-Za-z0-9._:-]+$/);
  assertString(sourceRunId, 'sourceRunId');
  assertDate(createdAt, 'createdAt');
  const normalizedReview = normalizeReview(review);
  if (normalizedReview.approved !== true) throw new Error('classification review must approve trace promotion');
  const originalTraceFingerprint = fingerprint(trace ?? {});
  const sanitizedTrace = sanitizeTrace(trace ?? {});
  const promotedCase = {
    id: caseId,
    kind: 'promoted-trace',
    inputFingerprint: sanitizedTrace.traceFingerprint,
    assertions: ['regression_reproduces', 'sensitive_data_absent'],
    tags: ['promoted-trace', sourceRunId]
  };
  const promotion = {
    schemaVersion: '1.0.0',
    id,
    datasetId,
    sourceRunId,
    originalTraceFingerprint,
    sanitizedTrace,
    case: promotedCase,
    review: normalizedReview,
    createdAt,
    labVersion: EVALUATION_LAB_VERSION
  };
  return Object.freeze({ ...promotion, promotionFingerprint: fingerprint(promotion) });
}

function normalizeReview(review) {
  const value = assertObject(review, 'review');
  return Object.freeze({
    reviewedBy: assertString(value.reviewedBy, 'review.reviewedBy'),
    approved: value.approved === true,
    dataClasses: sortedUnique(value.dataClasses ?? [], 'review.dataClasses'),
    reason: assertString(value.reason, 'review.reason').slice(0, 240)
  });
}

function sanitizeTrace(trace) {
  const events = (Array.isArray(trace.events) ? trace.events : []).map((event) => sanitizeEvent(event));
  const spans = (Array.isArray(trace.spans) ? trace.spans : []).map((span) => sanitizeSpan(span));
  const value = {
    schemaVersion: '1.0.0',
    events,
    spans
  };
  return Object.freeze({ ...value, traceFingerprint: fingerprint(value) });
}

function sanitizeEvent(event) {
  const value = assertObject(event, 'trace.event');
  const payload = sanitizeValue(value.payload ?? {});
  return Object.freeze({
    type: safeString(value.type ?? 'event.unknown', 120),
    occurredAt: Date.parse(value.occurredAt) ? value.occurredAt : null,
    payloadFingerprint: fingerprint(payload),
    safeAttributes: flattenSafeAttributes(payload)
  });
}

function sanitizeSpan(span) {
  const value = assertObject(span, 'trace.span');
  const attributes = sanitizeValue(value.attributes ?? {});
  return Object.freeze({
    name: safeString(value.name ?? 'span.unknown', 120),
    attributesFingerprint: fingerprint(attributes),
    safeAttributes: flattenSafeAttributes(attributes)
  });
}

function sanitizeValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return sanitizeString(value);
  if (Array.isArray(value)) return value.slice(0, 16).map(sanitizeValue).filter((item) => item !== null);
  if (typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (blockedAttributeKey(key)) continue;
      const sanitized = sanitizeValue(item);
      if (sanitized !== null) output[key] = sanitized;
    }
    return output;
  }
  return null;
}

function sanitizeString(value) {
  const text = safeString(value, 160);
  if (SECRET_VALUE.test(text) || LOCAL_PATH.test(text)) return REDACTED;
  return text;
}

function flattenSafeAttributes(value, prefix = '', output = null) {
  const target = output ?? {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return output ? target : Object.freeze(target);
  for (const [key, item] of Object.entries(value)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (blockedAttributeKey(nextKey)) continue;
    if (item === null || item === undefined) continue;
    if (typeof item === 'object') flattenSafeAttributes(item, nextKey, target);
    else target[nextKey] = item;
  }
  return output ? target : Object.freeze(target);
}

function blockedAttributeKey(key) {
  return String(key ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1.$2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .some((segment) => BLOCKED_KEY_SEGMENTS.has(segment.toLowerCase()));
}

function safeString(value, max = 160) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, max);
}
