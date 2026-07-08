import { createHash } from 'node:crypto';

const REPORT_VERSION = '1.0.0';
const SAFE_TARGET = /^[A-Za-z0-9._~!$&'()*+,;=:@%/\[\]-]+$/;
const ACCEPTED_PROFILE_STATUSES = new Set(['active']);
const PENDING_PROPOSAL_STATUSES = new Set(['proposed', 'quarantined']);
const SEARCH_STATUSES = new Set(['active', 'verified']);
const MEMORY_KINDS = new Set(['fact', 'preference', 'decision', 'episode', 'procedure', 'constraint']);
const MEMORY_SOURCE_ROLES = new Set(['memory-index', 'memory-file', 'harness-profile', 'workspace-note']);
const SAFE_MEMORY_ID = /^mem_[A-Za-z0-9._-]{1,128}$/;
const SAFE_TEXT_TOKEN = /^[A-Za-z0-9._:@-]{1,256}$/;
const SAFE_HASH = /^sha256:[a-f0-9]{64}$/;
const CLAUDE_CODE_INDEX_LINE_CAP = 200;
const CLAUDE_CODE_INDEX_BYTE_CAP = 25 * 1024;
const CLAUDE_CODE_SELECTION_REVIEW_LIMIT = 5;
const SOURCE_DIAGNOSTIC_COUNT_MAX = 10_000_000;
const STALE_MEMORY_SOURCE_DAYS = 1;
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/g,
  /AKIA[0-9A-Z]{16}/g,
  /gho_[A-Za-z0-9_]{20,}/g,
  /\b[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION|PRIVATE[_-]?KEY|DATABASE_URL|DB_URL|CONNECTION_STRING)\s*=\s*[^,\s]+/gi,
  /\b(?:token|secret|password|authorization|api[_-]?key|database_url|db_url|connection_string)\s*=\s*[^,\s]+/gi
];
const LOCAL_PATH_PATTERNS = [
  /file:\/\/\/[^\s)'"<>]+/g,
  /workspace:\/\/\/[^\s)'"<>]+/g,
  /(?:^|[\s('"`])\/(?:Users|private|tmp|var\/folders|var\/tmp|Volumes)\/[^\s)'"<>]+/g,
  /\b[A-Za-z]:\\[^\s)'"<>]+/g
];

function hashJson(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function hashText(value) {
  return `sha256:${createHash('sha256').update(String(value ?? '')).digest('hex')}`;
}

function safeString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function safeTimestamp(value, fallback = '1970-01-01T00:00:00.000Z') {
  return typeof value === 'string' && value ? value : fallback;
}

function sortRecords(records) {
  return [...records].sort((left, right) => {
    const time = String(left.updatedAt ?? left.createdAt ?? '').localeCompare(String(right.updatedAt ?? right.createdAt ?? ''));
    return time || String(left.id ?? '').localeCompare(String(right.id ?? ''));
  });
}

function redactedToken(prefix, value) {
  return `${prefix}_${createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 16)}`;
}

function unsafeProjection(value) {
  if (/(?:\/Users\/|\/private\/|\/tmp\/|\/var\/folders\/|\/var\/tmp\/|\/Volumes\/|file:\/\/\/|workspace:\/\/\/|\\|api[_-]?key=|database_url=|db_url=|connection_string=|token=|secret=|password=|authorization=)/i.test(String(value ?? ''))) return true;
  const { redactions } = redactMemoryText(value, { maxLength: 256 });
  return redactions.secretCount > 0 || redactions.localPathCount > 0;
}

function safeMemoryId(value) {
  const text = String(value ?? '');
  return SAFE_MEMORY_ID.test(text) && !unsafeProjection(text) ? text : redactedToken('mem_redacted', text);
}

function safeToken(value, prefix = 'redacted') {
  const text = String(value ?? '').trim();
  if (SAFE_TEXT_TOKEN.test(text) && !unsafeProjection(text)) return text;
  return redactedToken(prefix, text);
}

function safeTokenList(values, prefix) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => safeToken(value, prefix)))].sort();
}

function safeMemoryKind(value) {
  return MEMORY_KINDS.has(value) ? value : null;
}

function safeMemorySourceRole(value) {
  return MEMORY_SOURCE_ROLES.has(value) ? value : 'memory-file';
}

function safeSourceHash(value) {
  return SAFE_HASH.test(String(value ?? '')) ? String(value) : null;
}

function safeCount(value, max = 1000000) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(max, Math.trunc(number)));
}

