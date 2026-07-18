import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const NATIVE_TARGETS = Object.freeze({
  'darwin-arm64': Object.freeze({ platform: 'darwin', arch: 'arm64', binary: 'bin/oaf' }),
  'darwin-x64': Object.freeze({ platform: 'darwin', arch: 'x64', binary: 'bin/oaf' }),
  'linux-arm64-gnu': Object.freeze({ platform: 'linux', arch: 'arm64', libc: 'glibc', binary: 'bin/oaf' }),
  'linux-x64-gnu': Object.freeze({ platform: 'linux', arch: 'x64', libc: 'glibc', binary: 'bin/oaf' }),
  'win32-x64': Object.freeze({ platform: 'win32', arch: 'x64', binary: 'bin/oaf.exe' })
});

export function buildNativeManifest({ template, target, binarySha256 }) {
  const expected = NATIVE_TARGETS[target];
  if (!expected) throw new Error(`unsupported native target: ${target}`);
  if (!/^[a-f0-9]{64}$/u.test(binarySha256)) throw new Error('native binary checksum must be lowercase SHA-256');
  validateTemplate(template, target, expected);
  return Object.freeze({
    schemaVersion: '1.0.0',
    packageName: template.name,
    packageVersion: template.version,
    target,
    binary: expected.binary,
    sha256: `sha256:${binarySha256}`
  });
}

export function buildPublishedPackageJson(template, target) {
  const expected = NATIVE_TARGETS[target];
  if (!expected) throw new Error(`unsupported native target: ${target}`);
  validateTemplate(template, target, expected);
  return Object.freeze({
    ...template,
    os: [expected.platform],
    cpu: [expected.arch],
    ...(expected.libc ? { libc: [expected.libc] } : {})
  });
}

export function buildNativeDistributionReceipt({ packageReport, commit, runner, tarballSha256, consumerGateResult, packageAttestation = null }) {
  const expected = NATIVE_TARGETS[packageReport?.target];
  if (!expected) throw new Error('native distribution receipt target is unsupported');
  if (!/^[a-f0-9]{40}$/u.test(commit ?? '')) throw new Error('native distribution receipt commit must be a full Git SHA');
  if (!/^[A-Za-z0-9._-]+$/u.test(runner ?? '')) throw new Error('native distribution receipt runner is invalid');
  if (packageReport.packageName !== `@memory-recall/native-${packageReport.target}`) throw new Error('native distribution receipt package name is invalid');
  if (!/^\d+\.\d+\.\d+$/u.test(packageReport.version ?? '')) throw new Error('native distribution receipt package version is invalid');
  if (!/^sha256:[a-f0-9]{64}$/u.test(packageReport?.binarySha256 ?? '')) throw new Error('native distribution receipt binary checksum is invalid');
  if (!/^sha256:[a-f0-9]{64}$/u.test(tarballSha256 ?? '')) throw new Error('native distribution receipt tarball checksum is invalid');
  if (consumerGateResult !== 'pass') throw new Error('native distribution receipt requires a passing consumer gate');
  if (packageAttestation !== null) {
    if (!/^[1-9][0-9]*$/u.test(packageAttestation.id ?? '')) throw new Error('native package attestation ID is invalid');
    if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/attestations\/[1-9][0-9]*$/u.test(packageAttestation.url ?? '')) {
      throw new Error('native package attestation URL is invalid');
    }
  }
  const tarball = path.basename(packageReport.tarball ?? '');
  if (!tarball.endsWith('.tgz')) throw new Error('native distribution receipt tarball is invalid');
  if (packageReport.entryCount !== 5 || !Number.isInteger(packageReport.size) || packageReport.size <= 0
    || !Number.isInteger(packageReport.unpackedSize) || packageReport.unpackedSize <= 0) {
    throw new Error('native distribution receipt package measurements are invalid');
  }
  return Object.freeze({
    schemaVersion: '1.0.0',
    receiptVersion: 'memory-recall-native-distribution-1',
    commit,
    runner,
    target: packageReport.target,
    abi: {
      platform: expected.platform,
      arch: expected.arch,
      libc: expected.libc ?? null
    },
    package: {
      name: packageReport.packageName,
      version: packageReport.version,
      tarball,
      binarySha256: packageReport.binarySha256,
      tarballSha256,
      entryCount: packageReport.entryCount,
      size: packageReport.size,
      unpackedSize: packageReport.unpackedSize
    },
    consumerGate: {
      command: 'node scripts/native-code-intelligence-consumer-smoke.mjs',
      result: consumerGateResult
    },
    artifactState: {
      signed: packageAttestation !== null,
      published: false,
      signature: packageAttestation === null ? null : {
        kind: 'github-sigstore-provenance',
        attestationId: packageAttestation.id,
        attestationUrl: packageAttestation.url
      }
    }
  });
}

