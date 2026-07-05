import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

function rows(sqlite, sql) {
  const database = new DatabaseSync(sqlite);
  try {
    return database.prepare(sql).all();
  } finally {
    database.close();
  }
}

function activeCallEdges(sqlite) {
  return rows(sqlite, `
    SELECT source.name AS source,
           target.name AS target,
           json_extract(fact.metadata_json, '$.notes') AS notes
    FROM memory_edges edge
    JOIN memory_facts fact ON fact.id = edge.fact_id AND fact.workspace_id = edge.workspace_id
    JOIN memory_entities source ON source.id = edge.source_entity_id AND source.workspace_id = edge.workspace_id
    JOIN memory_entities target ON target.id = edge.target_entity_id AND target.workspace_id = edge.workspace_id
    WHERE fact.predicate = 'CALLS'
      AND fact.status = 'active'
      AND fact.superseded_by IS NULL
    ORDER BY source.name, target.name
  `);
}

function edgeKey(edge) {
  return `${edge.source}\t${edge.target}`;
}

function makeTypedFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaf-rust-ci2-typed-'));
  mkdirSync(path.join(root, '.local'), { recursive: true });
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src/typed.py'), [
    'class Counter:',
    '    def inc(self):',
    '        return 1',
    '    def bounce(self):',
    '        return self.inc()',
    '',
    'class Gauge:',
    '    def inc(self):',
    '        return 2',
    '',
    'class Runner:',
    '    def run(self):',
    '        self.local = Counter()',
    '        return self.local.inc()',
    '',
    'def run():',
    '    counter = Counter()',
    '    gauge = Gauge()',
    '    counter.inc()',
    '    gauge.inc()'
  ].join('\n'));
  return root;
}

function typedFixtureScenario() {
  const root = makeTypedFixture();
  const sqlite = path.join(root, '.local', 'memory.sqlite');
  try {
    const ingest = oaf(root, sqlite, ['ingest', '--max-file-bytes', '4096']);
    assert.equal(ingest.summary.parsedFileCount, 1);
    assert.equal(ingest.summary.activeMemoryCreated, 0);
    oaf(root, sqlite, ['memory', 'approve', '--all']);

    const edges = activeCallEdges(sqlite);
    const typedEdges = edges.filter((edge) => edge.notes === 'oaf.ingest:typed-call-python');
    const expected = [
      { source: 'function:run', target: 'method:Counter_inc' },
      { source: 'function:run', target: 'method:Gauge_inc' },
      { source: 'method:Counter_bounce', target: 'method:Counter_inc' },
      { source: 'method:Runner_run', target: 'method:Counter_inc' }
    ];
    const expectedKeys = new Set(expected.map(edgeKey));
    const predictedKeys = new Set(typedEdges.map(edgeKey));
    const truePositiveCount = typedEdges.filter((edge) => expectedKeys.has(edgeKey(edge))).length;
    const falsePositiveEdges = typedEdges.filter((edge) => !expectedKeys.has(edgeKey(edge)));
    const missedEdges = expected.filter((edge) => !predictedKeys.has(edgeKey(edge)));
    assert.deepEqual(falsePositiveEdges, []);
    assert.deepEqual(missedEdges, []);
    assert.equal(edges.some((edge) => edge.source === 'function:run' && edge.target === 'function:inc'), false);

    return {
      parsedFileCount: ingest.summary.parsedFileCount,
      generatedFactCount: ingest.summary.recordedCount,
      totalCallEdges: edges.length,
      expectedTypedCallEdges: expected.length,
      predictedTypedCallEdges: typedEdges.length,
      typedCallPrecision: Number((truePositiveCount / typedEdges.length).toFixed(3)),
      typedCallRecall: Number((truePositiveCount / expected.length).toFixed(3)),
      typedEdges
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function makeMultiLanguageTypedFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaf-rust-ci2-multilang-'));
  mkdirSync(path.join(root, '.local'), { recursive: true });
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src/Worker.java'), [
    'class Worker {',
    '  void run() { helper(); }',
    '  void helper() {}',
    '}',
    'class Runner {',
    '  void run() {',
    '    Worker worker = new Worker();',
    '    worker.run();',
    '  }',
    '}'
  ].join('\n'));
  writeFileSync(path.join(root, 'src/Worker.cs'), [
    'class WorkerCs {',
    '  void Run() { Helper(); }',
    '  void Helper() {}',
    '}',
    'class RunnerCs {',
    '  void Run() {',
    '    var worker = new WorkerCs();',
    '    worker.Run();',
    '  }',
    '}'
  ].join('\n'));
  writeFileSync(path.join(root, 'src/Worker.swift'), [
    'class WorkerSwift {',
    '  func run() { helper() }',
    '  func helper() {}',
    '}',
    'func bootSwift() {',
    '  let worker = WorkerSwift()',
    '  worker.run()',
    '}'
  ].join('\n'));
  writeFileSync(path.join(root, 'src/Worker.kt'), [
    'class WorkerKotlin {',
    '  fun run() { helper() }',
    '  fun helper() {}',
    '}',
    'fun bootKotlin() {',
    '  val worker = WorkerKotlin()',
    '  worker.run()',
    '}'
  ].join('\n'));
  return root;
}

