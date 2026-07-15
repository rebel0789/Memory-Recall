import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateJsonSchema } from '../packages/protocol/src/schema-validator.mjs';
import { normalizeSourceGraphWorkspaceLocator } from '../packages/protocol/src/source-graph-locator.mjs';
import { buildSourceGraphPreview } from '../packages/source-graph/src/index.mjs';
import { searchSourceGraph } from '../providers/native/context-candidate-ast-code/src/index.mjs';

const fixedNow = '2026-06-23T00:00:00.000Z';

async function fixtureWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaf-source-graph-preview-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'auth.ts'), [
    'export class TokenResetService {',
    '  approveTokenReset(request: ResetRequest) {',
    "    return { ok: true, secret: 'RAW BODY SENTINEL' };",
    '  }',
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
  return root;
}

test('source graph accepts ordinary relative users and private directories', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recall-relative-users-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'apps', 'api', 'users', '[userRef]'), { recursive: true });
  await mkdir(path.join(root, 'src', 'private'), { recursive: true });
  await writeFile(path.join(root, 'apps', 'api', 'users', '[userRef]', 'route.ts'), 'export function GET(){ return "ok"; }\n');
  await writeFile(path.join(root, 'src', 'private', 'state.ts'), 'export const state = "local";\n');

  const preview = await buildSourceGraphPreview({ root, workspaceId: 'ws_local' });

  assert.equal(preview.graph.summary.fileCount, 2);
  assert.equal(preview.graph.diagnostics.some(({ code }) => code.startsWith('source_graph_unavailable')), false);
  assert(preview.graph.sampleNodes.some(({ locator }) => locator?.includes('/users/')));
  assert(preview.graph.sampleNodes.some(({ locator }) => locator?.includes('/private/')));
});

test('source graph still rejects absolute and encoded traversal locators', () => {
  for (const locator of [
    '/Users/rebel/project/src/app.js',
    'C:\\Users\\rebel\\project\\src\\app.js',
    'workspace:///Users/rebel/project/src/app.js',
    'workspace://src/%252e%252e/secret.js',
    'https://example.com/source.js'
  ]) {
    assert.throws(
      () => normalizeSourceGraphWorkspaceLocator(locator),
      /source_graph_workspace_locator_invalid/
    );
  }
});

test('source graph preview builds bounded read-only report without raw source bodies', async () => {
  const root = await fixtureWorkspace();
  const preview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'approve token reset workflow',
    startName: 'runAuthWorkflow',
    changedLocators: ['src/auth.ts'],
    limit: 10,
    sampleLimit: 3,
    clock: () => fixedNow
  });
  const schema = JSON.parse(await readFile('packages/protocol/schemas/source-graph-preview.schema.json', 'utf8'));
  assert.equal(validateJsonSchema(schema, preview).valid, true);
  assert.equal(preview.safeguards.persisted, false);
  assert.equal(preview.safeguards.modelCalls, 0);
  assert.equal(preview.safeguards.networkCalls, 0);
  assert.equal(preview.safeguards.externalAdaptersEnabled, 0);
  assert.equal(preview.safeguards.externalWritesEnabled, false);
  assert(preview.measurements.fullGraphTokenEstimate > 0);
  assert(preview.measurements.deliveredTokenEstimate > 0);
  assert(preview.measurements.omittedTokenEstimate >= 0);
  assert.equal(preview.measurements.sourceContentIncluded, false);
  assert.equal(preview.measurements.providerBillingClaimed, false);
  assert(preview.search.results.some((item) => item.label.includes('approveTokenReset')));
  assert(preview.trace.paths.some((item) => item.terminalLabel === 'approveTokenReset'));
  assert.deepEqual(preview.impact.representedChangedLocators, ['workspace://src/auth.ts']);
  assert(preview.impact.affectedSymbols.some((item) => item.name === 'approveTokenReset'));
  assert(preview.graph.sampleNodes.length <= 3);
  const serialized = JSON.stringify(preview);
  assert(!serialized.includes('RAW BODY SENTINEL'));
  assert(!serialized.includes(root));
  assert(!serialized.includes('/Users/'));
});

test('source graph preview fingerprints are deterministic for fixed input', async () => {
  const root = await fixtureWorkspace();
  const input = {
    root,
    workspaceId: 'ws_local',
    query: 'approve token reset workflow',
    changedLocators: ['workspace://src/auth.ts'],
    clock: () => fixedNow
  };
  const first = await buildSourceGraphPreview(input);
  const second = await buildSourceGraphPreview(input);
  assert.equal(first.graph.graphFingerprint, second.graph.graphFingerprint);
  assert.equal(first.search.queryFingerprint, second.search.queryFingerprint);
});

test('source graph preview omits missing locators from module search results', async () => {
  const root = await fixtureWorkspace();
  const preview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: './auth',
    limit: 10,
    clock: () => fixedNow
  });
  const schema = JSON.parse(await readFile('packages/protocol/schemas/source-graph-preview.schema.json', 'utf8'));
  assert.equal(validateJsonSchema(schema, preview).valid, true);
  assert(preview.search.results.some((item) => item.kind === 'module' && item.label === './auth' && !('locator' in item)));
});

test('source graph preview ranks actionable locator results before import specifier modules', async () => {
  const root = await fixtureWorkspace();
  const preview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: './auth',
    limit: 10,
    clock: () => fixedNow
  });

  assert(preview.search.results.some((item) => item.kind === 'module' && item.label === './auth' && !('locator' in item)));
  assert(preview.search.results[0].locator);
  assert.notEqual(preview.search.results[0].kind, 'module');
});

test('source graph preview sanitizes unsafe dynamic module specifiers before rendering', async () => {
  const root = await fixtureWorkspace();
  await writeFile(path.join(root, 'src', 'dynamic.ts'), [
    'export async function loadDynamicModule() {',
    '  return Promise.all([',
    "    import('file:/tmp/REVIEW_SECRET.ts'),",
    "    import('git:repo/REVIEW_SECRET.ts'),",
    "    import('data:text/plain'),",
    "    import('node:../REVIEW_SECRET.ts')",
    '  ]);',
    '}'
  ].join('\n'));
  const preview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'load dynamic module',
    sampleLimit: 50,
    clock: () => fixedNow
  });
  const schema = JSON.parse(await readFile('packages/protocol/schemas/source-graph-preview.schema.json', 'utf8'));
  const serialized = JSON.stringify(preview);

  assert.equal(validateJsonSchema(schema, preview).valid, true);
  assert.ok(preview.graph.sampleNodes.some((node) => node.kind === 'module' && node.label === 'local:absolute-import'));
  assert.ok(preview.graph.sampleNodes.some((node) => node.kind === 'module' && node.label === 'external-module'));
  assert.equal(serialized.includes('file:/tmp/REVIEW_SECRET.ts'), false);
  assert.equal(serialized.includes('git:repo/REVIEW_SECRET.ts'), false);
  assert.equal(serialized.includes('data:text/plain'), false);
  assert.equal(serialized.includes('node:../REVIEW_SECRET.ts'), false);
  assert.equal(serialized.includes('/tmp/'), false);
  assert.equal(serialized.includes('REVIEW_SECRET'), false);
});

test('source graph preview omits recursively percent-encoded traversal filesystem segments', async () => {
  const root = await fixtureWorkspace();
  for (const directory of ['%2e%2e', '%252e%252e', '%25252e%25252e', '%252f', '%255c']) {
    await mkdir(path.join(root, 'src', directory), { recursive: true });
    await writeFile(path.join(root, 'src', directory, 'REVIEW_SECRET.ts'), 'export const secret = true;\n');
  }
  const preview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'secret',
    sampleLimit: 50,
    clock: () => fixedNow
  });
  const schema = JSON.parse(await readFile('packages/protocol/schemas/source-graph-preview.schema.json', 'utf8'));
  const serialized = JSON.stringify(preview);

  assert.equal(validateJsonSchema(schema, preview).valid, true);
  assert.equal(preview.graph.summary.fileCount, 2);
  for (const encodedPath of ['%2e%2e', '%252e%252e', '%25252e%25252e', '%252f', '%255c']) assert.equal(serialized.includes(encodedPath), false);
  assert.equal(serialized.includes('REVIEW_SECRET'), false);
});

test('source graph preview reports when file caps make results partial', async () => {
  const root = await fixtureWorkspace();
  const preview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'run auth workflow',
    maxFiles: 1,
    clock: () => fixedNow
  });
  assert.equal(preview.graph.summary.fileCount, 1);
  assert.equal(preview.graph.diagnostics.some((item) => item.code === 'max_files_reached'), true);
  assert.equal(preview.graph.summary.coverage.status, 'partial');
  assert.equal(preview.graph.summary.coverage.maxFilesReached, true);
  assert(preview.graph.summary.coverage.reasonCodes.includes('max_files_reached'));
  assert.equal(preview.graph.summary.coverage.representedFileCount, 1);
  assert.equal(preview.search.results.some((item) => item.label.includes('runAuthWorkflow')), false);
  assert(!JSON.stringify(preview).includes(root));
});

