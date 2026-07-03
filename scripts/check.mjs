import { readdir, readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const errors = [];
const ignoredDirectories = new Set(['.git', 'node_modules', '.local', '.playwright-cli', '.scratch', 'coverage', 'context-packs', 'graphify-out']);
const required = [
  'README.md',
  'ASSIGN_TO_AGENT.md',
  'AGENTS.md',
  'PROJECT_STATUS.json',
  'PRODUCT.md',
  'BRAND.md',
  'DESIGN.md',
  'ROADMAP.md',
  'TASKS.md',
  'SECURITY.md',
  'LICENSE',
  'NOTICE',
  'planning/backlog.json',
  'docs/START_HERE.md',
  'docs/implementation/BUILD_ORDER.md',
  'docs/implementation/AGENT_EXECUTION_PLAYBOOK.md',
  'docs/security/threat-model.md',
  'docs/adr/0012-build-the-whole-tool-own-the-boundaries.md',
  'docs/architecture/native-providers.md',
  'docs/architecture/agent-packs.md',
  'docs/architecture/flight-recorder.md',
  'packages/protocol/schemas/event.schema.json',
  'packages/protocol/schemas/agent-pack.schema.json',
  'packages/protocol/schemas/provider-manifest.schema.json',
  'providers/native/catalog.json',
  'examples/agentpacks/content-intelligence.agentpack.json',
  'workflows/content-intelligence/workflow.json'
];

for (const relative of required) {
  try {
    const info = await stat(path.join(root, relative));
    if (!info.isFile() || info.size === 0) errors.push(`${relative}: missing or empty`);
  } catch {
    errors.push(`${relative}: missing`);
  }
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else files.push(full);
  }
  return files;
}

async function emptyDirectories(directory) {
  const entries = (await readdir(directory, { withFileTypes: true })).filter((entry) => !ignoredDirectories.has(entry.name));
  if (!entries.length) return [directory];
  const result = [];
  for (const entry of entries) if (entry.isDirectory()) result.push(...await emptyDirectories(path.join(directory, entry.name)));
  return result;
}

const files = await walk(root);
for (const directory of await emptyDirectories(root)) errors.push(`${path.relative(root, directory)}: empty directory`);

const jsonValues = new Map();
for (const file of files.filter((candidate) => candidate.endsWith('.json'))) {
  try {
    jsonValues.set(file, JSON.parse(await readFile(file, 'utf8')));
  } catch (error) {
    errors.push(`${path.relative(root, file)}: invalid JSON (${error.message})`);
  }
}

