import test from 'node:test';
import assert from 'node:assert/strict';
import { ingestResearchSources, buildEvidenceGraph } from '../packages/evidence/src/index.mjs';
import { runContentIntelligence } from '../workflows/content-intelligence/runner.mjs';

const collectedAt = '2026-06-20T00:00:00.000Z';

test('ingests bounded text, markdown, JSON, RSS, and Atom into snapshots and observations', () => {
  const rss = `<?xml version="1.0"?><rss><channel><item><title>Recovery checklist</title><link>https://example.test/rss/1</link><description>A six-step checklist showing retries got more saves.</description><pubDate>Fri, 19 Jun 2026 00:00:00 GMT</pubDate></item></channel></rss>`;
  const atom = `<feed><entry><id>tag:example.test,2026:1</id><title>Local workflow test</title><link href="https://example.test/atom/1"/><summary>Reproducing a local-first workflow with cited evidence.</summary><updated>2026-06-19T01:00:00.000Z</updated></entry></feed>`;
  const result = ingestResearchSources({
    workspaceId: 'ws_research',
    collectedAt,
    sources: [
      { format: 'text', sourceLocator: 'file://workspace/notes.txt', body: 'A local agent test log with recovery evidence.' },
      { format: 'markdown', sourceLocator: 'file://workspace/brief.md', body: '# Durable workflow\nA checklist cut our debugging time.' },
      { format: 'json', sourceLocator: 'file://workspace/items.json', body: JSON.stringify([{ title: 'Policy replay', text: 'A replay result earned trust with cited outputs.', metrics: { saves: 12 } }]) },
      { format: 'rss', sourceLocator: 'https://example.test/feed.xml', body: rss, dataClass: 'public' },
      { format: 'atom', sourceLocator: 'https://example.test/feed.atom', body: atom, dataClass: 'public' }
    ]
  });

  assert.equal(result.summary.failureCount, 0);
  assert.equal(result.snapshots.length, 5);
  assert.equal(result.observations.length, 5);
  assert.equal(result.externalAccess.network, false);
  assert.equal(result.externalAccess.browserAutomation, false);
  assert(result.observations.every((item) => item.sourceSnapshotId?.startsWith('src_')));
  assert(result.observations.every((item) => item.sourceContentHash));
  assert(result.observations.every((item) => Object.keys(item.inferred).length === 0));
  assert(result.observations.some((item) => item.platform === 'rss-feed' && item.source === 'https://example.test/rss/1'));
  assert(result.observations.some((item) => item.platform === 'atom-feed' && item.source === 'https://example.test/atom/1'));
  assert(Object.isFrozen(result));
});

test('deduplicates repeated normalized observations while retaining source snapshots', () => {
  const result = ingestResearchSources({
    workspaceId: 'ws_research',
    collectedAt,
    sources: [
      { format: 'text', sourceLocator: 'file://workspace/a.txt', body: 'Same useful observation.' },
      { format: 'markdown', sourceLocator: 'file://workspace/b.md', body: 'Same useful observation.' }
    ]
  });

  assert.equal(result.snapshots.length, 2);
  assert.equal(result.observations.length, 1);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0].canonicalObservationId, result.observations[0].id);
});

test('handles malformed and oversized input without throwing', () => {
  const result = ingestResearchSources({
    workspaceId: 'ws_research',
    collectedAt,
    maxSourceBytes: 40,
    sources: [
      { format: 'json', sourceLocator: 'file://workspace/bad.json', body: '{"items": [' },
      { format: 'rss', sourceLocator: 'https://example.test/empty.xml', body: '<rss><channel></channel></rss>' },
      { format: 'text', sourceLocator: 'file://workspace/large.txt', body: 'x'.repeat(41) },
      { format: 'text', sourceLocator: 'https://user:password@example.test/private', body: 'credential locator' }
    ]
  });

  assert.deepEqual(result.failures.map((item) => item.code), [
    'malformed_source',
    'malformed_source',
    'source_too_large',
    'invalid_source'
  ]);
  assert.equal(result.summary.failureCount, 4);
  assert.equal(result.summary.observationCount, 0);
  assert(result.failures.every((failure) => !JSON.stringify(failure).includes('password')));
});

test('ingested observations remain compatible with evidence graph citation validation', () => {
  const ingestion = ingestResearchSources({
    workspaceId: 'ws_research',
    collectedAt,
    sources: [
      { format: 'text', sourceLocator: 'file://workspace/evidence.txt', body: 'A test result shows recovery completed after process restart.' }
    ]
  });
  const graph = buildEvidenceGraph({
    workspaceId: 'ws_research',
    generatedAt: collectedAt,
    snapshots: ingestion.snapshots,
    observations: ingestion.observations,
    claims: [{ id: 'claim_recovery', text: 'Recovery completed after restart.', evidenceIds: [ingestion.observations[0].id] }]
  });

  assert.equal(graph.citationEdges.length, 1);
  assert.equal(graph.citationEdges[0].sourceSnapshotId, ingestion.snapshots[0].id);
});

test('content workflow can collect from ingested read-only sources', async () => {
  const result = await runContentIntelligence({
    sources: [
      { format: 'text', sourceLocator: 'file://workspace/research.txt', body: 'A six-step checklist showing retries got more saves and cut debugging time.' },
      { format: 'text', sourceLocator: 'file://workspace/research-duplicate.txt', body: 'A six-step checklist showing retries got more saves and cut debugging time.' },
      { format: 'rss', sourceLocator: 'https://example.test/research.xml', body: '<rss><channel><item><title>Local-first permissions</title><link>https://example.test/research/1</link><description>Permissions tests earned trust with cited evidence.</description></item></channel></rss>' }
    ]
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.outputs.collect.summary.duplicateCount, 1);
  assert.equal(result.outputs.collect.externalAccess.network, false);
  assert(result.outputs.normalize.every((item) => item.metadata.sourceSnapshotId?.startsWith('src_')));
});
