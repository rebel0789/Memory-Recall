import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
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
const fleet = path.join(temp, 'fleet');
const fleetWorkspaceId = 'ws_installed_cross_repo';
const clientRoot = path.join(fleet, 'repositories', 'client');
const serviceRoot = path.join(fleet, 'repositories', 'service');
const decoyRoot = path.join(fleet, 'repositories', 'decoy');
const home = path.join(temp, 'home');
const npmCache = path.join(temp, 'npm-cache');
const packDirectory = path.join(temp, 'pack');
const prefix = path.join(temp, 'prefix');
const reinstallPrefix = path.join(temp, 'reinstall-prefix');
const runtimeBin = path.join(temp, 'runtime-bin');
const nativeBinary = path.resolve('rust', 'target', 'release', process.platform === 'win32' ? 'oaf.exe' : 'oaf');
const suppliedNativePackageTarball = process.env.MEMORY_RECALL_NATIVE_PACKAGE_TARBALL;
const suppliedRootPackageTarball = process.env.MEMORY_RECALL_ROOT_PACKAGE_TARBALL;
const fixtureRoot = path.resolve('evals', 'code-intelligence', 'fixtures');
const target = nativeTarget();
const languages = Object.freeze([
  'typescript', 'javascript', 'python', 'java', 'kotlin', 'csharp', 'go', 'rust',
  'php', 'ruby', 'swift', 'c', 'cpp', 'dart'
]);
const rawSourceSentinel = 'RAW_SOURCE_SENTINEL_INSTALLED_CONSUMER_9f47c2';
const governedMemory = path.join(workspace, '.local', 'memory.sqlite');
const smokeArguments = process.argv.slice(2);
const nativePolyglotOnly = smokeArguments.length === 1 && smokeArguments[0] === '--native-polyglot-only';
const goCrossRepositoryReceiptPath = nativePolyglotOnly ? null : parseGoCrossRepositoryReceiptPath(smokeArguments);
const goCrossRepositoryImplementationFiles = Object.freeze([
  'apps/cli/oaf.mjs',
  'packages/protocol/schemas/code-intelligence-repository-request.schema.json',
  'packages/protocol/schemas/code-intelligence-repository-response.schema.json',
  'providers/native/code-intelligence-rust/src/binary-resolver.mjs',
  'providers/native/code-intelligence-rust/src/index.mjs',
  'rust/oaf-index/src/registry.rs',
  'rust/oaf/src/code_intelligence.rs',
  'rust/oaf/src/repository_protocol.rs',
  'scripts/native-code-intelligence-consumer-smoke.mjs'
]);
let pendingGoCrossRepositoryReceipt = null;

