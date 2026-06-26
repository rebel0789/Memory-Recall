import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { extractTemporalFactProposalsFromEpisode } from '../../../../packages/memory-core/src/index.mjs';
import { prefixedId, nowIso, assertPlainObject, stableStringify, sha256Hex } from '../../../../packages/protocol/src/index.mjs';

const PROVIDER_ID = 'provider:native:memory:sqlite';
const STATUSES = new Set(['observed', 'proposed', 'verified', 'active', 'rejected', 'superseded', 'retracted', 'expired', 'quarantined']);
const SCOPES = new Set(['public', 'workspace-private', 'user-private', 'restricted']);
const DATA_CLASSES = new Set(['public', 'workspace-private', 'sensitive', 'secret']);
const DECISIONS = new Set(['propose', 'review', 'allow', 'reject']);
const QUEUE_STATUSES = new Set(['pending', 'claimed', 'applied', 'poison']);
const MEMORY_KINDS = new Set(['fact', 'preference', 'decision', 'episode', 'procedure', 'constraint']);
const TEMPORAL_MEMORY_SCOPES = new Set(['workspace', 'session', 'agent', 'user']);
const QUEUE_ID_PATTERN = /^mpq_[A-Za-z0-9._-]{1,128}$/;
const TEMPORAL_FACT_ID_PATTERN = /^memfact_[A-Za-z0-9._-]{1,128}$/;
const TEMPORAL_EPISODE_ID_PATTERN = /^mep_[A-Za-z0-9._-]{1,128}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/g,
  /AKIA[0-9A-Z]{16}/g,
  /gho_[A-Za-z0-9_]{20,}/g,
  /\b[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION|PRIVATE[_-]?KEY|DATABASE_URL|DB_URL|CONNECTION_STRING)\s*=\s*[^,\s]+/gi,
  /\b(?:token|secret|password|authorization|api[_-]?key|database_url|db_url|connection_string)\s*=\s*[^,\s]+/gi
];
const LOCAL_PATH_PATTERNS = [
  /file:\/\/\/[^\s)'"<>]+/g,
  /workspace:\/\/\/[^\s)'"<>]+/g,
  /(?:^|[\s('"`])\/(?:Users|private|tmp|var\/folders|var\/tmp|Volumes)\/[^\s)'"<>]+/g,
  /\b[A-Za-z]:\\[^\s)'"<>]+/g
];

function clamp(value, fallback = 0.5) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function contentHash(record) {
  return createHash('sha256').update(JSON.stringify({
    workspaceId: record.workspaceId,
    kind: record.kind,
    text: record.text,
    source: record.source,
    observedAt: record.observedAt,
    validFrom: record.validFrom,
    validTo: record.validTo,
    supersedes: record.supersedes,
    metadata: record.metadata
  })).digest('hex');
}

function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function deterministicId(prefix, value) {
  return `${prefix}_${stableHash(value).slice(0, 32)}`;
}

function queueFingerprint({ workspaceId, sourceLocator, sourceHash, payload }) {
  return stableHash({ workspaceId, sourceLocator, sourceHash, payload });
}

function redactQueueString(value, maximum = 512) {
  let text = String(value ?? '');
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[redacted-secret]');
  for (const pattern of LOCAL_PATH_PATTERNS) text = text.replace(pattern, (match) => match.startsWith(' ') ? ' [redacted-local-path]' : '[redacted-local-path]');
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > maximum ? `${normalized.slice(0, Math.max(0, maximum - 1)).trim()}...` : normalized;
}

function safeQueueKey(value) {
  const key = String(value ?? '');
  return /^[A-Za-z0-9._:-]{1,128}$/.test(key) && redactQueueString(key) === key ? key : `redacted_${stableHash(key).slice(0, 16)}`;
}

function safeQueueScalar(value) {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactQueueString(value);
  return `sha256:${stableHash(value)}`;
}

function safeQueueObject(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const output = {};
  for (const [key, item] of Object.entries(input).slice(0, 64)) output[safeQueueKey(key)] = safeQueueScalar(item);
  return output;
}

function tokenizeQuery(value) {
  return [...new Set(String(value ?? '').toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])].slice(0, 24);
}

function ftsExpression(query) {
  const tokens = tokenizeQuery(query);
  return tokens.length ? tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(' OR ') : null;
}

function normalizeRecord(input, clock) {
  assertPlainObject(input, 'memory record');
  for (const key of ['workspaceId', 'kind', 'text', 'source']) {
    if (typeof input[key] !== 'string' || !input[key].trim()) throw new Error(`${key} is required`);
  }
  if (!MEMORY_KINDS.has(input.kind)) throw new Error(`unsupported memory kind: ${input.kind}`);
  if (Buffer.byteLength(input.text, 'utf8') > 1_000_000) throw new Error('memory text exceeds 1 MB');
  const status = input.status ?? 'active';
  const scope = input.scope ?? 'workspace-private';
  const dataClass = input.dataClass ?? (scope === 'public' ? 'public' : 'workspace-private');
  const decision = input.decision ?? (['active', 'verified'].includes(status) ? 'allow' : (['rejected', 'quarantined'].includes(status) ? 'reject' : 'review'));
  if (!STATUSES.has(status)) throw new Error(`unsupported memory status: ${status}`);
  if (!SCOPES.has(scope)) throw new Error(`unsupported memory scope: ${scope}`);
  if (!DATA_CLASSES.has(dataClass)) throw new Error(`unsupported memory dataClass: ${dataClass}`);
  if (!DECISIONS.has(decision)) throw new Error(`unsupported memory decision: ${decision}`);
  const timestamp = input.updatedAt ?? input.createdAt ?? clock();
  const id = input.id ?? prefixedId('mem');
  if (!/^mem_[A-Za-z0-9._-]{1,128}$/.test(id)) throw new Error('memory id must be a safe mem_ identifier');
  const record = {
    schemaVersion: '1.0.0',
    id,
    workspaceId: input.workspaceId,
    kind: input.kind,
    text: input.text,
    scope,
    status,
    source: input.source,
    sourceTrust: input.sourceTrust ?? 'unverified',
    decision,
    reasons: Array.isArray(input.reasons) ? [...new Set(input.reasons.map(String))].sort() : [],
    confidence: clamp(input.confidence),
    authority: clamp(input.authority),
    tags: Array.isArray(input.tags) ? [...new Set(input.tags.map(String))] : [],
    relations: Array.isArray(input.relations) ? [...new Set(input.relations.map(String))] : [],
    observedAt: input.observedAt ?? timestamp,
    validFrom: input.validFrom ?? null,
    validTo: input.validTo ?? null,
    supersedes: input.supersedes ?? null,
    retention: input.retention ?? 'workspace-default',
    dataClass,
    createdAt: input.createdAt ?? timestamp,
    updatedAt: timestamp,
    evidenceIds: Array.isArray(input.evidenceIds) ? [...new Set(input.evidenceIds.map(String))].sort() : [],
    conflicts: Array.isArray(input.conflicts) ? input.conflicts : [],
    verifiedBy: input.verifiedBy ?? null,
    activatedBy: input.activatedBy ?? null,
    lifecycle: Array.isArray(input.lifecycle) ? input.lifecycle : [],
    metadata: input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? input.metadata : {}
  };
  record.contentHash = input.contentHash ?? contentHash(record);
  return record;
}

function rowToRecord(row) {
  if (!row) return null;
  return {
    schemaVersion: '1.0.0',
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    text: row.text,
    scope: row.scope,
    status: row.status,
    source: row.source,
    sourceTrust: row.source_trust,
    decision: row.decision,
    reasons: parseJson(row.reasons_json, []),
    confidence: row.confidence,
    authority: row.authority,
    tags: parseJson(row.tags_json, []),
    relations: parseJson(row.relations_json, []),
    observedAt: row.observed_at,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    supersedes: row.supersedes,
    retention: row.retention,
    dataClass: row.data_class,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    contentHash: row.content_hash,
    evidenceIds: parseJson(row.evidence_ids_json, []),
    conflicts: parseJson(row.conflicts_json, []),
    verifiedBy: row.verified_by,
    activatedBy: row.activated_by,
    lifecycle: parseJson(row.lifecycle_json, []),
    metadata: parseJson(row.metadata_json, {})
  };
}

function rowToQueueRecord(row) {
  if (!row) return null;
  return {
    schemaVersion: '1.0.0',
    id: row.id,
    workspaceId: row.workspace_id,
    fingerprint: row.fingerprint,
    sourceLocator: row.source_locator,
    sourceHash: row.source_hash,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    payload: safeQueueObject(parseJson(row.payload_json, {})),
    result: row.result_json === null ? null : safeQueueObject(parseJson(row.result_json, {})),
    error: row.error_json === null ? null : safeQueueObject(parseJson(row.error_json, {})),
    enqueuedAt: row.enqueued_at,
    updatedAt: row.updated_at
  };
}

function assertWorkspaceLocator(value, name) {
  const text = String(value ?? '');
  if (!/^workspace:\/\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,512}$/.test(text) || text.includes('..') || text.startsWith('workspace:///')) {
    throw new Error(`${name} must be a safe workspace locator`);
  }
  return text;
}

function boundedJson(value, maximumBytes = 4096) {
  const json = JSON.stringify(value ?? null);
  return Buffer.byteLength(json, 'utf8') > maximumBytes
    ? JSON.stringify({ message: 'error payload truncated', code: 'payload_too_large' })
    : json;
}

function byteLength(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

function temporalRank(validFrom, at) {
  const ageMs = Math.max(0, Date.parse(at) - Date.parse(validFrom));
  return 1 / (1 + ageMs / 86_400_000);
}

function assertIsoTimestamp(value, name) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new Error(`${name} must be an ISO-8601 timestamp`);
  return value;
}

function normalizeTemporalScope(value = 'workspace') {
  if (!TEMPORAL_MEMORY_SCOPES.has(value)) throw new Error(`unsupported temporal memory scope: ${value}`);
  return value;
}

function normalizeTemporalText(value, name, maximumBytes = 1_000_000) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  if (Buffer.byteLength(value, 'utf8') > maximumBytes) throw new Error(`${name} exceeds ${maximumBytes} bytes`);
  return value;
}

