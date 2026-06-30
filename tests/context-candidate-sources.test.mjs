import test from 'node:test';
import assert from 'node:assert/strict';
import { createPolicyService } from '../packages/policy/src/index.mjs';
import {
  compileContext,
  compileContextFromSources,
  createCandidateSourceRegistry,
  createFixtureRecordReader,
  createNativeExactCandidateSource,
  createNativeLexicalCandidateSource,
  generateContextCandidates
} from '../packages/context-compiler/src/index.mjs';

const fixedNow = '2026-06-19T10:00:00.000Z';

function request(overrides = {}) {
  return {
    schemaVersion: '1.0.0',
    requestId: 'ccreq_test',
    correlationId: 'req_candidate-sources-000000',
    workspaceId: 'ws_local',
    actorId: 'usr_owner',
    taskId: 'task_oaf_010',
    step: 'assemble context for policy evidence',
    objective: 'Find context manifest policy evidence',
    requiredIds: [],
    requiredEntities: ['context-manifest'],
    allowedDataClasses: ['public', 'workspace-private'],
    allowedTrustClasses: ['verified', 'trusted', 'observed'],
    perSourceLimit: 5,
    totalCandidateLimit: 8,
    trustedTimestamp: fixedNow,
    tokenBudget: 80,
    ...overrides
  };
}

function trustedContext(overrides = {}) {
  return {
    principal: {
      userId: 'usr_owner',
      principalType: 'user',
      authenticationMethod: 'session',
      status: 'active'
    },
    membership: {
      workspaceId: 'ws_local',
      role: 'owner',
      status: 'active'
    },
    environment: {
      deploymentProfile: 'local-dev',
      locality: 'local-only',
      interactive: true,
      externalWritesEnabled: false
    },
    ...overrides
  };
}

function records() {
  return [
    {
      id: 'mem_required',
      version: 'v1',
      kind: 'policy',
      workspaceId: 'ws_local',
      text: 'Every model call records a context manifest with selected and excluded records.',
      tags: ['context-manifest'],
      relations: ['context-manifest'],
      source: 'fixture',
      dataClass: 'workspace-private',
      scope: 'workspace-private',
      trustClass: 'verified',
      confidence: 0.91,
      authority: 0.9,
      updatedAt: fixedNow
    },
    {
      id: 'mem_lexical',
      version: 'v1',
      kind: 'evidence',
      workspaceId: 'ws_local',
      text: 'Policy evidence for context compilation keeps provenance and access decisions.',
      tags: ['policy', 'context-manifest'],
      relations: ['context-manifest'],
      source: 'fixture',
      dataClass: 'workspace-private',
      scope: 'workspace-private',
      trustClass: 'observed',
      confidence: 0.8,
      authority: 0.72,
      updatedAt: fixedNow
    },
    {
      id: 'mem_secret',
      version: 'v1',
      kind: 'secret',
      workspaceId: 'ws_local',
      text: 'Raw private token should not become model context.',
      source: 'fixture',
      dataClass: 'secret',
      scope: 'workspace-private',
      trustClass: 'trusted',
      confidence: 1,
      authority: 1,
      updatedAt: fixedNow
    },
    {
      id: 'mem_other_workspace',
      version: 'v1',
      kind: 'evidence',
      workspaceId: 'ws_other',
      text: 'Other workspace context manifest evidence.',
      tags: ['context-manifest'],
      source: 'fixture',
      dataClass: 'workspace-private',
      scope: 'workspace-private',
      trustClass: 'observed',
      updatedAt: fixedNow
    }
  ];
}

function registry(sourceOverrides = []) {
  return createCandidateSourceRegistry([
    createNativeExactCandidateSource(),
    createNativeLexicalCandidateSource(),
    ...sourceOverrides
  ]);
}

test('exact and lexical sources generate provenance-rich candidates before compiler selection', async () => {
  const result = await generateContextCandidates(request({ requiredIds: ['mem_required'] }), {
    registry: registry(),
    recordReader: createFixtureRecordReader(records()),
    policyService: createPolicyService({ decisionIdFactory: () => 'poldet_candidate_allow', clock: () => fixedNow }),
    trustedContext: trustedContext()
  });

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.reports.map((report) => [report.sourceKind, report.status]), [['exact', 'succeeded'], ['lexical', 'succeeded']]);
  assert.deepEqual(result.candidates.map((candidate) => candidate.record.id), ['mem_lexical', 'mem_required']);

  const required = result.candidates.find((candidate) => candidate.record.id === 'mem_required');
  assert.equal(required.record.workspaceId, 'ws_local');
  assert.equal(required.record.dataClass, 'workspace-private');
  assert.equal(required.hits.length, 2);
  assert(required.hits.some((hit) => hit.sourceId === 'provider:native:context-candidate:exact'));
  assert(required.hits.every((hit) => /^sha256:[a-f0-9]{64}$/.test(hit.queryFingerprint)));
  assert(required.hits.every((hit) => hit.accessDecisionRef === 'poldet_candidate_allow'));
});

