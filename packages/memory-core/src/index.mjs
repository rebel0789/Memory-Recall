import { prefixedId, nowIso, assertPlainObject, stableStringify, sha256Hex } from '../../protocol/src/index.mjs';

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{20,}/,
  /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/,
  /AKIA[0-9A-Z]{16}/,
  /gho_[A-Za-z0-9_]{20,}/
];
const MEMORY_KINDS = new Set(['fact', 'preference', 'decision', 'episode', 'procedure', 'constraint']);
const DATA_CLASSES = new Set(['public', 'workspace-private', 'sensitive', 'secret']);
const ACTIVE_EXPORT_STATUSES = new Set(['active']);
const INACTIVE_EXPORT_STATUSES = new Set(['verified', 'active', 'rejected', 'superseded', 'retracted', 'expired']);

function timestamp(input) {
  return input ?? nowIso();
}

function clone(value) {
  return structuredClone(value);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function plain(value, name) {
  assertPlainObject(value, name);
  return value;
}

function boundedConfidence(value) {
  const number = Number(value ?? 0.5);
  if (!Number.isFinite(number)) return 0.5;
  return Math.max(0, Math.min(1, number));
}

function normalizeDataClass(value = 'workspace-private') {
  if (!DATA_CLASSES.has(value)) throw new Error('dataClass is unsupported');
  return value;
}

function hasSecret(value) {
  return SECRET_PATTERNS.some((pattern) => pattern.test(String(value ?? '')));
}

function lifecycleEvent(type, { at, actorId = 'system', reason = null, evidenceIds = [] } = {}) {
  return deepFreeze({
    type,
    at: timestamp(at),
    actorId,
    reason,
    evidenceIds: [...new Set(evidenceIds.map(String))].sort()
  });
}

function withLifecycle(record, type, event) {
  return [...(record.lifecycle ?? []), lifecycleEvent(type, event)];
}

function normalizeInput(input) {
  plain(input, 'memory proposal');
  if (!MEMORY_KINDS.has(input.kind)) throw new Error('kind is unsupported');
  if (typeof input.text !== 'string' || !input.text.trim()) throw new Error('text is required');
  if (typeof input.source !== 'string' || !input.source.trim()) throw new Error('source is required');
  return input;
}

function commonRecord(input, { status, decision, reasons, text, dataClass }) {
  const createdAt = timestamp(input.now ?? input.createdAt);
  return {
    schemaVersion: '1.0.0',
    id: input.id ?? prefixedId('mem'),
    workspaceId: input.workspaceId ?? 'ws_local',
    kind: input.kind,
    text,
    status,
    source: input.source,
    sourceTrust: input.sourceTrust ?? 'unverified',
    decision,
    reasons: [...new Set(reasons)].sort(),
    confidence: boundedConfidence(input.confidence),
    retention: input.retention ?? 'workspace-default',
    validFrom: input.validFrom ?? null,
    validTo: input.validTo ?? null,
    createdAt,
    updatedAt: createdAt,
    supersedes: input.supersedes ?? null,
    dataClass,
    metadata: clone(input.metadata ?? {}),
    evidenceIds: Array.isArray(input.evidenceIds) ? [...new Set(input.evidenceIds.map(String))].sort() : [],
    conflicts: [],
    lifecycle: [lifecycleEvent('memory.proposed', { at: createdAt, actorId: input.actorId ?? 'system' })]
  };
}

function memoryKey(record) {
  return [record.workspaceId ?? 'ws_local', record.kind, String(record.text ?? '').trim().toLocaleLowerCase()].join('\u0000');
}

function conflictKey(record) {
  const metadata = record.metadata ?? {};
  if (!metadata.subject || !metadata.predicate) return null;
  return [record.workspaceId ?? 'ws_local', record.kind, String(metadata.subject), String(metadata.predicate)].join('\u0000');
}

function findDuplicate(record, existingRecords) {
  const key = memoryKey(record);
  return existingRecords.find((existing) => ['active', 'verified'].includes(existing.status) && memoryKey(existing) === key) ?? null;
}

function findConflicts(record, existingRecords) {
  const key = conflictKey(record);
  if (!key) return [];
  return existingRecords
    .filter((existing) => ['active', 'verified'].includes(existing.status) && conflictKey(existing) === key && String(existing.text ?? '').trim() !== String(record.text ?? '').trim())
    .map((existing) => ({
      existingId: existing.id,
      subject: record.metadata.subject,
      predicate: record.metadata.predicate,
      reason: 'same_subject_predicate_different_text'
    }));
}

function deterministicMemoryCoreId(prefix, value) {
  return `${prefix}_${sha256Hex(stableStringify(value)).slice(0, 32)}`;
}

function normalizeExtractionToken(value, name) {
  const text = String(value ?? '').trim();
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(text)) throw new Error(`${name} must be a safe extraction token`);
  return text;
}

