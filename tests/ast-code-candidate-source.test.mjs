import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateJsonSchema } from '../packages/protocol/src/schema-validator.mjs';
import {
  compileContextFromSources,
  createCandidateSourceRegistry,
  createFixtureRecordReader,
  generateContextCandidates
} from '../packages/context-compiler/src/index.mjs';
import {
  buildJsTsSourceIndex,
  buildJsTsSourceGraph,
  buildSourceGraphFromIndex,
  createNativeAstCodeCandidateSource,
  createNativeSourceGraphCandidateSource,
  mapSourceGraphDiffImpact,
  querySourceIndex,
  readAstCodeSlice,
  searchSourceGraph,
  scanAstCodeWorkspace,
  traceSourceGraph
} from '../providers/native/context-candidate-ast-code/src/index.mjs';

const fixedNow = '2026-06-23T00:00:00.000Z';

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function fixtureWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaf-ast-source-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'auth.ts'), [
    "import { z } from 'zod';",
    "import { compileContext } from '../context/compiler';",
    '',
    'export class TokenResetService {',
    '  async approveTokenReset(request: ResetRequest) {',
    '    const parsed = z.object({}).safeParse(request);',
    "    return compileContext(parsed.success ? request : request, 'private implementation body');",
    '  }',
    '}',
    '',
    'export function buildAuditEvidence(manifestId: string) {',
    "  return { manifestId, kind: 'auth-incident' };",
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'workflow.ts'), [
    "import { TokenResetService } from './auth';",
    '',
    'export function runAuthWorkflow(request: ResetRequest) {',
    '  const service = new TokenResetService();',
    '  return service.approveTokenReset(request);',
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'constants.ts'), [
    'export const kyOptionKeys = { retry: true };',
    'export const requestOptionsRegistry = { method: true };'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'options.ts'), [
    'import {',
    '  kyOptionKeys,',
    '  requestOptionsRegistry',
    "} from './constants.js';",
    '',
    'export const findUnknownOptions = (',
    '  options: Record<string, unknown>,',
    '): Record<string, unknown> => {',
    '  const unknownOptions: Record<string, unknown> = {};',
    '  for (const key in options) {',
    '    if (!(key in requestOptionsRegistry) && !(key in kyOptionKeys)) unknownOptions[key] = options[key];',
    '  }',
    '  return unknownOptions;',
    '};'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'multi.ts'), [
    'export class MultiMethodService {',
    '  first() {',
    "    return 'first';",
    '  }',
    '  second() {',
    '    return helper();',
    '  }',
    '}',
    '',
    'export function helper() {',
    "  return 'helper';",
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'local-path.ts'), [
    "import secretValue from '/Users/rebel/private/secret';",
    'export function localPathImport() {',
    '  return secretValue;',
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'broken.ts'), [
    'export function brokenParserCase() {',
    "  return 'missing close brace';"
  ].join('\n'));
  return root;
}

function request(overrides = {}) {
  return {
    schemaVersion: '1.0.0',
    requestId: 'ccreq_ast_code',
    correlationId: 'req_ast_code_000000',
    workspaceId: 'ws_ast',
    actorId: 'usr_owner',
    taskId: 'task_ast_code',
    step: 'select auth incident implementation evidence',
    objective: 'approve token reset auth incident audit evidence manifest compiler',
    requiredIds: [],
    requiredEntities: ['symbol:approveTokenReset', 'import:zod'],
    allowedDataClasses: ['workspace-private'],
    allowedTrustClasses: ['verified', 'observed'],
    allowedScopes: ['workspace-private'],
    sourcePlan: [{ kind: 'ast-code', required: false, limit: 8, timeoutMs: 1000 }],
    perSourceLimit: 8,
    totalCandidateLimit: 8,
    trustedTimestamp: fixedNow,
    tokenBudget: 120,
    ...overrides
  };
}

