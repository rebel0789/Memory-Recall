import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  COMPILER_VERSION,
  CONTEXT_SELECTION_POLICY,
  contextSelectionPolicyFingerprint,
  estimateTokens,
  hashRef,
  selectContextCandidates,
  stableStringify
} from '../../context-compiler/src/index.mjs';
import { assertJsonSchema } from '../../protocol/src/schema-validator.mjs';
import contextPackRegistryStatusSchema from '../../protocol/schemas/context-pack-registry-status.schema.json' with { type: 'json' };
import contextPackSchema from '../../protocol/schemas/context-pack.schema.json' with { type: 'json' };
import contextPackUsePlanSchema from '../../protocol/schemas/context-pack-use-plan.schema.json' with { type: 'json' };
import harnessContextPreviewSchema from '../../protocol/schemas/harness-context-preview.schema.json' with { type: 'json' };
import harnessContextSourceSchema from '../../protocol/schemas/harness-context-source.schema.json' with { type: 'json' };
import loopObservationSchema from '../../protocol/schemas/loop-observation.schema.json' with { type: 'json' };
import loopPlanSchema from '../../protocol/schemas/loop-plan.schema.json' with { type: 'json' };
import loopRunSchema from '../../protocol/schemas/loop-run.schema.json' with { type: 'json' };
import {
  buildMemoryProposalsReport,
  evaluateMemoryWrite,
  normalizeMemoryPathsConfig
} from '../../memory-core/src/index.mjs';
import {
  DEFAULT_SOURCE_GRAPH_PREVIEW_MAX_FILES,
  DEFAULT_SOURCE_GRAPH_PREVIEW_MAX_FILE_BYTES,
  buildSourceGraphPreview
} from '../../source-graph/src/index.mjs';
import {
  buildOafReadOnlyResourceCatalog,
  createMcpBridge
} from '../../protocol-bridges/src/index.mjs';
import contextPackReceiveReportSchema from '../../protocol/schemas/context-pack-receive-report.schema.json' with { type: 'json' };
import loopVerificationReportSchema from '../../protocol/schemas/loop-verification-report.schema.json' with { type: 'json' };
import { createReplayPlan } from '../../replay/src/index.mjs';

export const CONTEXT_PACK_VERSION = '0.1.0';
export const CONTEXT_PACK_USE_PLAN_VERSION = '0.1.0';
export const CONTEXT_PACK_REGISTRY_VERSION = '0.1.0';
export const HARNESS_CONTEXT_SCANNER_VERSION = '0.1.0';
export const HARNESS_CONTEXT_PREVIEW_VERSION = '0.1.0';
const HARNESS_CONTEXT_SELECTION_POLICY = Object.freeze({
  ...CONTEXT_SELECTION_POLICY,
  policyVersion: '1.0.1',
  thresholds: Object.freeze({
    ...CONTEXT_SELECTION_POLICY.thresholds,
    minimumEvidenceCount: 1
  })
});
export const HARNESS_CONTEXT_BENCHMARK_VERSION = '0.1.0';
export const HARNESS_SETUP_PLANNER_VERSION = '0.1.0';
export const LOOP_PLAN_VERSION = '0.1.0';
export const LOOP_RUN_WORKFLOW_ID = 'workflow:oaf:loop-run';
export const OAF_MCP_RESOURCE_BINARY_ARGS = Object.freeze(['mcp', 'resources', '--read-only', '--stdio']);
export const OAF_MCP_TOKEN_SAVER_BINARY_ARGS = Object.freeze(['mcp', 'server', '--read-only', '--root', '.', '--stdio']);
const OAF_HOOK_CONTEXT_COMMAND = 'oaf hook context --read-only --format text';
const OAF_CHECKOUT_COMMAND_PREFIX = 'npm --silent run oaf --';
const OAF_CHECKOUT_ARG_PREFIX = Object.freeze(['--silent', 'run', 'oaf', '--']);
export const REALISTIC_SAVINGS_OBJECTIVE = 'Prove MCP memory token savings on Memory Recall coding-agent work';
export const REALISTIC_SAVINGS_STEP = 'Compare context.profile delivery with naive candidate file and git history body resend';

const DEFAULT_MAX_BYTES = 65_536;
const DEFAULT_CHANGED_HASH_MAX_BYTES = 262_144;
const DEFAULT_SOURCE_GRAPH_MAX_FILE_BYTES = DEFAULT_SOURCE_GRAPH_PREVIEW_MAX_FILE_BYTES;
const MAX_SOURCE_GRAPH_FILE_BYTES = 1024 * 1024;
const MAX_OVERSIZED_CONTEXT_HASH_BYTES = 8 * 1024 * 1024;
const MEMORY_PATH_MAX_BYTES = 8 * 1024 * 1024;
const MAX_USER_SELECTED_FILES = 16;
const MAX_CHANGED_LOCATORS = 16;
const MARKDOWN_SELECTED_LIMIT = 16;
const MARKDOWN_REQUIRED_READ_LIMIT = 16;
const MARKDOWN_BULK_LIMIT = 2;
const GIT_STATUS_TIMEOUT_MS = 2_000;
const GIT_STATUS_MAX_BUFFER = 256 * 1024;
const CONTEXT_PACK_MARKDOWN_PATH = 'context-packs/CONTEXT_PACK.md';
const CONTEXT_PACK_USE_PLAN_PATH = 'context-packs/CONTEXT_PACK.use.json';
const CONTEXT_PACK_REGISTRY_PATH = 'context-packs/registry.json';
const CONTEXT_PACK_CURRENT_PATH = 'context-packs/current.json';
const SUPPORTED_HARNESSES = new Set(['codex', 'claude-code', 'cursor']);
const SUPPORTED_TARGET_HARNESSES = new Set(['codex', 'claude-code', 'cursor', 'a2a', 'generic']);
const FORBIDDEN_USER_SELECTED_ROOTS = new Set(['.git', '.local', 'node_modules']);
const AUTO_DETECTED_CHANGED_SKIP_ROOTS = new Set([...FORBIDDEN_USER_SELECTED_ROOTS, '.scratch']);
const CONTROL_BYTES = new Set([...Array.from({ length: 9 }, (_, index) => index), 11, 12, ...Array.from({ length: 18 }, (_, index) => index + 14)]);
const SECRET_LIKE = /\b(?:authorization\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|(?:Bearer|Basic|Digest|Token)\s+[^\s"'`,;)]+|[^\s"'`,;)]+)|(?:api[_-]?key|token|secret|password)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"'`,;)]+))/giu;
const LOCAL_FILE_PATH = /\/Users\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._ -]+)+/gu;
const LOCAL_USER_ROOT = /\/Users\/[A-Za-z0-9._-]+(?=$|[\s"'`,;).])/gu;
const HANDOFF_ABSOLUTE_PATH = /(?:\/home\/[A-Za-z0-9._-]+(?:\/[^\s"'`,;).]+)+|\/private\/[^\s"'`,;).]+(?:\/[^\s"'`,;).]+)*|\/var\/folders\/[^\s"'`,;).]+(?:\/[^\s"'`,;).]+)*|[A-Za-z]:\\[^\s"'`,;]+(?:\\[^\s"'`,;]+)+)/gu;
const HANDOFF_PROMPT_CONTROL = /\b(?:ignore|disregard|override|bypass)\s+(?:all\s+)?(?:previous|prior|above|system|developer)\s+instructions\b|\benable\s+external\s+writes\b|\b(?:curl|wget)\s+https?:\/\/|\brm\s+-rf\b|\bsudo\s+/iu;
const UNSAFE_PERSISTED_LOCATOR = /(?:https?:|file:|\/Users(?:\/|$)|\/private(?:\/|$)|\/var\/folders(?:\/|$)|oaf_session|oaf_ses_|sk-proj|OPENAI_API_KEY|authorization|cookie|token\s*[=:]|secret\s*[=:]|api[_-]?key\s*[=:])/iu;
const REDACTED_UNSAFE_SOURCE_LOCATOR = 'workspace://context-packs/redacted-unsafe-source-locator';
const execFileAsync = promisify(execFile);
const AUTO_DETECTED_SECRET_PATH = /(^|\/)(?:\.env(?:[./_-]|$)|secrets?(?:[./_-]|$)|credentials?(?:[./_-]|$)|id_rsa(?:[./_-]|$)|id_ed25519(?:[./_-]|$)|[^/]+\.(?:pem|key|p12|pfx|crt|cert)$)/iu;

const STATIC_PROJECT_SOURCES = Object.freeze({
  codex: [
    { relativePath: 'AGENTS.md', sourceKind: 'instruction', scope: 'repository', trust: 'user-authored' }
  ],
  'claude-code': [
    { relativePath: 'CLAUDE.md', sourceKind: 'instruction', scope: 'repository', trust: 'user-authored' }
  ],
  cursor: [
    { relativePath: '.cursorrules', sourceKind: 'rule', scope: 'repository', trust: 'user-authored' },
    { relativePath: '.cursor/mcp.json', sourceKind: 'mcp-config', scope: 'workspace', trust: 'user-authored' }
  ]
});

const REALISTIC_SAVINGS_CANDIDATE_PATHS = Object.freeze([
  'AGENTS.md',
  'README.md',
  'PRODUCT.md',
  'PROJECT_STATUS.json',
  'docs/superpowers/plans/2026-06-26-mcp-token-saver.md',
  'docs/product/loop-workbench-build-plan.md',
  'docs/architecture/overview.md',
  'apps/cli/oaf.mjs',
  'packages/harness-context/src/index.mjs',
  'packages/context-compiler/src/index.mjs',
  'providers/native/memory-sqlite/src/index.mjs',
  'packages/protocol-bridges/src/index.mjs',
  'services/control-api/src/server.mjs',
  'apps/web/app.js',
  'tests/cli.test.mjs',
  'tests/web-shell.test.mjs'
]);

export const HARNESS_SETUP_CLIENTS = new Map([
  ['codex', { id: 'codex', label: 'Codex', format: 'toml', configPath: '.codex/config.toml' }],
  ['cursor', { id: 'cursor', label: 'Cursor', format: 'json', configPath: '.cursor/mcp.json' }],
  ['claude-code', { id: 'claude-code', label: 'Claude Code', format: 'json', configPath: '.claude/mcp.json' }],
  ['opencode', { id: 'opencode', label: 'OpenCode', format: 'jsonc', configPath: 'opencode.jsonc' }],
  ['openclaw', { id: 'openclaw', label: 'OpenClaw', format: 'jsonc', configPath: '.openclaw/mcp.jsonc' }],
  ['gemini-cli', { id: 'gemini-cli', label: 'Gemini CLI', format: 'json', configPath: '.gemini/settings.json' }],
  ['zed', { id: 'zed', label: 'Zed', format: 'json', configPath: '.config/zed/settings.json' }],
  ['aider', { id: 'aider', label: 'Aider', format: 'yaml', configPath: '.aider.conf.yml' }],
  ['goose', { id: 'goose', label: 'Goose', format: 'yaml', configPath: '.config/goose/config.yaml' }],
  ['vscode', { id: 'vscode', label: 'VS Code', format: 'json', configPath: '.vscode/mcp.json' }],
  ['cline', { id: 'cline', label: 'Cline', format: 'json', configPath: '.cline/mcp.json' }],
  ['roo', { id: 'roo', label: 'Roo', format: 'json', configPath: '.roo/mcp.json' }],
  ['windsurf', { id: 'windsurf', label: 'Windsurf', format: 'json', configPath: '.windsurf/mcp.json' }],
  ['generic-mcp', { id: 'generic-mcp', label: 'Generic MCP', format: 'json', configPath: '.mcp.json' }]
]);

function hash(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function hashJson(value) {
  return hash(stableStringify(value));
}

export function buildContextProfileDeliveryPayloadFromReport({
  report,
  workspaceId = 'ws_local',
  generatedAt = new Date().toISOString(),
  objective,
  step,
  available = true,
  governedFactCount = 0,
  proposalFactCount = 0
} = {}) {
  if (!report?.contextBudget || !report?.manifest || !report?.profile) throw new Error('context profile report is required');
  return {
    schemaVersion: '1.0.0',
    command: 'context.profile',
    workspaceId,
    generatedAt,
    data: {
      available,
      objectiveFingerprint: hashJson(String(objective ?? '')),
      stepFingerprint: hashJson(String(step ?? '')),
      profile: {
        id: report.id,
        layers: report.profile.layers,
        staticRecordCount: report.profile.staticRecordCount,
        dynamicRecordCount: report.profile.dynamicRecordCount,
        acceptedHistoryRecordCount: report.profile.acceptedHistoryRecordCount,
        skippedHistoryRecordCount: report.profile.skippedHistoryRecordCount,
        governedFactCount,
        proposalFactCount,
        contentHash: report.profile.contentHash
      },
      contextBudget: report.contextBudget,
      selectedContext: {
        id: report.manifest.id,
        selectedCount: report.manifest.selected.length,
        excludedCount: report.manifest.excluded.length,
        selectedIds: report.manifest.selected.map((item) => String(item.id ?? '').slice(0, 120)).filter(Boolean),
        budget: report.manifest.budget
      },
      tokenSavingPercent: Math.round(Number(report.contextBudget.reductionRatio ?? 0) * 100)
    },
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

export async function buildRealisticContextProfileSavingsReport({
  root = process.cwd(),
  workspaceId = 'ws_local',
  generatedAt = new Date().toISOString(),
  objective,
  step,
  deliveredPayload,
  maxFiles = 16,
  maxFileBytes = DEFAULT_CHANGED_HASH_MAX_BYTES,
  gitHistoryLimit = 20
} = {}) {
  if (!objective || !step) throw new Error('objective and step are required');
  if (!deliveredPayload || typeof deliveredPayload !== 'object') throw new Error('delivered context.profile payload is required');
  const baseline = await collectRealisticSavingsBaseline({ root, objective, step, maxFiles, maxFileBytes, gitHistoryLimit });
  const afterDeliveryTokens = estimateTokens(JSON.stringify(deliveredPayload));
  const beforeDeliveryTokens = baseline.deliveryTokens;
  const tokensSaved = beforeDeliveryTokens - afterDeliveryTokens;
  const reductionRatio = beforeDeliveryTokens > 0 ? Number((tokensSaved / beforeDeliveryTokens).toFixed(6)) : 0;
  const report = {
    schemaVersion: '1.0.0',
    command: 'measure savings',
    generatedAt,
    workspaceId,
    measurementScope: 'realistic local context.profile delivery-token benchmark',
    objectiveFingerprint: hashJson(String(objective)),
    stepFingerprint: hashJson(String(step)),
    source: {
      provider: 'real-workspace-candidate-bodies',
      rootRef: 'workspace://.',
      candidateFileCount: baseline.candidateFiles.length,
      historyCommitCount: baseline.gitHistory.commitCount,
      candidateBodyTokens: baseline.candidateBodyTokens,
      historyBodyTokens: baseline.historyBodyTokens
    },
    baseline: {
      label: 'naive full candidate file/history body delivery estimate',
      deliveryTokens: beforeDeliveryTokens,
      basis: 'bounded real workspace candidate file bodies plus recent git history bodies'
    },
    compressed: {
      label: 'OAF context.profile MCP payload delivery estimate',
      deliveryTokens: afterDeliveryTokens,
      basis: 'estimated tokens over exact context.profile JSON payload text',
      selectedContextId: deliveredPayload.data?.selectedContext?.id ?? null,
      selectedCount: Number(deliveredPayload.data?.selectedContext?.selectedCount ?? 0),
      excludedCount: Number(deliveredPayload.data?.selectedContext?.excludedCount ?? 0)
    },
    savings: {
      tokensSaved,
      reductionRatio,
      percent: Math.round(reductionRatio * 100),
      basis: 'delivery-token-estimate',
      providerBillingClaimed: false
    },
    realisticBenchmark: {
      candidateFiles: baseline.candidateFiles,
      skippedFiles: baseline.skippedFiles,
      gitHistory: baseline.gitHistory,
      deliveredPayloadFingerprint: hash(JSON.stringify(deliveredPayload)),
      deliveredPayloadTokens: afterDeliveryTokens
    },
    checks: {
      baselineTokensPresent: beforeDeliveryTokens > 0,
      deliveredTokensPresent: afterDeliveryTokens > 0,
      savesTokens: tokensSaved > 0,
      providerBillingNotClaimed: true
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
      rawGitHistoryIncluded: false,
      rawObjectiveIncluded: false,
      rawStepIncluded: false,
      absoluteFilesystemLocationsIncluded: false
    }
  };
  return {
    ...report,
    beforeDeliveryTokens,
    afterDeliveryTokens,
    tokensSaved,
    reductionRatio,
    percent: report.savings.percent,
    reportFingerprint: hashJson(report)
  };
}

async function collectRealisticSavingsBaseline({ root, objective, step, maxFiles, maxFileBytes, gitHistoryLimit }) {
  const realRoot = await realpath(path.resolve(root));
  const candidateFiles = [];
  const skippedFiles = [];
  const bodyParts = [`objective:\n${objective}`, `step:\n${step}`];
  for (const relativePath of REALISTIC_SAVINGS_CANDIDATE_PATHS.slice(0, Math.max(1, maxFiles))) {
    const normalized = safeWorkspaceRelativePath(relativePath, 'realistic savings candidate path');
    const absolute = path.resolve(realRoot, normalized);
    if (!isInside(realRoot, absolute)) {
      skippedFiles.push({ locator: workspaceLocator(normalized), reason: 'escaped_root' });
      continue;
    }
    const info = await stat(absolute).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info?.isFile()) {
      skippedFiles.push({ locator: workspaceLocator(normalized), reason: 'missing' });
      continue;
    }
    if (info.size > maxFileBytes) {
      skippedFiles.push({ locator: workspaceLocator(normalized), reason: 'over_size_limit', byteSize: info.size });
      continue;
    }
    const text = await readFile(absolute, 'utf8');
    const tokenCount = estimateTokens(text);
    bodyParts.push(`file ${workspaceLocator(normalized)}:\n${text}`);
    candidateFiles.push({
      locator: workspaceLocator(normalized),
      byteSize: Buffer.byteLength(text, 'utf8'),
      tokenCount,
      contentHash: hash(text)
    });
  }
  const gitHistory = await collectRealisticSavingsGitHistory(realRoot, gitHistoryLimit);
  if (gitHistory.body) bodyParts.push(`git history:\n${gitHistory.body}`);
  const candidateBodyTokens = candidateFiles.reduce((sum, item) => sum + item.tokenCount, 0);
  const historyBodyTokens = gitHistory.tokenCount;
  return {
    deliveryTokens: estimateTokens(bodyParts.join('\n\n')),
    candidateBodyTokens,
    historyBodyTokens,
    candidateFiles,
    skippedFiles,
    gitHistory: {
      available: gitHistory.available,
      commitCount: gitHistory.commitCount,
      byteSize: gitHistory.byteSize,
      tokenCount: gitHistory.tokenCount,
      contentHash: gitHistory.contentHash,
      reason: gitHistory.reason
    }
  };
}

async function collectRealisticSavingsGitHistory(root, limit) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'log', `--max-count=${Math.max(1, Math.min(50, Number(limit) || 20))}`, '--pretty=format:%H%n%s%n%b%n---OAF-COMMIT---'], {
      encoding: 'utf8',
      timeout: GIT_STATUS_TIMEOUT_MS,
      maxBuffer: GIT_STATUS_MAX_BUFFER,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0'
      }
    });
    const body = String(stdout ?? '').trim();
    return {
      available: true,
      body,
      commitCount: body ? body.split('---OAF-COMMIT---').filter((item) => item.trim()).length : 0,
      byteSize: Buffer.byteLength(body, 'utf8'),
      tokenCount: estimateTokens(body),
      contentHash: body ? hash(body) : null,
      reason: null
    };
  } catch (error) {
    return {
      available: false,
      body: '',
      commitCount: 0,
      byteSize: 0,
      tokenCount: 0,
      contentHash: null,
      reason: safeGitErrorReason(error)
    };
  }
}

function idDigest(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function toPosix(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function workspaceLocator(relativePath) {
  return `workspace://${toPosix(relativePath)}`;
}

function sourceLocator(definition) {
  const scheme = definition.locatorScheme === 'user-selected' ? 'user-selected' : 'workspace';
  return `${scheme}://${toPosix(definition.relativePath)}`;
}

function isEscapedRelative(relativePath) {
  return relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath);
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isControlCharacterBuffer(buffer) {
  return buffer.some((byte) => CONTROL_BYTES.has(byte));
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

function replaceWithCount(text, pattern, replacement) {
  let count = 0;
  const redacted = text.replace(pattern, () => {
    count += 1;
    return replacement;
  });
  return { redacted, count };
}

function redact(text) {
  const secretCount = countMatches(text, SECRET_LIKE);
  const withoutSecrets = text.replace(SECRET_LIKE, '[redacted-secret]');
  const filePaths = replaceWithCount(withoutSecrets, LOCAL_FILE_PATH, '[redacted-local-path]');
  const rootPaths = replaceWithCount(filePaths.redacted, LOCAL_USER_ROOT, '[redacted-local-path]');
  const absolutePaths = replaceWithCount(rootPaths.redacted, HANDOFF_ABSOLUTE_PATH, '[redacted-local-path]');
  const localPathCount = filePaths.count + rootPaths.count + absolutePaths.count;
  const reasonCodes = [];
  if (secretCount > 0) reasonCodes.push('secret_like_value');
  if (localPathCount > 0) reasonCodes.push('local_path');
  return { redacted: absolutePaths.redacted, secretCount, localPathCount, reasonCodes };
}

function assertSafeHandoffField(value, fieldName) {
  const text = String(value ?? '');
  const secretCount = countMatches(text, SECRET_LIKE);
  const localPathCount = countMatches(text, LOCAL_FILE_PATH)
    + countMatches(text, LOCAL_USER_ROOT)
    + countMatches(text, HANDOFF_ABSOLUTE_PATH);
  if (secretCount > 0 || localPathCount > 0 || HANDOFF_PROMPT_CONTROL.test(text)) {
    const error = new Error(`context_pack_${fieldName}_unsafe`);
    error.code = `context_pack_${fieldName}_unsafe`;
    throw error;
  }
}

function summaryFor({ harness, sourceKind, relativePath, redactions }) {
  const counts = `redactions secrets=${redactions.secretCount} local_paths=${redactions.localPathCount}`;
  return `${harness} ${sourceKind} ${relativePath} ${counts}`.slice(0, 240);
}

async function cursorRuleDefinitions(root, rootReal) {
  const rulesRelative = path.join('.cursor', 'rules');
  const rulesRoot = path.join(root, '.cursor', 'rules');
  try {
    await lstat(rulesRoot);
  } catch {
    return { definitions: [], skipped: [] };
  }

  let rulesReal;
  try {
    rulesReal = await realpath(rulesRoot);
  } catch {
    return { definitions: [], skipped: [] };
  }

  if (isEscapedRelative(path.relative(rootReal, rulesReal))) {
    return { definitions: [], skipped: [skippedSource('cursor', toPosix(rulesRelative), 'symlink_escape')] };
  }

  let entries;
  try {
    entries = await readdir(rulesRoot, { withFileTypes: true });
  } catch {
    return { definitions: [], skipped: [] };
  }
  const definitions = entries
    .filter((entry) => entry.name.endsWith('.mdc') && (entry.isFile() || entry.isSymbolicLink()))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => ({
      relativePath: path.join('.cursor', 'rules', entry.name),
      sourceKind: 'rule',
      scope: 'repository',
      trust: 'user-authored'
    }));
  return { definitions, skipped: [] };
}

function nestedInstructionCandidatePaths(changedLocators, fileName) {
  const paths = new Set();
  for (const locator of changedLocators) {
    const relativePath = stripLineRange(String(locator ?? '').replace(/^workspace:\/\//u, ''));
    const parts = relativePath.split('/').filter(Boolean);
    if (parts.length < 2) continue;
    const directoryParts = parts.slice(0, -1);
    for (let depth = 1; depth <= directoryParts.length; depth += 1) {
      const candidate = [...directoryParts.slice(0, depth), fileName].join('/');
      if (candidate !== fileName) paths.add(candidate);
    }
  }
  return [...paths].sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right));
}

async function nestedInstructionDefinitions(root, changedLocators, fileName) {
  const definitions = [];
  for (const relativePath of nestedInstructionCandidatePaths(changedLocators, fileName)) {
    const absolutePath = path.resolve(root, relativePath);
    const declaredRelative = path.relative(root, absolutePath);
    if (isEscapedRelative(declaredRelative)) continue;
    try {
      const info = await lstat(absolutePath);
      if (!info.isFile() && !info.isSymbolicLink()) continue;
    } catch {
      continue;
    }
    definitions.push({
      relativePath,
      sourceKind: 'instruction',
      scope: 'repository',
      trust: 'user-authored'
    });
  }
  return definitions;
}

async function sourceDefinitions(root, rootReal, harness, { changedLocators = [] } = {}) {
  const definitions = [...(STATIC_PROJECT_SOURCES[harness] ?? [])];
  const skipped = [];
  if (harness === 'codex') {
    definitions.push(...await nestedInstructionDefinitions(root, changedLocators, 'AGENTS.md'));
  }
  if (harness === 'claude-code') {
    definitions.push(...await nestedInstructionDefinitions(root, changedLocators, 'CLAUDE.md'));
  }
  if (harness === 'cursor') {
    const cursorRules = await cursorRuleDefinitions(root, rootReal);
    definitions.push(...cursorRules.definitions);
    skipped.push(...cursorRules.skipped);
  }
  return { definitions, skipped };
}

function skippedSource(harness, relativePath, reason, locatorScheme = 'workspace', metadata = {}) {
  const result = {
    harness,
    locator: `${locatorScheme === 'user-selected' ? 'user-selected' : 'workspace'}://${toPosix(relativePath)}`,
    reason
  };
  if (typeof metadata.contentHash === 'string') result.contentHash = metadata.contentHash;
  if (Number.isInteger(metadata.byteSize)) result.byteSize = metadata.byteSize;
  return result;
}

function normalizeUserSelectedFilePath(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.length > 240 || raw.includes('\0') || raw.includes('\\')) {
    throw new Error('user_selected_context_path_invalid');
  }
  const withoutScheme = raw.startsWith('user-selected://') ? raw.slice('user-selected://'.length) : raw;
  const rawParts = withoutScheme.replace(/^\.\//u, '').split('/').filter(Boolean);
  if (rawParts.some((part) => part === '..')) {
    throw new Error('user_selected_context_path_invalid');
  }
  const normalized = path.posix.normalize(withoutScheme.replace(/^\.\//u, ''));
  const parts = normalized.split('/').filter(Boolean);
  if (!parts.length || normalized.startsWith('../') || normalized === '..' || path.posix.isAbsolute(normalized)) {
    throw new Error('user_selected_context_path_invalid');
  }
  if (parts.some((part) => part === '..') || FORBIDDEN_USER_SELECTED_ROOTS.has(parts[0])) {
    throw new Error('user_selected_context_path_forbidden');
  }
  return parts.join('/');
}

function normalizeUserSelectedFiles(values) {
  if (values === null || values === undefined || values === '') return [];
  const list = Array.isArray(values) ? values : String(values).split(',');
  if (list.length > MAX_USER_SELECTED_FILES) throw new Error('user_selected_context_too_many_files');
  return [...new Set(list.map(normalizeUserSelectedFilePath))].sort();
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

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function sourceCheckoutHasOafScript() {
  return existsSync(path.resolve(process.cwd(), 'package.json')) && existsSync(path.resolve(process.cwd(), 'apps/cli/oaf.mjs'));
}

function oafCommand(args) {
  return sourceCheckoutHasOafScript() ? `${OAF_CHECKOUT_COMMAND_PREFIX} ${args}` : `oaf ${args}`;
}

function oafServerCommand(binaryArgs) {
  return sourceCheckoutHasOafScript()
    ? { command: 'npm', args: [...OAF_CHECKOUT_ARG_PREFIX, ...binaryArgs] }
    : { command: 'oaf', args: binaryArgs };
}

function isOafServerInvocation(server, binaryArgs) {
  return Boolean(server) &&
    Array.isArray(server.args) &&
    (
      (server.command === 'oaf' && arraysEqual(server.args, binaryArgs)) ||
      (server.command === 'npm' && arraysEqual(server.args, [...OAF_CHECKOUT_ARG_PREFIX, ...binaryArgs]))
    );
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
    reportFingerprint: hashJson({
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

async function loadWorkspaceJson(root, relativePath) {
  const safePath = safeWorkspaceRelativePath(relativePath, 'memory config');
  const realRoot = await realpath(root);
  const absolute = path.resolve(realRoot, safePath);
  if (!isInside(realRoot, absolute)) throw new Error(`workspace JSON path escapes root: ${safePath}`);
  const actual = await realpath(absolute);
  if (!isInside(realRoot, actual)) throw new Error(`workspace JSON path escapes root: ${safePath}`);
  return JSON.parse(await readFile(actual, 'utf8'));
}

async function readWorkspaceMemoryPath(root, relativePath) {
  const safePath = safeWorkspaceRelativePath(relativePath, 'memoryPath');
  const realRoot = await realpath(root);
  const absolute = path.resolve(realRoot, safePath);
  const actual = await realpath(absolute);
  if (!isInside(realRoot, actual)) throw new Error(`memoryPath escapes workspace root: ${safePath}`);
  const info = await stat(actual);
  if (!info.isFile()) throw new Error(`memoryPath is not a file: ${safePath}`);
  const truncated = info.size > MEMORY_PATH_MAX_BYTES;
  const [inspection, text] = await Promise.all([
    inspectFile(actual),
    truncated ? readFileHeadTail(actual, info.size, MEMORY_PATH_MAX_BYTES) : readFile(actual, 'utf8')
  ]);
  return {
    text,
    locator: `workspace://${safePath}`,
    lineCount: inspection.lineCount,
    byteSize: info.size,
    updatedAt: info.mtime.toISOString(),
    contentHash: inspection.contentHash,
    warnings: truncated ? ['memory_path_truncated_to_8_mib'] : []
  };
}

function deterministicMemoryId(locator, text) {
  return `mem_${createHash('sha256').update(`${locator}\0${text}`).digest('hex').slice(0, 16)}`;
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

async function memoryProposalRecordsFromConfig(config, { root, workspaceId, generatedAt }) {
  const normalized = normalizeMemoryPathsConfig(config);
  const records = [];
  for (const entry of normalized.memoryPaths) {
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
      now: generatedAt
    }));
  }
  return records;
}

export async function buildMemoryProposalPreflightFromConfig({
  root = process.cwd(),
  workspaceId = 'ws_local',
  memoryConfig,
  configRef = 'workspace://oaf.memory.json',
  commandConfigPath = 'oaf.memory.json',
  generatedAt = new Date().toISOString()
} = {}) {
  const config = normalizeMemoryPathsConfig(memoryConfig);
  const records = await memoryProposalRecordsFromConfig(config, { root, workspaceId, generatedAt });
  const report = buildMemoryProposalsReport({
    records,
    workspaceId,
    generatedAt,
    targetDirectory: 'memory/proposals',
    dryRun: true,
    localFilesWritten: 0
  });
  return summarizeMemoryProposalReport(report, {
    configRef,
    command: memoryProposalCommand(commandConfigPath)
  });
}

export async function buildMemoryProposalPreflightFromFile({
  root = process.cwd(),
  workspaceId = 'ws_local',
  configPath = 'oaf.memory.json',
  generatedAt = new Date().toISOString()
} = {}) {
  const relativeConfigPath = safeWorkspaceRelativePath(configPath, 'memory config');
  const config = await loadWorkspaceJson(root, relativeConfigPath);
  return buildMemoryProposalPreflightFromConfig({
    root,
    workspaceId,
    memoryConfig: config,
    configRef: `workspace://${relativeConfigPath}`,
    commandConfigPath: relativeConfigPath,
    generatedAt
  });
}

function normalizeChangedLocator(value) {
  const raw = String(value ?? '').trim();
  const withoutScheme = raw.startsWith('workspace://') ? raw.slice('workspace://'.length) : raw;
  return `workspace://${normalizeUserSelectedFilePath(withoutScheme)}`;
}

function normalizeChangedLocators(values) {
  if (values === null || values === undefined || values === '') return [];
  const list = Array.isArray(values) ? values : String(values).split(',');
  if (list.length > MAX_CHANGED_LOCATORS) throw new Error('changed_context_too_many_locators');
  try {
    return [...new Set(list.map(normalizeChangedLocator))].sort();
  } catch (error) {
    const wrapped = new Error(error.message.startsWith('user_selected_context_path') ? 'changed_context_locator_invalid' : error.message);
    wrapped.cause = error;
    throw wrapped;
  }
}

function changedLocatorUnavailable(reason) {
  return {
    contentHash: null,
    contentByteSize: 0,
    contentTokenCount: 0,
    reasonCodes: ['content_hash_unavailable', reason].filter(Boolean)
  };
}

async function inspectChangedLocator({ root, rootReal, locator, maxBytes }) {
  const relativePath = String(locator ?? '').replace(/^workspace:\/\//u, '');
  const absolutePath = path.resolve(root, relativePath);
  const declaredRelative = path.relative(root, absolutePath);
  if (isEscapedRelative(declaredRelative)) return changedLocatorUnavailable('path_escape');

  try {
    await lstat(absolutePath);
  } catch {
    return changedLocatorUnavailable('missing_changed_locator');
  }

  let realPath;
  try {
    realPath = await realpath(absolutePath);
  } catch {
    return changedLocatorUnavailable('unsupported_file');
  }

  if (isEscapedRelative(path.relative(rootReal, realPath))) {
    return changedLocatorUnavailable('symlink_escape');
  }

  let info;
  try {
    info = await stat(realPath);
  } catch {
    return changedLocatorUnavailable('unsupported_file');
  }
  const hashByteLimit = Math.max(Number(maxBytes ?? 0), DEFAULT_CHANGED_HASH_MAX_BYTES);
  if (!info.isFile()) return changedLocatorUnavailable('unsupported_file');
  if (info.size > hashByteLimit) return changedLocatorUnavailable('oversized');

  const bodyBuffer = await readFile(realPath);
  if (isControlCharacterBuffer(bodyBuffer)) return changedLocatorUnavailable('binary');

  const redactions = redact(bodyBuffer.toString('utf8'));
  if (redactions.secretCount || redactions.localPathCount) {
    return {
      contentHash: null,
      contentByteSize: 0,
      contentTokenCount: 0,
      reasonCodes: [
        'content_hash_withheld_redacted_content',
        'redacted_before_hash',
        ...redactions.reasonCodes
      ].filter(Boolean)
    };
  }
  const measuredText = redactions.redacted;
  return {
    contentHash: hash(measuredText),
    contentByteSize: Buffer.byteLength(measuredText, 'utf8'),
    contentTokenCount: estimateTokens(measuredText),
    reasonCodes: [
      'content_hash_verified',
      redactions.secretCount || redactions.localPathCount ? 'redacted_before_hash' : null,
      ...redactions.reasonCodes
    ].filter(Boolean)
  };
}

async function inspectChangedLocators({ root, changedLocators, maxBytes }) {
  const resolvedRoot = path.resolve(root);
  let rootReal;
  try {
    rootReal = await realpath(resolvedRoot);
  } catch {
    return new Map(changedLocators.map((locator) => [locator, changedLocatorUnavailable('workspace_root_unavailable')]));
  }

  const entries = [];
  for (const locator of changedLocators) {
    const metadata = await inspectChangedLocator({ root: resolvedRoot, rootReal, locator, maxBytes });
    entries.push([locator, metadata]);
  }
  return new Map(entries);
}

function gitChangeDetectionSafeguards() {
  return {
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
    diffBodiesIncluded: false,
    rawBodyIncluded: false,
    absoluteFilesystemLocationsIncluded: false
  };
}

function gitChangeDetectionFingerprint(report) {
  const copy = { ...report };
  delete copy.reportFingerprint;
  return hash(stableStringify(copy));
}

function gitChangeDetectionReport(report) {
  return {
    ...report,
    reportFingerprint: gitChangeDetectionFingerprint(report)
  };
}

function repositoryIdentitySafeguards() {
  return {
    localOnly: true,
    diffBodiesIncluded: false,
    changedPathsIncluded: false,
    absoluteFilesystemLocationsIncluded: false,
    remoteUrlsIncluded: false
  };
}

function safeGitBranchName(value) {
  const text = String(value ?? '').trim();
  if (!text || text === 'HEAD') return null;
  return /^[A-Za-z0-9._/@-]{1,160}$/u.test(text) ? text : null;
}

function repositoryIdentityUnavailable({ generatedAt, reason, commitSha = null, branch = null, dirtyCount = 0, warnings = [] }) {
  return {
    provider: 'git',
    generatedAt,
    branch,
    commitSha,
    dirtyCount,
    gitStatusAvailable: false,
    source: 'unavailable',
    reason,
    warnings: [...new Set(warnings)].sort(),
    safeguards: repositoryIdentitySafeguards()
  };
}

export async function inspectRepositoryIdentity({
  root = process.cwd(),
  clock = () => new Date().toISOString()
} = {}) {
  const generatedAt = clock();
  const resolvedRoot = path.resolve(root);
  let commitSha = null;
  let branch = null;
  const warnings = [];
  try {
    const { stdout } = await execFileAsync('git', ['-C', resolvedRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: GIT_STATUS_TIMEOUT_MS,
      maxBuffer: GIT_STATUS_MAX_BUFFER,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0'
      }
    });
    const value = String(stdout ?? '').trim();
    commitSha = /^[a-f0-9]{40}$/u.test(value) ? value : null;
  } catch (error) {
    return repositoryIdentityUnavailable({ generatedAt, reason: safeGitErrorReason(error) });
  }

  try {
    const { stdout } = await execFileAsync('git', ['-C', resolvedRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      timeout: GIT_STATUS_TIMEOUT_MS,
      maxBuffer: GIT_STATUS_MAX_BUFFER,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0'
      }
    });
    branch = safeGitBranchName(stdout);
    if (!branch) warnings.push('git_branch_unavailable_or_detached');
  } catch {
    warnings.push('git_branch_unavailable');
  }

  try {
    const { stdout } = await execFileAsync(
      'git',
      ['--no-optional-locks', '-C', resolvedRoot, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'],
      {
        encoding: 'utf8',
        timeout: GIT_STATUS_TIMEOUT_MS,
        maxBuffer: GIT_STATUS_MAX_BUFFER,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0'
        }
      }
    );
    return {
      provider: 'git',
      generatedAt,
      branch,
      commitSha,
      dirtyCount: parseGitStatusPorcelainZ(stdout).length,
      gitStatusAvailable: true,
      source: 'git-status-porcelain',
      reason: null,
      warnings: [...new Set(warnings)].sort(),
      safeguards: repositoryIdentitySafeguards()
    };
  } catch (error) {
    return repositoryIdentityUnavailable({
      generatedAt,
      reason: safeGitErrorReason(error),
      commitSha,
      branch,
      warnings
    });
  }
}

function gitChangedUnavailableReport({ workspaceId, generatedAt, reason, warnings = [] }) {
  return gitChangeDetectionReport({
    schemaVersion: '1.0.0',
    command: 'git changed locators',
    generatedAt,
    workspaceId,
    status: 'unavailable',
    source: 'unavailable',
    reason,
    changedLocators: [],
    totalChangedLocatorCount: 0,
    omittedChangedLocatorCount: 0,
    skippedCount: 0,
    truncated: false,
    warnings: [...new Set(warnings)].sort(),
    safeguards: gitChangeDetectionSafeguards()
  });
}

function parseGitStatusPorcelainZ(stdout) {
  const entries = String(stdout ?? '').split('\0').filter(Boolean);
  const paths = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const filePath = entry.slice(3);
    if (filePath) paths.push(filePath);
    if (status.includes('R') || status.includes('C')) index += 1;
  }
  return paths;
}

function shouldSkipAutoDetectedChangedPath(relativePath) {
  const normalized = toPosix(relativePath);
  if (/\s/u.test(normalized) || /[\u0000-\u001f\u007f]/u.test(normalized)) return true;
  const parts = normalized.split('/').filter(Boolean);
  if (!parts.length) return true;
  if (AUTO_DETECTED_CHANGED_SKIP_ROOTS.has(parts[0])) return true;
  return AUTO_DETECTED_SECRET_PATH.test(normalized);
}

function safeGitErrorReason(error) {
  if (error?.killed || error?.signal === 'SIGTERM') return 'git_status_timeout';
  if (error?.code === 'ENOENT') return 'git_unavailable';
  if (error?.code === 128) return 'not_git_repository';
  return 'git_status_failed';
}

export async function detectGitChangedLocators({
  root = process.cwd(),
  workspaceId = 'ws_local',
  maxLocators = MAX_CHANGED_LOCATORS,
  offset = 0,
  clock = () => new Date().toISOString()
} = {}) {
  const generatedAt = clock();
  const limit = Math.max(0, Math.min(MAX_CHANGED_LOCATORS, Number.isInteger(maxLocators) ? maxLocators : MAX_CHANGED_LOCATORS));
  const start = Math.max(0, Number.isInteger(offset) ? offset : 0);
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['--no-optional-locks', '-C', path.resolve(root), 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'],
      {
        encoding: 'utf8',
        timeout: GIT_STATUS_TIMEOUT_MS,
        maxBuffer: GIT_STATUS_MAX_BUFFER,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
          GIT_PAGER: 'cat',
          PAGER: 'cat'
        }
      }
    );
    const detected = parseGitStatusPorcelainZ(stdout);
    const accepted = [];
    let skippedCount = 0;
    for (const relativePath of detected) {
      if (shouldSkipAutoDetectedChangedPath(relativePath)) {
        skippedCount += 1;
        continue;
      }
      try {
        accepted.push(normalizeChangedLocator(relativePath));
      } catch {
        skippedCount += 1;
      }
    }
    const changedLocators = [...new Set(accepted)].sort();
    const limited = changedLocators.slice(start, start + limit);
    const omittedChangedLocatorCount = Math.max(0, changedLocators.length - limited.length);
    const warnings = [];
    if (omittedChangedLocatorCount > 0) warnings.push('git_changed_locators_truncated');
    if (skippedCount > 0) warnings.push('git_changed_locators_skipped');
    return gitChangeDetectionReport({
      schemaVersion: '1.0.0',
      command: 'git changed locators',
      generatedAt,
      workspaceId,
      status: 'available',
      source: 'git-status-porcelain',
      reason: null,
      changedLocators: limited,
      totalChangedLocatorCount: changedLocators.length,
      omittedChangedLocatorCount,
      skippedCount,
      truncated: omittedChangedLocatorCount > 0,
      warnings,
      safeguards: gitChangeDetectionSafeguards()
    });
  } catch (error) {
    return gitChangedUnavailableReport({
      workspaceId,
      generatedAt,
      reason: safeGitErrorReason(error),
      warnings: ['git_changed_locators_unavailable']
    });
  }
}

function userSelectedDefinitions(userSelectedFiles) {
  return normalizeUserSelectedFiles(userSelectedFiles).map((relativePath) => ({
    relativePath,
    sourceKind: 'handoff',
    scope: 'workspace',
    trust: 'user-authored',
    locatorScheme: 'user-selected',
    retention: 'session',
    reviewStatus: 'proposed'
  }));
}

async function pathExistsWithExactCase(root, relativePath) {
  let directory = root;
  for (const part of toPosix(relativePath).split('/').filter(Boolean)) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return false;
    }
    if (!entries.some((entry) => entry.name === part)) return false;
    directory = path.join(directory, part);
  }
  return true;
}

