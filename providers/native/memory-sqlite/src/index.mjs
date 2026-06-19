import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { prefixedId, nowIso, assertPlainObject } from '../../../../packages/protocol/src/index.mjs';

const PROVIDER_ID = 'provider:native:memory:sqlite';
const STATUSES = new Set(['observed', 'proposed', 'verified', 'active', 'superseded', 'retracted', 'expired', 'quarantined']);
const SCOPES = new Set(['public', 'workspace-private', 'user-private', 'restricted']);

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
  if (Buffer.byteLength(input.text, 'utf8') > 1_000_000) throw new Error('memory text exceeds 1 MB');
  const status = input.status ?? 'active';
  const scope = input.scope ?? 'workspace-private';
  if (!STATUSES.has(status)) throw new Error(`unsupported memory status: ${status}`);
  if (!SCOPES.has(scope)) throw new Error(`unsupported memory scope: ${scope}`);
  const timestamp = input.updatedAt ?? input.createdAt ?? clock();
  const record = {
    schemaVersion: '1.0.0',
    id: input.id ?? prefixedId('mem'),
    workspaceId: input.workspaceId,
    kind: input.kind,
    text: input.text,
    scope,
    status,
    source: input.source,
    confidence: clamp(input.confidence),
    authority: clamp(input.authority),
    tags: Array.isArray(input.tags) ? [...new Set(input.tags.map(String))] : [],
    relations: Array.isArray(input.relations) ? [...new Set(input.relations.map(String))] : [],
    observedAt: input.observedAt ?? timestamp,
    validFrom: input.validFrom ?? null,
    validTo: input.validTo ?? null,
    supersedes: input.supersedes ?? null,
    retention: input.retention ?? 'workspace-default',
    createdAt: input.createdAt ?? timestamp,
    updatedAt: timestamp,
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
    confidence: row.confidence,
    authority: row.authority,
    tags: parseJson(row.tags_json, []),
    relations: parseJson(row.relations_json, []),
    observedAt: row.observed_at,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    supersedes: row.supersedes,
    retention: row.retention,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    contentHash: row.content_hash,
    metadata: parseJson(row.metadata_json, {})
  };
}

export class SQLiteMemoryProvider {
  constructor({ filename = ':memory:', clock = nowIso } = {}) {
    this.filename = filename;
    this.clock = clock;
    if (filename !== ':memory:') mkdirSync(path.dirname(path.resolve(filename)), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(filename);
    this.#migrate();
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
        confidence REAL NOT NULL,
        authority REAL NOT NULL,
        tags_json TEXT NOT NULL,
        relations_json TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        valid_from TEXT,
        valid_to TEXT,
        supersedes TEXT,
        retention TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_workspace_status ON memory_records(workspace_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_supersedes ON memory_records(workspace_id, supersedes);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        id UNINDEXED,
        workspace_id UNINDEXED,
        kind,
        text,
        tags,
        tokenize='unicode61 remove_diacritics 2'
      );
    `);
  }

  async health() {
    const row = this.database.prepare('PRAGMA integrity_check').get();
    return { status: row.integrity_check === 'ok' ? 'healthy' : 'degraded', local: true, details: { provider: PROVIDER_ID, storage: this.filename === ':memory:' ? 'memory' : 'sqlite-file', integrity: row.integrity_check } };
  }

  async capabilities() {
    return ['memory.put', 'memory.get', 'memory.search.lexical', 'memory.supersede', 'memory.forget', 'memory.export'];
  }

  async put(input) {
    const record = normalizeRecord(input, this.clock);
    const values = {
      id: record.id,
      workspace_id: record.workspaceId,
      kind: record.kind,
      text: record.text,
      scope: record.scope,
      status: record.status,
      source: record.source,
      confidence: record.confidence,
      authority: record.authority,
      tags_json: JSON.stringify(record.tags),
      relations_json: JSON.stringify(record.relations),
      observed_at: record.observedAt,
      valid_from: record.validFrom,
      valid_to: record.validTo,
      supersedes: record.supersedes,
      retention: record.retention,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
      content_hash: record.contentHash,
      metadata_json: JSON.stringify(record.metadata)
    };
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        INSERT INTO memory_records (
          id, workspace_id, kind, text, scope, status, source, confidence, authority,
          tags_json, relations_json, observed_at, valid_from, valid_to, supersedes,
          retention, created_at, updated_at, content_hash, metadata_json
        ) VALUES (
          :id, :workspace_id, :kind, :text, :scope, :status, :source, :confidence, :authority,
          :tags_json, :relations_json, :observed_at, :valid_from, :valid_to, :supersedes,
          :retention, :created_at, :updated_at, :content_hash, :metadata_json
        )
        ON CONFLICT(id) DO UPDATE SET
          workspace_id=excluded.workspace_id, kind=excluded.kind, text=excluded.text,
          scope=excluded.scope, status=excluded.status, source=excluded.source,
          confidence=excluded.confidence, authority=excluded.authority,
          tags_json=excluded.tags_json, relations_json=excluded.relations_json,
          observed_at=excluded.observed_at, valid_from=excluded.valid_from,
          valid_to=excluded.valid_to, supersedes=excluded.supersedes,
          retention=excluded.retention, updated_at=excluded.updated_at,
          content_hash=excluded.content_hash, metadata_json=excluded.metadata_json
      `).run(values);
      this.database.prepare('DELETE FROM memory_fts WHERE id = ?').run(record.id);
      this.database.prepare('INSERT INTO memory_fts(id, workspace_id, kind, text, tags) VALUES (?, ?, ?, ?, ?)')
        .run(record.id, record.workspaceId, record.kind, record.text, record.tags.join(' '));
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
        JOIN memory_records m ON m.id = memory_fts.id
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
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    try {
      return await this.put(next);
    } catch (error) {
      this.database.prepare('UPDATE memory_records SET status = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
        .run(previous.status, this.clock(), workspaceId, previousId);
      throw error;
    }
  }

  async forget({ workspaceId, id }) {
    if (!workspaceId || !id) throw new Error('workspaceId and id are required');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.database.prepare('SELECT id FROM memory_records WHERE workspace_id = ? AND id = ?').get(workspaceId, id);
      if (!existing) { this.database.exec('ROLLBACK'); return false; }
      this.database.prepare('DELETE FROM memory_fts WHERE id = ?').run(id);
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

  close() { this.database.close(); }
}

export { PROVIDER_ID as SQLITE_MEMORY_PROVIDER_ID };
