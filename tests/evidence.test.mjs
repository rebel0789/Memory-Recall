import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEvidenceGraph,
  evaluateObservationStaleness,
  normalizeObservation,
  normalizeSourceSnapshot,
  validateClaimCitations
} from '../packages/evidence/src/index.mjs';

const collectedAt = '2026-06-19T00:00:00.000Z';
const asOf = '2026-06-20T00:00:00.000Z';

test('normalizes source snapshots as immutable provenance records', () => {
  const snapshot = normalizeSourceSnapshot({
    id: 'src_0123456789abcdef',
    workspaceId: 'ws_local',
    body: 'Observed source text',
    mediaType: 'text/plain',
    sourceLocator: 'https://example.test/source',
    capturedAt: collectedAt,
    createdAt: collectedAt,
    collector: 'fixture',
    retrievalMethod: 'manual',
    metadata: { title: 'source' }
  });

  assert.equal(snapshot.kind, 'source_snapshot');
  assert.equal(snapshot.hashAlgorithm, 'sha256');
  assert.equal(snapshot.contentHash, snapshot.hash);
  assert.equal(snapshot.byteSize, Buffer.byteLength('Observed source text'));
  assert.equal(snapshot.trust, 'untrusted-external');
  assert(Object.isFrozen(snapshot));
  assert.throws(
    () => normalizeSourceSnapshot({
      id: 'src_0123456789abcdeg',
      body: 'text',
      sourceLocator: 'https://example.test/source',
      capturedAt: collectedAt,
      inferred: { hook: 'not provenance' }
    }),
    /source snapshot cannot contain inference/
  );
});

test('rejects secret-bearing query parameters in source locators', () => {
  assert.throws(
    () => normalizeSourceSnapshot({
      body: 'Observed source text',
      mediaType: 'text/plain',
      sourceLocator: 'https://example.test/source?token=abc123',
      capturedAt: collectedAt
    }),
    /sourceLocator must not contain credentials/
  );
});

test('verifies declared source snapshot hash and size against captured body', () => {
  assert.throws(
    () => normalizeSourceSnapshot({
      body: 'tampered source text',
      contentHash: '0'.repeat(64),
      sourceLocator: 'https://example.test/source',
      capturedAt: collectedAt
    }),
    /contentHash mismatch/
  );
  assert.throws(
    () => normalizeSourceSnapshot({
      body: 'Observed source text',
      byteSize: 1,
      sourceLocator: 'https://example.test/source',
      capturedAt: collectedAt
    }),
    /byteSize mismatch/
  );
});

test('normalizes observations while linking snapshots and separating inference', () => {
  const snapshot = normalizeSourceSnapshot({
    id: 'src_0123456789abcde0',
    body: 'Observed text',
    sourceLocator: 'manual://fixture',
    capturedAt: collectedAt
  });
  const value = normalizeObservation({
    id: 'obs_1',
    sourceSnapshotId: snapshot.id,
    sourceContentHash: snapshot.contentHash,
    source: 'fixture',
    text: 'Observed text',
    collectedAt,
    observed: { views: 10 },
    inferred: { hook: 'question' }
  });

  assert.equal(value.sourceSnapshotId, snapshot.id);
  assert.equal(value.sourceContentHash, snapshot.contentHash);
  assert.equal(value.observed.views, 10);
  assert.equal(value.inferred.hook, 'question');
  assert.equal(value.observed.hook, undefined);
  assert.match(value.contentHash, /^[a-f0-9]{64}$/);
  assert(Object.isFrozen(value));
});

