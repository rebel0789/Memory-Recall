import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateJsonSchema } from '../packages/protocol/src/schema-validator.mjs';
import {
  normalizeSourceGraphWorkspaceLocator,
  SOURCE_GRAPH_SAFE_LABEL_PATTERN,
  SOURCE_GRAPH_SAFE_LABEL_RE,
  SOURCE_GRAPH_FINGERPRINT_PATTERN,
  SOURCE_GRAPH_WORKSPACE_ID_PATTERN,
  SOURCE_GRAPH_WORKSPACE_LOCATOR_PATTERN,
  SOURCE_GRAPH_WORKSPACE_LOCATOR_RE
} from '../packages/protocol/src/source-graph-locator.mjs';
import previewSchema from '../packages/protocol/schemas/source-graph-preview.schema.json' with { type: 'json' };
import sourceGraphSchema from '../packages/protocol/schemas/source-graph.schema.json' with { type: 'json' };
import { buildSourceGraphPreview } from '../packages/source-graph/src/index.mjs';
import {
  buildJsTsSourceGraph,
  mapSourceGraphDiffImpact,
  rankArchitectureNodes,
  searchSourceGraph,
  traceSourceGraph
} from '../providers/native/context-candidate-ast-code/src/index.mjs';

const FIXED_NOW = '2026-07-10T00:00:00.000Z';
const SOURCE_BODY_SENTINEL = 'RECALL_MAP_RANKING_RAW_SOURCE_SENTINEL';
const rankingEval = JSON.parse(await readFile('evals/recall-map/architecture-ranking.v1.json', 'utf8'));

async function fixtureWorkspace(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-architecture-ranking-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [relativePath, body] of Object.entries(files)) {
    const filename = path.join(root, relativePath);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, body);
  }
  return root;
}

function caseById(id) {
  const item = rankingEval.cases.find((candidate) => candidate.id === id);
  assert.ok(item, `missing architecture ranking eval case ${id}`);
  return item;
}

function indexOfLabel(items, label) {
  return items.findIndex((item) => item.label === label);
}

test('architecture ranking promotes exported entry points above generic, private, and test-only symbols', async (t) => {
  const expectation = caseById('exported-entry-points-over-generic-helpers');
  const root = await fixtureWorkspace(t, {
    'app/api/health/route.ts': [
      "import { startServer } from '../../../src/server.js';",
      'export async function GET() {',
      '  return startServer();',
      '}'
    ].join('\n'),
    'src/server.ts': [
      "import { assertPlainObject } from './assert.js';",
      'export async function startServer() {',
      '  return assertPlainObject({ ready: true });',
      '}',
      'export function serviceOne() { return assertPlainObject({ one: true }); }',
      'export function serviceTwo() { return assertPlainObject({ two: true }); }'
    ].join('\n'),
    'src/assert.ts': [
      'export function assert(value) { return value; }',
      'export function assertPlainObject(value) {',
      '  return value;',
      '}',
      'export class InternalController {',
      "  #privateMethod() { return byteLength('x'); }",
      '}',
      'function byteLength(value) { return value.length; }'
    ].join('\n'),
    'test/server.test.ts': [
      'export function testOnlyProbe() { return byteLength(); }',
      'export function byteLength() { return 0; }'
    ].join('\n')
  });
  const graph = await buildJsTsSourceGraph({ root, clock: () => FIXED_NOW });
  const ranking = rankArchitectureNodes(graph, { query: 'where should I start', limit: 20 });
  const preview = await buildSourceGraphPreview({ root, query: 'where should I start', clock: () => FIXED_NOW });

  assert.equal(validateJsonSchema(sourceGraphSchema, graph).valid, true);
  assert.equal(validateJsonSchema(previewSchema, preview).valid, true);
  assert.deepEqual(ranking.entryPoints.slice(0, 2).map((item) => item.label), expectation.expectedTopEntryPoints);
  for (const label of expectation.mustDeprioritize) {
    const diagnostic = ranking.deprioritized.find((item) => item.label === label);
    assert.ok(diagnostic, `${label} must have a bounded deprioritization diagnostic`);
    assert.ok(diagnostic.reasonCodes.some((code) => code.endsWith('_penalty')));
  }
  const hotspots = preview.graph.summary.hotspots;
  for (const label of ['assertPlainObject', '#privateMethod', 'byteLength', 'testOnlyProbe']) {
    const startIndex = indexOfLabel(hotspots, 'startServer');
    const candidateIndex = indexOfLabel(hotspots, label);
    if (candidateIndex !== -1) assert.ok(startIndex !== -1 && startIndex < candidateIndex, `${label} must not outrank startServer`);
  }
  assert.equal(JSON.stringify(preview).includes(SOURCE_BODY_SENTINEL), false);
  assert.equal(JSON.stringify(preview).includes(root), false);
});

