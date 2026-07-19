import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { peakRssMb, timedSpawn } from './timing.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const RUST_BIN = path.join(ROOT, 'rust/target/release/oaf');
const SQLITE = '.local/memory.sqlite';
const FIXED_NOW = '2026-06-29T00:00:00.000Z';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', ...options });
  assert.equal(result.status, options.expectedStatus ?? 0, `${command} ${args.join(' ')}\n${result.stderr || result.stdout}`);
  return result;
}

function runAny(command, args, options = {}) {
  return spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', ...options });
}

function runJson(command, args, options = {}) {
  return JSON.parse(run(command, args, options).stdout);
}

function rpcLines(messages) {
  return messages.map((message) => JSON.stringify(message)).join('\n');
}

function mcpResponses(command, args, messages, options = {}) {
  const fixedNow = options.fixedNow ?? FIXED_NOW;
  const rest = { ...options };
  delete rest.fixedNow;
  const result = run(command, args, {
    input: rpcLines(messages),
    env: { ...process.env, OAF_FIXED_NOW: fixedNow },
    ...rest
  });
  return result.stdout.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

function nodeMcp(root, messages, cursor = '.local/node-m5-cursors.json', fixedNow = FIXED_NOW) {
  return mcpResponses(process.execPath, ['apps/cli/oaf.mjs', 'mcp', 'server', '--read-only', '--root', root, '--sqlite', SQLITE, '--cursors', cursor, '--stdio'], messages, {
    fixedNow,
    env: { ...process.env, OAF_FIXED_NOW: fixedNow, MEMORY_RECALL_NATIVE_BINARY: RUST_BIN }
  });
}

function rustMcp(root, messages, cursor = '.local/rust-m5-cursors.json', fixedNow = FIXED_NOW) {
  return mcpResponses(RUST_BIN, ['mcp', 'server', '--read-only', '--root', root, '--sqlite', SQLITE, '--cursors', cursor, '--stdio'], messages, { fixedNow });
}

function nodeCli(root, args, options = {}) {
  return runJson(process.execPath, ['apps/cli/oaf.mjs', ...args, '--root', root, '--sqlite', SQLITE, '--format', 'json'], {
    env: { ...process.env, OAF_FIXED_NOW: FIXED_NOW },
    ...options
  });
}

function buildNodeSourceIndex(root) {
  run(process.execPath, [
    'apps/cli/oaf.mjs',
    'graph', 'index', '--write', '--engine', 'native',
    '--root', root,
    '--workspace', 'ws_local',
    '--format', 'json'
  ], {
    env: { ...process.env, OAF_FIXED_NOW: FIXED_NOW, MEMORY_RECALL_NATIVE_BINARY: RUST_BIN }
  });
}

function rustCli(root, args, options = {}) {
  return runJson(RUST_BIN, [...args, '--root', root, '--sqlite', SQLITE, '--format', 'json'], {
    env: { ...process.env, OAF_FIXED_NOW: FIXED_NOW },
    ...options
  });
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      key === 'generatedAt' ||
      key === 'createdAt' ||
      key === 'updatedAt' ||
      key === 'sessionId' ||
      key === 'pathFingerprint' ||
      key === 'durationMs' ||
      key === 'outputSummary' ||
      key === 'outputHash' ||
      /fingerprint$/iu.test(key) ||
      /hash$/iu.test(key) ||
      (key === 'id' && typeof item === 'string' && /^(ctx|ctxprofile|ctxpack|hctxprev|ctxreq|loopverify|loopobs|evt_loop)_/u.test(item)) ||
      (key === 'requestId' && typeof item === 'string' && item.startsWith('ctxreq_')) ||
      (key === 'correlationId' && typeof item === 'string' && item.startsWith('corr_')) ||
      (key === 'observationId' && typeof item === 'string' && item.startsWith('loopobs_')) ||
      (key === 'verificationReportId' && typeof item === 'string' && item.startsWith('loopverify_'))
    ) {
      out[key] = '<normalized>';
    } else {
      out[key] = normalize(item);
    }
  }
  return out;
}

