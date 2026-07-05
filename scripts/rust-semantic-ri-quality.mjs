import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const RUST_BIN = path.join(ROOT, 'rust/target/release/oaf');
const FIXED_NOW = '2026-06-29T00:00:00.000Z';

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

function runJson(command, args) {
  return JSON.parse(run(command, args).stdout);
}

function oaf(root, sqlite, args) {
  return runJson(RUST_BIN, [...args, '--root', root, '--sqlite', sqlite, '--format', 'json']);
}

function reciprocalRank(hits, relevant) {
  const rank = hits.findIndex((hit) =>
    relevant.some((needle) => hit.fact.subject === needle || hit.fact.value === needle || hit.fact.text?.includes(needle))
  );
  return rank === -1 ? 0 : 1 / (rank + 1);
}

function evaluate(root, sqlite, mode, questions) {
  return questions.map((question) => {
    const args = ['search', '--query', question.query, '--mode', mode, '--limit', '8'];
    if (mode !== 'keyword') args.push('--semantic');
    const report = oaf(root, sqlite, args);
    return {
      id: question.id,
      query: question.query,
      relevant: question.relevant,
      mrr: reciprocalRank(report.hits, question.relevant),
      hit: reciprocalRank(report.hits, question.relevant) > 0 ? 1 : 0,
      topSubjects: report.hits.slice(0, 5).map((hit) => hit.fact.subject),
      topValues: report.hits.slice(0, 5).map((hit) => hit.fact.value),
      semantic: report.semantic
    };
  });
}

function summarize(results) {
  return {
    mrr: Number((results.reduce((sum, item) => sum + item.mrr, 0) / results.length).toFixed(4)),
    hitRate: Number((results.reduce((sum, item) => sum + item.hit, 0) / results.length).toFixed(4)),
    hits: results.reduce((sum, item) => sum + item.hit, 0),
    questionCount: results.length
  };
}

assert.equal(existsSync(RUST_BIN), true, 'rust/target/release/oaf must exist; run cargo build --release --manifest-path rust/Cargo.toml first');

const temp = mkdtempSync(path.join(os.tmpdir(), 'oaf-rust-semantic-ri-'));
try {
  const sqlite = path.join(temp, 'semantic-ri.sqlite');
  const ingest = oaf(ROOT, sqlite, ['ingest', '--workers', '1']);
  assert.ok(ingest.summary.proposalCount > 1000, 'CI-1 gate must use the real OAF source graph');
  oaf(ROOT, sqlite, ['memory', 'approve', '--all']);

  const defaultOff = oaf(ROOT, sqlite, ['search', '--query', 'changed file impacts', '--mode', 'keyword', '--limit', '5']);
  const explicitOff = oaf(ROOT, sqlite, ['search', '--query', 'changed file impacts', '--mode', 'keyword', '--limit', '5', '--semantic', 'false']);
  assert.deepEqual(defaultOff.hits, explicitOff.hits, 'semantic must be default-off and keyword byte-identical');
  assert.equal(defaultOff.semantic.enabled, false);

  const questions = [
    {
      id: 'database-backend',
      query: 'sql backend',
      relevant: ['module:rusqlite', 'module:providers_native_memory_sqlite_src_index']
    },
    {
      id: 'accept-queued-memories',
      query: 'approved proposals',
      relevant: ['method:Store_approve_all', 'method:Store_approve_proposal_uncommitted', 'function:buildMemoryProposalsReport']
    },
    {
      id: 'graph-neighborhood',
      query: 'dependency neighborhood',
      relevant: ['function:graph_explain_command', 'method:Store_explain', 'method:Store_graph_explain']
    },
    {
      id: 'change-impact',
      query: 'changed file impacts',
      relevant: ['function:impact_detect_changes_command', 'method:Store_affected_symbols_for_files', 'function:impact_command']
    }
  ];

  const keywordResults = evaluate(ROOT, sqlite, 'keyword', questions);
  const hybridResults = evaluate(ROOT, sqlite, 'hybrid', questions);
  const keyword = summarize(keywordResults);
  const hybrid = summarize(hybridResults);
  const surfacedKeywordMisses = hybridResults
    .filter((item, index) => item.hit === 1 && keywordResults[index].hit === 0)
    .map((item) => item.id);

  assert.ok(hybrid.mrr > keyword.mrr, `hybrid MRR ${hybrid.mrr} must beat keyword MRR ${keyword.mrr}`);
  assert.ok(hybrid.hitRate >= keyword.hitRate, `hybrid hitRate ${hybrid.hitRate} must not regress keyword ${keyword.hitRate}`);
  assert.ok(surfacedKeywordMisses.length >= 1, 'hybrid must surface at least one relevant keyword miss');
  assert.equal(hybridResults[0].semantic.model, 'random-indexing');
  assert.equal(hybridResults[0].semantic.dimensions, 256);
  assert.ok(hybridResults[0].semantic.tokenCount > 1000, 'RI corpus should be built from real repo tokens');

  console.log(JSON.stringify({
    schemaVersion: '1.0.0',
    command: 'rust semantic RI quality',
    methodology: 'Real OAF repo source graph; paraphrase queries use vocabulary different from fact text; relevance keys accept multiple genuinely relevant symbols; keyword vs opt-in Random Indexing hybrid.',
    questionCount: questions.length,
    keyword,
    hybrid,
    surfacedKeywordMisses,
    status: 'PASS',
    results: { keyword: keywordResults, hybrid: hybridResults }
  }, null, 2));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
