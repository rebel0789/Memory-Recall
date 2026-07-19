import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { SQLiteMemoryProvider } from '../providers/native/memory-sqlite/src/index.mjs';

async function approveProposal(provider, { id, workspaceId = 'ws_local', sourceHash, payload }) {
  await provider.enqueueProposal({
    id,
    workspaceId,
    sourceLocator: 'workspace://memory/native-core.md',
    sourceHash,
    payload
  });
  await provider.claimProposal({ workspaceId, workerId: 'reviewer', leaseUntil: '2026-06-26T10:05:00.000Z' });
  await provider.recordProposalResult({ workspaceId, id, workerId: 'reviewer', status: 'applied', result: { accepted: true } });
}

async function approveFact(provider, { id, subject, predicate, object, observedAt = '2026-06-26T09:00:00.000Z', supersedes = false }) {
  await provider.enqueueProposal({
    id,
    workspaceId: 'ws_local',
    sourceLocator: 'workspace://DECISIONS.md',
    sourceHash: `sha256:${id.replace(/[^a-f0-9]/giu, 'a').slice(0, 64).padEnd(64, 'a')}`,
    payload: {
      kind: 'fact',
      scope: 'workspace',
      subject,
      predicate,
      object,
      text: `${subject} ${predicate} ${object}`,
      observedAt,
      supersedesSubjectPredicate: supersedes
    }
  });
  return provider.approveProposalFact({ workspaceId: 'ws_local', id });
}

test('native hybrid memory retrieval fuses FTS5 graph and temporal signals while degrading without embeddings', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oaf-memory-hybrid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sqlitePath = path.join(directory, 'memory.sqlite');
  const provider = new SQLiteMemoryProvider({ filename: sqlitePath, clock: () => '2026-06-26T10:00:00.000Z' });
  let closed = false;
  t.after(() => { if (!closed) provider.close(); });

  await approveProposal(provider, {
    id: 'mpq_release',
    sourceHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    payload: { kind: 'fact', subject: 'project:oaf', predicate: 'release_status', object: 'release-candidate' }
  });
  await provider.addTemporalFact({
    id: 'memfact_release',
    workspaceId: 'ws_local',
    scope: 'workspace',
    subject: 'project:oaf',
    predicate: 'release_status',
    object: 'release-candidate',
    text: 'OAF native core release status is release-candidate.',
    source: 'workspace://memory/native-core.md',
    proposalQueueId: 'mpq_release',
    validFrom: '2026-06-25T10:00:00.000Z',
    episode: { id: 'mep_release', sourceLocator: 'workspace://memory/native-core.md', summary: 'Release status note.', observedAt: '2026-06-25T10:00:00.000Z' }
  });

  await approveProposal(provider, {
    id: 'mpq_capability',
    sourceHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    payload: { kind: 'fact', subject: 'project:oaf', predicate: 'uses', object: 'temporal-memory' }
  });
  await provider.addTemporalFact({
    id: 'memfact_capability',
    workspaceId: 'ws_local',
    scope: 'workspace',
    subject: 'project:oaf',
    predicate: 'uses',
    object: 'temporal-memory',
    text: 'Temporal memory retrieval uses local FTS5, entity edges, and temporal ranking.',
    source: 'workspace://memory/native-core.md',
    proposalQueueId: 'mpq_capability',
    validFrom: '2026-06-26T09:00:00.000Z',
    episode: { id: 'mep_capability', sourceLocator: 'workspace://memory/native-core.md', summary: 'Capability note.', observedAt: '2026-06-26T09:00:00.000Z' }
  });

  const report = await provider.searchTemporalMemory({
    workspaceId: 'ws_local',
    scope: 'workspace',
    query: 'release',
    at: '2026-06-26T10:00:00.000Z',
    limit: 5
  });
  assert.deepEqual(report.results.map((item) => item.fact.id), ['memfact_release', 'memfact_capability']);
  assert.equal(report.signals.fts5.status, provider.fts5Available ? 'used' : 'unavailable');
  assert.equal(report.signals.semantic.status, 'skipped');
  assert.equal(report.signals.semantic.reason, 'local_embedder_unavailable');
  assert(report.results[0].ranking.signals.fts5 > 0);
  assert(report.results[1].ranking.signals.graph > 0);
  assert(report.results[1].ranking.signals.temporal > 0);
  assert.match(report.scopedDigest.digest, /^sha256:[a-f0-9]{64}$/);
  assert(report.measurements.scopedDigestBytes < report.measurements.rawResultBytes);

  const pathReport = await provider.getTemporalMemoryPath({
    workspaceId: 'ws_local',
    scope: 'workspace',
    from: 'project:oaf',
    to: 'temporal-memory'
  });
  assert.deepEqual(pathReport.path.map((item) => item.name), ['project:oaf', 'temporal-memory']);
  assert.deepEqual(pathReport.edges.map((edge) => edge.factId), ['memfact_capability']);

  const explanation = await provider.explainTemporalMemory({
    workspaceId: 'ws_local',
    scope: 'workspace',
    query: 'release',
    factId: 'memfact_release'
  });
  assert.equal(explanation.fact.id, 'memfact_release');
  assert(explanation.ranking.signals.fts5 > 0);
  assert.equal(explanation.semantic.status, 'skipped');

  provider.close();
  closed = true;

  const env = { ...process.env, OAF_FIXED_NOW: '2026-06-26T10:00:00.000Z' };
  const search = spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'memory', 'search', 'release', '--sqlite', sqlitePath, '--workspace', 'ws_local', '--scope', 'workspace', '--format', 'json'], { encoding: 'utf8', env });
  assert.equal(search.status, 0, search.stderr);
  assert.deepEqual(JSON.parse(search.stdout).results.map((item) => item.fact.id), ['memfact_release', 'memfact_capability']);
  const pathResult = spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'memory', 'path', '--sqlite', sqlitePath, '--workspace', 'ws_local', '--scope', 'workspace', '--from', 'project:oaf', '--to', 'temporal-memory', '--format', 'json'], { encoding: 'utf8', env });
  assert.equal(pathResult.status, 0, pathResult.stderr);
  assert.deepEqual(JSON.parse(pathResult.stdout).edges.map((edge) => edge.factId), ['memfact_capability']);
  const explain = spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'memory', 'explain', '--sqlite', sqlitePath, '--workspace', 'ws_local', '--scope', 'workspace', '--query', 'release', '--fact', 'memfact_release', '--format', 'json'], { encoding: 'utf8', env });
  assert.equal(explain.status, 0, explain.stderr);
  assert.equal(JSON.parse(explain.stdout).fact.id, 'memfact_release');
});