consumerSmoke: try {
  if (goCrossRepositoryReceiptPath !== null) await rm(goCrossRepositoryReceiptPath, { force: true });
  if (!suppliedNativePackageTarball) {
    must((await stat(nativeBinary)).isFile(), 'build the local release native engine before running this smoke');
  }
  await mkdir(home, { recursive: true });
  const mcpConfig = path.join(home, '.cursor', 'mcp.json');
  await mkdir(path.dirname(mcpConfig), { recursive: true });
  await writeFile(mcpConfig, `${JSON.stringify({ mcpServers: { neighbor: { command: 'neighbor', args: ['serve'] } } }, null, 2)}\n`);
  await mkdir(npmCache, { recursive: true });
  await mkdir(packDirectory, { recursive: true });
  await mkdir(runtimeBin, { recursive: true });
  await createPolyglotWorkspace();
  await createCrossRepositoryWorkspace();
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
  const tarball = suppliedRootPackageTarball
    ? path.resolve(suppliedRootPackageTarball)
    : path.join(packDirectory, runJson('npm', ['pack', '--pack-destination', packDirectory, '--json'], { cwd: root })[0].filename);
  must((await stat(tarball)).isFile(), 'root package tarball is available');
  const {
    MEMORY_RECALL_NATIVE_BINARY: _ambientNativeBinary,
    MEMORY_RECALL_NATIVE_SHA256: _ambientNativeSha256,
    MEMORY_RECALL_NATIVE_PACKAGE_TARBALL: _ambientNativePackageTarball,
    MEMORY_RECALL_ROOT_PACKAGE_TARBALL: _ambientRootPackageTarball,
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
  verifyRootPackagePaths(await treeFiles(packageRoot));
  const installedCli = path.join(packageRoot, 'apps', 'cli', 'oaf.mjs');
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
  if (nativePolyglotOnly) {
    const legacyIntelligence = path.join(
      packageRoot,
      'providers',
      'native',
      'context-candidate-ast-code',
      'src',
      'index.mjs'
    );
    must((await stat(legacyIntelligence)).isFile(), 'installed package contains the legacy JS intelligence implementation');
    await writeFile(legacyIntelligence, "throw new Error('legacy_js_intelligence_invoked');\n");
  }
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
  if (nativePolyglotOnly) {
    must(await treeFingerprint(path.join(workspace, 'languages')) === initialSource, 'native fixture gate leaves consumer source unchanged');
    console.log(`PASS installed verified native platform package ${target}`);
    console.log('PASS compiler-free 14-language native graph and SQLite index without legacy JS intelligence');
    break consumerSmoke;
  }

  await withProcessEnvironment(isolatedEnvironment, async () => {
    const provider = new RustCodeIntelligenceProvider({ timeoutMs: 60_000 });
    for (const repositoryRoot of [clientRoot, serviceRoot, decoyRoot]) {
      await provider.buildIndex({ root: repositoryRoot, workspaceId: fleetWorkspaceId, languages: ['go'] });
    }
  });
  const repositoryIndexPaths = [clientRoot, serviceRoot, decoyRoot]
    .map((repositoryRoot) => path.join(repositoryRoot, '.local', 'source-index', 'index.v1.sqlite'));
  const repositoryBundlesBeforeQueries = await Promise.all(repositoryIndexPaths.map(fileBundleSnapshot));
  const crossNodes = await withProcessEnvironment(isolatedEnvironment, async () => {
    const provider = new RustCodeIntelligenceProvider({ timeoutMs: 60_000 });
    const exact = async (repositoryRoot, queryText) => {
      const result = await provider.queryIndex({
        root: repositoryRoot,
        workspaceId: fleetWorkspaceId,
        kind: 'exact',
        query: queryText,
        limit: 10
      });
      must(result.results.length === 1, `installed provider resolves one ${queryText} node`);
      return result.results[0];
    };
    const [clientEntry, serviceTarget, decoyTarget] = await Promise.all([
      exact(clientRoot, 'Build'),
      exact(serviceRoot, 'Service'),
      exact(decoyRoot, 'Service')
    ]);
    must(decoyTarget.id === serviceTarget.id, 'installed decoy preserves the same native symbol identity');
    const [clientStatus, serviceStatus] = await Promise.all([
      provider.indexStatus({ root: clientRoot, workspaceId: fleetWorkspaceId }),
      provider.indexStatus({ root: serviceRoot, workspaceId: fleetWorkspaceId })
    ]);
    for (const status of [clientStatus, serviceStatus]) {
      must(status.state === 'ready' && status.freshness === 'current', 'installed selected repository index is current');
      must(status.safeguards?.readOnly === true && status.safeguards?.localFilesWritten === 0, 'installed repository freshness check is read-only');
    }
    return { clientEntry, serviceTarget, decoyTarget, clientStatus, serviceStatus };
  });

  const repositoryCli = (commandArgs) => runJson(process.execPath, [installedCli, 'graph', 'repositories', ...commandArgs], {
    cwd: fleet,
    env: isolatedEnvironment
  });
  const clientRegistration = repositoryCli([
    'register', '--write', '--root', fleet, '--repository', 'repositories/client', '--name', 'Client',
    '--workspace', fleetWorkspaceId, '--format', 'json'
  ]);
  const serviceRegistration = repositoryCli([
    'register', '--write', '--root', fleet, '--repository', 'repositories/service', '--name', 'Service',
    '--workspace', fleetWorkspaceId, '--format', 'json'
  ]);
  const decoyRegistration = repositoryCli([
    'register', '--write', '--root', fleet, '--repository', 'repositories/decoy', '--name', 'Decoy',
    '--workspace', fleetWorkspaceId, '--format', 'json'
  ]);
  for (const registration of [clientRegistration, serviceRegistration, decoyRegistration]) {
    must(registration.engine?.selection === 'native-preview', 'installed repository registration uses native preview');
    must(registration.safeguards?.readOnly === false && registration.safeguards?.localFilesWritten === 1, 'installed repository registration requires one explicit local write');
  }
  const client = clientRegistration.repositories[0];
  const service = serviceRegistration.repositories[0];
  const decoy = decoyRegistration.repositories[0];
  const registryPath = path.join(fleet, '.local', 'source-index', 'registry.v1.sqlite');
  const registryBundleBeforeQueries = await fileBundleSnapshot(registryPath);
  const listedRepositories = repositoryCli([
    'list', '--read-only', '--root', fleet, '--workspace', fleetWorkspaceId, '--limit', '10', '--format', 'json'
  ]);
  must(listedRepositories.safeguards?.readOnly === true && listedRepositories.safeguards?.localFilesWritten === 0, 'installed repository list is read-only');
  must(new Set(listedRepositories.repositories.map(({ repositoryId }) => repositoryId)).size === 3, 'installed repository list returns all three registered repositories');
  const searchedRepositories = repositoryCli([
    'search', '--read-only', '--root', fleet, '--workspace', fleetWorkspaceId, '--query', 'Service',
    '--repository-ids', `${service.repositoryId},${decoy.repositoryId}`,
    '--per-repository-limit', '10', '--limit', '20', '--format', 'json'
  ]);
  must(searchedRepositories.safeguards?.readOnly === true && searchedRepositories.safeguards?.localFilesWritten === 0, 'installed repository search is read-only');
  must(
    new Set(searchedRepositories.results.map(({ repositoryId }) => repositoryId)).size === 2
      && searchedRepositories.results.some(({ repositoryId }) => repositoryId === service.repositoryId)
      && searchedRepositories.results.some(({ repositoryId }) => repositoryId === decoy.repositoryId),
    'installed repository search stays within the two selected repositories'
  );

  const crossRepository = {
    repositoryIds: [client.repositoryId, service.repositoryId],
    clientRepositoryId: client.repositoryId,
    serviceRepositoryId: service.repositoryId,
    clientEntryNativeId: crossNodes.clientEntry.id,
    serviceTargetNativeId: crossNodes.serviceTarget.id
  };
  const mcpRequests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'code.dependencies', arguments: { crossRepository } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'code.trace', arguments: { crossRepository, limit: 10 } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'code.impact', arguments: { crossRepository, limit: 10 } } }
  ];
  const installedMcp = run(process.execPath, [installedCli,
    'mcp', 'server', '--read-only', '--engine', 'native-preview', '--workspace', fleetWorkspaceId,
    '--root', fleet, '--stdio'
  ], {
    cwd: fleet,
    env: isolatedEnvironment,
    input: mcpRequests.map((request) => JSON.stringify(request)).join('\n'),
    maxBuffer: 2 * 1024 * 1024,
    timeout: 30_000
  });
  const mcpResponses = installedMcp.stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  const mcpPayload = (id) => {
    const response = mcpResponses.find((entry) => entry.id === id);
    must(response && !response.error, `installed cross-repository MCP call ${id} succeeds`);
    return JSON.parse(response.result.content[0].text);
  };
  const dependencies = mcpPayload(2);
  const trace = mcpPayload(3);
  const impact = mcpPayload(4);
  for (const payload of [dependencies, trace, impact]) {
    must(payload.safeguards?.readOnly === true && payload.safeguards?.localFilesWritten === 0, 'installed cross-repository MCP is read-only');
    must(payload.data?.source?.kind === 'native-persistent-repository-index', 'installed cross-repository MCP uses the native repository index');
    must(payload.data?.measurements?.selectedRepositoryCount === 2 && payload.data?.measurements?.openedRepositoryCount === 2, 'installed cross-repository MCP opens only the selected pair');
    const serialized = JSON.stringify(payload);
    must(!serialized.includes(decoy.repositoryId), 'installed cross-repository MCP excludes the decoy repository');
    must(!serialized.includes(rawSourceSentinel), 'installed cross-repository MCP omits raw source bodies');
    must(!serialized.includes(fleet), 'installed cross-repository MCP redacts the fleet path');
  }
  must(dependencies.data.modules.length === 2 && dependencies.data.relationships.length === 2, 'installed MCP resolves the exact Go dependency boundary');
  must(trace.data.paths.length === 1 && trace.data.relationships.some(({ kind }) => kind === 'constructs'), 'installed MCP returns one evidence-backed Go trace');
  must(
    impact.data.paths.length === 1
      && impact.data.impactedNodes.some(({ repositoryId, nativeId }) => repositoryId === client.repositoryId && nativeId === crossNodes.clientEntry.id),
    'installed MCP returns the exact reverse-impact client entry'
  );
  for (const relationship of dependencies.data.relationships) {
    must(relationship.resolution === 'exact_module_coordinate', 'installed MCP selects only exact Go module-coordinate evidence');
    must(/^workspace:\/\//u.test(relationship.evidenceLocator), 'installed MCP returns a workspace evidence locator');
    must(
      relationship.evidenceNativeRelationshipIds.length > 0
        && relationship.evidenceNativeRelationshipIds.every((id) => /^ciedge_[a-f0-9]{32}$/u.test(id)),
      'installed MCP binds every Go relationship to native evidence ids'
    );
  }
  const crossRepositoryPayloads = [dependencies, trace, impact];
  must(
    crossRepositoryPayloads.every((payload) => JSON.stringify(payload).length <= 1_048_576),
    'installed cross-repository MCP results stay within the output bound'
  );
  must(
    dependencies.data.relationships.length <= 10
      && trace.data.paths.length <= 10
      && impact.data.paths.length <= 10
      && impact.data.impactedNodes.length <= 10,
    'installed cross-repository MCP honors requested result bounds'
  );
  const repositoryBundlesAfterQueries = await Promise.all(repositoryIndexPaths.map(fileBundleSnapshot));
  must(
    repositoryBundlesBeforeQueries.every((before, index) => sameFileBundleSnapshot(before, repositoryBundlesAfterQueries[index])),
    'installed repository queries preserve every SQLite, WAL, and SHM bundle'
  );
  must(
    sameFileBundleSnapshot(registryBundleBeforeQueries, await fileBundleSnapshot(registryPath)),
    'installed repository queries preserve the registry SQLite, WAL, and SHM bundle'
  );
  if (goCrossRepositoryReceiptPath !== null) {
    pendingGoCrossRepositoryReceipt = await buildGoCrossRepositoryReceipt({
      target,
      nativeBinary,
      tarball,
      nativePackage,
      health,
      client,
      service,
      decoy,
      crossNodes,
      dependencies,
      trace,
      impact
    });
  }

  const stats = runJson(process.execPath, [installedCli,
    'graph', 'stats', '--root', cliWorkspace, '--engine', 'native-preview', '--format', 'json'
  ], { cwd: cliWorkspace, env: isolatedEnvironment });
  must(stats.engine?.selection === 'native-preview', 'packed CLI selects native preview explicitly');
  must(stats.engine?.previewOnly === true && stats.engine?.publicDefaultChanged === true, 'packed CLI reports strict native preview under the auto public default');
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

  const autoWithoutIndex = runJson(process.execPath, [installedCli, 'graph', 'stats', '--root', cliWorkspace, '--format', 'json'], {
    cwd: cliWorkspace,
    env: isolatedEnvironment
  });
  must(autoWithoutIndex.engine?.requested === 'auto' && autoWithoutIndex.engine?.selection === 'js', 'packed CLI defaults to auto and keeps the bounded JS fallback without a native index');
  must(autoWithoutIndex.engine?.reason === 'native_index_absent' && autoWithoutIndex.engine?.publicDefaultChanged === true, 'packed CLI labels the absent-index auto fallback');

  must(await treeFingerprint(path.join(workspace, 'languages')) === initialSource, 'native preview leaves consumer source unchanged');
  must(await treeFingerprint(cliWorkspace) === initialCliSource, 'native preview leaves CLI consumer source unchanged');
  must((await readFile(governedMemory)).equals(initialMemory), 'native preview leaves governed memory unchanged');
  must(await treeFingerprint(home) === initialHome, 'native preview leaves the isolated home and config unchanged');
  must(await treeFingerprint(packageRoot) === initialPackage, 'native preview leaves the installed package unchanged');
  must(await treeFingerprint(platformPackageRoot) === initialPlatformPackage, 'native preview leaves the platform package unchanged');

  const mcpInstallPreview = runJson(process.execPath, [installedCli,
    'mcp', 'install', '--client', 'cursor', '--home', home, '--root', cliWorkspace, '--format', 'json'
  ], { cwd: temp, env: isolatedEnvironment });
  must(mcpInstallPreview.status?.server === 'absent', 'packed CLI previews an absent MCP server entry');
  const cliRealRoot = await realpath(cliWorkspace);
  const cliIndexPath = path.join(cliRealRoot, '.local', 'source-index', 'index.v1.sqlite');
  const cliMemoryPath = path.join(cliRealRoot, '.local', 'memory.sqlite');
  const expectedIndexBuildCommand = `recall graph index --write --engine native-preview --root ${JSON.stringify(cliRealRoot)} --format summary`;
  must(mcpInstallPreview.indexBuildCommand === expectedIndexBuildCommand, 'packed CLI preview exposes the exact explicit native index build command');
  const mcpInstall = runJson(process.execPath, [installedCli,
    'mcp', 'install', '--client', 'cursor', '--home', home, '--root', cliWorkspace,
    '--apply', '--confirm', mcpInstallPreview.planFingerprint, '--format', 'json'
  ], { cwd: temp, env: isolatedEnvironment });
  must(mcpInstall.apply?.applied === true && mcpInstall.apply?.backupRef?.startsWith('home://'), 'packed CLI installs with a private config backup');
  const installedMcpConfig = JSON.parse(await readFile(mcpConfig, 'utf8'));
  must(installedMcpConfig.mcpServers?.neighbor?.command === 'neighbor', 'MCP install preserves neighboring servers');
  const installedMcpServer = installedMcpConfig.mcpServers?.oaf;
  must(installedMcpServer?.args?.includes('--read-only'), 'MCP install writes the read-only server entry');
  must(installedMcpServer.args.some((argument, index) => argument === '--engine' && installedMcpServer.args[index + 1] === 'auto'), 'MCP install persists contiguous --engine auto arguments');
  const callInstalledStructuralTool = (query) => {
    const requests = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'code.search', arguments: { query } } }
    ];
    const result = run(installedMcpServer.command, installedMcpServer.args, {
      cwd: cliWorkspace,
      env: isolatedEnvironment,
      input: requests.map((request) => JSON.stringify(request)).join('\n'),
      maxBuffer: 2 * 1024 * 1024,
      timeout: 30_000
    });
    const response = result.stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line)).find((entry) => entry.id === 2);
    must(response && !response.error, 'installed MCP structural tool call succeeds');
    return JSON.parse(response.result.content[0].text);
  };

  must((await fileBundleSnapshot(cliIndexPath)).every((snapshot) => snapshot === null), 'MCP install leaves source-index SQLite, WAL, and SHM absent');
  const absentIndexSearch = callInstalledStructuralTool('launchSmoke');
  must(absentIndexSearch.data?.source?.engine === 'js', 'installed auto MCP selects the JS engine when the native index is absent');
  must(absentIndexSearch.data?.source?.reason === 'native_index_absent', 'installed auto MCP labels the JS fallback when the native index is absent');
  must(absentIndexSearch.data?.results?.some((item) => item.label === 'launchSmoke'), 'installed auto MCP JS fallback returns the requested symbol');
  must(absentIndexSearch.safeguards?.readOnly === true && absentIndexSearch.safeguards?.localFilesWritten === 0, 'installed auto MCP JS fallback is read-only');
  must((await fileBundleSnapshot(cliIndexPath)).every((snapshot) => snapshot === null), 'installed auto MCP fallback does not create source-index SQLite, WAL, or SHM');
  must((await fileBundleSnapshot(cliMemoryPath)).every((snapshot) => snapshot === null), 'installed auto MCP fallback does not create memory SQLite, WAL, or SHM');

  const cliIndexBuild = runJson(process.execPath, [installedCli,
    'graph', 'index', '--write', '--engine', 'native-preview', '--root', cliWorkspace, '--format', 'json'
  ], { cwd: cliWorkspace, env: isolatedEnvironment });
  must(cliIndexBuild.command === 'graph index build' && cliIndexBuild.status === 'ready', 'packed CLI builds the native index only after the explicit writer command');
  must(cliIndexBuild.safeguards?.readOnly === false && cliIndexBuild.safeguards?.localFilesWritten === 1 && cliIndexBuild.safeguards?.canonicalMemoryWrites === 0, 'explicit packed CLI writer changes only the native index');
  const cliIndexBeforeNativeMcp = await fileBundleSnapshot(cliIndexPath);
  must(cliIndexBeforeNativeMcp[0] !== null, 'explicit native build creates the source-index SQLite database');
  const nativeIndexSearch = callInstalledStructuralTool('launchSmoke');
  must(nativeIndexSearch.data?.source?.kind === 'native-persistent-index-preview', 'installed auto MCP selects the current native index');
  must(nativeIndexSearch.data?.source?.engine === 'memory-recall-native' && nativeIndexSearch.data?.source?.freshness === 'current', 'installed auto MCP reports a current native source');
  must(nativeIndexSearch.data?.results?.some((item) => item.label === 'launchSmoke'), 'installed auto MCP native query returns the requested symbol');
  must(nativeIndexSearch.safeguards?.readOnly === true && nativeIndexSearch.safeguards?.localFilesWritten === 0, 'installed auto MCP native query is read-only');
  must(sameFileBundleSnapshot(await fileBundleSnapshot(cliIndexPath), cliIndexBeforeNativeMcp), 'installed auto MCP native read preserves SQLite bytes and mtime and leaves WAL and SHM unchanged');
  must((await fileBundleSnapshot(cliMemoryPath)).every((snapshot) => snapshot === null), 'installed auto MCP native read does not create memory SQLite, WAL, or SHM');

  const mcpUninstallPreview = runJson(process.execPath, [installedCli,
    'mcp', 'uninstall', '--client', 'cursor', '--home', home, '--format', 'json'
  ], { cwd: temp, env: isolatedEnvironment });
  must(mcpUninstallPreview.status?.server === 'installed', 'packed CLI recognizes its exact owned MCP entry');
  const mcpUninstall = runJson(process.execPath, [installedCli,
    'mcp', 'uninstall', '--client', 'cursor', '--home', home,
    '--apply', '--confirm', mcpUninstallPreview.planFingerprint, '--format', 'json'
  ], { cwd: temp, env: isolatedEnvironment });
  must(mcpUninstall.apply?.applied === true && mcpUninstall.apply?.backupRef?.startsWith('home://'), 'packed CLI removes its owned entry with a private backup');
  const removedMcpConfig = JSON.parse(await readFile(mcpConfig, 'utf8'));
  must(removedMcpConfig.mcpServers?.neighbor?.command === 'neighbor', 'MCP uninstall preserves neighboring servers');
  must(removedMcpConfig.mcpServers?.oaf === undefined, 'MCP uninstall removes only its owned server entry');
  const homeAfterMcpRemoval = await treeFingerprint(home);

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
  must(await treeFingerprint(home) === homeAfterMcpRemoval, 'package uninstall preserves home configuration and backups');

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
  must(await treeFingerprint(home) === homeAfterMcpRemoval, 'reinstall preserves home configuration and backups');

  if (goCrossRepositoryReceiptPath !== null) {
    await mkdir(path.dirname(goCrossRepositoryReceiptPath), { recursive: true });
    await writeFile(goCrossRepositoryReceiptPath, `${JSON.stringify(pendingGoCrossRepositoryReceipt, null, 2)}\n`);
  }

  console.log(`PASS installed verified native platform package ${target}`);
  console.log('PASS compiler-free 14-language graph and SQLite lifecycle');
  console.log('PASS automatic native preview stats and search');
  console.log('PASS installed repository CLI and cross-repository MCP');
  console.log('PASS invalid explicit native override fails closed');
  console.log('PASS no source, governed-memory, config, or package mutation');
  console.log('PASS auto is the public read default with a labeled bounded fallback');
  console.log('PASS packed MCP install and uninstall preserve neighboring config');
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

