import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  NativeCodeIntelligenceError,
  RustCodeIntelligenceProvider
} from '../providers/native/code-intelligence-rust/src/index.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURE_ROOT = path.join(ROOT, 'tests', 'fixtures', 'code-intelligence-multi-repository');
const RUST_BINARY = path.join(
  ROOT,
  'rust',
  'target',
  'release',
  process.platform === 'win32' ? 'oaf.exe' : 'oaf'
);
const WORKSPACE_ID = 'ws_multi_repository';
const REPOSITORIES = Object.freeze([
  { name: 'TypeScript', directory: 'typescript', languages: ['typescript'] },
  { name: 'Python', directory: 'python', languages: ['python'] },
  { name: 'Go', directory: 'go', languages: ['go'] }
]);

test('native repository search keeps mixed-language ambiguous results qualified and bounded', async (t) => {
  const fixture = await preparedFleet(t);
  const { provider, fleet, registrations } = fixture;
  const repositoryIds = registrations.map(({ repositoryId }) => repositoryId);
  const registryPath = path.join(fleet, '.local', 'source-index', 'registry.v1.sqlite');
  const indexPaths = REPOSITORIES.map(({ directory }) => indexPath(fleet, directory));
  const before = await snapshots([registryPath, ...indexPaths]);

  const result = await provider.searchRepositories({
    root: fleet,
    workspaceId: WORKSPACE_ID,
    query: 'sharedTarget',
    repositoryIds,
    perRepositoryLimit: 1,
    limit: 3
  });

  assert.equal(result.state, 'ready');
  assert.equal(result.partial, false);
  assert.equal(result.truncated, true);
  assert.equal(result.results.length, 3);
  assert.deepEqual(new Set(result.results.map(({ repositoryId }) => repositoryId)), new Set(repositoryIds));
  assert.equal(new Set(result.results.map(({ id }) => id)).size, 3);
  assert(result.results.every(({ label }) => label.startsWith('sharedTarget')));
  assert(result.results.every(({ locator }) => /^workspace:\/\/.+#L[1-9][0-9]*-L[1-9][0-9]*$/u.test(locator)));
  assert(result.results.every(({ confidence, generation }) => confidence === 1 && generation === 1));
  assert(result.perRepository.every(({ state, resultCount, truncated, reasonCodes }) => (
    state === 'ready' && resultCount === 1 && truncated && reasonCodes.length === 0
  )));
  assert.deepEqual(result.measurements, {
    durationMs: result.measurements.durationMs,
    selectedRepositoryCount: 3,
    openedRepositoryCount: 3,
    resultCount: 3,
    localFilesWritten: 0
  });
  assertReadOnlyEvidence(result, fleet);
  assert.deepEqual(await snapshots([registryPath, ...indexPaths]), before);

  const bounded = await provider.searchRepositories({
    root: fleet,
    workspaceId: WORKSPACE_ID,
    query: 'sharedTarget',
    repositoryIds,
    perRepositoryLimit: 2,
    limit: 2
  });
  assert.equal(bounded.results.length, 2);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.measurements.selectedRepositoryCount, 3);
  assert.equal(bounded.measurements.openedRepositoryCount, 3);
  assertReadOnlyEvidence(bounded, fleet);
  assert.deepEqual(await snapshots([registryPath, ...indexPaths]), before);
});

test('native repository search isolates a missing index and rejects another workspace', async (t) => {
  const { provider, fleet, registrations } = await preparedFleet(t);
  const repositoryIds = registrations.map(({ repositoryId }) => repositoryId);
  const missingRegistration = registrations.find(({ displayName }) => displayName === 'Python');
  const healthyIndexPaths = ['typescript', 'go'].map((directory) => indexPath(fleet, directory));
  const registryPath = path.join(fleet, '.local', 'source-index', 'registry.v1.sqlite');
  const before = await snapshots([registryPath, ...healthyIndexPaths]);
  await rm(indexPath(fleet, 'python'));

  const result = await provider.searchRepositories({
    root: fleet,
    workspaceId: WORKSPACE_ID,
    query: 'sharedTarget',
    repositoryIds,
    perRepositoryLimit: 1,
    limit: 3
  });

  assert.equal(result.state, 'partial');
  assert.equal(result.partial, true);
  assert.equal(result.results.length, 2);
  assert.equal(result.results.some(({ repositoryId }) => repositoryId === missingRegistration.repositoryId), false);
  assert.deepEqual(
    result.perRepository.find(({ repositoryId }) => repositoryId === missingRegistration.repositoryId),
    {
      repositoryId: missingRegistration.repositoryId,
      state: 'unavailable',
      resultCount: 0,
      truncated: false,
      reasonCodes: ['repository_index_unavailable']
    }
  );
  assert.equal(result.measurements.selectedRepositoryCount, 3);
  assert.equal(result.measurements.openedRepositoryCount, 2);
  assert.equal(result.repositories.find(({ repositoryId }) => repositoryId === missingRegistration.repositoryId).state, 'unavailable');
  assertReadOnlyEvidence(result, fleet);
  assert.deepEqual(await snapshots([registryPath, ...healthyIndexPaths]), before);

  await assert.rejects(
    provider.listRepositories({ root: fleet, workspaceId: 'ws_other_repository' }),
    (error) => error instanceof NativeCodeIntelligenceError && error.code === 'repository_registry_wrong_workspace'
  );
  assert.deepEqual(await snapshots([registryPath, ...healthyIndexPaths]), before);
});

test('native repository search exposes a stale index without contaminating healthy repositories', async (t) => {
  const { provider, fleet, registrations } = await preparedFleet(t);
  const repositoryIds = registrations.map(({ repositoryId }) => repositoryId);
  const staleRegistration = registrations.find(({ displayName }) => displayName === 'Python');
  const staleIndexPath = indexPath(fleet, 'python');
  const database = new DatabaseSync(staleIndexPath);
  database.exec("UPDATE index_metadata SET engine_version = 'stale-fixture-engine'");
  database.close();
  const registryPath = path.join(fleet, '.local', 'source-index', 'registry.v1.sqlite');
  const before = await snapshots([registryPath, ...REPOSITORIES.map(({ directory }) => indexPath(fleet, directory))]);

  const listed = await provider.listRepositories({ root: fleet, workspaceId: WORKSPACE_ID });
  const listedStale = listed.repositories.find(({ repositoryId }) => repositoryId === staleRegistration.repositoryId);
  assert.deepEqual(
    { state: listedStale.state, freshness: listedStale.freshness, activeGeneration: listedStale.activeGeneration },
    { state: 'unavailable', freshness: 'stale', activeGeneration: 1 }
  );

  const result = await provider.searchRepositories({
    root: fleet,
    workspaceId: WORKSPACE_ID,
    query: 'sharedTarget',
    repositoryIds,
    perRepositoryLimit: 1,
    limit: 3
  });

  assert.equal(result.state, 'partial');
  assert.equal(result.partial, true);
  assert.equal(result.results.length, 2);
  assert.equal(result.results.some(({ repositoryId }) => repositoryId === staleRegistration.repositoryId), false);
  assert.deepEqual(
    result.perRepository.find(({ repositoryId }) => repositoryId === staleRegistration.repositoryId),
    {
      repositoryId: staleRegistration.repositoryId,
      state: 'unavailable',
      resultCount: 0,
      truncated: false,
      reasonCodes: ['repository_index_stale']
    }
  );
  assert.equal(result.repositories.find(({ repositoryId }) => repositoryId === staleRegistration.repositoryId).freshness, 'stale');
  assertReadOnlyEvidence(result, fleet);
  assert.deepEqual(await snapshots([registryPath, ...REPOSITORIES.map(({ directory }) => indexPath(fleet, directory))]), before);
});

async function preparedFleet(t) {
  const fleet = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-multi-repository-'));
  t.after(() => rm(fleet, { recursive: true, force: true }));
  await cp(FIXTURE_ROOT, path.join(fleet, 'repositories'), { recursive: true });
  const provider = new RustCodeIntelligenceProvider({
    binaryPath: RUST_BINARY,
    timeoutMs: 60_000,
    maxStdoutBytes: 8_000_000,
    maxStderrBytes: 8192
  });
  for (const repository of REPOSITORIES) {
    await provider.buildIndex({
      root: path.join(fleet, 'repositories', repository.directory),
      workspaceId: WORKSPACE_ID,
      languages: repository.languages
    });
  }
  const registrations = [];
  for (const repository of REPOSITORIES) {
    const result = await provider.registerRepository({
      root: fleet,
      workspaceId: WORKSPACE_ID,
      displayName: repository.name,
      rootLocator: `workspace://repositories/${repository.directory}`
    });
    registrations.push(result.repositories[0]);
  }
  return { provider, fleet, registrations };
}

function indexPath(fleet, directory) {
  return path.join(fleet, 'repositories', directory, '.local', 'source-index', 'index.v1.sqlite');
}

async function snapshots(paths) {
  return Promise.all(paths.map(async (file) => {
    const [bytes, metadata] = await Promise.all([readFile(file), stat(file, { bigint: true })]);
    return { bytes, size: metadata.size, mtimeNs: metadata.mtimeNs };
  }));
}

function assertReadOnlyEvidence(result, fleet) {
  assert.equal(result.safeguards.readOnly, true);
  assert.equal(result.safeguards.localFilesWritten, 0);
  assert.equal(result.safeguards.rawSourceBodiesIncluded, false);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(fleet), false);
  assert.equal(serialized.includes('/Users/'), false);
  assert.equal(serialized.includes('/home/'), false);
  assert.equal(serialized.includes('/private/'), false);
  assert.equal(serialized.includes('C:\\'), false);
}
