import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildContextPack,
  buildContextPackCurrentPointer,
  buildContextPackRegistry,
  buildContextPackRegistryEntry,
  buildContextPackUsePlan,
  renderContextPackMarkdown,
  verifyContextPackRegistry
} from '../packages/harness-context/src/index.mjs';
import { assertJsonSchema } from '../packages/protocol/src/schema-validator.mjs';
import contextPackSchema from '../packages/protocol/schemas/context-pack.schema.json' with { type: 'json' };
import contextPackUsePlanSchema from '../packages/protocol/schemas/context-pack-use-plan.schema.json' with { type: 'json' };

const fixedClock = () => '2026-06-23T12:00:00.000Z';

async function workspace() {
  return mkdtemp(path.join(os.tmpdir(), 'oaf-context-pack-'));
}

function repeatedWords(prefix, count) {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index}`).join(' ');
}

function assertRequiredRead(usePlan, locator, role) {
  const read = usePlan.requiredLocalReads.find((item) => item.locator === locator && item.role === role);
  assert(read, `missing required read ${role}:${locator}`);
  assert.equal(read.required, true);
  return read;
}

test('context pack renders a harness-specific handoff without raw source bodies or writes', async () => {
  const root = await workspace();
  await mkdir(path.join(root, '.cursor', 'rules'), { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'AGENTS.md'), 'PACK RAW BODY: preserve local-only boundaries and run npm run ci.');
  await writeFile(path.join(root, 'CLAUDE.md'), 'Claude-only note that should be referenced by locator, not copied.');
  await writeFile(path.join(root, '.cursor', 'rules', 'fabric.mdc'), 'Cursor rule for OAF context pack testing.');
  await writeFile(path.join(root, 'src', 'authWorkflow.ts'), [
    'export function approveTokenResetWorkflow() {',
    "  return 'GRAPH RAW BODY SENTINEL';",
    '}'
  ].join('\n'));

  const pack = await buildContextPack({
    root,
    harnesses: ['all'],
    changedLocators: ['src/authWorkflow.ts'],
    workspaceId: 'ws_local',
    targetHarness: 'codex',
    objective: 'Prepare the next coding agent to continue Open Agent Fabric approve token reset workflow',
    step: 'select useful handoff context with source graph hints',
    tokenBudget: 128,
    clock: fixedClock
  });

  assertJsonSchema(contextPackSchema, pack, 'context pack');
  assert.equal(pack.targetHarness, 'codex');
  assert.deepEqual(pack.sourceHarnesses, ['codex', 'claude-code', 'cursor']);
  assert.equal(pack.dryRun, true);
  assert.equal(pack.safeguards.externalWritesEnabled, false);
  assert.equal(pack.safeguards.externalAdaptersEnabled, 0);
  assert.equal(pack.safeguards.rawBodyIncluded, false);
  assert.equal(pack.safeguards.sourceGraphPreviewed, true);
  assert.equal(pack.safeguards.graphDatabaseUsed, false);
  assert.equal(pack.safeguards.sourceSlicesRead, false);
  assert.equal(pack.delivery.representation, 'locator-handoff');
  assert.equal(pack.delivery.sourceCandidateTokenCount, pack.preview.candidateTokenCount);
  assert.equal(pack.delivery.sourceSelectedTokenCount, pack.preview.selectedTokenCount);
  assert.equal(pack.delivery.sourceContentTokenCountIncluded, 0);
  assert.equal(pack.delivery.sourceContentsIncluded, false);
  assert.equal(pack.sourceGraph.status, 'available');
  assert.deepEqual(pack.sourceGraph.impact.changedLocators, ['workspace://src/authWorkflow.ts']);
  assert.deepEqual(pack.sourceGraph.impact.representedChangedLocators, ['workspace://src/authWorkflow.ts']);
  assert(pack.sourceGraph.impact.affectedSymbols.some((item) => item.name === 'approveTokenResetWorkflow'));
  assert.equal(pack.sourceGraph.impact.omittedAffectedSymbolCount, 0);
  assert.equal(pack.sourceGraph.safeguards.graphDatabaseUsed, false);
  assert.equal(pack.sourceGraph.safeguards.sourceSlicesRead, false);
  assert(pack.sourceGraph.summary.fileCount >= 1);
  assert(pack.sourceGraph.results.some((item) => item.locator === 'workspace://src/authWorkflow.ts#L1-L3'));
  assert.equal(pack.utility.status, 'ready');
  assert.deepEqual(pack.utility.changedLocatorCoverage, { total: 1, covered: 1, ratio: 1, status: 'covered' });
  const changedRead = pack.utility.requiredLocalReads.find((item) => item.locator === 'workspace://src/authWorkflow.ts' && item.role === 'changed_locator');
  assert(changedRead);
  assert.equal(changedRead.required, true);
  assert.match(changedRead.contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(changedRead.reasonCodes.includes('content_hash_verified'), true);
  assert(pack.utility.requiredLocalReads.some((item) => item.role === 'source_graph_hint' && item.required === false));
  assert.equal(pack.utility.sourceSelection.candidateTokenCount, pack.preview.candidateTokenCount);
  assert.equal(pack.utility.delivery.sourceContentsIncluded, false);
  assert(pack.readFirst.some((item) => item.locator === 'workspace://AGENTS.md'));
  assert.equal(pack.omissions.excludedCount, pack.excluded.length);
  assert.equal(pack.omissions.excludedTokenCount, pack.excluded.reduce((sum, item) => sum + item.tokens, 0));
  assert.equal(pack.omissions.sourceGraphOmittedCount, pack.sourceGraph.omittedCount);
  assert(pack.omissions.refs.every((item) => item.id.startsWith('omit_')));
  assert(pack.handoff.instructions.some((item) => item.includes('Codex')));
  assert(pack.handoff.commands.some((item) => item.includes("--objective 'Prepare the next coding agent")));
  assert(pack.handoff.commands.some((item) => item.includes("--changed 'src/authWorkflow.ts'")));
  assert(pack.handoff.launchPrompt.includes('Changed-file coverage: 1/1'));
  assert(pack.files.some((item) => item.path === 'CONTEXT_PACK.md' && item.role === 'agent-handoff'));

  const markdown = renderContextPackMarkdown(pack);
  assert.match(markdown, /^# Context Pack/m);
  assert.match(markdown, /Target harness: codex/);
  assert.match(markdown, /Source families: codex, claude-code, cursor/);
  assert.match(markdown, /workspace:\/\/AGENTS\.md/);
  assert.match(markdown, /## Delivery Budget/);
  assert.match(markdown, /## Launch Prompt/);
  assert.match(markdown, /## Utility Read Plan/);
  assert.match(markdown, /Content Hash/);
  assert.match(markdown, /content_hash_verified/);
  assert.match(markdown, /## Omission Refs/);
  assert.match(markdown, /## Source Graph Hints/);
  assert.match(markdown, /## Change Impact/);
  assert.match(markdown, /workspace:\/\/src\/authWorkflow\.ts/);
  assert.match(markdown, /approveTokenResetWorkflow/);
  assert.match(markdown, /workspace:\/\/src\/authWorkflow\.ts#L1-L3/);
  assert.match(markdown, /External writes: disabled/);
  assert.match(markdown, /Complete command set: \d+ commands in structured pack data/);
  assert.match(markdown, /npm run doctor/);
  assert.match(markdown, /npm run oaf -- context registry status --read-only --format json/);
  assert.match(markdown, /npm run ci/);
  assert.doesNotMatch(markdown, /npm run oaf -- context pack --from/);
  assert.doesNotMatch(markdown, /<objective>|<step>/);
  assert(!markdown.includes('PACK RAW BODY'));
  assert(!JSON.stringify(pack.omissions).includes('Claude-only note'));
  assert(!markdown.includes('GRAPH RAW BODY SENTINEL'));
  assert(!JSON.stringify(pack).includes('PACK RAW BODY'));
  assert(!JSON.stringify(pack).includes('GRAPH RAW BODY SENTINEL'));
});

test('context pack use plan exposes complete local reads without private handoff content', async () => {
  const root = await workspace();
  await mkdir(path.join(root, 'notes'), { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'AGENTS.md'), 'USE PLAN AGENTS RAW BODY should stay out of use plan output.');
  await writeFile(path.join(root, 'notes', 'handoff.md'), 'USE PLAN SELECTED RAW BODY should stay out.');
  await writeFile(path.join(root, 'src', 'auth.ts'), [
    'export function approveTokenResetUsePlan() {',
    "  return 'USE PLAN SOURCE RAW BODY';",
    '}'
  ].join('\n'));

  const objective = 'Use plan private objective should not leak';
  const step = 'Use plan private step should not leak';
  const pack = await buildContextPack({
    root,
    harnesses: ['codex'],
    userSelectedFiles: ['notes/handoff.md'],
    changedLocators: ['src/auth.ts'],
    workspaceId: 'ws_local',
    targetHarness: 'codex',
    objective,
    step,
    tokenBudget: 4096,
    clock: fixedClock
  });
  const usePlan = buildContextPackUsePlan(pack);

  assertJsonSchema(contextPackUsePlanSchema, usePlan, 'context pack use plan');
  assert.equal(usePlan.contextPack.id, pack.id);
  assert.equal(usePlan.contextPack.fingerprint, pack.contextPackFingerprint);
  assert.equal(usePlan.resource.uri, 'oaf://workspace/ws_local/context-pack/use-plan/current');
  assert.equal(usePlan.requiredLocalReads.some((item) => item.locator === 'workspace://AGENTS.md'), true);
  assert.equal(usePlan.requiredLocalReads.some((item) => item.locator === 'user-selected://notes/handoff.md'), true);
  assert.equal(usePlan.requiredLocalReads.some((item) => item.locator === 'workspace://src/auth.ts'), true);
  assert.equal(usePlan.requiredLocalReads.every((item) => typeof item.readHint === 'string' && item.readHint.length > 0), true);
  assert.equal(usePlan.safeguards.readOnly, true);
  assert.equal(usePlan.safeguards.localFilesWritten, 0);
  assert.equal(usePlan.safeguards.objectiveTextIncluded, false);
  assert.equal(usePlan.safeguards.stepTextIncluded, false);
  assert.equal(usePlan.safeguards.markdownContentIncluded, false);
  assert.equal(usePlan.safeguards.sourceContentIncluded, false);
  assert.equal(usePlan.safeguards.absoluteFilesystemLocationsIncluded, false);
  const serialized = JSON.stringify(usePlan);
  for (const forbidden of [
    'USE PLAN AGENTS RAW BODY',
    'USE PLAN SELECTED RAW BODY',
    'USE PLAN SOURCE RAW BODY',
    objective,
    step,
    root,
    '/Users/rebel'
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('context pack registry verifies pinned artifacts without exposing private content', async () => {
  const root = await workspace();
  await mkdir(path.join(root, 'context-packs'), { recursive: true });
  await mkdir(path.join(root, 'notes'), { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'AGENTS.md'), 'REGISTRY AGENTS RAW BODY should stay out of registry status.');
  await writeFile(path.join(root, 'notes', 'handoff.md'), 'REGISTRY SELECTED RAW BODY should stay out.');
  await writeFile(path.join(root, 'src', 'auth.ts'), [
    'export function approveTokenResetRegistry() {',
    "  return 'REGISTRY SOURCE RAW BODY';",
    '}'
  ].join('\n'));

  const objective = 'Registry private objective should not leak';
  const step = 'Registry private step should not leak';
  const pack = await buildContextPack({
    root,
    harnesses: ['codex'],
    userSelectedFiles: ['notes/handoff.md'],
    changedLocators: ['src/auth.ts'],
    workspaceId: 'ws_local',
    targetHarness: 'codex',
    objective,
    step,
    tokenBudget: 4096,
    clock: fixedClock
  });
  const markdown = renderContextPackMarkdown(pack);
  const usePlan = buildContextPackUsePlan(pack);
  const usePlanContent = JSON.stringify(usePlan, null, 2);
  const registryEntry = buildContextPackRegistryEntry({
    pack,
    usePlan,
    markdown,
    usePlanContent,
    markdownPath: 'context-packs/CONTEXT_PACK.md',
    usePlanPath: 'context-packs/CONTEXT_PACK.use.json',
    createdAt: fixedClock()
  });
  const registry = buildContextPackRegistry({ entry: registryEntry, workspaceId: 'ws_local', updatedAt: fixedClock() });
  const current = buildContextPackCurrentPointer({ registry, entry: registryEntry, updatedAt: fixedClock() });
  await writeFile(path.join(root, 'context-packs', 'CONTEXT_PACK.md'), markdown);
  await writeFile(path.join(root, 'context-packs', 'CONTEXT_PACK.use.json'), usePlanContent);
  await writeFile(path.join(root, 'context-packs', 'registry.json'), JSON.stringify(registry, null, 2));
  await writeFile(path.join(root, 'context-packs', 'current.json'), JSON.stringify(current, null, 2));

  const verified = await verifyContextPackRegistry({ root, workspaceId: 'ws_local', clock: fixedClock });
  assert.equal(verified.current.status, 'verified');
  assert.equal(verified.entries[0].artifactChecks.every((item) => item.status === 'verified'), true);
  assert.equal(verified.entries[0].sourceChecks.staleLocators.length, 0);
  assert.equal(verified.safeguards.localFilesWritten, 0);
  const serialized = JSON.stringify(verified);
  for (const forbidden of [
    'REGISTRY AGENTS RAW BODY',
    'REGISTRY SELECTED RAW BODY',
    'REGISTRY SOURCE RAW BODY',
    objective,
    step,
    root,
    '/Users/rebel'
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('context pack keeps missing changed locators in review with unavailable hash proof', async () => {
  const root = await workspace();
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'AGENTS.md'), 'Review missing changed locators before handoff.');

  const pack = await buildContextPack({
    root,
    harnesses: ['codex'],
    changedLocators: ['src/missing.ts'],
    workspaceId: 'ws_local',
    targetHarness: 'codex',
    objective: 'Prepare handoff with missing changed file',
    step: 'prove unavailable hash changes readiness',
    tokenBudget: 4096,
    clock: fixedClock
  });

  assertJsonSchema(contextPackSchema, pack, 'context pack with missing changed locator');
  assert.deepEqual(pack.sourceGraph.impact.changedLocators, ['workspace://src/missing.ts']);
  assert.deepEqual(pack.sourceGraph.impact.representedChangedLocators, []);
  assert.equal(pack.utility.status, 'review');
  assert.deepEqual(pack.utility.changedLocatorCoverage, { total: 1, covered: 0, ratio: 0, status: 'partial' });
  const changedRead = pack.utility.requiredLocalReads.find((item) => item.locator === 'workspace://src/missing.ts' && item.role === 'changed_locator');
  assert(changedRead);
  assert.equal(changedRead.required, true);
  assert.equal(changedRead.represented, false);
  assert.equal(changedRead.contentHash, null);
  assert.equal(changedRead.reasonCodes.includes('source_graph_changed_locator_unmatched'), true);
  assert.equal(changedRead.reasonCodes.includes('content_hash_unavailable'), true);
  assert.equal(changedRead.reasonCodes.includes('missing_changed_locator'), true);
  const markdown = renderContextPackMarkdown(pack);
  assert.match(markdown, /hash changes readiness/);
  assert.match(markdown, /unavailable/);
  assert.match(markdown, /missing_changed_locator/);
});

test('context pack keeps non-graph changed files in review without overclaiming coverage', async () => {
  const root = await workspace();
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'AGENTS.md'), 'Review README-only changes before handoff.');
  await writeFile(path.join(root, 'README.md'), '# Operator Notes\n\nNo TypeScript symbols live here.\n');
  await writeFile(path.join(root, 'src', 'index.ts'), 'export const indexedSymbol = true;\n');

  const pack = await buildContextPack({
    root,
    harnesses: ['codex'],
    changedLocators: ['README.md'],
    workspaceId: 'ws_local',
    targetHarness: 'codex',
    objective: 'Prepare handoff for documentation-only context change',
    step: 'prove changed file coverage is not overclaimed',
    tokenBudget: 4096,
    clock: fixedClock
  });

  assertJsonSchema(contextPackSchema, pack, 'context pack with non-graph changed locator');
  assert.deepEqual(pack.sourceGraph.impact.changedLocators, ['workspace://README.md']);
  assert.deepEqual(pack.sourceGraph.impact.representedChangedLocators, []);
  assert.equal(pack.sourceGraph.warnings.includes('source_graph_changed_locator_unmatched'), true);
  assert.equal(pack.utility.status, 'review');
  assert.deepEqual(pack.utility.changedLocatorCoverage, { total: 1, covered: 0, ratio: 0, status: 'partial' });
  const changedRead = pack.utility.requiredLocalReads.find((item) => item.locator === 'workspace://README.md' && item.role === 'changed_locator');
  assert(changedRead);
  assert.equal(changedRead.required, true);
  assert.equal(changedRead.represented, false);
  assert.match(changedRead.contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(changedRead.reasonCodes.includes('source_graph_changed_locator_unmatched'), true);
  assert.equal(changedRead.reasonCodes.includes('content_hash_verified'), true);
  assert.equal(pack.handoff.launchPrompt.includes('Changed-file coverage: 0/1'), true);
});

test('context pack hashes large changed text files without embedding source bodies', async () => {
  const root = await workspace();
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'AGENTS.md'), 'Review large changed file hash proof before handoff.');
  await writeFile(path.join(root, 'src', 'large.ts'), [
    'export function largeChangedFile() {',
    `  return '${'large-body-sentinel '.repeat(3800)}';`,
    '}'
  ].join('\n'));

  const pack = await buildContextPack({
    root,
    harnesses: ['codex'],
    changedLocators: ['src/large.ts'],
    workspaceId: 'ws_local',
    targetHarness: 'codex',
    objective: 'Prepare handoff with large changed file',
    step: 'prove large file hash without raw body',
    tokenBudget: 4096,
    clock: fixedClock
  });

  assertJsonSchema(contextPackSchema, pack, 'context pack with large changed text file');
  assert.equal(pack.utility.status, 'ready');
  const changedRead = pack.utility.requiredLocalReads.find((item) => item.locator === 'workspace://src/large.ts' && item.role === 'changed_locator');
  assert(changedRead);
  assert.match(changedRead.contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(changedRead.reasonCodes.includes('content_hash_verified'), true);
  assert.equal(changedRead.reasonCodes.includes('oversized'), false);
  assert(!JSON.stringify(pack).includes('large-body-sentinel'));
});

test('context pack rejects unsafe changed locators before building a handoff', async () => {
  const root = await workspace();
  await writeFile(path.join(root, 'AGENTS.md'), 'Do not leak /Users/rebel/private.txt token=secret-value.');

  await assert.rejects(
    () => buildContextPack({
      root,
      harnesses: ['codex'],
      changedLocators: ['workspace://../secret.ts'],
      workspaceId: 'ws_local',
      targetHarness: 'codex',
      objective: 'Prepare unsafe locator test',
      step: 'reject path escape',
      clock: fixedClock
    }),
    /changed_context_locator_invalid/
  );
});

test('context pack rejects secret-like or absolute-path handoff fields before rendering markdown', async () => {
  const root = await workspace();
  await writeFile(path.join(root, 'AGENTS.md'), 'Do not echo unsafe objective fields.');

  await assert.rejects(
    () => buildContextPack({
      root,
      harnesses: ['codex'],
      workspaceId: 'ws_local',
      targetHarness: 'codex',
      objective: 'prepare handoff token=secret-value',
      step: 'select context',
      clock: fixedClock
    }),
    /context_pack_objective_unsafe/
  );

  await assert.rejects(
    () => buildContextPack({
      root,
      harnesses: ['codex'],
      workspaceId: 'ws_local',
      targetHarness: 'codex',
      objective: 'prepare handoff',
      step: 'read /Users/rebel/private.txt',
      clock: fixedClock
    }),
    /context_pack_step_unsafe/
  );
});

test('context pack delivery budget separates locator handoff cost from source selection cost', async () => {
  const root = await workspace();
  const largeInstruction = Array.from({ length: 420 }, (_, index) => `policy-${index} preserve local-only context boundaries`).join(' ');
  await writeFile(path.join(root, 'AGENTS.md'), `LONG RAW POLICY BODY ${largeInstruction}`);

  const pack = await buildContextPack({
    root,
    harnesses: ['codex'],
    workspaceId: 'ws_local',
    targetHarness: 'codex',
    objective: 'Prepare a compact locator handoff for a large repository policy file',
    step: 'measure delivered context budget',
    tokenBudget: 8192,
    clock: fixedClock
  });

  assertJsonSchema(contextPackSchema, pack, 'context pack delivery budget');
  assert.deepEqual(pack.sourceHarnesses, ['codex']);
  assert.equal(pack.readFirst.some((item) => item.locator === 'workspace://AGENTS.md'), true);
  assert(pack.delivery.sourceSelectedTokenCount > 1000);
  assert(pack.delivery.deliveredTokenCount < pack.delivery.sourceSelectedTokenCount);
  assert(pack.delivery.deliveredTokenRatio < pack.delivery.sourceSelectedTokenRatio);
  assert(pack.delivery.observedTokenReductionRatio > 0);
  assert.equal(pack.delivery.sourceContentTokenCountIncluded, 0);
  assert.equal(pack.delivery.sourceContentsIncluded, false);
  const markdown = renderContextPackMarkdown(pack);
  assert.match(markdown, /Delivered handoff tokens:/);
  assert(!markdown.includes('LONG RAW POLICY BODY'));
  assert(!JSON.stringify(pack).includes('LONG RAW POLICY BODY'));
});

test('context pack delivery stays compact on a realistic local pack without weakening read plan safety', async () => {
  const root = await workspace();
  await mkdir(path.join(root, '.cursor', 'rules'), { recursive: true });
  await mkdir(path.join(root, 'docs', 'implementation'), { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(
    path.join(root, 'AGENTS.md'),
    `REALISTIC SELECTED RAW BODY ${repeatedWords('read-first-local-policy', 1000)}`
  );
  await writeFile(
    path.join(root, 'CLAUDE.md'),
    `REALISTIC CLAUDE RAW BODY ${repeatedWords('claude-distractor-policy', 850)}`
  );
  await writeFile(
    path.join(root, '.cursorrules'),
    `REALISTIC CURSOR RAW BODY ${repeatedWords('cursor-rule-distractor', 650)}`
  );
  await writeFile(
    path.join(root, '.cursor', 'mcp.json'),
    `{"note":"REALISTIC MCP RAW BODY token=secret-value /Users/rebel/private ${repeatedWords('mcp-config-distractor', 350)}"}`
  );
  await writeFile(
    path.join(root, '.cursor', 'rules', 'delivery.mdc'),
    `REALISTIC CURSOR RULE RAW BODY ${repeatedWords('delivery-rule-distractor', 400)}`
  );
  await writeFile(
    path.join(root, 'docs', 'implementation', 'OAF-031-context-intake-preview-note.md'),
    `REALISTIC SELECTED DOC RAW BODY ${repeatedWords('explicit-user-selected-doc', 350)}`
  );
  await writeFile(
    path.join(root, 'src', 'contextPackMeasure.ts'),
    [
      'export function contextPackMeasureDelivery() {',
      "  return 'REALISTIC SOURCE RAW BODY';",
      '}'
    ].join('\n')
  );

  const pack = await buildContextPack({
    root,
    harnesses: ['all'],
    userSelectedFiles: ['docs/implementation/OAF-031-context-intake-preview-note.md'],
    changedLocators: ['src/contextPackMeasure.ts'],
    workspaceId: 'ws_local',
    targetHarness: 'codex',
    objective: 'Prove context pack delivery efficiency on realistic local OAF pack',
    step: 'preserve read-first omission refs and use-plan required reads while measuring delivered locator handoff',
    tokenBudget: 16384,
    clock: fixedClock
  });
  const usePlan = buildContextPackUsePlan(pack);
  const markdown = renderContextPackMarkdown(pack);

  assertJsonSchema(contextPackSchema, pack, 'realistic context pack delivery');
  assertJsonSchema(contextPackUsePlanSchema, usePlan, 'realistic context pack use plan');
  assert(pack.delivery.sourceCandidateTokenCount >= 12000);
  assert(pack.delivery.sourceSelectedTokenCount >= 3500);
  assert(pack.omissions.excludedTokenCount >= 7000);
  assert(pack.omissions.excludedCount >= 3);
  assert(pack.delivery.deliveredTokenRatio <= 0.12);
  assert(pack.delivery.observedTokenReductionRatio >= 0.88);
  assert(pack.delivery.deliveredTokenCount <= Math.floor(pack.delivery.sourceSelectedTokenCount * 0.45));
  assert.equal(pack.readFirst.some((item) => item.locator === 'workspace://AGENTS.md'), true);
  assert.equal(pack.omissions.refs.length, pack.excluded.length);
  assert(pack.omissions.refs.every((item) => item.id.startsWith('omit_')));
  assertRequiredRead(usePlan, 'workspace://AGENTS.md', 'selected_context');
  assertRequiredRead(usePlan, 'user-selected://docs/implementation/OAF-031-context-intake-preview-note.md', 'selected_context');
  assertRequiredRead(usePlan, 'workspace://src/contextPackMeasure.ts', 'changed_locator');
  assert.equal(usePlan.safeguards.readOnly, true);
  assert.equal(usePlan.safeguards.localFilesWritten, 0);
  assert.equal(usePlan.safeguards.markdownContentIncluded, false);
  assert.equal(usePlan.safeguards.sourceContentIncluded, false);
  assert.equal(usePlan.safeguards.objectiveTextIncluded, false);
  assert.equal(usePlan.safeguards.stepTextIncluded, false);
  for (const forbidden of [
    'REALISTIC SELECTED RAW BODY',
    'REALISTIC CLAUDE RAW BODY',
    'REALISTIC CURSOR RAW BODY',
    'REALISTIC MCP RAW BODY',
    'REALISTIC CURSOR RULE RAW BODY',
    'REALISTIC SELECTED DOC RAW BODY',
    'REALISTIC SOURCE RAW BODY',
    'secret-value',
    '/Users/rebel/private'
  ]) {
    assert.equal(markdown.includes(forbidden), false, forbidden);
    assert.equal(JSON.stringify(pack).includes(forbidden), false, forbidden);
    assert.equal(JSON.stringify(usePlan).includes(forbidden), false, forbidden);
  }
});

test('context pack fingerprints are deterministic for fixed input', async () => {
  const root = await workspace();
  await writeFile(path.join(root, 'AGENTS.md'), 'Deterministic context pack should keep stable selected locators.');
  const input = {
    root,
    harnesses: ['codex'],
    workspaceId: 'ws_local',
    targetHarness: 'generic',
    objective: 'Build a reusable context pack',
    step: 'select repository guidance',
    tokenBudget: 64,
    clock: fixedClock
  };

  const first = await buildContextPack(input);
  const second = await buildContextPack(input);
  assert.equal(first.contextPackFingerprint, second.contextPackFingerprint);
  assert.deepEqual(first.readFirst, second.readFirst);
  assert.equal(renderContextPackMarkdown(first), renderContextPackMarkdown(second));
});

test('context pack can include explicit user-selected files without activating memory', async () => {
  const root = await workspace();
  await mkdir(path.join(root, 'notes'), { recursive: true });
  await writeFile(path.join(root, 'AGENTS.md'), 'Use deterministic local context pack workflows.');
  await writeFile(path.join(root, 'notes', 'handoff.md'), 'BridgeContextSpecial selected file for local source graph handoff. USER SELECTED RAW BODY.');

  const pack = await buildContextPack({
    root,
    harnesses: ['codex'],
    userSelectedFiles: ['notes/handoff.md'],
    workspaceId: 'ws_local',
    targetHarness: 'codex',
    objective: 'Continue BridgeContextSpecial source graph handoff',
    step: 'select explicit user-selected handoff context',
    tokenBudget: 4096,
    clock: fixedClock
  });

  assertJsonSchema(contextPackSchema, pack, 'context pack with user selected file');
  assert(pack.readFirst.some((item) => item.locator === 'user-selected://notes/handoff.md' && item.harness === 'generic-mcp'));
  assert(pack.memoryPlan.items.some((item) => item.locator === 'user-selected://notes/handoff.md' && item.action === 'would_propose'));
  assert.equal(pack.memoryPlan.activeMemoryCreated, 0);
  assert.equal(pack.safeguards.activeMemoryCreated, 0);
  const markdown = renderContextPackMarkdown(pack);
  assert.match(markdown, /user-selected:\/\/notes\/handoff\.md/);
  assert(!markdown.includes('USER SELECTED RAW BODY'));
  assert(!JSON.stringify(pack).includes('USER SELECTED RAW BODY'));
});

test('context pack preserves explicit user-selected files even when excluded by budget', async () => {
  const root = await workspace();
  await mkdir(path.join(root, 'notes'), { recursive: true });
  await writeFile(path.join(root, 'AGENTS.md'), 'Always read repository instructions first.');
  await writeFile(
    path.join(root, 'notes', 'large-handoff.md'),
    Array.from({ length: 240 }, (_, index) => `large omitted handoff note ${index} RAW LARGE USER BODY`).join('\n')
  );

  const pack = await buildContextPack({
    root,
    harnesses: ['codex'],
    userSelectedFiles: ['notes/large-handoff.md'],
    workspaceId: 'ws_local',
    targetHarness: 'codex',
    objective: 'Continue the repository instruction handoff',
    step: 'preserve explicit omitted user file',
    tokenBudget: 72,
    clock: fixedClock
  });

  assertJsonSchema(contextPackSchema, pack, 'context pack with omitted user-selected file');
  assert.deepEqual(pack.requestedInputs.userSelectedLocators, ['user-selected://notes/large-handoff.md']);
  assert.equal(pack.readFirst.some((item) => item.locator === 'user-selected://notes/large-handoff.md'), false);
  assert.equal(pack.excluded.some((item) => item.locator === 'user-selected://notes/large-handoff.md'), true);
  const explicitRead = pack.utility.requiredLocalReads.find((item) => item.locator === 'user-selected://notes/large-handoff.md' && item.role === 'explicit_user_selected');
  assert(explicitRead);
  assert.equal(explicitRead.required, true);
  assert.equal(explicitRead.represented, true);
  assert.match(explicitRead.contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(explicitRead.reasonCodes.includes('content_hash_verified'), true);
  assert(pack.handoff.commands.some((item) => item.includes("--include-file 'notes/large-handoff.md'")));
  const markdown = renderContextPackMarkdown(pack);
  assert.match(markdown, /## Requested Inputs/);
  assert.match(markdown, /user-selected:\/\/notes\/large-handoff\.md/);
  assert.doesNotMatch(markdown, /RAW LARGE USER BODY/);
  assert.doesNotMatch(JSON.stringify(pack), /RAW LARGE USER BODY/);
});
