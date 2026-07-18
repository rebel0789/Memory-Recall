import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildNativeDistributionReceipt, buildNativeManifest, buildNativeSpdxSbom, buildPublishedPackageJson, NATIVE_TARGETS, spawnNpmSync } from '../scripts/package-native-platform.mjs';

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

test('native packaging invokes npm through the cross-platform JavaScript CLI', () => {
  const result = spawnNpmSync(['--version'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/u);
});

test('native CI retains a sanitized per-target receipt only after the consumer gate passes', async () => {
  const packageReport = {
    target: 'linux-x64-gnu',
    packageName: '@memory-recall/native-linux-x64-gnu',
    version: '1.1.1',
    tarball: '/private/runner/output/memory-recall-native-linux-x64-gnu-1.1.1.tgz',
    binarySha256: `sha256:${'a'.repeat(64)}`,
    entryCount: 5,
    size: 1024,
    unpackedSize: 4096,
    files: ['LICENSE', 'NOTICE', 'bin/oaf', 'native-manifest.json', 'package.json'].map((file, index) => ({
      path: file,
      size: index + 1,
      sha1: String(index + 1).repeat(40),
      sha256: String(index + 1).repeat(64)
    }))
  };
  const sbomReport = {
    name: 'native-package-linux-x64-gnu.spdx.json',
    sha256: `sha256:${'d'.repeat(64)}`
  };
  const sbom = buildNativeSpdxSbom({
    packageReport,
    commit: 'b'.repeat(40),
    created: '2026-07-18T00:00:00Z',
    tarballSha256: `sha256:${'c'.repeat(64)}`
  });
  assert.equal(sbom.spdxVersion, 'SPDX-2.3');
  assert.equal(sbom.documentNamespace, `https://github.com/rebel0789/Memory-Recall/sbom/${'b'.repeat(40)}/linux-x64-gnu/1.1.1/${'c'.repeat(64)}`);
  assert.equal(sbom.packages[0].checksums[0].checksumValue, 'c'.repeat(64));
  assert.equal(sbom.files.length, 5);
  assert.equal(sbom.packages[0].filesAnalyzed, true);
  const receipt = buildNativeDistributionReceipt({
    packageReport,
    commit: 'b'.repeat(40),
    runner: 'ubuntu-22.04',
    tarballSha256: `sha256:${'c'.repeat(64)}`,
    sbomReport,
    consumerGateResult: 'pass'
  });
  assert.deepEqual(receipt, {
    schemaVersion: '1.0.0',
    receiptVersion: 'memory-recall-native-distribution-1',
    commit: 'b'.repeat(40),
    runner: 'ubuntu-22.04',
    target: 'linux-x64-gnu',
    abi: { platform: 'linux', arch: 'x64', libc: 'glibc' },
    package: {
      name: '@memory-recall/native-linux-x64-gnu',
      version: '1.1.1',
      tarball: 'memory-recall-native-linux-x64-gnu-1.1.1.tgz',
      binarySha256: `sha256:${'a'.repeat(64)}`,
      tarballSha256: `sha256:${'c'.repeat(64)}`,
      sbom: sbomReport.name,
      sbomSha256: sbomReport.sha256,
      entryCount: 5,
      size: 1024,
      unpackedSize: 4096
    },
    consumerGate: {
      command: 'node scripts/native-code-intelligence-consumer-smoke.mjs',
      result: 'pass'
    },
    artifactState: { signed: false, published: false, signature: null }
  });
  assert.doesNotMatch(JSON.stringify(receipt), /\/private\/|\/Users\/|\/home\//u);
  const signedReceipt = buildNativeDistributionReceipt({
    packageReport,
    commit: 'b'.repeat(40),
    runner: 'ubuntu-22.04',
    tarballSha256: `sha256:${'c'.repeat(64)}`,
    sbomReport,
    consumerGateResult: 'pass',
    packageAttestation: {
      id: '12345',
      url: 'https://github.com/rebel0789/Memory-Recall/attestations/12345'
    }
  });
  assert.deepEqual(signedReceipt.artifactState, {
    signed: true,
    published: false,
    signature: {
      kind: 'github-sigstore-provenance',
      attestationId: '12345',
      attestationUrl: 'https://github.com/rebel0789/Memory-Recall/attestations/12345'
    }
  });
  assert.throws(
    () => buildNativeDistributionReceipt({ packageReport, commit: 'b'.repeat(40), runner: 'ubuntu-22.04', tarballSha256: `sha256:${'c'.repeat(64)}`, sbomReport, consumerGateResult: 'fail' }),
    /requires a passing consumer gate/u
  );

  const workflow = await readFile('.github/workflows/rust.yml', 'utf8');
  const consumerStep = workflow.indexOf('Verify exact artifact in installed consumer');
  const receiptStep = workflow.indexOf('Record sanitized native package receipt');
  const packageAttestationStep = workflow.indexOf('Attest native package provenance');
  const sbomAttestationStep = workflow.indexOf('Attest native package SBOM');
  const receiptAttestationStep = workflow.indexOf('Attest native receipt provenance');
  const uploadStep = workflow.indexOf('Upload native package and receipt');
  assert(consumerStep >= 0 && consumerStep < packageAttestationStep && packageAttestationStep < sbomAttestationStep);
  assert(sbomAttestationStep < receiptStep);
  assert(receiptStep < receiptAttestationStep && receiptAttestationStep < uploadStep);
  assert.match(workflow, /buildNativeDistributionReceipt/u);
  assert.match(workflow, /report\.files\.map/u);
  assert.match(workflow, /createHash\('sha1'\)/u);
  assert.match(workflow, /consumerGateResult: 'pass'/u);
  assert.match(workflow, /uses: actions\/attest@v4/u);
  assert.match(workflow, /sbom-path: output\/native-package-\$\{\{ matrix\.target \}\}\.spdx\.json/u);
  assert.match(workflow, /output\/native-package-\*-receipt\.json/u);
});
