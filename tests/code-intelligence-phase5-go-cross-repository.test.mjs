import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
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
const RECEIPT = path.join(ROOT, 'evals', 'code-intelligence', 'results', 'phase5-go-cross-repository.json');
const EXPECTED_TOOLS = Object.freeze([
  'code.context',
  'code.dependencies',
  'code.impact',
  'code.routes',
  'code.search',
  'code.trace',
  'context.pack',
  'context.profile',
  'memory.recall',
  'repo.architecture',
  'repo.index_status',
  'repo.map'
]);

test('release binary resolves one exact Go module across repositories and excludes an identical decoy', { timeout: 120_000 }, async (t) => {
  await assertStoredReceipt(JSON.parse(await readFile(RECEIPT, 'utf8')));
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

  const cliEnv = {
    ...process.env,
    MEMORY_RECALL_NATIVE_BINARY: BINARY,
    OAF_FIXED_NOW: '2026-07-17T00:00:00.000Z'
  };
  const client = graphRepositories([
    'register', '--write', '--root', fleet, '--repository', 'repositories/client', '--name', 'Client', '--workspace', WORKSPACE_ID, '--format', 'json'
  ], cliEnv).repositories[0];
  const service = graphRepositories([
    'register', '--write', '--root', fleet, '--repository', 'repositories/service', '--name', 'Service', '--workspace', WORKSPACE_ID, '--format', 'json'
  ], cliEnv).repositories[0];
  const decoy = graphRepositories([
    'register', '--write', '--root', fleet, '--repository', 'repositories/decoy', '--name', 'Decoy', '--workspace', WORKSPACE_ID, '--format', 'json'
  ], cliEnv).repositories[0];
  const listedCli = graphRepositories([
    'list', '--read-only', '--root', fleet, '--workspace', WORKSPACE_ID, '--limit', '10', '--format', 'json'
  ], cliEnv);
  assert.equal(listedCli.safeguards.readOnly, true);
  assert.deepEqual(
    new Set(listedCli.repositories.map(({ repositoryId }) => repositoryId)),
    new Set([client.repositoryId, service.repositoryId, decoy.repositoryId])
  );
  const searchedCli = graphRepositories([
    'search', '--read-only', '--root', fleet, '--workspace', WORKSPACE_ID, '--query', 'Service',
    '--repository-ids', `${service.repositoryId},${decoy.repositoryId}`, '--per-repository-limit', '10', '--limit', '20', '--format', 'json'
  ], cliEnv);
  assert.equal(searchedCli.safeguards.readOnly, true);
  assert.deepEqual(
    new Set(searchedCli.results.map(({ repositoryId }) => repositoryId)),
    new Set([service.repositoryId, decoy.repositoryId])
  );
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

  const mcpRequests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'code.search',
        arguments: { query: 'Service', repositoryIds: [service.repositoryId, decoy.repositoryId], limit: 10 }
      }
    },
    {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'repo.index_status', arguments: { scope: 'repositories', limit: 10 } }
    },
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'code.dependencies', arguments: { crossRepository: selectors } }
    },
    {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'code.trace', arguments: { crossRepository: selectors, limit: 10 } }
    },
    {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'code.impact', arguments: { crossRepository: selectors, limit: 10 } }
    },
    {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'code.dependencies', arguments: {} }
    },
    {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'code.dependencies', arguments: { query: 'Build', crossRepository: selectors } }
    },
    {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'code.dependencies', arguments: { crossRepository: selectors, limit: 10 } }
    }
  ];
  const mcp = spawnSync(process.execPath, [
    path.join(ROOT, 'apps', 'cli', 'oaf.mjs'),
    'mcp',
    'server',
    '--read-only',
    '--engine',
    'native',
    '--workspace',
    WORKSPACE_ID,
    '--root',
    fleet,
    '--stdio'
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      MEMORY_RECALL_NATIVE_BINARY: BINARY,
      OAF_FIXED_NOW: '2026-07-17T00:00:00.000Z'
    },
    input: mcpRequests.map((request) => JSON.stringify(request)).join('\n'),
    maxBuffer: 2 * 1024 * 1024,
    timeout: 30_000
  });
  assert.equal(mcp.status, 0, mcp.stderr);
  assert.equal(mcp.error, undefined);
  const mcpResponses = mcp.stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  assert.deepEqual(
    mcpResponses.find(({ id }) => id === 2).result.tools.map(({ name }) => name).sort(),
    EXPECTED_TOOLS
  );
  const mcpPayload = (id) => {
    const response = mcpResponses.find((entry) => entry.id === id);
    assert.equal(response?.error, undefined, `MCP response ${id}: ${JSON.stringify(response?.error)}`);
    return JSON.parse(response.result.content[0].text);
  };
  const searchedMcp = mcpPayload(3);
  const repositoriesMcp = mcpPayload(7);
  const dependenciesMcp = mcpPayload(4);
  const tracedMcp = mcpPayload(5);
  const impactedMcp = mcpPayload(6);
  for (const payload of [searchedMcp, repositoriesMcp, dependenciesMcp, tracedMcp, impactedMcp]) {
    assert.equal(payload.safeguards.readOnly, true);
    assert.equal(payload.safeguards.localFilesWritten, 0);
    assert.equal(payload.safeguards.rawSourceBodiesIncluded, false);
    assert.equal(payload.data.source.kind, 'native-persistent-repository-index');
  }
  assert.deepEqual(
    new Set(searchedMcp.data.results.map(({ repositoryId }) => repositoryId)),
    new Set([service.repositoryId, decoy.repositoryId])
  );
  assert.equal(repositoriesMcp.data.scope, 'repositories');
  assert.equal(repositoriesMcp.data.repositoryCount, 3);
  assert.deepEqual(
    new Set(repositoriesMcp.data.repositories.map(({ repositoryId }) => repositoryId)),
    new Set([client.repositoryId, service.repositoryId, decoy.repositoryId])
  );
  assert(searchedMcp.data.results.some(({ repositoryId, label }) => repositoryId === service.repositoryId && label.includes('Service')));
  assert(searchedMcp.data.results.some(({ repositoryId, label }) => repositoryId === decoy.repositoryId && label.includes('Service')));
  assert.deepEqual(dependenciesMcp.data.relationships, resolved.goRelationships);
  assert.deepEqual(dependenciesMcp.data.modules, resolved.goModules);
  assert.deepEqual(tracedMcp.data.relationships, traced.goRelationships);
  assert.deepEqual(tracedMcp.data.paths, traced.paths);
  assert.deepEqual(impactedMcp.data.relationships, impacted.goRelationships);
  assert.deepEqual(impactedMcp.data.paths, impacted.paths);
  assert.deepEqual(impactedMcp.data.impactedNodes, impacted.impactedNodes);
  for (const payload of [searchedMcp, dependenciesMcp, tracedMcp, impactedMcp]) {
    assert.equal(payload.data.measurements.selectedRepositoryCount, 2);
    assert.equal(payload.data.measurements.openedRepositoryCount, 2);
    assert.equal(payload.data.measurements.localFilesWritten, 0);
  }
  for (const payload of [dependenciesMcp, tracedMcp, impactedMcp]) {
    const text = JSON.stringify(payload);
    assert.equal(text.includes(decoy.repositoryId), false);
    assert.equal(text.includes('example.com/wrong'), false);
    assert.equal(text.includes('workspace://repositories/decoy'), false);
  }
  assert.equal(mcp.stdout.includes(fleet), false);
  assert.equal(mcp.stdout.includes('return &service.Service{}'), false);
  assert.equal(mcp.stdout.includes('return "service"'), false);
  const emptyDependencies = mcpResponses.find((entry) => entry.id === 8).error;
  const mixedDependencies = mcpResponses.find((entry) => entry.id === 9).error;
  const boundedDependencies = mcpResponses.find((entry) => entry.id === 10).error;
  for (const error of [emptyDependencies, mixedDependencies, boundedDependencies]) {
    assert.equal(error.code, -32008);
    assert.equal(error.data.code, 'mcp_tool_failed');
  }
  assert.equal(emptyDependencies.message, 'code.dependencies query is invalid');
  assert.match(mixedDependencies.message, /cannot mix local and cross-repository selectors/u);
  assert.match(boundedDependencies.message, /cannot mix local and cross-repository selectors/u);

  const jsMcp = spawnSync(process.execPath, [
    path.join(ROOT, 'apps', 'cli', 'oaf.mjs'),
    'mcp',
    'server',
    '--read-only',
    '--engine',
    'compatibility',
    '--workspace',
    WORKSPACE_ID,
    '--root',
    fleet,
    '--stdio'
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      MEMORY_RECALL_NATIVE_BINARY: BINARY,
      OAF_FIXED_NOW: '2026-07-17T00:00:00.000Z'
    },
    input: [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'code.dependencies', arguments: { crossRepository: selectors } }
      }
    ].map((request) => JSON.stringify(request)).join('\n'),
    maxBuffer: 2 * 1024 * 1024,
    timeout: 30_000
  });
  assert.equal(jsMcp.status, 2);
  assert.equal(jsMcp.stdout, '');
  assert.match(jsMcp.stderr, /mcp server --engine must be native, native-preview, or auto/u);
  assert.equal(jsMcp.stdout.includes(fleet), false);

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

