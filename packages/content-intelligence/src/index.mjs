const clamp = value => Math.max(0, Math.min(1, Number(value) || 0));
const ANTI_PATTERNS = new Set(['generic prediction', 'absolute claim']);
const INELIGIBLE_PATTERNS = new Set(['unrelated']);
const SPECIFIC_TERMS = ['workflow','checklist','retries','recovery','experiment','test','timeline','debugging','on-device','local-first','permissions','evidence','cited','reproducing','six-step'];
const EVIDENCE_TERMS = ['got more','most saved','beat a','cut our','earned trust','helped only after','understood fastest','automated one','showing','result','replies','saves'];

function containsAny(text, phrases) {
  const lower=String(text??'').toLowerCase();
  return phrases.reduce((count, phrase)=>count+(lower.includes(phrase)?1:0),0);
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
  const outcomeEvidence=clamp((containsAny(text,EVIDENCE_TERMS)/2)+((replies||saves)?.15:0));
  const candidateEligible=!INELIGIBLE_PATTERNS.has(pattern);
  const antiPattern=ANTI_PATTERNS.has(pattern);
  const retrievalPenalty=antiPattern?.9:(candidateEligible?0:1);
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
