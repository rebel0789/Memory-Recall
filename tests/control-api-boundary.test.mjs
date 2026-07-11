import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createControlApiServer, resolveServeSourceGraphRoot } from '../services/control-api/src/server.mjs';
import { API_ROUTE_CONTRACTS } from '../services/control-api/src/route-contracts.mjs';
import { LocalIdentityStore } from '../providers/native/identity-local/src/index.mjs';

const baseState = () => ({ schemaVersion: '1.0.0', runs: [], events: [], memories: [], approvals: [], artifacts: [] });

class SpyStore {
  constructor() {
    this.state = baseState();
    this.reads = 0;
    this.updates = 0;
    this.resets = 0;
  }
  async init() { return this; }
  async read() { this.reads += 1; return structuredClone(this.state); }
  async update(mutator) {
    this.updates += 1;
    this.state = await mutator(structuredClone(this.state));
    return structuredClone(this.state);
  }
  async reset() { this.resets += 1; this.state = baseState(); return structuredClone(this.state); }
}

async function freePort() {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function cookieHeader(headers) {
  const raw = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : headers.get('set-cookie')?.split(/,(?=\s*oaf_)/) ?? [];
  return raw.map((item) => item.split(';')[0]).join('; ');
}

function csrfFromCookie(cookie) {
  return /(?:^|;\s*)oaf_csrf=([^;]+)/.exec(cookie)?.[1] ?? '';
}

test('serve source graph root defaults to launched repository cwd with env override', () => {
  assert.equal(resolveServeSourceGraphRoot({ env: {}, cwd: '/tmp/project' }), path.resolve('/tmp/project'));
  assert.equal(resolveServeSourceGraphRoot({ env: { OAF_WORKSPACE_ROOT: '/tmp/other-project' }, cwd: '/tmp/project' }), path.resolve('/tmp/other-project'));
});

test('cli serve inspects the repository it is launched from', async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'oaf-cli-serve-root-'));
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'oaf-cli-serve-data-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oaf-cli-serve-home-'));
  t.after(async () => {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });
  await mkdir(path.join(sourceRoot, 'src'), { recursive: true });
  await writeFile(path.join(sourceRoot, 'src', 'web.ts'), 'export function servedWorkspaceRootFixture(){ return true; }\n');
  const port = await freePort();
  const child = spawn(process.execPath, [path.resolve('apps/cli/oaf.mjs'), 'serve'], {
    cwd: sourceRoot,
    env: { ...process.env, OAF_PORT: String(port), OAF_DATA_DIR: dataDir, HOME: home },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  let childExited = false;
  const childExit = once(child, 'exit').then(() => {
    childExited = true;
  });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    if (!childExited) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {}
    }
    await Promise.race([
      childExit,
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]);
    if (!childExited) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }
    await Promise.race([
      childExit,
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]);
  });

  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const status = await fetch(`${base}/api/auth/bootstrap-status`);
      if (status.ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.match(output, /Open Agent Fabric local bootstrap/);
  const bootstrap = await fetch(`${base}/api/auth/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({
      username: 'owner',
      displayName: 'Local Owner',
      password: 'correct horse battery staple',
      workspaceId: 'ws_local',
      workspaceName: 'Local Workspace'
    })
  });
  const bootstrapText = await bootstrap.text();
  assert.equal(bootstrap.status, 201, bootstrapText);
  const cookie = cookieHeader(bootstrap.headers);
  const graph = await fetch(`${base}/api/context/graph/preview`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: base,
      cookie,
      'x-csrf-token': csrfFromCookie(cookie)
    },
    body: JSON.stringify({
      workspaceId: 'ws_local',
      changedLocators: ['src/web.ts'],
      maxFiles: 50
    })
  });
  const graphText = await graph.text();
  assert.equal(graph.status, 200, graphText);
  const body = JSON.parse(graphText);
  assert.deepEqual(body.impact.changedLocators, ['workspace://src/web.ts']);
  assert.deepEqual(body.impact.representedChangedLocators, ['workspace://src/web.ts']);
});

test('memory intake previews facts that mention workspace source paths', async (t) => {
  const api = await startServer(t);
  const response = await fetch(`${api.base}/api/memory/proposals`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: api.base,
      cookie: api.auth.cookie,
      'x-csrf-token': api.auth.csrf
    },
    body: JSON.stringify({
      workspaceId: 'ws_local',
      sourceLocator: 'notes/hono-routing.md',
      text: 'Fact: project:hono routing_core src/hono-base.ts and src/compose.ts.',
      dryRun: true
    })
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const body = JSON.parse(text);
  assert.equal(body.command, 'memory preview');
  assert.equal(body.summary.proposalCount, 1);
  assert.equal(body.proposalFacts[0].subject, 'project:hono');
  assert.equal(body.proposalFacts[0].object, 'src/hono-base.ts and src/compose.ts');
});

test('memory intake duplicate after approval stays proposal gated', async (t) => {
  const api = await startServer(t);
  const payload = {
    workspaceId: 'ws_local',
    sourceLocator: 'memory/inbox.md',
    text: 'Fact: project:oaf browser_smoke release_candidate_checked.',
    dryRun: false,
    confirm: true
  };
  const queue = await fetch(`${api.base}/api/memory/proposals`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base, cookie: api.auth.cookie, 'x-csrf-token': api.auth.csrf },
    body: JSON.stringify(payload)
  });
  const queueText = await queue.text();
  assert.equal(queue.status, 200, queueText);
  const queued = JSON.parse(queueText);
  assert.equal(queued.proposalFacts[0].status, 'pending');
  const approve = await fetch(`${api.base}/api/memory/proposals/${queued.proposalFacts[0].id}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base, cookie: api.auth.cookie, 'x-csrf-token': api.auth.csrf },
    body: JSON.stringify({ workspaceId: 'ws_local', confirm: true })
  });
  const approveText = await approve.text();
  assert.equal(approve.status, 201, approveText);
  const duplicate = await fetch(`${api.base}/api/memory/proposals`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base, cookie: api.auth.cookie, 'x-csrf-token': api.auth.csrf },
    body: JSON.stringify(payload)
  });
  const duplicateText = await duplicate.text();
  assert.equal(duplicate.status, 200, duplicateText);
  const duplicateBody = JSON.parse(duplicateText);
  assert.equal(duplicateBody.summary.activeMemoryCreated, 0);
  assert.deepEqual(duplicateBody.proposalFacts, []);
});

async function startServer(t, overrides = {}) {
  const store = overrides.store ?? new SpyStore();
  const workspaceId = overrides.workspaceId ?? 'ws_local';
  const identityRoot = await mkdtemp(path.join(os.tmpdir(), 'oaf-boundary-identity-'));
  t.after(async () => rm(identityRoot, { recursive: true, force: true }));
  const identityStore = overrides.identityStore ?? await new LocalIdentityStore({
    directory: identityRoot,
    clock: () => '2026-06-19T10:00:00.000Z',
    scrypt: { N: 1024, r: 8, p: 1, keyLength: 32 }
  }).init();
  const owner = await identityStore.bootstrapOwner({
    username: 'owner',
    displayName: 'Local Owner',
    password: 'correct horse battery staple',
    workspaceId,
    workspaceName: 'Local Workspace'
  }).catch((error) => {
    if (error.code === 'already_bootstrapped') return null;
    throw error;
  });
  const userId = owner?.user.id ?? 'usr_existing';
  const session = owner ? await identityStore.createSession({ userId, remoteAddress: '127.0.0.1', userAgent: 'node:test' }) : null;
  const calls = { workflow: 0, compile: 0, logs: [] };
  const runWorkflow = overrides.runWorkflow ?? (async ({ objective, emit }) => {
    calls.workflow += 1;
    const runId = 'run_boundary';
    await emit({
      schemaVersion: '1.0.0',
      id: 'evt_boundary',
      workspaceId: 'ws_local',
      type: 'run.created',
      runId,
      actorId: 'system',
      sequence: 0,
      occurredAt: '2026-06-19T10:00:00.000Z',
      correlationId: runId,
      causationId: null,
      dataClass: 'workspace-private',
      producerVersion: '0.2.0-dev',
      payload: {}
    });
    return {
      runId,
      objective: objective ?? 'Default objective',
      status: 'completed',
      outputs: {
        'generate-angles': { output: [{ rank: 1, angle: 'A', hook: 'H', evidenceIds: ['obs_1'], confidence: 0.8 }] },
        'verify-recommendations': { valid: true }
      }
    };
  });
  const compileContext = overrides.compileContext ?? ((request, records) => {
    calls.compile += 1;
    return {
      schemaVersion: '1.0.0',
      id: 'ctx_boundary',
      workspaceId: request.workspaceId,
      requestId: request.id,
      compilerVersion: 'test',
      createdAt: '2026-06-19T10:00:00.000Z',
      budget: { available: request.tokenBudget, used: 1 },
      selected: records.map((record) => ({ id: record.id, kind: record.kind, tokens: 1, score: 1, reasonCodes: ['explicit'], source: record.source ?? 'test', text: record.text })),
      excluded: [],
      conflicts: [],
      warnings: []
    };
  });
  const logger = {
    info: (entry) => calls.logs.push({ level: 'info', entry }),
    warn: (entry) => calls.logs.push({ level: 'warn', entry }),
    error: (entry) => calls.logs.push({ level: 'error', entry })
  };
  const api = createControlApiServer({
    store,
    identityStore,
    runWorkflow,
    compileContext,
    memoryDatabasePath: path.join(identityRoot, 'memory.sqlite'),
    clock: () => '2026-06-19T10:00:00.000Z',
    correlationIdFactory: () => 'req_generated-00000000-0000-4000-8000-000000000000',
    logger,
    limits: {
      bodyBytes: 2048,
      urlBytes: 512,
      pathSegmentBytes: 80,
      queryParameters: 4,
      queryValueBytes: 40,
      headerBytes: 4096,
      headerCount: 64,
      jsonDepth: 5,
      jsonNodes: 80,
      jsonObjectKeys: 20,
      jsonArrayItems: 4,
      objectiveLength: 32
    },
    ...overrides
  });
  api.server.listen(0, '127.0.0.1');
  await once(api.server, 'listening');
  t.after(async () => {
    await new Promise((resolve) => api.close(resolve));
  });
  const { port } = api.server.address();
  const auth = session ? {
    cookie: `oaf_session=${session.token}; oaf_csrf=${session.csrfToken}`,
    csrf: session.csrfToken
  } : null;
  return { ...api, base: `http://127.0.0.1:${port}`, store, calls, auth };
}