test('source graph preview keeps readable files available when one source file is unreadable', async (t) => {
  const root = await fixtureWorkspace();
  const unreadable = path.join(root, 'src', 'unreadable.ts');
  await writeFile(unreadable, 'export function unreadableSource() { return true; }\n');
  await chmod(unreadable, 0o000);
  try {
    try {
      await readFile(unreadable, 'utf8');
      t.skip('filesystem user can read mode-000 fixture');
      return;
    } catch (error) {
      assert.equal(error?.code, 'EACCES');
    }
    const preview = await buildSourceGraphPreview({
      root,
      workspaceId: 'ws_local',
      query: 'approve token reset',
      clock: () => fixedNow
    });
    const schema = JSON.parse(await readFile('packages/protocol/schemas/source-graph-preview.schema.json', 'utf8'));
    const coverage = preview.graph.summary.coverage;

    assert.equal(validateJsonSchema(schema, preview).valid, true);
    assert.notEqual(preview.graph.parserVersion, 'oaf-js-ts-static-unavailable');
    assert.equal(preview.graph.summary.fileCount, 2);
    assert.equal(coverage.status, 'partial');
    assert.equal(coverage.skippedFileCount, 1);
    assert.deepEqual(coverage.skippedLocators, ['workspace://src/unreadable.ts']);
    assert.ok(coverage.reasonCodes.includes('file_unreadable'));
    assert.ok(preview.graph.diagnostics.some((item) => item.locator === 'workspace://src/unreadable.ts' && item.code === 'file_unreadable'));
    assert.ok(preview.search.results.some((item) => item.label === 'approveTokenReset'));
  } finally {
    await chmod(unreadable, 0o600);
  }
});

test('source graph preview keeps readable files available when a source directory is unreadable', async (t) => {
  const root = await fixtureWorkspace();
  const lockedDirectory = path.join(root, 'z-locked');
  await writeFile(path.join(root, 'a-good.ts'), 'export function readableDirectorySibling() { return true; }\n');
  await mkdir(lockedDirectory, { recursive: true });
  await writeFile(path.join(lockedDirectory, 'hidden.ts'), 'export function hiddenDirectorySecret() { return true; }\n');
  await chmod(lockedDirectory, 0o000);
  try {
    try {
      await readdir(lockedDirectory);
      t.skip('filesystem user can read mode-000 directory fixture');
      return;
    } catch (error) {
      assert.equal(error?.code, 'EACCES');
    }
    const preview = await buildSourceGraphPreview({
      root,
      workspaceId: 'ws_local',
      query: 'readable directory sibling',
      clock: () => fixedNow
    });
    const schema = JSON.parse(await readFile('packages/protocol/schemas/source-graph-preview.schema.json', 'utf8'));
    const coverage = preview.graph.summary.coverage;
    const serialized = JSON.stringify(preview);

    assert.equal(validateJsonSchema(schema, preview).valid, true);
    assert.notEqual(preview.graph.parserVersion, 'oaf-js-ts-static-unavailable');
    assert.equal(preview.graph.summary.fileCount, 3);
    assert.equal(coverage.status, 'partial');
    assert.equal(coverage.skippedFileCount, 0);
    assert.equal(coverage.sourceRelevantExcludedDirectoryCount, 0);
    assert.ok(coverage.reasonCodes.includes('directory_unreadable'));
    assert.ok(preview.graph.diagnostics.some((item) => item.locator === 'workspace://z-locked' && item.code === 'directory_unreadable'));
    assert.ok(preview.search.results.some((item) => item.label === 'readableDirectorySibling'));
    assert.equal(serialized.includes('hiddenDirectorySecret'), false);
    assert.equal(serialized.includes(root), false);
  } finally {
    await chmod(lockedDirectory, 0o700);
  }
});

test('source graph preview default covers normal repos beyond 200 JS files', async () => {
  const root = await fixtureWorkspace();
  await mkdir(path.join(root, 'generated'), { recursive: true });
  for (let index = 0; index < 250; index += 1) {
    await writeFile(path.join(root, 'generated', `module-${String(index).padStart(3, '0')}.js`), [
      `export function generatedRoute${index}() {`,
      `  return ${index};`,
      '}'
    ].join('\n'));
  }

  const preview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'generated route 249',
    clock: () => fixedNow
  });

  assert.equal(preview.graph.summary.fileCount, 252);
  assert.equal(preview.graph.diagnostics.some((item) => item.code === 'max_files_reached'), false);
  assert.equal(preview.graph.summary.coverage.status, 'complete');
  assert.equal(preview.graph.summary.coverage.representedFileCount, 252);
  assert(preview.search.results.some((item) => item.label === 'generatedRoute249'));
});

test('source graph preview default represents large JS files within the bounded preview ceiling', async () => {
  const root = await fixtureWorkspace();
  await mkdir(path.join(root, 'apps', 'web'), { recursive: true });
  const largeBody = [
    'export function renderLargeUiContextPack() {',
    `  return '${'large-source-graph-body-sentinel '.repeat(9000)}';`,
    '}'
  ].join('\n');
  assert(Buffer.byteLength(largeBody, 'utf8') > 256 * 1024);
  assert(Buffer.byteLength(largeBody, 'utf8') < 512 * 1024);
  await writeFile(path.join(root, 'apps', 'web', 'app.js'), largeBody);

  const preview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'large ui context pack',
    changedLocators: ['apps/web/app.js'],
    sampleLimit: 1,
    clock: () => fixedNow
  });
  const schema = JSON.parse(await readFile('packages/protocol/schemas/source-graph-preview.schema.json', 'utf8'));
  assert.equal(validateJsonSchema(schema, preview).valid, true);
  assert.deepEqual(preview.graph.diagnostics.filter((item) => item.locator === 'workspace://apps/web/app.js'), []);
  assert.deepEqual(preview.impact.representedChangedLocators, ['workspace://apps/web/app.js']);
  assert(preview.impact.affectedSymbols.some((item) => item.name === 'renderLargeUiContextPack'));
  assert(preview.search.results.some((item) => item.label === 'renderLargeUiContextPack'));
  assert.equal(preview.safeguards.externalAdaptersEnabled, 0);
  assert.equal(preview.safeguards.externalWritesEnabled, false);
  assert.equal(preview.safeguards.rawBodyIncluded, false);
  assert.equal(preview.safeguards.sourceSlicesRead, false);

  const serialized = JSON.stringify(preview);
  assert(!serialized.includes('large-source-graph-body-sentinel'));
  assert(!serialized.includes(root));
  assert(!serialized.includes('/Users/'));

  const capped = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'large ui context pack',
    changedLocators: ['apps/web/app.js'],
    maxFileBytes: 128 * 1024,
    clock: () => fixedNow
  });
  assert(capped.graph.diagnostics.some((item) => item.locator === 'workspace://apps/web/app.js' && item.code === 'file_too_large'));
  assert.equal(capped.graph.summary.coverage.status, 'partial');
  assert(capped.graph.summary.coverage.oversizedLocators.includes('workspace://apps/web/app.js'));
  assert(capped.graph.summary.coverage.reasonCodes.includes('file_too_large'));
  assert.deepEqual(capped.impact.representedChangedLocators, []);
});

test('source graph preview rejects unsafe changed locators', async () => {
  const root = await fixtureWorkspace();
  await assert.rejects(
    () => buildSourceGraphPreview({ root, workspaceId: 'ws_local', query: 'token', changedLocators: ['workspace://../secret.ts'], clock: () => fixedNow }),
    /source_graph_preview_locator_invalid/
  );
  await assert.rejects(
    () => buildSourceGraphPreview({ root, workspaceId: 'ws_local', query: 'token', locatorPrefix: '/Users/rebel/project', clock: () => fixedNow }),
    /source_graph_preview_locator_invalid/
  );
});

