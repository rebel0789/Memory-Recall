import test from 'node:test';
import assert from 'node:assert/strict';
import {
  POLICY_REGISTRY,
  POLICY_REASON_CODES,
  canonicalOperationFingerprint,
  createPolicyRegistry,
  createPolicyService,
  evaluateContextualPolicy,
  policyFingerprint,
  validatePolicyEvaluationRequest
} from '../packages/policy/src/index.mjs';
import { DeterministicPolicyProvider } from '../providers/native/policy-deterministic/src/index.mjs';
import { ToolRegistry } from '../packages/tool-registry/src/index.mjs';

const fixedNow = '2026-06-19T10:00:00.000Z';

function baseRequest(overrides = {}) {
  return {
    schemaVersion: '1.0.0',
    requestId: 'polreq_test',
    correlationId: 'req_contextual-policy-000000',
    operationId: 'operation:test',
    principal: {
      userId: 'usr_owner',
      principalType: 'user',
      authenticationMethod: 'session',
      status: 'active'
    },
    workspaceId: 'ws_local',
    membership: {
      workspaceId: 'ws_local',
      role: 'owner',
      status: 'active'
    },
    action: 'run.execute',
    resource: {
      type: 'run',
      id: 'run_local',
      workspaceId: 'ws_local',
      dataClass: 'workspace-private'
    },
    environment: {
      deploymentProfile: 'local-dev',
      locality: 'local-only',
      interactive: true,
      externalWritesEnabled: false
    },
    trustedTimestamp: fixedNow,
    ...overrides
  };
}

const readToolManifest = Object.freeze({
  id: 'tool:fixture-read',
  allowedRoles: ['agent:security-auditor'],
  riskClass: 'read-only',
  operations: {
    read: {
      sideEffectClass: 'read-only',
      filesystem: { read: ['workspace:project'], write: [] },
      network: [
        { protocol: 'http', host: 'localhost', port: 4310, methods: ['GET'], consequence: 'read', locality: 'loopback' }
      ],
      secretReferences: ['secret:fixture.read'],
      dataClasses: ['public', 'workspace-private'],
      sandbox: 'read-only',
      limits: { runtimeMs: 1000, outputBytes: 2048, costUnits: 0 }
    }
  }
});

function toolRequest(overrides = {}) {
  return baseRequest({
    action: 'tool.invoke',
    principal: {
      userId: 'usr_owner',
      principalType: 'agent',
      authenticationMethod: 'session',
      status: 'active',
      agentRole: 'agent:security-auditor'
    },
    resource: { type: 'tool', id: readToolManifest.id, workspaceId: 'ws_local', dataClass: 'workspace-private' },
    capabilityRequest: {
      toolId: readToolManifest.id,
      operation: 'read',
      sideEffectClass: 'read-only',
      filesystem: { read: ['workspace:project/src'], write: [] },
      network: [
        { protocol: 'http', host: 'localhost', port: 4310, methods: ['GET'], consequence: 'read', locality: 'loopback' }
      ],
      secretReferences: [],
      dataClasses: ['workspace-private'],
      sandbox: 'read-only',
      limits: { runtimeMs: 500, outputBytes: 1024, costUnits: 0 }
    },
    trustedToolManifest: readToolManifest,
    ...overrides
  });
}

function serverApprovalFor(request, overrides = {}) {
  return {
    approvalId: 'appr_1',
    operationFingerprint: canonicalOperationFingerprint(request),
    workspaceId: request.workspaceId,
    actorId: request.principal.userId,
    approverId: 'usr_owner',
    approvedAt: fixedNow,
    expiresAt: '2026-06-19T11:00:00.000Z',
    status: 'active',
    policyVersion: POLICY_REGISTRY.version,
    serverVerified: true,
    ...overrides
  };
}

function withServerApproval(request, overrides = {}) {
  return {
    ...request,
    approvalContext: serverApprovalFor(request, overrides)
  };
}