async function scanSource({ root, rootReal, harness, definition, workspaceId, maxBytes, createdAt, includeRedactedText = false }) {
  const relativePath = toPosix(definition.relativePath);
  const locator = sourceLocator(definition);
  const absolutePath = path.resolve(root, definition.relativePath);
  const declaredRelative = path.relative(root, absolutePath);
  if (isEscapedRelative(declaredRelative)) return { skipped: skippedSource(harness, relativePath, 'symlink_escape', definition.locatorScheme) };
  if (!await pathExistsWithExactCase(root, relativePath)) return null;

  try {
    await lstat(absolutePath);
  } catch {
    return null;
  }

  let realPath;
  try {
    realPath = await realpath(absolutePath);
  } catch {
    return { skipped: skippedSource(harness, relativePath, 'unsupported_file', definition.locatorScheme) };
  }

  const realRelative = path.relative(rootReal, realPath);
  if (isEscapedRelative(realRelative)) return { skipped: skippedSource(harness, relativePath, 'symlink_escape', definition.locatorScheme) };

  const info = await stat(realPath);
  if (!info.isFile()) return { skipped: skippedSource(harness, relativePath, 'unsupported_file', definition.locatorScheme) };
  if (info.size > maxBytes) {
    if (info.size <= MAX_OVERSIZED_CONTEXT_HASH_BYTES) {
      const bodyBuffer = await readFile(realPath);
      if (!isControlCharacterBuffer(bodyBuffer)) {
        const redactions = redact(bodyBuffer.toString('utf8'));
        const metadata = { byteSize: info.size };
        if (redactions.secretCount === 0 && redactions.localPathCount === 0) metadata.contentHash = hash(redactions.redacted);
        return { skipped: skippedSource(harness, relativePath, 'oversized', definition.locatorScheme, metadata) };
      }
    }
    return { skipped: skippedSource(harness, relativePath, 'oversized', definition.locatorScheme) };
  }

  const bodyBuffer = await readFile(realPath);
  if (isControlCharacterBuffer(bodyBuffer)) return { skipped: skippedSource(harness, relativePath, 'binary', definition.locatorScheme) };

  const body = bodyBuffer.toString('utf8');
  const redactions = redact(body);
  const contentHash = hash(redactions.redacted);
  const bodyHash = contentHash;
  const source = {
    schemaVersion: '1.0.0',
    id: `hctx_${idDigest(`${workspaceId}:${harness}:${relativePath}:${contentHash}`)}`,
    workspaceId,
    harness,
    sourceKind: definition.sourceKind,
    scope: definition.scope,
    trust: definition.trust,
    dataClass: redactions.secretCount > 0 ? 'sensitive' : 'workspace-private',
    provenance: {
      locator,
      contentHash,
      byteSize: info.size
    },
    reviewStatus: definition.reviewStatus ?? 'scan-only',
    retention: definition.retention ?? 'workspace',
    bodyHash,
    summary: summaryFor({ harness, sourceKind: definition.sourceKind, relativePath, redactions }),
    redactions: {
      secretCount: redactions.secretCount,
      localPathCount: redactions.localPathCount,
      reasonCodes: redactions.reasonCodes
    },
    createdAt,
    metadata: {
      scannerVersion: HARNESS_CONTEXT_SCANNER_VERSION
    }
  };

  assertJsonSchema(harnessContextSourceSchema, source, 'harness context source');
  return includeRedactedText ? { source, redactedText: redactions.redacted } : { source };
}

function selectedHarnesses(harnesses) {
  const requested = harnesses.includes('all') ? [...SUPPORTED_HARNESSES] : harnesses;
  for (const harness of requested) {
    if (!SUPPORTED_HARNESSES.has(harness)) {
      const error = new Error(`Unsupported harness: ${harness}`);
      error.code = 'unsupported_harness';
      throw error;
    }
  }
  return [...new Set(requested)];
}

async function scanHarnessContextInternal({
  root = process.cwd(),
  harnesses = ['codex', 'claude-code', 'cursor'],
  userSelectedFiles = [],
  changedLocators = [],
  workspaceId = 'ws_local',
  maxBytes = DEFAULT_MAX_BYTES,
  clock = () => new Date().toISOString()
} = {}, { includeRedactedText = false } = {}) {
  const resolvedRoot = path.resolve(root);
  const rootReal = await realpath(resolvedRoot);
  const createdAt = clock();
  const normalizedChangedLocators = normalizeChangedLocators(changedLocators);
  const accepted = [];
  const skipped = [];

  for (const harness of selectedHarnesses(harnesses)) {
    const harnessSources = await sourceDefinitions(resolvedRoot, rootReal, harness, { changedLocators: normalizedChangedLocators });
    skipped.push(...harnessSources.skipped);
    for (const definition of harnessSources.definitions) {
      const result = await scanSource({ root: resolvedRoot, rootReal, harness, definition, workspaceId, maxBytes, createdAt, includeRedactedText });
      if (result?.source) accepted.push({ source: result.source, redactedText: result.redactedText ?? null });
      if (result?.skipped) skipped.push(result.skipped);
    }
  }
  for (const definition of userSelectedDefinitions(userSelectedFiles)) {
    const result = await scanSource({
      root: resolvedRoot,
      rootReal,
      harness: 'generic-mcp',
      definition,
      workspaceId,
      maxBytes,
      createdAt,
      includeRedactedText
    });
    if (result?.source) accepted.push({ source: result.source, redactedText: result.redactedText ?? null });
    if (result?.skipped) skipped.push(result.skipped);
  }

  accepted.sort((left, right) => `${left.source.harness}:${left.source.provenance.locator}`.localeCompare(`${right.source.harness}:${right.source.provenance.locator}`));
  skipped.sort((left, right) => `${left.harness}:${left.locator}`.localeCompare(`${right.harness}:${right.locator}`));

  const report = {
    schemaVersion: '1.0.0',
    scannerVersion: HARNESS_CONTEXT_SCANNER_VERSION,
    workspaceId,
    rootFingerprint: hash(`workspace:${workspaceId}:harness-context-root`),
    summary: {
      totalAccepted: accepted.length,
      totalSkipped: skipped.length,
      externalAdaptersEnabled: 0,
      externalWritesEnabled: false
    },
    sources: accepted.map((item) => item.source),
    skipped
  };
  if (!includeRedactedText) return report;
  return {
    ...report,
    records: accepted.map((item) => ({
      source: item.source,
      redactedText: item.redactedText ?? ''
    }))
  };
}

export async function scanHarnessContext(options = {}) {
  return scanHarnessContextInternal(options);
}

export async function scanHarnessContextForPreview(options = {}) {
  return scanHarnessContextInternal(options, { includeRedactedText: true });
}

function contextRecordId(source) {
  return `hctxrec_${idDigest(`${source.id}:${source.bodyHash}`)}`;
}

function sourceCategory(sourceKind) {
  if (sourceKind === 'instruction' || sourceKind === 'rule') return 'evidence';
  if (sourceKind === 'mcp-config' || sourceKind === 'profile' || sourceKind === 'handoff') return 'evidence';
  if (sourceKind === 'command' || sourceKind === 'skill') return 'procedures';
  if (sourceKind === 'memory') return 'episodes';
  return 'other';
}

function trustClassFor(source) {
  if (source.trust === 'user-authored') return 'observed';
  if (source.trust === 'tool-generated') return 'untrusted';
  return 'untrusted';
}

export function harnessSourcesToContextRecords(scan) {
  if (!scan || !Array.isArray(scan.records)) {
    throw new TypeError('preview scan records are required');
  }
  return scan.records.map(({ source, redactedText }) => {
    const locator = source.provenance.locator;
    const text = String(redactedText ?? source.summary ?? '').trim() || source.summary;
    return {
      id: contextRecordId(source),
      kind: 'observation',
      category: sourceCategory(source.sourceKind),
      workspaceId: source.workspaceId,
      text,
      scope: 'workspace-private',
      dataClass: source.dataClass,
      trustClass: trustClassFor(source),
      status: 'active',
      source: `harness-context:${locator}`,
      tags: [
        `harness:${source.harness}`,
        `sourceKind:${source.sourceKind}`,
        `locator:${locator}`
      ],
      relations: [`source:${source.id}`, `locator:${locator}`],
      tokens: estimateTokens(text),
      confidence: source.trust === 'user-authored' ? 0.75 : 0.4,
      authority: source.sourceKind === 'mcp-config' ? 0.2 : 0.35,
      updatedAt: source.createdAt,
      contentHash: source.bodyHash,
      metadata: {
        sourceId: source.id,
        harness: source.harness,
        sourceKind: source.sourceKind,
        locator,
        originalScope: source.scope,
        reviewStatus: source.reviewStatus,
        scannerVersion: source.metadata.scannerVersion,
        redactions: source.redactions,
        persisted: false
      }
    };
  });
}

function previewRequestId({ workspaceId, objective, step }) {
  return `ctxreq_hctxprev_${idDigest(stableStringify({ workspaceId, objective, step }))}`;
}

function safeSource(source) {
  return {
    id: source.id,
    harness: source.harness,
    sourceKind: source.sourceKind,
    scope: source.scope,
    trust: source.trust,
    dataClass: source.dataClass,
    locator: source.provenance.locator,
    contentHash: source.provenance.contentHash,
    bodyHash: source.bodyHash,
    byteSize: source.provenance.byteSize,
    reviewStatus: source.reviewStatus,
    retention: source.retention,
    redactions: source.redactions,
    summary: source.summary
  };
}

