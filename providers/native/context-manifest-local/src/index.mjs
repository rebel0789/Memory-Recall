import { lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { compareContextManifests, verifyContextManifest } from '../../../../packages/context-compiler/src/index.mjs';
import { nowIso } from '../../../../packages/protocol/src/index.mjs';

const PROVIDER_ID = 'provider:native:context-manifest:local';
const WORKSPACE_PATTERN = /^ws_[A-Za-z0-9._:-]{1,120}$|^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MANIFEST_ID_PATTERN = /^ctx_[A-Za-z0-9._:-]{1,120}$/;

function providerError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function assertWorkspaceId(value) {
  if (typeof value !== 'string' || !WORKSPACE_PATTERN.test(value) || value.includes('/') || value.includes('\\') || value === '.' || value === '..') {
    throw new TypeError('contextManifest.workspaceId is invalid');
  }
  return value;
}

function assertManifestId(value) {
  if (typeof value !== 'string' || !MANIFEST_ID_PATTERN.test(value) || value.includes('/') || value.includes('\\')) {
    throw new TypeError('contextManifest.id is invalid');
  }
  return value;
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
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

export class FilesystemContextManifestRepository {
  constructor({
    root = '.local/context-manifests',
    maxManifestBytes = 512 * 1024,
    maxListLimit = 1000,
    clock = nowIso
  } = {}) {
    this.root = path.resolve(root);
    this.maxManifestBytes = maxManifestBytes;
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
        layout: 'workspace-scoped-context-manifests-v1',
        maxManifestBytes: this.maxManifestBytes
      }
    };
  }

  async capabilities() {
    return [
      'context-manifest.append',
      'context-manifest.get',
      'context-manifest.listByRun',
      'context-manifest.compare',
      'context-manifest.verify',
      'context-manifest.immutable',
      'context-manifest.workspace-scoped'
    ];
  }

  async append({ workspaceId, manifest }) {
    assertWorkspaceId(workspaceId);
    assertManifestId(manifest?.id);
    if (manifest.workspaceId !== workspaceId) throw providerError('manifest_workspace_mismatch', 'manifest workspace does not match append workspace', { workspaceId, manifestId: manifest.id });
    if (jsonBytes(manifest) > this.maxManifestBytes) throw providerError('manifest_too_large', 'context manifest exceeds provider byte limit', { maxManifestBytes: this.maxManifestBytes });
    await this.#ensureWorkspace(workspaceId);
    const filename = this.#manifestPath(workspaceId, manifest.id);
    await this.#assertInsideRoot(filename);
    if (await exists(filename)) {
      const existing = await this.#readManifestFile(filename);
      if (existing.manifestFingerprint !== manifest.manifestFingerprint) {
        throw providerError('manifest_identity_conflict', 'same context manifest id has a different fingerprint', { workspaceId, manifestId: manifest.id });
      }
      return existing;
    }
    const verification = verifyContextManifest(manifest);
    if (!verification.valid) throw providerError('manifest_invalid', `context manifest verification failed: ${verification.code}`, { manifestId: manifest.id, code: verification.code });
    const tmp = `${filename}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(tmp, filename);
    return structuredClone(manifest);
  }

  async get({ workspaceId, id }) {
    assertWorkspaceId(workspaceId);
    assertManifestId(id);
    const filename = this.#manifestPath(workspaceId, id);
    await this.#assertInsideRoot(filename);
    if (!await exists(filename)) return null;
    return this.#readManifestFile(filename);
  }

  async listByRun({ workspaceId, runId, limit = 100 }) {
    assertWorkspaceId(workspaceId);
    if (typeof runId !== 'string' || !runId) throw new TypeError('contextManifest.runId is required');
    const boundedLimit = Math.max(1, Math.min(this.maxListLimit, Number(limit) || 100));
    const directory = this.#workspaceManifestDir(workspaceId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await this.#assertInsideRoot(directory);
    const entries = await readdir(directory, { withFileTypes: true });
    const manifests = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.endsWith('.tmp')) continue;
      const manifest = await this.#readManifestFile(path.join(directory, entry.name));
      if (manifest.runId === runId) manifests.push(manifest);
    }
    return manifests
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || a.id.localeCompare(b.id))
      .slice(0, boundedLimit);
  }

  async compare({ workspaceId, leftId, rightId }) {
    const left = await this.get({ workspaceId, id: leftId });
    const right = await this.get({ workspaceId, id: rightId });
    if (!left || !right) throw providerError('manifest_not_found', 'context manifest not found for comparison', { workspaceId, leftId, rightId });
    return compareContextManifests(left, right);
  }

  async verify({ workspaceId, id }) {
    const manifest = await this.get({ workspaceId, id });
    if (!manifest) return { valid: false, code: 'manifest_not_found', manifestId: id };
    return verifyContextManifest(manifest);
  }

  #workspaceManifestDir(workspaceId) {
    return path.join(this.root, 'workspaces', assertWorkspaceId(workspaceId), 'manifests');
  }

  #manifestPath(workspaceId, id) {
    return path.join(this.#workspaceManifestDir(workspaceId), `${assertManifestId(id)}.json`);
  }

  async #ensureRoot() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.#assertNoSymlinkAncestors(this.root);
  }

  async #ensureWorkspace(workspaceId) {
    await this.#ensureRoot();
    const directory = this.#workspaceManifestDir(workspaceId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await this.#assertInsideRoot(directory);
  }

  async #readManifestFile(filename) {
    await this.#assertNoSymlinkAncestors(filename);
    const manifest = JSON.parse(await readFile(filename, 'utf8'));
    const verification = verifyContextManifest(manifest);
    if (!verification.valid) throw providerError('manifest_tampered', `context manifest failed verification: ${verification.code}`, { manifestId: manifest?.id ?? null, code: verification.code });
    return manifest;
  }

  async #assertInsideRoot(target) {
    await this.#ensureRoot();
    const rootResolved = path.resolve(this.root);
    const targetResolved = path.resolve(target);
    if (targetResolved !== rootResolved && !targetResolved.startsWith(`${rootResolved}${path.sep}`)) {
      throw providerError('manifest_path_escape', 'context manifest path escapes provider root');
    }
    await this.#assertNoSymlinkAncestors(path.dirname(target));
  }

  async #assertNoSymlinkAncestors(target) {
    let current = path.resolve(target);
    const rootPath = path.parse(current).root;
    while (current && current !== rootPath) {
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) throw providerError('manifest_path_symlink', 'context manifest path contains a symlink');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (current === this.root) break;
      current = path.dirname(current);
    }
  }
}