test('deterministic policy registry exposes a stable version, fingerprint, and bounded reasons', () => {
  const first = policyFingerprint(POLICY_REGISTRY);
  const second = policyFingerprint(POLICY_REGISTRY);
  assert.match(first, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first, second);
  assert(POLICY_REASON_CODES.includes('external_writes_disabled'));
  assert.throws(
    () => createPolicyRegistry({ version: '1.0.0', unknown: true }),
    /policy_configuration_invalid/
  );
});

test('same trusted input produces the same allow decision and reason ordering', () => {
  const request = baseRequest();
  const one = evaluateContextualPolicy(request, { decisionIdFactory: () => 'poldet_same', clock: () => fixedNow });
  const two = evaluateContextualPolicy(request, { decisionIdFactory: () => 'poldet_same', clock: () => fixedNow });
  assert.equal(one.outcome, 'allow');
  assert.deepEqual(one, two);
  assert.deepEqual(one.reasonCodes, []);
  assert.equal(one.policyFingerprint, policyFingerprint(POLICY_REGISTRY));
});

test('strict request validation rejects unknown fields and secret values before evaluation', () => {
  assert.throws(() => validatePolicyEvaluationRequest({ ...baseRequest(), modelReasoning: 'let me decide' }), /unknown_field/);
  assert.throws(
    () => validatePolicyEvaluationRequest(toolRequest({ capabilityRequest: { ...toolRequest().capabilityRequest, secretValues: ['raw-secret'] } })),
    /secret_value_not_allowed/
  );
});

test('identity, workspace, role, API-token, and resource dimensions default deny', () => {
  const cases = [
    ['missing principal', { principal: null }, ['missing_identity']],
    ['disabled user', { principal: { ...baseRequest().principal, status: 'disabled' } }, ['missing_identity']],
    ['missing workspace', { workspaceId: null }, ['missing_workspace']],
    ['unknown action', { action: 'model.decide.policy' }, ['unknown_action']],
    ['unsupported role', { membership: { workspaceId: 'ws_local', role: 'admin', status: 'active' } }, ['unsupported_role']],
    ['revoked membership', { membership: { workspaceId: 'ws_local', role: 'owner', status: 'revoked' } }, ['membership_required']],
    ['workspace mismatch', { resource: { type: 'run', id: 'run_other', workspaceId: 'ws_other', dataClass: 'workspace-private' } }, ['workspace_mismatch']],
    ['token scope intersection', { principal: { ...baseRequest().principal, authenticationMethod: 'bearer', tokenScopes: ['run.read'], tokenWorkspaceIds: ['ws_local'] } }, ['resource_denied']]
  ];
  for (const [name, overrides, reasons] of cases) {
    const decision = evaluateContextualPolicy(baseRequest(overrides), { decisionIdFactory: () => `poldet_${name.replace(/\W+/g, '_')}`, clock: () => fixedNow });
    assert.equal(decision.outcome, 'deny', name);
    for (const reason of reasons) assert(decision.reasonCodes.includes(reason), name);
  }
});

test('role policy preserves owner, builder, operator, and auditor route authority', () => {
  assert.equal(evaluateContextualPolicy(baseRequest({ membership: { workspaceId: 'ws_local', role: 'owner', status: 'active' } })).outcome, 'allow');
  assert.equal(evaluateContextualPolicy(baseRequest({ membership: { workspaceId: 'ws_local', role: 'builder', status: 'active' } })).outcome, 'allow');
  assert.equal(evaluateContextualPolicy(baseRequest({ membership: { workspaceId: 'ws_local', role: 'operator', status: 'active' } })).outcome, 'allow');
  const auditor = evaluateContextualPolicy(baseRequest({ membership: { workspaceId: 'ws_local', role: 'auditor', status: 'active' } }));
  assert.equal(auditor.outcome, 'deny');
  assert(auditor.reasonCodes.includes('resource_denied'));
});

