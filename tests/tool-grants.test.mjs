import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ToolGrantService,
  stableToolFingerprint
} from '../packages/tool-registry/src/index.mjs';

const issuedAt = '2026-06-20T00:00:00.000Z';
const binding = Object.freeze({
  actorId: 'usr_grant',
  workspaceId: 'ws_grant',
  runId: 'run_grant',
  stepId: 'step_grant',
  toolId: 'tool:fixture',
  toolVersion: '1.0.0',
  manifestFingerprint: `sha256:${'a'.repeat(64)}`,
  operation: 'read',
  inputFingerprint: `sha256:${'b'.repeat(64)}`,
  effectiveCapabilityFingerprint: `sha256:${'c'.repeat(64)}`,
  policyDecisionId: 'poldet_grant',
  policyVersion: '1.0.0',
  policyFingerprint: `sha256:${'d'.repeat(64)}`,
  operationFingerprint: `sha256:${'e'.repeat(64)}`,
  approvalFingerprint: null,
  idempotencyFingerprint: null
});

test('grant service issues one-use exact-operation grants without retaining raw token material', () => {
  let now = Date.parse(issuedAt);
  const service = new ToolGrantService({
    clock: () => new Date(now).toISOString(),
    randomBytes: (size) => Buffer.alloc(size, 0x42),
    grantIdFactory: () => 'grant_exact'
  });

  const grant = service.issue({ binding, ttlMs: 1000, maxUses: 1 });
  assert.match(grant.token, /^grant_exact\.[a-f0-9]{64}$/);
  assert.equal(grant.record.token, undefined);
  assert.equal(grant.record.secretHash, undefined);
  assert.equal(JSON.stringify(grant.record).includes(grant.token), false);
  assert.equal(service.inspect('grant_exact').tokenHash.startsWith('sha256:'), true);

  const consumed = service.consume(grant.token, binding);
  assert.equal(consumed.status, 'consumed');
  assert.equal(consumed.record.grantId, 'grant_exact');
  assert.equal(service.consume(grant.token, binding).code, 'tool_grant_consumed');

  const changedInput = service.issue({ binding, ttlMs: 1000 }).token;
  assert.equal(service.consume(changedInput, { ...binding, inputFingerprint: stableToolFingerprint({ changed: true }) }).code, 'tool_grant_binding_mismatch');

  const expired = service.issue({ binding, ttlMs: 1000 }).token;
  now += 1001;
  assert.equal(service.consume(expired, binding).code, 'tool_grant_expired');
});

test('grant revocation and process restart invalidate unconsumed grants', () => {
  const service = new ToolGrantService({ randomBytes: (size) => Buffer.alloc(size, 0x24), grantIdFactory: () => 'grant_revoked' });
  const grant = service.issue({ binding, ttlMs: 1000 });
  service.revoke('grant_revoked');
  assert.equal(service.consume(grant.token, binding).code, 'tool_grant_invalid');

  const oldProcess = new ToolGrantService({ randomBytes: (size) => Buffer.alloc(size, 0x35), grantIdFactory: () => 'grant_restart' });
  const restartToken = oldProcess.issue({ binding, ttlMs: 1000 }).token;
  const newProcess = new ToolGrantService({ randomBytes: (size) => Buffer.alloc(size, 0x35), grantIdFactory: () => 'grant_restart' });
  assert.equal(newProcess.consume(restartToken, binding).code, 'tool_grant_invalid');
});
