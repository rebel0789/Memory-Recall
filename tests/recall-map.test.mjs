import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import recallMapSchema from '../packages/protocol/schemas/recall-map.schema.json' with { type: 'json' };
import { assertJsonSchema, validateJsonSchema } from '../packages/protocol/src/schema-validator.mjs';
import { buildRecallMap as buildRecallMapReport } from '../packages/recall-map/src/index.mjs';
import {
  buildNativeIndexSourceGraphPreview,
  buildUnavailableSourceGraphPreview
} from '../packages/source-graph/src/index.mjs';
import { SQLiteMemoryProvider } from '../providers/native/memory-sqlite/src/index.mjs';

const WORKSPACE_ID = 'ws_local';
const FACT_BODY_SENTINEL = 'RECALL_MAP_FACT_BODY_SENTINEL';
const PROPOSAL_BODY_SENTINEL = 'RECALL_MAP_PROPOSAL_BODY_SENTINEL';
const SOURCE_BODY_SENTINEL = 'RECALL_MAP_SOURCE_BODY_SENTINEL';
const SOURCE_HASH = `sha256:${'a'.repeat(64)}`;

async function fixtureWorkspace(t, { withMemory = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-map-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'index.ts'), [
    'export function startWorkspace() {',
    `  return '${SOURCE_BODY_SENTINEL}';`,
    '}'
  ].join('\n'));
  if (withMemory) await seedMemory(root);
  return root;
}

async function seedMemory(root, {
  activeProposalId = 'mpq_recall_map_active',
  pendingProposalId = 'mpq_recall_map_pending',
  activeFactText = FACT_BODY_SENTINEL,
  pendingProposalText = PROPOSAL_BODY_SENTINEL
} = {}) {
  const memoryDirectory = path.join(root, '.local');
  const filename = path.join(memoryDirectory, 'memory.sqlite');
  await mkdir(memoryDirectory, { recursive: true });
  const provider = new SQLiteMemoryProvider({
    filename,
    clock: () => '2026-07-01T00:00:00.000Z'
  });
  try {
    const approved = await provider.enqueueProposal({
      id: activeProposalId,
      workspaceId: WORKSPACE_ID,
      sourceLocator: 'workspace://memory/review.md',
      sourceHash: SOURCE_HASH,
      payload: {
        kind: 'fact',
        scope: 'workspace',
        subject: 'project:recall',
        predicate: 'release_status',
        object: 'ready',
        text: activeFactText,
        observedAt: '2026-07-01T00:00:00.000Z'
      }
    });
    await provider.approveProposalFact({
      workspaceId: WORKSPACE_ID,
      id: approved.id,
      approvedAt: '2026-07-01T00:00:00.000Z'
    });
    await provider.enqueueProposal({
      id: pendingProposalId,
      workspaceId: WORKSPACE_ID,
      sourceLocator: 'workspace://memory/review.md',
      sourceHash: `sha256:${'b'.repeat(64)}`,
      payload: {
        kind: 'fact',
        scope: 'workspace',
        subject: 'project:recall',
        predicate: 'release_status',
        object: 'pending-review',
        text: pendingProposalText,
        observedAt: '2026-07-01T00:00:00.000Z'
      }
    });
  } finally {
    provider.close();
  }
  return filename;
}

function sha256File(filename) {
  return readFile(filename).then((body) => createHash('sha256').update(body).digest('hex'));
}

const loadJson = async (filename) => JSON.parse(await readFile(filename, 'utf8'));

async function buildRecallMap(options) {
  const rootStatus = await stat(options.root).catch(() => null);
  const sourceGraphPreviewBuilder = rootStatus?.isDirectory()
    ? buildFixtureNativePreview
    : (request) => buildUnavailableSourceGraphPreview({
      ...request,
      errorCode: 'source_index_unavailable'
    });
  return buildRecallMapReport({ ...options, sourceGraphPreviewBuilder });
}

