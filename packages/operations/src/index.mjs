import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalStringify, sha256Hex as sha256 } from '../../protocol/src/index.mjs';

export const OPERATIONS_VERSION = '0.1.0';
export const BACKUP_SCHEMA_VERSION = '1.0.0';

const WORKSPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_PROFILE_NAMES = new Set(['bootstrap', 'workstation', 'team']);
const PRIVATE_KEY_PATTERN = /(^|[-_.])(authorization|cookie|token|secret|password|credential|signedheaders|signed_headers|providerurl|provider_url|localpath|local_path|prompt|output|body|hiddenreasoning|hidden_reasoning|sql)([-_.]|$)/i;
const POSTGRES_URL_PATTERN = /(postgres(?:ql)?:\/\/[^:\s/@]+:)([^@\s]+)(@)/gi;
const LOCAL_PATH_PATTERN = /\/Users\/[^\s"']+|\/tmp\/[^\s"']+|\/var\/[^\s"']+|[A-Za-z]:\\[^\s"']+/g;

function operationsError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function requireWorkspaceId(value) {
  if (typeof value !== 'string' || !WORKSPACE_PATTERN.test(value)) throw operationsError('workspace_invalid', 'workspaceId is invalid');
  return value;
}

function requireIso(value, name) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || !value.includes('T')) throw operationsError('timestamp_invalid', `${name} must be an ISO timestamp`);
  return value;
}

function assertPlainObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw operationsError('input_invalid', `${name} must be an object`);
  return value;
}

async function exists(filename) {
  try {
    await stat(filename);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function ensureEmptyDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entries = await readdir(directory);
  if (entries.length) throw operationsError('destination_not_empty', 'backup destination must be empty', { destination: '[LOCAL_PATH]' });
}

async function writeJsonAtomic(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, filename);
}

async function readJson(filename) {
  return JSON.parse(await readFile(filename, 'utf8'));
}

function hashFileBytes(bytes) {
  return `sha256:${sha256(bytes)}`;
}

async function readHashedJson(filename) {
  const bytes = await readFile(filename);
  return { value: JSON.parse(bytes.toString('utf8')), sha256: hashFileBytes(bytes), byteSize: bytes.byteLength };
}

function validateStateShape(state) {
  assertPlainObject(state, 'state');
  for (const key of ['runs', 'events', 'memories', 'approvals', 'artifacts']) {
    if (!Array.isArray(state[key])) throw operationsError('state_invalid', `state.${key} must be an array`);
  }
  const eventsByRun = new Map();
  for (const event of state.events) {
    if (!event || typeof event !== 'object') throw operationsError('state_invalid', 'events must be objects');
    const runId = event.runId ?? 'unknown';
    const sequence = Number(event.sequence ?? event.seq ?? 0);
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw operationsError('state_invalid', 'event sequence must be a non-negative integer');
    if (!eventsByRun.has(runId)) eventsByRun.set(runId, []);
    eventsByRun.get(runId).push(sequence);
  }
  for (const [runId, sequences] of eventsByRun) {
    const sorted = [...sequences].sort((a, b) => a - b);
    for (let index = 1; index < sorted.length; index += 1) {
      if (sorted[index] <= sorted[index - 1]) throw operationsError('state_invalid', `event sequence is not monotonic for ${runId}`);
    }
  }
  return state;
}

function scopeStateToWorkspace(state, workspaceId) {
  const runs = state.runs.filter((run) => run.workspaceId === workspaceId);
  const runIds = new Set(runs.map((run) => run.id).filter(Boolean));
  const runIdCounts = new Map();
  for (const run of state.runs) {
    if (!run.id) continue;
    runIdCounts.set(run.id, (runIdCounts.get(run.id) ?? 0) + 1);
  }
  const belongsByWorkspace = (record) => record?.workspaceId === workspaceId;
  const belongsByUniqueRun = (record) => (
    !record?.workspaceId &&
    record?.runId &&
    runIds.has(record.runId) &&
    runIdCounts.get(record.runId) === 1
  );
  return {
    ...state,
    runs,
    events: state.events.filter((event) => belongsByWorkspace(event) || belongsByUniqueRun(event)),
    memories: state.memories.filter(belongsByWorkspace),
    approvals: state.approvals.filter((approval) => belongsByWorkspace(approval) || belongsByUniqueRun(approval)),
    artifacts: state.artifacts.filter(belongsByWorkspace)
  };
}

