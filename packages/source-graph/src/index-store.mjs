import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  AST_CODE_PARSER_VERSION,
  buildJsTsSourceIndexFromShards,
  buildSourceGraphFromIndex,
  sanitizeSourceGraphPublicOutput,
  scanAstCodeWorkspace
} from '../../../providers/native/context-candidate-ast-code/src/index.mjs';

export const DEFAULT_SOURCE_GRAPH_INDEX_PATH = '.local/source-graph/index.v1.json';
const INDEX_SCHEMA_VERSION = '1.0.0';
const INDEX_FORMAT_VERSION = 'memory-recall-source-graph-index-1';

export async function buildPersistentSourceGraphIndex(options = {}) {
  const settings = normalizedSettings(options);
  const startedAt = Date.now();
  const scan = await scanAstCodeWorkspace({
    root: settings.root,
    workspaceId: settings.workspaceId,
    maxFiles: settings.maxFiles,
    maxFileBytes: settings.maxFileBytes,
    clock: settings.clock
  });
  const shards = shardsFromScan(scan);
  const sourceIndex = buildJsTsSourceIndexFromShards({
    workspaceId: settings.workspaceId,
    parserVersion: scan.parserVersion,
    shards,
    coverage: scan.coverage,
    discoveryIdentity: scan.discoveryIdentity,
    diagnostics: scan.diagnostics,
    clock: settings.clock
  });
  const graph = sanitizeSourceGraphPublicOutput(buildSourceGraphFromIndex(sourceIndex, { builtAt: settings.clock() }));
  const document = await indexDocument({ settings, scan, shards, graph });
  await writeIndexDocument(settings.indexPath, document);
  return indexResult(document, graph, {
    parsedFileCount: shards.length,
    reusedFileCount: 0,
    addedFileCount: shards.length,
    changedFileCount: 0,
    deletedFileCount: 0,
    durationMs: Date.now() - startedAt,
    rebuildReason: 'explicit_build',
    localFilesWritten: 1
  }, settings.relativePath);
}

export async function refreshPersistentSourceGraphIndex(options = {}) {
  const settings = normalizedSettings(options);
  const startedAt = Date.now();
  let current;
  try {
    current = await readIndexDocument(settings);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const built = await buildPersistentSourceGraphIndex(options);
    return Object.freeze({
      ...built,
      measurements: Object.freeze({ ...built.measurements, rebuildReason: 'index_missing' })
    });
  }
  const discovery = await scanAstCodeWorkspace({
    root: settings.root,
    workspaceId: settings.workspaceId,
    maxFiles: settings.maxFiles,
    maxFileBytes: settings.maxFileBytes,
    metadataOnly: true,
    clock: settings.clock
  });
  if (current.discoveryIdentity?.ignoreRuleFingerprint !== discovery.discoveryIdentity?.ignoreRuleFingerprint
      || current.settings.maxFiles !== settings.maxFiles
      || current.settings.maxFileBytes !== settings.maxFileBytes
      || current.parserVersion !== AST_CODE_PARSER_VERSION) {
    const rebuilt = await buildPersistentSourceGraphIndex(options);
    return Object.freeze({
      ...rebuilt,
      measurements: Object.freeze({ ...rebuilt.measurements, rebuildReason: 'index_identity_changed' })
    });
  }

  const previousManifest = new Map(current.manifest.map((entry) => [entry.relativePath, entry]));
  const nextManifest = new Map(discovery.discoveredFiles.map((entry) => [entry.relativePath, entry]));
  const added = [];
  const changed = [];
  const deleted = [...previousManifest.keys()].filter((relativePath) => !nextManifest.has(relativePath));
  for (const [relativePath, entry] of nextManifest) {
    const previous = previousManifest.get(relativePath);
    if (!previous) added.push(relativePath);
    else if (previous.size !== entry.size || previous.mtimeMs !== entry.mtimeMs) changed.push(relativePath);
  }
  const parsedPaths = [...added, ...changed].sort();
  if (!parsedPaths.length && !deleted.length) {
    return indexResult(current, Object.freeze(current.graph), {
      parsedFileCount: 0,
      reusedFileCount: current.manifest.length,
      addedFileCount: 0,
      changedFileCount: 0,
      deletedFileCount: 0,
      durationMs: Date.now() - startedAt,
      rebuildReason: null,
      localFilesWritten: 0
    }, settings.relativePath);
  }

  const parsedScan = parsedPaths.length
    ? await scanAstCodeWorkspace({
        root: settings.root,
        workspaceId: settings.workspaceId,
        maxFiles: Math.min(settings.maxFiles, parsedPaths.length),
        maxFileBytes: settings.maxFileBytes,
        onlyIncludes: parsedPaths,
        clock: settings.clock
      })
    : { chunks: [], fileOutlines: [] };
  const shardsByPath = new Map(current.shards.map((shard) => [relativePathFromLocator(shard.locator), shard]));
  for (const relativePath of [...deleted, ...changed]) shardsByPath.delete(relativePath);
  for (const shard of shardsFromScan(parsedScan)) shardsByPath.set(relativePathFromLocator(shard.locator), shard);
  const shards = [...shardsByPath.values()].sort((left, right) => left.locator.localeCompare(right.locator));
  const sourceIndex = buildJsTsSourceIndexFromShards({
    workspaceId: settings.workspaceId,
    shards,
    coverage: discovery.coverage,
    discoveryIdentity: discovery.discoveryIdentity,
    diagnostics: discovery.diagnostics,
    clock: settings.clock
  });
  const graph = sanitizeSourceGraphPublicOutput(buildSourceGraphFromIndex(sourceIndex, { builtAt: settings.clock() }));
  const scan = {
    parserVersion: AST_CODE_PARSER_VERSION,
    discoveredFiles: discovery.discoveredFiles,
    discoveryIdentity: discovery.discoveryIdentity,
    coverage: sourceIndex.coverage,
    diagnostics: discovery.diagnostics
  };
  const document = await indexDocument({ settings, scan, shards, graph });
  await writeIndexDocument(settings.indexPath, document);
  return indexResult(document, graph, {
    parsedFileCount: parsedPaths.length,
    reusedFileCount: Math.max(0, shards.length - parsedPaths.length),
    addedFileCount: added.length,
    changedFileCount: changed.length,
    deletedFileCount: deleted.length,
    durationMs: Date.now() - startedAt,
    rebuildReason: null,
    localFilesWritten: 1
  }, settings.relativePath);
}

