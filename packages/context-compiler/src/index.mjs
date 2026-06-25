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

export const CANDIDATE_SOURCE_KINDS = Object.freeze(['exact', 'lexical', 'ast-code', 'vector', 'graph', 'temporal', 'preference', 'episode']);
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

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function hashRef(value) {
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
  const metadata = record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
    ? { ...record.metadata }
    : {};
  delete metadata.contentHash;
  delete metadata.fingerprint;
  delete metadata.retrieval;
  return hashRef(stableStringify({
    id: record.id,
    version: record.version ?? null,
    kind: record.kind,
    text: record.text,
    tags: record.tags ?? [],
    relations: record.relations ?? [],
    updatedAt: record.updatedAt ?? null,
    metadata
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
  const selected = selectContextCandidates(request, candidateGeneration.candidates, {
    candidateGeneration,
    warnings: candidateGeneration.warnings
  });
  return {
    schemaVersion: '1.0.0',
    manifest: selected.manifest,
    candidateGeneration,
    selection: selected.selection
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

export const SELECTION_REASON_CODES = Object.freeze([
  'required',
  'explicit_requirement',
  'mandatory_constraint',
  'forced_governance',
  'entity_coverage',
  'complementary_evidence',
  'high_task_relevance',
  'task_relevance',
  'preference_applicable',
  'active_working_state',
  'source_fusion',
  'entity_relation',
  'high_authority',
  'high_confidence',
  'high_importance',
  'outcome_evidence',
  'token_efficient',
  'diversity_gain',
  'selected_despite_kind_overlap'
]);

export const EXCLUSION_REASON_CODES = Object.freeze([
  'policy_denied',
  'workspace_mismatch',
  'scope_denied',
  'data_class_denied',
  'secret_context_denied',
  'trust_class_denied',
  'expired',
  'not_yet_valid',
  'outside_valid_time',
  'superseded',
  'superseded_by_newer_record',
  'retracted',
  'quarantined',
  'status_expired',
  'status_retracted',
  'status_quarantined',
  'status_superseded',
  'candidate_identity_conflict',
  'below_minimum_utility',
  'insufficient_relevance',
  'insufficient_marginal_utility',
  'redundant',
  'category_cap',
  'token_budget',
  'required_but_over_budget',
  'maximum_candidate_count',
  'unresolved_required_record',
  'malformed_candidate',
  'candidate_ineligible'
]);

export const CONTEXT_SELECTION_POLICY = deepFreeze({
  schemaVersion: '1.0.0',
  policyVersion: '1.0.0',
  fusion: {
    method: 'weighted_rrf',
    rrfK: 60
  },
  sourceWeights: {
    direct: 2,
    exact: 8,
    lexical: 4,
    'ast-code': 4,
    vector: 3,
    graph: 3,
    temporal: 2,
    preference: 2,
    episode: 2
  },
  featureWeights: {
    sourceFusion: 12,
    objectiveRelevance: 4,
    stepRelevance: 2,
    entityCoverage: 4,
    relationCoverage: 2,
    authority: 1,
    confidence: 1,
    preferenceApplicable: 1.5,
    outcomeEvidence: 1.5,
    temporalApplicability: 0.5,
    kindPriority: 1.5,
    tokenEfficiency: 1
  },
  diversity: {
    method: 'bounded_mmr',
    diversityWeight: 1.25,
    coverageBonus: 0.75,
    kindCoverageBonus: 0.15,
    duplicateSimilarityThreshold: 0.92,
    nearDuplicateSimilarityThreshold: 0.72
  },
  similarity: {
    normalization: 'unicode_nfkc_lower_ascii_terms',
    shingleSize: 3,
    maxTextBytes: 4096,
    minTokenLength: 2,
    maxTokens: 256,
    maxPairwiseComparisons: 2000
  },
  categoryBudgets: {
    governance: { cap: 6, softReserveRatio: 0.15 },
    workingState: { cap: 4, softReserveRatio: 0.15 },
    decisions: { cap: 4, softReserveRatio: 0.1 },
    preferences: { cap: 3, softReserveRatio: 0.05 },
    evidence: { cap: 4, softReserveRatio: 0.35 },
    procedures: { cap: 3, softReserveRatio: 0.05 },
    episodes: { cap: 3, softReserveRatio: 0.05 },
    artifacts: { cap: 3, softReserveRatio: 0.05 },
    negative: { cap: 2, softReserveRatio: 0 },
    examples: { cap: 2, softReserveRatio: 0.05 },
    other: { cap: 2, softReserveRatio: 0.05 }
  },
  thresholds: {
    minimumUtility: 0.35,
    marginalUtility: 0.2,
    minimumEvidenceCount: 2
  },
  limits: {
    maxSelectedCandidates: 12,
    maxCandidates: 200,
    maxSourceHitsPerCandidate: 16,
    maxScoreFactorsPerCandidate: 16,
    maxCandidateTokens: 8192,
    maxTotalCandidateTokens: 50000,
    requiredBudgetRatio: 1
  },
  tokenEstimation: {
    method: 'ceil_chars_div_4',
    zeroTokensAllowed: false
  },
  tieBreak: [
    'required_first',
    'utility_desc',
    'tokens_asc',
    'record_id_asc'
  ]
});

const SELECTION_POLICY_KEYS = new Set([
  'schemaVersion',
  'policyVersion',
  'fusion',
  'sourceWeights',
  'featureWeights',
  'diversity',
  'similarity',
  'categoryBudgets',
  'thresholds',
  'limits',
  'tokenEstimation',
  'tieBreak'
]);
const FUSION_KEYS = new Set(['method', 'rrfK']);
const DIVERSITY_KEYS = new Set(['method', 'diversityWeight', 'coverageBonus', 'kindCoverageBonus', 'duplicateSimilarityThreshold', 'nearDuplicateSimilarityThreshold']);
const SIMILARITY_KEYS = new Set(['normalization', 'shingleSize', 'maxTextBytes', 'minTokenLength', 'maxTokens', 'maxPairwiseComparisons']);
const THRESHOLD_KEYS = new Set(['minimumUtility', 'marginalUtility', 'minimumEvidenceCount']);
const LIMIT_KEYS = new Set(['maxSelectedCandidates', 'maxCandidates', 'maxSourceHitsPerCandidate', 'maxScoreFactorsPerCandidate', 'maxCandidateTokens', 'maxTotalCandidateTokens', 'requiredBudgetRatio']);
const TOKEN_ESTIMATION_KEYS = new Set(['method', 'zeroTokensAllowed']);
const CATEGORY_BUDGET_KEYS = new Set(['cap', 'softReserveRatio']);
const SOURCE_WEIGHT_KEYS = new Set(['direct', ...CANDIDATE_SOURCE_KINDS]);
const FEATURE_WEIGHT_KEYS = new Set([
  'sourceFusion',
  'objectiveRelevance',
  'stepRelevance',
  'entityCoverage',
  'relationCoverage',
  'authority',
  'confidence',
  'preferenceApplicable',
  'outcomeEvidence',
  'temporalApplicability',
  'kindPriority',
  'tokenEfficiency'
]);
const CATEGORY_NAMES = Object.freeze(['governance', 'workingState', 'decisions', 'preferences', 'evidence', 'procedures', 'episodes', 'artifacts', 'negative', 'examples', 'other']);
export const ASSEMBLY_SECTION_ORDER = Object.freeze(['governance', 'negative', 'decisions', 'preferences', 'procedures', 'evidence', 'episodes', 'artifacts', 'examples', 'other', 'workingState']);
export const CONTEXT_REPRESENTATION_TIERS = Object.freeze(['full', 'snippet', 'outline', 'locator-only', 'excluded']);
export const CONTEXT_ASSEMBLY_POLICY = deepFreeze({
  schemaVersion: '1.0.0',
  policyVersion: '1.0.0',
  sectionOrder: ASSEMBLY_SECTION_ORDER,
  representationTiers: CONTEXT_REPRESENTATION_TIERS,
  tokenAccounting: 'sum_selected_estimated_tokens',
  selectedText: 'preserve_exact_selected_text',
  excludedText: 'omit_from_durable_manifest',
  fingerprintAlgorithm: 'sha256_canonical_json'
});
const LEGACY_CONTEXT_ASSEMBLY_POLICY = deepFreeze({
  schemaVersion: '1.0.0',
  policyVersion: '1.0.0',
  sectionOrder: ASSEMBLY_SECTION_ORDER,
  tokenAccounting: 'sum_selected_estimated_tokens',
  selectedText: 'preserve_exact_selected_text',
  excludedText: 'omit_from_durable_manifest',
  fingerprintAlgorithm: 'sha256_canonical_json'
});

export function validateContextSelectionPolicy(policy = CONTEXT_SELECTION_POLICY) {
  try {
    assertPlainObject(policy, 'context selection policy');
    assertNoUnknown(policy, SELECTION_POLICY_KEYS, 'context selection policy');
    if (policy.schemaVersion !== '1.0.0') throw new Error('schemaVersion');
    if (!/^\d+\.\d+\.\d+$/.test(policy.policyVersion)) throw new Error('policyVersion');
    assertPlainObject(policy.fusion, 'context selection policy fusion');
    assertNoUnknown(policy.fusion, FUSION_KEYS, 'context selection policy fusion');
    if (policy.fusion.method !== 'weighted_rrf') throw new Error('fusion.method');
    assertIntegerInRange(policy.fusion.rrfK, 1, 1000, 'fusion.rrfK');
    validateNumericMap(policy.sourceWeights, SOURCE_WEIGHT_KEYS, 'sourceWeights', { min: 0, max: 100 });
    validateNumericMap(policy.featureWeights, FEATURE_WEIGHT_KEYS, 'featureWeights', { min: 0, max: 100 });
    assertPlainObject(policy.diversity, 'context selection policy diversity');
    assertNoUnknown(policy.diversity, DIVERSITY_KEYS, 'context selection policy diversity');
    if (policy.diversity.method !== 'bounded_mmr') throw new Error('diversity.method');
    for (const key of ['diversityWeight', 'coverageBonus', 'kindCoverageBonus', 'duplicateSimilarityThreshold', 'nearDuplicateSimilarityThreshold']) assertFiniteRange(policy.diversity[key], 0, 10, `diversity.${key}`);
    assertPlainObject(policy.similarity, 'context selection policy similarity');
    assertNoUnknown(policy.similarity, SIMILARITY_KEYS, 'context selection policy similarity');
    if (policy.similarity.normalization !== 'unicode_nfkc_lower_ascii_terms') throw new Error('similarity.normalization');
    assertIntegerInRange(policy.similarity.shingleSize, 1, 8, 'similarity.shingleSize');
    assertIntegerInRange(policy.similarity.maxTextBytes, 128, 65536, 'similarity.maxTextBytes');
    assertIntegerInRange(policy.similarity.minTokenLength, 1, 16, 'similarity.minTokenLength');
    assertIntegerInRange(policy.similarity.maxTokens, 16, 4096, 'similarity.maxTokens');
    assertIntegerInRange(policy.similarity.maxPairwiseComparisons, 1, 100000, 'similarity.maxPairwiseComparisons');
    assertPlainObject(policy.categoryBudgets, 'context selection policy categoryBudgets');
    assertNoUnknown(policy.categoryBudgets, new Set(CATEGORY_NAMES), 'context selection policy categoryBudgets');
    for (const [category, value] of Object.entries(policy.categoryBudgets)) {
      assertPlainObject(value, `context selection policy categoryBudgets.${category}`);
      assertNoUnknown(value, CATEGORY_BUDGET_KEYS, `context selection policy categoryBudgets.${category}`);
      assertIntegerInRange(value.cap, 0, 100, `categoryBudgets.${category}.cap`);
      assertFiniteRange(value.softReserveRatio, 0, 1, `categoryBudgets.${category}.softReserveRatio`);
    }
    assertPlainObject(policy.thresholds, 'context selection policy thresholds');
    assertNoUnknown(policy.thresholds, THRESHOLD_KEYS, 'context selection policy thresholds');
    assertFiniteRange(policy.thresholds.minimumUtility, 0, 100, 'thresholds.minimumUtility');
    assertFiniteRange(policy.thresholds.marginalUtility, 0, 100, 'thresholds.marginalUtility');
    assertIntegerInRange(policy.thresholds.minimumEvidenceCount, 0, 20, 'thresholds.minimumEvidenceCount');
    assertPlainObject(policy.limits, 'context selection policy limits');
    assertNoUnknown(policy.limits, LIMIT_KEYS, 'context selection policy limits');
    for (const key of ['maxSelectedCandidates', 'maxCandidates', 'maxSourceHitsPerCandidate', 'maxScoreFactorsPerCandidate', 'maxCandidateTokens', 'maxTotalCandidateTokens']) assertIntegerInRange(policy.limits[key], 1, 100000, `limits.${key}`);
    assertFiniteRange(policy.limits.requiredBudgetRatio, 0.01, 1, 'limits.requiredBudgetRatio');
    assertPlainObject(policy.tokenEstimation, 'context selection policy tokenEstimation');
    assertNoUnknown(policy.tokenEstimation, TOKEN_ESTIMATION_KEYS, 'context selection policy tokenEstimation');
    if (policy.tokenEstimation.method !== 'ceil_chars_div_4') throw new Error('tokenEstimation.method');
    if (typeof policy.tokenEstimation.zeroTokensAllowed !== 'boolean') throw new Error('tokenEstimation.zeroTokensAllowed');
    if (!Array.isArray(policy.tieBreak) || policy.tieBreak.length < 1 || policy.tieBreak.some((item) => typeof item !== 'string' || !item)) throw new Error('tieBreak');
    return deepFreeze(deepClone(policy));
  } catch (error) {
    if (String(error?.message ?? '').includes('unknown_field')) throw error;
    throw new TypeError(`selection_policy_invalid:${error?.message ?? 'unknown'}`);
  }
}

export function contextSelectionPolicyFingerprint(policy = CONTEXT_SELECTION_POLICY) {
  return hashRef(stableStringify(validateContextSelectionPolicy(policy)));
}

export function contextAssemblyPolicyFingerprint(policy = CONTEXT_ASSEMBLY_POLICY) {
  return hashRef(stableStringify(policy));
}

function assertIntegerInRange(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(name);
}

function assertFiniteRange(value, min, max, name) {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(name);
}

function validateNumericMap(value, allowed, name, { min, max }) {
  assertPlainObject(value, `context selection policy ${name}`);
  assertNoUnknown(value, allowed, `context selection policy ${name}`);
  for (const [key, item] of Object.entries(value)) assertFiniteRange(item, min, max, `${name}.${key}`);
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function directCandidateFromRecord(record) {
  const normalized = normalizeRecord(record);
  return {
    schemaVersion: '1.0.0',
    record: {
      ...normalized,
      workspaceId: normalized.workspaceId ?? null,
      dataClass: normalized.dataClass ?? normalized.metadata?.dataClass ?? (normalized.scope === 'public' ? 'public' : 'workspace-private'),
      trustClass: normalized.trustClass ?? normalized.metadata?.trustClass ?? 'observed',
      contentHash: recordFingerprint(normalized)
    },
    hits: [
      {
        sourceId: 'provider:native:context-selection:direct',
        sourceKind: 'direct',
        sourceVersion: COMPILER_VERSION,
        retrievalMethod: 'direct_records',
        localRank: 1,
        localScore: 1,
        reasonCodes: ['direct_record'],
        queryFingerprint: hashRef(stableStringify({ id: normalized.id, kind: normalized.kind })),
        accessDecisionRef: 'poldet_direct_record',
        retrievedAt: nowIso()
      }
    ]
  };
}

function validateSelectionRequest(request) {
  assertPlainObject(request, 'selection request');
  if (!request.objective || !request.step) throw new Error('objective and step are required');
  if (!Number.isInteger(request.tokenBudget) || request.tokenBudget < 1) throw new Error('tokenBudget must be positive');
  const now = new Date(request.now ?? request.trustedTimestamp ?? Date.now());
  if (Number.isNaN(now.getTime())) throw new Error('now must be valid');
  return {
    ...request,
    id: request.id ?? request.requestId ?? null,
    requestId: request.requestId ?? request.id ?? null,
    workspaceId: request.workspaceId ?? 'ws_local',
    requiredIds: request.requiredIds ?? [],
    requiredEntities: request.requiredEntities ?? [],
    allowedScopes: request.allowedScopes ?? ['public', 'workspace-private'],
    allowedDataClasses: request.allowedDataClasses ?? ['public', 'workspace-private'],
    allowedTrustClasses: request.allowedTrustClasses ?? ['verified', 'trusted', 'observed', 'untrusted'],
    now
  };
}

function normalizeSelectionCandidate(candidate, index, request, policy) {
  assertPlainObject(candidate, 'selection candidate');
  const item = candidate.record ? candidate : directCandidateFromRecord(candidate);
  const record = normalizeRecord(item.record);
  if (!record.id || !record.kind || !record.text) throw new TypeError('malformed_candidate');
  const tokens = Number.isInteger(record.tokens) ? record.tokens : estimateTokens(record.text);
  if ((!policy.tokenEstimation.zeroTokensAllowed && tokens < 1) || tokens < 0 || tokens > policy.limits.maxCandidateTokens) throw new TypeError('invalid_token_estimate');
  if (byteLength(record.text) > MAX_CANDIDATE_TEXT_BYTES) throw new TypeError('malformed_candidate:text_too_large');
  const contentHash = recordFingerprint(record);
  if ((record.contentHash || record.fingerprint) && !/^sha256:[a-f0-9]{64}$/.test(record.contentHash ?? record.fingerprint)) throw new TypeError('malformed_candidate:content_hash');
  const hits = Array.isArray(item.hits) && item.hits.length
    ? item.hits.slice(0, policy.limits.maxSourceHitsPerCandidate).map((hit, hitIndex) => normalizeSelectionHit(hit, hitIndex))
    : directCandidateFromRecord(record).hits;
  return {
    schemaVersion: '1.0.0',
    record: {
      ...record,
      tokens,
      workspaceId: record.workspaceId ?? request.workspaceId,
      dataClass: record.dataClass ?? record.metadata?.dataClass ?? (record.scope === 'public' ? 'public' : 'workspace-private'),
      trustClass: record.trustClass ?? record.metadata?.trustClass ?? 'observed',
      contentHash
    },
    hits: hits.sort(compareSelectionHits),
    inputIndex: index
  };
}

function normalizeSelectionHit(hit, index) {
  assertPlainObject(hit, 'selection source hit');
  const sourceKind = hit.sourceKind ?? 'direct';
  const localRank = Number.isInteger(hit.localRank) && hit.localRank > 0 ? hit.localRank : index + 1;
  const localScore = Number.isFinite(hit.localScore) ? hit.localScore : 0;
  return {
    sourceId: typeof hit.sourceId === 'string' ? hit.sourceId : `provider:native:context-selection:${sourceKind}`,
    sourceKind,
    sourceVersion: typeof hit.sourceVersion === 'string' ? hit.sourceVersion : COMPILER_VERSION,
    retrievalMethod: typeof hit.retrievalMethod === 'string' ? hit.retrievalMethod : 'unknown',
    localRank,
    localScore,
    reasonCodes: Array.isArray(hit.reasonCodes) ? hit.reasonCodes.filter((item) => typeof item === 'string').sort() : [],
    queryFingerprint: typeof hit.queryFingerprint === 'string' && /^sha256:[a-f0-9]{64}$/.test(hit.queryFingerprint) ? hit.queryFingerprint : hashRef(`${sourceKind}:${localRank}`),
    accessDecisionRef: typeof hit.accessDecisionRef === 'string' ? hit.accessDecisionRef : 'poldet_unavailable',
    retrievedAt: typeof hit.retrievedAt === 'string' ? hit.retrievedAt : nowIso()
  };
}

function compareSelectionHits(a, b) {
  return a.sourceKind.localeCompare(b.sourceKind) || a.sourceId.localeCompare(b.sourceId) || a.localRank - b.localRank || a.retrievalMethod.localeCompare(b.retrievalMethod);
}

function mergeSelectionCandidates(candidates) {
  const merged = new Map();
  for (const candidate of candidates) {
    const existing = merged.get(candidate.record.id);
    if (!existing) {
      merged.set(candidate.record.id, candidate);
      continue;
    }
    if (existing.record.contentHash !== candidate.record.contentHash || (existing.record.version ?? null) !== (candidate.record.version ?? null)) {
      const error = new Error('candidate_identity_conflict');
      error.code = 'candidate_identity_conflict';
      throw error;
    }
    const hitKeys = new Set(existing.hits.map((hit) => `${hit.sourceId}:${hit.retrievalMethod}:${hit.localRank}:${hit.queryFingerprint}`));
    for (const hit of candidate.hits) {
      const key = `${hit.sourceId}:${hit.retrievalMethod}:${hit.localRank}:${hit.queryFingerprint}`;
      if (!hitKeys.has(key)) existing.hits.push(hit);
    }
    existing.hits.sort(compareSelectionHits);
  }
  return [...merged.values()].sort((a, b) => a.record.id.localeCompare(b.record.id));
}

function selectionCategory(record) {
  if (record.category && CATEGORY_NAMES.includes(record.category)) return record.category;
  if (['policy', 'constraint'].includes(record.kind)) return 'governance';
  if (['state', 'plan', 'task'].includes(record.kind)) return 'workingState';
  if (record.kind === 'decision') return 'decisions';
  if (record.kind === 'preference') return 'preferences';
  if (['observation', 'evidence', 'fact', 'claim'].includes(record.kind)) return 'evidence';
  if (['procedure', 'runbook'].includes(record.kind)) return 'procedures';
  if (['episode', 'memory'].includes(record.kind)) return 'episodes';
  if (record.kind === 'artifact') return 'artifacts';
  if (['negative', 'negative-context', 'retraction'].includes(record.kind) || ['retracted', 'quarantined'].includes(record.status)) return 'negative';
  if (record.kind === 'example') return 'examples';
  return 'other';
}

function eligibilityReasons(candidate, request, supersededIds) {
  const record = candidate.record;
  const reasons = [];
  if (record.workspaceId && record.workspaceId !== request.workspaceId) reasons.push('workspace_mismatch');
  if (!request.allowedScopes.includes(record.scope ?? 'workspace-private')) reasons.push('scope_denied');
  if (record.dataClass === 'secret') reasons.push('secret_context_denied', 'data_class_denied');
  else if (!request.allowedDataClasses.includes(record.dataClass ?? 'workspace-private')) reasons.push('data_class_denied');
  if (!request.allowedTrustClasses.includes(record.trustClass ?? 'observed')) reasons.push('trust_class_denied');
  if (record.metadata?.retrieval?.candidateEligible === false) reasons.push('candidate_ineligible');
  if (record.status === 'expired') reasons.push('status_expired', 'expired');
  if (record.status === 'retracted') reasons.push('status_retracted', 'retracted');
  if (record.status === 'quarantined') reasons.push('status_quarantined', 'quarantined');
  if (record.status === 'superseded') reasons.push('status_superseded', 'superseded');
  if (supersededIds.has(record.id)) reasons.push('superseded_by_newer_record', 'superseded');
  const from = record.validFrom ? Date.parse(record.validFrom) : -Infinity;
  const to = record.validTo ? Date.parse(record.validTo) : Infinity;
  if (from > request.now.getTime()) reasons.push('not_yet_valid', 'outside_valid_time');
  if (to < request.now.getTime()) reasons.push('expired', 'outside_valid_time');
  return [...new Set(reasons)];
}

function sourceFusion(candidate, policy) {
  const contributions = [];
  let score = 0;
  for (const hit of candidate.hits) {
    const weight = policy.sourceWeights[hit.sourceKind] ?? 0;
    const contribution = weight / (policy.fusion.rrfK + hit.localRank);
    score += contribution;
    contributions.push({
      sourceId: hit.sourceId,
      sourceKind: hit.sourceKind,
      localRank: hit.localRank,
      contribution: round(contribution)
    });
  }
  return { score: round(score), contributions: contributions.sort((a, b) => a.sourceKind.localeCompare(b.sourceKind) || a.sourceId.localeCompare(b.sourceId) || a.localRank - b.localRank) };
}

function featureValues(candidate, request, fusionScore) {
  const record = candidate.record;
  const objectiveRelevance = overlapScore(request.objective, record);
  const stepRelevance = overlapScore(request.step, record);
  const requiredEntities = new Set(request.requiredEntities ?? []);
  const entityMatches = [...new Set([...(record.relations ?? []), ...(record.tags ?? [])])].filter((value) => requiredEntities.has(value));
  const entityCoverage = requiredEntities.size ? entityMatches.length / requiredEntities.size : 0;
  const relationCoverage = requiredEntities.size ? (record.relations ?? []).filter((value) => requiredEntities.has(value)).length / requiredEntities.size : 0;
  const authority = clamp01(Number(record.authority ?? 0.5));
  const confidence = clamp01(Number(record.confidence ?? 0.5));
  const retrieval = record.metadata?.retrieval ?? {};
  const preferenceApplicable = record.kind === 'preference' && (objectiveRelevance > 0 || stepRelevance > 0 || entityCoverage > 0) ? 1 : 0;
  const outcomeEvidence = clamp01(Number(record.outcomeEvidence ?? retrieval.outcomeEvidence ?? 0));
  const temporalApplicability = isTemporallyValid(record, request.now) ? 1 : 0;
  const kindPriority = kindPriorityValue(record.kind);
  const tokenEfficiency = clamp01(1 / Math.max(1, record.tokens / 32));
  return {
    sourceFusion: fusionScore,
    objectiveRelevance: round(objectiveRelevance),
    stepRelevance: round(stepRelevance),
    entityCoverage: round(entityCoverage),
    relationCoverage: round(relationCoverage),
    authority: round(authority),
    confidence: round(confidence),
    preferenceApplicable,
    outcomeEvidence: round(outcomeEvidence),
    temporalApplicability,
    kindPriority,
    tokenEfficiency: round(tokenEfficiency)
  };
}

function kindPriorityValue(kind) {
  if (['policy', 'constraint'].includes(kind)) return 1;
  if (kind === 'decision') return 0.85;
  if (kind === 'preference') return 0.7;
  if (['observation', 'evidence', 'fact'].includes(kind)) return 0.65;
  if (['procedure', 'episode', 'artifact'].includes(kind)) return 0.5;
  return 0.35;
}

function weightedUtility(values, policy) {
  const contributions = {};
  let total = 0;
  for (const [key, weight] of Object.entries(policy.featureWeights)) {
    const contribution = weight * (values[key] ?? 0);
    contributions[key] = round(contribution);
    total += contribution;
  }
  return { total: round(total), contributions };
}

function reasonCodesForScored({ record, values, required, governance, utility }) {
  const reasons = [];
  if (required) reasons.push('required', 'explicit_requirement');
  if (governance) reasons.push('mandatory_constraint', 'forced_governance');
  if (values.objectiveRelevance > 0.2 || values.stepRelevance > 0.2) reasons.push('task_relevance', 'high_task_relevance');
  if (values.entityCoverage > 0) reasons.push('entity_relation', 'entity_coverage');
  if (values.sourceFusion > 0) reasons.push('source_fusion');
  if (values.authority >= 0.8) reasons.push('high_authority');
  if (values.confidence >= 0.8) reasons.push('high_confidence');
  if (values.preferenceApplicable) reasons.push('preference_applicable');
  if (values.outcomeEvidence >= 0.6) reasons.push('outcome_evidence');
  if (values.tokenEfficiency >= 0.8) reasons.push('token_efficient');
  if (selectionCategory(record) === 'workingState') reasons.push('active_working_state');
  if (!reasons.length && utility >= 0.35) reasons.push('complementary_evidence');
  return [...new Set(reasons)].filter((reason) => SELECTION_REASON_CODES.includes(reason)).sort();
}

function normalizeTextTokens(text, policy) {
  const limited = Buffer.from(String(text ?? ''), 'utf8').subarray(0, policy.similarity.maxTextBytes).toString('utf8');
  return limited.normalize('NFKC').toLowerCase().replace(/[^a-z0-9_:-]+/g, ' ').split(/\s+/).filter((token) => token.length >= policy.similarity.minTokenLength).slice(0, policy.similarity.maxTokens);
}

function shinglesFor(text, policy) {
  const tokens = normalizeTextTokens(text, policy);
  if (tokens.length <= policy.similarity.shingleSize) return new Set(tokens);
  const shingles = new Set();
  for (let index = 0; index <= tokens.length - policy.similarity.shingleSize; index++) shingles.add(tokens.slice(index, index + policy.similarity.shingleSize).join(' '));
  return shingles;
}

function jaccard(left, right) {
  if (!left.size && !right.size) return 0;
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection++;
  return intersection / (left.size + right.size - intersection);
}

function similarity(left, right, policy) {
  if (left.record.id === right.record.id) return 1;
  if (left.record.contentHash && left.record.contentHash === right.record.contentHash) return 1;
  return jaccard(left.shingles, right.shingles);
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function round(value) {
  return Number((Number.isFinite(value) ? value : 0).toFixed(6));
}

function coverageFor(records, requiredEntities) {
  const requested = [...requiredEntities].sort();
  const represented = new Set();
  for (const record of records) {
    for (const value of [...(record.tags ?? []), ...(record.relations ?? [])]) if (requiredEntities.has(value)) represented.add(value);
  }
  return {
    requested,
    represented: [...represented].sort(),
    unresolved: requested.filter((entity) => !represented.has(entity))
  };
}

function decisionFromScored(item, score, reasonCodes, order = null) {
  const result = {
    id: item.record.id,
    kind: item.record.kind,
    tokens: item.record.tokens,
    score: round(score),
    reasonCodes: [...new Set(reasonCodes)].sort(),
    source: safeManifestSource(item.record.source),
    text: item.record.text
  };
  if (order !== null) result.order = order;
  if (item.category) result.category = item.category;
  const representationHint = normalizeRepresentationHint(item.record.metadata?.contextAssembly);
  if (representationHint) result.representationHint = representationHint;
  return result;
}

function exclusion(item, score, reasonCodes) {
  return decisionFromScored(item, score, reasonCodes.filter((reason) => EXCLUSION_REASON_CODES.includes(reason) || reason.startsWith('status_')));
}

function attachSelection(manifest, selection) {
  Object.defineProperty(manifest, 'selection', {
    value: selection,
    enumerable: false,
    configurable: true
  });
  return manifest;
}

export function selectContextCandidates(request, inputCandidates, {
  policy = CONTEXT_SELECTION_POLICY,
  candidateGeneration = null,
  warnings = []
} = {}) {
  const selectionPolicy = validateContextSelectionPolicy(policy);
  const policyFingerprint = contextSelectionPolicyFingerprint(selectionPolicy);
  const selectionRequest = validateSelectionRequest(request);
  if (!Array.isArray(inputCandidates)) throw new TypeError('records must be an array');
  if (inputCandidates.length > selectionPolicy.limits.maxCandidates) throw new Error('maximum_candidate_count');

  const normalized = mergeSelectionCandidates(inputCandidates.map((candidate, index) => normalizeSelectionCandidate(candidate, index, selectionRequest, selectionPolicy)));
  const totalCandidateTokens = normalized.reduce((sum, candidate) => sum + candidate.record.tokens, 0);
  if (totalCandidateTokens > selectionPolicy.limits.maxTotalCandidateTokens) throw new Error('candidate_token_ceiling_exceeded');

  const duplicateIds = new Set();
  const supersededIds = new Set(normalized.map((candidate) => candidate.record.supersedes).filter(Boolean));
  const excluded = [];
  const eligible = [];
  for (const candidate of normalized) {
    const category = selectionCategory(candidate.record);
    const reasons = eligibilityReasons(candidate, selectionRequest, supersededIds);
    const base = { ...candidate, category, shingles: shinglesFor(candidate.record.text, selectionPolicy) };
    if (reasons.length) excluded.push(exclusion(base, 0, reasons));
    else eligible.push(base);
  }

  const conflicts = detectConflicts(eligible.map((item) => item.record));
  const requiredIds = new Set(selectionRequest.requiredIds ?? []);
  const requiredEligible = eligible.filter((item) => requiredIds.has(item.record.id));
  const missingRequired = [...requiredIds].filter((id) => !requiredEligible.some((item) => item.record.id === id));
  if (missingRequired.length) throw selectionError('required_context_unresolved', { missingCount: missingRequired.length });
  if (conflicts.some((conflict) => conflict.records.some((item) => requiredIds.has(item.id)))) throw selectionError('required_context_conflict');

  const scored = eligible.map((candidate) => {
    const fusion = sourceFusion(candidate, selectionPolicy);
    const values = featureValues(candidate, selectionRequest, fusion.score);
    const utility = weightedUtility(values, selectionPolicy);
    const required = requiredIds.has(candidate.record.id);
    const governance = ['policy', 'constraint'].includes(candidate.record.kind);
    const taskSignal = values.objectiveRelevance > 0 || values.stepRelevance > 0 || values.entityCoverage > 0 || values.relationCoverage > 0 || values.preferenceApplicable > 0;
    const rawUtility = (!required && !governance && !taskSignal) ? Math.min(utility.total, selectionPolicy.thresholds.minimumUtility / 2) : utility.total;
    return {
      ...candidate,
      fusion,
      featureValues: values,
      contributions: utility.contributions,
      baseUtility: required || governance ? 1000 : utility.total,
      rawUtility,
      taskSignal,
      required,
      governance,
      reasonCodes: reasonCodesForScored({ record: candidate.record, values, required, governance, utility: rawUtility })
    };
  }).sort(compareScored);

  const selected = [];
  const selectedScored = [];
  const selectedByCategory = new Map();
  let used = 0;
  let pairwiseComparisons = 0;

  const requiredFirst = scored.filter((item) => item.required || item.governance).sort((a, b) => Number(b.required) - Number(a.required) || a.record.id.localeCompare(b.record.id));
  const requiredTokens = requiredFirst.reduce((sum, item) => sum + item.record.tokens, 0);
  if (requiredTokens > Math.floor(selectionRequest.tokenBudget * selectionPolicy.limits.requiredBudgetRatio)) throw selectionError('required_context_over_budget');
  for (const item of requiredFirst) {
    selected.push(decisionFromScored(item, item.baseUtility, item.reasonCodes, selected.length + 1));
    selectedScored.push(item);
    selectedByCategory.set(item.category, (selectedByCategory.get(item.category) ?? 0) + 1);
    used += item.record.tokens;
  }

  const selectedEntities = new Set();
  for (const item of selectedScored) for (const entity of [...(item.record.tags ?? []), ...(item.record.relations ?? [])]) if ((selectionRequest.requiredEntities ?? []).includes(entity)) selectedEntities.add(entity);

  const optional = scored.filter((item) => !item.required && !item.governance && !selected.some((decision) => decision.id === item.record.id));
  const optionalState = new Map(optional.map((item) => [item.record.id, item]));
  let iterations = 0;
  while (optionalState.size && selected.length < selectionPolicy.limits.maxSelectedCandidates) {
    iterations += 1;
    let best = null;
    for (const item of optionalState.values()) {
      const redundancy = maxSimilarity(item, selectedScored, selectionPolicy);
      pairwiseComparisons += redundancy.comparisons;
      if (pairwiseComparisons > selectionPolicy.similarity.maxPairwiseComparisons) throw new Error('similarity_comparison_limit_exceeded');
      const newEntityCoverage = [...(item.record.tags ?? []), ...(item.record.relations ?? [])].some((entity) => (selectionRequest.requiredEntities ?? []).includes(entity) && !selectedEntities.has(entity));
      const newKindCoverage = !selectedScored.some((selectedItem) => selectedItem.category === item.category);
      const coverageBonus = (newEntityCoverage ? selectionPolicy.diversity.coverageBonus : 0) + (newKindCoverage ? selectionPolicy.diversity.kindCoverageBonus : 0);
      const marginalUtility = round(item.rawUtility - (selectionPolicy.diversity.diversityWeight * redundancy.score) + coverageBonus);
      const decorated = { ...item, redundancyPenalty: round(redundancy.score), marginalUtility, coverageBonus: round(coverageBonus), newEntityCoverage, newKindCoverage };
      if (!best || compareMarginal(decorated, best) < 0) best = decorated;
    }
    if (!best) break;
    optionalState.delete(best.record.id);
    const categoryCount = selectedByCategory.get(best.category) ?? 0;
    const reasons = [];
    if (best.rawUtility < selectionPolicy.thresholds.minimumUtility) reasons.push('below_minimum_utility', 'insufficient_relevance');
    if (best.redundancyPenalty >= selectionPolicy.diversity.duplicateSimilarityThreshold) reasons.push('redundant');
    if (categoryCount >= selectionPolicy.categoryBudgets[best.category].cap) reasons.push('category_cap');
    if (used + best.record.tokens > selectionRequest.tokenBudget) reasons.push('token_budget');
    if (best.marginalUtility < selectionPolicy.thresholds.marginalUtility) reasons.push('insufficient_marginal_utility');
    if (reasons.length) {
      excluded.push(exclusion(best, best.marginalUtility, reasons));
      continue;
    }
    selected.push(decisionFromScored(best, best.marginalUtility, [...best.reasonCodes, best.newEntityCoverage ? 'entity_coverage' : 'complementary_evidence', selectedByCategory.has(best.category) ? 'selected_despite_kind_overlap' : 'diversity_gain'], selected.length + 1));
    selectedScored.push(best);
    selectedByCategory.set(best.category, categoryCount + 1);
    used += best.record.tokens;
    for (const entity of [...(best.record.tags ?? []), ...(best.record.relations ?? [])]) if ((selectionRequest.requiredEntities ?? []).includes(entity)) selectedEntities.add(entity);
    if (isSufficient({ request: selectionRequest, selectedScored, conflicts, policy: selectionPolicy }) && evidenceCount(selectedScored) >= selectionPolicy.thresholds.minimumEvidenceCount) {
      for (const item of [...optionalState.values()].sort((a, b) => a.record.id.localeCompare(b.record.id))) {
        const redundancy = maxSimilarity(item, selectedScored, selectionPolicy);
        excluded.push(exclusion(item, item.rawUtility, redundancy.score >= selectionPolicy.diversity.duplicateSimilarityThreshold ? ['redundant'] : ['insufficient_marginal_utility']));
      }
      optionalState.clear();
      break;
    }
  }
  for (const item of optionalState.values()) excluded.push(exclusion(item, item.rawUtility, selected.length >= selectionPolicy.limits.maxSelectedCandidates ? ['maximum_candidate_count'] : ['insufficient_marginal_utility']));

  const requiredEntities = new Set(selectionRequest.requiredEntities ?? []);
  const eligibleCoverage = coverageFor(eligible.map((item) => item.record), requiredEntities);
  const selectedCoverage = coverageFor(selectedScored.map((item) => item.record), requiredEntities);
  const sufficiency = {
    state: isSufficient({ request: selectionRequest, selectedScored, conflicts, policy: selectionPolicy }) ? 'sufficient' : 'insufficient',
    requiredIds: {
      requested: [...requiredIds].sort(),
      resolved: requiredEligible.map((item) => item.record.id).sort(),
      unresolvedCount: missingRequired.length
    },
    entities: {
      requested: eligibleCoverage.requested,
      eligible: eligibleCoverage.represented,
      selected: selectedCoverage.represented,
      unresolved: selectedCoverage.unresolved
    },
    evidenceCount: evidenceCount(selectedScored),
    conflictCount: conflicts.length
  };

  const decisionStateById = new Map([
    ...selected.map((item) => [item.id, 'selected']),
    ...excluded.map((item) => [item.id, 'excluded'])
  ]);
  const selection = {
    schemaVersion: '1.0.0',
    requestId: selectionRequest.requestId ?? null,
    workspaceId: selectionRequest.workspaceId,
    selectionPolicyVersion: selectionPolicy.policyVersion,
    selectionPolicyFingerprint: policyFingerprint,
    candidateGenerationFingerprint: hashRef(stableStringify(candidateGenerationSafeFingerprint(candidateGeneration, normalized))),
    totalCandidateCount: normalized.length,
    totalCandidateTokenCount: totalCandidateTokens,
    eligibleCandidateCount: eligible.length,
    selectedCandidateCount: selected.length,
    selectedTokenCount: used,
    availableTokenBudget: selectionRequest.tokenBudget,
    categoryBudgets: categoryBudgetSummary(selectionPolicy, selectionRequest, selectedScored),
    coverage: sufficiency.entities,
    selectedDecisions: selected.map(safeDecision),
    excludedDecisions: excluded.sort((a, b) => a.id.localeCompare(b.id)).map(safeDecision),
    conflicts,
    warnings: [...new Set(warnings)].sort(),
    sufficiency,
    scoreBreakdowns: scored.map((item) => safeScoreBreakdown(item, decisionStateById)).sort((a, b) => a.id.localeCompare(b.id)),
    bounds: {
      pairwiseSimilarityComparisons: pairwiseComparisons,
      selectionIterations: iterations
    }
  };
  selection.resultFingerprint = hashRef(stableStringify({ selected: selection.selectedDecisions, excluded: selection.excludedDecisions, coverage: selection.coverage, conflicts }));

  const requiredOverBudget = excluded.filter((item) => item.reasonCodes.includes('required_but_over_budget'));
  const manifestWarnings = [...new Set([...(requiredOverBudget.length ? ['required_governance_exceeded_budget'] : []), ...selection.warnings])].sort();
  const manifest = {
    schemaVersion: '1.0.0',
    id: prefixedId('ctx'),
    workspaceId: selectionRequest.workspaceId,
    requestId: selectionRequest.id ?? null,
    compilerVersion: COMPILER_VERSION,
    createdAt: nowIso(),
    budget: { available: selectionRequest.tokenBudget, used },
    selected,
    excluded: excluded.sort((a, b) => a.id.localeCompare(b.id)),
    conflicts,
    warnings: manifestWarnings
  };
  return { schemaVersion: '1.0.0', manifest: attachSelection(manifest, selection), selection };
}

function selectionError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}

function compareScored(a, b) {
  return b.baseUtility - a.baseUtility || a.record.tokens - b.record.tokens || a.record.id.localeCompare(b.record.id);
}

function compareMarginal(a, b) {
  return b.marginalUtility - a.marginalUtility || a.record.tokens - b.record.tokens || a.record.id.localeCompare(b.record.id);
}

function maxSimilarity(item, selected, policy) {
  let score = 0;
  let comparisons = 0;
  for (const selectedItem of selected) {
    if (item.record.workspaceId !== selectedItem.record.workspaceId) continue;
    comparisons += 1;
    score = Math.max(score, similarity(item, selectedItem, policy));
  }
  return { score: round(score), comparisons };
}

function evidenceCount(items) {
  return items.filter((item) => item.category === 'evidence').length;
}

function isSufficient({ request, selectedScored, conflicts, policy }) {
  const requiredIds = new Set(request.requiredIds ?? []);
  for (const id of requiredIds) if (!selectedScored.some((item) => item.record.id === id)) return false;
  if ((request.requiredEntities ?? []).length) {
    const selectedEntities = new Set();
    for (const item of selectedScored) for (const entity of [...(item.record.tags ?? []), ...(item.record.relations ?? [])]) selectedEntities.add(entity);
    for (const entity of request.requiredEntities) if (!selectedEntities.has(entity)) return false;
  }
  if (evidenceCount(selectedScored) < policy.thresholds.minimumEvidenceCount) return false;
  if (conflicts.length && !conflicts.every((conflict) => conflict.records.every((record) => selectedScored.some((item) => item.record.id === record.id)))) return false;
  return true;
}

function safeScoreBreakdown(item, decisionStateById) {
  return {
    id: item.record.id,
    category: item.category,
    fusion: item.fusion,
    featureValues: item.featureValues,
    weightedContributions: item.contributions,
    preDiversityUtility: round(item.rawUtility),
    selectedOrExcluded: decisionStateById.get(item.record.id) ?? 'excluded',
    reasonCodes: item.reasonCodes.slice(0, 16)
  };
}

function safeDecision(item) {
  return {
    id: item.id,
    order: item.order ?? null,
    tokens: item.tokens,
    category: item.category ?? null,
    utility: item.score,
    reasonCodes: item.reasonCodes
  };
}

function categoryBudgetSummary(policy, request, selectedScored) {
  return Object.fromEntries(CATEGORY_NAMES.map((category) => {
    const budget = policy.categoryBudgets[category];
    const selected = selectedScored.filter((item) => item.category === category);
    return [category, {
      cap: budget.cap,
      softReserveRatio: budget.softReserveRatio,
      softReserveTokens: Math.floor(request.tokenBudget * budget.softReserveRatio),
      selectedCount: selected.length,
      selectedTokens: selected.reduce((sum, item) => sum + item.record.tokens, 0)
    }];
  }));
}

function candidateGenerationSafeFingerprint(candidateGeneration, candidates) {
  return {
    status: candidateGeneration?.status ?? null,
    reports: (candidateGeneration?.reports ?? []).map((report) => ({
      sourceId: report.sourceId,
      sourceKind: report.sourceKind,
      status: report.status,
      failureCode: report.failureCode ?? null
    })).sort((a, b) => String(a.sourceId).localeCompare(String(b.sourceId))),
    candidates: candidates.map((candidate) => ({
      id: candidate.record.id,
      version: candidate.record.version ?? null,
      contentHash: candidate.record.contentHash,
      hits: candidate.hits.map((hit) => ({ sourceId: hit.sourceId, sourceKind: hit.sourceKind, localRank: hit.localRank }))
    }))
  };
}

function stripText(decision) {
  const { text: _text, ...safe } = decision;
  return safe;
}

const UNSAFE_MANIFEST_MATERIAL = /(?:^|[\s"'=:(])(?:\/Users\/|\/private\/|\/tmp\/|\/var\/folders\/|\/var\/tmp\/|\/Volumes\/|[A-Za-z]:\\)|workspace:\/\/\/(?:Users|private|tmp|var|Volumes)\//u;
const SECRET_MANIFEST_MATERIAL = /(?:sk-[A-Za-z0-9_-]{20,}|(?:token|secret|password|authorization)=|SELECT\s+\*)/iu;

function hasUnsafeManifestMaterial(value) {
  const text = String(value ?? '');
  return UNSAFE_MANIFEST_MATERIAL.test(text) || /^file:\/\//iu.test(text) || SECRET_MANIFEST_MATERIAL.test(text);
}

function safeManifestSource(value) {
  const source = String(value ?? 'unknown').trim() || 'unknown';
  return hasUnsafeManifestMaterial(source) ? 'redacted-source' : source;
}

function normalizeRepresentationHint(value) {
  if (!value || typeof value !== 'object') return null;
  const tier = CONTEXT_REPRESENTATION_TIERS.includes(value.tier) ? value.tier : null;
  if (!tier) return null;
  const reasonCodes = Array.isArray(value.reasonCodes)
    ? [...new Set(value.reasonCodes.filter((item) => typeof item === 'string' && /^[a-z][a-z0-9_:-]*$/u.test(item)))].sort().slice(0, 8)
    : ['explicit_representation_hint'];
  return {
    tier,
    reasonCodes: reasonCodes.length ? reasonCodes : ['explicit_representation_hint']
  };
}

function durableManifestId({ request, runId, selectedIds }) {
  return `ctx_${sha256(stableStringify({
    workspaceId: request.workspaceId ?? 'ws_local',
    runId: runId ?? null,
    requestId: request.requestId ?? request.id ?? null,
    taskId: request.taskId ?? null,
    step: request.step,
    objective: request.objective,
    selectedIds
  })).slice(0, 32)}`;
}

function manifestContentHash(item) {
  return hashRef(stableStringify({
    id: item.id,
    kind: item.kind,
    text: item.text,
    source: item.source,
    tokens: item.tokens
  }));
}

function assemblyCategory(item) {
  return ASSEMBLY_SECTION_ORDER.includes(item.category) ? item.category : 'other';
}

function representationForItem(item) {
  const requestedTier = normalizeRepresentationHint(item.representationHint)?.tier ?? 'full';
  const originalText = String(item.text ?? '');
  const source = safeManifestSource(item.source);
  const tier = CONTEXT_REPRESENTATION_TIERS.includes(requestedTier) ? requestedTier : 'full';
  let text = originalText;
  let reasonCodes = normalizeRepresentationHint(item.representationHint)?.reasonCodes ?? ['full_context_required'];
  if (tier === 'snippet') {
    const limit = 240;
    text = originalText.length > limit ? `${originalText.slice(0, limit)}...` : originalText;
    reasonCodes = [...new Set([...reasonCodes, 'snippet_compression'])].sort();
  } else if (tier === 'outline') {
    text = `${item.kind} ${item.id} from ${source}.`;
    reasonCodes = [...new Set([...reasonCodes, 'outline_compression'])].sort();
  } else if (tier === 'locator-only') {
    text = `${item.kind} ${item.id} locator ${source}.`;
    reasonCodes = [...new Set([...reasonCodes, 'locator_only_compression'])].sort();
  } else if (tier === 'excluded') {
    text = `${item.kind} ${item.id} excluded from assembly body.`;
    reasonCodes = [...new Set([...reasonCodes, 'excluded_from_assembly_body'])].sort();
  }
  const representedTokens = tier === 'full' ? item.tokens : estimateTokens(text);
  return {
    tier,
    text,
    originalTokens: item.tokens,
    representedTokens,
    reasonCodes
  };
}

function buildAssembly(selected, { policy = CONTEXT_ASSEMBLY_POLICY } = {}) {
  const bySection = new Map(ASSEMBLY_SECTION_ORDER.map((id) => [id, []]));
  for (const item of selected) bySection.get(assemblyCategory(item))?.push(item);
  const sections = [];
  let order = 1;
  for (const sectionId of policy.sectionOrder) {
    const items = [...(bySection.get(sectionId) ?? [])].sort((a, b) => {
      const rank = (item) => item.kind === 'policy' ? 0 : item.kind === 'constraint' ? 1 : 2;
      return rank(a) - rank(b) || (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id);
    });
    if (!items.length) continue;
    const sectionItems = items.map((item) => {
      const representation = representationForItem(item);
      return {
        id: item.id,
        kind: item.kind,
        tokens: representation.representedTokens,
        originalTokens: representation.originalTokens,
        source: safeManifestSource(item.source),
        text: representation.text,
        representation: {
          tier: representation.tier,
          reasonCodes: representation.reasonCodes
        },
        contentHash: manifestContentHash(item),
        representationHash: hashRef(stableStringify({
          id: item.id,
          tier: representation.tier,
          text: representation.text,
          representedTokens: representation.representedTokens,
          originalTokens: representation.originalTokens
        }))
      };
    });
    sections.push({
      id: sectionId,
      order: order++,
      recordCount: sectionItems.length,
      tokenCount: sectionItems.reduce((sum, item) => sum + item.tokens, 0),
      recordIds: sectionItems.map((item) => item.id),
      items: sectionItems
    });
  }
  const selectedRecordIds = sections.flatMap((section) => section.recordIds);
  const totalTokens = sections.reduce((sum, section) => sum + section.tokenCount, 0);
  const originalTokens = sections.reduce((sum, section) => sum + section.items.reduce((itemSum, item) => itemSum + item.originalTokens, 0), 0);
  const assemblyFingerprint = hashRef(stableStringify({
    policyVersion: policy.policyVersion,
    policyFingerprint: contextAssemblyPolicyFingerprint(policy),
    sectionOrder: policy.sectionOrder,
    sections: sections.map((section) => ({
      id: section.id,
      recordIds: section.recordIds,
      tokenCount: section.tokenCount,
      contentHashes: section.items.map((item) => item.contentHash),
      representationHashes: section.items.map((item) => item.representationHash)
    })),
    totalTokens,
    originalTokens
  }));
  return {
    schemaVersion: '1.0.0',
    assemblyPolicyVersion: policy.policyVersion,
    assemblyPolicyFingerprint: contextAssemblyPolicyFingerprint(policy),
    sectionOrder: policy.sectionOrder,
    representationTiers: policy.representationTiers,
    selectedRecordIds,
    totalTokens,
    originalTokens,
    sections,
    assemblyFingerprint
  };
}

function buildLegacyAssembly(selected, { policy = LEGACY_CONTEXT_ASSEMBLY_POLICY } = {}) {
  const bySection = new Map(ASSEMBLY_SECTION_ORDER.map((id) => [id, []]));
  for (const item of selected) bySection.get(assemblyCategory(item))?.push(item);
  const sections = [];
  let order = 1;
  for (const sectionId of policy.sectionOrder) {
    const items = [...(bySection.get(sectionId) ?? [])].sort((a, b) => {
      const rank = (item) => item.kind === 'policy' ? 0 : item.kind === 'constraint' ? 1 : 2;
      return rank(a) - rank(b) || (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id);
    });
    if (!items.length) continue;
    const sectionItems = items.map((item) => ({
      id: item.id,
      kind: item.kind,
      tokens: item.tokens,
      source: item.source,
      text: item.text,
      contentHash: manifestContentHash(item)
    }));
    sections.push({
      id: sectionId,
      order: order++,
      recordCount: sectionItems.length,
      tokenCount: sectionItems.reduce((sum, item) => sum + item.tokens, 0),
      recordIds: sectionItems.map((item) => item.id),
      items: sectionItems
    });
  }
  const selectedRecordIds = sections.flatMap((section) => section.recordIds);
  const totalTokens = sections.reduce((sum, section) => sum + section.tokenCount, 0);
  const assemblyFingerprint = hashRef(stableStringify({
    policyVersion: policy.policyVersion,
    policyFingerprint: contextAssemblyPolicyFingerprint(policy),
    sectionOrder: policy.sectionOrder,
    sections: sections.map((section) => ({
      id: section.id,
      recordIds: section.recordIds,
      tokenCount: section.tokenCount,
      contentHashes: section.items.map((item) => item.contentHash)
    })),
    totalTokens
  }));
  return {
    schemaVersion: '1.0.0',
    assemblyPolicyVersion: policy.policyVersion,
    assemblyPolicyFingerprint: contextAssemblyPolicyFingerprint(policy),
    sectionOrder: policy.sectionOrder,
    selectedRecordIds,
    totalTokens,
    sections,
    assemblyFingerprint
  };
}

function manifestEtag({ durable, assembly }) {
  return hashRef(stableStringify({
    workspaceId: durable.workspaceId,
    runId: durable.runId ?? null,
    requestId: durable.requestId ?? null,
    compilerVersion: durable.compilerVersion,
    assemblyFingerprint: assembly.assemblyFingerprint,
    selectedRecordIds: assembly.selectedRecordIds
  }));
}

function manifestDeltaFrom(previousManifest, durable, assembly) {
  if (!previousManifest) return null;
  const previousSelected = new Map((previousManifest.selected ?? []).map((item) => [item.id, item]));
  const nextSelected = new Map((durable.selected ?? []).map((item) => [item.id, item]));
  const previousAssemblyItems = new Map((previousManifest.assembly?.sections ?? []).flatMap((section) => (section.items ?? []).map((item) => [item.id, item])));
  const nextAssemblyItems = new Map((assembly.sections ?? []).flatMap((section) => (section.items ?? []).map((item) => [item.id, item])));
  const unchangedRecordIds = [];
  const changedRecordIds = [];
  for (const [id, item] of nextSelected) {
    const previous = previousSelected.get(id);
    if (!previous) continue;
    const previousAssemblyItem = previousAssemblyItems.get(id);
    const nextAssemblyItem = nextAssemblyItems.get(id);
    const previousContentHash = previousAssemblyItem?.contentHash ?? manifestContentHash(previous);
    const nextContentHash = nextAssemblyItem?.contentHash ?? manifestContentHash(item);
    const previousRepresentationHash = previousAssemblyItem?.representationHash ?? null;
    const nextRepresentationHash = nextAssemblyItem?.representationHash ?? null;
    if (
      previousContentHash === nextContentHash &&
      (!previousRepresentationHash || !nextRepresentationHash || previousRepresentationHash === nextRepresentationHash)
    ) unchangedRecordIds.push(id);
    else changedRecordIds.push(id);
  }
  return {
    manifestId: previousManifest.id ?? null,
    etag: previousManifest.etag ?? null,
    manifestFingerprint: previousManifest.manifestFingerprint ?? null,
    assemblyFingerprint: previousManifest.assembly?.assemblyFingerprint ?? null,
    unchangedRecordIds: unchangedRecordIds.sort(),
    addedRecordIds: [...nextSelected.keys()].filter((id) => !previousSelected.has(id)).sort(),
    removedRecordIds: [...previousSelected.keys()].filter((id) => !nextSelected.has(id)).sort(),
    changedRecordIds: changedRecordIds.sort(),
    assemblyChanged: previousManifest.assembly?.assemblyFingerprint !== assembly.assemblyFingerprint
  };
}

function tokenBudgetReport({ manifest, assembly, selection, request, deltaFrom }) {
  const selectedOriginalTokens = (manifest.selected ?? []).reduce((sum, item) => sum + Number(item.tokens ?? 0), 0);
  const assembledTokens = assembly.totalTokens;
  const candidateTokens = Number(selection?.totalCandidateTokenCount ?? selectedOriginalTokens);
  const requiredIds = new Set(request.requiredIds ?? []);
  const requiredSelected = (manifest.selected ?? []).filter((item) => requiredIds.has(item.id)).length;
  const requestedEntities = new Set(request.requiredEntities ?? []);
  const selectedEntities = new Set(selection?.coverage?.selected ?? []);
  const requiredEntityCoverage = requestedEntities.size
    ? Number((selectedEntities.size / requestedEntities.size).toFixed(6))
    : 1;
  const compressionLossNotes = [];
  for (const section of assembly.sections ?? []) {
    for (const item of section.items ?? []) {
      if (item.representation?.tier && item.representation.tier !== 'full') {
        compressionLossNotes.push({
          recordId: item.id,
          tier: item.representation.tier,
          reasonCodes: item.representation.reasonCodes ?? []
        });
      }
    }
  }
  return {
    selectedOriginalTokens,
    assembledTokens,
    totalCandidateTokens: candidateTokens,
    budgetAvailable: manifest.budget?.available ?? request.tokenBudget ?? null,
    budgetUsed: assembledTokens,
    selectedTokenRatio: candidateTokens ? Number((selectedOriginalTokens / candidateTokens).toFixed(6)) : 0,
    assembledTokenRatio: selectedOriginalTokens ? Number((assembledTokens / selectedOriginalTokens).toFixed(6)) : 0,
    wastedTokenEstimate: Math.max(0, selectedOriginalTokens - assembledTokens),
    requiredEvidenceCoverage: {
      requiredIds: {
        requested: requiredIds.size,
        selected: requiredSelected,
        ratio: requiredIds.size ? Number((requiredSelected / requiredIds.size).toFixed(6)) : 1
      },
      requiredEntities: {
        requested: requestedEntities.size,
        selected: selectedEntities.size,
        ratio: requiredEntityCoverage
      }
    },
    compressionLossNotes: compressionLossNotes.sort((a, b) => a.recordId.localeCompare(b.recordId)),
    delta: deltaFrom ? {
      unchangedRecordCount: deltaFrom.unchangedRecordIds.length,
      addedRecordCount: deltaFrom.addedRecordIds.length,
      removedRecordCount: deltaFrom.removedRecordIds.length,
      changedRecordCount: deltaFrom.changedRecordIds.length
    } : null
  };
}

function candidateGenerationSummary(candidateGeneration = null) {
  return {
    status: candidateGeneration?.status ?? null,
    fingerprint: hashRef(stableStringify(candidateGenerationSafeFingerprint(candidateGeneration, []))),
    warnings: [...new Set(candidateGeneration?.warnings ?? [])].sort(),
    failures: (candidateGeneration?.reports ?? [])
      .filter((report) => report.status !== 'succeeded')
      .map((report) => ({
        sourceId: report.sourceId,
        sourceKind: report.sourceKind,
        status: report.status,
        failureCode: report.failureCode ?? null,
        required: report.required === true
      }))
      .sort((a, b) => String(a.sourceId).localeCompare(String(b.sourceId)))
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function fingerprintManifest(manifest) {
  const copy = cloneJson(manifest);
  delete copy.manifestFingerprint;
  return hashRef(stableStringify(copy));
}

export function createDurableContextManifest({ manifest, selection, request, runId = null, candidateGeneration = null, createdAt = null, previousManifest = null } = {}) {
  assertPlainObject(manifest, 'context manifest');
  assertPlainObject(request, 'context request');
  const assembly = buildAssembly(manifest.selected ?? []);
  const assemblyOrder = new Map(assembly.selectedRecordIds.map((id, index) => [id, index + 1]));
  const selectedById = new Map((manifest.selected ?? []).map((item) => [item.id, item]));
  const orderedSelected = assembly.selectedRecordIds.map((id) => ({
    ...selectedById.get(id),
    order: assemblyOrder.get(id)
  }));
  const durable = {
    ...cloneJson(manifest),
    id: durableManifestId({ request, runId, selectedIds: assembly.selectedRecordIds }),
    runId,
    requestId: request.requestId ?? request.id ?? manifest.requestId ?? null,
    createdAt: createdAt ?? request.trustedTimestamp ?? request.now ?? manifest.createdAt ?? nowIso(),
    compilerVersion: manifest.compilerVersion ?? COMPILER_VERSION,
    selected: orderedSelected,
    excluded: (manifest.excluded ?? []).map(stripText).sort((a, b) => a.id.localeCompare(b.id)),
    assembly,
    selectionSummary: selection ? cloneJson(selection) : manifest.selection ? cloneJson(manifest.selection) : null,
    selectionPolicy: selection ? {
      version: selection.selectionPolicyVersion,
      fingerprint: selection.selectionPolicyFingerprint,
      resultFingerprint: selection.resultFingerprint,
      candidateGenerationFingerprint: selection.candidateGenerationFingerprint
    } : null,
    candidateGeneration: candidateGenerationSummary(candidateGeneration),
    tokenAccounting: {},
    fingerprintAlgorithm: 'sha256'
  };
  durable.etag = manifestEtag({ durable, assembly });
  durable.deltaFrom = manifestDeltaFrom(previousManifest, durable, assembly);
  durable.tokenAccounting = tokenBudgetReport({ manifest, assembly, selection, request, deltaFrom: durable.deltaFrom });
  durable.budget = { ...(durable.budget ?? {}), used: assembly.totalTokens };
  durable.manifestFingerprint = fingerprintManifest(durable);
  return durable;
}

export function verifyContextManifest(manifest) {
  try {
    assertPlainObject(manifest, 'context manifest');
    if (manifest.schemaVersion !== '1.0.0') throw new Error('schemaVersion');
    requireString(manifest.id, 'context manifest id', { maxBytes: 128, pattern: /^ctx_[A-Za-z0-9._:-]+$/ });
    requireString(manifest.workspaceId, 'context manifest workspaceId', { maxBytes: 128 });
    requireString(manifest.manifestFingerprint, 'context manifest manifestFingerprint', { maxBytes: 80, pattern: /^sha256:[a-f0-9]{64}$/ });
    assertPlainObject(manifest.assembly, 'context manifest assembly');
    requireString(manifest.assembly.assemblyFingerprint, 'context manifest assemblyFingerprint', { maxBytes: 80, pattern: /^sha256:[a-f0-9]{64}$/ });
    const selectedIds = (manifest.selected ?? []).map((item) => item.id);
    if (stableStringify(selectedIds) !== stableStringify(manifest.assembly.selectedRecordIds ?? [])) throw new Error('assembly_order_mismatch');
    const sectionTokens = (manifest.assembly.sections ?? []).reduce((sum, section) => sum + Number(section.tokenCount ?? 0), 0);
    if (sectionTokens !== manifest.assembly.totalTokens || sectionTokens !== manifest.budget?.used) throw new Error('token_accounting_mismatch');
    if (manifest.etag) requireString(manifest.etag, 'context manifest etag', { maxBytes: 80, pattern: /^sha256:[a-f0-9]{64}$/ });
    if ((manifest.excluded ?? []).some((item) => Object.prototype.hasOwnProperty.call(item, 'text'))) throw new Error('excluded_text_present');
    const legacyAssembly = !Object.prototype.hasOwnProperty.call(manifest.assembly, 'representationTiers') && !Object.prototype.hasOwnProperty.call(manifest.assembly, 'originalTokens');
    const rebuiltAssembly = legacyAssembly ? buildLegacyAssembly(manifest.selected ?? []) : buildAssembly(manifest.selected ?? []);
    if (rebuiltAssembly.assemblyFingerprint !== manifest.assembly.assemblyFingerprint) throw new Error('assembly_fingerprint_mismatch');
    if (fingerprintManifest(manifest) !== manifest.manifestFingerprint) throw new Error('manifest_fingerprint_mismatch');
    const serialized = JSON.stringify(manifest);
    if (hasUnsafeManifestMaterial(serialized)) throw new Error('unsafe_manifest_material');
    return { valid: true, manifestId: manifest.id, manifestFingerprint: manifest.manifestFingerprint, assemblyFingerprint: manifest.assembly.assemblyFingerprint };
  } catch (error) {
    return { valid: false, code: error.message, manifestId: manifest?.id ?? null };
  }
}

export function compareContextManifests(left, right) {
  assertPlainObject(left, 'left context manifest');
  assertPlainObject(right, 'right context manifest');
  if (left.workspaceId !== right.workspaceId) {
    const error = new Error('manifest_workspace_mismatch');
    error.code = 'manifest_workspace_mismatch';
    throw error;
  }
  const leftSelected = new Set((left.selected ?? []).map((item) => item.id));
  const rightSelected = new Set((right.selected ?? []).map((item) => item.id));
  const leftExcluded = new Set((left.excluded ?? []).map((item) => item.id));
  const rightExcluded = new Set((right.excluded ?? []).map((item) => item.id));
  const diffSet = (a, b) => [...a].filter((item) => !b.has(item)).sort();
  return {
    schemaVersion: '1.0.0',
    leftId: left.id,
    rightId: right.id,
    sameWorkspace: true,
    fingerprintsEqual: left.manifestFingerprint === right.manifestFingerprint,
    assemblyFingerprintsEqual: left.assembly?.assemblyFingerprint === right.assembly?.assemblyFingerprint,
    selected: {
      added: diffSet(rightSelected, leftSelected),
      removed: diffSet(leftSelected, rightSelected)
    },
    excluded: {
      added: diffSet(rightExcluded, leftExcluded),
      removed: diffSet(leftExcluded, rightExcluded)
    },
    conflicts: {
      leftCount: left.conflicts?.length ?? 0,
      rightCount: right.conflicts?.length ?? 0
    },
    tokenAccounting: {
      leftUsed: left.budget?.used ?? null,
      rightUsed: right.budget?.used ?? null
    }
  };
}

export async function compileAndPersistContext(request, input, {
  manifestRepository,
  runId = null,
  previousManifest = null,
  clock = nowIso,
  emitEvent = async () => {},
  afterPersist = null
} = {}) {
  const compiled = Array.isArray(input)
    ? (() => {
      const manifest = compileContext(request, input);
      return { manifest, selection: manifest.selection ?? null, candidateGeneration: null };
    })()
    : await compileContextFromSources(request, input ?? {});
  if (!manifestRepository || typeof manifestRepository.append !== 'function' || typeof manifestRepository.get !== 'function') {
    throw new TypeError('manifestRepository with append and get is required');
  }
  const createdAt = typeof clock === 'function' ? clock() : nowIso();
  const durable = createDurableContextManifest({
    manifest: compiled.manifest,
    selection: compiled.selection ?? compiled.manifest.selection ?? null,
    request,
    runId,
    candidateGeneration: compiled.candidateGeneration ?? null,
    createdAt,
    previousManifest
  });
  const verification = verifyContextManifest(durable);
  if (!verification.valid) {
    const error = new Error(verification.code ?? 'manifest_verification_failed');
    error.code = verification.code ?? 'manifest_verification_failed';
    throw error;
  }
  const stored = await manifestRepository.append({ workspaceId: durable.workspaceId, runId, manifest: durable, request });
  const storedManifest = stored?.manifest && stored?.workspaceId ? stored.manifest : stored;
  const loaded = await manifestRepository.get({ workspaceId: durable.workspaceId, id: durable.id });
  const loadedManifest = loaded?.manifest && loaded?.workspaceId ? loaded.manifest : loaded;
  const storedVerification = verifyContextManifest(loadedManifest ?? storedManifest);
  if (!storedVerification.valid || storedVerification.manifestFingerprint !== durable.manifestFingerprint) {
    const error = new Error(storedVerification.code ?? 'manifest_verification_failed');
    error.code = storedVerification.code ?? 'manifest_verification_failed';
    throw error;
  }
  await emitEvent('context.manifest.persisted', {
    schemaVersion: '1.0.0',
    manifestId: durable.id,
    workspaceId: durable.workspaceId,
    runId,
    requestId: durable.requestId,
    compilerVersion: durable.compilerVersion,
    manifestFingerprint: durable.manifestFingerprint,
    assemblyFingerprint: durable.assembly.assemblyFingerprint,
    selectedCount: durable.selected.length,
    excludedCount: durable.excluded.length,
    conflictCount: durable.conflicts.length,
    tokenBudget: durable.budget,
    occurredAt: createdAt
  });
  if (afterPersist) await afterPersist({ manifest: durable, verification: storedVerification });
  return {
    schemaVersion: '1.0.0',
    persisted: true,
    manifest: durable,
    candidateGeneration: compiled.candidateGeneration ?? null,
    selection: compiled.selection ?? compiled.manifest.selection ?? null,
    verification: storedVerification
  };
}

const RAW_FEEDBACK_KEYS = new Set(['rawOutput', 'rawPrompt', 'rawContext', 'rawBody', 'body', 'text', 'content', 'localPath', 'path', 'credential', 'credentials', 'secret', 'token', 'hiddenReasoning']);
const OUTCOME_DIRECTIONS = new Set(['positive', 'negative', 'neutral', 'unknown']);
const EXPERIMENT_ARMS = new Set(['baseline', 'variant', 'rollback']);

function assertFeedbackId(value, name) {
  return requireString(value, name, { maxBytes: 160, pattern: /^[a-z][a-z0-9_.:-]*$/ });
}

function assertNoRawFeedbackFields(value, name) {
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (RAW_FEEDBACK_KEYS.has(key) || key.toLowerCase().includes('raw')) {
      const error = new Error(`${name}_raw_field`);
      error.code = `${name}_raw_field`;
      throw error;
    }
  }
}

function normalizeOutcomeReference(input) {
  assertPlainObject(input, 'context outcome reference');
  assertNoRawFeedbackFields(input, 'context_outcome');
  const outcomeId = assertFeedbackId(input.outcomeId ?? input.id, 'context outcome id');
  requireString(input.kind, 'context outcome kind', { maxBytes: 64, pattern: /^[a-z][a-z0-9_.:-]*$/ });
  requireString(input.metric, 'context outcome metric', { maxBytes: 128, pattern: /^[a-z][a-z0-9_.:-]*$/ });
  requireIsoTimestamp(input.observedAt, 'context outcome observedAt');
  const direction = input.direction ?? 'unknown';
  if (!OUTCOME_DIRECTIONS.has(direction)) throw new Error('context_outcome_direction_invalid');
  return {
    outcomeId,
    kind: input.kind,
    metric: input.metric,
    direction,
    observedAt: input.observedAt,
    evidenceRef: input.evidenceRef ? assertFeedbackId(input.evidenceRef, 'context outcome evidenceRef') : null
  };
}

function normalizeUsedRecord(input, selectedIds, outcomeIds) {
  assertPlainObject(input, 'context selected record use');
  assertNoRawFeedbackFields(input, 'context_use');
  const recordId = assertFeedbackId(input.recordId ?? input.id, 'context use recordId');
  if (!selectedIds.has(recordId)) {
    const error = new Error('context_use_unselected_record');
    error.code = 'context_use_unselected_record';
    throw error;
  }
  const evidenceRefs = normalizeStringArray(input.evidenceRefs ?? [], 'context use evidenceRefs', { max: 32, pattern: /^[a-z][a-z0-9_.:-]*$/ });
  const refs = normalizeStringArray(input.outcomeRefs ?? [], 'context use outcomeRefs', { max: 32, pattern: /^[a-z][a-z0-9_.:-]*$/ });
  for (const ref of refs) if (!outcomeIds.has(ref)) throw new Error('context_use_unknown_outcome_ref');
  return {
    recordId,
    useState: 'used',
    evidenceRefs,
    outcomeRefs: refs
  };
}

function manifestSelectionPolicy(manifest) {
  return manifest.selectionPolicy ?? {
    version: manifest.selection?.selectionPolicyVersion ?? manifest.selectionSummary?.selectionPolicyVersion ?? null,
    fingerprint: manifest.selection?.selectionPolicyFingerprint ?? manifest.selectionSummary?.selectionPolicyFingerprint ?? null,
    resultFingerprint: manifest.selection?.resultFingerprint ?? manifest.selectionSummary?.resultFingerprint ?? null,
    candidateGenerationFingerprint: manifest.selection?.candidateGenerationFingerprint ?? manifest.selectionSummary?.candidateGenerationFingerprint ?? null
  };
}

export function recordContextUseFeedback({
  id = null,
  manifest,
  runId,
  taskId = null,
  actorId = null,
  usedRecords = [],
  outcomeReferences = [],
  createdAt = null
} = {}) {
  assertPlainObject(manifest, 'context manifest');
  assertFeedbackId(runId, 'context feedback runId');
  if (!Array.isArray(usedRecords)) throw new Error('context_use_records_array_required');
  if (!Array.isArray(outcomeReferences)) throw new Error('context_outcome_references_array_required');
  const selected = (manifest.selected ?? []).map((item, index) => ({
    recordId: assertFeedbackId(item.id, 'context feedback selected id'),
    selectedOrder: Number.isInteger(item.order) ? item.order : index + 1
  }));
  const selectedIds = new Set(selected.map((item) => item.recordId));
  const outcomes = outcomeReferences.map(normalizeOutcomeReference).sort((a, b) => a.outcomeId.localeCompare(b.outcomeId));
  const outcomeIds = new Set(outcomes.map((item) => item.outcomeId));
  const usedById = new Map(usedRecords.map((item) => {
    const normalized = normalizeUsedRecord(item, selectedIds, outcomeIds);
    return [normalized.recordId, normalized];
  }));
  const selectionPolicy = manifestSelectionPolicy(manifest);
  const feedback = {
    schemaVersion: '1.0.0',
    id: id ?? prefixedId('ctxuse'),
    workspaceId: manifest.workspaceId,
    runId,
    taskId,
    actorId,
    createdAt: createdAt ?? nowIso(),
    contextManifest: {
      id: manifest.id,
      requestId: manifest.requestId ?? null,
      manifestFingerprint: manifest.manifestFingerprint ?? hashRef(stableStringify({
        id: manifest.id,
        selected: selected.map((item) => item.recordId),
        excluded: (manifest.excluded ?? []).map((item) => item.id)
      })),
      assemblyFingerprint: manifest.assembly?.assemblyFingerprint ?? null,
      compilerVersion: manifest.compilerVersion ?? COMPILER_VERSION,
      selectionPolicyVersion: selectionPolicy.version,
      selectionPolicyFingerprint: selectionPolicy.fingerprint,
      selectionResultFingerprint: selectionPolicy.resultFingerprint,
      selectedRecordIds: selected.map((item) => item.recordId)
    },
    selectedRecordUse: selected.map((item) => {
      const used = usedById.get(item.recordId);
      return {
        recordId: item.recordId,
        selectedOrder: item.selectedOrder,
        useState: used?.useState ?? 'not_observed',
        evidenceRefs: used?.evidenceRefs ?? [],
        outcomeRefs: used?.outcomeRefs ?? []
      };
    }),
    outcomeReferences: outcomes,
    causalClaim: 'none'
  };
  feedback.feedbackFingerprint = hashRef(stableStringify(feedback));
  return deepFreeze(feedback);
}

export function summarizeContextUseFeedback(records) {
  if (!Array.isArray(records)) throw new Error('context feedback records must be an array');
  const recordUse = {};
  const outcomes = { positive: 0, negative: 0, neutral: 0, unknown: 0 };
  for (const record of records) {
    assertPlainObject(record, 'context feedback record');
    for (const item of record.selectedRecordUse ?? []) {
      const summary = recordUse[item.recordId] ?? { selectedCount: 0, usedCount: 0, notObservedCount: 0, outcomeRefs: [] };
      summary.selectedCount += 1;
      if (item.useState === 'used') summary.usedCount += 1;
      else summary.notObservedCount += 1;
      summary.outcomeRefs.push(...(item.outcomeRefs ?? []));
      summary.outcomeRefs = [...new Set(summary.outcomeRefs)].sort();
      recordUse[item.recordId] = summary;
    }
    for (const outcome of record.outcomeReferences ?? []) outcomes[outcome.direction ?? 'unknown'] = (outcomes[outcome.direction ?? 'unknown'] ?? 0) + 1;
  }
  return deepFreeze({
    schemaVersion: '1.0.0',
    totalFeedbackRecords: records.length,
    recordUse: Object.fromEntries(Object.entries(recordUse).sort(([left], [right]) => left.localeCompare(right))),
    outcomes,
    causalClaim: 'none'
  });
}

function validateEvaluationReport(report, name = 'selector evaluation report') {
  assertPlainObject(report, name);
  if (report.passed !== true) throw new Error('selector_default_requires_passing_evaluation');
  assertFeedbackId(report.reportId, `${name} reportId`);
  if (!Number.isInteger(report.evaluationCount) || report.evaluationCount < 1) throw new Error('selector_default_requires_evaluation_count');
  if (!Number.isInteger(report.regressionCount) || report.regressionCount !== 0) throw new Error('selector_default_requires_zero_regressions');
  assertPlainObject(report.metrics ?? {}, `${name} metrics`);
  if (Number(report.metrics.requiredRecall ?? 0) < 1) throw new Error('selector_default_requires_required_recall');
  if (Number(report.metrics.contextUseFeedbackCount ?? 0) < 1) throw new Error('selector_default_requires_feedback_evidence');
  requireString(report.rollbackPlan, `${name} rollbackPlan`, { maxBytes: 4096 });
  return {
    reportId: report.reportId,
    passed: true,
    evaluationCount: report.evaluationCount,
    regressionCount: report.regressionCount,
    metrics: cloneJson(report.metrics),
    rollbackPlan: report.rollbackPlan
  };
}

export function createSelectorExperiment({
  id = null,
  workspaceId = 'ws_local',
  baselinePolicy = CONTEXT_SELECTION_POLICY,
  variantPolicy,
  evaluationReport,
  createdAt = null
} = {}) {
  const baseline = validateContextSelectionPolicy(baselinePolicy);
  const variant = validateContextSelectionPolicy(variantPolicy);
  const baselineFingerprint = contextSelectionPolicyFingerprint(baseline);
  const variantFingerprint = contextSelectionPolicyFingerprint(variant);
  if (baselineFingerprint === variantFingerprint) throw new Error('selector_experiment_requires_distinct_variant');
  const experiment = {
    schemaVersion: '1.0.0',
    id: id ?? prefixedId('ctxexp'),
    workspaceId,
    status: 'review',
    reversible: true,
    createdAt: createdAt ?? nowIso(),
    baseline: {
      policyVersion: baseline.policyVersion,
      policyFingerprint: baselineFingerprint,
      policy: baseline
    },
    variant: {
      policyVersion: variant.policyVersion,
      policyFingerprint: variantFingerprint,
      policy: variant
    },
    evaluationReport: validateEvaluationReport(evaluationReport, 'selector experiment evaluation report'),
    defaultChanged: false
  };
  experiment.experimentFingerprint = hashRef(stableStringify({
    id: experiment.id,
    workspaceId: experiment.workspaceId,
    baseline: experiment.baseline.policyFingerprint,
    variant: experiment.variant.policyFingerprint,
    evaluationReportId: experiment.evaluationReport.reportId
  }));
  return deepFreeze(experiment);
}

export function resolveSelectorExperimentPolicy(experiment, { arm = 'baseline' } = {}) {
  assertPlainObject(experiment, 'selector experiment');
  if (!EXPERIMENT_ARMS.has(arm)) throw new Error('selector_experiment_arm_invalid');
  const selected = arm === 'variant' ? experiment.variant : experiment.baseline;
  return deepFreeze({
    schemaVersion: '1.0.0',
    experimentId: experiment.id,
    arm,
    policyVersion: selected.policyVersion,
    policyFingerprint: selected.policyFingerprint,
    policy: selected.policy,
    reversibleToFingerprint: experiment.baseline.policyFingerprint,
    defaultChanged: false
  });
}

export function promoteSelectorDefault({ candidatePolicy, evaluationReport, createdAt = null } = {}) {
  const policy = validateContextSelectionPolicy(candidatePolicy);
  const report = validateEvaluationReport(evaluationReport);
  const plan = {
    schemaVersion: '1.0.0',
    id: prefixedId('ctxprom'),
    status: 'review_required',
    createdAt: createdAt ?? nowIso(),
    candidatePolicyVersion: policy.policyVersion,
    candidatePolicyFingerprint: contextSelectionPolicyFingerprint(policy),
    evaluationReportId: report.reportId,
    evaluationReport: report,
    requiresHumanApproval: true,
    defaultChanged: false,
    rollbackPlan: report.rollbackPlan
  };
  plan.promotionFingerprint = hashRef(stableStringify(plan));
  return deepFreeze(plan);
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
  return selectContextCandidates(request, inputRecords).manifest;
}
