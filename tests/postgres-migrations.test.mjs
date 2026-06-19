import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  applyMigrations,
  discoverMigrations,
  getMigrationStatus,
  planMigrations,
  redactPostgresUrl
} from '../packages/storage/src/postgres-migrations.mjs';

async function tempDir(prefix = 'oaf migrations ') {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeMigration(directory, filename, sql = 'SELECT 1;') {
  const file = path.join(directory, filename);
  await writeFile(file, `${sql}\n`);
  return file;
}

class MemoryMigrationClient {
  constructor({ applied = [], failOnSql = null } = {}) {
    this.calls = [];
    this.applied = applied.map((row) => ({ ...row }));
    this.failOnSql = failOnSql;
    this.ledgerCreated = applied.length > 0;
    this.locked = false;
    this.released = false;
    this.migrationSql = [];
  }

  async query(text, values = []) {
    const sql = text.trim().replace(/\s+/g, ' ');
    this.calls.push({ sql, values });
    if (sql === 'CREATE TABLE IF NOT EXISTS oaf_schema_migrations ( version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), duration_ms bigint NOT NULL )') {
      this.ledgerCreated = true;
      return { rows: [] };
    }
    if (sql === "SELECT to_regclass('public.oaf_schema_migrations') AS table_name") {
      return { rows: [{ table_name: this.ledgerCreated ? 'oaf_schema_migrations' : null }] };
    }
    if (sql.startsWith('SELECT version, name, checksum, applied_at, duration_ms FROM oaf_schema_migrations')) {
      return { rows: [...this.applied].sort((a, b) => a.version - b.version) };
    }
    if (sql === 'SELECT pg_advisory_lock($1)') {
      this.locked = true;
      return { rows: [] };
    }
    if (sql === 'SELECT pg_advisory_unlock($1) AS released') {
      this.locked = false;
      return { rows: [{ released: true }] };
    }
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.startsWith('INSERT INTO oaf_schema_migrations')) {
      const [version, name, checksum, durationMs] = values;
      const row = { version, name, checksum, applied_at: '2026-06-19T00:00:00.000Z', duration_ms: durationMs };
      this.applied.push(row);
      return { rows: [row] };
    }
    this.migrationSql.push(sql);
    if (this.failOnSql && sql.includes(this.failOnSql)) throw new Error(`boom postgres://user:secret-password@db.example/oaf`);
    return { rows: [] };
  }

  release() {
    this.released = true;
  }
}

class MemoryMigrationPool {
  constructor(client) {
    this.client = client;
    this.connectCount = 0;
  }

  async connect() {
    this.connectCount += 1;
    return this.client;
  }

  async query() {
    throw new Error('pool.query must not be used for migration sessions');
  }
}

test('discovers migrations in numeric order from paths containing spaces', async (t) => {
  const directory = await tempDir();
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeMigration(directory, '010_later.sql');
  await writeMigration(directory, '001_init.sql');
  await writeMigration(directory, '002_second.sql');
  await writeFile(path.join(directory, '.DS_Store'), 'ignored');

  const migrations = await discoverMigrations({ directory });

  assert.deepEqual(migrations.map((migration) => migration.version), [1, 2, 10]);
  assert.deepEqual(migrations.map((migration) => migration.name), ['init', 'second', 'later']);
  assert.ok(migrations.every((migration) => migration.checksum.length === 64));
});

test('rejects malformed migration filenames and duplicate versions', async (t) => {
  const malformed = await tempDir('oaf bad migrations ');
  t.after(() => rm(malformed, { recursive: true, force: true }));
  await writeMigration(malformed, '1_bad.sql');
  await assert.rejects(discoverMigrations({ directory: malformed }), (error) => error.code === 'invalid_migration_filename');

  const duplicate = await tempDir('oaf duplicate migrations ');
  t.after(() => rm(duplicate, { recursive: true, force: true }));
  await writeMigration(duplicate, '001_init.sql');
  await writeMigration(duplicate, '001_again.sql');
  await assert.rejects(discoverMigrations({ directory: duplicate }), (error) => error.code === 'duplicate_migration_version');
});

test('rejects symlinks that resolve outside the migration directory', async (t) => {
  const directory = await tempDir('oaf symlink migrations ');
  const outside = await tempDir('oaf outside migrations ');
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const target = await writeMigration(outside, '001_outside.sql');
  await symlink(target, path.join(directory, '001_outside.sql'));

  await assert.rejects(discoverMigrations({ directory }), (error) => error.code === 'migration_symlink_outside_directory');
});

