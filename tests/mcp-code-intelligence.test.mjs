import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
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
  const result = spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'mcp', 'server', '--read-only', '--root', root, '--stdio'], {
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
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'code.search', arguments: { query: 'entry', locatorPrefix: '../outside', limit: 500 } } }
  ].map((message) => JSON.stringify(message)).join('\n');
  const result = spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'mcp', 'server', '--read-only', '--root', root, '--stdio'], { encoding: 'utf8', input });
  assert.equal(result.status, 0, result.stderr);
  const responses = result.stdout.trim().split(/\n/u).map((line) => JSON.parse(line));
  assert(responses.find((entry) => entry.id === 2).error);
  assert(responses.find((entry) => entry.id === 3).error);
  assert.equal(result.stdout.includes('../outside'), false);
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
  const result = spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'mcp', 'server', '--read-only', '--root', root, '--stdio'], { encoding: 'utf8', input });
  assert.equal(result.status, 0, result.stderr);
  const responses = result.stdout.trim().split(/\n/u).map((line) => JSON.parse(line));
  const payload = (id) => JSON.parse(responses.find((entry) => entry.id === id).result.content[0].text);
  assert.equal(payload(2).data.status, 'ready');
  assert.equal(payload(3).data.source.kind, 'persistent-index');
  assert(payload(3).data.results.some((item) => item.label === 'persistedEntry'));
  assert.equal(statSync(indexPath).mtimeMs, before);
});
