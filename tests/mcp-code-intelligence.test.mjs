import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXPECTED_TOOLS = [
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
];

test('MCP exposes twelve bounded read-only tools with structural code intelligence', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'memory-recall-mcp-intelligence-'));
  mkdirSync(path.join(root, 'src', 'routes'), { recursive: true });
  mkdirSync(path.join(root, 'src', 'data'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'mcp-intelligence-fixture', type: 'module' }, null, 2));
  writeFileSync(path.join(root, 'src', 'data', 'users.ts'), [
    'export function loadUser() {',
    "  return 'MCP STRUCTURAL RAW SOURCE BODY';",
    '}'
  ].join('\n'));
  writeFileSync(path.join(root, 'src', 'routes', 'users.ts'), [
    "import { loadUser } from '../data/users';",
    'export function GET() {',
    '  return loadUser();',
    '}'
  ].join('\n'));
  writeFileSync(path.join(root, 'src', 'app.ts'), [
    "import { GET } from './routes/users';",
    'export function startServer() {',
    '  return GET();',
    '}'
  ].join('\n'));

  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'repo.architecture', arguments: { limit: 10 } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'repo.index_status', arguments: {} } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'code.search', arguments: { query: 'load user', nodeKinds: ['symbol'], limit: 10 } } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'code.context', arguments: { query: 'loadUser', limit: 10 } } },
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'code.trace', arguments: { symbol: 'GET', direction: 'outbound', depth: 2, limit: 10 } } },
    { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'code.dependencies', arguments: { query: 'src/routes/users.ts', direction: 'outbound', depth: 2, limit: 10 } } },
    { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'code.routes', arguments: { limit: 10 } } }
  ].map((message) => JSON.stringify(message)).join('\n');
  const result = spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'mcp', 'server', '--read-only', '--engine', 'js', '--root', root, '--stdio'], {
    encoding: 'utf8',
    env: { ...process.env, OAF_FIXED_NOW: '2026-07-16T08:00:00.000Z' },
    input
  });
  assert.equal(result.status, 0, result.stderr);
  const responses = result.stdout.trim().split(/\n/u).map((line) => JSON.parse(line));
  const tools = responses.find((entry) => entry.id === 2).result.tools;
  assert.deepEqual(tools.map((tool) => tool.name).sort(), EXPECTED_TOOLS);
  assert(tools.every((tool) => tool.annotations?.sideEffectClass === 'read-only'));

  const payload = (id) => JSON.parse(responses.find((entry) => entry.id === id).result.content[0].text);
  const architecture = payload(3);
  assert.equal(architecture.command, 'repo.architecture');
  assert(architecture.data.entryPoints.some((item) => item.label === 'startServer'));
  assert(architecture.data.groups.length > 0);

  const indexStatus = payload(4);
  assert.equal(indexStatus.command, 'repo.index_status');
  assert.equal(indexStatus.data.status, 'not-built');

  const search = payload(5);
  assert.equal(search.command, 'code.search');
  assert(search.data.results.some((item) => item.label === 'loadUser'));

  const context = payload(6);
  assert.equal(context.command, 'code.context');
  assert.equal(context.data.selected.label, 'loadUser');
  assert(context.data.incoming.some((item) => item.kind === 'calls'));

  const trace = payload(7);
  assert.equal(trace.command, 'code.trace');
  assert(trace.data.paths.some((item) => item.terminalLabel === 'loadUser'));

  const dependencies = payload(8);
  assert.equal(dependencies.command, 'code.dependencies');
  assert(dependencies.data.relationships.some((item) => item.kind === 'imports'));

  const routes = payload(9);
  assert.equal(routes.command, 'code.routes');
  assert(routes.data.routes.some((item) => item.method === 'GET' && item.locator.includes('src/routes/users.ts')));

  for (const id of [3, 4, 5, 6, 7, 8, 9]) {
    const response = payload(id);
    assert.equal(response.safeguards.readOnly, true);
    assert.equal(response.safeguards.localFilesWritten, 0);
    assert.equal(response.safeguards.rawSourceBodiesIncluded, false);
  }
  for (const forbidden of ['MCP STRUCTURAL RAW SOURCE BODY', root, '/Users/rebel']) {
    assert.equal(result.stdout.includes(forbidden), false, forbidden);
  }
});