function normalizeExtractionObjectText(value) {
  const text = String(value ?? '')
    .trim()
    .replace(/[.;:,]+$/u, '')
    .trim();
  if (!text || text.length > 240) throw new Error('object is required');
  if (!/^[A-Za-z0-9][A-Za-z0-9:_./ -]{0,239}$/u.test(text)) throw new Error('object must be safe extraction text');
  return text;
}

function isUnsafeExtractionError(error) {
  return /^(subject|predicate|object) (?:must be safe extraction|is required)/u.test(error?.message ?? '');
}

function extractionSentences(text) {
  return String(text ?? '')
    .split(/[.\n]/u)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 50);
}

export function extractTemporalFactProposalsFromEpisode(input) {
  plain(input, 'memory extraction episode');
  const workspaceId = input.workspaceId ?? 'ws_local';
  const scope = input.scope ?? 'workspace';
  const sourceLocator = String(input.sourceLocator ?? '');
  if (!/^workspace:\/\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,512}$/.test(sourceLocator)) throw new Error('sourceLocator must be a safe workspace locator');
  const observedAt = timestamp(input.observedAt);
  const text = String(input.text ?? '');
  const episode = deepFreeze({
    schemaVersion: '1.0.0',
    id: deterministicMemoryCoreId('mep', { workspaceId, scope, sourceLocator, observedAt, text }),
    workspaceId,
    scope,
    sourceLocator,
    observedAt
  });
  const sourceHash = `sha256:${sha256Hex(text)}`;
  let skippedUnsafeCount = 0;
  const proposals = extractionSentences(text).map((sentence) => {
    try {
      if (hasSecret(sentence)) return null;
      let subjectRaw;
      let predicateRaw;
      let objectRaw;
      const decision = sentence.match(/^(?:Decision|Fact):\s*([A-Za-z0-9:_-]+)\s+([A-Za-z0-9:_-]+)\s+(.+)$/iu);
      if (decision) {
        subjectRaw = decision[1];
        predicateRaw = decision[2];
        objectRaw = decision[3].replace(/\s+(?:and\s+)?(?:supersedes|replaces|overrides)\s+.+$/iu, '');
      } else {
        const [subjectToken, predicateToken, objectToken, ...rest] = sentence.split(/\s+/u);
        if (rest.length || !subjectToken || !predicateToken || !objectToken) return null;
        subjectRaw = subjectToken;
        predicateRaw = predicateToken;
        objectRaw = objectToken;
      }
      const subject = normalizeExtractionToken(subjectRaw, 'subject');
      const predicate = normalizeExtractionToken(predicateRaw, 'predicate');
      const object = decision ? normalizeExtractionObjectText(objectRaw) : normalizeExtractionToken(objectRaw, 'object');
      const payload = {
        kind: 'fact',
        scope,
        subject,
        predicate,
        object,
        text: `${subject} ${predicate} ${object}`,
        sourceLocator,
        observedAt,
        subjectEntity: subject,
        objectEntity: object,
        entityLinks: [
          { name: subject, role: 'subject' },
          { name: object, role: 'object' }
        ],
        provenance: {
          episodeId: episode.id,
          sourceLocator,
          sourceHash
        }
      };
      return {
        id: deterministicMemoryCoreId('mpq', { workspaceId, sourceLocator, sourceHash, payload }),
        workspaceId,
        sourceLocator,
        sourceHash,
        payload
      };
    } catch (error) {
      if (!isUnsafeExtractionError(error)) throw error;
      skippedUnsafeCount += 1;
      return null;
    }
  }).filter(Boolean);
  return deepFreeze({
    schemaVersion: '1.0.0',
    workspaceId,
    scope,
    episode,
    proposals,
    safeguards: {
      activeMemoryCreated: 0,
      canonicalStateMutated: false,
      deterministicOffline: true,
      skippedUnsafeCount
    }
  });
}

