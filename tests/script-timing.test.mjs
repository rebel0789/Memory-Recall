import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { peakRssMb } from '../scripts/timing.mjs';

test('platform time RSS parser handles macOS and Linux output', () => {
  assert.equal(peakRssMb('104857600 maximum resident set size'), 100);
  assert.equal(peakRssMb('Maximum resident set size (kbytes): 204800'), 200);
  assert.equal(peakRssMb(''), 0);
});

test('repository check ignores Cargo build output directories', () => {
  const checkScript = readFileSync(new URL('../scripts/check.mjs', import.meta.url), 'utf8');
  assert.match(checkScript, /ignoredDirectories = new Set\(\[[^\]]*'target'/);
});
