import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileStateStore } from '../packages/storage/src/file-store.mjs';
import { FilesystemArtifactStore } from '../providers/native/artifact-filesystem/src/index.mjs';
import {
  createDiagnosticsReport,
  createOperationsBackup,
  restoreOperationsBackup,
  verifyDeploymentProfiles,
  verifyOperationsBackup
} from '../packages/operations/src/index.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'oaf-operations-smoke-'));
try {
  const stateStore = await new FileStateStore(path.join(root, 'state')).init();
  await stateStore.update((state) => {
    state.runs.push({ id: 'run_ops_smoke', workspaceId: 'ws_ops_smoke', status: 'completed' });
    state.events.push({ id: 'evt_ops_smoke_1', runId: 'run_ops_smoke', sequence: 1, type: 'run.started' });
    state.events.push({ id: 'evt_ops_smoke_2', runId: 'run_ops_smoke', sequence: 2, type: 'run.completed' });
    return state;
  });

  const artifacts = new FilesystemArtifactStore({ root: path.join(root, 'artifacts'), clock: () => '2026-06-20T00:00:00.000Z' });
  const artifact = await artifacts.put({ workspaceId: 'ws_ops_smoke', body: 'operations smoke artifact', mediaType: 'text/plain' });
  const backup = await createOperationsBackup({
    workspaceId: 'ws_ops_smoke',
    destination: path.join(root, 'backup'),
    stateStore,
    artifactStore: artifacts,
    migrationStatus: {
      ok: true,
      ledgerTable: 'oaf_schema_migrations',
      plan: [{ version: 1, name: 'init', filename: '001_init.sql', checksum: '1'.repeat(64), state: 'applied' }],
      appliedMigrations: [{ version: 1, name: 'init', checksum: '1'.repeat(64), appliedAt: '2026-06-20T00:00:00.000Z' }]
    },
    appVersion: '0.2.0-dev',
    deploymentProfile: 'bootstrap',
    createdAt: '2026-06-20T00:00:00.000Z'
  });
  if (!backup.ok) throw new Error('operations backup failed');
  const verification = await verifyOperationsBackup({ source: backup.backupRoot, appVersion: '0.2.0-dev' });
  if (!verification.ok) throw new Error(`operations backup verification failed: ${JSON.stringify(verification.findings)}`);

  const restoredArtifacts = new FilesystemArtifactStore({ root: path.join(root, 'restored-artifacts') });
  const restored = await restoreOperationsBackup({
    source: backup.backupRoot,
    stateDirectory: path.join(root, 'restored-state'),
    artifactStore: restoredArtifacts,
    appVersion: '0.2.0-dev'
  });
  if (!restored.ok) throw new Error('operations restore failed');
  const restoredState = JSON.parse(await readFile(path.join(root, 'restored-state', 'state.json'), 'utf8'));
  if (restoredState.events.length !== 2) throw new Error('restored state event count mismatch');
  const restoredArtifact = await restoredArtifacts.get({ workspaceId: 'ws_ops_smoke', id: artifact.id });
  if (restoredArtifact.body.toString('utf8') !== 'operations smoke artifact') throw new Error('restored artifact mismatch');

  const composeText = await readFile('deploy/compose/compose.yaml', 'utf8');
  const profiles = verifyDeploymentProfiles({ composeText });
  if (!profiles.ok) throw new Error(`deployment profile verification failed: ${JSON.stringify(profiles.findings)}`);

  const diagnostics = createDiagnosticsReport({
    generatedAt: '2026-06-20T00:00:00.000Z',
    health: { status: 'healthy', localPath: path.join(root, 'state'), databaseUrl: 'postgres://user:password@127.0.0.1/oaf' },
    logs: [{ message: `restore verified in ${root}`, token: 'secret' }]
  });
  if (JSON.stringify(diagnostics).includes(root) || JSON.stringify(diagnostics).includes('password') || JSON.stringify(diagnostics).includes('secret')) {
    throw new Error('diagnostics redaction failed');
  }

  await mkdir(path.join(root, 'corrupt'), { recursive: true });
  await writeFile(path.join(root, 'corrupt', 'README.txt'), 'not a backup');
  const corrupt = await verifyOperationsBackup({ source: path.join(root, 'corrupt'), appVersion: '0.2.0-dev' });
  if (corrupt.ok) throw new Error('corrupt backup unexpectedly verified');

  console.log(`PASS operations backup ${backup.manifest.id}`);
  console.log(`PASS operations restore ${restored.backupId}`);
  console.log('PASS operations deployment profiles');
  console.log('PASS operations diagnostics redaction');
  console.log('PASS operations corruption failure');
} finally {
  await rm(root, { recursive: true, force: true });
}