test('native temporal graph queries traverse approved current-truth neighborhoods', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaf-memory-graph-queries-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.local'), { recursive: true });
  const sqlitePath = path.join(root, '.local', 'memory.sqlite');
  const provider = new SQLiteMemoryProvider({ filename: sqlitePath, clock: () => '2026-06-26T11:00:00.000Z' });
  let closed = false;
  t.after(() => { if (!closed) provider.close(); });

  await approveFact(provider, { id: 'mpq_notes_depends_auth', subject: 'notes-api', predicate: 'depends_on', object: 'auth' });
  await approveFact(provider, { id: 'mpq_notes_uses_auth_mjs', subject: 'notes-api', predicate: 'uses', object: 'auth_mjs' });
  await approveFact(provider, { id: 'mpq_auth_uses_hmac', subject: 'auth', predicate: 'uses', object: 'hmac-session-tokens' });
  await approveFact(provider, { id: 'mpq_auth_implemented_by_auth_mjs', subject: 'auth', predicate: 'implemented_by', object: 'auth_mjs' });
  await approveFact(provider, { id: 'mpq_auth_mjs_exposes_issue', subject: 'auth_mjs', predicate: 'exposes', object: 'issueToken' });
  await approveFact(provider, { id: 'mpq_auth_mjs_exposes_verify', subject: 'auth_mjs', predicate: 'exposes', object: 'verifyToken' });
  await approveFact(provider, { id: 'mpq_auth_token_expiry', subject: 'auth', predicate: 'token_expiry', object: '15 minutes' });

  const issuePath = await provider.getTemporalMemoryPath({ workspaceId: 'ws_local', from: 'notes-api', to: 'issueToken', maxHops: 6 });
  assert.deepEqual(issuePath.path.map((node) => node.name), ['notes-api', 'auth_mjs', 'issueToken']);
  assert.deepEqual(issuePath.edges.map((edge) => [edge.from, edge.predicate, edge.to]), [
    ['notes-api', 'uses', 'auth_mjs'],
    ['auth_mjs', 'exposes', 'issueToken']
  ]);
  assert.deepEqual((await provider.getTemporalMemoryPath({ workspaceId: 'ws_local', from: 'issueToken', to: 'notes-api', maxHops: 6 })).path, []);
  const undirectedBackPath = await provider.getTemporalMemoryPath({ workspaceId: 'ws_local', from: 'issueToken', to: 'notes-api', maxHops: 6, undirected: true });
  assert.deepEqual(undirectedBackPath.path.map((node) => node.name), ['issueToken', 'auth_mjs', 'notes-api']);

  const hmacPath = await provider.getTemporalMemoryPath({ workspaceId: 'ws_local', from: 'notes-api', to: 'hmac-session-tokens', maxHops: 6 });
  assert.deepEqual(hmacPath.path.map((node) => node.name), ['notes-api', 'auth', 'hmac-session-tokens']);

  const authExplain = await provider.explainTemporalMemory({ workspaceId: 'ws_local', entity: 'auth', depth: 1 });
  assert.deepEqual(authExplain.edges.map((edge) => [edge.from, edge.predicate, edge.to]).sort(), [
    ['auth', 'implemented_by', 'auth_mjs'],
    ['auth', 'token_expiry', '15 minutes'],
    ['auth', 'uses', 'hmac-session-tokens'],
    ['notes-api', 'depends_on', 'auth']
  ]);

  await approveFact(provider, {
    id: 'mpq_auth_uses_signed_sessions',
    subject: 'auth',
    predicate: 'uses',
    object: 'signed-session-tokens',
    observedAt: '2026-06-26T10:00:00.000Z',
    supersedes: true
  });

  const stalePath = await provider.getTemporalMemoryPath({ workspaceId: 'ws_local', from: 'notes-api', to: 'hmac-session-tokens', maxHops: 6 });
  assert.deepEqual(stalePath.path, []);
  assert.deepEqual(stalePath.edges, []);
  const historicalPath = await provider.getTemporalMemoryPath({ workspaceId: 'ws_local', from: 'notes-api', to: 'hmac-session-tokens', maxHops: 6, at: '2026-06-26T09:30:00.000Z' });
  assert.deepEqual(historicalPath.path.map((node) => node.name), ['notes-api', 'auth', 'hmac-session-tokens']);

  const currentExplain = await provider.explainTemporalMemory({ workspaceId: 'ws_local', entity: 'auth', depth: 1 });
  assert.equal(currentExplain.edges.some((edge) => edge.to === 'hmac-session-tokens'), false);
  assert.equal(currentExplain.edges.some((edge) => edge.to === 'signed-session-tokens'), true);
  provider.close();
  closed = true;

  const env = { ...process.env, OAF_FIXED_NOW: '2026-06-26T11:00:00.000Z' };
  const cliPath = spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'memory', 'path', '--root', root, '--sqlite', '.local/memory.sqlite', '--workspace', 'ws_local', '--from', 'notes-api', '--to', 'issueToken', '--max-hops', '6', '--format', 'json'], { encoding: 'utf8', env });
  assert.equal(cliPath.status, 0, cliPath.stderr);
  assert.deepEqual(JSON.parse(cliPath.stdout).path.map((node) => node.name), ['notes-api', 'auth_mjs', 'issueToken']);
  const cliExplain = spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'memory', 'explain', '--root', root, '--sqlite', '.local/memory.sqlite', '--workspace', 'ws_local', '--entity', 'auth', '--depth', '1', '--format', 'json'], { encoding: 'utf8', env });
  assert.equal(cliExplain.status, 0, cliExplain.stderr);
  const explainReport = JSON.parse(cliExplain.stdout);
  assert.equal(explainReport.entity, 'auth');
  assert.equal(explainReport.edges.some((edge) => edge.to === 'hmac-session-tokens'), false);
  assert.equal(explainReport.edges.some((edge) => edge.to === 'signed-session-tokens'), true);
});

