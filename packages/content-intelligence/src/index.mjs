import { createHash } from 'node:crypto';

const clamp = value => Math.max(0, Math.min(1, Number(value) || 0));
const ANTI_PATTERNS = new Set(['generic prediction', 'absolute claim']);
const INELIGIBLE_PATTERNS = new Set(['unrelated']);
const SPECIFIC_TERMS = ['workflow','checklist','retries','recovery','experiment','test','timeline','debugging','on-device','local-first','permissions','evidence','cited','reproducing','six-step'];
const EVIDENCE_TERMS = ['got more','most saved','beat a','cut our','earned trust','helped only after','understood fastest','automated one','showing','result','replies','saves'];
const METRIC_KEYS = ['views','replies','saves','shares','clicks'];
const STOP_TERMS = new Set(['the','and','with','that','this','from','into','your','when','what','were','they','their','about','after','before','readers','people']);

function containsAny(text, phrases) {
  const lower=String(text??'').toLowerCase();
  return phrases.reduce((count, phrase)=>count+(lower.includes(phrase)?1:0),0);
}

function sha(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function fingerprint(value) {
  return `sha256:${sha(typeof value === 'string' ? value : stableStringify(value))}`;
}

function stableId(prefix, value) {
  return `${prefix}_${sha(stableStringify(value)).slice(0, 32)}`;
}

function terms(text) {
  return String(text??'')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g,' ')
    .split(/\s+/)
    .filter(term=>term.length>=4&&!STOP_TERMS.has(term));
}

function textSet(text) {
  return new Set(terms(text));
}

function jaccard(left, right) {
  if (!left.size && !right.size) return 0;
  let intersection=0;
  for (const item of left) if (right.has(item)) intersection++;
  return intersection/(left.size+right.size-intersection);
}

function normalizeMetrics(observation) {
  const input=observation.metrics??observation.observed?.metrics??observation.metadata?.metrics??{};
  const raw={};
  for (const key of METRIC_KEYS) {
    if (input[key]!==undefined) raw[key]=Math.max(0,Number(input[key])||0);
  }
  return raw;
}

function normalizeBaselines(observation) {
  const input=observation.baselines??observation.observed?.baselines??observation.metadata?.baselines??{};
  const baselines={};
  for (const key of METRIC_KEYS) {
    if (input[key]!==undefined) baselines[key]=Math.max(0,Number(input[key])||0);
  }
  return baselines;
}

function relativePerformance(raw, baselines) {
  const dimensions={};
  let above=0,below=0,available=0;
  for (const key of METRIC_KEYS) {
    if (raw[key]===undefined) continue;
    const baseline=baselines[key];
    if (!baseline) {
      dimensions[key]={value:raw[key],baseline:null,ratio:null,state:'insufficient_baseline'};
      continue;
    }
    const ratio=Number((raw[key]/baseline).toFixed(3));
    const state=ratio>=1.25?'above_baseline':(ratio<=0.75?'below_baseline':'near_baseline');
    if (state==='above_baseline') above++;
    if (state==='below_baseline') below++;
    available++;
    dimensions[key]={value:raw[key],baseline,ratio,state};
  }
  const state=available===0?'insufficient_baseline':(above>below?'above_baseline':(below>above?'below_baseline':'near_baseline'));
  return {
    state,
    dimensions,
    reasonCodes:[
      available===0?'raw_metrics_not_comparable':'baseline_compared',
      above>0?'relative_outperformer':null,
      below>0?'relative_underperformer':null
    ].filter(Boolean)
  };
}