function buildFixtureNativePreview(request) {
  const label = String(request.query ?? '').includes('mapLimit') ? 'mapLimitOne' : 'startWorkspace';
  const file = {
    id: 'cinode_fixture_file',
    kind: 'file',
    label: 'src/index.ts',
    locator: 'workspace://src/index.ts',
    confidence: 1,
    generation: 1
  };
  const symbol = {
    id: 'cinode_fixture_symbol',
    kind: 'function',
    label,
    locator: 'workspace://src/index.ts#L1-L3',
    confidence: 1,
    generation: 1
  };
  const relationship = {
    id: 'ciedge_fixture_defined',
    kind: 'defined_in',
    fromNodeId: symbol.id,
    toNodeId: file.id,
    locator: symbol.locator,
    confidence: 1,
    resolution: 'exact',
    resolver: 'fixture',
    resolverVersion: '1.0.0',
    generation: 1,
    stale: false
  };
  const status = fixtureNativeResult({ operation: 'index.status', results: [] });
  const provider = {
    async queryIndex({ kind }) {
      if (kind === 'communities') {
        return fixtureNativeResult({
          results: [file, symbol],
          relationships: [relationship],
          communities: [{
            id: 'cicommunity_fixture_src',
            label: 'src',
            pathPrefix: 'src',
            representedNodeCount: 2,
            representedRelationshipCount: 1,
            nodeIds: [file.id, symbol.id],
            algorithmVersion: 'label-propagation-v1',
            truncated: false
          }]
        });
      }
      if (kind === 'processes') return fixtureNativeResult({ results: [], relationships: [], processes: [] });
      if (kind === 'search') return fixtureNativeResult({ results: [symbol] });
      if (kind === 'neighborhood' || kind === 'impact') {
        return fixtureNativeResult({ results: [file, symbol], relationships: [relationship] });
      }
      if (kind === 'dependencies') return fixtureNativeResult({ results: [symbol], relationships: [] });
      throw new Error(`unexpected fixture native query: ${kind}`);
    }
  };
  return buildNativeIndexSourceGraphPreview({ provider, status, ...request });
}

function fixtureNativeResult(overrides = {}) {
  return {
    schemaVersion: '1.0.0',
    operation: 'index.query',
    state: 'ready',
    freshness: 'current',
    indexLocator: 'workspace://.local/source-index/index.v1.sqlite',
    activeGeneration: 1,
    repositoryIdentityHash: `sha256:${'1'.repeat(64)}`,
    engineVersion: '2.0.0',
    health: {
      status: 'ready',
      repairRequired: false,
      lastSuccessfulRefreshAt: '2026-07-10T00:00:00.000Z'
    },
    summary: { fileCount: 1, nodeCount: 2, edgeCount: 1 },
    results: [],
    relationships: [],
    diagnostics: [],
    truncated: false,
    nextCursor: null,
    measurements: { durationMs: 1 },
    safeguards: { readOnly: true, localFilesWritten: 0 },
    ...overrides
  };
}

test('Recall Map composes bounded architecture and governed-memory truth without writes', async (t) => {
  const root = await fixtureWorkspace(t);
  const sqlitePath = path.join(root, '.local', 'memory.sqlite');

  const report = await buildRecallMap({
    root,
    changedLocators: ['src/index.ts'],
    clock: () => '2026-07-10T00:00:00.000Z'
  });

  assert.equal(assertJsonSchema(recallMapSchema, report, 'Recall Map'), report);
  assert.equal(report.reportVersion, 'memory-recall-map-1.1.0');
  assert.equal(report.repository.name, path.basename(root));
  assert.equal(typeof report.repository.gitStatusAvailable, 'boolean');
  assert.equal(Number.isInteger(report.repository.dirtyCount), true);
  assert.equal(Object.hasOwn(report.repository, 'root'), false);
  assert.equal(Object.hasOwn(report.repository, 'remoteUrl'), false);
  assert.equal(JSON.stringify(report.repository).includes(root), false);
  assert.equal(report.safeguards.readOnly, true);
  assert.equal(report.safeguards.canonicalStateMutated, false);
  assert.equal(report.safeguards.rawSourceBodiesIncluded, false);
  assert.equal(report.safeguards.localFilesWritten, 0);
  assert.equal(report.support.sourceGraph.status, 'implemented');
  assert.equal(report.support.sourceGraph.coverage.status, 'complete');
  assert.deepEqual(report.architecture.groups.map(({ prefix }) => prefix), ['src']);
  assert.deepEqual(report.architecture.groupRelations, []);
  assert.deepEqual(report.architecture.impact.changedLocators, ['workspace://src/index.ts']);
  assert.deepEqual(report.memory.activeFacts, []);
  assert.deepEqual(report.memory.pendingProposals, []);
  assert.equal(report.memory.status, 'missing');
  assert.equal(report.support.memory.status, 'missing');
  assert.equal(report.memory.unavailableReason, 'memory_store_missing');
  assert.equal(existsSync(path.join(root, '.local')), false);
  assert.equal(existsSync(sqlitePath), false);
  assert.equal(JSON.stringify(report).includes(SOURCE_BODY_SENTINEL), false);
});

