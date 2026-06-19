import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PostgresContextManifestRepository,
  PostgresEventRepository,
  PostgresRunRepository,
  PostgresWorkspaceRepository
} from '../packages/storage/src/postgres-repositories.mjs';
import { EventRepositoryPort, assertPortImplementation } from '../packages/adapter-contracts/src/index.mjs';
import { createEvent } from '../packages/protocol/src/index.mjs';

class MemoryPostgresClient {
  constructor() {
    this.calls = [];
    this.workspaces = new Map();
    this.runs = new Map();
    this.events = [];
    this.contextManifests = new Map();
    this.transactionDepth = 0;
  }

  async query(text, values = []) {
    const sql = text.trim().replace(/\s+/g, ' ');
    this.calls.push({ sql, values });
    if (sql === 'BEGIN') { this.transactionDepth += 1; return { rows: [] }; }
    if (sql === 'COMMIT') { this.transactionDepth -= 1; return { rows: [] }; }
    if (sql === 'ROLLBACK') { this.transactionDepth = Math.max(0, this.transactionDepth - 1); return { rows: [] }; }

    if (sql.startsWith('INSERT INTO workspaces')) {
      const [id, name, policy, createdAt] = values;
      const row = { id, name, policy, created_at: createdAt };
      this.workspaces.set(id, row);
      return { rows: [row] };
    }

    if (sql.startsWith('SELECT id, name, created_at, policy FROM workspaces')) {
      return { rows: this.workspaces.has(values[0]) ? [this.workspaces.get(values[0])] : [] };
    }

    if (sql.startsWith('INSERT INTO runs')) {
      const [id, workspaceId, workflowVersionId, status, objective, createdAt, completedAt, metadata] = values;
      const row = { id, workspace_id: workspaceId, workflow_version_id: workflowVersionId, status, objective, created_at: createdAt, completed_at: completedAt, metadata };
      this.runs.set(`${workspaceId}:${id}`, row);
      return { rows: [row] };
    }

    if (sql.startsWith('SELECT id FROM runs WHERE workspace_id = $1 AND id = $2 FOR UPDATE')) {
      const row = this.runs.get(`${values[0]}:${values[1]}`);
      return { rows: row ? [{ id: row.id }] : [] };
    }

    if (sql.startsWith('SELECT id, workspace_id, workflow_version_id, status, objective, created_at, completed_at, metadata FROM runs')) {
      const row = this.runs.get(`${values[0]}:${values[1]}`);
      return { rows: row ? [row] : [] };
    }

    if (sql.startsWith('SELECT COALESCE(MAX(sequence), -1) AS last_sequence FROM events')) {
      const last = this.events
        .filter((event) => event.workspace_id === values[0] && event.run_id === values[1])
        .reduce((max, event) => Math.max(max, event.sequence), -1);
      return { rows: [{ last_sequence: last }] };
    }

    if (sql.startsWith('INSERT INTO events')) {
      const [
        id,
        workspaceId,
        runId,
        sequence,
        schemaVersion,
        type,
        actorId,
        occurredAt,
        correlationId,
        causationId,
        dataClass,
        producerVersion,
        payload
      ] = values;
      const row = {
        id,
        workspace_id: workspaceId,
        run_id: runId,
        sequence,
        schema_version: schemaVersion,
        type,
        actor_id: actorId,
        occurred_at: occurredAt,
        correlation_id: correlationId,
        causation_id: causationId,
        data_class: dataClass,
        producer_version: producerVersion,
        payload
      };
      this.events.push(row);
      return { rows: [row] };
    }

    if (sql.startsWith('SELECT id, workspace_id, run_id, sequence, schema_version, type, actor_id, occurred_at, correlation_id, causation_id, data_class, producer_version, payload FROM events')) {
      return {
        rows: this.events
          .filter((event) => event.workspace_id === values[0] && event.run_id === values[1])
          .sort((a, b) => a.sequence - b.sequence)
      };
    }

    if (sql.startsWith('INSERT INTO context_manifests')) {
      const [id, workspaceId, runId, compilerVersion, request, manifest, createdAt] = values;
      const row = { id, workspace_id: workspaceId, run_id: runId, compiler_version: compilerVersion, request, manifest, created_at: createdAt };
      this.contextManifests.set(`${workspaceId}:${id}`, row);
      return { rows: [row] };
    }

    throw new Error(`Unhandled SQL in test client: ${sql}`);
  }
}

