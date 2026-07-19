import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  NativeCodeIntelligenceError,
  RustCodeIntelligenceProvider
} from '../providers/native/code-intelligence-rust/src/index.mjs';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const RUST_BINARY = path.join(ROOT, 'rust', 'target', 'release', process.platform === 'win32' ? 'oaf.exe' : 'oaf');
const exampleResponse = JSON.parse(await readFile(path.join(ROOT, 'examples/protocol/code-intelligence-engine-response.json'), 'utf8'));

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-provider-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'index.ts'), 'export function main(){ return helper(); }\nexport function helper(){ return 1; }\n');
  return root;
}

async function mockBinary(t, behavior) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-native-mock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'native-mock.mjs');
  const frame = JSON.stringify(exampleResponse);
  await writeFile(file, [
    '#!/usr/bin/env node',
    "if (process.argv[2] === '--version') { console.log('oaf 2.0.0'); process.exit(0); }",
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => {",
    "  const request = JSON.parse(input.trim());",
    `  const frame = ${frame};`,
    '  frame.requestId = request.requestId;',
    behavior,
    '});'
  ].join('\n'));
  await chmod(file, 0o755);
  return file;
}

function provider(binaryPath, overrides = {}) {
  return new RustCodeIntelligenceProvider({
    binaryPath,
    timeoutMs: 3000,
    maxStdoutBytes: 1_000_000,
    maxStderrBytes: 8_192,
    ...overrides
  });
}

test('native provider default stdout bound can carry the maximum declared graph envelope', () => {
  const instance = new RustCodeIntelligenceProvider({ binaryPath: RUST_BINARY });
  assert.equal(instance.maxStdoutBytes, 8_000_000);
});

test('native provider builds and validates one local read-only graph', async (t) => {
  const root = await workspace(t);
  const instance = provider(RUST_BINARY);
  const graph = await instance.buildGraph({
    root,
    workspaceId: 'ws_local',
    languages: ['javascript', 'typescript']
  });

  assert.equal(graph.engine.name, 'memory-recall-native');
  assert(graph.nodes.some((node) => node.name === 'main'));
  assert.equal(JSON.stringify(graph).includes(root), false);
  assert.deepEqual(await instance.capabilities(), [
    'code-intelligence.graph.build',
    'code-intelligence.index.build',
    'code-intelligence.index.refresh',
    'code-intelligence.index.repair',
    'code-intelligence.index.status',
    'code-intelligence.index.doctor',
    'code-intelligence.index.query',
    'code-intelligence.repository.register',
    'code-intelligence.repository.list',
    'code-intelligence.repository.search',
    'code-intelligence.repository.go.resolve',
    'code-intelligence.repository.go.trace',
    'code-intelligence.repository.go.impact',
    'code-intelligence.local-read-only',
    'code-intelligence.native'
  ]);
  const health = await instance.health();
  assert.equal(health.status, 'healthy');
  assert.equal(health.details.productionDefault, true);
});

test('native provider fails clearly when the explicit binary is unavailable', async (t) => {
  const root = await workspace(t);
  const instance = provider(path.join(root, 'missing-native'));
  await assert.rejects(
    instance.buildGraph({ root, workspaceId: 'ws_local' }),
    (error) => error instanceof NativeCodeIntelligenceError && error.code === 'native_engine_unavailable'
  );
  assert.equal((await instance.health()).status, 'unavailable');
});

test('native provider enforces request bounds before spawning', async (t) => {
  const root = await workspace(t);
  const instance = provider(RUST_BINARY);
  await assert.rejects(
    instance.buildGraph({ root, workspaceId: 'INVALID', maxFiles: 100_001 }),
    (error) => error.code === 'native_engine_request_invalid'
  );
  await assert.rejects(
    instance.buildGraph({ root: path.join(root, 'missing'), workspaceId: 'ws_local' }),
    (error) => error.code === 'native_engine_workspace_invalid'
  );
  await assert.rejects(
    instance.buildIndex({ root, workspaceId: 'ws_local', maxNodes: 1_000_001 }),
    (error) => error.code === 'native_index_request_invalid'
  );
});