async function treeFiles(directory) {
  const files = [];
  await visit(directory, '');
  return files.sort();

  async function visit(current, relative) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(entryPath, entryRelative);
      else if (entry.isFile()) files.push(entryRelative);
      else throw new Error(`installed root package contains unsupported entry ${entryRelative}`);
    }
  }
}

function verifyRootPackagePaths(paths) {
  const installedPaths = new Set(paths);
  for (const required of [
    'apps/cli/oaf.mjs',
    'providers/native/code-intelligence-rust/provider.json',
    'providers/native/code-intelligence-rust/src/index.mjs',
    'providers/native/code-intelligence-rust/src/binary-resolver.mjs',
    'packages/source-graph/src/native-compatibility.mjs',
    'packages/protocol/schemas/code-intelligence-engine-request.schema.json',
    'packages/protocol/schemas/code-intelligence-engine-response.schema.json',
    'packages/protocol/schemas/code-intelligence-graph.schema.json'
  ]) must(installedPaths.has(required), `package includes ${required}`);
  for (const forbiddenPrefix of [
    'rust/target/',
    'evals/code-intelligence/results/',
    'tests/'
  ]) must(!paths.some((filePath) => filePath.startsWith(forbiddenPrefix)), `package excludes ${forbiddenPrefix}`);
  must(!installedPaths.has('scripts/native-code-intelligence-consumer-smoke.mjs'), 'package excludes checkout-only native consumer smoke');
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

async function createCrossRepositoryWorkspace() {
  const [routesSource, serviceSource] = await Promise.all([
    readFile(path.join(fixtureRoot, 'batch-b', 'go', 'api', 'routes.go'), 'utf8'),
    readFile(path.join(fixtureRoot, 'batch-b', 'go', 'service', 'service.go'), 'utf8')
  ]);
  await Promise.all([
    mkdir(path.join(clientRoot, 'api'), { recursive: true }),
    mkdir(path.join(serviceRoot, 'service'), { recursive: true }),
    mkdir(path.join(decoyRoot, 'service'), { recursive: true })
  ]);
  await Promise.all([
    writeFile(path.join(clientRoot, 'go.mod'), 'module example.com/client\n\ngo 1.22\n\nrequire example.com/demo v0.0.0\n'),
    writeFile(path.join(clientRoot, 'api', 'routes.go'), `// ${rawSourceSentinel}\n${routesSource}`),
    writeFile(path.join(serviceRoot, 'go.mod'), 'module example.com/demo\n\ngo 1.22\n'),
    writeFile(path.join(serviceRoot, 'service', 'service.go'), serviceSource),
    writeFile(path.join(decoyRoot, 'go.mod'), 'module example.com/wrong\n\ngo 1.22\n'),
    writeFile(path.join(decoyRoot, 'service', 'service.go'), serviceSource)
  ]);
  await Promise.all([clientRoot, serviceRoot, decoyRoot].map(initializeGitRepository));
}

function initializeGitRepository(repositoryRoot) {
  run('git', ['init', '--quiet', repositoryRoot]);
  run('git', ['-C', repositoryRoot, 'add', '.']);
  run('git', [
    '-C', repositoryRoot,
    '-c', 'user.name=Memory Recall Evidence',
    '-c', 'user.email=evidence@memory-recall.invalid',
    'commit', '--quiet', '-m', 'fixture'
  ], {
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2026-07-17T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-07-17T00:00:00Z'
    }
  });
}

