import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CONTEXT_SELECTION_POLICY,
  compileContext,
  compileContextFromSources,
  contextSelectionPolicyFingerprint,
  createCandidateSourceRegistry,
  createFixtureRecordReader,
  createNativeExactCandidateSource,
  createNativeLexicalCandidateSource,
  selectContextCandidates,
  validateContextSelectionPolicy
} from '../packages/context-compiler/src/index.mjs';
import { createPolicyService } from '../packages/policy/src/index.mjs';
import { validateJsonSchema } from '../packages/protocol/src/schema-validator.mjs';

const fixedNow = '2026-06-19T10:00:00.000Z';
const contextManifestSchema = JSON.parse(readFileSync('packages/protocol/schemas/context-manifest.schema.json', 'utf8'));

function request(overrides = {}) {
  return {
    schemaVersion: '1.0.0',
    id: 'ctxreq_selection',
    requestId: 'ctxreq_selection',
    correlationId: 'req_selection_000000',
    workspaceId: 'ws_local',
    actorId: 'usr_owner',
    taskId: 'task_oaf_011',
    step: 'answer policy incident',
    objective: 'Find authentication context manifest evidence',
    requiredIds: [],
    requiredEntities: ['topic:auth'],
    allowedScopes: ['workspace-private'],
    allowedDataClasses: ['workspace-private', 'public'],
    allowedTrustClasses: ['verified', 'trusted', 'observed'],
    tokenBudget: 80,
    now: fixedNow,
    trustedTimestamp: fixedNow,
    ...overrides
  };
}

function record(overrides = {}) {
  return {
    id: 'mem_auth',
    version: 'v1',
    kind: 'observation',
    workspaceId: 'ws_local',
    text: 'Authentication failure occurred after the session expired.',
    tags: ['topic:auth'],
    relations: ['topic:auth'],
    scope: 'workspace-private',
    dataClass: 'workspace-private',
    trustClass: 'observed',
    status: 'active',
    source: 'fixture',
    tokens: 12,
    confidence: 0.75,
    authority: 0.7,
    updatedAt: fixedNow,
    ...overrides
  };
}

function candidate(recordOverrides, hitOverrides = {}) {
  const sourceKind = hitOverrides.sourceKind ?? 'lexical';
  const sourceId = hitOverrides.sourceId ?? `provider:native:context-candidate:${sourceKind}`;
  return {
    schemaVersion: '1.0.0',
    record: record(recordOverrides),
    hits: [
      {
        sourceId,
        sourceKind,
        sourceVersion: '1.0.0',
        retrievalMethod: sourceKind === 'exact' ? 'id_lookup' : 'term_overlap',
        localRank: hitOverrides.localRank ?? 1,
        localScore: hitOverrides.localScore ?? 0.5,
        reasonCodes: [sourceKind === 'exact' ? 'exact_id_match' : 'lexical_match'],
        queryFingerprint: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        accessDecisionRef: 'poldet_candidate_allow',
        retrievedAt: fixedNow,
        ...hitOverrides
      }
    ]
  };
}

function selectedIds(result) {
  return result.manifest.selected.map((item) => item.id);
}

test('selection policy is strict, versioned, and deterministically fingerprinted', () => {
  const validated = validateContextSelectionPolicy(CONTEXT_SELECTION_POLICY);
  assert.equal(validated.policyVersion, '1.0.0');
  assert.match(contextSelectionPolicyFingerprint(), /^sha256:[a-f0-9]{64}$/);
  assert.equal(contextSelectionPolicyFingerprint(), contextSelectionPolicyFingerprint(CONTEXT_SELECTION_POLICY));
  assert.throws(
    () => validateContextSelectionPolicy({ ...CONTEXT_SELECTION_POLICY, sourceWeights: { ...CONTEXT_SELECTION_POLICY.sourceWeights, lexical: -1 } }),
    /selection_policy_invalid/
  );
  assert.throws(
    () => validateContextSelectionPolicy({ ...CONTEXT_SELECTION_POLICY, untrustedWeight: 1 }),
    /unknown_field/
  );
});

test('compiled selection manifest remains schema compatible', () => {
  const manifest = compileContext(request({ requiredIds: ['policy_auth'], requiredEntities: [], tokenBudget: 80 }), [
    record({ id: 'policy_auth', kind: 'policy', text: 'Cite authentication evidence.', tokens: 8 }),
    record({ id: 'evidence_auth', kind: 'observation', text: 'Session expiry caused the authentication failure.', tokens: 12 }),
    record({ id: 'evidence_retry', kind: 'observation', text: 'Retry with a refreshed session resolved the failure.', tokens: 12 })
  ]);

  const validation = validateJsonSchema(contextManifestSchema, manifest);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  assert.equal(Number.isInteger(manifest.selected[0].order), true);
  assert.equal(typeof manifest.selected[0].category, 'string');
});

