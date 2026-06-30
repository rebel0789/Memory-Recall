import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildCompressedProfileContextReport } from '../packages/context-compiler/src/index.mjs';
import { buildLoopPlan, runLoop } from '../packages/harness-context/src/index.mjs';
import { SQLiteMemoryProvider } from '../providers/native/memory-sqlite/src/index.mjs';

async function approveProposal(provider, { id, sourceHash, payload }) {
  await provider.enqueueProposal({
    id,
    workspaceId: 'ws_local',
    sourceLocator: 'workspace://memory/native-core.md',
    sourceHash,
    payload
  });
  await provider.claimProposal({ workspaceId: 'ws_local', workerId: 'reviewer', leaseUntil: '2026-06-26T10:05:00.000Z' });
  await provider.recordProposalResult({ workspaceId: 'ws_local', id, workerId: 'reviewer', status: 'applied', result: { accepted: true } });
}

function profileRecordFromFact(result) {
  const fact = result.fact;
  return {
    schemaVersion: '1.0.0',
    id: `mem_${fact.id}`,
    workspaceId: fact.workspaceId,
    kind: 'fact',
    text: fact.text,
    status: 'active',
    source: fact.source,
    sourceTrust: 'verified',
    trustClass: 'verified',
    confidence: fact.confidence,
    authority: 0.8,
    dataClass: 'workspace-private',
    scope: 'workspace-private',
    createdAt: fact.validFrom,
    updatedAt: fact.validFrom,
    tags: [fact.subject, fact.object],
    relations: [fact.subject, fact.object]
  };
}

test('native core local profile flows plan memory retrieval profile and loop without cloud', async (t) => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(pkg.scripts['local:run'], 'npm run bootstrap && npm run native:smoke');

  const draftPlan = buildLoopPlan({
    workspaceId: 'ws_local',
    objective: 'Prepare native core local profile',
    stopCondition: 'loop completes with memory-backed profile context',
    validationCommands: ['node --test tests/native-core-local-profile-e2e.test.mjs'],
    changedLocators: ['packages/harness-context/src/index.mjs'],
    clock: () => '2026-06-26T10:00:00.000Z'
  });
  assert.equal(draftPlan.contextBudget.basis, 'unestimated');

  const directory = await mkdtemp(path.join(os.tmpdir(), 'oaf-native-core-e2e-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const provider = new SQLiteMemoryProvider({ filename: path.join(directory, 'memory.sqlite'), clock: () => '2026-06-26T10:00:00.000Z' });
  t.after(() => provider.close());

  await approveProposal(provider, {
    id: 'mpq_e2e_release',
    sourceHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    payload: { kind: 'fact', subject: 'project:oaf', predicate: 'release_status', object: 'local-profile-ready' }
  });
  await provider.addTemporalFact({
    id: 'memfact_e2e_release',
    workspaceId: 'ws_local',
    scope: 'workspace',
    subject: 'project:oaf',
    predicate: 'release_status',
    object: 'local-profile-ready',
    text: 'OAF native core local profile is ready only for local-first single-developer use.',
    source: 'workspace://memory/native-core.md',
    proposalQueueId: 'mpq_e2e_release',
    validFrom: '2026-06-26T09:00:00.000Z',
    episode: { id: 'mep_e2e_release', sourceLocator: 'workspace://memory/native-core.md', summary: 'Local profile readiness note.', observedAt: '2026-06-26T09:00:00.000Z' }
  });

  await approveProposal(provider, {
    id: 'mpq_e2e_loop',
    sourceHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    payload: { kind: 'fact', subject: 'project:oaf', predicate: 'uses', object: 'loop-workbench' }
  });
  await provider.addTemporalFact({
    id: 'memfact_e2e_loop',
    workspaceId: 'ws_local',
    scope: 'workspace',
    subject: 'project:oaf',
    predicate: 'uses',
    object: 'loop-workbench',
    text: 'Loop Workbench run reports include maker checker reasoning and bounded stop reasons.',
    source: 'workspace://memory/native-core.md',
    proposalQueueId: 'mpq_e2e_loop',
    validFrom: '2026-06-26T09:30:00.000Z',
    episode: { id: 'mep_e2e_loop', sourceLocator: 'workspace://memory/native-core.md', summary: 'Loop reasoning note.', observedAt: '2026-06-26T09:30:00.000Z' }
  });

  const retrieval = await provider.searchTemporalMemory({
    workspaceId: 'ws_local',
    scope: 'workspace',
    query: 'local profile loop',
    at: '2026-06-26T10:00:00.000Z',
    limit: 5
  });
  assert.deepEqual([...new Set(retrieval.results.map((item) => item.fact.id))].sort(), ['memfact_e2e_loop', 'memfact_e2e_release']);
  assert.equal(retrieval.signals.semantic.status, 'skipped');

  const profile = buildCompressedProfileContextReport({
    records: retrieval.results.map(profileRecordFromFact),
    workspaceId: 'ws_local',
    generatedAt: '2026-06-26T10:00:00.000Z',
    objective: draftPlan.objective,
    step: draftPlan.stopCondition,
    tokenBudget: 256,
    staticLimit: 4,
    dynamicLimit: 2
  });
  assert(profile.contextBudget.estimatedDeliveryTokens > 0);
  assert(profile.contextBudget.historyTokensAvoided >= 0);

  const loopPlan = buildLoopPlan({
    workspaceId: 'ws_local',
    objective: draftPlan.objective,
    stopCondition: draftPlan.stopCondition,
    validationCommands: draftPlan.validationCommands,
    changedLocators: ['packages/harness-context/src/index.mjs'],
    contextBudget: {
      estimatedDeliveryTokens: profile.contextBudget.estimatedDeliveryTokens,
      sourceBodyTokensExcluded: profile.contextBudget.historyTokensAvoided,
      deliveryReductionRatio: profile.contextBudget.reductionRatio,
      basis: 'context-pack-measurement'
    },
    clock: () => '2026-06-26T10:00:00.000Z'
  });
  const run = await runLoop({
    loopPlan,
    runId: 'run_native_core_e2e',
    verificationRunner: async () => ({ id: 'loopverify_native_core_e2e', status: 'proposed', stopReason: 'completed' }),
    clock: () => '2026-06-26T10:00:01.000Z'
  });
  assert.equal(run.status, 'completed');
  assert.equal(run.stopReason, 'completed');
  assert.equal(run.tokenBudget.aggregatedEstimatedDeliveryTokens, profile.contextBudget.estimatedDeliveryTokens);
  assert.equal(run.reasoning.checker.planFields.stopCondition, draftPlan.stopCondition);
  assert.equal(run.safeguards.externalWritesEnabled, false);
  assert.equal(run.safeguards.networkCalls, 0);
  assert.equal(run.safeguards.modelCalls, 0);
});
