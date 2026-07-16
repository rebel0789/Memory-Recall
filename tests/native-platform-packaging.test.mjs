import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildNativeManifest, buildPublishedPackageJson, NATIVE_TARGETS } from '../scripts/package-native-platform.mjs';

const rootPackage = JSON.parse(await readFile('package.json', 'utf8'));
const packageLock = JSON.parse(await readFile('package-lock.json', 'utf8'));

test('native platform package metadata stays aligned with the public package and Cargo version', async () => {
  const cargoToml = await readFile('rust/Cargo.toml', 'utf8');
  const cargoSection = cargoToml.match(/\[workspace\.package\]([\s\S]*?)(?:\n\[|$)/u)?.[1] ?? '';
  assert.equal(cargoSection.match(/^version\s*=\s*"([^"]+)"/mu)?.[1], rootPackage.version);
  assert.match(await readFile('rust/oaf/src/main.rs', 'utf8'), /const SERVER_VERSION: &str = env!\("CARGO_PKG_VERSION"\);/u);
  assert(rootPackage.workspaces.includes('native-packages/*'));

  const expectedTargets = Object.keys(NATIVE_TARGETS).sort();
  assert.deepEqual(expectedTargets, [
    'darwin-arm64',
    'darwin-x64',
    'linux-arm64-gnu',
    'linux-x64-gnu',
    'win32-x64'
  ]);
  for (const target of expectedTargets) {
    const template = JSON.parse(await readFile(`native-packages/${target}/package.json`, 'utf8'));
    const packageName = `@memory-recall/native-${target}`;
    assert.equal(template.name, packageName);
    assert.equal(template.version, rootPackage.version);
    assert.equal(rootPackage.optionalDependencies[packageName], rootPackage.version);
    assert.equal(packageLock.packages[''].optionalDependencies[packageName], rootPackage.version);
    assert.equal(packageLock.packages[`native-packages/${target}`].version, rootPackage.version);
    assert.equal(packageLock.packages[`node_modules/${packageName}`].resolved, `native-packages/${target}`);
    const manifest = buildNativeManifest({ template, target, binarySha256: 'a'.repeat(64) });
    assert.deepEqual(Object.keys(manifest), ['schemaVersion', 'packageName', 'packageVersion', 'target', 'binary', 'sha256']);
    assert.equal(manifest.packageVersion, rootPackage.version);
    assert.equal(manifest.target, target);
    assert.equal(manifest.binary, NATIVE_TARGETS[target].binary);
    assert.equal(manifest.sha256, `sha256:${'a'.repeat(64)}`);
    const published = buildPublishedPackageJson(template, target);
    assert.deepEqual(published.os, [NATIVE_TARGETS[target].platform]);
    assert.deepEqual(published.cpu, [NATIVE_TARGETS[target].arch]);
    assert.deepEqual(published.libc ?? [], NATIVE_TARGETS[target].libc ? [NATIVE_TARGETS[target].libc] : []);
  }
});