test('compileContextFromSources preserves direct compileContext final selection semantics', async () => {
  const sourceResult = await compileContextFromSources(request({ requiredIds: ['mem_required'] }), {
    registry: registry(),
    recordReader: createFixtureRecordReader(records()),
    policyService: createPolicyService({ decisionIdFactory: () => 'poldet_candidate_allow', clock: () => fixedNow }),
    trustedContext: trustedContext()
  });
  const direct = compileContext(request({ id: 'ccreq_test', requiredIds: ['mem_required'] }), sourceResult.candidateGeneration.candidates.map((candidate) => candidate.record));

  assert.equal(sourceResult.manifest.workspaceId, direct.workspaceId);
  assert.deepEqual(sourceResult.manifest.selected.map((item) => item.id), direct.selected.map((item) => item.id));
  assert.deepEqual(sourceResult.manifest.excluded.map((item) => item.id), direct.excluded.map((item) => item.id));
  assert.equal(sourceResult.candidateGeneration.status, 'succeeded');
});

test('registry validates source descriptors and reports unavailable future source kinds', async () => {
  assert.throws(
    () => createCandidateSourceRegistry([createNativeLexicalCandidateSource(), createNativeLexicalCandidateSource()]),
    /duplicate_candidate_source/
  );
  assert.throws(
    () => createCandidateSourceRegistry([{
      descriptor: () => ({
        schemaVersion: '1.0.0',
        id: 'provider:native:context-candidate:bad',
        kind: 'neural',
        version: '1.0.0',
        enabled: true,
        methods: ['fixture']
      }),
      health: async () => ({ status: 'healthy' }),
      query: async () => ({ candidates: [] })
    }]),
    /unknown_candidate_source_kind/
  );

  const result = await generateContextCandidates(request({ sourcePlan: [{ kind: 'lexical', required: false }, { kind: 'vector', required: false }] }), {
    registry: registry(),
    recordReader: createFixtureRecordReader(records()),
    policyService: createPolicyService({ decisionIdFactory: () => 'poldet_candidate_allow', clock: () => fixedNow }),
    trustedContext: trustedContext()
  });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.warnings, ['candidate_source_unavailable']);
  const unavailable = result.reports.find((report) => report.sourceKind === 'vector');
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.failureCode, 'source_unavailable');
});

test('trusted policy denial prevents provider invocation and hides denied exact ids', async () => {
  let invoked = false;
  const deniedSource = {
    descriptor: () => ({
      schemaVersion: '1.0.0',
      id: 'provider:native:context-candidate:denytest',
      kind: 'exact',
      version: '1.0.0',
      enabled: true,
      methods: ['id_lookup']
    }),
    health: async () => ({ status: 'healthy' }),
    query: async () => {
      invoked = true;
      return { candidates: [] };
    }
  };
  const policyService = {
    evaluate: async () => ({
      outcome: 'deny',
      decisionId: 'poldet_denied',
      reasonCodes: ['resource_denied'],
      evaluatedAt: fixedNow,
      policyVersion: '1.0.0'
    })
  };

  await assert.rejects(
    generateContextCandidates(request({ requiredIds: ['mem_secret'], sourcePlan: [{ kind: 'exact', required: true }] }), {
      registry: createCandidateSourceRegistry([deniedSource]),
      recordReader: createFixtureRecordReader(records()),
      policyService,
      trustedContext: trustedContext()
    }),
    /candidate_source_required_denied/
  );
  assert.equal(invoked, false);
});

test('secret records and cross-workspace records are filtered before candidate output', async () => {
  const result = await generateContextCandidates(request({ requiredIds: ['mem_secret', 'mem_other_workspace'] }), {
    registry: registry(),
    recordReader: createFixtureRecordReader(records()),
    policyService: createPolicyService({ decisionIdFactory: () => 'poldet_candidate_allow', clock: () => fixedNow }),
    trustedContext: trustedContext()
  });

  assert.equal(result.status, 'succeeded');
  assert(!result.candidates.some((candidate) => candidate.record.id === 'mem_secret'));
  assert(!result.candidates.some((candidate) => candidate.record.id === 'mem_other_workspace'));
  assert(result.reports.some((report) => report.deniedCount >= 1));
});

