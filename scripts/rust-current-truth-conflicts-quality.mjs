import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const RUST_BIN = path.join(ROOT, 'rust/target/release/oaf');
const SQLITE = '.local/memory.sqlite';
const NOW = '2026-06-30T02:00:00.000Z';

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

function rpc(messages) {
  return messages.map((message) => JSON.stringify(message)).join('\n');
}

function mcp(root, name, args) {
  const result = run(RUST_BIN, ['mcp', 'server', '--read-only', '--root', root, '--sqlite', SQLITE, '--stdio'], {
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

function remember(root, object, source) {
  return runJson(RUST_BIN, [
    'memory', 'remember',
    '--subject', 'auth',
    '--predicate', 'token_expiry',
    '--object', object,
    '--source', source,
    '--root', root,
    '--sqlite', SQLITE,
    '--format', 'json'
  ]);
}

function assertConflict(payload) {
  assert.equal(payload.data.conflicts.summary.conflictCount, 1, JSON.stringify(payload, null, 2));
  const [conflict] = payload.data.conflicts.items;
  assert.equal(conflict.reason, 'active_same_subject_predicate');
  assert.equal(conflict.subject, 'auth');
  assert.equal(conflict.predicate, 'token_expiry');
  assert.deepEqual(conflict.objects.sort(), ['15 minutes', '60 minutes']);
  assert.equal(conflict.facts.length, 2);
  assert.equal(conflict.facts.every((fact) => fact.status === 'active'), true);
}

const root = mkdtempSync(path.join(os.tmpdir(), 'oaf-rust-s4-'));
try {
  mkdirSync(path.join(root, '.local'), { recursive: true });
  writeFileSync(path.join(root, 'DECISIONS.md'), 'Two unsuperseded token expiry claims disagree.\n');
  remember(root, '60 minutes', 'workspace://DECISIONS.md');
  remember(root, '15 minutes', 'workspace://DECISIONS.md');

  const defaultRecall = mcp(root, 'memory.recall', {
    client: 's4-default',
    query: 'auth token expiry',
    subject: 'auth',
    predicate: 'token_expiry',
    scope: 'workspace',
    limit: 20,
    currentTruthOnly: true
  });
  assert.equal(defaultRecall.data.conflicts, undefined, 'default recall must stay byte-parity compatible');

  const recall = mcp(root, 'memory.recall', {
    client: 's4-recall',
    query: 'auth token expiry',
    subject: 'auth',
    predicate: 'token_expiry',
    scope: 'workspace',
    limit: 20,
    currentTruthOnly: true,
    withConflicts: true
  });
  assertConflict(recall);

  const profile = mcp(root, 'context.profile', {
    client: 's4-profile',
    objective: 'auth token expiry',
    scope: 'workspace',
    limit: 20,
    budget: 4096,
    currentTruthOnly: true,
    withConflicts: true
  });
  assertConflict(profile);

  console.log(JSON.stringify({
    schemaVersion: '1.0.0',
    command: 'rust current truth conflicts quality',
    conflictCount: recall.data.conflicts.summary.conflictCount,
    activeFactsInConflict: recall.data.conflicts.items[0].facts.length,
    defaultParity: 'conflicts omitted unless withConflicts=true'
  }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
