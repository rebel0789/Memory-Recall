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
  ['typescript', 'typescriptSentinel', 'languages/typescript/'],
  ['javascript', 'javascriptSentinel', 'languages/javascript/'],
  ['python', 'BaseService', 'languages/python/'],
  ['java', 'ItemController', 'languages/java/'],
  ['kotlin', 'ItemLoader', 'languages/kotlin/'],
  ['csharp', 'IItemLoader', 'languages/csharp/'],
  ['go', 'Runner', 'languages/go/'],
  ['rust', 'Runner', 'languages/rust/'],
  ['php', 'LogsItems', 'languages/php/'],
  ['ruby', 'describe', 'languages/ruby/'],
  ['swift', 'ItemLoading', 'languages/swift/'],
  ['c', 'item_find', 'languages/c/'],
  ['cpp', 'ItemLoader', 'languages/cpp/'],
  ['dart', 'ItemLogging', 'languages/dart/']
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

  for (const [language, symbol, locatorFragment] of TIER_1) {
    const query = await provider.queryIndex({
      root: workspace,
      workspaceId: 'ws_polyglot',
      kind: 'exact',
      query: symbol,
      limit: 100
    });
    observed.push(query);
    assertReaderSafeguards(query);
    assert(
      query.results.some((result) => result.locator.includes(locatorFragment)),
      `${language}: expected ${symbol} under ${locatorFragment}; received ${JSON.stringify(query.results)}`
    );
  }

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
    `// ${RAW_SOURCE_SENTINEL}\nexport function javascriptSentinel() { return 1; }\n`
  );
  await writeFile(
    path.join(workspace, 'languages', 'typescript', 'index.ts'),
    `// ${RAW_SOURCE_SENTINEL}\nexport function typescriptSentinel(): number { return 1; }\n`
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
