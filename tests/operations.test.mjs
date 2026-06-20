import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileStateStore } from '../packages/storage/src/file-store.mjs';
import { FilesystemArtifactStore } from '../providers/native/artifact-filesystem/src/index.mjs';
import {
  createDiagnosticsReport,
  createOperationsBackup,
  createRollbackPlan,
  restoreOperationsBackup,
  verifyDeploymentProfiles,
  verifyOperationsBackup
} from '../packages/operations/src/index.mjs';

async function tempDir(t, prefix = 'oaf operations ') {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function migrationStatus() {
  return {
    ok: true,
    ledgerTable: 'oaf_schema_migrations',
    plan: [
      { version: 1, name: 'init', filename: '001_init.sql', checksum: '1'.repeat(64), state: 'applied' },
      { version: 2, name: 'identity', filename: '002_identity.sql', checksum: '2'.repeat(64), state: 'applied' }
    ],
    appliedMigrations: [
      { version: 1, name: 'init', checksum: '1'.repeat(64), appliedAt: '2026-06-20T00:00:00.000Z' },
      { version: 2, name: 'identity', checksum: '2'.repeat(64), appliedAt: '2026-06-20T00:00:00.000Z' }
    ]
  };
}

async function seededStateStore(directory) {
  const store = await new FileStateStore(directory).init();
  await store.update((state) => {
    state.runs.push({ id: 'run_ops', workspaceId: 'ws_ops', status: 'completed' });
    state.events.push({ id: 'evt_ops_1', runId: 'run_ops', sequence: 1, type: 'run.started' });
    state.events.push({ id: 'evt_ops_2', runId: 'run_ops', sequence: 2, type: 'run.completed' });
    state.memories.push({ id: 'mem_ops', workspaceId: 'ws_ops', status: 'active' });
    return state;
  });
  return store;
}

test('operations backup restores state and content-addressed artifacts with checksums intact', async (t) => {
  const root = await tempDir(t);
  const stateStore = await seededStateStore(path.join(root, 'state'));
  const artifacts = new FilesystemArtifactStore({ root: path.join(root, 'artifacts'), clock: () => '2026-06-20T00:00:00.000Z' });
  const artifact = await artifacts.put({ workspaceId: 'ws_ops', body: 'ops artifact', mediaType: 'text/plain', filename: 'ops.txt' });
  const deleted = await artifacts.put({ workspaceId: 'ws_ops', body: 'old artifact', mediaType: 'text/plain', retention: { mode: 'expire-at', expiresAt: '2026-06-19T00:00:00.000Z' } });
  await artifacts.removeRecord({ workspaceId: 'ws_ops', id: deleted.id, reason: 'retention rehearsal', allowExpired: true });

  const backupRoot = path.join(root, 'backup');
  const backup = await createOperationsBackup({
    workspaceId: 'ws_ops',
    destination: backupRoot,
    stateStore,
    artifactStore: artifacts,
    migrationStatus: migrationStatus(),
    appVersion: '0.2.0-dev',
    deploymentProfile: 'workstation',
    createdAt: '2026-06-20T00:00:00.000Z'
  });

  assert.equal(backup.ok, true);
  assert.equal(backup.manifest.externalWritesEnabled, false);
  assert.equal(backup.manifest.components.state.events, 2);
  assert.equal(backup.manifest.components.artifacts.records, 1);
  assert.equal(backup.manifest.components.artifacts.tombstones, 1);
  assert.match(backup.stateChecksum, /^sha256:[a-f0-9]{64}$/);
  assert.equal((await verifyOperationsBackup({ source: backupRoot, appVersion: '0.2.0-dev' })).ok, true);

  const restoredArtifacts = new FilesystemArtifactStore({ root: path.join(root, 'restored-artifacts') });
  const restored = await restoreOperationsBackup({
    source: backupRoot,
    stateDirectory: path.join(root, 'restored-state'),
    artifactStore: restoredArtifacts,
    appVersion: '0.2.0-dev'
  });

  assert.equal(restored.ok, true);
  assert.equal(restored.externalWritesEnabled, false);
  const restoredState = JSON.parse(await readFile(path.join(root, 'restored-state', 'state.json'), 'utf8'));
  assert.deepEqual(restoredState.events.map((event) => event.sequence), [1, 2]);
  assert.equal((await restoredArtifacts.get({ workspaceId: 'ws_ops', id: artifact.id })).body.toString('utf8'), 'ops artifact');
  assert.equal((await restoredArtifacts.listTombstones({ workspaceId: 'ws_ops' })).length, 1);
  assert.equal((await restoredArtifacts.verifyIntegrity({ workspaceId: 'ws_ops', includeDeleted: true })).ok, true);

  const artifactManifestPath = path.join(backupRoot, 'artifacts', 'ws_ops', 'manifest.json');
  const artifactManifest = JSON.parse(await readFile(artifactManifestPath, 'utf8'));
  await writeFile(artifactManifestPath, `${JSON.stringify({ ...artifactManifest, records: [], objects: [] }, null, 2)}\n`);
  const corruptedArtifacts = await verifyOperationsBackup({ source: backupRoot, appVersion: '0.2.0-dev' });
  assert.equal(corruptedArtifacts.ok, false);
  assert.ok(corruptedArtifacts.findings.some((finding) => finding.code === 'artifact_manifest_fingerprint_mismatch'));
  await assert.rejects(
    () => restoreOperationsBackup({ source: backupRoot, stateDirectory: path.join(root, 'corrupt-restore'), artifactStore: new FilesystemArtifactStore({ root: path.join(root, 'corrupt-artifacts') }), appVersion: '0.2.0-dev' }),
    (error) => error.code === 'backup_verification_failed'
  );
});

test('operations backup fails closed for corruption, incompatible versions, and unsafe external writes', async (t) => {
  const root = await tempDir(t, 'oaf operations failure ');
  const stateStore = await seededStateStore(path.join(root, 'state'));
  const backupRoot = path.join(root, 'backup');
  await assert.rejects(() => createOperationsBackup({
    workspaceId: 'ws_ops',
    destination: backupRoot,
    stateStore,
    migrationStatus: migrationStatus(),
    appVersion: '0.2.0-dev',
    createdAt: '2026-06-20T00:00:00.000Z',
    externalWritesEnabled: true
  }), (error) => error.code === 'external_writes_enabled');

  await createOperationsBackup({
    workspaceId: 'ws_ops',
    destination: backupRoot,
    stateStore,
    migrationStatus: migrationStatus(),
    appVersion: '0.2.0-dev',
    createdAt: '2026-06-20T00:00:00.000Z'
  });
  await writeFile(path.join(backupRoot, 'state', 'state.json'), '{"runs":[],"events":[{"runId":"r","sequence":2},{"runId":"r","sequence":2}],"memories":[],"approvals":[],"artifacts":[]}\n');

  const corrupt = await verifyOperationsBackup({ source: backupRoot, appVersion: '0.2.0-dev' });
  assert.equal(corrupt.ok, false);
  assert.ok(corrupt.findings.some((finding) => finding.code === 'state_checksum_mismatch' || finding.code === 'state_verification_failed'));
  await assert.rejects(() => restoreOperationsBackup({ source: backupRoot, stateDirectory: path.join(root, 'restore'), appVersion: '0.2.0-dev' }), (error) => error.code === 'backup_verification_failed');

  const incompatible = await verifyOperationsBackup({ source: backupRoot, appVersion: '2.0.0' });
  assert.equal(incompatible.ok, false);
  assert.ok(incompatible.findings.some((finding) => finding.code === 'version_incompatible'));
});

test('operations utilities verify deployment profiles, redact diagnostics, and create rollback plans', async () => {
  const composeText = await readFile(new URL('../deploy/compose/compose.yaml', import.meta.url), 'utf8');
  const profiles = verifyDeploymentProfiles({ composeText });
  assert.equal(profiles.ok, true);
  assert.equal(profiles.externalWritesDefault, false);
  assert.equal(profiles.productionReady, false);

  const diagnostics = createDiagnosticsReport({
    generatedAt: '2026-06-20T00:00:00.000Z',
    health: {
      databaseUrl: 'postgres://user:secret-password@127.0.0.1/oaf',
      localPath: '/Users/rebel/private/state.json',
      status: 'degraded'
    },
    logs: [{ message: 'failed at /tmp/private with token abc', token: 'abc' }],
    incidents: [{ severity: 'high', body: 'raw private body' }]
  });
  assert.equal(JSON.stringify(diagnostics).includes('secret-password'), false);
  assert.equal(JSON.stringify(diagnostics).includes('/Users/rebel'), false);
  assert.equal(JSON.stringify(diagnostics).includes('raw private body'), false);
  assert.equal(diagnostics.credentialsIncluded, false);
  assert.equal(diagnostics.localPathsIncluded, false);

  const rollback = createRollbackPlan({
    currentVersion: '0.2.0-dev',
    targetVersion: '0.2.0-dev',
    backupManifest: { id: 'opsbak_123' },
    reason: 'upgrade rehearsal failed',
    generatedAt: '2026-06-20T00:00:00.000Z'
  });
  assert.equal(rollback.externalWritesMustRemainDisabled, true);
  assert.ok(rollback.steps.some((step) => step.includes('restore into an isolated workspace')));
});