test('architecture ranking uses changed source membership deterministically', async (t) => {
  const expectation = caseById('changed-source-promotes-otherwise-equal-entry');
  const root = await fixtureWorkspace(t, {
    'src/base.ts': 'export function baseEntry() { return true; }\n',
    'src/changed.ts': 'export function changedEntry() { return true; }\n'
  });
  const graph = await buildJsTsSourceGraph({ root, clock: () => FIXED_NOW });
  const first = rankArchitectureNodes(graph, { changedLocators: [expectation.changedLocator], limit: 20 });
  const second = rankArchitectureNodes(graph, { changedLocators: [expectation.changedLocator], limit: 20 });
  const preview = await buildSourceGraphPreview({
    root,
    changedLocators: [expectation.changedLocator],
    clock: () => FIXED_NOW
  });

  assert.deepEqual(first, second);
  assert.equal(first.entryPoints[0].label, expectation.expectedTopEntryPoint);
  assert.equal(preview.graph.summary.entryPoints[0].label, expectation.expectedTopEntryPoint);
  assert.ok(preview.graph.summary.entryPoints[0].reasonCodes.includes('changed_locator'));
});

test('source graph coverage reports represented, unsupported, oversized, and capped static scope without source bodies', async (t) => {
  const expectation = caseById('coverage-is-partial-when-static-js-ts-scope-is-incomplete');
  const root = await fixtureWorkspace(t, {
    'legacy/worker.py': 'def worker():\n    return "unsupported"\n',
    'src/large.ts': `export const oversized = '${SOURCE_BODY_SENTINEL.repeat(200)}';\n`,
    'src/main.ts': 'export function representedEntry() { return true; }\n',
    'src/second.ts': 'export function secondEntry() { return true; }\n'
  });
  const oversized = await buildSourceGraphPreview({ root, maxFileBytes: 1024, maxFiles: 10, clock: () => FIXED_NOW });
  const capped = await buildSourceGraphPreview({ root, maxFileBytes: 1024 * 1024, maxFiles: 1, clock: () => FIXED_NOW });

  assert.equal(validateJsonSchema(previewSchema, oversized).valid, true);
  assert.equal(oversized.graph.summary.coverage.status, 'partial');
  assert.ok(oversized.graph.summary.coverage.representedJsTsLocators.includes('workspace://src/main.ts'));
  assert.ok(oversized.graph.summary.coverage.oversizedLocators.includes('workspace://src/large.ts'));
  assert.ok(oversized.graph.summary.coverage.unsupportedExtensions.includes('.py'));
  assert.ok(oversized.graph.summary.coverage.reasonCodes.includes(expectation.expectedReasonCodes[0]));
  assert.ok(oversized.graph.summary.coverage.reasonCodes.includes(expectation.expectedReasonCodes[2]));
  assert.equal(capped.graph.summary.coverage.status, 'partial');
  assert.ok(capped.graph.summary.coverage.reasonCodes.includes(expectation.expectedReasonCodes[1]));
  assert.equal(JSON.stringify(oversized).includes(SOURCE_BODY_SENTINEL), false);
  assert.equal(JSON.stringify(oversized).includes(root), false);
});

