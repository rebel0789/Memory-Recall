import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { peakRssMb, timedSpawn } from './timing.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const RUST_BIN = path.join(ROOT, 'rust/target/release/oaf');
const FIXED_NOW = '2026-06-29T00:00:00.000Z';
const SQLITE = '.local/memory.sqlite';
const LEGACY_MCP_TOOLS = new Set(['memory.recall', 'context.profile', 'context.pack']);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', ...options });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stderr || result.stdout}`);
  return result;
}

function runJson(command, args, options = {}) {
  return JSON.parse(run(command, args, options).stdout);
}

function nodeCli(root, args) {
  return runJson(process.execPath, ['apps/cli/oaf.mjs', ...args, '--root', root, '--sqlite', SQLITE, '--format', 'json'], {
    env: { ...process.env, OAF_FIXED_NOW: FIXED_NOW }
  });
}

function rustCli(root, args) {
  return runJson(RUST_BIN, [...args, '--root', root, '--sqlite', SQLITE, '--format', 'json'], {
    env: { ...process.env, OAF_FIXED_NOW: FIXED_NOW }
  });
}

function rpcInput(args) {
  return rpcLines([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory.recall', arguments: args } }
  ]);
}

function rpcLines(messages) {
  return messages.map((message) => JSON.stringify(message)).join('\n');
}

function mcpResponses(command, args, messages, options = {}) {
  const result = run(command, args, {
    input: rpcLines(messages),
    env: { ...process.env, OAF_FIXED_NOW: FIXED_NOW }
  });
  return result.stdout.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

function mcpPayload(command, args, root, recallArgs) {
  const lines = mcpResponses(command, args, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory.recall', arguments: recallArgs } }
  ]);
  assert.equal(lines[0].result.protocolVersion, '2025-06-18');
  return JSON.parse(lines[1].result.content[0].text);
}

function nodeRecall(root, recallArgs) {
  return mcpPayload(process.execPath, ['apps/cli/oaf.mjs', 'mcp', 'server', '--read-only', '--root', root, '--sqlite', SQLITE, '--cursors', '.local/node-recall-cursors.json', '--stdio'], root, recallArgs);
}

function rustRecall(root, recallArgs) {
  return mcpPayload(RUST_BIN, ['mcp', 'server', '--read-only', '--root', root, '--sqlite', SQLITE, '--cursors', '.local/rust-recall-cursors.json', '--stdio'], root, recallArgs);
}

function nodeMcp(root, messages, extra = []) {
  return mcpResponses(process.execPath, ['apps/cli/oaf.mjs', 'mcp', 'server', '--read-only', '--root', root, '--sqlite', SQLITE, ...extra, '--stdio'], messages);
}

function rustMcp(root, messages, extra = []) {
  return mcpResponses(RUST_BIN, ['mcp', 'server', '--read-only', '--root', root, '--sqlite', SQLITE, ...extra, '--stdio'], messages);
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === 'generatedAt' || /fingerprint$/iu.test(key) || key === 'sessionId') {
        out[key] = '<normalized>';
      } else {
        out[key] = normalize(item);
      }
    }
    return out;
  }
  return value;
}

function normalizeMcp(value) {
  if (Array.isArray(value)) return value.map(normalizeMcp);
  const normalized = normalize(value);
  if (Array.isArray(normalized?.result?.tools)) {
    // M4 adds graph/query tools; this legacy harness still verifies the M2 tool subset byte-for-byte.
    normalized.result.tools = normalized.result.tools.filter((tool) => LEGACY_MCP_TOOLS.has(tool.name));
  }
  const content = normalized?.result?.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item?.type === 'text' && typeof item.text === 'string' && item.text.trim().startsWith('{')) {
        item.text = normalize(JSON.parse(item.text));
      }
    }
  }
  return normalized;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertParity(label, rustValue, nodeValue) {
  assert.equal(canonical(normalize(rustValue)), canonical(normalize(nodeValue)), label);
}

function assertMcpParity(label, rustValue, nodeValue) {
  assert.equal(canonical(normalizeMcp(rustValue)), canonical(normalizeMcp(nodeValue)), label);
}

function makeRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaf-rust-m1-'));
  mkdirSync(path.join(root, '.local'), { recursive: true });
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'DECISIONS.md'), [
    '# Decisions',
    '',
    '2026-06-20: Auth tokens expired after 60 minutes.',
    '2026-06-21: Auth token expiry is now 15 minutes and supersedes 60 minutes.'
  ].join('\n'));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'oaf-m1-real-shape' }, null, 2));
  writeFileSync(path.join(root, 'src/auth.mjs'), 'export function issueToken() { return "token"; }\n');
  return root;
}

function writeScenarioA(root) {
  writeFileSync(path.join(root, 'facts.json'), JSON.stringify({ facts: [
    { subject: 'auth', predicate: 'token_expiry', object: '15 minutes', source: 'workspace://./DECISIONS.md', supersedes: { subject: 'auth', predicate: 'token_expiry' }, notes: '2026-03 security review; replaces the 60-minute decision' },
    { subject: 'auth', predicate: 'refresh_tokens', object: 'enabled, 24h', source: 'workspace://./DECISIONS.md' },
    { subject: 'auth', predicate: 'config_path', object: '/Users/rebel/private-config.json', source: 'workspace://DECISIONS.md' },
    { subject: 'auth', predicate: 'credential', object: 'token=SECRETVALUE', source: 'workspace://DECISIONS.md' }
  ] }, null, 2));
}

