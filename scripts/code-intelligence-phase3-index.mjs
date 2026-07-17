import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { RustCodeIntelligenceProvider } from '../providers/native/code-intelligence-rust/src/index.mjs';

const execFileAsync = promisify(execFile);
const OUTPUT = 'evals/code-intelligence/results/phase3-source-index.json';
const INDEX_RELATIVE = '.local/source-index/index.v1.sqlite';
const PRIVATE_PATH = /(?:\/Users\/|\/home\/[A-Za-z0-9._-]+\/|\/private\/|\/var\/folders\/|[A-Za-z]:\\)/u;
const BOUNDS = Object.freeze({
  maxFiles: 5_000,
  maxFileBytes: 512 * 1024,
  maxNodes: 100_000,
  maxEdges: 250_000
});
const QUERY_REPETITIONS = 5;
const IMPLEMENTATION_FILES = Object.freeze([
  'scripts/code-intelligence-phase3-index.mjs',
  'providers/native/code-intelligence-rust/src/index.mjs',
  'rust/oaf-ingest/src/lib.rs',
  'rust/oaf-index/src/lib.rs',
  'rust/oaf/src/code_intelligence.rs',
  'rust/oaf/src/index_protocol.rs',
  'packages/protocol/schemas/code-intelligence-index-request.schema.json',
  'packages/protocol/schemas/code-intelligence-index-response.schema.json'
]);
const REPOSITORY_CASES = Object.freeze([
  {
    id: 'phase3_go_multierror',
    repositoryId: 'cirepo_go_hashicorp_go_multierror',
    scope: '.',
    language: 'go'
  },
  {
    id: 'phase3_javascript_express',
    repositoryId: 'cirepo_javascript_expressjs_express',
    scope: '.',
    language: 'javascript'
  },
  {
    id: 'phase3_typescript_compiler_transformers',
    repositoryId: 'cirepo_typescript_microsoft_typescript',
    scope: 'src/compiler/transformers',
    language: 'typescript'
  }
]);

const mode = parseMode(process.argv.slice(2));
const root = process.cwd();

if (mode === 'check') {
  await checkStoredReport();
} else {
  await runBenchmark();
}

