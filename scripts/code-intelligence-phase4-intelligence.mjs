import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { RustCodeIntelligenceProvider } from '../providers/native/code-intelligence-rust/src/index.mjs';

const OUTPUT = 'evals/code-intelligence/results/phase4-intelligence.json';
const PRIVATE_PATH = /(?:\/Users\/|\/home\/[A-Za-z0-9._-]+\/|\/private\/|\/var\/folders\/|[A-Za-z]:\\)/u;
const REPETITIONS = 5;
const QUERY_LIMIT = 50;
const QUERY_DEADLINE_MS = 2_000;
const PROCESS_SINK_KINDS = new Set(['route', 'handler', 'storage', 'queue', 'event', 'sink', 'reads', 'writes', 'emits', 'listens']);
const IMPLEMENTATION_FILES = Object.freeze([
  'scripts/code-intelligence-phase4-intelligence.mjs',
  'providers/native/code-intelligence-rust/src/index.mjs',
  'rust/oaf-ingest/src/lib.rs',
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
  if (!(await stat(binary)).isFile()) throw new Error('phase4_native_release_binary_missing');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-phase4-'));
  try {
    const workspace = path.join(temporary, 'workspace');
    const fixtureFingerprint = await writeFixture(workspace);
    const provider = new RustCodeIntelligenceProvider({
      binaryPath: binary,
      timeoutMs: 30_000,
      maxStdoutBytes: 8_000_000
    });
    const workspaceId = 'ws_phase4_intelligence';
    const built = await provider.buildIndex({
      root: workspace,
      workspaceId,
      languages: ['typescript'],
      maxFiles: 1_000,
      maxFileBytes: 512 * 1024,
      maxNodes: 100_000,
      maxEdges: 250_000
    });
    const indexPath = path.join(workspace, '.local', 'source-index', 'index.v1.sqlite');
    const beforeReads = await sqliteBundleSnapshot(indexPath);
    const communityRuns = await repeat(() => provider.queryIndex({
      root: workspace,
      workspaceId,
      kind: 'communities',
      limit: QUERY_LIMIT
    }));
    const processRuns = await repeat(() => provider.queryIndex({
      root: workspace,
      workspaceId,
      kind: 'processes',
      depth: 4,
      limit: QUERY_LIMIT
    }));
    const routeRuns = await repeat(() => provider.queryIndex({
      root: workspace,
      workspaceId,
      kind: 'routes',
      limit: QUERY_LIMIT
    }));
    const impactRuns = await repeat(() => provider.queryIndex({
      root: workspace,
      workspaceId,
      kind: 'impact',
      query: 'persistUser',
      depth: 4,
      limit: QUERY_LIMIT
    }));
    const searchRuns = await repeat(() => provider.queryIndex({
      root: workspace,
      workspaceId,
      kind: 'search',
      query: 'handleUser',
      limit: 3
    }));
    const afterReads = await sqliteBundleSnapshot(indexPath);
    const readQueriesPreservedIndex = sameSnapshots(beforeReads, afterReads);
    const firstCommunities = communityRuns.results[0];
    const firstProcesses = processRuns.results[0];
    const firstRoutes = routeRuns.results[0];
    const firstImpact = impactRuns.results[0];
    const firstSearch = searchRuns.results[0];
    const projectionFingerprints = [
      ...communityRuns.results.map(projectedResultFingerprint),
      ...processRuns.results.map(projectedResultFingerprint),
      ...routeRuns.results.map(projectedResultFingerprint),
      ...impactRuns.results.map(projectedResultFingerprint),
      ...searchRuns.results.map(projectedResultFingerprint)
    ];
    const representativeProcess = representativeProcessEvidence(firstProcesses);
    const representativeRoute = representativeRouteEvidence(firstRoutes);
    const representativeImpact = representativeImpactEvidence(firstImpact, 'persistUser');
    const representativeSearch = representativeSearchEvidence(firstSearch, 'handleUser', 'handleUserUtility');
    const confidenceEvidence = confidenceSemanticsEvidence({
      processResult: firstProcesses,
      representativeProcess,
      representativeRoute,
      representativeImpact
    });
    const processRelationshipIds = new Set(firstProcesses.relationships.map((item) => item.id));
    const processNodeIds = new Set(firstProcesses.results.map((item) => item.id));
    const failures = [
      [firstCommunities.communities.length === 0, 'communities_missing'],
      [firstProcesses.processes.length === 0, 'processes_missing'],
      [new Set(communityRuns.results.map(projectedResultFingerprint)).size !== 1, 'communities_not_deterministic'],
      [new Set(processRuns.results.map(projectedResultFingerprint)).size !== 1, 'processes_not_deterministic'],
      [new Set(routeRuns.results.map(projectedResultFingerprint)).size !== 1, 'routes_not_deterministic'],
      [new Set(impactRuns.results.map(projectedResultFingerprint)).size !== 1, 'impact_not_deterministic'],
      [new Set(searchRuns.results.map(projectedResultFingerprint)).size !== 1, 'search_not_deterministic'],
      [!readQueriesPreservedIndex, 'read_query_mutated_index'],
      [communityRuns.wallMs.p95 > QUERY_DEADLINE_MS, 'communities_latency_gate_failed'],
      [processRuns.wallMs.p95 > QUERY_DEADLINE_MS, 'processes_latency_gate_failed'],
      [routeRuns.wallMs.p95 > QUERY_DEADLINE_MS, 'routes_latency_gate_failed'],
      [impactRuns.wallMs.p95 > QUERY_DEADLINE_MS, 'impact_latency_gate_failed'],
      [searchRuns.wallMs.p95 > QUERY_DEADLINE_MS, 'search_latency_gate_failed'],
      [!firstProcesses.processes.every((item) => item.nodeIds.every((id) => processNodeIds.has(id))), 'process_node_evidence_missing'],
      [!firstProcesses.processes.every((item) => item.relationshipIds.every((id) => processRelationshipIds.has(id))), 'process_relationship_evidence_missing'],
      [representativeProcess === null, 'ordered_entry_to_sink_process_missing'],
      [representativeRoute === null, 'route_evidence_missing'],
      [representativeImpact === null, 'impact_evidence_missing'],
      [representativeSearch === null, 'hybrid_search_evidence_missing'],
      [confidenceEvidence === null, 'confidence_semantics_missing']
    ].filter(([failed]) => failed).map(([, code]) => code);
    const report = {
      schemaVersion: '1.0.0',
      reportVersion: 'memory-recall-code-intelligence-phase4-intelligence-4',
      phase: 4,
      generatedAt: new Date().toISOString(),
      environment: {
        platform: os.platform(),
        architecture: os.arch(),
        nodeVersion: process.version
      },
      inputs: {
        fixtureRef: `fixture://${fixtureFingerprint}`,
        implementationFingerprint: await filesFingerprint(IMPLEMENTATION_FILES),
        repetitions: REPETITIONS,
        queryLimit: QUERY_LIMIT,
        queryDeadlineMs: QUERY_DEADLINE_MS
      },
      index: {
        fileCount: built.summary.fileCount,
        nodeCount: built.summary.nodeCount,
        edgeCount: built.summary.edgeCount,
        databaseBytes: built.summary.databaseBytes
      },
      results: {
        communityCount: firstCommunities.communities.length,
        processCount: firstProcesses.processes.length,
        routeCount: firstRoutes.results.length,
        impactNodeCount: firstImpact.results.length,
        impactRelationshipCount: firstImpact.relationships.length,
        communityAlgorithm: 'label-propagation-v1',
        processAlgorithm: 'entry-path-v1',
        communityQueryWallMs: communityRuns.wallMs,
        processQueryWallMs: processRuns.wallMs,
        routeQueryWallMs: routeRuns.wallMs,
        impactQueryWallMs: impactRuns.wallMs,
        searchQueryWallMs: searchRuns.wallMs,
        deterministicProjectionFingerprint: fingerprint(projectionFingerprints),
        readQueriesPreservedIndex,
        evidenceComplete: [representativeProcess, representativeRoute, representativeImpact, representativeSearch, confidenceEvidence].every((item) => item !== null)
          && failures.every((code) => !code.endsWith('_evidence_missing')),
        representativeProcess,
        representativeRoute,
        representativeImpact,
        representativeSearch,
        confidenceEvidence
      },
      failures,
      gateDecision: failures.length === 0 ? 'pass' : 'fail',
      claims: {
        phase4EvidenceSliceProven: failures.length === 0,
        phase4IntelligenceProven: false,
        competitorParity: false,
        leadership: false,
        millionNodeScale: false,
        reason: 'This local fixture gate proves deterministic bounded exact, lexical, and one-hop structural search; communities; entry-to-sink processes; route evidence; reverse impact; confidence propagation; read-only behavior; and the two-second query deadline. It does not prove constrained graph queries, competitor parity, packaged native binaries, multi-repository behavior, or million-node scale.'
      },
      safeguards: {
        networkCalls: 0,
        modelCalls: 0,
        canonicalMemoryWrites: 0,
        rawSourceStoredInReport: false,
        absolutePathsStoredInReport: false
      }
    };
    if (PRIVATE_PATH.test(JSON.stringify(report))) throw new Error('phase4_private_path_leak');
    report.reportFingerprint = fingerprint(comparableReport(report));
    await atomicWrite(OUTPUT, report);
    console.log(`Phase 4 intelligence benchmark wrote ${OUTPUT}: ${failures.length} failures.`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function writeFixture(workspace) {
  const files = new Map([
    ['app/api/users/route.ts', [
      "import http from 'node:http';",
      'export function GET() { return handleUser(); }',
      'function handleUser() { return persistUser(); }',
      'function handleUserUtility() { return true; }',
      'function persistUser() { return { ok: true }; }',
      'http.createServer(persistUser);'
    ].join('\n')],
    ['packages/auth/session.ts', 'export function readSession() { return validateSession(); }\nfunction validateSession() { return true; }\n'],
    ['packages/billing/invoice.ts', 'export function createInvoice() { return priceInvoice(); }\nfunction priceInvoice() { return 1; }\n'],
    ['packages/search/query.ts', 'export function runQuery() { return rankQuery(); }\nfunction rankQuery() { return []; }\n']
  ]);
  for (const [relative, content] of files) {
    const target = path.join(workspace, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return fingerprint([...files].sort(([left], [right]) => left.localeCompare(right)));
}

async function repeat(operation) {
  const results = [];
  const wallMs = [];
  for (let index = 0; index < REPETITIONS; index += 1) {
    const started = performance.now();
    results.push(await operation());
    wallMs.push(performance.now() - started);
  }
  return { results, wallMs: percentiles(wallMs) };
}

function projectedResultFingerprint(result) {
  return fingerprint({
    results: result.results.map((item) => item.id),
    relationships: result.relationships.map((item) => item.id),
    communities: result.communities ?? [],
    processes: result.processes ?? []
  });
}

function representativeProcessEvidence(result) {
  const relationships = new Map(result.relationships.map((item) => [item.id, item]));
  for (const process of result.processes) {
    if (process.truncated || !PROCESS_SINK_KINDS.has(process.sinkKind)) continue;
    if (process.nodeIds[0] !== process.entryNodeId || process.nodeIds.at(-1) !== process.sinkNodeId) continue;
    if (process.relationshipIds[0] !== process.entryRelationshipId) continue;
    const entry = relationships.get(process.entryRelationshipId);
    if (!entry || entry.fromNodeId !== process.entryNodeId) continue;
    const executionSteps = process.relationshipIds.slice(1).map((relationshipId) => relationships.get(relationshipId));
    if (executionSteps.length !== process.nodeIds.length - 1 || executionSteps.some((item) => item === undefined)) continue;
    if (!executionSteps.every((item, index) => (
      item.fromNodeId === process.nodeIds[index] && item.toNodeId === process.nodeIds[index + 1]
    ))) continue;
    return {
      processId: process.id,
      entryNodeId: process.entryNodeId,
      entryRelationshipId: process.entryRelationshipId,
      sinkNodeId: process.sinkNodeId,
      sinkKind: process.sinkKind,
      nodeIds: process.nodeIds,
      relationshipIds: process.relationshipIds,
      confidence: process.confidence,
      truncated: process.truncated,
      entryEvidence: {
        relationshipId: entry.id,
        kind: entry.kind,
        fromNodeId: entry.fromNodeId,
        toNodeId: entry.toNodeId,
        confidence: entry.confidence,
        resolution: entry.resolution
      },
      executionSteps: executionSteps.map((item) => ({
        relationshipId: item.id,
        kind: item.kind,
        fromNodeId: item.fromNodeId,
        toNodeId: item.toNodeId,
        confidence: item.confidence,
        resolution: item.resolution
      }))
    };
  }
  return null;
}

function representativeRouteEvidence(result) {
  for (const route of result.results) {
    if (route.kind !== 'route') continue;
    const relationship = result.relationships.find((item) => (
      ['entry_point', 'handles_route'].includes(item.kind)
      && (item.fromNodeId === route.id || item.toNodeId === route.id)
    ));
    if (!relationship) continue;
    return {
      routeNodeId: route.id,
      routeLabel: route.label,
      routeLocator: route.locator,
      relationshipId: relationship.id,
      relationshipKind: relationship.kind,
      fromNodeId: relationship.fromNodeId,
      toNodeId: relationship.toNodeId,
      confidence: relationship.confidence,
      resolution: relationship.resolution
    };
  }
  return null;
}

function representativeImpactEvidence(result, seedLabel) {
  const seed = result.results.find((item) => item.label === seedLabel);
  if (!seed) return null;
  const relationship = result.relationships.find((item) => item.toNodeId === seed.id);
  if (!relationship) return null;
  const dependant = result.results.find((item) => item.id === relationship.fromNodeId);
  if (!dependant) return null;
  return {
    seedNodeId: seed.id,
    seedLabel: seed.label,
    dependantNodeId: dependant.id,
    dependantLabel: dependant.label,
    relationshipId: relationship.id,
    relationshipKind: relationship.kind,
    confidence: relationship.confidence,
    resolution: relationship.resolution
  };
}

function representativeSearchEvidence(result, exactLabel, lexicalLabel) {
  const [exact, lexical, neighbor] = result.results;
  if (exact?.label !== exactLabel || lexical?.label !== lexicalLabel || !neighbor) return null;
  const resultIds = new Set(result.results.map((item) => item.id));
  const relationship = result.relationships.find((item) => (
    resultIds.has(item.fromNodeId)
    && resultIds.has(item.toNodeId)
    && Number.isFinite(item.confidence)
    && item.confidence > 0
    && item.locator.startsWith('workspace://')
  ));
  if (!relationship) return null;
  return {
    exactNodeId: exact.id,
    exactLabel: exact.label,
    lexicalNodeId: lexical.id,
    lexicalLabel: lexical.label,
    neighborNodeId: neighbor.id,
    neighborLabel: neighbor.label,
    relationshipId: relationship.id,
    relationshipKind: relationship.kind,
    confidence: relationship.confidence,
    locator: relationship.locator
  };
}

function confidenceSemanticsEvidence({ processResult, representativeProcess, representativeRoute, representativeImpact }) {
  if (!representativeProcess || !representativeRoute || !representativeImpact) return null;
  const relationships = new Map(processResult.relationships.map((item) => [item.id, item]));
  const path = representativeProcess.relationshipIds.map((id) => relationships.get(id));
  if (path.some((item) => item === undefined)) return null;
  const values = [
    ...path.map((item) => item.confidence),
    representativeRoute.confidence,
    representativeImpact.confidence
  ];
  if (values.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) return null;
  const minimumPathConfidence = Math.min(...path.map((item) => item.confidence));
  if (minimumPathConfidence !== representativeProcess.confidence) return null;
  return {
    range: [0, 1],
    routeConfidence: representativeRoute.confidence,
    impactConfidence: representativeImpact.confidence,
    processRelationshipConfidences: path.map((item) => item.confidence),
    processMinimumConfidence: minimumPathConfidence,
    processReportedConfidence: representativeProcess.confidence,
    processUsesMinimumRelationshipConfidence: true
  };
}

async function snapshot(file) {
  const [bytes, metadata] = await Promise.all([readFile(file), stat(file, { bigint: true })]);
  return { sha256: fingerprint(bytes), size: metadata.size.toString(), mtimeNs: metadata.mtimeNs.toString() };
}

async function sqliteBundleSnapshot(file) {
  return Promise.all([file, `${file}-wal`, `${file}-shm`].map(async (candidate) => {
    try {
      return await snapshot(candidate);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }));
}

function sameSnapshots(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function filesFingerprint(files) {
  return fingerprint(await Promise.all(files.map(async (file) => [file, await readFile(path.resolve(root, file), 'utf8')])));
}

async function checkStoredReport() {
  const report = JSON.parse(await readFile(path.resolve(root, OUTPUT), 'utf8'));
  if (report.reportFingerprint !== fingerprint(comparableReport(report))) throw new Error('phase4_report_fingerprint_invalid');
  if (report.inputs.implementationFingerprint !== await filesFingerprint(IMPLEMENTATION_FILES)) throw new Error('phase4_implementation_fingerprint_stale');
  if (report.gateDecision !== 'pass' || report.failures.length !== 0) throw new Error('phase4_gate_not_passing');
  if (!report.results.readQueriesPreservedIndex || !report.results.evidenceComplete) throw new Error('phase4_evidence_gate_not_passing');
  if (report.results.representativeProcess?.truncated !== false || !PROCESS_SINK_KINDS.has(report.results.representativeProcess?.sinkKind)) throw new Error('phase4_representative_sink_invalid');
  for (const key of ['communityQueryWallMs', 'processQueryWallMs', 'routeQueryWallMs', 'impactQueryWallMs', 'searchQueryWallMs']) {
    if (!Number.isFinite(report.results[key]?.p95) || report.results[key].p95 > report.inputs.queryDeadlineMs) throw new Error('phase4_query_deadline_failed');
  }
  if (!report.results.representativeRoute || !report.results.representativeImpact || !report.results.representativeSearch) throw new Error('phase4_structural_evidence_missing');
  if (report.results.confidenceEvidence?.processUsesMinimumRelationshipConfidence !== true) throw new Error('phase4_confidence_evidence_missing');
  if (!report.claims.phase4EvidenceSliceProven || report.claims.phase4IntelligenceProven) throw new Error('phase4_completion_claim_invalid');
  if (report.claims.competitorParity || report.claims.leadership || report.claims.millionNodeScale) throw new Error('phase4_claim_boundary_invalid');
  if (PRIVATE_PATH.test(JSON.stringify(report))) throw new Error('phase4_private_path_leak');
  console.log(`Phase 4 intelligence evidence is current: ${report.results.communityCount} communities, ${report.results.processCount} processes.`);
}

function comparableReport(report) {
  const { reportFingerprint: _fingerprint, generatedAt: _generatedAt, ...comparable } = report;
  return comparable;
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
  throw new Error('usage: node scripts/code-intelligence-phase4-intelligence.mjs [--write|--check]');
}

async function atomicWrite(file, value) {
  const target = path.resolve(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}