test('structural MCP tools reject unsafe and unbounded arguments', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'memory-recall-mcp-intelligence-invalid-'));
  writeFileSync(path.join(root, 'index.ts'), 'export function entry() { return true; }');
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'code.trace', arguments: { symbol: 'entry', direction: 'sideways', depth: 9 } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'code.search', arguments: { query: 'entry', locatorPrefix: '../outside', limit: 500 } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'code.search', arguments: { query: '/Users/rebel/private.ts' } } }
  ].map((message) => JSON.stringify(message)).join('\n');
  const result = spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'mcp', 'server', '--read-only', '--engine', 'js', '--root', root, '--stdio'], { encoding: 'utf8', input });
  assert.equal(result.status, 0, result.stderr);
  const responses = result.stdout.trim().split(/\n/u).map((line) => JSON.parse(line));
  assert(responses.find((entry) => entry.id === 2).error);
  assert(responses.find((entry) => entry.id === 3).error);
  assert(responses.find((entry) => entry.id === 4).error);
  assert.equal(result.stdout.includes('../outside'), false);
  assert.equal(result.stdout.includes('/Users/rebel'), false);
});

test('MCP structural tools reuse a persistent index without mutating it', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'memory-recall-mcp-persisted-'));
  writeFileSync(path.join(root, 'index.ts'), 'export function persistedEntry() { return true; }\n');
  const built = spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'graph', 'index', '--write', '--root', root, '--format', 'json'], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const indexPath = path.join(root, '.local', 'source-graph', 'index.v1.json');
  const before = statSync(indexPath).mtimeMs;
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'repo.index_status', arguments: {} } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'code.search', arguments: { query: 'persistedEntry' } } }
  ].map((message) => JSON.stringify(message)).join('\n');
  const result = spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'mcp', 'server', '--read-only', '--engine', 'js', '--root', root, '--stdio'], { encoding: 'utf8', input });
  assert.equal(result.status, 0, result.stderr);
  const responses = result.stdout.trim().split(/\n/u).map((line) => JSON.parse(line));
  const payload = (id) => JSON.parse(responses.find((entry) => entry.id === id).result.content[0].text);
  assert.equal(payload(2).data.status, 'ready');
  assert.equal(payload(3).data.source.kind, 'persistent-index');
  assert(payload(3).data.results.some((item) => item.label === 'persistedEntry'));
  assert.equal(statSync(indexPath).mtimeMs, before);
});

