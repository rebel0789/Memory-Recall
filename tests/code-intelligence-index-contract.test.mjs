import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  CODE_INTELLIGENCE_INDEX_OPERATIONS,
  CODE_INTELLIGENCE_INDEX_QUERY_KINDS,
  CODE_INTELLIGENCE_INDEX_LOCATOR
} from '../packages/protocol/src/index.mjs';
import { validateJsonSchema } from '../packages/protocol/src/schema-validator.mjs';

const readJson = async (file) => JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));

test('source index lifecycle request and response contracts are closed and bounded', async () => {
  const requestSchema = await readJson('packages/protocol/schemas/code-intelligence-index-request.schema.json');
  const responseSchema = await readJson('packages/protocol/schemas/code-intelligence-index-response.schema.json');
  const requests = await Promise.all([
    'build',
    'refresh',
    'repair',
    'status',
    'doctor',
    'query'
  ].map((operation) => readJson(`examples/protocol/code-intelligence-index-${operation}-request.json`)));
  const responses = await Promise.all([
    'writer',
    'reader'
  ].map((kind) => readJson(`examples/protocol/code-intelligence-index-${kind}-response.json`)));

  assert.deepEqual(CODE_INTELLIGENCE_INDEX_OPERATIONS, [
    'index.build',
    'index.refresh',
    'index.repair',
    'index.status',
    'index.doctor',
    'index.query'
  ]);
  assert.deepEqual(CODE_INTELLIGENCE_INDEX_QUERY_KINDS, [
    'summary',
    'exact',
    'search',
    'neighborhood',
    'dependencies',
    'trace',
    'impact',
    'routes',
    'communities',
    'processes'
  ]);
  assert.equal(CODE_INTELLIGENCE_INDEX_LOCATOR, 'workspace://.local/source-index/index.v1.sqlite');
  assert.equal(requests.every((request) => validateJsonSchema(requestSchema, request).valid), true);
  assert.equal(responses.every((response) => validateJsonSchema(responseSchema, response).valid), true);
});

test('source index request contract rejects paths, SQL, unbounded reads, and accidental writer authority', async () => {
  const schema = await readJson('packages/protocol/schemas/code-intelligence-index-request.schema.json');
  const invalidFiles = [
    'code-intelligence-index-absolute-path.json',
    'code-intelligence-index-raw-sql.json',
    'code-intelligence-index-unbounded-query.json',
    'code-intelligence-index-status-writer.json',
    'code-intelligence-index-doctor-repair.json'
  ];

  for (const file of invalidFiles) {
    const instance = await readJson(`examples/protocol/compatibility/invalid/${file}`);
    assert.equal(validateJsonSchema(schema, instance).valid, false, file);
  }
});

test('source index response contract rejects source bodies, local paths, raw database errors, and unsafe write claims', async () => {
  const schema = await readJson('packages/protocol/schemas/code-intelligence-index-response.schema.json');
  const reader = await readJson('examples/protocol/code-intelligence-index-reader-response.json');
  const writer = await readJson('examples/protocol/code-intelligence-index-writer-response.json');

  assert.equal(validateJsonSchema(schema, {
    ...reader,
    result: { ...reader.result, sourceBody: 'secret source' }
  }).valid, false);
  assert.equal(validateJsonSchema(schema, {
    ...reader,
    result: { ...reader.result, indexPath: '/Users/example/repository/.local/index.sqlite' }
  }).valid, false);
  assert.equal(validateJsonSchema(schema, {
    ...reader,
    result: {
      ...reader.result,
      relationships: [{ ...reader.result.relationships[0], locator: '/Users/example/repository/src/private.ts' }]
    }
  }).valid, false);
  assert.equal(validateJsonSchema(schema, {
    ...reader,
    result: {
      ...reader.result,
      diagnostics: [{ code: 'index_corrupt', count: 1, detail: 'database disk image is malformed' }]
    }
  }).valid, false);
  assert.equal(validateJsonSchema(schema, {
    ...reader,
    result: {
      ...reader.result,
      safeguards: { ...reader.result.safeguards, localFilesWritten: 1 }
    }
  }).valid, false);
  assert.equal(validateJsonSchema(schema, {
    ...writer,
    result: {
      ...writer.result,
      safeguards: { ...writer.result.safeguards, canonicalMemoryWrites: 1 }
    }
  }).valid, false);
});

test('Phase 3 source-index evidence binds clean pinned cases without scale or parity claims', async () => {
  const report = await readJson('evals/code-intelligence/results/phase3-source-index.json');
  const { generatedAt: _generatedAt, reportFingerprint, ...comparable } = report;
  const expectedFingerprint = `sha256:${createHash('sha256').update(JSON.stringify(comparable)).digest('hex')}`;

  assert.equal(reportFingerprint, expectedFingerprint);
  assert.equal(report.gateDecision, 'pass');
  assert.deepEqual(report.failures, []);
  assert.equal(report.checkout.dirtyBeforeRun, false);
  assert.match(report.checkout.commit, /^[a-f0-9]{40}$/u);
  assert.equal(report.summary.caseCount, 4);
  assert.equal(report.summary.fixtureCount, 1);
  assert.equal(report.summary.repositoryCount, 3);
  assert(report.summary.totalFileCount >= 700);
  assert(report.summary.totalNodeCount >= 6_000);
  assert(report.summary.totalEdgeCount >= 15_000);
  assert.equal(report.cases.every((item) => item.invariants.noChangeDatabaseUnchanged), true);
  assert.equal(report.cases.every((item) => item.invariants.readQueriesDatabaseUnchanged), true);
  assert.equal(report.cases.every((item) => item.operations.exactLookup.localFilesWritten === 0), true);
  assert.equal(report.cases.every((item) => item.operations.impact.localFilesWritten === 0), true);
  assert.equal(report.claims.competitorParity, false);
  assert.equal(report.claims.leadership, false);
  assert.equal(report.claims.multiRepository, false);
  assert.equal(report.claims.millionNodeScale, false);
  assert.doesNotMatch(JSON.stringify(report), /(?:\/Users\/|\/home\/[^/]+\/|\/private\/|\/var\/folders\/|[A-Za-z]:\\)/u);
});

test('Phase 4 intelligence evidence proves deterministic bounded projections without parity claims', async () => {
  const report = await readJson('evals/code-intelligence/results/phase4-intelligence.json');
  const { generatedAt: _generatedAt, reportFingerprint, ...comparable } = report;
  const expectedFingerprint = `sha256:${createHash('sha256').update(JSON.stringify(comparable)).digest('hex')}`;

  assert.equal(reportFingerprint, expectedFingerprint);
  assert.equal(report.gateDecision, 'pass');
  assert.deepEqual(report.failures, []);
  assert(report.results.communityCount > 0);
  assert(report.results.processCount > 0);
  assert.equal(report.results.communityAlgorithm, 'label-propagation-v1');
  assert.equal(report.results.processAlgorithm, 'entry-path-v1');
  assert.equal(report.results.readQueriesPreservedIndex, true);
  assert.equal(report.results.evidenceComplete, true);
  assert(report.results.communityQueryWallMs.p95 <= report.inputs.queryDeadlineMs);
  assert(report.results.processQueryWallMs.p95 <= report.inputs.queryDeadlineMs);
  assert.equal(report.claims.competitorParity, false);
  assert.equal(report.claims.leadership, false);
  assert.equal(report.claims.millionNodeScale, false);
  assert.doesNotMatch(JSON.stringify(report), /(?:\/Users\/|\/home\/[^/]+\/|\/private\/|\/var\/folders\/|[A-Za-z]:\\)/u);
});
