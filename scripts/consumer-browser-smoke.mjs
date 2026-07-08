import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = process.cwd();
const temp = await mkdtemp(path.join(os.tmpdir(), 'oaf-consumer-browser-'));
const workspace = path.join(temp, 'workspace');
const home = path.join(temp, 'home');
const data = path.join(temp, 'data');
const password = 'correct horse battery staple';
let server = null;
let browser = null;

try {
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), JSON.stringify({ name: 'consumer-browser-target' }, null, 2));
  await writeFile(path.join(workspace, 'AGENTS.md'), 'Use local context handoffs and proposal-gated memory.');
  await writeFile(path.join(workspace, 'src', 'app.js'), 'export function launchSmoke(){ return "ready"; }\n');
  await writeFile(path.join(workspace, 'src', 'huge.js'), Array.from({ length: 500 }, (_, index) => `export function helper${index}(){ return "local proof ${index}"; }`).join('\n'));

  const port = await freePort();
  server = spawn(process.execPath, ['services/control-api/src/server.mjs'], {
    cwd: root,
    env: { ...process.env, OAF_PORT: String(port), OAF_DATA_DIR: data, OAF_WORKSPACE_ROOT: workspace, HOME: home },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForHealth(port);

  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const browserErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));

  const base = `http://127.0.0.1:${port}`;
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await waitForText(page, 'Create owner');
  for (const label of ['Connect', 'Save Tokens', 'Add Memory', 'View Repo Map']) await waitForText(page, label);
  await page.fill('input[name="username"]', 'owner');
  await page.fill('input[name="displayName"]', 'Owner');
  await page.fill('input[name="password"]', password);
  await page.getByRole('button', { name: 'Create owner' }).click();
  await waitForText(page, 'Choose what you need first.');

  await page.getByRole('link', { name: /Connect/ }).click();
  await waitForText(page, 'Harness setup preview');
  await page.locator('#harness-setup-form button[type="submit"]').click();
  await waitForText(page, 'Harness setup preview ready.');
  await waitForText(page, 'Home writes');

  await page.locator('a[data-route="context-pack"]').first().click();
  await waitForText(page, 'Inputs to review');
  await page.fill('textarea[name="objective"]', 'Consumer browser smoke');
  await page.fill('input[name="step"]', 'verify rendered first-run flow');
  await page.fill('textarea[name="userSelectedFiles"]', 'src/huge.js');
  await page.fill('textarea[name="changedLocators"]', 'src/app.js');
  await page.locator('#context-pack-form button[type="submit"]').click();
  await waitForText(page, 'PRACTICAL HANDOFF');
  await waitForText(page, 'Status\nready');
  await waitForText(page, 'TOKEN SAVER');
  await waitForText(page, 'Provider billing\nnot claimed');
  const tokenSaverProof = await page.evaluate(() => /TOKEN SAVER\s+\d+ -> \d+ tokens\s+([1-9]\d*)% saved/u.test(document.body.innerText));
  must(tokenSaverProof, 'Token Saver did not render a non-zero saved percentage');
  await mustNotContain(page, 'SMOKE RAW BODY');

  await page.locator('a[data-route="memory"]').first().click();
  await waitForText(page, 'Preview first, approve after.');
  await page.fill('#memory-intake-form textarea[name="text"]', 'Fact: project:oaf consumer_browser_smoke rendered.');
  await page.locator('#memory-intake-form button[value="preview"]').click();
  await waitForText(page, '1 proposal');
  await waitForText(page, '0 active memory created');

  await page.locator('a[data-route="source-graph"]').first().click();
  await waitForText(page, 'Repo Map');
  await page.fill('input[name="query"]', 'launchSmoke');
  await page.fill('input[name="changedLocator"]', 'src/app.js');
  await page.locator('#source-graph-form button[type="submit"]').click();
  await waitForText(page, 'Search results');
  await waitForText(page, 'Diff impact');
  await waitForText(page, 'Preview repo map');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await waitForText(page, 'Choose what you need first.');
  const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  must(!hasHorizontalOverflow, 'mobile first-use shell has horizontal overflow');
  must(browserErrors.length === 0, `browser console/page errors: ${browserErrors.join('\n')}`);

  console.log('PASS consumer browser smoke: bootstrap, Connect, Token Saver, Add Memory, Repo Map, mobile shell');
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) {
    server.kill('SIGTERM');
    await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
  await rm(temp, { recursive: true, force: true });
}

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true });
  } catch (primaryError) {
    try {
      return await chromium.launch({ headless: true, channel: 'chrome' });
    } catch {
      primaryError.message = `${primaryError.message}\nInstall Playwright Chromium with: npx playwright install chromium`;
      throw primaryError;
    }
  }
}

function must(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForText(page, text) {
  try {
    await page.waitForFunction((value) => document.body.innerText.includes(value), text, { timeout: 15_000 });
  } catch {
    const body = await page.evaluate(() => document.body.innerText.slice(0, 4000)).catch(() => '');
    throw new Error(`Missing text: ${text}\nVisible text:\n${body}`);
  }
}

async function mustNotContain(page, text) {
  const found = await page.evaluate((value) => document.body.innerText.includes(value), text);
  must(!found, `page leaked forbidden text: ${text}`);
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
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('control API did not become healthy');
}