test('AST code chunk protocol fixtures validate and reject raw source bodies', async () => {
  const schema = await readJson('packages/protocol/schemas/ast-code-chunk.schema.json');
  const valid = await readJson('examples/protocol/ast-code-chunk.json');
  const invalid = await readJson('examples/protocol/compatibility/invalid/ast-code-chunk-raw-body.json');
  const symbolSchema = await readJson('packages/protocol/schemas/source-symbol-index.schema.json');
  const symbolValid = await readJson('examples/protocol/source-symbol-index.json');
  const symbolInvalid = await readJson('examples/protocol/compatibility/invalid/source-symbol-index-raw-body.json');
  const graphSchema = await readJson('packages/protocol/schemas/source-graph.schema.json');
  const graphValid = await readJson('examples/protocol/source-graph.json');
  const graphInvalidRawBody = await readJson('examples/protocol/compatibility/invalid/source-graph-raw-body.json');
  const graphInvalidLocalPath = await readJson('examples/protocol/compatibility/invalid/source-graph-local-path.json');

  assert.equal(validateJsonSchema(schema, valid).valid, true);
  const invalidResult = validateJsonSchema(schema, invalid);
  assert.equal(invalidResult.valid, false);
  assert(invalidResult.errors.some((error) => error.keyword === 'additionalProperties'));
  assert.equal(validateJsonSchema(symbolSchema, symbolValid).valid, true);
  const invalidSymbolResult = validateJsonSchema(symbolSchema, symbolInvalid);
  assert.equal(invalidSymbolResult.valid, false);
  assert(invalidSymbolResult.errors.some((error) => error.keyword === 'additionalProperties' || error.keyword === 'pattern'));
  assert.equal(validateJsonSchema(graphSchema, graphValid).valid, true);
  const invalidGraphRawBodyResult = validateJsonSchema(graphSchema, graphInvalidRawBody);
  assert.equal(invalidGraphRawBodyResult.valid, false);
  assert(invalidGraphRawBodyResult.errors.some((error) => error.keyword === 'additionalProperties'));
  const invalidGraphLocalPathResult = validateJsonSchema(graphSchema, graphInvalidLocalPath);
  assert.equal(invalidGraphLocalPathResult.valid, false);
  assert(invalidGraphLocalPathResult.errors.some((error) => error.keyword === 'pattern'));

  const invalidLocator = await readJson('examples/protocol/compatibility/invalid/ast-code-chunk-local-workspace-path.json');
  const invalidLocatorResult = validateJsonSchema(schema, invalidLocator);
  assert.equal(invalidLocatorResult.valid, false);
  assert(invalidLocatorResult.errors.some((error) => error.keyword === 'pattern'));
});

test('native AST code source returns deterministic sanitized candidates for JS and TS files', async () => {
  const root = await fixtureWorkspace();
  const source = createNativeAstCodeCandidateSource({ root, workspaceId: 'ws_ast', clock: () => fixedNow });
  const descriptor = source.descriptor();
  assert.equal(descriptor.id, 'provider:native:context-candidate:ast-code');
  assert.equal(descriptor.kind, 'ast-code');
  assert.equal(descriptor.enabled, true);

  const result = await generateContextCandidates(request(), {
    registry: createCandidateSourceRegistry([source]),
    recordReader: createFixtureRecordReader([])
  });

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.reports.map((report) => [report.sourceKind, report.status]), [['ast-code', 'succeeded']]);
  assert(result.candidates.length >= 1);
  const candidate = result.candidates.find((item) => item.record.text.includes('approveTokenReset'));
  assert(candidate);
  assert.equal(candidate.record.workspaceId, 'ws_ast');
  assert.equal(candidate.record.kind, 'code_chunk');
  assert.equal(candidate.record.dataClass, 'workspace-private');
  assert.equal(candidate.record.trustClass, 'observed');
  assert.match(candidate.record.source, /^workspace:\/\/src\/auth\.ts#L\d+-L\d+$/);
  assert(candidate.record.tags.includes('symbol:approveTokenReset'));
  assert(candidate.record.tags.includes('import:zod'));
  assert.equal(candidate.record.metadata.path, 'src/auth.ts');
  assert.equal(candidate.record.metadata.representation, 'source-locator-summary');
  assert(candidate.hits.every((hit) => hit.sourceKind === 'ast-code'));
  assert(candidate.hits.every((hit) => /^sha256:[a-f0-9]{64}$/.test(hit.queryFingerprint)));

  const serialized = JSON.stringify(result);
  assert(!serialized.includes('private implementation body'));
  assert(!serialized.includes(root));
  assert(!serialized.includes('/Users/'));
  assert(!serialized.includes('/Users/rebel/private/secret'));

  const compiled = await compileContextFromSources(request(), {
    registry: createCandidateSourceRegistry([source]),
    recordReader: createFixtureRecordReader([])
  });
  assert(compiled.manifest.selected.some((item) => item.id === candidate.record.id));
});

