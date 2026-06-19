import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { runAuthBootstrapCli } from '../scripts/auth-bootstrap.mjs';

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

test('invalid context request returns 400', async () => {
  const response = await fetch(`${base}/api/context/compile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request: {}, records: [] })
  });
  assert.equal(response.status, 400);
});
