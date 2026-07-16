import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cli = path.resolve('apps/cli/oaf.mjs');
const rustBinary = path.resolve('rust', 'target', 'release', process.platform === 'win32' ? 'oaf.exe' : 'oaf');

test('graph read commands expose strict native preview and compatibility modes', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'memory-recall-cli-native-preview-'));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'index.ts'), 'export function main(){ return helper(); }\nexport function helper(){ return 1; }\n');
  const env = { ...process.env, MEMORY_RECALL_NATIVE_BINARY: rustBinary, OAF_FIXED_NOW: '2026-07-16T00:00:00.000Z' };
  const run = (engine) => spawnSync(process.execPath, [
    cli,
    'graph',
    'search',
    '--root', root,
    '--query', 'main',
    '--engine', engine,
    '--format', 'json'
  ], { encoding: 'utf8', env });

  const native = run('native-preview');
  assert.equal(native.status, 0, native.stderr);
  const nativeReport = JSON.parse(native.stdout);
  assert.equal(nativeReport.engine.selection, 'native-preview');
  assert.equal(nativeReport.engine.previewOnly, true);
  assert(nativeReport.search.results.some((item) => item.label === 'main'));
  assert.equal(JSON.stringify(nativeReport).includes(root), false);

  const compatibility = run('compatibility');
  assert.equal(compatibility.status, 0, compatibility.stderr);
  const compatibilityReport = JSON.parse(compatibility.stdout);
  assert.equal(compatibilityReport.engine.selection, 'compatibility');
  assert.equal(compatibilityReport.compatibility.parityClaimed, false);
  assert.deepEqual(compatibilityReport.compatibility.dimensions.map((item) => item.name), ['files', 'symbols', 'imports', 'calls', 'routes']);

  const invalid = run('unknown');
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /graph --engine must be js, native-preview, or compatibility/u);

  const missing = spawnSync(process.execPath, [
    cli, 'graph', 'stats', '--root', root, '--engine', 'native-preview', '--format', 'json'
  ], { encoding: 'utf8', env: { ...env, MEMORY_RECALL_NATIVE_BINARY: path.join(root, 'missing-native') } });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /native_engine_unavailable/u);
});

test('graph read commands keep the JS engine as the public default', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'memory-recall-cli-js-default-'));
  writeFileSync(path.join(root, 'index.ts'), 'export function currentDefault(){ return true; }\n');
  const result = spawnSync(process.execPath, [cli, 'graph', 'stats', '--root', root, '--format', 'json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.engine.selection, 'js');
  assert.equal(report.engine.publicDefaultChanged, false);
});

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
  assert.match(implicit.stderr, /requires --status, --write, --refresh, --doctor, --repair, or --query/u);

  const built = run('--write');
  assert.equal(built.status, 0, built.stderr);
  const builtReport = JSON.parse(built.stdout);
  assert.equal(builtReport.command, 'graph index');
  assert.equal(builtReport.status, 'ready');
  assert.equal(builtReport.measurements.parsedFileCount, 2);
  assert.equal(builtReport.safeguards.rawSourceBodiesIncluded, false);

  const custom = run('--write', '--out', '.local/custom-index.json');
  assert.equal(custom.status, 0, custom.stderr);
  assert.equal(JSON.parse(custom.stdout).indexLocator, 'workspace://.local/custom-index.json');
  assert.equal(existsSync(path.join(root, '.local', 'custom-index.json')), true);

  const status = run('--status');
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).fileCount, 2);

  const indexPath = path.join(root, '.local', 'source-graph', 'index.v1.json');
  const beforeNoop = statSync(indexPath).mtimeMs;
  const noop = run('--refresh');
  assert.equal(noop.status, 0, noop.stderr);
  assert.equal(JSON.parse(noop.stdout).safeguards.localFilesWritten, 0);
  assert.equal(statSync(indexPath).mtimeMs, beforeNoop);

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

