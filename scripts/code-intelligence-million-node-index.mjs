import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { validateJsonSchema } from '../packages/protocol/src/schema-validator.mjs';
import requestSchema from '../packages/protocol/schemas/code-intelligence-index-request.schema.json' with { type: 'json' };
import responseSchema from '../packages/protocol/schemas/code-intelligence-index-response.schema.json' with { type: 'json' };
import { resolveNativeBinary } from '../providers/native/code-intelligence-rust/src/binary-resolver.mjs';
import { peakRssMb, timedSpawn } from './timing.mjs';

const OUTPUT = 'evals/code-intelligence/results/million-node-rust-index.json';
const INDEX_RELATIVE = '.local/source-index/index.v1.sqlite';
const PRIVATE_PATH = /(?:\/Users\/|\/home\/[A-Za-z0-9._-]+\/|\/private\/|\/var\/folders\/|[A-Za-z]:\\)/u;
const WORKSPACE_ID = 'ws_million_node_index';
const FIXED_NOW = '2026-07-17T00:00:00.000Z';
const BUILD_DEADLINE_MS = 300_000;
const READER_DEADLINE_MS = 2_000;
const QUERY_REPETITIONS = 20;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_NODES = 1_000_000;
const MAX_EDGES = 1_000_000;
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createDenseFixturePlan({ fileCount = 10, methodsPerFile = 99_997 } = {}) {
  if (!Number.isInteger(fileCount) || fileCount < 1 || fileCount > 1_000_000) {
    throw new Error('million_node_fixture_file_count_invalid');
  }
  if (!Number.isInteger(methodsPerFile) || methodsPerFile < 1) {
    throw new Error('million_node_fixture_method_count_invalid');
  }
  const expectedNodeCount = fileCount * (3 + methodsPerFile);
  const expectedEdgeCount = fileCount * (2 + methodsPerFile);
  if (!Number.isSafeInteger(expectedNodeCount) || expectedNodeCount > MAX_NODES) {
    throw new Error('million_node_fixture_node_count_invalid');
  }
  if (!Number.isSafeInteger(expectedEdgeCount) || expectedEdgeCount > MAX_EDGES) {
    throw new Error('million_node_fixture_edge_count_invalid');
  }
  return Object.freeze({
    language: 'javascript',
    fileCount,
    methodsPerFile,
    expectedNodeCount,
    expectedEdgeCount,
    maxFileBytes: MAX_FILE_BYTES,
    maxNodes: MAX_NODES,
    maxEdges: MAX_EDGES,
    seedQuery: 'C_m0'
  });
}

export const MILLION_NODE_PLAN = createDenseFixturePlan();

export async function writeDenseFixture(workspace, plan = MILLION_NODE_PLAN) {
  const source = path.join(workspace, 'src');
  await mkdir(source, { recursive: true });
  const hash = createHash('sha256');
  let totalSourceBytes = 0;
  let maxSourceFileBytes = 0;
  for (let fileIndex = 0; fileIndex < plan.fileCount; fileIndex += 1) {
    const name = `dense-${String(fileIndex).padStart(4, '0')}.js`;
    const methods = Array.from(
      { length: plan.methodsPerFile },
      (_, methodIndex) => `m${methodIndex.toString(36)}(){}\n`
    ).join('');
    const body = `class C{\n${methods}}\n`;
    const bytes = Buffer.byteLength(body);
    if (bytes > plan.maxFileBytes) throw new Error('million_node_fixture_file_too_large');
    await writeFile(path.join(source, name), body, { mode: 0o600 });
    hash.update(name).update('\0').update(body).update('\0');
    totalSourceBytes += bytes;
    maxSourceFileBytes = Math.max(maxSourceFileBytes, bytes);
  }
  return Object.freeze({
    ref: `fixture://sha256:${hash.digest('hex')}`,
    language: plan.language,
    fileCount: plan.fileCount,
    methodsPerFile: plan.methodsPerFile,
    expectedNodeCount: plan.expectedNodeCount,
    expectedEdgeCount: plan.expectedEdgeCount,
    totalSourceBytes,
    maxSourceFileBytes
  });
}

