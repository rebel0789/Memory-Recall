import test from 'node:test';import assert from 'node:assert/strict';import { spawnSync } from 'node:child_process';import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';import os from 'node:os';import path from 'node:path';import contextPackHandoffReportSchema from '../packages/protocol/schemas/context-pack-handoff-report.schema.json' with { type: 'json' };import contextPackMeasurementReportSchema from '../packages/protocol/schemas/context-pack-measurement-report.schema.json' with { type: 'json' };import contextPackReceiveReportSchema from '../packages/protocol/schemas/context-pack-receive-report.schema.json' with { type: 'json' };import { assertJsonSchema } from '../packages/protocol/src/schema-validator.mjs';import { SQLiteMemoryProvider } from '../providers/native/memory-sqlite/src/index.mjs';
test('CLI help documents MCP token-saver server',()=>{const result=spawnSync(process.execPath,['apps/cli/oaf.mjs','help'],{encoding:'utf8'});assert.equal(result.status,0);assert.match(result.stdout,/oaf mcp server --read-only --root \. --stdio/)});
test('CLI help documents MCP token-saver install',()=>{const result=spawnSync(process.execPath,['apps/cli/oaf.mjs','help'],{encoding:'utf8'});assert.equal(result.status,0);assert.match(result.stdout,/oaf mcp install --client claude-code --dry-run --format json/)});
test('CLI help is local and documents core commands',()=>{const result=spawnSync(process.execPath,['apps/cli/oaf.mjs','help'],{encoding:'utf8'});assert.equal(result.status,0);assert.match(result.stdout,/oaf task <OAF-ID>/);assert.match(result.stdout,/Run oaf task only when npm run status names a next task/);assert.match(result.stdout,/oaf demo memory-loop --root \. --format json/);assert.match(result.stdout,/oaf context scan --from codex --root \. --dry-run/);assert.match(result.stdout,/oaf context preview --from codex --root \. --objective/);assert.match(result.stdout,/oaf context pack .*--changed src\/auth\.ts .*--changed-from-git/);assert.match(result.stdout,/oaf context handoff --read-only --from codex --root \./);assert.match(result.stdout,/--memory-config oaf\.memory\.json/);assert.match(result.stdout,/oaf context receive --read-only --root \. --target codex --format json/);assert.match(result.stdout,/oaf context registry status --read-only --format json/);assert.match(result.stdout,/oaf context graph preview --root \. --query/);assert.match(result.stdout,/oaf loop plan --read-only --root \./);assert.match(result.stdout,/oaf loop observe --root \. --plan .*--execute-commands/);assert.match(result.stdout,/oaf loop verify --root \. --plan .*--execute-commands/);assert.match(result.stdout,/oaf measure savings --read-only --root \./);assert.match(result.stdout,/oaf measure context-pack --read-only --root \./);assert.match(result.stdout,/impact brief/);assert.match(result.stdout,/--format summary/);assert.match(result.stdout,/oaf benchmark truth-floor --suite benchmark-truth-floor --dataset evals\/benchmark-truth-floor\/cases.v1.json --format json/);assert.match(result.stdout,/oaf memory ingest --root \. --sqlite \.local\/memory\.sqlite/);assert.match(result.stdout,/oaf memory sgrep "context manifest"/);assert.match(result.stdout,/oaf memory fact add --sqlite \.local\/memory\.sqlite/);assert.match(result.stdout,/oaf memory fact get --sqlite \.local\/memory\.sqlite/);assert.match(result.stdout,/oaf memory fact history --sqlite \.local\/memory\.sqlite/);assert.match(result.stdout,/oaf mcp resources --read-only/);assert.match(result.stdout,/oaf mcp smoke context-pack/);assert.match(result.stdout,/oaf harness setup status --client codex --dry-run --format json/);assert.match(result.stdout,/oaf harness setup plan --client cursor --server oaf --dry-run --format json/);assert.match(result.stdout,/oaf harness setup uninstall --client cursor --server oaf --dry-run --format json/);assert.match(result.stdout,/no external writes/i)});
test('demo memory-loop runs native profile plan observe proposal and fact flow',()=>{const env={...process.env,OAF_FIXED_NOW:'2026-06-26T10:00:00.000Z'};const result=spawnSync(process.execPath,['apps/cli/oaf.mjs','demo','memory-loop','--root','.','--format','json'],{encoding:'utf8',env});assert.equal(result.status,0,result.stderr);const report=JSON.parse(result.stdout);assert.equal(report.command,'demo memory-loop');assert(report.compressedProfile.contextBudget.estimatedDeliveryTokens>0);assert.equal(report.loopPlan.contextBudget.estimatedDeliveryTokens,report.compressedProfile.contextBudget.estimatedDeliveryTokens);assert.equal(report.savings.beforeDeliveryTokens,report.compressedProfile.contextBudget.historyTokensAvailable);assert.equal(report.savings.afterDeliveryTokens,report.compressedProfile.contextBudget.estimatedDeliveryTokens);assert(report.savings.percent>0);assert.equal(report.savings.savings.providerBillingClaimed,false);assert.equal(report.observation.status,'passed');assert.equal(report.extractionProposal.status,'applied');assert.equal(report.memoryFact.id,'memfact_demo_memory_loop');assert.equal(report.memoryFact.validity.validFrom,'2026-06-26T10:00:00.000Z');assert.deepEqual(report.remembered,['project:oaf memory_loop connected']);assert.deepEqual(report.superseded,[]);assert.equal(report.safeguards.localOnly,true);assert.equal(report.safeguards.networkCalls,0);assert.equal(report.safeguards.modelCalls,0)});
test('demo memory-loop npm script prints token saving remembered and superseded facts',()=>{const env={...process.env,OAF_FIXED_NOW:'2026-06-26T10:00:00.000Z'};const result=spawnSync('npm',['run','demo:memory-loop'],{encoding:'utf8',env});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Memory loop token saving: \d+%/);assert.match(result.stdout,/Before\/after delivery tokens: \d+ -> \d+/);assert.match(result.stdout,/Remembered: project:oaf memory_loop connected/);assert.match(result.stdout,/Superseded: memfact_demo_memory_loop_previous -> memfact_demo_memory_loop/);assert.match(result.stdout,/Observation: passed/);assert.equal(result.stdout.includes('network'),false)});
test('measure savings reports real SQLite before and after delivery tokens without writes', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaf-cli-measure-savings-'));
  mkdirSync(path.join(root, '.local'), { recursive: true });
  mkdirSync(path.join(root, 'docs', 'product'), { recursive: true });
  mkdirSync(path.join(root, 'docs', 'superpowers', 'plans'), { recursive: true });
  mkdirSync(path.join(root, 'apps', 'cli'), { recursive: true });
  writeFileSync(path.join(root, 'AGENTS.md'), `${Array(500).fill('REALISTIC_BASELINE_RAW_BODY agent memory mcp context profile').join(' ')}`);
  writeFileSync(path.join(root, 'README.md'), `${Array(450).fill('REALISTIC_BASELINE_RAW_BODY readme token saver workspace').join(' ')}`);
  writeFileSync(path.join(root, 'docs', 'product', 'loop-workbench-build-plan.md'), `${Array(420).fill('REALISTIC_BASELINE_RAW_BODY loop workbench checkpoint protocol').join(' ')}`);
  writeFileSync(path.join(root, 'docs', 'superpowers', 'plans', '2026-06-26-mcp-token-saver.md'), `${Array(420).fill('REALISTIC_BASELINE_RAW_BODY mcp token saver context profile benchmark').join(' ')}`);
  writeFileSync(path.join(root, 'apps', 'cli', 'oaf.mjs'), `${Array(420).fill('REALISTIC_BASELINE_RAW_BODY cli memory recall context profile').join(' ')}`);
  spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' });
  spawnSync('git', ['add', '.'], { cwd: root, encoding: 'utf8' });
  spawnSync('git', ['-c', 'user.name=OAF Test', '-c', 'user.email=oaf@example.invalid', 'commit', '-m', 'realistic savings commit', '-m', `${Array(120).fill('REALISTIC_HISTORY_RAW_BODY').join(' ')}`], { cwd: root, encoding: 'utf8' });
  const sqlitePath = path.join(root, '.local', 'memory.sqlite');
  const provider = new SQLiteMemoryProvider({ filename: sqlitePath, clock: () => '2026-06-26T10:00:00.000Z' });
  await provider.put({
    id: 'mem_savings_profile',
    workspaceId: 'ws_local',
    kind: 'decision',
    text: `${Array(120).fill('measure-savings').join(' ')} SAVINGS_RAW_BODY should stay hidden.`,
    source: 'workspace://docs/savings.md',
    status: 'active',
    confidence: 0.9,
    authority: 0.9,
    updatedAt: '2026-06-26T09:55:00.000Z'
  });
  await provider.enqueueProposal({
    id: 'mpq_savings_fact',
    workspaceId: 'ws_local',
    sourceLocator: 'workspace://docs/savings.md',
    sourceHash: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    payload: { kind: 'fact', subject: 'project:oaf', predicate: 'measure_savings', object: 'ready' }
  });
  await provider.claimProposal({ workspaceId: 'ws_local', workerId: 'savings-test', leaseUntil: '2026-06-26T10:05:00.000Z' });
  await provider.recordProposalResult({ workspaceId: 'ws_local', id: 'mpq_savings_fact', workerId: 'savings-test', status: 'applied', result: { accepted: true } });
  await provider.addTemporalFact({
    id: 'memfact_savings_ready',
    workspaceId: 'ws_local',
    scope: 'workspace',
    subject: 'project:oaf',
    predicate: 'measure_savings',
    object: 'ready',
    text: `${Array(80).fill('measure-savings-ready').join(' ')} temporal fact body should stay out.`,
    source: 'workspace://docs/savings.md',
    proposalQueueId: 'mpq_savings_fact',
    validFrom: '2026-06-26T10:00:00.000Z'
  });
  provider.close();
  const beforeMtime = statSync(sqlitePath).mtimeMs;
  const env = { ...process.env, OAF_FIXED_NOW: '2026-06-26T10:00:00.000Z' };
  const args = ['apps/cli/oaf.mjs', 'measure', 'savings', '--read-only', '--root', root, '--objective', 'measure savings ready', '--step', 'compare compressed profile', '--format', 'json'];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.command, 'measure savings');
  assert.equal(report.measurementScope, 'realistic local context.profile delivery-token benchmark');
  assert.equal(report.source.provider, 'real-workspace-candidate-bodies');
  assert.equal(report.source.memory.provider, 'provider:native:memory:sqlite');
  assert.equal(report.source.memory.sqliteRef, 'workspace://.local/memory.sqlite');
  assert(report.source.candidateFileCount >= 5);
  assert(report.source.candidateBodyTokens > 2000);
  if (report.realisticBenchmark.gitHistory.available) {
    assert(report.source.historyCommitCount >= 1);
    assert(report.source.historyBodyTokens > 0);
  }
  assert(report.baseline.deliveryTokens > report.compressed.deliveryTokens);
  assert.equal(report.compressed.basis, 'estimated tokens over exact context.profile JSON payload text');
  assert.equal(report.beforeDeliveryTokens, report.baseline.deliveryTokens);
  assert.equal(report.afterDeliveryTokens, report.compressed.deliveryTokens);
  assert.equal(report.tokensSaved, report.baseline.deliveryTokens - report.compressed.deliveryTokens);
  assert(report.savings.percent > 0);
  assert.equal(report.savings.providerBillingClaimed, false);
  assert.equal(report.safeguards.rawSourceBodiesIncluded, false);
  assert.equal(report.safeguards.rawGitHistoryIncluded, false);
  assert.equal(report.realisticBenchmark.candidateFiles.some((item) => item.locator === 'workspace://AGENTS.md'), true);
  assert.match(report.reportFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(statSync(sqlitePath).mtimeMs, beforeMtime);
  for (const forbidden of ['SAVINGS_RAW_BODY', 'temporal fact body', 'REALISTIC_BASELINE_RAW_BODY', 'REALISTIC_HISTORY_RAW_BODY', root, '/Users/rebel']) assert.equal(result.stdout.includes(forbidden), false, forbidden);
  const summary = spawnSync(process.execPath, [...args.slice(0, -1), 'summary'], { encoding: 'utf8', env });
  assert.equal(summary.status, 0, summary.stderr);
  assert.match(summary.stdout, /Realistic token saving: \d+%/);
  assert.match(summary.stdout, /Before delivery tokens: \d+/);
  assert.match(summary.stdout, /After delivery tokens: \d+/);
  assert.match(summary.stdout, /Basis: delivery-token estimate, not provider billing/);
  assert.equal(summary.stdout.includes('SAVINGS_RAW_BODY'), false);
});
test('CLI help documents loop run and schedule',()=>{const result=spawnSync(process.execPath,['apps/cli/oaf.mjs','help'],{encoding:'utf8'});assert.equal(result.status,0);assert.match(result.stdout,/oaf loop run --root \. --plan .*--execute-commands/);assert.match(result.stdout,/oaf loop schedule --read-only --root \./)});
test('CLI rejects unknown commands',()=>{const result=spawnSync(process.execPath,['apps/cli/oaf.mjs','wat'],{encoding:'utf8'});assert.equal(result.status,2);assert.match(result.stderr,/Unknown command/)});
test('task command prints stop condition',()=>{const result=spawnSync(process.execPath,['apps/cli/oaf.mjs','task','OAF-004'],{encoding:'utf8'});assert.equal(result.status,0);assert.match(result.stdout,/Stop condition/)});
test('context scan dry-run reports sanitized harness sources',()=>{const root=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-harness-'));writeFileSync(path.join(root,'AGENTS.md'),'Run npm run ci. token=secret-value. See /Users/rebel/private.txt');const result=spawnSync(process.execPath,['apps/cli/oaf.mjs','context','scan','--from','codex','--root',root,'--dry-run'],{encoding:'utf8'});assert.equal(result.status,0);const report=JSON.parse(result.stdout);assert.equal(report.summary.totalAccepted,1);assert.equal(report.summary.externalAdaptersEnabled,0);assert.equal(report.summary.externalWritesEnabled,false);assert(!result.stdout.includes('secret-value'));assert(!result.stdout.includes('/Users/rebel/private.txt'))});
test('context scan rejects non-dry-run mode',()=>{const root=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-harness-'));writeFileSync(path.join(root,'AGENTS.md'),'Run npm run ci.');const result=spawnSync(process.execPath,['apps/cli/oaf.mjs','context','scan','--from','codex','--root',root],{encoding:'utf8'});assert.equal(result.status,2);assert.match(result.stderr,/--dry-run is required/)});
test('context preview dry-run reports sanitized compiler decisions',()=>{const root=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-harness-preview-'));writeFileSync(path.join(root,'AGENTS.md'),'Context preview CLI should select this manifest guidance. token=secret-value. See /Users/rebel/private.txt');const result=spawnSync(process.execPath,['apps/cli/oaf.mjs','context','preview','--from','codex','--root',root,'--objective','context preview manifest','--step','select manifest guidance','--token-budget','80','--dry-run'],{encoding:'utf8'});assert.equal(result.status,0);const preview=JSON.parse(result.stdout);assert.equal(preview.safeguards.persisted,false);assert.equal(preview.safeguards.modelCalls,0);assert.equal(preview.safeguards.externalAdaptersEnabled,0);assert.equal(preview.manifest.selected.every(item=>!Object.hasOwn(item,'text')),true);assert(!result.stdout.includes('Context preview CLI should select'));assert(!result.stdout.includes('secret-value'));assert(!result.stdout.includes('/Users/rebel/private.txt'))});
test('context preview rejects non-dry-run mode',()=>{const root=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-harness-preview-'));writeFileSync(path.join(root,'AGENTS.md'),'Run npm run ci.');const result=spawnSync(process.execPath,['apps/cli/oaf.mjs','context','preview','--from','codex','--root',root,'--objective','ci','--step','select'],{encoding:'utf8'});assert.equal(result.status,2);assert.match(result.stderr,/context preview --dry-run is required/)});
test('context pack dry-run emits markdown handoff without raw source bodies',()=>{const root=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-context-pack-'));mkdirSync(path.join(root,'src'),{recursive:true});writeFileSync(path.join(root,'AGENTS.md'),'CLI PACK RAW BODY should not be copied into the handoff.');writeFileSync(path.join(root,'src','auth.ts'),['export function changedAuthSymbol() {',"  return 'CLI CHANGED RAW BODY';",'}'].join('\n'));const result=spawnSync(process.execPath,['apps/cli/oaf.mjs','context','pack','--from','codex','--root',root,'--objective','handoff next agent changed auth symbol','--step','select useful context','--target','codex','--changed','src/auth.ts','--token-budget','80','--dry-run','--format','markdown'],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/# Context Pack/);assert.match(result.stdout,/Target harness: codex/);assert.match(result.stdout,/workspace:\/\/AGENTS\.md/);assert.match(result.stdout,/## Launch Prompt/);assert.match(result.stdout,/## Utility Read Plan/);assert.match(result.stdout,/Changed locator coverage: 1\/1/);assert.match(result.stdout,/Content Hash/);assert.match(result.stdout,/content_hash_verified/);assert.match(result.stdout,/sha256:[a-f0-9]{64}/);assert.match(result.stdout,/Complete command set: \d+ commands in structured pack data/);assert.match(result.stdout,/npm run doctor/);assert.match(result.stdout,/npm run oaf -- context registry status --read-only --format json/);assert.match(result.stdout,/npm run ci/);assert.match(result.stdout,/## Bridge Commands/);assert.match(result.stdout,/npm run oaf -- context pack --from 'codex'.*--write --pin --out context-packs\/CONTEXT_PACK\.md --format json/);assert.match(result.stdout,/npm run oaf -- context receive --read-only --root \. --target codex --format json/);assert.match(result.stdout,/npm --silent run oaf -- mcp resources --read-only --stdio/);assert.match(result.stdout,/context-pack\/registry\/current/);assert.match(result.stdout,/context-pack\/use-plan\/current/);assert.match(result.stdout,/harness setup plan --client codex --server oaf --dry-run --format json/);assert.doesNotMatch(result.stdout,/<objective>|<step>/);assert.match(result.stdout,/## Change Impact/);assert.match(result.stdout,/workspace:\/\/src\/auth\.ts/);assert.match(result.stdout,/changedAuthSymbol/);assert.doesNotMatch(result.stdout,/CLI PACK RAW BODY/);assert.doesNotMatch(result.stdout,/CLI CHANGED RAW BODY/)});
test('context pack can opt into read-only local git changed-file detection',()=>{const root=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-context-pack-git-'));mkdirSync(path.join(root,'src'),{recursive:true});mkdirSync(path.join(root,'secrets'),{recursive:true});const git=spawnSync('git',['init'],{cwd:root,encoding:'utf8'});if(git.status!==0)return;writeFileSync(path.join(root,'AGENTS.md'),'Git detection should keep raw AGENTS body hidden.');writeFileSync(path.join(root,'src','auth.ts'),['export function gitDetectedChangedAuthSymbol() {',"  return 'GIT DETECTED RAW BODY';",'}'].join('\n'));writeFileSync(path.join(root,'.env'),'OAF_GIT_SECRET=secret-value');writeFileSync(path.join(root,'secrets','token.ts'),'export const token = "secret";');const result=spawnSync(process.execPath,['apps/cli/oaf.mjs','context','pack','--from','codex','--root',root,'--objective','git detected changed auth symbol','--step','detect changed locators','--target','codex','--changed-from-git','--token-budget','4096','--dry-run','--format','json'],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);const report=JSON.parse(result.stdout);assert.equal(report.changedLocatorDetection.status,'available');assert.equal(report.changedLocatorDetection.safeguards.readOnly,true);assert.equal(report.changedLocatorDetection.safeguards.networkCalls,0);assert.equal(report.changedLocatorDetection.safeguards.modelCalls,0);assert.equal(report.changedLocatorDetection.safeguards.externalWritesEnabled,false);assert.equal(report.changedLocatorDetection.changedLocators.includes('workspace://src/auth.ts'),true);assert.equal(report.changedLocatorDetection.changedLocators.some(locator=>locator.includes('.env')||locator.includes('secrets/')),false);assert.equal(report.pack.sourceGraph.impact.changedLocators.includes('workspace://src/auth.ts'),true);assert.equal(report.pack.sourceGraph.impact.representedChangedLocators.includes('workspace://src/auth.ts'),true);assert.equal(report.pack.utility.status,'review');assert.equal(report.pack.utility.changedLocatorCoverage.total,report.changedLocatorDetection.changedLocators.length);assert.equal(report.pack.utility.changedLocatorCoverage.covered,report.pack.sourceGraph.impact.representedChangedLocators.length);assert.equal(report.pack.utility.changedLocatorCoverage.status,'partial');const changedRead=report.pack.utility.requiredLocalReads.find(item=>item.locator==='workspace://src/auth.ts'&&item.role==='changed_locator');assert(changedRead);assert.equal(changedRead.represented,true);assert.match(changedRead.contentHash,/^sha256:[a-f0-9]{64}$/);assert.equal(changedRead.reasonCodes.includes('source_graph_changed_locator_matched'),true);assert.equal(changedRead.reasonCodes.includes('content_hash_verified'),true);const governanceRead=report.pack.utility.requiredLocalReads.find(item=>item.locator==='workspace://AGENTS.md'&&item.role==='changed_locator');assert(governanceRead);assert.equal(governanceRead.represented,false);assert.equal(governanceRead.reasonCodes.includes('source_graph_changed_locator_unmatched'),true);assert(!result.stdout.includes('GIT DETECTED RAW BODY'));assert(!result.stdout.includes('secret-value'));assert(!result.stdout.includes(root));assert(!result.stdout.includes('/Users/'));});
test('context pack rejects unsafe changed locators',()=>{const root=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-context-pack-unsafe-'));writeFileSync(path.join(root,'AGENTS.md'),'token=secret-value /Users/rebel/private.txt');const result=spawnSync(process.execPath,['apps/cli/oaf.mjs','context','pack','--from','codex','--root',root,'--objective','unsafe changed locator','--step','reject path escape','--target','codex','--changed','workspace://../secret.ts','--dry-run','--format','json'],{encoding:'utf8'});assert.equal(result.status,2);assert.match(result.stderr,/changed_context_locator_invalid/);assert.equal(result.stdout,'');assert(!result.stderr.includes(root));assert(!result.stderr.includes('/Users/rebel/private.txt'));assert(!result.stderr.includes('secret-value'))});
test('context pack rejects unsafe objective and step text before echoing handoff fields',()=>{const root=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-context-pack-unsafe-fields-'));writeFileSync(path.join(root,'AGENTS.md'),'Do not echo unsafe handoff fields.');const secret=spawnSync(process.execPath,['apps/cli/oaf.mjs','context','pack','--from','codex','--root',root,'--objective','prepare token=secret-value','--step','select context','--target','codex','--dry-run','--format','markdown'],{encoding:'utf8'});assert.equal(secret.status,2);assert.match(secret.stderr,/context_pack_objective_unsafe/);assert.equal(secret.stdout,'');assert(!secret.stderr.includes('secret-value'));const pathLeak=spawnSync(process.execPath,['apps/cli/oaf.mjs','context','pack','--from','codex','--root',root,'--objective','prepare handoff','--step','read /Users/rebel/private.txt','--target','codex','--dry-run','--format','json'],{encoding:'utf8'});assert.equal(pathLeak.status,2);assert.match(pathLeak.stderr,/context_pack_step_unsafe/);assert.equal(pathLeak.stdout,'');assert(!pathLeak.stderr.includes('/Users/rebel/private.txt'));});
test('context pack dry-run includes explicit user-selected files as proposal-only locators',()=>{const root=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-context-pack-selected-'));mkdirSync(path.join(root,'notes'),{recursive:true});writeFileSync(path.join(root,'AGENTS.md'),'Keep local-only context pack behavior.');writeFileSync(path.join(root,'notes','handoff.md'),'CliSelectedContext raw user body should stay out of reports.');const result=spawnSync(process.execPath,['apps/cli/oaf.mjs','context','pack','--from','codex','--root',root,'--objective','CliSelectedContext handoff','--step','select explicit user file','--target','codex','--include-file','notes/handoff.md','--token-budget','4096','--dry-run','--format','json'],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);const report=JSON.parse(result.stdout);assert(report.pack.readFirst.some(item=>item.locator==='user-selected://notes/handoff.md'&&item.harness==='generic-mcp'));assert(report.pack.memoryPlan.items.some(item=>item.locator==='user-selected://notes/handoff.md'&&item.action==='would_propose'));assert.equal(report.pack.memoryPlan.activeMemoryCreated,0);assert(!result.stdout.includes('raw user body'));});
test('context pack commands preserve requested include files even when omitted by budget',()=>{const root=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-context-pack-omitted-'));mkdirSync(path.join(root,'notes'),{recursive:true});writeFileSync(path.join(root,'AGENTS.md'),'Keep local-only context pack behavior.');writeFileSync(path.join(root,'notes','large.md'),Array.from({length:240},(_,index)=>`CLI OMITTED RAW BODY ${index}`).join('\n'));const result=spawnSync(process.execPath,['apps/cli/oaf.mjs','context','pack','--from','codex','--root',root,'--objective','preserve requested include file','--step','keep omitted include in commands','--target','codex','--include-file','notes/large.md','--token-budget','72','--dry-run','--format','json'],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);const report=JSON.parse(result.stdout);assert.equal(report.pack.requestedInputs.userSelectedLocators.includes('user-selected://notes/large.md'),true);assert.equal(report.pack.excluded.some(item=>item.locator==='user-selected://notes/large.md'),true);assert.equal(report.pack.handoff.commands.some(item=>item.includes("--include-file 'notes/large.md'")),true);assert.doesNotMatch(result.stdout,/CLI OMITTED RAW BODY/);});
test('context handoff read-only report proves Codex-ready MCP bridge without writes',()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-context-handoff-'));
  const home=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-context-handoff-home-'));
  mkdirSync(path.join(root,'notes'),{recursive:true});
  mkdirSync(path.join(root,'src'),{recursive:true});
  writeFileSync(path.join(root,'AGENTS.md'),'HANDOFF CLI AGENTS RAW BODY should stay hidden.');
  writeFileSync(path.join(root,'notes','handoff.md'),'HANDOFF CLI SELECTED RAW BODY token=secret-value should stay hidden.');
  writeFileSync(path.join(root,'src','auth.ts'),"export function approveTokenResetHandoffCli(){ return 'HANDOFF CLI SOURCE RAW BODY'; }\n");
  const env={...process.env,OAF_FIXED_NOW:'2026-06-24T00:00:00.000Z',OAF_COMMIT_SHA:'1234567890abcdef1234567890abcdef12345678'};
  const objective='Prepare Codex handoff';
  const step='assemble local context';
  const result=spawnSync(process.execPath,['apps/cli/oaf.mjs','context','handoff','--read-only','--from','codex','--root',root,'--home',home,'--objective',objective,'--step',step,'--target','codex','--include-file','notes/handoff.md','--changed','src/auth.ts','--format','json'],{encoding:'utf8',env});
  assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(result.stdout);
  assertJsonSchema(contextPackHandoffReportSchema,report,'context pack handoff report');
  assert.equal(report.command,'context handoff');
  assert.equal(report.state,'ready');
  assert.equal(report.commitSha,'1234567890abcdef1234567890abcdef12345678');
  assert.equal(report.launchPrompt.includes('Continue this local repository work in codex.'),true);
  assert.deepEqual(report.request.sourceHarnesses,['codex']);
  assert.equal(report.request.userSelectedLocatorCount,1);
  assert.equal(report.request.changedLocatorCount,1);
  assert.equal(report.contextPack.utilityStatus,'ready');
  assert.equal(report.contextPack.changedLocatorCoverage.status,'covered');
  assert.equal(report.usePlan.contextPackFingerprint,report.contextPack.contextPackFingerprint);
  assert.equal(report.usePlan.requiredLocalReads.some(item=>item.locator==='workspace://AGENTS.md'),true);
  assert.equal(report.usePlan.requiredLocalReads.some(item=>item.locator==='user-selected://notes/handoff.md'),true);
  assert.equal(report.usePlan.requiredLocalReads.some(item=>item.locator==='workspace://src/auth.ts'),true);
  assert.equal(report.usePlan.markdownContentIncluded,false);
  assert.equal(report.usePlan.sourceContentIncluded,false);
  assert.equal(report.memoryProposalPreflight.state,'not_configured');
  assert.equal(report.memoryProposalPreflight.configured,false);
  assert.equal(report.memoryProposalPreflight.configRef,null);
  assert.match(report.memoryProposalPreflight.command,/memory proposals --from memoryPaths/);
  assert.equal(report.memoryProposalPreflight.dryRun,true);
  assert.equal(report.memoryProposalPreflight.summary.proposalCount,0);
  assert.equal(report.memoryProposalPreflight.summary.reviewItemCount,0);
  assert.equal(report.memoryProposalPreflight.diagnostics.sourceCount,0);
  assert.equal(report.memoryProposalPreflight.reportFingerprint,null);
  assert.equal(report.memoryProposalPreflight.safeguards.localFilesWritten,0);
  assert.equal(report.memoryProposalPreflight.safeguards.activeMemoryCreated,0);
  assert.equal(report.memoryProposalPreflight.safeguards.rawSourceBodiesIncluded,false);
  assert.equal(report.memoryProposalPreflight.safeguards.proposalTextIncluded,false);
  assert.equal(report.memoryProposalPreflight.safeguards.proposalMarkdownIncluded,false);
  assert.equal(report.memoryProposalPreflight.safeguards.absoluteFilesystemLocationsIncluded,false);
  assert.equal(report.mcp.setup.dryRun,true);
  assert.equal(report.mcp.setup.client,'codex');
  assert.equal(report.mcp.setup.desiredServer.command,'npm');
  assert.deepEqual(report.mcp.setup.desiredServer.args,['--silent','run','oaf','--','mcp','resources','--read-only','--stdio']);
  assert.equal(report.mcp.setup.manualConfigSnippet.format,'toml');
  assert.equal(report.mcp.setup.manualConfigSnippet.applyMode,'manual-copy');
  assert.match(report.mcp.setup.manualConfigSnippet.content,/\[mcp_servers\.oaf\]/);
  assert.match(report.mcp.setup.manualConfigSnippet.content,/--read-only/);
  assert.equal(report.mcp.smoke.toolsExposed,0);
  assert.equal(report.mcp.smoke.contextPackFingerprint,report.contextPack.contextPackFingerprint);
  assert.match(report.commands.startMcpBridge,/npm --silent run oaf -- mcp resources --read-only --context-pack/);
  assert.match(report.commands.readCurrentContextPack,/oaf:\/\/workspace\/ws_local\/context-pack\/current/);
  assert.equal(report.checks.contextPackFingerprintMatchesMcp,true);
  assert.equal(report.checks.contextPackFingerprintMatchesUsePlan,true);
  assert.equal(report.checks.resourceRead,true);
  assert.equal(report.checks.noToolsExposed,true);
  assert.equal(report.checks.noMarkdownBody,true);
  assert.equal(report.checks.setupDryRun,true);
  assert.equal(report.checks.setupUsesSilentNpm,true);
  assert.equal(report.safeguards.readOnly,true);
  assert.equal(report.safeguards.localFilesWritten,0);
  assert.equal(report.safeguards.homeConfigMutated,false);
  assert.equal(report.safeguards.externalWritesEnabled,false);
  assert.equal(report.safeguards.externalAdaptersEnabled,0);
  assert.equal(report.safeguards.networkCalls,0);
  assert.equal(report.safeguards.modelCalls,0);
  assert.equal(report.safeguards.activeMemoryCreated,0);
  assert.equal(report.safeguards.rawSourceBodiesIncluded,false);
  assert.equal(report.safeguards.absoluteFilesystemLocationsIncluded,false);
  for(const forbidden of ['HANDOFF CLI AGENTS RAW BODY','HANDOFF CLI SELECTED RAW BODY','HANDOFF CLI SOURCE RAW BODY','secret-value',root,home,'/Users/rebel']){
    assert.equal(result.stdout.includes(forbidden),false,forbidden);
  }
  assert.equal(existsSync(path.join(root,'context-packs','CONTEXT_PACK.md')),false);
  assert.equal(existsSync(path.join(home,'.codex','config.toml')),false);
  const missingReadOnly=spawnSync(process.execPath,['apps/cli/oaf.mjs','context','handoff','--root',root,'--home',home,'--objective',objective,'--step',step,'--format','json'],{encoding:'utf8',env});
  assert.equal(missingReadOnly.status,2);
  assert.match(missingReadOnly.stderr,/--read-only/);
  const writeMode=spawnSync(process.execPath,['apps/cli/oaf.mjs','context','handoff','--read-only','--root',root,'--home',home,'--objective',objective,'--step',step,'--write','--format','json'],{encoding:'utf8',env});
  assert.equal(writeMode.status,2);
  assert.match(writeMode.stderr,/read-only/);
});
test('context handoff can preflight explicit memory paths without leaking or writing proposals',()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-context-handoff-memory-'));
  const home=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-context-handoff-memory-home-'));
  mkdirSync(path.join(root,'notes'),{recursive:true});
  writeFileSync(path.join(root,'AGENTS.md'),'Memory preflight AGENTS body stays hidden.');
  writeFileSync(path.join(root,'notes','memory.md'),[
    'HANDOFF MEMORY RAW BODY should stay hidden.',
    'Remember this local preference from /Users/rebel/private.txt.',
    'sk-'+'abcdefghijklmnopqrstuvwxyz123456'
  ].join('\n'));
  writeFileSync(path.join(root,'oaf.memory.json'),JSON.stringify({
    schemaVersion:'1.0.0',
    memoryPaths:[{path:'notes/memory.md',kind:'preference',sourceTrust:'unverified',dataClass:'workspace-private'}]
  },null,2));
  const env={...process.env,OAF_FIXED_NOW:'2026-06-24T00:00:00.000Z',OAF_COMMIT_SHA:'1234567890abcdef1234567890abcdef12345678'};
  const result=spawnSync(process.execPath,['apps/cli/oaf.mjs','context','handoff','--read-only','--from','codex','--root',root,'--home',home,'--objective','Prepare Codex memory handoff','--step','preflight memory proposals','--target','codex','--memory-config','oaf.memory.json','--format','json'],{encoding:'utf8',env});
  assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(result.stdout);
  assertJsonSchema(contextPackHandoffReportSchema,report,'context pack handoff memory preflight report');
  assert.equal(report.state,'review');
  assert.equal(report.memoryProposalPreflight.state,'review');
  assert.equal(report.memoryProposalPreflight.configured,true);
  assert.equal(report.memoryProposalPreflight.configRef,'workspace://oaf.memory.json');
  assert.match(report.memoryProposalPreflight.command,/memory proposals --from memoryPaths/);
  assert.match(report.memoryProposalPreflight.command,/--config 'oaf\.memory\.json'/);
  assert.equal(report.memoryProposalPreflight.dryRun,true);
  assert.equal(report.memoryProposalPreflight.summary.proposalCount,0);
  assert.equal(report.memoryProposalPreflight.summary.quarantinedCount,1);
  assert.equal(report.memoryProposalPreflight.summary.reviewItemCount,1);
  assert.equal(report.memoryProposalPreflight.diagnostics.sourceCount,1);
  assert.match(report.memoryProposalPreflight.reportFingerprint,/^sha256:[a-f0-9]{64}$/);
  assert.equal(report.memoryProposalPreflight.safeguards.localFilesWritten,0);
  assert.equal(report.memoryProposalPreflight.safeguards.networkCalls,0);
  assert.equal(report.memoryProposalPreflight.safeguards.modelCalls,0);
  assert.equal(report.memoryProposalPreflight.safeguards.activeMemoryCreated,0);
  assert.equal(report.memoryProposalPreflight.safeguards.rawSourceBodiesIncluded,false);
  assert.equal(report.memoryProposalPreflight.safeguards.proposalTextIncluded,false);
  assert.equal(report.memoryProposalPreflight.safeguards.proposalMarkdownIncluded,false);
  assert.equal(report.memoryProposalPreflight.safeguards.sourceContentIncluded,false);
  assert.equal(report.memoryProposalPreflight.safeguards.credentialsIncluded,false);
  assert.equal(report.memoryProposalPreflight.safeguards.absoluteFilesystemLocationsIncluded,false);
  for(const forbidden of ['HANDOFF MEMORY RAW BODY','abcdefghijklmnopqrstuvwxyz123456','/Users/rebel/private.txt',root,home,'## Proposed Text','[redacted-secret]']){
    assert.equal(result.stdout.includes(forbidden),false,forbidden);
  }
  assert.equal(existsSync(path.join(root,'memory','proposals')),false);
  const absolute=spawnSync(process.execPath,['apps/cli/oaf.mjs','context','handoff','--read-only','--from','codex','--root',root,'--home',home,'--objective','Prepare Codex memory handoff','--step','preflight memory proposals','--target','codex','--memory-config','/Users/rebel/oaf.memory.json','--format','json'],{encoding:'utf8',env});
  assert.equal(absolute.status,2);
  assert.equal(absolute.stdout,'');
  assert.match(absolute.stderr,/memory config must be workspace-relative/);
  assert.equal(absolute.stderr.includes('/Users/rebel'),false);
});
test('context pack write is explicit and limited to context-packs markdown',()=>{const root=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-context-pack-write-'));writeFileSync(path.join(root,'AGENTS.md'),'Write mode still keeps body out of output.');const result=spawnSync(process.execPath,['apps/cli/oaf.mjs','context','pack','--from','codex','--root',root,'--objective','write handoff','--step','select context','--target','generic','--write','--out','context-packs/CONTEXT_PACK.md','--format','json'],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);const report=JSON.parse(result.stdout);assert.equal(report.localFilesWritten,1);assert.equal(report.target.locator,'workspace://context-packs/CONTEXT_PACK.md');const markdown=readFileSync(path.join(root,'context-packs','CONTEXT_PACK.md'),'utf8');assert.match(markdown,/# Context Pack/);assert.doesNotMatch(markdown,/Write mode still keeps body/)});
test('context pack use plan writes and serves through read-only MCP',()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-context-pack-use-plan-'));
  mkdirSync(path.join(root,'notes'),{recursive:true});
  mkdirSync(path.join(root,'src'),{recursive:true});
  writeFileSync(path.join(root,'AGENTS.md'),'USE PLAN CLI AGENTS RAW BODY should stay hidden.');
  writeFileSync(path.join(root,'notes','handoff.md'),'USE PLAN CLI SELECTED RAW BODY should stay hidden.');
  writeFileSync(path.join(root,'src','auth.ts'),"export function approveTokenResetUsePlanCli(){ return 'USE PLAN CLI SOURCE RAW BODY'; }\n");
  const env={...process.env,OAF_FIXED_NOW:'2026-06-24T00:00:00.000Z'};
  const objective='Use plan CLI objective should not leak';
  const step='Use plan CLI step should not leak';
  const write=spawnSync(process.execPath,['apps/cli/oaf.mjs','context','pack','--from','codex','--root',root,'--objective',objective,'--step',step,'--target','codex','--include-file','notes/handoff.md','--changed','src/auth.ts','--write','--out','context-packs/CONTEXT_PACK.md','--use-out','context-packs/CONTEXT_PACK.use.json','--format','json'],{encoding:'utf8',env});
  assert.equal(write.status,0,write.stderr);
  const report=JSON.parse(write.stdout);
  assert.equal(report.localFilesWritten,2);
  assert.equal(report.usePlanTarget.locator,'workspace://context-packs/CONTEXT_PACK.use.json');
  assert.equal(existsSync(path.join(root,'context-packs','CONTEXT_PACK.md')),true);
  assert.equal(existsSync(path.join(root,'context-packs','CONTEXT_PACK.use.json')),true);
  const usePlan=JSON.parse(readFileSync(path.join(root,'context-packs','CONTEXT_PACK.use.json'),'utf8'));
  assert.equal(usePlan.resource.uri,'oaf://workspace/ws_local/context-pack/use-plan/current');
  assert.equal(usePlan.contextPack.fingerprint,report.pack.contextPackFingerprint);
  assert.equal(usePlan.requiredLocalReads.some(item=>item.locator==='workspace://src/auth.ts'),true);
  assert.equal(usePlan.safeguards.markdownContentIncluded,false);
  const dryUse=spawnSync(process.execPath,['apps/cli/oaf.mjs','context','pack','--from','codex','--root',root,'--objective',objective,'--step',step,'--target','codex','--include-file','notes/handoff.md','--changed','src/auth.ts','--dry-run','--format','use-json'],{encoding:'utf8',env});
  assert.equal(dryUse.status,0,dryUse.stderr);
  assert.equal(JSON.parse(dryUse.stdout).resource.kind,'context-pack-use-plan');
  const read=spawnSync(process.execPath,['apps/cli/oaf.mjs','mcp','resources','--read-only','--root',root,'--context-pack-use','context-packs/CONTEXT_PACK.use.json','--uri','oaf://workspace/ws_local/context-pack/use-plan/current','--format','json'],{encoding:'utf8',env});
  assert.equal(read.status,0,read.stderr);
  const payload=JSON.parse(JSON.parse(read.stdout).contents[0].text);
  assert.equal(payload.resourceKind,'context-pack-use-plan');
  assert.equal(payload.provenance.source,'local-context-pack-use-plan');
  assert.equal(payload.data.contextPack.fingerprint,report.pack.contextPackFingerprint);
  assert.equal(payload.data.requiredLocalReads.some(item=>item.locator==='user-selected://notes/handoff.md'),true);
  assert.equal(payload.safeguards.readOnly,true);
  const stdioInput=['{"jsonrpc":"2.0","id":1,"method":"resources/list"}',JSON.stringify({jsonrpc:'2.0',id:2,method:'resources/read',params:{uri:'oaf://workspace/ws_local/context-pack/use-plan/current'}})].join('\n');
  const stdio=spawnSync(process.execPath,['apps/cli/oaf.mjs','mcp','resources','--read-only','--root',root,'--context-pack-use','context-packs/CONTEXT_PACK.use.json','--stdio'],{encoding:'utf8',env,input:stdioInput});
  assert.equal(stdio.status,0,stdio.stderr);
  const responses=stdio.stdout.trim().split(/\n/u).map(line=>JSON.parse(line));
  assert.equal(responses[0].result.resources.some(item=>item.uri==='oaf://workspace/ws_local/context-pack/use-plan/current'),true);
  assert.equal(JSON.parse(responses[1].result.contents[0].text).resourceKind,'context-pack-use-plan');
  for(const forbidden of ['USE PLAN CLI AGENTS RAW BODY','USE PLAN CLI SELECTED RAW BODY','USE PLAN CLI SOURCE RAW BODY',objective,step,root,'/Users/rebel']){
    assert.equal(read.stdout.includes(forbidden),false,forbidden);
    assert.equal(stdio.stdout.includes(forbidden),false,forbidden);
  }
  const poisonedUsePlan={
    ...usePlan,
    requiredLocalReads:[
      {
        ...usePlan.requiredLocalReads[0],
        locator:'workspace:///Users/rebel/private.txt',
        readHint:'Read workspace:///Users/rebel/private.txt token=secret-value before acting.'
      }
    ]
  };
  writeFileSync(path.join(root,'context-packs','POISON.use.json'),JSON.stringify(poisonedUsePlan,null,2));
  const poisoned=spawnSync(process.execPath,['apps/cli/oaf.mjs','mcp','resources','--read-only','--root',root,'--context-pack-use','context-packs/POISON.use.json','--uri','oaf://workspace/ws_local/context-pack/use-plan/current','--format','json'],{encoding:'utf8',env});
  assert.equal(poisoned.status,2);
  assert.equal(poisoned.stdout,'');
  assert.match(poisoned.stderr,/failed schema validation|must match/);
  for(const forbidden of ['workspace:///Users/rebel/private.txt','token=secret-value','/Users/rebel','private.txt']){
    assert.equal(poisoned.stdout.includes(forbidden),false,forbidden);
    assert.equal(poisoned.stderr.includes(forbidden),false,forbidden);
  }
  const badPath=spawnSync(process.execPath,['apps/cli/oaf.mjs','mcp','resources','--read-only','--root',root,'--context-pack-use','../CONTEXT_PACK.use.json','--format','json'],{encoding:'utf8',env});
  assert.equal(badPath.status,2);
  assert.match(badPath.stderr,/context-packs\/\*\.use\.json/);
  const both=spawnSync(process.execPath,['apps/cli/oaf.mjs','mcp','resources','--read-only','--root',root,'--context-pack','--context-pack-use','context-packs/CONTEXT_PACK.use.json','--objective',objective,'--step',step,'--format','json'],{encoding:'utf8',env});
  assert.equal(both.status,2);
  assert.match(both.stderr,/either --context-pack or --context-pack-use/);
});
test('context pack pin writes registry and detects stale or tampered exports',()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-context-pack-pin-'));
  mkdirSync(path.join(root,'notes'),{recursive:true});
  mkdirSync(path.join(root,'src'),{recursive:true});
  writeFileSync(path.join(root,'AGENTS.md'),'PIN CLI AGENTS RAW BODY should stay hidden.');
  writeFileSync(path.join(root,'notes','handoff.md'),'PIN CLI SELECTED RAW BODY should stay hidden.');
  writeFileSync(path.join(root,'src','auth.ts'),"export function approveTokenResetPinCli(){ return 'PIN CLI SOURCE RAW BODY'; }\n");
  const env={...process.env,OAF_FIXED_NOW:'2026-06-24T00:00:00.000Z'};
  const objective='Pin CLI objective should not leak';
  const step='Pin CLI step should not leak';
  const write=spawnSync(process.execPath,['apps/cli/oaf.mjs','context','pack','--from','codex','--root',root,'--objective',objective,'--step',step,'--target','codex','--include-file','notes/handoff.md','--changed','src/auth.ts','--write','--pin','--out','context-packs/CONTEXT_PACK.md','--format','json'],{encoding:'utf8',env});
  assert.equal(write.status,0,write.stderr);
  const report=JSON.parse(write.stdout);
  assert.equal(report.localFilesWritten,4);
  assert.equal(report.registryTarget.locator,'workspace://context-packs/registry.json');
  assert.equal(report.currentTarget.locator,'workspace://context-packs/current.json');
  assert.equal(report.usePlanTarget.locator,'workspace://context-packs/CONTEXT_PACK.use.json');
  assert.equal(report.registry.currentEntryId,report.registryEntry.id);
  assert.equal(existsSync(path.join(root,'context-packs','registry.json')),true);
  assert.equal(existsSync(path.join(root,'context-packs','current.json')),true);
  const registry=JSON.parse(readFileSync(path.join(root,'context-packs','registry.json'),'utf8'));
  const current=JSON.parse(readFileSync(path.join(root,'context-packs','current.json'),'utf8'));
  assert.equal(registry.entries.length,1);
  assert.equal(current.entryId,report.registryEntry.id);
  assert.match(registry.registryFingerprint,/^sha256:[a-f0-9]{64}$/);
  const verified=spawnSync(process.execPath,['apps/cli/oaf.mjs','context','registry','status','--root',root,'--read-only','--format','json'],{encoding:'utf8',env});
  assert.equal(verified.status,0,verified.stderr);
  const verifiedReport=JSON.parse(verified.stdout);
  assert.equal(verifiedReport.current.status,'verified');
  assert.equal(verifiedReport.entries[0].artifactChecks.every(item=>item.status==='verified'),true);
  assert.equal(verifiedReport.entries[0].sourceChecks.staleLocators.length,0);
  assert.equal(verifiedReport.safeguards.localFilesWritten,0);
  const mcp=spawnSync(process.execPath,['apps/cli/oaf.mjs','mcp','resources','--read-only','--root',root,'--context-pack-registry','--uri','oaf://workspace/ws_local/context-pack/registry/current','--format','json'],{encoding:'utf8',env});
  assert.equal(mcp.status,0,mcp.stderr);
  const mcpPayload=JSON.parse(JSON.parse(mcp.stdout).contents[0].text);
  assert.equal(mcpPayload.resourceKind,'context-pack-registry-status');
  assert.equal(mcpPayload.provenance.source,'local-context-pack-registry');
  assert.equal(mcpPayload.data.current.status,'verified');
  const mcpStdio=spawnSync(process.execPath,['apps/cli/oaf.mjs','mcp','resources','--read-only','--root',root,'--context-pack-registry','--stdio'],{encoding:'utf8',env,input:['{"jsonrpc":"2.0","id":1,"method":"resources/list"}','{"jsonrpc":"2.0","id":2,"method":"tools/list"}'].join('\n')});
  assert.equal(mcpStdio.status,0,mcpStdio.stderr);
  const mcpResponses=mcpStdio.stdout.trim().split(/\n/u).map(line=>JSON.parse(line));
  assert.equal(mcpResponses[0].result.resources.some(item=>item.uri==='oaf://workspace/ws_local/context-pack/registry/current'),true);
  assert.deepEqual(mcpResponses[1].result.tools,[]);
  const plainListing=spawnSync(process.execPath,['apps/cli/oaf.mjs','mcp','resources','--read-only','--root',root,'--format','json'],{encoding:'utf8',env});
  assert.equal(plainListing.status,0,plainListing.stderr);
  const plainResources=JSON.parse(plainListing.stdout).resources;
  assert.equal(plainResources.some(item=>item.uri==='oaf://workspace/ws_local/context-pack/use-plan/current'),true);
  assert.equal(plainResources.some(item=>item.uri==='oaf://workspace/ws_local/context-pack/registry/current'),true);
  const plainUsePlan=spawnSync(process.execPath,['apps/cli/oaf.mjs','mcp','resources','--read-only','--root',root,'--uri','oaf://workspace/ws_local/context-pack/use-plan/current','--format','json'],{encoding:'utf8',env});
  assert.equal(plainUsePlan.status,0,plainUsePlan.stderr);
  const plainUsePlanPayload=JSON.parse(JSON.parse(plainUsePlan.stdout).contents[0].text);
  assert.equal(plainUsePlanPayload.resourceKind,'context-pack-use-plan');
  assert.equal(plainUsePlanPayload.data.contextPack.fingerprint,report.registryEntry.contextPack.fingerprint);
  const plainRegistry=spawnSync(process.execPath,['apps/cli/oaf.mjs','mcp','resources','--read-only','--root',root,'--uri','oaf://workspace/ws_local/context-pack/registry/current','--format','json'],{encoding:'utf8',env});
  assert.equal(plainRegistry.status,0,plainRegistry.stderr);
  const plainRegistryPayload=JSON.parse(JSON.parse(plainRegistry.stdout).contents[0].text);
  assert.equal(plainRegistryPayload.resourceKind,'context-pack-registry-status');
  assert.equal(plainRegistryPayload.data.current.status,'verified');
  const plainStdio=spawnSync(process.execPath,['apps/cli/oaf.mjs','mcp','resources','--read-only','--root',root,'--stdio'],{encoding:'utf8',env,input:['{"jsonrpc":"2.0","id":1,"method":"resources/list"}','{"jsonrpc":"2.0","id":2,"method":"tools/list"}',JSON.stringify({jsonrpc:'2.0',id:3,method:'resources/read',params:{uri:'oaf://workspace/ws_local/context-pack/registry/current'}})].join('\n')});
  assert.equal(plainStdio.status,0,plainStdio.stderr);
  const plainStdioResponses=plainStdio.stdout.trim().split(/\n/u).map(line=>JSON.parse(line));
  assert.equal(plainStdioResponses[0].result.resources.some(item=>item.uri==='oaf://workspace/ws_local/context-pack/use-plan/current'),true);
  assert.equal(plainStdioResponses[0].result.resources.some(item=>item.uri==='oaf://workspace/ws_local/context-pack/registry/current'),true);
  assert.deepEqual(plainStdioResponses[1].result.tools,[]);
  assert.equal(JSON.parse(plainStdioResponses[2].result.contents[0].text).data.current.status,'verified');
  writeFileSync(path.join(root,'src','auth.ts'),"export function approveTokenResetPinCli(){ return 'changed after pin'; }\n");
  const stale=spawnSync(process.execPath,['apps/cli/oaf.mjs','context','registry','status','--root',root,'--read-only','--format','json'],{encoding:'utf8',env});
  assert.equal(stale.status,0,stale.stderr);
  const staleReport=JSON.parse(stale.stdout);
  assert.equal(staleReport.current.status,'stale');
  assert.equal(staleReport.entries[0].sourceChecks.staleLocators.includes('workspace://src/auth.ts'),true);
  const staleMcp=spawnSync(process.execPath,['apps/cli/oaf.mjs','mcp','resources','--read-only','--root',root,'--uri','oaf://workspace/ws_local/context-pack/registry/current','--format','json'],{encoding:'utf8',env});
  assert.equal(staleMcp.status,0,staleMcp.stderr);
  assert.equal(JSON.parse(JSON.parse(staleMcp.stdout).contents[0].text).data.current.status,'stale');
  writeFileSync(path.join(root,'context-packs','CONTEXT_PACK.md'),`${readFileSync(path.join(root,'context-packs','CONTEXT_PACK.md'),'utf8')}\nTAMPERED EXPORT\n`);
  const tampered=spawnSync(process.execPath,['apps/cli/oaf.mjs','context','registry','status','--root',root,'--read-only','--format','json'],{encoding:'utf8',env});
  assert.equal(tampered.status,0,tampered.stderr);
  const tamperedReport=JSON.parse(tampered.stdout);
  assert.equal(tamperedReport.current.status,'tampered');
  assert.equal(tamperedReport.entries[0].artifactChecks.some(item=>item.role==='agent-handoff'&&item.status==='tampered'),true);
  const tamperedListing=spawnSync(process.execPath,['apps/cli/oaf.mjs','mcp','resources','--read-only','--root',root,'--format','json'],{encoding:'utf8',env});
  assert.equal(tamperedListing.status,0,tamperedListing.stderr);
  const tamperedResources=JSON.parse(tamperedListing.stdout).resources;
  assert.equal(tamperedResources.some(item=>item.uri==='oaf://workspace/ws_local/context-pack/use-plan/current'),false);
  assert.equal(tamperedResources.some(item=>item.uri==='oaf://workspace/ws_local/context-pack/registry/current'),true);
  for(const forbidden of ['PIN CLI AGENTS RAW BODY','PIN CLI SELECTED RAW BODY','PIN CLI SOURCE RAW BODY',objective,step,root,'/Users/rebel']){
    assert.equal(write.stdout.includes(forbidden),false,forbidden);
    assert.equal(verified.stdout.includes(forbidden),false,forbidden);
    assert.equal(mcp.stdout.includes(forbidden),false,forbidden);
    assert.equal(mcpStdio.stdout.includes(forbidden),false,forbidden);
    assert.equal(plainListing.stdout.includes(forbidden),false,forbidden);
    assert.equal(plainUsePlan.stdout.includes(forbidden),false,forbidden);
    assert.equal(plainRegistry.stdout.includes(forbidden),false,forbidden);
    assert.equal(plainStdio.stdout.includes(forbidden),false,forbidden);
    assert.equal(stale.stdout.includes(forbidden),false,forbidden);
    assert.equal(staleMcp.stdout.includes(forbidden),false,forbidden);
    assert.equal(tampered.stdout.includes(forbidden),false,forbidden);
    assert.equal(tamperedListing.stdout.includes(forbidden),false,forbidden);
  }
});
test('context receive reads pinned Codex context pack without writes or private payloads',()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-context-receive-'));
  const home=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-context-receive-home-'));
  mkdirSync(path.join(root,'notes'),{recursive:true});
  mkdirSync(path.join(root,'src'),{recursive:true});
  writeFileSync(path.join(root,'AGENTS.md'),'RECEIVE CLI AGENTS RAW BODY should stay hidden. OPENAI_API_KEY=secret-value https://provider.example/private');
  writeFileSync(path.join(root,'notes','handoff.md'),'RECEIVE CLI SELECTED RAW BODY should stay hidden.');
  writeFileSync(path.join(root,'src','auth.ts'),"export function approveTokenResetReceiveCli(){ return 'RECEIVE CLI SOURCE RAW BODY'; }\n");
  const env={...process.env,HOME:home,OAF_FIXED_NOW:'2026-06-24T00:00:00.000Z',OAF_COMMIT_SHA:'1234567890abcdef1234567890abcdef12345678'};
  const objective='Receive CLI private objective should not leak';
  const step='Receive CLI private step should not leak';
  const pinned=spawnSync(process.execPath,['apps/cli/oaf.mjs','context','pack','--from','codex','--root',root,'--objective',objective,'--step',step,'--target','codex','--include-file','notes/handoff.md','--changed','src/auth.ts','--write','--pin','--out','context-packs/CONTEXT_PACK.md','--format','json'],{encoding:'utf8',env});
  assert.equal(pinned.status,0,pinned.stderr);
  const pinnedReport=JSON.parse(pinned.stdout);
  const artifactPaths=['CONTEXT_PACK.md','CONTEXT_PACK.use.json','registry.json','current.json'].map(file=>path.join(root,'context-packs',file));
  const beforeArtifacts=artifactPaths.map(file=>readFileSync(file,'utf8'));
  const receive=spawnSync(process.execPath,['apps/cli/oaf.mjs','context','receive','--read-only','--root',root,'--target','codex','--format','json'],{encoding:'utf8',env});
  assert.equal(receive.status,0,receive.stderr);
  const report=JSON.parse(receive.stdout);
  assertJsonSchema(contextPackReceiveReportSchema,report,'context pack receive report');
  assert.equal(report.command,'context receive');
  assert.equal(report.state,'ready');
  assert.equal(report.targetHarness,'codex');
  assert.equal(report.commitSha,'1234567890abcdef1234567890abcdef12345678');
  assert.equal(report.registry.currentStatus,'verified');
  assert.equal(report.registry.registryFingerprintStatus,'verified');
  assert.equal(report.registry.currentPointerFingerprintStatus,'verified');
  assert.equal(report.registry.currentEntryId,pinnedReport.registryEntry.id);
  assert.equal(report.registry.contextPackFingerprint,pinnedReport.registryEntry.contextPack.fingerprint);
  assert.equal(report.registry.usePlanFingerprint,pinnedReport.registryEntry.usePlan.fingerprint);
  assert.equal(report.registry.sourceChecks.stale,0);
  assert.equal(report.registry.artifactChecks.every(item=>item.status==='verified'),true);
  assert.equal(report.usePlan.exists,true);
  assert.equal(report.usePlan.resourceUri,'oaf://workspace/ws_local/context-pack/use-plan/current');
  assert.equal(report.usePlan.targetHarness,'codex');
  assert.equal(report.usePlan.contextPackFingerprint,pinnedReport.registryEntry.contextPack.fingerprint);
  assert.equal(report.usePlan.usePlanFingerprint,pinnedReport.registryEntry.usePlan.fingerprint);
  assert.equal(report.usePlan.requiredLocalReads.some(item=>item.locator==='workspace://AGENTS.md'&&item.contentHash),true);
  assert.equal(report.usePlan.requiredLocalReads.some(item=>item.locator==='user-selected://notes/handoff.md'&&item.contentHash),true);
  assert.equal(report.usePlan.requiredLocalReads.some(item=>item.locator==='workspace://src/auth.ts'&&item.reasonCodes.includes('content_hash_verified')),true);
  assert.equal(report.usePlan.safeguards.markdownContentIncluded,false);
  assert.equal(report.usePlan.safeguards.sourceContentIncluded,false);
  assert.equal(report.receiverPacket.packetVersion,'oaf-context-receiver-packet-1.0.0');
  assert.equal(report.receiverPacket.state,'ready');
  assert.equal(report.receiverPacket.targetHarness,'codex');
  assert.equal(report.receiverPacket.reviewNeeded,false);
  assert.equal(report.receiverPacket.fingerprints.contextPack,pinnedReport.registryEntry.contextPack.fingerprint);
  assert.equal(report.receiverPacket.fingerprints.usePlan,pinnedReport.registryEntry.usePlan.fingerprint);
  assert.equal(report.receiverPacket.proof.registryFingerprintVerified,true);
  assert.equal(report.receiverPacket.proof.currentPointerVerified,true);
  assert.equal(report.receiverPacket.proof.currentEntryVerified,true);
  assert.equal(report.receiverPacket.proof.targetMatches,true);
  assert.equal(report.receiverPacket.proof.usePlanLoaded,true);
  assert.equal(report.receiverPacket.proof.toolsExposed,0);
  assert.equal(report.receiverPacket.proof.externalWritesEnabled,false);
  assert.equal(report.receiverPacket.proof.externalAdaptersEnabled,0);
  assert.equal(report.receiverPacket.proof.sourceContentIncluded,false);
  assert.equal(report.receiverPacket.proof.markdownBodyIncluded,false);
  assert.equal(report.receiverPacket.proof.rawSourceBodiesIncluded,false);
  assert.equal(report.receiverPacket.readPlan.requiredReadCount,report.usePlan.requiredReadCount);
  assert.equal(report.receiverPacket.readPlan.requiredReads.some(item=>item.locator==='workspace://AGENTS.md'&&item.contentHash),true);
  assert.equal(report.receiverPacket.readPlan.requiredReads.some(item=>item.locator==='workspace://src/auth.ts'&&item.reasonCodes.includes('content_hash_verified')),true);
  assert.deepEqual(report.receiverPacket.nextActions.map(item=>item.label),['Check pinned registry','Read pinned use plan','Preview harness MCP setup','Start read-only MCP bridge']);
  assert.equal(report.receiverPacket.nextActions.find(item=>item.label==='Read pinned use plan').required,true);
  assert.equal(report.receiverPacket.nextActions.find(item=>item.label==='Start read-only MCP bridge').required,false);
  assert.equal(report.mcp.resourceUris.includes('oaf://workspace/ws_local/context-pack/use-plan/current'),true);
  assert.equal(report.mcp.resourceUris.includes('oaf://workspace/ws_local/context-pack/registry/current'),true);
  assert.equal(report.mcp.toolsExposed,0);
  assert.equal(report.mcp.usePlanResourceRead,true);
  assert.equal(report.mcp.registryResourceRead,true);
  assert.equal(report.setup.dryRun,true);
  assert.equal(report.setup.client,'codex');
  assert.deepEqual(report.setup.desiredServer.args,['--silent','run','oaf','--','mcp','resources','--read-only','--stdio']);
  assert.equal(report.setup.manualConfigSnippet.format,'toml');
  assert.match(report.setup.manualConfigSnippet.content,/\[mcp_servers\.oaf\]/);
  assert.match(report.commands.createPinnedContextPack,/context pack --from codex --root \. --objective '<reviewed-objective>' --step '<reviewed-step>' --target codex --write --pin --out context-packs\/CONTEXT_PACK\.md --format json/);
  assert.equal(report.checks.registryFingerprintVerified,true);
  assert.equal(report.checks.currentPointerVerified,true);
  assert.equal(report.checks.currentEntryVerified,true);
  assert.equal(report.checks.currentEntryMatchesTarget,true);
  assert.equal(report.checks.usePlanLoaded,true);
  assert.equal(report.checks.usePlanFingerprintMatchesRegistry,true);
  assert.equal(report.checks.contextPackFingerprintMatchesRegistry,true);
  assert.equal(report.checks.noToolsExposed,true);
  assert.equal(report.checks.setupDryRun,true);
  assert.equal(report.checks.setupUsesSilentNpm,true);
  assert.equal(report.safeguards.readOnly,true);
  assert.equal(report.safeguards.localFilesWritten,0);
  assert.equal(report.safeguards.homeConfigMutated,false);
  assert.equal(report.safeguards.externalWritesEnabled,false);
  assert.equal(report.safeguards.externalAdaptersEnabled,0);
  assert.equal(report.safeguards.networkCalls,0);
  assert.equal(report.safeguards.modelCalls,0);
  assert.equal(report.safeguards.activeMemoryCreated,0);
  assert.equal(report.safeguards.rawSourceBodiesIncluded,false);
  assert.equal(report.safeguards.markdownBodyIncluded,false);
  assert.equal(report.safeguards.sourceContentIncluded,false);
  assert.equal(report.safeguards.objectiveTextIncluded,false);
  assert.equal(report.safeguards.stepTextIncluded,false);
  assert.equal(report.safeguards.launchInstructionsIncluded,false);
  assert.equal(report.safeguards.credentialsIncluded,false);
  assert.equal(report.safeguards.providerUrlsIncluded,false);
  assert.equal(report.safeguards.absoluteFilesystemLocationsIncluded,false);
  assert.deepEqual(artifactPaths.map(file=>readFileSync(file,'utf8')),beforeArtifacts);
  for(const forbidden of ['RECEIVE CLI AGENTS RAW BODY','RECEIVE CLI SELECTED RAW BODY','RECEIVE CLI SOURCE RAW BODY','secret-value','OPENAI_API_KEY','https://provider.example/private',objective,step,'# Context Pack','Launch Prompt',root,home,'/Users/rebel']){
    assert.equal(receive.stdout.includes(forbidden),false,forbidden);
  }
  const missingRoot=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-context-receive-missing-'));
  const missing=spawnSync(process.execPath,['apps/cli/oaf.mjs','context','receive','--read-only','--root',missingRoot,'--target','codex','--format','json'],{encoding:'utf8',env});
  assert.equal(missing.status,0,missing.stderr);
  const missingReport=JSON.parse(missing.stdout);
  assertJsonSchema(contextPackReceiveReportSchema,missingReport,'missing context pack receive report');
  assert.equal(missingReport.state,'blocked');
  assert.equal(missingReport.registry.registryExists,false);
  assert.equal(missingReport.registry.currentPointerExists,false);
  assert.equal(missingReport.usePlan.exists,false);
  assert.equal(missingReport.receiverPacket.state,'blocked');
  assert.equal(missingReport.receiverPacket.reviewNeeded,true);
  assert.equal(missingReport.receiverPacket.readPlan.requiredReadCount,0);
  assert.deepEqual(missingReport.receiverPacket.readPlan.requiredReads,[]);
  assert.equal(missingReport.receiverPacket.nextActions.some(item=>item.label==='Read pinned use plan'),false);
  const missingCreate=missingReport.receiverPacket.nextActions.find(item=>item.label==='Create pinned context pack');
  assert(missingCreate);
  assert.equal(missingCreate.required,true);
  assert.equal(missingCreate.reasonCode,'create_pinned_context_pack');
  assert.equal(missingCreate.command,missingReport.commands.createPinnedContextPack);
  assert.match(missingCreate.command,/--objective '<reviewed-objective>' --step '<reviewed-step>'/);
  assert.equal(missingReport.mcp.toolsExposed,0);
  assert.equal(missing.stdout.includes(missingRoot),false);
  const staleRoot=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-context-receive-stale-'));
  mkdirSync(path.join(staleRoot,'src'),{recursive:true});
  writeFileSync(path.join(staleRoot,'AGENTS.md'),'stale receive raw body hidden');
  writeFileSync(path.join(staleRoot,'src','auth.ts'),'export function staleReceive(){ return true; }\n');
  const stalePin=spawnSync(process.execPath,['apps/cli/oaf.mjs','context','pack','--from','codex','--root',staleRoot,'--objective','stale receive objective','--step','stale receive step','--target','codex','--changed','src/auth.ts','--write','--pin','--out','context-packs/CONTEXT_PACK.md','--format','json'],{encoding:'utf8',env});
  assert.equal(stalePin.status,0,stalePin.stderr);
  writeFileSync(path.join(staleRoot,'src','auth.ts'),'export function staleReceive(){ return false; }\n');
  const staleReceive=spawnSync(process.execPath,['apps/cli/oaf.mjs','context','receive','--read-only','--root',staleRoot,'--target','codex','--format','json'],{encoding:'utf8',env});
  assert.equal(staleReceive.status,0,staleReceive.stderr);
  const staleReport=JSON.parse(staleReceive.stdout);
  assert.equal(staleReport.state,'review');
  assert.equal(staleReport.registry.currentStatus,'stale');
  assert.equal(staleReport.registry.sourceChecks.staleLocators.includes('workspace://src/auth.ts'),true);
  assert.equal(staleReport.usePlan.exists,false);
  assert.equal(staleReport.receiverPacket.state,'review');
  assert.equal(staleReport.receiverPacket.reviewNeeded,true);
  assert.equal(staleReport.receiverPacket.proof.currentEntryVerified,false);
  assert.equal(staleReport.receiverPacket.proof.usePlanLoaded,false);
  assert.deepEqual(staleReport.receiverPacket.readPlan.requiredReads,[]);
  assert.equal(staleReport.receiverPacket.nextActions.some(item=>item.label==='Read pinned use plan'),false);
  const staleCreate=staleReport.receiverPacket.nextActions.find(item=>item.label==='Create pinned context pack');
  assert(staleCreate);
  assert.equal(staleCreate.required,true);
  assert.equal(staleCreate.command,staleReport.commands.createPinnedContextPack);
  assert.equal(staleReport.checks.usePlanLoaded,false);
  assert.equal(staleReport.mcp.resourceUris.includes('oaf://workspace/ws_local/context-pack/use-plan/current'),false);
  assert.equal(staleReport.mcp.resourceUris.includes('oaf://workspace/ws_local/context-pack/registry/current'),true);
  assert.equal(staleReport.mcp.usePlanResourceRead,false);
  assert.equal(staleReport.mcp.registryResourceRead,true);
  assert.equal(staleReceive.stdout.includes('stale receive raw body hidden'),false);
  for(const args of [
    ['apps/cli/oaf.mjs','context','receive','--root',root,'--target','codex','--format','json'],
    ['apps/cli/oaf.mjs','context','receive','--read-only','--root',root,'--target','codex','--write','--format','json'],
    ['apps/cli/oaf.mjs','context','receive','--read-only','--root',root,'--target','codex','--out','context-packs/out.json','--format','json'],
    ['apps/cli/oaf.mjs','context','receive','--read-only','--root',root,'--target','codex','--pin','--format','json'],
    ['apps/cli/oaf.mjs','context','receive','--read-only','--root',root,'--target','codex','--use-out','context-packs/out.use.json','--format','json'],
    ['apps/cli/oaf.mjs','context','receive','--read-only','--root',root,'--target','codex','--stdio','--format','json'],
    ['apps/cli/oaf.mjs','context','receive','--read-only','--root',root,'--target','codex','--objective','private objective','--format','json'],
    ['apps/cli/oaf.mjs','context','receive','--read-only','--root',root,'--target','codex','--step','private step','--format','json'],
    ['apps/cli/oaf.mjs','context','receive','--read-only','--root',root,'--target','codex','--from','codex','--format','json'],
    ['apps/cli/oaf.mjs','context','receive','--read-only','--root',root,'--target','codex','--changed','src/auth.ts','--format','json'],
    ['apps/cli/oaf.mjs','context','receive','--read-only','--root',root,'--target','codex','--changed-locator','workspace://src/auth.ts','--format','json'],
    ['apps/cli/oaf.mjs','context','receive','--read-only','--root',root,'--target','codex','--changed-from-git','--format','json'],
    ['apps/cli/oaf.mjs','context','receive','--read-only','--root',root,'--target','codex','--include-file','notes/handoff.md','--format','json'],
    ['apps/cli/oaf.mjs','context','receive','--read-only','--root',root,'--target','codex','--home',home,'--format','json'],
    ['apps/cli/oaf.mjs','context','receive','--read-only','--root',root,'--target','codex','--config',path.join(home,'.codex','config.toml'),'--format','json'],
    ['apps/cli/oaf.mjs','context','receive','--read-only','--root',root,'--target','codex','--server','oaf','--format','json']
  ]){
    const rejected=spawnSync(process.execPath,args,{encoding:'utf8',env});
    assert.equal(rejected.status,2,args.join(' '));
    assert.equal(rejected.stdout,'');
    assert.equal(rejected.stderr.includes(root),false);
    assert.equal(rejected.stderr.includes(home),false);
  }
});
test('context graph preview dry-run emits sanitized source graph report',()=>{const root=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-source-graph-'));mkdirSync(path.join(root,'src'),{recursive:true});writeFileSync(path.join(root,'src','auth.ts'),['export class TokenResetService {','  approveTokenReset(request: ResetRequest) {',"    return { ok: true, secret: 'CLI GRAPH RAW BODY' };",'  }','}'].join('\n'));writeFileSync(path.join(root,'src','workflow.ts'),["import { TokenResetService } from './auth';",'export function runAuthWorkflow(request: ResetRequest) {','  const service = new TokenResetService();','  return service.approveTokenReset(request);','}'].join('\n'));const env={...process.env,OAF_FIXED_NOW:'2026-06-23T00:00:00.000Z'};const result=spawnSync(process.execPath,['apps/cli/oaf.mjs','context','graph','preview','--root',root,'--query','approve token reset workflow','--trace','runAuthWorkflow','--changed','src/auth.ts','--sample-limit','3','--dry-run','--format','json'],{encoding:'utf8',env});assert.equal(result.status,0,result.stderr);const report=JSON.parse(result.stdout);assert.equal(report.schemaVersion,'1.0.0');assert.equal(report.safeguards.persisted,false);assert.equal(report.safeguards.modelCalls,0);assert.equal(report.safeguards.networkCalls,0);assert.equal(report.safeguards.externalAdaptersEnabled,0);assert.equal(report.safeguards.externalWritesEnabled,false);assert.equal(report.safeguards.graphDatabaseUsed,false);assert(report.search.results.some(item=>item.label.includes('approveTokenReset')));assert(report.trace.paths.some(item=>item.terminalLabel==='approveTokenReset'));assert(report.impact.affectedSymbols.some(item=>item.name==='approveTokenReset'));assert(report.graph.sampleNodes.length<=3);assert(!result.stdout.includes('CLI GRAPH RAW BODY'));assert(!result.stdout.includes(root));assert(!result.stdout.includes('/Users/'))});
test('context graph preview rejects non-dry-run mode',()=>{const root=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-source-graph-'));mkdirSync(path.join(root,'src'),{recursive:true});writeFileSync(path.join(root,'src','auth.ts'),'export function approveTokenReset() { return true; }');const result=spawnSync(process.execPath,['apps/cli/oaf.mjs','context','graph','preview','--root',root,'--query','approve token reset','--format','json'],{encoding:'utf8'});assert.equal(result.status,2);assert.match(result.stderr,/context graph preview --dry-run is required/)});
test('benchmark truth-floor emits sanitized JSON and gates failures',()=>{const passing=spawnSync(process.execPath,['apps/cli/oaf.mjs','benchmark','truth-floor','--suite','benchmark-truth-floor','--dataset','evals/benchmark-truth-floor/cases.v1.json','--format','json'],{encoding:'utf8'});assert.equal(passing.status,0,passing.stderr);const report=JSON.parse(passing.stdout);assert.equal(report.gateDecision,'pass');assert.match(report.commitSha,/^[a-f0-9]{40}$/);assert.notEqual(report.commitSha,'0000000000000000000000000000000000000000');assert.equal(report.safeguards.externalAdaptersEnabled,0);assert.equal(report.safeguards.externalWritesEnabled,false);assert(!passing.stdout.includes('/Users/rebel'));assert(!passing.stdout.includes('credential-sentinel-value'));const root=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-benchmark-'));const failingPath=path.join(root,'cases.v1.json');const failingDataset=JSON.parse(readFileSync('evals/benchmark-truth-floor/cases.v1.json','utf8'));failingDataset.cases=[{...failingDataset.cases[0],requiredEvidenceIds:['ev_missing']}];writeFileSync(failingPath,JSON.stringify(failingDataset,null,2));const failing=spawnSync(process.execPath,['apps/cli/oaf.mjs','benchmark','truth-floor','--suite','benchmark-truth-floor','--dataset',failingPath,'--format','json'],{encoding:'utf8'});assert.equal(failing.status,1,failing.stderr);const failedReport=JSON.parse(failing.stdout);assert.equal(failedReport.gateDecision,'fail');const unsupported=spawnSync(process.execPath,['apps/cli/oaf.mjs','benchmark','truth-floor','--suite','hosted-models','--dataset','evals/benchmark-truth-floor/cases.v1.json','--format','json'],{encoding:'utf8'});assert.equal(unsupported.status,2);assert.match(unsupported.stderr,/unsupported suite/i)});
test('memory profile CLI renders dry-run and explicit local report writes',()=>{const root=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-memory-'));const recordsPath=path.join(root,'records.json');writeFileSync(recordsPath,JSON.stringify({records:[{schemaVersion:'1.0.0',id:'mem_cli_active',workspaceId:'ws_local',kind:'decision',text:'Use context manifests for model calls.',status:'active',source:'evidence:ev_cli',sourceTrust:'verified',decision:'allow',confidence:0.9,createdAt:'2026-06-23T00:00:00.000Z',updatedAt:'2026-06-23T00:00:00.000Z',dataClass:'workspace-private',evidenceIds:['ev_cli'],lifecycle:[{type:'memory.activated',at:'2026-06-23T00:00:00.000Z',actorId:'usr',reason:null,evidenceIds:['ev_cli']}]},{schemaVersion:'1.0.0',id:'mem_cli_proposed',workspaceId:'ws_local',kind:'episode',text:'Do not include pending records.',status:'proposed',source:'model-output',decision:'review',confidence:0.5,createdAt:'2026-06-23T00:00:00.000Z'}]},null,2));const env={...process.env,OAF_FIXED_NOW:'2026-06-23T00:00:00.000Z'};const dry=spawnSync(process.execPath,['apps/cli/oaf.mjs','memory','profile','--records',recordsPath,'--root',root,'--dry-run','--format','json'],{encoding:'utf8',env});assert.equal(dry.status,0,dry.stderr);const report=JSON.parse(dry.stdout);assert.deepEqual(report.summary.recordIds,['mem_cli_active']);assert.equal(report.safeguards.localFilesWritten,0);assert(!dry.stdout.includes('pending records'));const write=spawnSync(process.execPath,['apps/cli/oaf.mjs','memory','profile','--records',recordsPath,'--root',root,'--write','--format','json'],{encoding:'utf8',env});assert.equal(write.status,0,write.stderr);const written=JSON.parse(write.stdout);assert.equal(written.safeguards.localFilesWritten,1);assert.match(readFileSync(path.join(root,'memory/profile.md'),'utf8'),/Use context manifests/);});
test('memory report writes reject arbitrary output paths and symlinked memory parents',()=>{const root=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-memory-write-'));const outside=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-memory-outside-'));const recordsPath=path.join(root,'records.json');writeFileSync(recordsPath,JSON.stringify({records:[{schemaVersion:'1.0.0',id:'mem_cli_active',workspaceId:'ws_local',kind:'decision',text:'Use context manifests for model calls.',status:'active',source:'evidence:ev_cli',decision:'allow',confidence:0.9,createdAt:'2026-06-23T00:00:00.000Z',dataClass:'workspace-private'}]},null,2));const env={...process.env,OAF_FIXED_NOW:'2026-06-23T00:00:00.000Z'};const arbitrary=spawnSync(process.execPath,['apps/cli/oaf.mjs','memory','profile','--records',recordsPath,'--root',root,'--write','--out','package.json','--format','json'],{encoding:'utf8',env});assert.equal(arbitrary.status,2);assert.match(arbitrary.stderr,/memory\/profile\.md|generated reports/);symlinkSync(outside,path.join(root,'memory'),'dir');const escaped=spawnSync(process.execPath,['apps/cli/oaf.mjs','memory','profile','--records',recordsPath,'--root',root,'--write','--format','json'],{encoding:'utf8',env});assert.equal(escaped.status,2);assert.match(escaped.stderr,/symlink/);assert.equal(existsSync(path.join(outside,'profile.md')),false);});
test('memory proposals CLI treats memoryPaths as proposal-only sanitized sources',()=>{const root=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-memorypaths-'));writeFileSync(path.join(root,'notes.md'),'Remember context work from /Users/rebel/private.txt with token=secret-value and OPENAI_API_KEY=another-secret.');const configPath=path.join(root,'oaf.memory.json');writeFileSync(configPath,JSON.stringify({schemaVersion:'1.0.0',memoryPaths:[{path:'notes.md',kind:'episode'}]},null,2));const env={...process.env,OAF_FIXED_NOW:'2026-06-23T00:00:00.000Z'};const result=spawnSync(process.execPath,['apps/cli/oaf.mjs','memory','proposals','--from','memoryPaths','--config',configPath,'--root',root,'--dry-run','--format','json'],{encoding:'utf8',env});assert.equal(result.status,0,result.stderr);const report=JSON.parse(result.stdout);assert.equal(report.summary.proposalCount,1);assert.equal(report.diagnostics.sourceCount,1);assert.equal(report.items[0].sourceDiagnostics.sourceRole,'memory-file');assert.equal(report.items[0].sourceDiagnostics.lineCount,1);assert.equal(report.safeguards.activeMemoryCreated,0);assert.equal(report.safeguards.canonicalStateMutated,false);assert(!result.stdout.includes('/Users/rebel/private.txt'));assert(!result.stdout.includes('secret-value'));assert(!result.stdout.includes('another-secret'));const rejected=spawnSync(process.execPath,['apps/cli/oaf.mjs','memory','proposals','--from','memoryPaths','--config',configPath,'--root',root,'--format','json'],{encoding:'utf8',env});assert.equal(rejected.status,2);assert.match(rejected.stderr,/exactly one of --dry-run or --write/);});
test('memory sgrep CLI returns lifecycle evidence and manifest reason codes without writes',()=>{const root=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-sgrep-'));const recordsPath=path.join(root,'records.json');const manifestPath=path.join(root,'manifest.json');writeFileSync(recordsPath,JSON.stringify({records:[{schemaVersion:'1.0.0',id:'mem_cli_search',workspaceId:'ws_local',kind:'decision',text:'SQLite memory search returns source-grounded lifecycle state.',status:'active',source:'evidence:ev_search',decision:'allow',confidence:0.8,createdAt:'2026-06-23T00:00:00.000Z',updatedAt:'2026-06-23T00:00:00.000Z',dataClass:'workspace-private',evidenceIds:['ev_search'],lifecycle:[{type:'memory.activated',at:'2026-06-23T00:00:00.000Z',actorId:'usr',reason:null,evidenceIds:['ev_search']}]},{schemaVersion:'1.0.0',id:'mem_cli_rejected',workspaceId:'ws_local',kind:'decision',text:'SQLite memory search should not return rejected memory.',status:'rejected',source:'model-output',decision:'reject',confidence:0.2,createdAt:'2026-06-23T00:00:00.000Z'}]},null,2));writeFileSync(manifestPath,JSON.stringify({selectedDecisions:[{id:'mem_cli_search',reasonCodes:['active_memory','query_match']}],excludedDecisions:[]},null,2));const env={...process.env,OAF_FIXED_NOW:'2026-06-23T00:00:00.000Z'};const result=spawnSync(process.execPath,['apps/cli/oaf.mjs','memory','sgrep','sqlite','--records',recordsPath,'--manifest',manifestPath,'--workspace','ws_local','--dry-run','--format','json'],{encoding:'utf8',env});assert.equal(result.status,0,result.stderr);const report=JSON.parse(result.stdout);assert.equal(report.summary.resultCount,1);assert.equal(report.results[0].id,'mem_cli_search');assert.deepEqual(report.results[0].contextManifest.reasonCodes,['active_memory','query_match']);assert.equal(report.safeguards.localFilesWritten,0);assert.equal(report.safeguards.externalWritesEnabled,false);});
test('memory sgrep sqlite dry-run opens existing databases read-only without migration writes',async()=>{const root=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-sgrep-sqlite-'));const sqlitePath=path.join(root,'memory.sqlite');const provider=new SQLiteMemoryProvider({filename:sqlitePath,clock:()=>'2026-06-23T00:00:00.000Z'});await provider.put({id:'mem_cli_sqlite',workspaceId:'ws_local',kind:'decision',text:'SQLite memory search stays dry-run.',status:'active',source:'evidence:ev_sqlite'});provider.close();const before=statSync(sqlitePath).mtimeMs;const env={...process.env,OAF_FIXED_NOW:'2026-06-23T00:00:00.000Z'};const result=spawnSync(process.execPath,['apps/cli/oaf.mjs','memory','sgrep','sqlite','--sqlite',sqlitePath,'--workspace','ws_local','--dry-run','--format','json'],{encoding:'utf8',env});assert.equal(result.status,0,result.stderr);const report=JSON.parse(result.stdout);assert.equal(report.summary.resultCount,1);assert.equal(report.results[0].id,'mem_cli_sqlite');assert.equal(statSync(sqlitePath).mtimeMs,before);});
test('mcp server exposes governed memory recall and compressed profile over stdio', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaf-cli-mcp-server-'));
  mkdirSync(path.join(root, '.local'), { recursive: true });
  writeFileSync(path.join(root, 'PROJECT_STATUS.json'), JSON.stringify({
    release: '0.2.0-dev',
    phase: 'local-test',
    defaults: { network: 'deny', externalWrites: false, modelMode: 'deterministic', dataResidency: 'local-only', adapters: 'disabled' }
  }, null, 2));
  const sqlite = path.join(root, '.local', 'memory.sqlite');
  const provider = new SQLiteMemoryProvider({ filename: sqlite, clock: () => '2026-06-26T11:00:00.000Z' });
  let providerClosed = false;
  t.after(() => { if (!providerClosed) provider.close(); });
  async function approve(id, payload) {
    await provider.enqueueProposal({
      id,
      workspaceId: 'ws_local',
      sourceLocator: 'workspace://memory/mcp.md',
      sourceHash: 'sha256:' + id.replace(/[^a-f0-9]/g, 'a').padEnd(64, 'a').slice(0, 64),
      payload
    });
    await provider.claimProposal({ workspaceId: 'ws_local', workerId: 'mcp-test', leaseUntil: '2026-06-26T11:05:00.000Z' });
    await provider.recordProposalResult({ workspaceId: 'ws_local', id, workerId: 'mcp-test', status: 'applied', result: { accepted: true } });
  }
  await approve('mpq_mcp_old', { kind: 'fact', subject: 'project:oaf', predicate: 'mcp_token_saver_status', object: 'inactive' });
  await provider.addTemporalFact({
    id: 'memfact_mcp_old',
    workspaceId: 'ws_local',
    scope: 'workspace',
    subject: 'project:oaf',
    predicate: 'mcp_token_saver_status',
    object: 'inactive',
    text: 'OAF MCP token saver is inactive token=secret-value /Users/rebel/private.txt.',
    source: 'workspace://memory/old-private.md',
    proposalQueueId: 'mpq_mcp_old',
    validFrom: '2026-06-26T09:00:00.000Z',
    episode: {
      id: 'mep_mcp_old',
      sourceLocator: 'workspace://memory/old-private.md',
      summary: 'Old local note with token=secret-value.',
      observedAt: '2026-06-26T09:00:00.000Z'
    }
  });
  await approve('mpq_mcp_ready', { kind: 'fact', subject: 'project:oaf', predicate: 'mcp_token_saver_status', object: 'ready' });
  await provider.addTemporalFact({
    id: 'memfact_mcp_ready',
    workspaceId: 'ws_local',
    scope: 'workspace',
    subject: 'project:oaf',
    predicate: 'mcp_token_saver_status',
    object: 'ready',
    text: Array(80).fill('mcp token saver').join(' ') + ' ready for local coding-agent context.',
    source: 'workspace://docs/superpowers/plans/2026-06-26-mcp-token-saver.md',
    proposalQueueId: 'mpq_mcp_ready',
    validFrom: '2026-06-26T10:00:00.000Z',
    episode: {
      id: 'mep_mcp_ready',
      sourceLocator: 'workspace://docs/superpowers/plans/2026-06-26-mcp-token-saver.md',
      summary: 'MCP token saver is ready for local stdio use.',
      observedAt: '2026-06-26T10:00:00.000Z'
    }
  });
  provider.close();
  providerClosed = true;
  const env = { ...process.env, OAF_FIXED_NOW: '2026-06-26T11:00:00.000Z' };
  const input = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory.recall', arguments: { query: 'mcp token saver ready', scope: 'workspace', limit: 5 } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'context.profile', arguments: { objective: 'mcp token saver ready', step: 'serve coding agent context', budget: 256, limit: 10 } } })
  ].join('\n');
  const result = spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'mcp', 'server', '--read-only', '--root', root, '--stdio'], { encoding: 'utf8', env, input });
  assert.equal(result.status, 0, result.stderr);
  assert(!result.stderr.includes('token=secret-value'));
  assert(!result.stderr.includes('/Users/rebel'));
  assert(!result.stdout.includes('token=secret-value'));
  assert(!result.stdout.includes('/Users/rebel'));
  const lines = result.stdout.trim().split(/\n/u).map((line) => JSON.parse(line));
  assert.equal(lines.length, 4);
  assert.equal(lines[0].result.protocolVersion, '2025-06-18');
  assert.deepEqual(lines[1].result.tools.map((tool) => tool.name).sort(), ['context.pack', 'context.profile', 'memory.recall']);
  const recall = JSON.parse(lines[2].result.content[0].text);
  assert.equal(recall.command, 'memory.recall');
  assert.equal(recall.data.available, true);
  assert.equal(recall.data.factCount, 1);
  assert.equal(recall.data.facts[0].id, 'memfact_mcp_ready');
  assert.equal(recall.data.facts[0].status, 'active');
  assert.equal(recall.data.facts[0].validityWindow.validFrom, '2026-06-26T10:00:00.000Z');
  assert.equal(recall.data.facts[0].provenance.sourceLocator, 'workspace://docs/superpowers/plans/2026-06-26-mcp-token-saver.md');
  assert(recall.data.facts[0].supersessionChain.some((item) => item.id === 'memfact_mcp_old' && item.status === 'superseded' && item.supersededBy === 'memfact_mcp_ready'));
  assert.equal(recall.safeguards.networkCalls, 0);
  assert.equal(recall.safeguards.modelCalls, 0);
  const profile = JSON.parse(lines[3].result.content[0].text);
  assert.equal(profile.command, 'context.profile');
  assert.equal(profile.data.contextBudget.estimatedDeliveryTokens, profile.data.selectedContext.budget.used);
  assert(profile.data.contextBudget.estimatedDeliveryTokens > 0);
  assert(profile.data.contextBudget.historyTokensAvailable > profile.data.contextBudget.estimatedDeliveryTokens);
  assert(profile.data.tokenSavingPercent > 0);
  assert.equal(profile.data.profile.acceptedHistoryRecordCount, 1);
  assert.equal(profile.safeguards.canonicalStateMutated, false);
});
test('mcp install dry-run prints exact token-saver config for coding clients without writes', () => {
  const root = path.resolve('.');
  const sqlitePath = path.join(root, '.local', 'memory.sqlite');
  const statsPath = path.join(root, '.local', 'mcp-stats.jsonl');
  const expectedArgs = [path.join(root, 'apps', 'cli', 'oaf.mjs'), 'mcp', 'server', '--read-only', '--root', root, '--sqlite', sqlitePath, '--stats', statsPath, '--stdio'];
  for (const client of ['claude-code', 'cursor', 'codex']) {
    const home = mkdtempSync(path.join(os.tmpdir(), `oaf-cli-mcp-install-${client}-`));
    const result = spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'mcp', 'install', '--client', client, '--home', home, '--format', 'json'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.includes(home), false);
    const report = JSON.parse(result.stdout);
    assert.equal(report.command, 'mcp install');
    assert.equal(report.dryRun, true);
    assert.equal(report.apply.requested, false);
    assert.equal(report.apply.applied, false);
    assert.equal(report.client, client);
    assert.equal(report.server, 'oaf');
    assert.equal(report.bridgeMode, 'token-saver');
    assert.equal(report.config.ref.startsWith('home://'), true);
    assert.equal(report.config.exists, false);
    assert.equal(report.status.server, 'absent');
    assert.equal(report.workspaceRoot, root);
    assert.equal(report.memory.sqlitePath, sqlitePath);
    assert.equal(report.memory.sqliteRef, 'workspace://.local/memory.sqlite');
    assert.equal(report.stats.statsPath, statsPath);
    assert.equal(report.stats.statsRef, 'workspace://.local/mcp-stats.jsonl');
    assert.equal(report.desiredServer.command, process.execPath);
    assert.deepEqual(report.desiredServer.args, expectedArgs);
    assert.equal(report.desiredServer.resourceMode, 'read-only-token-saver');
    assert.equal(report.safeguards.localFilesWritten, 0);
    assert.equal(report.safeguards.homeConfigMutated, false);
    assert.equal(report.safeguards.externalWritesEnabled, false);
    assert.equal(report.safeguards.networkCalls, 0);
    assert.equal(report.safeguards.modelCalls, 0);
    assert.match(report.planFingerprint, /^sha256:[a-f0-9]{64}$/);
    assert.match(report.nextCommand, new RegExp(`mcp install --client ${client} --root .* --apply --confirm sha256:[a-f0-9]{64} --format json`));
    if (client === 'codex') {
      assert.match(report.manualConfigSnippet.content, /\[mcp_servers\.oaf\]/);
      assert.match(report.manualConfigSnippet.content, /--sqlite/);
      assert.equal(report.reversal.target, 'mcp_servers.oaf');
      assert.equal(existsSync(path.join(home, '.codex', 'config.toml')), false);
    } else {
      assert.match(report.manualConfigSnippet.content, /"mcpServers"/);
      assert.match(report.manualConfigSnippet.content, /--sqlite/);
      assert.equal(report.reversal.target, 'mcpServers.oaf');
      const configPath = client === 'cursor' ? '.cursor/mcp.json' : '.claude/mcp.json';
      assert.equal(existsSync(path.join(home, configPath)), false);
    }
  }
});

test('mcp install apply requires matching confirmation before writing config', () => {
  const root = path.resolve('.');
  const expectedArgs = [path.join(root, 'apps', 'cli', 'oaf.mjs'), 'mcp', 'server', '--read-only', '--root', root, '--sqlite', path.join(root, '.local', 'memory.sqlite'), '--stats', path.join(root, '.local', 'mcp-stats.jsonl'), '--stdio'];
  const home = mkdtempSync(path.join(os.tmpdir(), 'oaf-cli-mcp-install-apply-'));
  const configPath = path.join(home, '.cursor', 'mcp.json');
  const preview = spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'mcp', 'install', '--client', 'cursor', '--home', home, '--format', 'json'], { encoding: 'utf8' });
  assert.equal(preview.status, 0, preview.stderr);
  const previewReport = JSON.parse(preview.stdout);
  assert.equal(previewReport.status.server, 'absent');
  assert.equal(existsSync(configPath), false);

  const missingConfirm = spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'mcp', 'install', '--client', 'cursor', '--home', home, '--apply', '--format', 'json'], { encoding: 'utf8' });
  assert.equal(missingConfirm.status, 2);
  assert.match(missingConfirm.stderr, /requires --confirm <planFingerprint>/);
  assert.equal(missingConfirm.stdout, '');
  assert.equal(existsSync(configPath), false);

  const wrongConfirm = spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'mcp', 'install', '--client', 'cursor', '--home', home, '--apply', '--confirm', 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '--format', 'json'], { encoding: 'utf8' });
  assert.equal(wrongConfirm.status, 2);
  assert.match(wrongConfirm.stderr, /requires --confirm <planFingerprint>/);
  assert.equal(wrongConfirm.stdout, '');
  assert.equal(existsSync(configPath), false);

  const applied = spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'mcp', 'install', '--client', 'cursor', '--home', home, '--apply', '--confirm', previewReport.planFingerprint, '--format', 'json'], { encoding: 'utf8' });
  assert.equal(applied.status, 0, applied.stderr);
  const appliedReport = JSON.parse(applied.stdout);
  assert.equal(appliedReport.dryRun, false);
  assert.equal(appliedReport.apply.requested, true);
  assert.equal(appliedReport.apply.confirmed, true);
  assert.equal(appliedReport.apply.applied, true);
  assert.equal(appliedReport.safeguards.localFilesWritten, 1);
  assert.equal(appliedReport.safeguards.homeConfigMutated, true);
  assert.equal(appliedReport.nextCommand, null);
  assert.equal(appliedReport.reversal.target, 'mcpServers.oaf');
  assert.equal(existsSync(configPath), true);
  const written = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(written.mcpServers.oaf.command, process.execPath);
  assert.deepEqual(written.mcpServers.oaf.args, expectedArgs);

  const after = spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'mcp', 'install', '--client', 'cursor', '--home', home, '--format', 'json'], { encoding: 'utf8' });
  assert.equal(after.status, 0, after.stderr);
  const afterReport = JSON.parse(after.stdout);
  assert.equal(afterReport.status.server, 'installed');
  assert.deepEqual(afterReport.desiredServer.args, expectedArgs);
});

test('mcp install emits portable server config that works from another cwd', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaf-cli-mcp-install-portable-root-'));
  const home = mkdtempSync(path.join(os.tmpdir(), 'oaf-cli-mcp-install-portable-home-'));
  const otherCwd = mkdtempSync(path.join(os.tmpdir(), 'oaf-cli-mcp-install-portable-cwd-'));
  mkdirSync(path.join(root, 'docs', 'adr'), { recursive: true });
  writeFileSync(path.join(root, 'README.md'), 'Portable MCP memory should recall proposal-gated workspace facts from any agent cwd.');
  writeFileSync(path.join(root, 'AGENTS.md'), 'Keep MCP memory local-first, read-only by default, and proposal gated.');
  writeFileSync(path.join(root, 'docs', 'adr', '0001-portable-mcp.md'), 'Portable MCP install uses absolute root and SQLite memory paths.');
  const ingest = spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'memory', 'ingest', '--root', root, '--sqlite', '.local/memory.sqlite', '--format', 'json'], { encoding: 'utf8' });
  assert.equal(ingest.status, 0, ingest.stderr);
  assert(JSON.parse(ingest.stdout).summary.proposalCount > 0);
  const install = spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'mcp', 'install', '--client', 'claude-code', '--home', home, '--root', root, '--format', 'json'], { encoding: 'utf8' });
  assert.equal(install.status, 0, install.stderr);
  const report = JSON.parse(install.stdout);
  assert.equal(report.desiredServer.command, process.execPath);
  assert.equal(report.desiredServer.args.includes(report.workspaceRoot), true);
  assert.equal(report.desiredServer.args.includes(report.memory.sqlitePath), true);
  assert.equal(report.desiredServer.args.includes(report.stats.statsPath), true);
  const input = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory.recall', arguments: { query: 'portable MCP memory proposal gated', limit: 5 } } })
  ].join('\n');
  const served = spawnSync(report.desiredServer.command, report.desiredServer.args, { cwd: otherCwd, encoding: 'utf8', input });
  assert.equal(served.status, 0, served.stderr);
  const lines = served.stdout.trim().split(/\n/u).map((line) => JSON.parse(line));
  const recall = JSON.parse(lines[1].result.content[0].text);
  assert.equal(recall.data.available, true);
  assert(recall.data.proposalFactCount > 0);
  assert.equal(recall.safeguards.readOnly, true);
});

test('mcp server records delivery-token stats and stats command summarizes them', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaf-cli-mcp-stats-root-'));
  mkdirSync(path.join(root, '.local'), { recursive: true });
  mkdirSync(path.join(root, 'docs', 'product'), { recursive: true });
  mkdirSync(path.join(root, 'docs', 'superpowers', 'plans'), { recursive: true });
  writeFileSync(path.join(root, 'AGENTS.md'), `${Array(320).fill('MCP_STATS_REALISTIC_RAW_BODY memory profile token saver').join(' ')}`);
  writeFileSync(path.join(root, 'README.md'), `${Array(320).fill('MCP_STATS_REALISTIC_RAW_BODY workspace coding agent context').join(' ')}`);
  writeFileSync(path.join(root, 'docs', 'product', 'loop-workbench-build-plan.md'), `${Array(320).fill('MCP_STATS_REALISTIC_RAW_BODY checkpoint benchmark').join(' ')}`);
  writeFileSync(path.join(root, 'docs', 'superpowers', 'plans', '2026-06-26-mcp-token-saver.md'), `${Array(320).fill('MCP_STATS_REALISTIC_RAW_BODY context profile savings').join(' ')}`);
  const sqlitePath = path.join(root, '.local', 'memory.sqlite');
  const statsPath = path.join(root, '.local', 'mcp-stats.jsonl');
  const provider = new SQLiteMemoryProvider({ filename: sqlitePath, clock: () => '2026-06-26T12:00:00.000Z' });
  await provider.put({
    id: 'mem_mcp_stats_profile',
    workspaceId: 'ws_local',
    kind: 'decision',
    text: `${Array(160).fill('mcp-stats-profile').join(' ')} should stay summarized.`,
    source: 'workspace://docs/mcp-stats.md',
    status: 'active',
    confidence: 0.9,
    authority: 0.9,
    updatedAt: '2026-06-26T12:00:00.000Z'
  });
  await provider.enqueueProposal({
    id: 'mpq_mcp_stats_fact',
    workspaceId: 'ws_local',
    sourceLocator: 'workspace://docs/mcp-stats.md',
    sourceHash: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    payload: { kind: 'fact', subject: 'project:oaf', predicate: 'mcp_stats', object: 'records-delivery' }
  });
  await provider.claimProposal({ workspaceId: 'ws_local', workerId: 'stats-test', leaseUntil: '2026-06-26T12:05:00.000Z' });
  await provider.recordProposalResult({ workspaceId: 'ws_local', id: 'mpq_mcp_stats_fact', workerId: 'stats-test', status: 'applied', result: { accepted: true } });
  await provider.addTemporalFact({
    id: 'memfact_mcp_stats',
    workspaceId: 'ws_local',
    scope: 'workspace',
    subject: 'project:oaf',
    predicate: 'mcp_stats',
    object: 'records-delivery',
    text: 'MCP stats record delivery-token estimates for memory.recall and context.profile.',
    source: 'workspace://docs/mcp-stats.md',
    validFrom: '2026-06-26T12:00:00.000Z',
    proposalQueueId: 'mpq_mcp_stats_fact',
    episode: {
      id: 'mep_mcp_stats',
      sourceLocator: 'workspace://docs/mcp-stats.md',
      summary: 'MCP stats proof.',
      observedAt: '2026-06-26T12:00:00.000Z'
    }
  });
  provider.close();
  const input = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory.recall', arguments: { query: 'mcp stats delivery', limit: 5 } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'context.profile', arguments: { objective: 'mcp stats delivery', step: 'summarize delivery savings', budget: 256, limit: 10 } } })
  ].join('\n');
  const env = { ...process.env, OAF_FIXED_NOW: '2026-06-26T12:00:00.000Z' };
  const served = spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'mcp', 'server', '--read-only', '--root', root, '--sqlite', '.local/memory.sqlite', '--stats', '.local/mcp-stats.jsonl', '--stdio'], { encoding: 'utf8', env, input });
  assert.equal(served.status, 0, served.stderr);
  const responses = served.stdout.trim().split(/\n/u).map((line) => JSON.parse(line));
  const recall = JSON.parse(responses[1].result.content[0].text);
  const profile = JSON.parse(responses[2].result.content[0].text);
  assert(recall.data.deliveryEstimate.deliveredTokens > 0);
  assert.equal(recall.data.deliveryEstimate.providerBillingClaimed, false);
  assert.equal(recall.data.sessionStats.callCount, 1);
  assert(profile.data.deliveryEstimate.deliveredTokens > 0);
  assert.equal(profile.data.deliveryEstimate.providerBillingClaimed, false);
  assert.equal(profile.data.sessionStats.callCount, 2);
  const stats = spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'mcp', 'stats', '--read-only', '--root', root, '--stats', '.local/mcp-stats.jsonl', '--format', 'json'], { encoding: 'utf8', env });
  assert.equal(stats.status, 0, stats.stderr);
  const report = JSON.parse(stats.stdout);
  assert.equal(report.command, 'mcp stats');
  assert.equal(report.summary.callCount, 2);
  assert(report.summary.deliveredTokens > 0);
  assert(report.summary.baselineTokens > 0);
  assert(report.summary.tokensSaved >= 0);
  assert.equal(report.summary.providerBillingClaimed, false);
  assert.deepEqual(report.byTool.map((item) => item.toolName).sort(), ['context.profile', 'memory.recall']);
  assert.equal(report.realisticBenchmark.available, true);
  assert(report.realisticBenchmark.beforeDeliveryTokens > report.realisticBenchmark.afterDeliveryTokens);
  assert(report.realisticBenchmark.percent > 0);
  assert.equal(report.realisticBenchmark.providerBillingClaimed, false);
  assert.equal(report.safeguards.readOnly, true);
  assert.equal(report.safeguards.localFilesWritten, 0);
  assert.equal(stats.stdout.includes('MCP_STATS_REALISTIC_RAW_BODY'), false);
  const summary = spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'mcp', 'stats', '--read-only', '--root', root, '--stats', '.local/mcp-stats.jsonl', '--format', 'summary'], { encoding: 'utf8', env });
  assert.equal(summary.status, 0, summary.stderr);
  assert.match(summary.stdout, /MCP delivery calls: 2/);
  assert.match(summary.stdout, /Realistic context\.profile saving: \d+%/);
});
test('mcp resources CLI lists, reads, and serves sanitized read-only resources over stdio',()=>{const root=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-mcp-'));mkdirSync(path.join(root,'.local'),{recursive:true});writeFileSync(path.join(root,'PROJECT_STATUS.json'),JSON.stringify({release:'0.2.0-dev',phase:'local-test',nextTask:'OAF-031',defaults:{network:'deny',externalWrites:false,modelMode:'deterministic',dataResidency:'local-only',adapters:'disabled'}},null,2));writeFileSync(path.join(root,'.local','state.json'),JSON.stringify({schemaVersion:'1.0.0',runs:[{id:'run_cli_mcp',workspaceId:'ws_local',workflowId:'workflow:content-intelligence',objective:'Do not print this private objective.',status:'completed',residency:'local-only',createdAt:'2026-06-24T00:00:00.000Z',output:{text:'private model result'}}],events:[{id:'evt_cli_ctx',workspaceId:'ws_local',runId:'run_cli_mcp',sequence:1,type:'context.compiled',occurredAt:'2026-06-24T00:00:00.000Z',payload:{id:'ctx_cli',compilerVersion:'context-compiler@1.0.0',budget:{available:100,used:20},selected:[{id:'doc_cli',kind:'instruction',tokens:20,reasonCodes:['explicit_requirement'],source:'workspace://memory/old-private.md',text:'raw prompt body token=secret'}],excluded:[]}},{id:'evt_other',workspaceId:'ws_other',runId:'run_other',sequence:1,type:'run.started',occurredAt:'2026-06-24T00:00:00.000Z',payload:{text:'other workspace'}}],memories:[{id:'mem_cli_prop',workspaceId:'ws_local',kind:'decision',status:'proposed',decision:'review',confidence:0.6,text:'private memory text'}],approvals:[],artifacts:[]},null,2));const env={...process.env,OAF_FIXED_NOW:'2026-06-24T00:00:00.000Z'};const listed=spawnSync(process.execPath,['apps/cli/oaf.mjs','mcp','resources','--read-only','--root',root,'--format','json'],{encoding:'utf8',env});assert.equal(listed.status,0,listed.stderr);const listing=JSON.parse(listed.stdout);assert.equal(listing.mode,'read-only');assert.equal(listing.resources.length,5);assert(listing.resources.some(item=>item.uri==='oaf://workspace/ws_local/status'));assert.equal(listing.safeguards.externalWritesEnabled,false);const read=spawnSync(process.execPath,['apps/cli/oaf.mjs','mcp','resources','--read-only','--root',root,'--uri','oaf://workspace/ws_local/context/latest','--format','json'],{encoding:'utf8',env});assert.equal(read.status,0,read.stderr);const envelope=JSON.parse(read.stdout);const payload=JSON.parse(envelope.contents[0].text);assert.equal(payload.resourceKind,'context-manifest-summary');assert.equal(payload.data.contextManifest.selectedCount,1);assert.match(payload.resourceFingerprint,/^sha256:[a-f0-9]{64}$/);assert(!read.stdout.includes('raw prompt body'));assert(!read.stdout.includes('private objective'));assert(!read.stdout.includes('private model result'));assert(!read.stdout.includes('private memory text'));assert(!read.stdout.includes('/Users/rebel'));const stdioInput=['{"jsonrpc":"2.0","id":1,"method":"resources/list"}',JSON.stringify({jsonrpc:'2.0',id:2,method:'resources/read',params:{uri:'oaf://workspace/ws_local/status'}})].join('\n');const stdio=spawnSync(process.execPath,['apps/cli/oaf.mjs','mcp','resources','--read-only','--root',root,'--stdio'],{encoding:'utf8',env,input:stdioInput});assert.equal(stdio.status,0,stdio.stderr);const lines=stdio.stdout.trim().split(/\n/u).map(line=>JSON.parse(line));assert.equal(lines[0].result.resources.length,5);const statusPayload=JSON.parse(lines[1].result.contents[0].text);assert.equal(statusPayload.data.counts.runs,1);assert.equal(statusPayload.data.counts.proposedMemories,1);assert.equal(statusPayload.safeguards.canonicalStateMutated,false);});
test('mcp resources CLI bounds stdio input without echoing raw request bytes',()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-mcp-stdio-bounds-'));
  const env={...process.env,OAF_FIXED_NOW:'2026-06-24T00:00:00.000Z'};
  const args=['apps/cli/oaf.mjs','mcp','resources','--read-only','--root',root,'--stdio'];
  const oversized='RAW_SECRET_SENTINEL_'.repeat(4096);
  const tooLarge=spawnSync(process.execPath,args,{encoding:'utf8',env,input:oversized});
  assert.equal(tooLarge.status,2);
  assert.equal(tooLarge.stdout,'');
  assert.match(tooLarge.stderr,/stdio input exceeds 65536 bytes/);
  assert.equal(tooLarge.stderr.includes('RAW_SECRET_SENTINEL'),false);
  const longLine=JSON.stringify({jsonrpc:'2.0',id:1,method:'resources/list',params:{private:'LINE_SECRET_SENTINEL_'.repeat(1800)}});
  const oversizedLine=spawnSync(process.execPath,args,{encoding:'utf8',env,input:longLine});
  assert.equal(oversizedLine.status,2);
  assert.equal(oversizedLine.stdout,'');
  assert.match(oversizedLine.stderr,/JSON-RPC line 1 exceeds 32768 bytes/);
  assert.equal(oversizedLine.stderr.includes('LINE_SECRET_SENTINEL'),false);
});

test('mcp resources CLI rejects stdio message-count and batch bypasses',()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-mcp-stdio-shape-'));
  const env={...process.env,OAF_FIXED_NOW:'2026-06-24T00:00:00.000Z'};
  const args=['apps/cli/oaf.mjs','mcp','resources','--read-only','--root',root,'--stdio'];
  const tooMany=Array.from({length:17},(_,index)=>JSON.stringify({jsonrpc:'2.0',id:index+1,method:'resources/list'})).join('\n');
  const tooManyResult=spawnSync(process.execPath,args,{encoding:'utf8',env,input:tooMany});
  assert.equal(tooManyResult.status,2);
  assert.equal(tooManyResult.stdout,'');
  assert.match(tooManyResult.stderr,/too many JSON-RPC messages/);
  const batch=spawnSync(process.execPath,args,{encoding:'utf8',env,input:JSON.stringify([{jsonrpc:'2.0',id:1,method:'resources/list'}])});
  assert.equal(batch.status,2);
  assert.equal(batch.stdout,'');
  assert.match(batch.stderr,/JSON-RPC batches are not supported/);
  const malformed=spawnSync(process.execPath,args,{encoding:'utf8',env,input:'{"jsonrpc":"2.0","id":"MALFORMED_SECRET_SENTINEL"'});
  assert.equal(malformed.status,2);
  assert.equal(malformed.stdout,'');
  assert.match(malformed.stderr,/JSON-RPC line 1 is not valid JSON/);
  assert.equal(malformed.stderr.includes('MALFORMED_SECRET_SENTINEL'),false);
});