export async function packageNativePlatform({
  target,
  binaryPath,
  outDirectory = path.join(ROOT, 'output', 'native-packages'),
  root = ROOT
}) {
  const expected = NATIVE_TARGETS[target];
  if (!expected) throw new Error(`unsupported native target: ${target}`);
  const templatePath = path.join(root, 'native-packages', target, 'package.json');
  const [template, rootPackage, cargoToml] = await Promise.all([
    readJson(templatePath),
    readJson(path.join(root, 'package.json')),
    readFile(path.join(root, 'rust', 'Cargo.toml'), 'utf8')
  ]);
  validateTemplate(template, target, expected);
  const cargoVersion = workspaceVersion(cargoToml);
  for (const [name, version] of [['root package', rootPackage.version], ['Cargo workspace', cargoVersion]]) {
    if (version !== template.version) throw new Error(`${name} version ${version} does not match ${template.name}@${template.version}`);
  }

  const resolvedBinary = path.resolve(binaryPath);
  const metadata = await stat(resolvedBinary);
  if (!metadata.isFile()) throw new Error('native binary path must point to a regular file');
  verifyBinaryVersion(resolvedBinary, template.version);
  const binaryBytes = await readFile(resolvedBinary);
  const manifest = buildNativeManifest({
    template,
    target,
    binarySha256: createHash('sha256').update(binaryBytes).digest('hex')
  });
  const publishedTemplate = buildPublishedPackageJson(template, target);

  const stage = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-native-package-'));
  try {
    const stagedBinary = path.join(stage, expected.binary);
    await mkdir(path.dirname(stagedBinary), { recursive: true });
    await Promise.all([
      writeFile(path.join(stage, 'package.json'), `${JSON.stringify(publishedTemplate, null, 2)}\n`),
      writeFile(path.join(stage, 'native-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`),
      copyFile(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE')),
      copyFile(path.join(root, 'NOTICE'), path.join(stage, 'NOTICE')),
      copyFile(resolvedBinary, stagedBinary)
    ]);
    if (expected.platform !== 'win32') await chmod(stagedBinary, 0o755);
    await mkdir(outDirectory, { recursive: true });
    const packed = spawnNpmSync([
      'pack', stage,
      '--pack-destination', path.resolve(outDirectory),
      '--json',
      '--ignore-scripts'
    ], { cwd: root, encoding: 'utf8', windowsHide: true });
    if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr || packed.stdout || packed.error?.message || 'unknown error'}`);
    const results = JSON.parse(packed.stdout);
    if (!Array.isArray(results) || results.length !== 1) throw new Error('npm pack must return exactly one package result');
    const [result] = results;
    if (typeof result?.filename !== 'string' || result.filename.length === 0 || path.basename(result.filename) !== result.filename) {
      throw new Error('npm pack returned an invalid tarball filename');
    }
    const tarball = path.resolve(outDirectory, result.filename);
    if (!(await stat(tarball)).isFile()) throw new Error('npm pack did not create the reported tarball');
    return Object.freeze({
      target,
      packageName: template.name,
      version: template.version,
      tarball,
      binarySha256: manifest.sha256,
      entryCount: result.entryCount,
      size: result.size,
      unpackedSize: result.unpackedSize
    });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

function validateTemplate(template, target, expected) {
  const expectedName = `@memory-recall/native-${target}`;
  if (template.name !== expectedName) throw new Error(`native package name must be ${expectedName}`);
  if (!/^\d+\.\d+\.\d+$/u.test(template.version)) throw new Error('native package version must be an exact stable version');
  if (template.private === true) throw new Error('native platform packages must be publishable');
  if (template.publishConfig?.access !== 'public') throw new Error('native platform packages must publish with public access');
  if (template.license !== 'Apache-2.0') throw new Error('native platform package license must be Apache-2.0');
  const runtime = template.memoryRecallNative;
  if (runtime?.target !== target || runtime?.platform !== expected.platform || runtime?.arch !== expected.arch
    || runtime?.binary !== expected.binary || (runtime?.libc ?? null) !== (expected.libc ?? null)) {
    throw new Error('native package runtime metadata does not match target');
  }
  for (const required of [expected.binary, 'native-manifest.json', 'LICENSE', 'NOTICE']) {
    if (!template.files?.includes(required)) throw new Error(`native package files must include ${required}`);
  }
}

function workspaceVersion(cargoToml) {
  const section = cargoToml.match(/\[workspace\.package\]([\s\S]*?)(?:\n\[|$)/u)?.[1] ?? '';
  const version = section.match(/^version\s*=\s*"([^"]+)"/mu)?.[1];
  if (!version) throw new Error('Cargo workspace package version is missing');
  return version;
}

function verifyBinaryVersion(binaryPath, version) {
  const result = spawnSync(binaryPath, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
    env: { PATH: process.env.PATH ?? '', LANG: 'C', LC_ALL: 'C' }
  });
  if (result.status !== 0) throw new Error(`native binary version check failed: ${result.stderr || result.error?.message || 'unknown error'}`);
  if (result.stdout.trim() !== `oaf ${version}`) throw new Error(`native binary version must be oaf ${version}`);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export function spawnNpmSync(args, options = {}) {
  const candidates = [
    process.env.npm_execpath,
    path.resolve(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ].filter((candidate) => typeof candidate === 'string' && candidate.length > 0);
  const npmCli = candidates.find((candidate) => existsSync(candidate));
  if (!npmCli) throw new Error('npm CLI is unavailable');
  return spawnSync(process.execPath, [npmCli, ...args], { windowsHide: true, ...options });
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--target', '--binary', '--out'].includes(flag) || !value) throw new Error('usage: package-native-platform --target <target> --binary <path> [--out <directory>]');
    if (values.has(flag)) throw new Error(`duplicate option: ${flag}`);
    values.set(flag, value);
  }
  if (!values.has('--target') || !values.has('--binary')) throw new Error('usage: package-native-platform --target <target> --binary <path> [--out <directory>]');
  return values;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const report = await packageNativePlatform({
    target: args.get('--target'),
    binaryPath: args.get('--binary'),
    ...(args.has('--out') ? { outDirectory: args.get('--out') } : {})
  });
  console.log(JSON.stringify(report, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
