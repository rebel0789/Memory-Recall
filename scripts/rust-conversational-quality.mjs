import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const RUST_BIN = path.join(ROOT, 'rust/target/release/oaf');
const FIXED_NOW = '2026-06-30T01:00:00.000Z';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, OAF_FIXED_NOW: FIXED_NOW },
    ...options
  });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stderr || result.stdout}`);
  return result;
}

function runJson(command, args, options = {}) {
  return JSON.parse(run(command, args, options).stdout);
}

function oaf(root, sqlite, args) {
  return runJson(RUST_BIN, [...args, '--root', root, '--sqlite', sqlite, '--format', 'json']);
}

function rows(root, sqlite, sql) {
  const database = new DatabaseSync(path.isAbsolute(sqlite) ? sqlite : path.join(root, sqlite));
  try {
    return database.prepare(sql).all();
  } finally {
    database.close();
  }
}

assert.equal(existsSync(RUST_BIN), true, 'rust/target/release/oaf must exist; run cargo build --release --manifest-path rust/Cargo.toml first');

const temp = mkdtempSync(path.join(os.tmpdir(), 'oaf-rust-conversation-'));
try {
  const fixture = path.join(temp, 'fixture');
  const sqlite = path.join(fixture, '.local/memory.sqlite');
  mkdirSync(path.join(fixture, '.local'), { recursive: true });
  writeFileSync(path.join(fixture, 'seed.json'), JSON.stringify({
    facts: [
      { subject: 'user:alice', predicate: 'ROLE', object: 'engineer', source: 'workspace://seed.json', confidence: 'extracted' },
      { subject: 'user:alice', predicate: 'LIKES', object: 'cheese_pizza', source: 'workspace://seed.json', confidence: 'extracted' },
      { subject: 'user:alice', predicate: 'USES', object: 'cloud_db', source: 'workspace://seed.json', confidence: 'extracted' }
    ]
  }, null, 2));
  oaf(fixture, sqlite, ['memory', 'remember', '--batch', 'seed.json']);
  oaf(fixture, sqlite, ['memory', 'approve', '--all']);

  writeFileSync(path.join(fixture, 'chat-export.json'), JSON.stringify({
    messages: [
      { role: 'user', content: 'I am still an engineer.' },
      { role: 'user', content: 'I prefer chicken pizza now.' },
      { role: 'user', content: 'I use Rust for local tools.' },
      { role: 'user', content: 'Remove cloud db from my memory.' }
    ]
  }, null, 2));
  writeFileSync(path.join(fixture, 'candidates.json'), JSON.stringify({
    transcriptSource: 'workspace://chat-export.json',
    facts: [
      { subject: 'user:alice', predicate: 'ROLE', object: 'engineer', source: 'workspace://chat-export.json', confidence: 'extracted' },
      { subject: 'user:alice', predicate: 'LIKES', object: 'chicken_pizza', source: 'workspace://chat-export.json', confidence: 'extracted' },
      { subject: 'user:alice', predicate: 'TOOL', object: 'rust', source: 'workspace://chat-export.json', confidence: 'extracted' },
      { subject: 'user:alice', predicate: 'USES', object: 'remove cloud_db', source: 'workspace://chat-export.json', confidence: 'extracted' }
    ]
  }, null, 2));

  const report = oaf(fixture, sqlite, ['memory', 'consolidate', '--batch', 'candidates.json']);
  assert.equal(report.command, 'memory consolidate');
  assert.deepEqual(report.summary.operationCounts, { ADD: 1, DELETE: 1, NOOP: 1, UPDATE: 1 });
  assert.equal(report.summary.candidateCount, 4);
  assert.equal(report.summary.proposalCount, 3, 'NOOP must not queue a proposal');
  assert.equal(report.source.trustClass, 'untrusted_external');
  assert.equal(report.safeguards.transcriptContentTrusted, false);
  assert.equal(report.safeguards.modelCalls, 0);
  assert.equal(report.safeguards.networkCalls, 0);
  assert.equal(report.consolidationReceipt.semanticRetrieval.model, 'random-indexing');
  assert.ok(report.consolidationReceipt.semanticRetrieval.candidateCount >= 3, 'semantic retrieval must inspect current facts');

  const operations = report.consolidationReceipt.operations.map((item) => item.operation);
  assert.deepEqual(operations, ['NOOP', 'UPDATE', 'ADD', 'DELETE']);
  const updateReceipt = report.consolidationReceipt.operations[1];
  assert.ok(updateReceipt.similarExisting.length >= 1, 'UPDATE should carry similar existing memory evidence');
  assert.equal(updateReceipt.candidate.sourceTrust, 'untrusted_external');

  oaf(fixture, sqlite, ['memory', 'approve', '--all']);
  const facts = rows(fixture, sqlite, `
    SELECT subject, predicate, object, status, superseded_by, metadata_json
    FROM memory_facts
    WHERE subject = 'user:alice'
    ORDER BY predicate, object
  `);
  const byKey = new Map(facts.map((fact) => [`${fact.predicate}|${fact.object}`, fact]));
  assert.equal(byKey.get('ROLE|engineer').status, 'active', 'NOOP should leave exact existing fact active');
  assert.notEqual(byKey.get('LIKES|cheese_pizza').superseded_by, null, 'UPDATE should supersede old object');
  assert.equal(byKey.get('LIKES|chicken_pizza').status, 'active', 'UPDATE should make new object current');
  assert.equal(byKey.get('TOOL|rust').status, 'active', 'ADD should create a new current fact');
  assert.notEqual(byKey.get('USES|cloud_db').superseded_by, null, 'DELETE should supersede removed object');
  assert.ok([...byKey.keys()].some((key) => key.startsWith('USES|retired_')), 'DELETE should leave a retirement receipt fact');

  const untrustedFacts = facts
    .filter((fact) => fact.object === 'chicken_pizza' || fact.object === 'rust' || fact.object.startsWith('retired_'))
    .map((fact) => JSON.parse(fact.metadata_json).sourceTrust);
  assert.deepEqual(untrustedFacts, ['untrusted', 'untrusted', 'untrusted']);

  console.log(JSON.stringify({
    schemaVersion: '1.0.0',
    command: 'rust conversational quality',
    methodology: 'Seeded current memory, then consolidated host-extracted transcript candidates covering ADD, UPDATE, DELETE, and NOOP. Decisions are deterministic and use local hybrid Random Indexing for similar-memory receipts.',
    operationDecisionCorrect: 4,
    operationDecisionTotal: 4,
    operationDecisionAccuracy: 1,
    reportSummary: report.summary,
    semanticRetrieval: report.consolidationReceipt.semanticRetrieval,
    finalFacts: facts.map((fact) => ({
      subject: fact.subject,
      predicate: fact.predicate,
      object: fact.object,
      status: fact.status,
      superseded: fact.superseded_by !== null
    })),
    safeguards: report.safeguards,
    status: 'PASS'
  }, null, 2));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