function inferPatternShape(observation, retrieval) {
  const text=String(observation.text??'');
  const lower=text.toLowerCase();
  const declared=String(observation.inferred?.pattern??observation.metadata?.inferred?.pattern??'').toLowerCase();
  const format=lower.includes('checklist')||lower.includes('six-step')?'checklist':(lower.includes('timeline')?'timeline':(lower.includes('demo')?'demo-analysis':'observation'));
  const evidenceType=retrieval.outcomeEvidence>=.6?'outcome-backed':(containsAny(lower,['evidence','cited','showing','result'])?'evidence-mentioned':'needs-proof');
  const mechanism=lower.includes('retries')||lower.includes('recovery')?'failure-recovery':(lower.includes('permissions')?'permission-boundary':(lower.includes('workflow')?'workflow-breakdown':'general-claim'));
  const narrative=declared||mechanism;
  const reader=lower.includes('teams')?'operators':(lower.includes('readers')?'readers':'builders');
  const emotion=lower.includes('trust')||lower.includes('earned trust')?'trust':(lower.includes('failed')?'relief':'clarity');
  return {
    label: declared||`${format}:${mechanism}`,
    hookMechanism: mechanism,
    claimType: lower.includes('prediction')?'prediction':(lower.includes('show')?'demonstration':'lesson'),
    evidenceType,
    narrative,
    format,
    emotion,
    reader,
    takeaway: mechanism==='general-claim'?'needs concrete proof':'transfer the mechanism, not source phrasing'
  };
}

function sourceAgeDays(observation, generatedAt) {
  const sourceTime=observation.publishedAt??observation.metricAt??observation.collectedAt??observation.observedAt;
  const sourceMs=Date.parse(sourceTime);
  const generatedMs=Date.parse(generatedAt);
  if (Number.isNaN(sourceMs)||Number.isNaN(generatedMs)) return null;
  return Math.max(0,Math.floor((generatedMs-sourceMs)/86400000));
}

function lifecycleFor({ clusterSize, ageDays, similarityMax, relative }) {
  if (similarityMax>=.82||clusterSize>=5) return 'overused';
  if (relative.state==='below_baseline') return 'declining';
  if (ageDays!==null&&ageDays<=3&&relative.state==='above_baseline') return 'accelerating';
  if (ageDays!==null&&ageDays<=7) return 'emerging';
  return 'established';
}

function uncertaintyFor({ retrieval, relative, proofNeeded, similarityMax }) {
  const score=(proofNeeded.length*.3)+(relative.state==='insufficient_baseline'?0.35:0)+(retrieval.outcomeEvidence<.4?0.25:0)+(similarityMax>=.82?0.2:0);
  const level=score>=.7?'high':(score>=.35?'medium':'low');
  return {
    level,
    reasonCodes:[
      relative.state==='insufficient_baseline'?'missing_relative_baseline':null,
      retrieval.outcomeEvidence<.4?'weak_outcome_evidence':null,
      similarityMax>=.82?'high_similarity':null
    ].filter(Boolean)
  };
}

function copyingRiskFor(similarityMax, retrieval) {
  const level=similarityMax>=.82?'high':(similarityMax>=.55?'medium':(retrieval.polarity==='anti-pattern'?'medium':'low'));
  return {
    level,
    reasonCodes:[
      similarityMax>=.82?'near_duplicate_source':null,
      similarityMax>=.55&&similarityMax<.82?'similar_mechanism_needs_rewrite':null,
      retrieval.polarity==='anti-pattern'?'anti_pattern_should_not_be_copied':null
    ].filter(Boolean)
  };
}

function clusterKeyFor(pattern) {
  return [pattern.format,pattern.hookMechanism,pattern.evidenceType].join(':');
}

function buildSimilarity(observations) {
  const sets=observations.map(item=>textSet(item.text));
  const maxById=new Map(observations.map(item=>[item.id,{score:0,observationId:null}]));
  for (let i=0;i<observations.length;i++) {
    for (let j=i+1;j<observations.length;j++) {
      const score=Number(jaccard(sets[i],sets[j]).toFixed(3));
      if (score>maxById.get(observations[i].id).score) maxById.set(observations[i].id,{score,observationId:observations[j].id});
      if (score>maxById.get(observations[j].id).score) maxById.set(observations[j].id,{score,observationId:observations[i].id});
    }
  }
  return maxById;
}

