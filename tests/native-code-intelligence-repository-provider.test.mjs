import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  NativeCodeIntelligenceError,
  RustCodeIntelligenceProvider
} from '../providers/native/code-intelligence-rust/src/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUST_BINARY = path.join(
  ROOT,
  'rust',
  'target',
  'release',
  process.platform === 'win32' ? 'oaf.exe' : 'oaf'
);
const REGISTRY_LOCATOR = 'workspace://.local/source-index/registry.v1.sqlite';
const REPOSITORY_ID = `repo_${'a'.repeat(32)}`;

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-repository-provider-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function mockBinary(t, capturePath, responseBody = null, delayMs = 0) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-repository-provider-mock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, 'native-mock.mjs');
  await writeFile(binary, [
    '#!/usr/bin/env node',
    "import { appendFileSync } from 'node:fs';",
    "if (process.argv[2] === '--version') { console.log('oaf 2.0.0'); process.exit(0); }",
    "if (process.argv.slice(2).join(' ') !== 'code-intelligence repositories --stdio') process.exit(19);",
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => {",
    "  const request = JSON.parse(input.trim());",
    `  appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify(request) + '\\n');`,
    responseBody === null
      ? `  setTimeout(() => console.log(JSON.stringify(successFrame(request))), ${delayMs});`
      : `  setTimeout(() => console.log(JSON.stringify(${responseBody})), ${delayMs});`,
    "});",
    '',
    'function successFrame(request) {',
    `  const repository = ${JSON.stringify(repositoryRecord())};`,
    "  const readOnly = request.operation !== 'repository.register';",
    "  const isSearch = request.operation === 'repository.search';",
    '  return {',
    "    protocolVersion: '1.0.0',",
    '    requestId: request.requestId,',
    '    ok: true,',
    '    result: {',
    "      responseSchemaVersion: '1.0.0',",
    '      operation: request.operation,',
    `      registryLocator: ${JSON.stringify(REGISTRY_LOCATOR)},`,
    "      state: 'ready',",
    '      repositories: [repository],',
    '      results: isSearch ? [{',
    `        id: 'mrnode_${'b'.repeat(32)}',`,
    `        nativeId: 'cinode_${'c'.repeat(32)}',`,
    '        repositoryId: repository.repositoryId,',
    "        kind: 'symbol',",
    "        label: 'main',",
    "        locator: 'workspace://src/index.ts#L1-L1',",
    '        confidence: 1,',
    '        generation: 1',
    '      }] : [],',
    '      perRepository: isSearch ? [{ repositoryId: repository.repositoryId, state: "ready", resultCount: 1, truncated: false, reasonCodes: [] }] : [],',
    '      partial: false,',
    '      truncated: false,',
    '      measurements: { durationMs: 1, selectedRepositoryCount: isSearch ? 1 : 0, openedRepositoryCount: isSearch ? 1 : 0, resultCount: isSearch ? 1 : 0, localFilesWritten: readOnly ? 0 : 1 },',
    '      safeguards: { readOnly, localFilesWritten: readOnly ? 0 : 1, canonicalMemoryWrites: 0, networkCalls: 0, modelCalls: 0, rawSourceBodiesIncluded: false, absolutePathsIncluded: false }',
    '    }',
    '  };',
    '}'
  ].join('\n'));
  await chmod(binary, 0o755);
  return binary;
}

function provider(binaryPath, overrides = {}) {
  return new RustCodeIntelligenceProvider({
    binaryPath,
    timeoutMs: 3000,
    maxStdoutBytes: 1_000_000,
    maxStderrBytes: 8192,
    ...overrides
  });
}

test('repository provider rejects requests outside the protocol schema before transport', async (t) => {
  const root = await workspace(t);
  const capturePath = path.join(root, 'requests.jsonl');
  const binary = await mockBinary(t, capturePath);
  const instance = provider(binary);
  const invalidCalls = [
    () => instance.registerRepository({ root, workspaceId: 'ws_local', displayName: '<invalid>', rootLocator: 'workspace://repositories/alpha' }),
    () => instance.registerRepository({ root, workspaceId: 'ws_local', displayName: 'Alpha', rootLocator: 'https://example.invalid/outside' }),
    () => instance.listRepositories({ root, workspaceId: 'ws_local', limit: 65 }),
    () => instance.searchRepositories({ root, workspaceId: 'ws_local', query: 'main*unsafe', repositoryIds: [REPOSITORY_ID] }),
    () => instance.searchRepositories({ root, workspaceId: 'ws_local', query: 'main', repositoryIds: [REPOSITORY_ID, REPOSITORY_ID] }),
    () => instance.searchRepositories({ root, workspaceId: 'ws_local', query: 'main', repositoryIds: [REPOSITORY_ID], perRepositoryLimit: 26 }),
    () => instance.searchRepositories({ root, workspaceId: 'ws_local', query: 'main', repositoryIds: [REPOSITORY_ID], limit: 51 }),
    () => instance.resolveGoRepositories({
      root,
      repositoryIds: [REPOSITORY_ID, `repo_${'b'.repeat(32)}`],
      clientRepositoryId: `repo_${'b'.repeat(32)}`,
      serviceRepositoryId: REPOSITORY_ID,
      clientEntryNativeId: `cinode_${'c'.repeat(32)}`,
      serviceTargetNativeId: `cinode_${'d'.repeat(32)}`
    })
  ];
  for (const call of invalidCalls) {
    await assert.rejects(
      call(),
      (error) => error instanceof NativeCodeIntelligenceError && error.code === 'native_repository_request_invalid'
    );
  }
  await assert.rejects(readFile(capturePath), (error) => error.code === 'ENOENT');
});