function normalizeTemporalFactInput(input, clock) {
  assertPlainObject(input, 'temporal memory fact');
  const workspaceId = normalizeTemporalText(input.workspaceId, 'workspaceId', 512);
  const scope = normalizeTemporalScope(input.scope);
  const validFrom = assertIsoTimestamp(input.validFrom ?? clock(), 'validFrom');
  const id = input.id ?? prefixedId('memfact');
  if (!TEMPORAL_FACT_ID_PATTERN.test(id)) throw new Error('temporal fact id must be a safe memfact_ identifier');
  if (input.validUntil !== undefined && input.validUntil !== null) assertIsoTimestamp(input.validUntil, 'validUntil');
  return {
    schemaVersion: '1.0.0',
    id,
    workspaceId,
    scope,
    subject: normalizeTemporalText(input.subject, 'subject', 512),
    predicate: normalizeTemporalText(input.predicate, 'predicate', 256),
    object: normalizeTemporalText(input.object, 'object'),
    text: normalizeTemporalText(input.text, 'text'),
    status: input.status ?? 'active',
    source: assertWorkspaceLocator(input.source, 'source'),
    confidence: clamp(input.confidence),
    validFrom,
    validUntil: input.validUntil ?? null,
    supersededBy: input.supersededBy ?? null,
    episodeId: input.episodeId ?? input.episode?.id ?? null,
    proposalQueueId: input.proposalQueueId ?? input.proposalId ?? null,
    createdAt: input.createdAt ?? clock(),
    updatedAt: input.updatedAt ?? input.createdAt ?? clock(),
    metadata: input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? input.metadata : {},
    episode: input.episode ?? null
  };
}

function normalizeTemporalEpisodeInput(input, fact, clock) {
  const episode = input ? assertPlainObject(input, 'temporal memory episode') : {};
  const id = episode.id ?? fact.episodeId ?? prefixedId('mep');
  if (!TEMPORAL_EPISODE_ID_PATTERN.test(id)) throw new Error('temporal episode id must be a safe mep_ identifier');
  return {
    schemaVersion: '1.0.0',
    id,
    workspaceId: fact.workspaceId,
    scope: fact.scope,
    sourceLocator: assertWorkspaceLocator(episode.sourceLocator ?? fact.source, 'episode sourceLocator'),
    summary: normalizeTemporalText(episode.summary ?? fact.text, 'episode summary', 4096),
    observedAt: assertIsoTimestamp(episode.observedAt ?? fact.validFrom, 'episode observedAt'),
    createdAt: episode.createdAt ?? clock(),
    metadata: episode.metadata && typeof episode.metadata === 'object' && !Array.isArray(episode.metadata) ? episode.metadata : {}
  };
}

