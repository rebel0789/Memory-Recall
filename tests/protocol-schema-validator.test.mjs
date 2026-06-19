import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertJsonSchema, validateJsonSchema } from '../packages/protocol/src/schema-validator.mjs';

const load = async (filename) => JSON.parse(await readFile(filename, 'utf8'));

test('dependency-free schema validator accepts all valid compatibility fixtures', async () => {
  const manifest = await load('examples/protocol/compatibility/fixtures.json');
  for (const fixture of manifest.fixtures.filter((item) => item.expectedValid)) {
    const result = validateJsonSchema(await load(fixture.schema), await load(fixture.instance));
    assert.equal(result.valid, true, `${fixture.id}: ${JSON.stringify(result.errors)}`);
  }
});

test('dependency-free schema validator rejects all invalid compatibility fixtures', async () => {
  const manifest = await load('examples/protocol/compatibility/fixtures.json');
  for (const fixture of manifest.fixtures.filter((item) => !item.expectedValid)) {
    const result = validateJsonSchema(await load(fixture.schema), await load(fixture.instance));
    assert.equal(result.valid, false, `${fixture.id} unexpectedly valid`);
    assert.ok(result.errors.length > 0);
  }
});

test('schema assertion returns value or a stable error code', async () => {
  const schema = await load('packages/protocol/schemas/event.schema.json');
  const valid = await load('examples/protocol/event.json');
  assert.equal(assertJsonSchema(schema, valid), valid);
  assert.throws(() => assertJsonSchema(schema, {}, 'event'), (error) => error.code === 'schema_validation_failed' && error.errors.length > 0);
});

test('validator enforces bounded collection keywords and rejects unsupported schema keywords', () => {
  assert.deepEqual(validateJsonSchema({ type: 'array', maxItems: 1 }, ['a', 'b']).errors.map((item) => item.keyword), ['maxItems']);
  assert.deepEqual(validateJsonSchema({ type: 'object', maxProperties: 1 }, { a: 1, b: 2 }).errors.map((item) => item.keyword), ['maxProperties']);
  assert.throws(
    () => validateJsonSchema({ type: 'string', unevaluatedProperties: false }, 'x'),
    (error) => error.code === 'unsupported_schema_keyword' && error.keyword === 'unevaluatedProperties'
  );
});