export function evaluateMemoryWrite(input, { existingRecords = [] } = {}) {
  const proposal = proposeMemory(input);
  if (proposal.status === 'quarantined') return proposal;
  const reasons = new Set(proposal.reasons);
  const duplicate = findDuplicate(proposal, existingRecords);
  if (duplicate) reasons.add('duplicate_memory');
  const conflicts = findConflicts(proposal, existingRecords);
  if (conflicts.length) reasons.add('conflicting_memory');
  const decision = reasons.size ? 'review' : proposal.decision;
  return deepFreeze({
    ...proposal,
    decision,
    reasons: [...reasons].sort(),
    conflicts
  });
}

export function proposeMemory(input) {
  input = normalizeInput(input);
  const reasons = [];
  const secret = hasSecret(input.text);
  if (secret) reasons.push('possible_secret');
  if (input.kind === 'preference' && input.source !== 'user-confirmed') reasons.push('user_confirmation_required');
  if (input.kind === 'fact' && input.sourceTrust !== 'verified') reasons.push('source_verification_required');
  if (input.stability === 'transient') reasons.push('transient_not_durable');
  const status = secret ? 'quarantined' : 'proposed';
  const decision = secret ? 'reject' : (reasons.length ? 'review' : 'propose');
  const dataClass = secret ? 'secret' : normalizeDataClass(input.dataClass);
  return deepFreeze(commonRecord(input, {
    status,
    decision,
    reasons,
    text: secret ? '[redacted-secret]' : input.text,
    dataClass
  }));
}

export function verifyMemory(record, { verifiedAt, verifiedBy = 'system', evidenceIds = [] } = {}) {
  plain(record, 'memory record');
  if (['quarantined', 'rejected', 'retracted', 'expired'].includes(record.status)) throw new Error(`cannot verify ${record.status} memory`);
  if (!Array.isArray(evidenceIds) || !evidenceIds.length) throw new Error('verification requires evidenceIds');
  const at = timestamp(verifiedAt);
  return deepFreeze({
    ...clone(record),
    status: 'verified',
    decision: 'allow',
    verifiedBy,
    evidenceIds: [...new Set([...(record.evidenceIds ?? []), ...evidenceIds.map(String)])].sort(),
    updatedAt: at,
    lifecycle: withLifecycle(record, 'memory.verified', { at, actorId: verifiedBy, evidenceIds })
  });
}

export function activateMemory(record, { activatedAt, activatedBy = 'system' } = {}) {
  plain(record, 'memory record');
  if (['quarantined', 'rejected', 'retracted', 'expired', 'superseded'].includes(record.status)) throw new Error(`cannot activate ${record.status} memory`);
  const userConfirmedAllow = record.source === 'user-confirmed' && !['review', 'reject'].includes(record.decision);
  if (record.status !== 'verified' && !userConfirmedAllow) throw new Error('memory must be verified or user-confirmed before activation');
  const at = timestamp(activatedAt);
  return deepFreeze({
    ...clone(record),
    status: 'active',
    decision: 'allow',
    activatedBy,
    updatedAt: at,
    lifecycle: withLifecycle(record, 'memory.activated', { at, actorId: activatedBy })
  });
}

