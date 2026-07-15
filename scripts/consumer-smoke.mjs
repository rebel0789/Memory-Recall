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
const packDirectory = path.join(temp, 'pack');
const prefix = path.join(temp, 'prefix');
const password = 'correct horse battery staple';
let server = null;

try {
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(packDirectory, { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), JSON.stringify({ name: 'consumer-smoke-target' }, null, 2));
  await writeFile(path.join(workspace, 'AGENTS.md'), 'Use local context handoffs and proposal-gated memory.');
  await writeFile(path.join(workspace, 'src', 'app.js'), 'export function launchSmoke(){ return "ready"; }\n');

  const [pack] = runJson('npm', ['pack', '--pack-destination', packDirectory, '--json'], { cwd: root });
  must(pack?.files?.some((file) => file.path === 'apps/cli/oaf.mjs'), 'package includes recall bin');
  must(!pack?.files?.some((file) => file.path.startsWith('tests/')), 'package excludes checkout-only tests');
  const tarball = path.join(packDirectory, pack.filename);
  run('npm', ['install', '-g', '--prefix', prefix, tarball, '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root, env: { ...process.env, HOME: home } });
  const recall = path.join(prefix, 'bin', 'recall');
  const packageRoot = path.join(prefix, 'lib', 'node_modules', 'memory-recall');
  const env = { ...process.env, HOME: home, PATH: `${path.join(prefix, 'bin')}${path.delimiter}${process.env.PATH}` };

  const version = run(recall, ['--version'], { cwd: workspace, env });
  must(version.stdout.trim() === '1.1.1', 'installed recall reports the release version');
  const setupOutput = run(recall, ['setup'], { cwd: workspace, env });
  must(setupOutput.stdout.includes('Setup created only local state'), 'installed setup creates explicit local state');

  const map = runJson(recall, ['map', '--root', '.', '--sqlite', '.local/memory.sqlite', '--changed', 'src/app.js', '--query', 'launch smoke', '--format', 'json'], { cwd: workspace, env });
  must(validateJsonSchema(recallMapSchema, map).valid, 'Recall Map JSON is the exact strict schema object');
  must(!Object.hasOwn(map, 'command'), 'Recall Map JSON has no transport command envelope');
  must(map.safeguards?.readOnly === true && map.safeguards?.localFilesWritten === 0, 'Recall Map is read-only');
  must(map.architecture?.impact?.changedLocators?.includes('workspace://src/app.js'), 'Recall Map maps the target workspace change');
  must(!JSON.stringify(map).includes(workspace), 'Recall Map redacts local workspace paths');

  const preview = runJson(recall, ['mcp', 'install', '--client', 'codex', '--home', home, '--root', '.', '--format', 'json'], { cwd: workspace, env });
  must(preview.safeguards?.homeConfigMutated === false, 'mcp install preview is dry-run');
  const applied = runJson(recall, ['mcp', 'install', '--client', 'codex', '--home', home, '--root', '.', '--apply', '--confirm', preview.planFingerprint, '--format', 'json'], { cwd: workspace, env });
  must(applied.safeguards?.homeConfigMutated === true, 'mcp install applies only after confirm');

  const mcpSmoke = runJson(recall, ['mcp', 'smoke', 'context-pack', '--read-only', '--from', 'codex', '--root', '.', '--objective', 'Consumer smoke', '--step', 'verify context readback', '--target', 'codex', '--changed', 'src/app.js', '--format', 'json'], { cwd: workspace, env });
  must(mcpSmoke.checks?.resourceRead && mcpSmoke.safeguards?.readOnly === true, 'mcp context-pack smoke is read-only');

  const connect = runJson(recall, ['connect', 'codex', '--dry-run', '--format', 'json'], { cwd: workspace, env });
  must(connect.dryRun === true && connect.safeguards?.homeConfigMutated === false, 'connect remains a dry-run by default');
  const claudeInstall = runJson(recall, ['mcp', 'install', '--client', 'claude-code', '--dry-run', '--format', 'json'], { cwd: workspace, env });
  must(claudeInstall.safeguards?.homeConfigMutated === false, 'Claude Code MCP install preview writes nothing');
  const semanticPlan = runJson(recall, ['semantic', 'plan', '--harness', 'codex', '--root', '.', '--dry-run'], { cwd: workspace, env });
  must(semanticPlan.safeguards?.rawSourceBodiesIncluded === false && semanticPlan.sourceSummary?.selectedCount > 0, 'semantic plan is body-free');
  const semanticTask = run(recall, ['semantic', 'task', '--harness', 'codex', '--root', '.'], { cwd: workspace, env }).stdout;
  const semanticPacket = JSON.parse(semanticTask.match(/<semantic_setup_packet>\n([\s\S]+)\n<\/semantic_setup_packet>/u)?.[1] ?? 'null');
  must(semanticPacket?.packetFingerprint === semanticPlan.packetFingerprint, 'semantic task matches its installed plan');
  await writeFile(path.join(workspace, 'semantic-result.json'), JSON.stringify({
    schemaVersion: '1.0.0',
    packetFingerprint: semanticPacket.packetFingerprint,
    facts: [{ sourceIds: [semanticPacket.sources[0].sourceId], subject: 'project:consumer-smoke', predicate: 'uses', object: 'governed memory', text: 'The consumer smoke uses governed memory.' }]
  }));
  const semanticImport = runJson(recall, ['semantic', 'import', '--input', 'semantic-result.json', '--root', '.', '--sqlite', '.local/memory.sqlite'], { cwd: workspace, env });
  must(semanticImport.proposals?.count === 1 && semanticImport.safeguards?.networkCalls === 0, 'semantic import creates one local pending proposal');
  const ingest = runJson(recall, ['memory', 'ingest', '--root', '.', '--sqlite', '.local/memory.sqlite', '--format', 'json'], { cwd: workspace, env });
  must(ingest.safeguards?.activeMemoryCreated === 0 && ingest.summary?.proposalCount > 0, 'memory ingest creates proposals only');
  must(run(recall, ['memory', 'review', '--root', '.', '--sqlite', '.local/memory.sqlite', '--format', 'summary'], { cwd: workspace, env }).stdout.includes('Memory Review'), 'memory review renders the pending queue');
  const refine = runJson(recall, ['memory', 'refine', '--read-only', '--root', '.', '--sqlite', '.local/memory.sqlite', '--format', 'json'], { cwd: workspace, env });
  must(refine.safeguards?.readOnly === true && refine.summary?.activeMemoryCreated === 0, 'memory refine is read-only');
  must(isReadyHandoff(run(recall, ['verify'], { cwd: workspace, env }).stdout), 'verify runs the installed handoff gate');
  must(isReadyHandoff(run(recall, ['handoff'], { cwd: workspace, env }).stdout), 'handoff renders from the installed package');
  must(run(recall, ['token-saver'], { cwd: workspace, env }).stdout.includes('Token Saver'), 'token-saver renders from the installed package');
  must(run(recall, ['graph', 'stats', '--root', '.', '--format', 'summary'], { cwd: workspace, env }).stdout.includes('Graph Stats'), 'graph stats works from the installed package');
  must(run(recall, ['graph', 'search', '--root', '.', '--query', 'launchSmoke', '--format', 'summary'], { cwd: workspace, env }).stdout.includes('Graph Search'), 'graph search works from the installed package');
  must(run(recall, ['graph', 'trace', '--root', '.', '--symbol', 'launchSmoke', '--format', 'summary'], { cwd: workspace, env }).stdout.includes('Graph Trace'), 'graph trace works from the installed package');
  must(isReadyHandoff(run(recall, ['context', 'handoff', '--read-only', '--from', 'codex', '--root', '.', '--objective', 'Prepare handoff', '--step', 'select next agent context', '--target', 'codex', '--changed', 'src/app.js', '--format', 'summary'], { cwd: workspace, env }).stdout), 'explicit context handoff works from the installed package');
  const session = runJson(recall, ['bench', 'session', '--read-only', '--root', '.', '--format', 'json'], { cwd: workspace, env });
  must(session.headline?.correctnessGatePassed === true && session.dataset?.ref === 'package://evals/temporal/gold.v1.json', 'session benchmark uses its bundled fixture');
  const temporal = runJson(recall, ['bench', 'temporal', '--read-only', '--root', '.', '--format', 'json'], { cwd: workspace, env });
  must(temporal.headline?.oafWins === true && temporal.dataset?.ref === 'package://evals/temporal/gold.v1.json', 'temporal benchmark uses its bundled fixture');
  const truthFloor = runJson(recall, ['benchmark', 'truth-floor', '--suite', 'benchmark-truth-floor', '--dataset', 'evals/benchmark-truth-floor/cases.v1.json', '--format', 'json'], { cwd: workspace, env });
  must(truthFloor.gateDecision === 'pass', 'truth-floor benchmark uses its bundled fixture');

  const port = await freePort();
  server = spawn(recall, ['serve'], {
    cwd: workspace,
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
  must(homePage.includes('Memory Recall') && homePage.includes('repository-name') && homePage.includes('mobile-nav'), 'consumer home serves the local workbench shell');
  must(!homePage.includes('Open Agent Fabric'), 'consumer home omits stale OAF branding');
  const appJs = await text(base, '/app.js');
  for (const phrase of ['Developer-first', 'nervous system', 'supercharge', 'AI-powered', 'next-generation']) must(!appJs.toLocaleLowerCase().includes(phrase.toLocaleLowerCase()), `web shell omits ${phrase}`);
  const shellModel = await text(base, '/shell-model.js');
  for (const label of ['Overview', 'Map', 'Memory', 'Handoffs', 'Settings']) must(shellModel.includes(`label: '${label}'`), `workbench shell exposes ${label}`);

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

  must(!JSON.stringify(map).includes(packageRoot), 'installed commands do not leak package paths');
  console.log('PASS packed tarball installed in isolated HOME');
  console.log('PASS README CLI contract from installed recall binary');
  console.log('PASS bundled benchmark fixtures from installed recall binary');
  console.log('PASS consumer Recall Map first-run report');
  console.log('PASS consumer temp HOME mcp install');
  console.log('PASS consumer real MCP client smoke');
  console.log('PASS consumer control-api smoke: workbench, Recall Map, handoff, memory review, source graph');
} finally {
  if (server) {
    server.kill('SIGTERM');
    await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
  await rm(temp, { recursive: true, force: true });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result;
}

function runJson(command, args, options = {}) {
  const result = run(command, args, options);
  return JSON.parse(result.stdout);
}

function must(condition, message) {
  if (!condition) throw new Error(message);
}

function isReadyHandoff(output) {
  return output.includes('State: ready') && output.includes('MCP readback: ok');
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