function safeIsoTimestamp(value) {
  const text = String(value ?? '');
  if (!text) return null;
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function ageDays(updatedAt, generatedAt) {
  const updated = Date.parse(updatedAt ?? '');
  const generated = Date.parse(generatedAt ?? '');
  if (!Number.isFinite(updated) || !Number.isFinite(generated)) return null;
  return Math.max(0, Math.floor((generated - updated) / 86400000));
}

function sourceRoleForPath(relativePath) {
  return String(relativePath ?? '').split('/').at(-1) === 'MEMORY.md' ? 'memory-index' : 'memory-file';
}

function isGeneratedMemorySourcePath(relativePath) {
  const normalized = String(relativePath ?? '').replace(/^\/+/u, '');
  return normalized === 'memory/profile.md' ||
    normalized.startsWith('memory/proposals/') ||
    normalized.startsWith('context-packs/') ||
    normalized.startsWith('.local/');
}

export function redactMemoryText(value, { maxLength = 320 } = {}) {
  let text = String(value ?? '');
  const redactions = { secretCount: 0, localPathCount: 0, reasonCodes: [] };
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, () => {
      redactions.secretCount += 1;
      return '[redacted-secret]';
    });
  }
  for (const pattern of LOCAL_PATH_PATTERNS) {
    text = text.replace(pattern, (match) => {
      redactions.localPathCount += 1;
      return match.startsWith(' ') ? ' [redacted-local-path]' : '[redacted-local-path]';
    });
  }
  if (redactions.secretCount) redactions.reasonCodes.push('secret_redacted');
  if (redactions.localPathCount) redactions.reasonCodes.push('local_path_redacted');
  const normalized = text.replace(/\s+/g, ' ').trim();
  return {
    text: normalized.length > maxLength ? `${normalized.slice(0, Math.max(0, maxLength - 1)).trim()}...` : normalized,
    redactions
  };
}

export function sanitizeMemorySource(value) {
  const original = String(value ?? '').trim();
  if (!original) return 'redacted-source';
  const { text, redactions } = redactMemoryText(original, { maxLength: 180 });
  if (redactions.secretCount || redactions.localPathCount) return 'redacted-source';
  if (/^(?:https?:|file:)/i.test(text)) return 'redacted-source';
  return text.slice(0, 180);
}

function safeTargetLocator(relativePath) {
  const target = String(relativePath ?? '').replace(/^\/+/, '');
  if (!target || target.includes('..') || !SAFE_TARGET.test(target)) throw new Error('memory report target path is unsupported');
  return `workspace://${target}`;
}

function profileTargetLocator(relativePath) {
  if (String(relativePath ?? '') !== 'memory/profile.md') throw new Error('memory profile target must be memory/profile.md');
  return safeTargetLocator(relativePath);
}

function proposalTargetLocator(directory, id) {
  if (String(directory ?? '').replace(/\/+$/, '') !== 'memory/proposals') throw new Error('memory proposal target directory must be memory/proposals');
  return safeTargetLocator(`memory/proposals/${id}.md`);
}

function evidenceIdsFor(record) {
  const ids = new Set(Array.isArray(record.evidenceIds) ? record.evidenceIds.map(String) : []);
  for (const event of Array.isArray(record.lifecycle) ? record.lifecycle : []) {
    for (const id of Array.isArray(event.evidenceIds) ? event.evidenceIds : []) ids.add(String(id));
  }
  return safeTokenList([...ids], 'ev_redacted');
}

function lifecycleState(record) {
  const events = Array.isArray(record.lifecycle) ? record.lifecycle : [];
  const latest = events.at(-1);
  return {
    status: safeString(record.status, 'unknown'),
    latestEvent: latest?.type ?? null,
    latestAt: latest?.at ?? record.updatedAt ?? record.createdAt ?? null
  };
}

function acceptedProfileRecord(record) {
  return safeMemoryKind(record.kind) && ACCEPTED_PROFILE_STATUSES.has(record.status) && record.dataClass !== 'secret' && record.text !== '[redacted-secret]';
}

function pendingProposalRecord(record) {
  return safeMemoryKind(record.kind) && PENDING_PROPOSAL_STATUSES.has(record.status);
}

