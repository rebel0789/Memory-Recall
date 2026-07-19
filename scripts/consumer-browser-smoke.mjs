import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = process.cwd();
if (process.argv.slice(2).includes('--installed-native-only')) {
  await runInstalledNativeWorkbenchSmoke();
  process.exit(0);
}
const temp = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-browser-'));
const workspace = path.join(temp, 'workspace');
const home = path.join(temp, 'home');
const data = path.join(workspace, '.local');
const screenshots = path.join(root, '.scratch', 'ui-redesign');
const password = 'correct horse battery staple';
const nativeBinary = path.resolve('rust', 'target', 'release', process.platform === 'win32' ? 'oaf.exe' : 'oaf');
let server = null;
let browser = null;

try {
  await createRepositoryFixture();
  const nativeIndex = runJson(process.execPath, [
    'apps/cli/oaf.mjs', 'graph', 'index', '--write', '--engine', 'native-preview',
    '--root', workspace, '--format', 'json'
  ], { env: { ...process.env, MEMORY_RECALL_NATIVE_BINARY: nativeBinary } });
  must(nativeIndex.status === 'ready' && nativeIndex.safeguards?.localFilesWritten === 1, 'browser fixture did not build its explicit native index');
  const port = await freePort();
  server = spawn(process.execPath, ['services/control-api/src/server.mjs'], {
    cwd: root,
    env: { ...process.env, MEMORY_RECALL_NATIVE_BINARY: nativeBinary, OAF_PORT: String(port), OAF_DATA_DIR: data, OAF_WORKSPACE_ROOT: workspace, HOME: home },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForHealth(port);

  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const browserErrors = [];
  let expectedGraphFailureActive = false;
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (expectedGraphFailureActive && /^Failed to load resource: the server responded with a status of 503 \(Service Unavailable\)$/u.test(message.text())) return;
    browserErrors.push(message.text());
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));

  const base = `http://127.0.0.1:${port}`;
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await waitForText(page, 'Set up this workspace');
  await waitForText(page, 'Workspace security');
  await page.screenshot({ path: path.join(screenshots, 'setup-desktop-1440.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(screenshots, 'setup-mobile-390.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.fill('input[name="username"]', 'owner');
  await page.fill('input[name="displayName"]', 'Owner');
  await page.fill('input[name="password"]', password);
  await page.getByRole('button', { name: 'Create local owner' }).click();

  await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
  for (const label of ['Architecture', 'Start here', 'Current impact', 'Trusted context']) await waitForText(page, label);
  const overviewTruth = await page.evaluate(() => ({
    repository: document.querySelector('#repository-name')?.textContent?.trim(),
    branch: document.querySelector('#repository-branch')?.textContent?.trim(),
    coverage: document.querySelector('.coverage-label')?.textContent?.trim(),
    groupCount: document.querySelectorAll('.orientation-group').length,
    startCount: document.querySelectorAll('.start-item').length,
    impact: document.querySelector('.current-impact')?.innerText ?? '',
    trust: document.querySelector('.trusted-context')?.innerText ?? '',
    metricCount: document.querySelectorAll('.metric-strip').length,
    heroCount: document.querySelectorAll('.fabric-hero').length,
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    height: document.querySelector('.orientation-workbench')?.getBoundingClientRect().height ?? 0,
    statusCount: document.querySelectorAll('[role="status"]').length,
    regionBoxes: Object.fromEntries(['.orientation-heading', '.architecture-region', '.start-here', '.current-impact', '.trusted-context'].map((selector) => {
      const box = document.querySelector(selector)?.getBoundingClientRect();
      return [selector, box ? { y: box.y, height: box.height, bottom: box.bottom } : null];
    }))
  }));
  must(overviewTruth.repository === 'workspace', `unexpected repository name: ${overviewTruth.repository}`);
  must(Boolean(overviewTruth.branch) && overviewTruth.branch !== 'Branch unavailable', `missing branch truth: ${overviewTruth.branch}`);
  must(Boolean(overviewTruth.coverage) && !/unavailable/iu.test(overviewTruth.coverage), `missing coverage truth: ${overviewTruth.coverage}`);
  must(overviewTruth.groupCount >= 2 && overviewTruth.groupCount <= 12, `unexpected bounded native orientation group count: ${overviewTruth.groupCount}`);
  must(overviewTruth.startCount === 3, `Overview must show exactly three ranked starts: ${overviewTruth.startCount}`);
  must(/affected|outside the represented graph/iu.test(overviewTruth.impact), `changed-file impact is not useful: ${overviewTruth.impact}`);
  must(/pending/iu.test(overviewTruth.trust), `pending governed memory is not visible: ${overviewTruth.trust}`);
  must(/verified/iu.test(overviewTruth.trust), `verified handoff is not visible: ${overviewTruth.trust}`);
  must(overviewTruth.metricCount === 0 && overviewTruth.heroCount === 0, 'Overview contains retired dashboard or hero chrome');
  must(!overviewTruth.overflow, 'desktop Overview has horizontal overflow');
  must(overviewTruth.height > 0 && overviewTruth.height < 820, `Overview contains excessive empty height: ${overviewTruth.height}; ${JSON.stringify(overviewTruth.regionBoxes)}`);
  must(overviewTruth.statusCount > 0, 'screen-reader status is missing');
  for (const selector of ['.orientation-heading', '.architecture-region', '.start-here', '.current-impact', '.trusted-context']) {
    const box = await page.locator(selector).boundingBox();
    must(box && box.y + box.height <= 900, `${selector} is outside the first desktop viewport`);
  }
  for (const phrase of ['AI-powered', 'smart insights', 'mission control', 'command center', 'nervous system']) await mustNotContain(page, phrase);

  await page.screenshot({ path: path.join(screenshots, 'overview-desktop-light-1440.png'), fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: path.join(screenshots, 'overview-desktop-dark-1440.png'), fullPage: true });
  await page.emulateMedia({ colorScheme: 'light' });

  const initialGroupCopy = await page.locator('.region-heading p').textContent();
  const selectedGroupButton = page.locator('.orientation-group').nth(1);
  await selectedGroupButton.focus();
  await page.keyboard.press('Enter');
  must(await selectedGroupButton.getAttribute('aria-pressed') === 'true', 'keyboard selection did not update the active repository group');
  const selectedGroupCopy = await page.locator('.region-heading p').textContent();
  must(selectedGroupCopy !== initialGroupCopy, 'repository group selection did not update the inspector');
  const selectedPrefix = (await selectedGroupButton.locator('span').textContent()).trim();
  await page.getByRole('link', { name: 'Open in Map' }).click();
  await page.waitForURL(/\/map\?.*group=/u);
  must(new URL(page.url()).searchParams.get('group') === selectedPrefix, 'Overview deep link did not preserve the selected group');
  must(await page.inputValue('input[name="group"]') === selectedPrefix, 'Map form did not hydrate the group from the URL');

  await page.locator('.map-advanced summary').click();
  await page.fill('input[name="group"]', '');
  await page.fill('input[name="limit"]', '100');
  await page.fill('#source-graph-form input[name="query"]', 'startApp');
  const startAppResponse = page.waitForResponse((response) => graphPreviewQuery(response.request()) === 'startApp');
  await Promise.all([startAppResponse, page.getByRole('button', { name: 'Run map' }).click()]);
  await page.waitForFunction(() => document.querySelector('#live-status')?.textContent === 'Map loaded.');
  await waitForText(page, 'Focused map');
  await page.locator('#source-map-canvas').waitFor();
  const successfulMapUrl = page.url();

  const recoverableGraphFailure = async (route) => {
    let payload = {};
    try { payload = route.request().postDataJSON() ?? {}; } catch {}
    if (payload.query !== 'recoverableFailure') return route.continue();
    return route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'source_graph_temporarily_unavailable', message: 'Recoverable graph failure.', correlationId: 'req_browser_failure' } })
    });
  };
  expectedGraphFailureActive = true;
  await page.route('**/api/context/graph/preview', recoverableGraphFailure);
  await page.fill('#source-graph-form input[name="query"]', 'recoverableFailure');
  const failureResponse = page.waitForResponse((response) => graphPreviewQuery(response.request()) === 'recoverableFailure');
  await Promise.all([failureResponse, page.getByRole('button', { name: 'Run map' }).click()]);
  await waitForText(page, 'Recoverable graph failure.');
  const failedMapUrl = page.url();
  await assertMapState(page, { query: 'recoverableFailure', group: '' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForText(page, 'Recoverable graph failure.');
  await assertMapState(page, { query: 'recoverableFailure', group: '' });
  await page.goBack();
  await page.waitForURL(successfulMapUrl);
  await waitForText(page, 'Focused map');
  await assertMapState(page, { query: 'startApp', group: '' });
  await page.goForward();
  await page.waitForURL(failedMapUrl);
  await waitForText(page, 'Recoverable graph failure.');
  await assertMapState(page, { query: 'recoverableFailure', group: '' });
  await page.goBack();
  await page.waitForURL(successfulMapUrl);
  await page.locator('#source-map-canvas').waitFor();
  await page.unroute('**/api/context/graph/preview', recoverableGraphFailure);
  expectedGraphFailureActive = false;

  await page.waitForFunction(() => document.querySelector('#source-map-canvas')?.dataset.layoutReady === 'true');
  const focusNodeCount = await page.locator('.source-map-outline [data-node-id]').count();
  must(focusNodeCount > 20 && focusNodeCount <= 200, `large focused graph is outside node bounds: ${focusNodeCount}`);
  const initialNodeId = await page.locator('#source-map-selection').getAttribute('data-selected-node-id');
  must(Boolean(initialNodeId), 'focused graph has no canonical selection');
  await page.getByRole('button', { name: 'Fit selection' }).click();
  await page.locator('#source-map-canvas').hover();
  await page.mouse.wheel(0, -180);
  await page.getByRole('button', { name: 'Reset view' }).click();
  const outlineButtons = page.locator('.source-map-outline [data-node-id]');
  if (focusNodeCount > 1) await outlineButtons.nth(1).click();
  const outlineNodeId = await page.locator('#source-map-selection').getAttribute('data-selected-node-id');
  must(Boolean(outlineNodeId), 'outline selection did not update the canonical node');
  await page.getByRole('button', { name: 'Fit selection' }).click();
  const canvasBox = await page.locator('#source-map-canvas').boundingBox();
  must(Boolean(canvasBox), 'focused graph canvas has no bounds');
  await page.locator('#source-map-canvas').click({ position: { x: canvasBox.width / 2, y: canvasBox.height / 2 } });
  must(await page.locator('#source-map-selection').getAttribute('data-selected-node-id') === outlineNodeId, 'canvas and outline selection diverged');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const motion = await page.locator('#source-map-canvas').evaluate((element) => ({
    transition: getComputedStyle(element).transitionDuration,
    animation: getComputedStyle(element).animationDuration
  }));
  must(parseCssSeconds(motion.transition) <= 0.001 && parseCssSeconds(motion.animation) <= 0.001, `reduced motion is not bounded: ${JSON.stringify(motion)}`);
  await page.setViewportSize({ width: 900, height: 900 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#source-map-canvas')?.dataset.layoutReady === 'true');
  await page.screenshot({ path: path.join(screenshots, 'map-focused-tablet-900.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#source-map-canvas')?.dataset.layoutReady === 'true');
  await page.screenshot({ path: path.join(screenshots, 'map-focused-desktop-1440.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#source-map-canvas')?.dataset.layoutReady === 'true');
  must(!(await hasHorizontalOverflow(page)), 'focused Map has horizontal overflow at 390px');
  await page.locator('.source-map-outline [data-node-id]').last().scrollIntoViewIfNeeded();
  const [lastOutlineBox, mobileNavBox] = await Promise.all([
    page.locator('.source-map-outline [data-node-id]').last().boundingBox(),
    page.locator('.bottom-nav').boundingBox()
  ]);
  must(lastOutlineBox && mobileNavBox && lastOutlineBox.y + lastOutlineBox.height <= mobileNavBox.y + 1, 'mobile Map outline is obscured by navigation');
  await page.screenshot({ path: path.join(screenshots, 'map-focused-mobile-390.png'), fullPage: true });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/memory-graph`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Graph', exact: true }).waitFor();
  await page.locator('#memory-graph-history').check();
  await waitForText(page, 'Superseded');
  await waitForText(page, 'Provenance workspace://memory/status.md');
  must(await page.locator('#memory-graph-canvas').count() === 1, 'populated memory graph has no canvas');
  must(await page.locator('.memory-graph-outline [data-node-id]').count() > 0, 'populated memory graph has no outline');
  await page.screenshot({ path: path.join(screenshots, 'memory-graph-populated-1440.png'), fullPage: true });
  await page.setViewportSize({ width: 900, height: 900 });
  await page.waitForTimeout(100);
  await page.screenshot({ path: path.join(screenshots, 'memory-graph-populated-900.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });

  const emptyMemoryResponse = (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      schemaVersion: '1.0.0', workspaceId: 'ws_local', generatedAt: new Date().toISOString(),
      provider: 'provider:native:memory:sqlite', mode: 'current',
      summary: { nodeCount: 0, edgeCount: 0, currentNodeCount: 0, currentEdgeCount: 0, historyNodeCount: 0, historyEdgeCount: 0, communityCount: 0 },
      graph: { nodes: [], edges: [] }, focus: null,
      safeguards: { readOnly: true, modelCalls: 0, networkCalls: 0, externalWritesEnabled: false }
    })
  });
  await page.route('**/api/memory/graph?*', emptyMemoryResponse);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForText(page, 'No governed memory yet');
  await waitForText(page, 'Checked workspace');
  must(await page.locator('#memory-graph-canvas').count() === 0, 'empty memory state rendered a canvas');
  must(await page.locator('.metric-strip').count() === 0, 'empty memory state rendered zero metrics');
  await page.screenshot({ path: path.join(screenshots, 'memory-graph-empty-1440.png'), fullPage: true });
  await page.unroute('**/api/memory/graph?*', emptyMemoryResponse);

  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  for (const width of [320, 375, 414, 768, 1440]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
    must(!(await hasHorizontalOverflow(page)), `Overview has horizontal overflow at ${width}px`);
    const navSelector = width <= 700 ? '#mobile-nav a' : '#primary-nav a';
    const navHeights = await page.locator(navSelector).evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height));
    must(navHeights.length > 0 && navHeights.every((height) => height >= 44), `navigation target below 44px at ${width}px: ${JSON.stringify(navHeights)}`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
  await page.screenshot({ path: path.join(screenshots, 'overview-mobile-390.png'), fullPage: true });

  must(browserErrors.length === 0, `browser console/page errors: ${browserErrors.join('\n')}`);
  console.log('PASS consumer browser smoke: orientation, deterministic Map, governed memory, responsive shell');
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) {
    server.kill('SIGTERM');
    await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
  await rm(temp, { recursive: true, force: true });
}

async function createRepositoryFixture() {
  for (const directory of [
    'apps/web', 'packages/core', 'services/control-api',
    'providers/native/memory', 'scripts', 'tests', 'memory', 'docs'
  ]) await mkdir(path.join(workspace, directory), { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(screenshots, { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), JSON.stringify({ name: 'memory-recall-browser-target', type: 'module' }, null, 2));
  await writeFile(path.join(workspace, 'AGENTS.md'), 'Use local context handoffs and proposal-gated memory.');
  const helperNames = Array.from({ length: 120 }, (_, index) => `helper${index}`);
  const helperModule = helperNames.map((name, index) => `export function ${name}(){ return "local proof ${index}"; }`).join('\n');
  const appImports = `import { ${helperNames.join(', ')} } from "../../packages/core/helpers.js";`;
  const helperCalls = helperNames.map((name) => `${name}();`).join('');
  const baseApp = `import { serveControl } from "../../services/control-api/server.js";\n${appImports}\nexport function startApp(){ ${helperCalls} return serveControl(); }\n`;
  await writeFile(path.join(workspace, 'packages', 'core', 'index.js'), 'export function buildContext(value){ return { value, source: "local" }; }\n');
  await writeFile(path.join(workspace, 'packages', 'core', 'helpers.js'), `${helperModule}\n`);
  await writeFile(path.join(workspace, 'providers', 'native', 'memory', 'index.js'), 'export function readMemory(){ return "approved facts"; }\n');
  await writeFile(path.join(workspace, 'services', 'control-api', 'server.js'), 'import { buildContext } from "../../packages/core/index.js";\nimport { readMemory } from "../../providers/native/memory/index.js";\nexport function serveControl(){ return buildContext(readMemory()); }\n');
  await writeFile(path.join(workspace, 'apps', 'web', 'main.js'), baseApp);
  await writeFile(path.join(workspace, 'scripts', 'check.mjs'), 'import { startApp } from "../apps/web/main.js";\nexport function runCheck(){ return startApp(); }\n');
  await writeFile(path.join(workspace, 'tests', 'main.test.js'), 'import { startApp } from "../apps/web/main.js";\nexport function verifyMain(){ return startApp().source === "local"; }\n');
  await writeFile(path.join(workspace, 'memory', 'status.md'), 'Decision: project:memory-recall release_status ready supersedes draft.');
  await writeFile(path.join(workspace, '.gitignore'), '.local/\n');
  runJson(process.execPath, ['apps/cli/oaf.mjs', 'memory', 'remember', '--root', workspace, '--sqlite', '.local/memory.sqlite', '--subject', 'project:memory-recall', '--predicate', 'release_status', '--object', 'draft', '--source', 'workspace://memory/status.md', '--format', 'json']);
  runJson(process.execPath, ['apps/cli/oaf.mjs', 'memory', 'remember', '--root', workspace, '--sqlite', '.local/memory.sqlite', '--subject', 'project:memory-recall', '--predicate', 'release_status', '--object', 'ready', '--supersedes-subject', 'project:memory-recall', '--supersedes-predicate', 'release_status', '--source', 'workspace://memory/status.md', '--format', 'json']);
  run('git', ['init'], workspace);
  run('git', ['config', 'user.email', 'browser-smoke@example.invalid'], workspace);
  run('git', ['config', 'user.name', 'Browser Smoke'], workspace);
  run('git', ['add', '.'], workspace);
  run('git', ['commit', '-m', 'fixture baseline'], workspace);
  await writeFile(path.join(workspace, 'apps', 'web', 'main.js'), `${baseApp}export function normalizeResult(value){ return value; }\n`);
  await writeFile(path.join(workspace, 'docs', 'operator-note.md'), 'One changed non-JavaScript file remains outside source-graph coverage.\n');
  runJson(process.execPath, ['apps/cli/oaf.mjs', 'context', 'pack', '--from', 'codex', '--root', workspace, '--objective', 'Continue the verified local repository change', '--step', 'inspect bounded repository context', '--target', 'codex', '--include-file', 'AGENTS.md', '--changed', 'apps/web/main.js', '--write', '--pin', '--out', 'context-packs/CONTEXT_PACK.md', '--format', 'json']);
  runJson(process.execPath, ['apps/cli/oaf.mjs', 'memory', 'ingest', '--root', workspace, '--sqlite', '.local/memory.sqlite', '--format', 'json']);
}

async function assertMapState(page, expected) {
  const url = new URL(page.url());
  must(url.searchParams.get('query') === expected.query, `Map URL query drifted: ${url}`);
  must((url.searchParams.get('group') ?? '') === expected.group, `Map URL group drifted: ${url}`);
  must(await page.inputValue('#source-graph-form input[name="query"]') === expected.query, 'Map query field drifted from the URL');
  must(await page.inputValue('input[name="group"]') === expected.group, 'Map group field drifted from the URL');
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

function parseCssSeconds(value) {
  return Math.max(...String(value ?? '0s').split(',').map((part) => {
    const number = Number.parseFloat(part) || 0;
    return part.trim().endsWith('ms') ? number / 1000 : number;
  }));
}

function graphPreviewQuery(request) {
  if (!request.url().endsWith('/api/context/graph/preview')) return '';
  try { return request.postDataJSON()?.query ?? ''; } catch { return ''; }
}

function runJson(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
}

async function waitForText(page, text) {
  try {
    await page.waitForFunction((value) => document.body.innerText.toLocaleLowerCase().includes(String(value).toLocaleLowerCase()), text, { timeout: 15_000 });
  } catch {
    const body = await page.evaluate(() => document.body.innerText.slice(0, 5000)).catch(() => '');
    throw new Error(`Missing text: ${text}\nVisible text:\n${body}`);
  }
}

async function mustNotContain(page, text) {
  const found = await page.evaluate((value) => document.body.innerText.toLocaleLowerCase().includes(String(value).toLocaleLowerCase()), text);
  must(!found, `page leaked forbidden text: ${text}`);
}

async function hasHorizontalOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
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

async function runInstalledNativeWorkbenchSmoke() {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-installed-browser-'));
  const workspace = path.join(temp, 'workspace');
  const home = path.join(temp, 'home');
  const data = path.join(temp, 'data');
  const packDirectory = path.join(temp, 'pack');
  const prefix = path.join(temp, 'prefix');
  const runtimeBin = path.join(temp, 'runtime-bin');
  const indexPath = path.join(workspace, '.local', 'source-index', 'index.v1.sqlite');
  const nativeBinary = path.resolve('rust', 'target', 'release', process.platform === 'win32' ? 'oaf.exe' : 'oaf');
  const localPassword = 'correct horse battery staple';
  let server = null;
  let browser = null;
  let serverStderr = '';
  try {
    const [{ nativeTarget }, { packageNativePlatform, spawnNpmSync }] = await Promise.all([
      import('../providers/native/code-intelligence-rust/src/binary-resolver.mjs'),
      import('./package-native-platform.mjs')
    ]);
    const target = nativeTarget();
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(packDirectory, { recursive: true }),
      mkdir(runtimeBin, { recursive: true }),
      mkdir(path.join(workspace, 'app', 'api', 'users'), { recursive: true }),
      mkdir(path.join(workspace, 'src'), { recursive: true })
    ]);
    await Promise.all([
      writeFile(path.join(workspace, 'package.json'), `${JSON.stringify({ name: 'installed-native-browser-smoke' }, null, 2)}\n`),
      writeFile(path.join(workspace, 'app', 'api', 'users', 'route.js'), [
        "import http from 'node:http';",
        'export function GET() { return handleUser(); }',
        'function handleUser() { return persistUser(); }',
        'function persistUser() { return { ok: true }; }',
        'http.createServer(persistUser);'
      ].join('\n')),
      writeFile(path.join(workspace, 'src', 'app.js'), 'export function launchBrowserSmoke(){ return true; }\n'),
      writeFile(path.join(workspace, 'src', 'worker.py'), 'def pythonControlProof():\n    return "native workbench"\n')
    ]);
    const nativePackage = await packageNativePlatform({
      target,
      binaryPath: nativeBinary,
      outDirectory: packDirectory,
      root
    });
    const packed = spawnNpmSync(['pack', '--pack-destination', packDirectory, '--json'], {
      cwd: root,
      encoding: 'utf8'
    });
    must(packed.status === 0, `root package failed to pack: ${packed.stderr || packed.stdout}`);
    const [rootPackage] = JSON.parse(packed.stdout);
    const rootTarball = path.join(packDirectory, rootPackage.filename);
    const cleanEnvironment = withoutNativeOverrides(process.env);
    const installEnvironment = { ...cleanEnvironment, HOME: home, NPM_CONFIG_CACHE: path.join(temp, 'npm-cache') };
    const installed = spawnNpmSync([
      'install', '-g', '--prefix', prefix, rootTarball, nativePackage.tarball,
      '--ignore-scripts', '--offline', '--no-audit', '--no-fund'
    ], { cwd: temp, encoding: 'utf8', env: installEnvironment });
    must(installed.status === 0, `packed install failed: ${installed.stderr || installed.stdout}`);
    const npmRoot = spawnNpmSync(['root', '--global', '--prefix', prefix], {
      cwd: temp,
      encoding: 'utf8',
      env: installEnvironment
    });
    must(npmRoot.status === 0, `installed package root lookup failed: ${npmRoot.stderr || npmRoot.stdout}`);
    const packageRoot = path.join(npmRoot.stdout.trim(), 'memory-recall');
    const installedCli = path.join(packageRoot, 'apps', 'cli', 'oaf.mjs');
    const providerUrl = pathToFileURL(path.join(packageRoot, 'providers', 'native', 'code-intelligence-rust', 'src', 'index.mjs'));
    const isolatedEnvironment = {
      ...cleanEnvironment,
      HOME: home,
      PATH: runtimeBin,
      OAF_FIXED_NOW: '2026-07-17T06:00:00.000Z'
    };
    assertCommandUnavailable('cargo', isolatedEnvironment);
    assertCommandUnavailable('rustc', isolatedEnvironment);
    assertCommandUnavailable('cc', isolatedEnvironment);
    const { RustCodeIntelligenceProvider } = await import(providerUrl.href);
    const health = await withProcessEnvironment(
      isolatedEnvironment,
      () => new RustCodeIntelligenceProvider({ timeoutMs: 60_000 }).health()
    );
    must(health.status === 'healthy', 'installed native provider is healthy');
    must(health.details?.source === 'platform-package' && health.details?.verified === true, 'installed native provider verifies its optional platform package');
    const build = runInstalled(process.execPath, [
      installedCli, 'graph', 'index', '--write', '--engine', 'native-preview',
      '--languages', 'javascript,python', '--root', workspace, '--format', 'json'
    ], { cwd: workspace, env: isolatedEnvironment });
    const buildReport = JSON.parse(build.stdout);
    must(buildReport.status === 'ready' && buildReport.safeguards?.localFilesWritten === 1, 'installed CLI explicitly builds the native index once');
    const indexBeforeBrowser = await fileBundleSnapshot(indexPath);
    must(indexBeforeBrowser[0] !== null, 'explicit installed writer creates SQLite before server start');
    const mcp = runInstalled(process.execPath, [
      installedCli, 'mcp', 'server', '--read-only', '--engine', 'native-preview',
      '--root', workspace, '--stdio'
    ], {
      cwd: workspace,
      env: isolatedEnvironment,
      input: [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'repo.architecture', arguments: { limit: 20 } } }
      ].map((request) => JSON.stringify(request)).join('\n')
    });
    const mcpResponse = mcp.stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line)).find((entry) => entry.id === 2);
    must(mcpResponse && !mcpResponse.error, `installed MCP repo.architecture failed: ${JSON.stringify(mcpResponse?.error)}`);
    const mcpArchitecture = JSON.parse(mcpResponse.result.content[0].text);
    must(
      mcpArchitecture.safeguards?.readOnly === true
      && mcpArchitecture.safeguards?.localFilesWritten === 0,
      'installed MCP repo.architecture is read-only'
    );
    must(
      mcpArchitecture.data?.groups?.some((item) => item.algorithmVersion === 'label-propagation-v1'),
      'installed MCP repo.architecture returns a native community'
    );
    const mcpNodeIds = new Set((mcpArchitecture.data?.nodes ?? []).map((item) => item.id));
    const mcpRelationshipIds = new Set((mcpArchitecture.data?.relationships ?? []).map((item) => item.id));
    const mcpProcess = mcpArchitecture.data?.processes?.find((item) => (
      item.algorithmVersion === 'entry-path-v1'
      && item.truncated === false
      && item.nodeIds?.length >= 2
      && item.relationshipIds?.length >= 1
      && item.nodeIds?.every((id) => mcpNodeIds.has(id))
      && item.relationshipIds?.every((id) => mcpRelationshipIds.has(id))
      && mcpRelationshipIds.has(item.entryRelationshipId)
    ));
    must(mcpProcess, `installed MCP repo.architecture did not return an evidence-backed process: ${JSON.stringify(mcpArchitecture.data?.processes ?? [])}`);
    const retiredGraphPath = path.join(packageRoot, 'providers', 'native', 'context-candidate-ast-code', 'src', 'index.mjs');
    must(await stat(retiredGraphPath).catch(() => null) === null, 'installed package excludes the retired JS graph implementation');

    const port = await freePort();
    server = spawn(process.execPath, [installedCli, 'serve'], {
      cwd: workspace,
      env: {
        ...isolatedEnvironment,
        OAF_PORT: String(port),
        OAF_DATA_DIR: data,
        OAF_WORKSPACE_ROOT: workspace
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stderr.on('data', (chunk) => { serverStderr += chunk; });
    try {
      await waitForHealth(port);
    } catch (error) {
      throw new Error(`${error.message}; server stderr=${serverStderr}`);
    }
    browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const browserErrors = [];
    page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()); });
    page.on('pageerror', (error) => browserErrors.push(error.message));
    const base = `http://127.0.0.1:${port}`;
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await waitForText(page, 'Set up this workspace');
    await page.fill('input[name="username"]', 'owner');
    await page.fill('input[name="displayName"]', 'Owner');
    await page.fill('input[name="password"]', localPassword);
    await page.getByRole('button', { name: 'Create local owner' }).click();
    await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
    const architectureResponsePromise = page.waitForResponse((response) => (
      response.request().url().endsWith('/api/context/graph/preview')
      && graphPreviewQuery(response.request()) === ''
    ));
    await page.goto(`${base}/map`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Map', exact: true }).waitFor();
    const architectureResponse = await architectureResponsePromise;
    const architectureText = await architectureResponse.text();
    must(architectureResponse.ok(), `installed native architecture request failed: ${architectureResponse.status()} ${architectureText}; server stderr=${serverStderr}`);
    const architecture = JSON.parse(architectureText);
    must(/^memory-recall-native-/u.test(architecture.graph?.parserVersion ?? ''), `Control API did not use the installed native index: ${architecture.graph?.parserVersion}`);
    const group = architecture.orientation?.groups?.[0];
    must(group?.prefix, `installed native architecture did not expose a community: ${JSON.stringify(architecture.orientation)}`);
    await waitForText(page, group.prefix);
    const nativeProcess = architecture.orientation?.processes?.find((item) => (
      item.algorithmVersion === 'entry-path-v1'
      && item.truncated === false
      && item.entryPoint?.locator?.startsWith('workspace://app/api/users/route.js')
      && item.sink?.locator?.startsWith('workspace://app/api/users/route.js')
      && item.nodeIds?.length >= 2
      && item.relationshipIds?.length >= 1
    ));
    must(nativeProcess, `installed native architecture did not expose an evidence-backed entry-to-sink process: ${JSON.stringify(architecture.orientation?.processes ?? [])}`);
    const processPanel = await page.locator('.map-processes').innerText();
    must(
      processPanel.includes(nativeProcess.entryPoint.label)
      && processPanel.includes(nativeProcess.sink.label)
      && processPanel.includes(nativeProcess.sinkKind),
      `installed Map did not render the native process: ${processPanel}`
    );
    await page.fill('#source-graph-form input[name="query"]', 'pythonControlProof');
    const graphResponsePromise = page.waitForResponse((response) => graphPreviewQuery(response.request()) === 'pythonControlProof');
    await page.getByRole('button', { name: 'Run map' }).click();
    const graphResponse = await graphResponsePromise;
    const graphText = await graphResponse.text();
    must(graphResponse.ok(), `installed native graph request failed: ${graphResponse.status()} ${graphText}; server stderr=${serverStderr}`);
    const graph = JSON.parse(graphText);
    await page.waitForFunction(() => document.querySelector('#live-status')?.textContent === 'Map loaded.');
    await waitForText(page, 'pythonControlProof');
    must(/^memory-recall-native-/u.test(graph.graph?.parserVersion ?? ''), `Control API did not use the installed native index: ${graph.graph?.parserVersion}`);
    must(
      graph.search?.results?.some((item) => item.label === 'pythonControlProof' && item.locator?.startsWith('workspace://src/worker.py')),
      `browser Map finds the Python-only native symbol and locator: ${JSON.stringify(graph.search?.results ?? [])}`
    );
    must(graph.safeguards?.localFilesWritten === 0, 'browser graph request reports no local index write');
    must(sameFileBundleSnapshot(indexBeforeBrowser, await fileBundleSnapshot(indexPath)), 'MCP, browser, and Control API preserve SQLite bytes and mtime and create no WAL or SHM');
    must(browserErrors.length === 0, `browser console/page errors: ${browserErrors.join('\n')}`);
    console.log(`PASS installed verified native workbench ${target}`);
    console.log('PASS compiler-free loopback Control API and browser Map read the prebuilt index without writing it');
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) {
      server.kill('SIGTERM');
      await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 2000))]);
    }
    await rm(temp, { recursive: true, force: true });
  }
}

