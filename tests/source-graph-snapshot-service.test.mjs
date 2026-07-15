import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildJsTsSourceGraph } from '../providers/native/context-candidate-ast-code/src/index.mjs';
import { buildSourceGraphPreview } from '../packages/source-graph/src/index.mjs';
import { createSourceGraphSnapshotService } from '../packages/source-graph/src/snapshot-service.mjs';

test('snapshot service reuses, deduplicates, invalidates, and preserves last valid graph', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recall-snapshot-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let builds = 0;
  let fail = false;
  let onChange = null;
  const graph = fixtureGraph();
  const service = createSourceGraphSnapshotService({
    buildGraph: async () => {
      builds += 1;
      await Promise.resolve();
      if (fail) throw new Error('fixture_build_failed');
      return graph;
    },
    watchRoot: (_root, listener) => {
      onChange = listener;
      return { close() {} };
    },
    clock: () => 1000
  });
  t.after(() => service.close());

  const request = { root, workspaceId: 'ws_local', maxFiles: 1000, maxFileBytes: 524288 };
  const [first, concurrent] = await Promise.all([service.getSnapshot(request), service.getSnapshot(request)]);
  assert.equal(builds, 1);
  assert.equal(first.reuse, 'cold');
  assert.equal(concurrent.reuse, 'inflight');

  const cached = await service.getSnapshot(request);
  assert.equal(cached.reuse, 'cache');
  assert.equal(builds, 1);
  assert.match(service.inspect(root).identity, /^sha256:[a-f0-9]{64}$/u);

  onChange('change', 'node_modules/package/index.js');
  const ignoredChange = await service.getSnapshot(request);
  assert.equal(ignoredChange.reuse, 'cache');
  assert.equal(builds, 1);

  onChange('change', 'src/app.js');
  fail = true;
  const stale = await service.getSnapshot(request);
  assert.equal(stale.status, 'stale');
  assert.equal(stale.graph.graphFingerprint, graph.graphFingerprint);
  assert.equal(builds, 2);
});

test('snapshot service falls back to a bounded metadata scan when recursive watch is unavailable', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recall-snapshot-fallback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let builds = 0;
  let manifest = 'manifest:a';
  const unavailable = Object.assign(new Error('recursive watch unavailable'), { code: 'ERR_FEATURE_UNAVAILABLE' });
  const service = createSourceGraphSnapshotService({
    buildGraph: async () => {
      builds += 1;
      return fixtureGraph();
    },
    watchRoot: () => { throw unavailable; },
    freshnessProbe: async () => manifest,
    clock: () => 1000
  });
  t.after(() => service.close());
  const request = { root, workspaceId: 'ws_local', maxFiles: 1000, maxFileBytes: 524288 };

  await service.getSnapshot(request);
  const cached = await service.getSnapshot(request);
  assert.equal(cached.reuse, 'cache');
  assert.equal(cached.validationMode, 'metadata-scan');
  assert.equal(builds, 1);

  manifest = 'manifest:b';
  const rebuilt = await service.getSnapshot(request);
  assert.equal(rebuilt.reuse, 'cold');
  assert.equal(builds, 2);
});

test('source graph preview reports snapshot reuse without rebuilding', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recall-snapshot-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'app.js'), 'export function startApp(){ return true; }\n');
  let builds = 0;
  const service = createSourceGraphSnapshotService({
    buildGraph: async (request) => {
      builds += 1;
      return buildJsTsSourceGraph({ ...request, clock: () => '2026-07-15T10:00:00.000Z' });
    },
    watchRoot: () => ({ close() {} })
  });
  t.after(() => service.close());

  const first = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'startApp',
    snapshotService: service,
    clock: () => '2026-07-15T10:00:00.000Z'
  });
  const cached = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'startApp',
    snapshotService: service,
    clock: () => '2026-07-15T10:00:00.000Z'
  });

  assert.equal(builds, 1);
  assert.equal(first.snapshot.reuse, 'cold');
  assert.equal(cached.snapshot.reuse, 'cache');
  assert.equal(cached.snapshot.status, 'fresh');
  assert.equal(cached.snapshot.validationMode, 'watcher');
});

function fixtureGraph() {
  return Object.freeze({
    schemaVersion: '1.0.0',
    workspaceId: 'ws_local',
    graphVersion: 'memory-recall-test-1.0.0',
    parserVersion: 'memory-recall-test-parser',
    builtAt: '2026-07-15T10:00:00.000Z',
    sourceIndexFingerprint: `sha256:${'a'.repeat(64)}`,
    graphFingerprint: `sha256:${'b'.repeat(64)}`,
    summary: {
      fileCount: 1,
      symbolCount: 0,
      moduleCount: 0,
      nodeCount: 0,
      edgeCount: 0,
      nodeKindCounts: {},
      edgeKindCounts: {},
      hotspots: [],
      entryPoints: [],
      coverage: {
        ignoreRuleFingerprint: `sha256:${'c'.repeat(64)}`,
        ignoreFileLocators: []
      }
    },
    nodes: [],
    edges: [],
    diagnostics: []
  });
}
