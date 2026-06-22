import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeContentPatterns,
  assessContentObservation,
  createCandidateApproval,
  createLocalDraft,
  recordDraftOutcome,
  verifyLocalDraft,
  observationRecordKind
} from '../packages/content-intelligence/src/index.mjs';

test('marks unrelated material ineligible despite high engagement',()=>{
  const result=assessContentObservation({text:'A recipe with no connection to software agents.',metrics:{views:50000,saves:1000},inferred:{pattern:'unrelated'}});
  assert.equal(result.candidateEligible,false);
  assert.equal(result.polarity,'irrelevant');
  assert.equal(result.retrievalPenalty,1);
});

test('preserves anti-patterns as negative context rather than positive evidence',()=>{
  const result=assessContentObservation({text:'Unlimited memory solves everything.',metrics:{views:3000},inferred:{pattern:'absolute claim'}});
  assert.equal(result.candidateEligible,true);
  assert.equal(observationRecordKind(result),'negative-context');
  assert(result.reasonCodes.includes('anti_pattern'));
});

test('rewards specific outcome-backed workflow evidence',()=>{
  const result=assessContentObservation({text:'A six-step checklist showing retries got more saves and cut our debugging time.',metrics:{views:9000,replies:50,saves:300},inferred:{pattern:'reusable artifact'}});
  assert.equal(result.candidateEligible,true);
  assert(result.importance>.65);
  assert(result.outcomeEvidence>=.6);
});

test('pattern analysis separates raw metrics from inference and relative performance',()=>{
  const result=analyzeContentPatterns([
    {
      id:'obs_relative',
      text:'A six-step recovery checklist showing retries got more saves and cut debugging time.',
      collectedAt:'2026-06-20T00:00:00.000Z',
      publishedAt:'2026-06-19T00:00:00.000Z',
      metrics:{views:12000,replies:80,saves:450},
      baselines:{views:4000,replies:20,saves:100},
      inferred:{pattern:'reusable artifact'}
    }
  ],{generatedAt:'2026-06-20T00:00:00.000Z'});

  const analysis=result.observations[0];
  assert.equal(analysis.metrics.raw.views,12000);
  assert.equal(analysis.metrics.relativePerformance.state,'above_baseline');
  assert.equal(analysis.inference.pattern.format,'checklist');
  assert.equal(analysis.inference.lifecycle,'accelerating');
  assert.equal(analysis.inference.proofNeeded.length,0);
  assert.equal(analysis.inference.uncertainty.level,'low');
  assert.equal(analysis.inference.views,undefined);
  assert.equal(result.safeguards.metricsSeparatedFromInference,true);
});

test('pattern analysis reports proof needs and avoids treating baseline-free metrics as truth',()=>{
  const result=analyzeContentPatterns([
    {
      id:'obs_uncertain',
      text:'A broad prediction about agents changing everything soon.',
      collectedAt:'2026-06-20T00:00:00.000Z',
      metrics:{views:90000},
      inferred:{pattern:'generic prediction'}
    }
  ],{generatedAt:'2026-06-20T00:00:00.000Z'});

  const analysis=result.observations[0];
  assert.equal(analysis.metrics.relativePerformance.state,'insufficient_baseline');
  assert(analysis.inference.proofNeeded.includes('creator_or_format_baseline'));
  assert.equal(analysis.inference.uncertainty.level,'high');
  assert(analysis.inference.reasonCodes.includes('raw_metrics_not_comparable'));
});

test('pattern analysis clusters similar sources and flags copying risk without copying source text',()=>{
  const result=analyzeContentPatterns([
    {id:'obs_a',text:'Show the failed tool calls and retries so readers trust the local agent workflow.',collectedAt:'2026-06-20T00:00:00.000Z',metrics:{views:1000,saves:10},baselines:{views:1000,saves:10},inferred:{pattern:'reusable artifact'}},
    {id:'obs_b',text:'Show the failed tool calls and retries so readers trust the local agent workflow.',collectedAt:'2026-06-20T00:01:00.000Z',metrics:{views:1100,saves:12},baselines:{views:1000,saves:10},inferred:{pattern:'reusable artifact'}},
    {id:'obs_c',text:'A permissions checklist helped teams reproduce recovery tests.',collectedAt:'2026-06-20T00:02:00.000Z',metrics:{views:900,saves:9},baselines:{views:1000,saves:10},inferred:{pattern:'reusable artifact'}}
  ],{generatedAt:'2026-06-20T00:02:00.000Z'});

  const highRisk=result.observations.find(item=>item.observationId==='obs_b');
  assert.equal(result.clusters.length>=1,true);
  assert.equal(highRisk.inference.copyingRisk.level,'high');
  assert.equal(highRisk.inference.similarity.maxScore,1);
  assert(!JSON.stringify(result.clusters).includes('failed tool calls and retries'));
});

const manifestRef = {
  id:'ctx_manifest_local',
  manifestFingerprint:`sha256:${'1'.repeat(64)}`,
  assemblyFingerprint:`sha256:${'2'.repeat(64)}`,
  compilerVersion:'1.0.0',
  assemblyPolicyVersion:'1.0.0',
  assemblyPolicyFingerprint:`sha256:${'3'.repeat(64)}`,
  selectedCount:3,
  excludedCount:1
};

const candidate = {
  rank:1,
  angle:'Turn one agent failure into a checklist people can reuse',
  hook:'The polished demo was not the useful part. The recovery checklist was.',
  evidenceIds:['obs_alpha','obs_beta']
};

