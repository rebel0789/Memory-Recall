import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const RUST_BIN = path.join(ROOT, 'rust/target/release/oaf');
const FIXED_NOW = '2026-06-30T04:00:00.000Z';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, OAF_FIXED_NOW: FIXED_NOW, ...(options.env ?? {}) }
  });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stderr || result.stdout}`);
  return result;
}

function runJson(command, args, options = {}) {
  return JSON.parse(run(command, args, options).stdout);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function fetchText(port, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: pathname }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) reject(new Error(`${pathname} returned ${response.statusCode}: ${body}`));
        else resolve(body);
      });
    });
    request.on('error', reject);
  });
}

async function startUi(root, sqlite, port) {
  const child = spawn(RUST_BIN, ['ui', '--root', root, '--sqlite', sqlite, '--port', String(port), '--format', 'json'], {
    cwd: ROOT,
    env: { ...process.env, OAF_FIXED_NOW: FIXED_NOW },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  const startup = await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      try {
        resolve(JSON.parse(stdout));
      } catch {
        // wait for full JSON startup receipt
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`ui exited ${code}: ${stderr || stdout}`)));
  });
  return { child, startup, stderr: () => stderr };
}

async function waitForGraph(port) {
  const deadline = Date.now() + 5000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await fetchText(port, '/api/graph?mode=current'));
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError ?? new Error('ui graph did not start');
}

async function uiProofForRepo(temp, repo) {
  const repoRoot = path.join(temp, repo.name.replaceAll('/', '-'));
  run('git', ['clone', '--depth', '1', repo.cloneUrl, repoRoot]);
  mkdirSync(path.join(repoRoot, '.local'), { recursive: true });
  const sqlite = path.join(repoRoot, '.local/memory.sqlite');
  const ingestStarted = performance.now();
  const ingest = runJson(RUST_BIN, ['ingest', '--root', repoRoot, '--sqlite', sqlite, '--workers', '4', '--format', 'json']);
  runJson(RUST_BIN, ['memory', 'approve', '--all', '--root', repoRoot, '--sqlite', sqlite, '--format', 'json']);
  const port = await freePort();
  const uiStarted = performance.now();
  const started = await startUi(repoRoot, sqlite, port);
  try {
    const current = await waitForGraph(port);
    const html = await fetchText(port, '/');
    const wiki = JSON.parse(await fetchText(port, '/api/wiki'));
    assert.equal(/https?:\/\//iu.test(html), false, `${repo.name} UI references external URL`);
    assert.equal(/cdn|unpkg|jsdelivr|cdnjs|esm\.sh/iu.test(html), false, `${repo.name} UI references CDN marker`);
    for (const token of ['OAF Governed Graph', 'Current', 'History', '2D', '3D', 'Search graph', 'Architecture']) {
      assert.ok(html.includes(token), `${repo.name} missing UI token ${token}`);
    }
    assert.equal(started.startup.safeguards.assetsCompiledIn, true);
    assert.equal(current.safeguards.networkCalls, 0);
    assert.equal(current.safeguards.modelCalls, 0);
    assert.equal(current.safeguards.externalWritesEnabled, false);
    assert.ok(current.nodes.length > 0, `${repo.name} graph nodes`);
    assert.ok(current.edges.length > 0, `${repo.name} graph edges`);
    assert.ok(current.communities.length > 0, `${repo.name} graph communities`);
    assert.equal(wiki.summary.zeroCdn, true);
    assert.equal(wiki.summary.networkCalls, 0);
    assert.equal(wiki.summary.modelCalls, 0);
    return {
      repo: repo.name,
      parsedFileCount: ingest.summary.parsedFileCount,
      generatedFactCount: ingest.summary.generatedFactCount,
      generatedCallCount: ingest.summary.generatedCallCount,
      languageCounts: ingest.quality.languageCounts,
      graphNodeCount: current.nodes.length,
      graphEdgeCount: current.edges.length,
      communityCount: current.communities.length,
      wikiCurrentFactCount: wiki.summary.currentFactCount,
      htmlBytes: html.length,
      ingestWallMs: Number((performance.now() - ingestStarted).toFixed(3)),
      uiStartAndFetchMs: Number((performance.now() - uiStarted).toFixed(3)),
      offlineProof: {
        externalUrlReferences: 0,
        cdnReferences: 0,
        networkCalls: current.safeguards.networkCalls,
        modelCalls: current.safeguards.modelCalls,
        externalDatabase: false
      }
    };
  } finally {
    started.child.kill('SIGTERM');
    await new Promise((resolve) => started.child.once('exit', resolve));
    assert.equal(started.stderr().trim(), '');
  }
}

assert.equal(existsSync(RUST_BIN), true, 'build rust/target/release/oaf before running this harness');

const temp = mkdtempSync(path.join(os.tmpdir(), 'oaf-rust-ui-surface-'));
try {
  const repos = [
    { name: 'dtolnay/itoa', cloneUrl: 'https://github.com/dtolnay/itoa.git' },
    { name: 'expressjs/express', cloneUrl: 'https://github.com/expressjs/express.git' }
  ];
  const results = [];
  for (const repo of repos) {
    results.push(await uiProofForRepo(temp, repo));
  }
  console.log(JSON.stringify({
    schemaVersion: '1.0.0',
    command: 'rust ui surface quality',
    methodology: 'Fresh shallow clones of two public repos; OAF ingests locally, approves governed proposals, serves compiled-in UI over 127.0.0.1, then fetches HTML plus graph/wiki JSON. No CDN, browser package, model, cloud, or external DB at runtime.',
    repos: results,
    aggregate: {
      repoCount: results.length,
      graphNodeCount: results.reduce((sum, item) => sum + item.graphNodeCount, 0),
      graphEdgeCount: results.reduce((sum, item) => sum + item.graphEdgeCount, 0),
      communityCount: results.reduce((sum, item) => sum + item.communityCount, 0)
    },
    safeguards: {
      modelCalls: 0,
      externalDatabase: false,
      runtimeNetworkCallsAfterClone: 0,
      zeroCdn: true
    },
    status: 'PASS'
  }, null, 2));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
