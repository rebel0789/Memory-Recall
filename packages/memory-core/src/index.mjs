import { prefixedId, nowIso, assertPlainObject } from '../../protocol/src/index.mjs';

const SECRET_PATTERNS=[/sk-[A-Za-z0-9_-]{20,}/,/BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/,/AKIA[0-9A-Z]{16}/];
export function proposeMemory(input) {
  assertPlainObject(input,'memory proposal');
  if (!input.kind || !input.text || !input.source) throw new Error('kind, text, and source are required');
  const reasons=[];
  if (SECRET_PATTERNS.some(pattern=>pattern.test(input.text))) reasons.push('possible_secret');
  if (input.kind==='preference' && input.source!=='user-confirmed') reasons.push('user_confirmation_required');
  if (input.kind==='fact' && input.sourceTrust!=='verified') reasons.push('source_verification_required');
  if (input.stability==='transient') reasons.push('transient_not_durable');
  const decision=reasons.length?'review':'propose';
  return {schemaVersion:'1.0.0',id:prefixedId('mem'),workspaceId:input.workspaceId??'ws_local',kind:input.kind,text:input.text,source:input.source,status:'proposed',decision,reasons,confidence:Number(input.confidence??.5),retention:input.retention??'workspace-default',createdAt:nowIso(),supersedes:input.supersedes??null};
}
