import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import contextPackMeasurementReportSchema from '../packages/protocol/schemas/context-pack-measurement-report.schema.json' with { type: 'json' };
import { assertJsonSchema } from '../packages/protocol/src/schema-validator.mjs';

function runMeasure(args, { env = process.env } = {}) {
  return spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'measure', 'context-pack', ...args], {
    encoding: 'utf8',
    env
  });
}

function baseArgs(root) {
  return [
    '--read-only',
    '--root',
    root,
    '--from',
    'codex',
    '--objective',
    'Private measurement objective',
    '--step',
    'measure context impact',
    '--target',
    'codex',
    '--format',
    'json'
  ];
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('measure context-pack fails closed for writing, ambiguous, and unsupported modes', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaf-cli-measure-guard-'));
  writeFileSync(path.join(root, 'AGENTS.md'), 'Measurement guard test instructions.');
  const env = { ...process.env, OAF_FIXED_NOW: '2026-06-25T00:00:00.000Z' };

  const cases = [
    {
      args: [...baseArgs(root), '--pin'],
      stderr: /read-only/
    },
    {
      args: [...baseArgs(root), '--use-out', 'context-packs/CONTEXT_PACK.use.json'],
      stderr: /read-only/
    },
    {
      args: [...baseArgs(root), '--stdio'],
      stderr: /not accepted/
    },
    {
      args: [...baseArgs(root), '--dry-run'],
      stderr: /not accepted/
    },
    {
      args: [...baseArgs(root).slice(0, -2), '--format', 'markdown'],
      stderr: /only supports --format json or summary/
    },
    {
      args: ['--read-only', '--root', root, '--from', 'codex', '--step', 'measure context impact', '--format', 'json'],
      stderr: /requires --objective/
    },
    {
      args: ['--read-only', '--root', root, '--from', 'codex', '--objective', 'Private measurement objective', '--format', 'json'],
      stderr: /requires --objective/
    },
    {
      args: [...baseArgs(root), '--changed-from', 'filesystem'],
      stderr: /only supports --changed-from git/
    },
    {
      args: [...baseArgs(root), '--mystery-flag'],
      stderr: /unsupported option: --mystery-flag/
    }
  ];

  for (const item of cases) {
    const result = runMeasure(item.args, { env });
    assert.equal(result.status, 2, item.args.join(' '));
    assert.match(result.stderr, item.stderr);
    assert.equal(result.stdout, '');
  }
});

