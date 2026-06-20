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
  return `<section class="surface"><div class="section-heading"><h2>Run history</h2><span>Deep links and sanitized traces</span></div>${runList(dashboard?.runs)}</section>`;
}

function renderRunDetail(data) {
  return `<section class="work-grid"><div class="surface surface-primary"><div class="section-heading"><h2>${esc(data.run.workflowId)}</h2>${statusChip(data.run.status,data.run.status,'Run status')}</div><p>${esc(data.run.objective)}</p>${angles(data.run.output?.output)}${data.run.verification?.valid?'<p class="verified-note"><strong>Evidence references verified</strong><span>Checked against selected context.</span></p>':''}</div><aside class="inspector"><div class="section-heading"><h2>Event timeline</h2><span>${data.events.length} events</span></div>${timeline(data.events)}</aside></section>`;
}

function renderWorkflows() {
  const steps=['collect','normalize','analyze-patterns','compile-context','generate-angles','verify-recommendations','local-draft-outcome'];
  return `<section class="work-grid"><div class="surface surface-primary"><div class="section-heading"><h2>Content Intelligence</h2><span>workflow:content-intelligence</span></div><ol class="outline">${steps.map((step,index)=>`<li><span>${index+1}</span><strong>${step}</strong><em>${workflowStepCopy(step)}</em></li>`).join('')}</ol></div><aside class="inspector"><h2>Equivalent outline</h2><p>Graph information is presented as an ordered list for keyboard and screen-reader access.</p><dl class="facts"><div><dt>Risk</dt><dd>Read-only/local-only outputs</dd></div><div><dt>Timeout</dt><dd>5s deterministic steps, 120s model step</dd></div><div><dt>Approval</dt><dd>Local candidate approval record only</dd></div></dl></aside></section>`;
}

function renderContext() {
  const manifest=dashboard?.latestManifest;
  if(!manifest)return statePanel('empty','No context manifest yet','Run the local workflow to inspect selected and excluded records.',true);
  return `<section class="work-grid"><div class="surface surface-primary"><div class="section-heading"><h2>Selected context</h2><span>${manifest.selected.length} records</span></div>${manifestList(manifest.selected)}</div><aside class="inspector"><div class="section-heading"><h2>Excluded</h2><span>${manifest.excluded.length} records</span></div>${manifestList(manifest.excluded)}<hr>${contextSummary(manifest)}</aside></section>`;
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
function runList(items){if(!items?.length)return statePanel('empty','No runs yet','Execute the synthetic local workflow to populate the event ledger.',true);return `<div class="run-list">${items.map(run=>`<article class="run-row"><header><a href="/runs?run=${encodeURIComponent(run.id)}" data-run-id="${esc(run.id)}">${esc(run.workflowId)}</a>${statusChip(run.status,run.status,'Run status')}</header><p>${esc(run.objective??'')}</p><div class="meta-row"><code>${esc(run.id)}</code><span>${date(run.createdAt)}</span></div></article>`).join('')}</div>`}
function contextSummary(manifest){if(!manifest)return '<div class="state-inline">No context has been compiled.</div>';const percent=Math.min(100,Math.round(manifest.budget.used/manifest.budget.available*100));return `<div class="section-heading"><h2>Context budget</h2><span>${percent}% used</span></div><strong>${manifest.budget.used} / ${manifest.budget.available} estimated tokens</strong><div class="progress" aria-label="${percent}% of context budget used"><span style="width:${percent}%"></span></div><p class="muted">${manifest.selected.length} selected · ${manifest.excluded.length} excluded · ${manifest.conflicts.length} conflicts</p>`}
function manifestList(items){if(!items?.length)return '<p class="muted">None.</p>';return `<div class="manifest-list">${items.map(item=>`<article class="manifest-row"><header><code>${esc(item.id)}</code><span>${item.tokens} tokens</span></header>${item.text?`<p>${esc(item.text)}</p>`:''}${reasons(item.reasonCodes)}</article>`).join('')}</div>`}
function angles(items){if(!Array.isArray(items)||!items.length)return statePanel('empty','No candidates yet','Run the demo to generate evidence-backed candidates.');return `<div class="angle-list">${items.map(item=>`<article class="angle-row"><h3>${esc(item.angle)}</h3><p>${esc(item.hook)}</p><div class="meta-row"><span>Evidence: ${item.evidenceIds.map(esc).join(', ')||'none'}</span><span>Confidence: ${Math.round(Number(item.confidence??0)*100)}%</span></div></article>`).join('')}</div>`}
function timeline(events){if(!events?.length)return '<p class="muted">No events recorded.</p>';return `<div class="timeline">${events.map(item=>`<article class="event"><span class="event-marker" aria-hidden="true"></span><div><h3>${esc(item.type)}</h3><p>${date(item.occurredAt)} · ${esc(item.actorId)}</p></div></article>`).join('')}</div>`}
function reasons(items=[]){return `<div class="reason-list">${items.map(reason=>`<span class="reason">${esc(reason)}</span>`).join('')}</div>`}
function workflowStepCopy(step){return ({collect:'read bounded local/caller-supplied sources',normalize:'separate observed data from inference','analyze-patterns':'compute lifecycle and copying risk','compile-context':'persist selected/excluded context manifest','generate-angles':'schema-validated local model output','verify-recommendations':'citation verification','local-draft-outcome':'local approval, draft, and outcome record'})[step] ?? 'deterministic step'}

function navigate(event) {
  event.preventDefault();
  activeRunDetail=null;
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
  const id=event.currentTarget.dataset.runId;
  history.pushState({},'',`/runs?run=${encodeURIComponent(id)}`);
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

function boot(){
  document.querySelector('#run-button').addEventListener('click',runDemo);
  document.querySelector('#reset-button').addEventListener('click',resetDemo);
  window.addEventListener('popstate',()=>{activeRunDetail=null;render()});
  const runId=new URL(location.href).searchParams.get('run');
  load().then(()=>{if(runId)document.querySelector(`[data-run-id="${CSS.escape(runId)}"]`)?.click()});
}

if (globalThis.document?.querySelector('#view-root')) boot();
