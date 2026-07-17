import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { RustCodeIntelligenceProvider } from '../providers/native/code-intelligence-rust/src/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BINARY = path.join(
  ROOT,
  'rust',
  'target',
  'release',
  process.platform === 'win32' ? 'oaf.exe' : 'oaf'
);
const FIXTURES = path.join(ROOT, 'evals', 'code-intelligence', 'fixtures');
const RAW_SOURCE_SENTINEL = 'RAW_SOURCE_SENTINEL_DO_NOT_RETURN_7e2a63';
const TIER_1 = Object.freeze([
  ['typescript', 'typescriptSentinel', 'index.ts#L3-L3'],
  ['javascript', 'javascriptSentinel', 'index.js#L3-L3'],
  ['python', 'BaseService', 'src/demo_app/api.py#L6-L8'],
  ['java', 'ItemController', 'src/main/java/com/acme/api/ItemController.java#L18-L21'],
  ['kotlin', 'ItemLoader', 'src/main/kotlin/com/acme/api/Routes.kt#L9-L15'],
  ['csharp', 'IItemLoader', 'src/Demo/Api.cs#L18-L19'],
  ['go', 'Runner', 'service/service.go#L13-L15'],
  ['rust', 'Runner', 'src/service.rs#L19-L21'],
  ['php', 'LogsItems', 'src/ItemService.php#L22-L25'],
  ['ruby', 'describe', 'lib/demo/item_service.rb#L25-L28'],
  ['swift', 'ItemLoading', 'Sources/App/ItemService.swift#L13-L15'],
  ['c', 'item_find', 'src/main.c#L3-L6'],
  ['cpp', 'ItemLoader', 'src/item_service.cpp#L8-L10'],
  ['dart', 'ItemLogging', 'lib/item.dart#L25-L25']
]);
const ROUTE_LANGUAGES = Object.freeze([
  'csharp', 'dart', 'go', 'java', 'kotlin', 'php', 'python', 'ruby', 'rust', 'swift'
]);
const ENTRYPOINTS = Object.freeze([
  ['c', 'src/main.c#L3-L6', 'outbound'],
  ['dart', 'lib/main.dart#L4-L7', 'outbound']
]);