test('native source graph candidate source returns locator-only graph hits without raw source bodies', async () => {
  const root = await fixtureWorkspace();
  const source = createNativeSourceGraphCandidateSource({ root, workspaceId: 'ws_ast', clock: () => fixedNow });
  const descriptor = source.descriptor();
  assert.equal(descriptor.id, 'provider:native:context-candidate:graph');
  assert.equal(descriptor.kind, 'graph');

  const result = await generateContextCandidates(request({
    sourcePlan: [{ kind: 'graph', required: false, limit: 8, timeoutMs: 1000 }]
  }), {
    registry: createCandidateSourceRegistry([source]),
    recordReader: createFixtureRecordReader([])
  });

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.reports.map((report) => [report.sourceKind, report.status]), [['graph', 'succeeded']]);
  const candidate = result.candidates.find((item) => item.record.text.includes('approveTokenReset'));
  assert(candidate);
  assert.equal(candidate.record.kind, 'observation');
  assert.equal(candidate.record.metadata.representation, 'source-graph-locator');
  assert.equal(candidate.record.metadata.path, 'src/auth.ts');
  assert(candidate.hits.every((hit) => hit.sourceKind === 'graph'));
  assert(candidate.hits.some((hit) => hit.reasonCodes.includes('source_graph_match')));

  const serialized = JSON.stringify(result);
  assert(!serialized.includes('private implementation body'));
  assert(!serialized.includes(root));
  assert(!serialized.includes('/Users/'));
  assert(!serialized.includes('/Users/rebel/private/secret'));
});

test('native source graph candidate source carries resolved relative import neighbors', async () => {
  const root = await fixtureWorkspace();
  const source = createNativeSourceGraphCandidateSource({ root, workspaceId: 'ws_ast', clock: () => fixedNow });

  const result = await generateContextCandidates(request({
    objective: 'find unknown fetch options forwarded by options helper',
    step: 'include imported constants used by the helper',
    requiredEntities: [],
    sourcePlan: [{ kind: 'graph', required: false, limit: 10, timeoutMs: 1000 }],
    perSourceLimit: 10,
    totalCandidateLimit: 10
  }), {
    registry: createCandidateSourceRegistry([source]),
    recordReader: createFixtureRecordReader([])
  });

  const importedConstants = result.candidates.find((item) => item.record.metadata?.path === 'src/constants.ts');
  assert(importedConstants);
  assert.equal(importedConstants.record.metadata.representation, 'source-graph-locator');
  assert(importedConstants.hits.some((hit) => hit.reasonCodes.includes('source_graph_neighbor') || hit.reasonCodes.includes('lexical_match')));
  assert(!JSON.stringify(result).includes('kyOptionKeys = { retry: true }'));
});

test('native source graph candidate source keeps direct matches ahead of neighbor expansion', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaf-graph-fairness-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'hub.ts'), [
    "import { directNeedle } from './direct-needle.js';",
    "import { noisyOne } from './noisy-one.js';",
    "import { noisyTwo } from './noisy-two.js';",
    "import { noisyThree } from './noisy-three.js';",
    'export function centralHubNeedle() {',
    '  return directNeedle();',
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'direct-needle.ts'), "export function directNeedle() { return 'needle'; }\n");
  await writeFile(path.join(root, 'src', 'noisy-one.ts'), "export function noisyOne() { return 'one'; }\n");
  await writeFile(path.join(root, 'src', 'noisy-two.ts'), "export function noisyTwo() { return 'two'; }\n");
  await writeFile(path.join(root, 'src', 'noisy-three.ts'), "export function noisyThree() { return 'three'; }\n");

  const source = createNativeSourceGraphCandidateSource({ root, workspaceId: 'ws_ast', clock: () => fixedNow });
  const result = await generateContextCandidates(request({
    objective: 'central hub direct needle implementation',
    step: 'central hub direct needle implementation',
    requiredEntities: [],
    sourcePlan: [{ kind: 'graph', required: false, limit: 5, timeoutMs: 1000 }],
    perSourceLimit: 5,
    totalCandidateLimit: 5
  }), {
    registry: createCandidateSourceRegistry([source]),
    recordReader: createFixtureRecordReader([])
  });

  const firstNeighborIndex = result.candidates.findIndex((item) => item.hits.some((hit) => hit.reasonCodes.includes('source_graph_neighbor')));
  const directNeedleIndex = result.candidates.findIndex((item) => item.record.metadata?.path === 'src/direct-needle.ts');
  assert(directNeedleIndex >= 0);
  assert(firstNeighborIndex >= 0);
  assert(directNeedleIndex < firstNeighborIndex);
});