test('explicit native-preview MCP reads the prebuilt SQLite index without rebuilding or mutating it', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'memory-recall-mcp-native-index-'));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(path.join(root, 'app', 'api', 'users'), { recursive: true });
  mkdirSync(path.join(root, '.local'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'index.ts'), [
    'export function main(){ return helper(); }',
    'export function helper(){ return leaf(); }',
    'export function leaf(){ return 1; }',
    'export function mainUtility(){ return 2; }'
  ].join('\n'));
  writeFileSync(path.join(root, 'src', 'worker.py'), 'def worker():\n    return 1\n');
  writeFileSync(path.join(root, 'app', 'api', 'users', 'route.ts'), 'export function GET(){ return { ok: true }; }\n');
  const memoryPath = path.join(root, '.local', 'memory.sqlite');
  writeFileSync(memoryPath, 'governed-memory-sentinel');
  const env = {
    ...process.env,
    MEMORY_RECALL_NATIVE_BINARY: path.resolve('rust', 'target', 'release', process.platform === 'win32' ? 'oaf.exe' : 'oaf'),
    OAF_FIXED_NOW: '2026-07-16T08:00:00.000Z'
  };
  const built = spawnSync(process.execPath, [
    'apps/cli/oaf.mjs', 'graph', 'index', '--write', '--engine', 'native-preview',
    '--languages', 'typescript,python', '--root', root, '--format', 'json'
  ], { encoding: 'utf8', env });
  assert.equal(built.status, 0, built.stderr);
  const indexPath = path.join(root, '.local', 'source-index', 'index.v1.sqlite');
  const indexBefore = readFileSync(indexPath);
  const indexMtimeBefore = statSync(indexPath).mtimeMs;
  const memoryBefore = readFileSync(memoryPath);
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'repo.architecture', arguments: { limit: 20 } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'repo.index_status', arguments: {} } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'code.search', arguments: { query: 'main', limit: 3 } } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'code.context', arguments: { query: 'main', limit: 10 } } },
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'code.trace', arguments: { symbol: 'main', direction: 'outbound', depth: 2, limit: 10 } } },
    { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'code.dependencies', arguments: { query: 'src/index.ts', direction: 'outbound', depth: 2, limit: 10 } } },
    { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'code.routes', arguments: { limit: 10 } } },
    { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'repo.map', arguments: { query: 'main', changed: ['src/index.ts'], limit: 10 } } },
    { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'code.impact', arguments: { changed: ['src/index.ts'], depth: 2, limit: 10 } } },
    { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'repo.architecture', arguments: { limit: 20 } } },
    { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'code.search', arguments: { query: 'main', limit: 3 } } },
    { jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'code.context', arguments: { query: 'main', direction: 'outbound', depth: 2, edgeKinds: ['calls'], limit: 10 } } },
    { jsonrpc: '2.0', id: 15, method: 'tools/call', params: { name: 'code.context', arguments: { query: 'main', edgeKinds: ['calls', 'calls'] } } },
    { jsonrpc: '2.0', id: 16, method: 'tools/call', params: { name: 'code.context', arguments: { query: 'main', edgeKinds: ['contains', 'defines', 'imports', 'exports', 're_exports', 'references', 'calls', 'constructs', 'inherits', 'implements', 'extends', 'mixes_in', 'extends_type', 'part_of', 'entry_point', 'handles_route', 'reads'] } } },
    { jsonrpc: '2.0', id: 17, method: 'tools/call', params: { name: 'code.search', arguments: { query: 'src/index.ts', limit: 1 } } },
    { jsonrpc: '2.0', id: 18, method: 'tools/call', params: { name: 'code.search', arguments: { query: 'main', offset: 1, limit: 1 } } },
    { jsonrpc: '2.0', id: 19, method: 'tools/call', params: { name: 'code.search', arguments: { query: 'main', limit: 1 } } },
    { jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'code.search', arguments: { query: 'main', offset: 1000, limit: 1 } } },
    { jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'code.search', arguments: { query: 'main', offset: 1, cursor: `idxcur_${'a'.repeat(32)}`, limit: 1 } } }
  ];
  const result = spawnSync(process.execPath, [
    'apps/cli/oaf.mjs', 'mcp', 'server', '--read-only', '--engine', 'native-preview', '--root', root, '--stdio'
  ], { encoding: 'utf8', env, input: requests.map((request) => JSON.stringify(request)).join('\n') });
  assert.equal(result.status, 0, result.stderr);
  const responses = result.stdout.trim().split(/\n/u).map((line) => JSON.parse(line));
  const listedTools = responses.find((entry) => entry.id === 2).result.tools;
  assert.equal(listedTools.length, 12);
  assert.deepEqual(listedTools.map((tool) => tool.name).sort(), EXPECTED_TOOLS);
  assert.equal(
    listedTools.find((tool) => tool.name === 'repo.architecture').description,
    'Return bounded architecture groups, communities, entry points, hotspots, and evidence-backed entry-to-sink processes from local source metadata.'
  );
  for (let id = 3; id <= 14; id += 1) {
    const response = responses.find((entry) => entry.id === id);
    assert.equal(response.error, undefined, `tool response ${id}: ${JSON.stringify(response.error)}`);
    const payload = JSON.parse(response.result.content[0].text);
    assert.equal(payload.safeguards.readOnly, true);
    assert.equal(payload.safeguards.localFilesWritten, 0);
    assert.equal(payload.safeguards.rawSourceBodiesIncluded, false);
    const source = payload.data.source ?? payload.data.sourceIndex?.source;
    assert.equal(source.kind, 'native-persistent-index-preview');
  }
  const architecture = JSON.parse(responses.find((entry) => entry.id === 3).result.content[0].text).data;
  const indexStatus = JSON.parse(responses.find((entry) => entry.id === 4).result.content[0].text).data;
  assert.equal(Number.isSafeInteger(indexStatus.omittedCount), true);
  assert.equal(Array.isArray(indexStatus.diagnostics), true);
  const repeatedArchitecture = JSON.parse(responses.find((entry) => entry.id === 12).result.content[0].text).data;
  assert.equal(architecture.retrievalMethod, 'native_index_architecture');
  assert.equal(typeof architecture.completeness.communities.truncated, 'boolean');
  assert.equal(typeof architecture.completeness.processes.truncated, 'boolean');
  assert.equal(typeof architecture.completeness.merged.truncated, 'boolean');
  assert.equal(architecture.truncated, architecture.completeness.communities.truncated || architecture.completeness.processes.truncated || architecture.completeness.merged.truncated || architecture.groups.some((item) => item.truncated) || architecture.processes.some((item) => item.truncated));
  assert.match(architecture.groups[0].id, /^cicommunity_[a-f0-9]{32}$/u);
  assert.equal(architecture.groups[0].algorithmVersion, 'label-propagation-v1');
  assert(architecture.processes.some((item) => item.algorithmVersion === 'entry-path-v1'));
  assert(architecture.entryPoints.some((item) => item.label === 'GET'));
  assert(architecture.hotspots.length > 0);
  assert.deepEqual(
    repeatedArchitecture.groups.map((item) => item.id),
    architecture.groups.map((item) => item.id)
  );
  assert.deepEqual(
    repeatedArchitecture.processes.map((item) => item.id),
    architecture.processes.map((item) => item.id)
  );
  const architectureNodeIds = new Set(architecture.nodes.map((item) => item.id));
  const architectureRelationshipIds = new Set(architecture.relationships.map((item) => item.id));
  for (const process of architecture.processes) {
    assert(process.nodeIds.every((id) => architectureNodeIds.has(id)));
    assert(process.relationshipIds.every((id) => architectureRelationshipIds.has(id)));
    assert(architectureRelationshipIds.has(process.entryRelationshipId));
  }
  assert(architecture.relationships.some((item) => item.kind === 'handles_route' && item.confidence > 0));
  const search = JSON.parse(responses.find((entry) => entry.id === 5).result.content[0].text).data;
  const repeatedSearch = JSON.parse(responses.find((entry) => entry.id === 13).result.content[0].text).data;
  assert.deepEqual(search.results.map((item) => item.label), ['main', 'mainUtility', 'helper']);
  assert.deepEqual(repeatedSearch.results, search.results);
  assert.deepEqual(repeatedSearch.relationships, search.relationships);
  assert(search.results.length <= 3);
  assert(search.relationships.length <= 3);
  const searchResultIds = new Set(search.results.map((item) => item.id));
  assert(search.relationships.some((item) => (
    item.kind === 'calls'
      && item.confidence > 0
      && item.locator.startsWith('workspace://')
      && searchResultIds.has(item.fromNodeId)
      && searchResultIds.has(item.toNodeId)
  )));
  const context = JSON.parse(responses.find((entry) => entry.id === 6).result.content[0].text).data;
  assert(context.relationships.some((item) => item.kind === 'calls' && item.confidence > 0));
  assert.equal(typeof context.completeness.selection.truncated, 'boolean');
  assert.equal(typeof context.completeness.neighborhood.truncated, 'boolean');
  assert.equal(context.truncated, context.completeness.selection.truncated || context.completeness.neighborhood.truncated);
  const constrainedContext = JSON.parse(responses.find((entry) => entry.id === 14).result.content[0].text).data;
  assert.equal(constrainedContext.selected.label, 'main');
  assert.equal(constrainedContext.direction, 'outbound');
  assert.equal(constrainedContext.depth, 2);
  assert.deepEqual(constrainedContext.edgeKinds, ['calls']);
  assert(constrainedContext.related.some((item) => item.label === 'leaf'));
  const contextNodeIds = new Set(constrainedContext.related.map((item) => item.id));
  assert.equal(constrainedContext.relationships.length, 2);
  assert(constrainedContext.relationships.every((item) => (
    item.kind === 'calls'
      && contextNodeIds.has(item.fromNodeId)
      && contextNodeIds.has(item.toNodeId)
  )));
  assert(responses.find((entry) => entry.id === 15).error);
  assert(responses.find((entry) => entry.id === 16).error);
  const offsetPage = JSON.parse(responses.find((entry) => entry.id === 18).result.content[0].text).data;
  assert.equal(offsetPage.offset, 1);
  assert.equal(offsetPage.reachedOffset, 1);
  assert.equal(offsetPage.offsetIncomplete, false);
  const offsetBaseline = JSON.parse(responses.find((entry) => entry.id === 19).result.content[0].text).data;
  assert.notEqual(offsetPage.results[0].id, offsetBaseline.results[0].id);
  const exhaustedOffset = JSON.parse(responses.find((entry) => entry.id === 20).result.content[0].text).data;
  assert.equal(exhaustedOffset.results.length, 0);
  assert.equal(exhaustedOffset.offsetIncomplete, false);
  assert.equal(exhaustedOffset.truncated, false);
  assert.equal(exhaustedOffset.hasMore, false);
  assert.equal(exhaustedOffset.nextCursor, null);
  assert.match(responses.find((entry) => entry.id === 21).error.message, /cursor cannot be combined with a non-zero offset/u);
  const firstPage = JSON.parse(responses.find((entry) => entry.id === 17).result.content[0].text).data;
  assert.equal(firstPage.results.length, 1);
  assert.equal(firstPage.truncated, true);
  assert.equal(firstPage.hasMore, true);
  assert.match(firstPage.nextCursor, /^idxcur_[a-f0-9]{32}$/u);
  const continued = spawnSync(process.execPath, [
    'apps/cli/oaf.mjs', 'mcp', 'server', '--read-only', '--engine', 'native-preview', '--root', root, '--stdio'
  ], {
    encoding: 'utf8',
    env,
    input: [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'code.search', arguments: { query: 'src/index.ts', limit: 1, cursor: firstPage.nextCursor } } }
    ].map((request) => JSON.stringify(request)).join('\n')
  });
  assert.equal(continued.status, 0, continued.stderr);
  const continuedResponses = continued.stdout.trim().split(/\n/u).map((line) => JSON.parse(line));
  const secondPage = JSON.parse(continuedResponses.find((entry) => entry.id === 2).result.content[0].text).data;
  assert.equal(secondPage.results.length, 1);
  assert.notEqual(secondPage.results[0].id, firstPage.results[0].id);
  const routes = JSON.parse(responses.find((entry) => entry.id === 9).result.content[0].text).data;
  assert(routes.routes.some((item) => item.locator.includes('app/api/users/route.ts')));
  assert(routes.relationships.some((item) => item.kind === 'handles_route' && item.confidence > 0));
  assert.deepEqual(readFileSync(indexPath), indexBefore);
  assert.equal(statSync(indexPath).mtimeMs, indexMtimeBefore);
  assert.deepEqual(readFileSync(memoryPath), memoryBefore);
  assert.equal(result.stdout.includes(root), false);
  const constrainedJs = spawnSync(process.execPath, [
    'apps/cli/oaf.mjs', 'mcp', 'server', '--read-only', '--engine', 'js', '--root', root, '--stdio'
  ], {
    encoding: 'utf8',
    env,
    input: [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'code.context', arguments: { query: 'main', depth: 2 } } }
    ].map((request) => JSON.stringify(request)).join('\n')
  });
  assert.equal(constrainedJs.status, 0, constrainedJs.stderr);
  const constrainedJsResponse = constrainedJs.stdout.trim().split(/\n/u).map((line) => JSON.parse(line)).find((entry) => entry.id === 2);
  assert.match(constrainedJsResponse.error.message, /code\.context constraints require a current native index/u);
});

