import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const RUST_BIN = path.join(ROOT, 'rust/target/release/oaf');
const FIXED_NOW = '2026-06-29T00:00:00.000Z';
const CBM_PER_FILE_MS = 2.4;
const M7_FULL_CLI_PARALLEL_MS = 5750;

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

function timedJson(command, args) {
  const started = performance.now();
  const timeArgs = process.platform === 'darwin' ? ['-l', command, ...args] : ['-v', command, ...args];
  const result = spawnSync('/usr/bin/time', timeArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, OAF_FIXED_NOW: FIXED_NOW }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const darwinRss = result.stderr.match(/(\d+)\s+maximum resident set size/u);
  const linuxRss = result.stderr.match(/Maximum resident set size \(kbytes\):\s*(\d+)/u);
  const rssBytes = darwinRss ? Number(darwinRss[1]) : Number(linuxRss?.[1] ?? 0) * 1024;
  return {
    value: JSON.parse(result.stdout),
    ms: Number((performance.now() - started).toFixed(3)),
    peakRssMb: Number((rssBytes / 1024 / 1024).toFixed(1))
  };
}

function runJson(command, args) {
  return JSON.parse(run(command, args).stdout);
}

function rows(sqlite, sql) {
  const db = new DatabaseSync(sqlite);
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

function graphSignature(sqlite) {
  const facts = rows(sqlite, `
    SELECT id, subject, predicate, object, source, status, superseded_by
    FROM memory_facts
    WHERE status IN ('active', 'superseded')
    ORDER BY id
  `);
  const entities = rows(sqlite, `
    SELECT id, kind, name
    FROM memory_entities
    ORDER BY id
  `);
  const edges = rows(sqlite, `
    SELECT e.id, e.source_entity_id, s.name AS source, e.predicate, e.target_entity_id, t.name AS target, e.fact_id
    FROM memory_edges e
    JOIN memory_entities s ON s.id = e.source_entity_id AND s.workspace_id = e.workspace_id
    JOIN memory_entities t ON t.id = e.target_entity_id AND t.workspace_id = e.workspace_id
    ORDER BY e.id
  `);
  return JSON.stringify({ facts, entities, edges });
}

function proposalSignature(sqlite) {
  const proposals = rows(sqlite, `
    SELECT fingerprint, source_locator, source_hash, payload_json
    FROM memory_proposal_queue
    ORDER BY fingerprint
  `);
  return JSON.stringify(proposals);
}

function ingest(workers) {
  const temp = mkdtempSync(path.join(os.tmpdir(), `oaf-rust-ci4-${workers}-`));
  const sqlite = path.join(temp, 'memory.sqlite');
  const timed = timedJson(RUST_BIN, [
    'ingest',
    '--root', ROOT,
    '--sqlite', sqlite,
    '--format', 'json',
    '--workers', String(workers),
    '--max-memory', '350',
    '--max-file-mb', '2'
  ]);
  assert.equal(timed.value.summary.requestedWorkerCount, workers);
  assert.ok(timed.value.summary.effectiveWorkerCount >= 1);
  assert.ok(timed.value.summary.effectiveWorkerCount <= workers);
  assert.equal(timed.value.summary.activeMemoryCreated, 0);
  assert.ok(timed.value.summary.proposalCount > 1000, 'CI-4 gate must ingest the real OAF source graph');
  assert.ok(timed.value.summary.parsedFileCount > 100, 'CI-4 gate parsed too few real OAF files');
  assert.equal(timed.value.safeguards.proposalGated, true);
  assert.equal(timed.value.safeguards.singleWriterCommit, true);
  assert.equal(timed.value.safeguards.unsafeBlocks, 0);

  const proposals = proposalSignature(sqlite);
  const approved = runJson(RUST_BIN, [
    'memory', 'approve', '--all',
    '--root', ROOT,
    '--sqlite', sqlite,
    '--format', 'json'
  ]);
  assert.equal(approved.summary.activeMemoryCreated, timed.value.summary.proposalCount);
  return {
    temp,
    sqlite,
    timed,
    proposals,
    graph: graphSignature(sqlite)
  };
}

const sequential = ingest(1);
const parallel = ingest(4);
try {
  assert.equal(parallel.proposals, sequential.proposals, 'parallel proposal set changed');
  assert.equal(parallel.graph, sequential.graph, 'parallel approved graph changed');
  assert.equal(parallel.timed.value.summary.generatedFactCount, sequential.timed.value.summary.generatedFactCount);
  assert.equal(parallel.timed.value.summary.generatedCallCount, sequential.timed.value.summary.generatedCallCount);
  assert.equal(parallel.timed.value.summary.definitionCount, sequential.timed.value.summary.definitionCount);

  const parsedFiles = parallel.timed.value.summary.parsedFileCount;
  const fullCliSpeedup = Number((sequential.timed.ms / parallel.timed.ms).toFixed(3));
  const extractionSpeedup = Number((sequential.timed.value.summary.elapsedMs / parallel.timed.value.summary.elapsedMs).toFixed(3));
  const fullCliPerFileMs = Number((parallel.timed.ms / parsedFiles).toFixed(3));
  const extractionPerFileMs = Number((parallel.timed.value.summary.elapsedMs / parsedFiles).toFixed(3));
  const remainingFullCliGapVsCbm = Number((fullCliPerFileMs / CBM_PER_FILE_MS).toFixed(2));

  assert.ok(extractionSpeedup > 1, `parallel extraction did not beat sequential extraction: ${extractionSpeedup}`);

  console.log('ingest perf quality:', JSON.stringify({
    methodology: 'Real OAF repo ingest with proposal-gated write path; compare sequential and 4-worker proposal payloads, then approve and compare facts/entities/edges byte-for-byte.',
    parsedFileCount: parsedFiles,
    proposalCount: parallel.timed.value.summary.proposalCount,
    generatedFactCount: parallel.timed.value.summary.generatedFactCount,
    generatedCallCount: parallel.timed.value.summary.generatedCallCount,
    sequentialFullCliMs: sequential.timed.ms,
    parallelFullCliMs: parallel.timed.ms,
    fullCliSpeedup,
    sequentialExtractionMs: sequential.timed.value.summary.elapsedMs,
    parallelExtractionMs: parallel.timed.value.summary.elapsedMs,
    extractionSpeedup,
    parallelPeakRssMb: parallel.timed.peakRssMb,
    fullCliPerFileMs,
    extractionPerFileMs,
    m7FullCliParallelMs: M7_FULL_CLI_PARALLEL_MS,
    fullCliVsM7Baseline: Number((M7_FULL_CLI_PARALLEL_MS / parallel.timed.ms).toFixed(3)),
    cbmPerFileMs: CBM_PER_FILE_MS,
    remainingFullCliGapVsCbm,
    deterministicProposalParity: true,
    deterministicApprovedGraphParity: true,
    singleWriterCommit: parallel.timed.value.safeguards.singleWriterCommit,
    unsafeBlocks: parallel.timed.value.safeguards.unsafeBlocks
  }, null, 2));
} finally {
  rmSync(sequential.temp, { recursive: true, force: true });
  rmSync(parallel.temp, { recursive: true, force: true });
}