test('repository provider passes register, list, and search frames through one native command', async (t) => {
  const root = await workspace(t);
  const capturePath = path.join(root, 'requests.jsonl');
  const binary = await mockBinary(t, capturePath);
  const instance = provider(binary);

  const registered = await instance.registerRepository({
    root,
    workspaceId: 'ws_local',
    displayName: 'Alpha',
    rootLocator: 'workspace://repositories/alpha'
  });
  const listed = await instance.listRepositories({ root, workspaceId: 'ws_local', limit: 12 });
  const searched = await instance.searchRepositories({
    root,
    workspaceId: 'ws_local',
    query: 'main',
    repositoryIds: [REPOSITORY_ID],
    perRepositoryLimit: 3,
    limit: 5
  });

  assert.equal(registered.operation, 'repository.register');
  assert.equal(registered.safeguards.readOnly, false);
  assert.equal(listed.operation, 'repository.list');
  assert.equal(listed.safeguards.readOnly, true);
  assert.equal(searched.operation, 'repository.search');
  assert.equal(searched.results[0].repositoryId, REPOSITORY_ID);
  assert.equal(Object.isFrozen(searched), true);
  assert.deepEqual((await instance.capabilities()).filter((capability) => capability.includes('.repository.')), [
    'code-intelligence.repository.register',
    'code-intelligence.repository.list',
    'code-intelligence.repository.search',
    'code-intelligence.repository.go.resolve',
    'code-intelligence.repository.go.trace',
    'code-intelligence.repository.go.impact'
  ]);

  const requests = (await readFile(capturePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(requests.map(({ operation }) => operation), [
    'repository.register',
    'repository.list',
    'repository.search'
  ]);
  assert(requests.every(({ requestId }) => /^cireporeq_[a-f0-9]{32}$/u.test(requestId)));
  assert(requests.every(({ registryLocator }) => registryLocator === REGISTRY_LOCATOR));
  assert.deepEqual(requests.map(({ deadlineMs }) => deadlineMs), [3000, 3000, 2000]);
  assert.deepEqual(requests[0].arguments, {
    write: true,
    displayName: 'Alpha',
    rootLocator: 'workspace://repositories/alpha'
  });
  assert.deepEqual(requests[1].arguments, { limit: 12 });
  assert.deepEqual(requests[2].arguments, {
    query: 'main',
    repositoryIds: [REPOSITORY_ID],
    perRepositoryLimit: 3,
    limit: 5
  });
});

test('repository provider cancels active work and enforces the repository search deadline', async (t) => {
  const root = await workspace(t);
  const capturePath = path.join(root, 'requests.jsonl');
  const binary = await mockBinary(t, capturePath, null, 1000);
  const instance = provider(binary);
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(
    instance.listRepositories({ root, workspaceId: 'ws_local', signal: alreadyAborted.signal }),
    (error) => error instanceof NativeCodeIntelligenceError && error.code === 'native_engine_cancelled'
  );
  await assert.rejects(readFile(capturePath), (error) => error.code === 'ENOENT');

  const active = new AbortController();
  const pending = instance.listRepositories({ root, workspaceId: 'ws_local', signal: active.signal });
  await waitForFile(capturePath);
  active.abort();
  await assert.rejects(
    pending,
    (error) => error instanceof NativeCodeIntelligenceError && error.code === 'native_engine_cancelled'
  );

  const timeoutCapturePath = path.join(root, 'timeout-requests.jsonl');
  const slowBinary = await mockBinary(t, timeoutCapturePath, null, 2500);
  await assert.rejects(
    provider(slowBinary).searchRepositories({
      root,
      workspaceId: 'ws_local',
      query: 'main',
      repositoryIds: [REPOSITORY_ID]
    }),
    (error) => error instanceof NativeCodeIntelligenceError && error.code === 'native_engine_timeout'
  );
});

test('repository provider rejects terminal frames outside the response schema', async (t) => {
  const root = await workspace(t);
  const capturePath = path.join(root, 'requests.jsonl');
  const invalidResponse = JSON.stringify({
    protocolVersion: '1.0.0',
    requestId: 'cireporeq_ffffffffffffffffffffffffffffffff',
    ok: true,
    result: {}
  });
  const binary = await mockBinary(t, capturePath, invalidResponse);
  await assert.rejects(
    provider(binary).listRepositories({ root, workspaceId: 'ws_local' }),
    (error) => error instanceof NativeCodeIntelligenceError && error.code === 'native_repository_response_invalid'
  );
});

test('release binary registers, lists, and searches independent repository indexes', async (t) => {
  const root = await workspace(t);
  const alpha = path.join(root, 'repositories', 'alpha');
  const beta = path.join(root, 'repositories', 'beta');
  await mkdir(path.join(alpha, 'src'), { recursive: true });
  await mkdir(path.join(beta, 'src'), { recursive: true });
  await writeFile(path.join(alpha, 'src', 'index.ts'), 'export function sharedEntry(){ return true; }\n');
  await writeFile(path.join(beta, 'src', 'index.py'), 'def sharedEntry():\n    return True\n');

  const instance = provider(RUST_BINARY, { timeoutMs: 60_000, maxStdoutBytes: 8_000_000 });
  await instance.buildIndex({ root: alpha, workspaceId: 'ws_fleet', languages: ['typescript'] });
  await instance.buildIndex({ root: beta, workspaceId: 'ws_fleet', languages: ['python'] });
  const alphaRegistration = await instance.registerRepository({
    root,
    workspaceId: 'ws_fleet',
    displayName: 'Alpha',
    rootLocator: 'workspace://repositories/alpha'
  });
  const betaRegistration = await instance.registerRepository({
    root,
    workspaceId: 'ws_fleet',
    displayName: 'Beta',
    rootLocator: 'workspace://repositories/beta'
  });
  const repositoryIds = [
    alphaRegistration.repositories[0].repositoryId,
    betaRegistration.repositories[0].repositoryId
  ];
  const registryPath = path.join(root, '.local', 'source-index', 'registry.v1.sqlite');
  const beforeReaders = await fileSnapshot(registryPath);
  const listed = await instance.listRepositories({ root, workspaceId: 'ws_fleet' });
  const searched = await instance.searchRepositories({
    root,
    workspaceId: 'ws_fleet',
    query: 'sharedEntry',
    repositoryIds,
    perRepositoryLimit: 10,
    limit: 20
  });

  assert.equal(listed.repositories.length, 2);
  assert.equal(listed.safeguards.readOnly, true);
  assert.equal(searched.results.length, 2);
  assert.deepEqual(new Set(searched.results.map(({ repositoryId }) => repositoryId)), new Set(repositoryIds));
  assert.equal(new Set(searched.results.map(({ id }) => id)).size, 2);
  assert.equal(searched.safeguards.readOnly, true);
  assert.deepEqual(await fileSnapshot(registryPath), beforeReaders);
  const serialized = JSON.stringify({ alphaRegistration, betaRegistration, listed, searched });
  assert.equal(serialized.includes(root), false);
  assert.equal(serialized.includes('/Users/'), false);
  assert.equal(serialized.includes('/home/'), false);
  assert.equal(serialized.includes('/private/'), false);
  assert.equal(serialized.includes('C:\\'), false);
  await writeFile(path.join(alpha, 'src', 'index.ts'), 'export function sharedEntry(){ return false; }\n');
  const stale = await instance.searchRepositories({
    root,
    workspaceId: 'ws_fleet',
    query: 'sharedEntry',
    repositoryIds,
    perRepositoryLimit: 10,
    limit: 20
  });
  assert.equal(stale.partial, true);
  assert.equal(stale.results.length, 1);
  assert(stale.perRepository.some(({ repositoryId, state, reasonCodes }) => repositoryId === repositoryIds[0]
    && state === 'unavailable' && reasonCodes.includes('repository_index_stale')));

  await instance.buildIndex({ root: alpha, workspaceId: 'ws_fleet', languages: ['typescript'] });
  await rm(path.join(beta, '.local', 'source-index', 'index.v1.sqlite'));
  const missing = await instance.searchRepositories({
    root,
    workspaceId: 'ws_fleet',
    query: 'sharedEntry',
    repositoryIds,
    perRepositoryLimit: 10,
    limit: 20
  });
  assert.equal(missing.partial, true);
  assert.equal(missing.results.length, 1);
  assert(missing.perRepository.some(({ repositoryId, state, reasonCodes }) => repositoryId === repositoryIds[1]
    && state === 'unavailable' && reasonCodes.includes('repository_index_unavailable')));
});

function repositoryRecord() {
  return {
    repositoryId: REPOSITORY_ID,
    displayName: 'Alpha',
    rootLocator: 'workspace://repositories/alpha',
    indexLocator: 'workspace://repositories/alpha/.local/source-index/index.v1.sqlite',
    repositoryIdentityHash: `sha256:${'d'.repeat(64)}`,
    activeGeneration: 1,
    state: 'ready',
    freshness: 'unverified',
    lastSeenAt: '2026-07-17T00:00:00.000Z'
  };
}

async function fileSnapshot(file) {
  const [bytes, metadata] = await Promise.all([readFile(file), stat(file, { bigint: true })]);
  return { bytes, size: metadata.size, mtimeNs: metadata.mtimeNs };
}

async function waitForFile(file) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await stat(file);
      return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('native repository request was not observed');
}
