#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { compileContext } from '../../packages/context-compiler/src/index.mjs';
import { createBenchmarkDataset, runBenchmarkTruthFloor } from '../../packages/evaluation-lab/src/index.mjs';
import {
  buildContextPack,
  buildContextPackCurrentPointer,
  buildContextPackImpactBrief,
  buildContextPackRegistry,
  buildContextPackRegistryEntry,
  buildContextPackUsePlan,
  buildHarnessContextPreview,
  buildHarnessSetupReport,
  detectGitChangedLocators,
  loadCurrentContextPackUsePlan,
  renderContextPackMarkdown,
  scanHarnessContext,
  verifyContextPackRegistry
} from '../../packages/harness-context/src/index.mjs';
import {
  buildMemoryProfileReport,
  buildMemoryProposalsReport,
  buildMemorySgrepReport,
  evaluateMemoryWrite,
  normalizeMemoryPathsConfig
} from '../../packages/memory-core/src/index.mjs';
import { assertSafeContextPackUsePlanForResource, buildOafReadOnlyResourceCatalog, createMcpBridge } from '../../packages/protocol-bridges/src/index.mjs';
import contextPackUsePlanSchema from '../../packages/protocol/schemas/context-pack-use-plan.schema.json' with { type: 'json' };
import contextPackHandoffReportSchema from '../../packages/protocol/schemas/context-pack-handoff-report.schema.json' with { type: 'json' };
import contextPackMeasurementReportSchema from '../../packages/protocol/schemas/context-pack-measurement-report.schema.json' with { type: 'json' };
import contextPackReceiveReportSchema from '../../packages/protocol/schemas/context-pack-receive-report.schema.json' with { type: 'json' };
import mcpContextPackSmokeSchema from '../../packages/protocol/schemas/mcp-context-pack-smoke.schema.json' with { type: 'json' };
import { assertJsonSchema } from '../../packages/protocol/src/schema-validator.mjs';
import {
  DEFAULT_SOURCE_GRAPH_PREVIEW_MAX_FILE_BYTES,
  buildSourceGraphPreview
} from '../../packages/source-graph/src/index.mjs';

const CLI_PATH = fileURLToPath(import.meta.url);
const MCP_STDIO_MAX_STDIN_BYTES = boundedEnvInteger('OAF_MCP_STDIO_MAX_STDIN_BYTES', 64 * 1024, { min: 1, max: 512 * 1024 });
const MCP_STDIO_MAX_LINE_BYTES = boundedEnvInteger('OAF_MCP_STDIO_MAX_LINE_BYTES', 32 * 1024, { min: 1, max: 512 * 1024 });
const MCP_STDIO_MAX_MESSAGES = boundedEnvInteger('OAF_MCP_STDIO_MAX_MESSAGES', 16, { min: 1, max: 64 });
const MCP_STDIO_CHILD_TIMEOUT_MS = boundedEnvInteger('OAF_MCP_STDIO_CHILD_TIMEOUT_MS', 30_000, { min: 1, max: 60_000 });
const MCP_STDIO_CHILD_MAX_STDOUT_BYTES = boundedEnvInteger('OAF_MCP_STDIO_CHILD_MAX_STDOUT_BYTES', 512 * 1024, { min: 1, max: 2_000_000 });
const MCP_STDIO_CHILD_MAX_STDERR_BYTES = boundedEnvInteger('OAF_MCP_STDIO_CHILD_MAX_STDERR_BYTES', 64 * 1024, { min: 1, max: 512 * 1024 });

const [command = 'help', ...args] = process.argv.slice(2);
const commands = new Map([
  ['doctor', ['scripts/doctor.mjs']],
  ['demo', ['scripts/demo.mjs', ...args]],
  ['serve', ['services/control-api/src/server.mjs']],
  ['check', ['scripts/check.mjs']],
  ['eval', ['scripts/run-evals.mjs']],
  ['manifest', ['scripts/generate-manifest.mjs']],
  ['status', ['scripts/status.mjs']],
  ['task', ['scripts/task.mjs', ...args]]
]);

if (commands.has(command)) {
  process.exitCode = await runNode(commands.get(command));
} else if (command === 'context') {
  await contextCommand(args);
} else if (command === 'benchmark') {
  await benchmarkCommand(args);
} else if (command === 'memory') {
  await memoryCommand(args);
} else if (command === 'mcp') {
  await mcpCommand(args);
} else if (command === 'measure') {
  await measureCommand(args);
} else if (command === 'harness') {
  await harnessCommand(args);
} else if (['help', '--help', '-h'].includes(command)) {
  help();
} else if (['version', '--version', '-v'].includes(command)) {
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  console.log(pkg.version);
} else {
  console.error(`Unknown command: ${command}\n`);
  help();
  process.exitCode = 2;
}

