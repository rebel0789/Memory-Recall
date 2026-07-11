import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backlog = JSON.parse(await readFile('planning/backlog.json', 'utf8'));
const status = JSON.parse(await readFile('PROJECT_STATUS.json', 'utf8'));
const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'apps/cli/oaf.mjs');

function readyTasks() {
  const completed = new Set(backlog.tasks.filter((task) => task.status === 'completed').map((task) => task.id));
  return backlog.tasks.filter((task) => task.status === 'planned' && task.dependsOn.every((dependency) => completed.has(dependency)));
}

test('backlog has unique ordered task identifiers', () => {
  const ids = backlog.tasks.map((task) => task.id);
  assert.equal(ids.length, 30);
  assert.equal(new Set(ids).size, 30);
  assert.deepEqual(ids, Array.from({ length: 30 }, (_, index) => `OAF-${String(index + 1).padStart(3, '0')}`));
});

test('dependencies exist and precede dependents', () => {
  const index = new Map(backlog.tasks.map((task, taskIndex) => [task.id, taskIndex]));
  for (const task of backlog.tasks) {
    for (const dependency of task.dependsOn) {
      assert(index.has(dependency));
      assert(index.get(dependency) < index.get(task.id));
    }
  }
});

test('project status next task is ready or explicitly absent when backlog is complete', () => {
  const ready = readyTasks();
  assert.equal(status.defaults.externalWrites, false);
  if (status.nextTask === null) {
    assert.deepEqual(ready, []);
    return;
  }
  const nextTask = backlog.tasks.find((task) => task.id === status.nextTask);
  assert(nextTask);
  assert.equal(nextTask.status, 'planned');
  assert(ready.some((task) => task.id === status.nextTask));
});

test('status command does not advertise completed backlog work as next', () => {
  const result = spawnSync(process.execPath, ['scripts/status.mjs'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Next task: none \(checked-in backlog complete\)/);
  assert.match(result.stdout, /Use Memory Recall today: docs\/usage\/local-agent-handoff\.md/);
  assert.match(result.stdout, /First safe handoff: npm run recall -- handoff/);
  assert.match(result.stdout, /Measure token saver: npm run recall -- token-saver/);
  assert.match(result.stdout, /Expanded handoff: npm run recall -- context handoff --read-only --from codex --root \. --objective "Ship safely" --step handoff --target codex --changed-from-git --format summary/);
  assert.match(result.stdout, /Skill menu: npm run recall -- skill catalog --read-only --root \. --format summary/);
  assert.match(result.stdout, /Issue\/PR queue instructions: docs\/agents\/issue-tracker\.md/);
  assert.equal(result.stdout.includes('Next task: OAF-030'), false);
});

test('packaged status prints installed recall commands outside the source checkout', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaf-status-installed-'));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'consumer-project' }));
  const result = spawnSync(process.execPath, [cliPath, 'status'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /First safe handoff: recall handoff/);
  assert.match(result.stdout, /Measure token saver: recall token-saver/);
  assert.match(result.stdout, /Expanded handoff: recall context handoff --read-only/);
  assert.match(result.stdout, /Skill menu: available when this repository has a skills\/ directory\./);
  assert.doesNotMatch(result.stdout, /npm run handoff:safe/);
  assert.doesNotMatch(result.stdout, /npm run oaf --/);
  assert.doesNotMatch(result.stdout, /Skill menu: recall skill catalog/);
});

test('first safe handoff has a package script', () => {
  assert.equal(
    packageJson.scripts['handoff:safe'],
    'npm --silent run recall -- handoff'
  );
  assert.equal(packageJson.scripts['token-saver'], 'npm --silent run recall -- token-saver');
});

test('bootstrap output only points to task command conditionally', () => {
  const result = spawnSync(process.execPath, ['scripts/bootstrap.mjs'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Memory Recall ${packageJson.version.replaceAll('.', '\\.')} source bootstrap is ready\\.`));
  assert.doesNotMatch(result.stdout, /^  npm run task -- <OAF-ID>$/m);
  assert.match(result.stdout, /npm run recall -- skill catalog --read-only --root \. --format summary/);
  assert.match(result.stdout, /docs\/usage\/local-agent-handoff\.md/);
});
