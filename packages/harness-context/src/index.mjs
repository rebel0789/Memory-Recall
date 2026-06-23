import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { assertJsonSchema } from '../../protocol/src/schema-validator.mjs';
import harnessContextSourceSchema from '../../protocol/schemas/harness-context-source.schema.json' with { type: 'json' };

export const HARNESS_CONTEXT_SCANNER_VERSION = '0.1.0';

const DEFAULT_MAX_BYTES = 65_536;
const SUPPORTED_HARNESSES = new Set(['codex', 'claude-code', 'cursor']);
const CONTROL_BYTES = new Set([...Array.from({ length: 9 }, (_, index) => index), 11, 12, ...Array.from({ length: 18 }, (_, index) => index + 14)]);
const SECRET_LIKE = /\b(?:authorization\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|(?:Bearer|Basic|Digest|Token)\s+[^\s"'`,;)]+|[^\s"'`,;)]+)|(?:api[_-]?key|token|secret|password)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"'`,;)]+))/giu;
const LOCAL_FILE_PATH = /\/Users\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._ -]+)*\/[A-Za-z0-9._ -]+\.[A-Za-z0-9]{1,16}/gu;
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

function isEscapedRelative(relativePath) {
  return relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath);
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
  return `${harness} ${sourceKind} ${workspaceLocator(relativePath)} ${counts}`.slice(0, 240);
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

function skippedSource(harness, relativePath, reason) {
  return { harness, locator: workspaceLocator(relativePath), reason };
}

async function scanSource({ root, rootReal, harness, definition, workspaceId, maxBytes, createdAt }) {
  const relativePath = toPosix(definition.relativePath);
  const absolutePath = path.resolve(root, definition.relativePath);
  const declaredRelative = path.relative(root, absolutePath);
  if (isEscapedRelative(declaredRelative)) return { skipped: skippedSource(harness, relativePath, 'symlink_escape') };

  try {
    await lstat(absolutePath);
  } catch {
    return null;
  }

  let realPath;
  try {
    realPath = await realpath(absolutePath);
  } catch {
    return { skipped: skippedSource(harness, relativePath, 'unsupported_file') };
  }

  const realRelative = path.relative(rootReal, realPath);
  if (isEscapedRelative(realRelative)) return { skipped: skippedSource(harness, relativePath, 'symlink_escape') };

  const info = await stat(realPath);
  if (!info.isFile()) return { skipped: skippedSource(harness, relativePath, 'unsupported_file') };
  if (info.size > maxBytes) return { skipped: skippedSource(harness, relativePath, 'oversized') };

  const bodyBuffer = await readFile(realPath);
  if (isControlCharacterBuffer(bodyBuffer)) return { skipped: skippedSource(harness, relativePath, 'binary') };

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
      locator: workspaceLocator(relativePath),
      contentHash,
      byteSize: info.size
    },
    reviewStatus: 'scan-only',
    retention: 'workspace',
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
  return { source };
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

export async function scanHarnessContext({
  root = process.cwd(),
  harnesses = ['codex', 'claude-code', 'cursor'],
  workspaceId = 'ws_local',
  maxBytes = DEFAULT_MAX_BYTES,
  clock = () => new Date().toISOString()
} = {}) {
  const resolvedRoot = path.resolve(root);
  const rootReal = await realpath(resolvedRoot);
  const createdAt = clock();
  const sources = [];
  const skipped = [];

  for (const harness of selectedHarnesses(harnesses)) {
    const harnessSources = await sourceDefinitions(resolvedRoot, rootReal, harness);
    skipped.push(...harnessSources.skipped);
    for (const definition of harnessSources.definitions) {
      const result = await scanSource({ root: resolvedRoot, rootReal, harness, definition, workspaceId, maxBytes, createdAt });
      if (result?.source) sources.push(result.source);
      if (result?.skipped) skipped.push(result.skipped);
    }
  }

  sources.sort((left, right) => `${left.harness}:${left.provenance.locator}`.localeCompare(`${right.harness}:${right.provenance.locator}`));
  skipped.sort((left, right) => `${left.harness}:${left.locator}`.localeCompare(`${right.harness}:${right.locator}`));

  return {
    schemaVersion: '1.0.0',
    scannerVersion: HARNESS_CONTEXT_SCANNER_VERSION,
    workspaceId,
    rootFingerprint: hash(`workspace:${workspaceId}:harness-context-root`),
    summary: {
      totalAccepted: sources.length,
      totalSkipped: skipped.length,
      externalAdaptersEnabled: 0,
      externalWritesEnabled: false
    },
    sources,
    skipped
  };
}
