import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cli = path.resolve('apps/cli/oaf.mjs');

test('graph index CLI builds, reports, and incrementally refreshes a local persistent index', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'memory-recall-cli-index-'));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'one.ts'), 'export function one() { return 1; }\n');
  writeFileSync(path.join(root, 'src', 'stable.ts'), 'export const stable = true;\n');
  const run = (...args) => spawnSync(process.execPath, [cli, 'graph', 'index', ...args, '--root', root, '--format', 'json'], { encoding: 'utf8' });

  const missing = run('--status');
  assert.equal(missing.status, 0, missing.stderr);
  assert.equal(JSON.parse(missing.stdout).status, 'not-built');
  assert.equal(existsSync(path.join(root, '.local', 'source-graph', 'index.v1.json')), false);

  const implicit = run();
  assert.equal(implicit.status, 2);
  assert.match(implicit.stderr, /requires --status, --write, or --refresh/u);

  const built = run('--write');
  assert.equal(built.status, 0, built.stderr);
  const builtReport = JSON.parse(built.stdout);
  assert.equal(builtReport.command, 'graph index');
  assert.equal(builtReport.status, 'ready');
  assert.equal(builtReport.measurements.parsedFileCount, 2);
  assert.equal(builtReport.safeguards.rawSourceBodiesIncluded, false);

  const status = run('--status');
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).fileCount, 2);

  writeFileSync(path.join(root, 'src', 'one.ts'), 'export function one() { return 2; }\n');
  const refreshed = run('--refresh');
  assert.equal(refreshed.status, 0, refreshed.stderr);
  const refreshReport = JSON.parse(refreshed.stdout);
  assert.equal(refreshReport.measurements.parsedFileCount, 1);
  assert.equal(refreshReport.measurements.reusedFileCount, 1);
  assert.equal(refreshReport.measurements.changedFileCount, 1);

  const unsafe = spawnSync(process.execPath, [cli, 'graph', 'index', '--status', '--root', root, '--out', '../outside.json', '--format', 'json'], { encoding: 'utf8' });
  assert.equal(unsafe.status, 2);
  assert.equal(unsafe.stderr.includes('../outside.json'), false);
});

test('graph help documents the explicit persistent index lifecycle', () => {
  const result = spawnSync(process.execPath, [cli, 'help', 'graph'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /graph index --status/u);
  assert.match(result.stdout, /graph index --write/u);
  assert.match(result.stdout, /graph index --refresh/u);
  assert.match(result.stdout, /--watch/u);
  assert.match(result.stdout, /MCP reads the index but never builds or refreshes it/u);
});

test('graph index watch refreshes after a source file changes and exits cleanly', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'memory-recall-cli-index-watch-'));
  writeFileSync(path.join(root, 'watch.ts'), 'export const watched = 1;\n');
  const child = spawn(process.execPath, [cli, 'graph', 'index', '--refresh', '--watch', '--root', root, '--format', 'summary'], { encoding: 'utf8' });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const waitFor = (predicate, timeoutMs = 5000) => new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - startedAt > timeoutMs) return reject(new Error(`watch timeout: ${stderr}`));
      setTimeout(poll, 25);
    };
    poll();
  });
  await waitFor(() => (stdout.match(/# Source Graph Index/gu) ?? []).length >= 1);
  writeFileSync(path.join(root, 'watch.ts'), 'export const watched = 2;\n');
  await waitFor(() => (stdout.match(/# Source Graph Index/gu) ?? []).length >= 2);
  child.kill('SIGINT');
  const exit = await new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  assert.equal(exit.signal, null);
  assert.equal(exit.code, 0);
  assert.match(stdout, /Changed: 1/u);
});
