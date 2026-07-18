import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sourceGraphSchema from '../packages/protocol/schemas/source-graph.schema.json' with { type: 'json' };
import { validateJsonSchema } from '../packages/protocol/src/schema-validator.mjs';
import {
  buildUnavailableSourceGraphPreview,
  buildSourceGraphIntelligence,
  compareSourceGraphCompatibility,
  nativeIndexSource,
  translateCodeIntelligenceGraph
} from '../packages/source-graph/src/index.mjs';
import { RustCodeIntelligenceProvider } from '../providers/native/code-intelligence-rust/src/index.mjs';
import { buildJsTsSourceGraph } from '../providers/native/context-candidate-ast-code/src/index.mjs';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const RUST_BINARY = path.join(ROOT, 'rust', 'target', 'release', process.platform === 'win32' ? 'oaf.exe' : 'oaf');
const fixedNow = '2026-07-16T00:00:00.000Z';

async function compatibilityWorkspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-native-compat-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new Map([
    ['src/helper.js', 'export function helper(){ return 1; }\n'],
    ['src/index.ts', [
      "import { helper } from './helper.js';",
      'export class Runner { run(){ return helper(); } }',
      'export function main(){ return new Runner().run(); }'
    ].join('\n')],
    ['src/api/users/route.ts', 'export function GET(){ return main(); }\n'],
    ['src/broken.ts', 'export function broken( {\n']
  ]);
  for (const [relative, body] of files) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), body);
  }
  return root;
}

test('native graph translates to the closed JS/TS compatibility contract', async (t) => {
  const root = await compatibilityWorkspace(t);
  const provider = new RustCodeIntelligenceProvider({ binaryPath: RUST_BINARY });
  const native = await provider.buildGraph({ root, workspaceId: 'ws_local', languages: ['javascript', 'typescript'] });
  const first = translateCodeIntelligenceGraph(native);
  const second = translateCodeIntelligenceGraph(structuredClone(native));

  assert.equal(validateJsonSchema(sourceGraphSchema, first).valid, true);
  assert.equal(first.graphFingerprint, second.graphFingerprint);
  assert.equal(first.sourceIndexFingerprint, native.repository.rootIdentityHash);
  assert(first.nodes.some((node) => node.kind === 'file' && node.locator === 'workspace://src/index.ts'));
  assert(first.nodes.some((node) => node.kind === 'symbol' && node.label === 'main'));
  assert(first.nodes.some((node) => node.kind === 'symbol' && node.label === 'GET'));
  assert(first.edges.some((edge) => edge.kind === 'defined_in'));
  assert(first.edges.some((edge) => edge.kind === 'imports'));
  assert(first.edges.some((edge) => edge.kind === 'calls'));
  assert(first.summary.coverage.reasonCodes.includes('native_compatibility_projection'));
  assert.equal(JSON.stringify(first).includes(root), false);
});

test('compatibility comparison is deterministic and never claims parity', async (t) => {
  const root = await compatibilityWorkspace(t);
  const provider = new RustCodeIntelligenceProvider({ binaryPath: RUST_BINARY });
  const [baseline, native] = await Promise.all([
    buildJsTsSourceGraph({ root, workspaceId: 'ws_local', clock: () => fixedNow }),
    provider.buildGraph({ root, workspaceId: 'ws_local', languages: ['javascript', 'typescript'] })
  ]);
  const translated = translateCodeIntelligenceGraph(native);
  const comparison = compareSourceGraphCompatibility(baseline, translated);

  assert.deepEqual(comparison.dimensions.map((item) => item.name), [
    'files',
    'symbols',
    'imports',
    'calls',
    'routes'
  ]);
  assert.equal(comparison.parityClaimed, false);
  assert.equal(comparison.comparisonVersion, 'memory-recall-js-ts-native-preview-2');
  assert.equal(comparison.dimensions.every((item) => item.baselineCount >= item.matchedCount), true);
  assert.deepEqual(comparison, compareSourceGraphCompatibility(structuredClone(baseline), structuredClone(translated)));
});

