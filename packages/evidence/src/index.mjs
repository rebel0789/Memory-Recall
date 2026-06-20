import { createHash } from 'node:crypto';
import { assertPlainObject } from '../../protocol/src/index.mjs';

const SNAPSHOT_FORBIDDEN_KEYS = new Set([
  'observed',
  'inferred',
  'summary',
  'summaries',
  'classification',
  'classifications',
  'hook',
  'hooks',
  'modelConclusion',
  'modelConclusions',
  'memoryDecision',
  'memoryDecisions',
  'analysis',
  'claims'
]);
const DATA_CLASSES = new Set(['public', 'workspace-private', 'sensitive']);
const RETENTION_MODES = new Set(['workspace-default', 'retain', 'expire-at', 'legal-hold']);
const CLAIM_RELATIONS = new Set(['supports', 'contradicts', 'mentions', 'requires_verification']);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  throw new TypeError('body must be a string, Buffer, or Uint8Array');
}

function canonicalStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalStringify(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function clonePlain(value, name) {
  assertPlainObject(value, name);
  return structuredClone(value);
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function optionalString(value, fallback, name) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  return value;
}

function validIsoTimestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) && value.includes('T');
}

function requireIso(value, name) {
  if (!validIsoTimestamp(value)) throw new Error(`${name} must be an ISO-8601 timestamp`);
  return value;
}

function normalizeRetention(value = { mode: 'workspace-default' }) {
  if (typeof value === 'string') value = { mode: value };
  assertPlainObject(value, 'retention');
  const mode = value.mode ?? 'workspace-default';
  if (!RETENTION_MODES.has(mode)) throw new Error('retention mode is unsupported');
  if (mode === 'expire-at') {
    return { mode, expiresAt: requireIso(value.expiresAt, 'retention.expiresAt') };
  }
  if (value.expiresAt !== undefined) throw new Error('expiresAt is only valid for expire-at retention');
  return { mode };
}

function normalizeDataClass(value = 'workspace-private') {
  if (!DATA_CLASSES.has(value)) throw new Error('dataClass is unsupported');
  return value;
}

function assertNoSnapshotInference(input) {
  for (const key of SNAPSHOT_FORBIDDEN_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      throw new Error(`source snapshot cannot contain inference, summary, hook, classification, model conclusion, or memory decision field: ${key}`);
    }
  }
}

function requireEvidenceId(id) {
  if (typeof id !== 'string' || !/^obs_[A-Za-z0-9._-]+$/.test(id)) throw new Error('evidence id must use obs_ prefix');
  return id;
}

function normalizeClaim(input) {
  assertPlainObject(input, 'claim');
  const evidenceIds = normalizeEvidenceIds(input.evidenceIds);
  return deepFreeze({
    schemaVersion: '1.0.0',
    id: requireString(input.id, 'claim.id'),
    kind: 'claim',
    text: optionalString(input.text, '', 'claim.text'),
    relation: normalizeRelation(input.relation),
    evidenceIds,
    createdAt: input.createdAt ?? null,
    inferred: clonePlain(input.inferred ?? {}, 'claim.inferred'),
    uncertainty: optionalString(input.uncertainty, null, 'claim.uncertainty')
  });
}

function normalizeRelation(value) {
  const relation = value ?? 'supports';
  if (!CLAIM_RELATIONS.has(relation)) throw new Error('claim relation is unsupported');
  return relation;
}

function normalizeEvidenceIds(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error('claim requires evidenceIds');
  const unique = [...new Set(value.map(requireEvidenceId))].sort();
  if (unique.length !== value.length) throw new Error('claim evidenceIds must be unique');
  return unique;
}

function sourceSnapshotById(snapshots) {
  return new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
}

function normalizeObservationWithSnapshots(input, snapshotsById) {
  const observation = normalizeObservation(input);
  if (observation.sourceSnapshotId) {
    const snapshot = snapshotsById.get(observation.sourceSnapshotId);
    if (!snapshot) throw new Error(`observation ${observation.id} references unavailable source snapshot ${observation.sourceSnapshotId}`);
    if (observation.sourceContentHash && observation.sourceContentHash !== snapshot.contentHash) throw new Error(`observation ${observation.id} sourceContentHash does not match snapshot`);
    return deepFreeze({ ...observation, sourceContentHash: snapshot.contentHash });
  }
  return observation;
}

function citationEdgeId({ claimId, observationId, relation }) {
  return `edge_${sha256(canonicalStringify({ claimId, observationId, relation })).slice(0, 32)}`;
}

function conflictId(conflict) {
  return `conf_${sha256(canonicalStringify(conflict)).slice(0, 32)}`;
}

function dedupeGroupId(contentHash) {
  return `dedupe_${contentHash.slice(0, 32)}`;
}