function contentError(code, message) {
  const error=new Error(message);
  error.code=code;
  return error;
}

function assertPlainObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw contentError('content_record_invalid', `${name} must be an object`);
  return value;
}

function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw contentError('content_record_invalid', `${name} is required`);
  return value;
}

function candidatePreviewText(candidate) {
  return [assertNonEmptyString(candidate.angle, 'candidate.angle'), assertNonEmptyString(candidate.hook, 'candidate.hook')].join('\n\n');
}

function normalizeEvidenceIds(candidate) {
  if (!Array.isArray(candidate.evidenceIds) || !candidate.evidenceIds.length) throw contentError('candidate_evidence_required', 'candidate evidenceIds are required');
  return [...new Set(candidate.evidenceIds.map(id=>assertNonEmptyString(String(id), 'candidate.evidenceIds item')))].sort();
}

function ensureEvidenceAvailable(evidenceIds, availableEvidenceIds) {
  const available=new Set((availableEvidenceIds??[]).map(String));
  const missing=evidenceIds.filter(id=>!available.has(id));
  if (missing.length) throw contentError('candidate_evidence_unavailable', `approval evidence is not available: ${missing.join(',')}`);
}

function normalizeContextManifestRef(contextManifest) {
  assertPlainObject(contextManifest, 'contextManifest');
  return {
    id:assertNonEmptyString(contextManifest.id, 'contextManifest.id'),
    manifestFingerprint:assertNonEmptyString(contextManifest.manifestFingerprint, 'contextManifest.manifestFingerprint'),
    assemblyFingerprint:contextManifest.assemblyFingerprint??contextManifest.assembly?.assemblyFingerprint??null,
    compilerVersion:contextManifest.compilerVersion??null,
    assemblyPolicyVersion:contextManifest.assemblyPolicyVersion??contextManifest.assembly?.assemblyPolicyVersion??null,
    assemblyPolicyFingerprint:contextManifest.assemblyPolicyFingerprint??contextManifest.assembly?.assemblyPolicyFingerprint??null,
    selectedCount:Number.isInteger(contextManifest.selectedCount)?contextManifest.selectedCount:(Array.isArray(contextManifest.selected)?contextManifest.selected.length:null),
    excludedCount:Number.isInteger(contextManifest.excludedCount)?contextManifest.excludedCount:(Array.isArray(contextManifest.excluded)?contextManifest.excluded.length:null)
  };
}

function levenshtein(left, right) {
  const a=[...String(left??'')], b=[...String(right??'')];
  const prev=Array.from({length:b.length+1},(_,index)=>index);
  const curr=Array(b.length+1).fill(0);
  for (let i=1;i<=a.length;i++) {
    curr[0]=i;
    for (let j=1;j<=b.length;j++) {
      curr[j]=Math.min(prev[j]+1,curr[j-1]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));
    }
    prev.splice(0,prev.length,...curr);
  }
  return prev[b.length];
}

function similarityRisk(score, inheritedRisk='low') {
  const inherited=inheritedRisk==='high'?2:(inheritedRisk==='medium'?1:0);
  const lexical=score>=.82?2:(score>=.45?1:0);
  const level=['low','medium','high'][Math.max(inherited,lexical)];
  return {
    level,
    reasonCodes:[
      score>=.82?'edited_text_near_source':null,
      score>=.45&&score<.82?'edited_text_similar_to_source':null,
      inheritedRisk==='high'?'cited_evidence_high_copying_risk':null,
      inheritedRisk==='medium'?'cited_evidence_medium_copying_risk':null,
      level==='low'?'edited_text_differentiated':null
    ].filter(Boolean)
  };
}

function maxDraftSimilarity(editedText, sourceRecords) {
  const draftTerms=textSet(editedText);
  let best={score:0,evidenceId:null};
  for (const record of sourceRecords??[]) {
    const score=Number(jaccard(draftTerms,textSet(record.text)).toFixed(3));
    if (score>best.score) best={score,evidenceId:String(record.id)};
  }
  return best;
}

