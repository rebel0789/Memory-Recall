import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
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