function safeCandidate(record) {
  return {
    id: record.id,
    sourceId: record.metadata.sourceId,
    locator: record.metadata.locator,
    harness: record.metadata.harness,
    sourceKind: record.metadata.sourceKind,
    kind: record.kind,
    category: record.category,
    tokens: record.tokens,
    dataClass: record.dataClass,
    trustClass: record.trustClass,
    scope: record.scope,
    status: record.status,
    source: record.source,
    contentHash: record.contentHash
  };
}

function safeDecision(decision, byRecordId) {
  const record = byRecordId.get(decision.id);
  return {
    id: decision.id,
    sourceId: record?.metadata?.sourceId ?? null,
    locator: record?.metadata?.locator ?? null,
    harness: record?.metadata?.harness ?? null,
    sourceKind: record?.metadata?.sourceKind ?? null,
    kind: decision.kind,
    category: decision.category ?? record?.category ?? null,
    tokens: decision.tokens,
    score: decision.score,
    order: decision.order ?? null,
    reasonCodes: decision.reasonCodes,
    source: decision.source,
    contentHash: record?.contentHash ?? null
  };
}

function memoryProposalPlan(scan) {
  const items = scan.sources.map((source) => {
    const reasons = [...new Set([
      ...source.redactions.reasonCodes,
      source.dataClass === 'sensitive' ? 'sensitive_data' : null,
      'review_required',
      'proposal_only'
    ].filter(Boolean))].sort();
    return {
      sourceId: source.id,
      locator: source.provenance.locator,
      harness: source.harness,
      sourceKind: source.sourceKind,
      action: source.redactions.reasonCodes.length || source.dataClass === 'sensitive' ? 'would_quarantine' : 'would_propose',
      reasonCodes: reasons
    };
  });
  return {
    activeMemoryCreated: 0,
    proposedCount: items.filter((item) => item.action === 'would_propose').length,
    quarantinedCount: items.filter((item) => item.action === 'would_quarantine').length,
    items
  };
}

function summarizeScan(scan) {
  return {
    rootFingerprint: scan.rootFingerprint,
    summary: scan.summary,
    sources: scan.sources.map(safeSource),
    skipped: scan.skipped
  };
}

function fingerprintPreview(preview) {
  const copy = JSON.parse(JSON.stringify(preview));
  delete copy.previewFingerprint;
  return hashRef(stableStringify(copy));
}

export async function buildHarnessContextPreview({
  root = process.cwd(),
  harnesses = ['codex', 'claude-code', 'cursor'],
  userSelectedFiles = [],
  changedLocators = [],
  workspaceId = 'ws_local',
  objective,
  step,
  tokenBudget = 4096,
  requiredLocators = [],
  maxBytes = DEFAULT_MAX_BYTES,
  clock = () => new Date().toISOString()
} = {}) {
  if (typeof objective !== 'string' || !objective.trim()) throw new TypeError('objective is required');
  if (typeof step !== 'string' || !step.trim()) throw new TypeError('step is required');
  if (!Number.isInteger(tokenBudget) || tokenBudget < 1) throw new TypeError('tokenBudget must be positive');
  const createdAt = clock();
  const scan = await scanHarnessContextForPreview({
    root,
    harnesses,
    userSelectedFiles,
    changedLocators,
    workspaceId,
    maxBytes,
    clock: () => createdAt
  });
  const records = harnessSourcesToContextRecords(scan);
  const byRecordId = new Map(records.map((record) => [record.id, record]));
  const requiredIds = requiredIdsForLocators(records, requiredLocators, tokenBudget);
  const request = {
    schemaVersion: '1.0.0',
    id: previewRequestId({ workspaceId, objective, step }),
    requestId: previewRequestId({ workspaceId, objective, step }),
    workspaceId,
    objective,
    step,
    requiredIds,
    requiredEntities: [],
    allowedScopes: ['workspace-private'],
    allowedDataClasses: ['public', 'workspace-private'],
    allowedTrustClasses: ['verified', 'trusted', 'observed', 'untrusted'],
    tokenBudget,
    now: createdAt,
    trustedTimestamp: createdAt
  };
  const manifest = selectContextCandidates(request, records, { policy: HARNESS_CONTEXT_SELECTION_POLICY }).manifest;
  const selected = manifest.selected.map((item) => safeDecision(item, byRecordId));
  const excluded = manifest.excluded.map((item) => safeDecision(item, byRecordId));
  const candidateTokenCount = records.reduce((sum, record) => sum + record.tokens, 0);
  const selectedTokenCount = selected.reduce((sum, item) => sum + item.tokens, 0);
  const preview = {
    schemaVersion: '1.0.0',
    previewVersion: HARNESS_CONTEXT_PREVIEW_VERSION,
    id: `hctxprev_${idDigest(stableStringify({
      workspaceId,
      objective,
      step,
      createdAt,
      sourceHashes: scan.sources.map((source) => source.bodyHash)
    }))}`,
    workspaceId,
    createdAt,
    dryRun: true,
    scannerVersion: HARNESS_CONTEXT_SCANNER_VERSION,
    scan: summarizeScan(scan),
    candidates: {
      totalCount: records.length,
      tokenTotal: candidateTokenCount,
      records: records.map(safeCandidate)
    },
    manifest: {
      compilerVersion: COMPILER_VERSION,
      requestId: request.requestId,
      selectionPolicyFingerprint: manifest.selection?.selectionPolicyFingerprint ?? contextSelectionPolicyFingerprint(),
      resultFingerprint: manifest.selection?.resultFingerprint ?? hashRef(stableStringify({ selected, excluded })),
      budget: manifest.budget,
      selected,
      excluded,
      conflicts: manifest.conflicts,
      warnings: manifest.warnings,
      coverage: {
        requested: manifest.selection?.coverage?.requested ?? [],
        selected: manifest.selection?.coverage?.selected ?? [],
        unresolved: manifest.selection?.coverage?.unresolved ?? []
      }
    },
    memoryPlan: memoryProposalPlan(scan),
    metrics: {
      candidateTokenCount,
      selectedTokenCount,
      selectedTokenRatio: candidateTokenCount ? Number((selectedTokenCount / candidateTokenCount).toFixed(6)) : 0
    },
    safeguards: {
      persisted: false,
      modelCalls: 0,
      networkCalls: 0,
      sourceSnapshotsWritten: 0,
      activeMemoryCreated: 0,
      externalWritesEnabled: false,
      externalAdaptersEnabled: 0,
      rawBodyIncluded: false
    }
  };
  preview.previewFingerprint = fingerprintPreview(preview);
  assertJsonSchema(harnessContextPreviewSchema, preview, 'harness context preview');
  return preview;
}

function requiredIdsForLocators(records, locators, tokenBudget) {
  if (!Array.isArray(locators) || !locators.length) return [];
  const byLocator = new Map(records.map((record) => [record.metadata?.locator, record]));
  const ids = [];
  let used = 0;
  for (const locator of locators) {
    const record = byLocator.get(locator);
    if (!record || ids.includes(record.id)) continue;
    if (used + record.tokens > tokenBudget) continue;
    ids.push(record.id);
    used += record.tokens;
  }
  return ids;
}

function normalizeTargetHarness(targetHarness) {
  const normalized = targetHarness === 'claude' ? 'claude-code' : targetHarness;
  if (!SUPPORTED_TARGET_HARNESSES.has(normalized)) {
    const error = new Error(`Unsupported target harness: ${targetHarness}`);
    error.code = 'unsupported_target_harness';
    throw error;
  }
  return normalized;
}

function markdownEscape(value) {
  return String(value ?? '').replaceAll('|', '\\|').replace(/\s+/gu, ' ').trim();
}

function bulletList(items) {
  return items.length ? items.map((item) => `- ${item}`).join('\n') : '- none';
}

function instructionReadContext(locator, targetHarness) {
  if (typeof locator !== 'string' || !locator.startsWith('workspace://')) {
    return null;
  }
  const workspacePath = locator.slice('workspace://'.length);
  if (workspacePath === 'AGENTS.md' || workspacePath === 'CLAUDE.md') {
    return {
      reasonCodes: ['root_instruction'],
      readHint: `Read ${locator} as root workspace instructions before acting in ${targetHarness}.`
    };
  }
  const instructionFile = workspacePath.endsWith('/AGENTS.md')
    ? 'AGENTS.md'
    : workspacePath.endsWith('/CLAUDE.md')
      ? 'CLAUDE.md'
      : null;
  if (!instructionFile) return null;
  const rootLocator = `workspace://${instructionFile}`;
  return {
    reasonCodes: ['scoped_instruction', 'read_after_root_instruction'],
    readHint: `Read ${rootLocator} first, then read ${locator} as directory-scoped instructions before acting in ${targetHarness}.`
  };
}

function decisionForPack(item, targetHarness) {
  const instructionContext = instructionReadContext(item.locator, targetHarness);
  const reasonCodes = Array.isArray(item.reasonCodes) ? item.reasonCodes : [];
  return {
    id: item.id,
    locator: item.locator,
    harness: item.harness,
    sourceKind: item.sourceKind,
    tokens: item.tokens,
    score: item.score,
    reasonCodes: instructionContext ? [...new Set([...reasonCodes, ...instructionContext.reasonCodes])] : reasonCodes,
    contentHash: item.contentHash,
    readHint: instructionContext?.readHint ?? (item.locator
      ? `Read ${item.locator} from the local workspace before acting in ${targetHarness}.`
      : `Use ${item.id} only as sanitized context metadata.`)
  };
}

function omissionRefForPack(item, targetHarness) {
  return {
    id: `omit_${idDigest(stableStringify({
      locator: item.locator,
      contentHash: item.contentHash,
      reasonCodes: item.reasonCodes
    }))}`,
    locator: item.locator,
    harness: item.harness,
    sourceKind: item.sourceKind,
    tokens: item.tokens,
    contentHash: item.contentHash,
    reasonCodes: item.reasonCodes,
    recoveryHint: item.locator
      ? `If this omission matters, read ${item.locator} from the local workspace before acting in ${targetHarness}.`
      : `If this omission matters, re-run the context preview with a larger token budget.`
  };
}

function buildOmissions({ excluded, sourceGraph, targetHarness }) {
  const refs = excluded.map((item) => omissionRefForPack(item, targetHarness));
  return {
    excludedCount: refs.length,
    excludedTokenCount: refs.reduce((sum, item) => sum + item.tokens, 0),
    sourceGraphOmittedCount: sourceGraph.omittedCount,
    refs
  };
}

function requestedInputsForPack({ sourceHarnesses, userSelectedFiles, changedLocators }) {
  const userSelectedLocators = normalizeUserSelectedFiles(userSelectedFiles).map((relativePath) => `user-selected://${relativePath}`);
  return {
    sourceHarnesses,
    userSelectedLocators,
    changedLocators,
    userSelectedCount: userSelectedLocators.length,
    changedLocatorCount: changedLocators.length
  };
}

function coverageRatio(total, covered) {
  if (!total) return { total: 0, covered: 0, ratio: 0, status: 'not_applicable' };
  const boundedCovered = Math.max(0, Math.min(total, covered));
  return {
    total,
    covered: boundedCovered,
    ratio: Number((boundedCovered / total).toFixed(6)),
    status: boundedCovered === total ? 'covered' : 'partial'
  };
}

function boundedSourceGraphMaxFileBytes(value) {
  const requested = Number.isInteger(value) ? value : DEFAULT_SOURCE_GRAPH_MAX_FILE_BYTES;
  return Math.max(1024, Math.min(MAX_SOURCE_GRAPH_FILE_BYTES, requested));
}

function stripLineRange(locator) {
  return String(locator ?? '').replace(/#L[0-9]+-L[0-9]+$/u, '');
}

function requiredReadItem({ locator, role, required, represented = true, contentHash = null, reasonCodes = [], readHint }) {
  return {
    locator,
    role,
    required,
    represented,
    contentHash,
    reasonCodes: [...new Set(reasonCodes.filter(Boolean))].sort(),
    readHint
  };
}

function buildContextPackUtility({ selected, sourceGraph, preview, requestedInputs, changedLocatorMetadata = new Map() }) {
  const reads = [];
  const seen = new Set();
  const scanSourceByLocator = new Map((preview.scan?.sources ?? []).map((source) => [source.locator, source]));
  const skippedSourceByLocator = new Map((preview.scan?.skipped ?? []).map((source) => [source.locator, source]));
  const representedChangedLocators = new Set(sourceGraph.impact.representedChangedLocators ?? []);
  const addRead = (item) => {
    const key = `${item.role}:${item.locator}`;
    if (seen.has(key)) return;
    seen.add(key);
    reads.push(item);
  };

  for (const item of selected) {
    if (!item.locator) continue;
    addRead(requiredReadItem({
      locator: item.locator,
      role: 'selected_context',
      required: true,
      contentHash: item.contentHash,
      reasonCodes: [...item.reasonCodes, 'selected_context'],
      readHint: item.readHint
    }));
  }

  for (const locator of requestedInputs.userSelectedLocators) {
    if (reads.some((item) => item.locator === locator)) continue;
    const source = scanSourceByLocator.get(locator);
    const skipped = skippedSourceByLocator.get(locator);
    addRead(requiredReadItem({
      locator,
      role: 'explicit_user_selected',
      required: true,
      represented: Boolean(source),
      contentHash: source?.contentHash ?? skipped?.contentHash ?? null,
      reasonCodes: [
        'explicit_user_file',
        'read_before_handoff',
        source?.contentHash || skipped?.contentHash ? 'content_hash_verified' : 'content_hash_unavailable',
        skipped?.reason
      ],
      readHint: `Read ${locator} from the local workspace because it was explicitly included for this handoff.`
    }));
  }

  for (const locator of sourceGraph.impact.changedLocators) {
    const selectedMatch = selected.find((item) => stripLineRange(item.locator) === locator);
    const metadata = changedLocatorMetadata.get(locator) ?? changedLocatorUnavailable('content_hash_unavailable');
    const metadataWithheld = metadata.reasonCodes.includes('content_hash_withheld_redacted_content')
      || metadata.reasonCodes.includes('redacted_before_hash');
    const contentHash = metadataWithheld ? null : selectedMatch?.contentHash ?? metadata.contentHash ?? null;
    const hashReasonCodes = metadataWithheld
      ? metadata.reasonCodes
      : contentHash && selectedMatch?.contentHash
      ? ['content_hash_verified']
      : metadata.reasonCodes;
    const represented = representedChangedLocators.has(locator);
    addRead(requiredReadItem({
      locator,
      role: 'changed_locator',
      required: true,
      represented,
      contentHash,
      reasonCodes: [
        'changed_locator_supplied',
        'read_before_edit',
        represented ? 'source_graph_changed_locator_matched' : 'source_graph_changed_locator_unmatched',
        ...hashReasonCodes
      ],
      readHint: `Read ${locator} from the local workspace before editing or reviewing this changed file.`
    }));
  }

  for (const item of sourceGraph.results) {
    addRead(requiredReadItem({
      locator: item.locator,
      role: 'source_graph_hint',
      required: false,
      represented: true,
      contentHash: null,
      reasonCodes: [...item.reasonCodes, 'source_graph_hint'],
      readHint: item.readHint
    }));
  }

  const changedLocators = sourceGraph.impact.changedLocators;
  const changedCovered = changedLocators.filter((locator) => representedChangedLocators.has(stripLineRange(locator))).length;
  const graphHintIncluded = sourceGraph.results.length;
  const graphHintTotal = graphHintIncluded + Number(sourceGraph.omittedCount ?? 0);
  const candidateTokenCount = Number(preview.metrics.candidateTokenCount ?? 0);
  const selectedTokenCount = Number(preview.metrics.selectedTokenCount ?? 0);
  const selectedTokenRatio = candidateTokenCount ? Number((selectedTokenCount / candidateTokenCount).toFixed(6)) : 0;
  const changedCoverage = coverageRatio(changedLocators.length, changedCovered);
  const changedMetadata = changedLocators.map((locator) => changedLocatorMetadata.get(locator) ?? changedLocatorUnavailable('content_hash_unavailable'));
  const measuredChangedMetadata = changedMetadata.filter((metadata) => typeof metadata.contentHash === 'string' && metadata.contentHash.startsWith('sha256:'));
  const changedContentByteCount = measuredChangedMetadata.reduce((sum, metadata) => sum + Number(metadata.contentByteSize ?? 0), 0);
  const changedContentTokenCount = measuredChangedMetadata.reduce((sum, metadata) => sum + Number(metadata.contentTokenCount ?? 0), 0);
  const requiredHashesMissing = reads.some((item) => item.required && item.contentHash === null);
  return {
    status: changedCoverage.status === 'partial' || reads.filter((item) => item.required).length === 0 || requiredHashesMissing ? 'review' : 'ready',
    requiredLocalReads: reads.slice(0, 64),
    changedLocatorCoverage: changedCoverage,
    graphHintCoverage: coverageRatio(graphHintTotal, graphHintIncluded),
    sourceSelection: {
      candidateTokenCount,
      selectedTokenCount,
      selectedTokenRatio,
      estimatedReductionRatio: candidateTokenCount ? Number(Math.max(0, 1 - selectedTokenCount / candidateTokenCount).toFixed(6)) : 0
    },
    changedSourceBudget: {
      locatorCount: changedLocators.length,
      measuredLocatorCount: measuredChangedMetadata.length,
      contentByteCount: changedContentByteCount,
      contentTokenCount: changedContentTokenCount,
      contentTokenCountIncluded: 0,
      observedAvoidanceRatio: changedContentTokenCount ? 1 : 0,
      sourceContentIncluded: false
    },
    delivery: {
      representation: 'locator-handoff',
      sourceContentsIncluded: false
    }
  };
}

function quoteShell(value) {
  return `'${String(value ?? '').replaceAll("'", `'"'"'`)}'`;
}

function contextPackSetupClient(targetHarness) {
  return targetHarness === 'cursor' || targetHarness === 'claude-code' || targetHarness === 'codex' ? targetHarness : 'codex';
}

function contextPackCommands({ sourceHarnesses, targetHarness, objective, step, requestedInputs, sourceGraph }) {
  const from = quoteShell(sourceHarnesses.join(','));
  const objectiveArg = quoteShell(objective);
  const stepArg = quoteShell(step);
  const selectedFiles = requestedInputs.userSelectedLocators
    .map((locator) => ` --include-file ${quoteShell(locator.replace(/^user-selected:\/\//u, ''))}`)
    .join('');
  const changed = sourceGraph.impact.changedLocators
    .map((locator) => ` --changed ${quoteShell(locator.replace(/^workspace:\/\//u, ''))}`)
    .join('');
  const base = `--from ${from} --root . --objective ${objectiveArg} --step ${stepArg} --target ${targetHarness}${selectedFiles}${changed}`;
  const setupClient = contextPackSetupClient(targetHarness);
  return [
    'npm run doctor',
    `npm run oaf -- context pack ${base} --dry-run --format markdown`,
    `npm run oaf -- context pack ${base} --write --pin --out context-packs/CONTEXT_PACK.md --format json`,
    'npm run oaf -- context registry status --read-only --format json',
    `npm run oaf -- context receive --read-only --root . --target ${targetHarness} --format json`,
    `npm run oaf -- context receive --read-only --root . --target ${targetHarness} --format summary`,
    oafCommand('mcp resources --read-only --stdio'),
    'npm run oaf -- mcp resources --read-only --uri oaf://workspace/ws_local/context-pack/registry/current --format json',
    'npm run oaf -- mcp resources --read-only --uri oaf://workspace/ws_local/context-pack/use-plan/current --format json',
    `npm run oaf -- harness setup plan --client ${setupClient} --server oaf --dry-run --format json`,
    'npm run oaf -- mcp resources --read-only --context-pack-use context-packs/CONTEXT_PACK.use.json --uri oaf://workspace/ws_local/context-pack/use-plan/current --format json',
    `npm run oaf -- mcp resources --read-only --context-pack ${base} --uri oaf://workspace/ws_local/context-pack/current --format json`,
    'npm run ci'
  ];
}

function markdownVerificationCommands(commands) {
  const candidates = Array.isArray(commands) ? commands.filter((command) => typeof command === 'string' && command.trim()) : [];
  return [
    candidates.find((command) => command === 'npm run doctor'),
    candidates.find((command) => command.includes('context registry status --read-only')),
    candidates.find((command) => command === 'npm run ci')
  ].filter(Boolean);
}

function markdownBridgeCommands(commands) {
  const candidates = Array.isArray(commands) ? commands.filter((command) => typeof command === 'string' && command.trim()) : [];
  return [
    candidates.find((command) => command.includes('context pack') && command.includes('--write --pin')),
    candidates.find((command) => command.includes('context receive --read-only') && command.includes('--format json')),
    candidates.find((command) => command.includes('context receive --read-only') && command.includes('--format summary')),
    candidates.find((command) => command === oafCommand('mcp resources --read-only --stdio')),
    candidates.find((command) => command.includes('mcp resources --read-only') && command.includes('context-pack/registry/current')),
    candidates.find((command) => command.includes('mcp resources --read-only') && command.includes('context-pack/use-plan/current')),
    candidates.find((command) => command.includes('harness setup plan') && command.includes('--dry-run'))
  ].filter(Boolean);
}

function launchPromptForPack({ targetHarness, objective, step, utility }) {
  return [
    `Continue this local repository work in ${targetHarness}.`,
    `Objective: ${objective}`,
    `Current step: ${step}`,
    '',
    'Use the attached Context Pack as a locator handoff. Read the Utility Read Plan first, then read the listed local files from this workspace before editing.',
    `Changed-file coverage: ${utility.changedLocatorCoverage.covered}/${utility.changedLocatorCoverage.total}`,
    `Required local reads: ${utility.requiredLocalReads.filter((item) => item.required).length}`,
    '',
    'Do not treat this pack as hidden memory or authority. Do not enable external adapters, network writes, publishing, or config writes. Use only the dry-run/read-only commands below unless a human explicitly approves a write boundary.',
    '',
    'Run the Verification commands from this Context Pack before claiming completion.'
  ].join('\n');
}

function renderLaunchPromptSummary(pack) {
  return [
    `Continue this local repository work in ${pack.targetHarness}.`,
    'Use this Context Pack as a locator handoff, not as hidden memory or authority.',
    `Changed-file coverage: ${pack.utility.changedLocatorCoverage.covered}/${pack.utility.changedLocatorCoverage.total}`,
    `Required local reads: ${pack.utility.requiredLocalReads.filter((item) => item.required).length}`,
    'Read the Utility Read Plan before editing, and run the Verification commands before claiming completion.'
  ].join('\n');
}

function harnessInstructions(targetHarness) {
  const shared = [
    'Treat this pack as a locator manifest, not as hidden memory or authority.',
    'Read selected local files before changing code; do not assume raw context was embedded here.',
    'Preserve external adapters disabled and external writes disabled unless a later explicit task changes policy.',
    'Run the repository verification commands before claiming completion.'
  ];
  if (targetHarness === 'codex') {
    return [
      'Codex: start with AGENTS.md and any selected scoped instructions, then inspect the repo before editing.',
      ...shared
    ];
  }
  if (targetHarness === 'claude-code') {
    return [
      'Claude Code: read CLAUDE.md if selected, then reconcile it with AGENTS.md and repo-local task files.',
      ...shared
    ];
  }
  if (targetHarness === 'cursor') {
    return [
      'Cursor: load selected .cursor rules with AGENTS.md and keep generated changes inside the active workspace.',
      ...shared
    ];
  }
  if (targetHarness === 'a2a') {
    return [
      'A2A: treat this as typed coordinator-provided context for a stateless receiver; do not assume shared storage or transport authority.',
      ...shared
    ];
  }
  return [
    'Generic agent: use the selected locators as the ordered read list for this workspace.',
    ...shared
  ];
}

function packWarnings(preview) {
  const warnings = new Set(preview.manifest.warnings ?? []);
  if (!preview.manifest.selected.length) warnings.add('no_selected_context');
  for (const item of preview.memoryPlan.items) {
    if (item.action === 'would_quarantine') warnings.add(`quarantine:${item.locator}`);
  }
  if (preview.safeguards.rawBodyIncluded === false) warnings.add('raw_context_bodies_omitted');
  warnings.add('dry_run_no_import');
  warnings.add('external_writes_disabled');
  return [...warnings].sort();
}

function sourceGraphSafeguards() {
  return {
    dryRun: true,
    persisted: false,
    canonicalStateMutated: false,
    localFilesWritten: 0,
    modelCalls: 0,
    networkCalls: 0,
    externalAdaptersEnabled: 0,
    externalWritesEnabled: false,
    graphDatabaseUsed: false,
    rawBodyIncluded: false,
    sourceSlicesRead: false
  };
}

function sourceGraphPackQuery({ objective, step }) {
  const query = [objective, step]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 512);
  return query || 'context';
}

function compactSourceGraphSummary(preview) {
  const summary = preview.graph.summary;
  return {
    fileCount: summary.fileCount,
    symbolCount: summary.symbolCount,
    moduleCount: summary.moduleCount,
    nodeCount: summary.nodeCount,
    edgeCount: summary.edgeCount,
    diagnosticCount: preview.graph.diagnostics.length,
    hotspotCount: summary.hotspots.length,
    entryPointCount: summary.entryPoints.length
  };
}

