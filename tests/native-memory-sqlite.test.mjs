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

  const results = await provider.queryCandidates({ workspaceId: 'ws_a', query: 'context manifest' });
  assert.deepEqual(results.map((record) => record.id), ['mem_a']);
  assert.equal(await provider.get({ workspaceId: 'ws_a', id: 'mem_b' }), null);

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
