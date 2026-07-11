import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { runAuthBootstrapCli } from '../scripts/auth-bootstrap.mjs';
import { SQLiteMemoryProvider } from '../providers/native/memory-sqlite/src/index.mjs';
import recallMapSchema from '../packages/protocol/schemas/recall-map.schema.json' with { type: 'json' };
import { validateJsonSchema } from '../packages/protocol/src/schema-validator.mjs';

let child;
let base;
let temp;
let latestAuth = null;

async function bootstrapIdentity(dataDir) {
  let stderr = '';
  const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const err = new Writable({ write(chunk, _encoding, callback) { stderr += chunk.toString(); callback(); } });
  const code = await runAuthBootstrapCli({
    argv: ['--data-dir', path.join(dataDir, 'identity'), '--username', 'owner', '--display-name', 'Local Owner', '--password-stdin'],
    stdin: Readable.from(['correct horse battery staple\n']),
    stdout: sink,
    stderr: err
  });
  assert.equal(code, 0, stderr);
}

async function applyTemporalFact(provider, input) {
  const source = input.source ?? 'workspace://docs/graph.md';
  const proposal = await provider.enqueueProposal({
    id: input.proposalId ?? `mpq_${input.id.replace(/^memfact_/u, '')}`,
    workspaceId: 'ws_local',
    sourceLocator: source,
    sourceHash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    payload: {
      kind: 'fact',
      scope: 'workspace',
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
      text: input.text ?? `${input.subject} ${input.predicate} ${input.object}`
    }
  });
  await provider.claimProposal({ workspaceId: 'ws_local', workerId: 'reviewer', leaseUntil: '2026-06-26T10:05:00.000Z' });
  await provider.recordProposalResult({ workspaceId: 'ws_local', id: proposal.id, workerId: 'reviewer', status: 'applied', result: { accepted: true } });
  await provider.addTemporalFact({
    id: input.id,
    workspaceId: 'ws_local',
    scope: 'workspace',
    subject: input.subject,
    predicate: input.predicate,
    object: input.object,
    text: input.text ?? `${input.subject} ${input.predicate} ${input.object}`,
    source,
    proposalQueueId: proposal.id,
    validFrom: input.validFrom ?? '2026-06-26T09:30:00.000Z',
    supersedeSubjectPredicate: input.supersedeSubjectPredicate === true
  });
}

async function seedMemory(dataDir) {
  const provider = new SQLiteMemoryProvider({ filename: path.join(dataDir, 'memory.sqlite'), clock: () => '2026-06-26T10:00:00.000Z' });
  try {
    await provider.put({
      id: 'mem_api_profile',
      workspaceId: 'ws_local',
      kind: 'decision',
      text: 'Keep Surface & Wire memory cockpit local, real, token measured, proposal gated, and rendered from native SQLite facts.',
      source: 'workspace://docs/surface.md',
      status: 'active',
      confidence: 0.9,
      authority: 0.9,
      updatedAt: '2026-06-26T09:55:00.000Z'
    });
    const proposal = await provider.enqueueProposal({
      id: 'mpq_api_memory',
      workspaceId: 'ws_local',
      sourceLocator: 'workspace://docs/surface.md',
      sourceHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      payload: { kind: 'fact', subject: 'surface-wire', predicate: 'visible', object: 'memory-cockpit' }
    });
    await provider.claimProposal({ workspaceId: 'ws_local', workerId: 'reviewer', leaseUntil: '2026-06-26T10:05:00.000Z' });
    await provider.recordProposalResult({ workspaceId: 'ws_local', id: proposal.id, workerId: 'reviewer', status: 'applied', result: { accepted: true } });
    await provider.addTemporalFact({
      id: 'memfact_api_memory',
      workspaceId: 'ws_local',
      scope: 'workspace',
      subject: 'surface-wire',
      predicate: 'visible',
      object: 'memory-cockpit',
      text: 'Surface & Wire renders native SQLite temporal memory in the web cockpit.',
      source: 'workspace://docs/surface.md',
      proposalQueueId: proposal.id,
      validFrom: '2026-06-26T10:00:00.000Z'
    });
    await applyTemporalFact(provider, {
      id: 'memfact_api_graph_project_provider',
      subject: 'project:open-agent-fabric',
      predicate: 'default_memory_provider',
      object: 'provider:native:memory:sqlite',
      source: 'workspace://docs/architecture/overview.md'
    });
    await applyTemporalFact(provider, {
      id: 'memfact_api_graph_provider_port',
      subject: 'provider:native:memory:sqlite',
      predicate: 'implements_port',
      object: 'MemoryBackendPort',
      source: 'workspace://providers/native/memory-sqlite/provider.json'
    });
    await applyTemporalFact(provider, {
      id: 'memfact_api_graph_project_module',
      subject: 'project:open-agent-fabric',
      predicate: 'uses',
      object: 'module:apps/web',
      source: 'workspace://apps/web/app.js'
    });
    await applyTemporalFact(provider, {
      id: 'memfact_api_graph_decision',
      subject: 'adr:memory-graph-ui',
      predicate: 'decides',
      object: 'current-truth-toggle',
      source: 'workspace://docs/adr/0019-memory-graph-ui.md'
    });
    await applyTemporalFact(provider, {
      id: 'memfact_api_graph_legacy_index',
      subject: 'provider:native:memory:sqlite',
      predicate: 'uses',
      object: 'legacy-memory-index',
      source: 'workspace://DECISIONS.md',
      validFrom: '2026-06-26T09:00:00.000Z'
    });
    await applyTemporalFact(provider, {
      id: 'memfact_api_graph_edges_index',
      subject: 'provider:native:memory:sqlite',
      predicate: 'uses',
      object: 'memory_edges',
      source: 'workspace://DECISIONS.md',
      validFrom: '2026-06-26T09:45:00.000Z',
      supersedeSubjectPredicate: true
    });
    await provider.enqueueProposal({
      id: 'mpq_api_cockpit',
      workspaceId: 'ws_local',
      sourceLocator: 'workspace://docs/cockpit.md',
      sourceHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      payload: { kind: 'fact', scope: 'workspace', subject: 'memory-cockpit', predicate: 'approves', object: 'active-facts', text: 'memory-cockpit approves active-facts' }
    });
  } finally {
    provider.close();
  }
}

