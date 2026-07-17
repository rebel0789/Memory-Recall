import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateJsonSchema } from '../packages/protocol/src/schema-validator.mjs';
import {
  auditCodeIntelligenceLanguageTruth,
  evaluateCodeIntelligenceLanguage,
  truthFingerprint
} from '../packages/protocol/src/code-intelligence-evaluation.mjs';

const readJson = async (file) => JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));

test('language truth and report examples validate against closed schemas', async () => {
  const truthSchema = await readJson('packages/protocol/schemas/code-intelligence-language-truth.schema.json');
  const reportSchema = await readJson('packages/protocol/schemas/code-intelligence-language-report.schema.json');
  const truth = await readJson('examples/protocol/code-intelligence-language-truth.json');
  const report = await readJson('examples/protocol/code-intelligence-language-report.json');

  assert.equal(validateJsonSchema(truthSchema, truth).valid, true);
  assert.equal(validateJsonSchema(reportSchema, report).valid, true);
});

test('truth audit rejects duplicate semantic keys and non-repository full claims', async () => {
  const truth = await readJson('examples/protocol/code-intelligence-language-truth.json');
  const duplicate = {
    ...truth,
    items: [...truth.items, { ...truth.items[0], id: 'cititem_duplicate' }]
  };
  const duplicateFindings = auditCodeIntelligenceLanguageTruth(duplicate);
  assert(duplicateFindings.some((item) => item.code === 'truth_semantic_key_duplicate'));

  const falseFull = {
    ...truth,
    capabilityClaims: { ...truth.capabilityClaims, structure: 'full' }
  };
  const fullFindings = auditCodeIntelligenceLanguageTruth(falseFull);
  assert(fullFindings.some((item) => item.code === 'truth_full_claim_requires_real_repository'));
});

test('semantic compatibility fixtures fail the truth audit even when structurally valid', async () => {
  const truthSchema = await readJson('packages/protocol/schemas/code-intelligence-language-truth.schema.json');
  const duplicate = await readJson('examples/protocol/compatibility/invalid/code-intelligence-language-truth-duplicate-id.json');
  const unsupportedFull = await readJson('examples/protocol/compatibility/invalid/code-intelligence-language-truth-unsupported-full.json');

  assert.equal(validateJsonSchema(truthSchema, duplicate).valid, true);
  assert.equal(validateJsonSchema(truthSchema, unsupportedFull).valid, true);
  assert(auditCodeIntelligenceLanguageTruth(duplicate).some((item) => item.code === 'truth_item_id_duplicate'));
  assert(auditCodeIntelligenceLanguageTruth(unsupportedFull).some((item) => item.code === 'truth_full_claim_requires_real_repository'));
});

