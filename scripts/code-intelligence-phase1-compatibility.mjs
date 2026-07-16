import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import {
  AST_CODE_PARSER_VERSION,
  AST_CODE_PROVIDER_VERSION,
  buildJsTsSourceGraph
} from '../providers/native/context-candidate-ast-code/src/index.mjs';
import { RustCodeIntelligenceProvider } from '../providers/native/code-intelligence-rust/src/index.mjs';
import {
  compareSourceGraphCompatibility,
  translateCodeIntelligenceGraph
} from '../packages/source-graph/src/native-compatibility.mjs';

const execFileAsync = promisify(execFile);
const OUTPUT = 'evals/code-intelligence/results/phase1-js-ts-compatibility.json';
const FIXED_GRAPH_TIME = '2026-07-16T00:00:00.000Z';
const BOUNDS = Object.freeze({ maxFiles: 1000, maxFileBytes: 512 * 1024, maxNodes: 5000, maxEdges: 10000 });
const REPOSITORY_IDS = Object.freeze([
  'cirepo_typescript_microsoft_typescript',
  'cirepo_javascript_expressjs_express'
]);
const REPOSITORY_SCOPES = Object.freeze({
  cirepo_typescript_microsoft_typescript: 'src/compiler/transformers',
  cirepo_javascript_expressjs_express: '.'
});
const mode = parseMode(process.argv.slice(2));
const root = process.cwd();
const temp = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-phase1-compatibility-'));

