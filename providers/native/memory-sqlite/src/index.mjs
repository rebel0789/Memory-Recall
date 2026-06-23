import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { prefixedId, nowIso, assertPlainObject } from '../../../../packages/protocol/src/index.mjs';

const PROVIDER_ID = 'provider:native:memory:sqlite';
const STATUSES = new Set(['observed', 'proposed', 'verified', 'active', 'rejected', 'superseded', 'retracted', 'expired', 'quarantined']);
const SCOPES = new Set(['public', 'workspace-private', 'user-private', 'restricted']);
const DATA_CLASSES = new Set(['public', 'workspace-private', 'sensitive', 'secret']);
const DECISIONS = new Set(['propose', 'review', 'allow', 'reject']);
const QUEUE_STATUSES = new Set(['pending', 'claimed', 'applied', 'poison']);
const MEMORY_KINDS = new Set(['fact', 'preference', 'decision', 'episode', 'procedure', 'constraint']);
const QUEUE_ID_PATTERN = /^mpq_[A-Za-z0-9._-]{1,128}$/;
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
    return ['memory.put', 'memory.get', 'memory.search.lexical', 'memory.supersede', 'memory.forget', 'memory.export', 'memory.filesystemReports', 'memory.proposalQueue'];
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

  close() { this.database.close(); }
}

export { PROVIDER_ID as SQLITE_MEMORY_PROVIDER_ID };