export async function loadPersistentSourceGraphIndex(options = {}) {
  const settings = normalizedSettings(options);
  const document = await readIndexDocument(settings);
  const freshness = await indexFreshness(settings, document);
  const graph = sanitizeSourceGraphPublicOutput(document.graph);
  if (!graph.envelopeValid) throw indexInvalid();
  return Object.freeze({
    graph,
    source: Object.freeze({
      kind: 'persistent-index',
      freshness,
      persisted: true,
      indexLocator: workspaceIndexLocator(settings.relativePath),
      generatedAt: document.generatedAt
    })
  });
}

export async function readPersistentSourceGraphIndexStatus(options = {}) {
  const settings = normalizedSettings(options);
  try {
    const details = await stat(settings.indexPath);
    const document = await readIndexDocument(settings);
    const freshness = await indexFreshness(settings, document);
    return Object.freeze({
      schemaVersion: INDEX_SCHEMA_VERSION,
      status: freshness === 'current' ? 'ready' : 'stale',
      indexLocator: workspaceIndexLocator(settings.relativePath),
      persisted: true,
      bytes: details.size,
      fileCount: document.manifest.length,
      nodeCount: document.graph.nodes.length,
      edgeCount: document.graph.edges.length,
      generatedAt: document.generatedAt,
      parserVersion: document.parserVersion
    });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return Object.freeze({ schemaVersion: INDEX_SCHEMA_VERSION, status: 'not-built', indexLocator: workspaceIndexLocator(settings.relativePath), persisted: false, bytes: 0, fileCount: 0, nodeCount: 0, edgeCount: 0 });
    }
    return Object.freeze({ schemaVersion: INDEX_SCHEMA_VERSION, status: 'invalid', indexLocator: workspaceIndexLocator(settings.relativePath), persisted: false, bytes: 0, fileCount: 0, nodeCount: 0, edgeCount: 0, reasonCode: 'source_graph_index_invalid' });
  }
}

async function indexFreshness(settings, document) {
  const discovery = await scanAstCodeWorkspace({
    root: settings.root,
    workspaceId: settings.workspaceId,
    maxFiles: settings.maxFiles,
    maxFileBytes: settings.maxFileBytes,
    metadataOnly: true,
    clock: settings.clock
  });
  if (document.discoveryIdentity?.ignoreRuleFingerprint !== discovery.discoveryIdentity?.ignoreRuleFingerprint) return 'stale';
  if (document.manifest.length !== discovery.discoveredFiles.length) return 'stale';
  const previous = new Map(document.manifest.map((entry) => [entry.relativePath, entry]));
  for (const entry of discovery.discoveredFiles) {
    const stored = previous.get(entry.relativePath);
    if (!stored || stored.size !== entry.size || stored.mtimeMs !== entry.mtimeMs) return 'stale';
  }
  return 'current';
}

