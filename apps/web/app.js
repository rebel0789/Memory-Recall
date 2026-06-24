export const SHELL_STATES = new Set(['loading','setup','empty','error','denied','stale','partial','success']);

export const ROUTES = [
  { id:'home', path:'/', label:'Home', title:'Home', eyebrow:'Workspace / local', description:'Health, active work, approvals, residency, and the next local action.' },
  { id:'runs', path:'/runs', label:'Runs', title:'Runs', eyebrow:'Execution', description:'Run history, status, current step, artifacts, and sanitized timelines.' },
  { id:'workflows', path:'/workflows', label:'Workflows', title:'Workflows', eyebrow:'Definitions', description:'Workflow versions, graph outline, risk, retries, approvals, and tests.' },
  { id:'fabric-map', path:'/fabric-map', label:'Fabric Map', title:'Fabric Map', eyebrow:'System graph', description:'Visualize local process flow, context assembly, node handoffs, and disabled external boundaries.' },
  { id:'context', path:'/context', label:'Context', title:'Context', eyebrow:'Manifest inspector', description:'Selected and excluded records, budgets, conflicts, assembly, and compiler versions.' },
  { id:'context-pack', path:'/context-pack', label:'Context Pack', title:'Context Pack', eyebrow:'Agent handoff', description:'Build a safe, token-aware handoff for Codex, Claude Code, Cursor, or a generic agent.' },
  { id:'source-graph', path:'/source-graph', label:'Source Graph', title:'Source Graph', eyebrow:'Code map', description:'Search symbols, trace calls, and inspect likely diff impact from local JS/TS metadata.' },
  { id:'memory', path:'/memory', label:'Memory', title:'Memory', eyebrow:'Lifecycle', description:'Proposals, active records, supersession, retraction, expiry, and provenance.' },
  { id:'evidence', path:'/evidence', label:'Evidence', title:'Evidence', eyebrow:'Observed facts', description:'Snapshots, observations, citations, staleness, and inferred pattern boundaries.' },
  { id:'approvals', path:'/approvals', label:'Approvals', title:'Approvals', eyebrow:'Consequences', description:'Exact actions, risk, policy reasons, idempotency, expiry, and disabled publisher state.' },
  { id:'content', path:'/content', label:'Content Lab', title:'Content Lab', eyebrow:'Creator workflow', description:'Candidates, evidence, differentiation, proof needed, local drafts, and outcomes.' },
  { id:'agents', path:'/agents-tools', label:'Agents & Tools', title:'Agents & Tools', eyebrow:'Capabilities', description:'Manifests, permissions, compatibility, health, and bounded local execution.' },
  { id:'settings', path:'/settings', label:'Settings', title:'Settings', eyebrow:'Local system', description:'Models, storage, policy, privacy, infrastructure, and design token contract.' }
];

const routeById = new Map(ROUTES.map(route=>[route.id,route]));
const routeByPath = new Map(ROUTES.map(route=>[route.path,route]));
const legacyViews = new Map([['home','/'],['runs','/runs'],['context','/context'],['evidence','/evidence'],['memory','/memory'],['design','/settings']]);
export const navItems = ROUTES;

let dashboard=null;
let shellState={kind:'loading',message:'Loading local workspace state.'};
let activeRunDetail=null;
let contextPackResult=null;
let contextPackError=null;
let sourceGraphResult=null;
let sourceGraphError=null;
let harnessSetupResult=null;
let harnessSetupError=null;
let activeFabricNode='context';

export function legacyViewPath(view) {
  return legacyViews.get(String(view??'')) ?? '/';
}

export function resolveRoute(input) {
  const url = new URL(input ?? '/', 'http://127.0.0.1');
  const legacy = url.searchParams.get('view');
  if (legacy) return routeByPath.get(legacyViewPath(legacy)) ?? routeById.get('home');
  const normalized = url.pathname !== '/' && url.pathname.endsWith('/') ? url.pathname.slice(0,-1) : url.pathname;
  return routeByPath.get(normalized) ?? routeById.get('home');
}

export function classifyDashboardState(value) {
  if (!value) return { kind:'loading', message:'Loading local workspace state.' };
  if (value.error?.status === 503 && value.error?.code === 'bootstrap_required') return { kind:'setup', message:'Create the first local owner to unlock this workspace.' };
  if (value.error?.status === 401 || value.error?.status === 403) return { kind:'denied', message:'Sign in locally to view this workspace.' };
  if (value.error) return { kind:'error', message:value.error.message ?? 'Could not load local state.' };
  const runs = Array.isArray(value.runs) ? value.runs : [];
  if (!runs.length && !value.latestManifest) return { kind:'empty', message:'No local runs have been recorded.' };
  if (value.stale) return { kind:'stale', message:'Showing cached local data. Retry when the loopback API is available.' };
  if (!value.latestManifest) return { kind:'partial', message:'Runs exist, but no context manifest has been compiled yet.' };
  return { kind:'success', message:'Local workspace state loaded.' };
}

export function shellStatusLabel({ network='deny', externalWrites=false, modelMode='deterministic' } = {}) {
  const parts = [];
  if (network === 'deny') parts.push('Local-only','Network denied');
  else parts.push('Network allowed');
  parts.push(externalWrites ? 'External writes enabled' : 'External writes disabled');
  parts.push(`${modelMode === 'deterministic' ? 'Deterministic' : modelMode} model`);
  return parts.join(' · ');
}

export const WORKFLOW_STEPS = [
  { id:'collect', label:'Collect', detail:'Read bounded local or caller-supplied sources.' },
  { id:'normalize', label:'Normalize', detail:'Create observation records and retrieval eligibility.' },
  { id:'analyze-patterns', label:'Analyze patterns', detail:'Separate metrics from pattern inference and copying risk.' },
  { id:'compile-context', label:'Compile context', detail:'Persist selected/excluded records and context assembly.' },
  { id:'generate-angles', label:'Generate angles', detail:'Call the selected local model provider with a manifest reference.' },
  { id:'verify-recommendations', label:'Verify recommendations', detail:'Check generated claims against selected evidence.' },
  { id:'local-draft-outcome', label:'Local draft outcome', detail:'Record local approval, draft verification, and outcome.' }
];

const STEP_ORDER = new Map(WORKFLOW_STEPS.map((step,index)=>[step.id,index]));

export const FABRIC_NODES = [
  {
    id:'sources',
    lane:'intake',
    label:'Source Intake',
    role:'Harness project files and explicit user locators',
    route:'/context-pack',
    detail:'Scans documented project-visible files and selected workspace locators as untrusted input.'
  },
  {
    id:'normalize',
    lane:'intake',
    label:'Normalize',
    role:'Observed records, hashes, reason codes',
    route:'/evidence',
    detail:'Separates observed fields from interpretation and keeps source bodies out of the shell.'
  },
  {
    id:'context',
    lane:'reasoning',
    label:'Context Compiler',
    role:'Selected, excluded, conflicts, assembly',
    route:'/context',
    detail:'Persists a manifest that every model call references instead of carrying hidden context.'
  },
  {
    id:'model',
    lane:'reasoning',
    label:'Model Gateway',
    role:'Deterministic default, optional local provider',
    route:'/settings',
    detail:'Uses the selected local provider path with schema validation and no hosted fallback.'
  },
  {
    id:'workflow',
    lane:'execution',
    label:'Workflow Runtime',
    role:'Checkpoints, retries, cancellation',
    route:'/workflows',
    detail:'Runs deterministic steps through append-only events and recoverable checkpoints.'
  },
  {
    id:'tools',
    lane:'execution',
    label:'Tool Broker',
    role:'One-use exact-operation grants',
    route:'/agents-tools',
    detail:'Brokers filesystem, loopback egress, and secret references independently after policy allows.'
  },
  {
    id:'evidence',
    lane:'assurance',
    label:'Evidence Ledger',
    role:'Observed facts and claim links',
    route:'/evidence',
    detail:'Keeps observations, inferred claims, source hashes, and stale/conflict signals inspectable.'
  },
  {
    id:'memory',
    lane:'assurance',
    label:'Memory Queue',
    role:'Proposal-first lifecycle',
    route:'/memory',
    detail:'Requires review before activation and preserves supersession, retraction, expiry, and evidence.'
  },
  {
    id:'approvals',
    lane:'boundary',
    label:'Approval Gate',
    role:'Exact previews and idempotency',
    route:'/approvals',
    detail:'Consequential local effects require exact operation previews; external publishing remains unavailable.'
  },
  {
    id:'external',
    lane:'boundary',
    label:'External Adapters',
    role:'Disabled conformance boundary',
    route:'/agents-tools',
    detail:'Adapter contracts remain baselines only unless a reviewed adapter is explicitly enabled later.'
  }
];

export const FABRIC_LINKS = [
  { from:'sources', to:'normalize', label:'safe locators' },
  { from:'normalize', to:'context', label:'candidates' },
  { from:'context', to:'model', label:'manifest reference' },
  { from:'workflow', to:'context', label:'compile checkpoint' },
  { from:'workflow', to:'tools', label:'bounded grant request' },
  { from:'tools', to:'approvals', label:'exact operation preview' },
  { from:'model', to:'evidence', label:'schema output' },
  { from:'evidence', to:'memory', label:'proposal evidence' },
  { from:'approvals', to:'external', label:'blocked boundary' }
];

export function runDetailLink(runId, stepId = null) {
  const suffix = stepId ? `&step=${encodeURIComponent(stepId)}` : '';
  return `/runs?run=${encodeURIComponent(runId)}${suffix}`;
}

export function contextRecordLink(recordId, state = 'selected') {
  return `/context?record=${encodeURIComponent(recordId)}&state=${encodeURIComponent(state)}`;
}

export function summarizeRunSteps(events = []) {
  const discovered = new Set(WORKFLOW_STEPS.map((step)=>step.id));
  for (const event of events) {
    const steps = event?.type === 'run.created' && Array.isArray(event.payload?.steps) ? event.payload.steps : [];
    steps.forEach((step)=>discovered.add(step));
  }
  const steps = [...discovered].sort((left,right)=>(STEP_ORDER.get(left)??999)-(STEP_ORDER.get(right)??999)||left.localeCompare(right));
  const summary = new Map(steps.map((stepId)=>[stepId,{
    id:stepId,
    label:WORKFLOW_STEPS.find((step)=>step.id===stepId)?.label ?? titleize(stepId),
    detail:WORKFLOW_STEPS.find((step)=>step.id===stepId)?.detail ?? 'Deterministic workflow step.',
    status:'waiting',
    attempts:0,
    actorId:null,
    startedAt:null,
    completedAt:null,
    durationMs:null,
    summary:null,
    errorCode:null,
    retryable:false
  }]));
  for (const event of events) {
    const stepId = event?.payload?.stepId;
    if (!stepId || !summary.has(stepId)) continue;
    const current = summary.get(stepId);
    current.actorId = event.actorId ?? current.actorId;
    current.attempts = Math.max(current.attempts, Number(event.payload?.attempt ?? 0));
    if (event.type === 'step.started') {
      current.status = 'running';
      current.startedAt = current.startedAt ?? event.occurredAt;
    }
    if (event.type === 'step.completed') {
      current.status = 'success';
      current.completedAt = event.occurredAt;
      current.summary = sanitizeSummary(event.payload?.summary);
    }
    if (event.type === 'step.failed') {
      current.status = 'failed';
      current.completedAt = event.occurredAt;
      current.errorCode = safeText(event.payload?.code ?? 'step_failed');
      current.retryable = Boolean(event.payload?.retryable);
    }
    if (event.type === 'step.cancelled') {
      current.status = 'cancelled';
      current.completedAt = event.occurredAt;
      current.errorCode = 'run_cancelled';
    }
    if (current.startedAt && current.completedAt) {
      const started = Date.parse(current.startedAt);
      const completed = Date.parse(current.completedAt);
      current.durationMs = Number.isFinite(started) && Number.isFinite(completed) ? Math.max(0, completed - started) : null;
    }
  }
  return [...summary.values()];
}

export function currentStepLabel(run = {}, events = []) {
  if (run.status === 'completed') return 'completed';
  if (run.status === 'failed') return 'failed';
  const running = summarizeRunSteps(events).find((step)=>step.status === 'running');
  if (running) return running.id;
  const last = summarizeRunSteps(events).filter((step)=>step.status === 'success').at(-1);
  return last?.id ?? 'not started';
}

export function safeEventSummary(event = {}) {
  const payload = event.payload ?? {};
  return {
    sequence: Number.isInteger(event.sequence) ? event.sequence : null,
    type: safeText(event.type ?? 'event'),
    actorId: safeText(event.actorId ?? 'system'),
    occurredAt: event.occurredAt ?? null,
    stepId: payload.stepId ? safeText(payload.stepId) : null,
    attempt: Number.isInteger(payload.attempt) ? payload.attempt : null,
    summary: sanitizeSummary(payload.summary),
    code: payload.code ? safeText(payload.code) : null,
    retryable: Boolean(payload.retryable)
  };
}

export function contextDecisionView(item = {}, state = 'selected') {
  const reasonCodes = Array.isArray(item.reasonCodes) ? item.reasonCodes.map(safeText) : [];
  return {
    id:safeText(item.id ?? 'unknown_record'),
    kind:safeText(item.kind ?? 'record'),
    preview:previewText(item.text ?? item.summary ?? ''),
    tokens:Number.isFinite(Number(item.tokens)) ? Number(item.tokens) : 0,
    score:Number.isFinite(Number(item.score ?? item.selectionScore ?? item.utility)) ? Number(item.score ?? item.selectionScore ?? item.utility) : null,
    reasonCodes,
    source:safeText(item.source ?? item.metadata?.sourceSnapshotId ?? 'unknown'),
    scope:safeText(item.scope ?? 'workspace-private'),
    version:safeText(item.version ?? item.recordVersion ?? item.updatedAt ?? item.observedAt ?? 'current'),
    confidence:Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : null,
    state:state === 'excluded' ? 'excluded' : 'selected',
    selectedOrExcluded:state === 'excluded' ? 'excluded' : 'selected'
  };
}

