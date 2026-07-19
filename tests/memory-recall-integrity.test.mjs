import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { SQLiteMemoryProvider } from '../providers/native/memory-sqlite/src/index.mjs';

const cliPath = path.resolve('apps/cli/oaf.mjs');
const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const rustBinary = path.resolve('rust', 'target', 'release', process.platform === 'win32' ? 'oaf.exe' : 'oaf');

function mcpResult(lines, id) {
  const response = lines.map((line) => JSON.parse(line)).find((entry) => entry.id === id);
  return JSON.parse(response.result.content[0].text);
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function enqueueSemanticProposal(provider, root, { id = 'mpq_semantic_pending', tamperPrimaryAlias = false } = {}) {
  const sources = [];
  for (const [index, relativePath] of ['README.md', 'AGENTS.md'].entries()) {
    const bytes = await readFile(path.join(root, relativePath));
    sources.push({ sourceId: `src_${String(index + 1).padStart(3, '0')}`, locator: `workspace://${relativePath}`, sourceHash: sha256(bytes) });
  }
  const sourceFields = {};
  for (const [index, source] of sources.entries()) {
    sourceFields[`semanticSource${index}Id`] = source.sourceId;
    sourceFields[`semanticSource${index}Locator`] = source.locator;
    sourceFields[`semanticSource${index}Hash`] = source.sourceHash;
  }
  await provider.enqueueProposal({
    id,
    workspaceId: 'ws_local',
    sourceLocator: sources[0].locator,
    sourceHash: sources[0].sourceHash,
    payload: {
      kind: 'fact', scope: 'workspace', subject: 'project:semantic-fixture', predicate: 'semantic_status', object: 'reviewed',
      text: 'The semantic fixture is reviewed.', proposalOrigin: 'semantic-setup', approvalMode: 'explicit-id-only',
      extractionConfidence: 'inferred', semanticSourceCount: sources.length,
      semanticSourceId: sources[0].sourceId, semanticSourceLocator: sources[0].locator,
      semanticSourceHash: tamperPrimaryAlias ? `sha256:${'0'.repeat(64)}` : sources[0].sourceHash,
      ...sourceFields
    }
  });
  return sources;
}

test('bulk approval skips semantic proposals, approves ordinary facts, and explicit unchanged approval activates', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-semantic-approval-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.local'), { recursive: true });
  await writeFile(path.join(root, 'README.md'), '# Semantic approval source\n');
  await writeFile(path.join(root, 'AGENTS.md'), '# Secondary semantic source\n');
  const sqlitePath = path.join(root, '.local', 'memory.sqlite');
  const provider = new SQLiteMemoryProvider({ filename: sqlitePath, clock: () => '2026-07-11T12:00:00.000Z' });
  await enqueueSemanticProposal(provider, root);
  await provider.enqueueProposal({
    id: 'mpq_ordinary_pending', workspaceId: 'ws_local', sourceLocator: 'workspace://README.md',
    sourceHash: sha256(await readFile(path.join(root, 'README.md'))),
    payload: { kind: 'fact', scope: 'workspace', subject: 'project:ordinary', predicate: 'status', object: 'approved', text: 'The ordinary fact is approved.' }
  });
  provider.close();
  const env = { ...process.env, OAF_FIXED_NOW: '2026-07-11T12:00:00.000Z' };
  const bulk = spawnSync(process.execPath, [cliPath, 'memory', 'approve', '--all', '--root', root, '--sqlite', '.local/memory.sqlite', '--format', 'json'], { encoding: 'utf8', env });
  assert.equal(bulk.status, 0, bulk.stderr);
  assert.equal(JSON.parse(bulk.stdout).summary.activeMemoryCreated, 1);
  const afterBulk = new SQLiteMemoryProvider({ filename: sqlitePath, clock: () => env.OAF_FIXED_NOW });
  const queueAfterBulk = await afterBulk.listProposalQueue({ workspaceId: 'ws_local' });
  assert.equal(queueAfterBulk.find((item) => item.id === 'mpq_semantic_pending').status, 'pending');
  assert.equal(queueAfterBulk.find((item) => item.id === 'mpq_ordinary_pending').status, 'applied');
  afterBulk.close();

  const mcpInput = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory.recall', arguments: { query: 'semantic status reviewed', scope: 'workspace' } } })
  ].join('\n');
  const recall = spawnSync(process.execPath, [cliPath, 'mcp', 'server', '--read-only', '--root', root, '--sqlite', '.local/memory.sqlite', '--stdio'], { encoding: 'utf8', env, input: mcpInput });
  assert.equal(recall.status, 0, recall.stderr);
  assert.equal(mcpResult(recall.stdout.trim().split(/\n/u), 2).data.proposalFactCount, 0);

  const explicit = spawnSync(process.execPath, [cliPath, 'memory', 'approve', 'mpq_semantic_pending', '--root', root, '--sqlite', '.local/memory.sqlite', '--format', 'json'], { encoding: 'utf8', env });
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(JSON.parse(explicit.stdout).summary.activeMemoryCreated, 1);
  const recallAfterInput = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory.recall', arguments: { client: 'after-explicit', query: 'semantic fixture reviewed', scope: 'workspace' } } })
  ].join('\n');
  const recallAfter = spawnSync(process.execPath, [cliPath, 'mcp', 'server', '--read-only', '--root', root, '--sqlite', '.local/memory.sqlite', '--stdio'], { encoding: 'utf8', env, input: recallAfterInput });
  assert.equal(recallAfter.status, 0, recallAfter.stderr);
  const recalledAfter = mcpResult(recallAfter.stdout.trim().split(/\n/u), 2);
  assert.equal(recalledAfter.data.activeFactCount, 1);
  assert.equal(recalledAfter.data.proposalFactCount, 0);
  assert.equal(recalledAfter.data.activeFacts[0].subject, 'project:semantic-fixture');
});

