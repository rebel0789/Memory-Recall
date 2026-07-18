import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
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
    receipts.push(Object.freeze({
      target,
      packageName: receipt.package.name,
      version: receipt.package.version,
      tarball: path.relative(artifactsRoot, tarballFiles[0]).split(path.sep).join('/'),
      tarballSha256: sha256,
      tarballIntegrity: `sha512-${createHash('sha512').update(tarballBytes).digest('base64')}`,
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

function registryRecord(packageName, version, { allowMissing = false } = {}) {
  const result = spawnNpmSync(['view', `${packageName}@${version}`, 'version', 'dist.integrity', '--json'], {
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
    integrity: parsed['dist.integrity'] ?? parsed.dist?.integrity
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
