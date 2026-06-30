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
  const timeArgs = process.platform === 'darwin' ? ['-l', command, ...args] : ['-v', command, ...args];
  const result = spawnSync('/usr/bin/time', timeArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, OAF_FIXED_NOW: FIXED_NOW },
    ...options
  });
  const elapsedMs = performance.now() - started;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const darwinRss = result.stderr.match(/(\d+)\s+maximum resident set size/u);
  const linuxRss = result.stderr.match(/Maximum resident set size \(kbytes\):\s*(\d+)/u);
  const rssBytes = darwinRss ? Number(darwinRss[1]) : Number(linuxRss?.[1] ?? 0) * 1024;
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
    }),
    assertLanguageFixture({
      language: 'c',
      filename: 'worker.c',
      source: [
        '#include "dep.h"',
        'int c_helper(void) {',
        '  return 1;',
        '}',
        'int c_entry(void) {',
        '  return c_helper();',
        '}'
      ].join('\n'),
      expectedFacts: [
        { subject: 'function:c_entry', predicate: 'IS_A', object: 'Function' },
        { subject: 'function:c_helper', predicate: 'IS_A', object: 'Function' },
        { subject: 'module:src_worker', predicate: 'IMPORTS', object: 'module:dep' }
      ],
      expectedCalls: [
        { source: 'function:c_entry', target: 'function:c_helper' }
      ]
    }),
    assertLanguageFixture({
      language: 'cpp',
      filename: 'widget.cpp',
      source: [
        '#include "widget.hpp"',
        'class Widget {',
        'public:',
        '  int render() { return paint(); }',
        '  int paint() { return 1; }',
        '};',
        'int boot() {',
        '  return helper();',
        '}',
        'int helper() { return 1; }'
      ].join('\n'),
      expectedFacts: [
        { subject: 'class:Widget', predicate: 'IS_A', object: 'Class' },
        { subject: 'method:Widget_render', predicate: 'IS_A', object: 'Method' },
        { subject: 'method:Widget_paint', predicate: 'IS_A', object: 'Method' },
        { subject: 'function:boot', predicate: 'IS_A', object: 'Function' },
        { subject: 'function:helper', predicate: 'IS_A', object: 'Function' },
        { subject: 'module:src_widget', predicate: 'IMPORTS', object: 'module:widget' }
      ],
      expectedCalls: [
        { source: 'function:boot', target: 'function:helper' },
        { source: 'method:Widget_render', target: 'method:Widget_paint' }
      ]
    }),
    assertLanguageFixture({
      language: 'ruby',
      filename: 'worker.rb',
      source: [
        "require 'json'",
        'class Worker',
        '  def run',
        '    helper()',
        '  end',
        '  def helper',
        '    1',
        '  end',
        'end',
        'def boot',
        '  top_helper()',
        'end',
        'def top_helper',
        '  1',
        'end'
      ].join('\n'),
      expectedFacts: [
        { subject: 'class:Worker', predicate: 'IS_A', object: 'Class' },
        { subject: 'method:Worker_run', predicate: 'IS_A', object: 'Method' },
        { subject: 'method:Worker_helper', predicate: 'IS_A', object: 'Method' },
        { subject: 'function:boot', predicate: 'IS_A', object: 'Function' },
        { subject: 'function:top_helper', predicate: 'IS_A', object: 'Function' }
      ],
      expectedCalls: [
        { source: 'function:boot', target: 'function:top_helper' },
        { source: 'method:Worker_run', target: 'method:Worker_helper' }
      ]
    }),
    assertLanguageFixture({
      language: 'php',
      filename: 'Worker.php',
      source: [
        '<?php',
        "include 'dep.php';",
        'class Worker {',
        '  function run() {',
        '    return $this->helper();',
        '  }',
        '  function helper() {',
        '    return 1;',
        '  }',
        '}',
        'function boot() {',
        '  return helper_global();',
        '}',
        'function helper_global() { return 1; }'
      ].join('\n'),
      expectedFacts: [
        { subject: 'class:Worker', predicate: 'IS_A', object: 'Class' },
        { subject: 'method:Worker_run', predicate: 'IS_A', object: 'Method' },
        { subject: 'method:Worker_helper', predicate: 'IS_A', object: 'Method' },
        { subject: 'function:boot', predicate: 'IS_A', object: 'Function' },
        { subject: 'function:helper_global', predicate: 'IS_A', object: 'Function' },
        { subject: 'module:src_Worker', predicate: 'IMPORTS', object: 'module:dep' }
      ],
      expectedCalls: [
        { source: 'function:boot', target: 'function:helper_global' },
        { source: 'method:Worker_run', target: 'method:Worker_helper' }
      ]
    }),
    assertLanguageFixture({
      language: 'csharp',
      filename: 'Worker.cs',
      source: [
        'using System;',
        'class Worker {',
        '  void Run() {',
        '    Helper();',
        '  }',
        '  void Helper() {}',
        '}',
        'class Utility {',
        '  void Boot() {',
        '    Setup();',
        '  }',
        '  void Setup() {}',
        '}'
      ].join('\n'),
      expectedFacts: [
        { subject: 'class:Worker', predicate: 'IS_A', object: 'Class' },
        { subject: 'method:Worker_Run', predicate: 'IS_A', object: 'Method' },
        { subject: 'method:Worker_Helper', predicate: 'IS_A', object: 'Method' },
        { subject: 'class:Utility', predicate: 'IS_A', object: 'Class' },
        { subject: 'method:Utility_Boot', predicate: 'IS_A', object: 'Method' },
        { subject: 'method:Utility_Setup', predicate: 'IS_A', object: 'Method' }
      ],
      expectedCalls: [
        { source: 'method:Utility_Boot', target: 'method:Utility_Setup' },
        { source: 'method:Worker_Run', target: 'method:Worker_Helper' }
      ]
    }),
    assertLanguageFixture({
      language: 'swift',
      filename: 'Worker.swift',
      source: [
        'import Foundation',
        'class Worker {',
        '  func run() {',
        '    helper()',
        '  }',
        '  func helper() {}',
        '}',
        'func boot() {',
        '  topHelper()',
        '}',
        'func topHelper() {}'
      ].join('\n'),
      expectedFacts: [
        { subject: 'class:Worker', predicate: 'IS_A', object: 'Class' },
        { subject: 'method:Worker_run', predicate: 'IS_A', object: 'Method' },
        { subject: 'method:Worker_helper', predicate: 'IS_A', object: 'Method' },
        { subject: 'function:boot', predicate: 'IS_A', object: 'Function' },
        { subject: 'function:topHelper', predicate: 'IS_A', object: 'Function' },
        { subject: 'module:src_Worker', predicate: 'IMPORTS', object: 'module:Foundation' }
      ],
      expectedCalls: [
        { source: 'function:boot', target: 'function:topHelper' },
        { source: 'method:Worker_run', target: 'method:Worker_helper' }
      ]
    }),
    assertLanguageFixture({
      language: 'kotlin',
      filename: 'Worker.kt',
      source: [
        'import kotlin.collections.List',
        'class Worker {',
        '  fun run() {',
        '    helper()',
        '  }',
        '  fun helper() {}',
        '}',
        'fun boot() {',
        '  setup()',
        '}',
        'fun setup() {}'
      ].join('\n'),
      expectedFacts: [
        { subject: 'class:Worker', predicate: 'IS_A', object: 'Class' },
        { subject: 'method:Worker_run', predicate: 'IS_A', object: 'Method' },
        { subject: 'method:Worker_helper', predicate: 'IS_A', object: 'Method' },
        { subject: 'function:boot', predicate: 'IS_A', object: 'Function' },
        { subject: 'function:setup', predicate: 'IS_A', object: 'Function' },
        { subject: 'module:src_Worker', predicate: 'IMPORTS', object: 'module:kotlin' }
      ],
      expectedCalls: [
        { source: 'function:boot', target: 'function:setup' },
        { source: 'method:Worker_run', target: 'method:Worker_helper' }
      ]
    }),
    assertLanguageFixture({
      language: 'lua',
      filename: 'worker.lua',
      source: [
        'function helper()',
        '  return 1',
        'end',
        'function run()',
        '  return helper()',
        'end'
      ].join('\n'),
      expectedFacts: [
        { subject: 'function:helper', predicate: 'IS_A', object: 'Function' },
        { subject: 'function:run', predicate: 'IS_A', object: 'Function' }
      ],
      expectedCalls: [
        { source: 'function:run', target: 'function:helper' }
      ]
    }),
    assertLanguageFixture({
      language: 'bash',
      filename: 'worker.sh',
      source: [
        'helper() {',
        '  return 0',
        '}',
        'run() {',
        '  helper',
        '}'
      ].join('\n'),
      expectedFacts: [
        { subject: 'function:helper', predicate: 'IS_A', object: 'Function' },
        { subject: 'function:run', predicate: 'IS_A', object: 'Function' }
      ],
      expectedCalls: [
        { source: 'function:run', target: 'function:helper' }
      ]
    }),
    assertLanguageFixture({
      language: 'sql',
      filename: 'schema.sql',
      source: [
        'CREATE FUNCTION helper() RETURNS integer',
        'LANGUAGE SQL',
        'AS $$ SELECT 1 $$;',
        'CREATE FUNCTION run() RETURNS integer',
        'LANGUAGE SQL',
        'AS $$ SELECT helper() $$;'
      ].join('\n'),
      expectedFacts: [
        { subject: 'function:helper', predicate: 'IS_A', object: 'Function' },
        { subject: 'function:run', predicate: 'IS_A', object: 'Function' }
      ],
      expectedCalls: [
        { source: 'function:run', target: 'function:helper' }
      ]
    }),
    assertLanguageFixture({
      language: 'objectiveC',
      filename: 'Worker.m',
      source: [
        '@interface Worker',
        '- (void)run;',
        '- (void)helper;',
        '@end',
        '@implementation Worker',
        '- (void)run {',
        '  [self helper];',
        '}',
        '- (void)helper {}',
        '@end',
        'int boot(void) {',
        '  return helper_c();',
        '}',
        'int helper_c(void) { return 1; }'
      ].join('\n'),
      expectedFacts: [
        { subject: 'class:Worker', predicate: 'IS_A', object: 'Class' },
        { subject: 'method:Worker_run', predicate: 'IS_A', object: 'Method' },
        { subject: 'method:Worker_helper', predicate: 'IS_A', object: 'Method' },
        { subject: 'function:boot', predicate: 'IS_A', object: 'Function' },
        { subject: 'function:helper_c', predicate: 'IS_A', object: 'Function' }
      ],
      expectedCalls: [
        { source: 'function:boot', target: 'function:helper_c' },
        { source: 'method:Worker_run', target: 'method:Worker_helper' }
      ]
    }),
    assertLanguageFixture({
      language: 'scala',
      filename: 'Worker.scala',
      source: [
        'import scala.collection.mutable.ListBuffer',
        'class Worker {',
        '  def run(): Int = helper()',
        '  def helper(): Int = 1',
        '}',
        'def boot(): Int = setup()',
        'def setup(): Int = 1'
      ].join('\n'),
      expectedFacts: [
        { subject: 'class:Worker', predicate: 'IS_A', object: 'Class' },
        { subject: 'method:Worker_run', predicate: 'IS_A', object: 'Method' },
        { subject: 'method:Worker_helper', predicate: 'IS_A', object: 'Method' },
        { subject: 'function:boot', predicate: 'IS_A', object: 'Function' },
        { subject: 'function:setup', predicate: 'IS_A', object: 'Function' },
        { subject: 'module:src_Worker', predicate: 'IMPORTS', object: 'module:scala' }
      ],
      expectedCalls: [
        { source: 'function:boot', target: 'function:setup' },
        { source: 'method:Worker_run', target: 'method:Worker_helper' }
      ]
    }),
    assertLanguageFixture({
      language: 'dart',
      filename: 'worker.dart',
      source: [
        "import 'dart:math';",
        'class Worker {',
        '  int run() {',
        '    return helper();',
        '  }',
        '  int helper() {',
        '    return 1;',
        '  }',
        '}',
        'int boot() {',
        '  return setup();',
        '}',
        'int setup() { return 1; }'
      ].join('\n'),
      expectedFacts: [
        { subject: 'class:Worker', predicate: 'IS_A', object: 'Class' },
        { subject: 'method:Worker_run', predicate: 'IS_A', object: 'Method' },
        { subject: 'method:Worker_helper', predicate: 'IS_A', object: 'Method' },
        { subject: 'function:boot', predicate: 'IS_A', object: 'Function' },
        { subject: 'function:setup', predicate: 'IS_A', object: 'Function' },
        { subject: 'module:src_worker', predicate: 'IMPORTS', object: 'module:dart' }
      ],
      expectedCalls: [
        { source: 'function:boot', target: 'function:setup' },
        { source: 'method:Worker_run', target: 'method:Worker_helper' }
      ]
    }),
    assertLanguageFixture({
      language: 'r',
      filename: 'worker.R',
      source: [
        'helper <- function() {',
        '  1',
        '}',
        'run <- function() {',
        '  helper()',
        '}'
      ].join('\n'),
      expectedFacts: [
        { subject: 'function:helper', predicate: 'IS_A', object: 'Function' },
        { subject: 'function:run', predicate: 'IS_A', object: 'Function' }
      ],
      expectedCalls: [
        { source: 'function:run', target: 'function:helper' }
      ]
    }),
    assertLanguageFixture({
      language: 'julia',
      filename: 'worker.jl',
      source: [
        'import Base: show',
        'struct Worker',
        '  value::Int',
        'end',
        'function helper()',
        '  1',
        'end',
        'function run()',
        '  helper()',
        'end'
      ].join('\n'),
      expectedFacts: [
        { subject: 'class:Worker', predicate: 'IS_A', object: 'Class' },
        { subject: 'function:helper', predicate: 'IS_A', object: 'Function' },
        { subject: 'function:run', predicate: 'IS_A', object: 'Function' },
        { subject: 'module:src_worker', predicate: 'IMPORTS', object: 'module:Base' }
      ],
      expectedCalls: [
        { source: 'function:run', target: 'function:helper' }
      ]
    }),
    assertLanguageFixture({
      language: 'zig',
      filename: 'worker.zig',
      source: [
        'const Worker = struct {',
        '  fn run(self: *Worker) void {',
        '    self.helper();',
        '  }',
        '  fn helper(self: *Worker) void {',
        '    _ = self;',
        '  }',
        '};',
        'fn boot() void {',
        '  helperGlobal();',
        '}',
        'fn helperGlobal() void {}'
      ].join('\n'),
      expectedFacts: [
        { subject: 'class:Worker', predicate: 'IS_A', object: 'Class' },
        { subject: 'method:Worker_run', predicate: 'IS_A', object: 'Method' },
        { subject: 'method:Worker_helper', predicate: 'IS_A', object: 'Method' },
        { subject: 'function:boot', predicate: 'IS_A', object: 'Function' },
        { subject: 'function:helperGlobal', predicate: 'IS_A', object: 'Function' }
      ],
      expectedCalls: [
        { source: 'function:boot', target: 'function:helperGlobal' },
        { source: 'method:Worker_run', target: 'method:Worker_helper' }
      ]
    }),
    assertLanguageFixture({
      language: 'solidity',
      filename: 'Worker.sol',
      source: [
        'import "./Dep.sol";',
        'contract Worker {',
        '  function run() public returns (uint) {',
        '    return helper();',
        '  }',
        '  function helper() public returns (uint) {',
        '    return 1;',
        '  }',
        '}',
        'function boot() returns (uint) {',
        '  return setup();',
        '}',
        'function setup() returns (uint) { return 1; }'
      ].join('\n'),
      expectedFacts: [
        { subject: 'class:Worker', predicate: 'IS_A', object: 'Class' },
        { subject: 'method:Worker_run', predicate: 'IS_A', object: 'Method' },
        { subject: 'method:Worker_helper', predicate: 'IS_A', object: 'Method' },
        { subject: 'function:boot', predicate: 'IS_A', object: 'Function' },
        { subject: 'function:setup', predicate: 'IS_A', object: 'Function' },
        { subject: 'module:src_Worker', predicate: 'IMPORTS', object: 'module:Dep' }
      ],
      expectedCalls: [
        { source: 'function:boot', target: 'function:setup' },
        { source: 'method:Worker_run', target: 'method:Worker_helper' }
      ]
    }),
    assertLanguageFixture({
      language: 'haskell',
      filename: 'Worker.hs',
      source: [
        'module Worker where',
        'import Data.List',
        'helper () = 1',
        'run () = helper ()',
        'boot () = setup ()',
        'setup () = 1'
      ].join('\n'),
      expectedFacts: [
        { subject: 'function:boot', predicate: 'IS_A', object: 'Function' },
        { subject: 'function:helper', predicate: 'IS_A', object: 'Function' },
        { subject: 'function:run', predicate: 'IS_A', object: 'Function' },
        { subject: 'function:setup', predicate: 'IS_A', object: 'Function' },
        { subject: 'module:src_Worker', predicate: 'IMPORTS', object: 'module:Data' }
      ],
      expectedCalls: [
        { source: 'function:boot', target: 'function:setup' },
        { source: 'function:run', target: 'function:helper' }
      ]
    }),
    assertLanguageFixture({
      language: 'erlang',
      filename: 'worker.erl',
      source: [
        '-module(worker).',
        '-import(lists, [map/2]).',
        'run() -> helper().',
        'helper() -> 1.',
        'boot() -> setup().',
        'setup() -> 1.'
      ].join('\n'),
      expectedFacts: [
        { subject: 'class:worker', predicate: 'IS_A', object: 'Class' },
        { subject: 'function:boot', predicate: 'IS_A', object: 'Function' },
        { subject: 'function:helper', predicate: 'IS_A', object: 'Function' },
        { subject: 'function:run', predicate: 'IS_A', object: 'Function' },
        { subject: 'function:setup', predicate: 'IS_A', object: 'Function' },
        { subject: 'module:src_worker', predicate: 'IMPORTS', object: 'module:lists' }
      ],
      expectedCalls: [
        { source: 'function:boot', target: 'function:setup' },
        { source: 'function:run', target: 'function:helper' }
      ]
    }),
    assertLanguageFixture({
      language: 'perl',
      filename: 'worker.pl',
      source: [
        'package Worker {',
        'use strict;',
        'sub run {',
        '  return helper();',
        '}',
        'sub helper {',
        '  return 1;',
        '}',
        '}',
        'package main;',
        'sub boot {',
        '  return setup();',
        '}',
        'sub setup { return 1; }'
      ].join('\n'),
      expectedFacts: [
        { subject: 'class:Worker', predicate: 'IS_A', object: 'Class' },
        { subject: 'method:Worker_run', predicate: 'IS_A', object: 'Method' },
        { subject: 'method:Worker_helper', predicate: 'IS_A', object: 'Method' },
        { subject: 'function:boot', predicate: 'IS_A', object: 'Function' },
        { subject: 'function:setup', predicate: 'IS_A', object: 'Function' }
      ],
      expectedCalls: [
        { source: 'function:boot', target: 'function:setup' },
        { source: 'method:Worker_run', target: 'method:Worker_helper' }
      ]
    }),
    assertLanguageFixture({
      language: 'elixir',
      filename: 'worker.ex',
      source: [
        'defmodule Worker do',
        '  import Enum',
        '  def run do',
        '    helper()',
        '  end',
        '  def helper do',
        '    1',
        '  end',
        'end',
        'defmodule Utility do',
        '  def boot do',
        '    setup()',
        '  end',
        '  def setup do',
        '    1',
        '  end',
        'end'
      ].join('\n'),
      expectedFacts: [
        { subject: 'class:Worker', predicate: 'IS_A', object: 'Class' },
        { subject: 'method:Worker_run', predicate: 'IS_A', object: 'Method' },
        { subject: 'method:Worker_helper', predicate: 'IS_A', object: 'Method' },
        { subject: 'class:Utility', predicate: 'IS_A', object: 'Class' },
        { subject: 'method:Utility_boot', predicate: 'IS_A', object: 'Method' },
        { subject: 'method:Utility_setup', predicate: 'IS_A', object: 'Method' },
        { subject: 'module:src_worker', predicate: 'IMPORTS', object: 'module:Enum' }
      ],
      expectedCalls: [
        { source: 'method:Utility_boot', target: 'method:Utility_setup' },
        { source: 'method:Worker_run', target: 'method:Worker_helper' }
      ]
    }),
    assertLanguageFixture({
      language: 'ocaml',
      filename: 'worker.ml',
      source: [
        'open List',
        'let helper () = 1',
        'let run () = helper ()',
        'let setup () = 1',
        'let boot () = setup ()'
      ].join('\n'),
      expectedFacts: [
        { subject: 'function:boot', predicate: 'IS_A', object: 'Function' },
        { subject: 'function:helper', predicate: 'IS_A', object: 'Function' },
        { subject: 'function:run', predicate: 'IS_A', object: 'Function' },
        { subject: 'function:setup', predicate: 'IS_A', object: 'Function' },
        { subject: 'module:src_worker', predicate: 'IMPORTS', object: 'module:List' }
      ],
      expectedCalls: [
        { source: 'function:boot', target: 'function:setup' },
        { source: 'function:run', target: 'function:helper' }
      ]
    }),
    assertLanguageFixture({
      language: 'clojure',
      filename: 'worker.clj',
      source: [
        '(ns worker.core',
        '  (:require [clojure.string :as str]))',
        '(defn helper [] 1)',
        '(defn run [] (helper))',
        '(defn setup [] 1)',
        '(defn boot [] (setup))'
      ].join('\n'),
      expectedFacts: [
        { subject: 'class:workercore', predicate: 'IS_A', object: 'Class' },
        { subject: 'function:boot', predicate: 'IS_A', object: 'Function' },
        { subject: 'function:helper', predicate: 'IS_A', object: 'Function' },
        { subject: 'function:run', predicate: 'IS_A', object: 'Function' },
        { subject: 'function:setup', predicate: 'IS_A', object: 'Function' },
        { subject: 'module:src_worker', predicate: 'IMPORTS', object: 'module:clojure' }
      ],
      expectedCalls: [
        { source: 'function:boot', target: 'function:setup' },
        { source: 'function:run', target: 'function:helper' }
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

function realMultiLanguageRepoScenario() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'oaf-rust-m9-real-'));
  const repo = path.join(temp, 'tree-sitter-cpp');
  try {
    run('git', ['clone', '--depth', '1', 'https://github.com/tree-sitter/tree-sitter-cpp.git', repo]);
    const sqlite = path.join(temp, 'real.sqlite');
    const timed = timedJson(RUST_BIN, ['ingest', '--root', repo, '--sqlite', sqlite, '--format', 'json', '--max-memory', '350', '--max-file-mb', '2']);
    assert.ok(timed.value.summary.parsedFileCount >= 5, 'real multi-language repo parsed too few files');
    assert.ok(timed.value.quality.languageCounts.c > 0, 'real repo must exercise C');
    assert.ok(timed.value.quality.languageCounts.cpp > 0, 'real repo must exercise C++');
    assert.ok(timed.value.quality.languageCounts['javascript-jsx'] > 0, 'real repo must exercise JS');
    rustCli(repo, ['memory', 'approve', '--all'], sqlite);
    const duplicateNames = rows(repo, `
      SELECT name, count(*) AS count
      FROM memory_entities
      GROUP BY workspace_id, scope, name
      HAVING count(*) > 1
    `, sqlite);
    assert.deepEqual(duplicateNames, []);
    assert.equal(activeCallEdges(repo, sqlite).filter((edge) => edge.target.startsWith('module:')).length, 0);
    return {
      label: 'tree-sitter/tree-sitter-cpp',
      parsedFileCount: timed.value.summary.parsedFileCount,
      generatedFactCount: timed.value.summary.generatedFactCount,
      skippedFileCount: timed.value.summary.skippedFileCount,
      languageCounts: timed.value.quality.languageCounts,
      duplicateEntityNameCount: duplicateNames.length,
      moduleTargetCallCount: activeCallEdges(repo, sqlite).filter((edge) => edge.target.startsWith('module:')).length,
      indexMs: timed.ms,
      peakRssMb: timed.peakRssMb
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const fixture = fixtureScenario();
const languageQuality = languageFixtures();
crashScenario();
const oafRepo = oafRepoScenario();
const realMultiLanguageRepo = realMultiLanguageRepoScenario();
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
  `  realMultiLanguageRepo ${realMultiLanguageRepo.label}`,
  `  realMultiLanguageParsedFileCount ${realMultiLanguageRepo.parsedFileCount}`,
  `  realMultiLanguageGeneratedFactCount ${realMultiLanguageRepo.generatedFactCount}`,
  `  realMultiLanguageSkippedFileCount ${realMultiLanguageRepo.skippedFileCount}`,
  `  realMultiLanguageCounts ${JSON.stringify(realMultiLanguageRepo.languageCounts)}`,
  `  realMultiLanguageDuplicateEntityNameCount ${realMultiLanguageRepo.duplicateEntityNameCount}`,
  `  realMultiLanguageModuleTargetCallCount ${realMultiLanguageRepo.moduleTargetCallCount}`,
  `  realMultiLanguageIndexMs ${realMultiLanguageRepo.indexMs}`,
  `  realMultiLanguagePeakRssMb ${realMultiLanguageRepo.peakRssMb}`,
  `  rustOafIndexMs ${oafRepo.rustOafIndexMs}`,
  `  rustOafPeakRssMb ${oafRepo.rustOafPeakRssMb}`,
  `  documentedNodeBaselineMs ${NODE_BASELINE_MS}`,
  `  documentedNodeBaselinePeakRssMb ${NODE_BASELINE_RSS_MB}`,
  '  unhandledPatterns alias resolution across files, dynamic dispatch, generated route semantics, type-only call disambiguation'
].join('\n'));
