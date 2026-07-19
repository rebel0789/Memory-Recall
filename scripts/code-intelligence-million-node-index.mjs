import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { validateJsonSchema } from '../packages/protocol/src/schema-validator.mjs';
import requestSchema from '../packages/protocol/schemas/code-intelligence-index-request.schema.json' with { type: 'json' };
import responseSchema from '../packages/protocol/schemas/code-intelligence-index-response.schema.json' with { type: 'json' };
import { resolveNativeBinary } from '../providers/native/code-intelligence-rust/src/binary-resolver.mjs';

const OUTPUT = 'evals/code-intelligence/results/million-node-rust-index.json';
const REPORT_VERSION = 'memory-recall-million-node-rust-index-2';
const INDEX_RELATIVE = '.local/source-index/index.v1.sqlite';
const PRIVATE_PATH = /(?:\/Users\/|\/home\/[A-Za-z0-9._-]+\/|\/private\/|\/var\/folders\/|[A-Za-z]:\\)/u;
const WORKSPACE_ID = 'ws_million_node_index';
const FIXED_NOW = '2026-07-17T00:00:00.000Z';
const BUILD_DEADLINE_MS = 300_000;
const READER_DEADLINE_MS = 2_000;
const QUERY_REPETITIONS = 20;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_NODES = 1_000_000;
const MAX_EDGES = 1_000_000;
const RSS_SAMPLE_INTERVAL_MS = 250;
const RSS_SAMPLE_TIMEOUT_MS = 500;
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);

