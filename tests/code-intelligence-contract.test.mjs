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

test('native code intelligence engine request and response contracts are closed and bounded', async () => {
  const requestSchema = await readJson('packages/protocol/schemas/code-intelligence-engine-request.schema.json');
  const responseSchema = await readJson('packages/protocol/schemas/code-intelligence-engine-response.schema.json');
  const request = await readJson('examples/protocol/code-intelligence-engine-request.json');
  const response = await readJson('examples/protocol/code-intelligence-engine-response.json');

  assert.equal(validateJsonSchema(requestSchema, request).valid, true);
  assert.equal(validateJsonSchema(responseSchema, response).valid, true);

  for (const invalid of [
    { ...request, protocolVersion: '2.0.0' },
    { ...request, root: '/private/tmp/repository' },
    { ...request, root: '../repository' },
    { ...request, arguments: { ...request.arguments, maxFiles: 100_001 } },
    { ...request, sourceBody: 'export const secret = true;' }
  ]) {
    assert.equal(validateJsonSchema(requestSchema, invalid).valid, false);
  }

  const failure = {
    protocolVersion: '1.0.0',
    requestId: request.requestId,
    ok: false,
    error: {
      code: 'engine_invalid_request',
      retryable: false,
      details: ['request failed']
    }
  };
  assert.equal(validateJsonSchema(responseSchema, failure).valid, true);
  assert.equal(validateJsonSchema(responseSchema, {
    ...failure,
    error: { ...failure.error, rawError: 'read /Users/example/private.ts' }
  }).valid, false);
  assert.equal(validateJsonSchema(responseSchema, {
    ...failure,
    error: { ...failure.error, details: ['/Users/example/private.ts'] }
  }).valid, false);
});

test('native engine compatibility fixtures reject roots and raw errors', async () => {
  const requestSchema = await readJson('packages/protocol/schemas/code-intelligence-engine-request.schema.json');
  const responseSchema = await readJson('packages/protocol/schemas/code-intelligence-engine-response.schema.json');

  assert.equal(validateJsonSchema(
    requestSchema,
    await readJson('examples/protocol/compatibility/invalid/code-intelligence-engine-request-absolute-root.json')
  ).valid, false);
  assert.equal(validateJsonSchema(
    responseSchema,
    await readJson('examples/protocol/compatibility/invalid/code-intelligence-engine-response-raw-error.json')
  ).valid, false);
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
  const tier1 = matrix.languages.filter((item) => item.tier === 1);
  assert.deepEqual(tier1.filter((item) => item.benchmarkStatus === 'meets-floor'), []);
  assert.equal(tier1.every((item) => Object.values(item.capabilities).every((capability) => (
    ['applicable', 'not-applicable'].includes(capability.applicability)
    && typeof capability.applicabilityRationale === 'string'
    && capability.applicabilityRationale.length > 0
  ))), true);
  const notApplicable = tier1.flatMap((item) => Object.entries(item.capabilities)
    .filter(([, capability]) => capability.applicability === 'not-applicable')
    .map(([capability]) => `${item.id}:${capability}`));
  assert.deepEqual(notApplicable, ['c:heritage']);
});

test('matrix audit rejects unsupported full claims without fixture and real-repo evidence', async () => {
  const invalid = await readJson('examples/protocol/compatibility/invalid/code-intelligence-capability-matrix-false-full.json');
  const findings = await auditCodeIntelligenceCapabilityMatrix(invalid, { root: new URL('..', import.meta.url) });

  assert.equal(findings.some((item) => item.code === 'full_claim_missing_fixture_evidence'), true);
  assert.equal(findings.some((item) => item.code === 'full_claim_missing_real_repo_evidence'), true);
});

test('benchmark corpus has at least three pinned real repositories per Tier 1 language', async () => {
  const corpus = await readJson('evals/code-intelligence/corpus.v1.json');
  assert.equal(corpus.repositories.length, 43);
  for (const language of CODE_INTELLIGENCE_TIER_1_LANGUAGES) {
    const repos = corpus.repositories.filter((item) => item.primaryLanguage === language);
    assert.equal(repos.length >= 3, true, language);
    assert.equal(repos.every((item) => /^[a-f0-9]{40}$/.test(item.commit)), true, language);
    assert.equal(new Set(repos.map((item) => item.url)).size, repos.length, language);
  }
});

test('benchmark gates preserve the approved accuracy floors', async () => {
  const gates = await readJson('evals/code-intelligence/benchmark-gates.v1.json');

  assert.equal(gates.languageFull.symbolRecallMinimum, 0.95);
  assert.equal(gates.languageFull.resolvedCallPrecisionMinimum, 0.90);
  assert.equal(gates.languageFull.duplicateCanonicalSymbolMaximum, 0);
  assert.equal(gates.claims.parityRequiresAllTier1Languages, true);
  assert.equal(gates.claims.leadershipRequiresRelevantCompetitorWin, true);
});