function safeSourceGraphErrorCode(error) {
  const code = String(error?.code ?? error?.message ?? 'source_graph_unavailable')
    .split(':')[0]
    .replace(/[^a-z0-9_]/giu, '_')
    .replace(/_+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .toLowerCase()
    .slice(0, 64);
  return code || 'source_graph_unavailable';
}

function compactSourceGraphResults(results) {
  const seen = new Set();
  const output = [];
  for (const item of results) {
    if (!item.locator) continue;
    const key = `${item.resultType}:${item.kind}:${item.label}:${item.locator}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({
      resultType: item.resultType,
      kind: item.kind,
      label: item.label,
      locator: item.locator,
      score: item.score,
      reasonCodes: item.reasonCodes,
      readHint: `Read ${item.locator} before editing related ${item.kind} ${item.label}.`
    });
    if (output.length >= 12) break;
  }
  return output;
}

function compactSourceGraphImpact(impact, changedLocators) {
  const totalAffected = Number(impact?.affectedSymbols?.length ?? 0);
  const representedChangedLocators = (impact?.representedChangedLocators ?? [])
    .filter((locator) => changedLocators.includes(locator))
    .sort();
  const affectedSymbols = (impact?.affectedSymbols ?? []).slice(0, 12).map((item) => ({
    name: item.name,
    symbolKind: item.symbolKind ?? 'symbol',
    locator: item.locator,
    depth: Number(item.depth ?? 0),
    reasonCodes: Array.isArray(item.reasonCodes) && item.reasonCodes.length ? item.reasonCodes : ['changed_locator_impact'],
    readHint: `Inspect ${item.locator} because it may be affected by ${changedLocators.join(', ')}.`.slice(0, 512)
  }));
  return {
    changedLocators,
    representedChangedLocators,
    affectedSymbolCount: totalAffected,
    omittedAffectedSymbolCount: Math.max(0, totalAffected - affectedSymbols.length),
    affectedSymbols
  };
}

async function buildContextPackSourceGraph({
  root,
  workspaceId,
  objective,
  step,
  changedLocators,
  maxFileBytes = DEFAULT_SOURCE_GRAPH_MAX_FILE_BYTES,
  createdAt
}) {
  const query = sourceGraphPackQuery({ objective, step });
  const normalizedChangedLocators = normalizeChangedLocators(changedLocators);
  const queryFingerprint = hashRef(stableStringify({ query, changedLocators: normalizedChangedLocators, limit: 12, offset: 0 }));
  const graphMaxFileBytes = boundedSourceGraphMaxFileBytes(maxFileBytes);
  try {
    const preview = await buildSourceGraphPreview({
      root,
      workspaceId,
      query,
      changedLocators: normalizedChangedLocators,
      limit: 12,
      sampleLimit: 1,
      maxFiles: DEFAULT_SOURCE_GRAPH_PREVIEW_MAX_FILES,
      maxFileBytes: graphMaxFileBytes,
      clock: () => createdAt
    });
    const results = compactSourceGraphResults(preview.search.results);
    const warnings = [];
    if (preview.graph.diagnostics.length) warnings.push('source_graph_diagnostics_present');
    const representedChangedLocators = new Set(preview.impact?.representedChangedLocators ?? []);
    if (normalizedChangedLocators.some((locator) => !representedChangedLocators.has(locator))) {
      warnings.push('source_graph_changed_locator_unmatched');
    }
    return {
      status: 'available',
      previewVersion: preview.previewVersion,
      generatedAt: preview.generatedAt,
      sourceIndexFingerprint: preview.graph.sourceIndexFingerprint,
      graphFingerprint: preview.graph.graphFingerprint,
      summary: compactSourceGraphSummary(preview),
      queryFingerprint: preview.search.queryFingerprint,
      resultCount: preview.search.total,
      omittedCount: preview.search.omittedCount,
      results,
      impact: compactSourceGraphImpact(preview.impact, normalizedChangedLocators),
      warnings,
      safeguards: preview.safeguards
    };
  } catch (error) {
    return {
      status: 'unavailable',
      previewVersion: null,
      generatedAt: createdAt,
      sourceIndexFingerprint: null,
      graphFingerprint: null,
      summary: null,
      queryFingerprint,
      resultCount: 0,
      omittedCount: 0,
      results: [],
      impact: compactSourceGraphImpact(null, normalizedChangedLocators),
      warnings: [`source_graph_unavailable:${safeSourceGraphErrorCode(error)}`],
      safeguards: sourceGraphSafeguards()
    };
  }
}

function requiredLocatorsForTarget(targetHarness, changedLocators = []) {
  if (targetHarness === 'codex') {
    return [
      'workspace://AGENTS.md',
      ...nestedInstructionCandidatePaths(changedLocators, 'AGENTS.md').map((relativePath) => `workspace://${relativePath}`)
    ];
  }
  if (targetHarness === 'claude-code') {
    return [
      'workspace://AGENTS.md',
      'workspace://CLAUDE.md',
      ...nestedInstructionCandidatePaths(changedLocators, 'CLAUDE.md').map((relativePath) => `workspace://${relativePath}`)
    ];
  }
  if (targetHarness === 'cursor') return ['workspace://AGENTS.md', 'workspace://.cursorrules', 'workspace://.cursor/mcp.json'];
  return ['workspace://AGENTS.md'];
}

function fingerprintContextPack(pack) {
  const copy = JSON.parse(JSON.stringify(pack));
  delete copy.contextPackFingerprint;
  return hashRef(stableStringify(copy));
}

function buildDeliveryBudget(pack, markdown) {
  const sourceCandidateTokenCount = Number(pack.preview?.candidateTokenCount ?? 0);
  const sourceSelectedTokenCount = Number(pack.preview?.selectedTokenCount ?? 0);
  const deliveredTokenCount = estimateTokens(markdown);
  const deliveredByteSize = Buffer.byteLength(markdown, 'utf8');
  return {
    representation: 'locator-handoff',
    sourceCandidateTokenCount,
    sourceSelectedTokenCount,
    sourceSelectedTokenRatio: sourceCandidateTokenCount
      ? Number((sourceSelectedTokenCount / sourceCandidateTokenCount).toFixed(6))
      : 0,
    deliveredTokenCount,
    deliveredByteSize,
    deliveredTokenRatio: sourceCandidateTokenCount
      ? Number((deliveredTokenCount / sourceCandidateTokenCount).toFixed(6))
      : 0,
    observedTokenReductionRatio: sourceCandidateTokenCount
      ? Number(Math.max(0, 1 - deliveredTokenCount / sourceCandidateTokenCount).toFixed(6))
      : 0,
    sourceContentTokenCountIncluded: 0,
    sourceContentsIncluded: false
  };
}

function deliveryStable(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function settleDeliveryBudget(pack) {
  let markdown = renderContextPackMarkdown(pack);
  let delivery = buildDeliveryBudget(pack, markdown);
  for (let index = 0; index < 4; index += 1) {
    pack.delivery = delivery;
    markdown = renderContextPackMarkdown(pack);
    const next = buildDeliveryBudget(pack, markdown);
    if (deliveryStable(delivery, next)) return { delivery: next, markdown };
    delivery = next;
  }
  pack.delivery = delivery;
  markdown = renderContextPackMarkdown(pack);
  return { delivery: buildDeliveryBudget(pack, markdown), markdown };
}

function limitedRows(items, limit) {
  return Array.isArray(items) ? items.slice(0, limit) : [];
}

function omittedCount(items, limit) {
  return Math.max(0, (Array.isArray(items) ? items.length : 0) - limit);
}

function markdownOmittedLine(count, label) {
  return count > 0 ? `\n\n_${count} additional ${label} omitted from the Markdown handoff; use the JSON use plan or registry resource for the complete structured list._` : '';
}

export function renderContextPackMarkdown(pack) {
  const selectedRows = limitedRows(pack.readFirst, MARKDOWN_SELECTED_LIMIT).map((item) => `| ${markdownEscape(item.locator)} | ${markdownEscape(item.harness)} | ${item.tokens} | ${markdownEscape(item.reasonCodes.join(', '))} |`).join('\n');
  const excludedRows = limitedRows(pack.excluded, MARKDOWN_BULK_LIMIT).map((item) => `| ${markdownEscape(item.locator)} | ${markdownEscape(item.harness)} | ${item.tokens} | ${markdownEscape(item.reasonCodes.join(', '))} |`).join('\n');
  const omissionRows = limitedRows(pack.omissions.refs, MARKDOWN_BULK_LIMIT).map((item) => `| ${markdownEscape(item.id)} | ${markdownEscape(item.locator)} | ${item.tokens} | ${markdownEscape(item.reasonCodes.join(', '))} |`).join('\n');
  const requestedRows = [
    ...pack.requestedInputs.userSelectedLocators.map((locator) => `| ${markdownEscape(locator)} | explicit_user_selected |`),
    ...pack.requestedInputs.changedLocators.map((locator) => `| ${markdownEscape(locator)} | changed_locator |`)
  ].join('\n');
  const sourceGraphRows = limitedRows(pack.sourceGraph.results, MARKDOWN_BULK_LIMIT).map((item) => `| ${markdownEscape(item.locator)} | ${markdownEscape(item.kind)} | ${markdownEscape(item.label)} | ${item.score} | ${markdownEscape(item.reasonCodes.join(', '))} |`).join('\n');
  const changedLocatorRows = pack.sourceGraph.impact.changedLocators.map((locator) => `| ${markdownEscape(locator)} | reviewed_changed_locator |`).join('\n');
  const affectedSymbolRows = limitedRows(pack.sourceGraph.impact.affectedSymbols, MARKDOWN_BULK_LIMIT).map((item) => `| ${markdownEscape(item.locator)} | ${markdownEscape(item.symbolKind)} | ${markdownEscape(item.name)} | ${item.depth} | ${markdownEscape(item.reasonCodes.join(', '))} |`).join('\n');
  const requiredLocalReads = (pack.utility.requiredLocalReads ?? []).filter((item) => item.required);
  const optionalLocalReadCount = Math.max(0, (pack.utility.requiredLocalReads ?? []).length - requiredLocalReads.length);
  const requiredReadRows = limitedRows(requiredLocalReads, MARKDOWN_REQUIRED_READ_LIMIT).map((item) => `| ${markdownEscape(item.locator)} | ${markdownEscape(item.role)} | ${item.required ? 'yes' : 'no'} | ${item.represented ? 'yes' : 'no'} | ${markdownEscape(item.contentHash ?? 'unavailable')} | ${markdownEscape(item.reasonCodes.join(', '))} |`).join('\n');
  const verificationCommands = markdownVerificationCommands(pack.handoff.commands);
  const bridgeCommands = markdownBridgeCommands(pack.handoff.commands);
  const selectedOmitted = markdownOmittedLine(omittedCount(pack.readFirst, MARKDOWN_SELECTED_LIMIT), 'read-first locator rows');
  const requiredOmitted = markdownOmittedLine(omittedCount(requiredLocalReads, MARKDOWN_REQUIRED_READ_LIMIT), 'required utility-read rows');
  const excludedOmitted = markdownOmittedLine(omittedCount(pack.excluded, MARKDOWN_BULK_LIMIT), 'excluded-context rows');
  const omissionRefsOmitted = markdownOmittedLine(omittedCount(pack.omissions.refs, MARKDOWN_BULK_LIMIT), 'omission-ref rows');
  const sourceGraphOmitted = markdownOmittedLine(omittedCount(pack.sourceGraph.results, MARKDOWN_BULK_LIMIT), 'source-graph hint rows');
  const affectedSymbolsOmitted = markdownOmittedLine(omittedCount(pack.sourceGraph.impact.affectedSymbols, MARKDOWN_BULK_LIMIT), 'affected-symbol rows');
  const markdownCommandCount = new Set([...verificationCommands, ...bridgeCommands]).size;
  const commandOmitted = markdownOmittedLine(omittedCount(pack.handoff.commands, markdownCommandCount), 'handoff commands');
  const deliveryLines = pack.delivery ? [
    '## Delivery Budget',
    '',
    `Representation: ${pack.delivery.representation}`,
    `Source candidate tokens: ${pack.delivery.sourceCandidateTokenCount}`,
    `Source selected tokens: ${pack.delivery.sourceSelectedTokenCount}`,
    `Delivered handoff tokens: ${pack.delivery.deliveredTokenCount}`,
    `Delivered token ratio: ${pack.delivery.deliveredTokenRatio}`,
    `Observed token reduction: ${pack.delivery.observedTokenReductionRatio}`,
    `Changed source body tokens measured: ${pack.utility.changedSourceBudget?.contentTokenCount ?? 0}`,
    `Changed source body tokens included: ${pack.utility.changedSourceBudget?.contentTokenCountIncluded ?? 0}`,
    `Embedded source-content tokens: ${pack.delivery.sourceContentTokenCountIncluded}`,
    ''
  ] : [];
  return [
    '# Context Pack',
    '',
    `Target harness: ${pack.targetHarness}`,
    `Source families: ${(pack.sourceHarnesses ?? []).join(', ')}`,
    `Workspace: ${pack.workspaceId}`,
    `Objective: ${pack.objective}`,
    `Step: ${pack.step}`,
    `Created: ${pack.createdAt}`,
    '',
    '## Safety',
    '',
    `External writes: ${pack.safeguards.externalWritesEnabled ? 'enabled' : 'disabled'}`,
    `External adapters: ${pack.safeguards.externalAdaptersEnabled}`,
    `Raw context bodies included: ${pack.safeguards.rawBodyIncluded ? 'yes' : 'no'}`,
    `Model calls: ${pack.safeguards.modelCalls}`,
    `Network calls: ${pack.safeguards.networkCalls}`,
    '',
    '## Requested Inputs',
    '',
    `Source families: ${pack.requestedInputs.sourceHarnesses.join(', ')}`,
    `Explicit user-selected files: ${pack.requestedInputs.userSelectedCount}`,
    `Changed locators: ${pack.requestedInputs.changedLocatorCount}`,
    '',
    '| Locator | Role |',
    '| --- | --- |',
    requestedRows || '| none | none |',
    '',
    '## Instructions',
    '',
    bulletList(pack.handoff.instructions),
    '',
    '## Launch Prompt',
    '',
    '```text',
    renderLaunchPromptSummary(pack),
    '```',
    '',
    '## Read First',
    '',
    '| Locator | Harness | Tokens | Reasons |',
    '| --- | --- | ---: | --- |',
    selectedRows || '| none | none | 0 | none |',
    selectedOmitted,
    '',
    '## Utility Read Plan',
    '',
    `Status: ${pack.utility.status}`,
    `Changed locator coverage: ${pack.utility.changedLocatorCoverage.covered}/${pack.utility.changedLocatorCoverage.total} (${Math.round(pack.utility.changedLocatorCoverage.ratio * 100)}%)`,
    `Graph hint coverage: ${pack.utility.graphHintCoverage.covered}/${pack.utility.graphHintCoverage.total} (${Math.round(pack.utility.graphHintCoverage.ratio * 100)}%)`,
    `Source selection ratio: ${Math.round(pack.utility.sourceSelection.selectedTokenRatio * 100)}%`,
    `Optional graph reads summarized elsewhere: ${optionalLocalReadCount}`,
    '',
    '| Locator | Role | Required | Represented | Content Hash | Reasons |',
    '| --- | --- | --- | --- | --- | --- |',
    requiredReadRows || '| none | none | no | no | unavailable | none |',
    requiredOmitted,
    '',
    ...deliveryLines,
    '## Excluded',
    '',
    '| Locator | Harness | Tokens | Reasons |',
    '| --- | --- | ---: | --- |',
    excludedRows || '| none | none | 0 | none |',
    excludedOmitted,
    '',
    '## Omission Refs',
    '',
    `Excluded context refs: ${pack.omissions.excludedCount}`,
    `Excluded tokens: ${pack.omissions.excludedTokenCount}`,
    `Source graph omitted matches: ${pack.omissions.sourceGraphOmittedCount}`,
    '',
    '| Ref | Locator | Tokens | Reasons |',
    '| --- | --- | ---: | --- |',
    omissionRows || '| none | none | 0 | none |',
    omissionRefsOmitted,
    '',
    '## Source Graph Hints',
    '',
    `Status: ${pack.sourceGraph.status}`,
    `Graph database used: ${pack.sourceGraph.safeguards.graphDatabaseUsed ? 'yes' : 'no'}`,
    `Source slices included: ${pack.sourceGraph.safeguards.sourceSlicesRead ? 'yes' : 'no'}`,
    pack.sourceGraph.summary
      ? `Graph summary: ${pack.sourceGraph.summary.fileCount} files, ${pack.sourceGraph.summary.symbolCount} symbols, ${pack.sourceGraph.summary.edgeCount} edges`
      : 'Graph summary: unavailable',
    `Result rows shown: ${Math.min((pack.sourceGraph.results ?? []).length, MARKDOWN_BULK_LIMIT)}/${pack.sourceGraph.results?.length ?? 0}`,
    '',
    '| Locator | Kind | Label | Score | Reasons |',
    '| --- | --- | --- | ---: | --- |',
    sourceGraphRows || '| none | none | none | 0 | none |',
    sourceGraphOmitted,
    '',
    '## Change Impact',
    '',
    `Changed locators: ${pack.sourceGraph.impact.changedLocators.length}`,
    `Affected symbols: ${pack.sourceGraph.impact.affectedSymbolCount}`,
    `Omitted affected symbols: ${pack.sourceGraph.impact.omittedAffectedSymbolCount}`,
    '',
    '| Changed Locator | Source |',
    '| --- | --- |',
    changedLocatorRows || '| none | none |',
    '',
    '| Locator | Symbol Kind | Symbol | Depth | Reasons |',
    '| --- | --- | --- | ---: | --- |',
    affectedSymbolRows || '| none | none | none | 0 | none |',
    affectedSymbolsOmitted,
    '',
    '## Warnings',
    '',
    bulletList(pack.warnings),
    '',
    '## Verification',
    '',
    `Complete command set: ${pack.handoff.commands.length} commands in structured pack data.`,
    bulletList(verificationCommands),
    '',
    '## Bridge Commands',
    '',
    'Use these only after reviewing the pack and deciding to persist a local handoff under context-packs/.',
    bulletList(bridgeCommands),
    commandOmitted,
    '',
    '## Fingerprints',
    '',
    `Preview: ${pack.preview.previewFingerprint}`,
    `Selection: ${pack.preview.resultFingerprint}`,
    ''
  ].join('\n');
}

function assertSafeLoopPlanField(value, fieldName) {
  try {
    assertSafeHandoffField(value, fieldName);
  } catch (error) {
    const wrapped = new Error(`loop_plan_${fieldName}_unsafe`);
    wrapped.code = `loop_plan_${fieldName}_unsafe`;
    wrapped.cause = error;
    throw wrapped;
  }
  if (UNSAFE_PERSISTED_LOCATOR.test(String(value ?? ''))) {
    const error = new Error(`loop_plan_${fieldName}_unsafe`);
    error.code = `loop_plan_${fieldName}_unsafe`;
    throw error;
  }
}

function normalizeLoopPlanTexts(values, fieldName, maxItems = 16) {
  const list = values === null || values === undefined || values === ''
    ? []
    : Array.isArray(values) ? values : [values];
  if (list.length > maxItems) throw new Error(`loop_plan_${fieldName}_too_many`);
  return [...new Set(list.map((value) => {
    const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
    if (!text) return null;
    assertSafeLoopPlanField(text, fieldName);
    return text.slice(0, fieldName === 'validationCommand' ? 400 : 240);
  }).filter(Boolean))].sort();
}

function nullableFingerprint(value) {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value) ? value : null;
}

function normalizeReasonCode(value) {
  const text = String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9_:-]+/gu, '_').replace(/^_+|_+$/gu, '');
  if (!text) return null;
  return (/^[a-z]/u.test(text) ? text : `reason_${text}`).slice(0, 96);
}

function normalizeReasonCodes(values, fallback) {
  const input = Array.isArray(values) && values.length ? values : fallback;
  return [...new Set((input ?? []).map(normalizeReasonCode).filter(Boolean))].sort().slice(0, 16);
}

function loopReadItem({ locator, role, required = true, contentHash = null, reasonCodes = [] }) {
  return {
    locator,
    role,
    required: required === true,
    contentHash: nullableFingerprint(contentHash),
    reasonCodes: normalizeReasonCodes(reasonCodes, [])
  };
}

function addLoopRead(reads, item) {
  if (!item?.locator || !/^(workspace|user-selected):\/\/[^\r\n]{1,320}$/u.test(item.locator)) return;
  if (UNSAFE_PERSISTED_LOCATOR.test(item.locator)) throw new Error('loop_plan_locator_unsafe');
  const key = `${item.role}:${item.locator}`;
  if (!reads.some((existing) => `${existing.role}:${existing.locator}` === key)) reads.push(item);
}

function normalizeLoopBudget(contextBudget = null) {
  if (!contextBudget || contextBudget.basis !== 'context-pack-measurement') {
    return {
      estimatedDeliveryTokens: 0,
      sourceBodyTokensExcluded: 0,
      deliveryReductionRatio: 0,
      basis: 'unestimated'
    };
  }
  return {
    estimatedDeliveryTokens: Math.max(0, Math.trunc(Number(contextBudget.estimatedDeliveryTokens ?? 0))),
    sourceBodyTokensExcluded: Math.max(0, Math.trunc(Number(contextBudget.sourceBodyTokensExcluded ?? 0))),
    deliveryReductionRatio: Math.max(0, Math.min(1, Number(contextBudget.deliveryReductionRatio ?? 0))),
    basis: 'context-pack-measurement'
  };
}

function normalizeSkillTokens(values, fieldName, maxItems = 16) {
  return normalizeLoopPlanTexts(values, fieldName, maxItems);
}

function loopSkillStatusReady(value) {
  return value ? 'ready' : 'blocked_needs_human';
}

export function buildLoopActionEfficiencyGuidance({
  loopPlan = null,
  reusablePrimitives = [],
  proposedBoundary = [],
  validationCommands = loopPlan?.validationCommands ?? [],
  contextBudget = loopPlan?.contextBudget ?? null
} = {}) {
  if (loopPlan) assertJsonSchema(loopPlanSchema, loopPlan, 'loop action efficiency plan');
  const normalizedPrimitives = normalizeSkillTokens(reusablePrimitives, 'reusablePrimitive', 12);
  const normalizedValidation = normalizeLoopPlanTexts(validationCommands, 'validationCommand', 8);
  const normalizedBoundary = normalizeChangedLocators(proposedBoundary.length ? proposedBoundary : loopPlan?.sourceGraph?.changedLocators ?? []);
  const measuredBudget = normalizeLoopBudget(contextBudget);
  const ready = normalizedPrimitives.length > 0 && normalizedValidation.length > 0;
  return {
    schemaVersion: '1.0.0',
    skillId: 'skill:loop-action-efficiency',
    status: loopSkillStatusReady(ready),
    actionLadder: [
      'reuse_existing_primitive',
      'adapt_existing_boundary',
      'make_smallest_coherent_edit',
      'generate_new_code_last'
    ],
    reusedPrimitives: normalizedPrimitives,
    proposedBoundary: normalizedBoundary,
    validationCommands: normalizedValidation,
    measured: {
      contextBudget: measuredBudget,
      diffSize: 'unmeasured'
    },
    writeAuthorityGranted: false,
    reasonCodes: [
      'reuse_before_generate',
      normalizedPrimitives.length ? 'existing_primitive_named' : 'existing_primitive_missing',
      normalizedValidation.length ? 'validation_named' : 'validation_missing',
      measuredBudget.basis === 'context-pack-measurement' ? 'context_budget_measured' : 'context_budget_unestimated',
      'no_write_authority_granted'
    ].sort()
  };
}

export function buildLoopIntentClarification({
  objective = '',
  stopCondition = '',
  nonGoals = [],
  sideEffectClass = 'read-only',
  validationCommands = [],
  rollback = ''
} = {}) {
  const normalizedObjective = String(objective ?? '').replace(/\s+/gu, ' ').trim();
  const normalizedStopCondition = String(stopCondition ?? '').replace(/\s+/gu, ' ').trim();
  const normalizedValidation = normalizeLoopPlanTexts(validationCommands, 'validationCommand', 8);
  const normalizedRollback = String(rollback ?? '').replace(/\s+/gu, ' ').trim();
  if (normalizedObjective) assertSafeLoopPlanField(normalizedObjective, 'objective');
  if (normalizedStopCondition) assertSafeLoopPlanField(normalizedStopCondition, 'stopCondition');
  if (normalizedRollback) assertSafeLoopPlanField(normalizedRollback, 'rollback');
  const reasons = [];
  const questions = [];
  if (!normalizedObjective) {
    reasons.push('missing_objective');
    questions.push('What observable behavior should this loop produce?');
  }
  if (!normalizedStopCondition) {
    reasons.push('missing_stop_condition');
    questions.push('What exact condition stops the loop?');
  }
  if (!normalizedValidation.length) {
    reasons.push('missing_validation');
    questions.push('Which command or check proves the stop condition?');
  }
  if (!normalizedRollback) reasons.push('missing_rollback');
  const safeSideEffectClass = ['read-only', 'local-write', 'external-write'].includes(sideEffectClass) ? sideEffectClass : 'read-only';
  const ready = reasons.length === 0 && safeSideEffectClass !== 'external-write';
  return {
    schemaVersion: '1.0.0',
    skillId: 'skill:loop-intent-clarification',
    status: loopSkillStatusReady(ready),
    planFields: {
      objective: normalizedObjective,
      stopCondition: normalizedStopCondition,
      nonGoals: normalizeLoopPlanTexts(nonGoals, 'nonGoal', 8),
      sideEffectClass: safeSideEffectClass,
      validationCommands: normalizedValidation,
      rollback: normalizedRollback
    },
    openQuestions: questions.slice(0, 3),
    stopReason: ready ? null : 'blocked_needs_human',
    authorityGranted: false,
    reasonCodes: [
      ...reasons,
      safeSideEffectClass === 'external-write' ? 'external_write_requires_human' : 'side_effect_class_bounded',
      'no_authority_granted'
    ].sort()
  };
}

function loopRefId(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return /^[A-Za-z0-9._:-]{1,120}$/u.test(text) ? text : null;
}

function normalizeLoopGovernanceAssertions(values = []) {
  if (values === null || values === undefined) return [];
  if (!Array.isArray(values) || values.length > 16) throw new Error('loop_governance_assertions_invalid');
  return values.map((item) => {
    const subject = String(item?.subject ?? '').trim();
    const predicate = String(item?.predicate ?? '').trim();
    const file = normalizeUserSelectedFilePath(item?.probe?.file);
    const capture = String(item?.probe?.capture ?? '').trim();
    const valueTemplate = String(item?.probe?.valueTemplate ?? '').trim();
    if (!/^[A-Za-z0-9:_-]{1,128}$/u.test(subject)) throw new Error('loop_governance_subject_invalid');
    if (!/^[A-Za-z0-9:_-]{1,128}$/u.test(predicate)) throw new Error('loop_governance_predicate_invalid');
    if (!capture || capture.length > 240 || /[\r\n]/u.test(capture)) throw new Error('loop_governance_capture_invalid');
    if (!valueTemplate || valueTemplate.length > 120 || /[\r\n]/u.test(valueTemplate) || !valueTemplate.includes('$1')) throw new Error('loop_governance_value_template_invalid');
    assertSafeHandoffField(`${subject} ${predicate} ${file} ${capture} ${valueTemplate}`, 'loop_governance_assertion');
    return { subject, predicate, probe: { file, capture, valueTemplate } };
  });
}

