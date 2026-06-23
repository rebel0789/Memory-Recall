import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  compileAndPersistContext,
  compareContextManifests,
  hashRef,
  stableStringify,
  verifyContextManifest
} from '../packages/context-compiler/src/index.mjs';
import { validateJsonSchema } from '../packages/protocol/src/schema-validator.mjs';

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

function memoryRepository() {
  const appends = [];
  return {
    appends,
    async append(input) {
      appends.push(input);
      return input.manifest;
    },
    async get({ workspaceId, id }) {
      return appends.find((item) => item.workspaceId === workspaceId && item.manifest.id === id)?.manifest ?? null;
    }
  };
}

const legacyAssemblyPolicy = {
  schemaVersion: '1.0.0',
  policyVersion: '1.0.0',
  sectionOrder: ['governance', 'negative', 'decisions', 'preferences', 'procedures', 'evidence', 'episodes', 'artifacts', 'examples', 'other', 'workingState'],
  tokenAccounting: 'sum_selected_estimated_tokens',
  selectedText: 'preserve_exact_selected_text',
  excludedText: 'omit_from_durable_manifest',
  fingerprintAlgorithm: 'sha256_canonical_json'
};

function manifestContentHashForTest(item) {
  return hashRef(stableStringify({
    id: item.id,
    kind: item.kind,
    text: item.text,
    source: item.source,
    tokens: item.tokens
  }));
}

function legacyAssemblyForTest(selected) {
  const bySection = new Map(legacyAssemblyPolicy.sectionOrder.map((id) => [id, []]));
  for (const item of selected) bySection.get(legacyAssemblyPolicy.sectionOrder.includes(item.category) ? item.category : 'other')?.push(item);
  const sections = [];
  let order = 1;
  for (const sectionId of legacyAssemblyPolicy.sectionOrder) {
    const items = [...(bySection.get(sectionId) ?? [])].sort((a, b) => {
      const rank = (item) => item.kind === 'policy' ? 0 : item.kind === 'constraint' ? 1 : 2;
      return rank(a) - rank(b) || (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id);
    });
    if (!items.length) continue;
    const sectionItems = items.map((item) => ({
      id: item.id,
      kind: item.kind,
      tokens: item.tokens,
      source: item.source,
      text: item.text,
      contentHash: manifestContentHashForTest(item)
    }));
    sections.push({
      id: sectionId,
      order: order++,
      recordCount: sectionItems.length,
      tokenCount: sectionItems.reduce((sum, item) => sum + item.tokens, 0),
      recordIds: sectionItems.map((item) => item.id),
      items: sectionItems
    });
  }
  const selectedRecordIds = sections.flatMap((section) => section.recordIds);
  const totalTokens = sections.reduce((sum, section) => sum + section.tokenCount, 0);
  const assemblyFingerprint = hashRef(stableStringify({
    policyVersion: legacyAssemblyPolicy.policyVersion,
    policyFingerprint: hashRef(stableStringify(legacyAssemblyPolicy)),
    sectionOrder: legacyAssemblyPolicy.sectionOrder,
    sections: sections.map((section) => ({
      id: section.id,
      recordIds: section.recordIds,
      tokenCount: section.tokenCount,
      contentHashes: section.items.map((item) => item.contentHash)
    })),
    totalTokens
  }));
  return {
    schemaVersion: '1.0.0',
    assemblyPolicyVersion: legacyAssemblyPolicy.policyVersion,
    assemblyPolicyFingerprint: hashRef(stableStringify(legacyAssemblyPolicy)),
    sectionOrder: legacyAssemblyPolicy.sectionOrder,
    selectedRecordIds,
    totalTokens,
    sections,
    assemblyFingerprint
  };
}

