import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = process.cwd();
const temp = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-large-browser-'));
const workspace = path.join(temp, 'workspace');
const home = path.join(temp, 'home');
const data = path.join(workspace, '.local');
const screenshots = path.join(root, '.scratch', 'ui-redesign');
const nativeBinary = path.resolve('rust', 'target', 'release', process.platform === 'win32' ? 'oaf.exe' : 'oaf');
const phase = process.argv.includes('--overview') ? 'overview' : process.argv.includes('--map') ? 'map' : 'all';
const indexBounds = ['--max-files', '2000', '--max-nodes', '30000', '--max-edges', '50000'];
let server = null;
let browser = null;

if (process.argv.slice(2).some((argument) => !['--overview', '--map'].includes(argument)) || (process.argv.includes('--overview') && process.argv.includes('--map'))) {
  throw new Error('usage: large-repository-browser-smoke [--overview|--map]');
}

try {
  await stat(nativeBinary);
  run('git', ['clone', '--no-local', '--quiet', root, workspace]);
  const trackedFiles = run('git', ['ls-files'], workspace).stdout.split(/\r?\n/u).filter(Boolean).length;
  must(trackedFiles >= 1_000, `large repository fixture is too small: ${trackedFiles} tracked files`);
  await mkdir(home, { recursive: true });
  await mkdir(screenshots, { recursive: true });

  const indexed = runJson(process.execPath, [
    'apps/cli/oaf.mjs', 'graph', 'index', '--write', '--engine', 'native-preview',
    '--root', workspace, ...indexBounds, '--format', 'json'
  ], { env: { ...process.env, MEMORY_RECALL_NATIVE_BINARY: nativeBinary } });
  must(['ready', 'partial'].includes(indexed.status) && indexed.safeguards?.localFilesWritten === 1, `large repository did not build a bounded native index: ${JSON.stringify(indexed)}`);

  const port = await freePort();
  server = spawn(process.execPath, ['services/control-api/src/server.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      MEMORY_RECALL_NATIVE_BINARY: nativeBinary,
      OAF_PORT: String(port),
      OAF_DATA_DIR: data,
      OAF_WORKSPACE_ROOT: workspace,
      HOME: home
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForHealth(port);

  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const browserErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()); });
  page.on('pageerror', (error) => browserErrors.push(error.message));
  const base = `http://127.0.0.1:${port}`;

  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Set up this workspace', exact: true }).waitFor();
  await page.fill('input[name="username"]', 'owner');
  await page.fill('input[name="displayName"]', 'Owner');
  await page.fill('input[name="password"]', 'correct horse battery staple');
  await page.getByRole('button', { name: 'Create local owner' }).click();
  await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();

  let overview = null;
  if (phase !== 'map') {
    overview = await page.evaluate(() => {
    const groups = [...document.querySelectorAll('.orientation-group')];
    const regions = ['.orientation-heading', '.architecture-region', '.start-here', '.current-impact', '.trusted-context']
      .map((selector) => [selector, document.querySelector(selector)?.getBoundingClientRect() ?? null]);
    return {
      groupCount: groups.length,
      prefixes: groups.map((group) => group.querySelector('span')?.textContent?.trim() ?? ''),
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      regions
    };
    });
    must(overview.groupCount >= 2 && overview.groupCount <= 12, `large Overview group count is outside bounds: ${overview.groupCount}`);
    must(new Set(overview.prefixes).size === overview.prefixes.length, 'large Overview renders duplicate architecture path groups');
    must(!overview.overflow, 'large Overview has horizontal overflow');
    must(indexed.status === 'partial' ? await page.locator('.coverage-label').textContent().then((text) => /partial/iu.test(text ?? '')) : true, 'large Overview does not disclose partial coverage');
    for (const [selector, box] of overview.regions) {
      must(box && box.y + box.height <= 900, `${selector} is outside the first large-repository desktop viewport`);
    }
    await page.screenshot({ path: path.join(screenshots, 'large-overview-desktop-1440.png'), fullPage: true });
  }

  if (phase !== 'overview') {
    const group = overview?.prefixes[0] ?? 'apps/web';
    const mapResponse = page.waitForResponse((response) => response.url().endsWith('/api/context/graph/preview'));
    await page.goto(`${base}/map?group=${encodeURIComponent(group)}`, { waitUntil: 'domcontentloaded' });
    const mapPreview = await mapResponse;
    must(mapPreview.ok(), `large Map request failed: ${mapPreview.status()} ${await mapPreview.text()}`);
    await page.getByRole('heading', { name: 'Focused map', exact: true }).waitFor();
    await page.locator('#source-map-canvas').waitFor();
    await page.waitForFunction(() => document.querySelector('#source-map-canvas')?.dataset.layoutReady === 'true');
    const map = await page.evaluate(() => {
    const canvas = document.querySelector('#source-map-canvas');
    const outline = [...document.querySelectorAll('.source-map-outline [data-node-id]')];
    return {
      outlineCount: outline.length,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      labelsBounded: outline.every((button) => {
        const label = button.querySelector('.source-map-outline-label');
        const locator = button.querySelector('.source-map-outline-locator');
        return [label, locator].every((element) => element && getComputedStyle(element).overflow === 'hidden' && getComputedStyle(element).textOverflow === 'ellipsis');
      }),
      canvasHeight: canvas?.getBoundingClientRect().height ?? 0
    };
    });
    must(map.outlineCount > 0 && map.outlineCount <= 100, `large Map outline is outside bounds: ${map.outlineCount}`);
    must(map.labelsBounded, 'large Map outline does not truncate long labels safely');
    must(map.canvasHeight >= 280, 'large Map canvas has no usable viewport');
    must(!map.overflow, 'large Map has desktop horizontal overflow');
    must(indexed.status === 'partial' ? await page.getByText('Partial coverage', { exact: true }).count().then(Boolean) : true, 'large Map does not disclose partial coverage');
    const outline = page.locator('.source-map-outline [data-node-id]');
    if (await outline.count() > 1) {
      await outline.nth(1).focus();
      await page.keyboard.press('Enter');
      const selected = await page.locator('#source-map-selection').getAttribute('data-selected-node-id');
      must(selected === await outline.nth(1).getAttribute('data-node-id'), 'large Map keyboard selection did not update the inspector');
    }
    await page.screenshot({ path: path.join(screenshots, 'large-map-desktop-1440.png'), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Focused map', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('#source-map-canvas')?.dataset.layoutReady === 'true');
    must(!(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)), 'large Map has mobile horizontal overflow');
    await page.locator('.source-map-outline [data-node-id]').last().scrollIntoViewIfNeeded();
    const [lastOutline, mobileNav] = await Promise.all([
      page.locator('.source-map-outline [data-node-id]').last().boundingBox(),
      page.locator('.bottom-nav').boundingBox()
    ]);
    must(lastOutline && mobileNav && lastOutline.y + lastOutline.height <= mobileNav.y + 1, 'large Map outline is obscured by mobile navigation');
    await page.screenshot({ path: path.join(screenshots, 'large-map-mobile-390.png'), fullPage: true });
  }
  must(browserErrors.length === 0, `large repository browser errors: ${browserErrors.join('\n')}`);

  console.log(`PASS large repository browser smoke: ${trackedFiles} tracked files, ${phase} phase`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) {
    server.kill('SIGTERM');
    await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 2_000))]);
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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('large repository Control API did not become healthy');
}

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout || result.error?.message || 'unknown error'}`);
  return result;
}

function runJson(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout || result.error?.message || 'unknown error'}`);
  return JSON.parse(result.stdout);
}

function must(condition, message) {
  if (!condition) throw new Error(message);
}
