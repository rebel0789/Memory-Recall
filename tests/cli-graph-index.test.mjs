import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cli = path.resolve('apps/cli/oaf.mjs');
const rustBinary = path.resolve('rust', 'target', 'release', process.platform === 'win32' ? 'oaf.exe' : 'oaf');

test('graph read commands expose strict native aliases and reject the removed compatibility engine', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'memory-recall-cli-native-preview-'));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'index.ts'), 'export function main(){ return helper(); }\nexport function helper(){ return 1; }\n');
  const env = { ...process.env, MEMORY_RECALL_NATIVE_BINARY: rustBinary, OAF_FIXED_NOW: '2026-07-16T00:00:00.000Z' };
  const built = spawnSync(process.execPath, [
    cli, 'graph', 'index', '--write', '--engine', 'native', '--root', root, '--format', 'json'
  ], { encoding: 'utf8', env });
  assert.equal(built.status, 0, built.stderr);
  const run = (engine, runEnv = env) => spawnSync(process.execPath, [
    cli,
    'graph',
    'search',
    '--root', root,
    '--query', 'main',
    '--engine', engine,
    '--format', 'json'
  ], { encoding: 'utf8', env: runEnv });

  const native = run('native-preview');
  assert.equal(native.status, 0, native.stderr);
  const nativeReport = JSON.parse(native.stdout);
  assert.equal(nativeReport.engine.selection, 'native');
  assert.equal(nativeReport.engine.previewOnly, false);
  assert.equal(nativeReport.engine.publicDefaultChanged, true);
  assert(nativeReport.search.results.some((item) => item.label === 'main'));
  assert.equal(JSON.stringify(nativeReport).includes(root), false);

  const compatibility = run('compatibility', { ...env, MEMORY_RECALL_NATIVE_BINARY: path.join(root, 'missing-native') });
  assert.equal(compatibility.status, 2);
  assert.match(compatibility.stderr, /graph --engine must be native, native-preview, or auto/u);

  const invalid = run('unknown');
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /graph --engine must be native, native-preview, or auto/u);

  const missing = spawnSync(process.execPath, [
    cli, 'graph', 'stats', '--root', root, '--engine', 'native', '--format', 'json'
  ], { encoding: 'utf8', env: { ...env, MEMORY_RECALL_NATIVE_BINARY: path.join(root, 'missing-native') } });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /native_engine_unavailable/u);
});

test('graph read commands default to the current native persistent index without mutating it', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'memory-recall-cli-auto-default-'));
  writeFileSync(path.join(root, 'index.ts'), 'export function currentDefault(){ return true; }\n');
  const env = { ...process.env, MEMORY_RECALL_NATIVE_BINARY: rustBinary };
  const built = spawnSync(process.execPath, [cli, 'graph', 'index', '--write', '--root', root, '--format', 'json'], {
    encoding: 'utf8',
    env
  });
  assert.equal(built.status, 0, built.stderr);
  const indexPath = path.join(root, '.local', 'source-index', 'index.v1.sqlite');
  const before = statSync(indexPath);
  const result = spawnSync(process.execPath, [cli, 'graph', 'stats', '--root', root, '--format', 'json'], {
    encoding: 'utf8',
    env
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.engine.requested, 'native');
  assert.equal(report.engine.selection, 'native');
  assert.equal(report.engine.reason, null);
  assert.equal(report.engine.previewOnly, false);
  assert.equal(report.engine.publicDefaultChanged, true);
  assert(report.graph.summary.nodeCount > 0);
  const after = statSync(indexPath);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
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
    cli, 'graph', 'index', ...args, '--engine', 'native', '--root', root, '--format', 'json'
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
  const refreshedReport = JSON.parse(refreshed.stdout);
  assert.equal(refreshedReport.measurements.changedFileCount, 1);
  assert.equal(refreshedReport.measurements.parsedFileCount, 1);
  assert.equal(refreshedReport.measurements.reusedFileCount, 1);

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

  const hiddenNativeWrite = spawnSync(process.execPath, [cli, 'graph', 'index', '--doctor', '--engine', 'compatibility', '--root', root, '--format', 'json'], { encoding: 'utf8', env });
  assert.equal(hiddenNativeWrite.status, 2);
  assert.match(hiddenNativeWrite.stderr, /--engine must be native, native-preview, or auto/u);

  const invalidBound = run('--write', '--max-nodes', 'nope');
  assert.equal(invalidBound.status, 2);
  assert.match(invalidBound.stderr, /--max-nodes must be an integer/u);
  assert.doesNotMatch(invalidBound.stderr, /\n\s+at /u);

  const missingQuery = spawnSync(process.execPath, [
    cli, 'graph', 'index', '--query', '--engine', 'native', '--root', root, '--format', 'json'
  ], { encoding: 'utf8', env });
  assert.equal(missingQuery.status, 2);
  assert.match(missingQuery.stderr, /--query requires a query value/u);
  assert.doesNotMatch(missingQuery.stderr, /source_index_query_unavailable/u);

  const ignoredReaderBound = run('--status', '--max-nodes', '9');
  assert.equal(ignoredReaderBound.status, 2);
  assert.match(ignoredReaderBound.stderr, /--status does not accept --max-nodes/u);
});

