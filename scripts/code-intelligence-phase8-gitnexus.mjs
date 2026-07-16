import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { evaluateCodeIntelligenceLanguage } from '../packages/protocol/src/code-intelligence-evaluation.mjs';
import { stableStringify } from '../packages/protocol/src/fingerprint.mjs';
import { RustCodeIntelligenceProvider } from '../providers/native/code-intelligence-rust/src/index.mjs';

const LICENSE_ACKNOWLEDGEMENT = 'noncommercial-or-separately-authorized';
const PRIVATE_PATH = /(?:\/Users\/|\/home\/[A-Za-z0-9._-]+\/|\/private\/|\/var\/folders\/|[A-Za-z]:\\)/u;
const root = process.cwd();
let options = {};
try {
  options = parseArgs(process.argv.slice(2));
} catch {
  printReport(unavailableReport({}, 'arguments_invalid'));
  process.exit(2);
}

if (options.licenseAcknowledgement !== LICENSE_ACKNOWLEDGEMENT || !options.gitnexusCli) {
  printReport(unavailableReport(options, options.gitnexusCli ? 'license_acknowledgement_missing' : 'gitnexus_cli_missing'));
  process.exit(2);
}

const temporary = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-phase8-gitnexus-'));
try {
  const fixtureRoot = path.join(temporary, 'repository');
  const home = path.join(temporary, 'home');
  await cp(path.resolve(root, 'evals', 'code-intelligence', 'fixtures', 'batch-b', 'go'), fixtureRoot, { recursive: true });
  await mkdir(home, { recursive: true });
  const truth = JSON.parse(await readFile(path.resolve(root, 'evals', 'code-intelligence', 'truth', 'fixtures', 'go.json'), 'utf8'));
  const sourceFingerprintBefore = await treeFingerprint(fixtureRoot);
  let memoryRecall = await runMemoryRecall({ fixtureRoot, truth, binaryPath: options.memoryRecallBinary });
  const memoryRecallSourceMutated = await treeFingerprint(fixtureRoot) !== sourceFingerprintBefore;
  if (memoryRecallSourceMutated) memoryRecall = failedRun('memory_recall_source_mutation_detected', 'verification');
  const gitnexus = memoryRecallSourceMutated
    ? unavailableRun('comparison_aborted_after_source_mutation', 'verification')
    : await runGitNexus({ fixtureRoot, home, truth, options });
  const status = memoryRecall.status === 'measured' && gitnexus.status === 'measured'
    ? 'measured'
    : memoryRecall.status === 'failed' || gitnexus.status === 'failed'
      ? 'failed'
      : 'unavailable';
  const report = finalizeReport({
    schemaVersion: '1.0.0',
    reportVersion: 'memory-recall-code-intelligence-phase8-gitnexus-go-fixture-1',
    status,
    generatedAt: process.env.OAF_FIXED_NOW ?? new Date().toISOString(),
    inputs: {
      fixture: truth.source.ref,
      truthId: truth.id,
      truthFingerprint: truth.truthFingerprint,
      language: truth.language,
      gitnexus: {
        version: options.gitnexusVersion,
        upstreamSha: options.gitnexusSha,
        licenseAcknowledgement: 'provided'
      }
    },
    runs: { memoryRecall, gitnexus },
    gates: [
      {
        id: 'identical-reviewed-fixture-correctness',
        status: memoryRecall.status === 'measured' && gitnexus.status === 'measured'
          ? memoryRecall.evaluation.gateDecision === 'pass' && gitnexus.evaluation.gateDecision === 'pass' ? 'pass' : 'fail'
          : 'unavailable'
      },
      { id: 'performance-non-inferiority', status: 'unavailable' },
      { id: 'full-tier1-real-repository-corpus', status: 'unavailable' }
    ],
    gateDecision: 'fail',
    claims: {
      parity: false,
      leadership: false,
      reason: 'One reviewed Go fixture cannot prove product parity, performance non-inferiority, or the required Tier-1 real-repository corpus.'
    },
    safeguards: {
      rawSourceStored: false,
      absolutePathsStored: false,
      rawCommandOutputStored: false,
      environmentVariablesStored: false,
      sourceFilesMutated: memoryRecallSourceMutated || gitnexus.failure?.code === 'gitnexus_source_mutation_detected',
      modelCalls: 0,
      networkCallsDuringMeasuredCommands: null,
      networkIsolation: 'not-enforced',
      canonicalMemoryWrites: 0,
      competitorHomeIsolated: true,
      competitorRepositoryDisposable: true
    }
  });
  printReport(report);
} catch {
  printReport(executionFailureReport(options));
  process.exitCode = 1;
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function runMemoryRecall({ fixtureRoot, truth, binaryPath }) {
  const resolvedBinary = path.resolve(binaryPath ?? path.join(root, 'rust', 'target', 'release', process.platform === 'win32' ? 'oaf.exe' : 'oaf'));
  if (!(await pathExists(resolvedBinary))) return failedRun('memory_recall_binary_missing', 'discovery');
  const provider = new RustCodeIntelligenceProvider({ binaryPath: resolvedBinary, timeoutMs: 60_000, maxStdoutBytes: 8_000_000 });
  const graphs = [];
  const durationsMs = [];
  for (let index = 0; index < 2; index += 1) {
    const started = process.hrtime.bigint();
    graphs.push(await provider.buildGraph({
      root: fixtureRoot,
      workspaceId: 'ws_phase8_gitnexus_go',
      languages: ['go'],
      maxFiles: 100,
      maxNodes: 2_000,
      maxEdges: 4_000
    }));
    durationsMs.push(roundDuration(started));
  }
  const evaluation = evaluateCodeIntelligenceLanguage({ truth, graphRuns: graphs });
  return {
    status: 'measured',
    product: {
      name: 'memory-recall',
      version: JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version,
      artifactFingerprint: await fileFingerprint(resolvedBinary),
      verified: true
    },
    evaluation: compactEvaluation(evaluation),
    performance: {
      indexDurationMs: durationsMs[0],
      warmDurationMs: durationsMs[1],
      queryDurationMs: null,
      indexBytes: null,
      responseBytes: Buffer.byteLength(JSON.stringify(graphs[0]))
    },
    commands: [{
      id: 'memory-recall-graph-build',
      argvTemplate: ['code-intelligence', 'graph', '--stdio', '$REPOSITORY'],
      invocationCount: 2
    }],
    failure: null
  };
}

async function runGitNexus({ fixtureRoot, home, truth, options }) {
  const sourceFingerprintBefore = await treeFingerprint(fixtureRoot);
  const environment = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    NO_COLOR: '1',
    GITNEXUS_MCP_READ_ONLY: '1',
    ...(process.env.MEMORY_RECALL_PHASE8_FAKE_LOG ? { MEMORY_RECALL_PHASE8_FAKE_LOG: process.env.MEMORY_RECALL_PHASE8_FAKE_LOG } : {})
  };
  const commands = [];
  const version = invoke(options.gitnexusCli, ['--version'], {
    cwd: fixtureRoot,
    env: environment,
    id: 'gitnexus-version',
    argvTemplate: ['--version']
  });
  commands.push(version.receipt);
  if (!version.ok || version.stdout.trim() !== options.gitnexusVersion) {
    return failedRun('gitnexus_version_mismatch', 'version', commands);
  }
  const artifactFingerprint = fileFingerprintSync(options.gitnexusCli);
  if (!artifactFingerprint) return failedRun('gitnexus_artifact_unreadable', 'version', commands);
  const analyze = invoke(options.gitnexusCli, [
    'analyze', fixtureRoot, '--force', '--index-only', '--skip-git', '--name', 'memory-recall-phase8-go'
  ], {
    cwd: fixtureRoot,
    env: environment,
    id: 'gitnexus-analyze',
    argvTemplate: ['analyze', '$REPOSITORY', '--force', '--index-only', '--skip-git', '--name', 'memory-recall-phase8-go'],
    timeout: 120_000
  });
  commands.push(analyze.receipt);
  if (!analyze.ok) return failedRun('gitnexus_analyze_failed', 'index', commands);

  const outcomes = [];
  const queryDurations = [];
  for (const item of truth.items) {
    const query = gitnexusQuery(item);
    if (!query) {
      outcomes.push({ itemId: item.id, capability: item.capability, status: 'unavailable', matched: false });
      continue;
    }
    const result = invoke(options.gitnexusCli, ['cypher', query, '--repo', 'memory-recall-phase8-go', '--limit', '2'], {
      cwd: fixtureRoot,
      env: environment,
      id: `gitnexus-${item.id}`,
      argvTemplate: ['cypher', '$QUERY', '--repo', 'memory-recall-phase8-go', '--limit', '2']
    });
    commands.push(result.receipt);
    queryDurations.push(result.receipt.durationMs);
    if (!result.ok) return failedRun('gitnexus_query_failed', 'query', commands);
    let rowCount;
    try {
      rowCount = JSON.parse(result.stdout).row_count;
    } catch {
      return failedRun('gitnexus_query_output_invalid', 'query', commands);
    }
    if (!Number.isInteger(rowCount) || rowCount < 0 || rowCount > 2) {
      return failedRun('gitnexus_query_row_count_invalid', 'query', commands);
    }
    const present = rowCount > 0;
    outcomes.push({
      itemId: item.id,
      capability: item.capability,
      status: 'measured',
      matched: item.expectation === 'present' ? present : !present,
      present
    });
  }
  const measured = outcomes.filter((item) => item.status === 'measured');
  const nodes = truth.items.filter((item) => item.recordKind === 'node' && item.expectation === 'present');
  const relationships = truth.items.filter((item) => item.recordKind === 'edge' && item.kind !== 'calls' && item.expectation === 'present');
  const calls = truth.items.filter((item) => item.recordKind === 'edge' && item.kind === 'calls');
  const matchedById = new Map(measured.map((item) => [item.itemId, item]));
  const callTruePositiveCount = calls.filter((item) => item.expectation === 'present' && matchedById.get(item.id)?.present).length;
  const callFalsePositiveCount = calls.filter((item) => item.expectation === 'absent' && matchedById.get(item.id)?.present).length;
  const sourceFingerprintAfter = await treeFingerprint(fixtureRoot);
  if (sourceFingerprintAfter !== sourceFingerprintBefore) {
    return failedRun('gitnexus_source_mutation_detected', 'verification', commands);
  }
  const evaluation = {
    graphFingerprints: [],
    metrics: {
      declarationRecall: ratio(nodes.filter((item) => matchedById.get(item.id)?.present).length, nodes.length),
      relationshipRecall: ratio(relationships.filter((item) => matchedById.get(item.id)?.present).length, relationships.length),
      reviewedCallPrecision: ratio(callTruePositiveCount, callTruePositiveCount + callFalsePositiveCount),
      duplicateCanonicalSymbolCount: null,
      parseFailureCount: null,
      deterministicGraphFingerprint: null,
      truthItemCount: outcomes.length,
      matchedTruthItemCount: measured.filter((item) => item.matched).length,
      unavailableTruthItemCount: outcomes.filter((item) => item.status === 'unavailable').length
    },
    capabilities: Object.entries(Object.groupBy(outcomes, (item) => item.capability)).map(([id, items]) => ({
      id,
      status: items.every((item) => item.status === 'measured') ? 'measured' : 'partial',
      itemCount: items.length,
      matchedItemCount: items.filter((item) => item.matched).length
    })).sort((left, right) => left.id.localeCompare(right.id)),
    failures: measured.filter((item) => !item.matched).map((item) => ({ code: 'truth_expectation_mismatch', itemId: item.itemId })),
    gateDecision: outcomes.every((item) => item.status === 'measured' && item.matched) ? 'pass' : 'fail',
    reportFingerprint: fingerprint({ outcomes })
  };
  return {
    status: 'measured',
    product: {
      name: 'gitnexus',
      version: options.gitnexusVersion,
      upstreamSha: { value: options.gitnexusSha, verification: 'caller-supplied-unverified' },
      artifactFingerprint,
      verified: false,
      verification: 'observed-version-and-local-executable-hash-only'
    },
    evaluation,
    performance: {
      indexDurationMs: analyze.receipt.durationMs,
      warmDurationMs: null,
      queryDurationMs: percentileSummary(queryDurations),
      indexBytes: await generatedIndexBytes(fixtureRoot),
      responseBytes: commands.reduce((sum, command) => sum + command.stdoutBytes, 0)
    },
    commands,
    failure: null
  };
}

