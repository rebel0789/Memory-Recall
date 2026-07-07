import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function runContextRecall(args = []) {
  const result = spawnSync(process.execPath, ['scripts/context-recall-eval.mjs', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function runContextRecallRaw(args = []) {
  return spawnSync(process.execPath, ['scripts/context-recall-eval.mjs', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8'
  });
}

test('context recall eval gates the target budget without treating it as the only budget', () => {
  const report = runContextRecall([
    '--dataset',
    'evals/context-recall/oaf-repo-gold.v1.json',
    '--mode',
    'compiler-code-search',
    '--budgets',
    '8000,12000'
  ]);

  assert.equal(report.gateDecision, 'pass');
  assert.equal(report.mode, 'compiler-code-search');
  assert.equal(report.gate.budget, 8000);
  assert.equal(report.gate.minPassingBudget, 8000);
  assert(report.suiteDurationMs >= 0);
  assert.deepEqual(report.results.map((item) => item.budget), [8000, 12000]);

  const target = report.results.find((item) => item.budget === 8000);
  assert.equal(target.metrics.hitRate, 1);
  assert(target.metrics.avgFileRecall >= 0.7);
  assert(target.metrics.avgReturnedTokens <= 8000);
  assert(target.metrics.avgWindowUtilization >= 0.6);
  assert(target.metrics.avgWindowUtilization > 0);
  assert(target.metrics.avgWindowUtilization <= 1);
  assert(target.metrics.avgSavingsRatio >= 0.99);
  assert.equal(target.metrics.totalOmittedRequiredFileCount, target.cases.reduce((sum, item) => sum + item.omittedRequiredFileCount, 0));
  assert.equal(target.metrics.totalMissingGoldFileCount, 0);
  assert(target.metrics.durationMs >= 0);
  assert(target.cases.every((item) => Array.isArray(item.omittedRequiredFiles) && Number.isInteger(item.omittedRequiredFileCount)));
  assert(target.cases.every((item) => Array.isArray(item.missingGoldFiles) && item.missingGoldFileCount === 0));
  assert(target.cases.every((item) => Array.isArray(item.requiredFileDiagnostics)));
  assert(target.cases.flatMap((item) => item.requiredFileDiagnostics).every((item) => (
    typeof item.filePath === 'string' &&
    ['missing_gold_file', 'not_generated', 'generated_excluded', 'generated_not_selected'].includes(item.status) &&
    Array.isArray(item.reasonCodes)
  )));
  assert(target.cases.every((item) => item.windowUtilization >= 0 && item.windowUtilization <= 1));
  assert(target.cases.every((item) => item.durationMs >= 0));
  assert(!JSON.stringify(report).includes('export function'));
});

test('context recall eval scores anonymous baseline results against the same gate', () => {
  const report = runContextRecall([
    '--dataset',
    'evals/context-recall/oaf-repo-gold.v1.json',
    '--mode',
    'compiler-code-search',
    '--mode',
    'external-baseline-json',
    '--baseline-results',
    'tests/fixtures/context-recall-external-baseline.json',
    '--budgets',
    '8000'
  ]);

  assert.equal(report.gateDecision, 'pass');
  assert.equal(report.mode, 'external-baseline-json');
  assert.equal(report.baselineId, 'external-baseline-a');
  assert.equal(report.gate.budget, 8000);
  assert.equal(report.gate.minPassingBudget, 8000);
  assert(report.suiteDurationMs >= 0);

  const target = report.results.find((item) => item.budget === 8000);
  assert.equal(target.metrics.hitRate, 1);
  assert.equal(target.metrics.avgFileRecall, 1);
  assert(target.metrics.avgReturnedTokens <= 8000);
  assert(target.metrics.avgWindowUtilization > 0);
  assert(target.metrics.avgWindowUtilization <= 1);
  assert(target.metrics.avgSavingsRatio >= 0.99);
  assert.equal(target.metrics.totalOmittedRequiredFileCount, 0);
  assert.equal(target.metrics.totalMissingGoldFileCount, 0);
  assert(target.metrics.durationMs >= 0);
  assert(target.cases.every((item) => item.omittedRequiredFileCount === 0));
  assert(target.cases.every((item) => item.missingGoldFileCount === 0));
  assert(target.cases.every((item) => item.windowUtilization >= 0 && item.windowUtilization <= 1));
  assert(!JSON.stringify(report).includes('export function'));
});

test('context recall eval fails closed when gold files are not in the corpus', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaf-context-recall-missing-gold-'));
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  writeFileSync(path.join(root, 'docs', 'keep.md'), 'alphauniquemarker');
  writeFileSync(path.join(root, 'docs', 'side.md'), 'Completely unrelated archive.');
  spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' });
  spawnSync('git', ['add', 'docs/keep.md', 'docs/side.md'], { cwd: root, encoding: 'utf8' });
  const datasetPath = path.join(root, 'dataset.json');
  writeFileSync(datasetPath, JSON.stringify({
    id: 'evalds_missing_gold_file',
    suite: 'context-recall',
    targetBudget: 2000,
    thresholds: {
      hitRateMin: 0,
      avgFileRecallMin: 0,
      avgReturnedTokensMax: 2000,
      avgSavingsRatioMin: -10
    },
    cases: [
      {
        id: 'ctxrec_missing_gold_file',
        query: 'alphauniquemarker',
        goldFiles: ['docs/keep.md', 'docs/side.md', 'docs/renamed-away.md']
      }
    ]
  }, null, 2));

  const result = runContextRecallRaw([
    '--root',
    root,
    '--dataset',
    datasetPath,
    '--mode',
    'lexical-pack',
    '--budgets',
    '2000'
  ]);
  const report = JSON.parse(result.stdout);

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.deepEqual(report.gate.failures, ['missing_gold_files']);
  assert.equal(report.results[0].metrics.totalMissingGoldFileCount, 1);
  assert.deepEqual(report.results[0].cases[0].missingGoldFiles, ['docs/renamed-away.md']);
  assert.deepEqual(report.results[0].cases[0].requiredFileDiagnostics.map((item) => [item.filePath, item.status]), [
    ['docs/renamed-away.md', 'missing_gold_file'],
    ['docs/side.md', 'not_generated']
  ]);
});

test('context recall eval falls back to package file walk outside git metadata', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaf-context-recall-package-'));
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  mkdirSync(path.join(root, '.local'), { recursive: true });
  writeFileSync(path.join(root, 'docs', 'fallback.md'), 'Package archive fallback unique retrieval marker.');
  writeFileSync(path.join(root, '.local', 'state.json'), '{"private":"Package archive fallback unique retrieval marker"}');
  const datasetPath = path.join(root, 'dataset.json');
  writeFileSync(datasetPath, JSON.stringify({
    id: 'evalds_package_archive_fallback',
    suite: 'context-recall',
    targetBudget: 2000,
    thresholds: {
      hitRateMin: 1,
      avgFileRecallMin: 1,
      avgReturnedTokensMax: 2000,
      avgSavingsRatioMin: -10
    },
    cases: [
      {
        id: 'ctxrec_package_archive_fallback',
        query: 'Package archive fallback unique retrieval marker',
        goldFiles: ['docs/fallback.md']
      }
    ]
  }, null, 2));

  const report = runContextRecall([
    '--root',
    root,
    '--dataset',
    datasetPath,
    '--mode',
    'lexical-pack',
    '--budgets',
    '2000'
  ]);

  assert.equal(report.gateDecision, 'pass');
  assert.equal(report.corpus.trackedTextFiles, 1);
  const body = JSON.stringify(report);
  assert.match(body, /docs\/fallback\.md/);
  assert.doesNotMatch(body, /\.local\/state\.json/);
});

test('context recall eval ignores tracked local tool directories', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaf-context-recall-git-tools-'));
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  mkdirSync(path.join(root, '.claude'), { recursive: true });
  writeFileSync(path.join(root, 'docs', 'keep.md'), 'Tracked corpus keep marker.');
  writeFileSync(path.join(root, '.claude', 'CLAUDE.md'), 'Tracked corpus keep marker should not leak from tool config.');
  spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' });
  spawnSync('git', ['add', 'docs/keep.md', '.claude/CLAUDE.md'], { cwd: root, encoding: 'utf8' });
  const datasetPath = path.join(root, 'dataset.json');
  writeFileSync(datasetPath, JSON.stringify({
    id: 'evalds_git_tool_dir_exclusion',
    suite: 'context-recall',
    targetBudget: 2000,
    thresholds: {
      hitRateMin: 1,
      avgFileRecallMin: 1,
      avgReturnedTokensMax: 2000,
      avgSavingsRatioMin: -10
    },
    cases: [
      {
        id: 'ctxrec_git_tool_dir_exclusion',
        query: 'Tracked corpus keep marker',
        goldFiles: ['docs/keep.md']
      }
    ]
  }, null, 2));

  const report = runContextRecall([
    '--root',
    root,
    '--dataset',
    datasetPath,
    '--mode',
    'lexical-pack',
    '--budgets',
    '2000'
  ]);

  assert.equal(report.gateDecision, 'pass');
  assert.equal(report.corpus.trackedTextFiles, 1);
  assert.deepEqual(report.results[0].cases[0].selectedPaths, ['docs/keep.md']);
  assert.doesNotMatch(JSON.stringify(report), /\.claude\/CLAUDE\.md/);
});