test('plans pending, applied, and checksum mismatch states without mutating status reads', async (t) => {
  const directory = await tempDir('oaf plan migrations ');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeMigration(directory, '001_init.sql', 'SELECT 1;');
  await writeMigration(directory, '002_next.sql', 'SELECT 2;');
  const [first, second] = await discoverMigrations({ directory });

  const plan = planMigrations({ migrations: [first, second], appliedMigrations: [{ version: 1, name: 'init', checksum: first.checksum }] });
  assert.deepEqual(plan.map((item) => item.state), ['applied', 'pending']);

  const changed = planMigrations({ migrations: [first, second], appliedMigrations: [{ version: 1, name: 'init', checksum: '0'.repeat(64) }] });
  assert.deepEqual(changed.map((item) => item.state), ['checksum_mismatch', 'pending']);

  const client = new MemoryMigrationClient();
  const status = await getMigrationStatus({ client, directory });
  assert.deepEqual(status.plan.map((item) => item.state), ['pending', 'pending']);
  assert.equal(client.ledgerCreated, false);
});

test('applies migrations transactionally with ledger records and idempotent second run', async (t) => {
  const directory = await tempDir('oaf apply migrations ');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeMigration(directory, '002_second.sql', 'CREATE TABLE second(id text);');
  await writeMigration(directory, '001_init.sql', 'CREATE TABLE first(id text);');
  const client = new MemoryMigrationClient();
  const pool = new MemoryMigrationPool(client);

  const firstRun = await applyMigrations({ pool, directory });

  assert.equal(firstRun.ok, true);
  assert.deepEqual(firstRun.applied.map((item) => item.version), [1, 2]);
  assert.deepEqual(client.applied.map((item) => item.version), [1, 2]);
  assert.equal(pool.connectCount, 1);
  assert.equal(client.released, true);
  assert.equal(client.locked, false);
  assert.ok(client.calls.some((call) => call.sql === 'SELECT pg_advisory_lock($1)'));
  assert.ok(client.calls.some((call) => call.sql === 'SELECT pg_advisory_unlock($1) AS released'));

  client.released = false;
  const secondRun = await applyMigrations({ pool, directory });
  assert.equal(secondRun.ok, true);
  assert.deepEqual(secondRun.applied, []);
  assert.equal(client.applied.length, 2);
  assert.equal(client.released, true);
});

test('fails closed when an applied migration checksum changes', async (t) => {
  const directory = await tempDir('oaf tamper migrations ');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeMigration(directory, '001_init.sql', 'SELECT 1;');
  const [migration] = await discoverMigrations({ directory });
  const client = new MemoryMigrationClient({ applied: [{ version: 1, name: 'init', checksum: migration.checksum }] });
  await writeMigration(directory, '001_init.sql', 'SELECT 99;');

  const result = await applyMigrations({ pool: new MemoryMigrationPool(client), directory });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'checksum_mismatch');
  assert.equal(client.migrationSql.length, 0);
  assert.equal(client.applied.length, 1);
  assert.equal(client.locked, false);
  assert.equal(client.released, true);
});

test('rolls back failed migration, records no success, stops later migrations, and releases resources', async (t) => {
  const directory = await tempDir('oaf rollback migrations ');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeMigration(directory, '001_init.sql', 'CREATE TABLE first(id text);');
  await writeMigration(directory, '002_bad.sql', 'CREATE TABLE bad(id text); SELECT fail_here;');
  await writeMigration(directory, '003_later.sql', 'CREATE TABLE later(id text);');
  const client = new MemoryMigrationClient({ failOnSql: 'fail_here' });

  const result = await applyMigrations({ pool: new MemoryMigrationPool(client), directory });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'migration_failed');
  assert.equal(result.error.version, 2);
  assert.equal(result.error.name, 'bad');
  assert.match(result.error.message, /postgres:\/\/user:\[REDACTED\]@db\.example\/oaf/);
  assert.deepEqual(client.applied.map((item) => item.version), [1]);
  assert.equal(client.migrationSql.some((sql) => sql.includes('later')), false);
  assert.ok(client.calls.some((call) => call.sql === 'ROLLBACK'));
  assert.equal(client.locked, false);
  assert.equal(client.released, true);
});

test('redacts credentials and keeps external adapters disabled', async () => {
  assert.equal(redactPostgresUrl('postgres://alice:s3cret@example.com:5432/oaf'), 'postgres://alice:[REDACTED]@example.com:5432/oaf');
  assert.equal(redactPostgresUrl('not a url with postgres://user:pass@host/db inside'), 'not a url with postgres://user:[REDACTED]@host/db inside');

  const catalog = JSON.parse(await readFile(new URL('../adapters/catalog.json', import.meta.url), 'utf8'));
  for (const adapter of catalog.adapters) assert.equal(adapter.enabledByDefault, false);
});