try {
  const nativeBinary = path.resolve(root, 'rust', 'target', 'release', process.platform === 'win32' ? 'oaf.exe' : 'oaf');
  if (!(await stat(nativeBinary)).isFile()) throw new Error('phase1_native_release_binary_missing');
  const corpus = await readJson('evals/code-intelligence/corpus.v1.json');
  const gates = await readJson('evals/code-intelligence/benchmark-gates.v1.json');
  const pinnedRepositories = REPOSITORY_IDS.map((id) => {
    const repository = corpus.repositories.find((item) => item.id === id);
    if (!repository) throw new Error(`phase1_repository_missing:${id}`);
    return repository;
  });

  const fixtures = await createFixtures(path.join(temp, 'fixtures'));
  const repositories = [];
  for (const repository of pinnedRepositories) {
    const checkout = await checkoutPinnedRepository(repository, path.join(temp, 'repositories', repository.id));
    const scope = REPOSITORY_SCOPES[repository.id] ?? '.';
    repositories.push({
      ...repository,
      scope,
      root: path.resolve(checkout, scope)
    });
  }

  const provider = new RustCodeIntelligenceProvider({ binaryPath: nativeBinary, timeoutMs: 120_000 });
  const cases = [];
  for (const fixture of fixtures) cases.push(await runCase({ ...fixture, provider }));
  for (const repository of repositories) cases.push(await runCase({
    id: repository.id,
    language: repository.primaryLanguage,
    sourceClass: 'real-repo',
    sourceRef: `corpus://${repository.id}@${repository.commit}#${repository.scope}`,
    commit: repository.commit,
    root: repository.root,
    provider
  }));

  const thresholds = {
    operational: {
      minimumCaseCount: 4,
      minimumRealRepositoryCount: 2,
      maximumFailureCount: 0,
      deterministicGraphFingerprintsRequired: true
    },
    publishedLanguageFullAccuracy: gates.languageFull,
    accuracyGateApplied: false,
    accuracyGateReason: 'Compatibility against the existing JS/TS graph is not ground-truth accuracy evidence.'
  };
  const failures = cases.filter((item) => !item.deterministic).map((item) => ({ caseId: item.id, code: 'graph_fingerprint_nondeterministic' }));
  const realRepositoryCount = cases.filter((item) => item.sourceClass === 'real-repo').length;
  const gateDecision = cases.length >= thresholds.operational.minimumCaseCount
    && realRepositoryCount >= thresholds.operational.minimumRealRepositoryCount
    && failures.length <= thresholds.operational.maximumFailureCount
    && cases.every((item) => item.deterministic)
    ? 'pass'
    : 'fail';
  const currentCommit = await command('git', ['rev-parse', 'HEAD'], { cwd: root });
  const dirtyBeforeRun = (await command('git', ['status', '--porcelain'], { cwd: root })).length > 0;
  const nativeVersion = cases[0]?.engines?.native?.version ?? 'unknown';
  const report = {
    schemaVersion: '1.0.0',
    reportVersion: 'memory-recall-code-intelligence-phase1-compatibility-1',
    phase: 1,
    generatedAt: new Date().toISOString(),
    environment: {
      platform: os.platform(),
      architecture: os.arch(),
      nodeVersion: process.version
    },
    checkout: {
      commit: currentCommit,
      dirtyBeforeRun
    },
    inputs: {
      corpusFingerprint: corpus.corpusFingerprint,
      repositoryRefs: pinnedRepositories.map((item) => `corpus://${item.id}@${item.commit}#${REPOSITORY_SCOPES[item.id] ?? '.'}`),
      fixtureIds: fixtures.map((item) => item.id),
      bounds: BOUNDS
    },
    engines: {
      baseline: {
        name: 'node-bounded-static',
        providerVersion: AST_CODE_PROVIDER_VERSION,
        parserVersion: AST_CODE_PARSER_VERSION,
        languageIds: ['javascript', 'typescript']
      },
      native: {
        name: 'memory-recall-native',
        version: nativeVersion,
        protocolVersion: '1.0.0',
        status: 'preview',
        binaryBundledByNpm: false
      }
    },
    thresholds,
    cases,
    failures,
    gateScope: 'phase1-boundary-and-reproducibility',
    gateDecision,
    publicDefault: {
      engine: 'js',
      changed: false
    },
    competitors: {
      status: 'unmeasured',
      reason: 'Phase 1 contains no identical-commit competitor run.'
    },
    claims: {
      parity: false,
      leadership: false,
      accuracyFloorMet: false,
      reason: 'Phase 1 proves the native preview boundary and reproducible JS/TS compatibility measurements, not ground-truth accuracy or competitor parity.'
    },
    safeguards: {
      rawSourceStored: false,
      rawCommandOutputStored: false,
      absoluteCheckoutPathsStored: false,
      environmentVariablesStored: false,
      engineNetworkCalls: 0,
      engineModelCalls: 0,
      canonicalMemoryWrites: 0,
      workspaceWrites: 0
    }
  };
  report.reportFingerprint = fingerprint(comparableReport(report));

  if (mode === 'check') {
    const stored = await readJson(OUTPUT);
    if (JSON.stringify(comparableReport(stored)) !== JSON.stringify(comparableReport(report))) {
      throw new Error('phase1_compatibility_evidence_stale');
    }
    if (stored.reportFingerprint !== fingerprint(comparableReport(stored))) {
      throw new Error('phase1_compatibility_fingerprint_invalid');
    }
    console.log(`Phase 1 compatibility evidence is current: ${cases.length} cases, ${realRepositoryCount} pinned repositories.`);
  } else {
    await atomicWrite(OUTPUT, report);
    console.log(`Phase 1 compatibility passed ${cases.length} cases and wrote ${OUTPUT}.`);
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}

async function runCase({ id, language, sourceClass, sourceRef, commit = null, root: caseRoot, provider }) {
  const baselineFirst = await buildJsTsSourceGraph({
    root: caseRoot,
    workspaceId: 'ws_phase1',
    maxFiles: BOUNDS.maxFiles,
    maxFileBytes: BOUNDS.maxFileBytes,
    maxNodes: BOUNDS.maxNodes,
    maxEdges: BOUNDS.maxEdges,
    clock: () => FIXED_GRAPH_TIME
  });
  const baselineSecond = await buildJsTsSourceGraph({
    root: caseRoot,
    workspaceId: 'ws_phase1',
    maxFiles: BOUNDS.maxFiles,
    maxFileBytes: BOUNDS.maxFileBytes,
    maxNodes: BOUNDS.maxNodes,
    maxEdges: BOUNDS.maxEdges,
    clock: () => FIXED_GRAPH_TIME
  });
  const nativeFirst = await provider.buildGraph({
    root: caseRoot,
    workspaceId: 'ws_phase1',
    ...BOUNDS,
    languages: [language]
  });
  const nativeSecond = await provider.buildGraph({
    root: caseRoot,
    workspaceId: 'ws_phase1',
    ...BOUNDS,
    languages: [language]
  });
  const translatedFirst = translateCodeIntelligenceGraph(nativeFirst);
  const translatedSecond = translateCodeIntelligenceGraph(nativeSecond);
  const compatibility = compareSourceGraphCompatibility(baselineFirst, translatedFirst);
  const deterministic = baselineFirst.graphFingerprint === baselineSecond.graphFingerprint
    && nativeFirst.graphFingerprint === nativeSecond.graphFingerprint
    && translatedFirst.graphFingerprint === translatedSecond.graphFingerprint;

  return {
    id,
    language,
    sourceClass,
    sourceRef,
    ...(commit ? { commit } : {}),
    deterministic,
    engines: {
      baseline: {
        graphFingerprint: baselineFirst.graphFingerprint,
        fileCount: baselineFirst.summary.fileCount,
        symbolCount: baselineFirst.summary.symbolCount,
        edgeCount: baselineFirst.summary.edgeCount,
        diagnosticCount: baselineFirst.diagnostics.length
      },
      native: {
        version: nativeFirst.engine.version,
        providerGraphFingerprint: nativeFirst.graphFingerprint,
        compatibilityGraphFingerprint: translatedFirst.graphFingerprint,
        fileCount: translatedFirst.summary.fileCount,
        symbolCount: translatedFirst.summary.symbolCount,
        edgeCount: translatedFirst.summary.edgeCount,
        diagnosticCount: translatedFirst.diagnostics.length,
        coverage: nativeFirst.coverage.map((item) => ({
          language: item.language,
          support: item.support,
          discoveredFileCount: item.discoveredFileCount,
          indexedFileCount: item.indexedFileCount,
          failedFileCount: item.failedFileCount,
          omittedFileCount: item.omittedFileCount ?? 0
        }))
      }
    },
    compatibility: {
      comparisonVersion: compatibility.comparisonVersion,
      comparisonFingerprint: compatibility.comparisonFingerprint,
      dimensions: compatibility.dimensions,
      parityClaimed: compatibility.parityClaimed,
      publicDefaultChanged: compatibility.publicDefaultChanged
    }
  };
}

async function createFixtures(directory) {
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
  return [
    {
      id: 'fixture_typescript_import_call',
      language: 'typescript',
      sourceClass: 'fixture',
      sourceRef: `fixture://${fingerprint('typescript-import-call')}`,
      root: typescript
    },
    {
      id: 'fixture_javascript_import_call',
      language: 'javascript',
      sourceClass: 'fixture',
      sourceRef: `fixture://${fingerprint('javascript-import-call')}`,
      root: javascript
    }
  ];
}

async function checkoutPinnedRepository(repository, directory) {
  await mkdir(path.dirname(directory), { recursive: true });
  await command('git', ['init', '--quiet', directory], { cwd: root });
  await command('git', ['-C', directory, 'remote', 'add', 'origin', repository.url], { cwd: root });
  await command('git', [
    '-C', directory,
    '-c', 'advice.detachedHead=false',
    'fetch', '--quiet', '--depth', '1', 'origin', repository.commit
  ], { cwd: root, timeout: 180_000 });
  await command('git', ['-C', directory, 'checkout', '--quiet', '--detach', 'FETCH_HEAD'], { cwd: root });
  const commit = await command('git', ['-C', directory, 'rev-parse', 'HEAD'], { cwd: root });
  if (commit !== repository.commit) throw new Error(`phase1_repository_commit_mismatch:${repository.id}`);
  return directory;
}

async function command(file, args, { cwd, timeout = 30_000 } = {}) {
  const { stdout } = await execFileAsync(file, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout,
    windowsHide: true,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0'
    }
  });
  return String(stdout).trim();
}

function parseMode(args) {
  if (args.length === 0) return 'write';
  if (args.length === 1 && args[0] === '--check') return 'check';
  throw new Error('usage: node scripts/code-intelligence-phase1-compatibility.mjs [--check]');
}

async function readJson(file) {
  return JSON.parse(await readFile(path.resolve(root, file), 'utf8'));
}

async function atomicWrite(file, value) {
  const target = path.resolve(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

function comparableReport(report) {
  const { generatedAt: _generatedAt, reportFingerprint: _reportFingerprint, checkout: _checkout, ...comparable } = report;
  return comparable;
}

function fingerprint(value) {
  const payload = typeof value === 'string' ? value : JSON.stringify(value);
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}
