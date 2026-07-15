import { createHash } from 'node:crypto';
import { lstat, realpath, watch } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';

const realpathAsync = promisify(realpath);
const lstatAsync = promisify(lstat);
const SUPPORTED_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);
const EXCLUDED_SEGMENTS = new Set([
  '.git', '.worktrees', 'node_modules', '.venv', 'venv', 'site-packages',
  '.agents', '.claude', '.next', 'coverage', 'test-results', 'playwright-report',
  '.cache', '.pytest_cache', '.turbo', '.parcel-cache', 'dist', 'build', 'out',
  '.generated', 'generated-output', 'vendor'
]);
const MAX_FILE_LOCATORS = 1000;
const MAX_IGNORE_LOCATORS = 100;
const MAX_DIRECTORY_LOCATORS = 2000;

export function createSourceGraphSnapshotService({
  buildGraph,
  watchRoot = defaultWatchRoot,
  freshnessProbe = defaultFreshnessProbe,
  clock = Date.now
} = {}) {
  if (typeof buildGraph !== 'function') throw new Error('source_graph_snapshot_build_required');
  const entries = new Map();
  const canonicalRoots = new Map();
  const rootAliases = new Map();
  let closed = false;

  async function getSnapshot(request = {}) {
    if (closed) throw new Error('source_graph_snapshot_service_closed');
    const requestedRoot = path.resolve(String(request.root ?? ''));
    const rootPromise = canonicalRoots.get(requestedRoot) ?? canonicalRootFor(request.root);
    canonicalRoots.set(requestedRoot, rootPromise);
    let canonicalRoot;
    try {
      canonicalRoot = await rootPromise;
    } catch (error) {
      canonicalRoots.delete(requestedRoot);
      throw error;
    }
    rootAliases.set(requestedRoot, canonicalRoot);
    const key = snapshotKey(canonicalRoot, request);
    const entry = entries.get(key) ?? createEntry({ canonicalRoot, key, request });
    entries.set(key, entry);
    if (request.refresh) markEntryDirty(entry, 'refresh_requested');

    if (entry.inFlight) {
      const result = await entry.inFlight;
      return Object.freeze({ ...result, reuse: 'inflight' });
    }

    if (entry.graph && !entry.dirty && entry.validationMode === 'metadata-scan') {
      const manifest = await freshnessProbe(canonicalRoot, entry.graph);
      if (manifest !== entry.manifest) markEntryDirty(entry, 'metadata_changed');
    }
    if (entry.graph && !entry.dirty) return snapshotResult(entry, { reuse: 'cache' });

    const build = buildEntry(entry, { ...request, root: canonicalRoot });
    entry.inFlight = build;
    try {
      return await build;
    } finally {
      entry.inFlight = null;
    }
  }

  function createEntry({ canonicalRoot, key, request }) {
    const entry = {
      key,
      canonicalRoot,
      request: snapshotOptions(request),
      graph: null,
      identity: null,
      manifest: null,
      dirty: true,
      dirtyGeneration: 0,
      dirtyReason: 'cold_start',
      generation: 0,
      inFlight: null,
      watcher: null,
      validationMode: 'watcher',
      lastBuildDurationMs: null,
      lastErrorReason: null
    };
    try {
      entry.watcher = watchRoot(canonicalRoot, (eventType, filename) => {
        if (relevantWatchEvent(eventType, filename)) markEntryDirty(entry, 'filesystem_changed');
      });
      entry.watcher?.on?.('error', (error) => {
        if (watchFallbackError(error)) {
          try {
            entry.watcher?.close();
          } catch {
            // The failed watcher may already be closed.
          }
          entry.watcher = null;
          entry.validationMode = 'metadata-scan';
          markEntryDirty(entry, 'watcher_unavailable');
          return;
        }
        markEntryDirty(entry, 'watcher_error');
      });
    } catch (error) {
      if (!watchFallbackError(error)) throw error;
      entry.validationMode = 'metadata-scan';
    }
    return entry;
  }

  async function buildEntry(entry, request) {
    const startedAt = numericClock(clock);
    try {
      const graph = await buildGraph(request);
      const duration = Math.max(0, numericClock(clock) - startedAt);
      const manifest = entry.validationMode === 'metadata-scan'
        ? await freshnessProbe(entry.canonicalRoot, graph)
        : null;
      entry.graph = graph;
      entry.identity = snapshotIdentity(entry.canonicalRoot, graph);
      entry.manifest = manifest;
      entry.dirty = false;
      entry.dirtyReason = null;
      entry.generation += 1;
      entry.lastBuildDurationMs = duration;
      entry.lastErrorReason = null;
      return snapshotResult(entry, { reuse: 'cold' });
    } catch (error) {
      entry.lastBuildDurationMs = Math.max(0, numericClock(clock) - startedAt);
      entry.lastErrorReason = safeErrorCode(error);
      if (!entry.graph) throw error;
      return snapshotResult(entry, { reuse: 'cold', status: 'stale', reason: entry.lastErrorReason });
    }
  }

  function markDirty(root, reason = 'manual_invalidation') {
    const normalized = path.resolve(String(root ?? ''));
    const canonicalRoot = rootAliases.get(normalized) ?? normalized;
    let marked = 0;
    for (const entry of entries.values()) {
      if (entry.canonicalRoot !== canonicalRoot) continue;
      markEntryDirty(entry, reason);
      marked += 1;
    }
    return marked;
  }

  function inspect(root) {
    const normalized = path.resolve(String(root ?? ''));
    const canonicalRoot = rootAliases.get(normalized) ?? normalized;
    const entry = [...entries.values()].find((candidate) => candidate.canonicalRoot === canonicalRoot);
    if (!entry) return null;
    return Object.freeze({
      root: entry.canonicalRoot,
      identity: entry.identity,
      dirty: entry.dirty,
      dirtyGeneration: entry.dirtyGeneration,
      generation: entry.generation,
      validationMode: entry.validationMode,
      lastBuildDurationMs: entry.lastBuildDurationMs,
      lastErrorReason: entry.lastErrorReason
    });
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const entry of entries.values()) {
      try {
        entry.watcher?.close();
      } catch {
        // Closing a local cache must remain best-effort.
      }
    }
    entries.clear();
    canonicalRoots.clear();
    rootAliases.clear();
  }

  return Object.freeze({ getSnapshot, markDirty, inspect, close });
}

