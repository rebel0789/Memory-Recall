import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../packages/tool-registry/src/index.mjs';

const fixedNow = '2026-06-20T00:00:00.000Z';
const trustedContext = {
  principal: { userId: 'usr_registry', principalType: 'agent', authenticationMethod: 'session', status: 'active', agentRole: 'agent:security-auditor' },
  membership: { workspaceId: 'ws_registry', role: 'builder', status: 'active' },
  environment: { deploymentProfile: 'local-dev', locality: 'local-only', interactive: true, externalWritesEnabled: false }
};

test('registry invokes an authorized handler only with trusted context', async () => {
  const registry = ToolRegistry.createForTests({ tools: ['tool:fixture-pure'], clock: () => fixedNow });
  const result = await registry.execute({
    schemaVersion: '1.0.0',
    requestId: 'toolreq_registry_allow',
    correlationId: 'req_tool-registry-000000',
    workspaceId: 'ws_registry',
    runId: 'run_registry',
    stepId: 'step_registry',
    actorId: 'usr_registry',
    trustedContext,
    toolId: 'tool:fixture-pure',
    toolVersion: '1.0.0',
    operation: 'echo',
    input: { value: '3' },
    dataClass: 'workspace-private',
    trustedTimestamp: fixedNow
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.output.echoed, '3');
});

test('registry does not preserve caller-supplied role authority', async () => {
  const registry = ToolRegistry.createForTests({ tools: ['tool:fixture-pure'], clock: () => fixedNow });
  const result = await registry.execute({
    schemaVersion: '1.0.0',
    requestId: 'toolreq_registry_forged',
    correlationId: 'req_tool-registry-000001',
    workspaceId: 'ws_registry',
    runId: 'run_registry',
    stepId: 'step_registry',
    actorId: 'usr_registry',
    trustedContext: null,
    role: 'agent:security-auditor',
    toolId: 'tool:fixture-pure',
    toolVersion: '1.0.0',
    operation: 'echo',
    input: { value: '3' },
    dataClass: 'workspace-private',
    trustedTimestamp: fixedNow
  });
  assert.equal(result.status, 'denied');
  assert.equal(result.error.code, 'tool_request_invalid');
});