export function buildLoopPlan({
  workspaceId = 'ws_local',
  objective,
  stopCondition,
  nonGoals = [],
  validationCommands = [],
  governanceAssertions = [],
  changedLocators = [],
  userSelectedFiles = [],
  contextPack = null,
  usePlan = null,
  sourceGraph = null,
  contextBudget = null,
  riskClass = 'low',
  maxIterations = 3,
  timeoutSeconds = 1800,
  clock = () => new Date().toISOString()
} = {}) {
  const createdAt = clock();
  const normalizedObjective = String(objective ?? '').replace(/\s+/gu, ' ').trim();
  const normalizedStopCondition = String(stopCondition ?? '').replace(/\s+/gu, ' ').trim();
  if (!normalizedObjective) throw new Error('loop_plan_objective_required');
  if (!normalizedStopCondition) throw new Error('loop_plan_stopCondition_required');
  assertSafeLoopPlanField(normalizedObjective, 'objective');
  assertSafeLoopPlanField(normalizedStopCondition, 'stopCondition');
  for (const locator of Array.isArray(changedLocators) ? changedLocators : [changedLocators]) {
    if (UNSAFE_PERSISTED_LOCATOR.test(String(locator ?? ''))) throw new Error('changed_context_locator_invalid');
  }
  const normalizedChangedLocators = normalizeChangedLocators(changedLocators);
  const normalizedUserSelectedFiles = normalizeUserSelectedFiles(userSelectedFiles);
  const normalizedGovernanceAssertions = normalizeLoopGovernanceAssertions(governanceAssertions);
  const reads = [];

  for (const locator of normalizedChangedLocators) {
    addLoopRead(reads, loopReadItem({
      locator,
      role: 'changed_locator',
      required: true,
      reasonCodes: ['changed_locator_supplied', 'read_before_edit']
    }));
  }
  for (const relativePath of normalizedUserSelectedFiles) {
    addLoopRead(reads, loopReadItem({
      locator: `user-selected://${relativePath}`,
      role: 'explicit_user_selected',
      required: true,
      reasonCodes: ['explicit_user_file', 'read_before_handoff']
    }));
  }
  const inheritedReads = (usePlan?.requiredLocalReads?.length ? usePlan.requiredLocalReads : contextPack?.utility?.requiredLocalReads) ?? [];
  for (const item of inheritedReads) {
    addLoopRead(reads, loopReadItem({
      locator: item.locator,
      role: ['selected_context', 'explicit_user_selected', 'changed_locator', 'source_graph_hint'].includes(item.role) ? item.role : 'selected_context',
      required: item.required !== false,
      contentHash: item.contentHash,
      reasonCodes: item.reasonCodes?.length ? item.reasonCodes : ['selected_context']
    }));
  }
  for (const item of sourceGraph?.results ?? []) {
    addLoopRead(reads, loopReadItem({
      locator: item.locator,
      role: 'source_graph_hint',
      required: false,
      contentHash: item.contentHash,
      reasonCodes: item.reasonCodes?.length ? item.reasonCodes : ['source_graph_hint']
    }));
  }

  const plan = {
    schemaVersion: '1.0.0',
    command: 'loop plan',
    id: 'loopplan_000000000000000000000000',
    workspaceId: String(workspaceId ?? 'ws_local').trim(),
    createdAt,
    loopPlanFingerprint: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    objective: normalizedObjective,
    stopCondition: normalizedStopCondition,
    nonGoals: normalizeLoopPlanTexts(nonGoals, 'nonGoal'),
    riskClass: ['low', 'review', 'high'].includes(riskClass) ? riskClass : 'low',
    sideEffectClass: 'read-only',
    maxIterations: Number.isInteger(maxIterations) ? Math.max(1, Math.min(20, maxIterations)) : 3,
    timeoutSeconds: Number.isInteger(timeoutSeconds) ? Math.max(1, Math.min(86400, timeoutSeconds)) : 1800,
    approvalRequired: false,
    sourceGraph: {
      status: sourceGraph?.status === 'available' ? 'available' : 'unavailable',
      sourceIndexFingerprint: nullableFingerprint(sourceGraph?.sourceIndexFingerprint),
      graphFingerprint: nullableFingerprint(sourceGraph?.graphFingerprint),
      changedLocators: normalizedChangedLocators
    },
    contextPack: {
      contextPackId: loopRefId(contextPack?.id),
      contextPackFingerprint: nullableFingerprint(contextPack?.fingerprint ?? contextPack?.contextPackFingerprint),
      usePlanId: loopRefId(usePlan?.id),
      usePlanFingerprint: nullableFingerprint(usePlan?.fingerprint ?? usePlan?.usePlanFingerprint)
    },
    requiredLocalReads: reads.slice(0, 80),
    validationCommands: normalizeLoopPlanTexts(validationCommands, 'validationCommand'),
    contextBudget: normalizeLoopBudget(contextBudget),
    stopReasons: [
      'completed',
      'validation_failed',
      'governance-violation',
      'blocked_needs_human',
      'unsafe_action_required',
      'max_iterations',
      'timeout',
      'unrelated_changes',
      'out_of_scope'
    ],
    rollback: 'Discard this loop plan; Slice 1 is read-only and mutates no workspace state.',
    safeguards: {
      readOnly: true,
      commandsExecuted: 0,
      canonicalStateMutated: false,
      localFilesWritten: 0,
      externalWritesEnabled: false,
      externalAdaptersEnabled: 0,
      networkCalls: 0,
      modelCalls: 0,
      activeMemoryCreated: 0,
      sourceContentIncluded: false,
      rawOutputIncluded: false,
      hiddenReasoningIncluded: false
    }
  };
  if (normalizedGovernanceAssertions.length) plan.governanceAssertions = normalizedGovernanceAssertions;
  plan.id = `loopplan_${idDigest(stableStringify({
    workspaceId: plan.workspaceId,
    objective: plan.objective,
    stopCondition: plan.stopCondition,
    validationCommands: plan.validationCommands,
    governanceAssertions: plan.governanceAssertions ?? [],
    requiredLocalReads: plan.requiredLocalReads,
    contextBudget: plan.contextBudget
  }))}`;
  plan.loopPlanFingerprint = hashJson({ ...plan, loopPlanFingerprint: null });
  assertJsonSchema(loopPlanSchema, plan, 'loop plan');
  return plan;
}

function splitCommand(command) {
  const parts = [];
  const pattern = /"([^"]*)"|'([^']*)'|[^\s]+/gu;
  for (const match of String(command ?? '').matchAll(pattern)) parts.push(match[1] ?? match[2] ?? match[0]);
  if (!parts.length) throw new Error('loop_observation_command_empty');
  return parts;
}

function isAllowlistedValidationCommand(command) {
  const [file, ...args] = splitCommand(command);
  const executable = path.basename(file);
  if (executable === 'node' && args[0] === '--test') return true;
  if (executable === 'npm' && args[0] === 'test') return true;
  if (executable === 'npm' && args[0] === 'run' && typeof args[1] === 'string' && !args[1].startsWith('-')) return true;
  return false;
}

function assertValidationCommandAllowed(command, { executeCommands = false, confirmedCommands = [] } = {}) {
  if (executeCommands !== true) {
    const error = new Error('loop_observation_command_execution_not_enabled');
    error.code = 'loop_observation_command_execution_not_enabled';
    throw error;
  }
  if (isAllowlistedValidationCommand(command) || confirmedCommands.includes(command)) return;
  const error = new Error('loop_observation_command_not_allowed');
  error.code = 'loop_observation_command_not_allowed';
  throw error;
}

async function defaultValidationCommandRunner(command, { cwd = process.cwd(), timeoutMs = 60_000 } = {}) {
  const [file, ...args] = splitCommand(command);
  const started = Date.now();
  try {
    const result = await execFileAsync(file, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 128 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0'
      }
    });
    return {
      exitCode: 0,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      durationMs: Date.now() - started
    };
  } catch (error) {
    return {
      exitCode: Number.isInteger(error.code) ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? error.message ?? '',
      durationMs: Date.now() - started
    };
  }
}

function summarizeCommandOutput({ stdout = '', stderr = '' }) {
  const redactions = redact(`${stdout}\n${stderr}`.trim());
  const redacted = redactions.redacted.replace(/\s+/gu, ' ').trim();
  assertSafeHandoffField(redacted, 'command_output');
  return {
    summary: redacted.slice(0, 320),
    hash: hash(redacted),
    truncated: redacted.length > 320
  };
}

function loopObservationEvent({ observation, sequence, occurredAt }) {
  const payload = {
    observationId: observation.id,
    loopPlanId: observation.loopPlanId,
    loopPlanFingerprint: observation.loopPlanFingerprint,
    status: observation.status,
    commandCount: observation.commands.length,
    commandExitCodes: observation.commands.map((item) => item.exitCode),
    commandOutputHashes: observation.commands.map((item) => item.outputHash),
    observationFingerprint: observation.observationFingerprint
  };
  return {
    schemaVersion: '1.0.0',
    id: `evt_loop_${idDigest(stableStringify({ observationId: observation.id, sequence, payload }))}`,
    workspaceId: observation.workspaceId,
    runId: observation.runId,
    type: 'loop.observation_recorded',
    actorId: 'system',
    sequence,
    occurredAt,
    correlationId: `corr_${observation.id}`,
    causationId: observation.loopPlanId,
    dataClass: 'workspace-private',
    producerVersion: LOOP_PLAN_VERSION,
    payload
  };
}

export async function recordLoopObservation({
  loopPlan,
  runId = 'run_loop_observation',
  validationCommands = null,
  executeCommands = false,
  confirmedCommands = [],
  cwd = process.cwd(),
  commandRunner = defaultValidationCommandRunner,
  appendEvent = async () => {},
  eventSequence = 0,
  clock = () => new Date().toISOString()
} = {}) {
  assertJsonSchema(loopPlanSchema, loopPlan, 'loop observation plan');
  const planCommands = loopPlan.validationCommands ?? [];
  const commands = validationCommands === null || validationCommands === undefined ? planCommands : validationCommands;
  const normalizedCommands = normalizeLoopPlanTexts(commands, 'validationCommand');
  for (const command of normalizedCommands) {
    if (!planCommands.includes(command)) throw new Error('loop_observation_command_not_in_plan');
  }
  if (!normalizedCommands.length) throw new Error('loop_observation_commands_required');
  for (const command of normalizedCommands) assertValidationCommandAllowed(command, { executeCommands, confirmedCommands });

  const createdAt = clock();
  const results = [];
  for (const command of normalizedCommands) {
    const result = await commandRunner(command, {
      cwd,
      timeoutMs: Math.min(Number(loopPlan.timeoutSeconds ?? 1800) * 1000, 600_000)
    });
    const output = summarizeCommandOutput(result);
    const exitCode = Number.isInteger(result.exitCode) ? Math.max(0, Math.min(255, result.exitCode)) : 1;
    results.push({
      command,
      exitCode,
      durationMs: Math.max(0, Math.min(600_000, Math.trunc(Number(result.durationMs ?? 0)))),
      passed: exitCode === 0,
      outputSummary: output.summary,
      outputHash: output.hash,
      outputTruncated: output.truncated
    });
  }

  const observation = {
    schemaVersion: '1.0.0',
    command: 'loop observe',
    id: 'loopobs_000000000000000000000000',
    workspaceId: loopPlan.workspaceId,
    runId,
    createdAt,
    loopPlanId: loopPlan.id,
    loopPlanFingerprint: loopPlan.loopPlanFingerprint,
    status: results.every((item) => item.passed) ? 'passed' : 'failed',
    commands: results,
    events: [],
    safeguards: {
      commandsLimitedToPlan: true,
      rawOutputIncluded: false,
      outputSummaryMaxChars: 320,
      localFilesWrittenOutsideLedger: 0,
      networkCallsDeclared: 0,
      modelCalls: 0,
      externalWritesEnabled: false,
      activeMemoryCreated: 0
    },
    observationFingerprint: 'sha256:0000000000000000000000000000000000000000000000000000000000000000'
  };
  observation.id = `loopobs_${idDigest(stableStringify({
    workspaceId: observation.workspaceId,
    runId,
    loopPlanFingerprint: observation.loopPlanFingerprint,
    commands: observation.commands
  }))}`;
  observation.observationFingerprint = hashJson({ ...observation, observationFingerprint: null });
  const event = loopObservationEvent({ observation, sequence: eventSequence, occurredAt: createdAt });
  observation.events = [{ id: event.id, type: event.type, sequence: event.sequence }];
  await appendEvent(event);
  assertJsonSchema(loopObservationSchema, observation, 'loop observation');
  return observation;
}

async function gitChangedWorkspaceLocators(worktreePath) {
  const gitEnv = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0'
  };
  const options = {
    encoding: 'utf8',
    timeout: GIT_STATUS_TIMEOUT_MS,
    maxBuffer: GIT_STATUS_MAX_BUFFER,
    env: gitEnv
  };
  const [tracked, untracked] = await Promise.all([
    execFileAsync('git', ['-C', worktreePath, 'diff', '--name-only'], options),
    execFileAsync('git', ['-C', worktreePath, 'ls-files', '--others', '--exclude-standard'], options)
  ]);
  const paths = `${tracked.stdout}\n${untracked.stdout}`;
  return [...new Set(paths.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean))]
    .map((relativePath) => {
      if (relativePath.startsWith('"')) return `workspace://out-of-scope/${idDigest(relativePath)}`;
      try {
        return `workspace://${normalizeUserSelectedFilePath(relativePath)}`;
      } catch {
        return `workspace://out-of-scope/${idDigest(relativePath)}`;
      }
    })
    .sort();
}

function verificationEvent({ report, type, sequence, occurredAt, payload = {} }) {
  const safePayload = {
    verificationReportId: report.id,
    loopPlanId: report.loopPlanId,
    loopPlanFingerprint: report.loopPlanFingerprint,
    status: report.status,
    ...payload
  };
  return {
    schemaVersion: '1.0.0',
    id: `evt_loop_${idDigest(stableStringify({ reportId: report.id, type, sequence, safePayload }))}`,
    workspaceId: report.workspaceId,
    runId: report.runId,
    type,
    actorId: 'system',
    sequence,
    occurredAt,
    correlationId: `corr_${report.id}`,
    causationId: report.loopPlanId,
    dataClass: 'workspace-private',
    producerVersion: LOOP_PLAN_VERSION,
    payload: safePayload
  };
}

function replayEvidence({ workspaceId, runId, reason }) {
  const replay = createReplayPlan({
    workspaceId,
    sourceRunId: runId,
    mode: 'shadow',
    reason,
    sideEffects: 'disabled'
  });
  return {
    sideEffects: replay.sideEffects,
    approvalsReusable: replay.approvalsReusable,
    planFingerprint: replay.fingerprint
  };
}

function normalizeLoopGovernanceReport(report = {}) {
  const violations = Array.isArray(report.violations) ? report.violations.slice(0, 16).map((item) => ({
    subject: String(item.subject ?? '').trim(),
    predicate: String(item.predicate ?? '').trim(),
    expected: String(item.expected ?? '').trim().slice(0, 240),
    actual: String(item.actual ?? '').trim().slice(0, 240),
    file: normalizeUserSelectedFilePath(item.file)
  })) : [];
  return {
    checked: Math.max(0, Math.min(16, Math.trunc(Number(report.checked ?? 0)))),
    violations
  };
}

export async function runLoopVerification({
  loopPlan,
  runId = 'run_loop_verification',
  worktreePath,
  implementer = async () => {},
  executeCommands = false,
  confirmedCommands = [],
  commandRunner = defaultValidationCommandRunner,
  governanceChecker = async () => ({ checked: 0, violations: [] }),
  appendEvent = async () => {},
  replayMode = false,
  clock = () => new Date().toISOString()
} = {}) {
  assertJsonSchema(loopPlanSchema, loopPlan, 'loop verification plan');
  if (!worktreePath || typeof worktreePath !== 'string') throw new Error('loop_verification_worktree_required');
  const createdAt = clock();
  const allowedLocators = [...new Set(loopPlan.sourceGraph.changedLocators ?? [])].sort();
  const report = {
    schemaVersion: '1.0.0',
    command: 'loop verify',
    id: 'loopverify_000000000000000000000000',
    workspaceId: loopPlan.workspaceId,
    runId,
    createdAt,
    loopPlanId: loopPlan.id,
    loopPlanFingerprint: loopPlan.loopPlanFingerprint,
    status: 'blocked',
    stopReason: replayMode ? 'blocked_needs_human' : 'completed',
    worktree: {
      mode: 'isolated',
      pathFingerprint: hash(path.resolve(worktreePath))
    },
    implementer: {
      status: replayMode ? 'skipped_replay' : 'completed',
      changedLocators: []
    },
    checker: {
      status: replayMode ? 'skipped_replay' : 'failed',
      observation: null
    },
    governance: {
      checked: 0,
      violations: []
    },
    scope: {
      status: replayMode ? 'skipped_replay' : 'passed',
      allowedLocators,
      changedLocators: [],
      unrelatedLocators: []
    },
    proposal: {
      status: 'blocked',
      autoMerge: false,
      approvalRequired: true,
      approvalsReused: false,
      reasonCodes: []
    },
    replay: replayEvidence({ workspaceId: loopPlan.workspaceId, runId, reason: 'loop verification shadow replay disables side effects' }),
    flightRecorder: {
      eventCount: 0,
      eventTypes: []
    },
    safeguards: {
      isolatedWorktreeOnly: true,
      mainBranchWritten: false,
      autoMerge: false,
      externalWritesEnabled: false,
      networkCalls: 0,
      modelCalls: 0,
      replaySideEffectsDisabled: replayMode === true
    },
    reportFingerprint: 'sha256:0000000000000000000000000000000000000000000000000000000000000000'
  };
  report.id = `loopverify_${idDigest(stableStringify({
    workspaceId: report.workspaceId,
    runId,
    loopPlanFingerprint: report.loopPlanFingerprint,
    worktreePath: report.worktree.pathFingerprint,
    replayMode
  }))}`;

  const events = [];
  let sequence = 0;
  const emit = async (type, payload = {}) => {
    const event = verificationEvent({ report, type, sequence: sequence++, occurredAt: clock(), payload });
    events.push(event);
    await appendEvent(event);
  };

  if (!replayMode) {
    await implementer({ worktreePath, loopPlan });
    const changedLocators = await gitChangedWorkspaceLocators(worktreePath);
    report.implementer.changedLocators = changedLocators;
    await emit('loop.implementer_completed', { changedLocators });
    const observation = await recordLoopObservation({
      loopPlan,
      runId,
      cwd: worktreePath,
      commandRunner,
      executeCommands,
      confirmedCommands,
      appendEvent: async () => {},
      eventSequence: sequence,
      clock
    });
    report.checker.observation = observation;
    report.checker.status = observation.status === 'passed' ? 'passed' : 'failed';
    await emit('loop.checker_completed', { observationId: observation.id, checkerStatus: report.checker.status });
    report.governance = normalizeLoopGovernanceReport(await governanceChecker({ loopPlan, worktreePath, runId }));
    report.scope.changedLocators = changedLocators;
    report.scope.unrelatedLocators = changedLocators.filter((locator) => !allowedLocators.includes(locator));
    report.scope.status = report.scope.unrelatedLocators.length ? 'blocked' : 'passed';
    const checkerPassed = report.checker.status === 'passed';
    const governancePassed = report.governance.violations.length === 0;
    report.status = checkerPassed && report.scope.status === 'passed' && governancePassed ? 'proposed' : 'blocked';
    report.stopReason = !checkerPassed ? 'validation_failed' : !governancePassed ? 'governance-violation' : report.scope.status === 'blocked' ? 'unrelated_changes' : 'completed';
  }

  report.proposal.status = report.status === 'proposed' ? 'proposed' : 'blocked';
  report.proposal.reasonCodes = [
    report.checker.status === 'passed' ? 'checker_passed' : report.checker.status === 'skipped_replay' ? 'checker_skipped_replay' : 'checker_failed',
    report.governance.checked === 0 ? 'governance_not_configured' : report.governance.violations.length ? 'governance_violation' : 'governance_passed',
    report.scope.status === 'passed' ? 'scope_passed' : report.scope.status === 'skipped_replay' ? 'scope_skipped_replay' : 'unrelated_changes',
    'human_approval_required',
    'auto_merge_disabled'
  ];
  report.flightRecorder = {
    eventCount: events.length + 1,
    eventTypes: [...events.map((event) => event.type), 'loop.verification_reported']
  };
  report.reportFingerprint = hashJson({ ...report, reportFingerprint: null });
  await emit('loop.verification_reported', { reportFingerprint: report.reportFingerprint, stopReason: report.stopReason });
  assertJsonSchema(loopVerificationReportSchema, report, 'loop verification report');
  return report;
}

export function createLoopRunWorkflowDefinition({
  approvalRequired = false,
  scheduleDelayMs = 0
} = {}) {
  const handler = (id) => ({ id: `handler:oaf:loop-run:${id}`, version: '1.0.0' });
  const step = (id, riskClass = 'read-only') => ({
    id,
    kind: 'deterministic',
    handler: handler(id),
    timeoutMs: 1000,
    retry: { maxAttempts: 1 },
    approval: { required: false },
    idempotency: { required: false },
    riskClass,
    inputSchema: {},
    outputSchema: {}
  });
  const steps = [
    step('intent'),
    step('context')
  ];
  if (scheduleDelayMs > 0) {
    steps.push({
      id: 'schedule',
      kind: 'timer',
      timer: { delayMs: Math.max(1, Math.min(86_400_000, Math.trunc(scheduleDelayMs))) },
      timeoutMs: 1000,
      retry: { maxAttempts: 1 },
      approval: { required: false },
      idempotency: { required: false },
      riskClass: 'read-only',
      inputSchema: {},
      outputSchema: {}
    });
  }
  if (approvalRequired) {
    steps.push({
      id: 'approval',
      kind: 'approval',
      timeoutMs: 1000,
      retry: { maxAttempts: 1 },
      approval: { required: true, operationFingerprint: 'sha256:loop-run-human-approval', expiresInMs: 3_600_000 },
      idempotency: { required: false },
      riskClass: 'consequential-write',
      inputSchema: {},
      outputSchema: {}
    });
  }
  steps.push(
    step('action', approvalRequired ? 'consequential-write' : 'read-only'),
    step('observation'),
    step('adjustment'),
    step('stop')
  );
  return {
    schemaVersion: '1.0.0',
    id: LOOP_RUN_WORKFLOW_ID,
    version: '1.0.0',
    name: 'Loop Workbench run',
    description: 'Bounded local Loop Workbench run controller.',
    steps
  };
}

function normalizedTerminalStopReasons(reasons) {
  const allowed = new Set([
    'completed',
    'validation_failed',
    'governance-violation',
    'blocked_needs_human',
    'unsafe_action_required',
    'unrelated_changes',
    'out_of_scope'
  ]);
  const selected = Array.isArray(reasons) && reasons.length ? reasons : ['completed', 'validation_failed', 'governance-violation', 'blocked_needs_human', 'unsafe_action_required', 'unrelated_changes', 'out_of_scope'];
  return [...new Set(selected.filter((reason) => allowed.has(reason)))].slice(0, 8);
}

async function advanceDurableLoopWorkflow({
  durableRuntime,
  loopPlan,
  runId,
  workflowTicks,
  workerId,
  humanApprovalRequired,
  scheduleDelayMs
}) {
  if (!durableRuntime) {
    return {
      enabled: false,
      workflowId: null,
      workflowRunId: null,
      status: 'not_configured',
      resumed: false,
      historyEventCount: 0,
      eventTypes: []
    };
  }
  const definition = createLoopRunWorkflowDefinition({ approvalRequired: humanApprovalRequired, scheduleDelayMs });
  await durableRuntime.registerWorkflow(definition);
  const workflowRunId = `${runId}_workflow`;
  await durableRuntime.start({
    workspaceId: loopPlan.workspaceId,
    workflowId: definition.id,
    workflowVersion: definition.version,
    runId: workflowRunId,
    input: {
      loopPlanId: loopPlan.id,
      loopPlanFingerprint: loopPlan.loopPlanFingerprint
    },
    idempotencyKey: `loop-run:${loopPlan.id}:${runId}`
  });
  for (let tick = 0; tick < workflowTicks; tick += 1) {
    const result = await durableRuntime.tick({ workerId });
    if (!result.claimed) break;
  }
  const [run, history] = await Promise.all([
    durableRuntime.get({ workspaceId: loopPlan.workspaceId, runId: workflowRunId }),
    durableRuntime.history({ workspaceId: loopPlan.workspaceId, runId: workflowRunId })
  ]);
  const eventTypes = history.events.map((event) => event.type);
  return {
    enabled: true,
    workflowId: definition.id,
    workflowRunId,
    status: run?.status ?? 'missing',
    resumed: eventTypes.includes('run.resumed'),
    historyEventCount: history.events.length,
    eventTypes
  };
}