test('Recall Map forwards bounded depth and limit to safe source-graph summaries', async (t) => {
  const root = await fixtureWorkspace(t);
  await writeFile(path.join(root, 'src', 'index.ts'), [
    'export function mapLimitOne() { return 1; }',
    'export function mapLimitTwo() { return 2; }',
    'export function mapLimitThree() { return 3; }'
  ].join('\n'));

  const report = await buildRecallMap({
    root,
    changedLocators: ['src/index.ts'],
    query: 'mapLimit',
    depth: 1,
    limit: 1,
    clock: () => '2026-07-11T12:00:00.000Z'
  });

  assert.equal(assertJsonSchema(recallMapSchema, report, 'bounded Recall Map'), report);
  assert.equal(report.architecture.impact.depth, 1);
  assert.equal(report.architecture.search.results.length <= 1, true);
  assert.equal(report.architecture.impact.affectedSymbols.length <= 1, true);
  const highRequestedLimit = await buildRecallMap({
    root,
    changedLocators: ['src/index.ts'],
    query: 'mapLimit',
    limit: 50,
    clock: () => '2026-07-11T12:00:00.000Z'
  });
  assert.equal(assertJsonSchema(recallMapSchema, highRequestedLimit, 'high-limit Recall Map'), highRequestedLimit);
  assert.equal(highRequestedLimit.architecture.search.results.length <= 20, true);
  assert.equal(highRequestedLimit.architecture.impact.affectedSymbols.length <= 20, true);
  await assert.rejects(
    () => buildRecallMap({ root, depth: 0 }),
    /recall_map_depth_invalid/
  );
  await assert.rejects(
    () => buildRecallMap({ root, limit: 51 }),
    /recall_map_limit_invalid/
  );
});

test('Recall Map keeps active facts and pending proposals separate without exposing memory bodies or mutating SQLite', async (t) => {
  const root = await fixtureWorkspace(t, { withMemory: true });
  const sqlitePath = path.join(root, '.local', 'memory.sqlite');
  const before = await sha256File(sqlitePath);

  const report = await buildRecallMap({
    root,
    clock: () => '2026-07-10T00:00:00.000Z'
  });

  assert.equal(report.memory.status, 'available');
  assert.deepEqual(report.memory.activeFacts.map((item) => item.id), ['memfact_recall_map_active']);
  assert.deepEqual(report.memory.pendingProposals.map((item) => item.id), ['mpq_recall_map_pending']);
  assert.equal(report.memory.activeFacts.every((item) => item.status === 'active'), true);
  assert.equal(report.memory.pendingProposals.every((item) => ['pending', 'claimed'].includes(item.status)), true);
  assert.equal(report.memory.activeFacts.some((item) => report.memory.pendingProposals.some((proposal) => proposal.id === item.id)), false);
  assert.equal(await sha256File(sqlitePath), before);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(FACT_BODY_SENTINEL), false);
  assert.equal(serialized.includes(PROPOSAL_BODY_SENTINEL), false);
  assert.equal(serialized.includes(SOURCE_BODY_SENTINEL), false);
  assert.equal(serialized.includes(root), false);
});

test('Recall Map returns a bounded unavailable state for an unreadable local memory store', async (t) => {
  const root = await fixtureWorkspace(t);
  const memoryDirectory = path.join(root, '.local');
  await mkdir(memoryDirectory, { recursive: true });
  await writeFile(path.join(memoryDirectory, 'memory.sqlite'), 'not a SQLite database');

  const report = await buildRecallMap({
    root,
    clock: () => '2026-07-10T00:00:00.000Z'
  });

  assert.equal(report.memory.status, 'unavailable');
  assert.equal(report.memory.unavailableReason, 'memory_store_unavailable');
  assert.deepEqual(report.memory.activeFacts, []);
  assert.deepEqual(report.memory.pendingProposals, []);
  assert.equal(JSON.stringify(report).includes('not a SQLite database'), false);
  assert.equal(JSON.stringify(report).includes(root), false);
});

