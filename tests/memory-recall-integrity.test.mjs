import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const cliPath = path.resolve('apps/cli/oaf.mjs');

function mcpResult(lines, id) {
  const response = lines.map((line) => JSON.parse(line)).find((entry) => entry.id === id);
  return JSON.parse(response.result.content[0].text);
}

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

test('MCP initialize reports the public package identity', () => {
  const result = spawnSync(process.execPath, [cliPath, 'mcp', 'server', '--read-only', '--root', '.', '--stdio'], {
    encoding: 'utf8',
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  });
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout.trim());
  assert.equal(response.result.serverInfo.name, 'memory-recall');
  assert.equal(response.result.serverInfo.version, '1.0.5');
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