function profileMarkdown(records, { workspaceId, generatedAt }) {
  const lines = [
    '# OAF Memory Profile',
    '',
    'Generated from accepted Open Agent Fabric memory records only.',
    'Editing this file does not create, update, activate, or delete canonical memory.',
    '',
    `Workspace: ${workspaceId}`,
    `Generated: ${generatedAt}`,
    ''
  ];
  const byKind = new Map();
  for (const record of records) {
    const kind = safeMemoryKind(record.kind);
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(record);
  }
  for (const kind of [...byKind.keys()].sort()) {
    lines.push(`## ${kind}`, '');
    for (const record of byKind.get(kind)) {
      const snippet = redactMemoryText(record.text, { maxLength: 500 }).text;
      const evidence = evidenceIdsFor(record);
      lines.push(`- ${snippet}`);
      lines.push(`  - id: ${safeMemoryId(record.id)}`);
      lines.push(`  - source: ${sanitizeMemorySource(record.source)}`);
      if (evidence.length) lines.push(`  - evidence: ${evidence.join(', ')}`);
      if (record.supersedes) lines.push(`  - supersedes: ${safeMemoryId(record.supersedes)}`);
    }
    lines.push('');
  }
  return `${lines.join('\n').trim()}\n`;
}

function proposalMarkdown(record, { generatedAt }) {
  const snippet = redactMemoryText(record.text, { maxLength: 1000 }).text;
  const evidence = evidenceIdsFor(record);
  const reasons = safeTokenList(record.reasons, 'reason_redacted');
  const diagnostics = memorySourceDiagnosticsForRecord(record, { generatedAt });
  const id = safeMemoryId(record.id);
  const lines = [
    `# Memory Proposal ${id}`,
    '',
    'Generated from OAF proposal state for review. Editing this report is not a canonical memory write.',
    '',
    `Generated: ${generatedAt}`,
    `Status: ${record.status}`,
    `Decision: ${record.decision ?? 'review'}`,
    `Kind: ${safeMemoryKind(record.kind)}`,
    `Source: ${sanitizeMemorySource(record.source)}`,
    `Reasons: ${reasons.join(', ') || 'none'}`,
    `Evidence: ${evidence.join(', ') || 'none'}`,
    `Source role: ${diagnostics.sourceRole}`,
    `Source lines: ${diagnostics.lineCount}`,
    `Source bytes: ${diagnostics.byteSize}`,
    `Source age days: ${diagnostics.ageDays ?? 'unknown'}`,
    `Source warnings: ${diagnostics.warnings.join(', ') || 'none'}`,
    '',
    '## Proposed Text',
    '',
    snippet || '[empty]'
  ];
  return `${lines.join('\n').trim()}\n`;
}

function safeguards({ localFilesWritten = 0 } = {}) {
  return {
    networkCalls: 0,
    modelCalls: 0,
    sourceSnapshotsWritten: 0,
    activeMemoryCreated: 0,
    canonicalStateMutated: false,
    externalWritesEnabled: false,
    externalAdaptersEnabled: 0,
    rawBodyIncluded: false,
    localFilesWritten
  };
}

function memorySourceDiagnosticsForRecord(record, { generatedAt }) {
  const metadata = record.metadata ?? {};
  const sourceUpdatedAt = safeIsoTimestamp(metadata.sourceUpdatedAt ?? record.updatedAt ?? record.createdAt);
  const sourceAgeDays = sourceUpdatedAt ? ageDays(sourceUpdatedAt, generatedAt) : null;
  const sourceRole = safeMemorySourceRole(metadata.sourceRole ?? sourceRoleForPath(metadata.sourceLocator ?? record.source));
  const lineCount = safeCount(metadata.sourceLineCount, SOURCE_DIAGNOSTIC_COUNT_MAX);
  const byteSize = safeCount(metadata.sourceByteSize, SOURCE_DIAGNOSTIC_COUNT_MAX);
  const warnings = new Set(safeTokenList(metadata.sourceWarnings, 'warning_redacted'));
  if (sourceRole === 'memory-index' && lineCount > CLAUDE_CODE_INDEX_LINE_CAP) warnings.add('memory_index_line_cap_risk');
  if (sourceRole === 'memory-index' && byteSize > CLAUDE_CODE_INDEX_BYTE_CAP) warnings.add('memory_index_byte_cap_risk');
  if (sourceAgeDays !== null && sourceAgeDays >= STALE_MEMORY_SOURCE_DAYS) warnings.add('stale_source');
  return {
    sourceLocator: sanitizeMemorySource(metadata.sourceLocator ?? record.source),
    sourceRole,
    sourceHash: safeSourceHash(metadata.sourceHash),
    lineCount,
    byteSize,
    sourceUpdatedAt,
    ageDays: sourceAgeDays,
    warnings: [...warnings].sort()
  };
}

