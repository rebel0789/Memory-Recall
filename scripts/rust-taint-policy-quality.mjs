import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const RUST_BIN = path.join(ROOT, 'rust/target/release/oaf');
const SQLITE = '.local/memory.sqlite';
const NOW = '2026-06-30T01:00:00.000Z';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, OAF_FIXED_NOW: NOW },
    ...options,
  });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stderr || result.stdout}`);
  return result;
}

function runJson(command, args, options = {}) {
  return JSON.parse(run(command, args, options).stdout);
}

function makeRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaf-rust-s3-'));
  mkdirSync(path.join(root, '.local'), { recursive: true });
  writeFileSync(path.join(root, 'EXTERNAL.md'), 'External report claims auth uses vendor-oauth.\n');
  return root;
}

function rpc(messages) {
  return messages.map((message) => JSON.stringify(message)).join('\n');
}

function mcpProfile(root) {
  const result = run(RUST_BIN, ['mcp', 'server', '--read-only', '--root', root, '--sqlite', SQLITE, '--stdio'], {
    input: rpc([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'context.profile', arguments: { client: 's3-taint', objective: 'auth', scope: 'workspace', limit: 5, budget: 4096 } } }
    ])
  });
  const lines = result.stdout.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(lines[0].result.protocolVersion, '2025-06-18');
  assert.ok(lines[1].result?.content?.[0]?.text, JSON.stringify(lines, null, 2));
  return JSON.parse(lines[1].result.content[0].text);
}

const root = makeRoot();
try {
  const remember = runJson(RUST_BIN, [
    'memory', 'remember',
    '--subject', 'auth',
    '--predicate', 'uses',
    '--object', 'vendor-oauth',
    '--source', 'workspace://EXTERNAL.md',
    '--source-trust', 'untrusted',
    '--root', root,
    '--sqlite', SQLITE,
    '--format', 'json'
  ]);
  assert.equal(remember.summary.activeMemoryCreated, 0, JSON.stringify(remember, null, 2));
  assert.equal(remember.summary.pendingProposalCount, 1, JSON.stringify(remember, null, 2));
  assert.equal(remember.proposal.payload.sourceTrust, 'untrusted');
  assert.equal(remember.proposal.payload.trustClass, 'untrusted');
  assert.equal(remember.proposal.payload.policyReceipt.decision, 'queue_only');
  assert.equal(remember.proposal.payload.policyReceipt.reason, 'untrusted_source_requires_explicit_approval');
  assert.equal(remember.policyReceipts[0].decision, 'queue_only');
  assert.equal(remember.fact, null);

  const review = runJson(RUST_BIN, ['memory', 'review', '--root', root, '--sqlite', SQLITE, '--format', 'json']);
  assert.equal(review.summary.pendingProposalCount, 1, JSON.stringify(review, null, 2));
  assert.equal(review.proposalFacts[0].sourceTrust, 'untrusted');
  assert.equal(review.proposalFacts[0].policyReceipt.decision, 'queue_only');

  const approved = runJson(RUST_BIN, ['memory', 'approve', '--all-from', 'workspace://EXTERNAL.md', '--root', root, '--sqlite', SQLITE, '--format', 'json']);
  assert.equal(approved.summary.activeMemoryCreated, 1, JSON.stringify(approved, null, 2));
  assert.equal(approved.facts[0].metadata.sourceTrust, 'untrusted');
  assert.equal(approved.facts[0].metadata.trustClass, 'untrusted');
  assert.equal(approved.facts[0].metadata.policyReceipt.decision, 'approved_after_review');

  const profile = mcpProfile(root);
  const record = profile.data.selectedFacts.find((item) => item.sourceTrust === 'untrusted');
  assert.ok(record, JSON.stringify(profile, null, 2));
  assert.equal(record.sourceTrust, 'untrusted');
  assert.equal(record.trustClass, 'untrusted');
  assert.equal(record.metadata.policyReceipt.decision, 'approved_after_review');

  console.log(JSON.stringify({
    schemaVersion: '1.0.0',
    command: 'rust taint policy quality',
    untrustedAutoCommitted: false,
    pendingBeforeApproval: remember.summary.pendingProposalCount,
    approvedAfterExplicitReview: approved.summary.activeMemoryCreated,
    profileTrustClass: record.trustClass
  }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