function rowToTemporalEpisode(row) {
  if (!row) return null;
  return {
    schemaVersion: '1.0.0',
    id: row.id,
    workspaceId: row.workspace_id,
    scope: row.scope,
    sourceLocator: row.source_locator,
    summary: row.summary,
    observedAt: row.observed_at,
    createdAt: row.created_at,
    metadata: parseJson(row.metadata_json, {})
  };
}

function rowToTemporalFact(row, episode = null) {
  if (!row) return null;
  return {
    schemaVersion: '1.0.0',
    id: row.id,
    workspaceId: row.workspace_id,
    scope: row.scope,
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    text: row.text,
    status: row.status,
    source: row.source,
    confidence: row.confidence,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    supersededBy: row.superseded_by,
    episodeId: row.episode_id,
    proposalQueueId: row.proposal_queue_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: parseJson(row.metadata_json, {}),
    episode
  };
}

export class SQLiteMemoryProvider {
  constructor({ filename = ':memory:', clock = nowIso, migrate = true, readOnly = false } = {}) {
    this.filename = filename;
    this.clock = clock;
    if (filename !== ':memory:' && !readOnly) mkdirSync(path.dirname(path.resolve(filename)), { recursive: true, mode: 0o700 });
    this.database = readOnly ? new DatabaseSync(filename, { readOnly: true }) : new DatabaseSync(filename);
    if (migrate) this.#migrate();
  }

