import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanHarnessContext } from '../packages/harness-context/src/index.mjs';
import { assertJsonSchema } from '../packages/protocol/src/schema-validator.mjs';
import harnessContextSourceSchema from '../packages/protocol/schemas/harness-context-source.schema.json' with { type: 'json' };

const fixedClock = () => '2026-06-22T00:00:00.000Z';

async function workspace() {
  return mkdtemp(path.join(os.tmpdir(), 'oaf-harness-context-'));
}

function sha256Ref(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

test('scans Codex AGENTS.md without exposing raw content', async () => {
  const root = await workspace();
  await writeFile(path.join(root, 'AGENTS.md'), 'Use npm run ci. API_KEY=secret-value. Path /Users/rebel/private.txt');

  const report = await scanHarnessContext({ root, harnesses: ['codex'], workspaceId: 'ws_local', clock: fixedClock });

  assert.equal(report.summary.totalAccepted, 1);
  assert.equal(report.summary.totalSkipped, 0);
  assert.equal(report.sources[0].harness, 'codex');
  assert.equal(report.sources[0].sourceKind, 'instruction');
  assert.equal(report.sources[0].redactions.secretCount, 1);
  assert.equal(report.sources[0].redactions.localPathCount, 1);
  assertJsonSchema(harnessContextSourceSchema, report.sources[0], 'harness context source');
  const serialized = JSON.stringify(report);
  assert(!serialized.includes('secret-value'));
  assert(!serialized.includes('/Users/rebel/private.txt'));
});

test('scans Codex nested AGENTS.md for changed locators without exposing raw content', async () => {
  const root = await workspace();
  await mkdir(path.join(root, 'apps', 'cli'), { recursive: true });
  await writeFile(path.join(root, 'AGENTS.md'), 'Read root instructions first.');
  await writeFile(path.join(root, 'apps', 'cli', 'AGENTS.md'), 'NESTED RAW CLI INSTRUCTION: keep stdout stable.');

  const report = await scanHarnessContext({
    root,
    harnesses: ['codex'],
    changedLocators: ['apps/cli/oaf.mjs'],
    workspaceId: 'ws_local',
    clock: fixedClock
  });

  assert.deepEqual(report.sources.map((source) => source.provenance.locator), [
    'workspace://AGENTS.md',
    'workspace://apps/cli/AGENTS.md'
  ]);
  assert.equal(report.summary.totalSkipped, 0);
  assert(!JSON.stringify(report).includes('NESTED RAW CLI INSTRUCTION'));
});

test('scans Claude Code nested CLAUDE.md for changed locators without exposing raw content', async () => {
  const root = await workspace();
  await mkdir(path.join(root, 'packages', 'runtime'), { recursive: true });
  await writeFile(path.join(root, 'CLAUDE.md'), 'Read root Claude instructions first.');
  await writeFile(path.join(root, 'packages', 'runtime', 'CLAUDE.md'), 'NESTED RAW CLAUDE INSTRUCTION: preserve runtime events.');

  const report = await scanHarnessContext({
    root,
    harnesses: ['claude-code'],
    changedLocators: ['packages/runtime/index.mjs'],
    workspaceId: 'ws_local',
    clock: fixedClock
  });

  assert.deepEqual(report.sources.map((source) => source.provenance.locator), [
    'workspace://CLAUDE.md',
    'workspace://packages/runtime/CLAUDE.md'
  ]);
  assert.equal(report.summary.totalSkipped, 0);
  assert(!JSON.stringify(report).includes('NESTED RAW CLAUDE INSTRUCTION'));
});

test('redacts authorization tokens and local paths with spaces from reports', async () => {
  const root = await workspace();
  await writeFile(path.join(root, 'AGENTS.md'), [
    'API_KEY=secret-value',
    'token=secret-value',
    'secret: secret-value',
    'password=secret-value',
    'authorization=secret-value',
    'Authorization: Bearer sk-live-token',
    'Project path /Users/rebel/My Project/file.txt',
    'Workspace directory /Users/rebel/Downloads/open-agent-fabric 2',
    'Home path /Users/rebel'
  ].join('\n'));

  const report = await scanHarnessContext({ root, harnesses: ['codex'], workspaceId: 'ws_local', clock: fixedClock });

  assert.equal(report.sources[0].redactions.secretCount, 6);
  assert.equal(report.sources[0].redactions.localPathCount, 3);
  const serialized = JSON.stringify(report);
  assert(!serialized.includes('sk-live-token'));
  assert(!serialized.includes('/Users/rebel'));
  assert(!serialized.includes('My Project'));
  assert(!serialized.includes('file.txt'));
  assert(!serialized.includes('open-agent-fabric 2'));
});

test('summary omits ordinary non-secret body text', async () => {
  const root = await workspace();
  await writeFile(path.join(root, 'AGENTS.md'), 'unique plain project convention');

  const report = await scanHarnessContext({ root, harnesses: ['codex'], workspaceId: 'ws_local', clock: fixedClock });

  assert.equal(report.sources[0].summary.includes('codex'), true);
  assert.equal(report.sources[0].summary.includes('instruction'), true);
  assert.equal(report.sources[0].summary.includes('AGENTS.md'), true);
  assert(!JSON.stringify(report).includes('unique plain project convention'));
});

test('does not mislabel lowercase agents.md as AGENTS.md on case-insensitive filesystems', async () => {
  const root = await workspace();
  await writeFile(path.join(root, 'agents.md'), 'lowercase raw convention should not be mislabeled');

  const report = await scanHarnessContext({ root, harnesses: ['codex'], workspaceId: 'ws_local', clock: fixedClock });

  assert.equal(report.summary.totalAccepted, 0);
  assert(!JSON.stringify(report).includes('lowercase raw convention'));
});

test('scans Claude Code and Cursor documented project files', async () => {
  const root = await workspace();
  await mkdir(path.join(root, '.cursor', 'rules'), { recursive: true });
  await writeFile(path.join(root, 'CLAUDE.md'), 'Prefer deterministic tests.');
  await writeFile(path.join(root, '.cursor', 'rules', 'project.mdc'), 'Always run npm run check.');
  await writeFile(path.join(root, '.cursor', 'mcp.json'), '{"mcpServers":{}}');

  const report = await scanHarnessContext({ root, harnesses: ['claude-code', 'cursor'], workspaceId: 'ws_local', clock: fixedClock });

  assert.deepEqual(report.sources.map((source) => `${source.harness}:${source.sourceKind}`).sort(), [
    'claude-code:instruction',
    'cursor:mcp-config',
    'cursor:rule'
  ]);
  for (const source of report.sources) assertJsonSchema(harnessContextSourceSchema, source, 'harness context source');
});

test('explicit user-selected context files are proposal-only and locator-safe', async () => {
  const root = await workspace();
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(path.join(root, 'docs', 'handoff.md'), 'User selected handoff context for source graph work.');

  const report = await scanHarnessContext({
    root,
    harnesses: ['codex'],
    userSelectedFiles: ['docs/handoff.md'],
    workspaceId: 'ws_local',
    clock: fixedClock
  });

  const selected = report.sources.find((source) => source.provenance.locator === 'user-selected://docs/handoff.md');
  assert(selected);
  assert.equal(selected.harness, 'generic-mcp');
  assert.equal(selected.sourceKind, 'handoff');
  assert.equal(selected.reviewStatus, 'proposed');
  assert.equal(selected.retention, 'session');
  assert.equal(selected.dataClass, 'workspace-private');
  assertJsonSchema(harnessContextSourceSchema, selected, 'user selected harness context source');
  assert(!JSON.stringify(report).includes('User selected handoff context'));
});

test('user-selected context rejects path escapes and local state roots', async () => {
  const root = await workspace();
  await assert.rejects(
    () => scanHarnessContext({ root, harnesses: ['codex'], userSelectedFiles: ['../outside.md'], workspaceId: 'ws_local', clock: fixedClock }),
    /user_selected_context_path_invalid/
  );
  await assert.rejects(
    () => scanHarnessContext({ root, harnesses: ['codex'], userSelectedFiles: ['docs/../outside.md'], workspaceId: 'ws_local', clock: fixedClock }),
    /user_selected_context_path_invalid/
  );
  await assert.rejects(
    () => scanHarnessContext({ root, harnesses: ['codex'], userSelectedFiles: ['.local/identity/identity.json'], workspaceId: 'ws_local', clock: fixedClock }),
    /user_selected_context_path_forbidden/
  );
  await assert.rejects(
    () => scanHarnessContext({
      root,
      harnesses: ['codex'],
      userSelectedFiles: Array.from({ length: 17 }, (_, index) => `docs/file-${index}.md`),
      workspaceId: 'ws_local',
      clock: fixedClock
    }),
    /user_selected_context_too_many_files/
  );
});

test('skips oversized AGENTS.md with a sanitized workspace locator', async () => {
  const root = await workspace();
  const body = 'x'.repeat(70_000);
  await writeFile(path.join(root, 'AGENTS.md'), body);

  const report = await scanHarnessContext({ root, harnesses: ['codex'], workspaceId: 'ws_local', maxBytes: 1024, clock: fixedClock });

  assert.equal(report.summary.totalAccepted, 0);
  assert.equal(report.summary.totalSkipped, 1);
  assert.deepEqual(report.skipped, [{ harness: 'codex', locator: 'workspace://AGENTS.md', reason: 'oversized', contentHash: sha256Ref(body), byteSize: 70_000 }]);
});

test('skips symlink AGENTS.md that escapes the workspace without exposing outside body', async () => {
  const root = await workspace();
  const outside = await workspace();
  await writeFile(path.join(outside, 'outside.md'), 'outside file body');
  await symlink(path.join(outside, 'outside.md'), path.join(root, 'AGENTS.md'));

  const report = await scanHarnessContext({ root, harnesses: ['codex'], workspaceId: 'ws_local', clock: fixedClock });

  assert.equal(report.summary.totalAccepted, 0);
  assert.equal(report.summary.totalSkipped, 1);
  assert.equal(report.skipped[0].reason, 'symlink_escape');
  assert.equal(report.skipped[0].locator, 'workspace://AGENTS.md');
  assert(!JSON.stringify(report).includes('outside file body'));
});

test('skips cursor rules directory symlink escape without leaking child names', async () => {
  const root = await workspace();
  const outside = await workspace();
  await mkdir(path.join(root, '.cursor'), { recursive: true });
  await writeFile(path.join(outside, 'PRIVATE_API_KEY_RULE.mdc'), 'token=external-secret');
  await symlink(outside, path.join(root, '.cursor', 'rules'));

  const report = await scanHarnessContext({ root, harnesses: ['cursor'], workspaceId: 'ws_local', clock: fixedClock });

  assert.equal(report.summary.totalAccepted, 0);
  assert.equal(report.summary.totalSkipped, 1);
  assert.deepEqual(report.skipped, [{ harness: 'cursor', locator: 'workspace://.cursor/rules', reason: 'symlink_escape' }]);
  const serialized = JSON.stringify(report);
  assert(!serialized.includes('PRIVATE_API_KEY_RULE'));
  assert(!serialized.includes('external-secret'));
});

test('report-visible hashes are not raw secret body hashes', async () => {
  const root = await workspace();
  const rawBody = 'Use npm run ci. API_KEY=raw-secret-value.';
  await writeFile(path.join(root, 'AGENTS.md'), rawBody);

  const report = await scanHarnessContext({ root, harnesses: ['codex'], workspaceId: 'ws_local', clock: fixedClock });
  const rawHash = sha256Ref(rawBody);

  assert.notEqual(report.sources[0].provenance.contentHash, rawHash);
  assert.notEqual(report.sources[0].bodyHash, rawHash);
  assert(!JSON.stringify(report).includes('raw-secret-value'));
});

test('root fingerprint does not hash the absolute workspace realpath', async () => {
  const root = await workspace();
  await writeFile(path.join(root, 'AGENTS.md'), 'Use npm run ci.');

  const report = await scanHarnessContext({ root, harnesses: ['codex'], workspaceId: 'ws_local', clock: fixedClock });
  const rootPathHash = sha256Ref(await realpath(root));

  assert.notEqual(report.rootFingerprint, rootPathHash);
});

test('rejects unsupported harness names', async () => {
  const root = await workspace();

  await assert.rejects(
    scanHarnessContext({ root, harnesses: ['opencode'], workspaceId: 'ws_local', clock: fixedClock }),
    (error) => error.code === 'unsupported_harness' && error.message.includes('opencode')
  );
});

test('skips control-character files as binary without exposing body', async () => {
  const root = await workspace();
  await writeFile(path.join(root, 'AGENTS.md'), Buffer.from([0x55, 0x73, 0x65, 0x00, 0x20, 0x73, 0x65, 0x63, 0x72, 0x65, 0x74]));

  const report = await scanHarnessContext({ root, harnesses: ['codex'], workspaceId: 'ws_local', clock: fixedClock });

  assert.equal(report.summary.totalAccepted, 0);
  assert.equal(report.summary.totalSkipped, 1);
  assert.deepEqual(report.skipped, [{ harness: 'codex', locator: 'workspace://AGENTS.md', reason: 'binary' }]);
  assert(!JSON.stringify(report).includes('Use'));
  assert(!JSON.stringify(report).includes('secret'));
});

test('scanner output is deterministic for the same input and fixed clock', async () => {
  const root = await workspace();
  await writeFile(path.join(root, 'AGENTS.md'), 'Use npm run ci.');

  const first = await scanHarnessContext({ root, harnesses: ['codex'], workspaceId: 'ws_local', clock: fixedClock });
  const second = await scanHarnessContext({ root, harnesses: ['codex'], workspaceId: 'ws_local', clock: fixedClock });

  assert.deepEqual(first, second);
});