function gitnexusQuery(item) {
  if (item.recordKind === 'node') {
    const label = { interface: 'Interface', struct: 'Struct', method: 'Method', function: 'Function' }[item.kind];
    if (!label) return null;
    return `MATCH (n:${label}) WHERE n.name = ${cypherString(item.name)} AND n.filePath = ${cypherString(locatorPath(item.locator))} RETURN n.id LIMIT 2`;
  }
  if (item.recordKind !== 'edge' || item.kind === 'constructs') return null;
  const relation = { imports: 'IMPORTS', calls: 'CALLS', handles_route: 'HANDLES_ROUTE' }[item.kind];
  if (!relation) return null;
  if (item.kind === 'imports') {
    return `MATCH (a)-[r:CodeRelation {type: '${relation}'}]->(b) WHERE a.filePath = ${cypherString(locatorPath(item.from.locator))} AND b.filePath = ${cypherString(locatorPath(item.to.locator))} RETURN b.id LIMIT 2`;
  }
  if (item.kind === 'handles_route') {
    const method = item.to.name.split('_', 1)[0];
    const routePath = {
      cititem_go_gin_route: '/items/:item_id',
      cititem_go_net_http_route: '/legacy/{item_id}'
    }[item.id];
    if (!routePath) return null;
    return `MATCH (a:Function), (b:Route) WHERE a.name = ${cypherString(item.from.name)} AND a.filePath = ${cypherString(locatorPath(item.from.locator))} AND b.handlerSymbolId = a.id AND b.method = ${cypherString(method)} AND b.name = ${cypherString(routePath)} RETURN b.id LIMIT 2`;
  }
  return `MATCH (a)-[r:CodeRelation {type: '${relation}'}]->(b) WHERE a.name = ${cypherString(item.from.name)} AND a.filePath = ${cypherString(locatorPath(item.from.locator))} AND b.name = ${cypherString(item.to.name)} AND b.filePath = ${cypherString(locatorPath(item.to.locator))} RETURN b.id LIMIT 2`;
}

