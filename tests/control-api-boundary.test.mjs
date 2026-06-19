import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createControlApiServer } from '../services/control-api/src/server.mjs';
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

async function startServer(t, overrides = {}) {
  const store = overrides.store ?? new SpyStore();
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
    workspaceId: 'ws_local',
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
