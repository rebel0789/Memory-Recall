import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const RUST_BIN = path.join(ROOT, 'rust/target/release/oaf');
const SQLITE = '.local/memory.sqlite';
const FIXED_NOW = '2026-06-30T00:00:00.000Z';
const REASONS = new Set([
  'budget_pressure',
  'lower_relevance',
  'superseded',
  'untrusted_source',
  'duplicate',
  'filtered_secret'
]);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, OAF_FIXED_NOW: FIXED_NOW },
    ...options
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

function mcp(command, args, messages) {
  return run(command, args, { input: rpc(messages) })
    .stdout.trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function payload(response) {
  return JSON.parse(response.result.content[0].text);
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      key === 'generatedAt' ||
      key === 'sessionId' ||
      /fingerprint$/iu.test(key) ||
      /hash$/iu.test(key) ||
      (key === 'requestId' && typeof item === 'string' && item.startsWith('ctxreq_')) ||
      (key === 'id' && typeof item === 'string' && /^(ctx|ctxprofile|ctxpack|hctxprev|ctxreq)_/u.test(item))
    ) out[key] = '<normalized>';
    else out[key] = normalize(item);
  }
  return out;
}

function normalizeMcp(value) {
  const out = normalize(value);
  if (Array.isArray(out)) return out.map(normalizeMcp);
  const content = out?.result?.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item?.type === 'text' && typeof item.text === 'string' && item.text.trim().startsWith('{')) {
        item.text = normalize(JSON.parse(item.text));
      }
    }
  }
  return out;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertMcpParity(label, rustValue, nodeValue) {
  assert.equal(canonical(normalizeMcp(rustValue)), canonical(normalizeMcp(nodeValue)), label);
}

function makeRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaf-rust-s1-'));
  mkdirSync(path.join(root, '.local'), { recursive: true });
  writeFileSync(path.join(root, 'DECISIONS.md'), 'Auth token expiry changed from 60 minutes to 15 minutes.\n');
  return root;
}

function seed(root) {
  runJson(RUST_BIN, [
    'memory', 'remember',
    '--subject', 'auth',
    '--predicate', 'token_expiry',
    '--object', '60 minutes',
    '--source', 'workspace://DECISIONS.md',
    '--root', root,
    '--sqlite', SQLITE,
    '--format', 'json'
  ]);
  const facts = [
    { subject: 'auth', predicate: 'token_expiry', object: '15 minutes', source: 'workspace://DECISIONS.md', supersedes: { subject: 'auth', predicate: 'token_expiry' } }
  ];
  for (let i = 0; i < 20; i += 1) {
    facts.push({
      subject: 'auth',
      predicate: `decision_${i}`,
      object: `auth token supporting detail ${i}`,
      source: 'workspace://DECISIONS.md'
    });
  }
  writeFileSync(path.join(root, 'facts.json'), JSON.stringify({ facts }, null, 2));
  runJson(RUST_BIN, ['memory', 'remember', '--batch', 'facts.json', '--root', root, '--sqlite', SQLITE, '--format', 'json']);
  runJson(RUST_BIN, ['memory', 'approve', '--all-from', 'workspace://DECISIONS.md', '--root', root, '--sqlite', SQLITE, '--format', 'json']);
}

function seedSmall(root) {
  runJson(RUST_BIN, [
    'memory', 'remember',
    '--subject', 'auth',
    '--predicate', 'token_expiry',
    '--object', '15 minutes',
    '--source', 'workspace://DECISIONS.md',
    '--root', root,
    '--sqlite', SQLITE,
    '--format', 'json'
  ]);
  runJson(RUST_BIN, [
    'memory', 'remember',
    '--subject', 'auth',
    '--predicate', 'refresh_tokens',
    '--object', 'enabled, 24h',
    '--source', 'workspace://DECISIONS.md',
    '--root', root,
    '--sqlite', SQLITE,
    '--format', 'json'
  ]);
}

function toolCall(name, args) {
  return [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }
  ];
}

function rustMcp(root, messages) {
  return mcp(RUST_BIN, ['mcp', 'server', '--read-only', '--root', root, '--sqlite', SQLITE, '--stdio'], messages);
}

function nodeMcp(root, messages) {
  return mcp(process.execPath, ['apps/cli/oaf.mjs', 'mcp', 'server', '--read-only', '--root', root, '--sqlite', SQLITE, '--stdio'], messages);
}

function assertOmissions(report, label) {
  assert.ok(Array.isArray(report.omissions), `${label} must expose top-level omissions array`);
  assert.ok(report.omissions.length > 0, `${label} omissions must be non-empty`);
  for (const item of report.omissions) {
    assert.equal(typeof item.type, 'string');
    assert.equal(typeof item.ref, 'string');
    assert.equal(typeof item.reason, 'string');
    assert.equal(typeof item.recoverable_by, 'string');
    assert.equal(REASONS.has(item.reason), true, `invalid reason ${item.reason}`);
    assert.ok(item.recoverable_by.length > 0, `${label} omission must be recoverable`);
  }
  const reasons = new Set(report.omissions.map((item) => item.reason));
  assert.equal(reasons.has('budget_pressure'), true, `${label} missing budget_pressure`);
  assert.equal(reasons.has('superseded'), true, `${label} missing superseded`);
}

const parityRoot = makeRoot();
const root = makeRoot();
try {
  seedSmall(parityRoot);
  seed(root);
  const profileArgs = { client: 's1-default-profile', objective: 'auth token expiry', step: 'ship notes auth', scope: 'workspace', limit: 20, budget: 4096 };
  const packArgs = { client: 's1-default-pack', objective: 'auth token expiry', step: 'ship notes auth', target: 'generic', budget: 4096 };
  assertMcpParity('default context.profile parity', rustMcp(parityRoot, toolCall('context.profile', profileArgs)), nodeMcp(parityRoot, toolCall('context.profile', profileArgs)));
  assertMcpParity('default context.pack parity', rustMcp(parityRoot, toolCall('context.pack', packArgs)), nodeMcp(parityRoot, toolCall('context.pack', packArgs)));

  const profile = payload(rustMcp(root, toolCall('context.profile', { ...profileArgs, budget: 25, withOmissions: true }))[1]);
  const pack = payload(rustMcp(root, toolCall('context.pack', { ...packArgs, budget: 25, withOmissions: true }))[1]);
  assertOmissions(profile, 'context.profile');
  assertOmissions(pack, 'context.pack');
  console.log(JSON.stringify({
    schemaVersion: '1.0.0',
    command: 'rust omission quality',
    defaultParity: ['context.profile', 'context.pack'],
    profileOmissionCount: profile.omissions.length,
    packOmissionCount: pack.omissions.length,
    reasons: [...new Set([...profile.omissions, ...pack.omissions].map((item) => item.reason))].sort()
  }, null, 2));
} finally {
  rmSync(parityRoot, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
