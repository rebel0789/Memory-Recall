import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import skillCatalogReportSchema from '../packages/protocol/schemas/skill-catalog-report.schema.json' with { type: 'json' };
import skillLoadPlanSchema from '../packages/protocol/schemas/skill-load-plan.schema.json' with { type: 'json' };
import { assertJsonSchema } from '../packages/protocol/src/schema-validator.mjs';
import {
  buildLoopActionEfficiencyGuidance,
  buildLoopIntentClarification,
  buildLoopPlan
} from '../packages/harness-context/src/index.mjs';

async function readSkill(id) {
  const directory = new URL(`../skills/${id}/`, import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8'));
  const text = await readFile(new URL('SKILL.md', directory), 'utf8');
  return { manifest, text };
}

test('loop action efficiency skill stays read-only and measured', async () => {
  const { manifest, text } = await readSkill('loop-action-efficiency');
  assert.equal(manifest.id, 'skill:loop-action-efficiency');
  assert.equal(manifest.sideEffectClass, 'read-only');
  assert.deepEqual(manifest.tools, ['tool:filesystem-read', 'tool:git-read']);
  assert.equal(manifest.triggers.includes('reuse before generate'), true);
  assert.match(text, /smallest coherent edit/);
  assert.match(text, /contextBudget/);
  assert.match(text, /never grants write authority/);
  assert.match(text, /Do not claim provider billing savings/);

  const plan = buildLoopPlan({
    workspaceId: 'ws_loop',
    objective: 'Reuse existing loop verification helper',
    stopCondition: 'focused loop skill test passes',
    validationCommands: ['node --test tests/skill-catalog.test.mjs'],
    changedLocators: ['packages/harness-context/src/index.mjs'],
    contextBudget: {
      estimatedDeliveryTokens: 12,
      sourceBodyTokensExcluded: 30,
      deliveryReductionRatio: 0.6,
      basis: 'context-pack-measurement'
    },
    clock: () => '2026-06-26T00:00:00.000Z'
  });
  const guidance = buildLoopActionEfficiencyGuidance({
    loopPlan: plan,
    reusablePrimitives: ['buildLoopPlan', 'runLoopVerification'],
    proposedBoundary: ['packages/harness-context/src/index.mjs']
  });
  assert.equal(guidance.skillId, manifest.id);
  assert.equal(guidance.status, 'ready');
  assert.equal(guidance.actionLadder[0], 'reuse_existing_primitive');
  assert.equal(guidance.writeAuthorityGranted, false);
  assert.deepEqual(guidance.measured.contextBudget, plan.contextBudget);
  assert(guidance.reasonCodes.includes('reuse_before_generate'));
});

test('loop intent clarification skill blocks ambiguous loop starts', async () => {
  const { manifest, text } = await readSkill('loop-intent-clarification');
  assert.equal(manifest.id, 'skill:loop-intent-clarification');
  assert.equal(manifest.sideEffectClass, 'read-only');
  assert.equal(manifest.triggers.includes('stop condition'), true);
  assert.match(text, /objective, non-goals, side effects, validation, rollback, and stop condition/);
  assert.match(text, /blocked_needs_human/);
  assert.match(text, /Do not begin action work until the stop condition is testable/);
  assert.match(text, /never grants authority/);

  const blocked = buildLoopIntentClarification({
    objective: 'Improve the loop workbench',
    validationCommands: [],
    rollback: ''
  });
  assert.equal(blocked.skillId, manifest.id);
  assert.equal(blocked.status, 'blocked_needs_human');
  assert(blocked.openQuestions.length > 0);
  assert(blocked.openQuestions.length <= 3);
  assert(blocked.reasonCodes.includes('missing_stop_condition'));

  const clarified = buildLoopIntentClarification({
    objective: 'Improve the loop workbench',
    stopCondition: 'node --test tests/skill-catalog.test.mjs passes',
    sideEffectClass: 'read-only',
    validationCommands: ['node --test tests/skill-catalog.test.mjs'],
    rollback: 'discard the local patch'
  });
  assert.equal(clarified.status, 'ready');
  assert.equal(clarified.planFields.stopCondition, 'node --test tests/skill-catalog.test.mjs passes');
  assert.equal(clarified.planFields.sideEffectClass, 'read-only');
  assert.equal(clarified.authorityGranted, false);
});

test('legacy oaf-memory skill exposes governed Memory Recall semantic setup', async () => {
  const { manifest, text } = await readSkill('oaf-memory');
  const readme = await readFile(new URL('../skills/oaf-memory/README.md', import.meta.url), 'utf8');
  assert.equal(manifest.id, 'skill:oaf-memory');
  assert.equal(manifest.sideEffectClass, 'reversible-write');
  assert(manifest.triggers.includes('/oaf-memory'));
  assert(manifest.triggers.includes('map this project into OAF'));
  assert(manifest.triggers.includes('set up Memory Recall'));
  assert(manifest.triggers.includes('semantic setup'));
  assert(manifest.tools.includes('tool:workspace-write'));
  assert.equal(manifest.tools.some((tool) => tool.includes('network')), false);
  assert.match(text, /recall semantic plan --harness codex --root \. --dry-run/);
  assert.match(text, /recall semantic task --harness codex --root \./);
  assert.match(text, /recall semantic import --input semantic-result\.json --root \. --sqlite \.local\/memory\.sqlite/);
  assert.match(text, /recall memory approve <mpq_id>/);
  assert.match(text, /generic CLI does not invoke Codex, Claude Code, Cursor, or another harness/i);
  assert.match(text, /MCP remains read-only/i);
  assert.match(text, /semantic setup v1 does not scan or upload raw source-code files/i);
  assert.match(readme, /recall semantic task/);
  assert.doesNotMatch(`${text}\n${readme}`, /oaf ingest-docs|memory consolidate/);
  assert.match(text, /Never auto-approve/);
});

test('skill catalog CLI exposes governed manifests without raw skill bodies', () => {
  const env = { ...process.env, OAF_FIXED_NOW: '2026-07-05T00:00:00.000Z' };
  const result = spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'skill', 'catalog', '--read-only', '--format', 'json'], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assertJsonSchema(skillCatalogReportSchema, report, 'skill catalog report');
  assert.equal(report.command, 'skill catalog');
  assert.equal(report.generatedAt, '2026-07-05T00:00:00.000Z');
  assert.equal(report.summary.total >= 12, true);
  assert.equal(report.summary.advertisedSkillCount, report.summary.total);
  assert.equal(report.summary.loadableOnlySkillCount, 0);
  assert.equal(report.summary.writableSkillCount, report.summary.reversibleWriteCount + report.summary.consequentialWriteCount);
  assert(report.summary.toolIds.includes('tool:filesystem-read'));
  assert.deepEqual(report.summary.advertisedToolIds, report.summary.toolIds);
  assert.match(report.catalogFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.match(report.reportFingerprint, /^sha256:[a-f0-9]{64}$/);

  const memorySkill = report.skills.find((skill) => skill.id === 'skill:oaf-memory');
  assert.equal(memorySkill.sideEffectClass, 'reversible-write');
  assert.equal(memorySkill.advertised, true);
  assert.equal(memorySkill.description, 'Build bounded semantic setup proposals with explicit review and source rechecks.');
  assert.equal(memorySkill.readiness.state, 'blocked');
  assert.equal(memorySkill.readiness.approvalRequired, true);
  assert.deepEqual(memorySkill.readiness.unreviewedToolIds, ['tool:shell-sandbox']);
  assert(memorySkill.readiness.reasonCodes.includes('write_skill_requires_approval'));
  assert(memorySkill.readiness.reasonCodes.includes('skill_declares_unreviewed_tools'));
  assert.deepEqual(memorySkill.inputSchema, { type: 'object' });
  assert.deepEqual(memorySkill.outputSchema, { type: 'object' });
  assert.equal(memorySkill.manifestRef, 'workspace://skills/oaf-memory/manifest.json');
  assert.equal(memorySkill.skillRef, 'workspace://skills/oaf-memory/SKILL.md');
  assert.equal(memorySkill.checks.manifestValid, true);
  assert.equal(memorySkill.checks.skillDocumentPresent, true);
  const readOnlyReadySkill = report.skills.find((skill) => skill.id === 'skill:ui-review');
  assert.equal(readOnlyReadySkill.readiness.state, 'ready');
  assert.equal(readOnlyReadySkill.readiness.approvalRequired, false);
  assert.deepEqual(readOnlyReadySkill.readiness.unreviewedToolIds, []);
  const writeReviewSkill = report.skills.find((skill) => skill.id === 'skill:context-debug');
  assert.equal(writeReviewSkill.readiness.state, 'review');
  assert.equal(writeReviewSkill.readiness.approvalRequired, true);
  assert.deepEqual(writeReviewSkill.readiness.unreviewedToolIds, []);
  assert.equal(report.safeguards.readOnly, true);
  assert.equal(report.safeguards.localFilesWritten, 0);
  assert.equal(report.safeguards.rawSkillTextIncluded, false);
  assert.equal(report.safeguards.absoluteFilesystemLocationsIncluded, false);
  assert.equal(result.stdout.includes('Never auto-approve'), false);
  assert.equal(result.stdout.includes('/Users/rebel'), false);

  const summary = spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'skill', 'catalog', '--read-only', '--format', 'summary'], { encoding: 'utf8', env });
  assert.equal(summary.status, 0, summary.stderr);
  assert.match(summary.stdout, /Skills: /);
  assert.match(summary.stdout, /Reviewed tools: 3\/3; unreviewed declared: tool:git-read, tool:local-http, tool:shell-sandbox, tool:source-read/);
  assert.match(summary.stdout, /- skill:oaf-memory \[reversible-write\]: Build bounded semantic setup proposals with explicit review and source rechecks\./);
  assert.match(summary.stdout, /- skill:source-verification \[read-only\]: Verify material claims against evidence for support, weakness, conflict, and staleness\./);
  assert.match(summary.stdout, /Raw skill text included: no/);
  assert.match(summary.stdout, /Load policy: read a skillRef only after its trigger matches; catalog grants no tool authority\./);
  assert.equal(summary.stdout.includes('Never auto-approve'), false);
  assert.equal(summary.stdout.includes('/Users/rebel'), false);

  const listed = spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'mcp', 'resources', '--read-only', '--format', 'json'], { encoding: 'utf8', env });
  assert.equal(listed.status, 0, listed.stderr);
  const listing = JSON.parse(listed.stdout);
  assert(listing.resources.some((resource) => resource.uri === 'oaf://workspace/ws_local/skills/catalog'));
  assert(listing.resources.some((resource) => resource.uri === 'oaf://workspace/ws_local/skills/oaf-memory/load-plan'));
  const mcpRead = spawnSync(process.execPath, [
    'apps/cli/oaf.mjs',
    'mcp',
    'resources',
    '--read-only',
    '--uri',
    'oaf://workspace/ws_local/skills/catalog',
    '--format',
    'json'
  ], { encoding: 'utf8', env });
  assert.equal(mcpRead.status, 0, mcpRead.stderr);
  const mcpEnvelope = JSON.parse(mcpRead.stdout);
  const mcpPayload = JSON.parse(mcpEnvelope.contents[0].text);
  assert.equal(mcpPayload.resourceKind, 'skill-catalog-summary');
  assert.equal(mcpPayload.provenance.source, 'local-skill-catalog');
  assert.equal(mcpPayload.data.summary.total, report.summary.total);
  assert.equal(mcpPayload.data.summary.uniqueToolCount, report.summary.uniqueToolCount);
  assert(mcpPayload.data.skills.some((skill) => (
    skill.id === 'skill:oaf-memory'
    && skill.description === memorySkill.description
    && skill.readiness.state === 'blocked'
  )));
  assert(mcpPayload.data.toolReview.reviewedToolIds.includes('tool:filesystem-read'));
  assert(mcpPayload.data.toolReview.enabledReviewedToolIds.includes('tool:workspace-write'));
  assert(mcpPayload.data.toolReview.unreviewedDeclaredToolIds.includes('tool:git-read'));
  assert.match(mcpPayload.data.catalogFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.match(mcpPayload.data.toolReview.toolCatalogFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(mcpPayload.safeguards.readOnly, true);
  assert.equal(mcpPayload.data.safeguards.toolAuthorityGranted, false);
  assert.equal(mcpRead.stdout.includes('Never auto-approve'), false);
  assert.equal(mcpRead.stdout.includes('/Users/rebel'), false);

  const mcpLoadPlanRead = spawnSync(process.execPath, [
    'apps/cli/oaf.mjs',
    'mcp',
    'resources',
    '--read-only',
    '--uri',
    'oaf://workspace/ws_local/skills/oaf-memory/load-plan',
    '--format',
    'json'
  ], { encoding: 'utf8', env });
  assert.equal(mcpLoadPlanRead.status, 0, mcpLoadPlanRead.stderr);
  const mcpLoadPlanEnvelope = JSON.parse(mcpLoadPlanRead.stdout);
  const mcpLoadPlanPayload = JSON.parse(mcpLoadPlanEnvelope.contents[0].text);
  assert.equal(mcpLoadPlanPayload.resourceKind, 'skill-load-plan');
  assert.equal(mcpLoadPlanPayload.provenance.source, 'local-skill-load-plan');
  assert.equal(mcpLoadPlanPayload.data.skill.id, 'skill:oaf-memory');
  assert.deepEqual(mcpLoadPlanPayload.data.requiredLocalReads.map((item) => item.kind), ['manifest', 'skill']);
  assert.equal(mcpLoadPlanPayload.data.safeguards.rawSkillTextIncluded, undefined);
  assert.equal(mcpLoadPlanPayload.data.safeguards.skillTextIncluded, false);
  assert.equal(mcpLoadPlanPayload.data.safeguards.toolAuthorityGranted, false);
  assert.equal(mcpLoadPlanRead.stdout.includes('Never auto-approve'), false);
  assert.equal(mcpLoadPlanRead.stdout.includes('/Users/rebel'), false);

  const mcpLoadPlanSummary = spawnSync(process.execPath, [
    'apps/cli/oaf.mjs',
    'mcp',
    'resources',
    '--read-only',
    '--uri',
    'oaf://workspace/ws_local/skills/oaf-memory/load-plan',
    '--format',
    'summary'
  ], { encoding: 'utf8', env });
  assert.equal(mcpLoadPlanSummary.status, 0, mcpLoadPlanSummary.stderr);
  assert.match(mcpLoadPlanSummary.stdout, /Kind: skill-load-plan/);
  assert.match(mcpLoadPlanSummary.stdout, /Context tier: procedural-skill/);
  assert.match(mcpLoadPlanSummary.stdout, /Skill: skill:oaf-memory/);
  assert.match(mcpLoadPlanSummary.stdout, /Required local reads: 2/);
  assert.match(mcpLoadPlanSummary.stdout, /Skill text included: no/);
  assert.match(mcpLoadPlanSummary.stdout, /Tool authority granted: no/);
  assert.equal(mcpLoadPlanSummary.stdout.includes('Never auto-approve'), false);
  assert.equal(mcpLoadPlanSummary.stdout.includes('/Users/rebel'), false);

  const inspect = spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'mcp', 'inspect', '--read-only', '--format', 'json'], { encoding: 'utf8', env });
  assert.equal(inspect.status, 0, inspect.stderr);
  const inspectReport = JSON.parse(inspect.stdout);
  assert.equal(inspectReport.command, 'mcp inspect');
  assert(inspectReport.resources.some((resource) => resource.uri === 'oaf://workspace/ws_local/skills/catalog' && resource.resourceKind === 'skill-catalog-summary'));
  assert(inspectReport.resources.some((resource) => resource.uri === 'oaf://workspace/ws_local/skills/oaf-memory/load-plan' && resource.resourceKind === 'skill-load-plan'));
  assert.equal(inspectReport.summary.resourceKindCounts['skill-load-plan'] >= 1, true);
  assert.equal(inspectReport.summary.contextTierCounts['procedural-skill'] >= 2, true);
  assert.equal(inspectReport.summary.toolContextTierCounts['governed-memory'], 1);
  assert.equal(inspectReport.summary.toolContextTierCounts['selected-context'], 1);
  assert.equal(inspectReport.summary.toolContextTierCounts['handoff-context'], 1);
  assert.equal(inspectReport.summary.toolContextTierCounts['tool-capability'], 2);
  assert(inspectReport.resources.some((resource) => resource.uri === 'oaf://workspace/ws_local/skills/oaf-memory/load-plan' && resource.contextTier === 'procedural-skill'));
  assert(inspectReport.serverTools.some((tool) => tool.name === 'memory.recall' && tool.contextTier === 'governed-memory'));
  assert.equal(inspectReport.summary.toolsExposedByServerCommand, 12);
  assert.equal(inspectReport.safeguards.resourceBodiesRead, 0);
  assert.equal(inspect.stdout.includes('Never auto-approve'), false);
  assert.equal(inspect.stdout.includes('/Users/rebel'), false);

  const missingReadOnly = spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'skill', 'catalog', '--format', 'json'], { encoding: 'utf8', env });
  assert.equal(missingReadOnly.status, 2);
  assert.match(missingReadOnly.stderr, /--read-only/);

  const writeMode = spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'skill', 'catalog', '--read-only', '--write', '--format', 'json'], { encoding: 'utf8', env });
  assert.equal(writeMode.status, 2);
  assert.match(writeMode.stderr, /read-only/);
});