test('graph index native query exposes and consumes an opaque continuation cursor', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'memory-recall-cli-native-query-page-'));
  writeFileSync(path.join(root, 'index.ts'), [
    'export function pageMatchOne(){ return 1; }',
    'export function pageMatchTwo(){ return 2; }',
    'export function pageMatchThree(){ return 3; }'
  ].join('\n'));
  const env = { ...process.env, MEMORY_RECALL_NATIVE_BINARY: rustBinary };
  const run = (...args) => spawnSync(process.execPath, [
    cli, 'graph', 'index', ...args, '--engine', 'native', '--root', root
  ], { encoding: 'utf8', env });

  const built = run('--write', '--languages', 'typescript', '--format', 'json');
  assert.equal(built.status, 0, built.stderr);
  const first = run('--query', 'pageMatch', '--kind', 'search', '--limit', '1', '--format', 'json');
  assert.equal(first.status, 0, first.stderr);
  const firstReport = JSON.parse(first.stdout);
  assert.equal(firstReport.results.length, 1);
  assert.equal(firstReport.truncated, true);
  assert.match(firstReport.nextCursor, /^idxcur_[a-f0-9]{32}$/u);

  const second = run('--query', 'pageMatch', '--kind', 'search', '--limit', '1', '--cursor', firstReport.nextCursor, '--format', 'json');
  assert.equal(second.status, 0, second.stderr);
  const secondReport = JSON.parse(second.stdout);
  assert.equal(secondReport.results.length, 1);
  assert.notEqual(secondReport.results[0].id, firstReport.results[0].id);

  const summary = run('--query', 'pageMatch', '--kind', 'search', '--limit', '1', '--format', 'summary');
  assert.equal(summary.status, 0, summary.stderr);
  assert.match(summary.stdout, /Results returned: 1/u);
  assert.match(summary.stdout, /Query truncated: yes/u);
  assert.match(summary.stdout, /Next cursor: idxcur_[a-f0-9]{32}/u);
});

test('graph help documents the explicit persistent index lifecycle', () => {
  const result = spawnSync(process.execPath, [cli, 'help', 'graph'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /graph index --status/u);
  assert.match(result.stdout, /graph index --write/u);
  assert.match(result.stdout, /graph index --refresh/u);
  assert.match(result.stdout, /--watch/u);
  assert.match(result.stdout, /MCP reads the index but never builds or refreshes it/u);
  assert.match(result.stdout, /--engine <native\|native-preview\|auto>/u);
  assert.doesNotMatch(result.stdout, /compatibility/u);
  assert.match(result.stdout, /graph index --doctor --engine native/u);
  assert.match(result.stdout, /graph index --repair --confirm <repairPlanFingerprint>/u);
  assert.match(result.stdout, /\.local\/source-index/u);
});

test('graph index watch refreshes after a source file changes and exits cleanly', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'memory-recall-cli-index-watch-'));
  writeFileSync(path.join(root, 'watch.ts'), 'export const watched = 1;\n');
  const env = { ...process.env, MEMORY_RECALL_NATIVE_BINARY: rustBinary };
  const built = spawnSync(process.execPath, [cli, 'graph', 'index', '--write', '--engine', 'native', '--root', root, '--format', 'json'], {
    encoding: 'utf8',
    env
  });
  assert.equal(built.status, 0, built.stderr);
  const child = spawn(process.execPath, [cli, 'graph', 'index', '--refresh', '--watch', '--engine', 'native', '--root', root, '--format', 'summary'], {
    encoding: 'utf8',
    env
  });
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
