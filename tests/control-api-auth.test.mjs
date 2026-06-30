import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createControlApiServer } from '../services/control-api/src/server.mjs';
import { LocalIdentityStore } from '../providers/native/identity-local/src/index.mjs';

const password = 'correct horse battery staple';

class SpyStore {
  constructor() {
    this.state = { schemaVersion: '1.0.0', runs: [], events: [], memories: [], approvals: [], artifacts: [] };
    this.reads = 0;
    this.updates = 0;
    this.resets = 0;
  }
  async read() { this.reads += 1; return structuredClone(this.state); }
  async update(mutator) {
    this.updates += 1;
    this.state = await mutator(structuredClone(this.state));
    return structuredClone(this.state);
  }
  async reset() {
    this.resets += 1;
    this.state = { schemaVersion: '1.0.0', runs: [], events: [], memories: [], approvals: [], artifacts: [] };
    return structuredClone(this.state);
  }
}

async function startServer(t, { bootstrapped = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaf-api-auth-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const identityStore = await new LocalIdentityStore({
    directory: root,
    clock: () => '2026-06-19T10:00:00.000Z',
    scrypt: { N: 1024, r: 8, p: 1, keyLength: 32 }
  }).init();
  let owner = null;
  if (bootstrapped) {
    owner = await identityStore.bootstrapOwner({
      username: 'owner',
      displayName: 'Local Owner',
      password,
      workspaceId: 'ws_local',
      workspaceName: 'Local Workspace'
    });
    const auditor = await identityStore.createUser({ username: 'auditor', displayName: 'Local Auditor', password, status: 'active' });
    await identityStore.putWorkspace({ id: 'ws_other', name: 'Other Workspace' });
    await identityStore.putMembership({ userId: auditor.user.id, workspaceId: 'ws_local', role: 'auditor', status: 'active' });
  }

  const store = new SpyStore();
  const calls = { workflow: 0, compile: 0, logs: [] };
  const runWorkflow = async ({ objective, workspaceId, actorId, emit }) => {
    calls.workflow += 1;
    await emit({
      schemaVersion: '1.0.0',
      id: 'evt_auth_run',
      workspaceId,
      type: 'run.created',
      runId: 'run_auth',
      actorId,
      sequence: 0,
      occurredAt: '2026-06-19T10:00:00.000Z',
      correlationId: 'req_generated-00000000-0000-4000-8000-000000000000',
      causationId: null,
      dataClass: 'workspace-private',
      producerVersion: '0.2.0-dev',
      payload: {}
    });
    return {
      runId: 'run_auth',
      objective: objective ?? 'Default objective',
      status: 'completed',
      outputs: {
        'generate-angles': { output: [{ rank: 1, angle: 'A', hook: 'H', evidenceIds: ['obs_1'], confidence: 0.8 }] },
        'verify-recommendations': { valid: true }
      }
    };
  };
  const compileContext = (request, records) => {
    calls.compile += 1;
    return {
      schemaVersion: '1.0.0',
      id: 'ctx_auth',
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
  };
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
    logger,
    clock: () => '2026-06-19T10:00:00.000Z',
    correlationIdFactory: () => 'req_generated-00000000-0000-4000-8000-000000000000'
  });
  api.server.listen(0, '127.0.0.1');
  await once(api.server, 'listening');
  t.after(async () => new Promise((resolve) => api.close(resolve)));
  const { port } = api.server.address();
  return { ...api, base: `http://127.0.0.1:${port}`, identityStore, store, calls, owner };
}

function cookieHeader(headers) {
  const raw = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : headers.get('set-cookie')?.split(/,(?=\s*oaf_)/) ?? [];
  return raw.map((item) => item.split(';')[0]).join('; ');
}

function csrfFromCookie(cookie) {
  return /(?:^|;\s*)oaf_csrf=([^;]+)/.exec(cookie)?.[1] ?? '';
}

async function json(base, pathName, options = {}) {
  const response = await fetch(`${base}${pathName}`, options);
  const text = await response.text();
  return {
    response,
    status: response.status,
    headers: response.headers,
    text,
    body: text ? JSON.parse(text) : null
  };
}

async function login(base, username = 'owner') {
  const result = await json(base, '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ username, password })
  });
  assert.equal(result.status, 200, result.text);
  const cookies = cookieHeader(result.headers);
  assert.match(cookies, /oaf_session=/);
  assert.match(cookies, /oaf_csrf=/);
  assert.match(result.headers.get('set-cookie'), /HttpOnly/);
  assert.match(result.headers.get('set-cookie'), /SameSite=Strict/);
  return { ...result, cookies, csrf: csrfFromCookie(cookies) };
}