test('AST scanner bounds filesystem access, parse diagnostics, exact slices, and cache invalidation', async () => {
  const root = await fixtureWorkspace();
  const outside = await mkdtemp(path.join(os.tmpdir(), 'oaf-ast-outside-'));
  await writeFile(path.join(outside, 'secret.ts'), 'export function outsideSecret() { return "outside"; }\n');
  await symlink(path.join(outside, 'secret.ts'), path.join(root, 'src', 'linked-secret.ts'));
  await writeFile(path.join(root, 'src', 'huge.ts'), 'export const hugeValue = 1;\n'.repeat(200));

  const first = await scanAstCodeWorkspace({
    root,
    workspaceId: 'ws_ast',
    maxFileBytes: 512,
    clock: () => fixedNow
  });

  assert(first.chunks.some((chunk) => chunk.entities.some((entity) => entity.name === 'approveTokenReset')));
  assert(first.chunks.some((chunk) => chunk.parseErrorState === 'unbalanced_braces'));
  assert(first.diagnostics.some((item) => item.code === 'file_too_large' && item.locator === 'workspace://src/huge.ts'));
  assert(first.diagnostics.some((item) => item.code === 'symlink_skipped' && item.locator === 'workspace://src/linked-secret.ts'));
  assert(!JSON.stringify(first).includes('outsideSecret'));
  assert(!JSON.stringify(first).includes(outside));
  assert(!JSON.stringify(first).includes('/Users/rebel/private/secret'));

  const authChunk = first.chunks.find((chunk) => chunk.entities.some((entity) => entity.name === 'approveTokenReset') && chunk.locator.startsWith('workspace://src/auth.ts#L5'));
  const slice = await readAstCodeSlice({ root, chunk: authChunk });
  assert(slice.includes('approveTokenReset'));
  assert(slice.includes('private implementation body'));
  assert.equal(authChunk.exactSourceReconstructionHash, authChunk.contentHash);
  assert.match(authChunk.signatureHash, /^sha256:[a-f0-9]{64}$/);
  assert.match(authChunk.sourceSnapshotId, /^srcsnap_[a-f0-9]{16}$/);

  await writeFile(path.join(root, 'src', 'auth.ts'), [
    "import { z } from 'zod';",
    'export function approveTokenReset() {',
    "  return 'changed implementation';",
    '}'
  ].join('\n'));
  const second = await scanAstCodeWorkspace({ root, workspaceId: 'ws_ast', maxFileBytes: 512, clock: () => fixedNow });
  const changedChunk = second.chunks.find((chunk) => chunk.entities.some((entity) => entity.name === 'approveTokenReset'));
  assert.notEqual(changedChunk.contentHash, authChunk.contentHash);
});

