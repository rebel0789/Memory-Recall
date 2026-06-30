import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const RUST_BIN = path.join(ROOT, 'rust/target/release/oaf');
const FIXED_NOW = '2026-06-30T03:00:00.000Z';

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

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function startUi(root, sqlite, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(RUST_BIN, ['ui', '--root', root, '--sqlite', sqlite, '--port', String(port), '--format', 'json'], {
      cwd: ROOT,
      env: { ...process.env, OAF_FIXED_NOW: FIXED_NOW },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (settled) return;
      try {
        const info = JSON.parse(stdout);
        settled = true;
        resolve({ child, info, stderr: () => stderr });
      } catch {
        // wait for the pretty-printed JSON startup receipt to finish
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (!settled) reject(new Error(`oaf ui exited early ${code}: ${stderr || stdout}`));
    });
  });
}

assert.equal(existsSync(RUST_BIN), true, 'rust/target/release/oaf must exist; run cargo build --release --manifest-path rust/Cargo.toml first');

const temp = mkdtempSync(path.join(os.tmpdir(), 'oaf-rust-wiki-'));
let child;
try {
  const fixture = path.join(temp, 'fixture');
  const sqlite = path.join(fixture, '.local/memory.sqlite');
  mkdirSync(path.join(fixture, '.local'), { recursive: true });
  writeFileSync(path.join(fixture, 'seed-old.json'), JSON.stringify({
    facts: [
      { subject: 'project:oaf', predicate: 'IS_A', object: 'Project', source: 'workspace://seed-old.json', confidence: 'extracted' },
      { subject: 'decision:memory_policy', predicate: 'HAS_STATUS', object: 'accepted', source: 'workspace://seed-old.json', confidence: 'extracted' },
      { subject: 'decision:memory_policy', predicate: 'DECISION', object: 'memory writes require proposal gate', source: 'workspace://seed-old.json', confidence: 'extracted' },
      { subject: 'project:oaf', predicate: 'GOVERNS', object: 'decision:memory_policy', source: 'workspace://seed-old.json', confidence: 'extracted' }
    ]
  }, null, 2));
  oaf(fixture, sqlite, ['memory', 'remember', '--batch', 'seed-old.json']);
  oaf(fixture, sqlite, ['memory', 'approve', '--all']);
  writeFileSync(path.join(fixture, 'seed-new.json'), JSON.stringify({
    facts: [
      {
        subject: 'decision:memory_policy',
        predicate: 'HAS_STATUS',
        object: 'superseded_by_governed_core',
        source: 'workspace://seed-new.json',
        confidence: 'extracted',
        supersedes: { subject: 'decision:memory_policy', predicate: 'HAS_STATUS', object: 'accepted' }
      },
      { subject: 'decision:memory_policy', predicate: 'SUPERSEDES', object: 'decision:legacy_memory_policy', source: 'workspace://seed-new.json', confidence: 'extracted' }
    ]
  }, null, 2));
  oaf(fixture, sqlite, ['memory', 'remember', '--batch', 'seed-new.json']);
  oaf(fixture, sqlite, ['memory', 'approve', '--all']);

  const port = await freePort();
  const started = await startUi(fixture, sqlite, port);
  child = started.child;
  assert.equal(started.info.safeguards.assetsCompiledIn, true);
  const html = await fetch(`${started.info.url}/wiki`).then((response) => response.text());
  const wiki = await fetch(`${started.info.url}/api/wiki`).then((response) => response.json());

  assert.match(html, /OAF Knowledge Wiki/u);
  assert.equal(/https?:\/\//u.test(html), false, 'wiki HTML must not reference external URLs');
  assert.equal(/cdn\./iu.test(html), false, 'wiki HTML must not reference a CDN host');
  assert.equal(wiki.summary.offline, true);
  assert.equal(wiki.summary.zeroCdn, true);
  assert.equal(wiki.summary.modelCalls, 0);
  assert.equal(wiki.summary.networkCalls, 0);
  assert.ok(wiki.summary.entityPageCount >= 2, 'wiki should expose entity pages');
  assert.ok(wiki.summary.communityPageCount >= 2, 'wiki should expose community pages');
  assert.ok(wiki.summary.decisionPageCount >= 2, 'wiki should expose decision pages');
  assert.ok(wiki.summary.currentFactCount >= 4, 'wiki should expose current truth');
  assert.ok(wiki.summary.historyFactCount >= 1, 'wiki should expose superseded history');
  assert.deepEqual(wiki.pages.index.sections, ['entities', 'communities', 'decisions', 'currentTruth', 'history']);
  assert.ok(wiki.pages.history.some((fact) => fact.subject === 'decision:memory_policy' && fact.object === 'accepted'), 'history must retain superseded decision status');
  assert.ok(wiki.pages.currentTruth.some((fact) => fact.subject === 'decision:memory_policy' && fact.object === 'superseded_by_governed_core'), 'current truth must show latest decision status');

  console.log(JSON.stringify({
    schemaVersion: '1.0.0',
    command: 'rust wiki quality',
    methodology: 'Governed memory fixture with superseded decision; oaf ui serves /wiki and /api/wiki from compiled local assets and read-only SQLite state.',
    coverage: {
      entityPageCount: wiki.summary.entityPageCount,
      communityPageCount: wiki.summary.communityPageCount,
      decisionPageCount: wiki.summary.decisionPageCount,
      currentFactCount: wiki.summary.currentFactCount,
      historyFactCount: wiki.summary.historyFactCount
    },
    offlineProof: {
      htmlBytes: html.length,
      externalUrlReferences: 0,
      cdnReferences: 0,
      networkCalls: wiki.summary.networkCalls,
      modelCalls: wiki.summary.modelCalls,
      zeroCdn: wiki.summary.zeroCdn
    },
    status: 'PASS'
  }, null, 2));
} finally {
  if (child) child.kill();
  rmSync(temp, { recursive: true, force: true });
}