export function createDenseFixturePlan({ fileCount = 1_000, classesPerFile = 998 } = {}) {
  if (!Number.isInteger(fileCount) || fileCount < 1 || fileCount > 1_000_000) {
    throw new Error('million_node_fixture_file_count_invalid');
  }
  if (!Number.isInteger(classesPerFile) || classesPerFile < 1) {
    throw new Error('million_node_fixture_class_count_invalid');
  }
  const expectedNodeCount = fileCount * (2 + classesPerFile);
  const expectedEdgeCount = fileCount * (1 + classesPerFile);
  if (!Number.isSafeInteger(expectedNodeCount) || expectedNodeCount > MAX_NODES) {
    throw new Error('million_node_fixture_node_count_invalid');
  }
  if (!Number.isSafeInteger(expectedEdgeCount) || expectedEdgeCount > MAX_EDGES) {
    throw new Error('million_node_fixture_edge_count_invalid');
  }
  return Object.freeze({
    language: 'javascript',
    shape: 'base36-empty-classes-v2',
    fileCount,
    classesPerFile,
    expectedNodeCount,
    expectedEdgeCount,
    maxFileBytes: MAX_FILE_BYTES,
    maxNodes: MAX_NODES,
    maxEdges: MAX_EDGES,
    seedQuery: 'ScaleProbe'
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
    const classes = Array.from(
      { length: plan.classesPerFile },
      (_, classIndex) => {
        const className = fileIndex === 0 && classIndex === 0
          ? plan.seedQuery
          : `C${classIndex.toString(36)}`;
        return `class ${className}{}`;
      }
    ).join('');
    const body = `${classes}\n`;
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
    shape: plan.shape,
    fileCount: plan.fileCount,
    classesPerFile: plan.classesPerFile,
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
    const [binarySha256, checkout] = await Promise.all([
      fileSha256(selected.path),
      checkoutEvidence()
    ]);
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

    const coldBuild = await run('index.build', writerArguments, BUILD_DEADLINE_MS);
    const warmOpen = coldBuild.ok
      ? await run('index.status', {}, READER_DEADLINE_MS)
      : skippedOperation('cold_build_failed');
    const noChangeRefresh = coldBuild.ok
      ? await run('index.refresh', writerArguments, BUILD_DEADLINE_MS)
      : skippedOperation('cold_build_failed');
    const indexPath = path.join(workspace, INDEX_RELATIVE);
    const querySnapshotBefore = coldBuild.ok ? await fileSnapshot(indexPath) : null;
    const queries = [];
    if (coldBuild.ok) {
      for (let index = 0; index < QUERY_REPETITIONS; index += 1) {
        queries.push(await run('index.query', {
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
      oneFileRefresh = await run('index.refresh', writerArguments, BUILD_DEADLINE_MS);
    }
    const finalStatus = coldBuild.ok
      ? await run('index.status', {}, READER_DEADLINE_MS)
      : skippedOperation('cold_build_failed');
    const summary = finalStatus.ok ? finalStatus.result.summary : coldBuild.result?.summary ?? emptySummary();
    const queryReceipt = {
      ...summarizeQueries(queries),
      sqliteBefore: querySnapshotBefore,
      sqliteAfter: querySnapshotAfter
    };
    const failures = collectFailures({
      fixture,
      checkout,
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
      reportVersion: REPORT_VERSION,
      generatedAt: new Date().toISOString(),
      environment: {
        platform: os.platform(),
        architecture: os.arch(),
        nodeVersion: process.version,
        nativeVersion: selected.version,
        nativeTarget: selected.target,
        nativeSource: 'checkout',
        rssMeasurement: coldBuild.rssMeasurement ?? 'unavailable'
      },
      execution: {
        binarySha256,
        checkoutCommit: checkout.commit,
        checkoutDirtyBeforeRun: checkout.dirty,
        argvTemplate: ['<checkout-rust-binary>', 'code-intelligence', 'index', '--stdio'],
        rssSampling: {
          method: coldBuild.rssMeasurement ?? 'unavailable',
          cadenceMs: coldBuild.rssSampleIntervalMs ?? null
        }
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

async function runIndexOperation({ binary, workspace, operation, argumentsValue, deadlineMs, ordinal }) {
  const request = requestFrame(operation, argumentsValue, deadlineMs, ordinal);
  if (!validateJsonSchema(requestSchema, request).valid) {
    return failedOperation('benchmark_request_invalid');
  }
  const started = performance.now();
  const executed = await runKillSafeProcess({
    command: binary,
    args: ['code-intelligence', 'index', '--stdio'],
    cwd: workspace,
    input: `${JSON.stringify(request)}\n`,
    timeoutMs: deadlineMs + 5_000,
    maxStdoutBytes: MAX_STDOUT_BYTES,
    maxStderrBytes: MAX_STDERR_BYTES,
    env: Object.freeze({
      PATH: process.env.PATH ?? '',
      LANG: 'C',
      LC_ALL: 'C',
      OAF_FIXED_NOW: FIXED_NOW
    })
  });
  const wallMs = round(performance.now() - started);
  const processEvidence = processReceipt(executed);
  if (executed.timedOut) {
    return failedOperation('benchmark_operation_timeout', { wallMs, ...processEvidence });
  }
  if (executed.outputLimitExceeded) {
    return failedOperation('benchmark_native_output_limit', { wallMs, ...processEvidence });
  }
  if (executed.errorCode || executed.signal || executed.exitCode !== 0) {
    return failedOperation(executed.signal ? 'benchmark_native_process_signalled' : 'benchmark_native_process_failed', {
      wallMs,
      ...processEvidence
    });
  }
  let frame;
  try {
    const lines = executed.stdout.toString('utf8').trim().split(/\r?\n/u).filter(Boolean);
    if (lines.length !== 1) throw new Error('line-count');
    frame = JSON.parse(lines[0]);
  } catch {
    return failedOperation('benchmark_native_response_invalid', { wallMs, ...processEvidence });
  }
  if (!validateJsonSchema(responseSchema, frame).valid || frame.requestId !== request.requestId) {
    return failedOperation('benchmark_native_response_invalid', { wallMs, ...processEvidence });
  }
  if (!frame.ok) {
    return failedOperation(frame.error.code, { wallMs, ...processEvidence });
  }
  return Object.freeze({
    ok: true,
    wallMs,
    ...processEvidence,
    result: frame.result
  });
}

export function runKillSafeProcess({
  command,
  args,
  cwd,
  input = '',
  timeoutMs,
  maxStdoutBytes = MAX_STDOUT_BYTES,
  maxStderrBytes = MAX_STDERR_BYTES,
  env = process.env,
  rssSampler = platformRssSampler()
}) {
  return new Promise((resolve) => {
    const grouped = process.platform !== 'win32';
    const child = spawn(command, args, {
      cwd,
      env,
      detached: grouped,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let errorCode = null;
    let killStarted = false;
    let closed = false;
    let peakNativeRssMb = null;
    let rssSampleInFlight = null;
    let rssSampleInterval = null;
    const sampleRss = () => {
      if (!rssSampler || !child.pid || closed || rssSampleInFlight) return rssSampleInFlight ?? Promise.resolve();
      rssSampleInFlight = sampleDirectChildRssMb(child.pid, rssSampler)
        .then((rssMb) => {
          if (rssMb !== null) peakNativeRssMb = Math.max(peakNativeRssMb ?? 0, rssMb);
        })
        .catch(() => {})
        .finally(() => { rssSampleInFlight = null; });
      return rssSampleInFlight;
    };
    const killTree = () => {
      if (killStarted) return;
      killStarted = true;
      try {
        if (grouped && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timerId = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);
    child.on('error', (error) => {
      errorCode = safeCode(error?.code?.toLowerCase());
      killTree();
    });
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        outputLimitExceeded = true;
        killTree();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxStderrBytes) {
        outputLimitExceeded = true;
        killTree();
        return;
      }
      stderr.push(chunk);
    });
    child.on('close', (exitCode, signal) => {
      closed = true;
      clearTimeout(timerId);
      if (rssSampleInterval) clearInterval(rssSampleInterval);
      const stdoutBuffer = Buffer.concat(stdout);
      const stderrBuffer = Buffer.concat(stderr);
      const pendingSample = rssSampleInFlight;
      void Promise.resolve(pendingSample).finally(() => {
        resolve(Object.freeze({
          exitCode,
          signal,
          timedOut,
          outputLimitExceeded,
          errorCode,
          stdout: stdoutBuffer,
          stderr: stderrBuffer,
          stdoutBytes,
          stderrBytes,
          stdoutSha256: bufferSha256(stdoutBuffer),
          stderrSha256: bufferSha256(stderrBuffer),
          peakNativeRssMb,
          rssMeasurement: peakNativeRssMb === null ? 'unavailable' : rssSampler.measurement,
          rssSampleIntervalMs: peakNativeRssMb === null ? null : rssSampler.cadenceMs
        }));
      });
    });
    child.stdin.on('error', () => killTree());
    void sampleRss().finally(() => {
      if (closed || killStarted) return;
      rssSampleInterval = setInterval(() => { void sampleRss(); }, rssSampler?.cadenceMs ?? RSS_SAMPLE_INTERVAL_MS);
      child.stdin.end(input);
    });
  });
}

function processReceipt(executed) {
  return {
    peakNativeRssMb: executed.peakNativeRssMb,
    rssMeasurement: executed.rssMeasurement,
    rssSampleIntervalMs: executed.rssSampleIntervalMs,
    exitCode: executed.exitCode,
    signal: executed.signal,
    timedOut: executed.timedOut,
    outputLimitExceeded: executed.outputLimitExceeded,
    errorCode: executed.errorCode,
    stdoutBytes: executed.stdoutBytes,
    stderrBytes: executed.stderrBytes,
    stdoutSha256: executed.stdoutSha256,
    stderrSha256: executed.stderrSha256
  };
}

function platformRssSampler() {
  if (!['darwin', 'linux'].includes(process.platform)) return null;
  return Object.freeze({
    command: 'ps',
    measurement: 'direct-child-ps-sampled',
    cadenceMs: RSS_SAMPLE_INTERVAL_MS,
    timeoutMs: RSS_SAMPLE_TIMEOUT_MS
  });
}

async function sampleDirectChildRssMb(pid, sampler) {
  const { stdout } = await execFileAsync(sampler.command, ['-o', 'rss=', '-p', String(pid)], {
    encoding: 'utf8',
    timeout: sampler.timeoutMs,
    maxBuffer: 4096,
    windowsHide: true
  });
  const kilobytes = Number(stdout.trim().split(/\s+/u)[0] ?? 0);
  return Number.isFinite(kilobytes) && kilobytes > 0
    ? Number((kilobytes / 1024).toFixed(1))
    : null;
}

async function checkoutEvidence() {
  const options = { cwd: REPOSITORY_ROOT, encoding: 'utf8', maxBuffer: 1024 * 1024 };
  const [commit, status] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD'], options),
    execFileAsync('git', ['status', '--porcelain'], options)
  ]);
  return Object.freeze({ commit: commit.stdout.trim(), dirty: status.stdout.trim().length > 0 });
}

async function fileSha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

function bufferSha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
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
  if (!operation.ok) return { status: 'failed', code: operation.code, wallMs: operation.wallMs, ...executionReceipt(operation) };
  return {
    status: 'complete',
    wallMs: operation.wallMs,
    engineDurationMs: operation.result.measurements.durationMs,
    ...executionReceipt(operation),
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

function executionReceipt(operation) {
  return {
    peakNativeRssMb: operation.peakNativeRssMb,
    rssMeasurement: operation.rssMeasurement,
    rssSampleIntervalMs: operation.rssSampleIntervalMs,
    exitCode: operation.exitCode,
    signal: operation.signal,
    timedOut: operation.timedOut,
    outputLimitExceeded: operation.outputLimitExceeded,
    errorCode: operation.errorCode,
    stdoutBytes: operation.stdoutBytes,
    stderrBytes: operation.stderrBytes,
    stdoutSha256: operation.stdoutSha256,
    stderrSha256: operation.stderrSha256
  };
}

function summarizeQueries(operations) {
  if (operations.length === 0) return { status: 'skipped', reason: 'cold_build_failed', repetitions: 0 };
  const failed = operations.find((operation) => !operation.ok);
  if (failed) return {
    status: 'failed',
    code: failed.code,
    repetitions: operations.length,
    failedOperation: operationReceipt(failed)
  };
  const fingerprints = operations.map((operation) => fingerprint(projectQueryResults(operation.result.results)));
  const expectedSeedLocators = ['workspace://src/dense-0000.js#L1-L1'];
  return {
    status: 'complete',
    repetitions: operations.length,
    resultCount: operations[0].result.results.length,
    expectedSeedLocators,
    seedLocators: operations[0].result.results.map((item) => item.locator).sort(),
    expectedSeedPresent: operations.every((operation) => (
      operation.result.results.length === expectedSeedLocators.length &&
      operation.result.results.every((item) => item.kind === 'class' && item.label === MILLION_NODE_PLAN.seedQuery) &&
      JSON.stringify(operation.result.results.map((item) => item.locator).sort()) === JSON.stringify(expectedSeedLocators)
    )),
    stableResultFingerprint: new Set(fingerprints).size === 1 ? fingerprints[0] : null,
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
    stdoutBytes: percentiles(operations.map((operation) => operation.stdoutBytes)),
    stderrBytes: percentiles(operations.map((operation) => operation.stderrBytes)),
    stdoutSha256: [...new Set(operations.map((operation) => operation.stdoutSha256))].sort(),
    stderrSha256: [...new Set(operations.map((operation) => operation.stderrSha256))].sort(),
    exitCodes: [...new Set(operations.map((operation) => operation.exitCode))],
    signals: [...new Set(operations.map((operation) => operation.signal))],
    timedOut: operations.some((operation) => operation.timedOut),
    localFilesWritten: Math.max(...operations.map((operation) => operation.result.measurements.localFilesWritten))
  };
}

function collectFailures({
  fixture,
  checkout,
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
  fail(!/^[a-f0-9]{40}$/u.test(checkout.commit), 'benchmark_checkout_commit_invalid');
  fail(checkout.dirty, 'benchmark_checkout_dirty');
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
  fail(queryReceipt.status === 'complete' && !queryReceipt.expectedSeedPresent, 'exact_query_expected_seed_missing');
  fail(queryReceipt.status === 'complete' && queryReceipt.stableResultFingerprint === null, 'exact_query_results_not_stable');
  fail(queryReceipt.status === 'complete' && queryReceipt.localFilesWritten !== 0, 'exact_query_wrote_files');
  fail(queryReceipt.status === 'complete' && queryReceipt.omittedCount !== 0, 'exact_query_items_omitted');
  fail(queryReceipt.status === 'complete' && queryReceipt.readOnly !== true, 'exact_query_not_read_only');
  fail(queryReceipt.status === 'complete' && queryReceipt.peakNativeRssMb === null, 'query_peak_rss_unavailable');
  fail(queriesDoNotProveCommittedMillion(queryReceipt), 'exact_query_committed_node_count_not_million');
  fail(
    querySnapshotBefore && querySnapshotAfter && (
      querySnapshotBefore.bytes !== querySnapshotAfter.bytes ||
      querySnapshotBefore.mtimeNs !== querySnapshotAfter.mtimeNs ||
      querySnapshotBefore.sha256 !== querySnapshotAfter.sha256
    ),
    'exact_query_mutated_index'
  );
  return [...new Set(failures)];
}

function queriesDoNotProveCommittedMillion(queryReceipt) {
  return queryReceipt.status === 'complete' && queryReceipt.committedNodeCount !== MAX_NODES;
}

function projectQueryResults(results) {
  return results.map((item) => ({ kind: item.kind, label: item.label, locator: item.locator }));
}

function failedOperation(code, evidence = {}) {
  const emptyHash = bufferSha256(Buffer.alloc(0));
  return Object.freeze({
    ok: false,
    code: safeCode(code),
    wallMs: evidence.wallMs ?? 0,
    peakNativeRssMb: evidence.peakNativeRssMb ?? null,
    rssMeasurement: evidence.rssMeasurement ?? 'unavailable',
    rssSampleIntervalMs: evidence.rssSampleIntervalMs ?? null,
    exitCode: evidence.exitCode ?? null,
    signal: evidence.signal ?? null,
    timedOut: evidence.timedOut ?? false,
    outputLimitExceeded: evidence.outputLimitExceeded ?? false,
    errorCode: evidence.errorCode ?? null,
    stdoutBytes: evidence.stdoutBytes ?? 0,
    stderrBytes: evidence.stderrBytes ?? 0,
    stdoutSha256: evidence.stdoutSha256 ?? emptyHash,
    stderrSha256: evidence.stderrSha256 ?? emptyHash
  });
}

function skippedOperation(reason) {
  return failedOperation(reason);
}

function safeCode(value) {
  return /^[a-z][a-z0-9_.-]{0,127}$/u.test(value ?? '') ? value : 'benchmark_operation_failed';
}

function emptySummary() {
  return { fileCount: 0, nodeCount: 0, edgeCount: 0, unresolvedCount: 0, omittedCount: 0, databaseBytes: 0 };
}

async function fileSnapshot(file) {
  const metadata = await stat(file, { bigint: true });
  return { bytes: Number(metadata.size), mtimeNs: metadata.mtimeNs.toString(), sha256: await fileSha256(file) };
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
    reportVersion: REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    environment: { platform: os.platform(), architecture: os.arch(), nodeVersion: process.version },
    fixture: {
      language: MILLION_NODE_PLAN.language,
      shape: MILLION_NODE_PLAN.shape,
      fileCount: MILLION_NODE_PLAN.fileCount,
      classesPerFile: MILLION_NODE_PLAN.classesPerFile,
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
    reportVersion: REPORT_VERSION,
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
