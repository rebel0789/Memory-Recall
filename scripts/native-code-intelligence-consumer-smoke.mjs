import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import graphSchema from '../packages/protocol/schemas/code-intelligence-graph.schema.json' with { type: 'json' };
import { validateJsonSchema } from '../packages/protocol/src/schema-validator.mjs';

const root = process.cwd();
const temp = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-native-consumer-'));
const workspace = path.join(temp, 'workspace');
const home = path.join(temp, 'home');
const npmCache = path.join(temp, 'npm-cache');
const packDirectory = path.join(temp, 'pack');
const prefix = path.join(temp, 'prefix');
const nativeBinary = path.resolve('rust', 'target', 'release', process.platform === 'win32' ? 'oaf.exe' : 'oaf');

try {
  must((await stat(nativeBinary)).isFile(), 'build the local release native engine before running this smoke');
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(npmCache, { recursive: true });
  await mkdir(packDirectory, { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), `${JSON.stringify({ name: 'native-preview-consumer' }, null, 2)}\n`);
  await writeFile(path.join(workspace, 'src', 'index.ts'), [
    'export function launchSmoke(){ return helper(); }',
    'export function helper(){ return "ready"; }',
    ''
  ].join('\n'));

  const initialWorkspace = await treeFingerprint(workspace);
  const [pack] = runJson('npm', ['pack', '--pack-destination', packDirectory, '--json'], { cwd: root });
  const packedPaths = new Set(pack.files.map((file) => file.path));
  for (const required of [
    'apps/cli/oaf.mjs',
    'providers/native/code-intelligence-rust/provider.json',
    'providers/native/code-intelligence-rust/src/index.mjs',
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
  const { MEMORY_RECALL_NATIVE_BINARY: _ambientNativeBinary, ...ambientEnvironment } = process.env;
  const installEnvironment = {
    ...ambientEnvironment,
    HOME: home,
    NPM_CONFIG_CACHE: npmCache
  };
  run('npm', [
    'install', '-g', '--prefix', prefix, tarball,
    '--ignore-scripts', '--offline', '--no-audit', '--no-fund'
  ], { cwd: temp, env: installEnvironment });

  const recall = path.join(prefix, 'bin', process.platform === 'win32' ? 'recall.cmd' : 'recall');
  const packageRoot = path.join(prefix, 'lib', 'node_modules', 'memory-recall');
  const isolatedEnvironment = {
    ...ambientEnvironment,
    HOME: home,
    PATH: `${path.join(prefix, 'bin')}${path.delimiter}${ambientEnvironment.PATH ?? ''}`,
    OAF_FIXED_NOW: '2026-07-16T00:00:00.000Z'
  };
  const nativeEnvironment = {
    ...isolatedEnvironment,
    MEMORY_RECALL_NATIVE_BINARY: nativeBinary
  };
  const initialHome = await treeFingerprint(home);
  const initialPackage = await treeFingerprint(packageRoot);

  const providerUrl = pathToFileURL(path.join(packageRoot, 'providers', 'native', 'code-intelligence-rust', 'src', 'index.mjs')).href;
  const { RustCodeIntelligenceProvider } = await import(providerUrl);
  const providerGraph = await new RustCodeIntelligenceProvider({ binaryPath: nativeBinary }).buildGraph({ root: workspace });
  const graphValidation = validateJsonSchema(graphSchema, providerGraph);
  must(graphValidation.valid, `installed provider returns the strict graph contract: ${graphValidation.errors.join('; ')}`);
  must(providerGraph.nodes.some((node) => node.name === 'launchSmoke'), 'installed provider graph contains launchSmoke');
  must(!JSON.stringify(providerGraph).includes(workspace), 'installed provider graph redacts the workspace path');

  const stats = runJson(recall, [
    'graph', 'stats', '--root', workspace, '--engine', 'native-preview', '--format', 'json'
  ], { cwd: workspace, env: nativeEnvironment });
  must(stats.engine?.selection === 'native-preview', 'packed CLI selects native preview explicitly');
  must(stats.engine?.previewOnly === true && stats.engine?.publicDefaultChanged === false, 'packed CLI keeps native preview non-default');
  must(stats.graph?.summary?.fileCount >= 1 && stats.graph?.summary?.symbolCount >= 2, 'packed CLI reports native graph coverage');

  const search = runJson(recall, [
    'graph', 'search', '--root', workspace, '--query', 'launchSmoke', '--engine', 'native-preview', '--format', 'json'
  ], { cwd: workspace, env: nativeEnvironment });
  must(search.search?.results?.some((item) => item.label === 'launchSmoke'), 'packed CLI native search returns launchSmoke');
  for (const report of [stats, search]) {
    must(report.safeguards?.canonicalStateMutated === false, 'native preview does not mutate canonical memory');
    must(report.safeguards?.localFilesWritten === 0, 'native preview writes no local files');
    must(report.safeguards?.networkCalls === 0, 'native preview makes no network calls');
    must(report.safeguards?.modelCalls === 0, 'native preview makes no model calls');
    must(report.safeguards?.rawBodyIncluded === false, 'native preview omits source bodies');
    must(!JSON.stringify(report).includes(workspace), 'native preview report redacts the workspace path');
  }

  const unavailable = runFailure(recall, [
    'graph', 'stats', '--root', workspace, '--engine', 'native-preview', '--format', 'json'
  ], { cwd: workspace, env: isolatedEnvironment });
  must(unavailable.status === 2, 'native preview fails closed without the explicit binary override');
  must(/native_engine_unavailable/u.test(unavailable.stderr), 'missing native engine reports native_engine_unavailable');

  const jsDefault = runJson(recall, ['graph', 'stats', '--root', workspace, '--format', 'json'], {
    cwd: workspace,
    env: isolatedEnvironment
  });
  must(jsDefault.engine?.selection === 'js' && jsDefault.engine?.publicDefaultChanged === false, 'packed CLI keeps JS as the default');

  must(await treeFingerprint(workspace) === initialWorkspace, 'native preview leaves the consumer workspace unchanged');
  must(await treeFingerprint(home) === initialHome, 'native preview leaves the isolated home and config unchanged');
  must(await treeFingerprint(packageRoot) === initialPackage, 'native preview leaves the installed package unchanged');

  console.log('PASS packed native provider and protocol contract');
  console.log('PASS explicit native preview stats and search');
  console.log('PASS missing native binary fails closed');
  console.log('PASS no network, model, memory, config, package, or workspace writes');
  console.log('PASS JavaScript remains the public default');
} finally {
  await rm(temp, { recursive: true, force: true });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
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