export async function runMillionNodeBenchmark({ root = REPOSITORY_ROOT } = {}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-million-node-'));
  const workspace = path.join(temporary, 'workspace');
  let report;
  try {
    const fixture = await writeDenseFixture(workspace);
    const checkoutBinary = path.join(
      REPOSITORY_ROOT,
      'rust',
      'target',
      'release',
      process.platform === 'win32' ? 'oaf.exe' : 'oaf'
    );
    const selected = await resolveNativeBinary({ binaryPath: checkoutBinary });
    const writerArguments = {
      write: true,
      maxFiles: MILLION_NODE_PLAN.fileCount,
      maxFileBytes: MILLION_NODE_PLAN.maxFileBytes,
      maxNodes: MILLION_NODE_PLAN.maxNodes,
      maxEdges: MILLION_NODE_PLAN.maxEdges,
      languages: [MILLION_NODE_PLAN.language]
    };
    let ordinal = 0;
    const run = (operation, argumentsValue, deadlineMs) => runIndexOperation({
      binary: selected.path,
      workspace,
      operation,
      argumentsValue,
      deadlineMs,
      ordinal: ordinal += 1
    });

    const coldBuild = run('index.build', writerArguments, BUILD_DEADLINE_MS);
    const warmOpen = coldBuild.ok
      ? run('index.status', {}, READER_DEADLINE_MS)
      : skippedOperation('cold_build_failed');
    const noChangeRefresh = coldBuild.ok
      ? run('index.refresh', writerArguments, BUILD_DEADLINE_MS)
      : skippedOperation('cold_build_failed');
    const indexPath = path.join(workspace, INDEX_RELATIVE);
    const querySnapshotBefore = coldBuild.ok ? await fileSnapshot(indexPath) : null;
    const queries = [];
    if (coldBuild.ok) {
      for (let index = 0; index < QUERY_REPETITIONS; index += 1) {
        queries.push(run('index.query', {
          kind: 'exact',
          query: MILLION_NODE_PLAN.seedQuery,
          limit: 25
        }, READER_DEADLINE_MS));
      }
    }
    const querySnapshotAfter = coldBuild.ok ? await fileSnapshot(indexPath) : null;
    let oneFileRefresh = skippedOperation('cold_build_failed');
    if (coldBuild.ok) {
      await appendFile(path.join(workspace, 'src', 'dense-0000.js'), '// one-file-refresh\n');
      oneFileRefresh = run('index.refresh', writerArguments, BUILD_DEADLINE_MS);
    }
    const finalStatus = coldBuild.ok
      ? run('index.status', {}, READER_DEADLINE_MS)
      : skippedOperation('cold_build_failed');
    const summary = finalStatus.ok ? finalStatus.result.summary : coldBuild.result?.summary ?? emptySummary();
    const queryReceipt = summarizeQueries(queries);
    const failures = collectFailures({
      fixture,
      coldBuild,
      warmOpen,
      noChangeRefresh,
      oneFileRefresh,
      finalStatus,
      summary,
      queryReceipt,
      querySnapshotBefore,
      querySnapshotAfter
    });
    report = {
      schemaVersion: '1.0.0',
      reportVersion: 'memory-recall-million-node-rust-index-1',
      generatedAt: new Date().toISOString(),
      environment: {
        platform: os.platform(),
        architecture: os.arch(),
        nodeVersion: process.version,
        nativeVersion: selected.version,
        nativeTarget: selected.target,
        nativeSource: selected.source,
        rssMeasurement: process.platform === 'darwin'
          ? 'usr-bin-time-l'
          : process.platform === 'linux' ? 'usr-bin-time-v' : 'unavailable'
      },
      fixture,
      bounds: {
        maxFiles: writerArguments.maxFiles,
        maxFileBytes: writerArguments.maxFileBytes,
        maxNodes: writerArguments.maxNodes,
        maxEdges: writerArguments.maxEdges,
        buildDeadlineMs: BUILD_DEADLINE_MS,
        queryDeadlineMs: READER_DEADLINE_MS,
        queryRepetitions: QUERY_REPETITIONS
      },
      index: {
        fileCount: summary.fileCount,
        nodeCount: summary.nodeCount,
        edgeCount: summary.edgeCount,
        unresolvedCount: summary.unresolvedCount,
        omittedCount: summary.omittedCount,
        databaseBytes: summary.databaseBytes
      },
      proof: {
        measuredBoundary: 'exactly-1000000-committed-nodes',
        generatedFixtureNodeCount: fixture.expectedNodeCount,
        buildCommittedNodeCount: coldBuild.result?.summary?.nodeCount ?? null,
        warmStatusCommittedNodeCount: warmOpen.result?.summary?.nodeCount ?? null,
        querySamplesAllReadCommittedMillion: queries.length === QUERY_REPETITIONS && queries.every((operation) => (
          operation.ok &&
          operation.result.summary.nodeCount === MAX_NODES &&
          operation.result.summary.omittedCount === 0 &&
          operation.result.safeguards.readOnly === true
        )),
        finalStatusCommittedNodeCount: finalStatus.result?.summary?.nodeCount ?? null
      },
      measurements: {
        indexAndPersist: operationReceipt(coldBuild),
        warmOpen: operationReceipt(warmOpen),
        noChangeRefresh: operationReceipt(noChangeRefresh),
        oneFileRefresh: operationReceipt(oneFileRefresh),
        exactQuery: queryReceipt
      },
      failures,
      gateDecision: failures.length === 0 ? 'pass' : 'fail',
      claims: {
        millionNodeScaleProven: failures.length === 0,
        competitorParity: false,
        leadership: false,
        reason: failures.length === 0
          ? 'This local benchmark proves one million persisted Rust index nodes with bounded SQLite refresh and exact-query measurements on the recorded platform.'
          : 'The million-node claim remains unproven because one or more required measurements or correctness gates failed.'
      },
      safeguards: {
        networkCalls: 0,
        modelCalls: 0,
        canonicalMemoryWrites: 0,
        rawSourceStoredInReport: false,
        absolutePathsStoredInReport: false,
        fixtureDeletedAfterRun: true
      }
    };
  } catch (error) {
    report = failureReport(error);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  if (PRIVATE_PATH.test(JSON.stringify(report))) throw new Error('million_node_report_private_path');
  report.reportFingerprint = fingerprint(comparableReport(report));
  await atomicWrite(path.resolve(root, OUTPUT), report);
  return report;
}

function runIndexOperation({ binary, workspace, operation, argumentsValue, deadlineMs, ordinal }) {
  const request = requestFrame(operation, argumentsValue, deadlineMs, ordinal);
  if (!validateJsonSchema(requestSchema, request).valid) {
    return failedOperation('benchmark_request_invalid');
  }
  const started = performance.now();
  const spawned = timedSpawn(binary, ['code-intelligence', 'index', '--stdio'], {
    cwd: workspace,
    input: `${JSON.stringify(request)}\n`,
    encoding: 'utf8',
    maxBuffer: MAX_STDOUT_BYTES,
    timeout: deadlineMs + 5_000,
    killSignal: 'SIGKILL',
    env: Object.freeze({
      PATH: process.env.PATH ?? '',
      LANG: 'C',
      LC_ALL: 'C',
      OAF_FIXED_NOW: FIXED_NOW
    })
  });
  const wallMs = round(performance.now() - started);
  const measuredPeakRssMb = peakRssMb(spawned.stderr);
  const peakNativeRssMb = measuredPeakRssMb > 0 ? measuredPeakRssMb : null;
  if (spawned.error?.code === 'ETIMEDOUT') {
    return failedOperation('benchmark_operation_timeout', { wallMs, peakNativeRssMb });
  }
  if (spawned.error || spawned.signal || spawned.status !== 0) {
    return failedOperation(spawned.signal ? 'benchmark_native_process_signalled' : 'benchmark_native_process_failed', {
      wallMs,
      peakNativeRssMb
    });
  }
  let frame;
  try {
    const lines = String(spawned.stdout).trim().split(/\r?\n/u).filter(Boolean);
    if (lines.length !== 1) throw new Error('line-count');
    frame = JSON.parse(lines[0]);
  } catch {
    return failedOperation('benchmark_native_response_invalid', { wallMs, peakNativeRssMb });
  }
  if (!validateJsonSchema(responseSchema, frame).valid || frame.requestId !== request.requestId) {
    return failedOperation('benchmark_native_response_invalid', { wallMs, peakNativeRssMb });
  }
  if (!frame.ok) {
    return failedOperation(frame.error.code, { wallMs, peakNativeRssMb });
  }
  return Object.freeze({
    ok: true,
    wallMs,
    peakNativeRssMb,
    responseBytes: Buffer.byteLength(spawned.stdout),
    result: frame.result
  });
}

function requestFrame(operation, argumentsValue, deadlineMs, ordinal) {
  const token = createHash('sha256').update(`${operation}:${ordinal}`).digest('hex').slice(0, 32);
  return {
    protocolVersion: '1.0.0',
    requestId: `ciidxreq_${token}`,
    workspaceId: WORKSPACE_ID,
    operation,
    root: '.',
    indexLocator: 'workspace://.local/source-index/index.v1.sqlite',
    deadlineMs,
    cancellationToken: `cancel_${token}`,
    responseSchemaVersion: '1.0.0',
    arguments: argumentsValue
  };
}

function operationReceipt(operation) {
  if (!operation.ok) return { status: 'failed', code: operation.code, wallMs: operation.wallMs, peakNativeRssMb: operation.peakNativeRssMb };
  return {
    status: 'complete',
    wallMs: operation.wallMs,
    engineDurationMs: operation.result.measurements.durationMs,
    peakNativeRssMb: operation.peakNativeRssMb,
    responseBytes: operation.responseBytes,
    parsedFileCount: operation.result.measurements.parsedFileCount,
    reusedFileCount: operation.result.measurements.reusedFileCount,
    changedFileCount: operation.result.measurements.changedFileCount,
    deletedFileCount: operation.result.measurements.deletedFileCount,
    localFilesWritten: operation.result.measurements.localFilesWritten,
    state: operation.result.state,
    freshness: operation.result.freshness,
    activeGeneration: operation.result.activeGeneration
  };
}

function summarizeQueries(operations) {
  if (operations.length === 0) return { status: 'skipped', reason: 'cold_build_failed', repetitions: 0 };
  const failed = operations.find((operation) => !operation.ok);
  if (failed) return { status: 'failed', code: failed.code, repetitions: operations.length };
  return {
    status: 'complete',
    repetitions: operations.length,
    resultCount: operations[0].result.results.length,
    committedNodeCount: operations.every((operation) => operation.result.summary.nodeCount === MAX_NODES)
      ? MAX_NODES
      : null,
    omittedCount: Math.max(...operations.map((operation) => operation.result.summary.omittedCount)),
    readOnly: operations.every((operation) => operation.result.safeguards.readOnly === true),
    wallMs: percentiles(operations.map((operation) => operation.wallMs)),
    engineDurationMs: percentiles(operations.map((operation) => operation.result.measurements.durationMs)),
    peakNativeRssMb: operations.every((operation) => operation.peakNativeRssMb !== null)
      ? Math.max(...operations.map((operation) => operation.peakNativeRssMb))
      : null,
    responseBytes: percentiles(operations.map((operation) => operation.responseBytes)),
    localFilesWritten: Math.max(...operations.map((operation) => operation.result.measurements.localFilesWritten))
  };
}

function collectFailures({
  fixture,
  coldBuild,
  warmOpen,
  noChangeRefresh,
  oneFileRefresh,
  finalStatus,
  summary,
  queryReceipt,
  querySnapshotBefore,
  querySnapshotAfter
}) {
  const failures = [];
  const fail = (condition, code) => { if (condition) failures.push(code); };
  fail(fixture.expectedNodeCount !== MAX_NODES, 'fixture_node_count_not_million');
  for (const [name, operation] of [
    ['cold_build', coldBuild],
    ['warm_open', warmOpen],
    ['no_change_refresh', noChangeRefresh],
    ['one_file_refresh', oneFileRefresh],
    ['final_status', finalStatus]
  ]) {
    fail(!operation.ok, `${name}_${operation.code ?? 'failed'}`);
  }
  fail(summary.fileCount !== fixture.fileCount, 'persisted_file_count_mismatch');
  fail(summary.nodeCount !== fixture.expectedNodeCount, 'persisted_node_count_mismatch');
  fail(summary.edgeCount !== fixture.expectedEdgeCount, 'persisted_edge_count_mismatch');
  fail(summary.omittedCount !== 0, 'persisted_items_omitted');
  fail(coldBuild.ok && coldBuild.result.summary.nodeCount !== MAX_NODES, 'build_committed_node_count_not_million');
  fail(coldBuild.ok && coldBuild.result.summary.omittedCount !== 0, 'build_items_omitted');
  fail(warmOpen.ok && warmOpen.result.summary.nodeCount !== MAX_NODES, 'warm_status_node_count_not_million');
  fail(warmOpen.ok && warmOpen.result.summary.omittedCount !== 0, 'warm_status_items_omitted');
  fail(warmOpen.ok && warmOpen.result.safeguards.readOnly !== true, 'warm_status_not_read_only');
  fail(finalStatus.ok && finalStatus.result.summary.nodeCount !== MAX_NODES, 'final_status_node_count_not_million');
  fail(finalStatus.ok && finalStatus.result.summary.omittedCount !== 0, 'final_status_items_omitted');
  fail(coldBuild.ok && coldBuild.peakNativeRssMb === null, 'native_peak_rss_unavailable');
  fail(coldBuild.ok && (coldBuild.result.state !== 'ready' || coldBuild.result.freshness !== 'current'), 'cold_build_not_current');
  fail(noChangeRefresh.ok && noChangeRefresh.result.measurements.parsedFileCount !== 0, 'no_change_files_parsed');
  fail(noChangeRefresh.ok && noChangeRefresh.result.measurements.localFilesWritten !== 0, 'no_change_files_written');
  fail(noChangeRefresh.ok && coldBuild.ok && noChangeRefresh.result.activeGeneration !== coldBuild.result.activeGeneration, 'no_change_generation_advanced');
  fail(oneFileRefresh.ok && oneFileRefresh.result.measurements.changedFileCount !== 1, 'one_file_change_count_invalid');
  fail(oneFileRefresh.ok && oneFileRefresh.result.measurements.parsedFileCount !== 1, 'one_file_parse_count_invalid');
  fail(queryReceipt.status !== 'complete', `exact_query_${queryReceipt.code ?? 'incomplete'}`);
  fail(queryReceipt.status === 'complete' && queryReceipt.resultCount < 1, 'exact_query_empty');
  fail(queryReceipt.status === 'complete' && queryReceipt.localFilesWritten !== 0, 'exact_query_wrote_files');
  fail(queryReceipt.status === 'complete' && queryReceipt.omittedCount !== 0, 'exact_query_items_omitted');
  fail(queryReceipt.status === 'complete' && queryReceipt.readOnly !== true, 'exact_query_not_read_only');
  fail(queryReceipt.status === 'complete' && queryReceipt.peakNativeRssMb === null, 'query_peak_rss_unavailable');
  fail(queriesDoNotProveCommittedMillion(queryReceipt), 'exact_query_committed_node_count_not_million');
  fail(
    querySnapshotBefore && querySnapshotAfter && (
      querySnapshotBefore.bytes !== querySnapshotAfter.bytes ||
      querySnapshotBefore.mtimeNs !== querySnapshotAfter.mtimeNs
    ),
    'exact_query_mutated_index'
  );
  return [...new Set(failures)];
}

function queriesDoNotProveCommittedMillion(queryReceipt) {
  return queryReceipt.status === 'complete' && queryReceipt.committedNodeCount !== MAX_NODES;
}

function failedOperation(code, { wallMs = 0, peakNativeRssMb = null } = {}) {
  return Object.freeze({ ok: false, code: safeCode(code), wallMs, peakNativeRssMb });
}

function skippedOperation(reason) {
  return Object.freeze({ ok: false, code: safeCode(reason), wallMs: 0, peakNativeRssMb: null });
}

function safeCode(value) {
  return /^[a-z][a-z0-9_.-]{0,127}$/u.test(value ?? '') ? value : 'benchmark_operation_failed';
}

function emptySummary() {
  return { fileCount: 0, nodeCount: 0, edgeCount: 0, unresolvedCount: 0, omittedCount: 0, databaseBytes: 0 };
}

async function fileSnapshot(file) {
  const metadata = await stat(file, { bigint: true });
  return { bytes: Number(metadata.size), mtimeNs: metadata.mtimeNs.toString() };
}

function percentiles(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (percentile) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentile * sorted.length) - 1))];
  return { p50: round(at(0.5)), p95: round(at(0.95)), p99: round(at(0.99)) };
}