const ids = new Map();
for (const [file, value] of jsonValues) {
  const relative = path.relative(root, file).split(path.sep).join('/');
  const isIdentityManifest = /(?:manifest|adapter|provider)\.json$/.test(file);
  if (isIdentityManifest) {
    for (const key of ['schemaVersion', 'id']) if (!value[key]) errors.push(`${relative}: missing ${key}`);
    if (value.id) {
      if (ids.has(value.id)) errors.push(`${relative}: duplicate id ${value.id} also used by ${ids.get(value.id)}`);
      else ids.set(value.id, relative);
    }
  }

  if (relative.startsWith('agents/')) {
    for (const key of ['name', 'role', 'allowedTools', 'allowedSkills', 'defaultContextPolicy']) if (value[key] === undefined) errors.push(`${relative}: missing ${key}`);
  }

  if (relative.startsWith('skills/') && relative.endsWith('/manifest.json')) {
    for (const key of ['name', 'version', 'triggers', 'tools', 'sideEffectClass', 'inputSchema', 'outputSchema']) if (value[key] === undefined) errors.push(`${relative}: missing ${key}`);
  }

  if (relative.startsWith('tools/manifests/')) {
    if (value.schemaVersion === '1.1.0') {
      for (const key of ['name', 'version', 'contractVersion', 'handlerBindingId', 'operations']) if (value[key] === undefined) errors.push(`${relative}: missing ${key}`);
    } else {
      for (const key of ['name', 'version', 'riskClass', 'permissions', 'allowedRoles', 'inputSchema', 'outputSchema']) if (value[key] === undefined) errors.push(`${relative}: missing ${key}`);
      if (!['read-only', 'reversible-write', 'consequential-write'].includes(value.riskClass)) errors.push(`${relative}: invalid riskClass`);
    }
  }

  if (relative.startsWith('adapters/') && relative.endsWith('/adapter.json')) {
    for (const key of ['protocolVersion', 'category', 'status', 'enabledByDefault', 'upstream', 'licenseReview', 'trustBoundary', 'contract', 'capabilities', 'installation', 'conformance']) {
      if (value[key] === undefined) errors.push(`${relative}: missing ${key}`);
    }
    if (value.enabledByDefault) errors.push(`${relative}: external adapter must be disabled by default`);
    if (value.upstream?.commit === 'UNPINNED' && value.status === 'supported') errors.push(`${relative}: supported adapter cannot be unpinned`);
    const fixtureRelative = path.posix.join(path.posix.dirname(relative), value.conformance?.fixture ?? '');
    const fixture = jsonValues.get(path.join(root, ...fixtureRelative.split('/')));
    if (!fixture) errors.push(`${relative}: conformance fixture missing at ${fixtureRelative}`);
    else {
      if (fixture.adapterId !== value.id) errors.push(`${fixtureRelative}: adapterId does not match ${value.id}`);
      if (fixture.contract !== value.contract) errors.push(`${fixtureRelative}: contract does not match ${value.contract}`);
      if (!Array.isArray(fixture.cases) || fixture.cases.length < 4) errors.push(`${fixtureRelative}: at least four cases required`);
    }
  }

  if (relative.startsWith('providers/native/') && relative.endsWith('/provider.json')) {
    for (const key of ['name', 'version', 'category', 'enabledByDefault', 'locality', 'contract', 'capabilities', 'limits', 'dataPaths']) {
      if (value[key] === undefined) errors.push(`${relative}: missing ${key}`);
    }
    if (!String(value.id ?? '').startsWith('provider:native:')) errors.push(`${relative}: native provider ID must start provider:native:`);
    if (!['in-process', 'loopback-process'].includes(value.locality)) errors.push(`${relative}: invalid locality`);
    if (!Array.isArray(value.capabilities) || !value.capabilities.length) errors.push(`${relative}: capabilities must not be empty`);
  }
}

const workflow = jsonValues.get(path.join(root, 'workflows/content-intelligence/workflow.json'));
if (workflow) {
  const stepIds = workflow.steps?.map((step) => step.id) ?? [];
  if (!stepIds.length) errors.push('workflow: no steps');
  if (new Set(stepIds).size !== stepIds.length) errors.push('workflow: duplicate step ID');
  for (const step of workflow.steps ?? []) {
    for (const key of ['id', 'kind', 'inputSchema', 'outputSchema', 'contextPolicy', 'tools', 'riskClass', 'retry', 'timeoutMs', 'approval', 'idempotency']) {
      if (step[key] === undefined) errors.push(`workflow step ${step.id ?? '<unknown>'}: missing ${key}`);
    }
  }
}

