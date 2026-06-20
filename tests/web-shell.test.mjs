import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ROUTES,
  SHELL_STATES,
  buildContextInspectorModel,
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
  assert.deepEqual(navItems.map(item=>item.path),['/','/runs','/workflows','/context','/memory','/evidence','/approvals','/content','/agents-tools','/settings']);
  assert.equal(resolveRoute('http://127.0.0.1:4310/runs').id,'runs');
  assert.equal(resolveRoute('http://127.0.0.1:4310/context?manifest=ctx_1').id,'context');
  assert.equal(resolveRoute('http://127.0.0.1:4310/?view=evidence').id,'evidence');
  assert.equal(resolveRoute('http://127.0.0.1:4310/not-a-route').id,'home');
  assert.equal(legacyViewPath('design'),'/settings');
  assert.equal(ROUTES.some(route=>route.id==='content'),true);
});

test('web shell classifies loading, empty, partial, stale, success, denied, and error states',()=>{
  assert.deepEqual([...SHELL_STATES].sort(),['denied','empty','error','loading','partial','stale','success']);
  assert.equal(classifyDashboardState(null).kind,'loading');
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

test('web shell markup keeps accessibility anchors and mobile navigation landmarks',async()=>{
  const html=await readFile('apps/web/index.html','utf8');
  const css=await readFile('apps/web/styles.css','utf8');
  assert.match(html,/href="#main"/);
  assert.match(html,/aria-label="Primary navigation"/);
  assert.match(html,/aria-label="Mobile navigation"/);
  assert.match(html,/aria-live="polite"/);
  assert.match(css,/prefers-reduced-motion/);
  assert.match(css,/min-height:44px/);
  assert.match(css,/focus-visible/);
  assert.match(css,/bottom-nav/);
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