test('native source index builds, reads, queries, and no-op refreshes all 14 Tier-1 languages', async (t) => {
  const workspace = await polyglotWorkspace(t);
  const indexPath = path.join(workspace, '.local', 'source-index', 'index.v1.sqlite');
  const provider = new RustCodeIntelligenceProvider({
    binaryPath: BINARY,
    timeoutMs: 60_000,
    maxStdoutBytes: 8_000_000
  });
  const languages = TIER_1.map(([language]) => language);
  const observed = [];

  const unpromoted = await provider.buildGraph({
    root: workspace,
    workspaceId: 'ws_polyglot_unpromoted',
    languages: ['lua']
  });
  observed.push(unpromoted);
  assert.deepEqual(unpromoted.coverage, [{
    language: 'lua',
    support: 'parse-only',
    discoveredFileCount: 1,
    indexedFileCount: 1,
    failedFileCount: 0,
    omittedFileCount: 0,
    reasonCodes: ['native_preview', 'tier1_language_unpromoted']
  }]);
  assert.deepEqual(unpromoted.diagnostics, [{
    code: 'tier1_language_unpromoted',
    severity: 'warning',
    language: 'lua',
    count: 1
  }]);

  const built = await provider.buildIndex({
    root: workspace,
    workspaceId: 'ws_polyglot',
    languages,
    maxFiles: 1_000,
    maxNodes: 20_000,
    maxEdges: 40_000
  });
  observed.push(built);
  assert.equal(built.operation, 'index.build');
  assert.equal(built.state, 'ready');
  assert(built.summary.fileCount >= TIER_1.length, built.summary);
  assert(built.summary.nodeCount >= TIER_1.length, built.summary);
  assert(built.summary.edgeCount > 0, built.summary);
  assert(built.measurements.parsedFileCount >= TIER_1.length, built.measurements);
  assert.deepEqual(
    built.diagnostics.filter(({ code }) => code === 'parse_recovered'),
    [{ code: 'parse_recovered', count: 1 }]
  );
  assertWriterSafeguards(built);

  const status = await provider.indexStatus({ root: workspace, workspaceId: 'ws_polyglot' });
  observed.push(status);
  assert.equal(status.operation, 'index.status');
  assert.equal(status.state, 'ready');
  assert.equal(status.activeGeneration, built.activeGeneration);
  assert.equal(status.summary.fileCount, built.summary.fileCount);
  assert.equal(status.summary.nodeCount, built.summary.nodeCount);
  assert.equal(status.summary.edgeCount, built.summary.edgeCount);
  assert.equal(status.summary.unresolvedCount, built.summary.unresolvedCount);
  assertReaderSafeguards(status);

  const beforeReaders = await fileSnapshot(indexPath);
  for (const [language, symbol, dependencyPath] of TIER_1) {
    const locatorFragment = `languages/${language}/`;
    const search = await provider.queryIndex({
      root: workspace,
      workspaceId: 'ws_polyglot',
      kind: 'search',
      query: symbol,
      limit: 100
    });
    observed.push(search);
    assertReaderSafeguards(search);
    const indexedSymbol = search.results.find((result) => result.locator.includes(locatorFragment));
    assert(indexedSymbol, `${language}: ${symbol} was not searchable in ${locatorFragment}`);
    assert.match(indexedSymbol.id, /^cinode_[a-f0-9]{32}$/u);
    assert.equal(indexedSymbol.generation, built.activeGeneration);
    assert.notEqual(indexedSymbol.kind, 'file', `${language}: search evidence must be parser-produced`);

    const dependency = await provider.queryIndex({
      root: workspace,
      workspaceId: 'ws_polyglot',
      kind: 'dependencies',
      locator: `workspace://languages/${language}/${dependencyPath}`,
      direction: 'both',
      depth: 1,
      limit: 100
    });
    observed.push(dependency);
    assertReaderSafeguards(dependency);
    assert(
      dependency.relationships.length > 0,
      `${language}: expected dependency evidence for ${dependencyPath}`
    );
    assert(dependency.results.length >= 2, `${language}: dependency traversal must return both ends`);
    const resultIds = new Set(dependency.results.map((result) => result.id));
    assert(
      dependency.relationships.every((edge) => resultIds.has(edge.fromNodeId) && resultIds.has(edge.toNodeId)),
      `${language}: dependency edges must reference returned indexed nodes`
    );
    const resultById = new Map(dependency.results.map((result) => [result.id, result]));
    assert(
      dependency.relationships.some((edge) => {
        const from = resultById.get(edge.fromNodeId);
        const to = resultById.get(edge.toNodeId);
        return from?.locator.includes(locatorFragment) && to?.locator.includes(locatorFragment);
      }),
      `${language}: dependency evidence must remain inside its language fixture`
    );
  }

  const routes = await provider.queryIndex({
    root: workspace,
    workspaceId: 'ws_polyglot',
    kind: 'routes',
    limit: 100
  });
  observed.push(routes);
  assertReaderSafeguards(routes);
  assert.deepEqual(languagesRepresentedBy(routes.results), [...ROUTE_LANGUAGES]);
  assert(routes.relationships.length > 0, 'route query must return route-handler evidence');
  assert(routes.relationships.every((edge) => edge.kind === 'handles_route'));

  for (const [language, entrypointPath, direction] of ENTRYPOINTS) {
    const entrypoint = await provider.queryIndex({
      root: workspace,
      workspaceId: 'ws_polyglot',
      kind: 'dependencies',
      locator: `workspace://languages/${language}/${entrypointPath}`,
      direction,
      depth: 1,
      limit: 100
    });
    observed.push(entrypoint);
    assertReaderSafeguards(entrypoint);
    const entrypointEdge = entrypoint.relationships.find((edge) => edge.kind === 'entry_point');
    assert(entrypointEdge, `${language}: expected explicit entry-point evidence`);
    const sourceNode = entrypoint.results.find((result) => result.id === entrypointEdge.fromNodeId);
    assert(
      sourceNode?.locator.includes(`/languages/${language}/`),
      `${language}: entry point must originate in the same language fixture; received ${sourceNode?.locator}`
    );
  }

  assert.deepEqual(await fileSnapshot(indexPath), beforeReaders);
  const beforeRefresh = await fileSnapshot(indexPath);
  const refreshed = await provider.refreshIndex({
    root: workspace,
    workspaceId: 'ws_polyglot',
    languages,
    maxFiles: 1_000,
    maxNodes: 20_000,
    maxEdges: 40_000
  });
  observed.push(refreshed);
  assert.equal(refreshed.operation, 'index.refresh');
  assert.equal(refreshed.measurements.parsedFileCount, 0);
  assert.equal(refreshed.measurements.changedFileCount, 0);
  assert.equal(refreshed.measurements.deletedFileCount, 0);
  assert.equal(refreshed.measurements.localFilesWritten, 0);
  assert.equal(refreshed.activeGeneration, built.activeGeneration);
  assertWriterSafeguards(refreshed);
  assert.deepEqual(await fileSnapshot(indexPath), beforeRefresh);

  const serialized = JSON.stringify(observed);
  assert.equal(serialized.includes(workspace), false);
  assert.equal(serialized.includes(RAW_SOURCE_SENTINEL), false);
  assert.equal(serialized.includes('/Users/'), false);
  assert.equal(serialized.includes('/home/'), false);
  assert.equal(serialized.includes('/private/'), false);
  assert.equal(serialized.includes('C:\\'), false);
});