function invoke(command, args, { cwd, env, id, argvTemplate, timeout = 30_000 }) {
  const started = process.hrtime.bigint();
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024 });
  const durationMs = roundDuration(started);
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return {
    ok: !result.error && result.status === 0,
    stdout,
    receipt: {
      id,
      argvTemplate,
      exitCode: Number.isInteger(result.status) ? result.status : null,
      signal: result.signal ?? null,
      timedOut: result.error?.code === 'ETIMEDOUT',
      durationMs,
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: Buffer.byteLength(stderr),
      stdoutSha256: sha256(stdout),
      stderrSha256: sha256(stderr)
    }
  };
}

function unavailableReport(options, code) {
  return finalizeReport({
    schemaVersion: '1.0.0',
    reportVersion: 'memory-recall-code-intelligence-phase8-gitnexus-go-fixture-1',
    status: 'unavailable',
    generatedAt: process.env.OAF_FIXED_NOW ?? new Date().toISOString(),
    inputs: {
      fixture: 'fixture://go-batch-b',
      truthId: 'citruth_go_batch_b_fixture',
      truthFingerprint: null,
      language: 'go',
      gitnexus: {
        version: options.gitnexusVersion ?? null,
        upstreamSha: options.gitnexusSha ?? null,
        licenseAcknowledgement: options.licenseAcknowledgement === LICENSE_ACKNOWLEDGEMENT ? 'provided' : 'missing'
      }
    },
    runs: {
      memoryRecall: unavailableRun('comparison_not_started'),
      gitnexus: unavailableRun(code)
    },
    gates: [
      { id: 'identical-reviewed-fixture-correctness', status: 'unavailable' },
      { id: 'performance-non-inferiority', status: 'unavailable' },
      { id: 'full-tier1-real-repository-corpus', status: 'unavailable' }
    ],
    gateDecision: 'fail',
    claims: { parity: false, leadership: false, reason: 'The competitor comparison did not execute.' },
    safeguards: {
      rawSourceStored: false,
      absolutePathsStored: false,
      rawCommandOutputStored: false,
      environmentVariablesStored: false,
      sourceFilesMutated: false,
      modelCalls: 0,
      networkCallsDuringMeasuredCommands: null,
      networkIsolation: 'not-enforced',
      canonicalMemoryWrites: 0,
      competitorHomeIsolated: true,
      competitorRepositoryDisposable: true
    }
  });
}