test('required records are hard requirements and fail closed when unresolved or over budget', () => {
  const ok = compileContext(request({ requiredIds: ['decision_auth'], tokenBudget: 40 }), [
    record({ id: 'decision_auth', kind: 'decision', text: 'Use passkeys for authentication.', tokens: 12 }),
    record({ id: 'obs_auth', text: 'Authentication failure evidence.', tokens: 12 })
  ]);
  assert.deepEqual(selectedIds({ manifest: ok }).slice(0, 1), ['decision_auth']);
  assert(ok.selection.sufficiency.requiredIds.resolved.includes('decision_auth'));

  assert.throws(
    () => compileContext(request({ requiredIds: ['decision_missing'] }), [record({ id: 'obs_auth' })]),
    /required_context_unresolved/
  );
  assert.throws(
    () => compileContext(request({ requiredIds: ['decision_auth'], tokenBudget: 10 }), [
      record({ id: 'decision_auth', kind: 'decision', text: 'Use passkeys for authentication.', tokens: 20 })
    ]),
    /required_context_over_budget/
  );
});

test('weighted rank fusion is deterministic and ignores arbitrary provider score scale', () => {
  const multiSource = candidate(
    { id: 'obs_multi', text: 'Authentication context manifest evidence links the failure to session expiry.', tags: ['topic:auth'], tokens: 12 },
    { sourceKind: 'lexical', localRank: 2, localScore: 0.01 }
  );
  multiSource.hits.push({
    ...multiSource.hits[0],
    sourceId: 'provider:native:context-candidate:temporal',
    sourceKind: 'temporal',
    retrievalMethod: 'fixture',
    localRank: 1,
    localScore: 999
  });
  const arbitraryScore = candidate(
    { id: 'obs_score_only', text: 'Unrelated cooking note.', tags: [], relations: [], tokens: 12 },
    { sourceKind: 'lexical', localRank: 4, localScore: 999 }
  );
  const first = selectContextCandidates(request({ tokenBudget: 50 }), [arbitraryScore, multiSource]);
  const second = selectContextCandidates(request({ tokenBudget: 50 }), [multiSource, arbitraryScore]);

  assert.deepEqual(selectedIds(first), selectedIds(second));
  assert(selectedIds(first).includes('obs_multi'));
  assert(!selectedIds(first).includes('obs_score_only'));
  const breakdown = first.selection.scoreBreakdowns.find((item) => item.id === 'obs_multi');
  assert.equal(breakdown.fusion.contributions.length, 2);
  assert(breakdown.fusion.contributions.every((item) => Number.isFinite(item.contribution)));
});

test('diversity, category caps, and smallest-sufficient stopping prefer complementary evidence', () => {
  const candidates = [
    candidate({ id: 'obs_auth_a', text: 'Authentication failure happened after session expiry in the local agent.', tags: ['topic:auth'], tokens: 12 }, { localRank: 1 }),
    candidate({ id: 'obs_auth_b', text: 'Authentication failure happened after session expiry in the local agent.', tags: ['topic:auth'], tokens: 12 }, { localRank: 2 }),
    candidate({ id: 'obs_auth_c', text: 'The login trace shows token refresh failed during authentication.', tags: ['topic:auth'], tokens: 12 }, { localRank: 3 }),
    candidate({ id: 'obs_unrelated', text: 'A recipe for roasted tomatoes.', tags: [], relations: [], tokens: 12 }, { localRank: 4 })
  ];
  const result = selectContextCandidates(request({ tokenBudget: 80 }), candidates);
  const ids = selectedIds(result);

  assert(ids.includes('obs_auth_a'));
  assert(ids.includes('obs_auth_c'));
  assert(!ids.includes('obs_auth_b'));
  assert(!ids.includes('obs_unrelated'));
  assert(result.manifest.excluded.some((item) => item.id === 'obs_auth_b' && item.reasonCodes.includes('redundant')));
  assert(result.manifest.budget.used < 80);
  assert.equal(result.selection.sufficiency.state, 'sufficient');
  assert.equal(result.selection.categoryBudgets.evidence.cap, CONTEXT_SELECTION_POLICY.categoryBudgets.evidence.cap);
  assert.equal(result.selection.categoryBudgets.evidence.softReserveTokens, 28);
  assert.equal(result.selection.categoryBudgets.evidence.selectedCount, 2);
});

test('sufficiency requires the configured minimum evidence count', () => {
  const result = selectContextCandidates(request({ requiredEntities: [], tokenBudget: 80 }), [
    candidate({ id: 'decision_auth', kind: 'decision', text: 'Use passkeys for authentication.', tags: ['topic:auth'], relations: ['topic:auth'], tokens: 12 }),
    candidate({ id: 'procedure_auth', kind: 'procedure', text: 'Rotate authentication sessions after policy updates.', tags: ['topic:auth'], relations: ['topic:auth'], tokens: 12 })
  ]);

  assert.equal(result.selection.sufficiency.evidenceCount, 0);
  assert.equal(result.selection.sufficiency.state, 'insufficient');
});

