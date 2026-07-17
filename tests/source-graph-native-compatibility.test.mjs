import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sourceGraphSchema from '../packages/protocol/schemas/source-graph.schema.json' with { type: 'json' };
import { validateJsonSchema } from '../packages/protocol/src/schema-validator.mjs';
import {
  buildSourceGraphIntelligence,
  compareSourceGraphCompatibility,
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
  assert.equal(comparison.dimensions.every((item) => item.baselineCount >= item.matchedCount), true);
  assert.deepEqual(comparison, compareSourceGraphCompatibility(structuredClone(baseline), structuredClone(translated)));
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
    recall: 1
  });
  assert.equal(comparison.dimensions.find((item) => item.name === 'calls')?.matchedCount, 1);
});

test('source graph intelligence keeps JS default and makes native selection strict', async (t) => {
  const root = await compatibilityWorkspace(t);
  const provider = new RustCodeIntelligenceProvider({ binaryPath: RUST_BINARY });
  const js = await buildSourceGraphIntelligence({ root, workspaceId: 'ws_local', clock: () => fixedNow });
  assert.equal(js.source.kind, 'bounded-scan');

  const native = await buildSourceGraphIntelligence({
    root,
    workspaceId: 'ws_local',
    engine: 'native-preview',
    codeIntelligenceProvider: provider,
    clock: () => fixedNow
  });
  assert.equal(native.source.kind, 'native-preview');
  assert.equal(validateJsonSchema(sourceGraphSchema, native.graph).valid, true);

  const compatibility = await buildSourceGraphIntelligence({
    root,
    workspaceId: 'ws_local',
    engine: 'compatibility',
    codeIntelligenceProvider: provider,
    clock: () => fixedNow
  });
  assert.equal(compatibility.source.kind, 'native-preview');
  assert.equal(compatibility.compatibility.parityClaimed, false);

  await assert.rejects(
    buildSourceGraphIntelligence({ root, engine: 'native-preview' }),
    /source_graph_native_provider_required/u
  );
  await assert.rejects(
    buildSourceGraphIntelligence({ root, engine: 'unknown', codeIntelligenceProvider: provider }),
    /source_graph_engine_invalid/u
  );
});