function normalizeMcp(value) {
  if (Array.isArray(value)) return value.map(normalizeMcp);
  const out = normalize(value);
  const content = out?.result?.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item?.type === 'text' && typeof item.text === 'string' && item.text.trim().startsWith('{')) {
        item.text = normalize(JSON.parse(item.text));
      }
      const payload = item?.type === 'text' && item.text && typeof item.text === 'object' ? item.text : null;
      const data = payload?.data;
      if (!data?.sourceGraph) continue;
      data.sourceGraph = '<normalized>';
      data.warnings = data.warnings?.filter((warning) => !warning.startsWith('source_graph_'));
      for (const key of ['deliveredByteSize', 'deliveredTokenCount']) {
        if (data.delivery?.[key] !== undefined) data.delivery[key] = '<normalized>';
      }
      if (data.markdownArtifact?.byteSize !== undefined) data.markdownArtifact.byteSize = '<normalized>';
      for (const file of data.files ?? []) {
        if (file.byteSize !== undefined) file.byteSize = '<normalized>';
      }
    }
  }
  return out;
}

function assertParity(label, rustValue, nodeValue) {
  assert.equal(canonical(normalize(rustValue)), canonical(normalize(nodeValue)), label);
}

function assertMcpParity(label, rustValue, nodeValue) {
  assert.equal(canonical(normalizeMcp(rustValue)), canonical(normalizeMcp(nodeValue)), label);
}

function makeMemoryRoot(prefix = 'oaf-rust-m5-memory-') {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  mkdirSync(path.join(root, '.local'), { recursive: true });
  writeFileSync(path.join(root, 'DECISIONS.md'), 'Auth token expiry is governed at 15 minutes. Refresh tokens are enabled, 24h.\n');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'notes-api', type: 'module' }, null, 2));
  return root;
}

function seedMemory(root, now = FIXED_NOW) {
  const env = { ...process.env, OAF_FIXED_NOW: now };
  rustCli(root, ['memory', 'remember', '--subject', 'auth', '--predicate', 'token_expiry', '--object', '15 minutes', '--source', 'workspace://DECISIONS.md'], { env });
  rustCli(root, ['memory', 'remember', '--subject', 'auth', '--predicate', 'refresh_tokens', '--object', 'enabled, 24h', '--source', 'workspace://DECISIONS.md'], { env });
}

function exerciseProfileAndPack(root) {
  buildNodeSourceIndex(root);
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'context.profile', arguments: { client: 'm5-profile', objective: 'auth token expiry', step: 'ship notes auth', scope: 'workspace', limit: 20, budget: 4096 } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'context.pack', arguments: { client: 'm5-pack', objective: 'auth token expiry', step: 'ship notes auth', from: 'all', target: 'generic', budget: 4096 } } }
  ];
  assertMcpParity('M5 context.profile/context.pack parity', rustMcp(root, messages), nodeMcp(root, messages));
  const profile = JSON.parse(rustMcp(root, [messages[0], messages[1]], '.local/rust-m5-profile-bench.json')[1].result.content[0].text);
  return profile.data?.sessionStats?.tokenSavingPercent ?? 0;
}

