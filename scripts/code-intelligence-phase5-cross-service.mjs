import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { RustCodeIntelligenceProvider } from '../providers/native/code-intelligence-rust/src/index.mjs';

const OUTPUT = 'evals/code-intelligence/results/phase5-cross-service.json';
const PRIVATE_PATH = /(?:\/Users\/|\/home\/[A-Za-z0-9._-]+\/|\/private\/|\/var\/folders\/|[A-Za-z]:\\)/u;
const REPETITIONS = 5;
const QUERY_LIMIT = 32;
const QUERY_DEPTH = 4;
const QUERY_DEADLINE_MS = 2_000;
const WORKSPACE_ID = 'ws_phase5_cross_service';
const GATEWAY_PREFIX = 'workspace://services/gateway/';
const ORDERS_PREFIX = 'workspace://services/orders/';
const DECOY_PREFIX = 'workspace://services/zzz-decoy/';
const UNRESOLVED_PREFIX = 'workspace://services/missing/';
const IMPLEMENTATION_FILES = Object.freeze([
  'scripts/code-intelligence-phase5-cross-service.mjs',
  'rust/oaf-index/src/lib.rs',
  'rust/oaf/src/code_intelligence.rs',
  'rust/oaf/src/index_protocol.rs',
  'packages/protocol/schemas/code-intelligence-index-request.schema.json',
  'packages/protocol/schemas/code-intelligence-index-response.schema.json'
]);
const mode = parseMode(process.argv.slice(2));
const root = process.cwd();

if (mode === 'check') await checkStoredReport();
else await runBenchmark();