test('mcp resources CLI redacts stdio JSON-RPC error metadata',()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-mcp-stdio-redact-'));
  const env={...process.env,OAF_FIXED_NOW:'2026-06-24T00:00:00.000Z'};
  const args=['apps/cli/oaf.mjs','mcp','resources','--read-only','--root',root,'--stdio'];
  const input=[
    JSON.stringify({jsonrpc:'2.0',id:1,method:'resources/read',params:{uri:'oaf://workspace/ws_local/runs//Users/rebel/private?token=secret-value'}}),
    JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'oaf.secretTool./Users/rebel/token=secret-value',arguments:{}}}),
    JSON.stringify({jsonrpc:'2.0',id:3,method:'unsupported./Users/rebel/token=secret-value',params:{}}),
    JSON.stringify({jsonrpc:'2.0',id:'ID_SECRET_SENTINEL_'.repeat(16),method:'resources/list'})
  ].join('\n');
  const result=spawnSync(process.execPath,args,{encoding:'utf8',env,input});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stderr,'');
  const responses=result.stdout.trim().split(/\n/u).map(line=>JSON.parse(line));
  assert.deepEqual(responses.map(response=>response.error?.data?.code),[
    'mcp_method_not_found',
    'mcp_method_not_found',
    'mcp_method_not_found',
    'mcp_invalid_request'
  ]);
  assert.equal(responses[0].error.message,'unknown MCP resource');
  assert.equal(responses[1].error.message,'unknown MCP tool');
  assert.equal(responses[2].error.message,'unsupported MCP method');
  assert.equal(responses[3].id,null);
  assert.equal(responses[3].error.message,'MCP bridge request id exceeds limit');
  for(const forbidden of ['/Users/rebel','secret-value','ID_SECRET_SENTINEL',root]){
    assert.equal(result.stdout.includes(forbidden),false,forbidden);
  }
});