async function request(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    body: text ? JSON.parse(text) : null
  };
}

function rawRequest(base, path, { method = 'POST', headers = {}, chunks = [] } = {}) {
  const url = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: body ? JSON.parse(body) : null }));
    });
    req.on('error', reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

const validContextPayload = () => ({
  request: {
    schemaVersion: '1.0.0',
    id: 'ctxreq_boundary',
    workspaceId: 'ws_local',
    actorId: 'agent:test',
    taskId: 'run_test',
    step: 'answer',
    objective: 'test',
    tokenBudget: 20,
    allowedScopes: ['workspace-private']
  },
  records: [{ id: 'obs_1', kind: 'observation', text: 'test record', source: 'fixture', tokens: 1 }]
});

test('valid requests receive correlation IDs and preserve local-only behavior', async (t) => {
  const api = await startServer(t);
  const health = await request(api.base, '/api/health');
  assert.equal(health.status, 200);
  assert.match(health.headers.get('x-correlation-id'), /^req_/);
  assert.equal(health.body.residency, 'local-only');
  assert.equal(health.body.externalWrites, false);

  const supplied = await request(api.base, '/api/context/compile', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', origin: api.base, cookie: api.auth.cookie, 'x-csrf-token': api.auth.csrf, 'x-correlation-id': 'req_client-00000000-0000-4000-8000-000000000001' },
    body: JSON.stringify(validContextPayload())
  });
  assert.equal(supplied.status, 200);
  assert.equal(supplied.headers.get('x-correlation-id'), 'req_client-00000000-0000-4000-8000-000000000001');
  assert.equal(api.calls.compile, 1);
});

test('Recall Map rejects workspace IDs outside its strict report contract before map execution', async (t) => {
  const sourceGraphRoot = await mkdtemp(path.join(os.tmpdir(), 'oaf-recall-map-workspace-'));
  t.after(async () => rm(sourceGraphRoot, { recursive: true, force: true }));
  const api = await startServer(t, { sourceGraphRoot, workspaceId: 'ws_Mixed' });

  const response = await request(api.base, '/api/recall/map?workspaceId=ws_Mixed', {
    headers: { cookie: api.auth.cookie }
  });

  assert.equal(response.status, 400, response.text);
  assert.equal(response.body.error.code, 'request_validation_failed');
  assert.equal(api.store.reads, 0);
  assert.equal(api.store.updates, 0);
  assert.equal(api.calls.workflow, 0);
  assert.equal(api.calls.compile, 0);
});