test('source graph preview rejects protocol-invalid locators before emitting a report', async () => {
  const root = await fixtureWorkspace();
  for (const input of [
    { changedLocators: ['src/auth.ts?token=FACADE_LOCATOR_SECRET'] },
    { changedLocators: ['workspace://src/auth.ts#invalid-fragment'] },
    { changedLocators: ['workspace:///Users/rebel/private.ts'] },
    { changedLocators: ['src/%2e%2e/secret.ts'] },
    { changedLocators: ['workspace://src/..%2fsecret.ts'] },
    { changedLocators: ['workspace://src/%252e%252e/REVIEW_SECRET.ts'] },
    { changedLocators: ['workspace://src/%252fREVIEW_SECRET.ts'] },
    { changedLocators: ['workspace://src/%255cREVIEW_SECRET.ts'] },
    { changedLocators: ['file:///tmp/REVIEW_SECRET.ts'] },
    { changedLocators: ['file:/etc/passwd'] },
    { changedLocators: ['data:text/plain'] },
    { changedLocators: ['git:repo/path'] },
    { changedLocators: ['workspace://file:/etc/passwd'] },
    { changedLocators: ['workspace://data:text/plain'] },
    { changedLocators: ['workspace://git:repo/path'] },
    { changedLocators: ['workspace://src/file:/etc/passwd'] },
    { changedLocators: ['workspace://src/%66ile%3A/etc/passwd'] },
    { locatorPrefix: 'workspace:///private/secret.ts' },
    { locatorPrefix: 'workspace://src/auth.ts?token=FACADE_LOCATOR_SECRET' },
    { locatorPrefix: 'workspace://src/auth.ts#invalid-fragment' },
    { locatorPrefix: 'workspace://src/%2E%2E/secret.ts' },
    { locatorPrefix: 'workspace://src/%252e%252e/REVIEW_SECRET.ts' },
    { locatorPrefix: 'workspace://src/%252fREVIEW_SECRET.ts' },
    { locatorPrefix: 'workspace://src/%255cREVIEW_SECRET.ts' },
    { locatorPrefix: 'file:/etc/passwd' },
    { locatorPrefix: 'workspace://file:/etc/passwd' },
    { locatorPrefix: 'workspace://src/file:/etc/passwd' },
    { locatorPrefix: 'workspace://src/%66ile%3A/etc/passwd' }
  ]) {
    await assert.rejects(
      () => buildSourceGraphPreview({ root, workspaceId: 'ws_local', query: 'token', clock: () => fixedNow, ...input }),
      /source_graph_preview_locator_invalid/
    );
  }

  const preview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    changedLocators: ['src/auth.ts#L1-L3'],
    locatorPrefix: 'workspace://src/auth.ts#L1-L3',
    clock: () => fixedNow
  });
  const schema = JSON.parse(await readFile('packages/protocol/schemas/source-graph-preview.schema.json', 'utf8'));
  assert.equal(validateJsonSchema(schema, preview).valid, true);
  assert.deepEqual(preview.impact.changedLocators, ['workspace://src/auth.ts']);

  const dynamicRoutePreview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    changedLocators: ['app/api/items/[itemId]/route.ts#L1-L3'],
    locatorPrefix: 'workspace://app/api/items/[itemId]/route.ts#L1-L3',
    clock: () => fixedNow
  });
  assert.deepEqual(dynamicRoutePreview.impact.changedLocators, ['workspace://app/api/items/[itemId]/route.ts']);
});

test('source graph preview rejects oversized changed locator sets', async () => {
  const root = await fixtureWorkspace();
  await assert.rejects(
    () => buildSourceGraphPreview({
      root,
      workspaceId: 'ws_local',
      query: 'token',
      changedLocators: Array.from({ length: 17 }, (_, index) => `workspace://src/file-${index}.ts`),
      clock: () => fixedNow
    }),
    /changed_context_too_many_locators/
  );
});

test('source graph preview does not represent missing changed locators', async () => {
  const root = await fixtureWorkspace();
  const preview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'invented locator',
    changedLocators: ['workspace://src/invented.ts'],
    clock: () => fixedNow
  });

  assert.deepEqual(preview.impact.changedLocators, ['workspace://src/invented.ts']);
  assert.deepEqual(preview.impact.representedChangedLocators, []);
  assert.deepEqual(preview.impact.affectedSymbols, []);
  const serialized = JSON.stringify(preview);
  assert(!serialized.includes('RAW BODY SENTINEL'));
  assert(!serialized.includes(root));
  assert(!serialized.includes('/Users/'));
});

test('source graph preview names CommonJS and object-style route symbols in impact output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaf-source-graph-cjs-routes-'));
  await mkdir(path.join(root, 'lib'), { recursive: true });
  await writeFile(path.join(root, 'lib', 'routes.js'), [
    'const hooks = {',
    '  onRoute: function onRouteHook(route) { return registerRoute(route); },',
    '  routePatched(route) { return this.onRoute(route); },',
    '  patchTheRoute: async (route) => route',
    '};',
    'const groups = {',
    '  users: {',
    '    list(req) { return hooks.onRoute(req); }',
    '  }',
    '};',
    '',
    'module.exports.configureRoutes = function configureRoutes(app) {',
    '  return groups.users.list(app);',
    '};',
    '',
    'exports.addRoute = (fastify) => configureRoutes(fastify);',
    '',
    'function registerRoute(route) {',
    '  return route;',
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'lib', 'direct-cjs.js'), [
    'module.exports = {',
    '  configureObject(app) { return app; },',
    '  runObject: (app) => app',
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'lib', 'default-config.js'), [
    'export default {',
    '  rewrites() { return []; }',
    '}'
  ].join('\n'));

  const preview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'route hooks configure',
    changedLocators: ['lib/routes.js', 'lib/direct-cjs.js', 'lib/default-config.js'],
    clock: () => fixedNow
  });
  const names = new Set(preview.impact.affectedSymbols.map((item) => item.name));
  const qualifiedNames = new Set(preview.impact.affectedSymbols.map((item) => item.qualifiedName).filter(Boolean));

  assert.deepEqual(preview.impact.representedChangedLocators, ['workspace://lib/default-config.js', 'workspace://lib/direct-cjs.js', 'workspace://lib/routes.js']);
  assert(names.has('onRoute'));
  assert(names.has('routePatched'));
  assert(names.has('patchTheRoute'));
  assert(names.has('list'));
  assert(names.has('configureObject'));
  assert(names.has('runObject'));
  assert(names.has('rewrites'));
  assert(names.has('configureRoutes'));
  assert(names.has('addRoute'));
  assert(names.has('registerRoute'));
  assert.equal([...names].includes('undefined'), false);
  assert.equal([...names].includes('hooks'), false);
  assert(qualifiedNames.has('hooks.onRoute'));
  assert(qualifiedNames.has('hooks.routePatched'));
  assert(qualifiedNames.has('hooks.patchTheRoute'));
  assert(qualifiedNames.has('groups.users.list'));
  assert(qualifiedNames.has('module.exports.configureObject'));
  assert(qualifiedNames.has('module.exports.runObject'));
  assert(qualifiedNames.has('default-default-config.rewrites'));
  assert(!JSON.stringify(preview).includes(root));
});

test('source graph preview does not promote ordinary local constants as function symbols', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaf-source-graph-local-const-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'memory.ts'), [
    'export async function collectDocMemoryFacts(root, relativePath) {',
    '  const absolute = path.resolve(root, relativePath);',
    '  const info = await stat(absolute).catch(() => null);',
    '  if (!info) return [];',
    '  const facts = [relativePath];',
    '  const activeFacts = facts.filter((fact) => Boolean(fact));',
    '  return activeFacts.map((fact) => ({ fact, absolute }));',
    '}'
  ].join('\n'));

  const preview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'collect doc memory facts',
    changedLocators: ['src/memory.ts'],
    clock: () => fixedNow
  });

  const affectedNames = preview.impact.affectedSymbols.map((item) => item.name);
  assert(affectedNames.includes('collectDocMemoryFacts'));
  assert.equal(affectedNames.includes('absolute'), false);
  assert.equal(affectedNames.includes('activeFacts'), false);
  assert.equal(preview.graph.summary.entryPoints.some((item) => item.label === 'absolute'), false);
  assert.equal(preview.graph.summary.entryPoints.some((item) => item.label === 'activeFacts'), false);
  assert(!JSON.stringify(preview).includes(root));
});

test('source graph preview bounds type locators across comments and no-semicolon aliases', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaf-source-graph-type-boundaries-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'hono-base.ts'), [
    "type GetPath<E> = (request: Request, options?: { env?: E }) => string",
    '',
    'export type HonoOptions<E> = {',
    '  /**',
    '   * @see {@link https://example.test/hono#strict-mode}',
    '   * ```ts',
    '   * const app = new Hono({',
    "   *   getPath: (req) => '/' + req.url,",
    '   * })',
    '   * ```',
    '   */',
    '  getPath?: GetPath<E>',
    '}',
    '',
    'type MountOptions =',
    '  | MountOptionHandler',
    '  | {',
    '      optionHandler?: MountOptionHandler',
    '    }',
    '',
    'export class Hono {',
    '  get!: HandlerInterface',
    '}'
  ].join('\n'));

  const preview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'HonoOptions GetPath MountOptions Hono',
    changedLocators: ['src/hono-base.ts'],
    limit: 20,
    clock: () => fixedNow
  });
  const symbols = new Map(preview.search.results.filter((item) => item.kind === 'symbol').map((item) => [item.label, item]));

  assert.equal(symbols.get('GetPath')?.locator, 'workspace://src/hono-base.ts#L1-L1');
  assert.equal(symbols.get('HonoOptions')?.locator, 'workspace://src/hono-base.ts#L3-L13');
  assert.equal(symbols.get('MountOptions')?.locator, 'workspace://src/hono-base.ts#L15-L19');
  assert.equal(symbols.get('Hono')?.locator, 'workspace://src/hono-base.ts#L21-L23');
  assert(!JSON.stringify(preview).includes(root));
});

test('source graph preview impact ranks top-level surfaces before nested handlers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaf-source-graph-impact-rank-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'cli.ts'), [
    'export function graphImpactCommand(values) {',
    '  const tools = {',
    '    handler() {',
    '      return buildGraphImpactReport(values);',
    '    }',
    '  };',
    '  return tools.handler();',
    '}',
    '',
    'function buildGraphImpactReport(values) {',
    '  return values;',
    '}'
  ].join('\n'));

  const preview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'graph impact command',
    changedLocators: ['src/cli.ts'],
    clock: () => fixedNow
  });

  const labels = preview.impact.affectedSymbols.map((item) => item.qualifiedName ?? item.name);
  assert(labels.includes('graphImpactCommand'));
  assert(labels.includes('graphImpactCommand.tools.handler'));
  assert(labels.indexOf('graphImpactCommand') < labels.indexOf('graphImpactCommand.tools.handler'), labels.join(', '));
  assert(!JSON.stringify(preview).includes(root));
});

