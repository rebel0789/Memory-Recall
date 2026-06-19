import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export const MIGRATION_LEDGER_TABLE = 'oaf_schema_migrations';
export const MIGRATION_LOCK_KEY = 649202005;

const MIGRATION_FILENAME = /^(\d{3})_([a-z][a-z0-9_]*?)\.sql$/;

function migrationError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function assertDirectory(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('migration directory is required');
  if (!path.isAbsolute(value)) return path.resolve(value);
  return path.resolve(value);
}

function checksumSql(sql) {
  return createHash('sha256').update(sql).digest('hex');
}

function normalizeRow(row) {
  return {
    version: Number(row.version),
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at instanceof Date ? row.applied_at.toISOString() : row.applied_at,
    durationMs: Number(row.duration_ms)
  };
}

export function redactPostgresUrl(value) {
  return String(value ?? '').replace(/(postgres(?:ql)?:\/\/[^:\s/@]+:)([^@\s]+)(@)/gi, '$1[REDACTED]$3');
}

function sanitizeMessage(error) {
  return redactPostgresUrl(error?.message ?? String(error));
}

export async function discoverMigrations({ directory }) {
  const root = assertDirectory(directory);
  const info = await stat(root).catch((error) => {
    throw migrationError('migration_directory_unreadable', `migration directory is unreadable: ${root}`, { cause: error.message });
  });
  if (!info.isDirectory()) throw migrationError('migration_directory_invalid', `migration path is not a directory: ${root}`);

  const realRoot = await realpath(root);
  const entries = await readdir(root, { withFileTypes: true });
  const migrations = [];
  const seenVersions = new Map();

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const match = MIGRATION_FILENAME.exec(entry.name);
    if (!match) throw migrationError('invalid_migration_filename', `invalid migration filename: ${entry.name}`, { filename: entry.name });
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      throw migrationError('invalid_migration_entry', `migration entry must be a file: ${entry.name}`, { filename: entry.name });
    }

    const version = Number(match[1]);
    if (seenVersions.has(version)) {
      throw migrationError('duplicate_migration_version', `duplicate migration version: ${match[1]}`, { version, files: [seenVersions.get(version), entry.name] });
    }
    seenVersions.set(version, entry.name);

    const candidate = path.join(root, entry.name);
    const linkInfo = await lstat(candidate);
    if (linkInfo.isSymbolicLink()) {
      const realCandidate = await realpath(candidate);
      const relative = path.relative(realRoot, realCandidate);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw migrationError('migration_symlink_outside_directory', `migration symlink resolves outside directory: ${entry.name}`, { filename: entry.name });
      }
    }

    const sql = await readFile(candidate, 'utf8');
    migrations.push({
      version,
      versionLabel: match[1],
      name: match[2],
      filename: entry.name,
      path: candidate,
      checksum: checksumSql(sql),
      sql
    });
  }

  migrations.sort((a, b) => a.version - b.version);
  return migrations;
}

function appliedByVersion(appliedMigrations = []) {
  return new Map(appliedMigrations.map((row) => [Number(row.version), row]));
}

export function planMigrations({ migrations, appliedMigrations = [] }) {
  const applied = appliedByVersion(appliedMigrations);
  return migrations.map((migration) => {
    const ledger = applied.get(migration.version);
    if (!ledger) return { ...migration, state: 'pending' };
    if (ledger.checksum !== migration.checksum) {
      return {
        ...migration,
        state: 'checksum_mismatch',
        appliedChecksum: ledger.checksum,
        currentChecksum: migration.checksum,
        appliedAt: ledger.appliedAt ?? ledger.applied_at ?? null
      };
    }
    return {
      ...migration,
      state: 'applied',
      appliedAt: ledger.appliedAt ?? ledger.applied_at ?? null,
      durationMs: Number(ledger.durationMs ?? ledger.duration_ms ?? 0)
    };
  });
}