export function rejectMemory(record, { rejectedAt, rejectedBy = 'system', reason = 'rejected' } = {}) {
  plain(record, 'memory record');
  if (record.status === 'active') throw new Error('active memory must be retracted, not rejected');
  const at = timestamp(rejectedAt);
  return deepFreeze({
    ...clone(record),
    status: 'rejected',
    decision: 'reject',
    reasons: [...new Set([...(record.reasons ?? []), reason])].sort(),
    updatedAt: at,
    lifecycle: withLifecycle(record, 'memory.rejected', { at, actorId: rejectedBy, reason })
  });
}

export function supersedeMemory(previous, replacementInput) {
  plain(previous, 'previous memory');
  plain(replacementInput, 'replacement memory');
  if (previous.status !== 'active') throw new Error('only active memory can be superseded');
  const at = timestamp(replacementInput.supersededAt);
  const actorId = replacementInput.supersededBy ?? 'system';
  const previousRecord = deepFreeze({
    ...clone(previous),
    status: 'superseded',
    updatedAt: at,
    lifecycle: withLifecycle(previous, 'memory.superseded', { at, actorId, reason: replacementInput.reason ?? null })
  });
  const replacementProposal = proposeMemory({
    ...previous,
    ...replacementInput,
    workspaceId: previous.workspaceId,
    kind: replacementInput.kind ?? previous.kind,
    source: replacementInput.source ?? previous.source,
    sourceTrust: replacementInput.sourceTrust ?? previous.sourceTrust ?? 'verified',
    id: replacementInput.id,
    text: replacementInput.text,
    supersedes: previous.id,
    now: at
  });
  const replacement = activateMemory(
    replacementProposal.status === 'verified' ? replacementProposal : verifyMemory(replacementProposal, {
      verifiedAt: at,
      verifiedBy: actorId,
      evidenceIds: replacementInput.evidenceIds ?? previous.evidenceIds ?? ['supersession']
    }),
    { activatedAt: at, activatedBy: actorId }
  );
  return deepFreeze({ previous: previousRecord, replacement });
}

export function retractMemory(record, { retractedAt, retractedBy = 'system', reason = 'retracted' } = {}) {
  plain(record, 'memory record');
  if (!['active', 'verified'].includes(record.status)) throw new Error('only active or verified memory can be retracted');
  const at = timestamp(retractedAt);
  return deepFreeze({
    ...clone(record),
    status: 'retracted',
    updatedAt: at,
    lifecycle: withLifecycle(record, 'memory.retracted', { at, actorId: retractedBy, reason })
  });
}

export function expireMemory(record, { id = record.id, expiredAt, reason = 'expired' } = {}) {
  plain(record, 'memory record');
  const at = timestamp(expiredAt);
  return deepFreeze({
    ...clone(record),
    id,
    status: 'expired',
    validTo: at,
    updatedAt: at,
    lifecycle: withLifecycle(record, 'memory.expired', { at, actorId: 'system', reason })
  });
}

export function exportMemoryRecords(records, { exportedAt, includeInactive = false } = {}) {
  if (!Array.isArray(records)) throw new Error('records must be an array');
  const allowedStatuses = includeInactive ? INACTIVE_EXPORT_STATUSES : ACTIVE_EXPORT_STATUSES;
  const safeRecords = records
    .filter((record) => allowedStatuses.has(record.status))
    .filter((record) => record.dataClass !== 'secret' && record.status !== 'quarantined')
    .map((record) => clone(record))
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)) || left.id.localeCompare(right.id));
  return deepFreeze({
    schemaVersion: '1.0.0',
    exportedAt: timestamp(exportedAt),
    records: safeRecords
  });
}

export {
  buildMemoryProfileReport,
  buildMemoryProposalsReport,
  buildMemorySgrepReport,
  normalizeMemoryPathsConfig,
  redactMemoryText,
  sanitizeMemorySource
} from './filesystem-ux.mjs';
