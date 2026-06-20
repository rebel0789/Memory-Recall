import { createHash } from 'node:crypto';

export const EVALUATION_LAB_VERSION = '1.0.0';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const COMMIT = /^[a-f0-9]{40}$/;
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

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

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
    name: assertString(value.name, 'runner.name'),
    version: assertString(value.version, 'runner.version')
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
