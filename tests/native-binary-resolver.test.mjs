import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  NATIVE_TARGETS,
  nativePackageForTarget,
  nativeTarget,
  resolveNativeBinary
} from '../providers/native/code-intelligence-rust/src/binary-resolver.mjs';

test('native target selection is explicit and rejects unsupported runtimes', () => {
  assert.deepEqual(NATIVE_TARGETS, [
    'darwin-arm64',
    'darwin-x64',
    'linux-arm64-gnu',
    'linux-x64-gnu',
    'win32-x64'
  ]);
  assert.equal(nativeTarget({ platform: 'darwin', arch: 'arm64' }), 'darwin-arm64');
  assert.equal(nativeTarget({ platform: 'darwin', arch: 'x64' }), 'darwin-x64');
  assert.equal(nativeTarget({ platform: 'linux', arch: 'x64', glibcVersion: '2.39' }), 'linux-x64-gnu');
  assert.equal(nativeTarget({ platform: 'linux', arch: 'arm64', glibcVersion: '2.39' }), 'linux-arm64-gnu');
  assert.equal(nativeTarget({ platform: 'win32', arch: 'x64' }), 'win32-x64');
  assert.throws(
    () => nativeTarget({ platform: 'linux', arch: 'x64', glibcVersion: null }),
    (error) => error.code === 'native_platform_unsupported'
  );
  assert.throws(
    () => nativeTarget({ platform: 'win32', arch: 'arm64' }),
    (error) => error.code === 'native_platform_unsupported'
  );
  assert.equal(nativePackageForTarget('darwin-arm64').packageName, '@memory-recall/native-darwin-arm64');
});

test('packaged native binary requires contained manifest checksum and exact version', async (t) => {
  const fixture = await nativePackageFixture(t);
  const selected = await fixture.resolve();
  assert.equal(selected.source, 'platform-package');
  assert.equal(selected.target, 'darwin-arm64');
  assert.equal(selected.packageName, '@memory-recall/native-darwin-arm64');
  assert.equal(selected.version, '2.0.0');
  assert.equal(selected.verified, true);
  assert.equal(selected.sha256, await sha256(fixture.binary));

  await writeFile(fixture.binary, '#!/bin/sh\nprintf "oaf 2.0.0\\n"\n# tampered\n');
  await chmod(fixture.binary, 0o755);
  await assert.rejects(fixture.resolve(), (error) => error.code === 'native_engine_checksum_mismatch');
});

test('packaged native binary rejects version mismatch and path escape', async (t) => {
  const versionFixture = await nativePackageFixture(t, { versionOutput: 'oaf 9.9.9' });
  await assert.rejects(versionFixture.resolve(), (error) => error.code === 'native_engine_version_mismatch');

  const escapeFixture = await nativePackageFixture(t);
  const outside = path.join(escapeFixture.root, 'outside-oaf');
  await writeExecutable(outside, 'oaf 2.0.0');
  await rm(escapeFixture.binary);
  await symlink(outside, escapeFixture.binary);
  await escapeFixture.writeManifest(await sha256(outside));
  await assert.rejects(escapeFixture.resolve(), (error) => error.code === 'native_engine_path_invalid');
});

test('source checkout binary is used only through an explicit development path', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-native-checkout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = path.join(root, 'rust', 'target', 'release', process.platform === 'win32' ? 'oaf.exe' : 'oaf');
  await mkdir(path.join(root, 'native-packages'), { recursive: true });
  await mkdir(path.dirname(binary), { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{"name":"memory-recall","version":"2.0.0"}\n');
  await writeExecutable(binary, 'oaf 2.0.0');
  const options = {
    target: 'darwin-arm64',
    packageRoot: root,
    resolvePackageJson: async () => { throw new Error('not installed'); }
  };
  await assert.rejects(resolveNativeBinary(options), (error) => error.code === 'native_platform_package_missing');
  const selected = await resolveNativeBinary({ ...options, binaryPath: binary });
  assert.equal(selected.path, await realpath(binary));
  assert.equal(selected.source, 'explicit');
  assert.equal(selected.verified, false);
});

test('explicit binaries must report the exact package version', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-native-version-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = path.join(root, 'rust', 'target', 'release', 'oaf');
  await mkdir(path.join(root, 'native-packages'), { recursive: true });
  await mkdir(path.dirname(binary), { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{"name":"memory-recall","version":"2.0.0"}\n');
  await writeExecutable(binary, 'oaf 9.9.9');

  await assert.rejects(
    resolveNativeBinary({ binaryPath: binary, target: 'darwin-arm64', packageRoot: root }),
    (error) => error.code === 'native_engine_version_mismatch'
  );
});

async function nativePackageFixture(t, { versionOutput = 'oaf 2.0.0' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-native-resolver-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'memory-recall');
  const nativeRoot = path.join(root, 'native-darwin-arm64');
  const binary = path.join(nativeRoot, 'bin', 'oaf');
  const packageJson = path.join(nativeRoot, 'package.json');
  await mkdir(path.dirname(binary), { recursive: true });
  await mkdir(packageRoot, { recursive: true });
  await writeFile(path.join(packageRoot, 'package.json'), '{"name":"memory-recall","version":"2.0.0"}\n');
  await writeFile(packageJson, '{"name":"@memory-recall/native-darwin-arm64","version":"2.0.0"}\n');
  await writeExecutable(binary, versionOutput);
  const writeManifest = async (checksum) => writeFile(
    path.join(nativeRoot, 'native-manifest.json'),
    `${JSON.stringify({
      schemaVersion: '1.0.0',
      packageName: '@memory-recall/native-darwin-arm64',
      packageVersion: '2.0.0',
      target: 'darwin-arm64',
      binary: 'bin/oaf',
      sha256: checksum
    }, null, 2)}\n`
  );
  await writeManifest(await sha256(binary));
  return {
    root,
    binary,
    writeManifest,
    resolve: () => resolveNativeBinary({
      target: 'darwin-arm64',
      packageRoot,
      resolvePackageJson: async () => packageJson
    })
  };
}

async function writeExecutable(file, versionOutput) {
  await writeFile(file, `#!/bin/sh\nprintf "${versionOutput}\\n"\n`);
  await chmod(file, 0o755);
}

async function sha256(file) {
  return `sha256:${createHash('sha256').update(await readFile(file)).digest('hex')}`;
}