test('context pack route is protected and does not mutate run state', async (t) => {
  const sourceGraphRoot = await mkdtemp(path.join(os.tmpdir(), 'oaf-api-context-pack-'));
  t.after(async () => rm(sourceGraphRoot, { recursive: true, force: true }));
  await mkdir(path.join(sourceGraphRoot, '.cursor', 'rules'), { recursive: true });
  await mkdir(path.join(sourceGraphRoot, 'notes'), { recursive: true });
  await mkdir(path.join(sourceGraphRoot, 'src'), { recursive: true });
  await writeFile(path.join(sourceGraphRoot, 'AGENTS.md'), 'API RAW AGENTS BODY should never be returned.');
  await writeFile(path.join(sourceGraphRoot, 'CONTEXT.md'), 'API RAW SELECTED BODY should never be returned.');
  await writeFile(path.join(sourceGraphRoot, 'CLAUDE.md'), 'API RAW CLAUDE BODY should never be returned.');
  await writeFile(path.join(sourceGraphRoot, '.cursor', 'rules', 'fabric.mdc'), 'API RAW CURSOR BODY should never be returned.');
  await writeFile(path.join(sourceGraphRoot, 'notes', 'memory.md'), 'API RAW MEMORY BODY should never be returned. Prefer local-only context handoffs.');
  const largeMemoryTail = 'API_LARGE_MEMORY_TAIL_SHOULD_NOT_LEAK';
  await writeFile(path.join(sourceGraphRoot, 'notes', 'large-memory.md'), `project:oaf large_context browser_preflight\n${'ctx '.repeat(2_400_000)}${largeMemoryTail}`);
  await writeFile(path.join(sourceGraphRoot, 'src', 'web.ts'), 'export const webBoundary = true;\n');
  const api = await startServer(t, { sourceGraphRoot });
  const denied = await request(api.base, '/api/context/pack', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base },
    body: JSON.stringify({
      workspaceId: 'ws_local',
      objective: 'prepare handoff',
      step: 'select useful context',
      targetHarness: 'codex'
    })
  });
  assert.equal(denied.status, 401);
  assert.equal(denied.body.error.code, 'authentication_required');

  const deniedPreview = await request(api.base, '/api/context/source-preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base },
    body: JSON.stringify({
      workspaceId: 'ws_local',
      objective: 'prepare handoff',
      step: 'select useful context'
    })
  });
  assert.equal(deniedPreview.status, 401);
  assert.equal(deniedPreview.body.error.code, 'authentication_required');

  const deniedMemoryPreflight = await request(api.base, '/api/context/pack/memory-preflight', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base },
    body: JSON.stringify({
      workspaceId: 'ws_local',
      memoryConfig: { schemaVersion: '1.0.0', memoryPaths: [{ path: 'notes/memory.md' }] }
    })
  });
  assert.equal(deniedMemoryPreflight.status, 401);
  assert.equal(deniedMemoryPreflight.body.error.code, 'authentication_required');

  const sourcePreview = await request(api.base, '/api/context/source-preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base, cookie: api.auth.cookie, 'x-csrf-token': api.auth.csrf },
    body: JSON.stringify({
      workspaceId: 'ws_local',
      objective: 'prepare handoff',
      step: 'preview harness source intake',
      from: 'codex,cursor',
      userSelectedFiles: ['CONTEXT.md'],
      tokenBudget: 96
    })
  });
  assert.equal(sourcePreview.status, 200, sourcePreview.text);
  assert.equal(sourcePreview.body.schemaVersion, '1.0.0');
  assert.equal(sourcePreview.body.dryRun, true);
  assert.equal(sourcePreview.body.scan.summary.externalWritesEnabled, false);
  assert.equal(sourcePreview.body.scan.summary.externalAdaptersEnabled, 0);
  assert.equal(sourcePreview.body.scan.sources.some((source) => source.locator === 'workspace://AGENTS.md'), true);
  assert.equal(sourcePreview.body.scan.sources.some((source) => source.locator === 'user-selected://CONTEXT.md'), true);
  assert.equal(sourcePreview.body.safeguards.externalWritesEnabled, false);
  assert.equal(sourcePreview.body.safeguards.modelCalls, 0);
  assert.equal(sourcePreview.body.safeguards.networkCalls, 0);
  assert.equal(sourcePreview.body.safeguards.activeMemoryCreated, 0);
  assert.equal(sourcePreview.body.memoryPlan.activeMemoryCreated, 0);
  assert.equal(sourcePreview.text.includes('API RAW AGENTS BODY'), false);
  assert.equal(sourcePreview.text.includes('API RAW SELECTED BODY'), false);
  assert.equal(sourcePreview.text.includes('API RAW CURSOR BODY'), false);
  assert.equal(sourcePreview.text.includes('/Users/'), false);

  const response = await request(api.base, '/api/context/pack', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base, cookie: api.auth.cookie, 'x-csrf-token': api.auth.csrf },
    body: JSON.stringify({
      workspaceId: 'ws_local',
      objective: 'NOECHO_OBJ handoff',
      step: 'NOECHO_STEP context',
      targetHarness: 'codex',
      from: 'codex',
      userSelectedFiles: ['CONTEXT.md'],
      changedLocators: ['src/web.ts'],
      tokenBudget: 96
    })
  });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.schemaVersion, '1.0.0');
  assert.equal(response.body.pack.targetHarness, 'codex');
  assert.deepEqual(response.body.pack.sourceHarnesses, ['codex']);
  assert.deepEqual(response.body.pack.requestedInputs.sourceHarnesses, ['codex']);
  assert.deepEqual(response.body.pack.requestedInputs.userSelectedLocators, ['user-selected://CONTEXT.md']);
  assert.deepEqual(response.body.pack.requestedInputs.changedLocators, ['workspace://src/web.ts']);
  assert.equal(response.body.pack.readFirst.every((item) => ['codex', 'generic-mcp'].includes(item.harness)), true);
  assert.equal(JSON.stringify(response.body.pack).includes('workspace://CLAUDE.md'), false);
  assert.equal(JSON.stringify(response.body.pack).includes('workspace://.cursor'), false);
  assert(response.body.pack.memoryPlan.items.some((item) => item.locator === 'user-selected://CONTEXT.md'));
  assert.deepEqual(response.body.pack.sourceGraph.impact.changedLocators, ['workspace://src/web.ts']);
  assert.deepEqual(response.body.pack.sourceGraph.impact.representedChangedLocators, ['workspace://src/web.ts']);
  assert.equal(response.body.pack.utility.status, 'ready');
  assert.deepEqual(response.body.pack.utility.changedLocatorCoverage, { total: 1, covered: 1, ratio: 1, status: 'covered' });
  const changedRead = response.body.pack.utility.requiredLocalReads.find((item) => item.locator === 'workspace://src/web.ts' && item.role === 'changed_locator');
  assert(changedRead);
  assert.equal(changedRead.represented, true);
  assert.match(changedRead.contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(changedRead.reasonCodes.includes('content_hash_verified'), true);
  assert(response.body.pack.handoff.launchPrompt.includes('Changed-file coverage: 1/1'));
  assert.equal(response.body.pack.objective.startsWith('raw_prompt_omitted:sha256:'), true);
  assert.equal(response.body.pack.step.startsWith('raw_prompt_omitted:sha256:'), true);
  assert.equal(response.body.pack.prompt.rawPromptIncluded, false);
  assert.match(response.body.pack.prompt.objectiveFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.match(response.body.pack.prompt.stepFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert(response.body.pack.handoff.commands.some((item) => item.includes("--changed 'src/web.ts'")));
  assert(response.body.pack.handoff.commands.some((item) => item.includes('REVIEWED_OBJECTIVE_OMITTED_FROM_API')));
  assert.equal(response.body.markdown.includes('## Change Impact'), true);
  assert.equal(response.body.markdown.includes('## Utility Read Plan'), true);
  assert.equal(/<objective>|<step>/u.test(response.body.markdown), false);
  assert.equal(response.text.includes('NOECHO_OBJ'), false);
  assert.equal(response.text.includes('NOECHO_STEP'), false);
  assert.equal(response.text.includes('/Users/'), false);
  assert.equal(response.body.pack.safeguards.externalWritesEnabled, false);
  assert.equal(response.body.pack.safeguards.externalAdaptersEnabled, 0);
  assert.equal(response.body.pack.safeguards.networkCalls, 0);
  assert.equal(response.body.pack.safeguards.modelCalls, 0);
  assert.equal(response.body.pack.safeguards.activeMemoryCreated, 0);
  assert.deepEqual(response.body.pack.safeguards, {
    persisted: false,
    modelCalls: 0,
    networkCalls: 0,
    sourceSnapshotsWritten: 0,
    activeMemoryCreated: 0,
    externalWritesEnabled: false,
    externalAdaptersEnabled: 0,
    rawBodyIncluded: false,
    contextPackWritten: false,
    sourceGraphPreviewed: true,
    graphDatabaseUsed: false,
    sourceSlicesRead: false
  });
  assert.equal(response.body.pack.delivery.representation, 'locator-handoff');
  assert.equal(response.body.pack.delivery.sourceContentTokenCountIncluded, 0);
  assert.equal(response.body.pack.delivery.sourceContentsIncluded, false);
  assert.equal(response.body.usePlan.resource.uri, 'oaf://workspace/ws_local/context-pack/use-plan/current');
  assert.equal(response.body.usePlan.contextPack.id, response.body.pack.id);
  assert.equal(response.body.usePlan.contextPack.fingerprint, response.body.pack.contextPackFingerprint);
  assert.equal(response.body.usePlan.requiredLocalReads.some((item) => item.locator === 'workspace://src/web.ts'), true);
  assert.equal(response.body.usePlan.requiredLocalReads.some((item) => item.locator === 'user-selected://CONTEXT.md'), true);
  assert.equal(response.body.usePlan.safeguards.localFilesWritten, 0);
  assert.equal(response.body.usePlan.safeguards.objectiveTextIncluded, false);
  assert.equal(response.body.usePlan.safeguards.stepTextIncluded, false);
  assert.equal(response.body.usePlan.safeguards.markdownContentIncluded, false);
  assert.equal(response.body.usePlan.safeguards.sourceContentIncluded, false);
  const usePlanText = JSON.stringify(response.body.usePlan);
  assert.equal(usePlanText.includes('prepare handoff'), false);
  assert.equal(usePlanText.includes('select useful context'), false);
  assert.equal(usePlanText.includes('API RAW AGENTS BODY'), false);
  assert.equal(usePlanText.includes('API RAW SELECTED BODY'), false);
  assert.equal(response.body.readback.command, 'mcp readback context-pack');
  assert.equal(response.body.readback.transport, 'in-process');
  assert.equal(response.body.readback.measurementScope, 'single local in-process bridge read');
  assert.equal(response.body.readback.resource.contextPackFingerprint, response.body.pack.contextPackFingerprint);
  assert.equal(response.body.readback.checks.contextPackFingerprintMatches, true);
  assert.equal(response.body.readback.checks.noToolsExposed, true);
  assert.equal(response.body.readback.checks.noMarkdownBody, true);
  assert.equal(response.body.readback.bridge.toolsExposed, 0);
  assert.equal(response.body.readback.safeguards.externalWritesEnabled, false);
  assert.equal(response.body.readback.safeguards.modelCalls, 0);
  assert.equal(response.body.readback.safeguards.networkCalls, 0);
  assert.equal(response.body.readback.safeguards.localFilesWritten, 0);
  assert(response.body.readback.measurements.resourceByteSize > 0);

  const memoryPreflight = await request(api.base, '/api/context/pack/memory-preflight', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base, cookie: api.auth.cookie, 'x-csrf-token': api.auth.csrf },
    body: JSON.stringify({
      workspaceId: 'ws_local',
      memoryConfig: {
        schemaVersion: '1.0.0',
        memoryPaths: [{ path: 'notes/memory.md', kind: 'preference', sourceTrust: 'unverified', dataClass: 'workspace-private' }]
      }
    })
  });
  assert.equal(memoryPreflight.status, 200, memoryPreflight.text);
  assert.equal(memoryPreflight.body.configured, true);
  assert.equal(memoryPreflight.body.state, 'review');
  assert.equal(memoryPreflight.body.summary.proposalCount, 1);
  assert.equal(memoryPreflight.body.summary.reviewItemCount, 1);
  assert.equal(memoryPreflight.body.safeguards.localFilesWritten, 0);
  assert.equal(memoryPreflight.body.safeguards.externalWritesEnabled, false);
  assert.equal(memoryPreflight.body.safeguards.externalAdaptersEnabled, 0);
  assert.equal(memoryPreflight.body.safeguards.networkCalls, 0);
  assert.equal(memoryPreflight.body.safeguards.modelCalls, 0);
  assert.equal(memoryPreflight.body.safeguards.activeMemoryCreated, 0);
  assert.match(memoryPreflight.body.reportFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.match(memoryPreflight.body.command, /memory proposals --from memoryPaths/);
  assert.equal(memoryPreflight.text.includes('API RAW MEMORY BODY'), false);
  assert.equal(memoryPreflight.text.includes('local-only context handoffs'), false);
  assert.equal(memoryPreflight.text.includes('/Users/'), false);
  assert.equal(memoryPreflight.text.includes('notes/memory.md'), false);

  const largeMemoryPreflight = await request(api.base, '/api/context/pack/memory-preflight', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base, cookie: api.auth.cookie, 'x-csrf-token': api.auth.csrf },
    body: JSON.stringify({
      workspaceId: 'ws_local',
      memoryConfig: { schemaVersion: '1.0.0', memoryPaths: [{ path: 'notes/large-memory.md', kind: 'episode' }] }
    })
  });
  assert.equal(largeMemoryPreflight.status, 200, largeMemoryPreflight.text);
  assert.equal(largeMemoryPreflight.body.summary.proposalCount, 1);
  assert.equal(largeMemoryPreflight.body.diagnostics.warningCodes.includes('memory_path_truncated_to_8_mib'), true);
  assert.equal(largeMemoryPreflight.body.safeguards.activeMemoryCreated, 0);
  assert.equal(largeMemoryPreflight.text.includes(largeMemoryTail), false);
  assert.equal(largeMemoryPreflight.text.includes('notes/large-memory.md'), false);

  const invalidMemoryPreflight = await request(api.base, '/api/context/pack/memory-preflight', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base, cookie: api.auth.cookie, 'x-csrf-token': api.auth.csrf },
    body: JSON.stringify({
      workspaceId: 'ws_local',
      memoryConfig: { schemaVersion: '1.0.0', memoryPaths: [{ path: '../private.md' }] }
    })
  });
  assert.equal(invalidMemoryPreflight.status, 400);
  assert.equal(invalidMemoryPreflight.body.error.code, 'request_validation_failed');

  assert.equal(response.text.includes('API RAW AGENTS BODY'), false);
  assert.equal(response.text.includes('API RAW SELECTED BODY'), false);
  assert.equal(response.text.includes('API RAW CLAUDE BODY'), false);
  assert.equal(response.text.includes('API RAW CURSOR BODY'), false);
  assert.equal(response.body.markdown.includes('# Context Pack'), true);
  assert.equal(api.store.updates, 0);
  assert.equal(api.calls.workflow, 0);

  const clientMetric = await request(api.base, '/api/context/pack', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base, cookie: api.auth.cookie, 'x-csrf-token': api.auth.csrf },
    body: JSON.stringify({
      workspaceId: 'ws_local',
      objective: 'prepare handoff',
      step: 'reject client metrics',
      targetHarness: 'codex',
      observedDurationMs: 1
    })
  });
  assert.equal(clientMetric.status, 400);
  assert.equal(clientMetric.body.error.code, 'request_validation_failed');
  assert.equal(api.store.updates, 0);

  const invalidFrom = await request(api.base, '/api/context/pack', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base, cookie: api.auth.cookie, 'x-csrf-token': api.auth.csrf },
    body: JSON.stringify({
      workspaceId: 'ws_local',
      objective: 'prepare handoff',
      step: 'reject invalid source family',
      targetHarness: 'codex',
      from: 'codex,evil'
    })
  });
  assert.equal(invalidFrom.status, 400);
  assert.equal(invalidFrom.body.error.code, 'request_validation_failed');
  assert.equal(api.store.updates, 0);
  assert.equal(api.calls.workflow, 0);

  const rejected = await request(api.base, '/api/context/pack', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base, cookie: api.auth.cookie, 'x-csrf-token': api.auth.csrf },
    body: JSON.stringify({
      workspaceId: 'ws_local',
      objective: 'prepare handoff',
      step: 'reject unsafe changed locator',
      targetHarness: 'codex',
      changedLocators: ['workspace://../secret.ts']
    })
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error.code, 'request_validation_failed');
  assert.equal(rejected.text.includes('secret.ts'), false);
  assert.equal(api.store.updates, 0);
  assert.equal(api.calls.workflow, 0);

  const unsafeField = await request(api.base, '/api/context/pack', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base, cookie: api.auth.cookie, 'x-csrf-token': api.auth.csrf },
    body: JSON.stringify({
      workspaceId: 'ws_local',
      objective: 'prepare token=secret-value',
      step: 'select context',
      targetHarness: 'codex'
    })
  });
  assert.equal(unsafeField.status, 400);
  assert.equal(unsafeField.body.error.code, 'request_validation_failed');
  assert.equal(unsafeField.body.error.issues[0].path, '$.body.objective');
  assert.equal(unsafeField.body.error.issues[0].code, 'context_pack_objective_unsafe');
  assert.equal(unsafeField.text.includes('secret-value'), false);
  assert.equal(api.store.updates, 0);
  assert.equal(api.calls.workflow, 0);
});

