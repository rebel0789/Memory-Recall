import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const RUST_BIN = path.join(ROOT, 'rust/target/release/oaf');
const SQLITE = '.local/memory.sqlite';
const FIXED_NOW = '2026-06-29T00:00:00.000Z';
const HISTORICAL_NOW = '2026-06-29T00:10:00.000Z';
const CURRENT_NOW = '2026-06-29T00:20:00.000Z';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, OAF_FIXED_NOW: FIXED_NOW },
    ...options
  });
  assert.equal(result.status, options.expectedStatus ?? 0, `${command} ${args.join(' ')}\n${result.stderr || result.stdout}`);
  return result;
}

function timed(command, args, options = {}) {
  const started = performance.now();
  const result = run(command, args, options);
  return { result, ms: Number((performance.now() - started).toFixed(3)) };
}

function runJson(command, args, options = {}) {
  return JSON.parse(run(command, args, options).stdout);
}

function rust(root, args, options = {}) {
  return runJson(RUST_BIN, [...args, '--root', root, '--sqlite', SQLITE, '--format', 'json'], options);
}

function dependencyList() {
  if (process.platform === 'darwin') return run('otool', ['-L', RUST_BIN]).stdout.trim();
  if (process.platform === 'linux') return run('ldd', [RUST_BIN]).stdout.trim();
  return run('file', [RUST_BIN]).stdout.trim();
}

function assertExpectedDeps(text) {
  if (process.platform === 'darwin') {
    const bad = text.split(/\r?\n/u).slice(1).map((line) => line.trim().split(/\s+/u)[0]).filter((dep) => dep && !dep.startsWith('/usr/lib/') && !dep.startsWith('/System/Library/'));
    assert.deepEqual(bad, [], `unexpected non-system dynamic deps: ${bad.join(', ')}`);
  }
}

function rpcLines(messages) {
  return messages.map((message) => JSON.stringify(message)).join('\n');
}

function mcpRoundTrip(root) {
  const result = run(RUST_BIN, ['mcp', 'server', '--read-only', '--root', root, '--sqlite', SQLITE, '--stdio'], {
    input: rpcLines([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }
    ])
  });
  const responses = result.stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  assert.equal(responses[0].result.protocolVersion, '2025-06-18');
  assert.equal(responses[1].result.tools.some((tool) => tool.name === 'memory.recall'), true);
  return responses.length;
}

function makeMemoryRoot(prefix = 'oaf-rust-m6-') {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  mkdirSync(path.join(root, '.local'), { recursive: true });
  writeFileSync(path.join(root, 'DECISIONS.md'), '# M6 fixture\n');
  return root;
}

function seedGraph(root) {
  rust(root, ['memory', 'remember', '--subject', 'notes-api', '--predicate', 'DEFINES', '--object', 'function:notesApi', '--source', 'workspace://src/notes.js'], {
    env: { ...process.env, OAF_FIXED_NOW: HISTORICAL_NOW }
  });
  rust(root, ['memory', 'remember', '--subject', 'decision:m6-offline-ui', '--predicate', 'GOVERNS', '--object', 'oaf ui', '--source', 'workspace://DECISIONS.md'], {
    env: { ...process.env, OAF_FIXED_NOW: HISTORICAL_NOW }
  });
  rust(root, ['memory', 'remember', '--subject', 'auth', '--predicate', 'uses', '--object', 'hmac-session-tokens', '--source', 'workspace://DECISIONS.md'], {
    env: { ...process.env, OAF_FIXED_NOW: HISTORICAL_NOW }
  });
  rust(root, ['memory', 'remember', '--subject', 'auth', '--predicate', 'uses', '--object', 'signed-session-tokens', '--supersedes-subject', 'auth', '--supersedes-predicate', 'uses', '--source', 'workspace://DECISIONS.md'], {
    env: { ...process.env, OAF_FIXED_NOW: CURRENT_NOW }
  });
}

function listFiles(root) {
  const files = [];
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      const absolute = path.join(dir, name);
      const relative = path.relative(root, absolute).replaceAll(path.sep, '/');
      const stat = statSync(absolute);
      if (stat.isDirectory()) walk(absolute);
      else files.push([relative, readFileSync(absolute, 'utf8')]);
    }
  }
  if (existsSync(root)) walk(root);
  files.sort(([a], [b]) => a.localeCompare(b));
  return files;
}

