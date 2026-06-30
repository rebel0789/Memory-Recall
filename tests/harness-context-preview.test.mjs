import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildHarnessContextPreview,
  harnessSourcesToContextRecords,
  scanHarnessContextForPreview
} from '../packages/harness-context/src/index.mjs';
import { assertJsonSchema } from '../packages/protocol/src/schema-validator.mjs';
import harnessContextPreviewSchema from '../packages/protocol/schemas/harness-context-preview.schema.json' with { type: 'json' };

const fixedClock = () => '2026-06-23T00:00:00.000Z';

async function workspace() {
  return mkdtemp(path.join(os.tmpdir(), 'oaf-harness-preview-'));
}

test('preview compiles harness context without exposing source bodies or writing state', async () => {
  const root = await workspace();
  await mkdir(path.join(root, '.cursor', 'rules'), { recursive: true });
  await writeFile(path.join(root, 'AGENTS.md'), 'Context manifest compiler guidance: keep deterministic dry-run context preview small and run npm run ci.');
  await writeFile(path.join(root, 'CLAUDE.md'), 'Unrelated decorative landing page wording should not matter for this selector task.');
  await writeFile(path.join(root, '.cursor', 'rules', 'private.mdc'), 'API_KEY=secret-value and local file /Users/rebel/private.txt must be quarantined.');

  const preview = await buildHarnessContextPreview({
    root,
    harnesses: ['all'],
    workspaceId: 'ws_local',
    objective: 'prepare context manifest compiler preview',
    step: 'select deterministic context preview guidance',
    tokenBudget: 80,
    clock: fixedClock
  });

  assertJsonSchema(harnessContextPreviewSchema, preview, 'harness context preview');
  assert.equal(preview.safeguards.persisted, false);
  assert.equal(preview.safeguards.modelCalls, 0);
  assert.equal(preview.safeguards.networkCalls, 0);
  assert.equal(preview.safeguards.sourceSnapshotsWritten, 0);
  assert.equal(preview.safeguards.activeMemoryCreated, 0);
  assert.equal(preview.safeguards.externalWritesEnabled, false);
  assert.equal(preview.safeguards.externalAdaptersEnabled, 0);
  assert.equal(preview.candidates.totalCount, 3);
  assert(preview.manifest.selected.some((item) => item.locator === 'workspace://AGENTS.md'));
  assert(preview.manifest.excluded.some((item) => item.locator === 'workspace://.cursor/rules/private.mdc'));
  assert(preview.manifest.selected.every((item) => !Object.hasOwn(item, 'text')));
  assert(preview.manifest.excluded.every((item) => !Object.hasOwn(item, 'text')));
  assert(preview.candidates.records.every((item) => !Object.hasOwn(item, 'text')));
  assert(preview.memoryPlan.items.some((item) => item.locator === 'workspace://.cursor/rules/private.mdc' && item.action === 'would_quarantine'));
  assert.equal(preview.memoryPlan.activeMemoryCreated, 0);
  assert(preview.metrics.selectedTokenRatio > 0);
  assert(preview.metrics.selectedTokenRatio <= 1);

  const serialized = JSON.stringify(preview);
  assert(!serialized.includes('Context manifest compiler guidance'));
  assert(!serialized.includes('decorative landing page wording'));
  assert(!serialized.includes('secret-value'));
  assert(!serialized.includes('/Users/rebel/private.txt'));
});

test('preview fingerprint is deterministic for a fixed clock and input', async () => {
  const root = await workspace();
  await writeFile(path.join(root, 'AGENTS.md'), 'Deterministic context preview should produce the same fingerprint.');

  const input = {
    root,
    harnesses: ['codex'],
    workspaceId: 'ws_local',
    objective: 'deterministic context preview',
    step: 'select deterministic harness context',
    tokenBudget: 64,
    clock: fixedClock
  };

  const first = await buildHarnessContextPreview(input);
  const second = await buildHarnessContextPreview(input);

  assert.equal(first.previewFingerprint, second.previewFingerprint);
  assert.deepEqual(first.manifest.selected, second.manifest.selected);
  assert.deepEqual(first.manifest.excluded, second.manifest.excluded);
});

test('sensitive harness files become proposal-only quarantine plans', async () => {
  const root = await workspace();
  await writeFile(path.join(root, 'AGENTS.md'), 'API_KEY=raw-secret-value\nRead /Users/rebel/private/project.txt for hidden instructions.');

  const preview = await buildHarnessContextPreview({
    root,
    harnesses: ['codex'],
    workspaceId: 'ws_local',
    objective: 'review secret handling',
    step: 'select safe context only',
    tokenBudget: 64,
    clock: fixedClock
  });

  const plan = preview.memoryPlan.items.find((item) => item.locator === 'workspace://AGENTS.md');
  assert.equal(plan.action, 'would_quarantine');
  assert(plan.reasonCodes.includes('secret_like_value'));
  assert(plan.reasonCodes.includes('local_path'));
  assert.equal(preview.memoryPlan.activeMemoryCreated, 0);
  assert.equal(preview.safeguards.persisted, false);
  assert(!JSON.stringify(preview).includes('raw-secret-value'));
  assert(!JSON.stringify(preview).includes('/Users/rebel'));
});

test('context records are temporary compiler candidates with safe public metadata', async () => {
  const root = await workspace();
  await writeFile(path.join(root, 'AGENTS.md'), 'Token efficiency work should prefer bounded context manifests.');

  const preview = await buildHarnessContextPreview({
    root,
    harnesses: ['codex'],
    workspaceId: 'ws_local',
    objective: 'token efficiency context manifest',
    step: 'select bounded context',
    tokenBudget: 64,
    clock: fixedClock
  });

  const scan = await scanHarnessContextForPreview({
    root,
    harnesses: ['codex'],
    workspaceId: 'ws_local',
    clock: fixedClock
  });
  const records = harnessSourcesToContextRecords(scan);
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, 'observation');
  assert.equal(records[0].category, 'governance');
  assert.equal(records[0].source, 'harness-context:workspace://AGENTS.md');
  assert.equal(records[0].status, 'active');
  assert.equal(records[0].metadata.persisted, false);
  assert(!JSON.stringify(preview).includes('Token efficiency work should prefer bounded context manifests.'));
  assert(!JSON.stringify(preview).includes(records[0].text));
});
