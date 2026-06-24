import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  COMPILER_VERSION,
  compileContext,
  contextSelectionPolicyFingerprint,
  estimateTokens,
  hashRef,
  stableStringify
} from '../../context-compiler/src/index.mjs';
import { assertJsonSchema } from '../../protocol/src/schema-validator.mjs';
import contextPackSchema from '../../protocol/schemas/context-pack.schema.json' with { type: 'json' };
import harnessContextPreviewSchema from '../../protocol/schemas/harness-context-preview.schema.json' with { type: 'json' };
import harnessContextSourceSchema from '../../protocol/schemas/harness-context-source.schema.json' with { type: 'json' };
import { buildSourceGraphPreview } from '../../source-graph/src/index.mjs';

export const CONTEXT_PACK_VERSION = '0.1.0';
export const HARNESS_CONTEXT_SCANNER_VERSION = '0.1.0';
export const HARNESS_CONTEXT_PREVIEW_VERSION = '0.1.0';
export const HARNESS_CONTEXT_BENCHMARK_VERSION = '0.1.0';
export const HARNESS_SETUP_PLANNER_VERSION = '0.1.0';

const DEFAULT_MAX_BYTES = 65_536;
const MAX_USER_SELECTED_FILES = 16;
const MAX_CHANGED_LOCATORS = 16;
const SUPPORTED_HARNESSES = new Set(['codex', 'claude-code', 'cursor']);
const SUPPORTED_TARGET_HARNESSES = new Set(['codex', 'claude-code', 'cursor', 'generic']);
const FORBIDDEN_USER_SELECTED_ROOTS = new Set(['.git', '.local', 'node_modules']);
const CONTROL_BYTES = new Set([...Array.from({ length: 9 }, (_, index) => index), 11, 12, ...Array.from({ length: 18 }, (_, index) => index + 14)]);
const SECRET_LIKE = /\b(?:authorization\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|(?:Bearer|Basic|Digest|Token)\s+[^\s"'`,;)]+|[^\s"'`,;)]+)|(?:api[_-]?key|token|secret|password)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"'`,;)]+))/giu;
const LOCAL_FILE_PATH = /\/Users\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._ -]+)+/gu;
const LOCAL_USER_ROOT = /\/Users\/[A-Za-z0-9._-]+(?=$|[\s"'`,;).])/gu;

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
  const localPathCount = filePaths.count + rootPaths.count;
  const reasonCodes = [];
  if (secretCount > 0) reasonCodes.push('secret_like_value');
  if (localPathCount > 0) reasonCodes.push('local_path');
  return { redacted: rootPaths.redacted, secretCount, localPathCount, reasonCodes };
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

async function sourceDefinitions(root, rootReal, harness) {
  const definitions = [...(STATIC_PROJECT_SOURCES[harness] ?? [])];
  const skipped = [];
  if (harness === 'cursor') {
    const cursorRules = await cursorRuleDefinitions(root, rootReal);
    definitions.push(...cursorRules.definitions);
    skipped.push(...cursorRules.skipped);
  }
  return { definitions, skipped };
}

