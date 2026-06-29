import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const RUST_BIN = path.join(ROOT, 'rust/target/release/oaf');
const FIXED_NOW = '2026-06-29T00:00:00.000Z';
const SQLITE = '.local/memory.sqlite';
const NODE_BASELINE_MS = 1500;
const NODE_BASELINE_RSS_MB = 350;

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

function rustCli(root, args, sqlite = SQLITE) {
  return runJson(RUST_BIN, [...args, '--root', root, '--sqlite', sqlite, '--format', 'json']);
}

function mcpPayload(root, recallArgs, sqlite = SQLITE) {
  const cursorPath = path.join(os.tmpdir(), `oaf-rust-m3-cursors-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory.recall', arguments: recallArgs } }
  ].map((message) => JSON.stringify(message)).join('\n');
  const result = run(RUST_BIN, ['mcp', 'server', '--read-only', '--root', root, '--sqlite', sqlite, '--cursors', cursorPath, '--stdio'], { input });
  const lines = result.stdout.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(lines[0].result.protocolVersion, '2025-06-18');
  return JSON.parse(lines[1].result.content[0].text);
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
  const elapsedMs = performance.now() - started;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const rssBytes = Number(result.stderr.match(/(\d+)\s+maximum resident set size/u)?.[1] ?? 0);
  return {
    value: JSON.parse(result.stdout),
    ms: Number(elapsedMs.toFixed(3)),
    peakRssMb: Number((rssBytes / 1024 / 1024).toFixed(1))
  };
}

function makeFixtureRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaf-rust-m3-'));
  mkdirSync(path.join(root, '.local'), { recursive: true });
  mkdirSync(path.join(root, '.git/info'), { recursive: true });
  mkdirSync(path.join(root, 'src/jsx'), { recursive: true });
  mkdirSync(path.join(root, 'src/py'), { recursive: true });
  mkdirSync(path.join(root, 'src/rs'), { recursive: true });
  mkdirSync(path.join(root, 'src/go'), { recursive: true });
  writeFileSync(path.join(root, '.gitignore'), 'src/ignored.js\n');
  writeFileSync(path.join(root, '.git/info/exclude'), 'src/py/excluded.py\n');
  writeFixtureSources(root, 'py_helper');
  writeFileSync(path.join(root, 'src/ignored.js'), 'function IgnoredThing() { ignoredCall(); }\n');
  writeFileSync(path.join(root, 'src/py/excluded.py'), 'def excluded_entry():\n    excluded_call()\n');
  writeFileSync(path.join(root, 'src/large.js'), `${'x'.repeat(1200)}\nfunction TooLarge() { hiddenLargeCall(); }\n`);
  return root;
}

function writeFixtureSources(root, pythonHelperName) {
  writeFileSync(path.join(root, 'src/jsx/App.jsx'), [
    "import { jsxHelper } from './dep.js';",
    'export function JsxEntry() {',
    '  return jsxHelper();',
    '}',
    'function jsxHelper() {',
    '  return 1;',
    '}',
    'export const ArrowThing = () => jsxHelper();'
  ].join('\n'));
  writeFileSync(path.join(root, 'src/jsx/Widget.tsx'), [
    "import React from 'react';",
    'export class WidgetPanel {',
    '  renderWidget() {',
    '    return buildView();',
    '  }',
    '}',
    'function buildView() {',
    '  return 1;',
    '}'
  ].join('\n'));
  writeFileSync(path.join(root, 'src/py/graph.py'), [
    'import os',
    'def py_entry():',
    `    return ${pythonHelperName}()`,
    `def ${pythonHelperName}():`,
    '    return 1',
    'class PyWorker:',
    '    def run(self):',
    `        return ${pythonHelperName}()`
  ].join('\n'));
  writeFileSync(path.join(root, 'src/rs/lib.rs'), [
    'use crate::other;',
    'fn rust_entry() {',
    '    rust_helper();',
    '}',
    'fn rust_helper() {}',
    'struct Runner;',
    'impl Runner {',
    '    fn run(&self) {',
    '        rust_helper();',
    '    }',
    '}'
  ].join('\n'));
  writeFileSync(path.join(root, 'src/go/worker.go'), [
    'package fixture',
    'import "fmt"',
    'func GoEntry() {',
    '    goHelper()',
    '}',
    'func goHelper() {}',
    'type Worker struct{}',
    'func (w Worker) Run() {',
    '    goHelper()',
    '}'
  ].join('\n'));
}

function db(root, sqlite = SQLITE) {
  return new DatabaseSync(path.isAbsolute(sqlite) ? sqlite : path.join(root, sqlite));
}

function rows(root, sql, sqlite = SQLITE) {
  const database = db(root, sqlite);
  try {
    return database.prepare(sql).all();
  } finally {
    database.close();
  }
}

function scalar(root, sql, sqlite = SQLITE) {
  const database = db(root, sqlite);
  try {
    return Object.values(database.prepare(sql).get())[0];
  } finally {
    database.close();
  }
}

function activeCallEdges(root, sqlite = SQLITE) {
  return rows(root, `
    SELECT source.name AS source, target.name AS target
    FROM memory_edges edge
    JOIN memory_facts fact ON fact.id = edge.fact_id AND fact.workspace_id = edge.workspace_id
    JOIN memory_entities source ON source.id = edge.source_entity_id AND source.workspace_id = edge.workspace_id
    JOIN memory_entities target ON target.id = edge.target_entity_id AND target.workspace_id = edge.workspace_id
    WHERE fact.predicate = 'CALLS'
      AND fact.status = 'active'
      AND fact.superseded_by IS NULL
    ORDER BY source.name, target.name
  `, sqlite);
}

function assertFixtureQuality(root) {
  const expected = [
    { source: 'function:ArrowThing', target: 'function:jsxHelper' },
    { source: 'function:GoEntry', target: 'function:goHelper' },
    { source: 'function:JsxEntry', target: 'function:jsxHelper' },
    { source: 'function:py_entry', target: 'function:py_helper' },
    { source: 'function:rust_entry', target: 'function:rust_helper' },
    { source: 'method:PyWorker_run', target: 'function:py_helper' },
    { source: 'method:Runner_run', target: 'function:rust_helper' },
    { source: 'method:WidgetPanel_renderWidget', target: 'function:buildView' },
    { source: 'method:Worker_Run', target: 'function:goHelper' }
  ];
  const actual = activeCallEdges(root).map((edge) => ({ source: edge.source, target: edge.target }));
  assert.deepEqual(actual, expected);
  assert.equal(actual.filter((edge) => edge.target.startsWith('module:')).length, 0);
  return {
    expectedCallEdges: expected.length,
    actualCallEdges: actual.length,
    fixtureCallPrecision: Number((expected.length / actual.length).toFixed(3)),
    fixtureCallRecall: Number((actual.length / expected.length).toFixed(3))
  };
}

function makeLangFixtureRoot(language, filename, source) {
  const root = mkdtempSync(path.join(os.tmpdir(), `oaf-rust-m9-${language}-`));
  mkdirSync(path.join(root, '.local'), { recursive: true });
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src', filename), source);
  return root;
}

function activeFacts(root, sqlite = SQLITE) {
  return rows(root, `
    SELECT subject, predicate, object
    FROM memory_facts
    WHERE status = 'active'
      AND superseded_by IS NULL
    ORDER BY subject, predicate, object
  `, sqlite);
}

function assertContainsFacts(actual, expected, language) {
  const actualKeys = new Set(actual.map((fact) => `${fact.subject}\t${fact.predicate}\t${fact.object}`));
  const missing = expected.filter((fact) => !actualKeys.has(`${fact.subject}\t${fact.predicate}\t${fact.object}`));
  assert.deepEqual(missing, [], `${language} missing expected facts`);
}

function assertLanguageFixture({ language, filename, source, expectedFacts, expectedCalls }) {
  const root = makeLangFixtureRoot(language, filename, source);
  try {
    const ingest = rustCli(root, ['ingest', '--max-file-bytes', '2048']);
    assert.equal(ingest.summary.parsedFileCount, 1, `${language} parsed files`);
    assert.equal(ingest.quality.skippedFileCount, 0, `${language} skipped files`);
    rustCli(root, ['memory', 'approve', '--all']);
    const facts = activeFacts(root);
    assertContainsFacts(facts, expectedFacts, language);
    const actualCalls = activeCallEdges(root).map((edge) => ({ source: edge.source, target: edge.target }));
    assert.deepEqual(actualCalls, expectedCalls, `${language} call graph`);
    assert.equal(actualCalls.filter((edge) => edge.target.startsWith('module:')).length, 0, `${language} CALLS must not target modules`);
    const second = rustCli(root, ['ingest', '--max-file-bytes', '2048']);
    assert.equal(second.summary.recordedCount, 0, `${language} idempotent re-ingest`);
    return {
      language,
      expectedCallEdges: expectedCalls.length,
      actualCallEdges: actualCalls.length,
      callPrecision: Number((expectedCalls.length / actualCalls.length).toFixed(3)),
      callRecall: Number((actualCalls.length / expectedCalls.length).toFixed(3)),
      parsedFileCount: ingest.summary.parsedFileCount,
      generatedFactCount: ingest.summary.recordedCount
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function languageFixtures() {
  return [
    assertLanguageFixture({
      language: 'java',
      filename: 'Worker.java',
      source: [
        'package demo;',
        'import java.util.List;',
        'class Worker {',
        '  @Deprecated',
        '  void run() {',
        '    helper();',
        '  }',
        '  void helper() {}',
        '}',
        'class Utility {',
        '  static void boot() {',
        '    setup();',
        '  }',
        '  static void setup() {}',
        '}'
      ].join('\n'),
      expectedFacts: [
        { subject: 'class:Worker', predicate: 'IS_A', object: 'Class' },
        { subject: 'method:Worker_run', predicate: 'IS_A', object: 'Method' },
        { subject: 'method:Worker_helper', predicate: 'IS_A', object: 'Method' },
        { subject: 'class:Utility', predicate: 'IS_A', object: 'Class' },
        { subject: 'method:Utility_boot', predicate: 'IS_A', object: 'Method' },
        { subject: 'method:Utility_setup', predicate: 'IS_A', object: 'Method' },
        { subject: 'module:src_Worker', predicate: 'IMPORTS', object: 'module:java' }
      ],
      expectedCalls: [
        { source: 'method:Utility_boot', target: 'method:Utility_setup' },
        { source: 'method:Worker_run', target: 'method:Worker_helper' }
      ]
    })
  ];
}

function assertCamelRecall(root, query, expectedSubject, sqlite = SQLITE) {
  const payload = mcpPayload(root, { client: 'm3-quality', query, scope: 'workspace', limit: 20, currentTruthOnly: true }, sqlite);
  const facts = payload.data.facts ?? [];
  assert.ok(facts.some((fact) => fact.subject === expectedSubject || fact.value === expectedSubject), JSON.stringify(facts, null, 2));
  return facts.length;
}

function fixtureScenario() {
  const root = makeFixtureRoot();
  const ingest = rustCli(root, ['ingest', '--max-file-bytes', '1024']);
  assert.equal(ingest.summary.scannedFileCount, 6);
  assert.equal(ingest.summary.parsedFileCount, 5);
  assert.equal(ingest.summary.skippedFileCount, 1);
  assert.equal(ingest.summary.activeMemoryCreated, 0);
  assert.ok(ingest.quality.skippedFiles.some((file) => file.workspace_ref === 'workspace://src/large.js' && file.reason.includes('not truncated')));
  assert.equal(scalar(root, "SELECT count(*) AS count FROM memory_facts WHERE status = 'active'"), 0);
  assert.equal(scalar(root, "SELECT count(*) AS count FROM memory_proposal_queue WHERE status = 'pending'"), ingest.summary.recordedCount);

  const approve = rustCli(root, ['memory', 'approve', '--all']);
  assert.equal(approve.summary.activeMemoryCreated, ingest.summary.recordedCount);
  const quality = assertFixtureQuality(root);
  assert.equal(scalar(root, "SELECT count(*) AS count FROM memory_entities WHERE name LIKE '%Ignored%' OR name LIKE '%excluded%'"), 0);
  const recallCount = assertCamelRecall(root, 'Widget Panel render', 'method:WidgetPanel_renderWidget');

  const activeBefore = scalar(root, "SELECT count(*) AS count FROM memory_facts WHERE status = 'active' AND superseded_by IS NULL");
  const second = rustCli(root, ['ingest', '--max-file-bytes', '1024']);
  assert.equal(second.summary.recordedCount, 0);
  assert.equal(scalar(root, "SELECT count(*) AS count FROM memory_proposal_queue WHERE status = 'pending'"), 0);
  assert.equal(scalar(root, "SELECT count(*) AS count FROM memory_facts WHERE status = 'active' AND superseded_by IS NULL"), activeBefore);

  writeFixtureSources(root, 'py_helper_v2');
  const changed = rustCli(root, ['ingest', '--max-file-bytes', '1024']);
  assert.ok(changed.summary.recordedCount > 0);
  const changedApprove = rustCli(root, ['memory', 'approve', '--all']);
  assert.ok(changedApprove.summary.supersededFactCount > 0);
  assert.equal(scalar(root, "SELECT count(*) AS count FROM memory_facts WHERE status = 'active' AND superseded_by IS NULL AND subject = 'function:py_entry' AND predicate = 'CALLS' AND object = 'function:py_helper'"), 0);
  assert.equal(scalar(root, "SELECT count(*) AS count FROM memory_facts WHERE status = 'active' AND superseded_by IS NULL AND subject = 'function:py_entry' AND predicate = 'CALLS' AND object = 'function:py_helper_v2'"), 1);

  return {
    root,
    ingest,
    ...quality,
    fixtureCamelRecallCount: recallCount,
    fixtureIdempotentRecordedCount: second.summary.recordedCount,
    fixtureRetiredProposalCount: changed.summary.retiredProposalCount,
    fixtureSupersededFactCount: changedApprove.summary.supersededFactCount
  };
}

function crashScenario() {
  const root = makeFixtureRoot();
  const result = spawnSync(RUST_BIN, ['ingest', '--root', root, '--sqlite', SQLITE, '--format', 'json', '--max-file-bytes', '1024'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, OAF_FIXED_NOW: FIXED_NOW, OAF_STORE_ABORT_AFTER_UNCOMMITTED_WRITE: '1' }
  });
  assert.notEqual(result.status, 0);
  assert.ok(existsSync(path.join(root, SQLITE)));
  assert.equal(scalar(root, 'PRAGMA integrity_check'), 'ok');
  assert.equal(scalar(root, "SELECT count(*) AS count FROM memory_proposal_queue WHERE status = 'pending'"), 0);
  rmSync(root, { recursive: true, force: true });
}

function oafRepoScenario() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'oaf-rust-m3-oaf-'));
  const sqlite = path.join(temp, 'oaf-repo.sqlite');
  const timed = timedJson(RUST_BIN, ['ingest', '--root', ROOT, '--sqlite', sqlite, '--format', 'json', '--max-memory', '350', '--max-file-mb', '2']);
  assert.ok(timed.value.summary.parsedFileCount > 0);
  assert.ok(timed.value.summary.generatedFactCount > 0);
  rustCli(ROOT, ['memory', 'approve', '--all'], sqlite);
  const duplicateNames = rows(ROOT, `
    SELECT name, count(*) AS count
    FROM memory_entities
    GROUP BY workspace_id, scope, name
    HAVING count(*) > 1
  `, sqlite);
  assert.deepEqual(duplicateNames, []);
  assert.equal(activeCallEdges(ROOT, sqlite).filter((edge) => edge.target.startsWith('module:')).length, 0);
  const activeBefore = scalar(ROOT, "SELECT count(*) AS count FROM memory_facts WHERE status = 'active' AND superseded_by IS NULL", sqlite);
  const second = rustCli(ROOT, ['ingest', '--max-memory', '350', '--max-file-mb', '2'], sqlite);
  assert.equal(second.summary.recordedCount, 0);
  assert.equal(scalar(ROOT, "SELECT count(*) AS count FROM memory_facts WHERE status = 'active' AND superseded_by IS NULL", sqlite), activeBefore);
  const recallCount = assertCamelRecall(ROOT, 'Active Fact Snapshot', 'class:ActiveFactSnapshot', sqlite);
  const oafCallEdgeCount = activeCallEdges(ROOT, sqlite).length;
  rmSync(temp, { recursive: true, force: true });
  return {
    oafParsedFileCount: timed.value.summary.parsedFileCount,
    oafGeneratedFactCount: timed.value.summary.generatedFactCount,
    oafSkippedFileCount: timed.value.summary.skippedFileCount,
    oafActiveFactCount: activeBefore,
    oafCallEdgeCount,
    oafCamelRecallCount: recallCount,
    oafIdempotentRecordedCount: second.summary.recordedCount,
    rustOafIndexMs: timed.ms,
    rustOafPeakRssMb: timed.peakRssMb
  };
}

const fixture = fixtureScenario();
const languageQuality = languageFixtures();
crashScenario();
const oafRepo = oafRepoScenario();
rmSync(fixture.root, { recursive: true, force: true });

console.log([
  'ingest quality:',
  `  fixtureCallPrecision ${fixture.fixtureCallPrecision}`,
  `  fixtureCallRecall ${fixture.fixtureCallRecall}`,
  `  fixtureExpectedCallEdges ${fixture.expectedCallEdges}`,
  `  fixtureActualCallEdges ${fixture.actualCallEdges}`,
  `  fixtureCamelRecallCount ${fixture.fixtureCamelRecallCount}`,
  `  fixtureIdempotentRecordedCount ${fixture.fixtureIdempotentRecordedCount}`,
  `  fixtureRetiredProposalCount ${fixture.fixtureRetiredProposalCount}`,
  `  fixtureSupersededFactCount ${fixture.fixtureSupersededFactCount}`,
  ...languageQuality.flatMap((item) => [
    `  ${item.language}CallPrecision ${item.callPrecision}`,
    `  ${item.language}CallRecall ${item.callRecall}`,
    `  ${item.language}ExpectedCallEdges ${item.expectedCallEdges}`,
    `  ${item.language}ActualCallEdges ${item.actualCallEdges}`,
    `  ${item.language}ParsedFileCount ${item.parsedFileCount}`,
    `  ${item.language}GeneratedFactCount ${item.generatedFactCount}`
  ]),
  `  oafParsedFileCount ${oafRepo.oafParsedFileCount}`,
  `  oafGeneratedFactCount ${oafRepo.oafGeneratedFactCount}`,
  `  oafSkippedFileCount ${oafRepo.oafSkippedFileCount}`,
  `  oafActiveFactCount ${oafRepo.oafActiveFactCount}`,
  `  oafCallEdgeCount ${oafRepo.oafCallEdgeCount}`,
  `  oafCamelRecallCount ${oafRepo.oafCamelRecallCount}`,
  `  oafIdempotentRecordedCount ${oafRepo.oafIdempotentRecordedCount}`,
  `  rustOafIndexMs ${oafRepo.rustOafIndexMs}`,
  `  rustOafPeakRssMb ${oafRepo.rustOafPeakRssMb}`,
  `  documentedNodeBaselineMs ${NODE_BASELINE_MS}`,
  `  documentedNodeBaselinePeakRssMb ${NODE_BASELINE_RSS_MB}`,
  '  unhandledPatterns alias resolution across files, dynamic dispatch, generated route semantics, type-only call disambiguation'
].join('\n'));