test('context pack registry status route is protected read-only and sanitized', async (t) => {
  const sourceGraphRoot = await mkdtemp(path.join(os.tmpdir(), 'oaf-api-context-registry-'));
  t.after(async () => rm(sourceGraphRoot, { recursive: true, force: true }));
  await mkdir(path.join(sourceGraphRoot, 'src'), { recursive: true });
  await writeFile(path.join(sourceGraphRoot, 'AGENTS.md'), 'API REGISTRY RAW AGENTS BODY should not leak.');
  await writeFile(path.join(sourceGraphRoot, 'CONTEXT.md'), 'API REGISTRY RAW SELECTED BODY should not leak.');
  await writeFile(path.join(sourceGraphRoot, 'src', 'web.ts'), 'export function registryStatusFixture(){ return true; }\n');
  const objective = 'private registry objective must not leak';
  const step = 'private registry step must not leak';
  const pinned = spawnSync(process.execPath, [
    'apps/cli/oaf.mjs',
    'context',
    'pack',
    '--root',
    sourceGraphRoot,
    '--from',
    'codex',
    '--objective',
    objective,
    '--step',
    step,
    '--target',
    'codex',
    '--include-file',
    'CONTEXT.md',
    '--changed',
    'src/web.ts',
    '--write',
    '--pin',
    '--out',
    'context-packs/CONTEXT_PACK.md',
    '--format',
    'json'
  ], { encoding: 'utf8', env: { ...process.env, OAF_FIXED_NOW: '2026-06-19T10:00:00.000Z' } });
  assert.equal(pinned.status, 0, pinned.stderr);

  const api = await startServer(t, { sourceGraphRoot });
  const denied = await request(api.base, '/api/context/pack/registry/status?workspaceId=ws_local');
  assert.equal(denied.status, 401);
  assert.equal(denied.body.error.code, 'authentication_required');

  const response = await request(api.base, '/api/context/pack/registry/status?workspaceId=ws_local', {
    method: 'GET',
    headers: { cookie: api.auth.cookie }
  });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.command, 'context registry status');
  assert.equal(response.body.current.status, 'verified');
  assert.equal(response.body.registry.entryCount, 1);
  assert.equal(response.body.safeguards.readOnly, true);
  assert.equal(response.body.safeguards.localFilesWritten, 0);
  assert.equal(response.body.safeguards.externalWritesEnabled, false);
  assert.equal(response.body.safeguards.externalAdaptersEnabled, 0);
  assert.equal(response.body.safeguards.networkCalls, 0);
  assert.equal(response.body.safeguards.modelCalls, 0);
  assert.equal(response.body.safeguards.markdownContentIncluded, false);
  assert.equal(response.body.safeguards.sourceContentIncluded, false);
  assert.equal(response.body.entries[0].sourceChecks.stale, 0);
  assert.equal(response.body.entries[0].sourceChecks.verifiedLocators.includes('workspace://src/web.ts'), true);
  assert.equal(response.text.includes('API REGISTRY RAW AGENTS BODY'), false);
  assert.equal(response.text.includes('API REGISTRY RAW SELECTED BODY'), false);
  assert.equal(response.text.includes(objective), false);
  assert.equal(response.text.includes(step), false);
  assert.equal(response.text.includes(sourceGraphRoot), false);
  assert.equal(response.text.includes('/Users/'), false);
  assert.equal(api.store.updates, 0);
  assert.equal(api.calls.workflow, 0);
  assert.equal(api.calls.compile, 0);
});