test('optional source failure is visible while required source failure fails closed', async () => {
  const failingSource = {
    descriptor: () => ({
      schemaVersion: '1.0.0',
      id: 'provider:native:context-candidate:failing',
      kind: 'temporal',
      version: '1.0.0',
      enabled: true,
      methods: ['window_lookup']
    }),
    health: async () => ({ status: 'healthy' }),
    query: async () => {
      throw new Error('fixture failure');
    }
  };

  const optional = await generateContextCandidates(request({ sourcePlan: [{ kind: 'exact', required: false }, { kind: 'temporal', required: false }] }), {
    registry: registry([failingSource]),
    recordReader: createFixtureRecordReader(records()),
    policyService: createPolicyService({ decisionIdFactory: () => 'poldet_candidate_allow', clock: () => fixedNow }),
    trustedContext: trustedContext()
  });
  assert.equal(optional.status, 'succeeded');
  assert(optional.warnings.includes('candidate_source_failed'));
  assert(optional.reports.some((report) => report.sourceKind === 'temporal' && report.status === 'failed'));

  await assert.rejects(
    generateContextCandidates(request({ sourcePlan: [{ kind: 'temporal', required: true }] }), {
      registry: registry([failingSource]),
      recordReader: createFixtureRecordReader(records()),
      policyService: createPolicyService({ decisionIdFactory: () => 'poldet_candidate_allow', clock: () => fixedNow }),
      trustedContext: trustedContext()
    }),
    /candidate_source_required_failed/
  );
});

test('candidate union merges same identity hits and fails closed on hash conflicts', async () => {
  const duplicateSource = {
    descriptor: () => ({
      schemaVersion: '1.0.0',
      id: 'provider:native:context-candidate:duplicate',
      kind: 'temporal',
      version: '1.0.0',
      enabled: true,
      methods: ['fixture']
    }),
    health: async () => ({ status: 'healthy' }),
    query: async (_request, context) => ({
      candidates: [
        {
          record: records()[0],
          sourceHit: {
            sourceId: 'provider:native:context-candidate:duplicate',
            sourceKind: 'temporal',
            sourceVersion: '1.0.0',
            retrievalMethod: 'fixture',
            localRank: 1,
            localScore: 0.8,
            reasonCodes: ['fixture_match'],
            queryFingerprint: context.queryFingerprint,
            accessDecisionRef: context.accessDecisionRef,
            retrievedAt: fixedNow
          }
        }
      ]
    })
  };
  const merged = await generateContextCandidates(request({ requiredIds: ['mem_required'], sourcePlan: [{ kind: 'exact', required: true }, { kind: 'temporal', required: false }] }), {
    registry: registry([duplicateSource]),
    recordReader: createFixtureRecordReader(records()),
    policyService: createPolicyService({ decisionIdFactory: () => 'poldet_candidate_allow', clock: () => fixedNow }),
    trustedContext: trustedContext()
  });
  assert.equal(merged.candidates.filter((candidate) => candidate.record.id === 'mem_required').length, 1);
  assert.equal(merged.candidates.find((candidate) => candidate.record.id === 'mem_required').hits.length, 2);

  const conflictingSource = {
    ...duplicateSource,
    descriptor: () => ({ ...duplicateSource.descriptor(), id: 'provider:native:context-candidate:conflict' }),
    query: async (_request, context) => ({
      candidates: [
        {
          record: { ...records()[0], version: 'v2', text: `${records()[0].text} changed` },
          sourceHit: { ...((await duplicateSource.query(_request, context)).candidates[0].sourceHit), sourceId: 'provider:native:context-candidate:conflict' }
        }
      ]
    })
  };
  await assert.rejects(
    generateContextCandidates(request({ requiredIds: ['mem_required'], sourcePlan: [{ kind: 'exact', required: true }, { kind: 'temporal', required: false }] }), {
      registry: registry([conflictingSource]),
      recordReader: createFixtureRecordReader(records()),
      policyService: createPolicyService({ decisionIdFactory: () => 'poldet_candidate_allow', clock: () => fixedNow }),
      trustedContext: trustedContext()
    }),
    /candidate_identity_conflict/
  );

  const forgedHashSource = {
    ...duplicateSource,
    descriptor: () => ({ ...duplicateSource.descriptor(), id: 'provider:native:context-candidate:forged-hash' }),
    query: async (_request, context) => ({
      candidates: [
        {
          record: {
            ...records()[0],
            text: `${records()[0].text} altered with a stale declared hash`,
            contentHash: `sha256:${'a'.repeat(64)}`
          },
          sourceHit: { ...((await duplicateSource.query(_request, context)).candidates[0].sourceHit), sourceId: 'provider:native:context-candidate:forged-hash' }
        }
      ]
    })
  };
  const forgedReader = createFixtureRecordReader(records().map((record) => record.id === 'mem_required'
    ? { ...record, contentHash: `sha256:${'a'.repeat(64)}` }
    : record));
  await assert.rejects(
    generateContextCandidates(request({ requiredIds: ['mem_required'], sourcePlan: [{ kind: 'exact', required: true }, { kind: 'temporal', required: false }] }), {
      registry: registry([forgedHashSource]),
      recordReader: forgedReader,
      policyService: createPolicyService({ decisionIdFactory: () => 'poldet_candidate_allow', clock: () => fixedNow }),
      trustedContext: trustedContext()
    }),
    /candidate_identity_conflict/
  );
});

