import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  NativeCodeIntelligenceError,
  RustCodeIntelligenceProvider
} from '../providers/native/code-intelligence-rust/src/index.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const BINARY = path.join(
  ROOT,
  'rust',
  'target',
  'release',
  process.platform === 'win32' ? 'oaf.exe' : 'oaf'
);
const WORKSPACE_ID = 'ws_go_cross_repo';
const GO_FIXTURE = path.join(ROOT, 'evals', 'code-intelligence', 'fixtures', 'batch-b', 'go');

test('release binary resolves one exact Go module across repositories and excludes an identical decoy', { timeout: 120_000 }, async (t) => {
  const fleet = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-go-cross-repo-'));
  t.after(() => rm(fleet, { recursive: true, force: true }));
  const clientRoot = path.join(fleet, 'repositories', 'client');
  const serviceRoot = path.join(fleet, 'repositories', 'service');
  const decoyRoot = path.join(fleet, 'repositories', 'decoy');
  const [routesSource, serviceSource] = await Promise.all([
    readFile(path.join(GO_FIXTURE, 'api', 'routes.go'), 'utf8'),
    readFile(path.join(GO_FIXTURE, 'service', 'service.go'), 'utf8')
  ]);
  await Promise.all([
    writeFixture(clientRoot, {
      'go.mod': 'module example.com/client\n\ngo 1.22\n\nrequire example.com/demo v0.0.0\n',
      'api/routes.go': routesSource
    }),
    writeFixture(serviceRoot, {
      'go.mod': 'module example.com/demo\n\ngo 1.22\n',
      'service/service.go': serviceSource
    }),
    writeFixture(decoyRoot, {
      'go.mod': 'module example.com/wrong\n\ngo 1.22\n',
      'service/service.go': serviceSource
    })
  ]);

  const provider = new RustCodeIntelligenceProvider({
    binaryPath: BINARY,
    timeoutMs: 60_000,
    maxStdoutBytes: 8_000_000
  });
  for (const root of [clientRoot, serviceRoot, decoyRoot]) {
    await provider.buildIndex({ root, workspaceId: WORKSPACE_ID, languages: ['go'] });
  }
  const [clientEntry, serviceTarget, decoyTarget] = await Promise.all([
    exactNode(provider, clientRoot, 'Build'),
    exactNode(provider, serviceRoot, 'Service'),
    exactNode(provider, decoyRoot, 'Service')
  ]);
  assert.equal(decoyTarget.id, serviceTarget.id, 'the decoy must present the same native symbol identity');

  const client = await register(provider, fleet, 'Client', 'workspace://repositories/client');
  const service = await register(provider, fleet, 'Service', 'workspace://repositories/service');
  const decoy = await register(provider, fleet, 'Decoy', 'workspace://repositories/decoy');
  const selectors = {
    repositoryIds: [client.repositoryId, service.repositoryId],
    clientRepositoryId: client.repositoryId,
    serviceRepositoryId: service.repositoryId,
    clientEntryNativeId: clientEntry.id,
    serviceTargetNativeId: serviceTarget.id
  };

  const resolved = await provider.resolveGoRepositories({ root: fleet, workspaceId: WORKSPACE_ID, ...selectors });
  assert.deepEqual(
    resolved.goModules.map(({ repositoryId, moduleCoordinate, requiredModuleCoordinates }) => ({
      repositoryId,
      moduleCoordinate,
      requiredModuleCoordinates
    })),
    [
      {
        repositoryId: client.repositoryId,
        moduleCoordinate: 'example.com/client',
        requiredModuleCoordinates: ['example.com/demo']
      },
      {
        repositoryId: service.repositoryId,
        moduleCoordinate: 'example.com/demo',
        requiredModuleCoordinates: []
      }
    ]
  );
  const relationships = new Map(resolved.goRelationships.map((relationship) => [relationship.kind, relationship]));
  assert.deepEqual(new Set(relationships.keys()), new Set(['imports', 'constructs']));
  for (const relationship of relationships.values()) {
    assert.equal(relationship.sourceRepositoryId, client.repositoryId);
    assert.equal(relationship.targetRepositoryId, service.repositoryId);
    assert.equal(relationship.resolution, 'exact_module_coordinate');
    assert.match(relationship.id, /^mrrel_[a-f0-9]{32}$/u);
    assert(relationship.evidenceNativeRelationshipIds.every((id) => /^ciedge_[a-f0-9]{32}$/u.test(id)));
  }
  assert.equal(relationships.get('imports').evidenceLocator, 'workspace://api/routes.go#L6-L6');
  assert.equal(relationships.get('constructs').evidenceLocator, 'workspace://api/routes.go#L17-L17');
  const importEvidenceIds = relationships.get('imports').evidenceNativeRelationshipIds;
  const constructEvidenceIds = relationships.get('constructs').evidenceNativeRelationshipIds;
  assert.equal(importEvidenceIds.length, 1);
  assert.equal(constructEvidenceIds.length, 2);
  assert.equal(constructEvidenceIds[0], importEvidenceIds[0]);
  assert.notEqual(constructEvidenceIds[1], importEvidenceIds[0]);

  const traced = await provider.traceGoRepositories({
    root: fleet,
    workspaceId: WORKSPACE_ID,
    ...selectors,
    limit: 10
  });
  assert.deepEqual(traced.paths, [{
    nodeIds: [relationships.get('constructs').fromNodeId, relationships.get('constructs').toNodeId],
    relationshipIds: [relationships.get('constructs').id]
  }]);

  const impacted = await provider.impactGoRepositories({
    root: fleet,
    workspaceId: WORKSPACE_ID,
    ...selectors,
    limit: 10
  });
  assert.deepEqual(impacted.paths, traced.paths);
  assert.deepEqual(impacted.impactedNodes.map(({ repositoryId, nativeId }) => ({ repositoryId, nativeId })), [{
    repositoryId: client.repositoryId,
    nativeId: clientEntry.id
  }]);

  await assert.rejects(
    provider.resolveGoRepositories({
      root: fleet,
      workspaceId: WORKSPACE_ID,
      repositoryIds: [client.repositoryId, decoy.repositoryId],
      clientRepositoryId: client.repositoryId,
      serviceRepositoryId: decoy.repositoryId,
      clientEntryNativeId: clientEntry.id,
      serviceTargetNativeId: decoyTarget.id
    }),
    (error) => error instanceof NativeCodeIntelligenceError && error.code === 'repository_go_module_mismatch'
  );

  const serialized = JSON.stringify({ resolved, traced, impacted });
  assert.equal(serialized.includes(decoy.repositoryId), false);
  assert.equal(serialized.includes(fleet), false);
  assert.equal(serialized.length <= 1_048_576, true);
});

async function writeFixture(root, files) {
  await Promise.all(Object.entries(files).map(async ([relative, contents]) => {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents);
  }));
}

async function exactNode(provider, root, query) {
  const result = await provider.queryIndex({
    root,
    workspaceId: WORKSPACE_ID,
    kind: 'exact',
    query,
    limit: 10
  });
  assert.equal(result.results.length, 1, `${query} must identify one native node`);
  return result.results[0];
}

async function register(provider, root, displayName, rootLocator) {
  const result = await provider.registerRepository({
    root,
    workspaceId: WORKSPACE_ID,
    displayName,
    rootLocator
  });
  assert.equal(result.repositories.length, 1);
  return result.repositories[0];
}