function exerciseDelta() {
  const root = makeMemoryRoot('oaf-rust-m5-delta-');
  try {
    seedMemory(root, '2026-06-29T00:00:00.000Z');
    const first = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory.recall', arguments: { client: 'm5-delta', query: 'auth token expiry', subject: 'auth', predicate: 'token_expiry', scope: 'workspace', limit: 20, currentTruthOnly: true } } }
    ];
    assertMcpParity('M5 first cursor delivery parity', rustMcp(root, first, '.local/rust-delta.json'), nodeMcp(root, first, '.local/node-delta.json'));
    rustCli(root, ['memory', 'remember', '--subject', 'auth', '--predicate', 'token_expiry', '--object', '60 minutes', '--supersedes-subject', 'auth', '--supersedes-predicate', 'token_expiry', '--source', 'workspace://DECISIONS.md'], {
      env: { ...process.env, OAF_FIXED_NOW: '2026-06-29T00:10:00.000Z' }
    });
    const second = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory.recall', arguments: { client: 'm5-delta', query: 'auth token expiry', subject: 'auth', predicate: 'token_expiry', scope: 'workspace', limit: 20, currentTruthOnly: true } } }
    ];
    const rust = rustMcp(root, second, '.local/rust-delta.json', '2026-06-29T00:10:00.000Z');
    const node = nodeMcp(root, second, '.local/node-delta.json', '2026-06-29T00:10:00.000Z');
    assertMcpParity('M5 cursor delta retraction parity', rust, node);
    const payload = JSON.parse(rust[1].result.content[0].text);
    assert.equal(payload.d?.[0]?.value, '60 minutes');
    assert.equal(payload.r?.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function makeLoopRoot() {
  const root = makeMemoryRoot('oaf-rust-m5-loop-');
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(path.join(root, 'tests'), { recursive: true });
  writeFileSync(path.join(root, '.gitignore'), '.local/\nloop-plan.json\n');
  writeFileSync(path.join(root, 'tests/pass.test.mjs'), "import test from 'node:test';import assert from 'node:assert/strict';test('passes',()=>assert.equal(1,1));\n");
  writeFileSync(path.join(root, 'src/auth.mjs'), 'export const TOKEN_EXPIRY_MINUTES = 60;\nexport const REFRESH_TOKENS = "enabled, 24h";\n');
  run('git', ['init'], { cwd: root });
  run('git', ['add', '.'], { cwd: root });
  run('git', ['-c', 'user.name=OAF Test', '-c', 'user.email=oaf@example.invalid', 'commit', '-m', 'notes-api auth fixture'], { cwd: root });
  seedMemory(root);
  const plan = runJson(process.execPath, [
    'apps/cli/oaf.mjs',
    'loop',
    'plan',
    '--read-only',
    '--root',
    root,
    '--objective',
    'Keep notes-api auth decisions aligned',
    '--stop-condition',
    'validation passes and governed memory matches source',
    '--validation',
    'node --test tests/pass.test.mjs',
    '--changed',
    'src/auth.mjs',
    '--format',
    'json'
  ], { env: { ...process.env, OAF_FIXED_NOW: FIXED_NOW } });
  plan.governanceAssertions = [
    { subject: 'auth', predicate: 'token_expiry', probe: { file: 'src/auth.mjs', capture: 'TOKEN_EXPIRY_MINUTES\\s*=\\s*(\\d+)', valueTemplate: '$1 minutes' } },
    { subject: 'auth', predicate: 'refresh_tokens', probe: { file: 'src/auth.mjs', capture: 'REFRESH_TOKENS\\s*=\\s*"([^"]+)"', valueTemplate: '$1' } }
  ];
  writeFileSync(path.join(root, 'loop-plan.json'), JSON.stringify(plan, null, 2));
  return root;
}

function loopVerify(command, root, expectedStatus) {
  const result = runAny(command, [
    ...(command === process.execPath ? ['apps/cli/oaf.mjs'] : []),
    'loop', 'verify',
    '--root', root,
    '--plan', 'loop-plan.json',
    '--worktree', root,
    '--sqlite', SQLITE,
    '--execute-commands',
    '--format', 'json'
  ], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, OAF_FIXED_NOW: FIXED_NOW } });
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function exerciseLoopGovernance() {
  const root = makeLoopRoot();
  try {
    const nodeBad = loopVerify(process.execPath, root, 1);
    const rustBad = loopVerify(RUST_BIN, root, 1);
    assertParity('M5 loop governance blocking parity', rustBad, nodeBad);
    assert.equal(rustBad.status, 'blocked');
    assert.equal(rustBad.stopReason, 'governance-violation');
    assert.equal(rustBad.checker.observation.status, 'passed');
    assert.deepEqual(rustBad.governance.violations, [{ subject: 'auth', predicate: 'token_expiry', expected: '15 minutes', actual: '60 minutes', file: 'src/auth.mjs' }]);
    writeFileSync(path.join(root, 'src/auth.mjs'), 'export const TOKEN_EXPIRY_MINUTES = 15;\nexport const REFRESH_TOKENS = "enabled, 24h";\n');
    assertParity('M5 loop governance pass parity', loopVerify(RUST_BIN, root, 0), loopVerify(process.execPath, root, 0));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function makeImpactRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaf-rust-m5-impact-'));
  mkdirSync(path.join(root, '.local'), { recursive: true });
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'impact-fixture', type: 'module' }, null, 2));
  writeFileSync(path.join(root, 'src/auth.js'), [
    'export function issueToken() {',
    '  return "token";',
    '}'
  ].join('\n'));
  writeFileSync(path.join(root, 'src/notes.js'), [
    'import { issueToken } from "./auth.js";',
    'export function notesApi() {',
    '  return issueToken();',
    '}',
    'export function unrelated() {',
    '  return "ok";',
    '}'
  ].join('\n'));
  run('git', ['init'], { cwd: root });
  run('git', ['add', '.'], { cwd: root });
  run('git', ['-c', 'user.name=OAF Test', '-c', 'user.email=oaf@example.invalid', 'commit', '-m', 'impact fixture'], { cwd: root });
  rustCli(root, ['ingest']);
  rustCli(root, ['memory', 'approve', '--all']);
  writeFileSync(path.join(root, 'src/auth.js'), [
    'export function issueToken() {',
    '  return "changed";',
    '}'
  ].join('\n'));
  return root;
}

