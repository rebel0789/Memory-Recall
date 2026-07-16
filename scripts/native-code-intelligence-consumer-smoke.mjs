import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import graphSchema from '../packages/protocol/schemas/code-intelligence-graph.schema.json' with { type: 'json' };
import { validateJsonSchema } from '../packages/protocol/src/schema-validator.mjs';
import { nativeTarget } from '../providers/native/code-intelligence-rust/src/binary-resolver.mjs';
import { packageNativePlatform, spawnNpmSync } from './package-native-platform.mjs';

const root = process.cwd();
const temp = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-native-consumer-'));
const workspace = path.join(temp, 'workspace');
const cliWorkspace = path.join(temp, 'cli-workspace');
const home = path.join(temp, 'home');
const npmCache = path.join(temp, 'npm-cache');
const packDirectory = path.join(temp, 'pack');
const prefix = path.join(temp, 'prefix');
const reinstallPrefix = path.join(temp, 'reinstall-prefix');
const runtimeBin = path.join(temp, 'runtime-bin');
const nativeBinary = path.resolve('rust', 'target', 'release', process.platform === 'win32' ? 'oaf.exe' : 'oaf');
const suppliedNativePackageTarball = process.env.MEMORY_RECALL_NATIVE_PACKAGE_TARBALL;
const fixtureRoot = path.resolve('evals', 'code-intelligence', 'fixtures');
const target = nativeTarget();
const languages = Object.freeze([
  'typescript', 'javascript', 'python', 'java', 'kotlin', 'csharp', 'go', 'rust',
  'php', 'ruby', 'swift', 'c', 'cpp', 'dart'
]);
const rawSourceSentinel = 'RAW_SOURCE_SENTINEL_INSTALLED_CONSUMER_9f47c2';
const governedMemory = path.join(workspace, '.local', 'memory.sqlite');