export function buildContextInspectorModel(manifest = null) {
  if (!manifest) return null;
  const selected = (manifest.selected ?? []).map((item)=>contextDecisionView(item,'selected'));
  const excluded = (manifest.excluded ?? []).map((item)=>contextDecisionView(item,'excluded'));
  const selectedIds = new Set(selected.map((item)=>item.id));
  const excludedIds = new Set(excluded.map((item)=>item.id));
  const assemblyIds = new Set(manifest.assembly?.selectedRecordIds ?? []);
  const sections = (manifest.assembly?.sections ?? []).map((section)=>({
    id:safeText(section.id ?? 'section'),
    title:safeText(section.title ?? section.id ?? 'section'),
    count:Array.isArray(section.items) ? section.items.length : 0,
    tokens:(section.items ?? []).reduce((total,item)=>total+Number(item.tokens ?? 0),0),
    recordIds:(section.items ?? []).map((item)=>safeText(item.id ?? 'record'))
  }));
  return {
    id:safeText(manifest.id ?? 'ctx_unknown'),
    objective:safeText(manifest.objective ?? manifest.request?.objective ?? 'Context selection'),
    step:safeText(manifest.step ?? manifest.request?.step ?? 'model step'),
    actorId:safeText(manifest.actorId ?? manifest.request?.actorId ?? 'agent:context-curator'),
    compilerVersion:safeText(manifest.compilerVersion ?? 'unknown'),
    manifestFingerprint:safeText(manifest.manifestFingerprint ?? 'unavailable'),
    assemblyFingerprint:safeText(manifest.assembly?.assemblyFingerprint ?? 'unavailable'),
    budget:manifest.budget ?? { used:0, available:0 },
    selected,
    excluded,
    conflicts:Array.isArray(manifest.conflicts) ? manifest.conflicts : [],
    sections,
    comparison:{
      selectedCount:selected.length,
      excludedCount:excluded.length,
      assemblyCount:assemblyIds.size,
      selectedMissingFromAssembly:[...selectedIds].filter((id)=>!assemblyIds.has(id)),
      assemblyNotSelected:[...assemblyIds].filter((id)=>!selectedIds.has(id)),
      selectedExcludedOverlap:[...selectedIds].filter((id)=>excludedIds.has(id)),
      conflictCount:Array.isArray(manifest.conflicts) ? manifest.conflicts.length : 0
    }
  };
}

export function buildMemoryReviewModel({ memories = [] } = {}) {
  const records = Array.isArray(memories) ? memories : [];
  const byId = new Map(records.map((record)=>[String(record.id ?? ''), record]));
  return records.map((record)=> {
    const previous = record.supersedes ? byId.get(String(record.supersedes)) : null;
    const previousText = record.previous?.text ?? record.metadata?.previousText ?? previous?.text ?? null;
    const proposedText = record.proposed?.text ?? record.text ?? '';
    const status = safeText(record.status ?? 'proposed');
    return {
      id:safeText(record.id ?? 'mem_unknown'),
      kind:safeText(record.kind ?? 'fact'),
      status,
      lifecycle:Array.isArray(record.lifecycle) ? record.lifecycle.map((event)=>({
        type:safeText(event.type ?? 'memory.event'),
        at:event.at ?? null,
        actorId:safeText(event.actorId ?? 'system'),
        reason:event.reason ? safeText(event.reason) : null,
        evidenceIds:Array.isArray(event.evidenceIds) ? event.evidenceIds.map(safeText) : []
      })) : [],
      previousValue:memoryDisplayText(previousText ?? 'No previous durable memory record.'),
      proposedValue:memoryDisplayText(proposedText),
      source:safeText(record.source ?? 'unknown'),
      confidence:boundedPercent(record.confidence),
      conflict:Array.isArray(record.conflicts) && record.conflicts.length ? record.conflicts.map((conflict)=>safeText(conflict.reason ?? conflict.existingId ?? 'conflict')).join(', ') : 'none',
      retention:safeText(record.retention?.mode ?? record.retention ?? 'workspace-default'),
      supersession:record.supersedes ? safeText(record.supersedes) : 'none',
      reviewer:safeText(record.verifiedBy ?? record.activatedBy ?? record.metadata?.reviewer ?? 'not assigned'),
      evidenceIds:Array.isArray(record.evidenceIds) ? record.evidenceIds.map(safeText) : [],
      actions:memoryActionsForStatus(status)
    };
  });
}

export function buildEvidenceExplorerModel({ latestManifest = null, latestRun = null, evidenceGraph = null } = {}) {
  const manifestEvidence = (latestManifest?.selected ?? []).filter((item)=>['observation','evidence'].includes(item.kind));
  const graphObservations = Array.isArray(evidenceGraph?.observations) ? evidenceGraph.observations : [];
  const observations = graphObservations.length ? graphObservations : manifestEvidence;
  const claims = [
    ...(Array.isArray(evidenceGraph?.claims) ? evidenceGraph.claims : []),
    ...(Array.isArray(latestRun?.output?.output) ? latestRun.output.output.map((candidate)=>({
      id:`candidate:${candidate.rank ?? candidate.angle ?? 'local'}`,
      text:[candidate.angle,candidate.hook].filter(Boolean).join(' '),
      relation:'supports',
      evidenceIds:Array.isArray(candidate.evidenceIds) ? candidate.evidenceIds : [],
      inferred:{ model:latestRun.output.provider ?? 'deterministic', version:latestRun.output.model ?? latestRun.output.outputSchemaVersion ?? 'local' },
      uncertainty:candidate.confidence === undefined ? 'unknown' : `${Math.round(Number(candidate.confidence) * 100)}% confidence`
    })) : [])
  ];
  const claimsByEvidence = new Map();
  for (const claim of claims) {
    for (const id of claim.evidenceIds ?? []) {
      if (!claimsByEvidence.has(id)) claimsByEvidence.set(id, []);
      claimsByEvidence.get(id).push(claim);
    }
  }
  const conflicts = Array.isArray(latestManifest?.conflicts) ? latestManifest.conflicts : [];
  return observations.map((item)=> {
    const id = safeText(item.id ?? item.observationId ?? 'obs_unknown');
    const linkedClaims = claimsByEvidence.get(id) ?? [];
    return {
      id,
      observed:{
        text:previewText(item.text ?? item.observed?.text ?? item.summary ?? ''),
        fields:safeKeyValueList(item.observed ?? {
          kind:item.kind ?? 'observation',
          tokens:item.tokens ?? 0,
          source:item.source ?? item.sourceLocator ?? item.metadata?.sourceSnapshotId ?? 'unknown'
        })
      },
      source:safeText(item.source ?? item.sourceLocator ?? item.metadata?.sourceSnapshotId ?? item.sourceSnapshotId ?? 'unknown'),
      sourceSnapshotId:safeText(item.sourceSnapshotId ?? item.metadata?.sourceSnapshotId ?? 'snapshot_unavailable'),
      collectionMethod:safeText(item.collectionMethod ?? item.retrievalMethod ?? item.metadata?.collectionMethod ?? 'context-manifest'),
      publishedAt:item.publishedAt ?? item.metricTime ?? item.observedAt ?? null,
      collectedAt:item.collectedAt ?? item.observedAt ?? item.updatedAt ?? null,
      metricTime:item.metricTime ?? item.observedAt ?? null,
      hash:safeText(item.contentHash ?? item.sourceContentHash ?? item.hash ?? item.fingerprint ?? 'hash_unavailable'),
      trustClass:safeText(item.trustClass ?? item.sourceTrust ?? item.trust ?? 'observed'),
      inferred:safeKeyValueList(item.inferred ?? item.pattern ?? {}),
      claims:linkedClaims.map((claim)=>({
        id:safeText(claim.id),
        relation:safeText(claim.relation ?? 'supports'),
        text:previewText(claim.text ?? ''),
        uncertainty:claim.uncertainty ? safeText(claim.uncertainty) : 'not stated',
        model:safeText(claim.inferred?.model ?? claim.inferred?.version ?? 'not recorded')
      })),
      stale:Boolean(item.stale ?? false),
      conflicts:conflicts.filter((conflict)=>JSON.stringify(conflict).includes(id)).map((conflict)=>safeText(conflict.reason ?? conflict.type ?? 'conflict'))
    };
  });
}

export function buildApprovalReviewModel({ approvals = [] } = {}) {
  const items = Array.isArray(approvals) ? approvals : [];
  return items.map((approval)=> {
    const status = safeText(approval.status ?? 'pending');
    const operationHash = safeText(approval.operationHash ?? approval.operationFingerprint ?? approval.binding?.operationFingerprint ?? 'hash_unavailable');
    const exactContent = approval.preview?.diff ?? approval.preview?.editableText ?? approval.diff ?? approval.content ?? approval.candidate?.hook ?? 'No content preview recorded.';
    return {
      id:safeText(approval.id ?? 'approval_unknown'),
      status,
      operationHash,
      actor:safeText(approval.actorId ?? approval.actor ?? 'unknown'),
      destination:safeText(approval.destination ?? approval.publisher?.destination ?? approval.publisher?.reason ?? 'local workspace only'),
      exactContent:memoryDisplayText(exactContent),
      risk:safeText(approval.risk ?? approval.riskClass ?? approval.sideEffectClass ?? 'consequential-write'),
      policyVersion:safeText(approval.policyVersion ?? approval.policy?.version ?? 'policy:local'),
      expiresAt:approval.expiresAt ?? null,
      idempotency:safeText(approval.idempotencyKey ?? approval.idempotency?.key ?? approval.operationFingerprint ?? 'required-before-execution'),
      consequence:safeText(approval.consequence ?? approval.sideEffectClass ?? 'local-only review'),
      reasonCodes:Array.isArray(approval.reasonCodes) ? approval.reasonCodes.map(safeText) : [],
      externalWrites:approval.externalWrites === true,
      editInvalidates:true,
      actions:approvalActionsForStatus(status)
    };
  });
}

export function buildFabricMapModel({ dashboard: value = null, shellState: state = {}, activeNodeId = 'context' } = {}) {
  const metrics = value?.metrics ?? {};
  const runs = Array.isArray(value?.runs) ? value.runs : [];
  const manifestModel = buildContextInspectorModel(value?.latestManifest ?? null);
  const latestRun = value?.latestRun ?? runs[0] ?? null;
  const evidence = buildEvidenceExplorerModel({
    latestManifest:value?.latestManifest ?? null,
    latestRun,
    evidenceGraph:value?.evidenceGraph ?? null
  });
  const memories = buildMemoryReviewModel({ memories:value?.memories ?? [] });
  const approvals = buildApprovalReviewModel({ approvals:value?.approvals ?? [] });
  const pendingApprovals = approvals.filter((approval)=>approval.status === 'pending').length;
  const candidateCount = (manifestModel?.selected.length ?? 0) + (manifestModel?.excluded.length ?? 0);
  const budgetUsed = Number(manifestModel?.budget?.used ?? 0);
  const budgetAvailable = Number(manifestModel?.budget?.available ?? 0);
  const budgetPercent = budgetAvailable > 0 ? Math.min(100, Math.round(budgetUsed / budgetAvailable * 100)) : 0;
  const output = latestRun?.output ?? {};
  const nodeMetrics = {
    sources:[
      { label:'Candidates', value:String(candidateCount || metrics.contextCandidates || 0) },
      { label:'Input mode', value:'explicit local' }
    ],
    normalize:[
      { label:'Evidence cards', value:String(evidence.length) },
      { label:'Raw bodies', value:'not rendered' }
    ],
    context:[
      { label:'Selected', value:String(manifestModel?.selected.length ?? 0) },
      { label:'Excluded', value:String(manifestModel?.excluded.length ?? 0) },
      { label:'Budget', value:budgetAvailable ? `${budgetUsed}/${budgetAvailable}` : 'not compiled' }
    ],
    model:[
      { label:'Provider', value:safeText(output.provider ?? 'deterministic') },
      { label:'Model', value:safeText(output.model ?? 'offline default') },
      { label:'Schema', value:safeText(output.outputSchemaVersion ?? 'validated') }
    ],
    workflow:[
      { label:'Runs', value:String(Number(metrics.runs ?? runs.length ?? 0)) },
      { label:'Current step', value:safeText(latestRun ? currentStepLabel(latestRun) : 'not started') },
      { label:'Events', value:String(Number(metrics.events ?? 0)) }
    ],
    tools:[
      { label:'Grant scope', value:'one-use' },
      { label:'Loopback', value:'policy gated' }
    ],
    evidence:[
      { label:'Observations', value:String(evidence.length) },
      { label:'Claims', value:String(evidence.reduce((total,item)=>total + item.claims.length,0)) }
    ],
    memory:[
      { label:'Review records', value:String(memories.length) },
      { label:'Activation', value:'proposal-first' }
    ],
    approvals:[
      { label:'Pending', value:String(pendingApprovals) },
      { label:'External writes', value:'disabled' }
    ],
    external:[
      { label:'Contracts', value:'12' },
      { label:'Enabled', value:'0' }
    ]
  };
  const nodeStatuses = {
    sources: state.kind === 'success' || state.kind === 'partial' ? 'ready' : 'waiting',
    normalize: candidateCount || evidence.length ? 'active' : 'waiting',
    context: manifestModel ? 'active' : 'waiting',
    model: latestRun?.output ? 'active' : 'ready',
    workflow: runs.length ? 'active' : 'waiting',
    tools: 'guarded',
    evidence: evidence.length ? 'active' : 'waiting',
    memory: memories.length ? 'review' : 'ready',
    approvals: pendingApprovals ? 'waiting' : 'guarded',
    external: 'disabled'
  };
  const nodes = FABRIC_NODES.map((node)=>({
    ...node,
    status:nodeStatuses[node.id] ?? 'waiting',
    statusLabel:({
      active:'live',
      waiting:'waiting',
      ready:'ready',
      guarded:'guarded',
      review:'review',
      disabled:'disabled'
    })[nodeStatuses[node.id] ?? 'waiting'],
    facts:nodeMetrics[node.id] ?? []
  }));
  const nodesById = new Map(nodes.map((node)=>[node.id,node]));
  const selectedId = nodesById.has(activeNodeId) ? activeNodeId : 'context';
  return {
    state:safeText(state.kind ?? 'loading'),
    summary:{
      runs:Number(metrics.runs ?? runs.length ?? 0),
      selectedRecords:manifestModel?.selected.length ?? 0,
      excludedRecords:manifestModel?.excluded.length ?? 0,
      evidenceCards:evidence.length,
      memoryReviews:memories.length,
      pendingApprovals,
      externalAdaptersEnabled:0,
      externalWritesEnabled:false
    },
    contextFlow:{
      manifestId:manifestModel?.id ?? 'not compiled',
      compilerVersion:manifestModel?.compilerVersion ?? 'not recorded',
      sections:manifestModel?.sections.length ?? 0,
      budgetUsed,
      budgetAvailable,
      budgetPercent,
      manifestFingerprint:manifestModel?.manifestFingerprint ?? 'unavailable',
      assemblyFingerprint:manifestModel?.assemblyFingerprint ?? 'unavailable'
    },
    safeguards:{
      network:'deny',
      modelMode:'deterministic',
      externalWritesEnabled:false,
      externalAdaptersEnabled:0,
      rawBodiesRendered:false
    },
    activeNodeId:selectedId,
    activeNode:nodesById.get(selectedId),
    nodes,
    links:FABRIC_LINKS.map((link)=>({
      ...link,
      active:nodesById.get(link.from)?.status !== 'waiting' && nodesById.get(link.to)?.status !== 'waiting',
      blocked:link.to === 'external'
    }))
  };
}

