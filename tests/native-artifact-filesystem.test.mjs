import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ArtifactStorePort, runProviderSmokeConformance } from '../packages/adapter-contracts/src/index.mjs';
import { FilesystemArtifactStore } from '../providers/native/artifact-filesystem/src/index.mjs';

async function tempArtifactsRoot(t, prefix = 'oaf artifacts ') {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function adapterCatalog() {
  return JSON.parse(await readFile(new URL('../adapters/catalog.json', import.meta.url), 'utf8'));
}

test('content-addressed artifact store deduplicates and preserves integrity', async (t) => {
  const directory = await tempArtifactsRoot(t);
  const provider = new FilesystemArtifactStore({ root: directory, clock: () => '2026-06-19T10:00:00.000Z' });
  const first = await provider.put({ workspaceId: 'ws_local', body: 'evidence body', mediaType: 'text/plain', filename: 'evidence.txt' });
  const second = await provider.put({ workspaceId: 'ws_local', body: 'evidence body', mediaType: 'text/plain', filename: 'evidence.txt' });
  assert.equal(first.id, second.id);
  assert.equal(first.contentHash, first.hash);
  const loaded = await provider.get({ workspaceId: 'ws_local', id: first.id });
  assert.equal(loaded.body.toString('utf8'), 'evidence body');
  assert.equal(loaded.hash, first.hash);
  assert.deepEqual((await provider.list({ workspaceId: 'ws_local' })).map((item) => item.id), [first.id]);
  assert.equal(await provider.get({ workspaceId: 'other', id: first.id }), null);

  const report = await runProviderSmokeConformance({
    provider,
    PortClass: ArtifactStorePort,
    providerId: 'provider:native:artifact:filesystem',
    expectedCapabilities: ['artifact.content-addressed', 'artifact.source-snapshot', 'artifact.integrity.verify']
  });
  assert.equal(report.passed, true);
});

test('artifact store rejects traversal and oversized bodies', async (t) => {
  const directory = await tempArtifactsRoot(t);
  const provider = new FilesystemArtifactStore({ root: directory, maxBytes: 4, maxMetadataBytes: 32, maxMediaTypeLength: 32 });
  await assert.rejects(() => provider.put({ workspaceId: '../escape', body: 'ok' }), /workspaceId/);
  await assert.rejects(() => provider.put({ workspaceId: 'ws_local', body: '12345' }), /exceeds/);
  await assert.rejects(() => provider.put({ workspaceId: 'ws_local', body: 'ok', mediaType: 'not a media type' }), /mediaType/);
  await assert.rejects(() => provider.put({ workspaceId: 'ws_local', body: 'ok', metadata: { long: 'x'.repeat(128) } }), /metadata/);
});

test('artifact records are immutable references to shared workspace objects', async (t) => {
  const directory = await tempArtifactsRoot(t);
  const provider = new FilesystemArtifactStore({ root: directory, clock: () => '2026-06-19T10:00:00.000Z' });
  const body = Buffer.from([0, 255, 10, 65]);
  const first = await provider.put({ workspaceId: 'ws_local', body, mediaType: 'application/octet-stream', filename: 'raw.bin' });
  const second = await provider.put({ workspaceId: 'ws_local', body: new Uint8Array(body), mediaType: 'application/octet-stream', filename: 'renamed.bin' });

  assert.notEqual(first.id, second.id);
  assert.equal(first.contentHash, second.contentHash);
  assert.deepEqual(await provider.getBody({ workspaceId: 'ws_local', id: first.id }), body);
  assert.deepEqual((await provider.list({ workspaceId: 'ws_local' })).map((item) => item.id).sort(), [first.id, second.id].sort());

  const deletedFirst = await provider.removeRecord({ workspaceId: 'ws_local', id: first.id, reason: 'test cleanup' });
  assert.equal(deletedFirst.deleted, true);
  assert.equal(deletedFirst.bodyDeleted, false);
  assert.equal(await provider.get({ workspaceId: 'ws_local', id: first.id }), null);
  assert.equal((await provider.getBody({ workspaceId: 'ws_local', id: second.id })).toString('hex'), body.toString('hex'));

  const deletedSecond = await provider.removeRecord({ workspaceId: 'ws_local', id: second.id, reason: 'test cleanup' });
  assert.equal(deletedSecond.deleted, true);
  assert.equal(deletedSecond.bodyDeleted, true);
  assert.equal((await provider.removeRecord({ workspaceId: 'ws_local', id: second.id, reason: 'idempotent cleanup' })).deleted, false);
  assert.equal(await provider.remove({ workspaceId: 'ws_local', id: second.id }), false);
});

test('source snapshots default to untrusted external and reject inferred or secret provenance', async (t) => {
  const directory = await tempArtifactsRoot(t);
  const provider = new FilesystemArtifactStore({ root: directory, clock: () => '2026-06-19T10:00:00.000Z' });
  const snapshot = await provider.putSourceSnapshot({
    workspaceId: 'ws_local',
    body: '<html>source</html>',
    mediaType: 'text/html',
    collector: 'fixture-collector',
    retrievalMethod: 'manual',
    sourceLocator: 'https://example.test/source',
    capturedAt: '2026-06-19T09:59:00.000Z',
    metadata: { title: 'source page' }
  });

  assert.match(snapshot.id, /^src_/);
  assert.equal(snapshot.kind, 'source_snapshot');
  assert.equal(snapshot.trust, 'untrusted-external');
  assert.equal(snapshot.contentHash, snapshot.hash);
  assert.equal(snapshot.collector, 'fixture-collector');
  assert.equal((await provider.getMetadata({ workspaceId: 'ws_local', id: snapshot.id })).sourceLocator, 'https://example.test/source');
  assert.equal((await provider.getBody({ workspaceId: 'ws_other', id: snapshot.id })), null);

  await assert.rejects(
    () => provider.putSourceSnapshot({ workspaceId: 'ws_local', body: 'x', collector: 'c', retrievalMethod: 'manual', sourceLocator: 'https://user:pass@example.test/' }),
    /userinfo/
  );
  await assert.rejects(
    () => provider.putSourceSnapshot({ workspaceId: 'ws_local', body: 'x', collector: 'c', retrievalMethod: 'manual', sourceLocator: 'https://example.test/', summary: 'model conclusion' }),
    /inferred|summary|conclusion/
  );
  await assert.rejects(
    () => provider.putSourceSnapshot({ workspaceId: 'ws_local', body: 'x', collector: 'c', retrievalMethod: 'manual', sourceLocator: 'https://example.test/', metadata: { authorization: 'Bearer secret' } }),
    /secret|credential|token|cookie|authorization/i
  );
});

test('retention planning and deletion are explicit, deterministic, and auditable', async (t) => {
  const directory = await tempArtifactsRoot(t);
  const provider = new FilesystemArtifactStore({ root: directory, clock: () => '2026-06-19T10:00:00.000Z' });
  const expired = await provider.put({
    workspaceId: 'ws_local',
    body: 'expired',
    retention: { mode: 'expire-at', expiresAt: '2026-06-19T09:00:00.000Z' }
  });
  const retained = await provider.put({
    workspaceId: 'ws_local',
    body: 'retained',
    retention: { mode: 'retain' }
  });
  const held = await provider.put({
    workspaceId: 'ws_local',
    body: 'held',
    retention: { mode: 'legal-hold' }
  });

  assert.deepEqual((await provider.planRetention({ workspaceId: 'ws_local', at: '2026-06-19T11:00:00.000Z' })).actions.map((item) => item.recordId), [expired.id]);
  const applied = await provider.applyRetention({ workspaceId: 'ws_local', at: '2026-06-19T11:00:00.000Z', reason: 'retention expiry' });
  assert.equal(applied.applied.length, 1);
  assert.equal(applied.applied[0].recordId, expired.id);
  assert.equal(await provider.get({ workspaceId: 'ws_local', id: expired.id }), null);
  assert.equal((await provider.getMetadata({ workspaceId: 'ws_local', id: retained.id })).id, retained.id);
  await assert.rejects(() => provider.removeRecord({ workspaceId: 'ws_local', id: held.id, reason: 'manual delete' }), /legal hold/);

  const tombstones = await provider.listTombstones({ workspaceId: 'ws_local' });
  assert.equal(tombstones.length, 1);
  assert.equal(tombstones[0].recordId, expired.id);
});

test('integrity verification detects tamper, symlink escapes, and ignores incomplete temp files', async (t) => {
  const directory = await tempArtifactsRoot(t);
  const provider = new FilesystemArtifactStore({ root: directory });
  const artifact = await provider.put({ workspaceId: 'ws_local', body: 'safe body', filename: '../display-only.txt' });
  await writeFile(path.join(directory, 'workspaces', 'ws_local', 'records', 'artifacts', 'ignored.tmp'), '{');
  assert.equal((await provider.verifyIntegrity({ workspaceId: 'ws_local' })).ok, true);

  await writeFile(path.join(directory, 'workspaces', 'ws_local', 'objects', 'sha256', artifact.contentHash.slice(0, 2), artifact.contentHash), 'tampered');
  const tampered = await provider.verifyIntegrity({ workspaceId: 'ws_local' });
  assert.equal(tampered.ok, false);
  assert.ok(tampered.findings.some((finding) => finding.code === 'object_hash_mismatch'));

  const escapeRoot = await mkdtemp(path.join(os.tmpdir(), 'oaf-escape-'));
  t.after(() => rm(escapeRoot, { recursive: true, force: true }));
  const escapeProvider = new FilesystemArtifactStore({ root: directory });
  const escapeBody = Buffer.from('escape body');
  const escapeHash = createHash('sha256').update(escapeBody).digest('hex');
  await mkdir(path.join(directory, 'workspaces', 'ws_escape', 'objects', 'sha256'), { recursive: true });
  await symlink(escapeRoot, path.join(directory, 'workspaces', 'ws_escape', 'objects', 'sha256', escapeHash.slice(0, 2)));
  await assert.rejects(
    () => escapeProvider.put({ workspaceId: 'ws_escape', body: escapeBody, mediaType: 'application/octet-stream' }),
    /symlink|inside storage root|escape/
  );
});

test('portable export is deterministic, workspace scoped, deduplicated, and excludes tombstones by default', async (t) => {
  const directory = await tempArtifactsRoot(t);
  const exportDirectory = await tempArtifactsRoot(t, 'oaf export ');
  await rm(exportDirectory, { recursive: true, force: true });
  const provider = new FilesystemArtifactStore({ root: directory, clock: () => '2026-06-19T10:00:00.000Z' });
  const first = await provider.put({ workspaceId: 'ws_local', body: 'same', filename: 'a.txt' });
  const second = await provider.put({ workspaceId: 'ws_local', body: 'same', filename: 'b.txt' });
  const other = await provider.put({ workspaceId: 'ws_other', body: 'same', filename: 'other.txt' });
  await provider.removeRecord({ workspaceId: 'ws_local', id: first.id, reason: 'exclude deleted' });

  const exported = await provider.exportWorkspace({ workspaceId: 'ws_local', destination: exportDirectory });
  assert.equal(exported.ok, true);
  assert.equal(exported.manifest.records.length, 1);
  assert.equal(exported.manifest.records[0].id, second.id);
  assert.equal(exported.manifest.objects.length, 1);
  assert.equal(exported.manifest.objects[0].contentHash, second.contentHash);
  assert.equal(exported.manifest.records.some((record) => record.id === other.id), false);
  assert.equal(JSON.stringify(exported.manifest).includes(directory), false);
  assert.match(exported.manifest.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal((await readFile(path.join(exportDirectory, 'manifest.json'), 'utf8')).includes('tombstones'), false);

  const exportDirectoryWithTombstones = await tempArtifactsRoot(t, 'oaf export tombstones ');
  await rm(exportDirectoryWithTombstones, { recursive: true, force: true });
  const withTombstones = await provider.exportWorkspace({ workspaceId: 'ws_local', destination: exportDirectoryWithTombstones, includeTombstones: true });
  assert.equal(withTombstones.manifest.tombstones.length, 1);

  const catalog = await adapterCatalog();
  assert.equal(catalog.adapters.every((adapter) => adapter.enabledByDefault === false), true);
});
