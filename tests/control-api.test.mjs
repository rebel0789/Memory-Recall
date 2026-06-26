import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { runAuthBootstrapCli } from '../scripts/auth-bootstrap.mjs';
import { SQLiteMemoryProvider } from '../providers/native/memory-sqlite/src/index.mjs';

let child;
let base;
let temp;

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
  return { cookie, csrf: csrfFromCookie(cookie) };
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

test('memory cockpit approval endpoint promotes one pending proposal', async () => {
  const auth = await login();
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
  const cockpit = await fetch(`${base}/api/memory/cockpit?workspaceId=ws_local`, { headers: { cookie: auth.cookie } });
  const after = await cockpit.json();
  assert(after.facts.some((fact) => fact.id === 'memfact_api_cockpit' && fact.status === 'active'));
  assert.equal(after.summary.activeFactCount, 2);
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
  assert.match(body.memoryLoop.extractionProposal.id, /^mpq_api_/);
  assert.match(body.memoryLoop.memoryFact.id, /^memfact_api_/);
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