function normalizeMigrationStatus(status) {
  assertPlainObject(status, 'migrationStatus');
  const plan = Array.isArray(status.plan) ? status.plan.map((item) => ({
    version: Number(item.version),
    name: String(item.name),
    checksum: String(item.checksum),
    filename: item.filename ? String(item.filename) : null,
    state: String(item.state)
  })) : [];
  const appliedMigrations = Array.isArray(status.appliedMigrations) ? status.appliedMigrations.map((item) => ({
    version: Number(item.version),
    name: String(item.name),
    checksum: String(item.checksum),
    appliedAt: item.appliedAt ?? item.applied_at ?? null
  })) : [];
  const checksumMismatch = plan.some((item) => item.state === 'checksum_mismatch');
  return {
    ok: status.ok !== false && !checksumMismatch,
    ledgerTable: status.ledgerTable ?? 'oaf_schema_migrations',
    plan,
    appliedMigrations
  };
}

function appVersionCompatible(backupVersion, currentVersion) {
  if (typeof backupVersion !== 'string' || typeof currentVersion !== 'string') return false;
  if (backupVersion === currentVersion) return true;
  const backupMajor = backupVersion.split('.')[0];
  const currentMajor = currentVersion.split('.')[0];
  return backupMajor === currentMajor && backupVersion.includes('-dev') && currentVersion.includes('-dev');
}

export function redactDiagnosticValue(value) {
  if (typeof value === 'string') {
    return value
      .replace(POSTGRES_URL_PATTERN, '$1[REDACTED]$3')
      .replace(LOCAL_PATH_PATTERN, '[LOCAL_PATH]');
  }
  if (Array.isArray(value)) return value.map((item) => redactDiagnosticValue(item));
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = PRIVATE_KEY_PATTERN.test(key) ? '[REDACTED]' : redactDiagnosticValue(nested);
    }
    return output;
  }
  return value;
}

export function createDiagnosticsReport({ generatedAt, health = {}, incidents = [], logs = [] } = {}) {
  return {
    schemaVersion: '1.0.0',
    operationsVersion: OPERATIONS_VERSION,
    generatedAt: requireIso(generatedAt, 'generatedAt'),
    health: redactDiagnosticValue(health),
    incidents: redactDiagnosticValue(incidents),
    logs: redactDiagnosticValue(logs),
    rawBodiesIncluded: false,
    credentialsIncluded: false,
    localPathsIncluded: false
  };
}

export function verifyDeploymentProfiles({ composeText }) {
  if (typeof composeText !== 'string' || !composeText.trim()) throw operationsError('compose_invalid', 'composeText is required');
  const findings = [];
  const requireText = (code, pattern) => {
    if (!pattern.test(composeText)) findings.push({ code });
  };
  requireText('app_loopback_port_missing', /ports:\s*\["127\.0\.0\.1:4310:4310"\]/);
  requireText('app_external_writes_not_disabled', /OAF_ALLOW_EXTERNAL_WRITES:\s*"false"/);
  requireText('app_network_not_disabled', /OAF_ALLOW_NETWORK:\s*"false"/);
  requireText('app_read_only_missing', /read_only:\s*true/);
  requireText('postgres_pgvector_image_missing', /image:\s*pgvector\/pgvector:pg16/);
  requireText('otel_loopback_missing', /127\.0\.0\.1:4318:4318/);
  requireText('ollama_loopback_missing', /127\.0\.0\.1:11434:11434/);
  return {
    schemaVersion: '1.0.0',
    operationsVersion: OPERATIONS_VERSION,
    ok: findings.length === 0,
    profiles: [...SAFE_PROFILE_NAMES],
    findings,
    externalWritesDefault: false,
    networkDefault: 'deny',
    productionReady: false
  };
}

export function createRollbackPlan({ currentVersion, targetVersion, backupManifest, reason, generatedAt }) {
  assertPlainObject(backupManifest, 'backupManifest');
  return {
    schemaVersion: '1.0.0',
    operationsVersion: OPERATIONS_VERSION,
    generatedAt: requireIso(generatedAt, 'generatedAt'),
    currentVersion,
    targetVersion,
    backupId: backupManifest.id,
    reason: String(reason ?? 'operator rollback'),
    externalWritesMustRemainDisabled: true,
    steps: [
      'stop the affected OAF service',
      'preserve current logs, handoff metadata, repository SHA, and backup manifest without copying secrets',
      'verify the selected backup manifest, checksums, migration ledger, and artifact hashes',
      'restore into an isolated workspace first',
      'run read-only health, migration status, artifact integrity, and representative queries',
      'switch traffic only after verification passes',
      'keep external writes disabled until a human approval boundary re-enables them'
    ]
  };
}