test('negative-context records use the negative category budget and assembly section', () => {
  const result = selectContextCandidates(request({ requiredIds: ['neg_antipattern'], requiredEntities: [], tokenBudget: 80 }), [
    candidate({ id: 'neg_antipattern', kind: 'negative-context', text: 'Absolute claims about unlimited memory are an anti-pattern.', tags: ['topic:auth'], relations: ['topic:auth'], tokens: 12 }),
    candidate({ id: 'obs_auth', kind: 'observation', text: 'Authentication context manifest evidence after session expiry.', tags: ['topic:auth'], relations: ['topic:auth'], tokens: 12 })
  ]);

  const selected = result.manifest.selected.find((item) => item.id === 'neg_antipattern');
  assert.equal(selected.category, 'negative');
  assert.equal(result.selection.categoryBudgets.negative.selectedCount, 1);
});

test('eligibility remains fail closed before scoring optional candidates', () => {
  const result = selectContextCandidates(request({ tokenBudget: 80 }), [
    candidate({ id: 'obs_valid', text: 'Authentication context manifest evidence.', tags: ['topic:auth'] }),
    candidate({ id: 'obs_other_ws', workspaceId: 'ws_other', text: 'Authentication evidence in another workspace.', tags: ['topic:auth'] }),
    candidate({ id: 'obs_secret', dataClass: 'secret', text: 'Authentication secret token REDACTED_PLACEHOLDER.', tags: ['topic:auth'] }),
    candidate({ id: 'obs_expired', status: 'expired', text: 'Expired authentication evidence.', tags: ['topic:auth'] }),
    candidate({ id: 'obs_retracted', status: 'retracted', text: 'Retracted authentication evidence.', tags: ['topic:auth'] })
  ]);
  const reasons = Object.fromEntries(result.manifest.excluded.map((item) => [item.id, item.reasonCodes]));

  assert(selectedIds(result).includes('obs_valid'));
  assert(reasons.obs_other_ws.includes('workspace_mismatch'));
  assert(reasons.obs_secret.includes('secret_context_denied'));
  assert(reasons.obs_expired.includes('expired'));
  assert(reasons.obs_retracted.includes('retracted'));
});

test('direct and source-based paths share the same selection engine', async () => {
  const records = [
    record({ id: 'decision_auth', kind: 'decision', text: 'Use passkeys for authentication.', tags: ['topic:auth'], tokens: 12 }),
    record({ id: 'obs_auth', text: 'Authentication context manifest evidence after session expiry.', tags: ['topic:auth'], tokens: 12 }),
    record({ id: 'obs_noise', text: 'Unrelated cooking note.', tags: [], relations: [], tokens: 12 })
  ];
  const direct = compileContext(request({ requiredIds: ['decision_auth'], tokenBudget: 50 }), records);
  const source = await compileContextFromSources({
    ...request({ requiredIds: ['decision_auth'], tokenBudget: 50 }),
    schemaVersion: '1.0.0',
    requestId: 'ccreq_selection',
    perSourceLimit: 10,
    totalCandidateLimit: 20
  }, {
    registry: createCandidateSourceRegistry([createNativeExactCandidateSource(), createNativeLexicalCandidateSource()]),
    recordReader: createFixtureRecordReader(records),
    policyService: createPolicyService({ decisionIdFactory: () => 'poldet_candidate_allow', clock: () => fixedNow }),
    trustedContext: {
      principal: { userId: 'usr_owner', principalType: 'user', authenticationMethod: 'session', status: 'active' },
      membership: { workspaceId: 'ws_local', role: 'owner', status: 'active' },
      environment: { deploymentProfile: 'local-dev', locality: 'local-only', interactive: true, externalWritesEnabled: false }
    }
  });

  assert.deepEqual(source.manifest.selected.map((item) => item.id), direct.selected.map((item) => item.id));
  assert.equal(source.selection.selectionPolicyFingerprint, direct.selection.selectionPolicyFingerprint);
  assert.equal(source.candidateGeneration.status, 'succeeded');
});

test('safe selection trace omits raw text, secrets, hidden reasoning, local paths, and SQL', () => {
  const result = selectContextCandidates(request({ tokenBudget: 40 }), [
    candidate({
      id: 'obs_safe',
      text: 'Authentication context manifest evidence mentioning /Users/rebel/.env and SELECT * FROM secrets and REDACTED_PLACEHOLDER.',
      tags: ['topic:auth'],
      tokens: 16
    })
  ]);
  const trace = JSON.stringify(result.selection);

  assert(!trace.includes('/Users/rebel'));
  assert(!trace.includes('REDACTED_PLACEHOLDER'));
  assert(!trace.includes('SELECT *'));
  assert(!trace.includes('hiddenReasoning'));
  assert(!trace.includes('Authentication context manifest evidence mentioning'));
});
