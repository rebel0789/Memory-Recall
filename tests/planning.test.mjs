import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const backlog = JSON.parse(await readFile('planning/backlog.json', 'utf8'));
const status = JSON.parse(await readFile('PROJECT_STATUS.json', 'utf8'));

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
  assert.match(result.stdout, /Use OAF today: docs\/usage\/local-agent-handoff\.md/);
  assert.match(result.stdout, /First safe handoff: npm run oaf -- context handoff --read-only --from codex --root \. --objective "Ship safely" --step "handoff" --target codex --changed-from-git --format summary/);
  assert.match(result.stdout, /Skill menu: npm run oaf -- skill catalog --read-only --root \. --format summary/);
  assert.match(result.stdout, /Issue\/PR queue instructions: docs\/agents\/issue-tracker\.md/);
  assert.equal(result.stdout.includes('Next task: OAF-030'), false);
});

test('bootstrap output only points to task command conditionally', () => {
  const result = spawnSync(process.execPath, ['scripts/bootstrap.mjs'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /npm run task -- <OAF-ID> \(only when status names a next task\)/);
  assert.doesNotMatch(result.stdout, /^  npm run task -- <OAF-ID>$/m);
  assert.match(result.stdout, /npm run oaf -- skill catalog --read-only --root \. --format summary/);
  assert.match(result.stdout, /docs\/usage\/local-agent-handoff\.md/);
});