test('default graph and MCP reads select a current native index and preserve it', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'memory-recall-mcp-auto-current-'));
  writeFileSync(path.join(root, 'main.ts'), 'export function autoNativeEntry(){ return 1; }\n');
  writeFileSync(path.join(root, 'worker.py'), 'def auto_python_entry():\n    return 2\n');
  writeFileSync(path.join(root, 'worker.go'), 'package worker\nfunc AutoGoEntry() int { return 3 }\n');
  const binary = path.resolve('rust', 'target', 'release', process.platform === 'win32' ? 'oaf.exe' : 'oaf');
  const env = { ...process.env, MEMORY_RECALL_NATIVE_BINARY: binary };
  const built = spawnSync(process.execPath, [
    'apps/cli/oaf.mjs', 'graph', 'index', '--write', '--engine', 'native-preview',
    '--languages', 'typescript,python,go', '--root', root, '--format', 'json'
  ], { encoding: 'utf8', env });
  assert.equal(built.status, 0, built.stderr);
  const indexPath = path.join(root, '.local', 'source-index', 'index.v1.sqlite');
  const before = readFileSync(indexPath);
  const beforeMtime = statSync(indexPath).mtimeMs;
  const graph = spawnSync(process.execPath, [
    'apps/cli/oaf.mjs', 'graph', 'search', '--root', root, '--query', 'autoNativeEntry', '--format', 'json'
  ], { encoding: 'utf8', env });
  assert.equal(graph.status, 0, graph.stderr);
  const graphReport = JSON.parse(graph.stdout);
  assert.equal(graphReport.engine.requested, 'auto');
  assert.equal(graphReport.engine.selection, 'native-preview');
  assert.equal(graphReport.engine.reason, 'native_index_current');
  assert.equal(graphReport.engine.previewOnly, false);
  assert.equal(graphReport.engine.publicDefaultChanged, true);
  assert(graphReport.search.results.some((item) => item.label === 'autoNativeEntry'));
  assert.deepEqual(readFileSync(indexPath), before);
  assert.equal(statSync(indexPath).mtimeMs, beforeMtime);
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'repo.index_status', arguments: {} } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'code.search', arguments: { query: 'autoNativeEntry' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'repo.architecture', arguments: { limit: 10 } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'code.context', arguments: { query: 'autoNativeEntry' } } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'code.trace', arguments: { symbol: 'autoNativeEntry' } } },
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'code.dependencies', arguments: { query: 'main.ts' } } },
    { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'code.routes', arguments: {} } },
    { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'repo.map', arguments: { query: 'autoNativeEntry', changed: ['main.ts'] } } },
    { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'code.impact', arguments: { changed: ['main.ts'] } } },
    { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'code.search', arguments: { query: 'auto_python_entry' } } },
    { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'code.search', arguments: { query: 'AutoGoEntry' } } }
  ].map((message) => JSON.stringify(message)).join('\n');
  const result = spawnSync(process.execPath, [
    'apps/cli/oaf.mjs', 'mcp', 'server', '--read-only', '--root', root, '--stdio'
  ], { encoding: 'utf8', env, input });
  assert.equal(result.status, 0, result.stderr);
  const responses = result.stdout.trim().split(/\n/u).map((line) => JSON.parse(line));
  const payload = (id) => JSON.parse(responses.find((entry) => entry.id === id).result.content[0].text);
  assert.equal(payload(2).data.status, 'ready');
  assert.equal(payload(2).data.source.kind, 'native-persistent-index-preview');
  assert.equal(payload(3).data.source.kind, 'native-persistent-index-preview');
  assert(payload(3).data.results.some((item) => item.label === 'autoNativeEntry'));
  assert(payload(11).data.results.some((item) => item.label === 'auto_python_entry'));
  assert(payload(12).data.results.some((item) => item.label === 'AutoGoEntry'));
  for (let id = 4; id <= 10; id += 1) {
    assert.equal(payload(id).data.source.kind, 'native-persistent-index-preview', `tool response ${id}`);
  }
  assert.deepEqual(readFileSync(indexPath), before);
  assert.equal(statSync(indexPath).mtimeMs, beforeMtime);
});

