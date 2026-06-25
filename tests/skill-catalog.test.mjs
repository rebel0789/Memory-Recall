import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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
});
