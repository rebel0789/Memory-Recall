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
const INGESTION_FORMATS = new Set(['text', 'markdown', 'json', 'rss', 'atom']);
const DEFAULT_MAX_SOURCE_BYTES = 256 * 1024;
const DEFAULT_MAX_ITEMS_PER_SOURCE = 100;

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

function optionalIso(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
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

function ingestionFailure({ index, sourceLocator = null, sourceSnapshotId = null, code, message }) {
  return deepFreeze({
    index,
    sourceLocator,
    sourceSnapshotId,
    code,
    message
  });
}

function inferSourceFormat(source) {
  const explicit = source.format ? String(source.format).toLowerCase() : null;
  if (explicit) {
    if (!INGESTION_FORMATS.has(explicit)) throw new Error('source format is unsupported');
    return explicit;
  }
  const mediaType = String(source.mediaType ?? '').toLowerCase();
  const filename = String(source.filename ?? source.sourceLocator ?? '').toLowerCase();
  if (mediaType.includes('atom') || filename.endsWith('.atom')) return 'atom';
  if (mediaType.includes('rss') || mediaType.includes('xml') || filename.endsWith('.rss')) return 'rss';
  if (mediaType.includes('json') || filename.endsWith('.json')) return 'json';
  if (mediaType.includes('markdown') || filename.endsWith('.md') || filename.endsWith('.markdown')) return 'markdown';
  return 'text';
}

function mediaTypeForFormat(format, source) {
  if (source.mediaType) return String(source.mediaType);
  if (format === 'json') return 'application/json';
  if (format === 'markdown') return 'text/markdown';
  if (format === 'rss') return 'application/rss+xml';
  if (format === 'atom') return 'application/atom+xml';
  return 'text/plain';
}

function retrievalMethodForFormat(format, source) {
  if (source.retrievalMethod) return String(source.retrievalMethod);
  if (format === 'rss' || format === 'atom') return 'feed-import';
  return 'file-read';
}

function assertSafeSourceLocator(value) {
  const locator = requireString(value, 'sourceLocator');
  try {
    const parsed = new URL(locator);
    if (parsed.username || parsed.password) throw new Error('sourceLocator must not contain credentials');
  } catch (error) {
    if (error.message === 'sourceLocator must not contain credentials') throw error;
  }
  return locator;
}

function normalizeIngestionOptions(input) {
  assertPlainObject(input, 'research ingestion options');
  const collectedAt = requireIso(input.collectedAt ?? input.capturedAt, 'collectedAt');
  const maxSourceBytes = Math.max(1, Math.min(Number(input.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES), DEFAULT_MAX_SOURCE_BYTES));
  const maxItemsPerSource = Math.max(1, Math.min(Number(input.maxItemsPerSource ?? DEFAULT_MAX_ITEMS_PER_SOURCE), DEFAULT_MAX_ITEMS_PER_SOURCE));
  return {
    workspaceId: input.workspaceId ?? 'ws_local',
    collectedAt,
    capturedAt: requireIso(input.capturedAt ?? collectedAt, 'capturedAt'),
    collector: input.collector ?? 'provider:native:evidence:ingestion',
    maxSourceBytes,
    maxItemsPerSource
  };
}

function sourceText(source) {
  if (source.body !== undefined) return toBuffer(source.body).toString('utf8');
  if (source.text !== undefined) return toBuffer(source.text).toString('utf8');
  if (source.content !== undefined) return toBuffer(source.content).toString('utf8');
  throw new Error('source body is required');
}

function compactText(value) {
  return String(value ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeXmlEntities(value) {
  return String(value ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function xmlTag(block, name) {
  const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i').exec(block);
  return match ? compactText(decodeXmlEntities(match[1])) : null;
}

function atomLink(block) {
  const href = /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i.exec(block);
  if (href) return decodeXmlEntities(href[1]).trim();
  return xmlTag(block, 'link');
}

function xmlBlocks(text, name) {
  return [...String(text).matchAll(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'gi'))].map((match) => match[1]);
}

function parseTextLikeSource({ text, source, format }) {
  const body = compactText(text);
  if (!body) throw new Error('source has no ingestible text');
  return [{
    text: body,
    title: source.title ?? source.filename ?? null,
    itemLocator: source.sourceLocator ?? null,
    platform: format === 'markdown' ? 'markdown-file' : 'text-file',
    creator: source.creator ?? 'unknown',
    publishedAt: optionalIso(source.publishedAt),
    observed: { ingestion: { format, itemType: 'document' } }
  }];
}

function textFromJsonItem(item) {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return '';
  return item.text ?? item.content ?? item.body ?? item.description ?? item.summary ?? item.title ?? '';
}

function parseJsonSource({ text, source, maxItemsPerSource }) {
  const parsed = JSON.parse(text);
  const rows = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.items) ? parsed.items : (Array.isArray(parsed.observations) ? parsed.observations : [parsed]));
  const items = rows.slice(0, maxItemsPerSource).map((row, index) => {
    const body = compactText(textFromJsonItem(row));
    if (!body) return null;
    const object = row && typeof row === 'object' && !Array.isArray(row) ? row : {};
    return {
      text: body,
      title: object.title ?? null,
      itemLocator: object.url ?? object.link ?? object.id ?? `${source.sourceLocator ?? 'json'}#${index}`,
      platform: 'json-file',
      creator: object.creator ?? object.author ?? source.creator ?? 'unknown',
      publishedAt: optionalIso(object.publishedAt ?? object.published_at ?? object.date),
      metricAt: optionalIso(object.metricAt ?? object.metric_at),
      observed: {
        ingestion: { format: 'json', itemType: 'record', keys: Object.keys(object).sort().slice(0, 16) },
        metrics: object.metrics && typeof object.metrics === 'object' && !Array.isArray(object.metrics) ? clonePlain(object.metrics, 'metrics') : {}
      }
    };
  }).filter(Boolean);
  if (!items.length) throw new Error('JSON source has no ingestible records');
  return items;
}

function parseRssSource({ text, source, maxItemsPerSource }) {
  const blocks = xmlBlocks(text, 'item').slice(0, maxItemsPerSource);
  if (!blocks.length) throw new Error('RSS source has no item entries');
  return blocks.map((block, index) => {
    const title = xmlTag(block, 'title');
    const description = xmlTag(block, 'description') ?? xmlTag(block, 'content:encoded');
    const link = xmlTag(block, 'link') ?? xmlTag(block, 'guid') ?? `${source.sourceLocator ?? 'rss'}#item-${index}`;
    const textValue = compactText([title, description].filter(Boolean).join(' — '));
    return {
      text: textValue,
      title,
      itemLocator: link,
      platform: 'rss-feed',
      creator: xmlTag(block, 'author') ?? xmlTag(block, 'dc:creator') ?? source.creator ?? 'unknown',
      publishedAt: optionalIso(xmlTag(block, 'pubDate') ?? xmlTag(block, 'published')),
      observed: { ingestion: { format: 'rss', itemType: 'feed-entry', guid: xmlTag(block, 'guid') ?? null } }
    };
  }).filter((item) => item.text);
}

function parseAtomSource({ text, source, maxItemsPerSource }) {
  const blocks = xmlBlocks(text, 'entry').slice(0, maxItemsPerSource);
  if (!blocks.length) throw new Error('Atom source has no entry elements');
  return blocks.map((block, index) => {
    const title = xmlTag(block, 'title');
    const summary = xmlTag(block, 'summary') ?? xmlTag(block, 'content');
    const link = atomLink(block) ?? xmlTag(block, 'id') ?? `${source.sourceLocator ?? 'atom'}#entry-${index}`;
    const textValue = compactText([title, summary].filter(Boolean).join(' — '));
    return {
      text: textValue,
      title,
      itemLocator: link,
      platform: 'atom-feed',
      creator: xmlTag(block, 'name') ?? source.creator ?? 'unknown',
      publishedAt: optionalIso(xmlTag(block, 'published') ?? xmlTag(block, 'updated')),
      observed: { ingestion: { format: 'atom', itemType: 'feed-entry', atomId: xmlTag(block, 'id') ?? null } }
    };
  }).filter((item) => item.text);
}

function parseResearchItems({ format, text, source, maxItemsPerSource }) {
  if (format === 'json') return parseJsonSource({ text, source, maxItemsPerSource });
  if (format === 'rss') return parseRssSource({ text, source, maxItemsPerSource });
  if (format === 'atom') return parseAtomSource({ text, source, maxItemsPerSource });
  return parseTextLikeSource({ text, source, format });
}

function observationIdFor({ snapshot, item, index }) {
  return `obs_${sha256(canonicalStringify({ snapshot: snapshot.id, item: item.itemLocator ?? item.text, index })).slice(0, 32)}`;
}

function normalizeIngestedObservation({ snapshot, item, workspaceId, collectedAt, source }) {
  return normalizeObservation({
    id: item.id ?? observationIdFor({ snapshot, item, index: source.index }),
    workspaceId,
    sourceSnapshotId: snapshot.id,
    sourceContentHash: snapshot.contentHash,
    source: item.itemLocator ?? snapshot.sourceLocator,
    platform: item.platform,
    creator: item.creator ?? 'unknown',
    text: item.text,
    publishedAt: item.publishedAt ?? null,
    collectedAt,
    metricAt: item.metricAt ?? item.publishedAt ?? collectedAt,
    observed: item.observed ?? {},
    inferred: {},
    trust: 'untrusted-external'
  });
}

export function ingestResearchSources(input, options = {}) {
  const request = Array.isArray(input) ? { sources: input, ...options } : input;
  assertPlainObject(request, 'research ingestion request');
  const sources = request.sources;
  if (!Array.isArray(sources)) throw new Error('research ingestion requires sources array');
  const settings = normalizeIngestionOptions(request);
  const snapshots = [];
  const observations = [];
  const failures = [];
  const duplicates = [];
  const observationByContentHash = new Map();

  sources.forEach((sourceInput, index) => {
    try {
      assertPlainObject(sourceInput, 'research source');
      const source = { ...sourceInput, index };
      const text = sourceText(source);
      const bytes = Buffer.byteLength(text, 'utf8');
      const sourceLocator = assertSafeSourceLocator(source.sourceLocator ?? `inline://${index + 1}`);
      if (bytes > settings.maxSourceBytes) {
        failures.push(ingestionFailure({ index, sourceLocator, code: 'source_too_large', message: 'source exceeds configured byte bound' }));
        return;
      }
      const format = inferSourceFormat(source);
      const snapshot = normalizeSourceSnapshot({
        id: source.snapshotId,
        workspaceId: settings.workspaceId,
        body: text,
        mediaType: mediaTypeForFormat(format, source),
        filename: source.filename ?? null,
        dataClass: source.dataClass ?? 'workspace-private',
        retention: source.retention ?? { mode: 'workspace-default' },
        capturedAt: settings.capturedAt,
        createdAt: settings.capturedAt,
        collector: source.collector ?? settings.collector,
        retrievalMethod: retrievalMethodForFormat(format, source),
        sourceLocator,
        metadata: {
          format,
          title: source.title ?? null,
          itemLimit: settings.maxItemsPerSource
        }
      });
      snapshots.push(snapshot);
      let items;
      try {
        items = parseResearchItems({ format, text, source: { ...source, sourceLocator }, maxItemsPerSource: settings.maxItemsPerSource });
      } catch (error) {
        failures.push(ingestionFailure({ index, sourceLocator, sourceSnapshotId: snapshot.id, code: 'malformed_source', message: error.message }));
        return;
      }
      for (const item of items) {
        const observation = normalizeIngestedObservation({ snapshot, item, workspaceId: settings.workspaceId, collectedAt: settings.collectedAt, source });
        const existing = observationByContentHash.get(observation.contentHash);
        if (existing) {
          duplicates.push(deepFreeze({
            contentHash: observation.contentHash,
            canonicalObservationId: existing.id,
            duplicateObservationId: observation.id,
            sourceSnapshotId: snapshot.id,
            reasonCodes: ['same_content_hash']
          }));
          continue;
        }
        observationByContentHash.set(observation.contentHash, observation);
        observations.push(observation);
      }
      if (!items.length) {
        failures.push(ingestionFailure({ index, sourceLocator, sourceSnapshotId: snapshot.id, code: 'no_ingestible_items', message: 'source contained no usable observations' }));
      }
    } catch (error) {
      failures.push(ingestionFailure({ index, code: 'invalid_source', message: error.message }));
    }
  });

  return deepFreeze({
    schemaVersion: '1.0.0',
    workspaceId: settings.workspaceId,
    collectedAt: settings.collectedAt,
    sourceCount: sources.length,
    snapshots: snapshots.sort((left, right) => left.id.localeCompare(right.id)),
    observations: observations.sort((left, right) => left.id.localeCompare(right.id)),
    duplicates: duplicates.sort((left, right) => left.duplicateObservationId.localeCompare(right.duplicateObservationId)),
    failures: failures.sort((left, right) => left.index - right.index || left.code.localeCompare(right.code)),
    summary: {
      acceptedSources: snapshots.length,
      observationCount: observations.length,
      duplicateCount: duplicates.length,
      failureCount: failures.length,
      maxSourceBytes: settings.maxSourceBytes,
      maxItemsPerSource: settings.maxItemsPerSource
    },
    externalAccess: {
      network: false,
      browserAutomation: false,
      cookies: false,
      paidApis: false,
      externalWrites: false
    }
  });
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