async function polyglotWorkspace(t) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-polyglot-index-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const destinations = new Map([
    ['python', ['batch-b', 'python']],
    ['go', ['batch-b', 'go']],
    ['rust', ['batch-b', 'rust']],
    ['java', ['batch-c', 'java']],
    ['kotlin', ['batch-c', 'kotlin']],
    ['csharp', ['batch-c', 'csharp']],
    ['c', ['batch-d', 'c']],
    ['cpp', ['batch-d', 'cpp']],
    ['swift', ['batch-d', 'swift']],
    ['dart', ['batch-d', 'dart']],
    ['php', ['batch-e', 'php']],
    ['ruby', ['batch-e', 'ruby']]
  ]);
  for (const [language, [batch, fixture]] of destinations) {
    await cp(
      path.join(FIXTURES, batch, fixture),
      path.join(workspace, 'languages', language),
      { recursive: true }
    );
  }
  await mkdir(path.join(workspace, 'languages', 'javascript'), { recursive: true });
  await mkdir(path.join(workspace, 'languages', 'typescript'), { recursive: true });
  await writeFile(
    path.join(workspace, 'languages', 'javascript', 'index.js'),
    `// ${RAW_SOURCE_SENTINEL}\nimport { javascriptHelper } from './helper.js';\nexport function javascriptSentinel() { return javascriptHelper(); }\n`
  );
  await writeFile(
    path.join(workspace, 'languages', 'javascript', 'helper.js'),
    'export function javascriptHelper() { return 1; }\n'
  );
  await writeFile(
    path.join(workspace, 'languages', 'typescript', 'index.ts'),
    `// ${RAW_SOURCE_SENTINEL}\nimport { typescriptHelper } from './helper.js';\nexport function typescriptSentinel(): number { return typescriptHelper(); }\n`
  );
  await writeFile(
    path.join(workspace, 'languages', 'typescript', 'helper.ts'),
    'export function typescriptHelper(): number { return 1; }\n'
  );
  await writeFile(
    path.join(workspace, 'languages', 'typescript', 'malformed.ts'),
    'const incomplete = ;\nexport function recoveredTypeScriptSentinel(): number { return 1; }\n'
  );
  await mkdir(path.join(workspace, 'languages', 'lua'), { recursive: true });
  await writeFile(
    path.join(workspace, 'languages', 'lua', 'unpromoted.lua'),
    'function unpromotedLuaSentinel() return 1 end\n'
  );
  return workspace;
}

async function fileSnapshot(file) {
  const [bytes, metadata] = await Promise.all([readFile(file), stat(file, { bigint: true })]);
  return { bytes, size: metadata.size, mtimeNs: metadata.mtimeNs };
}

function assertWriterSafeguards(result) {
  assert.equal(result.safeguards.readOnly, false);
  assert.equal(result.safeguards.canonicalMemoryWrites, 0);
  assert.equal(result.safeguards.networkCalls, 0);
  assert.equal(result.safeguards.modelCalls, 0);
  assert.equal(result.safeguards.rawSourceBodiesIncluded, false);
  assert.equal(result.safeguards.absolutePathsIncluded, false);
}

function assertReaderSafeguards(result) {
  assert.equal(result.safeguards.readOnly, true);
  assert.equal(result.safeguards.localFilesWritten, 0);
  assert.equal(result.safeguards.canonicalMemoryWrites, 0);
  assert.equal(result.safeguards.networkCalls, 0);
  assert.equal(result.safeguards.modelCalls, 0);
  assert.equal(result.safeguards.rawSourceBodiesIncluded, false);
  assert.equal(result.safeguards.absolutePathsIncluded, false);
}

function languagesRepresentedBy(results) {
  return TIER_1
    .filter(([language]) => results.some((result) => result.locator.includes(`/languages/${language}/`)))
    .map(([language]) => language)
    .sort();
}