test('source graph preview impact records edges when changed symbols fill the node limit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaf-source-graph-impact-edges-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'changed.ts'), [
    ...Array.from({ length: 8 }, (_, index) => [
      `export function changedSurface${index}() {`,
      `  return ${index};`,
      '}'
    ].join('\n'))
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'caller.ts'), [
    "import { changedSurface0 } from './changed';",
    '',
    'export function callChangedSurface() {',
    '  return changedSurface0();',
    '}'
  ].join('\n'));

  const preview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'changed surface impact',
    changedLocators: ['src/changed.ts'],
    limit: 5,
    clock: () => fixedNow
  });

  assert(preview.impact.impactedEdgeIds.length > 0);
  assert(preview.impact.impactedEdgeKindCounts.calls > 0);
  assert(!JSON.stringify(preview).includes(root));
});

test('source graph preview impact ranks central classes before exported helper functions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaf-source-graph-impact-central-class-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'hono.ts'), [
    'export function errorHandler(error) {',
    '  return error;',
    '}',
    '',
    'class Hono {',
    '  route() {',
    '    return true;',
    '  }',
    '}',
    '',
    ...Array.from({ length: 48 }, (_, index) => [
      `function makeApp${index}() {`,
      '  return new Hono().route();',
      '}'
    ].join('\n'))
  ].join('\n'));

  const preview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'hono error handler impact',
    changedLocators: ['src/hono.ts'],
    clock: () => fixedNow
  });

  const labels = preview.impact.affectedSymbols.map((item) => item.qualifiedName ?? item.name);
  assert(labels.includes('Hono'));
  assert(labels.includes('errorHandler'));
  assert(labels.indexOf('Hono') < labels.indexOf('errorHandler'), labels.join(', '));
  assert(!JSON.stringify(preview).includes(root));
});

test('source graph preview impact ranks changed source symbols before test callers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaf-source-graph-impact-source-first-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'hono.ts'), [
    'export class Hono {',
    '  constructor() {}',
    '  getPath() {',
    "    return '/';",
    '  }',
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'hono.test.ts'), [
    "import { Hono } from './hono';",
    '',
    'class ExtendedHono extends Hono {}',
    '',
    'function createTestApp() {',
    '  return new ExtendedHono().getPath();',
    '}'
  ].join('\n'));

  const preview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'hono app impact',
    changedLocators: ['src/hono.ts'],
    clock: () => fixedNow
  });

  const labels = preview.impact.affectedSymbols.map((item) => item.qualifiedName ?? item.name);
  assert(labels.includes('Hono'));
  assert(labels.includes('Hono.constructor'));
  assert(labels.includes('ExtendedHono'));
  assert(labels.indexOf('Hono.constructor') < labels.indexOf('ExtendedHono'), labels.join(', '));
  assert(!JSON.stringify(preview).includes(root));
});

test('source graph preview trace ranks source callers before test callers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaf-source-graph-trace-source-first-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'hono.ts'), [
    'export function send(reply) {',
    '  return reply;',
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'route.ts'), [
    "import { send } from './hono';",
    '',
    'export function routeHandler(reply) {',
    '  return send(reply);',
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'hono.test.ts'), [
    "import { send } from './hono';",
    '',
    'export function testCaller(reply) {',
    '  return send(reply);',
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'send.test.ts'), [
    'export function send(reply) {',
    '  return reply;',
    '}'
  ].join('\n'));

  const preview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'send inbound callers',
    startName: 'send',
    direction: 'inbound',
    edgeKinds: ['calls'],
    limit: 10,
    clock: () => fixedNow
  });

  const callers = preview.trace.paths.filter((item) => item.depth === 1).map((item) => item.terminalLocator);
  const starts = preview.trace.paths.filter((item) => item.depth === 0).map((item) => item.terminalLocator);
  assert.deepEqual(starts, ['workspace://src/hono.ts#L1-L3']);
  assert.equal(callers[0], 'workspace://src/route.ts#L3-L5', callers.join(', '));
  assert(callers.indexOf('workspace://src/route.ts#L3-L5') < callers.indexOf('workspace://src/hono.test.ts#L3-L5'), callers.join(', '));
  assert(!JSON.stringify(preview).includes(root));
});

test('source graph preview trace ranks core start symbols before preset wrappers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaf-source-graph-trace-start-rank-'));
  await mkdir(path.join(root, 'src', 'preset'), { recursive: true });
  await writeFile(path.join(root, 'src', 'hono-base.ts'), [
    'export class Hono {',
    '  request() { return true; }',
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'hono.ts'), [
    'export class Hono {',
    '  fetch() { return true; }',
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'preset', 'quick.ts'), [
    'export class Hono {',
    '  preset() { return true; }',
    '}'
  ].join('\n'));

  const preview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'hono start',
    startName: 'Hono',
    direction: 'inbound',
    edgeKinds: ['exports'],
    limit: 10,
    clock: () => fixedNow
  });

  const starts = preview.trace.paths.filter((item) => item.depth === 0).map((item) => item.terminalLocator);
  assert.equal(starts[0], 'workspace://src/hono-base.ts#L1-L3', starts.join(', '));
  assert(starts.indexOf('workspace://src/hono.ts#L1-L3') < starts.indexOf('workspace://src/preset/quick.ts#L1-L3'), starts.join(', '));
  assert(!JSON.stringify(preview).includes(root));
});

test('source graph preview trace reports relationship kinds per path', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaf-source-graph-trace-edge-kinds-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'auth.ts'), [
    'export function approveTokenReset() {',
    '  return true;',
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'workflow.ts'), [
    "import { approveTokenReset } from './auth';",
    '',
    'export function runAuthWorkflow() {',
    '  return approveTokenReset();',
    '}'
  ].join('\n'));

  const preview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'auth workflow call trace',
    startName: 'runAuthWorkflow',
    edgeKinds: ['calls'],
    limit: 10,
    clock: () => fixedNow
  });

  const calleePath = preview.trace.paths.find((item) => item.terminalLabel === 'approveTokenReset');
  assert.deepEqual(calleePath?.edgeKinds, ['calls']);
  assert.deepEqual(calleePath?.edgeLocators, ['workspace://src/workflow.ts#L3-L5']);
  assert(!JSON.stringify(preview).includes(root));
});

test('source graph preview traces JSX component usage', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaf-source-graph-jsx-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'button.tsx'), [
    'export function Button() {',
    '  return null;',
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'app.tsx'), [
    "import React, { createElement } from 'react';",
    "import { Button } from './button';",
    "import * as UI from './button';",
    '',
    'export function App() {',
    '  return <Button />;',
    '}',
    '',
    'export function NamespacedApp() {',
    '  return <UI.Button />;',
    '}',
    '',
    'export function CreatedApp() {',
    '  return React.createElement(Button);',
    '}',
    '',
    'export function BareCreatedApp() {',
    '  return createElement(Button);',
    '}',
    '',
    'export function NamespacedCreatedApp() {',
    '  return React.createElement(UI.Button);',
    '}'
  ].join('\n'));

  const directTrace = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'app button jsx',
    startName: 'App',
    limit: 10,
    clock: () => fixedNow
  });
  const namespaceTrace = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'namespaced app button jsx',
    startName: 'NamespacedApp',
    limit: 10,
    clock: () => fixedNow
  });
  const createdTrace = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'created app button',
    startName: 'CreatedApp',
    limit: 10,
    clock: () => fixedNow
  });
  const bareCreatedTrace = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'bare created app button',
    startName: 'BareCreatedApp',
    limit: 10,
    clock: () => fixedNow
  });
  const namespacedCreatedTrace = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'namespaced created app button',
    startName: 'NamespacedCreatedApp',
    limit: 10,
    clock: () => fixedNow
  });

  assert(directTrace.trace.paths.some((item) => item.terminalLabel === 'Button' && item.terminalLocator === 'workspace://src/button.tsx#L1-L3'));
  assert(namespaceTrace.trace.paths.some((item) => item.terminalLabel === 'Button' && item.terminalLocator === 'workspace://src/button.tsx#L1-L3'));
  assert(createdTrace.trace.paths.some((item) => item.terminalLabel === 'Button' && item.terminalLocator === 'workspace://src/button.tsx#L1-L3'));
  assert(bareCreatedTrace.trace.paths.some((item) => item.terminalLabel === 'Button' && item.terminalLocator === 'workspace://src/button.tsx#L1-L3'));
  assert(namespacedCreatedTrace.trace.paths.some((item) => item.terminalLabel === 'Button' && item.terminalLocator === 'workspace://src/button.tsx#L1-L3'));
  assert(!JSON.stringify(directTrace).includes(root));
});