function inheritedCopyingRisk(evidenceIds, patternAnalysis) {
  const byId=new Map((patternAnalysis?.observations??[]).map(item=>[item.observationId,item]));
  let highest='low';
  for (const id of evidenceIds) {
    const level=byId.get(id)?.inference?.copyingRisk?.level;
    if (level==='high') return 'high';
    if (level==='medium') highest='medium';
  }
  return highest;
}

export function editDistance(left, right) {
  const distance=levenshtein(left,right);
  const maxLength=Math.max([...String(left??'')].length,[...String(right??'')].length,1);
  return {
    distance,
    ratio:Number((distance/maxLength).toFixed(4))
  };
}

/**
 * Produce deterministic retrieval hints without mutating the source observation.
 * These hints are candidates for reranking, not truth claims.
 */
export function assessContentObservation(observation) {
  if (!observation || typeof observation !== 'object') throw new TypeError('observation must be an object');
  const pattern=String(observation.inferred?.pattern??'').toLowerCase();
  const text=String(observation.text??'');
  const metrics=observation.metrics??{};
  const views=Math.max(0, Number(metrics.views)||0);
  const replies=Math.max(0, Number(metrics.replies)||0);
  const saves=Math.max(0, Number(metrics.saves)||0);
  const engagement=clamp(Math.log1p((views/250)+(replies*4)+(saves*3))/8);
  const specificity=clamp(containsAny(text,SPECIFIC_TERMS)/3);
  const outcomeEvidence=clamp((containsAny(text,EVIDENCE_TERMS)/2)+((replies||saves)?0.15:0));
  const candidateEligible=!INELIGIBLE_PATTERNS.has(pattern);
  const antiPattern=ANTI_PATTERNS.has(pattern);
  const retrievalPenalty=antiPattern?0.9:(candidateEligible?0:1);
  const importance=clamp((engagement*.25)+(specificity*.35)+(outcomeEvidence*.4)-(retrievalPenalty*.65));
  return {
    schemaVersion:'1.0.0',
    candidateEligible,
    polarity:antiPattern?'anti-pattern':(candidateEligible?'positive':'irrelevant'),
    importance,
    outcomeEvidence,
    retrievalPenalty,
    signals:{engagement,specificity},
    reasonCodes:[
      candidateEligible?'candidate_eligible':'candidate_ineligible',
      antiPattern?'anti_pattern':null,
      specificity>=.66?'specific_workflow_evidence':null,
      outcomeEvidence>=.6?'outcome_evidence':null
    ].filter(Boolean)
  };
}

export function observationRecordKind(assessment) {
  return assessment.polarity==='anti-pattern'?'negative-context':'observation';
}

