import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ROUTES,
  SHELL_STATES,
  buildApprovalReviewModel,
  buildContextInspectorModel,
  buildEvidenceExplorerModel,
  buildFabricMapModel,
  buildMemoryReviewModel,
  classifyDashboardState,
  contextDecisionView,
  contextRecordLink,
  legacyViewPath,
  navItems,
  resolveRoute,
  runDetailLink,
  safeEventSummary,
  shellStatusLabel,
  summarizeRunSteps
} from '../apps/web/app.js';

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
