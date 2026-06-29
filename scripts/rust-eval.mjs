import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const RUST_BIN = path.join(ROOT, 'rust/target/release/oaf');
const FIXED_NOW = '2026-06-29T00:00:00.000Z';
const CBM_PER_FILE_MS = 2.4;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, OAF_FIXED_NOW: FIXED_NOW },
    ...options
  });
  assert.equal(result.status, options.expectedStatus ?? 0, `${command} ${args.join(' ')}\n${result.stderr || result.stdout}`);
  return result;
}

function timedJson(command, args, options = {}) {
  const started = performance.now();
  const result = spawnSync('/usr/bin/time', ['-l', command, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, OAF_FIXED_NOW: FIXED_NOW },
    ...options
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const rssBytes = Number(result.stderr.match(/(\d+)\s+maximum resident set size/u)?.[1] ?? 0);
  return {
    value: JSON.parse(result.stdout),
    ms: Number((performance.now() - started).toFixed(3)),
    peakRssMb: Number((rssBytes / 1024 / 1024).toFixed(1))
  };
}

function runJson(command, args, options = {}) {
  return JSON.parse(run(command, args, options).stdout);
}

function rust(root, args, sqlite) {
  return runJson(RUST_BIN, [...args, '--root', root, '--sqlite', sqlite, '--format', 'json']);
}

function database(root, sqlite) {
  return new DatabaseSync(path.isAbsolute(sqlite) ? sqlite : path.join(root, sqlite));
}

function rows(root, sqlite, sql) {
  const db = database(root, sqlite);
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

function graphSignature(root, sqlite) {
  const facts = rows(root, sqlite, `
    SELECT id, subject, predicate, object, source, status, superseded_by
    FROM memory_facts
    WHERE status IN ('active', 'superseded')
    ORDER BY id
  `);
  const entities = rows(root, sqlite, `
    SELECT id, kind, name
    FROM memory_entities
    ORDER BY id
  `);
  const edges = rows(root, sqlite, `
    SELECT e.id, e.source_entity_id, s.name AS source, e.predicate, e.target_entity_id, t.name AS target, e.fact_id
    FROM memory_edges e
    JOIN memory_entities s ON s.id = e.source_entity_id AND s.workspace_id = e.workspace_id
    JOIN memory_entities t ON t.id = e.target_entity_id AND t.workspace_id = e.workspace_id
    ORDER BY e.id
  `);
  return JSON.stringify({ facts, entities, edges });
}

function cloneExternalRepo(temp) {
  const target = path.join(temp, 'itoa');
  const clone = spawnSync('git', ['clone', '--depth', '1', 'https://github.com/dtolnay/itoa.git', target], {
    cwd: temp,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  if (clone.status === 0) return target;
  throw new Error(`failed to clone external eval repo: ${clone.stderr || clone.stdout}`);
}

function ingestRepo(root, workers, maxMemoryMb = 350, approve = true) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'oaf-rust-m7-ingest-'));
  const sqlite = path.join(temp, 'memory.sqlite');
  const timed = timedJson(RUST_BIN, ['ingest', '--root', root, '--sqlite', sqlite, '--format', 'json', '--workers', String(workers), '--max-memory', String(maxMemoryMb), '--max-file-mb', '2']);
  assert.equal(timed.value.summary.requestedWorkerCount, workers);
  assert.ok(timed.value.summary.effectiveWorkerCount >= 1, 'effectiveWorkerCount must be positive');
  assert.ok(timed.value.summary.effectiveWorkerCount <= workers, 'effectiveWorkerCount must not exceed requested workers');
  assert.equal(timed.value.safeguards.singleWriterCommit, true);
  assert.equal(timed.value.safeguards.unsafeBlocks, 0);
  if (approve) {
    rust(root, ['memory', 'approve', '--all'], sqlite);
  }
  return { temp, sqlite, timed };
}

function assertDeterministic(root) {
  const sequential = ingestRepo(root, 1);
  const parallel = ingestRepo(root, 4);
  try {
    assert.equal(graphSignature(root, parallel.sqlite), graphSignature(root, sequential.sqlite));
    return {
      fullCliSequentialMs: sequential.timed.ms,
      fullCliParallelMs: parallel.timed.ms,
      fullCliSpeedup: Number((sequential.timed.ms / parallel.timed.ms).toFixed(3)),
      extractionSequentialMs: sequential.timed.value.summary.elapsedMs,
      extractionParallelMs: parallel.timed.value.summary.elapsedMs,
      extractionSpeedup: Number((sequential.timed.value.summary.elapsedMs / parallel.timed.value.summary.elapsedMs).toFixed(3)),
      parsedFileCount: parallel.timed.value.summary.parsedFileCount,
      parallelPeakRssMb: parallel.timed.peakRssMb,
      fullCliPerFileMs: Number((parallel.timed.ms / parallel.timed.value.summary.parsedFileCount).toFixed(3)),
      extractionPerFileMs: Number((parallel.timed.value.summary.elapsedMs / parallel.timed.value.summary.parsedFileCount).toFixed(3))
    };
  } finally {
    rmSync(sequential.temp, { recursive: true, force: true });
    rmSync(parallel.temp, { recursive: true, force: true });
  }
}

function assertMemoryBound(root) {
  const capped = ingestRepo(root, 4, 160, false);
  try {
    assert.ok(capped.timed.peakRssMb <= 160, `peak RSS ${capped.timed.peakRssMb}MB exceeded 160MB cap`);
    assert.ok(capped.timed.value.summary.parsedBytes <= 160 * 1024 * 1024);
    return {
      capMb: 160,
      peakRssMb: capped.timed.peakRssMb,
      parsedBytes: capped.timed.value.summary.parsedBytes,
      effectiveWorkerCount: capped.timed.value.summary.effectiveWorkerCount
    };
  } finally {
    rmSync(capped.temp, { recursive: true, force: true });
  }
}

function graphAnswer(root, sqlite, query) {
  const report = rust(root, ['query', 'graph', '--cypher', query.cypher, '--max-rows', '100'], sqlite);
  const answer = JSON.stringify(report.rows);
  const hits = query.expected.filter((needle) => answer.includes(needle)).length;
  const grade = hits === query.expected.length ? 'PASS' : hits > 0 ? 'PARTIAL' : 'FAIL';
  const tokens = estimateTokens(answer) + estimateTokens(query.cypher);
  return { grade, tokens, toolCalls: 1, hits, answer };
}

function fileBaselineAnswer(root, query) {
  const files = query.baselineFiles.filter((file) => existsSync(path.join(root, file)));
  let combined = '';
  let toolCalls = 0;
  for (const file of files) {
    combined += readFileSync(path.join(root, file), 'utf8');
    toolCalls += 1;
  }
  const hits = query.expected.filter((needle) => combined.includes(query.fileNeedles?.[needle] ?? needle)).length;
  const grade = hits === query.expected.length ? 'PASS' : hits > 0 ? 'PARTIAL' : 'FAIL';
  return { grade, tokens: estimateTokens(combined), toolCalls, hits };
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text).length / 4));
}