function writeScenarioB(root) {
  writeFileSync(path.join(root, 'facts.json'), JSON.stringify({ facts: [
    { subject: 'project:open-agent-fabric', predicate: 'memory_backend', object: 'MemoryBackendPort', source: 'workspace://package.json', confidence: 'inferred' },
    { subject: 'MemoryBackendPort', predicate: 'implemented_by', object: 'provider:native:memory', source: 'workspace://package.json' },
    { subject: 'provider:native:memory', predicate: 'uses', object: 'MemoryBackendPort', source: 'workspace://package.json' }
  ] }, null, 2));
}

function entityCounts(root) {
  const db = new DatabaseSync(path.join(root, SQLITE), { readOnly: true });
  try {
    return db.prepare('SELECT name, count(*) AS count FROM memory_entities GROUP BY workspace_id, scope, name ORDER BY name').all();
  } finally {
    db.close();
  }
}

function scenarioA(command) {
  const root = makeRoot();
  writeScenarioA(root);
  const remember = command(root, ['memory', 'remember', '--subject', 'auth', '--predicate', 'token_expiry', '--object', '60 minutes', '--source', 'workspace://DECISIONS.md']);
  const batch = command(root, ['memory', 'remember', '--batch', 'facts.json']);
  assert.equal(batch.summary.recordedCount, 2);
  assert.equal(batch.summary.skippedUnsafeCount, 2);
  assert.deepEqual(batch.skipped.map((item) => ({ index: item.index, subject: item.subject, predicate: item.predicate, reason: item.reason })), [
    { index: 2, subject: 'auth', predicate: 'config_path', reason: 'object must be safe' },
    { index: 3, subject: 'auth', predicate: 'credential', reason: 'object must be safe' }
  ]);
  const approve = command(root, ['memory', 'approve', '--all-from', 'workspace://DECISIONS.md']);
  assert.equal(approve.summary.activeMemoryCreated, 2);
  assert.equal(approve.summary.supersededFactCount, 1);
  return { root, remember, batch, approve };
}

function scenarioB(command) {
  const root = makeRoot();
  writeScenarioB(root);
  const batch = command(root, ['memory', 'remember', '--batch', 'facts.json']);
  assert.equal(batch.summary.recordedCount, 3);
  const approve = command(root, ['memory', 'approve', '--all']);
  assert.equal(approve.summary.activeMemoryCreated, 3);
  return { root, batch, approve };
}

function timed(command, args, options = {}) {
  const started = performance.now();
  const result = timedSpawn(command, args, { cwd: ROOT, encoding: 'utf8', ...options });
  const elapsedMs = performance.now() - started;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return { ms: Number(elapsedMs.toFixed(3)), peakRssMb: peakRssMb(result.stderr) };
}

function benchmark(root) {
  const env = { ...process.env, OAF_FIXED_NOW: FIXED_NOW };
  const benchRoot = makeRoot();
  writeScenarioA(benchRoot);
  const writeLatency = timed(RUST_BIN, ['memory', 'remember', '--batch', 'facts.json', '--root', benchRoot, '--sqlite', SQLITE, '--format', 'json'], { env });
  const approveLatency = timed(RUST_BIN, ['memory', 'approve', '--all', '--root', benchRoot, '--sqlite', SQLITE, '--format', 'json'], { env });
  const recallArgs = { client: 'bench', query: 'auth', subject: 'auth', scope: 'workspace', limit: 20, currentTruthOnly: true };
  const recallLatency = timed(RUST_BIN, ['mcp', 'server', '--read-only', '--root', root, '--sqlite', SQLITE, '--stdio'], { env, input: rpcInput(recallArgs) });
  const lifecycleLatency = timed(RUST_BIN, ['mcp', 'server', '--read-only', '--root', root, '--sqlite', SQLITE, '--stdio'], {
    env,
    input: rpcLines([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'ping', params: {} },
      { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 4, method: 'resources/list', params: {} },
      { jsonrpc: '2.0', id: 5, method: 'prompts/list', params: {} }
    ])
  });
  const profileLatency = timed(RUST_BIN, ['mcp', 'server', '--read-only', '--root', root, '--sqlite', SQLITE, '--stdio'], {
    env,
    input: rpcLines([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'context.profile', arguments: { client: 'bench-profile', objective: 'auth', scope: 'workspace', limit: 20, budget: 4096, currentTruthOnly: true } } }
    ])
  });
  rmSync(benchRoot, { recursive: true, force: true });
  return { writeLatency, approveLatency, recallLatency, lifecycleLatency, profileLatency };
}

if (existsSync(path.join(ROOT, 'docs/product/oaf-rust-supertool-spec.md'))) {
  run('git', ['ls-files', '--error-unmatch', 'docs/product/oaf-rust-supertool-spec.md']);
}
run('cargo', ['build', '--release', '--manifest-path', 'rust/Cargo.toml']);