test('builds deterministic deduplication groups and citation edges', () => {
  const graph = buildEvidenceGraph({
    id: 'eg_fixture',
    workspaceId: 'ws_local',
    generatedAt: asOf,
    snapshots: [
      {
        id: 'src_0123456789abcde1',
        body: 'Same body',
        sourceLocator: 'manual://one',
        capturedAt: collectedAt
      },
      {
        id: 'src_0123456789abcde2',
        body: 'Same body',
        sourceLocator: 'manual://two',
        capturedAt: collectedAt
      }
    ],
    observations: [
      {
        id: 'obs_a',
        sourceSnapshotId: 'src_0123456789abcde1',
        source: 'fixture',
        text: 'Same body',
        collectedAt,
        observed: { assertions: [{ subject: 'topic', predicate: 'state', value: 'present' }] }
      },
      {
        id: 'obs_b',
        sourceSnapshotId: 'src_0123456789abcde2',
        source: 'fixture',
        text: 'Same body',
        collectedAt,
        observed: { assertions: [{ subject: 'topic', predicate: 'state', value: 'present' }] }
      }
    ],
    claims: [
      {
        id: 'claim_1',
        text: 'The topic is present.',
        relation: 'supports',
        evidenceIds: ['obs_a']
      }
    ]
  });

  assert.equal(graph.deduplicationGroups.length, 1);
  assert.deepEqual(graph.deduplicationGroups[0].observationIds, ['obs_a', 'obs_b']);
  assert.equal(graph.citationEdges.length, 1);
  assert.equal(graph.citationEdges[0].claimId, 'claim_1');
  assert.equal(graph.citationEdges[0].observationId, 'obs_a');
  assert.equal(graph.citationEdges[0].sourceSnapshotId, 'src_0123456789abcde1');
  assert.equal(validateClaimCitations(graph.claims, graph.observations.map((item) => item.id)).valid, true);
  assert(Object.isFrozen(graph));
});

test('classifies stale observations without changing observed facts', () => {
  const stale = evaluateObservationStaleness({
    id: 'obs_old',
    metricAt: '2026-05-01T00:00:00.000Z',
    collectedAt: '2026-05-01T00:00:00.000Z',
    observed: { views: 5 }
  }, { asOf, staleAfterDays: 14 });
  const fresh = evaluateObservationStaleness({
    id: 'obs_new',
    metricAt: '2026-06-19T00:00:00.000Z',
    collectedAt: '2026-06-19T00:00:00.000Z',
    observed: { views: 5 }
  }, { asOf, staleAfterDays: 14 });

  assert.equal(stale.state, 'stale');
  assert.equal(stale.reasonCodes.includes('metric_window_exceeded'), true);
  assert.equal(fresh.state, 'fresh');
  assert.deepEqual(stale.observed, undefined);
});

test('surfaces conflicts as graph findings instead of overwriting observations', () => {
  const graph = buildEvidenceGraph({
    id: 'eg_conflict',
    workspaceId: 'ws_local',
    generatedAt: asOf,
    observations: [
      {
        id: 'obs_left',
        source: 'fixture',
        text: 'Plan is free',
        collectedAt,
        observed: { assertions: [{ subject: 'plan', predicate: 'price', value: 'free' }] }
      },
      {
        id: 'obs_right',
        source: 'fixture',
        text: 'Plan is paid',
        collectedAt,
        observed: { assertions: [{ subject: 'plan', predicate: 'price', value: 'paid' }] }
      }
    ],
    claims: [
      { id: 'claim_price', text: 'The plan has a price claim.', evidenceIds: ['obs_left', 'obs_right'] }
    ]
  });

  assert.equal(graph.conflicts.length, 1);
  assert.equal(graph.conflicts[0].subject, 'plan');
  assert.equal(graph.conflicts[0].predicate, 'price');
  assert.deepEqual(graph.conflicts[0].observationIds, ['obs_left', 'obs_right']);
  assert.deepEqual(graph.observations.map((item) => item.observed.assertions[0].value), ['free', 'paid']);
});

test('requires citations to available evidence', () => {
  const result = validateClaimCitations([
    { id: 'c1', evidenceIds: ['obs_1'] },
    { id: 'c2', evidenceIds: ['missing'] }
  ], ['obs_1']);

  assert.equal(result.valid, false);
  assert.equal(result.failures[0].claimId, 'c2');
});