test('compatibility comparison reports bounded deterministic normalized delta evidence', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-compatibility-deltas-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const baselineRoot = path.join(workspace, 'baseline');
  const nativeRoot = path.join(workspace, 'native');
  await mkdir(baselineRoot, { recursive: true });
  await mkdir(nativeRoot, { recursive: true });
  for (const root of [baselineRoot, nativeRoot]) {
    await writeFile(path.join(root, 'shared.js'), 'export function shared(){ return 1; }\n');
  }
  for (let index = 0; index < 12; index += 1) {
    const suffix = String(index).padStart(2, '0');
    await writeFile(path.join(baselineRoot, `baseline-${suffix}.js`), [
      "import { shared } from './shared.js';",
      `export function baseline${suffix}(){ return shared(); }`
    ].join('\n'));
    await writeFile(path.join(nativeRoot, `native-${suffix}.js`), [
      "import { shared } from './shared.js';",
      `export function native${suffix}(){ return shared(); }`
    ].join('\n'));
  }

  const [baseline, native] = await Promise.all([
    buildJsTsSourceGraph({ root: baselineRoot, workspaceId: 'ws_local', clock: () => fixedNow }),
    buildJsTsSourceGraph({ root: nativeRoot, workspaceId: 'ws_local', clock: () => fixedNow })
  ]);
  const first = compareSourceGraphCompatibility(baseline, native);
  const second = compareSourceGraphCompatibility(structuredClone(baseline), structuredClone(native));

  assert.deepEqual(first, second);
  assert.deepEqual(first.dimensions.map((item) => ({
    name: item.name,
    baselineOnlyCount: item.baselineOnlyCount,
    nativeOnlyCount: item.nativeOnlyCount,
    nativeAgreement: item.nativeAgreement
  })), [
    { name: 'files', baselineOnlyCount: 12, nativeOnlyCount: 12, nativeAgreement: 0.0769 },
    { name: 'symbols', baselineOnlyCount: 12, nativeOnlyCount: 12, nativeAgreement: 0.0769 },
    { name: 'imports', baselineOnlyCount: 12, nativeOnlyCount: 12, nativeAgreement: 0 },
    { name: 'calls', baselineOnlyCount: 12, nativeOnlyCount: 12, nativeAgreement: 0 },
    { name: 'routes', baselineOnlyCount: 0, nativeOnlyCount: 0, nativeAgreement: 1 }
  ]);
  for (const dimension of first.dimensions) {
    assert.equal(dimension.baselineOnlySample.length <= 10, true);
    assert.equal(dimension.nativeOnlySample.length <= 10, true);
    assert.deepEqual(dimension.baselineOnlySample, [...dimension.baselineOnlySample].sort());
    assert.deepEqual(dimension.nativeOnlySample, [...dimension.nativeOnlySample].sort());
  }
  assert.deepEqual(first.dimensions[0].baselineOnlySample, Array.from(
    { length: 10 },
    (_, index) => `workspace://baseline-${String(index).padStart(2, '0')}.js`
  ));
  assert.deepEqual(first.dimensions[0].nativeOnlySample, Array.from(
    { length: 10 },
    (_, index) => `workspace://native-${String(index).padStart(2, '0')}.js`
  ));
  const serializedSamples = JSON.stringify(first.dimensions.flatMap((item) => [item.baselineOnlySample, item.nativeOnlySample]));
  assert.equal(serializedSamples.includes(workspace), false);
  assert.equal(serializedSamples.includes('/Users/'), false);
  assert.equal(serializedSamples.includes('#L'), false);
});

test('compatibility matches a TypeScript import that resolves outside the selected scope', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-native-external-import-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const scope = path.join(workspace, 'transformers');
  await mkdir(path.join(workspace, '_namespaces'), { recursive: true });
  await mkdir(scope, { recursive: true });
  await writeFile(path.join(workspace, '_namespaces', 'ts.ts'), "export { chainBundle } from '../transformers/utilities.js';\n");
  await writeFile(path.join(scope, 'utilities.ts'), 'export function chainBundle(){ return 1; }\n');
  await writeFile(path.join(scope, 'es2016.ts'), [
    "import { chainBundle } from '../_namespaces/ts.js';",
    'export function transformES2016(){ return chainBundle(); }'
  ].join('\n'));

  const provider = new RustCodeIntelligenceProvider({ binaryPath: RUST_BINARY });
  const [baseline, native] = await Promise.all([
    buildJsTsSourceGraph({ root: scope, workspaceId: 'ws_local', clock: () => fixedNow }),
    provider.buildGraph({ root: scope, workspaceId: 'ws_local', languages: ['typescript'] })
  ]);
  const comparison = compareSourceGraphCompatibility(baseline, translateCodeIntelligenceGraph(native));
  const imports = comparison.dimensions.find((item) => item.name === 'imports');

  assert.deepEqual(imports, {
    name: 'imports',
    baselineCount: 1,
    nativeCount: 1,
    matchedCount: 1,
    recall: 1,
    baselineOnlyCount: 0,
    nativeOnlyCount: 0,
    nativeAgreement: 1,
    baselineOnlySample: [],
    nativeOnlySample: []
  });
  assert.equal(comparison.dimensions.find((item) => item.name === 'calls')?.matchedCount, 1);
});

