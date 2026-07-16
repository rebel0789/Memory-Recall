import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

const CLI_PATH = path.resolve('apps/cli/oaf.mjs');
const TEMPORAL_FIXTURE = path.resolve('evals/temporal/gold.v1.json');

test('packed native intelligence preview has an isolated consumer gate and runtime contract', () => {
  assert.equal(existsSync('scripts/native-code-intelligence-consumer-smoke.mjs'), true);

  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const [pack] = JSON.parse(result.stdout);
  const paths = new Set(pack.files.map((file) => file.path));

  for (const required of [
    'providers/native/code-intelligence-rust/provider.json',
    'providers/native/code-intelligence-rust/src/index.mjs',
    'packages/source-graph/src/native-compatibility.mjs',
    'packages/protocol/schemas/code-intelligence-engine-request.schema.json',
    'packages/protocol/schemas/code-intelligence-engine-response.schema.json',
    'packages/protocol/schemas/code-intelligence-graph.schema.json'
  ]) assert.equal(paths.has(required), true, required);

  for (const forbiddenPrefix of [
    'rust/target/',
    'evals/code-intelligence/results/'
  ]) assert.equal([...paths].some((filePath) => filePath.startsWith(forbiddenPrefix)), false, forbiddenPrefix);
  assert.equal(paths.has('scripts/native-code-intelligence-consumer-smoke.mjs'), false);
});

test('default packaged benchmark ignores a same-named workspace fixture', () => {
  const root = temporalShadowWorkspace('workspace-shadow-default');
  const result = spawnSync(process.execPath, [
    CLI_PATH,
    'bench',
    'temporal',
    '--read-only',
    '--root',
    '.',
    '--format',
    'json'
  ], { cwd: root, encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.dataset.id, 'oaf-temporal-gold-v1');
  assert.equal(report.dataset.ref, 'package://evals/temporal/gold.v1.json');
});

test('explicit benchmark dataset still resolves from the workspace', () => {
  const root = temporalShadowWorkspace('workspace-shadow-explicit');
  const result = spawnSync(process.execPath, [
    CLI_PATH,
    'bench',
    'temporal',
    '--read-only',
    '--root',
    '.',
    '--dataset',
    'evals/temporal/gold.v1.json',
    '--format',
    'json'
  ], { cwd: root, encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.dataset.id, 'workspace-shadow-explicit');
  assert.equal(report.dataset.ref, 'workspace://evals/temporal/gold.v1.json');
});

test('recall serve forwards SIGTERM to the control API child', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'recall-serve-signal-'));
  const port = await freePort();
  mkdirSync(path.join(root, 'data'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'signal-target' }));

  const wrapper = spawn(process.execPath, [CLI_PATH, 'serve'], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      HOME: root,
      OAF_PORT: String(port),
      OAF_DATA_DIR: path.join(root, 'data'),
      OAF_WORKSPACE_ROOT: root
    }
  });

  try {
    await waitForHealth(port);
    wrapper.kill('SIGTERM');
    await Promise.race([
      once(wrapper, 'exit'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('recall wrapper did not exit after SIGTERM')), 5000))
    ]);
    assert.equal(await waitForStop(port), true, 'control API child remained alive after wrapper SIGTERM');
  } finally {
    try {
      process.kill(-wrapper.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
});

test('token-saver reuses its context pack for MCP readback', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'recall-token-saver-single-scan-'));
  const bin = path.join(root, 'bin');
  const counterRoot = mkdtempSync(path.join(os.tmpdir(), 'recall-token-saver-counter-'));
  const counter = path.join(counterRoot, 'git-status-count.txt');
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'single-scan-target' }));
  writeFileSync(path.join(root, 'AGENTS.md'), 'Keep the measured handoff local and compact.');

  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  assert(realGit);
  const gitWrapper = path.join(bin, 'git');
  writeFileSync(gitWrapper, [
    '#!/usr/bin/env node',
    "const { appendFileSync } = require('node:fs');",
    "const { spawnSync } = require('node:child_process');",
    'const args = process.argv.slice(2);',
    `if (args.includes('status') && args.includes('--porcelain=v1')) appendFileSync(${JSON.stringify(counter)}, 'status\\n');`,
    `const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });`,
    'process.exit(result.status ?? 1);'
  ].join('\n'));
  chmodSync(gitWrapper, 0o755);

  runGit(root, ['init']);
  runGit(root, ['add', '.']);
  runGit(root, ['-c', 'user.name=Memory Recall Test', '-c', 'user.email=recall@example.invalid', 'commit', '-m', 'fixture']);

  const result = spawnSync(process.execPath, [
    CLI_PATH,
    'token-saver',
    '--root',
    root,
    '--include-file',
    'AGENTS.md',
    '--format',
    'json'
  ], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.checks.contextPackFingerprintMatchesMcp, true);
  const statusCalls = readFileSync(counter, 'utf8').trim().split(/\n/u).filter(Boolean);
  assert.equal(statusCalls.length, 2, `expected one context-pack scan pair, received ${statusCalls.length} git status calls`);
});

function temporalShadowWorkspace(id) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'recall-benchmark-shadow-'));
  const fixture = JSON.parse(readFileSync(TEMPORAL_FIXTURE, 'utf8'));
  fixture.id = id;
  mkdirSync(path.join(root, 'evals', 'temporal'), { recursive: true });
  writeFileSync(path.join(root, 'evals', 'temporal', 'gold.v1.json'), `${JSON.stringify(fixture, null, 2)}\n`);
  return root;
}

function runGit(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('control API did not become healthy');
}

async function waitForStop(port) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/health`);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
