import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const RUST_BIN = path.join(ROOT, 'rust/target/release/oaf');
const SQLITE = '.local/memory.sqlite';
const INITIAL_NOW = '2026-06-30T00:00:00.000Z';
const CURRENT_NOW = '2026-06-30T00:10:00.000Z';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, OAF_FIXED_NOW: options.now ?? CURRENT_NOW },
    ...options,
  });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stderr || result.stdout}`);
  return result;
}

function runJson(command, args, options = {}) {
  return JSON.parse(run(command, args, options).stdout);
}

function makeRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaf-rust-s2-'));
  mkdirSync(path.join(root, '.local'), { recursive: true });
  writeFileSync(path.join(root, 'DECISIONS.md'), 'Auth token expiry changed from 60 minutes to 15 minutes.\n');
  return root;
}

function seed(root) {
  const initial = runJson(RUST_BIN, [
    'memory', 'remember',
    '--subject', 'auth',
    '--predicate', 'token_expiry',
    '--object', '60 minutes',
    '--source', 'workspace://DECISIONS.md',
    '--root', root,
    '--sqlite', SQLITE,
    '--format', 'json'
  ], { now: INITIAL_NOW });
  const oldFactId = initial.fact.id;
  writeFileSync(path.join(root, 'facts.json'), JSON.stringify({ facts: [
    {
      subject: 'auth',
      predicate: 'token_expiry',
      object: '15 minutes',
      source: 'workspace://DECISIONS.md',
      supersedes: { subject: 'auth', predicate: 'token_expiry' },
      notes: 'shorter expiry supersedes the older 60 minute decision'
    }
  ] }, null, 2));
  runJson(RUST_BIN, ['memory', 'remember', '--batch', 'facts.json', '--root', root, '--sqlite', SQLITE, '--format', 'json'], { now: CURRENT_NOW });
  const approved = runJson(RUST_BIN, ['memory', 'approve', '--all-from', 'workspace://DECISIONS.md', '--root', root, '--sqlite', SQLITE, '--format', 'json'], { now: CURRENT_NOW });
  const current = approved.facts.find((fact) => fact.subject === 'auth' && fact.predicate === 'token_expiry' && fact.object === '15 minutes');
  assert.ok(current?.id, JSON.stringify(approved, null, 2));
  assert.equal(approved.supersededFacts.some((fact) => fact.id === oldFactId), true, JSON.stringify(approved, null, 2));
  return { oldFactId, currentFactId: current.id };
}

function rpc(messages) {
  return messages.map((message) => JSON.stringify(message)).join('\n');
}

function mcpWhy(root, factId) {
  const result = run(RUST_BIN, ['mcp', 'server', '--read-only', '--root', root, '--sqlite', SQLITE, '--stdio'], {
    input: rpc([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory.why', arguments: { factId, at: CURRENT_NOW } } }
    ]),
    now: CURRENT_NOW
  });
  const lines = result.stdout.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(lines[0].result.protocolVersion, '2025-06-18');
  return JSON.parse(lines[1].result.content[0].text);
}

function assertAcyclic(report) {
  const ids = [
    report.data?.fact?.id,
    report.data?.proposal?.id,
    report.data?.episode?.id,
    ...(report.data?.supersedes ?? []).map((item) => item.id),
    ...(report.data?.supersededBy ? [report.data.supersededBy.id] : [])
  ].filter(Boolean);
  assert.equal(new Set(ids).size, ids.length, `chain contains duplicate ids: ${ids.join(', ')}`);
}

function assertCurrentWhy(report, currentFactId, oldFactId) {
  assert.equal(report.command, 'memory why');
  assert.equal(report.data.fact.id, currentFactId);
  assert.equal(report.data.fact.subject, 'auth');
  assert.equal(report.data.fact.predicate, 'token_expiry');
  assert.equal(report.data.fact.object, '15 minutes');
  assert.equal(report.data.source.sourceLocator, 'workspace://DECISIONS.md');
  assert.ok(report.data.episode.id);
  assert.ok(report.data.proposal.id);
  assert.equal(report.data.proposal.id, report.data.fact.proposalQueueId);
  assert.equal(report.data.validity.validFrom, CURRENT_NOW);
  assert.equal(report.data.validity.validUntil, null);
  assert.equal(report.data.supersedes.some((fact) => fact.id === oldFactId && fact.object === '60 minutes'), true);
  assert.equal(report.data.supersededBy, null);
  assertAcyclic(report);
}

function assertOldWhy(report, oldFactId, currentFactId) {
  assert.equal(report.data.fact.id, oldFactId);
  assert.equal(report.data.fact.object, '60 minutes');
  assert.equal(report.data.fact.status, 'superseded');
  assert.equal(report.data.supersededBy.id, currentFactId);
  assert.equal(report.data.supersedes.length, 0);
  assertAcyclic(report);
}

const root = makeRoot();
try {
  const { oldFactId, currentFactId } = seed(root);
  const current = runJson(RUST_BIN, ['memory', 'why', currentFactId, '--at', CURRENT_NOW, '--root', root, '--sqlite', SQLITE, '--format', 'json'], { now: CURRENT_NOW });
  const old = runJson(RUST_BIN, ['memory', 'why', oldFactId, '--at', CURRENT_NOW, '--root', root, '--sqlite', SQLITE, '--format', 'json'], { now: CURRENT_NOW });
  const mcp = mcpWhy(root, currentFactId);
  assertCurrentWhy(current, currentFactId, oldFactId);
  assertOldWhy(old, oldFactId, currentFactId);
  assertCurrentWhy(mcp, currentFactId, oldFactId);
  console.log(JSON.stringify({
    schemaVersion: '1.0.0',
    command: 'rust provenance quality',
    currentFactId,
    supersededFactId: oldFactId,
    chainDepth: current.data.chain.length,
    supersedesCount: current.data.supersedes.length,
    mcpParity: 'same fact/provenance/supersession assertions'
  }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