try {
  must((await stat(nativeBinary)).isFile(), 'build the local release native engine before running this smoke');
  await mkdir(home, { recursive: true });
  await mkdir(npmCache, { recursive: true });
  await mkdir(packDirectory, { recursive: true });
  await mkdir(runtimeBin, { recursive: true });
  await createPolyglotWorkspace();
  await mkdir(path.join(cliWorkspace, 'src'), { recursive: true });
  await writeFile(
    path.join(cliWorkspace, 'src', 'index.ts'),
    'export function launchSmoke(){ return helper(); }\nexport function helper(){ return "ready"; }\n'
  );
  await mkdir(path.dirname(governedMemory), { recursive: true });
  await writeFile(governedMemory, 'governed-memory-sentinel');
  await writeFile(path.join(workspace, 'package.json'), `${JSON.stringify({ name: 'native-preview-consumer' }, null, 2)}\n`);

  const initialSource = await treeFingerprint(path.join(workspace, 'languages'));
  const initialCliSource = await treeFingerprint(cliWorkspace);
  const initialMemory = await readFile(governedMemory);
  const nativePackage = suppliedNativePackageTarball
    ? { tarball: path.resolve(suppliedNativePackageTarball) }
    : await packageNativePlatform({ target, binaryPath: nativeBinary, outDirectory: packDirectory, root });
  must((await stat(nativePackage.tarball)).isFile(), 'native package tarball is available');
  const [pack] = runJson('npm', ['pack', '--pack-destination', packDirectory, '--json'], { cwd: root });
  const packedPaths = new Set(pack.files.map((file) => file.path));
  for (const required of [
    'apps/cli/oaf.mjs',
    'providers/native/code-intelligence-rust/provider.json',
    'providers/native/code-intelligence-rust/src/index.mjs',
    'providers/native/code-intelligence-rust/src/binary-resolver.mjs',
    'packages/source-graph/src/native-compatibility.mjs',
    'packages/protocol/schemas/code-intelligence-engine-request.schema.json',
    'packages/protocol/schemas/code-intelligence-engine-response.schema.json',
    'packages/protocol/schemas/code-intelligence-graph.schema.json'
  ]) must(packedPaths.has(required), `package includes ${required}`);
  for (const forbiddenPrefix of [
    'rust/target/',
    'evals/code-intelligence/results/',
    'tests/'
  ]) must(![...packedPaths].some((filePath) => filePath.startsWith(forbiddenPrefix)), `package excludes ${forbiddenPrefix}`);
  must(!packedPaths.has('scripts/native-code-intelligence-consumer-smoke.mjs'), 'package excludes checkout-only native consumer smoke');

  const tarball = path.join(packDirectory, pack.filename);
  const {
    MEMORY_RECALL_NATIVE_BINARY: _ambientNativeBinary,
    MEMORY_RECALL_NATIVE_SHA256: _ambientNativeSha256,
    MEMORY_RECALL_NATIVE_PACKAGE_TARBALL: _ambientNativePackageTarball,
    ...ambientEnvironment
  } = process.env;
  const installEnvironment = {
    ...ambientEnvironment,
    HOME: home,
    NPM_CONFIG_CACHE: npmCache
  };
  run('npm', [
    'install', '-g', '--prefix', prefix, tarball, nativePackage.tarball,
    '--ignore-scripts', '--offline', '--no-audit', '--no-fund'
  ], { cwd: temp, env: installEnvironment });

  const recall = process.platform === 'win32'
    ? path.join(prefix, 'recall.cmd')
    : path.join(prefix, 'bin', 'recall');
  must((await stat(recall)).isFile(), 'installed root package exposes the recall executable');
  const installedModules = run('npm', ['root', '--global', '--prefix', prefix], {
    cwd: temp,
    env: installEnvironment
  }).stdout.trim();
  const packageRoot = path.join(installedModules, 'memory-recall');
  const platformPackageRoot = path.join(installedModules, '@memory-recall', `native-${target}`);
  const isolatedEnvironment = {
    ...ambientEnvironment,
    HOME: home,
    PATH: runtimeBin,
    OAF_FIXED_NOW: '2026-07-16T00:00:00.000Z'
  };
  const initialHome = await treeFingerprint(home);
  const initialPackage = await treeFingerprint(packageRoot);
  const initialPlatformPackage = await treeFingerprint(platformPackageRoot);
  const indexPath = path.join(workspace, '.local', 'source-index', 'index.v1.sqlite');

  const providerUrl = pathToFileURL(path.join(packageRoot, 'providers', 'native', 'code-intelligence-rust', 'src', 'index.mjs')).href;
  const { RustCodeIntelligenceProvider } = await import(providerUrl);
  assertCommandUnavailable('cargo', isolatedEnvironment);
  assertCommandUnavailable('rustc', isolatedEnvironment);
  const { health, providerGraph, built, status, query } = await withProcessEnvironment(
    isolatedEnvironment,
    async () => {
      const provider = new RustCodeIntelligenceProvider({ timeoutMs: 60_000 });
      const health = await provider.health();
      const providerGraph = await provider.buildGraph({
        root: workspace,
        workspaceId: 'ws_installed_polyglot',
        languages,
        maxFiles: 1_000,
        maxNodes: 5_000,
        maxEdges: 10_000
      });
      const built = await provider.buildIndex({
        root: workspace,
        workspaceId: 'ws_installed_polyglot',
        languages,
        maxFiles: 1_000,
        maxNodes: 5_000,
        maxEdges: 10_000
      });
      const beforeReaders = await fileSnapshot(indexPath);
      const status = await provider.indexStatus({ root: workspace, workspaceId: 'ws_installed_polyglot' });
      const query = await provider.queryIndex({
        root: workspace,
        workspaceId: 'ws_installed_polyglot',
        kind: 'search',
        query: 'typescriptSentinel',
        limit: 25
      });
      must(sameFileSnapshot(await fileSnapshot(indexPath), beforeReaders), 'installed status and query leave the source index unchanged');
      return { health, providerGraph, built, status, query };
    }
  );
  must(health.status === 'healthy', 'installed provider reports healthy');
  must(health.details?.source === 'platform-package', 'installed provider auto-selects the platform package');
  must(health.details?.target === target, 'installed provider selects the current native target');
  must(health.details?.verified === true, 'installed provider verifies platform manifest, version, and checksum');
  const graphValidation = validateJsonSchema(graphSchema, providerGraph);
  must(graphValidation.valid, `installed provider returns the strict graph contract: ${graphValidation.errors.join('; ')}`);
  const representedLanguages = new Set(
    providerGraph.nodes
      .filter((node) => node.kind !== 'file')
      .map((node) => node.language)
  );
  for (const language of languages) must(representedLanguages.has(language), `installed provider parses ${language}`);
  must(representedLanguages.size === languages.length, 'installed provider returns only the requested Tier-1 languages');
  must(built.operation === 'index.build' && built.state === 'ready', 'installed provider builds the SQLite index');
  must(built.measurements?.parsedFileCount >= languages.length, 'installed index build parses every Tier-1 language fixture');
  must(built.safeguards?.localFilesWritten === 1, 'installed index build writes only its explicit local index');
  must(built.safeguards?.canonicalMemoryWrites === 0, 'installed index build does not write governed memory');
  must(status.operation === 'index.status' && status.state === 'ready', 'installed provider reads index status');
  must(status.safeguards?.readOnly === true && status.safeguards?.localFilesWritten === 0, 'installed index status is read-only');
  must(query.results?.some((item) => item.label === 'typescriptSentinel'), 'installed provider queries the persisted index');
  must(query.safeguards?.readOnly === true && query.safeguards?.localFilesWritten === 0, 'installed index query is read-only');
  const installedReports = JSON.stringify({ health, providerGraph, built, status, query });
  must(!installedReports.includes(workspace), 'installed native reports redact the workspace path');
  must(!installedReports.includes(rawSourceSentinel), 'installed native reports omit raw source bodies');

  const installedCli = path.join(packageRoot, 'apps', 'cli', 'oaf.mjs');
  const stats = runJson(process.execPath, [installedCli,
    'graph', 'stats', '--root', cliWorkspace, '--engine', 'native-preview', '--format', 'json'
  ], { cwd: cliWorkspace, env: isolatedEnvironment });
  must(stats.engine?.selection === 'native-preview', 'packed CLI selects native preview explicitly');
  must(stats.engine?.previewOnly === true && stats.engine?.publicDefaultChanged === false, 'packed CLI keeps native preview non-default');
  must(stats.graph?.summary?.fileCount >= 1 && stats.graph?.summary?.symbolCount >= 2, 'packed CLI reports native graph coverage');

  const search = runJson(process.execPath, [installedCli,
    'graph', 'search', '--root', cliWorkspace, '--query', 'launchSmoke', '--engine', 'native-preview', '--format', 'json'
  ], { cwd: cliWorkspace, env: isolatedEnvironment });
  must(search.search?.results?.some((item) => item.label === 'launchSmoke'), 'packed CLI native search returns launchSmoke');
  for (const report of [stats, search]) {
    must(report.safeguards?.canonicalStateMutated === false, 'native preview does not mutate canonical memory');
    must(report.safeguards?.localFilesWritten === 0, 'native preview writes no local files');
    must(report.safeguards?.networkCalls === 0, 'native preview makes no network calls');
    must(report.safeguards?.modelCalls === 0, 'native preview makes no model calls');
    must(report.safeguards?.rawBodyIncluded === false, 'native preview omits source bodies');
    must(!JSON.stringify(report).includes(cliWorkspace), 'native preview report redacts the workspace path');
  }

  const unavailable = runFailure(process.execPath, [installedCli,
    'graph', 'stats', '--root', cliWorkspace, '--engine', 'native-preview', '--format', 'json'
  ], {
    cwd: cliWorkspace,
    env: { ...isolatedEnvironment, MEMORY_RECALL_NATIVE_BINARY: path.join(temp, 'missing-native') }
  });
  must(unavailable.status === 2, 'invalid explicit native override fails closed');
  must(/native_engine_unavailable/u.test(unavailable.stderr), 'invalid explicit native override reports native_engine_unavailable');

  const jsDefault = runJson(process.execPath, [installedCli, 'graph', 'stats', '--root', cliWorkspace, '--format', 'json'], {
    cwd: cliWorkspace,
    env: isolatedEnvironment
  });
  must(jsDefault.engine?.selection === 'js' && jsDefault.engine?.publicDefaultChanged === false, 'packed CLI keeps JS as the default');

  must(await treeFingerprint(path.join(workspace, 'languages')) === initialSource, 'native preview leaves consumer source unchanged');
  must(await treeFingerprint(cliWorkspace) === initialCliSource, 'native preview leaves CLI consumer source unchanged');
  must((await readFile(governedMemory)).equals(initialMemory), 'native preview leaves governed memory unchanged');
  must(await treeFingerprint(home) === initialHome, 'native preview leaves the isolated home and config unchanged');
  must(await treeFingerprint(packageRoot) === initialPackage, 'native preview leaves the installed package unchanged');
  must(await treeFingerprint(platformPackageRoot) === initialPlatformPackage, 'native preview leaves the platform package unchanged');

  const indexBeforeUninstall = await fileBundleSnapshot(indexPath);
  run('npm', [
    'uninstall', '-g', '--prefix', prefix, 'memory-recall', `@memory-recall/native-${target}`,
    '--ignore-scripts', '--offline', '--no-audit', '--no-fund'
  ], { cwd: temp, env: installEnvironment });
  must(!(await pathExists(recall)), 'package uninstall removes the recall executable');
  must(!(await pathExists(packageRoot)), 'package uninstall removes the root package');
  must(!(await pathExists(platformPackageRoot)), 'package uninstall removes the native platform package');
  must(await treeFingerprint(path.join(workspace, 'languages')) === initialSource, 'package uninstall preserves consumer source');
  must((await readFile(governedMemory)).equals(initialMemory), 'package uninstall preserves governed memory');
  must(sameFileBundleSnapshot(await fileBundleSnapshot(indexPath), indexBeforeUninstall), 'package uninstall preserves SQLite, WAL, and SHM state');
  must(await treeFingerprint(home) === initialHome, 'package uninstall preserves home configuration');

  run('npm', [
    'install', '-g', '--prefix', reinstallPrefix, tarball, nativePackage.tarball,
    '--ignore-scripts', '--offline', '--no-audit', '--no-fund'
  ], { cwd: temp, env: installEnvironment });
  const reinstalledModules = run('npm', ['root', '--global', '--prefix', reinstallPrefix], {
    cwd: temp,
    env: installEnvironment
  }).stdout.trim();
  const reinstalledPackageRoot = path.join(reinstalledModules, 'memory-recall');
  const reinstalledProviderUrl = pathToFileURL(path.join(
    reinstalledPackageRoot,
    'providers',
    'native',
    'code-intelligence-rust',
    'src',
    'index.mjs'
  )).href;
  const { RustCodeIntelligenceProvider: ReinstalledProvider } = await import(reinstalledProviderUrl);
  const reopenQueries = ['typescriptSentinel', 'read_item', 'Register'];
  const reopened = await withProcessEnvironment(isolatedEnvironment, async () => {
    const provider = new ReinstalledProvider({ timeoutMs: 60_000 });
    const reopenedHealth = await provider.health();
    const reopenedStatus = await provider.indexStatus({ root: workspace, workspaceId: 'ws_installed_polyglot' });
    const reopenedQueries = [];
    for (const queryText of reopenQueries) {
      reopenedQueries.push(await provider.queryIndex({
        root: workspace,
        workspaceId: 'ws_installed_polyglot',
        kind: 'search',
        query: queryText,
        limit: 25
      }));
    }
    return { reopenedHealth, reopenedStatus, reopenedQueries };
  });
  must(reopened.reopenedHealth.status === 'healthy', 'reinstall restores a healthy native provider');
  must(reopened.reopenedHealth.details?.source === 'platform-package', 'reinstall rediscovers the native platform package');
  must(reopened.reopenedHealth.details?.verified === true, 'reinstall revalidates native package integrity');
  must(reopened.reopenedStatus.state === 'ready' && reopened.reopenedStatus.freshness === 'current', 'reinstall reopens the current index without rebuilding');
  must(reopened.reopenedStatus.activeGeneration === status.activeGeneration, 'reinstall preserves the active generation');
  must(JSON.stringify(reopened.reopenedStatus.summary) === JSON.stringify(status.summary), 'reinstall preserves the index summary');
  for (const [index, queryText] of reopenQueries.entries()) {
    const reopenedQuery = reopened.reopenedQueries[index];
    must(reopenedQuery.results?.some((item) => item.label === queryText), `reinstall queries ${queryText}`);
    must(reopenedQuery.safeguards?.readOnly === true && reopenedQuery.safeguards?.localFilesWritten === 0, `reinstall query ${queryText} is read-only`);
  }
  must(sameFileBundleSnapshot(await fileBundleSnapshot(indexPath), indexBeforeUninstall), 'reinstall status and queries preserve SQLite, WAL, and SHM state');
  must((await readFile(governedMemory)).equals(initialMemory), 'reinstall preserves governed memory');
  must(await treeFingerprint(path.join(workspace, 'languages')) === initialSource, 'reinstall preserves consumer source');
  must(await treeFingerprint(home) === initialHome, 'reinstall preserves home configuration');

  console.log(`PASS installed verified native platform package ${target}`);
  console.log('PASS compiler-free 14-language graph and SQLite lifecycle');
  console.log('PASS automatic native preview stats and search');
  console.log('PASS invalid explicit native override fails closed');
  console.log('PASS no source, governed-memory, config, or package mutation');
  console.log('PASS JavaScript remains the public default');
  console.log('PASS uninstall removes packages and preserves workspace-local state');
  console.log('PASS same-version reinstall reopens the existing index without rebuilding');
} finally {
  await rm(temp, { recursive: true, force: true });
}

