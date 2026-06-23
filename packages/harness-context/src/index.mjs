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
import harnessContextPreviewSchema from '../../protocol/schemas/harness-context-preview.schema.json' with { type: 'json' };
import harnessContextSourceSchema from '../../protocol/schemas/harness-context-source.schema.json' with { type: 'json' };

export const HARNESS_CONTEXT_SCANNER_VERSION = '0.1.0';
export const HARNESS_CONTEXT_PREVIEW_VERSION = '0.1.0';
export const HARNESS_CONTEXT_BENCHMARK_VERSION = '0.1.0';

const DEFAULT_MAX_BYTES = 65_536;
const SUPPORTED_HARNESSES = new Set(['codex', 'claude-code', 'cursor']);
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

async function scanSource({ root, rootReal, harness, definition, workspaceId, maxBytes, createdAt, includeRedactedText = false }) {
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
  workspaceId = 'ws_local',
  objective,
  step,
  tokenBudget = 4096,
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
    workspaceId,
    maxBytes,
    clock: () => createdAt
  });
  const records = harnessSourcesToContextRecords(scan);
  const byRecordId = new Map(records.map((record) => [record.id, record]));
  const request = {
    schemaVersion: '1.0.0',
    id: previewRequestId({ workspaceId, objective, step }),
    requestId: previewRequestId({ workspaceId, objective, step }),
    workspaceId,
    objective,
    step,
    requiredIds: [],
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
