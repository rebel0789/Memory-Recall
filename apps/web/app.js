export const SHELL_STATES = new Set(['loading','empty','error','denied','stale','partial','success']);

export const ROUTES = [
  { id:'home', path:'/', label:'Home', title:'Home', eyebrow:'Workspace / local', description:'Health, active work, approvals, residency, and the next local action.' },
  { id:'runs', path:'/runs', label:'Runs', title:'Runs', eyebrow:'Execution', description:'Run history, status, current step, artifacts, and sanitized timelines.' },
  { id:'workflows', path:'/workflows', label:'Workflows', title:'Workflows', eyebrow:'Definitions', description:'Workflow versions, graph outline, risk, retries, approvals, and tests.' },
  { id:'context', path:'/context', label:'Context', title:'Context', eyebrow:'Manifest inspector', description:'Selected and excluded records, budgets, conflicts, assembly, and compiler versions.' },
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
  if (!response.ok) {
    const error = new Error(response.status === 401 ? 'Local authentication required.' : `Request failed with ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
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
    dashboard = { error:{ status:error.status, message:error.message }, metrics:{ runs:0, completed:0, events:0, pendingApprovals:0 }, runs:[], approvals:[], latestRun:null, latestManifest:null };
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
  if (shellState.kind === 'denied') return deniedState();
  if (shellState.kind === 'error') return statePanel('error','Could not load local state', shellState.message, true);
  if (route.id === 'home') return renderHome();
  if (route.id === 'runs') return activeRunDetail ? renderRunDetail(activeRunDetail) : renderRuns();
  if (route.id === 'workflows') return renderWorkflows();
  if (route.id === 'context') return renderContext();
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
    ? statePanel('empty','No local runs yet','Run the content intelligence workflow to populate the local event ledger.',true)
    : shellState.kind === 'partial'
      ? statePanel('partial','Context manifest pending','A run exists, but no persisted context manifest is available yet.')
      : shellState.kind === 'stale'
        ? statePanel('stale','Cached local state',shellState.message,true)
        : '';
  return `${stateMarkup}<section class="metric-strip" aria-label="Workspace metrics">${metric(metrics.runs,'Runs','Recorded locally')}${metric(metrics.completed,'Completed','Verified outcomes')}${metric(metrics.events,'Events','Append-only ledger')}${metric(metrics.pendingApprovals,'Approvals','Need review')}</section><section class="work-grid"><div class="surface surface-primary"><div class="section-heading"><h2>Recent runs</h2><span>Local event ledger</span></div>${runList(dashboard?.runs)}</div><aside class="inspector" aria-label="Workspace inspector">${contextSummary(dashboard?.latestManifest)}${localBoundary()}</aside></section><section class="surface"><div class="section-heading"><h2>Latest recommendations</h2><span>Evidence-backed candidates</span></div>${angles(dashboard?.latestRun?.output?.output)}</section>`;
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

function renderContext() {
  const manifest=dashboard?.latestManifest;
  if(!manifest)return statePanel('empty','No context manifest yet','Run the local workflow to inspect selected and excluded records.',true);
  const model=buildContextInspectorModel(manifest);
  const params=new URL(globalThis.location?.href ?? 'http://127.0.0.1/context').searchParams;
  const recordId=params.get('record');
  const selectedRecord=recordId ? [...model.selected,...model.excluded].find((item)=>item.id===recordId) : null;
  return `<section class="context-hero surface"><div><p class="eyebrow">Context manifest</p><h2>${esc(model.id)}</h2><p>${esc(model.objective)}</p></div>${contextHeaderFacts(model)}</section>${selectedRecord?`<section class="surface"><div class="section-heading"><h2>Decision detail</h2><span>${esc(selectedRecord.selectedOrExcluded)}</span></div>${contextDecisionCard(selectedRecord,true)}</section>`:''}<section class="work-grid"><div class="surface surface-primary"><div class="section-heading"><h2>Selected</h2><span>${model.selected.length} records</span></div>${contextDecisionList(model.selected)}</div><aside class="inspector"><div class="section-heading"><h2>Excluded</h2><span>${model.excluded.length} records</span></div>${contextDecisionList(model.excluded)}</aside></section><section class="work-grid"><div class="surface"><div class="section-heading"><h2>Assembly</h2><span>${model.sections.length} sections</span></div>${assemblySections(model)}</div><aside class="inspector"><div class="section-heading"><h2>Comparison</h2><span>Selected vs assembly</span></div>${contextComparison(model)}<hr><div class="section-heading"><h2>Conflicts</h2><span>${model.conflicts.length}</span></div>${contextConflicts(model.conflicts)}</aside></section>`;
}

function renderMemory() {
  return `<section class="work-grid"><div class="surface surface-primary"><div class="section-heading"><h2>Memory lifecycle</h2><span>Proposal-first</span></div>${statePanel('empty','No active memory review in this workspace','Memory changes require proposal, verification, activation, supersession, retraction, or expiry.')}</div><aside class="inspector"><h2>Lifecycle states</h2><ol class="compact-list"><li>Observed</li><li>Proposed</li><li>Verified</li><li>Active</li><li>Superseded / retracted / expired</li></ol></aside></section>`;
}

function renderEvidence() {
  const manifest=dashboard?.latestManifest;
  const items=(manifest?.selected??[]).filter(item=>item.kind==='observation');
  if(!items.length)return statePanel('empty','No selected evidence yet','Run the local workflow to inspect source-backed observations.',true);
  return `<section class="surface"><div class="section-heading"><h2>Selected evidence</h2><span>Observation separate from inference</span></div><div class="evidence-list">${items.map(item=>`<article class="evidence-row"><header><code>${esc(item.id)}</code><span class="trust-label">untrusted source data</span></header><p>${esc(item.text)}</p><div class="meta-row"><span>Source: ${esc(item.source)}</span><span>${item.tokens} tokens</span></div>${reasons(item.reasonCodes)}</article>`).join('')}</div></section>`;
}

function renderApprovals() {
  const pending=dashboard?.metrics?.pendingApprovals ?? 0;
  return `<section class="work-grid"><div class="surface surface-primary"><div class="section-heading"><h2>Approval inbox</h2><span>${pending} pending</span></div>${statePanel('empty','No pending approvals','Consequential actions require exact preview, risk, expiry, and idempotency before approval.')}</div><aside class="inspector"><h2>Publisher boundary</h2><p>Publishing remains disabled. Postiz is planned, unpinned, and unsupported.</p>${statusChip('disabled','External writes disabled','Global kill switch')}</aside></section>`;
}

function renderContentLab() {
  const latest=dashboard?.latestRun;
  return `<section class="work-grid"><div class="surface surface-primary"><div class="section-heading"><h2>Candidate drafts</h2><span>Local workflow</span></div>${angles(latest?.output?.output)}</div><aside class="inspector"><h2>Local outcome</h2><dl class="facts"><div><dt>Approval</dt><dd>Bound to candidate, evidence, schema, prompt, and context</dd></div><div><dt>Draft</dt><dd>Local-only, publisher disabled</dd></div><div><dt>Outcome</dt><dd>Edit distance and objective metric, no causal claim</dd></div></dl></aside></section>`;
}

function renderAgentsTools() {
  return `<section class="work-grid"><div class="surface surface-primary"><div class="section-heading"><h2>Native baselines</h2><span>Conformance anchors</span></div><div class="table-wrap"><table><thead><tr><th>Surface</th><th>Status</th><th>Boundary</th></tr></thead><tbody>${[['Model gateway','reference','deterministic default'],['Workflow runtime','reference','embedded + durable SQLite'],['Tool broker','reference','one-use local grants'],['External adapters','disabled','12 contracts, 0 enabled']].map(row=>`<tr><td>${row[0]}</td><td>${row[1]}</td><td>${row[2]}</td></tr>`).join('')}</tbody></table></div></div><aside class="inspector"><h2>Tool policy</h2><p>Policy, grants, filesystem, loopback egress, and secret references remain independently brokered.</p></aside></section>`;
}

function renderSettings() {
  return `<section class="work-grid"><div class="surface surface-primary"><div class="section-heading"><h2>Local system</h2><span>Shared tokens</span></div><div class="token-grid">${[['Ink','--ink'],['Paper','--paper'],['Signal','--signal'],['Proof','--proof'],['Caution','--caution'],['Danger','--danger'],['Success','--success']].map(([name,token])=>`<div class="swatch" style="background:var(${token})"><strong>${name}<code>${token}</code></strong></div>`).join('')}</div></div><aside class="inspector"><h2>Defaults</h2>${localBoundary()}</aside></section>`;
}

function metric(value,label,copy){return `<div class="metric"><strong>${Number(value??0)}</strong><span>${label}</span><small>${copy}</small></div>`}
function statusChip(kind,label,description){return `<span class="status-chip status-${esc(kind)}"><strong>${esc(label)}</strong><small>${esc(description)}</small></span>`}
function localBoundary(){return `<dl class="facts"><div><dt>Residency</dt><dd>Local-only</dd></div><div><dt>Network</dt><dd>Denied by default</dd></div><div><dt>Writes</dt><dd>External writes disabled</dd></div><div><dt>Model</dt><dd>Deterministic offline default</dd></div></dl>`}
function statePanel(kind,heading,copy,button=false){return `<section class="state-panel state-${esc(kind)}" aria-live="${kind==='loading'?'polite':'off'}"><h2>${esc(heading)}</h2><p>${esc(copy)}</p>${button?'<div class="action-row"><button class="button primary" data-action="run" type="button">Run local demo</button><button class="button secondary" data-action="reset" type="button">Reset demo</button></div>':''}</section>`}
function deniedState(){return `<section class="state-panel state-denied"><h2>Local authentication required</h2><p>The loopback API denied this workspace request. Bootstrap or sign in locally, then reload this route.</p><p class="muted">No fallback data, external network, or direct storage access was used.</p></section>`}
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

async function runDemo(){
  const button=document.querySelector('#run-button');
  button.disabled=true;
  button.textContent='Running...';
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
    button.disabled=false;
    button.textContent='Run local demo';
  }
}

async function resetDemo(){
  const button=document.querySelector('#reset-button');
  button.disabled=true;
  try{
    await api('/api/reset',{method:'POST'});
    activeRunDetail=null;
    await load();
    document.querySelector('#live-status').textContent='Local demo data reset.';
  }catch(error){
    document.querySelector('#live-status').textContent=error.message;
  }finally{
    button.disabled=false;
  }
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
function date(value){return value?new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(new Date(value)):'-'}
function duration(start,end){if(!start)return '-';const from=Date.parse(start),to=end?Date.parse(end):Date.now();if(!Number.isFinite(from)||!Number.isFinite(to))return '-';const ms=Math.max(0,to-from);if(ms<1000)return `${ms} ms`;if(ms<60000)return `${Math.round(ms/1000)} s`;return `${Math.round(ms/60000)} min`}
function titleize(value){return String(value??'').split(/[-_]/).filter(Boolean).map((part)=>part[0]?.toUpperCase()+part.slice(1)).join(' ')||'Step'}
function labelize(value){return titleize(value).replace(/\bId\b/g,'ID')}
function safeText(value){return String(value??'').replace(/[\r\n\t]+/g,' ').slice(0,160)}
function previewText(value){return safeText(value).slice(0,220)}
function sanitizeSummary(value){if(!value||typeof value!=='object'||Array.isArray(value))return null;const output={};for(const [key,raw] of Object.entries(value)){if(/prompt|body|text|credential|token|secret|path|url|reasoning|sql/i.test(key))continue;if(typeof raw==='string'||typeof raw==='number'||typeof raw==='boolean')output[key]=safeText(raw);else if(Array.isArray(raw))output[key]=raw.slice(0,6).map((item)=>typeof item==='string'||typeof item==='number'||typeof item==='boolean'?safeText(item):'[object]');}return output}
function summaryInline(summary){if(!summary)return '-';const entries=Object.entries(summary);if(!entries.length)return '-';return entries.map(([key,value])=>`${labelize(key)}: ${Array.isArray(value)?value.join(', '):value}`).join('; ')}

function boot(){
  document.querySelector('#run-button').addEventListener('click',runDemo);
  document.querySelector('#reset-button').addEventListener('click',resetDemo);
  window.addEventListener('popstate',()=>{activeRunDetail=null;const runId=new URL(location.href).searchParams.get('run');if(currentRoute().id==='runs'&&runId)loadRunById(runId,{push:false});else render()});
  const runId=new URL(location.href).searchParams.get('run');
  load().then(()=>{if(runId)loadRunById(runId,{push:false})});
}

if (globalThis.document?.querySelector('#view-root')) boot();
