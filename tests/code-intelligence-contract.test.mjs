import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateJsonSchema } from '../packages/protocol/src/schema-validator.mjs';
import {
  CODE_INTELLIGENCE_CAPABILITIES,
  CODE_INTELLIGENCE_TIER_1_LANGUAGES,
  auditCodeIntelligenceCapabilityMatrix
} from '../packages/protocol/src/code-intelligence-contract.mjs';

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

test('capability matrix covers every Tier 1 language and capability honestly', async () => {
  const matrix = await readJson('evals/code-intelligence/capability-matrix.v1.json');

  assert.deepEqual(
    matrix.languages.filter((item) => item.tier === 1).map((item) => item.id).sort(),
    [...CODE_INTELLIGENCE_TIER_1_LANGUAGES].sort()
  );
  assert.equal(
    matrix.languages.every((item) => CODE_INTELLIGENCE_CAPABILITIES.every((capability) => Object.hasOwn(item.capabilities, capability))),
    true
  );
  assert.deepEqual(await auditCodeIntelligenceCapabilityMatrix(matrix, { root: new URL('..', import.meta.url) }), []);
  assert.equal(matrix.languages.every((item) => item.benchmarkStatus !== 'meets-floor'), true);
});

test('matrix audit rejects unsupported full claims without fixture and real-repo evidence', async () => {
  const invalid = await readJson('examples/protocol/compatibility/invalid/code-intelligence-capability-matrix-false-full.json');
  const findings = await auditCodeIntelligenceCapabilityMatrix(invalid, { root: new URL('..', import.meta.url) });

  assert.equal(findings.some((item) => item.code === 'full_claim_missing_fixture_evidence'), true);
  assert.equal(findings.some((item) => item.code === 'full_claim_missing_real_repo_evidence'), true);
});
