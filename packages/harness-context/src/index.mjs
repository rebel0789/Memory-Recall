import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  COMPILER_VERSION,
  compileContext,
  contextSelectionPolicyFingerprint,
  estimateTokens,
  hashRef,
  stableStringify
} from '../../context-compiler/src/index.mjs';
import { assertJsonSchema } from '../../protocol/src/schema-validator.mjs';
import contextPackRegistryStatusSchema from '../../protocol/schemas/context-pack-registry-status.schema.json' with { type: 'json' };
import contextPackSchema from '../../protocol/schemas/context-pack.schema.json' with { type: 'json' };
import contextPackUsePlanSchema from '../../protocol/schemas/context-pack-use-plan.schema.json' with { type: 'json' };
import harnessContextPreviewSchema from '../../protocol/schemas/harness-context-preview.schema.json' with { type: 'json' };
import harnessContextSourceSchema from '../../protocol/schemas/harness-context-source.schema.json' with { type: 'json' };
import {
  DEFAULT_SOURCE_GRAPH_PREVIEW_MAX_FILE_BYTES,
  buildSourceGraphPreview
} from '../../source-graph/src/index.mjs';

export const CONTEXT_PACK_VERSION = '0.1.0';
export const CONTEXT_PACK_USE_PLAN_VERSION = '0.1.0';
export const CONTEXT_PACK_REGISTRY_VERSION = '0.1.0';
export const HARNESS_CONTEXT_SCANNER_VERSION = '0.1.0';
export const HARNESS_CONTEXT_PREVIEW_VERSION = '0.1.0';
export const HARNESS_CONTEXT_BENCHMARK_VERSION = '0.1.0';
export const HARNESS_SETUP_PLANNER_VERSION = '0.1.0';

