import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractTemporalFactProposalsFromEpisode } from '../packages/memory-core/src/index.mjs';
import { SQLiteMemoryProvider } from '../providers/native/memory-sqlite/src/index.mjs';

test('offline fact extraction is deterministic ADD-only and proposal-gated', async (t) => {
  const episode = {
    workspaceId: 'ws_local',
    scope: 'workspace',
    sourceLocator: 'workspace://memory/episode.md',
    observedAt: '2026-06-26T11:00:00.000Z',
    text: 'project:oaf release_status release-candidate. project:oaf uses temporal-memory.'
  };
  const first = extractTemporalFactProposalsFromEpisode(episode);
  const second = extractTemporalFactProposalsFromEpisode(episode);
  assert.deepEqual(first, second);
  assert.deepEqual(first.proposals.map((item) => [item.payload.subject, item.payload.predicate, item.payload.object]), [
    ['project:oaf', 'release_status', 'release-candidate'],
    ['project:oaf', 'uses', 'temporal-memory']
  ]);
  assert.deepEqual(first.proposals[0].payload.entityLinks, [
    { name: 'project:oaf', role: 'subject' },
    { name: 'release-candidate', role: 'object' }
  ]);
  assert.equal(first.proposals[0].payload.provenance.episodeId, first.episode.id);

  const pathEpisode = {
    ...episode,
    sourceLocator: 'workspace://notes/hono-routing.md',
    text: 'Fact: project:hono routing_core src/hono-base.ts and src/compose.ts.'
  };
  const pathProposal = extractTemporalFactProposalsFromEpisode(pathEpisode).proposals[0];
  assert.equal(pathProposal.payload.subject, 'project:hono');
  assert.equal(pathProposal.payload.predicate, 'routing_core');
  assert.equal(pathProposal.payload.object, 'src/hono-base.ts and src/compose.ts');

  const directory = await mkdtemp(path.join(os.tmpdir(), 'oaf-memory-extract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const provider = new SQLiteMemoryProvider({ filename: path.join(directory, 'memory.sqlite'), clock: () => '2026-06-26T11:00:00.000Z' });
  t.after(() => provider.close());

  const queued = await provider.proposeTemporalFactsFromEpisode(episode);
  assert.deepEqual(queued.map((item) => item.status), ['pending', 'pending']);
  assert.deepEqual(queued.map((item) => item.payload.subject), ['project:oaf', 'project:oaf']);
  assert.deepEqual(queued.map((item) => item.payload.subjectEntity), ['project:oaf', 'project:oaf']);
  assert.equal(queued[0].payload.entityLinksJson, '[{"name":"project:oaf","role":"subject"},{"name":"release-candidate","role":"object"}]');
  assert.equal(queued[0].payload.provenanceEpisodeId, first.episode.id);
  assert.equal(queued[0].payload.provenanceSourceLocator, 'workspace://memory/episode.md');
  assert.equal(queued[0].payload.provenanceSourceHash, first.proposals[0].sourceHash);
  assert.deepEqual(await provider.getTemporalFacts({ workspaceId: 'ws_local', scope: 'workspace', query: 'release' }), []);

  const duplicate = await provider.proposeTemporalFactsFromEpisode(episode);
  assert.deepEqual(duplicate.map((item) => item.id), queued.map((item) => item.id));
});
