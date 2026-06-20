import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ToolRegistry,
  createMemoryEffectBoundary
} from '../packages/tool-registry/src/index.mjs';

const fixedNow = '2026-06-20T00:00:00.000Z';
const trustedContext = {
  principal: { userId: 'usr_tool', principalType: 'agent', authenticationMethod: 'session', status: 'active', agentRole: 'agent:security-auditor' },
  membership: { workspaceId: 'ws_tool', role: 'builder', status: 'active' },
  environment: { deploymentProfile: 'local-dev', locality: 'local-only', interactive: true, externalWritesEnabled: false }
};

async function tempWorkspace(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oaf tool workspace with spaces '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'docs'), { recursive: true });
  await writeFile(path.join(directory, 'docs', 'read me.txt'), 'bounded read');
  await writeFile(path.join(directory, '.env'), 'SECRET_VALUE=do-not-read');
  return directory;
}

function invocation(overrides = {}) {
  return {
    schemaVersion: '1.0.0',
    requestId: 'toolreq_broker',
    correlationId: 'req_tool-broker-000000',
    workspaceId: 'ws_tool',
    runId: 'run_tool',
    stepId: 'step_tool',
    actorId: 'usr_tool',
    trustedContext,
    toolVersion: '1.0.0',
    dataClass: 'workspace-private',
    trustedTimestamp: fixedNow,
    ...overrides
  };
}

test('filesystem broker enforces workspace-relative read/write scopes and redacts absolute paths', async (t) => {
  const workspaceRoot = await tempWorkspace(t);
  const registry = ToolRegistry.createForTests({ tools: ['tool:filesystem-read', 'tool:workspace-write'], workspaceRoot, clock: () => fixedNow });

  const read = await registry.execute(invocation({ toolId: 'tool:filesystem-read', operation: 'readFile', input: { path: 'docs/read me.txt' } }));
  assert.equal(read.status, 'completed');
  assert.equal(read.output.path, 'docs/read me.txt');
  assert.equal(read.output.byteSize, 12);
  assert.equal(JSON.stringify(read).includes(workspaceRoot), false);

  for (const badPath of ['/tmp/file', '../secret', 'docs\\secret', 'docs/\u0000bad', '.env']) {
    const denied = await registry.execute(invocation({ toolId: 'tool:filesystem-read', operation: 'readFile', input: { path: badPath } }));
    assert.equal(denied.status, 'failed', badPath);
    assert.equal(denied.error.code, 'tool_filesystem_denied');
  }

  const outside = path.join(workspaceRoot, '..', `outside-${Date.now()}.txt`);
  await writeFile(outside, 'outside');
  t.after(() => rm(outside, { force: true }));
  await symlink(outside, path.join(workspaceRoot, 'docs', 'escape.txt'));
  const symlinkDenied = await registry.execute(invocation({ toolId: 'tool:filesystem-read', operation: 'readFile', input: { path: 'docs/escape.txt' } }));
  assert.equal(symlinkDenied.error.code, 'tool_filesystem_denied');

  const outsideDirectory = path.join(workspaceRoot, '..', `outside-dir-${Date.now()}`);
  await mkdir(outsideDirectory, { recursive: true });
  t.after(() => rm(outsideDirectory, { recursive: true, force: true }));
  await symlink(outsideDirectory, path.join(workspaceRoot, 'docs', 'linkdir'));
  const escapedWrite = await registry.execute(invocation({
    toolId: 'tool:workspace-write',
    operation: 'writeFile',
    input: { path: 'docs/linkdir/escaped.txt', content: 'escaped write' },
    idempotencyKey: 'idem_fs_symlink_write',
    effectBoundary: createMemoryEffectBoundary()
  }));
  assert.equal(escapedWrite.error.code, 'tool_filesystem_denied');
  await assert.rejects(() => readFile(path.join(outsideDirectory, 'escaped.txt'), 'utf8'), { code: 'ENOENT' });

  const effectBoundary = createMemoryEffectBoundary();
  const write = await registry.execute(invocation({
    toolId: 'tool:workspace-write',
    operation: 'writeFile',
    input: { path: 'docs/out.txt', content: 'safe write' },
    idempotencyKey: 'idem_fs_write',
    effectBoundary
  }));
  assert.equal(write.status, 'completed');
  assert.equal(await readFile(path.join(workspaceRoot, 'docs', 'out.txt'), 'utf8'), 'safe write');
  assert.equal(effectBoundary.count(), 1);
  const repeat = await registry.execute(invocation({
    toolId: 'tool:workspace-write',
    operation: 'writeFile',
    input: { path: 'docs/out.txt', content: 'safe write' },
    idempotencyKey: 'idem_fs_write',
    effectBoundary
  }));
  assert.equal(repeat.output.idempotent, true);
  assert.equal(effectBoundary.count(), 1);
});

test('egress broker denies external hosts and allows only exact bounded loopback reads', async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'secret=bad' });
    res.end('loopback ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const registry = ToolRegistry.createForTests({ tools: ['tool:loopback-read'], loopbackPort: port, clock: () => fixedNow });

  const ok = await registry.execute(invocation({ toolId: 'tool:loopback-read', operation: 'fetchText', input: { url: `http://127.0.0.1:${port}/status`, method: 'GET' } }));
  assert.equal(ok.status, 'completed');
  assert.equal(ok.output.status, 200);
  assert.equal(ok.output.bodySha256.startsWith('sha256:'), true);
  assert.equal(Object.hasOwn(ok.output.headers, 'set-cookie'), false);

  const external = await registry.execute(invocation({ toolId: 'tool:loopback-read', operation: 'fetchText', input: { url: 'https://example.com/', method: 'GET' } }));
  assert.equal(external.error.code, 'tool_network_denied');
  const wrongMethod = await registry.execute(invocation({ toolId: 'tool:loopback-read', operation: 'fetchText', input: { url: `http://127.0.0.1:${port}/status`, method: 'POST' } }));
  assert.equal(wrongMethod.error.code, 'tool_network_denied');
  const userinfo = await registry.execute(invocation({ toolId: 'tool:loopback-read', operation: 'fetchText', input: { url: `http://user:pass@127.0.0.1:${port}/status`, method: 'GET' } }));
  assert.equal(userinfo.error.code, 'tool_network_denied');
});

test('secret broker resolves declared references only after grant consumption and blocks leakage', async () => {
  const events = [];
  const registry = ToolRegistry.createForTests({
    tools: ['tool:secret-fixture'],
    eventSink: async (event) => events.push(event),
    secretResolver: {
      resolve: async (reference) => reference === 'secret:fixture.read' ? 'test-secret-value' : null
    },
    clock: () => fixedNow
  });

  const ok = await registry.execute(invocation({ toolId: 'tool:secret-fixture', operation: 'hashSecret', input: { secretReferences: ['secret:fixture.read'] } }));
  assert.equal(ok.status, 'completed');
  assert.equal(ok.output.secretCount, 1);
  assert.equal(JSON.stringify(ok).includes('test-secret-value'), false);
  assert.equal(JSON.stringify(events).includes('test-secret-value'), false);

  const undeclared = await registry.execute(invocation({ toolId: 'tool:secret-fixture', operation: 'hashSecret', input: { secretReferences: ['secret:other'] } }));
  assert.equal(undeclared.error.code, 'tool_secret_denied');
  const raw = await registry.execute(invocation({ toolId: 'tool:secret-fixture', operation: 'hashSecret', input: { secretValues: ['test-secret-value'] } }));
  assert.equal(raw.error.code, 'tool_request_invalid');
});
