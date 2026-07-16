import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const ROOT = path.resolve(import.meta.dirname, '..');
const REPORT_PATH = path.join(ROOT, 'evals', 'code-intelligence', 'results', 'phase5-cross-service.json');
const BINARY = path.join(
  ROOT,
  'rust',
  'target',
  'release',
  process.platform === 'win32' ? 'oaf.exe' : 'oaf'
);
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
const GATEWAY_PREFIX = 'workspace://services/gateway/';
const ORDERS_PREFIX = 'workspace://services/orders/';
const DECOY_PREFIX = 'workspace://services/zzz-decoy/';
const MISSING_PREFIX = 'workspace://services/missing/';

test('Phase 5 cross-service evidence stays bounded, source-backed, and honest through native-preview MCP', (t) => {
  assert.equal(existsSync(REPORT_PATH), true, 'run the Phase 5 cross-service evidence gate first');
  assertStoredReport(JSON.parse(readFileSync(REPORT_PATH, 'utf8')));

  if (!existsSync(BINARY)) {
    t.skip('native release binary is not built');
    return;
  }

  const workspace = mkdtempSync(path.join(os.tmpdir(), 'memory-recall-phase5-mcp-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  writeFixture(workspace);
  const env = {
    ...process.env,
    MEMORY_RECALL_NATIVE_BINARY: BINARY,
    OAF_FIXED_NOW: '2026-07-16T21:30:00.000Z'
  };
  const built = spawnSync(process.execPath, [
    path.join(ROOT, 'apps', 'cli', 'oaf.mjs'),
    'graph', 'index', '--write', '--engine', 'native-preview',
    '--languages', 'typescript', '--root', workspace, '--format', 'json'
  ], { cwd: ROOT, encoding: 'utf8', env });
  assert.equal(built.status, 0, built.stderr);

  const indexPath = path.join(workspace, '.local', 'source-index', 'index.v1.sqlite');
  const before = fileBundleSnapshot(indexPath);
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'repo.architecture', arguments: { limit: 50 } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'code.dependencies', arguments: { query: 'services/gateway/app/api/orders/route.ts', direction: 'outbound', depth: 2, limit: 50 } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'code.trace', arguments: { symbol: 'GET', direction: 'outbound', depth: 3, limit: 50 } } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'code.dependencies', arguments: { query: 'services/gateway/src/unresolved.ts', direction: 'outbound', depth: 2, limit: 50 } } },
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'repo.architecture', arguments: { limit: 50 } } },
    { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'code.dependencies', arguments: { query: 'services/gateway/app/api/orders/route.ts', direction: 'outbound', depth: 2, limit: 50 } } },
    { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'code.trace', arguments: { symbol: 'GET', direction: 'outbound', depth: 3, limit: 50 } } }
  ];
  const served = spawnSync(process.execPath, [
    path.join(ROOT, 'apps', 'cli', 'oaf.mjs'),
    'mcp', 'server', '--read-only', '--engine', 'native-preview', '--root', workspace, '--stdio'
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
    input: requests.map((request) => JSON.stringify(request)).join('\n')
  });
  assert.equal(served.status, 0, served.stderr);
  const responses = served.stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  assert.deepEqual(
    responses.find((entry) => entry.id === 2).result.tools.map((tool) => tool.name).sort(),
    EXPECTED_TOOLS
  );

  const payload = (id) => {
    const response = responses.find((entry) => entry.id === id);
    assert.equal(response?.error, undefined, `MCP response ${id}: ${JSON.stringify(response?.error)}`);
    return JSON.parse(response.result.content[0].text);
  };
  const architecture = payload(3);
  const dependencies = payload(4);
  const trace = payload(5);
  const unresolved = payload(6);
  const repeatedArchitecture = payload(7);
  const repeatedDependencies = payload(8);
  const repeatedTrace = payload(9);

  for (const report of [architecture, dependencies, trace, unresolved, repeatedArchitecture, repeatedDependencies, repeatedTrace]) {
    assert.equal(report.safeguards.readOnly, true);
    assert.equal(report.safeguards.localFilesWritten, 0);
    assert.equal(report.safeguards.rawSourceBodiesIncluded, false);
    assert.equal(report.data.source.kind, 'native-persistent-index-preview');
  }

  assertCrossServiceRelationship(dependencies.data, 'imports');
  assertCrossServiceRelationship(trace.data, 'calls');
  assert(
    architecture.data.processes.some((process) => {
      const nodes = new Map(architecture.data.nodes.map((node) => [node.id, node]));
      const selected = process.nodeIds.map((id) => nodes.get(id)).filter(Boolean);
      return selected.some((node) => node.locator.startsWith(GATEWAY_PREFIX))
        && selected.some((node) => node.locator.startsWith(ORDERS_PREFIX))
        && selected.every((node) => !node.locator.startsWith(DECOY_PREFIX));
    }),
    'repo.architecture must expose a source-backed gateway-to-orders process without selecting the decoy'
  );

  for (const report of [dependencies.data, trace.data, unresolved.data]) {
    assert.equal(report.nodes.some((item) => item.locator.startsWith(DECOY_PREFIX)), false);
    assert.equal(report.nodes.some((item) => item.locator.startsWith(MISSING_PREFIX)), false);
  }
  const unresolvedNodes = new Map(unresolved.data.nodes.map((node) => [node.id, node]));
  assert.equal(
    unresolved.data.relationships.some((relationship) => {
      if (relationship.resolution === 'unresolved') return false;
      const from = unresolvedNodes.get(relationship.fromNodeId);
      const to = unresolvedNodes.get(relationship.toNodeId);
      const fromGateway = Boolean(from?.locator.startsWith(GATEWAY_PREFIX));
      const toGateway = Boolean(to?.locator.startsWith(GATEWAY_PREFIX));
      return fromGateway !== toGateway;
    }),
    false,
    'an unresolved import must not become resolved cross-service evidence'
  );

  assert.deepEqual(stableArchitecture(repeatedArchitecture.data), stableArchitecture(architecture.data));
  assert.deepEqual(stableQuery(repeatedDependencies.data), stableQuery(dependencies.data));
  assert.deepEqual(stableQuery(repeatedTrace.data), stableQuery(trace.data));
  assert.deepEqual(fileBundleSnapshot(indexPath), before);
  assert.equal(served.stdout.includes(workspace), false);
});