test('native provider owns the bounded source-index lifecycle without mutating reader state or governed memory', async (t) => {
  const root = await workspace(t);
  const instance = provider(RUST_BINARY, { timeoutMs: 30_000 });
  const indexPath = path.join(root, '.local', 'source-index', 'index.v1.sqlite');
  const memoryPath = path.join(root, '.local', 'memory.sqlite');
  await mkdir(path.dirname(memoryPath), { recursive: true });
  await writeFile(memoryPath, 'governed-memory-sentinel');
  const memoryBefore = await readFile(memoryPath);

  const absent = await instance.indexStatus({ root, workspaceId: 'ws_local' });
  assert.equal(absent.state, 'absent');
  await assert.rejects(stat(indexPath), (error) => error.code === 'ENOENT');

  const built = await instance.buildIndex({
    root,
    workspaceId: 'ws_local',
    languages: ['javascript', 'typescript']
  });
  assert.equal(built.operation, 'index.build');
  assert.equal(built.safeguards.localFilesWritten, 1);
  assert.equal(built.safeguards.canonicalMemoryWrites, 0);
  assert(built.summary.nodeCount > 0);
  assert.equal(JSON.stringify(built).includes(root), false);

  const beforeReaders = await indexSnapshot(indexPath);
  const status = await instance.indexStatus({ root, workspaceId: 'ws_local' });
  const doctor = await instance.doctorIndex({ root, workspaceId: 'ws_local' });
  const query = await instance.queryIndex({
    root,
    workspaceId: 'ws_local',
    kind: 'exact',
    query: 'main',
    limit: 10
  });
  const search = await instance.queryIndex({
    root,
    workspaceId: 'ws_local',
    kind: 'search',
    query: 'mai',
    limit: 10
  });
  const dependencies = await instance.queryIndex({
    root,
    workspaceId: 'ws_local',
    kind: 'dependencies',
    query: 'main',
    direction: 'outbound',
    depth: 1,
    limit: 10
  });
  const boundedDependencies = await instance.queryIndex({
    root,
    workspaceId: 'ws_local',
    kind: 'dependencies',
    query: 'main',
    direction: 'outbound',
    depth: 1,
    limit: 1
  });
  assert.equal(status.state, 'ready');
  assert.equal(status.truncated, false);
  assert.equal(doctor.health.status, 'ready');
  assert.equal(doctor.truncated, false);
  assert(query.results.some((item) => item.label === 'main'));
  assert(search.results.some((item) => item.label === 'main'));
  assert(dependencies.relationships.some((item) => item.kind === 'calls' && item.confidence > 0));
  assert.equal(boundedDependencies.truncated, true);
  assert.deepEqual(await indexSnapshot(indexPath), beforeReaders);

  const unchanged = await instance.refreshIndex({
    root,
    workspaceId: 'ws_local',
    languages: ['javascript', 'typescript']
  });
  assert.equal(unchanged.measurements.parsedFileCount, 0);
  assert.equal(unchanged.measurements.changedFileCount, 0);
  assert.equal(unchanged.measurements.localFilesWritten, 0);
  assert.deepEqual(await indexSnapshot(indexPath), beforeReaders);

  await writeFile(path.join(root, 'src', 'index.ts'), 'export function main(){ return helper(); }\nexport function helper(){ return 2; }\n');
  const refreshed = await instance.refreshIndex({
    root,
    workspaceId: 'ws_local',
    languages: ['javascript', 'typescript']
  });
  assert.equal(refreshed.measurements.changedFileCount, 1);
  assert.equal(refreshed.measurements.parsedFileCount, 1);
  assert.equal(refreshed.activeGeneration, built.activeGeneration + 1);

  await writeFile(indexPath, 'not a sqlite database');
  const corrupt = await instance.doctorIndex({ root, workspaceId: 'ws_local' });
  assert.equal(corrupt.health.status, 'corrupt');
  assert.match(corrupt.health.repairPlanFingerprint, /^sha256:[a-f0-9]{64}$/u);

  const repaired = await instance.repairIndex({
    root,
    workspaceId: 'ws_local',
    languages: ['javascript', 'typescript'],
    confirmRepairPlan: corrupt.health.repairPlanFingerprint
  });
  assert.equal(repaired.operation, 'index.repair');
  assert.equal(repaired.safeguards.repairPerformed, true);
  assert.equal((await instance.indexStatus({ root, workspaceId: 'ws_local' })).state, 'ready');
  assert.deepEqual(await readFile(memoryPath), memoryBefore);
});