function assertAllInside(paths, root) {
  const rootReal = path.resolve(root);
  for (const candidate of paths) {
    const absolute = path.resolve(candidate);
    assert.equal(absolute.startsWith(`${rootReal}${path.sep}`) || absolute === rootReal, true, `${absolute} escaped ${rootReal}`);
  }
}

function installScenario() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'oaf-rust-m6-install-'));
  const configHome = path.join(temp, 'agent-config');
  const outside = path.join(temp, 'outside-sentinel.txt');
  mkdirSync(configHome, { recursive: true });
  mkdirSync(path.join(configHome, '.claude'), { recursive: true });
  mkdirSync(path.join(configHome, '.codex'), { recursive: true });
  mkdirSync(path.join(configHome, '.cursor'), { recursive: true });
  mkdirSync(path.join(configHome, '.vscode'), { recursive: true });
  writeFileSync(path.join(configHome, '.claude/mcp.json'), '{"mcpServers":{"existing":{"command":"existing-claude"}},"keep":true}\n');
  writeFileSync(path.join(configHome, '.codex/config.toml'), 'theme = "dark"\n');
  writeFileSync(path.join(configHome, '.cursor/mcp.json'), '{"mcpServers":{"existing":{"command":"existing-cursor"}}}\n');
  writeFileSync(path.join(configHome, '.vscode/mcp.json'), '{"mcpServers":{"existing":{"command":"existing-vscode"}}}\n');
  writeFileSync(outside, 'outside must not change\n');
  const beforeInstall = listFiles(configHome);
  const env = { ...process.env, OAF_CONFIG_HOME: configHome, HOME: path.join(temp, 'home'), OAF_FIXED_NOW: FIXED_NOW };
  const dry = timed(RUST_BIN, ['install', '--client', 'all', '--dry-run', '--format', 'json'], { env });
  const dryRun = JSON.parse(dry.result.stdout);
  assert.equal(dryRun.command, 'install');
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.confirmationRequired, true);
  assert.match(dryRun.planFingerprint, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(dryRun.receipt.touchedFiles.length, 8);
  assertAllInside(dryRun.receipt.touchedFiles, configHome);
  assert.deepEqual(listFiles(configHome), beforeInstall, 'dry-run must not write config files');

  const applied = runJson(RUST_BIN, ['install', '--client', 'all', '--confirm', dryRun.planFingerprint, '--format', 'json'], { env });
  assert.equal(applied.dryRun, false);
  assert.equal(applied.changed, true);
  assert.equal(applied.receipt.entries.every((entry) => entry.server.command === RUST_BIN), true);
  assertAllInside(applied.receipt.touchedFiles, configHome);
  const afterApply = listFiles(configHome);
  assert.equal(afterApply.length, 8);

  const reapplied = runJson(RUST_BIN, ['install', '--client', 'all', '--confirm', dryRun.planFingerprint, '--format', 'json'], { env });
  assert.equal(reapplied.idempotent, true);
  assert.equal(reapplied.changed, false);
  assert.deepEqual(listFiles(configHome), afterApply, 'idempotent reinstall changed config contents');

  const uninstallDry = runJson(RUST_BIN, ['install', '--client', 'all', '--uninstall', '--dry-run', '--format', 'json'], { env });
  assert.match(uninstallDry.planFingerprint, /^sha256:[a-f0-9]{64}$/u);
  const uninstalled = runJson(RUST_BIN, ['install', '--client', 'all', '--uninstall', '--confirm', uninstallDry.planFingerprint, '--format', 'json'], { env });
  assert.equal(uninstalled.uninstall, true);
  assert.equal(uninstalled.changed, true);
  assert.deepEqual(listFiles(configHome), beforeInstall, 'uninstall must restore the original fake configs exactly');
  assert.equal(readFileSync(outside, 'utf8'), 'outside must not change\n');
  rmSync(temp, { recursive: true, force: true });
  return {
    dryRunMs: dry.ms,
    receiptSample: dryRun.receipt,
    touchedOnlyTempConfig: true
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function fetchText(port, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: pathname }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) reject(new Error(`${pathname} returned ${response.statusCode}: ${body}`));
        else resolve(body);
      });
    });
    request.on('error', reject);
  });
}

