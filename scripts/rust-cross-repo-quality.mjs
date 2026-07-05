import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const RUST_BIN = path.join(ROOT, 'rust/target/release/oaf');
const FIXED_NOW = '2026-06-29T00:00:00.000Z';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, OAF_FIXED_NOW: FIXED_NOW },
    ...options
  });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stderr || result.stdout}`);
  return result;
}

function runJson(command, args) {
  return JSON.parse(run(command, args).stdout);
}

function oaf(root, sqlite, args) {
  return runJson(RUST_BIN, [...args, '--root', root, '--sqlite', sqlite, '--format', 'json']);
}

function rows(sqlite, sql) {
  const db = new DatabaseSync(sqlite);
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

function makeFleetFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaf-rust-ci5-fleet-'));
  mkdirSync(path.join(root, 'repo-a/src'), { recursive: true });
  mkdirSync(path.join(root, 'repo-b/src'), { recursive: true });
  writeFileSync(path.join(root, 'repo-a/src/client.js'), [
    "import { serveThing } from '../../repo-b/src/index.js';",
    'export function runClient() {',
    '  return serveThing();',
    '}'
  ].join('\n'));
  writeFileSync(path.join(root, 'repo-b/src/index.js'), [
    'export function serveThing() {',
    '  return 42;',
    '}'
  ].join('\n'));
  return root;
}

function makeSingleRepoFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaf-rust-ci5-single-'));
  mkdirSync(path.join(root, 'repo-a/src'), { recursive: true });
  writeFileSync(path.join(root, 'repo-a/src/app.js'), [
    'export function localTarget() {',
    '  return 1;',
    '}',
    'export function localCaller() {',
    '  return localTarget();',
    '}'
  ].join('\n'));
  return root;
}

function crossFacts(sqlite) {
  return rows(sqlite, `
    SELECT subject, predicate, object, source, metadata_json
    FROM memory_facts
    WHERE predicate = 'CROSS_CALLS'
    ORDER BY subject, object
  `);
}

function runFleetGate() {
  const root = makeFleetFixture();
  const sqlite = path.join(root, '.local/memory.sqlite');
  try {
    const ingest = oaf(root, sqlite, ['ingest', '--workers', '1']);
    assert.equal(ingest.summary.activeMemoryCreated, 0);
    assert.ok(ingest.summary.proposalCount >= 1);
    oaf(root, sqlite, ['memory', 'approve', '--all']);

    const cross = oaf(root, sqlite, ['cross-repo']);
    assert.equal(cross.summary.repoCount, 2);
    assert.equal(cross.summary.crossCallCount, 1);
    assert.equal(cross.summary.proposalCount, 1);
    assert.equal(cross.crossEdges[0].predicate, 'CROSS_CALLS');
    assert.equal(cross.crossEdges[0].subject, 'function:runClient');
    assert.equal(cross.crossEdges[0].object, 'function:serveThing');
    assert.equal(cross.crossEdges[0].fromRepo, 'repo-a');
    assert.equal(cross.crossEdges[0].toRepo, 'repo-b');
    assert.equal(cross.crossEdges[0].source, 'workspace://repo-a/src/client.js');
    assert.equal(cross.crossEdges[0].targetSource, 'workspace://repo-b/src/index.js');
    assert.equal(cross.safeguards.proposalGated, true);
    assert.equal(cross.safeguards.activeMemoryCreated, 0);
    assert.equal(cross.safeguards.modelCalls, 0);
    assert.equal(cross.safeguards.networkCalls, 0);

    const approved = oaf(root, sqlite, ['memory', 'approve', '--all']);
    assert.equal(approved.summary.activeMemoryCreated, 1);
    const facts = crossFacts(sqlite);
    assert.deepEqual(facts.map((fact) => [fact.subject, fact.predicate, fact.object, fact.source]), [
      ['function:runClient', 'CROSS_CALLS', 'function:serveThing', 'workspace://repo-a/src/client.js']
    ]);
    const metadata = JSON.parse(facts[0].metadata_json);
    assert.equal(metadata.notes, 'oaf.cross-repo:call');
    assert.equal(metadata.extractionConfidence, 'extracted');

    const idempotent = oaf(root, sqlite, ['cross-repo']);
    assert.equal(idempotent.summary.crossCallCount, 1);
    assert.equal(idempotent.summary.recordedCount, 0);

    return {
      parsedFileCount: ingest.summary.parsedFileCount,
      generatedFactCount: ingest.summary.generatedFactCount,
      crossCallCount: cross.summary.crossCallCount,
      recordedCount: cross.summary.recordedCount,
      idempotentRecordedCount: idempotent.summary.recordedCount,
      edge: cross.crossEdges[0]
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runSingleRepoGate() {
  const root = makeSingleRepoFixture();
  const sqlite = path.join(root, '.local/memory.sqlite');
  try {
    const ingest = oaf(root, sqlite, ['ingest', '--workers', '1']);
    oaf(root, sqlite, ['memory', 'approve', '--all']);
    const cross = oaf(root, sqlite, ['cross-repo']);
    assert.equal(cross.summary.repoCount, 1);
    assert.equal(cross.summary.crossCallCount, 0);
    assert.equal(cross.summary.recordedCount, 0);
    assert.deepEqual(crossFacts(sqlite), []);
    return {
      parsedFileCount: ingest.summary.parsedFileCount,
      generatedFactCount: ingest.summary.generatedFactCount,
      crossCallCount: cross.summary.crossCallCount,
      recordedCount: cross.summary.recordedCount
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const fleet = runFleetGate();
const singleRepo = runSingleRepoGate();

console.log(JSON.stringify({
  schemaVersion: '1.0.0',
  command: 'rust cross repo quality',
  methodology: 'CI-5 derives governed CROSS_CALLS proposals from approved ingest facts in a fleet root. Repo identity is the first workspace path component; no model, network, or direct graph mutation is used.',
  fleet,
  singleRepo,
  status: 'PASS'
}, null, 2));
