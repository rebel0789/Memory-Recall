import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { buildCompressedProfileContextReport } from '../packages/context-compiler/src/index.mjs';

const generatedAt = '2026-06-26T12:00:00.000Z';

function memoryRecord(overrides = {}) {
  return {
    schemaVersion: '1.0.0',
    id: 'mem_profile_fact',
    workspaceId: 'ws_local',
    kind: 'fact',
    text: 'Open Agent Fabric uses local-first temporal memory with proposal-gated writes and deterministic context manifests.',
    status: 'active',
    source: 'evidence:profile',
    sourceTrust: 'verified',
    trustClass: 'verified',
    confidence: 0.9,
    authority: 0.8,
    dataClass: 'workspace-private',
    scope: 'workspace-private',
    createdAt: '2026-06-20T00:00:00.000Z',
    updatedAt: '2026-06-25T00:00:00.000Z',
    tags: ['project:oaf'],
    relations: ['project:oaf'],
    ...overrides
  };
}

function repeatedWords(word, count) {
  return Array.from({ length: count }, () => word).join(' ');
}

test('compressed profile context is bounded deterministic measured and CLI exposed', async () => {
  const records = [
    memoryRecord({ id: 'mem_static_arch', kind: 'fact', text: `${repeatedWords('architecture', 90)} temporal-memory proposal-gated local-first project:oaf`, updatedAt: '2026-06-21T00:00:00.000Z' }),
    memoryRecord({ id: 'mem_static_policy', kind: 'decision', text: `${repeatedWords('policy', 80)} read-only measured-savings contextBudget project:oaf`, updatedAt: '2026-06-22T00:00:00.000Z' }),
    memoryRecord({ id: 'mem_static_pref', kind: 'preference', text: `${repeatedWords('preference', 70)} compact-profile deterministic project:oaf`, updatedAt: '2026-06-23T00:00:00.000Z' }),
    memoryRecord({ id: 'mem_dynamic_g4', kind: 'episode', text: `${repeatedWords('handoff', 75)} G4 extracted proposal facts without active memory writes project:oaf`, updatedAt: '2026-06-26T10:00:00.000Z' }),
    memoryRecord({ id: 'mem_dynamic_g3', kind: 'episode', text: `${repeatedWords('retrieval', 75)} G3 hybrid search path explain stayed local project:oaf`, updatedAt: '2026-06-26T09:00:00.000Z' }),
    memoryRecord({ id: 'mem_secret_skip', dataClass: 'secret', text: 'token=SHOULD_NOT_APPEAR' }),
    memoryRecord({ id: 'mem_other_workspace', workspaceId: 'ws_other', text: repeatedWords('otherworkspace', 40) })
  ];
  const input = {
    records,
    workspaceId: 'ws_local',
    generatedAt,
    objective: 'Prepare Open Agent Fabric native memory handoff for project:oaf',
    step: 'Build compressed profile context budget',
    tokenBudget: 220,
    staticLimit: 3,
    dynamicLimit: 2
  };
  const first = buildCompressedProfileContextReport(input);
  const second = buildCompressedProfileContextReport(input);

  assert.deepEqual(second, first);
  assert.equal(first.profile.layers.map((item) => item.layer).join(','), 'static,dynamic');
  assert.deepEqual(first.profile.layers.map((item) => item.recordCount), [3, 2]);
  assert(first.contextBudget.estimatedDeliveryTokens < first.contextBudget.historyTokensAvailable);
  assert(first.contextBudget.historyTokensAvoided > 0);
  assert(first.contextBudget.reductionRatio > 0.5);
  assert(first.contextBudget.profileTokens <= first.contextBudget.estimatedDeliveryTokens);
  assert.equal(first.manifest.budget.used, first.contextBudget.estimatedDeliveryTokens);
  assert.equal(first.safeguards.modelCalls, 0);
  assert.equal(first.safeguards.networkCalls, 0);
  assert.equal(JSON.stringify(first).includes('SHOULD_NOT_APPEAR'), false);

  const root = await mkdtemp(path.join(os.tmpdir(), 'oaf-profile-context-'));
  const recordsPath = path.join(root, 'records.json');
  await writeFile(recordsPath, JSON.stringify({ records }, null, 2));
  const cli = spawnSync(process.execPath, [
    'apps/cli/oaf.mjs',
    'context',
    'profile',
    '--records',
    recordsPath,
    '--objective',
    input.objective,
    '--step',
    input.step,
    '--token-budget',
    String(input.tokenBudget),
    '--static-limit',
    String(input.staticLimit),
    '--dynamic-limit',
    String(input.dynamicLimit),
    '--format',
    'json'
  ], {
    cwd: path.resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
    env: { ...process.env, OAF_FIXED_NOW: generatedAt }
  });
  assert.equal(cli.status, 0, cli.stderr);
  const parsed = JSON.parse(cli.stdout);
  assert.deepEqual(parsed.contextBudget, first.contextBudget);
  assert.equal(parsed.profile.contentHash, first.profile.contentHash);
});
