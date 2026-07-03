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
  assert(target.metrics.avgWindowUtilization > 0);
  assert(target.metrics.avgWindowUtilization <= 1);
  assert(target.metrics.avgSavingsRatio >= 0.99);
  assert.equal(target.metrics.totalOmittedRequiredFileCount, target.cases.reduce((sum, item) => sum + item.omittedRequiredFileCount, 0));
  assert(target.metrics.durationMs >= 0);
  assert(target.cases.every((item) => Array.isArray(item.omittedRequiredFiles) && Number.isInteger(item.omittedRequiredFileCount)));
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
  assert(target.metrics.durationMs >= 0);
  assert(target.cases.every((item) => item.omittedRequiredFileCount === 0));
  assert(target.cases.every((item) => item.windowUtilization >= 0 && item.windowUtilization <= 1));
  assert(!JSON.stringify(report).includes('export function'));
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
      avgSavingsRatioMin: -2
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