test('source graph preview traces callback handler references', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaf-source-graph-callbacks-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'handlers.ts'), [
    'export function getUser(req, res) {',
    '  return res;',
    '}',
    '',
    'export function renderUser(user) {',
    '  return user.name;',
    '}',
    '',
    'export function handleUser(user) {',
    '  return user.id;',
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'shadow.ts'), [
    'export function getUser() {',
    "  return 'shadow';",
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'routes.ts'), [
    "import { getUser, handleUser, renderUser } from './handlers';",
    "import * as handlers from './handlers';",
    '',
    'export function configureRoutes(router) {',
    "  router.get('/users', getUser);",
    '}',
    '',
    'export function configureNamespaceRoutes(router) {',
    "  router.get('/users', handlers.getUser);",
    '}',
    '',
    'export function renderUsers(users) {',
    '  return users.map(renderUser);',
    '}',
    '',
    'export function loadUser(fetchUser) {',
    '  return fetchUser().then(handleUser);',
    '}',
    '',
    'export function renderNamespaceUsers(users) {',
    '  return users.map(handlers.renderUser);',
    '}',
    '',
    'export function configureAliasedNamespaceRoutes(router) {',
    '  const { getUser: loadUser } = handlers;',
    "  return router.get('/users', loadUser);",
    '}'
  ].join('\n'));

  const namedTrace = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'configure route get user handler',
    startName: 'configureRoutes',
    limit: 10,
    clock: () => fixedNow
  });
  const namespaceTrace = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'configure namespace route get user handler',
    startName: 'configureNamespaceRoutes',
    limit: 10,
    clock: () => fixedNow
  });
  const mapTrace = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'render users map callback',
    startName: 'renderUsers',
    limit: 10,
    clock: () => fixedNow
  });
  const promiseTrace = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'load user promise callback',
    startName: 'loadUser',
    limit: 10,
    clock: () => fixedNow
  });
  const namespaceMapTrace = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'render namespace users map callback',
    startName: 'renderNamespaceUsers',
    limit: 10,
    clock: () => fixedNow
  });
  const aliasedNamespaceTrace = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'configure aliased namespace route handler',
    startName: 'configureAliasedNamespaceRoutes',
    limit: 10,
    clock: () => fixedNow
  });

  assert(namedTrace.trace.paths.some((item) => item.terminalLabel === 'getUser' && item.terminalLocator === 'workspace://src/handlers.ts#L1-L3'));
  assert(namespaceTrace.trace.paths.some((item) => item.terminalLabel === 'getUser' && item.terminalLocator === 'workspace://src/handlers.ts#L1-L3'));
  assert(mapTrace.trace.paths.some((item) => item.terminalLabel === 'renderUser' && item.terminalLocator === 'workspace://src/handlers.ts#L5-L7'));
  assert(promiseTrace.trace.paths.some((item) => item.terminalLabel === 'handleUser' && item.terminalLocator === 'workspace://src/handlers.ts#L9-L11'));
  assert(namespaceMapTrace.trace.paths.some((item) => item.terminalLabel === 'renderUser' && item.terminalLocator === 'workspace://src/handlers.ts#L5-L7'));
  assert(aliasedNamespaceTrace.trace.paths.some((item) => item.terminalLabel === 'getUser' && item.terminalLocator === 'workspace://src/handlers.ts#L1-L3'));
  assert.equal(namedTrace.trace.paths.some((item) => item.terminalLocator === 'workspace://src/shadow.ts#L1-L3'), false);
  assert.equal(namespaceTrace.trace.paths.some((item) => item.terminalLocator === 'workspace://src/shadow.ts#L1-L3'), false);
  assert(!JSON.stringify(namedTrace).includes(root));
});

test('source graph preview resolves barrel re-exports to real symbols', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaf-source-graph-barrel-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'server.ts'), [
    'export function createServer() {',
    '  return { ready: true };',
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'routes.ts'), [
    'export function buildRoute() {',
    "  return 'route';",
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'route-copy.ts'), [
    'export function buildRoute() {',
    "  return 'copy';",
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'page.tsx'), [
    'export default function () {',
    "  return 'page';",
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'consumer.ts'), [
    "import Page from './page';",
    '',
    'export function renderPage() {',
    '  return Page();',
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'barrel-consumer.ts'), [
    "import { Page as View } from './index';",
    '',
    'export function renderBarrelPage() {',
    '  return View();',
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'namespace-consumer.ts'), [
    "import * as UI from './index';",
    '',
    'export function renderNamespacePage() {',
    '  return UI.Page();',
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'export-namespace-consumer.ts'), [
    "import { Routes as RouteNS } from './index';",
    '',
    'export function renderNamespaceRoute() {',
    '  return RouteNS.buildRoute();',
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'named-page.tsx'), [
    'function Page() {',
    "  return 'page';",
    '}',
    '',
    'export default Page;'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'named-consumer.ts'), [
    "import View from './named-page';",
    '',
    'export function renderNamedPage() {',
    '  return View();',
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'provider.ts'), [
    'export default class {',
    '  ready() { return true; }',
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'api.ts'), [
    'export default async () => {',
    "  return 'api';",
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'handler.ts'), [
    'const handler = () => {',
    "  return 'handler';",
    '};',
    '',
    'export default handler;'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'function-expr.ts'), [
    'export const FunctionCard = function FunctionCard(props) {',
    "  return 'card';",
    '};'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'components.tsx'), [
    "import { forwardRef, memo } from 'react';",
    '',
    'export const MemoButton = memo(function MemoButton(props) {',
    "  return 'button';",
    '});',
    '',
    'export const InputBox = forwardRef(function InputBox(props, ref) {',
    "  return 'input';",
    '});',
    '',
    'export default memo(function DefaultWidget() {',
    "  return 'widget';",
    '});'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'badge.tsx'), [
    "import { memo } from 'react';",
    '',
    'export default memo(() => {',
    "  return 'badge';",
    '});'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'lazy.ts'), [
    'export async function loadRoute() {',
    "  return import('./routes');",
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'local-alias.ts'), [
    'function helper() {',
    "  return 'helper';",
    '}',
    '',
    'class Hono {',
    '  request() { return true; }',
    '}',
    '',
    'export { Hono as HonoBase };',
    '',
    'export type HonoOptions = { strict: boolean };'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'index.ts'), [
    "export { createServer } from './server';",
    "export { default as Page } from './page';",
    "export * as Routes from './routes';",
    "export * from './routes';",
    ''
  ].join('\n'));

  const preview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'create server export',
    edgeKinds: ['exports'],
    limit: 20,
    clock: () => fixedNow
  });

  assert(preview.search.results.some((item) => item.kind === 'exports' && item.locator === 'workspace://src/index.ts'));
  assert(preview.search.results.some((item) => item.label.includes('buildRoute')));
  assert(preview.search.results.some((item) => item.label.includes('default-page')));

  const defaultReExportPreview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'Page export',
    edgeKinds: ['exports'],
    limit: 20,
    clock: () => fixedNow
  });

  assert(defaultReExportPreview.search.results.some((item) => item.kind === 'exports' && item.locator === 'workspace://src/index.ts' && item.label.includes('Page') && item.label.includes('default-page')));
  const namespaceReExportPreview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'Routes export',
    edgeKinds: ['exports'],
    limit: 20,
    clock: () => fixedNow
  });

  assert(namespaceReExportPreview.search.results.some((item) => item.kind === 'exports' && item.locator === 'workspace://src/index.ts' && item.label.includes('Routes')));
  const localAliasExportPreview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'HonoBase export',
    edgeKinds: ['exports'],
    limit: 20,
    clock: () => fixedNow
  });

  assert(localAliasExportPreview.search.results.some((item) => (
    item.kind === 'exports' &&
    item.locator === 'workspace://src/local-alias.ts' &&
    item.exportName === 'HonoBase' &&
    item.toLabel === 'Hono' &&
    item.toSymbolKind === 'class' &&
    item.toLocator === 'workspace://src/local-alias.ts#L5-L7'
  )));
  assert(!localAliasExportPreview.search.results.some((item) => item.kind === 'exports' && item.locator === 'workspace://src/local-alias.ts' && item.label.includes('helper')));
  const localAliasTrace = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'HonoBase export alias',
    startName: 'HonoBase',
    edgeKinds: ['exports'],
    limit: 20,
    clock: () => fixedNow
  });

  assert(localAliasTrace.trace.startNodeIds.length > 0);
  assert(localAliasTrace.trace.paths.some((item) => item.depth === 0 && item.terminalLabel === 'Hono' && item.terminalLocator === 'workspace://src/local-alias.ts#L5-L7'));
  const directTypeExportPreview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'HonoOptions export',
    edgeKinds: ['exports'],
    limit: 20,
    clock: () => fixedNow
  });
  assert.equal(directTypeExportPreview.search.results.filter((item) => item.kind === 'exports' && item.exportName === 'HonoOptions' && item.toLabel === 'HonoOptions').length, 1);
  const defaultImportTrace = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'render page default import',
    startName: 'renderPage',
    limit: 20,
    clock: () => fixedNow
  });

  assert(defaultImportTrace.trace.paths.some((item) => item.terminalLabel === 'default-page' && item.terminalLocator === 'workspace://src/page.tsx#L1-L3'));
  const barrelImportTrace = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'render barrel page named import alias',
    startName: 'renderBarrelPage',
    limit: 20,
    clock: () => fixedNow
  });

  assert(barrelImportTrace.trace.paths.some((item) => item.terminalLabel === 'default-page' && item.terminalLocator === 'workspace://src/page.tsx#L1-L3'));
  const namespaceImportTrace = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'render namespace page barrel import',
    startName: 'renderNamespacePage',
    limit: 20,
    clock: () => fixedNow
  });

  assert(namespaceImportTrace.trace.paths.some((item) => item.terminalLabel === 'default-page' && item.terminalLocator === 'workspace://src/page.tsx#L1-L3'));
  const exportNamespaceTrace = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'render namespace route barrel import',
    startName: 'renderNamespaceRoute',
    limit: 20,
    clock: () => fixedNow
  });

  assert(exportNamespaceTrace.trace.paths.some((item) => item.terminalLabel === 'buildRoute' && item.terminalLocator === 'workspace://src/routes.ts#L1-L3'));
  assert.equal(exportNamespaceTrace.trace.paths.some((item) => item.terminalLocator === 'workspace://src/route-copy.ts#L1-L3'), false);
  const aliasedDefaultImportTrace = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'render named page default import alias',
    startName: 'renderNamedPage',
    limit: 20,
    clock: () => fixedNow
  });

  assert(aliasedDefaultImportTrace.trace.paths.some((item) => item.terminalLabel === 'Page' && item.terminalLocator === 'workspace://src/named-page.tsx#L1-L3'));
  assert(preview.search.results.some((item) => item.label.includes('default-provider')));
  assert(preview.search.results.some((item) => item.label.includes('default-api')));
  assert(preview.search.results.some((item) => item.label.includes('handler')));

  const componentPreview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'MemoButton InputBox DefaultWidget default-badge FunctionCard',
    nodeKinds: ['symbol'],
    limit: 20,
    clock: () => fixedNow
  });

  assert(componentPreview.search.results.some((item) => item.label === 'MemoButton'));
  assert(componentPreview.search.results.some((item) => item.label === 'InputBox'));
  assert(componentPreview.search.results.some((item) => item.label === 'DefaultWidget'));
  assert(componentPreview.search.results.some((item) => item.label === 'default-badge'));
  assert(componentPreview.search.results.some((item) => item.label === 'FunctionCard'));

  const importPreview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'lazy routes import',
    edgeKinds: ['imports'],
    limit: 10,
    clock: () => fixedNow
  });

  assert(importPreview.search.results.some((item) => item.kind === 'imports' && item.locator === 'workspace://src/routes.ts'));
  assert(!JSON.stringify(preview).includes(root));
  assert(!JSON.stringify(defaultReExportPreview).includes(root));
  assert(!JSON.stringify(componentPreview).includes(root));
  assert(!JSON.stringify(importPreview).includes(root));
});

