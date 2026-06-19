import { readFile } from 'node:fs/promises';
import {
  compileContext,
  compileContextFromSources,
  createCandidateSourceRegistry,
  createFixtureRecordReader,
  createNativeExactCandidateSource,
  createNativeLexicalCandidateSource
} from '../packages/context-compiler/src/index.mjs';
import { createPolicyService } from '../packages/policy/src/index.mjs';
import { evaluatePolicy } from '../packages/policy/src/index.mjs';
import { proposeMemory } from '../packages/memory-core/src/index.mjs';
let passed=0,failed=0;const check=(label,condition)=>{if(condition){console.log(`PASS ${label}`);passed++}else{console.error(`FAIL ${label}`);failed++}};
const contextCases=JSON.parse(await readFile('evals/context-selection/cases.json','utf8'));
for(const test of contextCases){
  const result=test.mode==='sources'
    ? await compileContextFromSources(test.request,{registry:createCandidateSourceRegistry([createNativeExactCandidateSource(),createNativeLexicalCandidateSource()]),recordReader:createFixtureRecordReader(test.records),policyService:createPolicyService({decisionIdFactory:()=>test.policyDecisionId??'poldet_eval_allow',clock:()=>test.request.now??test.request.trustedTimestamp??new Date().toISOString()}),trustedContext:test.trustedContext})
    : {manifest:compileContext(test.request,test.records),candidateGeneration:null,selection:null};
  const manifest=result.manifest,selection=result.selection??manifest.selection,selectedIds=manifest.selected.map(item=>item.id),excludedIds=manifest.excluded.map(item=>item.id),selected=new Set(selectedIds),excluded=new Set(excludedIds);
  check(`${test.id}: required selections`,test.expect.selected.every(id=>selected.has(id)));
  check(`${test.id}: required exclusions`,test.expect.excluded.every(id=>excluded.has(id)));
  check(`${test.id}: token budget`,manifest.budget.used<=manifest.budget.available);
  check(`${test.id}: conflict count`,manifest.conflicts.length===test.expect.conflicts);
  if(test.expect.selectedOrder)check(`${test.id}: selected order`,JSON.stringify(selectedIds)===JSON.stringify(test.expect.selectedOrder));
  if(test.expect.excludedReasons)for(const [id,reasons]of Object.entries(test.expect.excludedReasons)){const item=manifest.excluded.find(entry=>entry.id===id);check(`${test.id}: ${id} exclusion reasons`,!!item&&reasons.every(reason=>item.reasonCodes.includes(reason)))}
  if(test.expect.sufficiencyState)check(`${test.id}: sufficiency`,selection?.sufficiency?.state===test.expect.sufficiencyState);
  if(test.expect.selectionPolicyFingerprint)check(`${test.id}: policy fingerprint`,/^sha256:[a-f0-9]{64}$/.test(selection?.selectionPolicyFingerprint??''));
  if(test.expect.resultFingerprint)check(`${test.id}: result fingerprint`,/^sha256:[a-f0-9]{64}$/.test(selection?.resultFingerprint??''));
  if(test.expect.noPendingScoreStates)check(`${test.id}: score states`,selection?.scoreBreakdowns?.every(item=>['selected','excluded'].includes(item.selectedOrExcluded))===true);
  if(test.expect.warnings)check(`${test.id}: warnings`,JSON.stringify(result.selection?.warnings??manifest.warnings??[])===JSON.stringify(test.expect.warnings));
  if(test.expect.candidateWarnings)check(`${test.id}: candidate warnings`,JSON.stringify(result.candidateGeneration?.warnings??[])===JSON.stringify(test.expect.candidateWarnings));
  if(test.expect.coverageSelected)check(`${test.id}: coverage selected`,test.expect.coverageSelected.every(entity=>selection?.coverage?.selected?.includes(entity)));
}
const policyCases=JSON.parse(await readFile('evals/policy/cases.json','utf8'));for(const test of policyCases){const result=evaluatePolicy(test.input);check(`${test.id}: decision`,result.decision===test.expect.decision);check(`${test.id}: reasons`,test.expect.reasons.every(reason=>result.reasons.includes(reason)))}
const memoryCases=JSON.parse(await readFile('evals/memory/cases.json','utf8'));for(const test of memoryCases){const result=proposeMemory(test.input);check(`${test.id}: decision`,result.decision===test.expect.decision);check(`${test.id}: reasons`,test.expect.reasons.every(reason=>result.reasons.includes(reason)))}
console.log(`\nEvaluation result: ${passed} passed, ${failed} failed.`);if(failed)process.exitCode=1;
