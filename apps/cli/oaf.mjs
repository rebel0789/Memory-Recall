#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { buildCompressedProfileContextReport, compileContext } from '../../packages/context-compiler/src/index.mjs';
import { createBenchmarkDataset, runBenchmarkTruthFloor } from '../../packages/evaluation-lab/src/index.mjs';
import {
  buildContextPack,
  buildContextPackImpactBrief,
  buildContextPackReceiveReport,
  buildContextPackUsePlan,
  buildHarnessContextPreview,
  buildHarnessSetupReport,
  buildLoopPlan,
  buildMemoryProposalPreflightFromFile,
  detectGitChangedLocators,
  loadCurrentContextPackUsePlan,
  pinContextPackArtifacts,
  recordLoopObservation,
  renderContextPackMarkdown,
  runLoop,
  runLoopVerification,
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
import mcpContextPackSmokeSchema from '../../packages/protocol/schemas/mcp-context-pack-smoke.schema.json' with { type: 'json' };
import { assertJsonSchema } from '../../packages/protocol/src/schema-validator.mjs';
import { sha256Hex, stableStringify } from '../../packages/protocol/src/fingerprint.mjs';
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
const MCP_PRIVATE_MATERIAL = /(?:\/Users(?:\/|$)[^\s"',;]*|\/home\/[A-Za-z0-9._-]+(?:\/|$)[^\s"',;]*|[A-Za-z]:\\[^\s"',;]*|sk-[A-Za-z0-9_-]{12,}|OPENAI_API_KEY|AKIA[0-9A-Z]{16}|gh[opsu]_[A-Za-z0-9_]{12,}|(?:token|secret|password|api[_-]?key)\s*[=:]\s*[^\s"',;]+)/iu;
const MCP_PRIVATE_MATERIAL_GLOBAL = /(?:\/Users(?:\/|$)[^\s"',;]*|\/home\/[A-Za-z0-9._-]+(?:\/|$)[^\s"',;]*|[A-Za-z]:\\[^\s"',;]*|sk-[A-Za-z0-9_-]{12,}|OPENAI_API_KEY|AKIA[0-9A-Z]{16}|gh[opsu]_[A-Za-z0-9_]{12,}|(?:token|secret|password|api[_-]?key)\s*[=:]\s*[^\s"',;]+)/giu;
const MCP_INSTALL_CLIENTS = new Map([
  ['codex', { id: 'codex', format: 'toml', configPath: '.codex/config.toml' }],
  ['cursor', { id: 'cursor', format: 'json', configPath: '.cursor/mcp.json' }],
  ['claude-code', { id: 'claude-code', format: 'json', configPath: '.claude/mcp.json' }]
]);

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

if (command === 'demo' && args[0] === 'memory-loop') {
  await demoMemoryLoopCommand(args.slice(1));
} else if (commands.has(command)) {
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
} else if (command === 'loop') {
  await loopCommand(args);
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

async function demoMemoryLoopCommand(values) {
  const valueOptions = new Set(['--root', '--workspace-id', '--workspace', '--format']);
  const allowed = new Set(['--contradicting-fact', ...valueOptions]);
  const unsupported = unsupportedFlags(values, allowed, valueOptions);
  if (unsupported.length > 0) {
    console.error(`demo memory-loop unsupported option: ${unsupported[0]}`);
    process.exitCode = 2;
    return;
  }
  const format = option(values, '--format') ?? 'json';
  if (!['json', 'summary'].includes(format)) {
    console.error('demo memory-loop only supports --format json or --format summary');
    process.exitCode = 2;
    return;
  }
  const root = path.resolve(option(values, '--root') ?? process.cwd());
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) throw new Error('demo memory-loop --root must point at a local workspace directory');
  const workspaceId = option(values, '--workspace-id') ?? option(values, '--workspace') ?? 'ws_local';
  const generatedAt = fixedNow();
  const { SQLiteMemoryProvider } = await import('../../providers/native/memory-sqlite/src/index.mjs');
  const provider = new SQLiteMemoryProvider({ filename: ':memory:', clock: () => generatedAt });
  try {
    const report = await runMemoryLoopDemo({ provider, workspaceId, root, generatedAt, includeContradiction: values.includes('--contradicting-fact') });
    console.log(format === 'summary' ? renderMemoryLoopSummary(report) : JSON.stringify(report, null, 2));
  } finally {
    provider.close();
  }
}

async function runMemoryLoopDemo({ provider, workspaceId, root, generatedAt, includeContradiction = false }) {
  const objective = 'Use native memory to complete a local feedback loop';
  await provider.put({
    id: 'mem_demo_profile',
    workspaceId,
    kind: 'decision',
    text: `${Array(90).fill('native-memory-profile').join(' ')} keeps the local feedback loop token measured and proposal gated.`,
    source: 'workspace://docs/product/loop-workbench-build-plan.md',
    status: 'active',
    confidence: 0.9,
    authority: 0.9,
    updatedAt: generatedAt
  });
  if (includeContradiction) await seedContradictingMemoryLoopFact({ provider, workspaceId, generatedAt });
  const queued = await provider.proposeTemporalFactsFromEpisode({
    workspaceId,
    scope: 'workspace',
    sourceLocator: 'workspace://docs/product/loop-workbench-build-plan.md',
    observedAt: generatedAt,
    text: 'project:oaf memory_loop connected.'
  });
  const claimed = await provider.claimProposal({
    workspaceId,
    workerId: 'memory-loop-demo',
    leaseUntil: new Date(Date.parse(generatedAt) + 60_000).toISOString()
  });
  const proposal = claimed[0] ?? queued[0];
  await provider.recordProposalResult({
    workspaceId,
    id: proposal.id,
    workerId: 'memory-loop-demo',
    status: 'applied',
    result: { accepted: true, objective }
  });
  const payload = proposal.payload;
  const fact = await provider.addTemporalFact({
    id: 'memfact_demo_memory_loop',
    workspaceId,
    scope: payload.scope ?? 'workspace',
    subject: payload.subject,
    predicate: payload.predicate,
    object: payload.object,
    text: payload.text,
    source: payload.provenanceSourceLocator ?? proposal.sourceLocator,
    proposalQueueId: proposal.id,
    validFrom: payload.observedAt ?? generatedAt,
    episode: {
      id: payload.provenanceEpisodeId ?? 'mep_demo_memory_loop',
      sourceLocator: payload.provenanceSourceLocator ?? proposal.sourceLocator,
      summary: 'Observed the local memory-loop demo proposal and applied it as a temporal fact.',
      observedAt: payload.observedAt ?? generatedAt
    }
  });
  const exported = await provider.export({ workspaceId });
  const facts = await provider.listTemporalFacts({ workspaceId, limit: 100 });
  const profileRecords = [...exported.records, ...facts.map(memoryLoopFactProfileRecord)];
  const profile = buildCompressedProfileContextReport({
    records: profileRecords,
    workspaceId,
    generatedAt,
    objective,
    step: 'Compress memory before planning the loop',
    tokenBudget: 4096
  });
  const loopPlan = buildLoopPlan({
    workspaceId,
    objective,
    stopCondition: 'The observed proposal is applied as a temporal memory fact',
    validationCommands: ['node --test tests/native-memory-profile-context.test.mjs'],
    changedLocators: ['workspace://providers/native/memory-sqlite/src/index.mjs'],
    userSelectedFiles: ['docs/product/loop-workbench-build-plan.md'],
    contextBudget: loopBudgetFromProfile(profile.contextBudget),
    clock: () => generatedAt
  });
  const ledgerEvents = [];
  const observation = await recordLoopObservation({
    loopPlan,
    runId: 'run_memory_loop_demo',
    executeCommands: true,
    confirmedCommands: loopPlan.validationCommands,
    cwd: root,
    appendEvent: async (event) => ledgerEvents.push(event),
    clock: () => generatedAt
  });
  const appliedProposal = (await provider.listProposalQueue({ workspaceId, limit: 10 })).find((item) => item.id === proposal.id);
  const currentFacts = await provider.listTemporalFacts({ workspaceId, limit: 100 });
  const superseded = currentFacts
    .filter((item) => item.supersededBy === fact.id)
    .map((item) => ({ id: item.id, text: item.text, validUntil: item.validUntil, supersededBy: item.supersededBy }));
  const report = {
    schemaVersion: '1.0.0',
    command: 'demo memory-loop',
    workspaceId,
    generatedAt,
    objective,
    compressedProfile: {
      id: profile.id,
      contextBudget: profile.contextBudget,
      acceptedHistoryRecordCount: profile.profile.acceptedHistoryRecordCount,
      skippedHistoryRecordCount: profile.profile.skippedHistoryRecordCount
    },
    savings: buildProfileSavingsSummary({
      profile,
      command: 'demo memory-loop savings',
      workspaceId,
      generatedAt,
      objective,
      step: 'Compress memory before planning the loop',
      source: {
        provider: 'provider:native:memory:sqlite',
        sqliteRef: 'memory://demo-in-memory',
        recordCount: profileRecords.length,
        activeTemporalFactCount: facts.filter((item) => item.status === 'active').length
      }
    }),
    loopPlan: {
      id: loopPlan.id,
      contextBudget: loopPlan.contextBudget,
      validationCommands: loopPlan.validationCommands,
      stopCondition: loopPlan.stopCondition
    },
    observation: {
      id: observation.id,
      status: observation.status,
      commands: observation.commands,
      events: observation.events
    },
    extractionProposal: {
      id: proposal.id,
      status: appliedProposal?.status ?? 'applied',
      sourceLocator: proposal.sourceLocator,
      text: payload.text
    },
    memoryFact: {
      id: fact.id,
      text: fact.text,
      status: fact.status,
      validity: { validFrom: fact.validFrom, validUntil: fact.validUntil },
      supersededBy: fact.supersededBy,
      proposalQueueId: fact.proposalQueueId,
      episodeId: fact.episodeId
    },
    remembered: [fact.text],
    superseded,
    ledgerEvents: ledgerEvents.map((event) => ({ id: event.id, type: event.type, sequence: event.sequence })),
    safeguards: {
      localOnly: true,
      persisted: false,
      networkCalls: 0,
      modelCalls: 0,
      externalWritesEnabled: false,
      activeMemoryCreated: 1,
      rawOutputIncluded: false
    }
  };
  return { ...report, reportFingerprint: fingerprintJson({ ...report, reportFingerprint: null }) };
}

async function seedContradictingMemoryLoopFact({ provider, workspaceId, generatedAt }) {
  const previousAt = new Date(Date.parse(generatedAt) - 86_400_000).toISOString();
  const proposal = await provider.enqueueProposal({
    id: 'mpq_demo_previous_memory_loop',
    workspaceId,
    sourceLocator: 'workspace://docs/product/loop-workbench-build-plan.md',
    sourceHash: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    payload: { kind: 'fact', scope: 'workspace', subject: 'project:oaf', predicate: 'memory_loop', object: 'disconnected', text: 'project:oaf memory_loop disconnected', observedAt: previousAt }
  });
  await provider.claimProposal({
    workspaceId,
    workerId: 'memory-loop-demo',
    leaseUntil: new Date(Date.parse(generatedAt) + 60_000).toISOString()
  });
  await provider.recordProposalResult({
    workspaceId,
    id: proposal.id,
    workerId: 'memory-loop-demo',
    status: 'applied',
    result: { accepted: true, seed: 'contradicting_fact' }
  });
  await provider.addTemporalFact({
    id: 'memfact_demo_memory_loop_previous',
    workspaceId,
    scope: 'workspace',
    subject: 'project:oaf',
    predicate: 'memory_loop',
    object: 'disconnected',
    text: 'project:oaf memory_loop disconnected',
    source: 'workspace://docs/product/loop-workbench-build-plan.md',
    proposalQueueId: proposal.id,
    validFrom: previousAt,
    episode: {
      id: 'mep_demo_memory_loop_previous',
      sourceLocator: 'workspace://docs/product/loop-workbench-build-plan.md',
      summary: 'Seeded an earlier contradictory local memory-loop fact for supersession proof.',
      observedAt: previousAt
    }
  });
}

function memoryLoopFactProfileRecord(fact) {
  return {
    id: fact.id,
    workspaceId: fact.workspaceId,
    kind: 'fact',
    text: fact.text,
    scope: 'workspace-private',
    dataClass: 'workspace-private',
    status: fact.status,
    source: fact.source,
    confidence: fact.confidence,
    authority: fact.confidence,
    tags: [fact.subject, fact.predicate, fact.object].filter(Boolean),
    relations: [fact.subject, fact.object].filter(Boolean),
    updatedAt: fact.updatedAt,
    observedAt: fact.validFrom
  };
}

function loopBudgetFromProfile(contextBudget) {
  return {
    basis: 'context-pack-measurement',
    estimatedDeliveryTokens: Number(contextBudget?.estimatedDeliveryTokens ?? 0),
    sourceBodyTokensExcluded: Number(contextBudget?.historyTokensAvoided ?? 0),
    deliveryReductionRatio: Number(contextBudget?.reductionRatio ?? 0)
  };
}

function buildProfileSavingsSummary({ profile, command, workspaceId, generatedAt, objective, step, source }) {
  const beforeDeliveryTokens = Math.max(0, Math.trunc(Number(profile.contextBudget.historyTokensAvailable ?? 0)));
  const afterDeliveryTokens = Math.max(0, Math.trunc(Number(profile.contextBudget.estimatedDeliveryTokens ?? 0)));
  const tokensSaved = Math.max(0, beforeDeliveryTokens - afterDeliveryTokens);
  const reductionRatio = beforeDeliveryTokens > 0 ? Number((tokensSaved / beforeDeliveryTokens).toFixed(6)) : 0;
  const summary = {
    schemaVersion: '1.0.0',
    command,
    generatedAt,
    workspaceId,
    measurementScope: 'single local compressed-profile delivery-token estimate',
    objectiveFingerprint: stableJsonFingerprint(String(objective ?? '')),
    stepFingerprint: stableJsonFingerprint(String(step ?? '')),
    source,
    baseline: {
      label: 'naive full-context delivery estimate',
      deliveryTokens: beforeDeliveryTokens,
      basis: 'accepted history records before compressed profile selection'
    },
    compressed: {
      label: 'OAF compressed profile delivery estimate',
      deliveryTokens: afterDeliveryTokens,
      profileTokens: Math.max(0, Math.trunc(Number(profile.contextBudget.profileTokens ?? 0))),
      retrievedContextTokens: Math.max(0, Math.trunc(Number(profile.contextBudget.retrievedContextTokens ?? 0))),
      selectedContextId: profile.manifest.id,
      selectedCount: profile.manifest.selected.length,
      excludedCount: profile.manifest.excluded.length
    },
    savings: {
      tokensSaved,
      reductionRatio,
      percent: Math.round(reductionRatio * 100),
      basis: 'delivery-token-estimate',
      providerBillingClaimed: false
    },
    profile: {
      id: profile.id,
      acceptedHistoryRecordCount: profile.profile.acceptedHistoryRecordCount,
      skippedHistoryRecordCount: profile.profile.skippedHistoryRecordCount,
      bounded: profile.profile.bounded,
      limits: profile.profile.limits,
      contentHash: profile.profile.contentHash
    },
    safeguards: {
      readOnly: true,
      localOnly: true,
      providerBillingClaimed: false,
      networkCalls: 0,
      modelCalls: 0,
      localFilesWritten: 0,
      canonicalStateMutated: false,
      activeMemoryCreated: 0,
      externalWritesEnabled: false,
      externalAdaptersEnabled: 0,
      rawSourceBodiesIncluded: false,
      rawObjectiveIncluded: false,
      rawStepIncluded: false
    }
  };
  return {
    ...summary,
    beforeDeliveryTokens,
    afterDeliveryTokens,
    tokensSaved,
    reductionRatio,
    percent: summary.savings.percent,
    reportFingerprint: stableJsonFingerprint(summary)
  };
}

function stableJsonFingerprint(value) {
  return `sha256:${sha256Hex(stableStringify(value))}`;
}

function renderMemoryLoopSummary(report) {
  const tokenSaving = `${Math.round(Number(report.savings?.percent ?? Number(report.compressedProfile.contextBudget.reductionRatio ?? 0) * 100))}%`;
  return [
    `Memory loop token saving: ${tokenSaving}`,
    `Before/after delivery tokens: ${Number(report.savings?.beforeDeliveryTokens ?? report.compressedProfile.contextBudget.historyTokensAvailable ?? 0)} -> ${Number(report.savings?.afterDeliveryTokens ?? report.compressedProfile.contextBudget.estimatedDeliveryTokens ?? 0)}`,
    `Remembered: ${report.remembered.join('; ') || 'none'}`,
    `Superseded: ${report.superseded.map((item) => `${item.id} -> ${item.supersededBy}`).join('; ') || 'none'}`,
    `Observation: ${report.observation.status}`,
    `Fact: ${report.memoryFact.id}`
  ].join('\n');
}

async function memoryCommand(values) {
  const [subcommand, ...rest] = values;
  try {
    if (subcommand === 'ingest') return await memoryIngestCommand(rest);
    if (subcommand === 'profile') return await memoryProfileCommand(rest);
    if (subcommand === 'proposals') return await memoryProposalsCommand(rest);
    if (subcommand === 'sgrep') return await memorySgrepCommand(rest);
    if (subcommand === 'fact') return await memoryFactCommand(rest);
    if (subcommand === 'search') return await memorySearchCommand(rest);
    if (subcommand === 'path') return await memoryPathCommand(rest);
    if (subcommand === 'explain') return await memoryExplainCommand(rest);
    console.error('memory requires ingest, profile, proposals, sgrep, fact, search, path, or explain');
    process.exitCode = 2;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

async function memoryIngestCommand(values) {
  if (!validateJsonFormat(values)) return;
  if (values.includes('--read-only') || values.includes('--dry-run')) {
    console.error('memory ingest writes proposal queue records only; --read-only and --dry-run are not accepted');
    process.exitCode = 2;
    return;
  }
  const valueOptions = new Set(['--root', '--sqlite', '--workspace', '--workspace-id', '--scope', '--limit', '--format']);
  const unsupported = unsupportedFlags(values, new Set(valueOptions), valueOptions);
  if (unsupported.length > 0) {
    console.error(`memory ingest unsupported option: ${unsupported[0]}`);
    process.exitCode = 2;
    return;
  }
  const root = path.resolve(option(values, '--root') ?? process.cwd());
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) throw new Error('memory ingest --root must point at a local workspace directory');
  const workspaceId = option(values, '--workspace-id') ?? option(values, '--workspace') ?? 'ws_local';
  const generatedAt = fixedNow();
  const sqlitePath = await resolveWorkspaceSqlitePath(root, option(values, '--sqlite') ?? '.local/memory.sqlite', 'memory ingest', { mustExist: false });
  const { SQLiteMemoryProvider } = await import('../../providers/native/memory-sqlite/src/index.mjs');
  const provider = new SQLiteMemoryProvider({ filename: sqlitePath.absolute, clock: () => generatedAt });
  try {
    const episodes = await buildWorkspaceMemoryIngestEpisodes({
      root,
      workspaceId,
      scope: option(values, '--scope') ?? 'workspace',
      generatedAt,
      limit: parseIntegerOption(values, '--limit', 80)
    });
    const queued = [];
    for (const episode of episodes) queued.push(...await provider.proposeTemporalFactsFromEpisode(episode));
    const unique = new Map(queued.map((item) => [item.id, item]));
    const proposalFacts = [...unique.values()].map(summarizeProposalQueueFact).filter(Boolean);
    const report = {
      schemaVersion: '1.0.0',
      command: 'memory ingest',
      generatedAt,
      workspaceId,
      source: {
        provider: 'provider:native:memory:sqlite',
        sqliteRef: `workspace://${sqlitePath.relative}`,
        rootRef: 'workspace://.'
      },
      summary: {
        episodeCount: episodes.length,
        proposalCount: proposalFacts.length,
        activeMemoryCreated: 0,
        sources: {
          gitHistory: episodes.filter((item) => item.metadata?.sourceKind === 'git-history').length,
          docs: episodes.filter((item) => item.metadata?.sourceKind === 'workspace-doc').length,
          sourceGraph: episodes.filter((item) => item.metadata?.sourceKind === 'source-graph').length
        }
      },
      proposalFacts,
      safeguards: {
        proposalGated: true,
        activeMemoryCreated: 0,
        hardDeleted: false,
        deterministicOffline: true,
        networkCalls: 0,
        modelCalls: 0,
        externalWritesEnabled: false,
        rawSourceBodiesIncluded: false,
        absoluteFilesystemLocationsIncluded: false
      },
      reportFingerprint: null
    };
    console.log(JSON.stringify({ ...report, reportFingerprint: stableJsonFingerprint(report) }, null, 2));
  } finally {
    provider.close();
  }
}

async function measureCommand(values) {
  const [subcommand, ...rest] = values;
  try {
    if (subcommand === 'savings') return await measureSavingsCommand(rest);
    if (subcommand === 'context-pack') return await measureContextPackCommand(rest);
    console.error('measure requires savings or context-pack');
    process.exitCode = 2;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

async function loopCommand(values) {
  const [subcommand, ...rest] = values;
  try {
    if (subcommand === 'plan') return await loopPlanCommand(rest);
    if (subcommand === 'observe') return await loopObserveCommand(rest);
    if (subcommand === 'verify') return await loopVerifyCommand(rest);
    if (subcommand === 'run') return await loopRunCommand(rest);
    if (subcommand === 'schedule') return await loopScheduleCommand(rest);
    console.error('loop requires plan, observe, verify, run, or schedule');
    process.exitCode = 2;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

async function loopPlanCommand(values) {
  if (!values.includes('--read-only')) {
    console.error('loop plan requires --read-only');
    process.exitCode = 2;
    return;
  }
  if (values.includes('--write') || values.includes('--out') || values.includes('--pin')) {
    console.error('loop plan is read-only and does not write or pin artifacts');
    process.exitCode = 2;
    return;
  }
  const valueOptions = new Set([
    '--root',
    '--workspace-id',
    '--workspace',
    '--objective',
    '--stop-condition',
    '--non-goal',
    '--validation',
    '--changed-locator',
    '--changed',
    '--include-file',
    '--format'
  ]);
  const unsupported = unsupportedFlags(values, new Set(['--read-only', ...valueOptions]), valueOptions);
  if (unsupported.length > 0) {
    console.error(`loop plan unsupported option: ${unsupported[0]}`);
    process.exitCode = 2;
    return;
  }
  const format = option(values, '--format') ?? 'json';
  if (format !== 'json') {
    console.error('loop plan only supports --format json');
    process.exitCode = 2;
    return;
  }
  const objective = option(values, '--objective');
  const stopCondition = option(values, '--stop-condition');
  if (!objective || !stopCondition) {
    console.error('loop plan requires --objective <text> and --stop-condition <text>');
    process.exitCode = 2;
    return;
  }
  const plan = buildLoopPlan({
    workspaceId: option(values, '--workspace-id') ?? option(values, '--workspace') ?? 'ws_local',
    objective,
    stopCondition,
    nonGoals: options(values, '--non-goal'),
    validationCommands: options(values, '--validation'),
    changedLocators: [...options(values, '--changed'), ...options(values, '--changed-locator')],
    userSelectedFiles: options(values, '--include-file'),
    clock: fixedNow
  });
  console.log(JSON.stringify(plan, null, 2));
}

async function loopObserveCommand(values) {
  if (values.includes('--write') || values.includes('--out') || values.includes('--pin')) {
    console.error('loop observe records only sanitized in-memory ledger events in this CLI mode');
    process.exitCode = 2;
    return;
  }
  const valueOptions = new Set(['--root', '--plan', '--run-id', '--allow-command', '--format']);
  const unsupported = unsupportedFlags(values, new Set(['--execute-commands', ...valueOptions]), valueOptions);
  if (unsupported.length > 0) {
    console.error(`loop observe unsupported option: ${unsupported[0]}`);
    process.exitCode = 2;
    return;
  }
  const format = option(values, '--format') ?? 'json';
  if (format !== 'json') {
    console.error('loop observe only supports --format json');
    process.exitCode = 2;
    return;
  }
  const root = option(values, '--root') ?? process.cwd();
  const planPath = option(values, '--plan');
  if (!planPath) {
    console.error('loop observe requires --plan <loop-plan.json>');
    process.exitCode = 2;
    return;
  }
  const loopPlan = await loadWorkspaceJson(root, safeWorkspaceRelativePath(planPath, 'loop plan'), null);
  if (!loopPlan) throw new Error(`loop plan not found: ${planPath}`);
  const events = [];
  const observation = await recordLoopObservation({
    loopPlan,
    runId: option(values, '--run-id') ?? 'run_loop_observation',
    cwd: root,
    executeCommands: values.includes('--execute-commands'),
    confirmedCommands: options(values, '--allow-command'),
    appendEvent: async (event) => events.push(event),
    clock: fixedNow
  });
  console.log(JSON.stringify({ ...observation, ledgerEvents: events }, null, 2));
}

async function loopVerifyCommand(values) {
  if (values.includes('--write') || values.includes('--out') || values.includes('--merge')) {
    console.error('loop verify does not merge or write reports in this CLI checkpoint');
    process.exitCode = 2;
    return;
  }
  const valueOptions = new Set(['--root', '--plan', '--worktree', '--run-id', '--allow-command', '--format']);
  const unsupported = unsupportedFlags(values, new Set(['--execute-commands', '--replay', ...valueOptions]), valueOptions);
  if (unsupported.length > 0) {
    console.error(`loop verify unsupported option: ${unsupported[0]}`);
    process.exitCode = 2;
    return;
  }
  const format = option(values, '--format') ?? 'json';
  if (format !== 'json') {
    console.error('loop verify only supports --format json');
    process.exitCode = 2;
    return;
  }
  const root = option(values, '--root') ?? process.cwd();
  const planPath = option(values, '--plan');
  const worktreePath = option(values, '--worktree') ?? root;
  if (!planPath) {
    console.error('loop verify requires --plan <loop-plan.json>');
    process.exitCode = 2;
    return;
  }
  const loopPlan = await loadWorkspaceJson(root, safeWorkspaceRelativePath(planPath, 'loop plan'), null);
  if (!loopPlan) throw new Error(`loop plan not found: ${planPath}`);
  const events = [];
  const report = await runLoopVerification({
    loopPlan,
    runId: option(values, '--run-id') ?? 'run_loop_verification',
    worktreePath,
    replayMode: values.includes('--replay'),
    executeCommands: values.includes('--execute-commands'),
    confirmedCommands: options(values, '--allow-command'),
    implementer: async () => {},
    appendEvent: async (event) => events.push(event),
    clock: fixedNow
  });
  console.log(JSON.stringify({ ...report, ledgerEvents: events }, null, 2));
}

async function loopRunCommand(values) {
  if (values.includes('--write') || values.includes('--out') || values.includes('--merge')) {
    console.error('loop run does not merge or write reports in this CLI checkpoint');
    process.exitCode = 2;
    return;
  }
  const valueOptions = new Set(['--root', '--plan', '--worktree', '--run-id', '--max-iterations', '--timeout-ms', '--allow-command', '--format']);
  const unsupported = unsupportedFlags(values, new Set(['--execute-commands', '--human-approval-required', ...valueOptions]), valueOptions);
  if (unsupported.length > 0) {
    console.error(`loop run unsupported option: ${unsupported[0]}`);
    process.exitCode = 2;
    return;
  }
  const format = option(values, '--format') ?? 'json';
  if (format !== 'json') {
    console.error('loop run only supports --format json');
    process.exitCode = 2;
    return;
  }
  const root = option(values, '--root') ?? process.cwd();
  const planPath = option(values, '--plan');
  if (!planPath) {
    console.error('loop run requires --plan <loop-plan.json>');
    process.exitCode = 2;
    return;
  }
  const loopPlan = await loadWorkspaceJson(root, safeWorkspaceRelativePath(planPath, 'loop plan'), null);
  if (!loopPlan) throw new Error(`loop plan not found: ${planPath}`);
  const report = await runLoop({
    loopPlan,
    runId: option(values, '--run-id') ?? 'run_loop',
    worktreePath: option(values, '--worktree') ?? root,
    maxIterations: numericOption(values, '--max-iterations', loopPlan.maxIterations),
    timeoutMs: numericOption(values, '--timeout-ms', loopPlan.timeoutSeconds * 1000),
    humanApprovalRequired: values.includes('--human-approval-required'),
    executeCommands: values.includes('--execute-commands'),
    confirmedCommands: options(values, '--allow-command'),
    clock: fixedNow
  });
  console.log(JSON.stringify(report, null, 2));
}

async function loopScheduleCommand(values) {
  if (!values.includes('--read-only')) {
    console.error('loop schedule requires --read-only for this CLI checkpoint');
    process.exitCode = 2;
    return;
  }
  if (values.includes('--write') || values.includes('--out') || values.includes('--merge')) {
    console.error('loop schedule emits an opt-in prompt report only in this CLI checkpoint');
    process.exitCode = 2;
    return;
  }
  const valueOptions = new Set(['--root', '--plan', '--run-id', '--kind', '--cadence', '--next-run-at', '--human-approval-threshold-tokens', '--format']);
  const unsupported = unsupportedFlags(values, new Set(['--read-only', ...valueOptions]), valueOptions);
  if (unsupported.length > 0) {
    console.error(`loop schedule unsupported option: ${unsupported[0]}`);
    process.exitCode = 2;
    return;
  }
  const format = option(values, '--format') ?? 'json';
  if (format !== 'json') {
    console.error('loop schedule only supports --format json');
    process.exitCode = 2;
    return;
  }
  const root = option(values, '--root') ?? process.cwd();
  const planPath = option(values, '--plan');
  if (!planPath) {
    console.error('loop schedule requires --plan <loop-plan.json>');
    process.exitCode = 2;
    return;
  }
  const loopPlan = await loadWorkspaceJson(root, safeWorkspaceRelativePath(planPath, 'loop plan'), null);
  if (!loopPlan) throw new Error(`loop plan not found: ${planPath}`);
  const kind = option(values, '--kind') ?? 'triage';
  if (!['triage', 'pr-babysitter', 'ci-sweeper'].includes(kind)) {
    console.error('loop schedule --kind must be triage, pr-babysitter, or ci-sweeper');
    process.exitCode = 2;
    return;
  }
  const report = await runLoop({
    loopPlan,
    runId: option(values, '--run-id') ?? 'run_loop_schedule',
    humanApprovalRequired: true,
    schedule: {
      enabled: true,
      kind,
      cadence: option(values, '--cadence') ?? 'manual',
      nextRunAt: option(values, '--next-run-at'),
      humanApprovalThresholdTokens: numericOption(values, '--human-approval-threshold-tokens', 0)
    },
    clock: fixedNow
  });
  console.log(JSON.stringify(report, null, 2));
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
  if (!['json','summary'].includes(format)) {
    console.error('measure context-pack only supports --format json or summary');
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
  console.log(format === 'summary' ? renderContextPackMeasurementSummary(report) : JSON.stringify(report, null, 2));
}

async function measureSavingsCommand(values) {
  if (!values.includes('--read-only')) {
    console.error('measure savings requires --read-only');
    process.exitCode = 2;
    return;
  }
  if (values.includes('--write') || values.includes('--out') || values.includes('--pin') || values.includes('--use-out')) {
    console.error('measure savings is read-only and does not write or pin artifacts');
    process.exitCode = 2;
    return;
  }
  if (values.includes('--stdio') || values.includes('--dry-run')) {
    console.error('measure savings uses --read-only only; --stdio and --dry-run are not accepted');
    process.exitCode = 2;
    return;
  }
  const valueOptions = new Set([
    '--root',
    '--workspace',
    '--workspace-id',
    '--sqlite',
    '--scope',
    '--objective',
    '--step',
    '--token-budget',
    '--budget',
    '--limit',
    '--static-limit',
    '--dynamic-limit',
    '--format'
  ]);
  const unsupported = unsupportedFlags(values, new Set(['--read-only', ...valueOptions]), valueOptions);
  if (unsupported.length > 0) {
    console.error(`measure savings unsupported option: ${unsupported[0]}`);
    process.exitCode = 2;
    return;
  }
  const format = option(values, '--format') ?? 'json';
  if (!['json','summary'].includes(format)) {
    console.error('measure savings only supports --format json or summary');
    process.exitCode = 2;
    return;
  }
  const objective = option(values, '--objective');
  const step = option(values, '--step');
  if (!objective || !step) {
    console.error('measure savings requires --objective <text> and --step <text>');
    process.exitCode = 2;
    return;
  }
  const report = await buildSavingsMeasurementReport(values, { objective, step });
  console.log(format === 'summary' ? renderSavingsMeasurementSummary(report) : JSON.stringify(report, null, 2));
}

async function buildSavingsMeasurementReport(values, { objective, step }) {
  const root = path.resolve(option(values, '--root') ?? process.cwd());
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) throw new Error('measure savings --root must point at a local workspace directory');
  const workspaceId = option(values, '--workspace-id') ?? option(values, '--workspace') ?? 'ws_local';
  const generatedAt = fixedNow();
  const scope = option(values, '--scope') ?? 'workspace';
  const limit = parseIntegerOption(values, '--limit', 100);
  const provider = await openReadOnlySqliteMemoryProvider({
    values,
    root,
    generatedAt,
    commandName: 'measure savings',
    missingOk: false
  });
  try {
    const [exported, facts] = await Promise.all([
      provider.export({ workspaceId }),
      provider.getTemporalFacts({ workspaceId, scope, query: objective, at: generatedAt, limit })
    ]);
    const profileRecords = [...exported.records, ...facts.map(mcpProfileRecordFromFact)];
    const profile = buildCompressedProfileContextReport({
      records: profileRecords,
      workspaceId,
      generatedAt,
      objective,
      step,
      tokenBudget: parseIntegerOption(values, '--token-budget', parseIntegerOption(values, '--budget', 4096)),
      staticLimit: parseIntegerOption(values, '--static-limit', 8),
      dynamicLimit: parseIntegerOption(values, '--dynamic-limit', 5)
    });
    const sqliteRef = `workspace://${toPosix(option(values, '--sqlite') ?? '.local/memory.sqlite')}`;
    const summary = buildProfileSavingsSummary({
      profile,
      command: 'measure savings',
      workspaceId,
      generatedAt,
      objective,
      step,
      source: {
        provider: 'provider:native:memory:sqlite',
        sqliteRef,
        scope,
        recordCount: profileRecords.length,
        exportedRecordCount: exported.records.length,
        activeTemporalFactCount: facts.length
      }
    });
    const report = {
      ...summary,
      checks: {
        baselineTokensPresent: summary.beforeDeliveryTokens > 0,
        compressedTokensPresent: summary.afterDeliveryTokens > 0,
        compressedNoLargerThanBaseline: summary.afterDeliveryTokens <= summary.beforeDeliveryTokens,
        providerBillingNotClaimed: summary.savings.providerBillingClaimed === false
      }
    };
    return { ...report, reportFingerprint: stableJsonFingerprint({ ...report, reportFingerprint: null }) };
  } finally {
    provider.close();
  }
}

function renderSavingsMeasurementSummary(report) {
  return [
    `Token saving: ${report.savings.percent}%`,
    `Before delivery tokens: ${report.baseline.deliveryTokens}`,
    `After delivery tokens: ${report.compressed.deliveryTokens}`,
    `Saved delivery tokens: ${report.savings.tokensSaved}`,
    'Basis: delivery-token estimate, not provider billing'
  ].join('\n');
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

async function memoryFactCommand(values) {
  const [subcommand, ...rest] = values;
  if (subcommand === 'add') return await memoryFactAddCommand(rest);
  if (subcommand === 'get') return await memoryFactGetCommand(rest);
  if (subcommand === 'history') return await memoryFactHistoryCommand(rest);
  console.error('memory fact requires add, get, or history');
  process.exitCode = 2;
}

async function openMemoryFactProvider(values, { readOnly }) {
  const sqlitePath = option(values, '--sqlite');
  if (!sqlitePath) throw new Error('memory fact requires --sqlite <path>');
  try {
    await stat(sqlitePath);
  } catch {
    throw new Error('memory fact requires an existing SQLite database');
  }
  const { SQLiteMemoryProvider } = await import('../../providers/native/memory-sqlite/src/index.mjs');
  return new SQLiteMemoryProvider({ filename: sqlitePath, clock: fixedNow, migrate: !readOnly, readOnly });
}

function requiredOption(values, name) {
  const value = option(values, name);
  if (!value) throw new Error(`memory fact requires ${name}`);
  return value;
}

function memoryFactQuery(values) {
  return {
    workspaceId: option(values, '--workspace') ?? 'ws_local',
    scope: option(values, '--scope') ?? 'workspace',
    subject: requiredOption(values, '--subject'),
    predicate: requiredOption(values, '--predicate')
  };
}

async function memoryFactAddCommand(values) {
  if (!validateJsonFormat(values)) return;
  const provider = await openMemoryFactProvider(values, { readOnly: false });
  try {
    const fact = await provider.addTemporalFact({
      id: option(values, '--id') ?? undefined,
      ...memoryFactQuery(values),
      object: requiredOption(values, '--object'),
      text: requiredOption(values, '--text'),
      source: requiredOption(values, '--source'),
      proposalQueueId: option(values, '--proposal'),
      validFrom: option(values, '--valid-from') ?? fixedNow(),
      confidence: numericOption(values, '--confidence', 0.5),
      episode: {
        id: option(values, '--episode-id') ?? undefined,
        sourceLocator: option(values, '--episode-source') ?? requiredOption(values, '--source'),
        summary: option(values, '--episode-summary') ?? requiredOption(values, '--text'),
        observedAt: option(values, '--episode-observed-at') ?? option(values, '--valid-from') ?? fixedNow()
      }
    });
    console.log(JSON.stringify(fact, null, 2));
  } finally {
    provider.close();
  }
}

async function memoryFactGetCommand(values) {
  if (!validateJsonFormat(values)) return;
  const provider = await openMemoryFactProvider(values, { readOnly: true });
  try {
    const facts = await provider.getTemporalFacts({
      ...memoryFactQuery(values),
      at: option(values, '--at') ?? fixedNow(),
      query: option(values, '--query') ?? '',
      limit: parseIntegerOption(values, '--limit', 20)
    });
    console.log(JSON.stringify({
      schemaVersion: '1.0.0',
      workspaceId: option(values, '--workspace') ?? 'ws_local',
      generatedAt: fixedNow(),
      facts
    }, null, 2));
  } finally {
    provider.close();
  }
}

async function memoryFactHistoryCommand(values) {
  if (!validateJsonFormat(values)) return;
  const provider = await openMemoryFactProvider(values, { readOnly: true });
  try {
    const facts = await provider.getTemporalFactHistory({
      ...memoryFactQuery(values),
      limit: parseIntegerOption(values, '--limit', 50)
    });
    console.log(JSON.stringify({
      schemaVersion: '1.0.0',
      workspaceId: option(values, '--workspace') ?? 'ws_local',
      generatedAt: fixedNow(),
      facts
    }, null, 2));
  } finally {
    provider.close();
  }
}

function memoryHybridQuery(values) {
  return {
    workspaceId: option(values, '--workspace') ?? 'ws_local',
    scope: option(values, '--scope') ?? 'workspace'
  };
}

async function memorySearchCommand(values) {
  if (!validateJsonFormat(values)) return;
  const query = values.find((value, index) => index === 0 && !value.startsWith('--')) ?? option(values, '--query');
  if (!query) throw new Error('memory search requires a query');
  const provider = await openMemoryFactProvider(values, { readOnly: true });
  try {
    const report = await provider.searchTemporalMemory({
      ...memoryHybridQuery(values),
      query,
      at: option(values, '--at') ?? fixedNow(),
      limit: parseIntegerOption(values, '--limit', 10)
    });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    provider.close();
  }
}

async function memoryPathCommand(values) {
  if (!validateJsonFormat(values)) return;
  const provider = await openMemoryFactProvider(values, { readOnly: true });
  try {
    const report = await provider.getTemporalMemoryPath({
      ...memoryHybridQuery(values),
      from: requiredOption(values, '--from'),
      to: requiredOption(values, '--to')
    });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    provider.close();
  }
}

async function memoryExplainCommand(values) {
  if (!validateJsonFormat(values)) return;
  const provider = await openMemoryFactProvider(values, { readOnly: true });
  try {
    const report = await provider.explainTemporalMemory({
      ...memoryHybridQuery(values),
      query: requiredOption(values, '--query'),
      factId: requiredOption(values, '--fact'),
      at: option(values, '--at') ?? fixedNow()
    });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    provider.close();
  }
}

async function contextCommand(values) {
  if (values[0] === 'profile') return contextProfileCommand(values.slice(1));
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
    console.error('context requires --request <json> and --records <json>, context profile --records <json>, context scan --from <harness> --dry-run, context preview --from <harness> --dry-run, context pack --dry-run, context handoff --read-only, context receive --read-only, or context graph preview --dry-run');
    process.exitCode = 2;
    return;
  }
  const request = JSON.parse(await readFile(requestPath, 'utf8'));
  const records = JSON.parse(await readFile(recordsPath, 'utf8'));
  console.log(JSON.stringify(compileContext(request, records), null, 2));
}

async function contextProfileCommand(values) {
  if (!validateJsonFormat(values)) return;
  const records = await loadMemoryRecords(values);
  if (!records) return;
  const objective = option(values, '--objective');
  const step = option(values, '--step');
  if (!objective || !step) {
    console.error('context profile requires --objective <text> and --step <text>');
    process.exitCode = 2;
    return;
  }
  const report = buildCompressedProfileContextReport({
    records,
    workspaceId: option(values, '--workspace') ?? 'ws_local',
    generatedAt: fixedNow(),
    objective,
    step,
    tokenBudget: parseIntegerOption(values, '--token-budget', parseIntegerOption(values, '--budget', 4096)),
    staticLimit: parseIntegerOption(values, '--static-limit', 8),
    dynamicLimit: parseIntegerOption(values, '--dynamic-limit', 5)
  });
  console.log(JSON.stringify(report, null, 2));
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
      const usePlanContent = JSON.stringify(usePlan, null, 2);
      if (values.includes('--pin')) {
        const pin = await pinContextPackArtifacts({ root, workspaceId, pack, markdown, usePlan, markdownPath: out, usePlanPath: useOut, clock: fixedNow });
        const report = {
          schemaVersion: '1.0.0',
          usePlan,
          target: { locator: `workspace://${out}`, contentType: 'text/markdown' },
          usePlanTarget: { locator: `workspace://${useOut}`, contentType: 'application/json' },
          registryTarget: { locator: 'workspace://context-packs/registry.json', contentType: 'application/json' },
          currentTarget: { locator: 'workspace://context-packs/current.json', contentType: 'application/json' },
          registryEntry: pin.registryEntry,
          registry: pin.registry,
          changedLocatorDetection,
          localFilesWritten: pin.localFilesWritten,
          safeguards: {
            externalWritesEnabled: false,
            externalAdaptersEnabled: 0,
            rawBodyIncluded: false
          }
        };
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      await writeWorkspaceFile(root, `workspace://${out}`, markdown);
      if (useOut) await writeWorkspaceFile(root, `workspace://${useOut}`, usePlanContent);
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
    const root = option(values, '--root') ?? process.cwd();
    const workspaceId = option(values, '--workspace') ?? 'ws_local';
    const targetHarness = option(values, '--target') ?? option(values, '--target-harness') ?? null;
    const report = await buildContextPackReceiveReport({
      root,
      workspaceId,
      targetHarness,
      generatedAt: fixedNow(),
      home: process.env.HOME ?? process.cwd(),
      trustedContext: localMcpTrustedContext(workspaceId)
    });
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
    if (subcommand === 'server') return await mcpServerCommand(rest);
    if (subcommand === 'install') return await mcpInstallCommand(rest);
    if (subcommand === 'smoke') return await mcpSmokeCommand(rest);
    console.error('mcp requires resources, server, install, or smoke');
    process.exitCode = 2;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

async function mcpServerCommand(values) {
  if (!values.includes('--read-only')) {
    console.error('mcp server requires --read-only; MCP write tools are not exposed by this command');
    process.exitCode = 2;
    return;
  }
  if (!values.includes('--stdio')) {
    console.error('mcp server requires --stdio');
    process.exitCode = 2;
    return;
  }
  if (values.includes('--write') || values.includes('--out') || values.includes('--apply')) {
    console.error('mcp server is read-only and does not write context packs, config, memory, or output files');
    process.exitCode = 2;
    return;
  }
  const format = option(values, '--format') ?? 'json';
  if (format !== 'json') {
    console.error('mcp server only supports --format json');
    process.exitCode = 2;
    return;
  }
  const root = path.resolve(option(values, '--root') ?? process.cwd());
  const workspaceId = option(values, '--workspace') ?? 'ws_local';
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
    workspaceId,
    generatedAt: fixedNow()
  });
  const tools = buildMcpTokenSaverTools({ values, root, workspaceId, generatedAt: fixedNow() });
  await mcpResourcesStdio({
    resources,
    trustedContext: localMcpTrustedContext(workspaceId),
    tools,
    allowReadOnlyToolsWithoutGrant: true,
    commandLabel: 'mcp server'
  });
}

function buildMcpTokenSaverTools({ values, root, workspaceId, generatedAt }) {
  return [
    {
      name: 'memory.recall',
      description: 'Recall governed active bi-temporal memory facts for a query and scope.',
      operation: 'memory.recall',
      sideEffectClass: 'read-only',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 240 },
          scope: { type: 'string', maxLength: 64, default: 'workspace' },
          limit: { type: 'integer', minimum: 1, maximum: 20, default: 8 }
        }
      },
      handler: async ({ arguments: args }) => mcpToolJsonResult(await buildMcpMemoryRecallPayload({
        values,
        root,
        workspaceId,
        generatedAt,
        args
      }))
    },
    {
      name: 'context.profile',
      description: 'Compile a compressed profile from governed local memory for an objective.',
      operation: 'context.profile',
      sideEffectClass: 'read-only',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['objective'],
        properties: {
          objective: { type: 'string', minLength: 1, maxLength: 500 },
          step: { type: 'string', maxLength: 500 },
          scope: { type: 'string', maxLength: 64, default: 'workspace' },
          budget: { type: 'integer', minimum: 1, maximum: 100000, default: 4096 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 }
        }
      },
      handler: async ({ arguments: args }) => mcpToolJsonResult(await buildMcpContextProfilePayload({
        values,
        root,
        workspaceId,
        generatedAt,
        args
      }))
    },
    {
      name: 'context.pack',
      description: 'Return the existing sanitized context-pack handoff summary.',
      operation: 'context.pack',
      sideEffectClass: 'read-only',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['objective', 'step'],
        properties: {
          objective: { type: 'string', minLength: 1, maxLength: 500 },
          step: { type: 'string', minLength: 1, maxLength: 500 },
          from: { type: 'string', maxLength: 80, default: 'all' },
          target: { type: 'string', maxLength: 80, default: 'generic' },
          budget: { type: 'integer', minimum: 1, maximum: 100000, default: 4096 }
        }
      },
      handler: async ({ arguments: args }) => mcpToolTextResult(await buildMcpContextPackToolText({
        root,
        workspaceId,
        generatedAt,
        args
      }))
    }
  ];
}

async function buildMcpMemoryRecallPayload({ values, root, workspaceId, generatedAt, args }) {
  const query = mcpRequiredString(args.query, 'query', 240);
  const scope = mcpSafeScope(args.scope ?? 'workspace');
  const limit = mcpBoundedInteger(args.limit, 8, { min: 1, max: 20 });
  const provider = await openMcpReadOnlyMemoryProvider({ values, root, generatedAt });
  if (!provider) {
    return mcpBasePayload({
      command: 'memory.recall',
      workspaceId,
      generatedAt,
      data: { available: false, query: mcpSanitizeString(query), scope, facts: [] }
    });
  }
  try {
    const facts = await provider.getTemporalFacts({ workspaceId, scope, query, at: generatedAt, limit });
    const activeFacts = facts.filter((fact) => fact.status === 'active' && !fact.supersededBy).slice(0, limit);
    const proposalFacts = (await provider.listProposalQueue({ workspaceId, limit: 100 }))
      .map(summarizeProposalQueueFact)
      .filter((item) => item && item.scope === scope && proposalFactMatchesQuery(item, query))
      .slice(0, limit);
    const withChains = [];
    for (const fact of activeFacts) {
      const history = await provider.getTemporalFactHistory({
        workspaceId,
        scope,
        subject: fact.subject,
        predicate: fact.predicate,
        limit: 20
      });
      withChains.push(mcpSummarizeTemporalFact(fact, { history }));
    }
    return mcpBasePayload({
      command: 'memory.recall',
      workspaceId,
      generatedAt,
      data: {
        available: true,
        query: mcpSanitizeString(query),
        scope,
        factCount: withChains.length + proposalFacts.length,
        activeFactCount: withChains.length,
        proposalFactCount: proposalFacts.length,
        facts: withChains,
        proposalFacts
      }
    });
  } finally {
    provider.close();
  }
}

async function buildMcpContextProfilePayload({ values, root, workspaceId, generatedAt, args }) {
  const objective = mcpRequiredString(args.objective, 'objective', 500);
  const step = typeof args.step === 'string' && args.step.trim()
    ? mcpSanitizeString(args.step, 500)
    : 'Select compressed memory context for the objective';
  const scope = mcpSafeScope(args.scope ?? 'workspace');
  const budget = mcpBoundedInteger(args.budget, 4096, { min: 1, max: 100000 });
  const limit = mcpBoundedInteger(args.limit, 50, { min: 1, max: 100 });
  const provider = await openMcpReadOnlyMemoryProvider({ values, root, generatedAt });
  const records = [];
  let available = false;
  if (provider) {
    try {
      available = true;
      const exported = await provider.export({ workspaceId });
      const facts = await provider.getTemporalFacts({
        workspaceId,
        scope,
        query: objective,
        at: generatedAt,
        limit
      });
      const proposalRecords = (await provider.listProposalQueue({ workspaceId, limit: 100 }))
        .map(summarizeProposalQueueFact)
        .filter((item) => item && item.scope === scope && proposalFactMatchesQuery(item, objective))
        .slice(0, limit)
        .map(mcpProfileRecordFromProposal);
      records.push(...exported.records, ...facts.map(mcpProfileRecordFromFact), ...proposalRecords);
    } finally {
      provider.close();
    }
  }
  const report = buildCompressedProfileContextReport({
    records,
    workspaceId,
    generatedAt,
    objective: mcpSanitizeString(objective, 500),
    step,
    tokenBudget: budget,
    staticLimit: 8,
    dynamicLimit: 5
  });
  return mcpBasePayload({
    command: 'context.profile',
    workspaceId,
    generatedAt,
    data: {
      available,
      objectiveFingerprint: fingerprintJson(objective),
      stepFingerprint: fingerprintJson(step),
      profile: {
        id: report.id,
        layers: report.profile.layers,
        staticRecordCount: report.profile.staticRecordCount,
        dynamicRecordCount: report.profile.dynamicRecordCount,
        acceptedHistoryRecordCount: report.profile.acceptedHistoryRecordCount,
        skippedHistoryRecordCount: report.profile.skippedHistoryRecordCount,
        governedFactCount: records.length,
        proposalFactCount: records.filter((item) => item.metadata?.memoryLifecycle === 'proposal').length,
        contentHash: report.profile.contentHash
      },
      contextBudget: report.contextBudget,
      selectedContext: {
        id: report.manifest.id,
        selectedCount: report.manifest.selected.length,
        excludedCount: report.manifest.excluded.length,
        selectedIds: report.manifest.selected.map((item) => mcpSanitizeString(item.id, 120)).filter(Boolean),
        budget: report.manifest.budget
      },
      tokenSavingPercent: Math.round(Number(report.contextBudget.reductionRatio ?? 0) * 100)
    }
  });
}

async function buildMcpContextPackToolText({ root, workspaceId, generatedAt, args }) {
  const objective = mcpRequiredString(args.objective, 'objective', 500);
  const step = mcpRequiredString(args.step, 'step', 500);
  const toolValues = [
    '--context-pack',
    '--objective', objective,
    '--step', step,
    '--from', mcpSanitizeString(args.from ?? 'all', 80),
    '--target', mcpSanitizeString(args.target ?? 'generic', 80),
    '--token-budget', String(mcpBoundedInteger(args.budget, 4096, { min: 1, max: 100000 }))
  ];
  const currentContextPack = await buildMcpContextPackResource(toolValues, { root, workspaceId });
  const resources = buildOafReadOnlyResourceCatalog({
    state: {},
    projectStatus: {},
    currentContextPack,
    workspaceId,
    generatedAt
  });
  const resource = resources.find((item) => item.uri === `oaf://workspace/${workspaceId}/context-pack/current`);
  if (!resource) throw new Error('context.pack summary resource was not produced');
  const contents = await resource.read({ trustedContext: localMcpTrustedContext(workspaceId), replayMode: false });
  return contents[0].text;
}

async function openMcpReadOnlyMemoryProvider({ values, root, generatedAt }) {
  return openReadOnlySqliteMemoryProvider({ values, root, generatedAt, commandName: 'mcp server', missingOk: true });
}

async function openReadOnlySqliteMemoryProvider({ values, root, generatedAt, commandName, missingOk }) {
  const sqlitePath = await resolveWorkspaceSqlitePath(root, option(values, '--sqlite') ?? '.local/memory.sqlite', commandName, { mustExist: !missingOk });
  const absolute = sqlitePath.absolute;
  const sqliteStat = await stat(absolute).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!sqliteStat?.isFile()) {
    if (missingOk) return null;
    throw new Error(`${commandName} requires an existing SQLite database at --sqlite or .local/memory.sqlite; no database is created`);
  }
  const { SQLiteMemoryProvider } = await import('../../providers/native/memory-sqlite/src/index.mjs');
  return new SQLiteMemoryProvider({ filename: absolute, clock: () => generatedAt, migrate: false, readOnly: true });
}

function mcpProfileRecordFromFact(fact) {
  return {
    id: `mem_${fact.id}`,
    workspaceId: fact.workspaceId,
    kind: 'fact',
    text: fact.text,
    scope: 'workspace-private',
    dataClass: 'workspace-private',
    status: fact.status,
    source: fact.source,
    sourceTrust: 'verified',
    trustClass: 'verified',
    confidence: fact.confidence,
    authority: fact.confidence,
    tags: [fact.subject, fact.predicate, fact.object].filter(Boolean),
    relations: [fact.subject, fact.object].filter(Boolean),
    updatedAt: fact.updatedAt,
    observedAt: fact.validFrom
  };
}

function mcpProfileRecordFromProposal(fact) {
  return {
    id: `mem_${fact.id}`,
    workspaceId: fact.workspaceId,
    kind: 'fact',
    text: `proposal_only ${fact.text}`,
    scope: 'workspace-private',
    dataClass: 'workspace-private',
    status: 'active',
    source: fact.provenance.sourceLocator ?? 'workspace://memory/proposals',
    sourceTrust: 'unverified',
    trustClass: 'proposal',
    confidence: 0.5,
    authority: 0.5,
    tags: [fact.subject, fact.predicate, fact.object, 'memory:proposal'].filter(Boolean),
    relations: [fact.subject, fact.object].filter(Boolean),
    updatedAt: fixedNow(),
    observedAt: fixedNow(),
    metadata: {
      memoryLifecycle: 'proposal',
      proposalQueueId: fact.id,
      sourceHash: fact.provenance.sourceHash
    }
  };
}

function proposalFactMatchesQuery(fact, query) {
  const tokens = String(query ?? '').toLowerCase().match(/[a-z0-9:_-]+/gu) ?? [];
  if (!tokens.length) return true;
  const haystack = `${fact.subject} ${fact.predicate} ${fact.object} ${fact.text}`.toLowerCase();
  return tokens.some((token) => haystack.includes(token));
}

function mcpSummarizeTemporalFact(fact, { history }) {
  return {
    id: mcpSanitizeString(fact.id, 120),
    subject: mcpSanitizeString(fact.subject, 160),
    predicate: mcpSanitizeString(fact.predicate, 120),
    object: mcpSanitizeString(fact.object, 240),
    text: mcpSanitizeString(fact.text, 600),
    status: fact.status,
    confidence: Number(fact.confidence ?? 0),
    validityWindow: {
      validFrom: fact.validFrom,
      validUntil: fact.validUntil ?? null
    },
    supersededBy: fact.supersededBy ? mcpSanitizeString(fact.supersededBy, 120) : null,
    supersessionChain: history.map((item) => ({
      id: mcpSanitizeString(item.id, 120),
      status: item.status,
      current: item.id === fact.id,
      validFrom: item.validFrom,
      validUntil: item.validUntil ?? null,
      supersededBy: item.supersededBy ? mcpSanitizeString(item.supersededBy, 120) : null
    })),
    provenance: {
      sourceLocator: mcpSafeLocator(fact.source),
      proposalQueueId: fact.proposalQueueId ? mcpSanitizeString(fact.proposalQueueId, 120) : null,
      episode: fact.episode ? {
        id: mcpSanitizeString(fact.episode.id, 120),
        sourceLocator: mcpSafeLocator(fact.episode.sourceLocator),
        summary: mcpSanitizeString(fact.episode.summary, 300),
        observedAt: fact.episode.observedAt
      } : null
    }
  };
}

function mcpRequiredString(value, name, maxLength) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`mcp tool requires ${name}`);
  return mcpSanitizeString(value, maxLength);
}

function mcpSafeScope(value) {
  const scope = mcpSanitizeString(value, 64);
  if (!/^[A-Za-z0-9._:-]+$/u.test(scope)) throw new Error('mcp tool scope is invalid');
  return scope;
}

function mcpBoundedInteger(value, fallback, { min, max }) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function mcpSanitizeString(value, maxLength = 240) {
  const text = String(value ?? '').replace(MCP_PRIVATE_MATERIAL_GLOBAL, '[redacted]').normalize('NFKC').replace(/\s+/gu, ' ').trim();
  return text.slice(0, maxLength);
}

function mcpSafeLocator(value) {
  const raw = String(value ?? '');
  if (!raw) return null;
  if (MCP_PRIVATE_MATERIAL.test(raw) || raw.startsWith('file:')) return fingerprintJson(raw);
  return mcpSanitizeString(raw, 240);
}

function mcpBasePayload({ command, workspaceId, generatedAt, data }) {
  return {
    schemaVersion: '1.0.0',
    command,
    workspaceId,
    generatedAt,
    data,
    safeguards: {
      readOnly: true,
      canonicalStateMutated: false,
      externalWritesEnabled: false,
      networkCalls: 0,
      modelCalls: 0,
      activeMemoryCreated: 0,
      sourceSnapshotsWritten: 0,
      privateContentIncluded: false,
      absoluteFilesystemLocationsIncluded: false
    }
  };
}

function mcpToolJsonResult(payload) {
  return mcpToolTextResult(JSON.stringify(payload));
}

function mcpToolTextResult(text) {
  if (MCP_PRIVATE_MATERIAL.test(text)) throw new Error('mcp tool output contains private material');
  return { content: [{ type: 'text', text }] };
}

async function mcpInstallCommand(values) {
  if (values.includes('--write')) {
    console.error('mcp install uses --apply with --confirm; --write is not supported');
    process.exitCode = 2;
    return;
  }
  const format = option(values, '--format') ?? 'json';
  if (format !== 'json') {
    console.error('mcp install only supports --format json');
    process.exitCode = 2;
    return;
  }
  const client = normalizeMcpInstallClient(option(values, '--client'));
  const apply = values.includes('--apply');
  if (apply && values.includes('--dry-run')) {
    console.error('mcp install accepts either dry-run/default or --apply, not both');
    process.exitCode = 2;
    return;
  }
  const allowedFlags = new Set(['--client', '--server', '--home', '--config', '--root', '--sqlite', '--format', '--dry-run', '--apply', '--confirm']);
  const valueFlags = new Set(['--client', '--server', '--home', '--config', '--root', '--sqlite', '--format', '--confirm']);
  const unsupported = unsupportedFlags(values, allowedFlags, valueFlags);
  if (unsupported.length) {
    console.error(`mcp install unsupported option: ${unsupported[0]}`);
    process.exitCode = 2;
    return;
  }
  const root = path.resolve(option(values, '--root') ?? process.cwd());
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) throw new Error('mcp install --root must point at a local workspace directory');
  const sqlitePath = await resolveWorkspaceSqlitePath(root, option(values, '--sqlite') ?? '.local/memory.sqlite', 'mcp install', { mustExist: false });
  const home = option(values, '--home') ?? process.env.HOME ?? process.cwd();
  const setup = await buildHarnessSetupReport({
    action: 'plan',
    client: client.id,
    server: option(values, '--server') ?? 'oaf',
    home,
    configPath: option(values, '--config'),
    bridgeMode: 'token-saver',
    generatedAt: fixedNow()
  });
  const installPlan = await buildPortableMcpInstallPlan({ setup, client, root, sqlitePath, home, configPath: option(values, '--config') ?? client.configPath });
  const preview = buildMcpInstallReport({ setup, installPlan, client, root, sqlitePath, apply, applied: false, localFilesWritten: 0 });
  const confirm = option(values, '--confirm');
  if (apply && confirm !== preview.planFingerprint) {
    console.error('mcp install --apply requires --confirm <planFingerprint> from a dry-run preview');
    process.exitCode = 2;
    return;
  }
  if (apply) {
    await applyMcpInstallConfig({ home, client, configPath: option(values, '--config') ?? client.configPath, server: setup.server, desiredServer: installPlan.desiredServer });
    console.log(JSON.stringify(buildMcpInstallReport({ setup, installPlan, client, root, sqlitePath, apply, applied: true, localFilesWritten: 1 }), null, 2));
    return;
  }
  console.log(JSON.stringify(preview, null, 2));
}

function normalizeMcpInstallClient(value) {
  const aliases = new Map([['claude', 'claude-code']]);
  const id = aliases.get(String(value ?? '').trim()) ?? String(value ?? '').trim();
  const client = MCP_INSTALL_CLIENTS.get(id);
  if (!client) throw new Error('mcp install requires --client claude-code|cursor|codex');
  return client;
}

async function buildPortableMcpInstallPlan({ setup, client, root, sqlitePath, home, configPath }) {
  const realRoot = await realpath(root);
  const desiredServer = {
    name: setup.server,
    transport: 'stdio',
    command: process.execPath,
    args: [
      CLI_PATH,
      'mcp',
      'server',
      '--read-only',
      '--root',
      realRoot,
      '--sqlite',
      sqlitePath.absolute,
      '--stdio'
    ],
    environmentKeys: [],
    resourceMode: 'read-only-token-saver',
    externalWrites: false
  };
  const serverConfig = { command: desiredServer.command, args: desiredServer.args };
  const status = await classifyMcpInstallServer({ home, client, configPath, server: setup.server, desiredServer }).catch(() => setup.status.server);
  const diffOperations = status === 'installed'
    ? []
    : [{
        op: status === 'absent' ? 'add' : 'replace',
        target: client.format === 'toml' ? `mcp_servers.${setup.server}` : `mcpServers.${setup.server}`,
        before: status,
        after: 'read-only-oaf-mcp-stdio',
        summary: `${status === 'absent' ? 'add' : 'replace'} ${setup.server} with read-only OAF MCP stdio token-saver server`
      }];
  return {
    desiredServer,
    workspaceRoot: realRoot,
    sqlitePath,
    status: {
      ...setup.status,
      server: status
    },
    diff: {
      ...setup.diff,
      operations: diffOperations,
      preview: diffOperations.map((operation) => operation.summary)
    },
    manualConfigSnippet: buildMcpInstallManualConfigSnippet({
      client,
      server: setup.server,
      configRef: setup.config.ref,
      serverConfig
    })
  };
}

function buildMcpInstallManualConfigSnippet({ client, server, configRef, serverConfig }) {
  let content;
  if (client.format === 'toml') {
    const args = serverConfig.args.map((item) => `"${String(item).replaceAll('"', '\\"')}"`).join(', ');
    content = `[mcp_servers.${server}]\ncommand = "${String(serverConfig.command).replaceAll('"', '\\"')}"\nargs = [${args}]`;
  } else {
    content = JSON.stringify({ mcpServers: { [server]: serverConfig } }, null, 2);
  }
  return {
    format: client.format,
    configRef,
    applyMode: 'preview-then-confirm',
    content,
    warning: 'Preview only. OAF writes home config only with --apply and matching --confirm.'
  };
}

async function classifyMcpInstallServer({ home, client, configPath, server, desiredServer }) {
  const existing = await readMcpInstallServerConfig({ home, client, configPath, server });
  if (!existing) return 'absent';
  if (existing.command === desiredServer.command && arraysEqual(existing.args, desiredServer.args)) return 'installed';
  return 'drifted';
}

async function readMcpInstallServerConfig({ home, client, configPath, server }) {
  const realHome = await realpath(home);
  if (path.isAbsolute(configPath) || configPath.includes('..')) throw new Error('mcp install config path must stay inside --home');
  const target = path.resolve(realHome, configPath);
  if (!isInside(realHome, target)) throw new Error('mcp install config path escapes --home');
  const text = await readFile(target, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (text === null) return null;
  if (client.format === 'json') {
    const parsed = JSON.parse(text || '{}');
    const existing = parsed?.mcpServers?.[server];
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) return existing;
    return null;
  }
  if (client.format === 'toml') return readMcpInstallTomlServerConfig(text, server);
  return null;
}

function readMcpInstallTomlServerConfig(text, server) {
  const escaped = server.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`(?:^|\\n)\\[mcp_servers\\.${escaped}\\]\\n([\\s\\S]*?)(?=\\n\\[|$)`, 'u'));
  if (!match) return null;
  const body = match[1];
  const command = body.match(/(?:^|\n)\s*command\s*=\s*"((?:\\.|[^"\\])*)"/u)?.[1]?.replaceAll('\\"', '"');
  const argsText = body.match(/(?:^|\n)\s*args\s*=\s*\[([^\]]*)\]/u)?.[1] ?? '';
  const args = [...argsText.matchAll(/"((?:\\.|[^"\\])*)"/gu)].map((item) => item[1].replaceAll('\\"', '"'));
  if (!command) return null;
  return { command, args };
}

