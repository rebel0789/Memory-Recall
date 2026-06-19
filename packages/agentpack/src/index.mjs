import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const SECRET_KEYS = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|cookie|authorization)/i;

function fail(path, message) {
  const error = new Error(`${path}: ${message}`);
  error.code = 'invalid_agent_pack';
  throw error;
}

function plain(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object');
  return value;
}

function string(value, path) {
  if (typeof value !== 'string' || !value.trim()) fail(path, 'must be a non-empty string');
  return value;
}

function uniqueStrings(value, path) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) fail(path, 'must be an array of non-empty strings');
  if (new Set(value).size !== value.length) fail(path, 'must not contain duplicates');
  return value;
}

function validateReference(reference, path) {
  plain(reference, path);
  string(reference.id, `${path}.id`);
  string(reference.version, `${path}.version`);
  if (reference.required !== undefined && typeof reference.required !== 'boolean') fail(`${path}.required`, 'must be boolean');
}

function rejectSecretFields(value, path = '$') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSecretFields(item, `${path}[${index}]`));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEYS.test(key)) fail(`${path}.${key}`, 'credentials and secret-shaped fields are forbidden in Agent Packs');
    rejectSecretFields(item, `${path}.${key}`);
  }
}

export function validateAgentPack(input) {
  const pack = structuredClone(plain(input, '$'));
  rejectSecretFields(pack);
  if (pack.apiVersion !== 'openagentfabric.dev/v1') fail('$.apiVersion', 'must equal openagentfabric.dev/v1');
  if (pack.kind !== 'AgentPack') fail('$.kind', 'must equal AgentPack');

  const metadata = plain(pack.metadata, '$.metadata');
  if (!NAME_PATTERN.test(string(metadata.name, '$.metadata.name'))) fail('$.metadata.name', 'must be a DNS-style lowercase name');
  if (!SEMVER_PATTERN.test(string(metadata.version, '$.metadata.version'))) fail('$.metadata.version', 'must be semantic version syntax');
  string(metadata.description, '$.metadata.description');
  string(metadata.license, '$.metadata.license');

  const runtime = plain(pack.runtime, '$.runtime');
  string(runtime.runner, '$.runtime.runner');
  if (typeof runtime.localOnly !== 'boolean') fail('$.runtime.localOnly', 'must be boolean');

  const models = plain(pack.models, '$.models');
  if (!Object.keys(models).length) fail('$.models', 'must declare at least one model role');
  for (const [role, config] of Object.entries(models)) {
    plain(config, `$.models.${role}`);
    plain(config.capabilities, `$.models.${role}.capabilities`);
    if (config.fallbackAllowed !== undefined && typeof config.fallbackAllowed !== 'boolean') fail(`$.models.${role}.fallbackAllowed`, 'must be boolean');
  }

  const context = plain(pack.context, '$.context');
  string(context.policy, '$.context.policy');
  if (!Number.isInteger(context.defaultTokenBudget) || context.defaultTokenBudget < 256) fail('$.context.defaultTokenBudget', 'must be an integer of at least 256');
  if (context.recordManifest !== true) fail('$.context.recordManifest', 'must be true');

  const memory = plain(pack.memory, '$.memory');
  string(memory.provider, '$.memory.provider');
  if (!['disabled', 'propose', 'user-confirmed'].includes(memory.writePolicy)) fail('$.memory.writePolicy', 'unsupported write policy');

  uniqueStrings(pack.capabilities, '$.capabilities');
  for (const collection of ['skills', 'workflows', 'evaluations']) {
    if (!Array.isArray(pack[collection])) fail(`$.${collection}`, 'must be an array');
    pack[collection].forEach((reference, index) => validateReference(reference, `$.${collection}[${index}]`));
    const keys = pack[collection].map((reference) => `${reference.id}@${reference.version}`);
    if (new Set(keys).size !== keys.length) fail(`$.${collection}`, 'must not contain duplicate references');
  }
  if (!pack.workflows.length) fail('$.workflows', 'must contain at least one workflow');

  const permissions = plain(pack.permissions, '$.permissions');
  uniqueStrings(permissions.dataClasses, '$.permissions.dataClasses');
  uniqueStrings(permissions.network, '$.permissions.network');
  uniqueStrings(permissions.filesystem, '$.permissions.filesystem');
  if (typeof permissions.consequentialWrites !== 'boolean') fail('$.permissions.consequentialWrites', 'must be boolean');

  return pack;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

export function canonicalAgentPackJson(input) {
  return JSON.stringify(canonical(validateAgentPack(input)));
}

export function fingerprintAgentPack(input) {
  return `sha256:${createHash('sha256').update(canonicalAgentPackJson(input)).digest('hex')}`;
}

export async function loadAgentPack(filename) {
  let value;
  try { value = JSON.parse(await readFile(filename, 'utf8')); } catch (error) {
    const wrapped = new Error(`Unable to load Agent Pack ${filename}: ${error.message}`);
    wrapped.code = 'agent_pack_load_failed';
    throw wrapped;
  }
  return validateAgentPack(value);
}

export async function writeAgentPack(filename, input) {
  const pack = validateAgentPack(input);
  await writeFile(filename, `${JSON.stringify(pack, null, 2)}\n`, { mode: 0o600 });
  return { filename, fingerprint: fingerprintAgentPack(pack) };
}

export function resolveAgentPack(input, registry = {}) {
  const pack = validateAgentPack(input);
  const availableCapabilities = new Set(registry.capabilities ?? []);
  const availableSkills = new Set(registry.skills ?? []);
  const availableWorkflows = new Set(registry.workflows ?? []);
  const availableEvaluations = new Set(registry.evaluations ?? []);
  const missing = {
    capabilities: pack.capabilities.filter((id) => !availableCapabilities.has(id)),
    skills: pack.skills.filter((reference) => reference.required !== false && !availableSkills.has(`${reference.id}@${reference.version}`)),
    workflows: pack.workflows.filter((reference) => reference.required !== false && !availableWorkflows.has(`${reference.id}@${reference.version}`)),
    evaluations: pack.evaluations.filter((reference) => reference.required !== false && !availableEvaluations.has(`${reference.id}@${reference.version}`))
  };
  const ready = Object.values(missing).every((items) => items.length === 0);
  return {
    schemaVersion: '1.0.0',
    name: pack.metadata.name,
    version: pack.metadata.version,
    fingerprint: fingerprintAgentPack(pack),
    ready,
    missing,
    authorityGranted: false,
    note: 'Resolution proves references only. Runtime policy must grant requested capabilities.'
  };
}
