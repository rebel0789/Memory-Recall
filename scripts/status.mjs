import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const packageRoot = process.env.OAF_PACKAGE_ROOT ?? process.cwd();
const invokedCwd = process.env.OAF_INVOKED_CWD ?? process.cwd();
const status = JSON.parse(await readFile(path.join(packageRoot, 'PROJECT_STATUS.json'), 'utf8'));
const pkg = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
const backlog = JSON.parse(await readFile(path.join(packageRoot, 'planning/backlog.json'), 'utf8'));

function readyTasks(tasks) {
  const completed = new Set(tasks.filter((task) => task.status === 'completed').map((task) => task.id));
  return tasks.filter((task) => task.status === 'planned' && task.dependsOn.every((dependency) => completed.has(dependency)));
}

function nextTaskLabel(statusNextTask, tasks) {
  const ready = readyTasks(tasks);
  if (statusNextTask && ready.some((task) => task.id === statusNextTask)) return statusNextTask;
  if (ready.length) return `${ready[0].id} (derived from backlog)`;
  return 'none (checked-in backlog complete)';
}

const nextTask = nextTaskLabel(status.nextTask, backlog.tasks ?? []);
const sourceCheckout = existsSync(path.join(invokedCwd, 'package.json')) && existsSync(path.join(invokedCwd, 'apps/cli/oaf.mjs'));
const recall = (args) => sourceCheckout ? `npm run recall -- ${args}` : `recall ${args}`;

console.log(`Memory Recall ${pkg.version} — ${status.phase}`);
console.log(`Next task: ${nextTask}`);
console.log(`Defaults: network=${status.defaults.network}, externalWrites=${status.defaults.externalWrites}, model=${status.defaults.modelMode}, residency=${status.defaults.dataResidency}`);
if (nextTask.startsWith('none ')) {
  console.log(sourceCheckout ? 'Use Memory Recall today: docs/usage/local-agent-handoff.md' : 'Use Memory Recall today: build a read-only context handoff in this repository.');
  console.log(`First safe handoff: ${recall('handoff')}`);
  console.log(`Measure token saver: ${recall('token-saver')}`);
  console.log(`Expanded handoff: ${recall('context handoff --read-only --from codex --root . --objective "Ship safely" --step handoff --target codex --changed-from-git --format summary')}`);
  console.log(sourceCheckout ? `Skill menu: ${recall('skill catalog --read-only --root . --format summary')}` : 'Skill menu: available when this repository has a skills/ directory.');
  console.log(sourceCheckout ? 'Issue/PR queue instructions: docs/agents/issue-tracker.md' : 'Issue/PR queue instructions: run from the Memory Recall source checkout docs when maintaining Memory Recall itself.');
}
const groups = Map.groupBy(status.capabilities, (item) => item.status);
for (const state of ['implemented', 'reference', 'experimental', 'specified', 'disabled', 'unsupported']) {
  const items = groups.get(state) ?? [];
  if (!items.length) continue;
  console.log(`\n${state.toUpperCase()} (${items.length})`);
  for (const item of items) console.log(`- ${item.id}: ${item.name}`);
}