function normalizedSettings({
  root,
  workspaceId = 'ws_local',
  relativePath = DEFAULT_SOURCE_GRAPH_INDEX_PATH,
  maxFiles = 1000,
  maxFileBytes = 512 * 1024,
  clock = () => new Date().toISOString()
} = {}) {
  if (typeof root !== 'string' || !root) throw new Error('source_graph_index_root_required');
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes('..')) throw new Error('source_graph_index_path_invalid');
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 100_000) throw new Error('source_graph_index_max_files_invalid');
  if (!Number.isInteger(maxFileBytes) || maxFileBytes < 1024 || maxFileBytes > 1024 * 1024) throw new Error('source_graph_index_max_file_bytes_invalid');
  const resolvedRoot = path.resolve(root);
  const indexPath = path.resolve(resolvedRoot, relativePath);
  if (indexPath !== resolvedRoot && !indexPath.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error('source_graph_index_path_invalid');
  return Object.freeze({ root: resolvedRoot, workspaceId, relativePath: relativePath.replaceAll('\\', '/'), indexPath, maxFiles, maxFileBytes, clock });
}

async function indexDocument({ settings, scan, shards, graph }) {
  const rootReal = await realpath(settings.root);
  const outlineByLocator = new Map(shards.map((shard) => [shard.locator, shard.fileOutline]));
  return Object.freeze({
    schemaVersion: INDEX_SCHEMA_VERSION,
    formatVersion: INDEX_FORMAT_VERSION,
    workspaceId: settings.workspaceId,
    parserVersion: scan.parserVersion ?? AST_CODE_PARSER_VERSION,
    generatedAt: settings.clock(),
    rootIdentityHash: sha256(rootReal),
    settings: Object.freeze({ maxFiles: settings.maxFiles, maxFileBytes: settings.maxFileBytes }),
    discoveryIdentity: scan.discoveryIdentity,
    coverage: scan.coverage,
    diagnostics: scan.diagnostics,
    manifest: Object.freeze(scan.discoveredFiles.map((entry) => Object.freeze({
      relativePath: entry.relativePath,
      locator: entry.locator,
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      contentHash: outlineByLocator.get(entry.locator)?.contentHash ?? null
    }))),
    shards: Object.freeze(shards),
    graph
  });
}

function shardsFromScan(scan) {
  const chunksByFile = new Map();
  for (const chunk of scan.chunks ?? []) {
    const locator = fileLocator(chunk.locator);
    const values = chunksByFile.get(locator) ?? [];
    values.push(chunk);
    chunksByFile.set(locator, values);
  }
  return (scan.fileOutlines ?? []).map((fileOutline) => Object.freeze({
    locator: fileOutline.locator,
    fileOutline,
    chunks: Object.freeze((chunksByFile.get(fileOutline.locator) ?? []).sort((left, right) => left.locator.localeCompare(right.locator)))
  })).sort((left, right) => left.locator.localeCompare(right.locator));
}

async function readIndexDocument(settings) {
  let document;
  try {
    document = JSON.parse(await readFile(settings.indexPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') throw error;
    throw indexInvalid();
  }
  const rootReal = await realpath(settings.root);
  if (document?.schemaVersion !== INDEX_SCHEMA_VERSION
      || document?.formatVersion !== INDEX_FORMAT_VERSION
      || document?.workspaceId !== settings.workspaceId
      || document?.parserVersion !== AST_CODE_PARSER_VERSION
      || document?.rootIdentityHash !== sha256(rootReal)
      || !Array.isArray(document?.manifest)
      || !Array.isArray(document?.shards)
      || !Array.isArray(document?.graph?.nodes)
      || !Array.isArray(document?.graph?.edges)
      || document.manifest.some((entry) => !safeRelativePath(entry?.relativePath) || entry.locator !== `workspace://${entry.relativePath}`)
      || document.shards.some((shard) => !String(shard?.locator ?? '').startsWith('workspace://'))) {
    throw indexInvalid();
  }
  return document;
}

async function writeIndexDocument(indexPath, document) {
  await mkdir(path.dirname(indexPath), { recursive: true, mode: 0o700 });
  const temporary = `${indexPath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(document)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, indexPath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function indexResult(document, graph, measurements, relativePath) {
  return Object.freeze({
    schemaVersion: INDEX_SCHEMA_VERSION,
    status: 'ready',
    indexLocator: workspaceIndexLocator(relativePath),
    graph,
    measurements: Object.freeze(measurements),
    source: Object.freeze({ kind: 'persistent-index', freshness: 'current', persisted: true, generatedAt: document.generatedAt })
  });
}

function workspaceIndexLocator(relativePath) {
  return `workspace://${relativePath.replaceAll('\\', '/')}`;
}

function fileLocator(locator) {
  return String(locator ?? '').split('#', 1)[0];
}

function relativePathFromLocator(locator) {
  return String(locator ?? '').replace(/^workspace:\/\//u, '');
}

function safeRelativePath(value) {
  return typeof value === 'string' && Boolean(value) && !path.isAbsolute(value) && !value.split(/[\\/]/u).includes('..') && !/[\0\r\n]/u.test(value);
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function indexInvalid() {
  const error = new Error('source_graph_index_invalid');
  error.code = 'source_graph_index_invalid';
  return error;
}
