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

function activeFacts(sqlite) {
  return rows(sqlite, `
    SELECT subject,
           predicate,
           object,
           json_extract(metadata_json, '$.notes') AS notes
    FROM memory_facts
    WHERE status = 'active'
      AND superseded_by IS NULL
    ORDER BY subject, predicate, object
  `);
}

function factKey(fact) {
  return `${fact.subject}\t${fact.predicate}\t${fact.object}`;
}

function countFacts(facts, predicate, object) {
  return facts.filter((fact) => fact.predicate === predicate && fact.object === object).length;
}

function makeFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaf-rust-ci3-routes-'));
  mkdirSync(path.join(root, '.local'), { recursive: true });
  mkdirSync(path.join(root, 'src/demo_app'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: '@acme/web',
    main: 'src/index.js'
  }, null, 2));
  writeFileSync(path.join(root, 'pyproject.toml'), [
    '[project]',
    'name = "demo-app"'
  ].join('\n'));
  writeFileSync(path.join(root, 'src/index.js'), [
    "import { helper } from './helper.js';",
    'function listUsers(req, res) {',
    '  return helper();',
    '}',
    "app.get('/api/accounts/:id', listUsers);"
  ].join('\n'));
  writeFileSync(path.join(root, 'src/helper.js'), 'export function helper() { return 1; }\n');
  writeFileSync(path.join(root, 'src/module.mts'), [
    'export function typedEntry() {',
    '  return typedHelper();',
    '}',
    'function typedHelper() { return 1; }'
  ].join('\n'));
  writeFileSync(path.join(root, 'src/common.cts'), [
    'export function commonEntry() {',
    '  return commonHelper();',
    '}',
    'function commonHelper() { return 1; }'
  ].join('\n'));
  writeFileSync(path.join(root, 'src/demo_app/app.py'), [
    'from flask import Flask',
    'app = Flask(__name__)',
    "@app.route('/items/<int:item_id>', methods=['POST'])",
    'def create_item():',
    "    return 'ok'"
  ].join('\n'));
  writeFileSync(path.join(root, 'src/demo_app/client.py'), 'from demo_app.app import create_item\n');
  return root;
}

function fixtureScenario() {
  const root = makeFixture();
  const sqlite = path.join(root, '.local', 'memory.sqlite');
  try {
    const ingest = oaf(root, sqlite, ['ingest', '--max-file-bytes', '8192']);
    assert.equal(ingest.summary.activeMemoryCreated, 0);
    oaf(root, sqlite, ['memory', 'approve', '--all']);
    const facts = activeFacts(sqlite);
    const keys = new Set(facts.map(factKey));
    const expected = [
      { subject: 'route:GET_api_accounts_param', predicate: 'IS_A', object: 'Route' },
      { subject: 'route:GET_api_accounts_param', predicate: 'HAS_PATH', object: 'path=/api/accounts/:param' },
      { subject: 'route:GET_api_accounts_param', predicate: 'HAS_METHOD', object: 'method=GET' },
      { subject: 'function:listUsers', predicate: 'HANDLES', object: 'route:GET_api_accounts_param' },
      { subject: 'route:POST_items_param', predicate: 'IS_A', object: 'Route' },
      { subject: 'route:POST_items_param', predicate: 'HAS_PATH', object: 'path=/items/:param' },
      { subject: 'route:POST_items_param', predicate: 'HAS_METHOD', object: 'method=POST' },
      { subject: 'function:create_item', predicate: 'HANDLES', object: 'route:POST_items_param' },
      { subject: 'module:src_index', predicate: 'IMPORTS', object: 'module:src_helper' },
      { subject: 'module:src_demo_app_client', predicate: 'IMPORTS', object: 'module:src_demo_app_app' },
      { subject: 'function:typedEntry', predicate: 'CALLS', object: 'function:typedHelper' },
      { subject: 'function:commonEntry', predicate: 'CALLS', object: 'function:commonHelper' }
    ];
    const missing = expected.filter((fact) => !keys.has(factKey(fact)));
    assert.deepEqual(missing, [], JSON.stringify(facts.filter((fact) => fact.subject.startsWith('route:')), null, 2));
    const resolvedImports = facts.filter((fact) => fact.notes === 'oaf.ingest:resolved-import');
    return {
      parsedFileCount: ingest.summary.parsedFileCount,
      generatedFactCount: ingest.summary.recordedCount,
      routeCount: countFacts(facts, 'IS_A', 'Route'),
      handleCount: facts.filter((fact) => fact.predicate === 'HANDLES').length,
      resolvedImportCount: resolvedImports.length,
      addedTypeScriptModuleExtensions: ['.mts', '.cts'],
      expectedFactCount: expected.length
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function realFlaskScenario() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'oaf-rust-ci3-real-'));
  const repo = path.join(temp, 'flask');
  const sqlite = path.join(temp, 'flask.sqlite');
  try {
    run('git', ['clone', '--depth', '1', 'https://github.com/pallets/flask.git', repo]);
    const ingest = oaf(repo, sqlite, ['ingest', '--workers', '1', '--max-file-mb', '2']);
    assert.ok(ingest.summary.parsedFileCount >= 20, 'real Flask repo parsed too few files');
    oaf(repo, sqlite, ['memory', 'approve', '--all']);
    const facts = activeFacts(sqlite);
    const routeFacts = facts.filter((fact) => fact.predicate === 'IS_A' && fact.object === 'Route');
    const handles = facts.filter((fact) => fact.predicate === 'HANDLES');
    assert.ok(routeFacts.length > 0, 'real Flask repo should produce route facts');
    assert.ok(handles.length > 0, 'real Flask repo should produce handler links');
    const second = oaf(repo, sqlite, ['ingest', '--workers', '1', '--max-file-mb', '2']);
    assert.equal(second.summary.recordedCount, 0);
    return {
      label: 'pallets/flask',
      parsedFileCount: ingest.summary.parsedFileCount,
      generatedFactCount: ingest.summary.recordedCount,
      routeCount: routeFacts.length,
      handleCount: handles.length,
      idempotentRecordedCount: second.summary.recordedCount,
      sampleRoutes: routeFacts.slice(0, 10).map((fact) => fact.subject)
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const fixture = fixtureScenario();
assert.ok(fixture.resolvedImportCount >= 2);
assert.equal(fixture.routeCount, 2);
assert.equal(fixture.handleCount, 2);
const realFlaskRepo = realFlaskScenario();

console.log(JSON.stringify({
  schemaVersion: '1.0.0',
  command: 'rust routes imports quality',
  methodology: 'CI-3 measures governed Route facts and resolved in-project IMPORTS after proposal approval; real route extraction is checked on a cloned Flask repository.',
  fixture,
  realFlaskRepo,
  status: 'PASS'
}, null, 2));