export function buildHarnessSetupUiModel(report = null) {
  const operation = report?.diff?.operations?.[0] ?? null;
  return {
    ready:Boolean(report),
    client:safeText(report?.clientLabel ?? report?.client ?? 'Select a client'),
    clientId:safeText(report?.client ?? 'codex'),
    configRef:safeText(report?.config?.ref ?? 'home://not-selected'),
    configStatus:safeText(report?.status?.config ?? 'not checked'),
    serverStatus:safeText(report?.status?.server ?? 'not checked'),
    operation:operation ? safeText(operation.summary) : 'No MCP config change needed',
    operationKind:safeText(operation?.op ?? 'none'),
    command:report ? `npm run oaf -- harness setup plan --client ${safeText(report.client)} --server oaf --dry-run --format json` : 'npm run oaf -- harness setup plan --client codex --server oaf --dry-run --format json',
    bridgeCommand:report?.desiredServer ? [report.desiredServer.command,...report.desiredServer.args].join(' ') : 'npm run oaf -- mcp resources --read-only --stdio',
    fingerprint:safeText(report?.planFingerprint ?? 'not generated'),
    safeguards:[
      ['Dry run', report?.dryRun === true ? 'true' : 'not run'],
      ['Home writes', String(Number(report?.safeguards?.localFilesWritten ?? 0))],
      ['External writes', report?.safeguards?.externalWritesEnabled ? 'enabled' : 'disabled'],
      ['External adapters', String(Number(report?.safeguards?.externalAdaptersEnabled ?? 0))],
      ['Network calls', String(Number(report?.safeguards?.networkCalls ?? 0))],
      ['Raw config body', report?.safeguards?.rawConfigBodyIncluded ? 'included' : 'excluded']
    ]
  };
}

export function harnessSetupClientsForUi() {
  return [
    ['codex','Codex'],
    ['cursor','Cursor'],
    ['claude-code','Claude Code'],
    ['opencode','OpenCode'],
    ['gemini-cli','Gemini CLI'],
    ['vscode','VS Code'],
    ['aider','Aider'],
    ['windsurf','Windsurf']
  ];
}

function workspaceId() {
  return new URL(globalThis.location?.href ?? 'http://127.0.0.1/').searchParams.get('workspaceId') ?? 'ws_local';
}

function currentRoute() {
  return resolveRoute(globalThis.location?.href ?? '/');
}