async function memoryCommand(values) {
  const [subcommand, ...rest] = values;
  try {
    if (subcommand === 'profile') return await memoryProfileCommand(rest);
    if (subcommand === 'proposals') return await memoryProposalsCommand(rest);
    if (subcommand === 'sgrep') return await memorySgrepCommand(rest);
    console.error('memory requires profile, proposals, or sgrep');
    process.exitCode = 2;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

async function measureCommand(values) {
  const [subcommand, ...rest] = values;
  try {
    if (subcommand === 'context-pack') return await measureContextPackCommand(rest);
    console.error('measure requires context-pack');
    process.exitCode = 2;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

async function measureContextPackCommand(values) {
  if (!values.includes('--read-only')) {
    console.error('measure context-pack requires --read-only');
    process.exitCode = 2;
    return;
  }
  if (values.includes('--write') || values.includes('--out') || values.includes('--pin') || values.includes('--use-out')) {
    console.error('measure context-pack is read-only and does not write or pin context packs');
    process.exitCode = 2;
    return;
  }
  if (values.includes('--stdio') || values.includes('--dry-run')) {
    console.error('measure context-pack uses --read-only only; --stdio and --dry-run are not accepted');
    process.exitCode = 2;
    return;
  }
  const valueOptions = new Set([
    '--root',
    '--workspace',
    '--from',
    '--objective',
    '--step',
    '--target',
    '--target-harness',
    '--include-file',
    '--changed',
    '--changed-locator',
    '--changed-from',
    '--token-budget',
    '--budget',
    '--format'
  ]);
  const unsupported = unsupportedFlags(values, new Set(['--read-only', '--changed-from-git', ...valueOptions]), valueOptions);
  if (unsupported.length > 0) {
    console.error(`measure context-pack unsupported option: ${unsupported[0]}`);
    process.exitCode = 2;
    return;
  }
  const changedFrom = option(values, '--changed-from');
  if (changedFrom !== null && changedFrom !== 'git') {
    console.error('measure context-pack only supports --changed-from git');
    process.exitCode = 2;
    return;
  }
  const format = option(values, '--format') ?? 'json';
  if (format !== 'json') {
    console.error('measure context-pack only supports --format json');
    process.exitCode = 2;
    return;
  }
  const objective = option(values, '--objective');
  const step = option(values, '--step');
  if (!objective || !step) {
    console.error('measure context-pack requires --objective <text> and --step <text>');
    process.exitCode = 2;
    return;
  }
  const report = await buildContextPackMeasurementReport(values, { objective, step });
  console.log(JSON.stringify(report, null, 2));
}

async function memoryProfileCommand(values) {
  if (!validateJsonFormat(values)) return;
  const mode = localReportMode(values);
  if (!mode) return;
  const workspaceId = option(values, '--workspace') ?? 'ws_local';
  const root = option(values, '--root') ?? process.cwd();
  const records = await loadMemoryRecords(values);
  if (!records) return;
  const targetPath = option(values, '--out') ?? 'memory/profile.md';
  const projected = buildMemoryProfileReport({
    records,
    workspaceId,
    generatedAt: fixedNow(),
    targetPath,
    dryRun: mode === 'dry-run',
    localFilesWritten: mode === 'write' ? 1 : 0
  });
  if (mode === 'write') await writeWorkspaceFile(root, projected.target.locator, projected.markdown);
  console.log(JSON.stringify(projected, null, 2));
}

async function memoryProposalsCommand(values) {
  if (!validateJsonFormat(values)) return;
  const mode = localReportMode(values);
  if (!mode) return;
  const workspaceId = option(values, '--workspace') ?? 'ws_local';
  const root = option(values, '--root') ?? process.cwd();
  const records = values.includes('--from') && option(values, '--from') === 'memoryPaths'
    ? await loadMemoryPathProposalRecords(values, { workspaceId, root })
    : await loadMemoryRecords(values);
  if (!records) return;
  const targetDirectory = option(values, '--out') ?? 'memory/proposals';
  const dryProjected = buildMemoryProposalsReport({
    records,
    workspaceId,
    generatedAt: fixedNow(),
    targetDirectory,
    dryRun: mode === 'dry-run',
    localFilesWritten: 0
  });
  const projected = mode === 'write'
    ? buildMemoryProposalsReport({
      records,
      workspaceId,
      generatedAt: fixedNow(),
      targetDirectory,
      dryRun: false,
      localFilesWritten: dryProjected.items.length
    })
    : dryProjected;
  if (mode === 'write') {
    for (const item of projected.items) await writeWorkspaceFile(root, item.target.locator, item.markdown);
  }
  console.log(JSON.stringify(projected, null, 2));
}

async function memorySgrepCommand(values) {
  if (!validateJsonFormat(values)) return;
  if (!values.includes('--dry-run')) {
    console.error('memory sgrep --dry-run is required; it never writes files or canonical memory');
    process.exitCode = 2;
    return;
  }
  const query = values.find((value, index) => index === 0 && !value.startsWith('--')) ?? option(values, '--query');
  if (!query) {
    console.error('memory sgrep requires a query');
    process.exitCode = 2;
    return;
  }
  const workspaceId = option(values, '--workspace') ?? 'ws_local';
  const limit = parseIntegerOption(values, '--limit', 20);
  const records = await loadMemorySearchRecords(values, { workspaceId, query, limit });
  if (!records) return;
  const manifestPath = option(values, '--manifest');
  const manifest = manifestPath ? JSON.parse(await readFile(manifestPath, 'utf8')) : null;
  const report = buildMemorySgrepReport({
    query,
    records,
    workspaceId,
    generatedAt: fixedNow(),
    limit,
    manifest
  });
  console.log(JSON.stringify(report, null, 2));
}

async function contextCommand(values) {
  if (values[0] === 'scan') return contextScanCommand(values.slice(1));
  if (values[0] === 'preview') return contextPreviewCommand(values.slice(1));
  if (values[0] === 'pack') return contextPackCommand(values.slice(1));
  if (values[0] === 'handoff') return contextHandoffCommand(values.slice(1));
  if (values[0] === 'receive') return contextReceiveCommand(values.slice(1));
  if (values[0] === 'registry') return contextRegistryCommand(values.slice(1));
  if (values[0] === 'graph') {
    if (values[1] === 'preview') return contextGraphPreviewCommand(values.slice(2));
    console.error('context graph requires preview');
    process.exitCode = 2;
    return;
  }

  const requestPath = option(values, '--request');
  const recordsPath = option(values, '--records');
  if (!requestPath || !recordsPath) {
    console.error('context requires --request <json> and --records <json>, context scan --from <harness> --dry-run, context preview --from <harness> --dry-run, context pack --dry-run, context handoff --read-only, context receive --read-only, or context graph preview --dry-run');
    process.exitCode = 2;
    return;
  }
  const request = JSON.parse(await readFile(requestPath, 'utf8'));
  const records = JSON.parse(await readFile(recordsPath, 'utf8'));
  console.log(JSON.stringify(compileContext(request, records), null, 2));
}

async function benchmarkCommand(values) {
  if (values[0] !== 'truth-floor') {
    console.error('benchmark requires truth-floor');
    process.exitCode = 2;
    return;
  }

  const suite = option(values, '--suite') ?? 'benchmark-truth-floor';
  const datasetPath = option(values, '--dataset') ?? 'evals/benchmark-truth-floor/cases.v1.json';
  const format = option(values, '--format') ?? 'json';
  if (suite !== 'benchmark-truth-floor') {
    console.error(`unsupported suite: ${suite}`);
    process.exitCode = 2;
    return;
  }
  if (format !== 'json') {
    console.error('benchmark truth-floor only supports --format json');
    process.exitCode = 2;
    return;
  }

  try {
    const input = JSON.parse(await readFile(datasetPath, 'utf8'));
    const dataset = createBenchmarkDataset({ ...input, suite });
    const report = await runBenchmarkTruthFloor(dataset, {
      clock: () => '2026-06-23T00:00:00.000Z',
      commitSha: resolveCommitSha(),
      runner: { name: 'apps/cli/oaf.mjs benchmark truth-floor', version: '1.0.0' },
      subject: {
        kind: 'context-benchmark',
        id: 'native-context-baselines',
        version: '1.0.0',
        fingerprint: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
      }
    });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.gateDecision === 'pass' ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

async function contextScanCommand(values) {
  if (!values.includes('--dry-run')) {
    console.error('context scan --dry-run is required; import and writes are not implemented');
    process.exitCode = 2;
    return;
  }

  const from = option(values, '--from') ?? 'all';
  const root = option(values, '--root') ?? process.cwd();
  const workspaceId = option(values, '--workspace') ?? 'ws_local';
  const harnesses = normalizeHarnesses(from);
  try {
    const report = await scanHarnessContext({ root, harnesses, workspaceId });
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

async function contextPreviewCommand(values) {
  if (!values.includes('--dry-run')) {
    console.error('context preview --dry-run is required; import, memory writes, model calls, and source snapshots are not implemented');
    process.exitCode = 2;
    return;
  }

  const objective = option(values, '--objective');
  const step = option(values, '--step');
  if (!objective || !step) {
    console.error('context preview requires --objective <text> and --step <text>');
    process.exitCode = 2;
    return;
  }

  const from = option(values, '--from') ?? 'all';
  const root = option(values, '--root') ?? process.cwd();
  const workspaceId = option(values, '--workspace') ?? 'ws_local';
  const tokenBudget = parseIntegerOption(values, '--token-budget', parseIntegerOption(values, '--budget', 4096));
  const harnesses = normalizeHarnesses(from);
  const userSelectedFiles = options(values, '--include-file');
  try {
    const preview = await buildHarnessContextPreview({ root, harnesses, userSelectedFiles, workspaceId, objective, step, tokenBudget });
    console.log(JSON.stringify(preview, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

async function contextPackCommand(values) {
  const dryRun = values.includes('--dry-run');
  const write = values.includes('--write');
  if (dryRun === write) {
    console.error('context pack requires exactly one of --dry-run or --write');
    process.exitCode = 2;
    return;
  }
  if (values.includes('--pin') && !write) {
    console.error('context pack --pin requires --write');
    process.exitCode = 2;
    return;
  }

  const objective = option(values, '--objective');
  const step = option(values, '--step');
  if (!objective || !step) {
    console.error('context pack requires --objective <text> and --step <text>');
    process.exitCode = 2;
    return;
  }

  const format = option(values, '--format') ?? 'json';
  if (!['json', 'markdown', 'use-json'].includes(format)) {
    console.error('context pack only supports --format json, --format markdown, or --format use-json');
    process.exitCode = 2;
    return;
  }

  const from = option(values, '--from') ?? 'all';
  const root = option(values, '--root') ?? process.cwd();
  const workspaceId = option(values, '--workspace') ?? 'ws_local';
  const tokenBudget = parseIntegerOption(values, '--token-budget', parseIntegerOption(values, '--budget', 4096));
  const targetHarness = option(values, '--target') ?? option(values, '--target-harness') ?? 'generic';
  const harnesses = normalizeHarnesses(from);
  const userSelectedFiles = options(values, '--include-file');
  try {
    const { changedLocators, detection: changedLocatorDetection } = await resolveChangedLocators(values, { root, workspaceId });
    const pack = await buildContextPack({ root, harnesses, userSelectedFiles, changedLocators, workspaceId, objective, step, targetHarness, tokenBudget });
    const markdown = renderContextPackMarkdown(pack);
    const usePlan = buildContextPackUsePlan(pack);
    if (write) {
      const out = option(values, '--out') ?? 'context-packs/CONTEXT_PACK.md';
      const useOut = option(values, '--use-out') ?? (values.includes('--pin') ? defaultUsePlanPathFor(out) : null);
      await writeWorkspaceFile(root, `workspace://${out}`, markdown);
      const usePlanContent = JSON.stringify(usePlan, null, 2);
      if (useOut) await writeWorkspaceFile(root, `workspace://${useOut}`, usePlanContent);
      if (values.includes('--pin')) {
        const registryEntry = buildContextPackRegistryEntry({
          pack,
          usePlan,
          markdown,
          markdownPath: out,
          usePlanContent,
          usePlanPath: useOut,
          createdAt: fixedNow()
        });
        const existingRegistry = await readOptionalContextPackRegistry(root);
        const registry = buildContextPackRegistry({
          existingRegistry,
          entry: registryEntry,
          workspaceId,
          updatedAt: fixedNow()
        });
        const current = buildContextPackCurrentPointer({ registry, entry: registryEntry, updatedAt: fixedNow() });
        await writeWorkspaceFile(root, 'workspace://context-packs/registry.json', JSON.stringify(registry, null, 2));
        await writeWorkspaceFile(root, 'workspace://context-packs/current.json', JSON.stringify(current, null, 2));
        const report = {
          schemaVersion: '1.0.0',
          usePlan,
          target: { locator: `workspace://${out}`, contentType: 'text/markdown' },
          usePlanTarget: { locator: `workspace://${useOut}`, contentType: 'application/json' },
          registryTarget: { locator: 'workspace://context-packs/registry.json', contentType: 'application/json' },
          currentTarget: { locator: 'workspace://context-packs/current.json', contentType: 'application/json' },
          registryEntry,
          registry: {
            currentEntryId: registry.currentEntryId,
            entryCount: registry.entries.length,
            registryFingerprint: registry.registryFingerprint
          },
          changedLocatorDetection,
          localFilesWritten: 4,
          safeguards: {
            externalWritesEnabled: false,
            externalAdaptersEnabled: 0,
            rawBodyIncluded: false
          }
        };
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      const report = {
        schemaVersion: '1.0.0',
        pack,
        usePlan,
        target: { locator: `workspace://${out}`, contentType: 'text/markdown' },
        usePlanTarget: useOut ? { locator: `workspace://${useOut}`, contentType: 'application/json' } : null,
        changedLocatorDetection,
        localFilesWritten: useOut ? 2 : 1,
        safeguards: {
          externalWritesEnabled: false,
          externalAdaptersEnabled: 0,
          rawBodyIncluded: false
        }
      };
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    if (format === 'markdown') {
      console.log(markdown);
      return;
    }
    if (format === 'use-json') {
      console.log(JSON.stringify(usePlan, null, 2));
      return;
    }
    console.log(JSON.stringify({ schemaVersion: '1.0.0', pack, markdown, usePlan, changedLocatorDetection, localFilesWritten: 0 }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

async function contextHandoffCommand(values) {
  if (!values.includes('--read-only')) {
    console.error('context handoff requires --read-only');
    process.exitCode = 2;
    return;
  }
  if (values.includes('--write') || values.includes('--out') || values.includes('--pin') || values.includes('--use-out') || values.includes('--stdio')) {
    console.error('context handoff is read-only and does not write, pin, output files, or run as an MCP stdio server');
    process.exitCode = 2;
    return;
  }
  const format = option(values, '--format') ?? 'json';
  if (format !== 'json') {
    console.error('context handoff only supports --format json');
    process.exitCode = 2;
    return;
  }
  const objective = option(values, '--objective');
  const step = option(values, '--step');
  if (!objective || !step) {
    console.error('context handoff requires --objective <text> and --step <text>');
    process.exitCode = 2;
    return;
  }
  try {
    const report = await buildContextHandoffReport(values, { objective, step });
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

async function contextReceiveCommand(values) {
  if (!values.includes('--read-only')) {
    console.error('context receive requires --read-only');
    process.exitCode = 2;
    return;
  }
  if (values.includes('--write') || values.includes('--out') || values.includes('--pin') || values.includes('--use-out') || values.includes('--stdio')) {
    console.error('context receive is read-only and does not write, pin, output files, or run as an MCP stdio server');
    process.exitCode = 2;
    return;
  }
  if (option(values, '--home') || option(values, '--config') || option(values, '--server')) {
    console.error('context receive uses the default local harness status only; --home, --config, and --server overrides are not accepted');
    process.exitCode = 2;
    return;
  }
  if (option(values, '--objective') || option(values, '--step') || option(values, '--from') || values.includes('--changed-from-git') || options(values, '--changed').length || options(values, '--changed-locator').length || options(values, '--include-file').length) {
    console.error('context receive consumes the pinned context pack; rebuild inputs such as --objective, --step, --from, --changed, or --include-file are not accepted');
    process.exitCode = 2;
    return;
  }
  const format = option(values, '--format') ?? 'json';
  if (format !== 'json') {
    console.error('context receive only supports --format json');
    process.exitCode = 2;
    return;
  }
  try {
    const report = await buildContextReceiveReport(values);
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

async function contextRegistryCommand(values) {
  const subcommand = values[0] ?? 'status';
  if (subcommand !== 'status') {
    console.error('context registry requires status');
    process.exitCode = 2;
    return;
  }
  if (!values.includes('--read-only')) {
    console.error('context registry status requires --read-only');
    process.exitCode = 2;
    return;
  }
  const format = option(values, '--format') ?? 'json';
  if (format !== 'json') {
    console.error('context registry status only supports --format json');
    process.exitCode = 2;
    return;
  }
  const root = option(values, '--root') ?? process.cwd();
  const workspaceId = option(values, '--workspace') ?? 'ws_local';
  try {
    const report = await verifyContextPackRegistry({ root, workspaceId, clock: fixedNow });
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

function defaultUsePlanPathFor(markdownPath) {
  const value = String(markdownPath ?? '');
  if (/^context-packs\/[A-Za-z0-9._-]+\.md$/.test(value)) {
    return value.replace(/\.md$/u, '.use.json');
  }
  return 'context-packs/CONTEXT_PACK.use.json';
}

async function readOptionalContextPackRegistry(root) {
  try {
    return JSON.parse(await readFile(path.resolve(root, 'context-packs', 'registry.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function contextGraphPreviewCommand(values) {
  if (!values.includes('--dry-run')) {
    console.error('context graph preview --dry-run is required; graph preview never writes files, mutates canonical state, calls models, or enables adapters');
    process.exitCode = 2;
    return;
  }

  const format = option(values, '--format') ?? 'json';
  if (format !== 'json') {
    console.error('context graph preview only supports --format json');
    process.exitCode = 2;
    return;
  }

  const root = option(values, '--root') ?? process.cwd();
  const workspaceId = option(values, '--workspace') ?? 'ws_local';
  const query = option(values, '--query') ?? firstPositional(values) ?? '';
  try {
    const { changedLocators } = await resolveChangedLocators(values, { root, workspaceId });
    const preview = await buildSourceGraphPreview({
      root,
      workspaceId,
      query,
      startName: option(values, '--trace') ?? option(values, '--start-name'),
      startNodeId: option(values, '--start-node'),
      changedLocators: [...changedLocators, ...(option(values, '--changed-locators') ? [option(values, '--changed-locators')] : [])],
      nodeKinds: option(values, '--node-kinds'),
      edgeKinds: option(values, '--edge-kinds'),
      labelPattern: option(values, '--label-pattern'),
      locatorPrefix: option(values, '--locator-prefix'),
      direction: option(values, '--direction') ?? 'outbound',
      limit: strictIntegerOption(values, '--limit', 20),
      offset: strictIntegerOption(values, '--offset', 0),
      depth: strictIntegerOption(values, '--depth', 2),
      sampleLimit: strictIntegerOption(values, '--sample-limit', 12),
      maxFiles: strictIntegerOption(values, '--max-files', 200),
      maxFileBytes: strictIntegerOption(values, '--max-file-bytes', DEFAULT_SOURCE_GRAPH_PREVIEW_MAX_FILE_BYTES),
      clock: fixedNow
    });
    console.log(JSON.stringify(preview, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

async function mcpCommand(values) {
  const [subcommand, ...rest] = values;
  try {
    if (subcommand === 'resources') return await mcpResourcesCommand(rest);
    if (subcommand === 'smoke') return await mcpSmokeCommand(rest);
    console.error('mcp requires resources or smoke');
    process.exitCode = 2;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

async function mcpSmokeCommand(values) {
  const [target, ...rest] = values;
  if (target !== 'context-pack') {
    console.error('mcp smoke requires context-pack');
    process.exitCode = 2;
    return;
  }
  if (!rest.includes('--read-only')) {
    console.error('mcp smoke context-pack requires --read-only');
    process.exitCode = 2;
    return;
  }
  if (rest.includes('--write') || rest.includes('--out') || rest.includes('--stdio')) {
    console.error('mcp smoke context-pack is read-only and manages its own stdio bridge invocation');
    process.exitCode = 2;
    return;
  }
  const format = option(rest, '--format') ?? 'json';
  if (format !== 'json') {
    console.error('mcp smoke context-pack only supports --format json');
    process.exitCode = 2;
    return;
  }
  const objective = option(rest, '--objective');
  const step = option(rest, '--step');
  if (!objective || !step) {
    console.error('mcp smoke context-pack requires --objective <text> and --step <text>');
    process.exitCode = 2;
    return;
  }
  const report = await buildMcpContextPackSmokeReport(rest, { objective, step });
  console.log(JSON.stringify(report, null, 2));
}

async function harnessCommand(values) {
  const [subcommand, ...rest] = values;
  try {
    if (subcommand !== 'setup') {
      console.error('harness requires setup');
      process.exitCode = 2;
      return;
    }
    return await harnessSetupCommand(rest);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

async function harnessSetupCommand(values) {
  const [action, ...rest] = values;
  if (!['status', 'plan', 'uninstall'].includes(action)) {
    console.error('harness setup requires status, plan, or uninstall');
    process.exitCode = 2;
    return;
  }
  if (!rest.includes('--dry-run')) {
    console.error('harness setup requires --dry-run; config writes are not implemented by this command');
    process.exitCode = 2;
    return;
  }
  if (rest.includes('--write')) {
    console.error('harness setup is dry-run only; config writes are not implemented by this command');
    process.exitCode = 2;
    return;
  }
  const format = option(rest, '--format') ?? 'json';
  if (format !== 'json') {
    console.error('harness setup only supports --format json');
    process.exitCode = 2;
    return;
  }
  const home = option(rest, '--home') ?? process.env.HOME ?? process.cwd();
  const report = await buildHarnessSetupReport({
    action,
    client: option(rest, '--client'),
    server: option(rest, '--server') ?? 'oaf',
    home,
    configPath: option(rest, '--config'),
    generatedAt: fixedNow()
  });
  console.log(JSON.stringify(report, null, 2));
}

async function mcpResourcesCommand(values) {
  if (!values.includes('--read-only')) {
    console.error('mcp resources requires --read-only; MCP write tools are not exposed by this command');
    process.exitCode = 2;
    return;
  }
  if (values.includes('--write') || values.includes('--out')) {
    console.error('mcp resources is read-only and does not write context packs or output files');
    process.exitCode = 2;
    return;
  }
  const format = option(values, '--format') ?? 'json';
  if (format !== 'json') {
    console.error('mcp resources only supports --format json');
    process.exitCode = 2;
    return;
  }
  const root = option(values, '--root') ?? process.cwd();
  const workspaceId = option(values, '--workspace') ?? 'ws_local';
  const currentContextPackUsePlan = await loadMcpContextPackUsePlan(values, { root, workspaceId });
  const currentContextPack = await buildMcpContextPackResource(values, { root, workspaceId });
  const currentContextPackRegistryStatus = await loadMcpContextPackRegistryStatus(values, { root, workspaceId });
  const state = await loadWorkspaceJson(root, option(values, '--state') ?? '.local/state.json', {
    schemaVersion: '1.0.0',
    runs: [],
    events: [],
    memories: [],
    approvals: [],
    artifacts: []
  });
  const projectStatus = await loadWorkspaceJson(root, option(values, '--project-status') ?? 'PROJECT_STATUS.json', {});
  const resources = buildOafReadOnlyResourceCatalog({
    state,
    projectStatus,
    currentContextPack,
    currentContextPackUsePlan,
    currentContextPackRegistryStatus,
    workspaceId,
    generatedAt: fixedNow()
  });
  const trustedContext = localMcpTrustedContext(workspaceId);

  if (values.includes('--stdio')) {
    await mcpResourcesStdio({ resources, trustedContext });
    return;
  }

  const uri = option(values, '--uri');
  if (uri) {
    const resource = resources.find((item) => item.uri === uri);
    if (!resource) {
      console.error(`unknown MCP resource: ${uri}`);
      process.exitCode = 2;
      return;
    }
    const contents = await resource.read({ trustedContext, replayMode: false });
    console.log(JSON.stringify({
      schemaVersion: '1.0.0',
      mode: 'read-only',
      workspaceId,
      uri,
      contents
    }, null, 2));
    return;
  }

  console.log(JSON.stringify({
    schemaVersion: '1.0.0',
    mode: 'read-only',
    workspaceId,
    resources: resources.map(({ uri: resourceUri, name, description, mimeType }) => ({ uri: resourceUri, name, description, mimeType })),
    safeguards: {
      canonicalStateMutated: false,
      externalWritesEnabled: false,
      externalAdaptersEnabled: 0,
      networkCalls: 0,
      modelCalls: 0
    }
  }, null, 2));
}

async function loadMcpContextPackUsePlan(values, { root, workspaceId }) {
  const relativePath = option(values, '--context-pack-use');
  if (!relativePath) {
    if (values.includes('--context-pack-use')) throw new Error('mcp resources --context-pack-use requires a relative context-packs/*.use.json file');
    if (values.includes('--context-pack')) return null;
    return loadCurrentContextPackUsePlan({ root, workspaceId, clock: fixedNow }).catch(() => null);
  }
  if (values.includes('--context-pack')) {
    throw new Error('mcp resources supports either --context-pack or --context-pack-use, not both');
  }
  if (!/^context-packs\/[A-Za-z0-9._-]+\.use\.json$/.test(relativePath)) {
    throw new Error('mcp resources --context-pack-use must be a relative context-packs/*.use.json file');
  }
  const realRoot = await realpath(root);
  await assertNoSymlinkAncestors(realRoot, relativePath);
  const absolute = path.resolve(realRoot, relativePath);
  const entry = await lstat(absolute);
  if (entry.isSymbolicLink()) throw new Error(`context-pack use plan target is a symlink: ${relativePath}`);
  if (!entry.isFile()) throw new Error(`context-pack use plan target is not a file: ${relativePath}`);
  const actual = await realpath(absolute);
  if (!isInside(realRoot, actual)) throw new Error(`context-pack use plan escapes root: ${relativePath}`);
  const plan = JSON.parse(await readFile(actual, 'utf8'));
  assertJsonSchema(contextPackUsePlanSchema, plan, 'context pack use plan');
  return assertSafeContextPackUsePlanForResource(plan);
}

async function loadMcpContextPackRegistryStatus(values, { root, workspaceId }) {
  const report = values.includes('--context-pack-registry')
    ? await verifyContextPackRegistry({ root, workspaceId, clock: fixedNow })
    : await verifyContextPackRegistry({ root, workspaceId, clock: fixedNow }).catch(() => null);
  if (!report) return null;
  if (values.includes('--context-pack-registry')) return report;
  return report.registry.exists || report.currentPointer.exists ? report : null;
}

async function buildMcpContextPackResource(values, { root, workspaceId }) {
  if (!values.includes('--context-pack')) return null;
  const objective = option(values, '--objective');
  const step = option(values, '--step');
  if (!objective || !step) {
    throw new Error('mcp resources --context-pack requires --objective <text> and --step <text>');
  }
  const from = option(values, '--from') ?? 'all';
  const tokenBudget = parseIntegerOption(values, '--token-budget', parseIntegerOption(values, '--budget', 4096));
  const targetHarness = option(values, '--target') ?? option(values, '--target-harness') ?? 'generic';
  const harnesses = normalizeHarnesses(from);
  const userSelectedFiles = options(values, '--include-file');
  const { changedLocators } = await resolveChangedLocators(values, { root, workspaceId });
  const pack = await buildContextPack({
    root,
    harnesses,
    userSelectedFiles,
    changedLocators,
    workspaceId,
    objective,
    step,
    targetHarness,
    tokenBudget,
    clock: fixedNow
  });
  return {
    pack,
    markdown: renderContextPackMarkdown(pack)
  };
}

async function buildMcpContextPackSmokeReport(values, { objective, step, fixedTimestamp = null }) {
  const root = option(values, '--root') ?? process.cwd();
  const workspaceId = option(values, '--workspace') ?? 'ws_local';
  const targetHarness = option(values, '--target') ?? option(values, '--target-harness') ?? 'generic';
  const from = option(values, '--from') ?? 'all';
  const tokenBudget = parseIntegerOption(values, '--token-budget', parseIntegerOption(values, '--budget', 4096));
  const generatedAt = fixedTimestamp ?? fixedNow();
  const resourceUri = `oaf://workspace/${workspaceId}/context-pack/current`;
  const childArgs = [
    CLI_PATH,
    'mcp',
    'resources',
    '--read-only',
    '--context-pack',
    '--root',
    root,
    '--workspace',
    workspaceId,
    '--from',
    from,
    '--target',
    targetHarness,
    '--objective',
    objective,
    '--step',
    step,
    '--token-budget',
    String(tokenBudget),
    '--format',
    'json',
    '--stdio'
  ];
  for (const value of options(values, '--include-file')) childArgs.push('--include-file', value);
  for (const value of options(values, '--changed')) childArgs.push('--changed', value);
  for (const value of options(values, '--changed-locator')) childArgs.push('--changed-locator', value);
  if (gitChangedLocatorsRequested(values)) childArgs.push('--changed-from-git');

  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize' },
    { jsonrpc: '2.0', id: 2, method: 'resources/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/list' },
    { jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: resourceUri } }
  ];
  const started = process.hrtime.bigint();
  const child = await runCliStdio(childArgs, messages.map((message) => JSON.stringify(message)).join('\n'), {
    env: fixedTimestamp ? { ...process.env, OAF_FIXED_NOW: fixedTimestamp } : process.env
  });
  const durationMs = Math.max(0, Math.round(Number(process.hrtime.bigint() - started) / 1_000_000));
  if (child.code !== 0) {
    throw new Error(`mcp context-pack smoke bridge failed with status ${child.code}`);
  }
  const responses = parseJsonRpcResponseLines(child.stdout, { expectedCount: messages.length });
  const errors = responses.filter((response) => response.error);
  if (errors.length) {
    const code = errors[0].error?.data?.code ?? 'jsonrpc_error';
    throw new Error(`mcp context-pack smoke JSON-RPC failed: ${code}`);
  }
  const listed = responses.find((response) => response.id === 2)?.result?.resources ?? [];
  const tools = responses.find((response) => response.id === 3)?.result?.tools ?? [];
  const read = responses.find((response) => response.id === 4)?.result?.contents?.[0];
  if (!read?.text) throw new Error('mcp context-pack smoke did not return a resource body');
  const payload = parseSmokeResourcePayload(read.text);
  const candidateUnitCount = Number(payload.data?.preview?.candidateUnitCount ?? 0);
  const selectedUnitCount = Number(payload.data?.preview?.selectedUnitCount ?? 0);
  const selectedUnitRatio = Number(payload.data?.preview?.selectedUnitRatio ?? 0);
  const observedReductionRatio = candidateUnitCount > 0 ? Number(Math.max(0, 1 - selectedUnitCount / candidateUnitCount).toFixed(6)) : 0;
  const deliveredUnitCount = Number(payload.data?.delivery?.deliveredTokenCount ?? 0);
  const deliveredUnitRatio = Number(payload.data?.delivery?.deliveredTokenRatio ?? 0);
  const observedDeliveryReductionRatio = Number(payload.data?.delivery?.observedTokenReductionRatio ?? 0);
  const report = {
    schemaVersion: '1.0.0',
    command: 'mcp smoke context-pack',
    generatedAt,
    workspaceId,
    transport: 'stdio',
    resourceUri,
    targetHarness,
    measurementScope: 'single local stdio invocation',
    request: {
      objectiveFingerprint: fingerprintJson(objective),
      objectiveLength: objective.length,
      stepFingerprint: fingerprintJson(step),
      stepLength: step.length,
      userSelectedLocatorCount: options(values, '--include-file').length,
      changedLocatorCount: [...options(values, '--changed'), ...options(values, '--changed-locator')].length,
      unitBudget: tokenBudget
    },
    bridge: {
      invocation: 'oaf mcp resources --read-only --context-pack --stdio',
      jsonRpcMessageCount: messages.length,
      responseCount: responses.length,
      resourcesListed: listed.length,
      toolsExposed: tools.length
    },
    resource: {
      resourceKind: payload.resourceKind,
      resourceFingerprint: payload.resourceFingerprint,
      contextPackFingerprint: payload.data?.contextPackFingerprint ?? null,
      markdownArtifactHash: payload.data?.markdownArtifact?.contentHash ?? null,
      readFirstCount: Number(payload.data?.preview?.selectedCount ?? 0),
      omittedRefCount: Number(payload.data?.omissions?.excludedCount ?? 0),
      changedLocatorCount: Number(payload.data?.sourceGraph?.impact?.changedLocators?.length ?? 0),
      affectedSymbolCount: Number(payload.data?.sourceGraph?.impact?.affectedSymbolCount ?? 0),
      readFirstLocators: (payload.data?.readFirst ?? []).map((item) => item.locator).filter(Boolean).slice(0, 8),
      changedLocators: (payload.data?.sourceGraph?.impact?.changedLocators ?? []).slice(0, 16)
    },
    measurements: {
      durationMs,
      stdoutByteSize: Buffer.byteLength(child.stdout, 'utf8'),
      stderrByteSize: Buffer.byteLength(child.stderr, 'utf8'),
      resourceByteSize: Buffer.byteLength(read.text, 'utf8'),
      candidateUnitCount,
      selectedUnitCount,
      selectedUnitRatio,
      observedReductionRatio,
      deliveredUnitCount,
      deliveredUnitRatio,
      observedDeliveryReductionRatio
    },
    checks: {
      initialized: true,
      resourceListed: listed.some((resource) => resource.uri === resourceUri),
      resourceRead: payload.resourceKind === 'context-pack-summary',
      noToolsExposed: tools.length === 0,
      noMarkdownBody: payload.data?.markdownArtifact?.included === false
    },
    safeguards: {
      readOnly: true,
      canonicalStateMutated: false,
      localFilesWritten: 0,
      externalWritesEnabled: false,
      externalAdaptersEnabled: 0,
      networkCalls: 0,
      modelCalls: 0,
      activeMemoryCreated: 0,
      sourceSnapshotsWritten: 0,
      privateBodiesIncluded: false,
      objectiveTextIncluded: false,
      stepTextIncluded: false,
      markdownBodyIncluded: false,
      absoluteFilesystemLocationsIncluded: false
    },
    reportFingerprint: 'sha256:0000000000000000000000000000000000000000000000000000000000000000'
  };
  report.reportFingerprint = fingerprintJson({ ...report, reportFingerprint: null });
  assertJsonSchema(mcpContextPackSmokeSchema, report, 'mcp context-pack smoke report');
  return report;
}

async function buildContextHandoffReport(values, { objective, step }) {
  const root = option(values, '--root') ?? process.cwd();
  const workspaceId = option(values, '--workspace') ?? 'ws_local';
  const targetHarness = option(values, '--target') ?? option(values, '--target-harness') ?? 'codex';
  const from = option(values, '--from') ?? 'codex';
  const sourceHarnesses = normalizeHarnesses(from);
  const userSelectedFiles = options(values, '--include-file');
  const tokenBudget = parseIntegerOption(values, '--token-budget', parseIntegerOption(values, '--budget', 4096));
  const generatedAt = fixedNow();
  const { changedLocators, detection } = await resolveChangedLocators(values, { root, workspaceId });
  const pack = await buildContextPack({
    root,
    harnesses: sourceHarnesses,
    userSelectedFiles,
    changedLocators,
    workspaceId,
    objective,
    step,
    targetHarness,
    tokenBudget,
    clock: () => generatedAt
  });
  const usePlan = buildContextPackUsePlan(pack);
  assertJsonSchema(contextPackUsePlanSchema, usePlan, 'context-pack handoff use plan');
  const smoke = await buildMcpContextPackSmokeReport(values, { objective, step, fixedTimestamp: generatedAt });
  const setupClient = contextHandoffSetupClient(targetHarness);
  const setup = await buildHarnessSetupReport({
    action: 'plan',
    client: setupClient,
    server: 'oaf',
    home: option(values, '--home') ?? process.env.HOME ?? process.cwd(),
    configPath: option(values, '--config'),
    generatedAt
  });
  const readFirst = usePlan.requiredLocalReads.slice(0, 12).map((item) => ({
    locator: item.locator,
    role: item.role,
    required: item.required,
    represented: item.represented,
    contentHash: item.contentHash,
    readHint: item.readHint,
    reasonCodes: item.reasonCodes
  }));
  const selected = pack.utility.sourceSelection;
  const delivery = pack.delivery ?? {};
  const baseCommand = contextHandoffBaseCommand({ from, objective, step, targetHarness, userSelectedFiles, changedLocators });
  const startMcpBridge = `npm --silent run oaf -- mcp resources --read-only --context-pack ${baseCommand} --stdio`;
  const report = {
    schemaVersion: '1.0.0',
    command: 'context handoff',
    generatedAt,
    workspaceId,
    targetHarness: pack.targetHarness,
    state: pack.utility.status === 'ready' && smoke.checks.resourceRead && smoke.checks.noToolsExposed && smoke.checks.noMarkdownBody && setup.dryRun === true ? 'ready' : 'review',
    commitSha: resolveCommitSha(root),
    measurementScope: 'single local context-pack build, MCP readback, and harness setup dry-run',
    launchPrompt: pack.handoff.launchPrompt,
    request: {
      objectiveFingerprint: fingerprintJson(objective),
      objectiveLength: objective.length,
      stepFingerprint: fingerprintJson(step),
      stepLength: step.length,
      sourceHarnesses,
      userSelectedLocatorCount: userSelectedFiles.length,
      changedLocatorCount: changedLocators.length,
      changedFromGit: Boolean(detection),
      unitBudget: tokenBudget
    },
    contextPack: {
      contextPackFingerprint: pack.contextPackFingerprint,
      utilityStatus: pack.utility.status,
      readFirstCount: pack.readFirst.length,
      omittedRefCount: pack.omissions.excludedCount,
      candidateUnitCount: selected.candidateTokenCount,
      selectedUnitCount: selected.selectedTokenCount,
      selectedUnitRatio: selected.selectedTokenRatio,
      estimatedSelectionReductionRatio: selected.estimatedReductionRatio,
      deliveredUnitCount: Number(delivery.deliveredTokenCount ?? 0),
      deliveredUnitRatio: Number(delivery.deliveredTokenRatio ?? 0),
      observedDeliveryReductionRatio: Number(delivery.observedTokenReductionRatio ?? 0),
      changedSourceBudget: pack.utility.changedSourceBudget,
      changedLocatorCoverage: pack.utility.changedLocatorCoverage,
      graphHintCoverage: pack.utility.graphHintCoverage
    },
    usePlan: {
      resourceUri: usePlan.resource.uri,
      contextPackFingerprint: usePlan.contextPack.fingerprint,
      requiredReadCount: usePlan.requiredLocalReads.length,
      requiredLocalReads: readFirst,
      truncatedRequiredReadCount: Math.max(0, usePlan.requiredLocalReads.length - readFirst.length),
      markdownContentIncluded: usePlan.safeguards.markdownContentIncluded,
      sourceContentIncluded: usePlan.safeguards.sourceContentIncluded
    },
    mcp: {
      resourceUri: smoke.resourceUri,
      setup: {
        dryRun: setup.dryRun,
        client: setup.client,
        configRef: setup.config.ref,
        serverStatus: setup.status.server,
        desiredServer: setup.desiredServer,
        manualConfigSnippet: setup.manualConfigSnippet
      },
      smoke: {
        durationMs: smoke.measurements.durationMs,
        stdoutByteSize: smoke.measurements.stdoutByteSize,
        stderrByteSize: smoke.measurements.stderrByteSize,
        resourceByteSize: smoke.measurements.resourceByteSize,
        resourcesListed: smoke.bridge.resourcesListed,
        toolsExposed: smoke.bridge.toolsExposed,
        resourceFingerprint: smoke.resource.resourceFingerprint,
        contextPackFingerprint: smoke.resource.contextPackFingerprint
      }
    },
    commands: {
      previewSetup: `npm --silent run oaf -- harness setup plan --client ${setupClient} --server oaf --dry-run --format json`,
      startMcpBridge,
      readCurrentContextPack: `npm --silent run oaf -- mcp resources --read-only --context-pack ${baseCommand} --uri oaf://workspace/${workspaceId}/context-pack/current --format json`,
      renderMarkdown: `npm --silent run oaf -- context pack ${baseCommand} --dry-run --format markdown`
    },
    checks: {
      contextPackFingerprintMatchesMcp: smoke.resource.contextPackFingerprint === pack.contextPackFingerprint,
      contextPackFingerprintMatchesUsePlan: usePlan.contextPack.fingerprint === pack.contextPackFingerprint,
      resourceRead: smoke.checks.resourceRead,
      noToolsExposed: smoke.checks.noToolsExposed,
      noMarkdownBody: smoke.checks.noMarkdownBody,
      setupDryRun: setup.dryRun === true,
      setupUsesSilentNpm: setup.desiredServer.command === 'npm' && setup.desiredServer.args[0] === '--silent'
    },
    safeguards: {
      readOnly: true,
      canonicalStateMutated: false,
      localFilesWritten: 0,
      homeConfigMutated: false,
      externalWritesEnabled: false,
      externalAdaptersEnabled: 0,
      networkCalls: 0,
      modelCalls: 0,
      activeMemoryCreated: 0,
      sourceSnapshotsWritten: 0,
      rawSourceBodiesIncluded: false,
      markdownBodyIncluded: false,
      sourceContentIncluded: false,
      credentialsIncluded: false,
      providerUrlsIncluded: false,
      absoluteFilesystemLocationsIncluded: false,
      hiddenReasoningIncluded: false
    },
    reportFingerprint: 'sha256:0000000000000000000000000000000000000000000000000000000000000000'
  };
  report.reportFingerprint = fingerprintJson({ ...report, reportFingerprint: null });
  assertJsonSchema(contextPackHandoffReportSchema, report, 'context-pack handoff report');
  return report;
}

async function buildContextReceiveReport(values) {
  const root = option(values, '--root') ?? process.cwd();
  const workspaceId = option(values, '--workspace') ?? 'ws_local';
  const generatedAt = fixedNow();
  const registryStatus = await verifyContextPackRegistry({ root, workspaceId, clock: () => generatedAt });
  const currentEntry = registryStatus.entries.find((entry) => entry.id === registryStatus.current.entryId) ?? null;
  const usePlan = await loadCurrentContextPackUsePlan({ root, workspaceId, clock: () => generatedAt }).catch(() => null);
  const targetHarness = option(values, '--target') ?? option(values, '--target-harness') ?? usePlan?.targetHarness ?? currentEntry?.targetHarness ?? 'codex';
  const setupClient = contextHandoffSetupClient(targetHarness);
  const setup = await buildHarnessSetupReport({
    action: 'status',
    client: setupClient,
    server: 'oaf',
    home: process.env.HOME ?? process.cwd(),
    generatedAt
  });
  const resources = buildOafReadOnlyResourceCatalog({
    state: {},
    projectStatus: {},
    currentContextPackUsePlan: usePlan,
    currentContextPackRegistryStatus: registryStatus,
    workspaceId,
    generatedAt
  });
  const bridge = createMcpBridge({
    trustedContext: localMcpTrustedContext(workspaceId),
    resources,
    tools: [],
    clock: () => generatedAt
  });
  const usePlanResourceUri = `oaf://workspace/${workspaceId}/context-pack/use-plan/current`;
  const registryResourceUri = `oaf://workspace/${workspaceId}/context-pack/registry/current`;
  const resourcesResponse = await bridge.handle({ jsonrpc: '2.0', id: 1, method: 'resources/list' });
  const toolsResponse = await bridge.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const usePlanRead = usePlan ? await bridge.handle({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: usePlanResourceUri } }) : null;
  const registryRead = await bridge.handle({ jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: registryResourceUri } });
  const usePlanPayload = parseMcpJsonPayload(usePlanRead);
  const registryPayload = parseMcpJsonPayload(registryRead);
  const listedResources = resourcesResponse?.result?.resources ?? [];
  const listedTools = toolsResponse?.result?.tools ?? [];
  const currentStatus = registryStatus.current.status;
  const registryBlocking = !registryStatus.registry.exists
    || !registryStatus.currentPointer.exists
    || registryStatus.registry.fingerprintStatus !== 'verified'
    || registryStatus.currentPointer.fingerprintStatus !== 'verified'
    || currentStatus === 'tampered'
    || currentStatus === 'missing';
  const checks = {
    registryFingerprintVerified: registryStatus.registry.fingerprintStatus === 'verified',
    currentPointerVerified: registryStatus.currentPointer.fingerprintStatus === 'verified',
    currentEntryVerified: currentStatus === 'verified',
    currentEntryMatchesTarget: Boolean(usePlan && currentEntry && usePlan.targetHarness === targetHarness && currentEntry.targetHarness === targetHarness),
    usePlanLoaded: Boolean(usePlan),
    usePlanFingerprintMatchesRegistry: Boolean(usePlan && currentEntry?.usePlan?.fingerprint === usePlan.usePlanFingerprint),
    contextPackFingerprintMatchesRegistry: Boolean(usePlan && currentEntry?.contextPack?.fingerprint === usePlan.contextPack.fingerprint),
    noToolsExposed: listedTools.length === 0,
    usePlanResourceRead: usePlanPayload?.resourceKind === 'context-pack-use-plan',
    registryResourceRead: registryPayload?.resourceKind === 'context-pack-registry-status',
    setupDryRun: setup.dryRun === true,
    setupUsesSilentNpm: setup.desiredServer.command === 'npm' && setup.desiredServer.args[0] === '--silent'
  };
  const readyChecks = [
    checks.registryFingerprintVerified,
    checks.currentPointerVerified,
    checks.currentEntryVerified,
    checks.currentEntryMatchesTarget,
    checks.usePlanLoaded,
    checks.usePlanFingerprintMatchesRegistry,
    checks.contextPackFingerprintMatchesRegistry,
    checks.noToolsExposed,
    checks.usePlanResourceRead,
    checks.registryResourceRead,
    checks.setupDryRun,
    checks.setupUsesSilentNpm
  ];
  const state = registryBlocking
    ? 'blocked'
    : currentStatus !== 'verified'
      ? 'review'
      : !usePlan
        ? 'blocked'
        : (readyChecks.every(Boolean) ? 'ready' : 'review');
  const requiredLocalReads = (usePlan?.requiredLocalReads ?? []).slice(0, 12).map((item) => ({
    locator: item.locator,
    role: item.role,
    required: item.required,
    represented: item.represented,
    contentHash: item.contentHash,
    readHint: item.readHint,
    reasonCodes: item.reasonCodes
  }));
  const commands = {
    createPinnedContextPack: `npm run oaf -- context pack --from codex --root . --objective '<reviewed-objective>' --step '<reviewed-step>' --target ${targetHarness} --write --pin --out context-packs/CONTEXT_PACK.md --format json`,
    checkRegistry: `npm --silent run oaf -- context registry status --read-only --root . --workspace ${workspaceId} --format json`,
    readUsePlan: `npm --silent run oaf -- mcp resources --read-only --root . --workspace ${workspaceId} --uri ${usePlanResourceUri} --format json`,
    readRegistry: `npm --silent run oaf -- mcp resources --read-only --root . --workspace ${workspaceId} --uri ${registryResourceUri} --format json`,
    previewSetup: `npm --silent run oaf -- harness setup status --client ${setupClient} --server oaf --dry-run --format json`,
    startReadOnlyBridge: `npm --silent run oaf -- mcp resources --read-only --root . --workspace ${workspaceId} --stdio`
  };
  const report = {
    schemaVersion: '1.0.0',
    command: 'context receive',
    generatedAt,
    workspaceId,
    targetHarness,
    state,
    commitSha: resolveCommitSha(root),
    measurementScope: 'single pinned context-pack registry/use-plan verification, MCP read-only resource proof, and harness setup status dry-run',
    registry: {
      registryExists: registryStatus.registry.exists,
      currentPointerExists: registryStatus.currentPointer.exists,
      currentEntryId: registryStatus.current.entryId,
      currentStatus,
      registryFingerprintStatus: registryStatus.registry.fingerprintStatus,
      currentPointerFingerprintStatus: registryStatus.currentPointer.fingerprintStatus,
      registryFingerprint: registryStatus.registry.registryFingerprint,
      currentPointerFingerprint: registryStatus.currentPointer.pointerFingerprint,
      entryCount: registryStatus.registry.entryCount,
      currentTargetHarness: currentEntry?.targetHarness ?? null,
      contextPackFingerprint: currentEntry?.contextPack?.fingerprint ?? null,
      usePlanFingerprint: currentEntry?.usePlan?.fingerprint ?? null,
      sourceChecks: currentEntry?.sourceChecks ?? null,
      artifactChecks: (currentEntry?.artifactChecks ?? []).map((item) => ({
        role: item.role,
        locator: item.locator,
        expectedHash: item.expectedHash,
        actualHash: item.actualHash,
        status: item.status,
        reasonCodes: item.reasonCodes
      })),
      warnings: registryStatus.warnings
    },
    usePlan: {
      exists: Boolean(usePlan),
      resourceUri: usePlan?.resource?.uri ?? null,
      id: usePlan?.id ?? null,
      targetHarness: usePlan?.targetHarness ?? null,
      contextPackFingerprint: usePlan?.contextPack?.fingerprint ?? null,
      usePlanFingerprint: usePlan?.usePlanFingerprint ?? null,
      requiredReadCount: usePlan?.requiredLocalReads?.length ?? 0,
      requiredLocalReads,
      truncatedRequiredReadCount: Math.max(0, (usePlan?.requiredLocalReads?.length ?? 0) - requiredLocalReads.length),
      coverage: usePlan?.coverage ?? null,
      sourceSelection: usePlan ? {
        candidateUnitCount: usePlan.sourceSelection.candidateUnitCount,
        selectedUnitCount: usePlan.sourceSelection.selectedUnitCount,
        selectedUnitRatio: usePlan.sourceSelection.selectedUnitRatio,
        estimatedReductionRatio: usePlan.sourceSelection.estimatedReductionRatio
      } : null,
      delivery: usePlan ? {
        representation: usePlan.delivery.representation,
        deliveredUnitCount: usePlan.delivery.deliveredUnitCount,
        deliveredByteSize: usePlan.delivery.deliveredByteSize,
        deliveredUnitRatio: usePlan.delivery.deliveredUnitRatio,
        observedReductionRatio: usePlan.delivery.observedReductionRatio,
        sourceContentIncluded: usePlan.delivery.sourceContentIncluded
      } : null,
      safeguards: usePlan?.safeguards ?? null
    },
    receiverPacket: buildContextReceiverPacket({
      state,
      targetHarness,
      registryStatus,
      currentEntry,
      usePlan,
      requiredLocalReads,
      commands,
      checks,
      listedTools
    }),
    mcp: {
      mode: 'read-only',
      resourcesListed: listedResources.length,
      resourceUris: listedResources.map((item) => item.uri).sort(),
      toolsExposed: listedTools.length,
      usePlanResourceRead: checks.usePlanResourceRead,
      registryResourceRead: checks.registryResourceRead,
      usePlanResourceFingerprint: usePlanPayload?.resourceFingerprint ?? null,
      registryResourceFingerprint: registryPayload?.resourceFingerprint ?? null
    },
    setup: {
      dryRun: setup.dryRun,
      client: setup.client,
      configRef: setup.config.ref,
      serverStatus: setup.status.server,
      desiredServer: setup.desiredServer,
      manualConfigSnippet: setup.manualConfigSnippet
    },
    commands,
    checks,
    safeguards: {
      readOnly: true,
      canonicalStateMutated: false,
      localFilesWritten: 0,
      homeConfigMutated: false,
      externalWritesEnabled: false,
      externalAdaptersEnabled: 0,
      networkCalls: 0,
      modelCalls: 0,
      activeMemoryCreated: 0,
      sourceSnapshotsWritten: 0,
      rawSourceBodiesIncluded: false,
      markdownBodyIncluded: false,
      sourceContentIncluded: false,
      objectiveTextIncluded: false,
      stepTextIncluded: false,
      launchInstructionsIncluded: false,
      credentialsIncluded: false,
      providerUrlsIncluded: false,
      absoluteFilesystemLocationsIncluded: false,
      hiddenReasoningIncluded: false
    },
    reportFingerprint: 'sha256:0000000000000000000000000000000000000000000000000000000000000000'
  };
  report.reportFingerprint = fingerprintJson({ ...report, reportFingerprint: null });
  assertJsonSchema(contextPackReceiveReportSchema, report, 'context-pack receive report');
  return report;
}

function buildContextReceiverPacket({ state, targetHarness, registryStatus, currentEntry, usePlan, requiredLocalReads, commands, checks, listedTools }) {
  const contextPackFingerprint = currentEntry?.contextPack?.fingerprint ?? usePlan?.contextPack?.fingerprint ?? null;
  const usePlanFingerprint = currentEntry?.usePlan?.fingerprint ?? usePlan?.usePlanFingerprint ?? null;
  const requiredReadCount = Number(usePlan?.requiredLocalReads?.length ?? 0);
  const packetReads = requiredLocalReads.slice(0, 8).map((item) => ({
    locator: item.locator,
    role: item.role,
    contentHash: item.contentHash,
    readHint: item.readHint,
    reasonCodes: item.reasonCodes
  }));
  const reviewNeeded = state !== 'ready';
  const summary = state === 'ready'
    ? `Pinned ${targetHarness} context pack verified. Read the listed local locators before editing; this packet excludes raw source, markdown, prompts, credentials, provider URLs, local paths, and hidden reasoning.`
    : state === 'review'
      ? `Pinned ${targetHarness} context pack needs review before use. Check the registry status and rebuild or re-pin if any source, artifact, target, or fingerprint check is not verified.`
      : `No verified pinned ${targetHarness} context pack is available. Pin a context pack before trying to receive it in an agent harness.`;
  const nextActions = [
    {
      label: 'Check pinned registry',
      command: commands.checkRegistry,
      reasonCode: 'verify_pinned_registry',
      required: true
    },
    ...(state === 'ready' ? [] : [{
      label: 'Create pinned context pack',
      command: commands.createPinnedContextPack,
      reasonCode: 'create_pinned_context_pack',
      required: true
    }]),
    ...(state === 'ready' ? [{
      label: 'Read pinned use plan',
      command: commands.readUsePlan,
      reasonCode: 'read_required_local_locators',
      required: true
    }] : []),
    {
      label: 'Preview harness MCP setup',
      command: commands.previewSetup,
      reasonCode: 'confirm_read_only_bridge_config',
      required: state === 'ready'
    },
    ...(state === 'ready' ? [{
      label: 'Start read-only MCP bridge',
      command: commands.startReadOnlyBridge,
      reasonCode: 'serve_sanitized_resources_only',
      required: false
    }] : [])
  ];
  return {
    packetVersion: 'oaf-context-receiver-packet-1.0.0',
    state,
    targetHarness,
    summary,
    reviewNeeded,
    fingerprints: {
      registry: registryStatus.registry.registryFingerprint,
      currentPointer: registryStatus.currentPointer.pointerFingerprint,
      contextPack: contextPackFingerprint,
      usePlan: usePlanFingerprint
    },
    proof: {
      registryFingerprintVerified: checks.registryFingerprintVerified,
      currentPointerVerified: checks.currentPointerVerified,
      currentEntryVerified: checks.currentEntryVerified,
      targetMatches: checks.currentEntryMatchesTarget,
      usePlanLoaded: checks.usePlanLoaded,
      usePlanResourceRead: checks.usePlanResourceRead,
      registryResourceRead: checks.registryResourceRead,
      toolsExposed: listedTools.length,
      externalWritesEnabled: false,
      externalAdaptersEnabled: 0,
      sourceContentIncluded: false,
      markdownBodyIncluded: false,
      rawSourceBodiesIncluded: false
    },
    readPlan: {
      requiredReadCount,
      includedReadCount: packetReads.length,
      omittedReadCount: Math.max(0, requiredReadCount - packetReads.length),
      coverage: usePlan?.coverage ?? null,
      sourceSelection: usePlan ? {
        candidateUnitCount: usePlan.sourceSelection.candidateUnitCount,
        selectedUnitCount: usePlan.sourceSelection.selectedUnitCount,
        selectedUnitRatio: usePlan.sourceSelection.selectedUnitRatio,
        estimatedReductionRatio: usePlan.sourceSelection.estimatedReductionRatio
      } : null,
      delivery: usePlan ? {
        deliveredUnitCount: usePlan.delivery.deliveredUnitCount,
        observedReductionRatio: usePlan.delivery.observedReductionRatio,
        sourceContentIncluded: usePlan.delivery.sourceContentIncluded
      } : null,
      requiredReads: packetReads
    },
    nextActions,
    warnings: [...new Set(registryStatus.warnings ?? [])].sort()
  };
}

function parseMcpJsonPayload(response) {
  const text = response?.result?.contents?.[0]?.text;
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function buildContextPackMeasurementReport(values, { objective, step }) {
  const root = option(values, '--root') ?? process.cwd();
  const workspaceId = option(values, '--workspace') ?? 'ws_local';
  const targetHarness = option(values, '--target') ?? option(values, '--target-harness') ?? 'generic';
  const from = option(values, '--from') ?? 'all';
  const sourceHarnesses = normalizeHarnesses(from);
  const userSelectedFiles = options(values, '--include-file');
  const tokenBudget = parseIntegerOption(values, '--token-budget', parseIntegerOption(values, '--budget', 4096));
  const generatedAt = fixedNow();
  const { changedLocators, detection } = await resolveChangedLocators(values, { root, workspaceId });
  const started = process.hrtime.bigint();
  const pack = await buildContextPack({
    root,
    harnesses: sourceHarnesses,
    userSelectedFiles,
    changedLocators,
    workspaceId,
    objective,
    step,
    targetHarness,
    tokenBudget,
    clock: () => generatedAt
  });
  const buildDurationMs = Math.max(0, Math.round(Number(process.hrtime.bigint() - started) / 1_000_000));
  const smoke = await buildMcpContextPackSmokeReport(values, { objective, step, fixedTimestamp: generatedAt });
  const usePlan = buildContextPackUsePlan(pack, { generatedAt });
  const impactBrief = buildContextPackImpactBrief(pack, {
    generatedAt,
    changedLocatorSource: detection ? 'git-status-porcelain' : 'explicit',
    usePlanFingerprint: usePlan.usePlanFingerprint
  });
  const summary = pack.sourceGraph.summary ?? {};
  const selection = pack.utility.sourceSelection;
  const delivery = pack.delivery ?? {};
  const report = {
    schemaVersion: '1.0.0',
    command: 'measure context-pack',
    generatedAt,
    workspaceId,
    targetHarness: pack.targetHarness,
    commitSha: resolveCommitSha(root),
    measurementScope: 'single local context-pack build plus stdio readback',
    request: {
      objectiveFingerprint: fingerprintJson(objective),
      objectiveLength: objective.length,
      stepFingerprint: fingerprintJson(step),
      stepLength: step.length,
      sourceHarnesses: pack.sourceHarnesses,
      userSelectedLocatorCount: userSelectedFiles.length,
      changedLocatorCount: changedLocators.length,
      changedFromGit: Boolean(detection),
      unitBudget: tokenBudget
    },
    contextPack: {
      contextPackFingerprint: pack.contextPackFingerprint,
      utilityStatus: pack.utility.status,
      readFirstCount: pack.readFirst.length,
      omittedRefCount: pack.omissions.excludedCount,
      candidateUnitCount: selection.candidateTokenCount,
      selectedUnitCount: selection.selectedTokenCount,
      selectedUnitRatio: selection.selectedTokenRatio,
      estimatedSelectionReductionRatio: selection.estimatedReductionRatio,
      deliveredUnitCount: Number(delivery.deliveredTokenCount ?? 0),
      deliveredUnitRatio: Number(delivery.deliveredTokenRatio ?? 0),
      observedDeliveryReductionRatio: Number(delivery.observedTokenReductionRatio ?? 0),
      changedSourceBudget: pack.utility.changedSourceBudget,
      changedLocatorCoverage: pack.utility.changedLocatorCoverage,
      graphHintCoverage: pack.utility.graphHintCoverage
    },
    sourceGraph: {
      status: pack.sourceGraph.status,
      previewVersion: pack.sourceGraph.previewVersion,
      sourceIndexFingerprint: pack.sourceGraph.sourceIndexFingerprint,
      graphFingerprint: pack.sourceGraph.graphFingerprint,
      fileCount: Number(summary.fileCount ?? 0),
      symbolCount: Number(summary.symbolCount ?? 0),
      nodeCount: Number(summary.nodeCount ?? 0),
      edgeCount: Number(summary.edgeCount ?? 0),
      resultCount: Number(pack.sourceGraph.resultCount ?? 0),
      omittedCount: Number(pack.sourceGraph.omittedCount ?? 0),
      changedLocatorCount: pack.sourceGraph.impact.changedLocators.length,
      representedChangedLocatorCount: pack.sourceGraph.impact.representedChangedLocators.length,
      affectedSymbolCount: pack.sourceGraph.impact.affectedSymbolCount,
      omittedAffectedSymbolCount: pack.sourceGraph.impact.omittedAffectedSymbolCount,
      warningCodes: pack.sourceGraph.warnings
    },
    impactBrief,
    mcpReadback: {
      transport: smoke.transport,
      resourceUri: smoke.resourceUri,
      durationMs: smoke.measurements.durationMs,
      stdoutByteSize: smoke.measurements.stdoutByteSize,
      stderrByteSize: smoke.measurements.stderrByteSize,
      resourceByteSize: smoke.measurements.resourceByteSize,
      toolsExposed: smoke.bridge.toolsExposed,
      resourcesListed: smoke.bridge.resourcesListed,
      resourceFingerprint: smoke.resource.resourceFingerprint,
      contextPackFingerprint: smoke.resource.contextPackFingerprint
    },
    timings: {
      contextPackBuildMs: buildDurationMs,
      mcpReadbackMs: smoke.measurements.durationMs,
      totalObservedMs: buildDurationMs + smoke.measurements.durationMs
    },
    checks: {
      contextPackFingerprintMatchesMcp: smoke.resource.contextPackFingerprint === pack.contextPackFingerprint,
      resourceRead: smoke.checks.resourceRead,
      noToolsExposed: smoke.checks.noToolsExposed,
      noMarkdownBody: smoke.checks.noMarkdownBody,
      noLocalFilesWritten: smoke.safeguards.localFilesWritten === 0,
      readOnly: smoke.safeguards.readOnly
    },
    safeguards: {
      readOnly: true,
      canonicalStateMutated: false,
      localFilesWritten: 0,
      externalWritesEnabled: false,
      externalAdaptersEnabled: 0,
      networkCalls: 0,
      modelCalls: 0,
      activeMemoryCreated: 0,
      sourceSnapshotsWritten: 0,
      privateBodiesIncluded: false,
      objectiveTextIncluded: false,
      stepTextIncluded: false,
      markdownBodyIncluded: false,
      sourceContentIncluded: false,
      absoluteFilesystemLocationsIncluded: false,
      productionBenchmarkClaimed: false
    },
    reportFingerprint: 'sha256:0000000000000000000000000000000000000000000000000000000000000000'
  };
  report.reportFingerprint = fingerprintJson({ ...report, reportFingerprint: null });
  assertJsonSchema(contextPackMeasurementReportSchema, report, 'context-pack measurement report');
  return report;
}

function runCliStdio(
  nodeArgs,
  input,
  {
    env = process.env,
    timeoutMs = MCP_STDIO_CHILD_TIMEOUT_MS,
    maxStdoutBytes = MCP_STDIO_CHILD_MAX_STDOUT_BYTES,
    maxStderrBytes = MCP_STDIO_CHILD_MAX_STDERR_BYTES
  } = {}
) {
  const inputBytes = Buffer.byteLength(input, 'utf8');
  if (inputBytes > MCP_STDIO_MAX_STDIN_BYTES) {
    return Promise.reject(new Error(`mcp stdio child input exceeded ${MCP_STDIO_MAX_STDIN_BYTES} bytes`));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, nodeArgs, {
      cwd: process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!child.killed) child.kill('SIGKILL');
      reject(error);
    };
    const collect = (target, streamName, chunk) => {
      const buffer = Buffer.from(chunk);
      if (streamName === 'stdout') {
        stdoutBytes += buffer.length;
        if (stdoutBytes > maxStdoutBytes) {
          fail(new Error(`mcp stdio child stdout exceeded ${maxStdoutBytes} bytes`));
          return;
        }
      } else {
        stderrBytes += buffer.length;
        if (stderrBytes > maxStderrBytes) {
          fail(new Error(`mcp stdio child stderr exceeded ${maxStderrBytes} bytes`));
          return;
        }
      }
      target.push(buffer);
    };
    timer = setTimeout(() => {
      fail(new Error(`mcp stdio child timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => collect(stdout, 'stdout', chunk));
    child.stderr.on('data', (chunk) => collect(stderr, 'stderr', chunk));
    child.stdin.on('error', (error) => {
      if (!settled) fail(error);
    });
    child.on('error', fail);
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      });
    });
    child.stdin.end(input);
  });
}

async function mcpResourcesStdio({ resources, trustedContext }) {
  const input = await readStdinText();
  if (!input.trim()) {
    console.error('mcp resources --stdio requires JSON-RPC input on stdin');
    process.exitCode = 2;
    return;
  }
  const bridge = createMcpBridge({ trustedContext, resources, tools: [] });
  const messages = parseJsonRpcMessages(input);
  for (const message of messages) {
    const response = await bridge.handle(message);
    console.log(JSON.stringify(response));
  }
}

async function readStdinText() {
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    byteLength += buffer.length;
    if (byteLength > MCP_STDIO_MAX_STDIN_BYTES) {
      throw new Error(`mcp resources --stdio input exceeds ${MCP_STDIO_MAX_STDIN_BYTES} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, byteLength).toString('utf8');
}

function parseJsonRpcMessages(input) {
  const trimmed = input.trim();
  const lines = trimmed.split(/\r?\n/u).filter((line) => line.trim());
  if (lines.length > MCP_STDIO_MAX_MESSAGES) {
    throw new Error(`mcp resources --stdio received too many JSON-RPC messages; max ${MCP_STDIO_MAX_MESSAGES}`);
  }
  return lines.map((line, index) => {
    const lineNumber = index + 1;
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (lineBytes > MCP_STDIO_MAX_LINE_BYTES) {
      throw new Error(`mcp resources --stdio JSON-RPC line ${lineNumber} exceeds ${MCP_STDIO_MAX_LINE_BYTES} bytes`);
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`mcp resources --stdio JSON-RPC line ${lineNumber} is not valid JSON`);
    }
    if (Array.isArray(parsed)) {
      throw new Error('mcp resources --stdio JSON-RPC batches are not supported');
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`mcp resources --stdio JSON-RPC line ${lineNumber} must be an object`);
    }
    return parsed;
  });
}

function parseJsonRpcResponseLines(output, { expectedCount }) {
  if (Buffer.byteLength(output, 'utf8') > MCP_STDIO_CHILD_MAX_STDOUT_BYTES) {
    throw new Error('mcp_stdio_response_over_limit');
  }
  const lines = output.trim().split(/\r?\n/u).filter(Boolean);
  if (lines.length !== expectedCount) {
    throw new Error('mcp_stdio_response_count_mismatch');
  }
  return lines.map((line, index) => {
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('invalid');
      }
      return parsed;
    } catch {
      throw new Error(`mcp_stdio_invalid_response_${index + 1}`);
    }
  });
}

function parseSmokeResourcePayload(text) {
  if (Buffer.byteLength(text, 'utf8') > 64 * 1024) {
    throw new Error('mcp_stdio_resource_response_over_limit');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('mcp_stdio_invalid_resource_response');
  }
}

function boundedEnvInteger(name, fallback, { min, max }) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) return fallback;
  return value;
}

function localMcpTrustedContext(workspaceId) {
  return {
    principal: {
      userId: 'usr_local_cli',
      principalType: 'user',
      authenticationMethod: 'local-cli',
      status: 'active'
    },
    membership: {
      workspaceId,
      role: 'builder',
      status: 'active'
    },
    environment: {
      deploymentProfile: 'local-dev',
      locality: 'local-only',
      externalWritesEnabled: false
    }
  };
}

function validateJsonFormat(values) {
  const format = option(values, '--format') ?? 'json';
  if (format !== 'json') {
    console.error('memory commands only support --format json');
    process.exitCode = 2;
    return false;
  }
  return true;
}

function localReportMode(values) {
  const dryRun = values.includes('--dry-run');
  const write = values.includes('--write');
  if (dryRun === write) {
    console.error('memory report commands require exactly one of --dry-run or --write');
    process.exitCode = 2;
    return null;
  }
  return write ? 'write' : 'dry-run';
}

async function loadMemoryRecords(values) {
  const recordsPath = option(values, '--records');
  if (!recordsPath) {
    console.error('memory command requires --records <json> unless --from memoryPaths or --sqlite is used');
    process.exitCode = 2;
    return null;
  }
  const parsed = JSON.parse(await readFile(recordsPath, 'utf8'));
  const records = Array.isArray(parsed) ? parsed : parsed.records;
  if (!Array.isArray(records)) {
    console.error('memory records JSON must be an array or an object with records');
    process.exitCode = 2;
    return null;
  }
  return records;
}

async function loadWorkspaceJson(root, relativePath, fallback) {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('..')) throw new Error(`workspace JSON path is unsupported: ${relativePath}`);
  const realRoot = await realpath(root);
  const absolute = path.resolve(realRoot, relativePath);
  if (!isInside(realRoot, absolute)) throw new Error(`workspace JSON path escapes root: ${relativePath}`);
  let actual;
  try {
    actual = await realpath(absolute);
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
  if (!isInside(realRoot, actual)) throw new Error(`workspace JSON path escapes root: ${relativePath}`);
  return JSON.parse(await readFile(actual, 'utf8'));
}

async function loadMemorySearchRecords(values, { workspaceId, query, limit }) {
  if (option(values, '--records')) return loadMemoryRecords(values);
  const sqlitePath = option(values, '--sqlite');
  if (!sqlitePath) {
    console.error('memory sgrep requires --records <json> or --sqlite <path>');
    process.exitCode = 2;
    return null;
  }
  try {
    await stat(sqlitePath);
  } catch {
    console.error('memory SQLite database does not exist; no database is created in dry-run search');
    process.exitCode = 2;
    return null;
  }
  const { SQLiteMemoryProvider } = await import('../../providers/native/memory-sqlite/src/index.mjs');
  const provider = new SQLiteMemoryProvider({ filename: sqlitePath, clock: fixedNow, migrate: false, readOnly: true });
  try {
    return await provider.queryCandidates({ workspaceId, query, limit, statuses: ['active', 'verified'] });
  } finally {
    provider.close();
  }
}

async function loadMemoryPathProposalRecords(values, { workspaceId, root }) {
  const configPath = option(values, '--config');
  if (!configPath) {
    console.error('memory proposals --from memoryPaths requires --config <json>');
    process.exitCode = 2;
    return null;
  }
  const config = normalizeMemoryPathsConfig(JSON.parse(await readFile(configPath, 'utf8')));
  const records = [];
  for (const entry of config.memoryPaths) {
    const source = await readWorkspaceMemoryPath(root, entry.path);
    const { text, locator } = source;
    records.push(evaluateMemoryWrite({
      id: deterministicMemoryId(locator, text),
      workspaceId,
      kind: entry.kind,
      text,
      source: locator,
      sourceTrust: entry.sourceTrust,
      dataClass: entry.dataClass,
      metadata: {
        sourceLocator: locator,
        sourceHash: `sha256:${createHash('sha256').update(text).digest('hex')}`,
        sourceRole: entry.sourceRole,
        sourceLineCount: source.lineCount,
        sourceByteSize: source.byteSize,
        sourceUpdatedAt: source.updatedAt,
        proposalSource: 'memoryPaths'
      },
      now: fixedNow()
    }));
  }
  return records;
}

async function readWorkspaceMemoryPath(root, relativePath) {
  const realRoot = await realpath(root);
  const absolute = path.resolve(realRoot, relativePath);
  const actual = await realpath(absolute);
  if (!isInside(realRoot, actual)) throw new Error(`memoryPath escapes workspace root: ${relativePath}`);
  const info = await stat(actual);
  if (!info.isFile()) throw new Error(`memoryPath is not a file: ${relativePath}`);
  if (info.size > 64 * 1024) throw new Error(`memoryPath exceeds 64 KiB: ${relativePath}`);
  const text = await readFile(actual, 'utf8');
  return {
    text,
    locator: `workspace://${relativePath}`,
    lineCount: text ? text.split(/\r\n|\r|\n/u).length : 0,
    byteSize: info.size,
    updatedAt: info.mtime.toISOString()
  };
}

async function writeWorkspaceFile(root, locator, content) {
  if (!locator.startsWith('workspace://')) throw new Error('only workspace locators can be written');
  const relativePath = locator.slice('workspace://'.length);
  if (!relativePath || relativePath.includes('..') || relativePath.startsWith('/')) throw new Error('workspace write target is unsupported');
  if (!isGeneratedMemoryReportTarget(relativePath)) throw new Error('workspace writes are limited to generated reports under memory/ or context-packs/');
  const realRoot = await realpath(root);
  const absolute = path.resolve(realRoot, relativePath);
  if (!isInside(realRoot, absolute)) throw new Error(`workspace write target escapes root: ${relativePath}`);
  await assertNoSymlinkAncestors(realRoot, relativePath);
  const parent = path.dirname(absolute);
  await mkdir(parent, { recursive: true });
  const realParent = await realpath(parent);
  if (!isInside(realRoot, realParent)) throw new Error(`workspace write parent escapes root: ${relativePath}`);
  const existing = await lstat(absolute).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing?.isSymbolicLink()) throw new Error(`workspace write target is a symlink: ${relativePath}`);
  if (existing && !existing.isFile()) throw new Error(`workspace write target is not a file: ${relativePath}`);
  await writeFile(absolute, content, 'utf8');
}

function isGeneratedMemoryReportTarget(relativePath) {
  return relativePath === 'memory/profile.md' ||
    /^memory\/proposals\/mem_[A-Za-z0-9._-]+\.md$/.test(relativePath) ||
    /^context-packs\/[A-Za-z0-9._-]+\.md$/.test(relativePath) ||
    /^context-packs\/[A-Za-z0-9._-]+\.use\.json$/.test(relativePath) ||
    relativePath === 'context-packs/registry.json' ||
    relativePath === 'context-packs/current.json';
}

async function assertNoSymlinkAncestors(root, relativePath) {
  const parts = relativePath.split('/').slice(0, -1);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const entry = await lstat(current).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!entry) return;
    if (entry.isSymbolicLink()) throw new Error(`workspace write parent is a symlink: ${relativePath}`);
    if (!entry.isDirectory()) throw new Error(`workspace write parent is not a directory: ${relativePath}`);
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function deterministicMemoryId(locator, text) {
  return `mem_${createHash('sha256').update(`${locator}\0${text}`).digest('hex').slice(0, 16)}`;
}

function fixedNow() {
  return process.env.OAF_FIXED_NOW ?? new Date().toISOString();
}

function fingerprintJson(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function normalizeHarnesses(value) {
  const aliases = new Map([['claude', 'claude-code']]);
  return value.split(',').map((item) => aliases.get(item.trim()) ?? item.trim()).filter(Boolean);
}

function shellQuote(value) {
  return `'${String(value ?? '').replaceAll("'", `'"'"'`)}'`;
}

function contextHandoffSetupClient(targetHarness) {
  return targetHarness === 'cursor' || targetHarness === 'claude-code' || targetHarness === 'codex' ? targetHarness : 'codex';
}

function contextHandoffBaseCommand({ from, objective, step, targetHarness, userSelectedFiles, changedLocators }) {
  const includeArgs = userSelectedFiles.map((value) => ` --include-file ${shellQuote(value)}`).join('');
  const changedArgs = changedLocators.map((value) => ` --changed ${shellQuote(String(value).replace(/^workspace:\/\//u, ''))}`).join('');
  return `--from ${shellQuote(from)} --root . --objective ${shellQuote(objective)} --step ${shellQuote(step)} --target ${targetHarness}${includeArgs}${changedArgs}`;
}

function option(values, name) {
  const index = values.indexOf(name);
  return index >= 0 ? values[index + 1] : null;
}

function unsupportedFlags(values, allowed, valueOptions = new Set()) {
  const output = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value.startsWith('--') && !allowed.has(value)) output.push(value);
    if (valueOptions.has(value) && index + 1 < values.length) index += 1;
  }
  return output;
}

function options(values, name) {
  const output = [];
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === name && values[index + 1]) output.push(values[index + 1]);
  }
  return output;
}

function gitChangedLocatorsRequested(values) {
  return values.includes('--changed-from-git') || option(values, '--changed-from') === 'git';
}

async function resolveChangedLocators(values, { root, workspaceId }) {
  const explicit = [...options(values, '--changed'), ...options(values, '--changed-locator')];
  if (!gitChangedLocatorsRequested(values)) return { changedLocators: explicit, detection: null };
  const detection = await detectGitChangedLocators({ root, workspaceId, clock: fixedNow });
  if (detection.status !== 'available') {
    console.error(`local git changed-file detection unavailable: ${detection.reason}`);
    return { changedLocators: explicit, detection };
  }
  if (detection.truncated) {
    console.error(`local git changed-file detection capped at ${detection.changedLocators.length} locators; review explicit --changed entries for omitted files`);
  }
  const changedLocators = [...new Set([...explicit, ...detection.changedLocators])].sort();
  if (changedLocators.length > 16) throw new Error('changed_context_too_many_locators');
  return { changedLocators, detection };
}

function firstPositional(values) {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) return value;
    if (option(values, value) !== null) index += 1;
  }
  return null;
}

function parseIntegerOption(values, name, fallback) {
  const value = option(values, name);
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function strictIntegerOption(values, name, fallback) {
  const value = option(values, name);
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function resolveCommitSha(root = process.cwd()) {
  if (/^[a-f0-9]{40}$/.test(process.env.OAF_COMMIT_SHA ?? '')) return process.env.OAF_COMMIT_SHA;
  try {
    const value = execFileSync('git', ['-C', path.resolve(root), 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (/^[a-f0-9]{40}$/.test(value)) return value;
  } catch {
    // Git metadata is unavailable in generated source archives.
  }
  return '0000000000000000000000000000000000000000';
}

function runNode(nodeArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, nodeArgs, { stdio: 'inherit', env: process.env });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

function help() {
  console.log(`Open Agent Fabric CLI

Usage:
  oaf doctor
  oaf status
  oaf task <OAF-ID>
  oaf demo [objective]
  oaf serve
  oaf check
  oaf eval
  oaf manifest
  oaf context --request request.json --records records.json
  oaf context scan --from codex --root . --dry-run
  oaf context preview --from codex --root . --objective "Ship safely" --step "select context" --include-file notes/handoff.md --dry-run
  oaf context pack --from codex --root . --objective "Ship safely" --step "handoff" --target codex --include-file notes/handoff.md --changed src/auth.ts --changed-from-git --dry-run --format markdown
  oaf context pack --from codex --root . --objective "Ship safely" --step "handoff" --target codex --write --out context-packs/CONTEXT_PACK.md --use-out context-packs/CONTEXT_PACK.use.json --format json
  oaf context pack --from codex --root . --objective "Ship safely" --step "handoff" --target codex --write --pin --out context-packs/CONTEXT_PACK.md --format json
  oaf context handoff --read-only --from codex --root . --objective "Ship safely" --step "handoff" --target codex --changed src/auth.ts --format json
  oaf context receive --read-only --root . --target codex --format json
  oaf context registry status --read-only --format json
  oaf context graph preview --root . --query "approve token reset" --trace runAuthWorkflow --changed src/auth.ts --changed-from-git --dry-run --format json
  oaf measure context-pack --read-only --root . --from codex --objective "Ship safely" --step "impact brief" --target codex --changed src/auth.ts --format json
  oaf benchmark truth-floor --suite benchmark-truth-floor --dataset evals/benchmark-truth-floor/cases.v1.json --format json
  oaf memory profile --records memory-export.json --root . --dry-run --format json
  oaf memory proposals --records memory-export.json --root . --dry-run --format json
  oaf memory proposals --from memoryPaths --config oaf.memory.json --root . --dry-run --format json
  oaf memory sgrep "context manifest" --records memory-export.json --workspace ws_local --dry-run --format json
  oaf mcp resources --read-only --workspace ws_local --format json
  oaf mcp resources --read-only --context-pack --objective "Ship safely" --step "handoff" --target codex --changed src/auth.ts --changed-from-git --uri oaf://workspace/ws_local/context-pack/current --format json
  oaf mcp resources --read-only --context-pack-use context-packs/CONTEXT_PACK.use.json --uri oaf://workspace/ws_local/context-pack/use-plan/current --format json
  oaf mcp resources --read-only --context-pack-registry --uri oaf://workspace/ws_local/context-pack/registry/current --format json
  oaf mcp smoke context-pack --read-only --objective "Ship safely" --step "handoff" --target codex --changed src/auth.ts --changed-from-git --format json
  oaf mcp resources --read-only --stdio
  oaf harness setup status --client codex --dry-run --format json
  oaf harness setup plan --client cursor --server oaf --dry-run --format json
  oaf harness setup uninstall --client cursor --server oaf --dry-run --format json
  oaf version

Run oaf task only when npm run status names a next task.
The default bootstrap is local-only and enables no external writes.`);
}