test('tool manifest intersection denies unregistered, undeclared, wider, injected, and unsafe capabilities', () => {
  const cases = [
    ['unregistered tool', toolRequest({ trustedToolManifest: null }), 'tool_not_registered'],
    ['undeclared operation', toolRequest({ capabilityRequest: { ...toolRequest().capabilityRequest, operation: 'write' } }), 'operation_not_declared'],
    ['filesystem write wider than manifest', toolRequest({ capabilityRequest: { ...toolRequest().capabilityRequest, filesystem: { read: ['workspace:project/src'], write: ['workspace:project'] } } }), 'filesystem_write_denied'],
    ['prefix confusion', toolRequest({ capabilityRequest: { ...toolRequest().capabilityRequest, filesystem: { read: ['workspace:project-evil'], write: [] } } }), 'filesystem_read_denied'],
    ['traversal path', toolRequest({ capabilityRequest: { ...toolRequest().capabilityRequest, filesystem: { read: ['workspace:project/../secret'], write: [] } } }), 'filesystem_read_denied'],
    ['suffix confusion host', toolRequest({ capabilityRequest: { ...toolRequest().capabilityRequest, network: [{ protocol: 'http', host: 'localhost.evil.test', port: 4310, methods: ['GET'], consequence: 'read', locality: 'external' }] } }), 'network_denied'],
    ['disallowed method', toolRequest({ capabilityRequest: { ...toolRequest().capabilityRequest, network: [{ protocol: 'http', host: 'localhost', port: 4310, methods: ['POST'], consequence: 'read', locality: 'loopback' }] } }), 'network_denied'],
    ['disallowed port', toolRequest({ capabilityRequest: { ...toolRequest().capabilityRequest, network: [{ protocol: 'http', host: 'localhost', port: 9999, methods: ['GET'], consequence: 'read', locality: 'loopback' }] } }), 'network_denied'],
    ['secret undeclared', toolRequest({ capabilityRequest: { ...toolRequest().capabilityRequest, secretReferences: ['secret:other.read'] } }), 'secret_scope_denied'],
    ['skill injection ignored', toolRequest({ untrustedInputs: { skillTextCapabilityOverride: { filesystem: { read: ['workspace:project-evil'] } } } }), null],
    ['model output ignored', toolRequest({ untrustedInputs: { modelOutputCapabilityOverride: { network: [{ host: 'evil.test' }] } } }), null],
    ['retrieved content ignored', toolRequest({ untrustedInputs: { retrievedContentCapabilityOverride: { secretReferences: ['secret:other.read'] } } }), null]
  ];
  for (const [name, request, expectedReason] of cases) {
    const decision = evaluateContextualPolicy(request, { decisionIdFactory: () => `poldet_${name.replace(/\W+/g, '_')}`, clock: () => fixedNow });
    if (expectedReason) {
      assert.equal(decision.outcome, 'deny', name);
      assert(decision.reasonCodes.includes(expectedReason), name);
    } else {
      assert.equal(decision.outcome, 'allow', name);
    }
  }
});

test('permitted read-only tool operation returns bounded effective capability', () => {
  const decision = evaluateContextualPolicy(toolRequest(), { decisionIdFactory: () => 'poldet_tool_allow', clock: () => fixedNow });
  assert.equal(decision.outcome, 'allow');
  assert.deepEqual(decision.effectiveCapability.filesystem.read, ['workspace:project/src']);
  assert.deepEqual(decision.effectiveCapability.filesystem.write, []);
  assert.deepEqual(decision.effectiveCapability.limits, { runtimeMs: 500, outputBytes: 1024, costUnits: 0 });
});

