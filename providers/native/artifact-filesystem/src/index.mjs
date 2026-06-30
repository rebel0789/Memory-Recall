import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nowIso } from '../../../../packages/protocol/src/index.mjs';
import { canonicalStringify, sha256Hex as sha256 } from '../../../../packages/protocol/src/fingerprint.mjs';

const PROVIDER_ID = 'provider:native:artifact:filesystem';
const WORKSPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const RECORD_ID_PATTERN = /^(art|src)_[A-Za-z0-9._-]{16,128}$/;
const TOMBSTONE_ID_PATTERN = /^tmb_[A-Za-z0-9._-]{16,160}$/;
const MEDIA_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;
const DATA_CLASSES = new Set(['public', 'workspace-private', 'sensitive']);
const RETENTION_MODES = new Set(['workspace-default', 'retain', 'expire-at', 'legal-hold']);
const SNAPSHOT_FORBIDDEN_KEYS = new Set([
  'observed',
  'inferred',
  'summary',
  'summaries',
  'classification',
  'classifications',
  'hook',
  'hooks',
  'modelConclusion',
  'modelConclusions',
  'memoryDecision',
  'memoryDecisions',
  'analysis',
  'claims'
]);
const SENSITIVE_KEY_PATTERN = /(^|[-_.])(authorization|cookie|token|secret|password|credential|signedheaders|signed_headers)([-_.]|$)/i;

function exportManifestFingerprint(manifest) {
  const { fingerprint, ...fingerprintInput } = manifest;
  return sha256(canonicalStringify(fingerprintInput));
}

function safeWorkspace(value) {
  if (typeof value !== 'string' || !WORKSPACE_PATTERN.test(value)) throw new Error('workspaceId contains unsupported characters');
  return value;
}

function safeRecordId(value) {
  if (typeof value !== 'string' || !RECORD_ID_PATTERN.test(value)) throw new Error('record id contains unsupported characters');
  return value;
}

function safeHash(value) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) throw new Error('artifact hash must be sha256 hex');
  return value;
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  throw new TypeError('body must be a string, Buffer, or Uint8Array');
}

function requirePlainObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value;
}

function jsonByteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function normalizeMediaType(value, maxMediaTypeLength) {
  const mediaType = value ?? 'application/octet-stream';
  if (typeof mediaType !== 'string' || mediaType.length < 3 || mediaType.length > maxMediaTypeLength || !MEDIA_TYPE_PATTERN.test(mediaType)) {
    throw new Error('mediaType must be a valid bounded type/subtype value');
  }
  return mediaType.toLowerCase();
}

function normalizeString(value, name, maxLength, { nullable = true } = {}) {
  if (value === undefined || value === null) {
    if (nullable) return null;
    throw new Error(`${name} is required`);
  }
  if (typeof value !== 'string' || value.length > maxLength) throw new Error(`${name} must be a bounded string`);
  return value;
}

function normalizeDataClass(value) {
  const dataClass = value ?? 'workspace-private';
  if (!DATA_CLASSES.has(dataClass)) throw new Error('dataClass is unsupported');
  return dataClass;
}

function validIsoTimestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) && value.includes('T');
}

function normalizeRetention(value = 'workspace-default') {
  if (typeof value === 'string') value = { mode: value };
  requirePlainObject(value, 'retention');
  const mode = value.mode ?? 'workspace-default';
  if (!RETENTION_MODES.has(mode)) throw new Error('retention mode is unsupported');
  if (mode === 'expire-at') {
    if (!validIsoTimestamp(value.expiresAt)) throw new Error('expire-at retention requires an ISO expiresAt timestamp');
    return { mode, expiresAt: value.expiresAt };
  }
  if (value.expiresAt !== undefined) throw new Error('expiresAt is only valid for expire-at retention');
  return { mode };
}

function assertNoSensitiveKeys(value, pathName = 'metadata') {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) throw new Error(`${pathName}.${key} may contain a secret, credential, token, cookie, or authorization value`);
    if (nested && typeof nested === 'object') assertNoSensitiveKeys(nested, `${pathName}.${key}`);
  }
}

function normalizeMetadata(value, maxMetadataBytes, { rejectSensitive = false } = {}) {
  const metadata = value ?? {};
  requirePlainObject(metadata, 'metadata');
  if (jsonByteLength(metadata) > maxMetadataBytes) throw new Error(`metadata exceeds ${maxMetadataBytes} byte limit`);
  if (rejectSensitive) assertNoSensitiveKeys(metadata);
  return structuredClone(metadata);
}