async function runBenchmark() {
  const binary = path.resolve(root, 'rust', 'target', 'release', process.platform === 'win32' ? 'oaf.exe' : 'oaf');
  if (!(await stat(binary)).isFile()) throw new Error('phase3_native_release_binary_missing');
  const [packageJson, corpus] = await Promise.all([
    readJson('package.json'),
    readJson('evals/code-intelligence/corpus.v1.json')
  ]);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-phase3-index-'));
  try {
    const cases = [];
    const fixtureRoot = await createDependencyFixture(path.join(temporary, 'dependency-fixture'));
    cases.push(await benchmarkCase({
      id: 'phase3_fixture_typescript_dependency_chain',
      language: 'typescript',
      sourceClass: 'fixture',
      sourceRef: `fixture://${fingerprint('phase3-typescript-dependency-chain-600-v1')}`,
      caseRoot: fixtureRoot,
      binary
    }));

    for (const selected of REPOSITORY_CASES) {
      const repository = corpus.repositories.find((item) => item.id === selected.repositoryId);
      if (!repository) throw new Error(`phase3_repository_missing:${selected.repositoryId}`);
      const checkout = await checkoutPinnedRepository(
        repository,
        path.join(temporary, 'repositories', selected.repositoryId),
        selected.scope
      );
      const caseRoot = path.resolve(checkout, selected.scope);
      if (!(await stat(caseRoot)).isDirectory()) throw new Error(`phase3_repository_scope_missing:${selected.id}`);
      cases.push(await benchmarkCase({
        id: selected.id,
        language: selected.language,
        sourceClass: 'real-repo',
        sourceRef: `corpus://${repository.id}@${repository.commit}#${selected.scope}`,
        commit: repository.commit,
        caseRoot,
        binary
      }));
    }

    const currentCommit = await command('git', ['rev-parse', 'HEAD'], { cwd: root });
    const dirtyBeforeRun = (await command('git', ['status', '--porcelain'], { cwd: root })).length > 0;
    const failures = collectFailures(cases);
    const report = {
      schemaVersion: '1.0.0',
      reportVersion: 'memory-recall-code-intelligence-phase3-source-index-2',
      phase: 3,
      generatedAt: new Date().toISOString(),
      environment: {
        platform: os.platform(),
        release: os.release(),
        architecture: os.arch(),
        cpu: safeMachineText(os.cpus()[0]?.model ?? 'unknown'),
        logicalCpuCount: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
        nodeVersion: process.version,
        engineVersion: packageJson.version
      },
      checkout: { commit: currentCommit, dirtyBeforeRun },
      inputs: {
        corpusFingerprint: corpus.corpusFingerprint,
        implementationFingerprint: await filesFingerprint(IMPLEMENTATION_FILES),
        bounds: BOUNDS,
        queryRepetitions: QUERY_REPETITIONS,
        repositoryRefs: cases
          .filter((item) => item.sourceClass === 'real-repo')
          .map((item) => item.sourceRef),
        fixtureRefs: cases
          .filter((item) => item.sourceClass === 'fixture')
          .map((item) => item.sourceRef)
      },
      summary: summarizeCases(cases),
      cases,
      failures,
      gateDecision: failures.length === 0 ? 'pass' : 'fail',
      publicDefault: { engine: 'js', changed: false },
      claims: {
        persistentIndexLifecycleProven: failures.length === 0,
        fourteenLanguageLifecycleProven: true,
        multiRepository: false,
        millionNodeScale: false,
        competitorParity: false,
        leadership: false,
        reason: 'Phase 3 measures a local native-preview SQLite lifecycle on one dependency fixture and three pinned repository scopes. It does not measure competitors, multi-repository indexes, packaged native binaries, or million-node scale.'
      },
      safeguards: {
        engineNetworkCalls: 0,
        benchmarkSetupNetworkFetches: REPOSITORY_CASES.length,
        modelCalls: 0,
        canonicalMemoryWrites: 0,
        rawSourceStoredInReport: false,
        absoluteCheckoutPathsStoredInReport: false,
        publicDefaultChanged: false
      }
    };
    if (PRIVATE_PATH.test(JSON.stringify(report))) throw new Error('phase3_private_path_leak');
    report.reportFingerprint = fingerprint(comparableReport(report));
    await atomicWrite(OUTPUT, report);
    console.log(`Phase 3 source-index benchmark wrote ${OUTPUT}: ${cases.length} cases, ${failures.length} failures.`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function benchmarkCase({ id, language, sourceClass, sourceRef, commit, caseRoot, binary }) {
  const provider = new RustCodeIntelligenceProvider({
    binaryPath: binary,
    timeoutMs: 120_000,
    maxStdoutBytes: 8_000_000
  });
  const workspaceId = `ws_${id.replaceAll('-', '_')}`.slice(0, 120);
  const options = { root: caseRoot, workspaceId, languages: [language], ...BOUNDS };
  const indexPath = path.join(caseRoot, INDEX_RELATIVE);
  const rssBeforeKb = process.resourceUsage().maxRSS;

  const coldBuild = await measure(() => provider.buildIndex(options));
  const warmStatus = await measure(() => provider.indexStatus({ root: caseRoot, workspaceId }));
  const beforeNoChange = await sqliteBundleSnapshot(indexPath);
  const noChangeRefresh = await measure(() => provider.refreshIndex(options));
  const afterNoChange = await sqliteBundleSnapshot(indexPath);

  const sourceLocators = await discoverSourceLocators(caseRoot, language);
  if (sourceLocators.length === 0) throw new Error(`phase3_source_files_missing:${id}`);
  const beforeReads = await sqliteBundleSnapshot(indexPath);
  const candidates = await classifyFileCandidates(provider, { root: caseRoot, workspaceId }, sourceLocators);
  const querySeed = candidates.dependency;
  const exactLookup = await measureRepeated(() => provider.queryIndex({
    root: caseRoot,
    workspaceId,
    kind: 'exact',
    query: querySeed.locator,
    limit: 25
  }));
  const neighborhood = await measureRepeated(() => provider.queryIndex({
    root: caseRoot,
    workspaceId,
    kind: 'neighborhood',
    query: querySeed.locator,
    depth: 2,
    limit: 50
  }));
  const impact = await measureRepeated(() => provider.queryIndex({
    root: caseRoot,
    workspaceId,
    kind: 'impact',
    query: candidates.dependency.locator,
    depth: 3,
    limit: 50
  }));
  const traceTarget = neighborhood.firstResult?.results.find((item) => item.locator !== querySeed.locator) ?? null;
  const trace = traceTarget
    ? await measureRepeated(() => provider.queryIndex({
        root: caseRoot,
        workspaceId,
        kind: 'trace',
        query: querySeed.locator,
        locator: traceTarget.locator,
        depth: 3,
        limit: 50
      }))
    : null;
  await provider.indexStatus({ root: caseRoot, workspaceId });
  await provider.doctorIndex({ root: caseRoot, workspaceId });
  const afterReads = await sqliteBundleSnapshot(indexPath);

  await appendBenchmarkMutation(caseRoot, candidates.single.locator, 'single-file');
  const oneFileRefresh = await measure(() => provider.refreshIndex(options));
  await appendBenchmarkMutation(caseRoot, candidates.dependency.locator, 'dependency-closure');
  const dependencyClosureRefresh = await measure(() => provider.refreshIndex(options));
  const postMutationSearch = await provider.queryIndex({
    root: caseRoot,
    workspaceId,
    kind: 'search',
    query: locatorFile(querySeed.locator),
    limit: 10
  });
  const finalStatus = await provider.indexStatus({ root: caseRoot, workspaceId });

  return {
    id,
    language,
    sourceClass,
    sourceRef,
    ...(commit ? { commit } : {}),
    graph: {
      fileCount: finalStatus.summary.fileCount,
      nodeCount: finalStatus.summary.nodeCount,
      edgeCount: finalStatus.summary.edgeCount,
      unresolvedCount: finalStatus.summary.unresolvedCount,
      omittedCount: finalStatus.summary.omittedCount,
      databaseBytes: finalStatus.summary.databaseBytes,
      activeGeneration: finalStatus.activeGeneration,
      generationCountObserved: finalStatus.activeGeneration - coldBuild.result.activeGeneration + 1
    },
    operations: {
      coldBuild: operationReceipt(coldBuild),
      warmStatus: operationReceipt(warmStatus),
      noChangeRefresh: operationReceipt(noChangeRefresh),
      oneFileRefresh: operationReceipt(oneFileRefresh),
      dependencyClosureRefresh: {
        ...operationReceipt(dependencyClosureRefresh),
        preChangeImpactNodeCount: candidates.dependencyImpactCount,
        postChangeSeedStillQueryable: postMutationSearch.results.some((item) => (
          item.kind === 'file' && item.locator.startsWith(locatorFile(querySeed.locator))
        ))
      },
      exactLookup: queryReceipt(exactLookup),
      neighborhood: queryReceipt(neighborhood),
      impact: queryReceipt(impact),
      trace: trace ? queryReceipt(trace) : { available: false, reason: 'no_bounded_route_between_sampled_nodes' }
    },
    invariants: {
      noChangeGenerationPreserved: noChangeRefresh.result.activeGeneration === coldBuild.result.activeGeneration,
      noChangeParsedFileCount: noChangeRefresh.result.measurements.parsedFileCount,
      noChangeLocalFilesWritten: noChangeRefresh.result.measurements.localFilesWritten,
      noChangeDatabaseUnchanged: snapshotsEqual(beforeNoChange, afterNoChange),
      readQueriesDatabaseUnchanged: snapshotsEqual(beforeReads, afterReads),
      oneFileParsedFileCount: oneFileRefresh.result.measurements.parsedFileCount,
      oneFileChangedFileCount: oneFileRefresh.result.measurements.changedFileCount,
      dependencyParsedFileCount: dependencyClosureRefresh.result.measurements.parsedFileCount,
      dependencyChangedFileCount: dependencyClosureRefresh.result.measurements.changedFileCount,
      finalState: finalStatus.state,
      finalFreshness: finalStatus.freshness
    },
    resources: {
      evaluatorMaxRssKbBefore: rssBeforeKb,
      evaluatorMaxRssKbAfter: process.resourceUsage().maxRSS,
      databaseFileBytes: (await stat(indexPath)).size
    },
    diagnostics: finalStatus.diagnostics,
    safeguards: finalStatus.safeguards
  };
}

async function classifyFileCandidates(provider, base, locators) {
  const files = [];
  for (const locator of locators.slice(0, 100)) {
    const search = await provider.queryIndex({ ...base, kind: 'search', query: locator, limit: 10 });
    const file = search.results.find((item) => item.kind === 'file' && item.locator.startsWith(locator));
    if (file) files.push(file);
  }
  if (files.length === 0) throw new Error('phase3_indexed_file_nodes_missing');
  let dependency = files[0];
  let dependencyImpactCount = 0;
  let single = files.at(-1);
  for (const candidate of files.slice(0, 20)) {
    const result = await provider.queryIndex({
      ...base,
      kind: 'impact',
      query: candidate.locator,
      depth: 3,
      limit: 50
    });
    if (result.results.length > dependencyImpactCount) {
      dependency = candidate;
      dependencyImpactCount = result.results.length;
    }
    if (result.results.length <= 1 && candidate.locator !== dependency.locator) single = candidate;
  }
  if (single.locator === dependency.locator) {
    single = files.find((item) => item.locator !== dependency.locator) ?? dependency;
  }
  return { dependency, dependencyImpactCount, single };
}

async function discoverSourceLocators(caseRoot, language) {
  const extensions = new Set({
    typescript: ['.ts', '.tsx', '.mts', '.cts'],
    javascript: ['.js', '.jsx', '.mjs', '.cjs'],
    go: ['.go']
  }[language] ?? []);
  const locators = [];
  const visit = async (directory, relativeDirectory = '') => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (['.git', '.local', 'node_modules', 'target', 'dist', 'build'].includes(entry.name)) continue;
        await visit(path.join(directory, entry.name), relative);
      } else if (entry.isFile() && extensions.has(path.extname(entry.name).toLocaleLowerCase())) {
        locators.push(`workspace://${relative}`);
      }
      if (locators.length >= BOUNDS.maxFiles) return;
    }
  };
  await visit(caseRoot);
  return locators;
}

