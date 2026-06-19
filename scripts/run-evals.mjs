import { readFile } from 'node:fs/promises';
import { compileContext } from '../packages/context-compiler/src/index.mjs';
import { evaluatePolicy } from '../packages/policy/src/index.mjs';
import { proposeMemory } from '../packages/memory-core/src/index.mjs';
let passed=0,failed=0;const check=(label,condition)=>{if(condition){console.log(`PASS ${label}`);passed++}else{console.error(`FAIL ${label}`);failed++}};
const contextCases=JSON.parse(await readFile('evals/context-selection/cases.json','utf8'));
for(const test of contextCases){const result=compileContext(test.request,test.records),selected=new Set(result.selected.map(item=>item.id)),excluded=new Set(result.excluded.map(item=>item.id));check(`${test.id}: required selections`,test.expect.selected.every(id=>selected.has(id)));check(`${test.id}: required exclusions`,test.expect.excluded.every(id=>excluded.has(id)));check(`${test.id}: token budget`,result.budget.used<=result.budget.available);check(`${test.id}: conflict count`,result.conflicts.length===test.expect.conflicts)}
const policyCases=JSON.parse(await readFile('evals/policy/cases.json','utf8'));for(const test of policyCases){const result=evaluatePolicy(test.input);check(`${test.id}: decision`,result.decision===test.expect.decision);check(`${test.id}: reasons`,test.expect.reasons.every(reason=>result.reasons.includes(reason)))}
const memoryCases=JSON.parse(await readFile('evals/memory/cases.json','utf8'));for(const test of memoryCases){const result=proposeMemory(test.input);check(`${test.id}: decision`,result.decision===test.expect.decision);check(`${test.id}: reasons`,test.expect.reasons.every(reason=>result.reasons.includes(reason)))}
console.log(`\nEvaluation result: ${passed} passed, ${failed} failed.`);if(failed)process.exitCode=1;