test('measure context-pack summary renders operator proof without raw bodies or paths', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaf-cli-measure-summary-'));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'AGENTS.md'), 'Summary measurement instructions. SUMMARY AGENTS RAW BODY should stay hidden.');
  writeFileSync(path.join(root, 'src', 'auth.ts'), [
    'export function summaryMeasureSymbol() {',
    "  return 'SUMMARY MEASURE RAW BODY';",
    '}'
  ].join('\n'));

  const env = { ...process.env, OAF_FIXED_NOW: '2026-06-25T00:00:00.000Z', OAF_COMMIT_SHA: 'summary-test-sha' };
  const args = [...baseArgs(root).slice(0, -2), '--changed', 'src/auth.ts', '--format', 'summary'];
  const result = runMeasure(args, { env });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# Context Pack Measurement/m);
  assert.match(result.stdout, /Target harness: codex/);
  assert.match(result.stdout, /## Token Saver/);
  assert.match(result.stdout, /Practical baseline units:/);
  assert.match(result.stdout, /Saved units:/);
  assert.match(result.stdout, /Provider billing claimed: no/);
  assert.match(result.stdout, /Observed delivery reduction:/);
  assert.match(result.stdout, /Delivery budget status:/);
  assert.match(result.stdout, /Changed source tokens included: 0/);
  assert.match(result.stdout, /## Source Graph/);
  assert.match(result.stdout, /Files indexed:/);
  assert.match(result.stdout, /Symbols indexed:/);
  assert.match(result.stdout, /Affected symbols:/);
  assert.match(result.stdout, /MCP Readback/);
  assert.match(result.stdout, /Fingerprint match: pass/);
  assert.match(result.stdout, /Network calls: 0/);
  assert.match(result.stdout, /Model calls: 0/);
  assert.match(result.stdout, /Local files written: 0/);
  assert.match(result.stdout, /Raw source bodies included: no/);
  assert.equal(result.stdout.includes('SUMMARY MEASURE RAW BODY'), false);
  assert.equal(result.stdout.includes('SUMMARY AGENTS RAW BODY'), false);
  assert.equal(result.stdout.includes(root), false);
  assert.equal(result.stdout.includes('/Users/'), false);
  assert.equal(result.stdout.includes('Private measurement objective'), false);
  assert.equal(existsSync(path.join(root, 'context-packs')), false);
});

test('measure context-pack records read-only git changed-file detection against the measured root', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaf-cli-measure-git-'));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'AGENTS.md'), 'Git measurement instructions. GIT MEASURE AGENTS RAW BODY should stay hidden.');
  writeFileSync(path.join(root, 'src', 'auth.ts'), [
    'export function gitMeasureSymbol() {',
    "  return 'baseline';",
    '}'
  ].join('\n'));

  git(root, ['init']);
  git(root, ['-c', 'user.name=OAF Test', '-c', 'user.email=oaf@example.invalid', 'add', 'AGENTS.md', 'src/auth.ts']);
  git(root, ['-c', 'user.name=OAF Test', '-c', 'user.email=oaf@example.invalid', 'commit', '-m', 'baseline']);
  const expectedSha = git(root, ['rev-parse', 'HEAD']);

  writeFileSync(path.join(root, 'src', 'auth.ts'), [
    'export function gitMeasureSymbol() {',
    "  return 'GIT MEASURE RAW BODY';",
    '}',
    '',
    'export function gitMeasureChangedSymbol() {',
    "  return 'changed';",
    '}'
  ].join('\n'));

  const env = { ...process.env, OAF_FIXED_NOW: '2026-06-25T00:00:00.000Z' };
  delete env.OAF_COMMIT_SHA;
  const result = runMeasure([...baseArgs(root), '--changed-from-git'], { env });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assertJsonSchema(contextPackMeasurementReportSchema, report, 'context pack measurement report');
  assert.equal(report.command, 'measure context-pack');
  assert.equal(report.commitSha, expectedSha);
  assert.equal(report.request.changedFromGit, true);
  assert.equal(report.request.changedLocatorCount >= 1, true);
  assert.equal(report.impactBrief.request.changedLocatorSource, 'git-status-porcelain');
  assert.equal(report.impactBrief.impact.changedLocators.includes('workspace://src/auth.ts'), true);
  assert.equal(report.impactBrief.impact.representedChangedLocators.includes('workspace://src/auth.ts'), true);
  assert.equal(report.contextPack.changedLocatorCoverage.status, 'covered');
  assert.equal(report.contextPack.changedSourceBudget.locatorCount, 1);
  assert.equal(report.contextPack.changedSourceBudget.sourceContentIncluded, false);
  assert.equal(report.contextPack.changedSourceBudget.observedAvoidanceRatio, 1);
  assert.equal(report.tokenSaver.basis, 'selected-context-plus-changed-source-resend');
  assert.equal(report.tokenSaver.selectedUnitCount, report.contextPack.selectedUnitCount);
  assert.equal(report.tokenSaver.changedSourceUnitCount, report.contextPack.changedSourceBudget.contentTokenCount);
  assert.equal(report.tokenSaver.changedSourceUnitCountIncluded, 0);
  assert.equal(report.tokenSaver.baselineUnitCount, report.contextPack.selectedUnitCount + report.contextPack.changedSourceBudget.contentTokenCount);
  assert.equal(report.tokenSaver.deliveredUnitCount, report.contextPack.deliveredUnitCount);
  assert.equal(report.tokenSaver.savedUnitCount, Math.max(0, report.tokenSaver.baselineUnitCount - report.tokenSaver.deliveredUnitCount));
  assert.equal(report.tokenSaver.sourceContentIncluded, false);
  assert.equal(report.tokenSaver.providerBillingClaimed, false);
  assert.equal(report.mcpReadback.transport, 'stdio');
  assert.equal(report.mcpReadback.toolsExposed, 0);
  assert.equal(report.checks.contextPackFingerprintMatchesMcp, true);
  assert.equal(report.checks.noToolsExposed, true);
  assert.equal(report.safeguards.readOnly, true);
  assert.equal(report.safeguards.localFilesWritten, 0);
  assert.equal(report.safeguards.externalWritesEnabled, false);
  assert.equal(report.safeguards.externalAdaptersEnabled, 0);
  assert.equal(report.safeguards.networkCalls, 0);
  assert.equal(report.safeguards.modelCalls, 0);
  assert.equal(result.stdout.includes('GIT MEASURE RAW BODY'), false);
  assert.equal(result.stdout.includes('GIT MEASURE AGENTS RAW BODY'), false);
  assert.equal(result.stdout.includes(root), false);
  assert.equal(result.stdout.includes('/Users/'), false);
  assert.equal(existsSync(path.join(root, 'context-packs')), false);
});

