const templates=[
 {angle:'Turn one agent failure into a checklist people can reuse',hook:'The polished demo was not the useful part. The recovery checklist was.',evidenceTerms:['failed tool','retries','recovery','checklist','reproducing','most saved'],confidence:.82},
 {angle:'The strongest agent story may be the most boring workflow',hook:'Agents become understandable when they automate one repetitive job end to end.',evidenceTerms:['boring','workflow','support triage','inbox','local-first','on-device'],confidence:.79},
 {angle:'Show the failed tool calls—not just the polished agent demo',hook:'A trustworthy agent demo should show what it refused, retried, and excluded.',evidenceTerms:['timeline','debugging','selected context','policy decision','failed step','denied permissions'],confidence:.77}
];

function evidenceScore(item,terms) {
  const text=String(item.text??'').toLowerCase();
  return terms.reduce((score,term)=>score+(text.includes(term)?1:0),0)+(Number(item.score)||0)/100;
}
function selectEvidence(evidence,terms,count=2) {
  return [...evidence].sort((a,b)=>evidenceScore(b,terms)-evidenceScore(a,terms)||a.id.localeCompare(b.id)).slice(0,count).map(item=>item.id);
}

export class DeterministicModel {
  name='deterministic-v1';
  capabilities={structuredOutput:true,tools:false,vision:false,network:false};
  async generate({objective,context}) {
    const evidence=context.selected.filter(item=>item.kind==='observation');
    if (evidence.length<2) throw new Error('At least two selected observations are required for deterministic recommendations');
    const output=templates.map((template,index)=>({
      rank:index+1,
      angle:template.angle,
      hook:template.hook,
      targetReader:'builders shipping reliable local agents',
      whyNow:objective,
      evidenceIds:selectEvidence(evidence,template.evidenceTerms),
      proofNeeded:'A concrete run trace or workflow result',
      copyingRisk:'low: mechanism only',
      confidence:template.confidence,
      uncertainty:'Synthetic fixtures and deterministic generation; validate with real evidence before publication.'
    }));
    return {model:this.name,provider:'local-bootstrap',output,usage:{inputEstimated:context.budget.used,outputEstimated:Math.ceil(JSON.stringify(output).length/4)},validated:true};
  }
}
export function modelFromEnv(env=process.env) {
  const mode=env.OAF_MODEL_MODE??'deterministic';
  if (mode==='deterministic') return new DeterministicModel();
  throw new Error(`Model mode ${mode} is specified but not implemented in the bootstrap. No cloud fallback occurred.`);
}
