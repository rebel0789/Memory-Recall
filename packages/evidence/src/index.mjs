import { createHash } from 'node:crypto';
import { assertPlainObject } from '../../protocol/src/index.mjs';
export function normalizeObservation(input) {
  assertPlainObject(input,'observation');
  for (const key of ['id','source','text','collectedAt']) if (!input[key]) throw new Error(`observation requires ${key}`);
  return {schemaVersion:'1.0.0',id:input.id,workspaceId:input.workspaceId??'ws_local',source:input.source,platform:input.platform??'unknown',creator:input.creator??'unknown',text:input.text,publishedAt:input.publishedAt??null,collectedAt:input.collectedAt,metricAt:input.metricAt??input.collectedAt,contentHash:createHash('sha256').update(input.text).digest('hex'),observed:input.observed??{},inferred:input.inferred??{},trust:input.trust??'untrusted-external'};
}
export function validateClaimCitations(claims, availableEvidenceIds) {
  const available=new Set(availableEvidenceIds), failures=[];
  for (const claim of claims) {
    if (!Array.isArray(claim.evidenceIds)||!claim.evidenceIds.length) failures.push({claimId:claim.id,reason:'missing_evidence'});
    else { const missing=claim.evidenceIds.filter(id=>!available.has(id)); if (missing.length) failures.push({claimId:claim.id,reason:'unavailable_evidence',missing}); }
  }
  return {valid:failures.length===0,failures};
}