function run(command, args, options = {}) {
  const result = command === 'npm'
    ? spawnNpmSync(args, { encoding: 'utf8', ...options })
    : spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout || result.error?.message || 'unknown error'}`);
  return result;
}

function runFailure(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  return result;
}

function runJson(command, args, options = {}) {
  return JSON.parse(run(command, args, options).stdout);
}

function must(condition, message) {
  if (!condition) throw new Error(message);
}

async function treeFingerprint(directory) {
  const files = [];
  await visit(directory, '');
  return createHash('sha256').update(files.join('\n')).digest('hex');

  async function visit(current, relative) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        files.push(`d:${entryRelative}`);
        await visit(entryPath, entryRelative);
      } else if (entry.isFile()) {
        const body = await readFile(entryPath);
        files.push(`f:${entryRelative}:${createHash('sha256').update(body).digest('hex')}`);
      } else if (entry.isSymbolicLink()) {
        files.push(`l:${entryRelative}`);
      }
    }
  }
}

async function createPolyglotWorkspace() {
  const fixtures = Object.freeze([
    ['python', 'batch-b/python'],
    ['go', 'batch-b/go'],
    ['rust', 'batch-b/rust'],
    ['java', 'batch-c/java'],
    ['kotlin', 'batch-c/kotlin'],
    ['csharp', 'batch-c/csharp'],
    ['c', 'batch-d/c'],
    ['cpp', 'batch-d/cpp'],
    ['dart', 'batch-d/dart'],
    ['swift', 'batch-d/swift'],
    ['php', 'batch-e/php'],
    ['ruby', 'batch-e/ruby']
  ]);
  for (const [language, relative] of fixtures) {
    await cp(path.join(fixtureRoot, relative), path.join(workspace, 'languages', language), { recursive: true });
  }
  await mkdir(path.join(workspace, 'languages', 'javascript'), { recursive: true });
  await mkdir(path.join(workspace, 'languages', 'typescript'), { recursive: true });
  await writeFile(
    path.join(workspace, 'languages', 'javascript', 'index.js'),
    `// ${rawSourceSentinel}\nimport { javascriptHelper } from './helper.js';\nexport function javascriptSentinel() { return javascriptHelper(); }\n`
  );
  await writeFile(
    path.join(workspace, 'languages', 'javascript', 'helper.js'),
    'export function javascriptHelper() { return 1; }\n'
  );
  await writeFile(
    path.join(workspace, 'languages', 'typescript', 'index.ts'),
    `// ${rawSourceSentinel}\nimport { typescriptHelper } from './helper.js';\nexport function typescriptSentinel(): number { return typescriptHelper(); }\n`
  );
  await writeFile(
    path.join(workspace, 'languages', 'typescript', 'helper.ts'),
    'export function typescriptHelper(): number { return 1; }\n'
  );
}

