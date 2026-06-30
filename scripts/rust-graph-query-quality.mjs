import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const RUST_BIN = path.join(ROOT, 'rust/target/release/oaf');
const FIXTURE_NOW = '2026-06-26T11:00:00.000Z';
const PAST = '2026-06-26T09:30:00.000Z';
const INITIAL = '2026-06-26T09:00:00.000Z';
const SUPERSEDE = '2026-06-26T10:00:00.000Z';
const SQLITE = '.local/memory.sqlite';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, OAF_FIXED_NOW: FIXTURE_NOW },
    ...options
  });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stderr || result.stdout}`);
  return result;
}

function runJson(command, args, options = {}) {
  return JSON.parse(run(command, args, options).stdout);
}

function runFailure(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, OAF_FIXED_NOW: FIXTURE_NOW },
    ...options
  });
  assert.notEqual(result.status, 0, `${command} ${args.join(' ')} unexpectedly succeeded`);
  return result;
}

function nodeCli(root, args) {
  return runJson(process.execPath, ['apps/cli/oaf.mjs', ...args, '--root', root, '--sqlite', SQLITE, '--workspace', 'ws_local', '--scope', 'workspace', '--format', 'json'], {
    env: { ...process.env, OAF_FIXED_NOW: FIXTURE_NOW }
  });
}

function rustCli(root, args, options = {}) {
  return runJson(RUST_BIN, [...args, '--root', root, '--sqlite', SQLITE, '--workspace', 'ws_local', '--scope', 'workspace', '--format', 'json'], {
    env: { ...process.env, OAF_FIXED_NOW: FIXTURE_NOW },
    ...options
  });
}

function rustCliFailure(root, args) {
  return runFailure(RUST_BIN, [...args, '--root', root, '--sqlite', SQLITE, '--workspace', 'ws_local', '--scope', 'workspace', '--format', 'json']);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === 'digest') out[key] = '<digest>';
      else out[key] = normalize(item);
    }
    return out;
  }
  return value;
}

function assertParity(label, rustValue, nodeValue) {
  assert.equal(canonical(normalize(rustValue)), canonical(normalize(nodeValue)), label);
}

function makeRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaf-rust-m4-'));
  mkdirSync(path.join(root, '.local'), { recursive: true });
  writeFileSync(path.join(root, 'DECISIONS.md'), '# M4 fixture\n');
  return root;
}

function remember(root, { subject, predicate, object, now = INITIAL, supersedes = false, source = 'workspace://DECISIONS.md' }) {
  const args = ['memory', 'remember', '--subject', subject, '--predicate', predicate, '--object', object, '--source', source, '--root', root, '--sqlite', SQLITE, '--format', 'json'];
  if (supersedes) args.push('--supersedes-subject', subject, '--supersedes-predicate', predicate);
  return runJson(RUST_BIN, args, { env: { ...process.env, OAF_FIXED_NOW: now } });
}

function seedFixture(root) {
  const facts = [
    ['notes-api', 'depends_on', 'auth'],
    ['notes-api', 'uses', 'auth_mjs'],
    ['auth', 'uses', 'hmac-session-tokens'],
    ['auth', 'implemented_by', 'auth_mjs'],
    ['auth_mjs', 'exposes', 'issueToken'],
    ['auth_mjs', 'exposes', 'verifyToken'],
    ['auth', 'token_expiry', '15 minutes'],
    ['auth', 'timeout_seconds', '900'],
    ['module:rust/oaf-store', 'DEFINES', 'class:Store'],
    ['class:Store', 'DEFINES', 'method:Store_graph_path'],
    ['method:Store_graph_path', 'CALLS', 'function:validTemporalGraphEdges'],
    ['method:Store_query_graph', 'CALLS', 'function:cypher_eval'],
    ['file:rust/oaf/src/main.rs', 'IMPORTS', 'module:oaf_store'],
    ['decision:m4-readonly', 'GOVERNS', 'architecture.overview']
  ];
  for (const [subject, predicate, object] of facts) remember(root, { subject, predicate, object });
  remember(root, {
    subject: 'auth',
    predicate: 'uses',
    object: 'signed-session-tokens',
    now: SUPERSEDE,
    supersedes: true
  });
}

function graphParityScenario() {
  const root = makeRoot();
  seedFixture(root);
  const currentPathArgs = ['path', '--from', 'notes-api', '--to', 'issueToken', '--max-hops', '6'];
  assertParity('graph.path current parity', rustCli(root, ['graph', ...currentPathArgs]), nodeCli(root, ['memory', ...currentPathArgs]));
  const historicalPathArgs = ['path', '--from', 'notes-api', '--to', 'hmac-session-tokens', '--max-hops', '6', '--at', PAST];
  assertParity('graph.path AS OF parity', rustCli(root, ['graph', ...historicalPathArgs]), nodeCli(root, ['memory', ...historicalPathArgs]));
  const stalePath = rustCli(root, ['graph', 'path', '--from', 'notes-api', '--to', 'hmac-session-tokens', '--max-hops', '6']);
  assert.deepEqual(stalePath.path, []);
  assert.deepEqual(stalePath.edges, []);
  const currentSigned = rustCli(root, ['graph', 'path', '--from', 'notes-api', '--to', 'signed-session-tokens', '--max-hops', '6']);
  assert.deepEqual(currentSigned.path.map((node) => node.name), ['notes-api', 'auth', 'signed-session-tokens']);

  const explainArgs = ['explain', '--entity', 'auth', '--depth', '1'];
  assertParity('graph.explain current parity', rustCli(root, ['graph', ...explainArgs]), nodeCli(root, ['memory', ...explainArgs]));
  const explain = rustCli(root, ['graph', 'explain', '--entity', 'auth', '--depth', '1']);
  assert.equal(explain.edges.some((edge) => edge.to === 'hmac-session-tokens'), false);
  assert.equal(explain.edges.some((edge) => edge.to === 'signed-session-tokens'), true);
  return root;
}

function assertRows(root, cypher, rows, options = []) {
  const report = rustCli(root, ['query', 'graph', '--cypher', cypher, ...options]);
  assert.deepEqual(report.rows, rows, cypher);
  assert.equal(report.rowCount, rows.length, cypher);
  assert.equal(typeof report.truncated, 'boolean', cypher);
  return report;
}

function cypherScenario(root) {
  assertRows(root, "MATCH (n)-[:uses]->(m) WHERE n.name = 'notes-api' RETURN n.name AS from, m.name AS to ORDER BY to", [
    { from: 'notes-api', to: 'auth_mjs' }
  ]);
  assertRows(root, "MATCH (n:Class)-[:DEFINES]->(m:Method) RETURN n.name AS class, m.name AS method ORDER BY method LIMIT 5", [
    { class: 'class:Store', method: 'method:Store_graph_path' }
  ]);
  assertRows(root, "MATCH (n:Method)-[:CALLS]->(m:Function) WHERE n.name = 'method:Store_query_graph' RETURN labels(n) AS n_labels, m.name AS fn", [
    { n_labels: ['Method'], fn: 'function:cypher_eval' }
  ]);
  assertRows(root, "MATCH (n)-[:uses]->(m) RETURN count(*) AS uses_count", [
    { uses_count: 2 }
  ]);
  assertRows(root, "MATCH (n)-[:exposes]->(m) RETURN count(DISTINCT m.name) AS exposed_count", [
    { exposed_count: 2 }
  ]);
  assertRows(root, "MATCH (n)-[:exposes]->(m) WITH DISTINCT m.name AS name RETURN name ORDER BY name LIMIT 1", [
    { name: 'issueToken' }
  ]);
  assertRows(root, "MATCH (n)-[:timeout_seconds]->(m) WHERE toInteger(m.name) >= 600 RETURN toInteger(m.name) AS seconds", [
    { seconds: 900 }
  ]);
  assertRows(root, "MATCH (n)-[:exposes]->(m) WHERE m.name CONTAINS 'Token' OR NOT m.name = 'issueToken' RETURN m.name AS name ORDER BY name", [
    { name: 'issueToken' },
    { name: 'verifyToken' }
  ]);
  assertRows(root, `AS OF '${PAST}' MATCH (n)-[:uses]->(m) WHERE n.name = 'auth' RETURN m.name AS token`, [
    { token: 'hmac-session-tokens' }
  ]);
  assertRows(root, "MATCH (n)-[:uses]->(m) WHERE n.name = 'auth' RETURN m.name AS token", [
    { token: 'signed-session-tokens' }
  ]);
  const bounded = assertRows(root, "MATCH (n)-[:exposes]->(m) RETURN m.name AS name ORDER BY name", [
    { name: 'issueToken' }
  ], ['--max-rows', '1']);
  assert.equal(bounded.truncated, true);

  for (const cypher of [
    'MATCH p=(n)-[:uses]->(m) RETURN p',
    'MATCH (n)<-[:uses]-(m) RETURN n.name',
    'MATCH (n)-[*1..2]->(m) RETURN m.name',
    'CREATE (n)',
    'MATCH (n) DETACH DELETE n',
    'MATCH (n)-[:uses|depends_on]->(m) RETURN m.name',
    'MATCH (n) RETURN n'
  ]) {
    const failure = rustCliFailure(root, ['query', 'graph', '--cypher', cypher]);
    assert.match(failure.stderr, /unsupported Cypher|invalid Cypher/u, cypher);
  }
}

function mcpTool(root, name, args) {
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } }
  ].map((message) => JSON.stringify(message)).join('\n');
  const result = run(RUST_BIN, ['mcp', 'server', '--read-only', '--root', root, '--sqlite', SQLITE, '--cursors', '.local/m4-cursors.json', '--stdio'], { input });
  const lines = result.stdout.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(lines[0].result.protocolVersion, '2025-06-18');
  const toolNames = lines[1].result.tools.map((tool) => tool.name);
  for (const expected of ['graph.path', 'graph.explain', 'query.graph', 'architecture.overview']) {
    assert.ok(toolNames.includes(expected), `tools/list missing ${expected}`);
  }
  assert.equal(lines[2].result._meta.oaf.sideEffectClass, 'read-only');
  return JSON.parse(lines[2].result.content[0].text);
}

function mcpScenario(root) {
  const pathPayload = mcpTool(root, 'graph.path', { from: 'notes-api', to: 'issueToken', maxHops: 6, scope: 'workspace' });
  assert.deepEqual(pathPayload.data.path.path.map((node) => node.name), ['notes-api', 'auth_mjs', 'issueToken']);
  const queryPayload = mcpTool(root, 'query.graph', { cypher: "MATCH (n)-[:uses]->(m) WHERE n.name = 'auth' RETURN m.name AS token", scope: 'workspace' });
  assert.deepEqual(queryPayload.data.query.rows, [{ token: 'signed-session-tokens' }]);
  const overviewPayload = mcpTool(root, 'architecture.overview', { scope: 'workspace' });
  assert.ok(overviewPayload.data.overview.summary.nodeCount >= 10);
}

function architectureScenario(root) {
  const overview = rustCli(root, ['architecture', 'overview']);
  assert.equal(overview.safeguards.readOnly, true);
  assert.equal(overview.safeguards.canonicalStateMutated, false);
  assert.ok(overview.summary.nodeCount >= 10);
  assert.ok(overview.summary.edgeCount >= 10);
  assert.ok(overview.summary.communityCount >= 1);
  assert.ok(overview.topModules.some((item) => item.name === 'module:rust/oaf-store'), JSON.stringify(overview.topModules));
  assert.ok(overview.hotspots.some((item) => item.name === 'auth'), JSON.stringify(overview.hotspots));
  assert.ok(overview.governedDecisions.some((item) => item.name === 'decision:m4-readonly'), JSON.stringify(overview.governedDecisions));
  return overview;
}

function dbRows(sqlite, sql) {
  const db = new DatabaseSync(sqlite, { readOnly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

function timed(command, args, options = {}) {
  const started = performance.now();
  const result = spawnSync('/usr/bin/time', ['-l', command, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, OAF_FIXED_NOW: FIXTURE_NOW },
    ...options
  });
  const elapsedMs = performance.now() - started;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const rssBytes = Number(result.stderr.match(/(\d+)\s+maximum resident set size/u)?.[1] ?? 0);
  return { ms: Number(elapsedMs.toFixed(3)), peakRssMb: Number((rssBytes / 1024 / 1024).toFixed(1)) };
}

function realOafScenario() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'oaf-rust-m4-oaf-'));
  const sqlite = path.join(temp, 'oaf-repo.sqlite');
  try {
    const ingest = timed(RUST_BIN, ['ingest', '--root', ROOT, '--sqlite', sqlite, '--format', 'json', '--max-memory', '350', '--max-file-mb', '2']);
    run(RUST_BIN, ['memory', 'approve', '--all', '--root', ROOT, '--sqlite', sqlite, '--format', 'json']);
    const edge = dbRows(sqlite, `
      SELECT source.name AS source, target.name AS target
      FROM memory_edges edge
      JOIN memory_facts fact ON fact.id = edge.fact_id AND fact.workspace_id = edge.workspace_id
      JOIN memory_entities source ON source.id = edge.source_entity_id AND source.workspace_id = edge.workspace_id
      JOIN memory_entities target ON target.id = edge.target_entity_id AND target.workspace_id = edge.workspace_id
      WHERE fact.status = 'active'
        AND fact.superseded_by IS NULL
        AND fact.predicate = 'CALLS'
      ORDER BY source.name, target.name
      LIMIT 1
    `)[0];
    assert.ok(edge, 'real OAF graph should have at least one CALLS edge');
    const pathBench = timed(RUST_BIN, ['graph', 'path', '--root', ROOT, '--sqlite', sqlite, '--from', edge.source, '--to', edge.target, '--max-hops', '3', '--format', 'json']);
    const explainBench = timed(RUST_BIN, ['graph', 'explain', '--root', ROOT, '--sqlite', sqlite, '--entity', edge.source, '--depth', '2', '--format', 'json']);
    const cypherBench = timed(RUST_BIN, ['query', 'graph', '--root', ROOT, '--sqlite', sqlite, '--cypher', 'MATCH (n)-[:CALLS]->(m) RETURN n.name AS caller, m.name AS callee LIMIT 20', '--format', 'json']);
    const overviewBench = timed(RUST_BIN, ['architecture', 'overview', '--root', ROOT, '--sqlite', sqlite, '--format', 'json']);
    const overview = runJson(RUST_BIN, ['architecture', 'overview', '--root', ROOT, '--sqlite', sqlite, '--format', 'json']);
    assert.ok(overview.summary.nodeCount > 100);
    assert.ok(overview.summary.edgeCount > 100);
    assert.ok(overview.hotspots.length > 0);
    assert.ok(overview.communities.length > 0);
    return {
      ingestMs: ingest.ms,
      ingestPeakRssMb: ingest.peakRssMb,
      nodeCount: overview.summary.nodeCount,
      edgeCount: overview.summary.edgeCount,
      communityCount: overview.summary.communityCount,
      hotspotCount: overview.hotspots.length,
      languageCount: overview.languageHistogram.length,
      pathLatency: pathBench,
      explainLatency: explainBench,
      cypherLatency: cypherBench,
      overviewLatency: overviewBench
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

assert.equal(existsSync(RUST_BIN), true, 'rust/target/release/oaf must exist; run cargo build --release --manifest-path rust/Cargo.toml first');

const fixtureRoot = graphParityScenario();
try {
  cypherScenario(fixtureRoot);
  const fixtureOverview = architectureScenario(fixtureRoot);
  mcpScenario(fixtureRoot);
  const realOaf = realOafScenario();
  console.log([
    'graph/query quality:',
    '  graphPathParity byte-parity',
    '  graphExplainParity byte-parity',
    '  cypherCorrectness exact-rows-and-clear-errors',
    `  fixtureOverviewNodeCount ${fixtureOverview.summary.nodeCount}`,
    `  fixtureOverviewEdgeCount ${fixtureOverview.summary.edgeCount}`,
    `  fixtureOverviewCommunityCount ${fixtureOverview.summary.communityCount}`,
    `  oafNodeCount ${realOaf.nodeCount}`,
    `  oafEdgeCount ${realOaf.edgeCount}`,
    `  oafCommunityCount ${realOaf.communityCount}`,
    `  oafHotspotCount ${realOaf.hotspotCount}`,
    `  oafLanguageCount ${realOaf.languageCount}`,
    `  oafIngestMs ${realOaf.ingestMs}`,
    `  oafIngestPeakRssMb ${realOaf.ingestPeakRssMb}`,
    `  pathLatencyMs ${realOaf.pathLatency.ms}`,
    `  pathPeakRssMb ${realOaf.pathLatency.peakRssMb}`,
    `  explainLatencyMs ${realOaf.explainLatency.ms}`,
    `  explainPeakRssMb ${realOaf.explainLatency.peakRssMb}`,
    `  cypherLatencyMs ${realOaf.cypherLatency.ms}`,
    `  cypherPeakRssMb ${realOaf.cypherLatency.peakRssMb}`,
    `  architectureLatencyMs ${realOaf.overviewLatency.ms}`,
    `  architecturePeakRssMb ${realOaf.overviewLatency.peakRssMb}`,
    '  cypherUnsupported path-binding, reverse-pattern, variable-length, mutation, relationship-alternation, node-only-match',
    '  unhandledPatterns variable-length paths, arbitrary node-only matches, writes, relationship alternation, shortestPath, OPTIONAL MATCH, multi-MATCH joins'
  ].join('\n'));
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