test('source graph coverage distinguishes source-relevant exclusions from declared out-of-scope directories', async (t) => {
  const root = await fixtureWorkspace(t, {
    'src/main.ts': 'export const main = true;\n',
    'vendor/legacy.py': 'DIRECTORY_EXCLUSION_RAW_BODY_SENTINEL\n',
    'node_modules/example/index.js': 'export const dependency = true;\n'
  });
  const preview = await buildSourceGraphPreview({ root, clock: () => FIXED_NOW });
  const coverage = preview.graph.summary.coverage;

  assert.equal(validateJsonSchema(previewSchema, preview).valid, true);
  assert.equal(coverage.status, 'partial');
  assert.equal(coverage.excludedDirectoryCount, 2);
  assert.deepEqual(coverage.excludedDirectoryLocators, ['workspace://node_modules', 'workspace://vendor']);
  assert.equal(coverage.sourceRelevantExcludedDirectoryCount, 1);
  assert.deepEqual(coverage.sourceRelevantExcludedDirectoryLocators, ['workspace://vendor']);
  assert.equal(coverage.declaredOutOfScopeDirectoryCount, 1);
  assert.deepEqual(coverage.declaredOutOfScopeDirectoryLocators, ['workspace://node_modules']);
  assert.ok(coverage.reasonCodes.includes('source_relevant_directory_excluded'));
  assert.ok(coverage.reasonCodes.includes('declared_out_of_scope_directory_excluded'));
  assert.ok(preview.graph.diagnostics.some((item) => item.locator === 'workspace://vendor' && item.code === 'source_relevant_directory_excluded'));
  assert.ok(preview.graph.diagnostics.some((item) => item.locator === 'workspace://node_modules' && item.code === 'declared_out_of_scope_directory_excluded'));
  assert.equal(JSON.stringify(preview).includes('DIRECTORY_EXCLUSION_RAW_BODY_SENTINEL'), false);
  assert.equal(JSON.stringify(preview).includes(root), false);
});

test('source graph coverage records exclusions without inventing a file-cap overflow', async (t) => {
  const root = await fixtureWorkspace(t, {
    'src/main.ts': 'export const main = true;\n',
    'vendor/legacy.py': 'POST_CAP_VENDOR_SENTINEL\n'
  });
  const preview = await buildSourceGraphPreview({ root, maxFiles: 1, clock: () => FIXED_NOW });
  const coverage = preview.graph.summary.coverage;

  assert.equal(validateJsonSchema(previewSchema, preview).valid, true);
  assert.equal(coverage.status, 'partial');
  assert.equal(coverage.maxFilesReached, false);
  assert.equal(coverage.sourceRelevantExcludedDirectoryCount, 1);
  assert.deepEqual(coverage.sourceRelevantExcludedDirectoryLocators, ['workspace://vendor']);
  assert.ok(coverage.reasonCodes.includes('source_relevant_directory_excluded'));
  assert.equal(coverage.reasonCodes.includes('max_files_reached'), false);
  assert.ok(preview.graph.diagnostics.some((item) => item.locator === 'workspace://vendor' && item.code === 'source_relevant_directory_excluded'));
  assert.equal(JSON.stringify(preview).includes('POST_CAP_VENDOR_SENTINEL'), false);
  assert.equal(JSON.stringify(preview).includes(root), false);
});

