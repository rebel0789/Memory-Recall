import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activateMemory,
  buildMemoryProfileReport,
  buildMemoryProposalsReport,
  buildMemorySgrepReport,
  normalizeMemoryPathsConfig,
  proposeMemory,
  verifyMemory
} from '../packages/memory-core/src/index.mjs';

const now = '2026-06-23T00:00:00.000Z';

function activeMemory(input) {
  return activateMemory(verifyMemory(proposeMemory({
    workspaceId: 'ws_local',
    sourceTrust: 'verified',
    now,
    ...input
  }), { verifiedAt: now, verifiedBy: 'usr_reviewer', evidenceIds: input.evidenceIds ?? ['ev_default'] }), { activatedAt: now, activatedBy: 'usr_reviewer' });
}

test('memory profile renders accepted active memory only as a generated non-authoritative report', () => {
  const active = activeMemory({
    id: 'mem_profile_active',
    kind: 'decision',
    text: 'Every model call must reference a persisted context manifest.',
    source: 'evidence:ev_context',
    evidenceIds: ['ev_context']
  });
  const proposed = proposeMemory({
    id: 'mem_profile_proposed',
    workspaceId: 'ws_local',
    kind: 'preference',
    text: 'Prefer speculative memory imports.',
    source: 'model-output',
    now
  });
  const quarantined = proposeMemory({
    id: 'mem_profile_secret',
    workspaceId: 'ws_local',
    kind: 'episode',
    text: 'BEGIN RSA PRIVATE KEY',
    source: 'tool-output',
    now
  });
  const otherWorkspace = activeMemory({
    id: 'mem_profile_other_workspace',
    workspaceId: 'ws_other',
    kind: 'decision',
    text: 'Other workspace memory must not appear.',
    source: 'evidence:ev_other',
    evidenceIds: ['ev_other']
  });

  const report = buildMemoryProfileReport({ records: [proposed, active, quarantined, otherWorkspace], workspaceId: 'ws_local', generatedAt: now });
  assert.equal(report.dryRun, true);
  assert.equal(report.target.locator, 'workspace://memory/profile.md');
  assert.deepEqual(report.summary.recordIds, ['mem_profile_active']);
  assert.match(report.markdown, /persisted context manifest/);
  assert.doesNotMatch(report.markdown, /speculative memory imports/);
  assert.doesNotMatch(report.markdown, /Other workspace/);
  assert.doesNotMatch(report.markdown, /BEGIN RSA PRIVATE KEY/);
  assert.equal(report.safeguards.activeMemoryCreated, 0);
  assert.equal(report.safeguards.canonicalStateMutated, false);
  assert.equal(report.safeguards.externalWritesEnabled, false);
});

test('memory proposal reports include pending and quarantined review items with redactions', () => {
  const proposed = proposeMemory({
    id: 'mem_report_proposed',
    workspaceId: 'ws_local',
    kind: 'episode',
    text: 'Investigate context profile at /Users/rebel/private.txt with token=secret-value and OPENAI_API_KEY=another-secret.',
    source: 'workspace://notes/context.md',
    now
  });
  const quarantined = proposeMemory({
    id: 'mem_report_quarantined',
    workspaceId: 'ws_local',
    kind: 'episode',
    text: 'BEGIN RSA PRIVATE KEY',
    source: 'tool-output',
    now
  });
  const otherWorkspace = proposeMemory({
    id: 'mem_report_other_workspace',
    workspaceId: 'ws_other',
    kind: 'episode',
    text: 'Other workspace proposal must not appear.',
    source: 'workspace://notes/other.md',
    now
  });

  const report = buildMemoryProposalsReport({ records: [proposed, quarantined, otherWorkspace], workspaceId: 'ws_local', generatedAt: now });
  assert.equal(report.summary.proposalCount, 1);
  assert.equal(report.summary.quarantinedCount, 1);
  assert.deepEqual(report.items.map((item) => item.id), ['mem_report_proposed', 'mem_report_quarantined']);
  assert.match(report.items[0].markdown, /\[redacted-local-path\]/);
  assert.match(report.items[0].markdown, /\[redacted-secret\]/);
  assert.doesNotMatch(JSON.stringify(report), /\/Users\/rebel/);
  assert.doesNotMatch(JSON.stringify(report), /secret-value/);
  assert.doesNotMatch(JSON.stringify(report), /another-secret/);
  assert.doesNotMatch(JSON.stringify(report), /Other workspace/);
  assert.equal(report.safeguards.activeMemoryCreated, 0);
});