export async function runLoop({
  loopPlan,
  runId = 'run_loop',
  worktreePath = process.cwd(),
  maxIterations = loopPlan?.maxIterations,
  timeoutMs = Math.max(0, Number(loopPlan?.timeoutSeconds ?? 0) * 1000),
  terminalStopReasons = null,
  humanApprovalRequired = false,
  schedule = null,
  durableRuntime = null,
  workflowTicks = 0,
  workerId = 'worker_loop',
  verificationRunner = async (input) => runLoopVerification(input),
  executeCommands = false,
  confirmedCommands = [],
  governanceChecker = async () => ({ checked: 0, violations: [] }),
  clock = () => new Date().toISOString()
} = {}) {
  assertJsonSchema(loopPlanSchema, loopPlan, 'loop run plan');
  const createdAt = clock();
  const boundedMaxIterations = Number.isInteger(maxIterations) ? Math.max(1, Math.min(20, maxIterations)) : loopPlan.maxIterations;
  const boundedTimeoutMs = Number.isFinite(timeoutMs) ? Math.max(0, Math.min(86_400_000, Math.trunc(timeoutMs))) : Math.max(0, loopPlan.timeoutSeconds * 1000);
  const terminalReasons = normalizedTerminalStopReasons(terminalStopReasons);
  const scheduleEnabled = Boolean(schedule);
  const scheduleDelayMs = schedule?.delayMs ? Math.max(1, Math.min(86_400_000, Math.trunc(Number(schedule.delayMs)))) : 0;
  const approvalGate = humanApprovalRequired === true || loopPlan.approvalRequired === true;
  const durable = await advanceDurableLoopWorkflow({
    durableRuntime,
    loopPlan,
    runId,
    workflowTicks,
    workerId,
    humanApprovalRequired: approvalGate,
    scheduleDelayMs
  });
  const perIterationTokens = loopPlan.contextBudget.estimatedDeliveryTokens;
  const iterations = [];
  const governance = { checked: 0, violations: [] };
  let status = 'blocked';
  let stopReason = 'max_iterations';
  const deadline = Date.parse(createdAt) + boundedTimeoutMs;

  if (Date.parse(clock()) >= deadline) {
    stopReason = 'timeout';
  } else if (approvalGate) {
    stopReason = 'blocked_needs_human';
  } else {
    for (let index = 1; index <= boundedMaxIterations; index += 1) {
      if (Date.parse(clock()) >= deadline) {
        stopReason = 'timeout';
        break;
      }
      const verification = await verificationRunner({
        loopPlan,
        runId: `${runId}_iter_${index}`,
        worktreePath,
        executeCommands,
        confirmedCommands,
        governanceChecker,
        replayMode: false,
        clock
      });
      governance.checked += Number(verification.governance?.checked ?? 0);
      for (const violation of verification.governance?.violations ?? []) {
        if (governance.violations.length < 16) governance.violations.push(violation);
      }
      const iterationStopReason = verification.stopReason ?? (verification.status === 'proposed' ? 'completed' : 'validation_failed');
      iterations.push({
        index,
        status: verification.status,
        stopReason: iterationStopReason,
        verificationReportId: verification.id ?? null,
        estimatedDeliveryTokens: perIterationTokens
      });
      if (terminalReasons.includes(iterationStopReason)) {
        stopReason = iterationStopReason;
        status = iterationStopReason === 'completed' ? 'completed' : 'blocked';
        break;
      }
      if (index === boundedMaxIterations) stopReason = 'max_iterations';
    }
  }

  if (stopReason === 'completed') status = 'completed';
  const runLogEventTypes = [
    'loop.run_started',
    ...durable.eventTypes,
    ...iterations.map((iteration) => `loop.iteration_${iteration.index}_${iteration.stopReason}`),
    'loop.run_stopped'
  ];
  const report = {
    schemaVersion: '1.0.0',
    command: 'loop run',
    id: 'looprun_000000000000000000000000',
    workspaceId: loopPlan.workspaceId,
    runId,
    createdAt,
    loopPlanId: loopPlan.id,
    loopPlanFingerprint: loopPlan.loopPlanFingerprint,
    status,
    stopReason,
    controller: {
      maxIterations: boundedMaxIterations,
      timeoutMs: boundedTimeoutMs,
      terminalStopReasons: terminalReasons
    },
    durable: {
      enabled: durable.enabled,
      workflowId: durable.workflowId,
      workflowRunId: durable.workflowRunId,
      status: durable.status,
      resumed: durable.resumed,
      historyEventCount: durable.historyEventCount
    },
    iterations,
    governance,
    tokenBudget: {
      perIterationEstimatedDeliveryTokens: perIterationTokens,
      aggregatedEstimatedDeliveryTokens: perIterationTokens * iterations.length,
      sourceBodyTokensExcluded: loopPlan.contextBudget.sourceBodyTokensExcluded,
      basis: loopPlan.contextBudget.basis
    },
    schedule: {
      enabled: scheduleEnabled,
      kind: schedule?.kind ?? 'manual',
      cadence: schedule?.cadence ?? 'none',
      nextRunAt: schedule?.nextRunAt ?? null,
      humanApprovalThresholdTokens: Math.max(0, Math.trunc(Number(schedule?.humanApprovalThresholdTokens ?? 0)))
    },
    runLog: {
      eventCount: runLogEventTypes.length,
      eventTypes: runLogEventTypes
    },
    reasoning: {
      maker: buildLoopActionEfficiencyGuidance({
        loopPlan,
        reusablePrimitives: ['buildLoopPlan', 'runLoopVerification', 'runLoop'],
        proposedBoundary: loopPlan.sourceGraph.changedLocators,
        validationCommands: loopPlan.validationCommands,
        contextBudget: loopPlan.contextBudget
      }),
      checker: buildLoopIntentClarification({
        objective: loopPlan.objective,
        stopCondition: loopPlan.stopCondition,
        nonGoals: loopPlan.nonGoals,
        sideEffectClass: loopPlan.sideEffectClass,
        validationCommands: loopPlan.validationCommands,
        rollback: loopPlan.rollback
      }),
      stopConditions: {
        plannedStopCondition: loopPlan.stopCondition,
        terminalStopReasons: terminalReasons,
        observedStopReason: stopReason
      }
    },
    safeguards: {
      boundedIterations: true,
      timeoutEnforced: true,
      humanApprovalGateEnforced: approvalGate,
      externalWritesEnabled: false,
      networkCalls: 0,
      modelCalls: 0,
      autoMerge: false
    },
    runFingerprint: 'sha256:0000000000000000000000000000000000000000000000000000000000000000'
  };
  report.id = `looprun_${idDigest(stableStringify({
    workspaceId: report.workspaceId,
    runId,
    loopPlanFingerprint: report.loopPlanFingerprint,
    iterations: report.iterations,
    stopReason: report.stopReason
  }))}`;
  report.runFingerprint = hashJson({ ...report, runFingerprint: null });
  assertJsonSchema(loopRunSchema, report, 'loop run');
  return report;
}

export async function buildContextPack({
  root = process.cwd(),
  harnesses = ['codex', 'claude-code', 'cursor'],
  userSelectedFiles = [],
  changedLocators = [],
  workspaceId = 'ws_local',
  targetHarness = 'generic',
  objective,
  step,
  tokenBudget = 4096,
  maxBytes = DEFAULT_MAX_BYTES,
  sourceGraphMaxFileBytes = Math.max(DEFAULT_SOURCE_GRAPH_MAX_FILE_BYTES, Number.isInteger(maxBytes) ? maxBytes : DEFAULT_MAX_BYTES),
  clock = () => new Date().toISOString()
} = {}) {
  const normalizedTarget = normalizeTargetHarness(targetHarness);
  assertSafeHandoffField(objective, 'objective');
  assertSafeHandoffField(step, 'step');
  const sourceHarnesses = selectedHarnesses(harnesses);
  const normalizedUserSelectedFiles = normalizeUserSelectedFiles(userSelectedFiles);
  const normalizedChangedLocators = normalizeChangedLocators(changedLocators);
  const requestedInputs = requestedInputsForPack({
    sourceHarnesses,
    userSelectedFiles: normalizedUserSelectedFiles,
    changedLocators: normalizedChangedLocators
  });
  const preview = await buildHarnessContextPreview({
    root,
    harnesses: sourceHarnesses,
    userSelectedFiles: normalizedUserSelectedFiles,
    workspaceId,
    objective,
    step,
    tokenBudget,
    changedLocators: normalizedChangedLocators,
    requiredLocators: requiredLocatorsForTarget(normalizedTarget, normalizedChangedLocators),
    maxBytes,
    clock
  });
  const selected = preview.manifest.selected.map((item) => decisionForPack(item, normalizedTarget));
  const excluded = preview.manifest.excluded.map((item) => decisionForPack(item, normalizedTarget));
  const sourceGraph = await buildContextPackSourceGraph({
    root,
    workspaceId,
    objective,
    step,
    changedLocators: normalizedChangedLocators,
    maxFileBytes: sourceGraphMaxFileBytes,
    createdAt: preview.createdAt
  });
  const changedLocatorMetadata = await inspectChangedLocators({
    root,
    changedLocators: sourceGraph.impact.changedLocators,
    maxBytes
  });
  const repository = await inspectRepositoryIdentity({ root, clock });
  const omissions = buildOmissions({ excluded, sourceGraph, targetHarness: normalizedTarget });
  const utility = buildContextPackUtility({ selected, sourceGraph, preview, requestedInputs, changedLocatorMetadata });
  const handoffCommands = contextPackCommands({
    sourceHarnesses,
    targetHarness: normalizedTarget,
    objective,
    step,
    requestedInputs,
    sourceGraph
  });
  const pack = {
    schemaVersion: '1.0.0',
    packVersion: CONTEXT_PACK_VERSION,
    id: `ctxpack_${idDigest(stableStringify({
      workspaceId,
      targetHarness: normalizedTarget,
      sourceHarnesses,
      objective,
      step,
      previewFingerprint: preview.previewFingerprint,
      sourceGraphFingerprint: sourceGraph.graphFingerprint,
      sourceGraphQueryFingerprint: sourceGraph.queryFingerprint,
      repository,
      requestedInputs
    }))}`,
    workspaceId,
    createdAt: preview.createdAt,
    dryRun: true,
    targetHarness: normalizedTarget,
    sourceHarnesses,
    requestedInputs,
    objective,
    step,
    scannerVersion: preview.scannerVersion,
    compilerVersion: preview.manifest.compilerVersion,
    preview: {
      id: preview.id,
      previewFingerprint: preview.previewFingerprint,
      requestId: preview.manifest.requestId,
      selectionPolicyFingerprint: preview.manifest.selectionPolicyFingerprint,
      resultFingerprint: preview.manifest.resultFingerprint,
      budget: preview.manifest.budget,
      selectedCount: selected.length,
      excludedCount: excluded.length,
      candidateTokenCount: preview.metrics.candidateTokenCount,
      selectedTokenCount: preview.metrics.selectedTokenCount,
      selectedTokenRatio: preview.metrics.selectedTokenRatio
    },
    delivery: null,
    readFirst: selected,
    excluded,
    omissions,
    memoryPlan: preview.memoryPlan,
    sourceGraph,
    repository,
    utility,
    warnings: [...new Set([...packWarnings(preview), ...sourceGraph.warnings])].sort(),
    handoff: {
      title: `${normalizedTarget} context handoff`,
      summary: `Selected ${selected.length} of ${preview.candidates.totalCount} safe workspace context records for ${objective}.`,
      instructions: harnessInstructions(normalizedTarget),
      commands: handoffCommands,
      launchPrompt: launchPromptForPack({
        targetHarness: normalizedTarget,
        objective,
        step,
        utility,
        commands: handoffCommands
      }),
      limitations: [
        'This pack references local workspace locators and hashes; it does not import harness chat history.',
        'Raw context bodies, credentials, provider URLs, hidden reasoning, and private local paths are omitted.',
        'External adapters, model calls, network calls, and external writes remain disabled.'
      ]
    },
    files: [],
    safeguards: {
      ...preview.safeguards,
      contextPackWritten: false,
      sourceGraphPreviewed: sourceGraph.status === 'available',
      graphDatabaseUsed: false,
      sourceSlicesRead: false
    },
    contextPackFingerprint: 'sha256:0000000000000000000000000000000000000000000000000000000000000000'
  };
  const { delivery, markdown } = settleDeliveryBudget(pack);
  pack.delivery = delivery;
  pack.files = [{
    path: 'CONTEXT_PACK.md',
    role: 'agent-handoff',
    contentType: 'text/markdown',
    contentHash: hash(markdown),
    byteSize: Buffer.byteLength(markdown, 'utf8')
  }];
  pack.contextPackFingerprint = fingerprintContextPack(pack);
  assertJsonSchema(contextPackSchema, pack, 'context pack');
  return pack;
}

function usePlanReadItem(item) {
  return {
    locator: item.locator,
    role: item.role,
    required: item.required === true,
    represented: item.represented === true,
    contentHash: typeof item.contentHash === 'string' ? item.contentHash : null,
    reasonCodes: [...new Set((item.reasonCodes ?? []).filter(Boolean))].sort().slice(0, 16),
    readHint: String(item.readHint ?? '').slice(0, 320)
  };
}

function usePlanCoverage(coverage = {}) {
  return {
    total: Number.isFinite(coverage.total) ? coverage.total : 0,
    covered: Number.isFinite(coverage.covered) ? coverage.covered : 0,
    ratio: Number.isFinite(coverage.ratio) ? coverage.ratio : 0,
    status: ['covered', 'partial', 'not_applicable'].includes(coverage.status) ? coverage.status : 'not_applicable'
  };
}

function contextPackRecipientProof({ workspaceId = 'ws_local', targetHarness = 'generic', usePlanResourceUri = null } = {}) {
  const usePlanUri = usePlanResourceUri ?? `oaf://workspace/${workspaceId}/context-pack/use-plan/current`;
  return {
    targetHarness,
    resourceMode: 'read-only',
    requiredResourceUris: [usePlanUri, `oaf://workspace/${workspaceId}/context-pack/registry/current`],
    toolsExposed: 0,
    externalWritesEnabled: false,
    externalAdaptersEnabled: 0
  };
}

function safeImpactBriefWarningCode(value) {
  const code = String(value ?? 'warning')
    .replace(/[^a-z0-9_:-]/giu, '_')
    .replace(/_+/gu, '_')
    .replace(/^[_:-]+|[_:-]+$/gu, '')
    .toLowerCase()
    .slice(0, 96);
  return /^[a-z]/u.test(code) ? code : `warning_${code || 'unknown'}`;
}

export function buildContextPackImpactBrief(pack, {
  generatedAt = pack?.createdAt ?? new Date().toISOString(),
  changedLocatorSource = 'explicit',
  usePlanFingerprint = null,
  maxRequiredReads = 12,
  maxAffectedSymbols = 12,
  maxGraphHints = 8
} = {}) {
  const utility = pack?.utility ?? {};
  const sourceGraph = pack?.sourceGraph ?? {};
  const impact = sourceGraph.impact ?? {};
  const delivery = pack?.delivery ?? {};
  const selection = utility.sourceSelection ?? {};
  const changedLocators = Array.isArray(impact.changedLocators) ? impact.changedLocators.slice(0, MAX_CHANGED_LOCATORS) : [];
  const representedChangedLocators = Array.isArray(impact.representedChangedLocators)
    ? impact.representedChangedLocators.filter((locator) => changedLocators.includes(locator)).slice(0, MAX_CHANGED_LOCATORS)
    : [];
  const requiredLocalReads = (utility.requiredLocalReads ?? [])
    .filter((item) => item?.required === true)
    .slice(0, maxRequiredReads)
    .map(usePlanReadItem);
  const changedReads = requiredLocalReads.filter((item) => item.role === 'changed_locator');
  const affectedSymbols = (impact.affectedSymbols ?? []).slice(0, maxAffectedSymbols).map((item) => ({
    name: String(item?.name ?? '').slice(0, 160),
    symbolKind: String(item?.symbolKind ?? 'symbol').slice(0, 64),
    locator: String(item?.locator ?? '').slice(0, 320),
    depth: Number.isFinite(Number(item?.depth)) ? Number(item.depth) : 0,
    reasonCodes: [...new Set((item?.reasonCodes ?? ['changed_locator_impact']).filter(Boolean))].sort().slice(0, 16)
  }));
  const graphHints = (sourceGraph.results ?? []).slice(0, maxGraphHints).map((item) => ({
    kind: String(item?.kind ?? 'node').slice(0, 64),
    label: String(item?.label ?? '').slice(0, 160),
    locator: String(item?.locator ?? '').slice(0, 320),
    reasonCodes: [...new Set((item?.reasonCodes ?? []).filter(Boolean))].sort().slice(0, 16)
  }));
  const affectedSymbolCount = Number.isInteger(impact.affectedSymbolCount)
    ? impact.affectedSymbolCount
    : Number(impact.affectedSymbols?.length ?? 0);
  const omittedAffectedSymbolCount = Math.max(
    Number.isInteger(impact.omittedAffectedSymbolCount) ? impact.omittedAffectedSymbolCount : 0,
    Math.max(0, affectedSymbolCount - affectedSymbols.length)
  );
  const changedLocatorCoverage = usePlanCoverage(utility.changedLocatorCoverage);
  const graphHintCoverage = usePlanCoverage(utility.graphHintCoverage);
  const status = utility.status === 'ready' && changedLocatorCoverage.status !== 'partial' ? 'ready' : 'review';
  const warnings = [
    ...(Array.isArray(pack?.warnings) ? pack.warnings : []),
    changedLocatorCoverage.status === 'partial' ? 'changed_locator_coverage_partial' : null,
    omittedAffectedSymbolCount > 0 ? 'affected_symbols_truncated' : null,
    requiredLocalReads.length < (utility.requiredLocalReads ?? []).filter((item) => item?.required === true).length ? 'required_reads_truncated' : null
  ].filter(Boolean);
  const brief = {
    schemaVersion: '1.0.0',
    briefVersion: 'oaf-context-impact-brief-1.0.0',
    generatedAt,
    workspaceId: pack?.workspaceId ?? 'ws_local',
    targetHarness: pack?.targetHarness ?? 'generic',
    status,
    request: {
      changedLocatorSource: ['explicit', 'git-status-porcelain'].includes(changedLocatorSource) ? changedLocatorSource : 'explicit',
      sourceHarnesses: Array.isArray(pack?.sourceHarnesses) ? pack.sourceHarnesses : [],
      changedLocatorCount: changedLocators.length,
      userSelectedLocatorCount: Number.isInteger(pack?.requestedInputs?.userSelectedCount) ? pack.requestedInputs.userSelectedCount : 0
    },
    impact: {
      sourceGraphStatus: sourceGraph.status ?? 'unavailable',
      changedLocators,
      representedChangedLocators,
      changedLocatorCoverage,
      graphHintCoverage,
      affectedSymbolCount,
      omittedAffectedSymbolCount,
      affectedSymbols,
      graphHints,
      warningCodes: [...new Set(warnings.map(safeImpactBriefWarningCode))].sort().slice(0, 32)
    },
    readPlan: {
      requiredReadCount: Number((utility.requiredLocalReads ?? []).filter((item) => item?.required === true).length),
      deliveredRequiredReadCount: requiredLocalReads.length,
      changedReadHashVerifiedCount: changedReads.filter((item) => typeof item.contentHash === 'string' && item.contentHash.startsWith('sha256:')).length,
      requiredLocalReads
    },
    selection: {
      candidateUnitCount: Number.isInteger(selection.candidateTokenCount) ? selection.candidateTokenCount : 0,
      selectedUnitCount: Number.isInteger(selection.selectedTokenCount) ? selection.selectedTokenCount : 0,
      selectedUnitRatio: Number.isFinite(selection.selectedTokenRatio) ? selection.selectedTokenRatio : 0,
      estimatedSelectionReductionRatio: Number.isFinite(selection.estimatedReductionRatio) ? selection.estimatedReductionRatio : 0,
      deliveredUnitCount: Number.isInteger(delivery.deliveredTokenCount) ? delivery.deliveredTokenCount : 0,
      observedDeliveryReductionRatio: Number.isFinite(delivery.observedTokenReductionRatio) ? delivery.observedTokenReductionRatio : 0
    },
    evidence: {
      contextPackFingerprint: pack?.contextPackFingerprint ?? null,
      sourceIndexFingerprint: sourceGraph.sourceIndexFingerprint ?? null,
      graphFingerprint: sourceGraph.graphFingerprint ?? null,
      queryFingerprint: sourceGraph.queryFingerprint ?? null,
      usePlanFingerprint,
      handoffArtifactHash: pack?.files?.find((item) => item?.role === 'agent-handoff')?.contentHash ?? null,
      handoffArtifactIncluded: false
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
      graphDatabaseUsed: false,
      privateBodiesIncluded: false,
      objectiveTextIncluded: false,
      stepTextIncluded: false,
      markdownBodyIncluded: false,
      sourceContentIncluded: false,
      diffBodiesIncluded: false,
      absoluteFilesystemLocationsIncluded: false,
      productionBenchmarkClaimed: false
    },
    briefFingerprint: 'sha256:0000000000000000000000000000000000000000000000000000000000000000'
  };
  brief.briefFingerprint = hash(stableStringify({ ...brief, briefFingerprint: null }));
  return brief;
}

export function buildContextPackUsePlan(pack, {
  generatedAt = pack?.createdAt ?? new Date().toISOString(),
  resourceUri = `oaf://workspace/${pack?.workspaceId ?? 'ws_local'}/context-pack/use-plan/current`
} = {}) {
  const requiredLocalReads = (pack?.utility?.requiredLocalReads ?? []).map(usePlanReadItem);
  const targetHarness = pack?.targetHarness ?? 'generic';
  const recipientProof = contextPackRecipientProof({
    workspaceId: pack?.workspaceId ?? 'ws_local',
    targetHarness,
    usePlanResourceUri: resourceUri
  });
  const plan = {
    schemaVersion: '1.0.0',
    usePlanVersion: CONTEXT_PACK_USE_PLAN_VERSION,
    id: `ctxuse_${idDigest(stableStringify({
      contextPackId: pack?.id,
      contextPackFingerprint: pack?.contextPackFingerprint,
      targetHarness,
      resourceUri,
      requiredLocalReads
    }))}`,
    workspaceId: pack?.workspaceId ?? 'ws_local',
    generatedAt,
    targetHarness,
    sourceHarnesses: pack?.sourceHarnesses ?? [],
    contextPack: {
      id: pack?.id ?? 'ctxpack_unknown',
      packVersion: pack?.packVersion ?? CONTEXT_PACK_VERSION,
      createdAt: pack?.createdAt ?? generatedAt,
      fingerprint: pack?.contextPackFingerprint ?? null,
      scannerVersion: pack?.scannerVersion ?? HARNESS_CONTEXT_SCANNER_VERSION,
      compilerVersion: pack?.compilerVersion ?? COMPILER_VERSION
    },
    resource: {
      uri: resourceUri,
      kind: 'context-pack-use-plan'
    },
    recipientProof,
    repository: pack?.repository ?? repositoryIdentityUnavailable({
      generatedAt,
      reason: 'git_status_failed'
    }),
    requestedInputs: {
      sourceHarnesses: pack?.requestedInputs?.sourceHarnesses ?? [],
      userSelectedLocators: pack?.requestedInputs?.userSelectedLocators ?? [],
      changedLocators: pack?.requestedInputs?.changedLocators ?? [],
      userSelectedCount: Number.isInteger(pack?.requestedInputs?.userSelectedCount) ? pack.requestedInputs.userSelectedCount : 0,
      changedLocatorCount: Number.isInteger(pack?.requestedInputs?.changedLocatorCount) ? pack.requestedInputs.changedLocatorCount : 0
    },
    requiredLocalReads,
    coverage: {
      changedLocators: usePlanCoverage(pack?.utility?.changedLocatorCoverage),
      graphHints: usePlanCoverage(pack?.utility?.graphHintCoverage)
    },
    sourceSelection: {
      candidateUnitCount: Number.isInteger(pack?.utility?.sourceSelection?.candidateTokenCount) ? pack.utility.sourceSelection.candidateTokenCount : 0,
      selectedUnitCount: Number.isInteger(pack?.utility?.sourceSelection?.selectedTokenCount) ? pack.utility.sourceSelection.selectedTokenCount : 0,
      selectedUnitRatio: Number.isFinite(pack?.utility?.sourceSelection?.selectedTokenRatio) ? pack.utility.sourceSelection.selectedTokenRatio : 0,
      estimatedReductionRatio: Number.isFinite(pack?.utility?.sourceSelection?.estimatedReductionRatio) ? pack.utility.sourceSelection.estimatedReductionRatio : 0
    },
    delivery: {
      representation: 'locator-handoff',
      deliveredUnitCount: Number.isInteger(pack?.delivery?.deliveredTokenCount) ? pack.delivery.deliveredTokenCount : 0,
      deliveredByteSize: Number.isInteger(pack?.delivery?.deliveredByteSize) ? pack.delivery.deliveredByteSize : 0,
      deliveredUnitRatio: Number.isFinite(pack?.delivery?.deliveredTokenRatio) ? pack.delivery.deliveredTokenRatio : 0,
      observedReductionRatio: Number.isFinite(pack?.delivery?.observedTokenReductionRatio) ? pack.delivery.observedTokenReductionRatio : 0,
      sourceContentUnitCountIncluded: 0,
      sourceContentIncluded: false
    },
    sourceGraph: {
      status: pack?.sourceGraph?.status ?? 'unavailable',
      sourceIndexFingerprint: pack?.sourceGraph?.sourceIndexFingerprint ?? null,
      graphFingerprint: pack?.sourceGraph?.graphFingerprint ?? null,
      queryFingerprint: pack?.sourceGraph?.queryFingerprint ?? null,
      changedLocators: pack?.sourceGraph?.impact?.changedLocators ?? [],
      representedChangedLocators: pack?.sourceGraph?.impact?.representedChangedLocators ?? [],
      affectedSymbolCount: Number.isInteger(pack?.sourceGraph?.impact?.affectedSymbolCount) ? pack.sourceGraph.impact.affectedSymbolCount : 0,
      omittedAffectedSymbolCount: Number.isInteger(pack?.sourceGraph?.impact?.omittedAffectedSymbolCount) ? pack.sourceGraph.impact.omittedAffectedSymbolCount : 0
    },
    handoffArtifact: {
      contentType: 'text/markdown',
      contentHash: pack?.files?.find((item) => item?.role === 'agent-handoff')?.contentHash ?? null,
      byteSize: Number.isInteger(pack?.files?.find((item) => item?.role === 'agent-handoff')?.byteSize)
        ? pack.files.find((item) => item?.role === 'agent-handoff').byteSize
        : 0,
      contentIncluded: false
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
      objectiveTextIncluded: false,
      stepTextIncluded: false,
      launchInstructionsIncluded: false,
      markdownContentIncluded: false,
      sourceContentIncluded: false,
      privateContentIncluded: false,
      absoluteFilesystemLocationsIncluded: false,
      remoteEndpointDetailsIncluded: false
    },
    usePlanFingerprint: 'sha256:0000000000000000000000000000000000000000000000000000000000000000'
  };
  plan.usePlanFingerprint = hash(stableStringify({ ...plan, usePlanFingerprint: null }));
  assertJsonSchema(contextPackUsePlanSchema, plan, 'context pack use plan');
  return plan;
}

function artifactHash(content) {
  return hash(String(content ?? ''));
}

function registryFingerprint(registry) {
  return hash(stableStringify({ ...registry, registryFingerprint: null }));
}

function currentPointerFingerprint(pointer) {
  return hash(stableStringify({ ...pointer, pointerFingerprint: null }));
}

function registryEntryId({ workspaceId, contextPackId, contextPackFingerprint, usePlanFingerprint, usePlanPath }) {
  return `ctxpin_${idDigest(stableStringify({
    workspaceId,
    contextPackId,
    contextPackFingerprint,
    usePlanFingerprint,
    usePlanPath
  }))}`;
}