function memoryImportDiagnostics(records, { generatedAt }) {
  const diagnostics = records.map((record) => memorySourceDiagnosticsForRecord(record, { generatedAt }));
  const warningCodes = [...new Set(diagnostics.flatMap((item) => item.warnings))].sort();
  const sourceCount = new Set(diagnostics.map((item) => item.sourceLocator)).size;
  const memoryIndexCount = diagnostics.filter((item) => item.sourceRole === 'memory-index').length;
  const staleSourceCount = diagnostics.filter((item) => item.warnings.includes('stale_source')).length;
  const indexCliffRiskCount = diagnostics.filter((item) => item.warnings.includes('memory_index_line_cap_risk') || item.warnings.includes('memory_index_byte_cap_risk')).length;
  const overSelectionLimit = sourceCount > CLAUDE_CODE_SELECTION_REVIEW_LIMIT;
  return {
    sourceCount,
    memoryIndexCount,
    staleSourceCount,
    indexCliffRiskCount,
    selectionReviewLimit: CLAUDE_CODE_SELECTION_REVIEW_LIMIT,
    warnings: [
      ...warningCodes,
      overSelectionLimit ? 'more_than_five_sources_review_required' : null
    ].filter(Boolean).sort(),
    items: diagnostics
  };
}

export function buildMemoryProfileReport({ records, workspaceId = 'ws_local', generatedAt = '1970-01-01T00:00:00.000Z', targetPath = 'memory/profile.md', dryRun = true, localFilesWritten = 0 } = {}) {
  if (!Array.isArray(records)) throw new Error('records must be an array');
  const workspaceRecords = records.filter((record) => record.workspaceId === workspaceId);
  const accepted = sortRecords(workspaceRecords.filter(acceptedProfileRecord));
  const markdown = profileMarkdown(accepted, { workspaceId, generatedAt });
  const contentHash = hashText(markdown);
  const reportBase = {
    schemaVersion: '1.0.0',
    reportVersion: REPORT_VERSION,
    workspaceId,
    generatedAt,
    dryRun: Boolean(dryRun),
    target: {
      locator: profileTargetLocator(targetPath),
      format: 'markdown'
    },
    summary: {
      acceptedCount: accepted.length,
      skippedCount: records.length - accepted.length,
      recordIds: accepted.map((record) => safeMemoryId(record.id)),
      contentHash
    },
    markdown,
    safeguards: safeguards({ localFilesWritten })
  };
  return {
    id: `memprofile_${hashJson(reportBase).slice(7, 23)}`,
    ...reportBase
  };
}

export function buildMemoryProposalsReport({ records, workspaceId = 'ws_local', generatedAt = '1970-01-01T00:00:00.000Z', targetDirectory = 'memory/proposals', dryRun = true, localFilesWritten = 0 } = {}) {
  if (!Array.isArray(records)) throw new Error('records must be an array');
  if (String(targetDirectory ?? '').replace(/\/+$/, '') !== 'memory/proposals') throw new Error('memory proposal target directory must be memory/proposals');
  const workspaceRecords = records.filter((record) => record.workspaceId === workspaceId);
  const proposals = sortRecords(workspaceRecords.filter(pendingProposalRecord));
  const items = proposals.map((record) => {
    const markdown = proposalMarkdown(record, { generatedAt });
    const id = safeMemoryId(record.id);
    const sourceDiagnostics = memorySourceDiagnosticsForRecord(record, { generatedAt });
    return {
      id,
      kind: safeMemoryKind(record.kind),
      status: record.status,
      decision: record.decision ?? (record.status === 'quarantined' ? 'reject' : 'review'),
      reasons: safeTokenList(record.reasons, 'reason_redacted'),
      source: sanitizeMemorySource(record.source),
      lifecycle: lifecycleState(record),
      evidenceIds: evidenceIdsFor(record),
      target: {
        locator: proposalTargetLocator(targetDirectory, id),
        format: 'markdown'
      },
      sourceDiagnostics,
      contentHash: hashText(markdown),
      markdown
    };
  });
  const diagnostics = memoryImportDiagnostics(proposals, { generatedAt });
  const reportBase = {
    schemaVersion: '1.0.0',
    reportVersion: REPORT_VERSION,
    workspaceId,
    generatedAt,
    dryRun: Boolean(dryRun),
    summary: {
      proposalCount: items.filter((item) => item.status === 'proposed').length,
      quarantinedCount: items.filter((item) => item.status === 'quarantined').length,
      skippedCount: records.length - items.length
    },
    diagnostics,
    items,
    safeguards: safeguards({ localFilesWritten })
  };
  return {
    id: `memprops_${hashJson(reportBase).slice(7, 23)}`,
    ...reportBase
  };
}