const nodeA = scenarioA(nodeCli);
const rustA = scenarioA(rustCli);
try {
  assertParity('scenario A remember report', rustA.remember, nodeA.remember);
  assertParity('scenario A batch report', rustA.batch, nodeA.batch);
  assertParity('scenario A approve report', rustA.approve, nodeA.approve);
  const recallArgs = { client: 'scenario-a', query: 'auth', subject: 'auth', scope: 'workspace', limit: 20, currentTruthOnly: true };
  const rustRecallA = rustRecall(rustA.root, recallArgs);
  const nodeRecallRustDbA = nodeRecall(rustA.root, recallArgs);
  assertParity('scenario A recall against Rust DB', rustRecallA, nodeRecallRustDbA);
  const recallText = JSON.stringify(rustRecallA);
  assert.match(recallText, /15 minutes/u);
  assert.match(recallText, /enabled, 24h/u);
  assert.equal(recallText.includes('60 minutes'), false);

  const nodeB = scenarioB(nodeCli);
  const rustB = scenarioB(rustCli);
  try {
    assertParity('scenario B batch report', rustB.batch, nodeB.batch);
    assertParity('scenario B approve report', rustB.approve, nodeB.approve);
    const exactArgs = { client: 'scenario-b-exact', query: 'MemoryBackendPort', scope: 'workspace', limit: 20, currentTruthOnly: true };
    assertParity('scenario B recall exact against Rust DB', rustRecall(rustB.root, exactArgs), nodeRecall(rustB.root, exactArgs));
    const tokenizerRecall = rustRecall(rustB.root, { client: 'scenario-b-tokenizer', query: 'backend', scope: 'workspace', limit: 20, currentTruthOnly: true });
    assert((tokenizerRecall.data?.factCount ?? 0) > 0, JSON.stringify(tokenizerRecall));
    const nodeCounts = entityCounts(nodeB.root);
    assert(nodeCounts.every((item) => item.count === 1), JSON.stringify(nodeCounts));
    const counts = entityCounts(rustB.root);
    assert(counts.every((item) => item.count === 1), JSON.stringify(counts));

    const lifecycleMessages = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'ping', params: {} },
      { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 4, method: 'resources/list', params: {} },
      { jsonrpc: '2.0', id: 5, method: 'prompts/list', params: {} }
    ];
    assertMcpParity('M2 MCP lifecycle/tools/resources/prompts parity', rustMcp(rustB.root, lifecycleMessages), nodeMcp(rustB.root, lifecycleMessages));

    const toolMessages = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory.recall', arguments: { client: 'm2', query: 'MemoryBackendPort', scope: 'workspace', limit: 20, currentTruthOnly: true } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'context.profile', arguments: { client: 'm2', objective: 'MemoryBackendPort', step: 'Verify memory backend', scope: 'workspace', limit: 20, budget: 4096, currentTruthOnly: true } } }
    ];
    assertMcpParity('M2 MCP memory.recall/context.profile parity', rustMcp(rustB.root, toolMessages, ['--cursors', '.local/rust-tools-cursors.json']), nodeMcp(rustB.root, toolMessages, ['--cursors', '.local/node-tools-cursors.json']));

    const deltaMessages = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory.recall', arguments: { client: 'm2-delta', query: 'MemoryBackendPort', scope: 'workspace', limit: 20, currentTruthOnly: true } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory.recall', arguments: { client: 'm2-delta', query: 'MemoryBackendPort', scope: 'workspace', limit: 20, currentTruthOnly: true } } }
    ];
    assertMcpParity('M2 MCP cursor auto-delta parity', rustMcp(rustB.root, deltaMessages, ['--cursors', '.local/rust-delta-cursors.json']), nodeMcp(rustB.root, deltaMessages, ['--cursors', '.local/node-delta-cursors.json']));

    const bench = benchmark(rustA.root);
    console.log(JSON.stringify({
      schemaVersion: '1.0.0',
      command: 'rust recall conformance',
      conformance: {
        scenarioA: 'byte-parity',
        scenarioB: 'byte-parity',
        nodeInternalEntityDedup: 'deduped-by-name',
        mcpLifecycle: 'byte-parity',
        mcpToolsList: 'byte-parity',
        mcpMemoryRecall: 'byte-parity',
        mcpContextProfile: 'byte-parity',
        mcpCursorAutoDelta: 'byte-parity',
        mcpContextPack: 'closed-in-M5: byte-parity covered by rust-intelligence-quality'
      },
      benchmark: {
        nodeBaseline: { coldStartMs: 50, coldStartRssMb: 55, initRecallMs: 60, initRecallRssMb: 60 },
        rust: bench
      }
    }, null, 2));
  } finally {
    rmSync(nodeB.root, { recursive: true, force: true });
    rmSync(rustB.root, { recursive: true, force: true });
  }
} finally {
  rmSync(nodeA.root, { recursive: true, force: true });
  rmSync(rustA.root, { recursive: true, force: true });
}
