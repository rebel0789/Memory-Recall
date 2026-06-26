import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryBackendPort, runProviderSmokeConformance } from '../packages/adapter-contracts/src/index.mjs';
import { SQLiteMemoryProvider } from '../providers/native/memory-sqlite/src/index.mjs';

test('native SQLite memory is workspace scoped and searchable', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oaf-memory-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const provider = new SQLiteMemoryProvider({ filename: path.join(directory, 'memory.sqlite'), clock: () => '2026-06-19T10:00:00.000Z' });
  t.after(() => provider.close());

  await provider.put({ id: 'mem_a', workspaceId: 'ws_a', kind: 'decision', text: 'Use a context manifest for every model call', source: 'user-confirmed', status: 'active', tags: ['context', 'manifest'] });
  await provider.put({ id: 'mem_b', workspaceId: 'ws_b', kind: 'decision', text: 'Use an unrelated provider', source: 'user-confirmed', status: 'active' });
  await assert.rejects(
    () => provider.put({ id: 'mem_bad_kind', workspaceId: 'ws_a', kind: '/Users/rebel/private-kind', text: 'Bad kind', source: 'user-confirmed', status: 'active' }),
    /unsupported memory kind/
  );
  await assert.rejects(
    () => provider.put({ id: 'mem_a', workspaceId: 'ws_b', kind: 'decision', text: 'Do not move workspace records', source: 'user-confirmed', status: 'active' }),
    /another workspace/
  );

  const results = await provider.queryCandidates({ workspaceId: 'ws_a', query: 'context manifest' });
  assert.deepEqual(results.map((record) => record.id), ['mem_a']);
  assert.equal(await provider.get({ workspaceId: 'ws_a', id: 'mem_b' }), null);
  assert.equal((await provider.get({ workspaceId: 'ws_a', id: 'mem_a' })).text, 'Use a context manifest for every model call');

  const report = await runProviderSmokeConformance({ provider, PortClass: MemoryBackendPort, providerId: 'provider:native:memory:sqlite', expectedCapabilities: ['memory.search.lexical'] });
  assert.equal(report.passed, true);
});

test('native SQLite memory preserves supersession and hard forget', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oaf-memory-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let index = 0;
  const provider = new SQLiteMemoryProvider({ filename: path.join(directory, 'memory.sqlite'), clock: () => `2026-06-19T10:00:0${index++}.000Z` });
  t.after(() => provider.close());

  await provider.put({ id: 'mem_old', workspaceId: 'ws_local', kind: 'preference', text: 'Use long reports', source: 'user-confirmed', status: 'active' });
  await provider.put({ id: 'mem_taken', workspaceId: 'ws_other', kind: 'preference', text: 'Other workspace record', source: 'user-confirmed', status: 'active' });
  await assert.rejects(
    () => provider.supersede({
      workspaceId: 'ws_local',
      previousId: 'mem_old',
      replacement: { id: 'mem_taken', kind: 'preference', text: 'Invalid cross-workspace replacement', source: 'user-confirmed' }
    }),
    /another workspace/
  );
  assert.equal((await provider.get({ workspaceId: 'ws_local', id: 'mem_old' })).status, 'active');
  const replacement = await provider.supersede({
    workspaceId: 'ws_local',
    previousId: 'mem_old',
    replacement: { id: 'mem_new', kind: 'preference', text: 'Use focused reports', source: 'user-confirmed' }
  });
  assert.equal(replacement.supersedes, 'mem_old');
  assert.equal((await provider.get({ workspaceId: 'ws_local', id: 'mem_old' })).status, 'superseded');
  assert.deepEqual((await provider.queryCandidates({ workspaceId: 'ws_local', query: 'reports' })).map((record) => record.id), ['mem_new']);

  assert.equal(await provider.forget({ workspaceId: 'ws_local', id: 'mem_new' }), true);
  assert.equal(await provider.forget({ workspaceId: 'ws_local', id: 'mem_new' }), false);
  const archive = await provider.export({ workspaceId: 'ws_local' });
  assert.deepEqual(archive.records.map((record) => record.id), ['mem_old']);
});