const contextPayload = (workspaceId = 'ws_local') => ({
  request: {
    schemaVersion: '1.0.0',
    id: 'ctxreq_auth',
    workspaceId,
    actorId: 'agent:test',
    taskId: 'run_auth',
    step: 'answer',
    objective: 'test',
    tokenBudget: 20,
    allowedScopes: ['workspace-private']
  },
  records: [{ id: 'obs_1', kind: 'observation', text: 'test record', source: 'fixture', tokens: 1 }]
});

test('public bootstrap status is safe and protected routes fail closed before bootstrap', async (t) => {
  const api = await startServer(t, { bootstrapped: false });
  const status = await json(api.base, '/api/auth/bootstrap-status');
  assert.deepEqual(status.body, { schemaVersion: '1.0.0', bootstrapRequired: true });

  const denied = await json(api.base, '/api/runs?workspaceId=ws_local');
  assert.equal(denied.status, 503);
  assert.equal(denied.body.error.code, 'bootstrap_required');
  assert.equal(api.store.reads + api.store.updates + api.store.resets, 0);
  assert.equal(api.calls.workflow, 0);

  const created = await json(api.base, '/api/auth/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base },
    body: JSON.stringify({
      username: 'owner',
      displayName: 'Local Owner',
      password,
      workspaceId: 'ws_local',
      workspaceName: 'Local Workspace'
    })
  });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.body.authenticated, true);
  assert.equal(created.body.user.username, 'owner');
  assert.equal(created.body.memberships[0].role, 'owner');
  assert.equal(created.text.includes(password), false);
  const cookies = cookieHeader(created.headers);
  assert.match(cookies, /oaf_session=/);
  assert.match(cookies, /oaf_csrf=/);
  assert.match(created.headers.get('set-cookie'), /HttpOnly/);

  const after = await json(api.base, '/api/auth/bootstrap-status');
  assert.deepEqual(after.body, { schemaVersion: '1.0.0', bootstrapRequired: false });
  const dashboard = await json(api.base, '/api/dashboard?workspaceId=ws_local', { headers: { cookie: cookies } });
  assert.equal(dashboard.status, 200, dashboard.text);

  const duplicate = await json(api.base, '/api/auth/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base },
    body: JSON.stringify({ username: 'again', displayName: 'Again', password })
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.code, 'already_bootstrapped');
});

test('login issues safe session and csrf cookies and rejects credential ambiguity', async (t) => {
  const api = await startServer(t);
  const badUnknown = await json(api.base, '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base },
    body: JSON.stringify({ username: 'missing', password: 'wrong password 12345' })
  });
  const badWrong = await json(api.base, '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base },
    body: JSON.stringify({ username: 'owner', password: 'wrong password 12345' })
  });
  assert.equal(badUnknown.status, 401);
  assert.equal(badWrong.status, 401);
  assert.equal(badUnknown.body.error.code, 'invalid_credentials');
  assert.equal(badWrong.body.error.code, 'invalid_credentials');
  assert.equal(badUnknown.text.includes('missing'), false);

  const session = await login(api.base);
  assert.equal(session.body.user.username, 'owner');
  assert.equal(JSON.stringify(session.body).includes('password'), false);
  assert.equal(JSON.stringify(session.body).includes('tokenHash'), false);

  const me = await json(api.base, '/api/auth/session', { headers: { cookie: session.cookies } });
  assert.equal(me.status, 200);
  assert.equal(me.body.authenticated, true);
  assert.equal(me.body.memberships[0].workspaceId, 'ws_local');

  const ambiguous = await json(api.base, '/api/runs?workspaceId=ws_local', {
    headers: { cookie: session.cookies, authorization: 'Bearer oaf_tok_fake_fake' }
  });
  assert.equal(ambiguous.status, 401);
  assert.equal(ambiguous.body.error.code, 'invalid_authentication');
  assert.equal(ambiguous.headers.get('www-authenticate'), 'Bearer');
  assert.equal(api.store.reads, 0);
});

