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

function runJson(command, args, options = {}) {
  return JSON.parse(run(command, args, options).stdout);
}

function oaf(root, sqlite, args) {
  return runJson(RUST_BIN, [...args, '--root', root, '--sqlite', sqlite, '--format', 'json']);
}

function reciprocalRank(hits, relevant) {
  const rank = hits.findIndex((hit) => relevant.some((needle) => hit.fact.subject === needle || hit.fact.value === needle || hit.fact.text?.includes(needle)));
  return rank === -1 ? 0 : 1 / (rank + 1);
}

function hitRate(hits, relevant) {
  return reciprocalRank(hits, relevant) > 0 ? 1 : 0;
}

function evaluateMode(root, sqlite, mode, questions) {
  return questions.map((question) => {
    const args = ['search', '--query', question.query, '--mode', mode, '--limit', '8'];
    if (mode !== 'keyword') args.push('--semantic');
    const report = oaf(root, sqlite, args);
    return {
      id: question.id,
      query: question.query,
      relevant: question.relevant,
      mrr: reciprocalRank(report.hits, question.relevant),
      hit: hitRate(report.hits, question.relevant),
      topSubjects: report.hits.slice(0, 5).map((hit) => hit.fact.subject),
      topValues: report.hits.slice(0, 5).map((hit) => hit.fact.value),
      semantic: report.semantic
    };
  });
}

function summarize(results) {
  const mrr = results.reduce((sum, item) => sum + item.mrr, 0) / results.length;
  const hitRateValue = results.reduce((sum, item) => sum + item.hit, 0) / results.length;
  return {
    mrr: Number(mrr.toFixed(4)),
    hitRate: Number(hitRateValue.toFixed(4)),
    hits: results.reduce((sum, item) => sum + item.hit, 0),
    questionCount: results.length
  };
}

assert.equal(existsSync(RUST_BIN), true, 'rust/target/release/oaf must exist; run cargo build --release --manifest-path rust/Cargo.toml first');

const temp = mkdtempSync(path.join(os.tmpdir(), 'oaf-rust-semantic-'));
try {
  const sqlite = path.join(temp, 'semantic.sqlite');
  const ingest = oaf(ROOT, sqlite, ['ingest', '--workers', '1']);
  assert.ok(ingest.summary.proposalCount > 1000, 'semantic gate needs the real OAF source graph');
  oaf(ROOT, sqlite, ['memory', 'approve', '--all']);

  const defaultOff = oaf(ROOT, sqlite, ['search', '--query', 'database backend', '--mode', 'keyword', '--limit', '5']);
  const explicitOff = oaf(ROOT, sqlite, ['search', '--query', 'database backend', '--mode', 'keyword', '--limit', '5', '--semantic', 'false']);
  assert.deepEqual(defaultOff.hits, explicitOff.hits, 'keyword search must be byte-identical with semantic omitted vs explicitly off');
  assert.equal(defaultOff.semantic.enabled, false);
  assert.equal(defaultOff.semantic.tableLoaded, false);

  const questions = [
    {
      id: 'database-backend',
      query: 'sql backend',
      relevant: ['module:rusqlite']
    },
    {
      id: 'accept-queued-memories',
      query: 'approved proposals',
      relevant: ['method:Store_approve_all', 'method:Store_approve_proposal_uncommitted']
    },
    {
      id: 'graph-neighborhood',
      query: 'dependency neighborhood',
      relevant: ['function:graph_explain_command', 'method:Store_explain']
    },
    {
      id: 'change-impact',
      query: 'changed file impacts',
      relevant: ['function:impact_detect_changes_command', 'method:Store_affected_symbols_for_files']
    }
  ];

  const keywordResults = evaluateMode(ROOT, sqlite, 'keyword', questions);
  const semanticResults = evaluateMode(ROOT, sqlite, 'semantic', questions);
  const hybridResults = evaluateMode(ROOT, sqlite, 'hybrid', questions);
  const keyword = summarize(keywordResults);
  const semantic = summarize(semanticResults);
  const hybrid = summarize(hybridResults);
  const surfacedKeywordMisses = hybridResults.filter((item, index) => item.hit === 1 && keywordResults[index].hit === 0).map((item) => item.id);
  const hybridBeatsKeyword = hybrid.mrr > keyword.mrr && hybrid.hitRate >= keyword.hitRate && surfacedKeywordMisses.length >= 1;

  const report = {
    schemaVersion: '1.0.0',
    command: 'rust semantic quality',
    methodology: 'Real OAF repo source graph; paraphrase queries intentionally use vocabulary different from the governed fact text; compare keyword FTS, static-token semantic cosine, and hybrid blend.',
    questionCount: questions.length,
    keyword,
    semantic,
    hybrid,
    surfacedKeywordMisses,
    hybridBeatsKeyword,
    status: hybridBeatsKeyword ? 'PASS' : 'EXPERIMENTAL',
    results: { keyword: keywordResults, semantic: semanticResults, hybrid: hybridResults }
  };

  console.log(JSON.stringify(report, null, 2));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
