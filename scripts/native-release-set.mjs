import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { buildPackageSpdxSbom, NATIVE_TARGETS, spawnNpmSync } from './package-native-platform.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_RELEASE_RECEIPT = 'memory-recall-root-release.json';
const ROOT_RELEASE_SBOM = 'memory-recall-root.spdx.json';
export const NATIVE_RELEASE_ORDER = Object.freeze([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64-gnu',
  'linux-x64-gnu',
  'win32-x64'
]);

export async function packageRootRelease({ outDirectory, expectedCommit, created, root = ROOT }) {
  if (!/^[a-f0-9]{40}$/u.test(expectedCommit ?? '')) throw new Error('root release commit must be a full Git SHA');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(created ?? '') || Number.isNaN(Date.parse(created))) {
    throw new Error('root release creation time must be canonical SPDX ISO-8601');
  }
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (packageJson.name !== 'memory-recall' || !/^\d+\.\d+\.\d+$/u.test(packageJson.version ?? '')) {
    throw new Error('root package identity must use an exact stable version');
  }
  validateRootNativeDependencies(packageJson, packageJson.version);
  const output = path.resolve(outDirectory);
  await mkdir(output, { recursive: true });
  const packed = spawnNpmSync([
    'pack', path.resolve(root), '--pack-destination', output, '--json', '--ignore-scripts'
  ], { cwd: root, encoding: 'utf8', env: process.env });
  if (packed.status !== 0) throw new Error(`root npm pack failed: ${packed.stderr || packed.stdout || packed.error?.message || 'unknown error'}`);
  const results = JSON.parse(packed.stdout);
  if (!Array.isArray(results) || results.length !== 1) throw new Error('root npm pack must produce exactly one artifact');
  const [packReport] = results;
  if (packReport?.name !== packageJson.name || packReport?.version !== packageJson.version
    || packReport?.filename !== `memory-recall-${packageJson.version}.tgz`
    || !Number.isInteger(packReport?.entryCount) || packReport.entryCount <= 0
    || packReport.entryCount !== packReport.files?.length
    || !Number.isInteger(packReport?.size) || packReport.size <= 0
    || !Number.isInteger(packReport?.unpackedSize) || packReport.unpackedSize <= 0) {
    throw new Error('root npm pack report is invalid');
  }
  const files = await Promise.all(packReport.files.map(async ({ path: relativePath, size }) => {
    if (!safePackagePath(relativePath)) throw new Error('root npm pack contains an unsafe path');
    const sourcePath = path.resolve(root, relativePath);
    const metadata = await lstat(sourcePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== size) {
      throw new Error(`root npm pack file metadata differs for ${relativePath}`);
    }
    const bytes = await readFile(sourcePath);
    return Object.freeze({
      path: relativePath,
      size: bytes.length,
      sha1: createHash('sha1').update(bytes).digest('hex'),
      sha256: createHash('sha256').update(bytes).digest('hex')
    });
  }));
  const tarball = path.join(output, packReport.filename);
  const tarballBytes = await readFile(tarball);
  const tarballSha256 = `sha256:${createHash('sha256').update(tarballBytes).digest('hex')}`;
  const tarballIntegrity = `sha512-${createHash('sha512').update(tarballBytes).digest('base64')}`;
  const sbom = buildPackageSpdxSbom({
    packageName: packageJson.name,
    version: packageJson.version,
    files,
    commit: expectedCommit,
    created,
    tarballSha256,
    namespaceKey: 'root'
  });
  const sbomBytes = Buffer.from(`${JSON.stringify(sbom, null, 2)}\n`);
  const receipt = Object.freeze({
    schemaVersion: '1.0.0',
    receiptVersion: 'memory-recall-root-release-1',
    commit: expectedCommit,
    package: {
      name: packageJson.name,
      version: packageJson.version,
      tarball: packReport.filename,
      tarballSha256,
      tarballIntegrity,
      sbom: ROOT_RELEASE_SBOM,
      sbomSha256: `sha256:${createHash('sha256').update(sbomBytes).digest('hex')}`,
      entryCount: packReport.entryCount,
      size: packReport.size,
      unpackedSize: packReport.unpackedSize
    },
    nativePackages: NATIVE_RELEASE_ORDER.map((target) => ({
      name: `@memory-recall/native-${target}`,
      version: packageJson.version
    }))
  });
  await Promise.all([
    writeFile(path.join(output, ROOT_RELEASE_SBOM), sbomBytes),
    writeFile(path.join(output, ROOT_RELEASE_RECEIPT), `${JSON.stringify(receipt, null, 2)}\n`)
  ]);
  return receipt;
}