test('native SQLite memory enforces temporal validity and scopes', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oaf-memory-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const provider = new SQLiteMemoryProvider({ filename: path.join(directory, 'memory.sqlite'), clock: () => '2026-06-19T10:00:00.000Z' });
  t.after(() => provider.close());

  await provider.put({ id: 'mem_expired', workspaceId: 'ws_local', kind: 'fact', text: 'Old launch date', source: 'verified', status: 'active', validTo: '2026-01-01T00:00:00.000Z' });
  await provider.put({ id: 'mem_private', workspaceId: 'ws_local', kind: 'fact', text: 'Restricted launch detail', source: 'verified', status: 'active', scope: 'restricted' });
  assert.deepEqual(await provider.queryCandidates({ workspaceId: 'ws_local', query: 'launch', at: '2026-06-19T10:00:00.000Z' }), []);
  assert.deepEqual((await provider.queryCandidates({ workspaceId: 'ws_local', query: 'launch', at: '2026-06-19T10:00:00.000Z', allowedScopes: ['restricted'] })).map((record) => record.id), ['mem_private']);
});

test('native SQLite memory preserves lifecycle, evidence, and review fields', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oaf-memory-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const provider = new SQLiteMemoryProvider({ filename: path.join(directory, 'memory.sqlite'), clock: () => '2026-06-23T10:00:00.000Z' });
  t.after(() => provider.close());

  await provider.put({
    id: 'mem_lifecycle',
    workspaceId: 'ws_local',
    kind: 'decision',
    text: 'Memory reports are generated from canonical OAF memory only.',
    source: 'evidence:ev_memory',
    sourceTrust: 'verified',
    status: 'active',
    decision: 'allow',
    reasons: ['reviewed'],
    dataClass: 'workspace-private',
    evidenceIds: ['ev_memory'],
    conflicts: [{ existingId: 'mem_old', reason: 'superseded' }],
    verifiedBy: 'usr_reviewer',
    activatedBy: 'usr_reviewer',
    lifecycle: [
      { type: 'memory.proposed', at: '2026-06-23T09:59:00.000Z', actorId: 'agent', reason: null, evidenceIds: [] },
      { type: 'memory.activated', at: '2026-06-23T10:00:00.000Z', actorId: 'usr_reviewer', reason: null, evidenceIds: ['ev_memory'] }
    ]
  });

  const record = await provider.get({ workspaceId: 'ws_local', id: 'mem_lifecycle' });
  assert.equal(record.sourceTrust, 'verified');
  assert.equal(record.decision, 'allow');
  assert.deepEqual(record.reasons, ['reviewed']);
  assert.equal(record.dataClass, 'workspace-private');
  assert.deepEqual(record.evidenceIds, ['ev_memory']);
  assert.equal(record.conflicts[0].existingId, 'mem_old');
  assert.equal(record.verifiedBy, 'usr_reviewer');
  assert.equal(record.activatedBy, 'usr_reviewer');
  assert.equal(record.lifecycle.at(-1).type, 'memory.activated');

  const archive = await provider.export({ workspaceId: 'ws_local' });
  assert.equal(archive.records[0].lifecycle.length, 2);
});