export function normalizeMemoryPathsConfig(config, { maxPaths = 32 } = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('memory config must be an object');
  const paths = config.memoryPaths;
  if (!Array.isArray(paths)) throw new Error('memoryPaths must be an array');
  if (paths.length > maxPaths) throw new Error('memoryPaths exceeds maximum entries');
  const normalized = paths.map((entry, index) => {
    const value = typeof entry === 'string' ? { path: entry } : entry;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`memoryPaths[${index}] must be a string or object`);
    const relativePath = String(value.path ?? '');
    if (!relativePath || relativePath.startsWith('/') || relativePath.includes('..') || relativePath.includes('\\') || /^[a-z]+:/i.test(relativePath)) {
      throw new Error(`memoryPaths[${index}] path must be workspace-relative`);
    }
    if (!SAFE_TARGET.test(relativePath)) throw new Error(`memoryPaths[${index}] path contains unsupported characters`);
    if (isGeneratedMemorySourcePath(relativePath)) throw new Error(`memoryPaths[${index}] path must not point at generated OAF reports`);
    return {
      path: relativePath,
      kind: value.kind ?? 'episode',
      sourceTrust: value.sourceTrust ?? 'unverified',
      dataClass: value.dataClass ?? 'workspace-private',
      sourceRole: value.sourceRole ?? sourceRoleForPath(relativePath)
    };
  });
  return Object.freeze({
    schemaVersion: '1.0.0',
    memoryPaths: Object.freeze(normalized)
  });
}

function tokenize(value) {
  return [...new Set(String(value ?? '').toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])].slice(0, 32);
}

function matchesQuery(record, terms) {
  if (!terms.length) return true;
  const haystack = [
    record.kind,
    record.text,
    record.source,
    ...(Array.isArray(record.tags) ? record.tags : []),
    ...(Array.isArray(record.reasons) ? record.reasons : [])
  ].join(' ').toLocaleLowerCase();
  return terms.some((term) => haystack.includes(term));
}

function manifestDecision(record, manifest) {
  if (!manifest) return { state: 'not_provided', selected: null, reasonCodes: [] };
  const selected = manifest.selectedDecisions ?? manifest.selected ?? [];
  const excluded = manifest.excludedDecisions ?? manifest.excluded ?? [];
  const selectedMatch = selected.find((item) => item.id === record.id || item.recordId === record.id);
  if (selectedMatch) return { state: 'matched', selected: true, reasonCodes: safeTokenList(selectedMatch.reasonCodes, 'reason_redacted') };
  const excludedMatch = excluded.find((item) => item.id === record.id || item.recordId === record.id);
  if (excludedMatch) return { state: 'matched', selected: false, reasonCodes: safeTokenList(excludedMatch.reasonCodes, 'reason_redacted') };
  return { state: 'not_matched', selected: null, reasonCodes: [] };
}

export function buildMemorySgrepReport({ query, records, workspaceId = 'ws_local', generatedAt = '1970-01-01T00:00:00.000Z', limit = 20, manifest = null } = {}) {
  if (typeof query !== 'string' || !query.trim()) throw new Error('query is required');
  if (!Array.isArray(records)) throw new Error('records must be an array');
  const terms = tokenize(query);
  const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  const candidates = records
    .filter((record) => record.workspaceId === workspaceId)
    .filter((record) => safeMemoryKind(record.kind))
    .filter((record) => SEARCH_STATUSES.has(record.status))
    .filter((record) => record.dataClass !== 'secret' && record.text !== '[redacted-secret]')
    .filter((record) => matchesQuery(record, terms))
    .slice(0, boundedLimit);
  const results = candidates.map((record) => {
    const redacted = redactMemoryText(record.text, { maxLength: 240 });
    const manifestState = manifestDecision(record, manifest);
    return {
      id: safeMemoryId(record.id),
      kind: safeMemoryKind(record.kind),
      lifecycle: lifecycleState(record),
      source: sanitizeMemorySource(record.source),
      confidence: Number(record.confidence ?? 0),
      supersedes: record.supersedes ? safeMemoryId(record.supersedes) : null,
      evidenceIds: evidenceIdsFor(record),
      snippet: redacted.text,
      redactions: redacted.redactions,
      contextManifest: manifestState
    };
  });
  const reportBase = {
    schemaVersion: '1.0.0',
    reportVersion: REPORT_VERSION,
    workspaceId,
    generatedAt,
    dryRun: true,
    query,
    summary: {
      searchedCount: records.length,
      resultCount: results.length,
      manifestState: manifest ? 'provided' : 'not_provided'
    },
    results,
    safeguards: safeguards()
  };
  return {
    id: `memsgrep_${hashJson(reportBase).slice(7, 23)}`,
    ...reportBase
  };
}
