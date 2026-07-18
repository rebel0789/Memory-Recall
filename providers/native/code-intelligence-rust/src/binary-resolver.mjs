import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, createReadStream } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const VERSION_TIMEOUT_MS = 5_000;
const VERSION_OUTPUT_LIMIT = 256;
const TARGETS = Object.freeze({
  'darwin-arm64': Object.freeze({
    packageName: '@memory-recall/native-darwin-arm64',
    binary: 'bin/oaf'
  }),
  'darwin-x64': Object.freeze({
    packageName: '@memory-recall/native-darwin-x64',
    binary: 'bin/oaf'
  }),
  'linux-arm64-gnu': Object.freeze({
    packageName: '@memory-recall/native-linux-arm64-gnu',
    binary: 'bin/oaf'
  }),
  'linux-x64-gnu': Object.freeze({
    packageName: '@memory-recall/native-linux-x64-gnu',
    binary: 'bin/oaf'
  }),
  'win32-x64': Object.freeze({
    packageName: '@memory-recall/native-win32-x64',
    binary: 'bin/oaf.exe'
  })
});

export class NativeBinaryResolutionError extends Error {
  constructor(code) {
    super(code);
    this.name = 'NativeBinaryResolutionError';
    this.code = code;
  }
}

export function nativeTarget({
  platform = process.platform,
  arch = process.arch,
  glibcVersion = runtimeGlibcVersion()
} = {}) {
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) return `darwin-${arch}`;
  if (platform === 'win32' && arch === 'x64') return 'win32-x64';
  if (platform === 'linux' && glibcVersion && (arch === 'arm64' || arch === 'x64')) {
    return `linux-${arch}-gnu`;
  }
  throw new NativeBinaryResolutionError('native_platform_unsupported');
}

export function nativePackageForTarget(target) {
  const descriptor = TARGETS[target];
  if (!descriptor) throw new NativeBinaryResolutionError('native_platform_unsupported');
  return descriptor;
}

export async function resolveNativeBinary({
  binaryPath,
  expectedSha256,
  target = nativeTarget(),
  packageRoot = PACKAGE_ROOT,
  resolvePackageJson
} = {}) {
  const rootMetadata = await readJson(path.join(packageRoot, 'package.json'), 'native_engine_manifest_invalid');
  const expectedVersion = exactVersion(rootMetadata?.version);
  if (binaryPath) {
    const resolved = await resolveRegularExecutable(binaryPath);
    if (expectedSha256) await verifyChecksum(resolved, expectedSha256);
    await verifyVersion(resolved, expectedVersion, path.dirname(resolved));
    return Object.freeze({
      path: resolved,
      source: 'explicit',
      target,
      verified: Boolean(expectedSha256),
      version: expectedVersion
    });
  }

  const descriptor = nativePackageForTarget(target);
  return resolvePlatformPackage({
    descriptor,
    expectedVersion,
    target,
    resolvePackageJson: resolvePackageJson ?? defaultPackageResolver(packageRoot)
  });
}

async function resolvePlatformPackage({ descriptor, expectedVersion, target, resolvePackageJson }) {
  let packageJsonPath;
  try {
    packageJsonPath = await resolvePackageJson(descriptor.packageName);
  } catch {
    throw new NativeBinaryResolutionError('native_platform_package_missing');
  }
  const packageRoot = await realpath(path.dirname(packageJsonPath)).catch(() => {
    throw new NativeBinaryResolutionError('native_engine_manifest_invalid');
  });
  const packageMetadata = await readJson(packageJsonPath, 'native_engine_manifest_invalid');
  const manifest = await readJson(path.join(packageRoot, 'native-manifest.json'), 'native_engine_manifest_invalid');
  validateManifest({ descriptor, expectedVersion, manifest, packageMetadata, target });
  const binaryPath = await resolveRegularExecutable(path.join(packageRoot, descriptor.binary));
  if (!inside(packageRoot, binaryPath)) throw new NativeBinaryResolutionError('native_engine_path_invalid');
  await verifyChecksum(binaryPath, manifest.sha256);
  await verifyVersion(binaryPath, expectedVersion, packageRoot);
  return Object.freeze({
    path: binaryPath,
    source: 'platform-package',
    target,
    packageName: descriptor.packageName,
    verified: true,
    version: expectedVersion,
    sha256: manifest.sha256
  });
}