test('native SQLite proposal queue dedupes, leases, retries, and records poison errors', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oaf-memory-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let index = 0;
  const provider = new SQLiteMemoryProvider({ filename: path.join(directory, 'memory.sqlite'), clock: () => `2026-06-23T10:00:0${index++}.000Z` });
  t.after(() => provider.close());

  const input = {
    workspaceId: 'ws_local',
    sourceLocator: 'workspace://memory/inbox.md',
    sourceHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    payload: { kind: 'episode', text: 'Review proposed memory from workspace file.' },
    maxAttempts: 2
  };
  await assert.rejects(
    () => provider.enqueueProposal({ ...input, id: 'bad_/Users/rebel/private', sourceHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
    /queue id/
  );
  await assert.rejects(
    () => provider.enqueueProposal({ ...input, fingerprint: 'not-a-fingerprint' }),
    /fingerprint/
  );
  const queued = await provider.enqueueProposal(input);
  const duplicate = await provider.enqueueProposal(input);
  assert.equal(duplicate.id, queued.id);
  assert.equal(duplicate.status, 'pending');

  const claimed = await provider.claimProposal({
    workspaceId: 'ws_local',
    workerId: 'worker_a',
    leaseUntil: '2026-06-23T10:01:00.000Z'
  });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].attempts, 1);
  assert.equal(claimed[0].leaseOwner, 'worker_a');

  const retry = await provider.recordProposalResult({
    workspaceId: 'ws_local',
    id: queued.id,
    workerId: 'worker_a',
    status: 'claimed',
    error: { code: 'temporary_parse_error', message: 'retry' },
    retry: true
  });
  assert.equal(retry.status, 'pending');
  const reclaimed = await provider.claimProposal({
    workspaceId: 'ws_local',
    workerId: 'worker_b',
    leaseUntil: '2026-06-23T10:01:00.000Z'
  });
  assert.equal(reclaimed[0].attempts, 2);
  assert.equal(reclaimed[0].leaseOwner, 'worker_b');

  const poison = await provider.recordProposalResult({
    workspaceId: 'ws_local',
    id: queued.id,
    workerId: 'worker_b',
    status: 'poison',
    error: { code: 'invalid_memory_path', message: 'poison /Users/rebel/private.txt OPENAI_API_KEY=secret-value' }
  });
  assert.equal(poison.status, 'poison');
  const errors = await provider.listProposalErrors({ workspaceId: 'ws_local' });
  assert.deepEqual(errors.map((record) => record.id), [queued.id]);
  assert.equal(errors[0].error.code, 'invalid_memory_path');
  assert.match(errors[0].error.message, /\[redacted-local-path\]/);
  assert.match(errors[0].error.message, /\[redacted-secret\]/);
  assert.doesNotMatch(JSON.stringify(errors), /\/Users\/rebel/);
  assert.doesNotMatch(JSON.stringify(errors), /secret-value/);
});

test('native SQLite proposal queue enforces lease ownership and poisons abandoned final leases', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oaf-memory-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let current = '2026-06-23T10:00:00.000Z';
  const provider = new SQLiteMemoryProvider({ filename: path.join(directory, 'memory.sqlite'), clock: () => current });
  t.after(() => provider.close());

  const queued = await provider.enqueueProposal({
    workspaceId: 'ws_local',
    sourceLocator: 'workspace://memory/inbox.md',
    sourceHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    payload: { kind: 'episode', text: 'Review proposed memory from workspace file.' },
    maxAttempts: 1
  });
  await provider.claimProposal({
    workspaceId: 'ws_local',
    workerId: 'worker_a',
    leaseUntil: '2026-06-23T10:00:01.000Z'
  });
  await assert.rejects(
    () => provider.recordProposalResult({ workspaceId: 'ws_local', id: queued.id, workerId: 'worker_b', status: 'applied' }),
    /does not own/
  );
  current = '2026-06-23T10:00:02.000Z';
  await assert.rejects(
    () => provider.recordProposalResult({ workspaceId: 'ws_local', id: queued.id, workerId: 'worker_a', status: 'applied' }),
    /lease expired/
  );
  assert.deepEqual(await provider.claimProposal({ workspaceId: 'ws_local', workerId: 'worker_c' }), []);
  const errors = await provider.listProposalErrors({ workspaceId: 'ws_local' });
  assert.deepEqual(errors.map((record) => record.id), [queued.id]);
  assert.equal(errors[0].error.code, 'lease_expired_max_attempts');
});