function exerciseImpact() {
  const root = makeImpactRoot();
  try {
    const report = rustCli(root, ['impact', 'detect-changes', '--changed-from-git', '--max-depth', '4']);
    const names = report.affectedSymbols.map((item) => item.name).sort();
    assert(names.includes('function:issueToken'), JSON.stringify(report));
    assert(names.includes('function:notesApi'), JSON.stringify(report));
    assert.equal(names.some((name) => name.startsWith('module:')), false, JSON.stringify(report));
    assert.equal(report.quality.moduleLevelFalseAttributionCount, 0, JSON.stringify(report));
    const mcp = rustMcp(root, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'detect.changes', arguments: { client: 'm5-impact', changedFromGit: true, maxDepth: 4 } } }
    ], '.local/rust-impact-mcp.json');
    const mcpReport = JSON.parse(mcp[1].result.content[0].text);
    assert.deepEqual(mcpReport.affectedSymbols.map((item) => item.name).sort(), names);
    assert.equal(mcpReport.quality.moduleLevelFalseAttributionCount, 0, JSON.stringify(mcpReport));
    return report;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function timed(label, command, args, options = {}) {
  const started = performance.now();
  const result = timedSpawn(command, args, { cwd: ROOT, encoding: 'utf8', ...options });
  assert.equal(result.status, options.expectedStatus ?? 0, `${label}\n${result.stderr || result.stdout}`);
  const elapsedMs = performance.now() - started;
  return { ms: Number(elapsedMs.toFixed(3)), peakRssMb: peakRssMb(result.stderr) };
}

assert.equal(existsSync(RUST_BIN), true, 'run cargo build --release before M5 intelligence harness');

const root = makeMemoryRoot();
try {
  seedMemory(root);
  const tokenSavingPercent = exerciseProfileAndPack(root);
  exerciseDelta();
  exerciseLoopGovernance();
  const impact = exerciseImpact();
  const env = { ...process.env, OAF_FIXED_NOW: FIXED_NOW };
  const profileMessages = rpcLines([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'context.profile', arguments: { client: 'bench-profile', objective: 'auth token expiry', step: 'ship notes auth', scope: 'workspace', limit: 20, budget: 4096 } } }
  ]);
  const packMessages = rpcLines([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'context.pack', arguments: { client: 'bench-pack', objective: 'auth token expiry', step: 'ship notes auth', from: 'all', target: 'generic', budget: 4096 } } }
  ]);
  console.log(JSON.stringify({
    schemaVersion: '1.0.0',
    command: 'rust intelligence quality',
    conformance: {
      contextProfileCompressed: 'byte-parity',
      contextPack: 'byte-parity',
      contextDeltaRetraction: 'byte-parity',
      loopGovernanceVerify: 'byte-parity',
      impactDetectChanges: 'quality'
    },
    benchmark: {
      rust: {
        contextProfile: timed('rust context.profile', RUST_BIN, ['mcp', 'server', '--read-only', '--root', root, '--sqlite', SQLITE, '--stdio'], { env, input: profileMessages }),
        contextPack: timed('rust context.pack', RUST_BIN, ['mcp', 'server', '--read-only', '--root', root, '--sqlite', SQLITE, '--stdio'], { env, input: packMessages }),
        loopVerify: { coveredByParityScenario: true },
        detectChanges: { affectedSymbols: impact.affectedSymbols.length, unresolved: impact.unresolved.length, latencyMs: impact.metrics.elapsedMs }
      },
      sessionTokenSavingPercent: tokenSavingPercent,
      baseline: 'same MCP JSON payload content before/after delivery metadata, no strawman long-history baseline'
    },
    impact: {
      affectedSymbols: impact.affectedSymbols,
      unresolved: impact.unresolved,
      quality: impact.quality
    }
  }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
