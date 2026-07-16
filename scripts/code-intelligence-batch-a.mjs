import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { evaluateCodeIntelligenceLanguage } from '../packages/protocol/src/code-intelligence-evaluation.mjs';
import { RustCodeIntelligenceProvider } from '../providers/native/code-intelligence-rust/src/index.mjs';

const execFileAsync = promisify(execFile);
const OUTPUT = 'evals/code-intelligence/results/phase2-batch-a.json';
const BOUNDS = Object.freeze({ maxFiles: 5_000, maxFileBytes: 512 * 1024, maxNodes: 5_000, maxEdges: 10_000 });
const REPOSITORY_SCOPES = Object.freeze({
  cirepo_typescript_microsoft_typescript: 'src/compiler/transformers',
  cirepo_typescript_microsoft_vscode: 'src/vs/base/common',
  cirepo_typescript_vercel_next_js: 'packages/next/src/server/route-modules/app-route',
  cirepo_javascript_axios_axios: 'lib/core',
  cirepo_javascript_expressjs_express: 'lib',
  cirepo_javascript_lodash_lodash: '.'
});
const mode = parseMode(process.argv.slice(2));
const root = process.cwd();
const temporary = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-batch-a-fixtures-'));

try {
  const nativeBinary = path.resolve(root, 'rust', 'target', 'release', process.platform === 'win32' ? 'oaf.exe' : 'oaf');
  if (!(await stat(nativeBinary)).isFile()) throw new Error('batch_a_native_release_binary_missing');
  const corpus = await readJson('evals/code-intelligence/corpus.v1.json');
  const gates = await readJson('evals/code-intelligence/benchmark-gates.v1.json');
  const fixtures = await materializeFixtures(temporary);
  const repositories = [];
  for (const [id, scope] of mode === 'fixtures' ? [] : Object.entries(REPOSITORY_SCOPES)) {
    const repository = corpus.repositories.find((item) => item.id === id);
    if (!repository) throw new Error(`batch_a_repository_missing:${id}`);
    const truthPath = `evals/code-intelligence/truth/repositories/${repository.primaryLanguage}/${id}.json`;
    const truth = await readJson(truthPath);
    const checkout = await ensurePinnedRepository(repository);
    repositories.push({
      id,
      language: repository.primaryLanguage,
      root: path.resolve(checkout, scope),
      sourceClass: 'real-repo',
      sourceRef: `corpus://${id}@${repository.commit}#${scope}`,
      truth,
      truthPath,
      commit: repository.commit
    });
  }

  const provider = new RustCodeIntelligenceProvider({ binaryPath: nativeBinary, timeoutMs: 120_000 });
  const cases = [];
  for (const definition of [...fixtures, ...repositories]) cases.push(await runCase(definition, provider));
  const languages = ['javascript', 'typescript'].map((language) => aggregateLanguage(language, cases, gates.languageFull));
  const failures = cases.flatMap((item) => item.report.failures.map((failure) => ({ caseId: item.id, ...failure })));
  for (const language of languages.filter((item) => item.gateDecision === 'fail')) {
    failures.push({ caseId: language.language, code: 'language_accuracy_floor_not_met' });
  }
  const report = {
    schemaVersion: '1.0.0',
    reportVersion: 'memory-recall-code-intelligence-phase2-batch-a-1',
    phase: 2,
    batch: 'A',
    generatedAt: new Date().toISOString(),
    inputs: {
      corpusFingerprint: corpus.corpusFingerprint,
      bounds: BOUNDS,
      fixtureTruth: fixtures.map((item) => item.truthPath),
      repositoryTruth: repositories.map((item) => item.truthPath),
      repositoryRefs: repositories.map((item) => item.sourceRef)
    },
    thresholds: gates.languageFull,
    cases,
    languages,
    failures,
    gateDecision: failures.length === 0 ? 'pass' : 'fail',
    publicDefault: { engine: 'js', changed: false },
    claims: {
      accuracyFloorMet: languages.every((item) => item.gateDecision === 'pass'),
      parity: false,
      leadership: false,
      reason: 'Batch A measures reviewed JavaScript and TypeScript truth. It does not change the public engine or claim competitor parity.'
    },
    safeguards: {
      rawSourceStored: false,
      absoluteCheckoutPathsStored: false,
      environmentVariablesStored: false,
      engineNetworkCalls: 0,
      engineModelCalls: 0,
      canonicalMemoryWrites: 0,
      workspaceWrites: 0
    }
  };
  report.reportFingerprint = fingerprint(comparableReport(report));

  if (mode === 'fixtures') {
    const failed = cases.filter((item) => item.report.gateDecision !== 'pass');
    for (const item of failed) console.error(JSON.stringify({ id: item.id, report: item.report }, null, 2));
    if (failed.length > 0) throw new Error('batch_a_fixture_truth_failed');
    console.log(`Batch A fixture truth passed: ${cases.length} cases.`);
  } else if (mode === 'check') {
    const stored = await readJson(OUTPUT);
    if (JSON.stringify(comparableReport(stored)) !== JSON.stringify(comparableReport(report))) {
      throw new Error('batch_a_evidence_stale');
    }
    if (stored.reportFingerprint !== fingerprint(comparableReport(stored))) {
      throw new Error('batch_a_report_fingerprint_invalid');
    }
    console.log(`Batch A evidence is current: ${cases.length} cases, ${languages.length} languages.`);
  } else {
    await atomicWrite(OUTPUT, report);
    console.log(`Batch A evaluated ${cases.length} cases and wrote ${OUTPUT}.`);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function runCase(definition, provider) {
  if (definition.truth.source.ref !== definition.sourceRef) throw new Error(`batch_a_truth_source_mismatch:${definition.id}`);
  const before = await treeFingerprint(definition.root);
  const rssBefore = process.resourceUsage().maxRSS;
  const firstStarted = process.hrtime.bigint();
  const first = await provider.buildGraph({
    root: definition.root,
    workspaceId: 'ws_batch_a',
    ...BOUNDS,
    languages: [definition.language]
  });
  const firstElapsedMs = Number(process.hrtime.bigint() - firstStarted) / 1_000_000;
  const secondStarted = process.hrtime.bigint();
  const second = await provider.buildGraph({
    root: definition.root,
    workspaceId: 'ws_batch_a',
    ...BOUNDS,
    languages: [definition.language]
  });
  const secondElapsedMs = Number(process.hrtime.bigint() - secondStarted) / 1_000_000;
  const after = await treeFingerprint(definition.root);
  if (before !== after) throw new Error(`batch_a_workspace_changed:${definition.id}`);
  const evaluation = evaluateCodeIntelligenceLanguage({ truth: definition.truth, graphRuns: [first, second] });
  return {
    id: definition.id,
    language: definition.language,
    sourceClass: definition.sourceClass,
    sourceRef: definition.sourceRef,
    ...(definition.commit ? { commit: definition.commit } : {}),
    truthPath: definition.truthPath,
    graph: {
      fingerprint: first.graphFingerprint,
      nodeCount: first.nodes.length,
      edgeCount: first.edges.length,
      diagnosticCount: first.diagnostics.length,
      coverage: first.coverage
    },
    measurements: {
      firstElapsedMs: round(firstElapsedMs),
      secondElapsedMs: round(secondElapsedMs),
      evaluatorMaxRssKb: Math.max(rssBefore, process.resourceUsage().maxRSS),
      workspaceFingerprintUnchanged: true
    },
    report: evaluation
  };
}

function aggregateLanguage(language, cases, gates) {
  const selected = cases.filter((item) => item.language === language);
  const declaration = sumRatio(selected, 'declarationRecall');
  const relationships = sumRatio(selected, 'relationshipRecall');
  const calls = sumRatio(selected, 'reviewedCallPrecision');
  const duplicateCanonicalSymbolCount = sumMetric(selected, 'duplicateCanonicalSymbolCount');
  const parseFailureCount = sumMetric(selected, 'parseFailureCount');
  const deterministic = selected.every((item) => item.report.metrics.deterministicGraphFingerprint);
  const repositoryCount = selected.filter((item) => item.sourceClass === 'real-repo').length;
  const fixtureCount = selected.filter((item) => item.sourceClass === 'fixture').length;
  const gateDecision = selected.every((item) => item.report.gateDecision === 'pass')
    && fixtureCount >= 1
    && repositoryCount >= 3
    && declaration.value !== null
    && declaration.value >= gates.symbolRecallMinimum
    && relationships.value !== null
    && relationships.value >= gates.symbolRecallMinimum
    && calls.value !== null
    && calls.value >= gates.resolvedCallPrecisionMinimum
    && duplicateCanonicalSymbolCount === gates.duplicateCanonicalSymbolMaximum
    && parseFailureCount === gates.malformedFileRepositoryFailureMaximum
    && deterministic
    ? 'pass'
    : 'fail';
  return {
    language,
    caseCount: selected.length,
    fixtureCount,
    repositoryCount,
    metrics: { declarationRecall: declaration, relationshipRecall: relationships, reviewedCallPrecision: calls, duplicateCanonicalSymbolCount, parseFailureCount, deterministicGraphFingerprint: deterministic },
    gateDecision
  };
}

function sumRatio(cases, metric) {
  const numerator = cases.reduce((sum, item) => sum + item.report.metrics[metric].numerator, 0);
  const denominator = cases.reduce((sum, item) => sum + item.report.metrics[metric].denominator, 0);
  return { numerator, denominator, value: denominator === 0 ? null : round(numerator / denominator, 6) };
}

function sumMetric(cases, metric) {
  return cases.reduce((sum, item) => sum + item.report.metrics[metric], 0);
}

async function materializeFixtures(directory) {
  const typescript = path.join(directory, 'typescript');
  const javascript = path.join(directory, 'javascript');
  await mkdir(path.join(typescript, 'src'), { recursive: true });
  await mkdir(path.join(javascript, 'routes'), { recursive: true });
  await writeFile(path.join(typescript, 'src', 'helper.ts'), 'export function helper(value: number): number { return value + 1; }\n');
  await writeFile(path.join(typescript, 'src', 'index.ts'), [
    "import { helper } from './helper.js';",
    'export interface Result { value: number }',
    'export function main(value: number): Result { return { value: helper(value) }; }',
    ''
  ].join('\n'));
  await writeFile(path.join(javascript, 'helper.js'), 'export function helper(value) { return value + 1; }\n');
  await writeFile(path.join(javascript, 'routes', 'health.js'), [
    "import { helper } from '../helper.js';",
    "export function health() { return { ok: helper(0) === 1 }; }",
    ''
  ].join('\n'));
  return Promise.all([
    fixtureDefinition('typescript', typescript, 'fixture_typescript_import_call'),
    fixtureDefinition('javascript', javascript, 'fixture_javascript_import_call')
  ]);
}

async function fixtureDefinition(language, fixtureRoot, id) {
  const truthPath = `evals/code-intelligence/truth/fixtures/${language}.json`;
  const truth = await readJson(truthPath);
  return { id, language, root: fixtureRoot, sourceClass: 'fixture', sourceRef: truth.source.ref, truth, truthPath };
}

async function ensurePinnedRepository(repository) {
  const directory = path.join(os.tmpdir(), 'memory-recall-code-intelligence-corpus-v1', repository.id);
  await mkdir(directory, { recursive: true });
  if (!(await exists(path.join(directory, '.git')))) {
    await command('git', ['init', '--quiet'], { cwd: directory });
    await command('git', ['remote', 'add', 'origin', repository.url], { cwd: directory });
  }
  let present = false;
  try {
    await command('git', ['cat-file', '-e', `${repository.commit}^{commit}`], { cwd: directory });
    present = true;
  } catch {}
  if (!present) await command('git', ['fetch', '--quiet', '--depth', '1', 'origin', repository.commit], { cwd: directory, timeout: 300_000 });
  await command('git', ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', repository.commit], { cwd: directory });
  const commit = await command('git', ['rev-parse', 'HEAD'], { cwd: directory });
  if (commit !== repository.commit) throw new Error(`batch_a_repository_commit_mismatch:${repository.id}`);
  return directory;
}

async function treeFingerprint(directory) {
  const hasher = createHash('sha256');
  async function visit(current, relative = '') {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target, nextRelative);
      else if (entry.isFile()) {
        hasher.update(nextRelative);
        hasher.update(await readFile(target));
      }
    }
  }
  await visit(directory);
  return `sha256:${hasher.digest('hex')}`;
}

async function command(file, args, { cwd, timeout = 30_000 } = {}) {
  const { stdout } = await execFileAsync(file, args, { cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return String(stdout).trim();
}

function parseMode(args) {
  if (args.length === 0) return 'write';
  if (args.length === 1 && args[0] === '--check') return 'check';
  if (args.length === 1 && args[0] === '--fixtures-only') return 'fixtures';
  throw new Error('usage: node scripts/code-intelligence-batch-a.mjs [--check|--fixtures-only]');
}

async function readJson(file) {
  return JSON.parse(await readFile(path.resolve(root, file), 'utf8'));
}

async function atomicWrite(file, value) {
  const target = path.resolve(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  const temporaryFile = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryFile, target);
}

function comparableReport(report) {
  const comparable = structuredClone(report);
  delete comparable.generatedAt;
  delete comparable.reportFingerprint;
  for (const item of comparable.cases ?? []) delete item.measurements;
  return comparable;
}

function fingerprint(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function round(value, precision = 3) {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}
