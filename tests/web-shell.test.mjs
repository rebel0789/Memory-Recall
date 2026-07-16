import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildCompressedProfileContextReport } from '../packages/context-compiler/src/index.mjs';
import { SQLiteMemoryProvider } from '../providers/native/memory-sqlite/src/index.mjs';
import {
  MOBILE_NAV,
  PRIMARY_NAV,
  navigationItemsFor,
  navigationOwner,
  selectOverviewPrimaryAction
} from '../apps/web/shell-model.js';
import {
  ROUTES,
  SHELL_STATES,
  buildApiErrorUiModel,
  buildMemoryWorkspaceConfig,
  buildContextSourcePreviewUiModel,
  buildContextPackUiModel,
  buildCurrentHandoffStatusModel,
  buildApprovalReviewModel,
  buildContextInspectorModel,
  buildEvidenceExplorerModel,
  buildFabricMapModel,
  buildFirstUseReadinessModel,
  buildHarnessSetupUiModel,
  buildLoopWorkbenchModel,
  buildRecallMapHomeModel,
  buildAuthViewModel,
  authFailureTransition,
  normalizeRecallMapGitChanges,
  buildMemoryCockpitModel,
  buildMemoryReviewModel,
  buildPinnedHandoffStatusModel,
  canReceivePinnedHandoff,
  classifyDashboardState,
  contextDecisionView,
  copyCommand,
  contextRecordLink,
  deliveryChangeLabel,
  legacyViewPath,
  normalizeMemorySourceFiles,
  parseSelectedFiles,
  harnessSetupClientsForUi,
  resolveRoute,
  runDetailLink,
  safeEventSummary,
  selectContextPackPinPayload,
  renderMemoryCockpit,
  renderLoopWorkbenchMemoryFlow,
  renderSetupScreen,
  renderContextPackTokenSaverSummary,
  renderMemoryIntakePanel,
  renderOverview,
  renderRepositorySearchState,
  renderRecallMapHome,
  shellStateMessageForOverview,
  shouldLoadProtectedShellData,
  summarizeRunSteps,
  writeClipboardText
} from '../apps/web/app.js';
import { parseMapUrl, renderSourceMap } from '../apps/web/source-map-view.js';
import { buildMemoryGraphViewModel, renderMemoryGraphView } from '../apps/web/memory-graph-view.js';