test('Python configuration claims require a resource and an exact causal edge', async () => {
  const source = await readJson('examples/protocol/code-intelligence-language-truth.json');
  const finalize = (truth) => ({ ...truth, truthFingerprint: truthFingerprint(truth) });
  const unsupported = finalize({
    ...source,
    language: 'python',
    capabilityClaims: { ...source.capabilityClaims, config: 'partial' }
  });
  const unsupportedFindings = auditCodeIntelligenceLanguageTruth(unsupported);
  assert(unsupportedFindings.some((item) => item.code === 'python_config_claim_missing_configuration_resource'));
  assert(unsupportedFindings.some((item) => item.code === 'python_config_claim_missing_exact_causal_edge'));

  const arbitrary = finalize({
    ...unsupported,
    items: unsupported.items.map((item, index) => index === 0 ? { ...item, capability: 'config' } : item)
  });
  assert(auditCodeIntelligenceLanguageTruth(arbitrary).some((item) => item.code === 'python_config_truth_item_kind_invalid'));

  const relabeledImport = finalize({
    ...unsupported,
    items: [
      ...unsupported.items,
      {
        id: 'cititem_python_unrelated_config_import',
        semanticKey: 'edge:imports:unrelated-config-import',
        capability: 'config',
        expectation: 'present',
        recordKind: 'edge',
        kind: 'imports',
        from: { kind: 'module', name: 'consumer', locator: 'workspace://consumer.py#L1-L2' },
        to: { kind: 'module', name: 'service', locator: 'workspace://service.py#L1-L2' },
        locator: 'workspace://consumer.py#L1-L1',
        resolution: 'exact'
      }
    ]
  });
  assert(auditCodeIntelligenceLanguageTruth(relabeledImport).some((item) => item.code === 'python_config_truth_item_kind_invalid'));

  const resource = {
    id: 'cititem_python_project_config',
    semanticKey: 'node:configuration-resource:pyproject:demo-app',
    capability: 'config',
    expectation: 'present',
    recordKind: 'node',
    kind: 'configuration_resource',
    name: 'demo_app',
    qualifiedName: 'pyproject.toml::demo_app',
    locator: 'workspace://pyproject.toml#L2-L2'
  };
  const dependency = {
    id: 'cititem_python_project_config_dependency',
    semanticKey: 'edge:depends-on:pyproject:demo-app',
    capability: 'config',
    expectation: 'present',
    recordKind: 'edge',
    kind: 'depends_on',
    from: {
      kind: 'configuration_resource',
      name: 'demo_app',
      qualifiedName: 'pyproject.toml::demo_app',
      locator: 'workspace://pyproject.toml#L2-L2'
    },
    to: {
      kind: 'package',
      name: 'demo_app',
      qualifiedName: 'pyproject.toml::demo_app',
      locator: 'workspace://pyproject.toml#L2-L2'
    },
    locator: 'workspace://pyproject.toml#L2-L2',
    resolution: 'exact'
  };
  const valid = finalize({ ...unsupported, items: [...unsupported.items, resource, dependency] });
  assert.deepEqual(auditCodeIntelligenceLanguageTruth(valid), []);
});

test('language evaluation records exact counts, determinism, and zero-sized samples', async () => {
  const truth = await readJson('examples/protocol/code-intelligence-language-truth.json');
  const graph = await readJson('examples/protocol/code-intelligence-graph.json');
  const report = evaluateCodeIntelligenceLanguage({ truth, graphRuns: [graph, graph] });

  assert.equal(report.gateDecision, 'pass');
  assert.equal(report.metrics.declarationRecall.numerator, 1);
  assert.equal(report.metrics.declarationRecall.denominator, 1);
  assert.equal(report.metrics.declarationRecall.value, 1);
  assert.equal(report.metrics.relationshipRecall.numerator, 1);
  assert.equal(report.metrics.relationshipRecall.denominator, 1);
  assert.equal(report.metrics.reviewedCallPrecision.denominator, 0);
  assert.equal(report.metrics.reviewedCallPrecision.value, null);
  assert.equal(report.metrics.duplicateCanonicalSymbolCount, 0);
  assert.equal(report.metrics.parseFailureCount, 0);
  assert.equal(report.metrics.deterministicGraphFingerprint, true);
  assert.equal(report.claims.accuracyFloorMet, false);
  assert.equal(report.safeguards.rawSourceStored, false);
  assert.equal(report.safeguards.absolutePathsStored, false);
  assert.doesNotMatch(JSON.stringify(report), /\/Users\/|\/private\/|sourceBody|sourceText/u);
});

test('language evaluation fails closed for unsafe truth and non-deterministic runs', async () => {
  const truth = await readJson('examples/protocol/code-intelligence-language-truth.json');
  const graph = await readJson('examples/protocol/code-intelligence-graph.json');
  const unsafe = {
    ...truth,
    items: truth.items.map((item, index) => index === 0 ? { ...item, locator: '/Users/example/private.ts' } : item)
  };
  assert.throws(
    () => evaluateCodeIntelligenceLanguage({ truth: unsafe, graphRuns: [graph, graph] }),
    /code_intelligence_truth_invalid/u
  );

  const changed = { ...graph, graphFingerprint: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' };
  const report = evaluateCodeIntelligenceLanguage({ truth, graphRuns: [graph, changed] });
  assert.equal(report.gateDecision, 'fail');
  assert.equal(report.metrics.deterministicGraphFingerprint, false);
  assert(report.failures.some((item) => item.code === 'graph_fingerprint_nondeterministic'));
});