test('Recall Map refuses an external memory store behind an intermediate workspace symlink', async (t) => {
  const root = await fixtureWorkspace(t);
  const externalRoot = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-map-external-'));
  t.after(() => rm(externalRoot, { recursive: true, force: true }));
  await seedMemory(externalRoot, {
    activeProposalId: 'mpq_external_sentinel',
    pendingProposalId: 'mpq_external_pending',
    activeFactText: 'EXTERNAL_DB_SENTINEL'
  });
  await symlink(path.join(externalRoot, '.local'), path.join(root, '.local'));

  const report = await buildRecallMap({
    root,
    clock: () => '2026-07-10T00:00:00.000Z'
  });

  assert.equal(assertJsonSchema(recallMapSchema, report, 'Recall Map'), report);
  assert.equal(report.memory.status, 'unavailable');
  assert.equal(report.memory.unavailableReason, 'memory_store_unavailable');
  assert.deepEqual(report.memory.activeFacts, []);
  assert.deepEqual(report.memory.pendingProposals, []);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('memfact_external_sentinel'), false);
  assert.equal(serialized.includes('EXTERNAL_DB_SENTINEL'), false);
  assert.equal(serialized.includes(externalRoot), false);
});

test('Recall Map refuses an external memory store behind a SQLite filename symlink', async (t) => {
  const root = await fixtureWorkspace(t);
  const externalRoot = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-map-external-'));
  t.after(() => rm(externalRoot, { recursive: true, force: true }));
  await seedMemory(externalRoot, {
    activeProposalId: 'mpq_filename_sentinel',
    pendingProposalId: 'mpq_filename_pending',
    activeFactText: 'FILENAME_SYMLINK_DB_SENTINEL'
  });
  await mkdir(path.join(root, '.local'), { recursive: true });
  await symlink(path.join(externalRoot, '.local', 'memory.sqlite'), path.join(root, '.local', 'memory.sqlite'));

  const report = await buildRecallMap({
    root,
    clock: () => '2026-07-10T00:00:00.000Z'
  });

  assert.equal(report.memory.status, 'unavailable');
  assert.equal(report.memory.unavailableReason, 'memory_store_unavailable');
  assert.deepEqual(report.memory.activeFacts, []);
  assert.deepEqual(report.memory.pendingProposals, []);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('memfact_filename_sentinel'), false);
  assert.equal(serialized.includes('FILENAME_SYMLINK_DB_SENTINEL'), false);
  assert.equal(serialized.includes(externalRoot), false);
});

test('Recall Map treats a non-file SQLite target as unavailable rather than missing', async (t) => {
  const root = await fixtureWorkspace(t);
  await mkdir(path.join(root, '.local', 'memory.sqlite'), { recursive: true });

  const report = await buildRecallMap({
    root,
    clock: () => '2026-07-10T00:00:00.000Z'
  });

  assert.equal(report.memory.status, 'unavailable');
  assert.equal(report.memory.unavailableReason, 'memory_store_unavailable');
  assert.deepEqual(report.memory.activeFacts, []);
  assert.deepEqual(report.memory.pendingProposals, []);
});

test('Recall Map redacts hostile stored locators and clamps malformed proposal counters', async (t) => {
  const root = await fixtureWorkspace(t, { withMemory: true });
  const sqlitePath = path.join(root, '.local', 'memory.sqlite');
  const database = new DatabaseSync(sqlitePath);
  try {
    database.prepare('UPDATE memory_facts SET source = ? WHERE workspace_id = ? AND id = ?').run(
      'workspace://memory/review.md?token=RECALL_MAP_LOCATOR_SECRET',
      WORKSPACE_ID,
      'memfact_recall_map_active'
    );
    database.prepare('UPDATE memory_proposal_queue SET source_locator = ?, attempts = ?, max_attempts = ? WHERE workspace_id = ? AND id = ?').run(
      'workspace://memory/review.md?api_key=RECALL_MAP_LOCATOR_SECRET',
      99,
      99,
      WORKSPACE_ID,
      'mpq_recall_map_pending'
    );
  } finally {
    database.close();
  }

  const report = await buildRecallMap({
    root,
    clock: () => '2026-07-10T00:00:00.000Z'
  });

  assert.equal(report.memory.status, 'available');
  assert.equal(report.memory.activeFacts[0].sourceLocator, null);
  assert.equal(report.memory.pendingProposals[0].sourceLocator, null);
  assert.equal(report.memory.pendingProposals[0].attempts, 10);
  assert.equal(report.memory.pendingProposals[0].maxAttempts, 10);
  assert.equal(assertJsonSchema(recallMapSchema, report, 'Recall Map'), report);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('RECALL_MAP_LOCATOR_SECRET'), false);
  assert.equal(serialized.includes('?token='), false);
  assert.equal(serialized.includes('?api_key='), false);
});

