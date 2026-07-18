import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { NATIVE_TARGETS, spawnNpmSync } from './package-native-platform.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const NATIVE_RELEASE_ORDER = Object.freeze([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64-gnu',
  'linux-x64-gnu',
  'win32-x64'
]);

export async function validateNativeReleaseSet({
  artifactsDirectory,
  expectedVersion,
  expectedCommit,
  rootPackage,
  requireSigned = true
}) {
  if (!/^\d+\.\d+\.\d+$/u.test(expectedVersion ?? '')) throw new Error('release version must be an exact stable version');
  if (!/^[a-f0-9]{40}$/u.test(expectedCommit ?? '')) throw new Error('release commit must be a full Git SHA');
  const artifactsRoot = path.resolve(artifactsDirectory);
  const files = await walk(artifactsRoot);
  const packageJson = rootPackage ?? JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  if (packageJson.name !== 'memory-recall' || packageJson.version !== expectedVersion) {
    throw new Error('root package identity does not match the release version');
  }
  const expectedPackageNames = new Set(NATIVE_RELEASE_ORDER.map((target) => `@memory-recall/native-${target}`));
  const optionalDependencies = packageJson.optionalDependencies ?? {};
  if (Object.keys(optionalDependencies).length !== expectedPackageNames.size) {
    throw new Error('root package must reference exactly the five native packages');
  }
  for (const name of expectedPackageNames) {
    if (optionalDependencies[name] !== expectedVersion) throw new Error(`root native dependency ${name} must use ${expectedVersion}`);
  }

  const receipts = [];
  for (const target of NATIVE_RELEASE_ORDER) {
    const receiptName = `native-package-${target}-receipt.json`;
    const receiptFiles = files.filter((file) => path.basename(file) === receiptName);
    if (receiptFiles.length !== 1) throw new Error(`release set requires exactly one ${receiptName}`);
    const receipt = JSON.parse(await readFile(receiptFiles[0], 'utf8'));
    validateReceipt({ receipt, target, expectedVersion, expectedCommit, requireSigned });

    const tarballFiles = files.filter((file) => path.basename(file) === receipt.package.tarball);
    if (tarballFiles.length !== 1) throw new Error(`release set requires exactly one ${receipt.package.tarball}`);
    const tarballBytes = await readFile(tarballFiles[0]);
    const sha256 = `sha256:${createHash('sha256').update(tarballBytes).digest('hex')}`;
    if (sha256 !== receipt.package.tarballSha256) throw new Error(`${target} tarball checksum does not match its receipt`);

    const sbomFiles = files.filter((file) => path.basename(file) === receipt.package.sbom);
    if (sbomFiles.length !== 1) throw new Error(`release set requires exactly one ${receipt.package.sbom}`);
    const sbomBytes = await readFile(sbomFiles[0]);
    const sbomSha256 = `sha256:${createHash('sha256').update(sbomBytes).digest('hex')}`;
    if (sbomSha256 !== receipt.package.sbomSha256) throw new Error(`${target} SBOM checksum does not match its receipt`);
    validateNativeSbom({
      sbom: JSON.parse(sbomBytes),
      target,
      expectedVersion,
      expectedCommit,
      tarballSha256: sha256
    });
    receipts.push(Object.freeze({
      target,
      packageName: receipt.package.name,
      version: receipt.package.version,
      tarball: path.relative(artifactsRoot, tarballFiles[0]).split(path.sep).join('/'),
      tarballSha256: sha256,
      tarballIntegrity: `sha512-${createHash('sha512').update(tarballBytes).digest('base64')}`,
      sbom: path.relative(artifactsRoot, sbomFiles[0]).split(path.sep).join('/'),
      sbomSha256,
      sbomPredicateType: 'https://spdx.dev/Document/v2.3',
      binarySha256: receipt.package.binarySha256,
      runner: receipt.runner,
      signed: receipt.artifactState.signed
    }));
  }
  return Object.freeze({
    schemaVersion: '1.0.0',
    releaseVersion: expectedVersion,
    releaseCommit: expectedCommit,
    nativePackageCount: receipts.length,
    publishOrder: receipts.map(({ packageName }) => packageName),
    rootPackage: packageJson.name,
    artifacts: receipts
  });
}