function arraysEqual(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => item === right[index]);
}

function buildMcpInstallReport({ setup, installPlan, client, root, sqlitePath, apply, applied, localFilesWritten }) {
  const reportBase = {
    schemaVersion: '1.0.0',
    command: 'mcp install',
    generatedAt: setup.generatedAt,
    dryRun: !apply,
    apply: {
      requested: apply,
      confirmed: apply,
      applied
    },
    client: setup.client,
    clientLabel: setup.clientLabel,
    server: setup.server,
    bridgeMode: setup.bridgeMode,
    workspaceRootRef: 'workspace://selected-root',
    workspaceRoot: installPlan.workspaceRoot,
    memory: {
      provider: 'provider:native:memory:sqlite',
      sqlitePath: sqlitePath.absolute,
      sqliteRef: `workspace://${sqlitePath.relative}`
    },
    config: setup.config,
    status: installPlan.status,
    desiredServer: installPlan.desiredServer,
    manualConfigSnippet: installPlan.manualConfigSnippet,
    reversal: {
      mode: 'manual',
      configRef: setup.config.ref,
      target: client.format === 'toml' ? `mcp_servers.${setup.server}` : `mcpServers.${setup.server}`,
      instruction: 'Remove only this server entry to reverse the install; do not paste or print the raw home config body.'
    },
    diff: installPlan.diff,
    safeguards: {
      ...setup.safeguards,
      localFilesWritten,
      homeConfigMutated: applied
    }
  };
  const planFingerprint = fingerprintMcpInstallPlan(reportBase);
  return {
    ...reportBase,
    planFingerprint,
    nextCommand: apply || applied
      ? null
      : `npm run oaf -- mcp install --client ${client.id} --root ${JSON.stringify(root)} --apply --confirm ${planFingerprint} --format json`,
    warnings: [
      'Dry-run is the default; OAF writes home config only with --apply and matching --confirm.',
      'Review the config before applying. The MCP server is local stdio and read-only.'
    ]
  };
}