test('csrf and role policy prevent unsafe domain execution before handlers', async (t) => {
  const api = await startServer(t);
  const owner = await login(api.base);
  const missingCsrf = await json(api.base, '/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base, cookie: owner.cookies },
    body: JSON.stringify({ workspaceId: 'ws_local' })
  });
  assert.equal(missingCsrf.status, 403);
  assert.equal(missingCsrf.body.error.code, 'csrf_failed');
  assert.equal(api.calls.workflow, 0);
  assert.equal(api.store.updates, 0);

  const auditor = await login(api.base, 'auditor');
  const denied = await json(api.base, '/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base, cookie: auditor.cookies, 'x-csrf-token': auditor.csrf },
    body: JSON.stringify({ workspaceId: 'ws_local' })
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'forbidden');
  assert.equal(api.calls.workflow, 0);
  assert.equal(api.store.updates, 0);

  const allowed = await json(api.base, '/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base, cookie: owner.cookies, 'x-csrf-token': owner.csrf },
    body: JSON.stringify({ workspaceId: 'ws_local', objective: 'local agents' })
  });
  assert.equal(allowed.status, 201, allowed.text);
  assert.equal(allowed.body.run.workspaceId, 'ws_local');
  assert.equal(allowed.body.events[0].actorId, api.owner.user.id);
  assert.equal(api.calls.workflow, 1);
  assert.equal(api.store.updates, 1);
});

test('api tokens are returned once, scoped by membership, and cannot mint tokens', async (t) => {
  const api = await startServer(t);
  const owner = await login(api.base);
  const created = await json(api.base, '/api/auth/tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base, cookie: owner.cookies, 'x-csrf-token': owner.csrf },
    body: JSON.stringify({
      name: 'ci token',
      workspaceIds: ['ws_local'],
      scopes: ['run.read', 'run.execute'],
      expiresAt: '2026-06-20T10:00:00.000Z'
    })
  });
  assert.equal(created.status, 201, created.text);
  assert.match(created.body.token, /^oaf_tok_/);
  assert.equal(created.body.apiToken.tokenHash, undefined);

  const listed = await json(api.base, '/api/auth/tokens', { headers: { cookie: owner.cookies } });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.items[0].token, undefined);
  assert.equal(listed.body.items[0].tokenHash, undefined);

  const bearerRead = await json(api.base, '/api/runs?workspaceId=ws_local', {
    headers: { authorization: `Bearer ${created.body.token}` }
  });
  assert.equal(bearerRead.status, 200);

  const bearerMint = await json(api.base, '/api/auth/tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base, authorization: `Bearer ${created.body.token}` },
    body: JSON.stringify({ name: 'bad', workspaceIds: ['ws_local'], scopes: ['run.read'] })
  });
  assert.equal(bearerMint.status, 403);
  assert.equal(bearerMint.body.error.code, 'forbidden');

  const revoked = await json(api.base, `/api/auth/tokens/${created.body.apiToken.id}`, {
    method: 'DELETE',
    headers: { origin: api.base, cookie: owner.cookies, 'x-csrf-token': owner.csrf }
  });
  assert.equal(revoked.status, 200);
  const afterRevoke = await json(api.base, '/api/runs?workspaceId=ws_local', {
    headers: { authorization: `Bearer ${created.body.token}` }
  });
  assert.equal(afterRevoke.status, 401);
});

test('workspace context scopes lists, run detail, compile, and stream authorization', async (t) => {
  const api = await startServer(t);
  const owner = await login(api.base);
  const created = await json(api.base, '/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base, cookie: owner.cookies, 'x-csrf-token': owner.csrf },
    body: JSON.stringify({ workspaceId: 'ws_local', objective: 'local agents' })
  });
  assert.equal(created.status, 201);

  const visible = await json(api.base, '/api/runs/run_auth?workspaceId=ws_local', { headers: { cookie: owner.cookies } });
  assert.equal(visible.status, 200);
  const hidden = await json(api.base, '/api/runs/run_auth?workspaceId=ws_other', { headers: { cookie: owner.cookies } });
  assert.equal(hidden.status, 404);
  assert.equal(hidden.body.error.code, 'resource_not_found');

  const compile = await json(api.base, '/api/context/compile', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base, cookie: owner.cookies, 'x-csrf-token': owner.csrf },
    body: JSON.stringify(contextPayload('ws_local'))
  });
  assert.equal(compile.status, 200);
  assert.equal(api.calls.compile, 1);

  const conflict = await json(api.base, '/api/runs?workspaceId=ws_other', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: api.base, cookie: owner.cookies, 'x-csrf-token': owner.csrf },
    body: JSON.stringify({ workspaceId: 'ws_local' })
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'workspace_context_conflict');

  const stream = await new Promise((resolve, reject) => {
    const url = new URL('/api/stream?workspaceId=ws_local', api.base);
    const req = http.request({ hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, headers: { cookie: owner.cookies } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.includes('event: connected')) {
          req.destroy();
          resolve({ status: res.statusCode, headers: res.headers, body });
        }
      });
    });
    req.on('error', (error) => {
      if (error.code === 'ECONNRESET') return;
      reject(error);
    });
    req.end();
  });
  assert.equal(stream.status, 200);
  assert.match(stream.headers['content-type'], /text\/event-stream/);
});