test('mcp smoke context-pack bounds child stdio output and runtime',()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-mcp-smoke-caps-'));
  mkdirSync(path.join(root,'notes'),{recursive:true});
  mkdirSync(path.join(root,'src'),{recursive:true});
  writeFileSync(path.join(root,'AGENTS.md'),'CAP SMOKE AGENTS RAW BODY should stay hidden.');
  writeFileSync(path.join(root,'notes','handoff.md'),'CAP SMOKE SELECTED RAW BODY should stay hidden.');
  writeFileSync(path.join(root,'src','auth.ts'),"export function capSmoke() { return 'CAP SMOKE AUTH RAW BODY'; }\n");
  const objective='Private cap smoke objective must not leak';
  const step='Private cap smoke step must not leak';
  const args=['apps/cli/oaf.mjs','mcp','smoke','context-pack','--read-only','--root',root,'--objective',objective,'--step',step,'--target','codex','--include-file','notes/handoff.md','--changed','src/auth.ts','--format','json'];
  const capped=spawnSync(process.execPath,args,{encoding:'utf8',env:{...process.env,OAF_FIXED_NOW:'2026-06-24T00:00:00.000Z',OAF_MCP_STDIO_CHILD_MAX_STDOUT_BYTES:'64'}});
  assert.equal(capped.status,2);
  assert.equal(capped.stdout,'');
  assert.match(capped.stderr,/mcp stdio child stdout exceeded 64 bytes/);
  const timedOut=spawnSync(process.execPath,args,{encoding:'utf8',env:{...process.env,OAF_FIXED_NOW:'2026-06-24T00:00:00.000Z',OAF_MCP_STDIO_CHILD_TIMEOUT_MS:'1'}});
  assert.equal(timedOut.status,2);
  assert.equal(timedOut.stdout,'');
  assert.match(timedOut.stderr,/mcp stdio child timed out after 1ms/);
  for(const output of [capped.stderr,timedOut.stderr]){
    for(const forbidden of ['CAP SMOKE AGENTS RAW BODY','CAP SMOKE SELECTED RAW BODY','CAP SMOKE AUTH RAW BODY',objective,step,root,'/Users/rebel']){
      assert.equal(output.includes(forbidden),false,forbidden);
    }
  }
});

