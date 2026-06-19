import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { applyMigrations, redactPostgresUrl } from '../packages/storage/src/postgres-migrations.mjs';
import { PsqlSessionClient, PsqlSessionPool } from '../packages/storage/src/psql-session-client.mjs';
import {
  PostgresEventRepository,
  PostgresRunRepository,
  PostgresWorkspaceRepository,
  PostgresWorkflowVersionRepository
} from '../packages/storage/src/postgres-repositories.mjs';
import { createEvent } from '../packages/protocol/src/index.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const migrationDirectory = path.join(root, 'deploy/postgres/migrations');
const url = process.env.OAF_POSTGRES_TEST_URL;

function log(result) {
  console.log(JSON.stringify(result, null, 2));
}

async function queryOne(client, sql) {
  return (await client.query(sql)).rows[0] ?? {};
}

async function withClient(work) {
  const client = new PsqlSessionClient({ connectionUrl: url });
  try {
    return await work(client);
  } finally {
    client.release();
  }
}

async function cleanup() {
  await withClient((client) => client.query(`
    DROP TABLE IF EXISTS
      evaluations,
      approvals,
      artifacts,
      context_manifests,
      record_edges,
      records,
      events,
      runs,
      workflow_versions,
      security_audit_events,
      identity_api_tokens,
      identity_sessions,
      identity_workspace_memberships,
      identity_users,
      workspaces,
      oaf_temp_failure,
      oaf_temp_recovered,
      oaf_concurrent,
      oaf_schema_migrations
    CASCADE
  `));
}

if (!url) {
  log({ result: 'skipped', reason: 'OAF_POSTGRES_TEST_URL is not set' });
  process.exit(0);
}

if (process.env.OAF_POSTGRES_TEST_RESET !== 'true') {
  console.error('OAF_POSTGRES_TEST_RESET=true is required because this test resets OAF-owned tables in the supplied database.');
  process.exit(2);
}

try {
  await withClient(async (client) => {
    const vector = await queryOne(client, "SELECT count(*)::int AS count FROM pg_available_extensions WHERE name = 'vector'");
    assert.equal(vector.count, 1, 'test database must provide the pgvector extension');
  });

  const pool = new PsqlSessionPool({ connectionUrl: url });
  await cleanup();

  const first = await applyMigrations({ pool, directory: migrationDirectory });
  assert.equal(first.ok, true);
  assert.deepEqual(first.applied.map((item) => item.version), [1, 2]);

  const second = await applyMigrations({ pool, directory: migrationDirectory });
  assert.equal(second.ok, true);
  assert.deepEqual(second.applied, []);

  const recoveryDir = await mkdtemp(path.join(os.tmpdir(), 'oaf recovery migrations '));
  try {
    const initSql = await readFile(path.join(migrationDirectory, '001_init.sql'), 'utf8');
    await writeFile(path.join(recoveryDir, '001_init.sql'), initSql);
    await writeFile(path.join(recoveryDir, '003_failure.sql'), 'CREATE TABLE oaf_temp_failure(id text PRIMARY KEY);\nSELECT oaf_missing_function();\n');
    const failed = await applyMigrations({ pool, directory: recoveryDir });
    assert.equal(failed.ok, false);
    assert.equal(failed.error.version, 3);

    await withClient(async (client) => {
      assert.equal((await queryOne(client, "SELECT to_regclass('public.oaf_temp_failure') AS table_name")).table_name, null);
      assert.equal((await queryOne(client, 'SELECT count(*)::int AS count FROM oaf_schema_migrations WHERE version = 3')).count, 0);
    });

    await writeFile(path.join(recoveryDir, '003_failure.sql'), 'CREATE TABLE oaf_temp_recovered(id text PRIMARY KEY);\n');
    const recovered = await applyMigrations({ pool, directory: recoveryDir });
    assert.equal(recovered.ok, true);
    assert.deepEqual(recovered.applied.map((item) => item.version), [3]);
  } finally {
    await rm(recoveryDir, { recursive: true, force: true });
  }

  await withClient(async (client) => {
    const workspaces = new PostgresWorkspaceRepository({ client });
    const workflows = new PostgresWorkflowVersionRepository({ client });
    const runs = new PostgresRunRepository({ client });
    const events = new PostgresEventRepository({ client });
    await workspaces.put({ id: 'ws_recovery', name: 'Recovery Test' });
    await workflows.put({ id: 'wfv_recovery', workspaceId: 'ws_recovery', workflowKey: 'workflow:recovery', version: '0.0.1', definition: { steps: [] } });
    await runs.put({ id: 'run_recovery', workspaceId: 'ws_recovery', workflowVersionId: 'wfv_recovery', status: 'running', createdAt: new Date().toISOString() });
    await events.append(createEvent({ workspaceId: 'ws_recovery', runId: 'run_recovery', type: 'run.created', sequence: 0, payload: { steps: [] } }));
    assert.equal((await events.listByRun({ workspaceId: 'ws_recovery', runId: 'run_recovery' })).length, 1);
  });

  await cleanup();
  const concurrentDir = await mkdtemp(path.join(os.tmpdir(), 'oaf concurrent migrations '));
  try {
    await writeFile(path.join(concurrentDir, '001_concurrent.sql'), 'SELECT pg_sleep(0.25);\nCREATE TABLE oaf_concurrent(id text PRIMARY KEY);\n');
    const [a, b] = await Promise.all([
      applyMigrations({ pool, directory: concurrentDir }),
      applyMigrations({ pool, directory: concurrentDir })
    ]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(a.applied.length + b.applied.length, 1);
    await withClient(async (client) => {
      assert.equal((await queryOne(client, 'SELECT count(*)::int AS count FROM oaf_schema_migrations WHERE version = 1')).count, 1);
    });
  } finally {
    await rm(concurrentDir, { recursive: true, force: true });
    if (process.env.OAF_KEEP_POSTGRES_TEST_DB !== 'true') await cleanup();
  }

  log({ result: 'passed', database: redactPostgresUrl(url), checks: ['clean apply', 'idempotent second run', 'rollback recovery', 'corrected migration', 'concurrent runners', 'repository event append'] });
} catch (error) {
  console.error(redactPostgresUrl(error.stack ?? error.message));
  process.exit(1);
}