function fingerprintMcpInstallPlan(report) {
  return fingerprintJson({
    command: report.command,
    client: report.client,
    server: report.server,
    bridgeMode: report.bridgeMode,
    workspaceRootRef: report.workspaceRootRef,
    config: report.config,
    status: report.status,
    desiredServer: report.desiredServer,
    diff: report.diff
  });
}

async function applyMcpInstallConfig({ home, client, configPath, server, desiredServer }) {
  const realHome = await realpath(home);
  if (path.isAbsolute(configPath) || configPath.includes('..')) throw new Error('mcp install config path must stay inside --home');
  const target = path.resolve(realHome, configPath);
  if (!isInside(realHome, target)) throw new Error('mcp install config path escapes --home');
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const current = await readFile(target, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const serverConfig = { command: desiredServer.command, args: desiredServer.args };
  const next = client.format === 'toml'
    ? mergeMcpInstallToml(current ?? '', server, serverConfig)
    : mergeMcpInstallJson(current ?? '{}', server, serverConfig);
  await writeFile(target, next, { mode: 0o600 });
}

function mergeMcpInstallJson(text, server, serverConfig) {
  const parsed = JSON.parse(text || '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('mcp install JSON config must be an object');
  const source = parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)
    ? { ...parsed.mcpServers }
    : {};
  source[server] = serverConfig;
  return `${JSON.stringify({ ...parsed, mcpServers: source }, null, 2)}\n`;
}

function mergeMcpInstallToml(text, server, serverConfig) {
  const sectionPattern = new RegExp(`(?:^|\\n)\\[mcp_servers\\.${server.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\n(?:[^\\[]|\\[(?!mcp_servers\\.))*`, 'u');
  const withoutExisting = text.replace(sectionPattern, (match) => match.startsWith('\n') ? '\n' : '');
  const args = serverConfig.args.map((item) => `"${String(item).replaceAll('"', '\\"')}"`).join(', ');
  const section = `[mcp_servers.${server}]\ncommand = "${serverConfig.command}"\nargs = [${args}]\n`;
  const prefix = withoutExisting.trimEnd();
  return `${prefix ? `${prefix}\n\n` : ''}${section}`;
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
      console.error(`unknown MCP resource: ${fingerprintJson(uri)}`);
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
  const memoryProposalPreflight = await buildMemoryProposalPreflight(values, { root, workspaceId, generatedAt });
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
    state: pack.utility.status === 'ready' &&
      smoke.checks.resourceRead &&
      smoke.checks.noToolsExposed &&
      smoke.checks.noMarkdownBody &&
      setup.dryRun === true &&
      memoryProposalPreflight.state !== 'review'
      ? 'ready'
      : 'review',
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
    memoryProposalPreflight,
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

function safeWorkspaceRelativePath(value, label) {
  const relativePath = String(value ?? '').trim();
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('..') || relativePath.includes('\\') || /^[a-z]+:/iu.test(relativePath)) {
    throw new Error(`${label} must be workspace-relative`);
  }
  if (!/^[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,512}$/u.test(relativePath)) throw new Error(`${label} contains unsupported characters`);
  if (/(^|\/)(?:\.git|\.local|node_modules)(?:\/|$)/u.test(relativePath)) throw new Error(`${label} points to an unsupported workspace location`);
  return relativePath;
}

function memoryProposalCommand(configPath = 'oaf.memory.json') {
  return `npm --silent run oaf -- memory proposals --from memoryPaths --config ${shellQuote(configPath)} --root . --dry-run --format json`;
}

function memoryPreflightSafeguards(report = null) {
  return {
    dryRun: true,
    canonicalStateMutated: false,
    localFilesWritten: 0,
    externalWritesEnabled: false,
    externalAdaptersEnabled: 0,
    networkCalls: 0,
    modelCalls: 0,
    activeMemoryCreated: Number(report?.safeguards?.activeMemoryCreated ?? 0),
    sourceSnapshotsWritten: 0,
    rawSourceBodiesIncluded: false,
    proposalTextIncluded: false,
    proposalMarkdownIncluded: false,
    sourceContentIncluded: false,
    credentialsIncluded: false,
    providerUrlsIncluded: false,
    hiddenReasoningIncluded: false,
    absoluteFilesystemLocationsIncluded: false
  };
}

function summarizeMemoryProposalReport(report, { configRef, command }) {
  const warnings = [...new Set(report.diagnostics?.warnings ?? [])].sort();
  const proposalCount = Number(report.summary.proposalCount ?? 0);
  const quarantinedCount = Number(report.summary.quarantinedCount ?? 0);
  const reviewItemCount = proposalCount + quarantinedCount;
  const review = reviewItemCount > 0 || warnings.length > 0;
  return {
    state: review ? 'review' : 'ready',
    configured: true,
    configRef,
    command,
    dryRun: report.dryRun === true,
    summary: {
      proposalCount,
      quarantinedCount,
      skippedCount: Number(report.summary.skippedCount ?? 0),
      reviewItemCount
    },
    diagnostics: {
      sourceCount: Number(report.diagnostics?.sourceCount ?? 0),
      memoryIndexCount: Number(report.diagnostics?.memoryIndexCount ?? 0),
      staleSourceCount: Number(report.diagnostics?.staleSourceCount ?? 0),
      indexCliffRiskCount: Number(report.diagnostics?.indexCliffRiskCount ?? 0),
      warningCodes: warnings
    },
    reportFingerprint: fingerprintJson({
      id: report.id,
      summary: report.summary,
      diagnostics: {
        sourceCount: report.diagnostics?.sourceCount ?? 0,
        memoryIndexCount: report.diagnostics?.memoryIndexCount ?? 0,
        staleSourceCount: report.diagnostics?.staleSourceCount ?? 0,
        indexCliffRiskCount: report.diagnostics?.indexCliffRiskCount ?? 0,
        warnings
      },
      safeguards: report.safeguards
    }),
    safeguards: memoryPreflightSafeguards(report)
  };
}

async function buildMemoryProposalPreflight(values, { root, workspaceId, generatedAt }) {
  const configuredPath = option(values, '--memory-config');
  if (!configuredPath) {
    return {
      state: 'not_configured',
      configured: false,
      configRef: null,
      command: memoryProposalCommand(),
      dryRun: true,
      summary: { proposalCount: 0, quarantinedCount: 0, skippedCount: 0, reviewItemCount: 0 },
      diagnostics: { sourceCount: 0, memoryIndexCount: 0, staleSourceCount: 0, indexCliffRiskCount: 0, warningCodes: [] },
      reportFingerprint: null,
      safeguards: memoryPreflightSafeguards()
    };
  }
  return buildMemoryProposalPreflightFromFile({
    root,
    workspaceId,
    configPath: configuredPath,
    generatedAt
  });
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

function ratioPercent(value) {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) return '0.00%';
  return `${(numeric * 100).toFixed(2)}%`;
}

function passFail(value) {
  return value === true ? 'pass' : 'review';
}

function deliveryBudgetStatus(report) {
  const ratio = Number(report.contextPack.deliveredUnitRatio ?? 0);
  if (!Number.isFinite(ratio)) return 'review';
  if (ratio > 1) return `above candidate estimate by ${ratioPercent(ratio - 1)}`;
  return 'within candidate estimate';
}

function renderContextPackMeasurementSummary(report) {
  const changed = report.contextPack.changedSourceBudget;
  return [
    '# Context Pack Measurement',
    '',
    `Target harness: ${report.targetHarness}`,
    `Commit: ${report.commitSha ?? 'unavailable'}`,
    `Report fingerprint: ${report.reportFingerprint}`,
    '',
    '## Selection and Delivery',
    `Candidate units: ${Number(report.contextPack.candidateUnitCount)}`,
    `Selected units: ${Number(report.contextPack.selectedUnitCount)} (${ratioPercent(report.contextPack.selectedUnitRatio)} selected)`,
    `Source selection reduction: ${ratioPercent(report.contextPack.estimatedSelectionReductionRatio)}`,
    `Delivered handoff units: ${Number(report.contextPack.deliveredUnitCount)} (${ratioPercent(report.contextPack.deliveredUnitRatio)} of candidate units)`,
    `Observed delivery reduction: ${ratioPercent(report.contextPack.observedDeliveryReductionRatio)}`,
    `Delivery budget status: ${deliveryBudgetStatus(report)}`,
    '',
    '## Changed Source Bodies',
    `Changed locators measured: ${Number(changed.measuredLocatorCount)} / ${Number(changed.locatorCount)}`,
    `Changed source tokens scanned: ${Number(changed.contentTokenCount)}`,
    `Changed source tokens included: ${Number(changed.contentTokenCountIncluded)}`,
    `Changed source body avoidance: ${ratioPercent(changed.observedAvoidanceRatio)}`,
    `Changed locator coverage: ${report.contextPack.changedLocatorCoverage.status}`,
    '',
    '## MCP Readback',
    `Transport: ${report.mcpReadback.transport}`,
    `Resource URI: ${report.mcpReadback.resourceUri}`,
    `Readback duration: ${Number(report.mcpReadback.durationMs)} ms`,
    `Resource bytes: ${Number(report.mcpReadback.resourceByteSize)}`,
    `Tools exposed: ${Number(report.mcpReadback.toolsExposed)}`,
    `Fingerprint match: ${passFail(report.checks.contextPackFingerprintMatchesMcp)}`,
    '',
    '## Local Timing',
    `Context pack build: ${Number(report.timings.contextPackBuildMs)} ms`,
    `MCP readback: ${Number(report.timings.mcpReadbackMs)} ms`,
    `Total observed: ${Number(report.timings.totalObservedMs)} ms`,
    '',
    '## Safeguards',
    `Read-only: ${passFail(report.safeguards.readOnly)}`,
    `Local files written: ${Number(report.safeguards.localFilesWritten)}`,
    `Network calls: ${Number(report.safeguards.networkCalls)}`,
    `Model calls: ${Number(report.safeguards.modelCalls)}`,
    `External writes enabled: ${report.safeguards.externalWritesEnabled === true ? 'yes' : 'no'}`,
    `External adapters enabled: ${Number(report.safeguards.externalAdaptersEnabled)}`,
    `Raw source bodies included: ${report.safeguards.sourceContentIncluded === true ? 'yes' : 'no'}`,
    `Production benchmark claimed: ${report.safeguards.productionBenchmarkClaimed === true ? 'yes' : 'no'}`
  ].join('\n');
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

async function mcpResourcesStdio({
  resources,
  trustedContext,
  tools = [],
  allowReadOnlyToolsWithoutGrant = false,
  commandLabel = 'mcp resources'
}) {
  const input = await readStdinText();
  if (!input.trim()) {
    console.error(`${commandLabel} --stdio requires JSON-RPC input on stdin`);
    process.exitCode = 2;
    return;
  }
  const bridge = createMcpBridge({ trustedContext, resources, tools, allowReadOnlyToolsWithoutGrant });
  const messages = parseJsonRpcMessages(input, { commandLabel });
  for (const message of messages) {
    const response = await bridge.handle(message);
    if (response) console.log(JSON.stringify(response));
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

function parseJsonRpcMessages(input, { commandLabel = 'mcp resources' } = {}) {
  const trimmed = input.trim();
  const lines = trimmed.split(/\r?\n/u).filter((line) => line.trim());
  if (lines.length > MCP_STDIO_MAX_MESSAGES) {
    throw new Error(`${commandLabel} --stdio received too many JSON-RPC messages; max ${MCP_STDIO_MAX_MESSAGES}`);
  }
  return lines.map((line, index) => {
    const lineNumber = index + 1;
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (lineBytes > MCP_STDIO_MAX_LINE_BYTES) {
      throw new Error(`${commandLabel} --stdio JSON-RPC line ${lineNumber} exceeds ${MCP_STDIO_MAX_LINE_BYTES} bytes`);
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`${commandLabel} --stdio JSON-RPC line ${lineNumber} is not valid JSON`);
    }
    if (Array.isArray(parsed)) {
      throw new Error(`${commandLabel} --stdio JSON-RPC batches are not supported`);
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`${commandLabel} --stdio JSON-RPC line ${lineNumber} must be an object`);
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

async function resolveWorkspaceSqlitePath(root, sqlitePath, commandName, { mustExist }) {
  const requested = sqlitePath ?? '.local/memory.sqlite';
  const realRoot = await realpath(root);
  const absolute = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(realRoot, requested);
  if (!isInside(realRoot, absolute)) {
    throw new Error(`${commandName} --sqlite must stay inside --root`);
  }
  const existing = await stat(absolute).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (mustExist && !existing?.isFile()) {
    throw new Error(`${commandName} requires an existing SQLite database at --sqlite or .local/memory.sqlite; no database is created`);
  }
  return { absolute, relative: toPosix(path.relative(realRoot, absolute)) };
}

async function buildWorkspaceMemoryIngestEpisodes({ root, workspaceId, scope, generatedAt, limit }) {
  const episodes = [];
  const remaining = () => Math.max(0, limit - episodes.reduce((sum, episode) => sum + episode.text.split(/\n/u).filter(Boolean).length, 0));
  const gitFacts = collectGitHistoryFacts(root).slice(0, Math.min(12, remaining()));
  if (gitFacts.length) episodes.push(memoryIngestEpisode({
    workspaceId,
    scope,
    sourceLocator: 'workspace://git/recent-commits',
    observedAt: generatedAt,
    facts: gitFacts,
    metadata: { sourceKind: 'git-history' }
  }));

  for (const relativePath of memoryIngestDocPaths()) {
    if (remaining() <= 0) break;
    const facts = await collectDocMemoryFacts(root, relativePath);
    if (!facts.length) continue;
    episodes.push(memoryIngestEpisode({
      workspaceId,
      scope,
      sourceLocator: `workspace://${relativePath}`,
      observedAt: generatedAt,
      facts: facts.slice(0, remaining()),
      metadata: { sourceKind: 'workspace-doc' }
    }));
  }

  if (remaining() > 0) {
    const graphFacts = await collectSourceGraphMemoryFacts(root, workspaceId, generatedAt);
    if (graphFacts.length) episodes.push(memoryIngestEpisode({
      workspaceId,
      scope,
      sourceLocator: 'workspace://source-graph/native-preview',
      observedAt: generatedAt,
      facts: graphFacts.slice(0, remaining()),
      metadata: { sourceKind: 'source-graph' }
    }));
  }
  return episodes;
}

function memoryIngestEpisode({ workspaceId, scope, sourceLocator, observedAt, facts, metadata }) {
  return {
    workspaceId,
    scope,
    sourceLocator,
    observedAt,
    text: [...new Set(facts)].join('\n'),
    metadata
  };
}

function collectGitHistoryFacts(root) {
  try {
    return execFileSync('git', ['-C', root, 'log', '--max-count=12', '--pretty=%s'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).split(/\r?\n/u)
      .map((subject) => safeFactToken(subject, 'commit'))
      .filter(Boolean)
      .map((subject) => factTriple('project:oaf', 'recent_commit', subject));
  } catch {
    return [];
  }
}

function memoryIngestDocPaths() {
  return [
    'README.md',
    'AGENTS.md',
    'PRODUCT.md',
    'PROJECT_STATUS.json',
    'docs/architecture/overview.md',
    'docs/adr/0019-proposal-gated-harness-memory-import.md',
    'docs/adr/0020-read-only-mcp-before-write-tools.md',
    'docs/adr/0021-native-source-graph-before-codebase-memory-adapter.md'
  ];
}

async function collectDocMemoryFacts(root, relativePath) {
  const absolute = path.resolve(root, relativePath);
  const info = await stat(absolute).catch(() => null);
  if (!info?.isFile() || info.size > 512 * 1024) return [];
  const text = await readFile(absolute, 'utf8');
  const facts = [factTriple('project:oaf', 'has_doc', safeFactToken(relativePath, 'doc'))];
  const checks = [
    [/local-first/i, 'locality', 'local-first'],
    [/proposal[- ]gated|proposal gate/i, 'memory_policy', 'proposal-gated'],
    [/read-only MCP/i, 'mcp_policy', 'read-only-first'],
    [/source graph/i, 'context_source', 'native-source-graph'],
    [/context manifest/i, 'requires', 'context-manifests'],
    [/no external service|no external writes|externalWrites.*false/i, 'external_writes', 'disabled-by-default'],
    [/SQLite|FTS5/i, 'memory_store', 'sqlite-fts5']
  ];
  for (const [pattern, predicate, object] of checks) {
    if (pattern.test(text)) facts.push(factTriple('project:oaf', predicate, object));
  }
  return [...new Set(facts)];
}

async function collectSourceGraphMemoryFacts(root, workspaceId, generatedAt) {
  const preview = await buildSourceGraphPreview({
    root,
    workspaceId,
    query: 'memory context mcp',
    sampleLimit: 12,
    maxFiles: 200,
    clock: () => generatedAt
  });
  const summary = preview.graph?.summary ?? {};
  const facts = [
    factTriple('project:oaf', 'source_graph_files', `files_${Math.max(0, Number(summary.fileCount ?? 0))}`),
    factTriple('project:oaf', 'source_graph_modules', `modules_${Math.max(0, Number(summary.moduleCount ?? 0))}`),
    factTriple('project:oaf', 'source_graph_symbols', `symbols_${Math.max(0, Number(summary.symbolCount ?? 0))}`)
  ];
  for (const hotspot of (summary.hotspots ?? []).slice(0, 5)) {
    const label = safeFactToken(hotspot.label ?? hotspot.name ?? hotspot.id, 'hotspot');
    if (label) facts.push(factTriple('project:oaf', 'source_graph_hub', label));
  }
  return facts;
}

function factTriple(subject, predicate, object) {
  return `${safeFactToken(subject, 'subject')} ${safeFactToken(predicate, 'predicate')} ${safeFactToken(object, 'object')}.`;
}

function safeFactToken(value, fallback) {
  const normalized = String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 96);
  const token = normalized || fallback;
  return /^[a-z0-9:_-]{1,128}$/u.test(token) ? token : fallback;
}

function summarizeProposalQueueFact(item) {
  if (item?.payload?.kind !== 'fact') return null;
  if (!['pending', 'claimed'].includes(item.status)) return null;
  return {
    id: mcpSanitizeString(item.id, 120),
    workspaceId: item.workspaceId,
    status: item.status,
    scope: mcpSanitizeString(item.payload.scope ?? 'workspace', 64),
    subject: mcpSanitizeString(item.payload.subject, 160),
    predicate: mcpSanitizeString(item.payload.predicate, 120),
    object: mcpSanitizeString(item.payload.object, 240),
    text: mcpSanitizeString(item.payload.text, 600),
    provenance: {
      sourceLocator: mcpSafeLocator(item.sourceLocator),
      sourceHash: item.sourceHash,
      episodeId: item.payload.provenanceEpisodeId ? mcpSanitizeString(item.payload.provenanceEpisodeId, 120) : null
    }
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

function toPosix(value) {
  return String(value).split(path.sep).join('/');
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

function numericOption(values, name, fallback) {
  const value = option(values, name);
  if (value === null) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
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
  oaf demo memory-loop --root . --format json
  oaf serve
  oaf check
  oaf eval
  oaf manifest
  oaf context --request request.json --records records.json
  oaf context profile --records memory-export.json --objective "Ship safely" --step "select compact memory" --token-budget 4096 --format json
  oaf context scan --from codex --root . --dry-run
  oaf context preview --from codex --root . --objective "Ship safely" --step "select context" --include-file notes/handoff.md --dry-run
  oaf context pack --from codex --root . --objective "Ship safely" --step "handoff" --target codex --include-file notes/handoff.md --changed src/auth.ts --changed-from-git --dry-run --format markdown
  oaf context pack --from codex --root . --objective "Ship safely" --step "handoff" --target codex --write --out context-packs/CONTEXT_PACK.md --use-out context-packs/CONTEXT_PACK.use.json --format json
  oaf context pack --from codex --root . --objective "Ship safely" --step "handoff" --target codex --write --pin --out context-packs/CONTEXT_PACK.md --format json
  oaf context handoff --read-only --from codex --root . --objective "Ship safely" --step "handoff" --target codex --changed src/auth.ts --memory-config oaf.memory.json --format json
  oaf context receive --read-only --root . --target codex --format json
  oaf context registry status --read-only --format json
  oaf context graph preview --root . --query "approve token reset" --trace runAuthWorkflow --changed src/auth.ts --changed-from-git --dry-run --format json
  oaf loop plan --read-only --root . --objective "Ship safely" --stop-condition "focused tests pass" --validation "node --test tests/web-shell.test.mjs" --format json
  oaf loop observe --root . --plan loop-plan.json --execute-commands --format json
  oaf loop verify --root . --plan loop-plan.json --worktree ../isolated-worktree --execute-commands --format json
  oaf loop run --root . --plan loop-plan.json --worktree ../isolated-worktree --execute-commands --format json
  oaf loop schedule --read-only --root . --plan loop-plan.json --kind triage --cadence manual --format json
  oaf measure savings --read-only --root . --objective "Ship safely" --step "measure savings" --format json
  oaf measure savings --read-only --root . --objective "Ship safely" --step "measure savings" --format summary
  oaf measure context-pack --read-only --root . --from codex --objective "Ship safely" --step "impact brief" --target codex --changed src/auth.ts --format json
  oaf measure context-pack --read-only --root . --from codex --objective "Ship safely" --step "impact brief" --target codex --changed src/auth.ts --format summary
  oaf benchmark truth-floor --suite benchmark-truth-floor --dataset evals/benchmark-truth-floor/cases.v1.json --format json
  oaf memory profile --records memory-export.json --root . --dry-run --format json
  oaf memory ingest --root . --sqlite .local/memory.sqlite --format json
  oaf memory proposals --records memory-export.json --root . --dry-run --format json
  oaf memory proposals --from memoryPaths --config oaf.memory.json --root . --dry-run --format json
  oaf memory sgrep "context manifest" --records memory-export.json --workspace ws_local --dry-run --format json
  oaf memory fact add --sqlite .local/memory.sqlite --workspace ws_local --scope workspace --subject project:oaf --predicate release_status --object release-candidate --text "OAF release status is release-candidate." --source workspace://memory/status.md --proposal mpq_status --episode-id mep_status --episode-source workspace://memory/status.md --episode-summary "Reviewed status note." --format json
  oaf memory fact get --sqlite .local/memory.sqlite --workspace ws_local --scope workspace --subject project:oaf --predicate release_status --at 2026-06-26T00:00:00.000Z --format json
  oaf memory fact history --sqlite .local/memory.sqlite --workspace ws_local --scope workspace --subject project:oaf --predicate release_status --format json
  oaf memory search "release" --sqlite .local/memory.sqlite --workspace ws_local --scope workspace --format json
  oaf memory path --sqlite .local/memory.sqlite --workspace ws_local --scope workspace --from project:oaf --to temporal-memory --format json
  oaf memory explain --sqlite .local/memory.sqlite --workspace ws_local --scope workspace --query release --fact memfact_status --format json
  oaf mcp resources --read-only --workspace ws_local --format json
  oaf mcp resources --read-only --context-pack --objective "Ship safely" --step "handoff" --target codex --changed src/auth.ts --changed-from-git --uri oaf://workspace/ws_local/context-pack/current --format json
  oaf mcp resources --read-only --context-pack-use context-packs/CONTEXT_PACK.use.json --uri oaf://workspace/ws_local/context-pack/use-plan/current --format json
  oaf mcp resources --read-only --context-pack-registry --uri oaf://workspace/ws_local/context-pack/registry/current --format json
  oaf mcp smoke context-pack --read-only --objective "Ship safely" --step "handoff" --target codex --changed src/auth.ts --changed-from-git --format json
  oaf mcp resources --read-only --stdio
  oaf mcp server --read-only --root . --stdio
  oaf mcp install --client claude-code --dry-run --format json
  oaf harness setup status --client codex --dry-run --format json
  oaf harness setup plan --client cursor --server oaf --dry-run --format json
  oaf harness setup uninstall --client cursor --server oaf --dry-run --format json
  oaf version

Run oaf task only when npm run status names a next task.
The default bootstrap is local-only and enables no external writes.`);
}
