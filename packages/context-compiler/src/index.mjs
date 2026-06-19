import { createHash } from 'node:crypto';
import { prefixedId, nowIso, assertPlainObject } from '../../protocol/src/index.mjs';

export const COMPILER_VERSION = '0.2.0';
const STOP_WORDS = new Set(['a','an','and','are','as','at','be','by','for','from','in','is','it','of','on','or','that','the','this','to','with']);

export function estimateTokens(text) { return Math.max(1, Math.ceil(String(text ?? '').length / 4)); }
export function terms(value) {
  return new Set(String(value ?? '').toLowerCase().replace(/[^a-z0-9_:-]+/g,' ').split(/\s+/).filter(term => term.length > 1 && !STOP_WORDS.has(term)));
}
function overlapScore(query, record) {
  const q=terms(query), r=terms([record.text,...(record.tags??[]),...(record.relations??[])].join(' '));
  if (!q.size || !r.size) return 0;
  let matches=0; for (const term of q) if (r.has(term)) matches++;
  return matches / Math.sqrt(q.size*r.size);
}
function lexicalRecordText(record) {
  return [
    record.title,
    record.safeTitle,
    record.text,
    ...(record.tags ?? []),
    ...(record.relations ?? [])
  ].filter((value) => typeof value === 'string').join(' ');
}
function temporalScore(record, now) {
  const updated=Date.parse(record.updatedAt??record.observedAt??now.toISOString());
  if (!Number.isFinite(updated)) return 0;
  return Math.exp(-Math.max(0,(now.getTime()-updated)/86400000)/60);
}
function isTemporallyValid(record, now) {
  const from=record.validFrom?Date.parse(record.validFrom):-Infinity;
  const to=record.validTo?Date.parse(record.validTo):Infinity;
  return from <= now.getTime() && now.getTime() <= to;
}
function normalizeRecord(record) {
  assertPlainObject(record,'record');
  if (!record.id || !record.kind || !record.text) throw new Error('record requires id, kind, and text');
  return {scope:'workspace-private',status:'active',confidence:.5,authority:.5,tags:[],relations:[],source:'unknown',...record,tokens:Number.isInteger(record.tokens)?record.tokens:estimateTokens(record.text)};
}
function decision(item) {
  return {id:item.record.id,kind:item.record.kind,tokens:item.record.tokens,score:Number(item.score.toFixed(4)),reasonCodes:[...new Set(item.reasonCodes)],source:item.record.source,text:item.record.text};
}
function detectConflicts(records) {
  const groups=new Map();
  for (const record of records) {
    const key=record.metadata?.conflictKey; if (!key) continue;
    const values=groups.get(key)??[]; values.push({id:record.id,value:record.metadata.value,confidence:record.confidence}); groups.set(key,values);
  }
  return [...groups.entries()].filter(([,values])=>new Set(values.map(value=>JSON.stringify(value.value))).size>1).map(([key,values])=>({key,records:values,status:'unresolved'}));
}

export const CANDIDATE_SOURCE_KINDS = Object.freeze(['exact', 'lexical', 'vector', 'graph', 'temporal', 'preference', 'episode']);
export const CANDIDATE_SOURCE_STATUSES = Object.freeze(['succeeded', 'failed', 'timed_out', 'cancelled', 'unavailable', 'denied', 'invalid_output', 'skipped']);
export const CANDIDATE_FAILURE_CODES = Object.freeze([
  'source_unavailable',
  'candidate_source_failed',
  'candidate_source_required_failed',
  'candidate_source_required_denied',
  'candidate_source_required_unavailable',
  'candidate_generation_unavailable',
  'candidate_identity_conflict',
  'invalid_candidate_output',
  'candidate_source_cancelled',
  'candidate_source_timed_out'
]);

const CANDIDATE_REQUEST_KEYS = new Set([
  'schemaVersion',
  'id',
  'requestId',
  'correlationId',
  'workspaceId',
  'actorId',
  'taskId',
  'step',
  'objective',
  'requiredIds',
  'requiredEntities',
  'allowedDataClasses',
  'allowedTrustClasses',
  'allowedScopes',
  'sourcePlan',
  'perSourceLimit',
  'totalCandidateLimit',
  'trustedTimestamp',
  'tokenBudget',
  'now'
]);
const SOURCE_PLAN_KEYS = new Set(['kind', 'sourceId', 'required', 'limit', 'timeoutMs']);
const SOURCE_DESCRIPTOR_KEYS = new Set(['schemaVersion', 'id', 'kind', 'version', 'enabled', 'methods', 'contractVersion', 'description']);
const SOURCE_HIT_KEYS = new Set(['sourceId', 'sourceKind', 'sourceVersion', 'retrievalMethod', 'localRank', 'localScore', 'reasonCodes', 'queryFingerprint', 'accessDecisionRef', 'retrievedAt']);
const MAX_OBJECTIVE_BYTES = 4096;
const MAX_STEP_BYTES = 2048;
const MAX_ID_COUNT = 128;
const MAX_ENTITY_COUNT = 128;
const MAX_SOURCE_COUNT = 16;
const MAX_CANDIDATE_TEXT_BYTES = 64 * 1024;
const MAX_TOTAL_CANDIDATE_BYTES = 512 * 1024;
const MAX_HITS_PER_CANDIDATE = 16;

