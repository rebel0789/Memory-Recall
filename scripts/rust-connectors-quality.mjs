import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const RUST_BIN = path.join(ROOT, 'rust/target/release/oaf');
const FIXED_NOW = '2026-06-30T02:00:00.000Z';

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

function scalar(root, sqlite, sql) {
  const database = new DatabaseSync(path.isAbsolute(sqlite) ? sqlite : path.join(root, sqlite));
  try {
    return Object.values(database.prepare(sql).get())[0];
  } finally {
    database.close();
  }
}

assert.equal(existsSync(RUST_BIN), true, 'rust/target/release/oaf must exist; run cargo build --release --manifest-path rust/Cargo.toml first');

const temp = mkdtempSync(path.join(os.tmpdir(), 'oaf-rust-connectors-'));
try {
  const fixture = path.join(temp, 'fixture');
  const sqlite = path.join(fixture, '.local/memory.sqlite');
  mkdirSync(path.join(fixture, '.local'), { recursive: true });
  mkdirSync(path.join(fixture, 'docs'), { recursive: true });
  mkdirSync(path.join(fixture, 'notion-export'), { recursive: true });
  mkdirSync(path.join(fixture, 'obsidian-vault'), { recursive: true });
  mkdirSync(path.join(fixture, 'github'), { recursive: true });
  writeFileSync(path.join(fixture, 'docs/guide.md'), [
    '# Local Connector Guide',
    'Status: accepted',
    'Decision: Connector imports stay proposal-gated and local.'
  ].join('\n'));
  writeFileSync(path.join(fixture, 'notion-export/project.md'), [
    '# Notion Export',
    'Decision: Notion exports are treated as local markdown snapshots.'
  ].join('\n'));
  writeFileSync(path.join(fixture, 'obsidian-vault/Memory.md'), [
    '# Obsidian Memory',
    'Decision: Obsidian vault notes are imported from disk only.'
  ].join('\n'));
  writeFileSync(path.join(fixture, 'github/issues.json'), JSON.stringify([
    { number: 7, title: 'Keep connectors local first', state: 'OPEN', url: 'https://example.invalid/7' },
    { number: 8, title: 'Do not store gh credentials', state: 'CLOSED', url: 'https://example.invalid/8' }
  ], null, 2));
  writeFileSync(path.join(fixture, 'chat.json'), JSON.stringify({
    messages: [
      { role: 'user', content: 'Remember local connector receipts.' },
      { role: 'assistant', content: 'Queued only after review.' }
    ]
  }, null, 2));

  const docs = oaf(fixture, sqlite, ['connectors', 'ingest', '--kind', 'docs-folder', '--path', 'docs']);
  const notion = oaf(fixture, sqlite, ['connectors', 'ingest', '--kind', 'notion-export', '--path', 'notion-export']);
  const obsidian = oaf(fixture, sqlite, ['connectors', 'ingest', '--kind', 'obsidian-export', '--path', 'obsidian-vault']);
  const github = oaf(fixture, sqlite, ['connectors', 'ingest', '--kind', 'github-gh', '--fixture', 'github/issues.json']);
  const chat = oaf(fixture, sqlite, ['connectors', 'ingest', '--kind', 'chat-export', '--path', 'chat.json']);

  for (const report of [docs, notion, obsidian, github, chat]) {
    assert.equal(report.command, 'connectors ingest');
    assert.equal(report.safeguards.proposalGated, true);
    assert.equal(report.safeguards.modelCalls, 0);
    assert.equal(report.safeguards.networkCalls, 0);
    assert.equal(report.safeguards.credentialsStored, false);
    assert.equal(report.safeguards.unexpectedNetwork, false);
    assert.equal(report.connectorReceipt.receiptFirst, true);
    assert.ok(report.summary.proposalCount > 0, `${report.summary.connectorKind} must queue governed facts`);
  }
  assert.equal(docs.connectorReceipt.sourceCount, 1);
  assert.equal(notion.connectorReceipt.connectorKind, 'notion-export');
  assert.equal(obsidian.connectorReceipt.connectorKind, 'obsidian-export');
  assert.equal(github.connectorReceipt.mode, 'recorded-fixture');
  assert.equal(github.connectorReceipt.itemCount, 2);
  assert.equal(chat.connectorReceipt.messageCount, 2);
  assert.equal(chat.connectorReceipt.trustClass, 'untrusted_external');

  oaf(fixture, sqlite, ['memory', 'approve', '--all']);
  const githubIssueCount = scalar(fixture, sqlite, `
    SELECT count(*)
    FROM memory_facts
    WHERE subject LIKE 'github:issue_%'
      AND status = 'active'
      AND superseded_by IS NULL
  `);
  const connectorPolicyCount = scalar(fixture, sqlite, `
    SELECT count(*)
    FROM memory_facts
    WHERE metadata_json LIKE '%"sourceTrust":"untrusted"%'
      AND source LIKE 'workspace://github/%'
  `);
  assert.ok(githubIssueCount >= 6, 'GitHub fixture should create issue entity/title/state facts');
  assert.ok(connectorPolicyCount >= 1, 'GitHub external facts should carry untrusted source trust');

  console.log(JSON.stringify({
    schemaVersion: '1.0.0',
    command: 'rust connectors quality',
    methodology: 'Local fixture exercises docs folder, Notion markdown export, Obsidian vault export, GitHub recorded fixture, and chat export metadata. No network, credentials, cloud, model, vector DB, or graph DB is used.',
    connectorReports: {
      docs: docs.summary,
      notion: notion.summary,
      obsidian: obsidian.summary,
      github: github.summary,
      chat: chat.summary
    },
    githubIssueFactCount: githubIssueCount,
    githubUntrustedFactCount: connectorPolicyCount,
    safeguards: {
      networkCalls: [docs, notion, obsidian, github, chat].reduce((sum, item) => sum + item.safeguards.networkCalls, 0),
      modelCalls: [docs, notion, obsidian, github, chat].reduce((sum, item) => sum + item.safeguards.modelCalls, 0),
      credentialsStored: false,
      unexpectedNetwork: false
    },
    status: 'PASS'
  }, null, 2));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