async function waitForUi(port) {
  const deadline = Date.now() + 5000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await fetchText(port, '/api/graph?mode=current');
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError ?? new Error('ui did not start');
}

function rssMb(pid) {
  const result = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' });
  if (result.status !== 0) return 0;
  const kb = Number(result.stdout.trim());
  return Number((kb / 1024).toFixed(1));
}

async function uiScenario(root) {
  const port = await freePort();
  const started = performance.now();
  const child = spawn(RUST_BIN, ['ui', '--root', root, '--sqlite', SQLITE, '--port', String(port), '--format', 'json'], {
    cwd: ROOT,
    env: { ...process.env, OAF_FIXED_NOW: CURRENT_NOW },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    await waitForUi(port);
    const startMs = Number((performance.now() - started).toFixed(3));
    const html = await fetchText(port, '/');
    assert.equal(/https?:\/\//iu.test(html), false, 'UI HTML includes external URL');
    assert.equal(/cdn|unpkg|jsdelivr|cdnjs|esm\.sh/iu.test(html), false, 'UI HTML includes CDN marker');
    const current = JSON.parse(await fetchText(port, '/api/graph?mode=current'));
    const history = JSON.parse(await fetchText(port, '/api/graph?mode=history'));
    assert.equal(current.safeguards.readOnly, true);
    assert.equal(current.safeguards.localhostOnly, true);
    assert.equal(current.safeguards.networkCalls, 0);
    assert.equal(current.safeguards.rawSourceBodiesIncluded, false);
    assert.equal(Array.isArray(current.nodes) && current.nodes.length > 0, true);
    assert.equal(Array.isArray(current.edges) && current.edges.length > 0, true);
    assert.equal(Array.isArray(current.communities) && current.communities.length > 0, true);
    assert.equal(history.edges.length > current.edges.length, true, 'history must include superseded edge');
    assert.equal(current.edges.some((edge) => edge.to === 'hmac-session-tokens'), false);
    assert.equal(history.edges.some((edge) => edge.to === 'hmac-session-tokens'), true);
    assert.equal(current.edges.some((edge) => edge.to === 'signed-session-tokens'), true);
    return {
      port,
      startMs,
      peakRssMb: rssMb(child.pid),
      currentEdges: current.edges.length,
      historyEdges: history.edges.length,
      htmlBytes: Buffer.byteLength(html),
      outboundRequests: 0,
      cdnUrls: 0
    };
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    assert.equal(stderr.trim(), '', stderr || stdout);
  }
}

run('cargo', ['build', '--release', '--manifest-path', 'rust/Cargo.toml']);
assert.equal(existsSync(RUST_BIN), true, 'release binary missing');

const root = makeMemoryRoot();
try {
  seedGraph(root);
  const deps = dependencyList();
  assertExpectedDeps(deps);
  const version = run(RUST_BIN, ['--version']).stdout.trim();
  assert.match(version, /^oaf \d+\.\d+\.\d+/u);
  rust(root, ['architecture', 'overview']);
  const mcpResponseCount = mcpRoundTrip(root);
  const install = installScenario();
  const ui = await uiScenario(root);
  const binarySizeBytes = statSync(RUST_BIN).size;
  const coldStart = timed(RUST_BIN, ['--version']);
  const report = {
    schemaVersion: '1.0.0',
    command: 'rust distribution quality',
    binary: {
      path: path.relative(ROOT, RUST_BIN),
      sizeBytes: binarySizeBytes,
      version,
      dependencyCommand: process.platform === 'darwin' ? 'otool -L' : process.platform === 'linux' ? 'ldd' : 'file',
      dependencyList: deps.split(/\r?\n/u),
      fullyStatic: process.platform === 'darwin' ? false : !/=>|\/lib|\/usr\/lib/u.test(deps),
      platformCaveat: process.platform === 'darwin' ? 'macOS keeps system libSystem/framework dependencies; this release binary is single-file but not fully static-linked.' : ''
    },
    cli: { architectureOverview: 'ok', mcpResponseCount },
    install,
    ui,
    benchmark: {
      binarySizeBytes,
      coldStartMs: coldStart.ms,
      uiStartMs: ui.startMs,
      uiPeakRssMb: ui.peakRssMb,
      installDryRunMs: install.dryRunMs
    },
    caveats: ['signing/notarization and package-manager publishing are deferred']
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
