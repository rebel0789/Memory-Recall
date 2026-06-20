import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { compileAndPersistContext } from '../../packages/context-compiler/src/index.mjs';
import { modelFromEnv } from '../../packages/model-gateway/src/index.mjs';
import { executeSteps } from '../../packages/workflow-runtime/src/index.mjs';
import { prefixedId } from '../../packages/protocol/src/index.mjs';
import { ingestResearchSources, normalizeObservation, validateClaimCitations } from '../../packages/evidence/src/index.mjs';
import { analyzeContentPatterns, assessContentObservation, observationRecordKind } from '../../packages/content-intelligence/src/index.mjs';
import { FilesystemContextManifestRepository } from '../../providers/native/context-manifest-local/src/index.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const fixturePath=path.resolve(here,'../../examples/content-intelligence/fixtures/observations.json');

const recommendationSchema = {
  type: 'array',
  minItems: 3,
  maxItems: 3,
  items: {
    type: 'object',
    additionalProperties: true,
    required: ['rank', 'angle', 'hook', 'evidenceIds'],
    properties: {
      rank: { type: 'integer', minimum: 1 },
      angle: { type: 'string', minLength: 1 },
      hook: { type: 'string', minLength: 1 },
      evidenceIds: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', minLength: 1 }
      }
    }
  }
};

function promptFromManifest({ objective, manifest }) {
  const sections = (manifest.assembly?.sections ?? []).map((section) => {
    const records = section.items.map((item) => `- [${item.id}] ${item.text}`).join('\n');
    return `## ${section.id}\n${records}`;
  }).join('\n\n');
  return [
    `Objective: ${objective}`,
    'Use only the persisted context manifest assembly below.',
    `Context manifest: ${manifest.id}`,
    sections
  ].join('\n\n');
}

function collectedObservations(collectOutput) {
  return Array.isArray(collectOutput) ? collectOutput : collectOutput.observations;
}

function analysisRecords({ analysis, workspaceId }) {
  return analysis.observations.map((item) => ({
    id:`analysis:${item.observationId}`,
    workspaceId,
    kind:'analysis',
    text:[
      `Pattern ${item.inference.pattern.label}`,
      `format ${item.inference.pattern.format}`,
      `lifecycle ${item.inference.lifecycle}`,
      `relative ${item.metrics.relativePerformance.state}`,
      `copying risk ${item.inference.copyingRisk.level}`,
      `uncertainty ${item.inference.uncertainty.level}`,
      `proof ${item.inference.proofNeeded.length?item.inference.proofNeeded.join(','):'sufficient'}`
    ].join('; '),
    scope:'workspace-private',
    status:'active',
    observedAt:analysis.generatedAt,
    updatedAt:analysis.generatedAt,
    source:`analysis:${item.observationId}`,
    confidence:item.inference.uncertainty.level==='low'? .82:(item.inference.uncertainty.level==='medium'? .62:.42),
    authority:.58,
    tags:[item.inference.pattern.format,`lifecycle:${item.inference.lifecycle}`,`copying-risk:${item.inference.copyingRisk.level}`],
    relations:[item.observationId,item.inference.clusterId],
    metadata:{
      observationId:item.observationId,
      clusterId:item.inference.clusterId,
      relativePerformance:item.metrics.relativePerformance.state,
      lifecycle:item.inference.lifecycle,
      proofNeeded:item.inference.proofNeeded,
      uncertainty:item.inference.uncertainty,
      copyingRisk:item.inference.copyingRisk,
      similarity:item.inference.similarity
    }
  }));
}