test('mcp resources CLI exposes opt-in current context-pack summary without raw content',()=>{const root=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-mcp-context-pack-'));mkdirSync(path.join(root,'notes'),{recursive:true});mkdirSync(path.join(root,'src'),{recursive:true});writeFileSync(path.join(root,'AGENTS.md'),'Use approve token reset workflow guidance. AGENTS RAW MCP BODY should stay out of MCP output.');writeFileSync(path.join(root,'notes','handoff.md'),'SELECTED RAW MCP BODY should stay out of MCP output.');writeFileSync(path.join(root,'src','auth.ts'),['export function approveTokenReset() {',"  return 'AUTH RAW MCP BODY';",'}'].join('\n'));const env={...process.env,OAF_FIXED_NOW:'2026-06-24T00:00:00.000Z'};const baseArgs=['apps/cli/oaf.mjs','mcp','resources','--read-only','--context-pack','--root',root,'--objective','Private MCP objective must not leak','--step','Private MCP step must not leak','--target','codex','--include-file','notes/handoff.md','--changed','src/auth.ts','--format','json'];const listed=spawnSync(process.execPath,baseArgs,{encoding:'utf8',env});assert.equal(listed.status,0,listed.stderr);const listing=JSON.parse(listed.stdout);assert.equal(listing.resources.length,6);assert(listing.resources.some(item=>item.uri==='oaf://workspace/ws_local/context-pack/current'));const read=spawnSync(process.execPath,[...baseArgs,'--uri','oaf://workspace/ws_local/context-pack/current'],{encoding:'utf8',env});assert.equal(read.status,0,read.stderr);const envelope=JSON.parse(read.stdout);const payload=JSON.parse(envelope.contents[0].text);assert.equal(payload.resourceKind,'context-pack-summary');assert.equal(payload.provenance.source,'local-context-pack');assert.equal(payload.data.targetHarness,'codex');assert.match(payload.data.objectiveFingerprint,/^sha256:[a-f0-9]{64}$/);assert.equal(payload.data.readFirst.some(item=>item.locator==='user-selected://notes/handoff.md'),true);assert.equal(payload.data.sourceGraph.impact.changedLocators.includes('workspace://src/auth.ts'),true);assert.equal(payload.data.markdownArtifact.included,false);assert.equal(payload.safeguards.readOnly,true);assert.equal(payload.safeguards.canonicalStateMutated,false);assert.equal(payload.safeguards.networkCalls,0);assert.equal(payload.safeguards.modelCalls,0);for(const forbidden of ['AGENTS RAW MCP BODY','SELECTED RAW MCP BODY','AUTH RAW MCP BODY','Private MCP objective must not leak','Private MCP step must not leak',root,'/Users/rebel'])assert.equal(read.stdout.includes(forbidden),false,forbidden);assert.equal(existsSync(path.join(root,'context-packs','CONTEXT_PACK.md')),false);const stdioInput=['{"jsonrpc":"2.0","id":1,"method":"resources/list"}','{"jsonrpc":"2.0","id":2,"method":"tools/list"}',JSON.stringify({jsonrpc:'2.0',id:3,method:'resources/read',params:{uri:'oaf://workspace/ws_local/context-pack/current'}})].join('\n');const stdio=spawnSync(process.execPath,[...baseArgs,'--stdio'],{encoding:'utf8',env,input:stdioInput});assert.equal(stdio.status,0,stdio.stderr);const lines=stdio.stdout.trim().split(/\n/u).map(line=>JSON.parse(line));assert.equal(lines[0].result.resources.some(item=>item.uri==='oaf://workspace/ws_local/context-pack/current'),true);assert.deepEqual(lines[1].result.tools,[]);const stdioPayload=JSON.parse(lines[2].result.contents[0].text);assert.equal(stdioPayload.resourceKind,'context-pack-summary');assert.equal(stdioPayload.data.readFirst.some(item=>item.locator==='user-selected://notes/handoff.md'),true);const missingStep=spawnSync(process.execPath,['apps/cli/oaf.mjs','mcp','resources','--read-only','--context-pack','--root',root,'--objective','missing step','--format','json'],{encoding:'utf8',env});assert.equal(missingStep.status,2);assert.match(missingStep.stderr,/requires --objective .* --step/);const writeMode=spawnSync(process.execPath,[...baseArgs,'--write'],{encoding:'utf8',env});assert.equal(writeMode.status,2);assert.match(writeMode.stderr,/read-only/);const outMode=spawnSync(process.execPath,[...baseArgs,'--out','context-packs/CONTEXT_PACK.md'],{encoding:'utf8',env});assert.equal(outMode.status,2);assert.match(outMode.stderr,/read-only/);const tooManyChanged=spawnSync(process.execPath,[...baseArgs,...Array.from({length:17},(_,index)=>['--changed',`src/file${index}.ts`]).flat()],{encoding:'utf8',env});assert.equal(tooManyChanged.status,2);assert.match(tooManyChanged.stderr,/changed_context_too_many_locators/);});

test('mcp resources CLI redacts unknown resource URIs in errors',()=>{
  const result=spawnSync(process.execPath,[
    'apps/cli/oaf.mjs',
    'mcp',
    'resources',
    '--read-only',
    '--uri',
    'oaf://workspace/ws_local/runs//Users/rebel/private?token=secret-value',
    '--format',
    'json'
  ],{encoding:'utf8'});
  assert.equal(result.status,2);
  assert.equal(result.stdout,'');
  assert.match(result.stderr,/unknown MCP resource: sha256:[a-f0-9]{64}/);
  for(const forbidden of ['/Users/rebel','token=secret-value','private?token'])assert.equal(result.stderr.includes(forbidden),false,forbidden);
});

test('mcp smoke context-pack proves stdio resource read with observed measurements',()=>{const root=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-mcp-smoke-'));mkdirSync(path.join(root,'notes'),{recursive:true});mkdirSync(path.join(root,'src'),{recursive:true});writeFileSync(path.join(root,'AGENTS.md'),'Use approve token reset workflow guidance. SMOKE AGENTS RAW BODY should stay hidden.');writeFileSync(path.join(root,'notes','handoff.md'),'SMOKE SELECTED RAW BODY should stay hidden.');writeFileSync(path.join(root,'src','auth.ts'),['export function approveTokenReset() {',"  return 'SMOKE AUTH RAW BODY';",'}'].join('\n'));const env={...process.env,OAF_FIXED_NOW:'2026-06-24T00:00:00.000Z'};const objective='Private smoke objective must not leak';const step='Private smoke step must not leak';const result=spawnSync(process.execPath,['apps/cli/oaf.mjs','mcp','smoke','context-pack','--read-only','--root',root,'--objective',objective,'--step',step,'--target','codex','--include-file','notes/handoff.md','--changed','src/auth.ts','--format','json'],{encoding:'utf8',env});assert.equal(result.status,0,result.stderr);const report=JSON.parse(result.stdout);assert.equal(report.command,'mcp smoke context-pack');assert.equal(report.transport,'stdio');assert.equal(report.resource.resourceKind,'context-pack-summary');assert.match(report.reportFingerprint,/^sha256:[a-f0-9]{64}$/);assert(report.measurements.durationMs>=0);assert(report.measurements.stdoutByteSize>0);assert(report.measurements.resourceByteSize>0);assert(report.measurements.candidateUnitCount>=report.measurements.selectedUnitCount);assert(report.measurements.selectedUnitRatio>=0);assert(report.measurements.selectedUnitRatio<=1);assert(report.measurements.observedReductionRatio>=0);assert(report.measurements.observedReductionRatio<=1);assert(report.measurements.deliveredUnitCount>0);assert(report.measurements.deliveredUnitRatio>=0);assert(report.measurements.observedDeliveryReductionRatio>=0);assert(report.measurements.observedDeliveryReductionRatio<=1);assert.equal(report.bridge.toolsExposed,0);assert.equal(report.checks.resourceListed,true);assert.equal(report.checks.resourceRead,true);assert.equal(report.checks.noToolsExposed,true);assert.equal(report.checks.noMarkdownBody,true);assert.equal(report.safeguards.readOnly,true);assert.equal(report.safeguards.localFilesWritten,0);assert.equal(report.safeguards.externalWritesEnabled,false);assert.equal(report.safeguards.externalAdaptersEnabled,0);assert.equal(report.safeguards.networkCalls,0);assert.equal(report.safeguards.modelCalls,0);assert.equal(report.safeguards.activeMemoryCreated,0);assert.equal(report.resource.readFirstLocators.some(locator=>locator==='user-selected://notes/handoff.md'),true);assert.equal(report.resource.changedLocators.includes('workspace://src/auth.ts'),true);for(const forbidden of ['SMOKE AGENTS RAW BODY','SMOKE SELECTED RAW BODY','SMOKE AUTH RAW BODY',objective,step,root,'/Users/rebel'])assert.equal(result.stdout.includes(forbidden),false,forbidden);assert.equal(existsSync(path.join(root,'context-packs','CONTEXT_PACK.md')),false);const missingReadOnly=spawnSync(process.execPath,['apps/cli/oaf.mjs','mcp','smoke','context-pack','--root',root,'--objective',objective,'--step',step,'--format','json'],{encoding:'utf8',env});assert.equal(missingReadOnly.status,2);assert.match(missingReadOnly.stderr,/--read-only/);const writeMode=spawnSync(process.execPath,['apps/cli/oaf.mjs','mcp','smoke','context-pack','--read-only','--root',root,'--objective',objective,'--step',step,'--write','--format','json'],{encoding:'utf8',env});assert.equal(writeMode.status,2);assert.match(writeMode.stderr,/read-only/);});
test('measure context-pack reports real local reduction and readback without writes',()=>{const root=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-measure-context-pack-'));mkdirSync(path.join(root,'notes'),{recursive:true});mkdirSync(path.join(root,'src'),{recursive:true});writeFileSync(path.join(root,'AGENTS.md'),'Measure context pack guidance. MEASURE AGENTS RAW BODY should stay hidden.');writeFileSync(path.join(root,'notes','handoff.md'),'MEASURE SELECTED RAW BODY token=secret-value should stay hidden.');writeFileSync(path.join(root,'src','auth.ts'),['export function measureTokenReset() {',"  return 'MEASURE AUTH RAW BODY';",'}'].join('\n'));const env={...process.env,OAF_FIXED_NOW:'2026-06-24T00:00:00.000Z',OAF_COMMIT_SHA:'1234567890abcdef1234567890abcdef12345678'};const objective='Private measure objective must not leak';const step='Private measure step must not leak';const result=spawnSync(process.execPath,['apps/cli/oaf.mjs','measure','context-pack','--read-only','--root',root,'--from','codex','--objective',objective,'--step',step,'--target','codex','--include-file','notes/handoff.md','--changed','src/auth.ts','--format','json'],{encoding:'utf8',env});assert.equal(result.status,0,result.stderr);const report=JSON.parse(result.stdout);assertJsonSchema(contextPackMeasurementReportSchema,report,'context pack measurement report');assert.equal(report.command,'measure context-pack');assert.equal(report.commitSha,'1234567890abcdef1234567890abcdef12345678');assert.equal(report.measurementScope,'single local context-pack build plus stdio readback');assert.deepEqual(report.request.sourceHarnesses,['codex']);assert.equal(report.request.userSelectedLocatorCount,1);assert.equal(report.request.changedLocatorCount,1);assert.equal(report.request.changedFromGit,false);assert.equal(report.contextPack.candidateUnitCount>=report.contextPack.selectedUnitCount,true);assert.equal(report.contextPack.estimatedSelectionReductionRatio,Number(Math.max(0,1-report.contextPack.selectedUnitCount/report.contextPack.candidateUnitCount).toFixed(6)));assert.equal(report.contextPack.deliveredUnitCount>0,true);assert.equal(report.contextPack.changedSourceBudget.locatorCount,1);assert.equal(report.contextPack.changedSourceBudget.measuredLocatorCount,1);assert.equal(report.contextPack.changedSourceBudget.contentByteCount>0,true);assert.equal(report.contextPack.changedSourceBudget.contentTokenCount>0,true);assert.equal(report.contextPack.changedSourceBudget.contentTokenCountIncluded,0);assert.equal(report.contextPack.changedSourceBudget.observedAvoidanceRatio,1);assert.equal(report.contextPack.changedSourceBudget.sourceContentIncluded,false);assert.equal(report.contextPack.changedLocatorCoverage.total,1);assert.equal(report.impactBrief.briefVersion,'oaf-context-impact-brief-1.0.0');assert.equal(report.impactBrief.request.changedLocatorSource,'explicit');assert.equal(report.impactBrief.status,'ready');assert.deepEqual(report.impactBrief.impact.changedLocators,['workspace://src/auth.ts']);assert.deepEqual(report.impactBrief.impact.representedChangedLocators,['workspace://src/auth.ts']);assert.equal(report.impactBrief.impact.changedLocatorCoverage.status,'covered');assert.equal(report.impactBrief.impact.affectedSymbolCount>=1,true);assert.equal(report.impactBrief.readPlan.requiredReadCount>=2,true);assert.equal(report.impactBrief.readPlan.changedReadHashVerifiedCount,1);assert.match(report.impactBrief.evidence.usePlanFingerprint,/^sha256:[a-f0-9]{64}$/);assert.equal(report.impactBrief.safeguards.readOnly,true);assert.equal(report.impactBrief.safeguards.localFilesWritten,0);assert.equal(report.impactBrief.safeguards.networkCalls,0);assert.equal(report.impactBrief.safeguards.modelCalls,0);assert.equal(report.impactBrief.safeguards.sourceContentIncluded,false);assert.equal(report.impactBrief.safeguards.diffBodiesIncluded,false);assert.equal(report.impactBrief.safeguards.graphDatabaseUsed,false);assert.equal(report.mcpReadback.transport,'stdio');assert.equal(report.mcpReadback.toolsExposed,0);assert.equal(report.mcpReadback.contextPackFingerprint,report.contextPack.contextPackFingerprint);assert.equal(report.timings.totalObservedMs,report.timings.contextPackBuildMs+report.timings.mcpReadbackMs);assert.equal(report.checks.contextPackFingerprintMatchesMcp,true);assert.equal(report.checks.noToolsExposed,true);assert.equal(report.checks.noMarkdownBody,true);assert.equal(report.safeguards.readOnly,true);assert.equal(report.safeguards.localFilesWritten,0);assert.equal(report.safeguards.externalWritesEnabled,false);assert.equal(report.safeguards.externalAdaptersEnabled,0);assert.equal(report.safeguards.networkCalls,0);assert.equal(report.safeguards.modelCalls,0);assert.equal(report.safeguards.sourceContentIncluded,false);assert.equal(report.safeguards.productionBenchmarkClaimed,false);for(const forbidden of ['MEASURE AGENTS RAW BODY','MEASURE SELECTED RAW BODY','MEASURE AUTH RAW BODY','secret-value',objective,step,root,'/Users/rebel'])assert.equal(result.stdout.includes(forbidden),false,forbidden);assert.equal(existsSync(path.join(root,'context-packs','CONTEXT_PACK.md')),false);const missingReadOnly=spawnSync(process.execPath,['apps/cli/oaf.mjs','measure','context-pack','--root',root,'--objective',objective,'--step',step,'--format','json'],{encoding:'utf8',env});assert.equal(missingReadOnly.status,2);assert.match(missingReadOnly.stderr,/--read-only/);const writeMode=spawnSync(process.execPath,['apps/cli/oaf.mjs','measure','context-pack','--read-only','--root',root,'--objective',objective,'--step',step,'--write','--format','json'],{encoding:'utf8',env});assert.equal(writeMode.status,2);assert.match(writeMode.stderr,/read-only/);const outMode=spawnSync(process.execPath,['apps/cli/oaf.mjs','measure','context-pack','--read-only','--root',root,'--objective',objective,'--step',step,'--out','context-packs/CONTEXT_PACK.md','--format','json'],{encoding:'utf8',env});assert.equal(outMode.status,2);assert.match(outMode.stderr,/read-only/);});
test('mcp resources CLI rejects write-capable mode requests',()=>{const result=spawnSync(process.execPath,['apps/cli/oaf.mjs','mcp','resources','--format','json'],{encoding:'utf8'});assert.equal(result.status,2);assert.match(result.stderr,/--read-only/);});

test('mcp stdio prompts list returns empty prompt catalog',()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-mcp-prompts-'));
  const env={...process.env,OAF_FIXED_NOW:'2026-06-24T00:00:00.000Z'};
  const input=JSON.stringify({jsonrpc:'2.0',id:1,method:'prompts/list'});
  const result=spawnSync(process.execPath,['apps/cli/oaf.mjs','mcp','resources','--read-only','--root',root,'--stdio'],{encoding:'utf8',env,input});
  assert.equal(result.status,0,result.stderr);
  const response=JSON.parse(result.stdout.trim());
  assert.deepEqual(response.result,{prompts:[]});
  assert.equal(response.error,undefined);
});

test('context registry and receive CLIs redact unsafe persisted source locators', async()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-poisoned-registry-'));
  mkdirSync(path.join(root,'context-packs'),{recursive:true});
  writeFileSync(path.join(root,'AGENTS.md'),'Poisoned registry CLI source.');
  const {
    buildContextPack,
    buildContextPackCurrentPointer,
    buildContextPackRegistry,
    buildContextPackRegistryEntry,
    buildContextPackUsePlan,
    renderContextPackMarkdown
  }=await import('../packages/harness-context/src/index.mjs');
  const fixed=()=> '2026-06-24T00:00:00.000Z';
  const pack=await buildContextPack({root,harnesses:['codex'],workspaceId:'ws_local',targetHarness:'codex',objective:'Prepare safe poisoned registry CLI proof',step:'redact unsafe persisted locators',clock:fixed});
  const usePlan=buildContextPackUsePlan(pack,{generatedAt:fixed()});
  const markdown=renderContextPackMarkdown(pack);
  const usePlanText=JSON.stringify(usePlan,null,2);
  const entry=buildContextPackRegistryEntry({pack,usePlan,markdown,usePlanContent:usePlanText});
  const poisonedEntry={...entry,requiredLocalReads:[{...entry.requiredLocalReads[0],locator:'workspace://tmp/https://api.openai.com/v1/oaf_session=oaf_ses_abc/sk-proj-secret/Users/rebel/private',contentHash:'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}]};
  const registry=buildContextPackRegistry({entry:poisonedEntry,updatedAt:fixed()});
  const pointer=buildContextPackCurrentPointer({registry,entry:poisonedEntry,updatedAt:fixed()});
  writeFileSync(path.join(root,'context-packs','CONTEXT_PACK.md'),markdown);
  writeFileSync(path.join(root,'context-packs','CONTEXT_PACK.use.json'),usePlanText);
  writeFileSync(path.join(root,'context-packs','registry.json'),JSON.stringify(registry,null,2));
  writeFileSync(path.join(root,'context-packs','current.json'),JSON.stringify(pointer,null,2));
  const status=spawnSync(process.execPath,['apps/cli/oaf.mjs','context','registry','status','--read-only','--root',root,'--format','json'],{encoding:'utf8'});
  assert.equal(status.status,0,status.stderr);
  const report=JSON.parse(status.stdout);
  assert.equal(report.current.status,'review');
  assert.deepEqual(report.entries[0].sourceChecks.unavailableLocators,['workspace://context-packs/redacted-unsafe-source-locator']);
  const receive=spawnSync(process.execPath,['apps/cli/oaf.mjs','context','receive','--read-only','--root',root,'--target','codex','--format','json'],{encoding:'utf8'});
  assert.equal(receive.status,0,receive.stderr);
  const receiveReport=JSON.parse(receive.stdout);
  assert.equal(receiveReport.state,'review');
  assert.equal(receiveReport.mcp.usePlanResourceRead,false);
  for(const forbidden of ['https://api.openai.com','oaf_session','oaf_ses_','sk-proj','/Users/rebel',root]){
    assert.equal(status.stdout.includes(forbidden),false,forbidden);
    assert.equal(receive.stdout.includes(forbidden),false,forbidden);
  }
});

test('harness setup rejects write-capable mode requests',()=>{
  const missingDryRun=spawnSync(process.execPath,['apps/cli/oaf.mjs','harness','setup','plan','--client','cursor','--server','oaf','--format','json'],{encoding:'utf8'});
  assert.equal(missingDryRun.status,2);
  assert.match(missingDryRun.stderr,/--dry-run|writes are not implemented/i);
  assert.equal(missingDryRun.stdout,'');
  const writeFlag=spawnSync(process.execPath,['apps/cli/oaf.mjs','harness','setup','plan','--client','cursor','--server','oaf','--dry-run','--write','--format','json'],{encoding:'utf8'});
  assert.equal(writeFlag.status,2);
  assert.match(writeFlag.stderr,/dry-run only|writes are not implemented/i);
  assert.equal(writeFlag.stdout,'');
  const unsupportedServer=spawnSync(process.execPath,['apps/cli/oaf.mjs','harness','setup','plan','--client','cursor','--server','other','--dry-run','--format','json'],{encoding:'utf8'});
  assert.equal(unsupportedServer.status,2);
  assert.match(unsupportedServer.stderr,/only supports the oaf MCP server/);
  assert.equal(unsupportedServer.stdout,'');
});

test('harness setup status reports absent home config without writes or path leakage',()=>{
  const home=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-harness-home-'));
  const result=spawnSync(process.execPath,['apps/cli/oaf.mjs','harness','setup','status','--client','codex','--home',home,'--dry-run','--format','json'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(result.stdout);
  assert.equal(report.schemaVersion,'1.0.0');
  assert.equal(report.command,'harness setup status');
  assert.equal(report.dryRun,true);
  assert.equal(report.config.ref,'home://.codex/config.toml');
  assert.equal(report.config.exists,false);
  assert.equal(report.status.config,'absent');
  assert.equal(report.status.server,'absent');
  assert.equal(report.manualConfigSnippet.format,'toml');
  assert.equal(report.manualConfigSnippet.configRef,'home://.codex/config.toml');
  assert.equal(report.manualConfigSnippet.applyMode,'manual-copy');
  assert.match(report.manualConfigSnippet.content,/\[mcp_servers\.oaf\]/);
  assert.match(report.manualConfigSnippet.content,/command = "npm"/);
  assert.match(report.manualConfigSnippet.content,/--read-only/);
  assert.match(report.manualConfigSnippet.warning,/OAF does not write home config files/);
  assert.equal(report.diff.operations.length,0);
  assert.equal(report.safeguards.localFilesWritten,0);
  assert.equal(report.safeguards.homeConfigMutated,false);
  assert.equal(report.safeguards.canonicalStateMutated,false);
  assert.equal(report.safeguards.externalAdaptersEnabled,0);
  assert.equal(report.safeguards.externalWritesEnabled,false);
  assert.equal(existsSync(path.join(home,'.codex','config.toml')),false);
  assert(!result.stdout.includes(home));
  assert(!result.stdout.includes('/Users/'));
});

test('harness setup plan emits deterministic redacted diff for cursor',()=>{
  const home=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-harness-plan-'));
  mkdirSync(path.join(home,'.cursor'),{recursive:true});
  const configPath=path.join(home,'.cursor','mcp.json');
  writeFileSync(configPath,JSON.stringify({mcpServers:{other:{command:'/Users/rebel/private-tool',args:['token=secret-value'],env:{OPENAI_API_KEY:'secret-value'}}}},null,2));
  const before=readFileSync(configPath,'utf8');
  const env={...process.env,OAF_FIXED_NOW:'2026-06-24T00:00:00.000Z'};
  const args=['apps/cli/oaf.mjs','harness','setup','plan','--client','cursor','--server','oaf','--home',home,'--dry-run','--format','json'];
  const first=spawnSync(process.execPath,args,{encoding:'utf8',env});
  const second=spawnSync(process.execPath,args,{encoding:'utf8',env});
  assert.equal(first.status,0,first.stderr);
  assert.equal(second.status,0,second.stderr);
  const report=JSON.parse(first.stdout);
  assert.deepEqual(report,JSON.parse(second.stdout));
  assert.match(report.planFingerprint,/^sha256:[a-f0-9]{64}$/);
  assert.equal(report.config.ref,'home://.cursor/mcp.json');
  assert.equal(report.config.serverCount,1);
  assert.equal(report.diff.redacted,true);
  assert.deepEqual(report.diff.operations,[{op:'add',target:'mcpServers.oaf',before:'absent',after:'read-only-oaf-mcp-stdio',summary:'add oaf with read-only OAF MCP stdio resource bridge'}]);
  assert.equal(report.desiredServer.command,'npm');
  assert.deepEqual(report.desiredServer.args,['--silent','run','oaf','--','mcp','resources','--read-only','--stdio']);
  assert.equal(report.manualConfigSnippet.format,'json');
  assert.equal(report.manualConfigSnippet.configRef,'home://.cursor/mcp.json');
  const snippet=JSON.parse(report.manualConfigSnippet.content);
  assert.equal(snippet.mcpServers.oaf.command,'npm');
  assert.deepEqual(snippet.mcpServers.oaf.args,['--silent','run','oaf','--','mcp','resources','--read-only','--stdio']);
  assert.deepEqual(Object.keys(snippet.mcpServers),['oaf']);
  assert.equal(report.safeguards.localFilesWritten,0);
  assert.equal(report.safeguards.externalAdaptersEnabled,0);
  assert.equal(report.safeguards.externalWritesEnabled,false);
  assert.equal(report.safeguards.networkCalls,0);
  assert.equal(report.safeguards.modelCalls,0);
  assert.equal(readFileSync(configPath,'utf8'),before);
  const combined=first.stdout+first.stderr;
  assert(!combined.includes('secret-value'));
  assert(!combined.includes('OPENAI_API_KEY'));
  assert(!combined.includes('/Users/rebel/private-tool'));
  assert(!combined.includes('other'));
  assert(!combined.includes(home));
  assert.doesNotMatch(combined,/supermemory|graphify|serena|npx|uvx|curl/i);
  const claude=spawnSync(process.execPath,['apps/cli/oaf.mjs','harness','setup','plan','--client','claude-code','--server','oaf','--home',home,'--dry-run','--format','json'],{encoding:'utf8',env});
  assert.equal(claude.status,0,claude.stderr);
  const claudeReport=JSON.parse(claude.stdout);
  assert.equal(claudeReport.manualConfigSnippet.format,'json');
  assert.equal(claudeReport.manualConfigSnippet.configRef,'home://.claude/mcp.json');
  assert.equal(JSON.parse(claudeReport.manualConfigSnippet.content).mcpServers.oaf.command,'npm');
});

test('harness setup status parses installed codex toml jsonc and yaml configs',()=>{
  const env={...process.env,OAF_FIXED_NOW:'2026-06-24T00:00:00.000Z'};
  const codexHome=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-harness-codex-'));
  mkdirSync(path.join(codexHome,'.codex'),{recursive:true});
  writeFileSync(path.join(codexHome,'.codex','config.toml'),'[mcp_servers.oaf]\ncommand = "npm"\nargs = ["--silent", "run", "oaf", "--", "mcp", "resources", "--read-only", "--stdio"]\n\n[mcp_servers.other.http_headers]\nX-Private-Token = "secret-value"\n\n[[projects.items]]\ntrust_level = "trusted"\n"repo-0.0" = 1\n');
  const codex=spawnSync(process.execPath,['apps/cli/oaf.mjs','harness','setup','status','--client','codex','--home',codexHome,'--dry-run','--format','json'],{encoding:'utf8',env});
  assert.equal(codex.status,0,codex.stderr);
  assert.equal(JSON.parse(codex.stdout).status.server,'installed');
  const jsoncHome=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-harness-jsonc-'));
  writeFileSync(path.join(jsoncHome,'opencode.jsonc'),'{\n  // local read-only bridge\n  "mcpServers": {"oaf": {"command": "npm", "args": ["--silent", "run", "oaf", "--", "mcp", "resources", "--read-only", "--stdio"]}}\n}\n');
  const jsonc=spawnSync(process.execPath,['apps/cli/oaf.mjs','harness','setup','status','--client','opencode','--home',jsoncHome,'--dry-run','--format','json'],{encoding:'utf8',env});
  assert.equal(jsonc.status,0,jsonc.stderr);
  assert.equal(JSON.parse(jsonc.stdout).status.server,'installed');
  const yamlHome=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-harness-yaml-'));
  writeFileSync(path.join(yamlHome,'.aider.conf.yml'),'mcpServers:\n  oaf:\n    command: npm\n    args:\n      - --silent\n      - run\n      - oaf\n      - --\n      - mcp\n      - resources\n      - --read-only\n      - --stdio\n');
  const yaml=spawnSync(process.execPath,['apps/cli/oaf.mjs','harness','setup','status','--client','aider','--home',yamlHome,'--dry-run','--format','json'],{encoding:'utf8',env});
  assert.equal(yaml.status,0,yaml.stderr);
  assert.equal(JSON.parse(yaml.stdout).status.server,'installed');
});

test('harness setup malformed config fails closed without leaking config bodies',()=>{
  const cases=[
    {client:'cursor',file:'.cursor/mcp.json',text:'{"mcpServers": {"oaf": OPENAI_API_KEY=secret-value /Users/rebel/private.txt }'},
    {client:'opencode',file:'opencode.jsonc',text:'{"mcpServers": {"oaf": {"command": "npm", "args": ["run", }}}'},
    {client:'aider',file:'.aider.conf.yml',text:'mcpServers:\n  oaf:\n    command: npm\n    unexpected: token=secret-value\n'},
    {client:'codex',file:'.codex/config.toml',text:'[mcp_servers.oaf]\ncommand = token=secret-value\n'}
  ];
  for (const item of cases) {
    const home=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-harness-malformed-'));
    mkdirSync(path.dirname(path.join(home,item.file)),{recursive:true});
    const filePath=path.join(home,item.file);
    writeFileSync(filePath,item.text);
    const result=spawnSync(process.execPath,['apps/cli/oaf.mjs','harness','setup','status','--client',item.client,'--home',home,'--dry-run','--format','json'],{encoding:'utf8'});
    assert.equal(result.status,2,`${item.client}: ${result.stdout} ${result.stderr}`);
    assert.equal(result.stdout,'');
    assert.match(result.stderr,/harness config parse failed/);
    assert.equal(readFileSync(filePath,'utf8'),item.text);
    const combined=result.stdout+result.stderr;
    assert(!combined.includes('secret-value'));
    assert(!combined.includes('OPENAI_API_KEY'));
    assert(!combined.includes('/Users/rebel/private.txt'));
    assert(!combined.includes(home));
  }
});

test('harness setup uninstall dry-run removes exactly one named server',()=>{
  const home=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-harness-uninstall-'));
  mkdirSync(path.join(home,'.cursor'),{recursive:true});
  const configPath=path.join(home,'.cursor','mcp.json');
  const config={mcpServers:{oaf:{command:'npm',args:['--silent','run','oaf','--','mcp','resources','--read-only','--stdio']},other:{command:'/Users/rebel/private-tool',args:['other-secret']}}};
  writeFileSync(configPath,JSON.stringify(config,null,2));
  const before=readFileSync(configPath,'utf8');
  const result=spawnSync(process.execPath,['apps/cli/oaf.mjs','harness','setup','uninstall','--client','cursor','--server','oaf','--home',home,'--dry-run','--format','json'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(result.stdout);
  assert.equal(report.status.server,'installed');
  assert.deepEqual(report.diff.operations,[{op:'remove',target:'mcpServers.oaf',before:'installed',after:'absent',summary:'remove exactly oaf from the harness MCP server map'}]);
  assert.equal(report.safeguards.localFilesWritten,0);
  assert.equal(report.safeguards.homeConfigMutated,false);
  assert.equal(readFileSync(configPath,'utf8'),before);
  assert(!result.stdout.includes('other-secret'));
  assert(!result.stdout.includes('/Users/rebel/private-tool'));
  assert(!result.stdout.includes(home));
});

test('memory fact CLI adds, gets, and histories proposal-gated temporal facts',async()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-memory-fact-'));
  const sqlitePath=path.join(root,'memory.sqlite');
  const provider=new SQLiteMemoryProvider({filename:sqlitePath,clock:()=>'2026-06-25T10:00:00.000Z'});
  const queued=await provider.enqueueProposal({id:'mpq_cli_fact',workspaceId:'ws_local',sourceLocator:'workspace://memory/status.md',sourceHash:'sha256:3333333333333333333333333333333333333333333333333333333333333333',payload:{kind:'fact',subject:'project:oaf',predicate:'release_status',object:'beta'}});
  await provider.claimProposal({workspaceId:'ws_local',workerId:'reviewer',leaseUntil:'2026-06-25T10:05:00.000Z'});
  await provider.recordProposalResult({workspaceId:'ws_local',id:queued.id,workerId:'reviewer',status:'applied',result:{accepted:true}});
  provider.close();
  const env={...process.env,OAF_FIXED_NOW:'2026-06-25T10:00:00.000Z'};
  const ungated=spawnSync(process.execPath,['apps/cli/oaf.mjs','memory','fact','add','--sqlite',sqlitePath,'--workspace','ws_local','--scope','workspace','--subject','project:oaf','--predicate','release_status','--object','alpha','--text','OAF release status is alpha.','--source','workspace://memory/status.md','--episode-id','mep_cli_fact','--episode-source','workspace://memory/status.md','--episode-summary','CLI status note.','--valid-from','2026-06-25T10:00:00.000Z','--format','json'],{encoding:'utf8',env});
  assert.equal(ungated.status,2);
  assert.match(ungated.stderr,/proposal/i);
  const add=spawnSync(process.execPath,['apps/cli/oaf.mjs','memory','fact','add','--sqlite',sqlitePath,'--workspace','ws_local','--scope','workspace','--subject','project:oaf','--predicate','release_status','--object','beta','--text','OAF release status is beta.','--source','workspace://memory/status.md','--proposal',queued.id,'--episode-id','mep_cli_fact','--episode-source','workspace://memory/status.md','--episode-summary','CLI status note.','--valid-from','2026-06-25T10:00:00.000Z','--format','json'],{encoding:'utf8',env});
  assert.equal(add.status,0,add.stderr);
  const added=JSON.parse(add.stdout);
  assert.equal(added.subject,'project:oaf');
  assert.equal(added.episode.id,'mep_cli_fact');
  const get=spawnSync(process.execPath,['apps/cli/oaf.mjs','memory','fact','get','--sqlite',sqlitePath,'--workspace','ws_local','--scope','workspace','--subject','project:oaf','--predicate','release_status','--at','2026-06-26T00:00:00.000Z','--format','json'],{encoding:'utf8',env});
  assert.equal(get.status,0,get.stderr);
  assert.deepEqual(JSON.parse(get.stdout).facts.map((fact)=>fact.object),['beta']);
  const history=spawnSync(process.execPath,['apps/cli/oaf.mjs','memory','fact','history','--sqlite',sqlitePath,'--workspace','ws_local','--scope','workspace','--subject','project:oaf','--predicate','release_status','--format','json'],{encoding:'utf8',env});
  assert.equal(history.status,0,history.stderr);
  assert.deepEqual(JSON.parse(history.stdout).facts.map((fact)=>fact.id),[added.id]);
});

test('memory ingest queues real workspace proposals and MCP serves them without activation',()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'oaf-cli-memory-ingest-'));
  mkdirSync(path.join(root,'docs','adr'),{recursive:true});
  mkdirSync(path.join(root,'src'),{recursive:true});
  writeFileSync(path.join(root,'README.md'),'Open Agent Fabric is local-first with proposal-gated memory, read-only MCP, SQLite FTS5 memory, source graph context, and context manifests. README RAW BODY should stay hidden.');
  writeFileSync(path.join(root,'AGENTS.md'),'Use context manifests. Keep external writes disabled by default.');
  writeFileSync(path.join(root,'docs','adr','0019-proposal-gated-harness-memory-import.md'),'Proposal-gated harness memory import keeps durable facts as proposals.');
  writeFileSync(path.join(root,'docs','adr','0020-read-only-mcp-before-write-tools.md'),'Read-only MCP before write tools.');
  writeFileSync(path.join(root,'docs','adr','0021-native-source-graph-before-codebase-memory-adapter.md'),'Native source graph before codebase memory adapter.');
  writeFileSync(path.join(root,'src','index.mjs'),'export function buildMemoryProfile(){ return "local"; }\n');
  const env={...process.env,OAF_FIXED_NOW:'2026-06-26T10:00:00.000Z'};
  const ingest=spawnSync(process.execPath,['apps/cli/oaf.mjs','memory','ingest','--root',root,'--sqlite','.local/memory.sqlite','--format','json'],{encoding:'utf8',env});
  assert.equal(ingest.status,0,ingest.stderr);
  const report=JSON.parse(ingest.stdout);
  assert(report.summary.proposalCount>0);
  assert.equal(report.summary.activeMemoryCreated,0);
  assert.equal(report.safeguards.proposalGated,true);
  assert.equal(report.safeguards.modelCalls,0);
  assert.equal(existsSync(path.join(root,'.local','memory.sqlite')),true);
  const stdioInput=[
    JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{}}),
    JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'memory.recall',arguments:{query:'proposal gated memory',scope:'workspace',limit:5}}}),
    JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'context.profile',arguments:{objective:'Use proposal gated memory',scope:'workspace',limit:5,budget:512}}})
  ].join('\n');
  const mcp=spawnSync(process.execPath,['apps/cli/oaf.mjs','mcp','server','--read-only','--root',root,'--sqlite','.local/memory.sqlite','--stdio'],{encoding:'utf8',env,input:stdioInput});
  assert.equal(mcp.status,0,mcp.stderr);
  const responses=mcp.stdout.trim().split(/\n/u).map((line)=>JSON.parse(line));
  const recall=JSON.parse(responses[1].result.content[0].text);
  assert.equal(recall.command,'memory.recall');
  assert(recall.data.proposalFactCount>0);
  assert.equal(recall.data.activeFactCount,0);
  assert.equal(recall.safeguards.activeMemoryCreated,0);
  const profile=JSON.parse(responses[2].result.content[0].text);
  assert.equal(profile.command,'context.profile');
  assert(profile.data.profile.proposalFactCount>0);
  assert(profile.data.selectedContext.selectedCount>0);
  assert.equal(profile.safeguards.activeMemoryCreated,0);
  for(const forbidden of ['README RAW BODY',root,'/Users/rebel']) assert.equal(`${ingest.stdout}\n${mcp.stdout}`.includes(forbidden),false,forbidden);
});
