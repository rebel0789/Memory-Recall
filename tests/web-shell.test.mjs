import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ROUTES,
  SHELL_STATES,
  buildContextSourcePreviewUiModel,
  buildContextPackUiModel,
  buildApprovalReviewModel,
  buildContextInspectorModel,
  buildEvidenceExplorerModel,
  buildFabricMapModel,
  buildFirstUseReadinessModel,
  buildHarnessSetupUiModel,
  buildMemoryReviewModel,
  classifyDashboardState,
  contextDecisionView,
  copyCommand,
  contextRecordLink,
  legacyViewPath,
  navItems,
  parseSelectedFiles,
  harnessSetupClientsForUi,
  resolveRoute,
  runDetailLink,
  safeEventSummary,
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
  assert.deepEqual(navItems.map(item=>item.path),['/','/runs','/workflows','/fabric-map','/context','/context-pack','/source-graph','/memory','/evidence','/approvals','/content','/agents-tools','/settings']);
  assert.equal(resolveRoute('http://127.0.0.1:4310/runs').id,'runs');
  assert.equal(resolveRoute('http://127.0.0.1:4310/fabric-map').id,'fabric-map');
  assert.equal(resolveRoute('http://127.0.0.1:4310/context?manifest=ctx_1').id,'context');
  assert.equal(resolveRoute('http://127.0.0.1:4310/context-pack').id,'context-pack');
  assert.equal(resolveRoute('http://127.0.0.1:4310/source-graph').id,'source-graph');
  assert.equal(resolveRoute('http://127.0.0.1:4310/?view=evidence').id,'evidence');
  assert.equal(resolveRoute('http://127.0.0.1:4310/not-a-route').id,'home');
  assert.equal(legacyViewPath('design'),'/settings');
  assert.equal(ROUTES.some(route=>route.id==='content'),true);
});