function validateManifest({ descriptor, expectedVersion, manifest, packageMetadata, target }) {
  const valid = packageMetadata?.name === descriptor.packageName &&
    packageMetadata?.version === expectedVersion &&
    manifest?.schemaVersion === '1.0.0' &&
    manifest?.packageName === descriptor.packageName &&
    manifest?.packageVersion === expectedVersion &&
    manifest?.target === target &&
    manifest?.binary === descriptor.binary &&
    /^sha256:[a-f0-9]{64}$/u.test(manifest?.sha256 ?? '') &&
    Object.keys(manifest ?? {}).sort().join(',') === 'binary,packageName,packageVersion,schemaVersion,sha256,target';
  if (!valid) throw new NativeBinaryResolutionError('native_engine_manifest_invalid');
}

async function resolveRegularExecutable(candidate) {
  let resolved;
  let metadata;
  try {
    resolved = await realpath(path.resolve(candidate));
    metadata = await stat(resolved);
    if (!metadata.isFile()) throw new Error('not-file');
    if (process.platform !== 'win32') await access(resolved, constants.X_OK);
  } catch {
    throw new NativeBinaryResolutionError('native_engine_unavailable');
  }
  return resolved;
}

async function verifyChecksum(binaryPath, expected) {
  if (!/^sha256:[a-f0-9]{64}$/u.test(expected ?? '')) {
    throw new NativeBinaryResolutionError('native_engine_manifest_invalid');
  }
  const hash = createHash('sha256');
  try {
    for await (const chunk of createReadStream(binaryPath)) hash.update(chunk);
  } catch {
    throw new NativeBinaryResolutionError('native_engine_unavailable');
  }
  const actual = `sha256:${hash.digest('hex')}`;
  if (actual !== expected) throw new NativeBinaryResolutionError('native_engine_checksum_mismatch');
}

function verifyVersion(binaryPath, expectedVersion, cwd) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let outputBytes = 0;
    const child = spawn(binaryPath, ['--version'], {
      cwd,
      env: Object.freeze({ PATH: process.env.PATH ?? '', LANG: 'C', LC_ALL: 'C' }),
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: false,
      windowsHide: true
    });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new NativeBinaryResolutionError('native_engine_version_mismatch'));
    }, VERSION_TIMEOUT_MS);
    child.on('error', () => finish(new NativeBinaryResolutionError('native_engine_version_mismatch')));
    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > VERSION_OUTPUT_LIMIT) {
        child.kill('SIGKILL');
        finish(new NativeBinaryResolutionError('native_engine_version_mismatch'));
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      if (code !== 0 || stdout.trim() !== `oaf ${expectedVersion}`) {
        finish(new NativeBinaryResolutionError('native_engine_version_mismatch'));
        return;
      }
      finish();
    });
  });
}

function defaultPackageResolver(packageRoot) {
  const require = createRequire(path.join(packageRoot, 'package.json'));
  return async (packageName) => require.resolve(`${packageName}/package.json`);
}

async function readJson(filePath, code) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    throw new NativeBinaryResolutionError(code);
  }
}

function exactVersion(value) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value ?? '')) {
    throw new NativeBinaryResolutionError('native_engine_manifest_invalid');
  }
  return value;
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function runtimeGlibcVersion() {
  try {
    return process.report?.getReport()?.header?.glibcVersionRuntime ?? null;
  } catch {
    return null;
  }
}

export const NATIVE_TARGETS = Object.freeze(Object.keys(TARGETS));