test('explicit auto MCP falls back to a fresh JS scan when the native index is stale', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'memory-recall-mcp-auto-stale-'));
  const sourcePath = path.join(root, 'main.ts');
  writeFileSync(sourcePath, 'export function staleNativeEntry(){ return 1; }\n');
  const binary = path.resolve('rust', 'target', 'release', process.platform === 'win32' ? 'oaf.exe' : 'oaf');
  const env = { ...process.env, MEMORY_RECALL_NATIVE_BINARY: binary };
  const built = spawnSync(process.execPath, [
    'apps/cli/oaf.mjs', 'graph', 'index', '--write', '--engine', 'native-preview',
    '--languages', 'typescript', '--root', root, '--format', 'json'
  ], { encoding: 'utf8', env });
  assert.equal(built.status, 0, built.stderr);
  const indexPath = path.join(root, '.local', 'source-index', 'index.v1.sqlite');
  const before = readFileSync(indexPath);
  const beforeMtime = statSync(indexPath).mtimeMs;
  writeFileSync(sourcePath, 'export function freshJsFallback(){ return 2; }\n');
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'repo.index_status', arguments: {} } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'code.search', arguments: { query: 'freshJsFallback' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'repo.architecture', arguments: { limit: 10 } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'code.context', arguments: { query: 'freshJsFallback' } } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'code.trace', arguments: { symbol: 'freshJsFallback' } } },
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'code.dependencies', arguments: { query: 'main.ts' } } },
    { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'code.routes', arguments: {} } },
    { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'repo.map', arguments: { query: 'freshJsFallback', changed: ['main.ts'] } } },
    { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'code.impact', arguments: { changed: ['main.ts'] } } }
  ].map((message) => JSON.stringify(message)).join('\n');
  const result = spawnSync(process.execPath, [
    'apps/cli/oaf.mjs', 'mcp', 'server', '--read-only', '--engine', 'auto', '--root', root, '--stdio'
  ], { encoding: 'utf8', env, input });
  assert.equal(result.status, 0, result.stderr);
  const responses = result.stdout.trim().split(/\n/u).map((line) => JSON.parse(line));
  const payload = (id) => JSON.parse(responses.find((entry) => entry.id === id).result.content[0].text);
  assert.equal(payload(2).data.status, 'stale');
  assert.equal(payload(2).data.automaticSelection.engine, 'js');
  assert.equal(payload(2).data.automaticSelection.reason, 'native_index_stale');
  assert(payload(3).data.results.some((item) => item.label === 'freshJsFallback'));
  for (let id = 3; id <= 10; id += 1) {
    assert.notEqual(payload(id).data.source.kind, 'native-persistent-index-preview', `tool response ${id}`);
    assert.equal(payload(id).data.source.reason, 'native_index_stale', `tool response ${id}`);
  }
  assert.deepEqual(readFileSync(indexPath), before);
  assert.equal(statSync(indexPath).mtimeMs, beforeMtime);
  assert.equal(existsSync(`${indexPath}-wal`), false);
  assert.equal(existsSync(`${indexPath}-shm`), false);
});

