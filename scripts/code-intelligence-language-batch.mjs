import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { evaluateCodeIntelligenceLanguage } from '../packages/protocol/src/code-intelligence-evaluation.mjs';
import { RustCodeIntelligenceProvider } from '../providers/native/code-intelligence-rust/src/index.mjs';

const execFileAsync = promisify(execFile);
const BOUNDS = Object.freeze({ maxFiles: 5_000, maxFileBytes: 512 * 1024, maxNodes: 5_000, maxEdges: 10_000 });

export async function runLanguageBatch({ batch, languages, repositoryScopes, claimReason }) {
  const lower = batch.toLowerCase();
  const output = `evals/code-intelligence/results/phase2-batch-${lower}.json`;
  const mode = parseMode(process.argv.slice(2), lower);
  const root = process.cwd();
  const nativeBinary = path.resolve(root, 'rust', 'target', 'release', process.platform === 'win32' ? 'oaf.exe' : 'oaf');
  if (!(await stat(nativeBinary)).isFile()) throw new Error(`batch_${lower}_native_release_binary_missing`);
  const corpus = await readJson(root, 'evals/code-intelligence/corpus.v1.json');
  const gates = await readJson(root, 'evals/code-intelligence/benchmark-gates.v1.json');
  const fixtures = await Promise.all(languages.map(async (language) => {
    const truthPath = `evals/code-intelligence/truth/fixtures/${language}.json`;
    return {
      id: `fixture_${language}_batch_${lower}`,
      language,
      root: path.resolve(root, 'evals', 'code-intelligence', 'fixtures', `batch-${lower}`, language),
      sourceClass: 'fixture',
      sourceRef: (await readJson(root, truthPath)).source.ref,
      truth: await readJson(root, truthPath),
      truthPath
    };
  }));
  const repositories = [];
  for (const [id, scope] of mode === 'fixtures' ? [] : Object.entries(repositoryScopes)) {
    const repository = corpus.repositories.find((item) => item.id === id);
    if (!repository) throw new Error(`batch_${lower}_repository_missing:${id}`);
    const truthPath = `evals/code-intelligence/truth/repositories/${repository.primaryLanguage}/${id}.json`;
    const checkout = await ensurePinnedRepository(repository, lower);
    repositories.push({
      id,
      language: repository.primaryLanguage,
      root: path.resolve(checkout, scope),
      sourceClass: 'real-repo',
      sourceRef: `corpus://${id}@${repository.commit}#${scope}`,
      truth: await readJson(root, truthPath),
      truthPath,
      commit: repository.commit
    });
  }

  const provider = new RustCodeIntelligenceProvider({ binaryPath: nativeBinary, timeoutMs: 120_000 });
  const cases = [];
  for (const definition of [...fixtures, ...repositories]) {
    cases.push(await runCase(definition, provider, lower));
  }
  const languageReports = languages.map((language) => aggregateLanguage(language, cases, gates.languageFull));
  const failures = cases.flatMap((item) => item.report.failures.map((failure) => ({ caseId: item.id, ...failure })));
  for (const language of languageReports.filter((item) => item.gateDecision === 'fail')) {
    failures.push({ caseId: language.language, code: 'language_accuracy_floor_not_met' });
  }
  const report = {
    schemaVersion: '1.0.0',
    reportVersion: `memory-recall-code-intelligence-phase2-batch-${lower}-1`,
    phase: 2,
    batch,
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
    languages: languageReports,
    failures,
    gateDecision: failures.length === 0 ? 'pass' : 'fail',
    publicDefault: { engine: 'js', changed: false },
    claims: {
      accuracyFloorMet: languageReports.every((item) => item.gateDecision === 'pass'),
      parity: false,
      leadership: false,
      reason: claimReason
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
    if (failed.length > 0) throw new Error(`batch_${lower}_fixture_truth_failed`);
    console.log(`Batch ${batch} fixture truth passed: ${cases.length} cases.`);
  } else if (mode === 'check') {
    const stored = await readJson(root, output);
    if (JSON.stringify(comparableReport(stored)) !== JSON.stringify(comparableReport(report))) {
      throw new Error(`batch_${lower}_evidence_stale`);
    }
    if (stored.reportFingerprint !== fingerprint(comparableReport(stored))) {
      throw new Error(`batch_${lower}_report_fingerprint_invalid`);
    }
    console.log(`Batch ${batch} evidence is current: ${cases.length} cases, ${languageReports.length} languages.`);
  } else {
    await atomicWrite(root, output, report);
    console.log(`Batch ${batch} evaluated ${cases.length} cases and wrote ${output}.`);
  }
}

async function runCase(definition, provider, lower) {
  if (definition.truth.source.ref !== definition.sourceRef) {
    throw new Error(`batch_${lower}_truth_source_mismatch:${definition.id}`);
  }
  const before = await treeFingerprint(definition.root);
  const rssBefore = process.resourceUsage().maxRSS;
  const firstStarted = process.hrtime.bigint();
  const first = await provider.buildGraph({
    root: definition.root,
    workspaceId: `ws_batch_${lower}`,
    ...BOUNDS,
    languages: [definition.language]
  });
  const firstElapsedMs = Number(process.hrtime.bigint() - firstStarted) / 1_000_000;
  const secondStarted = process.hrtime.bigint();
  const second = await provider.buildGraph({
    root: definition.root,
    workspaceId: `ws_batch_${lower}`,
    ...BOUNDS,
    languages: [definition.language]
  });
  const secondElapsedMs = Number(process.hrtime.bigint() - secondStarted) / 1_000_000;
  if (before !== await treeFingerprint(definition.root)) throw new Error(`batch_${lower}_workspace_changed:${definition.id}`);
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

async function ensurePinnedRepository(repository, lower) {
  const directory = path.join(os.tmpdir(), 'memory-recall-code-intelligence-corpus-v1', repository.id);
  await mkdir(directory, { recursive: true });
  if (!(await exists(path.join(directory, '.git')))) {
    await command('git', ['init', '--quiet'], { cwd: directory });
    await command('git', ['remote', 'add', 'origin', repository.url], { cwd: directory });
  }
  try {
    await command('git', ['cat-file', '-e', `${repository.commit}^{commit}`], { cwd: directory });
  } catch {
    await command('git', ['fetch', '--quiet', '--depth', '1', 'origin', repository.commit], { cwd: directory, timeout: 300_000 });
  }
  await command('git', ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', repository.commit], { cwd: directory });
  if (await command('git', ['rev-parse', 'HEAD'], { cwd: directory }) !== repository.commit) {
    throw new Error(`batch_${lower}_repository_commit_mismatch:${repository.id}`);
  }
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

function parseMode(args, lower) {
  if (args.length === 0) return 'write';
  if (args.length === 1 && args[0] === '--check') return 'check';
  if (args.length === 1 && args[0] === '--fixtures-only') return 'fixtures';
  throw new Error(`usage: node scripts/code-intelligence-batch-${lower}.mjs [--check|--fixtures-only]`);
}

async function readJson(root, file) {
  return JSON.parse(await readFile(path.resolve(root, file), 'utf8'));
}

async function atomicWrite(root, file, value) {
  const target = path.resolve(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
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