test('Postgres event repository appends canonical events in sequence and by workspace', async () => {
  const client = new MemoryPostgresClient();
  const workspaces = new PostgresWorkspaceRepository({ client });
  const runs = new PostgresRunRepository({ client });
  const events = new PostgresEventRepository({ client });
  assertPortImplementation(events, EventRepositoryPort);

  await workspaces.put({ id: 'ws_a', name: 'Workspace A', createdAt: '2026-06-19T00:00:00.000Z' });
  await runs.put({
    id: 'run_a',
    workspaceId: 'ws_a',
    workflowVersionId: 'wfv_a',
    status: 'running',
    objective: 'verify postgres repositories',
    createdAt: '2026-06-19T00:00:01.000Z'
  });

  const first = createEvent({ workspaceId: 'ws_a', runId: 'run_a', type: 'run.created', sequence: 0, payload: { steps: [] } });
  const second = createEvent({ workspaceId: 'ws_a', runId: 'run_a', type: 'run.started', sequence: 1, payload: {} });
  assert.equal((await events.append(first)).id, first.id);
  assert.equal((await events.append(second)).sequence, 1);

  client.events.push({
    id: 'evt_other',
    workspace_id: 'ws_b',
    run_id: 'run_a',
    sequence: 0,
    schema_version: '1.0.0',
    type: 'run.created',
    actor_id: 'system',
    occurred_at: '2026-06-19T00:00:02.000Z',
    correlation_id: 'run_a',
    causation_id: null,
    data_class: 'workspace-private',
    producer_version: '0.2.0-dev',
    payload: {}
  });

  assert.deepEqual((await events.listByRun({ workspaceId: 'ws_a', runId: 'run_a' })).map((event) => event.sequence), [0, 1]);
  assert.ok(client.calls.some((call) => call.sql.includes('WHERE workspace_id = $1 AND run_id = $2')));
});

test('Postgres event repository rejects sequence gaps and cross-workspace runs', async () => {
  const client = new MemoryPostgresClient();
  const runs = new PostgresRunRepository({ client });
  const events = new PostgresEventRepository({ client });

  await runs.put({
    id: 'run_scoped',
    workspaceId: 'ws_a',
    workflowVersionId: 'wfv_a',
    status: 'running',
    createdAt: '2026-06-19T00:00:00.000Z'
  });

  await assert.rejects(
    events.append(createEvent({ workspaceId: 'ws_a', runId: 'run_scoped', type: 'run.started', sequence: 1, payload: {} })),
    (error) => error.code === 'event_sequence_conflict'
  );
  assert.equal(client.events.length, 0);
  assert.ok(client.calls.some((call) => call.sql === 'ROLLBACK'));

  await assert.rejects(
    events.append(createEvent({ workspaceId: 'ws_b', runId: 'run_scoped', type: 'run.created', sequence: 0, payload: { steps: [] } })),
    (error) => error.code === 'run_not_found'
  );
});

test('Postgres repositories map JSON columns without exposing provider payloads', async () => {
  const client = new MemoryPostgresClient();
  const workspaces = new PostgresWorkspaceRepository({ client });
  const runs = new PostgresRunRepository({ client });
  const manifests = new PostgresContextManifestRepository({ client });

  const workspace = await workspaces.put({ id: 'ws_json', name: 'JSON workspace', policy: { network: 'deny' }, createdAt: '2026-06-19T00:00:00.000Z' });
  assert.deepEqual(workspace.policy, { network: 'deny' });
  assert.equal((await workspaces.get({ id: 'ws_json' })).name, 'JSON workspace');

  const run = await runs.put({
    id: 'run_json',
    workspaceId: 'ws_json',
    workflowVersionId: 'wfv_json',
    status: 'completed',
    createdAt: '2026-06-19T00:00:01.000Z',
    metadata: { provider: 'postgres' }
  });
  assert.deepEqual(run.metadata, { provider: 'postgres' });
  assert.equal(await runs.get({ workspaceId: 'ws_other', id: 'run_json' }), null);

  const manifest = await manifests.put({
    id: 'ctx_json',
    workspaceId: 'ws_json',
    runId: 'run_json',
    compilerVersion: 'context-compiler@0.2.0-dev',
    request: { objective: 'test' },
    manifest: { selected: [], excluded: [] },
    createdAt: '2026-06-19T00:00:02.000Z'
  });
  assert.deepEqual(manifest.manifest, { selected: [], excluded: [] });
});
