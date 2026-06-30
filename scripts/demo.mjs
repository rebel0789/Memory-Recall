import { runContentIntelligence } from '../workflows/content-intelligence/runner.mjs';
const objective=process.argv.slice(2).join(' ')||undefined;
const result=await runContentIntelligence({objective});
const manifest=result.outputs?.['compile-context'];const generated=result.outputs?.['generate-angles'];
console.log(`Run ${result.runId}: ${result.status}`);console.log(`Objective: ${result.objective}`);
if(manifest){console.log(`Context: ${manifest.selected.length} selected, ${manifest.excluded.length} excluded, ${manifest.budget.used}/${manifest.budget.available} estimated tokens`);console.log(`Manifest: ${manifest.id} verification ${manifest.manifestVerification?.valid?'PASS':'FAIL'}`)}
for(const item of generated?.output??[])console.log(`\n${item.rank}. ${item.angle}\n   Hook: ${item.hook}\n   Evidence: ${item.evidenceIds.join(', ')}\n   Confidence: ${Math.round(item.confidence*100)}%`);
const verification=result.outputs?.['verify-recommendations'];console.log(`\nCitation verification: ${verification?.valid?'PASS':'FAIL'}`);
if(result.status!=='completed'||!verification?.valid)process.exitCode=1;