export async function validateRootReleaseArtifact({ artifactsDirectory, expectedVersion, expectedCommit }) {
  if (!/^\d+\.\d+\.\d+$/u.test(expectedVersion ?? '')) throw new Error('root release version must be exact and stable');
  if (!/^[a-f0-9]{40}$/u.test(expectedCommit ?? '')) throw new Error('root release commit must be a full Git SHA');
  const root = path.resolve(artifactsDirectory);
  const files = await walk(root);
  const receiptPath = uniqueBasename(files, ROOT_RELEASE_RECEIPT);
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  if (receipt?.schemaVersion !== '1.0.0' || receipt?.receiptVersion !== 'memory-recall-root-release-1'
    || receipt?.commit !== expectedCommit || receipt?.package?.name !== 'memory-recall'
    || receipt?.package?.version !== expectedVersion || receipt?.package?.tarball !== `memory-recall-${expectedVersion}.tgz`
    || receipt?.package?.sbom !== ROOT_RELEASE_SBOM
    || !Number.isInteger(receipt?.package?.entryCount) || receipt.package.entryCount <= 0
    || !Number.isInteger(receipt?.package?.size) || receipt.package.size <= 0
    || !Number.isInteger(receipt?.package?.unpackedSize) || receipt.package.unpackedSize <= 0) {
    throw new Error('root release receipt is invalid');
  }
  const expectedNatives = NATIVE_RELEASE_ORDER.map((target) => `@memory-recall/native-${target}@${expectedVersion}`);
  const actualNatives = (receipt.nativePackages ?? []).map(({ name, version }) => `${name}@${version}`);
  if (JSON.stringify(actualNatives) !== JSON.stringify(expectedNatives)) throw new Error('root release native dependencies are invalid');
  const tarballPath = uniqueBasename(files, receipt.package.tarball);
  const expectedArtifactNames = [ROOT_RELEASE_RECEIPT, ROOT_RELEASE_SBOM, receipt.package.tarball].sort();
  const actualArtifactNames = files.map((file) => path.basename(file)).sort();
  if (JSON.stringify(actualArtifactNames) !== JSON.stringify(expectedArtifactNames)) {
    throw new Error('root release must contain exactly the receipt, SBOM, and tarball');
  }
  const tarballBytes = await readFile(tarballPath);
  const tarballSha256 = `sha256:${createHash('sha256').update(tarballBytes).digest('hex')}`;
  const tarballIntegrity = `sha512-${createHash('sha512').update(tarballBytes).digest('base64')}`;
  if (receipt.package.tarballSha256 !== tarballSha256 || receipt.package.tarballIntegrity !== tarballIntegrity
    || receipt.package.size !== tarballBytes.length) {
    throw new Error('root release tarball checksum or size is invalid');
  }
  const sbomPath = uniqueBasename(files, ROOT_RELEASE_SBOM);
  const sbomBytes = await readFile(sbomPath);
  if (receipt.package.sbomSha256 !== `sha256:${createHash('sha256').update(sbomBytes).digest('hex')}`) {
    throw new Error('root release SBOM checksum is invalid');
  }
  validatePackageSbom({
    sbom: JSON.parse(sbomBytes),
    packageName: 'memory-recall',
    expectedVersion,
    expectedCommit,
    namespaceKey: 'root',
    tarballSha256,
    expectedFileCount: receipt.package.entryCount
  });
  await validateArchiveAgainstSbom({ tarballPath, sbom: JSON.parse(sbomBytes) });
  return Object.freeze({
    packageName: 'memory-recall',
    version: expectedVersion,
    tarball: path.relative(root, tarballPath).split(path.sep).join('/'),
    tarballSha256,
    tarballIntegrity,
    sbom: path.relative(root, sbomPath).split(path.sep).join('/'),
    receipt: path.relative(root, receiptPath).split(path.sep).join('/')
  });
}