test('source graph coverage keeps excluded-directory evidence bounded while retaining complete counts', async (t) => {
  const files = { 'src/main.ts': 'export const main = true;\n' };
  for (let index = 0; index < 101; index += 1) {
    files[`packages/pkg-${String(index).padStart(3, '0')}/vendor/legacy.py`] = 'EXCLUDED_DIRECTORY_SAMPLE_SENTINEL\n';
  }
  const root = await fixtureWorkspace(t, files);
  const preview = await buildSourceGraphPreview({ root, clock: () => FIXED_NOW });
  const coverage = preview.graph.summary.coverage;
  const exclusionDiagnostics = preview.graph.diagnostics.filter((item) => item.code === 'source_relevant_directory_excluded');

  assert.equal(validateJsonSchema(previewSchema, preview).valid, true);
  assert.equal(coverage.status, 'partial');
  assert.equal(coverage.excludedDirectoryCount, 101);
  assert.equal(coverage.sourceRelevantExcludedDirectoryCount, 101);
  assert.equal(coverage.excludedDirectoryLocators.length, 100);
  assert.equal(coverage.sourceRelevantExcludedDirectoryLocators.length, 100);
  assert.equal(exclusionDiagnostics.length, 100);
  assert.ok(preview.graph.diagnostics.some((item) => item.code === 'excluded_directory_diagnostics_truncated'));
  assert.equal(JSON.stringify(preview).includes('EXCLUDED_DIRECTORY_SAMPLE_SENTINEL'), false);
  assert.equal(JSON.stringify(preview).includes(root), false);
});

test('source graph coverage directory fields are additive within v1', async (t) => {
  const root = await fixtureWorkspace(t, { 'src/main.ts': 'export const main = true;\n' });
  const graph = await buildJsTsSourceGraph({ root, clock: () => FIXED_NOW });
  const preview = await buildSourceGraphPreview({ root, clock: () => FIXED_NOW });
  const legacyGraph = structuredClone(graph);
  const legacyPreview = structuredClone(preview);
  const fields = [
    'excludedDirectoryCount',
    'excludedDirectoryLocators',
    'declaredOutOfScopeDirectoryCount',
    'declaredOutOfScopeDirectoryLocators',
    'sourceRelevantExcludedDirectoryCount',
    'sourceRelevantExcludedDirectoryLocators'
  ];
  for (const field of fields) {
    delete legacyGraph.summary.coverage[field];
    delete legacyPreview.graph.summary.coverage[field];
  }

  assert.equal(validateJsonSchema(sourceGraphSchema, legacyGraph).valid, true);
  assert.equal(validateJsonSchema(previewSchema, legacyPreview).valid, true);
});