test('skill load-plan CLI returns ordered local reads without raw skill bodies', () => {
  const env = { ...process.env, OAF_FIXED_NOW: '2026-07-05T00:00:00.000Z' };
  const result = spawnSync(process.execPath, [
    'apps/cli/oaf.mjs',
    'skill',
    'load-plan',
    '--read-only',
    '--id',
    'skill:oaf-memory',
    '--format',
    'json'
  ], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assertJsonSchema(skillLoadPlanSchema, report, 'skill load-plan report');
  assert.equal(report.command, 'skill load-plan');
  assert.equal(report.generatedAt, '2026-07-05T00:00:00.000Z');
  assert.equal(report.skill.id, 'skill:oaf-memory');
  assert.equal(report.skill.sideEffectClass, 'reversible-write');
  assert.equal(report.skill.readiness.approvalRequired, true);
  assert.deepEqual(report.requiredLocalReads.map((item) => item.kind), ['manifest', 'skill']);
  assert.equal(report.requiredLocalReads[0].ref, 'workspace://skills/oaf-memory/manifest.json');
  assert.equal(report.requiredLocalReads[1].ref, 'workspace://skills/oaf-memory/SKILL.md');
  assert.match(report.catalogFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.match(report.loadPlanFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(report.safeguards.readOnly, true);
  assert.equal(report.safeguards.rawSkillTextIncluded, false);
  assert.equal(report.safeguards.toolAuthorityGranted, false);
  assert.equal(report.safeguards.absoluteFilesystemLocationsIncluded, false);
  assert.equal(result.stdout.includes('Never auto-approve'), false);
  assert.equal(result.stdout.includes('/Users/rebel'), false);

  const summary = spawnSync(process.execPath, [
    'apps/cli/oaf.mjs',
    'skill',
    'load-plan',
    '--read-only',
    '--id',
    'skill:oaf-memory',
    '--format',
    'summary'
  ], { encoding: 'utf8', env });
  assert.equal(summary.status, 0, summary.stderr);
  assert.match(summary.stdout, /Skill: skill:oaf-memory/);
  assert.match(summary.stdout, /Side effect: reversible-write/);
  assert.match(summary.stdout, /Approval required: yes/);
  assert.match(summary.stdout, /Required local reads: 2/);
  assert.match(summary.stdout, /workspace:\/\/skills\/oaf-memory\/manifest\.json/);
  assert.match(summary.stdout, /workspace:\/\/skills\/oaf-memory\/SKILL\.md/);
  assert.match(summary.stdout, /Raw skill text included: no/);
  assert.match(summary.stdout, /Tool authority granted: no/);
  assert.equal(summary.stdout.includes('Never auto-approve'), false);
  assert.equal(summary.stdout.includes('/Users/rebel'), false);

  const missingReadOnly = spawnSync(process.execPath, [
    'apps/cli/oaf.mjs',
    'skill',
    'load-plan',
    '--id',
    'skill:oaf-memory',
    '--format',
    'json'
  ], { encoding: 'utf8', env });
  assert.equal(missingReadOnly.status, 2);
  assert.match(missingReadOnly.stderr, /--read-only/);

  const writeMode = spawnSync(process.execPath, [
    'apps/cli/oaf.mjs',
    'skill',
    'load-plan',
    '--read-only',
    '--id',
    'skill:oaf-memory',
    '--write',
    '--format',
    'json'
  ], { encoding: 'utf8', env });
  assert.equal(writeMode.status, 2);
  assert.match(writeMode.stderr, /read-only/);
});

test('skill load-plan rejects symlinked skill files and references', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaf-skill-symlink-'));
  const outside = mkdtempSync(path.join(os.tmpdir(), 'oaf-skill-outside-'));
  mkdirSync(path.join(root, 'skills', 'linked-skill'), { recursive: true });
  writeFileSync(path.join(outside, 'SKILL.md'), '# Outside\n');
  writeFileSync(path.join(root, 'skills', 'linked-skill', 'manifest.json'), JSON.stringify({
    schemaVersion: '1.0.0',
    id: 'skill:linked-skill',
    name: 'Linked Skill',
    description: 'Symlinked skill document should not be loadable.',
    version: '0.1.0',
    triggers: ['linked'],
    tools: [],
    sideEffectClass: 'read-only',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    references: []
  }, null, 2));
  symlinkSync(path.join(outside, 'SKILL.md'), path.join(root, 'skills', 'linked-skill', 'SKILL.md'));
  const env = { ...process.env, OAF_FIXED_NOW: '2026-07-05T00:00:00.000Z' };
  const linkedSkill = spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'skill', 'load-plan', '--read-only', '--root', root, '--id', 'skill:linked-skill', '--format', 'json'], { encoding: 'utf8', env });
  assert.equal(linkedSkill.status, 2);
  assert.match(linkedSkill.stderr, /skills\/linked-skill\/SKILL\.md is a symlink/);
  assert.equal(linkedSkill.stdout, '');
  assert.equal(linkedSkill.stderr.includes(outside), false);

  mkdirSync(path.join(root, 'skills', 'linked-reference'), { recursive: true });
  writeFileSync(path.join(root, 'skills', 'linked-reference', 'SKILL.md'), '# Linked Reference\n');
  writeFileSync(path.join(outside, 'rules.md'), '# Outside Rules\n');
  writeFileSync(path.join(root, 'skills', 'linked-reference', 'manifest.json'), JSON.stringify({
    schemaVersion: '1.0.0',
    id: 'skill:linked-reference',
    name: 'Linked Reference',
    description: 'Symlinked reference should not be loadable.',
    version: '0.1.0',
    triggers: ['linked-reference'],
    tools: [],
    sideEffectClass: 'read-only',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    references: ['rules.md']
  }, null, 2));
  symlinkSync(path.join(outside, 'rules.md'), path.join(root, 'skills', 'linked-reference', 'rules.md'));
  const linkedReference = spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'skill', 'load-plan', '--read-only', '--root', root, '--id', 'skill:linked-reference', '--format', 'json'], { encoding: 'utf8', env });
  assert.equal(linkedReference.status, 2);
  assert.match(linkedReference.stderr, /skills\/linked-reference\/rules\.md is a symlink/);
  assert.equal(linkedReference.stdout, '');
  assert.equal(linkedReference.stderr.includes(outside), false);
});