test('context pack user flow exposes artifact actions and safe harness commands',async()=>{
  assert.deepEqual(parseSelectedFiles('docs/handoff.md\n docs/handoff.md,notes/context.md '),['docs/handoff.md','notes/context.md']);
  const app=await readFile('apps/web/app.js','utf8');
  assert.match(app,/Build context pack/);
  assert.match(app,/data-action="copy-pack"/);
  assert.match(app,/data-action="copy-launch-prompt"/);
  assert.match(app,/data-action="copy-command"/);
  assert.match(app,/function copyCommand/);
  assert.match(app,/async function writeClipboardText/);
  assert.match(app,/Copy markdown first/);
  assert.match(app,/data-action="download-pack"/);
  assert.match(app,/data-action="detect-git-changes"/);
  assert.match(app,/data-action="preview-context-sources"/);
  assert.match(app,/api\('\/api\/context\/git-changes'/);
  assert.match(app,/api\('\/api\/context\/source-preview'/);
  assert.match(app,/Preview sources/);
  assert.match(app,/Review before building/);
  assert.match(app,/name="changedLocators"/);
  assert.match(app,/name="sourceFamilies"/);
  assert.match(app,/\['codex','Codex'\]/);
  assert.match(app,/\['claude-code','Claude Code'\]/);
  assert.match(app,/\['cursor','Cursor'\]/);
  assert.match(app,/index===0\?' checked':''/);
  assert.equal(app.includes('name="sourceFamilies" value="all"'),false);
  assert.equal(app.includes('name="sourceFamilies" value="generic"'),false);
  assert.match(app,/from:sourceFamilies\.join\(','\)/);
  assert.match(app,/data-action="preview-pack-setup"/);
  assert.match(app,/Change Impact/);
  assert.match(app,/Intake review/);
  assert.match(app,/Context pack proof metrics/);
  assert.match(app,/Utility read plan/);
  assert.match(app,/Hash verified/);
  assert.match(app,/Build time/);
  assert.match(app,/Raw bodies/);
  assert.match(app,/Estimated local tokens/);
  assert.match(app,/Observed local request/);
  assert.match(app,/Readback proof/);
  assert.match(app,/MCP readback/);
  assert.match(app,/mcp resources --read-only --uri oaf:\/\/workspace\/ws_local\/handoff\/latest/);
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
    sourceGraph:{impact:{changedLocators:['workspace://apps/web/app.js'],representedChangedLocators:['workspace://apps/web/app.js'],affectedSymbolCount:3,affectedSymbols:[]}},
    utility:{
      status:'ready',
      requiredLocalReads:[
        {locator:'workspace://AGENTS.md',role:'selected_context',required:true,represented:true,contentHash:'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',reasonCodes:['selected_context'],readHint:'Read workspace://AGENTS.md'},
        {locator:'workspace://apps/web/app.js',role:'changed_locator',required:true,represented:true,contentHash:null,reasonCodes:['changed_locator_supplied'],readHint:'Read workspace://apps/web/app.js'}
      ],
      changedLocatorCoverage:{total:1,covered:1,ratio:1,status:'covered'},
      graphHintCoverage:{total:2,covered:1,ratio:0.5,status:'partial'},
      sourceSelection:{candidateTokenCount:1000,selectedTokenCount:250,selectedTokenRatio:0.25,estimatedReductionRatio:0.75},
      delivery:{representation:'locator-handoff',sourceContentsIncluded:false}
    },
    handoff:{
      launchPrompt:'Continue this local repository work in codex.\nChanged-file coverage: 1/1',
      commands:[
        "npm run doctor",
        "npm run oaf -- context pack --from 'codex,cursor' --root . --objective 'Ship user'\"'\"'s change safely' --step 'select useful context' --target codex --changed 'apps/web/app.js' --dry-run --format markdown",
        "npm run oaf -- harness setup plan --client codex --server oaf --dry-run --format json",
        "npm run oaf -- mcp resources --read-only --context-pack --from 'codex,cursor' --root . --objective 'Ship user'\"'\"'s change safely' --step 'select useful context' --target codex --changed 'apps/web/app.js' --uri oaf://workspace/ws_local/context-pack/current --format json",
        "npm run ci"
      ]
    },
    safeguards:{modelCalls:0,networkCalls:0,activeMemoryCreated:0,externalWritesEnabled:false,rawBodyIncluded:false},
    warnings:['dry_run_no_import'],
    contextPackFingerprint:'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  },'# Context Pack',{
    observedDurationMs:34.4,
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
  assert.equal(model.setupClient,'codex');
  assert.equal(model.launchPrompt.includes('Changed-file coverage: 1/1'),true);
  assert.deepEqual(model.utility.topReads.map((item)=>item.locator),['workspace://AGENTS.md','workspace://apps/web/app.js']);
  assert.equal(model.utility.changedCoverageLabel,'1/1');
  assert.equal(model.utility.changedHashVerifiedLabel,'0/1');
  assert.equal(model.utility.topReads[1].contentHash,'');
  assert.equal(model.utility.sourceReduction,'75%');
  assert.deepEqual(model.sourceFamilies,['codex','cursor']);
  assert.equal(model.sourceFamilyLabel,'codex, cursor');
  assert.deepEqual(model.intakeReview,{acceptedCount:1,excludedCount:1,omittedCount:2,proposedCount:1,quarantinedCount:1,activeMemoryCreated:0});
  assert.equal(model.estimatedReductionPercent,75);
  assert.equal(model.downloadName,'open-agent-fabric-context-pack-codex-2026-06-24.md');
  assert.match(model.commands[1].command,/--from 'codex,cursor'/);
  assert.match(model.commands[1].command,/--target codex --changed 'apps\/web\/app\.js' --dry-run --format markdown/);
  assert.doesNotMatch(model.commands[1].command,/--from all/);
  assert.match(model.commands[1].command,/Ship user'"'"'s change safely/);
  assert.match(model.commands[2].command,/harness setup plan --client codex --server oaf --dry-run --format json/);
  assert.match(model.commands[3].command,/--from 'codex,cursor'/);
  assert.equal(model.commands.some((item)=>item.command.includes('mcp resources --read-only')),true);
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
    safeguards:{rawBodyIncluded:false,externalWritesEnabled:false,networkCalls:0,modelCalls:0,activeMemoryCreated:0},
    contextPackFingerprint:'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  };
  const safeReadback={
    checks:{contextPackFingerprintMatches:true,noMarkdownBody:true,noToolsExposed:true},
    bridge:{toolsExposed:0}
  };
  const ready=buildFirstUseReadinessModel({pack:safePack,markdown:'# Context Pack\n',readback:safeReadback});
  assert.equal(ready.ready,true);
  assert.equal(ready.title,'Ready for local handoff');
  assert.equal(ready.gates.find((gate)=>gate.id==='setup-preview').status,'pending');
  assert.equal(ready.nextAction,'Use Copy markdown now. Preview setup only if you want MCP resource discovery.');
  const setupReady=buildFirstUseReadinessModel({
    pack:safePack,
    markdown:'# Context Pack\n',
    readback:safeReadback,
    setupResult:{dryRun:true,safeguards:{localFilesWritten:0,externalWritesEnabled:false,networkCalls:0,rawConfigBodyIncluded:false}}
  });
  assert.equal(setupReady.ready,true);
  assert.equal(setupReady.gates.find((gate)=>gate.id==='setup-preview').status,'pass');
  const setupUnsafe=buildFirstUseReadinessModel({
    pack:safePack,
    markdown:'# Context Pack\n',
    readback:safeReadback,
    setupResult:{dryRun:false,safeguards:{localFilesWritten:1,externalWritesEnabled:true,networkCalls:1,rawConfigBodyIncluded:true}}
  });
  assert.equal(setupUnsafe.ready,false);
  assert.equal(setupUnsafe.gates.find((gate)=>gate.id==='setup-preview').blocking,true);
  const unsafe=buildFirstUseReadinessModel({
    pack:{
      ...safePack,
      readFirst:[],
      delivery:{sourceContentsIncluded:true},
      utility:{status:'review',changedLocatorCoverage:{total:1,covered:0,ratio:0,status:'partial'},requiredLocalReads:[],graphHintCoverage:{total:0,covered:0,ratio:0,status:'not_applicable'},sourceSelection:{candidateTokenCount:10,selectedTokenCount:0,selectedTokenRatio:0,estimatedReductionRatio:1},delivery:{representation:'locator-handoff',sourceContentsIncluded:false}},
      safeguards:{rawBodyIncluded:true,externalWritesEnabled:true,networkCalls:1,modelCalls:1,activeMemoryCreated:1}
    },
    markdown:'',
    readback:{checks:{contextPackFingerprintMatches:false,noMarkdownBody:false,noToolsExposed:false},bridge:{toolsExposed:1}}
  });
  assert.equal(unsafe.ready,false);
  assert.equal(unsafe.title,'Review before handoff');
  assert.deepEqual(unsafe.gates.filter((gate)=>gate.blocking).map((gate)=>gate.id),['artifact','selection','readback','resource-tools','raw-bodies','utility','side-effects','memory']);
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
    desiredServer:{name:'oaf',transport:'stdio',command:'npm',args:['run','oaf','--','mcp','resources','--read-only','--stdio'],environmentKeys:[],resourceMode:'read-only',externalWrites:false},
    diff:{redacted:true,operations:[{op:'add',target:'mcpServers.oaf',before:'absent',after:'read-only-oaf-mcp-stdio',summary:'add oaf with read-only OAF MCP stdio resource bridge'}],preview:['add oaf with read-only OAF MCP stdio resource bridge']},
    safeguards:{localFilesWritten:0,canonicalStateMutated:false,homeConfigMutated:false,externalWritesEnabled:false,externalAdaptersEnabled:0,networkCalls:0,modelCalls:0,rawConfigBodyIncluded:false,absoluteFilesystemLocationsIncluded:false,credentialsIncluded:false},
    planFingerprint:'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  });
  assert.equal(model.client,'Cursor');
  assert.equal(model.configRef,'home://.cursor/mcp.json');
  assert.equal(model.operation,'add oaf with read-only OAF MCP stdio resource bridge');
  assert.equal(model.command,'npm run oaf -- harness setup plan --client cursor --server oaf --dry-run --format json');
  assert.equal(model.bridgeCommand,'npm run oaf -- mcp resources --read-only --stdio');
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
  assert.equal(model.safeguards.externalWritesEnabled,false);
  assert.equal(model.safeguards.rawBodiesRendered,false);
  assert.equal(model.contextFlow.budgetPercent,50);
  assert.equal(model.nodes.find((node)=>node.id==='context').status,'active');
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