export async function createOperationsBackup({
  workspaceId,
  destination,
  stateStore,
  artifactStore = null,
  migrationStatus,
  appVersion,
  deploymentProfile = 'bootstrap',
  backupId = null,
  createdAt,
  externalWritesEnabled = false
} = {}) {
  const normalizedWorkspace = requireWorkspaceId(workspaceId);
  if (externalWritesEnabled !== false) throw operationsError('external_writes_enabled', 'backup requires external writes disabled');
  if (!SAFE_PROFILE_NAMES.has(deploymentProfile)) throw operationsError('deployment_profile_invalid', 'deployment profile is unsupported');
  if (!stateStore || typeof stateStore.read !== 'function') throw operationsError('state_store_invalid', 'stateStore.read is required');
  const backupRoot = path.resolve(destination);
  await ensureEmptyDirectory(backupRoot);
  const timestamp = requireIso(createdAt, 'createdAt');

  const state = validateStateShape(scopeStateToWorkspace(validateStateShape(await stateStore.read()), normalizedWorkspace));
  const statePath = path.join(backupRoot, 'state', 'state.json');
  await writeJsonAtomic(statePath, state);
  const stateBytes = await readFile(statePath);

  let artifactComponent = null;
  if (artifactStore) {
    if (typeof artifactStore.exportWorkspace !== 'function') throw operationsError('artifact_store_invalid', 'artifactStore.exportWorkspace is required');
    const artifactExport = await artifactStore.exportWorkspace({
      workspaceId: normalizedWorkspace,
      destination: path.join(backupRoot, 'artifacts', normalizedWorkspace),
      includeTombstones: true
    });
    if (!artifactExport.ok) throw operationsError('artifact_export_failed', 'artifact export failed integrity verification');
    artifactComponent = {
      provider: artifactExport.provider,
      manifestPath: path.join('artifacts', normalizedWorkspace, 'manifest.json'),
      fingerprint: artifactExport.manifest.fingerprint,
      records: artifactExport.manifest.records.length,
      objects: artifactExport.manifest.objects.length,
      tombstones: artifactExport.manifest.tombstones?.length ?? 0
    };
  }

  const migrations = normalizeMigrationStatus(migrationStatus);
  const migrationPath = path.join(backupRoot, 'migrations', 'status.json');
  await writeJsonAtomic(migrationPath, migrations);
  const migrationBytes = await readFile(migrationPath);

  const manifest = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    id: backupId ?? `opsbak_${sha256(`${normalizedWorkspace}:${timestamp}:${appVersion}`).slice(0, 32)}`,
    operationsVersion: OPERATIONS_VERSION,
    workspaceId: normalizedWorkspace,
    appVersion,
    deploymentProfile,
    createdAt: timestamp,
    externalWritesEnabled: false,
    components: {
      state: {
        path: 'state/state.json',
        sha256: hashFileBytes(stateBytes),
        byteSize: stateBytes.byteLength,
        runs: state.runs.length,
        events: state.events.length,
        memories: state.memories.length,
        approvals: state.approvals.length,
        artifacts: state.artifacts.length
      },
      artifacts: artifactComponent,
      migrations: {
        path: 'migrations/status.json',
        sha256: hashFileBytes(migrationBytes),
        byteSize: migrationBytes.byteLength,
        ok: migrations.ok,
        ledgerTable: migrations.ledgerTable,
        planned: migrations.plan.length,
        applied: migrations.appliedMigrations.length
      }
    },
    compatibility: {
      restoreRequiresSameMajorVersion: true,
      restoreRequiresMigrationChecksumMatch: true,
      restoreRequiresExternalWritesDisabled: true
    },
    fingerprintAlgorithm: 'sha256'
  };
  manifest.fingerprint = `sha256:${sha256(canonicalStringify(manifest))}`;
  await writeJsonAtomic(path.join(backupRoot, 'manifest.json'), manifest);
  await writeFile(path.join(backupRoot, 'manifest.json.sha256'), `${hashFileBytes(await readFile(path.join(backupRoot, 'manifest.json')))}  manifest.json\n`, { mode: 0o600 });
  return {
    ok: true,
    backupRoot,
    manifest,
    stateChecksum: manifest.components.state.sha256,
    migrationChecksum: manifest.components.migrations.sha256,
    artifactFingerprint: artifactComponent?.fingerprint ?? null
  };
}