export function analyzeContentPatterns(observations, { generatedAt = new Date().toISOString() } = {}) {
  if (!Array.isArray(observations)) throw new TypeError('observations must be an array');
  const normalized=observations.map((observation,index)=>({
    ...observation,
    id:String(observation.id??`obs_analysis_${index}`),
    text:String(observation.text??'')
  }));
  const similarity=buildSimilarity(normalized);
  const clusterMembers=new Map();
  const partial=normalized.map((observation)=>{
    const retrieval=assessContentObservation(observation);
    const metrics={raw:normalizeMetrics(observation)};
    metrics.baselines=normalizeBaselines(observation);
    metrics.relativePerformance=relativePerformance(metrics.raw,metrics.baselines);
    const pattern=inferPatternShape(observation,retrieval);
    const clusterKey=clusterKeyFor(pattern);
    const clusterId=stableId('clu',clusterKey);
    const members=clusterMembers.get(clusterId)??[];
    members.push(observation.id);
    clusterMembers.set(clusterId,members);
    return {observation,retrieval,metrics,pattern,clusterId};
  });
  const analyses=partial.map((item)=>{
    const similar=similarity.get(item.observation.id)??{score:0,observationId:null};
    const proofNeeded=[
      item.metrics.relativePerformance.state==='insufficient_baseline'?'creator_or_format_baseline':null,
      item.retrieval.outcomeEvidence<.4?'concrete_outcome_evidence':null,
      item.pattern.evidenceType==='needs-proof'?'citation_or_run_trace':null
    ].filter(Boolean);
    const clusterSize=clusterMembers.get(item.clusterId)?.length??1;
    const lifecycle=lifecycleFor({clusterSize,ageDays:sourceAgeDays(item.observation,generatedAt),similarityMax:similar.score,relative:item.metrics.relativePerformance});
    const copyingRisk=copyingRiskFor(similar.score,item.retrieval);
    const uncertainty=uncertaintyFor({retrieval:item.retrieval,relative:item.metrics.relativePerformance,proofNeeded,similarityMax:similar.score});
    return {
      schemaVersion:'1.0.0',
      observationId:item.observation.id,
      metrics:item.metrics,
      inference:{
        pattern:item.pattern,
        clusterId:item.clusterId,
        lifecycle,
        proofNeeded,
        uncertainty,
        similarity:{maxScore:similar.score,nearestObservationId:similar.observationId},
        copyingRisk,
        reasonCodes:[
          ...item.retrieval.reasonCodes,
          ...item.metrics.relativePerformance.reasonCodes,
          `lifecycle_${lifecycle}`,
          `copying_risk_${copyingRisk.level}`,
          proofNeeded.length?'proof_needed':'proof_sufficient'
        ]
      }
    };
  }).sort((left,right)=>left.observationId.localeCompare(right.observationId));
  const clusters=[...clusterMembers.entries()].map(([clusterId,members])=>({
    id:clusterId,
    observationIds:[...members].sort(),
    size:members.length,
    lifecycle:members.length>=5?'overused':(members.length>=3?'established':'emerging'),
    saturation:members.length>=5?'high':(members.length>=3?'medium':'low'),
    reasonCodes:[members.length>=3?'repeated_pattern':'bounded_cluster']
  })).sort((left,right)=>left.id.localeCompare(right.id));
  return {
    schemaVersion:'1.0.0',
    generatedAt,
    observations:analyses,
    clusters,
    safeguards:{
      metricsSeparatedFromInference:true,
      rawMetricsAreNotTruth:true,
      sourceTextExcludedFromClusters:true,
      copyingRequiresRewrite:true
    }
  };
}

