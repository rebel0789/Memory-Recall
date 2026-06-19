import { createHash } from 'node:crypto';
import { prefixedId, nowIso, assertPlainObject } from '../../protocol/src/index.mjs';

const MODES = new Set(['exact', 'alternate-model', 'alternate-context', 'fork-from-step', 'shadow']);

function sortedUnique(values) {
  return [...new Set((values ?? []).map(String))].sort();
}

function stableHash(value) {
  const normalize = (item) => Array.isArray(item) ? item.map(normalize) : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, normalize(item[key])])) : item;
  return `sha256:${createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex')}`;
}

export function createReplayPlan(input) {
  assertPlainObject(input, 'replay request');
  for (const key of ['workspaceId', 'sourceRunId', 'mode', 'reason']) if (typeof input[key] !== 'string' || !input[key]) throw new Error(`${key} is required`);
  if (!MODES.has(input.mode)) throw new Error(`unsupported replay mode: ${input.mode}`);
  if (input.sideEffects !== undefined && input.sideEffects !== 'disabled') throw new Error('replay side effects must be disabled');
  if (input.mode === 'alternate-model' && (!input.modelOverrides || !Object.keys(input.modelOverrides).length)) throw new Error('alternate-model replay requires modelOverrides');
  if (input.mode === 'alternate-context' && !input.contextPolicyOverride) throw new Error('alternate-context replay requires contextPolicyOverride');
  if (input.mode === 'fork-from-step' && !input.forkStepId) throw new Error('fork-from-step replay requires forkStepId');
  const plan = {
    schemaVersion: '1.0.0',
    id: prefixedId('replay'),
    workspaceId: input.workspaceId,
    sourceRunId: input.sourceRunId,
    mode: input.mode,
    sideEffects: 'disabled',
    approvalsReusable: false,
    modelOverrides: input.modelOverrides ?? {},
    contextPolicyOverride: input.contextPolicyOverride ?? null,
    forkStepId: input.forkStepId ?? null,
    reason: input.reason,
    createdAt: nowIso()
  };
  plan.fingerprint = stableHash({ ...plan, id: undefined, createdAt: undefined });
  return plan;
}

export function compareRunRecords(baseline, candidate) {
  assertPlainObject(baseline, 'baseline run');
  assertPlainObject(candidate, 'candidate run');
  const selected = (run) => sortedUnique(run.contextManifest?.selected?.map((item) => item.id));
  const excluded = (run) => sortedUnique(run.contextManifest?.excluded?.map((item) => item.id));
  const eventTypes = (run) => (run.events ?? []).map((event) => event.type);
  const artifactHashes = (run) => sortedUnique((run.artifacts ?? []).map((artifact) => artifact.hash ?? artifact.contentHash).filter(Boolean));
  const difference = (left, right) => ({ added: right.filter((item) => !left.includes(item)), removed: left.filter((item) => !right.includes(item)) });
  const baselineSelected = selected(baseline), candidateSelected = selected(candidate);
  const baselineExcluded = excluded(baseline), candidateExcluded = excluded(candidate);
  return {
    schemaVersion: '1.0.0',
    baselineRunId: baseline.id,
    candidateRunId: candidate.id,
    statusChanged: baseline.status !== candidate.status,
    status: { baseline: baseline.status ?? null, candidate: candidate.status ?? null },
    context: {
      selected: difference(baselineSelected, candidateSelected),
      excluded: difference(baselineExcluded, candidateExcluded),
      tokenDelta: Number(candidate.contextManifest?.budget?.used ?? 0) - Number(baseline.contextManifest?.budget?.used ?? 0)
    },
    events: {
      baseline: eventTypes(baseline),
      candidate: eventTypes(candidate),
      identicalSequence: JSON.stringify(eventTypes(baseline)) === JSON.stringify(eventTypes(candidate))
    },
    artifacts: difference(artifactHashes(baseline), artifactHashes(candidate)),
    evaluations: {
      baseline: baseline.evaluations ?? [],
      candidate: candidate.evaluations ?? []
    },
    comparedAt: nowIso()
  };
}

export function createLearningProposal(input) {
  assertPlainObject(input, 'learning proposal');
  for (const key of ['workspaceId', 'observedFailure', 'expectedBenefit', 'rollout', 'rollback']) if (typeof input[key] !== 'string' || !input[key]) throw new Error(`${key} is required`);
  if (!Array.isArray(input.evidenceIds) || !input.evidenceIds.length) throw new Error('evidenceIds must be a non-empty array');
  if (!input.proposedChange || typeof input.proposedChange !== 'object' || Array.isArray(input.proposedChange)) throw new Error('proposedChange must be an object');
  if (!Array.isArray(input.affectedComponents) || !input.affectedComponents.length) throw new Error('affectedComponents must be a non-empty array');
  if (!Array.isArray(input.regressionTests) || !input.regressionTests.length) throw new Error('regressionTests must be a non-empty array');
  return {
    schemaVersion: '1.0.0',
    id: prefixedId('learn'),
    workspaceId: input.workspaceId,
    status: 'proposed',
    observedFailure: input.observedFailure,
    evidenceIds: sortedUnique(input.evidenceIds),
    proposedChange: structuredClone(input.proposedChange),
    expectedBenefit: input.expectedBenefit,
    affectedComponents: sortedUnique(input.affectedComponents),
    regressionTests: sortedUnique(input.regressionTests),
    rollout: input.rollout,
    rollback: input.rollback,
    createdAt: nowIso()
  };
}
