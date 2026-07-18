import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const RUNNER = path.join(ROOT, 'scripts', 'code-intelligence-phase8-gitnexus.mjs');
const BINARY = path.join(ROOT, 'rust', 'target', 'release', process.platform === 'win32' ? 'oaf.exe' : 'oaf');
const UPSTREAM_SHA = '91955e657639cdf3a098162a2a632b505a563ffa';

test('Phase 8 runner gates GitNexus by license and emits a sanitized measured Go receipt', { timeout: 120_000 }, async (t) => {
  if (process.platform === 'win32') return t.skip('fake executable fixture uses a POSIX shebang');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-phase8-test-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const fake = path.join(temporary, 'gitnexus');
  const log = path.join(temporary, 'calls.jsonl');
  await writeFile(fake, `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.MEMORY_RECALL_PHASE8_FAKE_LOG, JSON.stringify({ args, home: process.env.HOME, cwd: process.cwd() }) + '\\n');
if (args[0] === '--version') process.stdout.write('1.6.9\\n');
else if (args[0] === 'analyze') {
  mkdirSync(path.join(args[1], '.gitnexus'), { recursive: true });
  writeFileSync(path.join(args[1], '.gitnexus', 'index.bin'), 'fixture-index');
  process.stdout.write('indexed\\n');
} else if (args[0] === 'cypher') {
  const query = args[1];
  const absent = query.includes("type: 'CALLS'") && query.includes("a.name = 'Register'") && query.includes("b.name = 'Item'");
  const invalidImport = query.includes("type: 'IMPORTS'") && (query.includes('api_routes') || query.includes('service_service'));
  const invalidRoute = query.includes('handlerSymbolId') && !(query.includes("b.name = '/items/:item_id'") || query.includes("b.name = '/legacy/{item_id}'"));
  process.stdout.write(JSON.stringify({ markdown: '', row_count: absent || invalidImport || invalidRoute ? 0 : 1 }) + '\\n');
} else process.exit(3);
`);
  await chmod(fake, 0o755);

  const invalid = run(['--gitnexus-cli']);
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stderr, '');
  assert.equal(invalid.report.runs.gitnexus.failure.code, 'arguments_invalid');

  const unavailable = run([
    '--gitnexus-cli', fake,
    '--gitnexus-version', '1.6.9',
    '--gitnexus-sha', UPSTREAM_SHA
  ], { MEMORY_RECALL_PHASE8_FAKE_LOG: log });
  assert.equal(unavailable.status, 2);
  assert.equal(unavailable.report.status, 'unavailable');
  assert.equal(unavailable.report.runs.gitnexus.failure.code, 'license_acknowledgement_missing');
  assert.equal(await exists(log), false, 'missing acknowledgement must not execute GitNexus');

  const measured = run([
    '--gitnexus-cli', fake,
    '--gitnexus-version', '1.6.9',
    '--gitnexus-sha', UPSTREAM_SHA,
    '--license-acknowledgement', 'noncommercial-or-separately-authorized',
    '--memory-recall-binary', BINARY
  ], { MEMORY_RECALL_PHASE8_FAKE_LOG: log });
  assert.equal(measured.status, 0, measured.stderr);
  assert.equal(measured.report.status, 'measured');
  assert.equal(measured.report.runs.memoryRecall.status, 'measured');
  assert.equal(measured.report.runs.gitnexus.status, 'measured');
  assert.equal(measured.report.runs.gitnexus.product.version, '1.6.9');
  assert.deepEqual(measured.report.runs.gitnexus.product.upstreamSha, {
    value: UPSTREAM_SHA,
    verification: 'caller-supplied-unverified'
  });
  assert.equal(measured.report.runs.gitnexus.evaluation.metrics.unavailableTruthItemCount, 1);
  assert.equal(measured.report.runs.gitnexus.evaluation.metrics.relationshipRecall.denominator, 4);
  assert.equal(measured.report.runs.gitnexus.evaluation.metrics.parseFailureCount, null);
  assert.equal(measured.report.claims.parity, false);
  assert.equal(measured.report.claims.leadership, false);
  assert.equal(measured.report.gateDecision, 'fail');
  assert.equal(measured.report.gates[0].status, 'fail');
  assert.equal(measured.report.safeguards.competitorHomeIsolated, true);
  assert.equal(measured.report.safeguards.competitorRepositoryDisposable, true);
  assert.match(measured.report.structuralFingerprint, /^sha256:[a-f0-9]{64}$/u);
  assert.match(measured.report.reportFingerprint, /^sha256:[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(measured.report), /(?:\/Users\/|\/private\/|\/var\/folders\/)/u);
  assert.equal(measured.report.runs.gitnexus.commands.every((command) => !JSON.stringify(command).includes(temporary)), true);

  const repeated = run([
    '--gitnexus-cli', fake,
    '--gitnexus-version', '1.6.9',
    '--gitnexus-sha', UPSTREAM_SHA,
    '--license-acknowledgement', 'noncommercial-or-separately-authorized',
    '--memory-recall-binary', BINARY
  ], { MEMORY_RECALL_PHASE8_FAKE_LOG: log });
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(repeated.report.structuralFingerprint, measured.report.structuralFingerprint);

  const calls = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(calls[1].args[0], 'analyze');
  assert.equal(normalizeTemporaryPath(calls[1].args[1]), normalizeTemporaryPath(calls[1].cwd));
  assert.equal(calls[1].args.includes('--index-only'), true);
  assert.equal(calls[1].args.includes('--skip-git'), true);
  assert.notEqual(calls[1].home, os.homedir());
  const queries = calls.filter(({ args }) => args[0] === 'cypher').map(({ args }) => args[1]);
  const measuredQueryCount = measured.report.runs.gitnexus.evaluation.metrics.truthItemCount
    - measured.report.runs.gitnexus.evaluation.metrics.unavailableTruthItemCount;
  assert.equal(queries.length, measuredQueryCount * 2, 'measured and repeated runs query every supported truth item');
  assert.equal(queries.filter((query) => query.includes("type: 'IMPORTS'")).every((query) => !query.includes('api_routes') && !query.includes('service_service')), true);
  assert.equal(queries.filter((query) => query.includes('handlerSymbolId')).every((query) => query.includes("b.name = '/items/:item_id'") || query.includes("b.name = '/legacy/{item_id}'")), true);

  function run(args, extraEnvironment = {}) {
    const result = spawnSync(process.execPath, [RUNNER, ...args], {
      cwd: ROOT,
      env: { ...process.env, OAF_FIXED_NOW: '2026-07-17T00:00:00.000Z', ...extraEnvironment },
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024
    });
    return { status: result.status, stderr: result.stderr, report: JSON.parse(result.stdout) };
  }
});

async function exists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeTemporaryPath(filePath) {
  return path.normalize(filePath).replace(/^\/private(?=\/var\/)/u, '');
}
