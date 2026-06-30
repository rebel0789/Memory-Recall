import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const RUST_BIN = path.join(ROOT, 'rust/target/release/oaf');
const FIXED_NOW = '2026-06-30T00:00:00.000Z';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, OAF_FIXED_NOW: FIXED_NOW },
    ...options
  });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stderr || result.stdout}`);
  return result;
}

function timedJson(command, args, options = {}) {
  const started = performance.now();
  const result = run(command, args, options);
  return {
    value: JSON.parse(result.stdout),
    ms: Number((performance.now() - started).toFixed(3))
  };
}

function oaf(root, sqlite, args) {
  return timedJson(RUST_BIN, [...args, '--root', root, '--sqlite', sqlite, '--format', 'json']);
}

function dbRows(sqlite, sql) {
  const db = new DatabaseSync(sqlite);
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

function makeRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaf-rust-ci7-'));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src/index.js'), `
export function calculateInvoice(items, taxRate) {
  let subtotal = 0;
  for (const item of items) {
    const price = Number(item.price || 0);
    const quantity = Number(item.quantity || 0);
    if (price > 0 && quantity > 0) {
      subtotal += price * quantity;
    }
  }
  const tax = subtotal * taxRate;
  const total = subtotal + tax;
  return { subtotal, tax, total };
}

export function calculateReceipt(records, rate) {
  let subtotal = 0;
  for (const record of records) {
    const price = Number(record.price || 0);
    const quantity = Number(record.quantity || 0);
    if (price > 0 && quantity > 0) {
      subtotal += price * quantity;
    }
  }
  const tax = subtotal * rate;
  const total = subtotal + tax;
  return { subtotal, tax, total };
}

export function main() {
  const lines = [{ price: 10, quantity: 2 }];
  calculateInvoice(lines, 0.1);
  calculateReceipt(lines, 0.1);
  return lines.length;
}
`);
  writeFileSync(path.join(root, 'src/server.js'), `
function handleHealth(req, res) {
  res.json({ ok: true });
}

app.get('/health', handleHealth);
`);
  writeFileSync(path.join(root, 'src/unused.js'), `
export function unusedIsland() {
  let total = 0;
  for (const value of [1, 2, 3, 4]) {
    total += value;
  }
  return total > 5 ? total : 0;
}
`);
  writeFileSync(path.join(root, 'src/math.test.js'), `
export function testHelper() {
  return calculateInvoice([{ price: 1, quantity: 1 }], 0);
}
`);
  run('git', ['init'], { cwd: root });
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'initial'], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'OAF',
      GIT_AUTHOR_EMAIL: 'oaf@example.test',
      GIT_COMMITTER_NAME: 'OAF',
      GIT_COMMITTER_EMAIL: 'oaf@example.test'
    }
  });
  return root;
}

const root = makeRepo();
const sqlite = path.join(root, '.local/memory.sqlite');
try {
  const ingest = oaf(root, sqlite, ['ingest', '--workers', '1']);
  oaf(root, sqlite, ['memory', 'approve', '--all']);

  const similarity = oaf(root, sqlite, ['similarity']);
  assert.equal(similarity.value.summary.similarEdgeCount, 1, JSON.stringify(similarity.value, null, 2));
  assert.equal(similarity.value.similarEdges[0].subject, 'function:calculateInvoice');
  assert.equal(similarity.value.similarEdges[0].object, 'function:calculateReceipt');
  assert.ok(similarity.value.similarEdges[0].jaccard >= 0.95);
  oaf(root, sqlite, ['memory', 'approve', '--all']);

  const similarFacts = dbRows(sqlite, `
    SELECT subject, predicate, object, source
    FROM memory_facts
    WHERE status = 'active'
      AND superseded_by IS NULL
      AND predicate = 'SIMILAR_TO'
    ORDER BY subject, object
  `);
  assert.deepEqual(similarFacts.map((row) => [row.subject, row.object]), [
    ['function:calculateInvoice', 'function:calculateReceipt']
  ]);

  const deadCode = oaf(root, sqlite, ['dead-code', '--limit', '20']);
  const deadSymbols = deadCode.value.deadCode.map((row) => row.symbol);
  assert.ok(deadSymbols.includes('function:unusedIsland'), JSON.stringify(deadCode.value, null, 2));
  assert.ok(!deadSymbols.includes('function:main'), 'main should be excluded as an entrypoint');
  assert.ok(!deadSymbols.includes('function:handleHealth'), 'route handler should be excluded');
  assert.ok(!deadSymbols.includes('function:testHelper'), 'test helper should be excluded');

  console.log(JSON.stringify({
    schemaVersion: '1.0.0',
    command: 'rust clone dead-code quality',
    methodology: 'Real temporary git repository with one near-duplicate function pair, one main caller, one Express route handler, one test helper, and one intentionally unused function. Similarity is proposal-gated and approved before active SIMILAR_TO facts are checked; dead-code is read-only over approved graph facts.',
    ingest: {
      parsedFileCount: ingest.value.summary.parsedFileCount,
      generatedFactCount: ingest.value.summary.generatedFactCount,
      generatedCallCount: ingest.value.summary.generatedCallCount,
      wallMs: ingest.ms
    },
    similarity: {
      fingerprintCount: similarity.value.summary.fingerprintCount,
      candidatePairCount: similarity.value.summary.candidatePairCount,
      similarEdgeCount: similarity.value.summary.similarEdgeCount,
      proposalCount: similarity.value.summary.proposalCount,
      maxJaccard: similarity.value.similarEdges[0].jaccard,
      wallMs: similarity.ms
    },
    deadCode: {
      candidateCount: deadCode.value.summary.candidateCount,
      returnedCount: deadCode.value.summary.returnedCount,
      excludedEntryPointCount: deadCode.value.summary.excludedEntryPointCount,
      containsUnusedIsland: deadSymbols.includes('function:unusedIsland'),
      excludesMain: !deadSymbols.includes('function:main'),
      excludesRouteHandler: !deadSymbols.includes('function:handleHealth'),
      excludesTest: !deadSymbols.includes('function:testHelper'),
      wallMs: deadCode.ms
    },
    status: 'PASS'
  }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