test('context pack pin route is protected and writes only fixed local artifacts', async (t) => {
  const sourceGraphRoot = await mkdtemp(path.join(os.tmpdir(), 'oaf-api-context-pack-pin-'));
  t.after(async () => rm(sourceGraphRoot, { recursive: true, force: true }));
  await mkdir(path.join(sourceGraphRoot, 'notes'), { recursive: true });
  await mkdir(path.join(sourceGraphRoot, 'src'), { recursive: true });
  await writeFile(path.join(sourceGraphRoot, 'AGENTS.md'), 'API PIN AGENTS RAW BODY should stay hidden.');
  await writeFile(path.join(sourceGraphRoot, 'notes', 'handoff.md'), 'API PIN SELECTED RAW BODY should stay hidden.');
  await writeFile(path.join(sourceGraphRoot, 'src', 'web.ts'), 'export const apiPinRawBody = true;\n');
  const api = await startServer(t, { sourceGraphRoot });

  const body = {
    workspaceId: 'ws_local',
    objective: 'NOECHO_PIN_OBJ handoff',
    step: 'NOECHO_PIN_STEP context',
    targetHarness: 'codex',
    from: 'codex',
    userSelectedFiles: ['notes/handoff.md'],
    changedLocators: ['src/web.ts'],
    tokenBudget: 256
  };

  const denied = await request(api.base, '/api/context/pack/pin', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base },
    body: JSON.stringify(body)
  });
  assert.equal(denied.status, 401);
  assert.equal(denied.body.error.code, 'authentication_required');

  const csrfDenied = await request(api.base, '/api/context/pack/pin', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base, cookie: api.auth.cookie },
    body: JSON.stringify(body)
  });
  assert.equal(csrfDenied.status, 403);
  assert.equal(csrfDenied.body.error.code, 'csrf_failed');

  const rejectedRoot = await request(api.base, '/api/context/pack/pin', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base, cookie: api.auth.cookie, 'x-csrf-token': api.auth.csrf },
    body: JSON.stringify({ ...body, root: sourceGraphRoot })
  });
  assert.equal(rejectedRoot.status, 400);
  assert.equal(rejectedRoot.body.error.code, 'request_validation_failed');
  assert.equal(rejectedRoot.text.includes(sourceGraphRoot), false);

  const response = await request(api.base, '/api/context/pack/pin', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base, cookie: api.auth.cookie, 'x-csrf-token': api.auth.csrf },
    body: JSON.stringify(body)
  });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.schemaVersion, '1.0.0');
  assert.equal(response.body.pin.pinned, true);
  assert.equal(response.body.pin.localFilesWritten, 4);
  assert.equal(response.body.pin.registryStatus.current.status, 'verified');
  assert.equal(response.body.registryStatus.current.status, 'verified');
  assert.deepEqual(response.body.pin.artifacts.map((item) => item.locator).sort(), [
    'workspace://context-packs/CONTEXT_PACK.md',
    'workspace://context-packs/CONTEXT_PACK.use.json',
    'workspace://context-packs/current.json',
    'workspace://context-packs/registry.json'
  ].sort());
  assert.equal(response.body.pack.objective.startsWith('raw_prompt_omitted:sha256:'), true);
  assert.equal(response.body.pack.prompt.rawPromptIncluded, false);
  assert.equal(response.body.usePlan.safeguards.objectiveTextIncluded, false);
  assert.equal(response.body.pin.safeguards.localFilesWritten, 4);
  assert.equal(response.body.pin.safeguards.externalWritesEnabled, false);
  assert.equal(response.body.pin.safeguards.externalAdaptersEnabled, 0);
  assert.equal(response.body.pin.safeguards.networkCalls, 0);
  assert.equal(response.body.pin.safeguards.modelCalls, 0);
  const pinnedMarkdown = await readFile(path.join(sourceGraphRoot, 'context-packs', 'CONTEXT_PACK.md'), 'utf8');
  const pinnedUsePlan = JSON.parse(await readFile(path.join(sourceGraphRoot, 'context-packs', 'CONTEXT_PACK.use.json'), 'utf8'));
  assert.match(pinnedMarkdown, /# Context Pack/);
  assert.equal(pinnedUsePlan.contextPack.fingerprint, response.body.pack.contextPackFingerprint);
  const receiveDenied = await request(api.base, '/api/context/pack/receive?workspaceId=ws_local');
  assert.equal(receiveDenied.status, 401);
  assert.equal(receiveDenied.body.error.code, 'authentication_required');
  const received = await request(api.base, '/api/context/pack/receive?workspaceId=ws_local', {
    headers: { cookie: api.auth.cookie }
  });
  assert.equal(received.status, 200, received.text);
  assert.equal(received.body.command, 'context receive');
  assert.equal(received.body.state, 'ready');
  assert.equal(received.body.receiverPacket.state, 'ready');
  assert.equal(received.body.receiverPacket.proof.toolsExposed, 0);
  assert.equal(received.body.receiverPacket.readPlan.requiredReads.some((item) => item.locator === 'workspace://src/web.ts'), true);
  assert.deepEqual(received.body.receiverPacket.messageParts.map((item) => item.partType), ['summary', 'proof', 'read_plan', 'next_actions']);
  assert.equal(received.body.receiverPacket.messageParts.find((item) => item.partType === 'read_plan').readPlan.requiredReads.some((item) => item.locator === 'workspace://src/web.ts'), true);
  assert.equal(received.body.safeguards.readOnly, true);
  assert.equal(received.body.safeguards.localFilesWritten, 0);
  assert.equal(received.body.safeguards.externalWritesEnabled, false);
  assert.equal(received.body.safeguards.networkCalls, 0);
  assert.equal(received.body.safeguards.modelCalls, 0);
  for (const forbidden of ['NOECHO_PIN_OBJ', 'NOECHO_PIN_STEP', 'API PIN AGENTS RAW BODY', 'API PIN SELECTED RAW BODY', 'apiPinRawBody', sourceGraphRoot, '/Users/rebel']) {
    assert.equal(response.text.includes(forbidden), false, forbidden);
    assert.equal(received.text.includes(forbidden), false, forbidden);
  }
  assert.equal(api.store.updates, 0);
  assert.equal(api.calls.workflow, 0);
});

test('git changed-locator detection route is opt-in protected and read-only', async (t) => {
  const sourceGraphRoot = await mkdtemp(path.join(os.tmpdir(), 'oaf-api-git-changes-'));
  t.after(async () => rm(sourceGraphRoot, { recursive: true, force: true }));
  await mkdir(path.join(sourceGraphRoot, 'src'), { recursive: true });
  await mkdir(path.join(sourceGraphRoot, 'secrets'), { recursive: true });
  const git = spawnSync('git', ['init'], { cwd: sourceGraphRoot, encoding: 'utf8' });
  if (git.status !== 0) return;
  await writeFile(path.join(sourceGraphRoot, 'src', 'web.ts'), 'export const apiGitChangedSymbol = true;\n');
  await writeFile(path.join(sourceGraphRoot, '.env'), 'OAF_API_SECRET=secret-value\n');
  await writeFile(path.join(sourceGraphRoot, 'secrets', 'token.ts'), 'export const token = "secret";\n');
  const api = await startServer(t, { sourceGraphRoot });
  const denied = await request(api.base, '/api/context/git-changes', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base },
    body: JSON.stringify({ workspaceId: 'ws_local' })
  });
  assert.equal(denied.status, 401);
  assert.equal(denied.body.error.code, 'authentication_required');

  const response = await request(api.base, '/api/context/git-changes', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base, cookie: api.auth.cookie, 'x-csrf-token': api.auth.csrf },
    body: JSON.stringify({ workspaceId: 'ws_local' })
  });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.schemaVersion, '1.0.0');
  assert.equal(response.body.command, 'git changed locators');
  assert.equal(response.body.status, 'available');
  assert.equal(response.body.source, 'git-status-porcelain');
  assert.equal(response.body.changedLocators.includes('workspace://src/web.ts'), true);
  assert.equal(response.body.changedLocators.some((locator) => locator.includes('.env') || locator.includes('secrets/')), false);
  assert(response.body.skippedCount >= 1);
  assert.equal(response.body.safeguards.readOnly, true);
  assert.equal(response.body.safeguards.canonicalStateMutated, false);
  assert.equal(response.body.safeguards.localFilesWritten, 0);
  assert.equal(response.body.safeguards.externalWritesEnabled, false);
  assert.equal(response.body.safeguards.externalAdaptersEnabled, 0);
  assert.equal(response.body.safeguards.networkCalls, 0);
  assert.equal(response.body.safeguards.modelCalls, 0);
  assert.equal(response.body.safeguards.rawBodyIncluded, false);
  assert.equal(response.body.safeguards.absoluteFilesystemLocationsIncluded, false);
  assert.equal(response.text.includes('secret-value'), false);
  assert.equal(response.text.includes(sourceGraphRoot), false);
  assert.equal(response.text.includes('/Users/'), false);
  assert.equal(api.store.updates, 0);
  assert.equal(api.calls.workflow, 0);

  const rejectedRoot = await request(api.base, '/api/context/git-changes', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base, cookie: api.auth.cookie, 'x-csrf-token': api.auth.csrf },
    body: JSON.stringify({ workspaceId: 'ws_local', root: sourceGraphRoot })
  });
  assert.equal(rejectedRoot.status, 400);
  assert.equal(rejectedRoot.body.error.code, 'request_validation_failed');
  assert.equal(rejectedRoot.text.includes(sourceGraphRoot), false);
  assert.equal(api.store.updates, 0);
  assert.equal(api.calls.workflow, 0);
});

