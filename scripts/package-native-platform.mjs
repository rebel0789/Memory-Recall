import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
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
    const packed = spawnSync(npmCommand(), [
      'pack', stage,
      '--pack-destination', path.resolve(outDirectory),
      '--json',
      '--ignore-scripts'
    ], { cwd: root, encoding: 'utf8', windowsHide: true });
    if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr || packed.stdout}`);
    const [result] = JSON.parse(packed.stdout);
    return Object.freeze({
      target,
      packageName: template.name,
      version: template.version,
      tarball: path.resolve(outDirectory, result.filename),
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

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
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