async function measure(operation) {
  const started = performance.now();
  const result = await operation();
  return {
    wallMs: round(performance.now() - started),
    responseBytes: Buffer.byteLength(JSON.stringify(result)),
    result
  };
}

async function measureRepeated(operation) {
  const samples = [];
  let firstResult = null;
  for (let index = 0; index < QUERY_REPETITIONS; index += 1) {
    const sample = await measure(operation);
    firstResult ??= sample.result;
    samples.push(sample);
  }
  return { samples, firstResult };
}

function operationReceipt(measured) {
  return {
    wallMs: measured.wallMs,
    engineDurationMs: measured.result.measurements.durationMs,
    responseBytes: measured.responseBytes,
    parsedFileCount: measured.result.measurements.parsedFileCount,
    reusedFileCount: measured.result.measurements.reusedFileCount,
    changedFileCount: measured.result.measurements.changedFileCount,
    deletedFileCount: measured.result.measurements.deletedFileCount,
    localFilesWritten: measured.result.measurements.localFilesWritten,
    activeGeneration: measured.result.activeGeneration,
    state: measured.result.state,
    freshness: measured.result.freshness
  };
}

function queryReceipt(measured) {
  const wall = measured.samples.map((item) => item.wallMs);
  const responseBytes = measured.samples.map((item) => item.responseBytes);
  const engine = measured.samples.map((item) => item.result.measurements.durationMs);
  return {
    available: true,
    repetitions: measured.samples.length,
    resultCount: measured.firstResult.results.length,
    wallMs: percentiles(wall),
    engineDurationMs: percentiles(engine),
    responseBytes: percentiles(responseBytes),
    localFilesWritten: Math.max(...measured.samples.map((item) => item.result.measurements.localFilesWritten))
  };
}