export function verifyRegistryRecord(artifact, record) {
  if (record?.version !== artifact.version) throw new Error(`${artifact.packageName}@${artifact.version} is not available on npm`);
  if (record.integrity !== artifact.tarballIntegrity) {
    throw new Error(`${artifact.packageName}@${artifact.version} npm integrity does not match the verified tarball`);
  }
  verifyRegistryProvenance(artifact.packageName, artifact.version, record.attestations);
}

export async function publishNativePackages({ releaseSet, artifactsDirectory, authMode }) {
  for (const artifact of releaseSet.artifacts) {
    let record = registryRecord(artifact.packageName, artifact.version, { allowMissing: true });
    if (!record) {
      const tarball = path.resolve(artifactsDirectory, artifact.tarball);
      const args = ['publish', tarball, '--access', 'public'];
      if (authMode === 'npm-token') args.push('--provenance');
      const published = spawnNpmSync(args, { cwd: ROOT, encoding: 'utf8', env: process.env });
      if (published.status !== 0) throw new Error(`npm publish failed for ${artifact.packageName}: ${published.stderr || published.stdout || published.error?.message || 'unknown error'}`);
      record = await waitForRegistry(artifact.packageName, artifact.version);
    }
    verifyRegistryRecord(artifact, record);
  }
}

async function verifyNativeRegistry(releaseSet) {
  for (const artifact of releaseSet.artifacts) {
    verifyRegistryRecord(artifact, registryRecord(artifact.packageName, artifact.version));
  }
  await auditRegistrySignatures(releaseSet.artifacts.map(({ packageName, version }) => ({ packageName, version })));
}

function validateReceipt({ receipt, target, expectedVersion, expectedCommit, requireSigned }) {
  const expected = NATIVE_TARGETS[target];
  if (!expected) throw new Error(`unsupported native target ${target}`);
  if (receipt?.schemaVersion !== '1.0.0' || receipt?.receiptVersion !== 'memory-recall-native-distribution-1') {
    throw new Error(`${target} receipt version is unsupported`);
  }
  if (receipt.commit !== expectedCommit || receipt.target !== target) throw new Error(`${target} receipt is not from the release commit`);
  if (receipt.abi?.platform !== expected.platform || receipt.abi?.arch !== expected.arch
    || (receipt.abi?.libc ?? null) !== (expected.libc ?? null)) {
    throw new Error(`${target} receipt ABI does not match the target`);
  }
  if (receipt.package?.name !== `@memory-recall/native-${target}` || receipt.package?.version !== expectedVersion) {
    throw new Error(`${target} receipt package identity does not match the release`);
  }
  if (!/^[A-Za-z0-9._-]+\.tgz$/u.test(receipt.package?.tarball ?? '')) throw new Error(`${target} receipt tarball name is invalid`);
  for (const [name, value] of [['binary', receipt.package?.binarySha256], ['tarball', receipt.package?.tarballSha256]]) {
    if (!/^sha256:[a-f0-9]{64}$/u.test(value ?? '')) throw new Error(`${target} ${name} checksum is invalid`);
  }
  if (receipt.package?.sbom !== `native-package-${target}.spdx.json`
    || !/^sha256:[a-f0-9]{64}$/u.test(receipt.package?.sbomSha256 ?? '')) {
    throw new Error(`${target} receipt SBOM metadata is invalid`);
  }
  if (receipt.consumerGate?.command !== 'node scripts/native-code-intelligence-consumer-smoke.mjs'
    || receipt.consumerGate?.result !== 'pass') {
    throw new Error(`${target} receipt does not contain a passing consumer gate`);
  }
  if (receipt.artifactState?.published !== false) throw new Error(`${target} receipt must describe an unpublished artifact`);
  if (requireSigned && receipt.artifactState?.signed !== true) throw new Error(`${target} artifact is not signed`);
  if (requireSigned && (receipt.artifactState?.signature?.kind !== 'github-sigstore-provenance'
    || !/^[1-9][0-9]*$/u.test(receipt.artifactState.signature.attestationId ?? '')
    || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/attestations\/[1-9][0-9]*$/u.test(receipt.artifactState.signature.attestationUrl ?? ''))) {
    throw new Error(`${target} receipt does not identify its signed provenance`);
  }
}