function executionFailureReport(options) {
  const report = unavailableReport(options, 'comparison_execution_failed');
  return finalizeReport({
    ...report,
    status: 'failed',
    generatedAt: process.env.OAF_FIXED_NOW ?? new Date().toISOString(),
    runs: {
      memoryRecall: failedRun('comparison_execution_failed', 'execution'),
      gitnexus: failedRun('comparison_execution_failed', 'execution')
    },
    claims: { parity: false, leadership: false, reason: 'The comparison failed before a safe measured receipt was produced.' },
    reportFingerprint: undefined
  });
}

function failedRun(code, stage, commands = []) {
  return { status: 'failed', product: null, evaluation: null, performance: null, commands, failure: { stage, code } };
}

function unavailableRun(code, stage = 'preflight') {
  return { status: 'unavailable', product: null, evaluation: null, performance: null, commands: [], failure: { stage, code } };
}

function compactEvaluation(report) {
  return {
    graphFingerprints: report.graphFingerprints,
    metrics: report.metrics,
    capabilities: report.capabilities,
    failures: report.failures,
    gateDecision: report.gateDecision,
    reportFingerprint: report.reportFingerprint
  };
}

function finalizeReport(report) {
  const { structuralFingerprint: _structuralFingerprint, reportFingerprint: _reportFingerprint, ...withoutFingerprints } = report;
  const withStructuralFingerprint = {
    ...withoutFingerprints,
    structuralFingerprint: fingerprint(comparableReport(withoutFingerprints))
  };
  const finalized = { ...withStructuralFingerprint, reportFingerprint: fingerprint(withStructuralFingerprint) };
  if (PRIVATE_PATH.test(JSON.stringify(finalized))) throw new Error('phase8_report_private_path_leak');
  return finalized;
}

