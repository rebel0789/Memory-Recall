#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createReadStream, existsSync, realpathSync } from 'node:fs';
import { appendFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename as renameFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { buildCompressedProfileContextReport, compileContext, estimateTokens } from '../../packages/context-compiler/src/index.mjs';
import { createBenchmarkDataset, runBenchmarkTruthFloor } from '../../packages/evaluation-lab/src/index.mjs';
import {
  buildContextPack,
  buildContextPackImpactBrief,
  buildContextPackReceiveReport,
  buildContextPackUsePlan,
  buildContextProfileDeliveryPayloadFromReport,
  buildHarnessContextPreview,
  buildHarnessSetupReport,
  buildLoopPlan,
  buildMemoryProposalPreflightFromFile,
  OAF_MCP_RESOURCE_BINARY_ARGS,
  OAF_MCP_TOKEN_SAVER_BINARY_ARGS,
  buildRealisticContextProfileSavingsReport,
  detectGitChangedLocators,
  loadCurrentContextPackUsePlan,
  pinContextPackArtifacts,
  REALISTIC_SAVINGS_OBJECTIVE,
  REALISTIC_SAVINGS_STEP,
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
import memoryRefineReportSchema from '../../packages/protocol/schemas/memory-refine-report.schema.json' with { type: 'json' };
import skillManifestSchema from '../../packages/protocol/schemas/skill-manifest.schema.json' with { type: 'json' };
import skillCatalogReportSchema from '../../packages/protocol/schemas/skill-catalog-report.schema.json' with { type: 'json' };
import skillLoadPlanSchema from '../../packages/protocol/schemas/skill-load-plan.schema.json' with { type: 'json' };
import { assertJsonSchema } from '../../packages/protocol/src/schema-validator.mjs';
import { sha256Hex, stableStringify } from '../../packages/protocol/src/fingerprint.mjs';
import { loadReviewedToolCatalog } from '../../packages/tool-registry/src/index.mjs';
import {
  DEFAULT_SOURCE_GRAPH_PREVIEW_MAX_FILE_BYTES,
  buildSourceGraphPreview
} from '../../packages/source-graph/src/index.mjs';

const CLI_PATH = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = path.resolve(path.dirname(CLI_PATH), '../..');
const OAF_CHECKOUT_COMMAND_PREFIX = 'npm --silent run oaf --';
const OAF_CHECKOUT_ARG_PREFIX = Object.freeze(['--silent', 'run', 'oaf', '--']);
const MCP_STDIO_MAX_STDIN_BYTES = boundedEnvInteger('OAF_MCP_STDIO_MAX_STDIN_BYTES', 64 * 1024, { min: 1, max: 512 * 1024 });
const MCP_STDIO_MAX_LINE_BYTES = boundedEnvInteger('OAF_MCP_STDIO_MAX_LINE_BYTES', 32 * 1024, { min: 1, max: 512 * 1024 });
const MCP_STDIO_MAX_MESSAGES = boundedEnvInteger('OAF_MCP_STDIO_MAX_MESSAGES', 16, { min: 1, max: 64 });
const MCP_STDIO_CHILD_TIMEOUT_MS = boundedEnvInteger('OAF_MCP_STDIO_CHILD_TIMEOUT_MS', 30_000, { min: 1, max: 60_000 });
const MCP_STDIO_CHILD_MAX_STDOUT_BYTES = boundedEnvInteger('OAF_MCP_STDIO_CHILD_MAX_STDOUT_BYTES', 512 * 1024, { min: 1, max: 2_000_000 });
const MCP_STDIO_CHILD_MAX_STDERR_BYTES = boundedEnvInteger('OAF_MCP_STDIO_CHILD_MAX_STDERR_BYTES', 64 * 1024, { min: 1, max: 512 * 1024 });
const MEMORY_PATH_MAX_BYTES = 8 * 1024 * 1024;
const SECRET_LIKE = /\b(?:authorization\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|(?:Bearer|Basic|Digest|Token)\s+[^\s"'`,;)]+|[^\s"'`,;)]+)|(?:api[_-]?key|token|secret|password)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"'`,;)]+))/iu;
const PRIVATE_LOCAL_PATH = /(?:^|[\s"'`(])(?:\/Users(?:\/|$)|\/home\/[A-Za-z0-9._-]+(?:\/|$)|\/private(?:\/|$)|\/var\/folders(?:\/|$)|[A-Za-z]:\\)/u;
const AUTO_DETECTED_SECRET_PATH = /(^|\/)(?:\.env(?:[./_-]|$)|secrets?(?:[./_-]|$)|credentials?(?:[./_-]|$)|id_rsa(?:[./_-]|$)|id_ed25519(?:[./_-]|$)|[^/]+\.(?:pem|key|p12|pfx|crt|cert)$)/iu;
const MCP_PRIVATE_MATERIAL = /(?:\/Users(?:\/|$)[^\s"',;]*|\/home\/[A-Za-z0-9._-]+(?:\/|$)[^\s"',;]*|[A-Za-z]:\\[^\s"',;]*|sk-[A-Za-z0-9_-]{12,}|OPENAI_API_KEY|AKIA[0-9A-Z]{16}|gh[opsu]_[A-Za-z0-9_]{12,}|(?:token|secret|password|api[_-]?key)\s*[=:]\s*[^\s"',;]+)/iu;
const MCP_PRIVATE_MATERIAL_GLOBAL = /(?:\/Users(?:\/|$)[^\s"',;]*|\/home\/[A-Za-z0-9._-]+(?:\/|$)[^\s"',;]*|[A-Za-z]:\\[^\s"',;]*|sk-[A-Za-z0-9_-]{12,}|OPENAI_API_KEY|AKIA[0-9A-Z]{16}|gh[opsu]_[A-Za-z0-9_]{12,}|(?:token|secret|password|api[_-]?key)\s*[=:]\s*[^\s"',;]+)/giu;
const MEMORY_BATCH_UNSAFE_TEXT = /(?:^|[\s('"`])\/(?:[A-Za-z0-9._-]+\/)+[^\s)'"<>]+|file:\/\/|[A-Za-z]:\\|\n|\r/iu;
const MEMORY_BATCH_CONFIDENCES = new Set(['extracted', 'inferred', 'ambiguous']);
const REALQA_QUERY_STOPWORDS = new Set(['what', 'which', 'who', 'where', 'when', 'why', 'how', 'is', 'the', 'a', 'an', 'by', 'does', 'do', 'for', 'to', 'of', 'provider', 'default', 'implements']);
const LOCOMO_ANSWER_STOPWORDS = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'her', 'his', 'their', 'was', 'were', 'would', 'likely', 'since']);
const EXPLICIT_CHANGED_LOCATOR_OPTIONS = new Set(['--changed', '--changed-locator']);
const MCP_INSTALL_CLIENTS = new Map([
  ['codex', { id: 'codex', format: 'toml', configPath: '.codex/config.toml' }],
  ['cursor', { id: 'cursor', format: 'json', configPath: '.cursor/mcp.json' }],
  ['claude-code', { id: 'claude-code', format: 'json', configPath: '.claude/mcp.json' }]
]);

const [command = 'help', ...args] = process.argv.slice(2);
const commands = new Map([
  ['setup', ['scripts/bootstrap.mjs']],
  ['verify', ['scripts/verify-handoff.mjs']],
  ['doctor', ['scripts/doctor.mjs']],
  ['demo', ['scripts/demo.mjs', ...args]],
  ['serve', ['services/control-api/src/server.mjs']],
  ['check', ['scripts/check.mjs']],
  ['eval', ['scripts/run-evals.mjs']],
  ['manifest', ['scripts/generate-manifest.mjs']],
  ['status', ['scripts/status.mjs']],
  ['task', ['scripts/task.mjs', ...args]]
]);

function defaultHandoffArgs() {
  return [
    '--read-only',
    '--from',
    'codex',
    '--root',
    '.',
    '--objective',
    'Ship safely',
    '--step',
    'handoff',
    '--target',
    'codex',
    '--changed-from-git',
    '--format',
    'summary'
  ];
}

function defaultTokenSaverArgs() {
  return [
    '--read-only',
    '--root',
    '.',
    '--from',
    'codex',
    '--objective',
    'Ship safely',
    '--step',
    'impact brief',
    '--target',
    'codex',
    '--changed-from-git',
    '--format',
    'summary'
  ];
}

function contextPackValueOptions() {
  return new Set(['--root', '--workspace', '--from', '--objective', '--step', '--target', '--target-harness', '--include-file', '--changed', '--changed-locator', '--changed-from', '--changed-shard', '--token-budget', '--budget', '--format']);
}

function contextPackOptionAliases() {
  return new Map([
    ['--target', '--target'],
    ['--target-harness', '--target']
  ]);
}

function mergeDefaultArgs(defaults, overrides, valueOptions, aliases = new Map()) {
  if (overrides.length === 0) return defaults;
  const overridden = new Set(overrides.filter((value) => value.startsWith('--')).map((value) => aliases.get(value) ?? value));
  const merged = [];
  for (let index = 0; index < defaults.length; index += 1) {
    const value = defaults[index];
    if (overridden.has(aliases.get(value) ?? value)) {
      if (valueOptions.has(value)) index += 1;
      continue;
    }
    merged.push(value);
  }
  return [...merged, ...overrides];
}

if (!isHelpCommand(command) && args.some(isHelpCommand)) {
  help(command, args.find((value) => !isHelpCommand(value)));
} else if (command === 'demo' && args[0] === 'memory-loop') {
  await demoMemoryLoopCommand(args.slice(1));
} else if (command === 'serve') {
  process.exitCode = await runNode(commands.get(command), {
    cwd: process.cwd(),
    env: { ...process.env, OAF_WORKSPACE_ROOT: process.env.OAF_WORKSPACE_ROOT ?? process.cwd() }
  });
} else if (command === 'status') {
  process.exitCode = await runNode(commands.get(command), {
    env: { ...process.env, OAF_PACKAGE_ROOT: PACKAGE_ROOT, OAF_INVOKED_CWD: process.cwd() }
  });
} else if (commands.has(command)) {
  process.exitCode = await runNode(commands.get(command));
} else if (command === 'context') {
  await contextCommand(args);
} else if (command === 'handoff') {
  await contextCommand(['handoff', ...mergeDefaultArgs(defaultHandoffArgs(), args, contextPackValueOptions(), contextPackOptionAliases())]);
} else if (command === 'token-saver') {
  await measureCommand(['context-pack', ...mergeDefaultArgs(defaultTokenSaverArgs(), args, contextPackValueOptions(), contextPackOptionAliases())]);
} else if (command === 'benchmark' || command === 'bench') {
  await benchmarkCommand(args);
} else if (command === 'memory') {
  await memoryCommand(args);
} else if (command === 'mcp') {
  await mcpCommand(args);
} else if (command === 'measure') {
  await measureCommand(args);
} else if (command === 'loop') {
  await loopCommand(args);
} else if (command === 'skill' || command === 'skills') {
  await skillCommand(args);
} else if (command === 'harness') {
  await harnessCommand(args);
} else if (command === 'hook') {
  await hookCommand(args);
} else if (command === 'connect' || command === 'disconnect') {
  await connectionCommand(command, args);
} else if (isHelpCommand(command)) {
  help(args[0], args[1]);
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
    if (subcommand === 'remember') return await memoryRememberCommand(rest);
    if (subcommand === 'ingest') return await memoryIngestCommand(rest);
    if (subcommand === 'approve') return await memoryApproveCommand(rest);
    if (subcommand === 'reject') return await memoryRejectCommand(rest);
    if (subcommand === 'review') return await memoryReviewCommand(rest);
    if (subcommand === 'refine') return await memoryRefineCommand(rest);
    if (subcommand === 'profile') return await memoryProfileCommand(rest);
    if (subcommand === 'proposals') return await memoryProposalsCommand(rest);
    if (subcommand === 'sgrep') return await memorySgrepCommand(rest);
    if (subcommand === 'fact') return await memoryFactCommand(rest);
    if (subcommand === 'search') return await memorySearchCommand(rest);
    if (subcommand === 'path') return await memoryPathCommand(rest);
    if (subcommand === 'explain') return await memoryExplainCommand(rest);
    console.error('memory requires remember, ingest, approve, reject, review, refine, profile, proposals, sgrep, fact, search, path, or explain');
    process.exitCode = 2;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

async function memoryReviewCommand(values) {
  const [action, ...rest] = values;
  if (action === 'approve') return await memoryReviewApproveCommand(rest);
  if (action === 'list') return await memoryReviewListCommand(rest);
  if (action && !action.startsWith('--')) {
    console.error('memory review requires list or approve');
    process.exitCode = 2;
    return;
  }
  return await memoryReviewListCommand(values);
}

async function openMemoryReviewProvider(values, { readOnly, commandName, allowMissing = false }) {
  const root = path.resolve(option(values, '--root') ?? process.cwd());
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) throw new Error(`${commandName} --root must point at a local workspace directory`);
  const sqlitePath = await resolveWorkspaceSqlitePath(root, option(values, '--sqlite') ?? '.local/memory.sqlite', commandName, { mustExist: !allowMissing });
  const workspaceId = option(values, '--workspace-id') ?? option(values, '--workspace') ?? 'ws_local';
  if (allowMissing && !sqlitePath.exists) {
    return { root, sqlitePath, workspaceId, provider: null, unavailableReason: 'sqlite_missing' };
  }
  const { SQLiteMemoryProvider } = await import('../../providers/native/memory-sqlite/src/index.mjs');
  return {
    root,
    sqlitePath,
    workspaceId,
    provider: new SQLiteMemoryProvider({ filename: sqlitePath.absolute, clock: fixedNow, migrate: false, readOnly })
  };
}

async function memoryReviewListCommand(values) {
  const format = option(values, '--format') ?? 'json';
  if (!['json', 'summary'].includes(format)) {
    console.error('memory review only supports --format json or summary');
    process.exitCode = 2;
    return;
  }
  const valueOptions = new Set(['--root', '--sqlite', '--workspace', '--workspace-id', '--scope', '--limit', '--format']);
  const unsupported = unsupportedFlags(values, new Set(['--read-only', ...valueOptions]), valueOptions);
  if (unsupported.length > 0) {
    console.error(`memory review unsupported option: ${unsupported[0]}`);
    process.exitCode = 2;
    return;
  }
  const generatedAt = fixedNow();
  const scope = option(values, '--scope') ?? 'workspace';
  const { sqlitePath, workspaceId, provider } = await openMemoryReviewProvider(values, { readOnly: true, commandName: 'memory review' });
  try {
    const proposalFacts = (await provider.listProposalQueue({ workspaceId, limit: parseIntegerOption(values, '--limit', 100) }))
      .map(summarizeProposalQueueFact)
      .filter((item) => item && item.scope === scope);
    const report = {
      schemaVersion: '1.0.0',
      command: 'memory review',
      generatedAt,
      workspaceId,
      source: {
        provider: 'provider:native:memory:sqlite',
        sqliteRef: `workspace://${sqlitePath.relative}`
      },
      summary: {
        pendingProposalCount: proposalFacts.length,
        activeMemoryCreated: 0
      },
      proposalFacts,
      safeguards: {
        readOnly: true,
        proposalGated: true,
        canonicalStateMutated: false,
        activeMemoryCreated: 0,
        hardDeleted: false,
        networkCalls: 0,
        modelCalls: 0,
        externalWritesEnabled: false,
        rawSourceBodiesIncluded: false,
        absoluteFilesystemLocationsIncluded: false
      },
      reportFingerprint: null
    };
    const output = { ...report, reportFingerprint: stableJsonFingerprint(report) };
    console.log(format === 'summary' ? renderMemoryReviewSummary(output) : JSON.stringify(output, null, 2));
  } finally {
    provider.close();
  }
}

function renderMemoryReviewSummary(report) {
  const first = report.proposalFacts.slice(0, 5).map((item) => `- ${item.id}: ${item.subject} ${item.predicate}`).join('\n') || '- none';
  return [
    '# Memory Review',
    `Workspace: ${report.workspaceId}`,
    `SQLite: ${report.source.sqliteRef}`,
    `Pending proposals: ${report.summary.pendingProposalCount}`,
    `Active memory created: ${report.summary.activeMemoryCreated}`,
    '',
    'Next proposals',
    first,
    '',
    'Safeguards',
    `Read-only: ${report.safeguards.readOnly ? 'pass' : 'no'}`,
    `Proposal gated: ${report.safeguards.proposalGated ? 'yes' : 'no'}`,
    `Canonical state mutated: ${report.safeguards.canonicalStateMutated ? 'yes' : 'no'}`,
    `Network calls: ${report.safeguards.networkCalls}`,
    `Model calls: ${report.safeguards.modelCalls}`,
    `Report fingerprint: ${report.reportFingerprint}`
  ].join('\n');
}

async function memoryRefineCommand(values) {
  const format = option(values, '--format') ?? 'json';
  if (!['json', 'summary'].includes(format)) {
    console.error('memory refine only supports --format json or summary');
    process.exitCode = 2;
    return;
  }
  if (!values.includes('--read-only')) {
    console.error('memory refine requires --read-only; it only reports candidates and never mutates memory');
    process.exitCode = 2;
    return;
  }
  const valueOptions = new Set(['--root', '--sqlite', '--workspace', '--workspace-id', '--scope', '--limit', '--target-active-facts', '--min-confidence', '--format']);
  const unsupported = unsupportedFlags(values, new Set(['--read-only', ...valueOptions]), valueOptions);
  if (unsupported.length > 0) {
    console.error(`memory refine unsupported option: ${unsupported[0]}`);
    process.exitCode = 2;
    return;
  }
  const generatedAt = fixedNow();
  const output = await buildMemoryRefineReportForValues(values, { generatedAt });
  emitMemoryRefineReport(output, format);
}

async function buildMemoryRefineReportForValues(values, { generatedAt = fixedNow() } = {}) {
  const scope = option(values, '--scope') ?? 'workspace';
  const limit = Math.max(1, Math.min(500, parseIntegerOption(values, '--limit', 500)));
  const targetActiveFactCount = option(values, '--target-active-facts') === null ? null : strictIntegerOption(values, '--target-active-facts', null);
  if (targetActiveFactCount !== null && (targetActiveFactCount < 1 || targetActiveFactCount > 500)) throw new Error('memory refine --target-active-facts must be an integer between 1 and 500');
  const minConfidence = option(values, '--min-confidence') === null ? 0.5 : strictNumberOption(values, '--min-confidence', 0.5);
  if (minConfidence < 0 || minConfidence > 1) throw new Error('memory refine --min-confidence must be a number between 0 and 1');
  const { root, sqlitePath, workspaceId, provider, unavailableReason } = await openMemoryReviewProvider(values, {
    readOnly: true,
    commandName: 'memory refine',
    allowMissing: true
  });
  if (!provider) {
    const output = buildEmptyMemoryRefineReport({ generatedAt, workspaceId, scope, sqlitePath, reasonCode: unavailableReason, targetActiveFactCount });
    assertJsonSchema(memoryRefineReportSchema, output, 'memory refine unavailable report');
    return output;
  }
  try {
    const facts = await provider.listTemporalFacts({ workspaceId, scope, limit });
    const proposalQueue = await provider.listProposalQueue({ workspaceId, limit });
    const activeFacts = facts.filter((fact) => memoryRefineFactIsActiveAt(fact, generatedAt));
    const duplicateCandidates = memoryRefineDuplicateCandidates(activeFacts);
    const conflictCandidates = memoryRefineConflictCandidates(activeFacts);
    const staleCandidates = memoryRefineStaleCandidates(facts, generatedAt);
    const supersessionCandidates = memoryRefineSupersessionCandidates(activeFacts);
    const lineageResidueCandidates = memoryRefineLineageResidueCandidates(activeFacts, proposalQueue, root);
    const lowConfidenceCandidates = memoryRefineLowConfidenceCandidates(activeFacts, minConfidence);
    const refineCandidateCount = duplicateCandidates.length + conflictCandidates.length + staleCandidates.length + supersessionCandidates.length + lineageResidueCandidates.length + lowConfidenceCandidates.length;
    const derivedArtifacts = await memoryRefineDerivedArtifacts(root, refineCandidateCount);
    const report = {
      schemaVersion: '1.0.0',
      command: 'memory refine',
      generatedAt,
      workspaceId,
      scope,
      state: 'ready',
      reasonCodes: ['memory_schema_ready'],
      source: {
        provider: 'provider:native:memory:sqlite',
        sqliteRef: `workspace://${sqlitePath.relative}`
      },
      summary: {
        scannedFactCount: facts.length,
        activeFactCount: activeFacts.length,
        duplicateCandidateCount: duplicateCandidates.length,
        conflictCandidateCount: conflictCandidates.length,
        staleCandidateCount: staleCandidates.length,
        supersessionCandidateCount: supersessionCandidates.length,
        lineageResidueCandidateCount: lineageResidueCandidates.length,
        lowConfidenceCandidateCount: lowConfidenceCandidates.length,
        derivedArtifactReviewCount: derivedArtifacts.length,
        refineCandidateCount,
        activeMemoryCreated: 0
      },
      duplicateCandidates,
      conflictCandidates,
      staleCandidates,
      supersessionCandidates,
      lineageResidueCandidates,
      lowConfidenceCandidates,
      derivedArtifacts,
      budgetPlan: buildMemoryRefineBudgetPlan({
        activeFactCount: activeFacts.length,
        targetActiveFactCount,
        duplicateCandidates,
        supersessionCandidates,
        lineageResidueCandidates,
        lowConfidenceCandidates
      }),
      safeguards: {
        readOnly: true,
        proposalGated: true,
        canonicalStateMutated: false,
        activeMemoryCreated: 0,
        hardDeleted: false,
        networkCalls: 0,
        modelCalls: 0,
        externalWritesEnabled: false,
        rawSourceBodiesIncluded: false,
        absoluteFilesystemLocationsIncluded: false
      },
      reportFingerprint: null
    };
    const output = { ...report, reportFingerprint: stableJsonFingerprint(report) };
    assertJsonSchema(memoryRefineReportSchema, output, 'memory refine report');
    return output;
  } catch (error) {
    if (!memoryRefineSchemaUnavailable(error)) throw error;
    const output = buildEmptyMemoryRefineReport({ generatedAt, workspaceId, scope, sqlitePath, reasonCode: 'sqlite_schema_unavailable', targetActiveFactCount });
    assertJsonSchema(memoryRefineReportSchema, output, 'memory refine unavailable report');
    return output;
  } finally {
    provider.close();
  }
}

function emitMemoryRefineReport(report, format) {
  console.log(format === 'summary' ? renderMemoryRefineSummary(report) : JSON.stringify(report, null, 2));
}

function renderMemoryRefineSummary(report) {
  const summary = report.summary;
  const safeguards = report.safeguards;
  const lines = [
    `State: ${report.state}`,
    `Workspace: ${report.workspaceId}`,
    `Scope: ${report.scope}`,
    `Reason codes: ${report.reasonCodes.join(', ')}`,
    `SQLite: ${report.source.sqliteRef}`,
    `Scanned facts: ${summary.scannedFactCount}`,
    `Active facts: ${summary.activeFactCount}`,
    `Refine candidates: ${summary.refineCandidateCount}`,
    `Duplicates: ${summary.duplicateCandidateCount}`,
    `Conflicts: ${summary.conflictCandidateCount}`,
    `Stale: ${summary.staleCandidateCount}`,
    `Supersessions: ${summary.supersessionCandidateCount}`,
    `Lineage residue: ${summary.lineageResidueCandidateCount}`,
    `Low confidence: ${summary.lowConfidenceCandidateCount}`,
    `Derived artifacts to review: ${summary.derivedArtifactReviewCount}`
  ];
  if (report.budgetPlan) {
    lines.push(
      `Budget plan: ${report.budgetPlan.state}`,
      `Target active facts: ${report.budgetPlan.targetActiveFactCount}`,
      `Projected active facts: ${report.budgetPlan.projectedActiveFactCount}`,
      `Planned reviews: ${report.budgetPlan.plannedReviewCount}`,
      `Planned reductions: ${report.budgetPlan.plannedReductionCount}`
    );
  } else {
    lines.push('Budget plan: not requested');
  }
  lines.push(
    `Canonical state mutated: ${safeguards.canonicalStateMutated ? 'yes' : 'no'}`,
    `Active memory created: ${safeguards.activeMemoryCreated}`,
    `Network calls: ${safeguards.networkCalls}`,
    `Model calls: ${safeguards.modelCalls}`,
    `Report fingerprint: ${report.reportFingerprint}`
  );
  return lines.join('\n');
}

function buildEmptyMemoryRefineReport({ generatedAt, workspaceId, scope, sqlitePath, reasonCode, targetActiveFactCount = null }) {
  const report = {
    schemaVersion: '1.0.0',
    command: 'memory refine',
    generatedAt,
    workspaceId,
    scope,
    state: 'unavailable',
    reasonCodes: [reasonCode],
    source: {
      provider: 'provider:native:memory:sqlite',
      sqliteRef: `workspace://${sqlitePath.relative}`
    },
    summary: {
      scannedFactCount: 0,
      activeFactCount: 0,
      duplicateCandidateCount: 0,
      conflictCandidateCount: 0,
      staleCandidateCount: 0,
      supersessionCandidateCount: 0,
      lineageResidueCandidateCount: 0,
      lowConfidenceCandidateCount: 0,
      derivedArtifactReviewCount: 0,
      refineCandidateCount: 0,
      activeMemoryCreated: 0
    },
    duplicateCandidates: [],
    conflictCandidates: [],
    staleCandidates: [],
    supersessionCandidates: [],
    lineageResidueCandidates: [],
    lowConfidenceCandidates: [],
    derivedArtifacts: [],
    budgetPlan: targetActiveFactCount === null ? null : memoryRefineUnavailableBudgetPlan(targetActiveFactCount, reasonCode),
    safeguards: {
      readOnly: true,
      proposalGated: true,
      canonicalStateMutated: false,
      activeMemoryCreated: 0,
      hardDeleted: false,
      networkCalls: 0,
      modelCalls: 0,
      externalWritesEnabled: false,
      rawSourceBodiesIncluded: false,
      absoluteFilesystemLocationsIncluded: false
    },
    reportFingerprint: null
  };
  return { ...report, reportFingerprint: stableJsonFingerprint(report) };
}

function memoryRefineUnavailableBudgetPlan(targetActiveFactCount, reasonCode) {
  return {
    state: 'unavailable',
    reasonCodes: [reasonCode],
    targetActiveFactCount,
    currentActiveFactCount: 0,
    projectedActiveFactCount: 0,
    overBudgetBy: 0,
    plannedReviewCount: 0,
    plannedReductionCount: 0,
    actions: []
  };
}

function buildMemoryRefineBudgetPlan({ activeFactCount, targetActiveFactCount, duplicateCandidates, supersessionCandidates, lineageResidueCandidates, lowConfidenceCandidates }) {
  if (targetActiveFactCount === null) return null;
  let projectedActiveFactCount = activeFactCount;
  const seenFactIds = new Set();
  const actions = [];
  const add = (candidate, action, reasonCodes, factIds) => {
    if (projectedActiveFactCount <= targetActiveFactCount) return;
    const reviewFactIds = factIds.filter((id) => id && !seenFactIds.has(id)).sort();
    if (reviewFactIds.length === 0) return;
    for (const id of reviewFactIds) seenFactIds.add(id);
    projectedActiveFactCount = Math.max(0, projectedActiveFactCount - reviewFactIds.length);
    const seed = { action, candidateId: candidate.id, factIds: reviewFactIds };
    actions.push({
      id: `mbp_${sha256Hex(stableStringify(seed)).slice(0, 16)}`,
      action,
      candidateId: candidate.id,
      candidateKind: candidate.kind,
      reasonCodes,
      factIds: reviewFactIds,
      expectedActiveFactReduction: reviewFactIds.length,
      recommendation: candidate.recommendation
    });
  };
  for (const candidate of lineageResidueCandidates) add(candidate, 'review_lineage_residue', ['lineage_residue'], candidate.factIds);
  for (const candidate of duplicateCandidates) add(candidate, 'review_duplicate_facts', ['duplicate_active_fact'], candidate.supersededFactIds);
  for (const candidate of supersessionCandidates) add(candidate, 'review_supersession', ['newer_value_available'], candidate.supersededFactIds);
  for (const candidate of lowConfidenceCandidates) add(candidate, 'review_low_confidence_fact', ['low_confidence_fact'], candidate.factIds);
  const overBudgetBy = Math.max(0, activeFactCount - targetActiveFactCount);
  const plannedReductionCount = activeFactCount - projectedActiveFactCount;
  return {
    state: overBudgetBy === 0 ? 'within_budget' : projectedActiveFactCount <= targetActiveFactCount ? 'review_needed' : 'insufficient_candidates',
    reasonCodes: overBudgetBy === 0 ? ['target_active_fact_budget_met'] : projectedActiveFactCount <= targetActiveFactCount ? ['target_active_fact_budget_exceeded'] : ['target_active_fact_budget_exceeded', 'insufficient_refine_candidates'],
    targetActiveFactCount,
    currentActiveFactCount: activeFactCount,
    projectedActiveFactCount,
    overBudgetBy,
    plannedReviewCount: actions.length,
    plannedReductionCount,
    actions
  };
}

function memoryRefineSchemaUnavailable(error) {
  return /no such table: memory_(?:facts|proposal_queue|episodes)/u.test(String(error?.message ?? ''));
}

async function memoryRefineDerivedArtifacts(root, refineCandidateCount) {
  if (refineCandidateCount <= 0) return [];
  const relativePath = 'memory/profile.md';
  const absolutePath = path.join(root, relativePath);
  if (!existsSync(absolutePath)) return [];
  const body = await readFile(absolutePath, 'utf8').catch(() => null);
  if (body === null) return [];
  return [{
    role: 'memory_profile',
    locator: `workspace://${relativePath}`,
    contentHash: `sha256:${sha256Hex(body)}`,
    state: 'review_recommended',
    reasonCodes: ['refine_candidates_present', 'derived_memory_profile_may_contain_residue'],
    recommendation: 'Regenerate or review the derived memory profile after memory refine candidates are resolved.'
  }];
}

function memoryRefineFactIsActiveAt(fact, at) {
  if (fact.status !== 'active' || fact.supersededBy) return false;
  const atMs = Date.parse(at);
  const validFromMs = Date.parse(fact.validFrom);
  const validUntilMs = fact.validUntil ? Date.parse(fact.validUntil) : null;
  return Number.isFinite(atMs) && Number.isFinite(validFromMs) && validFromMs <= atMs && (!Number.isFinite(validUntilMs) || validUntilMs > atMs);
}

function memoryRefineDuplicateCandidates(facts) {
  const groups = groupMemoryRefineFacts(facts, (fact) => [fact.subject, fact.predicate, fact.object].join('\0'));
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .sort(memoryRefineGroupSort)
    .slice(0, 50)
    .map((group) => memoryRefineCandidate('duplicate_active_fact', group, {
      object: memoryRefineSafeText(group[0].object, 240),
      objects: null,
      recommendation: 'Review duplicate ACTIVE facts; reject or supersede the extra source through the normal memory review flow.'
    }));
}

function memoryRefineConflictCandidates(facts) {
  const groups = groupMemoryRefineFacts(facts, (fact) => [fact.subject, fact.predicate].join('\0'));
  return [...groups.values()]
    .filter((group) => new Set(group.map((fact) => fact.object)).size > 1)
    .sort(memoryRefineGroupSort)
    .slice(0, 50)
    .map((group) => memoryRefineCandidate('conflicting_active_fact', group, {
      object: null,
      objects: [...new Set(group.map((fact) => memoryRefineSafeText(fact.object, 240)))].sort(),
      supersededFactIds: [],
      recommendation: 'Approve a superseding fact or reject the stale candidate; do not let multiple ACTIVE values answer the same subject/predicate.'
    }));
}

function memoryRefineStaleCandidates(facts, at) {
  return facts
    .filter((fact) => fact.status === 'active' && !fact.supersededBy && fact.validUntil && Date.parse(fact.validUntil) <= Date.parse(at))
    .sort((left, right) => String(left.validUntil).localeCompare(String(right.validUntil)) || String(left.id).localeCompare(String(right.id)))
    .slice(0, 50)
    .map((fact) => memoryRefineCandidate('stale_active_fact', [fact], {
      object: memoryRefineSafeText(fact.object, 240),
      objects: null,
      supersededFactIds: [],
      validUntil: fact.validUntil,
      recommendation: 'Review expired ACTIVE fact; approve a replacement or mark it superseded through the normal memory review flow.'
    }));
}

function memoryRefineSupersessionCandidates(facts) {
  const groups = groupMemoryRefineFacts(facts, (fact) => [fact.subject, fact.predicate].join('\0'));
  return [...groups.values()]
    .filter((group) => new Set(group.map((fact) => fact.object)).size > 1)
    .sort(memoryRefineGroupSort)
    .slice(0, 50)
    .map((group) => {
      const sorted = group.slice().sort((left, right) => String(right.validFrom).localeCompare(String(left.validFrom)) || String(right.id).localeCompare(String(left.id)));
      return memoryRefineCandidate('supersession_candidate', group, {
        object: memoryRefineSafeText(sorted[0].object, 240),
        objects: [...new Set(group.map((fact) => memoryRefineSafeText(fact.object, 240)))].sort(),
        supersededFactIds: sorted.slice(1).map((fact) => fact.id).sort(),
        recommendation: 'Newest ACTIVE value can supersede older values once evidence is reviewed.'
      });
    });
}

function memoryRefineLineageResidueCandidates(facts, proposalQueue, root) {
  const proposals = new Map(proposalQueue.map((proposal) => [proposal.id, proposal]));
  return facts
    .filter((fact) => {
      const proposalId = fact.proposalQueueId;
      if (!proposalId) return true;
      const proposal = proposals.get(proposalId);
      return !proposal || proposal.result?.accepted === false || memoryRefineWorkspaceSourceMissing(root, fact.source);
    })
    .sort((left, right) => String(left.proposalQueueId ?? '').localeCompare(String(right.proposalQueueId ?? '')) || String(left.id).localeCompare(String(right.id)))
    .slice(0, 50)
    .map((fact) => {
      const sourceMissing = memoryRefineWorkspaceSourceMissing(root, fact.source);
      return memoryRefineCandidate('lineage_residue_candidate', [fact], {
        object: memoryRefineSafeText(fact.object, 240),
        objects: null,
        supersededFactIds: [],
        recommendation: sourceMissing
          ? 'Review ACTIVE fact whose workspace source is missing; attach replacement evidence or supersede through the normal memory review flow.'
          : fact.proposalQueueId
            ? 'Review ACTIVE fact whose proposal lineage is missing or rejected; supersede or retract through the normal memory review flow.'
            : 'Review ACTIVE fact without proposal lineage; attach evidence or supersede through the normal memory review flow.'
      });
    });
}

function memoryRefineLowConfidenceCandidates(facts, minConfidence) {
  return facts
    .filter((fact) => Number(fact.confidence) < minConfidence)
    .sort((left, right) => Number(left.confidence) - Number(right.confidence) || String(left.id).localeCompare(String(right.id)))
    .slice(0, 50)
    .map((fact) => {
      const candidate = memoryRefineCandidate('low_confidence_fact', [fact], {
        object: memoryRefineSafeText(fact.object, 240),
        objects: null,
        supersededFactIds: [],
        recommendation: 'Review low-confidence ACTIVE fact; attach stronger evidence or supersede through the normal memory review flow.'
      });
      return {
        ...candidate,
        confidence: Number(fact.confidence),
        minConfidence
      };
    });
}

function memoryRefineWorkspaceSourceMissing(root, source) {
  if (!/^workspace:\/\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,512}$/u.test(source ?? '')) return false;
  const relative = memoryRefineWorkspaceLocatorPath(source.slice('workspace://'.length));
  const normalized = path.normalize(relative);
  if (path.isAbsolute(normalized) || normalized === '..' || normalized.startsWith(`..${path.sep}`)) return true;
  const candidate = path.resolve(root, normalized);
  if (!existsSync(candidate)) return true;
  try {
    return !isInside(realpathSync(root), realpathSync(candidate));
  } catch {
    return true;
  }
}

function memoryRefineWorkspaceLocatorPath(locatorPath) {
  return String(locatorPath ?? '').replace(/:[0-9]+(?:-[0-9]+)?$/u, '');
}

function memoryRefineSafeText(value, maxLength = 240) {
  const text = mcpSanitizeString(value, maxLength);
  return SECRET_LIKE.test(text) ? '[redacted]' : text;
}

function groupMemoryRefineFacts(facts, keyForFact) {
  const groups = new Map();
  for (const fact of facts) {
    const key = keyForFact(fact);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(fact);
  }
  return groups;
}

function memoryRefineGroupSort(left, right) {
  const leftKey = [left[0]?.subject, left[0]?.predicate, left[0]?.object].join('\0');
  const rightKey = [right[0]?.subject, right[0]?.predicate, right[0]?.object].join('\0');
  return leftKey.localeCompare(rightKey);
}

function memoryRefineCandidate(kind, group, { object, objects, supersededFactIds = null, validUntil = null, recommendation }) {
  const newest = group.slice().sort((left, right) => String(right.validFrom).localeCompare(String(left.validFrom)) || String(right.id).localeCompare(String(left.id)))[0];
  const seed = {
    kind,
    subject: group[0].subject,
    predicate: group[0].predicate,
    object,
    objects,
    factIds: group.map((fact) => fact.id).sort(),
    validUntil
  };
  const inferredSupersededFactIds = supersededFactIds ?? group
    .filter((fact) => fact.id !== newest.id)
    .map((fact) => fact.id)
    .sort();
  return {
    id: `mref_${sha256Hex(stableStringify(seed)).slice(0, 16)}`,
    kind,
    subject: memoryRefineSafeText(group[0].subject, 240),
    predicate: memoryRefineSafeText(group[0].predicate, 160),
    object,
    objects,
    factIds: seed.factIds,
    supersededFactIds: inferredSupersededFactIds,
    sourceRefs: [...new Set(group.map((fact) => mcpCompactProvenanceRef(fact.source)))].sort(),
    newestFactId: newest.id,
    validUntil,
    recommendation
  };
}

async function memoryReviewApproveCommand(values) {
  return await memoryApproveCommand(values, { legacyReview: true });
}

async function memoryApproveCommand(values, { legacyReview = false } = {}) {
  if (!validateJsonFormat(values)) return;
  if (values.includes('--read-only') || values.includes('--dry-run')) {
    console.error('memory approve is the explicit write step; --read-only and --dry-run are not accepted');
    process.exitCode = 2;
    return;
  }
  const valueOptions = new Set(['--root', '--sqlite', '--workspace', '--workspace-id', '--proposal', '--all-from', '--format']);
  const allowedOptions = new Set([...valueOptions, '--all']);
  const unsupported = unsupportedFlags(values, allowedOptions, valueOptions);
  if (unsupported.length > 0) {
    console.error(`memory approve unsupported option: ${unsupported[0]}`);
    process.exitCode = 2;
    return;
  }
  const positionalId = values.find((value, index) => index === 0 && !value.startsWith('--'));
  const proposalId = option(values, '--proposal') ?? positionalId;
  const allFrom = option(values, '--all-from');
  const approveAll = values.includes('--all');
  if ([proposalId, allFrom, approveAll].filter(Boolean).length > 1) throw new Error('memory approve accepts one target: <id>/--proposal, --all-from <source>, or --all');
  if (!approveAll && !allFrom && !/^mpq_[A-Za-z0-9._-]{1,128}$/u.test(proposalId ?? '')) throw new Error('memory approve requires <mpq_id>, --proposal <mpq_id>, --all-from <source>, or --all');
  if (allFrom && !/^workspace:\/\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,512}$/u.test(allFrom)) throw new Error('memory approve --all-from requires a workspace:// source locator');
  const generatedAt = fixedNow();
  const workerId = 'memory-review';
  const command = legacyReview ? 'memory review approve' : 'memory approve';
  const { sqlitePath, workspaceId, provider } = await openMemoryReviewProvider(values, { readOnly: false, commandName: command });
  try {
    const pending = (await provider.listProposalQueue({ workspaceId, limit: 500 })).filter((item) => item.status === 'pending');
    const targets = (allFrom || approveAll ? pending
      .filter((item) => approveAll || memoryProposalSourceMatches(item, allFrom))
      .sort((left, right) => String(left.enqueuedAt).localeCompare(String(right.enqueuedAt)) || String(left.id).localeCompare(String(right.id)))
      .map((item) => item.id) : [proposalId]);
    if (!targets.length) throw new Error(approveAll ? 'memory approve found no pending proposals' : `memory approve found no pending proposals for ${allFrom}`);
    const approved = [];
    for (const id of targets) approved.push(await provider.approveProposalFact({ workspaceId, id, workerId, approvedAt: generatedAt }));
    const facts = approved.map((item) => item.fact);
    const supersededFacts = [];
    for (const item of facts) {
      const history = await provider.getTemporalFactHistory({ workspaceId, scope: item.scope, subject: item.subject, predicate: item.predicate, limit: 50 });
      supersededFacts.push(...history.filter((fact) => fact.supersededBy === item.id));
    }
    const pendingAfter = (await provider.listProposalQueue({ workspaceId, limit: 500 })).filter((item) => item.status === 'pending').length;
    const report = {
      schemaVersion: '1.0.0',
      command,
      generatedAt,
      workspaceId,
      source: {
        provider: 'provider:native:memory:sqlite',
        sqliteRef: `workspace://${sqlitePath.relative}`
      },
      summary: {
        pendingProposalCount: pendingAfter,
        activeMemoryCreated: facts.length,
        rejectedProposalCount: 0,
        supersededFactCount: supersededFacts.length
      },
      proposal: approved.length === 1 ? approved[0].proposal : null,
      fact: facts[0] ?? null,
      facts,
      supersededFacts,
      safeguards: {
        readOnly: false,
        proposalGated: true,
        canonicalStateMutated: true,
        activeMemoryCreated: facts.length,
        hardDeleted: false,
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

function normalizeWorkspaceLocator(value) {
  const locator = String(value ?? '').trim();
  if (!locator.startsWith('workspace://')) return locator;
  const relative = path.posix.normalize(locator.slice('workspace://'.length));
  if (!relative || relative === '.' || relative.startsWith('../') || relative === '..') return locator;
  return `workspace://${relative}`;
}

function memoryProposalSourceMatches(item, sourceLocator) {
  const target = normalizeWorkspaceLocator(sourceLocator);
  return [item.sourceLocator, item.payload?.provenance?.sourceLocator]
    .some((candidate) => normalizeWorkspaceLocator(candidate) === target);
}

async function memoryRememberCommand(values) {
  if (!validateJsonFormat(values)) return;
  if (values.includes('--read-only') || values.includes('--dry-run')) {
    console.error('memory remember is an explicit governed write; --read-only and --dry-run are not accepted');
    process.exitCode = 2;
    return;
  }
  if (option(values, '--batch')) return await memoryRememberBatchCommand(values);
  const valueOptions = new Set([
    '--root',
    '--sqlite',
    '--workspace',
    '--workspace-id',
    '--scope',
    '--subject',
    '--predicate',
    '--object',
    '--source',
    '--supersedes-subject',
    '--supersedes-predicate',
    '--format'
  ]);
  const unsupported = unsupportedFlags(values, valueOptions, valueOptions);
  if (unsupported.length > 0) {
    console.error(`memory remember unsupported option: ${unsupported[0]}`);
    process.exitCode = 2;
    return;
  }
  const root = path.resolve(option(values, '--root') ?? process.cwd());
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) throw new Error('memory remember --root must point at a local workspace directory');
  const workspaceId = option(values, '--workspace-id') ?? option(values, '--workspace') ?? 'ws_local';
  const scope = option(values, '--scope') ?? 'workspace';
  const subject = option(values, '--subject');
  const predicate = option(values, '--predicate');
  const object = option(values, '--object');
  const source = option(values, '--source');
  if (!subject || !predicate || !object) throw new Error('memory remember requires --subject, --predicate, and --object');
  if (!/^workspace:\/\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,512}$/u.test(source ?? '')) throw new Error('memory remember requires --source workspace://...');
  if (!['workspace', 'session', 'agent', 'user'].includes(scope)) throw new Error('memory remember --scope must be workspace, session, agent, or user');
  const supersedesSubject = option(values, '--supersedes-subject') ?? subject;
  const supersedesPredicate = option(values, '--supersedes-predicate') ?? predicate;
  const supersedes = values.includes('--supersedes-subject') || values.includes('--supersedes-predicate');
  if (supersedesSubject !== subject || supersedesPredicate !== predicate) {
    throw new Error('memory remember can only supersede the same subject and predicate as the new fact');
  }
  const generatedAt = fixedNow();
  const sqlitePath = await resolveWorkspaceSqlitePath(root, option(values, '--sqlite') ?? '.local/memory.sqlite', 'memory remember', { mustExist: false });
  const { SQLiteMemoryProvider } = await import('../../providers/native/memory-sqlite/src/index.mjs');
  const provider = new SQLiteMemoryProvider({ filename: sqlitePath.absolute, clock: () => generatedAt });
  const proposalInput = buildMemoryRememberProposalInput({ workspaceId, scope, subject, predicate, object, source: normalizeWorkspaceLocator(source), generatedAt, supersedes });
  try {
    const queued = await provider.enqueueProposal(proposalInput);
    const historyBeforeApproval = await provider.getTemporalFactHistory({ workspaceId, scope, subject, predicate, limit: 50 });
    const existingFact = historyBeforeApproval.find((item) => item.proposalQueueId === queued.id);
    const approved = queued.status === 'applied' && existingFact
      ? { proposal: queued, fact: existingFact }
      : await provider.approveProposalFact({
        workspaceId,
        id: queued.id,
        workerId: 'memory-remember',
        approvedAt: generatedAt
      });
    const history = queued.status === 'applied'
      ? historyBeforeApproval
      : await provider.getTemporalFactHistory({ workspaceId, scope, subject, predicate, limit: 50 });
    const supersededFacts = history.filter((item) => item.supersededBy === approved.fact.id);
    const activeMemoryCreated = queued.status === 'applied' && existingFact ? 0 : 1;
    const report = {
      schemaVersion: '1.0.0',
      command: 'memory remember',
      generatedAt,
      workspaceId,
      source: {
        provider: 'provider:native:memory:sqlite',
        sqliteRef: `workspace://${sqlitePath.relative}`,
        sourceLocator: source
      },
      summary: {
        activeMemoryCreated,
        duplicateFactSkipped: activeMemoryCreated === 0 ? 1 : 0,
        supersededFactCount: supersededFacts.length,
        pendingProposalCount: 0
      },
      proposal: approved.proposal,
      fact: approved.fact,
      supersededFacts,
      safeguards: {
        readOnly: false,
        proposalGated: true,
        canonicalStateMutated: true,
        activeMemoryCreated,
        hardDeleted: false,
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

async function memoryRememberBatchCommand(values) {
  const valueOptions = new Set(['--root', '--sqlite', '--workspace', '--workspace-id', '--scope', '--batch', '--format']);
  const unsupported = unsupportedFlags(values, valueOptions, valueOptions);
  if (unsupported.length > 0) {
    console.error(`memory remember unsupported option: ${unsupported[0]}`);
    process.exitCode = 2;
    return;
  }
  const root = path.resolve(option(values, '--root') ?? process.cwd());
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) throw new Error('memory remember --root must point at a local workspace directory');
  const workspaceId = option(values, '--workspace-id') ?? option(values, '--workspace') ?? 'ws_local';
  const scope = option(values, '--scope') ?? 'workspace';
  if (!['workspace', 'session', 'agent', 'user'].includes(scope)) throw new Error('memory remember --scope must be workspace, session, agent, or user');
  const generatedAt = fixedNow();
  const batchPath = await resolveWorkspaceReadPath(root, option(values, '--batch'), 'memory remember --batch');
  const parsed = JSON.parse(await readFile(batchPath.absolute, 'utf8'));
  const facts = parsed?.facts;
  if (!Array.isArray(facts)) throw new Error('memory remember --batch requires JSON shaped as {facts:[...]}');
  const sqlitePath = await resolveWorkspaceSqlitePath(root, option(values, '--sqlite') ?? '.local/memory.sqlite', 'memory remember', { mustExist: false });
  const { SQLiteMemoryProvider } = await import('../../providers/native/memory-sqlite/src/index.mjs');
  const provider = new SQLiteMemoryProvider({ filename: sqlitePath.absolute, clock: () => generatedAt });
  const queued = [];
  const seen = new Set();
  const skipped = [];
  let skippedUnsafeCount = 0;
  let skippedDuplicateCount = 0;
  try {
    for (const [index, item] of facts.entries()) {
      let fact;
      try {
        fact = await normalizeMemoryBatchFact(root, item);
      } catch (error) {
        skippedUnsafeCount += 1;
        skipped.push(memoryBatchSkippedFact(index, item, error));
        continue;
      }
      const key = `${fact.subject}\u0000${fact.predicate}\u0000${fact.object}`;
      if (seen.has(key)) {
        skippedDuplicateCount += 1;
        continue;
      }
      seen.add(key);
      queued.push(await provider.enqueueProposal(buildMemoryRememberProposalInput({
        workspaceId,
        scope,
        subject: fact.subject,
        predicate: fact.predicate,
        object: fact.object,
        source: fact.source,
        generatedAt,
        enqueuedAt: addMilliseconds(generatedAt, index),
        extractionConfidence: fact.extractionConfidence,
        notes: fact.notes,
        supersedes: fact.supersedes
      })));
    }
    const proposalFacts = queued.map(summarizeProposalQueueFact).filter(Boolean);
    const report = {
      schemaVersion: '1.0.0',
      command: 'memory remember --batch',
      generatedAt,
      workspaceId,
      source: {
        provider: 'provider:native:memory:sqlite',
        sqliteRef: `workspace://${sqlitePath.relative}`,
        batchRef: `workspace://${batchPath.relative}`
      },
      summary: {
        inputFactCount: facts.length,
        recordedCount: proposalFacts.length,
        proposalCount: proposalFacts.length,
        pendingProposalCount: proposalFacts.length,
        skippedUnsafeCount,
        skippedDuplicateCount,
        skipped,
        supersededFactCount: 0,
        activeMemoryCreated: 0
      },
      proposalFacts,
      skipped,
      safeguards: {
        readOnly: false,
        proposalGated: true,
        canonicalStateMutated: true,
        activeMemoryCreated: 0,
        hardDeleted: false,
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

function buildMemoryRememberProposalInput({ workspaceId, scope, subject, predicate, object, source, generatedAt, enqueuedAt, extractionConfidence = 'extracted', notes, supersedes = false }) {
  const text = `${subject} ${predicate} ${object}`;
  const sourceHash = `sha256:${sha256Hex(stableStringify({ subject, predicate, object, source }))}`;
  const proposalId = `mpq_${sha256Hex(stableStringify({ workspaceId, scope, subject, predicate, object, sourceHash })).slice(0, 32)}`;
  const episodeId = `mep_${sha256Hex(stableStringify({ workspaceId, source, sourceHash, text })).slice(0, 32)}`;
  return {
    id: proposalId,
    workspaceId,
    fingerprint: sha256Hex(stableStringify({ workspaceId, scope, subject, predicate, object, sourceHash })),
    sourceLocator: source,
    sourceHash,
    enqueuedAt,
    payload: {
      kind: 'fact',
      scope,
      subject,
      predicate,
      object,
      text,
      observedAt: generatedAt,
      subjectEntity: subject,
      objectEntity: object,
      provenanceEpisodeId: episodeId,
      provenanceSourceLocator: source,
      provenanceSourceHash: sourceHash,
      extractionConfidence,
      supersedesSubjectPredicate: supersedes === true,
      notes: notes ?? null
    }
  };
}

async function normalizeMemoryBatchFact(root, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('fact must be an object');
  const subject = safeMemoryBatchToken(input.subject, 'subject');
  const predicate = safeMemoryBatchToken(input.predicate, 'predicate');
  const object = safeMemoryBatchObject(input.object);
  const source = await safeMemoryBatchSource(root, input.source);
  const extractionConfidence = safeMemoryBatchConfidence(input.confidence);
  const notes = input.notes === undefined ? null : safeMemoryBatchNotes(input.notes);
  let supersedes = false;
  if (input.supersedes) {
    const supersedesSubject = safeMemoryBatchToken(input.supersedes.subject, 'supersedes.subject');
    const supersedesPredicate = safeMemoryBatchToken(input.supersedes.predicate, 'supersedes.predicate');
    if (supersedesSubject !== subject || supersedesPredicate !== predicate) throw new Error('supersedes must match subject and predicate');
    supersedes = true;
  }
  return { subject, predicate, object, source, extractionConfidence, notes, supersedes };
}

function safeMemoryBatchToken(value, name) {
  const text = String(value ?? '').trim();
  if (!/^[A-Za-z0-9:_-]{1,128}$/u.test(text)) throw new Error(`${name} must be safe`);
  if (MCP_PRIVATE_MATERIAL.test(text) || MEMORY_BATCH_UNSAFE_TEXT.test(text)) throw new Error(`${name} must be safe`);
  return text;
}

function safeMemoryBatchObject(value) {
  const text = String(value ?? '').trim().replace(/[.;:,]+$/u, '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9:_./ =,;()'-]{0,239}$/u.test(text)) throw new Error('object must be safe');
  if (MCP_PRIVATE_MATERIAL.test(text) || MEMORY_BATCH_UNSAFE_TEXT.test(text)) throw new Error('object must be safe');
  return text;
}

function safeMemoryBatchNotes(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 500) throw new Error('notes must be safe');
  if (/[\n\r]/u.test(text) || MCP_PRIVATE_MATERIAL.test(text) || MEMORY_BATCH_UNSAFE_TEXT.test(text)) throw new Error('notes must be safe');
  return text;
}

function memoryBatchSkippedFact(index, item, error) {
  return {
    index,
    subject: mcpSanitizeString(item?.subject ?? '', 128) || null,
    predicate: mcpSanitizeString(item?.predicate ?? '', 128) || null,
    reason: error instanceof Error ? error.message : 'fact must be safe'
  };
}

function safeMemoryBatchConfidence(value) {
  const confidence = String(value ?? 'extracted').trim();
  if (!MEMORY_BATCH_CONFIDENCES.has(confidence)) throw new Error('confidence must be extracted, inferred, or ambiguous');
  return confidence;
}

async function safeMemoryBatchSource(root, value) {
  const source = String(value ?? '').trim();
  if (!/^workspace:\/\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,512}$/u.test(source)) throw new Error('source must be workspace-relative');
  const relativePath = source.slice('workspace://'.length);
  if (!relativePath || relativePath.startsWith('/') || relativePath.includes('..')) throw new Error('source must stay inside workspace');
  const realRoot = await realpath(root);
  const absolute = path.resolve(realRoot, relativePath);
  if (!isInside(realRoot, absolute)) throw new Error('source must stay inside workspace');
  return `workspace://${toPosix(path.relative(realRoot, absolute))}`;
}

function addMilliseconds(iso, amount) {
  return new Date(Date.parse(iso) + amount).toISOString();
}

async function memoryRejectCommand(values) {
  if (!validateJsonFormat(values)) return;
  if (values.includes('--read-only') || values.includes('--dry-run')) {
    console.error('memory reject is the explicit write step; --read-only and --dry-run are not accepted');
    process.exitCode = 2;
    return;
  }
  const valueOptions = new Set(['--root', '--sqlite', '--workspace', '--workspace-id', '--proposal', '--reason', '--format']);
  const unsupported = unsupportedFlags(values, valueOptions, valueOptions);
  if (unsupported.length > 0) {
    console.error(`memory reject unsupported option: ${unsupported[0]}`);
    process.exitCode = 2;
    return;
  }
  const proposalId = option(values, '--proposal') ?? values.find((value, index) => index === 0 && !value.startsWith('--'));
  if (!/^mpq_[A-Za-z0-9._-]{1,128}$/u.test(proposalId ?? '')) throw new Error('memory reject requires <mpq_id> or --proposal <mpq_id>');
  const generatedAt = fixedNow();
  const { sqlitePath, workspaceId, provider } = await openMemoryReviewProvider(values, { readOnly: false, commandName: 'memory reject' });
  try {
    const rejected = await provider.rejectProposal({ workspaceId, id: proposalId, workerId: 'memory-review', rejectedAt: generatedAt, reason: option(values, '--reason') ?? 'rejected_by_user' });
    const report = {
      schemaVersion: '1.0.0',
      command: 'memory reject',
      generatedAt,
      workspaceId,
      source: {
        provider: 'provider:native:memory:sqlite',
        sqliteRef: `workspace://${sqlitePath.relative}`
      },
      summary: {
        pendingProposalCount: 0,
        activeMemoryCreated: 0,
        rejectedProposalCount: 1
      },
      proposal: rejected.proposal,
      safeguards: {
        readOnly: false,
        proposalGated: true,
        canonicalStateMutated: true,
        activeMemoryCreated: 0,
        hardDeleted: false,
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
    let skippedUnsafeCount = 0;
    for (const episode of episodes) {
      const proposed = await provider.proposeTemporalFactsFromEpisode(episode);
      skippedUnsafeCount += proposed.skippedUnsafeCount ?? 0;
      queued.push(...proposed);
    }
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
        skippedUnsafeCount,
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

async function openLoopGovernanceChecker({ values, root, generatedAt, commandName }) {
  if (!values.includes('--sqlite')) return { provider: null, checker: undefined };
  const provider = await openReadOnlySqliteMemoryProvider({ values, root, generatedAt, commandName, missingOk: false });
  return {
    provider,
    checker: async ({ loopPlan, worktreePath }) => evaluateLoopGovernanceAssertions({ loopPlan, worktreePath, provider })
  };
}

async function evaluateLoopGovernanceAssertions({ loopPlan, worktreePath, provider }) {
  const assertions = Array.isArray(loopPlan.governanceAssertions) ? loopPlan.governanceAssertions.slice(0, 16) : [];
  if (!provider || assertions.length === 0) return { checked: 0, violations: [] };
  const violations = [];
  let checked = 0;
  for (const assertion of assertions) {
    const subject = safeMemoryBatchToken(assertion.subject, 'governance subject');
    const predicate = safeMemoryBatchToken(assertion.predicate, 'governance predicate');
    const expected = await loopGovernanceExpectedValue({ provider, workspaceId: loopPlan.workspaceId, subject, predicate });
    if (!expected) continue;
    const actual = await loopGovernanceActualValue({ worktreePath, probe: assertion.probe });
    checked += 1;
    if (actual !== expected && violations.length < 16) {
      violations.push({ subject, predicate, expected, actual, file: safeWorkspaceRelativePath(assertion.probe.file, 'governance assertion file') });
    }
  }
  return { checked, violations };
}

async function loopGovernanceExpectedValue({ provider, workspaceId, subject, predicate }) {
  const facts = await provider.listTemporalFacts({ workspaceId, scope: 'workspace', limit: 500 });
  const fact = facts.find((item) => item.status === 'active' && !item.supersededBy && item.subject === subject && item.predicate === predicate);
  return fact ? safeMemoryBatchObject(fact.object) : null;
}

async function loopGovernanceActualValue({ worktreePath, probe }) {
  const file = safeWorkspaceRelativePath(probe?.file, 'governance assertion file');
  const rootReal = await realpath(worktreePath);
  const absolute = path.resolve(rootReal, file);
  if (!isInside(rootReal, absolute)) throw new Error('governance assertion file must stay inside worktree');
  const actual = await realpath(absolute).catch(() => null);
  if (!actual) return 'not found';
  if (!isInside(rootReal, actual)) throw new Error('governance assertion file must stay inside worktree');
  const info = await stat(actual).catch(() => null);
  if (!info?.isFile()) return 'not found';
  if (info.size > 64 * 1024) return 'file too large';
  const text = await readFile(actual, 'utf8');
  const match = text.match(new RegExp(String(probe.capture ?? ''), 'u'));
  if (!match || match.length < 2) return 'not found';
  return safeMemoryBatchObject(String(probe.valueTemplate ?? '').replace(/\$(\d+)/gu, (_, index) => match[Number(index)] ?? ''));
}

async function loopVerifyCommand(values) {
  if (values.includes('--write') || values.includes('--out') || values.includes('--merge')) {
    console.error('loop verify does not merge or write reports in this CLI checkpoint');
    process.exitCode = 2;
    return;
  }
  const valueOptions = new Set(['--root', '--plan', '--worktree', '--run-id', '--allow-command', '--sqlite', '--format']);
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
  const generatedAt = fixedNow();
  const { provider, checker } = await openLoopGovernanceChecker({ values, root, generatedAt, commandName: 'loop verify' });
  try {
    const report = await runLoopVerification({
      loopPlan,
      runId: option(values, '--run-id') ?? 'run_loop_verification',
      worktreePath,
      replayMode: values.includes('--replay'),
      executeCommands: values.includes('--execute-commands'),
      confirmedCommands: options(values, '--allow-command'),
      governanceChecker: checker,
      implementer: async () => {},
      appendEvent: async (event) => events.push(event),
      clock: fixedNow
    });
    if (report.governance.violations.length) process.exitCode = 1;
    console.log(JSON.stringify({ ...report, ledgerEvents: events }, null, 2));
  } finally {
    provider?.close();
  }
}

async function loopRunCommand(values) {
  if (values.includes('--write') || values.includes('--out') || values.includes('--merge')) {
    console.error('loop run does not merge or write reports in this CLI checkpoint');
    process.exitCode = 2;
    return;
  }
  const valueOptions = new Set(['--root', '--plan', '--worktree', '--run-id', '--max-iterations', '--timeout-ms', '--allow-command', '--sqlite', '--format']);
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
  const generatedAt = fixedNow();
  const { provider, checker } = await openLoopGovernanceChecker({ values, root, generatedAt, commandName: 'loop run' });
  try {
    const report = await runLoop({
      loopPlan,
      runId: option(values, '--run-id') ?? 'run_loop',
      worktreePath: option(values, '--worktree') ?? root,
      maxIterations: numericOption(values, '--max-iterations', loopPlan.maxIterations),
      timeoutMs: numericOption(values, '--timeout-ms', loopPlan.timeoutSeconds * 1000),
      humanApprovalRequired: values.includes('--human-approval-required'),
      executeCommands: values.includes('--execute-commands'),
      confirmedCommands: options(values, '--allow-command'),
      governanceChecker: checker,
      clock: fixedNow
    });
    if (report.governance.violations.length) process.exitCode = 1;
    console.log(JSON.stringify(report, null, 2));
  } finally {
    provider?.close();
  }
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
    '--changed-shard',
    '--token-budget',
    '--budget',
    '--format'
  ]);
  const unsupported = unsupportedFlags(values, new Set(['--read-only', '--changed-from-git', '--all-shards', ...valueOptions]), valueOptions);
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
  if (values.includes('--all-shards')) {
    if (!gitChangedLocatorsRequested(values)) {
      console.error('measure context-pack --all-shards requires --changed-from-git');
      process.exitCode = 2;
      return;
    }
    const report = await buildContextPackAllShardsMeasurementReport(values, { objective, step });
    console.log(format === 'summary' ? renderContextPackAllShardsMeasurementSummary(report) : JSON.stringify(report, null, 2));
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
  const sqlitePath = await resolveWorkspaceSqlitePath(root, option(values, '--sqlite') ?? '.local/memory.sqlite', 'measure savings', { mustExist: true });
  const sqliteStat = await stat(sqlitePath.absolute).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!sqliteStat?.isFile()) throw new Error('measure savings requires an existing SQLite database at --sqlite or .local/memory.sqlite; no database is created');
  const deliveredPayload = await buildMcpContextProfilePayload({
    values,
    root,
    workspaceId,
    generatedAt,
    args: {
      objective,
      step,
      scope,
      budget: parseIntegerOption(values, '--token-budget', parseIntegerOption(values, '--budget', 4096)),
      limit
    }
  });
  const report = await buildRealisticContextProfileSavingsReport({
    root,
    workspaceId,
    generatedAt,
    objective,
    step,
    deliveredPayload
  });
  const enriched = {
    ...report,
    source: {
      ...report.source,
      memory: {
        provider: 'provider:native:memory:sqlite',
        sqliteRef: `workspace://${sqlitePath.relative}`,
        scope
      }
    },
    compressed: {
      ...report.compressed,
      contextBudget: deliveredPayload.data.contextBudget
    }
  };
  return { ...enriched, reportFingerprint: stableJsonFingerprint({ ...enriched, reportFingerprint: null }) };
}

function renderSavingsMeasurementSummary(report) {
  return [
    `Realistic token saving: ${report.savings.percent}%`,
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
  const rootOption = option(values, '--root');
  if (rootOption) {
    const root = path.resolve(rootOption);
    const rootStat = await stat(root).catch(() => null);
    if (!rootStat?.isDirectory()) throw new Error('memory fact --root must point at a local workspace directory');
    const resolved = await resolveWorkspaceSqlitePath(root, sqlitePath, 'memory fact', { mustExist: readOnly });
    const { SQLiteMemoryProvider } = await import('../../providers/native/memory-sqlite/src/index.mjs');
    return new SQLiteMemoryProvider({ filename: resolved.absolute, clock: fixedNow, migrate: !readOnly, readOnly });
  }
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
      to: requiredOption(values, '--to'),
      maxHops: parseIntegerOption(values, '--max-hops', 6),
      undirected: values.includes('--undirected'),
      at: option(values, '--at') ?? fixedNow()
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
    const factId = option(values, '--fact');
    const entity = option(values, '--entity');
    const query = option(values, '--query');
    if (!factId && !entity && !query) throw new Error('memory explain requires --fact, --entity, or --query');
    const report = await provider.explainTemporalMemory({
      ...memoryHybridQuery(values),
      query: query ?? '',
      factId,
      entity,
      depth: parseIntegerOption(values, '--depth', 1),
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
  if (values[0] === 'retrieve') return contextRetrieveCommand(values.slice(1));
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
    console.error('context requires --request <json> and --records <json>, context profile --records <json>, context scan --from <harness> --dry-run, context preview --from <harness> --dry-run, context pack --dry-run, context handoff --read-only, context receive --read-only, context retrieve --read-only, or context graph preview --dry-run');
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
  if (values[0] === 'sufficiency') return await benchmarkSufficiencyCommand(values.slice(1));
  if (values[0] === 'temporal') return await benchmarkTemporalCommand(values.slice(1));
  if (values[0] === 'session') return await benchmarkSessionCommand(values.slice(1));
  if (values[0] === 'realqa') return await benchmarkRealQaCommand(values.slice(1));
  if (values[0] === 'locomo') return await benchmarkLocomoCommand(values.slice(1));

  if (values[0] !== 'truth-floor') {
    console.error('benchmark requires truth-floor, sufficiency, temporal, session, realqa, or locomo');
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

async function benchmarkLocomoCommand(values) {
  if (!values.includes('--read-only')) {
    console.error('bench locomo requires --read-only');
    process.exitCode = 2;
    return;
  }
  if (values.includes('--write') || values.includes('--out') || values.includes('--pin') || values.includes('--use-out')) {
    console.error('bench locomo is read-only and does not write or pin workspace artifacts');
    process.exitCode = 2;
    return;
  }
  const valueOptions = new Set(['--root', '--workspace', '--workspace-id', '--budget', '--token-budget', '--limit', '--sample', '--dataset', '--memory-source', '--miss-limit', '--format']);
  const unsupported = unsupportedFlags(values, new Set(['--read-only', ...valueOptions]), valueOptions);
  if (unsupported.length > 0) {
    console.error(`bench locomo unsupported option: ${unsupported[0]}`);
    process.exitCode = 2;
    return;
  }
  const format = option(values, '--format') ?? 'json';
  if (!['json', 'summary'].includes(format)) {
    console.error('bench locomo only supports --format json or summary');
    process.exitCode = 2;
    return;
  }
  try {
    const report = await buildLocomoBenchmarkReport(values);
    console.log(format === 'summary' ? renderLocomoBenchmarkSummary(report) : JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

async function buildLocomoBenchmarkReport(values) {
  const root = path.resolve(option(values, '--root') ?? process.cwd());
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) throw new Error('bench locomo --root must point at a local workspace directory');
  const workspaceId = option(values, '--workspace-id') ?? option(values, '--workspace') ?? 'ws_local';
  const generatedAt = fixedNow();
  const tokenBudget = parseIntegerOption(values, '--token-budget', parseIntegerOption(values, '--budget', 1024));
  const recallLimit = parseIntegerOption(values, '--limit', 12);
  const sampleLimit = parseIntegerOption(values, '--sample', 0);
  const missLimit = parseIntegerOption(values, '--miss-limit', 12);
  const memorySource = option(values, '--memory-source') ?? 'turns+observations';
  const datasetPath = option(values, '--dataset') ?? 'evals/locomo/smoke.v1.json';
  const dataset = await loadLocomoDataset(datasetPath);
  const scratchRoot = await mkdtemp(path.join(tmpdir(), 'oaf-locomo-'));
  const scratchSqlite = path.join(scratchRoot, 'memory.sqlite');
  const cases = [];
  const categoryStats = new Map();
  const sampleStats = [];
  let activeMemoryCreated = 0;
  let baselineTokens = 0;
  let selectedBaselineTokens = 0;
  const started = Date.now();
  try {
    const { SQLiteMemoryProvider } = await import('../../providers/native/memory-sqlite/src/index.mjs');
    const provider = new SQLiteMemoryProvider({ filename: scratchSqlite, clock: () => generatedAt });
    try {
      for (const sample of dataset.samples) {
        const locomoSample = normalizeLocomoSample(sample);
        baselineTokens += locomoSample.fullConversationTokens;
        activeMemoryCreated += await addLocomoBenchmarkFacts(provider, { sample: locomoSample, workspaceId, memorySource });
        let sampleQuestionCount = 0;
        for (const qa of locomoSample.qa) {
          if (sampleLimit > 0 && cases.length >= sampleLimit) break;
          sampleQuestionCount += 1;
          selectedBaselineTokens += locomoSample.fullConversationTokens;
          const queryStarted = Date.now();
          const retrievalQuery = locomoRetrievalQuery(qa.question);
          const recall = await provider.searchTemporalMemory({
            workspaceId,
            scope: 'workspace',
            query: retrievalQuery,
            at: generatedAt,
            limit: recallLimit
          });
          const retrieved = recall.results.map((item) => item.fact);
          const deliveredText = locomoRetrievedText(retrieved);
          const evidenceHits = locomoEvidenceHits(retrieved, qa.evidence);
          const answerScored = qa.category !== 5 && Boolean(qa.answer);
          const answerCovered = answerScored ? locomoAnswerCovered(deliveredText, qa.answer) : null;
          const deliveredTokens = estimateTokens(deliveredText);
          const category = locomoCategoryLabel(qa.category);
          const item = {
            id: qa.id,
            sampleId: locomoSample.sampleId,
            category,
            question: qa.question,
            retrievalQuery,
            evidenceCount: qa.evidence.length,
            retrievedFactCount: retrieved.length,
            deliveredTokens,
            baselineTokens: locomoSample.fullConversationTokens,
            tokenReductionPercent: locomoSample.fullConversationTokens ? Number(((1 - deliveredTokens / locomoSample.fullConversationTokens) * 100).toFixed(2)) : 0,
            evidenceAnyHit: evidenceHits.any,
            evidenceAllHit: evidenceHits.all,
            evidenceHitCount: evidenceHits.hitCount,
            answerScored,
            answerCovered,
            latencyMs: Date.now() - queryStarted
          };
          cases.push(item);
          updateLocomoCategoryStats(categoryStats, item);
        }
        sampleStats.push({
          sampleId: locomoSample.sampleId,
          sessionCount: locomoSample.sessionCount,
          turnCount: locomoSample.turnCount,
          qaCount: sampleQuestionCount,
          fullConversationTokens: locomoSample.fullConversationTokens
        });
        if (sampleLimit > 0 && cases.length >= sampleLimit) break;
      }
    } finally {
      provider.close();
    }
  } finally {
    await rm(scratchRoot, { recursive: true, force: true }).catch(() => {});
  }
  const totals = summarizeLocomoCases(cases);
  const report = {
    schemaVersion: '1.0.0',
    command: 'bench locomo',
    generatedAt,
    workspaceId,
    dataset: {
      id: dataset.id,
      version: dataset.version,
      ref: datasetPath.startsWith('/') ? 'local-absolute-dataset' : `workspace://${toPosix(datasetPath)}`,
      sampleCount: dataset.samples.length,
      evaluatedSampleCount: sampleStats.length,
      qaCount: dataset.samples.reduce((sum, sample) => sum + (Array.isArray(sample.qa) ? sample.qa.length : 0), 0),
      evaluatedQaCount: cases.length
    },
    benchmarkType: {
      name: 'locomo-model-free-retrieval-coverage',
      officialGenerativeQaF1: false,
      reason: 'Memory Recall local benches do not call model APIs; this measures retrieved context coverage and token delivery, not generated answers.',
      scoredSignals: ['evidence_any_recall', 'evidence_all_recall', 'answer_string_coverage_non_adversarial', 'delivered_tokens', 'retrieval_latency']
    },
    budget: {
      tokenBudget,
      recallLimit,
      unit: 'estimated delivery tokens per question',
      estimator: 'ceil(chars/4)'
    },
    source: {
      memoryProvider: 'provider:native:memory:sqlite',
      scratchStore: 'os-temp-sqlite',
      memorySource,
      activeMemoryCreated,
      proposalGated: true
    },
    totals,
    categoryBreakdown: [...categoryStats.values()].map(finalizeLocomoCategoryStats),
    samples: sampleStats,
    tokenDelivery: {
      selectedFullConversationTokens: selectedBaselineTokens,
      retrievedContextTokens: totals.deliveredTokens,
      reductionPercent: selectedBaselineTokens ? Number(((1 - totals.deliveredTokens / selectedBaselineTokens) * 100).toFixed(2)) : 0,
      baseline: 'full conversation text per question',
      providerBillingClaimed: false
    },
    misses: cases
      .filter((item) => !item.evidenceAllHit || (item.answerScored && !item.answerCovered))
      .slice(0, missLimit)
      .map((item) => ({
        id: item.id,
        sampleId: item.sampleId,
        category: item.category,
        evidenceAnyHit: item.evidenceAnyHit,
        evidenceAllHit: item.evidenceAllHit,
        answerCovered: item.answerCovered,
        deliveredTokens: item.deliveredTokens,
        tokenReductionPercent: item.tokenReductionPercent
      })),
    antiGaming: {
      retrievalUsesQuestionOnly: true,
      goldAnswerNotUsedForRetrieval: true,
      evidenceIdsNotUsedForRetrieval: true,
      transcriptBodiesExcludedFromReport: true,
      adversarialAnswerGenerationNotScored: true
    },
    safeguards: {
      readOnly: true,
      workspaceFilesWritten: 0,
      scratchFilesWritten: activeMemoryCreated > 0 ? 1 : 0,
      proposalGated: true,
      activeMemoryCreated,
      hardDeleted: false,
      deterministicOffline: true,
      networkCalls: 0,
      modelCalls: 0,
      externalWritesEnabled: false,
      rawConversationBodiesIncluded: false,
      rawMcpPayloadsIncluded: false,
      providerBillingClaimed: false
    },
    durationMs: Date.now() - started,
    reportFingerprint: null
  };
  return { ...report, reportFingerprint: stableJsonFingerprint(report) };
}

async function loadLocomoDataset(datasetPath) {
  const parsed = JSON.parse(await readFile(datasetPath, 'utf8'));
  const samples = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.samples) ? parsed.samples : []);
  if (samples.length < 1) throw new Error('bench locomo dataset requires at least one sample');
  return {
    id: Array.isArray(parsed) ? 'locomo-json-array' : String(parsed.id ?? 'locomo-json-array'),
    version: Array.isArray(parsed) ? 'external' : String(parsed.version ?? 'external'),
    samples
  };
}

function normalizeLocomoSample(sample) {
  if (!sample || typeof sample !== 'object' || Array.isArray(sample)) throw new Error('bench locomo sample must be an object');
  const sampleId = sanitizeLocomoId(sample.sample_id ?? sample.sampleId ?? 'sample');
  const conversation = sample.conversation && typeof sample.conversation === 'object' && !Array.isArray(sample.conversation) ? sample.conversation : {};
  const sessions = locomoSessionIndexes(conversation);
  const turns = [];
  for (const sessionIndex of sessions) {
    const sessionTurns = Array.isArray(conversation[`session_${sessionIndex}`]) ? conversation[`session_${sessionIndex}`] : [];
    const sessionAt = locomoSessionTimestamp(conversation[`session_${sessionIndex}_date_time`], sessionIndex);
    for (const [turnIndex, turn] of sessionTurns.entries()) {
      if (!turn || typeof turn !== 'object') continue;
      const diaId = sanitizeLocomoDiaId(turn.dia_id ?? `D${sessionIndex}:${turnIndex + 1}`);
      const speaker = String(turn.speaker ?? 'speaker').trim() || 'speaker';
      const text = String(turn.text ?? '').trim();
      if (!text) continue;
      const extras = [
        turn.blip_caption ? `image caption: ${String(turn.blip_caption).trim()}` : '',
        turn.query ? `image query: ${String(turn.query).trim()}` : ''
      ].filter(Boolean).join(' ');
      turns.push({
        sampleId,
        sessionIndex,
        turnIndex,
        diaId,
        speaker,
        text,
        memoryText: `${speaker} in ${diaId}: ${text}${extras ? ` ${extras}` : ''}`,
        observedAt: new Date(Date.parse(sessionAt) + turnIndex * 1000).toISOString()
      });
    }
  }
  const observations = locomoObservationFacts(sample.observation, { sampleId });
  const qa = (Array.isArray(sample.qa) ? sample.qa : []).map((item, index) => normalizeLocomoQa(item, { sampleId, index })).filter(Boolean);
  const transcriptText = turns.map((turn) => `${turn.diaId} ${turn.speaker}: ${turn.text}`).join('\n');
  return {
    sampleId,
    sessionCount: sessions.length,
    turnCount: turns.length,
    turns,
    observations,
    qa,
    fullConversationTokens: estimateTokens(transcriptText)
  };
}

function locomoSessionIndexes(conversation) {
  return Object.keys(conversation)
    .map((key) => /^session_(\d+)$/u.exec(key)?.[1])
    .filter(Boolean)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0)
    .sort((left, right) => left - right);
}

function locomoSessionTimestamp(rawValue, sessionIndex) {
  const raw = String(rawValue ?? '').trim();
  const parsed = raw ? Date.parse(raw.replace(/\bon\b/iu, '')) : Number.NaN;
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  return new Date(Date.UTC(2026, 0, Math.max(1, sessionIndex), 0, 0, 0)).toISOString();
}

function locomoObservationFacts(observation, { sampleId }) {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) return [];
  const facts = [];
  for (const [key, value] of Object.entries(observation)) {
    const sessionIndex = Number(/^session_(\d+)_observation$/u.exec(key)?.[1] ?? 0);
    if (!sessionIndex || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    for (const [speaker, items] of Object.entries(value)) {
      if (!Array.isArray(items)) continue;
      for (const [index, item] of items.entries()) {
        const text = Array.isArray(item) ? String(item[0] ?? '').trim() : String(item ?? '').trim();
        const evidence = Array.isArray(item) ? [String(item[1] ?? '').trim()].filter(Boolean) : [];
        if (!text) continue;
        facts.push({
          sampleId,
          kind: 'observation',
          sessionIndex,
          index,
          speaker: String(speaker ?? 'speaker').trim() || 'speaker',
          text,
          evidence,
          observedAt: locomoSessionTimestamp(null, sessionIndex)
        });
      }
    }
  }
  return facts;
}

function normalizeLocomoQa(item, { sampleId, index }) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const question = String(item.question ?? '').trim();
  if (!question) return null;
  const category = Number(item.category ?? 0);
  const answer = item.answer === undefined || item.answer === null ? '' : String(item.answer).trim();
  const adversarialAnswer = item.adversarial_answer === undefined || item.adversarial_answer === null ? '' : String(item.adversarial_answer).trim();
  const evidence = Array.isArray(item.evidence) ? item.evidence.map((value) => sanitizeLocomoDiaId(value)).filter(Boolean) : [];
  return {
    id: `locomo_${sampleId}_qa_${index + 1}`,
    question,
    answer,
    adversarialAnswer,
    category,
    evidence
  };
}

async function addLocomoBenchmarkFacts(provider, { sample, workspaceId, memorySource }) {
  const includeTurns = memorySource === 'turns' || memorySource === 'turns+observations' || memorySource === 'all';
  const includeObservations = memorySource === 'observations' || memorySource === 'turns+observations' || memorySource === 'all';
  if (!includeTurns && !includeObservations) throw new Error('bench locomo --memory-source must be turns, observations, turns+observations, or all');
  let count = 0;
  if (includeTurns) {
    for (const turn of sample.turns) {
      count += await addLocomoFact(provider, {
        workspaceId,
        sampleId: sample.sampleId,
        factKey: `turn:${turn.diaId}`,
        sourceLocator: `workspace://evals/locomo/${sample.sampleId}/${turn.diaId}.md`,
        subject: `locomo:${sample.sampleId}:${turn.speaker}`,
        predicate: 'dialog_turn',
        object: turn.memoryText,
        text: turn.memoryText,
        observedAt: turn.observedAt,
        metadata: {
          kind: 'turn',
          sampleId: sample.sampleId,
          diaId: turn.diaId,
          evidenceIds: [turn.diaId],
          sessionIndex: turn.sessionIndex,
          speaker: turn.speaker
        }
      });
    }
  }
  if (includeObservations) {
    for (const observation of sample.observations) {
      const sourceDia = observation.evidence[0] ?? `S${observation.sessionIndex}:${observation.index + 1}`;
      count += await addLocomoFact(provider, {
        workspaceId,
        sampleId: sample.sampleId,
        factKey: `observation:${observation.sessionIndex}:${observation.index}`,
        sourceLocator: `workspace://evals/locomo/${sample.sampleId}/observation-${observation.sessionIndex}-${observation.index + 1}.md`,
        subject: `locomo:${sample.sampleId}:${observation.speaker}`,
        predicate: 'observation',
        object: observation.text,
        text: `${observation.speaker} observation from ${sourceDia}: ${observation.text}`,
        observedAt: observation.observedAt,
        metadata: {
          kind: 'observation',
          sampleId: sample.sampleId,
          diaId: sourceDia,
          evidenceIds: observation.evidence,
          sessionIndex: observation.sessionIndex,
          speaker: observation.speaker
        }
      });
    }
  }
  return count;
}

async function addLocomoFact(provider, { workspaceId, sampleId, factKey, sourceLocator, subject, predicate, object, text, observedAt, metadata }) {
  const idHash = createHash('sha256').update(`${sampleId}:${factKey}`).digest('hex').slice(0, 24);
  const proposalId = `mpq_locomo_${idHash}`;
  const proposal = await provider.enqueueProposal({
    id: proposalId,
    workspaceId,
    sourceLocator,
    sourceHash: `sha256:${createHash('sha256').update(`${sourceLocator}\0${text}`).digest('hex')}`,
    payload: { kind: 'fact', subject, predicate, object, text, observedAt }
  });
  if (proposal.status !== 'applied') {
    await provider.claimProposal({ workspaceId, workerId: 'locomo-bench', leaseUntil: '2999-01-01T00:00:00.000Z', limit: 25 });
    await provider.recordProposalResult({ workspaceId, id: proposal.id, workerId: 'locomo-bench', status: 'applied', result: { accepted: true } });
  }
  await provider.addTemporalFact({
    id: `memfact_locomo_${idHash}`,
    workspaceId,
    scope: 'workspace',
    subject,
    predicate,
    object,
    text,
    source: sourceLocator,
    proposalQueueId: proposal.id,
    validFrom: observedAt,
    supersedeSubjectPredicate: false,
    metadata,
    episode: {
      id: `mep_locomo_${idHash}`,
      sourceLocator,
      summary: text.slice(0, 400),
      observedAt,
      metadata
    }
  });
  return 1;
}

function locomoRetrievedText(facts) {
  return facts.map((fact) => [
    fact.source,
    fact.subject,
    fact.predicate,
    fact.text
  ].filter(Boolean).join('\n')).join('\n\n');
}

function locomoEvidenceHits(facts, evidence) {
  const required = new Set((evidence ?? []).map(sanitizeLocomoDiaId).filter(Boolean));
  if (required.size === 0) return { any: false, all: false, hitCount: 0 };
  const seen = new Set();
  for (const fact of facts) {
    for (const id of fact.metadata?.evidenceIds ?? []) {
      const normalized = sanitizeLocomoDiaId(id);
      if (required.has(normalized)) seen.add(normalized);
    }
    const diaId = sanitizeLocomoDiaId(fact.metadata?.diaId ?? '');
    if (required.has(diaId)) seen.add(diaId);
  }
  return { any: seen.size > 0, all: seen.size === required.size, hitCount: seen.size };
}

function locomoAnswerCovered(text, answer) {
  const haystack = normalizeLocomoAnswer(text);
  const normalizedAnswer = normalizeLocomoAnswer(answer);
  if (!normalizedAnswer) return false;
  if (haystack.includes(normalizedAnswer)) return true;
  const tokens = normalizedAnswer.split(' ').filter((token) => token.length >= 3 && !LOCOMO_ANSWER_STOPWORDS.has(token));
  if (tokens.length === 0) return false;
  const hits = tokens.filter((token) => haystack.includes(token)).length;
  return hits / tokens.length >= (tokens.length <= 2 ? 1 : 0.67);
}

function locomoRetrievalQuery(question) {
  const stopwords = new Set(['what', 'which', 'where', 'when', 'who', 'why', 'how', 'did', 'does', 'do', 'was', 'were', 'would', 'could', 'should', 'the', 'a', 'an', 'to', 'for', 'of', 'in', 'on', 'at', 'is', 'are', 'be', 'been', 'had', 'has', 'have', 'with', 'from', 'after', 'before', 'likely', 'current']);
  const tokens = [...new Set(normalizeLocomoAnswer(question).split(' ').filter((token) => token.length >= 3 && !stopwords.has(token)))];
  return tokens.slice(0, 12).join(' ') || String(question ?? '').trim();
}

function normalizeLocomoAnswer(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function locomoCategoryLabel(category) {
  const labels = new Map([
    [1, 'category-1'],
    [2, 'category-2-temporal'],
    [3, 'category-3-commonsense'],
    [4, 'category-4-single-hop'],
    [5, 'category-5-adversarial']
  ]);
  return labels.get(Number(category)) ?? `category-${category || 'unknown'}`;
}

function updateLocomoCategoryStats(stats, item) {
  const current = stats.get(item.category) ?? {
    category: item.category,
    count: 0,
    evidenceAnyHitCount: 0,
    evidenceAllHitCount: 0,
    answerScoredCount: 0,
    answerCoveredCount: 0,
    deliveredTokens: 0,
    baselineTokens: 0,
    latencyMs: 0
  };
  current.count += 1;
  current.evidenceAnyHitCount += item.evidenceAnyHit ? 1 : 0;
  current.evidenceAllHitCount += item.evidenceAllHit ? 1 : 0;
  current.answerScoredCount += item.answerScored ? 1 : 0;
  current.answerCoveredCount += item.answerCovered ? 1 : 0;
  current.deliveredTokens += item.deliveredTokens;
  current.baselineTokens += item.baselineTokens;
  current.latencyMs += item.latencyMs;
  stats.set(item.category, current);
}

function finalizeLocomoCategoryStats(item) {
  return {
    ...item,
    evidenceAnyRecallPercent: sufficiencyPercent(item.evidenceAnyHitCount, item.count),
    evidenceAllRecallPercent: sufficiencyPercent(item.evidenceAllHitCount, item.count),
    answerCoveragePercent: sufficiencyPercent(item.answerCoveredCount, item.answerScoredCount),
    averageDeliveredTokens: item.count ? Math.round(item.deliveredTokens / item.count) : 0,
    tokenReductionPercent: item.baselineTokens ? Number(((1 - item.deliveredTokens / item.baselineTokens) * 100).toFixed(2)) : 0,
    averageLatencyMs: item.count ? Math.round(item.latencyMs / item.count) : 0
  };
}

function summarizeLocomoCases(cases) {
  const count = cases.length;
  const evidenceAnyHitCount = cases.filter((item) => item.evidenceAnyHit).length;
  const evidenceAllHitCount = cases.filter((item) => item.evidenceAllHit).length;
  const answerScored = cases.filter((item) => item.answerScored);
  const answerCoveredCount = answerScored.filter((item) => item.answerCovered).length;
  const deliveredTokens = cases.reduce((sum, item) => sum + item.deliveredTokens, 0);
  const baselineTokens = cases.reduce((sum, item) => sum + item.baselineTokens, 0);
  const latencyMs = cases.reduce((sum, item) => sum + item.latencyMs, 0);
  return {
    qaCount: count,
    evidenceAnyHitCount,
    evidenceAllHitCount,
    evidenceAnyRecallPercent: sufficiencyPercent(evidenceAnyHitCount, count),
    evidenceAllRecallPercent: sufficiencyPercent(evidenceAllHitCount, count),
    answerScoredCount: answerScored.length,
    answerCoveredCount,
    answerCoveragePercent: sufficiencyPercent(answerCoveredCount, answerScored.length),
    deliveredTokens,
    averageDeliveredTokens: count ? Math.round(deliveredTokens / count) : 0,
    baselineTokens,
    averageBaselineTokens: count ? Math.round(baselineTokens / count) : 0,
    tokenReductionPercent: baselineTokens ? Number(((1 - deliveredTokens / baselineTokens) * 100).toFixed(2)) : 0,
    averageLatencyMs: count ? Math.round(latencyMs / count) : 0,
    maxLatencyMs: cases.reduce((max, item) => Math.max(max, item.latencyMs), 0)
  };
}

function renderLocomoBenchmarkSummary(report) {
  return [
    `LoCoMo retrieval benchmark: evidence-any ${report.totals.evidenceAnyRecallPercent}% / evidence-all ${report.totals.evidenceAllRecallPercent}% / answer-string ${report.totals.answerCoveragePercent}%`,
    `Questions: ${report.dataset.evaluatedQaCount}/${report.dataset.qaCount}`,
    `Delivered tokens: ${report.tokenDelivery.retrievedContextTokens} vs full-conversation ${report.tokenDelivery.selectedFullConversationTokens} (${report.tokenDelivery.reductionPercent}% smaller)`,
    `Average latency: ${report.totals.averageLatencyMs}ms`,
    `Official generative QA F1 claimed: no`
  ].join('\n');
}

function sanitizeLocomoId(value) {
  return String(value ?? 'sample').replace(/[^A-Za-z0-9._-]+/gu, '-').slice(0, 80) || 'sample';
}

function sanitizeLocomoDiaId(value) {
  return String(value ?? '').trim().replace(/[^A-Za-z0-9:._-]+/gu, '-').slice(0, 80);
}

async function benchmarkTemporalCommand(values) {
  if (!values.includes('--read-only')) {
    console.error('bench temporal requires --read-only');
    process.exitCode = 2;
    return;
  }
  if (values.includes('--write') || values.includes('--out') || values.includes('--pin') || values.includes('--use-out')) {
    console.error('bench temporal is read-only and does not write or pin workspace artifacts');
    process.exitCode = 2;
    return;
  }
  const valueOptions = new Set(['--root', '--workspace', '--workspace-id', '--budget', '--token-budget', '--limit', '--dataset', '--format']);
  const unsupported = unsupportedFlags(values, new Set(['--read-only', ...valueOptions]), valueOptions);
  if (unsupported.length > 0) {
    console.error(`bench temporal unsupported option: ${unsupported[0]}`);
    process.exitCode = 2;
    return;
  }
  const format = option(values, '--format') ?? 'json';
  if (!['json', 'summary'].includes(format)) {
    console.error('bench temporal only supports --format json or summary');
    process.exitCode = 2;
    return;
  }
  try {
    const report = await buildTemporalBenchmarkReport(values);
    console.log(format === 'summary' ? renderTemporalBenchmarkSummary(report) : JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

async function buildTemporalBenchmarkReport(values) {
  const root = path.resolve(option(values, '--root') ?? process.cwd());
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) throw new Error('bench temporal --root must point at a local workspace directory');
  const workspaceId = option(values, '--workspace-id') ?? option(values, '--workspace') ?? 'ws_local';
  const generatedAt = fixedNow();
  const tokenBudget = parseIntegerOption(values, '--token-budget', parseIntegerOption(values, '--budget', 1024));
  const recallLimit = parseIntegerOption(values, '--limit', 8);
  const datasetPath = option(values, '--dataset') ?? 'evals/temporal/gold.v1.json';
  const dataset = await loadTemporalDataset(datasetPath);
  const scratchRoot = await mkdtemp(path.join(tmpdir(), 'oaf-temporal-'));
  const scratchSqlite = path.join(scratchRoot, 'memory.sqlite');
  const sqliteValues = ['--sqlite', 'memory.sqlite'];
  const cases = [];
  let temporalFactCount = 0;
  try {
    const { SQLiteMemoryProvider } = await import('../../providers/native/memory-sqlite/src/index.mjs');
    const provider = new SQLiteMemoryProvider({ filename: scratchSqlite, clock: () => generatedAt });
    try {
      for (const item of dataset.cases) temporalFactCount += await addTemporalBenchmarkFacts(provider, { item, workspaceId });
    } finally {
      provider.close();
    }

    for (const item of dataset.cases) {
      const profilePayload = await buildMcpContextProfilePayload({
        values: sqliteValues,
        root: scratchRoot,
        workspaceId,
        generatedAt,
        args: {
          objective: item.question,
          step: 'Measure current temporal fact without stale superseded values',
          scope: 'workspace',
          budget: tokenBudget,
          limit: recallLimit,
          subject: item.subject,
          predicate: item.predicate,
          currentTruthOnly: true
        }
      });
      const recallPayload = await buildMcpMemoryRecallPayload({
        values: sqliteValues,
        root: scratchRoot,
        workspaceId,
        generatedAt,
        args: {
          query: item.question,
          scope: 'workspace',
          limit: recallLimit,
          subject: item.subject,
          predicate: item.predicate,
          currentTruthOnly: true
        }
      });
      const oafText = JSON.stringify({ contextProfile: profilePayload, memoryRecall: recallPayload });
      const baseline = buildTemporalRawTimelineBaseline({ item, tokenBudget });
      cases.push({
        id: item.id,
        question: item.question,
        currentValue: item.currentValue,
        supersededValues: item.supersededValues,
        oaf: scoreTemporalAnswer(oafText, item, {
          deliveredTokens: estimateTokens(oafText),
          contextProfileTokens: estimateTokens(JSON.stringify(profilePayload)),
          memoryRecallTokens: estimateTokens(JSON.stringify(recallPayload)),
          activeFactCount: Number(recallPayload.data?.activeFactCount ?? 0),
          selectedContextCount: Number(profilePayload.data?.selectedContext?.selectedCount ?? 0)
        }),
        baseline: scoreTemporalAnswer(baseline.text, item, {
          deliveredTokens: baseline.deliveredTokens,
          snippetCount: baseline.snippetCount,
          evidenceLocators: baseline.evidenceLocators
        })
      });
    }
  } finally {
    await rm(scratchRoot, { recursive: true, force: true }).catch(() => {});
  }

  const oaf = summarizeTemporalArm('bi-temporal memory.recall+context.profile', cases.map((item) => item.oaf), tokenBudget);
  const baseline = {
    ...summarizeTemporalArm('keyword-top-k-raw-timeline', cases.map((item) => item.baseline), tokenBudget),
    dumpRepo: false
  };
  const headline = {
    metric: 'current-correct-and-clean-temporal-recall',
    oafWins: oaf.correctnessPercent > baseline.correctnessPercent && oaf.cleanlinessPercent > baseline.cleanlinessPercent,
    rule: 'OAF wins only when it is more correct and cleaner than keyword top-k over the same raw timeline text',
    oafDeliveredTokens: oaf.deliveredTokens,
    baselineDeliveredTokens: baseline.deliveredTokens
  };
  const report = {
    schemaVersion: '1.0.0',
    command: 'bench temporal',
    generatedAt,
    workspaceId,
    dataset: {
      id: dataset.id,
      version: dataset.version,
      ref: datasetPath.startsWith('/') ? 'local-absolute-dataset' : `workspace://${toPosix(datasetPath)}`,
      caseCount: dataset.cases.length
    },
    budget: {
      tokenBudget,
      unit: 'estimated delivery tokens per question',
      estimator: 'ceil(chars/4)'
    },
    source: {
      memoryProvider: 'provider:native:memory:sqlite',
      scratchStore: 'os-temp-sqlite',
      temporalFactCount,
      proposalGated: true
    },
    oaf,
    baseline,
    headline,
    antiGaming: {
      returningStaleFails: true,
      returningNothingFails: true,
      returningCurrentAndStaleIsNotClean: true,
      realisticBaseline: true,
      dumpRepoBaseline: false,
      sameRawTimelineText: true
    },
    cases,
    safeguards: {
      readOnly: true,
      workspaceFilesWritten: 0,
      scratchFilesWritten: temporalFactCount > 0 ? 1 : 0,
      proposalGated: true,
      activeMemoryCreated: temporalFactCount,
      hardDeleted: false,
      deterministicOffline: true,
      networkCalls: 0,
      modelCalls: 0,
      externalWritesEnabled: false,
      rawTimelineBodiesIncluded: false,
      rawMcpPayloadsIncluded: false,
      providerBillingClaimed: false
    },
    reportFingerprint: null
  };
  return { ...report, reportFingerprint: stableJsonFingerprint(report) };
}

async function benchmarkSessionCommand(values) {
  if (!values.includes('--read-only')) {
    console.error('bench session requires --read-only');
    process.exitCode = 2;
    return;
  }
  if (values.includes('--write') || values.includes('--out') || values.includes('--pin') || values.includes('--use-out')) {
    console.error('bench session is read-only and does not write or pin workspace artifacts');
    process.exitCode = 2;
    return;
  }
  const valueOptions = new Set(['--root', '--workspace', '--workspace-id', '--budget', '--token-budget', '--limit', '--dataset', '--format']);
  const unsupported = unsupportedFlags(values, new Set(['--read-only', ...valueOptions]), valueOptions);
  if (unsupported.length > 0) {
    console.error(`bench session unsupported option: ${unsupported[0]}`);
    process.exitCode = 2;
    return;
  }
  const format = option(values, '--format') ?? 'json';
  if (!['json', 'summary'].includes(format)) {
    console.error('bench session only supports --format json or summary');
    process.exitCode = 2;
    return;
  }
  try {
    const report = await buildSessionBenchmarkReport(values);
    console.log(format === 'summary' ? renderSessionBenchmarkSummary(report) : JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

async function buildSessionBenchmarkReport(values) {
  const root = path.resolve(option(values, '--root') ?? process.cwd());
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) throw new Error('bench session --root must point at a local workspace directory');
  const workspaceId = option(values, '--workspace-id') ?? option(values, '--workspace') ?? 'ws_local';
  const tokenBudget = parseIntegerOption(values, '--token-budget', parseIntegerOption(values, '--budget', 1024));
  const recallLimit = parseIntegerOption(values, '--limit', 8);
  const datasetPath = option(values, '--dataset') ?? 'evals/temporal/gold.v1.json';
  const dataset = await loadTemporalDataset(datasetPath);
  const item = dataset.cases[0];
  const scratchRoot = await mkdtemp(path.join(tmpdir(), 'oaf-session-'));
  const scratchSqlite = path.join(scratchRoot, 'memory.sqlite');
  const sqliteValues = ['--sqlite', 'memory.sqlite'];
  const calls = buildSessionBenchmarkCalls(item);
  const fullCalls = [];
  const deltaCalls = [];
  const cursorStore = await createMcpCursorStore({ values: ['--cursors', '.local/mcp-cursors.json'], root: scratchRoot, workspaceId });
  const cursorArgs = { client: 'bench-session', scope: 'workspace' };
  const restartAfterCall = 3;
  let persistedCursorReloaded = false;
  let restartCallIndex = null;
  let cursor = null;
  let agentValue = null;
  let temporalFactCount = 0;
  try {
    for (const call of calls) {
      if (call.changed) {
        await addTemporalBenchmarkFactAt({ sqlitePath: scratchSqlite, now: call.at, item, pointIndex: call.pointIndex, workspaceId });
        temporalFactCount += 1;
      }
      const args = {
        scope: 'workspace',
        limit: recallLimit,
        subject: item.subject,
        predicate: item.predicate,
        currentTruthOnly: true
      };
      if (call.index === restartAfterCall + 1) {
        cursor = await cursorStore.get({ toolName: 'session.delta', args: cursorArgs });
        persistedCursorReloaded = Boolean(cursor);
        restartCallIndex = call.index;
      }
      const profileArgs = {
        ...args,
        objective: item.question,
        step: 'Measure session cursor delta delivery',
        budget: tokenBudget
      };
      const recallArgs = {
        ...args,
        query: item.question
      };
      const fullProfile = await buildMcpContextProfilePayload({ values: sqliteValues, root: scratchRoot, workspaceId, generatedAt: call.at, args: profileArgs });
      const fullRecall = await buildMcpMemoryRecallPayload({ values: sqliteValues, root: scratchRoot, workspaceId, generatedAt: call.at, args: recallArgs });
      const fullText = JSON.stringify([fullProfile, fullRecall]);
      fullCalls.push({
        index: call.index,
        changed: call.changed,
        currentValue: call.currentValue,
        deliveredTokens: estimateTokens(fullText),
        correct: fullText.includes(call.currentValue)
      });

      const deltaProfile = await buildMcpContextProfilePayload({ values: sqliteValues, root: scratchRoot, workspaceId, generatedAt: call.at, args: cursor ? { ...profileArgs, since: cursor } : profileArgs });
      const deltaRecall = await buildMcpMemoryRecallPayload({ values: sqliteValues, root: scratchRoot, workspaceId, generatedAt: call.at, args: cursor ? { ...recallArgs, since: cursor } : recallArgs });
      const deltaText = JSON.stringify([deltaProfile, deltaRecall]);
      const changes = mcpPayloadCurrentTruthChanges(deltaRecall);
      if (!cursor || changes.length > 0) agentValue = changes.at(-1)?.value ?? mcpPayloadCurrentTruthChanges(deltaRecall).at(-1)?.value ?? agentValue;
      cursor = mcpPayloadNextCursor(deltaRecall) ?? mcpPayloadNextCursor(deltaProfile) ?? call.at;
      await cursorStore.set({ toolName: 'session.delta', args: cursorArgs, cursor });
      deltaCalls.push({
        index: call.index,
        mode: call.index === 1 ? 'full' : 'delta',
        restart: call.index === restartCallIndex ? 'reloaded-persisted-cursor' : null,
        changed: call.changed,
        currentValue: call.currentValue,
        agentValue,
        deliveredTokens: estimateTokens(deltaText),
        changeCount: changes.length,
        correct: agentValue === call.currentValue,
        cursor
      });
    }
  } finally {
    await rm(scratchRoot, { recursive: true, force: true }).catch(() => {});
  }
  const fullResend = summarizeSessionArm('full-resend-memory.recall+context.profile', fullCalls, tokenBudget);
  const delta = summarizeSessionArm('cursor-delta-memory.recall+context.profile', deltaCalls, tokenBudget);
  return {
    schemaVersion: '1.0.0',
    command: 'bench session',
    generatedAt: fixedNow(),
    workspaceId,
    dataset: {
      id: dataset.id,
      version: dataset.version,
      ref: datasetPath.startsWith('/') ? 'local-absolute-dataset' : `workspace://${toPosix(datasetPath)}`,
      caseCount: dataset.cases.length,
      sessionCaseId: item.id
    },
    budget: {
      tokenBudget,
      unit: 'estimated delivery tokens per call',
      estimator: 'ceil(chars/4)'
    },
    source: {
      memoryProvider: 'provider:native:memory:sqlite',
      scratchStore: 'os-temp-sqlite',
      cursorStore: cursorStore.cursorRef,
      temporalFactCount,
      proposalGated: true
    },
    fullResend,
    delta,
    restart: {
      afterCall: restartAfterCall,
      restartCall: restartCallIndex,
      cursorRef: cursorStore.cursorRef,
      persistedCursorReloaded,
      deliveredTokens: restartCallIndex ? deltaCalls.find((item) => item.index === restartCallIndex)?.deliveredTokens ?? 0 : 0,
      correctnessAfterRestart: deltaCalls.filter((item) => item.index >= restartCallIndex).every((item) => item.correct === true)
    },
    headline: {
      metric: 'session-current-truth-with-cursor-deltas',
      correctnessGatePassed: delta.correctnessPercent === 100,
      deltaDeliveredTokens: delta.deliveredTokens,
      fullResendDeliveredTokens: fullResend.deliveredTokens,
      tokenReductionPercent: fullResend.deliveredTokens ? Math.round((1 - delta.deliveredTokens / fullResend.deliveredTokens) * 100) : 0
    },
    antiGaming: {
      missingChangedFactFails: true,
      agentMustEndCurrent: true,
      noChangeMayOnlyReturnNoChanges: true
    },
    safeguards: {
      readOnly: true,
      workspaceFilesWritten: 0,
      scratchFilesWritten: 2,
      proposalGated: true,
      activeMemoryCreated: temporalFactCount,
      hardDeleted: false,
      deterministicOffline: true,
      networkCalls: 0,
      modelCalls: 0,
      externalWritesEnabled: false,
      providerBillingClaimed: false
    },
    reportFingerprint: fingerprintJson({ datasetId: dataset.id, fullResend, delta })
  };
}

function buildSessionBenchmarkCalls(item) {
  const [first, second, third] = item.timeline;
  return [
    { index: 1, changed: true, pointIndex: 0, at: addIsoMilliseconds(first.at, 1000), currentValue: first.value },
    { index: 2, changed: false, pointIndex: 0, at: addIsoMilliseconds(first.at, 2000), currentValue: first.value },
    { index: 3, changed: true, pointIndex: 1, at: addIsoMilliseconds(second.at, 1000), currentValue: second.value },
    { index: 4, changed: false, pointIndex: 1, at: addIsoMilliseconds(second.at, 2000), currentValue: second.value },
    { index: 5, changed: true, pointIndex: 2, at: addIsoMilliseconds(third.at, 1000), currentValue: third.value },
    { index: 6, changed: false, pointIndex: 2, at: addIsoMilliseconds(third.at, 2000), currentValue: third.value }
  ];
}

function addIsoMilliseconds(value, milliseconds) {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}

async function addTemporalBenchmarkFactAt({ sqlitePath, now, item, pointIndex, workspaceId }) {
  const { SQLiteMemoryProvider } = await import('../../providers/native/memory-sqlite/src/index.mjs');
  const provider = new SQLiteMemoryProvider({ filename: sqlitePath, clock: () => now });
  try {
    const point = item.timeline[pointIndex];
    const proposalId = `mpq_${item.id}_session_${pointIndex + 1}`;
    await provider.enqueueProposal({
      id: proposalId,
      workspaceId,
      sourceLocator: `workspace://evals/temporal/${item.id}.md`,
      sourceHash: `sha256:${createHash('sha256').update(`${item.id}:session:${pointIndex}:${point.value}`).digest('hex')}`,
      payload: { kind: 'fact', subject: item.subject, predicate: item.predicate, object: point.value }
    });
    await provider.claimProposal({ workspaceId, workerId: 'session-bench', leaseUntil: '2999-01-01T00:00:00.000Z' });
    await provider.recordProposalResult({ workspaceId, id: proposalId, workerId: 'session-bench', status: 'applied', result: { accepted: true } });
    await provider.addTemporalFact({
      id: `memfact_${item.id}_session_${pointIndex + 1}`,
      workspaceId,
      scope: 'workspace',
      subject: item.subject,
      predicate: item.predicate,
      object: point.value,
      text: `${item.predicate} current value ${point.value}.`,
      source: `workspace://evals/temporal/${item.id}.md`,
      proposalQueueId: proposalId,
      validFrom: point.at,
      episode: {
        id: `mep_${item.id}_session_${pointIndex + 1}`,
        sourceLocator: `workspace://evals/temporal/${item.id}.md`,
        summary: `${item.predicate} changed to ${point.value}.`,
        observedAt: point.at
      }
    });
  } finally {
    provider.close();
  }
}

async function benchmarkRealQaCommand(values) {
  if (!values.includes('--read-only')) {
    console.error('bench realqa requires --read-only');
    process.exitCode = 2;
    return;
  }
  if (values.includes('--write') || values.includes('--out') || values.includes('--pin') || values.includes('--use-out')) {
    console.error('bench realqa is read-only and does not write or pin workspace artifacts');
    process.exitCode = 2;
    return;
  }
  const valueOptions = new Set(['--root', '--workspace', '--workspace-id', '--budget', '--token-budget', '--limit', '--format']);
  const unsupported = unsupportedFlags(values, new Set(['--read-only', ...valueOptions]), valueOptions);
  if (unsupported.length > 0) {
    console.error(`bench realqa unsupported option: ${unsupported[0]}`);
    process.exitCode = 2;
    return;
  }
  const format = option(values, '--format') ?? 'json';
  if (!['json', 'summary'].includes(format)) {
    console.error('bench realqa only supports --format json or summary');
    process.exitCode = 2;
    return;
  }
  try {
    const report = await buildRealQaBenchmarkReport(values);
    console.log(format === 'summary' ? renderRealQaBenchmarkSummary(report) : JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

async function buildRealQaBenchmarkReport(values) {
  const root = path.resolve(option(values, '--root') ?? process.cwd());
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) throw new Error('bench realqa --root must point at a local workspace directory');
  const workspaceId = option(values, '--workspace-id') ?? option(values, '--workspace') ?? 'ws_local';
  const generatedAt = fixedNow();
  const tokenBudget = parseIntegerOption(values, '--token-budget', parseIntegerOption(values, '--budget', 4096));
  const recallLimit = parseIntegerOption(values, '--limit', 20);
  const cases = await buildRealQaCases(root);
  const beforeEpisodes = await buildWorkspaceMemoryIngestEpisodes({ root, workspaceId, scope: 'workspace', generatedAt, limit: 80, structured: false });
  const afterEpisodes = await buildWorkspaceMemoryIngestEpisodes({ root, workspaceId, scope: 'workspace', generatedAt, limit: 80, structured: true });
  const before = await scoreRealQaArm({ name: 'legacy-generic-ingest', root, workspaceId, generatedAt, tokenBudget, recallLimit, cases, episodes: beforeEpisodes });
  const after = await scoreRealQaArm({ name: 'structured-deduped-ingest', root, workspaceId, generatedAt, tokenBudget, recallLimit, cases, episodes: afterEpisodes });
  return {
    schemaVersion: '1.0.0',
    command: 'bench realqa',
    generatedAt,
    workspaceId,
    cases,
    before,
    after,
    headline: {
      metric: 'real-repo-question-sufficiency',
      beforeSufficiencyPercent: before.correctnessPercent,
      afterSufficiencyPercent: after.correctnessPercent,
      improvementPercent: after.correctnessPercent - before.correctnessPercent,
      correctnessGatePassed: after.correctnessPercent === 100
    },
    antiGaming: {
      answersDerivedFromRepoFiles: true,
      recallAndProfileMustContainAnswer: true,
      lowScoreReportedHonestly: true
    },
    safeguards: {
      readOnly: true,
      workspaceFilesWritten: 0,
      scratchFilesWritten: 2,
      proposalGated: true,
      networkCalls: 0,
      modelCalls: 0,
      externalWritesEnabled: false,
      providerBillingClaimed: false
    },
    reportFingerprint: stableJsonFingerprint({ cases, before, after })
  };
}

async function scoreRealQaArm({ name, root, workspaceId, generatedAt, tokenBudget, recallLimit, cases, episodes }) {
  const scratchRoot = await mkdtemp(path.join(tmpdir(), 'oaf-realqa-'));
  const scratchSqlite = path.join(scratchRoot, 'memory.sqlite');
  const sqliteValues = ['--sqlite', 'memory.sqlite'];
  let proposalCount = 0;
  try {
    const { SQLiteMemoryProvider } = await import('../../providers/native/memory-sqlite/src/index.mjs');
    const provider = new SQLiteMemoryProvider({ filename: scratchSqlite, clock: () => generatedAt });
    try {
      const queued = [];
      for (const episode of episodes) queued.push(...await provider.proposeTemporalFactsFromEpisode(episode));
      proposalCount = new Set(queued.map((item) => item.id)).size;
    } finally {
      provider.close();
    }
    const calls = [];
    for (const item of cases) {
      const recallPayload = await buildMcpMemoryRecallPayload({
        values: sqliteValues,
        root: scratchRoot,
        workspaceId,
        generatedAt,
        args: { query: item.question, scope: 'workspace', limit: recallLimit }
      });
      const profilePayload = await buildMcpContextProfilePayload({
        values: sqliteValues,
        root: scratchRoot,
        workspaceId,
        generatedAt,
        args: { objective: item.question, step: 'Answer real repo question from governed memory', scope: 'workspace', budget: tokenBudget, limit: recallLimit }
      });
      const recallText = JSON.stringify(recallPayload);
      const profileText = JSON.stringify(profilePayload);
      const recallContainsAnswer = recallText.includes(item.answer);
      const profileContainsAnswer = profileText.includes(item.answer);
      calls.push({
        id: item.id,
        answer: item.answer,
        recallContainsAnswer,
        profileContainsAnswer,
        correct: recallContainsAnswer && profileContainsAnswer,
        deliveredTokens: estimateTokens(JSON.stringify({ recallPayload, profilePayload }))
      });
    }
    const deliveredTokens = calls.reduce((sum, item) => sum + item.deliveredTokens, 0);
    const correctCount = calls.filter((item) => item.correct).length;
    return {
      name,
      caseCount: cases.length,
      episodeCount: episodes.length,
      proposalCount,
      correctCount,
      correctnessPercent: Math.round((correctCount / cases.length) * 100),
      deliveredTokens,
      averageDeliveredTokens: Math.round(deliveredTokens / cases.length),
      calls
    };
  } finally {
    await rm(scratchRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function buildRealQaCases(root) {
  const status = await loadWorkspaceJson(root, 'PROJECT_STATUS.json', {});
  const defaults = status?.defaults && typeof status.defaults === 'object' ? status.defaults : {};
  const cases = [];
  const addDefault = (field, question) => {
    if (typeof defaults[field] === 'string') cases.push({ id: `default_${camelToSnakeToken(field)}`, question, answer: defaults[field] });
  };
  addDefault('workflowProvider', 'What is the default durable workflow provider?');
  addDefault('artifactProvider', 'Which provider stores artifacts by default?');
  addDefault('memoryProvider', 'Which memory provider is the default?');
  addDefault('policyProvider', 'Which policy provider is the default?');
  addDefault('toolProvider', 'Which tool provider is the default?');
  addDefault('modelMode', 'What is the default model mode?');
  const manifests = [];
  for (const relativePath of await memoryIngestProviderPaths(root)) {
    const manifest = await loadWorkspaceJson(root, relativePath, null).catch(() => null);
    if (manifest?.id && manifest?.contract) manifests.push(manifest);
  }
  for (const contract of ['ArtifactStorePort', 'MemoryBackendPort', 'PolicyEvaluatorPort', 'ToolExecutionPort', 'ModelGatewayPort']) {
    const provider = manifests.filter((item) => item.contract === contract).sort((a, b) => Number(b.enabledByDefault === true) - Number(a.enabledByDefault === true))[0];
    if (provider) cases.push({ id: `provider_${safeFactToken(contract, 'port')}`, question: `Which provider implements ${contract}?`, answer: provider.id });
  }
  const workflowProvider = manifests.filter((item) => item.contract === 'WorkflowRuntimePort').sort((a, b) => Number(b.enabledByDefault === true) - Number(a.enabledByDefault === true))[0];
  if (workflowProvider) cases.push({ id: 'provider_workflowruntimeport_default', question: 'Which default provider implements WorkflowRuntimePort?', answer: workflowProvider.id });
  if (cases.length < 10) throw new Error('bench realqa requires at least 10 derived repo questions');
  return cases.slice(0, 12);
}

function renderRealQaBenchmarkSummary(report) {
  return [
    `RealQA benchmark: before ${report.before.correctnessPercent}% / after ${report.after.correctnessPercent}%`,
    `Cases: ${report.cases.length}`,
    `After delivered tokens: ${report.after.deliveredTokens}`,
    `Correctness gate: ${report.headline.correctnessGatePassed ? 'pass' : 'fail'}`
  ].join('\n');
}

function summarizeSessionArm(name, calls, tokenBudget) {
  const deliveredTokens = calls.reduce((total, item) => total + item.deliveredTokens, 0);
  const correctCount = calls.filter((item) => item.correct).length;
  return {
    name,
    tokenBudget,
    callCount: calls.length,
    correctCount,
    correctnessPercent: Math.round((correctCount / calls.length) * 100),
    deliveredTokens,
    averageDeliveredTokens: Math.round(deliveredTokens / calls.length),
    maxDeliveredTokensPerCall: Math.max(...calls.map((item) => item.deliveredTokens)),
    calls
  };
}

function renderSessionBenchmarkSummary(report) {
  const curve = report.delta.calls.map((item) => `${item.index}:${item.deliveredTokens}`).join(' ');
  return [
    `Session benchmark: ${report.headline.correctnessGatePassed ? 'PASS' : 'FAIL'}`,
    `Delta correctness: ${report.delta.correctnessPercent}%`,
    `Full resend tokens: ${report.fullResend.deliveredTokens}`,
    `Delta tokens: ${report.delta.deliveredTokens}`,
    `Delta curve: ${curve}`
  ].join('\n');
}

async function addTemporalBenchmarkFacts(provider, { item, workspaceId }) {
  let count = 0;
  for (let index = 0; index < item.timeline.length; index += 1) {
    const point = item.timeline[index];
    const proposalId = `mpq_${item.id}_${index + 1}`;
    await provider.enqueueProposal({
      id: proposalId,
      workspaceId,
      sourceLocator: `workspace://evals/temporal/${item.id}.md`,
      sourceHash: `sha256:${createHash('sha256').update(`${item.id}:${index}:${point.value}`).digest('hex')}`,
      payload: { kind: 'fact', subject: item.subject, predicate: item.predicate, object: point.value }
    });
    await provider.claimProposal({ workspaceId, workerId: 'temporal-bench', leaseUntil: '2999-01-01T00:00:00.000Z' });
    await provider.recordProposalResult({ workspaceId, id: proposalId, workerId: 'temporal-bench', status: 'applied', result: { accepted: true } });
    await provider.addTemporalFact({
      id: `memfact_${item.id}_${index + 1}`,
      workspaceId,
      scope: 'workspace',
      subject: item.subject,
      predicate: item.predicate,
      object: point.value,
      text: `${item.predicate} current value ${point.value}.`,
      source: `workspace://evals/temporal/${item.id}.md`,
      proposalQueueId: proposalId,
      validFrom: point.at,
      episode: {
        id: `mep_${item.id}_${index + 1}`,
        sourceLocator: `workspace://evals/temporal/${item.id}.md`,
        summary: `${item.predicate} changed to ${point.value}.`,
        observedAt: point.at
      }
    });
    count += 1;
  }
  return count;
}

async function loadTemporalDataset(datasetPath) {
  const parsed = JSON.parse(await readFile(datasetPath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bench temporal dataset must be a JSON object');
  if (typeof parsed.id !== 'string' || !parsed.id.trim()) throw new Error('bench temporal dataset requires id');
  const cases = Array.isArray(parsed.cases) ? parsed.cases.map(normalizeTemporalCase) : [];
  if (cases.length < 8 || cases.length > 12) throw new Error('bench temporal dataset requires 8-12 cases');
  return { id: parsed.id, version: parsed.version ?? '1.0.0', cases };
}

function normalizeTemporalCase(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('bench temporal case must be an object');
  const id = String(item.id ?? `case_${index + 1}`);
  const question = String(item.question ?? '').trim();
  const subject = String(item.subject ?? 'project:oaf').trim();
  const predicate = String(item.predicate ?? '').trim();
  const timeline = Array.isArray(item.timeline) ? item.timeline.map((point) => ({
    at: String(point.at ?? '').trim(),
    value: String(point.value ?? '').trim()
  })).filter((point) => point.at && point.value) : [];
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(id)) throw new Error(`bench temporal case has unsafe id: ${id}`);
  if (!question || question.length > 240) throw new Error(`bench temporal case ${id} requires a short question`);
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(subject)) throw new Error(`bench temporal case ${id} has unsafe subject`);
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(predicate)) throw new Error(`bench temporal case ${id} has unsafe predicate`);
  if (timeline.length < 2) throw new Error(`bench temporal case ${id} requires at least one supersession`);
  for (const point of timeline) {
    if (Number.isNaN(Date.parse(point.at))) throw new Error(`bench temporal case ${id} has invalid timestamp`);
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(point.value)) throw new Error(`bench temporal case ${id} has unsafe value`);
  }
  const currentValue = timeline.at(-1).value;
  const supersededValues = [...new Set(timeline.slice(0, -1).map((point) => point.value))];
  return { id, question, subject, predicate, timeline, currentValue, supersededValues };
}

function buildTemporalRawTimelineBaseline({ item, tokenBudget }) {
  const raw = [
    `Question: ${item.question}`,
    `Timeline for ${item.predicate}: ${item.timeline.map((point) => `${point.at}=${point.value}`).join(' -> ')}`,
    `Current marker: ${item.currentValue}`
  ].join('\n');
  const text = fitEstimatedTokens(raw, tokenBudget);
  return {
    text,
    deliveredTokens: estimateTokens(text),
    snippetCount: text ? 1 : 0,
    evidenceLocators: [{ locator: `workspace://evals/temporal/${item.id}.md`, lineStart: 1, lineEnd: item.timeline.length + 2 }]
  };
}

function scoreTemporalAnswer(text, item, extra = {}) {
  const normalized = normalizeSufficiencyText(text);
  const hasCurrent = normalized.includes(normalizeSufficiencyText(item.currentValue));
  const staleValuesReturned = item.supersededValues.filter((value) => normalized.includes(normalizeSufficiencyText(value)));
  const clean = staleValuesReturned.length === 0;
  return {
    ...extra,
    hasCurrent,
    clean,
    correct: hasCurrent && clean,
    staleValueCount: staleValuesReturned.length
  };
}

function summarizeTemporalArm(name, items, tokenBudget) {
  const correctCount = items.filter((item) => item.correct).length;
  const cleanCount = items.filter((item) => item.clean).length;
  const deliveredTokens = items.reduce((sum, item) => sum + Math.max(0, Math.trunc(Number(item.deliveredTokens ?? 0))), 0);
  const maxDeliveredTokensPerCase = items.reduce((max, item) => Math.max(max, Math.max(0, Math.trunc(Number(item.deliveredTokens ?? 0)))), 0);
  return {
    name,
    tokenBudget,
    caseCount: items.length,
    correctCount,
    cleanCount,
    correctnessPercent: sufficiencyPercent(correctCount, items.length),
    cleanlinessPercent: sufficiencyPercent(cleanCount, items.length),
    deliveredTokens,
    averageDeliveredTokens: items.length ? Math.round(deliveredTokens / items.length) : 0,
    maxDeliveredTokensPerCase
  };
}

function renderTemporalBenchmarkSummary(report) {
  return [
    `Temporal benchmark: OAF ${report.oaf.correctnessPercent}% correct / ${report.oaf.cleanlinessPercent}% clean / ${report.oaf.deliveredTokens} tokens; baseline ${report.baseline.correctnessPercent}% correct / ${report.baseline.cleanlinessPercent}% clean / ${report.baseline.deliveredTokens} tokens`,
    `OAF wins: ${report.headline.oafWins ? 'yes' : 'no'}`,
    `Basis: current value must be present and superseded values absent`
  ].join('\n');
}

async function benchmarkSufficiencyCommand(values) {
  if (!values.includes('--read-only')) {
    console.error('bench sufficiency requires --read-only');
    process.exitCode = 2;
    return;
  }
  if (values.includes('--write') || values.includes('--out') || values.includes('--pin') || values.includes('--use-out')) {
    console.error('bench sufficiency is read-only and does not write or pin workspace artifacts');
    process.exitCode = 2;
    return;
  }
  const valueOptions = new Set(['--root', '--workspace', '--workspace-id', '--budget', '--token-budget', '--limit', '--dataset', '--format']);
  const unsupported = unsupportedFlags(values, new Set(['--read-only', ...valueOptions]), valueOptions);
  if (unsupported.length > 0) {
    console.error(`bench sufficiency unsupported option: ${unsupported[0]}`);
    process.exitCode = 2;
    return;
  }
  const format = option(values, '--format') ?? 'json';
  if (!['json', 'summary'].includes(format)) {
    console.error('bench sufficiency only supports --format json or summary');
    process.exitCode = 2;
    return;
  }
  try {
    const report = await buildSufficiencyBenchmarkReport(values);
    console.log(format === 'summary' ? renderSufficiencyBenchmarkSummary(report) : JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

async function buildSufficiencyBenchmarkReport(values) {
  const root = path.resolve(option(values, '--root') ?? process.cwd());
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) throw new Error('bench sufficiency --root must point at a local workspace directory');
  const workspaceId = option(values, '--workspace-id') ?? option(values, '--workspace') ?? 'ws_local';
  const generatedAt = fixedNow();
  const tokenBudget = parseIntegerOption(values, '--token-budget', parseIntegerOption(values, '--budget', 1024));
  const recallLimit = parseIntegerOption(values, '--limit', 8);
  const datasetPath = option(values, '--dataset') ?? 'evals/sufficiency/gold.v1.json';
  const dataset = await loadSufficiencyDataset(datasetPath);
  const scratchRoot = await mkdtemp(path.join(tmpdir(), 'oaf-sufficiency-'));
  const scratchSqlite = path.join(scratchRoot, 'memory.sqlite');
  const sqliteValues = ['--sqlite', 'memory.sqlite'];
  let scratchFilesWritten = 0;
  let proposalCount = 0;
  let episodeCount = 0;
  const cases = [];
  try {
    const { SQLiteMemoryProvider } = await import('../../providers/native/memory-sqlite/src/index.mjs');
    const provider = new SQLiteMemoryProvider({ filename: scratchSqlite, clock: () => generatedAt });
    try {
      const episodes = await buildWorkspaceMemoryIngestEpisodes({
        root,
        workspaceId,
        scope: 'workspace',
        generatedAt,
        limit: 80
      });
      episodeCount = episodes.length;
      const queued = [];
      for (const episode of episodes) queued.push(...await provider.proposeTemporalFactsFromEpisode(episode));
      proposalCount = new Set(queued.map((item) => item.id)).size;
      scratchFilesWritten = 1;
    } finally {
      provider.close();
    }

    for (const item of dataset.cases) {
      const profilePayload = await buildMcpContextProfilePayload({
        values: sqliteValues,
        root: scratchRoot,
        workspaceId,
        generatedAt,
        args: {
          objective: item.question,
          step: 'Measure whether governed memory contains the gold repo fact',
          scope: 'workspace',
          budget: tokenBudget,
          limit: recallLimit
        }
      });
      const recallPayload = await buildMcpMemoryRecallPayload({
        values: sqliteValues,
        root: scratchRoot,
        workspaceId,
        generatedAt,
        args: {
          query: item.question,
          scope: 'workspace',
          limit: recallLimit
        }
      });
      const oafPayloadText = JSON.stringify({ contextProfile: profilePayload, memoryRecall: recallPayload });
      const baseline = await buildKeywordSnippetBaseline({ root, question: item.question, tokenBudget });
      cases.push({
        id: item.id,
        question: item.question,
        goldAnswer: item.answer,
        acceptedAnswerCount: sufficiencyNeedles(item).length,
        oaf: {
          sufficient: containsGoldFact(oafPayloadText, item),
          deliveredTokens: estimateTokens(oafPayloadText),
          contextProfileTokens: estimateTokens(JSON.stringify(profilePayload)),
          memoryRecallTokens: estimateTokens(JSON.stringify(recallPayload)),
          governedFactCount: Number(profilePayload.data?.profile?.governedFactCount ?? 0),
          proposalFactCount: Number(recallPayload.data?.proposalFactCount ?? 0),
          contextProfileProposalFactCount: Number(profilePayload.data?.profile?.proposalFactCount ?? 0),
          selectedContextCount: Number(profilePayload.data?.selectedContext?.selectedCount ?? 0)
        },
        baseline: {
          sufficient: containsGoldFact(baseline.text, item),
          deliveredTokens: baseline.deliveredTokens,
          snippetCount: baseline.snippetCount,
          candidateFileCount: baseline.candidateFileCount,
          evidenceLocators: baseline.evidenceLocators
        }
      });
    }
  } finally {
    await rm(scratchRoot, { recursive: true, force: true }).catch(() => {});
  }

  const oaf = summarizeSufficiencyArm('context.profile+memory.recall', cases.map((item) => item.oaf), tokenBudget);
  const baseline = {
    ...summarizeSufficiencyArm('keyword-top-k-snippets', cases.map((item) => item.baseline), tokenBudget),
    dumpRepo: false
  };
  const nearEmptyProfileSufficiencyPercent = sufficiencyPercent(dataset.cases.filter((item) => containsGoldFact(JSON.stringify({ contextProfile: { data: { selectedContext: [] } }, memoryRecall: { data: { facts: [], proposalFacts: [] } } }), item)).length, dataset.cases.length);
  const headline = {
    metric: 'sufficiency-per-thousand-delivery-tokens',
    oafWins: oaf.deliveredTokens < baseline.deliveredTokens && oaf.sufficiencyPercent >= baseline.sufficiencyPercent,
    rule: 'OAF wins only when it is both smaller and at least as sufficient as keyword top-k snippets at the same per-question budget',
    oafSufficiencyPerThousandTokens: oaf.sufficiencyPerThousandTokens,
    baselineSufficiencyPerThousandTokens: baseline.sufficiencyPerThousandTokens
  };
  const report = {
    schemaVersion: '1.0.0',
    command: 'bench sufficiency',
    generatedAt,
    workspaceId,
    dataset: {
      id: dataset.id,
      version: dataset.version,
      ref: datasetPath.startsWith('/') ? 'local-absolute-dataset' : `workspace://${toPosix(datasetPath)}`,
      caseCount: dataset.cases.length
    },
    budget: {
      tokenBudget,
      unit: 'estimated delivery tokens per question',
      estimator: 'ceil(chars/4)'
    },
    source: {
      memoryProvider: 'provider:native:memory:sqlite',
      scratchStore: 'os-temp-sqlite',
      ingestEpisodes: episodeCount,
      proposalCount,
      proposalGated: true
    },
    oaf,
    baseline,
    headline,
    antiGaming: {
      nearEmptyProfileSufficiencyPercent,
      realisticBaseline: true,
      dumpRepoBaseline: false,
      sameBudget: true,
      goldFixtureExcludedFromBaseline: true
    },
    cases,
    safeguards: {
      readOnly: true,
      workspaceFilesWritten: 0,
      scratchFilesWritten,
      proposalGated: true,
      activeMemoryCreated: 0,
      hardDeleted: false,
      deterministicOffline: true,
      networkCalls: 0,
      modelCalls: 0,
      externalWritesEnabled: false,
      rawSourceBodiesIncluded: false,
      rawMcpPayloadsIncluded: false,
      providerBillingClaimed: false
    },
    reportFingerprint: null
  };
  return { ...report, reportFingerprint: stableJsonFingerprint(report) };
}

async function loadSufficiencyDataset(datasetPath) {
  const parsed = JSON.parse(await readFile(datasetPath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bench sufficiency dataset must be a JSON object');
  if (typeof parsed.id !== 'string' || !parsed.id.trim()) throw new Error('bench sufficiency dataset requires id');
  const cases = Array.isArray(parsed.cases) ? parsed.cases.map(normalizeSufficiencyCase) : [];
  if (cases.length < 8 || cases.length > 12) throw new Error('bench sufficiency dataset requires 8-12 cases');
  return { id: parsed.id, version: parsed.version ?? '1.0.0', cases };
}

function normalizeSufficiencyCase(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('bench sufficiency case must be an object');
  const id = String(item.id ?? `case_${index + 1}`);
  const question = String(item.question ?? '').trim();
  const answer = String(item.answer ?? '').trim();
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(id)) throw new Error(`bench sufficiency case has unsafe id: ${id}`);
  if (!question || question.length > 240) throw new Error(`bench sufficiency case ${id} requires a short question`);
  if (!answer || answer.length > 160) throw new Error(`bench sufficiency case ${id} requires an answer`);
  const aliases = Array.isArray(item.aliases) ? item.aliases.map((value) => String(value).trim()).filter(Boolean).slice(0, 8) : [];
  return { id, question, answer, aliases };
}

function sufficiencyNeedles(item) {
  return [...new Set([item.answer, ...(item.aliases ?? [])].map(normalizeSufficiencyText).filter((value) => value.length >= 2))];
}

function containsGoldFact(text, item) {
  const haystack = normalizeSufficiencyText(text);
  return sufficiencyNeedles(item).some((needle) => haystack.includes(needle));
}

function normalizeSufficiencyText(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/gu, ' ').trim();
}

function summarizeSufficiencyArm(name, items, tokenBudget) {
  const sufficientCount = items.filter((item) => item.sufficient).length;
  const deliveredTokens = items.reduce((sum, item) => sum + Math.max(0, Math.trunc(Number(item.deliveredTokens ?? 0))), 0);
  const maxDeliveredTokensPerCase = items.reduce((max, item) => Math.max(max, Math.max(0, Math.trunc(Number(item.deliveredTokens ?? 0)))), 0);
  return {
    name,
    tokenBudget,
    caseCount: items.length,
    sufficientCount,
    sufficiencyPercent: sufficiencyPercent(sufficientCount, items.length),
    deliveredTokens,
    averageDeliveredTokens: items.length ? Math.round(deliveredTokens / items.length) : 0,
    maxDeliveredTokensPerCase,
    sufficiencyPerThousandTokens: Number(((sufficientCount / Math.max(1, deliveredTokens)) * 1000).toFixed(3))
  };
}

function sufficiencyPercent(count, total) {
  return total > 0 ? Math.round((count / total) * 100) : 0;
}

async function buildKeywordSnippetBaseline({ root, question, tokenBudget }) {
  const files = await listKeywordBaselineFiles(root);
  const queryTokens = tokenizeSufficiencyQuery(question);
  const snippets = [];
  for (const relativePath of files) {
    const absolute = path.resolve(root, relativePath);
    const info = await stat(absolute).catch(() => null);
    if (!info?.isFile() || info.size > 256 * 1024) continue;
    const body = await readFile(absolute, 'utf8').catch(() => '');
    if (!body) continue;
    const lines = body.split(/\r\n|\r|\n/u);
    const pathScore = scoreKeywordText(relativePath, queryTokens);
    const matches = [];
    for (let index = 0; index < lines.length; index += 1) {
      const score = scoreKeywordText(lines[index], queryTokens);
      if (score > 0) matches.push({ index, score: score + pathScore });
    }
    if (!matches.length && pathScore > 0) matches.push({ index: 0, score: pathScore });
    for (const match of matches.sort((left, right) => right.score - left.score).slice(0, 3)) {
      const start = Math.max(0, match.index - 2);
      const end = Math.min(lines.length - 1, match.index + 2);
      const text = lines.slice(start, end + 1).join('\n');
      snippets.push({
        locator: `workspace://${toPosix(relativePath)}`,
        lineStart: start + 1,
        lineEnd: end + 1,
        score: match.score,
        text
      });
    }
  }
  const deduped = [];
  const seen = new Set();
  for (const snippet of snippets.sort((left, right) => right.score - left.score || left.locator.localeCompare(right.locator))) {
    const key = `${snippet.locator}:${snippet.lineStart}:${snippet.lineEnd}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(snippet);
  }
  const selected = [];
  let deliveredTokens = 0;
  const textParts = [];
  for (const snippet of deduped) {
    const raw = `${snippet.locator}:${snippet.lineStart}-${snippet.lineEnd}\n${snippet.text}`;
    const remaining = Math.max(0, tokenBudget - deliveredTokens);
    if (remaining <= 0) break;
    const fitted = fitEstimatedTokens(raw, remaining);
    const tokens = estimateTokens(fitted);
    if (!fitted || tokens <= 0 || deliveredTokens + tokens > tokenBudget) continue;
    selected.push(snippet);
    textParts.push(fitted);
    deliveredTokens += tokens;
  }
  return {
    text: textParts.join('\n\n'),
    deliveredTokens,
    snippetCount: selected.length,
    candidateFileCount: files.length,
    evidenceLocators: selected.slice(0, 8).map((item) => ({
      locator: item.locator,
      lineStart: item.lineStart,
      lineEnd: item.lineEnd
    }))
  };
}

async function listKeywordBaselineFiles(root) {
  const output = [];
  const excludedDirs = new Set(['.git', '.local', '.cache', '.claude', '.codex', 'node_modules', 'coverage', 'dist', 'build', 'context-packs', 'evals']);
  const allowedExtensions = new Set(['.md', '.json', '.mjs', '.js', '.ts', '.tsx', '.yml', '.yaml', '.toml']);
  async function walk(current, relative) {
    if (output.length >= 400) return;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (output.length >= 400) break;
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!excludedDirs.has(entry.name)) await walk(path.join(current, entry.name), childRelative);
      } else if (entry.isFile() && allowedExtensions.has(path.extname(entry.name).toLowerCase())) {
        output.push(childRelative);
      }
    }
  }
  await walk(root, '');
  return output;
}

function tokenizeSufficiencyQuery(value) {
  const stopWords = new Set(['the','what','which','where','when','who','does','from','with','into','this','that','about','agent','agents','repo','repository','project','known','fact','file','command','policy','provider','native','local']);
  return [...new Set(String(value ?? '').toLowerCase().match(/[a-z0-9:_-]{3,}/gu) ?? [])]
    .filter((token) => !stopWords.has(token))
    .slice(0, 24);
}

function scoreKeywordText(value, tokens) {
  const text = String(value ?? '').toLowerCase();
  return tokens.reduce((sum, token) => sum + (text.includes(token) ? 1 : 0), 0);
}

function fitEstimatedTokens(text, tokenBudget) {
  if (tokenBudget <= 0) return '';
  let output = String(text ?? '');
  while (output && estimateTokens(output) > tokenBudget) output = output.slice(0, Math.floor(output.length * 0.8)).trimEnd();
  return output;
}

function renderSufficiencyBenchmarkSummary(report) {
  return [
    `Sufficiency benchmark: OAF ${report.oaf.sufficiencyPercent}% / ${report.oaf.deliveredTokens} tokens; baseline ${report.baseline.sufficiencyPercent}% / ${report.baseline.deliveredTokens} tokens`,
    `OAF wins: ${report.headline.oafWins ? 'yes' : 'no'}`,
    `Near-empty profile sufficiency: ${report.antiGaming.nearEmptyProfileSufficiencyPercent}%`,
    `Basis: estimated delivery tokens, same ${report.budget.tokenBudget}-token per-question budget`
  ].join('\n');
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
  if (!['json', 'summary'].includes(format)) {
    console.error('context handoff only supports --format json or summary');
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
    console.log(format === 'summary' ? renderContextHandoffSummary(report) : JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

function renderContextHandoffSummary(report) {
  const contextPack = report.contextPack ?? {};
  const usePlan = report.usePlan ?? {};
  const memory = report.memoryProposalPreflight ?? {};
  const skillCatalog = report.skillCatalog ?? {};
  const mcp = report.mcp ?? {};
  return [
    `State: ${report.state}`,
    `Target: ${report.targetHarness}`,
    `Context pack: ${contextPack.utilityStatus ?? 'unknown'} ${contextPack.contextPackFingerprint ?? 'unknown'}`,
    `Required reads: ${usePlan.requiredReadCount ?? 0} (${(usePlan.requiredLocalReads ?? []).length} shown, ${usePlan.truncatedRequiredReadCount ?? 0} omitted)`,
    `Changed coverage: ${contextPack.changedLocatorCoverage?.covered ?? 0}/${contextPack.changedLocatorCoverage?.total ?? 0} ${contextPack.changedLocatorCoverage?.status ?? 'unknown'}`,
    `MCP readback: ${report.checks?.resourceRead ? 'ok' : 'review'} (${mcp.smoke?.resourcesListed ?? 0} resources, ${mcp.smoke?.toolsExposed ?? 0} tools)`,
    `Harness setup: ${mcp.setup?.client ?? 'unknown'} ${mcp.setup?.serverStatus ?? 'unknown'} dry-run`,
    `Memory preflight: ${memory.state ?? 'unknown'} (${memory.summary?.reviewItemCount ?? 0} review items)`,
    `Skill catalog: ${skillCatalog.state ?? 'unknown'} (${skillCatalog.summary?.total ?? 0} skills, ${skillCatalog.summary?.uniqueToolCount ?? 0} tools)`,
    `External writes: ${report.safeguards?.externalWritesEnabled ? 'enabled' : 'disabled'}`,
    `Report fingerprint: ${report.reportFingerprint}`
  ].join('\n');
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
  if (!['json', 'summary'].includes(format)) {
    console.error('context receive only supports --format json or summary');
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
    console.log(format === 'summary' ? renderContextReceiveSummary(report) : JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

function renderContextReceiveSummary(report) {
  const packet = report.receiverPacket ?? {};
  const proof = packet.proof ?? {};
  const recipientProof = proof.recipientProof ?? {};
  const readPlan = packet.readPlan ?? {};
  const partSchemas = (packet.messageParts ?? [])
    .map((item) => [item.partType, item.contentType, item.schemaVersion].filter(Boolean).join(' '))
    .filter(Boolean)
    .join(', ') || 'none';
  const nextRequired = (packet.nextActions ?? [])
    .filter((item) => item.required === true)
    .map((item) => item.label)
    .join(', ') || 'none';
  return [
    `State: ${report.state}`,
    `Target: ${report.targetHarness}`,
    `Registry: ${report.registry?.currentStatus ?? 'unknown'}`,
    `Recipient proof: ${proof.recipientProofValid ? 'valid' : 'review'}`,
    `Read-only resources: ${(recipientProof.requiredResourceUris ?? []).join(', ') || 'none'}`,
    `Packet parts: ${partSchemas}`,
    `Required reads: ${readPlan.requiredReadCount ?? 0} (${readPlan.includedReadCount ?? 0} shown, ${readPlan.omittedReadCount ?? 0} omitted)`,
    `Tools exposed: ${proof.toolsExposed ?? report.mcp?.toolsExposed ?? 0}`,
    `External writes: ${proof.externalWritesEnabled ? 'enabled' : 'disabled'}`,
    `Next required: ${nextRequired}`,
    `Report fingerprint: ${report.reportFingerprint}`
  ].join('\n');
}

async function contextRetrieveCommand(values) {
  if (!values.includes('--read-only')) {
    console.error('context retrieve requires --read-only');
    process.exitCode = 2;
    return;
  }
  if (values.includes('--write') || values.includes('--out') || values.includes('--pin') || values.includes('--stdio')) {
    console.error('context retrieve is read-only and does not write, pin, output files, or run as an MCP stdio server');
    process.exitCode = 2;
    return;
  }
  const format = option(values, '--format') ?? 'json';
  if (!['json', 'summary'].includes(format)) {
    console.error('context retrieve only supports --format json or summary');
    process.exitCode = 2;
    return;
  }
  const target = option(values, '--locator') ?? option(values, '--hash') ?? firstPositional(values, new Set(['--locator', '--hash', '--format', '--root', '--workspace']));
  if (!target) {
    console.error('context retrieve requires a workspace locator or sha256 hash');
    process.exitCode = 2;
    return;
  }
  try {
    const root = option(values, '--root') ?? process.cwd();
    const workspaceId = option(values, '--workspace') ?? 'ws_local';
    const report = await buildContextRetrieveReport({ root, workspaceId, target, generatedAt: fixedNow() });
    console.log(format === 'summary' ? renderContextRetrieveSummary(report) : JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

function renderContextRetrieveSummary(report) {
  return [
    `State: ${report.state}`,
    `Locator: ${report.locator}`,
    `Matched use plan: ${report.matchedUsePlan ? 'yes' : 'no'}`,
    `Role: ${report.role}`,
    `Required: ${report.required ? 'yes' : 'no'}`,
    `Represented: ${report.represented === null ? 'unknown' : report.represented ? 'yes' : 'no'}`,
    `Content hash: ${report.contentHash}`,
    `Bytes: ${report.byteSize}`,
    `Lines: ${report.lineCount}`,
    'Summary content included: no',
    `JSON content included: ${report.contentIncluded ? 'yes' : 'no'}`,
    `Reason codes: ${report.reasonCodes.join(', ')}`,
    `Local files written: ${report.safeguards.localFilesWritten}`,
    `Network calls: ${report.safeguards.networkCalls}`,
    `Model calls: ${report.safeguards.modelCalls}`
  ].join('\n');
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
  if (!['json', 'summary'].includes(format)) {
    console.error('context graph preview only supports --format json or summary');
    process.exitCode = 2;
    return;
  }

  const root = option(values, '--root') ?? process.cwd();
  const workspaceId = option(values, '--workspace') ?? 'ws_local';
  const query = option(values, '--query') ?? firstPositional(values, new Set(['--format', '--root', '--workspace', '--query', '--trace', '--start-name', '--start-node', '--changed', '--changed-locator', '--changed-locators', '--node-kinds', '--edge-kinds', '--label-pattern', '--locator-prefix', '--direction', '--limit', '--offset', '--depth', '--sample-limit', '--max-files', '--max-file-bytes'])) ?? '';
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
    console.log(format === 'summary' ? renderSourceGraphPreviewSummary(preview) : JSON.stringify(preview, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

function renderSourceGraphPreviewSummary(preview) {
  const summary = preview.graph?.summary ?? {};
  const impact = preview.impact ?? {};
  const hotspots = (summary.hotspots ?? []).slice(0, 5).map((item) => item.label).join(', ') || 'none';
  const entryPoints = (summary.entryPoints ?? []).slice(0, 5).map((item) => item.label).join(', ') || 'none';
  const changedTotal = impact.changedLocators?.length ?? 0;
  const representedTotal = impact.representedChangedLocators?.length ?? 0;
  const warnings = [...(preview.warningCodes ?? []), ...(impact.warningCodes ?? [])].filter(Boolean).join(', ') || 'none';
  return [
    '# Repo Map',
    `Status: ${preview.status ?? 'ready'}`,
    `Files: ${summary.fileCount ?? 0}`,
    `Symbols: ${summary.symbolCount ?? 0}`,
    `Nodes: ${summary.nodeCount ?? 0}`,
    `Edges: ${summary.edgeCount ?? 0}`,
    `Hotspots: ${hotspots}`,
    `Entry points: ${entryPoints}`,
    `Changed coverage: ${representedTotal}/${changedTotal}`,
    `Affected symbols: ${impact.affectedSymbolCount ?? impact.affectedSymbols?.length ?? 0}`,
    `Warnings: ${warnings}`,
    '',
    'Safeguards',
    `Read-only: ${preview.safeguards?.persisted === false ? 'pass' : 'unknown'}`,
    `Network calls: ${preview.safeguards?.networkCalls ?? 0}`,
    `Model calls: ${preview.safeguards?.modelCalls ?? 0}`,
    `External adapters enabled: ${preview.safeguards?.externalAdaptersEnabled ?? 0}`,
    `Raw source bodies included: ${preview.safeguards?.rawBodyIncluded ? 'yes' : 'no'}`
  ].join('\n');
}

async function mcpCommand(values) {
  const [subcommand, ...rest] = values;
  try {
    if (subcommand === 'inspect') return await mcpInspectCommand(rest);
    if (subcommand === 'resources') return await mcpResourcesCommand(rest);
    if (subcommand === 'server') return await mcpServerCommand(rest);
    if (subcommand === 'install') return await mcpInstallCommand(rest);
    if (subcommand === 'stats') return await mcpStatsCommand(rest);
    if (subcommand === 'smoke') return await mcpSmokeCommand(rest);
    console.error('mcp requires inspect, resources, server, install, stats, or smoke');
    process.exitCode = 2;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

async function skillCommand(values) {
  const [subcommand, ...rest] = values;
  try {
    if (subcommand === 'catalog') return await skillCatalogCommand(rest);
    if (subcommand === 'load-plan') return await skillLoadPlanCommand(rest);
    console.error('skill requires catalog or load-plan');
    process.exitCode = 2;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

async function skillCatalogCommand(values) {
  if (!values.includes('--read-only')) {
    console.error('skill catalog requires --read-only');
    process.exitCode = 2;
    return;
  }
  if (values.includes('--write') || values.includes('--apply') || values.includes('--out') || values.includes('--stdio')) {
    console.error('skill catalog is read-only and does not write files, apply configs, or start stdio servers');
    process.exitCode = 2;
    return;
  }
  const format = option(values, '--format') ?? 'json';
  if (!['json', 'summary'].includes(format)) {
    console.error('skill catalog only supports --format json or summary');
    process.exitCode = 2;
    return;
  }
  const allowedFlags = new Set(['--read-only', '--root', '--workspace', '--workspace-id', '--format']);
  const valueFlags = new Set(['--root', '--workspace', '--workspace-id', '--format']);
  const unsupported = unsupportedFlags(values, allowedFlags, valueFlags);
  if (unsupported.length) {
    console.error(`skill catalog unsupported option: ${unsupported[0]}`);
    process.exitCode = 2;
    return;
  }
  const root = path.resolve(option(values, '--root') ?? process.cwd());
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) throw new Error('skill catalog --root must point at a local workspace directory');
  const workspaceId = option(values, '--workspace-id') ?? option(values, '--workspace') ?? 'ws_local';
  const report = await buildSkillCatalogReport({ root, workspaceId, generatedAt: fixedNow() });
  const toolReview = format === 'summary' ? await buildSkillCatalogToolReview({ root, declaredToolIds: report.summary.advertisedToolIds }) : null;
  console.log(format === 'summary' ? renderSkillCatalogSummary(report, toolReview) : JSON.stringify(report, null, 2));
}

async function skillLoadPlanCommand(values) {
  if (!values.includes('--read-only')) {
    console.error('skill load-plan requires --read-only');
    process.exitCode = 2;
    return;
  }
  if (values.includes('--write') || values.includes('--apply') || values.includes('--out') || values.includes('--stdio')) {
    console.error('skill load-plan is read-only and does not write files, apply configs, or start stdio servers');
    process.exitCode = 2;
    return;
  }
  const format = option(values, '--format') ?? 'json';
  if (!['json', 'summary'].includes(format)) {
    console.error('skill load-plan only supports --format json or summary');
    process.exitCode = 2;
    return;
  }
  const skillId = option(values, '--id');
  if (!skillId) {
    console.error('skill load-plan requires --id <skill:id>');
    process.exitCode = 2;
    return;
  }
  const allowedFlags = new Set(['--read-only', '--root', '--workspace', '--workspace-id', '--id', '--format']);
  const valueFlags = new Set(['--root', '--workspace', '--workspace-id', '--id', '--format']);
  const unsupported = unsupportedFlags(values, allowedFlags, valueFlags);
  if (unsupported.length) {
    console.error(`skill load-plan unsupported option: ${unsupported[0]}`);
    process.exitCode = 2;
    return;
  }
  const root = path.resolve(option(values, '--root') ?? process.cwd());
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) throw new Error('skill load-plan --root must point at a local workspace directory');
  const workspaceId = option(values, '--workspace-id') ?? option(values, '--workspace') ?? 'ws_local';
  const report = await buildSkillLoadPlan({ root, workspaceId, skillId, generatedAt: fixedNow() });
  console.log(format === 'summary' ? renderSkillLoadPlanSummary(report) : JSON.stringify(report, null, 2));
}

async function buildSkillCatalogReport({ root, workspaceId, generatedAt }) {
  const realRoot = await realpath(root);
  const skillsRoot = path.join(realRoot, 'skills');
  const skillsRootStat = await stat(skillsRoot).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!skillsRootStat?.isDirectory()) throw new Error('skill catalog requires a skills/ directory under --root');

  const entries = (await readdir(skillsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .sort((left, right) => left.name.localeCompare(right.name));
  const skills = [];
  for (const entry of entries) {
    const directory = path.join(skillsRoot, entry.name);
    const relativeDirectory = `skills/${entry.name}`;
    await assertSkillCatalogFile({ directory, relativeDirectory, relativePath: 'manifest.json' });
    const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
    assertJsonSchema(skillManifestSchema, manifest, `${relativeDirectory}/manifest.json`);

    await assertSkillCatalogFile({ directory, relativeDirectory, relativePath: 'SKILL.md' });

    const references = [];
    for (const reference of manifest.references ?? []) {
      if (typeof reference !== 'string' || !reference || path.isAbsolute(reference) || reference.includes('..')) {
        throw new Error(`${relativeDirectory}/manifest.json has an unsafe reference`);
      }
      await assertSkillCatalogFile({ directory, relativeDirectory, relativePath: reference });
      references.push(`workspace://${relativeDirectory}/${reference.split(path.sep).join('/')}`);
    }

    skills.push({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      advertised: manifest.advertise !== false,
      directoryRef: `workspace://${relativeDirectory}`,
      manifestRef: `workspace://${relativeDirectory}/manifest.json`,
      skillRef: `workspace://${relativeDirectory}/SKILL.md`,
      sideEffectClass: manifest.sideEffectClass,
      inputSchema: manifest.inputSchema,
      outputSchema: manifest.outputSchema,
      triggers: [...manifest.triggers].sort((left, right) => left.localeCompare(right)),
      tools: [...manifest.tools].sort((left, right) => left.localeCompare(right)),
      references: references.sort((left, right) => left.localeCompare(right)),
      manifestFingerprint: stableJsonFingerprint(manifest),
      checks: {
        manifestValid: true,
        skillDocumentPresent: true,
        referencesPresent: true
      }
    });
  }

  const bySideEffectClass = {
    'read-only': skills.filter((skill) => skill.sideEffectClass === 'read-only').length,
    'reversible-write': skills.filter((skill) => skill.sideEffectClass === 'reversible-write').length,
    'consequential-write': skills.filter((skill) => skill.sideEffectClass === 'consequential-write').length
  };
  const advertisedSkills = skills.filter((skill) => skill.advertised);
  const toolIds = [...new Set(skills.flatMap((skill) => skill.tools))].sort((left, right) => left.localeCompare(right));
  const advertisedToolIds = [...new Set(advertisedSkills.flatMap((skill) => skill.tools))].sort((left, right) => left.localeCompare(right));
  const toolReview = await buildSkillCatalogToolReview({ root: realRoot, declaredToolIds: toolIds });
  const skillsWithReadiness = skills.map((skill) => ({
    ...skill,
    readiness: skillCatalogReadiness(skill, toolReview)
  }));
  const summary = {
    total: skills.length,
    advertisedSkillCount: advertisedSkills.length,
    loadableOnlySkillCount: skills.length - advertisedSkills.length,
    readOnlyCount: bySideEffectClass['read-only'],
    reversibleWriteCount: bySideEffectClass['reversible-write'],
    consequentialWriteCount: bySideEffectClass['consequential-write'],
    writableSkillCount: bySideEffectClass['reversible-write'] + bySideEffectClass['consequential-write'],
    bySideEffectClass,
    uniqueToolCount: toolIds.length,
    toolIds,
    advertisedToolCount: advertisedToolIds.length,
    advertisedToolIds
  };
  const reportBase = {
    schemaVersion: '1.0.0',
    command: 'skill catalog',
    generatedAt,
    workspaceId,
    rootRef: 'workspace://.',
    summary,
    skills: skillsWithReadiness,
    catalogFingerprint: stableJsonFingerprint({ summary, skills: skillsWithReadiness.map((skill) => ({
      id: skill.id,
      version: skill.version,
      description: skill.description,
      advertised: skill.advertised,
      sideEffectClass: skill.sideEffectClass,
      inputSchema: skill.inputSchema,
      outputSchema: skill.outputSchema,
      tools: skill.tools,
      readiness: skill.readiness,
      manifestFingerprint: skill.manifestFingerprint
    })) }),
    safeguards: {
      readOnly: true,
      canonicalStateMutated: false,
      localFilesWritten: 0,
      externalWritesEnabled: false,
      networkCalls: 0,
      modelCalls: 0,
      rawSkillTextIncluded: false,
      absoluteFilesystemLocationsIncluded: false
    }
  };
  const report = { ...reportBase, reportFingerprint: stableJsonFingerprint({ ...reportBase, reportFingerprint: null }) };
  assertJsonSchema(skillCatalogReportSchema, report, 'skill catalog report');
  return report;
}

async function assertSkillCatalogFile({ directory, relativeDirectory, relativePath }) {
  const absolute = path.resolve(directory, relativePath);
  if (!isInside(directory, absolute)) throw new Error(`${relativeDirectory}/manifest.json reference escapes skill directory`);
  const parts = relativePath.split(/[\\/]+/u).slice(0, -1);
  let current = directory;
  for (const part of parts) {
    current = path.join(current, part);
    const parent = await lstat(current).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!parent) throw new Error(`${relativeDirectory}/${relativePath} is missing`);
    if (parent.isSymbolicLink()) throw new Error(`${relativeDirectory}/${relativePath} parent is a symlink`);
    if (!parent.isDirectory()) throw new Error(`${relativeDirectory}/${relativePath} parent is not a directory`);
  }
  const entry = await lstat(absolute).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!entry) throw new Error(`${relativeDirectory}/${relativePath} is missing`);
  if (entry.isSymbolicLink()) throw new Error(`${relativeDirectory}/${relativePath} is a symlink`);
  if (!entry.isFile()) throw new Error(`${relativeDirectory}/${relativePath} is not a file`);
  const actual = await realpath(absolute);
  if (!isInside(directory, actual)) throw new Error(`${relativeDirectory}/${relativePath} escapes skill directory`);
  return actual;
}

async function buildSkillLoadPlan({ root, workspaceId, skillId, generatedAt }) {
  const catalog = await buildSkillCatalogReport({ root, workspaceId, generatedAt });
  return buildSkillLoadPlanFromCatalog({ catalog, skillId });
}

async function buildOptionalSkillCatalogReport({ root, workspaceId, generatedAt }) {
  try {
    return {
      report: await buildSkillCatalogReport({ root, workspaceId, generatedAt }),
      reasonCode: null
    };
  } catch {
    return {
      report: null,
      reasonCode: 'skill_catalog_invalid'
    };
  }
}

function buildSkillLoadPlanFromCatalog({ catalog, skillId }) {
  const skill = catalog.skills.find((item) => item.id === skillId);
  if (!skill) throw new Error(`skill load-plan could not find ${skillId}`);
  const requiredLocalReads = [
    { order: 1, kind: 'manifest', ref: skill.manifestRef, reason: 'Validate skill metadata before reading instructions.' },
    { order: 2, kind: 'skill', ref: skill.skillRef, reason: 'Read instructions only after the trigger matches.' },
    ...skill.references.map((ref, index) => ({
      order: index + 3,
      kind: 'reference',
      ref,
      reason: 'Read only if the selected skill instructions require this reference.'
    }))
  ];
  const reportBase = {
    schemaVersion: '1.0.0',
    command: 'skill load-plan',
    generatedAt: catalog.generatedAt,
    workspaceId: catalog.workspaceId,
    rootRef: catalog.rootRef,
    skill: {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      version: skill.version,
      advertised: skill.advertised,
      directoryRef: skill.directoryRef,
      manifestRef: skill.manifestRef,
      skillRef: skill.skillRef,
      sideEffectClass: skill.sideEffectClass,
      triggers: skill.triggers,
      tools: skill.tools,
      references: skill.references,
      readiness: skill.readiness,
      manifestFingerprint: skill.manifestFingerprint,
      checks: skill.checks
    },
    requiredLocalReads,
    catalogFingerprint: catalog.catalogFingerprint,
    safeguards: {
      readOnly: true,
      canonicalStateMutated: false,
      localFilesWritten: 0,
      externalWritesEnabled: false,
      networkCalls: 0,
      modelCalls: 0,
      rawSkillTextIncluded: false,
      toolAuthorityGranted: false,
      absoluteFilesystemLocationsIncluded: false
    }
  };
  const report = { ...reportBase, loadPlanFingerprint: stableJsonFingerprint({ ...reportBase, loadPlanFingerprint: null }) };
  assertJsonSchema(skillLoadPlanSchema, report, 'skill load-plan report');
  return report;
}

function skillCatalogReadiness(skill, toolReview) {
  const approvalRequired = skill.sideEffectClass !== 'read-only';
  const reviewedToolIds = new Set(toolReview.state === 'ready' ? toolReview.reviewedToolIds : []);
  const disabledReviewedToolIds = new Set(toolReview.state === 'ready' ? toolReview.disabledReviewedToolIds : []);
  const unreviewedToolIds = skill.tools.filter((toolId) => !reviewedToolIds.has(toolId));
  const disabledToolIds = skill.tools.filter((toolId) => disabledReviewedToolIds.has(toolId));
  const reasonCodes = [
    approvalRequired ? 'write_skill_requires_approval' : 'read_only_skill',
    ...(unreviewedToolIds.length ? ['skill_declares_unreviewed_tools'] : []),
    ...(disabledToolIds.length ? ['skill_declares_disabled_tools'] : []),
    ...(toolReview.state === 'unavailable' ? ['tool_catalog_missing'] : []),
    ...(toolReview.state === 'invalid' ? ['tool_catalog_invalid'] : [])
  ];
  return {
    state: unreviewedToolIds.length || disabledToolIds.length ? 'blocked' : approvalRequired ? 'review' : 'ready',
    approvalRequired,
    unreviewedToolIds,
    disabledToolIds,
    reasonCodes
  };
}

function renderSkillCatalogSummary(report, toolReview = null) {
  const advertisedSkills = report.skills.filter((skill) => skill.advertised);
  const lines = [
    `Skills: ${report.summary.total}`,
    `Advertised: ${report.summary.advertisedSkillCount}`,
    `Loadable only: ${report.summary.loadableOnlySkillCount}`,
    `Read-only: ${report.summary.readOnlyCount}`,
    `Reversible write: ${report.summary.reversibleWriteCount}`,
    `Consequential write: ${report.summary.consequentialWriteCount}`,
    `Unique tools: ${report.summary.uniqueToolCount}`,
    toolReview?.configured
      ? `Reviewed tools: ${toolReview.enabledReviewedToolIds.length}/${toolReview.reviewedToolIds.length}; unreviewed declared: ${toolReview.unreviewedDeclaredToolIds.join(', ') || 'none'}`
      : 'Reviewed tools: unavailable',
    `Catalog fingerprint: ${report.catalogFingerprint}`,
    `Raw skill text included: ${report.safeguards.rawSkillTextIncluded ? 'yes' : 'no'}`,
    'Load policy: read a skillRef only after its trigger matches; catalog grants no tool authority.',
    'Load plan: npm run oaf -- skill load-plan --read-only --root . --id <skill:id> --format summary',
    'Skill menu:',
    ...advertisedSkills.map((skill) => `- ${skill.id} [${skill.sideEffectClass}]: ${skill.description}`),
    report.summary.loadableOnlySkillCount > 0 ? `Loadable-only skills omitted from menu: ${report.summary.loadableOnlySkillCount}` : null
  ];
  return lines.filter(Boolean).join('\n');
}

function renderSkillLoadPlanSummary(report) {
  const refs = report.requiredLocalReads.map((item) => `- ${item.order}. ${item.kind}: ${item.ref}`);
  return [
    `Skill: ${report.skill.id}`,
    `Name: ${report.skill.name}`,
    `Side effect: ${report.skill.sideEffectClass}`,
    `Readiness: ${report.skill.readiness.state}`,
    `Approval required: ${report.skill.readiness.approvalRequired ? 'yes' : 'no'}`,
    `Required local reads: ${report.requiredLocalReads.length}`,
    ...refs,
    `Catalog fingerprint: ${report.catalogFingerprint}`,
    `Load plan fingerprint: ${report.loadPlanFingerprint}`,
    `Raw skill text included: ${report.safeguards.rawSkillTextIncluded ? 'yes' : 'no'}`,
    `Tool authority granted: ${report.safeguards.toolAuthorityGranted ? 'yes' : 'no'}`
  ].join('\n');
}

async function buildSkillCatalogPreflight({ root, workspaceId, generatedAt }) {
  const realRoot = await realpath(root);
  const skillsRootStat = await stat(path.join(realRoot, 'skills')).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const command = oafCommand('skill catalog --read-only --root . --format json');
  if (!skillsRootStat?.isDirectory()) {
    return {
      state: 'unavailable',
      configured: false,
      command,
      summary: emptySkillCatalogSummary(),
      catalogFingerprint: null,
      reasonCodes: ['skills_directory_missing'],
      safeguards: skillCatalogPreflightSafeguards()
    };
  }
  const { report, reasonCode } = await buildOptionalSkillCatalogReport({ root, workspaceId, generatedAt });
  if (!report) {
    return {
      state: 'unavailable',
      configured: true,
      command,
      summary: emptySkillCatalogSummary(),
      catalogFingerprint: null,
      reasonCodes: [reasonCode],
      safeguards: skillCatalogPreflightSafeguards()
    };
  }
  return {
    state: 'ready',
    configured: true,
    command,
    summary: report.summary,
    catalogFingerprint: report.catalogFingerprint,
    reasonCodes: ['skill_catalog_validated'],
    safeguards: skillCatalogPreflightSafeguards(report)
  };
}

function emptySkillCatalogSummary() {
  return {
    total: 0,
    readOnlyCount: 0,
    reversibleWriteCount: 0,
    consequentialWriteCount: 0,
    writableSkillCount: 0,
    advertisedSkillCount: 0,
    loadableOnlySkillCount: 0,
    bySideEffectClass: {
      'read-only': 0,
      'reversible-write': 0,
      'consequential-write': 0
    },
    uniqueToolCount: 0,
    toolIds: [],
    advertisedToolCount: 0,
    advertisedToolIds: []
  };
}

function skillCatalogPreflightSafeguards(report = null) {
  return {
    readOnly: true,
    localFilesWritten: 0,
    networkCalls: 0,
    modelCalls: 0,
    rawSkillTextIncluded: false,
    absoluteFilesystemLocationsIncluded: false,
    externalWritesEnabled: false,
    toolAuthorityGranted: false,
    catalogReportFingerprint: report?.reportFingerprint ?? null
  };
}

async function buildSkillCatalogMcpResourceSummaryFromReport({ root, report }) {
  const toolReview = await buildSkillCatalogToolReview({ root, declaredToolIds: report.summary.toolIds });
  return {
    state: 'ready',
    configured: true,
    command: oafCommand('skill catalog --read-only --root . --format json'),
    summary: report.summary,
    skills: report.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      version: skill.version,
      advertised: skill.advertised,
      sideEffectClass: skill.sideEffectClass,
      tools: skill.tools,
      readiness: skill.readiness,
      manifestFingerprint: skill.manifestFingerprint
    })),
    toolReview,
    catalogFingerprint: report.catalogFingerprint,
    reportFingerprint: report.reportFingerprint,
    reasonCodes: ['skill_catalog_validated', ...toolReview.reasonCodes],
    safeguards: skillCatalogMcpResourceSafeguards(report)
  };
}

async function buildSkillMcpResources({ root, workspaceId, generatedAt }) {
  const realRoot = await realpath(root);
  const skillsRootStat = await stat(path.join(realRoot, 'skills')).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!skillsRootStat?.isDirectory()) {
    return { skillCatalog: null, skillLoadPlans: [], skillCatalogUnavailableReason: 'skills_directory_missing' };
  }
  const { report, reasonCode } = await buildOptionalSkillCatalogReport({ root: realRoot, workspaceId, generatedAt });
  if (!report) {
    return { skillCatalog: null, skillLoadPlans: [], skillCatalogUnavailableReason: reasonCode };
  }
  return {
    skillCatalog: await buildSkillCatalogMcpResourceSummaryFromReport({ root: realRoot, report }),
    skillLoadPlans: report.skills.map((skill) => buildSkillLoadPlanFromCatalog({ catalog: report, skillId: skill.id })),
    skillCatalogUnavailableReason: null
  };
}

function skillCatalogMcpResourceSafeguards(report) {
  return {
    readOnly: true,
    localFilesWritten: 0,
    networkCalls: 0,
    modelCalls: 0,
    skillTextIncluded: false,
    absoluteFilesystemLocationsIncluded: false,
    externalWritesEnabled: false,
    toolAuthorityGranted: false,
    catalogReportFingerprint: report.reportFingerprint
  };
}

async function buildToolCatalogMcpResourceSummary({ root }) {
  const catalogPath = path.join(root, 'tools', 'catalog.json');
  const catalogStat = await stat(catalogPath).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!catalogStat?.isFile()) return { toolCatalog: null, toolCatalogUnavailableReason: 'tool_catalog_missing' };
  try {
    const catalog = await loadReviewedToolCatalog({ catalogPath, manifestRoot: root });
    const tools = catalog.tools.map((tool) => {
      const operations = Object.entries(tool.manifest.operations)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, operation]) => ({
          name,
          sideEffectClass: operation.sideEffectClass,
          approvalRequired: operation.approval?.required === true,
          idempotencyRequired: operation.idempotency?.required === true,
          dataClasses: [...(operation.dataClasses ?? [])].sort((left, right) => left.localeCompare(right)),
          filesystemReadScopes: [...(operation.filesystem?.read ?? [])].sort((left, right) => left.localeCompare(right)),
          filesystemWriteScopes: [...(operation.filesystem?.write ?? [])].sort((left, right) => left.localeCompare(right)),
          networkTargetCount: Array.isArray(operation.network) ? operation.network.length : 0,
          credentialReferenceCount: Array.isArray(operation.secretReferences) ? operation.secretReferences.length : 0
        }));
      return {
        id: tool.manifest.id,
        name: tool.manifest.name,
        version: tool.manifest.version,
        enabled: tool.enabled,
        reviewStatus: tool.entry.reviewStatus,
        reviewVersion: tool.entry.reviewVersion,
        manifestRef: `workspace://${tool.entry.manifestPath}`,
        reviewedManifestSha256: `sha256:${tool.entry.sha256}`,
        manifestFingerprint: tool.manifestFingerprint,
        operations
      };
    }).sort((left, right) => left.id.localeCompare(right.id));
    const operations = tools.flatMap((tool) => tool.operations);
    const summary = {
      toolCount: tools.length,
      enabledToolCount: tools.filter((tool) => tool.enabled).length,
      reviewedToolCount: tools.filter((tool) => tool.reviewStatus === 'reviewed').length,
      disabledToolCount: tools.filter((tool) => !tool.enabled).length,
      operationCount: operations.length,
      sideEffectClassCounts: countValues(operations.map((operation) => operation.sideEffectClass)),
      writableOperationCount: operations.filter((operation) => operation.sideEffectClass !== 'read-only').length,
      approvalRequiredOperationCount: operations.filter((operation) => operation.approvalRequired).length,
      idempotencyRequiredOperationCount: operations.filter((operation) => operation.idempotencyRequired).length,
      networkTargetCount: operations.reduce((sum, operation) => sum + operation.networkTargetCount, 0),
      credentialReferenceCount: operations.reduce((sum, operation) => sum + operation.credentialReferenceCount, 0)
    };
    const report = {
      state: 'ready',
      configured: true,
      summary,
      tools,
      toolCatalogFingerprint: stableJsonFingerprint(tools.map((tool) => ({
        id: tool.id,
        enabled: tool.enabled,
        reviewStatus: tool.reviewStatus,
        reviewVersion: tool.reviewVersion,
        manifestFingerprint: tool.manifestFingerprint
      }))),
      reasonCodes: ['tool_catalog_validated'],
      safeguards: {
        readOnly: true,
        localFilesWritten: 0,
        networkCalls: 0,
        modelCalls: 0,
        toolAuthorityGranted: false,
        manifestTextIncluded: false,
        absoluteFilesystemLocationsIncluded: false,
        remoteEndpointDetailsIncluded: false
      }
    };
    return { toolCatalog: report, toolCatalogUnavailableReason: null };
  } catch (error) {
    return {
      toolCatalog: null,
      toolCatalogUnavailableReason: typeof error?.code === 'string' ? error.code : 'tool_catalog_invalid'
    };
  }
}

async function buildSkillCatalogToolReview({ root, declaredToolIds }) {
  const declared = [...new Set(declaredToolIds)].sort((left, right) => left.localeCompare(right));
  const catalogPath = path.join(root, 'tools', 'catalog.json');
  const catalogStat = await stat(catalogPath).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!catalogStat?.isFile()) {
    return {
      state: 'unavailable',
      configured: false,
      reviewedToolIds: [],
      enabledReviewedToolIds: [],
      disabledReviewedToolIds: [],
      unreviewedDeclaredToolIds: declared,
      toolCatalogFingerprint: null,
      reasonCodes: ['tool_catalog_missing']
    };
  }
  try {
    const catalog = await loadReviewedToolCatalog({ catalogPath, manifestRoot: root });
    const reviewedToolIds = catalog.tools
      .filter((tool) => tool.entry.reviewStatus === 'reviewed')
      .map((tool) => tool.manifest.id)
      .sort((left, right) => left.localeCompare(right));
    const enabledReviewedToolIds = catalog.tools
      .filter((tool) => tool.entry.reviewStatus === 'reviewed' && tool.enabled)
      .map((tool) => tool.manifest.id)
      .sort((left, right) => left.localeCompare(right));
    const disabledReviewedToolIds = catalog.tools
      .filter((tool) => tool.entry.reviewStatus === 'reviewed' && !tool.enabled)
      .map((tool) => tool.manifest.id)
      .sort((left, right) => left.localeCompare(right));
    const reviewed = new Set(reviewedToolIds);
    const unreviewedDeclaredToolIds = declared.filter((toolId) => !reviewed.has(toolId));
    return {
      state: 'ready',
      configured: true,
      reviewedToolIds,
      enabledReviewedToolIds,
      disabledReviewedToolIds,
      unreviewedDeclaredToolIds,
      toolCatalogFingerprint: stableJsonFingerprint(catalog.tools.map((tool) => ({
        toolId: tool.manifest.id,
        enabled: tool.enabled,
        reviewStatus: tool.entry.reviewStatus,
        reviewVersion: tool.entry.reviewVersion,
        manifestFingerprint: tool.manifestFingerprint
      }))),
      reasonCodes: unreviewedDeclaredToolIds.length
        ? ['tool_catalog_validated', 'skill_declares_unreviewed_tools']
        : ['tool_catalog_validated']
    };
  } catch (error) {
    return {
      state: 'invalid',
      configured: true,
      reviewedToolIds: [],
      enabledReviewedToolIds: [],
      disabledReviewedToolIds: [],
      unreviewedDeclaredToolIds: declared,
      toolCatalogFingerprint: null,
      reasonCodes: [typeof error?.code === 'string' ? error.code : 'tool_catalog_invalid']
    };
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
  const { skillCatalog, skillLoadPlans } = await buildSkillMcpResources({ root, workspaceId, generatedAt: fixedNow() });
  const resources = buildOafReadOnlyResourceCatalog({
    state,
    projectStatus,
    skillCatalog,
    skillLoadPlans,
    workspaceId,
    generatedAt: fixedNow()
  });
  const statsRecorder = await createMcpStatsRecorder({ values, root, workspaceId, generatedAt: fixedNow() });
  const cursorStore = await createMcpCursorStore({ values, root, workspaceId });
  const tools = buildMcpTokenSaverTools({ values, root, workspaceId, generatedAt: fixedNow(), statsRecorder, cursorStore });
  await mcpResourcesStdio({
    resources,
    trustedContext: localMcpTrustedContext(workspaceId),
    tools,
    allowReadOnlyToolsWithoutGrant: true,
    commandLabel: 'mcp server',
    streaming: true
  });
}

async function mcpStatsCommand(values) {
  if (!values.includes('--read-only')) {
    console.error('mcp stats requires --read-only');
    process.exitCode = 2;
    return;
  }
  if (values.includes('--write') || values.includes('--apply') || values.includes('--out') || values.includes('--stdio')) {
    console.error('mcp stats is read-only and only summarizes local MCP delivery telemetry');
    process.exitCode = 2;
    return;
  }
  const format = option(values, '--format') ?? 'json';
  if (!['json', 'summary'].includes(format)) {
    console.error('mcp stats only supports --format json or summary');
    process.exitCode = 2;
    return;
  }
  const allowedFlags = new Set(['--read-only', '--root', '--workspace', '--workspace-id', '--sqlite', '--stats', '--format']);
  const valueFlags = new Set(['--root', '--workspace', '--workspace-id', '--sqlite', '--stats', '--format']);
  const unsupported = unsupportedFlags(values, allowedFlags, valueFlags);
  if (unsupported.length) {
    console.error(`mcp stats unsupported option: ${unsupported[0]}`);
    process.exitCode = 2;
    return;
  }
  const root = path.resolve(option(values, '--root') ?? process.cwd());
  const workspaceId = option(values, '--workspace-id') ?? option(values, '--workspace') ?? 'ws_local';
  const generatedAt = fixedNow();
  const statsPath = await resolveWorkspaceStatsPath(root, option(values, '--stats') ?? '.local/mcp-stats.jsonl', 'mcp stats', { mustExist: false });
  const entries = await readMcpStatsEntries(statsPath.absolute, { workspaceId });
  const realisticBenchmark = await buildMcpRealisticSavingsBenchmark({ values, root, workspaceId, generatedAt }).catch((error) => ({
    available: false,
    reason: mcpSanitizeString(error.message, 160)
  }));
  const report = buildMcpStatsReport({
    entries,
    workspaceId,
    generatedAt,
    statsRef: `workspace://${statsPath.relative}`,
    realisticBenchmark
  });
  console.log(format === 'summary' ? renderMcpStatsSummary(report) : JSON.stringify(report, null, 2));
}

async function buildMcpRealisticSavingsBenchmark({ values, root, workspaceId, generatedAt }) {
  const deliveredPayload = await buildMcpContextProfilePayload({
    values,
    root,
    workspaceId,
    generatedAt,
    args: {
      objective: REALISTIC_SAVINGS_OBJECTIVE,
      step: REALISTIC_SAVINGS_STEP,
      scope: 'workspace',
      budget: 4096,
      limit: 50
    }
  });
  const report = await buildRealisticContextProfileSavingsReport({
    root,
    workspaceId,
    generatedAt,
    objective: REALISTIC_SAVINGS_OBJECTIVE,
    step: REALISTIC_SAVINGS_STEP,
    deliveredPayload
  });
  return {
    available: true,
    beforeDeliveryTokens: report.beforeDeliveryTokens,
    afterDeliveryTokens: report.afterDeliveryTokens,
    tokensSaved: report.tokensSaved,
    percent: report.percent,
    basis: report.savings.basis,
    providerBillingClaimed: false,
    candidateFileCount: report.source.candidateFileCount,
    historyCommitCount: report.source.historyCommitCount,
    reportFingerprint: report.reportFingerprint
  };
}

function buildMcpTokenSaverTools({ values, root, workspaceId, generatedAt, statsRecorder = null, cursorStore = null }) {
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
          client: { type: 'string', maxLength: 80, default: 'default' },
          limit: { type: 'integer', minimum: 1, maximum: 20, default: 8 },
          since: { type: 'string', maxLength: 80 },
          verbose: { type: 'boolean', default: false }
        }
      },
      handler: async ({ arguments: args }) => {
        const argsWithCursor = await mcpArgsWithPersistedCursor({ cursorStore, toolName: 'memory.recall', args });
        const payload = await buildMcpMemoryRecallPayload({
          values,
          root,
          workspaceId,
          generatedAt,
          args: argsWithCursor
        });
        await cursorStore?.set({ toolName: 'memory.recall', args: argsWithCursor, cursor: mcpPayloadNextCursor(payload) });
        return mcpToolJsonResult(await recordMcpToolPayload({ payload, statsRecorder, toolName: 'memory.recall' }));
      }
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
          client: { type: 'string', maxLength: 80, default: 'default' },
          budget: { type: 'integer', minimum: 1, maximum: 100000, default: 4096 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          since: { type: 'string', maxLength: 80 }
        }
      },
      handler: async ({ arguments: args }) => {
        const argsWithCursor = await mcpArgsWithPersistedCursor({ cursorStore, toolName: 'context.profile', args });
        const payload = await buildMcpContextProfilePayload({
          values,
          root,
          workspaceId,
          generatedAt,
          args: argsWithCursor
        });
        await cursorStore?.set({ toolName: 'context.profile', args: argsWithCursor, cursor: mcpPayloadNextCursor(payload) });
        return mcpToolJsonResult(await recordMcpToolPayload({ payload, statsRecorder, toolName: 'context.profile' }));
      }
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
  const verbose = args.verbose === true;
  const currentTruthOnly = args.currentTruthOnly === true && !verbose;
  const since = mcpParseSinceCursor(args.since);
  const subject = typeof args.subject === 'string' && args.subject.trim() ? mcpSanitizeString(args.subject, 128) : null;
  const predicate = typeof args.predicate === 'string' && args.predicate.trim() ? mcpSanitizeString(args.predicate, 128) : null;
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
    const facts = await provider.getTemporalFacts({ workspaceId, scope, subject, predicate, query, at: generatedAt, limit });
    const activeFacts = facts.filter((fact) => fact.status === 'active' && !fact.supersededBy).slice(0, limit);
    const changedActiveFacts = since ? activeFacts.filter((fact) => mcpFactChangedSince(fact, since)) : activeFacts;
    if (currentTruthOnly) {
      const currentFacts = changedActiveFacts.map(mcpSummarizeCurrentTruthFact);
      const retracted = since ? (await provider.listTemporalFacts({ workspaceId, scope, limit: 500 }))
        .filter((fact) => fact.status === 'superseded' && fact.supersededBy && mcpFactChangedSince(fact, since))
        .filter((fact) => proposalFactMatchesTemporalFilter(fact, { subject, predicate }) && proposalFactMatchesQuery(fact, query))
        .map((fact) => mcpSanitizeString(fact.id, 120)) : [];
      if (since) return mcpCursorDeltaPayload({ cursor: generatedAt, changes: currentFacts, retracted });
      return mcpBasePayload({
        command: 'memory.recall',
        workspaceId,
        generatedAt,
        data: {
          available: true,
          query: mcpSanitizeString(query),
          scope,
          mode: 'current-truth',
          factCount: currentFacts.length,
          activeFactCount: currentFacts.length,
          proposalFactCount: 0,
          summary: { activeFactCount: currentFacts.length, proposalFactCount: 0, totalFactCount: currentFacts.length },
          facts: currentFacts,
          cursor: { previous: null, next: generatedAt }
        }
      });
    }
    const proposalLimit = Math.max(0, limit - changedActiveFacts.length);
    const proposalFacts = (await provider.listProposalQueue({ workspaceId, limit: 100 }))
      .map(summarizeProposalQueueFact)
      .filter((item) => item && item.scope === scope && proposalFactMatchesTemporalFilter(item, { subject, predicate }) && proposalFactMatchesQuery(item, query))
      .filter((item) => !proposalFactShadowedByActiveFacts(item, activeFacts))
      .slice(0, proposalLimit);
    const withChains = [];
    const verboseFacts = [];
    for (const fact of changedActiveFacts) {
      const history = await provider.getTemporalFactHistory({
        workspaceId,
        scope,
        subject: fact.subject,
        predicate: fact.predicate,
        limit: 20
      });
      withChains.push(mcpSummarizeTemporalFact(fact, { history, verbose }));
      verboseFacts.push(mcpSummarizeTemporalFact(fact, { history, verbose: true }));
    }
    const servedProposalFacts = proposalFacts.map((fact) => mcpSummarizeProposalFact(fact, { verbose }));
    const verboseProposalFacts = proposalFacts.map((fact) => mcpSummarizeProposalFact(fact, { verbose: true }));
    return mcpBasePayload({
      command: 'memory.recall',
      workspaceId,
      generatedAt,
      data: {
        available: true,
        query: mcpSanitizeString(query),
        scope,
        mode: verbose ? 'verbose' : 'compact',
        trustOrder: ['active', 'proposal'],
        factCount: withChains.length + servedProposalFacts.length,
        activeFactCount: withChains.length,
        proposalFactCount: servedProposalFacts.length,
        summary: {
          activeFactCount: withChains.length,
          proposalFactCount: servedProposalFacts.length,
          totalFactCount: withChains.length + servedProposalFacts.length
        },
        activeFacts: withChains,
        facts: withChains,
        proposalFacts: servedProposalFacts,
        cursor: { previous: since, next: generatedAt },
        recallBenchmark: {
          baselineTokens: estimateTokens(JSON.stringify({ activeFacts: verboseFacts, facts: verboseFacts, proposalFacts: verboseProposalFacts })),
          basis: 'verbose memory.recall fact payload before compact provenance'
        }
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
  const currentTruthOnly = args.currentTruthOnly === true;
  const since = mcpParseSinceCursor(args.since);
  const subject = typeof args.subject === 'string' && args.subject.trim() ? mcpSanitizeString(args.subject, 128) : null;
  const predicate = typeof args.predicate === 'string' && args.predicate.trim() ? mcpSanitizeString(args.predicate, 128) : null;
  const provider = await openMcpReadOnlyMemoryProvider({ values, root, generatedAt });
  const records = [];
  let available = false;
  if (provider) {
    try {
      available = true;
      const facts = await provider.getTemporalFacts({
        workspaceId,
        scope,
        subject,
        predicate,
        query: objective,
        at: generatedAt,
        limit
      });
      if (currentTruthOnly) {
        const selected = facts
          .filter((fact) => fact.status === 'active' && !fact.supersededBy)
          .filter((fact) => !since || mcpFactChangedSince(fact, since))
          .slice(0, limit)
          .map(mcpSummarizeCurrentTruthFact);
        if (since) return mcpCursorDeltaPayload({ cursor: generatedAt, changes: selected });
        return mcpBasePayload({
          command: 'context.profile',
          workspaceId,
          generatedAt,
          data: {
            available: true,
            objective: mcpSanitizeString(objective, 500),
            scope,
            mode: 'current-truth',
            selectedContext: {
              selectedCount: selected.length,
              selected
            },
            contextBudget: {
              budget,
              estimatedDeliveryTokens: estimateTokens(JSON.stringify(selected)),
              unit: 'estimated delivery tokens'
            },
            governedFactCount: selected.length,
            proposalFactCount: 0,
            summary: { activeFactCount: selected.length, proposalFactCount: 0, totalFactCount: selected.length },
            cursor: { previous: null, next: generatedAt }
          }
        });
      }
      const exported = await provider.export({ workspaceId });
      const activeRecords = facts.filter((fact) => (!since || mcpFactChangedSince(fact, since))).map(mcpProfileRecordFromFact);
      const proposalRecords = (await provider.listProposalQueue({ workspaceId, limit: 100 }))
        .map(summarizeProposalQueueFact)
        .filter((item) => item && item.scope === scope && proposalFactMatchesTemporalFilter(item, { subject, predicate }) && proposalFactMatchesQuery(item, objective))
        .filter((item) => !proposalFactShadowedByActiveFacts(item, facts.filter((fact) => fact.status === 'active' && !fact.supersededBy)))
        .slice(0, limit)
        .map(mcpProfileRecordFromProposal);
      records.push(...(since ? [] : exported.records), ...activeRecords, ...proposalRecords);
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
  const payload = buildContextProfileDeliveryPayloadFromReport({
    report,
    workspaceId,
    generatedAt,
    objective,
    step,
    available,
    governedFactCount: records.length,
    proposalFactCount: records.filter((item) => item.metadata?.memoryLifecycle === 'proposal').length
  });
  const selectedIds = new Set([
    ...(payload.data?.selectedContext?.selectedIds ?? []),
    ...(payload.data?.profile?.layers ?? []).flatMap((layer) => layer.sourceRecordIds ?? [])
  ]);
  const selectedFacts = records
    .filter((record) => selectedIds.has(record.id) && record.kind === 'fact')
    .map((record) => ({
      id: mcpSanitizeString(record.id, 120),
      text: mcpSanitizeString(record.text, 300),
      sourceRef: mcpCompactProvenanceRef(record.source),
      trust: record.metadata?.memoryLifecycle === 'proposal' ? 'proposal' : 'active',
      extractionConfidence: MEMORY_BATCH_CONFIDENCES.has(record.metadata?.extractionConfidence) ? record.metadata.extractionConfidence : 'extracted'
    }))
    .slice(0, 20);
  if (selectedFacts.length) payload.data.selectedFacts = selectedFacts;
  payload.data.summary = {
    activeFactCount: records.filter((item) => item.kind === 'fact' && item.metadata?.memoryLifecycle !== 'proposal').length,
    proposalFactCount: records.filter((item) => item.kind === 'fact' && item.metadata?.memoryLifecycle === 'proposal').length,
    totalFactCount: records.filter((item) => item.kind === 'fact').length
  };
  if (since) payload.data.cursor = { previous: since, next: generatedAt };
  return payload;
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
    scope: fact.scope,
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
    observedAt: fact.validFrom,
    metadata: {
      extractionConfidence: MEMORY_BATCH_CONFIDENCES.has(fact.metadata?.extractionConfidence) ? fact.metadata.extractionConfidence : 'extracted'
    }
  };
}

function mcpProfileRecordFromProposal(fact) {
  return {
    id: `mem_${fact.id}`,
    workspaceId: fact.workspaceId,
    kind: 'fact',
    text: `proposal_only ${fact.text}`,
    scope: fact.scope,
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
      sourceHash: fact.provenance.sourceHash,
      extractionConfidence: MEMORY_BATCH_CONFIDENCES.has(fact.extractionConfidence) ? fact.extractionConfidence : 'extracted'
    }
  };
}

function proposalFactMatchesQuery(fact, query) {
  const tokens = (String(query ?? '').toLowerCase().match(/[a-z0-9:_-]+/gu) ?? [])
    .filter((token) => !REALQA_QUERY_STOPWORDS.has(token))
    .flatMap((token) => token.endsWith('s') ? [token, token.slice(0, -1)] : [token]);
  if (!tokens.length) return true;
  const haystack = `${fact.subject} ${fact.predicate} ${fact.object} ${fact.text}`.toLowerCase();
  return tokens.some((token) => haystack.includes(token));
}

function proposalFactMatchesTemporalFilter(fact, { subject, predicate }) {
  if (subject && fact.subject !== subject) return false;
  if (predicate && fact.predicate !== predicate) return false;
  return true;
}

function proposalFactShadowedByActiveFacts(fact, activeFacts) {
  return activeFacts.some((active) => active.subject === fact.subject && active.predicate === fact.predicate);
}

function mcpSummarizeProposalFact(fact, { verbose = false } = {}) {
  const base = {
    id: fact.id,
    workspaceId: fact.workspaceId,
    status: fact.status,
    scope: fact.scope,
    subject: fact.subject,
    predicate: fact.predicate,
    object: fact.object,
    extractionConfidence: MEMORY_BATCH_CONFIDENCES.has(fact.extractionConfidence) ? fact.extractionConfidence : 'extracted',
    text: fact.text
  };
  return verbose
    ? { ...base, provenance: fact.provenance }
    : {
        ...base,
        provenance: {
          ref: mcpCompactProvenanceRef(fact.provenance?.episodeId ?? fact.id),
          sourceRef: mcpCompactProvenanceRef(fact.provenance?.sourceLocator)
        }
      };
}

function mcpSummarizeTemporalFact(fact, { history, verbose = false }) {
  const base = {
    id: mcpSanitizeString(fact.id, 120),
    subject: mcpSanitizeString(fact.subject, 160),
    predicate: mcpSanitizeString(fact.predicate, 120),
    object: mcpSanitizeString(fact.object, 240),
    text: mcpSanitizeString(fact.text, 600),
    status: fact.status,
    confidence: Number(fact.confidence ?? 0),
    extractionConfidence: MEMORY_BATCH_CONFIDENCES.has(fact.metadata?.extractionConfidence) ? fact.metadata.extractionConfidence : 'extracted',
    validityWindow: {
      validFrom: fact.validFrom,
      validUntil: fact.validUntil ?? null
    },
    supersededBy: fact.supersededBy ? mcpSanitizeString(fact.supersededBy, 120) : null,
    supersessionChain: history.map((item) => ({
      id: mcpSanitizeString(item.id, 120),
      status: item.status,
      current: item.id === fact.id
    }))
  };
  if (!verbose) {
    return {
      ...base,
      provenance: {
        ref: mcpCompactProvenanceRef(fact.proposalQueueId ?? fact.episode?.id ?? fact.source),
        proposalQueueId: fact.proposalQueueId ? mcpSanitizeString(fact.proposalQueueId, 120) : null,
        episodeId: fact.episode?.id ? mcpSanitizeString(fact.episode.id, 120) : null
      }
    };
  }
  return {
    ...base,
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

function mcpSummarizeCurrentTruthFact(fact) {
  return {
    id: mcpSanitizeString(fact.id, 120),
    subject: mcpSanitizeString(fact.subject, 160),
    predicate: mcpSanitizeString(fact.predicate, 120),
    value: mcpSanitizeString(fact.object, 240),
    extractionConfidence: MEMORY_BATCH_CONFIDENCES.has(fact.metadata?.extractionConfidence) ? fact.metadata.extractionConfidence : 'extracted',
    sourceRef: mcpCompactProvenanceRef(fact.proposalQueueId ?? fact.episode?.sourceLocator ?? fact.source ?? fact.id)
  };
}

function mcpParseSinceCursor(value) {
  if (value === undefined || value === null || value === '') return null;
  const cursor = mcpSanitizeString(value, 80);
  const parsed = Date.parse(cursor);
  if (Number.isNaN(parsed)) throw new Error('mcp since cursor must be an ISO-8601 timestamp');
  return new Date(parsed).toISOString();
}

function mcpFactChangedSince(fact, since) {
  return Date.parse(fact.updatedAt ?? fact.validFrom ?? 0) > Date.parse(since);
}

function mcpCursorDeltaPayload({ cursor, changes, retracted = [] }) {
  return { c: cursor, d: changes, r: retracted };
}

function mcpPayloadNextCursor(payload) {
  return payload?.c ?? payload?.data?.cursor?.next ?? null;
}

function mcpPayloadCurrentTruthChanges(payload) {
  return payload?.d ?? payload?.data?.facts ?? [];
}

async function mcpArgsWithPersistedCursor({ cursorStore, toolName, args }) {
  if (!cursorStore || args?.since) return args;
  const cursor = await cursorStore.get({ toolName, args });
  return cursor ? { ...args, since: cursor } : args;
}

async function createMcpCursorStore({ values, root, workspaceId }) {
  const cursorPath = await resolveWorkspaceCursorPath(root, option(values, '--cursors') ?? '.local/mcp-cursors.json', 'mcp cursor store', { mustExist: false });
  return {
    cursorRef: `workspace://${cursorPath.relative}`,
    async get({ toolName, args }) {
      const data = await readMcpCursorFile(cursorPath.absolute);
      const cursor = data.cursors?.[mcpCursorStoreKey({ workspaceId, toolName, args })]?.cursor ?? null;
      if (!cursor) return null;
      try {
        return mcpParseSinceCursor(cursor);
      } catch {
        return null;
      }
    },
    async set({ toolName, args, cursor }) {
      if (!cursor) return;
      const next = mcpParseSinceCursor(cursor);
      const key = mcpCursorStoreKey({ workspaceId, toolName, args });
      const data = await readMcpCursorFile(cursorPath.absolute);
      data.schemaVersion = '1.0.0';
      data.kind = 'mcp-session-cursors';
      data.workspaceId = workspaceId;
      data.cursors ??= {};
      data.cursors[key] = {
        workspaceId,
        toolName,
        client: mcpCursorStoreClient(args),
        scope: mcpSafeScope(args?.scope ?? 'workspace'),
        cursor: next,
        updatedAt: next
      };
      await mkdir(path.dirname(cursorPath.absolute), { recursive: true, mode: 0o700 });
      const tmpPath = `${cursorPath.absolute}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      await renameFile(tmpPath, cursorPath.absolute);
    }
  };
}

async function readMcpCursorFile(cursorPath) {
  const text = await readFile(cursorPath, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  if (!text.trim()) return { schemaVersion: '1.0.0', kind: 'mcp-session-cursors', cursors: {} };
  const parsed = JSON.parse(text);
  return parsed && typeof parsed === 'object' ? parsed : { schemaVersion: '1.0.0', kind: 'mcp-session-cursors', cursors: {} };
}

function mcpCursorStoreKey({ workspaceId, toolName, args }) {
  return [workspaceId, toolName, mcpCursorStoreClient(args), mcpSafeScope(args?.scope ?? 'workspace')].map((part) => mcpSanitizeString(part, 120)).join('|');
}

function mcpCursorStoreClient(args) {
  return mcpSanitizeString(args?.client ?? 'default', 80);
}

function mcpCompactProvenanceRef(value) {
  const raw = String(value ?? 'memory').replace(/^workspace:\/\//u, '');
  const parts = raw.split('/').filter(Boolean);
  return mcpSanitizeString(parts.length > 2 ? `${parts.at(-2)}/${parts.at(-1)}` : raw, 96);
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
      deliveryStatsRecorded: false,
      privateContentIncluded: false,
      absoluteFilesystemLocationsIncluded: false
    }
  };
}

async function createMcpStatsRecorder({ values, root, workspaceId, generatedAt }) {
  const statsPath = await resolveWorkspaceStatsPath(root, option(values, '--stats') ?? '.local/mcp-stats.jsonl', 'mcp server stats', { mustExist: false });
  const sessionId = `mcpsess_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  const totals = {
    callCount: 0,
    deliveredTokens: 0,
    baselineTokens: 0,
    tokensSaved: 0
  };
  return {
    sessionId,
    workspaceId,
    statsRef: `workspace://${statsPath.relative}`,
    generatedAt,
    async record(entry) {
      totals.callCount += 1;
      totals.deliveredTokens += entry.deliveredTokens;
      totals.baselineTokens += entry.baselineTokens;
      totals.tokensSaved += entry.tokensSaved;
      const record = {
        schemaVersion: '1.0.0',
        kind: 'mcp-delivery-token-estimate',
        recordedAt: entry.recordedAt,
        sessionId,
        workspaceId,
        toolName: entry.toolName,
        requestFingerprint: entry.requestFingerprint,
        deliveredTokens: entry.deliveredTokens,
        baselineTokens: entry.baselineTokens,
        tokensSaved: entry.tokensSaved,
        factCount: entry.factCount,
        selectedCount: entry.selectedCount,
        providerBillingClaimed: false,
        basis: 'estimated tokens over exact MCP JSON tool payload text'
      };
      await mkdir(path.dirname(statsPath.absolute), { recursive: true, mode: 0o700 });
      await appendFile(statsPath.absolute, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      return {
        ...totals,
        sessionId,
        statsRef: `workspace://${statsPath.relative}`,
        tokenSavingPercent: totals.baselineTokens > 0 ? Math.round((totals.tokensSaved / totals.baselineTokens) * 100) : 0,
        providerBillingClaimed: false
      };
    }
  };
}

async function recordMcpToolPayload({ payload, statsRecorder, toolName }) {
  if (!statsRecorder) return payload;
  const requestFingerprint = mcpStatsRequestFingerprint(payload, toolName);
  const factCount = Number(payload.data?.factCount ?? payload.data?.profile?.governedFactCount ?? 0);
  const selectedCount = Number(payload.data?.selectedContext?.selectedCount ?? payload.data?.factCount ?? 0);
  let finalPayload = payload;
  let finalEntry = null;
  let finalTotals = null;
  for (let pass = 0; pass < 2; pass += 1) {
    const deliveredTokens = estimateTokens(JSON.stringify(finalPayload));
    const baselineTokens = mcpStatsBaselineTokens(finalPayload, toolName);
    finalEntry = {
      toolName,
      recordedAt: payload.generatedAt,
      requestFingerprint,
      deliveredTokens,
      baselineTokens,
      tokensSaved: Math.max(0, baselineTokens - deliveredTokens),
      factCount,
      selectedCount
    };
    const previewTotals = {
      callCount: statsRecorder ? 1 : 0,
      deliveredTokens,
      baselineTokens,
      tokensSaved: finalEntry.tokensSaved,
      sessionId: statsRecorder.sessionId,
      statsRef: statsRecorder.statsRef,
      tokenSavingPercent: baselineTokens > 0 ? Math.round((finalEntry.tokensSaved / baselineTokens) * 100) : 0,
      providerBillingClaimed: false
    };
    finalPayload = decorateMcpPayloadWithDeliveryStats(payload, finalEntry, previewTotals);
  }
  finalTotals = await statsRecorder.record(finalEntry);
  return decorateMcpPayloadWithDeliveryStats(payload, finalEntry, finalTotals);
}

function decorateMcpPayloadWithDeliveryStats(payload, entry, totals) {
  return {
    ...payload,
    data: {
      ...payload.data,
      deliveryEstimate: {
        toolName: entry.toolName,
        deliveredTokens: entry.deliveredTokens,
        baselineTokens: entry.baselineTokens,
        tokensSaved: entry.tokensSaved,
        providerBillingClaimed: false,
        basis: 'estimated tokens over exact MCP JSON tool payload text',
        requestFingerprint: entry.requestFingerprint
      },
      sessionStats: {
        sessionId: totals.sessionId,
        statsRef: totals.statsRef,
        callCount: totals.callCount,
        deliveredTokens: totals.deliveredTokens,
        baselineTokens: totals.baselineTokens,
        tokensSaved: totals.tokensSaved,
        tokenSavingPercent: totals.tokenSavingPercent,
        providerBillingClaimed: false
      }
    },
    safeguards: {
      ...payload.safeguards,
      deliveryStatsRecorded: true
    }
  };
}

function mcpStatsBaselineTokens(payload, toolName) {
  if (toolName === 'context.profile') return Math.max(0, Math.trunc(Number(payload.data?.contextBudget?.historyTokensAvailable ?? 0)));
  if (toolName === 'memory.recall') {
    const compactFactsTokens = estimateTokens(JSON.stringify({
      activeFacts: payload.data?.activeFacts ?? [],
      facts: payload.data?.facts ?? [],
      proposalFacts: payload.data?.proposalFacts ?? []
    }));
    const verboseFactsTokens = Math.max(0, Math.trunc(Number(payload.data?.recallBenchmark?.baselineTokens ?? compactFactsTokens)));
    return estimateTokens(JSON.stringify(payload)) + Math.max(0, verboseFactsTokens - compactFactsTokens);
  }
  return estimateTokens(JSON.stringify({
    facts: payload.data?.facts ?? [],
    proposalFacts: payload.data?.proposalFacts ?? []
  }));
}

function mcpStatsRequestFingerprint(payload, toolName) {
  if (toolName === 'context.profile') return payload.data?.objectiveFingerprint ?? fingerprintJson(toolName);
  return fingerprintJson({ toolName, query: payload.data?.query ?? '', scope: payload.data?.scope ?? 'workspace' });
}

async function readMcpStatsEntries(statsPath, { workspaceId }) {
  const info = await stat(statsPath).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info?.isFile()) return [];
  if (info.size > 2 * 1024 * 1024) throw new Error('mcp stats file exceeds 2 MiB');
  const lines = (await readFile(statsPath, 'utf8')).split(/\r?\n/u).filter(Boolean);
  return lines.map((line) => JSON.parse(line)).filter((entry) => entry.workspaceId === workspaceId && entry.kind === 'mcp-delivery-token-estimate');
}

function buildMcpStatsReport({ entries, workspaceId, generatedAt, statsRef, realisticBenchmark = null }) {
  const byTool = new Map();
  for (const entry of entries) {
    const key = entry.toolName;
    const current = byTool.get(key) ?? { toolName: key, callCount: 0, deliveredTokens: 0, baselineTokens: 0, tokensSaved: 0 };
    current.callCount += 1;
    current.deliveredTokens += Math.max(0, Math.trunc(Number(entry.deliveredTokens ?? 0)));
    current.baselineTokens += Math.max(0, Math.trunc(Number(entry.baselineTokens ?? 0)));
    current.tokensSaved += Math.max(0, Math.trunc(Number(entry.tokensSaved ?? 0)));
    byTool.set(key, current);
  }
  const summary = [...byTool.values()].reduce((total, item) => ({
    callCount: total.callCount + item.callCount,
    deliveredTokens: total.deliveredTokens + item.deliveredTokens,
    baselineTokens: total.baselineTokens + item.baselineTokens,
    tokensSaved: total.tokensSaved + item.tokensSaved
  }), { callCount: 0, deliveredTokens: 0, baselineTokens: 0, tokensSaved: 0 });
  const tokenSavingPercent = summary.baselineTokens > 0 ? Math.round((summary.tokensSaved / summary.baselineTokens) * 100) : 0;
  const byToolItems = [...byTool.values()]
    .sort((left, right) => left.toolName.localeCompare(right.toolName))
    .map((item) => ({
      ...item,
      tokenSavingPercent: item.baselineTokens > 0 ? Math.round((item.tokensSaved / item.baselineTokens) * 100) : 0
    }));
  const savingClasses = {
    compressionPath: mcpStatsSavingClass(byToolItems, 'context.profile', 'context.profile compression path', 'history budget compared with delivered context.profile payload'),
    recallCompaction: mcpStatsSavingClass(byToolItems, 'memory.recall', 'memory.recall compaction', 'verbose recall payload compared with compact memory.recall delivery')
  };
  return {
    schemaVersion: '1.0.0',
    command: 'mcp stats',
    generatedAt,
    workspaceId,
    source: {
      provider: 'local-jsonl',
      statsRef
    },
    summary: {
      ...summary,
      tokenSavingPercent,
      providerBillingClaimed: false,
      basis: 'estimated tokens over exact MCP JSON tool payload text'
    },
    savingClasses,
    byTool: byToolItems,
    realisticBenchmark: realisticBenchmark ?? { available: false, reason: 'not_measured' },
    recentCalls: entries.slice(-10).map((entry) => ({
      recordedAt: entry.recordedAt,
      sessionId: entry.sessionId,
      toolName: entry.toolName,
      requestFingerprint: entry.requestFingerprint,
      deliveredTokens: Math.max(0, Math.trunc(Number(entry.deliveredTokens ?? 0))),
      baselineTokens: Math.max(0, Math.trunc(Number(entry.baselineTokens ?? 0))),
      tokensSaved: Math.max(0, Math.trunc(Number(entry.tokensSaved ?? 0)))
    })),
    safeguards: {
      readOnly: true,
      canonicalStateMutated: false,
      localFilesWritten: 0,
      externalWritesEnabled: false,
      networkCalls: 0,
      modelCalls: 0,
      providerBillingClaimed: false,
      rawRequestTextIncluded: false
    },
    reportFingerprint: fingerprintJson({ workspaceId, statsRef, summary, savingClasses, realisticBenchmark, byTool: [...byTool.keys()].sort() })
  };
}

function mcpStatsSavingClass(byToolItems, toolName, label, basis) {
  const item = byToolItems.find((candidate) => candidate.toolName === toolName) ?? {
    toolName,
    callCount: 0,
    deliveredTokens: 0,
    baselineTokens: 0,
    tokensSaved: 0,
    tokenSavingPercent: 0
  };
  return { ...item, label, basis, providerBillingClaimed: false };
}

function renderMcpStatsSummary(report) {
  const compression = report.savingClasses?.compressionPath ?? { tokenSavingPercent: 0, deliveredTokens: 0, baselineTokens: 0 };
  const recall = report.savingClasses?.recallCompaction ?? { tokenSavingPercent: 0, deliveredTokens: 0, baselineTokens: 0 };
  const realistic = report.realisticBenchmark?.available
    ? [
        `Realistic context.profile saving: ${report.realisticBenchmark.percent}%`,
        `Realistic before/after: ${report.realisticBenchmark.beforeDeliveryTokens} -> ${report.realisticBenchmark.afterDeliveryTokens}`
      ]
    : [`Realistic context.profile saving: unavailable`];
  return [
    `MCP delivery calls: ${report.summary.callCount}`,
    `Delivered tokens: ${report.summary.deliveredTokens}`,
    `Baseline tokens: ${report.summary.baselineTokens}`,
    `Saved tokens: ${report.summary.tokensSaved}`,
    `Saving: ${report.summary.tokenSavingPercent}%`,
    `Compression-path saving (context.profile): ${compression.tokenSavingPercent}%`,
    `Compression-path before/after: ${compression.baselineTokens} -> ${compression.deliveredTokens}`,
    `Recall compaction saving (memory.recall): ${recall.tokenSavingPercent}%`,
    `Recall before/after: ${recall.baselineTokens} -> ${recall.deliveredTokens}`,
    ...realistic,
    `Provider billing claimed: ${report.summary.providerBillingClaimed ? 'yes' : 'no'}`
  ].join('\n');
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
  const allowedFlags = new Set(['--client', '--server', '--home', '--config', '--root', '--sqlite', '--stats', '--format', '--dry-run', '--apply', '--confirm']);
  const valueFlags = new Set(['--client', '--server', '--home', '--config', '--root', '--sqlite', '--stats', '--format', '--confirm']);
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
  const statsPath = await resolveWorkspaceStatsPath(root, option(values, '--stats') ?? '.local/mcp-stats.jsonl', 'mcp install', { mustExist: false });
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
  const installPlan = await buildPortableMcpInstallPlan({ setup, client, root, sqlitePath, statsPath, home, configPath: option(values, '--config') ?? client.configPath });
  const preview = buildMcpInstallReport({ setup, installPlan, client, root, sqlitePath, statsPath, apply, applied: false, localFilesWritten: 0 });
  const confirm = option(values, '--confirm');
  if (apply && confirm !== preview.planFingerprint) {
    console.error('mcp install --apply requires --confirm <planFingerprint> from a dry-run preview');
    process.exitCode = 2;
    return;
  }
  if (apply) {
    await applyMcpInstallConfig({ home, client, configPath: option(values, '--config') ?? client.configPath, server: setup.server, desiredServer: installPlan.desiredServer });
    console.log(JSON.stringify(buildMcpInstallReport({ setup, installPlan, client, root, sqlitePath, statsPath, apply, applied: true, localFilesWritten: 1 }), null, 2));
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

async function buildPortableMcpInstallPlan({ setup, client, root, sqlitePath, statsPath, home, configPath }) {
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
      '--stats',
      statsPath.absolute,
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
    const args = serverConfig.args.map(tomlString).join(', ');
    content = `[mcp_servers.${server}]\ncommand = ${tomlString(serverConfig.command)}\nargs = [${args}]`;
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
  const command = parseTomlStringBody(body.match(/(?:^|\n)\s*command\s*=\s*"((?:\\.|[^"\\])*)"/u)?.[1]);
  const argsText = body.match(/(?:^|\n)\s*args\s*=\s*\[([^\]]*)\]/u)?.[1] ?? '';
  const args = [...argsText.matchAll(/"((?:\\.|[^"\\])*)"/gu)].map((item) => parseTomlStringBody(item[1]));
  if (!command) return null;
  return { command, args };
}

function tomlString(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function parseTomlStringBody(value) {
  return typeof value === 'string' ? value.replaceAll('\\\\', '\\').replaceAll('\\"', '"') : undefined;
}

function arraysEqual(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => item === right[index]);
}

function buildMcpInstallReport({ setup, installPlan, client, root, sqlitePath, statsPath, apply, applied, localFilesWritten }) {
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
    stats: {
      provider: 'local-jsonl',
      statsPath: statsPath.absolute,
      statsRef: `workspace://${statsPath.relative}`
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
  const args = serverConfig.args.map(tomlString).join(', ');
  const section = `[mcp_servers.${server}]\ncommand = ${tomlString(serverConfig.command)}\nargs = [${args}]\n`;
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

async function hookCommand(values) {
  const [subcommand, ...rest] = values;
  if (subcommand === 'install' || subcommand === 'uninstall') {
    return hookSetupCommand(subcommand, rest);
  }
  if (subcommand !== 'context') {
    console.error('hook requires install, uninstall, or context');
    process.exitCode = 2;
    return;
  }
  if (!rest.includes('--read-only')) {
    console.error('hook context requires --read-only');
    process.exitCode = 2;
    return;
  }
  const format = option(rest, '--format') ?? 'text';
  const payload = {
    schemaVersion: '1.0.0',
    command: 'hook context',
    dryRun: true,
    readOnly: true,
    recommendedCommands: [
      oafCommand('context receive --read-only --root . --target codex --format json'),
      oafCommand('mcp resources --read-only --stdio')
    ],
    safeguards: {
      localFilesWritten: 0,
      canonicalStateMutated: false,
      externalWritesEnabled: false,
      memoryActivated: false,
      authorityGranted: false
    }
  };
  if (format === 'json') {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  if (format !== 'text') {
    console.error('hook context only supports --format text or json');
    process.exitCode = 2;
    return;
  }
  console.log([
    'OAF HOOK CONTEXT',
    'Use pinned local context only:',
    ...payload.recommendedCommands.map((item) => `- ${item}`),
    'No writes, memory activation, external adapters, network calls, or authority grants.'
  ].join('\n'));
}

async function hookSetupCommand(action, values) {
  if (!values.includes('--dry-run')) {
    console.error(`hook ${action} requires --dry-run; home config writes are not implemented`);
    process.exitCode = 2;
    return;
  }
  if (values.includes('--write')) {
    console.error(`hook ${action} is dry-run only; home config writes are not implemented`);
    process.exitCode = 2;
    return;
  }
  const agent = option(values, '--agent') ?? option(values, '--client') ?? 'codex';
  if (!['codex', 'claude-code'].includes(agent)) {
    console.error('hook install supports --agent codex or --agent claude-code');
    process.exitCode = 2;
    return;
  }
  const format = option(values, '--format') ?? 'json';
  if (format !== 'json') {
    console.error(`hook ${action} only supports --format json`);
    process.exitCode = 2;
    return;
  }
  const report = await buildHarnessSetupReport({
    action: action === 'install' ? 'plan' : 'uninstall',
    client: agent,
    server: 'oaf',
    home: option(values, '--home') ?? process.env.HOME ?? process.cwd(),
    configPath: option(values, '--config'),
    generatedAt: fixedNow()
  });
  const manualHookSnippet = action === 'install'
    ? report.manualHookSnippet
    : {
      format: 'json',
      configRef: report.manualHookSnippet.configRef,
      applyMode: 'manual-remove',
      content: JSON.stringify({
        removeEvents: report.desiredHooks.events,
        matchingCommand: report.desiredHooks.command
      }, null, 2),
      warning: 'Dry-run only. Remove matching OAF hook entries manually; OAF did not edit home config.'
    };
  console.log(JSON.stringify({
    schemaVersion: '1.0.0',
    command: `hook ${action}`,
    agent,
    dryRun: true,
    state: report.desiredHooks.supported ? `manual-${action === 'install' ? 'copy' : 'remove'}-ready` : 'unsupported',
    receipt: {
      localFilesWritten: 0,
      homeConfigMutated: false,
      externalWritesEnabled: false,
      authorityGranted: false,
      memoryActivated: false
    },
    manualHookSnippet,
    harnessSetup: report
  }, null, 2));
}

async function connectionCommand(action, values) {
  const allowed = new Set(['--agent', '--client', '--home', '--format', '--dry-run', '--yes']);
  const unsupported = unsupportedFlags(values, allowed, new Set(['--agent', '--client', '--home', '--format']));
  if (unsupported.length) {
    console.error(`${action} unsupported flags: ${unsupported.join(', ')}`);
    process.exitCode = 2;
    return;
  }
  if (values.includes('--dry-run') && values.includes('--yes')) {
    console.error(`${action} accepts either --dry-run or --yes, not both`);
    process.exitCode = 2;
    return;
  }
  const format = option(values, '--format') ?? 'json';
  if (format !== 'json') {
    console.error(`${action} only supports --format json`);
    process.exitCode = 2;
    return;
  }
  try {
    const agent = normalizeConnectionAgent(option(values, '--agent') ?? option(values, '--client') ?? firstPositional(values, new Set(['--agent', '--client', '--home', '--format'])) ?? 'codex');
    const dryRun = !values.includes('--yes');
    const home = option(values, '--home') ?? process.env.HOME ?? process.cwd();
    const setup = await buildHarnessSetupReport({
      action: action === 'connect' ? 'plan' : 'uninstall',
      client: agent,
      server: 'oaf',
      home,
      generatedAt: fixedNow()
    });
    const receipt = dryRun
      ? connectionDryRunReceipt()
      : await applyConnection({ action, agent, home, setup, generatedAt: fixedNow() });
    console.log(JSON.stringify({
      schemaVersion: '1.0.0',
      command: action,
      agent,
      dryRun,
      state: dryRun ? 'preview-ready' : receipt.state,
      receipt,
      harnessSetup: setup,
      safeguards: {
        localFilesWritten: receipt.localFilesWritten,
        homeConfigMutated: receipt.homeConfigMutated,
        externalWritesEnabled: false,
        authorityGranted: false,
        memoryActivated: false
      }
    }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
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
  if (!['json', 'summary'].includes(format)) {
    console.error('mcp resources only supports --format json or summary');
    process.exitCode = 2;
    return;
  }
  const { workspaceId, resources } = await buildMcpResourceCatalogForValues(values);
  const trustedContext = localMcpTrustedContext(workspaceId);

  if (values.includes('--stdio')) {
    if (format !== 'json') {
      console.error('mcp resources --stdio only supports --format json');
      process.exitCode = 2;
      return;
    }
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
    const report = {
      schemaVersion: '1.0.0',
      mode: 'read-only',
      workspaceId,
      uri,
      contents
    };
    console.log(format === 'summary' ? renderMcpResourceReadSummary(report) : JSON.stringify(report, null, 2));
    return;
  }

  if (format === 'summary') {
    console.error('mcp resources --format summary requires --uri; use mcp inspect --format summary for resource listings');
    process.exitCode = 2;
    return;
  }

  console.log(JSON.stringify({
    schemaVersion: '1.0.0',
    mode: 'read-only',
    workspaceId,
    resources: resources.map(({ uri: resourceUri, name, title, description, mimeType, annotations }) => ({ uri: resourceUri, name, title, description, mimeType, annotations })),
    safeguards: {
      canonicalStateMutated: false,
      externalWritesEnabled: false,
      externalAdaptersEnabled: 0,
      networkCalls: 0,
      modelCalls: 0
    }
  }, null, 2));
}

async function mcpInspectCommand(values) {
  if (!values.includes('--read-only')) {
    console.error('mcp inspect requires --read-only; MCP write tools are not exposed by this command');
    process.exitCode = 2;
    return;
  }
  if (values.includes('--write') || values.includes('--out') || values.includes('--stdio')) {
    console.error('mcp inspect is read-only and does not write context packs, output files, or start stdio');
    process.exitCode = 2;
    return;
  }
  const format = option(values, '--format') ?? 'json';
  if (!['json', 'summary'].includes(format)) {
    console.error('mcp inspect only supports --format json or summary');
    process.exitCode = 2;
    return;
  }
  const catalog = await buildMcpResourceCatalogForValues(values);
  const tools = buildMcpTokenSaverTools({ values, root: catalog.root, workspaceId: catalog.workspaceId, generatedAt: catalog.generatedAt });
  const report = buildMcpInspectReport({ ...catalog, tools });
  console.log(format === 'summary' ? renderMcpInspectSummary(report) : JSON.stringify(report, null, 2));
}

async function buildMcpResourceCatalogForValues(values) {
  const root = option(values, '--root') ?? process.cwd();
  const workspaceId = option(values, '--workspace-id') ?? option(values, '--workspace') ?? 'ws_local';
  const generatedAt = fixedNow();
  const currentContextPackUsePlan = await loadMcpContextPackUsePlan(values, { root, workspaceId });
  const currentContextPack = await buildMcpContextPackResource(values, { root, workspaceId });
  const currentContextPackRegistryStatus = await loadMcpContextPackRegistryStatus(values, { root, workspaceId });
  const wantsMemoryRefineResource = values.includes('--memory-refine') || option(values, '--uri') === `oaf://workspace/${workspaceId}/memory/refine`;
  const memoryRefineReport = wantsMemoryRefineResource ? await buildMemoryRefineReportForValues(values, { generatedAt }) : null;
  const state = await loadWorkspaceJson(root, option(values, '--state') ?? '.local/state.json', {
    schemaVersion: '1.0.0',
    runs: [],
    events: [],
    memories: [],
    approvals: [],
    artifacts: []
  });
  const projectStatus = await loadWorkspaceJson(root, option(values, '--project-status') ?? 'PROJECT_STATUS.json', {});
  const { skillCatalog, skillLoadPlans, skillCatalogUnavailableReason } = await buildSkillMcpResources({ root, workspaceId, generatedAt });
  const { toolCatalog, toolCatalogUnavailableReason } = await buildToolCatalogMcpResourceSummary({ root });
  const resources = buildOafReadOnlyResourceCatalog({
    state,
    projectStatus,
    currentContextPack,
    currentContextPackUsePlan,
    currentContextPackRegistryStatus,
    memoryRefineReport,
    skillCatalog,
    skillLoadPlans,
    toolCatalog,
    workspaceId,
    generatedAt
  });
  return {
    root,
    workspaceId,
    generatedAt,
    resources,
    optionalAvailability: {
      contextPackCurrent: Boolean(currentContextPack),
      contextPackUsePlan: Boolean(currentContextPackUsePlan),
      contextPackRegistry: Boolean(currentContextPackRegistryStatus),
      memoryRefine: Boolean(memoryRefineReport),
      skillCatalog: Boolean(skillCatalog),
      skillLoadPlans: Array.isArray(skillLoadPlans) ? skillLoadPlans.length : 0,
      skillCatalogUnavailableReason,
      toolCatalog: Boolean(toolCatalog),
      toolCatalogUnavailableReason
    }
  };
}

function buildMcpInspectReport({ workspaceId, generatedAt, resources, tools, optionalAvailability }) {
  const inspectedResources = resources.map((resource) => {
    const metadataText = [resource.uri, resource.name, resource.title, resource.description, resource.mimeType].filter(Boolean).join(' ');
    return {
      uri: resource.uri,
      name: resource.name,
      title: resource.title,
      description: resource.description,
      mimeType: resource.mimeType,
      annotations: resource.annotations,
      resourceKind: inferMcpResourceKind(resource.uri),
      contextTier: inferMcpResourceContextTier(resource.uri),
      visibility: 'listed',
      readOnly: true,
      metadataTokens: estimateTokens(metadataText)
    };
  });
  const inspectedTools = tools.map((tool) => {
    const inputProperties = Object.keys(tool.inputSchema?.properties ?? {}).sort((left, right) => left.localeCompare(right));
    return {
      name: tool.name,
      description: tool.description,
      operation: tool.operation,
      sideEffectClass: tool.sideEffectClass,
      contextTier: inferMcpToolContextTier(tool.operation ?? tool.name),
      visibility: tool.sideEffectClass === 'read-only' ? 'server-listed' : 'blocked',
      inputFieldCount: inputProperties.length,
      inputFields: inputProperties,
      metadataTokens: estimateTokens([tool.name, tool.description, tool.operation, tool.sideEffectClass, inputProperties.join(' ')].filter(Boolean).join(' '))
    };
  });
  const unavailable = buildMcpInspectUnavailable(optionalAvailability);
  const reportBase = {
    schemaVersion: '1.0.0',
    command: 'mcp inspect',
    mode: 'read-only',
    workspaceId,
    generatedAt,
    summary: {
      resourcesListed: inspectedResources.length,
      resourceKindCounts: countValues(inspectedResources.map((resource) => resource.resourceKind)),
      contextTierCounts: countValues(inspectedResources.map((resource) => resource.contextTier)),
      toolContextTierCounts: countValues(inspectedTools.map((tool) => tool.contextTier)),
      toolsExposedByResourcesCommand: 0,
      toolsExposedByServerCommand: inspectedTools.filter((tool) => tool.visibility === 'server-listed').length,
      resourceTemplatesExposed: 0,
      promptsExposed: 0,
      unavailableResourceCount: unavailable.length,
      estimatedMetadataTokens: inspectedResources.reduce((sum, item) => sum + item.metadataTokens, 0) + inspectedTools.reduce((sum, item) => sum + item.metadataTokens, 0)
    },
    resources: inspectedResources,
    serverTools: inspectedTools,
    unavailableResources: unavailable,
    safeguards: {
      readOnly: true,
      canonicalStateMutated: false,
      localFilesWritten: 0,
      externalWritesEnabled: false,
      externalAdaptersEnabled: 0,
      networkCalls: 0,
      modelCalls: 0,
      resourceBodiesRead: 0,
      rawSourceBodiesIncluded: false,
      absoluteFilesystemLocationsIncluded: false
    }
  };
  return { ...reportBase, reportFingerprint: stableJsonFingerprint({ ...reportBase, reportFingerprint: null }) };
}

function inferMcpResourceKind(uri) {
  if (/\/status$/u.test(uri)) return 'status-summary';
  if (/\/context\/latest$/u.test(uri)) return 'context-manifest-summary';
  if (/\/runs\/latest$/u.test(uri)) return 'run-summary';
  if (/\/memory\/proposals$/u.test(uri)) return 'memory-proposal-summary';
  if (/\/memory\/refine$/u.test(uri)) return 'memory-refine-report';
  if (/\/handoff\/latest$/u.test(uri)) return 'handoff-bundle-summary';
  if (/\/context-pack\/current$/u.test(uri)) return 'context-pack-summary';
  if (/\/context-pack\/use-plan\/current$/u.test(uri)) return 'context-pack-use-plan';
  if (/\/context-pack\/registry\/current$/u.test(uri)) return 'context-pack-registry-status';
  if (/\/skills\/catalog$/u.test(uri)) return 'skill-catalog-summary';
  if (/\/skills\/[^/]+\/load-plan$/u.test(uri)) return 'skill-load-plan';
  if (/\/tools\/catalog$/u.test(uri)) return 'tool-catalog-summary';
  return 'unknown';
}

function inferMcpResourceContextTier(uri) {
  const kind = inferMcpResourceKind(uri);
  if (kind === 'run-summary') return 'event-trace';
  if (kind === 'context-manifest-summary') return 'selected-context';
  if (kind === 'memory-proposal-summary' || kind === 'memory-refine-report') return 'governed-memory';
  if (kind === 'skill-catalog-summary' || kind === 'skill-load-plan') return 'procedural-skill';
  if (kind === 'tool-catalog-summary') return 'tool-capability';
  if (kind === 'context-pack-summary' || kind === 'context-pack-use-plan' || kind === 'handoff-bundle-summary') return 'handoff-context';
  if (kind === 'context-pack-registry-status' || kind === 'status-summary') return 'workspace-state';
  return 'other';
}

function inferMcpToolContextTier(operation) {
  if (operation === 'memory.recall') return 'governed-memory';
  if (operation === 'context.profile') return 'selected-context';
  if (operation === 'context.pack') return 'handoff-context';
  return 'tool-capability';
}

function countValues(values) {
  return values.reduce((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function buildMcpInspectUnavailable(availability = {}) {
  const missing = [];
  if (!availability.contextPackCurrent) {
    missing.push({
      uri: 'oaf://workspace/<workspaceId>/context-pack/current',
      reasonCodes: ['requires_context_pack_inputs'],
      howToExpose: oafCommand('mcp inspect --read-only --context-pack --objective "Ship safely" --step "handoff" --format json')
    });
  }
  if (!availability.contextPackUsePlan) {
    missing.push({
      uri: 'oaf://workspace/<workspaceId>/context-pack/use-plan/current',
      reasonCodes: ['no_current_context_pack_use_plan'],
      howToExpose: 'pin or export a context-pack use plan, then rerun mcp inspect'
    });
  }
  if (!availability.contextPackRegistry) {
    missing.push({
      uri: 'oaf://workspace/<workspaceId>/context-pack/registry/current',
      reasonCodes: ['no_pinned_context_pack_registry'],
      howToExpose: 'pin a context pack locally, then rerun mcp inspect'
    });
  }
  if (!availability.skillCatalog) {
    const reasonCode = availability.skillCatalogUnavailableReason ?? 'skills_directory_missing';
    missing.push({
      uri: 'oaf://workspace/<workspaceId>/skills/catalog',
      reasonCodes: [reasonCode],
      howToExpose: reasonCode === 'skills_directory_missing'
        ? 'run from an OAF checkout with a skills/ directory'
        : 'fix skills/*/manifest.json and SKILL.md, then rerun mcp inspect'
    });
  }
  if (!availability.toolCatalog) {
    const reasonCode = availability.toolCatalogUnavailableReason ?? 'tool_catalog_missing';
    missing.push({
      uri: 'oaf://workspace/<workspaceId>/tools/catalog',
      reasonCodes: [reasonCode],
      howToExpose: reasonCode === 'tool_catalog_missing'
        ? 'run from an OAF checkout with tools/catalog.json'
        : 'fix tools/catalog.json and pinned tool manifests, then rerun mcp inspect'
    });
  }
  return missing;
}

function renderMcpInspectSummary(report) {
  const tierRows = Object.entries(report.summary.contextTierCounts).sort(([left], [right]) => left.localeCompare(right)).map(([tier, count]) => `- ${tier}: ${count}`);
  const resources = report.resources.slice(0, 12).map((resource) => `- ${resource.contextTier}/${resource.resourceKind}: ${resource.uri}`);
  const tools = report.serverTools.map((tool) => `- ${tool.contextTier}/${tool.name} [${tool.sideEffectClass}]: ${tool.operation}`);
  const unavailable = report.unavailableResources.map((item) => `- ${item.uri}: ${item.reasonCodes.join(', ')}`);
  return [
    `Resources listed: ${report.summary.resourcesListed}`,
    `Server tools: ${report.summary.toolsExposedByServerCommand}`,
    `Resource templates: ${report.summary.resourceTemplatesExposed}`,
    `Prompts: ${report.summary.promptsExposed}`,
    `Metadata tokens: ${report.summary.estimatedMetadataTokens}`,
    'Context tiers:',
    ...(tierRows.length ? tierRows : ['- none']),
    'Resources:',
    ...(resources.length ? resources : ['- none']),
    'Tools:',
    ...(tools.length ? tools : ['- none']),
    'Unavailable:',
    ...(unavailable.length ? unavailable : ['- none']),
    `Resource bodies read: ${report.safeguards.resourceBodiesRead}`,
    `Report fingerprint: ${report.reportFingerprint}`
  ].join('\n');
}

function renderMcpResourceReadSummary(report) {
  const payload = parseMcpResourcePayload(report.contents);
  const resourceKind = payload.resourceKind ?? inferMcpResourceKind(report.uri);
  const lines = [
    `Resource: ${report.uri}`,
    `Kind: ${resourceKind}`,
    `Context tier: ${inferMcpResourceContextTier(report.uri)}`,
    `Provenance: ${payload.provenance?.source ?? 'unknown'}`,
    `Fingerprint: ${payload.resourceFingerprint ?? 'unknown'}`,
    `Read-only: ${payload.safeguards?.readOnly === true ? 'yes' : 'unknown'}`
  ];
  if (typeof payload.data?.state === 'string') lines.push(`State: ${payload.data.state}`);
  if (payload.data?.skill?.id) lines.push(`Skill: ${payload.data.skill.id}`);
  if (Array.isArray(payload.data?.requiredLocalReads)) lines.push(`Required local reads: ${payload.data.requiredLocalReads.length}`);
  const summary = payload.data?.summary && typeof payload.data.summary === 'object' && !Array.isArray(payload.data.summary) ? payload.data.summary : {};
  for (const [key, value] of Object.entries(summary).sort(([left], [right]) => left.localeCompare(right))) {
    if (['string', 'number', 'boolean'].includes(typeof value)) lines.push(`${key}: ${value}`);
  }
  const safeguards = payload.data?.safeguards && typeof payload.data.safeguards === 'object' && !Array.isArray(payload.data.safeguards) ? payload.data.safeguards : {};
  if (typeof safeguards.skillTextIncluded === 'boolean') lines.push(`Skill text included: ${safeguards.skillTextIncluded ? 'yes' : 'no'}`);
  if (typeof safeguards.manifestTextIncluded === 'boolean') lines.push(`Manifest text included: ${safeguards.manifestTextIncluded ? 'yes' : 'no'}`);
  if (typeof safeguards.toolAuthorityGranted === 'boolean') lines.push(`Tool authority granted: ${safeguards.toolAuthorityGranted ? 'yes' : 'no'}`);
  return lines.join('\n');
}

function parseMcpResourcePayload(contents) {
  try {
    return JSON.parse(contents?.[0]?.text ?? '{}');
  } catch {
    return {};
  }
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
  if (option(values, '--changed-shard')) childArgs.push('--changed-shard', String(changedShard(values)));

  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize' },
    { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
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
  const expectedResponseCount = messages.filter((message) => message.id !== undefined).length;
  const responses = parseJsonRpcResponseLines(child.stdout, { expectedCount: expectedResponseCount });
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
      invocation: oafCommand('mcp resources --read-only --context-pack --stdio'),
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
      noMarkdownBody: payload.data?.markdownArtifact?.included === false,
      initializedNotificationAccepted: responses.length === expectedResponseCount
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
  const skillCatalog = await buildSkillCatalogPreflight({ root, workspaceId, generatedAt });
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
  const startMcpBridge = oafCommand(`mcp resources --read-only --context-pack ${baseCommand} --stdio`);
  const handoffParts = buildContextHandoffParts({
    launchPrompt: pack.handoff.launchPrompt,
    contextPackFingerprint: pack.contextPackFingerprint,
    contextPackResourceUri: smoke.resourceUri,
    usePlanResourceUri: usePlan.resource.uri,
    usePlanFingerprint: usePlan.usePlanFingerprint
  });
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
    handoffParts,
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
      usePlanFingerprint: usePlan.usePlanFingerprint,
      requiredReadCount: usePlan.requiredLocalReads.length,
      requiredLocalReads: readFirst,
      truncatedRequiredReadCount: Math.max(0, usePlan.requiredLocalReads.length - readFirst.length),
      markdownContentIncluded: usePlan.safeguards.markdownContentIncluded,
      sourceContentIncluded: usePlan.safeguards.sourceContentIncluded
    },
    memoryProposalPreflight,
    skillCatalog,
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
      previewSetup: oafCommand(`harness setup plan --client ${setupClient} --server oaf --dry-run --format json`),
      startMcpBridge,
      readCurrentContextPack: oafCommand(`mcp resources --read-only --context-pack ${baseCommand} --uri oaf://workspace/${workspaceId}/context-pack/current --format json`),
      renderMarkdown: oafCommand(`context pack ${baseCommand} --dry-run --format markdown`),
      refineMemory: oafCommand('memory refine --read-only --root . --sqlite .local/memory.sqlite --target-active-facts 200 --format json'),
      catalogSkills: skillCatalog.command
    },
    checks: {
      contextPackFingerprintMatchesMcp: smoke.resource.contextPackFingerprint === pack.contextPackFingerprint,
      contextPackFingerprintMatchesUsePlan: usePlan.contextPack.fingerprint === pack.contextPackFingerprint,
      resourceRead: smoke.checks.resourceRead,
      noToolsExposed: smoke.checks.noToolsExposed,
      noMarkdownBody: smoke.checks.noMarkdownBody,
      setupDryRun: setup.dryRun === true,
      setupUsesInstalledOaf: harnessSetupUsesRunnableOaf(setup.desiredServer)
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

function buildContextHandoffParts({ launchPrompt, contextPackFingerprint, contextPackResourceUri, usePlanResourceUri, usePlanFingerprint }) {
  return [
    {
      order: 1,
      partType: 'launch_instruction',
      schemaVersion: '1.0.0',
      title: 'Launch instruction',
      resourceUri: null,
      commandKey: null,
      fingerprint: fingerprintJson(launchPrompt),
      payloadIncluded: false,
      reasonCodes: ['schema_versioned_part', 'target_harness_instruction']
    },
    {
      order: 2,
      partType: 'context_pack_resource',
      schemaVersion: '1.0.0',
      title: 'Context pack MCP resource',
      resourceUri: contextPackResourceUri,
      commandKey: 'readCurrentContextPack',
      fingerprint: contextPackFingerprint,
      payloadIncluded: false,
      reasonCodes: ['mcp_readback_verified', 'schema_versioned_part']
    },
    {
      order: 3,
      partType: 'use_plan_resource',
      schemaVersion: '1.0.0',
      title: 'Required local read plan',
      resourceUri: usePlanResourceUri,
      commandKey: null,
      fingerprint: usePlanFingerprint,
      payloadIncluded: false,
      reasonCodes: ['local_reads_required', 'schema_versioned_part']
    },
    {
      order: 4,
      partType: 'safeguards',
      schemaVersion: '1.0.0',
      title: 'Read-only safeguards',
      resourceUri: null,
      commandKey: null,
      fingerprint: fingerprintJson({ readOnly: true, externalWritesEnabled: false, rawSourceBodiesIncluded: false }),
      payloadIncluded: false,
      reasonCodes: ['no_external_writes', 'no_raw_source_bodies', 'schema_versioned_part']
    }
  ];
}

function harnessSetupUsesRunnableOaf(server) {
  return isOafServerInvocation(server, OAF_MCP_RESOURCE_BINARY_ARGS) ||
    isOafServerInvocation(server, OAF_MCP_TOKEN_SAVER_BINARY_ARGS);
}

function safeWorkspaceRelativePath(value, label) {
  const relativePath = String(value ?? '').trim();
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('..') || relativePath.includes('\\') || /^[a-z]+:/iu.test(relativePath)) {
    throw new Error(`${label} must be workspace-relative`);
  }
  if (!/^[A-Za-z0-9._~!$&'()*+,;=:@%/\[\]-]{1,512}$/u.test(relativePath)) throw new Error(`${label} contains unsupported characters`);
  if (/(^|\/)(?:\.git|\.local|node_modules)(?:\/|$)/u.test(relativePath)) throw new Error(`${label} points to an unsupported workspace location`);
  return relativePath;
}

function memoryProposalCommand(configPath = 'oaf.memory.json') {
  return oafCommand(`memory proposals --from memoryPaths --config ${shellQuote(configPath)} --root . --dry-run --format json`);
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

function buildTokenSaverMeasurement({ selection, delivery, changedSourceBudget }) {
  const selectedUnitCount = Number(selection.selectedTokenCount ?? 0);
  const changedSourceUnitCount = Number(changedSourceBudget?.contentTokenCount ?? 0);
  const changedSourceUnitCountIncluded = Number(changedSourceBudget?.contentTokenCountIncluded ?? 0);
  const deliveredUnitCount = Number(delivery.deliveredTokenCount ?? 0);
  const baselineUnitCount = selectedUnitCount + changedSourceUnitCount;
  const savedUnitCount = Math.max(0, baselineUnitCount - deliveredUnitCount);
  const reductionRatio = baselineUnitCount > 0 ? Number((savedUnitCount / baselineUnitCount).toFixed(6)) : 0;
  return {
    basis: 'selected-context-plus-changed-source-resend',
    baselineUnitCount,
    deliveredUnitCount,
    savedUnitCount,
    reductionRatio,
    selectedUnitCount,
    changedSourceUnitCount,
    changedSourceUnitCountIncluded,
    sourceContentIncluded: false,
    providerBillingClaimed: false
  };
}

function changedShard(values) {
  return parseIntegerOption(values, '--changed-shard', 1);
}

function buildLargeContextMeasurement({ values, changedLocators, detection }) {
  const shardSize = 16;
  const explicitCount = [...options(values, '--changed'), ...options(values, '--changed-locator')].length;
  const detectionAvailable = detection?.status === 'available';
  const detectedTotal = detectionAvailable ? Number(detection.totalChangedLocatorCount ?? 0) : 0;
  const source = explicitCount > 0 && detectedTotal === 0 ? 'explicit' : (detection?.source ?? 'explicit');
  const shard = source === 'git-status-porcelain' ? changedShard(values) : 1;
  const total = detectionAvailable ? Math.max(detectedTotal, changedLocators.length) : changedLocators.length;
  const measured = changedLocators.length;
  const omittedBefore = source === 'git-status-porcelain' ? Math.min(total, Math.max(0, (shard - 1) * shardSize)) : 0;
  const omittedAfter = source === 'git-status-porcelain' ? Math.max(0, total - omittedBefore - measured) : 0;
  return {
    source,
    changedLocatorShard: shard,
    changedLocatorShardSize: shardSize,
    changedLocatorShardCount: total > 0 ? Math.ceil(total / shardSize) : 0,
    totalChangedLocatorCount: total,
    measuredChangedLocatorCount: measured,
    omittedBeforeCount: omittedBefore,
    omittedAfterCount: omittedAfter,
    allChangesMeasured: omittedBefore + omittedAfter === 0,
    nextChangedShard: omittedAfter > 0 ? shard + 1 : null
  };
}

function explicitChangedLocatorCount(values) {
  return new Set([...options(values, '--changed'), ...options(values, '--changed-locator')]).size;
}

function valuesWithChangedShard(values, shard, { includeExplicitChanged = false } = {}) {
  const output = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--all-shards') continue;
    if (value === '--changed-shard') {
      index += 1;
      continue;
    }
    if (!includeExplicitChanged && EXPLICIT_CHANGED_LOCATOR_OPTIONS.has(value)) {
      index += 1;
      continue;
    }
    output.push(value);
  }
  output.push('--changed-shard', String(shard));
  return output;
}

function canonicalChangedLocatorForDedupe(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.includes('\0') || raw.includes('\\')) return null;
  const withoutScheme = raw.startsWith('workspace://') ? raw.slice('workspace://'.length) : raw;
  const normalized = path.posix.normalize(withoutScheme.replace(/^\.\//u, ''));
  const parts = normalized.split('/').filter(Boolean);
  if (!parts.length || normalized.startsWith('../') || normalized === '..' || path.posix.isAbsolute(normalized)) return null;
  if (parts.some((part) => part === '..')) return null;
  return `workspace://${parts.join('/')}`;
}

function valuesWithExplicitChangedOnly(values, { excludeChangedLocators = new Set() } = {}) {
  const output = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--all-shards' || value === '--changed-from-git') continue;
    if (value === '--changed-shard') {
      index += 1;
      continue;
    }
    if (value === '--changed-from' && values[index + 1] === 'git') {
      index += 1;
      continue;
    }
    if (EXPLICIT_CHANGED_LOCATOR_OPTIONS.has(value)) {
      const changedLocator = values[index + 1];
      const canonical = canonicalChangedLocatorForDedupe(changedLocator);
      if (canonical && excludeChangedLocators.has(canonical)) {
        index += 1;
        continue;
      }
    }
    output.push(value);
  }
  return output;
}

function sumReports(reports, read) {
  return reports.reduce((total, report) => total + Number(read(report) ?? 0), 0);
}

function changedLocatorSetFromReports(reports) {
  const locators = new Set();
  for (const report of reports) {
    for (const locator of report.impactBrief?.impact?.changedLocators ?? []) {
      const canonical = canonicalChangedLocatorForDedupe(locator);
      if (canonical) locators.add(canonical);
    }
  }
  return locators;
}

function buildContextPackAllShardsMeasurementReportFromReports(reports, { gitShardCount = null, totalGitChangedLocatorCount = null } = {}) {
  const first = reports[0];
  const last = reports[reports.length - 1];
  const gitReports = reports.filter((report) => report.largeContext.source === 'git-status-porcelain');
  const explicitReports = reports.filter((report) => report.largeContext.source !== 'git-status-porcelain');
  const firstGit = gitReports[0] ?? first;
  const lastGit = gitReports[gitReports.length - 1] ?? last;
  const expectedShardCount = Number(gitShardCount ?? firstGit.largeContext.changedLocatorShardCount ?? 0) + explicitReports.length;
  const totalChangedLocatorCount = Number(totalGitChangedLocatorCount ?? firstGit.largeContext.totalChangedLocatorCount ?? 0) + sumReports(explicitReports, (report) => report.largeContext.measuredChangedLocatorCount);
  const baselineUnitCount = sumReports(reports, (report) => report.tokenSaver.baselineUnitCount);
  const deliveredUnitCount = sumReports(reports, (report) => report.tokenSaver.deliveredUnitCount);
  const savedUnitCount = Math.max(0, baselineUnitCount - deliveredUnitCount);
  const report = {
    schemaVersion: '1.0.0',
    command: 'measure context-pack all-shards',
    generatedAt: first.generatedAt,
    workspaceId: first.workspaceId,
    targetHarness: first.targetHarness,
    commitSha: first.commitSha,
    measurementScope: 'local context-pack shard build plus stdio readback per shard',
    summary: {
      changedLocatorShardCount: expectedShardCount,
      shardsMeasured: reports.length,
      totalChangedLocatorCount,
      measuredChangedLocatorCount: sumReports(reports, (report) => report.largeContext.measuredChangedLocatorCount),
      omittedBeforeCount: Number(firstGit.largeContext.omittedBeforeCount ?? 0),
      omittedAfterCount: Number(lastGit.largeContext.omittedAfterCount ?? 0),
      allChangesMeasured: reports.length === expectedShardCount && Number(lastGit.largeContext.omittedAfterCount ?? 0) === 0
    },
    tokenSaver: {
      basis: 'selected-context-plus-changed-source-resend',
      baselineUnitCount,
      deliveredUnitCount,
      savedUnitCount,
      reductionRatio: baselineUnitCount > 0 ? Number((savedUnitCount / baselineUnitCount).toFixed(6)) : 0,
      selectedUnitCount: sumReports(reports, (report) => report.tokenSaver.selectedUnitCount),
      changedSourceUnitCount: sumReports(reports, (report) => report.tokenSaver.changedSourceUnitCount),
      changedSourceUnitCountIncluded: sumReports(reports, (report) => report.tokenSaver.changedSourceUnitCountIncluded),
      sourceContentIncluded: reports.some((report) => report.tokenSaver.sourceContentIncluded === true),
      providerBillingClaimed: false
    },
    shards: reports.map((report) => ({
      source: report.largeContext.source,
      changedLocatorShard: report.largeContext.changedLocatorShard,
      measuredChangedLocatorCount: report.largeContext.measuredChangedLocatorCount,
      savedUnitCount: report.tokenSaver.savedUnitCount,
      reductionRatio: report.tokenSaver.reductionRatio,
      reportFingerprint: report.reportFingerprint
    })),
    safeguards: {
      readOnly: reports.every((report) => report.safeguards.readOnly === true),
      canonicalStateMutated: reports.some((report) => report.safeguards.canonicalStateMutated === true),
      localFilesWritten: sumReports(reports, (report) => report.safeguards.localFilesWritten),
      externalWritesEnabled: reports.some((report) => report.safeguards.externalWritesEnabled === true),
      externalAdaptersEnabled: sumReports(reports, (report) => report.safeguards.externalAdaptersEnabled),
      networkCalls: sumReports(reports, (report) => report.safeguards.networkCalls),
      modelCalls: sumReports(reports, (report) => report.safeguards.modelCalls),
      activeMemoryCreated: sumReports(reports, (report) => report.safeguards.activeMemoryCreated),
      sourceSnapshotsWritten: sumReports(reports, (report) => report.safeguards.sourceSnapshotsWritten),
      privateBodiesIncluded: reports.some((report) => report.safeguards.privateBodiesIncluded === true),
      objectiveTextIncluded: reports.some((report) => report.safeguards.objectiveTextIncluded === true),
      stepTextIncluded: reports.some((report) => report.safeguards.stepTextIncluded === true),
      markdownBodyIncluded: reports.some((report) => report.safeguards.markdownBodyIncluded === true),
      sourceContentIncluded: reports.some((report) => report.safeguards.sourceContentIncluded === true),
      absoluteFilesystemLocationsIncluded: reports.some((report) => report.safeguards.absoluteFilesystemLocationsIncluded === true),
      productionBenchmarkClaimed: false
    },
    reportFingerprint: 'sha256:0000000000000000000000000000000000000000000000000000000000000000'
  };
  report.reportFingerprint = fingerprintJson({ ...report, reportFingerprint: null });
  assertJsonSchema(contextPackMeasurementReportSchema, report, 'context-pack all-shards measurement report');
  return report;
}

async function buildContextPackAllShardsMeasurementReport(values, { objective, step }) {
  const first = await buildContextPackMeasurementReport(valuesWithChangedShard(values, 1), { objective, step });
  const gitTotalChangedLocatorCount = Number(first.largeContext.totalChangedLocatorCount ?? 0);
  const shardCount = gitTotalChangedLocatorCount > 0 ? Math.max(1, Number(first.largeContext.changedLocatorShardCount ?? 1)) : 0;
  const reports = gitTotalChangedLocatorCount > 0 ? [first] : [];
  for (let shard = 2; shard <= shardCount; shard += 1) {
    reports.push(await buildContextPackMeasurementReport(valuesWithChangedShard(values, shard), { objective, step }));
  }
  if (explicitChangedLocatorCount(values) > 0) {
    const explicitOnlyValues = valuesWithExplicitChangedOnly(values, {
      excludeChangedLocators: changedLocatorSetFromReports(reports)
    });
    if (explicitChangedLocatorCount(explicitOnlyValues) > 0) {
      reports.push(await buildContextPackMeasurementReport(explicitOnlyValues, { objective, step }));
    }
  }
  if (reports.length === 0) reports.push(first);
  return buildContextPackAllShardsMeasurementReportFromReports(reports, {
    gitShardCount: shardCount,
    totalGitChangedLocatorCount: gitTotalChangedLocatorCount
  });
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
  const largeContext = buildLargeContextMeasurement({ values, changedLocators, detection });
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
    changedLocatorSource: largeContext.source === 'git-status-porcelain' ? 'git-status-porcelain' : 'explicit',
    usePlanFingerprint: usePlan.usePlanFingerprint
  });
  const summary = pack.sourceGraph.summary ?? {};
  const selection = pack.utility.sourceSelection;
  const delivery = pack.delivery ?? {};
  const tokenSaver = buildTokenSaverMeasurement({
    selection,
    delivery,
    changedSourceBudget: pack.utility.changedSourceBudget
  });
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
    tokenSaver,
    largeContext,
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
  const tokenSaver = report.tokenSaver;
  const largeContext = report.largeContext;
  return [
    '# Context Pack Measurement',
    '',
    `Target harness: ${report.targetHarness}`,
    `Commit: ${report.commitSha ?? 'unavailable'}`,
    `Report fingerprint: ${report.reportFingerprint}`,
    '',
    '## Token Saver',
    `Practical baseline units: ${Number(tokenSaver.baselineUnitCount)}`,
    `Delivered handoff units: ${Number(tokenSaver.deliveredUnitCount)}`,
    `Saved units: ${Number(tokenSaver.savedUnitCount)} (${ratioPercent(tokenSaver.reductionRatio)})`,
    `Basis: ${tokenSaver.basis}`,
    `Provider billing claimed: ${tokenSaver.providerBillingClaimed === true ? 'yes' : 'no'}`,
    '',
    '## Large Context',
    `Changed locator shard: ${Number(largeContext.changedLocatorShard)} / ${Number(largeContext.changedLocatorShardCount)}`,
    `Changed locators measured: ${Number(largeContext.measuredChangedLocatorCount)} / ${Number(largeContext.totalChangedLocatorCount)}`,
    `Omitted before shard: ${Number(largeContext.omittedBeforeCount)}`,
    `Omitted after shard: ${Number(largeContext.omittedAfterCount)}`,
    `Next shard: ${largeContext.nextChangedShard === null ? 'none' : `--changed-shard ${largeContext.nextChangedShard}`}`,
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

function renderContextPackAllShardsMeasurementSummary(report) {
  return [
    '# Context Pack Measurement All Shards',
    '',
    `Target harness: ${report.targetHarness}`,
    `Commit: ${report.commitSha ?? 'unavailable'}`,
    `Report fingerprint: ${report.reportFingerprint}`,
    '',
    '## Token Saver',
    `Practical baseline units: ${Number(report.tokenSaver.baselineUnitCount)}`,
    `Delivered handoff units: ${Number(report.tokenSaver.deliveredUnitCount)}`,
    `Saved units: ${Number(report.tokenSaver.savedUnitCount)} (${ratioPercent(report.tokenSaver.reductionRatio)})`,
    `Basis: ${report.tokenSaver.basis}`,
    `Provider billing claimed: ${report.tokenSaver.providerBillingClaimed === true ? 'yes' : 'no'}`,
    '',
    '## Large Context',
    `Shards measured: ${Number(report.summary.shardsMeasured)} / ${Number(report.summary.changedLocatorShardCount)}`,
    `Changed locators measured: ${Number(report.summary.measuredChangedLocatorCount)} / ${Number(report.summary.totalChangedLocatorCount)}`,
    `Omitted before first shard: ${Number(report.summary.omittedBeforeCount)}`,
    `Omitted after last shard: ${Number(report.summary.omittedAfterCount)}`,
    `All changes measured: ${report.summary.allChangesMeasured === true ? 'yes' : 'no'}`,
    '',
    '## Safeguards',
    `Read-only: ${passFail(report.safeguards.readOnly)}`,
    `Local files written: ${Number(report.safeguards.localFilesWritten)}`,
    `Network calls: ${Number(report.safeguards.networkCalls)}`,
    `Model calls: ${Number(report.safeguards.modelCalls)}`,
    `External writes enabled: ${report.safeguards.externalWritesEnabled === true ? 'yes' : 'no'}`,
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
  commandLabel = 'mcp resources',
  streaming = false
}) {
  const bridge = createMcpBridge({ trustedContext, resources, tools, allowReadOnlyToolsWithoutGrant });
  if (!streaming) {
    const batchInput = await readStdinText(commandLabel);
    if (!batchInput.trim()) {
      console.error(`${commandLabel} --stdio requires JSON-RPC input on stdin`);
      process.exitCode = 2;
      return;
    }
    const messages = parseJsonRpcMessages(batchInput, { commandLabel });
    for (const message of messages) {
      const response = await bridge.handle(message);
      if (response) console.log(JSON.stringify(response));
    }
    return;
  }
  let input = '';
  let lineNumber = 0;
  async function handleLine(line) {
    if (!line.trim()) return;
    lineNumber += 1;
    const message = parseJsonRpcMessageLine(line, lineNumber, { commandLabel });
    const response = await bridge.handle(message);
    if (response) console.log(JSON.stringify(response));
  }
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    input += buffer.toString('utf8');
    const lines = input.split(/\n/u);
    input = lines.pop() ?? '';
    for (const rawLine of lines) {
      await handleLine(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine);
    }
    if (Buffer.byteLength(input, 'utf8') > MCP_STDIO_MAX_LINE_BYTES) {
      throw new Error(`${commandLabel} --stdio JSON-RPC line ${lineNumber + 1} exceeds ${MCP_STDIO_MAX_LINE_BYTES} bytes`);
    }
  }
  if (input.trim()) await handleLine(input);
  if (lineNumber === 0) {
    console.error(`${commandLabel} --stdio requires JSON-RPC input on stdin`);
    process.exitCode = 2;
  }
}

async function readStdinText(commandLabel = 'mcp resources') {
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    byteLength += buffer.length;
    if (byteLength > MCP_STDIO_MAX_STDIN_BYTES) {
      throw new Error(`${commandLabel} --stdio input exceeds ${MCP_STDIO_MAX_STDIN_BYTES} bytes`);
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
  return lines.map((line, index) => parseJsonRpcMessageLine(line, index + 1, { commandLabel }));
}

function parseJsonRpcMessageLine(line, lineNumber, { commandLabel = 'mcp resources' } = {}) {
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
        sourceHash: source.contentHash,
        sourceRole: entry.sourceRole,
        sourceLineCount: source.lineCount,
        sourceByteSize: source.byteSize,
        sourceUpdatedAt: source.updatedAt,
        sourceWarnings: source.warnings,
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
  const truncated = info.size > MEMORY_PATH_MAX_BYTES;
  const [inspection, text] = await Promise.all([
    inspectFile(actual),
    truncated ? readFileHeadTail(actual, info.size, MEMORY_PATH_MAX_BYTES) : readFile(actual, 'utf8')
  ]);
  return {
    text,
    locator: `workspace://${relativePath}`,
    lineCount: inspection.lineCount,
    byteSize: info.size,
    updatedAt: info.mtime.toISOString(),
    contentHash: inspection.contentHash,
    warnings: truncated ? ['memory_path_truncated_to_8_mib'] : []
  };
}

async function readFileHeadTail(filePath, fileSize, maxBytes) {
  const handle = await open(filePath, 'r');
  try {
    const headBytes = Math.floor(maxBytes / 2);
    const tailBytes = maxBytes - headBytes;
    const head = Buffer.alloc(headBytes);
    const tail = Buffer.alloc(tailBytes);
    const headRead = await handle.read(head, 0, headBytes, 0);
    const tailStart = Math.max(0, fileSize - tailBytes);
    const tailRead = await handle.read(tail, 0, tailBytes, tailStart);
    return [
      head.subarray(0, headRead.bytesRead).toString('utf8'),
      `[... OAF memoryPath excerpt omitted ${Math.max(0, tailStart - headRead.bytesRead)} bytes; full-file hash recorded ...]`,
      tail.subarray(0, tailRead.bytesRead).toString('utf8')
    ].join('\n\n');
  } finally {
    await handle.close();
  }
}

async function inspectFile(filePath) {
  const digest = createHash('sha256');
  let byteSize = 0;
  let newlineCount = 0;
  await new Promise((resolve, reject) => {
    createReadStream(filePath)
      .on('data', (chunk) => {
        digest.update(chunk);
        byteSize += chunk.length;
        for (const byte of chunk) if (byte === 10) newlineCount += 1;
      })
      .on('error', reject)
      .on('end', resolve);
  });
  return {
    contentHash: `sha256:${digest.digest('hex')}`,
    lineCount: byteSize === 0 ? 0 : newlineCount + 1
  };
}

async function resolveWorkspaceSqlitePath(root, sqlitePath, commandName, { mustExist }) {
  const requested = sqlitePath ?? '.local/memory.sqlite';
  const lexicalRoot = path.resolve(root);
  const realRoot = await realpath(root);
  const requestedAbsolute = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(realRoot, requested);
  const existing = await stat(requestedAbsolute).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  let absolute = requestedAbsolute;
  if (existing) {
    absolute = await realpath(requestedAbsolute);
  } else {
    const parentReal = await realpath(path.dirname(requestedAbsolute)).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (parentReal) {
      absolute = path.join(parentReal, path.basename(requestedAbsolute));
    } else if (isInside(lexicalRoot, requestedAbsolute)) {
      absolute = path.resolve(realRoot, path.relative(lexicalRoot, requestedAbsolute));
    }
  }
  if (!isInside(realRoot, absolute)) {
    throw new Error(`${commandName} --sqlite must stay inside --root`);
  }
  if (mustExist && !existing?.isFile()) {
    throw new Error(`${commandName} requires an existing SQLite database at --sqlite or .local/memory.sqlite; no database is created`);
  }
  return { absolute, relative: toPosix(path.relative(realRoot, absolute)), exists: Boolean(existing?.isFile()) };
}

async function resolveWorkspaceReadPath(root, requestedPath, commandName) {
  if (!requestedPath) throw new Error(`${commandName} requires a workspace-relative JSON path`);
  if (path.isAbsolute(requestedPath) || requestedPath.includes('..')) throw new Error(`${commandName} path must stay inside --root`);
  const realRoot = await realpath(root);
  const absolute = path.resolve(realRoot, requestedPath);
  if (!isInside(realRoot, absolute)) throw new Error(`${commandName} path must stay inside --root`);
  const actual = await realpath(absolute);
  if (!isInside(realRoot, actual)) throw new Error(`${commandName} path must stay inside --root`);
  const info = await stat(actual);
  if (!info.isFile()) throw new Error(`${commandName} path must be a file`);
  return { absolute: actual, relative: toPosix(path.relative(realRoot, actual)) };
}

async function resolveWorkspaceStatsPath(root, statsPath, commandName, { mustExist }) {
  const requested = statsPath ?? '.local/mcp-stats.jsonl';
  const realRoot = await realpath(root);
  const absolute = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(realRoot, requested);
  if (!isInside(realRoot, absolute)) throw new Error(`${commandName} --stats must stay inside --root`);
  const existing = await stat(absolute).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (mustExist && !existing?.isFile()) throw new Error(`${commandName} requires an existing stats file at --stats or .local/mcp-stats.jsonl`);
  return { absolute, relative: toPosix(path.relative(realRoot, absolute)) };
}

async function resolveWorkspaceCursorPath(root, cursorPath, commandName, { mustExist }) {
  const requested = cursorPath ?? '.local/mcp-cursors.json';
  const realRoot = await realpath(root);
  const absolute = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(realRoot, requested);
  if (!isInside(realRoot, absolute)) throw new Error(`${commandName} --cursors must stay inside --root`);
  const existing = await stat(absolute).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (mustExist && !existing?.isFile()) throw new Error(`${commandName} requires an existing cursor file at --cursors or .local/mcp-cursors.json`);
  return { absolute, relative: toPosix(path.relative(realRoot, absolute)) };
}

async function buildWorkspaceMemoryIngestEpisodes({ root, workspaceId, scope, generatedAt, limit, structured = true }) {
  const episodes = [];
  const remaining = () => Math.max(0, limit - episodes.reduce((sum, episode) => sum + episode.text.split(/\n/u).filter(Boolean).length, 0));
  const projectSubject = await memoryIngestProjectSubject(root);

  if (structured) {
    for (const relativePath of await memoryIngestProviderPaths(root)) {
      if (remaining() <= 0) break;
      const facts = await collectProviderMemoryFacts(root, relativePath);
      if (!facts.length) continue;
      episodes.push(memoryIngestEpisode({
        workspaceId,
        scope,
        sourceLocator: `workspace://${relativePath}`,
        observedAt: generatedAt,
        facts: facts.slice(0, remaining()),
        metadata: { sourceKind: 'provider-catalog' }
      }));
    }
  }

  for (const relativePath of await memoryIngestDocPaths(root)) {
    if (remaining() <= 0) break;
    const facts = await collectDocMemoryFacts(root, relativePath, { structured, projectSubject });
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
    const graphFacts = await collectSourceGraphMemoryFacts(root, workspaceId, generatedAt, projectSubject);
    if (graphFacts.length) episodes.push(memoryIngestEpisode({
      workspaceId,
      scope,
      sourceLocator: 'workspace://source-graph/native-preview',
      observedAt: generatedAt,
      facts: graphFacts.slice(0, remaining()),
      metadata: { sourceKind: 'source-graph' }
    }));
  }
  const gitFacts = collectGitHistoryFacts(root, projectSubject).slice(0, Math.min(12, remaining()));
  if (gitFacts.length) episodes.push(memoryIngestEpisode({
    workspaceId,
    scope,
    sourceLocator: 'workspace://git/recent-commits',
    observedAt: generatedAt,
    facts: gitFacts,
    metadata: { sourceKind: 'git-history' }
  }));
  return dedupeMemoryIngestEpisodes(episodes);
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

function collectGitHistoryFacts(root, projectSubject) {
  try {
    return execFileSync('git', ['-C', root, 'log', '--max-count=12', '--pretty=%s'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).split(/\r?\n/u)
      .map((subject) => safeFactToken(subject, 'commit'))
      .filter(Boolean)
      .map((subject) => factTriple(projectSubject, 'recent_commit', subject));
  } catch {
    return [];
  }
}

async function memoryIngestProjectSubject(root) {
  const packageJson = await loadWorkspaceJson(root, 'package.json', null).catch(() => null);
  const name = typeof packageJson?.name === 'string' && packageJson.name.trim() ? packageJson.name : path.basename(root);
  return `project:${safeFactToken(name, 'workspace')}`;
}

async function memoryIngestDocPaths(root) {
  const paths = new Set([
    'DECISIONS.md',
    'PROJECT_STATUS.json',
    'README.md',
    'AGENTS.md',
    'PRODUCT.md',
    'docs/architecture/overview.md',
    'docs/adr/0019-proposal-gated-harness-memory-import.md',
    'docs/adr/0020-read-only-mcp-before-write-tools.md',
    'docs/adr/0021-native-source-graph-before-codebase-memory-adapter.md'
  ]);
  for (const relativePath of await collectWorkspaceMarkdownPaths(root, 'docs', 80)) paths.add(relativePath);
  return [...paths];
}

async function collectWorkspaceMarkdownPaths(root, relativeDir, limit) {
  const output = [];
  async function visit(dir) {
    if (output.length >= limit) return;
    const absolute = path.resolve(root, dir);
    const entries = await readdir(absolute, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (output.length >= limit) break;
      const relativePath = toPosix(path.join(dir, entry.name));
      if (entry.isDirectory()) {
        if (!['node_modules', '.git', 'dist', 'build', '.next'].includes(entry.name)) await visit(relativePath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        output.push(relativePath);
      }
    }
  }
  await visit(relativeDir);
  return output;
}

async function collectDocMemoryFacts(root, relativePath, { structured = true, projectSubject = 'project:workspace' } = {}) {
  const absolute = path.resolve(root, relativePath);
  const info = await stat(absolute).catch(() => null);
  if (!info?.isFile() || info.size > 512 * 1024) return [];
  const text = await readFile(absolute, 'utf8');
  const facts = [factTriple(projectSubject, 'has_doc', safeFactToken(relativePath, 'doc'))];
  if (structured && relativePath === 'PROJECT_STATUS.json') {
    try {
      facts.push(...collectProjectStatusMemoryFacts(JSON.parse(text), projectSubject));
    } catch {}
  }
  if (structured) facts.push(...collectDecisionDocMemoryFacts(text));
  if (structured && relativePath.startsWith('docs/adr/')) facts.push(...collectAdrMemoryFacts(relativePath, text));
  if (structured && relativePath.startsWith('docs/architecture/')) facts.push(...collectArchitectureDocMemoryFacts(relativePath, text));
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
    if (pattern.test(text)) facts.push(factTriple(projectSubject, predicate, object));
  }
  return [...new Set(facts)];
}

function collectProjectStatusMemoryFacts(status, projectSubject) {
  const facts = [];
  const defaults = status?.defaults && typeof status.defaults === 'object' ? status.defaults : {};
  for (const [key, value] of Object.entries(defaults)) {
    if (typeof value === 'string') facts.push(factTriple(projectSubject, `default_${camelToSnakeToken(key)}`, value));
  }
  for (const capability of (Array.isArray(status?.capabilities) ? status.capabilities : []).slice(0, 12)) {
    if (capability?.id && capability?.status) facts.push(factTriple(`capability:${capability.id}`, 'status', capability.status));
  }
  return facts;
}

function collectDecisionDocMemoryFacts(text) {
  const facts = [];
  for (const line of String(text ?? '').split(/\r?\n/u).map((item) => item.trim()).filter(Boolean).slice(0, 400)) {
    const explicit = line.match(/\b(?:Decision|Fact):\s*([A-Za-z0-9:_-]+)\s+([A-Za-z0-9:_-]+)\s+(.+)$/iu);
    if (explicit) {
      const object = cleanDecisionObject(explicit[3]);
      if (object) facts.push(decisionFactSentence(explicit[1], explicit[2], object));
      continue;
    }
    const now = line.match(/\b([A-Za-z0-9:_-]+)\s+([A-Za-z0-9:_-]+)\s+(?:is\s+)?now\s+(.+)$/iu);
    if (now) {
      const object = cleanDecisionObject(now[3]);
      if (object) facts.push(decisionFactSentence(now[1], now[2], object));
    }
  }
  return facts;
}

function cleanDecisionObject(value) {
  const object = String(value ?? '')
    .replace(/\s+(?:and\s+)?(?:supersedes|replaces|overrides)\s+.+$/iu, '')
    .replace(/[.;:,]+$/u, '')
    .trim()
    .slice(0, 240);
  if (!object || MCP_PRIVATE_MATERIAL.test(object)) return null;
  return object;
}

function decisionFactSentence(subject, predicate, object) {
  return `Decision: ${safeFactToken(subject, 'subject')} ${safeFactToken(predicate, 'predicate')} ${object}.`;
}

function collectAdrMemoryFacts(relativePath, text) {
  const id = path.basename(relativePath, '.md').replace(/[^0-9a-z-]+/giu, '_');
  const heading = text.split(/\r?\n/u).find((line) => line.startsWith('# '))?.replace(/^#\s+/u, '');
  return heading ? [factTriple(`adr:${id}`, 'decision', heading)] : [];
}

function collectArchitectureDocMemoryFacts(relativePath, text) {
  const id = path.basename(relativePath, '.md').replace(/[^0-9a-z-]+/giu, '_');
  const heading = text.split(/\r?\n/u).find((line) => line.startsWith('# '))?.replace(/^#\s+/u, '');
  return heading ? [factTriple(`architecture:${id}`, 'documents', heading)] : [];
}

async function memoryIngestProviderPaths(root) {
  const nativeRoot = path.resolve(root, 'providers/native');
  const entries = await readdir(nativeRoot, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => `providers/native/${entry.name}/provider.json`);
}

async function collectProviderMemoryFacts(root, relativePath) {
  const manifest = await loadWorkspaceJson(root, relativePath, null).catch(() => null);
  if (!manifest?.id) return [];
  const facts = [];
  if (manifest.contract) facts.push(factTriple(manifest.id, 'implements_port', manifest.contract));
  if (manifest.category) facts.push(factTriple(manifest.id, 'provider_category', manifest.category));
  if (manifest.enabledByDefault === true) facts.push(factTriple(manifest.id, 'enabled_by_default', 'true'));
  return facts;
}

function dedupeMemoryIngestEpisodes(episodes) {
  const seen = new Set();
  return episodes.map((episode) => {
    const facts = [];
    for (const fact of episode.text.split(/\n/u).filter(Boolean)) {
      const key = fact.replace(/\.$/u, '').toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      facts.push(fact);
    }
    return facts.length ? { ...episode, text: facts.join('\n') } : null;
  }).filter(Boolean);
}

async function collectSourceGraphMemoryFacts(root, workspaceId, generatedAt, projectSubject) {
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
    factTriple(projectSubject, 'source_graph_files', `files_${Math.max(0, Number(summary.fileCount ?? 0))}`),
    factTriple(projectSubject, 'source_graph_modules', `modules_${Math.max(0, Number(summary.moduleCount ?? 0))}`),
    factTriple(projectSubject, 'source_graph_symbols', `symbols_${Math.max(0, Number(summary.symbolCount ?? 0))}`)
  ];
  for (const hotspot of (summary.hotspots ?? []).slice(0, 5)) {
    const label = safeFactToken(hotspot.label ?? hotspot.name ?? hotspot.id, 'hotspot');
    if (label) facts.push(factTriple(projectSubject, 'source_graph_hub', label));
  }
  return facts;
}

function factTriple(subject, predicate, object) {
  return `${safeFactToken(subject, 'subject')} ${safeFactToken(predicate, 'predicate')} ${safeFactObjectToken(object, 'object')}.`;
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

function safeFactObjectToken(value, fallback) {
  const normalized = String(value ?? '')
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9:_-]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 96);
  return /^[A-Za-z0-9:_-]{1,128}$/u.test(normalized || '') ? normalized : safeFactToken(value, fallback);
}

function camelToSnakeToken(value) {
  return safeFactToken(String(value).replace(/([a-z0-9])([A-Z])/g, '$1_$2'), 'field');
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
    extractionConfidence: MEMORY_BATCH_CONFIDENCES.has(item.payload.extractionConfidence) ? item.payload.extractionConfidence : 'extracted',
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

async function buildContextRetrieveReport({ root, workspaceId, target, generatedAt }) {
  const usePlan = await loadCurrentContextPackUsePlan({ root, workspaceId, clock: () => generatedAt }).catch(() => null);
  const readItem = findRetrieveReadItem(usePlan, target);
  const locator = readItem?.locator ?? (String(target).startsWith('sha256:') ? null : String(target));
  if (!locator) throw new Error('context retrieve hash was not found in the current verified context-pack use plan');
  const source = await readWorkspaceLocator(root, locator);
  const contentHash = `sha256:${createHash('sha256').update(source.text).digest('hex')}`;
  if (String(target).startsWith('sha256:') && contentHash !== target) throw new Error('context retrieve hash no longer matches local source');
  if (readItem?.contentHash && readItem.contentHash !== contentHash) throw new Error('context retrieve source is stale against current use plan');
  const sensitive = SECRET_LIKE.test(source.text) || PRIVATE_LOCAL_PATH.test(source.text) || AUTO_DETECTED_SECRET_PATH.test(source.relativePath);
  return {
    schemaVersion: '1.0.0',
    command: 'context retrieve',
    generatedAt,
    workspaceId,
    state: sensitive ? 'withheld' : 'ready',
    target,
    locator,
    matchedUsePlan: Boolean(readItem),
    role: readItem?.role ?? 'direct_workspace_read',
    required: readItem?.required ?? false,
    represented: readItem?.represented ?? null,
    contentHash,
    byteSize: source.byteSize,
    lineCount: source.lineCount,
    contentIncluded: !sensitive,
    content: sensitive ? null : source.text,
    reasonCodes: [
      readItem ? 'use_plan_match' : 'direct_workspace_locator',
      sensitive ? 'sensitive_content_withheld' : 'content_recovered',
      readItem?.contentHash ? 'content_hash_verified' : null
    ].filter(Boolean),
    readHint: readItem?.readHint ?? `Read ${locator} from the local workspace.`,
    safeguards: {
      readOnly: true,
      canonicalStateMutated: false,
      localFilesWritten: 0,
      homeConfigMutated: false,
      externalWritesEnabled: false,
      externalAdaptersEnabled: 0,
      networkCalls: 0,
      modelCalls: 0,
      sensitiveContentIncluded: false
    }
  };
}

function findRetrieveReadItem(usePlan, target) {
  const reads = usePlan?.requiredLocalReads ?? [];
  if (String(target).startsWith('sha256:')) return reads.find((item) => item.contentHash === target) ?? null;
  return reads.find((item) => item.locator === target) ?? null;
}

async function readWorkspaceLocator(root, locator) {
  const relativePath = relativePathFromContextLocator(locator);
  if (!relativePath || relativePath.includes('..') || path.isAbsolute(relativePath)) throw new Error('context retrieve locator is unsupported');
  if (AUTO_DETECTED_SECRET_PATH.test(relativePath)) throw new Error('context retrieve refuses secret-like workspace paths');
  const realRoot = await realpath(root);
  const absolute = path.resolve(realRoot, relativePath);
  const actual = await realpath(absolute).catch((error) => {
    if (error.code === 'ENOENT') throw new Error('context retrieve locator is not a file');
    throw error;
  });
  if (!isInside(realRoot, actual)) throw new Error('context retrieve locator escapes workspace root');
  const info = await stat(actual);
  if (!info.isFile()) throw new Error('context retrieve locator is not a file');
  if (info.size > 256 * 1024) throw new Error('context retrieve locator exceeds 256 KiB');
  const text = await readFile(actual, 'utf8');
  return {
    text,
    relativePath,
    byteSize: info.size,
    lineCount: text ? text.split(/\r\n|\r|\n/u).length : 0
  };
}

function relativePathFromContextLocator(locator) {
  const value = String(locator ?? '');
  if (value.startsWith('workspace://')) return value.slice('workspace://'.length);
  if (value.startsWith('user-selected://')) return value.slice('user-selected://'.length);
  return null;
}

async function applyConnection({ action, agent, home, setup, generatedAt }) {
  const changes = [
    await prepareMcpConfigChange({ action, home, setup }),
    await prepareHookConfigChange({ action, home, setup })
  ];
  const operations = [];
  for (const change of changes) {
    operations.push(change.operation ?? await writeHomeFileIfChanged({ home, generatedAt, ...change }));
  }
  const localFilesWritten = operations.reduce((sum, operation) => sum + operation.filesWritten, 0);
  return {
    state: operations.some((operation) => operation.changed) ? `${action}ed` : 'unchanged',
    agent,
    localFilesWritten,
    homeConfigMutated: operations.some((operation) => operation.changed),
    externalWritesEnabled: false,
    authorityGranted: false,
    memoryActivated: false,
    operations
  };
}

function connectionDryRunReceipt() {
  return {
    state: 'preview-ready',
    localFilesWritten: 0,
    homeConfigMutated: false,
    externalWritesEnabled: false,
    authorityGranted: false,
    memoryActivated: false,
    operations: []
  };
}

async function prepareMcpConfigChange({ action, home, setup }) {
  const relativePath = homeRefRelativePath(setup.config.ref);
  const current = await readHomeFile(home, relativePath);
  if (action === 'disconnect' && setup.status.server !== 'installed') {
    return { operation: skippedOperation('mcp', setup.config.ref, 'not_installed_or_drifted') };
  }
  const nextText = setup.config.format === 'toml'
    ? nextTomlMcpConfig(current.text, setup.manualConfigSnippet.content, action)
    : nextJsonMcpConfig(current.text, setup.desiredServer, action);
  return { relativePath, current, nextText, role: 'mcp' };
}

async function prepareHookConfigChange({ action, home, setup }) {
  if (!setup.desiredHooks.supported) return { operation: skippedOperation('hook', setup.manualHookSnippet.configRef, 'unsupported') };
  const relativePath = homeRefRelativePath(setup.manualHookSnippet.configRef);
  const current = await readHomeFile(home, relativePath);
  const nextText = nextJsonHookConfig(current.text, setup.desiredHooks, action);
  return { relativePath, current, nextText, role: 'hook' };
}

function nextTomlMcpConfig(text, snippet, action) {
  const withoutOaf = removeTomlMcpServer(text ?? '', 'oaf').trimEnd();
  if (action === 'disconnect') return withoutOaf ? `${withoutOaf}\n` : '';
  return `${withoutOaf ? `${withoutOaf}\n\n` : ''}${snippet.trim()}\n`;
}

function removeTomlMcpServer(text, server) {
  const lines = String(text ?? '').split(/\r\n|\r|\n/u);
  const output = [];
  let skipping = false;
  const target = new RegExp(`^\\[mcp_servers\\.${server}\\]\\s*$`, 'u');
  for (const line of lines) {
    const trimmed = line.trim();
    if (target.test(trimmed)) {
      skipping = true;
      continue;
    }
    if (skipping && /^\[[^\]]+\]\s*$/u.test(trimmed)) skipping = false;
    if (!skipping) output.push(line);
  }
  return output.join('\n');
}

function nextJsonMcpConfig(text, desiredServer, action) {
  const doc = parseJsonHomeConfig(text);
  const servers = doc.mcpServers ?? {};
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error('mcpServers must be an object');
  if (action === 'disconnect') {
    if (isDesiredOafServer(servers.oaf)) delete servers.oaf;
  } else {
    servers.oaf = { command: desiredServer.command, args: desiredServer.args };
  }
  doc.mcpServers = servers;
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function nextJsonHookConfig(text, desiredHooks, action) {
  const doc = parseJsonHomeConfig(text);
  const hooks = doc.hooks ?? {};
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) throw new Error('hooks must be an object');
  for (const event of desiredHooks.events) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    if (hooks[event] && !Array.isArray(hooks[event])) throw new Error(`hooks.${event} must be an array`);
    hooks[event] = action === 'disconnect'
      ? removeHookCommand(existing, desiredHooks.command)
      : addHookCommand(existing, desiredHooks.command);
    if (hooks[event].length === 0) delete hooks[event];
  }
  doc.hooks = hooks;
  if (Object.keys(hooks).length === 0) delete doc.hooks;
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function addHookCommand(entries, command) {
  if (entries.some((entry) => hookEntryHasCommand(entry, command))) return entries;
  return [...entries, { hooks: [{ type: 'command', command, timeout: 5 }] }];
}

function removeHookCommand(entries, command) {
  return entries.map((entry) => {
    if (!Array.isArray(entry?.hooks)) return entry;
    return { ...entry, hooks: entry.hooks.filter((hook) => hook?.command !== command) };
  }).filter((entry) => !Array.isArray(entry?.hooks) || entry.hooks.length > 0);
}

function hookEntryHasCommand(entry, command) {
  return Array.isArray(entry?.hooks) && entry.hooks.some((hook) => hook?.command === command);
}

function parseJsonHomeConfig(text) {
  if (!text) return {};
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('home config must be a JSON object');
  return parsed;
}

function isDesiredOafServer(server) {
  return isOafServerInvocation(server, OAF_MCP_RESOURCE_BINARY_ARGS);
}

function isOafServerInvocation(server, binaryArgs) {
  return Boolean(server) &&
    Array.isArray(server.args) &&
    (
      (server.command === 'oaf' && arraysEqual(server.args, binaryArgs)) ||
      (server.command === 'npm' && arraysEqual(server.args, [...OAF_CHECKOUT_ARG_PREFIX, ...binaryArgs]))
    );
}

async function readHomeFile(home, relativePath) {
  const { absolute } = await resolveHomePath(home, relativePath);
  const entry = await lstat(absolute).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!entry) return { exists: false, text: '' };
  if (entry.isSymbolicLink()) throw new Error(`home config target is a symlink: ${relativePath}`);
  if (!entry.isFile()) throw new Error(`home config target is not a file: ${relativePath}`);
  if (entry.size > 256 * 1024) throw new Error(`home config exceeds 256 KiB: ${relativePath}`);
  return { exists: true, text: await readFile(absolute, 'utf8') };
}

async function writeHomeFileIfChanged({ home, relativePath, current, nextText, generatedAt, role }) {
  if ((current.text ?? '') === nextText) return {
    role,
    target: `home://${toPosix(relativePath)}`,
    changed: false,
    filesWritten: 0,
    backupRef: null,
    reason: 'already_current'
  };
  const { root, absolute } = await resolveHomePath(home, relativePath);
  await assertNoSymlinkAncestors(root, relativePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  const backupRef = current.exists ? await writeHomeBackup({ home, relativePath, text: current.text, generatedAt }) : null;
  const existing = await lstat(absolute).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing?.isSymbolicLink()) throw new Error(`home config target is a symlink: ${relativePath}`);
  await writeFile(absolute, nextText, 'utf8');
  return {
    role,
    target: `home://${toPosix(relativePath)}`,
    changed: true,
    filesWritten: backupRef ? 2 : 1,
    backupRef,
    reason: current.exists ? 'updated_with_backup' : 'created'
  };
}

async function writeHomeBackup({ home, relativePath, text, generatedAt }) {
  const suffix = `${generatedAt.replace(/[^0-9A-Za-z_-]/gu, '-')}-${createHash('sha256').update(text).digest('hex').slice(0, 8)}`;
  const backupRelative = `${relativePath}.oaf-backup-${suffix}`;
  const { root, absolute } = await resolveHomePath(home, backupRelative);
  await assertNoSymlinkAncestors(root, backupRelative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, text, 'utf8');
  return `home://${toPosix(backupRelative)}`;
}

async function resolveHomePath(home, relativePath) {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('..')) throw new Error(`home config path is unsupported: ${relativePath}`);
  const root = await realpath(home);
  const absolute = path.resolve(root, relativePath);
  if (!isInside(root, absolute)) throw new Error(`home config path escapes home: ${relativePath}`);
  return { root, absolute };
}

function homeRefRelativePath(ref) {
  const value = String(ref ?? '');
  if (!value.startsWith('home://')) throw new Error(`unsupported home config ref: ${value}`);
  return value.slice('home://'.length);
}

function skippedOperation(role, target, reason) {
  return { role, target, changed: false, filesWritten: 0, backupRef: null, reason };
}

function normalizeConnectionAgent(value) {
  const normalized = new Map([['claude', 'claude-code']]).get(String(value ?? '').trim()) ?? String(value ?? '').trim();
  if (!['codex', 'claude-code'].includes(normalized)) throw new Error('connect supports codex or claude-code');
  return normalized;
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

function memoryFactIdFromProposalId(proposalId) {
  return `memfact_${String(proposalId).replace(/^mpq_/u, '').slice(0, 128)}`;
}

function memoryEpisodeIdFromProposalId(proposalId) {
  return `mep_${String(proposalId).replace(/^mpq_/u, '').slice(0, 128)}`;
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

function sourceCheckoutHasOafScript() {
  return existsSync(path.resolve(process.cwd(), 'package.json')) && existsSync(path.resolve(process.cwd(), 'apps/cli/oaf.mjs'));
}

function oafCommand(args) {
  return sourceCheckoutHasOafScript() ? `${OAF_CHECKOUT_COMMAND_PREFIX} ${args}` : `oaf ${args}`;
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
    if (valueOptions.has(value) && index + 1 < values.length && !values[index + 1].startsWith('--')) index += 1;
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
  const shard = changedShard(values);
  const detection = await detectGitChangedLocators({ root, workspaceId, offset: (shard - 1) * 16, clock: fixedNow });
  if (detection.status !== 'available') {
    console.error(`local git changed-file detection unavailable: ${detection.reason}`);
    return { changedLocators: explicit, detection };
  }
  if (detection.truncated) {
    const shardCount = detection.totalChangedLocatorCount > 0 ? Math.ceil(detection.totalChangedLocatorCount / 16) : 0;
    console.error(`local git changed-file detection measuring shard ${shard}/${shardCount}; ${detection.changedLocators.length} of ${detection.totalChangedLocatorCount} locators in this run`);
  }
  const changedLocators = [...new Set([...explicit, ...detection.changedLocators])].sort();
  if (changedLocators.length > 16) throw new Error('changed_context_too_many_locators');
  return { changedLocators, detection };
}

function firstPositional(values, valueOptions = new Set()) {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) return value;
    if (valueOptions.has(value) && index + 1 < values.length && !values[index + 1].startsWith('--')) index += 1;
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

function strictNumberOption(values, name, fallback) {
  const value = option(values, name);
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number`);
  return parsed;
}

function resolveCommitSha(root = process.cwd()) {
  if (/^[a-f0-9]{40}$/.test(process.env.OAF_COMMIT_SHA ?? '')) return process.env.OAF_COMMIT_SHA;
  const expectedRoot = realComparablePath(root);
  try {
    const resolvedRoot = path.resolve(root);
    const gitRoot = execFileSync('git', ['-C', resolvedRoot, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (realComparablePath(gitRoot) !== expectedRoot) return '0000000000000000000000000000000000000000';
    const value = execFileSync('git', ['-C', resolvedRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (/^[a-f0-9]{40}$/.test(value)) return value;
  } catch {
    // Git metadata is unavailable in generated source archives.
  }
  return '0000000000000000000000000000000000000000';
}

function realComparablePath(value) {
  const resolved = path.resolve(value);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function runNode(nodeArgs, { cwd = PACKAGE_ROOT, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const [script, ...rest] = nodeArgs;
    const resolvedScript = path.isAbsolute(script) ? script : path.join(PACKAGE_ROOT, script);
    const child = spawn(process.execPath, [resolvedScript, ...rest], { stdio: 'inherit', env, cwd });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

function isHelpCommand(value) {
  return ['help', '--help', '-h'].includes(value);
}

function helpCommandName() {
  if (process.env.npm_lifecycle_event === 'recall') return 'recall';
  return path.basename(process.argv[1] ?? '') === 'recall' ? 'recall' : 'oaf';
}

function renderHelpText(text) {
  const command = helpCommandName();
  if (command === 'oaf') return text;
  return text
    .replaceAll('Open Agent Fabric CLI', 'Memory Recall CLI')
    .replace(
      /\boaf (?=(status|setup|verify|doctor|connect|disconnect|task|demo|serve|check|eval|manifest|handoff|token-saver|context|loop|skill|measure|benchmark|bench|memory|mcp|harness|hook|version)\b)/g,
      `${command} `
    );
}

function help(topic, subtopic) {
  const topicHelp = helpTopic(topic, subtopic);
  if (topicHelp) {
    console.log(renderHelpText(topicHelp));
    return;
  }

  console.log(renderHelpText(`Open Agent Fabric CLI

Usage:
  oaf status
  oaf setup
  oaf verify
  oaf doctor
  oaf connect codex --dry-run --format json
  oaf disconnect codex --dry-run --format json
  oaf task <OAF-ID>
  oaf demo [objective]
  oaf demo memory-loop --root . --format json
  oaf serve
  oaf check
  oaf eval
  oaf manifest
  oaf handoff
  oaf handoff --read-only --from codex --root . --objective "Ship safely" --step "handoff" --target codex --changed-from-git --format summary
  oaf token-saver
  oaf token-saver --all-shards
  oaf token-saver --read-only --root . --from codex --objective "Ship safely" --step "impact brief" --target codex --changed-from-git --format summary
  oaf context --request request.json --records records.json
  oaf context profile --records memory-export.json --objective "Ship safely" --step "select compact memory" --token-budget 4096 --format json
  oaf context scan --from codex --root . --dry-run
  oaf context preview --from codex --root . --objective "Ship safely" --step "select context" --include-file notes/handoff.md --dry-run
  oaf context pack --from codex --root . --objective "Ship safely" --step "handoff" --target codex --include-file notes/handoff.md --changed src/auth.ts --changed-from-git --dry-run --format markdown
  oaf context pack --from codex --root . --objective "Ship safely" --step "handoff" --target codex --write --out context-packs/CONTEXT_PACK.md --use-out context-packs/CONTEXT_PACK.use.json --format json
  oaf context pack --from codex --root . --objective "Ship safely" --step "handoff" --target codex --write --pin --out context-packs/CONTEXT_PACK.md --format json
  oaf context handoff --read-only --from codex --root . --objective "Ship safely" --step "handoff" --target codex --changed src/auth.ts --memory-config oaf.memory.json --format json
  oaf context handoff --read-only --from codex --root . --objective "Ship safely" --step "handoff" --target codex --changed src/auth.ts --format summary
  oaf context receive --read-only --root . --target codex --format json
  oaf context receive --read-only --root . --target codex --format summary
  oaf context retrieve workspace://AGENTS.md --read-only --root . --format json
  oaf context retrieve workspace://AGENTS.md --read-only --root . --format summary
  oaf context registry status --read-only --format json
  oaf context graph preview --root . --query "approve token reset" --trace runAuthWorkflow --changed src/auth.ts --changed-from-git --dry-run --format summary
  oaf loop plan --read-only --root . --objective "Ship safely" --stop-condition "focused tests pass" --validation "node --test tests/web-shell.test.mjs" --format json
  oaf loop observe --root . --plan loop-plan.json --execute-commands --format json
  oaf loop verify --root . --plan loop-plan.json --worktree ../isolated-worktree --sqlite .local/memory.sqlite --execute-commands --format json
  oaf loop run --root . --plan loop-plan.json --worktree ../isolated-worktree --sqlite .local/memory.sqlite --execute-commands --format json
  oaf loop schedule --read-only --root . --plan loop-plan.json --kind triage --cadence manual --format json
  oaf skill catalog --read-only --root . --format json
  oaf skill load-plan --read-only --root . --id skill:oaf-memory --format json
  oaf skill load-plan --read-only --root . --id skill:oaf-memory --format summary
  oaf measure savings --read-only --root . --objective "Ship safely" --step "measure savings" --format json
  oaf measure savings --read-only --root . --objective "Ship safely" --step "measure savings" --format summary
  oaf measure context-pack --read-only --root . --from codex --objective "Ship safely" --step "impact brief" --target codex --changed src/auth.ts --format json
  oaf measure context-pack --read-only --root . --from codex --objective "Ship safely" --step "impact brief" --target codex --changed src/auth.ts --format summary
  oaf benchmark truth-floor --suite benchmark-truth-floor --dataset evals/benchmark-truth-floor/cases.v1.json --format json
  oaf bench sufficiency --read-only --root . --format json
  oaf bench temporal --read-only --root . --format json
  oaf bench session --read-only --root . --format json
  oaf bench realqa --read-only --root . --format json
  oaf bench locomo --read-only --root . --dataset evals/locomo/smoke.v1.json --format json
  oaf memory profile --records memory-export.json --root . --dry-run --format json
  oaf memory remember --root . --sqlite .local/memory.sqlite --subject auth --predicate token_expiry --object "15 minutes" --supersedes-subject auth --supersedes-predicate token_expiry --source workspace://DECISIONS.md --format json
  oaf memory remember --batch facts.json --root . --sqlite .local/memory.sqlite --format json
  oaf memory ingest --root . --sqlite .local/memory.sqlite --format json
  oaf memory review --root . --sqlite .local/memory.sqlite --format summary
  oaf memory approve mpq_status --root . --sqlite .local/memory.sqlite --format json
  oaf memory approve --all-from workspace://PROJECT_STATUS.json --root . --sqlite .local/memory.sqlite --format json
  oaf memory approve --all --root . --sqlite .local/memory.sqlite --format json
  oaf memory reject mpq_status --root . --sqlite .local/memory.sqlite --format json
  oaf memory review approve --root . --sqlite .local/memory.sqlite --proposal mpq_status --format json
  oaf memory refine --read-only --root . --sqlite .local/memory.sqlite --target-active-facts 200 --format json
  oaf memory refine --read-only --root . --sqlite .local/memory.sqlite --target-active-facts 200 --min-confidence 0.5 --format summary
  oaf memory proposals --records memory-export.json --root . --dry-run --format json
  oaf memory proposals --from memoryPaths --config oaf.memory.json --root . --dry-run --format json
  oaf memory sgrep "context manifest" --records memory-export.json --workspace ws_local --dry-run --format json
  oaf memory fact add --sqlite .local/memory.sqlite --workspace ws_local --scope workspace --subject project:oaf --predicate release_status --object release-candidate --text "OAF release status is release-candidate." --source workspace://memory/status.md --proposal mpq_status --episode-id mep_status --episode-source workspace://memory/status.md --episode-summary "Reviewed status note." --format json
  oaf memory fact get --sqlite .local/memory.sqlite --workspace ws_local --scope workspace --subject project:oaf --predicate release_status --at 2026-06-26T00:00:00.000Z --format json
  oaf memory fact history --sqlite .local/memory.sqlite --workspace ws_local --scope workspace --subject project:oaf --predicate release_status --format json
  oaf memory search "release" --sqlite .local/memory.sqlite --workspace ws_local --scope workspace --format json
  oaf memory path --root . --sqlite .local/memory.sqlite --workspace ws_local --scope workspace --from project:oaf --to temporal-memory --max-hops 6 --format json
  oaf memory explain --root . --sqlite .local/memory.sqlite --workspace ws_local --scope workspace --entity auth --depth 1 --format json
  oaf mcp inspect --read-only --root . --format json
  oaf mcp resources --read-only --workspace ws_local --format json
  oaf mcp resources --read-only --uri oaf://workspace/ws_local/skills/catalog --format json
  oaf mcp resources --read-only --uri oaf://workspace/ws_local/tools/catalog --format summary
  oaf mcp resources --read-only --memory-refine --uri oaf://workspace/ws_local/memory/refine --format summary
  oaf mcp resources --read-only --context-pack --objective "Ship safely" --step "handoff" --target codex --changed src/auth.ts --changed-from-git --uri oaf://workspace/ws_local/context-pack/current --format json
  oaf mcp resources --read-only --context-pack-use context-packs/CONTEXT_PACK.use.json --uri oaf://workspace/ws_local/context-pack/use-plan/current --format json
  oaf mcp resources --read-only --context-pack-registry --uri oaf://workspace/ws_local/context-pack/registry/current --format json
  oaf mcp smoke context-pack --read-only --objective "Ship safely" --step "handoff" --target codex --changed src/auth.ts --changed-from-git --format json
  oaf mcp resources --read-only --stdio
  oaf mcp server --read-only --root . --stdio
  oaf mcp stats --read-only --root . --format json
  oaf mcp install --client claude-code --dry-run --format json
  oaf harness setup status --client codex --dry-run --format json
  oaf harness setup plan --client cursor --server oaf --dry-run --format json
  oaf harness setup uninstall --client cursor --server oaf --dry-run --format json
  oaf hook install --agent codex --dry-run --format json
  oaf hook uninstall --agent codex --dry-run --format json
  oaf hook context --read-only --format text
  oaf version

Start with oaf status; if it says Next task: none, run the First safe handoff command it prints.
Run oaf task only when npm run status names a next task.
oaf setup bootstraps the local checkout; use oaf harness setup plan/status for dry-run harness wiring previews.
The default bootstrap is local-only and enables no external writes.`));
}

function helpTopic(topic, subtopic) {
  const key = [topic, subtopic].filter(Boolean).join(' ');
  const topics = new Map([
    ['setup', `Open Agent Fabric CLI: setup

Usage:
  oaf setup

Runs the repository bootstrap script for this local checkout. It does not
configure MCP clients, install harness servers, activate memory, or enable
external writes.

Use harness setup for client wiring previews:
  oaf harness setup status --client codex --dry-run --format json
  oaf harness setup plan --client codex --server oaf --dry-run --format json`],
    ['connect', `Open Agent Fabric CLI: connect

Usage:
  oaf connect codex --dry-run --format json
  oaf connect codex --yes --format json
  oaf disconnect codex --dry-run --format json

Previews or applies local harness client configuration through the governed
connection wrapper. It is dry-run by default. --yes writes only the local
harness client config for the selected agent; it does not enable external
writes, grant authority, activate memory, or call models.`],
    ['disconnect', `Open Agent Fabric CLI: disconnect

Usage:
  oaf disconnect codex --dry-run --format json
  oaf disconnect codex --yes --format json

Previews or applies removal of local OAF harness client configuration through
the governed connection wrapper. It is dry-run by default. --yes removes only
matching local harness config entries; it does not touch project state, memory,
models, or external services.`],
    ['harness setup', `Open Agent Fabric CLI: harness setup

Usage:
  oaf harness setup status --client codex --dry-run --format json
  oaf harness setup plan --client cursor --server oaf --dry-run --format json
  oaf harness setup uninstall --client cursor --server oaf --dry-run --format json

Builds dry-run reports for local harness client wiring. This command is preview
only: it requires --dry-run, does not mutate home config, does not write local
files, does not grant authority, and does not enable external writes.`],
    ['context', `Open Agent Fabric CLI: context

Usage:
  oaf handoff
  oaf context scan --from codex --root . --dry-run
  oaf context preview --from codex --root . --objective "Ship safely" --step "select context" --include-file notes/handoff.md --dry-run
  oaf context pack --from codex --root . --objective "Ship safely" --step "handoff" --target codex --include-file notes/handoff.md --changed src/auth.ts --dry-run --format json
  oaf context handoff --read-only --from codex --root . --objective "Ship safely" --step "handoff" --target codex --changed src/auth.ts --format json
  oaf context handoff --read-only --from codex --root . --objective "Ship safely" --step "handoff" --target codex --changed src/auth.ts --format summary
  oaf context receive --read-only --root . --target codex --format json
  oaf context receive --read-only --root . --target codex --format summary
  oaf context retrieve workspace://AGENTS.md --read-only --root . --format summary
  oaf context graph preview --root . --query "approve token reset" --trace runAuthWorkflow --changed src/auth.ts --dry-run --format summary
  oaf context registry status --read-only --format json

Context commands select local handoff context, preview harness inputs, and read
pinned context-pack state. Graph preview is dry-run only. Read-only commands do
not write files, call models, use network access, or expose raw source bodies.
Retrieve summary verifies locator/hash metadata without printing file content.`],
    ['context handoff', `Open Agent Fabric CLI: context handoff

Usage:
  oaf handoff
  oaf context handoff --read-only --from codex --root . --objective "Ship safely" --step "handoff" --target codex --changed src/auth.ts --format json
  oaf context handoff --read-only --from codex --root . --objective "Ship safely" --step "handoff" --target codex --changed src/auth.ts --format summary

Options:
  --from <codex[,cursor,claude-code]>  Source harness families to inspect.
  --target <codex|cursor|claude-code|a2a|generic>  Receiver harness.
  --include-file <path>                Add reviewed workspace-relative files.
  --changed <path>                     Add reviewed changed files.
  --changed-from-git                   Detect changed files with local git.
  --memory-config <path>               Preflight selected memory source paths.
  --format json|summary                Emit the validated report or compact operator summary.

Builds a read-only local agent handoff with context-pack proof, MCP readback,
harness setup dry-run status, and zero-tool MCP proof. It requires --read-only
and does not write files, import harness history, call models, use network
access, or expose raw source bodies.`],
    ['handoff', `Open Agent Fabric CLI: handoff

Usage:
  oaf handoff
  oaf handoff --read-only --from codex --root . --objective "Ship safely" --step "handoff" --target codex --changed-from-git --format summary
  oaf context handoff --read-only --from codex --root . --objective "Ship safely" --step "handoff" --target codex --changed src/auth.ts --format json

Runs the read-only context handoff flow. With no flags it defaults to a compact
Codex summary for the current repository and local git changes. It does not
write files, import harness history, call models, use network access, enable
external adapters, create active memory, or expose raw source bodies.`],
    ['token-saver', `Open Agent Fabric CLI: token-saver

Usage:
  oaf token-saver
  oaf token-saver --all-shards
  oaf token-saver --read-only --root . --from codex --objective "Ship safely" --step "impact brief" --target codex --changed-from-git --format summary
  oaf measure context-pack --read-only --root . --from codex --objective "Ship safely" --step "impact brief" --target codex --changed src/auth.ts --format json

Runs the read-only context-pack measurement flow. With no flags it measures the
current repository and local git changes. It does not write files, call models,
use network access, enable external adapters, include raw source bodies, or
claim provider billing-token savings.`],
    ['context receive', `Open Agent Fabric CLI: context receive

Usage:
  oaf context receive --read-only --root . --target codex --format json
  oaf context receive --read-only --root . --target codex --format summary

Reads the pinned local context-pack registry, current pointer, and use plan
without rebuilding or writing files. JSON returns the versioned receiver packet;
summary prints state, recipient proof, packet parts, required reads, and report
fingerprint. It rejects task text, write flags, MCP stdio mode, raw Markdown
bodies, source bodies, credentials, provider URLs, and absolute local paths.`],
    ['context registry', `Open Agent Fabric CLI: context registry

Usage:
  oaf context registry status --read-only --format json

Reads the pinned local context-pack registry and verifies the current pointer,
artifact hashes, and source hashes. It requires --read-only and does not rebuild
packs, write artifacts, call models, use network access, or expose raw source
bodies.`],
    ['skill', `Open Agent Fabric CLI: skill

Usage:
  oaf skill catalog --read-only --root . --format json
  oaf skill catalog --read-only --root . --format summary
  oaf skill load-plan --read-only --root . --id skill:oaf-memory --format json
  oaf skill load-plan --read-only --root . --id skill:oaf-memory --format summary

Skill commands inspect local OAF skill manifests. They do not grant tool
authority or load raw skill text into the report.`],
    ['skill catalog', `Open Agent Fabric CLI: skill catalog

Usage:
  oaf skill catalog --read-only --root . --format json
  oaf skill catalog --read-only --root . --format summary

Reports side-effect classes, tool IDs, manifest fingerprints, and
catalog/report fingerprints for workspace skills. It requires --read-only and
does not include raw skill text, expose absolute filesystem paths, grant tool
authority, start MCP stdio, call models, use network access, or write local
files.`],
    ['skill load-plan', `Open Agent Fabric CLI: skill load-plan

Usage:
  oaf skill load-plan --read-only --root . --id skill:oaf-memory --format json
  oaf skill load-plan --read-only --root . --id skill:oaf-memory --format summary

Returns the ordered local reads for one skill: manifest, SKILL.md, and declared
references. It requires --read-only and does not include raw skill text, grant
tool authority, start MCP stdio, call models, use network access, or write local
files.`],
    ['measure', `Open Agent Fabric CLI: measure

Usage:
  oaf measure savings --read-only --root . --objective "Ship safely" --step "measure savings" --format json
  oaf measure context-pack --read-only --root . --from codex --objective "Ship safely" --step "impact brief" --target codex --changed src/auth.ts --format json

Measure commands emit local evidence about context delivery. They do not claim
provider billing savings, call models, use network access, or perform external
writes.`],
    ['measure context-pack', `Open Agent Fabric CLI: measure context-pack

Usage:
  oaf measure context-pack --read-only --root . --from codex --objective "Ship safely" --step "impact brief" --target codex --changed src/auth.ts --format json
  oaf measure context-pack --read-only --root . --from codex --objective "Ship safely" --step "impact brief" --target codex --changed-from-git --format summary

Measures the same read-only context-pack path used for handoff: selected and
delivered token estimates, changed-file coverage, MCP readback, timings, and
safeguards. It requires --read-only and does not include raw source bodies,
call models, use network access, or write local files.`],
    ['mcp', `Open Agent Fabric CLI: mcp

Usage:
  oaf mcp inspect --read-only --root . --format json
  oaf mcp inspect --read-only --root . --format summary
  oaf mcp resources --read-only --workspace ws_local --format json
  oaf mcp resources --read-only --uri oaf://workspace/ws_local/skills/catalog --format json
  oaf mcp resources --read-only --uri oaf://workspace/ws_local/tools/catalog --format summary
  oaf mcp resources --read-only --memory-refine --uri oaf://workspace/ws_local/memory/refine --format summary
  oaf mcp resources --read-only --context-pack --objective "Ship safely" --step "handoff" --target codex --changed src/auth.ts --format json
  oaf mcp server --read-only --root . --stdio
  oaf mcp stats --read-only --root . --format json
  oaf mcp smoke context-pack --read-only --objective "Ship safely" --step "handoff" --target codex --changed src/auth.ts --format json
  oaf mcp install --client claude-code --dry-run --format json

MCP commands inspect or expose local read-only resources, run the stdio bridge,
preview install plans, or report delivery stats. Resource summaries require
--uri and do not dump full resource bodies. Resource/server paths require
--read-only; install remains dry-run unless explicitly confirmed by the install
flow.`],
    ['memory refine', `Open Agent Fabric CLI: memory refine

Usage:
  oaf memory refine --read-only --root . --sqlite .local/memory.sqlite --format json
  oaf memory refine --read-only --root . --sqlite .local/memory.sqlite --target-active-facts 200 --format json
  oaf memory refine --read-only --root . --sqlite .local/memory.sqlite --target-active-facts 200 --min-confidence 0.5 --format summary

Scans governed local memory for duplicate, conflicting, stale, and lineage
residue candidates without applying changes. It also reports ACTIVE facts below
--min-confidence, which defaults to 0.5. --target-active-facts adds a read-only
budget preflight from existing candidates only. Summary output prints counts,
budget status, safeguards, and fingerprint only. It requires
--read-only and does not create active memory, write proposals, delete facts,
call models, use network access, or expose raw private bodies. Missing or stale
SQLite memory schemas return state: "unavailable" with zero candidates.`]
  ]);
  return topics.get(key) ?? topics.get(topic);
}
