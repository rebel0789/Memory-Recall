import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function manifests(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await manifests(full));
    else if (entry.name === 'adapter.json') output.push(full);
  }
  return output;
}

test('every external adapter has a versioned conformance contract fixture', async () => {
  const files = await manifests(fileURLToPath(new URL('../adapters', import.meta.url)));
  assert.equal(files.length, 12);
  const experimental = [];
  for (const file of files) {
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    const fixture = JSON.parse(await readFile(path.join(path.dirname(file), manifest.conformance.fixture), 'utf8'));
    assert.equal(manifest.protocolVersion, '1.0.0');
    assert.equal(manifest.enabledByDefault, false);
    if (manifest.status === 'experimental') {
      experimental.push(manifest.id);
      assert.equal(manifest.conformance.status, 'passed');
      assert.notEqual(manifest.upstream.commit, 'UNPINNED');
      assert.match(manifest.upstream.checksum, /^sha256:[a-f0-9]{64}$/);
      assert.equal(manifest.licenseReview.status, 'reviewed');
    } else {
      assert.equal(manifest.conformance.status, 'not-run');
    }
    assert.equal(fixture.adapterId, manifest.id);
    assert.equal(fixture.contract, manifest.contract);
    const kinds = new Set(fixture.cases.map((item) => item.kind));
    for (const required of ['health', 'capabilities', 'permission-denied', 'malformed-output']) assert.ok(kinds.has(required), `${manifest.id} missing ${required}`);
  }
  assert.deepEqual(experimental, ['adapter:tool:ecc']);
});