function refreshManifestFingerprintForTest(manifest) {
  const copy = structuredClone(manifest);
  delete copy.manifestFingerprint;
  manifest.manifestFingerprint = hashRef(stableStringify(copy));
  return manifest;
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

test('representation tiers shrink assembly tokens and persisted manifests record bounded deltas', async () => {
  const repository = memoryRepository();
  const first = await compileAndPersistContext(
    request({
      tokenBudget: 260,
      requiredIds: ['artifact_manifest_large', 'procedure_manifest_locator']
    }),
    records([
      {
        id: 'artifact_manifest_large',
        kind: 'artifact',
        workspaceId: 'ws_local',
        text: 'Context manifest token evidence must stay compact while preserving the exact selected record identity. '.repeat(10),
        tags: ['topic:context-manifest'],
        relations: ['topic:context-manifest'],
        scope: 'workspace-private',
        dataClass: 'workspace-private',
        trustClass: 'trusted',
        status: 'active',
        source: 'workspace-artifact',
        tokens: 160,
        confidence: 0.9,
        authority: 0.8,
        metadata: {
          contextAssembly: {
            tier: 'snippet',
            reasonCodes: ['token_budget']
          }
        }
      },
      {
        id: 'procedure_manifest_locator',
        kind: 'procedure',
        workspaceId: 'ws_local',
        text: 'Use the durable manifest by stable locator when the body is already available in a trusted local source.',
        tags: ['topic:context-manifest'],
        relations: ['topic:context-manifest'],
        scope: 'workspace-private',
        dataClass: 'workspace-private',
        trustClass: 'trusted',
        status: 'active',
        source: 'workspace-procedure',
        tokens: 32,
        confidence: 0.9,
        authority: 0.8,
        metadata: {
          contextAssembly: {
            tier: 'locator-only',
            reasonCodes: ['stable_reference']
          }
        }
      }
    ]),
    {
      manifestRepository: repository,
      runId: 'run_oaf012_delta_a',
      clock: () => fixedNow
    }
  );

  const firstItems = first.manifest.assembly.sections.flatMap((section) => section.items);
  const snippet = firstItems.find((item) => item.id === 'artifact_manifest_large');
  const locator = firstItems.find((item) => item.id === 'procedure_manifest_locator');
  assert.equal(first.manifest.deltaFrom, null);
  assert.match(first.manifest.etag, /^sha256:[a-f0-9]{64}$/);
  assert.equal(snippet.representation.tier, 'snippet');
  assert.equal(locator.representation.tier, 'locator-only');
  assert(snippet.tokens < snippet.originalTokens);
  assert(locator.tokens < locator.originalTokens);
  assert.equal(first.manifest.tokenAccounting.assembledTokens, first.manifest.assembly.totalTokens);
  assert.equal(first.manifest.tokenAccounting.selectedOriginalTokens, first.manifest.assembly.originalTokens);
  assert.equal(first.manifest.tokenAccounting.totalCandidateTokens, 260);
  assert.equal(first.manifest.tokenAccounting.selectedTokenRatio, Number((250 / 260).toFixed(6)));
  assert(first.manifest.tokenAccounting.assembledTokenRatio < 1);
  assert.equal(first.manifest.tokenAccounting.wastedTokenEstimate, first.manifest.assembly.originalTokens - first.manifest.assembly.totalTokens);
  assert(first.manifest.tokenAccounting.compressionLossNotes.some((item) => item.recordId === 'artifact_manifest_large' && item.tier === 'snippet'));
  assert.equal(verifyContextManifest(first.manifest).valid, true);

  const second = await compileAndPersistContext(
    request({
      id: 'ctxreq_oaf012_delta',
      requestId: 'ctxreq_oaf012_delta',
      tokenBudget: 300,
      requiredIds: ['artifact_manifest_large', 'artifact_manifest_new']
    }),
    records([
      {
        id: 'artifact_manifest_large',
        kind: 'artifact',
        workspaceId: 'ws_local',
        text: 'Context manifest token evidence changed but remains compact in the assembled model context. '.repeat(10),
        tags: ['topic:context-manifest'],
        relations: ['topic:context-manifest'],
        scope: 'workspace-private',
        dataClass: 'workspace-private',
        trustClass: 'trusted',
        status: 'active',
        source: 'workspace-artifact',
        tokens: 150,
        confidence: 0.9,
        authority: 0.8,
        metadata: {
          contextAssembly: {
            tier: 'snippet',
            reasonCodes: ['token_budget']
          }
        }
      },
      {
        id: 'artifact_manifest_new',
        kind: 'artifact',
        workspaceId: 'ws_local',
        text: 'A new manifest note is represented as an outline because the source body can be fetched by its stable record identifier.',
        tags: ['topic:context-manifest'],
        relations: ['topic:context-manifest'],
        scope: 'workspace-private',
        dataClass: 'workspace-private',
        trustClass: 'trusted',
        status: 'active',
        source: 'workspace-artifact',
        tokens: 44,
        confidence: 0.9,
        authority: 0.8,
        metadata: {
          contextAssembly: {
            tier: 'outline',
            reasonCodes: ['summary_sufficient']
          }
        }
      }
    ]),
    {
      manifestRepository: repository,
      runId: 'run_oaf012_delta_b',
      previousManifest: first.manifest,
      clock: () => fixedNow
    }
  );

  assert.equal(second.manifest.deltaFrom.manifestId, first.manifest.id);
  assert.equal(second.manifest.deltaFrom.etag, first.manifest.etag);
  assert(second.manifest.deltaFrom.unchangedRecordIds.includes('policy_manifest'));
  assert(second.manifest.deltaFrom.changedRecordIds.includes('artifact_manifest_large'));
  assert(second.manifest.deltaFrom.addedRecordIds.includes('artifact_manifest_new'));
  assert(second.manifest.deltaFrom.removedRecordIds.includes('procedure_manifest_locator'));
  assert.equal(second.manifest.deltaFrom.assemblyChanged, true);
  assert.deepEqual(second.manifest.tokenAccounting.delta, {
    unchangedRecordCount: second.manifest.deltaFrom.unchangedRecordIds.length,
    addedRecordCount: second.manifest.deltaFrom.addedRecordIds.length,
    removedRecordCount: second.manifest.deltaFrom.removedRecordIds.length,
    changedRecordCount: second.manifest.deltaFrom.changedRecordIds.length
  });
  assert.equal(verifyContextManifest(second.manifest).valid, true);
});

test('durable manifests sanitize local source paths and preserve legacy assembly schema compatibility', async () => {
  const repository = memoryRepository();
  const result = await compileAndPersistContext(
    request({
      tokenBudget: 180,
      requiredIds: ['artifact_path_locator']
    }),
    records([
      {
        id: 'artifact_path_locator',
        kind: 'artifact',
        workspaceId: 'ws_local',
        text: 'A local source path should never be persisted into assembled model context.',
        tags: ['topic:context-manifest'],
        relations: ['topic:context-manifest'],
        scope: 'workspace-private',
        dataClass: 'workspace-private',
        trustClass: 'trusted',
        status: 'active',
        source: '/private/tmp/oaf-secret/project/.env',
        tokens: 18,
        confidence: 0.9,
        authority: 0.8,
        metadata: {
          contextAssembly: {
            tier: 'locator-only',
            reasonCodes: ['stable_reference']
          }
        }
      }
    ]),
    {
      manifestRepository: repository,
      runId: 'run_oaf012_path_safety',
      clock: () => fixedNow
    }
  );

  const serialized = JSON.stringify(result.manifest);
  assert(!serialized.includes('/private/tmp/oaf-secret'));
  assert(serialized.includes('redacted-source'));
  assert.equal(verifyContextManifest(result.manifest).valid, true);

  const schema = JSON.parse(await readFile(new URL('../packages/protocol/schemas/context-manifest.schema.json', import.meta.url), 'utf8'));
  assert.equal(validateJsonSchema(schema, result.manifest).valid, true);

  const legacy = structuredClone(result.manifest);
  delete legacy.etag;
  delete legacy.deltaFrom;
  legacy.assembly = legacyAssemblyForTest(legacy.selected);
  legacy.budget.used = legacy.assembly.totalTokens;
  legacy.tokenAccounting = {
    selectedTokens: legacy.assembly.totalTokens,
    budgetUsed: legacy.budget.used,
    budgetAvailable: legacy.budget.available
  };
  refreshManifestFingerprintForTest(legacy);

  assert.equal(validateJsonSchema(schema, legacy).valid, true);
  assert.equal(verifyContextManifest(legacy).valid, true);
});

test('manifest deltas treat representation-only assembly changes as changed records', async () => {
  const repository = memoryRepository();
  const baseRecord = {
    id: 'artifact_representation_change',
    kind: 'artifact',
    workspaceId: 'ws_local',
    text: 'Representation-only changes alter assembled model context while preserving the source record body.',
    tags: ['topic:context-manifest'],
    relations: ['topic:context-manifest'],
    scope: 'workspace-private',
    dataClass: 'workspace-private',
    trustClass: 'trusted',
    status: 'active',
    source: 'workspace-artifact',
    tokens: 24,
    confidence: 0.9,
    authority: 0.8
  };
  const first = await compileAndPersistContext(
    request({ tokenBudget: 160, requiredIds: ['artifact_representation_change'] }),
    records([{ ...baseRecord, metadata: { contextAssembly: { tier: 'full', reasonCodes: ['full_context_required'] } } }]),
    {
      manifestRepository: repository,
      runId: 'run_oaf012_rep_delta_a',
      clock: () => fixedNow
    }
  );
  const second = await compileAndPersistContext(
    request({ id: 'ctxreq_oaf012_rep_delta', requestId: 'ctxreq_oaf012_rep_delta', tokenBudget: 160, requiredIds: ['artifact_representation_change'] }),
    records([{ ...baseRecord, metadata: { contextAssembly: { tier: 'locator-only', reasonCodes: ['stable_reference'] } } }]),
    {
      manifestRepository: repository,
      runId: 'run_oaf012_rep_delta_b',
      previousManifest: first.manifest,
      clock: () => fixedNow
    }
  );

  assert(second.manifest.deltaFrom.changedRecordIds.includes('artifact_representation_change'));
  assert(!second.manifest.deltaFrom.unchangedRecordIds.includes('artifact_representation_change'));
  assert.equal(second.manifest.deltaFrom.assemblyChanged, true);
  assert.equal(verifyContextManifest(second.manifest).valid, true);
});