function assertNoUnknown(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}:unknown_field:${key}`);
}

function byteLength(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8');
}

function requirePositiveInteger(value, name, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || value < 1 || value > max) throw new TypeError(`${name}:positive_integer`);
  return value;
}

function requireString(value, name, { maxBytes = 256, pattern = null } = {}) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name}:string_required`);
  if (byteLength(value) > maxBytes) throw new TypeError(`${name}:too_large`);
  if (pattern && !pattern.test(value)) throw new TypeError(`${name}:invalid`);
  return value;
}

function requireIsoTimestamp(value, name) {
  requireString(value, name, { maxBytes: 64 });
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${name}:invalid_timestamp`);
  return value;
}

function normalizeStringArray(values, name, { max = MAX_ID_COUNT, pattern = null } = {}) {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw new TypeError(`${name}:array_required`);
  if (values.length > max) throw new TypeError(`${name}:too_many`);
  const result = [];
  const seen = new Set();
  for (const value of values) {
    const normalized = requireString(String(value), name, { maxBytes: 256, pattern }).trim();
    const key = normalized.toLowerCase();
    if (seen.has(key)) throw new TypeError(`${name}:duplicate_after_normalization`);
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hashRef(value) {
  return `sha256:${sha256(value)}`;
}

function safeNow(clock) {
  const value = typeof clock === 'function' ? clock() : nowIso();
  return value instanceof Date ? value.toISOString() : String(value);
}

function queryFingerprintFor(request, planEntry) {
  return hashRef(stableStringify({
    schemaVersion: request.schemaVersion,
    workspaceId: request.workspaceId,
    objective: request.objective,
    step: request.step,
    requiredIds: request.requiredIds,
    requiredEntities: request.requiredEntities,
    allowedDataClasses: request.allowedDataClasses,
    allowedTrustClasses: request.allowedTrustClasses,
    kind: planEntry.kind,
    sourceId: planEntry.sourceId ?? null,
    limit: planEntry.limit
  }));
}

function recordFingerprint(record) {
  const explicit = record.contentHash ?? record.fingerprint ?? record.metadata?.contentHash ?? record.metadata?.fingerprint;
  if (typeof explicit === 'string' && /^sha256:[a-f0-9]{64}$/.test(explicit)) return explicit;
  return hashRef(stableStringify({
    id: record.id,
    version: record.version ?? null,
    kind: record.kind,
    text: record.text,
    tags: record.tags ?? [],
    relations: record.relations ?? [],
    updatedAt: record.updatedAt ?? null
  }));
}

export function validateCandidateSourceRequest(request) {
  assertPlainObject(request, 'candidate source request');
  assertNoUnknown(request, CANDIDATE_REQUEST_KEYS, 'candidate source request');
  if (request.schemaVersion !== '1.0.0') throw new TypeError('candidate source request:schemaVersion');
  requireString(request.requestId ?? request.id, 'candidate source request requestId', { maxBytes: 128, pattern: /^[a-z][a-z0-9_-]*$/ });
  requireString(request.correlationId, 'candidate source request correlationId', { maxBytes: 128, pattern: /^[a-z][a-z0-9_-]*$/ });
  requireString(request.workspaceId, 'candidate source request workspaceId', { maxBytes: 128, pattern: /^[a-z][a-z0-9_-]*$/ });
  requireString(request.actorId, 'candidate source request actorId', { maxBytes: 128, pattern: /^[a-z][a-z0-9_-]*$/ });
  requireString(request.taskId, 'candidate source request taskId', { maxBytes: 128, pattern: /^[a-z][a-z0-9_-]*$/ });
  requireString(request.objective, 'candidate source request objective', { maxBytes: MAX_OBJECTIVE_BYTES });
  requireString(request.step, 'candidate source request step', { maxBytes: MAX_STEP_BYTES });
  const requiredIds = normalizeStringArray(request.requiredIds, 'candidate source request requiredIds', { max: MAX_ID_COUNT, pattern: /^[a-z][a-z0-9_.:-]*$/ });
  const requiredEntities = normalizeStringArray(request.requiredEntities, 'candidate source request requiredEntities', { max: MAX_ENTITY_COUNT });
  const allowedDataClasses = normalizeStringArray(request.allowedDataClasses ?? ['public', 'workspace-private'], 'candidate source request allowedDataClasses', { max: 4 });
  const allowedTrustClasses = normalizeStringArray(request.allowedTrustClasses ?? ['verified', 'trusted', 'observed'], 'candidate source request allowedTrustClasses', { max: 8 });
  const allowedScopes = normalizeStringArray(request.allowedScopes ?? ['public', 'workspace-private'], 'candidate source request allowedScopes', { max: 4 });
  const perSourceLimit = requirePositiveInteger(request.perSourceLimit ?? 20, 'candidate source request perSourceLimit', 100);
  const totalCandidateLimit = requirePositiveInteger(request.totalCandidateLimit ?? 50, 'candidate source request totalCandidateLimit', 200);
  requireIsoTimestamp(request.trustedTimestamp, 'candidate source request trustedTimestamp');
  return {
    ...request,
    id: request.id ?? request.requestId,
    requiredIds,
    requiredEntities,
    allowedDataClasses,
    allowedTrustClasses,
    allowedScopes,
    perSourceLimit,
    totalCandidateLimit,
    sourcePlan: normalizeSourcePlan(request.sourcePlan, { requiredIds, perSourceLimit })
  };
}

function normalizeSourcePlan(sourcePlan, { requiredIds, perSourceLimit }) {
  const plan = sourcePlan ?? [
    ...(requiredIds.length ? [{ kind: 'exact', required: true }] : []),
    { kind: 'lexical', required: false }
  ];
  if (!Array.isArray(plan)) throw new TypeError('candidate source request sourcePlan:array_required');
  if (plan.length > MAX_SOURCE_COUNT) throw new TypeError('candidate source request sourcePlan:too_many');
  const seen = new Set();
  const normalized = plan.map((entry) => {
    assertPlainObject(entry, 'candidate source plan entry');
    assertNoUnknown(entry, SOURCE_PLAN_KEYS, 'candidate source plan entry');
    if (!CANDIDATE_SOURCE_KINDS.includes(entry.kind)) throw new TypeError(`unknown_candidate_source_kind:${entry.kind}`);
    if (seen.has(entry.kind)) throw new TypeError(`duplicate_source_kind:${entry.kind}`);
    seen.add(entry.kind);
    return {
      kind: entry.kind,
      sourceId: entry.sourceId ?? null,
      required: entry.required === true,
      limit: requirePositiveInteger(entry.limit ?? perSourceLimit, 'candidate source plan limit', perSourceLimit),
      timeoutMs: requirePositiveInteger(entry.timeoutMs ?? 1000, 'candidate source plan timeoutMs', 30_000)
    };
  });
  if (requiredIds.length) {
    const exact = normalized.find((entry) => entry.kind === 'exact');
    if (!exact || exact.required !== true) throw new TypeError('required_ids_require_exact_source');
  }
  return normalized;
}

export function createCandidateSourceRegistry(sources = []) {
  if (!Array.isArray(sources)) throw new TypeError('candidate sources must be an array');
  const byId = new Map();
  const byKind = new Map();
  for (const source of sources) {
    if (!source || typeof source.descriptor !== 'function' || typeof source.health !== 'function' || typeof source.query !== 'function') {
      throw new TypeError('candidate_source_invalid:missing_port_method');
    }
    const descriptor = validateCandidateSourceDescriptor(source.descriptor());
    if (byId.has(descriptor.id)) throw new Error(`duplicate_candidate_source:${descriptor.id}`);
    byId.set(descriptor.id, { source, descriptor });
    if (descriptor.enabled !== false) {
      const values = byKind.get(descriptor.kind) ?? [];
      values.push({ source, descriptor });
      values.sort((a, b) => a.descriptor.id.localeCompare(b.descriptor.id));
      byKind.set(descriptor.kind, values);
    }
  }
  return Object.freeze({
    list: () => [...byId.values()].map((item) => item.descriptor),
    get: (id) => byId.get(id)?.source ?? null,
    getByKind: (kind) => byKind.get(kind)?.map((item) => item.source) ?? [],
    descriptorFor: (source) => validateCandidateSourceDescriptor(source.descriptor()),
    async health() {
      const results = [];
      for (const { source, descriptor } of byId.values()) results.push({ sourceId: descriptor.id, sourceKind: descriptor.kind, ...await source.health() });
      return results.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
    }
  });
}

function validateCandidateSourceDescriptor(descriptor) {
  assertPlainObject(descriptor, 'candidate source descriptor');
  assertNoUnknown(descriptor, SOURCE_DESCRIPTOR_KEYS, 'candidate source descriptor');
  if (descriptor.schemaVersion !== '1.0.0') throw new TypeError('candidate_source_descriptor_invalid:schemaVersion');
  requireString(descriptor.id, 'candidate source descriptor id', { maxBytes: 160, pattern: /^provider:native:context-candidate:[a-z0-9-]+$/ });
  if (!CANDIDATE_SOURCE_KINDS.includes(descriptor.kind)) throw new TypeError(`unknown_candidate_source_kind:${descriptor.kind}`);
  requireString(descriptor.version, 'candidate source descriptor version', { maxBytes: 32 });
  if (descriptor.enabled !== undefined && typeof descriptor.enabled !== 'boolean') throw new TypeError('candidate_source_descriptor_invalid:enabled');
  if (!Array.isArray(descriptor.methods) || descriptor.methods.length < 1 || descriptor.methods.some((method) => typeof method !== 'string' || !method)) {
    throw new TypeError('candidate_source_descriptor_invalid:methods');
  }
  return Object.freeze({ enabled: true, ...descriptor });
}

export function createFixtureRecordReader(inputRecords = []) {
  if (!Array.isArray(inputRecords)) throw new TypeError('fixture records must be an array');
  const records = inputRecords.map((record) => normalizeRecord(record));
  function visible(record, { workspaceId, allowedScopes = ['public', 'workspace-private'], statuses = ['active', 'verified'], at = fixedDate() } = {}) {
    if (record.workspaceId && record.workspaceId !== workspaceId) return false;
    if (!allowedScopes.includes(record.scope ?? 'workspace-private')) return false;
    if (!statuses.includes(record.status ?? 'active')) return false;
    const now = new Date(at);
    return isTemporallyValid(record, now);
  }
  return Object.freeze({
    async getManyByIds({ workspaceId, ids, allowedScopes, statuses, at, signal } = {}) {
      throwIfAborted(signal);
      const wanted = new Set(ids ?? []);
      return records.filter((record) => wanted.has(record.id) && visible(record, { workspaceId, allowedScopes, statuses, at }));
    },
    async searchLexical({ workspaceId, query, limit = 20, allowedScopes, statuses, at, signal } = {}) {
      throwIfAborted(signal);
      return records
        .filter((record) => visible(record, { workspaceId, allowedScopes, statuses, at }))
        .map((record) => ({ record, score: overlapScore(query, { ...record, text: lexicalRecordText(record) }) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id))
        .slice(0, limit)
        .map((item, index) => ({ ...item.record, metadata: { ...(item.record.metadata ?? {}), retrieval: { ...(item.record.metadata?.retrieval ?? {}), lexicalScore: item.score, localRank: index + 1 } } }));
    }
  });
}

function fixedDate() {
  return '1970-01-01T00:00:00.000Z';
}

export function createNativeExactCandidateSource() {
  return Object.freeze({
    descriptor: () => ({
      schemaVersion: '1.0.0',
      id: 'provider:native:context-candidate:exact',
      kind: 'exact',
      version: '1.0.0',
      enabled: true,
      methods: ['id_lookup'],
      contractVersion: '1.0.0',
      description: 'Workspace-scoped exact candidate lookup by canonical record id'
    }),
    health: async () => ({ status: 'healthy' }),
    async query(request, trustedContext) {
      const ids = [...new Set(request.requiredIds)];
      const rows = ids.length
        ? await trustedContext.recordReader.getManyByIds({
          workspaceId: request.workspaceId,
          ids,
          allowedScopes: request.allowedScopes,
          statuses: ['active', 'verified'],
          at: request.trustedTimestamp,
          signal: trustedContext.signal
        })
        : [];
      const byId = new Map(rows.map((record) => [record.id, record]));
      return {
        unresolvedCount: ids.filter((id) => !byId.has(id)).length,
        candidates: ids.filter((id) => byId.has(id)).map((id, index) => ({
          record: byId.get(id),
          sourceHit: {
            sourceId: 'provider:native:context-candidate:exact',
            sourceKind: 'exact',
            sourceVersion: '1.0.0',
            retrievalMethod: 'id_lookup',
            localRank: index + 1,
            localScore: 1,
            reasonCodes: ['exact_id_match'],
            queryFingerprint: trustedContext.queryFingerprint,
            accessDecisionRef: trustedContext.accessDecisionRef,
            retrievedAt: trustedContext.retrievedAt
          }
        }))
      };
    }
  });
}

export function createNativeLexicalCandidateSource() {
  return Object.freeze({
    descriptor: () => ({
      schemaVersion: '1.0.0',
      id: 'provider:native:context-candidate:lexical',
      kind: 'lexical',
      version: '1.0.0',
      enabled: true,
      methods: ['term_overlap'],
      contractVersion: '1.0.0',
      description: 'Workspace-scoped lexical candidate lookup over safe record fields'
    }),
    health: async () => ({ status: 'healthy' }),
    async query(request, trustedContext) {
      const query = `${request.objective} ${request.step} ${request.requiredEntities.join(' ')}`;
      const rows = await trustedContext.recordReader.searchLexical({
        workspaceId: request.workspaceId,
        query,
        limit: trustedContext.sourceLimit ?? request.perSourceLimit,
        allowedScopes: request.allowedScopes,
        statuses: ['active', 'verified'],
        at: request.trustedTimestamp,
        signal: trustedContext.signal
      });
      return {
        candidates: rows.map((record, index) => ({
          record,
          sourceHit: {
            sourceId: 'provider:native:context-candidate:lexical',
            sourceKind: 'lexical',
            sourceVersion: '1.0.0',
            retrievalMethod: 'term_overlap',
            localRank: index + 1,
            localScore: Math.max(0, Math.min(1, Number(record.metadata?.retrieval?.lexicalScore ?? 0))),
            reasonCodes: ['lexical_match'],
            queryFingerprint: trustedContext.queryFingerprint,
            accessDecisionRef: trustedContext.accessDecisionRef,
            retrievedAt: trustedContext.retrievedAt
          }
        }))
      };
    }
  });
}

export async function generateContextCandidates(request, {
  registry = createCandidateSourceRegistry([createNativeExactCandidateSource(), createNativeLexicalCandidateSource()]),
  recordReader,
  policyService = null,
  trustedContext = {},
  clock = nowIso,
  signal = null
} = {}) {
  const candidateRequest = validateCandidateSourceRequest(request);
  if (!recordReader) throw new TypeError('recordReader is required');
  const reports = [];
  const warnings = new Set();
  const candidateMap = new Map();
  let successfulSources = 0;

  for (const planEntry of candidateRequest.sourcePlan) {
    throwIfAborted(signal);
    const source = resolvePlanSource(registry, planEntry);
    if (!source) {
      const report = sourceReport(candidateRequest, planEntry, { status: 'unavailable', failureCode: 'source_unavailable', clock });
      reports.push(report);
      warnings.add('candidate_source_unavailable');
      if (planEntry.required) throw sourceError('candidate_source_required_unavailable', reports, warnings);
      continue;
    }
    const descriptor = registry.descriptorFor(source);
    const retrievedAt = safeNow(clock);
    const access = await evaluateSourceAccess({ request: candidateRequest, descriptor, policyService, trustedContext, retrievedAt });
    if (access.outcome !== 'allow') {
      const report = sourceReport(candidateRequest, planEntry, { descriptor, status: 'denied', deniedCount: candidateRequest.requiredIds.length, failureCode: 'candidate_source_required_denied', accessDecisionRef: access.decisionId, clock });
      reports.push(report);
      warnings.add('candidate_source_denied');
      if (planEntry.required) throw sourceError('candidate_source_required_denied', reports, warnings);
      continue;
    }
    let output;
    try {
      output = await withTimeout(
        (childSignal) => source.query(candidateRequest, {
          ...trustedContext,
          recordReader,
          queryFingerprint: queryFingerprintFor(candidateRequest, planEntry),
          accessDecisionRef: access.decisionId,
          retrievedAt,
          sourceLimit: planEntry.limit,
          signal: childSignal
        }),
        { timeoutMs: planEntry.timeoutMs, parentSignal: signal }
      );
    } catch (error) {
      const status = error?.name === 'AbortError' ? 'cancelled' : error?.code === 'candidate_source_timed_out' ? 'timed_out' : 'failed';
      const failureCode = status === 'timed_out' ? 'candidate_source_timed_out' : status === 'cancelled' ? 'candidate_source_cancelled' : 'candidate_source_failed';
      const report = sourceReport(candidateRequest, planEntry, { descriptor, status, failureCode, accessDecisionRef: access.decisionId, clock });
      reports.push(report);
      warnings.add(failureCode === 'candidate_source_failed' ? 'candidate_source_failed' : failureCode);
      if (planEntry.required) throw sourceError(status === 'cancelled' ? 'candidate_source_cancelled' : 'candidate_source_required_failed', reports, warnings);
      continue;
    }
    const report = await mergeSourceOutput({ output, descriptor, request: candidateRequest, planEntry, candidateMap, policyService, trustedContext, accessDecisionRef: access.decisionId, clock });
    reports.push(report);
    if (report.status !== 'succeeded') {
      warnings.add(report.failureCode ?? 'candidate_source_failed');
      if (planEntry.required) throw sourceError('candidate_source_required_failed', reports, warnings);
    } else {
      successfulSources += 1;
    }
  }

  const candidates = [...candidateMap.values()]
    .sort((a, b) => a.record.id.localeCompare(b.record.id))
    .slice(0, candidateRequest.totalCandidateLimit)
    .map((candidate) => ({
      ...candidate,
      hits: candidate.hits.sort(compareHits)
    }));
  if (!successfulSources && !candidates.length) throw sourceError('candidate_generation_unavailable', reports, warnings);
  return {
    schemaVersion: '1.0.0',
    requestId: candidateRequest.requestId,
    workspaceId: candidateRequest.workspaceId,
    status: 'succeeded',
    candidates,
    reports,
    warnings: [...warnings].sort()
  };
}

export async function compileContextFromSources(request, options = {}) {
  const candidateGeneration = await generateContextCandidates(request, options);
  return {
    schemaVersion: '1.0.0',
    manifest: compileContext(request, candidateGeneration.candidates.map((candidate) => candidate.record)),
    candidateGeneration
  };
}

function resolvePlanSource(registry, planEntry) {
  if (planEntry.sourceId) return registry.get(planEntry.sourceId);
  return registry.getByKind(planEntry.kind)[0] ?? null;
}

function sourceReport(request, planEntry, { descriptor = null, status, failureCode = null, candidateCount = 0, deniedCount = 0, unresolvedCount = 0, accessDecisionRef = null, clock }) {
  if (!CANDIDATE_SOURCE_STATUSES.includes(status)) throw new TypeError(`candidate source status invalid:${status}`);
  return {
    schemaVersion: '1.0.0',
    requestId: request.requestId,
    sourceId: descriptor?.id ?? planEntry.sourceId ?? `source:${planEntry.kind}:unavailable`,
    sourceKind: descriptor?.kind ?? planEntry.kind,
    sourceVersion: descriptor?.version ?? null,
    required: planEntry.required,
    status,
    failureCode,
    candidateCount,
    deniedCount,
    unresolvedCount,
    accessDecisionRef,
    reportedAt: safeNow(clock)
  };
}

function sourceError(code, reports, warnings) {
  const error = new Error(code);
  error.code = code;
  error.reports = reports;
  error.warnings = [...warnings].sort();
  return error;
}

async function evaluateSourceAccess({ request, descriptor, policyService, trustedContext, retrievedAt }) {
  if (!policyService?.evaluate) return { outcome: 'allow', decisionId: 'poldet_unconfigured', reasonCodes: [], evaluatedAt: retrievedAt };
  return policyService.evaluate({
    schemaVersion: '1.0.0',
    requestId: `polreq_${request.requestId}_${descriptor.kind}`,
    correlationId: request.correlationId,
    operationId: `contextCandidate:${descriptor.kind}`,
    principal: trustedContext.principal ?? null,
    workspaceId: request.workspaceId,
    membership: trustedContext.membership ?? null,
    action: 'context.compile',
    resource: { type: 'context', id: request.requestId, workspaceId: request.workspaceId, dataClass: 'workspace-private' },
    environment: trustedContext.environment ?? { deploymentProfile: 'local-dev', locality: 'local-only', interactive: true, externalWritesEnabled: false },
    trustedTimestamp: request.trustedTimestamp
  });
}

async function evaluateRecordAccess({ record, request, policyService, trustedContext, clock }) {
  if (record.workspaceId && record.workspaceId !== request.workspaceId) return { outcome: 'deny', decisionId: null, reasonCodes: ['workspace_mismatch'] };
  const dataClass = record.dataClass ?? record.metadata?.dataClass ?? 'workspace-private';
  if (!request.allowedDataClasses.includes(dataClass)) return { outcome: 'deny', decisionId: null, reasonCodes: ['data_class_denied'] };
  const trustClass = record.trustClass ?? record.metadata?.trustClass ?? 'observed';
  if (!request.allowedTrustClasses.includes(trustClass)) return { outcome: 'deny', decisionId: null, reasonCodes: ['trust_class_denied'] };
  if (!policyService?.evaluate) return { outcome: dataClass === 'secret' ? 'deny' : 'allow', decisionId: 'poldet_unconfigured', reasonCodes: dataClass === 'secret' ? ['data_class_denied'] : [] };
  return policyService.evaluate({
    schemaVersion: '1.0.0',
    requestId: `polreq_${request.requestId}_${record.id}`,
    correlationId: request.correlationId,
    operationId: `contextCandidate:record:${record.id}`,
    principal: trustedContext.principal ?? null,
    workspaceId: request.workspaceId,
    membership: trustedContext.membership ?? null,
    action: 'context.compile',
    resource: { type: 'context', id: record.id, workspaceId: record.workspaceId ?? request.workspaceId, dataClass },
    environment: trustedContext.environment ?? { deploymentProfile: 'local-dev', locality: 'local-only', interactive: true, externalWritesEnabled: false },
    trustedTimestamp: request.trustedTimestamp
  });
}

async function mergeSourceOutput({ output, descriptor, request, planEntry, candidateMap, policyService, trustedContext, accessDecisionRef, clock }) {
  if (!output || typeof output !== 'object' || !Array.isArray(output.candidates)) {
    return sourceReport(request, planEntry, { descriptor, status: 'invalid_output', failureCode: 'invalid_candidate_output', accessDecisionRef, clock });
  }
  let candidateCount = 0;
  let deniedCount = 0;
  let totalBytes = 0;
  const seenHits = new Set();
  for (const item of output.candidates) {
    try {
      const candidate = validateCandidateItem(item, descriptor, request);
      const access = await evaluateRecordAccess({ record: candidate.record, request, policyService, trustedContext, clock });
      if (access.outcome !== 'allow') {
        deniedCount += 1;
        continue;
      }
      totalBytes += byteLength(candidate.record.text);
      if (totalBytes > MAX_TOTAL_CANDIDATE_BYTES) return sourceReport(request, planEntry, { descriptor, status: 'invalid_output', failureCode: 'invalid_candidate_output', deniedCount, accessDecisionRef, clock });
      const hitKey = `${candidate.record.id}:${candidate.hit.sourceId}:${candidate.hit.retrievalMethod}:${candidate.hit.localRank}`;
      if (seenHits.has(hitKey)) continue;
      seenHits.add(hitKey);
      upsertCandidate(candidateMap, candidate);
      candidateCount += 1;
    } catch (error) {
      if (error?.code === 'candidate_identity_conflict') throw error;
      return sourceReport(request, planEntry, { descriptor, status: 'invalid_output', failureCode: 'invalid_candidate_output', deniedCount, accessDecisionRef, clock });
    }
  }
  return sourceReport(request, planEntry, { descriptor, status: 'succeeded', candidateCount, deniedCount, unresolvedCount: Number(output.unresolvedCount ?? 0), accessDecisionRef, clock });
}

function validateCandidateItem(item, descriptor, request) {
  assertPlainObject(item, 'candidate source output item');
  const record = normalizeRecord(item.record);
  requireString(record.id, 'candidate record id', { maxBytes: 256, pattern: /^[a-z][a-z0-9_.:-]*$/ });
  requireString(record.kind, 'candidate record kind', { maxBytes: 64 });
  requireString(record.text, 'candidate record text', { maxBytes: MAX_CANDIDATE_TEXT_BYTES });
  const hit = validateSourceHit(item.sourceHit ?? item.hit, descriptor);
  return {
    schemaVersion: '1.0.0',
    record: {
      ...record,
      workspaceId: record.workspaceId ?? request.workspaceId,
      dataClass: record.dataClass ?? record.metadata?.dataClass ?? 'workspace-private',
      trustClass: record.trustClass ?? record.metadata?.trustClass ?? 'observed',
      contentHash: recordFingerprint(record)
    },
    hit
  };
}

function validateSourceHit(hit, descriptor) {
  assertPlainObject(hit, 'candidate source hit');
  assertNoUnknown(hit, SOURCE_HIT_KEYS, 'candidate source hit');
  if (hit.sourceId !== descriptor.id || hit.sourceKind !== descriptor.kind || hit.sourceVersion !== descriptor.version) throw new TypeError('candidate_source_hit:descriptor_mismatch');
  requireString(hit.retrievalMethod, 'candidate source hit retrievalMethod', { maxBytes: 64 });
  requirePositiveInteger(hit.localRank, 'candidate source hit localRank', 10_000);
  if (!Number.isFinite(hit.localScore) || hit.localScore < 0 || hit.localScore > 1) throw new TypeError('candidate_source_hit:score_invalid');
  normalizeStringArray(hit.reasonCodes, 'candidate source hit reasonCodes', { max: 16, pattern: /^[a-z][a-z0-9_:-]*$/ });
  requireString(hit.queryFingerprint, 'candidate source hit queryFingerprint', { maxBytes: 80, pattern: /^sha256:[a-f0-9]{64}$/ });
  requireString(hit.accessDecisionRef, 'candidate source hit accessDecisionRef', { maxBytes: 128, pattern: /^[a-z][a-z0-9_-]*$/ });
  requireIsoTimestamp(hit.retrievedAt, 'candidate source hit retrievedAt');
  return {
    sourceId: hit.sourceId,
    sourceKind: hit.sourceKind,
    sourceVersion: hit.sourceVersion,
    retrievalMethod: hit.retrievalMethod,
    localRank: hit.localRank,
    localScore: Number(hit.localScore.toFixed(6)),
    reasonCodes: [...new Set(hit.reasonCodes)].sort(),
    queryFingerprint: hit.queryFingerprint,
    accessDecisionRef: hit.accessDecisionRef,
    retrievedAt: hit.retrievedAt
  };
}

function upsertCandidate(candidateMap, candidate) {
  const key = candidate.record.id;
  const existing = candidateMap.get(key);
  if (!existing) {
    candidateMap.set(key, { schemaVersion: '1.0.0', record: candidate.record, hits: [candidate.hit] });
    return;
  }
  const existingHash = existing.record.contentHash;
  if (existingHash !== candidate.record.contentHash || (existing.record.version ?? null) !== (candidate.record.version ?? null)) {
    const error = new Error('candidate_identity_conflict');
    error.code = 'candidate_identity_conflict';
    throw error;
  }
  if (existing.hits.length >= MAX_HITS_PER_CANDIDATE) return;
  const hitKey = (hit) => `${hit.sourceId}:${hit.retrievalMethod}:${hit.localRank}:${hit.queryFingerprint}`;
  if (!existing.hits.some((hit) => hitKey(hit) === hitKey(candidate.hit))) existing.hits.push(candidate.hit);
}

function compareHits(a, b) {
  return a.sourceKind.localeCompare(b.sourceKind) || a.sourceId.localeCompare(b.sourceId) || a.localRank - b.localRank || a.retrievalMethod.localeCompare(b.retrievalMethod);
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error('candidate_source_cancelled');
    error.name = 'AbortError';
    throw error;
  }
}

async function withTimeout(callback, { timeoutMs, parentSignal = null }) {
  throwIfAborted(parentSignal);
  const controller = new AbortController();
  const onAbort = () => controller.abort(parentSignal.reason);
  if (parentSignal) parentSignal.addEventListener('abort', onAbort, { once: true });
  let timer;
  try {
    return await Promise.race([
      callback(controller.signal),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          const error = new Error('candidate_source_timed_out');
          error.code = 'candidate_source_timed_out';
          reject(error);
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
    if (parentSignal) parentSignal.removeEventListener('abort', onAbort);
  }
}

export function compileContext(request,inputRecords) {
  assertPlainObject(request,'request');
  if (!request.objective || !request.step) throw new Error('objective and step are required');
  if (!Number.isInteger(request.tokenBudget) || request.tokenBudget < 1) throw new Error('tokenBudget must be positive');
  if (!Array.isArray(inputRecords)) throw new TypeError('records must be an array');
  const now=new Date(request.now??Date.now()); if (Number.isNaN(now.getTime())) throw new Error('now must be valid');
  const allowedScopes=new Set(request.allowedScopes??['public','workspace-private']);
  const requiredIds=new Set(request.requiredIds??[]), requiredEntities=new Set(request.requiredEntities??[]);
  const records=inputRecords.map(normalizeRecord), supersededIds=new Set(records.map(record=>record.supersedes).filter(Boolean));
  const excluded=[], eligible=[];
  for (const record of records) {
    const reasons=[];
    if (!allowedScopes.has(record.scope)) reasons.push('scope_denied');
    if (record.metadata?.retrieval?.candidateEligible===false) reasons.push('candidate_ineligible');
    if (['expired','retracted','quarantined','superseded'].includes(record.status)) reasons.push(`status_${record.status}`);
    if (supersededIds.has(record.id)) reasons.push('superseded_by_newer_record');
    if (!isTemporallyValid(record,now)) reasons.push('outside_valid_time');
    if (reasons.length) excluded.push({id:record.id,kind:record.kind,tokens:record.tokens,score:0,reasonCodes:reasons,source:record.source}); else eligible.push(record);
  }
  const query=`${request.objective} ${request.step} ${(request.requiredEntities??[]).join(' ')}`;
  const scored=eligible.map(record=>{
    const forced=requiredIds.has(record.id)||['policy','constraint'].includes(record.kind);
    const entityMatches=(record.relations??[]).filter(value=>requiredEntities.has(value)).length+(record.tags??[]).filter(value=>requiredEntities.has(value)).length;
    const lexical=overlapScore(query,record), recency=temporalScore(record,now);
    const confidence=Math.max(0,Math.min(1,Number(record.confidence??.5))), authority=Math.max(0,Math.min(1,Number(record.authority??.5)));
    const relation=Math.min(1,entityMatches/Math.max(1,requiredEntities.size));
    const retrieval=record.metadata?.retrieval??{};
    const importance=Math.max(0,Math.min(1,Number(record.importance??retrieval.importance??0)));
    const outcomeEvidence=Math.max(0,Math.min(1,Number(record.outcomeEvidence??retrieval.outcomeEvidence??0)));
    const retrievalPenalty=Math.max(0,Math.min(1,Number(record.retrievalPenalty??retrieval.retrievalPenalty??0)));
    const score=forced?1000:(lexical*5)+(relation*3)+authority+confidence+(recency*.75)+(importance*2.5)+(outcomeEvidence*1.5)-(retrievalPenalty*4);
    const reasonCodes=[];
    if (forced) reasonCodes.push(requiredIds.has(record.id)?'explicit_requirement':'forced_governance');
    if (lexical>0) reasonCodes.push('task_relevance');
    if (relation>0) reasonCodes.push('entity_relation');
    if (recency>.7) reasonCodes.push('recent');
    if (authority>=.8) reasonCodes.push('high_authority');
    if (confidence>=.8) reasonCodes.push('high_confidence');
    if (importance>=.7) reasonCodes.push('high_importance');
    if (outcomeEvidence>=.6) reasonCodes.push('outcome_evidence');
    if (retrievalPenalty>0) reasonCodes.push('retrieval_penalty');
    return {record,score,forced,relevant:lexical>0||relation>0,reasonCodes};
  }).sort((a,b)=>b.score-a.score||a.record.id.localeCompare(b.record.id));
  const selected=[], selectedKinds=new Map(); let used=0;
  for (const item of scored.filter(item=>item.forced)) {
    const tokens=item.record.tokens;
    if (used+tokens>request.tokenBudget) excluded.push({id:item.record.id,kind:item.record.kind,tokens,score:item.score,reasonCodes:['required_but_over_budget'],source:item.record.source});
    else { selected.push(decision(item)); used+=tokens; selectedKinds.set(item.record.kind,(selectedKinds.get(item.record.kind)??0)+1); }
  }
  const remaining=scored.filter(item=>!item.forced).map(item=>({...item,adjustedScore:item.score-((selectedKinds.get(item.record.kind)??0)*.35)})).sort((a,b)=>b.adjustedScore-a.adjustedScore||a.record.id.localeCompare(b.record.id));
  for (const item of remaining) {
    const tokens=item.record.tokens;
    if (!item.relevant||item.score<=.05) excluded.push({id:item.record.id,kind:item.record.kind,tokens,score:item.score,reasonCodes:['insufficient_relevance'],source:item.record.source});
    else if (used+tokens>request.tokenBudget) excluded.push({id:item.record.id,kind:item.record.kind,tokens,score:item.score,reasonCodes:['token_budget'],source:item.record.source});
    else { const picked=decision(item); picked.reasonCodes.push((selectedKinds.get(item.record.kind)??0)>0?'selected_despite_kind_overlap':'diversity_gain'); selected.push(picked); used+=tokens; selectedKinds.set(item.record.kind,(selectedKinds.get(item.record.kind)??0)+1); }
  }
  const requiredOverBudget=excluded.filter(item=>item.reasonCodes.includes('required_but_over_budget'));
  return {schemaVersion:'1.0.0',id:prefixedId('ctx'),workspaceId:request.workspaceId??'ws_local',requestId:request.id??null,compilerVersion:COMPILER_VERSION,createdAt:nowIso(),budget:{available:request.tokenBudget,used},selected,excluded:excluded.sort((a,b)=>a.id.localeCompare(b.id)),conflicts:detectConflicts(eligible),warnings:requiredOverBudget.length?['required_governance_exceeded_budget']:[]};
}