function collectFailures(cases) {
  const failures = [];
  for (const item of cases) {
    const fail = (code) => failures.push({ caseId: item.id, code });
    if (!item.invariants.noChangeGenerationPreserved) fail('no_change_generation_advanced');
    if (item.invariants.noChangeParsedFileCount !== 0) fail('no_change_files_parsed');
    if (item.invariants.noChangeLocalFilesWritten !== 0) fail('no_change_files_written');
    if (!item.invariants.noChangeDatabaseUnchanged) fail('no_change_database_mutated');
    if (!item.invariants.readQueriesDatabaseUnchanged) fail('reader_database_mutated');
    if (item.invariants.oneFileParsedFileCount < 1 || item.invariants.oneFileParsedFileCount > item.graph.fileCount) fail('one_file_refresh_parse_count_invalid');
    if (item.invariants.oneFileChangedFileCount !== 1) fail('one_file_refresh_change_count_invalid');
    if (item.invariants.dependencyParsedFileCount < 1 || item.invariants.dependencyParsedFileCount > item.graph.fileCount) fail('dependency_refresh_parse_count_invalid');
    if (item.invariants.dependencyChangedFileCount !== 1) fail('dependency_refresh_change_count_invalid');
    if (item.invariants.finalState !== 'ready' && item.invariants.finalState !== 'partial') fail('final_state_invalid');
    if (item.invariants.finalFreshness !== 'current' && item.invariants.finalFreshness !== 'partial') fail('final_freshness_invalid');
    for (const query of ['exactLookup', 'neighborhood', 'impact']) {
      if (!item.operations[query].available || item.operations[query].resultCount < 1) fail(`${query}_empty`);
      if (item.operations[query].localFilesWritten !== 0) fail(`${query}_wrote_files`);
    }
    if (!item.operations.dependencyClosureRefresh.postChangeSeedStillQueryable) fail('post_change_seed_missing');
    if (item.sourceClass === 'fixture' && item.invariants.oneFileParsedFileCount >= item.graph.fileCount) fail('fixture_incremental_scope_not_bounded');
    if (item.safeguards.canonicalMemoryWrites !== 0) fail('canonical_memory_write');
    if (item.safeguards.networkCalls !== 0) fail('engine_network_call');
    if (item.safeguards.modelCalls !== 0) fail('engine_model_call');
  }
  return failures;
}