function runInstalled(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout || result.error?.message}`);
  return result;
}

function assertCommandUnavailable(command, env) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', env });
  must(result.error?.code === 'ENOENT', `${command} must be unavailable during installed runtime verification`);
}

function withoutNativeOverrides(environment) {
  const {
    MEMORY_RECALL_NATIVE_BINARY: _binary,
    MEMORY_RECALL_NATIVE_SHA256: _sha,
    MEMORY_RECALL_NATIVE_PACKAGE_TARBALL: _tarball,
    ...clean
  } = environment;
  return clean;
}

async function withProcessEnvironment(environment, operation) {
  const previous = new Map();
  for (const [key, value] of Object.entries(environment)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  for (const key of ['MEMORY_RECALL_NATIVE_BINARY', 'MEMORY_RECALL_NATIVE_SHA256', 'MEMORY_RECALL_NATIVE_PACKAGE_TARBALL']) {
    if (!Object.hasOwn(environment, key)) {
      previous.set(key, process.env[key]);
      delete process.env[key];
    }
  }
  try {
    return await operation();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function fileBundleSnapshot(databasePath) {
  return Promise.all([databasePath, `${databasePath}-wal`, `${databasePath}-shm`].map(async (filePath) => {
    try {
      const [metadata, bytes] = await Promise.all([stat(filePath), readFile(filePath)]);
      return { mtimeMs: metadata.mtimeMs, size: metadata.size, bytes };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }));
}

function sameFileBundleSnapshot(left, right) {
  return left.length === right.length && left.every((before, index) => {
    const after = right[index];
    if (before === null || after === null) return before === after;
    return before.mtimeMs === after.mtimeMs && before.size === after.size && before.bytes.equals(after.bytes);
  });
}