export async function runContentIntelligence({emit=async()=>{},env=process.env,objective='Find evidence-backed content angles about reliable local agents',workspaceId='ws_local',actorId='agent:researcher',manifestRepository=null,sources=null}={}) {
  const runId=prefixedId('run');
  const contextManifestRepository=manifestRepository??new FilesystemContextManifestRepository({root:path.join(env.OAF_DATA_DIR??'.local','context-manifests')});
  const steps=[
    {
      id:'collect',
      kind:'deterministic',
      timeoutMs:5000,
      retry:{maxAttempts:1},
      actorId,
      run:async()=>sources
        ? ingestResearchSources({workspaceId,collectedAt:'2026-06-19T10:00:00.000Z',capturedAt:'2026-06-19T10:00:00.000Z',sources})
        : JSON.parse(await readFile(fixturePath,'utf8')),
      summarize:result=>Array.isArray(result)
        ? {observations:result.length,source:'synthetic-fixture'}
        : {observations:result.observations.length,snapshots:result.snapshots.length,duplicates:result.duplicates.length,failures:result.failures.length,source:'native-ingestion'}
    },
    {id:'normalize',kind:'deterministic',timeoutMs:5000,retry:{maxAttempts:1},actorId,run:async({outputs})=>collectedObservations(outputs.collect).map(item=>{const obs=normalizeObservation(item);const retrieval=assessContentObservation(item);return {id:obs.id,workspaceId,kind:observationRecordKind(retrieval),text:obs.text,scope:'workspace-private',status:'active',observedAt:obs.collectedAt,updatedAt:obs.collectedAt,source:obs.source,confidence:.72,authority:.55,tags:[obs.inferred.pattern,obs.platform],relations:retrieval.candidateEligible?[`creator:${obs.creator}`,'topic:agent-systems']:[`creator:${obs.creator}`],metadata:{metrics:item.metrics,observed:obs.observed,inferred:obs.inferred,retrieval,sourceSnapshotId:obs.sourceSnapshotId}}}),summarize:rows=>({normalized:rows.length,eligible:rows.filter(row=>row.metadata.retrieval.candidateEligible).length,antiPatterns:rows.filter(row=>row.kind==='negative-context').length})},
    {id:'analyze-patterns',kind:'deterministic',timeoutMs:5000,retry:{maxAttempts:1},actorId,run:async({outputs})=>{const analysis=analyzeContentPatterns(collectedObservations(outputs.collect),{generatedAt:'2026-06-19T10:00:00.000Z'});return {...analysis,records:analysisRecords({analysis,workspaceId})}},summarize:result=>({observations:result.observations.length,clusters:result.clusters.length,copyingRiskHigh:result.observations.filter(item=>item.inference.copyingRisk.level==='high').length,proofNeeded:result.observations.filter(item=>item.inference.proofNeeded.length).length})},
    {id:'compile-context',kind:'deterministic',timeoutMs:5000,retry:{maxAttempts:1},actorId:'agent:context-curator',run:async({outputs,emitEvent})=>{const records=[{id:'policy_evidence',workspaceId,kind:'policy',text:'Every recommendation must cite selected observations and state uncertainty.',scope:'workspace-private',status:'active',source:'workspace-policy',confidence:1,authority:1,tokens:22},{id:'constraint_no_copying',workspaceId,kind:'constraint',text:'Transfer content mechanisms, never copy distinctive source wording.',scope:'workspace-private',status:'active',source:'workspace-policy',confidence:1,authority:1,tokens:18},...outputs.normalize,...outputs['analyze-patterns'].records];const result=await compileAndPersistContext({schemaVersion:'1.0.0',id:'ctxreq_demo',requestId:'ctxreq_demo',correlationId:`req_${runId.slice(4)}_context`,workspaceId,actorId,taskId:runId,step:'generate-angles',objective,requiredEntities:['topic:agent-systems'],tokenBudget:245,allowedScopes:['workspace-private'],allowedDataClasses:['workspace-private'],allowedTrustClasses:['verified','trusted','observed'],now:'2026-06-19T10:00:00.000Z',trustedTimestamp:'2026-06-19T10:00:00.000Z'},records,{manifestRepository:contextManifestRepository,runId,clock:()=>'2026-06-19T10:00:00.000Z',emitEvent:async(type,payload)=>emitEvent(type,payload,'agent:context-curator')});await emitEvent('context.compiled',result.manifest,'agent:context-curator');return {...result.manifest,persisted:result.persisted,manifestVerification:result.verification}},summarize:manifest=>({manifestId:manifest.id,verified:manifest.manifestVerification?.valid===true,selected:manifest.selected.length,excluded:manifest.excluded.length,tokens:manifest.budget})},
    {id:'generate-angles',kind:'model',timeoutMs:120000,retry:{maxAttempts:2,retryable:true},actorId,run:async({outputs,emitEvent,signal})=>{const manifest=outputs['compile-context'];const gateway=modelFromEnv(env);return gateway.generateStructured({requestId:`modelreq_${runId.slice(4)}_angles`,correlationId:`req_${runId.slice(4)}_model`,workspaceId,actorId,objective,prompt:promptFromManifest({objective,manifest}),promptVersion:'content-intelligence.generate-angles.v1',contextManifest:{id:manifest.id,manifestFingerprint:manifest.manifestFingerprint,assemblyFingerprint:manifest.assembly.assemblyFingerprint,compilerVersion:manifest.compilerVersion,assemblyPolicyVersion:manifest.assembly.assemblyPolicyVersion,assemblyPolicyFingerprint:manifest.assembly.assemblyPolicyFingerprint,selectedCount:manifest.selected.length,excludedCount:manifest.excluded.length},context:{manifestId:manifest.id,manifestFingerprint:manifest.manifestFingerprint,budget:manifest.budget,assembly:manifest.assembly,selected:manifest.selected,excluded:manifest.excluded,conflicts:manifest.conflicts},outputSchema:recommendationSchema,outputSchemaName:'content-intelligence.recommendations',outputSchemaVersion:'1.0.0',repair:{enabled:true,maxAttempts:1}}, {emitEvent:(type,payload)=>emitEvent(type,payload,actorId), signal})},summarize:result=>({provider:result.provider,model:result.model,recommendations:Array.isArray(result.output)?result.output.length:0,manifestId:result.contextManifest.id,repairAttempts:result.repair.attempts})},
    {id:'verify-recommendations',kind:'deterministic',timeoutMs:5000,retry:{maxAttempts:1},actorId:'agent:reviewer',run:async({outputs})=>{const recommendations=outputs['generate-angles']?.output??[];const available=outputs['compile-context'].selected.filter(item=>item.kind==='observation').map(item=>item.id);const claims=recommendations.map(item=>({id:`recommendation:${item.rank}`,text:`${item.angle} ${item.hook}`,evidenceIds:item.evidenceIds}));const result=validateClaimCitations(claims,available);if(!result.valid){const error=new Error('Generated recommendations contain missing or unavailable evidence citations');error.code='citation_validation_failed';error.retryable=false;error.failures=result.failures;throw error}return {valid:true,manifestId:outputs['compile-context'].id,manifestVerified:outputs['compile-context'].manifestVerification?.valid===true,verifiedRecommendations:recommendations.length,availableEvidenceIds:available}},summarize:result=>({valid:result.valid,manifestVerified:result.manifestVerified,verifiedRecommendations:result.verifiedRecommendations})}
  ];
  const result=await executeSteps({runId,workspaceId,steps,emit});
  return {runId,objective,...result};
}
