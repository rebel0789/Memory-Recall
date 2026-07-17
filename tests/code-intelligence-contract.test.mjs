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
  assert.equal(matrix.languages.every((item) => item.benchmarkStatus !== 'meets-floor'), true);
});

test('matrix audit rejects unsupported full claims without fixture and real-repo evidence', async () => {
  const invalid = await readJson('examples/protocol/compatibility/invalid/code-intelligence-capability-matrix-false-full.json');
  const findings = await auditCodeIntelligenceCapabilityMatrix(invalid, { root: new URL('..', import.meta.url) });

  assert.equal(findings.some((item) => item.code === 'full_claim_missing_fixture_evidence'), true);
  assert.equal(findings.some((item) => item.code === 'full_claim_missing_real_repo_evidence'), true);
});

test('benchmark corpus has three pinned real repositories per Tier 1 language', async () => {
  const corpus = await readJson('evals/code-intelligence/corpus.v1.json');
  for (const language of CODE_INTELLIGENCE_TIER_1_LANGUAGES) {
    const repos = corpus.repositories.filter((item) => item.primaryLanguage === language);
    assert.equal(repos.length, 3, language);
    assert.equal(repos.every((item) => /^[a-f0-9]{40}$/.test(item.commit)), true, language);
    assert.equal(new Set(repos.map((item) => item.url)).size, 3, language);
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

test('Phase 0 baseline separates public, experimental, and unmeasured evidence', async () => {
  const report = await readJson('evals/code-intelligence/results/phase0-baseline.json');

  assert.equal(report.phase, 0);
  assert.equal(report.publicEngine.languageIds.join(','), 'javascript,typescript');
  assert.equal(report.experimentalEngine.languageIds.includes('python'), true);
  assert.equal(report.competitors.gitnexus.status, 'unmeasured');
  assert.equal(report.competitors.codebaseMemoryMcp.status, 'unmeasured');
  assert.equal(report.claims.parity, false);
  assert.equal(report.claims.leadership, false);
  assert.equal(report.commands.every((item) => item.exitCode === 0), true);
  assert.equal(report.checkout.dirtyBeforeBaseline, false);
  assert.match(report.checkout.commit, /^[a-f0-9]{40}$/);
  assert.equal(report.safeguards.rawCommandOutputStored, false);
  assert.equal(report.safeguards.absoluteRepositoryRootStored, false);
});

test('Phase 1 compatibility evidence is reproducible and does not claim parity', async () => {
  const report = await readJson('evals/code-intelligence/results/phase1-js-ts-compatibility.json');

  assert.equal(report.phase, 1);
  assert.equal(report.gateDecision, 'pass');
  assert.equal(report.cases.length, 4);
  assert.equal(report.cases.filter((item) => item.sourceClass === 'real-repo').length, 2);
  assert.equal(report.cases.every((item) => item.deterministic === true), true);
  assert.equal(report.cases.every((item) => item.compatibility.parityClaimed === false), true);
  for (const item of report.cases) {
    assert.equal(item.compatibility.comparisonVersion, 'memory-recall-js-ts-native-preview-2');
    for (const dimension of item.compatibility.dimensions) {
      assert.equal(dimension.baselineOnlyCount, dimension.baselineCount - dimension.matchedCount);
      assert.equal(dimension.nativeOnlyCount, dimension.nativeCount - dimension.matchedCount);
      const maximumCount = Math.max(dimension.baselineCount, dimension.nativeCount);
      const expectedAgreement = maximumCount
        ? Number((dimension.matchedCount / maximumCount).toFixed(4))
        : 1;
      assert.equal(dimension.nativeAgreement, expectedAgreement);
      for (const sample of [dimension.baselineOnlySample, dimension.nativeOnlySample]) {
        assert.equal(sample.length <= 10, true);
        assert.deepEqual(sample, [...sample].sort());
        for (const key of sample) {
          assert.doesNotMatch(key, /(?:^|[|>])(?:\/(?!\/)|[A-Za-z]:\\)/u);
          assert.doesNotMatch(key, /#L[0-9]+-L[0-9]+/u);
        }
      }
    }
  }
  assert.equal(report.failures.length, 0);
  assert.equal(report.claims.parity, false);
  assert.equal(report.claims.leadership, false);
  assert.equal(report.publicDefault.engine, 'js');
  assert.equal(report.publicDefault.changed, false);
  assert.equal(report.safeguards.rawSourceStored, false);
  assert.equal(report.safeguards.absoluteCheckoutPathsStored, false);
  assert.equal(report.safeguards.environmentVariablesStored, false);
  assert.doesNotMatch(JSON.stringify(report), /\/Users\/|\/private\/|\/var\/folders\//u);
});