function validateNativeSbom({ sbom, target, expectedVersion, expectedCommit, tarballSha256 }) {
  const packageName = `@memory-recall/native-${target}`;
  const described = sbom?.packages?.[0];
  const expectedFiles = ['LICENSE', 'NOTICE', NATIVE_TARGETS[target].binary, 'native-manifest.json', 'package.json']
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const files = Array.isArray(sbom?.files) ? [...sbom.files]
    .sort((left, right) => left.fileName < right.fileName ? -1 : left.fileName > right.fileName ? 1 : 0) : [];
  if (sbom?.spdxVersion !== 'SPDX-2.3' || sbom?.dataLicense !== 'CC0-1.0'
    || sbom?.SPDXID !== 'SPDXRef-DOCUMENT' || sbom?.name !== `${packageName}@${expectedVersion}`
    || sbom?.documentNamespace !== `https://github.com/rebel0789/Memory-Recall/sbom/${expectedCommit}/${target}/${expectedVersion}/${tarballSha256.slice('sha256:'.length)}`
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(sbom?.creationInfo?.created ?? '')
    || !sbom?.creationInfo?.creators?.includes('Tool: memory-recall-native-release')
    || !sbom?.documentDescribes?.includes('SPDXRef-Package')) {
    throw new Error(`${target} SPDX document metadata is invalid`);
  }
  if (files.length !== 5 || files.map(({ fileName }) => fileName).some((fileName, index) => fileName !== `./${expectedFiles[index]}`)
    || files.some((file, index) => file.SPDXID !== `SPDXRef-File-${index + 1}`
      || file.licenseConcluded !== 'NOASSERTION' || file.copyrightText !== 'NOASSERTION'
      || file.checksums?.length !== 2 || file.checksums[0]?.algorithm !== 'SHA1'
      || !/^[a-f0-9]{40}$/u.test(file.checksums[0]?.checksumValue ?? '')
      || file.checksums[1]?.algorithm !== 'SHA256' || !/^[a-f0-9]{64}$/u.test(file.checksums[1]?.checksumValue ?? ''))) {
    throw new Error(`${target} SPDX file evidence is invalid`);
  }
  const verificationCode = createHash('sha1')
    .update(files.map((file) => file.checksums[0].checksumValue).sort().join(''))
    .digest('hex');
  if (described?.SPDXID !== 'SPDXRef-Package' || described?.name !== packageName
    || described?.versionInfo !== expectedVersion || described?.filesAnalyzed !== true
    || described?.packageVerificationCode?.packageVerificationCodeValue !== verificationCode
    || described?.licenseConcluded !== 'Apache-2.0' || described?.licenseDeclared !== 'Apache-2.0'
    || described?.checksums?.length !== 1 || described.checksums[0]?.algorithm !== 'SHA256'
    || described.checksums[0]?.checksumValue !== tarballSha256.slice('sha256:'.length)) {
    throw new Error(`${target} SPDX package evidence is invalid`);
  }
  if (!Array.isArray(sbom?.relationships) || sbom.relationships.length !== 5
    || sbom.relationships.some((relationship, index) => relationship.spdxElementId !== 'SPDXRef-Package'
      || relationship.relationshipType !== 'CONTAINS'
      || relationship.relatedSpdxElement !== `SPDXRef-File-${index + 1}`)) {
    throw new Error(`${target} SPDX package relationships are invalid`);
  }
}

function verifyRegistryProvenance(packageName, version, attestations) {
  if (attestations?.provenance?.predicateType !== 'https://slsa.dev/provenance/v1') {
    throw new Error(`${packageName}@${version} npm provenance is missing`);
  }
  let attestationUrl;
  try {
    attestationUrl = new URL(attestations.url);
  } catch {
    throw new Error(`${packageName}@${version} npm attestation URL is invalid`);
  }
  if (attestationUrl.protocol !== 'https:' || attestationUrl.hostname !== 'registry.npmjs.org'
    || !attestationUrl.pathname.startsWith('/-/npm/v1/attestations/')) {
    throw new Error(`${packageName}@${version} npm attestation URL is invalid`);
  }
}

