import { readFile } from 'node:fs/promises';
import { validateJsonSchema } from '../packages/protocol/src/schema-validator.mjs';

const manifest = JSON.parse(await readFile('examples/protocol/compatibility/fixtures.json', 'utf8'));
let failures = 0;
for (const fixture of manifest.fixtures) {
  const schema = JSON.parse(await readFile(fixture.schema, 'utf8'));
  const instance = JSON.parse(await readFile(fixture.instance, 'utf8'));
  const result = validateJsonSchema(schema, instance);
  const passed = result.valid === fixture.expectedValid;
  console.log(`${passed ? 'PASS' : 'FAIL'} ${fixture.id}: expected ${fixture.expectedValid ? 'valid' : 'invalid'}, received ${result.valid ? 'valid' : 'invalid'}`);
  if (!passed) {
    failures += 1;
    for (const error of result.errors) console.log(`  ${error.path} ${error.keyword}: ${error.message}`);
  }
}
if (failures) {
  console.error(`Protocol compatibility result: ${failures} failed.`);
  process.exitCode = 1;
} else {
  console.log(`Protocol compatibility result: ${manifest.fixtures.length} passed, 0 failed.`);
}