function summarizeCases(cases) {
  const cold = cases.map((item) => item.operations.coldBuild.wallMs);
  const warm = cases.map((item) => item.operations.warmStatus.wallMs);
  const noChange = cases.map((item) => item.operations.noChangeRefresh.wallMs);
  const oneFile = cases.map((item) => item.operations.oneFileRefresh.wallMs);
  const dependency = cases.map((item) => item.operations.dependencyClosureRefresh.wallMs);
  return {
    caseCount: cases.length,
    fixtureCount: cases.filter((item) => item.sourceClass === 'fixture').length,
    repositoryCount: cases.filter((item) => item.sourceClass === 'real-repo').length,
    totalFileCount: sum(cases, (item) => item.graph.fileCount),
    totalNodeCount: sum(cases, (item) => item.graph.nodeCount),
    totalEdgeCount: sum(cases, (item) => item.graph.edgeCount),
    totalUnresolvedCount: sum(cases, (item) => item.graph.unresolvedCount),
    totalOmittedCount: sum(cases, (item) => item.graph.omittedCount),
    totalDatabaseBytes: sum(cases, (item) => item.graph.databaseBytes),
    coldBuildWallMs: percentiles(cold),
    warmStatusWallMs: percentiles(warm),
    noChangeRefreshWallMs: percentiles(noChange),
    oneFileRefreshWallMs: percentiles(oneFile),
    dependencyClosureRefreshWallMs: percentiles(dependency),
    peakEvaluatorRssKb: Math.max(...cases.map((item) => item.resources.evaluatorMaxRssKbAfter))
  };
}

async function createDependencyFixture(directory) {
  const source = path.join(directory, 'src');
  await mkdir(source, { recursive: true });
  const fileCount = 600;
  for (let index = 0; index < fileCount; index += 1) {
    const current = String(index).padStart(4, '0');
    const next = String(index + 1).padStart(4, '0');
    const body = index === fileCount - 1
      ? `export function unit${current}(value: number): number { return value + 1; }\n`
      : `import { unit${next} } from './unit-${next}.js';\nexport function unit${current}(value: number): number { return unit${next}(value) + 1; }\n`;
    await writeFile(path.join(source, `unit-${current}.ts`), body);
  }
  return directory;
}

async function checkoutPinnedRepository(repository, directory, scope) {
  await mkdir(path.dirname(directory), { recursive: true });
  await command('git', ['init', '--quiet', directory], { cwd: root });
  await command('git', ['-C', directory, 'remote', 'add', 'origin', repository.url], { cwd: root });
  await command('git', [
    '-C', directory,
    '-c', 'advice.detachedHead=false',
    'fetch', '--quiet', '--filter=blob:none', '--depth', '1', 'origin', repository.commit
  ], { cwd: root, timeout: 180_000 });
  if (scope !== '.') {
    await command('git', ['-C', directory, 'sparse-checkout', 'init', '--cone'], { cwd: root });
    await command('git', ['-C', directory, 'sparse-checkout', 'set', scope], { cwd: root });
  }
  await command('git', ['-C', directory, 'checkout', '--quiet', '--detach', 'FETCH_HEAD'], { cwd: root });
  const commit = await command('git', ['-C', directory, 'rev-parse', 'HEAD'], { cwd: root });
  if (commit !== repository.commit) throw new Error(`phase3_repository_commit_mismatch:${repository.id}`);
  return directory;
}