const backlog = jsonValues.get(path.join(root, 'planning/backlog.json'));
const projectStatus = jsonValues.get(path.join(root, 'PROJECT_STATUS.json'));
if (backlog) {
  const taskIds = backlog.tasks?.map((task) => task.id) ?? [];
  const taskSet = new Set(taskIds);
  if (taskIds.length !== 30) errors.push(`planning/backlog.json: expected 30 tasks, found ${taskIds.length}`);
  if (taskSet.size !== taskIds.length) errors.push('planning/backlog.json: duplicate task ID');
  for (const task of backlog.tasks ?? []) {
    for (const key of ['id', 'title', 'milestone', 'status', 'ownerAgent', 'dependsOn', 'objective', 'deliverables', 'acceptanceCommands', 'stopCondition', 'requiredReading']) {
      if (task[key] === undefined) errors.push(`task ${task.id ?? '<unknown>'}: missing ${key}`);
    }
    for (const dependency of task.dependsOn ?? []) if (!taskSet.has(dependency)) errors.push(`task ${task.id}: unknown dependency ${dependency}`);
    for (const requiredReading of task.requiredReading ?? []) {
      const absolute = path.join(root, requiredReading);
      if (!files.includes(absolute) && !files.some((candidate) => candidate.startsWith(`${absolute}${path.sep}`))) errors.push(`task ${task.id}: required reading missing ${requiredReading}`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const byId = new Map((backlog.tasks ?? []).map((task) => [task.id, task]));
  function visit(id) {
    if (visiting.has(id)) { errors.push(`backlog: dependency cycle at ${id}`); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of taskIds) visit(id);
  if (projectStatus?.nextTask !== null && projectStatus?.nextTask !== undefined) {
    const nextTask = byId.get(projectStatus.nextTask);
    if (!nextTask) errors.push(`PROJECT_STATUS.json: unknown nextTask ${projectStatus.nextTask}`);
    else if (nextTask.status !== 'planned') errors.push(`PROJECT_STATUS.json: nextTask ${projectStatus.nextTask} is ${nextTask.status}`);
    else {
      const completed = new Set((backlog.tasks ?? []).filter((task) => task.status === 'completed').map((task) => task.id));
      for (const dependency of nextTask.dependsOn ?? []) {
        if (!completed.has(dependency)) errors.push(`PROJECT_STATUS.json: nextTask ${projectStatus.nextTask} dependency ${dependency} is not completed`);
      }
    }
  }
}

const agentPack = jsonValues.get(path.join(root, 'examples/agentpacks/content-intelligence.agentpack.json'));
if (agentPack) {
  if (agentPack.apiVersion !== 'openagentfabric.dev/v1' || agentPack.kind !== 'AgentPack') errors.push('example Agent Pack: unsupported apiVersion or kind');
  if (agentPack.context?.recordManifest !== true) errors.push('example Agent Pack: recordManifest must be true');
  if (agentPack.permissions?.consequentialWrites !== false) errors.push('example Agent Pack: consequential writes must be disabled');
}

const webSyntax = spawnSync(process.execPath, ['--check', path.join(root, 'apps/web/app.js')], { encoding: 'utf8' });
if (webSyntax.status !== 0) errors.push(`apps/web/app.js: JavaScript syntax error (${webSyntax.stderr || webSyntax.stdout})`.trim());

const forbidden = [
  /sk-[A-Za-z0-9_-]{20,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/
];
for (const file of files.filter((candidate) => !/\.(?:png|jpg|jpeg|gif|webp|zip)$/.test(candidate))) {
  const text = await readFile(file, 'utf8').catch(() => '');
  for (const pattern of forbidden) if (pattern.test(text)) errors.push(`${path.relative(root, file)}: possible secret pattern`);
}

const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (packageJson.dependencies && Object.keys(packageJson.dependencies).length) errors.push('package.json: bootstrap must remain dependency-free unless an ADR approves dependencies');

if (errors.length) {
  console.error(`Repository checks failed:\n${errors.map((error) => `- ${error}`).join('\n')}`);
  process.exitCode = 1;
} else {
  const providerCount = [...jsonValues.keys()].filter((file) => file.endsWith(`${path.sep}provider.json`)).length;
  const adapterCount = [...jsonValues.keys()].filter((file) => file.endsWith(`${path.sep}adapter.json`)).length;
  console.log(`Repository checks passed (${files.length} files inspected; ${ids.size} unique manifest IDs; ${providerCount} native providers; ${adapterCount} external adapter contracts; ${backlog?.tasks?.length ?? 0} planned tasks).`);
}