test('semantic approval rejects changed missing and secondary-source drift without claiming proposals', async (t) => {
  for (const scenario of ['changed-primary', 'missing-primary', 'changed-secondary', 'malformed-binding']) {
    const root = await mkdtemp(path.join(os.tmpdir(), `memory-recall-semantic-${scenario}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, '.local'), { recursive: true });
    await writeFile(path.join(root, 'README.md'), '# Primary semantic source\n');
    await writeFile(path.join(root, 'AGENTS.md'), '# Secondary semantic source\n');
    const sqlitePath = path.join(root, '.local', 'memory.sqlite');
    const provider = new SQLiteMemoryProvider({ filename: sqlitePath, clock: () => '2026-07-11T12:00:00.000Z' });
    await enqueueSemanticProposal(provider, root, { id: `mpq_semantic_${scenario}`, tamperPrimaryAlias: scenario === 'malformed-binding' });
    provider.close();
    if (scenario === 'changed-primary') await writeFile(path.join(root, 'README.md'), '# Changed primary\n');
    if (scenario === 'missing-primary') await rm(path.join(root, 'README.md'));
    if (scenario === 'changed-secondary') await writeFile(path.join(root, 'AGENTS.md'), '# Changed secondary\n');
    const result = spawnSync(process.execPath, [cliPath, 'memory', 'approve', `mpq_semantic_${scenario}`, '--root', root, '--sqlite', '.local/memory.sqlite', '--format', 'json'], { encoding: 'utf8', env: { ...process.env, OAF_FIXED_NOW: '2026-07-11T12:00:00.000Z' } });
    assert.equal(result.status, 2, `${scenario}: ${result.stderr}`);
    assert.match(result.stderr, /semantic_source_changed/);
    const after = new SQLiteMemoryProvider({ filename: sqlitePath, clock: () => '2026-07-11T12:00:00.000Z' });
    const queued = (await after.listProposalQueue({ workspaceId: 'ws_local' }))[0];
    assert.equal(queued.status, 'pending');
    assert.equal(queued.leaseOwner, null);
    assert.equal(queued.attempts, 0);
    assert.equal((await after.listTemporalFacts({ workspaceId: 'ws_local' })).length, 0);
    after.close();
  }
});

test('MCP cursors never suppress a different query for the same client', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-cursor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'facts.json'), JSON.stringify({ facts: [
    { subject: 'alpha', predicate: 'value', object: 'first', source: 'workspace://facts.json' },
    { subject: 'beta', predicate: 'value', object: 'second', source: 'workspace://facts.json' }
  ] }));
  const env = { ...process.env, OAF_FIXED_NOW: '2026-07-09T12:00:00.000Z' };
  for (const args of [
    ['memory', 'remember', '--batch', 'facts.json', '--root', root, '--sqlite', '.local/memory.sqlite', '--format', 'json'],
    ['memory', 'approve', '--all', '--root', root, '--sqlite', '.local/memory.sqlite', '--format', 'json']
  ]) {
    const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
  }
  const input = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory.recall', arguments: { client: 'agent', query: 'alpha', scope: 'workspace' } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory.recall', arguments: { client: 'agent', query: 'beta', scope: 'workspace' } } })
  ].join('\n');
  const result = spawnSync(process.execPath, [cliPath, 'mcp', 'server', '--read-only', '--root', root, '--sqlite', '.local/memory.sqlite', '--stdio'], { encoding: 'utf8', env, input });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(mcpResult(result.stdout.trim().split(/\n/u), 3).data.activeFacts[0].subject, 'beta');
});

test('MCP recall excludes pending proposals unless explicitly requested', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-proposals-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'proposal-fixture' }));
  await writeFile(path.join(root, 'DECISIONS.md'), 'Decision: project:proposal-fixture memory_policy proposal-gated.');
  const env = { ...process.env, OAF_FIXED_NOW: '2026-07-09T12:00:00.000Z' };
  const ingest = spawnSync(process.execPath, [cliPath, 'memory', 'ingest', '--root', root, '--sqlite', '.local/memory.sqlite', '--format', 'json'], { encoding: 'utf8', env });
  assert.equal(ingest.status, 0, ingest.stderr);
  const input = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory.recall', arguments: { query: 'memory policy', scope: 'workspace' } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory.recall', arguments: { query: 'memory policy', scope: 'workspace', includeProposals: true } } })
  ].join('\n');
  const result = spawnSync(process.execPath, [cliPath, 'mcp', 'server', '--read-only', '--root', root, '--sqlite', '.local/memory.sqlite', '--stdio'], { encoding: 'utf8', env, input });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split(/\n/u);
  assert.equal(mcpResult(lines, 2).data.proposalFactCount, 0);
  assert.equal(mcpResult(lines, 3).data.proposalFactCount, 1);
});

test('MCP repo.map separates active facts from proposals and never returns source bodies', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-mcp-map-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, '.local'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'mcp-map-fixture' }));
  await writeFile(path.join(root, 'src', 'index.ts'), 'export function secretImplementation() { return "MCP MAP RAW SOURCE BODY"; }\n');
  const provider = new SQLiteMemoryProvider({
    filename: path.join(root, '.local', 'memory.sqlite'),
    clock: () => '2026-07-11T12:00:00.000Z'
  });
  try {
    await provider.enqueueProposal({
      id: 'mpq_mcp_map_pending',
      workspaceId: 'ws_local',
      sourceLocator: 'workspace://memory/review.md',
      sourceHash: `sha256:${'a'.repeat(64)}`,
      payload: {
        kind: 'fact',
        scope: 'workspace',
        subject: 'project:mcp-map-fixture',
        predicate: 'review_status',
        object: 'pending',
        text: 'MCP MAP PROPOSAL BODY MUST NOT LEAK'
      }
    });
  } finally {
    provider.close();
  }
  const sqliteBefore = await readFile(path.join(root, '.local', 'memory.sqlite'));
  const env = {
    ...process.env,
    MEMORY_RECALL_NATIVE_BINARY: rustBinary,
    OAF_FIXED_NOW: '2026-07-11T12:00:00.000Z'
  };
  const indexed = spawnSync(process.execPath, [
    cliPath, 'graph', 'index', '--write', '--engine', 'native', '--languages', 'typescript',
    '--root', root, '--format', 'json'
  ], { encoding: 'utf8', env });
  assert.equal(indexed.status, 0, indexed.stderr);
  const input = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'repo.map', arguments: { changed: ['src/index.ts'], limit: 5 } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'repo.map', arguments: { changed: [] } } })
  ].join('\n');
  const result = spawnSync(process.execPath, [cliPath, 'mcp', 'server', '--read-only', '--root', root, '--sqlite', '.local/memory.sqlite', '--stdio'], { encoding: 'utf8', env, input });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split(/\n/u);
  const tools = lines.map((line) => JSON.parse(line)).find((entry) => entry.id === 2).result.tools;
  assert.equal(tools.some((tool) => tool.name === 'repo.map'), true);
  const response = mcpResult(lines, 3);
  assert.equal(response.command, 'repo.map');
  assert.equal(response.data.safeguards.readOnly, true);
  assert.equal(response.data.safeguards.canonicalStateMutated, false);
  assert.equal(response.data.memory.activeFacts.length, 0);
  assert.equal(response.data.memory.pendingProposals.length, 1);
  assert.deepEqual(response.data.architecture.impact.changedLocators, ['workspace://src/index.ts']);
  assert.deepEqual(mcpResult(lines, 4).data.architecture.impact.changedLocators, []);
  assert.deepEqual(await readFile(path.join(root, '.local', 'memory.sqlite')), sqliteBefore);
  assert.equal(existsSync(path.join(root, '.local', 'mcp-stats.jsonl')), false);
  assert.equal(existsSync(path.join(root, '.local', 'mcp-cursors.json')), false);
  const serialized = JSON.stringify(response);
  for (const forbidden of ['function secretImplementation', 'MCP MAP RAW SOURCE BODY', 'MCP MAP PROPOSAL BODY MUST NOT LEAK', root, '/Users/rebel']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('MCP initialize reports the public package identity', () => {
  const result = spawnSync(process.execPath, [cliPath, 'mcp', 'server', '--read-only', '--root', '.', '--stdio'], {
    encoding: 'utf8',
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  });
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout.trim());
  assert.equal(response.result.serverInfo.name, 'memory-recall');
  assert.equal(response.result.serverInfo.version, packageJson.version);
});

test('memory review summary makes each proposal value and source reviewable', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'review-fixture' }));
  await writeFile(path.join(root, 'DECISIONS.md'), 'Decision: auth token_expiry 15 minutes.');
  const env = { ...process.env, OAF_FIXED_NOW: '2026-07-09T12:00:00.000Z' };
  const ingest = spawnSync(process.execPath, [cliPath, 'memory', 'ingest', '--root', root, '--sqlite', '.local/memory.sqlite', '--format', 'json'], { encoding: 'utf8', env });
  assert.equal(ingest.status, 0, ingest.stderr);
  const review = spawnSync(process.execPath, [cliPath, 'memory', 'review', '--root', root, '--sqlite', '.local/memory.sqlite', '--format', 'summary'], { encoding: 'utf8', env });
  assert.equal(review.status, 0, review.stderr);
  assert.match(review.stdout, /auth token_expiry = 15 minutes/);
  assert.match(review.stdout, /DECISIONS\.md/);
});