export async function auditRegistrySignatures(packages) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-npm-provenance-'));
  try {
    await writeFile(path.join(directory, 'package.json'), `${JSON.stringify({
      name: 'memory-recall-npm-provenance-verification',
      version: '0.0.0',
      private: true,
      dependencies: Object.fromEntries(packages.map(({ packageName, version }) => [packageName, version]))
    }, null, 2)}\n`);
    const installed = spawnNpmSync([
      'install', '--force', '--ignore-scripts', '--no-audit', '--no-fund'
    ], { cwd: directory, encoding: 'utf8', env: process.env });
    if (installed.status !== 0) throw new Error(`npm provenance lock failed: ${installed.stderr || installed.stdout || installed.error?.message || 'unknown error'}`);
    const audited = spawnNpmSync([
      'audit', 'signatures', '--json', '--include-attestations'
    ], { cwd: directory, encoding: 'utf8', env: process.env });
    if (audited.status !== 0) throw new Error(`npm signature audit failed: ${audited.stderr || audited.stdout || audited.error?.message || 'unknown error'}`);
    let report;
    try {
      report = JSON.parse(audited.stdout);
    } catch {
      throw new Error('npm signature audit did not return JSON evidence');
    }
    if (!Array.isArray(report.invalid) || report.invalid.length !== 0
      || !Array.isArray(report.missing) || report.missing.length !== 0
      || !Array.isArray(report.verified)) {
      throw new Error('npm signature audit reported invalid or missing signatures');
    }
    const requiredPredicates = new Set([
      'https://github.com/npm/attestation/tree/main/specs/publish/v0.1',
      'https://slsa.dev/provenance/v1'
    ]);
    for (const { packageName, version } of packages) {
      const verified = report.verified.find((entry) => entry?.name === packageName && entry?.version === version);
      const predicates = new Set((verified?.attestationBundles ?? []).map(({ predicateType }) => predicateType));
      if (!verified || [...requiredPredicates].some((predicate) => !predicates.has(predicate))) {
        throw new Error(`${packageName}@${version} npm attestation bundle is incomplete`);
      }
    }
    return Object.freeze({
      verified: packages.map(({ packageName, version }) => `${packageName}@${version}`),
      requiredPredicates: [...requiredPredicates]
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function registryRecord(packageName, version, { allowMissing = false } = {}) {
  const result = spawnNpmSync(['view', `${packageName}@${version}`, 'version', 'dist.integrity', 'dist.attestations', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env
  });
  if (result.status !== 0) {
    if (allowMissing && /E404|Not Found|is not in this registry/iu.test(`${result.stderr ?? ''}\n${result.stdout ?? ''}`)) return null;
    throw new Error(`npm registry verification failed for ${packageName}@${version}`);
  }
  const parsed = JSON.parse(result.stdout);
  return {
    version: parsed.version,
    integrity: parsed['dist.integrity'] ?? parsed.dist?.integrity,
    attestations: parsed['dist.attestations'] ?? parsed.dist?.attestations
  };
}

async function waitForRegistry(packageName, version) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const record = registryRecord(packageName, version, { allowMissing: true });
    if (record) return record;
    await new Promise((resolve) => setTimeout(resolve, 2_500));
  }
  throw new Error(`${packageName}@${version} did not become visible on npm within 30 seconds`);
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const next = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(next));
    else if (entry.isFile()) files.push(next);
  }
  return files.sort();
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!['validate', 'publish-native', 'verify-registry'].includes(command)) throw new Error('command must be validate, publish-native, or verify-registry');
  const values = { command, requireSigned: true };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!value || !['--artifacts', '--version', '--commit', '--auth-mode'].includes(flag)) throw new Error(`invalid argument ${flag ?? ''}`.trim());
    values[flag.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value;
  }
  if (!values.artifacts || !values.version || !values.commit) throw new Error('artifacts, version, and commit are required');
  if (command === 'publish-native' && !['trusted-publishing', 'npm-token'].includes(values.authMode)) throw new Error('publish-native requires a supported auth mode');
  return values;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const releaseSet = await validateNativeReleaseSet({
    artifactsDirectory: options.artifacts,
    expectedVersion: options.version,
    expectedCommit: options.commit,
    requireSigned: true
  });
  if (options.command === 'publish-native') await publishNativePackages({
    releaseSet,
    artifactsDirectory: options.artifacts,
    authMode: options.authMode
  });
  if (options.command === 'verify-registry') await verifyNativeRegistry(releaseSet);
  process.stdout.write(`${JSON.stringify(releaseSet, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