function csrfToken() {
  return /(?:^|;\s*)oaf_csrf=([^;]+)/.exec(globalThis.document?.cookie ?? '')?.[1] ?? '';
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (options.body && !headers.has('content-type')) headers.set('content-type','application/json');
  const token = csrfToken();
  if (token && options.method && !['GET','HEAD'].includes(options.method)) headers.set('x-csrf-token', token);
  const response = await fetch(path, { ...options, headers });
  const payload = await response.clone().json().catch(()=>null);
  if (!response.ok) {
    const code = payload?.error?.code ?? null;
    const message = code === 'bootstrap_required'
      ? 'Local owner setup is required.'
      : code === 'invalid_credentials'
        ? 'Username or password is incorrect.'
        : response.status === 401
          ? 'Local authentication required.'
          : payload?.error?.message ?? `Request failed with ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.code = code;
    throw error;
  }
  return payload ?? response.json();
}

async function load() {
  const root = document.querySelector('#view-root');
  root.setAttribute('aria-busy','true');
  shellState={kind:'loading',message:'Loading local workspace state.'};
  render();
  try {
    dashboard = await api(`/api/dashboard?workspaceId=${encodeURIComponent(workspaceId())}`);
    shellState = classifyDashboardState(dashboard);
  } catch (error) {
    dashboard = { error:{ status:error.status, code:error.code, message:error.message }, metrics:{ runs:0, completed:0, events:0, pendingApprovals:0 }, runs:[], approvals:[], latestRun:null, latestManifest:null };
    shellState = classifyDashboardState(dashboard);
  } finally {
    render();
    root.setAttribute('aria-busy','false');
  }
}

function render() {
  const route=currentRoute();
  document.querySelector('#page-title').textContent=route.title;
  document.querySelector('#page-eyebrow').textContent=route.eyebrow;
  document.querySelector('#page-description').textContent=route.description;
  renderNav(document.querySelector('#primary-nav'), 'rail');
  renderNav(document.querySelector('#mobile-nav'), 'bottom');
  renderStatusBar();
  const root=document.querySelector('#view-root');
  root.dataset.state=shellState.kind;
  root.innerHTML = shellState.kind === 'loading'
    ? statePanel('loading','Loading local state','Checking the loopback control API for workspace data.')
    : renderRoute(route);
  root.querySelectorAll('[data-action=run]').forEach(button=>button.addEventListener('click',runDemo));
  root.querySelectorAll('[data-action=reset]').forEach(button=>button.addEventListener('click',resetDemo));
  root.querySelectorAll('[data-run-id]').forEach(link=>link.addEventListener('click',showRun));
  root.querySelectorAll('[data-step-id],[data-record-id]').forEach(link=>link.addEventListener('click',navigateLocal));
  root.querySelector('#auth-form')?.addEventListener('submit',submitAuthForm);
  root.querySelector('#context-pack-form')?.addEventListener('submit',submitContextPack);
  root.querySelectorAll('[data-action=detect-git-changes]').forEach(button=>button.addEventListener('click',detectContextPackGitChanges));
  root.querySelector('#source-graph-form')?.addEventListener('submit',submitSourceGraph);
  root.querySelector('#harness-setup-form')?.addEventListener('submit',submitHarnessSetupPlan);
  root.querySelectorAll('[data-action=copy-pack]').forEach(button=>button.addEventListener('click',copyContextPack));
  root.querySelectorAll('[data-action=download-pack]').forEach(button=>button.addEventListener('click',downloadContextPack));
  root.querySelectorAll('[data-action=preview-pack-setup]').forEach(button=>button.addEventListener('click',previewContextPackSetup));
  root.querySelectorAll('[data-fabric-node]').forEach(button=>button.addEventListener('click',selectFabricNode));
  document.querySelectorAll('[data-route]').forEach(link=>link.onclick=navigate);
}

function renderNav(container, mode) {
  container.innerHTML = navItems.map(item=>`<a href="${item.path}" data-route="${item.id}"${currentRoute().id===item.id?' aria-current="page"':''}><span class="nav-code" aria-hidden="true">${item.label.slice(0,2)}</span><span>${item.label}</span></a>`).join('');
  container.dataset.mode=mode;
}

function renderStatusBar() {
  const metrics=dashboard?.metrics ?? {};
  const label=shellStatusLabel({ network:'deny', externalWrites:false, modelMode:'deterministic' });
  document.querySelector('#shell-status').innerHTML=[
    statusChip(shellState.kind, shellState.kind, shellState.message),
    statusChip('local','Local-only','Data residency'),
    statusChip('network','Network denied','Default posture'),
    statusChip('writes','External writes disabled','Policy gate'),
    statusChip('model','Deterministic model','Offline default'),
    statusChip('approvals',`${Number(metrics.pendingApprovals??0)} pending approvals`,'Approval inbox')
  ].join('');
  document.querySelector('#shell-status').setAttribute('aria-label', label);
}

function renderRoute(route) {
  if (shellState.kind === 'setup') return authPanel('bootstrap', shellState.message);
  if (shellState.kind === 'denied') return deniedState();
  if (shellState.kind === 'error') return statePanel('error','Could not load local state', shellState.message, true);
  if (route.id === 'home') return renderHome();
  if (route.id === 'runs') return activeRunDetail ? renderRunDetail(activeRunDetail) : renderRuns();
  if (route.id === 'workflows') return renderWorkflows();
  if (route.id === 'fabric-map') return renderFabricMap();
  if (route.id === 'context') return renderContext();
  if (route.id === 'context-pack') return renderContextPack();
  if (route.id === 'source-graph') return renderSourceGraph();
  if (route.id === 'memory') return renderMemory();
  if (route.id === 'evidence') return renderEvidence();
  if (route.id === 'approvals') return renderApprovals();
  if (route.id === 'content') return renderContentLab();
  if (route.id === 'agents') return renderAgentsTools();
  if (route.id === 'settings') return renderSettings();
  return renderHome();
}

function renderHome() {
  const metrics=dashboard?.metrics ?? {runs:0,completed:0,events:0,pendingApprovals:0};
  const stateMarkup = shellState.kind === 'empty'
    ? contextPackEmptyState()
    : shellState.kind === 'partial'
      ? statePanel('partial','Context manifest pending','A run exists, but no persisted context manifest is available yet.')
      : shellState.kind === 'stale'
        ? statePanel('stale','Cached local state',shellState.message,true)
        : '';
  return `${stateMarkup}${renderPrimaryFlow()}<section class="metric-strip" aria-label="Workspace metrics">${metric(metrics.runs,'Runs','Recorded locally')}${metric(metrics.completed,'Completed','Verified outcomes')}${metric(metrics.events,'Events','Append-only ledger')}${metric(metrics.pendingApprovals,'Approvals','Need review')}</section><section class="work-grid"><div class="surface surface-primary"><div class="section-heading"><h2>Recent runs</h2><span>Local event ledger</span></div>${runList(dashboard?.runs)}</div><aside class="inspector" aria-label="Workspace inspector">${contextSummary(dashboard?.latestManifest)}${localBoundary()}</aside></section><section class="surface"><div class="section-heading"><h2>Latest recommendations</h2><span>Evidence-backed candidates</span></div>${angles(dashboard?.latestRun?.output?.output)}</section>`;
}

function contextPackEmptyState(){
  return `<section class="state-panel state-empty"><h2>No local handoff yet</h2><p>Build a context pack first. The demo workflow is optional evidence data, not the main product path.</p><div class="action-row"><a class="button primary" href="/context-pack" data-route="context-pack">Build context pack</a><button class="button secondary" data-action="run" type="button">Run demo</button></div></section>`;
}

function renderPrimaryFlow() {
  return `<section class="surface primary-flow" aria-label="Primary local context workflow"><div><p class="eyebrow">Start here</p><h2>Build a handoff your next agent can actually use.</h2><p>The pack selects safe local locators, explains omissions, estimates context pressure, maps explicitly changed files, and keeps raw source bodies out of the browser and MCP resources.</p></div><ol class="flow-mini" aria-label="Context pack workflow"><li><strong>1</strong><span>Choose target harness</span></li><li><strong>2</strong><span>Add explicit files and changed locators</span></li><li><strong>3</strong><span>Inspect selected, omitted, and impacted context</span></li><li><strong>4</strong><span>Preview read-only harness setup</span></li></ol><div class="action-row"><a class="button primary" href="/context-pack" data-route="context-pack">Build context pack</a><a class="button secondary" href="/source-graph" data-route="source-graph">Preview source graph</a></div></section>`;
}

function renderRuns() {
  if (activeRunDetail) return renderRunDetail(activeRunDetail);
  return `<section class="surface"><div class="section-heading"><h2>Run history</h2><span>Stable links and current steps</span></div>${runList(dashboard?.runs)}</section>`;
}

function renderRunDetail(data) {
  const steps=summarizeRunSteps(data.events);
  const selectedStep=new URL(globalThis.location?.href ?? 'http://127.0.0.1/runs').searchParams.get('step');
  const manifest=[...data.events].reverse().find((event)=>event.type==='context.compiled')?.payload ?? dashboard?.latestManifest ?? null;
  return `<section class="run-detail"><div class="surface surface-primary"><div class="section-heading"><h2>${esc(data.run.workflowId)}</h2>${statusChip(data.run.status,data.run.status,'Run status')}</div><p>${esc(data.run.objective)}</p>${runFacts(data.run,steps,data.events)}<div class="section-heading"><h2>Step detail</h2><span>${steps.length} deterministic checkpoints</span></div>${stepDetailList(steps,selectedStep,data.run.id)}<div class="section-heading"><h2>Outcome</h2><span>Validated output</span></div>${angles(data.run.output?.output)}${data.run.verification?.valid?'<p class="verified-note"><strong>Evidence references verified</strong><span>Checked against selected context.</span></p>':''}</div><aside class="inspector"><div class="section-heading"><h2>Timeline</h2><span>${data.events.length} sanitized events</span></div>${stepRail(steps,data.run.id,selectedStep)}<hr>${manifest?contextSummary(manifest):'<p class="muted">No manifest linked to this run.</p>'}<div class="action-row"><a class="button secondary" href="/context">Open context inspector</a></div></aside></section><section class="surface"><div class="section-heading"><h2>Sanitized event trace</h2><span>No raw payload bodies</span></div>${eventTable(data.events)}</section>`;
}

function renderWorkflows() {
  const steps=['collect','normalize','analyze-patterns','compile-context','generate-angles','verify-recommendations','local-draft-outcome'];
  return `<section class="work-grid"><div class="surface surface-primary"><div class="section-heading"><h2>Content Intelligence</h2><span>workflow:content-intelligence</span></div><ol class="outline">${steps.map((step,index)=>`<li><span>${index+1}</span><strong>${step}</strong><em>${workflowStepCopy(step)}</em></li>`).join('')}</ol></div><aside class="inspector"><h2>Equivalent outline</h2><p>Graph information is presented as an ordered list for keyboard and screen-reader access.</p><dl class="facts"><div><dt>Risk</dt><dd>Read-only/local-only outputs</dd></div><div><dt>Timeout</dt><dd>5s deterministic steps, 120s model step</dd></div><div><dt>Approval</dt><dd>Local candidate approval record only</dd></div></dl></aside></section>`;
}

function renderFabricMap() {
  const model=buildFabricMapModel({dashboard,shellState,activeNodeId:activeFabricNode});
  return `<section class="fabric-stage" aria-label="Open Agent Fabric system map"><div class="fabric-hero surface"><div><p class="eyebrow">Runtime map</p><h2>Local agent fabric</h2><p>Process flow, context assembly, policy gates, and disabled external boundaries rendered from the current workspace state.</p></div><dl class="fabric-scoreboard" aria-label="Current fabric counts"><div><dt>Runs</dt><dd>${model.summary.runs}</dd></div><div><dt>Context</dt><dd>${model.summary.selectedRecords}/${model.summary.excludedRecords}</dd></div><div><dt>Evidence</dt><dd>${model.summary.evidenceCards}</dd></div><div><dt>Approvals</dt><dd>${model.summary.pendingApprovals}</dd></div><div><dt>Adapters</dt><dd>${model.summary.externalAdaptersEnabled}</dd></div></dl></div><div class="fabric-layout"><div class="surface surface-primary fabric-board"><div class="section-heading"><h2>Node conversation</h2><span>${model.links.filter((link)=>link.active).length} active links</span></div>${fabricNodeGrid(model)}${fabricLinkList(model.links)}</div><aside class="inspector fabric-inspector"><div class="section-heading"><h2>${esc(model.activeNode.label)}</h2>${fabricStatus(model.activeNode.status,model.activeNode.statusLabel)}</div><p>${esc(model.activeNode.detail)}</p><dl class="facts compact-facts">${model.activeNode.facts.map((fact)=>`<div><dt>${esc(fact.label)}</dt><dd>${esc(fact.value)}</dd></div>`).join('')}<div><dt>Route</dt><dd><a href="${esc(model.activeNode.route)}" data-route="${esc(routeByPath.get(model.activeNode.route)?.id ?? 'home')}">${esc(model.activeNode.route)}</a></dd></div></dl><hr><div class="section-heading"><h2>Safeguards</h2><span>default posture</span></div>${fabricSafeguards(model.safeguards)}</aside></div>${fabricContextFlow(model.contextFlow)}</section>`;
}

function fabricNodeGrid(model) {
  const lanes=[...new Set(model.nodes.map((node)=>node.lane))];
  return `<div class="fabric-node-grid">${lanes.map((lane)=>`<section class="fabric-lane" aria-label="${esc(titleize(lane))} lane"><h3>${esc(titleize(lane))}</h3><div>${model.nodes.filter((node)=>node.lane===lane).map((node)=>fabricNodeButton(node,model.activeNodeId)).join('')}</div></section>`).join('')}</div>`;
}

function fabricNodeButton(node,activeNodeId) {
  return `<button class="fabric-node fabric-node-${esc(node.status)}${node.id===activeNodeId?' is-active':''}" type="button" data-fabric-node="${esc(node.id)}" aria-pressed="${node.id===activeNodeId?'true':'false'}"><span class="fabric-node-top"><strong>${esc(node.label)}</strong>${fabricStatus(node.status,node.statusLabel)}</span><span>${esc(node.role)}</span><small>${node.facts.map((fact)=>`${esc(fact.label)}: ${esc(fact.value)}`).join(' · ')}</small></button>`;
}

function fabricLinkList(links) {
  return `<ol class="fabric-links" aria-label="Node handoff links">${links.map((link)=>`<li class="${link.active?'is-active':'is-waiting'}${link.blocked?' is-blocked':''}"><span>${esc(nodeLabel(link.from))}</span><strong>${esc(link.label)}</strong><span>${esc(nodeLabel(link.to))}</span></li>`).join('')}</ol>`;
}

function fabricContextFlow(flow) {
  const steps=[
    { label:'Candidates', value:flow.budgetAvailable ? `${flow.budgetUsed}/${flow.budgetAvailable} tokens` : 'waiting for manifest', detail:`Manifest ${flow.manifestId}` },
    { label:'Selection', value:`${flow.budgetPercent}% budget`, detail:`Compiler ${flow.compilerVersion}` },
    { label:'Assembly', value:`${flow.sections} sections`, detail:`Assembly ${shortFingerprint(flow.assemblyFingerprint)}` },
    { label:'Model reference', value:'manifest-bound', detail:`Manifest ${shortFingerprint(flow.manifestFingerprint)}` }
  ];
  return `<section class="surface fabric-context-flow" aria-label="Context assembly flow"><div class="section-heading"><h2>Context assembly flow</h2><span>No raw context bodies rendered</span></div><div class="flow-steps">${steps.map((step,index)=>`<article class="flow-step"><span>${index+1}</span><strong>${esc(step.label)}</strong><em>${esc(step.value)}</em><small>${esc(step.detail)}</small></article>`).join('')}</div></section>`;
}

function fabricSafeguards(safeguards) {
  return `<dl class="facts compact-facts"><div><dt>Network</dt><dd>${esc(safeguards.network)}</dd></div><div><dt>Model</dt><dd>${esc(safeguards.modelMode)}</dd></div><div><dt>External writes</dt><dd>${safeguards.externalWritesEnabled?'enabled':'disabled'}</dd></div><div><dt>External adapters</dt><dd>${Number(safeguards.externalAdaptersEnabled)}</dd></div><div><dt>Raw bodies</dt><dd>${safeguards.rawBodiesRendered?'rendered':'not rendered'}</dd></div></dl>`;
}

function fabricStatus(status,label) {
  return `<span class="fabric-status fabric-status-${esc(status)}"><span aria-hidden="true"></span>${esc(label)}</span>`;
}

function nodeLabel(id) {
  return FABRIC_NODES.find((node)=>node.id===id)?.label ?? titleize(id);
}

function renderContext() {
  const manifest=dashboard?.latestManifest;
  if(!manifest)return statePanel('empty','No context manifest yet','Run the local workflow to inspect selected and excluded records.',true);
  const model=buildContextInspectorModel(manifest);
  const params=new URL(globalThis.location?.href ?? 'http://127.0.0.1/context').searchParams;
  const recordId=params.get('record');
  const selectedRecord=recordId ? [...model.selected,...model.excluded].find((item)=>item.id===recordId) : null;
  return `<section class="context-hero surface"><div><p class="eyebrow">Context manifest</p><h2>${esc(model.id)}</h2><p>${esc(model.objective)}</p></div>${contextHeaderFacts(model)}</section>${selectedRecord?`<section class="surface"><div class="section-heading"><h2>Decision detail</h2><span>${esc(selectedRecord.selectedOrExcluded)}</span></div>${contextDecisionCard(selectedRecord,true)}</section>`:''}<section class="work-grid"><div class="surface surface-primary"><div class="section-heading"><h2>Selected</h2><span>${model.selected.length} records</span></div>${contextDecisionList(model.selected)}</div><aside class="inspector"><div class="section-heading"><h2>Excluded</h2><span>${model.excluded.length} records</span></div>${contextDecisionList(model.excluded)}</aside></section><section class="work-grid"><div class="surface"><div class="section-heading"><h2>Assembly</h2><span>${model.sections.length} sections</span></div>${assemblySections(model)}</div><aside class="inspector"><div class="section-heading"><h2>Comparison</h2><span>Selected vs assembly</span></div>${contextComparison(model)}<hr><div class="section-heading"><h2>Conflicts</h2><span>${model.conflicts.length}</span></div>${contextConflicts(model.conflicts)}</aside></section>`;
}

function renderContextPack() {
  const pack=contextPackResult?.pack ?? null;
  const markdown=contextPackResult?.markdown ?? '';
  const errorPanel=contextPackError?statePanel('error','Context pack failed',contextPackError,false):'';
  return `<section class="surface context-pack-guide" aria-label="Guided context pack builder"><div class="section-heading"><h2>Repo to agent handoff</h2><span>No server-side writes</span></div><ol class="guide-steps"><li><strong>1</strong><span>Choose sources</span></li><li><strong>2</strong><span>Name changed files</span></li><li><strong>3</strong><span>Inspect omissions and impact</span></li><li><strong>4</strong><span>Use it in your harness</span></li></ol></section><section class="work-grid"><div class="surface surface-primary"><div class="section-heading"><h2>Build context pack</h2><span>Current local repository</span></div><form id="context-pack-form" class="stacked-form"><div class="field-grid"><label class="field"><span>Target</span><select name="targetHarness"><option value="codex">Codex</option><option value="claude-code">Claude Code</option><option value="cursor">Cursor</option><option value="generic">Generic agent</option></select></label><label class="field"><span>Token budget</span><input name="tokenBudget" type="number" min="1" max="100000" value="4096" required></label></div>${contextPackSourceFamilyControls()}<label class="field"><span>Objective</span><textarea name="objective" required maxlength="2000">Prepare the next coding agent to continue Open Agent Fabric safely</textarea></label><label class="field"><span>Step</span><input name="step" value="select useful local handoff context" required maxlength="256"></label><label class="field"><span>Explicit relative files</span><textarea name="userSelectedFiles" maxlength="4000" placeholder="notes/handoff.md&#10;docs/context.md"></textarea></label><label class="field"><span>Changed relative files</span><textarea name="changedLocators" maxlength="4000" placeholder="apps/web/app.js&#10;services/control-api/src/server.mjs"></textarea></label><div class="action-row context-pack-detect-row"><button class="button secondary" data-action="detect-git-changes" type="button">Detect git changes</button><span class="muted" data-git-change-status>Read-only local git status. Review before building.</span></div><div class="action-row"><button class="button primary" type="submit">Build context pack</button><span class="muted">Dry run. Locators, hashes, and impact metadata only.</span></div></form></div><aside class="inspector"><h2>Pack boundary</h2><dl class="facts"><div><dt>Input</dt><dd>Selected harness project files, explicit relative files, and reviewed changed-file locators</dd></div><div><dt>Output</dt><dd>Markdown locator handoff with omission and impact hints</dd></div><div><dt>Browser</dt><dd>copy, download, or preview setup only</dd></div><div><dt>Server writes</dt><dd>none from this page</dd></div></dl>${localBoundary()}</aside></section>${errorPanel}${pack?renderContextPackResult(pack,markdown):statePanel('empty','No context pack yet','Build a context pack to get a concrete next-agent handoff for this repository.')}`;
}

function renderContextPackResult(pack,markdown) {
  const model=buildContextPackUiModel(pack,markdown,{observedDurationMs:contextPackResult?.observedDurationMs,readback:contextPackResult?.readback});
  const setupResult=harnessSetupResult?.client===model.setupClient?harnessSetupResult:null;
  const readiness=buildFirstUseReadinessModel({pack,markdown,readback:contextPackResult?.readback,setupResult});
  return `<section class="context-value-ledger" aria-label="Context pack proof metrics">${contextPackProofLedger(model.proof)}</section><section class="work-grid"><div class="surface surface-primary"><div class="section-heading"><h2>Handoff ready</h2><span title="${esc(pack.contextPackFingerprint)}">${esc(model.fingerprintShort)}</span></div><div class="artifact-actions"><button class="button primary" data-action="copy-pack" type="button">Copy markdown</button><button class="button secondary" data-action="download-pack" type="button">Download .md</button><button class="button secondary" data-action="preview-pack-setup" data-client="${esc(model.setupClient)}" type="button">Preview setup</button><a class="button secondary" href="/source-graph" data-route="source-graph">Inspect graph</a></div><textarea id="context-pack-output" class="pack-output" readonly>${esc(markdown)}</textarea></div><aside class="inspector">${contextPackReadinessPanel(readiness)}<hr><div class="section-heading"><h2>Use now</h2><span>${esc(pack.targetHarness)}</span></div>${contextPackCommandList(model.commands)}<hr><div class="section-heading"><h2>Intake review</h2><span>${esc(model.sourceFamilyLabel)}</span></div>${contextPackIntakeReview(model.intakeReview)}<hr><div class="section-heading"><h2>Readback proof</h2><span>${esc(model.proof.readbackFingerprintLabel)}</span></div>${contextPackReadbackProof(model.proof)}<hr><div class="section-heading"><h2>Change Impact</h2><span>${model.changedLocators}</span></div>${contextPackChangeImpact(pack.sourceGraph?.impact)}<hr><div class="section-heading"><h2>Selected locators</h2><span>${pack.readFirst.length}</span></div>${contextPackLocatorList(pack.readFirst)}<hr><div class="section-heading"><h2>Omitted refs</h2><span>${Number(pack.omissions?.excludedCount??0)}</span></div>${contextPackOmissionList(pack.omissions)}<hr><div class="section-heading"><h2>Graph hints</h2><span>${esc(pack.sourceGraph?.status??'unavailable')}</span></div>${contextPackSourceGraphList(pack.sourceGraph)}<hr><div class="section-heading"><h2>Warnings</h2><span>${model.warningCount}</span></div>${reasons(pack.warnings)}<hr><dl class="facts"><div><dt>Target</dt><dd>${esc(pack.targetHarness)}</dd></div><div><dt>Candidate tokens</dt><dd>${Number(pack.preview.candidateTokenCount??0)}</dd></div><div><dt>Selected source tokens</dt><dd>${Number(pack.preview.selectedTokenCount??0)} (${esc(model.selectedTokenRatio)})</dd></div><div><dt>Delivered handoff tokens</dt><dd>${model.deliveredTokens} (${esc(model.deliveredTokenRatio)})</dd></div><div><dt>Delivery reduction</dt><dd>${esc(model.deliveryReductionPercent)}</dd></div><div><dt>Observed build time</dt><dd>${esc(model.proof.observedDurationLabel)}</dd></div><div><dt>External writes</dt><dd>disabled</dd></div></dl></aside></section>${setupResult?renderHarnessSetupResult(setupResult):''}`;
}

export function buildContextPackUiModel(pack,markdown='',meta={}) {
  const candidateTokens=Number(pack?.preview?.candidateTokenCount ?? 0);
  const selectedTokens=Number(pack?.preview?.selectedTokenCount ?? 0);
  const deliveredTokens=Number(pack?.delivery?.deliveredTokenCount ?? 0);
  const sourceFamilies=contextPackSourceFamilies(pack);
  const observedDurationMs=Number(meta?.observedDurationMs);
  const observedDurationLabel=Number.isFinite(observedDurationMs) ? `${Math.max(0,Math.round(observedDurationMs))} ms` : 'not measured';
  const readback=meta?.readback ?? null;
  const readbackDurationMs=Number(readback?.measurements?.durationMs);
  const readbackDurationLabel=Number.isFinite(readbackDurationMs) ? `${Math.max(0,Math.round(readbackDurationMs))} ms` : 'not run';
  const readbackResourceBytes=Number(readback?.measurements?.resourceByteSize);
  const readbackResourceBytesLabel=Number.isFinite(readbackResourceBytes) ? `${Math.max(0,Math.round(readbackResourceBytes))} bytes` : 'not measured';
  const readbackFingerprintLabel=readback?.checks?.contextPackFingerprintMatches===true?'match':'check';
  const estimatedReductionPercent=candidateTokens > 0
    ? Math.max(0,Math.min(100,Math.round((1 - selectedTokens / candidateTokens) * 100)))
    : 0;
  const deliveryReductionPercent=candidateTokens > 0
    ? Math.max(0,Math.min(100,Math.round((1 - deliveredTokens / candidateTokens) * 100)))
    : 0;
  const rawBodiesExcluded=pack?.delivery?.sourceContentsIncluded===false && pack?.safeguards?.rawBodyIncluded===false;
  return {
    targetHarness:String(pack?.targetHarness ?? 'generic'),
    sourceFamilies,
    sourceFamilyLabel:sourceFamilies.join(', '),
    markdownBytes:new Blob([String(markdown)]).size,
    selectedLocators:Array.isArray(pack?.readFirst) ? pack.readFirst.length : 0,
    omittedRefs:Number(pack?.omissions?.excludedCount ?? 0),
    selectedTokens,
    deliveredTokens,
    candidateTokens,
    estimatedReductionPercent,
    downloadName:contextPackDownloadName(pack),
    excludedTokens:Number(pack?.omissions?.excludedTokenCount ?? 0),
    sourceGraphOmittedCount:Number(pack?.omissions?.sourceGraphOmittedCount ?? 0),
    warningCount:Array.isArray(pack?.warnings) ? pack.warnings.length : 0,
    selectedTokenRatio:candidateTokens > 0 ? `${Math.round(selectedTokens / candidateTokens * 100)}%` : '0%',
    deliveredTokenRatio:candidateTokens > 0 ? `${Math.round(deliveredTokens / candidateTokens * 100)}%` : '0%',
    deliveryReductionPercent:`${deliveryReductionPercent}%`,
    fingerprintShort:shortFingerprint(pack?.contextPackFingerprint ?? ''),
    changedLocators:Array.isArray(pack?.sourceGraph?.impact?.changedLocators) ? pack.sourceGraph.impact.changedLocators.length : 0,
    affectedSymbols:Number(pack?.sourceGraph?.impact?.affectedSymbolCount ?? 0),
    setupClient:contextPackSetupClient(pack),
    intakeReview:buildContextPackIntakeReview(pack),
    proof:{
      tokenSaved:`${deliveryReductionPercent}%`,
      selectedTokenRatio:candidateTokens > 0 ? `${Math.round(selectedTokens / candidateTokens * 100)}%` : '0%',
      deliveredTokens:String(deliveredTokens),
      observedDurationLabel,
      readbackDurationLabel,
      readbackResourceBytesLabel,
      readbackFingerprintLabel,
      readbackScope:String(readback?.measurementScope ?? 'not run'),
      readbackTransport:String(readback?.transport ?? 'not run'),
      readbackToolsLabel:safeguardCountLabel(readback?.bridge?.toolsExposed),
      rawBodiesLabel:rawBodiesExcluded?'excluded':'check',
      modelCallsLabel:safeguardCountLabel(pack?.safeguards?.modelCalls),
      networkCallsLabel:safeguardCountLabel(pack?.safeguards?.networkCalls),
      externalWritesLabel:pack?.safeguards?.externalWritesEnabled===false?'disabled':pack?.safeguards?.externalWritesEnabled===true?'enabled':'check',
      activeMemoryLabel:safeguardCountLabel(pack?.safeguards?.activeMemoryCreated)
    },
    commands:contextPackHarnessCommands(pack)
  };
}

function contextPackSourceFamilies(pack) {
  const values=Array.isArray(pack?.sourceHarnesses) ? pack.sourceHarnesses : [];
  const allowed=new Set(CONTEXT_PACK_SOURCE_FAMILIES.map(([id])=>id));
  const selected=values.map(String).filter((value)=>allowed.has(value));
  return selected.length ? [...new Set(selected)] : ['codex'];
}

function buildContextPackIntakeReview(pack) {
  const memoryPlan=pack?.memoryPlan ?? {};
  const items=Array.isArray(memoryPlan.items) ? memoryPlan.items : [];
  return {
    acceptedCount:Array.isArray(pack?.readFirst) ? pack.readFirst.length : 0,
    excludedCount:Array.isArray(pack?.excluded) ? pack.excluded.length : Number(pack?.omissions?.excludedCount ?? 0),
    omittedCount:Number(pack?.omissions?.excludedCount ?? 0),
    proposedCount:Number.isInteger(memoryPlan.proposedCount) ? memoryPlan.proposedCount : items.filter((item)=>item?.action==='would_propose').length,
    quarantinedCount:Number.isInteger(memoryPlan.quarantinedCount) ? memoryPlan.quarantinedCount : items.filter((item)=>item?.action==='would_quarantine').length,
    activeMemoryCreated:Number(pack?.safeguards?.activeMemoryCreated ?? memoryPlan.activeMemoryCreated ?? 0)
  };
}

export function buildFirstUseReadinessModel({pack=null,markdown='',readback=null,setupResult=null} = {}) {
  const selectedLocators=Array.isArray(pack?.readFirst) ? pack.readFirst.length : 0;
  const markdownReady=String(markdown??'').trim().length > 0;
  const hasPack=Boolean(pack?.contextPackFingerprint);
  const readbackMatched=readback?.checks?.contextPackFingerprintMatches === true;
  const noMarkdownBody=readback?.checks?.noMarkdownBody === true;
  const noToolsExposed=readback?.checks?.noToolsExposed === true && zeroCount(readback?.bridge?.toolsExposed);
  const rawBodiesExcluded=pack?.delivery?.sourceContentsIncluded === false && pack?.safeguards?.rawBodyIncluded === false;
  const noSideEffects=pack?.safeguards?.externalWritesEnabled === false && zeroCount(pack?.safeguards?.networkCalls) && zeroCount(pack?.safeguards?.modelCalls);
  const noActiveMemory=zeroCount(pack?.safeguards?.activeMemoryCreated);
  const setupPreviewed=Boolean(setupResult);
  const setupPreviewSafe=setupPreviewed
    && setupResult?.dryRun === true
    && zeroCount(setupResult?.safeguards?.localFilesWritten)
    && setupResult?.safeguards?.externalWritesEnabled === false
    && zeroCount(setupResult?.safeguards?.networkCalls)
    && setupResult?.safeguards?.rawConfigBodyIncluded === false;
  const gates=[
    readinessGate('artifact','Pack artifact',hasPack && markdownReady,'Markdown handoff is generated in the browser for copy or download.'),
    readinessGate('selection','Selected context',selectedLocators > 0,`${selectedLocators} safe local locator${selectedLocators===1?'':'s'} selected.`),
    readinessGate('readback','MCP readback',readbackMatched && noMarkdownBody,'Read-only resource matches the generated pack and omits markdown bodies.'),
    readinessGate('resource-tools','Resource tools',noToolsExposed,'The context-pack MCP resource exposes zero tools.'),
    readinessGate('raw-bodies','Raw bodies',rawBodiesExcluded,'Source bodies stay out of the pack, shell, and MCP summary.'),
    readinessGate('side-effects','Side effects',noSideEffects,'Model calls, network calls, and external writes remain off.'),
    readinessGate('memory','Memory import',noActiveMemory,'Harness context can propose memory, but creates no active memory.'),
    readinessGate('setup-preview','Setup preview',setupPreviewed ? setupPreviewSafe : null,setupPreviewed ? 'Dry-run harness setup preview remains redacted.' : 'Optional: preview the read-only MCP setup plan before editing any harness config.',setupPreviewed)
  ];
  const blocking=gates.find((gate)=>gate.blocking);
  const ready=!blocking;
  return {
    ready,
    title:ready?'Ready for local handoff':'Review before handoff',
    status:ready?'ready':'blocked',
    copy:ready
      ? 'Copy the markdown into your next local agent, or preview setup if you want a read-only MCP resource.'
      : 'Do not hand this to another agent until the failed gate is fixed.',
    nextAction:ready
      ? (setupPreviewed ? 'Use Copy markdown, Download .md, or the previewed read-only MCP command.' : 'Use Copy markdown now. Preview setup only if you want MCP resource discovery.')
      : `Fix: ${blocking.label}.`,
    gates
  };
}

function readinessGate(id,label,passed,detail,required=true) {
  const status=passed === true ? 'pass' : passed === null ? 'pending' : 'failed';
  return { id, label, status, detail, required, blocking:required && status !== 'pass' };
}

function zeroCount(value) {
  const number=Number(value);
  return Number.isFinite(number) && number === 0;
}

function contextPackHarnessCommands(pack) {
  const target=String(pack?.targetHarness ?? 'generic');
  const objective=quoteShell(pack?.objective ?? 'Ship safely');
  const step=quoteShell(pack?.step ?? 'select context');
  const from=quoteShell(contextPackSourceFamilies(pack).join(','));
  const selected=(pack?.memoryPlan?.items ?? [])
    .filter((item)=>String(item?.locator ?? '').startsWith('user-selected://'))
    .map((item)=>` --include-file ${quoteShell(String(item.locator).replace(/^user-selected:\/\//u,''))}`)
    .join('');
  const changed=(pack?.sourceGraph?.impact?.changedLocators ?? []).map((locator)=>` --changed ${quoteShell(locator.replace(/^workspace:\/\//u,''))}`).join('');
  const setupClient=contextPackSetupClient(pack);
  return [
    { label:'Rebuild from CLI', command:`npm run oaf -- context pack --from ${from} --root . --objective ${objective} --step ${step} --target ${target}${selected}${changed} --dry-run --format markdown` },
    { label:'Preview harness setup', command:`npm run oaf -- harness setup plan --client ${setupClient} --server oaf --dry-run --format json` },
    { label:'Read current context pack', command:`npm run oaf -- mcp resources --read-only --context-pack --from ${from} --root . --objective ${objective} --step ${step} --target ${target}${selected}${changed} --uri oaf://workspace/ws_local/context-pack/current --format json` },
    { label:'Read MCP resources', command:'npm run oaf -- mcp resources --read-only --format json' },
    { label:'Read latest handoff', command:'npm run oaf -- mcp resources --read-only --uri oaf://workspace/ws_local/handoff/latest --format json' }
  ];
}

function contextPackSetupClient(pack) {
  const target=String(pack?.targetHarness ?? 'codex');
  return target === 'cursor' || target === 'claude-code' || target === 'codex' ? target : 'codex';
}

function contextPackCommandList(commands) {
  return `<ol class="command-list">${commands.map((item)=>`<li><strong>${esc(item.label)}</strong><code>${esc(item.command)}</code></li>`).join('')}</ol>`;
}

const CONTEXT_PACK_SOURCE_FAMILIES=[
  ['codex','Codex'],
  ['claude-code','Claude Code'],
  ['cursor','Cursor']
];

function contextPackSourceFamilyControls() {
  return `<fieldset class="source-family-field"><legend>Source families</legend><div class="source-family-options">${CONTEXT_PACK_SOURCE_FAMILIES.map(([id,label],index)=>`<label><input type="checkbox" name="sourceFamilies" value="${esc(id)}"${index===0?' checked':''}><span>${esc(label)}</span></label>`).join('')}</div></fieldset>`;
}

function contextPackSelectedSourceFamilies(form) {
  const selected=[...form.querySelectorAll('input[name="sourceFamilies"]:checked')]
    .map((input)=>String(input.value))
    .filter((value)=>CONTEXT_PACK_SOURCE_FAMILIES.some(([id])=>id===value));
  return selected.length ? selected : ['codex'];
}

function contextPackIntakeReview(review) {
  return `<dl class="facts compact-facts intake-review"><div><dt>Accepted</dt><dd>${Number(review.acceptedCount??0)}</dd></div><div><dt>Excluded</dt><dd>${Number(review.excludedCount??0)}</dd></div><div><dt>Omitted</dt><dd>${Number(review.omittedCount??0)}</dd></div><div><dt>Would propose</dt><dd>${Number(review.proposedCount??0)}</dd></div><div><dt>Quarantine</dt><dd>${Number(review.quarantinedCount??0)}</dd></div><div><dt>Active memory</dt><dd>${Number(review.activeMemoryCreated??0)}</dd></div></dl>`;
}

function contextPackProofLedger(proof) {
  return [
    ledgerItem(proof.tokenSaved,'Handoff reduction','Estimated local tokens'),
    ledgerItem(proof.selectedTokenRatio,'Source kept','Estimated source tokens'),
    ledgerItem(proof.observedDurationLabel,'Build time','Observed local request'),
    ledgerItem(proof.readbackDurationLabel,'MCP readback','In-process bridge'),
    ledgerItem(proof.rawBodiesLabel,'Raw bodies','Schema safeguard'),
    ledgerItem(proof.readbackToolsLabel,'Tools exposed','Read-only resource'),
    ledgerItem(proof.externalWritesLabel,'External writes','Global gate')
  ].join('');
}

function contextPackReadbackProof(proof) {
  return `<dl class="facts compact-facts"><div><dt>Transport</dt><dd>${esc(proof.readbackTransport)}</dd></div><div><dt>Scope</dt><dd>${esc(proof.readbackScope)}</dd></div><div><dt>Fingerprint</dt><dd>${esc(proof.readbackFingerprintLabel)}</dd></div><div><dt>Resource</dt><dd>${esc(proof.readbackResourceBytesLabel)}</dd></div><div><dt>Tools</dt><dd>${esc(proof.readbackToolsLabel)}</dd></div></dl>`;
}

function contextPackReadinessPanel(readiness) {
  const chip=statusChip(readiness.ready?'success':'partial',readiness.title,readiness.ready?'critical gates passed':'blocked gate');
  return `<div class="readiness-panel" aria-label="First-use readiness"><div class="section-heading"><h2>First-use readiness</h2>${chip}</div><p>${esc(readiness.copy)}</p><ol class="readiness-list">${readiness.gates.map((gate)=>`<li class="readiness-${esc(gate.status)}"><strong>${esc(gate.status)}</strong><span><b>${esc(gate.label)}</b><small>${esc(gate.detail)}</small></span></li>`).join('')}</ol><p class="readiness-next"><strong>Next:</strong> ${esc(readiness.nextAction)}</p></div>`;
}

function safeguardCountLabel(value) {
  return Number.isInteger(value) && value >= 0 ? String(value) : 'check';
}

export function contextPackDownloadName(pack) {
  const target=String(pack?.targetHarness ?? 'generic').replace(/[^A-Za-z0-9._-]/g,'-');
  const date=String(pack?.createdAt ?? new Date().toISOString()).slice(0,10);
  return `open-agent-fabric-context-pack-${target}-${date}.md`;
}

function contextPackLocatorList(items) {
  if(!items?.length)return '<p class="muted">No selected locators.</p>';
  return `<ol class="compact-list locator-list">${items.map((item)=>`<li><strong>${esc(item.locator)}</strong><span>${esc(item.reasonCodes.join(', '))}</span></li>`).join('')}</ol>`;
}

function contextPackOmissionList(omissions) {
  const refs=omissions?.refs??[];
  if(!refs.length)return '<p class="muted">No omitted context refs.</p>';
  return `<ol class="compact-list locator-list">${refs.slice(0,6).map((item)=>`<li><strong>${esc(item.locator)}</strong><span>${esc(item.id)} · ${Number(item.tokens??0)} tokens · ${esc(item.reasonCodes.join(', '))}</span><small>${esc(item.recoveryHint)}</small></li>`).join('')}</ol>`;
}

function contextPackSourceGraphList(sourceGraph) {
  const results=sourceGraph?.results??[];
  const summary=sourceGraph?.summary;
  if(!results.length){
    const label=summary?`${Number(summary.fileCount??0)} files · ${Number(summary.symbolCount??0)} symbols`:'No source graph preview.';
    return `<p class="muted">${esc(label)}</p>`;
  }
  return `<ol class="compact-list locator-list">${results.map((item)=>`<li><strong>${esc(item.locator)}</strong><span>${esc(item.kind)} · ${esc(item.label)} · ${Number(item.score??0).toFixed(3)}</span></li>`).join('')}</ol>`;
}

function contextPackChangeImpact(impact={}) {
  const changed=impact?.changedLocators ?? [];
  const symbols=impact?.affectedSymbols ?? [];
  if(!changed.length)return '<p class="muted">No changed files were supplied for impact mapping.</p>';
  return `<ol class="compact-list locator-list">${changed.map((locator)=>`<li><strong>${esc(locator)}</strong><span>explicit changed file</span></li>`).join('')}</ol>${symbols.length?`<ol class="compact-list locator-list">${symbols.slice(0,6).map((item)=>`<li><strong>${esc(item.name)}</strong><span>${esc(item.symbolKind)} · ${esc(item.locator)}</span></li>`).join('')}</ol>`:'<p class="muted">No affected symbols found for the supplied locators.</p>'}`;
}

function ledgerItem(value,label,copy){return `<div><strong>${esc(value)}</strong><span>${esc(label)}</span><small>${esc(copy)}</small></div>`}

export function parseSelectedFiles(value) {
  return [...new Set(String(value??'').split(/[,\n]/u).map((item)=>item.trim()).filter(Boolean))];
}

function renderSourceGraph() {
  const errorPanel=sourceGraphError?statePanel('error','Source graph preview failed',sourceGraphError,false):'';
  return `<section class="work-grid"><div class="surface surface-primary"><div class="section-heading"><h2>Preview source graph</h2><span>Current local repository</span></div><form id="source-graph-form" class="stacked-form"><label class="field"><span>Query</span><input name="query" value="context graph preview" maxlength="512"></label><div class="field-grid"><label class="field"><span>Trace symbol</span><input name="startName" placeholder="runAuthWorkflow" maxlength="240"></label><label class="field"><span>Changed locator</span><input name="changedLocator" placeholder="src/auth.ts" maxlength="512"></label></div><div class="field-grid"><label class="field"><span>Limit</span><input name="limit" type="number" min="1" max="100" value="8"></label><label class="field"><span>Depth</span><input name="depth" type="number" min="1" max="5" value="2"></label></div><div class="action-row"><button class="button primary" type="submit">Preview graph</button><span class="muted">Dry-run metadata only</span></div></form></div><aside class="inspector"><h2>Graph boundary</h2><dl class="facts"><div><dt>State</dt><dd>not persisted</dd></div><div><dt>Model calls</dt><dd>0</dd></div><div><dt>External writes</dt><dd>disabled</dd></div></dl>${localBoundary()}</aside></section>${errorPanel}${sourceGraphResult?renderSourceGraphResult(sourceGraphResult):statePanel('empty','No graph preview yet','Run a source graph preview to inspect symbols, calls, and likely diff impact.')}`;
}

function renderSourceGraphResult(report) {
  const summary=report.graph?.summary ?? {};
  return `<section class="metric-strip" aria-label="Source graph metrics">${metric(summary.fileCount??0,'Files','Scanned JS/TS')}${metric(summary.symbolCount??0,'Symbols','Static parser')}${metric(summary.nodeCount??0,'Nodes','Metadata graph')}${metric(summary.edgeCount??0,'Edges','Calls and refs')}</section><section class="work-grid"><div class="surface surface-primary"><div class="section-heading"><h2>Search results</h2><span>${Number(report.search?.total??0)} matches</span></div>${sourceGraphSearchList(report.search?.results)}</div><aside class="inspector"><div class="section-heading"><h2>Safeguards</h2><span>${esc(shortFingerprint(report.graph?.graphFingerprint))}</span></div>${sourceGraphSafeguards(report.safeguards)}<hr><div class="section-heading"><h2>Sample nodes</h2><span>${report.graph?.sampleNodes?.length??0}</span></div>${sourceGraphNodeList(report.graph?.sampleNodes)}</aside></section><section class="work-grid"><div class="surface"><div class="section-heading"><h2>Trace</h2><span>${report.trace?.paths?.length??0} paths</span></div>${sourceGraphTraceList(report.trace?.paths)}</div><aside class="inspector"><div class="section-heading"><h2>Diff impact</h2><span>${report.impact?.affectedSymbols?.length??0} symbols</span></div>${sourceGraphImpactList(report.impact?.affectedSymbols)}</aside></section>`;
}

function sourceGraphSearchList(results=[]) {
  if(!results.length)return '<p class="muted">No matching graph records.</p>';
  return `<ol class="compact-list locator-list">${results.map((item)=>`<li><strong>${esc(item.label)}</strong><span>${esc(item.kind)} · ${esc(item.locator??'no locator')} · ${Number(item.score??0).toFixed(3)}</span></li>`).join('')}</ol>`;
}

function sourceGraphNodeList(nodes=[]) {
  if(!nodes.length)return '<p class="muted">No sample nodes.</p>';
  return `<ol class="compact-list locator-list">${nodes.map((node)=>`<li><strong>${esc(node.label)}</strong><span>${esc(node.kind)} · ${esc(node.locator??node.sourceRef??node.id)}</span></li>`).join('')}</ol>`;
}

function sourceGraphTraceList(paths=[]) {
  if(!paths.length)return '<p class="muted">No trace paths for the selected symbol.</p>';
  return `<ol class="compact-list locator-list">${paths.map((path)=>`<li><strong>${esc(path.terminalLabel)}</strong><span>depth ${Number(path.depth??0)} · ${path.nodeIds?.length??0} nodes</span></li>`).join('')}</ol>`;
}

function sourceGraphImpactList(symbols=[]) {
  if(!symbols.length)return '<p class="muted">No impacted symbols for the supplied locator.</p>';
  return `<ol class="compact-list locator-list">${symbols.map((symbol)=>`<li><strong>${esc(symbol.name)}</strong><span>${esc(symbol.symbolKind)} · ${esc(symbol.locator)}</span></li>`).join('')}</ol>`;
}

function sourceGraphSafeguards(safeguards={}) {
  return `<dl class="facts compact-facts"><div><dt>Persisted</dt><dd>${safeguards.persisted?'yes':'no'}</dd></div><div><dt>Model calls</dt><dd>${Number(safeguards.modelCalls??0)}</dd></div><div><dt>Network</dt><dd>${Number(safeguards.networkCalls??0)}</dd></div><div><dt>Graph DB</dt><dd>${safeguards.graphDatabaseUsed?'yes':'no'}</dd></div><div><dt>Raw bodies</dt><dd>${safeguards.rawBodyIncluded?'included':'excluded'}</dd></div></dl>`;
}

function renderMemory() {
  const memories=buildMemoryReviewModel({memories:dashboard?.memories});
  return `<section class="work-grid"><div class="surface surface-primary"><div class="section-heading"><h2>Memory diffs</h2><span>${memories.length} reviewable records</span></div>${memoryDiffList(memories)}</div><aside class="inspector"><h2>Lifecycle states</h2><ol class="compact-list"><li>Observed</li><li>Proposed</li><li>Verified</li><li>Active</li><li>Superseded / retracted / expired</li></ol><hr><p class="muted">Memory remains proposal-first. Raw source bodies, credentials, local paths, and hidden reasoning are not rendered.</p></aside></section>`;
}

function renderEvidence() {
  const items=buildEvidenceExplorerModel({latestManifest:dashboard?.latestManifest,latestRun:dashboard?.latestRun,evidenceGraph:dashboard?.evidenceGraph});
  if(!items.length)return statePanel('empty','No selected evidence yet','Run the local workflow to inspect source-backed observations.',true);
  return `<section class="surface"><div class="section-heading"><h2>Evidence explorer</h2><span>Observation separate from inference</span></div><div class="evidence-list">${items.map(evidenceCard).join('')}</div></section>`;
}

function renderApprovals() {
  const approvals=buildApprovalReviewModel({approvals:dashboard?.approvals});
  const pending=approvals.filter((approval)=>approval.status==='pending').length;
  return `<section class="work-grid"><div class="surface surface-primary"><div class="section-heading"><h2>Approval inbox</h2><span>${pending} pending</span></div>${approvalCardList(approvals)}</div><aside class="inspector"><h2>Publisher boundary</h2><p>Publishing remains disabled. Approval cards are exact previews only; no external write action is available in this shell.</p>${statusChip('disabled','External writes disabled','Global kill switch')}</aside></section>`;
}

function renderContentLab() {
  const latest=dashboard?.latestRun;
  return `<section class="work-grid"><div class="surface surface-primary"><div class="section-heading"><h2>Candidate drafts</h2><span>Local workflow</span></div>${angles(latest?.output?.output)}</div><aside class="inspector"><h2>Local outcome</h2><dl class="facts"><div><dt>Approval</dt><dd>Bound to candidate, evidence, schema, prompt, and context</dd></div><div><dt>Draft</dt><dd>Local-only, publisher disabled</dd></div><div><dt>Outcome</dt><dd>Edit distance and objective metric, no causal claim</dd></div></dl></aside></section>`;
}

function renderAgentsTools() {
  const errorPanel=harnessSetupError?statePanel('error','Harness setup preview failed',harnessSetupError,false):'';
  const selectedClient=harnessSetupResult?.client ?? 'codex';
  return `<section class="work-grid"><div class="surface surface-primary"><div class="section-heading"><h2>Native baselines</h2><span>Conformance anchors</span></div><div class="table-wrap"><table><thead><tr><th>Surface</th><th>Status</th><th>Boundary</th></tr></thead><tbody>${[['Model gateway','reference','deterministic default'],['Workflow runtime','reference','embedded + durable SQLite'],['Tool broker','reference','one-use local grants'],['External adapters','disabled','12 contracts, 0 enabled']].map(row=>`<tr><td>${row[0]}</td><td>${row[1]}</td><td>${row[2]}</td></tr>`).join('')}</tbody></table></div></div><aside class="inspector"><h2>Tool policy</h2><p>Policy, grants, filesystem, loopback egress, and secret references remain independently brokered.</p></aside></section><section class="work-grid"><div class="surface surface-primary"><div class="section-heading"><h2>Harness setup preview</h2><span>Dry run only</span></div><form id="harness-setup-form" class="stacked-form"><label class="field"><span>Client</span><select name="client">${harnessSetupClientsForUi().map(([id,label])=>`<option value="${esc(id)}"${id===selectedClient?' selected':''}>${esc(label)}</option>`).join('')}</select></label><div class="action-row"><button class="button primary" type="submit">Preview setup</button><span class="muted">No home config writes. OAF server only.</span></div></form></div><aside class="inspector"><h2>Setup boundary</h2><dl class="facts"><div><dt>API body</dt><dd>workspace and client only</dd></div><div><dt>Server</dt><dd>oaf</dd></div><div><dt>Mode</dt><dd>plan-only dry run</dd></div><div><dt>Bridge</dt><dd>read-only MCP resources</dd></div></dl></aside></section>${errorPanel}${harnessSetupResult?renderHarnessSetupResult(harnessSetupResult):statePanel('empty','No setup preview yet','Choose a local harness client to see the redacted MCP setup plan.')}`;
}

function renderHarnessSetupResult(report) {
  const model=buildHarnessSetupUiModel(report);
  return `<section class="work-grid"><div class="surface surface-primary"><div class="section-heading"><h2>${esc(model.client)} setup plan</h2><span>${esc(shortFingerprint(model.fingerprint))}</span></div><dl class="facts facts-wide"><div><dt>Config</dt><dd>${esc(model.configRef)}</dd></div><div><dt>Config status</dt><dd>${esc(model.configStatus)}</dd></div><div><dt>OAF server</dt><dd>${esc(model.serverStatus)}</dd></div><div><dt>Operation</dt><dd>${esc(model.operation)}</dd></div></dl><ol class="command-list"><li><strong>CLI preview</strong><code>${esc(model.command)}</code></li><li><strong>Read-only bridge</strong><code>${esc(model.bridgeCommand)}</code></li></ol></div><aside class="inspector"><div class="section-heading"><h2>Safeguards</h2><span>redacted</span></div><dl class="facts compact-facts">${model.safeguards.map(([label,value])=>`<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl><hr><p class="muted">This preview does not print raw config bodies, credentials, provider URLs, absolute local paths, or hidden reasoning.</p></aside></section>`;
}

function renderSettings() {
  return `<section class="work-grid"><div class="surface surface-primary"><div class="section-heading"><h2>Local system</h2><span>Shared tokens</span></div><div class="token-grid">${[['Ink','--ink'],['Paper','--paper'],['Signal','--signal'],['Proof','--proof'],['Caution','--caution'],['Danger','--danger'],['Success','--success']].map(([name,token])=>`<div class="swatch" style="background:var(${token})"><strong>${name}<code>${token}</code></strong></div>`).join('')}</div></div><aside class="inspector"><h2>Defaults</h2>${localBoundary()}</aside></section>`;
}

function metric(value,label,copy){return `<div class="metric"><strong>${Number(value??0)}</strong><span>${label}</span><small>${copy}</small></div>`}
function statusChip(kind,label,description){return `<span class="status-chip status-${esc(kind)}"><strong>${esc(label)}</strong><small>${esc(description)}</small></span>`}
function localBoundary(){return `<dl class="facts"><div><dt>Residency</dt><dd>Local-only</dd></div><div><dt>Network</dt><dd>Denied by default</dd></div><div><dt>Writes</dt><dd>External writes disabled</dd></div><div><dt>Model</dt><dd>Deterministic offline default</dd></div></dl>`}
function statePanel(kind,heading,copy,button=false){return `<section class="state-panel state-${esc(kind)}" aria-live="${kind==='loading'?'polite':'off'}"><h2>${esc(heading)}</h2><p>${esc(copy)}</p>${button?'<div class="action-row"><button class="button primary" data-action="run" type="button">Run local demo</button><button class="button secondary" data-action="reset" type="button">Reset demo</button></div>':''}</section>`}
function deniedState(){return authPanel('login','Sign in with the local owner account for this workspace.')}
function authPanel(mode,copy){
  const isBootstrap=mode==='bootstrap';
  const title=isBootstrap?'Set up local owner':'Sign in locally';
  return `<section class="state-panel state-${isBootstrap?'setup':'denied'} auth-panel"><h2>${title}</h2><p>${esc(copy)}</p><form id="auth-form" data-mode="${mode}" autocomplete="on"><div class="field-grid"><label class="field"><span>Username</span><input name="username" autocomplete="username" value="${isBootstrap?'rebel':''}" required maxlength="80" pattern="[A-Za-z0-9._:\\-]{1,80}"></label>${isBootstrap?'<label class="field"><span>Display name</span><input name="displayName" autocomplete="name" value="Rebel" required maxlength="120"></label>':''}<label class="field"><span>Password</span><input name="password" type="password" autocomplete="${isBootstrap?'new-password':'current-password'}" required minlength="12" maxlength="256"></label></div><div class="action-row"><button class="button primary" type="submit">${isBootstrap?'Create owner':'Sign in'}</button>${isBootstrap?'<span class="muted">Local-only. Stored in .local/identity with hashed credentials.</span>':'<span class="muted">No external network or fallback identity provider is used.</span>'}</div></form></section>`;
}
function runList(items){if(!items?.length)return statePanel('empty','No runs yet','Execute the synthetic local workflow to populate the event ledger.',true);return `<div class="run-list">${items.map(run=>`<article class="run-row"><header><a href="${runDetailLink(run.id)}" data-run-id="${esc(run.id)}">${esc(run.workflowId)}</a>${statusChip(run.status,run.status,'Run status')}</header><p>${esc(run.objective??'')}</p><div class="meta-row"><span>Version: ${esc(run.workflowVersion??'unknown')}</span><span>Residency: ${esc(run.residency??'local-only')}</span><span>Current step: ${esc(currentStepLabel(run))}</span><span>Owner: local workspace</span><span>Warnings: ${Number(run.warningCount??0)}</span></div><div class="meta-row"><code>${esc(run.id)}</code><span>Started ${date(run.createdAt)}</span><span>${duration(run.createdAt,run.completedAt)}</span></div></article>`).join('')}</div>`}
function contextSummary(manifest){if(!manifest)return '<div class="state-inline">No context has been compiled.</div>';const percent=Math.min(100,Math.round(manifest.budget.used/manifest.budget.available*100));return `<div class="section-heading"><h2>Context budget</h2><span>${percent}% used</span></div><strong>${manifest.budget.used} / ${manifest.budget.available} estimated tokens</strong><div class="progress" aria-label="${percent}% of context budget used"><span style="width:${percent}%"></span></div><p class="muted">${manifest.selected.length} selected · ${manifest.excluded.length} excluded · ${manifest.conflicts.length} conflicts</p>`}
function angles(items){if(!Array.isArray(items)||!items.length)return statePanel('empty','No candidates yet','Run the demo to generate evidence-backed candidates.');return `<div class="angle-list">${items.map(item=>`<article class="angle-row"><h3>${esc(item.angle)}</h3><p>${esc(item.hook)}</p><div class="meta-row"><span>Evidence: ${item.evidenceIds.map(esc).join(', ')||'none'}</span><span>Confidence: ${Math.round(Number(item.confidence??0)*100)}%</span></div></article>`).join('')}</div>`}
function reasons(items=[]){return `<div class="reason-list">${items.map(reason=>`<span class="reason">${esc(reason)}</span>`).join('')}</div>`}
function workflowStepCopy(step){return ({collect:'read bounded local/caller-supplied sources',normalize:'separate observed data from inference','analyze-patterns':'compute lifecycle and copying risk','compile-context':'persist selected/excluded context manifest','generate-angles':'schema-validated local model output','verify-recommendations':'citation verification','local-draft-outcome':'local approval, draft, and outcome record'})[step] ?? 'deterministic step'}

function runFacts(run,steps,events){
  return `<dl class="facts facts-wide"><div><dt>Run ID</dt><dd><code>${esc(run.id)}</code></dd></div><div><dt>Workflow</dt><dd>${esc(run.workflowId)} ${esc(run.workflowVersion??'')}</dd></div><div><dt>Residency</dt><dd>${esc(run.residency??'local-only')}</dd></div><div><dt>Current step</dt><dd>${esc(currentStepLabel(run,events))}</dd></div><div><dt>Duration</dt><dd>${duration(run.createdAt,run.completedAt)}</dd></div><div><dt>Warnings</dt><dd>${Number(run.warningCount??0)}</dd></div></dl>`;
}

function stepRail(steps,runId,selectedStep){
  return `<ol class="step-rail">${steps.map((step,index)=>`<li class="step-${esc(step.status)}${selectedStep===step.id?' is-selected':''}"><a href="${runDetailLink(runId,step.id)}" data-step-id="${esc(step.id)}"><span>${index+1}</span><strong>${esc(step.label)}</strong><small>${esc(step.status)}</small></a></li>`).join('')}</ol>`;
}

function stepDetailList(steps,selectedStep,runId){
  const ordered=selectedStep ? [...steps.filter((step)=>step.id===selectedStep),...steps.filter((step)=>step.id!==selectedStep)] : steps;
  return `<div class="step-grid">${ordered.map((step)=>`<article class="step-card step-${esc(step.status)}" id="step-${esc(step.id)}"><header><h3><a href="${runDetailLink(runId,step.id)}" data-step-id="${esc(step.id)}">${esc(step.label)}</a></h3>${statusChip(step.status,step.status,'Step status')}</header><p>${esc(step.detail)}</p><dl class="facts compact-facts"><div><dt>Actor</dt><dd>${esc(step.actorId??'pending')}</dd></div><div><dt>Attempt</dt><dd>${Number(step.attempts||0)}</dd></div><div><dt>Duration</dt><dd>${step.durationMs===null?'-':`${step.durationMs} ms`}</dd></div>${step.errorCode?`<div><dt>Error</dt><dd>${esc(step.errorCode)}${step.retryable?' · retryable':''}</dd></div>`:''}</dl>${summaryList(step.summary)}</article>`).join('')}</div>`;
}

function summaryList(summary){
  if(!summary || !Object.keys(summary).length)return '<p class="muted">No summary recorded yet.</p>';
  return `<dl class="summary-list">${Object.entries(summary).map(([key,value])=>`<div><dt>${esc(labelize(key))}</dt><dd>${esc(Array.isArray(value)?value.join(', '):value)}</dd></div>`).join('')}</dl>`;
}

function eventTable(events){
  if(!events?.length)return '<p class="muted">No events recorded.</p>';
  return `<div class="table-wrap"><table><thead><tr><th>Seq</th><th>Type</th><th>Step</th><th>Actor</th><th>Attempt</th><th>Summary</th><th>Time</th></tr></thead><tbody>${events.map((event)=>safeEventSummary(event)).map((event)=>`<tr><td>${event.sequence??'-'}</td><td>${esc(event.type)}</td><td>${esc(event.stepId??'-')}</td><td>${esc(event.actorId)}</td><td>${event.attempt??'-'}</td><td>${event.code?esc(event.code):summaryInline(event.summary)}</td><td>${date(event.occurredAt)}</td></tr>`).join('')}</tbody></table></div>`;
}

function contextHeaderFacts(model){
  const percent=Math.min(100,Math.round(Number(model.budget.used??0)/Math.max(1,Number(model.budget.available??1))*100));
  return `<dl class="facts facts-wide"><div><dt>Step</dt><dd>${esc(model.step)}</dd></div><div><dt>Actor</dt><dd>${esc(model.actorId)}</dd></div><div><dt>Compiler</dt><dd>${esc(model.compilerVersion)}</dd></div><div><dt>Budget</dt><dd>${Number(model.budget.used??0)} / ${Number(model.budget.available??0)} tokens (${percent}%)</dd></div><div><dt>Manifest</dt><dd><code>${esc(model.manifestFingerprint)}</code></dd></div><div><dt>Assembly</dt><dd><code>${esc(model.assemblyFingerprint)}</code></dd></div></dl>`;
}

function contextDecisionList(items){
  if(!items.length)return '<p class="muted">None.</p>';
  return `<div class="manifest-list">${items.map((item)=>contextDecisionCard(item)).join('')}</div>`;
}

function contextDecisionCard(item,expanded=false){
  return `<article class="manifest-row decision-card decision-${esc(item.selectedOrExcluded)}"><header><a href="${contextRecordLink(item.id,item.selectedOrExcluded)}" data-record-id="${esc(item.id)}"><code>${esc(item.id)}</code></a>${statusChip(item.selectedOrExcluded,item.selectedOrExcluded,'Context decision')}</header><p>${esc(item.preview||'No preview available.')}</p><div class="meta-row"><span>Kind: ${esc(item.kind)}</span><span>${item.tokens} tokens</span><span>Score: ${item.score===null?'n/a':item.score.toFixed(3)}</span><span>Source: ${esc(item.source)}</span><span>Scope: ${esc(item.scope)}</span><span>Version: ${esc(item.version)}</span>${item.confidence===null?'':`<span>Confidence: ${Math.round(item.confidence*100)}%</span>`}</div>${reasons(item.reasonCodes)}${expanded?'<p class="muted">This detail uses sanitized manifest fields only. Raw context bodies, prompts, hidden reasoning, local paths, and credentials are not rendered.</p>':''}</article>`;
}

function assemblySections(model){
  if(!model.sections.length)return '<p class="muted">No assembly sections recorded.</p>';
  return `<div class="assembly-list">${model.sections.map((section)=>`<article class="assembly-section"><header><h3>${esc(section.title)}</h3><span>${section.count} records · ${section.tokens} tokens</span></header><div class="reason-list">${section.recordIds.map((id)=>`<a class="reason" href="${contextRecordLink(id,'selected')}">${esc(id)}</a>`).join('')}</div></article>`).join('')}</div>`;
}

function contextComparison(model){
  const comparison=model.comparison;
  return `<dl class="facts"><div><dt>Selected</dt><dd>${comparison.selectedCount}</dd></div><div><dt>Excluded</dt><dd>${comparison.excludedCount}</dd></div><div><dt>Assembly IDs</dt><dd>${comparison.assemblyCount}</dd></div><div><dt>Selected missing</dt><dd>${comparison.selectedMissingFromAssembly.length || '0'}</dd></div><div><dt>Assembly not selected</dt><dd>${comparison.assemblyNotSelected.length || '0'}</dd></div><div><dt>Overlap</dt><dd>${comparison.selectedExcludedOverlap.length || '0'}</dd></div><div><dt>Conflicts</dt><dd>${comparison.conflictCount}</dd></div></dl>`;
}

function contextConflicts(conflicts){
  if(!conflicts.length)return '<p class="muted">No unresolved conflicts recorded.</p>';
  return `<div class="conflict-list">${conflicts.map((conflict,index)=>`<article class="state-inline"><strong>${esc(conflict.id??`conflict_${index+1}`)}</strong><p>${esc(conflict.reason??conflict.type??'Conflict recorded')}</p></article>`).join('')}</div>`;
}

function memoryDiffList(memories){
  if(!memories.length)return statePanel('empty','No active memory review in this workspace','Memory changes require proposal, verification, activation, supersession, retraction, or expiry.');
  return `<div class="memory-list">${memories.map((memory)=>`<article class="memory-diff state-${esc(memory.status)}"><header><div><code>${esc(memory.id)}</code><h3>${esc(memory.kind)} memory</h3></div>${statusChip(memory.status,memory.status,'Memory lifecycle')}</header><div class="diff-grid"><section><h4>Previous</h4><p>${esc(memory.previousValue)}</p></section><section><h4>Proposed</h4><p>${esc(memory.proposedValue)}</p></section></div><dl class="facts compact-facts"><div><dt>Source</dt><dd>${esc(memory.source)}</dd></div><div><dt>Confidence</dt><dd>${memory.confidence}%</dd></div><div><dt>Conflict</dt><dd>${esc(memory.conflict)}</dd></div><div><dt>Retention</dt><dd>${esc(memory.retention)}</dd></div><div><dt>Supersedes</dt><dd>${esc(memory.supersession)}</dd></div><div><dt>Reviewer</dt><dd>${esc(memory.reviewer)}</dd></div></dl>${memory.evidenceIds.length?`<div class="reason-list">${memory.evidenceIds.map((id)=>`<a class="reason" href="/evidence">${esc(id)}</a>`).join('')}</div>`:''}${lifecycleTrace(memory.lifecycle)}<div class="action-row review-actions">${memory.actions.map((action)=>`<button class="button secondary" type="button" disabled>${esc(action.label)}</button>`).join('')}</div></article>`).join('')}</div>`;
}

function lifecycleTrace(lifecycle){
  if(!lifecycle.length)return '<p class="muted">No lifecycle events recorded.</p>';
  return `<ol class="compact-list lifecycle-list">${lifecycle.map((event)=>`<li><strong>${esc(event.type)}</strong><span>${date(event.at)} · ${esc(event.actorId)}${event.reason?` · ${esc(event.reason)}`:''}</span></li>`).join('')}</ol>`;
}

function evidenceCard(item){
  return `<article class="evidence-row"><header><code>${esc(item.id)}</code><span class="trust-label">${esc(item.trustClass)}</span></header><p>${esc(item.observed.text || 'No observation preview available.')}</p><div class="evidence-columns"><section><h3>Observed</h3>${keyValueFacts(item.observed.fields)}</section><section><h3>Inferred</h3>${item.inferred.length?keyValueFacts(item.inferred):'<p class="muted">No inference recorded on this evidence card.</p>'}</section></div><dl class="facts facts-wide"><div><dt>Snapshot</dt><dd>${esc(item.sourceSnapshotId)}</dd></div><div><dt>Source</dt><dd>${esc(item.source)}</dd></div><div><dt>Method</dt><dd>${esc(item.collectionMethod)}</dd></div><div><dt>Hash</dt><dd><code>${esc(item.hash)}</code></dd></div><div><dt>Published</dt><dd>${date(item.publishedAt)}</dd></div><div><dt>Collected</dt><dd>${date(item.collectedAt)}</dd></div></dl>${item.claims.length?`<div class="claim-list">${item.claims.map((claim)=>`<article class="state-inline"><strong>${esc(claim.id)}</strong><p>${esc(claim.text)}</p><div class="meta-row"><span>${esc(claim.relation)}</span><span>${esc(claim.uncertainty)}</span><span>Inference: ${esc(claim.model)}</span></div></article>`).join('')}</div>`:'<p class="muted">No generated claim links reference this evidence.</p>'}${item.stale?statusChip('stale','stale','Evidence staleness'):''}${item.conflicts.length?`<div class="reason-list">${item.conflicts.map((conflict)=>`<span class="reason">${esc(conflict)}</span>`).join('')}</div>`:''}</article>`;
}

function approvalCardList(approvals){
  if(!approvals.length)return statePanel('empty','No pending approvals','Consequential actions require exact preview, risk, expiry, and idempotency before approval.');
  return `<div class="approval-list">${approvals.map((approval)=>`<article class="approval-card state-${esc(approval.status)}"><header><div><code>${esc(approval.id)}</code><h3>${esc(approval.consequence)}</h3></div>${statusChip(approval.status,approval.status,'Approval status')}</header><dl class="facts compact-facts"><div><dt>Operation</dt><dd><code>${esc(approval.operationHash)}</code></dd></div><div><dt>Actor</dt><dd>${esc(approval.actor)}</dd></div><div><dt>Destination</dt><dd>${esc(approval.destination)}</dd></div><div><dt>Risk</dt><dd>${esc(approval.risk)}</dd></div><div><dt>Policy</dt><dd>${esc(approval.policyVersion)}</dd></div><div><dt>Expires</dt><dd>${date(approval.expiresAt)}</dd></div><div><dt>Idempotency</dt><dd>${esc(approval.idempotency)}</dd></div></dl><section class="preview-box"><h4>Exact content or diff</h4><p>${esc(approval.exactContent)}</p></section><p class="muted">Any edit invalidates this approval. External writes: ${approval.externalWrites?'enabled':'disabled'}.</p>${reasons(approval.reasonCodes)}<div class="action-row review-actions">${approval.actions.map((action)=>`<button class="button secondary" type="button" disabled>${esc(action.label)}</button>`).join('')}</div></article>`).join('')}</div>`;
}

function keyValueFacts(items){
  return `<dl class="summary-list">${items.map((item)=>`<div><dt>${esc(item.key)}</dt><dd>${esc(item.value)}</dd></div>`).join('')}</dl>`;
}

function navigate(event) {
  event.preventDefault();
  activeRunDetail=null;
  history.pushState({},'',event.currentTarget.getAttribute('href'));
  render();
  document.querySelector('#main').focus({preventScroll:true});
}

function navigateLocal(event) {
  event.preventDefault();
  history.pushState({},'',event.currentTarget.getAttribute('href'));
  render();
  document.querySelector('#main').focus({preventScroll:true});
}

function selectFabricNode(event) {
  activeFabricNode=event.currentTarget.dataset.fabricNode ?? 'context';
  render();
  document.querySelector('#main').focus({preventScroll:true});
}

async function runDemo(event){
  const button=event?.currentTarget ?? document.querySelector('#run-button');
  if(button){
    button.disabled=true;
    button.textContent='Running...';
  }
  document.querySelector('#live-status').textContent='Local workflow started.';
  try{
    await api('/api/runs',{method:'POST',body:JSON.stringify({workspaceId:workspaceId(),workflowId:'workflow:content-intelligence'})});
    await load();
    document.querySelector('#live-status').textContent='Local workflow completed.';
  }catch(error){
    document.querySelector('#live-status').textContent=error.message;
    shellState=classifyDashboardState({error:{status:error.status,message:error.message}});
    render();
  }finally{
    if(button){
      button.disabled=false;
      button.textContent='Run demo';
    }
  }
}

async function submitAuthForm(event){
  event.preventDefault();
  const form=event.currentTarget;
  const button=form.querySelector('button[type=submit]');
  const mode=form.dataset.mode;
  const data=new FormData(form);
  const username=String(data.get('username') ?? '').trim();
  const password=String(data.get('password') ?? '');
  const displayName=String(data.get('displayName') ?? '').trim();
  button.disabled=true;
  button.textContent=mode==='bootstrap'?'Creating...':'Signing in...';
  document.querySelector('#live-status').textContent=mode==='bootstrap'?'Creating local owner.':'Signing in locally.';
  try{
    if(mode==='bootstrap'){
      await api('/api/auth/bootstrap',{method:'POST',body:JSON.stringify({username,displayName,password,workspaceId:'ws_local',workspaceName:'Local Workspace'})});
    }else{
      await api('/api/auth/login',{method:'POST',body:JSON.stringify({username,password})});
    }
    form.reset();
    document.querySelector('#live-status').textContent=mode==='bootstrap'?'Local owner created.':'Signed in locally.';
    await load();
  }catch(error){
    document.querySelector('#live-status').textContent=error.message;
    const message=error.code==='already_bootstrapped'?'This workspace already has an owner. Sign in instead.':error.message;
    shellState={kind:mode==='bootstrap'&&error.code!=='already_bootstrapped'?'setup':'denied',message};
    render();
  }finally{
    button.disabled=false;
    button.textContent=mode==='bootstrap'?'Create owner':'Sign in';
  }
}

async function submitContextPack(event){
  event.preventDefault();
  const form=event.currentTarget;
  const button=form.querySelector('button[type=submit]');
  const data=new FormData(form);
  const targetHarness=String(data.get('targetHarness') ?? 'generic');
  const objective=String(data.get('objective') ?? '').trim();
  const step=String(data.get('step') ?? '').trim();
  const tokenBudget=Number(data.get('tokenBudget') ?? 4096);
  const sourceFamilies=contextPackSelectedSourceFamilies(form);
  const userSelectedFiles=parseSelectedFiles(data.get('userSelectedFiles'));
  const changedLocators=parseSelectedFiles(data.get('changedLocators'));
  button.disabled=true;
  button.textContent='Building...';
  document.querySelector('#live-status').textContent='Building local context pack.';
  try{
    const started=globalThis.performance?.now?.() ?? Date.now();
    const result=await api('/api/context/pack',{method:'POST',body:JSON.stringify({workspaceId:workspaceId(),targetHarness,from:sourceFamilies.join(','),objective,step,tokenBudget,userSelectedFiles,changedLocators})});
    const finished=globalThis.performance?.now?.() ?? Date.now();
    contextPackResult={...result,observedDurationMs:Math.max(0,Math.round(finished-started))};
    contextPackError=null;
    document.querySelector('#live-status').textContent='Context pack built.';
    render();
  }catch(error){
    document.querySelector('#live-status').textContent=error.message;
    contextPackError=error.message;
    render();
  }finally{
    button.disabled=false;
    button.textContent='Build context pack';
  }
}

function gitDetectionReasonLabel(reason){
  return String(reason ?? 'unavailable').replace(/_/gu,' ');
}

async function detectContextPackGitChanges(event){
  const button=event.currentTarget;
  const form=button.closest('form');
  const field=form?.querySelector('textarea[name="changedLocators"]');
  const status=form?.querySelector('[data-git-change-status]');
  if(!field || !status)return;
  button.disabled=true;
  button.textContent='Detecting...';
  status.textContent='Reading local git status without diffs.';
  try{
    const report=await api('/api/context/git-changes',{method:'POST',body:JSON.stringify({workspaceId:workspaceId()})});
    if(report.status!=='available'){
      status.textContent=`Git changes unavailable: ${gitDetectionReasonLabel(report.reason)}.`;
      return;
    }
    const existing=parseSelectedFiles(field.value);
    const detected=(report.changedLocators ?? []).map((locator)=>String(locator).replace(/^workspace:\/\//u,''));
    const merged=[...new Set([...existing,...detected])].sort();
    field.value=merged.join('\n');
    const omitted=Number(report.omittedChangedLocatorCount ?? 0);
    const skipped=Number(report.skippedCount ?? 0);
    const suffix=[
      omitted>0?`${omitted} omitted by cap`:null,
      skipped>0?`${skipped} skipped by safety rules`:null
    ].filter(Boolean).join('; ');
    status.textContent=`${detected.length} git change${detected.length===1?'':'s'} added for review${suffix?`; ${suffix}`:''}.`;
  }catch(error){
    status.textContent=error.message;
  }finally{
    button.disabled=false;
    button.textContent='Detect git changes';
  }
}

async function submitSourceGraph(event){
  event.preventDefault();
  const form=event.currentTarget;
  const button=form.querySelector('button[type=submit]');
  const data=new FormData(form);
  const query=String(data.get('query') ?? '').trim();
  const startName=String(data.get('startName') ?? '').trim();
  const changedLocator=String(data.get('changedLocator') ?? '').trim();
  const limit=Number(data.get('limit') ?? 8);
  const depth=Number(data.get('depth') ?? 2);
  const body={
    workspaceId:workspaceId(),
    limit,
    depth,
    sampleLimit:6
  };
  if(query)body.query=query;
  if(startName)body.startName=startName;
  if(changedLocator)body.changedLocators=[changedLocator];
  button.disabled=true;
  button.textContent='Previewing...';
  document.querySelector('#live-status').textContent='Previewing local source graph.';
  try{
    sourceGraphResult=await api('/api/context/graph/preview',{method:'POST',body:JSON.stringify(body)});
    sourceGraphError=null;
    document.querySelector('#live-status').textContent='Source graph preview ready.';
    render();
  }catch(error){
    document.querySelector('#live-status').textContent=error.message;
    sourceGraphError=error.message;
    render();
  }finally{
    button.disabled=false;
    button.textContent='Preview graph';
  }
}

async function previewContextPackSetup(event){
  const button=event.currentTarget;
  const client=button.dataset.client ?? 'codex';
  button.disabled=true;
  button.textContent='Previewing...';
  document.querySelector('#live-status').textContent='Previewing matching harness setup.';
  try{
    harnessSetupResult=await api('/api/harness/setup/plan',{method:'POST',body:JSON.stringify({workspaceId:workspaceId(),client})});
    harnessSetupError=null;
    document.querySelector('#live-status').textContent='Harness setup preview ready.';
    render();
  }catch(error){
    document.querySelector('#live-status').textContent=error.message;
    harnessSetupError=error.message;
    render();
  }finally{
    button.disabled=false;
    button.textContent='Preview setup';
  }
}

async function submitHarnessSetupPlan(event){
  event.preventDefault();
  const form=event.currentTarget;
  const button=form.querySelector('button[type=submit]');
  const data=new FormData(form);
  const client=String(data.get('client') ?? 'codex');
  button.disabled=true;
  button.textContent='Previewing...';
  document.querySelector('#live-status').textContent='Previewing local harness setup.';
  try{
    harnessSetupResult=await api('/api/harness/setup/plan',{method:'POST',body:JSON.stringify({workspaceId:workspaceId(),client})});
    harnessSetupError=null;
    document.querySelector('#live-status').textContent='Harness setup preview ready.';
    render();
  }catch(error){
    document.querySelector('#live-status').textContent=error.message;
    harnessSetupError=error.message;
    render();
  }finally{
    button.disabled=false;
    button.textContent='Preview setup';
  }
}

async function resetDemo(event){
  const button=event?.currentTarget ?? document.querySelector('#reset-button');
  if(button)button.disabled=true;
  try{
    await api('/api/reset',{method:'POST'});
    activeRunDetail=null;
    await load();
    document.querySelector('#live-status').textContent='Local demo data reset.';
  }catch(error){
    document.querySelector('#live-status').textContent=error.message;
  }finally{
    if(button)button.disabled=false;
  }
}

async function copyContextPack(event){
  const markdown=contextPackResult?.markdown ?? '';
  if(!markdown)return;
  const button=event.currentTarget;
  const previous=button.textContent;
  try{
    if(globalThis.navigator?.clipboard?.writeText){
      await navigator.clipboard.writeText(markdown);
    }else{
      const output=document.querySelector('#context-pack-output');
      output?.focus();
      output?.select();
      document.execCommand?.('copy');
    }
    document.querySelector('#live-status').textContent='Context pack markdown copied.';
    button.textContent='Copied';
  }catch(error){
    document.querySelector('#live-status').textContent='Copy failed. Select the markdown manually.';
  }finally{
    setTimeout(()=>{ button.textContent=previous; },1200);
  }
}

function downloadContextPack(event){
  const markdown=contextPackResult?.markdown ?? '';
  const pack=contextPackResult?.pack ?? null;
  if(!markdown||!pack)return;
  const blob=new Blob([markdown],{type:'text/markdown;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const link=document.createElement('a');
  link.href=url;
  link.download=contextPackDownloadName(pack);
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  document.querySelector('#live-status').textContent='Context pack markdown download started.';
  event.currentTarget.textContent='Download .md';
}

async function showRun(event){
  event.preventDefault();
  await loadRunById(event.currentTarget.dataset.runId);
}

async function loadRunById(id,{push=true}={}){
  if(push) history.pushState({},'',`/runs?run=${encodeURIComponent(id)}`);
  try{
    activeRunDetail=await api(`/api/runs/${encodeURIComponent(id)}?workspaceId=${encodeURIComponent(workspaceId())}`);
    render();
  }catch(error){
    shellState=classifyDashboardState({error:{status:error.status,message:error.message}});
    render();
  }
}

function esc(value){return String(value??'').replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]))}
function shortFingerprint(value){return `${String(value??'').slice(0,19)}...`}
function date(value){return value?new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(new Date(value)):'-'}
function duration(start,end){if(!start)return '-';const from=Date.parse(start),to=end?Date.parse(end):Date.now();if(!Number.isFinite(from)||!Number.isFinite(to))return '-';const ms=Math.max(0,to-from);if(ms<1000)return `${ms} ms`;if(ms<60000)return `${Math.round(ms/1000)} s`;return `${Math.round(ms/60000)} min`}
function titleize(value){return String(value??'').split(/[-_]/).filter(Boolean).map((part)=>part[0]?.toUpperCase()+part.slice(1)).join(' ')||'Step'}
function labelize(value){return titleize(value).replace(/\bId\b/g,'ID')}
function safeText(value){return String(value??'').replace(/[\r\n\t]+/g,' ').slice(0,160)}
function previewText(value){return safeText(value).slice(0,220)}
function sanitizeSummary(value){if(!value||typeof value!=='object'||Array.isArray(value))return null;const output={};for(const [key,raw] of Object.entries(value)){if(/prompt|body|text|credential|token|secret|path|url|reasoning|sql/i.test(key))continue;if(typeof raw==='string'||typeof raw==='number'||typeof raw==='boolean')output[key]=safeText(raw);else if(Array.isArray(raw))output[key]=raw.slice(0,6).map((item)=>typeof item==='string'||typeof item==='number'||typeof item==='boolean'?safeText(item):'[object]');}return output}
function summaryInline(summary){if(!summary)return '-';const entries=Object.entries(summary);if(!entries.length)return '-';return entries.map(([key,value])=>`${labelize(key)}: ${Array.isArray(value)?value.join(', '):value}`).join('; ')}
function boundedPercent(value){const number=Number(value??0);return Math.max(0,Math.min(100,Math.round((Number.isFinite(number)?number:0)*100)))}
function memoryActionsForStatus(status){if(status==='proposed'||status==='verified')return [{label:'Approve'},{label:'Edit'},{label:'Reject'},{label:'Set expiry'}];if(status==='active')return [{label:'Supersede'},{label:'Retract'},{label:'Set expiry'}];return [{label:'Review history'}]}
function approvalActionsForStatus(status){if(status==='pending')return [{label:'Approve exact operation'},{label:'Edit invalidates approval'},{label:'Reject'}];return [{label:'Review outcome'}]}
function memoryDisplayText(value){const text=String(value??'');return /sk-[A-Za-z0-9_-]{12,}|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|AKIA[0-9A-Z]{16}|gho_[A-Za-z0-9_]{12,}/.test(text) ? '[redacted-sensitive-value]' : previewText(text)}
function safeKeyValueList(value){if(!value||typeof value!=='object'||Array.isArray(value))return [];return Object.entries(value).filter(([key])=>!/prompt|body|credential|token|secret|path|url|reasoning|sql/i.test(key)).slice(0,8).map(([key,raw])=>({key:labelize(key),value:Array.isArray(raw)?raw.slice(0,4).map(safeText).join(', '):safeText(raw)}))}
function quoteShell(value){return `'${String(value??'').replaceAll("'","'\"'\"'")}'`}

function boot(){
  document.querySelector('#run-button')?.addEventListener('click',runDemo);
  document.querySelector('#reset-button')?.addEventListener('click',resetDemo);
  window.addEventListener('popstate',()=>{activeRunDetail=null;const runId=new URL(location.href).searchParams.get('run');if(currentRoute().id==='runs'&&runId)loadRunById(runId,{push:false});else render()});
  const runId=new URL(location.href).searchParams.get('run');
  load().then(()=>{if(runId)loadRunById(runId,{push:false})});
}

if (globalThis.document?.querySelector('#view-root')) boot();