async function ledgerExists(client) {
  const result = await client.query(`SELECT to_regclass('public.${MIGRATION_LEDGER_TABLE}') AS table_name`);
  return Boolean(result.rows[0]?.table_name);
}

async function ensureLedger(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATION_LEDGER_TABLE} (
      version integer PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      duration_ms bigint NOT NULL
    )
  `);
}

async function readLedger(client, { createIfMissing = false } = {}) {
  if (createIfMissing) await ensureLedger(client);
  else if (!await ledgerExists(client)) return [];
  const result = await client.query(`
    SELECT version, name, checksum, applied_at, duration_ms
    FROM ${MIGRATION_LEDGER_TABLE}
    ORDER BY version ASC
  `);
  return result.rows.map(normalizeRow);
}

export async function getMigrationStatus({ client, directory }) {
  if (!client || typeof client.query !== 'function') throw new TypeError('client with query(text, values) is required');
  const migrations = await discoverMigrations({ directory });
  const appliedMigrations = await readLedger(client, { createIfMissing: false });
  const plan = planMigrations({ migrations, appliedMigrations });
  return {
    ok: !plan.some((item) => item.state === 'checksum_mismatch'),
    ledgerTable: MIGRATION_LEDGER_TABLE,
    migrations,
    appliedMigrations,
    plan
  };
}

async function acquireConnection({ pool, clientFactory, client }) {
  if (clientFactory) return clientFactory();
  if (pool?.connect) return pool.connect();
  if (client?.query) return client;
  throw new TypeError('pool, clientFactory, or client is required');
}

async function releaseConnection(connection, rootClient) {
  if (connection !== rootClient && typeof connection.release === 'function') connection.release();
  else if (typeof connection.release === 'function') connection.release();
}

async function withSessionLock(client, work) {
  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    locked = true;
    return await work();
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1) AS released', [MIGRATION_LOCK_KEY]).catch(() => null);
  }
}

function structuredFailure(code, message, details = {}) {
  return { ok: false, error: { code, message: redactPostgresUrl(message), ...details } };
}

export async function applyMigrations({ pool = null, clientFactory = null, client = null, directory }) {
  const connection = await acquireConnection({ pool, clientFactory, client });
  const applied = [];
  try {
    const result = await withSessionLock(connection, async () => {
      await ensureLedger(connection);
      const migrations = await discoverMigrations({ directory });
      const appliedMigrations = await readLedger(connection, { createIfMissing: false });
      const plan = planMigrations({ migrations, appliedMigrations });
      const mismatch = plan.find((item) => item.state === 'checksum_mismatch');
      if (mismatch) {
        return structuredFailure('checksum_mismatch', `applied migration checksum differs from file: ${mismatch.filename}`, {
          version: mismatch.version,
          name: mismatch.name,
          appliedChecksum: mismatch.appliedChecksum,
          currentChecksum: mismatch.currentChecksum,
          plan
        });
      }

      for (const migration of plan.filter((item) => item.state === 'pending')) {
        const started = performance.now();
        try {
          await connection.query('BEGIN');
          await connection.query(migration.sql);
          const durationMs = Math.max(0, Math.round(performance.now() - started));
          const ledger = await connection.query(
            `
              INSERT INTO ${MIGRATION_LEDGER_TABLE} (version, name, checksum, duration_ms)
              VALUES ($1, $2, $3, $4)
              RETURNING version, name, checksum, applied_at, duration_ms
            `,
            [migration.version, migration.name, migration.checksum, durationMs]
          );
          await connection.query('COMMIT');
          applied.push(normalizeRow(ledger.rows[0]));
        } catch (error) {
          await connection.query('ROLLBACK').catch(() => null);
          return structuredFailure('migration_failed', sanitizeMessage(error), {
            version: migration.version,
            name: migration.name,
            applied,
            plan
          });
        }
      }

      return { ok: true, applied, plan };
    });
    return result;
  } finally {
    await releaseConnection(connection, client);
  }
}