test('measure context-pack reports explicit changed files sanely when git has no changes', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaf-cli-measure-explicit-clean-'));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'AGENTS.md'), 'Explicit clean repo measurement instructions.');
  writeFileSync(path.join(root, 'src', 'auth.ts'), 'export function explicitCleanSymbol() { return true; }\n');

  git(root, ['init']);
  git(root, ['-c', 'user.name=OAF Test', '-c', 'user.email=oaf@example.invalid', 'add', 'AGENTS.md', 'src/auth.ts']);
  git(root, ['-c', 'user.name=OAF Test', '-c', 'user.email=oaf@example.invalid', 'commit', '-m', 'baseline']);

  const env = { ...process.env, OAF_FIXED_NOW: '2026-06-25T00:00:00.000Z' };
  const result = runMeasure([...baseArgs(root), '--changed-from-git', '--changed', 'src/auth.ts'], { env });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.largeContext.source, 'explicit');
  assert.equal(report.largeContext.changedLocatorShardCount, 1);
  assert.equal(report.largeContext.totalChangedLocatorCount, 1);
  assert.equal(report.largeContext.measuredChangedLocatorCount, 1);
  assert.equal(report.largeContext.allChangesMeasured, true);
  assert.equal(report.impactBrief.request.changedLocatorSource, 'explicit');
});

test('measure context-pack can inspect a later git changed-file shard', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaf-cli-measure-git-shard-'));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'AGENTS.md'), 'Shard measurement instructions.');

  git(root, ['init']);
  git(root, ['-c', 'user.name=OAF Test', '-c', 'user.email=oaf@example.invalid', 'add', 'AGENTS.md']);
  git(root, ['-c', 'user.name=OAF Test', '-c', 'user.email=oaf@example.invalid', 'commit', '-m', 'baseline']);

  for (let index = 0; index < 20; index += 1) {
    writeFileSync(path.join(root, 'src', `shard-${String(index).padStart(2, '0')}.ts`), `export const shard${index}=true;\n`);
  }

  const env = { ...process.env, OAF_FIXED_NOW: '2026-06-25T00:00:00.000Z' };
  const result = runMeasure([...baseArgs(root), '--changed-from-git', '--changed-shard', '2'], { env });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assertJsonSchema(contextPackMeasurementReportSchema, report, 'context pack measurement report');
  assert.equal(report.largeContext.changedLocatorShard, 2);
  assert.equal(report.largeContext.changedLocatorShardSize, 16);
  assert.equal(report.largeContext.totalChangedLocatorCount, 20);
  assert.equal(report.largeContext.measuredChangedLocatorCount, 4);
  assert.equal(report.largeContext.omittedBeforeCount, 16);
  assert.equal(report.largeContext.omittedAfterCount, 0);
  assert.equal(report.largeContext.allChangesMeasured, false);
  assert.equal(report.request.changedLocatorCount, 4);
  assert.equal(report.impactBrief.impact.changedLocators.every((locator) => /shard-1[6-9]\.ts/u.test(locator)), true);
});

test('measure context-pack all-shards summarizes every git changed-file shard', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaf-cli-measure-git-all-shards-'));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'AGENTS.md'), 'All shard measurement instructions.');

  git(root, ['init']);
  git(root, ['-c', 'user.name=OAF Test', '-c', 'user.email=oaf@example.invalid', 'add', 'AGENTS.md']);
  git(root, ['-c', 'user.name=OAF Test', '-c', 'user.email=oaf@example.invalid', 'commit', '-m', 'baseline']);

  for (let index = 0; index < 20; index += 1) {
    writeFileSync(path.join(root, 'src', `all-${String(index).padStart(2, '0')}.ts`), `export const allShard${index}='ALL_SHARDS_RAW_BODY_${index}';\n`);
  }

  const env = { ...process.env, OAF_FIXED_NOW: '2026-06-25T00:00:00.000Z' };
  const result = runMeasure([...baseArgs(root).slice(0, -2), '--changed-from-git', '--all-shards', '--format', 'summary'], { env });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# Context Pack Measurement All Shards/m);
  assert.match(result.stdout, /Shards measured: 2 \/ 2/);
  assert.match(result.stdout, /Changed locators measured: 20 \/ 20/);
  assert.match(result.stdout, /Provider billing claimed: no/);
  assert.doesNotMatch(result.stdout, /ALL_SHARDS_RAW_BODY_/);
  assert.equal(result.stdout.includes(root), false);
  assert.equal(result.stdout.includes('/Users/'), false);
});