test('architecture ranking and search omit protocol-forbidden locators from direct graph input', () => {
  const secret = 'RECALL_MAP_RANKING_LOCATOR_SECRET';
  for (const locator of [
    `workspace://src/server.ts?token=${secret}`,
    'workspace:///Users/rebel/secret.ts#L1-L1',
    'workspace:///private/secret.ts',
    'workspace:///var/folders/x.ts',
    'workspace://src/%252e%252e/REVIEW_SECRET.ts',
    'workspace://src/%25252e%25252e/REVIEW_SECRET.ts',
    'workspace://src/%252fREVIEW_SECRET.ts',
    'workspace://src/%255cREVIEW_SECRET.ts',
    'workspace://file:/etc/passwd#L1-L1',
    'workspace://data:text/plain#L1-L1',
    'workspace://git:repo/path#L1-L1',
    'workspace://src/file:/etc/passwd#L1-L1',
    'workspace://src/%66ile%3A/etc/passwd#L1-L1'
  ]) {
    const graph = {
      schemaVersion: '1.0.0',
      nodes: [
        {
          id: 'sgnode_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          kind: 'symbol',
          label: 'startServer',
          locator,
          symbolKind: 'function'
        }
      ],
      edges: [
        {
          id: 'sgedge_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          kind: 'exports',
          fromNodeId: 'sgnode_cccccccccccccccccccccccccccccccc',
          toNodeId: 'sgnode_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        }
      ]
    };
    const ranking = rankArchitectureNodes(graph);
    const search = searchSourceGraph(graph, { query: 'start server', limit: 20 });

    assert.deepEqual(ranking.entryPoints, []);
    assert.deepEqual(ranking.hotspots, []);
    assert.deepEqual(ranking.deprioritized, []);
    assert.deepEqual(search.results, []);
    assert.equal(JSON.stringify(ranking).includes(secret), false);
    assert.equal(JSON.stringify(search).includes(locator), false);
    assert.equal(JSON.stringify(ranking).includes('Users/rebel/secret.ts'), false);
    assert.equal(JSON.stringify(ranking).includes('private/secret.ts'), false);
    assert.equal(JSON.stringify(ranking).includes('var/folders/x.ts'), false);
  }
});

test('public source graph readers omit unsafe direct raw nodes and edges', () => {
  const secret = 'PUBLIC_GRAPH_OUTPUT_REVIEW_SECRET';
  const safeFileId = 'sgnode_11111111111111111111111111111111';
  const safeSymbolId = 'sgnode_22222222222222222222222222222222';
  const unsafeLabelId = 'sgnode_33333333333333333333333333333333';
  const unsafeLocatorId = 'sgnode_44444444444444444444444444444444';
  const crossWorkspaceId = 'sgnode_55555555555555555555555555555555';
  const graph = {
    schemaVersion: '1.0.0',
    workspaceId: 'ws_local',
    graphFingerprint: `sha256:${'a'.repeat(64)}`,
    nodes: [
      { id: safeFileId, kind: 'file', label: 'src/safe.ts', locator: 'workspace://src/safe.ts' },
      { id: safeSymbolId, kind: 'symbol', label: 'safeStart', locator: 'workspace://src/safe.ts#L1-L1', symbolKind: 'function' },
      { id: unsafeLabelId, kind: 'symbol', label: `file:///tmp/${secret}.ts`, locator: 'workspace://src/safe.ts#L2-L2', symbolKind: 'function' },
      { id: unsafeLocatorId, kind: 'symbol', label: 'coercedStart', locator: 'workspace://file:/etc/passwd#L1-L1', symbolKind: 'function' },
      { id: crossWorkspaceId, workspaceId: 'ws_other', kind: 'symbol', label: 'crossWorkspaceStart', locator: 'workspace://src/other.ts#L1-L1', symbolKind: 'function' }
    ],
    edges: [
      { id: 'sgedge_11111111111111111111111111111111', kind: 'defined_in', fromNodeId: safeFileId, toNodeId: safeSymbolId, locator: 'workspace://src/safe.ts#L1-L1' },
      { id: 'sgedge_22222222222222222222222222222222', kind: 'calls', fromNodeId: safeSymbolId, toNodeId: unsafeLabelId, locator: 'workspace://src/safe.ts#L1-L2' },
      { id: 'sgedge_33333333333333333333333333333333', kind: 'calls', fromNodeId: safeSymbolId, toNodeId: unsafeLocatorId, locator: 'workspace://file:/etc/passwd#L1-L1' },
      { id: 'sgedge_44444444444444444444444444444444', workspaceId: 'ws_other', kind: 'calls', fromNodeId: safeSymbolId, toNodeId: crossWorkspaceId, locator: 'workspace://src/other.ts#L1-L1' }
    ]
  };
  const ranking = rankArchitectureNodes(graph, { query: 'coerced start', limit: 20 });
  const search = searchSourceGraph(graph, { query: 'coerced start', limit: 20 });
  const trace = traceSourceGraph(graph, { startName: 'safeStart', edgeKinds: ['calls'], limit: 20 });
  const impact = mapSourceGraphDiffImpact(graph, {
    changedLocators: ['workspace://src/safe.ts', 'workspace://file:/etc/passwd'],
    limit: 20
  });
  const serialized = JSON.stringify({ ranking, search, trace, impact });

  assert.deepEqual(ranking.entryPoints.map((item) => item.nodeId), [safeSymbolId]);
  assert.ok(search.results.some((item) => item.id === safeSymbolId));
  assert.deepEqual(trace.paths.map((item) => item.terminalNodeId), [safeSymbolId]);
  assert.deepEqual(impact.changedLocators, ['workspace://src/safe.ts']);
  assert.deepEqual(impact.affectedSymbols.map((item) => item.nodeId), [safeSymbolId]);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('file:///tmp/'), false);
  assert.equal(serialized.includes('workspace://file:/etc/passwd'), false);
  assert.equal(serialized.includes('crossWorkspaceStart'), false);
  assert.equal(serialized.includes('ws_other'), false);
});