function cookieHeader(headers) {
  const raw = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : headers.get('set-cookie')?.split(/,(?=\s*oaf_)/) ?? [];
  return raw.map((item) => item.split(';')[0]).join('; ');
}

function csrfFromCookie(cookie) {
  return /(?:^|;\s*)oaf_csrf=([^;]+)/.exec(cookie)?.[1] ?? '';
}

async function login() {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ username: 'owner', password: 'correct horse battery staple' })
  });
  assert.equal(response.status, 200, await response.text());
  const cookie = cookieHeader(response.headers);
  latestAuth = { cookie, csrf: csrfFromCookie(cookie) };
  return latestAuth;
}

async function getWithRawBody(pathname, { cookie, body }) {
  const payload = String(body ?? '');
  return new Promise((resolve, reject) => {
    const request = http.request(`${base}${pathname}`, {
      method: 'GET',
      headers: {
        cookie,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      }
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

test.before(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), 'oaf-api-'));
  await bootstrapIdentity(temp);
  await seedMemory(temp);
  const port = 46000 + Math.floor(Math.random() * 1000);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['services/control-api/src/server.mjs'], {
    env: { ...process.env, OAF_PORT: String(port), OAF_DATA_DIR: temp },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  for (let i = 0; i < 80; i += 1) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('server did not start');
});

test.after(async () => {
  child?.kill('SIGTERM');
  await rm(temp, { recursive: true, force: true });
});

test('health declares local-only bootstrap and security headers', async () => {
  const response = await fetch(`${base}/api/health`);
  const body = await response.json();
  assert.equal(body.residency, 'local-only');
  assert.equal(body.externalWrites, false);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('invalid JSON returns bounded client error', async () => {
  const response = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'invalid_json');
});

test('runs the complete verified bootstrap workflow', async () => {
  const auth = await login();
  const response = await fetch(`${base}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, cookie: auth.cookie, 'x-csrf-token': auth.csrf },
    body: JSON.stringify({ workspaceId: 'ws_local' })
  });
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.run.status, 'completed');
  assert.equal(body.run.verification.valid, true);
});

test('memory cockpit route reads native SQLite facts proposals and token budget', async () => {
  const auth = await login();
  const response = await fetch(`${base}/api/memory/cockpit?workspaceId=ws_local`, { headers: { cookie: auth.cookie } });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const body = JSON.parse(text);
  assert.equal(body.provider, 'provider:native:memory:sqlite');
  assert.equal(body.facts[0].id, 'memfact_api_memory');
  assert.equal(body.facts[0].validity.validFrom, '2026-06-26T10:00:00.000Z');
  assert.equal(body.facts[0].provenance.episode.sourceLocator, 'workspace://docs/surface.md');
  assert(body.proposalQueue.some((item) => item.id === 'mpq_api_memory'));
  assert.equal(body.tokenBudget.measured, true);
  assert(body.tokenBudget.estimatedDeliveryTokens > 0);
  assert.equal(body.savings.command, 'measure savings');
  assert.equal(body.savings.measurementScope, 'realistic local context.profile delivery-token benchmark');
  assert(body.savings.beforeDeliveryTokens >= body.tokenBudget.historyTokensAvailable);
  assert(body.savings.afterDeliveryTokens > 0);
  assert.equal(body.savings.tokensSaved, body.savings.beforeDeliveryTokens - body.savings.afterDeliveryTokens);
  assert.equal(body.savings.realisticBenchmark.candidateFiles.some((item) => item.locator === 'workspace://AGENTS.md'), true);
  assert.equal(body.savings.savings.providerBillingClaimed, false);
  assert.match(body.reportFingerprint, /^sha256:[a-f0-9]{64}$/);
});

test('memory graph route serves governed current and temporal history graph', async () => {
  const auth = await login();
  const response = await fetch(`${base}/api/memory/graph?workspaceId=ws_local`, { headers: { cookie: auth.cookie } });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const current = JSON.parse(text);
  assert.equal(current.provider, 'provider:native:memory:sqlite');
  assert.equal(current.mode, 'current');
  assert(current.graph.nodes.some((node) => node.name === 'project:open-agent-fabric' && node.type === 'project'));
  assert(current.graph.edges.some((edge) => edge.from === 'provider:native:memory:sqlite' && edge.predicate === 'implements_port' && edge.to === 'MemoryBackendPort'));
  assert(current.summary.communityCount > 1);
  assert.equal(current.graph.edges.some((edge) => edge.to === 'legacy-memory-index'), false);

  const historyResponse = await fetch(`${base}/api/memory/graph?workspaceId=ws_local&history=true`, { headers: { cookie: auth.cookie } });
  const historyText = await historyResponse.text();
  assert.equal(historyResponse.status, 200, historyText);
  const history = JSON.parse(historyText);
  assert.equal(history.mode, 'history');
  assert(history.summary.edgeCount > current.summary.edgeCount);
  assert(history.graph.edges.some((edge) => edge.to === 'legacy-memory-index' && edge.current === false && edge.status === 'superseded'));

  const focusResponse = await fetch(`${base}/api/memory/graph?workspaceId=ws_local&entity=${encodeURIComponent('provider:native:memory:sqlite')}`, { headers: { cookie: auth.cookie } });
  const focusText = await focusResponse.text();
  assert.equal(focusResponse.status, 200, focusText);
  const focused = JSON.parse(focusText);
  assert.equal(focused.focus.entity, 'provider:native:memory:sqlite');
  assert(focused.focus.nodes.some((node) => node.name === 'MemoryBackendPort'));
  assert(focused.focus.edges.some((edge) => edge.predicate === 'implements_port'));
  assert.equal(focused.safeguards.readOnly, true);
});

test('recall map API returns only the strict read-only report and rejects unsafe input', async () => {
  const unauthenticated = await fetch(`${base}/api/recall/map?workspaceId=ws_local`);
  assert.equal(unauthenticated.status, 401);
  const auth = latestAuth ?? await login();
  const response = await fetch(`${base}/api/recall/map?workspaceId=ws_local&changed=apps%2Fweb%2Fapp.js&query=auth`, {
    headers: { cookie: auth.cookie }
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const report = JSON.parse(text);
  assert.equal(validateJsonSchema(recallMapSchema, report).valid, true);
  assert.equal(Object.hasOwn(report, 'command'), false);
  assert.equal(report.safeguards.readOnly, true);
  assert.equal(report.safeguards.localFilesWritten, 0);
  assert.equal(report.safeguards.canonicalStateMutated, false);
  assert.deepEqual(report.architecture.impact.changedLocators, ['workspace://apps/web/app.js']);
  assert.equal(typeof report.repository.name, 'string');
  assert.equal(Object.hasOwn(report.repository, 'root'), false);
  assert.equal(Object.hasOwn(report.repository, 'changedPaths'), false);
  assert.equal(Object.hasOwn(report.repository, 'diff'), false);
  const sourceGraphRoot = process.cwd();
  assert.equal(text.includes(sourceGraphRoot), false);

  for (const suffix of [
    'workspaceId=ws_local&changed=%2Fprivate%2Fvar%2Fdb.sqlite',
    'workspaceId=ws_local&changed=..%2Fmemory.sqlite',
    'workspaceId=ws_local&changed=apps%2Fweb%2Fapp.js&query=file%3A%2F%2F%2Fprivate%2Fvar%2Fdb.sqlite',
    'workspaceId=ws_local&write=true',
    'workspaceId=ws_local&sqlite=.local%2Fother.sqlite'
  ]) {
    const rejected = await fetch(`${base}/api/recall/map?${suffix}`, { headers: { cookie: auth.cookie } });
    const rejectedBody = await rejected.json();
    assert.equal(rejected.status, 400, suffix);
    assert.equal(rejectedBody.error.code, 'request_validation_failed', suffix);
  }

  const bodyRejected = await getWithRawBody('/api/recall/map?workspaceId=ws_local', {
    cookie: auth.cookie,
    body: JSON.stringify({ changedLocators: ['apps/web/app.js'] })
  });
  assert.equal(bodyRejected.status, 400);
  assert.equal(bodyRejected.body.error.code, 'request_validation_failed');
});

test('recall map POST accepts one bounded multi-locator read with session CSRF', async () => {
  const auth = latestAuth ?? await login();
  const payload = {
    workspaceId: 'ws_local',
    changedLocators: ['apps/web/app.js', 'services/control-api/src/server.mjs'],
    query: 'services/control-api/src/server.mjs'
  };
  const response = await fetch(`${base}/api/recall/map`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, cookie: auth.cookie, 'x-csrf-token': auth.csrf },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const report = JSON.parse(text);
  assert.equal(validateJsonSchema(recallMapSchema, report).valid, true);
  assert.deepEqual(report.architecture.impact.changedLocators, [
    'workspace://apps/web/app.js',
    'workspace://services/control-api/src/server.mjs'
  ]);
  assert(report.architecture.impact.affectedSymbols.length > 0);
  assert.equal(report.safeguards.readOnly, true);
  assert.equal(report.safeguards.localFilesWritten, 0);
  assert.equal(report.safeguards.canonicalStateMutated, false);
  assert.equal(report.safeguards.networkCalls, 0);
  assert.equal(report.safeguards.modelCalls, 0);
  assert.equal(text.includes(process.cwd()), false);

  const noAuth = await fetch(`${base}/api/recall/map`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify(payload)
  });
  assert.equal(noAuth.status, 401);

  const noCsrf = await fetch(`${base}/api/recall/map`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, cookie: auth.cookie },
    body: JSON.stringify(payload)
  });
  assert.equal(noCsrf.status, 403);
  assert.equal((await noCsrf.json()).error.code, 'csrf_failed');

  for (const body of [
    { ...payload, changedLocators: Array.from({ length: 17 }, (_, index) => `src/file-${index}.js`) },
    { ...payload, changedLocators: ['../private/secret.js'] },
    { ...payload, extra: true }
  ]) {
    const rejected = await fetch(`${base}/api/recall/map`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: auth.cookie, 'x-csrf-token': auth.csrf },
      body: JSON.stringify(body)
    });
    assert.equal(rejected.status, 400, JSON.stringify(body));
    assert.equal((await rejected.json()).error.code, 'request_validation_failed');
  }
});

test('memory cockpit approval endpoint promotes one pending proposal', async () => {
  const auth = await login();
  const previewResponse = await fetch(`${base}/api/memory/proposals`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, cookie: auth.cookie, 'x-csrf-token': auth.csrf },
    body: JSON.stringify({
      workspaceId: 'ws_local',
      sourceLocator: 'memory/intake.md',
      text: 'Fact: memory-cockpit intake_flow explicit-approval.',
      dryRun: true
    })
  });
  const previewText = await previewResponse.text();
  assert.equal(previewResponse.status, 200, previewText);
  const preview = JSON.parse(previewText);
  assert.equal(preview.command, 'memory preview');
  assert.equal(preview.summary.proposalCount, 1);
  assert.equal(preview.summary.activeMemoryCreated, 0);
  assert.equal(preview.proposalFacts[0].subject, 'memory-cockpit');

  const queueResponse = await fetch(`${base}/api/memory/proposals`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, cookie: auth.cookie, 'x-csrf-token': auth.csrf },
    body: JSON.stringify({
      workspaceId: 'ws_local',
      sourceLocator: 'memory/intake.md',
      text: 'Fact: memory-cockpit intake_flow explicit-approval.',
      dryRun: false,
      confirm: true
    })
  });
  const queueText = await queueResponse.text();
  assert.equal(queueResponse.status, 200, queueText);
  const queued = JSON.parse(queueText);
  assert.equal(queued.command, 'memory propose');
  assert.equal(queued.summary.activeMemoryCreated, 0);
  assert.equal(queued.proposalFacts[0].status, 'pending');
  assert.equal(queued.proposalFacts[0].id, preview.proposalFacts[0].id);

  const response = await fetch(`${base}/api/memory/proposals/mpq_api_cockpit/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, cookie: auth.cookie, 'x-csrf-token': auth.csrf },
    body: JSON.stringify({ workspaceId: 'ws_local', confirm: true })
  });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  const body = JSON.parse(text);
  assert.equal(body.command, 'memory approve');
  assert.equal(body.summary.activeMemoryCreated, 1);
  assert.equal(body.fact.id, 'memfact_api_cockpit');
  const intakeApprove = await fetch(`${base}/api/memory/proposals/${queued.proposalFacts[0].id}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, cookie: auth.cookie, 'x-csrf-token': auth.csrf },
    body: JSON.stringify({ workspaceId: 'ws_local', confirm: true })
  });
  const intakeApproveText = await intakeApprove.text();
  assert.equal(intakeApprove.status, 201, intakeApproveText);
  const intakeBody = JSON.parse(intakeApproveText);
  assert.equal(intakeBody.fact.subject, 'memory-cockpit');
  assert.equal(intakeBody.fact.predicate, 'intake_flow');
  const retryQueueResponse = await fetch(`${base}/api/memory/proposals`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, cookie: auth.cookie, 'x-csrf-token': auth.csrf },
    body: JSON.stringify({
      workspaceId: 'ws_local',
      sourceLocator: 'memory/intake.md',
      text: 'Fact: memory-cockpit intake_flow explicit-approval.',
      dryRun: false,
      confirm: true
    })
  });
  const retryQueueText = await retryQueueResponse.text();
  assert.equal(retryQueueResponse.status, 200, retryQueueText);
  const retryQueue = JSON.parse(retryQueueText);
  assert.equal(retryQueue.command, 'memory propose');
  assert.equal(retryQueue.summary.proposalCount, 0);
  assert.deepEqual(retryQueue.proposalFacts, []);
  const cockpit = await fetch(`${base}/api/memory/cockpit?workspaceId=ws_local`, { headers: { cookie: auth.cookie } });
  const after = await cockpit.json();
  assert(after.facts.some((fact) => fact.id === 'memfact_api_cockpit' && fact.status === 'active'));
  assert(after.facts.some((fact) => fact.subject === 'memory-cockpit' && fact.predicate === 'intake_flow' && fact.status === 'active'));
  assert.equal(after.summary.activeFactCount, 8);
});

test('loop workbench route wires compressed profile plan proposal and fact from native memory', async () => {
  const auth = await login();
  const response = await fetch(`${base}/api/loop/workbench?workspaceId=ws_local`, { headers: { cookie: auth.cookie } });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const body = JSON.parse(text);
  assert.equal(body.memoryLoop.objective, 'Use native memory to complete a local feedback loop');
  assert(body.memoryLoop.compressedProfile.contextBudget.estimatedDeliveryTokens > 0);
  assert.equal(body.memoryLoop.loopPlan.contextBudget.estimatedDeliveryTokens, body.memoryLoop.compressedProfile.contextBudget.estimatedDeliveryTokens);
  assert.match(body.memoryLoop.extractionProposal.id, /^mpq_/);
  assert.match(body.memoryLoop.memoryFact.id, /^memfact_/);
  assert.equal(Number.isNaN(Date.parse(body.memoryLoop.memoryFact.validity.validFrom)), false);
  assert.equal(body.tokenBudget.aggregatedEstimatedDeliveryTokens, body.memoryLoop.loopPlan.contextBudget.estimatedDeliveryTokens);
  assert.equal(body.safeguards.networkCalls, 0);
});

test('invalid context request returns 400', async () => {
  const response = await fetch(`${base}/api/context/compile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request: {}, records: [] })
  });
  assert.equal(response.status, 400);
});