export function createCandidateApproval({
  workspaceId,
  actorId,
  candidate,
  availableEvidenceIds = [],
  contextManifest,
  promptVersion = 'content-intelligence.generate-angles.v1',
  outputSchemaName = 'content-intelligence.recommendations',
  outputSchemaVersion = '1.0.0',
  provider = null,
  model = null,
  decision = 'approved',
  decidedAt = new Date().toISOString(),
  expiresAt = null
} = {}) {
  assertNonEmptyString(workspaceId, 'workspaceId');
  assertNonEmptyString(actorId, 'actorId');
  assertPlainObject(candidate, 'candidate');
  const rank=Number(candidate.rank);
  if (!Number.isInteger(rank) || rank < 1) throw contentError('candidate_rank_invalid', 'candidate.rank must be a positive integer');
  const evidenceIds=normalizeEvidenceIds(candidate);
  ensureEvidenceAvailable(evidenceIds, availableEvidenceIds);
  const manifestRef=normalizeContextManifestRef(contextManifest);
  const previewText=candidatePreviewText(candidate);
  const candidateRecord={
    id:stableId('cand',{rank,angle:candidate.angle,hook:candidate.hook,evidenceIds}),
    rank,
    angle:candidate.angle,
    hook:candidate.hook,
    evidenceIds
  };
  const binding={
    candidateId:candidateRecord.id,
    candidateRank:rank,
    candidateFingerprint:fingerprint(candidateRecord),
    evidenceIds,
    evidenceFingerprint:fingerprint(evidenceIds),
    contextManifest:manifestRef,
    promptVersion,
    outputSchemaName,
    outputSchemaVersion,
    provider,
    model
  };
  const operationFingerprint=fingerprint({
    workspaceId,
    actorId,
    operation:'content.local-draft',
    sideEffectClass:'local-only',
    externalWrites:false,
    binding
  });
  const allowedDecisions=new Set(['approved','rejected','cancelled']);
  if (!allowedDecisions.has(decision)) throw contentError('approval_decision_invalid', `unsupported approval decision ${decision}`);
  const expired=decision==='approved' && expiresAt && Date.parse(expiresAt) <= Date.parse(decidedAt);
  const status=expired?'expired':decision;
  return {
    schemaVersion:'1.0.0',
    id:stableId('app',{workspaceId,actorId,binding,operationFingerprint}),
    workspaceId,
    actorId,
    status,
    approved:status==='approved',
    decidedAt,
    expiresAt,
    sideEffectClass:'local-only',
    operationFingerprint,
    candidate:candidateRecord,
    preview:{
      format:'plain-text',
      editableText:previewText,
      previewFingerprint:fingerprint(previewText)
    },
    binding,
    publisher:{
      enabled:false,
      reason:'publisher_disabled'
    },
    reasonCodes:[
      status==='approved'?'candidate_approved':`candidate_${status}`,
      'evidence_available',
      'context_manifest_bound',
      'schema_version_bound',
      'prompt_version_bound',
      'publisher_disabled'
    ]
  };
}

export function createLocalDraft({
  approval,
  editedText = null,
  createdAt = new Date().toISOString()
} = {}) {
  assertPlainObject(approval, 'approval');
  if (approval.status !== 'approved') throw contentError('draft_requires_approved_candidate', `cannot draft from ${approval.status} approval`);
  if (approval.expiresAt && Date.parse(approval.expiresAt) <= Date.parse(createdAt)) {
    throw contentError('approval_expired', 'cannot draft from an expired approval');
  }
  const text=editedText === null ? approval.preview.editableText : assertNonEmptyString(editedText, 'editedText');
  const edit=editDistance(approval.preview.editableText,text);
  return {
    schemaVersion:'1.0.0',
    id:stableId('draft',{approvalId:approval.id,editedText:text,createdAt}),
    workspaceId:approval.workspaceId,
    actorId:approval.actorId,
    approvalId:approval.id,
    candidateId:approval.candidate.id,
    status:'local-draft',
    format:'plain-text',
    editedText:text,
    draftFingerprint:fingerprint(text),
    evidenceIds:approval.candidate.evidenceIds,
    createdAt,
    editDistance:{
      source:'approval_preview_to_edited_draft',
      ...edit
    },
    binding:{
      operationFingerprint:approval.operationFingerprint,
      approvalFingerprint:fingerprint({
        id:approval.id,
        status:approval.status,
        operationFingerprint:approval.operationFingerprint,
        binding:approval.binding
      }),
      contextManifest:approval.binding.contextManifest,
      candidateFingerprint:approval.binding.candidateFingerprint
    },
    publisher:{
      enabled:false,
      reason:'publisher_disabled'
    },
    sideEffectClass:'local-only'
  };
}