function assertStoredReport(report) {
  assert.equal(report.schemaVersion, '1.0.0');
  assert.equal(report.reportVersion, 'memory-recall-code-intelligence-phase5-cross-service-1');
  assert.equal(report.phase, 5);
  assert.equal(report.gateDecision, 'pass');
  assert.deepEqual(report.failures, []);
  assert.match(report.results.crossServiceCallEvidenceId, /^ciedge_[a-f0-9]{32}$/u);
  assert.match(report.results.crossServiceImportEvidenceId, /^ciedge_[a-f0-9]{32}$/u);
  assert(report.results.crossServiceTraceRelationshipIds.includes(report.results.crossServiceCallEvidenceId));
  assert.equal(report.results.sameNameDecoyExcluded, true);
  assert.equal(report.results.unresolvedTargetExcluded, true);
  assert.equal(report.results.evidenceIdsComplete, true);
  assert.equal(report.results.bounded, true);
  assert.match(report.results.deterministicFingerprint, /^sha256:[a-f0-9]{64}$/u);
  assert(report.results.queryWallMs.p95 <= report.inputs.queryDeadlineMs);
  assert.equal(report.results.readQueriesPreservedIndex, true);
  assert.equal(report.claims.crossServiceMonorepoFixture, true);
  assert.equal(report.claims.multiRepository, false);
  assert.equal(report.claims.competitorParity, false);
  assert.equal(report.claims.leadership, false);
  assert.equal(report.claims.millionNodeScale, false);
  assert.match(report.claims.reason, /does not prove independent repository indexes/u);
  assert.match(report.claims.reason, /competitor parity/u);
  assert.deepEqual(report.safeguards, {
    networkCalls: 0,
    modelCalls: 0,
    canonicalMemoryWrites: 0,
    rawSourceStoredInReport: false,
    absolutePathsStoredInReport: false
  });
}

function writeFixture(workspace) {
  const files = new Map([
    ['package.json', JSON.stringify({ name: 'phase5-cross-service-fixture', private: true, workspaces: ['services/*'] }, null, 2)],
    ['services/gateway/package.json', JSON.stringify({ name: '@fixture/gateway', private: true }, null, 2)],
    ['services/orders/package.json', JSON.stringify({ name: '@fixture/orders', private: true }, null, 2)],
    ['services/zzz-decoy/package.json', JSON.stringify({ name: '@fixture/zzz-decoy', private: true }, null, 2)],
    ['services/gateway/app/api/orders/route.ts', [
      "import { handleOrder } from '../../../../orders/src/handler.js';",
      'export function GET() {',
      '  return handleOrder();',
      '}'
    ].join('\n')],
    ['services/orders/src/handler.ts', [
      'export function handleOrder() {',
      '  return persistOrder();',
      '}',
      'function persistOrder() {',
      "  return 'stored';",
      '}'
    ].join('\n')],
    ['services/zzz-decoy/src/handler.ts', [
      'export class DecoyHandler {',
      '  handleOrder() {',
      "    return 'decoy';",
      '  }',
      '}'
    ].join('\n')],
    ['services/gateway/src/unresolved.ts', [
      "import { missingHandler } from '../../missing/src/handler.js';",
      'export function probeMissing() {',
      '  return missingHandler();',
      '}'
    ].join('\n')]
  ]);
  for (const [relative, content] of files) {
    const target = path.join(workspace, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${content}\n`);
  }
}

function assertCrossServiceRelationship(data, kind) {
  const nodes = new Map(data.nodes.map((node) => [node.id, node]));
  assert(
    data.relationships.some((relationship) => {
      const from = nodes.get(relationship.fromNodeId);
      const to = nodes.get(relationship.toNodeId);
      return relationship.kind === kind
        && from?.locator.startsWith(GATEWAY_PREFIX)
        && to?.locator.startsWith(ORDERS_PREFIX)
        && relationship.id.startsWith('ciedge_');
    }),
    `expected source-backed cross-service ${kind} evidence`
  );
}

function stableArchitecture(data) {
  return {
    groups: data.groups.map((item) => item.id),
    processes: data.processes.map((item) => ({ id: item.id, nodeIds: item.nodeIds, relationshipIds: item.relationshipIds })),
    nodes: data.nodes.map((item) => item.id),
    relationships: data.relationships.map((item) => item.id)
  };
}

function stableQuery(data) {
  return {
    nodes: data.nodes.map((item) => item.id),
    relationships: data.relationships.map((item) => item.id)
  };
}

function fileBundleSnapshot(indexPath) {
  return ['', '-wal', '-shm'].map((suffix) => {
    const file = `${indexPath}${suffix}`;
    if (!existsSync(file)) return { suffix, exists: false };
    const metadata = statSync(file, { bigint: true });
    return {
      suffix,
      exists: true,
      bytes: metadata.size.toString(),
      mtimeNs: metadata.mtimeNs.toString(),
      sha256: createHash('sha256').update(readFileSync(file)).digest('hex')
    };
  });
}