test('explicit auto MCP uses bounded JS when the native binary or index is unavailable', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'memory-recall-mcp-auto-unavailable-'));
  writeFileSync(path.join(root, 'index.ts'), 'export function unavailableNativeFallback(){ return true; }\n');
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'code.search', arguments: { query: 'unavailableNativeFallback' } } }
  ].map((message) => JSON.stringify(message)).join('\n');
  const result = spawnSync(process.execPath, [
    'apps/cli/oaf.mjs', 'mcp', 'server', '--read-only', '--engine', 'auto', '--root', root, '--stdio'
  ], {
    encoding: 'utf8',
    input,
    env: { ...process.env, MEMORY_RECALL_NATIVE_BINARY: path.join(root, 'missing-native-binary') }
  });
  assert.equal(result.status, 0, result.stderr);
  const response = result.stdout.trim().split(/\n/u).map((line) => JSON.parse(line)).find((entry) => entry.id === 2);
  const payload = JSON.parse(response.result.content[0].text);
  assert.equal(payload.data.source.reason, 'native_unavailable');
  assert(payload.data.results.some((item) => item.label === 'unavailableNativeFallback'));
  const binary = path.resolve('rust', 'target', 'release', process.platform === 'win32' ? 'oaf.exe' : 'oaf');
  const absent = spawnSync(process.execPath, [
    'apps/cli/oaf.mjs', 'mcp', 'server', '--read-only', '--engine', 'auto', '--root', root, '--stdio'
  ], { encoding: 'utf8', input, env: { ...process.env, MEMORY_RECALL_NATIVE_BINARY: binary } });
  assert.equal(absent.status, 0, absent.stderr);
  const absentResponse = absent.stdout.trim().split(/\n/u).map((line) => JSON.parse(line)).find((entry) => entry.id === 2);
  const absentPayload = JSON.parse(absentResponse.result.content[0].text);
  assert.equal(absentPayload.data.source.reason, 'native_index_absent');
  assert(absentPayload.data.results.some((item) => item.label === 'unavailableNativeFallback'));
});

