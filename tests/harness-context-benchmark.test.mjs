import test from 'node:test';
import assert from 'node:assert/strict';
import { runHarnessContextBenchmarks } from '../packages/harness-context/src/index.mjs';

const fixedClock = () => '2026-06-23T00:00:00.000Z';

const dataset = {
  schemaVersion: '1.0.0',
  thresholds: {
    requiredLocatorRecall: 1,
    distractorExclusionRate: 0.9,
    selectedTokenRatioMax: 0.65,
    caseDurationMsMax: 1000,
    suiteDurationMsMax: 5000
  },
  cases: [
    {
      id: 'codex-required-context-with-large-distractors',
      harnesses: ['codex', 'claude-code', 'cursor'],
      objective: 'context manifest compiler token efficiency',
      step: 'select deterministic preview guidance',
      tokenBudget: 90,
      files: [
        {
          path: 'AGENTS.md',
          body: 'Context manifest compiler guidance: use deterministic preview, selected/excluded locators, and token efficiency gates.'
        },
        {
          path: 'CLAUDE.md',
          body: 'Unrelated onboarding palette discussion. '.repeat(80)
        },
        {
          path: '.cursor/rules/private.mdc',
          body: 'API_KEY=secret-value\nA private local instruction at /Users/rebel/private.txt should not appear.'
        }
      ],
      expect: {
        selectedLocators: ['workspace://AGENTS.md'],
        excludedLocators: ['workspace://CLAUDE.md', 'workspace://.cursor/rules/private.mdc'],
        forbiddenStrings: ['Context manifest compiler guidance', 'secret-value', '/Users/rebel/private.txt']
      }
    },
    {
      id: 'cursor-required-rule-with-noisy-codex-file',
      harnesses: ['codex', 'cursor'],
      objective: 'cursor rule safe handoff token budget',
      step: 'select cursor handoff preview rule',
      tokenBudget: 90,
      files: [
        {
          path: 'AGENTS.md',
          body: 'Large unrelated release checklist. '.repeat(90)
        },
        {
          path: '.cursor/rules/handoff.mdc',
          body: 'Cursor handoff preview rule: keep harness output proposal-only and include selected locator hashes.'
        },
        {
          path: '.cursorrules',
          body: 'General formatting note without matching selector vocabulary. '.repeat(40)
        }
      ],
      expect: {
        selectedLocators: ['workspace://.cursor/rules/handoff.mdc'],
        excludedLocators: ['workspace://AGENTS.md', 'workspace://.cursorrules'],
        forbiddenStrings: ['Cursor handoff preview rule', 'Large unrelated release checklist']
      }
    }
  ]
};

test('harness context benchmark proves recall, exclusion, leakage, and token gates', async () => {
  const result = await runHarnessContextBenchmarks(dataset, { clock: fixedClock });

  assert.equal(result.passed, true);
  assert.equal(result.metrics.requiredLocatorRecall, 1);
  assert(result.metrics.distractorExclusionRate >= 0.9);
  assert(result.metrics.selectedTokenRatio <= 0.65);
  assert.equal(result.metrics.secretLeakageCount, 0);
  assert.equal(result.metrics.localPathLeakageCount, 0);
  assert.equal(result.metrics.rawBodyLeakageCount, 0);
  assert.equal(result.metrics.activeMemoryCreated, 0);
  assert.equal(result.metrics.sourceSnapshotsWritten, 0);
  assert.equal(result.metrics.modelCalls, 0);
  assert.equal(result.metrics.networkCalls, 0);
  assert.equal(result.metrics.externalAdaptersEnabled, 0);
  assert.equal(result.metrics.externalWritesEnabled, false);
  assert.equal(result.metrics.deterministicMismatchCount, 0);
  assert.equal(result.cases.length, 2);
  assert(result.cases.every((item) => item.passed));
  assert(!JSON.stringify(result).includes('secret-value'));
  assert(!JSON.stringify(result).includes('/Users/rebel'));
});

test('harness context benchmark fails closed when a required locator is not selected', async () => {
  const failing = structuredClone(dataset);
  failing.cases[0].expect.selectedLocators = ['workspace://missing.md'];

  const result = await runHarnessContextBenchmarks(failing, { clock: fixedClock });

  assert.equal(result.passed, false);
  assert(result.metrics.requiredLocatorRecall < 1);
  assert(result.cases.some((item) => item.id === 'codex-required-context-with-large-distractors' && !item.passed));
});