export function normalizeSourceSnapshot(input) {
  assertPlainObject(input, 'source snapshot');
  assertNoSnapshotInference(input);
  const body = toBuffer(input.body ?? '');
  const contentHash = input.contentHash ?? sha256(body);
  if (!/^[a-f0-9]{64}$/.test(contentHash)) throw new Error('contentHash must be sha256 hex');
  const id = optionalString(input.id, `src_${contentHash.slice(0, 32)}`, 'source snapshot id');
  if (!/^src_[A-Za-z0-9._-]{16,128}$/.test(id)) throw new Error('source snapshot id must use src_ prefix with at least 16 safe characters');
  const byteSize = input.byteSize ?? body.byteLength;
  const snapshot = {
    schemaVersion: '1.0.0',
    id,
    provider: input.provider ?? 'provider:native:evidence:memory',
    workspaceId: input.workspaceId ?? 'ws_local',
    kind: 'source_snapshot',
    hashAlgorithm: 'sha256',
    contentHash,
    hash: contentHash,
    byteSize,
    size: byteSize,
    mediaType: input.mediaType ?? 'text/plain',
    filename: input.filename ?? null,
    dataClass: normalizeDataClass(input.dataClass),
    retention: normalizeRetention(input.retention),
    trust: 'untrusted-external',
    capturedAt: requireIso(input.capturedAt ?? input.createdAt, 'capturedAt'),
    createdAt: requireIso(input.createdAt ?? input.capturedAt, 'createdAt'),
    collector: input.collector ?? 'fixture',
    retrievalMethod: input.retrievalMethod ?? 'manual',
    sourceLocator: requireString(input.sourceLocator, 'sourceLocator'),
    metadata: clonePlain(input.metadata ?? {}, 'metadata')
  };
  return deepFreeze(snapshot);
}

export function normalizeObservation(input) {
  assertPlainObject(input, 'observation');
  for (const key of ['id', 'source', 'text', 'collectedAt']) {
    if (!input[key]) throw new Error(`observation requires ${key}`);
  }
  if (!/^obs_[A-Za-z0-9._-]+$/.test(input.id)) throw new Error('observation id must use obs_ prefix');
  const text = String(input.text);
  const observation = {
    schemaVersion: '1.0.0',
    id: input.id,
    workspaceId: input.workspaceId ?? 'ws_local',
    source: input.source,
    sourceSnapshotId: input.sourceSnapshotId ?? null,
    sourceContentHash: input.sourceContentHash ?? null,
    platform: input.platform ?? 'unknown',
    creator: input.creator ?? 'unknown',
    text,
    publishedAt: input.publishedAt ?? null,
    collectedAt: requireIso(input.collectedAt, 'collectedAt'),
    metricAt: requireIso(input.metricAt ?? input.collectedAt, 'metricAt'),
    contentHash: sha256(text),
    observed: clonePlain(input.observed ?? {}, 'observed'),
    inferred: clonePlain(input.inferred ?? {}, 'inferred'),
    trust: input.trust ?? 'untrusted-external'
  };
  return deepFreeze(observation);
}

export function validateClaimCitations(claims, availableEvidenceIds) {
  const available = new Set(availableEvidenceIds);
  const failures = [];
  for (const claim of claims) {
    if (!Array.isArray(claim.evidenceIds) || !claim.evidenceIds.length) failures.push({ claimId: claim.id, reason: 'missing_evidence' });
    else {
      const missing = claim.evidenceIds.filter((id) => !available.has(id));
      if (missing.length) failures.push({ claimId: claim.id, reason: 'unavailable_evidence', missing });
    }
  }
  return { valid: failures.length === 0, failures };
}

export function evaluateObservationStaleness(observation, { asOf, staleAfterDays = 30 } = {}) {
  assertPlainObject(observation, 'observation');
  const reference = requireIso(asOf, 'asOf');
  const metricAt = observation.metricAt ?? observation.collectedAt;
  if (!validIsoTimestamp(metricAt)) {
    return deepFreeze({
      observationId: requireString(observation.id, 'observation.id'),
      state: 'unknown',
      asOf: reference,
      metricAt: metricAt ?? null,
      ageDays: null,
      staleAfterDays,
      reasonCodes: ['missing_metric_time']
    });
  }
  const ageDays = Math.max(0, Math.floor((Date.parse(reference) - Date.parse(metricAt)) / 86_400_000));
  const stale = ageDays > staleAfterDays;
  return deepFreeze({
    observationId: requireString(observation.id, 'observation.id'),
    state: stale ? 'stale' : 'fresh',
    asOf: reference,
    metricAt,
    ageDays,
    staleAfterDays,
    reasonCodes: stale ? ['metric_window_exceeded'] : ['within_metric_window']
  });
}