test('memory reports redact hostile IDs, evidence IDs, reasons, and reject arbitrary targets', () => {
  const hostile = {
    schemaVersion: '1.0.0',
    id: 'mem_/Users/rebel/private.txt',
    workspaceId: 'ws_local',
    kind: 'decision',
    text: 'Safe body.',
    status: 'active',
    source: 'evidence:ev_safe',
    confidence: 0.9,
    createdAt: now,
    dataClass: 'workspace-private',
    evidenceIds: ['ev_/Users/rebel/private.txt', 'token=secret-value'],
    reasons: ['reason_/Users/rebel/private.txt'],
    supersedes: 'mem_/Users/rebel/old.txt',
    lifecycle: [{ type: 'memory.activated', at: now, actorId: 'usr', reason: null, evidenceIds: ['ev_/Users/rebel/private.txt'] }]
  };
  const profile = buildMemoryProfileReport({ records: [hostile], workspaceId: 'ws_local', generatedAt: now });
  assert.match(profile.summary.recordIds[0], /^mem_redacted_/);
  assert.doesNotMatch(JSON.stringify(profile), /\/Users\/rebel/);
  assert.doesNotMatch(JSON.stringify(profile), /secret-value/);

  const proposal = { ...hostile, status: 'proposed', decision: 'review' };
  const proposals = buildMemoryProposalsReport({ records: [proposal], workspaceId: 'ws_local', generatedAt: now });
  assert.match(proposals.items[0].id, /^mem_redacted_/);
  assert.match(proposals.items[0].reasons[0], /^reason_redacted_/);
  assert.doesNotMatch(JSON.stringify(proposals), /\/Users\/rebel/);
  assert.doesNotMatch(JSON.stringify(proposals), /secret-value/);

  assert.throws(() => buildMemoryProfileReport({ records: [], targetPath: 'package.json' }), /memory\/profile\.md/);
  assert.throws(() => buildMemoryProposalsReport({ records: [], targetDirectory: '.git/hooks' }), /memory\/proposals/);

  const invalidKind = { ...hostile, id: 'mem_invalid_kind', kind: '/Users/rebel/private-kind', text: 'Invalid kind must be skipped.' };
  const skipped = buildMemoryProfileReport({ records: [invalidKind], workspaceId: 'ws_local', generatedAt: now });
  assert.equal(skipped.summary.acceptedCount, 0);
  assert.doesNotMatch(JSON.stringify(skipped), /private-kind/);
});

test('memoryPaths config is explicit and workspace-relative only', () => {
  const config = normalizeMemoryPathsConfig({
    schemaVersion: '1.0.0',
    memoryPaths: [
      'docs/decisions.md',
      { path: '.codex/context.md', kind: 'procedure', sourceTrust: 'verified' }
    ]
  });
  assert.deepEqual(config.memoryPaths.map((entry) => entry.path), ['docs/decisions.md', '.codex/context.md']);
  assert.equal(config.memoryPaths[1].kind, 'procedure');
  assert.throws(() => normalizeMemoryPathsConfig({ memoryPaths: ['/Users/rebel/private.md'] }), /workspace-relative/);
  assert.throws(() => normalizeMemoryPathsConfig({ memoryPaths: ['../outside.md'] }), /workspace-relative/);
});

test('memory sgrep returns lifecycle, evidence, and explicit context manifest reason codes', () => {
  const selected = activeMemory({
    id: 'mem_sgrep_selected',
    kind: 'decision',
    text: 'Use SQLite FTS5 for local memory search.',
    source: 'evidence:ev_sqlite',
    evidenceIds: ['ev_sqlite']
  });
  const otherWorkspace = activeMemory({
    id: 'mem_sgrep_other',
    workspaceId: 'ws_other',
    kind: 'decision',
    text: 'Use SQLite FTS5 for another workspace.',
    source: 'evidence:ev_other',
    evidenceIds: ['ev_other']
  });
  const manifest = {
    selectedDecisions: [{ id: 'mem_sgrep_selected', reasonCodes: ['query_match', 'active_memory'] }],
    excludedDecisions: []
  };

  const report = buildMemorySgrepReport({
    query: 'sqlite memory',
    records: [selected, otherWorkspace],
    workspaceId: 'ws_local',
    generatedAt: now,
    manifest
  });
  assert.equal(report.summary.resultCount, 1);
  assert.equal(report.results[0].id, 'mem_sgrep_selected');
  assert.equal(report.results[0].lifecycle.status, 'active');
  assert.deepEqual(report.results[0].evidenceIds, ['ev_sqlite']);
  assert.deepEqual(report.results[0].contextManifest.reasonCodes, ['active_memory', 'query_match']);
  assert.equal(report.safeguards.networkCalls, 0);
  assert.equal(report.safeguards.modelCalls, 0);
});

test('memory sgrep redacts unsafe manifest reasons and supersession IDs', () => {
  const record = {
    schemaVersion: '1.0.0',
    id: 'mem_sgrep_hostile',
    workspaceId: 'ws_local',
    kind: 'decision',
    text: 'Use safe search reports.',
    status: 'active',
    source: 'evidence:ev_safe',
    confidence: 0.9,
    createdAt: now,
    dataClass: 'workspace-private',
    supersedes: 'mem_/Users/rebel/private.txt',
    evidenceIds: ['ev_safe'],
    lifecycle: [{ type: 'memory.activated', at: now, actorId: 'usr', reason: null, evidenceIds: [] }]
  };
  const report = buildMemorySgrepReport({
    query: 'safe search',
    records: [record],
    workspaceId: 'ws_local',
    generatedAt: now,
    manifest: {
      selectedDecisions: [{
        id: 'mem_sgrep_hostile',
        reasonCodes: ['query_match', '/Users/rebel/private.txt', 'token=secret-value', 'OPENAI_API_KEY=another-secret']
      }],
      excludedDecisions: []
    }
  });

  assert.match(report.results[0].supersedes, /^mem_redacted_/);
  assert(report.results[0].contextManifest.reasonCodes.includes('query_match'));
  assert(report.results[0].contextManifest.reasonCodes.some((reason) => reason.startsWith('reason_redacted_')));
  assert.doesNotMatch(JSON.stringify(report), /\/Users\/rebel/);
  assert.doesNotMatch(JSON.stringify(report), /secret-value/);
  assert.doesNotMatch(JSON.stringify(report), /another-secret/);

  const invalidKindReport = buildMemorySgrepReport({
    query: 'safe search',
    records: [{ ...record, id: 'mem_sgrep_invalid_kind', kind: '/Users/rebel/private-kind' }],
    workspaceId: 'ws_local',
    generatedAt: now
  });
  assert.equal(invalidKindReport.summary.resultCount, 0);
  assert.doesNotMatch(JSON.stringify(invalidKindReport), /private-kind/);
});