test('public source graph readers fail closed for unsafe metadata envelopes', () => {
  const rawWorkspaceId = 'file:///tmp/PUBLIC_GRAPH_WORKSPACE_SECRET';
  const rawGraphFingerprint = 'PUBLIC_GRAPH_FINGERPRINT_SECRET';
  const rawSourceIndexFingerprint = 'PUBLIC_GRAPH_SOURCE_INDEX_FINGERPRINT_SECRET';
  const rawGraphVersion = 'file:///tmp/PUBLIC_GRAPH_VERSION_SECRET';
  const rawParserVersion = 'PUBLIC_GRAPH_PARSER_VERSION_SECRET';
  const rawBuiltAt = 'PUBLIC_GRAPH_BUILT_AT_SECRET';
  const rawDiagnosticLocator = 'workspace://src/file:/PUBLIC_GRAPH_DIAGNOSTIC_SECRET';
  const fileId = 'sgnode_11111111111111111111111111111111';
  const symbolId = 'sgnode_22222222222222222222222222222222';
  const graph = {
    schemaVersion: '1.0.0',
    workspaceId: rawWorkspaceId,
    graphFingerprint: rawGraphFingerprint,
    sourceIndexFingerprint: rawSourceIndexFingerprint,
    graphVersion: rawGraphVersion,
    parserVersion: rawParserVersion,
    builtAt: rawBuiltAt,
    nodes: [
      { id: fileId, kind: 'file', label: 'src/safe.ts', locator: 'workspace://src/safe.ts' },
      { id: symbolId, kind: 'symbol', label: 'safeStart', locator: 'workspace://src/safe.ts#L1-L1', symbolKind: 'function' }
    ],
    edges: [{ id: 'sgedge_11111111111111111111111111111111', kind: 'defined_in', fromNodeId: fileId, toNodeId: symbolId, locator: 'workspace://src/safe.ts#L1-L1' }],
    diagnostics: [{ locator: rawDiagnosticLocator, code: 'unsafe_diagnostic_metadata' }]
  };
  const search = searchSourceGraph(graph, { query: 'safe start' });
  const trace = traceSourceGraph(graph, { startName: 'safeStart', edgeKinds: ['defined_in'] });
  const impact = mapSourceGraphDiffImpact(graph, { changedLocators: ['workspace://src/safe.ts'] });
  const ranking = rankArchitectureNodes(graph, { query: 'safe start' });
  const serialized = JSON.stringify({ search, trace, impact, ranking });

  for (const output of [search, trace, impact]) {
    assert.match(output.workspaceId, /^[a-z][a-z0-9_-]{0,127}$/u);
    assert.match(output.graphFingerprint, /^sha256:[a-f0-9]{64}$/u);
  }
  assert.deepEqual(search.results, []);
  assert.deepEqual(trace.paths, []);
  assert.deepEqual(impact.changedLocators, []);
  assert.deepEqual(impact.representedChangedLocators, []);
  assert.deepEqual(impact.affectedSymbols, []);
  assert.deepEqual(ranking.entryPoints, []);
  assert.deepEqual(ranking.hotspots, []);
  assert.deepEqual(ranking.deprioritized, []);
  assert.equal(serialized.includes(rawWorkspaceId), false);
  assert.equal(serialized.includes(rawGraphFingerprint), false);
  assert.equal(serialized.includes(rawSourceIndexFingerprint), false);
  assert.equal(serialized.includes(rawGraphVersion), false);
  assert.equal(serialized.includes(rawParserVersion), false);
  assert.equal(serialized.includes(rawBuiltAt), false);
  assert.equal(serialized.includes(rawDiagnosticLocator), false);
});

