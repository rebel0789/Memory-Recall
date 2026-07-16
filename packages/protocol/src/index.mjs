import { randomUUID } from 'node:crypto';

export const EVENT_TYPES = Object.freeze([
  'run.created','run.started','run.completed','run.failed','run.cancelled',
  'run.suspended','run.resumed',
  'step.started','step.completed','step.failed','step.cancelled','step.retry_scheduled',
  'timer.scheduled','timer.fired',
  'context.compiled','context.manifest.persisted','context.failed',
  'memory.proposed','memory.verified','memory.activated','memory.rejected','memory.superseded','memory.retracted','memory.expired',
  'tool.requested','tool.authorized','tool.denied','tool.completed','tool.failed',
  'model.requested','model.completed','model.failed',
  'approval.requested','approval.resolved','approval.expired',
  'artifact.created','evaluation.completed','policy.evaluated','adapter.health_changed',
  'replay.created','replay.completed','replay.failed',
  'learning.proposed','learning.evaluating','learning.approved','learning.rejected','learning.rolled_back',
  'agentpack.activated','agentpack.rejected'
]);

export function prefixedId(prefix) {
  if (!/^[a-z][a-z0-9]*$/.test(prefix)) throw new TypeError('prefix must be lowercase alphanumeric');
  return `${prefix}_${Date.now().toString(36)}_${randomUUID().slice(0,8)}`;
}
export function nowIso() { return new Date().toISOString(); }
export function assertPlainObject(value, name='value') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}
export function createEvent({ type, workspaceId='ws_local', runId, actorId='system', payload={}, sequence=0, correlationId, causationId=null, dataClass='workspace-private', producerVersion='0.2.0-dev' }) {
  if (!EVENT_TYPES.includes(type)) throw new Error(`Unsupported event type: ${type}`);
  if (!workspaceId) throw new Error('workspaceId is required');
  if (!runId) throw new Error('runId is required');
  if (!Number.isInteger(sequence) || sequence < 0) throw new Error('sequence must be a non-negative integer');
  assertPlainObject(payload,'payload');
  const id=prefixedId('evt');
  return { schemaVersion:'1.0.0', id, workspaceId, type, runId, actorId, sequence, occurredAt:nowIso(), correlationId:correlationId??runId, causationId, dataClass, producerVersion, payload };
}

export { validateJsonSchema, assertJsonSchema } from './schema-validator.mjs';
export { canonicalStringify, stableStringify, sha256Hex } from './fingerprint.mjs';
export {
  isSafeSourceGraphDisplayLabel,
  normalizeSourceGraphWorkspaceLocator,
  SOURCE_GRAPH_SAFE_LABEL_PATTERN,
  SOURCE_GRAPH_SAFE_LABEL_RE,
  SOURCE_GRAPH_SAFE_LABEL_TOKEN_PATTERN,
  SOURCE_GRAPH_WORKSPACE_LOCATOR_PATTERN,
  SOURCE_GRAPH_WORKSPACE_LOCATOR_RE
} from './source-graph-locator.mjs';
export {
  CODE_INTELLIGENCE_CAPABILITIES,
  CODE_INTELLIGENCE_TIER_1_LANGUAGES,
  CODE_INTELLIGENCE_TIER_2_LANGUAGES,
  auditCodeIntelligenceCapabilityMatrix
} from './code-intelligence-contract.mjs';