test('source graph preview ranks source files before test files for generic code searches', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaf-source-graph-ranking-'));
  await mkdir(path.join(root, 'lib'), { recursive: true });
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await mkdir(path.join(root, 'test'), { recursive: true });
  await mkdir(path.join(root, 'types'), { recursive: true });
  const body = [
    'export function registerRoute(app) {',
    '  return routeHelper(app);',
    '}',
    '',
    'function routeHelper(app) {',
    '  return app.route;',
    '}'
  ].join('\n');
  await writeFile(path.join(root, 'lib', 'route.js'), body);
  await writeFile(path.join(root, 'scripts', 'route.js'), body);
  await writeFile(path.join(root, 'test', 'route.test.js'), body);
  await writeFile(path.join(root, 'lib', 'types.ts'), [
    'export interface RouteContract {',
    '  registerRoute(app: App): void;',
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'types', 'route.d.ts'), [
    'export interface RegisterRoute {',
    '  app: App;',
    '}'
  ].join('\n'));

  const preview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'register route',
    limit: 20,
    clock: () => fixedNow
  });
  const matchingSymbols = preview.search.results.filter((item) => item.kind === 'symbol' && item.label === 'registerRoute');

  assert.equal(matchingSymbols[0].locator, 'workspace://lib/route.js#L1-L3');
  assert.equal(preview.graph.summary.entryPoints.find((item) => item.label === 'registerRoute')?.locator, 'workspace://lib/route.js#L1-L3');
  assert(preview.graph.summary.entryPoints.every((item) => ['function', 'method'].includes(item.symbolKind)));

  const testPreview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'test register route',
    limit: 10,
    clock: () => fixedNow
  });
  const explicitTestSymbols = testPreview.search.results.filter((item) => item.kind === 'symbol' && item.label === 'registerRoute');

  assert.equal(explicitTestSymbols[0].locator, 'workspace://test/route.test.js#L1-L3');

  const sourceBeforeTypes = preview.search.results.filter((item) => item.kind === 'symbol' && item.label.toLowerCase() === 'registerroute');
  assert.equal(sourceBeforeTypes[0].locator, 'workspace://lib/route.js#L1-L3');
  assert(sourceBeforeTypes.findIndex((item) => item.locator === 'workspace://scripts/route.js#L1-L3') > 0);
  assert(sourceBeforeTypes.findIndex((item) => item.locator === 'workspace://types/route.d.ts#L1-L3') > 0);
  const firstCall = preview.search.results.findIndex((item) => item.kind === 'calls');
  assert(firstCall >= 0, preview.search.results.map((item) => `${item.kind}:${item.label}`).join(', '));
  assert.equal(preview.search.results.some((item) => item.kind === 'defined_in'), false);

  const definedInPreview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'register route',
    edgeKinds: ['defined_in'],
    limit: 10,
    clock: () => fixedNow
  });
  assert(definedInPreview.search.results.some((item) => item.kind === 'defined_in'));

  const scriptPreview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'scripts register route',
    limit: 10,
    clock: () => fixedNow
  });
  const explicitScriptSymbols = scriptPreview.search.results.filter((item) => item.kind === 'symbol' && item.label === 'registerRoute');
  assert.equal(explicitScriptSymbols[0].locator, 'workspace://scripts/route.js#L1-L3');

  const typePreview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'register route interface',
    limit: 10,
    clock: () => fixedNow
  });
  assert.equal(typePreview.search.results[0].locator, 'workspace://types/route.d.ts#L1-L3');
});

test('source graph preview ranks source imports before test imports in default searches', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaf-source-graph-import-ranking-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'test'), { recursive: true });
  await writeFile(path.join(root, 'src', 'route.ts'), [
    'export function registerRoute(app) {',
    '  return app;',
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'app.ts'), [
    "import { registerRoute } from './route';",
    'export function wireRoute(app) {',
    '  return registerRoute(app);',
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'test', 'app.test.ts'), [
    "import { registerRoute } from '../src/route';",
    'export function testWireRoute(app) {',
    '  return registerRoute(app);',
    '}'
  ].join('\n'));

  const preview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'register route import',
    limit: 20,
    clock: () => fixedNow
  });
  const sourceImport = preview.search.results.findIndex((item) => item.kind === 'imports' && item.label.includes('src/app.ts'));
  const testImport = preview.search.results.findIndex((item) => item.kind === 'imports' && item.label.includes('test/app.test.ts'));
  assert(sourceImport >= 0, preview.search.results.map((item) => `${item.kind}:${item.label}`).join(', '));
  assert(testImport > sourceImport, preview.search.results.map((item) => `${item.kind}:${item.label}`).join(', '));

  const explicitTestPreview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'test register route import',
    limit: 20,
    clock: () => fixedNow
  });
  const explicitTestImport = explicitTestPreview.search.results.findIndex((item) => item.kind === 'imports' && item.label.includes('test/app.test.ts'));
  assert(explicitTestImport >= 0, explicitTestPreview.search.results.map((item) => `${item.kind}:${item.label}`).join(', '));
  assert(!JSON.stringify(preview).includes(root));
  assert(!JSON.stringify(explicitTestPreview).includes(root));
});

test('source graph search weights import edge source paths, not only target locators', () => {
  const graph = {
    schemaVersion: '1.0.0',
    workspaceId: 'ws_local',
    graphFingerprint: 'sha256:' + '0'.repeat(64),
    nodes: [
      { id: 'sgnode_' + '1'.repeat(32), workspaceId: 'ws_local', kind: 'chunk', label: 'src/middleware/compress/index.test.ts#L1-L1', locator: 'workspace://src/middleware/compress/index.test.ts#L1-L1' },
      { id: 'sgnode_' + '2'.repeat(32), workspaceId: 'ws_local', kind: 'chunk', label: 'src/middleware/method-override/index.ts#L1-L1', locator: 'workspace://src/middleware/method-override/index.ts#L1-L1' },
      { id: 'sgnode_' + '3'.repeat(32), workspaceId: 'ws_local', kind: 'file', label: 'src/hono.ts', locator: 'workspace://src/hono.ts' }
    ],
    edges: [
      { id: 'sgedge_' + '0'.repeat(32), workspaceId: 'ws_local', kind: 'imports', fromNodeId: 'sgnode_' + '1'.repeat(32), toNodeId: 'sgnode_' + '3'.repeat(32), locator: 'workspace://src/hono.ts', confidence: 1 },
      { id: 'sgedge_' + 'f'.repeat(32), workspaceId: 'ws_local', kind: 'imports', fromNodeId: 'sgnode_' + '2'.repeat(32), toNodeId: 'sgnode_' + '3'.repeat(32), locator: 'workspace://src/hono.ts', confidence: 1 }
    ]
  };

  const search = searchSourceGraph(graph, { query: 'hono middleware', limit: 2 });
  assert.match(search.results[0].label, /method-override/);
});

