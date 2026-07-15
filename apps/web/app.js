import { navigationItemsFor, navigationOwner, selectOverviewPrimaryAction } from './shell-model.js';
import { csrfToken, requestJson as api } from './api.js';
import { buildOrientationModel } from './orientation-model.js';
import {
  buildApiErrorUiModel,
  escapeHtml as esc,
  formatDate as date,
  renderApiErrorPanel,
  renderApiErrorRecovery,
  safeErrorToken,
  shortFingerprint,
  statePanel,
  titleize
} from './ui-primitives.js';

export { buildApiErrorUiModel } from './ui-primitives.js';

export const SHELL_STATES = new Set(['loading','setup','empty','error','denied','stale','partial','success']);

const OAF_CHECKOUT_COMMAND_PREFIX = 'npm --silent run oaf --';
const OAF_COMPATIBILITY_URL = 'https://github.com/rebel0789/Memory-Recall/blob/main/docs/usage/oaf-compatibility.md';
const OAF_URI_COMPATIBILITY_NOTE = 'Legacy oaf:// URIs remain supported compatibility identifiers; normal commands use recall.';

export const ROUTES = [
  { id:'home', path:'/', label:'Overview', title:'Overview', description:'Current repository, memory, impact, and handoff state.' },
  { id:'runs', path:'/runs', label:'Runs', title:'Runs', description:'Run history, status, current step, artifacts, and sanitized timelines.' },
  { id:'workflows', path:'/workflows', label:'Workflows', title:'Workflows', description:'Workflow versions, graph outline, risk, retries, approvals, and tests.' },
  { id:'loop-workbench', path:'/loop-workbench', label:'Loop Workbench', title:'Loop Workbench', description:'Plan, run, observe, verify, budget, and stop loops with local proof.' },
  { id:'fabric-map', path:'/fabric-map', label:'Fabric Map', title:'Fabric Map', description:'Visualize local process flow, context assembly, node handoffs, and disabled external boundaries.' },
  { id:'context', path:'/context', label:'Context', title:'Context', description:'Selected and excluded records, budgets, conflicts, assembly, and compiler versions.' },
  { id:'context-pack', path:'/context-pack', label:'Context Pack', title:'Context Pack', description:'Build a safe, token-aware handoff for Codex, Claude Code, Cursor, or a generic agent.' },
  { id:'source-graph', path:'/source-graph', label:'Source Graph', title:'Source Graph', description:'Search symbols, trace calls, and inspect likely diff impact from local JS/TS metadata.' },
  { id:'memory', path:'/memory', label:'Memory', title:'Memory', description:'Proposals, active records, supersession, retraction, expiry, and provenance.' },
  { id:'memory-graph', path:'/memory-graph', label:'Graph', title:'Memory Graph', description:'Explore current and historical governed memory relationships from the local SQLite store.' },
  { id:'evidence', path:'/evidence', label:'Evidence', title:'Evidence', description:'Snapshots, observations, citations, staleness, and inferred pattern boundaries.' },
  { id:'approvals', path:'/approvals', label:'Approvals', title:'Approvals', description:'Exact actions, risk, policy reasons, idempotency, expiry, and disabled publisher state.' },
  { id:'content', path:'/content', label:'Content Lab', title:'Content Lab', description:'Candidates, evidence, differentiation, proof needed, local drafts, and outcomes.' },
  { id:'agents', path:'/agents-tools', label:'Agents & Tools', title:'Agents & Tools', description:'Manifests, permissions, compatibility, health, and bounded local execution.' },
  { id:'settings', path:'/settings', label:'Settings', title:'Settings', description:'Models, storage, policy, privacy, infrastructure, and design token contract.' }
];

const routeById = new Map(ROUTES.map(route=>[route.id,route]));
const routeByPath = new Map(ROUTES.map(route=>[route.path,route]));
const routeAliases = new Map([
  ['/map', 'source-graph'],
  ['/handoffs', 'context-pack']
]);
const legacyViews = new Map([['home','/'],['runs','/runs'],['context','/context'],['evidence','/evidence'],['memory','/memory'],['design','/settings']]);

let dashboard=null;
let shellState={kind:'loading',message:'Loading local workspace state.'};
let recallMap=null;
let recallMapError=null;
let recallMapGitChanges=null;
let recallMapLoadSequence=0;
let authDraft={username:'',displayName:''};
let authError=null;
let activeRunDetail=null;
let contextPackResult=null;
let contextPackError=null;
let contextPackMemoryConfig=null;
let contextPackMemoryPreflightError=null;
let contextPackPinError=null;
let contextPackReviewedPayload=null;
let pinnedHandoffStatus=null;
let pinnedHandoffError=null;
let pinnedHandoffReceiveReport=null;
let pinnedHandoffReceiveError=null;
let loopWorkbench=null;
let loopWorkbenchError=null;
let memoryCockpit=null;
let memoryCockpitError=null;
let memoryIntakeResult=null;
let memoryIntakeError=null;
let memoryIntakeDraft={sourceLocator:'memory/inbox.md',text:''};
let memoryGraph=null;
let memoryGraphError=null;
let memoryGraphOptions={history:false,query:'',entity:'',communities:false};
let contextSourcePreviewResult=null;
let contextSourcePreviewError=null;
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
  const aliasRouteId = routeAliases.get(normalized);
  if (aliasRouteId) return routeById.get(aliasRouteId);
  return routeByPath.get(normalized) ?? routeById.get('home');
}

export function classifyDashboardState(value) {
  if (!value) return { kind:'loading', message:'Loading local workspace state.' };
  if (value.error?.status === 503 && value.error?.code === 'bootstrap_required') return { kind:'setup', message:'Set up local access before reading workspace state.' };
  if (value.error?.status === 401 || value.error?.status === 403) return { kind:'denied', message:'Sign in locally to view this workspace.' };
  if (value.error) return { kind:'error', message:value.error.message ?? 'Could not load local state.' };
  const runs = Array.isArray(value.runs) ? value.runs : [];
  if (!runs.length && !value.latestManifest) return { kind:'empty', message:'No local runs have been recorded.' };
  if (value.stale) return { kind:'stale', message:'Showing cached local data. Retry when the loopback API is available.' };
  if (!value.latestManifest) return { kind:'partial', message:'Runs exist, but no context manifest has been compiled yet.' };
  return { kind:'success', message:'Local workspace state loaded.' };
}

export function buildAuthViewModel({mode='login',copy='',draft={},error=null}={}) {
  const limit=(value,max)=>String(value??'').slice(0,max);
  return {
    mode:mode==='bootstrap'?'bootstrap':'login',
    copy:limit(copy,240),
    draft:{username:limit(draft.username,80),displayName:limit(draft.displayName,120)},
    error:error ? buildApiErrorUiModel(error) : null
  };
}

export function authFailureTransition({mode='login',draft={},error={}}={}) {
  const alreadyBootstrapped=error?.code==='already_bootstrapped';
  const safeDraft=buildAuthViewModel({mode,draft}).draft;
  return {
    mode:alreadyBootstrapped?'login':mode==='bootstrap'?'bootstrap':'login',
    shellKind:alreadyBootstrapped||mode!=='bootstrap'?'denied':'setup',
    draft:{username:safeDraft.username,displayName:alreadyBootstrapped?'':safeDraft.displayName},
    clearPassword:alreadyBootstrapped,
    message:alreadyBootstrapped?'This workspace already has an owner. Sign in instead.':String(error?.message??'Authentication failed.').slice(0,240)
  };
}

