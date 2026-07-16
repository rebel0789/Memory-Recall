import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateJsonSchema } from '../packages/protocol/src/schema-validator.mjs';

const readJson = async (file) => JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));

test('provider-neutral code intelligence graph validates', async () => {
  const schema = await readJson('packages/protocol/schemas/code-intelligence-graph.schema.json');
  const graph = await readJson('examples/protocol/code-intelligence-graph.json');

  assert.equal(validateJsonSchema(schema, graph).valid, true);
  assert.equal(graph.nodes.every((node) => !Object.hasOwn(node, 'body') && !Object.hasOwn(node, 'sourceText')), true);
});

test('code intelligence graph rejects source bodies and absolute paths', async () => {
  const schema = await readJson('packages/protocol/schemas/code-intelligence-graph.schema.json');
  for (const file of [
    'examples/protocol/compatibility/invalid/code-intelligence-graph-raw-body.json',
    'examples/protocol/compatibility/invalid/code-intelligence-graph-absolute-path.json'
  ]) {
    assert.equal(validateJsonSchema(schema, await readJson(file)).valid, false, file);
  }
});