function snapshotResult(entry, { reuse, status = 'fresh', reason = null }) {
  return Object.freeze({
    graph: entry.graph,
    status,
    reuse,
    reason,
    generation: entry.generation,
    validationMode: entry.validationMode,
    buildDurationMs: entry.lastBuildDurationMs,
    builtAt: entry.graph?.builtAt ?? null
  });
}

function markEntryDirty(entry, reason) {
  entry.dirty = true;
  entry.dirtyGeneration += 1;
  entry.dirtyReason = safeCode(reason, 'manual_invalidation');
}

function snapshotOptions(request) {
  return {
    workspaceId: request.workspaceId,
    maxFiles: request.maxFiles,
    maxFileBytes: request.maxFileBytes,
    maxNodes: request.maxNodes,
    maxEdges: request.maxEdges
  };
}

function snapshotKey(canonicalRoot, request) {
  return JSON.stringify({ canonicalRoot, ...snapshotOptions(request) });
}

function snapshotIdentity(canonicalRoot, graph) {
  return sha256(JSON.stringify({
    canonicalRoot,
    graphVersion: graph?.graphVersion ?? null,
    parserVersion: graph?.parserVersion ?? null,
    ignoreRuleFingerprint: graph?.summary?.coverage?.ignoreRuleFingerprint ?? null,
    sourceIndexFingerprint: graph?.sourceIndexFingerprint ?? null
  }));
}

async function canonicalRootFor(root) {
  if (typeof root !== 'string' || !root) throw new Error('source_graph_snapshot_root_required');
  return realpathAsync(path.resolve(root));
}

function defaultWatchRoot(root, listener) {
  return watch(root, { recursive: true }, listener);
}

async function defaultFreshnessProbe(root, graph) {
  const locators = new Set(['workspace://.']);
  const fileLocators = (graph?.nodes ?? [])
    .filter((node) => node.kind === 'file')
    .map((node) => fileLocator(node.locator))
    .filter(Boolean)
    .slice(0, MAX_FILE_LOCATORS);
  const ignoreLocators = (graph?.summary?.coverage?.ignoreFileLocators ?? [])
    .map(fileLocator)
    .filter(Boolean)
    .slice(0, MAX_IGNORE_LOCATORS);
  for (const locator of [...fileLocators, ...ignoreLocators]) locators.add(locator);

  const directoryLocators = new Set();
  for (const locator of fileLocators) {
    const parts = relativeLocator(locator).split('/');
    parts.pop();
    for (let index = 1; index <= parts.length && directoryLocators.size < MAX_DIRECTORY_LOCATORS; index += 1) {
      directoryLocators.add(`workspace://${parts.slice(0, index).join('/')}`);
    }
  }
  for (const locator of directoryLocators) locators.add(locator);

  const tuples = [];
  for (const locator of [...locators].sort()) {
    const filename = filenameForLocator(root, locator);
    if (!filename) continue;
    try {
      const details = await lstatAsync(filename);
      tuples.push({ locator, size: details.size, mtimeMs: Math.trunc(details.mtimeMs) });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      tuples.push({ locator, size: -1, mtimeMs: 0 });
    }
  }
  return sha256(JSON.stringify(tuples));
}

function filenameForLocator(root, locator) {
  if (locator === 'workspace://.') return root;
  const relative = relativeLocator(locator);
  if (!relative || relative.includes('\\') || path.posix.isAbsolute(relative) || relative.split('/').some((part) => !part || part === '.' || part === '..')) return null;
  const filename = path.resolve(root, ...relative.split('/'));
  const fromRoot = path.relative(root, filename);
  if (fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) return null;
  return filename;
}

function fileLocator(locator) {
  const relative = relativeLocator(locator);
  return relative ? `workspace://${relative}` : null;
}

function relativeLocator(locator) {
  const value = String(locator ?? '').split('#', 1)[0];
  if (!value.startsWith('workspace://')) return '';
  return value.slice('workspace://'.length);
}

function relevantWatchEvent(eventType, filename) {
  if (!['change', 'rename'].includes(String(eventType))) return false;
  const relative = String(filename ?? '').replaceAll('\\', '/');
  if (!relative) return true;
  const segments = relative.split('/').filter(Boolean);
  if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) return false;
  const basename = segments.at(-1) ?? '';
  if (basename === '.gitignore' || basename === '.recallignore') return true;
  const extension = path.posix.extname(basename).toLowerCase();
  return !extension || SUPPORTED_EXTENSIONS.has(extension);
}

function watchFallbackError(error) {
  return ['ERR_FEATURE_UNAVAILABLE', 'ERR_INVALID_ARG_VALUE'].includes(error?.code);
}

function safeErrorCode(error) {
  return safeCode(error?.message, 'source_graph_snapshot_build_failed');
}

function safeCode(value, fallback) {
  const normalized = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/gu, '_')
    .replace(/_+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 64);
  return /^[a-z][a-z0-9_]{0,63}$/u.test(normalized) ? normalized : fallback;
}

function numericClock(clock) {
  const value = Number(clock());
  return Number.isFinite(value) ? value : Date.now();
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