test('native provider terminates timeout and cancellation paths', async (t) => {
  const root = await workspace(t);
  const slow = await mockBinary(t, "  setTimeout(() => console.log(JSON.stringify(frame)), 1000);");
  await assert.rejects(
    provider(slow, { timeoutMs: 25 }).buildGraph({ root, workspaceId: 'ws_local' }),
    (error) => error.code === 'native_engine_timeout'
  );

  const controller = new AbortController();
  const pending = provider(slow).buildGraph({ root, workspaceId: 'ws_local', signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error.code === 'native_engine_cancelled');
});

test('native provider rejects output overflow without retaining child output', async (t) => {
  const root = await workspace(t);
  const overflowing = await mockBinary(t, "  process.stdout.write('x'.repeat(20000));");
  await assert.rejects(
    provider(overflowing, { maxStdoutBytes: 1024 }).buildGraph({ root, workspaceId: 'ws_local' }),
    (error) => error.code === 'native_engine_stdout_limit'
  );
});

test('native provider rejects malformed, duplicate, mismatched, and invalid terminal frames', async (t) => {
  const root = await workspace(t);
  const cases = [
    ["  console.log('{invalid');", 'native_engine_response_invalid'],
    ["  console.log(JSON.stringify(frame)); console.log(JSON.stringify(frame));", 'native_engine_response_invalid'],
    ["  frame.requestId = 'cireq_ffffffffffffffffffffffffffffffff'; console.log(JSON.stringify(frame));", 'native_engine_response_mismatch'],
    ["  frame.result.graph.nodes[0].locator = '/Users/example/private.ts'; console.log(JSON.stringify(frame));", 'native_engine_graph_invalid']
  ];
  for (const [behavior, code] of cases) {
    const binary = await mockBinary(t, behavior);
    await assert.rejects(
      provider(binary).buildGraph({ root, workspaceId: 'ws_local' }),
      (error) => error.code === code,
      code
    );
  }
});

test('native provider sanitizes nonzero exits and engine failure frames', async (t) => {
  const root = await workspace(t);
  const failedProcess = await mockBinary(t, "  console.error('/Users/example/private.ts'); process.exit(9);");
  await assert.rejects(
    provider(failedProcess).buildGraph({ root, workspaceId: 'ws_local' }),
    (error) => error.code === 'native_engine_process_failed' && !error.message.includes('/Users/')
  );
  const failedFrame = await mockBinary(t, [
    "  console.log(JSON.stringify({",
    "    protocolVersion: '1.0.0', requestId: request.requestId, ok: false,",
    "    error: { code: 'engine_deadline_exceeded', retryable: true, details: ['request deadline exceeded'] }",
    '  }));'
  ].join('\n'));
  await assert.rejects(
    provider(failedFrame).buildGraph({ root, workspaceId: 'ws_local' }),
    (error) => error.code === 'engine_deadline_exceeded' && error.retryable === true
  );
});

async function indexSnapshot(file) {
  const [bytes, metadata] = await Promise.all([
    readFile(file),
    stat(file, { bigint: true })
  ]);
  return {
    bytes,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs
  };
}
