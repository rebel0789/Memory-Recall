import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isIgnoredPath, parseIgnoreFile } from '../providers/native/context-candidate-ast-code/src/ignore-rules.mjs';
import { scanAstCodeWorkspace } from '../providers/native/context-candidate-ast-code/src/index.mjs';

test('ignore rules preserve scope, negation, anchoring, and directory semantics', () => {
  const rules = [
    ...parseIgnoreFile('/generated/\n*.tmp\n!important.tmp\ncache/\n', { base: 'src' }),
    ...parseIgnoreFile('nested.ts\n', { base: 'src/features' })
  ];
  assert.equal(isIgnoredPath('src/generated', { isDirectory: true, rules }), true);
  assert.equal(isIgnoredPath('src/generated/file.ts', { rules }), true);
  assert.equal(isIgnoredPath('src/other/generated', { isDirectory: true, rules }), false);
  assert.equal(isIgnoredPath('src/notes.tmp', { rules }), true);
  assert.equal(isIgnoredPath('src/important.tmp', { rules }), false);
  assert.equal(isIgnoredPath('src/cache', { isDirectory: true, rules }), true);
  assert.equal(isIgnoredPath('src/features/nested.ts', { rules }), true);
  assert.equal(isIgnoredPath('src/other/nested.ts', { rules }), false);
  assert.equal(isIgnoredPath('src/ignored.ts', { rules: parseIgnoreFile('src/ignored.ts\n'), explicitIncludes: ['src/ignored.ts'] }), false);
});

test('discovery honors nested gitignore and recallignore before maxFiles', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recall-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src', 'generated'), { recursive: true });
  await mkdir(path.join(root, '.worktrees', 'old', 'src'), { recursive: true });
  await mkdir(path.join(root, '.venv', 'lib'), { recursive: true });
  await writeFile(path.join(root, '.gitignore'), 'src/generated/\n');
  await writeFile(path.join(root, '.recallignore'), 'src/ignored.ts\n');
  await writeFile(path.join(root, 'src', '.gitignore'), 'nested.ts\n');
  await writeFile(path.join(root, 'src', 'entry.ts'), 'export function entry(){ return 1; }\n');
  await writeFile(path.join(root, 'src', 'nested.ts'), 'export const nested = 1;\n');
  await writeFile(path.join(root, 'src', 'ignored.ts'), 'export const ignored = 1;\n');
  await writeFile(path.join(root, 'src', 'generated', 'output.ts'), 'export const generated = 1;\n');
  await writeFile(path.join(root, '.worktrees', 'old', 'src', 'copy.ts'), 'export const copy = 1;\n');
  await writeFile(path.join(root, '.venv', 'lib', 'tool.js'), 'export const tool = 1;\n');

  const scan = await scanAstCodeWorkspace({ root, maxFiles: 1 });

  assert.equal(scan.fileCount, 1);
  assert.deepEqual(scan.coverage.representedJsTsLocators, ['workspace://src/entry.ts']);
  assert.equal(scan.coverage.maxFilesReached, false);
  assert.equal(scan.coverage.ignoredFileCount, 2);
  assert.equal(scan.coverage.ignoredDirectoryCount, 1);
  assert(scan.coverage.excludedDirectoryCount >= 2);
  assert.deepEqual(scan.coverage.ignoredSamples, [
    'workspace://src/generated',
    'workspace://src/ignored.ts',
    'workspace://src/nested.ts'
  ]);
});

test('explicit include overrides non-security ignore but not root containment', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recall-include-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, '.recallignore'), 'src/kept.ts\n');
  await writeFile(path.join(root, 'src', 'kept.ts'), 'export const kept = true;\n');
  const scan = await scanAstCodeWorkspace({ root, explicitIncludes: ['src/kept.ts'] });
  assert.deepEqual(scan.coverage.representedJsTsLocators, ['workspace://src/kept.ts']);
  await assert.rejects(
    scanAstCodeWorkspace({ root, explicitIncludes: ['../outside.ts'] }),
    /source_graph_explicit_include_invalid/
  );
});

test('explicit include cannot enter Git metadata or nested worktrees', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recall-security-exclude-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.git', 'hooks'), { recursive: true });
  await mkdir(path.join(root, '.worktrees', 'other'), { recursive: true });
  await writeFile(path.join(root, '.git', 'hooks', 'unsafe.js'), 'export const unsafe = true;\n');
  await writeFile(path.join(root, '.worktrees', 'other', 'copy.js'), 'export const copy = true;\n');

  const scan = await scanAstCodeWorkspace({
    root,
    explicitIncludes: ['.git/hooks/unsafe.js', '.worktrees/other/copy.js']
  });

  assert.deepEqual(scan.coverage.representedJsTsLocators, []);
  assert.deepEqual(scan.coverage.excludedDirectoryLocators, ['workspace://.git', 'workspace://.worktrees']);
});