function boundedRegistryReads(usePlan) {
  return (usePlan?.requiredLocalReads ?? [])
    .filter((item) => item?.required === true)
    .map((item) => ({
      locator: item.locator,
      role: item.role,
      contentHash: typeof item.contentHash === 'string' ? item.contentHash : null,
      represented: item.represented === true,
      reasonCodes: [...new Set((item.reasonCodes ?? []).filter(Boolean))].sort().slice(0, 16)
    }))
    .slice(0, 64);
}

export function buildContextPackRegistryEntry({
  pack,
  usePlan,
  markdown,
  markdownPath = 'context-packs/CONTEXT_PACK.md',
  usePlanContent = JSON.stringify(usePlan, null, 2),
  usePlanPath = 'context-packs/CONTEXT_PACK.use.json',
  createdAt = usePlan?.generatedAt ?? pack?.createdAt ?? new Date().toISOString()
} = {}) {
  assertJsonSchema(contextPackUsePlanSchema, usePlan, 'context pack registry use plan');
  const markdownContent = String(markdown ?? '');
  const usePlanText = String(usePlanContent ?? '');
  const entry = {
    schemaVersion: '1.0.0',
    registryVersion: CONTEXT_PACK_REGISTRY_VERSION,
    id: registryEntryId({
      workspaceId: usePlan.workspaceId,
      contextPackId: usePlan.contextPack.id,
      contextPackFingerprint: usePlan.contextPack.fingerprint,
      usePlanFingerprint: usePlan.usePlanFingerprint,
      usePlanPath
    }),
    workspaceId: usePlan.workspaceId,
    createdAt,
    targetHarness: usePlan.targetHarness,
    sourceHarnesses: usePlan.sourceHarnesses,
    contextPack: {
      id: usePlan.contextPack.id,
      createdAt: usePlan.contextPack.createdAt,
      fingerprint: usePlan.contextPack.fingerprint,
      packVersion: usePlan.contextPack.packVersion,
      scannerVersion: usePlan.contextPack.scannerVersion,
      compilerVersion: usePlan.contextPack.compilerVersion
    },
    usePlan: {
      id: usePlan.id,
      fingerprint: usePlan.usePlanFingerprint,
      generatedAt: usePlan.generatedAt,
      resourceUri: usePlan.resource.uri
    },
    artifacts: [
      {
        role: 'agent-handoff',
        locator: `workspace://${markdownPath}`,
        contentType: 'text/markdown',
        contentHash: artifactHash(markdownContent),
        byteSize: Buffer.byteLength(markdownContent, 'utf8'),
        contentIncluded: false
      },
      {
        role: 'use-plan',
        locator: `workspace://${usePlanPath}`,
        contentType: 'application/json',
        contentHash: artifactHash(usePlanText),
        byteSize: Buffer.byteLength(usePlanText, 'utf8'),
        contentIncluded: false
      }
    ],
    requestedInputs: {
      userSelectedCount: usePlan.requestedInputs.userSelectedCount,
      changedLocatorCount: usePlan.requestedInputs.changedLocatorCount
    },
    coverage: usePlan.coverage,
    sourceSelection: usePlan.sourceSelection,
    delivery: usePlan.delivery,
    sourceGraph: {
      status: usePlan.sourceGraph.status,
      graphFingerprint: usePlan.sourceGraph.graphFingerprint,
      changedLocatorCount: usePlan.sourceGraph.changedLocators.length,
      affectedSymbolCount: usePlan.sourceGraph.affectedSymbolCount
    },
    requiredLocalReads: boundedRegistryReads(usePlan),
    safeguards: {
      readOnlyUsePlan: true,
      canonicalStateMutated: false,
      localFilesWrittenByRegistryAction: 4,
      externalWritesEnabled: false,
      externalAdaptersEnabled: 0,
      networkCalls: 0,
      modelCalls: 0,
      activeMemoryCreated: 0,
      markdownContentIncluded: false,
      sourceContentIncluded: false,
      privateContentIncluded: false,
      absoluteFilesystemLocationsIncluded: false
    }
  };
  return entry;
}

export function buildContextPackRegistry({
  existingRegistry = null,
  entry,
  workspaceId = entry?.workspaceId ?? 'ws_local',
  updatedAt = entry?.createdAt ?? new Date().toISOString()
} = {}) {
  const existingEntries = Array.isArray(existingRegistry?.entries) ? existingRegistry.entries : [];
  const entriesById = new Map(existingEntries.map((item) => [item.id, item]));
  entriesById.set(entry.id, entry);
  const entries = [...entriesById.values()].sort((left, right) => {
    const created = String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? ''));
    return created || String(left.id).localeCompare(String(right.id));
  }).slice(0, 50);
  const registry = {
    schemaVersion: '1.0.0',
    registryVersion: CONTEXT_PACK_REGISTRY_VERSION,
    workspaceId,
    updatedAt,
    currentEntryId: entry.id,
    entries,
    safeguards: {
      canonicalStateMutated: false,
      externalWritesEnabled: false,
      externalAdaptersEnabled: 0,
      networkCalls: 0,
      modelCalls: 0,
      activeMemoryCreated: 0,
      markdownContentIncluded: false,
      sourceContentIncluded: false,
      privateContentIncluded: false,
      absoluteFilesystemLocationsIncluded: false
    },
    registryFingerprint: null
  };
  registry.registryFingerprint = registryFingerprint(registry);
  return registry;
}

export function buildContextPackCurrentPointer({
  registry,
  entry,
  updatedAt = registry?.updatedAt ?? entry?.createdAt ?? new Date().toISOString()
} = {}) {
  const pointer = {
    schemaVersion: '1.0.0',
    registryVersion: CONTEXT_PACK_REGISTRY_VERSION,
    workspaceId: entry.workspaceId,
    updatedAt,
    entryId: entry.id,
    registryLocator: 'workspace://context-packs/registry.json',
    usePlanLocator: entry.artifacts.find((item) => item.role === 'use-plan')?.locator ?? null,
    contextPackFingerprint: entry.contextPack.fingerprint,
    registryFingerprint: registry.registryFingerprint,
    safeguards: {
      canonicalStateMutated: false,
      externalWritesEnabled: false,
      externalAdaptersEnabled: 0,
      networkCalls: 0,
      modelCalls: 0,
      markdownContentIncluded: false,
      sourceContentIncluded: false
    },
    pointerFingerprint: null
  };
  pointer.pointerFingerprint = currentPointerFingerprint(pointer);
  return pointer;
}

async function readOptionalContextPackRegistry(rootReal) {
  try {
    return JSON.parse((await readRegistryWorkspaceFile(rootReal, CONTEXT_PACK_REGISTRY_PATH)).text);
  } catch {
    return null;
  }
}

async function writeRegistryWorkspaceFile(rootReal, relativePath, content) {
  const normalizedPath = registryRelativePath(`workspace://${relativePath}`);
  if (!normalizedPath) throw new Error('registry_artifact_locator_invalid');
  await assertRegistryNoSymlinkAncestors(rootReal, normalizedPath);
  const absolute = path.resolve(rootReal, normalizedPath);
  if (!isInside(rootReal, absolute)) throw new Error('registry_target_escape');
  const parent = path.dirname(absolute);
  await mkdir(parent, { recursive: true });
  const parentReal = await realpath(parent);
  if (!isInside(rootReal, parentReal)) throw new Error('registry_parent_escape');
  const entry = await lstat(absolute).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (entry?.isSymbolicLink()) throw new Error('registry_target_symlink');
  if (entry && !entry.isFile()) throw new Error('registry_target_not_file');
  await writeFile(absolute, String(content ?? ''), 'utf8');
}

export async function pinContextPackArtifacts({
  root = process.cwd(),
  workspaceId = 'ws_local',
  pack,
  markdown,
  usePlan,
  markdownPath = CONTEXT_PACK_MARKDOWN_PATH,
  usePlanPath = CONTEXT_PACK_USE_PLAN_PATH,
  clock = () => new Date().toISOString()
} = {}) {
  assertJsonSchema(contextPackSchema, pack, 'context pack pin pack');
  assertJsonSchema(contextPackUsePlanSchema, usePlan, 'context pack pin use plan');
  const rootReal = await realpath(root);
  const generatedAt = clock();
  const normalizedMarkdownPath = registryRelativePath(`workspace://${markdownPath}`);
  const normalizedUsePlanPath = registryRelativePath(`workspace://${usePlanPath}`);
  if (!normalizedMarkdownPath || !normalizedUsePlanPath) throw new Error('registry_artifact_locator_invalid');
  const markdownText = String(markdown ?? '');
  const usePlanContent = JSON.stringify(usePlan, null, 2);
  const entry = buildContextPackRegistryEntry({
    pack,
    usePlan,
    markdown: markdownText,
    markdownPath: normalizedMarkdownPath,
    usePlanContent,
    usePlanPath: normalizedUsePlanPath,
    createdAt: generatedAt
  });
  const existingRegistry = await readOptionalContextPackRegistry(rootReal);
  const registry = buildContextPackRegistry({
    existingRegistry,
    entry,
    workspaceId,
    updatedAt: generatedAt
  });
  const current = buildContextPackCurrentPointer({ registry, entry, updatedAt: generatedAt });
  const registryContent = JSON.stringify(registry, null, 2);
  const currentContent = JSON.stringify(current, null, 2);

  await writeRegistryWorkspaceFile(rootReal, normalizedMarkdownPath, markdownText);
  await writeRegistryWorkspaceFile(rootReal, normalizedUsePlanPath, usePlanContent);
  await writeRegistryWorkspaceFile(rootReal, CONTEXT_PACK_REGISTRY_PATH, registryContent);
  await writeRegistryWorkspaceFile(rootReal, CONTEXT_PACK_CURRENT_PATH, currentContent);

  const registryStatus = await verifyContextPackRegistry({ root, workspaceId, clock });
  return {
    schemaVersion: '1.0.0',
    command: 'context pack pin',
    pinned: true,
    workspaceId,
    generatedAt,
    targetHarness: usePlan.targetHarness,
    artifacts: [
      { role: 'agent-handoff', locator: `workspace://${normalizedMarkdownPath}`, contentType: 'text/markdown', contentHash: entry.artifacts[0].contentHash, byteSize: entry.artifacts[0].byteSize },
      { role: 'use-plan', locator: `workspace://${normalizedUsePlanPath}`, contentType: 'application/json', contentHash: entry.artifacts[1].contentHash, byteSize: entry.artifacts[1].byteSize },
      { role: 'registry', locator: `workspace://${CONTEXT_PACK_REGISTRY_PATH}`, contentType: 'application/json', contentHash: artifactHash(registryContent), byteSize: Buffer.byteLength(registryContent, 'utf8') },
      { role: 'current-pointer', locator: `workspace://${CONTEXT_PACK_CURRENT_PATH}`, contentType: 'application/json', contentHash: artifactHash(currentContent), byteSize: Buffer.byteLength(currentContent, 'utf8') }
    ],
    registryEntry: {
      ...entry,
      contextPackFingerprint: entry.contextPack.fingerprint,
      usePlanFingerprint: entry.usePlan.fingerprint
    },
    registry: {
      currentEntryId: registry.currentEntryId,
      entryCount: registry.entries.length,
      registryFingerprint: registry.registryFingerprint
    },
    current: {
      entryId: current.entryId,
      pointerFingerprint: current.pointerFingerprint,
      status: registryStatus.current.status
    },
    localFilesWritten: 4,
    registryStatus,
    safeguards: {
      canonicalStateMutated: false,
      localFilesWritten: 4,
      externalWritesEnabled: false,
      externalAdaptersEnabled: 0,
      networkCalls: 0,
      modelCalls: 0,
      activeMemoryCreated: 0,
      sourceSnapshotsWritten: 0,
      markdownContentIncludedInResponse: false,
      sourceContentIncluded: false,
      privateContentIncluded: false,
      absoluteFilesystemLocationsIncluded: false
    }
  };
}

function registryRelativePath(locator) {
  if (typeof locator !== 'string' || !locator.startsWith('workspace://context-packs/')) return null;
  const relativePath = locator.slice('workspace://'.length);
  if (!/^context-packs\/(?:registry\.json|current\.json|[A-Za-z0-9._-]+\.md|[A-Za-z0-9._-]+\.use\.json)$/.test(relativePath)) return null;
  return relativePath;
}

function sourceRelativePath(locator) {
  const stripped = stripLineRange(String(locator ?? ''));
  const withoutScheme = stripped.replace(/^(?:workspace|user-selected):\/\//u, '');
  try {
    return normalizeUserSelectedFilePath(withoutScheme);
  } catch {
    return null;
  }
}

function safeRegistrySourceLocator(locator) {
  if (typeof locator !== 'string' || UNSAFE_PERSISTED_LOCATOR.test(locator)) return null;
  const relativePath = sourceRelativePath(locator);
  if (!relativePath) return null;
  const scheme = locator.startsWith('user-selected://') ? 'user-selected' : 'workspace';
  return {
    locator: `${scheme}://${relativePath}`,
    relativePath
  };
}

async function readRegistryWorkspaceFile(rootReal, relativePath) {
  await assertRegistryNoSymlinkAncestors(rootReal, relativePath);
  const absolute = path.resolve(rootReal, relativePath);
  const entry = await lstat(absolute);
  if (entry.isSymbolicLink()) throw new Error('registry_target_symlink');
  if (!entry.isFile()) throw new Error('registry_target_not_file');
  const actual = await realpath(absolute);
  if (!isInside(rootReal, actual)) throw new Error('registry_target_escape');
  return {
    text: await readFile(actual, 'utf8'),
    byteSize: entry.size
  };
}

async function assertRegistryNoSymlinkAncestors(rootReal, relativePath) {
  const parts = relativePath.split('/').slice(0, -1);
  let current = rootReal;
  for (const part of parts) {
    current = path.join(current, part);
    const entry = await lstat(current).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!entry) return;
    if (entry.isSymbolicLink()) throw new Error('registry_parent_symlink');
    if (!entry.isDirectory()) throw new Error('registry_parent_not_directory');
  }
}

async function verifyRegistryArtifact(rootReal, artifact) {
  const relativePath = registryRelativePath(artifact?.locator);
  if (!relativePath) {
    return {
      role: artifact?.role ?? 'unknown',
      locator: artifact?.locator ?? null,
      status: 'tampered',
      reasonCodes: ['registry_artifact_locator_invalid']
    };
  }
  try {
    const file = await readRegistryWorkspaceFile(rootReal, relativePath);
    const actualHash = artifactHash(file.text);
    const status = actualHash === artifact.contentHash && file.byteSize === artifact.byteSize ? 'verified' : 'tampered';
    return {
      role: artifact.role,
      locator: artifact.locator,
      expectedHash: artifact.contentHash,
      actualHash,
      expectedByteSize: artifact.byteSize,
      actualByteSize: file.byteSize,
      status,
      reasonCodes: status === 'verified' ? ['artifact_hash_verified'] : ['artifact_hash_mismatch']
    };
  } catch (error) {
    return {
      role: artifact?.role ?? 'unknown',
      locator: artifact?.locator ?? null,
      expectedHash: artifact?.contentHash ?? null,
      actualHash: null,
      expectedByteSize: artifact?.byteSize ?? null,
      actualByteSize: null,
      status: 'missing',
      reasonCodes: [error?.message === 'registry_parent_symlink' ? 'registry_parent_symlink' : 'artifact_unavailable']
    };
  }
}

async function verifyRegistrySourceRead(rootReal, item) {
  const safeLocator = safeRegistrySourceLocator(item?.locator);
  if (!safeLocator || !item?.contentHash) {
    return {
      locator: safeLocator?.locator ?? REDACTED_UNSAFE_SOURCE_LOCATOR,
      role: item?.role ?? null,
      expectedHash: item?.contentHash ?? null,
      actualHash: null,
      status: 'unavailable',
      reasonCodes: [safeLocator ? 'source_hash_unavailable' : 'source_locator_unsafe']
    };
  }
  const metadata = await inspectChangedLocator({
    root: rootReal,
    rootReal,
    locator: `workspace://${safeLocator.relativePath}`,
    maxBytes: DEFAULT_CHANGED_HASH_MAX_BYTES
  });
  if (!metadata.contentHash) {
    return {
      locator: safeLocator.locator,
      role: item.role,
      expectedHash: item.contentHash,
      actualHash: null,
      status: 'unavailable',
      reasonCodes: metadata.reasonCodes
    };
  }
  const status = metadata.contentHash === item.contentHash ? 'verified' : 'stale';
  return {
    locator: safeLocator.locator,
    role: item.role,
    expectedHash: item.contentHash,
    actualHash: metadata.contentHash,
    status,
    reasonCodes: status === 'verified' ? ['source_hash_verified'] : ['source_hash_changed']
  };
}

function entryVerificationStatus({ artifactChecks, sourceChecks }) {
  if (artifactChecks.some((item) => item.status === 'tampered' || item.status === 'missing')) return 'tampered';
  if (sourceChecks.some((item) => item.status === 'stale')) return 'stale';
  if (sourceChecks.some((item) => item.status === 'unavailable')) return 'review';
  return 'verified';
}

async function verifyRegistryEntry(rootReal, entry) {
  const artifactChecks = [];
  for (const artifact of entry.artifacts ?? []) artifactChecks.push(await verifyRegistryArtifact(rootReal, artifact));
  const sourceChecksList = [];
  for (const item of entry.requiredLocalReads ?? []) sourceChecksList.push(await verifyRegistrySourceRead(rootReal, item));
  const staleLocators = sourceChecksList.filter((item) => item.status === 'stale').map((item) => item.locator);
  const unavailableLocators = sourceChecksList.filter((item) => item.status === 'unavailable').map((item) => item.locator);
  const verifiedLocators = sourceChecksList.filter((item) => item.status === 'verified').map((item) => item.locator);
  const status = entryVerificationStatus({ artifactChecks, sourceChecks: sourceChecksList });
  return {
    id: entry.id,
    workspaceId: entry.workspaceId,
    createdAt: entry.createdAt,
    targetHarness: entry.targetHarness,
    contextPack: entry.contextPack,
    usePlan: entry.usePlan,
    artifactChecks,
    sourceChecks: {
      total: sourceChecksList.length,
      verified: verifiedLocators.length,
      stale: staleLocators.length,
      unavailable: unavailableLocators.length,
      verifiedLocators,
      staleLocators,
      unavailableLocators
    },
    status
  };
}

export async function verifyContextPackRegistry({
  root = process.cwd(),
  workspaceId = 'ws_local',
  registryPath = 'context-packs/registry.json',
  currentPath = 'context-packs/current.json',
  clock = () => new Date().toISOString()
} = {}) {
  const rootReal = await realpath(root);
  const generatedAt = clock();
  let registry = null;
  let currentPointer = null;
  const warnings = [];
  try {
    registry = JSON.parse((await readRegistryWorkspaceFile(rootReal, registryPath)).text);
  } catch {
    registry = null;
    warnings.push('context_pack_registry_missing');
  }
  try {
    currentPointer = JSON.parse((await readRegistryWorkspaceFile(rootReal, currentPath)).text);
  } catch {
    currentPointer = null;
    warnings.push('context_pack_current_pointer_missing');
  }
  const registryFingerprintStatus = registry
    ? (registry.registryFingerprint === registryFingerprint(registry) ? 'verified' : 'tampered')
    : 'missing';
  const pointerSelfFingerprintStatus = currentPointer
    ? (currentPointer.pointerFingerprint === currentPointerFingerprint(currentPointer) ? 'verified' : 'tampered')
    : 'missing';
  const pointerRegistryFingerprintStatus = currentPointer
    ? (registry && currentPointer.registryFingerprint === registry.registryFingerprint ? 'verified' : 'tampered')
    : 'missing';
  const pointerFingerprintStatus = currentPointer
    ? (pointerSelfFingerprintStatus === 'verified' && pointerRegistryFingerprintStatus === 'verified' ? 'verified' : 'tampered')
    : 'missing';
  if (pointerSelfFingerprintStatus === 'verified' && pointerRegistryFingerprintStatus === 'tampered') {
    warnings.push('context_pack_current_pointer_registry_mismatch');
  }
  const entries = [];
  for (const entry of registry?.entries ?? []) entries.push(await verifyRegistryEntry(rootReal, entry));
  if (entries.some((entry) => entry.sourceChecks.unavailableLocators.includes(REDACTED_UNSAFE_SOURCE_LOCATOR))) {
    warnings.push('context_pack_registry_unsafe_locator_redacted');
  }
  const currentEntryId = currentPointer?.entryId ?? registry?.currentEntryId ?? null;
  const current = entries.find((entry) => entry.id === currentEntryId) ?? null;
  const currentStatus = registryFingerprintStatus === 'tampered' || pointerFingerprintStatus === 'tampered'
    ? 'tampered'
    : (current ? current.status : 'missing');
  const report = {
    schemaVersion: '1.0.0',
    registryVersion: CONTEXT_PACK_REGISTRY_VERSION,
    command: 'context registry status',
    workspaceId,
    generatedAt,
    registry: {
      exists: Boolean(registry),
      locator: 'workspace://context-packs/registry.json',
      currentEntryId: registry?.currentEntryId ?? null,
      entryCount: Array.isArray(registry?.entries) ? registry.entries.length : 0,
      registryFingerprint: registry?.registryFingerprint ?? null,
      fingerprintStatus: registryFingerprintStatus
    },
    currentPointer: {
      exists: Boolean(currentPointer),
      locator: 'workspace://context-packs/current.json',
      entryId: currentPointer?.entryId ?? null,
      pointerFingerprint: currentPointer?.pointerFingerprint ?? null,
      fingerprintStatus: pointerFingerprintStatus
    },
    current: current ? { entryId: current.id, status: currentStatus } : { entryId: currentEntryId, status: currentStatus },
    entries,
    warnings: [...new Set(warnings)].sort(),
    safeguards: {
      readOnly: true,
      canonicalStateMutated: false,
      localFilesWritten: 0,
      externalWritesEnabled: false,
      externalAdaptersEnabled: 0,
      networkCalls: 0,
      modelCalls: 0,
      activeMemoryCreated: 0,
      markdownContentIncluded: false,
      sourceContentIncluded: false,
      privateContentIncluded: false,
      absoluteFilesystemLocationsIncluded: false
    }
  };
  assertJsonSchema(contextPackRegistryStatusSchema, report, 'context pack registry status');
  return report;
}

export async function loadCurrentContextPackUsePlan({
  root = process.cwd(),
  workspaceId = 'ws_local',
  currentPath = 'context-packs/current.json',
  clock = () => new Date().toISOString()
} = {}) {
  const status = await verifyContextPackRegistry({ root, workspaceId, currentPath, clock });
  if (!status.registry.exists || status.registry.fingerprintStatus !== 'verified') return null;
  if (!status.currentPointer.exists || status.currentPointer.fingerprintStatus !== 'verified') return null;
  if (status.current.status !== 'verified') return null;
  const rootReal = await realpath(root);
  const pointer = JSON.parse((await readRegistryWorkspaceFile(rootReal, currentPath)).text);
  const relativePath = registryRelativePath(pointer.usePlanLocator);
  if (!relativePath || !relativePath.endsWith('.use.json')) return null;
  const plan = JSON.parse((await readRegistryWorkspaceFile(rootReal, relativePath)).text);
  assertJsonSchema(contextPackUsePlanSchema, plan, 'current context pack use plan');
  if (plan.workspaceId !== workspaceId) return null;
  if (pointer.contextPackFingerprint !== plan.contextPack.fingerprint) return null;
  return plan;
}