function evaluateRepo(label, root, queries) {
  const ingest = ingestRepo(root, 4);
  try {
    const results = queries.map((query) => {
      const graph = graphAnswer(root, ingest.sqlite, query);
      const fileBaseline = fileBaselineAnswer(root, query);
      return {
        id: query.id,
        expected: query.expected,
        graph: { grade: graph.grade, tokens: graph.tokens, toolCalls: graph.toolCalls, hits: graph.hits },
        fileBaseline,
        tokenReduction: Number((1 - graph.tokens / Math.max(1, fileBaseline.tokens)).toFixed(3)),
        toolCallReduction: Number((1 - graph.toolCalls / Math.max(1, fileBaseline.toolCalls)).toFixed(3))
      };
    });
    return {
      label,
      rootKind: root === ROOT ? 'local-oaf-repo' : 'external-readonly-git-repo',
      ingestMs: ingest.timed.ms,
      parsedFileCount: ingest.timed.value.summary.parsedFileCount,
      questions: results
    };
  } finally {
    rmSync(ingest.temp, { recursive: true, force: true });
  }
}

assert.equal(existsSync(RUST_BIN), true, 'run cargo build --release before rust-eval');

const externalTemp = mkdtempSync(path.join(os.tmpdir(), 'oaf-rust-m7-external-'));
const externalRepo = cloneExternalRepo(externalTemp);
try {
  const oafBench = assertDeterministic(ROOT);
  const memory = assertMemoryBound(ROOT);
  const evals = [
    evaluateRepo('open-agent-fabric', ROOT, [
      {
        id: 'store-approval-claim-callers',
        cypher: "MATCH (n)-[:CALLS]->(m) WHERE m.name = 'function:claim_result_uncommitted' RETURN n.name AS caller, m.name AS callee ORDER BY caller LIMIT 20",
        expected: ['method:Store_approve_proposal_uncommitted', 'function:claim_result_uncommitted'],
        baselineFiles: ['rust/oaf-store/src/lib.rs'],
        fileNeedles: {
          'method:Store_approve_proposal_uncommitted': 'fn approve_proposal_uncommitted',
          'function:claim_result_uncommitted': 'fn claim_result_uncommitted'
        }
      },
      {
        id: 'cli-detect-changes-surface',
        cypher: "MATCH (n)-[:DEFINES]->(m) WHERE m.name = 'function:impact_detect_changes_command' RETURN n.name AS owner, m.name AS symbol LIMIT 20",
        expected: ['function:impact_detect_changes_command'],
        baselineFiles: ['rust/oaf/src/main.rs'],
        fileNeedles: { 'function:impact_detect_changes_command': 'fn impact_detect_changes_command' }
      }
    ]),
    evaluateRepo('dtolnay/itoa', externalRepo, [
      {
        id: 'buffer-methods',
        cypher: "MATCH (n)-[:DEFINES]->(m) WHERE m.name = 'method:Buffer_new' RETURN n.name AS owner, m.name AS method LIMIT 20",
        expected: ['method:Buffer_new'],
        baselineFiles: ['src/lib.rs'],
        fileNeedles: { 'method:Buffer_new': 'fn new' }
      },
      {
        id: 'format-helper-call',
        cypher: "MATCH (n)-[:CALLS]->(m) WHERE n.name = 'method:Buffer_format' RETURN n.name AS caller, m.name AS callee LIMIT 20",
        expected: ['method:Buffer_format'],
        baselineFiles: ['src/lib.rs'],
        fileNeedles: { 'method:Buffer_format': 'fn format' }
      }
    ])
  ];
  const failures = evals.flatMap((repo) => repo.questions.filter((question) => question.graph.grade === 'FAIL').map((question) => `${repo.label}:${question.id}`));
  const report = {
    schemaVersion: '1.0.0',
    command: 'rust eval',
    methodology: 'Graph queries over governed Rust ingest compared with targeted file-by-file reads of likely source files; no whole-repo dumping baseline.',
    parallelIngest: {
      ...oafBench,
      cbmDocumentedPerFileMs: CBM_PER_FILE_MS,
      remainingFullCliGapVsCbm: Number((oafBench.fullCliPerFileMs / CBM_PER_FILE_MS).toFixed(2)),
      remainingExtractionGapVsCbm: Number((oafBench.extractionPerFileMs / CBM_PER_FILE_MS).toFixed(2))
    },
    memoryBound: memory,
    evals,
    unhandledPatterns: [
      'Rust receiver-qualified method calls currently resolve to bare function targets when the method name is not globally unique.',
      'Dynamic dispatch, macro-expanded calls, and cross-file alias import resolution remain outside M7.'
    ],
    failures
  };
  assert.equal(failures.length, 0, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  rmSync(externalTemp, { recursive: true, force: true });
}
