import { readFile } from 'node:fs/promises';
import {
  compileContext,
  compileAndPersistContext,
  compareContextManifests,
  compileContextFromSources,
  createCandidateSourceRegistry,
  createFixtureRecordReader,
  createNativeExactCandidateSource,
  createNativeLexicalCandidateSource,
  verifyContextManifest
} from '../packages/context-compiler/src/index.mjs';
import { createPolicyService } from '../packages/policy/src/index.mjs';
import { evaluatePolicy } from '../packages/policy/src/index.mjs';
import { proposeMemory } from '../packages/memory-core/src/index.mjs';
let passed=0,failed=0;const check=(label,condition)=>{if(condition){console.log(`PASS ${label}`);passed++}else{console.error(`FAIL ${label}`);failed++}};
const contextCases=JSON.parse(await readFile('evals/context-selection/cases.json','utf8'));
for(const test of contextCases){
  const result=test.mode==='sources'
    ? await compileContextFromSources(test.request,{registry:createCandidateSourceRegistry([createNativeExactCandidateSource(),createNativeLexicalCandidateSource()]),recordReader:createFixtureRecordReader(test.records),policyService:createPolicyService({decisionIdFactory:()=>test.policyDecisionId??'poldet_eval_allow',clock:()=>test.request.now??test.request.trustedTimestamp??new Date().toISOString()}),trustedContext:test.trustedContext})
    : {manifest:compileContext(test.request,test.records),candidateGeneration:null,selection:null};
  const manifest=result.manifest,selection=result.selection??manifest.selection,selectedIds=manifest.selected.map(item=>item.id),excludedIds=manifest.excluded.map(item=>item.id),selected=new Set(selectedIds),excluded=new Set(excludedIds);
  check(`${test.id}: required selections`,test.expect.selected.every(id=>selected.has(id)));
  check(`${test.id}: required exclusions`,test.expect.excluded.every(id=>excluded.has(id)));
  check(`${test.id}: token budget`,manifest.budget.used<=manifest.budget.available);
  check(`${test.id}: conflict count`,manifest.conflicts.length===test.expect.conflicts);
  if(test.expect.selectedOrder)check(`${test.id}: selected order`,JSON.stringify(selectedIds)===JSON.stringify(test.expect.selectedOrder));
  if(test.expect.excludedReasons)for(const [id,reasons]of Object.entries(test.expect.excludedReasons)){const item=manifest.excluded.find(entry=>entry.id===id);check(`${test.id}: ${id} exclusion reasons`,!!item&&reasons.every(reason=>item.reasonCodes.includes(reason)))}
  if(test.expect.sufficiencyState)check(`${test.id}: sufficiency`,selection?.sufficiency?.state===test.expect.sufficiencyState);
  if(test.expect.selectionPolicyFingerprint)check(`${test.id}: policy fingerprint`,/^sha256:[a-f0-9]{64}$/.test(selection?.selectionPolicyFingerprint??''));
  if(test.expect.resultFingerprint)check(`${test.id}: result fingerprint`,/^sha256:[a-f0-9]{64}$/.test(selection?.resultFingerprint??''));
  if(test.expect.noPendingScoreStates)check(`${test.id}: score states`,selection?.scoreBreakdowns?.every(item=>['selected','excluded'].includes(item.selectedOrExcluded))===true);
  if(test.expect.warnings)check(`${test.id}: warnings`,JSON.stringify(result.selection?.warnings??manifest.warnings??[])===JSON.stringify(test.expect.warnings));
  if(test.expect.candidateWarnings)check(`${test.id}: candidate warnings`,JSON.stringify(result.candidateGeneration?.warnings??[])===JSON.stringify(test.expect.candidateWarnings));
  if(test.expect.coverageSelected)check(`${test.id}: coverage selected`,test.expect.coverageSelected.every(entity=>selection?.coverage?.selected?.includes(entity)));
}
class EvalManifestRepository{
  constructor(){this.rows=new Map()}
  async append({workspaceId,manifest}){const key=`${workspaceId}:${manifest.id}`;const existing=this.rows.get(key);if(existing){if(existing.manifestFingerprint!==manifest.manifestFingerprint){const error=new Error('manifest_identity_conflict');error.code='manifest_identity_conflict';throw error}return existing}this.rows.set(key,structuredClone(manifest));return manifest}
  async get({workspaceId,id}){return this.rows.get(`${workspaceId}:${id}`)??null}
  async listByRun({workspaceId,runId}){return [...this.rows.values()].filter(item=>item.workspaceId===workspaceId&&item.runId===runId).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))||a.id.localeCompare(b.id))}
}
const manifestRepo=new EvalManifestRepository();
const manifestRequest={schemaVersion:'1.0.0',id:'ctxreq_eval_manifest',requestId:'ctxreq_eval_manifest',correlationId:'req_eval_manifest_000000',workspaceId:'ws_eval',actorId:'usr_eval',taskId:'task_oaf_012',step:'generate answer',objective:'Persist context manifest evidence',requiredIds:[],requiredEntities:['topic:manifest'],allowedScopes:['workspace-private'],allowedDataClasses:['workspace-private'],allowedTrustClasses:['verified','observed'],tokenBudget:72,now:'2026-06-20T00:00:00.000Z',trustedTimestamp:'2026-06-20T00:00:00.000Z'};
const manifestRecords=[
  {id:'policy_eval_manifest',kind:'policy',workspaceId:'ws_eval',text:'Persist the context manifest before model invocation.',tags:['topic:manifest'],relations:['topic:manifest'],scope:'workspace-private',dataClass:'workspace-private',trustClass:'verified',status:'active',source:'eval',tokens:12,confidence:1,authority:1},
  {id:'decision_eval_manifest',kind:'decision',workspaceId:'ws_eval',text:'Context manifests are immutable and comparable.',tags:['topic:manifest'],relations:['topic:manifest'],scope:'workspace-private',dataClass:'workspace-private',trustClass:'verified',status:'active',source:'eval',tokens:10,confidence:.9,authority:.9},
  {id:'obs_eval_manifest',kind:'observation',workspaceId:'ws_eval',text:'Assembly order keeps governance before evidence.',tags:['topic:manifest'],relations:['topic:manifest'],scope:'workspace-private',dataClass:'workspace-private',trustClass:'observed',status:'active',source:'eval',tokens:10,confidence:.8,authority:.7},
  {id:'obs_eval_leak',kind:'observation',workspaceId:'ws_eval',text:'Excluded text contains /Users/rebel/.env and SELECT * FROM secrets.',tags:['topic:manifest'],relations:['topic:manifest'],scope:'workspace-private',dataClass:'secret',trustClass:'verified',status:'active',source:'eval',tokens:10,confidence:1,authority:1}
];
const manifestResult=await compileAndPersistContext(manifestRequest,manifestRecords,{manifestRepository:manifestRepo,runId:'run_eval_manifest',clock:()=>'2026-06-20T00:00:00.000Z'});
check('persisted-manifest: assembly order',JSON.stringify(manifestResult.manifest.assembly.sections.map(section=>section.id))===JSON.stringify(['governance','decisions','evidence']));
check('persisted-manifest: manifest fingerprint',/^sha256:[a-f0-9]{64}$/.test(manifestResult.manifest.manifestFingerprint)&&verifyContextManifest(manifestResult.manifest).valid);
const changed=structuredClone(manifestResult.manifest);changed.id='ctx_eval_manifest_changed';changed.selected=changed.selected.filter(item=>item.id!=='obs_eval_manifest');changed.assembly.selectedRecordIds=changed.assembly.selectedRecordIds.filter(id=>id!=='obs_eval_manifest');
check('persisted-manifest: comparison',compareContextManifests(manifestResult.manifest,changed).selected.removed.includes('obs_eval_manifest'));
let overflowClosed=false;try{await compileAndPersistContext({...manifestRequest,id:'ctxreq_eval_overflow',requestId:'ctxreq_eval_overflow',tokenBudget:4},manifestRecords,{manifestRepository:manifestRepo,runId:'run_eval_manifest_overflow',clock:()=>'2026-06-20T00:00:00.000Z'})}catch(error){overflowClosed=error.code==='required_context_over_budget'}
check('persisted-manifest: governance overflow',overflowClosed);
check('persisted-manifest: persistence',manifestRepo.rows.size===1&&(await manifestRepo.listByRun({workspaceId:'ws_eval',runId:'run_eval_manifest'})).length===1);
check('persisted-manifest: zero leakage',!JSON.stringify(manifestResult.manifest.excluded).includes('/Users/rebel')&&!JSON.stringify(manifestResult.manifest.excluded).includes('SELECT *'));
check('persisted-manifest: workspace isolation',await manifestRepo.get({workspaceId:'ws_other',id:manifestResult.manifest.id})===null);
const retry=await compileAndPersistContext(manifestRequest,manifestRecords,{manifestRepository:manifestRepo,runId:'run_eval_manifest',clock:()=>'2026-06-20T00:00:00.000Z'});
check('persisted-manifest: retry idempotency',retry.manifest.manifestFingerprint===manifestResult.manifest.manifestFingerprint&&manifestRepo.rows.size===1);
const policyCases=JSON.parse(await readFile('evals/policy/cases.json','utf8'));for(const test of policyCases){const result=evaluatePolicy(test.input);check(`${test.id}: decision`,result.decision===test.expect.decision);check(`${test.id}: reasons`,test.expect.reasons.every(reason=>result.reasons.includes(reason)))}
const memoryCases=JSON.parse(await readFile('evals/memory/cases.json','utf8'));for(const test of memoryCases){const result=proposeMemory(test.input);check(`${test.id}: decision`,result.decision===test.expect.decision);check(`${test.id}: reasons`,test.expect.reasons.every(reason=>result.reasons.includes(reason)))}
console.log(`\nEvaluation result: ${passed} passed, ${failed} failed.`);if(failed)process.exitCode=1;