test('explicit auto MCP rechecks freshness between structural calls', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'memory-recall-mcp-auto-recheck-'));
  const sourcePath = path.join(root, 'main.ts');
  writeFileSync(sourcePath, 'export function currentNativeResult(){ return 1; }\n');
  const binary = path.resolve('rust', 'target', 'release', process.platform === 'win32' ? 'oaf.exe' : 'oaf');
  const env = { ...process.env, MEMORY_RECALL_NATIVE_BINARY: binary };
  const built = spawnSync(process.execPath, [
    'apps/cli/oaf.mjs', 'graph', 'index', '--write', '--engine', 'native-preview',
    '--languages', 'typescript', '--root', root, '--format', 'json'
  ], { encoding: 'utf8', env });
  assert.equal(built.status, 0, built.stderr);
  const child = spawn(process.execPath, [
    'apps/cli/oaf.mjs', 'mcp', 'server', '--read-only', '--engine', 'auto', '--root', root, '--stdio'
  ], { cwd: path.resolve('.'), env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGTERM'));
  let stderr = '';
  let stdoutBuffer = '';
  const pending = new Map();
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/u);
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines.filter(Boolean)) {
      const response = JSON.parse(line);
      pending.get(response.id)?.(response);
      pending.delete(response.id);
    }
  });
  const request = (message) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(message.id);
      reject(new Error(`MCP response timed out; stderr=${stderr}`));
    }, 2000);
    pending.set(message.id, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
    child.stdin.write(`${JSON.stringify(message)}\n`);
  });
  await request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const current = await request({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'code.search', arguments: { query: 'currentNativeResult' } } });
  const currentPayload = JSON.parse(current.result.content[0].text);
  assert.equal(currentPayload.data.source.kind, 'native-persistent-index-preview');
  writeFileSync(sourcePath, 'export function freshJsAfterMutation(){ return 2; }\n');
  const stale = await request({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'code.search', arguments: { query: 'freshJsAfterMutation' } } });
  const stalePayload = JSON.parse(stale.result.content[0].text);
  assert.equal(stalePayload.data.source.reason, 'native_index_stale');
  assert(stalePayload.data.results.some((item) => item.label === 'freshJsAfterMutation'));
  child.stdin.end();
});

