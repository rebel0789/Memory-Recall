import { readFile } from 'node:fs/promises';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CONTEXT_SELECTION_POLICY,
  compileContext,
  compileAndPersistContext,
  compareContextManifests,
  compileContextFromSources,
  createCandidateSourceRegistry,
  createFixtureRecordReader,
  createNativeExactCandidateSource,
  createNativeLexicalCandidateSource,
  createSelectorExperiment,
  promoteSelectorDefault,
  recordContextUseFeedback,
  resolveSelectorExperimentPolicy,
  summarizeContextUseFeedback,
  verifyContextManifest
} from '../packages/context-compiler/src/index.mjs';
import { createPolicyService } from '../packages/policy/src/index.mjs';
import { canonicalOperationFingerprint, evaluateContextualPolicy, evaluatePolicy } from '../packages/policy/src/index.mjs';
import { proposeMemory } from '../packages/memory-core/src/index.mjs';
import {
  ToolGrantService,
  ToolRegistry,
  createMemoryEffectBoundary,
  loadReviewedToolCatalog,
  stableToolFingerprint
} from '../packages/tool-registry/src/index.mjs';
import { analyzeContentPatterns, completeLocalCreatorWorkflow } from '../packages/content-intelligence/src/index.mjs';
import {
  DurableSQLiteWorkflowRuntime,
  createDurableSmokeWorkflowDefinition,
  createDurableSmokeWorkflowRegistry
} from '../providers/native/workflow-durable-sqlite/src/index.mjs';
import {
  createEvaluationDataset,
  createEvaluationExperiment,
  promoteTraceToEvaluationCase,
  recordEvaluationReport
} from '../packages/evaluation-lab/src/index.mjs';
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
const feedbackOne=recordContextUseFeedback({id:'ctxuse_eval_a',manifest:manifestResult.manifest,runId:'run_eval_manifest',taskId:'task_oaf_018',actorId:'usr_eval',usedRecords:[{recordId:'policy_eval_manifest',evidenceRefs:['claim_eval_manifest'],outcomeRefs:['out_eval_accept']}],outcomeReferences:[{outcomeId:'out_eval_accept',kind:'accepted',observedAt:'2026-06-20T00:01:00.000Z',metric:'task_acceptance',direction:'positive'}],createdAt:'2026-06-20T00:01:00.000Z'});
const feedbackTwo=recordContextUseFeedback({id:'ctxuse_eval_b',manifest:manifestResult.manifest,runId:'run_eval_manifest_retry',taskId:'task_oaf_018',actorId:'usr_eval',usedRecords:[{recordId:'obs_eval_manifest'}],outcomeReferences:[{outcomeId:'out_eval_revision',kind:'needs_revision',observedAt:'2026-06-20T00:02:00.000Z',metric:'task_acceptance',direction:'negative'}],createdAt:'2026-06-20T00:02:00.000Z'});
const feedbackSummary=summarizeContextUseFeedback([feedbackOne,feedbackTwo]);
check('context-feedback: records selected use against manifest',feedbackOne.contextManifest.manifestFingerprint===manifestResult.manifest.manifestFingerprint&&feedbackOne.selectedRecordUse.some(item=>item.recordId==='policy_eval_manifest'&&item.useState==='used'));
check('context-feedback: summary avoids causal overclaim',feedbackSummary.causalClaim==='none'&&feedbackSummary.outcomes.positive===1&&feedbackSummary.outcomes.negative===1);
let rejectedUnselected=false;try{recordContextUseFeedback({manifest:manifestResult.manifest,runId:'run_eval_manifest',usedRecords:[{recordId:'not_selected'}],outcomeReferences:[],createdAt:'2026-06-20T00:00:00.000Z'})}catch(error){rejectedUnselected=error.code==='context_use_unselected_record'}
check('context-feedback: unselected record rejected',rejectedUnselected);
const selectorVariant=structuredClone(CONTEXT_SELECTION_POLICY);
selectorVariant.policyVersion='1.0.1';
selectorVariant.thresholds={...selectorVariant.thresholds,marginalUtility:0.25};
const selectorExperiment=createSelectorExperiment({id:'ctxexp_eval_feedback',workspaceId:'ws_eval',variantPolicy:selectorVariant,evaluationReport:{reportId:'eval_selector_feedback',passed:true,evaluationCount:5,regressionCount:0,metrics:{requiredRecall:1,contextUseFeedbackCount:2},rollbackPlan:'Restore baseline selector fingerprint.'},createdAt:'2026-06-20T00:00:00.000Z'});
check('context-feedback: selector experiment is reversible',selectorExperiment.reversible===true&&resolveSelectorExperimentPolicy(selectorExperiment,{arm:'rollback'}).policyFingerprint===selectorExperiment.baseline.policyFingerprint);
let blockedDefault=false;try{promoteSelectorDefault({candidatePolicy:selectorVariant,evaluationReport:{reportId:'eval_selector_bad',passed:false}})}catch(error){blockedDefault=error.message==='selector_default_requires_passing_evaluation'}
check('context-feedback: selector default requires evaluation',blockedDefault);
const defaultPlan=promoteSelectorDefault({candidatePolicy:selectorVariant,evaluationReport:{reportId:'eval_selector_default',passed:true,evaluationCount:5,regressionCount:0,metrics:{requiredRecall:1,contextUseFeedbackCount:2},rollbackPlan:'Restore baseline selector fingerprint.'},createdAt:'2026-06-20T00:00:00.000Z'});
check('context-feedback: selector default promotion remains review-only',defaultPlan.status==='review_required'&&defaultPlan.defaultChanged===false&&defaultPlan.requiresHumanApproval===true);
const evalLabDataset=createEvaluationDataset({id:'evalds_context_regression',suite:'deterministic-regression',version:'1.0.0',owner:'agent:evaluator',sourceRefs:['evals/context-selection/cases.json'],createdAt:'2026-06-20T00:00:00.000Z',cases:[{id:'evalcase_required_recall',kind:'context-selection',inputFingerprint:`sha256:${'1'.repeat(64)}`,assertions:['required_recall','distractor_exclusion'],tags:['context','deterministic']}]});
const evalLabShadowDataset=createEvaluationDataset({id:'evalds_model_quality_shadow',suite:'model-quality-shadow',version:'1.0.0',owner:'agent:evaluator',sourceRefs:['evals/lab/datasets/model-quality-shadow.v1.json'],createdAt:'2026-06-20T00:00:00.000Z',cases:[{id:'evalcase_model_quality_shadow',kind:'model-quality',inputFingerprint:`sha256:${'2'.repeat(64)}`,assertions:['schema_valid','evidence_use'],tags:['model-quality','shadow']}]});
check('evaluation-lab: separates deterministic and model-quality suites',evalLabDataset.mergeGate===true&&evalLabShadowDataset.mergeGate===false&&/^sha256:[a-f0-9]{64}$/.test(evalLabDataset.datasetFingerprint));
const evalLabExperiment=createEvaluationExperiment({id:'evalexp_selector_policy_v1',dataset:evalLabDataset,subject:{kind:'selector',id:'context.selection',version:'1.0.0',fingerprint:`sha256:${'3'.repeat(64)}`},baseline:{id:'selector-baseline',version:'1.0.0',fingerprint:`sha256:${'4'.repeat(64)}`},candidate:{id:'selector-candidate',version:'1.0.1',fingerprint:`sha256:${'5'.repeat(64)}`},mode:'deterministic',createdAt:'2026-06-20T00:01:00.000Z'});
const evalLabReport=recordEvaluationReport({id:'evalrep_selector_policy_v1',experiment:evalLabExperiment,commitSha:'7a7630903d27137a425536b1eee6a40d8b41fd1c',runner:{name:'scripts/run-evals.mjs',version:'1.0.0'},versions:{compiler:'1.0.0',prompt:'none',model:'deterministic-v1',policy:'1.0.0'},results:[{caseId:'evalcase_required_recall',status:'passed',metrics:{requiredRecall:1}}],generatedAt:'2026-06-20T00:02:00.000Z'});
check('evaluation-lab: deterministic reports are merge gated',evalLabReport.gateDecision==='pass'&&evalLabReport.mergeGate===true&&evalLabReport.counts.failed===0);
const evalLabShadowExperiment=createEvaluationExperiment({id:'evalexp_shadow_quality',dataset:evalLabShadowDataset,subject:{kind:'model',id:'provider:native:model:deterministic',version:'1.0.0',fingerprint:`sha256:${'6'.repeat(64)}`},baseline:{id:'deterministic-v1',version:'1.0.0',fingerprint:`sha256:${'7'.repeat(64)}`},candidate:{id:'explicit-local-quality-run',version:'manual',fingerprint:`sha256:${'8'.repeat(64)}`},mode:'model-quality',createdAt:'2026-06-20T00:01:00.000Z'});
const evalLabShadowReport=recordEvaluationReport({id:'evalrep_shadow_quality',experiment:evalLabShadowExperiment,commitSha:'7a7630903d27137a425536b1eee6a40d8b41fd1c',runner:{name:'manual-shadow',version:'0.0.0'},versions:{compiler:'1.0.0',prompt:'content-intelligence.generate-angles.v1',model:'explicit-local-only',policy:'1.0.0'},results:[{caseId:'evalcase_model_quality_shadow',status:'failed',metrics:{calibration:0.4}}],generatedAt:'2026-06-20T00:02:00.000Z'});
check('evaluation-lab: model-quality reports remain shadow only',evalLabShadowReport.gateDecision==='shadow_failed_non_blocking'&&evalLabShadowReport.mergeGate===false);
const evalLabPromoted=promoteTraceToEvaluationCase({id:'evaltp_failed_model_trace',datasetId:'evalds_context_regression',caseId:'evalcase_promoted_failed_model_trace',sourceRunId:'run_failed_trace',createdAt:'2026-06-20T00:03:00.000Z',review:{reviewedBy:'usr_eval_reviewer',approved:true,dataClasses:['workspace-private'],reason:'Minimal reproduction after private body redaction.'},trace:{events:[{type:'model.requested',occurredAt:'2026-06-20T00:00:00.000Z',payload:{prompt:'private prompt',contextBody:'private source body',contextManifestId:'ctx_safe',output:'raw model output'}}],spans:[{name:'oaf.model.generate',attributes:{localPath:'/Users/rebel/project/file.txt','model.provider':'provider:native:model:deterministic'}}]}});
const evalLabPromotedText=JSON.stringify(evalLabPromoted);
check('evaluation-lab: trace promotion is sanitized',evalLabPromoted.case.inputFingerprint===evalLabPromoted.sanitizedTrace.traceFingerprint&&!evalLabPromotedText.includes('private prompt')&&!evalLabPromotedText.includes('private source body')&&!evalLabPromotedText.includes('raw model output')&&!evalLabPromotedText.includes('/Users/rebel'));
const patternAnalysis=analyzeContentPatterns([
  {id:'obs_eval_pattern_a',text:'A six-step recovery checklist showing retries got more saves and cut debugging time.',collectedAt:'2026-06-20T00:00:00.000Z',publishedAt:'2026-06-19T00:00:00.000Z',metrics:{views:12000,replies:80,saves:450},baselines:{views:4000,replies:20,saves:100},inferred:{pattern:'reusable artifact'}},
  {id:'obs_eval_pattern_b',text:'A broad prediction about agents changing everything soon.',collectedAt:'2026-06-20T00:00:00.000Z',metrics:{views:90000},inferred:{pattern:'generic prediction'}},
  {id:'obs_eval_pattern_c',text:'Show the failed tool calls and retries so readers trust the local agent workflow.',collectedAt:'2026-06-20T00:01:00.000Z',metrics:{views:1000,saves:10},baselines:{views:1000,saves:10},inferred:{pattern:'reusable artifact'}},
  {id:'obs_eval_pattern_d',text:'Show the failed tool calls and retries so readers trust the local agent workflow.',collectedAt:'2026-06-20T00:02:00.000Z',metrics:{views:1100,saves:12},baselines:{views:1000,saves:10},inferred:{pattern:'reusable artifact'}}
],{generatedAt:'2026-06-20T00:02:00.000Z'});
const patternA=patternAnalysis.observations.find(item=>item.observationId==='obs_eval_pattern_a');
const patternB=patternAnalysis.observations.find(item=>item.observationId==='obs_eval_pattern_b');
const patternD=patternAnalysis.observations.find(item=>item.observationId==='obs_eval_pattern_d');
check('content-patterns: metrics separate from inference',patternAnalysis.safeguards.metricsSeparatedFromInference===true&&patternA.metrics.raw.views===12000&&patternA.inference.views===undefined);
check('content-patterns: relative performance and lifecycle',patternA.metrics.relativePerformance.state==='above_baseline'&&patternA.inference.lifecycle==='accelerating');
check('content-patterns: proof needed without comparable baseline',patternB.metrics.relativePerformance.state==='insufficient_baseline'&&patternB.inference.proofNeeded.includes('creator_or_format_baseline')&&patternB.inference.uncertainty.level==='high');
check('content-patterns: copying risk from similarity without cluster text leakage',patternD.inference.copyingRisk.level==='high'&&patternD.inference.similarity.maxScore===1&&!JSON.stringify(patternAnalysis.clusters).includes('failed tool calls'));
const localDraftCompletion=completeLocalCreatorWorkflow({
  workspaceId:'ws_eval',
  actorId:'usr_eval_creator',
  objective:'Find evidence-backed content angles about reliable local agents',
  candidate:{rank:1,angle:'Turn one agent failure into a checklist people can reuse',hook:'Show the recovery boundary before asking for trust.',evidenceIds:['obs_eval_pattern_a','obs_eval_pattern_b']},
  availableEvidenceIds:['obs_eval_pattern_a','obs_eval_pattern_b'],
  contextManifest:{id:'ctx_eval_local_draft',manifestFingerprint:`sha256:${'8'.repeat(64)}`,assemblyFingerprint:`sha256:${'9'.repeat(64)}`,compilerVersion:'1.0.0',assemblyPolicyVersion:'1.0.0',assemblyPolicyFingerprint:`sha256:${'a'.repeat(64)}`,selectedCount:2,excludedCount:0},
  modelResult:{provider:'provider:native:model:deterministic',model:'deterministic-v1',promptVersion:'content-intelligence.generate-angles.v1',outputSchemaName:'content-intelligence.recommendations',outputSchemaVersion:'1.0.0'},
  editedText:'Turn one failure into a reusable checklist.\n\nShow retries, denied actions, and evidence IDs before asking readers to trust the local agent.',
  sourceRecords:[
    {id:'obs_eval_pattern_a',text:'A six-step recovery checklist showing retries got more saves and cut debugging time.'},
    {id:'obs_eval_pattern_b',text:'A broad prediction about agents changing everything soon.'}
  ],
  patternAnalysis,
  now:'2026-06-20T00:03:00.000Z',
  expiresAt:'2026-06-20T00:10:00.000Z'
});
check('content-local-draft: approval bound to context manifest',localDraftCompletion.approval.status==='approved'&&localDraftCompletion.approval.binding.contextManifest.manifestFingerprint===`sha256:${'8'.repeat(64)}`&&/^sha256:[a-f0-9]{64}$/.test(localDraftCompletion.approval.operationFingerprint));
check('content-local-draft: draft verified without publisher',localDraftCompletion.verification.valid===true&&localDraftCompletion.draft.publisher.enabled===false&&localDraftCompletion.safeguards.externalWrites===false);
check('content-local-draft: outcome records edit distance without causality',localDraftCompletion.outcome.editDistance.distance>0&&localDraftCompletion.outcome.causalClaim==='none'&&localDraftCompletion.outcome.objectiveMetric.name==='creator_judgment');
const durableDir=await mkdtemp(path.join(os.tmpdir(),'oaf-eval-durable-'));
try{
  let evalNow=Date.parse('2026-06-20T00:00:00.000Z');
  const durableClock=()=>new Date(evalNow).toISOString();
  const durable=new DurableSQLiteWorkflowRuntime({dataRoot:durableDir,registry:createDurableSmokeWorkflowRegistry(),clock:durableClock,leaseMs:10});
  const durableDefinition=createDurableSmokeWorkflowDefinition();
  await durable.registerWorkflow(durableDefinition);
  await durable.start({workspaceId:'ws_eval',workflowId:durableDefinition.id,workflowVersion:durableDefinition.version,runId:'run_eval_durable',input:{objective:'evaluate durable recovery'},idempotencyKey:'eval-durable-start'});
  await durable.tick({workerId:'worker_eval_a'});
  await durable.tick({workerId:'worker_eval_a'});
  let durableRun=await durable.get({workspaceId:'ws_eval',runId:'run_eval_durable'});
  check('durable-workflow: retry recovery',durableRun.status==='waiting_retry'&&durableRun.steps.retry.attempt===1);
  durable.close();
  const recovered=new DurableSQLiteWorkflowRuntime({dataRoot:durableDir,registry:createDurableSmokeWorkflowRegistry(),clock:durableClock,leaseMs:10});
  evalNow+=100;
  await recovered.tick({workerId:'worker_eval_b'});
  await recovered.tick({workerId:'worker_eval_b'});
  durableRun=await recovered.get({workspaceId:'ws_eval',runId:'run_eval_durable'});
  check('durable-workflow: process recovery',durableRun.status==='waiting_timer');
  evalNow+=1000;
  await recovered.tick({workerId:'worker_eval_b'});
  durableRun=await recovered.get({workspaceId:'ws_eval',runId:'run_eval_durable'});
  check('durable-workflow: timer recovery',durableRun.status==='waiting_approval');
  const approvalId=durableRun.steps.approval.approvalId;
  await recovered.resolveApproval({workspaceId:'ws_eval',runId:'run_eval_durable',approvalId,actorId:'usr_eval',decision:'approved',operationFingerprint:'sha256:approval-smoke'});
  await recovered.tick({workerId:'worker_eval_b'});
  await recovered.tick({workerId:'worker_eval_b'});
  await recovered.tick({workerId:'worker_eval_b'});
  durableRun=await recovered.get({workspaceId:'ws_eval',runId:'run_eval_durable'});
  const durableHistory=await recovered.history({workspaceId:'ws_eval',runId:'run_eval_durable'});
  check('durable-workflow: approval-wait recovery',durableHistory.events.some(event=>event.type==='approval.resolved')&&durableRun.status==='completed');
  check('durable-workflow: no completed-step repetition',durableHistory.events.filter(event=>event.type==='step.completed'&&event.payload.stepId==='effect').length===1);
  check('durable-workflow: idempotent effect count',durableRun.output.effect.effectCount===1);
  check('durable-workflow: monotonic event history',JSON.stringify(durableHistory.events.map(event=>event.sequence))===JSON.stringify([...durableHistory.events.keys()]));
  check('durable-workflow: workspace isolation',await recovered.get({workspaceId:'ws_other',runId:'run_eval_durable'})===null);
  let conflictClosed=false;try{await recovered.registerWorkflow({...durableDefinition,description:'changed after run'})}catch(error){conflictClosed=error.code==='workflow_version_fingerprint_conflict'}
  check('durable-workflow: version-fingerprint conflict',conflictClosed);
  check('durable-workflow: zero secret/path leakage',!JSON.stringify(durableHistory.events).includes('/Users/')&&!JSON.stringify(durableHistory.events).includes('SELECT '));
  await recovered.start({workspaceId:'ws_eval',workflowId:durableDefinition.id,workflowVersion:durableDefinition.version,runId:'run_eval_cancel',input:{objective:'cancel eval'}});
  await recovered.cancel({workspaceId:'ws_eval',runId:'run_eval_cancel',reason:'operator stop'});
  check('durable-workflow: cancellation persistence',(await recovered.get({workspaceId:'ws_eval',runId:'run_eval_cancel'})).status==='cancelled');
  recovered.close();
}finally{
  await rm(durableDir,{recursive:true,force:true});
}
const toolCatalog=await loadReviewedToolCatalog({catalogPath:'tools/catalog.json',manifestRoot:process.cwd()});
check('bounded-tools: reviewed checksum-pinned manifests load',toolCatalog.tools.length===3&&toolCatalog.tools.every(tool=>tool.entry.reviewStatus==='reviewed'&&/^sha256:[a-f0-9]{64}$/.test(tool.manifestFingerprint)));
const toolTrustedContext={principal:{userId:'usr_tool_eval',principalType:'agent',authenticationMethod:'session',status:'active',agentRole:'agent:security-auditor'},membership:{workspaceId:'ws_tool_eval',role:'builder',status:'active'},environment:{deploymentProfile:'local-dev',locality:'local-only',interactive:true,externalWritesEnabled:false}};
const toolRequestBase={schemaVersion:'1.0.0',correlationId:'req_tool-eval-000000',workspaceId:'ws_tool_eval',runId:'run_tool_eval',stepId:'step_tool_eval',actorId:'usr_tool_eval',trustedContext:toolTrustedContext,toolVersion:'1.0.0',dataClass:'workspace-private',trustedTimestamp:'2026-06-20T00:00:00.000Z'};
let forgedHandlerCalled=false;
const forgedRegistry=ToolRegistry.createForTests({tools:['tool:fixture-pure'],handlers:{'handler:pure:echo@1.0.0':async()=>{forgedHandlerCalled=true;return{echoed:'forged'}}},clock:()=>'2026-06-20T00:00:00.000Z'});
const forged=await forgedRegistry.execute({...toolRequestBase,requestId:'toolreq_eval_forged_role',toolId:'tool:fixture-pure',operation:'echo',input:{value:'forged-role'},role:'owner'});
check('bounded-tools: caller role cannot grant authority',forged.status==='denied'&&forged.error.code==='tool_request_invalid'&&!forgedHandlerCalled);
let deniedHandlerCalled=false;
const deniedRegistry=ToolRegistry.createForTests({tools:['tool:fixture-pure'],handlers:{'handler:pure:echo@1.0.0':async()=>{deniedHandlerCalled=true;return{echoed:'denied'}}},clock:()=>'2026-06-20T00:00:00.000Z'});
const denied=await deniedRegistry.execute({...toolRequestBase,requestId:'toolreq_eval_denied',trustedContext:{...toolTrustedContext,principal:{...toolTrustedContext.principal,authenticationMethod:'bearer',tokenScopes:['run.read'],tokenWorkspaceIds:['ws_tool_eval']}},toolId:'tool:fixture-pure',operation:'echo',input:{value:'denied-input'}});
check('bounded-tools: denied invocation never executes',denied.status==='denied'&&denied.error.code==='tool_policy_denied'&&!deniedHandlerCalled&&denied.grantId===null);
let grantNow=Date.parse('2026-06-20T00:00:00.000Z');
const grantBinding={actorId:'usr_tool_eval',workspaceId:'ws_tool_eval',runId:'run_tool_eval',stepId:'step_tool_eval',toolId:'tool:fixture-pure',toolVersion:'1.0.0',manifestFingerprint:`sha256:${'a'.repeat(64)}`,operation:'echo',inputFingerprint:`sha256:${'b'.repeat(64)}`,effectiveCapabilityFingerprint:`sha256:${'c'.repeat(64)}`,policyDecisionId:'poldet_eval_grant',policyVersion:'1.0.0',policyFingerprint:`sha256:${'d'.repeat(64)}`,operationFingerprint:`sha256:${'e'.repeat(64)}`,approvalFingerprint:null,idempotencyFingerprint:null};
const grantService=new ToolGrantService({clock:()=>new Date(grantNow).toISOString(),randomBytes:(size)=>Buffer.alloc(size,0x17),grantIdFactory:()=>`grant_eval_${grantNow}`});
const oneUseToken=grantService.issue({binding:grantBinding,ttlMs:1000}).token;
check('bounded-tools: one-use grant enforcement',grantService.consume(oneUseToken,grantBinding).status==='consumed'&&grantService.consume(oneUseToken,grantBinding).code==='tool_grant_consumed');
const expiringToken=grantService.issue({binding:grantBinding,ttlMs:1000}).token;
grantNow+=1001;
check('bounded-tools: grant expiry',grantService.consume(expiringToken,grantBinding).code==='tool_grant_expired');
grantNow+=1;
const bindingToken=grantService.issue({binding:grantBinding,ttlMs:1000}).token;
check('bounded-tools: grant binding to exact operation',grantService.consume(bindingToken,{...grantBinding,inputFingerprint:stableToolFingerprint({changed:true})}).code==='tool_grant_binding_mismatch');
const toolWorkspace=await mkdtemp(path.join(os.tmpdir(),'oaf-eval-tool-workspace-'));
try{
  await mkdir(path.join(toolWorkspace,'docs'),{recursive:true});
  await writeFile(path.join(toolWorkspace,'docs','input.txt'),'tool eval input');
  const fsRegistry=ToolRegistry.createForTests({tools:['tool:filesystem-read','tool:workspace-write'],workspaceRoot:toolWorkspace,clock:()=>'2026-06-20T00:00:00.000Z'});
  const fsDenied=await fsRegistry.execute({...toolRequestBase,requestId:'toolreq_eval_fs_denied',toolId:'tool:filesystem-read',operation:'readFile',input:{path:'../secret.txt'}});
  check('bounded-tools: filesystem workspace isolation',fsDenied.status==='failed'&&fsDenied.error.code==='tool_filesystem_denied');
  const effects=createMemoryEffectBoundary();
  const fsWrite=await fsRegistry.execute({...toolRequestBase,requestId:'toolreq_eval_write',toolId:'tool:workspace-write',operation:'writeFile',input:{path:'docs/output.txt',content:'tool eval write'},idempotencyKey:'idem_eval_tool_write',effectBoundary:effects});
  const fsWriteRetry=await fsRegistry.execute({...toolRequestBase,requestId:'toolreq_eval_write_retry',toolId:'tool:workspace-write',operation:'writeFile',input:{path:'docs/output.txt',content:'tool eval write'},idempotencyKey:'idem_eval_tool_write',effectBoundary:effects});
  check('bounded-tools: idempotent write effect count of one',fsWrite.status==='completed'&&fsWriteRetry.output?.idempotent===true&&effects.count()===1);
}finally{
  await rm(toolWorkspace,{recursive:true,force:true});
}
const egressRegistry=ToolRegistry.createForTests({tools:['tool:loopback-read'],loopbackPort:4310,clock:()=>'2026-06-20T00:00:00.000Z'});
const externalEgress=await egressRegistry.execute({...toolRequestBase,requestId:'toolreq_eval_egress',toolId:'tool:loopback-read',operation:'fetchText',input:{url:'https://example.com/',method:'GET'}});
check('bounded-tools: external egress denial',externalEgress.status==='failed'&&externalEgress.error.code==='tool_network_denied');
const secretEvents=[];
const secretRegistry=ToolRegistry.createForTests({tools:['tool:secret-fixture'],eventSink:async(event)=>secretEvents.push(event),secretResolver:{resolve:async(reference)=>reference==='secret:fixture.read'?'eval-secret-value':null},clock:()=>'2026-06-20T00:00:00.000Z'});
const secretResult=await secretRegistry.execute({...toolRequestBase,requestId:'toolreq_eval_secret',toolId:'tool:secret-fixture',operation:'hashSecret',input:{secretReferences:['secret:fixture.read']}});
check('bounded-tools: secret non-leakage',secretResult.status==='completed'&&!JSON.stringify(secretResult).includes('eval-secret-value')&&!JSON.stringify(secretEvents).includes('eval-secret-value'));
const slowRegistry=ToolRegistry.createForTests({tools:['tool:fixture-pure'],handlers:{'handler:pure:echo@1.0.0':async()=>new Promise(resolve=>setTimeout(()=>resolve({echoed:'late'}),50))},clock:()=>'2026-06-20T00:00:00.000Z'});
const timeoutResult=await slowRegistry.execute({...toolRequestBase,requestId:'toolreq_eval_timeout',toolId:'tool:fixture-pure',operation:'echo',input:{value:'slow'},timeoutMs:5});
const cancelController=new AbortController();
cancelController.abort();
const cancelResult=await slowRegistry.execute({...toolRequestBase,requestId:'toolreq_eval_cancel',toolId:'tool:fixture-pure',operation:'echo',input:{value:'cancelled'},signal:cancelController.signal});
check('bounded-tools: timeout and cancellation',timeoutResult.error.code==='tool_timeout'&&cancelResult.error.code==='tool_cancelled');
const largeOutputRegistry=ToolRegistry.createForTests({tools:['tool:fixture-pure'],handlers:{'handler:pure:echo@1.0.0':async()=>({echoed:'x'.repeat(80)})},clock:()=>'2026-06-20T00:00:00.000Z'});
const largeOutput=await largeOutputRegistry.execute({...toolRequestBase,requestId:'toolreq_eval_output_limit',toolId:'tool:fixture-pure',operation:'echo',input:{value:'limit'},outputLimitBytes:20});
check('bounded-tools: output bound enforcement',largeOutput.status==='failed'&&largeOutput.error.code==='tool_output_too_large');
const approvalPolicyBase={schemaVersion:'1.0.0',requestId:'polreq_eval_tool_approval',correlationId:'req_tool-eval-approval-000000',operationId:'tool:tool:eval-consequential:publish',principal:toolTrustedContext.principal,workspaceId:'ws_tool_eval',membership:toolTrustedContext.membership,action:'tool.invoke',resource:{type:'tool',id:'tool:eval-consequential',workspaceId:'ws_tool_eval',dataClass:'workspace-private'},environment:toolTrustedContext.environment,capabilityRequest:{toolId:'tool:eval-consequential',operation:'publish',sideEffectClass:'consequential-write',filesystem:{read:[],write:[]},network:[],secretReferences:[],dataClasses:['workspace-private'],sandbox:'pure-local',limits:{runtimeMs:1000,inputBytes:1000,outputBytes:1000,costUnits:0}},trustedToolManifest:{id:'tool:eval-consequential',riskClass:'consequential-write',operations:{publish:{sideEffectClass:'consequential-write',filesystem:{read:[],write:[]},network:[],secretReferences:[],dataClasses:['workspace-private'],sandbox:'pure-local',limits:{runtimeMs:1000,inputBytes:1000,outputBytes:1000,costUnits:0}}}},idempotencyKey:'idem_eval_approval',trustedTimestamp:'2026-06-20T00:00:00.000Z',payloadFingerprint:stableToolFingerprint({payload:'approval'})};
const approvalFingerprint=canonicalOperationFingerprint(approvalPolicyBase);
const approvedPolicy=evaluateContextualPolicy({...approvalPolicyBase,approvalContext:{approvalId:'apr_eval_tool',operationFingerprint:approvalFingerprint,workspaceId:'ws_tool_eval',actorId:'usr_tool_eval',status:'active',policyVersion:'1.0.0',expiresAt:'2026-06-20T00:01:00.000Z'}});
const badApprovalPolicy=evaluateContextualPolicy({...approvalPolicyBase,approvalContext:{approvalId:'apr_eval_tool_bad',operationFingerprint:`sha256:${'0'.repeat(64)}`,workspaceId:'ws_tool_eval',actorId:'usr_tool_eval',status:'active',policyVersion:'1.0.0',expiresAt:'2026-06-20T00:01:00.000Z'}});
check('bounded-tools: exact approval binding',approvedPolicy.outcome==='allow'&&badApprovalPolicy.reasonCodes.includes('approval_scope_mismatch'));
const externalWritePolicy=evaluateContextualPolicy({...approvalPolicyBase,requestId:'polreq_eval_external_write',capabilityRequest:{...approvalPolicyBase.capabilityRequest,sideEffectClass:'reversible-write',operation:'webhook',network:[{protocol:'https',host:'example.com',port:443,methods:['POST'],consequence:'write',locality:'external'}]},trustedToolManifest:{id:'tool:eval-external',riskClass:'reversible-write',operations:{webhook:{sideEffectClass:'reversible-write',filesystem:{read:[],write:[]},network:[{protocol:'https',host:'example.com',port:443,methods:['POST'],consequence:'write',locality:'external'}],secretReferences:[],dataClasses:['workspace-private'],sandbox:'pure-local',limits:{runtimeMs:1000,inputBytes:1000,outputBytes:1000,costUnits:0}}}},approvalContext:null});
check('bounded-tools: external-write kill switch',externalWritePolicy.outcome==='deny'&&externalWritePolicy.reasonCodes.includes('external_writes_disabled'));
const retryEvents=[];
const retryWorkspace=await mkdtemp(path.join(os.tmpdir(),'oaf-eval-tool-retry-'));
const retryRegistry=ToolRegistry.createForTests({tools:['tool:workspace-write'],eventSink:async(event)=>retryEvents.push(event),workspaceRoot:retryWorkspace,clock:()=>'2026-06-20T00:00:00.000Z'});
try{
  const retryEffects=createMemoryEffectBoundary();
  const retryOne=await retryRegistry.execute({...toolRequestBase,requestId:'toolreq_eval_retry_one',toolId:'tool:workspace-write',operation:'writeFile',input:{path:'out/result.txt',content:'retry output'},idempotencyKey:'idem_eval_retry',effectBoundary:retryEffects});
  const retryTwo=await retryRegistry.execute({...toolRequestBase,requestId:'toolreq_eval_retry_two',toolId:'tool:workspace-write',operation:'writeFile',input:{path:'out/result.txt',content:'retry output'},idempotencyKey:'idem_eval_retry',effectBoundary:retryEffects});
  check('bounded-tools: fresh grant after durable retry/restart',retryOne.status==='completed'&&retryTwo.status==='completed'&&retryOne.grantId!==retryTwo.grantId&&retryEffects.count()===1);
  const safeEventText=JSON.stringify(retryEvents);
  check('bounded-tools: zero raw grant/input/output/path leakage in events',!safeEventText.includes('retry output')&&!safeEventText.includes('out/result.txt')&&!/grant_[A-Za-z0-9._:-]+\.[a-f0-9]{64}/.test(safeEventText));
}finally{
  await rm(retryWorkspace,{recursive:true,force:true});
}
const policyCases=JSON.parse(await readFile('evals/policy/cases.json','utf8'));for(const test of policyCases){const result=evaluatePolicy(test.input);check(`${test.id}: decision`,result.decision===test.expect.decision);check(`${test.id}: reasons`,test.expect.reasons.every(reason=>result.reasons.includes(reason)))}
const memoryCases=JSON.parse(await readFile('evals/memory/cases.json','utf8'));for(const test of memoryCases){const result=proposeMemory(test.input);check(`${test.id}: decision`,result.decision===test.expect.decision);check(`${test.id}: reasons`,test.expect.reasons.every(reason=>result.reasons.includes(reason)))}
console.log(`\nEvaluation result: ${passed} passed, ${failed} failed.`);if(failed)process.exitCode=1;