test('Recall Map reports unavailable source coverage without falling back to a different graph engine', async (t) => {
  const root = await fixtureWorkspace(t);
  const report = await buildRecallMap({
    root: path.join(root, 'src', 'index.ts'),
    clock: () => '2026-07-10T00:00:00.000Z'
  });

  assert.equal(report.support.sourceGraph.status, 'unavailable');
  assert.equal(report.support.sourceGraph.coverage.status, 'unavailable');
  assert.equal(report.architecture.search.status, 'unavailable');
  assert.equal(report.safeguards.graphDatabaseUsed, false);
});

test('Recall Map rejects unsafe SQLite locators before reading a workspace', async (t) => {
  const root = await fixtureWorkspace(t);

  await assert.rejects(
    () => buildRecallMap({ root, sqliteLocator: '../outside.sqlite' }),
    /recall_map_sqlite_locator_invalid/
  );
  await assert.rejects(
    () => buildRecallMap({ root, sqliteLocator: path.join(root, '.local', 'memory.sqlite') }),
    /recall_map_sqlite_locator_invalid/
  );
});

test('Recall Map fingerprint excludes clock-derived report timestamps', async (t) => {
  const root = await fixtureWorkspace(t);
  const first = await buildRecallMap({
    root,
    changedLocators: ['src/index.ts'],
    clock: () => '2026-07-10T00:00:00.000Z'
  });
  const second = await buildRecallMap({
    root,
    changedLocators: ['src/index.ts'],
    clock: () => '2026-07-11T00:00:00.000Z'
  });

  assert.notEqual(first.generatedAt, second.generatedAt);
  assert.equal(first.fingerprint, second.fingerprint);
});

test('Recall Map schema compatibility fixtures cover strict read-only safety boundaries', async () => {
  const manifest = await loadJson('examples/protocol/compatibility/fixtures.json');
  const recallMapFixtures = manifest.fixtures.filter((fixture) => fixture.schema === 'packages/protocol/schemas/recall-map.schema.json');
  assert.deepEqual(recallMapFixtures.map((fixture) => fixture.id).sort(), [
    'recall-map-active-fact-proposal-invalid',
    'recall-map-canonical-state-mutation-invalid',
    'recall-map-model-call-invalid',
    'recall-map-network-call-invalid',
    'recall-map-raw-label-invalid',
    'recall-map-raw-source-body-invalid',
    'recall-map-valid'
  ]);
  for (const fixture of recallMapFixtures) {
    const result = validateJsonSchema(recallMapSchema, await loadJson(fixture.instance));
    assert.equal(result.valid, fixture.expectedValid, `${fixture.id}: ${JSON.stringify(result.errors)}`);
  }
  const unknownEdgeKind = structuredClone(await loadJson('examples/protocol/recall-map.json'));
  unknownEdgeKind.architecture.impact.affectedEdgeKindCounts.provider_extension = 1;
  assert.equal(validateJsonSchema(recallMapSchema, unknownEdgeKind).valid, false);
  const unsafeLabel = structuredClone(await loadJson('examples/protocol/recall-map.json'));
  unsafeLabel.architecture.search.results[0].label = 'file:///tmp/private-source.ts';
  assert.equal(validateJsonSchema(recallMapSchema, unsafeLabel).valid, false);
  const unsafeLocatorQuery = structuredClone(await loadJson('examples/protocol/recall-map.json'));
  unsafeLocatorQuery.architecture.search.results[0].locator = 'workspace://src/index.ts?token=RECALL_MAP_LOCATOR_SECRET';
  assert.equal(validateJsonSchema(recallMapSchema, unsafeLocatorQuery).valid, false);
  const unsafeLocatorFragment = structuredClone(await loadJson('examples/protocol/recall-map.json'));
  unsafeLocatorFragment.architecture.search.results[0].locator = 'workspace://src/index.ts#RECALL_MAP_LOCATOR_SECRET';
  assert.equal(validateJsonSchema(recallMapSchema, unsafeLocatorFragment).valid, false);
});