async function runBenchmark() {
  const binary = path.resolve(root, 'rust', 'target', 'release', process.platform === 'win32' ? 'oaf.exe' : 'oaf');
  if (!(await stat(binary)).isFile()) throw new Error('phase5_native_release_binary_missing');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-phase5-'));
  try {
    const workspace = path.join(temporary, 'workspace');
    const fixtureFingerprint = await writeFixture(workspace);
    const provider = new RustCodeIntelligenceProvider({
      binaryPath: binary,
      timeoutMs: 30_000,
      maxStdoutBytes: 8_000_000
    });
    const built = await provider.buildIndex({
      root: workspace,
      workspaceId: WORKSPACE_ID,
      languages: ['typescript'],
      maxFiles: 1_000,
      maxFileBytes: 512 * 1024,
      maxNodes: 100_000,
      maxEdges: 250_000
    });
    const indexPath = path.join(workspace, '.local', 'source-index', 'index.v1.sqlite');
    const beforeReads = await snapshot(indexPath);

    const processRuns = await repeat(() => provider.queryIndex({
      root: workspace,
      workspaceId: WORKSPACE_ID,
      kind: 'processes',
      depth: QUERY_DEPTH,
      limit: QUERY_LIMIT
    }));
    const firstProcesses = processRuns.results[0];
    const processNodes = new Map(firstProcesses.results.map((item) => [item.id, item]));
    const processRelationships = new Map(firstProcesses.relationships.map((item) => [item.id, item]));
    const crossServiceCall = firstProcesses.relationships.find((relationship) => {
      const from = processNodes.get(relationship.fromNodeId);
      const to = processNodes.get(relationship.toNodeId);
      return relationship.kind === 'calls'
        && from?.locator.startsWith(GATEWAY_PREFIX)
        && to?.locator.startsWith(ORDERS_PREFIX);
    });
    const targetNode = crossServiceCall === undefined
      ? undefined
      : processNodes.get(crossServiceCall.toNodeId);

    const traceRuns = targetNode === undefined
      ? emptyRepeated()
      : await repeat(() => provider.queryIndex({
        root: workspace,
        workspaceId: WORKSPACE_ID,
        kind: 'trace',
        query: 'GET',
        locator: targetNode.locator,
        depth: QUERY_DEPTH,
        limit: QUERY_LIMIT
      }));

    const dependencyRuns = await repeat(() => provider.queryIndex({
      root: workspace,
      workspaceId: WORKSPACE_ID,
      kind: 'dependencies',
      locator: 'workspace://services/gateway/app/api/orders/route.ts',
      direction: 'outbound',
      depth: 2,
      limit: QUERY_LIMIT
    }));
    const firstDependencies = dependencyRuns.results[0];
    const dependencyNodes = new Map(firstDependencies.results.map((item) => [item.id, item]));
    const crossServiceImport = firstDependencies.relationships.find((relationship) => {
      const from = dependencyNodes.get(relationship.fromNodeId);
      const to = dependencyNodes.get(relationship.toNodeId);
      return relationship.kind === 'imports'
        && from?.locator.startsWith(GATEWAY_PREFIX)
        && to?.locator.startsWith(ORDERS_PREFIX);
    });

    const sameNameRuns = await repeat(() => provider.queryIndex({
      root: workspace,
      workspaceId: WORKSPACE_ID,
      kind: 'search',
      query: 'handleOrder',
      limit: QUERY_LIMIT
    }));
    const firstSameName = sameNameRuns.results[0];
    const indexedCorrectTarget = firstSameName.results.find((item) =>
      item.label === 'handleOrder' && item.locator.startsWith(ORDERS_PREFIX));
    const indexedDecoyTarget = firstSameName.results.find((item) =>
      item.label === 'handleOrder' && item.locator.startsWith(DECOY_PREFIX));

    const unresolvedSeed = await provider.queryIndex({
      root: workspace,
      workspaceId: WORKSPACE_ID,
      kind: 'exact',
      query: 'probeMissing',
      limit: 1
    });
    const unresolvedRuns = unresolvedSeed.results.length === 0
      ? emptyRepeated()
      : await repeat(() => provider.queryIndex({
        root: workspace,
        workspaceId: WORKSPACE_ID,
        kind: 'dependencies',
        query: unresolvedSeed.results[0].id,
        direction: 'outbound',
        depth: 2,
        limit: QUERY_LIMIT
      }));
    const firstUnresolved = unresolvedRuns.results[0] ?? { results: [], relationships: [] };
    const afterReads = await snapshot(indexPath);

    const processFingerprints = processRuns.results.map(queryResultFingerprint);
    const traceFingerprints = traceRuns.results.map(queryResultFingerprint);
    const dependencyFingerprints = dependencyRuns.results.map(queryResultFingerprint);
    const sameNameFingerprints = sameNameRuns.results.map(queryResultFingerprint);
    const unresolvedFingerprints = unresolvedRuns.results.map(queryResultFingerprint);
    const referencedProcessEvidence = firstProcesses.processes.every((item) =>
      item.nodeIds.every((id) => processNodes.has(id))
      && item.relationshipIds.every((id) => processRelationships.has(id)));
    const decoyIds = new Set(firstProcesses.results
      .filter((item) => item.locator.startsWith(DECOY_PREFIX))
      .map((item) => item.id));
    const unresolvedProducedCrossServiceEvidence = firstUnresolved.results.some((item) =>
      item.locator.startsWith(UNRESOLVED_PREFIX))
      || firstUnresolved.relationships.some((item) => item.resolution !== 'unresolved');
    const allRuns = [processRuns, traceRuns, dependencyRuns, sameNameRuns, unresolvedRuns];
    const boundsHonored = allRuns.every((runs) => runs.results.every((result) =>
      result.results.length <= QUERY_LIMIT
      && result.relationships.length <= QUERY_LIMIT
      && (result.processes ?? []).every((item) =>
        item.nodeIds.length <= QUERY_DEPTH + 1 && item.relationshipIds.length <= QUERY_DEPTH)));
    const queryLatency = combineLatencies(allRuns.map((runs) => runs.wallMs));
    const readOnly = beforeReads.sha256 === afterReads.sha256
      && beforeReads.mtimeNs === afterReads.mtimeNs
      && allRuns.every((runs) => runs.results.every((result) =>
        result.safeguards.readOnly && result.safeguards.localFilesWritten === 0));

    const failures = [
      [firstProcesses.processes.length === 0, 'cross_service_process_missing'],
      [crossServiceCall === undefined, 'cross_service_call_missing'],
      [crossServiceImport === undefined, 'cross_service_import_missing'],
      [traceRuns.results.length === 0 || !traceRuns.results[0].relationships.some((item) => item.id === crossServiceCall?.id), 'cross_service_trace_missing'],
      [!referencedProcessEvidence, 'process_evidence_id_missing'],
      [indexedCorrectTarget === undefined, 'cross_service_target_not_indexed'],
      [indexedDecoyTarget === undefined, 'same_name_decoy_not_indexed'],
      [crossServiceCall !== undefined && (decoyIds.has(crossServiceCall.fromNodeId) || decoyIds.has(crossServiceCall.toNodeId)), 'same_name_decoy_selected'],
      [firstProcesses.results.some((item) => item.locator.startsWith(DECOY_PREFIX)), 'same_name_decoy_leaked_into_process'],
      [unresolvedProducedCrossServiceEvidence, 'unresolved_target_linked'],
      [new Set(processFingerprints).size !== 1, 'processes_not_deterministic'],
      [new Set(traceFingerprints).size > 1, 'trace_not_deterministic'],
      [new Set(dependencyFingerprints).size !== 1, 'dependencies_not_deterministic'],
      [new Set(sameNameFingerprints).size !== 1, 'same_name_search_not_deterministic'],
      [new Set(unresolvedFingerprints).size > 1, 'unresolved_query_not_deterministic'],
      [!boundsHonored, 'query_bounds_not_honored'],
      [queryLatency.p95 > QUERY_DEADLINE_MS, 'query_latency_gate_failed'],
      [!readOnly, 'read_query_mutated_index']
    ].filter(([failed]) => failed).map(([, code]) => code);

    const report = {
      schemaVersion: '1.0.0',
      reportVersion: 'memory-recall-code-intelligence-phase5-cross-service-1',
      phase: 5,
      generatedAt: new Date().toISOString(),
      environment: {
        platform: os.platform(),
        architecture: os.arch(),
        nodeVersion: process.version
      },
      inputs: {
        fixtureRef: `fixture://${fixtureFingerprint}`,
        fixtureFingerprint,
        implementationFingerprint: await filesFingerprint(IMPLEMENTATION_FILES),
        workspaceId: WORKSPACE_ID,
        serviceBoundaries: [
          { name: '@fixture/gateway', prefix: GATEWAY_PREFIX },
          { name: '@fixture/orders', prefix: ORDERS_PREFIX },
          { name: '@fixture/zzz-decoy', prefix: DECOY_PREFIX }
        ],
        repetitions: REPETITIONS,
        queryLimit: QUERY_LIMIT,
        queryDepth: QUERY_DEPTH,
        queryDeadlineMs: QUERY_DEADLINE_MS
      },
      index: {
        repositoryIdentityHash: built.repositoryIdentityHash,
        fileCount: built.summary.fileCount,
        nodeCount: built.summary.nodeCount,
        edgeCount: built.summary.edgeCount,
        databaseBytes: built.summary.databaseBytes
      },
      results: {
        processCount: firstProcesses.processes.length,
        crossServiceCallEvidenceId: crossServiceCall?.id ?? null,
        crossServiceImportEvidenceId: crossServiceImport?.id ?? null,
        crossServiceTraceRelationshipIds: traceRuns.results[0]?.relationships.map((item) => item.id) ?? [],
        sameNameDecoyIndexed: indexedDecoyTarget !== undefined,
        sameNameDecoyExcluded: indexedDecoyTarget !== undefined
          && !firstProcesses.results.some((item) => item.locator.startsWith(DECOY_PREFIX)),
        unresolvedTargetExcluded: !unresolvedProducedCrossServiceEvidence,
        evidenceIdsComplete: referencedProcessEvidence,
        bounded: boundsHonored,
        deterministicFingerprint: fingerprint({
          processFingerprints,
          traceFingerprints,
          dependencyFingerprints,
          sameNameFingerprints,
          unresolvedFingerprints
        }),
        queryWallMs: queryLatency,
        readQueriesPreservedIndex: readOnly
      },
      failures,
      gateDecision: failures.length === 0 ? 'pass' : 'fail',
      claims: {
        crossServiceMonorepoFixture: failures.length === 0,
        multiRepository: false,
        competitorParity: false,
        leadership: false,
        millionNodeScale: false,
        reason: 'This bounded local fixture proves source-backed import, call, trace, and process evidence across two declared service prefixes inside one repository. It does not prove independent repository indexes, a repository registry, cross-repository search, competitor parity, leadership, or large-scale behavior.'
      },
      safeguards: {
        networkCalls: 0,
        modelCalls: 0,
        canonicalMemoryWrites: 0,
        rawSourceStoredInReport: false,
        absolutePathsStoredInReport: false
      }
    };
    if (PRIVATE_PATH.test(JSON.stringify(report))) throw new Error('phase5_private_path_leak');
    report.reportFingerprint = fingerprint(comparableReport(report));
    await atomicWrite(OUTPUT, report);
    console.log(`Phase 5 cross-service benchmark wrote ${OUTPUT}: ${failures.length} failures.`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function fixtureFiles() {
  return new Map([
    ['package.json', JSON.stringify({ name: 'phase5-cross-service-fixture', private: true, workspaces: ['services/*'] }, null, 2)],
    ['services/gateway/package.json', JSON.stringify({ name: '@fixture/gateway', private: true }, null, 2)],
    ['services/orders/package.json', JSON.stringify({ name: '@fixture/orders', private: true }, null, 2)],
    ['services/zzz-decoy/package.json', JSON.stringify({ name: '@fixture/zzz-decoy', private: true }, null, 2)],
    ['services/gateway/app/api/orders/route.ts', [
      "import { handleOrder } from '../../../../orders/src/handler.js';",
      'export function GET() {',
      '  return handleOrder();',
      '}'
    ].join('\n')],
    ['services/orders/src/handler.ts', [
      'export function handleOrder() {',
      '  return persistOrder();',
      '}',
      'function persistOrder() {',
      "  return 'stored';",
      '}'
    ].join('\n')],
    ['services/zzz-decoy/src/handler.ts', [
      'export class DecoyHandler {',
      '  handleOrder() {',
      "    return 'decoy';",
      '  }',
      '}'
    ].join('\n')],
    ['services/gateway/src/unresolved.ts', [
      "import { missingHandler } from '../../missing/src/handler.js';",
      'export function probeMissing() {',
      '  return missingHandler();',
      '}'
    ].join('\n')]
  ]);
}

async function writeFixture(workspace) {
  const files = fixtureFiles();
  for (const [relative, content] of files) {
    const target = path.join(workspace, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${content}\n`);
  }
  return fingerprint([...files].sort(([left], [right]) => left.localeCompare(right)));
}

async function repeat(operation) {
  const results = [];
  const samples = [];
  for (let index = 0; index < REPETITIONS; index += 1) {
    const started = performance.now();
    results.push(await operation());
    samples.push(performance.now() - started);
  }
  return { results, wallMs: percentiles(samples) };
}

function emptyRepeated() {
  return { results: [], wallMs: percentiles([]) };
}

function queryResultFingerprint(result) {
  return fingerprint({
    repositoryIdentityHash: result.repositoryIdentityHash,
    activeGeneration: result.activeGeneration,
    results: result.results.map((item) => item.id),
    relationships: result.relationships.map((item) => item.id),
    processes: result.processes ?? []
  });
}

async function snapshot(file) {
  const [bytes, metadata] = await Promise.all([readFile(file), stat(file, { bigint: true })]);
  return { sha256: fingerprint(bytes), mtimeNs: metadata.mtimeNs.toString() };
}

async function filesFingerprint(files) {
  return fingerprint(await Promise.all(files.map(async (file) => [file, await readFile(path.resolve(root, file), 'utf8')])));
}

async function checkStoredReport() {
  const report = JSON.parse(await readFile(path.resolve(root, OUTPUT), 'utf8'));
  if (report.reportFingerprint !== fingerprint(comparableReport(report))) throw new Error('phase5_report_fingerprint_invalid');
  if (report.inputs.fixtureFingerprint !== fingerprint([...fixtureFiles()].sort(([left], [right]) => left.localeCompare(right)))) throw new Error('phase5_fixture_fingerprint_stale');
  if (report.inputs.implementationFingerprint !== await filesFingerprint(IMPLEMENTATION_FILES)) throw new Error('phase5_implementation_fingerprint_stale');
  if (report.gateDecision !== 'pass' || report.failures.length !== 0) throw new Error('phase5_gate_not_passing');
  if (!report.results.readQueriesPreservedIndex || !report.results.evidenceIdsComplete || !report.results.bounded) throw new Error('phase5_evidence_gate_not_passing');
  if (!report.results.sameNameDecoyIndexed || !report.results.sameNameDecoyExcluded || !report.results.unresolvedTargetExcluded) throw new Error('phase5_negative_gate_not_passing');
  if (!report.claims.crossServiceMonorepoFixture || report.claims.multiRepository || report.claims.competitorParity || report.claims.leadership || report.claims.millionNodeScale) throw new Error('phase5_claim_boundary_invalid');
  if (PRIVATE_PATH.test(JSON.stringify(report))) throw new Error('phase5_private_path_leak');
  console.log(`Phase 5 cross-service evidence is current: ${report.results.processCount} processes, multi-repository claim disabled.`);
}

function comparableReport(report) {
  const { reportFingerprint: _fingerprint, generatedAt: _generatedAt, ...comparable } = report;
  return comparable;
}

function combineLatencies(latencies) {
  const values = latencies.filter((value) => Number.isFinite(value.maximum));
  if (values.length === 0) return percentiles([]);
  return {
    minimum: round(Math.min(...values.map((value) => value.minimum))),
    p50: round(Math.max(...values.map((value) => value.p50))),
    p95: round(Math.max(...values.map((value) => value.p95))),
    maximum: round(Math.max(...values.map((value) => value.maximum)))
  };
}

function percentiles(values) {
  if (values.length === 0) return { minimum: null, p50: null, p95: null, maximum: null };
  const sorted = [...values].sort((left, right) => left - right);
  return {
    minimum: round(sorted[0]),
    p50: round(sorted[Math.ceil(sorted.length * 0.5) - 1]),
    p95: round(sorted[Math.ceil(sorted.length * 0.95) - 1]),
    maximum: round(sorted.at(-1))
  };
}

function round(value) {
  return Number(value.toFixed(3));
}

function fingerprint(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function parseMode(args) {
  if (args.length === 0 || (args.length === 1 && args[0] === '--write')) return 'write';
  if (args.length === 1 && args[0] === '--check') return 'check';
  throw new Error('usage: node scripts/code-intelligence-phase5-cross-service.mjs [--write|--check]');
}

async function atomicWrite(file, value) {
  const target = path.resolve(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}
