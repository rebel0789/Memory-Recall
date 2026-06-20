import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  loadReviewedToolCatalog,
  stableToolFingerprint
} from '../packages/tool-registry/src/index.mjs';

async function tempRoot(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oaf tool catalog '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'manifests with spaces'), { recursive: true });
  return directory;
}

function manifest(overrides = {}) {
  return {
    schemaVersion: '1.1.0',
    contractVersion: '1.0.0',
    id: 'tool:fixture-read',
    name: 'Fixture read',
    version: '1.0.0',
    handlerBindingId: 'handler:brokered:workspace-file-read@1.0.0',
    operations: {
      readFile: {
        sideEffectClass: 'read-only',
        inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string', minLength: 1, maxLength: 120 } } },
        outputSchema: { type: 'object', additionalProperties: false, required: ['path', 'sha256', 'byteSize'], properties: { path: { type: 'string' }, sha256: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' }, byteSize: { type: 'integer', minimum: 0 } } },
        filesystem: { read: ['workspace:root'], write: [] },
        network: [],
        secretReferences: [],
        dataClasses: ['workspace-private'],
        sandbox: 'brokered-filesystem-read',
        limits: { runtimeMs: 500, inputBytes: 1024, outputBytes: 2048 },
        approval: { required: false },
        idempotency: { required: false }
      }
    },
    ...overrides
  };
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

async function sha256File(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

test('reviewed catalog loads only checksum-pinned enabled manifests from explicit paths with spaces', async (t) => {
  const root = await tempRoot(t);
  const manifestPath = path.join(root, 'manifests with spaces', 'read.json');
  await writeJson(manifestPath, manifest());
  const checksum = await sha256File(manifestPath);
  const catalogPath = await writeJson(path.join(root, 'catalog.json'), {
    schemaVersion: '1.0.0',
    entries: [{
      toolId: 'tool:fixture-read',
      manifestPath: 'manifests with spaces/read.json',
      sha256: checksum,
      enabled: true,
      handlerBindingId: 'handler:brokered:workspace-file-read@1.0.0',
      reviewStatus: 'reviewed',
      reviewVersion: 'OAF-015'
    }]
  });
  await writeJson(path.join(root, 'manifests with spaces', 'unlisted.json'), manifest({ id: 'tool:unlisted' }));

  const catalog = await loadReviewedToolCatalog({ catalogPath, manifestRoot: root });
  assert.equal(catalog.tools.length, 1);
  assert.equal(catalog.get('tool:fixture-read').manifestFingerprint, stableToolFingerprint(manifest()));
  assert.equal(catalog.get('tool:unlisted'), null);
});

test('catalog loader fails closed for checksum mismatch, duplicates, unknown fields, unsupported schema, and symlink escape', async (t) => {
  const root = await tempRoot(t);
  const manifestPath = path.join(root, 'manifests with spaces', 'read.json');
  await writeJson(manifestPath, manifest());
  const checksum = await sha256File(manifestPath);

  async function loadWith(entry, extraCatalog = {}) {
    const catalogPath = await writeJson(path.join(root, `catalog-${Math.random()}.json`), {
      schemaVersion: '1.0.0',
      entries: [entry],
      ...extraCatalog
    });
    return loadReviewedToolCatalog({ catalogPath, manifestRoot: root });
  }

  await assert.rejects(loadWith({ toolId: 'tool:fixture-read', manifestPath: 'manifests with spaces/read.json', sha256: '0'.repeat(64), enabled: true, handlerBindingId: 'handler:brokered:workspace-file-read@1.0.0', reviewStatus: 'reviewed', reviewVersion: 'OAF-015' }), /tool_manifest_checksum_mismatch/);
  await assert.rejects(loadWith({ toolId: 'tool:fixture-read', manifestPath: 'manifests with spaces/read.json', sha256: checksum, enabled: true, handlerBindingId: 'handler:brokered:workspace-file-read@1.0.0', reviewStatus: 'reviewed', reviewVersion: 'OAF-015' }, { entries: [
    { toolId: 'tool:fixture-read', manifestPath: 'manifests with spaces/read.json', sha256: checksum, enabled: true, handlerBindingId: 'handler:brokered:workspace-file-read@1.0.0', reviewStatus: 'reviewed', reviewVersion: 'OAF-015' },
    { toolId: 'tool:fixture-read', manifestPath: 'manifests with spaces/read.json', sha256: checksum, enabled: true, handlerBindingId: 'handler:brokered:workspace-file-read@1.0.0', reviewStatus: 'reviewed', reviewVersion: 'OAF-015' }
  ] }), /tool_manifest_invalid/);
  await assert.rejects(loadWith({ toolId: 'tool:fixture-read', manifestPath: 'manifests with spaces/read.json', sha256: checksum, enabled: true, handlerBindingId: 'handler:brokered:workspace-file-read@1.0.0', reviewStatus: 'reviewed', reviewVersion: 'OAF-015', surprise: true }), /tool_manifest_invalid/);

  const badSchemaPath = path.join(root, 'manifests with spaces', 'bad-schema.json');
  await writeJson(badSchemaPath, manifest({ schemaVersion: '9.9.9' }));
  await assert.rejects(loadWith({ toolId: 'tool:fixture-read', manifestPath: 'manifests with spaces/bad-schema.json', sha256: await sha256File(badSchemaPath), enabled: true, handlerBindingId: 'handler:brokered:workspace-file-read@1.0.0', reviewStatus: 'reviewed', reviewVersion: 'OAF-015' }), /tool_manifest_invalid/);

  const unsupportedKeywordPath = path.join(root, 'manifests with spaces', 'bad-keyword.json');
  await writeJson(unsupportedKeywordPath, manifest({ operations: { readFile: { ...manifest().operations.readFile, inputSchema: { type: 'object', oneOf: [{ type: 'object' }] } } } }));
  await assert.rejects(loadWith({ toolId: 'tool:fixture-read', manifestPath: 'manifests with spaces/bad-keyword.json', sha256: await sha256File(unsupportedKeywordPath), enabled: true, handlerBindingId: 'handler:brokered:workspace-file-read@1.0.0', reviewStatus: 'reviewed', reviewVersion: 'OAF-015' }), /tool_manifest_invalid/);

  const outside = path.join(root, '..', `outside-${Date.now()}.json`);
  await writeJson(outside, manifest());
  t.after(() => rm(outside, { force: true }));
  await symlink(outside, path.join(root, 'manifests with spaces', 'escape.json'));
  await assert.rejects(loadWith({ toolId: 'tool:fixture-read', manifestPath: 'manifests with spaces/escape.json', sha256: await sha256File(outside), enabled: true, handlerBindingId: 'handler:brokered:workspace-file-read@1.0.0', reviewStatus: 'reviewed', reviewVersion: 'OAF-015' }), /tool_manifest_invalid/);
});