const DEFAULT_MAX_BYTES = 65_536;
const DEFAULT_CHANGED_HASH_MAX_BYTES = 262_144;
const DEFAULT_SOURCE_GRAPH_MAX_FILE_BYTES = DEFAULT_SOURCE_GRAPH_PREVIEW_MAX_FILE_BYTES;
const MAX_SOURCE_GRAPH_FILE_BYTES = 1024 * 1024;
const MAX_USER_SELECTED_FILES = 16;
const MAX_CHANGED_LOCATORS = 16;
const MARKDOWN_SELECTED_LIMIT = 16;
const MARKDOWN_REQUIRED_READ_LIMIT = 16;
const MARKDOWN_BULK_LIMIT = 2;
const GIT_STATUS_TIMEOUT_MS = 2_000;
const GIT_STATUS_MAX_BUFFER = 256 * 1024;
const SUPPORTED_HARNESSES = new Set(['codex', 'claude-code', 'cursor']);
const SUPPORTED_TARGET_HARNESSES = new Set(['codex', 'claude-code', 'cursor', 'generic']);
const FORBIDDEN_USER_SELECTED_ROOTS = new Set(['.git', '.local', 'node_modules']);
const CONTROL_BYTES = new Set([...Array.from({ length: 9 }, (_, index) => index), 11, 12, ...Array.from({ length: 18 }, (_, index) => index + 14)]);
const SECRET_LIKE = /\b(?:authorization\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|(?:Bearer|Basic|Digest|Token)\s+[^\s"'`,;)]+|[^\s"'`,;)]+)|(?:api[_-]?key|token|secret|password)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"'`,;)]+))/giu;
const LOCAL_FILE_PATH = /\/Users\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._ -]+)+/gu;
const LOCAL_USER_ROOT = /\/Users\/[A-Za-z0-9._-]+(?=$|[\s"'`,;).])/gu;
const HANDOFF_ABSOLUTE_PATH = /(?:\/home\/[A-Za-z0-9._-]+(?:\/[^\s"'`,;).]+)+|[A-Za-z]:\\[^\s"'`,;]+(?:\\[^\s"'`,;]+)+)/gu;
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

function assertSafeHandoffField(value, fieldName) {
  const text = String(value ?? '');
  const secretCount = countMatches(text, SECRET_LIKE);
  const localPathCount = countMatches(text, LOCAL_FILE_PATH)
    + countMatches(text, LOCAL_USER_ROOT)
    + countMatches(text, HANDOFF_ABSOLUTE_PATH);
  if (secretCount > 0 || localPathCount > 0) {
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

function changedLocatorUnavailable(reason) {
  return {
    contentHash: null,
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
  return {
    contentHash: hash(redactions.redacted),
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
  if (FORBIDDEN_USER_SELECTED_ROOTS.has(parts[0])) return true;
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
  clock = () => new Date().toISOString()
} = {}) {
  const generatedAt = clock();
  const limit = Math.max(0, Math.min(MAX_CHANGED_LOCATORS, Number.isInteger(maxLocators) ? maxLocators : MAX_CHANGED_LOCATORS));
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
    const limited = changedLocators.slice(0, limit);
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
    addRead(requiredReadItem({
      locator,
      role: 'explicit_user_selected',
      required: true,
      represented: Boolean(source),
      contentHash: source?.contentHash ?? null,
      reasonCodes: [
        'explicit_user_file',
        'read_before_handoff',
        source?.contentHash ? 'content_hash_verified' : 'content_hash_unavailable'
      ],
      readHint: `Read ${locator} from the local workspace because it was explicitly included for this handoff.`
    }));
  }

  for (const locator of sourceGraph.impact.changedLocators) {
    const selectedMatch = selected.find((item) => stripLineRange(item.locator) === locator);
    const metadata = changedLocatorMetadata.get(locator) ?? changedLocatorUnavailable('content_hash_unavailable');
    const contentHash = selectedMatch?.contentHash ?? metadata.contentHash ?? null;
    const hashReasonCodes = contentHash && selectedMatch?.contentHash
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
    'npm --silent run oaf -- mcp resources --read-only --stdio',
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
    readHint: `Inspect ${item.locator} because it may be affected by ${changedLocators.join(', ')}.`
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
      maxFiles: 200,
      maxFileBytes: graphMaxFileBytes,
      clock: () => createdAt
    });
    const results = compactSourceGraphResults(preview.search.results);
    const warnings = [];
    if (!results.length) warnings.push('source_graph_no_locator_matches');
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
  const selectedOmitted = markdownOmittedLine(omittedCount(pack.readFirst, MARKDOWN_SELECTED_LIMIT), 'read-first locator rows');
  const requiredOmitted = markdownOmittedLine(omittedCount(requiredLocalReads, MARKDOWN_REQUIRED_READ_LIMIT), 'required utility-read rows');
  const excludedOmitted = markdownOmittedLine(omittedCount(pack.excluded, MARKDOWN_BULK_LIMIT), 'excluded-context rows');
  const omissionRefsOmitted = markdownOmittedLine(omittedCount(pack.omissions.refs, MARKDOWN_BULK_LIMIT), 'omission-ref rows');
  const sourceGraphOmitted = markdownOmittedLine(omittedCount(pack.sourceGraph.results, MARKDOWN_BULK_LIMIT), 'source-graph hint rows');
  const affectedSymbolsOmitted = markdownOmittedLine(omittedCount(pack.sourceGraph.impact.affectedSymbols, MARKDOWN_BULK_LIMIT), 'affected-symbol rows');
  const commandOmitted = markdownOmittedLine(omittedCount(pack.handoff.commands, verificationCommands.length), 'verification commands');
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
    commandOmitted,
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
    maxFileBytes: sourceGraphMaxFileBytes,
    createdAt: preview.createdAt
  });
  const changedLocatorMetadata = await inspectChangedLocators({
    root,
    changedLocators: sourceGraph.impact.changedLocators,
    maxBytes
  });
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
  const plan = {
    schemaVersion: '1.0.0',
    usePlanVersion: CONTEXT_PACK_USE_PLAN_VERSION,
    id: `ctxuse_${idDigest(stableStringify({
      contextPackId: pack?.id,
      contextPackFingerprint: pack?.contextPackFingerprint,
      resourceUri,
      requiredLocalReads
    }))}`,
    workspaceId: pack?.workspaceId ?? 'ws_local',
    generatedAt,
    targetHarness: pack?.targetHarness ?? 'generic',
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
  const relativePath = sourceRelativePath(item?.locator);
  if (!relativePath || !item?.contentHash) {
    return {
      locator: item?.locator ?? null,
      role: item?.role ?? null,
      expectedHash: item?.contentHash ?? null,
      actualHash: null,
      status: 'unavailable',
      reasonCodes: ['source_hash_unavailable']
    };
  }
  const metadata = await inspectChangedLocator({
    root: rootReal,
    rootReal,
    locator: `workspace://${relativePath}`,
    maxBytes: DEFAULT_CHANGED_HASH_MAX_BYTES
  });
  if (!metadata.contentHash) {
    return {
      locator: item.locator,
      role: item.role,
      expectedHash: item.contentHash,
      actualHash: null,
      status: 'unavailable',
      reasonCodes: metadata.reasonCodes
    };
  }
  const status = metadata.contentHash === item.contentHash ? 'verified' : 'stale';
  return {
    locator: item.locator,
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
  const pointerFingerprintStatus = currentPointer
    ? (currentPointer.pointerFingerprint === currentPointerFingerprint(currentPointer) ? 'verified' : 'tampered')
    : 'missing';
  const entries = [];
  for (const entry of registry?.entries ?? []) entries.push(await verifyRegistryEntry(rootReal, entry));
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
  if (status.current.status === 'tampered' || status.current.status === 'missing') return null;
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
    args: ['--silent', 'run', 'oaf', '--', 'mcp', 'resources', '--read-only', '--stdio'],
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
    arraysEqual(server.args, ['--silent', 'run', 'oaf', '--', 'mcp', 'resources', '--read-only', '--stdio'])
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
