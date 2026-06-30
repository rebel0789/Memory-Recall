import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const RUST_BIN = path.join(ROOT, 'rust/target/release/oaf');
const FIXED_NOW = '2026-06-30T00:00:00.000Z';

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

function db(root, sqlite) {
  return new DatabaseSync(path.isAbsolute(sqlite) ? sqlite : path.join(root, sqlite));
}

function rows(root, sqlite, sql) {
  const database = db(root, sqlite);
  try {
    return database.prepare(sql).all();
  } finally {
    database.close();
  }
}

function makePdf(text) {
  const escaped = text.replace(/[()\\]/gu, (char) => `\\${char}`);
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    `5 0 obj\n<< /Length ${escaped.length + 44} >>\nstream\nBT /F1 18 Tf 72 720 Td (${escaped}) Tj ET\nendstream\nendobj\n`
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body, 'utf8'));
    body += object;
  }
  const xref = Buffer.byteLength(body, 'utf8');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xref}\n%%EOF\n`;
  return body;
}

assert.equal(existsSync(RUST_BIN), true, 'rust/target/release/oaf must exist; run cargo build --release --manifest-path rust/Cargo.toml first');

const temp = mkdtempSync(path.join(os.tmpdir(), 'oaf-rust-docs-'));
try {
  const fixture = path.join(temp, 'fixture');
  const sqlite = path.join(fixture, '.local/memory.sqlite');
  mkdirSync(path.join(fixture, '.local'), { recursive: true });
  mkdirSync(path.join(fixture, 'docs/adr'), { recursive: true });
  writeFileSync(path.join(fixture, 'docs/adr/0001-storage.md'), [
    '# ADR 0001 Storage',
    'Status: accepted',
    'Decision: Use SQLite for local memory.',
    'Context: Local-first operation must not require an external database.'
  ].join('\n'));
  writeFileSync(path.join(fixture, 'README.md'), [
    '# Fixture Project',
    'The project runs offline and stores governed memory locally.'
  ].join('\n'));
  writeFileSync(path.join(fixture, 'notes.txt'), 'Receipt-first local connector export.\n');
  writeFileSync(path.join(fixture, 'policy.pdf'), makePdf('Offline PDF policy uses governed proposals'));

  const first = oaf(fixture, sqlite, ['ingest-docs']);
  assert.equal(first.command, 'ingest-docs');
  assert.equal(first.safeguards.proposalGated, true);
  assert.equal(first.safeguards.modelCalls, 0);
  assert.equal(first.safeguards.networkCalls, 0);
  assert.equal(first.safeguards.externalVectorDatabase, false);
  assert.ok(first.summary.parsedFileCount >= 4, 'fixture must parse markdown, text, ADR, and PDF');
  assert.equal(first.summary.formatCounts.pdf, 1, 'fixture PDF must be parsed');
  assert.ok(first.proposalFacts.some((fact) => fact.provenance.sourceLocator === 'workspace://policy.pdf'), 'PDF provenance must be present');
  assert.ok(first.proposalFacts.some((fact) => fact.provenance.sourceLocator === 'workspace://docs/adr/0001-storage.md'), 'ADR provenance must be present');
  oaf(fixture, sqlite, ['memory', 'approve', '--all']);

  writeFileSync(path.join(fixture, 'docs/adr/0002-storage.md'), [
    '# ADR 0002 Storage',
    'Status: accepted',
    'Supersedes: 0001-storage',
    'Decision: Use embedded SQLite plus governed proposal receipts for local memory.'
  ].join('\n'));
  const second = oaf(fixture, sqlite, ['ingest-docs']);
  assert.ok(second.summary.generatedSupersessionCount >= 1, 'new ADR must emit supersession proposals');
  assert.ok(second.proposalFacts.some((fact) => fact.subject === 'decision:0001_storage' && fact.predicate === 'HAS_STATUS' && fact.object.startsWith('retired_by_')), 'old ADR retirement proposal must be queued');
  oaf(fixture, sqlite, ['memory', 'approve', '--all']);

  const statuses = rows(fixture, sqlite, `
    SELECT subject, predicate, object, status, superseded_by
    FROM memory_facts
    WHERE subject = 'decision:0001_storage'
      AND predicate = 'HAS_STATUS'
    ORDER BY object
  `);
  const accepted = statuses.find((fact) => fact.object === 'accepted');
  const retired = statuses.find((fact) => fact.object.startsWith('retired_by_'));
  assert.ok(accepted, 'old accepted status must have existed');
  assert.notEqual(accepted.superseded_by, null, 'old accepted status must be superseded');
  assert.ok(retired, 'retirement status must be active');
  assert.equal(retired.superseded_by, null, 'retirement status must be current');

  const realSqlite = path.join(temp, 'real-oaf-docs.sqlite');
  const real = oaf(ROOT, realSqlite, ['ingest-docs', '--max-file-bytes', '2000000', '--max-memory-bytes', '70000000']);
  assert.ok(real.summary.parsedFileCount >= 25, 'real OAF docs must be the quality input, not only fixtures');
  assert.ok(real.summary.generatedDecisionCount >= 5, 'real OAF docs should surface decisions from plans/architecture docs');
  assert.equal(real.safeguards.modelCalls, 0);
  assert.equal(real.safeguards.networkCalls, 0);
  assert.equal(real.safeguards.rawSourceBodiesIncluded, false);

  console.log(JSON.stringify({
    schemaVersion: '1.0.0',
    command: 'rust docs ingest quality',
    methodology: 'Fixture covers markdown, ADR supersession, text, and PDF; real OAF docs tree verifies non-synthetic coverage. All facts are proposal-gated and local.',
    fixture: {
      first: first.summary,
      second: second.summary,
      statusRows: statuses
    },
    realOafDocs: {
      parsedFileCount: real.summary.parsedFileCount,
      generatedFactCount: real.summary.generatedFactCount,
      generatedDecisionCount: real.summary.generatedDecisionCount,
      generatedSupersessionCount: real.summary.generatedSupersessionCount,
      formatCounts: real.summary.formatCounts,
      elapsedMs: real.summary.elapsedMs
    },
    safeguards: real.safeguards,
    status: 'PASS'
  }, null, 2));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
