import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BrokeredLocalToolProvider } from '../providers/native/tool-brokered-local/src/index.mjs';
import { createMemoryEffectBoundary } from '../packages/tool-registry/src/index.mjs';

const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'oaf bounded tool smoke '));
try {
  await mkdir(path.join(workspaceRoot, 'docs'), { recursive: true });
  await writeFile(path.join(workspaceRoot, 'docs', 'input.txt'), 'bounded smoke input');

  const provider = await BrokeredLocalToolProvider.fromCatalog({
    catalogPath: 'tools/catalog.json',
    manifestRoot: process.cwd(),
    workspaceRoot,
    clock: () => '2026-06-20T00:00:00.000Z'
  });
  const health = await provider.health();
  if (health.status !== 'healthy' || health.details.externalWrites !== false) throw new Error('bounded tool provider health failed');

  const trustedContext = {
    principal: { userId: 'usr_tool_smoke', principalType: 'agent', authenticationMethod: 'session', status: 'active', agentRole: 'agent:security-auditor' },
    membership: { workspaceId: 'ws_tool_smoke', role: 'builder', status: 'active' },
    environment: { deploymentProfile: 'local-dev', locality: 'local-only', interactive: true, externalWritesEnabled: false }
  };
  const base = {
    schemaVersion: '1.0.0',
    correlationId: 'req_tool-bounded-smoke-000000',
    workspaceId: 'ws_tool_smoke',
    runId: 'run_tool_smoke',
    stepId: 'step_tool_smoke',
    actorId: 'usr_tool_smoke',
    trustedContext,
    toolVersion: '1.0.0',
    dataClass: 'workspace-private',
    trustedTimestamp: '2026-06-20T00:00:00.000Z'
  };

  const read = await provider.execute({
    ...base,
    requestId: 'toolreq_smoke_read',
    toolId: 'tool:filesystem-read',
    operation: 'readFile',
    input: { path: 'docs/input.txt' }
  });
  if (read.status !== 'completed' || read.output.byteSize !== 19) throw new Error(`bounded read failed: ${read.error?.code ?? read.status}`);

  const effects = createMemoryEffectBoundary();
  const write = await provider.execute({
    ...base,
    requestId: 'toolreq_smoke_write',
    toolId: 'tool:workspace-write',
    operation: 'writeFile',
    input: { path: 'docs/output.txt', content: 'bounded write' },
    idempotencyKey: 'idem_tool_smoke_write',
    effectBoundary: effects
  });
  if (write.status !== 'completed') throw new Error(`bounded write failed: ${write.error?.code ?? write.status}`);
  const repeat = await provider.execute({
    ...base,
    requestId: 'toolreq_smoke_write_retry',
    toolId: 'tool:workspace-write',
    operation: 'writeFile',
    input: { path: 'docs/output.txt', content: 'bounded write' },
    idempotencyKey: 'idem_tool_smoke_write',
    effectBoundary: effects
  });
  if (repeat.status !== 'completed' || repeat.output.idempotent !== true || effects.count() !== 1) throw new Error('idempotent bounded write failed');
  if (await readFile(path.join(workspaceRoot, 'docs', 'output.txt'), 'utf8') !== 'bounded write') throw new Error('bounded write file mismatch');

  const denied = await provider.execute({
    ...base,
    requestId: 'toolreq_smoke_denied',
    trustedContext: {
      ...trustedContext,
      principal: { ...trustedContext.principal, authenticationMethod: 'bearer', tokenScopes: ['run.read'], tokenWorkspaceIds: ['ws_tool_smoke'] }
    },
    toolId: 'tool:fixture-pure',
    operation: 'echo',
    input: { value: 'should not run' }
  });
  if (denied.status !== 'denied' || denied.error.code !== 'tool_policy_denied' || denied.grantId !== null) throw new Error('denied bounded invocation failed closed incorrectly');

  console.log('PASS reviewed checksum-pinned tool catalog');
  console.log('PASS brokered filesystem read');
  console.log('PASS idempotent brokered workspace write');
  console.log('PASS denied invocation does not mint a grant');
  console.log('PASS bounded local tool execution smoke');
} finally {
  await rm(workspaceRoot, { recursive: true, force: true });
}
