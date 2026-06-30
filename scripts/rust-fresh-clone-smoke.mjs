import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const FIXED_NOW = '2026-06-30T04:00:00.000Z';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, OAF_FIXED_NOW: FIXED_NOW },
    ...options
  });
  assert.equal(result.status, options.expectedStatus ?? 0, `${command} ${args.join(' ')}\n${result.stderr || result.stdout}`);
  return result;
}

function timed(command, args, options = {}) {
  const started = performance.now();
  const result = run(command, args, options);
  return {
    stdout: result.stdout,
    ms: Number((performance.now() - started).toFixed(3))
  };
}

function runJson(command, args, options = {}) {
  return JSON.parse(run(command, args, options).stdout);
}

const temp = mkdtempSync(path.join(os.tmpdir(), 'oaf-rust-fresh-clone-'));
try {
  const cloneRoot = path.join(temp, 'open-agent-fabric');
  const clone = timed('git', ['clone', '--local', '--no-hardlinks', ROOT, cloneRoot], { cwd: temp });
  const build = timed('cargo', ['build', '--release', '--manifest-path', 'rust/Cargo.toml'], { cwd: cloneRoot });
  const bin = path.join(cloneRoot, 'rust/target/release/oaf');
  const version = run(bin, ['--version'], { cwd: cloneRoot }).stdout.trim();
  const sqlite = path.join(temp, 'fresh-clone.sqlite');
  const ingest = runJson(bin, [
    'ingest',
    '--root', cloneRoot,
    '--sqlite', sqlite,
    '--workers', '4',
    '--max-file-mb', '2',
    '--format', 'json'
  ], { cwd: cloneRoot });
  assert.ok(ingest.summary.parsedFileCount > 100, 'fresh clone ingest parsed too few files');
  assert.equal(ingest.safeguards.proposalGated, true);
  assert.equal(ingest.safeguards.singleWriterCommit, true);
  assert.equal(ingest.safeguards.unsafeBlocks, 0);
  const approved = runJson(bin, [
    'memory', 'approve', '--all',
    '--root', cloneRoot,
    '--sqlite', sqlite,
    '--format', 'json'
  ], { cwd: cloneRoot });
  assert.equal(approved.summary.activeMemoryCreated, ingest.summary.proposalCount);
  const search = runJson(bin, [
    'search',
    '--query', 'changed file impacts',
    '--mode', 'hybrid',
    '--semantic',
    '--limit', '5',
    '--root', cloneRoot,
    '--sqlite', sqlite,
    '--format', 'json'
  ], { cwd: cloneRoot });
  assert.equal(search.semantic.enabled, true);
  assert.ok(search.hits.length > 0, 'fresh clone search returned no hits');
  console.log(JSON.stringify({
    schemaVersion: '1.0.0',
    command: 'rust fresh clone smoke',
    methodology: 'Local --no-hardlinks git clone into a temp directory; build release binary inside the clone; run version, governed ingest, approval, and semantic hybrid search locally.',
    clone: {
      source: ROOT,
      wallMs: clone.ms
    },
    build: {
      wallMs: build.ms
    },
    binary: {
      version
    },
    ingest: {
      parsedFileCount: ingest.summary.parsedFileCount,
      generatedFactCount: ingest.summary.generatedFactCount,
      proposalCount: ingest.summary.proposalCount,
      generatedCallCount: ingest.summary.generatedCallCount,
      elapsedMs: ingest.summary.elapsedMs,
      safeguards: ingest.safeguards
    },
    approval: {
      activeMemoryCreated: approved.summary.activeMemoryCreated
    },
    search: {
      hitCount: search.hitCount,
      semantic: search.semantic
    },
    status: 'PASS'
  }, null, 2));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
