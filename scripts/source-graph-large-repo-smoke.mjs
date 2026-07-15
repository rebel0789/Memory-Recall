import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import sourceGraphPreviewSchema from '../packages/protocol/schemas/source-graph-preview.schema.json' with { type: 'json' };
import { validateJsonSchema } from '../packages/protocol/src/schema-validator.mjs';
import {
  buildSourceGraphPreview,
  createSourceGraphSnapshotService
} from '../packages/source-graph/src/index.mjs';

const configuredRoot = process.env.MEMORY_RECALL_LARGE_REPO_ROOT || null;
let generatedRoot = null;
let service = null;

try {
  const root = configuredRoot ? await configuredRepositoryRoot(configuredRoot) : await generatedRepository();
  if (!configuredRoot) generatedRoot = root;
  service = createSourceGraphSnapshotService();
  const request = {
    root,
    workspaceId: 'ws_large_smoke',
    query: 'target0 shared graph',
    sampleLimit: 3,
    maxFiles: 1000,
    maxFileBytes: 512 * 1024,
    snapshotService: service
  };

  const coldStarted = performance.now();
  const first = await buildSourceGraphPreview(request);
  const coldMs = elapsedMs(coldStarted);
  const cachedStarted = performance.now();
  const second = await buildSourceGraphPreview(request);
  const cachedMs = elapsedMs(cachedStarted);
  const protocolValid = validateJsonSchema(sourceGraphPreviewSchema, first).valid;

  must(first.graph.summary.fileCount > 0, 'large_repo_graph_empty');
  must(!first.graph.diagnostics.some(({ code }) => code.startsWith('source_graph_unavailable')), 'large_repo_graph_unavailable');
  must(first.graph.summary.nodeCount <= 20_000, 'large_repo_node_budget_exceeded');
  must(first.graph.summary.edgeCount <= 50_000, 'large_repo_edge_budget_exceeded');
  must(second.snapshot.reuse === 'cache', 'large_repo_snapshot_not_reused');
  must(cachedMs <= coldMs * 0.2, `large_repo_cache_not_80_percent_faster:${coldMs}:${cachedMs}`);
  must(protocolValid, 'large_repo_preview_protocol_invalid');
  must(first.safeguards.networkCalls === 0, 'large_repo_network_call_detected');
  must(first.safeguards.modelCalls === 0, 'large_repo_model_call_detected');
  must(first.safeguards.externalWritesEnabled === false, 'large_repo_external_write_enabled');
  must(first.safeguards.rawBodyIncluded === false, 'large_repo_raw_body_included');
  must(first.safeguards.graphDatabaseUsed === false, 'large_repo_graph_database_used');
  if (!configuredRoot) verifyGeneratedCoverage(first.graph.summary.coverage);

  console.log(JSON.stringify({
    schemaVersion: '1.0.0',
    rootKind: configuredRoot ? 'configured' : 'generated',
    coldMs,
    cachedMs,
    cacheReductionPercent: Number(((1 - cachedMs / coldMs) * 100).toFixed(2)),
    snapshot: second.snapshot,
    summary: first.graph.summary,
    diagnostics: first.graph.diagnostics.map(({ code }) => code),
    safeguards: first.safeguards,
    protocolValid
  }, null, 2));
} finally {
  service?.close();
  if (generatedRoot) await rm(generatedRoot, { recursive: true, force: true });
}

async function configuredRepositoryRoot(value) {
  if (!path.isAbsolute(value)) throw new Error('large_repo_root_must_be_absolute');
  return realpath(value);
}

async function generatedRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-large-repo-'));
  const featureRoot = path.join(root, 'src', 'features');
  const routeRoot = path.join(root, 'apps', 'api', 'users', '[userRef]');
  const webRoot = path.join(root, 'apps', 'web');
  await Promise.all([
    mkdir(featureRoot, { recursive: true }),
    mkdir(routeRoot, { recursive: true }),
    mkdir(webRoot, { recursive: true }),
    mkdir(path.join(root, '.worktrees', 'old', 'src'), { recursive: true }),
    mkdir(path.join(root, '.venv', 'lib'), { recursive: true }),
    mkdir(path.join(root, 'generated-output'), { recursive: true }),
    mkdir(path.join(root, 'dist'), { recursive: true })
  ]);
  const targetNames = Array.from({ length: 40 }, (_, index) => `target${index}`);
  const coreBody = targetNames.map((name, index) => `export function ${name}(){ return ${index}; }`).join('\n');
  await Promise.all([
    writeFile(path.join(root, '.recallignore'), 'apps/web/ignored-by-recall.js\n'),
    writeFile(path.join(webRoot, '.gitignore'), 'ignored-by-git.js\n'),
    writeFile(path.join(webRoot, 'ignored-by-git.js'), 'export const ignoredByGit = true;\n'),
    writeFile(path.join(webRoot, 'ignored-by-recall.js'), 'export const ignoredByRecall = true;\n'),
    writeFile(path.join(routeRoot, 'route.js'), 'export function GET(){ return true; }\n'),
    writeFile(path.join(root, 'src', 'core.js'), `${coreBody}\n`),
    writeFile(path.join(root, '.worktrees', 'old', 'src', 'ignored.js'), 'export const ignoredWorktree = true;\n'),
    writeFile(path.join(root, '.venv', 'lib', 'ignored.js'), 'export const ignoredVenv = true;\n'),
    writeFile(path.join(root, 'generated-output', 'ignored.js'), 'export const ignoredGenerated = true;\n'),
    writeFile(path.join(root, 'dist', 'ignored.js'), 'export const ignoredDist = true;\n')
  ]);

  const imports = `import { ${targetNames.join(', ')} } from '../core.js';`;
  const calls = targetNames.map((name) => `${name}()`).join(' + ');
  for (let start = 0; start < 1100; start += 50) {
    const batch = Array.from({ length: Math.min(50, 1100 - start) }, (_, offset) => {
      const index = start + offset;
      const suffix = String(index).padStart(4, '0');
      const body = `${imports}\nexport function caller${suffix}(){\n  return ${calls};\n}\n`;
      return writeFile(path.join(featureRoot, `feature-${suffix}.js`), body);
    });
    await Promise.all(batch);
  }
  return root;
}

function verifyGeneratedCoverage(coverage) {
  must(coverage.candidateEdgeCount > 50_000, `large_repo_candidate_relations_too_small:${coverage.candidateEdgeCount}`);
  must(coverage.ignoredFileCount >= 2, `large_repo_ignore_rules_not_applied:${coverage.ignoredFileCount}`);
  must(coverage.excludedDirectoryCount >= 4, `large_repo_default_exclusions_not_applied:${coverage.excludedDirectoryCount}`);
  must(coverage.maxFilesReached === true, 'large_repo_supported_file_budget_not_exercised');
  must(coverage.status === 'partial', `large_repo_partial_coverage_not_reported:${coverage.status}`);
}

function elapsedMs(startedAt) {
  return Number(Math.max(0.001, performance.now() - startedAt).toFixed(3));
}

function must(condition, code) {
  if (!condition) throw new Error(code);
}