test('skill catalog keeps loadable-only skills out of the human menu', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaf-skill-catalog-advertise-'));
  for (const name of ['visible', 'hidden']) {
    mkdirSync(path.join(root, 'skills', name), { recursive: true });
    writeFileSync(path.join(root, 'skills', name, 'SKILL.md'), `# ${name}\n\nUse ${name} safely.\n`);
  }
  writeFileSync(path.join(root, 'skills', 'visible', 'rules.md'), '# Rules\n\nKeep reference reads explicit.\n');
  writeFileSync(path.join(root, 'skills', 'visible', 'manifest.json'), JSON.stringify({
    schemaVersion: '1.0.0',
    id: 'skill:visible',
    name: 'Visible Skill',
    description: 'Visible skill can appear in the compact menu.',
    version: '0.1.0',
    triggers: ['visible'],
    tools: ['tool:filesystem-read'],
    sideEffectClass: 'read-only',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    references: ['rules.md']
  }, null, 2));
  writeFileSync(path.join(root, 'skills', 'hidden', 'manifest.json'), JSON.stringify({
    schemaVersion: '1.0.0',
    id: 'skill:hidden',
    name: 'Hidden Skill',
    description: 'Hidden skill remains loadable but not advertised.',
    version: '0.1.0',
    advertise: false,
    triggers: ['hidden'],
    tools: ['tool:hidden-read'],
    sideEffectClass: 'read-only',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    references: []
  }, null, 2));

  const env = { ...process.env, OAF_FIXED_NOW: '2026-07-05T00:00:00.000Z' };
  const json = spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'skill', 'catalog', '--read-only', '--root', root, '--format', 'json'], { encoding: 'utf8', env });
  assert.equal(json.status, 0, json.stderr);
  const report = JSON.parse(json.stdout);
  assertJsonSchema(skillCatalogReportSchema, report, 'skill catalog advertise report');
  assert.equal(report.summary.total, 2);
  assert.equal(report.summary.advertisedSkillCount, 1);
  assert.equal(report.summary.loadableOnlySkillCount, 1);
  assert.deepEqual(report.summary.toolIds, ['tool:filesystem-read', 'tool:hidden-read']);
  assert.deepEqual(report.summary.advertisedToolIds, ['tool:filesystem-read']);
  assert.equal(report.skills.find((skill) => skill.id === 'skill:visible').advertised, true);
  assert.equal(report.skills.find((skill) => skill.id === 'skill:hidden').advertised, false);
  const visibleLoadPlan = spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'skill', 'load-plan', '--read-only', '--root', root, '--id', 'skill:visible', '--format', 'json'], { encoding: 'utf8', env });
  assert.equal(visibleLoadPlan.status, 0, visibleLoadPlan.stderr);
  const visiblePlan = JSON.parse(visibleLoadPlan.stdout);
  assertJsonSchema(skillLoadPlanSchema, visiblePlan, 'skill load-plan reference report');
  assert.deepEqual(visiblePlan.requiredLocalReads.map((item) => item.kind), ['manifest', 'skill', 'reference']);
  assert.equal(visiblePlan.requiredLocalReads[2].ref, 'workspace://skills/visible/rules.md');

  const summary = spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'skill', 'catalog', '--read-only', '--root', root, '--format', 'summary'], { encoding: 'utf8', env });
  assert.equal(summary.status, 0, summary.stderr);
  assert.match(summary.stdout, /Advertised: 1/);
  assert.match(summary.stdout, /Loadable only: 1/);
  assert.match(summary.stdout, /Load plan: npm run oaf -- skill load-plan --read-only --root \. --id <skill:id> --format summary/);
  assert.match(summary.stdout, /- skill:visible \[read-only\]: Visible skill can appear in the compact menu\./);
  assert.match(summary.stdout, /Loadable-only skills omitted from menu: 1/);
  assert.equal(summary.stdout.includes('skill:hidden'), false);
  assert.equal(summary.stdout.includes('tool:hidden-read'), false);

  const mcp = spawnSync(process.execPath, [
    'apps/cli/oaf.mjs',
    'mcp',
    'resources',
    '--read-only',
    '--root',
    root,
    '--uri',
    'oaf://workspace/ws_local/skills/catalog',
    '--format',
    'json'
  ], { encoding: 'utf8', env });
  assert.equal(mcp.status, 0, mcp.stderr);
  const payload = JSON.parse(JSON.parse(mcp.stdout).contents[0].text);
  assert.equal(payload.data.summary.loadableOnlySkillCount, 1);
  assert.equal(payload.data.skills.find((skill) => skill.id === 'skill:hidden').advertised, false);

  const stdio = spawnSync(process.execPath, [
    'apps/cli/oaf.mjs',
    'mcp',
    'resources',
    '--read-only',
    '--root',
    root,
    '--stdio'
  ], {
    encoding: 'utf8',
    env,
    input: [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/list' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'oaf://workspace/ws_local/skills/catalog' } })
    ].join('\n')
  });
  assert.equal(stdio.status, 0, stdio.stderr);
  const responses = stdio.stdout.trim().split(/\n/u).map((line) => JSON.parse(line));
  assert(responses[0].result.resources.some((resource) => resource.uri === 'oaf://workspace/ws_local/skills/catalog'));
  assert.deepEqual(responses[1].result.tools, []);
  const stdioPayload = JSON.parse(responses[2].result.contents[0].text);
  assert.equal(stdioPayload.data.summary.loadableOnlySkillCount, 1);
  assert.equal(stdioPayload.data.skills.find((skill) => skill.id === 'skill:hidden').advertised, false);
});

