import { spawn, spawnSync } from 'node:child_process';
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
const data = path.join(workspace, '.local');
const password = 'correct horse battery staple';
const screenshots = path.join(root, '.scratch', 'ui-redesign');
let server = null;
let browser = null;

try {
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(screenshots, { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), JSON.stringify({ name: 'consumer-browser-target' }, null, 2));
  await writeFile(path.join(workspace, 'AGENTS.md'), 'Use local context handoffs and proposal-gated memory.');
  await writeFile(path.join(workspace, 'src', 'app.js'), 'export function launchSmoke(){ return "ready"; }\n');
  await writeFile(path.join(workspace, 'src', 'huge.js'), Array.from({ length: 500 }, (_, index) => `export function helper${index}(){ return "local proof ${index}"; }`).join('\n'));
  await mkdir(path.join(workspace, 'memory'), { recursive: true });
  await writeFile(path.join(workspace, 'memory', 'status.md'), 'Decision: project:oaf release_status ready supersedes draft.');
  await writeFile(path.join(workspace, '.gitignore'), '.local/\n');
  runJson(process.execPath, ['apps/cli/oaf.mjs', 'memory', 'remember', '--root', workspace, '--sqlite', '.local/memory.sqlite', '--subject', 'project:oaf', '--predicate', 'release_status', '--object', 'draft', '--source', 'workspace://memory/status.md', '--format', 'json']);
  runJson(process.execPath, ['apps/cli/oaf.mjs', 'memory', 'remember', '--root', workspace, '--sqlite', '.local/memory.sqlite', '--subject', 'project:oaf', '--predicate', 'release_status', '--object', 'ready', '--supersedes-subject', 'project:oaf', '--supersedes-predicate', 'release_status', '--source', 'workspace://memory/status.md', '--format', 'json']);
  run('git', ['init'], workspace);
  run('git', ['config', 'user.email', 'browser-smoke@example.invalid'], workspace);
  run('git', ['config', 'user.name', 'Browser Smoke'], workspace);
  run('git', ['add', '.'], workspace);
  run('git', ['commit', '-m', 'fixture baseline'], workspace);
  await writeFile(path.join(workspace, 'src', 'app.js'), 'export function launchSmoke(){ return changedHelper(); }\nexport function changedHelper(){ return "ready"; }\n');
  await writeFile(path.join(workspace, 'src', 'changed.js'), 'import { launchSmoke } from "./app.js";\nexport const changedResult = launchSmoke();\n');

  const port = await freePort();
  server = spawn(process.execPath, ['services/control-api/src/server.mjs'], {
    cwd: root,
    env: { ...process.env, OAF_PORT: String(port), OAF_DATA_DIR: data, OAF_WORKSPACE_ROOT: workspace, HOME: home },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForHealth(port);

  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const browserErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));

  const base = `http://127.0.0.1:${port}`;
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await waitForText(page, 'Set up this workspace');
  await waitForText(page, 'Workspace security');
  await waitForText(page, 'Run the first scan after sign-in');
  await page.screenshot({ path: path.join(screenshots, 'setup-desktop-1440.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(screenshots, 'setup-mobile-390.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await mustNotContain(page, 'Choose what you need first');
  await mustNotContain(page, 'Developer-first');
  await page.fill('input[name="username"]', 'owner');
  await page.fill('input[name="displayName"]', 'Owner');
  await page.fill('input[name="password"]', password);
  await page.getByRole('button', { name: 'Create local owner' }).click();
  for (const label of ['Changes', 'Needs attention', 'Impact', 'Current handoff', 'Recent activity']) await waitForText(page, label);
  await waitForText(page, 'workspace://src/app.js');
  await waitForText(page, 'workspace://src/changed.js');
  const affectedCount = await page.locator('.overview-impact header span').textContent();
  must(Number.parseInt(affectedCount, 10) > 0, `ordinary Overview did not hydrate meaningful impact: ${affectedCount}`);
  await page.screenshot({ path: path.join(screenshots, 'overview-desktop-light-1440.png'), fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: path.join(screenshots, 'overview-desktop-dark-1440.png'), fullPage: true });
  await page.emulateMedia({ colorScheme: 'light' });
  await mustNotContain(page, 'Developer-first');
  await mustNotContain(page, 'Read the local picture before the next change');
  await mustNotContain(page, 'Index health');
  await assertNoElementHorizontalOverflow(page, '.overview-section', 'desktop Overview section');

  const unavailableGitChanges = (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ status: 'unavailable', reason: 'git_status_failed' })
  });
  await page.route('**/api/context/git-changes', unavailableGitChanges);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForText(page, 'file detection unavailable');
  await waitForText(page, 'Change detection unavailable');
  await mustNotContain(page, 'No changed files detected.');
  await page.unroute('**/api/context/git-changes', unavailableGitChanges);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForText(page, 'workspace://src/app.js');

  await page.fill('#global-search-input', '/private/secret');
  await page.press('#global-search-input', 'Enter');
  await page.waitForURL(/\/map\?query=%2Fprivate%2Fsecret$/u);
  await waitForText(page, 'Repository search failed');
  must(await page.inputValue('#global-search-input') === '/private/secret', 'failed repository query was not preserved');
  await mustNotContain(page, 'No bounded source-graph matches');
  must((await page.locator('#live-status').textContent()).includes('Repository search failed'), 'failed repository query was announced as loaded');

  await page.fill('#global-search-input', 'launchSmoke');
  await page.press('#global-search-input', 'Enter');
  await page.waitForURL(/\/map\?query=launchSmoke$/u);
  await waitForText(page, 'Search results');
  await waitForText(page, 'launchSmoke');
  await page.goBack();
  await page.waitForURL(/\/map\?query=%2Fprivate%2Fsecret$/u);
  await waitForText(page, 'Repository search failed');
  await page.goBack();
  await page.waitForURL(base + '/');
  await page.goForward();
  await page.waitForURL(/\/map\?query=%2Fprivate%2Fsecret$/u);
  await waitForText(page, 'Repository search failed');
  await page.goForward();
  await page.waitForURL(/\/map\?query=launchSmoke$/u);
  await waitForText(page, 'launchSmoke');
  await page.goto(base, { waitUntil: 'domcontentloaded' });

  const stateMatrix = await page.evaluate(async () => {
    const { buildRecallMapHomeModel, renderOverview } = await import('/app.js');
    const response = await fetch('/api/recall/map?workspaceId=ws_local');
    const report = await response.json();
    const cleanReport = structuredClone(report);
    cleanReport.memory = { ...cleanReport.memory, pendingProposals: [], staleFactCount: 0 };
    const gitChanges = { status: 'available', changedLocators: [], totalCount: 0, omittedCount: 0, truncated: false };
    const pinned = (status) => ({
      generatedAt: cleanReport.generatedAt,
      current: { status, entryId: 'handoff-browser-matrix' },
      entries: [{ id: 'handoff-browser-matrix', createdAt: cleanReport.generatedAt }]
    });
    const empty = structuredClone(cleanReport);
    empty.architecture = { ...empty.architecture, entryPoints: [], hotspots: [], impact: { changedLocators: [], representedChangedLocators: [], affectedSymbols: [], depth: 0 } };
    const omitted = structuredClone(cleanReport);
    omitted.architecture = { ...omitted.architecture, impact: { changedLocators: [], representedChangedLocators: [], affectedSymbols: [], depth: 0 } };
    omitted.repository = { ...omitted.repository, dirtyCount: 2 };
    const partial = structuredClone(cleanReport);
    partial.support.sourceGraph.status = 'unavailable';
    partial.support.sourceGraph.coverage.status = 'unavailable';
    const cases = [
      ['loading', { report: null }, 'loading', 'Loading Recall Map', 'Scan repository'],
      ['empty', { report: empty, gitChanges }, 'empty', 'No JS/TS entry points yet', 'Scan repository'],
      ['all-omitted', { report: omitted, gitChanges: { status: 'available', changedLocators: [], totalCount: 2, omittedCount: 2, truncated: true } }, 'success', '0 shown · 2 omitted by safety or scan bounds', ''],
      ['partial', { report: partial, gitChanges }, 'partial', 'Bounded coverage', ''],
      ['stale', { report: cleanReport, gitChanges, pinnedHandoffStatus: pinned('stale') }, 'stale', 'Source changes need review', 'Update handoff'],
      ['blocked', { report: cleanReport, gitChanges, pinnedHandoffStatus: pinned('tampered') }, 'success', 'Handoff blocked', 'Repair handoff'],
      ['success', { report: cleanReport, gitChanges, pinnedHandoffStatus: pinned('verified') }, 'success', 'Current handoff', 'View current handoff'],
      ['auth-error', { error: { status: 401, code: 'authentication_required', message: 'Authentication is required.' } }, 'error', 'Recall Map unavailable', 'Retry scan']
    ];
    const host = document.createElement('div');
    document.querySelector('#view-root').append(host);
    const results = cases.map(([name, args, expectedState, expectedText, expectedAction]) => {
      const model = buildRecallMapHomeModel(args);
      host.innerHTML = renderOverview(model);
      const action = host.querySelector('.page-heading .button, .page-heading a.button')?.textContent?.trim() ?? '';
      return {
        name,
        modelState: model.state,
        expectedState,
        expectedText,
        expectedAction,
        text: host.innerText,
        action,
        overflow: host.scrollWidth > host.clientWidth + 1
      };
    });
    host.remove();
    return results;
  });
  for (const state of stateMatrix) {
    must(state.modelState === state.expectedState, `${state.name} Overview model state mismatch: ${state.modelState}`);
    must(state.text.includes(state.expectedText), `${state.name} Overview state missing ${state.expectedText}`);
    must(!state.expectedAction || state.action === state.expectedAction, `${state.name} Overview action mismatch: ${state.action}`);
    must(!state.overflow, `${state.name} Overview state has horizontal overflow`);
  }

  await page.context().clearCookies();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForText(page, 'Sign in');
  await page.fill('input[name="username"]', 'owner');
  await page.fill('input[name="password"]', 'incorrect password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await waitForText(page, 'Username or password is incorrect.');
  must(await page.inputValue('input[name="username"]') === 'owner', 'login username was not preserved after recoverable failure');
  must(await page.inputValue('input[name="password"]') === 'incorrect password', 'live password input was reconstructed after recoverable failure');
  await page.fill('input[name="password"]', password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await waitForText(page, 'Changes');
  browserErrors.length = 0;

  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [701, 768, 900, 1080]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    const responsiveTablet = await page.evaluate(() => ({
      rail: document.querySelector('.sidebar')?.getBoundingClientRect().width,
      navHeights: [...document.querySelectorAll('#primary-nav a')].map((item) => item.getBoundingClientRect().height),
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    }));
    must(responsiveTablet.rail === 72, `tablet ${width}px rail is not compact: ${JSON.stringify(responsiveTablet)}`);
    must(responsiveTablet.navHeights.every((height) => height >= 44), `tablet ${width}px nav touch target below 44px: ${JSON.stringify(responsiveTablet.navHeights)}`);
    must(!responsiveTablet.overflow, `tablet ${width}px shell has horizontal overflow`);
  }
  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await waitForText(page, 'Changes');
  const tablet = await page.evaluate(() => ({
    rail: document.querySelector('.sidebar')?.getBoundingClientRect().width,
    navHeights: [...document.querySelectorAll('#primary-nav a')].map((item) => item.getBoundingClientRect().height),
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    reducedMotionTransition: getComputedStyle(document.querySelector('#primary-nav a')).transitionDuration,
    reducedMotionAnimation: getComputedStyle(document.querySelector('#primary-nav a')).animationDuration
  }));
  must(tablet.rail === 72, `tablet rail is not compact: ${JSON.stringify(tablet)}`);
  must(tablet.navHeights.every((height) => height >= 44), `tablet nav touch target below 44px: ${JSON.stringify(tablet.navHeights)}`);
  must(!tablet.overflow, 'tablet shell has horizontal overflow');
  must(parseCssSeconds(tablet.reducedMotionTransition) <= 0.001, `reduced motion transition remains active: ${tablet.reducedMotionTransition}`);
  must(parseCssSeconds(tablet.reducedMotionAnimation) <= 0.001, `reduced motion animation remains active: ${tablet.reducedMotionAnimation}`);
  const focusedControls = [];
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press('Tab');
    focusedControls.push(await page.evaluate(() => ({
      id: document.activeElement?.id ?? '',
      tag: document.activeElement?.tagName ?? '',
      href: document.activeElement?.getAttribute?.('href') ?? '',
      outline: getComputedStyle(document.activeElement).outlineWidth
    })));
  }
  must(focusedControls.some((item) => item.id === 'global-search-input'), `keyboard traversal did not reach global search: ${JSON.stringify(focusedControls)}`);
  must(focusedControls.some((item) => item.href === '/map'), `keyboard traversal did not reach primary navigation: ${JSON.stringify(focusedControls)}`);
  must(focusedControls.filter((item) => item.id === 'global-search-input' || item.href === '/map').every((item) => item.outline !== '0px'), `keyboard focus is not visible: ${JSON.stringify(focusedControls)}`);
  await page.screenshot({ path: path.join(screenshots, 'overview-tablet-900.png'), fullPage: true });

  await page.goto(`${base}/agents-tools`, { waitUntil: 'domcontentloaded' });
  await waitForText(page, 'Harness setup preview');
  await page.locator('#harness-setup-form button[type="submit"]').click();
  await waitForText(page, 'Harness setup preview ready.');
  await waitForText(page, 'Home writes');

  await page.locator('a[href="/handoffs"][data-route="context-pack"]').first().click();
  await waitForText(page, 'Handoffs');
  await waitForText(page, 'Build handoff');
  await page.screenshot({ path: path.join(screenshots, 'handoffs-desktop-1440.png'), fullPage: true });
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
  await waitForText(page, 'Review queue');
  await waitForText(page, 'Add memory');
  await page.screenshot({ path: path.join(screenshots, 'memory-desktop-1440.png'), fullPage: true });
  await page.fill('#memory-intake-form textarea[name="text"]', 'Fact: project:oaf consumer_browser_smoke rendered.');
  await page.locator('#memory-intake-form button[value="preview"]').click();
  await waitForText(page, '1 proposal');
  await waitForText(page, '0 active memory created');

  await page.goto(`${base}/memory-graph`, { waitUntil: 'domcontentloaded' });
  await waitForText(page, 'Governed knowledge graph');
  await waitForText(page, 'Current facts');
  await waitForText(page, 'project:oaf release_status ready');
  await page.locator('#memory-graph-history').check();
  await waitForText(page, 'Superseded');
  await waitForText(page, 'project:oaf release_status draft');
  await waitForText(page, 'Provenance workspace://memory/status.md');

  await page.locator('a[href="/map"][data-route="source-graph"]').first().click();
  await waitForText(page, 'Map');
  await page.fill('input[name="query"]', 'launchSmoke');
  await page.fill('input[name="changedLocator"]', 'src/app.js');
  await page.locator('#source-graph-form button[type="submit"]').click();
  await waitForText(page, 'Search results');
  await waitForText(page, 'Changed impact');
  await waitForText(page, 'Run map');
  await page.screenshot({ path: path.join(screenshots, 'map-desktop-1440.png'), fullPage: true });

  for (const [route, label, file] of [['/map', 'Map', 'map-mobile-390.png'], ['/memory', 'Memory', 'memory-mobile-390.png'], ['/handoffs', 'Handoffs', 'handoffs-mobile-390.png']]) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: label, exact: true }).waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    must(!overflow, `${route} has horizontal overflow at 390px`);
    await page.screenshot({ path: path.join(screenshots, file), fullPage: true });
  }

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    for (const label of ['Changes', 'Needs attention', 'Impact', 'Current handoff', 'Recent activity']) await waitForText(page, label);
    const mobile = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      navHeights: [...document.querySelectorAll('#mobile-nav a')].map((item) => item.getBoundingClientRect().height)
    }));
    must(!mobile.overflow, `mobile ${width}px first-use shell has horizontal overflow`);
    must(mobile.navHeights.every((height) => height >= 44), `mobile ${width}px nav touch target below 44px: ${JSON.stringify(mobile.navHeights)}`);
    await assertNoElementHorizontalOverflow(page, '.overview-section', `mobile ${width}px Overview section`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(screenshots, 'overview-mobile-390.png'), fullPage: true });
  must(browserErrors.length === 0, `browser console/page errors: ${browserErrors.join('\n')}`);

  console.log('PASS consumer browser smoke: Recall Map, handoff, harness, Token Saver, memory, graph, mobile shell');
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

function parseCssSeconds(value) {
  return Math.max(...String(value ?? '0s').split(',').map((part) => Number.parseFloat(part) || 0));
}

function runJson(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
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
    const body = await page.evaluate(() => document.body.innerText.slice(0, 4000)).catch(() => '');
    throw new Error(`Missing text: ${text}\nVisible text:\n${body}`);
  }
}

async function mustNotContain(page, text) {
  const found = await page.evaluate((value) => document.body.innerText.includes(value), text);
  must(!found, `page leaked forbidden text: ${text}`);
}

async function assertNoElementHorizontalOverflow(page, selector, label) {
  const overflows = await page.locator(selector).evaluateAll((elements) => elements
    .map((element) => ({
      text: element.innerText.replace(/\s+/gu, ' ').trim().slice(0, 120),
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth
    }))
    .filter((item) => item.scrollWidth > item.clientWidth + 1));
  must(overflows.length === 0, `${label} has horizontal overflow: ${JSON.stringify(overflows)}`);
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