function round(value) {
  return Number(Number(value).toFixed(3));
}

function fingerprint(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function comparableReport(report) {
  const { generatedAt: _generatedAt, reportFingerprint: _reportFingerprint, ...comparable } = report;
  return comparable;
}

function failureReport(error) {
  return {
    schemaVersion: '1.0.0',
    reportVersion: 'memory-recall-million-node-rust-index-1',
    generatedAt: new Date().toISOString(),
    environment: { platform: os.platform(), architecture: os.arch(), nodeVersion: process.version },
    fixture: {
      language: MILLION_NODE_PLAN.language,
      fileCount: MILLION_NODE_PLAN.fileCount,
      methodsPerFile: MILLION_NODE_PLAN.methodsPerFile,
      expectedNodeCount: MILLION_NODE_PLAN.expectedNodeCount,
      expectedEdgeCount: MILLION_NODE_PLAN.expectedEdgeCount
    },
    index: emptySummary(),
    measurements: {},
    failures: [safeCode(error?.code ?? error?.message)],
    gateDecision: 'fail',
    claims: {
      millionNodeScaleProven: false,
      competitorParity: false,
      leadership: false,
      reason: 'The million-node claim remains unproven because the benchmark could not complete.'
    },
    safeguards: {
      networkCalls: 0,
      modelCalls: 0,
      canonicalMemoryWrites: 0,
      rawSourceStoredInReport: false,
      absolutePathsStoredInReport: false,
      fixtureDeletedAfterRun: true
    }
  };
}

async function atomicWrite(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

function planReport() {
  return {
    mode: 'plan',
    requiresExplicitRun: true,
    output: OUTPUT,
    fixture: MILLION_NODE_PLAN,
    measurements: [
      'indexAndPersist',
      'warmOpen',
      'noChangeRefresh',
      'oneFileRefresh',
      'exactQueryP50P95P99',
      'nativePeakRss',
      'databaseBytes'
    ]
  };
}

async function main(args) {
  if (args.length !== 1 || !['--plan', '--run'].includes(args[0])) {
    console.error('usage: node scripts/code-intelligence-million-node-index.mjs --plan|--run');
    process.exitCode = 2;
    return;
  }
  if (args[0] === '--plan') {
    console.log(JSON.stringify(planReport(), null, 2));
    return;
  }
  const report = await runMillionNodeBenchmark();
  console.log(`Million-node Rust index benchmark wrote ${OUTPUT}: ${report.gateDecision}.`);
  if (report.gateDecision !== 'pass') process.exitCode = 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main(process.argv.slice(2));