export async function buildContextPackReceiveReport({
  root = process.cwd(),
  workspaceId = 'ws_local',
  targetHarness = null,
  home = process.env.HOME ?? process.cwd(),
  trustedContext = null,
  generatedAt = null,
  clock = () => new Date().toISOString()
} = {}) {
  const timestamp = generatedAt ?? clock();
  const registryStatus = await verifyContextPackRegistry({ root, workspaceId, clock: () => timestamp });
  const currentEntry = registryStatus.entries.find((entry) => entry.id === registryStatus.current.entryId) ?? null;
  const usePlan = await loadCurrentContextPackUsePlan({ root, workspaceId, clock: () => timestamp }).catch(() => null);
  const normalizedTarget = normalizeTargetHarness(targetHarness ?? usePlan?.targetHarness ?? currentEntry?.targetHarness ?? 'codex');
  const setupClient = contextPackSetupClient(normalizedTarget);
  const setup = await buildHarnessSetupReport({
    action: 'status',
    client: setupClient,
    server: 'oaf',
    home,
    generatedAt: timestamp
  });
  const resources = buildOafReadOnlyResourceCatalog({
    state: {},
    projectStatus: {},
    currentContextPackUsePlan: usePlan,
    currentContextPackRegistryStatus: registryStatus,
    workspaceId,
    generatedAt: timestamp
  });
  const bridge = createMcpBridge({
    trustedContext: trustedContext ?? defaultReceiveTrustedContext(workspaceId),
    resources,
    tools: [],
    clock: () => timestamp
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
  const expectedRecipientProof = contextPackRecipientProof({
    workspaceId,
    targetHarness: normalizedTarget,
    usePlanResourceUri
  });
  const actualRecipientProof = usePlan?.recipientProof ?? null;
  const recipientResourceUris = actualRecipientProof?.requiredResourceUris ?? [];
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
    currentEntryMatchesTarget: Boolean(usePlan && currentEntry && usePlan.targetHarness === normalizedTarget && currentEntry.targetHarness === normalizedTarget),
    usePlanLoaded: Boolean(usePlan),
    usePlanFingerprintMatchesRegistry: Boolean(usePlan && currentEntry?.usePlan?.fingerprint === usePlan.usePlanFingerprint),
    contextPackFingerprintMatchesRegistry: Boolean(usePlan && currentEntry?.contextPack?.fingerprint === usePlan.contextPack.fingerprint),
    noToolsExposed: listedTools.length === 0,
    usePlanResourceRead: usePlanPayload?.resourceKind === 'context-pack-use-plan',
    registryResourceRead: registryPayload?.resourceKind === 'context-pack-registry-status',
    recipientProofValid: Boolean(actualRecipientProof
      && actualRecipientProof.targetHarness === expectedRecipientProof.targetHarness
      && actualRecipientProof.resourceMode === expectedRecipientProof.resourceMode
      && actualRecipientProof.toolsExposed === 0
      && actualRecipientProof.externalWritesEnabled === false
      && actualRecipientProof.externalAdaptersEnabled === 0
      && recipientResourceUris.length === expectedRecipientProof.requiredResourceUris.length
      && expectedRecipientProof.requiredResourceUris.every((uri) => recipientResourceUris.includes(uri))),
    setupDryRun: setup.dryRun === true,
    setupUsesInstalledOaf: harnessSetupUsesRunnableOaf(setup.desiredServer)
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
    checks.recipientProofValid,
    checks.setupDryRun,
    checks.setupUsesInstalledOaf
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
    createPinnedContextPack: oafCommand(`context pack --from codex --root . --objective '<reviewed-objective>' --step '<reviewed-step>' --target ${normalizedTarget} --write --pin --out context-packs/CONTEXT_PACK.md --format json`),
    checkRegistry: oafCommand(`context registry status --read-only --root . --workspace ${workspaceId} --format json`),
    readUsePlan: oafCommand(`mcp resources --read-only --root . --workspace ${workspaceId} --uri ${usePlanResourceUri} --format json`),
    readRegistry: oafCommand(`mcp resources --read-only --root . --workspace ${workspaceId} --uri ${registryResourceUri} --format json`),
    previewSetup: oafCommand(`harness setup status --client ${setupClient} --server oaf --dry-run --format json`),
    startReadOnlyBridge: oafCommand(`mcp resources --read-only --root . --workspace ${workspaceId} --stdio`)
  };
  const report = {
    schemaVersion: '1.0.0',
    command: 'context receive',
    generatedAt: timestamp,
    workspaceId,
    targetHarness: normalizedTarget,
    state,
    commitSha: await resolveCommitSha(root),
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
      workspaceId,
      state,
      targetHarness: normalizedTarget,
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
  report.reportFingerprint = hashJson({ ...report, reportFingerprint: null });
  assertJsonSchema(contextPackReceiveReportSchema, report, 'context-pack receive report');
  return report;
}

function harnessSetupUsesRunnableOaf(server) {
  return isOafServerInvocation(server, OAF_MCP_RESOURCE_BINARY_ARGS) ||
    isOafServerInvocation(server, OAF_MCP_TOKEN_SAVER_BINARY_ARGS);
}

function defaultReceiveTrustedContext(workspaceId) {
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

function buildContextReceiverPacket({ workspaceId = 'ws_local', state, targetHarness, registryStatus, currentEntry, usePlan, requiredLocalReads, commands, checks, listedTools }) {
  const contextPackFingerprint = currentEntry?.contextPack?.fingerprint ?? usePlan?.contextPack?.fingerprint ?? null;
  const usePlanFingerprint = currentEntry?.usePlan?.fingerprint ?? usePlan?.usePlanFingerprint ?? null;
  const recipientProof = usePlan?.recipientProof ?? contextPackRecipientProof({ workspaceId, targetHarness });
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
  const fingerprints = {
    registry: registryStatus.registry.registryFingerprint,
    currentPointer: registryStatus.currentPointer.pointerFingerprint,
    contextPack: contextPackFingerprint,
    usePlan: usePlanFingerprint
  };
  const proof = {
    registryFingerprintVerified: checks.registryFingerprintVerified,
    currentPointerVerified: checks.currentPointerVerified,
    currentEntryVerified: checks.currentEntryVerified,
    targetMatches: checks.currentEntryMatchesTarget,
    usePlanLoaded: checks.usePlanLoaded,
    usePlanResourceRead: checks.usePlanResourceRead,
    registryResourceRead: checks.registryResourceRead,
    recipientProofValid: checks.recipientProofValid,
    recipientProof,
    toolsExposed: listedTools.length,
    externalWritesEnabled: false,
    externalAdaptersEnabled: 0,
    sourceContentIncluded: false,
    markdownBodyIncluded: false,
    rawSourceBodiesIncluded: false
  };
  const readPlan = {
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
  };
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
  const messageParts = [
    {
      schemaVersion: '1.0.0',
      partType: 'summary',
      contentType: 'text/plain',
      text: summary
    },
    {
      schemaVersion: '1.0.0',
      partType: 'proof',
      contentType: 'application/json',
      state,
      reviewNeeded,
      fingerprints,
      proof
    },
    {
      schemaVersion: '1.0.0',
      partType: 'read_plan',
      contentType: 'application/json',
      readPlan
    },
    {
      schemaVersion: '1.0.0',
      partType: 'next_actions',
      contentType: 'application/json',
      nextActions
    }
  ];
  return {
    packetVersion: 'oaf-context-receiver-packet-1.0.0',
    state,
    targetHarness,
    summary,
    reviewNeeded,
    fingerprints,
    proof,
    readPlan,
    nextActions,
    messageParts,
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

async function resolveCommitSha(root = process.cwd()) {
  if (/^[a-f0-9]{40}$/.test(process.env.OAF_COMMIT_SHA ?? '')) return process.env.OAF_COMMIT_SHA;
  try {
    const { stdout } = await execFileAsync('git', ['-C', path.resolve(root), 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 4096
    });
    const value = stdout.trim();
    if (/^[a-f0-9]{40}$/.test(value)) return value;
  } catch {
    // Git metadata is unavailable in generated source archives.
  }
  return '0000000000000000000000000000000000000000';
}

function defaultThresholds(dataset) {
  return {
    requiredLocatorRecall: 1,
    distractorExclusionRate: 0.9,
    selectedTokenRatioMax: 0.65,
    caseDurationMsMax: 1000,
    suiteDurationMsMax: 5000,
    ...(dataset.thresholds ?? {})
  };
}

async function writeCaseWorkspace(testCase) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaf-hctx-bench-'));
  for (const file of testCase.files ?? []) {
    const relativePath = String(file.path ?? '');
    if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(path.sep).includes('..') || relativePath.split('/').includes('..')) {
      throw new TypeError(`benchmark case ${testCase.id}: unsafe file path`);
    }
    const absolutePath = path.join(root, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, String(file.body ?? ''));
  }
  return root;
}

function countForbidden(serialized, forbiddenStrings = []) {
  return forbiddenStrings.filter((value) => value && serialized.includes(value)).length;
}

function casePasses(metrics, thresholds) {
  return metrics.requiredLocatorRecall === 1 &&
    metrics.distractorExclusionRate >= thresholds.distractorExclusionRate &&
    metrics.secretLeakageCount === 0 &&
    metrics.localPathLeakageCount === 0 &&
    metrics.rawBodyLeakageCount === 0 &&
    metrics.activeMemoryCreated === 0 &&
    metrics.sourceSnapshotsWritten === 0 &&
    metrics.modelCalls === 0 &&
    metrics.networkCalls === 0 &&
    metrics.externalAdaptersEnabled === 0 &&
    metrics.externalWritesEnabled === false &&
    metrics.deterministic === true &&
    metrics.selectedTokenRatio <= thresholds.selectedTokenRatioMax &&
    metrics.durationMs <= thresholds.caseDurationMsMax;
}

export async function runHarnessContextBenchmarks(dataset, { clock = () => new Date().toISOString() } = {}) {
  if (!dataset || !Array.isArray(dataset.cases)) throw new TypeError('benchmark dataset cases are required');
  const thresholds = defaultThresholds(dataset);
  const suiteStarted = Date.now();
  const cases = [];
  let requiredHits = 0;
  let requiredTotal = 0;
  let excludedHits = 0;
  let excludedTotal = 0;
  let selectedTokens = 0;
  let candidateTokens = 0;
  let secretLeakageCount = 0;
  let localPathLeakageCount = 0;
  let rawBodyLeakageCount = 0;
  let activeMemoryCreated = 0;
  let sourceSnapshotsWritten = 0;
  let modelCalls = 0;
  let networkCalls = 0;
  let externalAdaptersEnabled = 0;
  let externalWritesEnabled = false;
  let deterministicMismatchCount = 0;

  for (const testCase of dataset.cases) {
    const caseStarted = Date.now();
    const root = await writeCaseWorkspace(testCase);
    try {
      const preview = await buildHarnessContextPreview({
        root,
        harnesses: testCase.harnesses ?? ['all'],
        workspaceId: testCase.workspaceId ?? 'ws_benchmark',
        objective: testCase.objective,
        step: testCase.step,
        tokenBudget: testCase.tokenBudget ?? 4096,
        clock
      });
      const rerun = await buildHarnessContextPreview({
        root,
        harnesses: testCase.harnesses ?? ['all'],
        workspaceId: testCase.workspaceId ?? 'ws_benchmark',
        objective: testCase.objective,
        step: testCase.step,
        tokenBudget: testCase.tokenBudget ?? 4096,
        clock
      });
      const serialized = JSON.stringify(preview);
      const selectedLocators = preview.manifest.selected.map((item) => item.locator).filter(Boolean).sort();
      const excludedLocators = preview.manifest.excluded.map((item) => item.locator).filter(Boolean).sort();
      const required = testCase.expect?.selectedLocators ?? [];
      const excludedExpected = testCase.expect?.excludedLocators ?? [];
      const requiredFound = required.filter((locator) => selectedLocators.includes(locator)).length;
      const excludedFound = excludedExpected.filter((locator) => !selectedLocators.includes(locator)).length;
      const forbiddenLeaks = countForbidden(serialized, testCase.expect?.forbiddenStrings ?? []);
      const localLeaks = /\/Users\/[A-Za-z0-9._-]+/u.test(serialized) ? 1 : 0;
      const secretLeaks = /(?:secret-value|raw-secret|sk-[A-Za-z0-9_-]{12,}|api[_-]?key\s*[:=])/iu.test(serialized) ? 1 : 0;
      const metrics = {
        requiredLocatorRecall: required.length ? Number((requiredFound / required.length).toFixed(6)) : 1,
        distractorExclusionRate: excludedExpected.length ? Number((excludedFound / excludedExpected.length).toFixed(6)) : 1,
        selectedTokenRatio: preview.metrics.selectedTokenRatio,
        secretLeakageCount: secretLeaks,
        localPathLeakageCount: localLeaks,
        rawBodyLeakageCount: forbiddenLeaks,
        activeMemoryCreated: preview.safeguards.activeMemoryCreated,
        sourceSnapshotsWritten: preview.safeguards.sourceSnapshotsWritten,
        modelCalls: preview.safeguards.modelCalls,
        networkCalls: preview.safeguards.networkCalls,
        externalAdaptersEnabled: preview.safeguards.externalAdaptersEnabled,
        externalWritesEnabled: preview.safeguards.externalWritesEnabled,
        deterministic: preview.previewFingerprint === rerun.previewFingerprint,
        durationMs: Date.now() - caseStarted
      };
      const passed = casePasses(metrics, thresholds);
      cases.push({
        id: testCase.id,
        passed,
        selectedLocators,
        excludedLocators,
        metrics,
        previewFingerprint: preview.previewFingerprint
      });
      requiredHits += requiredFound;
      requiredTotal += required.length;
      excludedHits += excludedFound;
      excludedTotal += excludedExpected.length;
      selectedTokens += preview.metrics.selectedTokenCount;
      candidateTokens += preview.metrics.candidateTokenCount;
      secretLeakageCount += secretLeaks;
      localPathLeakageCount += localLeaks;
      rawBodyLeakageCount += forbiddenLeaks;
      activeMemoryCreated += preview.safeguards.activeMemoryCreated;
      sourceSnapshotsWritten += preview.safeguards.sourceSnapshotsWritten;
      modelCalls += preview.safeguards.modelCalls;
      networkCalls += preview.safeguards.networkCalls;
      externalAdaptersEnabled += preview.safeguards.externalAdaptersEnabled;
      externalWritesEnabled = externalWritesEnabled || preview.safeguards.externalWritesEnabled;
      if (preview.previewFingerprint !== rerun.previewFingerprint) deterministicMismatchCount += 1;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  const durationMs = Date.now() - suiteStarted;
  const metrics = {
    requiredLocatorRecall: requiredTotal ? Number((requiredHits / requiredTotal).toFixed(6)) : 1,
    distractorExclusionRate: excludedTotal ? Number((excludedHits / excludedTotal).toFixed(6)) : 1,
    selectedTokenRatio: candidateTokens ? Number((selectedTokens / candidateTokens).toFixed(6)) : 0,
    secretLeakageCount,
    localPathLeakageCount,
    rawBodyLeakageCount,
    activeMemoryCreated,
    sourceSnapshotsWritten,
    modelCalls,
    networkCalls,
    externalAdaptersEnabled,
    externalWritesEnabled,
    deterministicMismatchCount,
    durationMs
  };
  const passed = metrics.requiredLocatorRecall >= thresholds.requiredLocatorRecall &&
    metrics.distractorExclusionRate >= thresholds.distractorExclusionRate &&
    metrics.selectedTokenRatio <= thresholds.selectedTokenRatioMax &&
    metrics.secretLeakageCount === 0 &&
    metrics.localPathLeakageCount === 0 &&
    metrics.rawBodyLeakageCount === 0 &&
    metrics.activeMemoryCreated === 0 &&
    metrics.sourceSnapshotsWritten === 0 &&
    metrics.modelCalls === 0 &&
    metrics.networkCalls === 0 &&
    metrics.externalAdaptersEnabled === 0 &&
    metrics.externalWritesEnabled === false &&
    metrics.deterministicMismatchCount === 0 &&
    metrics.durationMs <= thresholds.suiteDurationMsMax &&
    cases.every((item) => item.passed);
  return {
    schemaVersion: '1.0.0',
    benchmarkVersion: HARNESS_CONTEXT_BENCHMARK_VERSION,
    suite: dataset.name ?? 'harness-context-preview',
    caseCount: cases.length,
    thresholds,
    metrics,
    cases,
    passed
  };
}

export async function buildHarnessSetupReport({
  action,
  client,
  server = 'oaf',
  home = process.env.HOME ?? process.cwd(),
  configPath = null,
  bridgeMode = 'resources',
  generatedAt = new Date().toISOString()
}) {
  const normalizedAction = normalizeHarnessSetupAction(action);
  const normalizedClient = normalizeHarnessSetupClient(client);
  const normalizedServer = normalizeHarnessSetupServer(server);
  const normalizedBridgeMode = normalizeHarnessSetupBridgeMode(bridgeMode);
  const selectedConfigPath = configPath ?? normalizedClient.configPath;
  const config = await readHomeConfig(home, selectedConfigPath);
  const parsed = config.exists ? parseHarnessConfig(config.text, normalizedClient.format) : emptyHarnessConfig(normalizedClient.format);
  const servers = extractHarnessServers(parsed);
  const serverState = classifyHarnessServer(servers.get(normalizedServer), { bridgeMode: normalizedBridgeMode });
  const operations = harnessSetupOperations({ action: normalizedAction, server: normalizedServer, serverState, bridgeMode: normalizedBridgeMode });
  const report = {
    schemaVersion: '1.0.0',
    plannerVersion: HARNESS_SETUP_PLANNER_VERSION,
    command: `harness setup ${normalizedAction}`,
    dryRun: true,
    generatedAt,
    client: normalizedClient.id,
    clientLabel: normalizedClient.label,
    server: normalizedServer,
    bridgeMode: normalizedBridgeMode,
    config: {
      ref: config.configRef,
      format: normalizedClient.format,
      exists: config.exists,
      serverCount: servers.size
    },
    status: {
      config: config.exists ? 'present' : 'absent',
      server: serverState
    },
    desiredServer: desiredHarnessServerSummary(normalizedServer, { bridgeMode: normalizedBridgeMode }),
    desiredHooks: desiredHarnessHooks(normalizedClient),
    manualHookSnippet: harnessManualHookSnippet(normalizedClient),
    manualConfigSnippet: harnessManualConfigSnippet({
      client: normalizedClient,
      server: normalizedServer,
      bridgeMode: normalizedBridgeMode,
      configRef: config.configRef
    }),
    diff: {
      redacted: true,
      operations,
      preview: operations.map((operation) => operation.summary)
    },
    safeguards: harnessSetupSafeguards()
  };
  return { ...report, planFingerprint: hash(stableStringify(report)) };
}

export function normalizeHarnessSetupClient(value) {
  const aliases = new Map([['claude', 'claude-code'], ['gemini', 'gemini-cli'], ['generic', 'generic-mcp']]);
  const id = aliases.get(String(value ?? '').trim()) ?? String(value ?? '').trim();
  const client = HARNESS_SETUP_CLIENTS.get(id);
  if (!client) throw new Error(`unsupported harness setup client: ${value ?? '<missing>'}`);
  return client;
}

function normalizeHarnessSetupAction(value) {
  const action = String(value ?? '').trim();
  if (!['status', 'plan', 'uninstall'].includes(action)) throw new Error('harness setup requires status, plan, or uninstall');
  return action;
}

function normalizeHarnessSetupServer(value) {
  const name = String(value ?? '').trim();
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(name)) throw new Error(`invalid harness setup server name: ${name || '<empty>'}`);
  if (name !== 'oaf') throw new Error('harness setup only supports the oaf MCP server');
  return name;
}

function normalizeHarnessSetupBridgeMode(value) {
  const mode = String(value ?? 'resources').trim();
  if (!['resources', 'token-saver'].includes(mode)) throw new Error(`unsupported harness setup bridge mode: ${mode || '<missing>'}`);
  return mode;
}

async function readHomeConfig(home, relativePath) {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('..')) throw new Error(`harness config path is unsupported: ${relativePath}`);
  const realHome = await realpath(home);
  const absolute = path.resolve(realHome, relativePath);
  if (!isInside(realHome, absolute)) throw new Error(`harness config path escapes home: ${relativePath}`);
  let actual;
  try {
    actual = await realpath(absolute);
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, text: '', configRef: `home://${toPosix(relativePath)}` };
    throw error;
  }
  if (!isInside(realHome, actual)) throw new Error(`harness config path escapes home: ${relativePath}`);
  const info = await stat(actual);
  if (!info.isFile()) throw new Error(`harness config path is not a file: ${relativePath}`);
  if (info.size > 256 * 1024) throw new Error(`harness config exceeds 256 KiB: ${relativePath}`);
  return { exists: true, text: await readFile(actual, 'utf8'), configRef: `home://${toPosix(relativePath)}` };
}

function harnessSetupOperations({ action, server, serverState, bridgeMode }) {
  if (action === 'status') return [];
  if (action === 'plan') {
    if (serverState === 'installed') return [];
    const label = bridgeMode === 'token-saver' ? 'token-saver server' : 'resource bridge';
    return [{
      op: serverState === 'absent' ? 'add' : 'replace',
      target: `mcpServers.${server}`,
      before: serverState,
      after: 'read-only-oaf-mcp-stdio',
      summary: `${serverState === 'absent' ? 'add' : 'replace'} ${server} with read-only OAF MCP stdio ${label}`
    }];
  }
  if (serverState === 'absent') return [];
  return [{
    op: 'remove',
    target: `mcpServers.${server}`,
    before: serverState,
    after: 'absent',
    summary: `remove exactly ${server} from the harness MCP server map`
  }];
}

function harnessSetupSafeguards() {
  return {
    localFilesWritten: 0,
    canonicalStateMutated: false,
    homeConfigMutated: false,
    externalWritesEnabled: false,
    externalAdaptersEnabled: 0,
    networkCalls: 0,
    modelCalls: 0,
    rawConfigBodyIncluded: false,
    absoluteFilesystemLocationsIncluded: false,
    credentialsIncluded: false
  };
}

function desiredHarnessServerSummary(server, { bridgeMode = 'resources' } = {}) {
  const binaryArgs = bridgeMode === 'token-saver' ? [...OAF_MCP_TOKEN_SAVER_BINARY_ARGS] : [...OAF_MCP_RESOURCE_BINARY_ARGS];
  const invocation = oafServerCommand(binaryArgs);
  return {
    name: server,
    transport: 'stdio',
    command: invocation.command,
    args: invocation.args,
    environmentKeys: [],
    resourceMode: bridgeMode === 'token-saver' ? 'read-only-token-saver' : 'read-only',
    externalWrites: false
  };
}

function desiredHarnessHooks(client) {
  const supported = ['codex', 'claude-code'].includes(client.id);
  return {
    supported,
    applyMode: 'manual-copy',
    events: supported ? ['SessionStart', 'UserPromptSubmit', 'PreCompact'] : [],
    command: supported
      ? (sourceCheckoutHasOafScript() ? oafCommand('hook context --read-only --format text') : OAF_HOOK_CONTEXT_COMMAND)
      : null,
    authority: 'none',
    externalWrites: false
  };
}

function harnessManualHookSnippet(client) {
  const desired = desiredHarnessHooks(client);
  const configRef = client.id === 'codex' ? 'home://.codex/hooks.json' : client.id === 'claude-code' ? 'home://.claude/settings.json' : `home://${toPosix(client.configPath)}`;
  const content = desired.supported
    ? JSON.stringify({ hooks: Object.fromEntries(desired.events.map((event) => [event, [{ hooks: [{ type: 'command', command: desired.command, timeout: 5 }] }]])) }, null, 2)
    : '';
  return {
    format: 'json',
    configRef,
    applyMode: 'manual-copy',
    content,
    warning: desired.supported
      ? 'Preview only. OAF hook commands are read-only and do not grant authority or write memory.'
      : 'This harness has no OAF hook snippet yet; use the read-only MCP bridge.'
  };
}

function harnessManualConfigSnippet({ client, server, bridgeMode = 'resources', configRef }) {
  const desired = desiredHarnessServerSummary(server, { bridgeMode });
  const serverConfig = {
    command: desired.command,
    args: desired.args
  };
  let content;
  if (client.format === 'toml') {
    const args = desired.args.map((item) => `"${item}"`).join(', ');
    content = `[mcp_servers.${server}]\ncommand = "${desired.command}"\nargs = [${args}]`;
  } else if (client.format === 'yaml') {
    content = [
      'mcpServers:',
      `  ${server}:`,
      `    command: ${desired.command}`,
      '    args:',
      ...desired.args.map((item) => `      - ${item}`)
    ].join('\n');
  } else {
    content = JSON.stringify({ mcpServers: { [server]: serverConfig } }, null, 2);
  }
  return {
    format: client.format,
    configRef,
    applyMode: 'manual-copy',
    content,
    warning: 'Preview only. Review and paste manually; OAF does not write home config files.'
  };
}

function classifyHarnessServer(server, { bridgeMode = 'resources' } = {}) {
  if (!server) return 'absent';
  const binaryArgs = bridgeMode === 'token-saver' ? OAF_MCP_TOKEN_SAVER_BINARY_ARGS : OAF_MCP_RESOURCE_BINARY_ARGS;
  if (isOafServerInvocation(server, binaryArgs)) return 'installed';
  return 'drifted';
}

function extractHarnessServers(parsed) {
  const source = parsed?.mcpServers ?? parsed?.mcp_servers ?? {};
  if (!source || typeof source !== 'object' || Array.isArray(source)) return new Map();
  return new Map(Object.entries(source).filter(([name, value]) => /^[A-Za-z0-9._-]{1,80}$/.test(name) && value && typeof value === 'object' && !Array.isArray(value)));
}

function parseHarnessConfig(text, format) {
  try {
    if (format === 'json') return JSON.parse(text);
    if (format === 'jsonc') return JSON.parse(stripJsonComments(text));
    if (format === 'toml') return parseHarnessToml(text);
    if (format === 'yaml') return parseHarnessYaml(text);
  } catch {
    throw new Error(`harness config parse failed for ${format}: invalid syntax`);
  }
  throw new Error(`unsupported harness config format: ${format}`);
}

function emptyHarnessConfig(format) {
  return format === 'toml' ? { mcp_servers: {} } : { mcpServers: {} };
}

function parseHarnessToml(text) {
  const result = { mcp_servers: {} };
  let current = null;
  for (const rawLine of text.split(/\r\n|\r|\n/u)) {
    const line = rawLine.replace(/#.*$/u, '').trim();
    if (!line) continue;
    const section = /^\[mcp_servers\.([A-Za-z0-9_-]{1,80})\]$/u.exec(line);
    if (section) {
      current = section[1];
      result.mcp_servers[current] ??= {};
      continue;
    }
    if (/^\[\[[^\]]+\]\]$/u.test(line) || /^\[[^\]]+\]$/u.test(line)) {
      current = null;
      continue;
    }
    if (!current) {
      if (/^[A-Za-z0-9_.-]+\s*=\s*.+$/u.test(line) || /^"([^"\\]|\\.)+"\s*=\s*.+$/u.test(line)) continue;
      throw new Error('unsupported top-level statement');
    }
    const entry = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/u.exec(line);
    if (!entry) throw new Error('invalid key-value statement');
    const [, key, rawValue] = entry;
    if (!['command', 'args'].includes(key)) continue;
    result.mcp_servers[current][key] = parseTomlValue(rawValue);
  }
  return result;
}

function parseTomlValue(rawValue) {
  const value = rawValue.trim();
  if (/^"([^"\\]|\\.)*"$/u.test(value)) return JSON.parse(value);
  if (/^\[(.*)\]$/u.test(value)) {
    const body = value.slice(1, -1).trim();
    if (!body) return [];
    return body.split(',').map((part) => parseTomlValue(part.trim()));
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('unsupported TOML value');
}

function parseHarnessYaml(text) {
  const result = { mcpServers: {} };
  const lines = text.split(/\r\n|\r|\n/u);
  let inServers = false;
  let current = null;
  let collectingArgs = false;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+#.*$/u, '').trimEnd();
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (/^mcpServers:\s*$/u.test(line.trim())) {
      inServers = true;
      current = null;
      collectingArgs = false;
      continue;
    }
    if (!inServers) throw new Error('expected mcpServers root');
    const server = /^ {2}([A-Za-z0-9._-]{1,80}):\s*$/u.exec(line);
    if (server) {
      current = server[1];
      result.mcpServers[current] = {};
      collectingArgs = false;
      continue;
    }
    if (!current) throw new Error('expected server name');
    const command = /^ {4}command:\s*["']?([^"']+)["']?\s*$/u.exec(line);
    if (command) {
      result.mcpServers[current].command = command[1];
      collectingArgs = false;
      continue;
    }
    if (/^ {4}args:\s*$/u.test(line)) {
      result.mcpServers[current].args = [];
      collectingArgs = true;
      continue;
    }
    const arg = /^ {6}-\s*["']?([^"']+)["']?\s*$/u.exec(line);
    if (arg && collectingArgs) {
      result.mcpServers[current].args.push(arg[1]);
      continue;
    }
    throw new Error('unsupported YAML statement');
  }
  return result;
}

function stripJsonComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/.*$/gmu, '$1');
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
