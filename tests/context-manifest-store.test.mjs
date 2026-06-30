import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compileAndPersistContext } from '../packages/context-compiler/src/index.mjs';
import { ContextManifestRepositoryPort, assertPortImplementation } from '../packages/adapter-contracts/src/index.mjs';
import { FilesystemContextManifestRepository } from '../providers/native/context-manifest-local/src/index.mjs';
import { PostgresContextManifestRepository } from '../packages/storage/src/postgres-repositories.mjs';

const fixedNow = '2026-06-20T00:00:00.000Z';

function request(overrides = {}) {
  return {
    schemaVersion: '1.0.0',
    id: 'ctxreq_store',
    requestId: 'ctxreq_store',
    correlationId: 'req_store_000000',
    workspaceId: 'ws_store',
    actorId: 'usr_owner',
    taskId: 'task_oaf_012',
    step: 'persist manifest',
    objective: 'Persist context manifest evidence',
    requiredIds: [],
    requiredEntities: ['topic:manifest'],
    allowedScopes: ['workspace-private'],
    allowedDataClasses: ['workspace-private'],
    allowedTrustClasses: ['verified', 'trusted', 'observed'],
    tokenBudget: 80,
    now: fixedNow,
    trustedTimestamp: fixedNow,
    ...overrides
  };
}

function records() {
  return [
    {
      id: 'policy_store',
      kind: 'policy',
      workspaceId: 'ws_store',
      text: 'Persist manifests as immutable workspace-scoped records.',
      tags: ['topic:manifest'],
      relations: ['topic:manifest'],
      scope: 'workspace-private',
      dataClass: 'workspace-private',
      trustClass: 'verified',
      status: 'active',
      source: 'fixture',
      tokens: 12,
      confidence: 1,
      authority: 1
    },
    {
      id: 'obs_store',
      kind: 'observation',
      workspaceId: 'ws_store',
      text: 'A manifest repository supports append, get, list, compare, and verify.',
      tags: ['topic:manifest'],
      relations: ['topic:manifest'],
      scope: 'workspace-private',
      dataClass: 'workspace-private',
      trustClass: 'observed',
      status: 'active',
      source: 'fixture',
      tokens: 14,
      confidence: 0.8,
      authority: 0.7
    }
  ];
}

async function durableManifest(runId = 'run_store') {
  const repository = {
    async append(input) { return input.manifest; },
    async get() { return null; }
  };
  const result = await compileAndPersistContext(request(), records(), {
    manifestRepository: repository,
    runId,
    clock: () => fixedNow
  });
  return result.manifest;
}

test('native manifest repository is workspace scoped, immutable, idempotent, ordered, and tamper detecting', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oaf-context-manifest-'));
  try {
    const store = new FilesystemContextManifestRepository({ root: path.join(directory, 'context manifests'), clock: () => fixedNow });
    assertPortImplementation(store, ContextManifestRepositoryPort);
    assert.equal((await store.health()).status, 'healthy');

    const manifest = await durableManifest('run_store_a');
    const appended = await store.append({ workspaceId: 'ws_store', manifest });
    const duplicate = await store.append({ workspaceId: 'ws_store', manifest: structuredClone(manifest) });
    assert.equal(duplicate.manifestFingerprint, appended.manifestFingerprint);

    const listed = await store.listByRun({ workspaceId: 'ws_store', runId: 'run_store_a' });
    assert.deepEqual(listed.map((item) => item.id), [manifest.id]);
    assert.equal((await store.get({ workspaceId: 'ws_other', id: manifest.id })), null);

    const conflict = structuredClone(manifest);
    conflict.manifestFingerprint = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    await assert.rejects(
      store.append({ workspaceId: 'ws_store', manifest: conflict }),
      (error) => error.code === 'manifest_identity_conflict'
    );

    const tmpPath = path.join(directory, 'context manifests', 'workspaces', 'ws_store', 'manifests', 'ctx_tmp.json.tmp');
    await writeFile(tmpPath, '{}\n');
    assert.deepEqual((await store.listByRun({ workspaceId: 'ws_store', runId: 'run_store_a' })).map((item) => item.id), [manifest.id]);

    const manifestPath = path.join(directory, 'context manifests', 'workspaces', 'ws_store', 'manifests', `${manifest.id}.json`);
    const tampered = JSON.parse(await readFile(manifestPath, 'utf8'));
    tampered.budget.used += 1;
    await writeFile(manifestPath, `${JSON.stringify(tampered, null, 2)}\n`);
    await assert.rejects(
      store.get({ workspaceId: 'ws_store', id: manifest.id }),
      (error) => error.code === 'manifest_tampered'
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

class MemoryPostgresClient {
  constructor() {
    this.contextManifests = new Map();
  }

  async query(text, values = []) {
    const sql = text.trim().replace(/\s+/g, ' ');
    if (sql.startsWith('SELECT id, workspace_id, run_id, compiler_version, request, manifest, created_at FROM context_manifests WHERE workspace_id = $1 AND id = $2')) {
      const row = this.contextManifests.get(`${values[0]}:${values[1]}`);
      return { rows: row ? [row] : [] };
    }
    if (sql.startsWith('INSERT INTO context_manifests')) {
      const [id, workspaceId, runId, compilerVersion, requestValue, manifest, createdAt] = values;
      const row = { id, workspace_id: workspaceId, run_id: runId, compiler_version: compilerVersion, request: requestValue, manifest, created_at: createdAt };
      this.contextManifests.set(`${workspaceId}:${id}`, row);
      return { rows: [row] };
    }
    if (sql.startsWith('SELECT id, workspace_id, run_id, compiler_version, request, manifest, created_at FROM context_manifests WHERE workspace_id = $1 AND run_id = $2')) {
      return {
        rows: [...this.contextManifests.values()]
          .filter((row) => row.workspace_id === values[0] && row.run_id === values[1])
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || a.id.localeCompare(b.id))
          .slice(0, values[2])
      };
    }
    throw new Error(`Unhandled SQL in test client: ${sql}`);
  }
}

test('postgres manifest repository supports append, get, listByRun, idempotency, and conflicts', async () => {
  const client = new MemoryPostgresClient();
  const store = new PostgresContextManifestRepository({ client, clock: () => fixedNow });
  assertPortImplementation(store, ContextManifestRepositoryPort);

  const manifest = await durableManifest('run_store_pg');
  const appended = await store.append({ workspaceId: 'ws_store', manifest });
  assert.equal(appended.manifest.manifestFingerprint, manifest.manifestFingerprint);
  assert.equal((await store.append({ workspaceId: 'ws_store', manifest })).manifest.manifestFingerprint, manifest.manifestFingerprint);
  assert.equal((await store.get({ workspaceId: 'ws_store', id: manifest.id })).manifest.manifestFingerprint, manifest.manifestFingerprint);
  assert.equal(await store.get({ workspaceId: 'ws_other', id: manifest.id }), null);
  assert.deepEqual((await store.listByRun({ workspaceId: 'ws_store', runId: 'run_store_pg' })).map((item) => item.id), [manifest.id]);

  const conflict = structuredClone(manifest);
  conflict.manifestFingerprint = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  await assert.rejects(
    store.append({ workspaceId: 'ws_store', manifest: conflict }),
    (error) => error.code === 'manifest_identity_conflict'
  );
});