function skippedSource(harness, relativePath, reason, locatorScheme = 'workspace') {
  return {
    harness,
    locator: `${locatorScheme === 'user-selected' ? 'user-selected' : 'workspace'}://${toPosix(relativePath)}`,
    reason
  };
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

async function scanSource({ root, rootReal, harness, definition, workspaceId, maxBytes, createdAt, includeRedactedText = false }) {
  const relativePath = toPosix(definition.relativePath);
  const locator = sourceLocator(definition);
  const absolutePath = path.resolve(root, definition.relativePath);
  const declaredRelative = path.relative(root, absolutePath);
  if (isEscapedRelative(declaredRelative)) return { skipped: skippedSource(harness, relativePath, 'symlink_escape', definition.locatorScheme) };

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
  if (info.size > maxBytes) return { skipped: skippedSource(harness, relativePath, 'oversized', definition.locatorScheme) };

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
  workspaceId = 'ws_local',
  maxBytes = DEFAULT_MAX_BYTES,
  clock = () => new Date().toISOString()
} = {}, { includeRedactedText = false } = {}) {
  const resolvedRoot = path.resolve(root);
  const rootReal = await realpath(resolvedRoot);
  const createdAt = clock();
  const accepted = [];
  const skipped = [];

  for (const harness of selectedHarnesses(harnesses)) {
    const harnessSources = await sourceDefinitions(resolvedRoot, rootReal, harness);
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
  if (sourceKind === 'instruction' || sourceKind === 'rule') return 'governance';
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
  const manifest = compileContext(request, records);
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

function decisionForPack(item, targetHarness) {
  return {
    id: item.id,
    locator: item.locator,
    harness: item.harness,
    sourceKind: item.sourceKind,
    tokens: item.tokens,
    score: item.score,
    reasonCodes: item.reasonCodes,
    contentHash: item.contentHash,
    readHint: item.locator
      ? `Read ${item.locator} from the local workspace before acting in ${targetHarness}.`
      : `Use ${item.id} only as sanitized context metadata.`
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
  const affectedSymbols = (impact?.affectedSymbols ?? []).slice(0, 12).map((item) => ({
    name: item.name,
    symbolKind: item.symbolKind ?? 'symbol',
    locator: item.locator,
    depth: Number(item.depth ?? 0),
    reasonCodes: Array.isArray(item.reasonCodes) && item.reasonCodes.length ? item.reasonCodes : ['changed_locator_impact'],
    readHint: `Inspect ${item.locator} because it may be affected by ${changedLocators.join(', ')}.`
  }));
  return {
    changedLocators,
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
  createdAt
}) {
  const query = sourceGraphPackQuery({ objective, step });
  const normalizedChangedLocators = normalizeChangedLocators(changedLocators);
  const queryFingerprint = hashRef(stableStringify({ query, changedLocators: normalizedChangedLocators, limit: 12, offset: 0 }));
  try {
    const preview = await buildSourceGraphPreview({
      root,
      workspaceId,
      query,
      changedLocators: normalizedChangedLocators,
      limit: 12,
      sampleLimit: 1,
      maxFiles: 200,
      clock: () => createdAt
    });
    const results = compactSourceGraphResults(preview.search.results);
    const warnings = [];
    if (!results.length) warnings.push('source_graph_no_locator_matches');
    if (preview.graph.diagnostics.length) warnings.push('source_graph_diagnostics_present');
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

function requiredLocatorsForTarget(targetHarness) {
  if (targetHarness === 'codex') return ['workspace://AGENTS.md'];
  if (targetHarness === 'claude-code') return ['workspace://AGENTS.md', 'workspace://CLAUDE.md'];
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

export function renderContextPackMarkdown(pack) {
  const selectedRows = pack.readFirst.map((item) => `| ${markdownEscape(item.locator)} | ${markdownEscape(item.harness)} | ${item.tokens} | ${markdownEscape(item.reasonCodes.join(', '))} |`).join('\n');
  const excludedRows = pack.excluded.map((item) => `| ${markdownEscape(item.locator)} | ${markdownEscape(item.harness)} | ${item.tokens} | ${markdownEscape(item.reasonCodes.join(', '))} |`).join('\n');
  const omissionRows = pack.omissions.refs.map((item) => `| ${markdownEscape(item.id)} | ${markdownEscape(item.locator)} | ${item.tokens} | ${markdownEscape(item.reasonCodes.join(', '))} |`).join('\n');
  const sourceGraphRows = pack.sourceGraph.results.map((item) => `| ${markdownEscape(item.locator)} | ${markdownEscape(item.kind)} | ${markdownEscape(item.label)} | ${item.score} | ${markdownEscape(item.reasonCodes.join(', '))} |`).join('\n');
  const changedLocatorRows = pack.sourceGraph.impact.changedLocators.map((locator) => `| ${markdownEscape(locator)} | explicit_user_input |`).join('\n');
  const affectedSymbolRows = pack.sourceGraph.impact.affectedSymbols.map((item) => `| ${markdownEscape(item.locator)} | ${markdownEscape(item.symbolKind)} | ${markdownEscape(item.name)} | ${item.depth} | ${markdownEscape(item.reasonCodes.join(', '))} |`).join('\n');
  const deliveryLines = pack.delivery ? [
    '## Delivery Budget',
    '',
    `Representation: ${pack.delivery.representation}`,
    `Source candidate tokens: ${pack.delivery.sourceCandidateTokenCount}`,
    `Source selected tokens: ${pack.delivery.sourceSelectedTokenCount}`,
    `Delivered handoff tokens: ${pack.delivery.deliveredTokenCount}`,
    `Delivered token ratio: ${pack.delivery.deliveredTokenRatio}`,
    `Observed token reduction: ${pack.delivery.observedTokenReductionRatio}`,
    `Embedded source-content tokens: ${pack.delivery.sourceContentTokenCountIncluded}`,
    ''
  ] : [];
  return [
    '# Context Pack',
    '',
    `Target harness: ${pack.targetHarness}`,
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
    '## Instructions',
    '',
    bulletList(pack.handoff.instructions),
    '',
    '## Read First',
    '',
    '| Locator | Harness | Tokens | Reasons |',
    '| --- | --- | ---: | --- |',
    selectedRows || '| none | none | 0 | none |',
    '',
    ...deliveryLines,
    '## Excluded',
    '',
    '| Locator | Harness | Tokens | Reasons |',
    '| --- | --- | ---: | --- |',
    excludedRows || '| none | none | 0 | none |',
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
    '',
    '## Source Graph Hints',
    '',
    `Status: ${pack.sourceGraph.status}`,
    `Graph database used: ${pack.sourceGraph.safeguards.graphDatabaseUsed ? 'yes' : 'no'}`,
    `Source slices included: ${pack.sourceGraph.safeguards.sourceSlicesRead ? 'yes' : 'no'}`,
    pack.sourceGraph.summary
      ? `Graph summary: ${pack.sourceGraph.summary.fileCount} files, ${pack.sourceGraph.summary.symbolCount} symbols, ${pack.sourceGraph.summary.edgeCount} edges`
      : 'Graph summary: unavailable',
    '',
    '| Locator | Kind | Label | Score | Reasons |',
    '| --- | --- | --- | ---: | --- |',
    sourceGraphRows || '| none | none | none | 0 | none |',
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
    '',
    '## Warnings',
    '',
    bulletList(pack.warnings),
    '',
    '## Verification',
    '',
    bulletList(pack.handoff.commands),
    '',
    '## Fingerprints',
    '',
    `Preview: ${pack.preview.previewFingerprint}`,
    `Selection: ${pack.preview.resultFingerprint}`,
    ''
  ].join('\n');
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
  clock = () => new Date().toISOString()
} = {}) {
  const normalizedTarget = normalizeTargetHarness(targetHarness);
  const normalizedChangedLocators = normalizeChangedLocators(changedLocators);
  const preview = await buildHarnessContextPreview({
    root,
    harnesses,
    userSelectedFiles,
    workspaceId,
    objective,
    step,
    tokenBudget,
    requiredLocators: requiredLocatorsForTarget(normalizedTarget),
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
    createdAt: preview.createdAt
  });
  const omissions = buildOmissions({ excluded, sourceGraph, targetHarness: normalizedTarget });
  const pack = {
    schemaVersion: '1.0.0',
    packVersion: CONTEXT_PACK_VERSION,
    id: `ctxpack_${idDigest(stableStringify({
      workspaceId,
      targetHarness: normalizedTarget,
      objective,
      step,
      previewFingerprint: preview.previewFingerprint,
      sourceGraphFingerprint: sourceGraph.graphFingerprint,
      sourceGraphQueryFingerprint: sourceGraph.queryFingerprint,
      changedLocators: sourceGraph.impact.changedLocators
    }))}`,
    workspaceId,
    createdAt: preview.createdAt,
    dryRun: true,
    targetHarness: normalizedTarget,
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
    warnings: [...new Set([...packWarnings(preview), ...sourceGraph.warnings])].sort(),
    handoff: {
      title: `${normalizedTarget} context handoff`,
      summary: `Selected ${selected.length} of ${preview.candidates.totalCount} safe workspace context records for ${objective}.`,
      instructions: harnessInstructions(normalizedTarget),
      commands: [
        'npm run doctor',
        'npm run oaf -- context preview --from all --root . --objective "<objective>" --step "<step>" --dry-run',
        'npm run ci'
      ],
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
  generatedAt = new Date().toISOString()
}) {
  const normalizedAction = normalizeHarnessSetupAction(action);
  const normalizedClient = normalizeHarnessSetupClient(client);
  const normalizedServer = normalizeHarnessSetupServer(server);
  const selectedConfigPath = configPath ?? normalizedClient.configPath;
  const config = await readHomeConfig(home, selectedConfigPath);
  const parsed = config.exists ? parseHarnessConfig(config.text, normalizedClient.format) : emptyHarnessConfig(normalizedClient.format);
  const servers = extractHarnessServers(parsed);
  const serverState = classifyHarnessServer(servers.get(normalizedServer));
  const operations = harnessSetupOperations({ action: normalizedAction, server: normalizedServer, serverState });
  const report = {
    schemaVersion: '1.0.0',
    plannerVersion: HARNESS_SETUP_PLANNER_VERSION,
    command: `harness setup ${normalizedAction}`,
    dryRun: true,
    generatedAt,
    client: normalizedClient.id,
    clientLabel: normalizedClient.label,
    server: normalizedServer,
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
    desiredServer: desiredHarnessServerSummary(normalizedServer),
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

function harnessSetupOperations({ action, server, serverState }) {
  if (action === 'status') return [];
  if (action === 'plan') {
    if (serverState === 'installed') return [];
    return [{
      op: serverState === 'absent' ? 'add' : 'replace',
      target: `mcpServers.${server}`,
      before: serverState,
      after: 'read-only-oaf-mcp-stdio',
      summary: `${serverState === 'absent' ? 'add' : 'replace'} ${server} with read-only OAF MCP stdio resource bridge`
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

function desiredHarnessServerSummary(server) {
  return {
    name: server,
    transport: 'stdio',
    command: 'npm',
    args: ['run', 'oaf', '--', 'mcp', 'resources', '--read-only', '--stdio'],
    environmentKeys: [],
    resourceMode: 'read-only',
    externalWrites: false
  };
}

function classifyHarnessServer(server) {
  if (!server) return 'absent';
  if (
    server.command === 'npm' &&
    Array.isArray(server.args) &&
    arraysEqual(server.args, ['run', 'oaf', '--', 'mcp', 'resources', '--read-only', '--stdio'])
  ) return 'installed';
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
