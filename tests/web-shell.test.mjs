import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildCompressedProfileContextReport } from '../packages/context-compiler/src/index.mjs';
import { SQLiteMemoryProvider } from '../providers/native/memory-sqlite/src/index.mjs';
import {
  ROUTES,
  SHELL_STATES,
  buildApiErrorUiModel,
  CONSUMER_START_ACTIONS,
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
  buildMemoryCockpitModel,
  buildMemoryGraphModel,
  buildMemoryReviewModel,
  buildPinnedHandoffStatusModel,
  canReceivePinnedHandoff,
  classifyDashboardState,
  contextDecisionView,
  copyCommand,
  contextRecordLink,
  legacyViewPath,
  navItems,
  normalizeMemorySourceFiles,
  parseSelectedFiles,
  harnessSetupClientsForUi,
  resolveRoute,
  runDetailLink,
  safeEventSummary,
  selectContextPackPinPayload,
  renderMemoryCockpit,
  renderMemoryGraph,
  renderLoopWorkbenchMemoryFlow,
  renderConsumerStartActions,
  shellStatusLabel,
  summarizeRunSteps,
  writeClipboardText
} from '../apps/web/app.js';

function replaceGlobal(name,value) {
  const previous=Object.getOwnPropertyDescriptor(globalThis,name);
  Object.defineProperty(globalThis,name,{ configurable:true, writable:true, value });
  return ()=>{
    if(previous)Object.defineProperty(globalThis,name,previous);
    else delete globalThis[name];
  };
}

test('web shell exposes stable path routes with legacy query compatibility',()=>{
  assert.deepEqual(navItems.map(item=>item.path),['/','/runs','/workflows','/loop-workbench','/fabric-map','/context','/context-pack','/source-graph','/memory','/memory-graph','/evidence','/approvals','/content','/agents-tools','/settings']);
  assert.equal(resolveRoute('http://127.0.0.1:4310/runs').id,'runs');
  assert.equal(resolveRoute('http://127.0.0.1:4310/loop-workbench').id,'loop-workbench');
  assert.equal(resolveRoute('http://127.0.0.1:4310/fabric-map').id,'fabric-map');
  assert.equal(resolveRoute('http://127.0.0.1:4310/context?manifest=ctx_1').id,'context');
  assert.equal(resolveRoute('http://127.0.0.1:4310/context-pack').id,'context-pack');
  assert.equal(resolveRoute('http://127.0.0.1:4310/source-graph').id,'source-graph');
  assert.equal(resolveRoute('http://127.0.0.1:4310/memory-graph').id,'memory-graph');
  assert.equal(resolveRoute('http://127.0.0.1:4310/?view=evidence').id,'evidence');
  assert.equal(resolveRoute('http://127.0.0.1:4310/not-a-route').id,'home');
  assert.equal(legacyViewPath('design'),'/settings');
  assert.equal(ROUTES.some(route=>route.id==='content'),true);
});

test('first-use home exposes consumer start actions',()=>{
  assert.deepEqual(CONSUMER_START_ACTIONS.map((action)=>action.label),['Connect','Save Tokens','Add Memory','View Repo Map']);
  assert.deepEqual(CONSUMER_START_ACTIONS.map((action)=>action.route),['/agents-tools','/context-pack','/memory','/source-graph']);
  const html=renderConsumerStartActions();
  for (const label of ['Connect','Save Tokens','Add Memory','View Repo Map']) {
    assert.match(html,new RegExp(`>${label}<`));
  }
  assert.match(html,/aria-label="First actions"/);
});