test('skill catalog blocks skills that depend on disabled reviewed tools', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaf-skill-disabled-tool-'));
  mkdirSync(path.join(root, 'skills', 'needs-disabled-tool'), { recursive: true });
  mkdirSync(path.join(root, 'tools', 'manifests'), { recursive: true });
  writeFileSync(path.join(root, 'skills', 'needs-disabled-tool', 'SKILL.md'), '# Needs Disabled Tool\n');
  writeFileSync(path.join(root, 'skills', 'needs-disabled-tool', 'manifest.json'), JSON.stringify({
    schemaVersion: '1.0.0',
    id: 'skill:needs-disabled-tool',
    name: 'Needs Disabled Tool',
    description: 'A read-only skill that depends on a disabled reviewed tool.',
    version: '0.1.0',
    triggers: ['disabled-tool'],
    tools: ['tool:filesystem-read'],
    sideEffectClass: 'read-only',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    references: []
  }, null, 2));
  const toolManifest = readFileSync('tools/manifests/brokered-filesystem-read.json', 'utf8');
  writeFileSync(path.join(root, 'tools', 'manifests', 'brokered-filesystem-read.json'), toolManifest);
  writeFileSync(path.join(root, 'tools', 'catalog.json'), JSON.stringify({
    schemaVersion: '1.0.0',
    entries: [{
      toolId: 'tool:filesystem-read',
      manifestPath: 'tools/manifests/brokered-filesystem-read.json',
      sha256: createHash('sha256').update(toolManifest).digest('hex'),
      enabled: false,
      handlerBindingId: 'handler:brokered:workspace-file-read@1.0.0',
      reviewStatus: 'reviewed',
      reviewVersion: 'test-disabled-tool'
    }]
  }, null, 2));
  const env = { ...process.env, OAF_FIXED_NOW: '2026-07-05T00:00:00.000Z' };
  const catalog = spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'skill', 'catalog', '--read-only', '--root', root, '--format', 'json'], { encoding: 'utf8', env });
  assert.equal(catalog.status, 0, catalog.stderr);
  const report = JSON.parse(catalog.stdout);
  assertJsonSchema(skillCatalogReportSchema, report, 'skill catalog disabled tool report');
  const skill = report.skills.find((item) => item.id === 'skill:needs-disabled-tool');
  assert.equal(skill.readiness.state, 'blocked');
  assert.deepEqual(skill.readiness.unreviewedToolIds, []);
  assert.deepEqual(skill.readiness.disabledToolIds, ['tool:filesystem-read']);
  assert(skill.readiness.reasonCodes.includes('skill_declares_disabled_tools'));

  const loadPlan = spawnSync(process.execPath, ['apps/cli/oaf.mjs', 'skill', 'load-plan', '--read-only', '--root', root, '--id', 'skill:needs-disabled-tool', '--format', 'json'], { encoding: 'utf8', env });
  assert.equal(loadPlan.status, 0, loadPlan.stderr);
  const plan = JSON.parse(loadPlan.stdout);
  assertJsonSchema(skillLoadPlanSchema, plan, 'skill load-plan disabled tool report');
  assert.equal(plan.skill.readiness.state, 'blocked');
  assert.deepEqual(plan.skill.readiness.disabledToolIds, ['tool:filesystem-read']);
});