test('data-class, risk, approval, idempotency, and budget rules fail closed', () => {
  const consequentialManifest = {
    ...readToolManifest,
    riskClass: 'consequential-write',
    operations: {
      read: {
        ...readToolManifest.operations.read,
        sideEffectClass: 'consequential-write'
      }
    }
  };
  const consequentialRequest = (overrides = {}) => toolRequest({
    trustedToolManifest: consequentialManifest,
    capabilityRequest: { ...toolRequest().capabilityRequest, sideEffectClass: 'consequential-write' },
    ...overrides
  });
  const validApprovalNoIdempotency = withServerApproval(consequentialRequest());
  const validApprovalWithIdempotency = withServerApproval(consequentialRequest({ idempotencyKey: 'idem_1' }));
  const externalWriteRequest = withServerApproval(consequentialRequest({
    capabilityRequest: {
      ...toolRequest().capabilityRequest,
      sideEffectClass: 'consequential-write',
      network: [{ protocol: 'https', host: 'example.com', port: 443, methods: ['POST'], consequence: 'write', locality: 'external' }]
    },
    idempotencyKey: 'idem_1'
  }));
  const cases = [
    ['secret model context', baseRequest({ action: 'context.compile', resource: { type: 'context', id: 'ctx_secret', workspaceId: 'ws_local', dataClass: 'secret' } }), 'data_class_denied'],
    ['secret network tool', toolRequest({ resource: { type: 'tool', id: readToolManifest.id, workspaceId: 'ws_local', dataClass: 'secret' } }), 'data_class_denied'],
    ['confidential cross workspace', baseRequest({ resource: { type: 'artifact', id: 'art_other', workspaceId: 'ws_other', dataClass: 'confidential' } }), 'workspace_mismatch'],
    ['consequential approval missing', consequentialRequest(), 'approval_required'],
    ['caller-minted approval missing server verification', consequentialRequest({ idempotencyKey: 'idem_1', approvalContext: { approvalId: 'appr_1', operationFingerprint: canonicalOperationFingerprint(consequentialRequest({ idempotencyKey: 'idem_1' })), workspaceId: 'ws_local', actorId: 'usr_owner', approvedAt: fixedNow, expiresAt: '2026-06-19T11:00:00.000Z', status: 'active', approverId: 'usr_owner', policyVersion: POLICY_REGISTRY.version } }), 'approval_invalid'],
    ['consequential idempotency missing', validApprovalNoIdempotency, 'idempotency_required'],
    ['approval mismatch', withServerApproval(consequentialRequest({ idempotencyKey: 'idem_1' }), { operationFingerprint: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }), 'approval_scope_mismatch'],
    ['expired approval', withServerApproval(consequentialRequest({ idempotencyKey: 'idem_1' }), { expiresAt: '2026-06-19T09:00:00.000Z' }), 'approval_expired'],
    ['external write disabled', externalWriteRequest, 'external_writes_disabled'],
    ['runtime over limit', toolRequest({ capabilityRequest: { ...toolRequest().capabilityRequest, limits: { runtimeMs: 2000, outputBytes: 1024, costUnits: 0 } } }), 'budget_exceeded'],
    ['negative limit', toolRequest({ capabilityRequest: { ...toolRequest().capabilityRequest, limits: { runtimeMs: -1, outputBytes: 1024, costUnits: 0 } } }), 'budget_exceeded']
  ];
  assert.equal(evaluateContextualPolicy(validApprovalWithIdempotency, { decisionIdFactory: () => 'poldet_server_verified_approval', clock: () => fixedNow }).outcome, 'allow');
  for (const [name, request, reason] of cases) {
    const decision = evaluateContextualPolicy(request, { decisionIdFactory: () => `poldet_${name.replace(/\W+/g, '_')}`, clock: () => fixedNow });
    assert.equal(decision.outcome, 'deny', name);
    assert(decision.reasonCodes.includes(reason), `${name} expected ${reason}, got ${decision.reasonCodes.join(',')}`);
  }
});