async function validateArchiveAgainstSbom({ tarballPath, sbom }) {
  const listed = spawnSync('tar', ['-tzf', tarballPath], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 5 * 1024 * 1024
  });
  if (listed.status !== 0) throw new Error(`root release tarball listing failed: ${listed.stderr || listed.error?.message || 'unknown error'}`);
  const archivePaths = listed.stdout.split(/\r?\n/u).filter(Boolean).map((entry) => entry.endsWith('/') ? entry.slice(0, -1) : entry);
  if (archivePaths.length === 0 || new Set(archivePaths).size !== archivePaths.length
    || archivePaths.some((entry) => entry !== 'package' && (!entry.startsWith('package/') || !safePackagePath(entry)))) {
    throw new Error('root release tarball paths are unsafe or ambiguous');
  }
  const extracted = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-root-release-'));
  try {
    const unpacked = spawnSync('tar', ['-xzf', tarballPath, '-C', extracted], {
      cwd: ROOT,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });
    if (unpacked.status !== 0) throw new Error(`root release tarball extraction failed: ${unpacked.stderr || unpacked.error?.message || 'unknown error'}`);
    const packageRoot = path.join(extracted, 'package');
    const extractedFiles = await walkRegularFiles(packageRoot);
    const sbomFiles = new Map(sbom.files.map((file) => [file.fileName.slice(2), file]));
    if (extractedFiles.length !== sbomFiles.size
      || extractedFiles.some((file) => !sbomFiles.has(file.relativePath))) {
      throw new Error('root release SBOM file set does not match the tarball');
    }
    for (const { relativePath, absolutePath } of extractedFiles) {
      const bytes = await readFile(absolutePath);
      const checksums = new Map(sbomFiles.get(relativePath).checksums.map(({ algorithm, checksumValue }) => [algorithm, checksumValue]));
      if (checksums.get('SHA1') !== createHash('sha1').update(bytes).digest('hex')
        || checksums.get('SHA256') !== createHash('sha256').update(bytes).digest('hex')) {
        throw new Error(`root release SBOM checksum does not match tarball entry ${relativePath}`);
      }
    }
  } finally {
    await rm(extracted, { recursive: true, force: true });
  }
}

async function walkRegularFiles(directory, relative = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
    const absolutePath = path.join(directory, entry.name);
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) throw new Error(`root release tarball contains symbolic link ${relativePath}`);
    if (metadata.isDirectory()) files.push(...await walkRegularFiles(absolutePath, relativePath));
    else if (metadata.isFile()) files.push({ relativePath, absolutePath });
    else throw new Error(`root release tarball contains unsupported entry ${relativePath}`);
  }
  return files.sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
}

export async function verifyRootRegistry(artifact) {
  verifyRegistryRecord(artifact, registryRecord(artifact.packageName, artifact.version));
  return auditRegistrySignatures([{ packageName: artifact.packageName, version: artifact.version }]);
}

export async function publishRootPackage({
  artifact,
  artifactsDirectory,
  nativeArtifactsDirectory,
  expectedVersion,
  expectedCommit,
  authMode
}) {
  if (!nativeArtifactsDirectory) throw new Error('root publication requires native artifacts directory');
  if (artifact.version !== expectedVersion) throw new Error('root artifact version does not match the release version');
  const releaseSet = await validateNativeReleaseSet({
    artifactsDirectory: nativeArtifactsDirectory,
    expectedVersion,
    expectedCommit,
    requireSigned: true
  });
  await verifyNativeRegistry(releaseSet);
  let record = registryRecord(artifact.packageName, artifact.version, { allowMissing: true });
  if (!record) {
    const tarball = path.resolve(artifactsDirectory, artifact.tarball);
    const args = ['publish', tarball, '--access', 'public'];
    if (authMode === 'npm-token') args.push('--provenance');
    const published = spawnNpmSync(args, { cwd: ROOT, encoding: 'utf8', env: process.env });
    if (published.status !== 0) throw new Error(`root npm publish failed: ${published.stderr || published.stdout || published.error?.message || 'unknown error'}`);
    record = await waitForRegistry(artifact.packageName, artifact.version);
  }
  verifyRegistryRecord(artifact, record);
}

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
  validateRootNativeDependencies(packageJson, expectedVersion, expectedPackageNames);

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
  const expectedFiles = ['LICENSE', 'NOTICE', NATIVE_TARGETS[target].binary, 'native-manifest.json', 'package.json']
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  validatePackageSbom({
    sbom,
    packageName,
    expectedVersion,
    expectedCommit,
    namespaceKey: target,
    tarballSha256,
    expectedFiles,
    expectedFileCount: 5
  });
}

