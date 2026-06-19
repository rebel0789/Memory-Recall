import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileAndPersistContext,
  compareContextManifests,
  verifyContextManifest
} from '../packages/context-compiler/src/index.mjs';

const fixedNow = '2026-06-20T00:00:00.000Z';

function request(overrides = {}) {
  return {
    schemaVersion: '1.0.0',
    id: 'ctxreq_oaf012',
    requestId: 'ctxreq_oaf012',
    correlationId: 'req_oaf012_000000',
    workspaceId: 'ws_local',
    actorId: 'usr_owner',
    taskId: 'task_oaf_012',
    step: 'generate-angles',
    objective: 'Find durable context manifest evidence',
    requiredIds: [],
    requiredEntities: ['topic:context-manifest'],
    allowedScopes: ['workspace-private'],
    allowedDataClasses: ['workspace-private', 'public'],
    allowedTrustClasses: ['verified', 'trusted', 'observed'],
    tokenBudget: 90,
    now: fixedNow,
    trustedTimestamp: fixedNow,
    ...overrides
  };
}

function records(overrides = []) {
  return [
    {
      id: 'policy_manifest',
      kind: 'policy',
      workspaceId: 'ws_local',
      text: 'Persist a safe context manifest before every model call.',
      tags: ['topic:context-manifest'],
      relations: ['topic:context-manifest'],
      scope: 'workspace-private',
      dataClass: 'workspace-private',
      trustClass: 'verified',
      status: 'active',
      source: 'workspace-policy',
      tokens: 12,
      confidence: 1,
      authority: 1
    },
    {
      id: 'constraint_no_secret',
      kind: 'constraint',
      workspaceId: 'ws_local',
      text: 'Do not store credentials, cookies, auth headers, SQL, local paths, or hidden reasoning.',
      tags: ['topic:context-manifest'],
      relations: ['topic:context-manifest'],
      scope: 'workspace-private',
      dataClass: 'workspace-private',
      trustClass: 'verified',
      status: 'active',
      source: 'workspace-policy',
      tokens: 18,
      confidence: 1,
      authority: 1
    },
    {
      id: 'decision_manifest',
      kind: 'decision',
      workspaceId: 'ws_local',
      text: 'Context manifests are immutable append-only records keyed by workspace and run.',
      tags: ['topic:context-manifest'],
      relations: ['topic:context-manifest'],
      scope: 'workspace-private',
      dataClass: 'workspace-private',
      trustClass: 'trusted',
      status: 'active',
      source: 'architecture-note',
      tokens: 14,
      confidence: 0.9,
      authority: 0.9
    },
    {
      id: 'obs_manifest',
      kind: 'observation',
      workspaceId: 'ws_local',
      text: 'A durable manifest makes the later model input reproducible and comparable.',
      tags: ['topic:context-manifest'],
      relations: ['topic:context-manifest'],
      scope: 'workspace-private',
      dataClass: 'workspace-private',
      trustClass: 'observed',
      status: 'active',
      source: 'test-fixture',
      tokens: 14,
      confidence: 0.8,
      authority: 0.7
    },
    {
      id: 'obs_excluded_secret',
      kind: 'observation',
      workspaceId: 'ws_local',
      text: 'Excluded raw text contains /Users/rebel/.env and SELECT * FROM secrets.',
      tags: ['topic:context-manifest'],
      relations: ['topic:context-manifest'],
      scope: 'workspace-private',
      dataClass: 'secret',
      trustClass: 'trusted',
      status: 'active',
      source: 'unsafe-fixture',
      tokens: 10,
      confidence: 1,
      authority: 1
    },
    ...overrides
  ];
}

test('durable composition assembles ordered sections, persists before model work, verifies, and emits safe event', async () => {
  const events = [];
  const appends = [];
  const repository = {
    async append(input) {
      appends.push(input);
      return input.manifest;
    },
    async get({ workspaceId, id }) {
      return appends.find((item) => item.workspaceId === workspaceId && item.manifest.id === id)?.manifest ?? null;
    }
  };
  let modelInvoked = false;

  const result = await compileAndPersistContext(request(), records(), {
    manifestRepository: repository,
    runId: 'run_oaf012',
    clock: () => fixedNow,
    emitEvent: async (type, payload) => events.push({ type, payload }),
    afterPersist: async ({ manifest }) => {
      modelInvoked = true;
      assert.equal(appends.length, 1);
      assert.equal(appends[0].manifest.id, manifest.id);
    }
  });

  assert.equal(modelInvoked, true);
  assert.equal(result.persisted, true);
  assert.equal(result.verification.valid, true);
  assert.match(result.manifest.manifestFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.match(result.manifest.assembly.assemblyFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(result.manifest.assembly.sections.slice(0, 2).map((section) => section.id), ['governance', 'decisions']);
  assert.deepEqual(result.manifest.assembly.selectedRecordIds, result.manifest.selected.map((item) => item.id));
  assert.equal(result.manifest.assembly.sections[0].items[0].text, 'Persist a safe context manifest before every model call.');
  assert.equal(result.manifest.assembly.totalTokens, result.manifest.budget.used);
  assert(!JSON.stringify(result.manifest.excluded).includes('/Users/rebel/.env'));
  assert(!JSON.stringify(result.manifest.excluded).includes('SELECT * FROM secrets'));

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'context.manifest.persisted');
  assert.equal(events[0].payload.manifestId, result.manifest.id);
  assert.equal(events[0].payload.manifestFingerprint, result.manifest.manifestFingerprint);
  assert(!JSON.stringify(events[0]).includes('Persist a safe context manifest'));
});

test('required governance over budget fails before persistence or downstream invocation', async () => {
  let appended = false;
  let downstream = false;
  await assert.rejects(
    compileAndPersistContext(request({ tokenBudget: 10 }), records(), {
      manifestRepository: {
        async append() {
          appended = true;
        }
      },
      afterPersist: async () => {
        downstream = true;
      }
    }),
    (error) => error.code === 'required_context_over_budget'
  );
  assert.equal(appended, false);
  assert.equal(downstream, false);
});

test('manifest verification and comparison are deterministic and do not expose raw selected text', async () => {
  const repository = {
    async append(input) { return input.manifest; },
    async get({ id }) { return this.manifest?.id === id ? this.manifest : null; }
  };
  const left = await compileAndPersistContext(request(), records(), {
    manifestRepository: {
      async append(input) {
        repository.manifest = input.manifest;
        return input.manifest;
      },
      async get({ id }) {
        return repository.manifest?.id === id ? repository.manifest : null;
      }
    },
    runId: 'run_oaf012',
    clock: () => fixedNow
  });
  const right = structuredClone(left.manifest);
  right.id = 'ctx_oaf012_other';
  right.selected = right.selected.filter((item) => item.id !== 'obs_manifest');
  right.assembly.sections = right.assembly.sections.map((section) => ({
    ...section,
    items: section.items.filter((item) => item.id !== 'obs_manifest'),
    recordIds: section.recordIds.filter((id) => id !== 'obs_manifest')
  }));
  right.assembly.selectedRecordIds = right.assembly.selectedRecordIds.filter((id) => id !== 'obs_manifest');

  assert.equal(verifyContextManifest(left.manifest).valid, true);
  const diff = compareContextManifests(left.manifest, right);
  assert.equal(diff.sameWorkspace, true);
  assert.deepEqual(diff.selected.removed, ['obs_manifest']);
  assert(!JSON.stringify(diff).includes('A durable manifest makes the later model input'));
});