export function buildEvidenceGraph({
  id,
  workspaceId = 'ws_local',
  generatedAt,
  snapshots = [],
  observations = [],
  claims = [],
  staleAfterDays = 30
}) {
  const normalizedSnapshots = snapshots.map(normalizeSourceSnapshot).sort((left, right) => left.id.localeCompare(right.id));
  const snapshotsById = sourceSnapshotById(normalizedSnapshots);
  const normalizedObservations = observations
    .map((observation) => normalizeObservationWithSnapshots(observation, snapshotsById))
    .sort((left, right) => left.id.localeCompare(right.id));
  const normalizedClaims = claims.map(normalizeClaim).sort((left, right) => left.id.localeCompare(right.id));
  const citationResult = validateClaimCitations(normalizedClaims, normalizedObservations.map((observation) => observation.id));
  if (!citationResult.valid) {
    const error = new Error('claim citations reference unavailable evidence');
    error.code = 'invalid_claim_citations';
    error.failures = citationResult.failures;
    throw error;
  }
  const graphGeneratedAt = requireIso(generatedAt, 'generatedAt');
  const graph = {
    schemaVersion: '1.0.0',
    id: id ?? `eg_${sha256(canonicalStringify({ workspaceId, generatedAt: graphGeneratedAt, observations: normalizedObservations.map((item) => item.id), claims: normalizedClaims.map((item) => item.id) })).slice(0, 32)}`,
    workspaceId,
    generatedAt: graphGeneratedAt,
    snapshots: normalizedSnapshots,
    observations: normalizedObservations,
    deduplicationGroups: buildDeduplicationGroups(normalizedObservations),
    claims: normalizedClaims,
    citationEdges: buildCitationEdges(normalizedClaims, normalizedObservations),
    staleness: normalizedObservations.map((observation) => evaluateObservationStaleness(observation, { asOf: graphGeneratedAt, staleAfterDays })),
    conflicts: detectObservationConflicts(normalizedObservations)
  };
  return deepFreeze(graph);
}

function buildDeduplicationGroups(observations) {
  const byHash = new Map();
  for (const observation of observations) {
    const group = byHash.get(observation.contentHash) ?? [];
    group.push(observation);
    byHash.set(observation.contentHash, group);
  }
  return [...byHash.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([contentHash, group]) => {
      const ordered = [...group].sort((left, right) => left.id.localeCompare(right.id));
      return deepFreeze({
        id: dedupeGroupId(contentHash),
        contentHash,
        canonicalObservationId: ordered[0].id,
        observationIds: ordered.map((item) => item.id),
        sourceSnapshotIds: [...new Set(ordered.map((item) => item.sourceSnapshotId).filter(Boolean))].sort(),
        reasonCodes: ['same_content_hash']
      });
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function buildCitationEdges(claims, observations) {
  const observationById = new Map(observations.map((observation) => [observation.id, observation]));
  const edges = [];
  for (const claim of claims) {
    for (const observationId of claim.evidenceIds) {
      const observation = observationById.get(observationId);
      const edge = {
        id: citationEdgeId({ claimId: claim.id, observationId, relation: claim.relation }),
        claimId: claim.id,
        observationId,
        sourceSnapshotId: observation?.sourceSnapshotId ?? null,
        relation: claim.relation,
        reasonCodes: [`claim_${claim.relation}`]
      };
      edges.push(deepFreeze(edge));
    }
  }
  return edges.sort((left, right) => left.id.localeCompare(right.id));
}

function detectObservationConflicts(observations) {
  const assertions = [];
  for (const observation of observations) {
    const observedAssertions = Array.isArray(observation.observed?.assertions) ? observation.observed.assertions : [];
    for (const assertion of observedAssertions) {
      if (!assertion || typeof assertion !== 'object') continue;
      if (!assertion.subject || !assertion.predicate || assertion.value === undefined) continue;
      assertions.push({
        observationId: observation.id,
        subject: String(assertion.subject),
        predicate: String(assertion.predicate),
        value: assertion.value
      });
    }
  }
  const byClaim = new Map();
  for (const assertion of assertions) {
    const key = `${assertion.subject}\u0000${assertion.predicate}`;
    const group = byClaim.get(key) ?? [];
    group.push(assertion);
    byClaim.set(key, group);
  }
  const conflicts = [];
  for (const group of byClaim.values()) {
    const values = new Map();
    for (const assertion of group) {
      const valueKey = canonicalStringify(assertion.value);
      const bucket = values.get(valueKey) ?? { value: assertion.value, observationIds: [] };
      bucket.observationIds.push(assertion.observationId);
      values.set(valueKey, bucket);
    }
    if (values.size < 2) continue;
    const subject = group[0].subject;
    const predicate = group[0].predicate;
    const conflict = {
      subject,
      predicate,
      observationIds: [...new Set(group.map((assertion) => assertion.observationId))].sort(),
      values: [...values.values()].map((item) => ({ value: item.value, observationIds: [...new Set(item.observationIds)].sort() })).sort((left, right) => canonicalStringify(left.value).localeCompare(canonicalStringify(right.value))),
      severity: 'requires_review',
      reasonCodes: ['conflicting_observed_assertions']
    };
    conflicts.push(deepFreeze({ id: conflictId(conflict), ...conflict }));
  }
  return conflicts.sort((left, right) => left.id.localeCompare(right.id));
}