test('candidate approval is exact and bound to evidence, schema, prompt, and context versions',()=>{
  const approval=createCandidateApproval({
    workspaceId:'ws_local',
    actorId:'usr_creator',
    candidate,
    availableEvidenceIds:['obs_alpha','obs_beta','obs_gamma'],
    contextManifest:manifestRef,
    promptVersion:'content-intelligence.generate-angles.v1',
    outputSchemaName:'content-intelligence.recommendations',
    outputSchemaVersion:'1.0.0',
    provider:'provider:native:model:deterministic',
    model:'deterministic-v1',
    decision:'approved',
    decidedAt:'2026-06-20T00:00:00.000Z',
    expiresAt:'2026-06-20T00:10:00.000Z'
  });

  assert.equal(approval.status,'approved');
  assert.equal(approval.preview.editableText,`${candidate.angle}\n\n${candidate.hook}`);
  assert.equal(approval.binding.contextManifest.manifestFingerprint,manifestRef.manifestFingerprint);
  assert.equal(approval.binding.promptVersion,'content-intelligence.generate-angles.v1');
  assert.equal(approval.binding.outputSchemaVersion,'1.0.0');
  assert.match(approval.operationFingerprint,/^sha256:[a-f0-9]{64}$/);
  assert.equal(approval.sideEffectClass,'local-only');
  assert.equal(approval.publisher.enabled,false);
});

test('candidate approval rejects missing evidence and records non-approved states explicitly',()=>{
  assert.throws(
    ()=>createCandidateApproval({
      workspaceId:'ws_local',
      actorId:'usr_creator',
      candidate:{...candidate,evidenceIds:['obs_missing']},
      availableEvidenceIds:['obs_alpha'],
      contextManifest:manifestRef,
      decision:'approved'
    }),
    /approval evidence is not available/
  );

  const expired=createCandidateApproval({
    workspaceId:'ws_local',
    actorId:'usr_creator',
    candidate,
    availableEvidenceIds:['obs_alpha','obs_beta'],
    contextManifest:manifestRef,
    decision:'approved',
    decidedAt:'2026-06-20T00:11:00.000Z',
    expiresAt:'2026-06-20T00:10:00.000Z'
  });
  assert.equal(expired.status,'expired');

  const cancelled=createCandidateApproval({
    workspaceId:'ws_local',
    actorId:'usr_creator',
    candidate,
    availableEvidenceIds:['obs_alpha','obs_beta'],
    contextManifest:manifestRef,
    decision:'cancelled'
  });
  assert.equal(cancelled.status,'cancelled');
  assert.equal(cancelled.approved,false);
});

test('local drafting verifies citations and rechecks edited similarity without publishing',()=>{
  const approval=createCandidateApproval({
    workspaceId:'ws_local',
    actorId:'usr_creator',
    candidate,
    availableEvidenceIds:['obs_alpha','obs_beta'],
    contextManifest:manifestRef,
    decision:'approved',
    decidedAt:'2026-06-20T00:00:00.000Z',
    expiresAt:'2026-06-20T00:10:00.000Z'
  });
  assert.throws(
    ()=>createLocalDraft({
      approval,
      editedText:'This draft is too late.',
      createdAt:'2026-06-20T00:10:00.000Z'
    }),
    (error)=>error.code==='approval_expired'
  );
  const draft=createLocalDraft({
    approval,
    editedText:'Turn recovery into a reusable checklist.\n\nShow the retry boundary, the denied action, and the evidence IDs before asking anyone to trust the agent.',
    createdAt:'2026-06-20T00:01:00.000Z'
  });
  const verification=verifyLocalDraft({
    draft,
    availableEvidenceIds:['obs_alpha','obs_beta'],
    sourceRecords:[
      {id:'obs_alpha',text:'The recovery checklist was useful because it showed retries and denied actions.'},
      {id:'obs_beta',text:'Readers trusted the local agent after seeing a run trace with evidence IDs.'}
    ],
    patternAnalysis:{
      observations:[
        {observationId:'obs_alpha',inference:{copyingRisk:{level:'low'},similarity:{maxScore:.1}}},
        {observationId:'obs_beta',inference:{copyingRisk:{level:'medium'},similarity:{maxScore:.4}}}
      ]
    }
  });

  assert.equal(draft.publisher.enabled,false);
  assert.equal(draft.publisher.reason,'publisher_disabled');
  assert.equal(verification.valid,true);
  assert.equal(verification.citations.valid,true);
  assert.equal(verification.similarity.copyingRisk.level,'medium');
  assert(!JSON.stringify(verification).includes('recovery checklist was useful'));
});

test('draft outcomes record objective metrics and edit distance without causal claims',()=>{
  const approval=createCandidateApproval({
    workspaceId:'ws_local',
    actorId:'usr_creator',
    candidate,
    availableEvidenceIds:['obs_alpha','obs_beta'],
    contextManifest:manifestRef,
    decision:'approved'
  });
  const draft=createLocalDraft({approval,editedText:'Turn one failure into a checklist people can reuse.\n\nShow retries, denial, and evidence before the final result.'});
  const verification=verifyLocalDraft({draft,availableEvidenceIds:['obs_alpha','obs_beta'],sourceRecords:[],patternAnalysis:{observations:[]}});
  const outcome=recordDraftOutcome({
    draft,
    verification,
    objective:'Find evidence-backed content angles about reliable local agents',
    metric:{name:'creator_judgment',value:'accepted_for_local_review',direction:'positive'},
    qualitative:'Needs final voice pass before any separate publishing workflow.',
    observedAt:'2026-06-20T00:05:00.000Z'
  });

  assert.equal(outcome.objectiveMetric.name,'creator_judgment');
  assert.equal(outcome.causalClaim,'none');
  assert.equal(outcome.editDistance.source,'approval_preview_to_edited_draft');
  assert(outcome.editDistance.distance>0);
  assert(outcome.editDistance.ratio>0);
});