test('native temporal graph handles scale-shaped entity identity and identifier recall', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oaf-memory-graph-scale-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const provider = new SQLiteMemoryProvider({ filename: path.join(directory, 'memory.sqlite'), clock: () => '2026-06-26T12:00:00.000Z' });
  let closed = false;
  t.after(() => { if (!closed) provider.close(); });

  await approveFact(provider, { id: 'mpq_project_default_memory_provider', subject: 'project:open-agent-fabric', predicate: 'default_memory_provider', object: 'provider:native:memory:sqlite' });
  await approveFact(provider, { id: 'mpq_provider_implements_port', subject: 'provider:native:memory:sqlite', predicate: 'implements_port', object: 'MemoryBackendPort' });
  await approveFact(provider, { id: 'mpq_provider_uses_memory_edges', subject: 'provider:native:memory:sqlite', predicate: 'uses', object: 'memory_edges' });
  for (let index = 0; index < 60; index += 1) {
    await approveFact(provider, { id: `mpq_noise_memory_${index}`, subject: `noise:${index}`, predicate: 'mentions', object: `memory_${index}` });
  }

  const entities = provider.database.prepare(`
    SELECT id, kind, name
    FROM memory_entities
    WHERE workspace_id = ? AND scope = ? AND name = ?
    ORDER BY id ASC
  `).all('ws_local', 'workspace', 'provider:native:memory:sqlite');
  assert.equal(entities.length, 1);

  const pathReport = await provider.getTemporalMemoryPath({
    workspaceId: 'ws_local',
    from: 'project:open-agent-fabric',
    to: 'MemoryBackendPort',
    maxHops: 6
  });
  assert.deepEqual(pathReport.path.map((node) => node.name), ['project:open-agent-fabric', 'provider:native:memory:sqlite', 'MemoryBackendPort']);

  const portRecall = await provider.searchTemporalMemory({ workspaceId: 'ws_local', query: 'MemoryBackendPort', limit: 5 });
  assert.equal(portRecall.results[0].fact.object, 'MemoryBackendPort');
  const memoryRecall = await provider.searchTemporalMemory({ workspaceId: 'ws_local', query: 'memory', limit: 80 });
  assert(memoryRecall.results.some((item) => item.fact.subject === 'provider:native:memory:sqlite' || item.fact.object === 'memory_edges'));

  const legacyPath = path.join(directory, 'legacy.sqlite');
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec(`
    CREATE TABLE memory_entities (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_id, scope, kind, name)
    );
    CREATE TABLE memory_edges (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      source_entity_id TEXT NOT NULL,
      target_entity_id TEXT NOT NULL,
      predicate TEXT NOT NULL,
      fact_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(workspace_id, scope, fact_id)
    );
    INSERT INTO memory_entities VALUES
      ('old_object_provider', 'ws_local', 'workspace', 'object', 'provider:native:memory:sqlite', '2026-06-26T09:00:00.000Z', '2026-06-26T09:00:00.000Z'),
      ('old_subject_provider', 'ws_local', 'workspace', 'subject', 'provider:native:memory:sqlite', '2026-06-26T09:00:00.000Z', '2026-06-26T10:00:00.000Z'),
      ('old_project', 'ws_local', 'workspace', 'subject', 'project:open-agent-fabric', '2026-06-26T09:00:00.000Z', '2026-06-26T09:00:00.000Z');
    INSERT INTO memory_edges VALUES
      ('edge_project_provider', 'ws_local', 'workspace', 'old_project', 'old_object_provider', 'default_memory_provider', 'fact_project_provider', '2026-06-26T09:00:00.000Z'),
      ('edge_provider_port', 'ws_local', 'workspace', 'old_subject_provider', 'old_project', 'implements_port', 'fact_provider_port', '2026-06-26T10:00:00.000Z');
  `);
  legacy.close();
  const migrated = new SQLiteMemoryProvider({ filename: legacyPath, clock: () => '2026-06-26T12:00:00.000Z' });
  const migratedEntities = migrated.database.prepare(`
    SELECT id
    FROM memory_entities
    WHERE workspace_id = ? AND scope = ? AND name = ?
  `).all('ws_local', 'workspace', 'provider:native:memory:sqlite');
  assert.equal(migratedEntities.length, 1);
  const migratedEdgeIds = migrated.database.prepare(`
    SELECT source_entity_id, target_entity_id
    FROM memory_edges
    WHERE workspace_id = ? AND scope = ?
    ORDER BY id ASC
  `).all('ws_local', 'workspace');
  assert(migratedEdgeIds.some((edge) => edge.source_entity_id === migratedEntities[0].id));
  assert(migratedEdgeIds.some((edge) => edge.target_entity_id === migratedEntities[0].id));
  migrated.close();
});