test('native SQLite temporal facts are proposal-gated, superseded, time-travel queryable, and episode-provenanced', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oaf-memory-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let current = '2026-06-24T10:00:00.000Z';
  const provider = new SQLiteMemoryProvider({ filename: path.join(directory, 'memory.sqlite'), clock: () => current });
  t.after(() => provider.close());

  await assert.rejects(
    () => provider.addTemporalFact({
      id: 'memfact_ungated',
      workspaceId: 'ws_local',
      scope: 'workspace',
      subject: 'project:oaf',
      predicate: 'release_status',
      object: 'alpha',
      text: 'OAF release status is alpha.',
      source: 'workspace://memory/status.md',
      episode: {
        id: 'mep_status_1',
        sourceLocator: 'workspace://memory/status.md',
        summary: 'Initial status note.',
        observedAt: '2026-06-24T09:55:00.000Z'
      }
    }),
    /proposal gate/
  );

  const firstProposal = await provider.enqueueProposal({
    id: 'mpq_first',
    workspaceId: 'ws_local',
    sourceLocator: 'workspace://memory/status.md',
    sourceHash: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    payload: { kind: 'fact', subject: 'project:oaf', predicate: 'release_status', object: 'alpha' }
  });
  await provider.claimProposal({ workspaceId: 'ws_local', workerId: 'reviewer', leaseUntil: '2026-06-24T10:05:00.000Z' });
  await provider.recordProposalResult({ workspaceId: 'ws_local', id: firstProposal.id, workerId: 'reviewer', status: 'applied', result: { accepted: true } });
  const first = await provider.addTemporalFact({
    id: 'memfact_alpha',
    workspaceId: 'ws_local',
    scope: 'workspace',
    subject: 'project:oaf',
    predicate: 'release_status',
    object: 'alpha',
    text: 'OAF release status is alpha.',
    source: 'workspace://memory/status.md',
    proposalQueueId: firstProposal.id,
    validFrom: '2026-06-24T10:00:00.000Z',
    episode: {
      id: 'mep_status_1',
      sourceLocator: 'workspace://memory/status.md',
      summary: 'Initial status note.',
      observedAt: '2026-06-24T09:55:00.000Z'
    }
  });
  assert.equal(first.episode.id, 'mep_status_1');

  current = '2026-06-25T10:00:00.000Z';
  const secondProposal = await provider.enqueueProposal({
    id: 'mpq_second',
    workspaceId: 'ws_local',
    sourceLocator: 'workspace://memory/status.md',
    sourceHash: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    payload: { kind: 'fact', subject: 'project:oaf', predicate: 'release_status', object: 'release-candidate' }
  });
  await provider.claimProposal({ workspaceId: 'ws_local', workerId: 'reviewer', leaseUntil: '2026-06-25T10:05:00.000Z' });
  await provider.recordProposalResult({ workspaceId: 'ws_local', id: secondProposal.id, workerId: 'reviewer', status: 'applied', result: { accepted: true } });
  const second = await provider.addTemporalFact({
    id: 'memfact_rc',
    workspaceId: 'ws_local',
    scope: 'workspace',
    subject: 'project:oaf',
    predicate: 'release_status',
    object: 'release-candidate',
    text: 'OAF release status is release-candidate.',
    source: 'workspace://memory/status.md',
    proposalQueueId: secondProposal.id,
    validFrom: '2026-06-25T10:00:00.000Z',
    episode: {
      id: 'mep_status_2',
      sourceLocator: 'workspace://memory/status.md',
      summary: 'Reviewed status update.',
      observedAt: '2026-06-25T09:55:00.000Z'
    }
  });

  const then = await provider.getTemporalFacts({
    workspaceId: 'ws_local',
    scope: 'workspace',
    subject: 'project:oaf',
    predicate: 'release_status',
    at: '2026-06-24T12:00:00.000Z'
  });
  const now = await provider.getTemporalFacts({
    workspaceId: 'ws_local',
    scope: 'workspace',
    subject: 'project:oaf',
    predicate: 'release_status',
    at: '2026-06-26T12:00:00.000Z'
  });
  assert.deepEqual(then.map((fact) => fact.id), ['memfact_alpha']);
  assert.deepEqual(now.map((fact) => fact.id), ['memfact_rc']);

  const history = await provider.getTemporalFactHistory({
    workspaceId: 'ws_local',
    scope: 'workspace',
    subject: 'project:oaf',
    predicate: 'release_status'
  });
  assert.deepEqual(history.map((fact) => fact.id), ['memfact_alpha', 'memfact_rc']);
  assert.equal(history[0].validUntil, second.validFrom);
  assert.equal(history[0].supersededBy, 'memfact_rc');
  assert.equal(history[1].supersededBy, null);
  assert.equal(history[1].episode.sourceLocator, 'workspace://memory/status.md');
  assert.equal(second.proposalQueueId, 'mpq_second');
});