function multiLanguageTypedScenario() {
  const root = makeMultiLanguageTypedFixture();
  const sqlite = path.join(root, '.local', 'memory.sqlite');
  try {
    const ingest = oaf(root, sqlite, ['ingest', '--max-file-bytes', '4096']);
    assert.equal(ingest.summary.parsedFileCount, 4);
    oaf(root, sqlite, ['memory', 'approve', '--all']);
    const edges = activeCallEdges(sqlite);
    const typedEdges = edges.filter((edge) => edge.notes?.startsWith('oaf.ingest:typed-call-'));
    const expected = [
      { source: 'function:bootKotlin', target: 'method:WorkerKotlin_run', notes: 'oaf.ingest:typed-call-kotlin' },
      { source: 'function:bootSwift', target: 'method:WorkerSwift_run', notes: 'oaf.ingest:typed-call-swift' },
      { source: 'method:Runner_run', target: 'method:Worker_run', notes: 'oaf.ingest:typed-call-java' },
      { source: 'method:RunnerCs_Run', target: 'method:WorkerCs_Run', notes: 'oaf.ingest:typed-call-csharp' },
      { source: 'method:Worker_run', target: 'method:Worker_helper', notes: 'oaf.ingest:typed-call-java' },
      { source: 'method:WorkerCs_Run', target: 'method:WorkerCs_Helper', notes: 'oaf.ingest:typed-call-csharp' },
      { source: 'method:WorkerSwift_run', target: 'method:WorkerSwift_helper', notes: 'oaf.ingest:typed-call-swift' },
      { source: 'method:WorkerKotlin_run', target: 'method:WorkerKotlin_helper', notes: 'oaf.ingest:typed-call-kotlin' }
    ];
    const expectedKeys = new Set(expected.map((edge) => `${edgeKey(edge)}\t${edge.notes}`));
    const predictedKeys = new Set(typedEdges.map((edge) => `${edgeKey(edge)}\t${edge.notes}`));
    const falsePositiveEdges = typedEdges.filter((edge) => !expectedKeys.has(`${edgeKey(edge)}\t${edge.notes}`));
    const missedEdges = expected.filter((edge) => !predictedKeys.has(`${edgeKey(edge)}\t${edge.notes}`));
    assert.deepEqual(falsePositiveEdges, []);
    assert.deepEqual(missedEdges, []);
    assert.equal(edges.filter((edge) => edge.target.startsWith('module:')).length, 0);
    return {
      parsedFileCount: ingest.summary.parsedFileCount,
      generatedFactCount: ingest.summary.recordedCount,
      expectedTypedCallEdges: expected.length,
      predictedTypedCallEdges: typedEdges.length,
      typedCallPrecision: 1,
      typedCallRecall: 1,
      typedEdges
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function realPythonRepoScenario() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'oaf-rust-ci2-real-'));
  const repo = path.join(temp, 'requests');
  const sqlite = path.join(temp, 'requests.sqlite');
  try {
    run('git', ['clone', '--depth', '1', 'https://github.com/psf/requests.git', repo]);
    const ingest = oaf(repo, sqlite, ['ingest', '--workers', '1', '--max-file-mb', '2']);
    assert.ok(ingest.summary.parsedFileCount >= 10, 'real Python repo parsed too few files');
    oaf(repo, sqlite, ['memory', 'approve', '--all']);
    const edges = activeCallEdges(sqlite);
    const typedEdges = edges.filter((edge) => edge.notes === 'oaf.ingest:typed-call-python');
    assert.equal(edges.filter((edge) => edge.target.startsWith('module:')).length, 0);
    const second = oaf(repo, sqlite, ['ingest', '--workers', '1', '--max-file-mb', '2']);
    assert.equal(second.summary.recordedCount, 0);
    return {
      label: 'psf/requests',
      parsedFileCount: ingest.summary.parsedFileCount,
      generatedFactCount: ingest.summary.recordedCount,
      totalCallEdges: edges.length,
      typedCallEdges: typedEdges.length,
      moduleTargetCallCount: edges.filter((edge) => edge.target.startsWith('module:')).length,
      idempotentRecordedCount: second.summary.recordedCount,
      sampleTypedEdges: typedEdges.slice(0, 10)
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const fixture = typedFixtureScenario();
assert.equal(fixture.typedCallPrecision, 1);
assert.equal(fixture.typedCallRecall, 1);
const multiLanguageFixture = multiLanguageTypedScenario();
const realPythonRepo = realPythonRepoScenario();

console.log(JSON.stringify({
  schemaVersion: '1.0.0',
  command: 'rust typed calls quality',
  methodology: 'CI-2 measures Python plus Java/C#/Swift/Kotlin receiver-call resolution after proposal approval. Type hints are used only when constructor/self inference resolves to an existing symbol; otherwise the prior name resolver is used.',
  fixture,
  multiLanguageFixture,
  realPythonRepo,
  status: 'PASS'
}, null, 2));