function graphRepositories(args, env) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'apps', 'cli', 'oaf.mjs'), 'graph', 'repositories', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
    maxBuffer: 2 * 1024 * 1024,
    timeout: 30_000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.error, undefined);
  assert.equal(result.stdout.includes(env.MEMORY_RECALL_NATIVE_BINARY), false);
  return JSON.parse(result.stdout);
}

async function assertStoredReceipt(receipt) {
  assert.equal(receipt.schemaVersion, '1.0.0');
  assert.equal(receipt.receiptVersion, 'memory-recall-phase5-go-cross-repository-1');
  assert.equal(receipt.phase, 5);
  assert.equal(receipt.packageEvidence.installed, true);
  assert.equal(receipt.packageEvidence.providerSource, 'platform-package');
  assert.equal(receipt.packageEvidence.providerVerified, true);
  assert.equal(receipt.packageEvidence.mcpEngine, 'native');
  assert.match(receipt.packageEvidence.rootTarballSha256, /^sha256:[a-f0-9]{64}$/u);
  assert.match(receipt.packageEvidence.nativeTarballSha256, /^sha256:[a-f0-9]{64}$/u);
  assert.match(receipt.implementation.releaseBinarySha256, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(receipt.implementation.fingerprint, await filesFingerprint(receipt.implementation.files));
  assert.equal(receipt.fixture.language, 'go');
  assert.equal(receipt.fixture.selectedIndependentGitRepositoryCount, 2);
  assert.equal(receipt.fixture.selectedGitHeadCommits.length, 2);
  assert(receipt.fixture.selectedGitHeadCommits.every((commit) => /^[a-f0-9]{40}$/u.test(commit)));
  assert.equal(new Set(receipt.fixture.selectedGitHeadCommits).size, 2);
  assert.equal(receipt.fixture.identicalDecoyNativeId, true);
  assert.equal(receipt.fixture.requiredModuleCoordinate, 'example.com/demo');
  assert.equal(receipt.fixture.decoyModuleCoordinate, 'example.com/wrong');
  assert.deepEqual(receipt.results.selectedRepositoryFreshness, ['current', 'current']);
  assert.equal(receipt.results.selectedRepositoryCount, 2);
  assert.equal(receipt.results.openedRepositoryCount, 2);
  assert.equal(receipt.results.exactModuleEvidenceSelected, true);
  assert.equal(receipt.results.identicalDecoyExcluded, true);
  assert.equal(receipt.results.bounded, true);
  assert.equal(receipt.results.sourceBacked, true);
  assert.equal(receipt.results.sqliteBundlesPreserved, true);
  assert.equal(receipt.results.relationshipEvidence.length, 2);
  assert(receipt.results.relationshipEvidence.every((relationship) => (
    relationship.resolution === 'exact_module_coordinate'
      && /^workspace:\/\//u.test(relationship.evidenceLocator)
      && relationship.evidenceNativeRelationshipIds.every((id) => /^ciedge_[a-f0-9]{32}$/u.test(id))
  )));
  assert.deepEqual(receipt.safeguards, {
    readOnlyQueries: true,
    localFilesWrittenByQueries: 0,
    rawSourceBodiesIncluded: false,
    absolutePathsIncluded: false,
    networkCalls: 0,
    modelCalls: 0,
    published: false
  });
  assert.deepEqual(receipt.claims, {
    exactGoCrossRepositoryBehavior: true,
    generalCrossLanguageBehavior: false,
    competitorParity: false,
    productionPublishReady: false
  });
  const comparable = { ...receipt };
  delete comparable.generatedAt;
  delete comparable.receiptFingerprint;
  assert.equal(
    receipt.receiptFingerprint,
    `sha256:${createHash('sha256').update(JSON.stringify(comparable)).digest('hex')}`
  );
  assert.doesNotMatch(JSON.stringify(receipt), /(?:\/Users\/|\/home\/[A-Za-z0-9._-]+\/|\/private\/|\/var\/folders\/|[A-Za-z]:\\)/u);
}

async function filesFingerprint(files) {
  const hash = createHash('sha256');
  for (const relative of [...files].sort()) {
    hash.update(`${relative}\0`);
    hash.update(await readFile(path.join(ROOT, relative)));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}
