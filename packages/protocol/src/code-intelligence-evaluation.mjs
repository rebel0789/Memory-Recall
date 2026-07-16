import graphSchema from '../schemas/code-intelligence-graph.schema.json' with { type: 'json' };
import reportSchema from '../schemas/code-intelligence-language-report.schema.json' with { type: 'json' };
import truthSchema from '../schemas/code-intelligence-language-truth.schema.json' with { type: 'json' };
import { CODE_INTELLIGENCE_CAPABILITIES } from './code-intelligence-contract.mjs';
import { sha256Hex, stableStringify } from './fingerprint.mjs';
import { validateJsonSchema } from './schema-validator.mjs';

const SYMBOL_NODE_KINDS = new Set([
  'namespace', 'library', 'function', 'method', 'class', 'interface', 'struct', 'enum',
  'trait', 'protocol', 'mixin', 'extension', 'type_alias', 'variable', 'constant',
  'route', 'configuration_resource', 'framework_component', 'execution_process',
  'build_target'
]);
const PRIVATE_PATH = /(?:^|[\s"'(])(?:\/Users\/|\/home\/[A-Za-z0-9._-]+\/|\/private\/|\/var\/folders\/|[A-Za-z]:\\)/u;

export function auditCodeIntelligenceLanguageTruth(truth) {
  const findings = [];
  const validation = validateJsonSchema(truthSchema, truth);
  for (const error of validation.errors) findings.push({ code: 'truth_schema_invalid', path: error.path });
  if (!validation.valid) return findings;

  const ids = new Set();
  const semanticKeys = new Set();
  for (const item of truth.items) {
    if (ids.has(item.id)) findings.push({ code: 'truth_item_id_duplicate', itemId: item.id });
    ids.add(item.id);
    if (semanticKeys.has(item.semanticKey)) findings.push({ code: 'truth_semantic_key_duplicate', itemId: item.id });
    semanticKeys.add(item.semanticKey);
  }
  if (truth.source.class === 'fixture' && !truth.source.ref.startsWith('fixture://')) {
    findings.push({ code: 'truth_source_class_mismatch' });
  }
  if (truth.source.class === 'real-repo' && !truth.source.ref.startsWith('corpus://')) {
    findings.push({ code: 'truth_source_class_mismatch' });
  }
  for (const [capability, claim] of Object.entries(truth.capabilityClaims)) {
    if (claim === 'full' && truth.source.class !== 'real-repo') {
      findings.push({ code: 'truth_full_claim_requires_real_repository', capability });
    }
    if (claim === 'full' && coverageForCapability(truth.reviewCoverage, capability) !== 'exhaustive') {
      findings.push({ code: 'truth_full_claim_requires_exhaustive_review', capability });
    }
  }
  if (truth.truthFingerprint !== truthFingerprint(truth)) findings.push({ code: 'truth_fingerprint_mismatch' });
  return findings;
}

export function evaluateCodeIntelligenceLanguage({ truth, graphRuns } = {}) {
  const truthFindings = auditCodeIntelligenceLanguageTruth(truth);
  if (truthFindings.length > 0) {
    const error = new Error('code_intelligence_truth_invalid');
    error.code = 'code_intelligence_truth_invalid';
    error.findings = truthFindings;
    throw error;
  }
  if (!Array.isArray(graphRuns) || graphRuns.length < 2 || graphRuns.length > 10) {
    throw new Error('code_intelligence_graph_runs_invalid');
  }
  for (const graph of graphRuns) {
    if (!validateJsonSchema(graphSchema, graph).valid) throw new Error('code_intelligence_graph_run_invalid');
    if (graph.repository.workspaceId !== graphRuns[0].repository.workspaceId) {
      throw new Error('code_intelligence_graph_workspace_mismatch');
    }
  }
  const graph = graphRuns[0];
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const outcomes = truth.items.map((item) => {
    const present = truthItemPresent(item, graph, nodeById);
    return {
      item,
      present,
      matched: item.expectation === 'present' ? present : !present
    };
  });
  const fingerprints = graphRuns.map((item) => item.graphFingerprint);
  const deterministic = new Set(fingerprints).size === 1;
  const duplicateCanonicalSymbolCount = duplicateCanonicalSymbols(graph.nodes);
  const parseFailureCount = graph.diagnostics.filter((item) => item.code === 'parse_failed' || item.severity === 'error').length;
  const failures = [];
  if (!deterministic) failures.push({ code: 'graph_fingerprint_nondeterministic' });
  if (duplicateCanonicalSymbolCount > 0) failures.push({ code: 'duplicate_canonical_symbol' });
  if (parseFailureCount > 0) failures.push({ code: 'repository_parse_failure' });
  for (const outcome of outcomes.filter((item) => !item.matched)) {
    failures.push({
      code: 'truth_expectation_mismatch',
      itemId: outcome.item.id,
      capability: outcome.item.capability
    });
  }

  const declarationItems = outcomes.filter((item) => item.item.recordKind === 'node' && item.item.expectation === 'present');
  const relationshipItems = outcomes.filter((item) => item.item.recordKind === 'edge' && item.item.kind !== 'calls' && item.item.expectation === 'present');
  const callItems = outcomes.filter((item) => item.item.recordKind === 'edge' && item.item.kind === 'calls');
  const callTruePositiveCount = callItems.filter((item) => item.item.expectation === 'present' && item.present).length;
  const callFalsePositiveCount = callItems.filter((item) => item.item.expectation === 'absent' && item.present).length;
  const metrics = {
    declarationRecall: ratio(declarationItems.filter((item) => item.present).length, declarationItems.length),
    relationshipRecall: ratio(relationshipItems.filter((item) => item.present).length, relationshipItems.length),
    reviewedCallPrecision: ratio(callTruePositiveCount, callTruePositiveCount + callFalsePositiveCount),
    duplicateCanonicalSymbolCount,
    parseFailureCount,
    deterministicGraphFingerprint: deterministic,
    truthItemCount: outcomes.length,
    matchedTruthItemCount: outcomes.filter((item) => item.matched).length
  };
  const structural = {
    schemaVersion: '1.0.0',
    reportVersion: 'memory-recall-code-intelligence-language-report-1',
    truthId: truth.id,
    language: truth.language,
    sourceRef: truth.source.ref,
    graphFingerprints: fingerprints,
    reviewCoverage: truth.reviewCoverage,
    metrics,
    capabilities: CODE_INTELLIGENCE_CAPABILITIES.map((id) => capabilityResult({ id, truth, outcomes })),
    failures,
    gateDecision: failures.length === 0 ? 'pass' : 'fail',
    claims: {
      accuracyFloorMet: false,
      parity: false,
      leadership: false
    },
    safeguards: {
      rawSourceStored: false,
      absolutePathsStored: false,
      environmentVariablesStored: false,
      networkCalls: 0,
      modelCalls: 0,
      canonicalMemoryWrites: 0,
      workspaceWrites: 0
    }
  };
  const report = Object.freeze({
    ...structural,
    reportFingerprint: fingerprint(structural)
  });
  if (!validateJsonSchema(reportSchema, report).valid || PRIVATE_PATH.test(JSON.stringify(report))) {
    throw new Error('code_intelligence_language_report_invalid');
  }
  return report;
}

export function truthFingerprint(truth) {
  const { truthFingerprint: _truthFingerprint, ...structural } = truth;
  return fingerprint(structural);
}

function truthItemPresent(item, graph, nodeById) {
  if (item.recordKind === 'node') return graph.nodes.some((node) => nodeMatches(item, node));
  if (item.recordKind === 'diagnostic') {
    return graph.diagnostics.some((diagnostic) => diagnostic.code === item.code && diagnostic.locator === item.locator);
  }
  return graph.edges.some((edge) => {
    const from = nodeById.get(edge.fromNodeId);
    const to = nodeById.get(edge.toNodeId);
    return edge.kind === item.kind
      && from && nodeMatches(item.from, from)
      && to && nodeMatches(item.to, to)
      && edge.evidence.locator === item.locator
      && (item.resolution === undefined || edge.resolution === item.resolution);
  });
}

function nodeMatches(selector, node) {
  return node.kind === selector.kind
    && node.name === selector.name
    && node.locator === selector.locator
    && (selector.qualifiedName === undefined || node.qualifiedName === selector.qualifiedName);
}

function duplicateCanonicalSymbols(nodes) {
  const counts = new Map();
  for (const node of nodes.filter((item) => SYMBOL_NODE_KINDS.has(item.kind))) {
    const key = `${node.language}|${node.kind}|${node.qualifiedName}|${node.locator}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
}

function ratio(numerator, denominator) {
  return Object.freeze({
    numerator,
    denominator,
    value: denominator === 0 ? null : Number((numerator / denominator).toFixed(6))
  });
}

function capabilityResult({ id, truth, outcomes }) {
  const relevant = outcomes.filter((item) => item.item.capability === id);
  const matchedItemCount = relevant.filter((item) => item.matched).length;
  const coverage = coverageForCapability(truth.reviewCoverage, id);
  const benchmarkStatus = coverage === 'not-applicable'
    ? 'not-applicable'
    : relevant.some((item) => !item.matched)
      ? 'does-not-meet-floor'
      : 'unmeasured';
  return Object.freeze({
    id,
    claim: truth.capabilityClaims[id],
    benchmarkStatus,
    itemCount: relevant.length,
    matchedItemCount
  });
}

function coverageForCapability(reviewCoverage, capability) {
  if (capability === 'calls') return reviewCoverage.calls;
  if (capability === 'parse' || capability === 'structure') return reviewCoverage.declarations;
  return reviewCoverage.relationships;
}

function fingerprint(value) {
  return `sha256:${sha256Hex(stableStringify(value))}`;
}