test('architecture ranking and search omit raw source-like and absolute labels from direct graph input', () => {
  for (const label of [
    SOURCE_BODY_SENTINEL,
    'function startServer() { return true; }',
    'file:///tmp/private-source.ts',
    'file:/tmp/REVIEW_SECRET.ts',
    'https:/example.test/REVIEW_SECRET.ts',
    'git:repo/REVIEW_SECRET.ts',
    'data:text/plain',
    'node:../REVIEW_SECRET.ts',
    'default:page',
    '/Users/rebel/private-source.ts',
    '/var/folders/private-source.ts',
    'a'.repeat(241)
  ]) {
    const graph = {
      schemaVersion: '1.0.0',
      nodes: [{
        id: 'sgnode_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        kind: 'symbol',
        label,
        locator: 'workspace://src/server.ts#L1-L1',
        symbolKind: 'function'
      }],
      edges: [{
        id: 'sgedge_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        kind: 'exports',
        fromNodeId: 'sgnode_cccccccccccccccccccccccccccccccc',
        toNodeId: 'sgnode_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      }]
    };
    const ranking = rankArchitectureNodes(graph);
    const search = searchSourceGraph(graph, { query: label, limit: 20 });

    assert.deepEqual(ranking.entryPoints, []);
    assert.deepEqual(ranking.hotspots, []);
    assert.deepEqual(ranking.deprioritized, []);
    assert.equal(JSON.stringify(ranking).includes(label), false);
    assert.deepEqual(search.results, []);
    assert.equal(JSON.stringify(search).includes(label), false);
    assert.equal(JSON.stringify(search).includes('REVIEW_SECRET'), false);
  }
});

test('source graph locator and label grammars are shared by ranking and both protocol schemas', () => {
  assert.equal(sourceGraphSchema.$defs.locator.pattern, SOURCE_GRAPH_WORKSPACE_LOCATOR_PATTERN);
  assert.equal(previewSchema.$defs.locator.pattern, SOURCE_GRAPH_WORKSPACE_LOCATOR_PATTERN);
  assert.equal(sourceGraphSchema.properties.workspaceId.pattern, SOURCE_GRAPH_WORKSPACE_ID_PATTERN);
  assert.equal(sourceGraphSchema.$defs.node.properties.workspaceId.pattern, SOURCE_GRAPH_WORKSPACE_ID_PATTERN);
  assert.equal(sourceGraphSchema.$defs.edge.properties.workspaceId.pattern, SOURCE_GRAPH_WORKSPACE_ID_PATTERN);
  assert.equal(previewSchema.$defs.workspaceId.pattern, SOURCE_GRAPH_WORKSPACE_ID_PATTERN);
  assert.equal(sourceGraphSchema.$defs.fingerprint.pattern, SOURCE_GRAPH_FINGERPRINT_PATTERN);
  assert.equal(previewSchema.$defs.fingerprint.pattern, SOURCE_GRAPH_FINGERPRINT_PATTERN);
  assert.equal(sourceGraphSchema.$defs.safeLabel.pattern, SOURCE_GRAPH_SAFE_LABEL_PATTERN);
  assert.equal(previewSchema.$defs.safeLabel.pattern, SOURCE_GRAPH_SAFE_LABEL_PATTERN);
  const sourceGraphFor = (locator, label = 'startServer') => ({
    schemaVersion: '1.0.0',
    workspaceId: 'ws_local',
    graphVersion: 'oaf-native-source-graph-1.0.0',
    parserVersion: 'oaf-js-ts-static-1.0.0',
    builtAt: FIXED_NOW,
    sourceIndexFingerprint: `sha256:${'1'.repeat(64)}`,
    summary: {
      fileCount: 1,
      symbolCount: 1,
      moduleCount: 0,
      nodeCount: 1,
      edgeCount: 0,
      nodeKindCounts: { symbol: 1 },
      edgeKindCounts: {},
      hotspots: [],
      entryPoints: []
    },
    nodes: [{
      id: 'sgnode_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      workspaceId: 'ws_local',
      kind: 'symbol',
      label,
      locator,
      symbolKind: 'function'
    }],
    edges: [],
    diagnostics: [],
    graphFingerprint: `sha256:${'2'.repeat(64)}`
  });

  assert.equal(SOURCE_GRAPH_WORKSPACE_LOCATOR_RE.test('workspace://src/server.ts#L1-L1'), true);
  assert.equal(validateJsonSchema(sourceGraphSchema, sourceGraphFor('workspace://src/server.ts#L1-L1')).valid, true);
  assert.equal(SOURCE_GRAPH_WORKSPACE_LOCATOR_RE.test('workspace://app/api/items/[itemId]/route.ts#L1-L3'), true);
  assert.equal(validateJsonSchema(sourceGraphSchema, sourceGraphFor('workspace://app/api/items/[itemId]/route.ts#L1-L3')).valid, true);
  for (const label of ['startServer', 'src/[id]/route.ts', 'apps/api/users/[id]/route.ts', 'src/private/state.ts', 'var/folders/local.ts', 'node:fs', 'node:fs/promises', 'local:absolute-import', 'default-page', 'from calls to', 'from exports Alias to']) {
    assert.equal(SOURCE_GRAPH_SAFE_LABEL_RE.test(label), true);
    assert.equal(validateJsonSchema(sourceGraphSchema, sourceGraphFor('workspace://src/server.ts#L1-L1', label)).valid, true);
  }
  for (const locator of [
    'workspace://src/server.ts?token=secret',
    'workspace:///Users/rebel/secret.ts#L1-L1',
    'workspace:///private/secret.ts',
    'workspace:///var/folders/x.ts',
    'workspace://src/%2e%2e/secret.ts',
    'workspace://src/..%2fsecret.ts',
    'workspace://src/%252e%252e/REVIEW_SECRET.ts',
    'workspace://src/%25252e%25252e/REVIEW_SECRET.ts',
    'workspace://src/%252fREVIEW_SECRET.ts',
    'workspace://src/%255cREVIEW_SECRET.ts',
    'workspace://file:/etc/passwd#L1-L1',
    'workspace://data:text/plain#L1-L1',
    'workspace://git:repo/path#L1-L1',
    'workspace://src/file:/etc/passwd#L1-L1',
    'workspace://src/%66ile%3A/etc/passwd#L1-L1'
  ]) {
    assert.equal(SOURCE_GRAPH_WORKSPACE_LOCATOR_RE.test(locator), false);
    assert.equal(validateJsonSchema(sourceGraphSchema, sourceGraphFor(locator)).valid, false);
    assert.equal(new RegExp(previewSchema.$defs.locator.pattern, 'u').test(locator), false);
    assert.throws(() => normalizeSourceGraphWorkspaceLocator(locator), /source_graph_workspace_locator_invalid/);
  }
  for (const locator of ['file:/etc/passwd', 'data:text/plain', 'git:repo/path']) {
    assert.throws(() => normalizeSourceGraphWorkspaceLocator(locator), /source_graph_workspace_locator_invalid/);
  }
  for (const label of [
    SOURCE_BODY_SENTINEL,
    'function startServer() { return true; }',
    'file:///tmp/private-source.ts',
    'file:/tmp/REVIEW_SECRET.ts',
    'file:REVIEW_SECRET',
    'https:/example.test/REVIEW_SECRET.ts',
    'git:repo/REVIEW_SECRET.ts',
    'data:text/plain',
    'node:../REVIEW_SECRET.ts',
    'default:page',
    '/Users/rebel/private-source.ts',
    '/var/folders/private-source.ts',
    'a'.repeat(241)
  ]) {
    assert.equal(SOURCE_GRAPH_SAFE_LABEL_RE.test(label), false);
    assert.equal(validateJsonSchema(sourceGraphSchema, sourceGraphFor('workspace://src/server.ts#L1-L1', label)).valid, false);
    assert.equal(new RegExp(previewSchema.$defs.safeLabel.pattern, 'u').test(label), false);
  }
});
