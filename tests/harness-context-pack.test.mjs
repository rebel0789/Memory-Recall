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
    workspaceId: 'ws_local',
    targetHarness: 'codex',
    objective: 'Prepare the next coding agent to continue Open Agent Fabric approve token reset workflow',
    step: 'select useful handoff context with source graph hints',
    tokenBudget: 128,
    clock: fixedClock
  });

  assertJsonSchema(contextPackSchema, pack, 'context pack');
  assert.equal(pack.targetHarness, 'codex');
  assert.equal(pack.dryRun, true);
  assert.equal(pack.safeguards.externalWritesEnabled, false);
  assert.equal(pack.safeguards.externalAdaptersEnabled, 0);
  assert.equal(pack.safeguards.rawBodyIncluded, false);
  assert.equal(pack.safeguards.sourceGraphPreviewed, true);
  assert.equal(pack.safeguards.graphDatabaseUsed, false);
  assert.equal(pack.safeguards.sourceSlicesRead, false);
  assert.equal(pack.sourceGraph.status, 'available');
  assert.equal(pack.sourceGraph.safeguards.graphDatabaseUsed, false);
  assert.equal(pack.sourceGraph.safeguards.sourceSlicesRead, false);
  assert(pack.sourceGraph.summary.fileCount >= 1);
  assert(pack.sourceGraph.results.some((item) => item.locator === 'workspace://src/authWorkflow.ts#L1-L3'));
  assert(pack.readFirst.some((item) => item.locator === 'workspace://AGENTS.md'));
  assert(pack.handoff.instructions.some((item) => item.includes('Codex')));
  assert(pack.files.some((item) => item.path === 'CONTEXT_PACK.md' && item.role === 'agent-handoff'));

  const markdown = renderContextPackMarkdown(pack);
  assert.match(markdown, /^# Context Pack/m);
  assert.match(markdown, /Target harness: codex/);
  assert.match(markdown, /workspace:\/\/AGENTS\.md/);
  assert.match(markdown, /## Source Graph Hints/);
  assert.match(markdown, /workspace:\/\/src\/authWorkflow\.ts#L1-L3/);
  assert.match(markdown, /External writes: disabled/);
  assert(!markdown.includes('PACK RAW BODY'));
  assert(!markdown.includes('GRAPH RAW BODY SENTINEL'));
  assert(!JSON.stringify(pack).includes('PACK RAW BODY'));
  assert(!JSON.stringify(pack).includes('GRAPH RAW BODY SENTINEL'));
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
