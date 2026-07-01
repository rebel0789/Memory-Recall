import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

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
  assert.deepEqual(report.results.map((item) => item.budget), [8000, 12000]);

  const target = report.results.find((item) => item.budget === 8000);
  assert.equal(target.metrics.hitRate, 1);
  assert(target.metrics.avgFileRecall >= 0.7);
  assert(target.metrics.avgReturnedTokens <= 8000);
  assert(target.metrics.avgSavingsRatio >= 0.99);
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

  const target = report.results.find((item) => item.budget === 8000);
  assert.equal(target.metrics.hitRate, 1);
  assert.equal(target.metrics.avgFileRecall, 1);
  assert(target.metrics.avgReturnedTokens <= 8000);
  assert(target.metrics.avgSavingsRatio >= 0.99);
  assert(!JSON.stringify(report).includes('export function'));
});
