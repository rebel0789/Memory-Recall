import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateJsonSchema } from '../packages/protocol/src/schema-validator.mjs';
import { buildSourceGraphPreview } from '../packages/source-graph/src/index.mjs';

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
  assert(preview.search.results.some((item) => item.label.includes('approveTokenReset')));
  assert(preview.trace.paths.some((item) => item.terminalLabel === 'approveTokenReset'));
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
