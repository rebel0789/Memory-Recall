import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { redactPostgresUrl } from './postgres-migrations.mjs';

const FIELD_SEPARATOR = '\x1f';

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite numeric SQL parameter');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `'${text.replaceAll("'", "''")}'`;
}

function bindParameters(text, values) {
  return text.replace(/\$(\d+)/g, (_, index) => {
    const offset = Number(index) - 1;
    if (offset < 0 || offset >= values.length) throw new Error(`missing SQL parameter $${index}`);
    return sqlLiteral(values[offset]);
  });
}

function normalizeSql(text) {
  return text.trim().replace(/\s+/g, ' ');
}

function parseJson(value, fallback = {}) {
  if (value === null || value === undefined || value === '') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function parseRows(sql, lines) {
  const normalized = normalizeSql(sql);
  const split = (line) => line.split(FIELD_SEPARATOR);

  if (normalized.startsWith("SELECT to_regclass('public.") && normalized.includes(' AS table_name')) {
    return lines.length ? [{ table_name: lines[0] || null }] : [{ table_name: null }];
  }
  if (normalized.startsWith('SELECT count(*)::int AS count')) {
    return lines.map((line) => ({ count: Number(line) }));
  }
  if (normalized.startsWith('SELECT version, name, checksum, applied_at, duration_ms FROM oaf_schema_migrations') ||
      normalized.startsWith('INSERT INTO oaf_schema_migrations')) {
    return lines.map((line) => {
      const [version, name, checksum, appliedAt, durationMs] = split(line);
      return { version: Number(version), name, checksum, applied_at: appliedAt, duration_ms: Number(durationMs) };
    });
  }
  if (normalized.startsWith('SELECT pg_advisory_unlock')) {
    return lines.map((line) => ({ released: line === 't' || line === 'true' }));
  }
  if (normalized.startsWith('SELECT id FROM runs WHERE workspace_id')) {
    return lines.map((line) => ({ id: line }));
  }
  if (normalized.startsWith('INSERT INTO workspaces') || normalized.startsWith('SELECT id, name, created_at, policy FROM workspaces')) {
    return lines.map((line) => {
      const [id, name, createdAt, policy] = split(line);
      return { id, name, created_at: createdAt, policy: parseJson(policy) };
    });
  }
  if (normalized.startsWith('INSERT INTO workflow_versions') || normalized.startsWith('SELECT id, workspace_id, workflow_key, version, definition, created_at FROM workflow_versions')) {
    return lines.map((line) => {
      const [id, workspaceId, workflowKey, version, definition, createdAt] = split(line);
      return { id, workspace_id: workspaceId, workflow_key: workflowKey, version, definition: parseJson(definition), created_at: createdAt };
    });
  }
  if (normalized.startsWith('INSERT INTO runs') || normalized.startsWith('SELECT id, workspace_id, workflow_version_id, status, objective, created_at, completed_at, metadata FROM runs') || normalized.startsWith('UPDATE runs')) {
    return lines.map((line) => {
      const [id, workspaceId, workflowVersionId, status, objective, createdAt, completedAt, metadata] = split(line);
      return { id, workspace_id: workspaceId, workflow_version_id: workflowVersionId, status, objective: objective || null, created_at: createdAt, completed_at: completedAt || null, metadata: parseJson(metadata) };
    });
  }
  if (normalized.startsWith('INSERT INTO events') || normalized.startsWith('SELECT id, workspace_id, run_id, sequence, schema_version, type, actor_id')) {
    return lines.map((line) => {
      const [id, workspaceId, runId, sequence, schemaVersion, type, actorId, occurredAt, correlationId, causationId, dataClass, producerVersion, payload] = split(line);
      return {
        id,
        workspace_id: workspaceId,
        run_id: runId,
        sequence: Number(sequence),
        schema_version: schemaVersion,
        type,
        actor_id: actorId,
        occurred_at: occurredAt,
        correlation_id: correlationId,
        causation_id: causationId || null,
        data_class: dataClass,
        producer_version: producerVersion,
        payload: parseJson(payload)
      };
    });
  }
  if (normalized.startsWith('INSERT INTO context_manifests') || normalized.startsWith('SELECT id, workspace_id, run_id, compiler_version')) {
    return lines.map((line) => {
      const [id, workspaceId, runId, compilerVersion, request, manifest, createdAt] = split(line);
      return { id, workspace_id: workspaceId, run_id: runId || null, compiler_version: compilerVersion, request: parseJson(request), manifest: parseJson(manifest), created_at: createdAt };
    });
  }
  return [];
}

export class PsqlSessionClient {
  constructor({ connectionUrl, psqlBin = 'psql' } = {}) {
    if (!connectionUrl) throw new TypeError('connectionUrl is required');
    this.connectionUrl = connectionUrl;
    this.process = spawn(psqlBin, [
      '--no-psqlrc',
      '--quiet',
      '--no-align',
      '--tuples-only',
      '--field-separator', FIELD_SEPARATOR,
      '--set', 'ON_ERROR_STOP=1',
      '--dbname', connectionUrl
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.buffer = '';
    this.stderr = '';
    this.pending = null;
    this.queue = Promise.resolve();
    this.closed = false;
    this.process.stdout.setEncoding('utf8');
    this.process.stderr.setEncoding('utf8');
    this.process.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      this.#drain();
    });
    this.process.stderr.on('data', (chunk) => {
      this.stderr += chunk;
    });
    this.process.on('close', (code) => {
      this.closed = true;
      if (this.pending) {
        const pending = this.pending;
        this.pending = null;
        pending.reject(new Error(redactPostgresUrl(this.stderr || `psql exited with code ${code}`)));
      }
    });
  }

  async query(text, values = []) {
    this.queue = this.queue.then(() => this.#query(text, values));
    return this.queue;
  }

  #query(text, values) {
    if (this.closed) return Promise.reject(new Error('psql session is closed'));
    const sql = bindParameters(text, values);
    const statement = sql.trim().endsWith(';') ? sql.trim() : `${sql.trim()};`;
    const id = randomUUID().replaceAll('-', '');
    const begin = `__OAF_BEGIN_${id}__`;
    const end = `__OAF_END_${id}__`;
    this.stderr = '';
    return new Promise((resolve, reject) => {
      this.pending = { begin, end, sql: text, resolve, reject };
      this.process.stdin.write(`\\echo ${begin}\n${statement}\n\\echo ${end}\n`);
    });
  }

  #drain() {
    if (!this.pending) return;
    const { begin, end, sql, resolve } = this.pending;
    const start = this.buffer.indexOf(begin);
    const finish = this.buffer.indexOf(end, start + begin.length);
    if (start === -1 || finish === -1) return;
    const body = this.buffer.slice(start + begin.length, finish);
    this.buffer = this.buffer.slice(finish + end.length);
    this.pending = null;
    const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    resolve({ rows: parseRows(sql, lines) });
  }

  release() {
    if (this.closed) return;
    this.process.stdin.write('\\q\n');
    this.process.stdin.end();
  }
}

export class PsqlSessionPool {
  constructor({ connectionUrl, psqlBin = 'psql' } = {}) {
    this.connectionUrl = connectionUrl;
    this.psqlBin = psqlBin;
  }

  async connect() {
    return new PsqlSessionClient({ connectionUrl: this.connectionUrl, psqlBin: this.psqlBin });
  }
}
