import assert from 'node:assert/strict';
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
    'index.status',
    'index.doctor',
    'index.query'
  ]);
  assert.deepEqual(CODE_INTELLIGENCE_INDEX_QUERY_KINDS, [
    'summary',
    'exact',
    'neighborhood',
    'dependencies',
    'trace',
    'impact',
    'routes'
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
