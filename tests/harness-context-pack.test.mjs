import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildContextPack,
  renderContextPackMarkdown
} from '../packages/harness-context/src/index.mjs';
import { assertJsonSchema } from '../packages/protocol/src/schema-validator.mjs';
import contextPackSchema from '../packages/protocol/schemas/context-pack.schema.json' with { type: 'json' };

const fixedClock = () => '2026-06-23T12:00:00.000Z';

async function workspace() {
  return mkdtemp(path.join(os.tmpdir(), 'oaf-context-pack-'));
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
  assert.doesNotMatch(markdown, /<objective>|<step>/);
  assert(!markdown.includes('PACK RAW BODY'));
  assert(!JSON.stringify(pack.omissions).includes('Claude-only note'));
  assert(!markdown.includes('GRAPH RAW BODY SENTINEL'));
  assert(!JSON.stringify(pack).includes('PACK RAW BODY'));
  assert(!JSON.stringify(pack).includes('GRAPH RAW BODY SENTINEL'));
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
  assert.equal(pack.utility.status, 'review');
  assert.deepEqual(pack.utility.changedLocatorCoverage, { total: 1, covered: 1, ratio: 1, status: 'covered' });
  const changedRead = pack.utility.requiredLocalReads.find((item) => item.locator === 'workspace://src/missing.ts' && item.role === 'changed_locator');
  assert(changedRead);
  assert.equal(changedRead.required, true);
  assert.equal(changedRead.contentHash, null);
  assert.equal(changedRead.reasonCodes.includes('content_hash_unavailable'), true);
  assert.equal(changedRead.reasonCodes.includes('missing_changed_locator'), true);
  const markdown = renderContextPackMarkdown(pack);
  assert.match(markdown, /hash changes readiness/);
  assert.match(markdown, /unavailable/);
  assert.match(markdown, /missing_changed_locator/);
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