test('web API and UI primitives are focused modules', async () => {
  const apiSource = await readFile(new URL('../apps/web/api.js', import.meta.url), 'utf8');
  const primitiveSource = await readFile(new URL('../apps/web/ui-primitives.js', import.meta.url), 'utf8');
  const appSource = await readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8');
  assert.match(apiSource, /export async function requestJson/);
  assert.match(apiSource, /export class ApiRequestError/);
  assert.match(primitiveSource, /export function escapeHtml/);
  assert.match(primitiveSource, /export function statePanel/);
  assert.doesNotMatch(appSource, /async function api\(/);
  assert.doesNotMatch(appSource, /function statePanel\(/);
});

test('setup is a focused workspace-security screen', () => {
  const html = renderSetupScreen('bootstrap', 'Create the first local owner.');
  assert.match(html, /Set up this workspace/);
  assert.match(html, /Workspace security/);
  assert.match(html, /Run the first scan after sign-in/);
  assert.match(html, /id="auth-form"/);
  assert.doesNotMatch(html, /Choose what you need first/);
  assert.doesNotMatch(html, /Create handoff/);
  assert.doesNotMatch(html, /Developer-first/i);
});

test('auth view preserves only bounded non-secret draft fields and renders the real error', () => {
  const model = buildAuthViewModel({
    mode: 'bootstrap',
    copy: 'Create the first local owner.',
    draft: { username: 'owner', displayName: 'Local Owner', password: 'must-not-serialize', extra: 'ignored' },
    error: { message: 'Username is already in use.', correlationId: 'req_12345678' }
  });
  assert.deepEqual(model.draft, { username: 'owner', displayName: 'Local Owner' });
  const html = renderSetupScreen('bootstrap', model.copy, model);
  assert.match(html, /value="owner"/);
  assert.match(html, /value="Local Owner"/);
  assert.match(html, /Username is already in use/);
  assert.match(html, /role="alert"/);
  assert.doesNotMatch(JSON.stringify(model), /must-not-serialize/);
  assert.doesNotMatch(html, /value="rebel"|value="Rebel"/);
  assert.doesNotMatch(html, /must-not-serialize/);
  const transition=authFailureTransition({mode:'bootstrap',draft:{username:'owner',displayName:'Owner',password:'must-not-serialize'},error:{code:'already_bootstrapped',message:'Already set up'}});
  assert.deepEqual(transition,{mode:'login',shellKind:'denied',draft:{username:'owner',displayName:''},clearPassword:true,message:'This workspace already has an owner. Sign in instead.'});
  assert.doesNotMatch(JSON.stringify(transition),/must-not-serialize/);
});

test('git change hydration keeps safe bounded locators and reports omitted evidence', () => {
  const normalized = normalizeRecallMapGitChanges({
    status: 'available',
    changedLocators: ['workspace://src/a.js', 'workspace://src/b.js'],
    totalChangedLocatorCount: 5,
    omittedChangedLocatorCount: 2,
    skippedCount: 1,
    truncated: true
  });
  assert.deepEqual(normalized.changedLocators, ['src/a.js', 'src/b.js']);
  assert.equal(normalized.totalCount, 6);
  assert.equal(normalized.omittedCount, 3);
  assert.equal(normalized.truncated, true);
  assert.deepEqual(normalizeRecallMapGitChanges(normalized), normalized);
  assert.deepEqual(normalizeRecallMapGitChanges({ status: 'unavailable' }).changedLocators, []);
  const unavailable=normalizeRecallMapGitChanges({status:'unavailable',reason:'git_status_failed'});
  assert.equal(unavailable.status,'unavailable');
  assert.equal(unavailable.reason,'git_status_failed');
  assert.match(unavailable.message,/Git change detection is unavailable/);
  const failed=normalizeRecallMapGitChanges(null,{code:'forbidden',message:'CSRF validation failed.'});
  assert.deepEqual(failed,{status:'error',changedLocators:[],totalCount:0,omittedCount:0,truncated:false,reason:'forbidden',message:'CSRF validation failed.'});
  const redacted=normalizeRecallMapGitChanges(null,{code:'internal_error',message:'failed at /Users/rebel/private token=secret'});
  assert.equal(redacted.message,'Git change detection failed. Retry the local scan.');
});

test('repository search distinguishes a bounded failure from valid zero results',()=>{
  const error=Object.assign(new Error('The request did not match the API contract.'),{status:400,code:'request_validation_failed',correlationId:'req_12345678'});
  const failed=renderRepositorySearchState({query:'/private/secret',error});
  assert.match(failed,/Repository search failed/);
  assert.match(failed,/request did not match/);
  assert.doesNotMatch(failed,/No bounded source-graph matches/);
  for(const errorCase of [
    {status:429,code:'rate_limited',message:'Too many requests. Retry later.'},
    {status:401,code:'authentication_required',message:'Authentication is required.'},
    {status:500,code:'internal_error',message:'Repository search could not be completed.'}
  ]){
    const rendered=renderRepositorySearchState({query:'launchSmoke',error:errorCase});
    assert.match(rendered,/Repository search failed/);
    assert.match(rendered,new RegExp(errorCase.message.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&')));
    assert.doesNotMatch(rendered,/No bounded source-graph matches/);
  }
  const empty=renderRepositorySearchState({query:'noSuchSymbol',report:{architecture:{search:{total:0,results:[]}}}});
  assert.match(empty,/No bounded source-graph matches/);
});

test('workbench navigation has five desktop and four mobile destinations', () => {
  assert.deepEqual(PRIMARY_NAV.map((item) => item.label), ['Start', 'Explore code', 'Review memory', 'Prepare handoff', 'Settings']);
  assert.deepEqual(PRIMARY_NAV.map((item) => item.path), ['/', '/map', '/memory', '/handoffs', '/settings']);
  assert.deepEqual(MOBILE_NAV.map((item) => item.label), ['Start', 'Explore code', 'Review memory', 'Prepare handoff']);
  assert.equal(navigationItemsFor('rail'), PRIMARY_NAV);
  assert.equal(navigationItemsFor('bottom'), MOBILE_NAV);
});

test('web tokens use the approved restrained workbench system', async () => {
  const css = await readFile(new URL('../apps/web/tokens.css', import.meta.url), 'utf8');
  const shellCss = await readFile(new URL('../apps/web/styles.css', import.meta.url), 'utf8');
  const shared = JSON.parse(await readFile(new URL('../packages/ui/tokens.json', import.meta.url), 'utf8'));
  assert.match(css, /--color-canvas:oklch\(/);
  assert.match(css, /--color-accent:oklch\(/);
  assert.match(css, /--radius-control:6px/);
  assert.match(css, /--radius-panel:8px/);
  assert.match(css, /--font-sans:ui-sans-serif/);
  assert.match(css, /--space-md:24px/);
  assert.doesNotMatch(css, /#56e0c4|gradient|glow/i);
  assert.equal(shared.color.canvas, 'oklch(97.8% 0.006 80)');
  assert.equal(shared.color.accent, 'oklch(50% 0.12 258)');
  assert.equal(shared.color.dark.accent, 'oklch(70% 0.1 258)');
  assert.equal(shared.color.dark.canvas, 'oklch(17% 0.008 255)');
  assert.match(shared.font.sans, /^ui-sans-serif/);
  assert.match(shared.font.mono, /^ui-monospace/);
  assert.equal(shared.spacing.md, 24);
  assert.equal(shared.radius.control, 6);
  assert.equal(shared.radius.panel, 8);
  assert.equal(shared.layout.rail, 216);
  assert.equal(shared.motion.durationFast, 120);
  assert.match(shared.motion.easeOut, /^cubic-bezier\(/);
  assert.doesNotMatch(JSON.stringify(shared), /#56e0c4/i);
  assert.match(shellCss, /@media\(min-width:701px\) and \(max-width:1080px\)\{[\s\S]*\.app-shell\{grid-template-columns:72px minmax\(0,1fr\)\}/);
  assert.match(shellCss, /@media\(min-width:701px\) and \(max-width:1080px\)\{[\s\S]*\.nav-label[^{]*\{[^}]*position:absolute/);
  assert.match(shellCss, /#primary-nav a\{[^}]*min-height:44px/);
  assert.match(shellCss, /\.global-search input\{[^}]*min-height:44px/);
  assert.match(shellCss, /\.button:focus-visible,a:focus-visible,main:focus-visible,input:focus-visible/);
  assert.match(shellCss, /\.button:hover:not\(:disabled\)/);
  assert.match(shellCss, /\.button:active:not\(:disabled\)/);
  assert.match(shellCss, /\.field input,.field select,.field textarea\{[^}]*outline:2px solid transparent[^}]*outline-offset:1px/);
  assert.match(shellCss, /\.field span\{[^}]*font-weight:650[^}]*color:var\(--slate\)\}/);
  assert.doesNotMatch(shellCss, /\.field span\{[^}]*text-transform:uppercase/);
  assert.match(shellCss, /\.field input:disabled,.field select:disabled,.field textarea:disabled\{[^}]*opacity:\.55[^}]*cursor:not-allowed/);
  assert.match(shellCss, /h1\{[^}]*overflow-wrap:anywhere[^}]*min-width:0/);
  assert.match(shellCss, /code,pre\{font-family:var\(--font-mono\)\}/);
  assert.doesNotMatch(shellCss, /\.state-panel\{[^}]*border-left:[2-9]px/);
  assert.match(shellCss, /\.state-stale,\.state-partial\{border-color:var\(--caution\)\}/);
  assert.match(shellCss, /\.overview\{[^}]*max-width:1280px[^}]*margin:0 auto/);
  assert.match(shellCss, /\.overview-grid\{[^}]*grid-template-columns:minmax\(0,1\.2fr\) minmax\(320px,\.8fr\)/);
  assert.match(shellCss, /\.overview-section\{[^}]*border-bottom:1px solid var\(--color-rule\)/);
  assert.match(shellCss, /\.attention-list a\{[^}]*grid-template-columns:max-content minmax\(0,1fr\)[^}]*gap:var\(--space-xs\)/);
  assert.match(shellCss, /\.attention-list a strong,\.attention-list button strong\{white-space:nowrap/);
  assert.match(shellCss, /\.attention-list a span,\.attention-list button span\{white-space:normal;overflow-wrap:anywhere/);
  assert.match(shellCss, /\.attention-list a:hover\{background:var\(--color-panel-muted\)\}/);
  assert.match(shellCss, /\.attention-list a:active\{color:var\(--color-accent\)\}/);
  assert.doesNotMatch(shellCss, /\.bottom-nav a\{[^}]*gap:4px/);
  assert.match(shellCss, /@media\(max-width:900px\)\{\s*\.overview-grid\{grid-template-columns:1fr\}/s);
  assert.doesNotMatch(shellCss, /\.recall-map-signals/);
});

test('mobile shell exposes four fixed destinations without horizontal scrolling', async () => {
  const css = await readFile(new URL('../apps/web/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.bottom-nav\{[^}]*grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/s);
  assert.doesNotMatch(css, /\.bottom-nav\{[^}]*overflow-x:auto/s);
  assert.match(css, /@media\(max-width:700px\)\{\s*\.app-shell\{[^}]*min-height:100dvh[^}]*\}/s);
});

test('secondary routes select the destination that owns them', () => {
  assert.equal(navigationOwner('source-graph'), 'map');
  assert.equal(navigationOwner('memory-graph'), 'memory');
  assert.equal(navigationOwner('context-pack'), 'handoffs');
  assert.equal(navigationOwner('runs'), 'overview');
  assert.equal(navigationOwner('agents'), 'settings');
});

test('Overview primary action is deterministic and state ordered', () => {
  assert.deepEqual(selectOverviewPrimaryAction({ state: 'empty' }), { label: 'Scan repository', route: '/', action: 'refresh-recall-map' });
  assert.deepEqual(selectOverviewPrimaryAction({ state: 'success', memory: { pendingCount: 3 }, handoff: { state: 'ready' } }), { label: 'Review 3 proposals', route: '/memory', routeId: 'memory' });
  assert.deepEqual(selectOverviewPrimaryAction({ state: 'stale', memory: { pendingCount: 0 }, handoff: { state: 'review' } }), { label: 'Update handoff', route: '/handoffs', routeId: 'context-pack' });
  assert.deepEqual(selectOverviewPrimaryAction({ state: 'success', memory: { pendingCount: 0 }, handoff: { state: 'ready' } }), { label: 'View current handoff', route: '/handoffs', routeId: 'context-pack' });
  assert.deepEqual(selectOverviewPrimaryAction({ state: 'partial', memory: { pendingCount: 0 }, handoff: { state: 'blocked' } }), { label: 'Repair handoff', route: '/handoffs', routeId: 'context-pack' });
  assert.equal(selectOverviewPrimaryAction({ state: 'success', memory: { pendingCount: 0 }, handoff: { state: 'pending' } }), null);
});

function replaceGlobal(name,value) {
  const previous=Object.getOwnPropertyDescriptor(globalThis,name);
  Object.defineProperty(globalThis,name,{ configurable:true, writable:true, value });
  return ()=>{
    if(previous)Object.defineProperty(globalThis,name,previous);
    else delete globalThis[name];
  };
}

test('web shell exposes primary aliases and preserves deep links', () => {
  assert.equal(resolveRoute('http://127.0.0.1:4310/map').id, 'source-graph');
  assert.equal(resolveRoute('http://127.0.0.1:4310/handoffs').id, 'context-pack');
  assert.equal(resolveRoute('http://127.0.0.1:4310/source-graph').id, 'source-graph');
  assert.equal(resolveRoute('http://127.0.0.1:4310/context-pack').id, 'context-pack');
  assert.equal(resolveRoute('http://127.0.0.1:4310/runs').id, 'runs');
  assert.equal(resolveRoute('http://127.0.0.1:4310/?view=evidence').id, 'evidence');
  assert.equal(resolveRoute('http://127.0.0.1:4310/not-a-route').id, 'home');
  assert.equal(legacyViewPath('design'), '/settings');
});

test('web shell markup uses a repository bar and no duplicated hero header', async () => {
  const html = await readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8');
  for (const id of ['repository-name', 'repository-branch', 'repository-scan', 'repository-condition']) assert.match(html, new RegExp(`id="${id}"`));
  for (const id of ['repository-menu', 'global-search-form', 'global-search-input']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /Open another repository/);
  assert.match(html, /one local repository per running server/i);
  assert.doesNotMatch(html, /id="page-eyebrow"/);
  assert.doesNotMatch(html, /Developer-first local recall/i);
  assert.doesNotMatch(html, /Next-Agent Handoff/);
});

test('product shell omits prohibited marketing and removed dashboard patterns', async () => {
  const sources = await Promise.all([
    readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8')
  ]);
  const shell = sources.join('\n');
  for (const phrase of ['developer-first', 'nervous system', 'unlock this workspace', 'supercharge', 'AI-powered', 'next-generation']) {
    assert.doesNotMatch(shell, new RegExp(phrase, 'i'));
  }
  for (const retiredCopy of ['Open Agent Fabric', 'project:oaf', 'OAF compressed', 'read OAF resources', 'OAF server only']) {
    assert.doesNotMatch(shell, new RegExp(retiredCopy, 'i'));
  }
  assert.match(shell, /Memory Recall/);
  for (const selector of ['page-eyebrow', 'recall-map-signals', 'nav-code']) {
    assert.doesNotMatch(shell, new RegExp(selector));
  }
});

test('visible web copy is factual and contains no intelligence theater', async () => {
  const files = [
    'apps/web/index.html', 'apps/web/app.js', 'apps/web/orientation-view.js',
    'apps/web/source-map-view.js', 'apps/web/memory-graph-view.js'
  ];
  const source = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');
  for (const phrase of [
    'AI-powered', 'intelligent workspace', 'smart insights', 'magical', 'seamless',
    'unlock', 'supercharge', 'revolutionary', 'next-generation', 'nervous system',
    'mission control', 'command center', 'content intelligence'
  ]) assert.doesNotMatch(source, new RegExp(phrase, 'iu'));
  assert.doesNotMatch(source, /[✨🤖🪄]/u);
});

test('Recall Map home presents a repository-first daily Overview',()=>{
  const report={
    schemaVersion:'1.0.0',
    reportVersion:'memory-recall-map-1.0.0',
    workspaceId:'ws_local',
    generatedAt:'2026-07-11T10:00:00.000Z',
    repository:{
      name:'memory-recall-map-home',
      branch:'main',
      commitSha:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      dirtyCount:1,
      gitStatusAvailable:true,
      reason:null
    },
    support:{
      sourceGraph:{status:'implemented',languages:['javascript','typescript'],coverage:{status:'partial',analyzedFileCount:42,maxFiles:1000,maxFileBytes:262144,diagnosticCount:1,reasonCodes:['static_js_ts_only','bounded_file_scan']}},
      memory:{status:'available'}
    },
    architecture:{
      entryPoints:[{label:'createControlApiServer',qualifiedLabel:'createControlApiServer',locator:'workspace://services/control-api/src/server.mjs#L600-L610',symbolKind:'function'}],
      hotspots:[],
      search:{status:'available',queryFingerprint:'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',total:1,hasMore:false,omittedCount:0,results:[]},
      impact:{changedLocators:['workspace://apps/web/app.js'],representedChangedLocators:['workspace://apps/web/app.js'],affectedSymbols:[{label:'renderHome',qualifiedLabel:'renderHome',locator:'workspace://apps/web/app.js#L1100-L1110',symbolKind:'function'}],affectedEdgeKindCounts:{calls:1},depth:2},
      diagnostics:[{locator:'workspace://apps/web/app.js',code:'static_js_ts_only'}]
    },
    memory:{status:'available',activeFacts:[{id:'memfact_map_home',scope:'workspace',status:'active',sourceLocator:'workspace://docs/overview.md',validFrom:'2026-07-11T09:00:00.000Z',validUntil:null,confidence:0.9}],pendingProposals:[{id:'mpq_map_home',status:'pending',sourceLocator:'workspace://docs/overview.md',attempts:0,maxAttempts:3,enqueuedAt:'2026-07-11T09:10:00.000Z'}],staleFactCount:1,unavailableReason:null},
    readiness:{handoff:{status:'available',command:'recall handoff'},mcp:{status:'available',command:'recall mcp inspect --read-only --root .'},nextCommands:['recall handoff','recall graph stats --root . --format summary']},
    safeguards:{readOnly:true,localFilesWritten:0,canonicalStateMutated:false,networkCalls:0,modelCalls:0,rawSourceBodiesIncluded:false,graphDatabaseUsed:false,externalAdaptersEnabled:0},
    fingerprint:'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  };
  const model=buildRecallMapHomeModel({report,pinnedHandoffStatus:{current:{status:'verified'}}});
  assert.equal(model.state,'success');
  assert.deepEqual(selectOverviewPrimaryAction(model),{label:'Review 1 proposal',route:'/memory',routeId:'memory'});
  assert.equal(model.index.status,'implemented');
  assert.equal(model.coverage.label,'42 / 1000 files');
  assert.equal(model.impact.changedCount,1);
  assert.equal(model.memory.activeCount,1);
  assert.equal(model.memory.pendingCount,1);
  assert.equal(model.handoff.state,'ready');
  const html=renderOverview(model);
  assert.match(html,/data-status="partial">Partial/);
  for (const label of ['Architecture','Start here','Current impact','Trusted context']) assert.match(html,new RegExp(label));
  assert.match(html,/No supported groups/);
  assert.match(html,/memory-recall-map-home/);
  assert.match(html,/workspace:\/\/apps\/web\/app\.js/);
  assert.match(html,/data-route="source-graph"/);
  assert.doesNotMatch(html,/Developer-first/i);
  assert.doesNotMatch(html,/Read the local picture/i);
  assert.doesNotMatch(html,/recall-map-signals/);
  assert.doesNotMatch(html,/<canvas\b/i);
  assert.equal(renderRecallMapHome,renderOverview);

  const staleMemoryOnlyModel=buildRecallMapHomeModel({
    report:{...report,memory:{...report.memory,pendingProposals:[]}}
  });
  assert.equal(staleMemoryOnlyModel.state,'success');
  assert.equal(selectOverviewPrimaryAction(staleMemoryOnlyModel),null);
  assert.match(renderOverview(staleMemoryOnlyModel),/<dt>Memory<\/dt><dd>stale<\/dd>/);

  const staleHandoffModel=buildRecallMapHomeModel({
    report:{...report,memory:{...report.memory,pendingProposals:[],staleFactCount:0}},
    pinnedHandoffStatus:{current:{status:'stale'}}
  });
  assert.equal(staleHandoffModel.state,'stale');
  assert.deepEqual(selectOverviewPrimaryAction(staleHandoffModel),{label:'Update handoff',route:'/handoffs',routeId:'context-pack'});
  assert.match(renderOverview(staleHandoffModel),/<dt>Handoff<\/dt><dd>stale<\/dd>/);

  const blockedHandoffModel=buildRecallMapHomeModel({
    report:{...report,memory:{...report.memory,pendingProposals:[],staleFactCount:0}},
    pinnedHandoffStatus:{
      generatedAt:'2026-07-11T10:00:00.000Z',
      current:{status:'tampered',entryId:'pack_1'},
      entries:[{id:'pack_1',createdAt:'2026-07-11T08:00:00.000Z'}]
    }
  });
  assert.equal(blockedHandoffModel.handoff.state,'blocked');
  assert.deepEqual(selectOverviewPrimaryAction(blockedHandoffModel),{label:'Repair handoff',route:'/handoffs',routeId:'context-pack'});
  assert.match(renderOverview(blockedHandoffModel),/<dt>Handoff<\/dt><dd>tampered<\/dd>/);
  assert.equal(blockedHandoffModel.handoff.ageLabel,'2 hours old');

  const detectedModel=buildRecallMapHomeModel({
    report:{...report,repository:{...report.repository,dirtyCount:6}},
    gitChanges:{status:'available',changedLocators:['workspace://apps/web/app.js'],totalChangedLocatorCount:5,omittedChangedLocatorCount:3,skippedCount:1,truncated:true},
    pinnedHandoffStatus:{current:{status:'verified'}}
  });
  assert.equal(detectedModel.impact.totalChangedCount,6);
  assert.equal(detectedModel.impact.omittedChangedCount,4);
  assert.match(renderOverview(detectedModel),/5 changed files outside the represented graph/);

  const allOmittedModel=buildRecallMapHomeModel({
    report:{...report,repository:{...report.repository,dirtyCount:2},architecture:{...report.architecture,impact:{...report.architecture.impact,changedLocators:[],representedChangedLocators:[],affectedSymbols:[]}}},
    gitChanges:{status:'available',changedLocators:[],skippedCount:2,truncated:true},
    pinnedHandoffStatus:{current:{status:'verified'}}
  });
  assert.equal(allOmittedModel.impact.detectionStatus,'available');
  assert.equal(allOmittedModel.impact.omittedChangedCount,2);
  assert.deepEqual(allOmittedModel.impact.changedLocators,[]);
  const allOmittedHtml=renderOverview(allOmittedModel);
  assert.match(allOmittedHtml,/2 local changes/);
  assert.match(allOmittedHtml,/2 changed files outside the represented graph/);

  const degradedModel=buildRecallMapHomeModel({
    report:{...report,repository:{...report.repository,dirtyCount:3},architecture:{...report.architecture,impact:{...report.architecture.impact,changedLocators:[],representedChangedLocators:[],affectedSymbols:[]}}},
    gitChanges:{status:'unavailable',reason:'git_status_failed'},
    pinnedHandoffStatus:{current:{status:'verified'}}
  });
  assert.equal(degradedModel.impact.detectionStatus,'unavailable');
  assert.equal(degradedModel.impact.repositoryDirtyCount,3);
  const degradedHtml=renderOverview(degradedModel);
  assert.match(degradedHtml,/Local change detection unavailable/);

  assert.equal(shellStateMessageForOverview('stale'),'Pinned handoff source evidence changed and needs review.');

  assert.equal(buildRecallMapHomeModel({report:null,error:null}).state,'loading');
  assert.equal(buildRecallMapHomeModel({report:null,error:'loopback unavailable'}).state,'error');
  assert.equal(buildRecallMapHomeModel({report:{...report,memory:{...report.memory,staleFactCount:0},architecture:{...report.architecture,entryPoints:[],hotspots:[],impact:{...report.architecture.impact,changedLocators:[],representedChangedLocators:[],affectedSymbols:[]}}}}).state,'empty');
  const unavailableSourceModel=buildRecallMapHomeModel({report:{...report,memory:{...report.memory,staleFactCount:0},support:{...report.support,sourceGraph:{...report.support.sourceGraph,status:'unavailable',coverage:{...report.support.sourceGraph.coverage,status:'unavailable'}}}}});
  assert.equal(unavailableSourceModel.state,'partial');
  assert.match(renderOverview(unavailableSourceModel),/data-status="failed">Unavailable/);
});

test('shell defers protected workspace loads until local session evidence exists',()=>{
  assert.equal(shouldLoadProtectedShellData({ bootstrapRequired:true, csrfTokenValue:'csrf_1' }),false);
  assert.equal(shouldLoadProtectedShellData({ bootstrapRequired:false, csrfTokenValue:'' }),false);
  assert.equal(shouldLoadProtectedShellData({ bootstrapRequired:false, csrfTokenValue:'csrf_1' }),true);
});

test('source graph preview renders bounded focus with scan truth',()=>{
  const report={
    graph:{
      graphFingerprint:'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      summary:{
        fileCount:2,
        symbolCount:2,
        nodeCount:6,
        edgeCount:4,
        entryPoints:[{nodeId:'sgnode_entry',label:'runAuthWorkflow',locator:'workspace://src/workflow.ts#L3-L7',symbolKind:'function'}],
        hotspots:[{nodeId:'sgnode_auth',label:'TokenResetService',inbound:2,outbound:1,total:3}]
      },
      sampleNodes:[
        {id:'sgnode_file_workflow',kind:'file',label:'src/workflow.ts',locator:'workspace://src/workflow.ts'},
        {id:'sgnode_file_auth',kind:'file',label:'src/auth.ts',locator:'workspace://src/auth.ts'},
        {id:'sgnode_workflow',kind:'symbol',label:'runAuthWorkflow',locator:'workspace://src/workflow.ts#L3-L7',symbolKind:'function'},
        {id:'sgnode_auth',kind:'symbol',label:'TokenResetService',locator:'workspace://src/auth.ts#L1-L5',symbolKind:'class'}
      ],
      sampleEdges:[
        {kind:'imports',fromNodeId:'sgnode_file_workflow',toNodeId:'sgnode_file_auth'},
        {kind:'calls',fromNodeId:'sgnode_workflow',toNodeId:'sgnode_auth'}
      ]
    },
    orientation:{groups:[{id:'group_src',prefix:'src',fileCount:2,symbolCount:2,changedFileCount:1}],relations:[]},
    focus:{nodes:[
      {id:'sgnode_workflow',kind:'symbol',label:'runAuthWorkflow',locator:'workspace://src/workflow.ts#L3-L7'},
      {id:'sgnode_auth',kind:'symbol',label:'TokenResetService',locator:'workspace://src/auth.ts#L1-L5'}
    ],edges:[{id:'edge_1',kind:'calls',fromNodeId:'sgnode_workflow',toNodeId:'sgnode_auth'}],omittedNodes:0,omittedEdges:0},
    snapshot:{status:'fresh',reuse:'cache',builtAt:'2026-07-15T10:00:00.000Z'},
    coverage:{status:'complete',representedFileCount:2,omittedFileCount:0,omittedEdgeCount:0,reasonCodes:[]},
    search:{total:1,results:[]},
    trace:{paths:[]},
    impact:{
      changedLocators:['workspace://src/auth.ts'],
      representedChangedLocators:['workspace://src/auth.ts'],
      affectedSymbols:[{name:'TokenResetService',locator:'workspace://src/auth.ts#L1-L5',symbolKind:'class'}]
    },
    safeguards:{persisted:false,modelCalls:0,networkCalls:0,graphDatabaseUsed:false,rawBodyIncluded:false}
  };
  const html=renderSourceMap({state:parseMapUrl('/map?query=runAuthWorkflow'),report});
  assert.match(html,/class="tool-workspace source-map-workspace"/);
  assert.match(html,/Focused map/);
  assert.match(html,/runAuthWorkflow/);
  assert.match(html,/workspace:\/\/src\/workflow\.ts#L3-L7/);
  assert.match(html,/workspace:\/\/src\/auth\.ts/);
  assert.match(html,/TokenResetService/);
  assert.match(html,/Source map outline/);
  assert.match(html,/Scan truth/);
  assert.match(html,/2 represented files/);
  assert.match(html,/External writes/);
  assert.match(html,/off/);
  assert.doesNotMatch(html,/class="metric-strip"/);
});

test('memory route renders real temporal fact fields and computed token number', async (t) => {
  assert.equal(deliveryChangeLabel(42),'42% reduction');
  assert.equal(deliveryChangeLabel(0),'No reduction');
  assert.equal(deliveryChangeLabel(-363),'363% overhead');
  assert.equal(deliveryChangeLabel(100,0),'Not measured');
  const provider = new SQLiteMemoryProvider({ filename: ':memory:', clock: () => '2026-06-26T10:00:00.000Z' });
  t.after(() => provider.close());
  await provider.put({
    id: 'mem_web_profile',
    workspaceId: 'ws_local',
    kind: 'decision',
    text: `${Array(80).fill('surface-wire-memory').join(' ')} local token budget profile`,
    source: 'workspace://docs/web-memory.md',
    status: 'active',
    confidence: 0.9,
    authority: 0.9,
    updatedAt: '2026-06-26T09:55:00.000Z'
  });
  const proposal = await provider.enqueueProposal({
    id: 'mpq_web_memory',
    workspaceId: 'ws_local',
    sourceLocator: 'workspace://docs/web-memory.md',
    sourceHash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    payload: { kind: 'fact', subject: 'memory-route', predicate: 'renders', object: 'real-fields' }
  });
  await provider.claimProposal({ workspaceId: 'ws_local', workerId: 'reviewer', leaseUntil: '2026-06-26T10:05:00.000Z' });
  await provider.recordProposalResult({ workspaceId: 'ws_local', id: proposal.id, workerId: 'reviewer', status: 'applied', result: { accepted: true } });
  await provider.addTemporalFact({
    id: 'memfact_web_memory',
    workspaceId: 'ws_local',
    scope: 'workspace',
    subject: 'memory-route',
    predicate: 'renders',
    object: 'real-fields',
    text: 'The memory route renders native SQLite fact fields.',
    source: 'workspace://docs/web-memory.md',
    proposalQueueId: proposal.id,
    validFrom: '2026-06-26T10:00:00.000Z'
  });
  const exported = await provider.export({ workspaceId: 'ws_local' });
  const facts = await provider.listTemporalFacts({ workspaceId: 'ws_local' });
  const proposalQueue = [
    ...(await provider.listProposalQueue({ workspaceId: 'ws_local' })),
    { id: 'mpq_web_pending', status: 'pending', sourceLocator: 'workspace://docs/pending.md', sourceHash: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', attempts: 0, payload: { kind: 'fact', subject: 'memory-route', predicate: 'approves', object: 'pending' } }
  ];
  const profile = buildCompressedProfileContextReport({
    records: [...exported.records, ...facts],
    workspaceId: 'ws_local',
    generatedAt: '2026-06-26T10:00:00.000Z',
    objective: 'Render memory route',
    step: 'Assert token number',
    tokenBudget: 4096
  });
  const cockpit = {
    schemaVersion: '1.0.0',
    workspaceId: 'ws_local',
    generatedAt: '2026-06-26T10:00:00.000Z',
    provider: 'provider:native:memory:sqlite',
    summary: { activeFactCount: 1, pendingProposalCount: 1 },
    facts,
    proposalQueue,
    mcpStats: {
      available: true,
      callCount: 2,
      deliveredTokens: 320,
      baselineTokens: 900,
      tokensSaved: 580,
      tokenSavingPercent: 64,
      providerBillingClaimed: false,
      basis: 'estimated tokens over exact MCP JSON tool payload text',
      byTool: [
        { toolName: 'memory.recall', callCount: 1, deliveredTokens: 120, tokensSaved: 0 },
        { toolName: 'context.profile', callCount: 1, deliveredTokens: 200, tokensSaved: 580 }
      ]
    },
    tokenBudget: profile.contextBudget,
    savings: {
      beforeDeliveryTokens: profile.contextBudget.historyTokensAvailable,
      afterDeliveryTokens: profile.contextBudget.estimatedDeliveryTokens,
      tokensSaved: profile.contextBudget.historyTokensAvoided,
      percent: Math.round(profile.contextBudget.reductionRatio * 100),
      savings: { providerBillingClaimed: false, basis: 'delivery-token-estimate' }
    },
    profile: { id: profile.id },
    safeguards: { readOnly: true },
    reportFingerprint: profile.id.replace(/^ctxprofile_/, 'sha256:').padEnd(71, '0')
  };
  const model = buildMemoryCockpitModel(cockpit);
  const html = renderMemoryCockpit(cockpit);
  const intakeHtml = renderMemoryIntakePanel({
    command:'memory preview',
    summary:{proposalCount:1,activeMemoryCreated:0},
    proposalFacts:[{id:'mpq_preview',status:'preview',sourceLocator:'workspace://memory/inbox.md',subject:'project:oaf',predicate:'release_status',object:'release-candidate'}]
  },null,{sourceLocator:'memory/inbox.md',text:'Fact: project:oaf release_status release-candidate.'});
  assert.equal(model.tokenBudget.estimatedDeliveryTokens, profile.contextBudget.estimatedDeliveryTokens);
  assert.equal(model.savings.beforeDeliveryTokens, profile.contextBudget.historyTokensAvailable);
  assert.equal(model.savings.afterDeliveryTokens, profile.contextBudget.estimatedDeliveryTokens);
  assert.equal(model.savings.providerBillingClaimed, false);
  assert.equal(model.mcpStats.callCount, 2);
  assert.equal(model.mcpStats.deliveredTokens, 320);
  assert.equal(model.summary.activeFactCount, 1);
  assert.equal(model.summary.pendingProposalCount, 1);
  assert.match(html, /class="tool-workspace memory-workspace"/);
  assert.match(html, /<h1>Memory<\/h1>/);
  assert.match(html, /Review queue/);
  assert.match(html, /Active memory/);
  const reviewQueueHtml=html.match(/<section class="memory-review-queue">([\s\S]*?)<\/section><aside/)?.[1]??'';
  assert.match(reviewQueueHtml,/mpq_web_pending/);
  assert.doesNotMatch(reviewQueueHtml,/mpq_web_memory/);
  assert.match(html, new RegExp(deliveryChangeLabel(model.savings.percent)));
  assert.doesNotMatch(html, /token saving/);
  assert.match(html, /<dt>Active facts<\/dt><dd>1<\/dd>/);
  assert.match(html, /<dt>Pending proposals<\/dt><dd>1<\/dd>/);
  assert.match(html, /id="memory-intake-form"/);
  assert.match(html, /Preview proposals/);
  assert.match(html, /Queue proposals/);
  assert.match(html, /data-action="approve-memory-proposal"/);
  assert.match(intakeHtml, /memory preview/);
  assert.match(intakeHtml, /project:oaf release_status/);
  assert.match(intakeHtml, /active memory created/);
  const failedIntakeHtml = renderMemoryIntakePanel(null, {
    message: 'The request did not match the API contract.',
    issues: [{ path: '$.body.text', code: 'memory_extraction_invalid' }]
  });
  assert.match(failedIntakeHtml, /Memory intake failed/);
  assert.match(failedIntakeHtml, /Memory text/);
  assert.match(failedIntakeHtml, /Use simple Fact or Decision lines/);
  const emptyIntakeHtml = renderMemoryIntakePanel({
    command: 'memory preview',
    summary: { proposalCount: 0, activeMemoryCreated: 0 },
    proposalFacts: []
  });
  assert.match(emptyIntakeHtml, /Try: Fact: project:memory-recall release_status release-candidate/);
  assert.match(html, new RegExp(`<dt>Naive baseline</dt><dd>${profile.contextBudget.historyTokensAvailable}</dd>`));
  assert.match(html, new RegExp(`<dt>Memory Recall delivery</dt><dd>${profile.contextBudget.estimatedDeliveryTokens}</dd>`));
  assert.match(html, /<dt>Provider billing<\/dt><dd>not claimed<\/dd>/);
  assert.match(html, /<dt>MCP calls<\/dt><dd>2<\/dd>/);
  assert.match(html, /<dt>MCP delivered<\/dt><dd>320<\/dd>/);
  assert.match(html, /context\.profile/);
  assert.match(html, /memfact_web_memory/);
  assert.match(html, /memory-route/);
  assert.match(html, /Jun 26, 2026/);
  assert.match(html, /mpq_web_memory/);
  assert.match(html, new RegExp(`<dd>${profile.contextBudget.estimatedDeliveryTokens}</dd>`));
});

test('memory route never reports savings when the baseline is absent', () => {
  const html = renderMemoryCockpit({
    workspaceId:'ws_local',
    summary:{activeFactCount:0,pendingProposalCount:0},
    facts:[], proposalQueue:[],
    savings:{beforeDeliveryTokens:0,afterDeliveryTokens:0,tokensSaved:0,percent:100},
    mcpStats:{available:true,callCount:0,deliveredTokens:0,baselineTokens:0,tokensSaved:0,byTool:[]}
  });
  assert.match(html,/Not measured/);
  assert.doesNotMatch(html,/100% reduction/);
});

test('Settings presents real local controls and boundaries instead of design swatches', async () => {
  const app = await readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8');
  const settings = app.match(/function renderSettings\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(settings, /<h1>Settings<\/h1>/);
  assert.match(settings, /Local storage/);
  assert.match(settings, /Scan limits/);
  assert.match(settings, /Privacy/);
  assert.doesNotMatch(settings, /token-grid|class="swatch"|--signal/);
});

test('memory graph route renders governed graph canvas controls', async () => {
  const report = {
    schemaVersion: '1.0.0',
    workspaceId: 'ws_local',
    generatedAt: '2026-06-26T10:00:00.000Z',
    provider: 'provider:native:memory:sqlite',
    mode: 'history',
    communityMethod: 'label-propagation',
    summary: { nodeCount: 3, edgeCount: 2, currentNodeCount: 2, currentEdgeCount: 1, historyNodeCount: 1, historyEdgeCount: 1, communityCount: 2 },
    graph: {
      nodes: [
        { id: 'provider:native:memory:sqlite', entityId: 'ment_provider', name: 'provider:native:memory:sqlite', type: 'provider', kind: 'subject', current: true, governedDecision: false, degree: 2, size: 16, community: 1 },
        { id: 'MemoryBackendPort', entityId: 'ment_port', name: 'MemoryBackendPort', type: 'port', kind: 'object', current: true, governedDecision: false, degree: 1, size: 13, community: 1 },
        { id: 'adr:memory-graph-ui', entityId: 'ment_adr', name: 'adr:memory-graph-ui', type: 'decision', kind: 'subject', current: false, governedDecision: true, degree: 1, size: 13, community: 2 }
      ],
      edges: [
        { id: 'medge_provider_port', from: 'provider:native:memory:sqlite', to: 'MemoryBackendPort', predicate: 'implements_port', factId: 'memfact_provider_port', current: true, status: 'active', validFrom: '2026-06-26T09:00:00.000Z', validUntil: null, supersededBy: null, source: 'workspace://providers/native/memory-sqlite/provider.json' },
        { id: 'medge_adr', from: 'adr:memory-graph-ui', to: 'legacy-view', predicate: 'replaces', factId: 'memfact_adr', current: false, status: 'superseded', validFrom: '2026-06-26T08:00:00.000Z', validUntil: '2026-06-26T09:00:00.000Z', supersededBy: 'memfact_new', source: 'workspace://DECISIONS.md' }
      ]
    },
    focus: null,
    safeguards: { readOnly: true, networkCalls: 0, modelCalls: 0, externalWritesEnabled: false },
    reportFingerprint: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
  };
  const model = buildMemoryGraphViewModel(report, { history: true, query: '', communities: true });
  const html = renderMemoryGraphView(model);
  const source = await readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8');
  assert.equal(model.summary.edgeCount, 2);
  assert.equal(model.nodes.some((node) => node.governedDecision), true);
  assert.match(html, /id="memory-graph-canvas"/);
  assert.match(html, /id="memory-graph-history"/);
  assert.match(html, /id="memory-graph-communities"/);
  assert.match(html, /Group related facts/);
  assert.match(html, /provider:native:memory:sqlite/);
  assert.match(html, /legacy-view/);
  assert.match(html, /Fact history/);
  assert.match(html, /Superseded/);
  assert.match(html, /Provenance/);
  assert.match(html, /Valid from/);
  assert.match(html, /Valid until/);
  assert.match(html, /workspace:\/\/providers\/native\/memory-sqlite\/provider\.json/);
  assert.match(source, /\/api\/memory\/graph/);
});

test('context pack pin uses the reviewed build payload instead of a stale form payload',()=>{
  const reviewed={
    workspaceId:'ws_local',
    targetHarness:'codex',
    from:'codex,cursor',
    objective:'Reviewed objective',
    step:'Reviewed step',
    tokenBudget:2048,
    userSelectedFiles:['docs/usage/local-agent-handoff.md'],
    changedLocators:['apps/web/app.js','services/control-api/src/server.mjs']
  };
  const staleForm={
    workspaceId:'ws_local',
    targetHarness:'codex',
    from:'codex',
    objective:'Default objective after render',
    step:'select useful local handoff context',
    tokenBudget:4096,
    userSelectedFiles:[],
    changedLocators:[]
  };
  const payload=selectContextPackPinPayload({reviewedPayload:reviewed,formPayload:staleForm});
  assert.deepEqual(payload.changedLocators,['apps/web/app.js','services/control-api/src/server.mjs']);
  assert.deepEqual(payload.userSelectedFiles,['docs/usage/local-agent-handoff.md']);
  assert.equal(payload.from,'codex,cursor');
  assert.equal(payload.objective,'Reviewed objective');
  const fallback=selectContextPackPinPayload({formPayload:staleForm});
  assert.deepEqual(fallback.changedLocators,[]);
  assert.equal(fallback.objective,'Default objective after render');
});

test('context pack user flow exposes artifact actions and safe harness commands',async()=>{
  assert.deepEqual(parseSelectedFiles('docs/handoff.md\n docs/handoff.md,notes/context.md '),['docs/handoff.md','notes/context.md']);
  const app=await readFile('apps/web/app.js','utf8');
  const sourceMap=await readFile('apps/web/source-map-view.js','utf8');
  assert.match(app,/Build context pack/);
  assert.match(app,/data-action="copy-pack"/);
  assert.match(app,/data-action="copy-launch-prompt"/);
  assert.match(app,/data-action="receive-pinned-handoff"/);
  assert.match(app,/data-action="copy-receiver-packet"/);
  assert.match(app,/data-action="copy-command"/);
  assert.match(app,/function copyCommand/);
  assert.match(app,/async function submitMemoryIntake/);
  assert.match(app,/api\('\/api\/memory\/proposals'/);
  assert.match(app,/async function writeClipboardText/);
  assert.match(app,/Export plan explicitly/);
  assert.match(app,/Current handoff status/);
  assert.match(app,/Test local handoff/);
  assert.match(app,/context handoff --read-only/);
  assert.match(app,/\/api\/context\/pack\/receive\?workspaceId=/);
  assert.match(app,/Receiver packet ready/);
  assert.match(app,/Review blockers/);
  assert.match(app,/Copy receiver packet/);
  assert.match(app,/Packet parts/);
  assert.match(app,/Part schemas/);
  assert.match(app,/item\.contentType/);
  assert.match(app,/item\.schemaVersion/);
  assert.match(app,/packet\.messageParts/);
  assert.match(app,/reviewedPayload:contextPackReviewedPayload/);
  assert.match(app,/selectContextPackPinPayload\(\{reviewedPayload:contextPackResult\?\.reviewedPayload/);
  assert.match(app,/data-action="download-pack"/);
  assert.match(app,/data-action="detect-git-changes"/);
  assert.match(app,/data-action="preview-context-sources"/);
  assert.match(app,/api\('\/api\/context\/git-changes'/);
  assert.match(app,/api\('\/api\/context\/source-preview'/);
  assert.match(app,/Preview sources/);
  assert.match(app,/class="tool-workspace handoff-workspace"/);
  assert.match(app,/<h1>Handoffs<\/h1>/);
  assert.match(app,/Current handoff/);
  assert.doesNotMatch(app,/Prepare this repository for the next coding agent/);
  assert.match(app,/Build handoff/);
  assert.match(app,/Detect current git changes/);
  assert.match(app,/Review before building/);
  assert.match(app,/name="changedLocators"/);
  assert.doesNotMatch(app,/name="changedLocators"[^>]*>apps\/web\/app\.js<\/textarea>/);
  assert.match(app,/name="sourceFamilies"/);
  assert.match(app,/name="memorySourceFiles"/);
  assert.match(app,/Memory preflight sources \(optional\)/);
  assert.match(app,/The browser keeps paths as config and can run read-only local preflight after the pack is built/);
  assert.match(app,/data-action="copy-memory-config"/);
  assert.match(app,/data-action="download-memory-config"/);
  assert.match(app,/data-action="run-memory-preflight"/);
  assert.match(app,/async function runContextPackMemoryPreflight/);
  assert.match(app,/api\('\/api\/context\/pack\/memory-preflight'/);
  assert.match(app,/function contextPackMemoryConfigPanel/);
  assert.match(app,/async function copyContextPackMemoryConfig/);
  assert.match(app,/function downloadContextPackMemoryConfig/);
  assert.match(app,/oaf\.memory\.json/);
  assert.match(app,/Memory preflight/);
  assert.match(app,/Preflight ran locally in dry-run mode/);
  assert.match(app,/\['codex','Codex'\]/);
  assert.match(app,/\['claude-code','Claude Code'\]/);
  assert.match(app,/\['cursor','Cursor'\]/);
  assert.match(app,/contextPackSourceFamilyControls\(formDraft\.sourceFamilies\)/);
  assert.match(app,/selected\.has\(id\)/);
  assert.equal(app.includes('name="sourceFamilies" value="all"'),false);
  assert.equal(app.includes('name="sourceFamilies" value="generic"'),false);
  assert.match(app,/from:sourceFamilies\.join\(','\)/);
  assert.match(app,/data-action="preview-pack-setup"/);
  assert.match(app,/data-action="download-use-plan"/);
  assert.match(app,/Impact brief/);
  assert.match(app,/Copy impact command/);
  assert.match(app,/measure context-pack --read-only/);
  assert.match(app,/Read-only impact brief/);
  assert.match(app,/Change Impact/);
  assert.match(sourceMap,/value="\$\{escapeHtml\(state\.query\)\}"/);
  assert.match(sourceMap,/name="startName" value="\$\{escapeHtml\(state\.startName\)\}"/);
  assert.match(sourceMap,/name="changedLocator" value="\$\{escapeHtml\(state\.changedLocator\)\}"/);
  assert.doesNotMatch(sourceMap,/where should I start/iu);
  assert.doesNotMatch(sourceMap,/name="changedLocator" value="apps\/web\/app\.js"/);
  assert.match(app,/Intake review/);
  assert.match(app,/Context pack proof metrics/);
  assert.match(app,/Pinned handoff status/);
  assert.match(app,/Check pinned handoff/);
  assert.match(app,/\/api\/context\/pack\/registry\/status\?workspaceId=/);
  assert.match(app,/This panel reads the local registry status only/);
  assert.match(app,/Handoff operator brief/);
  assert.match(app,/Practical handoff/);
  assert.match(app,/Use this in another local agent session/);
  assert.match(app,/Copy the locator pack first/);
  assert.match(app,/Give the agent context/);
  assert.match(app,/Add memory only by choice/);
  assert.match(app,/Pin durable artifacts/);
  assert.match(app,/Connect MCP manually/);
  assert.match(app,/explicit local pin only/);
  assert.match(app,/only the Pin locally action writes fixed context-packs artifacts/);
  assert.match(app,/data-action="pin-context-pack"/);
  assert.match(app,/async function pinCurrentContextPack/);
  assert.match(app,/api\('\/api\/context\/pack\/pin'/);
  assert.match(app,/Pinned locally/);
  assert.match(app,/Written artifacts/);
  assert.match(app,/Repository/);
  assert.match(app,/Use this pack/);
  assert.match(app,/Test handoff summary/);
  assert.match(app,/artifactHeading=readiness\.ready\?'Handoff ready':'Handoff needs review'/);
  assert.match(app,/Changed files, reads, and proof commands are ready/);
  assert.match(app,/Review changed files, reads, and proof commands before handoff/);
  assert.match(app,/Raw source bodies, markdown bodies, local paths, model calls, network calls, and adapters stay out of this brief/);
  assert.match(app,/Pin locally is the only browser-triggered write here, and it writes fixed context-packs artifacts before Receive pinned pack reads them/);
  assert.match(app,/Pin and receive/);
  assert.match(app,/setupPreviewed/);
  assert.match(app,/Setup preview already passed for this browser session/);
  assert.match(app,/\['Test local handoff','Test handoff summary','Pin locally','Receive pinned pack','Receive summary','Copy impact command'\]/);
  assert.match(app,/context receive --read-only --root \. --target/);
  assert.match(app,/Utility read plan/);
  assert.match(app,/Hash verified/);
  assert.match(app,/Observed build time/);
  assert.match(app,/Raw bodies/);
  assert.match(app,/Estimate vs candidate source tokens/);
  assert.match(app,/Browser request time/);
  assert.match(app,/Observed around local API call/);
  assert.match(app,/Readback proof/);
  assert.match(app,/MCP summary read/);
  assert.match(app,/mcp resources --read-only --uri oaf:\/\/workspace\/ws_local\/handoff\/latest/);
  const contextPackPayloadSource=app.slice(app.indexOf('function contextPackPayloadFromForm'),app.indexOf('async function submitContextPack'));
  assert.match(contextPackPayloadSource,/memoryConfig=buildMemoryWorkspaceConfig\(data\.get\('memorySourceFiles'\)\)/);
  assert.match(contextPackPayloadSource,/payload:\{workspaceId:workspaceId\(\),targetHarness,from:sourceFamilies\.join\(','\),objective,step,tokenBudget,userSelectedFiles,changedLocators\}/);
  const submitContextPackSource=app.slice(app.indexOf('async function submitContextPack'),app.indexOf('async function runContextPackMemoryPreflight'));
  assert.match(submitContextPackSource,/const \{payload,memoryConfig\}=contextPackPayloadFromForm\(form\)/);
  assert.match(submitContextPackSource,/contextPackReviewedPayload=selectContextPackPinPayload\(\{formPayload:payload\}\)/);
  assert.match(submitContextPackSource,/api\('\/api\/context\/pack'/);
  assert.doesNotMatch(submitContextPackSource,/body:JSON\.stringify\(\{[^}]*memoryConfig/s);
  assert.doesNotMatch(submitContextPackSource,/body:JSON\.stringify\(\{[^}]*memorySourceFiles/s);
  assert.doesNotMatch(submitContextPackSource,/body:JSON\.stringify\(\{[^}]*(?:checklist|preflight|externalAdaptersEnabled|setupPreview)/s);
  const pinContextPackSource=app.slice(app.indexOf('async function pinCurrentContextPack'),app.indexOf('async function submitSourceGraph'));
  assert.match(pinContextPackSource,/formSnapshot=contextPackPayloadFromForm\(form\)/);
  assert.match(pinContextPackSource,/reviewedPayload:contextPackResult\?\.reviewedPayload \?\? contextPackReviewedPayload/);
  assert.doesNotMatch(pinContextPackSource,/const \{payload,memoryConfig\}=contextPackPayloadFromForm\(form\)/);
  assert.match(pinContextPackSource,/api\('\/api\/context\/pack\/pin'/);
  assert.deepEqual(normalizeMemorySourceFiles('notes/memory.md\nnotes/memory.md\n../secret.md\n/private/path.txt\nnode_modules/pkg.md\nhttps://bad.example/memory'),['notes/memory.md']);
  const model=buildContextPackUiModel({
    createdAt:'2026-06-24T00:00:00.000Z',
    targetHarness:'codex',
    sourceHarnesses:['codex','cursor'],
    objective:"Ship user's change safely",
    step:'select useful context',
    readFirst:[{locator:'workspace://AGENTS.md'}],
    excluded:[{locator:'workspace://.cursor/rules/fabric.mdc'}],
    omissions:{excludedCount:2,excludedTokenCount:500,sourceGraphOmittedCount:1},
    memoryPlan:{activeMemoryCreated:0,proposedCount:1,quarantinedCount:1,items:[{action:'would_propose'},{action:'would_quarantine'}]},
    preview:{candidateTokenCount:1000,selectedTokenCount:250},
    delivery:{representation:'locator-handoff',sourceCandidateTokenCount:1000,sourceSelectedTokenCount:250,sourceSelectedTokenRatio:0.25,deliveredTokenCount:80,deliveredByteSize:320,deliveredTokenRatio:0.08,observedTokenReductionRatio:0.92,sourceContentTokenCountIncluded:0,sourceContentsIncluded:false},
    sourceGraph:{impact:{changedLocators:['workspace://apps/web/app.js'],representedChangedLocators:['workspace://apps/web/app.js'],affectedSymbolCount:3,omittedAffectedSymbolCount:1,affectedSymbols:[{name:'renderContextPackResult',locator:'workspace://apps/web/app.js#L1-L3',symbolKind:'function'}]}},
    utility:{
      status:'ready',
      requiredLocalReads:[
        {locator:'workspace://AGENTS.md',role:'selected_context',required:true,represented:true,contentHash:'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',reasonCodes:['selected_context'],readHint:'Read workspace://AGENTS.md'},
        {locator:'workspace://apps/web/app.js',role:'changed_locator',required:true,represented:true,contentHash:null,reasonCodes:['changed_locator_supplied'],readHint:'Read workspace://apps/web/app.js'}
      ],
      changedLocatorCoverage:{total:1,covered:1,ratio:1,status:'covered'},
      graphHintCoverage:{total:2,covered:1,ratio:0.5,status:'partial'},
      sourceSelection:{candidateTokenCount:1000,selectedTokenCount:250,selectedTokenRatio:0.25,estimatedReductionRatio:0.75},
      changedSourceBudget:{locatorCount:1,measuredLocatorCount:1,contentByteCount:3200,contentTokenCount:800,contentTokenCountIncluded:0,observedAvoidanceRatio:1,sourceContentIncluded:false},
      delivery:{representation:'locator-handoff',sourceContentsIncluded:false}
    },
    handoff:{
      launchPrompt:'Continue this local repository work in codex.\nChanged-file coverage: 1/1',
      commands:[
        "npm run doctor",
        "npm run oaf -- context pack --from 'codex,cursor' --root . --objective 'Ship user'\"'\"'s change safely' --step 'select useful context' --target codex --changed 'apps/web/app.js' --dry-run --format markdown",
        "npm run oaf -- context pack --from 'codex,cursor' --root . --objective 'Ship user'\"'\"'s change safely' --step 'select useful context' --target codex --changed 'apps/web/app.js' --write --pin --out context-packs/CONTEXT_PACK.md --format json",
        "npm run oaf -- context registry status --read-only --format json",
        "npm --silent run oaf -- mcp resources --read-only --stdio",
        "npm run oaf -- mcp resources --read-only --uri oaf://workspace/ws_local/context-pack/registry/current --format json",
        "npm run oaf -- mcp resources --read-only --uri oaf://workspace/ws_local/context-pack/use-plan/current --format json",
        "npm run oaf -- harness setup plan --client codex --server oaf --dry-run --format json",
        "npm run oaf -- mcp resources --read-only --context-pack-use context-packs/CONTEXT_PACK.use.json --uri oaf://workspace/ws_local/context-pack/use-plan/current --format json",
        "npm run oaf -- mcp resources --read-only --context-pack-registry --uri oaf://workspace/ws_local/context-pack/registry/current --format json",
        "npm run oaf -- mcp resources --read-only --context-pack --from 'codex,cursor' --root . --objective 'Ship user'\"'\"'s change safely' --step 'select useful context' --target codex --changed 'apps/web/app.js' --uri oaf://workspace/ws_local/context-pack/current --format json",
        "npm run ci"
      ]
    },
    safeguards:{modelCalls:0,networkCalls:0,activeMemoryCreated:0,externalWritesEnabled:false,rawBodyIncluded:false},
    warnings:['dry_run_no_import'],
    contextPackFingerprint:'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  },'# Context Pack',{
    observedDurationMs:34.4,
    memoryConfig:buildMemoryWorkspaceConfig('notes/memory.md\n/private/path.txt\n../bad.md\nhttps://bad.example/private\nnode_modules/pkg.md'),
    readback:{
      transport:'in-process',
      measurementScope:'single local in-process bridge read',
      bridge:{toolsExposed:0},
      measurements:{durationMs:3,resourceByteSize:640},
      checks:{contextPackFingerprintMatches:true}
    }
  });
  assert.equal(model.selectedLocators,1);
  assert.equal(model.omittedRefs,2);
  assert.equal(model.excludedTokens,500);
  assert.equal(model.sourceGraphOmittedCount,1);
  assert.equal(model.selectedTokenRatio,'25%');
  assert.equal(model.deliveredTokens,80);
  assert.equal(model.deliveredTokenRatio,'8%');
  assert.equal(model.deliveryReductionPercent,'92%');
  assert.deepEqual(model.tokenSaver,{
    beforeTokens:1000,
    afterTokens:80,
    hasMeasuredBaseline:true,
    savedLabel:'92%',
    changedSourceAvoidedLabel:'800 tokens (100%)',
    selectedFiles:['workspace://AGENTS.md'],
    requiredReadFiles:['workspace://AGENTS.md','workspace://apps/web/app.js'],
    excludedFiles:['workspace://.cursor/rules/fabric.mdc'],
    command:"recall measure context-pack --read-only --root . --from 'codex,cursor' --objective 'Ship user'\"'\"'s change safely' --step 'select useful context' --target codex --changed 'apps/web/app.js' --format json"
  });
  const tokenSaverHtml=renderContextPackTokenSaverSummary(model);
  assert.match(tokenSaverHtml,/Token Saver/);
  assert.match(tokenSaverHtml,/1000 -&gt; 80 tokens/);
  assert.match(tokenSaverHtml,/Required reads/);
  assert.match(tokenSaverHtml,/workspace:\/\/AGENTS\.md/);
  assert.match(tokenSaverHtml,/workspace:\/\/apps\/web\/app\.js/);
  assert.match(tokenSaverHtml,/workspace:\/\/\.cursor\/rules\/fabric\.mdc/);
  assert.match(tokenSaverHtml,/Measure token saver/);
  assert.match(tokenSaverHtml,/measure context-pack --read-only/);
  assert.match(tokenSaverHtml,/Provider billing/);
  assert.match(tokenSaverHtml,/not claimed/);
  const unmeasuredTokenSaverHtml=renderContextPackTokenSaverSummary({
    ...model,
    omittedRefs:0,
    tokenSaver:{
      ...model.tokenSaver,
      beforeTokens:0,
      afterTokens:1185,
      hasMeasuredBaseline:false,
      savedLabel:'not measured',
      changedSourceAvoidedLabel:'1649 tokens (100%)'
    }
  });
  assert.match(unmeasuredTokenSaverHtml,/1185 token handoff/);
  assert.match(unmeasuredTokenSaverHtml,/1649 tokens \(100%\) changed source avoided/);
  assert.match(unmeasuredTokenSaverHtml,/Baseline/);
  assert.match(unmeasuredTokenSaverHtml,/Provider billing/);
  assert.match(unmeasuredTokenSaverHtml,/not claimed/);
  assert.doesNotMatch(unmeasuredTokenSaverHtml,/0 -&gt; 1185 tokens/);
  assert.deepEqual(model.proof,{
    tokenSaved:'92%',
    selectedTokenRatio:'25%',
    changedSourceAvoidedLabel:'800 tokens (100%)',
    deliveredTokens:'80',
    observedDurationLabel:'34 ms',
    readbackDurationLabel:'3 ms',
    readbackResourceBytesLabel:'640 bytes',
    readbackFingerprintLabel:'match',
    readbackScope:'single local in-process bridge read',
    readbackTransport:'in-process',
    readbackToolsLabel:'0',
    rawBodiesLabel:'excluded',
    modelCallsLabel:'0',
    networkCallsLabel:'0',
    externalWritesLabel:'disabled',
    activeMemoryLabel:'0'
  });
  const unsafeModel=buildContextPackUiModel({
    targetHarness:'codex',
    sourceHarnesses:['codex'],
    objective:'unsafe fixture',
    step:'check safeguards',
    readFirst:[],
    excluded:[],
    omissions:{excludedCount:0,excludedTokenCount:0,sourceGraphOmittedCount:0},
    memoryPlan:{items:[]},
    preview:{candidateTokenCount:10,selectedTokenCount:5},
    delivery:{deliveredTokenCount:4,sourceContentsIncluded:true},
    sourceGraph:{impact:{changedLocators:[],representedChangedLocators:[],affectedSymbolCount:0,affectedSymbols:[]}},
    safeguards:{externalWritesEnabled:true,rawBodyIncluded:true},
    contextPackFingerprint:'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  });
  assert.equal(unsafeModel.proof.rawBodiesLabel,'check');
  assert.equal(unsafeModel.proof.externalWritesLabel,'enabled');
  assert.equal(unsafeModel.proof.modelCallsLabel,'check');
  assert.equal(unsafeModel.proof.networkCallsLabel,'check');
  assert.equal(model.changedLocators,1);
  assert.equal(model.affectedSymbols,3);
  assert.equal(model.impactBrief.status,'ready');
  assert.equal(model.impactBrief.changedCoverageLabel,'1/1');
  assert.equal(model.impactBrief.changedCoveragePercent,'100%');
  assert.equal(model.impactBrief.affectedSymbolCount,3);
  assert.equal(model.impactBrief.omittedAffectedSymbolCount,1);
  assert.equal(model.impactBrief.requiredReadCount,2);
  assert.equal(model.impactBrief.changedHashVerifiedCount,0);
  assert.equal(model.impactBrief.estimatedReductionRatio,'75%');
  assert.equal(model.impactBrief.topReads.length,2);
  assert.equal(model.impactBrief.affectedSymbols[0].name,'renderContextPackResult');
  assert.match(model.impactBrief.safeguards,/no writes/);
  assert.equal(model.setupClient,'codex');
  assert.equal(model.launchPrompt.includes('Changed-file coverage: 1/1'),true);
  assert.deepEqual(model.utility.topReads.map((item)=>item.locator),['workspace://AGENTS.md','workspace://apps/web/app.js']);
  assert.equal(model.utility.changedCoverageLabel,'1/1');
  assert.equal(model.utility.changedHashVerifiedLabel,'0/1');
  assert.equal(model.utility.changedSourceBudgetLabel,'1/1 files, 800 tokens');
  assert.equal(model.utility.topReads[1].contentHash,'');
  assert.equal(model.utility.sourceReduction,'75%');
  assert.deepEqual(model.sourceFamilies,['codex','cursor']);
  assert.equal(model.sourceFamilyLabel,'codex, cursor');
  assert.deepEqual(model.intakeReview,{acceptedCount:1,excludedCount:1,omittedCount:2,proposedCount:1,quarantinedCount:1,activeMemoryCreated:0});
  assert.equal(model.estimatedReductionPercent,75);
  assert.equal(model.downloadName,'open-agent-fabric-context-pack-codex-2026-06-24.md');
  assert.equal(model.usePlanDownloadName,'open-agent-fabric-context-pack-use-plan-codex-2026-06-24.json');
  assert.equal(model.usePlanReadCount,2);
  assert.equal(model.memoryConfig.configured,true);
  assert.equal(model.memoryConfig.pathCount,1);
  assert.equal(model.memoryConfig.downloadName,'oaf.memory.json');
  assert.match(model.memoryConfig.commandFlag,/--memory-config oaf\.memory\.json/);
  assert.match(model.memoryConfig.json,/"path": "notes\/memory\.md"/);
  assert.doesNotMatch(model.memoryConfig.json,/private|secret|https?:|node_modules|\.\./);
  const noBaselineModel=buildContextPackUiModel({
    targetHarness:'codex',
    sourceHarnesses:['codex'],
    readFirst:[],
    excluded:[],
    omissions:{excludedCount:0,excludedTokenCount:0,sourceGraphOmittedCount:0},
    memoryPlan:{items:[]},
    preview:{candidateTokenCount:0,selectedTokenCount:0},
    delivery:{deliveredTokenCount:0,sourceContentsIncluded:false},
    sourceGraph:{impact:{changedLocators:[],representedChangedLocators:[],affectedSymbolCount:0,affectedSymbols:[]}},
    safeguards:{modelCalls:0,networkCalls:0,activeMemoryCreated:0,externalWritesEnabled:false,rawBodyIncluded:false},
    contextPackFingerprint:'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
  });
  assert.equal(noBaselineModel.selectedTokenRatio,'not measured');
  assert.equal(noBaselineModel.deliveredTokenRatio,'not measured');
  assert.equal(noBaselineModel.deliveryReductionPercent,'not measured');
  assert.equal(noBaselineModel.proof.tokenSaved,'not measured');
  assert.equal(noBaselineModel.memoryConfig.configured,false);
  assert.equal(noBaselineModel.memoryConfig.pathCount,0);
  assert.doesNotMatch(noBaselineModel.commands.find((item)=>item.label==='Test local handoff')?.command ?? '',/--memory-config/);
  assert.match(model.commands[1].command,/--from 'codex,cursor'/);
  assert.match(model.commands[1].command,/--target codex --changed 'apps\/web\/app\.js' --dry-run --format markdown/);
  assert.doesNotMatch(model.commands[1].command,/--from all/);
  assert.match(model.commands[1].command,/Ship user'"'"'s change safely/);
  assert.match(model.commands[2].command,/--write --pin --out context-packs\/CONTEXT_PACK\.md --format json/);
  assert.equal(model.commands[2].label,'Pin locally');
  const pinIndex=model.commands.findIndex((item)=>item.label==='Pin locally');
  const verifyIndex=model.commands.findIndex((item)=>item.label==='Verify pin');
  const receiveIndex=model.commands.findIndex((item)=>item.label==='Receive pinned pack');
  const summaryIndex=model.commands.findIndex((item)=>item.label==='Receive summary');
  assert(pinIndex >= 0);
  assert.equal(verifyIndex,pinIndex+1);
  assert.equal(receiveIndex,verifyIndex+1);
  assert.equal(summaryIndex,receiveIndex+1);
  assert.match(model.commands[verifyIndex].command,/context registry status --read-only --format json/);
  const receiveCommand=model.commands[receiveIndex].command;
  assert.equal(receiveCommand,'recall context receive --read-only --root . --target codex --format json');
  assert.doesNotMatch(receiveCommand,/--objective|--step|--write|--pin|--out|--home|--config|--stdio/);
  const summaryCommand=model.commands[summaryIndex].command;
  assert.equal(summaryCommand,'recall context receive --read-only --root . --target codex --format summary');
  assert.doesNotMatch(summaryCommand,/--objective|--step|--write|--pin|--out|--home|--config|--stdio/);
  assert.equal(model.commands.some((item)=>item.command==='recall mcp resources --read-only --stdio'),true);
  const preflightCommand=model.commands.find((item)=>item.label==='Test local handoff')?.command ?? '';
  assert.match(preflightCommand,/^recall context handoff --read-only /);
  assert.match(preflightCommand,/--from 'codex,cursor'/);
  assert.match(preflightCommand,/--target codex --changed 'apps\/web\/app\.js' --memory-config oaf\.memory\.json --format json/);
  assert.doesNotMatch(preflightCommand,/--write|--pin|--out|install/);
  const preflightSummaryCommand=model.commands.find((item)=>item.label==='Test handoff summary')?.command ?? '';
  assert.match(preflightSummaryCommand,/^recall context handoff --read-only /);
  assert.match(preflightSummaryCommand,/--from 'codex,cursor'/);
  assert.match(preflightSummaryCommand,/--target codex --changed 'apps\/web\/app\.js' --memory-config oaf\.memory\.json --format summary/);
  assert.doesNotMatch(preflightSummaryCommand,/--write|--pin|--out|install/);
  const impactCommand=model.commands.find((item)=>item.label==='Copy impact command')?.command ?? '';
  assert.match(impactCommand,/^recall measure context-pack --read-only /);
  assert.match(impactCommand,/--from 'codex,cursor'/);
  assert.match(impactCommand,/--target codex --changed 'apps\/web\/app\.js' --format json/);
  assert.doesNotMatch(impactCommand,/--write|--pin|--out|install/);
  assert.equal(model.commands.some((item)=>item.command==='recall mcp resources --read-only --uri oaf://workspace/ws_local/context-pack/registry/current --format json'),true);
  assert.equal(model.commands.some((item)=>item.command==='recall mcp resources --read-only --uri oaf://workspace/ws_local/context-pack/use-plan/current --format json'),true);
  assert.equal(model.commands.some((item)=>/harness setup plan --client codex --server oaf --dry-run --format json/.test(item.command)),true);
  assert.equal(model.commands.some((item)=>item.command.includes('mcp resources --read-only')),true);
  assert.equal(model.commands.some((item)=>item.command.includes('context-pack/registry/current')),true);
  assert.equal(model.commands.some((item)=>item.command.includes('context-pack/use-plan/current')),true);
  const sourcePreviewModel=buildContextSourcePreviewUiModel({
    id:'hctxprev_aaaaaaaaaaaaaaaa',
    previewFingerprint:'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    scan:{
      summary:{totalAccepted:2,totalSkipped:1,externalAdaptersEnabled:0,externalWritesEnabled:false},
      sources:[
        {id:'hsrc_1',locator:'workspace://AGENTS.md',harness:'codex',sourceKind:'instruction',redactions:{secretCount:1,localPathCount:0}},
        {id:'hsrc_2',locator:'workspace://.cursor/rules/project.mdc',harness:'cursor',sourceKind:'rule',redactions:{secretCount:0,localPathCount:1}}
      ],
      skipped:[{locator:'workspace://.cursor/rules/private.mdc',reason:'symlink_escape'}]
    },
    manifest:{
      selected:[{sourceId:'hsrc_1',tokens:40}],
      excluded:[{sourceId:'hsrc_2',tokens:20}]
    },
    memoryPlan:{proposedCount:1,quarantinedCount:1,activeMemoryCreated:0},
    metrics:{candidateTokenCount:60,selectedTokenCount:40,selectedTokenRatio:0.666667},
    safeguards:{externalWritesEnabled:false,rawBodyIncluded:false,modelCalls:0,networkCalls:0,sourceSnapshotsWritten:0}
  });
  assert.equal(sourcePreviewModel.acceptedCount,2);
  assert.equal(sourcePreviewModel.skippedCount,1);
  assert.equal(sourcePreviewModel.selectedCount,1);
  assert.equal(sourcePreviewModel.selectedTokenRatio,'67%');
  assert.equal(sourcePreviewModel.sources[0].status,'selected');
  assert.equal(sourcePreviewModel.sources[1].status,'excluded');
  assert.equal(sourcePreviewModel.sources[1].redactions,1);
  assert.equal(sourcePreviewModel.rawBodiesLabel,'excluded');
  assert.equal(sourcePreviewModel.externalWritesLabel,'disabled');
  assert.equal(sourcePreviewModel.activeMemoryCreated,0);
});

test('loop workbench model exposes plan run observation verification budget and stop reasons',async()=>{
  const report={
    schemaVersion:'1.0.0',
    workspaceId:'ws_local',
    generatedAt:'2026-06-26T00:00:00.000Z',
    plan:{status:'reference',command:'loop plan',maxIterations:4,timeoutSeconds:1200,sideEffectClass:'read-only'},
    runs:{status:'blocked',count:2,latestRunId:'run_loop',controller:'bounded maxIterations and timeout'},
    observations:{status:'recorded',count:1,rawOutputIncluded:false},
    verification:{status:'reported',count:1,autoMerge:false},
    tokenBudget:{basis:'contextBudget estimate',estimatedDeliveryTokens:10,aggregatedEstimatedDeliveryTokens:20,providerBillingClaimed:false},
    memoryLoop:{
      objective:'Use native memory to complete a local feedback loop',
      compressedProfile:{
        id:'ctxprofile_loop',
        contextBudget:{basis:'compressed-profile-measurement',estimatedDeliveryTokens:123,profileTokens:44,retrievedContextTokens:0,historyTokensAvailable:600,historyTokensAvoided:477,reductionRatio:0.795,measured:true},
        acceptedHistoryRecordCount:2,
        skippedHistoryRecordCount:0
      },
      loopPlan:{id:'loopplan_native_memory',maxIterations:3,timeoutMs:1800000,validationCommands:['node --test tests/native-memory-profile-context.test.mjs'],contextBudget:{basis:'context-pack-measurement',estimatedDeliveryTokens:123,sourceBodyTokensExcluded:477,deliveryReductionRatio:0.795},sideEffectClass:'read-only'},
      observation:{status:'recorded',command:'node --test tests/native-memory-profile-context.test.mjs',rawOutputIncluded:false},
      extractionProposal:{id:'mpq_loop_web',status:'applied',sourceLocator:'workspace://docs/surface.md',text:'surface-wire visible loop-workbench'},
      memoryFact:{id:'memfact_loop_web',text:'Loop Workbench renders native memory-loop fact fields.',status:'active',validity:{validFrom:'2026-06-26T10:00:00.000Z',validUntil:null},supersededBy:null,proposalQueueId:'mpq_loop_web',episodeId:'mep_loop_web'},
      safeguards:{readOnlyView:true,networkCalls:0,modelCalls:0,externalWritesEnabled:false}
    },
    stopReasons:['completed','validation_failed','blocked_needs_human','max_iterations','timeout','unrelated_changes'],
    trace:{eventCount:3,eventTypes:['loop.run_started','loop.verification_reported','loop.run_stopped']},
    safeguards:{readOnlyViews:true,planCreationViaControlApi:true,externalWritesEnabled:false,networkCalls:0,modelCalls:0,autoMerge:false}
  };
  const model=buildLoopWorkbenchModel(report,{dashboard:{metrics:{runs:5,pendingApprovals:1}}});
  assert.equal(model.plan.maxIterations,4);
  assert.equal(model.runs.count,2);
  assert.equal(model.observations.rawOutputIncluded,false);
  assert.equal(model.verification.autoMerge,false);
  assert.equal(model.tokenBudget.aggregatedEstimatedDeliveryTokens,20);
  assert.equal(model.memoryLoop.loopPlan.contextBudget.estimatedDeliveryTokens,123);
  const flowHtml=renderLoopWorkbenchMemoryFlow(model.memoryLoop);
  assert.match(flowHtml,/80% token saving into loop plan/);
  assert.match(flowHtml,/123 delivery tokens/);
  assert.match(flowHtml,/mpq_loop_web/);
  assert.match(flowHtml,/memfact_loop_web/);
  assert.match(flowHtml,/Jun 26, 2026/);
  assert.equal(model.stopReasons.includes('unrelated_changes'),true);
  const app=await readFile('apps/web/app.js','utf8');
  assert.match(app,/function renderLoopWorkbench/);
  assert.match(app,/\/api\/loop\/workbench\?workspaceId=/);
  assert.match(app,/Create plan context/);
});

test('context pack command copy copies the adjacent command text',async()=>{
  const restores=[];
  try {
    const copied=[];
    const liveStatus={ textContent:'' };
    const command='npm run oaf -- mcp resources --read-only --format json';
    const button={
      textContent:'Copy',
      closest:(selector)=>selector==='li' ? { querySelector:(inner)=>inner==='code' ? { textContent:command } : null } : null
    };
    restores.push(replaceGlobal('navigator',{ clipboard:{ writeText:async(value)=>{ copied.push(value); } } }));
    restores.push(replaceGlobal('document',{ querySelector:(selector)=>selector==='#live-status' ? liveStatus : null }));
    restores.push(replaceGlobal('setTimeout',()=>0));
    await copyCommand({ currentTarget:button });
    assert.deepEqual(copied,[command]);
    assert.equal(liveStatus.textContent,'Command copied.');
    assert.equal(button.textContent,'Copied');
  } finally {
    for(const restore of restores.reverse())restore();
  }
});

test('pinned handoff status model gates receive commands by registry verification',()=>{
  const verifiedReport={
    registry:{exists:true,fingerprintStatus:'verified',entryCount:1},
    currentPointer:{exists:true,fingerprintStatus:'verified'},
    current:{entryId:'ctxpin_aaaaaaaaaaaaaaaaaaaaaaaa',status:'verified'},
    entries:[{
      id:'ctxpin_aaaaaaaaaaaaaaaaaaaaaaaa',
      targetHarness:'codex',
      contextPack:{fingerprint:'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'},
      usePlan:{fingerprint:'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'},
      sourceChecks:{total:2,verified:2,stale:0,unavailable:0,verifiedLocators:['workspace://AGENTS.md'],staleLocators:[],unavailableLocators:[]},
      artifactChecks:[{role:'agent-handoff',status:'verified'},{role:'use-plan',status:'verified'}]
    }]
  };
  const ready=buildPinnedHandoffStatusModel(verifiedReport);
  assert.equal(ready.state,'ready');
  assert.equal(ready.statusLabel,'verified');
  assert.equal(ready.targetLabel,'Codex');
  assert.equal(ready.primaryCommand.label,'Receive pinned pack');
  assert.equal(ready.primaryCommand.command,'recall context receive --read-only --root . --target codex --format json');
  assert.equal(canReceivePinnedHandoff(ready.state),true);
  assert.equal(ready.commands.some((item)=>item.label==='Receive pinned pack'),true);
  assert.equal(ready.commands.find((item)=>item.label==='Receive summary')?.command,'recall context receive --read-only --root . --target codex --format summary');
  assert.equal(ready.commands.some((item)=>item.label==='Read pinned use plan'),true);
  assert.equal(ready.facts.some(([key,value])=>key==='Use plan'&&value==='available'),true);

  const staleReport={
    ...verifiedReport,
    current:{entryId:'ctxpin_aaaaaaaaaaaaaaaaaaaaaaaa',status:'stale'},
    entries:[{
      ...verifiedReport.entries[0],
      sourceChecks:{total:2,verified:1,stale:1,unavailable:0,verifiedLocators:['workspace://AGENTS.md'],staleLocators:['workspace://apps/web/app.js'],unavailableLocators:[]}
    }]
  };
  const stale=buildPinnedHandoffStatusModel(staleReport);
  assert.equal(stale.state,'review');
  assert.equal(stale.statusLabel,'stale');
  assert.equal(stale.primaryCommand,null);
  assert.equal(canReceivePinnedHandoff(stale.state),true);
  assert.equal(stale.commands.some((item)=>item.label==='Receive pinned pack'),true);
  assert.equal(stale.commands.some((item)=>item.label==='Receive summary'),true);
  assert.equal(stale.commands.some((item)=>item.label==='Read pinned use plan'),false);
  assert.equal(stale.facts.some(([key,value])=>key==='Use plan'&&value==='withheld'),true);

  const missing=buildPinnedHandoffStatusModel({registry:{exists:false},currentPointer:{exists:false},current:{entryId:null,status:'missing'},entries:[]});
  assert.equal(missing.state,'none');
  assert.equal(missing.statusLabel,'not pinned');
  assert.equal(missing.primaryCommand,null);
  assert.equal(canReceivePinnedHandoff(missing.state),false);
  assert.equal(canReceivePinnedHandoff('blocked'),false);
  assert.equal(missing.commands.some((item)=>item.label==='Read pinned use plan'),false);
});

test('clipboard fallback rejects when browser copy fails',async()=>{
  const restores=[];
  try {
    let appended=false;
    let removed=false;
    const helper={
      value:'',
      style:{},
      setAttribute(){},
      focus(){},
      select(){},
      remove(){ removed=true; }
    };
    restores.push(replaceGlobal('navigator',{}));
    restores.push(replaceGlobal('document',{
      body:{ appendChild(node){ appended=node===helper; } },
      createElement(tag){
        assert.equal(tag,'textarea');
        return helper;
      },
      execCommand(command){
        assert.equal(command,'copy');
        return false;
      }
    }));
    await assert.rejects(()=>writeClipboardText('copy me'),/clipboard_unavailable/);
    assert.equal(helper.value,'copy me');
    assert.equal(appended,true);
    assert.equal(removed,true);
  } finally {
    for(const restore of restores.reverse())restore();
  }
});

test('first-use readiness proves local handoff gates before recommending use',()=>{
  const safePack={
    createdAt:'2026-06-24T00:00:00.000Z',
    targetHarness:'codex',
    sourceHarnesses:['codex'],
    readFirst:[{locator:'workspace://AGENTS.md'}],
    delivery:{sourceContentsIncluded:false},
    utility:{status:'ready',changedLocatorCoverage:{total:0,covered:0,ratio:0,status:'not_applicable'},requiredLocalReads:[{locator:'workspace://AGENTS.md',role:'selected_context',required:true,represented:true}],graphHintCoverage:{total:0,covered:0,ratio:0,status:'not_applicable'},sourceSelection:{candidateTokenCount:10,selectedTokenCount:10,selectedTokenRatio:1,estimatedReductionRatio:0},delivery:{representation:'locator-handoff',sourceContentsIncluded:false}},
    safeguards:{rawBodyIncluded:false,externalWritesEnabled:false,externalAdaptersEnabled:0,networkCalls:0,modelCalls:0,activeMemoryCreated:0},
    contextPackFingerprint:'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  };
  const safeReadback={
    checks:{contextPackFingerprintMatches:true,noMarkdownBody:true,noToolsExposed:true},
    bridge:{toolsExposed:0}
  };
  const ready=buildFirstUseReadinessModel({pack:safePack,markdown:'# Context Pack\n',readback:safeReadback});
  assert.equal(ready.ready,true);
  assert.equal(ready.title,'Ready for local handoff');
  assert.equal(ready.gates.find((gate)=>gate.id==='adapters').status,'pass');
  assert.equal(ready.gates.find((gate)=>gate.id==='utility').detail,'Utility read plan is present; no changed locators require source-graph coverage.');
  assert.equal(ready.gates.find((gate)=>gate.id==='setup-preview').status,'pending');
  assert.equal(ready.nextAction,'Use Copy markdown now, or copy and run Test local handoff for CLI and MCP proof. For durable CLI reuse, copy and run Pin locally, then Receive pinned pack.');
  const handoffStatus=buildCurrentHandoffStatusModel({
    contextPackResult:{
      pack:{...safePack,objective:'Prepare safe Codex handoff',step:'select useful context'},
      markdown:'# Context Pack\n',
      readback:safeReadback,
      usePlan:{requiredLocalReads:[{locator:'workspace://AGENTS.md'}]}
    }
  });
  assert.equal(handoffStatus.state,'generated-in-browser');
  assert.equal(handoffStatus.statusLabel,'ready');
  assert.equal(handoffStatus.selectedLocators,1);
  assert.equal(handoffStatus.usePlanReads,1);
  assert.equal(handoffStatus.safeguards.serverWrites,false);
  assert.equal(handoffStatus.safeguards.configWrites,false);
  assert.equal(handoffStatus.safeguards.externalWritesEnabled,false);
  assert.equal(handoffStatus.safeguards.externalAdaptersEnabled,0);
  assert.match(handoffStatus.preflightCommand,/^recall context handoff --read-only /);
  assert.doesNotMatch(handoffStatus.preflightCommand,/--memory-config/);
  assert.doesNotMatch(handoffStatus.preflightCommand,/--write|--pin|--out|install/);
  assert.match(handoffStatus.preflightSummaryCommand,/^recall context handoff --read-only /);
  assert.match(handoffStatus.preflightSummaryCommand,/--format summary/);
  assert.doesNotMatch(handoffStatus.preflightSummaryCommand,/--memory-config/);
  assert.doesNotMatch(handoffStatus.preflightSummaryCommand,/--write|--pin|--out|install/);
  const memoryPendingStatus=buildCurrentHandoffStatusModel({
    contextPackResult:{
      pack:{...safePack,objective:'Prepare safe Codex handoff',step:'select useful context'},
      markdown:'# Context Pack\n',
      readback:safeReadback,
      usePlan:{requiredLocalReads:[{locator:'workspace://AGENTS.md'}]},
      memoryConfig:buildMemoryWorkspaceConfig('notes/memory.md')
    }
  });
  assert.equal(memoryPendingStatus.state,'review-required');
  assert.equal(memoryPendingStatus.statusLabel,'review');
  assert.match(memoryPendingStatus.nextAction,/Memory import/);
  assert.match(memoryPendingStatus.preflightCommand,/--memory-config oaf\.memory\.json --format json/);
  assert.match(memoryPendingStatus.preflightSummaryCommand,/--memory-config oaf\.memory\.json --format summary/);
  const memoryPending=buildFirstUseReadinessModel({
    pack:safePack,
    markdown:'# Context Pack\n',
    readback:safeReadback,
    memoryConfig:buildMemoryWorkspaceConfig('notes/memory.md')
  });
  const memoryPendingGate=memoryPending.gates.find((gate)=>gate.id==='memory');
  assert.equal(memoryPending.ready,false);
  assert.equal(memoryPendingGate.status,'failed');
  assert.match(memoryPendingGate.detail,/Copy or download oaf\.memory\.json and run Test local handoff/);
  const memoryReady=buildFirstUseReadinessModel({
    pack:safePack,
    markdown:'# Context Pack\n',
    readback:safeReadback,
    memoryConfig:buildMemoryWorkspaceConfig('notes/memory.md'),
    memoryPreflight:{state:'ready',configured:true,safeguards:{activeMemoryCreated:0},summary:{reviewItemCount:0}}
  });
  assert.equal(memoryReady.ready,true);
  assert.equal(memoryReady.gates.find((gate)=>gate.id==='memory').status,'pass');
  const emptyHandoffStatus=buildCurrentHandoffStatusModel();
  assert.equal(emptyHandoffStatus.state,'none');
  assert.equal(emptyHandoffStatus.nextAction,'Build context pack');
  assert.equal(emptyHandoffStatus.preflightCommand,null);
  const setupReady=buildFirstUseReadinessModel({
    pack:safePack,
    markdown:'# Context Pack\n',
    readback:safeReadback,
    setupResult:{dryRun:true,safeguards:{localFilesWritten:0,externalWritesEnabled:false,networkCalls:0,rawConfigBodyIncluded:false}}
  });
  assert.equal(setupReady.ready,true);
  assert.equal(setupReady.gates.find((gate)=>gate.id==='setup-preview').status,'pass');
  assert.equal(setupReady.nextAction,'Use Copy markdown, or copy and run Test local handoff, Pin locally, then Receive pinned pack commands for durable CLI reuse.');
  const setupUnsafe=buildFirstUseReadinessModel({
    pack:safePack,
    markdown:'# Context Pack\n',
    readback:safeReadback,
    setupResult:{dryRun:false,safeguards:{localFilesWritten:1,externalWritesEnabled:true,networkCalls:1,rawConfigBodyIncluded:true}}
  });
  assert.equal(setupUnsafe.ready,false);
  assert.equal(setupUnsafe.gates.find((gate)=>gate.id==='setup-preview').blocking,true);
  const docsReview=buildFirstUseReadinessModel({
    pack:{
      ...safePack,
      utility:{
        status:'review',
        changedLocatorCoverage:{total:2,covered:1,ratio:.5,status:'partial'},
        requiredLocalReads:[
          {locator:'workspace://AGENTS.md',role:'selected_context',required:true,represented:true,contentHash:'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'},
          {locator:'workspace://apps/web/app.js',role:'changed_locator',required:true,represented:true,contentHash:'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'},
          {locator:'workspace://README.md',role:'changed_locator',required:true,represented:false,contentHash:'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'}
        ],
        graphHintCoverage:{total:0,covered:0,ratio:0,status:'not_applicable'},
        sourceSelection:{candidateTokenCount:10,selectedTokenCount:10,selectedTokenRatio:1,estimatedReductionRatio:0},
        delivery:{representation:'locator-handoff',sourceContentsIncluded:false}
      }
    },
    markdown:'# Context Pack\n',
    readback:safeReadback
  });
  const docsGate=docsReview.gates.find((gate)=>gate.id==='utility');
  assert.equal(docsReview.ready,false);
  assert.equal(docsGate.status,'failed');
  assert.equal(docsGate.detail,'1/2 changed locators represented by source-graph evidence; 2/2 have hash proof. Read unrepresented docs, config, or unsupported files manually before handoff.');
  const unsafe=buildFirstUseReadinessModel({
    pack:{
      ...safePack,
      readFirst:[],
      delivery:{sourceContentsIncluded:true},
      utility:{status:'review',changedLocatorCoverage:{total:1,covered:0,ratio:0,status:'partial'},requiredLocalReads:[],graphHintCoverage:{total:0,covered:0,ratio:0,status:'not_applicable'},sourceSelection:{candidateTokenCount:10,selectedTokenCount:0,selectedTokenRatio:0,estimatedReductionRatio:1},delivery:{representation:'locator-handoff',sourceContentsIncluded:false}},
      safeguards:{rawBodyIncluded:true,externalWritesEnabled:true,externalAdaptersEnabled:1,networkCalls:1,modelCalls:1,activeMemoryCreated:1}
    },
    markdown:'',
    readback:{checks:{contextPackFingerprintMatches:false,noMarkdownBody:false,noToolsExposed:false},bridge:{toolsExposed:1}}
  });
  assert.equal(unsafe.ready,false);
  assert.equal(unsafe.title,'Review before handoff');
  assert.deepEqual(unsafe.gates.filter((gate)=>gate.blocking).map((gate)=>gate.id),['artifact','selection','readback','resource-tools','raw-bodies','utility','side-effects','adapters','memory']);
  assert.equal(unsafe.nextAction,'Fix: Pack artifact.');
});

test('web shell copy avoids public beta and hidden-import claims',async()=>{
  const app=await readFile('apps/web/app.js','utf8');
  for (const forbidden of [
    /public beta/i,
    /production-ready/i,
    /automatic import/i,
    /automatically imports/i,
    /write-capable MCP/i,
    /external adapter enabled/i,
    /publishing enabled/i,
    /hosted benchmark/i,
    /saves provider tokens/i
  ]) {
    assert.doesNotMatch(app,forbidden);
  }
});

test('agents tools exposes dry-run harness setup planning without install affordances',async()=>{
  const app=await readFile('apps/web/app.js','utf8');
  assert.match(app,/Harness setup preview/);
  assert.equal(app.includes("api('/api/harness/setup/plan'"),true);
  assert.match(app,/No home config writes/);
  assert.match(app,/contextPackCommandList\(commands\)/);
  assert.match(app,/Manual config/);
  assert.match(app,/manualConfigSnippet/);
  assert.match(app,/CLI preview/);
  assert.match(app,/Read-only bridge/);
  assert.equal(harnessSetupClientsForUi().some(([id])=>id==='codex'),true);
  assert.equal(harnessSetupClientsForUi().some(([id])=>id==='cursor'),true);
  const model=buildHarnessSetupUiModel({
    schemaVersion:'1.0.0',
    plannerVersion:'0.1.0',
    command:'harness setup plan',
    dryRun:true,
    generatedAt:'2026-06-24T00:00:00.000Z',
    client:'cursor',
    clientLabel:'Cursor',
    server:'oaf',
    config:{ref:'home://.cursor/mcp.json',format:'json',exists:false,serverCount:0},
    status:{config:'absent',server:'absent'},
    desiredServer:{name:'oaf',transport:'stdio',command:'npm',args:['--silent','run','oaf','--','mcp','resources','--read-only','--stdio'],environmentKeys:[],resourceMode:'read-only',externalWrites:false},
    manualConfigSnippet:{format:'json',configRef:'home://.cursor/mcp.json',applyMode:'manual-copy',content:'{"mcpServers":{"oaf":{"command":"npm","args":["--silent","run","oaf","--","mcp","resources","--read-only","--stdio"]}}}',warning:'Preview only. Review and paste manually; OAF does not write home config files.'},
    diff:{redacted:true,operations:[{op:'add',target:'mcpServers.oaf',before:'absent',after:'read-only-oaf-mcp-stdio',summary:'add oaf with read-only OAF MCP stdio resource bridge'}],preview:['add oaf with read-only OAF MCP stdio resource bridge']},
    safeguards:{localFilesWritten:0,canonicalStateMutated:false,homeConfigMutated:false,externalWritesEnabled:false,externalAdaptersEnabled:0,networkCalls:0,modelCalls:0,rawConfigBodyIncluded:false,absoluteFilesystemLocationsIncluded:false,credentialsIncluded:false},
    planFingerprint:'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  });
  assert.equal(model.client,'Cursor');
  assert.equal(model.configRef,'home://.cursor/mcp.json');
  assert.equal(model.operation,'add oaf with read-only OAF MCP stdio resource bridge');
  assert.equal(model.command,'recall harness setup plan --client cursor --server oaf --dry-run --format json');
  assert.equal(model.bridgeCommand,'recall mcp resources --read-only --stdio');
  assert.equal(model.manualConfigSnippet.configRef,'home://.cursor/mcp.json');
  assert.match(model.manualConfigSnippet.content,/mcpServers/);
  assert.deepEqual(model.safeguards.find(([label])=>label==='External writes'),['External writes','disabled']);
  assert.deepEqual(model.safeguards.find(([label])=>label==='External adapters'),['External adapters','0']);
  assert.equal(JSON.stringify(model).includes('/Users/'),false);
  assert.equal(JSON.stringify(model).includes('secret-value'),false);
});

test('web shell classifies loading, setup, empty, partial, stale, success, denied, and error states',()=>{
  assert.deepEqual([...SHELL_STATES].sort(),['denied','empty','error','loading','partial','setup','stale','success']);
  assert.equal(classifyDashboardState(null).kind,'loading');
  assert.equal(classifyDashboardState({error:{status:503,code:'bootstrap_required'}}).kind,'setup');
  assert.equal(classifyDashboardState({error:{status:401}}).kind,'denied');
  assert.equal(classifyDashboardState({error:{message:'offline'}}).kind,'error');
  assert.equal(classifyDashboardState({metrics:{runs:0},runs:[],approvals:[],latestManifest:null}).kind,'empty');
  assert.equal(classifyDashboardState({metrics:{runs:1},runs:[{id:'run_1'}],approvals:[],latestManifest:null}).kind,'partial');
  assert.equal(classifyDashboardState({metrics:{runs:1},runs:[{id:'run_1'}],approvals:[],latestManifest:{id:'ctx_1'},stale:true}).kind,'stale');
  assert.equal(classifyDashboardState({metrics:{runs:1},runs:[{id:'run_1'}],approvals:[],latestManifest:{id:'ctx_1'}}).kind,'success');
});

test('web shell maps API validation issues to bounded recovery copy',()=>{
  const model=buildApiErrorUiModel({
    message:'The request did not match the API contract.',
    status:400,
    code:'request_validation_failed',
    correlationId:'req_client-00000000-0000-4000-8000-000000000001',
    issues:[
      {path:'$.body.changedLocators',code:'max_items'},
      {path:'$.body.client',code:'enum'},
      {path:'$.body.objective',code:'context_pack_objective_secret_like'},
      {path:'$.body.text',code:'memory_extraction_invalid'}
    ]
  });
  assert.equal(model.message,'The request did not match the API contract.');
  assert.equal(model.correlationId,'req_client-00000000-0000-4000-8000-000000000001');
  assert.deepEqual(model.issues.map((issue)=>issue.label),['Changed files','Client','Objective','Memory text']);
  assert.match(model.issues[0].detail,/workspace-relative paths/);
  assert.match(model.issues[2].detail,/Do not include secrets/);
  assert.match(model.issues[3].detail,/Fact or Decision/);
});

test('web shell redacts unsafe issue tokens before rendering recovery copy',()=>{
  const model=buildApiErrorUiModel({
    message:'Request failed.',
    correlationId:'/Users/rebel/private-token',
    issues:[{path:'/Users/rebel/.config/token',code:'secret=value'}]
  });
  assert.equal(model.correlationId,'');
  assert.equal(model.issues[0].path,'$.body');
  assert.equal(model.issues[0].code,'validation_failed');
  assert.equal(JSON.stringify(model).includes('/Users/rebel'),false);
  assert.equal(JSON.stringify(model).includes('secret=value'),false);
});

test('fabric map model visualizes current local state without enabling external surfaces',()=>{
  const model=buildFabricMapModel({
    shellState:{kind:'success'},
    activeNodeId:'model',
    dashboard:{
      metrics:{runs:2,events:9,pendingApprovals:1},
      runs:[{id:'run_1',status:'completed',output:{provider:'deterministic',model:'content-fixture',outputSchemaVersion:'schema:content@1'}}],
      latestRun:{
        id:'run_1',
        status:'completed',
        output:{
          provider:'deterministic',
          model:'content-fixture',
          outputSchemaVersion:'schema:content@1',
          output:[{rank:1,angle:'Keep it local',hook:'Use source-backed context.',evidenceIds:['obs_one'],confidence:.9}]
        }
      },
      latestManifest:{
        id:'ctx_test',
        objective:'Explain context flow',
        step:'generate-angles',
        compilerVersion:'0.2.0',
        manifestFingerprint:'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        budget:{used:45,available:90},
        selected:[{id:'obs_one',kind:'observation',text:'Selected evidence preview',tokens:30,source:'fixture'}],
        excluded:[{id:'obs_two',kind:'observation',text:'Excluded evidence preview',tokens:15,source:'fixture'}],
        conflicts:[],
        assembly:{
          assemblyFingerprint:'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          selectedRecordIds:['obs_one'],
          sections:[{id:'evidence',title:'Evidence',items:[{id:'obs_one',tokens:30}]}]
        }
      },
      memories:[{id:'mem_1',status:'proposed',kind:'preference',text:'Prefer local-only context',confidence:.7}],
      approvals:[{id:'apr_1',status:'pending',operationFingerprint:'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'}]
    }
  });
  assert.equal(model.activeNode.id,'model');
  assert.equal(model.summary.selectedRecords,1);
  assert.equal(model.summary.excludedRecords,1);
  assert.equal(model.summary.pendingApprovals,1);
  assert.equal(model.summary.externalAdaptersEnabled,0);
  assert.equal(model.summary.handoffState,'none');
  assert.equal(model.safeguards.externalWritesEnabled,false);
  assert.equal(model.safeguards.rawBodiesRendered,false);
  assert.equal(model.contextFlow.budgetPercent,50);
  assert.equal(model.nodes.find((node)=>node.id==='context').status,'active');
  assert.equal(model.nodes.find((node)=>node.id==='context').statusLabel,'has data');
  assert.equal(model.nodes.find((node)=>node.id==='approvals').status,'waiting');
  assert.equal(model.links.find((link)=>link.to==='external').blocked,true);
});

test('web shell markup keeps accessibility anchors and mobile navigation landmarks',async()=>{
  const html=await readFile('apps/web/index.html','utf8');
  const css=await readFile('apps/web/styles.css','utf8');
  const app=await readFile('apps/web/app.js','utf8');
  const usernamePattern=app.match(/name="username"[^>]+pattern="([^"]+)"/)?.[1];
  const renderedUsernamePattern=usernamePattern.replaceAll('\\\\','\\');
  assert.match(html,/href="#main"/);
  assert.match(html,/aria-label="Primary navigation"/);
  assert.match(html,/aria-label="Mobile navigation"/);
  assert.match(html,/aria-live="polite"/);
  assert.match(css,/prefers-reduced-motion/);
  assert.match(css,/min-height:44px/);
  assert.match(css,/focus-visible/);
  assert.match(css,/bottom-nav/);
  assert.equal(new RegExp(`^(?:${renderedUsernamePattern})$`,'v').test('agent-user_1:local'),true);
});

test('run inspector builds stable deep links and sanitized step summaries',()=>{
  const events=[
    {sequence:0,type:'run.created',actorId:'system',occurredAt:'2026-06-20T00:00:00.000Z',payload:{steps:['collect','compile-context','generate-angles']}},
    {sequence:1,type:'step.started',actorId:'agent:researcher',occurredAt:'2026-06-20T00:00:01.000Z',payload:{stepId:'collect',kind:'deterministic',attempt:1}},
    {sequence:2,type:'step.completed',actorId:'agent:researcher',occurredAt:'2026-06-20T00:00:02.000Z',payload:{stepId:'collect',attempt:1,summary:{observations:3,source:'synthetic-fixture',rawText:'do not render'}}},
    {sequence:3,type:'step.started',actorId:'agent:context-curator',occurredAt:'2026-06-20T00:00:03.000Z',payload:{stepId:'compile-context',kind:'deterministic',attempt:1}},
    {sequence:4,type:'step.failed',actorId:'agent:context-curator',occurredAt:'2026-06-20T00:00:04.000Z',payload:{stepId:'compile-context',attempt:1,code:'context_policy_denied',message:'safe public error',retryable:false}}
  ];
  const steps=summarizeRunSteps(events);
  assert.equal(steps.find((step)=>step.id==='collect').status,'success');
  assert.equal(steps.find((step)=>step.id==='collect').summary.rawText,undefined);
  assert.equal(steps.find((step)=>step.id==='compile-context').status,'failed');
  assert.equal(steps.find((step)=>step.id==='compile-context').errorCode,'context_policy_denied');
  assert.equal(runDetailLink('run_123','compile-context'),'/runs?run=run_123&step=compile-context');
  const safe=safeEventSummary(events[2]);
  assert.deepEqual(safe.summary,{observations:'3',source:'synthetic-fixture'});
});

test('context inspector model covers decision cards, assembly, conflicts, comparison, and links',()=>{
  const manifest={
    id:'ctx_test',
    objective:'Explain context selection',
    step:'generate-angles',
    actorId:'agent:context-curator',
    compilerVersion:'0.2.0',
    manifestFingerprint:'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    budget:{used:30,available:100},
    selected:[{id:'obs_one',kind:'observation',text:'Selected evidence preview',tokens:12,source:'fixture',scope:'workspace-private',confidence:.8,reasonCodes:['required_entity_match']}],
    excluded:[{id:'obs_two',kind:'observation',text:'Excluded evidence preview',tokens:18,source:'fixture',scope:'workspace-private',reasonCodes:['redundant']}],
    conflicts:[{id:'conflict_one',reason:'version conflict'}],
    assembly:{
      assemblyFingerprint:'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      selectedRecordIds:['obs_one'],
      sections:[{id:'evidence',title:'Evidence',items:[{id:'obs_one',tokens:12}]}]
    }
  };
  const selected=contextDecisionView(manifest.selected[0],'selected');
  assert.equal(selected.id,'obs_one');
  assert.equal(selected.preview,'Selected evidence preview');
  assert.equal(selected.tokens,12);
  assert.equal(selected.selectedOrExcluded,'selected');
  assert.equal(contextRecordLink('obs_one','selected'),'/context?record=obs_one&state=selected');
  const model=buildContextInspectorModel(manifest);
  assert.equal(model.selected.length,1);
  assert.equal(model.excluded.length,1);
  assert.equal(model.sections[0].recordIds[0],'obs_one');
  assert.equal(model.comparison.selectedMissingFromAssembly.length,0);
  assert.equal(model.comparison.conflictCount,1);
});

test('memory review model exposes lifecycle diffs without leaking raw secrets',()=>{
  const memories=[
    {
      id:'mem_old',
      kind:'preference',
      text:'Use short local-only runs',
      status:'active',
      source:'user-confirmed',
      confidence:.9,
      retention:{mode:'workspace-default'},
      lifecycle:[{type:'memory.activated',at:'2026-06-20T00:00:00.000Z',actorId:'usr_reviewer'}],
      evidenceIds:['obs_pref']
    },
    {
      id:'mem_new',
      kind:'preference',
      text:`Use ${['sk','abcdefghijklmnopqrstuvwxyz'].join('-')} as the model key`,
      status:'proposed',
      source:'agent-proposed',
      confidence:.6,
      retention:'expire-at',
      supersedes:'mem_old',
      conflicts:[{reason:'same_subject_predicate_different_text'}],
      lifecycle:[{type:'memory.proposed',at:'2026-06-20T00:01:00.000Z',actorId:'agent:evaluator',evidenceIds:['obs_pref']}],
      evidenceIds:['obs_pref'],
      metadata:{reviewer:'usr_reviewer'}
    }
  ];
  const model=buildMemoryReviewModel({memories});
  const replacement=model.find((memory)=>memory.id==='mem_new');
  assert.equal(replacement.previousValue,'Use short local-only runs');
  assert.equal(replacement.proposedValue,'[redacted-sensitive-value]');
  assert.equal(replacement.conflict,'same_subject_predicate_different_text');
  assert.deepEqual(replacement.actions.map((action)=>action.label),['Approve','Edit','Reject','Set expiry']);
  assert.equal(replacement.lifecycle[0].evidenceIds[0],'obs_pref');
});

test('evidence explorer model separates observed fields, inferred claims, source snapshots, and conflicts',()=>{
  const model=buildEvidenceExplorerModel({
    latestManifest:{
      selected:[{
        id:'obs_alpha',
        kind:'observation',
        text:'A run recovered after restart with evidence IDs.',
        sourceSnapshotId:'src_alpha',
        source:'fixture',
        collectionMethod:'file-read',
        observedAt:'2026-06-20T00:00:00.000Z',
        sourceContentHash:'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        trustClass:'observed'
      }],
      conflicts:[{id:'conf_alpha',reason:'stale_metric',recordId:'obs_alpha'}]
    },
    latestRun:{
      output:{
        provider:'deterministic',
        model:'content-fixture',
        output:[{rank:1,angle:'Show recovery',hook:'Use restart proof.',evidenceIds:['obs_alpha'],confidence:.82}]
      }
    }
  });
  assert.equal(model.length,1);
  assert.equal(model[0].sourceSnapshotId,'src_alpha');
  assert.equal(model[0].observed.text,'A run recovered after restart with evidence IDs.');
  assert.equal(model[0].claims[0].id,'candidate:1');
  assert.equal(model[0].claims[0].model,'deterministic');
  assert.equal(model[0].conflicts[0],'stale_metric');
});

test('approval review model requires exact operation previews and marks edits invalidating',()=>{
  const model=buildApprovalReviewModel({
    approvals:[{
      id:'appr_1',
      status:'pending',
      actorId:'usr_reviewer',
      operationFingerprint:'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      destination:'local draft ledger',
      preview:{diff:'- old\n+ new'},
      riskClass:'consequential-write',
      policyVersion:'policy:local@1.0.0',
      expiresAt:'2026-06-20T00:15:00.000Z',
      idempotencyKey:'idem_1',
      consequence:'records local draft outcome',
      reasonCodes:['approval_required','idempotency_required'],
      externalWrites:false
    }]
  });
  assert.equal(model[0].operationHash,'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(model[0].exactContent,'- old + new');
  assert.equal(model[0].editInvalidates,true);
  assert.equal(model[0].externalWrites,false);
  assert.deepEqual(model[0].actions.map((action)=>action.label),['Approve exact operation','Edit invalidates approval','Reject']);
});