function assertCommandUnavailable(command, environment) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', env: environment });
  must(result.error?.code === 'ENOENT', `${command} is unavailable in the installed consumer runtime`);
}

async function withProcessEnvironment(environment, runTask) {
  const previous = new Map();
  for (const [name, value] of Object.entries(environment)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  for (const name of ['MEMORY_RECALL_NATIVE_BINARY', 'MEMORY_RECALL_NATIVE_SHA256']) {
    if (!previous.has(name)) previous.set(name, process.env[name]);
    delete process.env[name];
  }
  try {
    return await runTask();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function fileSnapshot(file) {
  const [metadata, body] = await Promise.all([stat(file), readFile(file)]);
  return Object.freeze({
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    sha256: createHash('sha256').update(body).digest('hex')
  });
}

async function fileBundleSnapshot(file) {
  return Promise.all([file, `${file}-wal`, `${file}-shm`].map(async (candidate) => (
    await pathExists(candidate) ? fileSnapshot(candidate) : null
  )));
}

function sameFileBundleSnapshot(left, right) {
  return left.length === right.length && left.every((snapshot, index) => (
    snapshot === null ? right[index] === null : right[index] !== null && sameFileSnapshot(snapshot, right[index])
  ));
}

async function pathExists(file) {
  return stat(file).then(() => true, (error) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
}

function sameFileSnapshot(left, right) {
  return left.size === right.size && left.mtimeMs === right.mtimeMs && left.sha256 === right.sha256;
}