export async function verifyOperationsBackup({ source, appVersion = null } = {}) {
  const backupRoot = path.resolve(source);
  const findings = [];
  let manifest = null;
  try {
    manifest = await readJson(path.join(backupRoot, 'manifest.json'));
  } catch (error) {
    return { ok: false, findings: [{ code: 'manifest_unreadable', message: error.message }], manifest: null };
  }

  if (manifest.schemaVersion !== BACKUP_SCHEMA_VERSION) findings.push({ code: 'manifest_schema_unsupported' });
  if (manifest.externalWritesEnabled !== false) findings.push({ code: 'external_writes_not_disabled' });
  if (appVersion && !appVersionCompatible(manifest.appVersion, appVersion)) findings.push({ code: 'version_incompatible', backupVersion: manifest.appVersion, currentVersion: appVersion });
  const { fingerprint, ...fingerprintInput } = manifest;
  if (fingerprint !== `sha256:${sha256(canonicalStringify(fingerprintInput))}`) findings.push({ code: 'manifest_fingerprint_mismatch' });
  try {
    const checksumLine = await readFile(path.join(backupRoot, 'manifest.json.sha256'), 'utf8');
    const manifestBytes = await readFile(path.join(backupRoot, 'manifest.json'));
    const expectedChecksum = `${hashFileBytes(manifestBytes)}  manifest.json`;
    if (checksumLine.trim() !== expectedChecksum) findings.push({ code: 'manifest_checksum_mismatch' });
  } catch (error) {
    findings.push({ code: 'manifest_checksum_unreadable', message: error.message });
  }

  for (const [component, descriptor] of Object.entries(manifest.components ?? {})) {
    if (!descriptor) continue;
    if (!descriptor.path) continue;
    try {
      const file = await readHashedJson(path.join(backupRoot, descriptor.path));
      if (file.sha256 !== descriptor.sha256) findings.push({ code: `${component}_checksum_mismatch`, expected: descriptor.sha256, actual: file.sha256 });
      if (component === 'state') validateStateShape(file.value);
      if (component === 'migrations' && file.value.ok !== true) findings.push({ code: 'migration_status_not_ok' });
    } catch (error) {
      findings.push({ code: `${component}_verification_failed`, message: error.message });
    }
  }

  const artifactDescriptor = manifest.components?.artifacts;
  if (artifactDescriptor) {
    try {
      const artifactManifest = await readJson(path.join(backupRoot, artifactDescriptor.manifestPath));
      const { fingerprint: artifactFingerprint, ...artifactFingerprintInput } = artifactManifest;
      const recomputedArtifactFingerprint = sha256(canonicalStringify(artifactFingerprintInput));
      if (artifactFingerprint !== recomputedArtifactFingerprint || artifactFingerprint !== artifactDescriptor.fingerprint) {
        findings.push({ code: 'artifact_manifest_fingerprint_mismatch' });
      }
      for (const object of artifactManifest.objects ?? []) {
        const objectPath = path.join(path.dirname(path.join(backupRoot, artifactDescriptor.manifestPath)), object.relativePath);
        const body = await readFile(objectPath);
        if (hashFileBytes(body) !== `sha256:${object.contentHash}` || body.byteLength !== object.byteSize) findings.push({ code: 'artifact_object_checksum_mismatch', contentHash: object.contentHash });
      }
    } catch (error) {
      findings.push({ code: 'artifact_verification_failed', message: error.message });
    }
  }

  return { ok: findings.length === 0, findings, manifest };
}

export async function restoreOperationsBackup({ source, stateDirectory, artifactStore = null, appVersion = null } = {}) {
  const verification = await verifyOperationsBackup({ source, appVersion });
  if (!verification.ok) throw operationsError('backup_verification_failed', 'backup verification failed before restore', { findings: verification.findings });
  const backupRoot = path.resolve(source);
  const stateTarget = path.resolve(stateDirectory);
  await mkdir(stateTarget, { recursive: true, mode: 0o700 });
  const state = await readJson(path.join(backupRoot, verification.manifest.components.state.path));
  validateStateShape(state);
  await writeJsonAtomic(path.join(stateTarget, 'state.json'), state);

  let artifactImport = null;
  if (artifactStore && verification.manifest.components.artifacts) {
    if (typeof artifactStore.importWorkspaceExport !== 'function') throw operationsError('artifact_store_invalid', 'artifactStore.importWorkspaceExport is required');
    artifactImport = await artifactStore.importWorkspaceExport({
      source: path.join(backupRoot, 'artifacts', verification.manifest.workspaceId),
      workspaceId: verification.manifest.workspaceId,
      includeTombstones: true
    });
    if (!artifactImport.ok) throw operationsError('artifact_restore_failed', 'artifact import failed integrity verification');
  }

  return {
    ok: true,
    backupId: verification.manifest.id,
    workspaceId: verification.manifest.workspaceId,
    appVersion: verification.manifest.appVersion,
    stateRestored: true,
    artifactImport,
    externalWritesEnabled: false
  };
}