function validateSourceLocator(value, maxSourceLocatorLength) {
  const sourceLocator = normalizeString(value, 'sourceLocator', maxSourceLocatorLength, { nullable: false });
  try {
    const parsed = new URL(sourceLocator);
    if (parsed.username || parsed.password) throw new Error('sourceLocator must not include URL userinfo');
  } catch (error) {
    if (error.message.includes('userinfo')) throw error;
  }
  if (SENSITIVE_KEY_PATTERN.test(sourceLocator)) throw new Error('sourceLocator must not include credentials or secret tokens');
  return sourceLocator;
}

function logicalRecordId(prefix, recordKey) {
  return `${prefix}_${sha256(canonicalStringify(recordKey)).slice(0, 32)}`;
}

function recordDirectoryName(kind) {
  if (kind === 'artifact') return 'artifacts';
  if (kind === 'source_snapshot') return 'snapshots';
  throw new Error(`unsupported artifact record kind ${kind}`);
}

function recordKindFromId(id) {
  if (id.startsWith('src_')) return 'source_snapshot';
  if (id.startsWith('art_')) return 'artifact';
  throw new Error('unsupported artifact record id prefix');
}

function retentionBlocksDeletion(record) {
  return record?.retention?.mode === 'legal-hold';
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

export class FilesystemArtifactStore {
  constructor({
    root = '.local/artifacts',
    maxBytes = 50 * 1024 * 1024,
    maxMetadataBytes = 64 * 1024,
    maxFilenameLength = 255,
    maxMediaTypeLength = 127,
    maxSourceLocatorLength = 2048,
    maxListLimit = 1000,
    clock = nowIso
  } = {}) {
    this.root = path.resolve(root);
    this.maxBytes = maxBytes;
    this.maxMetadataBytes = maxMetadataBytes;
    this.maxFilenameLength = maxFilenameLength;
    this.maxMediaTypeLength = maxMediaTypeLength;
    this.maxSourceLocatorLength = maxSourceLocatorLength;
    this.maxListLimit = maxListLimit;
    this.clock = clock;
  }

  async health() {
    await this.#ensureRoot();
    const info = await stat(this.root);
    return {
      status: info.isDirectory() ? 'healthy' : 'unavailable',
      local: true,
      details: {
        provider: PROVIDER_ID,
        root: this.root,
        layout: 'workspace-scoped-content-addressed-v1',
        maxBytes: this.maxBytes,
        maxMetadataBytes: this.maxMetadataBytes
      }
    };
  }

  async capabilities() {
    return [
      'artifact.put',
      'artifact.get',
      'artifact.list',
      'artifact.remove',
      'artifact.metadata.get',
      'artifact.body.get',
      'artifact.source-snapshot',
      'artifact.content-addressed',
      'artifact.retention.plan',
      'artifact.retention.apply',
      'artifact.integrity.verify',
      'artifact.export',
      'artifact.import'
    ];
  }

  async put(input) {
    return this.#putRecord({ ...input, kind: 'artifact' });
  }

  async putSourceSnapshot(input) {
    for (const key of SNAPSHOT_FORBIDDEN_KEYS) {
      if (input && Object.prototype.hasOwnProperty.call(input, key)) {
        throw new Error(`source snapshot cannot contain inferred, summary, hook, classification, model conclusion, or memory decision field: ${key}`);
      }
    }
    return this.#putRecord({ ...input, kind: 'source_snapshot' });
  }

  async get({ workspaceId, id = null, hash = null, includeBody = true }) {
    const record = await this.getMetadata({ workspaceId, id, hash });
    if (!record) return null;
    if (!includeBody) return record;
    const body = await this.getBody({ workspaceId, id: record.id });
    return body === null ? null : { ...record, body };
  }

  async getMetadata({ workspaceId, id = null, hash = null }) {
    safeWorkspace(workspaceId);
    const record = id ? await this.#readRecordById(workspaceId, id) : await this.#firstRecordByHash(workspaceId, hash);
    return record ? structuredClone(record) : null;
  }

  async getBody({ workspaceId, id = null, hash = null }) {
    safeWorkspace(workspaceId);
    const record = id ? await this.#readRecordById(workspaceId, id) : await this.#firstRecordByHash(workspaceId, hash);
    if (!record) return null;
    const objectPath = this.#objectPath(workspaceId, record.contentHash);
    await this.#assertNoSymlinkAncestors(objectPath);
    try {
      const body = await readFile(objectPath);
      if (sha256(body) !== record.contentHash) throw new Error('artifact body integrity failure');
      if (body.byteLength !== record.byteSize) throw new Error('artifact body size integrity failure');
      return body;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async list({ workspaceId, kind = null, limit = 100 }) {
    safeWorkspace(workspaceId);
    const boundedLimit = this.#boundedLimit(limit);
    const records = await this.#listActiveRecords(workspaceId, kind);
    return records.slice(0, boundedLimit).map((record) => structuredClone(record));
  }

  async listTombstones({ workspaceId, limit = 100 }) {
    safeWorkspace(workspaceId);
    const boundedLimit = this.#boundedLimit(limit);
    const tombstones = await this.#readJsonDirectory(this.#tombstoneDir(workspaceId), (entry) => entry.name.endsWith('.json'));
    return tombstones
      .filter((item) => item.workspaceId === workspaceId)
      .sort((a, b) => a.recordId.localeCompare(b.recordId))
      .slice(0, boundedLimit)
      .map((item) => structuredClone(item));
  }

  async remove(input) {
    const receipt = await this.removeRecord(input);
    return receipt.deleted;
  }

  async removeRecord({ workspaceId, id = null, hash = null, reason = 'explicit deletion', deletedBy = 'system', allowExpired = false } = {}) {
    safeWorkspace(workspaceId);
    const record = id ? await this.#readRecordById(workspaceId, id) : await this.#firstRecordByHash(workspaceId, hash);
    if (!record) {
      return {
        schemaVersion: '1.0.0',
        provider: PROVIDER_ID,
        workspaceId,
        recordId: id ?? null,
        contentHash: hash ?? null,
        deleted: false,
        bodyDeleted: false,
        reason,
        deletedAt: this.clock()
      };
    }
    if (retentionBlocksDeletion(record)) throw new Error('record is under legal hold and cannot be deleted');
    if (!allowExpired && record.retention?.mode === 'expire-at' && validIsoTimestamp(record.retention.expiresAt) && Date.parse(record.retention.expiresAt) > Date.parse(this.clock())) {
      throw new Error('record retention has not expired');
    }

    const recordPath = this.#recordPath(workspaceId, record.id);
    const tombstone = this.#deletionReceipt({ workspaceId, record, reason, deletedBy, deleted: true, bodyDeleted: false });
    await this.#writeJsonAtomic(this.#tombstonePath(workspaceId, record.id), tombstone);
    await rm(recordPath, { force: true });

    const remaining = await this.#recordsReferencingHash(workspaceId, record.contentHash);
    let bodyDeleted = false;
    if (remaining.length === 0) {
      await rm(this.#objectPath(workspaceId, record.contentHash), { force: true });
      bodyDeleted = true;
    }
    const finalReceipt = { ...tombstone, bodyDeleted };
    await this.#writeJsonAtomic(this.#tombstonePath(workspaceId, record.id), finalReceipt);
    return structuredClone(finalReceipt);
  }

  async planRetention({ workspaceId, at = this.clock(), limit = 100 } = {}) {
    safeWorkspace(workspaceId);
    if (!validIsoTimestamp(at)) throw new Error('retention planning requires an ISO timestamp');
    const boundedLimit = this.#boundedLimit(limit);
    const records = await this.#listActiveRecords(workspaceId);
    const actions = records
      .filter((record) => record.retention?.mode === 'expire-at' && Date.parse(record.retention.expiresAt) <= Date.parse(at))
      .sort((a, b) => a.retention.expiresAt.localeCompare(b.retention.expiresAt) || a.id.localeCompare(b.id))
      .slice(0, boundedLimit)
      .map((record) => ({
        workspaceId,
        recordId: record.id,
        kind: record.kind,
        contentHash: record.contentHash,
        action: 'delete-record',
        reason: 'retention-expired',
        expiresAt: record.retention.expiresAt
      }));
    return { schemaVersion: '1.0.0', provider: PROVIDER_ID, workspaceId, plannedAt: this.clock(), effectiveAt: at, dryRun: true, actions };
  }

  async applyRetention({ workspaceId, at = this.clock(), reason = 'retention-expired', limit = 100 } = {}) {
    const plan = await this.planRetention({ workspaceId, at, limit });
    const applied = [];
    for (const action of plan.actions) {
      const receipt = await this.removeRecord({ workspaceId, id: action.recordId, reason, allowExpired: true });
      applied.push(receipt);
    }
    return { schemaVersion: '1.0.0', provider: PROVIDER_ID, workspaceId, appliedAt: this.clock(), planned: plan.actions, applied };
  }

  async verifyIntegrity({ workspaceId, includeDeleted = false } = {}) {
    safeWorkspace(workspaceId);
    await this.#ensureWorkspaceDirs(workspaceId);
    const findings = [];
    const records = [];
    for (const kind of ['artifact', 'source_snapshot']) {
      const directory = this.#recordDir(workspaceId, kind);
      const entries = await this.#directoryEntries(directory);
      for (const entry of entries) {
        if (entry.name.endsWith('.tmp')) continue;
        if (!entry.name.endsWith('.json')) {
          findings.push({ code: 'unexpected_record_file', path: this.#relative(path.join(directory, entry.name)) });
          continue;
        }
        try {
          const record = JSON.parse(await readFile(path.join(directory, entry.name), 'utf8'));
          records.push(record);
          this.#validateRecordShape(record, workspaceId);
          const objectPath = this.#objectPath(workspaceId, record.contentHash);
          await this.#assertNoSymlinkAncestors(objectPath);
          const body = await readFile(objectPath);
          const actualHash = sha256(body);
          if (actualHash !== record.contentHash) findings.push({ code: 'object_hash_mismatch', recordId: record.id, contentHash: record.contentHash, actualHash });
          if (body.byteLength !== record.byteSize) findings.push({ code: 'object_size_mismatch', recordId: record.id, contentHash: record.contentHash, expected: record.byteSize, actual: body.byteLength });
        } catch (error) {
          findings.push({ code: error.code === 'ENOENT' ? 'object_missing' : 'record_integrity_failure', path: this.#relative(path.join(directory, entry.name)), message: error.message });
        }
      }
    }

    const activeHashes = new Set(records.filter((record) => record.workspaceId === workspaceId).map((record) => record.contentHash));
    const objectPaths = await this.#listObjectPaths(workspaceId);
    for (const objectPath of objectPaths) {
      if (objectPath.endsWith('.tmp')) continue;
      const hash = path.basename(objectPath);
      if (!HASH_PATTERN.test(hash)) findings.push({ code: 'unexpected_body', path: this.#relative(objectPath) });
      else if (!activeHashes.has(hash)) findings.push({ code: 'unexpected_body', contentHash: hash, path: this.#relative(objectPath) });
    }

    const tombstones = await this.listTombstones({ workspaceId, limit: this.maxListLimit });
    for (const tombstone of tombstones) {
      if (!TOMBSTONE_ID_PATTERN.test(tombstone.id) || tombstone.workspaceId !== workspaceId) {
        findings.push({ code: 'tombstone_integrity_failure', recordId: tombstone.recordId ?? null });
      }
      if (!includeDeleted && await this.#readRecordById(workspaceId, tombstone.recordId)) {
        findings.push({ code: 'tombstoned_record_active', recordId: tombstone.recordId });
      }
    }

    return { schemaVersion: '1.0.0', provider: PROVIDER_ID, workspaceId, checkedAt: this.clock(), ok: findings.length === 0, findings };
  }

  async exportWorkspace({ workspaceId, destination, includeTombstones = false, limit = this.maxListLimit } = {}) {
    safeWorkspace(workspaceId);
    if (typeof destination !== 'string' || destination.length === 0) throw new Error('export destination is required');
    const exportRoot = path.resolve(destination);
    if (path.relative(this.root, exportRoot) === '' || !path.relative(this.root, exportRoot).startsWith('..')) {
      throw new Error('export destination must not be inside the artifact storage root');
    }
    if (await exists(exportRoot)) {
      const entries = await readdir(exportRoot);
      if (entries.length) throw new Error('export destination already exists and is not empty');
    }
    await mkdir(exportRoot, { recursive: true, mode: 0o700 });
    await mkdir(path.join(exportRoot, 'records'), { recursive: true, mode: 0o700 });
    await mkdir(path.join(exportRoot, 'objects', 'sha256'), { recursive: true, mode: 0o700 });

    const records = (await this.#listActiveRecords(workspaceId)).slice(0, this.#boundedLimit(limit));
    const objectHashes = [...new Set(records.map((record) => record.contentHash))].sort();
    const objects = [];

    for (const record of records) {
      await this.#writeExportJson(path.join(exportRoot, 'records', `${record.id}.json`), record);
    }
    for (const hash of objectHashes) {
      const relativePath = path.join('objects', 'sha256', hash.slice(0, 2), hash);
      const target = path.join(exportRoot, relativePath);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(this.#objectPath(workspaceId, hash), target);
      const size = (await stat(target)).size;
      if (sha256(await readFile(target)) !== hash) throw new Error(`export verification failed for object ${hash}`);
      objects.push({ hashAlgorithm: 'sha256', contentHash: hash, byteSize: size, relativePath });
    }

    const manifest = {
      schemaVersion: '1.0.0',
      id: `exp_${sha256(`${workspaceId}:${this.clock()}:${records.map((record) => record.id).join(',')}`).slice(0, 32)}`,
      provider: PROVIDER_ID,
      workspaceId,
      exportedAt: this.clock(),
      includeTombstones,
      records: records.map((record) => ({
        id: record.id,
        kind: record.kind,
        contentHash: record.contentHash,
        hashAlgorithm: record.hashAlgorithm,
        byteSize: record.byteSize,
        relativePath: path.join('records', `${record.id}.json`)
      })),
      objects,
      fingerprintAlgorithm: 'sha256'
    };
    if (includeTombstones) {
      const tombstones = await this.listTombstones({ workspaceId, limit: this.maxListLimit });
      await mkdir(path.join(exportRoot, 'tombstones'), { recursive: true, mode: 0o700 });
      for (const tombstone of tombstones) await this.#writeExportJson(path.join(exportRoot, 'tombstones', `${tombstone.recordId}.json`), tombstone);
      manifest.tombstones = tombstones.map((tombstone) => ({ id: tombstone.id, recordId: tombstone.recordId, relativePath: path.join('tombstones', `${tombstone.recordId}.json`) }));
    }
    manifest.records.sort((a, b) => a.id.localeCompare(b.id));
    manifest.objects.sort((a, b) => a.contentHash.localeCompare(b.contentHash));
    if (manifest.tombstones) manifest.tombstones.sort((a, b) => a.recordId.localeCompare(b.recordId));
    manifest.fingerprint = exportManifestFingerprint(manifest);
    await this.#writeExportJson(path.join(exportRoot, 'manifest.json'), manifest);

    const verification = await this.#verifyExport(exportRoot, manifest);
    return { ok: verification.ok, provider: PROVIDER_ID, workspaceId, destination: exportRoot, manifest, verification };
  }

  async importWorkspaceExport({ source, workspaceId = null, includeTombstones = true } = {}) {
    if (typeof source !== 'string' || source.length === 0) throw new Error('import source is required');
    const exportRoot = path.resolve(source);
    const realExportRoot = await realpath(exportRoot);
    await this.#ensureRoot();
    const realStoreRoot = await realpath(this.root);
    const relativeToStore = path.relative(realStoreRoot, realExportRoot);
    if (relativeToStore === '' || (!relativeToStore.startsWith('..') && !path.isAbsolute(relativeToStore))) {
      throw new Error('import source must not be inside the artifact storage root');
    }

    const manifest = await this.#readExportJson(exportRoot, 'manifest.json');
    if (manifest.provider !== PROVIDER_ID) throw new Error('artifact export provider mismatch');
    if (manifest.fingerprint !== exportManifestFingerprint(manifest)) throw new Error('artifact export manifest fingerprint mismatch');
    const restoredWorkspace = safeWorkspace(workspaceId ?? manifest.workspaceId);
    if (manifest.workspaceId !== restoredWorkspace) throw new Error('artifact export workspace mismatch');
    await this.#ensureWorkspaceDirs(restoredWorkspace);

    const importedObjects = new Set();
    for (const object of manifest.objects ?? []) {
      safeHash(object.contentHash);
      const sourcePath = await this.#safeExportPath(exportRoot, object.relativePath);
      const body = await readFile(sourcePath);
      if (sha256(body) !== object.contentHash || body.byteLength !== object.byteSize) throw new Error(`artifact export object integrity failure: ${object.contentHash}`);
      await this.#writeObject(restoredWorkspace, object.contentHash, body);
      importedObjects.add(object.contentHash);
    }

    let importedRecords = 0;
    for (const recordRef of manifest.records ?? []) {
      const record = await this.#readExportJson(exportRoot, recordRef.relativePath);
      this.#validateRecordShape(record, restoredWorkspace);
      if (!importedObjects.has(record.contentHash)) throw new Error(`artifact export missing object for record ${record.id}`);
      await this.#writeImportedJson(this.#recordPath(restoredWorkspace, record.id), record);
      importedRecords += 1;
    }

    let importedTombstones = 0;
    if (includeTombstones) {
      for (const tombstoneRef of manifest.tombstones ?? []) {
        const tombstone = await this.#readExportJson(exportRoot, tombstoneRef.relativePath);
        if (!TOMBSTONE_ID_PATTERN.test(tombstone.id) || tombstone.workspaceId !== restoredWorkspace || tombstone.recordId !== tombstoneRef.recordId) {
          throw new Error(`artifact export tombstone integrity failure: ${tombstoneRef.recordId}`);
        }
        await this.#writeImportedJson(this.#tombstonePath(restoredWorkspace, tombstone.recordId), tombstone);
        importedTombstones += 1;
      }
    }

    const integrity = await this.verifyIntegrity({ workspaceId: restoredWorkspace, includeDeleted: true });
    return {
      ok: integrity.ok,
      provider: PROVIDER_ID,
      workspaceId: restoredWorkspace,
      source: exportRoot,
      imported: {
        records: importedRecords,
        objects: importedObjects.size,
        tombstones: importedTombstones
      },
      manifest,
      integrity
    };
  }

  async #putRecord(input) {
    requirePlainObject(input, 'artifact input');
    const workspaceId = safeWorkspace(input.workspaceId);
    const bytes = toBuffer(input.body);
    if (bytes.byteLength > this.maxBytes) throw new Error(`artifact exceeds ${this.maxBytes} byte limit`);
    const contentHash = sha256(bytes);
    const mediaType = normalizeMediaType(input.mediaType, this.maxMediaTypeLength);
    const filename = normalizeString(input.filename, 'filename', this.maxFilenameLength);
    const dataClass = normalizeDataClass(input.dataClass);
    const retention = normalizeRetention(input.retention);
    const metadata = normalizeMetadata(input.metadata, this.maxMetadataBytes, { rejectSensitive: input.kind === 'source_snapshot' });
    const createdAt = this.clock();
    await this.#ensureWorkspaceDirs(workspaceId);
    await this.#writeObject(workspaceId, contentHash, bytes);

    if (input.kind === 'source_snapshot') {
      const capturedAt = input.capturedAt ?? createdAt;
      if (!validIsoTimestamp(capturedAt)) throw new Error('capturedAt must be an ISO timestamp');
      const collector = normalizeString(input.collector, 'collector', 128, { nullable: false });
      const retrievalMethod = normalizeString(input.retrievalMethod, 'retrievalMethod', 128, { nullable: false });
      const sourceLocator = validateSourceLocator(input.sourceLocator ?? input.sourceIdentifier, this.maxSourceLocatorLength);
      const recordKey = { kind: input.kind, contentHash, mediaType, dataClass, retention, metadata, collector, retrievalMethod, sourceLocator, capturedAt };
      const id = await this.#availableRecordId(workspaceId, logicalRecordId('src', recordKey));
      const record = {
        schemaVersion: '1.0.0',
        id,
        provider: PROVIDER_ID,
        workspaceId,
        kind: 'source_snapshot',
        hashAlgorithm: 'sha256',
        contentHash,
        hash: contentHash,
        byteSize: bytes.byteLength,
        size: bytes.byteLength,
        mediaType,
        filename,
        dataClass,
        retention,
        trust: 'untrusted-external',
        capturedAt,
        createdAt,
        collector,
        retrievalMethod,
        sourceLocator,
        metadata
      };
      return this.#writeOrReadRecord(workspaceId, record);
    }

    const source = normalizeString(input.source ?? 'generated', 'source', this.maxSourceLocatorLength, { nullable: false });
    const recordKey = { kind: input.kind, contentHash, mediaType, filename, dataClass, source, retention, metadata };
    const id = await this.#availableRecordId(workspaceId, logicalRecordId('art', recordKey));
    const record = {
      schemaVersion: '1.0.0',
      id,
      provider: PROVIDER_ID,
      workspaceId,
      kind: 'artifact',
      hashAlgorithm: 'sha256',
      contentHash,
      hash: contentHash,
      byteSize: bytes.byteLength,
      size: bytes.byteLength,
      mediaType,
      filename,
      dataClass,
      retention,
      source,
      createdAt,
      metadata
    };
    return this.#writeOrReadRecord(workspaceId, record);
  }

  async #writeObject(workspaceId, contentHash, bytes) {
    const objectPath = this.#objectPath(workspaceId, contentHash);
    await this.#assertNoSymlinkAncestors(objectPath);
    await mkdir(path.dirname(objectPath), { recursive: true, mode: 0o700 });
    try {
      const existing = await readFile(objectPath);
      if (sha256(existing) !== contentHash || !existing.equals(bytes)) throw new Error('content hash collision or tampering detected');
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const temporary = path.join(path.dirname(objectPath), `.${path.basename(objectPath)}.${process.pid}.${Date.now()}.tmp`);
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, objectPath);
    const stored = await readFile(objectPath);
    if (sha256(stored) !== contentHash || stored.byteLength !== bytes.byteLength) throw new Error('artifact object write verification failed');
  }

  async #writeImportedJson(filename, value) {
    try {
      const existing = JSON.parse(await readFile(filename, 'utf8'));
      if (canonicalStringify(existing) !== canonicalStringify(value)) throw new Error('import target already contains different record');
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await this.#writeJsonAtomic(filename, value);
  }

  async #writeOrReadRecord(workspaceId, record) {
    this.#validateRecordShape(record, workspaceId);
    const recordPath = this.#recordPath(workspaceId, record.id);
    try {
      const existing = JSON.parse(await readFile(recordPath, 'utf8'));
      if (canonicalStringify({ ...existing, createdAt: record.createdAt }) !== canonicalStringify(record)) throw new Error('record id collision detected');
      return structuredClone(existing);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await this.#writeJsonAtomic(recordPath, record);
    return structuredClone(record);
  }

  async #availableRecordId(workspaceId, baseId) {
    const tombstonePath = this.#tombstonePath(workspaceId, baseId);
    if (!await exists(tombstonePath)) return baseId;
    return `${baseId}.${sha256(`${this.clock()}:${process.pid}`).slice(0, 8)}`;
  }

  #validateRecordShape(record, workspaceId) {
    requirePlainObject(record, 'artifact record');
    safeRecordId(record.id);
    if (record.schemaVersion !== '1.0.0') throw new Error('artifact record schema version is unsupported');
    if (record.provider !== PROVIDER_ID) throw new Error('artifact record provider mismatch');
    if (record.workspaceId !== workspaceId) throw new Error('artifact record workspace mismatch');
    if (!['artifact', 'source_snapshot'].includes(record.kind)) throw new Error('artifact record kind is unsupported');
    if (record.hashAlgorithm !== 'sha256') throw new Error('artifact record hash algorithm is unsupported');
    safeHash(record.contentHash);
    if (record.hash !== record.contentHash) throw new Error('artifact record hash alias mismatch');
    if (!Number.isSafeInteger(record.byteSize) || record.byteSize < 0 || record.size !== record.byteSize) throw new Error('artifact record byte size is invalid');
    normalizeMediaType(record.mediaType, this.maxMediaTypeLength);
    normalizeDataClass(record.dataClass);
    normalizeRetention(record.retention);
    normalizeMetadata(record.metadata, this.maxMetadataBytes, { rejectSensitive: record.kind === 'source_snapshot' });
    if (!validIsoTimestamp(record.createdAt)) throw new Error('artifact record createdAt is invalid');
    if (record.kind === 'source_snapshot') {
      if (record.trust !== 'untrusted-external') throw new Error('source snapshot trust must be untrusted-external');
      if (!validIsoTimestamp(record.capturedAt)) throw new Error('source snapshot capturedAt is invalid');
      validateSourceLocator(record.sourceLocator, this.maxSourceLocatorLength);
      normalizeString(record.collector, 'collector', 128, { nullable: false });
      normalizeString(record.retrievalMethod, 'retrievalMethod', 128, { nullable: false });
    }
  }

  async #readRecordById(workspaceId, id) {
    safeRecordId(id);
    const recordPath = this.#recordPath(workspaceId, id);
    try {
      const record = JSON.parse(await readFile(recordPath, 'utf8'));
      this.#validateRecordShape(record, workspaceId);
      return record;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async #firstRecordByHash(workspaceId, hash) {
    safeHash(hash);
    const records = await this.#recordsReferencingHash(workspaceId, hash);
    return records[0] ?? null;
  }

  async #recordsReferencingHash(workspaceId, hash) {
    safeHash(hash);
    return (await this.#listActiveRecords(workspaceId)).filter((record) => record.contentHash === hash);
  }

  async #listActiveRecords(workspaceId, kind = null) {
    await this.#ensureWorkspaceDirs(workspaceId);
    const kinds = kind ? [kind] : ['artifact', 'source_snapshot'];
    const records = [];
    for (const itemKind of kinds) {
      const directory = this.#recordDir(workspaceId, itemKind);
      const items = await this.#readJsonDirectory(directory, (entry) => entry.name.endsWith('.json') && !entry.name.endsWith('.tmp'));
      for (const item of items) {
        this.#validateRecordShape(item, workspaceId);
        records.push(item);
      }
    }
    return records.sort((a, b) => a.id.localeCompare(b.id));
  }

  async #readJsonDirectory(directory, filter) {
    const output = [];
    for (const entry of await this.#directoryEntries(directory)) {
      if (!filter(entry)) continue;
      output.push(JSON.parse(await readFile(path.join(directory, entry.name), 'utf8')));
    }
    return output;
  }

  async #directoryEntries(directory) {
    try {
      return await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async #listObjectPaths(workspaceId) {
    const root = this.#objectsRoot(workspaceId);
    const output = [];
    for (const prefix of await this.#directoryEntries(root)) {
      const prefixPath = path.join(root, prefix.name);
      if (!prefix.isDirectory()) {
        if (!prefix.name.endsWith('.tmp')) output.push(prefixPath);
        continue;
      }
      for (const entry of await this.#directoryEntries(prefixPath)) {
        if (entry.isFile()) output.push(path.join(prefixPath, entry.name));
      }
    }
    return output.sort();
  }

  #deletionReceipt({ workspaceId, record, reason, deletedBy, deleted, bodyDeleted }) {
    return {
      schemaVersion: '1.0.0',
      id: `tmb_${sha256(`${workspaceId}:${record.id}`).slice(0, 40)}`,
      provider: PROVIDER_ID,
      workspaceId,
      recordId: record.id,
      kind: record.kind,
      contentHash: record.contentHash,
      hashAlgorithm: 'sha256',
      deleted,
      bodyDeleted,
      reason: normalizeString(reason, 'reason', 256, { nullable: false }),
      deletedBy: normalizeString(deletedBy, 'deletedBy', 128, { nullable: false }),
      deletedAt: this.clock(),
      retention: record.retention
    };
  }

  async #verifyExport(exportRoot, manifest) {
    const findings = [];
    for (const object of manifest.objects) {
      try {
        const body = await readFile(path.join(exportRoot, object.relativePath));
        if (body.byteLength !== object.byteSize) findings.push({ code: 'export_object_size_mismatch', contentHash: object.contentHash });
        if (sha256(body) !== object.contentHash) findings.push({ code: 'export_object_hash_mismatch', contentHash: object.contentHash });
      } catch (error) {
        findings.push({ code: 'export_object_missing', contentHash: object.contentHash, message: error.message });
      }
    }
    return { schemaVersion: '1.0.0', ok: findings.length === 0, checkedAt: this.clock(), findings };
  }

  async #readExportJson(exportRoot, relativePath) {
    const filename = await this.#safeExportPath(exportRoot, relativePath);
    return JSON.parse(await readFile(filename, 'utf8'));
  }

  async #safeExportPath(exportRoot, relativePath) {
    if (typeof relativePath !== 'string' || !relativePath.length || path.isAbsolute(relativePath)) throw new Error('artifact export path must be relative');
    const normalized = path.normalize(relativePath);
    if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) throw new Error('artifact export path escapes export root');
    const realExportRoot = await realpath(exportRoot);
    const filename = path.resolve(realExportRoot, normalized);
    const relative = path.relative(realExportRoot, filename);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('artifact export path escapes export root');
    let current = realExportRoot;
    for (const segment of normalized.split(path.sep)) {
      current = path.join(current, segment);
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error('artifact export must not contain symlinks');
    }
    return filename;
  }

  async #writeJsonAtomic(filename, value) {
    await this.#assertNoSymlinkAncestors(filename);
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${process.pid}.${Date.now()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, filename);
  }

  async #writeExportJson(filename, value) {
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  }

  async #ensureRoot() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.#assertNoSymlinkAncestors(this.root);
  }

  async #ensureWorkspaceDirs(workspaceId) {
    await this.#ensureRoot();
    const directories = [
      this.#workspaceRoot(workspaceId),
      this.#objectsRoot(workspaceId),
      this.#recordDir(workspaceId, 'artifact'),
      this.#recordDir(workspaceId, 'source_snapshot'),
      this.#tombstoneDir(workspaceId),
      this.#exportsDir(workspaceId)
    ];
    for (const directory of directories) {
      await this.#assertNoSymlinkAncestors(directory);
      await mkdir(directory, { recursive: true, mode: 0o700 });
    }
  }

  async #assertNoSymlinkAncestors(target) {
    const resolved = path.resolve(target);
    if (path.relative(this.root, resolved).startsWith('..') || path.isAbsolute(path.relative(this.root, resolved))) throw new Error('path must remain inside storage root');
    const realRoot = await realpath(this.root);
    const relative = path.relative(this.root, resolved);
    if (!relative) return;
    let current = this.root;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) throw new Error('symlink escape rejected inside artifact storage');
        const real = await realpath(current);
        if (path.relative(realRoot, real).startsWith('..') || path.isAbsolute(path.relative(realRoot, real))) {
          throw new Error('path must remain inside storage root');
        }
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
    }
  }

  #boundedLimit(value) {
    const numeric = Number(value);
    if (!Number.isInteger(numeric) || numeric < 1) throw new Error('limit must be a positive integer');
    return Math.min(numeric, this.maxListLimit);
  }

  #workspaceRoot(workspaceId) {
    return path.join(this.root, 'workspaces', safeWorkspace(workspaceId));
  }

  #objectsRoot(workspaceId) {
    return path.join(this.#workspaceRoot(workspaceId), 'objects', 'sha256');
  }

  #objectPath(workspaceId, hash) {
    const contentHash = safeHash(hash);
    return path.join(this.#objectsRoot(workspaceId), contentHash.slice(0, 2), contentHash);
  }

  #recordDir(workspaceId, kind) {
    return path.join(this.#workspaceRoot(workspaceId), 'records', recordDirectoryName(kind));
  }

  #recordPath(workspaceId, id) {
    const recordId = safeRecordId(id);
    return path.join(this.#recordDir(workspaceId, recordKindFromId(recordId)), `${recordId}.json`);
  }

  #tombstoneDir(workspaceId) {
    return path.join(this.#workspaceRoot(workspaceId), 'tombstones');
  }

  #tombstonePath(workspaceId, recordId) {
    return path.join(this.#tombstoneDir(workspaceId), `${safeRecordId(recordId)}.json`);
  }

  #exportsDir(workspaceId) {
    return path.join(this.#workspaceRoot(workspaceId), 'exports');
  }

  #relative(filename) {
    return path.relative(this.root, filename);
  }
}

export { PROVIDER_ID as FILESYSTEM_ARTIFACT_PROVIDER_ID };