test('default MCP falls back safely and strict native failures give the matching recovery action', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'memory-recall-mcp-native-off-'));
  writeFileSync(path.join(root, 'index.ts'), 'export function mcpDefault(){ return true; }\n');
  const missingBinary = path.join(root, 'missing-native');
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'code.search', arguments: { query: 'mcpDefault' } } }
  ].map((message) => JSON.stringify(message)).join('\n');
  const result = spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'mcp', 'server', '--read-only', '--root', root, '--stdio'], {
    encoding: 'utf8',
    input,
    env: { ...process.env, MEMORY_RECALL_NATIVE_BINARY: missingBinary }
  });
  assert.equal(result.status, 0, result.stderr);
  const fallbackResponse = result.stdout.trim().split(/\n/u).map((line) => JSON.parse(line)).find(({ id }) => id === 2);
  const fallback = JSON.parse(fallbackResponse.result.content[0].text);
  assert.equal(fallback.data.source.reason, 'native_unavailable');
  assert(fallback.data.results.some((item) => item.label === 'mcpDefault'));

  const strict = spawnSync(process.execPath, [
    'apps/cli/oaf.mjs', 'mcp', 'server', '--read-only', '--engine', 'native-preview', '--root', root, '--stdio'
  ], {
    encoding: 'utf8',
    input,
    env: { ...process.env, MEMORY_RECALL_NATIVE_BINARY: missingBinary }
  });
  assert.equal(strict.status, 0, strict.stderr);
  const strictResponse = strict.stdout.trim().split(/\n/u).map((line) => JSON.parse(line)).find(({ id }) => id === 2);
  assert.match(strictResponse.error.message, /native_engine_unavailable/u);
  assert.match(strictResponse.error.message, /@memory-recall\/native-/u);

  const absent = spawnSync(process.execPath, [
    'apps/cli/oaf.mjs', 'mcp', 'server', '--read-only', '--engine', 'native-preview', '--root', root, '--stdio'
  ], {
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      MEMORY_RECALL_NATIVE_BINARY: path.resolve('rust', 'target', 'release', process.platform === 'win32' ? 'oaf.exe' : 'oaf')
    }
  });
  assert.equal(absent.status, 0, absent.stderr);
  const absentResponse = absent.stdout.trim().split(/\n/u).map((line) => JSON.parse(line)).find(({ id }) => id === 2);
  assert.match(absentResponse.error.message, /source_index_(?:build_required|query_unavailable)/u);
  assert.match(absentResponse.error.message, /recall graph index --write --engine native-preview --root \. --format summary/u);
  assert.doesNotMatch(absentResponse.error.message, /@memory-recall\/native-/u);
});
