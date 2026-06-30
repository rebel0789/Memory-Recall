import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const RUST_BIN = path.join(ROOT, 'rust/target/release/oaf');
const FIXED_NOW = '2026-06-29T00:00:00.000Z';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, OAF_FIXED_NOW: FIXED_NOW },
    ...options
  });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stderr || result.stdout}`);
  return result;
}

function timedJson(command, args, options = {}) {
  const started = performance.now();
  const result = run(command, args, options);
  return {
    value: JSON.parse(result.stdout),
    ms: Number((performance.now() - started).toFixed(3))
  };
}

function oaf(root, sqlite, args) {
  return timedJson(RUST_BIN, [...args, '--root', root, '--sqlite', sqlite, '--format', 'json']);
}

function dbRows(sqlite, sql) {
  const db = new DatabaseSync(sqlite);
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

function graphSignature(sqlite) {
  return JSON.stringify(dbRows(sqlite, `
    SELECT subject, predicate, object, source
    FROM memory_facts
    WHERE status = 'active'
      AND superseded_by IS NULL
      AND object NOT LIKE 'retired_%'
    ORDER BY subject, predicate, object, source
  `));
}

function scalar(sqlite, sql) {
  return Object.values(dbRows(sqlite, sql)[0] ?? { count: 0 })[0];
}

function makeRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaf-rust-ci6-'));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src/a.js'), [
    'export function changedThing() {',
    '  return stableThing();',
    '}'
  ].join('\n'));
  writeFileSync(path.join(root, 'src/stable.js'), [
    'export function stableThing() {',
    '  return 1;',
    '}'
  ].join('\n'));
  writeFileSync(path.join(root, 'src/remove.js'), [
    'export function removedThing() {',
    '  return 2;',
    '}'
  ].join('\n'));
  for (let index = 0; index < 30; index += 1) {
    writeFileSync(path.join(root, `src/unchanged_${index}.js`), [
      `export function unchanged${index}() {`,
      `  return ${index};`,
      '}'
    ].join('\n'));
  }
  run('git', ['init'], { cwd: root });
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'initial'], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: 'OAF', GIT_AUTHOR_EMAIL: 'oaf@example.test', GIT_COMMITTER_NAME: 'OAF', GIT_COMMITTER_EMAIL: 'oaf@example.test' } });
  return root;
}

function applySmallChange(root) {
  writeFileSync(path.join(root, 'src/a.js'), [
    'export function changedThing() {',
    '  return addedThing();',
    '}'
  ].join('\n'));
  writeFileSync(path.join(root, 'src/added.js'), [
    'export function addedThing() {',
    '  return 3;',
    '}'
  ].join('\n'));
  unlinkSync(path.join(root, 'src/remove.js'));
}

function approve(root, sqlite) {
  return oaf(root, sqlite, ['memory', 'approve', '--all']).value;
}

const root = makeRepo();
const sqlite = path.join(root, '.local/memory.sqlite');
try {
  const initial = oaf(root, sqlite, ['ingest', '--incremental', '--workers', '1']);
  assert.equal(initial.value.summary.parsedFileCount, 33);
  assert.equal(initial.value.summary.incrementalChangedSourceCount, 33);
  approve(root, sqlite);

  applySmallChange(root);
  const incremental = oaf(root, sqlite, ['ingest', '--incremental', '--workers', '1']);
  assert.equal(incremental.value.summary.parsedFileCount, 2, JSON.stringify(incremental.value.summary));
  assert.equal(incremental.value.summary.incrementalChangedSourceCount, 2);
  assert.equal(incremental.value.summary.incrementalDeletedSourceCount, 1);
  assert.equal(incremental.value.summary.incrementalUnchangedSourceCount, 31);
  approve(root, sqlite);

  assert.equal(
    scalar(sqlite, "SELECT count(*) AS count FROM memory_facts WHERE source = 'workspace://src/remove.js' AND status = 'active' AND object NOT LIKE 'retired_%'"),
    0
  );
  assert.ok(
    scalar(sqlite, "SELECT count(*) AS count FROM memory_facts WHERE source = 'workspace://src/remove.js' AND status = 'superseded'") > 0,
    'deleted file facts were not superseded'
  );
  assert.ok(
    scalar(sqlite, "SELECT count(*) AS count FROM memory_facts WHERE source = 'workspace://src/a.js' AND predicate = 'CALLS' AND object = 'function:stableThing' AND status = 'superseded'") > 0,
    'changed file stale call was not superseded'
  );

  const fullSqlite = path.join(root, '.local/full.sqlite');
  const full = oaf(root, fullSqlite, ['ingest', '--incremental', '--workers', '1']);
  approve(root, fullSqlite);
  assert.equal(graphSignature(sqlite), graphSignature(fullSqlite));

  console.log(JSON.stringify({
    schemaVersion: '1.0.0',
    command: 'rust incremental quality',
    methodology: 'Git fixture with content-hash governed incremental cursor facts. The second ingest parses only changed and added files, retires deleted/changed-file stale facts through approval, and compares active non-retired graph facts with a fresh full ingest of the final tree.',
    initial: {
      parsedFileCount: initial.value.summary.parsedFileCount,
      proposalCount: initial.value.summary.proposalCount,
      elapsedMs: initial.value.summary.elapsedMs,
      wallMs: initial.ms
    },
    incremental: {
      parsedFileCount: incremental.value.summary.parsedFileCount,
      changedSourceCount: incremental.value.summary.incrementalChangedSourceCount,
      deletedSourceCount: incremental.value.summary.incrementalDeletedSourceCount,
      unchangedSourceCount: incremental.value.summary.incrementalUnchangedSourceCount,
      proposalCount: incremental.value.summary.proposalCount,
      retiredProposalCount: incremental.value.summary.retiredProposalCount,
      elapsedMs: incremental.value.summary.elapsedMs,
      wallMs: incremental.ms
    },
    fullFinal: {
      parsedFileCount: full.value.summary.parsedFileCount,
      elapsedMs: full.value.summary.elapsedMs,
      wallMs: full.ms
    },
    speedup: {
      wallVsFull: Number((full.ms / incremental.ms).toFixed(3)),
      parsedFileReduction: Number((1 - (incremental.value.summary.parsedFileCount / full.value.summary.parsedFileCount)).toFixed(3))
    },
    correctness: {
      activeNonRetiredGraphEqualsFull: true,
      deletedFileFactsSuperseded: true,
      changedFileStaleCallSuperseded: true
    },
    status: 'PASS'
  }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
