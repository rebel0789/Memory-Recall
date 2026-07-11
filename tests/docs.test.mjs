import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { auditPublicCopyEntries } from '../scripts/public-copy-audit.mjs';

test('public benchmark documentation makes each claim reproducible', async () => {
  const page = await readFile('docs/benchmarks.md', 'utf8');
  for (const heading of ['Dataset', 'Baseline', 'Command', 'Result artifact', 'Pass condition', 'Limitations']) {
    assert.match(page, new RegExp(`## ${heading}`));
  }
});

test('support matrix distinguishes implemented experimental and unsupported surfaces', async () => {
  const matrix = await readFile('docs/usage/support-matrix.md', 'utf8');
  assert.match(matrix, /Implemented/);
  assert.match(matrix, /Experimental/);
  assert.match(matrix, /Unsupported/);
});

test('public-copy audit does not let another file bless an unlinked oaf URI', () => {
  const errors = auditPublicCopyEntries([
    {
      entries: [
        { relative: 'apps/web/app.js', text: "const command = 'oaf://workspace/ws_local/status';" },
        { relative: 'apps/web/index.html', text: 'See [OAF compatibility](oaf-compatibility.md).' }
      ]
    }
  ]);
  assert.deepEqual(errors, ['apps/web/app.js: oaf:// appears in public copy without a nearby compatibility link']);
});

test('public-copy audit accepts app command URIs only with their rendered compatibility note', async () => {
  const app = await readFile('apps/web/app.js', 'utf8');
  const errors = auditPublicCopyEntries([{ entries: [{ relative: 'apps/web/app.js', text: app }] }]);
  assert.deepEqual(errors, []);
});

test('README describes bench realqa as checkout-derived structured-ingest sufficiency', async () => {
  const readme = await readFile('README.md', 'utf8');
  assert.match(readme, /checkout-derived structured-ingest sufficiency/);
  assert.doesNotMatch(readme, /real repo question answering/i);
});