test('context graph preview route is protected bounded and does not mutate run state', async (t) => {
  const sourceGraphRoot = await mkdtemp(path.join(os.tmpdir(), 'oaf-api-source-graph-'));
  t.after(async () => rm(sourceGraphRoot, { recursive: true, force: true }));
  await mkdir(path.join(sourceGraphRoot, 'src'), { recursive: true });
  await writeFile(path.join(sourceGraphRoot, 'src', 'auth.ts'), [
    'export class TokenResetService {',
    '  approveTokenReset(request: ResetRequest) {',
    "    return { ok: true, secret: 'API GRAPH RAW BODY' };",
    '  }',
    '}'
  ].join('\n'));
  await writeFile(path.join(sourceGraphRoot, 'src', 'workflow.ts'), [
    "import { TokenResetService } from './auth';",
    'export function runAuthWorkflow(request: ResetRequest) {',
    '  const service = new TokenResetService();',
    '  return service.approveTokenReset(request);',
    '}'
  ].join('\n'));
  const api = await startServer(t, { sourceGraphRoot });
  const denied = await request(api.base, '/api/context/graph/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base },
    body: JSON.stringify({ workspaceId: 'ws_local', query: 'approve token reset' })
  });
  assert.equal(denied.status, 401);
  assert.equal(denied.body.error.code, 'authentication_required');

  const rejectedRoot = await request(api.base, '/api/context/graph/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base, cookie: api.auth.cookie, 'x-csrf-token': api.auth.csrf },
    body: JSON.stringify({ workspaceId: 'ws_local', root: '/Users/rebel/private', query: 'approve token reset' })
  });
  assert.equal(rejectedRoot.status, 400);
  assert.equal(rejectedRoot.body.error.code, 'request_validation_failed');

  const response = await request(api.base, '/api/context/graph/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base, cookie: api.auth.cookie, 'x-csrf-token': api.auth.csrf },
    body: JSON.stringify({
      workspaceId: 'ws_local',
      query: 'approve token reset workflow',
      startName: 'runAuthWorkflow',
      changedLocators: ['src/auth.ts'],
      sampleLimit: 3
    })
  });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.schemaVersion, '1.0.0');
  assert.equal(response.body.safeguards.persisted, false);
  assert.equal(response.body.safeguards.modelCalls, 0);
  assert.equal(response.body.safeguards.networkCalls, 0);
  assert.equal(response.body.safeguards.externalAdaptersEnabled, 0);
  assert.equal(response.body.safeguards.externalWritesEnabled, false);
  assert(response.body.search.results.some((item) => item.label.includes('approveTokenReset')));
  assert(response.body.trace.paths.some((item) => item.terminalLabel === 'approveTokenReset'));
  assert.deepEqual(response.body.impact.representedChangedLocators, ['workspace://src/auth.ts']);
  assert(response.body.impact.affectedSymbols.some((item) => item.name === 'approveTokenReset'));
  assert.equal(response.text.includes('API GRAPH RAW BODY'), false);
  assert.equal(response.text.includes(sourceGraphRoot), false);
  assert.equal(api.store.updates, 0);
  assert.equal(api.calls.workflow, 0);
  assert.equal(api.calls.compile, 0);
});

test('context graph preview route returns sanitized unavailable preview when source root disappears', async (t) => {
  const sourceGraphRoot = await mkdtemp(path.join(os.tmpdir(), 'oaf-api-source-graph-missing-'));
  await mkdir(path.join(sourceGraphRoot, 'src'), { recursive: true });
  await writeFile(path.join(sourceGraphRoot, 'src', 'auth.ts'), 'export const vanishedRoot = true;\n');
  const api = await startServer(t, { sourceGraphRoot });
  await rm(sourceGraphRoot, { recursive: true, force: true });

  const response = await request(api.base, '/api/context/graph/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base, cookie: api.auth.cookie, 'x-csrf-token': api.auth.csrf },
    body: JSON.stringify({ workspaceId: 'ws_local', query: 'vanished root', changedLocators: ['src/auth.ts'] })
  });

  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.schemaVersion, '1.0.0');
  assert.equal(response.body.graph.summary.fileCount, 0);
  assert.equal(response.body.graph.diagnostics.some((item) => String(item.code).startsWith('source_graph_unavailable')), true);
  assert.deepEqual(response.body.impact.representedChangedLocators, []);
  assert.equal(response.text.includes(sourceGraphRoot), false);
  assert.equal(response.text.includes('/Users/'), false);
  assert.equal(api.store.updates, 0);
  assert.equal(api.calls.workflow, 0);
  assert.equal(api.calls.compile, 0);
});

test('harness setup plan route is protected plan-only and does not expose home config bodies', async (t) => {
  const harnessSetupHome = await mkdtemp(path.join(os.tmpdir(), 'oaf-api-harness-home-'));
  t.after(async () => rm(harnessSetupHome, { recursive: true, force: true }));
  await mkdir(path.join(harnessSetupHome, '.cursor'), { recursive: true });
  const configPath = path.join(harnessSetupHome, '.cursor', 'mcp.json');
  const configBody = JSON.stringify({
    mcpServers: {
      other: {
        command: '/Users/rebel/private-tool',
        args: ['token=secret-value'],
        env: { OPENAI_API_KEY: 'secret-value' }
      }
    }
  }, null, 2);
  await writeFile(configPath, configBody);
  const api = await startServer(t, { harnessSetupHome });

  const denied = await request(api.base, '/api/harness/setup/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base },
    body: JSON.stringify({ workspaceId: 'ws_local', client: 'cursor' })
  });
  assert.equal(denied.status, 401);
  assert.equal(denied.body.error.code, 'authentication_required');

  const csrfDenied = await request(api.base, '/api/harness/setup/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base, cookie: api.auth.cookie },
    body: JSON.stringify({ workspaceId: 'ws_local', client: 'cursor' })
  });
  assert.equal(csrfDenied.status, 403);
  assert.equal(csrfDenied.body.error.code, 'csrf_failed');

  for (const extra of [{ home: harnessSetupHome }, { configPath: '.cursor/mcp.json' }, { write: true }, { server: 'other' }, { dryRun: true }]) {
    const rejected = await request(api.base, '/api/harness/setup/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: api.base, cookie: api.auth.cookie, 'x-csrf-token': api.auth.csrf },
      body: JSON.stringify({ workspaceId: 'ws_local', client: 'cursor', ...extra })
    });
    assert.equal(rejected.status, 400, JSON.stringify(extra));
    assert.equal(rejected.body.error.code, 'request_validation_failed');
  }

  const response = await request(api.base, '/api/harness/setup/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base, cookie: api.auth.cookie, 'x-csrf-token': api.auth.csrf },
    body: JSON.stringify({ workspaceId: 'ws_local', client: 'cursor' })
  });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.schemaVersion, '1.0.0');
  assert.equal(response.body.command, 'harness setup plan');
  assert.equal(response.body.dryRun, true);
  assert.equal(response.body.client, 'cursor');
  assert.equal(response.body.server, 'oaf');
  assert.equal(response.body.bridgeMode, 'resources');
  assert.equal(response.body.config.ref, 'home://.cursor/mcp.json');
  assert.equal(response.body.config.serverCount, 1);
  assert.equal(response.body.diff.redacted, true);
  assert.deepEqual(response.body.diff.operations, [{ op: 'add', target: 'mcpServers.oaf', before: 'absent', after: 'read-only-oaf-mcp-stdio', summary: 'add oaf with read-only OAF MCP stdio resource bridge' }]);
  assert.equal(response.body.desiredServer.command, 'npm');
  assert.deepEqual(response.body.desiredServer.args, ['--silent', 'run', 'oaf', '--', 'mcp', 'resources', '--read-only', '--stdio']);
  assert.equal(response.body.desiredHooks.supported, false);
  assert.equal(response.body.desiredHooks.authority, 'none');
  assert.equal(response.body.manualHookSnippet.applyMode, 'manual-copy');
  assert.equal(response.body.manualConfigSnippet.format, 'json');
  assert.equal(response.body.manualConfigSnippet.configRef, 'home://.cursor/mcp.json');
  assert.equal(response.body.manualConfigSnippet.applyMode, 'manual-copy');
  const snippet = JSON.parse(response.body.manualConfigSnippet.content);
  assert.deepEqual(Object.keys(snippet.mcpServers), ['oaf']);
  assert.equal(snippet.mcpServers.oaf.command, 'npm');
  assert.deepEqual(snippet.mcpServers.oaf.args, ['--silent', 'run', 'oaf', '--', 'mcp', 'resources', '--read-only', '--stdio']);
  assert.match(response.body.planFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(response.body.safeguards.localFilesWritten, 0);
  assert.equal(response.body.safeguards.homeConfigMutated, false);
  assert.equal(response.body.safeguards.externalWritesEnabled, false);
  assert.equal(response.body.safeguards.externalAdaptersEnabled, 0);
  assert.equal(await readFile(configPath, 'utf8'), configBody);
  assert.equal(response.text.includes(harnessSetupHome), false);
  assert.equal(response.text.includes('/Users/rebel/private-tool'), false);
  assert.equal(response.text.includes('secret-value'), false);
  assert.equal(response.text.includes('OPENAI_API_KEY'), false);
  assert.equal(response.text.includes('other-secret'), false);
  assert.equal(response.text.includes('npx'), false);
  assert.equal(response.text.includes('uvx'), false);
  assert.equal(response.text.includes('curl'), false);
  assert.equal(api.store.updates, 0);
  assert.equal(api.calls.workflow, 0);
  assert.equal(api.calls.compile, 0);
});

