import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import recallMapSchema from '../packages/protocol/schemas/recall-map.schema.json' with { type: 'json' };
import { validateJsonSchema } from '../packages/protocol/src/schema-validator.mjs';

const root = process.cwd();
const temp = await mkdtemp(path.join(os.tmpdir(), 'oaf-consumer-smoke-'));
const workspace = path.join(temp, 'workspace');
const home = path.join(temp, 'home');
const data = path.join(temp, 'data');
const password = 'correct horse battery staple';
let server = null;

try {
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), JSON.stringify({ name: 'consumer-smoke-target' }, null, 2));
  await writeFile(path.join(workspace, 'AGENTS.md'), 'Use local context handoffs and proposal-gated memory.');
  await writeFile(path.join(workspace, 'src', 'app.js'), 'export function launchSmoke(){ return "ready"; }\n');

  const pack = runJson('npm', ['pack', '--dry-run', '--json']);
  must(pack[0]?.files?.some((file) => file.path === 'apps/cli/oaf.mjs'), 'package includes oaf bin');

  const map = runJson(process.execPath, ['apps/cli/oaf.mjs', 'map', '--root', workspace, '--sqlite', '.local/memory.sqlite', '--changed', 'src/app.js', '--query', 'launch smoke', '--format', 'json']);
  must(validateJsonSchema(recallMapSchema, map).valid, 'Recall Map JSON is the exact strict schema object');
  must(!Object.hasOwn(map, 'command'), 'Recall Map JSON has no transport command envelope');
  must(map.safeguards?.readOnly === true && map.safeguards?.localFilesWritten === 0, 'Recall Map is read-only');
  must(map.architecture?.impact?.changedLocators?.includes('workspace://src/app.js'), 'Recall Map maps the target workspace change');
  must(!JSON.stringify(map).includes(workspace), 'Recall Map redacts local workspace paths');

  const preview = runJson(process.execPath, ['apps/cli/oaf.mjs', 'mcp', 'install', '--client', 'codex', '--home', home, '--root', root, '--format', 'json']);
  must(preview.safeguards?.homeConfigMutated === false, 'mcp install preview is dry-run');
  const applied = runJson(process.execPath, ['apps/cli/oaf.mjs', 'mcp', 'install', '--client', 'codex', '--home', home, '--root', root, '--apply', '--confirm', preview.planFingerprint, '--format', 'json']);
  must(applied.safeguards?.homeConfigMutated === true, 'mcp install applies only after confirm');

  const mcpSmoke = runJson(process.execPath, ['apps/cli/oaf.mjs', 'mcp', 'smoke', 'context-pack', '--read-only', '--from', 'codex', '--root', workspace, '--objective', 'Consumer smoke', '--step', 'verify context readback', '--target', 'codex', '--changed', 'src/app.js', '--format', 'json']);
  must(mcpSmoke.checks?.resourceRead && mcpSmoke.safeguards?.readOnly === true, 'mcp context-pack smoke is read-only');

  const port = await freePort();
  server = spawn(process.execPath, ['services/control-api/src/server.mjs'], {
    cwd: root,
    env: { ...process.env, OAF_PORT: String(port), OAF_DATA_DIR: data, OAF_WORKSPACE_ROOT: workspace, HOME: home },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForHealth(port);
  const base = `http://127.0.0.1:${port}`;

  const boot = await json(base, '/api/auth/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ username: 'owner', displayName: 'Owner', password, workspaceId: 'ws_local', workspaceName: 'Local Workspace' })
  });
  must(boot.status === 201 && boot.body.authenticated === true, `local owner bootstrap works: ${boot.status} ${boot.text}`);
  const cookie = cookieHeader(boot.headers);
  const csrf = /(?:^|;\s*)oaf_csrf=([^;]+)/.exec(cookie)?.[1] ?? '';
  const authHeaders = { 'content-type': 'application/json', origin: base, cookie, 'x-csrf-token': csrf };

  const homePage = await text(base, '/');
  must(homePage.includes('Recall Map') && homePage.includes('Next-Agent Handoff'), 'consumer home prioritizes Recall Map and Next-Agent Handoff');
  must(!homePage.includes('Open Agent Fabric'), 'consumer home omits stale OAF branding');
  const appJs = await text(base, '/app.js');
  for (const label of ['Create handoff', 'Review memory', 'Inspect source graph']) must(appJs.includes(label), `web shell exposes ${label}`);

  const setup = await json(base, '/api/harness/setup/plan', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ workspaceId: 'ws_local', client: 'codex' })
  });
  must(setup.status === 200 && setup.body.safeguards?.homeConfigMutated === false, 'Next-Agent Handoff setup preview is dry-run');

  const packApi = await json(base, '/api/context/pack', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ workspaceId: 'ws_local', objective: 'Consumer smoke', step: 'build token saver pack', targetHarness: 'codex', from: 'codex', userSelectedFiles: ['AGENTS.md'], changedLocators: ['src/app.js'], tokenBudget: 2048 })
  });
  must(packApi.status === 200 && packApi.body.readback?.checks?.resourceRead === true, 'Next-Agent Handoff builds a readable context pack');
  must(packApi.body.pack?.delivery?.sourceContentsIncluded === false, 'Next-Agent Handoff omits raw source bodies');

  const memory = await json(base, '/api/memory/proposals', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ workspaceId: 'ws_local', sourceLocator: 'memory/inbox.md', text: 'consumer_smoke proposal_gate active', dryRun: true })
  });
  must(memory.status === 200 && memory.body.summary?.proposalCount === 1 && memory.body.safeguards?.activeMemoryCreated === 0, 'Review memory previews a proposal-gated fact');

  const graph = await json(base, '/api/context/graph/preview', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ workspaceId: 'ws_local', query: 'launchSmoke', changedLocators: ['src/app.js'], limit: 20 })
  });
  must(graph.status === 200 && graph.body.graph?.summary?.nodeCount > 0 && graph.body.impact?.changedLocators?.includes('workspace://src/app.js'), `Inspect source graph previews changed code: ${graph.status} ${graph.text}`);

  console.log('PASS consumer package dry-run');
  console.log('PASS consumer Recall Map first-run report');
  console.log('PASS consumer temp HOME mcp install');
  console.log('PASS consumer real MCP client smoke');
  console.log('PASS consumer control-api smoke: Recall Map, Next-Agent Handoff, Review memory, Inspect source graph');
} finally {
  if (server) {
    server.kill('SIGTERM');
    await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
  await rm(temp, { recursive: true, force: true });
}

function runJson(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

function must(condition, message) {
  if (!condition) throw new Error(message);
}

async function freePort() {
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function waitForHealth(port) {
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const health = await json(base, '/api/health');
      if (health.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('control API did not become healthy');
}

async function json(base, pathName, options = {}) {
  const response = await fetch(`${base}${pathName}`, options);
  const body = await response.text();
  return { status: response.status, headers: response.headers, body: body ? JSON.parse(body) : null, text: body };
}

async function text(base, pathName) {
  const response = await fetch(`${base}${pathName}`);
  if (!response.ok) throw new Error(`GET ${pathName} failed: ${response.status}`);
  return response.text();
}

function cookieHeader(headers) {
  const raw = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : headers.get('set-cookie')?.split(/,(?=\s*oaf_)/) ?? [];
  return raw.map((item) => item.split(';')[0]).join('; ');
}
