import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canonicalAgentPackJson, fingerprintAgentPack, resolveAgentPack, validateAgentPack } from '../packages/agentpack/src/index.mjs';

const fixture = JSON.parse(await readFile(new URL('../examples/agentpacks/content-intelligence.agentpack.json', import.meta.url), 'utf8'));

test('Agent Pack validates and fingerprints deterministically', () => {
  const validated = validateAgentPack(fixture);
  const reordered = Object.fromEntries(Object.entries(fixture).reverse());
  assert.equal(fingerprintAgentPack(validated), fingerprintAgentPack(reordered));
  assert.match(fingerprintAgentPack(validated), /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.parse(canonicalAgentPackJson(validated)).kind, 'AgentPack');
});

test('Agent Pack rejects credentials and unrecorded context', () => {
  const withSecret = structuredClone(fixture);
  withSecret.models.analyst.apiKey = 'not-a-real-key';
  assert.throws(() => validateAgentPack(withSecret), /credentials/);
  const withoutManifest = structuredClone(fixture);
  withoutManifest.context.recordManifest = false;
  assert.throws(() => validateAgentPack(withoutManifest), /recordManifest/);
});

test('Agent Pack resolution reports missing references without granting authority', () => {
  const result = resolveAgentPack(fixture, {
    capabilities: ['artifact.put', 'memory.search.lexical'],
    skills: ['skill:content-research@1.0.0'],
    workflows: ['workflow:content-intelligence@1.0.0'],
    evaluations: ['eval:context-selection@1.0.0']
  });
  assert.equal(result.ready, false);
  assert.equal(result.authorityGranted, false);
  assert.deepEqual(result.missing.capabilities, ['model.generate.synthetic']);
  assert.deepEqual(result.missing.skills.map((reference) => reference.id), ['skill:source-verification']);
});