test('graph index native preview exposes the full bounded SQLite lifecycle explicitly', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'memory-recall-cli-native-index-'));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(path.join(root, '.local'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'index.ts'), 'export function main(){ return helper(); }\nexport function helper(){ return 1; }\n');
  writeFileSync(path.join(root, 'src', 'worker.py'), 'def worker():\n    return 1\n');
  const memoryPath = path.join(root, '.local', 'memory.sqlite');
  writeFileSync(memoryPath, 'governed-memory-sentinel');
  const memoryBefore = readFileSync(memoryPath);
  const env = { ...process.env, MEMORY_RECALL_NATIVE_BINARY: rustBinary };
  const run = (...args) => spawnSync(process.execPath, [
    cli, 'graph', 'index', ...args, '--engine', 'native-preview', '--root', root, '--format', 'json'
  ], { encoding: 'utf8', env });

  const missing = run('--status');
  assert.equal(missing.status, 0, missing.stderr);
  assert.equal(JSON.parse(missing.stdout).status, 'absent');

  const built = run('--write', '--languages', 'typescript,python');
  assert.equal(built.status, 0, built.stderr);
  const builtReport = JSON.parse(built.stdout);
  assert.equal(builtReport.status, 'ready');
  assert.equal(builtReport.fileCount, 2);
  assert.equal(builtReport.safeguards.localFilesWritten, 1);
  assert.equal(JSON.stringify(builtReport).includes(root), false);

  const indexPath = path.join(root, '.local', 'source-index', 'index.v1.sqlite');
  const beforeReaders = readFileSync(indexPath);
  const beforeReaderMtime = statSync(indexPath).mtimeMs;
  const status = run('--status');
  const doctor = run('--doctor');
  const query = run('--query', 'main', '--kind', 'exact');
  assert.equal(status.status, 0, status.stderr);
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.equal(query.status, 0, query.stderr);
  assert(JSON.parse(query.stdout).results.some((item) => item.label === 'main'));
  assert.deepEqual(readFileSync(indexPath), beforeReaders);
  assert.equal(statSync(indexPath).mtimeMs, beforeReaderMtime);

  const noop = run('--refresh', '--languages', 'typescript,python');
  assert.equal(noop.status, 0, noop.stderr);
  const noopReport = JSON.parse(noop.stdout);
  assert.equal(noopReport.measurements.parsedFileCount, 0);
  assert.equal(noopReport.safeguards.localFilesWritten, 0);
  assert.deepEqual(readFileSync(indexPath), beforeReaders);

  writeFileSync(path.join(root, 'src', 'worker.py'), 'def worker():\n    return 2\n');
  const refreshed = run('--refresh', '--languages', 'typescript,python');
  assert.equal(refreshed.status, 0, refreshed.stderr);
  assert.equal(JSON.parse(refreshed.stdout).measurements.changedFileCount, 1);

  writeFileSync(indexPath, 'not a sqlite database');
  const diagnosed = run('--doctor');
  assert.equal(diagnosed.status, 0, diagnosed.stderr);
  const diagnosis = JSON.parse(diagnosed.stdout);
  assert.equal(diagnosis.health.status, 'corrupt');
  assert.match(diagnosis.health.repairPlanFingerprint, /^sha256:[a-f0-9]{64}$/u);
  const repaired = run('--repair', '--confirm', diagnosis.health.repairPlanFingerprint, '--languages', 'typescript,python');
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.equal(JSON.parse(repaired.stdout).safeguards.repairPerformed, true);
  assert.deepEqual(readFileSync(memoryPath), memoryBefore);

  const hiddenNativeWrite = spawnSync(process.execPath, [cli, 'graph', 'index', '--doctor', '--root', root, '--format', 'json'], { encoding: 'utf8', env });
  assert.equal(hiddenNativeWrite.status, 2);
  assert.match(hiddenNativeWrite.stderr, /requires --engine native-preview/u);

  const invalidBound = run('--write', '--max-nodes', 'nope');
  assert.equal(invalidBound.status, 2);
  assert.match(invalidBound.stderr, /--max-nodes must be an integer/u);
  assert.doesNotMatch(invalidBound.stderr, /\n\s+at /u);

  const missingQuery = spawnSync(process.execPath, [
    cli, 'graph', 'index', '--query', '--engine', 'native-preview', '--root', root, '--format', 'json'
  ], { encoding: 'utf8', env });
  assert.equal(missingQuery.status, 2);
  assert.match(missingQuery.stderr, /--query requires a query value/u);
  assert.doesNotMatch(missingQuery.stderr, /source_index_query_unavailable/u);

  const ignoredReaderBound = run('--status', '--max-nodes', '9');
  assert.equal(ignoredReaderBound.status, 2);
  assert.match(ignoredReaderBound.stderr, /--status does not accept --max-nodes/u);
});

test('graph help documents the explicit persistent index lifecycle', () => {
  const result = spawnSync(process.execPath, [cli, 'help', 'graph'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /graph index --status/u);
  assert.match(result.stdout, /graph index --write/u);
  assert.match(result.stdout, /graph index --refresh/u);
  assert.match(result.stdout, /--watch/u);
  assert.match(result.stdout, /MCP reads the index but never builds or refreshes it/u);
  assert.match(result.stdout, /--engine <js\|native-preview\|compatibility>/u);
  assert.match(result.stdout, /graph index --doctor --engine native-preview/u);
  assert.match(result.stdout, /graph index --repair --confirm <repairPlanFingerprint>/u);
  assert.match(result.stdout, /\.local\/source-index/u);
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