test('context pack and graph preview authorize context resources', async (t) => {
  const sourceGraphRoot = await mkdtemp(path.join(os.tmpdir(), 'oaf-api-context-policy-'));
  t.after(async () => rm(sourceGraphRoot, { recursive: true, force: true }));
  const harnessSetupHome = await mkdtemp(path.join(os.tmpdir(), 'oaf-api-context-policy-home-'));
  t.after(async () => rm(harnessSetupHome, { recursive: true, force: true }));
  await mkdir(path.join(sourceGraphRoot, 'src'), { recursive: true });
  await mkdir(path.join(sourceGraphRoot, 'notes'), { recursive: true });
  await writeFile(path.join(sourceGraphRoot, 'src', 'index.ts'), 'export function buildContextPackPolicyFixture(){ return true; }\n');
  await writeFile(path.join(sourceGraphRoot, 'notes', 'memory.md'), 'Remember to keep context packs local-only.');
  const policyRequests = [];
  const policyService = {
    async evaluate(request) {
      policyRequests.push(request);
      return {
        outcome: 'allow',
        reasonCodes: [],
        policyVersion: '1.0.0',
        policyFingerprint: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        resource: request.resource
      };
    }
  };
  const api = await startServer(t, { sourceGraphRoot, harnessSetupHome, policyService });

  const pack = await request(api.base, '/api/context/pack', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base, cookie: api.auth.cookie, 'x-csrf-token': api.auth.csrf },
    body: JSON.stringify({
      workspaceId: 'ws_local',
      objective: 'prepare handoff',
      step: 'select useful context',
      targetHarness: 'codex',
      tokenBudget: 96
    })
  });
  assert.equal(pack.status, 200, pack.text);

  const registryStatus = await request(api.base, '/api/context/pack/registry/status?workspaceId=ws_local', {
    method: 'GET',
    headers: { cookie: api.auth.cookie }
  });
  assert.equal(registryStatus.status, 200, registryStatus.text);

  const memoryPreflight = await request(api.base, '/api/context/pack/memory-preflight', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base, cookie: api.auth.cookie, 'x-csrf-token': api.auth.csrf },
    body: JSON.stringify({
      workspaceId: 'ws_local',
      memoryConfig: { schemaVersion: '1.0.0', memoryPaths: [{ path: 'notes/memory.md' }] }
    })
  });
  assert.equal(memoryPreflight.status, 200, memoryPreflight.text);

  const gitChanges = await request(api.base, '/api/context/git-changes', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base, cookie: api.auth.cookie, 'x-csrf-token': api.auth.csrf },
    body: JSON.stringify({ workspaceId: 'ws_local' })
  });
  assert.equal(gitChanges.status, 200, gitChanges.text);

  const graph = await request(api.base, '/api/context/graph/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base, cookie: api.auth.cookie, 'x-csrf-token': api.auth.csrf },
    body: JSON.stringify({ workspaceId: 'ws_local', query: 'context pack policy' })
  });
  assert.equal(graph.status, 200, graph.text);

  const sourcePreview = await request(api.base, '/api/context/source-preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base, cookie: api.auth.cookie, 'x-csrf-token': api.auth.csrf },
    body: JSON.stringify({ workspaceId: 'ws_local', objective: 'context policy preview', step: 'source preview' })
  });
  assert.equal(sourcePreview.status, 200, sourcePreview.text);

  const harness = await request(api.base, '/api/harness/setup/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base, cookie: api.auth.cookie, 'x-csrf-token': api.auth.csrf },
    body: JSON.stringify({ workspaceId: 'ws_local', client: 'codex' })
  });
  assert.equal(harness.status, 200, harness.text);

  assert.deepEqual(
    policyRequests
      .filter((item) => ['buildContextPack', 'getContextPackRegistryStatus', 'preflightContextPackMemory', 'previewContextSources', 'detectGitChanges', 'previewContextGraph', 'planHarnessSetup'].includes(item.operationId))
      .map((item) => [item.operationId, item.action, item.resource.type]),
    [
      ['buildContextPack', 'context.compile', 'context'],
      ['getContextPackRegistryStatus', 'context.compile', 'context'],
      ['preflightContextPackMemory', 'context.compile', 'context'],
      ['detectGitChanges', 'context.compile', 'context'],
      ['previewContextGraph', 'context.compile', 'context'],
      ['previewContextSources', 'context.compile', 'context'],
      ['planHarnessSetup', 'workspace.read', 'workspace']
    ]
  );
});

test('dashboard counters are scoped to the authorized workspace', async (t) => {
  const api = await startServer(t);
  api.store.state.memories = [
    { id: 'mem_local', workspaceId: 'ws_local', status: 'active' },
    { id: 'mem_other', workspaceId: 'ws_other', status: 'active' }
  ];
  api.store.state.approvals = [
    { id: 'apr_local_pending', workspaceId: 'ws_local', status: 'pending' },
    { id: 'apr_local_done', workspaceId: 'ws_local', status: 'approved' },
    { id: 'apr_other_pending', workspaceId: 'ws_other', status: 'pending' }
  ];

  const response = await request(api.base, '/api/dashboard?workspaceId=ws_local', {
    headers: { cookie: api.auth.cookie }
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.metrics.memories, 1);
  assert.equal(response.body.metrics.pendingApprovals, 1);
  assert.deepEqual(response.body.memories.map((item) => item.id), ['mem_local']);
  assert.deepEqual(response.body.approvals.map((item) => item.id).sort(), ['apr_local_done', 'apr_local_pending']);
});

test('loop workbench endpoint returns read-only local projection', async (t) => {
  const api = await startServer(t);
  api.store.state.events = [
    { id: 'evt_loop_a', workspaceId: 'ws_local', runId: 'run_loop', type: 'loop.verification_reported', payload: {} },
    { id: 'evt_other', workspaceId: 'ws_other', runId: 'run_other', type: 'loop.verification_reported', payload: {} }
  ];
  const response = await request(api.base, '/api/loop/workbench?workspaceId=ws_local', {
    headers: { cookie: api.auth.cookie }
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.schemaVersion, '1.0.0');
  assert.equal(response.body.workspaceId, 'ws_local');
  assert.equal(response.body.verification.autoMerge, false);
  assert.equal(response.body.trace.eventCount, 1);
  assert.equal(response.body.stopReasons.includes('unrelated_changes'), true);
  assert.equal(response.body.safeguards.externalWritesEnabled, false);
});

test('start-run validates input and propagates API correlation into persisted events', async (t) => {
  const api = await startServer(t);
  const response = await request(api.base, '/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base, cookie: api.auth.cookie, 'x-csrf-token': api.auth.csrf, 'x-correlation-id': 'req_client-00000000-0000-4000-8000-000000000002' },
    body: JSON.stringify({ workspaceId: 'ws_local', workflowId: 'workflow:content-intelligence', objective: 'local agents' })
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('x-correlation-id'), 'req_client-00000000-0000-4000-8000-000000000002');
  assert.equal(response.body.events[0].correlationId, 'req_client-00000000-0000-4000-8000-000000000002');
  assert.equal(api.store.state.events[0].correlationId, 'req_client-00000000-0000-4000-8000-000000000002');
  assert.equal(api.calls.workflow, 1);
});

test('stable sanitized errors never reflect invalid correlation IDs or sensitive internals', async (t) => {
  const api = await startServer(t, { runWorkflow: async () => { throw new Error('boom /Users/rebel/secret token=abc SELECT * FROM private'); } });
  const invalidJson = await request(api.base, '/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-correlation-id': 'bad secret id' },
    body: '{'
  });
  assert.equal(invalidJson.status, 400);
  assert.equal(invalidJson.body.schemaVersion, '1.0.0');
  assert.equal(invalidJson.body.error.code, 'invalid_json');
  assert.match(invalidJson.body.error.correlationId, /^req_/);
  assert.notEqual(invalidJson.body.error.correlationId, 'bad secret id');
  assert.equal(invalidJson.headers.get('x-correlation-id'), invalidJson.body.error.correlationId);
  assert.equal(invalidJson.text.includes('bad secret id'), false);
  assert.equal(api.calls.workflow, 0);

  const internal = await request(api.base, '/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base, cookie: api.auth.cookie, 'x-csrf-token': api.auth.csrf },
    body: JSON.stringify({ workspaceId: 'ws_local', objective: 'safe' })
  });
  assert.equal(internal.status, 500);
  assert.equal(internal.body.error.code, 'internal_error');
  assert.equal(/\/Users\/rebel|SELECT \*|token=abc|Error: boom/.test(internal.text), false);
});