test('compatibility preserves the official node:path import key', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-native-node-path-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'index.js'), [
    "var path = require('node:path');",
    "function renderPath(){ return path.join('one', 'two'); }",
    'module.exports = renderPath;'
  ].join('\n'));

  const provider = new RustCodeIntelligenceProvider({ binaryPath: RUST_BINARY });
  const [baseline, native] = await Promise.all([
    buildJsTsSourceGraph({ root, workspaceId: 'ws_local', clock: () => fixedNow }),
    provider.buildGraph({ root, workspaceId: 'ws_local', languages: ['javascript'] })
  ]);
  const translated = translateCodeIntelligenceGraph(native);
  const comparison = compareSourceGraphCompatibility(baseline, translated);
  const nativeNodes = new Map(translated.nodes.map((node) => [node.id, node]));
  const nativeImport = translated.edges.find((edge) => edge.kind === 'imports');
  const nativeExport = translated.edges.find((edge) => edge.kind === 'exports');

  assert.equal(nativeNodes.get(nativeImport?.toNodeId)?.label, 'node:path');
  assert.equal(nativeNodes.get(nativeExport?.toNodeId)?.label, 'renderPath');
  assert.deepEqual(comparison.dimensions.find((item) => item.name === 'imports'), {
    name: 'imports',
    baselineCount: 1,
    nativeCount: 1,
    matchedCount: 1,
    recall: 1,
    baselineOnlyCount: 0,
    nativeOnlyCount: 0,
    nativeAgreement: 1,
    baselineOnlySample: [],
    nativeOnlySample: []
  });
});

test('compatibility preserves a hyphenated CommonJS package import key', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-native-hyphenated-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'index.js'), [
    "var merge = require('merge-descriptors');",
    'function mergeApp(target, source){ return merge(target, source); }',
    'module.exports = mergeApp;'
  ].join('\n'));

  const provider = new RustCodeIntelligenceProvider({ binaryPath: RUST_BINARY });
  const [baseline, native] = await Promise.all([
    buildJsTsSourceGraph({ root, workspaceId: 'ws_local', clock: () => fixedNow }),
    provider.buildGraph({ root, workspaceId: 'ws_local', languages: ['javascript'] })
  ]);
  const translated = translateCodeIntelligenceGraph(native);
  const comparison = compareSourceGraphCompatibility(baseline, translated);
  const nativeNodes = new Map(translated.nodes.map((node) => [node.id, node]));
  const nativeImport = translated.edges.find((edge) => edge.kind === 'imports');

  assert.equal(nativeNodes.get(nativeImport?.toNodeId)?.label, 'merge-descriptors');
  assert.deepEqual(comparison.dimensions.find((item) => item.name === 'imports'), {
    name: 'imports',
    baselineCount: 1,
    nativeCount: 1,
    matchedCount: 1,
    recall: 1,
    baselineOnlyCount: 0,
    nativeOnlyCount: 0,
    nativeAgreement: 1,
    baselineOnlySample: [],
    nativeOnlySample: []
  });
});

test('compatibility preserves a scoped CommonJS package import key', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-native-scoped-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'index.js'), [
    "var scopedPackage = require('@scope/pkg-name');",
    'function loadPackage(){ return scopedPackage; }',
    'module.exports = loadPackage;'
  ].join('\n'));

  const provider = new RustCodeIntelligenceProvider({ binaryPath: RUST_BINARY });
  const [baseline, native] = await Promise.all([
    buildJsTsSourceGraph({ root, workspaceId: 'ws_local', clock: () => fixedNow }),
    provider.buildGraph({ root, workspaceId: 'ws_local', languages: ['javascript'] })
  ]);
  const translated = translateCodeIntelligenceGraph(native);
  const comparison = compareSourceGraphCompatibility(baseline, translated);
  const nativeNodes = new Map(translated.nodes.map((node) => [node.id, node]));
  const nativeImport = translated.edges.find((edge) => edge.kind === 'imports');

  assert.equal(nativeNodes.get(nativeImport?.toNodeId)?.label, '@scope/pkg-name');
  assert.deepEqual(comparison.dimensions.find((item) => item.name === 'imports'), {
    name: 'imports',
    baselineCount: 1,
    nativeCount: 1,
    matchedCount: 1,
    recall: 1,
    baselineOnlyCount: 0,
    nativeOnlyCount: 0,
    nativeAgreement: 1,
    baselineOnlySample: [],
    nativeOnlySample: []
  });
});