function comparableReport(report) {
  const { generatedAt: _generatedAt, runs, ...stable } = report;
  return {
    ...stable,
    runs: Object.fromEntries(Object.entries(runs).map(([name, run]) => {
      const { commands, performance, ...stableRun } = run;
      return [name, {
        ...stableRun,
        commands: commands.map(({ durationMs: _durationMs, ...command }) => command),
        performance: performance && {
          indexBytes: performance.indexBytes,
          responseBytes: performance.responseBytes,
          querySampleCount: performance.queryDurationMs?.sampleCount ?? null
        }
      }];
    }))
  };
}

function printReport(report) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    const value = args[index + 1];
    if (!name.startsWith('--') || value === undefined || value.startsWith('--')) throw new Error(`invalid_argument:${name}`);
    index += 1;
    if (name === '--gitnexus-cli') parsed.gitnexusCli = value;
    else if (name === '--gitnexus-version') parsed.gitnexusVersion = value;
    else if (name === '--gitnexus-sha') parsed.gitnexusSha = value;
    else if (name === '--license-acknowledgement') parsed.licenseAcknowledgement = value;
    else if (name === '--memory-recall-binary') parsed.memoryRecallBinary = value;
    else throw new Error(`unknown_argument:${name}`);
  }
  if (parsed.gitnexusCli && !/^\d+\.\d+\.\d+$/u.test(parsed.gitnexusVersion ?? '')) throw new Error('gitnexus_version_invalid');
  if (parsed.gitnexusCli && !/^[a-f0-9]{40}$/u.test(parsed.gitnexusSha ?? '')) throw new Error('gitnexus_sha_invalid');
  if (parsed.gitnexusCli && !path.isAbsolute(parsed.gitnexusCli)) throw new Error('gitnexus_cli_absolute_path_required');
  return parsed;
}

function locatorPath(locator) {
  const match = /^workspace:\/\/([^#]+)#/u.exec(locator);
  if (!match) throw new Error('truth_locator_invalid');
  return match[1];
}

function cypherString(value) {
  return `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function ratio(numerator, denominator) {
  return { numerator, denominator, value: denominator === 0 ? null : Number((numerator / denominator).toFixed(6)) };
}

function percentileSummary(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const at = (percentile) => sorted[Math.min(sorted.length - 1, Math.ceil((percentile / 100) * sorted.length) - 1)];
  return { sampleCount: sorted.length, p50: at(50), p95: at(95), p99: at(99) };
}

function roundDuration(started) {
  return Number((Number(process.hrtime.bigint() - started) / 1_000_000).toFixed(3));
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function fingerprint(value) {
  return sha256(stableStringify(value));
}

async function fileFingerprint(filePath) {
  return sha256(await readFile(filePath));
}

function fileFingerprintSync(filePath) {
  try {
    return sha256(readFileSync(filePath));
  } catch {
    return null;
  }
}

async function pathExists(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function treeFingerprint(directory) {
  const records = [];
  await visit(directory, '');
  return sha256(records.join('\n'));

  async function visit(current, relative) {
    const entries = await readdirSorted(current);
    for (const entry of entries) {
      if (!relative && (entry.name === '.gitnexus' || entry.name === 'gitnexus.json')) continue;
      const entryPath = path.join(current, entry.name);
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        records.push(`d:${entryRelative}`);
        await visit(entryPath, entryRelative);
      } else if (entry.isFile()) {
        records.push(`f:${entryRelative}:${sha256(await readFile(entryPath))}`);
      }
    }
  }
}

async function generatedIndexBytes(repository) {
  let total = 0;
  for (const candidate of [path.join(repository, '.gitnexus'), path.join(repository, 'gitnexus.json')]) {
    total += await pathBytes(candidate);
  }
  return total;
}

async function pathBytes(candidate) {
  try {
    const info = await stat(candidate);
    if (info.isFile()) return info.size;
    if (!info.isDirectory()) return 0;
    let total = 0;
    for (const entry of await readdirSorted(candidate)) total += await pathBytes(path.join(candidate, entry.name));
    return total;
  } catch {
    return 0;
  }
}

async function readdirSorted(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}