test('source graph search collapses default export edges when the target symbol is already returned', () => {
  const symbolId = 'sgnode_' + '2'.repeat(32);
  const graph = {
    schemaVersion: '1.0.0',
    workspaceId: 'ws_local',
    graphFingerprint: 'sha256:' + '0'.repeat(64),
    nodes: [
      { id: 'sgnode_' + '1'.repeat(32), workspaceId: 'ws_local', kind: 'file', label: 'src/utils/handler.ts', locator: 'workspace://src/utils/handler.ts' },
      { id: symbolId, workspaceId: 'ws_local', kind: 'symbol', label: 'isMiddleware', locator: 'workspace://src/utils/handler.ts#L8-L15', symbolKind: 'function' }
    ],
    edges: [
      { id: 'sgedge_' + '0'.repeat(32), workspaceId: 'ws_local', kind: 'exports', fromNodeId: 'sgnode_' + '1'.repeat(32), toNodeId: symbolId, locator: 'workspace://src/utils/handler.ts#L8-L15', exportName: 'isMiddleware', confidence: 1 }
    ]
  };

  const search = searchSourceGraph(graph, { query: 'is middleware', limit: 10 });
  assert(search.results.some((item) => item.resultType === 'node' && item.id === symbolId));
  assert.equal(search.results.some((item) => item.resultType === 'edge' && item.kind === 'exports' && item.toNodeId === symbolId), false);

  const explicitExports = searchSourceGraph(graph, { query: 'is middleware', edgeKinds: ['exports'], limit: 10 });
  assert(explicitExports.results.some((item) => item.resultType === 'edge' && item.kind === 'exports' && item.toNodeId === symbolId));
});

test('source graph preview traces class relationships to imported bases and interfaces', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaf-source-graph-inheritance-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'base.ts'), [
    'export class BaseService {',
    '  ready() { return true; }',
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'contracts.ts'), [
    'export interface UserRepository {',
    '  getUser(id: string): string;',
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'shadow.ts'), [
    'export class BaseService {',
    '  ready() { return false; }',
    '}',
    '',
    'export interface UserRepository {',
    '  shadow: true;',
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'user.ts'), [
    "import { BaseService as ParentService } from './base';",
    '',
    'export class UserService extends ParentService {',
    '  getUser() { return this.ready(); }',
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'repo.ts'), [
    "import { UserRepository as Repo } from './contracts';",
    '',
    'export class SqlUserRepository implements Repo {',
    '  getUser(id) { return id; }',
    '}'
  ].join('\n'));

  const preview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'user service base class',
    startName: 'UserService',
    limit: 10,
    clock: () => fixedNow
  });
  const interfacePreview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'sql user repository interface',
    startName: 'SqlUserRepository',
    limit: 10,
    clock: () => fixedNow
  });

  assert(preview.trace.paths.some((item) => item.terminalLabel === 'BaseService' && item.terminalLocator === 'workspace://src/base.ts#L1-L3'));
  assert(interfacePreview.trace.paths.some((item) => item.terminalLabel === 'UserRepository' && item.terminalLocator === 'workspace://src/contracts.ts#L1-L3'));
  assert.equal(preview.trace.paths.some((item) => item.terminalLocator === 'workspace://src/shadow.ts#L1-L3'), false);
  assert.equal(interfacePreview.trace.paths.some((item) => item.terminalLocator === 'workspace://src/shadow.ts#L5-L7'), false);
  assert(!JSON.stringify(preview).includes(root));
});

test('source graph preview suppresses low-signal reference hotspots', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaf-source-graph-noisy-references-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'handlers.ts'), [
    'export function runWorkflow() {',
    '  return routeHandler();',
    '}',
    'export function routeHandler() {',
    '  return true;',
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'noise.ts'), [
    'export function id() {',
    '  return "id";',
    '}',
    'export function clock() {',
    '  return Date.now();',
    '}',
    'export function status() {',
    '  return "ok";',
    '}',
    'export function text() {',
    '  return "ok";',
    '}',
    'export function noisyRecord(idValue: string) {',
    '  const id = idValue;',
    '  const clock = Date.now();',
    '  const status = "ok";',
    '  const text = "ok";',
    '  const item = { id, clock, status, text };',
    '  return item.id && item.status && item.text;',
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'consumer.ts'), [
    "import { runWorkflow } from './handlers';",
    "import { noisyRecord } from './noise';",
    'export function boot() {',
    '  const id = noisyRecord("abc");',
    '  const clock = Date.now();',
    '  return runWorkflow() && Boolean(id) && Boolean(clock);',
    '}'
  ].join('\n'));

  const preview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'workflow handler',
    startName: 'boot',
    sampleLimit: 4,
    clock: () => fixedNow
  });

  const hotspotLabels = preview.graph.summary.hotspots.map((item) => item.label);
  assert(!hotspotLabels.includes('id'));
  assert(!hotspotLabels.includes('clock'));
  assert(!hotspotLabels.includes('status'));
  assert(!hotspotLabels.includes('text'));
  assert(preview.trace.paths.some((item) => item.terminalLabel === 'runWorkflow'));
});

test('source graph preview keeps locators on source-backed hotspots', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaf-source-graph-hotspot-locators-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'routes.ts'), [
    'export function routeHandler() {',
    '  return true;',
    '}',
    '',
    'export function runWorkflow() {',
    '  return routeHandler() && routeHandler();',
    '}',
    '',
    'export function boot() {',
    '  return runWorkflow();',
    '}'
  ].join('\n'));

  const preview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'route workflow handler',
    startName: 'boot',
    clock: () => fixedNow
  });
  const routeHandler = preview.graph.summary.hotspots.find((item) => item.label === 'routeHandler');

  assert.equal(routeHandler?.locator, 'workspace://src/routes.ts#L1-L3');
  assert(!JSON.stringify(preview).includes(root));
});

test('source graph preview exposes qualified labels for scoped symbols', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaf-source-graph-qualified-labels-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'controller.ts'), [
    'export class Controller {',
    '  handle(request) {',
    '    return request;',
    '  }',
    '}',
    '',
    'export function run(controller) {',
    '  return controller.handle({ ok: true });',
    '}'
  ].join('\n'));

  const preview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'Controller handle',
    startName: 'run',
    limit: 10,
    clock: () => fixedNow
  });
  const handle = preview.search.results.find((item) => item.kind === 'symbol' && item.label === 'handle');

  assert.equal(preview.graph.summary.qualifiedSymbolCount, 1);
  assert.equal(preview.graph.summary.ambiguousSymbolLabelCount, 0);
  assert.equal(handle?.qualifiedLabel, 'Controller.handle');
  assert(preview.trace.paths.some((item) => item.terminalLabel === 'handle' && item.terminalQualifiedLabel === 'Controller.handle'));
});

test('source graph preview deduplicates ambiguous qualified label samples', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaf-source-graph-ambiguous-qualified-labels-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  for (const name of ['page-a.ts', 'page-b.ts', 'page-c.ts']) {
    await writeFile(path.join(root, 'src', name), [
      'export function buildPage() {',
      '  function Content() {',
      '    return true;',
      '  }',
      '  return Content();',
      '}'
    ].join('\n'));
  }

  const preview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'Content build page',
    startName: 'buildPage',
    limit: 10,
    clock: () => fixedNow
  });
  const content = preview.graph.summary.ambiguousLabels.find((item) => item.label === 'Content');

  assert(content);
  assert.equal(content.count, 3);
  assert.deepEqual(content.qualifiedLabels, ['buildPage.Content']);
});

test('source graph preview qualifies nested function helpers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaf-source-graph-nested-functions-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'routes.js'), [
    'export function buildRoutes(app) {',
    '  function addRoute(route) {',
    '    return app.route(route);',
    '  }',
    '  const normalizeRoute = function normalizeRoute(route) {',
    '    return route.trim();',
    '  };',
    '  const registerRoute = (route) => {',
    '    return addRoute(normalizeRoute(route));',
    '  };',
    '  return registerRoute("/users");',
    '}',
    '',
    'export function runLater() {',
    '  return true;',
    '}'
  ].join('\n'));

  const preview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'nested route helpers',
    startName: 'buildRoutes',
    limit: 10,
    clock: () => fixedNow
  });
  const laterPreview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'run later',
    limit: 10,
    clock: () => fixedNow
  });

  const helperLabels = new Set(preview.search.results.map((item) => item.qualifiedLabel).filter(Boolean));
  const runLater = laterPreview.search.results.find((item) => item.kind === 'symbol' && item.label === 'runLater');
  assert(helperLabels.has('buildRoutes.addRoute'));
  assert(helperLabels.has('buildRoutes.normalizeRoute'));
  assert(helperLabels.has('buildRoutes.registerRoute'));
  assert.equal(runLater?.qualifiedLabel, undefined);
  assert(preview.trace.paths.some((item) => item.terminalQualifiedLabel === 'buildRoutes.addRoute'));
  assert(preview.trace.paths.some((item) => item.terminalQualifiedLabel === 'buildRoutes.registerRoute'));
  assert(!JSON.stringify(preview).includes(root));
});