function parseGoCrossRepositoryReceiptPath(argv) {
  if (argv.length === 0) return null;
  if (argv.length !== 2 || argv[0] !== '--go-cross-repository-receipt' || argv[1].length === 0) {
    throw new Error('usage: native-code-intelligence-consumer-smoke [--native-polyglot-only | --go-cross-repository-receipt <path>]');
  }
  return path.resolve(argv[1]);
}

async function buildGoCrossRepositoryReceipt({
  target,
  nativeBinary,
  tarball,
  nativePackage,
  health,
  client,
  service,
  decoy,
  crossNodes,
  dependencies,
  trace,
  impact
}) {
  const selectedGitRoots = [clientRoot, serviceRoot].map((repositoryRoot) => (
    run('git', ['-C', repositoryRoot, 'rev-parse', '--show-toplevel']).stdout.trim()
  ));
  must(new Set(selectedGitRoots).size === 2, 'installed selected repositories have independent Git metadata');
  const selectedGitHeads = [clientRoot, serviceRoot].map((repositoryRoot) => (
    run('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD']).stdout.trim()
  ));
  const rootPackage = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const evidence = dependencies.data.relationships.map((relationship) => ({
    id: relationship.id,
    kind: relationship.kind,
    resolution: relationship.resolution,
    evidenceLocator: relationship.evidenceLocator,
    evidenceNativeRelationshipIds: relationship.evidenceNativeRelationshipIds
  }));
  const receipt = {
    schemaVersion: '1.0.0',
    receiptVersion: 'memory-recall-phase5-go-cross-repository-1',
    phase: 5,
    generatedAt: new Date().toISOString(),
    environment: {
      platform: os.platform(),
      architecture: os.arch(),
      nodeVersion: process.version,
      nativeTarget: target
    },
    implementation: {
      files: [...goCrossRepositoryImplementationFiles],
      fingerprint: await filesFingerprint(goCrossRepositoryImplementationFiles),
      releaseBinarySha256: await fileSha256(nativeBinary)
    },
    packageEvidence: {
      rootPackage: `${rootPackage.name}@${rootPackage.version}`,
      rootTarballSha256: await fileSha256(tarball),
      nativePackage: `@memory-recall/native-${target}@${rootPackage.version}`,
      nativeTarballSha256: await fileSha256(nativePackage.tarball),
      installed: true,
      providerSource: health.details.source,
      providerVerified: health.details.verified,
      mcpEngine: 'native-preview'
    },
    fixture: {
      language: 'go',
      selectedIndependentGitRepositoryCount: 2,
      selectedGitHeadCommits: selectedGitHeads,
      decoyRepositoryCount: 1,
      identicalDecoyNativeId: crossNodes.decoyTarget.id === crossNodes.serviceTarget.id,
      clientModuleCoordinate: 'example.com/client',
      requiredModuleCoordinate: 'example.com/demo',
      decoyModuleCoordinate: 'example.com/wrong'
    },
    results: {
      selectedRepositoryCount: dependencies.data.measurements.selectedRepositoryCount,
      openedRepositoryCount: dependencies.data.measurements.openedRepositoryCount,
      selectedRepositoryFreshness: [crossNodes.clientStatus.freshness, crossNodes.serviceStatus.freshness],
      exactModuleEvidenceSelected: evidence.length === 2
        && evidence.every((relationship) => relationship.resolution === 'exact_module_coordinate'),
      identicalDecoyExcluded: !JSON.stringify({ dependencies, trace, impact }).includes(decoy.repositoryId),
      bounded: [dependencies, trace, impact].every((payload) => JSON.stringify(payload).length <= 1_048_576)
        && dependencies.data.relationships.length <= 10
        && trace.data.paths.length <= 10
        && impact.data.paths.length <= 10
        && impact.data.impactedNodes.length <= 10,
      sourceBacked: evidence.every((relationship) => /^workspace:\/\//u.test(relationship.evidenceLocator)
        && relationship.evidenceNativeRelationshipIds.length > 0),
      sqliteBundlesPreserved: true,
      relationshipEvidence: evidence,
      traceRelationshipIds: trace.data.relationships.map(({ id }) => id),
      impactNativeNodeIds: impact.data.impactedNodes.map(({ nativeId }) => nativeId)
    },
    safeguards: {
      readOnlyQueries: true,
      localFilesWrittenByQueries: 0,
      rawSourceBodiesIncluded: false,
      absolutePathsIncluded: false,
      networkCalls: 0,
      modelCalls: 0,
      published: false
    },
    claims: {
      exactGoCrossRepositoryBehavior: true,
      generalCrossLanguageBehavior: false,
      competitorParity: false,
      productionPublishReady: false
    }
  };
  receipt.receiptFingerprint = reportFingerprint(receipt);
  const serialized = JSON.stringify(receipt);
  must(!serialized.includes(temp), 'Go cross-repository receipt excludes temporary paths');
  must(!/(?:\/Users\/|\/home\/[A-Za-z0-9._-]+\/|\/private\/|\/var\/folders\/|[A-Za-z]:\\)/u.test(serialized), 'Go cross-repository receipt excludes absolute paths');
  must(receipt.results.exactModuleEvidenceSelected, 'Go cross-repository receipt requires exact module evidence');
  must(receipt.results.identicalDecoyExcluded, 'Go cross-repository receipt requires decoy exclusion');
  must(receipt.results.bounded && receipt.results.sourceBacked, 'Go cross-repository receipt requires bounded source evidence');
  must(receipt.results.selectedRepositoryFreshness.every((freshness) => freshness === 'current'), 'Go cross-repository receipt requires current selected repositories');
  return Object.freeze(receipt);
}

async function filesFingerprint(files) {
  const hash = createHash('sha256');
  for (const relative of [...files].sort()) {
    hash.update(`${relative}\0`);
    hash.update(await readFile(path.join(root, relative)));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

async function fileSha256(file) {
  return `sha256:${createHash('sha256').update(await readFile(file)).digest('hex')}`;
}

function reportFingerprint(report) {
  const comparable = { ...report };
  delete comparable.generatedAt;
  delete comparable.receiptFingerprint;
  return `sha256:${createHash('sha256').update(JSON.stringify(comparable)).digest('hex')}`;
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
