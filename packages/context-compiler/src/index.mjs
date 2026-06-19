import { prefixedId, nowIso, assertPlainObject } from '../../protocol/src/index.mjs';

export const COMPILER_VERSION = '0.2.0';
const STOP_WORDS = new Set(['a','an','and','are','as','at','be','by','for','from','in','is','it','of','on','or','that','the','this','to','with']);

export function estimateTokens(text) { return Math.max(1, Math.ceil(String(text ?? '').length / 4)); }
export function terms(value) {
  return new Set(String(value ?? '').toLowerCase().replace(/[^a-z0-9_:-]+/g,' ').split(/\s+/).filter(term => term.length > 1 && !STOP_WORDS.has(term)));
}
function overlapScore(query, record) {
  const q=terms(query), r=terms([record.text,...(record.tags??[]),...(record.relations??[])].join(' '));
  if (!q.size || !r.size) return 0;
  let matches=0; for (const term of q) if (r.has(term)) matches++;
  return matches / Math.sqrt(q.size*r.size);
}
function temporalScore(record, now) {
  const updated=Date.parse(record.updatedAt??record.observedAt??now.toISOString());
  if (!Number.isFinite(updated)) return 0;
  return Math.exp(-Math.max(0,(now.getTime()-updated)/86400000)/60);
}
function isTemporallyValid(record, now) {
  const from=record.validFrom?Date.parse(record.validFrom):-Infinity;
  const to=record.validTo?Date.parse(record.validTo):Infinity;
  return from <= now.getTime() && now.getTime() <= to;
}
function normalizeRecord(record) {
  assertPlainObject(record,'record');
  if (!record.id || !record.kind || !record.text) throw new Error('record requires id, kind, and text');
  return {scope:'workspace-private',status:'active',confidence:.5,authority:.5,tags:[],relations:[],source:'unknown',...record,tokens:Number.isInteger(record.tokens)?record.tokens:estimateTokens(record.text)};
}
function decision(item) {
  return {id:item.record.id,kind:item.record.kind,tokens:item.record.tokens,score:Number(item.score.toFixed(4)),reasonCodes:[...new Set(item.reasonCodes)],source:item.record.source,text:item.record.text};
}
function detectConflicts(records) {
  const groups=new Map();
  for (const record of records) {
    const key=record.metadata?.conflictKey; if (!key) continue;
    const values=groups.get(key)??[]; values.push({id:record.id,value:record.metadata.value,confidence:record.confidence}); groups.set(key,values);
  }
  return [...groups.entries()].filter(([,values])=>new Set(values.map(value=>JSON.stringify(value.value))).size>1).map(([key,values])=>({key,records:values,status:'unresolved'}));
}