export function normalizeRecallMapGitChanges(report=null,error=null) {
  const empty={changedLocators:[],totalCount:0,omittedCount:0,truncated:false};
  if(error){
    const reason=safeErrorToken(error?.code,'git_detection_failed',64);
    return {status:'error',...empty,reason,message:safeGitDetectionMessage(error?.message,'Git change detection failed. Retry the local scan.')};
  }
  if(report?.status==='error'){
    const reason=safeErrorToken(report.reason,'git_detection_failed',64);
    return {status:'error',...empty,reason,message:safeGitDetectionMessage(report.message,'Git change detection failed. Retry the local scan.')};
  }
  if(report?.status==='unavailable'){
    const reason=safeErrorToken(report.reason,'git_unavailable',64);
    return {status:'unavailable',...empty,reason,message:gitDetectionUnavailableMessage(reason)};
  }
  if(report?.status!=='available')return {status:'unknown',...empty,reason:'not_run',message:'Git change detection has not run.'};
  const changedLocators=(Array.isArray(report.changedLocators)?report.changedLocators:[])
    .map((value)=>String(value).replace(/^workspace:\/\//u,''))
    .filter(Boolean)
    .slice(0,16);
  return {
    status:'available',
    changedLocators,
    totalCount:Math.max(changedLocators.length,Number(report.totalCount??report.totalChangedLocatorCount??changedLocators.length)+Math.max(0,Number(report.totalCount==null?report.skippedCount??0:0))),
    omittedCount:Math.max(0,Number(report.omittedCount??report.omittedChangedLocatorCount??0))+Math.max(0,Number(report.omittedCount==null?report.skippedCount??0:0)),
    truncated:report.truncated===true
  };
}

function safeGitDetectionMessage(value,fallback) {
  const message=String(value??'').trim();
  if(!message||/(?:\/Users|\/private|\/var\/folders|https?:|file:|token|secret|api[_-]?key|authorization|cookie)/iu.test(message))return fallback;
  return message.slice(0,180);
}

function gitDetectionUnavailableMessage(reason) {
  return ({
    not_git_repository:'Git change detection is unavailable because this workspace is not a Git repository.',
    git_unavailable:'Git change detection is unavailable because the local Git executable could not be used.',
    git_status_failed:'Git change detection is unavailable because local status could not be read.',
    git_status_timeout:'Git change detection is unavailable because local status timed out.'
  })[reason] ?? 'Git change detection is unavailable. Retry the local scan.';
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

export function buildMemoryCockpitModel(cockpit = null) {
  const budget = cockpit?.tokenBudget ?? {};
  const savings = cockpit?.savings ?? {};
  const summary = cockpit?.summary ?? {};
  const facts = Array.isArray(cockpit?.facts) ? cockpit.facts : [];
  const proposalQueue = Array.isArray(cockpit?.proposalQueue) ? cockpit.proposalQueue : [];
  return {
    ready:Boolean(cockpit),
    workspaceId:safeText(cockpit?.workspaceId ?? 'ws_local'),
    provider:safeText(cockpit?.provider ?? 'provider:native:memory:sqlite'),
    generatedAt:cockpit?.generatedAt ?? null,
    summary:{
      activeFactCount:Number(summary.activeFactCount ?? facts.filter((fact)=>fact.status==='active').length),
      pendingProposalCount:Number(summary.pendingProposalCount ?? proposalQueue.filter((item)=>item.status==='pending').length),
      proposalCount:Number(summary.proposalCount ?? proposalQueue.length)
    },
    tokenSavingPercent:Math.round(Number(budget.reductionRatio ?? 0) * 100),
    tokenBudget:{
      estimatedDeliveryTokens:Number(budget.estimatedDeliveryTokens ?? 0),
      historyTokensAvoided:Number(budget.historyTokensAvoided ?? 0),
      historyTokensAvailable:Number(budget.historyTokensAvailable ?? 0),
      profileTokens:Number(budget.profileTokens ?? 0),
      basis:safeText(budget.basis ?? 'not measured')
    },
    savings:{
      beforeDeliveryTokens:Number(savings.beforeDeliveryTokens ?? savings.baseline?.deliveryTokens ?? budget.historyTokensAvailable ?? 0),
      afterDeliveryTokens:Number(savings.afterDeliveryTokens ?? savings.compressed?.deliveryTokens ?? budget.estimatedDeliveryTokens ?? 0),
      tokensSaved:Number(savings.tokensSaved ?? savings.savings?.tokensSaved ?? budget.historyTokensAvoided ?? 0),
      percent:Math.round(Number(savings.percent ?? savings.savings?.percent ?? Number(budget.reductionRatio ?? 0) * 100)),
      providerBillingClaimed:Boolean(savings.savings?.providerBillingClaimed ?? false),
      basis:safeText(savings.savings?.basis ?? 'delivery-token-estimate')
    },
    mcpStats:{
      available:Boolean(cockpit?.mcpStats?.available),
      callCount:Number(cockpit?.mcpStats?.callCount ?? 0),
      deliveredTokens:Number(cockpit?.mcpStats?.deliveredTokens ?? 0),
      baselineTokens:Number(cockpit?.mcpStats?.baselineTokens ?? 0),
      tokensSaved:Number(cockpit?.mcpStats?.tokensSaved ?? 0),
      tokenSavingPercent:Number(cockpit?.mcpStats?.tokenSavingPercent ?? 0),
      providerBillingClaimed:Boolean(cockpit?.mcpStats?.providerBillingClaimed ?? false),
      basis:safeText(cockpit?.mcpStats?.basis ?? 'estimated tokens over exact MCP JSON tool payload text'),
      byTool:Array.isArray(cockpit?.mcpStats?.byTool) ? cockpit.mcpStats.byTool.map((item)=>({
        toolName:safeText(item.toolName ?? 'unknown'),
        callCount:Number(item.callCount ?? 0),
        deliveredTokens:Number(item.deliveredTokens ?? 0),
        tokensSaved:Number(item.tokensSaved ?? 0)
      })).slice(0,8) : []
    },
    facts:facts.map((fact)=>({
      id:safeText(fact.id ?? 'memfact_unknown'),
      text:memoryDisplayText(fact.text ?? ''),
      subject:safeText(fact.subject ?? 'unknown'),
      predicate:safeText(fact.predicate ?? 'unknown'),
      object:memoryDisplayText(fact.object ?? ''),
      status:safeText(fact.status ?? 'unknown'),
      scope:safeText(fact.scope ?? 'workspace'),
      validFrom:fact.validity?.validFrom ?? fact.validFrom ?? null,
      validUntil:fact.validity?.validUntil ?? fact.validUntil ?? null,
      supersededBy:fact.supersededBy ? safeText(fact.supersededBy) : 'none',
      supersessionChain:Array.isArray(fact.supersessionChain) ? fact.supersessionChain.map(safeText) : [],
      provenance:{
        episodeId:safeText(fact.provenance?.episodeId ?? fact.episodeId ?? 'none'),
        source:safeText(fact.provenance?.source ?? fact.source ?? 'unknown'),
        summary:memoryDisplayText(fact.provenance?.episode?.summary ?? fact.episode?.summary ?? '')
      }
    })),
    proposalQueue:proposalQueue.map((item)=>({
      id:safeText(item.id ?? 'mpq_unknown'),
      status:safeText(item.status ?? 'pending'),
      sourceLocator:safeText(item.sourceLocator ?? 'workspace://unknown'),
      sourceHash:safeText(item.sourceHash ?? 'sha256:unknown'),
      attempts:Number(item.attempts ?? 0),
      payload:safeKeyValueList(item.payload ?? {}).slice(0,6)
    })),
    safeguards:cockpit?.safeguards ?? {},
    reportFingerprint:safeText(cockpit?.reportFingerprint ?? 'sha256:unavailable')
  };
}

export function deliveryChangeLabel(percent) {
  const value=Math.round(Number(percent) || 0);
  if(value>0)return `${value}% reduction`;
  if(value<0)return `${Math.abs(value)}% overhead`;
  return 'No reduction';
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

export function buildFabricMapModel({ dashboard: value = null, shellState: state = {}, activeNodeId = 'context', handoffStatus = null } = {}) {
  const handoff = handoffStatus ?? buildCurrentHandoffStatusModel();
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
      { label:'Input mode', value:'explicit local' },
      { label:'Handoff', value:handoff.statusLabel }
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
    sources: handoff.state !== 'none' ? 'active' : state.kind === 'success' || state.kind === 'partial' ? 'ready' : 'waiting',
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
      active:'has data',
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
      externalWritesEnabled:false,
      handoffState:handoff.state
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
    handoff,
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
    bridgeCommand:report?.desiredServer ? [report.desiredServer.command,...report.desiredServer.args].join(' ') : oafCommand('mcp resources --read-only --stdio'),
    manualConfigSnippet:report?.manualConfigSnippet ? {
      format:safeText(report.manualConfigSnippet.format),
      configRef:safeText(report.manualConfigSnippet.configRef),
      applyMode:safeText(report.manualConfigSnippet.applyMode),
      content:String(report.manualConfigSnippet.content ?? ''),
      warning:safeText(report.manualConfigSnippet.warning)
    } : null,
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

function harnessClientLabel(client) {
  return harnessSetupClientsForUi().find(([id])=>id===client)?.[1] ?? titleize(client);
}

function workspaceId() {
  return new URL(globalThis.location?.href ?? 'http://127.0.0.1/').searchParams.get('workspaceId') ?? 'ws_local';
}

function currentRoute() {
  return resolveRoute(globalThis.location?.href ?? '/');
}

export function shouldLoadProtectedShellData({ bootstrapRequired = false, csrfTokenValue = '' } = {}) {
  return bootstrapRequired === false && String(csrfTokenValue ?? '').trim().length > 0;
}

async function load() {
  const root = document.querySelector('#view-root');
  root.setAttribute('aria-busy','true');
  shellState={kind:'loading',message:'Loading local workspace state.'};
  render();
  try {
    const bootstrap = await api('/api/auth/bootstrap-status');
    if (bootstrap?.bootstrapRequired) {
      dashboard = { error:{ status:503, code:'bootstrap_required', message:'Local owner setup is required.' }, metrics:{ runs:0, completed:0, events:0, pendingApprovals:0 }, runs:[], approvals:[], latestRun:null, latestManifest:null };
      shellState = classifyDashboardState(dashboard);
      return;
    }
    if (!shouldLoadProtectedShellData({ bootstrapRequired: false, csrfTokenValue: csrfToken() })) {
      dashboard = { error:{ status:401, code:'authentication_required', message:'Local authentication required.' }, metrics:{ runs:0, completed:0, events:0, pendingApprovals:0 }, runs:[], approvals:[], latestRun:null, latestManifest:null };
      shellState = classifyDashboardState(dashboard);
      return;
    }
    dashboard = await api(`/api/dashboard?workspaceId=${encodeURIComponent(workspaceId())}`);
    await Promise.all([loadRecallMap(), loadPinnedHandoffStatus(), loadLoopWorkbench(), loadMemoryCockpit(), loadMemoryGraph()]);
    shellState = classifyDashboardState(dashboard);
  } catch (error) {
    dashboard = { error:{ status:error.status, code:error.code, message:error.message }, metrics:{ runs:0, completed:0, events:0, pendingApprovals:0 }, runs:[], approvals:[], latestRun:null, latestManifest:null };
    shellState = classifyDashboardState(dashboard);
  } finally {
    render();
    root.setAttribute('aria-busy','false');
  }
}

async function loadRecallMap() {
  const sequence=++recallMapLoadSequence;
  const query=recallMapSearchQuery();
  let gitChanges=normalizeRecallMapGitChanges();
  try {
    try{
      gitChanges=normalizeRecallMapGitChanges(await api('/api/context/git-changes',{method:'POST',body:JSON.stringify({workspaceId:workspaceId()})}));
    }catch(error){
      gitChanges=normalizeRecallMapGitChanges(null,error);
    }
    const report=gitChanges.status==='available'
      ? await api('/api/recall/map',{method:'POST',body:JSON.stringify({workspaceId:workspaceId(),changedLocators:gitChanges.changedLocators,...(query?{query}:{})})})
      : await api(`/api/recall/map?workspaceId=${encodeURIComponent(workspaceId())}${query?`&query=${encodeURIComponent(query)}`:''}`);
    if(sequence!==recallMapLoadSequence)return;
    recallMap = report;
    recallMapGitChanges = gitChanges;
    recallMapError = null;
  } catch (error) {
    if(sequence!==recallMapLoadSequence)return;
    recallMap = null;
    recallMapGitChanges = gitChanges;
    recallMapError = error;
  }
}

function recallMapSearchQuery(){return String(new URL(globalThis.location?.href??'http://127.0.0.1/').searchParams.get('query')??'').trim().slice(0,256)}

async function refreshRecallMap(event) {
  const button = event?.currentTarget ?? null;
  const previous = button?.textContent ?? 'Refresh Recall Map';
  if (button) {
    button.disabled = true;
    button.textContent = 'Refreshing…';
  }
  document.querySelector('#live-status').textContent = 'Refreshing the local Recall Map.';
  try {
    await Promise.all([loadRecallMap(), loadPinnedHandoffStatus()]);
    render();
    document.querySelector('#live-status').textContent = recallMapError ? 'Recall Map could not be refreshed.' : 'Recall Map refreshed.';
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = previous;
    }
  }
}

async function loadPinnedHandoffStatus() {
  try {
    pinnedHandoffStatus = await api(`/api/context/pack/registry/status?workspaceId=${encodeURIComponent(workspaceId())}`);
    pinnedHandoffError = null;
  } catch (error) {
    pinnedHandoffStatus = null;
    pinnedHandoffError = error.message;
  }
}

async function loadLoopWorkbench() {
  try {
    loopWorkbench = await api(`/api/loop/workbench?workspaceId=${encodeURIComponent(workspaceId())}`);
    loopWorkbenchError = null;
  } catch (error) {
    loopWorkbench = null;
    loopWorkbenchError = error.message;
  }
}

async function loadMemoryCockpit() {
  try {
    memoryCockpit = await api(`/api/memory/cockpit?workspaceId=${encodeURIComponent(workspaceId())}`);
    memoryCockpitError = null;
  } catch (error) {
    memoryCockpit = null;
    memoryCockpitError = error.message;
  }
}

async function loadMemoryGraph(options = memoryGraphOptions) {
  const next={...memoryGraphOptions,...options};
  const params=new URLSearchParams({workspaceId:workspaceId(),history:next.history?'true':'false'});
  if(next.entity)params.set('entity',next.entity);
  if(next.query)params.set('query',next.query);
  try {
    memoryGraph = await api(`/api/memory/graph?${params.toString()}`);
    memoryGraphError = null;
    memoryGraphOptions=next;
  } catch (error) {
    memoryGraph = null;
    memoryGraphError = error.message;
    memoryGraphOptions=next;
  }
}

async function approveMemoryProposal(event) {
  const button=event.currentTarget;
  const proposalId=button.dataset.proposalId;
  if(!proposalId || !globalThis.confirm?.(`Approve memory proposal ${proposalId}?`))return;
  button.disabled=true;
  document.querySelector('#live-status').textContent='Approving memory proposal.';
  try{
    await api(`/api/memory/proposals/${encodeURIComponent(proposalId)}/approve`,{method:'POST',body:JSON.stringify({workspaceId:workspaceId(),confirm:true})});
    await loadMemoryCockpit();
    memoryIntakeResult=null;
    render();
    document.querySelector('#live-status').textContent='Memory proposal approved.';
  }catch(error){
    memoryCockpitError=error.message;
    render();
    document.querySelector('#live-status').textContent=error.message;
  }
}

async function submitMemoryIntake(event) {
  event.preventDefault();
  const form=event.currentTarget;
  const submitter=event.submitter;
  const dryRun=submitter?.value!=='queue';
  const data=new FormData(form);
  memoryIntakeDraft={
    sourceLocator:String(data.get('sourceLocator') ?? '').trim(),
    text:String(data.get('text') ?? '').trim()
  };
  if(!memoryIntakeDraft.text)return;
  if(!dryRun && !globalThis.confirm?.('Queue memory proposals for explicit approval?'))return;
  const previous=submitter?.textContent ?? '';
  if(submitter){
    submitter.disabled=true;
    submitter.textContent=dryRun?'Previewing...':'Queuing...';
  }
  document.querySelector('#live-status').textContent=dryRun?'Previewing memory proposals.':'Queuing memory proposals.';
  try{
    memoryIntakeResult=await api('/api/memory/proposals',{method:'POST',body:JSON.stringify({workspaceId:workspaceId(),sourceLocator:memoryIntakeDraft.sourceLocator,text:memoryIntakeDraft.text,dryRun,confirm:!dryRun})});
    memoryIntakeError=null;
    if(!dryRun)await loadMemoryCockpit();
    render();
    document.querySelector('#live-status').textContent=dryRun?'Memory proposal preview ready.':'Memory proposals queued for approval.';
  }catch(error){
    memoryIntakeResult=null;
    memoryIntakeError=error;
    render();
    document.querySelector('#live-status').textContent=error.message;
  }finally{
    if(submitter?.isConnected){
      submitter.disabled=false;
      submitter.textContent=previous;
    }
  }
}

function render() {
  const route=currentRoute();
  const setupScreen = shellState.kind === 'setup' || shellState.kind === 'denied';
  const appShell = document.querySelector('.app-shell');
  if (setupScreen) appShell.dataset.setup='true';
  else delete appShell.dataset.setup;
  renderNav(document.querySelector('#primary-nav'), 'rail');
  renderNav(document.querySelector('#mobile-nav'), 'bottom');
  renderRepositoryBar(route);
  const root=document.querySelector('#view-root');
  root.dataset.state=visibleShellState(route).kind;
  root.innerHTML = shellState.kind === 'loading'
    ? statePanel('loading','Loading local state','Checking the loopback control API for workspace data.')
    : renderRoute(route);
  root.querySelectorAll('[data-action=run]').forEach(button=>button.addEventListener('click',runDemo));
  root.querySelectorAll('[data-action=reset]').forEach(button=>button.addEventListener('click',resetDemo));
  root.querySelectorAll('[data-action=refresh-recall-map]').forEach(button=>button.addEventListener('click',refreshRecallMap));
  root.querySelectorAll('[data-run-id]').forEach(link=>link.addEventListener('click',showRun));
  root.querySelectorAll('[data-step-id],[data-record-id]').forEach(link=>link.addEventListener('click',navigateLocal));
  root.querySelector('#auth-form')?.addEventListener('submit',submitAuthForm);
  root.querySelector('#context-pack-form')?.addEventListener('submit',submitContextPack);
  root.querySelectorAll('[data-action=preview-context-sources]').forEach(button=>button.addEventListener('click',previewContextSources));
  root.querySelectorAll('[data-action=detect-git-changes]').forEach(button=>button.addEventListener('click',detectContextPackGitChanges));
  root.querySelectorAll('[data-action=refresh-pinned-handoff]').forEach(button=>button.addEventListener('click',refreshPinnedHandoff));
  root.querySelectorAll('[data-action=receive-pinned-handoff]').forEach(button=>button.addEventListener('click',receivePinnedHandoff));
  root.querySelector('#source-graph-form')?.addEventListener('submit',submitSourceGraph);
  root.querySelector('#memory-graph-form')?.addEventListener('submit',submitMemoryGraph);
  root.querySelector('#memory-intake-form')?.addEventListener('submit',submitMemoryIntake);
  root.querySelector('#memory-graph-history')?.addEventListener('change',toggleMemoryGraphHistory);
  root.querySelector('#memory-graph-communities')?.addEventListener('change',toggleMemoryGraphCommunities);
  root.querySelector('#harness-setup-form')?.addEventListener('submit',submitHarnessSetupPlan);
  root.querySelectorAll('[data-action=copy-pack]').forEach(button=>button.addEventListener('click',copyContextPack));
  root.querySelectorAll('[data-action=copy-receiver-packet]').forEach(button=>button.addEventListener('click',copyPinnedReceiverPacket));
  root.querySelectorAll('[data-action=copy-command]').forEach(button=>button.addEventListener('click',copyCommand));
  root.querySelectorAll('[data-action=download-pack]').forEach(button=>button.addEventListener('click',downloadContextPack));
  root.querySelectorAll('[data-action=download-use-plan]').forEach(button=>button.addEventListener('click',downloadContextPackUsePlan));
  root.querySelectorAll('[data-action=copy-memory-config]').forEach(button=>button.addEventListener('click',copyContextPackMemoryConfig));
  root.querySelectorAll('[data-action=download-memory-config]').forEach(button=>button.addEventListener('click',downloadContextPackMemoryConfig));
  root.querySelectorAll('[data-action=run-memory-preflight]').forEach(button=>button.addEventListener('click',runContextPackMemoryPreflight));
  root.querySelectorAll('[data-action=approve-memory-proposal]').forEach(button=>button.addEventListener('click',approveMemoryProposal));
  root.querySelectorAll('[data-action=pin-context-pack]').forEach(button=>button.addEventListener('click',pinCurrentContextPack));
  root.querySelectorAll('[data-action=preview-pack-setup]').forEach(button=>button.addEventListener('click',previewContextPackSetup));
  root.querySelectorAll('[data-action=copy-launch-prompt]').forEach(button=>button.addEventListener('click',copyContextPackLaunchPrompt));
  root.querySelectorAll('[data-fabric-node]').forEach(button=>button.addEventListener('click',selectFabricNode));
  if(route.id==='memory-graph')drawMemoryGraphCanvas(root.querySelector('#memory-graph-canvas'),memoryGraph,memoryGraphOptions);
  document.querySelectorAll('[data-route]').forEach(link=>link.onclick=navigate);
}

function renderNav(container, mode) {
  const currentOwner = navigationOwner(currentRoute().id);
  container.innerHTML = navigationItemsFor(mode).map((item) => `
    <a href="${item.path}" data-route="${item.routeId}" aria-label="${item.label}" title="${item.label}"${currentOwner === item.id ? ' aria-current="page"' : ''}>
      ${navIcon(item.id)}
      <span class="nav-label">${item.label}</span>
    </a>`).join('');
  container.dataset.mode = mode;
}

function renderRepositoryBar(route) {
  const repository = recallMap?.repository ?? null;
  const condition = visibleShellState(route);
  document.querySelector('#repository-name').textContent = repository?.name ?? 'Local workspace';
  document.querySelector('#repository-branch').textContent = repository?.branch ?? 'Branch unavailable';
  document.querySelector('#repository-scan').textContent = recallMap?.generatedAt ? `Scanned ${date(recallMap.generatedAt)}` : 'Not scanned';
  const conditionNode = document.querySelector('#repository-condition');
  conditionNode.textContent = condition.kind;
  conditionNode.dataset.state = condition.kind;
  const search=document.querySelector('#global-search-input');
  if(search&&document.activeElement!==search)search.value=recallMapSearchQuery();
}

function navIcon(id){const paths={overview:'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',map:'M5 4l5 2 4-2 5 2v14l-5-2-4 2-5-2zM10 6v14M14 4v14',memory:'M7 5h10a3 3 0 013 3v8a3 3 0 01-3 3H7a3 3 0 01-3-3V8a3 3 0 013-3zM8 9h8M8 13h6',handoffs:'M5 7h11M13 4l3 3-3 3M19 17H8M11 14l-3 3 3 3',settings:'M12 8a4 4 0 100 8 4 4 0 000-8zM12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4'};return `<svg class="nav-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${paths[id]??paths.overview}"/></svg>`}

function visibleShellState(route=currentRoute()) {
  if (route.id!=='home'||(!recallMap&&!recallMapError)) return shellState;
  const model=buildRecallMapHomeModel({ report:recallMap, error:recallMapError, gitChanges:recallMapGitChanges, pinnedHandoffStatus, pinnedHandoffError });
  const message=shellStateMessageForOverview(model.state);
  return { kind:model.state, message };
}

export function shellStateMessageForOverview(state) {
  return ({
    loading:'Loading the local Recall Map.',
    error:'Recall Map could not be loaded from the local API.',
    empty:'Recall Map loaded without bounded entry points.',
    partial:'Bounded Recall Map loaded; inspect supported coverage.',
    stale:'Pinned handoff source evidence changed and needs review.',
    success:'Recall Map loaded from local source and memory summaries.'
  })[state] ?? 'Recall Map loaded.';
}

function currentHandoffStatus() {
  const setupClient=contextPackResult?.pack ? contextPackSetupClient(contextPackResult.pack) : null;
  const setupResult=setupClient && harnessSetupResult?.client === setupClient ? harnessSetupResult : null;
  return buildCurrentHandoffStatusModel({contextPackResult,setupResult});
}

export function buildPinnedHandoffStatusModel(report=null,error=null) {
  if(error){
    return {
      state:'blocked',
      statusLabel:'error',
      title:'Pinned handoff unavailable',
      copy:String(error),
      currentEntryId:null,
      contextPackFingerprint:'unavailable',
      usePlanFingerprint:'unavailable',
      sourceChecks:null,
      targetLabel:'Codex',
      primaryCommand:null,
      commands:pinnedHandoffCommands('codex',false),
      facts:[['Registry','error'],['Current pointer','error'],['Use plan','not loaded']]
    };
  }
  const registryExists=report?.registry?.exists === true;
  const pointerExists=report?.currentPointer?.exists === true;
  const currentStatus=String(report?.current?.status ?? 'missing');
  const currentEntryId=report?.current?.entryId ?? null;
  const currentEntry=(report?.entries ?? []).find((entry)=>entry.id===currentEntryId) ?? null;
  const targetHarness=String(currentEntry?.targetHarness ?? 'codex');
  const verified=currentStatus === 'verified' && registryExists && pointerExists;
  const review=(currentStatus === 'stale' || currentStatus === 'review') && registryExists && pointerExists;
  const blocked=currentStatus === 'tampered' || (!registryExists && pointerExists) || (registryExists && !pointerExists);
  const state=verified ? 'ready' : review ? 'review' : blocked ? 'blocked' : 'none';
  const sourceChecks=currentEntry?.sourceChecks ?? null;
  const staleCount=Number(sourceChecks?.stale ?? 0);
  const unavailableCount=Number(sourceChecks?.unavailable ?? 0);
  const artifactProblem=(currentEntry?.artifactChecks ?? []).filter((item)=>item.status!=='verified').length;
  const title=state === 'ready'
    ? 'Pinned handoff ready'
    : state === 'review'
      ? 'Pinned handoff needs review'
      : state === 'blocked'
        ? 'Pinned handoff blocked'
        : 'No pinned handoff yet';
  const copy=state === 'ready'
    ? 'A CLI-pinned context pack is verified and ready for read-only receive.'
    : state === 'review'
      ? 'The pinned pack still exists, but changed or unavailable source hashes require review before the use-plan resource is served.'
      : state === 'blocked'
        ? 'The pinned registry, pointer, or artifacts failed verification. Re-pin before handing this to another agent.'
        : 'Use the CLI Pin locally command to write context-packs artifacts, then check again.';
  return {
    state,
    statusLabel:state === 'none' ? 'not pinned' : currentStatus,
    title,
    copy,
    currentEntryId,
    contextPackFingerprint:currentEntry?.contextPack?.fingerprint ? shortFingerprint(currentEntry.contextPack.fingerprint) : 'unavailable',
    usePlanFingerprint:currentEntry?.usePlan?.fingerprint ? shortFingerprint(currentEntry.usePlan.fingerprint) : 'unavailable',
    sourceChecks,
    targetLabel:harnessClientLabel(targetHarness),
    primaryCommand:verified ? {label:'Receive pinned pack',command:`npm run oaf -- context receive --read-only --root . --target ${targetHarness} --format json`} : null,
    commands:pinnedHandoffCommands(targetHarness,verified),
    facts:[
      ['Registry', registryExists ? report.registry.fingerprintStatus : 'missing'],
      ['Current pointer', pointerExists ? report.currentPointer.fingerprintStatus : 'missing'],
      ['Use plan', verified ? 'available' : 'withheld'],
      ['Stale sources', String(staleCount)],
      ['Unavailable hashes', String(unavailableCount)],
      ['Artifact issues', String(artifactProblem)]
    ]
  };
}

export function canReceivePinnedHandoff(state) {
  return state === 'ready' || state === 'review';
}

function pinnedHandoffCommands(targetHarness='codex',includeUsePlan=false) {
  const commands=[
    {label:'Receive pinned pack',command:`npm run oaf -- context receive --read-only --root . --target ${targetHarness} --format json`},
    {label:'Receive summary',command:`npm run oaf -- context receive --read-only --root . --target ${targetHarness} --format summary`},
    {label:'Check registry',command:'npm run oaf -- context registry status --read-only --format json'},
    {label:'Read registry',command:'npm run oaf -- mcp resources --read-only --uri oaf://workspace/ws_local/context-pack/registry/current --format json'}
  ];
  if(includeUsePlan){
    commands.splice(2,0,{label:'Read pinned use plan',command:'npm run oaf -- mcp resources --read-only --uri oaf://workspace/ws_local/context-pack/use-plan/current --format json'});
  }
  return commands;
}

function renderRoute(route) {
  if (shellState.kind === 'setup') return renderSetupScreen('bootstrap', 'Create a local owner before this browser can read workspace state.');
  if (shellState.kind === 'denied') return renderSetupScreen('login', 'Use the local owner account for this workspace.');
  if (shellState.kind === 'error') return statePanel('error','Could not load local state', shellState.message, true);
  if (route.id === 'home') return renderHome();
  if (route.id === 'runs') return activeRunDetail ? renderRunDetail(activeRunDetail) : renderRuns();
  if (route.id === 'workflows') return renderWorkflows();
  if (route.id === 'loop-workbench') return renderLoopWorkbench();
  if (route.id === 'fabric-map') return renderFabricMap();
  if (route.id === 'context') return renderContext();
  if (route.id === 'context-pack') return renderContextPack();
  if (route.id === 'source-graph') return renderSourceGraph();
  if (route.id === 'memory') return renderMemory();
  if (route.id === 'memory-graph') return renderMemoryGraph(memoryGraph,memoryGraphOptions,memoryGraphError);
  if (route.id === 'evidence') return renderEvidence();
  if (route.id === 'approvals') return renderApprovals();
  if (route.id === 'content') return renderContentLab();
  if (route.id === 'agents') return renderAgentsTools();
  if (route.id === 'settings') return renderSettings();
  return renderHome();
}

function renderHome() {
  return renderOverview(buildRecallMapHomeModel({
    report: recallMap,
    error: recallMapError,
    gitChanges: recallMapGitChanges,
    pinnedHandoffStatus,
    pinnedHandoffError
  }));
}

export function buildRecallMapHomeModel({ report=null, error=null, gitChanges=null, pinnedHandoffStatus=null, pinnedHandoffError=null }={}) {
  const model=buildOrientationModel({
    report,
    error,
    loading:!report&&!error,
    gitChanges,
    handoff:pinnedHandoffStatus,
    handoffError:pinnedHandoffError
  });
  return model.state==='failure' ? Object.freeze({...model,state:'error'}) : model;
}

export function renderOverview(model) {
  if (model.state==='loading') return `<section class="overview"><header class="page-heading"><h1>Overview</h1><button class="button" data-action="refresh-recall-map" type="button">Scan repository</button></header>${statePanel('loading',model.title,model.copy)}</section>`;
  if (model.state==='error') return `<section class="overview"><header class="page-heading"><h1>Overview</h1><button class="button" data-action="refresh-recall-map" type="button">Retry scan</button></header>${renderApiErrorPanel(model.title,model.error)}</section>`;
  const action=selectOverviewPrimaryAction(model);
  const actionHtml=action?.action
    ? `<button class="button primary" data-action="${esc(action.action)}" type="button">${esc(action.label)}</button>`
    : action
      ? `<a class="button primary" href="${esc(action.route)}" data-route="${esc(action.routeId)}">${esc(action.label)}</a>`
      : '<span class="overview-current">No action queued</span>';
  const stateCopy=model.state==='stale'
    ? statePanel('stale','Source changes need review','Repository evidence changed after the current handoff was pinned. Review the affected sources before sharing context.')
    : model.state==='empty'
      ? statePanel('empty','No JS/TS entry points yet','The map is live, but this workspace did not yield a bounded JS/TS entry point. Inspect supported coverage in Map before broadening the workspace.')
      : model.state==='partial'||model.coverage.status==='partial'
        ? statePanel('partial','Bounded coverage','The bounded scan completed, but the Map only indexes supported JS/TS metadata within its scan limits. Review its coverage notes before treating the repository picture as complete.')
        : '';
  const detectionFailed=model.impact.detectionStatus==='unavailable'||model.impact.detectionStatus==='error';
  const omittedChangeEvidence=model.impact.detectionStatus==='available'&&model.impact.omittedChangedCount>0;
  const changed=model.impact.changedLocators.length
    ? `<ul class="plain-list overview-changes">${model.impact.changedLocators.map((locator)=>`<li><code>${esc(locator)}</code></li>`).join('')}</ul>${model.impact.omittedChangedCount?`<p class="muted">${model.impact.changedCount} shown · ${model.impact.omittedChangedCount} omitted by safety or scan bounds.</p>`:''}`
    : detectionFailed
      ? `<div class="change-detection-warning"><strong>${model.impact.repositoryDirtyCount>0?`${model.impact.repositoryDirtyCount} changed entr${model.impact.repositoryDirtyCount===1?'y':'ies'}; `:''}file detection unavailable.</strong><p>${esc(model.impact.detectionMessage)}</p><button class="button secondary" data-action="refresh-recall-map" type="button">Retry scan</button></div>`
      : omittedChangeEvidence
        ? `<p class="muted">0 shown · ${model.impact.omittedChangedCount} omitted by safety or scan bounds.</p>`
      : model.impact.detectionStatus==='available'
        ? '<p class="muted">No changed files detected.</p>'
        : '<p class="muted">Changed-file detection has not run.</p>';
  const attention=[
    model.memory.pendingCount?`<a href="/memory" data-route="memory"><strong>${model.memory.pendingCount} pending</strong><span>Review proposed memory</span></a>`:'',
    model.memory.staleCount?`<a href="/memory" data-route="memory"><strong>${model.memory.staleCount} stale</strong><span>Check source changes</span></a>`:'',
    model.handoff.state==='blocked'?`<a href="/handoffs" data-route="context-pack"><strong>Handoff blocked</strong><span>Repair registry or pinned artifacts</span></a>`:'',
    model.handoff.state==='review'?`<a href="/handoffs" data-route="context-pack"><strong>Handoff needs review</strong><span>Update changed sources</span></a>`:'',
    detectionFailed?`<button type="button" data-action="refresh-recall-map"><strong>Change detection unavailable</strong><span>${esc(model.impact.detectionReason)}</span></button>`:'',
    omittedChangeEvidence?`<a href="/map" data-route="source-graph"><strong>${model.impact.omittedChangedCount} change${model.impact.omittedChangedCount===1?'':'s'} omitted</strong><span>Inspect safety and scan bounds</span></a>`:'',
    model.coverage.status==='partial'||model.coverage.diagnosticCount?`<a href="/map" data-route="source-graph"><strong>${model.coverage.diagnosticCount?`${model.coverage.diagnosticCount} coverage note${model.coverage.diagnosticCount===1?'':'s'}`:'Bounded coverage'}</strong><span>Inspect supported files and scan scope</span></a>`:''
  ].filter(Boolean).join('')||'<p class="muted">Nothing needs review.</p>';
  const affected=model.impact.affectedSymbols.length
    ? `<ol class="plain-list">${model.impact.affectedSymbols.slice(0,6).map((entry)=>`<li><strong>${esc(entry.label)}</strong><code>${esc(entry.locator ?? 'locator unavailable')}</code></li>`).join('')}</ol>`
    : '<p class="muted">No focused impact set.</p>';
  const activity=model.recentActivity.length
    ? `<ol class="activity-list">${model.recentActivity.map((item)=>`<li><span>${esc(item.label)}</span><code>${esc(item.detail ?? 'source unavailable')}</code><time>${esc(item.at?date(item.at):'time unavailable')}</time></li>`).join('')}</ol>`
    : '<p class="muted">No memory activity recorded.</p>';
  return `<section class="overview" aria-label="Repository overview">
    <header class="page-heading">
      <div><h1>${esc(model.repository.name)}</h1><p>${esc(model.repository.branch ?? 'Branch unavailable')} · ${model.repository.dirtyCount} changed · scanned ${esc(model.generatedAt?date(model.generatedAt):'not yet')}</p></div>
      ${actionHtml}
    </header>
    ${stateCopy}
    <div class="overview-grid">
      <section class="overview-section"><header><h2>Changes</h2><a href="/map" data-route="source-graph">Open Map</a></header>${changed}</section>
      <section class="overview-section"><header><h2>Needs attention</h2><a href="/memory" data-route="memory">Open Memory</a></header><div class="attention-list">${attention}</div></section>
      <section class="overview-section overview-impact"><header><h2>Impact</h2><span>${model.impact.affectedCount} affected</span></header>${affected}</section>
      <section class="overview-section"><header><h2>Current handoff</h2><a href="/handoffs" data-route="context-pack">Open Handoffs</a></header><dl class="summary-list"><div><dt>State</dt><dd>${esc(model.handoff.state)}</dd></div><div><dt>Age</dt><dd>${esc(model.handoff.ageLabel)}</dd></div><div><dt>Source check</dt><dd>${esc(model.handoff.copy)}</dd></div></dl></section>
      <section class="overview-section overview-activity"><header><h2>Recent activity</h2><span>${model.recentActivity.length}</span></header>${activity}</section>
    </div>
  </section>`;
}

export const renderRecallMapHome=renderOverview;

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

export function buildLoopWorkbenchModel(report=null,{dashboard=null,error=null}={}) {
  const fallback={
    schemaVersion:'1.0.0',
    workspaceId:'ws_local',
    generatedAt:new Date(0).toISOString(),
    plan:{status:'reference',command:'loop plan',maxIterations:3,timeoutSeconds:1800,sideEffectClass:'read-only'},
    runs:{status:'ready',count:0,latestRunId:null,controller:'bounded maxIterations and timeout'},
    observations:{status:'ready',count:0,rawOutputIncluded:false},
    verification:{status:'ready',count:0,autoMerge:false},
    tokenBudget:{basis:'contextBudget estimate',estimatedDeliveryTokens:0,aggregatedEstimatedDeliveryTokens:0,providerBillingClaimed:false},
    memoryLoop:null,
    stopReasons:['completed','validation_failed','blocked_needs_human','unsafe_action_required','max_iterations','timeout','unrelated_changes','out_of_scope'],
    trace:{eventCount:0,eventTypes:[]},
    safeguards:{readOnlyViews:true,planCreationViaControlApi:true,externalWritesEnabled:false,networkCalls:0,modelCalls:0,autoMerge:false}
  };
  const source=report?.schemaVersion === '1.0.0' ? report : fallback;
  return {
    source:error ? 'fallback' : report ? 'api' : 'local',
    error:error ? String(error) : null,
    workspaceId:source.workspaceId,
    generatedAt:source.generatedAt,
    plan:source.plan,
    runs:source.runs,
    observations:source.observations,
    verification:source.verification,
    tokenBudget:source.tokenBudget,
    memoryLoop:source.memoryLoop ?? null,
    stopReasons:source.stopReasons,
    trace:source.trace,
    safeguards:source.safeguards,
    dashboardRuns:Number(dashboard?.metrics?.runs ?? 0),
    pendingApprovals:Number(dashboard?.metrics?.pendingApprovals ?? 0)
  };
}

function renderLoopWorkbench() {
  const model=buildLoopWorkbenchModel(loopWorkbench,{dashboard,error:loopWorkbenchError});
  const stopReasonRows=model.stopReasons.map((reason)=>`<tr><td><code>${esc(reason)}</code></td><td>${loopStopReasonCopy(reason)}</td></tr>`).join('');
  const traceRows=(model.trace.eventTypes.length ? model.trace.eventTypes : ['loop.run_started','loop.run_stopped']).map((type)=>`<li><span>${esc(type)}</span></li>`).join('');
  const errorPanel=model.error ? statePanel('partial','Loop Workbench API unavailable',model.error,false) : '';
  return `${errorPanel}<section class="surface primary-flow" aria-label="Loop Workbench summary"><div><p class="eyebrow">Outcome</p><h2>${esc(model.runs.status)} loop controller</h2><p>Plan, observation, verification, schedule prompt, and stop-reason views stay local and read-only.</p></div><ol class="flow-mini" aria-label="Loop stages"><li><strong>1</strong><span>Intent plan</span></li><li><strong>2</strong><span>Scoped action</span></li><li><strong>3</strong><span>Observation</span></li><li><strong>4</strong><span>Verifier gate</span></li></ol><div class="action-row"><a class="button primary" href="/context-pack" data-route="context-pack">Create plan context</a><a class="button secondary" href="/runs" data-route="runs">View run trace</a></div></section><section class="metric-strip" aria-label="Loop Workbench metrics">${metric(model.plan.maxIterations,'Max iterations','Controller bound')}${metric(Math.round(Number(model.plan.timeoutSeconds??0)/60),'Timeout min','Stop bound')}${metric(model.tokenBudget.aggregatedEstimatedDeliveryTokens,'Budget tokens','Aggregated estimate')}${metric(model.trace.eventCount,'Loop events','Flight recorder')}</section>${renderLoopWorkbenchMemoryFlow(model.memoryLoop)}<section class="work-grid"><div class="surface surface-primary"><div class="section-heading"><h2>Current loop</h2><span>outcome before trace</span></div><dl class="facts facts-wide"><div><dt>Plan</dt><dd>${esc(model.plan.command)} · ${esc(model.plan.sideEffectClass)}</dd></div><div><dt>Runs</dt><dd>${esc(model.runs.status)} · ${model.runs.count} loop records</dd></div><div><dt>Observation</dt><dd>${esc(model.observations.status)} · raw output included: ${model.observations.rawOutputIncluded?'yes':'no'}</dd></div><div><dt>Verification</dt><dd>${esc(model.verification.status)} · auto-merge: ${model.verification.autoMerge?'enabled':'off'}</dd></div><div><dt>Budget basis</dt><dd>${esc(model.tokenBudget.basis)} · provider billing claimed: ${model.tokenBudget.providerBillingClaimed?'yes':'no'}</dd></div></dl><div class="section-heading"><h2>Stop reasons</h2><span>${model.stopReasons.length} controller exits</span></div><div class="table-wrap"><table><thead><tr><th>Reason</th><th>Meaning</th></tr></thead><tbody>${stopReasonRows}</tbody></table></div></div><aside class="inspector"><div class="section-heading"><h2>Trace</h2><span>${model.trace.eventCount} events</span></div><ol class="outline compact-outline">${traceRows}</ol><hr><h2>Safeguards</h2><dl class="facts compact-facts"><div><dt>Views</dt><dd>${model.safeguards.readOnlyViews?'read-only':'write-capable'}</dd></div><div><dt>Plan creation</dt><dd>${model.safeguards.planCreationViaControlApi?'Control API':'unavailable'}</dd></div><div><dt>External writes</dt><dd>${model.safeguards.externalWritesEnabled?'enabled':'disabled'}</dd></div><div><dt>Network calls</dt><dd>${model.safeguards.networkCalls}</dd></div><div><dt>Model calls</dt><dd>${model.safeguards.modelCalls}</dd></div></dl></aside></section>`;
}

export function renderLoopWorkbenchMemoryFlow(flow = null) {
  if(!flow)return statePanel('empty','No native memory loop data','Seed the native SQLite memory provider to connect compressed profile, loop plan, observation, proposal, and fact.');
  const profileBudget=flow.compressedProfile?.contextBudget ?? {};
  const loopBudget=flow.loopPlan?.contextBudget ?? {};
  const tokenSavingPercent=Math.round(Number(profileBudget.reductionRatio ?? 0) * 100);
  const proposal=flow.extractionProposal;
  const fact=flow.memoryFact;
  return `<section class="surface loop-memory-flow" aria-label="Native memory loop flow"><div class="section-heading"><div><p class="eyebrow">Native memory loop</p><h2>${tokenSavingPercent}% token saving into loop plan</h2></div><span>${esc(flow.observation?.status ?? 'ready')} observation</span></div><div class="flow-steps"><article class="flow-step"><span>1</span><strong>Objective</strong><em>${esc(flow.objective)}</em><small>local-only</small></article><article class="flow-step"><span>2</span><strong>Compressed profile</strong><em>${Number(profileBudget.estimatedDeliveryTokens ?? 0)} delivery tokens</em><small>${Number(profileBudget.historyTokensAvoided ?? 0)} history tokens avoided</small></article><article class="flow-step"><span>3</span><strong>Loop plan</strong><em>${Number(loopBudget.estimatedDeliveryTokens ?? 0)} budget tokens</em><small>${esc(flow.loopPlan?.validationCommands?.[0] ?? 'no validation command')}</small></article><article class="flow-step"><span>4</span><strong>Observe</strong><em>${esc(flow.observation?.status ?? 'ready')}</em><small>raw output excluded</small></article><article class="flow-step"><span>5</span><strong>Proposal</strong><em>${proposal?esc(proposal.status):'none'}</em><small>${proposal?esc(proposal.id):'no proposal queued'}</small></article><article class="flow-step"><span>6</span><strong>Memory fact</strong><em>${fact?esc(fact.status):'none'}</em><small>${fact?esc(fact.id):'no fact applied'}</small></article></div><dl class="facts facts-wide"><div><dt>Proposal text</dt><dd>${proposal?esc(proposal.text):'none'}</dd></div><div><dt>Fact text</dt><dd>${fact?esc(fact.text):'none'}</dd></div><div><dt>Validity</dt><dd>${fact?`${date(fact.validity?.validFrom)} to ${fact.validity?.validUntil?date(fact.validity.validUntil):'open'}`:'none'}</dd></div><div><dt>Superseded by</dt><dd>${esc(fact?.supersededBy ?? 'none')}</dd></div></dl></section>`;
}

function loopStopReasonCopy(reason) {
  return ({
    completed:'Stop condition passed.',
    validation_failed:'Checker command failed or returned non-zero.',
    blocked_needs_human:'Human approval or clarification is required.',
    unsafe_action_required:'Requested action exceeds the current policy boundary.',
    max_iterations:'Controller reached its bounded iteration cap.',
    timeout:'Controller reached its wall-clock timeout.',
    unrelated_changes:'Verifier found changes outside the Loop Plan scope.',
    out_of_scope:'The next action no longer matches the Loop Plan.'
  })[reason] ?? 'Controller stopped with a recorded reason.';
}

function renderFabricMap() {
  const handoff=currentHandoffStatus();
  const model=buildFabricMapModel({dashboard,shellState,activeNodeId:activeFabricNode,handoffStatus:handoff});
  return `<section class="fabric-stage" aria-label="Memory Recall system map"><div class="fabric-hero surface"><div><p class="eyebrow">Local map</p><h2>Local agent fabric</h2><p>Process flow, context assembly, policy gates, and disabled external boundaries rendered from the current workspace state.</p></div><dl class="fabric-scoreboard" aria-label="Current fabric counts"><div><dt>Runs</dt><dd>${model.summary.runs}</dd></div><div><dt>Context</dt><dd>${model.summary.selectedRecords}/${model.summary.excludedRecords}</dd></div><div><dt>Handoff</dt><dd>${esc(model.handoff.statusLabel)}</dd></div><div><dt>Approvals</dt><dd>${model.summary.pendingApprovals}</dd></div><div><dt>Adapters</dt><dd>${model.summary.externalAdaptersEnabled}</dd></div></dl></div>${renderHandoffStatusPanel(model.handoff,'fabric')}<div class="fabric-layout"><div class="surface surface-primary fabric-board"><div class="section-heading"><h2>Node conversation</h2><span>${model.links.filter((link)=>link.active).length} links with data</span></div>${fabricNodeGrid(model)}${fabricLinkList(model.links)}</div><aside class="inspector fabric-inspector"><div class="section-heading"><h2>${esc(model.activeNode.label)}</h2>${fabricStatus(model.activeNode.status,model.activeNode.statusLabel)}</div><p>${esc(model.activeNode.detail)}</p><dl class="facts compact-facts">${model.activeNode.facts.map((fact)=>`<div><dt>${esc(fact.label)}</dt><dd>${esc(fact.value)}</dd></div>`).join('')}<div><dt>Route</dt><dd><a href="${esc(model.activeNode.route)}" data-route="${esc(routeByPath.get(model.activeNode.route)?.id ?? 'home')}">${esc(model.activeNode.route)}</a></dd></div></dl><hr><div class="section-heading"><h2>Safeguards</h2><span>default posture</span></div>${fabricSafeguards(model.safeguards)}</aside></div>${fabricContextFlow(model.contextFlow)}</section>`;
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
  const errorPanel=contextPackError?renderApiErrorPanel('Context pack failed',contextPackError):'';
  const pinErrorPanel=contextPackPinError?renderApiErrorPanel('Pin locally failed',contextPackPinError):'';
  const memoryPreflightErrorPanel=contextPackMemoryPreflightError?renderApiErrorPanel('Memory preflight failed',contextPackMemoryPreflightError):'';
  const sourcePreviewPanel=contextSourcePreviewError?renderApiErrorPanel('Source preview failed',contextSourcePreviewError):contextSourcePreviewResult?renderContextSourcePreview(contextSourcePreviewResult):'';
  const resultPanel=pack?renderContextPackResult(pack,markdown):statePanel('empty','No context pack yet','Build a context pack to get a concrete next-agent handoff for this repository.');
  const formDraft=contextPackFormDraft();
  return `<div class="tool-workspace handoff-workspace">${contextPackFirstRunGuide()}${renderPinnedHandoffPanel(pinnedHandoffStatus,pinnedHandoffError,pinnedHandoffReceiveReport,pinnedHandoffReceiveError)}<section class="work-grid handoff-builder"><div class="surface surface-primary"><div class="section-heading"><h2>Build handoff</h2><span>Current local repository</span></div><form id="context-pack-form" class="stacked-form"><div class="field-grid"><label class="field"><span>Target</span><select name="targetHarness">${contextPackTargetOptions(formDraft.targetHarness)}</select></label><label class="field"><span>Token budget</span><input name="tokenBudget" type="number" min="1" max="100000" value="${esc(formDraft.tokenBudget)}" required></label></div>${contextPackSourceFamilyControls(formDraft.sourceFamilies)}<label class="field"><span>Objective</span><textarea name="objective" required maxlength="2000">${esc(formDraft.objective)}</textarea></label><label class="field"><span>Step</span><input name="step" value="${esc(formDraft.step)}" required maxlength="256"></label><label class="field"><span>Explicit relative files</span><textarea name="userSelectedFiles" maxlength="4000" placeholder="notes/handoff.md&#10;CONTEXT.md">${esc(formDraft.userSelectedFiles)}</textarea></label><label class="field"><span>Changed relative files</span><textarea name="changedLocators" maxlength="4000" placeholder="apps/web/app.js&#10;services/control-api/src/server.mjs">${esc(formDraft.changedLocators)}</textarea><small>Add reviewed workspace-relative files, or use git detection below.</small></label><label class="field"><span>Memory preflight sources (optional)</span><textarea name="memorySourceFiles" maxlength="4000" placeholder="notes/memory.md&#10;docs/decisions.md">${esc(formDraft.memorySourceFiles)}</textarea><small>Add only reviewed workspace-relative files. The browser keeps paths as config and can run read-only local preflight after the pack is built.</small></label><div class="action-row context-pack-detect-row"><button class="button secondary" data-action="preview-context-sources" type="button">Preview sources</button><span class="muted" data-source-preview-status>Dry-run selected source families before building.</span></div><div class="action-row context-pack-detect-row"><button class="button secondary" data-action="detect-git-changes" type="button">Detect current git changes</button><span class="muted" data-git-change-status>Read-only local git status. Review before building.</span></div><div class="action-row"><button class="button primary" type="submit">Build context pack</button><span class="muted">Dry run. Locators, hashes, and impact metadata only.</span></div></form></div><aside class="inspector"><h2>Review boundary</h2><dl class="facts"><div><dt>Input</dt><dd>Selected harness project files, explicit relative files, reviewed changed-file locators, and optional memory proposal file locators</dd></div><div><dt>Output</dt><dd>Markdown locator handoff with omission and impact hints</dd></div><div><dt>Browser</dt><dd>copy commands, download artifacts, run read-only memory preflight, preview setup, or explicitly pin reviewed local artifacts</dd></div><div><dt>Server writes</dt><dd>only the Pin locally action writes fixed context-packs artifacts</dd></div></dl>${localBoundary()}</aside></section>${sourcePreviewPanel}${memoryPreflightErrorPanel}${pinErrorPanel}${errorPanel}${resultPanel}</div>`;
}

function contextPackFirstRunGuide() {
  return `<header class="tool-page-heading"><div><p class="eyebrow">Current handoff</p><h1>Handoffs</h1><p>Review the pinned pack or build a replacement from explicit repository inputs.</p></div><span>Local · review before pinning</span></header>`;
}

function renderPinnedHandoffPanel(report,error=null,receiveReport=null,receiveError=null) {
  const model=buildPinnedHandoffStatusModel(report,error);
  const primary=model.primaryCommand ? `<hr><div class="section-heading"><h2>Consume in ${esc(model.targetLabel)}</h2><span>read-only</span></div>${contextPackCommandList([model.primaryCommand])}` : '';
  const receiveButton=canReceivePinnedHandoff(model.state) ? '<button class="button primary" data-action="receive-pinned-handoff" type="button">Receive pinned pack</button>' : '';
  return `<section class="work-grid pinned-handoff" aria-label="Pinned handoff status"><div class="surface surface-primary"><div class="section-heading"><h2>${esc(model.title)}</h2>${statusChip(model.state,model.statusLabel,'Pinned handoff status')}</div><p>${esc(model.copy)}</p><dl class="facts facts-wide"><div><dt>Entry</dt><dd>${esc(model.currentEntryId ?? 'none')}</dd></div><div><dt>Context pack</dt><dd>${esc(model.contextPackFingerprint)}</dd></div><div><dt>Use plan</dt><dd>${esc(model.usePlanFingerprint)}</dd></div>${model.facts.map(([key,value])=>`<div><dt>${esc(key)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>${primary}<div class="action-row">${receiveButton}<button class="button secondary" data-action="refresh-pinned-handoff" type="button">Check pinned handoff</button></div></div><aside class="inspector"><div class="section-heading"><h2>Receive boundary</h2><span>read-only</span></div><p class="muted">This panel reads the local registry status only. It does not create memory, write harness config, call models, use network access, or enable adapters.</p>${contextPackCommandList(model.commands)}</aside></section>${renderPinnedReceivePacketPanel(receiveReport,receiveError)}`;
}

function renderPinnedReceivePacketPanel(report=null,error=null) {
  if(error)return renderApiErrorPanel('Receive pinned pack failed',error);
  if(!report?.receiverPacket)return '';
  const packet=report.receiverPacket;
  const packetTitle=packet.state === 'ready' ? 'Receiver packet ready' : 'Receiver packet needs review';
  const reads=packet.readPlan?.requiredReads ?? [];
  const actions=packet.nextActions ?? [];
  const partTypes=(packet.messageParts ?? []).map((item)=>item.partType).filter(Boolean);
  const partSchemas=(packet.messageParts ?? []).map((item)=>[item.partType,item.contentType,item.schemaVersion].filter(Boolean).join(' ')).filter(Boolean);
  const reviewBlockers=contextPackSourceCheckReview(report.registry?.sourceChecks);
  return `<section class="work-grid receiver-packet" aria-label="Pinned receiver packet"><div class="surface surface-primary"><div class="section-heading"><h2>${packetTitle}</h2>${statusChip(packet.state,packet.state,'Receiver packet state')}</div><p>${esc(packet.summary)}</p><dl class="facts facts-wide"><div><dt>Target</dt><dd>${esc(packet.targetHarness)}</dd></div><div><dt>Packet parts</dt><dd>${esc(partTypes.join(', ')||'legacy packet')}</dd></div><div><dt>Part schemas</dt><dd>${esc(partSchemas.join(', ')||'unavailable')}</dd></div><div><dt>Required reads</dt><dd>${Number(packet.readPlan?.requiredReadCount ?? 0)}</dd></div><div><dt>Included reads</dt><dd>${Number(packet.readPlan?.includedReadCount ?? 0)}</dd></div><div><dt>Tools exposed</dt><dd>${Number(packet.proof?.toolsExposed ?? 0)}</dd></div><div><dt>External writes</dt><dd>${packet.proof?.externalWritesEnabled?'enabled':'disabled'}</dd></div><div><dt>Report</dt><dd>${esc(shortFingerprint(report.reportFingerprint))}</dd></div></dl><div class="action-row"><button class="button primary" data-action="copy-receiver-packet" type="button">Copy receiver packet</button></div></div><aside class="inspector">${reviewBlockers}<div class="section-heading"><h2>Read first</h2><span>${reads.length} shown</span></div>${reads.length?`<ol class="locator-list compact-list">${reads.map((item)=>`<li><strong>${esc(item.role)}</strong><code>${esc(item.locator)}</code><small>${item.contentHash?'hash verified':'hash unavailable'} · ${esc((item.reasonCodes??[]).slice(0,2).join(', ')||'review')}</small></li>`).join('')}</ol>`:'<p class="muted">No verified read plan is available yet.</p>'}<hr><div class="section-heading"><h2>Next actions</h2><span>read-only</span></div>${contextPackCommandList(actions.slice(0,4).map((item)=>({label:item.label,command:item.command})))}</aside></section>`;
}

function contextPackSourceCheckReview(sourceChecks=null) {
  const stale=Array.isArray(sourceChecks?.staleLocators) ? sourceChecks.staleLocators : [];
  const unavailable=Array.isArray(sourceChecks?.unavailableLocators) ? sourceChecks.unavailableLocators : [];
  const blockers=[
    ...stale.map((locator)=>({locator,reason:'hash changed'})),
    ...unavailable.map((locator)=>({locator,reason:'hash unavailable'}))
  ];
  if(!blockers.length)return '';
  return `<div class="section-heading"><h2>Review blockers</h2><span>${blockers.length}</span></div><ol class="locator-list compact-list">${blockers.slice(0,8).map((item)=>`<li><strong>${esc(item.reason)}</strong><code>${esc(item.locator)}</code><small>Rebuild or re-pin after manual review.</small></li>`).join('')}</ol><hr>`;
}

function renderContextPackResult(pack,markdown) {
  const model=buildContextPackUiModel(pack,markdown,{observedDurationMs:contextPackResult?.observedDurationMs,readback:contextPackResult?.readback,usePlan:contextPackResult?.usePlan});
  const setupResult=harnessSetupResult?.client===model.setupClient?harnessSetupResult:null;
  const readiness=buildFirstUseReadinessModel({pack,markdown,readback:contextPackResult?.readback,setupResult,memoryConfig:contextPackResult?.memoryConfig,memoryPreflight:contextPackResult?.memoryProposalPreflight});
  const handoff=buildCurrentHandoffStatusModel({contextPackResult,setupResult});
  const memoryPreflight=contextPackResult?.memoryProposalPreflight ?? null;
  const memoryActions=model.memoryConfig.configured?`<button class="button secondary" data-action="copy-memory-config" type="button">Copy memory config</button><button class="button secondary" data-action="download-memory-config" type="button">Download memory config</button><button class="button secondary" data-action="run-memory-preflight" type="button">Run memory preflight</button>`:'';
  const artifactHeading=readiness.ready?'Handoff ready':'Handoff needs review';
  return `<section class="context-value-ledger" aria-label="Context pack proof metrics">${contextPackProofLedger(model.proof)}</section>${renderContextPackTokenSaverSummary(model)}${contextPackLaunchPath(model,readiness,memoryPreflight)}${contextPackOperatorBrief(model,readiness)}${renderHandoffStatusPanel(handoff,'context-pack')}${contextPackPinSummary(contextPackResult?.pin)}<section class="work-grid"><div class="surface surface-primary"><div class="section-heading"><h2>${artifactHeading}</h2><span title="${esc(pack.contextPackFingerprint)}">${esc(model.fingerprintShort)}</span></div><div class="artifact-actions"><button class="button primary" data-action="copy-pack" type="button">Copy markdown</button><button class="button secondary" data-action="copy-launch-prompt" type="button">Copy launch prompt</button><button class="button secondary" data-action="pin-context-pack" type="button">Pin locally</button><button class="button secondary" data-action="download-pack" type="button">Download .md</button><button class="button secondary" data-action="download-use-plan" type="button">Download use plan</button>${memoryActions}<button class="button secondary" data-action="preview-pack-setup" data-client="${esc(model.setupClient)}" type="button">Preview setup</button><a class="button secondary" href="/source-graph" data-route="source-graph">Inspect graph</a></div><textarea id="context-pack-output" class="pack-output" readonly>${esc(markdown)}</textarea></div><aside class="inspector">${contextPackReadinessPanel(readiness)}<hr><div class="section-heading"><h2>Impact brief</h2><span>${esc(model.impactBrief.status)}</span></div>${contextPackImpactBriefPanel(model.impactBrief)}<hr><div class="section-heading"><h2>Utility read plan</h2><span>${esc(model.utility.status)}</span></div>${contextPackUtilityPanel(model.utility)}<hr><div class="section-heading"><h2>Use now</h2><span>Export plan explicitly</span></div>${contextPackCommandList(model.commands)}<hr><div class="section-heading"><h2>Intake review</h2><span>${esc(model.sourceFamilyLabel)}</span></div>${contextPackIntakeReview(model.intakeReview)}${model.memoryConfig.configured?`<hr><div class="section-heading"><h2>Memory preflight</h2><span>${model.memoryConfig.pathCount} files</span></div>${contextPackMemoryConfigPanel(model.memoryConfig,memoryPreflight)}`:''}<hr><div class="section-heading"><h2>Readback proof</h2><span>${esc(model.proof.readbackFingerprintLabel)}</span></div>${contextPackReadbackProof(model.proof)}<hr><div class="section-heading"><h2>Repository</h2><span>${esc(pack.repository?.gitStatusAvailable?'git':'unavailable')}</span></div>${contextPackRepositoryPanel(pack.repository)}<hr><div class="section-heading"><h2>Change Impact</h2><span>${model.changedLocators}</span></div>${contextPackChangeImpact(pack.sourceGraph?.impact)}<hr><div class="section-heading"><h2>Selected locators</h2><span>${pack.readFirst.length}</span></div>${contextPackLocatorList(pack.readFirst)}<hr><div class="section-heading"><h2>Omitted refs</h2><span>${Number(pack.omissions?.excludedCount??0)}</span></div>${contextPackOmissionList(pack.omissions)}<hr><div class="section-heading"><h2>Graph hints</h2><span>${esc(pack.sourceGraph?.status??'unavailable')}</span></div>${contextPackSourceGraphList(pack.sourceGraph)}<hr><div class="section-heading"><h2>Warnings</h2><span>${model.warningCount}</span></div>${reasons(pack.warnings)}<hr><dl class="facts"><div><dt>Target</dt><dd>${esc(pack.targetHarness)}</dd></div><div><dt>Candidate tokens</dt><dd>${Number(pack.preview.candidateTokenCount??0)}</dd></div><div><dt>Selected source tokens</dt><dd>${Number(pack.preview.selectedTokenCount??0)} (${esc(model.selectedTokenRatio)})</dd></div><div><dt>Delivered handoff tokens</dt><dd>${model.deliveredTokens} (${esc(model.deliveredTokenRatio)})</dd></div><div><dt>Delivery reduction</dt><dd>${esc(model.deliveryReductionPercent)}</dd></div><div><dt>Use-plan reads</dt><dd>${model.usePlanReadCount}</dd></div><div><dt>Observed build time</dt><dd>${esc(model.proof.observedDurationLabel)}</dd></div><div><dt>External writes</dt><dd>disabled</dd></div></dl></aside></section>${setupResult?renderHarnessSetupResult(setupResult):''}`;
}

export function renderContextPackTokenSaverSummary(model) {
  const requiredReads=(model.tokenSaver.requiredReadFiles?.length ? model.tokenSaver.requiredReadFiles : model.tokenSaver.selectedFiles) ?? [];
  const selected=requiredReads.length
    ? `<ol class="locator-list compact-list">${requiredReads.map((locator)=>`<li><code>${esc(locator)}</code></li>`).join('')}</ol>`
    : '<p class="muted">No required reads measured yet.</p>';
  const excluded=model.tokenSaver.excludedFiles.length
    ? `<ol class="locator-list compact-list">${model.tokenSaver.excludedFiles.map((locator)=>`<li><code>${esc(locator)}</code></li>`).join('')}</ol>`
    : `<p class="muted">${Number(model.omittedRefs)} omitted refs; build a pack to inspect exact excluded locators.</p>`;
  const command=model.tokenSaver.command ? contextPackCommandList([{label:'Measure token saver',command:model.tokenSaver.command}]) : '';
  const hasMeasuredBaseline=model.tokenSaver.hasMeasuredBaseline === true;
  const heading=hasMeasuredBaseline
    ? `${Number(model.tokenSaver.beforeTokens)} -> ${Number(model.tokenSaver.afterTokens)} tokens`
    : `${Number(model.tokenSaver.afterTokens)} token handoff`;
  const badge=hasMeasuredBaseline
    ? `${model.tokenSaver.savedLabel} saved`
    : `${model.tokenSaver.changedSourceAvoidedLabel} changed source avoided`;
  const proof=hasMeasuredBaseline
    ? `<dl class="facts compact-facts"><div><dt>Before</dt><dd>${Number(model.tokenSaver.beforeTokens)} tokens</dd></div><div><dt>After</dt><dd>${Number(model.tokenSaver.afterTokens)} tokens</dd></div><div><dt>Reduction</dt><dd>${esc(model.tokenSaver.savedLabel)}</dd></div><div><dt>Provider billing</dt><dd>not claimed</dd></div></dl>`
    : `<dl class="facts compact-facts"><div><dt>Handoff</dt><dd>${Number(model.tokenSaver.afterTokens)} tokens</dd></div><div><dt>Changed source avoided</dt><dd>${esc(model.tokenSaver.changedSourceAvoidedLabel)}</dd></div><div><dt>Baseline</dt><dd>run measure command</dd></div><div><dt>Provider billing</dt><dd>not claimed</dd></div></dl>`;
  return `<section class="surface token-saver-summary" aria-label="Token Saver summary"><div class="section-heading"><div><p class="eyebrow">Token Saver</p><h2>${esc(heading)}</h2></div><span>${esc(badge)}</span></div><div class="handoff-brief-grid"><article><h3>Proof</h3>${proof}</article><article><h3>Required reads</h3>${selected}</article><article><h3>Excluded files</h3>${excluded}</article></div>${command}</section>`;
}

function contextPackPinSummary(pin=null) {
  if(!pin?.pinned)return '';
  const status=pin.current?.status ?? pin.registryStatus?.current?.status ?? 'review';
  return `<section class="work-grid pinned-local-proof" aria-label="Pinned local handoff proof"><div class="surface surface-primary"><div class="section-heading"><h2>Pinned locally</h2>${statusChip(status,status,'Pinned local handoff')}</div><p>The reviewed pack was written to fixed local context-pack artifacts and immediately verified through the registry.</p><dl class="facts facts-wide"><div><dt>Files written</dt><dd>${Number(pin.localFilesWritten ?? 0)}</dd></div><div><dt>Entry</dt><dd>${esc(pin.registryEntry?.id ?? 'unavailable')}</dd></div><div><dt>Registry</dt><dd>${esc(shortFingerprint(pin.registry?.registryFingerprint ?? ''))}</dd></div><div><dt>External writes</dt><dd>disabled</dd></div></dl></div><aside class="inspector"><div class="section-heading"><h2>Written artifacts</h2><span>fixed paths</span></div><ol class="locator-list compact-list">${(pin.artifacts ?? []).map((item)=>`<li><strong>${esc(item.role)}</strong><code>${esc(item.locator)}</code><small>${esc(shortFingerprint(item.contentHash ?? ''))}</small></li>`).join('')}</ol></aside></section>`;
}

function contextPackRepositoryPanel(repository=null) {
  const commit=repository?.commitSha ? String(repository.commitSha).slice(0,12) : 'unavailable';
  const branch=repository?.branch ?? 'unavailable';
  const status=repository?.gitStatusAvailable ? `${Number(repository.dirtyCount ?? 0)} changed entries` : `unavailable${repository?.reason?`: ${repository.reason}`:''}`;
  return `<dl class="facts compact-facts"><div><dt>Branch</dt><dd>${esc(branch)}</dd></div><div><dt>Commit</dt><dd>${esc(commit)}</dd></div><div><dt>Status</dt><dd>${esc(status)}</dd></div><div><dt>Paths</dt><dd>not included</dd></div><div><dt>Diffs</dt><dd>not included</dd></div></dl>`;
}

function renderHandoffStatusPanel(status,scope='default') {
  const routeId=routeByPath.get(status.actionRoute)?.id ?? 'context-pack';
  const preflightCommands=status.preflightCommand
    ? [
      {label:'Test local handoff',command:status.preflightCommand},
      {label:'Test handoff summary',command:status.preflightSummaryCommand}
    ].filter((item)=>item.command)
    : [];
  const commands=preflightCommands.length ? contextPackCommandList(preflightCommands) : '';
  return `<section class="work-grid current-handoff current-handoff-${esc(scope)}" aria-label="Current handoff status"><div class="surface surface-primary"><div class="section-heading"><h2>${esc(status.title)}</h2>${statusChip(status.state,status.statusLabel,'Handoff status')}</div><p>${esc(status.copy)}</p><dl class="facts facts-wide"><div><dt>Target</dt><dd>${esc(status.targetHarness)}</dd></div><div><dt>Fingerprint</dt><dd>${esc(status.fingerprintShort)}</dd></div><div><dt>Selected</dt><dd>${Number(status.selectedLocators)} locators</dd></div><div><dt>Omitted</dt><dd>${Number(status.omittedRefs)} refs</dd></div><div><dt>Use-plan reads</dt><dd>${Number(status.usePlanReads)}</dd></div><div><dt>Reduction</dt><dd>${esc(status.deliveryReductionPercent)}</dd></div><div><dt>MCP readback</dt><dd>${esc(status.readbackStatus)}</dd></div><div><dt>Setup</dt><dd>${esc(status.setupStatus)}</dd></div></dl><div class="action-row"><a class="button ${status.state==='none'?'primary':'secondary'}" href="${esc(status.actionRoute)}" data-route="${esc(routeId)}">${esc(status.actionLabel)}</a></div></div><aside class="inspector"><div class="section-heading"><h2>Use boundary</h2><span>${esc(status.nextAction)}</span></div><dl class="facts compact-facts"><div><dt>Server writes</dt><dd>${status.safeguards.serverWrites?'enabled':'none'}</dd></div><div><dt>Home config writes</dt><dd>${status.safeguards.configWrites?'enabled':'none'}</dd></div><div><dt>Network calls</dt><dd>${Number(status.safeguards.networkCalls)}</dd></div><div><dt>Model calls</dt><dd>${Number(status.safeguards.modelCalls)}</dd></div><div><dt>External writes</dt><dd>${status.safeguards.externalWritesEnabled?'enabled':'disabled'}</dd></div><div><dt>External adapters</dt><dd>${Number(status.safeguards.externalAdaptersEnabled)}</dd></div><div><dt>Raw bodies</dt><dd>${status.safeguards.rawBodiesRendered?'rendered':'excluded'}</dd></div></dl>${commands?`<hr><div class="section-heading"><h2>Preflight</h2><span>read-only</span></div>${commands}`:''}</aside></section>`;
}

export function buildContextPackUiModel(pack,markdown='',meta={}) {
  const candidateTokens=Number(pack?.preview?.candidateTokenCount ?? 0);
  const selectedTokens=Number(pack?.preview?.selectedTokenCount ?? 0);
  const deliveredTokens=Number(pack?.delivery?.deliveredTokenCount ?? 0);
  const changedSourceBudget=pack?.utility?.changedSourceBudget ?? {};
  const changedSourceTokenCount=Number(changedSourceBudget.contentTokenCount ?? 0);
  const changedSourceAvoidanceRatio=Number(changedSourceBudget.observedAvoidanceRatio ?? 0);
  const changedSourceAvoidedLabel=changedSourceTokenCount > 0
    ? `${changedSourceTokenCount} tokens (${boundedPercent(changedSourceAvoidanceRatio)}%)`
    : 'not measured';
  const sourceFamilies=contextPackSourceFamilies(pack);
  const observedDurationMs=Number(meta?.observedDurationMs);
  const observedDurationLabel=Number.isFinite(observedDurationMs) ? `${Math.max(0,Math.round(observedDurationMs))} ms` : 'not measured';
  const readback=meta?.readback ?? null;
  const readbackDurationMs=Number(readback?.measurements?.durationMs);
  const readbackDurationLabel=Number.isFinite(readbackDurationMs) ? `${Math.max(0,Math.round(readbackDurationMs))} ms` : 'not run';
  const readbackResourceBytes=Number(readback?.measurements?.resourceByteSize);
  const readbackResourceBytesLabel=Number.isFinite(readbackResourceBytes) ? `${Math.max(0,Math.round(readbackResourceBytes))} bytes` : 'not measured';
  const readbackFingerprintLabel=readback?.checks?.contextPackFingerprintMatches===true?'match':'check';
  const usePlan=meta?.usePlan ?? null;
  const memoryConfig=normalizeMemoryWorkspaceConfig(meta?.memoryConfig ?? contextPackMemoryConfig);
  const hasCandidateTokenBaseline=candidateTokens > 0;
  const selectedTokenRatioLabel=hasCandidateTokenBaseline ? `${Math.round(selectedTokens / candidateTokens * 100)}%` : 'not measured';
  const deliveredTokenRatioLabel=hasCandidateTokenBaseline ? `${Math.round(deliveredTokens / candidateTokens * 100)}%` : 'not measured';
  const estimatedReductionPercent=hasCandidateTokenBaseline
    ? Math.max(0,Math.min(100,Math.round((1 - selectedTokens / candidateTokens) * 100)))
    : null;
  const deliveryReductionPercent=hasCandidateTokenBaseline
    ? Math.max(0,Math.min(100,Math.round((1 - deliveredTokens / candidateTokens) * 100)))
    : null;
  const deliveryReductionLabel=deliveryReductionPercent===null ? 'not measured' : `${deliveryReductionPercent}%`;
  const rawBodiesExcluded=pack?.delivery?.sourceContentsIncluded===false && pack?.safeguards?.rawBodyIncluded===false;
  const commands=contextPackHarnessCommands(pack,usePlan,{memoryConfig});
  const tokenSaverCommand=commands.find((item)=>item.label==='Copy impact command')?.command ?? '';
  const requiredReadFiles=[...new Set([
    ...(Array.isArray(pack?.readFirst) ? pack.readFirst : []).map((item)=>String(item.locator ?? '')).filter(Boolean),
    ...(Array.isArray(pack?.utility?.requiredLocalReads) ? pack.utility.requiredLocalReads : [])
      .filter((item)=>item?.required===true)
      .map((item)=>String(item.locator ?? ''))
      .filter(Boolean)
  ])].slice(0,6);
  return {
    targetHarness:String(pack?.targetHarness ?? 'generic'),
    sourceFamilies,
    sourceFamilyLabel:sourceFamilies.join(', '),
    markdownBytes:new Blob([String(markdown)]).size,
    usePlanBytes:new Blob([JSON.stringify(usePlan ?? {},null,2)]).size,
    usePlanReadCount:Array.isArray(usePlan?.requiredLocalReads) ? usePlan.requiredLocalReads.length : Number(pack?.utility?.requiredLocalReads?.length ?? 0),
    usePlanDownloadName:contextPackUsePlanDownloadName(pack),
    memoryConfig:{
      configured:memoryConfig.memoryPaths.length > 0,
      pathCount:memoryConfig.memoryPaths.length,
      downloadName:memoryConfigDownloadName(),
      json:memoryConfigJson(memoryConfig),
      commandFlag:memoryConfig.memoryPaths.length ? ' --memory-config oaf.memory.json' : ''
    },
    selectedLocators:Array.isArray(pack?.readFirst) ? pack.readFirst.length : 0,
    omittedRefs:Number(pack?.omissions?.excludedCount ?? 0),
    selectedTokens,
    deliveredTokens,
    candidateTokens,
    estimatedReductionPercent:estimatedReductionPercent ?? 0,
    downloadName:contextPackDownloadName(pack),
    excludedTokens:Number(pack?.omissions?.excludedTokenCount ?? 0),
    sourceGraphOmittedCount:Number(pack?.omissions?.sourceGraphOmittedCount ?? 0),
    warningCount:Array.isArray(pack?.warnings) ? pack.warnings.length : 0,
    selectedTokenRatio:selectedTokenRatioLabel,
    deliveredTokenRatio:deliveredTokenRatioLabel,
    deliveryReductionPercent:deliveryReductionLabel,
    fingerprintShort:shortFingerprint(pack?.contextPackFingerprint ?? ''),
    changedLocators:Array.isArray(pack?.sourceGraph?.impact?.changedLocators) ? pack.sourceGraph.impact.changedLocators.length : 0,
    affectedSymbols:Number(pack?.sourceGraph?.impact?.affectedSymbolCount ?? 0),
    setupClient:contextPackSetupClient(pack),
    intakeReview:buildContextPackIntakeReview(pack),
    impactBrief:buildContextPackImpactBriefUiModel(pack),
    launchPrompt:String(pack?.handoff?.launchPrompt ?? ''),
    utility:buildContextPackUtilityUiModel(pack?.utility),
    proof:{
      tokenSaved:deliveryReductionLabel,
      selectedTokenRatio:selectedTokenRatioLabel,
      changedSourceAvoidedLabel,
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
    tokenSaver:{
      beforeTokens:candidateTokens,
      afterTokens:deliveredTokens,
      hasMeasuredBaseline:candidateTokens > 0,
      savedLabel:deliveryReductionLabel,
      changedSourceAvoidedLabel,
      selectedFiles:(Array.isArray(pack?.readFirst) ? pack.readFirst : []).map((item)=>String(item.locator ?? '')).filter(Boolean).slice(0,5),
      requiredReadFiles,
      excludedFiles:(Array.isArray(pack?.excluded) ? pack.excluded : []).map((item)=>String(item.locator ?? '')).filter(Boolean).slice(0,5),
      command:tokenSaverCommand
    },
    commands
  };
}

function buildContextPackUtilityUiModel(utility) {
  const requiredReads=Array.isArray(utility?.requiredLocalReads) ? utility.requiredLocalReads : [];
  const changedReads=requiredReads.filter((item)=>item?.role==='changed_locator');
  const changedHashVerified=changedReads.filter((item)=>typeof item?.contentHash==='string'&&item.contentHash.startsWith('sha256:')).length;
  const changed=utility?.changedLocatorCoverage ?? {};
  const graph=utility?.graphHintCoverage ?? {};
  const source=utility?.sourceSelection ?? {};
  const changedSource=utility?.changedSourceBudget ?? {};
  return {
    status:String(utility?.status ?? 'review'),
    requiredReadCount:requiredReads.filter((item)=>item?.required===true).length,
    changedCoverageLabel:`${Number(changed.covered??0)}/${Number(changed.total??0)}`,
    changedCoveragePercent:`${boundedPercent(changed.ratio)}%`,
    changedHashVerifiedLabel:`${changedHashVerified}/${changedReads.length}`,
    graphCoverageLabel:`${Number(graph.covered??0)}/${Number(graph.total??0)}`,
    sourceSelectionRatio:`${boundedPercent(source.selectedTokenRatio)}%`,
    sourceReduction:`${boundedPercent(source.estimatedReductionRatio)}%`,
    changedSourceBudgetLabel:`${Number(changedSource.measuredLocatorCount??0)}/${Number(changedSource.locatorCount??0)} files, ${Number(changedSource.contentTokenCount??0)} tokens`,
    topReads:requiredReads.slice(0,5).map((item)=>({
      locator:String(item.locator ?? ''),
      role:String(item.role ?? 'selected_context'),
      required:item.required===true,
      contentHash:String(item.contentHash ?? '')
    }))
  };
}

function buildContextPackImpactBriefUiModel(pack) {
  const impact=pack?.sourceGraph?.impact ?? {};
  const utility=pack?.utility ?? {};
  const changed=utility.changedLocatorCoverage ?? {total:0,covered:0,ratio:0,status:'not_applicable'};
  const graph=utility.graphHintCoverage ?? {total:0,covered:0,ratio:0,status:'not_applicable'};
  const requiredReads=Array.isArray(utility.requiredLocalReads) ? utility.requiredLocalReads.filter((item)=>item?.required===true) : [];
  const changedReads=requiredReads.filter((item)=>item?.role==='changed_locator');
  const sourceSelection=utility.sourceSelection ?? {};
  return {
    status:utility.status==='ready'&&changed.status!=='partial'?'ready':'review',
    changedCoverageLabel:`${Number(changed.covered??0)}/${Number(changed.total??0)}`,
    changedCoveragePercent:`${boundedPercent(changed.ratio)}%`,
    representedChangedCount:Array.isArray(impact.representedChangedLocators) ? impact.representedChangedLocators.length : 0,
    affectedSymbolCount:Number(impact.affectedSymbolCount ?? 0),
    omittedAffectedSymbolCount:Number(impact.omittedAffectedSymbolCount ?? 0),
    graphCoverageLabel:`${Number(graph.covered??0)}/${Number(graph.total??0)}`,
    requiredReadCount:requiredReads.length,
    changedHashVerifiedCount:changedReads.filter((item)=>typeof item?.contentHash==='string'&&item.contentHash.startsWith('sha256:')).length,
    selectedUnitRatio:`${boundedPercent(sourceSelection.selectedTokenRatio)}%`,
    estimatedReductionRatio:`${boundedPercent(sourceSelection.estimatedReductionRatio)}%`,
    sourceGraphStatus:String(pack?.sourceGraph?.status ?? 'unavailable'),
    topReads:requiredReads.slice(0,4).map((item)=>({
      locator:String(item.locator ?? ''),
      role:String(item.role ?? ''),
      represented:item.represented!==false,
      contentHash:String(item.contentHash ?? '')
    })),
    affectedSymbols:(impact.affectedSymbols ?? []).slice(0,4).map((item)=>({
      name:String(item.name ?? ''),
      locator:String(item.locator ?? ''),
      symbolKind:String(item.symbolKind ?? 'symbol')
    })),
    safeguards:'no writes, network, model calls, source bodies, markdown bodies, graph DB, or adapters'
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

export function buildFirstUseReadinessModel({pack=null,markdown='',readback=null,setupResult=null,memoryConfig=null,memoryPreflight=null} = {}) {
  const selectedLocators=Array.isArray(pack?.readFirst) ? pack.readFirst.length : 0;
  const markdownReady=String(markdown??'').trim().length > 0;
  const hasPack=Boolean(pack?.contextPackFingerprint);
  const readbackMatched=readback?.checks?.contextPackFingerprintMatches === true;
  const noMarkdownBody=readback?.checks?.noMarkdownBody === true;
  const noToolsExposed=readback?.checks?.noToolsExposed === true && zeroCount(readback?.bridge?.toolsExposed);
  const rawBodiesExcluded=pack?.delivery?.sourceContentsIncluded === false && pack?.safeguards?.rawBodyIncluded === false;
  const noSideEffects=pack?.safeguards?.externalWritesEnabled === false && zeroCount(pack?.safeguards?.networkCalls) && zeroCount(pack?.safeguards?.modelCalls);
  const noExternalAdapters=zeroCount(pack?.safeguards?.externalAdaptersEnabled);
  const noActiveMemory=zeroCount(pack?.safeguards?.activeMemoryCreated);
  const memoryState=contextPackMemoryReadinessState({memoryConfig,memoryPreflight,noActiveMemory});
  const utilityReady=pack?.utility?.status === 'ready';
  const utilityDetail=contextPackUtilityReadinessDetail(pack);
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
    readinessGate('utility','Read plan',utilityReady,utilityDetail),
    readinessGate('side-effects','Side effects',noSideEffects,'Model calls, network calls, and external writes remain off.'),
    readinessGate('adapters','External adapters',noExternalAdapters,'External adapters remain disabled for this handoff.'),
    readinessGate('memory','Memory import',memoryState.passed,memoryState.detail),
    readinessGate('setup-preview','Setup preview',setupPreviewed ? setupPreviewSafe : null,setupPreviewed ? 'Dry-run harness setup preview remains redacted.' : 'Optional: preview the read-only MCP setup plan before editing any harness config.',setupPreviewed)
  ];
  const blocking=gates.find((gate)=>gate.blocking);
  const ready=!blocking;
  return {
    ready,
    title:ready?'Ready for local handoff':'Review before handoff',
    status:ready?'ready':'blocked',
    copy:ready
      ? 'Copy the markdown into your next local agent, or run the local handoff preflight for CLI and MCP proof.'
      : 'Do not hand this to another agent until the failed gate is fixed.',
    nextAction:ready
      ? (setupPreviewed ? 'Use Copy markdown, or copy and run Test local handoff, Pin locally, then Receive pinned pack commands for durable CLI reuse.' : 'Use Copy markdown now, or copy and run Test local handoff for CLI and MCP proof. For durable CLI reuse, copy and run Pin locally, then Receive pinned pack.')
      : `Fix: ${blocking.label}.`,
    gates
  };
}

function contextPackUtilityReadinessDetail(pack) {
  const utility=pack?.utility ?? {};
  const coverage=utility.changedLocatorCoverage ?? {};
  const total=Number(coverage.total ?? 0);
  const covered=Number(coverage.covered ?? 0);
  const requiredReads=Array.isArray(utility.requiredLocalReads) ? utility.requiredLocalReads.filter((item)=>item?.required===true) : [];
  const changedReads=requiredReads.filter((item)=>item?.role==='changed_locator');
  const changedReadBase=changedReads.length || total;
  const hashVerified=changedReads.filter((item)=>typeof item?.contentHash==='string'&&item.contentHash.startsWith('sha256:')).length;
  const hashMissing=changedReads.filter((item)=>item?.contentHash==null).length;
  if(utility.status==='ready'){
    if(total>0)return `${covered}/${total} changed locators represented by source-graph evidence; ${hashVerified}/${changedReadBase} have hash proof.`;
    return 'Utility read plan is present; no changed locators require source-graph coverage.';
  }
  if(total>0&&covered<total){
    if(hashVerified>0)return `${covered}/${total} changed locators represented by source-graph evidence; ${hashVerified}/${changedReadBase} have hash proof. Read unrepresented docs, config, or unsupported files manually before handoff.`;
    if(hashMissing>0)return `${covered}/${total} changed locators represented by source-graph evidence; ${hashMissing} changed locators are missing hash proof. Review paths before handoff.`;
    return `${covered}/${total} changed locators represented by source-graph evidence. Review unrepresented changed files before handoff.`;
  }
  if(requiredReads.length===0)return 'The pack needs at least one required local read before handoff.';
  return 'The pack must include a schema-backed utility read plan before handoff.';
}

function contextPackMemoryReadinessState({memoryConfig=null,memoryPreflight=null,noActiveMemory=true} = {}) {
  const normalized=normalizeMemoryWorkspaceConfig(memoryConfig);
  const configured=normalized.memoryPaths.length > 0 || memoryPreflight?.configured === true;
  if(!noActiveMemory)return {
    passed:false,
    detail:'Active memory was created; browser handoff must remain proposal-only.'
  };
  if(!configured)return {
    passed:true,
    detail:'No memory source files were configured, and no active memory is created.'
  };
  if(memoryPreflight?.state === 'ready' && zeroCount(memoryPreflight?.safeguards?.activeMemoryCreated))return {
    passed:true,
    detail:'Read-only memory proposal preflight passed without creating active memory.'
  };
  if(memoryPreflight?.state === 'review')return {
    passed:false,
    detail:`Memory proposal preflight returned ${Number(memoryPreflight?.summary?.reviewItemCount ?? 0)} review items. Review proposals or quarantine before handoff.`
  };
  return {
    passed:false,
    detail:`${normalized.memoryPaths.length} memory source file${normalized.memoryPaths.length===1?' is':'s are'} configured. Copy or download ${memoryConfigDownloadName()} and run Test local handoff before treating memory proposals as reviewed.`
  };
}

export function buildCurrentHandoffStatusModel({contextPackResult:result=null,setupResult=null} = {}) {
  const pack=result?.pack ?? null;
  const markdown=String(result?.markdown ?? '');
  if(!pack?.contextPackFingerprint){
    return {
      state:'none',
      statusLabel:'not built',
      title:'No current handoff',
      copy:'Build a context pack before handing this workspace to another local agent.',
      nextAction:'Build context pack',
      actionLabel:'Build context pack',
      actionRoute:'/context-pack',
      targetHarness:'codex',
      fingerprintShort:'unavailable',
      selectedLocators:0,
      omittedRefs:0,
      usePlanReads:0,
      deliveryReductionPercent:'not measured',
      readbackStatus:'not run',
      setupStatus:'not previewed',
      preflightCommand:null,
      preflightSummaryCommand:null,
      safeguards:{
        serverWrites:false,
        configWrites:false,
        externalWritesEnabled:false,
        externalAdaptersEnabled:0,
        networkCalls:0,
        modelCalls:0,
        rawBodiesRendered:false
      }
    };
  }
  const meta={observedDurationMs:result?.observedDurationMs,readback:result?.readback,usePlan:result?.usePlan,memoryConfig:result?.memoryConfig};
  const ui=buildContextPackUiModel(pack,markdown,meta);
  const readiness=buildFirstUseReadinessModel({pack,markdown,readback:result?.readback,setupResult,memoryConfig:result?.memoryConfig,memoryPreflight:result?.memoryProposalPreflight});
  const setupPreviewed=Boolean(setupResult);
  const setupSafe=setupPreviewed
    && setupResult?.dryRun === true
    && zeroCount(setupResult?.safeguards?.localFilesWritten)
    && setupResult?.safeguards?.externalWritesEnabled === false
    && zeroCount(setupResult?.safeguards?.networkCalls)
    && setupResult?.safeguards?.rawConfigBodyIncluded === false;
  return {
    state:result?.pin?.pinned ? 'pinned-locally' : readiness.ready ? 'generated-in-browser' : 'review-required',
    statusLabel:result?.pin?.pinned ? 'pinned' : readiness.ready ? 'ready' : 'review',
    title:result?.pin?.pinned ? 'Current handoff pinned' : readiness.ready ? 'Current handoff ready' : 'Current handoff needs review',
    copy:result?.pin?.pinned ? 'The current handoff is pinned to fixed local context-pack artifacts and verified by the registry.' : readiness.copy,
    nextAction:result?.pin?.pinned ? 'Receive pinned pack' : readiness.nextAction,
    actionLabel:readiness.ready ? 'Open handoff' : 'Review handoff',
    actionRoute:'/context-pack',
    targetHarness:ui.targetHarness,
    fingerprintShort:ui.fingerprintShort,
    selectedLocators:ui.selectedLocators,
    omittedRefs:ui.omittedRefs,
    usePlanReads:ui.usePlanReadCount,
    deliveryReductionPercent:ui.deliveryReductionPercent,
    readbackStatus:ui.proof.readbackFingerprintLabel,
    setupStatus:setupPreviewed ? setupSafe ? 'safe preview' : 'review required' : 'not previewed',
    preflightCommand:contextPackPreflightCommand(pack,{memoryConfig:result?.memoryConfig}),
    preflightSummaryCommand:contextPackPreflightCommand(pack,{memoryConfig:result?.memoryConfig,format:'summary'}),
    safeguards:{
      serverWrites:Boolean(result?.pin?.pinned),
      configWrites:false,
      externalWritesEnabled:false,
      externalAdaptersEnabled:0,
      networkCalls:Number(pack?.safeguards?.networkCalls ?? 0),
      modelCalls:Number(pack?.safeguards?.modelCalls ?? 0),
      rawBodiesRendered:false
    }
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

function contextPackHarnessCommands(pack,usePlan=null,{memoryConfig=null}={}) {
  const packCommands=Array.isArray(pack?.handoff?.commands) ? pack.handoff.commands.filter((command)=>typeof command==='string'&&command.trim()) : [];
  if(packCommands.length){
    const commands=packCommands.map((command)=>({ label:contextPackCommandLabel(command), command }));
    insertContextPackReceiveCommand(commands,pack);
    const generated=[
      {label:'Test local handoff',command:contextPackPreflightCommand(pack,{memoryConfig})},
      {label:'Test handoff summary',command:contextPackPreflightCommand(pack,{memoryConfig,format:'summary'})},
      {label:'Copy impact command',command:contextPackImpactCommand(pack)},
      ...contextPackGeneratedUsePlanCommands(pack,usePlan)
    ].filter((item)=>item.command);
    for(const command of generated){
      if(!commands.some((item)=>item.command===command.command || item.command.includes('--context-pack-use')===command.command.includes('--context-pack-use') && command.command.includes('--context-pack-use'))){
        commands.push(command);
      }
    }
    return commands;
  }
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
    { label:'Test local handoff', command:contextPackPreflightCommand(pack,{memoryConfig}) },
    { label:'Test handoff summary', command:contextPackPreflightCommand(pack,{memoryConfig,format:'summary'}) },
    { label:'Copy impact command', command:contextPackImpactCommand(pack) },
    { label:'Rebuild from CLI', command:`npm run oaf -- context pack --from ${from} --root . --objective ${objective} --step ${step} --target ${target}${selected}${changed} --dry-run --format markdown` },
    { label:'Pin locally', command:`npm run oaf -- context pack --from ${from} --root . --objective ${objective} --step ${step} --target ${target}${selected}${changed} --write --pin --out context-packs/CONTEXT_PACK.md --format json` },
    { label:'Verify pin', command:'npm run oaf -- context registry status --read-only --format json' },
    { label:'Receive pinned pack', command:contextPackReceiveCommand(pack) },
    { label:'Receive summary', command:contextPackReceiveSummaryCommand(pack) },
    { label:'Start MCP bridge', command:oafCommand('mcp resources --read-only --stdio') },
    { label:'Preview harness setup', command:`npm run oaf -- harness setup plan --client ${setupClient} --server oaf --dry-run --format json` },
    { label:'Read use plan', command:'npm run oaf -- mcp resources --read-only --uri oaf://workspace/ws_local/context-pack/use-plan/current --format json' },
    { label:'Read registry', command:'npm run oaf -- mcp resources --read-only --uri oaf://workspace/ws_local/context-pack/registry/current --format json' },
    { label:'Read current context pack', command:`npm run oaf -- mcp resources --read-only --context-pack --from ${from} --root . --objective ${objective} --step ${step} --target ${target}${selected}${changed} --uri oaf://workspace/ws_local/context-pack/current --format json` },
    { label:'Read MCP resources', command:'npm run oaf -- mcp resources --read-only --format json' },
    { label:'Read latest handoff', command:'npm run oaf -- mcp resources --read-only --uri oaf://workspace/ws_local/handoff/latest --format json' }
  ];
}

function insertContextPackReceiveCommand(commands,pack) {
  const command=contextPackReceiveCommand(pack);
  const summaryCommand=contextPackReceiveSummaryCommand(pack);
  const hasReceive=commands.some((item)=>item.command===command || item.label==='Receive pinned pack');
  const hasSummary=commands.some((item)=>item.command===summaryCommand || item.label==='Receive summary');
  if(hasReceive && hasSummary)return;
  const afterVerify=commands.findIndex((item)=>item.label==='Verify pin');
  const afterPin=commands.findIndex((item)=>item.label==='Pin locally');
  const index=afterVerify >= 0 ? afterVerify : afterPin;
  const items=[];
  if(!hasReceive)items.push({label:'Receive pinned pack',command});
  if(!hasSummary)items.push({label:'Receive summary',command:summaryCommand});
  if(index >= 0)commands.splice(index+1,0,...items);
  else commands.push(...items);
}

function contextPackImpactCommand(pack) {
  if(!pack)return '';
  const target=String(pack?.targetHarness ?? 'generic');
  const objective=quoteShell(pack?.objective ?? 'Ship safely');
  const step=quoteShell(pack?.step ?? 'select context');
  const from=quoteShell(contextPackSourceFamilies(pack).join(','));
  const selected=(pack?.memoryPlan?.items ?? [])
    .filter((item)=>String(item?.locator ?? '').startsWith('user-selected://'))
    .map((item)=>` --include-file ${quoteShell(String(item.locator).replace(/^user-selected:\/\//u,''))}`)
    .join('');
  const changed=(pack?.sourceGraph?.impact?.changedLocators ?? []).map((locator)=>` --changed ${quoteShell(locator.replace(/^workspace:\/\//u,''))}`).join('');
  return oafCommand(`measure context-pack --read-only --root . --from ${from} --objective ${objective} --step ${step} --target ${target}${selected}${changed} --format json`);
}

function contextPackPreflightCommand(pack,{memoryConfig=null,format='json'}={}) {
  if(!pack)return '';
  const outputFormat=format === 'summary' ? 'summary' : 'json';
  const target=String(pack?.targetHarness ?? 'generic');
  const objective=quoteShell(pack?.objective ?? 'Ship safely');
  const step=quoteShell(pack?.step ?? 'select context');
  const from=quoteShell(contextPackSourceFamilies(pack).join(','));
  const selected=(pack?.memoryPlan?.items ?? [])
    .filter((item)=>String(item?.locator ?? '').startsWith('user-selected://'))
    .map((item)=>` --include-file ${quoteShell(String(item.locator).replace(/^user-selected:\/\//u,''))}`)
    .join('');
  const changed=(pack?.sourceGraph?.impact?.changedLocators ?? []).map((locator)=>` --changed ${quoteShell(locator.replace(/^workspace:\/\//u,''))}`).join('');
  const memoryFlag=normalizeMemoryWorkspaceConfig(memoryConfig).memoryPaths.length ? ' --memory-config oaf.memory.json' : '';
  return oafCommand(`context handoff --read-only --from ${from} --root . --objective ${objective} --step ${step} --target ${target}${selected}${changed}${memoryFlag} --format ${outputFormat}`);
}

function contextPackReceiveCommand(pack) {
  const target=String(pack?.targetHarness ?? 'generic');
  return `npm run oaf -- context receive --read-only --root . --target ${target} --format json`;
}

function contextPackReceiveSummaryCommand(pack) {
  const target=String(pack?.targetHarness ?? 'generic');
  return `npm run oaf -- context receive --read-only --root . --target ${target} --format summary`;
}

function contextPackGeneratedUsePlanCommands(pack,usePlan=null) {
  const target=String(pack?.targetHarness ?? 'generic');
  const objective=quoteShell(pack?.objective ?? 'Ship safely');
  const step=quoteShell(pack?.step ?? 'select context');
  const from=quoteShell(contextPackSourceFamilies(pack).join(','));
  const selected=(pack?.memoryPlan?.items ?? [])
    .filter((item)=>String(item?.locator ?? '').startsWith('user-selected://'))
    .map((item)=>` --include-file ${quoteShell(String(item.locator).replace(/^user-selected:\/\//u,''))}`)
    .join('');
  const changed=(pack?.sourceGraph?.impact?.changedLocators ?? []).map((locator)=>` --changed ${quoteShell(locator.replace(/^workspace:\/\//u,''))}`).join('');
  const uri=String(usePlan?.resource?.uri ?? 'oaf://workspace/ws_local/context-pack/use-plan/current');
  return [
    { label:'Pin locally', command:`npm run oaf -- context pack --from ${from} --root . --objective ${objective} --step ${step} --target ${target}${selected}${changed} --write --pin --out context-packs/CONTEXT_PACK.md --format json` },
    { label:'Verify pin', command:'npm run oaf -- context registry status --read-only --format json' },
    { label:'Receive pinned pack', command:contextPackReceiveCommand(pack) },
    { label:'Receive summary', command:contextPackReceiveSummaryCommand(pack) },
    { label:'Start MCP bridge', command:oafCommand('mcp resources --read-only --stdio') },
    { label:'Read registry', command:'npm run oaf -- mcp resources --read-only --uri oaf://workspace/ws_local/context-pack/registry/current --format json' },
    { label:'Read use plan', command:`npm run oaf -- mcp resources --read-only --uri ${uri} --format json` }
  ];
}

function contextPackCommandLabel(command) {
  if(command === 'npm run doctor')return 'Check local setup';
  if(command === 'npm run ci')return 'Run CI';
  if(command.includes('measure context-pack'))return 'Copy impact command';
  if(command.includes('context handoff') && command.includes('--format summary'))return 'Test handoff summary';
  if(command.includes('context handoff'))return 'Test local handoff';
  if(command.includes('context receive') && command.includes('--format summary'))return 'Receive summary';
  if(command.includes('context receive'))return 'Receive pinned pack';
  if(command.includes('context registry status'))return 'Verify pin';
  if(command.includes('--stdio'))return 'Start MCP bridge';
  if(command.includes('context-pack/registry/current'))return 'Read registry';
  if(command.includes('context-pack-registry'))return 'Read registry';
  if(command.includes('--use-out'))return 'Export use plan';
  if(command.includes('context pack') && command.includes('--write') && command.includes('--pin'))return 'Pin locally';
  if(command.includes('context pack') && command.includes('--write'))return 'Export context pack';
  if(command.includes('context pack'))return 'Rebuild from CLI';
  if(command.includes('harness setup plan'))return 'Preview harness setup';
  if(command.includes('context-pack/use-plan/current'))return 'Read use plan';
  if(command.includes('context-pack/current'))return 'Read current context pack';
  if(command.includes('mcp resources --read-only'))return 'Read MCP resources';
  return 'Run command';
}

function oafCommand(args) {
  return `${OAF_CHECKOUT_COMMAND_PREFIX} ${args}`;
}

function contextPackSetupClient(pack) {
  const target=String(pack?.targetHarness ?? 'codex');
  return target === 'cursor' || target === 'claude-code' || target === 'codex' ? target : 'codex';
}

function contextPackCommandList(commands) {
  const legacyUriNote=commands.some((item)=>String(item?.command??'').includes('oaf://'))
    ? `<p class="muted">${esc(OAF_URI_COMPATIBILITY_NOTE)} <a href="${esc(OAF_COMPATIBILITY_URL)}">Compatibility identifiers</a>.</p>`
    : '';
  return `<ol class="command-list">${commands.map((item)=>`<li><div class="command-heading"><strong>${esc(item.label)}</strong><button class="button secondary command-copy" data-action="copy-command" type="button" aria-label="Copy ${esc(item.label)} terminal command">Copy terminal command</button></div><code>${esc(item.command)}</code></li>`).join('')}</ol>${legacyUriNote}`;
}

const CONTEXT_PACK_SOURCE_FAMILIES=[
  ['codex','Codex'],
  ['claude-code','Claude Code'],
  ['cursor','Cursor']
];

const DEFAULT_CONTEXT_PACK_OBJECTIVE='Prepare the next coding agent to continue Memory Recall safely';
const DEFAULT_CONTEXT_PACK_STEP='select useful local handoff context';

function contextPackTargetOptions(selectedTarget='codex') {
  return [
    ['codex','Codex'],
    ['claude-code','Claude Code'],
    ['cursor','Cursor'],
    ['generic','Generic agent']
  ].map(([id,label])=>`<option value="${esc(id)}"${id===selectedTarget?' selected':''}>${esc(label)}</option>`).join('');
}

function contextPackFormDraft() {
  const payload=selectContextPackPinPayload({reviewedPayload:contextPackResult?.reviewedPayload ?? contextPackReviewedPayload});
  const memoryConfig=normalizeMemoryWorkspaceConfig(contextPackResult?.memoryConfig ?? contextPackMemoryConfig);
  const sourceFamilies=String(payload?.from ?? 'codex').split(',').map((item)=>item.trim()).filter(Boolean);
  return {
    targetHarness:String(payload?.targetHarness ?? 'codex'),
    tokenBudget:String(Number(payload?.tokenBudget ?? 4096)),
    sourceFamilies:sourceFamilies.length ? sourceFamilies : ['codex'],
    objective:String(payload?.objective ?? DEFAULT_CONTEXT_PACK_OBJECTIVE),
    step:String(payload?.step ?? DEFAULT_CONTEXT_PACK_STEP),
    userSelectedFiles:(payload?.userSelectedFiles ?? []).join('\n'),
    changedLocators:(payload?.changedLocators ?? []).map((locator)=>String(locator).replace(/^workspace:\/\//u,'')).join('\n'),
    memorySourceFiles:memoryConfig.memoryPaths.map((item)=>item.path).join('\n')
  };
}

function contextPackSourceFamilyControls(selectedFamilies=['codex']) {
  const selected=new Set((Array.isArray(selectedFamilies)?selectedFamilies:['codex']).map(String));
  return `<fieldset class="source-family-field"><legend>Source families</legend><div class="source-family-options">${CONTEXT_PACK_SOURCE_FAMILIES.map(([id,label],index)=>`<label><input type="checkbox" name="sourceFamilies" value="${esc(id)}"${selected.has(id)||(!selected.size&&index===0)?' checked':''}><span>${esc(label)}</span></label>`).join('')}</div></fieldset>`;
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

function contextPackMemoryConfigPanel(config,preflight=null) {
  const preflightSummary=preflight
    ? `<hr><dl class="facts compact-facts"><div><dt>State</dt><dd>${esc(preflight.state)}</dd></div><div><dt>Review items</dt><dd>${Number(preflight.summary?.reviewItemCount??0)}</dd></div><div><dt>Proposals</dt><dd>${Number(preflight.summary?.proposalCount??0)}</dd></div><div><dt>Quarantine</dt><dd>${Number(preflight.summary?.quarantinedCount??0)}</dd></div><div><dt>Active memory</dt><dd>${Number(preflight.safeguards?.activeMemoryCreated??0)}</dd></div></dl><p class="muted">Preflight ran locally in dry-run mode. It returns counts, warning codes, fingerprints, and safeguards only.</p>`
    : '<p class="muted">Run memory preflight to check these reviewed local files before treating memory proposals as handled.</p>';
  return `<dl class="facts compact-facts"><div><dt>Config</dt><dd>${esc(config.downloadName)}</dd></div><div><dt>Reviewed files</dt><dd>${Number(config.pathCount)}</dd></div><div><dt>CLI flag</dt><dd><code>${esc(config.commandFlag.trim())}</code></dd></div><div><dt>Server writes</dt><dd>none</dd></div><div><dt>Raw bodies</dt><dd>excluded from browser state and handoff summary</dd></div></dl><div class="action-row"><button class="button secondary" data-action="run-memory-preflight" type="button">Run memory preflight</button></div><p class="muted">Copy or download the config for CLI parity, or run memory preflight here. The local API reads reviewed files and reports proposal or quarantine counts without creating active memory.</p>${preflightSummary}`;
}

function contextPackUtilityPanel(utility) {
  return `<dl class="facts compact-facts"><div><dt>Changed files</dt><dd>${esc(utility.changedCoverageLabel)} (${esc(utility.changedCoveragePercent)})</dd></div><div><dt>Hash verified</dt><dd>${esc(utility.changedHashVerifiedLabel)}</dd></div><div><dt>Changed source</dt><dd>${esc(utility.changedSourceBudgetLabel)}</dd></div><div><dt>Required reads</dt><dd>${Number(utility.requiredReadCount)}</dd></div><div><dt>Graph hints</dt><dd>${esc(utility.graphCoverageLabel)}</dd></div><div><dt>Source kept</dt><dd>${esc(utility.sourceSelectionRatio)}</dd></div><div><dt>Source reduction</dt><dd>${esc(utility.sourceReduction)}</dd></div></dl>${utility.topReads.length?`<ol class="locator-list compact-list">${utility.topReads.map((item)=>`<li><strong>${esc(item.role)}</strong><code>${esc(item.locator)}</code><small>${item.required?'required':'optional'} · ${item.contentHash?'hash':'hash unavailable'}</small></li>`).join('')}</ol>`:'<p class="muted">No required local reads recorded.</p>'}`;
}

function contextPackImpactBriefPanel(brief) {
  const reads=brief.topReads.length?`<ol class="locator-list compact-list">${brief.topReads.map((item)=>`<li><strong>${esc(item.role)}</strong><code>${esc(item.locator)}</code><small>${item.represented?'represented':'review'} · ${item.contentHash?'hash':'hash unavailable'}</small></li>`).join('')}</ol>`:'<p class="muted">Build a context pack or detect git changes to generate a diff-aware impact brief.</p>';
  const symbols=brief.affectedSymbols.length?`<ol class="locator-list compact-list">${brief.affectedSymbols.map((item)=>`<li><strong>${esc(item.name)}</strong><span>${esc(item.symbolKind)} · ${esc(item.locator)}</span></li>`).join('')}</ol>`:'<p class="muted">No affected symbols found for the supplied changed locators.</p>';
  return `<dl class="facts compact-facts"><div><dt>Changed coverage</dt><dd>${esc(brief.changedCoverageLabel)} (${esc(brief.changedCoveragePercent)})</dd></div><div><dt>Affected symbols</dt><dd>${Number(brief.affectedSymbolCount)}${brief.omittedAffectedSymbolCount?` · ${Number(brief.omittedAffectedSymbolCount)} omitted`:''}</dd></div><div><dt>Required reads</dt><dd>${Number(brief.requiredReadCount)}</dd></div><div><dt>Hash proof</dt><dd>${Number(brief.changedHashVerifiedCount)} changed files</dd></div><div><dt>Graph hints</dt><dd>${esc(brief.graphCoverageLabel)}</dd></div><div><dt>Source kept</dt><dd>${esc(brief.selectedUnitRatio)}</dd></div><div><dt>Reduction</dt><dd>${esc(brief.estimatedReductionRatio)}</dd></div><div><dt>Source graph</dt><dd>${esc(brief.sourceGraphStatus)}</dd></div></dl><p class="muted">Read-only impact brief: ${esc(brief.safeguards)}.</p>${reads}${symbols}`;
}

function contextPackLaunchPath(model,readiness,memoryPreflight=null) {
  const preflight=model.commands.find((item)=>item.label==='Test local handoff') ?? null;
  const preflightSummary=model.commands.find((item)=>item.label==='Test handoff summary') ?? null;
  const setupPreviewed=readiness.gates?.find?.((gate)=>gate.id==='setup-preview')?.status === 'pass';
  const memoryPreflightStatus=memoryPreflight
    ? `<small>Preflight ${esc(memoryPreflight.state)}; ${Number(memoryPreflight.summary?.reviewItemCount??0)} review item${Number(memoryPreflight.summary?.reviewItemCount??0)===1?'':'s'}; active memory ${Number(memoryPreflight.safeguards?.activeMemoryCreated??0)}.</small>`
    : '';
  const memoryControls=model.memoryConfig.configured
    ? `<div class="action-row"><button class="button secondary" data-action="copy-memory-config" type="button">Copy memory config</button><button class="button secondary" data-action="download-memory-config" type="button">Download memory config</button><button class="button secondary" data-action="run-memory-preflight" type="button">Run memory preflight</button></div><small>${Number(model.memoryConfig.pathCount)} reviewed file${model.memoryConfig.pathCount===1?'':'s'}; place ${esc(model.memoryConfig.downloadName)} at the repo root for CLI parity.</small>${memoryPreflightStatus}`
    : '<p class="muted">Skip memory config unless you explicitly chose local files to review as proposal sources.</p>';
  const setupAction=setupPreviewed
    ? '<p class="muted">Setup preview already passed for this browser session.</p>'
    : `<button class="button secondary" data-action="preview-pack-setup" data-client="${esc(model.setupClient)}" type="button">Preview setup</button>`;
  const preflightCommands=[preflight,preflightSummary].filter(Boolean);
  return `<section class="surface handoff-use-path" aria-label="Practical handoff path"><div class="handoff-use-path-head"><div><p class="eyebrow">Practical handoff</p><h2>Use this in another local agent session.</h2><p>Copy the locator pack first, keep optional memory proposal files explicit, then pin the reviewed artifacts when another local agent should receive them later.</p></div><dl class="facts compact-facts"><div><dt>Target</dt><dd>${esc(model.targetHarness)}</dd></div><div><dt>Status</dt><dd>${readiness.ready?'ready':'review required'}</dd></div><div><dt>Writes</dt><dd>explicit local pin only</dd></div></dl></div><ol class="use-path-grid"><li><span>1</span><strong>Give the agent context</strong><p>Paste the markdown or launch prompt into the next local harness session.</p><div class="action-row"><button class="button primary" data-action="copy-pack" type="button">Copy markdown</button><button class="button secondary" data-action="copy-launch-prompt" type="button">Copy launch prompt</button></div></li><li><span>2</span><strong>Add memory only by choice</strong>${memoryControls}</li><li><span>3</span><strong>Pin durable artifacts</strong><p>Write the reviewed pack to fixed local context-pack files and verify the registry immediately.</p><div class="action-row"><button class="button secondary" data-action="pin-context-pack" type="button">Pin locally</button></div></li><li><span>4</span><strong>Connect MCP manually</strong><p>Preview the config snippet when the target harness should read Memory Recall resources.</p>${setupAction}${preflightCommands.length?contextPackCommandList(preflightCommands):''}</li></ol></section>`;
}

function contextPackOperatorBrief(model,readiness={ready:false}) {
  const brief=model.impactBrief;
  const isReady=readiness.ready===true && brief.status === 'ready';
  const title=isReady
    ? 'Changed files, reads, and proof commands are ready.'
    : 'Review changed files, reads, and proof commands before handoff.';
  const stateLabel=isReady ? 'ready' : 'review';
  const reads=brief.topReads.length
    ? `<ol class="locator-list compact-list">${brief.topReads.slice(0,3).map((item)=>`<li><code>${esc(item.locator)}</code><small>${esc(item.role)} · ${item.contentHash?'hash verified':'hash unavailable'}</small></li>`).join('')}</ol>`
    : '<p class="muted">No required local reads were selected yet.</p>';
  const commands=['Test local handoff','Test handoff summary','Pin locally','Receive pinned pack','Receive summary','Copy impact command']
    .map((label)=>model.commands.find((item)=>item.label===label))
    .filter(Boolean);
  const commandList=commands.length ? contextPackCommandList(commands) : '<p class="muted">Build a context pack to get read-only proof commands.</p>';
  const symbols=brief.affectedSymbols.length
    ? brief.affectedSymbols.slice(0,3).map((item)=>esc(item.name)).join(', ')
    : 'no affected symbols reported';
  return `<section class="handoff-brief" aria-label="Handoff operator brief"><div class="handoff-brief-head"><div><p class="eyebrow">Use this pack</p><h2>${esc(title)}</h2></div><span>${esc(stateLabel)} · ${esc(model.targetHarness)} · ${esc(model.fingerprintShort)}</span></div><div class="handoff-brief-grid"><article><h3>Changed</h3><dl class="facts compact-facts"><div><dt>Coverage</dt><dd>${esc(brief.changedCoverageLabel)} (${esc(brief.changedCoveragePercent)})</dd></div><div><dt>Symbols</dt><dd>${Number(brief.affectedSymbolCount)} affected</dd></div><div><dt>Top impact</dt><dd>${symbols}</dd></div><div><dt>Hash proof</dt><dd>${Number(brief.changedHashVerifiedCount)} changed files</dd></div></dl></article><article><h3>Read first</h3>${reads}<p class="muted">Raw source bodies, markdown bodies, local paths, model calls, network calls, and adapters stay out of this brief. Pin locally is the only browser-triggered write here, and it writes fixed context-packs artifacts before Receive pinned pack reads them.</p></article><article><h3>Pin and receive</h3>${commandList}</article></div></section>`;
}

function contextPackProofLedger(proof) {
  return [
    ledgerItem(proof.tokenSaved,'Locator handoff reduction','Estimate vs candidate source tokens'),
    ledgerItem(proof.selectedTokenRatio,'Source kept','Estimate vs candidate source tokens'),
    ledgerItem(proof.changedSourceAvoidedLabel,'Changed source avoided','Raw changed-file body tokens kept out'),
    ledgerItem(proof.observedDurationLabel,'Browser request time','Observed around local API call'),
    ledgerItem(proof.readbackDurationLabel,'MCP summary read','Single in-process read'),
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

export function buildContextSourcePreviewUiModel(preview) {
  const scan=preview?.scan ?? {};
  const manifest=preview?.manifest ?? {};
  const memoryPlan=preview?.memoryPlan ?? {};
  const metrics=preview?.metrics ?? {};
  const safeguards=preview?.safeguards ?? {};
  const selected=Array.isArray(manifest.selected) ? manifest.selected : [];
  const excluded=Array.isArray(manifest.excluded) ? manifest.excluded : [];
  const sources=Array.isArray(scan.sources) ? scan.sources : [];
  const skipped=Array.isArray(scan.skipped) ? scan.skipped : [];
  return {
    id:String(preview?.id ?? ''),
    fingerprint:shortFingerprint(preview?.previewFingerprint ?? ''),
    acceptedCount:Number(scan.summary?.totalAccepted ?? sources.length),
    skippedCount:Number(scan.summary?.totalSkipped ?? skipped.length),
    selectedCount:selected.length,
    excludedCount:excluded.length,
    candidateTokens:Number(metrics.candidateTokenCount ?? 0),
    selectedTokens:Number(metrics.selectedTokenCount ?? 0),
    selectedTokenRatio:Number.isFinite(Number(metrics.selectedTokenRatio)) ? `${Math.round(Number(metrics.selectedTokenRatio) * 100)}%` : '0%',
    proposedCount:Number(memoryPlan.proposedCount ?? 0),
    quarantinedCount:Number(memoryPlan.quarantinedCount ?? 0),
    activeMemoryCreated:Number(memoryPlan.activeMemoryCreated ?? 0),
    externalWritesLabel:safeguards.externalWritesEnabled===false?'disabled':'check',
    rawBodiesLabel:safeguards.rawBodyIncluded===false?'excluded':'check',
    modelCallsLabel:safeguardCountLabel(safeguards.modelCalls),
    networkCallsLabel:safeguardCountLabel(safeguards.networkCalls),
    sourceSnapshotsLabel:safeguardCountLabel(safeguards.sourceSnapshotsWritten),
    sources:sources.slice(0,8).map((source)=>({
      locator:source.locator,
      harness:source.harness,
      sourceKind:source.sourceKind,
      tokens:selected.find((item)=>item.sourceId===source.id)?.tokens ?? excluded.find((item)=>item.sourceId===source.id)?.tokens ?? 0,
      status:selected.some((item)=>item.sourceId===source.id)?'selected':excluded.some((item)=>item.sourceId===source.id)?'excluded':'candidate',
      redactions:Number(source.redactions?.secretCount ?? 0)+Number(source.redactions?.localPathCount ?? 0)
    })),
    skipped:skipped.slice(0,5).map((item)=>({ locator:item.locator, reason:item.reason }))
  };
}

function renderContextSourcePreview(preview) {
  const model=buildContextSourcePreviewUiModel(preview);
  return `<section class="surface context-source-preview" aria-label="Harness source preview"><div class="section-heading"><h2>Source preview</h2><span title="${esc(preview.previewFingerprint)}">${esc(model.fingerprint)}</span></div><dl class="facts facts-wide"><div><dt>Accepted</dt><dd>${model.acceptedCount}</dd></div><div><dt>Skipped</dt><dd>${model.skippedCount}</dd></div><div><dt>Selected</dt><dd>${model.selectedCount} / ${model.acceptedCount}</dd></div><div><dt>Source tokens</dt><dd>${model.selectedTokens} / ${model.candidateTokens} (${esc(model.selectedTokenRatio)})</dd></div><div><dt>Would propose</dt><dd>${model.proposedCount}</dd></div><div><dt>Quarantine</dt><dd>${model.quarantinedCount}</dd></div><div><dt>Raw bodies</dt><dd>${esc(model.rawBodiesLabel)}</dd></div><div><dt>External writes</dt><dd>${esc(model.externalWritesLabel)}</dd></div></dl>${contextSourcePreviewList(model.sources)}${model.skipped.length?`<hr><div class="section-heading"><h2>Skipped</h2><span>${model.skipped.length}</span></div><ol class="compact-list locator-list">${model.skipped.map((item)=>`<li><strong>${esc(item.locator)}</strong><span>${esc(item.reason)}</span></li>`).join('')}</ol>`:''}<p class="muted">Safeguards: model calls ${esc(model.modelCallsLabel)}, network calls ${esc(model.networkCallsLabel)}, source snapshots ${esc(model.sourceSnapshotsLabel)}, active memory ${model.activeMemoryCreated}.</p></section>`;
}

function contextSourcePreviewList(sources) {
  if(!sources.length)return '<p class="muted">No harness context sources accepted for the selected families.</p>';
  return `<ol class="compact-list locator-list source-preview-list">${sources.map((source)=>`<li><strong>${esc(source.locator)}</strong><span>${esc(source.status)} · ${esc(source.harness)} · ${esc(source.sourceKind)} · ${Number(source.tokens??0)} tokens${source.redactions?` · ${source.redactions} redaction${source.redactions===1?'':'s'}`:''}</span></li>`).join('')}</ol>`;
}

function safeguardCountLabel(value) {
  return Number.isInteger(value) && value >= 0 ? String(value) : 'check';
}

export function contextPackDownloadName(pack) {
  const target=String(pack?.targetHarness ?? 'generic').replace(/[^A-Za-z0-9._-]/g,'-');
  const date=String(pack?.createdAt ?? new Date().toISOString()).slice(0,10);
  return `open-agent-fabric-context-pack-${target}-${date}.md`;
}

export function contextPackUsePlanDownloadName(pack) {
  const target=String(pack?.targetHarness ?? 'generic').replace(/[^A-Za-z0-9._-]/g,'-');
  const date=String(pack?.createdAt ?? new Date().toISOString()).slice(0,10);
  return `open-agent-fabric-context-pack-use-plan-${target}-${date}.json`;
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

function isSafeWorkspaceRelativePath(value) {
  const relativePath=String(value??'').trim();
  return Boolean(relativePath)
    && !relativePath.startsWith('/')
    && !relativePath.includes('..')
    && !relativePath.includes('\\')
    && !/^[a-z]+:/iu.test(relativePath)
    && !/(^|\/)(?:\.git|\.local|node_modules)(?:\/|$)/u.test(relativePath)
    && /^[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,512}$/u.test(relativePath);
}

export function normalizeMemorySourceFiles(value) {
  const items=Array.isArray(value) ? value : parseSelectedFiles(value);
  return [...new Set(items.map((item)=>String(item??'').trim()).filter(isSafeWorkspaceRelativePath))].slice(0,32);
}

export function buildMemoryWorkspaceConfig(value) {
  const memoryPaths=normalizeMemorySourceFiles(value).map((relativePath)=>({path:relativePath,kind:'episode'}));
  return { schemaVersion:'1.0.0', memoryPaths };
}

const MEMORY_CONFIG_KINDS=new Set(['fact','preference','decision','episode','procedure','constraint']);

function safeMemoryKind(value) {
  const kind=String(value??'episode');
  return MEMORY_CONFIG_KINDS.has(kind) ? kind : 'episode';
}

function normalizeMemoryWorkspaceConfig(value) {
  const memoryPaths=Array.isArray(value?.memoryPaths)
    ? value.memoryPaths.map((entry)=>typeof entry==='string'?{path:entry}:entry).filter((entry)=>isSafeWorkspaceRelativePath(entry?.path)).slice(0,32)
    : [];
  return { schemaVersion:'1.0.0', memoryPaths:memoryPaths.map((entry)=>({path:String(entry.path),kind:safeMemoryKind(entry.kind)})) };
}

function memoryConfigJson(config) {
  return `${JSON.stringify(normalizeMemoryWorkspaceConfig(config),null,2)}\n`;
}

function memoryConfigDownloadName() {
  return 'oaf.memory.json';
}

function renderSourceGraph() {
  const errorPanel=sourceGraphError?renderApiErrorPanel('Source graph preview failed',sourceGraphError):'';
  const query=recallMapSearchQuery();
  const globalResults=renderRepositorySearchState({query,report:recallMap,error:recallMapError});
  return `<div class="tool-workspace map-workspace"><header class="tool-page-heading"><div><p class="eyebrow">Repository structure</p><h1>Map</h1><p>Find an entry point, trace a symbol, or inspect the impact of a changed file.</p></div><span>Read-only · bounded metadata</span></header>${globalResults}<section class="tool-query"><form id="source-graph-form" class="stacked-form"><label class="field"><span>Query</span><input name="query" value="${esc(query||'where should I start')}" maxlength="512"></label><div class="field-grid"><label class="field"><span>Trace symbol</span><input name="startName" value="" placeholder="optional function or class name" maxlength="240"></label><label class="field"><span>Changed locator</span><input name="changedLocator" value="" placeholder="src/index.js" maxlength="512"></label></div><div class="query-options"><label class="field"><span>Limit</span><input name="limit" type="number" min="1" max="100" value="8"></label><label class="field"><span>Depth</span><input name="depth" type="number" min="1" max="5" value="2"></label><button class="button primary" type="submit">Run map</button><span class="muted">No model or network calls</span></div></form></section>${errorPanel}${sourceGraphResult?renderSourceGraphResult(sourceGraphResult):statePanel('empty','No map results','Run the map to inspect files, symbols, import neighbors, and likely starting points.')}</div>`;
}

function renderRecallMapSearchResults(report,query){const search=report?.architecture?.search;const results=Array.isArray(search?.results)?search.results:[];return `<section class="surface repository-search-results" aria-label="Repository search results"><div class="section-heading"><h2>Search results</h2><span>${Number(search?.total??0)} matches for ${esc(query)}</span></div>${results.length?`<ol class="plain-list">${results.map((item)=>`<li><strong>${esc(item.label)}</strong><code>${esc(item.locator)}</code></li>`).join('')}</ol>`:'<p class="muted">No bounded source-graph matches.</p>'}</section>`}

export function renderRepositorySearchState({query='',report=null,error=null}={}) {
  if(!query)return '';
  if(error)return renderApiErrorPanel('Repository search failed',error);
  return renderRecallMapSearchResults(report,query);
}

export function renderSourceGraphResult(report) {
  const summary=report.graph?.summary ?? {};
  return `<div class="tool-workspace map-workspace"><section class="tool-result-heading"><div><p class="eyebrow">Map results</p><h2>Repo Map</h2></div><dl class="tool-summary" aria-label="Source graph summary"><div><dt>Files</dt><dd>${Number(summary.fileCount??0)}</dd></div><div><dt>Symbols</dt><dd>${Number(summary.symbolCount??0)}</dd></div><div><dt>Relations</dt><dd>${Number(summary.edgeCount??0)}</dd></div><div><dt>Matches</dt><dd>${Number(report.search?.total??0)}</dd></div></dl></section>${renderRepoMap(report)}<section class="tool-detail-grid"><section><div class="section-heading"><h2>Search results</h2><span>${Number(report.search?.total??0)} matches</span></div>${sourceGraphSearchList(report.search?.results)}</section><section><div class="section-heading"><h2>Trace</h2><span>${report.trace?.paths?.length??0} paths</span></div>${sourceGraphTraceList(report.trace?.paths)}</section><section><div class="section-heading"><h2>Changed impact</h2><span>${report.impact?.affectedSymbols?.length??0} symbols</span></div>${sourceGraphImpactList(report.impact?.affectedSymbols)}</section><details class="tool-disclosure"><summary>Scan details</summary>${sourceGraphSafeguards(report.safeguards)}<div class="section-heading"><h3>Sample nodes</h3><span>${report.graph?.sampleNodes?.length??0}</span></div>${sourceGraphNodeList(report.graph?.sampleNodes)}<code>${esc(shortFingerprint(report.graph?.graphFingerprint))}</code></details></section></div>`;
}

function renderRepoMap(report) {
  const nodes=report.graph?.sampleNodes ?? [];
  const byId=new Map(nodes.map((node)=>[node.id,node]));
  const files=nodes.filter((node)=>node.kind==='file').slice(0,6);
  const symbols=uniqueBy([
    ...(report.graph?.summary?.entryPoints ?? []),
    ...(report.graph?.summary?.hotspots ?? []),
    ...nodes.filter((node)=>node.kind==='symbol')
  ],(item)=>item.locator ?? item.label).slice(0,6);
  const imports=(report.graph?.sampleEdges ?? []).filter((edge)=>edge.kind==='imports').map((edge)=>{
    const from=byId.get(edge.fromNodeId);
    const to=byId.get(edge.toNodeId);
    return from&&to?`${from.label} -> ${to.label}`:'';
  }).filter(Boolean).slice(0,6);
  const readFirst=(report.graph?.summary?.entryPoints ?? []).map((item)=>item.locator).filter(Boolean).slice(0,6);
  return `<section class="work-grid repo-map"><div class="surface surface-primary"><div class="section-heading"><h2>Repo Map</h2><span>${files.length} files</span></div>${sourceGraphStartHere(report)}<div class="split-list"><div><h3>Read first</h3>${sourceGraphTextList(readFirst)}</div><div><h3>Files</h3>${sourceGraphNodeList(files)}</div></div></div><aside class="inspector"><div class="section-heading"><h2>Key symbols</h2><span>${symbols.length}</span></div>${sourceGraphSymbolList(symbols)}<hr><div class="section-heading"><h2>Import neighbors</h2><span>${imports.length}</span></div>${sourceGraphTextList(imports)}</aside></section>`;
}

function uniqueBy(items,key) {
  const seen=new Set();
  return items.filter((item)=>{const value=key(item);if(!value||seen.has(value))return false;seen.add(value);return true;});
}

function sourceGraphStartHere(report) {
  const entry=report.graph?.summary?.entryPoints?.[0];
  const changed=report.impact?.representedChangedLocators?.[0] ?? report.impact?.changedLocators?.[0];
  const affected=report.impact?.affectedSymbols?.[0];
  if(!entry && !changed && !affected)return '';
  return `<div class="state-panel state-success"><h3>Start here</h3><p>${entry?`Begin at ${esc(entry.label)} (${esc(entry.locator)}).`:'Use the read-first list below.'}${changed?` Changed impact: ${esc(changed)}${affected?` touches ${esc(affected.name)}`:''}.`:''}</p></div>`;
}

function sourceGraphSymbolList(symbols=[]) {
  if(!symbols.length)return '<p class="muted">No key symbols in the bounded preview.</p>';
  return `<ol class="compact-list locator-list">${symbols.map((symbol)=>`<li><strong>${esc(symbol.label)}</strong><span>${esc(symbol.symbolKind??'symbol')} · ${esc(symbol.locator??`${Number(symbol.total??0)} links`)}</span></li>`).join('')}</ol>`;
}

function sourceGraphTextList(items=[]) {
  if(!items.length)return '<p class="muted">No bounded preview items.</p>';
  return `<ol class="compact-list locator-list">${items.map((item)=>`<li><strong>${esc(item)}</strong></li>`).join('')}</ol>`;
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
  if(memoryCockpitError)return statePanel('error','Memory cockpit unavailable',memoryCockpitError);
  return renderMemoryCockpit(memoryCockpit);
}

export function buildMemoryGraphModel(report = null) {
  if(!report?.graph)return {ready:false,summary:{nodeCount:0,edgeCount:0,communityCount:0},nodes:[],edges:[],focus:null};
  const nodes=Array.isArray(report.graph.nodes)?report.graph.nodes:[];
  const edges=Array.isArray(report.graph.edges)?report.graph.edges:[];
  const summary={nodeCount:nodes.length,edgeCount:edges.length,communityCount:0,...(report.summary??{})};
  return {
    ready:true,
    provider:report.provider??'provider:native:memory:sqlite',
    mode:report.mode??'current',
    generatedAt:report.generatedAt,
    reportFingerprint:report.reportFingerprint,
    communityMethod:report.communityMethod??'label-propagation',
    summary,
    nodes,
    edges,
    focus:report.focus,
    safeguards:report.safeguards??{}
  };
}

export function renderMemoryGraph(report = null, options = {}, error = null) {
  if(error)return statePanel('error','Memory graph unavailable',error);
  const model=buildMemoryGraphModel(report);
  if(!model.ready)return statePanel('empty','No governed graph loaded','Ingest and approve temporal memory facts, then refresh this local graph view.');
  const query=options.query??'';
  const historyChecked=options.history?' checked':'';
  const communityChecked=options.communities?' checked':'';
  const focus=model.focus?.nodes?.length?model.focus:null;
  const focusList=focus
    ? `<ol class="compact-list locator-list">${focus.nodes.slice(0,12).map((node)=>`<li><strong>${esc(node.name)}</strong><span>${esc(node.type)} · degree ${Number(node.degree??0)} · community ${Number(node.community??0)}</span></li>`).join('')}</ol>`
    : '<p class="muted">Click a node or search for an entity to focus its governed neighborhood.</p>';
  const currentEdges=model.edges.filter((edge)=>edge.current).slice(0,12);
  const staleEdges=model.edges.filter((edge)=>!edge.current).slice(0,12);
  const currentList=currentEdges.length
    ? memoryGraphEdgeList(currentEdges)
    : '<p class="muted">No current graph facts are visible.</p>';
  const historyList=staleEdges.length
    ? memoryGraphEdgeList(staleEdges)
    : '<p class="muted">No superseded graph edges are visible in this mode.</p>';
  return `<section class="metric-strip" aria-label="Governed memory graph metrics">${metric(model.summary.nodeCount,'Nodes',`${model.summary.currentNodeCount??0} current`)}${metric(model.summary.edgeCount,'Edges',`${model.summary.currentEdgeCount??0} current`)}${metric(model.summary.communityCount,'Communities',model.communityMethod)}${metric(model.summary.historyEdgeCount??0,'History edges',model.mode==='history'?'visible':'hidden')}</section><section class="memory-graph-shell"><div class="surface surface-primary"><div class="section-heading"><h2>Governed knowledge graph</h2><span>${esc(model.mode)} · ${esc(shortFingerprint(model.reportFingerprint))}</span></div><form id="memory-graph-form" class="memory-graph-toolbar"><label class="field memory-graph-search"><span>Search entity</span><input name="query" value="${esc(query)}" placeholder="provider:native:memory:sqlite" maxlength="512"></label><label class="toggle-field"><input id="memory-graph-history" name="history" type="checkbox"${historyChecked}> <span>Show history</span></label><label class="toggle-field"><input id="memory-graph-communities" name="communities" type="checkbox"${communityChecked}> <span>Community colors</span></label><button class="button primary" type="submit">Refresh graph</button></form><div class="memory-graph-canvas-wrap"><canvas id="memory-graph-canvas" width="1120" height="640" role="img" aria-label="Interactive governed memory graph"></canvas></div><div class="memory-graph-legend">${memoryGraphLegend(model.nodes)}</div></div><aside class="inspector"><h2>Current facts</h2>${currentList}<hr><h2>History facts</h2>${historyList}<hr><h2>Focus neighborhood</h2>${focusList}<hr><dl class="facts compact-facts"><div><dt>Provider</dt><dd>${esc(model.provider)}</dd></div><div><dt>Generated</dt><dd>${date(model.generatedAt)}</dd></div><div><dt>Read-only</dt><dd>${model.safeguards.readOnly?'yes':'no'}</dd></div><div><dt>Model calls</dt><dd>${Number(model.safeguards.modelCalls??0)}</dd></div><div><dt>Network</dt><dd>${Number(model.safeguards.networkCalls??0)}</dd></div><div><dt>External writes</dt><dd>${model.safeguards.externalWritesEnabled?'enabled':'disabled'}</dd></div></dl></aside></section>`;
}

function memoryGraphEdgeList(edges=[]) {
  return `<ol class="compact-list locator-list">${edges.map((edge)=>`<li><strong>${esc(edge.from)} ${esc(edge.predicate)} ${esc(edge.to)}</strong><span>${edge.current?'Current':'Superseded'} · ${edge.supersededBy?`superseded by ${esc(edge.supersededBy)}`:'current winner'}</span><small>Valid from ${date(edge.validFrom)} · Valid until ${edge.validUntil?date(edge.validUntil):'open'} · Provenance ${esc(edge.source)}</small></li>`).join('')}</ol>`;
}

function memoryGraphLegend(nodes=[]) {
  const types=[...new Set(nodes.map((node)=>node.type))].sort();
  if(!types.length)return '<p class="muted">No node types to render.</p>';
  return types.map((type)=>`<span><i style="background:${memoryGraphNodeColor(type,0,false)}"></i>${esc(type)}</span>`).join('');
}

export function renderMemoryIntakePanel(result=null,error=null,draft={sourceLocator:'memory/inbox.md',text:''}) {
  const rows=Array.isArray(result?.proposalFacts) && result.proposalFacts.length
    ? `<ol class="compact-list locator-list">${result.proposalFacts.map((item)=>`<li><strong>${esc(item.subject)} ${esc(item.predicate)}</strong><span>${esc(item.object)}</span><small>${esc(item.id)} · ${esc(item.status)} · ${esc(item.sourceLocator)}</small></li>`).join('')}</ol>`
    : '<p class="muted">No proposal facts extracted yet. Try: Fact: project:memory-recall release_status release-candidate.</p>';
  const resultPanel=result
    ? `<div class="state-panel state-success"><h2>${esc(result.command)}</h2><p>${Number(result.summary?.proposalCount ?? 0)} proposal${Number(result.summary?.proposalCount ?? 0)===1?'':'s'} · ${Number(result.summary?.activeMemoryCreated ?? 0)} active memory created</p>${rows}</div>`
    : '';
  const errorPanel=error?renderApiErrorPanel('Memory intake failed',error):'';
  return `<section class="memory-intake" aria-label="Add memory"><div class="section-heading"><div><p class="eyebrow">New proposal</p><h2>Add memory</h2></div><span>Creates proposals only</span></div><form id="memory-intake-form" class="stacked-form"><label class="field"><span>Source path</span><input name="sourceLocator" value="${esc(draft.sourceLocator ?? 'memory/inbox.md')}" required maxlength="512" placeholder="memory/inbox.md"></label><label class="field"><span>Memory text</span><textarea name="text" required maxlength="8000" placeholder="Fact: project:memory-recall release_status release-candidate.">${esc(draft.text ?? '')}</textarea><small>Use simple fact lines. Preview creates no active memory.</small></label><div class="action-row"><button class="button secondary" name="mode" value="preview" type="submit">Preview proposals</button><button class="button primary" name="mode" value="queue" type="submit">Queue proposals</button></div></form>${errorPanel}${resultPanel}</section>`;
}

function renderMemoryProposalList(items=[],approve=false) {
  if(!items.length)return '<p class="muted">No proposals waiting for review.</p>';
  return `<ol class="compact-list locator-list">${items.map((item)=>`<li><strong>${esc(item.id)} · ${esc(item.status)}</strong><span>${esc(item.sourceLocator)} · attempts ${item.attempts}</span>${approve?`<button class="button secondary" data-action="approve-memory-proposal" data-proposal-id="${esc(item.id)}" type="button">Approve</button>`:''}${item.payload.length?`<dl class="summary-list">${item.payload.map((entry)=>`<div><dt>${esc(entry.key)}</dt><dd>${esc(entry.value)}</dd></div>`).join('')}</dl>`:''}</li>`).join('')}</ol>`;
}

export function renderMemoryCockpit(cockpit = null) {
  const model=buildMemoryCockpitModel(cockpit);
  const intake=renderMemoryIntakePanel(memoryIntakeResult,memoryIntakeError,memoryIntakeDraft);
  if(!model.ready)return `<div class="tool-workspace memory-workspace"><header class="tool-page-heading"><div><p class="eyebrow">Governed repository memory</p><h1>Memory</h1><p>Review proposals before they become active repository facts.</p></div><span>Local SQLite</span></header><section class="surface">${intake}</section>${statePanel('empty','No memory store loaded','Run local memory ingest to create reviewable proposals.')}</div>`;
  const facts=model.facts.length
    ? `<div class="memory-list">${model.facts.map((fact)=>`<article class="memory-diff state-${esc(fact.status)}"><header><div><code>${esc(fact.id)}</code><h3>${esc(fact.subject)} ${esc(fact.predicate)}</h3></div>${statusChip(fact.status,fact.status,'Temporal fact status')}</header><p>${esc(fact.text)}</p><dl class="facts compact-facts"><div><dt>Scope</dt><dd>${esc(fact.scope)}</dd></div><div><dt>Object</dt><dd>${esc(fact.object)}</dd></div><div><dt>Valid from</dt><dd>${date(fact.validFrom)}</dd></div><div><dt>Valid until</dt><dd>${fact.validUntil?date(fact.validUntil):'open'}</dd></div><div><dt>Superseded by</dt><dd>${esc(fact.supersededBy)}</dd></div><div><dt>Episode</dt><dd>${esc(fact.provenance.episodeId)}</dd></div></dl><div class="reason-list">${fact.supersessionChain.map((id)=>`<span class="reason">${esc(id)}</span>`).join('')}</div><p class="muted">Source ${esc(fact.provenance.source)}${fact.provenance.summary?` · ${esc(fact.provenance.summary)}`:''}</p></article>`).join('')}</div>`
    : statePanel('empty','No temporal facts yet','The native SQLite provider is reachable, but this workspace has no bi-temporal facts.');
  const pendingProposals=model.proposalQueue.filter((item)=>item.status==='pending');
  const proposalHistory=model.proposalQueue.filter((item)=>item.status!=='pending');
  const queue=renderMemoryProposalList(pendingProposals,true);
  const history=proposalHistory.length?`<div class="section-heading"><h3>Proposal history</h3><span>${proposalHistory.length}</span></div>${renderMemoryProposalList(proposalHistory)}`:'';
  const toolStats=model.mcpStats.byTool.length
    ? `<ol class="compact-list locator-list">${model.mcpStats.byTool.map((item)=>`<li><strong>${esc(item.toolName)} · ${item.callCount}</strong><span>${item.deliveredTokens} delivered · ${item.tokensSaved} saved</span></li>`).join('')}</ol>`
    : '<p class="muted">No MCP delivery calls recorded for this workspace yet.</p>';
  return `<div class="tool-workspace memory-workspace"><header class="tool-page-heading"><div><p class="eyebrow">Governed repository memory</p><h1>Memory</h1><p>Review proposed facts, inspect current truth, and add explicit source-backed memory.</p></div><dl class="tool-summary"><div><dt>Pending</dt><dd>${model.summary.pendingProposalCount}</dd></div><div><dt>Active</dt><dd>${model.summary.activeFactCount}</dd></div><div><dt>Delivery</dt><dd>${deliveryChangeLabel(model.savings.percent)}</dd></div></dl></header><section class="memory-review-grid"><section class="memory-review-queue"><div class="section-heading"><h2>Review queue</h2><span>${model.summary.pendingProposalCount} pending</span></div>${queue}</section><aside class="memory-intake-panel">${intake}</aside></section><section class="memory-ledger"><div class="section-heading"><h2>Active memory</h2><span>${model.facts.length} facts</span></div>${facts}</section><details class="tool-disclosure memory-delivery"><summary>Delivery details · ${deliveryChangeLabel(model.savings.percent)}</summary><dl class="facts facts-wide"><div><dt>Active facts</dt><dd>${model.summary.activeFactCount}</dd></div><div><dt>Pending proposals</dt><dd>${model.summary.pendingProposalCount}</dd></div><div><dt>Naive baseline</dt><dd>${model.savings.beforeDeliveryTokens}</dd></div><div><dt>Memory Recall delivery</dt><dd>${model.savings.afterDeliveryTokens}</dd></div><div><dt>Delivery tokens saved</dt><dd>${model.savings.tokensSaved}</dd></div><div><dt>MCP calls</dt><dd>${model.mcpStats.callCount}</dd></div><div><dt>MCP delivered</dt><dd>${model.mcpStats.deliveredTokens}</dd></div><div><dt>MCP saved</dt><dd>${model.mcpStats.tokensSaved}</dd></div><div><dt>Provider billing</dt><dd>${model.savings.providerBillingClaimed||model.mcpStats.providerBillingClaimed?'claimed':'not claimed'}</dd></div><div><dt>Provider</dt><dd>${esc(model.provider)}</dd></div></dl>${toolStats}${history}<p class="muted">Delivery values are local estimates, not provider billing claims. No model, network, or raw source body is used on this route.</p></details></div>`;
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
  const errorPanel=harnessSetupError?renderApiErrorPanel('Harness setup preview failed',harnessSetupError):'';
  const selectedClient=harnessSetupResult?.client ?? 'codex';
  const handoff=currentHandoffStatus();
  return `<section class="work-grid"><div class="surface surface-primary"><div class="section-heading"><h2>Native baselines</h2><span>Conformance anchors</span></div><div class="table-wrap"><table><thead><tr><th>Surface</th><th>Status</th><th>Boundary</th></tr></thead><tbody>${[['Model gateway','reference','deterministic default'],['Workflow runtime','reference','embedded + durable SQLite'],['Tool broker','reference','one-use local grants'],['External adapters','disabled','12 contracts, 0 enabled']].map(row=>`<tr><td>${row[0]}</td><td>${row[1]}</td><td>${row[2]}</td></tr>`).join('')}</tbody></table></div></div><aside class="inspector"><h2>Tool policy</h2><p>Policy, grants, filesystem, loopback egress, and secret references remain independently brokered.</p></aside></section>${renderHandoffStatusPanel(handoff,'agents')}<section class="work-grid"><div class="surface surface-primary"><div class="section-heading"><h2>Harness setup preview</h2><span>Dry run only</span></div><form id="harness-setup-form" class="stacked-form"><label class="field"><span>Client</span><select name="client">${harnessSetupClientsForUi().map(([id,label])=>`<option value="${esc(id)}"${id===selectedClient?' selected':''}>${esc(label)}</option>`).join('')}</select></label><div class="action-row"><button class="button primary" type="submit">Preview setup</button><span class="muted">No home config writes. Compatibility server key: oaf.</span></div></form></div><aside class="inspector"><h2>Setup boundary</h2><dl class="facts"><div><dt>API body</dt><dd>workspace and client only</dd></div><div><dt>Server key</dt><dd>oaf</dd></div><div><dt>Mode</dt><dd>plan-only dry run</dd></div><div><dt>Bridge</dt><dd>read-only MCP resources</dd></div></dl></aside></section>${errorPanel}${harnessSetupResult?renderHarnessSetupResult(harnessSetupResult):statePanel('empty','No setup preview yet','Choose a local harness client to see the redacted MCP setup plan.')}`;
}

function renderHarnessSetupResult(report) {
  const model=buildHarnessSetupUiModel(report);
  const commands=[
    {label:'CLI preview',command:model.command},
    {label:'Read-only bridge',command:model.bridgeCommand}
  ];
  const snippet=model.manualConfigSnippet ? `<hr><div class="section-heading"><h2>Manual config</h2><span>${esc(model.manualConfigSnippet.format)}</span></div><p class="muted">${esc(model.manualConfigSnippet.warning)}</p><dl class="facts compact-facts"><div><dt>Config ref</dt><dd>${esc(model.manualConfigSnippet.configRef)}</dd></div><div><dt>Apply mode</dt><dd>${esc(model.manualConfigSnippet.applyMode)}</dd></div></dl><pre class="code-block"><code>${esc(model.manualConfigSnippet.content)}</code></pre>` : '';
  return `<section class="work-grid"><div class="surface surface-primary"><div class="section-heading"><h2>${esc(model.client)} setup plan</h2><span>${esc(shortFingerprint(model.fingerprint))}</span></div><dl class="facts facts-wide"><div><dt>Config</dt><dd>${esc(model.configRef)}</dd></div><div><dt>Config status</dt><dd>${esc(model.configStatus)}</dd></div><div><dt>Server key</dt><dd>${esc(model.serverStatus)}</dd></div><div><dt>Operation</dt><dd>${esc(model.operation)}</dd></div></dl>${contextPackCommandList(commands)}${snippet}</div><aside class="inspector"><div class="section-heading"><h2>Safeguards</h2><span>redacted</span></div><dl class="facts compact-facts">${model.safeguards.map(([label,value])=>`<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl><hr><p class="muted">This preview does not print raw config bodies, credentials, provider URLs, absolute local paths, or hidden reasoning.</p></aside></section>`;
}

function renderSettings() {
  return `<section class="work-grid"><div class="surface surface-primary"><div class="section-heading"><h2>Local system</h2><span>Shared tokens</span></div><div class="token-grid">${[['Ink','--ink'],['Paper','--paper'],['Signal','--signal'],['Proof','--proof'],['Caution','--caution'],['Danger','--danger'],['Success','--success']].map(([name,token])=>`<div class="swatch" style="background:var(${token})"><strong>${name}<code>${token}</code></strong></div>`).join('')}</div></div><aside class="inspector"><h2>Defaults</h2>${localBoundary()}</aside></section>`;
}

function metric(value,label,copy){return `<div class="metric"><strong>${Number(value??0)}</strong><span>${label}</span><small>${copy}</small></div>`}
function statusChip(kind,label,description){return `<span class="status-chip status-${esc(kind)}"><strong>${esc(label)}</strong><small>${esc(description)}</small></span>`}
function localBoundary(){return `<dl class="facts"><div><dt>Residency</dt><dd>Local-only</dd></div><div><dt>Network</dt><dd>Denied by default</dd></div><div><dt>Writes</dt><dd>External writes disabled</dd></div><div><dt>Model</dt><dd>Deterministic offline default</dd></div></dl>`}
export function renderSetupScreen(mode, copy, inputModel=null) {
  const model=inputModel ?? buildAuthViewModel({mode,copy,draft:authDraft,error:authError});
  const isBootstrap = mode === 'bootstrap';
  const title = isBootstrap ? 'Set up this workspace' : 'Sign in';
  const submitLabel = isBootstrap ? 'Create local owner' : 'Sign in';
  const displayName = isBootstrap
    ? `<label class="field"><span>Display name</span><input name="displayName" autocomplete="name" value="${esc(model.draft.displayName)}" required maxlength="120"></label>`
    : '';
  const errorPanel=model.error?`<div class="auth-error" role="alert"><strong>${esc(model.error.message)}</strong>${renderApiErrorRecovery(model.error)}</div>`:'';
  return `<section class="setup-screen">
    <div class="setup-intro">
      <span class="setup-step">Workspace security</span>
      <h1>${title}</h1>
      <p>${esc(copy)}</p>
      <ol class="setup-sequence">
        <li aria-current="step">Secure local access</li>
        <li>Run the first scan after sign-in</li>
        <li>Connect a coding tool</li>
        <li>Review proposed memory</li>
      </ol>
    </div>
    <form id="auth-form" class="setup-form" data-mode="${mode}" autocomplete="on">
      <label class="field"><span>Username</span><input name="username" autocomplete="username" value="${esc(model.draft.username)}" required maxlength="80" pattern="[A-Za-z0-9._:\\-]{1,80}"></label>
      ${displayName}
      <label class="field"><span>Password</span><input name="password" type="password" autocomplete="${isBootstrap ? 'new-password' : 'current-password'}" required minlength="12" maxlength="256"></label>
      ${errorPanel}
      <button class="button primary" type="submit">${submitLabel}</button>
      <p class="setup-note">Credentials stay in this workspace and are stored as a password hash.</p>
    </form>
  </section>`;
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

async function submitGlobalSearch(event){event.preventDefault();const input=event.currentTarget.elements.query;const query=String(input?.value??'').trim().slice(0,256);if(!query){input?.focus();return}const params=new URLSearchParams({query});const currentWorkspace=workspaceId();if(currentWorkspace!=='ws_local')params.set('workspaceId',currentWorkspace);history.pushState({},'',`/map?${params.toString()}`);document.querySelector('#live-status').textContent='Searching bounded repository metadata.';await loadRecallMap();render();document.querySelector('#main').focus({preventScroll:true});document.querySelector('#live-status').textContent=recallMapError?`Repository search failed. ${buildApiErrorUiModel(recallMapError).message}`:'Repository search loaded.'}

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
  authDraft={username,displayName};
  authError=null;
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
    authDraft={username:'',displayName:''};
    authError=null;
    document.querySelector('#live-status').textContent=mode==='bootstrap'?'Local owner created.':'Signed in locally.';
    await load();
  }catch(error){
    document.querySelector('#live-status').textContent=error.message;
    const transition=authFailureTransition({mode,draft:{username,displayName},error});
    const message=transition.message;
    authError={...buildApiErrorUiModel(error),message};
    authDraft=transition.draft;
    if(transition.clearPassword){
      form.querySelector('input[name="password"]').value='';
      shellState={kind:transition.shellKind,message};
      render();
    }else{
      const existing=form.querySelector('.auth-error');
      const panel=existing??document.createElement('div');
      panel.className='auth-error';
      panel.setAttribute('role','alert');
      panel.textContent=message;
      if(authError.correlationId){const correlation=document.createElement('code');correlation.textContent=`Correlation ${authError.correlationId}`;panel.append(correlation)}
      if(!existing)button.before(panel);
      shellState={kind:transition.shellKind,message};
    }
  }finally{
    button.disabled=false;
    button.textContent=mode==='bootstrap'?'Create owner':'Sign in';
  }
}

function contextPackPayloadFromForm(form) {
  const data=new FormData(form);
  const targetHarness=String(data.get('targetHarness') ?? 'generic');
  const objective=String(data.get('objective') ?? '').trim();
  const step=String(data.get('step') ?? '').trim();
  const tokenBudget=Number(data.get('tokenBudget') ?? 4096);
  const sourceFamilies=contextPackSelectedSourceFamilies(form);
  const userSelectedFiles=parseSelectedFiles(data.get('userSelectedFiles'));
  const changedLocators=parseSelectedFiles(data.get('changedLocators'));
  const memoryConfig=buildMemoryWorkspaceConfig(data.get('memorySourceFiles'));
  return {
    memoryConfig,
    payload:{workspaceId:workspaceId(),targetHarness,from:sourceFamilies.join(','),objective,step,tokenBudget,userSelectedFiles,changedLocators}
  };
}

function cloneContextPackPayload(payload) {
  if(!payload || typeof payload!=='object')return null;
  return {
    workspaceId:String(payload.workspaceId ?? workspaceId()),
    targetHarness:String(payload.targetHarness ?? 'generic'),
    from:String(payload.from ?? 'codex'),
    objective:String(payload.objective ?? ''),
    step:String(payload.step ?? ''),
    tokenBudget:Number(payload.tokenBudget ?? 4096),
    userSelectedFiles:Array.isArray(payload.userSelectedFiles) ? payload.userSelectedFiles.map(String) : [],
    changedLocators:Array.isArray(payload.changedLocators) ? payload.changedLocators.map(String) : []
  };
}

export function selectContextPackPinPayload({reviewedPayload=null,formPayload=null} = {}) {
  return cloneContextPackPayload(reviewedPayload) ?? cloneContextPackPayload(formPayload);
}

async function submitContextPack(event){
  event.preventDefault();
  const form=event.currentTarget;
  const button=form.querySelector('button[type=submit]');
  const {payload,memoryConfig}=contextPackPayloadFromForm(form);
  contextPackMemoryConfig=memoryConfig;
  button.disabled=true;
  button.textContent='Building...';
  document.querySelector('#live-status').textContent='Building local context pack.';
  try{
    const started=globalThis.performance?.now?.() ?? Date.now();
    const result=await api('/api/context/pack',{method:'POST',body:JSON.stringify(payload)});
    const finished=globalThis.performance?.now?.() ?? Date.now();
    contextPackReviewedPayload=selectContextPackPinPayload({formPayload:payload});
    contextPackResult={...result,observedDurationMs:Math.max(0,Math.round(finished-started)),memoryConfig:contextPackMemoryConfig,reviewedPayload:contextPackReviewedPayload};
    contextPackError=null;
    contextPackPinError=null;
    contextPackMemoryPreflightError=null;
    document.querySelector('#live-status').textContent='Context pack built.';
    render();
  }catch(error){
    document.querySelector('#live-status').textContent=error.message;
    contextPackError=error;
    render();
  }finally{
    button.disabled=false;
    button.textContent='Build context pack';
  }
}

async function runContextPackMemoryPreflight(event){
  const button=event.currentTarget;
  const config=currentContextPackMemoryConfig();
  if(!config.memoryPaths.length){
    document.querySelector('#live-status').textContent='No memory preflight sources selected.';
    return;
  }
  button.disabled=true;
  button.textContent='Running...';
  document.querySelector('#live-status').textContent='Running read-only memory preflight.';
  try{
    const result=await api('/api/context/pack/memory-preflight',{method:'POST',body:JSON.stringify({workspaceId:workspaceId(),memoryConfig:config})});
    contextPackResult={...(contextPackResult??{}),memoryConfig:config,memoryProposalPreflight:result};
    contextPackMemoryPreflightError=null;
    document.querySelector('#live-status').textContent=`Memory preflight ${result.state}.`;
    render();
  }catch(error){
    contextPackMemoryPreflightError=error;
    document.querySelector('#live-status').textContent=error.message;
    render();
  }finally{
    button.disabled=false;
    button.textContent='Run memory preflight';
  }
}

async function previewContextSources(event){
  const button=event.currentTarget;
  const form=button.closest('form');
  if(!form)return;
  const status=form.querySelector('[data-source-preview-status]');
  const data=new FormData(form);
  const objective=String(data.get('objective') ?? '').trim();
  const step=String(data.get('step') ?? '').trim();
  const tokenBudget=Number(data.get('tokenBudget') ?? 4096);
  const sourceFamilies=contextPackSelectedSourceFamilies(form);
  const userSelectedFiles=parseSelectedFiles(data.get('userSelectedFiles'));
  button.disabled=true;
  button.textContent='Previewing...';
  if(status)status.textContent='Scanning selected harness sources without writes.';
  document.querySelector('#live-status').textContent='Previewing harness context sources.';
  try{
    contextSourcePreviewResult=await api('/api/context/source-preview',{method:'POST',body:JSON.stringify({workspaceId:workspaceId(),from:sourceFamilies.join(','),objective,step,tokenBudget,userSelectedFiles})});
    contextSourcePreviewError=null;
    if(status)status.textContent=`${Number(contextSourcePreviewResult.scan?.summary?.totalAccepted??0)} source${Number(contextSourcePreviewResult.scan?.summary?.totalAccepted??0)===1?'':'s'} accepted for review.`;
    document.querySelector('#live-status').textContent='Harness source preview ready.';
    render();
  }catch(error){
    contextSourcePreviewError=error;
    if(status)status.textContent=error.message;
    document.querySelector('#live-status').textContent=error.message;
    render();
  }finally{
    button.disabled=false;
    button.textContent='Preview sources';
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
    button.textContent='Detect current git changes';
  }
}

async function refreshPinnedHandoff(event) {
  const button=event.currentTarget;
  const previous=button.textContent;
  button.disabled=true;
  button.textContent='Checking...';
  document.querySelector('#live-status').textContent='Checking pinned local handoff.';
  try {
    await loadPinnedHandoffStatus();
    pinnedHandoffReceiveReport=null;
    pinnedHandoffReceiveError=null;
    document.querySelector('#live-status').textContent='Pinned handoff status checked.';
    render();
  } catch (error) {
    pinnedHandoffError=error.message;
    pinnedHandoffReceiveReport=null;
    pinnedHandoffReceiveError=null;
    document.querySelector('#live-status').textContent=error.message;
    render();
  } finally {
    if(button.isConnected){
      button.disabled=false;
      button.textContent=previous;
    }
  }
}

async function receivePinnedHandoff(event) {
  const button=event.currentTarget;
  const previous=button.textContent;
  button.disabled=true;
  button.textContent='Receiving...';
  document.querySelector('#live-status').textContent='Reading pinned receiver packet.';
  try {
    pinnedHandoffReceiveReport=await api(`/api/context/pack/receive?workspaceId=${encodeURIComponent(workspaceId())}`);
    pinnedHandoffReceiveError=null;
    document.querySelector('#live-status').textContent=`Pinned receiver packet ${pinnedHandoffReceiveReport.state}.`;
    render();
  } catch (error) {
    pinnedHandoffReceiveReport=null;
    pinnedHandoffReceiveError=error;
    document.querySelector('#live-status').textContent=error.message;
    render();
  } finally {
    if(button.isConnected){
      button.disabled=false;
      button.textContent=previous;
    }
  }
}

async function pinCurrentContextPack(event) {
  const button=event.currentTarget;
  const form=document.querySelector('#context-pack-form');
  if(!form || !contextPackResult?.pack){
    document.querySelector('#live-status').textContent='Build a context pack before pinning.';
    return;
  }
  const previous=button.textContent;
  const formSnapshot=contextPackPayloadFromForm(form);
  const payload=selectContextPackPinPayload({reviewedPayload:contextPackResult?.reviewedPayload ?? contextPackReviewedPayload,formPayload:formSnapshot.payload});
  const memoryConfig=contextPackResult?.memoryConfig ?? formSnapshot.memoryConfig;
  if(!payload){
    document.querySelector('#live-status').textContent='Build a context pack before pinning.';
    return;
  }
  button.disabled=true;
  button.textContent='Pinning...';
  document.querySelector('#live-status').textContent='Pinning reviewed local handoff.';
  try{
    const result=await api('/api/context/pack/pin',{method:'POST',body:JSON.stringify(payload)});
    contextPackReviewedPayload=payload;
    contextPackResult={...result,observedDurationMs:contextPackResult?.observedDurationMs,memoryConfig,memoryProposalPreflight:contextPackResult?.memoryProposalPreflight,reviewedPayload:payload};
    contextPackMemoryConfig=memoryConfig;
    contextPackPinError=null;
    pinnedHandoffStatus=result.registryStatus;
    pinnedHandoffError=null;
    pinnedHandoffReceiveReport=null;
    pinnedHandoffReceiveError=null;
    document.querySelector('#live-status').textContent=`Pinned local handoff: ${result.pin?.current?.status ?? 'verified'}.`;
    render();
  }catch(error){
    contextPackPinError=error;
    document.querySelector('#live-status').textContent=error.message;
    render();
  }finally{
    if(button.isConnected){
      button.disabled=false;
      button.textContent=previous;
    }
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
    sourceGraphError=error;
    render();
  }finally{
    button.disabled=false;
    button.textContent='Preview repo map';
  }
}

async function submitMemoryGraph(event){
  event.preventDefault();
  const form=event.currentTarget;
  const button=form.querySelector('button[type=submit]');
  const data=new FormData(form);
  const query=String(data.get('query')??'').trim();
  const history=data.get('history')==='on';
  const communities=data.get('communities')==='on';
  button.disabled=true;
  button.textContent='Refreshing...';
  document.querySelector('#live-status').textContent='Refreshing governed memory graph.';
  await loadMemoryGraph({history,query,entity:'',communities});
  render();
  document.querySelector('#live-status').textContent=memoryGraphError??'Governed memory graph ready.';
}

async function toggleMemoryGraphHistory(event){
  await loadMemoryGraph({...memoryGraphOptions,history:event.currentTarget.checked,entity:''});
  render();
}

function toggleMemoryGraphCommunities(event){
  memoryGraphOptions={...memoryGraphOptions,communities:event.currentTarget.checked};
  render();
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
    harnessSetupError=error;
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
    harnessSetupError=error;
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
    await writeClipboardText(markdown);
    document.querySelector('#live-status').textContent='Context pack markdown copied.';
    button.textContent='Copied';
  }catch(error){
    document.querySelector('#live-status').textContent='Copy failed. Select the markdown manually.';
  }finally{
    setTimeout(()=>{ button.textContent=previous; },1200);
  }
}

async function copyContextPackLaunchPrompt(event){
  const prompt=contextPackResult?.pack?.handoff?.launchPrompt ?? '';
  if(!prompt)return;
  const button=event.currentTarget;
  const previous=button.textContent;
  try{
    await writeClipboardText(prompt);
    document.querySelector('#live-status').textContent='Launch prompt copied.';
    button.textContent='Copied';
  }catch(error){
    document.querySelector('#live-status').textContent='Copy failed. Select the launch prompt from the markdown.';
  }finally{
    setTimeout(()=>{ button.textContent=previous; },1200);
  }
}

async function copyPinnedReceiverPacket(event){
  const packet=pinnedHandoffReceiveReport?.receiverPacket ?? null;
  if(!packet)return;
  const button=event.currentTarget;
  const previous=button.textContent;
  try{
    await writeClipboardText(JSON.stringify(packet,null,2));
    document.querySelector('#live-status').textContent='Receiver packet copied.';
    button.textContent='Copied';
  }catch(error){
    document.querySelector('#live-status').textContent='Copy failed. Use the read-only receive command instead.';
  }finally{
    setTimeout(()=>{ button.textContent=previous; },1200);
  }
}

function currentContextPackMemoryConfig() {
  return normalizeMemoryWorkspaceConfig(contextPackResult?.memoryConfig ?? contextPackMemoryConfig);
}

async function copyContextPackMemoryConfig(event){
  const config=currentContextPackMemoryConfig();
  if(!config.memoryPaths.length)return;
  const button=event.currentTarget;
  const previous=button.textContent;
  try{
    await writeClipboardText(memoryConfigJson(config));
    document.querySelector('#live-status').textContent='Memory config copied.';
    button.textContent='Copied';
  }catch(error){
    document.querySelector('#live-status').textContent='Copy failed. Download the memory config instead.';
  }finally{
    setTimeout(()=>{ button.textContent=previous; },1200);
  }
}

export async function writeClipboardText(text) {
  if(globalThis.navigator?.clipboard?.writeText){
    await navigator.clipboard.writeText(text);
    return true;
  }
  const helper=document.createElement('textarea');
  helper.value=text;
  helper.setAttribute('readonly','');
  helper.style.position='fixed';
  helper.style.opacity='0';
  document.body.appendChild(helper);
  helper.focus();
  helper.select();
  const copied=document.execCommand?.('copy') ?? false;
  helper.remove();
  if(!copied)throw new Error('clipboard_unavailable');
  return copied;
}

export async function copyCommand(event){
  const button=event.currentTarget;
  const command=button.closest('li')?.querySelector('code')?.textContent ?? '';
  if(!command)return;
  const previous=button.textContent;
  try{
    await writeClipboardText(command);
    document.querySelector('#live-status').textContent='Command copied.';
    button.textContent='Copied';
  }catch(error){
    document.querySelector('#live-status').textContent='Copy failed. Select the command manually.';
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

function downloadContextPackUsePlan(event){
  const usePlan=contextPackResult?.usePlan ?? null;
  const pack=contextPackResult?.pack ?? null;
  if(!usePlan||!pack)return;
  const blob=new Blob([JSON.stringify(usePlan,null,2)],{type:'application/json;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const link=document.createElement('a');
  link.href=url;
  link.download=contextPackUsePlanDownloadName(pack);
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  document.querySelector('#live-status').textContent='Context pack use-plan download started.';
  event.currentTarget.textContent='Download use plan';
}

function downloadContextPackMemoryConfig(event){
  const config=currentContextPackMemoryConfig();
  if(!config.memoryPaths.length)return;
  const blob=new Blob([memoryConfigJson(config)],{type:'application/json;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const link=document.createElement('a');
  link.href=url;
  link.download=memoryConfigDownloadName();
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  document.querySelector('#live-status').textContent='Memory config download started.';
  event.currentTarget.textContent='Download memory config';
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

function duration(start,end){if(!start)return '-';const from=Date.parse(start),to=end?Date.parse(end):Date.now();if(!Number.isFinite(from)||!Number.isFinite(to))return '-';const ms=Math.max(0,to-from);if(ms<1000)return `${ms} ms`;if(ms<60000)return `${Math.round(ms/1000)} s`;return `${Math.round(ms/60000)} min`}
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

function memoryGraphNodeColor(type,community=0,useCommunity=false){
  if(useCommunity){
    const palette=['#4cc9a6','#7aa2ff','#f7b955','#e56b8b','#b38cff','#62d3ff','#9bd66f','#f08f4f'];
    return palette[Math.abs(Number(community??0))%palette.length];
  }
  return ({project:'#4cc9a6',provider:'#7aa2ff',port:'#f7b955',decision:'#e56b8b',module:'#b38cff',entity:'#8a96a8'})[type]??'#8a96a8';
}

function memoryGraphVisiblePayload(report){
  const nodes=Array.isArray(report?.graph?.nodes)?report.graph.nodes:[];
  const edges=Array.isArray(report?.graph?.edges)?report.graph.edges:[];
  const focusNames=new Set((report?.focus?.nodes??[]).map((node)=>node.name));
  if(!focusNames.size)return {nodes,edges};
  return {
    nodes:nodes.filter((node)=>focusNames.has(node.name)),
    edges:edges.filter((edge)=>focusNames.has(edge.from)&&focusNames.has(edge.to))
  };
}

function layoutMemoryGraph(nodes,edges,width,height){
  const positions=new Map();
  const centerX=width/2;
  const centerY=height/2;
  const radius=Math.max(80,Math.min(width,height)*0.36);
  nodes.forEach((node,index)=>{
    const angle=(Math.PI*2*index)/Math.max(1,nodes.length);
    positions.set(node.id,{x:centerX+Math.cos(angle)*radius,y:centerY+Math.sin(angle)*radius,vx:0,vy:0,node});
  });
  const linked=edges.map((edge)=>({source:positions.get(edge.from),target:positions.get(edge.to),edge})).filter((item)=>item.source&&item.target);
  for(let tick=0;tick<90;tick+=1){
    for(let i=0;i<nodes.length;i+=1){
      const a=positions.get(nodes[i].id);
      for(let j=i+1;j<nodes.length;j+=1){
        const b=positions.get(nodes[j].id);
        let dx=a.x-b.x;
        let dy=a.y-b.y;
        let distance=Math.max(24,Math.hypot(dx,dy));
        const force=780/(distance*distance);
        dx/=distance;dy/=distance;
        a.vx+=dx*force;b.vx-=dx*force;
        a.vy+=dy*force;b.vy-=dy*force;
      }
    }
    for(const link of linked){
      const dx=link.target.x-link.source.x;
      const dy=link.target.y-link.source.y;
      const distance=Math.max(1,Math.hypot(dx,dy));
      const target=140;
      const force=(distance-target)*0.015;
      const fx=(dx/distance)*force;
      const fy=(dy/distance)*force;
      link.source.vx+=fx;link.target.vx-=fx;
      link.source.vy+=fy;link.target.vy-=fy;
    }
    for(const entry of positions.values()){
      entry.vx+=(centerX-entry.x)*0.004;
      entry.vy+=(centerY-entry.y)*0.004;
      entry.x=Math.max(36,Math.min(width-36,entry.x+entry.vx));
      entry.y=Math.max(36,Math.min(height-36,entry.y+entry.vy));
      entry.vx*=0.82;entry.vy*=0.82;
    }
  }
  return positions;
}

function drawMemoryGraphCanvas(canvas,report,options={}){
  if(!canvas||!report?.graph)return;
  const ctx=canvas.getContext('2d');
  if(!ctx)return;
  const rect=canvas.getBoundingClientRect();
  const width=Math.max(640,Math.floor(rect.width||canvas.width||1120));
  const height=Math.max(420,Math.floor(rect.height||canvas.height||640));
  const dpr=Math.min(2,globalThis.devicePixelRatio||1);
  canvas.width=width*dpr;
  canvas.height=height*dpr;
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,width,height);
  ctx.fillStyle='#111826';
  ctx.fillRect(0,0,width,height);
  const {nodes,edges}=memoryGraphVisiblePayload(report);
  if(!nodes.length){
    ctx.fillStyle='#8a96a8';
    ctx.font='14px Inter, system-ui, sans-serif';
    ctx.fillText('No governed graph nodes to render.',24,34);
    return;
  }
  const positions=layoutMemoryGraph(nodes,edges,width,height);
  const focusNodes=new Set((report.focus?.nodes??[]).map((node)=>node.name));
  const query=String(options.query??'').toLowerCase();
  ctx.lineCap='round';
  for(const edge of edges){
    const source=positions.get(edge.from);
    const target=positions.get(edge.to);
    if(!source||!target)continue;
    const focused=!focusNodes.size||focusNodes.has(edge.from)||focusNodes.has(edge.to);
    ctx.globalAlpha=edge.current?(focused?0.72:0.32):0.18;
    ctx.strokeStyle=edge.current?'#4f5d75':'#9aa3b2';
    ctx.lineWidth=edge.current?1.4:1;
    ctx.setLineDash(edge.current?[]:[5,5]);
    ctx.beginPath();
    ctx.moveTo(source.x,source.y);
    ctx.lineTo(target.x,target.y);
    ctx.stroke();
    ctx.setLineDash([]);
    const labelX=(source.x+target.x)/2;
    const labelY=(source.y+target.y)/2;
    ctx.globalAlpha=edge.current?0.75:0.32;
    ctx.fillStyle='#c7ced9';
    ctx.font='11px Inter, system-ui, sans-serif';
    ctx.fillText(edge.predicate.slice(0,28),labelX+4,labelY-4);
  }
  ctx.globalAlpha=1;
  for(const node of nodes){
    const point=positions.get(node.id);
    if(!point)continue;
    const matched=query&&node.name.toLowerCase().includes(query);
    const focused=!focusNodes.size||focusNodes.has(node.name);
    const r=Number(node.size??10)+(matched?4:0);
    ctx.globalAlpha=node.current?(focused?1:0.52):0.34;
    ctx.fillStyle=memoryGraphNodeColor(node.type,node.community,options.communities);
    ctx.beginPath();
    ctx.arc(point.x,point.y,r,0,Math.PI*2);
    ctx.fill();
    if(node.governedDecision||matched){
      ctx.strokeStyle=node.governedDecision?'#ff7395':'#f7b955';
      ctx.lineWidth=3;
      ctx.stroke();
    }
    ctx.globalAlpha=node.current?0.92:0.46;
    ctx.fillStyle='#f5f7fb';
    ctx.font='12px Inter, system-ui, sans-serif';
    ctx.fillText(node.name.slice(0,34),point.x+r+5,point.y+4);
  }
  ctx.globalAlpha=1;
  canvas.onclick=async (event)=>{
    const box=canvas.getBoundingClientRect();
    const x=(event.clientX-box.left)*(width/box.width);
    const y=(event.clientY-box.top)*(height/box.height);
    let selected=null;
    let best=Infinity;
    for(const node of nodes){
      const point=positions.get(node.id);
      if(!point)continue;
      const distance=Math.hypot(point.x-x,point.y-y);
      const hit=(Number(node.size??10)+8);
      if(distance<hit&&distance<best){selected=node;best=distance;}
    }
    if(!selected)return;
    document.querySelector('#live-status').textContent=`Focusing ${selected.name}.`;
    await loadMemoryGraph({...memoryGraphOptions,entity:selected.name,query:''});
    render();
  };
}

function boot(){
  document.querySelector('#reset-button')?.addEventListener('click',resetDemo);
  document.querySelector('#global-search-form')?.addEventListener('submit',submitGlobalSearch);
  document.addEventListener('keydown',(event)=>{if(event.key==='Escape'){const menu=document.querySelector('#repository-menu[open]');if(menu){menu.open=false;menu.querySelector('summary')?.focus()}}});
  window.addEventListener('popstate',async()=>{activeRunDetail=null;const runId=new URL(location.href).searchParams.get('run');if(currentRoute().id==='runs'&&runId)loadRunById(runId,{push:false});else if(currentRoute().id==='source-graph'){await loadRecallMap();render()}else render()});
  const runId=new URL(location.href).searchParams.get('run');
  load().then(()=>{if(runId)loadRunById(runId,{push:false})});
}

if (globalThis.document?.querySelector('#view-root')) boot();
