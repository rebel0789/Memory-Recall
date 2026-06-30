import { readFile } from 'node:fs/promises';

const status = JSON.parse(await readFile('PROJECT_STATUS.json', 'utf8'));
const backlog = JSON.parse(await readFile('planning/backlog.json', 'utf8'));

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

console.log(`${status.project} ${status.release} — ${status.phase}`);
console.log(`Next task: ${nextTaskLabel(status.nextTask, backlog.tasks ?? [])}`);
console.log(`Defaults: network=${status.defaults.network}, externalWrites=${status.defaults.externalWrites}, model=${status.defaults.modelMode}, residency=${status.defaults.dataResidency}`);
const groups = Map.groupBy(status.capabilities, (item) => item.status);
for (const state of ['implemented', 'reference', 'experimental', 'specified', 'disabled', 'unsupported']) {
  const items = groups.get(state) ?? [];
  if (!items.length) continue;
  console.log(`\n${state.toUpperCase()} (${items.length})`);
  for (const item of items) console.log(`- ${item.id}: ${item.name}`);
}