export function compileContext(request,inputRecords) {
  assertPlainObject(request,'request');
  if (!request.objective || !request.step) throw new Error('objective and step are required');
  if (!Number.isInteger(request.tokenBudget) || request.tokenBudget < 1) throw new Error('tokenBudget must be positive');
  if (!Array.isArray(inputRecords)) throw new TypeError('records must be an array');
  const now=new Date(request.now??Date.now()); if (Number.isNaN(now.getTime())) throw new Error('now must be valid');
  const allowedScopes=new Set(request.allowedScopes??['public','workspace-private']);
  const requiredIds=new Set(request.requiredIds??[]), requiredEntities=new Set(request.requiredEntities??[]);
  const records=inputRecords.map(normalizeRecord), supersededIds=new Set(records.map(record=>record.supersedes).filter(Boolean));
  const excluded=[], eligible=[];
  for (const record of records) {
    const reasons=[];
    if (!allowedScopes.has(record.scope)) reasons.push('scope_denied');
    if (record.metadata?.retrieval?.candidateEligible===false) reasons.push('candidate_ineligible');
    if (['expired','retracted','quarantined','superseded'].includes(record.status)) reasons.push(`status_${record.status}`);
    if (supersededIds.has(record.id)) reasons.push('superseded_by_newer_record');
    if (!isTemporallyValid(record,now)) reasons.push('outside_valid_time');
    if (reasons.length) excluded.push({id:record.id,kind:record.kind,tokens:record.tokens,score:0,reasonCodes:reasons,source:record.source}); else eligible.push(record);
  }
  const query=`${request.objective} ${request.step} ${(request.requiredEntities??[]).join(' ')}`;
  const scored=eligible.map(record=>{
    const forced=requiredIds.has(record.id)||['policy','constraint'].includes(record.kind);
    const entityMatches=(record.relations??[]).filter(value=>requiredEntities.has(value)).length+(record.tags??[]).filter(value=>requiredEntities.has(value)).length;
    const lexical=overlapScore(query,record), recency=temporalScore(record,now);
    const confidence=Math.max(0,Math.min(1,Number(record.confidence??.5))), authority=Math.max(0,Math.min(1,Number(record.authority??.5)));
    const relation=Math.min(1,entityMatches/Math.max(1,requiredEntities.size));
    const retrieval=record.metadata?.retrieval??{};
    const importance=Math.max(0,Math.min(1,Number(record.importance??retrieval.importance??0)));
    const outcomeEvidence=Math.max(0,Math.min(1,Number(record.outcomeEvidence??retrieval.outcomeEvidence??0)));
    const retrievalPenalty=Math.max(0,Math.min(1,Number(record.retrievalPenalty??retrieval.retrievalPenalty??0)));
    const score=forced?1000:(lexical*5)+(relation*3)+authority+confidence+(recency*.75)+(importance*2.5)+(outcomeEvidence*1.5)-(retrievalPenalty*4);
    const reasonCodes=[];
    if (forced) reasonCodes.push(requiredIds.has(record.id)?'explicit_requirement':'forced_governance');
    if (lexical>0) reasonCodes.push('task_relevance');
    if (relation>0) reasonCodes.push('entity_relation');
    if (recency>.7) reasonCodes.push('recent');
    if (authority>=.8) reasonCodes.push('high_authority');
    if (confidence>=.8) reasonCodes.push('high_confidence');
    if (importance>=.7) reasonCodes.push('high_importance');
    if (outcomeEvidence>=.6) reasonCodes.push('outcome_evidence');
    if (retrievalPenalty>0) reasonCodes.push('retrieval_penalty');
    return {record,score,forced,relevant:lexical>0||relation>0,reasonCodes};
  }).sort((a,b)=>b.score-a.score||a.record.id.localeCompare(b.record.id));
  const selected=[], selectedKinds=new Map(); let used=0;
  for (const item of scored.filter(item=>item.forced)) {
    const tokens=item.record.tokens;
    if (used+tokens>request.tokenBudget) excluded.push({id:item.record.id,kind:item.record.kind,tokens,score:item.score,reasonCodes:['required_but_over_budget'],source:item.record.source});
    else { selected.push(decision(item)); used+=tokens; selectedKinds.set(item.record.kind,(selectedKinds.get(item.record.kind)??0)+1); }
  }
  const remaining=scored.filter(item=>!item.forced).map(item=>({...item,adjustedScore:item.score-((selectedKinds.get(item.record.kind)??0)*.35)})).sort((a,b)=>b.adjustedScore-a.adjustedScore||a.record.id.localeCompare(b.record.id));
  for (const item of remaining) {
    const tokens=item.record.tokens;
    if (!item.relevant||item.score<=.05) excluded.push({id:item.record.id,kind:item.record.kind,tokens,score:item.score,reasonCodes:['insufficient_relevance'],source:item.record.source});
    else if (used+tokens>request.tokenBudget) excluded.push({id:item.record.id,kind:item.record.kind,tokens,score:item.score,reasonCodes:['token_budget'],source:item.record.source});
    else { const picked=decision(item); picked.reasonCodes.push((selectedKinds.get(item.record.kind)??0)>0?'selected_despite_kind_overlap':'diversity_gain'); selected.push(picked); used+=tokens; selectedKinds.set(item.record.kind,(selectedKinds.get(item.record.kind)??0)+1); }
  }
  const requiredOverBudget=excluded.filter(item=>item.reasonCodes.includes('required_but_over_budget'));
  return {schemaVersion:'1.0.0',id:prefixedId('ctx'),workspaceId:request.workspaceId??'ws_local',requestId:request.id??null,compilerVersion:COMPILER_VERSION,createdAt:nowIso(),budget:{available:request.tokenBudget,used},selected,excluded:excluded.sort((a,b)=>a.id.localeCompare(b.id)),conflicts:detectConflicts(eligible),warnings:requiredOverBudget.length?['required_governance_exceeded_budget']:[]};
}
