import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildJsTsSourceGraph,
  sanitizeSourceGraphPublicOutput
} from '../providers/native/context-candidate-ast-code/src/index.mjs';
import {
  buildPersistentSourceGraphIndex,
  loadPersistentSourceGraphIndex,
  readPersistentSourceGraphIndexStatus,
  refreshPersistentSourceGraphIndex
} from '../packages/source-graph/src/index-store.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-index-store-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'alpha.ts'), [
    'export function alpha() {',
    "  return 'INDEX RAW ALPHA';",
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'beta.ts'), [
    "import { alpha } from './alpha';",
    'export function beta() { return alpha(); }'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'stable.ts'), 'export const stable = true;\n');
  return root;
}

test('persistent source index stores sanitized structural shards and survives reload', async () => {
  const root = await fixture();
  const built = await buildPersistentSourceGraphIndex({ root, workspaceId: 'ws_local', clock: () => '2026-07-16T10:00:00.000Z' });
  assert.equal(built.status, 'ready');
  assert.equal(built.measurements.parsedFileCount, 3);
  assert.equal(built.measurements.reusedFileCount, 0);
  const raw = await readFile(path.join(root, '.local', 'source-graph', 'index.v1.json'), 'utf8');
  assert.equal(raw.includes('INDEX RAW ALPHA'), false);
  assert.equal(raw.includes(root), false);
  assert.equal(raw.includes('/Users/'), false);
  const loaded = await loadPersistentSourceGraphIndex({ root, workspaceId: 'ws_local' });
  assert.equal(loaded.graph.graphFingerprint, built.graph.graphFingerprint);
  assert.equal(loaded.source.kind, 'persistent-index');
  assert.equal(loaded.source.freshness, 'current');
  const status = await readPersistentSourceGraphIndexStatus({ root, workspaceId: 'ws_local' });
  assert.equal(status.status, 'ready');
  assert.equal(status.fileCount, 3);
});

test('incremental refresh parses changed and added files, reuses unchanged shards, and removes deleted files', async () => {
  const root = await fixture();
  await buildPersistentSourceGraphIndex({ root, workspaceId: 'ws_local', clock: () => '2026-07-16T10:00:00.000Z' });
  await new Promise((resolve) => setTimeout(resolve, 12));
  await writeFile(path.join(root, 'src', 'alpha.ts'), 'export function alpha() { return 2; }\n');
  await writeFile(path.join(root, 'src', 'gamma.ts'), "import { alpha } from './alpha';\nexport function gamma() { return alpha(); }\n");
  await rm(path.join(root, 'src', 'beta.ts'));
  const refreshed = await refreshPersistentSourceGraphIndex({ root, workspaceId: 'ws_local', clock: () => '2026-07-16T10:01:00.000Z' });
  assert.equal(refreshed.measurements.parsedFileCount, 2);
  assert.equal(refreshed.measurements.reusedFileCount, 1);
  assert.equal(refreshed.measurements.addedFileCount, 1);
  assert.equal(refreshed.measurements.changedFileCount, 1);
  assert.equal(refreshed.measurements.deletedFileCount, 1);
  const clean = sanitizeSourceGraphPublicOutput(await buildJsTsSourceGraph({ root, workspaceId: 'ws_local', clock: () => '2026-07-16T10:01:00.000Z' }));
  assert.deepEqual(
    refreshed.graph.nodes.map(({ kind, label, locator }) => ({ kind, label, locator })),
    clean.nodes.map(({ kind, label, locator }) => ({ kind, label, locator }))
  );
  assert.deepEqual(
    refreshed.graph.edges.map(({ kind, fromNodeId, toNodeId, locator }) => ({ kind, fromNodeId, toNodeId, locator })),
    clean.edges.map(({ kind, fromNodeId, toNodeId, locator }) => ({ kind, fromNodeId, toNodeId, locator }))
  );
});

test('persistent source index fails closed when the file is corrupt', async () => {
  const root = await fixture();
  await mkdir(path.join(root, '.local', 'source-graph'), { recursive: true });
  await writeFile(path.join(root, '.local', 'source-graph', 'index.v1.json'), '{not-json');
  const status = await readPersistentSourceGraphIndexStatus({ root, workspaceId: 'ws_local' });
  assert.equal(status.status, 'invalid');
  await assert.rejects(() => loadPersistentSourceGraphIndex({ root, workspaceId: 'ws_local' }), /source_graph_index_invalid/u);
});

test('persistent source index reports stale after source changes without a refresh', async () => {
  const root = await fixture();
  await buildPersistentSourceGraphIndex({ root, workspaceId: 'ws_local' });
  await new Promise((resolve) => setTimeout(resolve, 12));
  await writeFile(path.join(root, 'src', 'alpha.ts'), 'export function alpha() { return 9; }\n');
  const loaded = await loadPersistentSourceGraphIndex({ root, workspaceId: 'ws_local' });
  assert.equal(loaded.source.freshness, 'stale');
  const status = await readPersistentSourceGraphIndexStatus({ root, workspaceId: 'ws_local' });
  assert.equal(status.status, 'stale');
});