function validatePackageSbom({
  sbom,
  packageName,
  expectedVersion,
  expectedCommit,
  namespaceKey,
  tarballSha256,
  expectedFiles = null,
  expectedFileCount
}) {
  const described = sbom?.packages?.[0];
  const files = Array.isArray(sbom?.files) ? [...sbom.files]
    .sort((left, right) => left.fileName < right.fileName ? -1 : left.fileName > right.fileName ? 1 : 0) : [];
  if (sbom?.spdxVersion !== 'SPDX-2.3' || sbom?.dataLicense !== 'CC0-1.0'
    || sbom?.SPDXID !== 'SPDXRef-DOCUMENT' || sbom?.name !== `${packageName}@${expectedVersion}`
    || sbom?.documentNamespace !== `https://github.com/rebel0789/Memory-Recall/sbom/${expectedCommit}/${namespaceKey}/${expectedVersion}/${tarballSha256.slice('sha256:'.length)}`
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(sbom?.creationInfo?.created ?? '')
    || !sbom?.creationInfo?.creators?.includes('Tool: memory-recall-native-release')
    || !sbom?.documentDescribes?.includes('SPDXRef-Package')) {
    throw new Error(`${packageName} SPDX document metadata is invalid`);
  }
  if (files.length !== expectedFileCount
    || (expectedFiles !== null && files.map(({ fileName }) => fileName).some((fileName, index) => fileName !== `./${expectedFiles[index]}`))
    || files.some(({ fileName }) => !safePackagePath(fileName?.slice(2)) || !fileName.startsWith('./'))
    || files.some((file, index) => file.SPDXID !== `SPDXRef-File-${index + 1}`
      || file.licenseConcluded !== 'NOASSERTION' || file.copyrightText !== 'NOASSERTION'
      || file.checksums?.length !== 2 || file.checksums[0]?.algorithm !== 'SHA1'
      || !/^[a-f0-9]{40}$/u.test(file.checksums[0]?.checksumValue ?? '')
      || file.checksums[1]?.algorithm !== 'SHA256' || !/^[a-f0-9]{64}$/u.test(file.checksums[1]?.checksumValue ?? ''))) {
    throw new Error(`${packageName} SPDX file evidence is invalid`);
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
    throw new Error(`${packageName} SPDX package evidence is invalid`);
  }
  if (!Array.isArray(sbom?.relationships) || sbom.relationships.length !== expectedFileCount
    || sbom.relationships.some((relationship, index) => relationship.spdxElementId !== 'SPDXRef-Package'
      || relationship.relationshipType !== 'CONTAINS'
      || relationship.relatedSpdxElement !== `SPDXRef-File-${index + 1}`)) {
    throw new Error(`${packageName} SPDX package relationships are invalid`);
  }
}

function validateRootNativeDependencies(packageJson, expectedVersion, expectedPackageNames = new Set(
  NATIVE_RELEASE_ORDER.map((target) => `@memory-recall/native-${target}`)
)) {
  const optionalDependencies = packageJson.optionalDependencies ?? {};
  if (Object.keys(optionalDependencies).length !== expectedPackageNames.size) {
    throw new Error('root package must reference exactly the five native packages');
  }
  for (const name of expectedPackageNames) {
    if (optionalDependencies[name] !== expectedVersion) throw new Error(`root native dependency ${name} must use ${expectedVersion}`);
  }
}

function safePackagePath(relativePath) {
  return typeof relativePath === 'string' && relativePath.length > 0
    && relativePath.length <= 512 && !path.posix.isAbsolute(relativePath)
    && !relativePath.includes('\\') && !relativePath.split('/').includes('..')
    && /^[A-Za-z0-9._/@+ -]+$/u.test(relativePath);
}

function uniqueBasename(files, name) {
  const matches = files.filter((file) => path.basename(file) === name);
  if (matches.length !== 1) throw new Error(`root release requires exactly one ${name}`);
  return matches[0];
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
  if (!['validate', 'publish-native', 'verify-registry', 'package-root', 'validate-root', 'publish-root', 'verify-root-registry'].includes(command)) {
    throw new Error('unsupported release command');
  }
  const values = { command, requireSigned: true };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!value || !['--artifacts', '--native-artifacts', '--version', '--commit', '--auth-mode', '--out', '--created'].includes(flag)) {
      throw new Error(`invalid argument ${flag ?? ''}`.trim());
    }
    values[flag.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value;
  }
  if (command === 'package-root' && (!values.out || !values.commit || !values.created)) {
    throw new Error('package-root requires out, commit, and created');
  }
  if (command !== 'package-root' && (!values.artifacts || !values.version || !values.commit)) {
    throw new Error('artifacts, version, and commit are required');
  }
  if (['publish-native', 'publish-root'].includes(command) && !['trusted-publishing', 'npm-token'].includes(values.authMode)) {
    throw new Error(`${command} requires a supported auth mode`);
  }
  if (command === 'publish-root' && !values.nativeArtifacts) {
    throw new Error('publish-root requires native-artifacts');
  }
  return values;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.command === 'package-root') {
    const receipt = await packageRootRelease({
      outDirectory: options.out,
      expectedCommit: options.commit,
      created: options.created
    });
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    return;
  }
  if (['validate-root', 'publish-root', 'verify-root-registry'].includes(options.command)) {
    const artifact = await validateRootReleaseArtifact({
      artifactsDirectory: options.artifacts,
      expectedVersion: options.version,
      expectedCommit: options.commit
    });
    if (options.command === 'publish-root') await publishRootPackage({
      artifact,
      artifactsDirectory: options.artifacts,
      nativeArtifactsDirectory: options.nativeArtifacts,
      expectedVersion: options.version,
      expectedCommit: options.commit,
      authMode: options.authMode
    });
    const registryProof = options.command === 'verify-root-registry' ? await verifyRootRegistry(artifact) : null;
    process.stdout.write(`${JSON.stringify({ artifact, registryProof }, null, 2)}\n`);
    return;
  }
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