test('source graph preview traces class field methods as scoped symbols', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaf-source-graph-class-fields-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'validators.ts'), [
    'export function validateForm() {',
    '  return true;',
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'controller.ts'), [
    "import { validateForm as validate } from './validators';",
    '',
    'export class FormController {',
    '  #prepare() {',
    '    return validate();',
    '  }',
    '',
    '  submit = () => {',
    '    return this.#prepare();',
    '  };',
    '',
    '  static create = () => new FormController();',
    '}',
    '',
    'export function boot(controller) {',
    '  return controller.submit();',
    '}'
  ].join('\n'));

  const preview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'form controller submit',
    startName: 'boot',
    depth: 4,
    limit: 10,
    clock: () => fixedNow
  });
  const submit = preview.search.results.find((item) => item.kind === 'symbol' && item.label === 'submit');
  const create = preview.search.results.find((item) => item.kind === 'symbol' && item.label === 'create');
  const prepare = preview.search.results.find((item) => item.kind === 'symbol' && item.label === '#prepare');

  assert.equal(submit?.qualifiedLabel, 'FormController.submit');
  assert.equal(create?.qualifiedLabel, 'FormController.create');
  assert.equal(prepare?.qualifiedLabel, 'FormController.#prepare');
  assert(preview.trace.paths.some((item) => item.terminalLabel === 'submit' && item.terminalQualifiedLabel === 'FormController.submit'));
  assert(preview.trace.paths.some((item) => item.terminalLabel === '#prepare' && item.terminalQualifiedLabel === 'FormController.#prepare'));
  assert(preview.trace.paths.some((item) => item.terminalLabel === 'validateForm' && item.terminalLocator === 'workspace://src/validators.ts#L1-L3'));
  assert(!JSON.stringify(preview).includes(root));
});

test('source graph preview indexes typed callable class properties', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaf-source-graph-typed-class-properties-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'app.ts'), [
    'type HandlerInterface = (path: string, handler: unknown) => unknown;',
    'type MiddlewareHandlerInterface = (path: string, handler: unknown) => unknown;',
    'type Router = { add(path: string): void };',
    '',
    'export class App<',
    '  Env extends Record<string, unknown> = {},',
    '> {',
    '  get!: HandlerInterface',
    '  post!: HandlerInterface',
    '  use: MiddlewareHandlerInterface',
    '  router!: Router',
    '  routes: string[] = []',
    '',
    '  constructor() {',
    "    this.use = (path, handler) => handler;",
    '  }',
    '}'
  ].join('\n'));

  const preview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'get post use route handler',
    changedLocators: ['src/app.ts'],
    clock: () => fixedNow
  });
  const tracePreview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'get route handler',
    startName: 'App.get',
    clock: () => fixedNow
  });
  const symbols = new Map(preview.search.results.filter((item) => item.qualifiedLabel).map((item) => [item.qualifiedLabel, item]));
  const labels = new Set(symbols.keys());
  const affected = new Set(preview.impact.affectedSymbols.map((item) => item.qualifiedName).filter(Boolean));

  assert(labels.has('App.get'));
  assert(labels.has('App.post'));
  assert(labels.has('App.use'));
  assert(preview.search.results.findIndex((item) => item.qualifiedLabel === 'App.get') < preview.search.results.findIndex((item) => item.label === 'HandlerInterface'));
  assert.equal(symbols.get('App.get')?.locator, 'workspace://src/app.ts#L8-L8');
  assert.equal(symbols.get('App.post')?.locator, 'workspace://src/app.ts#L9-L9');
  assert(preview.search.results.some((item) => item.qualifiedLabel === 'App.use' && item.locator === 'workspace://src/app.ts#L10-L10'));
  assert.equal(labels.has('App.router'), false);
  assert.equal(labels.has('App.routes'), false);
  assert(affected.has('App.get'));
  assert(affected.has('App.post'));
  assert(affected.has('App.use'));
  assert(tracePreview.trace.paths.some((item) => item.depth === 0 && item.terminalQualifiedLabel === 'App.get' && item.terminalLocator === 'workspace://src/app.ts#L8-L8'));
  assert(!JSON.stringify(preview).includes(root));
});

test('source graph preview traces typed exported arrow route handlers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaf-source-graph-typed-arrow-route-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'users.ts'), [
    'export function loadUser(request) {',
    '  return request;',
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'route.ts'), [
    "import { loadUser } from './users';",
    '',
    'type Handler = (request: Request) => unknown;',
    '',
    'export const GET: Handler = async (request) => {',
    '  return loadUser(request);',
    '};'
  ].join('\n'));

  const preview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'typed route handler',
    startName: 'GET',
    limit: 10,
    clock: () => fixedNow
  });
  const handler = preview.search.results.find((item) => item.kind === 'symbol' && item.label === 'GET');

  assert.equal(handler?.locator, 'workspace://src/route.ts#L5-L7');
  assert(preview.trace.paths.some((item) => item.terminalLabel === 'loadUser' && item.terminalLocator === 'workspace://src/users.ts#L1-L3'));
  assert(!JSON.stringify(preview).includes(root));
});

test('source graph preview resolves workspace root alias imports', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaf-source-graph-root-alias-'));
  await mkdir(path.join(root, 'src', 'lib'), { recursive: true });
  await mkdir(path.join(root, 'src', 'app'), { recursive: true });
  await writeFile(path.join(root, 'src', 'lib', 'session.ts'), [
    'export function readSession(request) {',
    '  return request;',
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'app', 'route.ts'), [
    "import { readSession } from '@/src/lib/session';",
    '',
    'export const GET = async (request) => {',
    '  return readSession(request);',
    '};'
  ].join('\n'));

  const preview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'root alias session route',
    startName: 'GET',
    limit: 10,
    clock: () => fixedNow
  });

  assert(preview.trace.paths.some((item) => item.terminalLabel === 'readSession' && item.terminalLocator === 'workspace://src/lib/session.ts#L1-L3'));
  assert(!JSON.stringify(preview).includes(root));
});

test('source graph preview prefers source callees over duplicate test helpers in traces', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaf-source-graph-trace-ranking-'));
  await mkdir(path.join(root, 'lib'), { recursive: true });
  await mkdir(path.join(root, 'test'), { recursive: true });
  await writeFile(path.join(root, 'lib', 'route.js'), [
    'export function routeHandler(reply) {',
    '  send(reply);',
    '  return end(reply);',
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'lib', 'reply.js'), [
    'export function send(reply) {',
    '  return reply;',
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'test', 'reply.test.js'), [
    'export function send(reply) {',
    '  return reply;',
    '}',
    '',
    'export function end(reply) {',
    '  return reply;',
    '}'
  ].join('\n'));

  const preview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'route handler send',
    startName: 'routeHandler',
    limit: 10,
    clock: () => fixedNow
  });
  const sendPaths = preview.trace.paths.filter((item) => item.terminalLabel === 'send');

  assert(sendPaths.some((item) => item.terminalLocator === 'workspace://lib/reply.js#L1-L3'));
  assert.equal(sendPaths.some((item) => item.terminalLocator?.startsWith('workspace://test/')), false);
  assert.equal(preview.trace.paths.some((item) => item.terminalLabel === 'end'), false);
});

test('source graph preview does not resolve generic member calls to unrelated symbols', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaf-source-graph-member-noise-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'state.js'), [
    'export function has(flag) {',
    '  return Boolean(flag);',
    '}',
    '',
    'export function log(value) {',
    '  return value;',
    '}',
    '',
    'export function clock() {',
    '  return new Date();',
    '}',
    '',
    'export function results() {',
    '  return [];',
    '}'
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'reader.js'), [
    'export function readFlag(flags) {',
    "  return flags.has('enabled');",
    '}',
    '',
    'export function readValues(values) {',
    '  values.forEach(console.log);',
    '  return values;',
    '}',
    '',
    'export function readGenerated(clock) {',
    '  return clock();',
    '}',
    '',
    'export function readResults() {',
    '  const results = [1];',
    '  return results.map((item) => item);',
    '}'
  ].join('\n'));

  const preview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'read flag',
    startName: 'readFlag',
    limit: 10,
    clock: () => fixedNow
  });
  const callbackPreview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'read values',
    startName: 'readValues',
    limit: 10,
    clock: () => fixedNow
  });
  const lowSignalPreview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'read generated',
    startName: 'readGenerated',
    limit: 10,
    clock: () => fixedNow
  });
  const resultsPreview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'read results',
    startName: 'readResults',
    limit: 10,
    clock: () => fixedNow
  });
  const hasPreview = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'has',
    limit: 10,
    clock: () => fixedNow
  });
  const resultsSearch = await buildSourceGraphPreview({
    root,
    workspaceId: 'ws_local',
    query: 'results',
    limit: 10,
    clock: () => fixedNow
  });

  assert.equal(preview.trace.paths.some((item) => item.terminalLabel === 'has'), false);
  assert.equal(callbackPreview.trace.paths.some((item) => item.terminalLabel === 'log'), false);
  assert.equal(lowSignalPreview.trace.paths.some((item) => item.terminalLabel === 'clock'), false);
  assert.equal(resultsPreview.trace.paths.some((item) => item.terminalLabel === 'results'), false);
  assert.equal(hasPreview.search.results.some((item) => item.kind === 'symbol' && item.label === 'has'), true);
  assert.equal(resultsSearch.search.results.some((item) => item.kind === 'symbol' && item.label === 'results'), true);
});