test('policy service emits safe events and fail-closes writes when audit persistence fails', async () => {
  const events = [];
  const service = createPolicyService({
    auditSink: { recordAuditEvent: async (event) => events.push(event) },
    decisionIdFactory: () => 'poldet_event',
    clock: () => fixedNow
  });
  const allow = await service.evaluate(toolRequest());
  const deny = await service.evaluate(toolRequest({ capabilityRequest: { ...toolRequest().capabilityRequest, filesystem: { read: ['workspace:project-evil'], write: [] } } }));
  assert.equal(allow.outcome, 'allow');
  assert.equal(deny.outcome, 'deny');
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.type), ['policy.decision', 'policy.decision']);
  assert.equal(JSON.stringify(events).includes('raw-secret'), false);
  assert.equal(JSON.stringify(events).includes('/Users/'), false);
  assert.equal(events[0].metadata.policyFingerprint, policyFingerprint(POLICY_REGISTRY));

  const closed = createPolicyService({
    auditSink: { recordAuditEvent: async () => { throw new Error('disk unavailable'); } },
    decisionIdFactory: () => 'poldet_fail_closed',
    clock: () => fixedNow
  });
  const writeManifest = {
    ...readToolManifest,
    operations: {
      write: {
        sideEffectClass: 'reversible-write',
        filesystem: { read: ['workspace:project'], write: ['workspace:project'] },
        network: [],
        secretReferences: [],
        dataClasses: ['workspace-private'],
        sandbox: 'workspace-write',
        limits: { runtimeMs: 1000, outputBytes: 2048, costUnits: 0 }
      }
    }
  };
  const writeDecision = await closed.evaluate(toolRequest({
    trustedToolManifest: writeManifest,
    idempotencyKey: 'idem_audit_write',
    capabilityRequest: {
      toolId: readToolManifest.id,
      operation: 'write',
      sideEffectClass: 'reversible-write',
      filesystem: { read: ['workspace:project/src'], write: ['workspace:project/src'] },
      network: [],
      secretReferences: [],
      dataClasses: ['workspace-private'],
      sandbox: 'workspace-write',
      limits: { runtimeMs: 500, outputBytes: 1024, costUnits: 0 }
    }
  }));
  assert.equal(writeDecision.outcome, 'deny');
  assert(writeDecision.reasonCodes.includes('policy_configuration_invalid'));
});

test('native deterministic provider implements the contextual policy port', async () => {
  const provider = new DeterministicPolicyProvider({ decisionIdFactory: () => 'poldet_native', clock: () => fixedNow });
  const health = await provider.health();
  const capabilities = await provider.capabilities();
  const decision = await provider.evaluate(baseRequest());
  assert.equal(health.status, 'healthy');
  assert(capabilities.capabilities.includes('policy.default-deny'));
  assert.equal(decision.outcome, 'allow');
  assert.equal(decision.decisionId, 'poldet_native');
});

test('tool registry uses the contextual evaluator and denied requests never call providers', async () => {
  let called = false;
  const registry = ToolRegistry.createForTests({
    tools: ['tool:filesystem-read'],
    handlers: {
      'handler:brokered:workspace-file-read@1.0.0': async () => {
        called = true;
        return { path: 'docs/readme.txt', sha256: `sha256:${'a'.repeat(64)}`, byteSize: 1 };
      }
    },
    clock: () => fixedNow
  });
  const denied = await registry.execute({
    schemaVersion: '1.0.0',
    requestId: 'toolreq_policy_denied',
    correlationId: 'req_contextual-policy-tool-000000',
    workspaceId: 'ws_local',
    runId: 'run_policy_tool',
    stepId: 'step_policy_tool',
    actorId: 'usr_owner',
    trustedContext: {
      principal: { userId: 'usr_owner', principalType: 'agent', authenticationMethod: 'session', status: 'active', agentRole: 'agent:security-auditor' },
      membership: { workspaceId: 'ws_local', role: 'builder', status: 'active' },
      environment: { deploymentProfile: 'local-dev', locality: 'local-only', interactive: true, externalWritesEnabled: false }
    },
    toolId: 'tool:filesystem-read',
    toolVersion: '1.0.0',
    operation: 'readFile',
    requestedCapability: {
      toolId: 'tool:filesystem-read',
      operation: 'readFile',
      sideEffectClass: 'read-only',
      filesystem: { read: ['workspace:evil'], write: [] },
      network: [],
      secretReferences: [],
      dataClasses: ['workspace-private'],
      sandbox: 'brokered-filesystem-read',
      limits: { runtimeMs: 1000, inputBytes: 1024, outputBytes: 4096, costUnits: 0 }
    },
    input: { path: 'docs/readme.txt' },
    dataClass: 'workspace-private',
    trustedTimestamp: fixedNow
  });
  assert.equal(denied.status, 'denied');
  assert.equal(called, false);
  assert(denied.policy.reasonCodes.includes('filesystem_read_denied'));
});
