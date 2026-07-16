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
    const beforeReads = await snapshot(indexPath);
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
    const afterReads = await snapshot(indexPath);
    const firstCommunities = communityRuns.results[0];
    const firstProcesses = processRuns.results[0];
    const projectionFingerprints = [
      ...communityRuns.results.map(projectedResultFingerprint),
      ...processRuns.results.map(projectedResultFingerprint)
    ];
    const processRelationshipIds = new Set(firstProcesses.relationships.map((item) => item.id));
    const processNodeIds = new Set(firstProcesses.results.map((item) => item.id));
    const failures = [
      [firstCommunities.communities.length === 0, 'communities_missing'],
      [firstProcesses.processes.length === 0, 'processes_missing'],
      [new Set(communityRuns.results.map(projectedResultFingerprint)).size !== 1, 'communities_not_deterministic'],
      [new Set(processRuns.results.map(projectedResultFingerprint)).size !== 1, 'processes_not_deterministic'],
      [beforeReads.sha256 !== afterReads.sha256 || beforeReads.mtimeNs !== afterReads.mtimeNs, 'read_query_mutated_index'],
      [communityRuns.wallMs.p95 > QUERY_DEADLINE_MS, 'communities_latency_gate_failed'],
      [processRuns.wallMs.p95 > QUERY_DEADLINE_MS, 'processes_latency_gate_failed'],
      [!firstProcesses.processes.every((item) => item.nodeIds.every((id) => processNodeIds.has(id))), 'process_node_evidence_missing'],
      [!firstProcesses.processes.every((item) => item.relationshipIds.every((id) => processRelationshipIds.has(id))), 'process_relationship_evidence_missing'],
      [!firstProcesses.relationships.some((item) => item.kind === 'handles_route'), 'entry_evidence_missing'],
      [!firstProcesses.relationships.some((item) => item.kind === 'calls'), 'execution_evidence_missing']
    ].filter(([failed]) => failed).map(([, code]) => code);
    const report = {
      schemaVersion: '1.0.0',
      reportVersion: 'memory-recall-code-intelligence-phase4-intelligence-1',
      phase: 4,
      generatedAt: new Date().toISOString(),
      environment: {
        platform: os.platform(),
        architecture: os.arch(),
        nodeVersion: process.version
      },
      inputs: {
        fixtureRef: `fixture://${fixtureFingerprint}`,
        implementationFingerprint: await filesFingerprint([
          'rust/oaf-index/src/lib.rs',
          'rust/oaf/src/index_protocol.rs',
          'packages/protocol/schemas/code-intelligence-index-request.schema.json',
          'packages/protocol/schemas/code-intelligence-index-response.schema.json'
        ]),
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
        communityAlgorithm: 'label-propagation-v1',
        processAlgorithm: 'entry-path-v1',
        communityQueryWallMs: communityRuns.wallMs,
        processQueryWallMs: processRuns.wallMs,
        deterministicProjectionFingerprint: fingerprint(projectionFingerprints),
        readQueriesPreservedIndex: beforeReads.sha256 === afterReads.sha256 && beforeReads.mtimeNs === afterReads.mtimeNs,
        evidenceComplete: failures.every((code) => !code.endsWith('_evidence_missing'))
      },
      failures,
      gateDecision: failures.length === 0 ? 'pass' : 'fail',
      claims: {
        phase4IntelligenceProven: failures.length === 0,
        competitorParity: false,
        leadership: false,
        millionNodeScale: false,
        reason: 'This local fixture gate proves deterministic bounded communities, entry-to-sink processes, evidence integrity, read-only behavior, and the two-second query deadline. It does not measure competitors, packaged native binaries, multi-repository behavior, or million-node scale.'
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
      'export function GET() { return handleUser(); }',
      'function handleUser() { return persistUser(); }',
      'function persistUser() { return { ok: true }; }'
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

async function snapshot(file) {
  const [bytes, metadata] = await Promise.all([readFile(file), stat(file, { bigint: true })]);
  return { sha256: fingerprint(bytes), mtimeNs: metadata.mtimeNs.toString() };
}

async function filesFingerprint(files) {
  return fingerprint(await Promise.all(files.map(async (file) => [file, await readFile(path.resolve(root, file), 'utf8')])));
}

async function checkStoredReport() {
  const report = JSON.parse(await readFile(path.resolve(root, OUTPUT), 'utf8'));
  if (report.reportFingerprint !== fingerprint(comparableReport(report))) throw new Error('phase4_report_fingerprint_invalid');
  if (report.gateDecision !== 'pass' || report.failures.length !== 0) throw new Error('phase4_gate_not_passing');
  if (!report.results.readQueriesPreservedIndex || !report.results.evidenceComplete) throw new Error('phase4_evidence_gate_not_passing');
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