  #migrate() {
    if (this.filename !== ':memory:') this.database.exec('PRAGMA journal_mode=WAL;');
    this.database.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS memory_records (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        scope TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        source_trust TEXT NOT NULL DEFAULT 'unverified',
        decision TEXT NOT NULL DEFAULT 'allow',
        reasons_json TEXT NOT NULL DEFAULT '[]',
        confidence REAL NOT NULL,
        authority REAL NOT NULL,
        tags_json TEXT NOT NULL,
        relations_json TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        valid_from TEXT,
        valid_to TEXT,
        supersedes TEXT,
        retention TEXT NOT NULL,
        data_class TEXT NOT NULL DEFAULT 'workspace-private',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        evidence_ids_json TEXT NOT NULL DEFAULT '[]',
        conflicts_json TEXT NOT NULL DEFAULT '[]',
        verified_by TEXT,
        activated_by TEXT,
        lifecycle_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_workspace_status ON memory_records(workspace_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_supersedes ON memory_records(workspace_id, supersedes);
      CREATE TABLE IF NOT EXISTS memory_proposal_queue (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        source_locator TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        lease_owner TEXT,
        lease_until TEXT,
        payload_json TEXT NOT NULL,
        result_json TEXT,
        error_json TEXT,
        enqueued_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(workspace_id, fingerprint)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_proposal_queue_claim ON memory_proposal_queue(workspace_id, status, lease_until, enqueued_at);
      CREATE INDEX IF NOT EXISTS idx_memory_proposal_queue_errors ON memory_proposal_queue(workspace_id, status, updated_at DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        id UNINDEXED,
        workspace_id UNINDEXED,
        kind,
        text,
        tags,
        tokenize='unicode61 remove_diacritics 2'
      );
      CREATE TABLE IF NOT EXISTS memory_episodes (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        source_locator TEXT NOT NULL,
        summary TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_episodes_workspace ON memory_episodes(workspace_id, scope, observed_at DESC);
      CREATE TABLE IF NOT EXISTS memory_entities (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(workspace_id, scope, kind, name)
      );
      CREATE TABLE IF NOT EXISTS memory_facts (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        confidence REAL NOT NULL,
        valid_from TEXT NOT NULL,
        valid_until TEXT,
        superseded_by TEXT,
        episode_id TEXT NOT NULL,
        proposal_queue_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        FOREIGN KEY(episode_id) REFERENCES memory_episodes(id)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_facts_lookup ON memory_facts(workspace_id, scope, subject, predicate, valid_from, valid_until);
      CREATE INDEX IF NOT EXISTS idx_memory_facts_superseded ON memory_facts(workspace_id, superseded_by);
      CREATE INDEX IF NOT EXISTS idx_memory_facts_episode ON memory_facts(workspace_id, episode_id);
      CREATE TABLE IF NOT EXISTS memory_edges (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        source_entity_id TEXT NOT NULL,
        target_entity_id TEXT NOT NULL,
        predicate TEXT NOT NULL,
        fact_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(workspace_id, scope, fact_id),
        FOREIGN KEY(source_entity_id) REFERENCES memory_entities(id),
        FOREIGN KEY(target_entity_id) REFERENCES memory_entities(id),
        FOREIGN KEY(fact_id) REFERENCES memory_facts(id)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fact_fts USING fts5(
        id UNINDEXED,
        workspace_id UNINDEXED,
        scope UNINDEXED,
        subject,
        predicate,
        object,
        text,
        tokenize='unicode61 remove_diacritics 2'
      );
    `);
    this.#ensureColumn('memory_records', 'source_trust', "TEXT NOT NULL DEFAULT 'unverified'");
    this.#ensureColumn('memory_records', 'decision', "TEXT NOT NULL DEFAULT 'allow'");
    this.#ensureColumn('memory_records', 'reasons_json', "TEXT NOT NULL DEFAULT '[]'");
    this.#ensureColumn('memory_records', 'data_class', "TEXT NOT NULL DEFAULT 'workspace-private'");
    this.#ensureColumn('memory_records', 'evidence_ids_json', "TEXT NOT NULL DEFAULT '[]'");
    this.#ensureColumn('memory_records', 'conflicts_json', "TEXT NOT NULL DEFAULT '[]'");
    this.#ensureColumn('memory_records', 'verified_by', 'TEXT');
    this.#ensureColumn('memory_records', 'activated_by', 'TEXT');
    this.#ensureColumn('memory_records', 'lifecycle_json', "TEXT NOT NULL DEFAULT '[]'");
  }

  #ensureColumn(table, column, definition) {
    const columns = this.database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    if (!columns.includes(column)) this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }

  async health() {
    const row = this.database.prepare('PRAGMA integrity_check').get();
    return { status: row.integrity_check === 'ok' ? 'healthy' : 'degraded', local: true, details: { provider: PROVIDER_ID, storage: this.filename === ':memory:' ? 'memory' : 'sqlite-file', integrity: row.integrity_check } };
  }

  async capabilities() {
    return ['memory.put', 'memory.get', 'memory.search.lexical', 'memory.supersede', 'memory.forget', 'memory.export', 'memory.filesystemReports', 'memory.proposalQueue', 'memory.temporalFacts', 'memory.search.hybrid', 'memory.extract.proposals'];
  }

  #recordValues(record) {
    return {
      id: record.id,
      workspace_id: record.workspaceId,
      kind: record.kind,
      text: record.text,
      scope: record.scope,
      status: record.status,
      source: record.source,
      source_trust: record.sourceTrust,
      decision: record.decision,
      reasons_json: JSON.stringify(record.reasons),
      confidence: record.confidence,
      authority: record.authority,
      tags_json: JSON.stringify(record.tags),
      relations_json: JSON.stringify(record.relations),
      observed_at: record.observedAt,
      valid_from: record.validFrom,
      valid_to: record.validTo,
      supersedes: record.supersedes,
      retention: record.retention,
      data_class: record.dataClass,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
      content_hash: record.contentHash,
      evidence_ids_json: JSON.stringify(record.evidenceIds),
      conflicts_json: JSON.stringify(record.conflicts),
      verified_by: record.verifiedBy,
      activated_by: record.activatedBy,
      lifecycle_json: JSON.stringify(record.lifecycle),
      metadata_json: JSON.stringify(record.metadata)
    };
  }

  #writeRecord(record) {
    const existingOwner = this.database.prepare('SELECT workspace_id FROM memory_records WHERE id = ? AND workspace_id <> ? LIMIT 1').get(record.id, record.workspaceId);
    if (existingOwner) throw new Error('memory id already exists in another workspace');
    const values = this.#recordValues(record);
    this.database.prepare(`
      INSERT INTO memory_records (
        id, workspace_id, kind, text, scope, status, source, confidence, authority,
        source_trust, decision, reasons_json, tags_json, relations_json,
        observed_at, valid_from, valid_to, supersedes, retention, data_class,
        created_at, updated_at, content_hash, evidence_ids_json, conflicts_json,
        verified_by, activated_by, lifecycle_json, metadata_json
      ) VALUES (
        :id, :workspace_id, :kind, :text, :scope, :status, :source, :confidence, :authority,
        :source_trust, :decision, :reasons_json, :tags_json, :relations_json,
        :observed_at, :valid_from, :valid_to, :supersedes, :retention, :data_class,
        :created_at, :updated_at, :content_hash, :evidence_ids_json, :conflicts_json,
        :verified_by, :activated_by, :lifecycle_json, :metadata_json
      )
      ON CONFLICT(id) DO UPDATE SET
        workspace_id=excluded.workspace_id, kind=excluded.kind, text=excluded.text,
        scope=excluded.scope, status=excluded.status, source=excluded.source,
        source_trust=excluded.source_trust, decision=excluded.decision,
        reasons_json=excluded.reasons_json,
        confidence=excluded.confidence, authority=excluded.authority,
        tags_json=excluded.tags_json, relations_json=excluded.relations_json,
        observed_at=excluded.observed_at, valid_from=excluded.valid_from,
        valid_to=excluded.valid_to, supersedes=excluded.supersedes,
        retention=excluded.retention, data_class=excluded.data_class,
        updated_at=excluded.updated_at, content_hash=excluded.content_hash,
        evidence_ids_json=excluded.evidence_ids_json,
        conflicts_json=excluded.conflicts_json,
        verified_by=excluded.verified_by, activated_by=excluded.activated_by,
        lifecycle_json=excluded.lifecycle_json, metadata_json=excluded.metadata_json
    `).run(values);
    this.database.prepare('DELETE FROM memory_fts WHERE workspace_id = ? AND id = ?').run(record.workspaceId, record.id);
    this.database.prepare('INSERT INTO memory_fts(id, workspace_id, kind, text, tags) VALUES (?, ?, ?, ?, ?)')
      .run(record.id, record.workspaceId, record.kind, record.text, record.tags.join(' '));
  }

  async put(input) {
    const record = normalizeRecord(input, this.clock);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.#writeRecord(record);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return structuredClone(record);
  }

  async get({ workspaceId, id }) {
    if (!workspaceId || !id) throw new Error('workspaceId and id are required');
    return rowToRecord(this.database.prepare('SELECT * FROM memory_records WHERE workspace_id = ? AND id = ?').get(workspaceId, id));
  }

  async queryCandidates({ workspaceId, query = '', limit = 20, allowedScopes = ['public', 'workspace-private'], statuses = ['active', 'verified'], at = this.clock() }) {
    if (!workspaceId) throw new Error('workspaceId is required');
    const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const scopes = [...new Set(allowedScopes)].filter((scope) => SCOPES.has(scope));
    const allowedStatuses = [...new Set(statuses)].filter((status) => STATUSES.has(status));
    if (!scopes.length || !allowedStatuses.length) return [];
    const scopePlaceholders = scopes.map(() => '?').join(',');
    const statusPlaceholders = allowedStatuses.map(() => '?').join(',');
    const expression = ftsExpression(query);
    let rows;
    if (expression) {
      rows = this.database.prepare(`
        SELECT m.*, bm25(memory_fts) AS rank
        FROM memory_fts
        JOIN memory_records m ON m.id = memory_fts.id AND m.workspace_id = memory_fts.workspace_id
        WHERE memory_fts MATCH ?
          AND m.workspace_id = ?
          AND m.scope IN (${scopePlaceholders})
          AND m.status IN (${statusPlaceholders})
          AND (m.valid_from IS NULL OR m.valid_from <= ?)
          AND (m.valid_to IS NULL OR m.valid_to >= ?)
        ORDER BY rank ASC, m.updated_at DESC, m.id ASC
        LIMIT ?
      `).all(expression, workspaceId, ...scopes, ...allowedStatuses, at, at, boundedLimit);
    } else {
      rows = this.database.prepare(`
        SELECT m.*, 0 AS rank
        FROM memory_records m
        WHERE m.workspace_id = ?
          AND m.scope IN (${scopePlaceholders})
          AND m.status IN (${statusPlaceholders})
          AND (m.valid_from IS NULL OR m.valid_from <= ?)
          AND (m.valid_to IS NULL OR m.valid_to >= ?)
        ORDER BY m.updated_at DESC, m.id ASC
        LIMIT ?
      `).all(workspaceId, ...scopes, ...allowedStatuses, at, at, boundedLimit);
    }
    return rows.map((row) => ({ ...rowToRecord(row), provider: PROVIDER_ID, retrieval: { method: expression ? 'fts5' : 'recent', score: expression ? 1 / (1 + Math.abs(Number(row.rank ?? 0))) : 0.1 } }));
  }

  async supersede({ workspaceId, previousId, replacement }) {
    if (!workspaceId || !previousId) throw new Error('workspaceId and previousId are required');
    const previous = await this.get({ workspaceId, id: previousId });
    if (!previous) throw new Error(`memory not found: ${previousId}`);
    const next = normalizeRecord({ ...replacement, workspaceId, supersedes: previousId, status: replacement.status ?? 'active' }, this.clock);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('UPDATE memory_records SET status = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
        .run('superseded', this.clock(), workspaceId, previousId);
      this.#writeRecord(next);
      this.database.exec('COMMIT');
      return structuredClone(next);
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  async forget({ workspaceId, id }) {
    if (!workspaceId || !id) throw new Error('workspaceId and id are required');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.database.prepare('SELECT id FROM memory_records WHERE workspace_id = ? AND id = ?').get(workspaceId, id);
      if (!existing) { this.database.exec('ROLLBACK'); return false; }
      this.database.prepare('DELETE FROM memory_fts WHERE workspace_id = ? AND id = ?').run(workspaceId, id);
      this.database.prepare('DELETE FROM memory_records WHERE workspace_id = ? AND id = ?').run(workspaceId, id);
      this.database.exec('COMMIT');
      return true;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  async export({ workspaceId }) {
    if (!workspaceId) throw new Error('workspaceId is required');
    const records = this.database.prepare('SELECT * FROM memory_records WHERE workspace_id = ? ORDER BY created_at ASC, id ASC').all(workspaceId).map(rowToRecord);
    return { schemaVersion: '1.0.0', provider: PROVIDER_ID, workspaceId, exportedAt: this.clock(), records };
  }

  #assertAppliedProposal({ workspaceId, proposalQueueId }) {
    if (!proposalQueueId) throw new Error('proposal gate requires an applied memory proposal');
    const row = this.database.prepare('SELECT status FROM memory_proposal_queue WHERE workspace_id = ? AND id = ?').get(workspaceId, proposalQueueId);
    if (!row || row.status !== 'applied') throw new Error('proposal gate requires an applied memory proposal');
  }

  #upsertTemporalEpisode(episode) {
    this.database.prepare(`
      INSERT INTO memory_episodes (
        id, workspace_id, scope, source_locator, summary, observed_at, created_at, metadata_json
      ) VALUES (
        :id, :workspace_id, :scope, :source_locator, :summary, :observed_at, :created_at, :metadata_json
      )
      ON CONFLICT(id) DO UPDATE SET
        workspace_id=excluded.workspace_id,
        scope=excluded.scope,
        source_locator=excluded.source_locator,
        summary=excluded.summary,
        observed_at=excluded.observed_at,
        metadata_json=excluded.metadata_json
    `).run({
      id: episode.id,
      workspace_id: episode.workspaceId,
      scope: episode.scope,
      source_locator: episode.sourceLocator,
      summary: episode.summary,
      observed_at: episode.observedAt,
      created_at: episode.createdAt,
      metadata_json: JSON.stringify(episode.metadata)
    });
  }

  #upsertTemporalEntity({ workspaceId, scope, kind, name, now }) {
    const id = deterministicId('ment', { workspaceId, scope, kind, name });
    this.database.prepare(`
      INSERT INTO memory_entities (id, workspace_id, scope, kind, name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, scope, kind, name) DO UPDATE SET updated_at=excluded.updated_at
    `).run(id, workspaceId, scope, kind, name, now, now);
    return id;
  }

  #writeTemporalFact(fact) {
    this.database.prepare(`
      INSERT INTO memory_facts (
        id, workspace_id, scope, subject, predicate, object, text, status, source,
        confidence, valid_from, valid_until, superseded_by, episode_id, proposal_queue_id,
        created_at, updated_at, metadata_json
      ) VALUES (
        :id, :workspace_id, :scope, :subject, :predicate, :object, :text, :status, :source,
        :confidence, :valid_from, :valid_until, :superseded_by, :episode_id, :proposal_queue_id,
        :created_at, :updated_at, :metadata_json
      )
      ON CONFLICT(id) DO UPDATE SET
        workspace_id=excluded.workspace_id,
        scope=excluded.scope,
        subject=excluded.subject,
        predicate=excluded.predicate,
        object=excluded.object,
        text=excluded.text,
        status=excluded.status,
        source=excluded.source,
        confidence=excluded.confidence,
        valid_from=excluded.valid_from,
        valid_until=excluded.valid_until,
        superseded_by=excluded.superseded_by,
        episode_id=excluded.episode_id,
        proposal_queue_id=excluded.proposal_queue_id,
        updated_at=excluded.updated_at,
        metadata_json=excluded.metadata_json
    `).run({
      id: fact.id,
      workspace_id: fact.workspaceId,
      scope: fact.scope,
      subject: fact.subject,
      predicate: fact.predicate,
      object: fact.object,
      text: fact.text,
      status: fact.status,
      source: fact.source,
      confidence: fact.confidence,
      valid_from: fact.validFrom,
      valid_until: fact.validUntil,
      superseded_by: fact.supersededBy,
      episode_id: fact.episodeId,
      proposal_queue_id: fact.proposalQueueId,
      created_at: fact.createdAt,
      updated_at: fact.updatedAt,
      metadata_json: JSON.stringify(fact.metadata)
    });
    this.database.prepare('DELETE FROM memory_fact_fts WHERE workspace_id = ? AND id = ?').run(fact.workspaceId, fact.id);
    this.database.prepare('INSERT INTO memory_fact_fts(id, workspace_id, scope, subject, predicate, object, text) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(fact.id, fact.workspaceId, fact.scope, fact.subject, fact.predicate, fact.object, fact.text);
  }

  #temporalFactFromRow(row) {
    if (!row) return null;
    const episode = row.episode_id
      ? rowToTemporalEpisode(this.database.prepare('SELECT * FROM memory_episodes WHERE workspace_id = ? AND id = ?').get(row.workspace_id, row.episode_id))
      : null;
    return rowToTemporalFact(row, episode);
  }

  async addTemporalFact(input) {
    const normalized = normalizeTemporalFactInput(input, this.clock);
    if (normalized.status !== 'active') throw new Error('temporal facts can only be added as active facts');
    this.#assertAppliedProposal({ workspaceId: normalized.workspaceId, proposalQueueId: normalized.proposalQueueId });
    const episode = normalizeTemporalEpisodeInput(normalized.episode, normalized, this.clock);
    normalized.episodeId = episode.id;
    const now = this.clock();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.#upsertTemporalEpisode(episode);
      const subjectEntityId = this.#upsertTemporalEntity({ workspaceId: normalized.workspaceId, scope: normalized.scope, kind: 'subject', name: normalized.subject, now });
      const objectEntityId = this.#upsertTemporalEntity({ workspaceId: normalized.workspaceId, scope: normalized.scope, kind: 'object', name: normalized.object, now });
      this.database.prepare(`
        UPDATE memory_facts
        SET status = 'superseded',
            valid_until = ?,
            superseded_by = ?,
            updated_at = ?
        WHERE workspace_id = ?
          AND scope = ?
          AND subject = ?
          AND predicate = ?
          AND id <> ?
          AND object <> ?
          AND superseded_by IS NULL
          AND (valid_until IS NULL OR valid_until > ?)
      `).run(normalized.validFrom, normalized.id, now, normalized.workspaceId, normalized.scope, normalized.subject, normalized.predicate, normalized.id, normalized.object, normalized.validFrom);
      this.#writeTemporalFact(normalized);
      this.database.prepare(`
        INSERT INTO memory_edges (id, workspace_id, scope, source_entity_id, target_entity_id, predicate, fact_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, scope, fact_id) DO UPDATE SET
          source_entity_id=excluded.source_entity_id,
          target_entity_id=excluded.target_entity_id,
          predicate=excluded.predicate
      `).run(
        deterministicId('medge', { workspaceId: normalized.workspaceId, scope: normalized.scope, factId: normalized.id }),
        normalized.workspaceId,
        normalized.scope,
        subjectEntityId,
        objectEntityId,
        normalized.predicate,
        normalized.id,
        now
      );
      this.database.exec('COMMIT');
      return this.#temporalFactFromRow(this.database.prepare('SELECT * FROM memory_facts WHERE workspace_id = ? AND id = ?').get(normalized.workspaceId, normalized.id));
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  async getTemporalFacts({ workspaceId, scope = 'workspace', subject = null, predicate = null, at = this.clock(), query = '', limit = 20 } = {}) {
    if (!workspaceId) throw new Error('workspaceId is required');
    const normalizedScope = normalizeTemporalScope(scope);
    const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const conditions = [
      'm.workspace_id = ?',
      'm.scope = ?',
      "m.status IN ('active', 'superseded')",
      'm.valid_from <= ?',
      '(m.valid_until IS NULL OR m.valid_until > ?)'
    ];
    const parameters = [workspaceId, normalizedScope, at, at];
    if (subject) { conditions.push('m.subject = ?'); parameters.push(subject); }
    if (predicate) { conditions.push('m.predicate = ?'); parameters.push(predicate); }
    const expression = ftsExpression(query);
    let rows;
    if (expression) {
      rows = this.database.prepare(`
        SELECT m.*, bm25(memory_fact_fts) AS rank
        FROM memory_fact_fts
        JOIN memory_facts m ON m.id = memory_fact_fts.id AND m.workspace_id = memory_fact_fts.workspace_id
        WHERE memory_fact_fts MATCH ?
          AND ${conditions.join(' AND ')}
        ORDER BY rank ASC, m.valid_from DESC, m.id ASC
        LIMIT ?
      `).all(expression, ...parameters, boundedLimit);
    } else {
      rows = this.database.prepare(`
        SELECT m.*, 0 AS rank
        FROM memory_facts m
        WHERE ${conditions.join(' AND ')}
        ORDER BY m.valid_from DESC, m.id ASC
        LIMIT ?
      `).all(...parameters, boundedLimit);
    }
    return rows.map((row) => this.#temporalFactFromRow(row));
  }

  async getTemporalFactHistory({ workspaceId, scope = 'workspace', subject, predicate, limit = 50 } = {}) {
    if (!workspaceId) throw new Error('workspaceId is required');
    if (!subject || !predicate) throw new Error('subject and predicate are required');
    const normalizedScope = normalizeTemporalScope(scope);
    const boundedLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    return this.database.prepare(`
      SELECT *
      FROM memory_facts
      WHERE workspace_id = ?
        AND scope = ?
        AND subject = ?
        AND predicate = ?
      ORDER BY valid_from ASC, created_at ASC, id ASC
      LIMIT ?
    `).all(workspaceId, normalizedScope, subject, predicate, boundedLimit).map((row) => this.#temporalFactFromRow(row));
  }

  async listTemporalFacts({ workspaceId, scope = 'workspace', limit = 100 } = {}) {
    if (!workspaceId) throw new Error('workspaceId is required');
    const normalizedScope = normalizeTemporalScope(scope);
    const boundedLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    return this.database.prepare(`
      SELECT *
      FROM memory_facts
      WHERE workspace_id = ?
        AND scope = ?
      ORDER BY valid_from DESC, created_at DESC, id ASC
      LIMIT ?
    `).all(workspaceId, normalizedScope, boundedLimit).map((row) => this.#temporalFactFromRow(row));
  }

  #validTemporalFactRows({ workspaceId, scope, at }) {
    return this.database.prepare(`
      SELECT *
      FROM memory_facts
      WHERE workspace_id = ?
        AND scope = ?
        AND status IN ('active', 'superseded')
        AND valid_from <= ?
        AND (valid_until IS NULL OR valid_until > ?)
    `).all(workspaceId, scope, at, at);
  }

  #ftsTemporalMatches({ workspaceId, scope, query, at, limit }) {
    const expression = ftsExpression(query);
    if (!expression) return new Map();
    const rows = this.database.prepare(`
      SELECT m.id, bm25(memory_fact_fts) AS rank
      FROM memory_fact_fts
      JOIN memory_facts m ON m.id = memory_fact_fts.id AND m.workspace_id = memory_fact_fts.workspace_id
      WHERE memory_fact_fts MATCH ?
        AND m.workspace_id = ?
        AND m.scope = ?
        AND m.status IN ('active', 'superseded')
        AND m.valid_from <= ?
        AND (m.valid_until IS NULL OR m.valid_until > ?)
      ORDER BY rank ASC, m.valid_from DESC, m.id ASC
      LIMIT ?
    `).all(expression, workspaceId, scope, at, at, limit);
    return new Map(rows.map((row) => [row.id, 1 / (1 + Math.abs(Number(row.rank ?? 0)))]));
  }

  #relatedTemporalFactIds(rows, seedRows) {
    const subjects = new Set(seedRows.map((row) => row.subject));
    const objects = new Set(seedRows.map((row) => row.object));
    return new Set(rows
      .filter((row) => subjects.has(row.subject) || subjects.has(row.object) || objects.has(row.subject) || objects.has(row.object))
      .map((row) => row.id));
  }

  async searchTemporalMemory({ workspaceId, scope = 'workspace', query = '', at = this.clock(), limit = 10 } = {}) {
    if (!workspaceId) throw new Error('workspaceId is required');
    const normalizedScope = normalizeTemporalScope(scope);
    const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 10));
    const rows = this.#validTemporalFactRows({ workspaceId, scope: normalizedScope, at });
    const ftsScores = this.#ftsTemporalMatches({ workspaceId, scope: normalizedScope, query, at, limit: Math.max(boundedLimit, 25) });
    const seedRows = rows.filter((row) => ftsScores.has(row.id));
    const relatedIds = this.#relatedTemporalFactIds(rows, seedRows);
    const scored = rows
      .map((row) => {
        const fts5 = ftsScores.get(row.id) ?? 0;
        const graph = fts5 > 0 ? 0.2 : (relatedIds.has(row.id) ? 0.4 : 0);
        const temporal = temporalRank(row.valid_from, at);
        const score = fts5 * 0.7 + graph * 0.2 + temporal * 0.1;
        return { row, ranking: { score, signals: { fts5, graph, temporal, semantic: 0 } } };
      })
      .filter((item) => item.ranking.signals.fts5 > 0 || item.ranking.signals.graph > 0)
      .sort((left, right) => right.ranking.score - left.ranking.score || right.row.valid_from.localeCompare(left.row.valid_from) || left.row.id.localeCompare(right.row.id))
      .slice(0, boundedLimit);
    const results = scored.map((item) => ({ fact: this.#temporalFactFromRow(item.row), ranking: item.ranking }));
    const rawResultBytes = byteLength(results);
    const digestPayload = {
      query,
      at,
      resultIds: results.map((item) => item.fact.id),
      edges: results.map((item) => [item.fact.subject, item.fact.predicate, item.fact.object])
    };
    const serializedDigest = stableStringify(digestPayload);
    return {
      schemaVersion: '1.0.0',
      provider: PROVIDER_ID,
      workspaceId,
      scope: normalizedScope,
      generatedAt: this.clock(),
      query,
      results,
      signals: {
        fts5: { status: ftsScores.size ? 'used' : 'empty', matchCount: ftsScores.size },
        semantic: { status: 'skipped', reason: 'local_embedder_unavailable' },
        graph: { status: seedRows.length ? 'used' : 'empty', relatedFactCount: relatedIds.size },
        temporal: { status: 'used', at }
      },
      scopedDigest: {
        digest: `sha256:${sha256Hex(serializedDigest)}`,
        summary: digestPayload
      },
      measurements: {
        rawResultBytes,
        scopedDigestBytes: byteLength(serializedDigest)
      }
    };
  }

  async getTemporalMemoryPath({ workspaceId, scope = 'workspace', from, to } = {}) {
    if (!workspaceId) throw new Error('workspaceId is required');
    if (!from || !to) throw new Error('from and to are required');
    const normalizedScope = normalizeTemporalScope(scope);
    const rows = this.database.prepare(`
      SELECT e.predicate, e.fact_id, source.name AS source_name, target.name AS target_name
      FROM memory_edges e
      JOIN memory_entities source ON source.id = e.source_entity_id
      JOIN memory_entities target ON target.id = e.target_entity_id
      WHERE e.workspace_id = ?
        AND e.scope = ?
        AND source.name = ?
        AND target.name = ?
      ORDER BY e.created_at ASC, e.fact_id ASC
      LIMIT 10
    `).all(workspaceId, normalizedScope, from, to);
    return {
      schemaVersion: '1.0.0',
      provider: PROVIDER_ID,
      workspaceId,
      scope: normalizedScope,
      path: rows.length ? [{ name: from }, { name: to }] : [],
      edges: rows.map((row) => ({ from: row.source_name, predicate: row.predicate, to: row.target_name, factId: row.fact_id }))
    };
  }

  async explainTemporalMemory({ workspaceId, scope = 'workspace', query = '', factId, at = this.clock() } = {}) {
    if (!factId) throw new Error('factId is required');
    const report = await this.searchTemporalMemory({ workspaceId, scope, query, at, limit: 100 });
    const result = report.results.find((item) => item.fact.id === factId);
    if (!result) throw new Error(`temporal fact not found in search result: ${factId}`);
    return {
      schemaVersion: '1.0.0',
      provider: PROVIDER_ID,
      workspaceId: report.workspaceId,
      scope: report.scope,
      query,
      fact: result.fact,
      ranking: result.ranking,
      semantic: report.signals.semantic,
      scopedDigest: report.scopedDigest
    };
  }

  async proposeTemporalFactsFromEpisode(input) {
    const extracted = extractTemporalFactProposalsFromEpisode(input);
    const queued = [];
    for (const proposal of extracted.proposals) {
      queued.push(await this.enqueueProposal({
        id: proposal.id,
        workspaceId: proposal.workspaceId,
        sourceLocator: proposal.sourceLocator,
        sourceHash: proposal.sourceHash,
        payload: {
          kind: 'fact',
          scope: proposal.payload.scope,
          subject: proposal.payload.subject,
          predicate: proposal.payload.predicate,
          object: proposal.payload.object,
          text: proposal.payload.text,
          observedAt: proposal.payload.observedAt,
          subjectEntity: proposal.payload.subjectEntity,
          objectEntity: proposal.payload.objectEntity,
          entityLinksJson: stableStringify(proposal.payload.entityLinks),
          provenanceEpisodeId: proposal.payload.provenance.episodeId,
          provenanceSourceLocator: proposal.payload.provenance.sourceLocator,
          provenanceSourceHash: proposal.payload.provenance.sourceHash
        }
      }));
    }
    return queued;
  }

  async enqueueProposal(input) {
    assertPlainObject(input, 'memory proposal queue input');
    const workspaceId = input.workspaceId;
    if (!workspaceId) throw new Error('workspaceId is required');
    const payload = assertPlainObject(input.payload, 'memory proposal payload');
    const sourceLocator = assertWorkspaceLocator(input.sourceLocator, 'sourceLocator');
    const sourceHash = input.sourceHash ?? `sha256:${stableHash(payload)}`;
    if (!/^sha256:[a-f0-9]{64}$/.test(sourceHash)) throw new Error('sourceHash must be a sha256 hash');
    const fingerprint = input.fingerprint ?? queueFingerprint({ workspaceId, sourceLocator, sourceHash, payload });
    if (!FINGERPRINT_PATTERN.test(fingerprint)) throw new Error('fingerprint must be a 64 character hex string');
    const id = input.id ?? prefixedId('mpq');
    if (!QUEUE_ID_PATTERN.test(id)) throw new Error('queue id must be a safe mpq_ identifier');
    const now = this.clock();
    const values = {
      id,
      workspace_id: workspaceId,
      fingerprint,
      source_locator: sourceLocator,
      source_hash: sourceHash,
      status: 'pending',
      attempts: 0,
      max_attempts: Math.max(1, Math.min(10, Number(input.maxAttempts) || 3)),
      lease_owner: null,
      lease_until: null,
      payload_json: JSON.stringify(safeQueueObject(payload)),
      result_json: null,
      error_json: null,
      enqueued_at: input.enqueuedAt ?? now,
      updated_at: now
    };
    this.database.prepare(`
      INSERT INTO memory_proposal_queue (
        id, workspace_id, fingerprint, source_locator, source_hash, status,
        attempts, max_attempts, lease_owner, lease_until, payload_json,
        result_json, error_json, enqueued_at, updated_at
      ) VALUES (
        :id, :workspace_id, :fingerprint, :source_locator, :source_hash, :status,
        :attempts, :max_attempts, :lease_owner, :lease_until, :payload_json,
        :result_json, :error_json, :enqueued_at, :updated_at
      )
      ON CONFLICT(workspace_id, fingerprint) DO UPDATE SET
        updated_at=excluded.updated_at
    `).run(values);
    return rowToQueueRecord(this.database.prepare('SELECT * FROM memory_proposal_queue WHERE workspace_id = ? AND fingerprint = ?').get(workspaceId, fingerprint));
  }

  async claimProposal({ workspaceId, workerId = 'worker', leaseUntil, limit = 1 } = {}) {
    if (!workspaceId) throw new Error('workspaceId is required');
    const now = this.clock();
    const until = leaseUntil ?? new Date(Date.parse(now) + 60_000).toISOString();
    const boundedLimit = Math.max(1, Math.min(25, Number(limit) || 1));
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        UPDATE memory_proposal_queue
        SET status = 'poison',
            lease_owner = NULL,
            lease_until = NULL,
            error_json = ?,
            updated_at = ?
        WHERE workspace_id = ?
          AND status = 'claimed'
          AND lease_until IS NOT NULL
          AND lease_until <= ?
          AND attempts >= max_attempts
      `).run(boundedJson({ code: 'lease_expired_max_attempts', message: 'proposal lease expired after max attempts' }), now, workspaceId, now);
      const rows = this.database.prepare(`
        SELECT *
        FROM memory_proposal_queue
        WHERE workspace_id = ?
          AND attempts < max_attempts
          AND (
            status = 'pending'
            OR (status = 'claimed' AND lease_until IS NOT NULL AND lease_until <= ?)
          )
        ORDER BY enqueued_at ASC, id ASC
        LIMIT ?
      `).all(workspaceId, now, boundedLimit);
      for (const row of rows) {
        this.database.prepare(`
          UPDATE memory_proposal_queue
          SET status = 'claimed',
              attempts = attempts + 1,
              lease_owner = ?,
              lease_until = ?,
              updated_at = ?
          WHERE workspace_id = ? AND id = ?
        `).run(workerId, until, now, workspaceId, row.id);
      }
      this.database.exec('COMMIT');
      return rows.map((row) => rowToQueueRecord(this.database.prepare('SELECT * FROM memory_proposal_queue WHERE workspace_id = ? AND id = ?').get(workspaceId, row.id)));
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  async recordProposalResult({ workspaceId, id, workerId, status = 'applied', result = null, error = null, retry = false } = {}) {
    if (!workspaceId || !id) throw new Error('workspaceId and id are required');
    if (!workerId) throw new Error('workerId is required to record proposal results');
    if (!QUEUE_STATUSES.has(status)) throw new Error(`unsupported queue status: ${status}`);
    const current = rowToQueueRecord(this.database.prepare('SELECT * FROM memory_proposal_queue WHERE workspace_id = ? AND id = ?').get(workspaceId, id));
    if (!current) throw new Error(`memory proposal queue record not found: ${id}`);
    const now = this.clock();
    if (current.status !== 'claimed') throw new Error('proposal result requires a claimed queue record');
    if (current.leaseOwner !== workerId) throw new Error('proposal result worker does not own the lease');
    if (!current.leaseUntil || Date.parse(current.leaseUntil) <= Date.parse(now)) throw new Error('proposal lease expired');
    let nextStatus = status;
    if (error) nextStatus = status === 'poison' || !retry || current.attempts >= current.maxAttempts ? 'poison' : 'pending';
    const resultJson = result === null ? null : boundedJson(safeQueueObject(result));
    const errorJson = error === null ? null : boundedJson(safeQueueObject(error));
    this.database.prepare(`
      UPDATE memory_proposal_queue
      SET status = ?,
          lease_owner = NULL,
          lease_until = NULL,
          result_json = ?,
          error_json = ?,
          updated_at = ?
      WHERE workspace_id = ? AND id = ?
    `).run(nextStatus, resultJson, errorJson, now, workspaceId, id);
    return rowToQueueRecord(this.database.prepare('SELECT * FROM memory_proposal_queue WHERE workspace_id = ? AND id = ?').get(workspaceId, id));
  }

  async listProposalErrors({ workspaceId, limit = 20 } = {}) {
    if (!workspaceId) throw new Error('workspaceId is required');
    const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    return this.database.prepare(`
      SELECT *
      FROM memory_proposal_queue
      WHERE workspace_id = ?
        AND status = 'poison'
      ORDER BY updated_at DESC, id ASC
      LIMIT ?
    `).all(workspaceId, boundedLimit).map(rowToQueueRecord);
  }

  async listProposalQueue({ workspaceId, limit = 100 } = {}) {
    if (!workspaceId) throw new Error('workspaceId is required');
    const boundedLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    return this.database.prepare(`
      SELECT *
      FROM memory_proposal_queue
      WHERE workspace_id = ?
      ORDER BY enqueued_at DESC, id ASC
      LIMIT ?
    `).all(workspaceId, boundedLimit).map(rowToQueueRecord);
  }

  close() { this.database.close(); }
}

export { PROVIDER_ID as SQLITE_MEMORY_PROVIDER_ID };