export function verifyLocalDraft({
  draft,
  availableEvidenceIds = [],
  sourceRecords = [],
  patternAnalysis = null,
  verifiedAt = new Date().toISOString()
} = {}) {
  assertPlainObject(draft, 'draft');
  const available=new Set(availableEvidenceIds.map(String));
  const missing=(draft.evidenceIds??[]).filter(id=>!available.has(id));
  const best=maxDraftSimilarity(draft.editedText, sourceRecords);
  const inheritedRisk=inheritedCopyingRisk(draft.evidenceIds??[], patternAnalysis);
  const copyingRisk=similarityRisk(best.score,inheritedRisk);
  const valid=missing.length===0 && copyingRisk.level !== 'high';
  return {
    schemaVersion:'1.0.0',
    draftId:draft.id,
    verifiedAt,
    valid,
    citations:{
      valid:missing.length===0,
      evidenceIds:[...(draft.evidenceIds??[])].sort(),
      missingEvidenceIds:missing.sort()
    },
    similarity:{
      maxScore:best.score,
      nearestEvidenceId:best.evidenceId,
      copyingRisk
    },
    publisher:{
      enabled:false,
      reason:'publisher_disabled'
    },
    reasonCodes:[
      missing.length?'missing_evidence':'citations_verified',
      `copying_risk_${copyingRisk.level}`,
      valid?'local_draft_verified':'local_draft_requires_revision',
      'publisher_disabled'
    ]
  };
}

export function recordDraftOutcome({
  draft,
  verification,
  objective,
  metric,
  qualitative = null,
  observedAt = new Date().toISOString()
} = {}) {
  assertPlainObject(draft, 'draft');
  assertPlainObject(verification, 'verification');
  assertNonEmptyString(objective, 'objective');
  assertPlainObject(metric, 'metric');
  assertNonEmptyString(metric.name, 'metric.name');
  const previewDistance=draft.editDistance ?? {source:'approval_preview_to_edited_draft',...editDistance('',draft.editedText)};
  return {
    schemaVersion:'1.0.0',
    id:stableId('out',{draftId:draft.id,metric,observedAt}),
    workspaceId:draft.workspaceId,
    actorId:draft.actorId,
    draftId:draft.id,
    approvalId:draft.approvalId,
    objective,
    objectiveMetric:{
      name:metric.name,
      value:metric.value ?? null,
      direction:metric.direction ?? 'neutral',
      unit:metric.unit ?? null
    },
    qualitative,
    observedAt,
    verification:{
      valid:verification.valid,
      copyingRisk:verification.similarity?.copyingRisk?.level ?? 'unknown',
      citationsValid:verification.citations?.valid === true
    },
    editDistance:previewDistance,
    causalClaim:'none',
    sideEffectClass:'local-only',
    publisher:{
      enabled:false,
      reason:'publisher_disabled'
    },
    reasonCodes:['objective_metric_recorded','edit_distance_recorded','no_causal_claim','publisher_disabled']
  };
}

export function completeLocalCreatorWorkflow({
  workspaceId,
  actorId,
  objective,
  candidate,
  availableEvidenceIds,
  contextManifest,
  modelResult = {},
  editedText = null,
  sourceRecords = [],
  patternAnalysis = null,
  metric = { name:'creator_judgment', value:'accepted_for_local_review', direction:'positive' },
  now = new Date().toISOString(),
  expiresAt = null
} = {}) {
  const approval=createCandidateApproval({
    workspaceId,
    actorId,
    candidate,
    availableEvidenceIds,
    contextManifest,
    promptVersion:modelResult.promptVersion ?? 'content-intelligence.generate-angles.v1',
    outputSchemaName:modelResult.outputSchemaName ?? 'content-intelligence.recommendations',
    outputSchemaVersion:modelResult.outputSchemaVersion ?? '1.0.0',
    provider:modelResult.provider ?? null,
    model:modelResult.model ?? null,
    decision:'approved',
    decidedAt:now,
    expiresAt
  });
  const draft=createLocalDraft({approval,editedText,createdAt:now});
  const verification=verifyLocalDraft({draft,availableEvidenceIds,sourceRecords,patternAnalysis,verifiedAt:now});
  const outcome=recordDraftOutcome({draft,verification,objective,metric,observedAt:now});
  return {
    schemaVersion:'1.0.0',
    workspaceId,
    actorId,
    generatedAt:now,
    approval,
    draft,
    verification,
    outcome,
    safeguards:{
      localDraftOnly:true,
      publisherEnabled:false,
      externalWrites:false,
      causalClaim:'none',
      rawSourceTextExcludedFromVerification:true
    }
  };
}