test('boundary rejects malformed bodies before domain execution', async (t) => {
  const cases = [
    ['empty required body', '/api/context/compile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '' }, 400, 'request_validation_failed'],
    ['wrong top-level type', '/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[]' }, 400, 'request_validation_failed'],
    ['unknown property', '/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ unexpected: true }) }, 400, 'request_validation_failed'],
    ['missing required property', '/api/context/compile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request: validContextPayload().request }) }, 400, 'request_validation_failed'],
    ['oversized objective', '/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ objective: 'x'.repeat(80) }) }, 400, 'request_validation_failed'],
    ['oversized array', '/api/context/compile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...validContextPayload(), records: new Array(8).fill(validContextPayload().records[0]) }) }, 400, 'request_validation_failed'],
    ['excessive depth', '/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ objective: 'ok', metadata: { a: { b: { c: { d: { e: true } } } } } }) }, 400, 'request_validation_failed'],
    ['excessive nodes', '/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ objective: 'ok', extra: Object.fromEntries(Array.from({ length: 90 }, (_, i) => [`k${i}`, i])) }) }, 400, 'request_validation_failed'],
    ['unsupported workflow', '/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workflowId: 'workflow:remote-publish' }) }, 400, 'request_validation_failed']
  ];

  for (const [name, pathName, init, status, code] of cases) {
    const api = await startServer(t);
    const response = await request(api.base, pathName, init);
    assert.equal(response.status, status, name);
    assert.equal(response.body.error.code, code, name);
    assert.match(response.headers.get('x-correlation-id'), /^req_/, name);
    assert.equal(response.text.includes('x'.repeat(40)), false, name);
    assert.equal(api.calls.workflow, 0, name);
    assert.equal(api.calls.compile, 0, name);
    assert.equal(api.store.reads + api.store.updates + api.store.resets, 0, name);
  }

  const api = await startServer(t);
  const unexpectedGetBody = await rawRequest(api.base, '/api/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, chunks: ['{}'] });
  assert.equal(unexpectedGetBody.status, 400);
  assert.equal(unexpectedGetBody.body.error.code, 'request_validation_failed');
  assert.equal(api.store.reads + api.store.updates + api.store.resets, 0);
});

test('request size, media type, charset, and encoding are enforced before handlers', async (t) => {
  const api = await startServer(t);
  const tooLargeByLength = await request(api.base, '/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ objective: 'x'.repeat(4096) })
  });
  assert.equal(tooLargeByLength.status, 413);
  assert.equal(tooLargeByLength.body.error.code, 'request_too_large');
  assert.equal(api.calls.workflow, 0);

  const chunkedTooLarge = await rawRequest(api.base, '/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    chunks: ['{"objective":"', 'x'.repeat(3000), '"}']
  });
  assert.equal(chunkedTooLarge.status, 413);
  assert.equal(chunkedTooLarge.body.error.code, 'request_too_large');

  for (const [headers, expectedCode] of [
    [{ 'content-type': 'text/plain' }, 'unsupported_media_type'],
    [{ 'content-type': 'application/json; charset=utf-16' }, 'unsupported_media_type'],
    [{ 'content-type': 'application/json', 'content-encoding': 'gzip' }, 'unsupported_content_encoding']
  ]) {
    const response = await request(api.base, '/api/runs', { method: 'POST', headers, body: '{}' });
    assert.equal(response.status, 415);
    assert.equal(response.body.error.code, expectedCode);
  }
  assert.equal(api.calls.workflow, 0);
});

test('path, query, host, origin, and method validation are fail-closed', async (t) => {
  const api = await startServer(t);
  const pathCases = [
    ['/api/runs/%E0%A4%A', 400, 'invalid_path_parameter'],
    ['/api/runs/run%2Fsecret', 400, 'invalid_path_parameter'],
    ['/api/runs/..%2e', 400, 'invalid_path_parameter'],
    ['/api/runs/run_invalid!', 400, 'invalid_path_parameter'],
    ['/api/runs/run_missing?extra=1', 400, 'request_validation_failed'],
    ['/api/runs/run_missing?limit=1&limit=2', 400, 'request_validation_failed'],
    ['/api/nope', 404, 'route_not_found']
  ];
  for (const [pathName, status, code] of pathCases) {
    const response = await request(api.base, pathName);
    assert.equal(response.status, status, pathName);
    assert.equal(response.body.error.code, code, pathName);
    assert.equal(api.store.reads, 0, pathName);
  }

  const method = await request(api.base, '/api/health', { method: 'POST' });
  assert.equal(method.status, 405);
  assert.equal(method.body.error.code, 'method_not_allowed');
  assert.equal(method.headers.get('allow'), 'GET');

  const originRejected = await request(api.base, '/api/reset?workspaceId=ws_local', { method: 'POST', headers: { origin: 'https://evil.test' } });
  assert.equal(originRejected.status, 400);
  assert.equal(originRejected.body.error.code, 'request_validation_failed');
  assert.equal(api.store.resets, 0);

  const noOriginAccepted = await request(api.base, '/api/reset?workspaceId=ws_local', { method: 'POST', headers: { cookie: api.auth.cookie, 'x-csrf-token': api.auth.csrf } });
  assert.equal(noOriginAccepted.status, 200);
  assert.equal(api.store.resets, 1);
});

test('response validation fails closed with sanitized internal_error', async (t) => {
  const api = await startServer(t, { compileContext: () => ({ malformed: true }) });
  const response = await request(api.base, '/api/context/compile', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base, cookie: api.auth.cookie, 'x-csrf-token': api.auth.csrf },
    body: JSON.stringify(validContextPayload())
  });
  assert.equal(response.status, 500);
  assert.equal(response.body.error.code, 'internal_error');
  assert.equal(response.text.includes('malformed'), false);
  assert.equal(api.calls.logs.some((item) => item.entry.code === 'response_validation_failed'), true);
});

test('SSE uses boundary headers and cleans up on disconnect', async (t) => {
  const api = await startServer(t);
  const url = new URL('/api/stream?workspaceId=ws_local', api.base);
  const req = http.request({ hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method: 'GET', headers: { cookie: api.auth.cookie } });
  const resPromise = once(req, 'response');
  req.end();
  const [res] = await resPromise;
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'text/event-stream');
  assert.match(res.headers['x-correlation-id'], /^req_/);
  await once(res, 'data');
  assert.equal(api.activeStreamCount(), 1);
  res.destroy();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(api.activeStreamCount(), 0);
});

test('runtime route registry and OpenAPI implemented routes stay in parity', async () => {
  const openapi = await readFile('docs/api/openapi.yaml', 'utf8');
  const openApiOperations = [...openapi.matchAll(/^\s{4}(get|post|delete):\n\s{6}operationId:\s*([A-Za-z0-9_-]+)/gm)]
    .map((match) => `${match[1].toUpperCase()} ${match[2]}`)
    .sort();
  const registryOperations = API_ROUTE_CONTRACTS.map((contract) => `${contract.method} ${contract.operationId}`).sort();
  assert.deepEqual(openApiOperations, registryOperations);
  assert.equal(new Set(API_ROUTE_CONTRACTS.map((contract) => `${contract.method} ${contract.path}`)).size, API_ROUTE_CONTRACTS.length);
});

test('external adapters remain disabled', async () => {
  const catalog = JSON.parse(await readFile('adapters/catalog.json', 'utf8'));
  assert.equal(catalog.adapters.filter((adapter) => adapter.enabledByDefault).length, 0);
});