test('compatibility resolves a CommonJS member call to the required module', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-native-commonjs-member-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'application.js'), 'exports.create = function create(){ return 1; };\n');
  await writeFile(path.join(root, 'express.js'), [
    "var create = require('./application').create;",
    'function createApplication(){ return create(); }',
    'module.exports = createApplication;'
  ].join('\n'));

  const provider = new RustCodeIntelligenceProvider({ binaryPath: RUST_BINARY });
  const [baseline, native] = await Promise.all([
    buildJsTsSourceGraph({ root, workspaceId: 'ws_local', clock: () => fixedNow }),
    provider.buildGraph({ root, workspaceId: 'ws_local', languages: ['javascript'] })
  ]);
  const comparison = compareSourceGraphCompatibility(baseline, translateCodeIntelligenceGraph(native));

  assert.deepEqual(comparison.dimensions.find((item) => item.name === 'calls'), {
    name: 'calls',
    baselineCount: 1,
    nativeCount: 1,
    matchedCount: 1,
    recall: 1,
    baselineOnlyCount: 0,
    nativeOnlyCount: 0,
    nativeAgreement: 1,
    baselineOnlySample: [],
    nativeOnlySample: []
  });
});

test('source graph intelligence defaults to native and keeps JS as explicit compatibility', async (t) => {
  const root = await compatibilityWorkspace(t);
  const provider = new RustCodeIntelligenceProvider({ binaryPath: RUST_BINARY });
  const native = await buildSourceGraphIntelligence({
    root,
    workspaceId: 'ws_local',
    codeIntelligenceProvider: provider,
    clock: () => fixedNow
  });
  assert.equal(native.source.kind, 'native');
  assert.equal(validateJsonSchema(sourceGraphSchema, native.graph).valid, true);

  const js = await buildSourceGraphIntelligence({ root, workspaceId: 'ws_local', engine: 'js', clock: () => fixedNow });
  assert.equal(js.source.kind, 'bounded-scan');

  const explicitNative = await buildSourceGraphIntelligence({
    root,
    workspaceId: 'ws_local',
    engine: 'native',
    codeIntelligenceProvider: provider,
    clock: () => fixedNow
  });
  assert.equal(explicitNative.source.kind, 'native');

  const compatibilityAlias = await buildSourceGraphIntelligence({
    root,
    workspaceId: 'ws_local',
    engine: 'native-preview',
    codeIntelligenceProvider: provider,
    clock: () => fixedNow
  });
  assert.equal(compatibilityAlias.source.kind, 'native');

  const compatibility = await buildSourceGraphIntelligence({
    root,
    workspaceId: 'ws_local',
    engine: 'compatibility',
    codeIntelligenceProvider: provider,
    clock: () => fixedNow
  });
  assert.equal(compatibility.source.kind, 'native');
  assert.equal(compatibility.compatibility.parityClaimed, false);

  await assert.rejects(
    buildSourceGraphIntelligence({ root, engine: 'native' }),
    /source_graph_native_provider_required/u
  );
  await assert.rejects(
    buildSourceGraphIntelligence({ root, engine: 'unknown', codeIntelligenceProvider: provider }),
    /source_graph_engine_invalid/u
  );
});

test('native source metadata is canonical and contains no preview-default disclaimers', () => {
  assert.deepEqual(nativeIndexSource({
    indexLocator: 'workspace://.local/source-index/index.v1.sqlite',
    activeGeneration: 3,
    freshness: 'current'
  }), {
    kind: 'native-persistent-index',
    engine: 'memory-recall-native',
    indexLocator: 'workspace://.local/source-index/index.v1.sqlite',
    activeGeneration: 3,
    freshness: 'current'
  });
});

test('native-unavailable preview is bounded without invoking the JS scanner', () => {
  const preview = buildUnavailableSourceGraphPreview({
    workspaceId: 'ws_local',
    query: 'entry point',
    changedLocators: ['workspace://src/main.ts'],
    limit: 7,
    offset: 4,
    depth: 3,
    sampleLimit: 5,
    errorCode: 'native_platform_package_missing',
    clock: () => fixedNow
  });
  assert.equal(preview.snapshot.status, 'unavailable');
  assert.equal(preview.search.limit, 7);
  assert.equal(preview.search.offset, 4);
  assert.equal(preview.search.total, 0);
  assert.equal(preview.graph.summary.nodeCount, 0);
  assert.match(preview.snapshot.reason, /native_platform_package_missing/u);
  assert.throws(
    () => buildUnavailableSourceGraphPreview({ limit: 101 }),
    /source_graph_preview_limit_invalid/u
  );
});