test('memory route renders real temporal fact fields and computed token number', async (t) => {
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
  assert.equal(model.tokenBudget.estimatedDeliveryTokens, profile.contextBudget.estimatedDeliveryTokens);
  assert.equal(model.savings.beforeDeliveryTokens, profile.contextBudget.historyTokensAvailable);
  assert.equal(model.savings.afterDeliveryTokens, profile.contextBudget.estimatedDeliveryTokens);
  assert.equal(model.savings.providerBillingClaimed, false);
  assert.equal(model.mcpStats.callCount, 2);
  assert.equal(model.mcpStats.deliveredTokens, 320);
  assert.equal(model.summary.activeFactCount, 1);
  assert.equal(model.summary.pendingProposalCount, 1);
  assert.match(html, new RegExp(`${model.tokenSavingPercent}% token saving`));
  assert.match(html, /<dt>Active facts<\/dt><dd>1<\/dd>/);
  assert.match(html, /<dt>Pending proposals<\/dt><dd>1<\/dd>/);
  assert.match(html, /data-action="approve-memory-proposal"/);
  assert.match(html, new RegExp(`<dt>Naive baseline</dt><dd>${profile.contextBudget.historyTokensAvailable}</dd>`));
  assert.match(html, new RegExp(`<dt>OAF compressed</dt><dd>${profile.contextBudget.estimatedDeliveryTokens}</dd>`));
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
  const model = buildMemoryGraphModel(report);
  const html = renderMemoryGraph(report, { history: true, query: 'provider', communities: true });
  const source = await readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8');
  assert.equal(model.summary.edgeCount, 2);
  assert.equal(model.nodes.some((node) => node.governedDecision), true);
  assert.match(html, /id="memory-graph-canvas"/);
  assert.match(html, /id="memory-graph-history"/);
  assert.match(html, /id="memory-graph-communities"/);
  assert.match(html, /provider:native:memory:sqlite/);
  assert.match(html, /legacy-view/);
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
  assert.match(app,/Build context pack/);
  assert.match(app,/data-action="copy-pack"/);
  assert.match(app,/data-action="copy-launch-prompt"/);
  assert.match(app,/data-action="receive-pinned-handoff"/);
  assert.match(app,/data-action="copy-receiver-packet"/);
  assert.match(app,/data-action="copy-command"/);
  assert.match(app,/function copyCommand/);
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
  assert.match(app,/Create a first local handoff/);
  assert.match(app,/Prepare this repository for the next coding agent/);
  assert.match(app,/without sending source bodies, writing server state, calling models, using the network, or enabling adapters/);
  assert.match(app,/Inputs to review/);
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
  assert.match(app,/value="context pack buildContextPackUiModel"/);
  assert.match(app,/value="buildContextPackUiModel"/);
  assert.match(app,/name="changedLocator" value="apps\/web\/app\.js"/);
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
  assert.equal(receiveCommand,'npm run oaf -- context receive --read-only --root . --target codex --format json');
  assert.doesNotMatch(receiveCommand,/--objective|--step|--write|--pin|--out|--home|--config|--stdio/);
  const summaryCommand=model.commands[summaryIndex].command;
  assert.equal(summaryCommand,'npm run oaf -- context receive --read-only --root . --target codex --format summary');
  assert.doesNotMatch(summaryCommand,/--objective|--step|--write|--pin|--out|--home|--config|--stdio/);
  assert.equal(model.commands.some((item)=>item.command==='npm --silent run oaf -- mcp resources --read-only --stdio'),true);
  const preflightCommand=model.commands.find((item)=>item.label==='Test local handoff')?.command ?? '';
  assert.match(preflightCommand,/^npm --silent run oaf -- context handoff --read-only /);
  assert.match(preflightCommand,/--from 'codex,cursor'/);
  assert.match(preflightCommand,/--target codex --changed 'apps\/web\/app\.js' --memory-config oaf\.memory\.json --format json/);
  assert.doesNotMatch(preflightCommand,/--write|--pin|--out|install/);
  const preflightSummaryCommand=model.commands.find((item)=>item.label==='Test handoff summary')?.command ?? '';
  assert.match(preflightSummaryCommand,/^npm --silent run oaf -- context handoff --read-only /);
  assert.match(preflightSummaryCommand,/--from 'codex,cursor'/);
  assert.match(preflightSummaryCommand,/--target codex --changed 'apps\/web\/app\.js' --memory-config oaf\.memory\.json --format summary/);
  assert.doesNotMatch(preflightSummaryCommand,/--write|--pin|--out|install/);
  const impactCommand=model.commands.find((item)=>item.label==='Copy impact command')?.command ?? '';
  assert.match(impactCommand,/^npm --silent run oaf -- measure context-pack --read-only /);
  assert.match(impactCommand,/--from 'codex,cursor'/);
  assert.match(impactCommand,/--target codex --changed 'apps\/web\/app\.js' --format json/);
  assert.doesNotMatch(impactCommand,/--write|--pin|--out|install/);
  assert.equal(model.commands.some((item)=>item.command==='npm run oaf -- mcp resources --read-only --uri oaf://workspace/ws_local/context-pack/registry/current --format json'),true);
  assert.equal(model.commands.some((item)=>item.command==='npm run oaf -- mcp resources --read-only --uri oaf://workspace/ws_local/context-pack/use-plan/current --format json'),true);
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
  assert.equal(ready.primaryCommand.command,'npm run oaf -- context receive --read-only --root . --target codex --format json');
  assert.equal(canReceivePinnedHandoff(ready.state),true);
  assert.equal(ready.commands.some((item)=>item.label==='Receive pinned pack'),true);
  assert.equal(ready.commands.find((item)=>item.label==='Receive summary')?.command,'npm run oaf -- context receive --read-only --root . --target codex --format summary');
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
  assert.match(handoffStatus.preflightCommand,/^npm --silent run oaf -- context handoff --read-only /);
  assert.doesNotMatch(handoffStatus.preflightCommand,/--memory-config/);
  assert.doesNotMatch(handoffStatus.preflightCommand,/--write|--pin|--out|install/);
  assert.match(handoffStatus.preflightSummaryCommand,/^npm --silent run oaf -- context handoff --read-only /);
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
  assert.equal(model.command,'npm run oaf -- harness setup plan --client cursor --server oaf --dry-run --format json');
  assert.equal(model.bridgeCommand,'npm --silent run oaf -- mcp resources --read-only --stdio');
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
      {path:'$.body.objective',code:'context_pack_objective_secret_like'}
    ]
  });
  assert.equal(model.message,'The request did not match the API contract.');
  assert.equal(model.correlationId,'req_client-00000000-0000-4000-8000-000000000001');
  assert.deepEqual(model.issues.map((issue)=>issue.label),['Changed files','Client','Objective']);
  assert.match(model.issues[0].detail,/workspace-relative paths/);
  assert.match(model.issues[2].detail,/Do not include secrets/);
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

test('status labels include text and do not rely on color alone',()=>{
  assert.equal(shellStatusLabel({network:'deny',externalWrites:false,modelMode:'deterministic'}),'Local-only · Network denied · External writes disabled · Deterministic model');
  assert.equal(shellStatusLabel({network:'allow',externalWrites:true,modelMode:'ollama'}),'Network allowed · External writes enabled · ollama model');
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