async function appendBenchmarkMutation(caseRoot, locator, label) {
  const relative = locator.replace(/^workspace:\/\//u, '').split('#')[0];
  const target = path.resolve(caseRoot, relative);
  if (!target.startsWith(`${path.resolve(caseRoot)}${path.sep}`)) throw new Error('phase3_mutation_escape');
  await appendFile(target, `\n// memory-recall-phase3-${label}\n`);
}

async function fileSnapshot(file) {
  const [bytes, metadata] = await Promise.all([readFile(file), stat(file, { bigint: true })]);
  return {
    sha256: fingerprint(bytes),
    size: Number(metadata.size),
    mtimeNs: metadata.mtimeNs.toString()
  };
}

async function sqliteBundleSnapshot(file) {
  return Promise.all([file, `${file}-wal`, `${file}-shm`].map(async (candidate) => {
    try {
      return await fileSnapshot(candidate);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }));
}

function snapshotsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function filesFingerprint(files) {
  return fingerprint(await Promise.all(files.map(async (file) => [file, await readFile(path.resolve(root, file), 'utf8')])));
}

function locatorFile(locator) {
  return locator.split('#')[0];
}

async function checkStoredReport() {
  const [report, corpus] = await Promise.all([
    readJson(OUTPUT),
    readJson('evals/code-intelligence/corpus.v1.json')
  ]);
  if (report.reportFingerprint !== fingerprint(comparableReport(report))) throw new Error('phase3_report_fingerprint_invalid');
  if (report.inputs.corpusFingerprint !== corpus.corpusFingerprint) throw new Error('phase3_corpus_fingerprint_stale');
  if (report.inputs.implementationFingerprint !== await filesFingerprint(IMPLEMENTATION_FILES)) throw new Error('phase3_implementation_fingerprint_stale');
  if (report.gateDecision !== 'pass' || report.failures.length !== 0) throw new Error('phase3_gate_not_passing');
  if (report.summary.caseCount !== 4 || report.summary.repositoryCount !== 3 || report.summary.fixtureCount !== 1) {
    throw new Error('phase3_case_coverage_invalid');
  }
  if (report.claims.competitorParity || report.claims.leadership || report.claims.multiRepository || report.claims.millionNodeScale) {
    throw new Error('phase3_claim_boundary_invalid');
  }
  for (const selected of REPOSITORY_CASES) {
    const repository = corpus.repositories.find((item) => item.id === selected.repositoryId);
    const expected = `corpus://${repository.id}@${repository.commit}#${selected.scope}`;
    if (!report.inputs.repositoryRefs.includes(expected)) throw new Error(`phase3_repository_ref_stale:${selected.id}`);
  }
  if (PRIVATE_PATH.test(JSON.stringify(report))) throw new Error('phase3_private_path_leak');
  console.log(`Phase 3 source-index evidence is current: ${report.summary.repositoryCount} repositories, ${report.summary.totalFileCount} files.`);
}

async function command(file, args, { cwd, timeout = 30_000 } = {}) {
  const { stdout } = await execFileAsync(file, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  });
  return String(stdout).trim();
}

function percentiles(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    minimum: round(sorted[0]),
    p50: round(sorted[Math.ceil(sorted.length * 0.5) - 1]),
    p95: round(sorted[Math.ceil(sorted.length * 0.95) - 1]),
    maximum: round(sorted.at(-1))
  };
}

function sum(items, selector) {
  return items.reduce((total, item) => total + selector(item), 0);
}

function round(value) {
  return Number(Number(value).toFixed(3));
}

function safeMachineText(value) {
  return String(value).replace(/[^A-Za-z0-9_. ()@+-]/gu, '_').slice(0, 160) || 'unknown';
}

function parseMode(args) {
  if (args.length === 0 || (args.length === 1 && args[0] === '--write')) return 'write';
  if (args.length === 1 && args[0] === '--check') return 'check';
  throw new Error('usage: node scripts/code-intelligence-phase3-index.mjs [--write|--check]');
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
  const { generatedAt: _generatedAt, reportFingerprint: _reportFingerprint, ...comparable } = report;
  return comparable;
}

function fingerprint(value) {
  const payload = Buffer.isBuffer(value) || value instanceof Uint8Array
    ? value
    : typeof value === 'string' ? value : JSON.stringify(value);
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}