test('invalid optional source batches do not leak earlier candidates', async () => {
  const batchSource = {
    descriptor: () => ({
      schemaVersion: '1.0.0',
      id: 'provider:native:context-candidate:batch',
      kind: 'temporal',
      version: '1.0.0',
      enabled: true,
      methods: ['fixture']
    }),
    health: async () => ({ status: 'healthy' }),
    query: async (_request, context) => ({
      candidates: [
        {
          record: {
            id: 'mem_batch',
            version: 'v1',
            kind: 'evidence',
            workspaceId: 'ws_local',
            text: 'Valid candidate that must be discarded with the bad batch.',
            dataClass: 'workspace-private',
            trustClass: 'observed',
            source: 'fixture'
          },
          sourceHit: {
            sourceId: 'provider:native:context-candidate:batch',
            sourceKind: 'temporal',
            sourceVersion: '1.0.0',
            retrievalMethod: 'fixture',
            localRank: 1,
            localScore: 0.8,
            reasonCodes: ['fixture_match'],
            queryFingerprint: context.queryFingerprint,
            accessDecisionRef: context.accessDecisionRef,
            retrievedAt: fixedNow
          }
        },
        { record: { kind: 'evidence', text: 'missing id' } }
      ]
    })
  };

  const result = await generateContextCandidates(request({ sourcePlan: [{ kind: 'lexical', required: false }, { kind: 'temporal', required: false }] }), {
    registry: registry([batchSource]),
    recordReader: createFixtureRecordReader(records()),
    policyService: createPolicyService({ decisionIdFactory: () => 'poldet_candidate_allow', clock: () => fixedNow }),
    trustedContext: trustedContext()
  });

  assert.equal(result.reports.find((report) => report.sourceKind === 'temporal').status, 'invalid_output');
  assert.equal(result.candidates.some((candidate) => candidate.record.id === 'mem_batch'), false);
});

test('request validation rejects client supplied authority and malformed source plans', async () => {
  await assert.rejects(
    generateContextCandidates(request({ roles: ['owner'] }), {
      registry: registry(),
      recordReader: createFixtureRecordReader(records()),
      trustedContext: trustedContext()
    }),
    /unknown_field/
  );
  await assert.rejects(
    generateContextCandidates(request({ sourcePlan: [{ kind: 'exact', required: true }, { kind: 'exact', required: false }] }), {
      registry: registry(),
      recordReader: createFixtureRecordReader(records()),
      trustedContext: trustedContext()
    }),
    /duplicate_source_kind/
  );
  await assert.rejects(
    generateContextCandidates(request({ requiredIds: ['mem_required'], sourcePlan: [{ kind: 'lexical', required: false }] }), {
      registry: registry(),
      recordReader: createFixtureRecordReader(records()),
      trustedContext: trustedContext()
    }),
    /required_ids_require_exact_source/
  );
  await assert.rejects(
    generateContextCandidates(request({ perSourceLimit: 0 }), {
      registry: registry(),
      recordReader: createFixtureRecordReader(records()),
      trustedContext: trustedContext()
    }),
    /positive_integer/
  );
});
