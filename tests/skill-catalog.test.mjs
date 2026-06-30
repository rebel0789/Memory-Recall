import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

test('oaf memory mapper skill is registered as a governed reversible write', async () => {
  const { manifest, text } = await readSkill('oaf-memory');
  assert.equal(manifest.id, 'skill:oaf-memory');
  assert.equal(manifest.sideEffectClass, 'reversible-write');
  assert(manifest.triggers.includes('/oaf-memory'));
  assert(manifest.tools.includes('tool:workspace-write'));
  assert.match(text, /facts\.json schema/);
  assert.match(text, /oaf memory remember --batch facts\.json/);
  assert.match(text, /Never auto-approve/);
});
