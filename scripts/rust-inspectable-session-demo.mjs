import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const RUST_BIN = path.join(ROOT, 'rust/target/release/oaf');
const NOW = '2026-06-30T03:00:00.000Z';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, OAF_FIXED_NOW: options.now ?? NOW },
    ...options,
  });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stderr || result.stdout}`);
  return result;
}

function runJson(command, args, options = {}) {
  return JSON.parse(run(command, args, options).stdout);
}

function rpc(messages) {
  return messages.map((message) => JSON.stringify(message)).join('\n');
}

function mcp(sqlite, name, args) {
  const cursor = path.join(path.dirname(sqlite), `${name.replaceAll('.', '-')}-${Date.now()}.json`);
  const result = run(RUST_BIN, ['mcp', 'server', '--read-only', '--root', ROOT, '--sqlite', sqlite, '--cursors', cursor, '--stdio'], {
    input: rpc([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }
    ])
  });
  const lines = result.stdout.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(lines[0].result.protocolVersion, '2025-06-18');
  assert.ok(lines[1].result?.content?.[0]?.text, JSON.stringify(lines, null, 2));
  return JSON.parse(lines[1].result.content[0].text);
}

function remember(sqlite, args, options = {}) {
  return runJson(RUST_BIN, ['memory', 'remember', ...args, '--root', ROOT, '--sqlite', sqlite, '--format', 'json'], options);
}

function approve(sqlite, args = []) {
  return runJson(RUST_BIN, ['memory', 'approve', ...args, '--root', ROOT, '--sqlite', sqlite, '--format', 'json']);
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'oaf-rust-s5-'));
const sqlite = path.join(tmp, 'memory.sqlite');
try {
  remember(sqlite, ['--subject', 'auth', '--predicate', 'token_expiry', '--object', '60 minutes', '--source', 'workspace://README.md'], {
    now: '2026-06-30T02:00:00.000Z'
  });
  const current = remember(sqlite, [
    '--subject', 'auth',
    '--predicate', 'token_expiry',
    '--object', '15 minutes',
    '--supersedes-subject', 'auth',
    '--supersedes-predicate', 'token_expiry',
    '--source', 'workspace://README.md'
  ], { now: '2026-06-30T02:10:00.000Z' });
  remember(sqlite, ['--subject', 'auth', '--predicate', 'token_expiry', '--object', '30 minutes', '--source', 'workspace://README.md'], {
    now: '2026-06-30T02:20:00.000Z'
  });
  const untrusted = remember(sqlite, [
    '--subject', 'auth',
    '--predicate', 'external_claim',
    '--object', 'vendor-oauth',
    '--source', 'workspace://package.json',
    '--source-trust', 'untrusted'
  ], { now: '2026-06-30T02:30:00.000Z' });
  assert.equal(untrusted.summary.activeMemoryCreated, 0);
  assert.equal(untrusted.summary.pendingProposalCount, 1);

  const factsPath = path.join(tmp, 'facts.json');
  const fillerFacts = Array.from({ length: 18 }, (_, index) => ({
    subject: `session:item_${index}`,
    predicate: 'notes',
    object: `detail_${index}`,
    source: 'workspace://README.md'
  }));
  writeFileSync(factsPath, JSON.stringify({ facts: fillerFacts }, null, 2));
  const batch = runJson(RUST_BIN, ['memory', 'remember', '--batch', factsPath, '--root', ROOT, '--sqlite', sqlite, '--format', 'json']);
  assert.equal(batch.summary.recordedCount, fillerFacts.length);
  approve(sqlite, ['--all-from', 'workspace://README.md']);

  const why = runJson(RUST_BIN, ['memory', 'why', current.fact.id, '--root', ROOT, '--sqlite', sqlite, '--format', 'json']);
  assert.equal(why.data.fact.id, current.fact.id);
  assert.equal(why.data.supersedes.some((fact) => fact.object === '60 minutes'), true);

  const review = runJson(RUST_BIN, ['memory', 'review', '--root', ROOT, '--sqlite', sqlite, '--format', 'json']);
  assert.equal(review.summary.pendingProposalCount, 1);
  assert.equal(review.proposalFacts[0].sourceTrust, 'untrusted');
  assert.equal(review.proposalFacts[0].policyReceipt.decision, 'queue_only');

  const recall = mcp(sqlite, 'memory.recall', {
    client: 's5-recall',
    query: 'auth token expiry',
    subject: 'auth',
    predicate: 'token_expiry',
    scope: 'workspace',
    limit: 20,
    currentTruthOnly: true,
    withConflicts: true
  });
  assert.ok(recall.data.conflicts, JSON.stringify(recall, null, 2));
  assert.equal(recall.data.conflicts.summary.conflictCount, 1);

  const profile = mcp(sqlite, 'context.profile', {
    client: 's5-profile',
    objective: 'auth token expiry session',
    scope: 'workspace',
    limit: 20,
    budget: 25,
    currentTruthOnly: true,
    withConflicts: true,
    withOmissions: true
  });
  assert.ok(profile.omissions.length > 0, JSON.stringify(profile, null, 2));
  assert.equal(profile.data.conflicts.summary.conflictCount, 1);

  console.log(JSON.stringify({
    schemaVersion: '1.0.0',
    command: 'rust inspectable session demo',
    realRepoRoot: ROOT,
    sqliteLocation: 'tempfile',
    checkpoints: {
      omissions: { count: profile.omissions.length, reasons: [...new Set(profile.omissions.map((item) => item.reason))].sort() },
      provenance: { chainDepth: why.data.chain.length, supersedesCount: why.data.supersedes.length },
      taint: { untrustedAutoCommitted: false, pendingProposalCount: review.summary.pendingProposalCount },
      conflicts: { conflictCount: recall.data.conflicts.summary.conflictCount, activeFacts: recall.data.conflicts.items[0].facts.length }
    },
    honestEval: {
      modelCalls: 0,
      networkCalls: 0,
      productFilesChanged: false,
      rootKind: 'real-oaf-repo',
      limitations: [
        'S5 is a deterministic harness demo, not a replay or flight recorder.',
        'Semantic search remains covered by the existing experimental M9 harness, not changed here.',
        'Conflict surfacing identifies active same-subject/predicate disagreement; it does not resolve truth automatically.'
      ]
    }
  }, null, 2));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
