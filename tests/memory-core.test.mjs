import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activateMemory,
  evaluateMemoryWrite,
  expireMemory,
  exportMemoryRecords,
  proposeMemory,
  rejectMemory,
  retractMemory,
  supersedeMemory,
  verifyMemory
} from '../packages/memory-core/src/index.mjs';

const now = '2026-06-20T00:00:00.000Z';

test('preferences from model output require confirmation and cannot silently activate', () => {
  const proposal = proposeMemory({
    id: 'mem_pref_model',
    kind: 'preference',
    text: 'Prefer blue.',
    source: 'model-output',
    sourceTrust: 'unverified',
    now
  });

  assert.equal(proposal.decision, 'review');
  assert.equal(proposal.status, 'proposed');
  assert(proposal.reasons.includes('user_confirmation_required'));
  assert.throws(() => activateMemory(proposal, { activatedAt: now, activatedBy: 'system' }), /verified or user-confirmed/);

  const verified = verifyMemory(proposal, {
    verifiedAt: now,
    verifiedBy: 'usr_reviewer',
    evidenceIds: ['obs_pref']
  });
  const active = activateMemory(verified, { activatedAt: now, activatedBy: 'usr_reviewer' });
  assert.equal(active.status, 'active');
  assert.equal(active.activatedBy, 'usr_reviewer');
  assert.equal(active.lifecycle[0].type, 'memory.proposed');
  assert.equal(active.lifecycle.at(-1).type, 'memory.activated');
});

test('verified facts can activate only after deterministic source verification', () => {
  const unverified = proposeMemory({
    id: 'mem_fact_unverified',
    kind: 'fact',
    text: 'The external service changed its policy.',
    source: 'external-page',
    sourceTrust: 'unverified',
    now
  });
  assert.equal(unverified.decision, 'review');
  assert(unverified.reasons.includes('source_verification_required'));
  assert.throws(() => activateMemory(unverified, { activatedAt: now, activatedBy: 'system' }), /verified or user-confirmed/);

  const verifiedProposal = proposeMemory({
    id: 'mem_fact_verified',
    kind: 'fact',
    text: 'The migration recovery test passed.',
    source: 'evidence:obs_1',
    sourceTrust: 'verified',
    now
  });
  const verified = verifyMemory(verifiedProposal, {
    verifiedAt: now,
    verifiedBy: 'agent:researcher',
    evidenceIds: ['obs_1']
  });
  assert.equal(activateMemory(verified, { activatedAt: now, activatedBy: 'agent:researcher' }).status, 'active');
});

test('likely secrets are quarantined and redacted before persistence or export', () => {
  const result = proposeMemory({
    id: 'mem_secret',
    kind: 'episode',
    text: 'BEGIN RSA PRIVATE KEY',
    source: 'tool-output',
    now
  });

  assert.equal(result.decision, 'reject');
  assert.equal(result.status, 'quarantined');
  assert.equal(result.text, '[redacted-secret]');
  assert.equal(result.dataClass, 'secret');
  assert(result.reasons.includes('possible_secret'));
  assert.throws(() => activateMemory(result, { activatedAt: now, activatedBy: 'system' }), /quarantined|rejected/);
  assert.deepEqual(exportMemoryRecords([result], { exportedAt: now }).records, []);
});

test('duplicates and conflicts require explicit review instead of silent overwrite', () => {
  const active = activateMemory(verifyMemory(proposeMemory({
    id: 'mem_active',
    kind: 'fact',
    text: 'The launch date is July 1.',
    source: 'evidence:obs_launch',
    sourceTrust: 'verified',
    metadata: { subject: 'launch', predicate: 'date' },
    now
  }), { verifiedAt: now, verifiedBy: 'usr_reviewer', evidenceIds: ['obs_launch'] }), { activatedAt: now, activatedBy: 'usr_reviewer' });

  const duplicate = evaluateMemoryWrite({
    kind: 'fact',
    text: 'The launch date is July 1.',
    source: 'evidence:obs_launch_2',
    sourceTrust: 'verified',
    now
  }, { existingRecords: [active] });
  assert.equal(duplicate.decision, 'review');
  assert(duplicate.reasons.includes('duplicate_memory'));

  const conflict = evaluateMemoryWrite({
    kind: 'fact',
    text: 'The launch date is August 1.',
    source: 'evidence:obs_launch_3',
    sourceTrust: 'verified',
    metadata: { subject: 'launch', predicate: 'date' },
    now
  }, { existingRecords: [active] });
  assert.equal(conflict.decision, 'review');
  assert(conflict.reasons.includes('conflicting_memory'));
  assert.equal(conflict.conflicts[0].existingId, 'mem_active');
});

test('supersession, rejection, retraction, and expiry are versioned lifecycle changes', () => {
  const active = activateMemory(verifyMemory(proposeMemory({
    id: 'mem_old',
    kind: 'preference',
    text: 'Use long reports.',
    source: 'user-confirmed',
    now
  }), { verifiedAt: now, verifiedBy: 'usr_reviewer', evidenceIds: ['obs_old'] }), { activatedAt: now, activatedBy: 'usr_reviewer' });

  const { previous, replacement } = supersedeMemory(active, {
    id: 'mem_new',
    text: 'Use focused reports.',
    source: 'user-confirmed',
    supersededAt: now,
    supersededBy: 'usr_reviewer'
  });
  assert.equal(previous.status, 'superseded');
  assert.equal(replacement.status, 'active');
  assert.equal(replacement.supersedes, 'mem_old');

  const rejected = rejectMemory(proposeMemory({ id: 'mem_reject', kind: 'episode', text: 'not durable', source: 'run', now }), {
    rejectedAt: now,
    rejectedBy: 'usr_reviewer',
    reason: 'not durable'
  });
  assert.equal(rejected.status, 'rejected');

  assert.equal(retractMemory(replacement, { retractedAt: now, retractedBy: 'usr_reviewer', reason: 'user request' }).status, 'retracted');
  assert.equal(expireMemory(active, { expiredAt: now, reason: 'retention elapsed' }).status, 'expired');
});

test('exports preserve classifications and exclude inactive records by default', () => {
  const active = activateMemory(verifyMemory(proposeMemory({
    id: 'mem_export_active',
    kind: 'episode',
    text: 'The run recovered after retry.',
    source: 'run:verified',
    sourceTrust: 'verified',
    dataClass: 'workspace-private',
    now
  }), { verifiedAt: now, verifiedBy: 'agent:evaluator', evidenceIds: ['obs_retry'] }), { activatedAt: now, activatedBy: 'agent:evaluator' });
  const expired = expireMemory(active, { id: 'mem_export_expired', expiredAt: now, reason: 'retention elapsed' });

  const exported = exportMemoryRecords([active, expired], { exportedAt: now });
  assert.deepEqual(exported.records.map((record) => record.id), ['mem_export_active']);
  assert.equal(exported.records[0].dataClass, 'workspace-private');
  assert.equal(JSON.stringify(exported).includes('BEGIN RSA PRIVATE KEY'), false);

  const withInactive = exportMemoryRecords([active, expired], { exportedAt: now, includeInactive: true });
  assert.deepEqual(withInactive.records.map((record) => record.status), ['active', 'expired']);
});