test('AST scanner handles large template-heavy workspace files without CPU spin', () => {
  const script = [
    "import('./providers/native/context-candidate-ast-code/src/index.mjs').then(async ({scanAstCodeWorkspace})=>{",
    "const scan=await scanAstCodeWorkspace({root:'packages/harness-context/src',workspaceId:'ws_ast',maxFiles:1,clock:()=> '2026-06-23T00:00:00.000Z'});",
    "if(scan.fileCount!==1 || scan.chunkCount<1) throw new Error('scan did not index harness context');",
    "}).catch((error)=>{console.error(error);process.exit(1);});"
  ].join('');
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.signal, null, result.stderr || result.stdout);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('JS and TS source index exposes definitions references imports exports outlines and calls without raw source', async () => {
  const root = await fixtureWorkspace();
  const index = await buildJsTsSourceIndex({
    root,
    workspaceId: 'ws_ast',
    clock: () => fixedNow
  });

  assert.equal(index.repositoryOutline.fileCount, 7);
  assert(index.repositoryOutline.symbolCount >= 4);
  assert.match(index.sourceIndexFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.match(index.symbolIndex.symbolIndexFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert(index.contentJournal.every((item) => /^sha256:[a-f0-9]{64}$/.test(item.contentHash)));

  const definitions = querySourceIndex(index, { operation: 'definition', name: 'approveTokenReset' });
  assert(definitions.some((item) => item.kind === 'method' && item.locator.startsWith('workspace://src/auth.ts#L')));

  const references = querySourceIndex(index, { operation: 'references', name: 'approveTokenReset' });
  assert(references.some((item) => item.sourceLocator.startsWith('workspace://src/workflow.ts#L')));

  const imports = querySourceIndex(index, { operation: 'imports', module: 'zod' });
  assert.equal(imports.length, 1);
  assert(imports.some((item) => item.locator.startsWith('workspace://src/auth.ts#L')));
  const multilineImports = querySourceIndex(index, { operation: 'imports', module: './constants.js' });
  assert.equal(multilineImports.length, 1);
  assert(multilineImports.some((item) => item.locator.startsWith('workspace://src/options.ts#L')));
  const absoluteImports = querySourceIndex(index, { operation: 'imports', module: 'local:absolute-import' });
  assert.equal(absoluteImports.length, 1);

  const exports = querySourceIndex(index, { operation: 'exports', name: 'TokenResetService' });
  assert(exports.some((item) => item.kind === 'class'));

  const callers = querySourceIndex(index, { operation: 'callers', name: 'approveTokenReset' });
  assert(callers.some((item) => item.callerName === 'runAuthWorkflow'));

  const callees = querySourceIndex(index, { operation: 'callees', name: 'runAuthWorkflow' });
  assert(callees.some((item) => item.calleeName === 'approveTokenReset'));
  const helperCallers = querySourceIndex(index, { operation: 'callers', name: 'helper' });
  assert(helperCallers.some((item) => item.callerName === 'second'));
  assert(!helperCallers.some((item) => item.callerName === 'first'));
  const firstCallees = querySourceIndex(index, { operation: 'callees', name: 'first' });
  assert(!firstCallees.some((item) => ['second', 'helper'].includes(item.calleeName)));

  const fileOutline = querySourceIndex(index, { operation: 'file-outline', locator: 'workspace://src/auth.ts' });
  assert.equal(fileOutline.length, 1);
  assert(fileOutline[0].symbols.some((item) => item.name === 'TokenResetService'));

  const serialized = JSON.stringify(index);
  assert(!serialized.includes('private implementation body'));
  assert(!serialized.includes(root));
  assert(!serialized.includes('/Users/'));
  assert(!serialized.includes('/Users/rebel/private/secret'));
  assert(!serialized.includes('missing close brace'));
});

test('native source graph exposes sanitized graph search trace and diff impact over JS and TS source index', async () => {
  const root = await fixtureWorkspace();
  const graphSchema = await readJson('packages/protocol/schemas/source-graph.schema.json');
  const index = await buildJsTsSourceIndex({
    root,
    workspaceId: 'ws_ast',
    clock: () => fixedNow
  });
  const graph = buildSourceGraphFromIndex(index, { builtAt: fixedNow });
  const graphFromScanner = await buildJsTsSourceGraph({
    root,
    workspaceId: 'ws_ast',
    clock: () => fixedNow
  });

  assert.equal(validateJsonSchema(graphSchema, graph).valid, true);
  assert.equal(validateJsonSchema(graphSchema, graphFromScanner).valid, true);
  assert.match(graph.graphFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(graph.workspaceId, 'ws_ast');
  assert.equal(graph.summary.fileCount, 7);
  assert(graph.summary.symbolCount >= 7);
  assert(graph.summary.edgeKindCounts.calls >= 2);
  assert(graph.nodes.some((node) => node.kind === 'module' && node.label === 'zod'));
  assert(graph.edges.some((edge) => edge.kind === 'calls'));
  assert(graph.edges.some((edge) => edge.kind === 'imports' && edge.locator === 'workspace://src/constants.ts'));

  const search = searchSourceGraph(graph, { query: 'approve token reset workflow', limit: 10 });
  assert.equal(search.retrievalMethod, 'source_graph_lexical');
  assert(search.results.length <= 10);
  assert.equal(search.hasMore, search.total > search.results.length);
  assert(search.results.some((item) => item.resultType === 'node' && item.label === 'approveTokenReset'));
  assert(search.results.some((item) => item.resultType === 'edge' && item.kind === 'calls'));
  assert(search.results.every((item) => item.reasonCodes.includes('lexical_match')));

  const filtered = searchSourceGraph(graph, {
    query: 'service',
    nodeKinds: ['symbol'],
    edgeKinds: [],
    labelPattern: '.*Service$',
    locatorPrefix: 'workspace://src/auth.ts'
  });
  assert(filtered.results.some((item) => item.label === 'TokenResetService'));
  assert(filtered.results.every((item) => item.resultType === 'node' && item.kind === 'symbol'));
  assert(filtered.results.every((item) => item.locator.startsWith('workspace://src/auth.ts')));

  const trace = traceSourceGraph(graph, {
    startName: 'runAuthWorkflow',
    direction: 'outbound',
    edgeKinds: ['calls'],
    depth: 2
  });
  assert(trace.startNodeIds.length >= 1);
  assert(trace.paths.some((item) => item.terminalLabel === 'approveTokenReset'));
  assert(trace.paths.every((item) => item.depth <= 2));

  const impact = mapSourceGraphDiffImpact(graph, {
    changedLocators: ['workspace://src/auth.ts'],
    depth: 3
  });
  assert.deepEqual(impact.representedChangedLocators, ['workspace://src/auth.ts']);
  assert(impact.affectedSymbols.some((item) => item.name === 'approveTokenReset'));
  assert(impact.affectedSymbols.some((item) => item.name === 'runAuthWorkflow'));
  assert(impact.impactedEdgeIds.length >= 1);

  const serialized = JSON.stringify({ graph, search, filtered, trace, impact });
  assert(!serialized.includes('private implementation body'));
  assert(!serialized.includes(root));
  assert(!serialized.includes('/Users/'));
  assert(!serialized.includes('/Users/rebel/private/secret'));
  assert(!serialized.includes('missing close brace'));
});

test('source graph diff impact preserves CommonJS changed-file symbols under tight limits', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaf-cjs-impact-'));
  await mkdir(path.join(root, 'lib'), { recursive: true });
  await writeFile(path.join(root, 'lib', 'index.js'), [
    "function alpha() { return 'a'; }",
    "function bravo() { return alpha(); }",
    "function charlie() { return bravo(); }",
    'module.exports = bravo;'
  ].join('\n'));
  const index = await buildJsTsSourceIndex({
    root,
    workspaceId: 'ws_cjs',
    clock: () => fixedNow
  });
  const graph = buildSourceGraphFromIndex(index, { builtAt: fixedNow });
  const impact = mapSourceGraphDiffImpact(graph, {
    changedLocators: ['workspace://lib/index.js'],
    depth: 2,
    limit: 2
  });

  assert.deepEqual(impact.representedChangedLocators, ['workspace://lib/index.js']);
  assert(impact.affectedSymbols.some((item) => item.name === 'alpha'));
});

test('source index fingerprints are stable across collection timestamps', async () => {
  const root = await fixtureWorkspace();
  const first = await buildJsTsSourceIndex({
    root,
    workspaceId: 'ws_ast',
    clock: () => '2026-06-23T00:00:00.000Z'
  });
  const second = await buildJsTsSourceIndex({
    root,
    workspaceId: 'ws_ast',
    clock: () => '2026-06-24T00:00:00.000Z'
  });

  assert.notEqual(first.symbolIndex.indexedAt, second.symbolIndex.indexedAt);
  assert.equal(first.scanFingerprint, second.scanFingerprint);
  assert.equal(first.sourceIndexFingerprint, second.sourceIndexFingerprint);
  assert.equal(first.symbolIndex.symbolIndexFingerprint, second.symbolIndex.symbolIndexFingerprint);
  const firstChunks = new Map(first.fileOutlines.flatMap((file) => file.chunkIds.map((id) => [id, true])));
  assert.equal(firstChunks.size, second.fileOutlines.flatMap((file) => file.chunkIds).length);
  for (const chunk of (await scanAstCodeWorkspace({ root, workspaceId: 'ws_ast', clock: () => '2026-06-23T00:00:00.000Z' })).chunks) {
    const rerun = (await scanAstCodeWorkspace({ root, workspaceId: 'ws_ast', clock: () => '2026-06-24T00:00:00.000Z' })).chunks.find((item) => item.id === chunk.id);
    assert.equal(chunk.chunkFingerprint, rerun.chunkFingerprint);
  }
});
