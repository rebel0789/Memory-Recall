import { createHash, randomUUID } from 'node:crypto';
import { assertPlainObject } from '../../protocol/src/index.mjs';

export const POLICY_VERSION = '1.0.0';
export const POLICY_SCHEMA_VERSION = '1.0.0';

export const AUTHZ_ACTIONS = Object.freeze([
  'system.status.read',
  'workspace.read',
  'workspace.manage',
  'dashboard.read',
  'run.read',
  'run.execute',
  'context.compile',
  'stream.read',
  'workspace.reset',
  'token.manage',
  'audit.read'
]);

export const POLICY_REASON_CODES = Object.freeze([
  'missing_identity',
  'missing_workspace',
  'unknown_action',
  'unsupported_role',
  'membership_required',
  'workspace_mismatch',
  'resource_denied',
  'tool_not_registered',
  'operation_not_declared',
  'capability_exceeds_manifest',
  'filesystem_read_denied',
  'filesystem_write_denied',
  'network_denied',
  'secret_scope_denied',
  'data_class_denied',
  'sandbox_denied',
  'budget_exceeded',
  'approval_required',
  'approval_invalid',
  'approval_expired',
  'approval_scope_mismatch',
  'idempotency_required',
  'external_writes_disabled',
  'policy_configuration_invalid'
]);

export const POLICY_RESOURCE_TYPES = Object.freeze([
  'system',
  'workspace',
  'run',
  'workflow',
  'context',
  'artifact',
  'source-snapshot',
  'memory',
  'tool',
  'token',
  'audit'
]);

export const POLICY_DATA_CLASSES = Object.freeze(['public', 'workspace-private', 'confidential', 'secret']);
export const POLICY_SIDE_EFFECT_CLASSES = Object.freeze(['read-only', 'reversible-write', 'consequential-write']);

const ROLE_ACTIONS_OBJECT = Object.freeze({
  owner: Object.freeze([...AUTHZ_ACTIONS, 'tool.invoke']),
  builder: Object.freeze(['workspace.read', 'dashboard.read', 'run.read', 'run.execute', 'context.compile', 'stream.read', 'tool.invoke']),
  operator: Object.freeze(['workspace.read', 'dashboard.read', 'run.read', 'run.execute', 'stream.read', 'tool.invoke']),
  auditor: Object.freeze(['workspace.read', 'dashboard.read', 'run.read', 'stream.read', 'audit.read', 'tool.invoke'])
});

const ROLE_ACTIONS = Object.freeze(Object.fromEntries(
  Object.entries(ROLE_ACTIONS_OBJECT).map(([role, actions]) => [role, new Set(actions)])
));

const DEFAULT_LIMITS = Object.freeze({
  runtimeMs: 30_000,
  memoryBytes: 256 * 1024 * 1024,
  outputBytes: 1_000_000,
  inputBytes: 1_000_000,
  invocationCount: 1,
  costUnits: 0,
  retryCount: 0
});

const DEFAULT_REGISTRY = Object.freeze({
  schemaVersion: POLICY_SCHEMA_VERSION,
  version: POLICY_VERSION,
  knownActions: Object.freeze([...AUTHZ_ACTIONS, 'tool.invoke']),
  resourceTypes: POLICY_RESOURCE_TYPES,
  roleActions: ROLE_ACTIONS_OBJECT,
  dataClasses: POLICY_DATA_CLASSES,
  sideEffectClasses: POLICY_SIDE_EFFECT_CLASSES,
  defaultLimits: DEFAULT_LIMITS,
  externalWritesEnabled: false,
  approvalBinding: 'exact-operation-fingerprint',
  idempotencyRequiredFor: Object.freeze(['consequential-write'])
});

const REQUEST_KEYS = new Set([
  'schemaVersion',
  'requestId',
  'correlationId',
  'operationId',
  'principal',
  'workspaceId',
  'membership',
  'action',
  'resource',
  'environment',
  'capabilityRequest',
  'trustedToolManifest',
  'approvalContext',
  'idempotencyKey',
  'trustedTimestamp',
  'payloadFingerprint',
  'untrustedInputs'
]);
const PRINCIPAL_KEYS = new Set(['userId', 'principalType', 'authenticationMethod', 'status', 'tokenScopes', 'tokenWorkspaceIds', 'agentRole']);
const MEMBERSHIP_KEYS = new Set(['workspaceId', 'role', 'status']);
const RESOURCE_KEYS = new Set(['type', 'id', 'workspaceId', 'dataClass']);
const ENVIRONMENT_KEYS = new Set(['deploymentProfile', 'locality', 'interactive', 'externalWritesEnabled']);
const CAPABILITY_KEYS = new Set(['toolId', 'operation', 'sideEffectClass', 'filesystem', 'network', 'secretReferences', 'dataClasses', 'sandbox', 'limits']);
const FILESYSTEM_KEYS = new Set(['read', 'write']);
const NETWORK_KEYS = new Set(['protocol', 'host', 'port', 'methods', 'consequence', 'locality']);
const LIMIT_KEYS = new Set(['runtimeMs', 'memoryBytes', 'outputBytes', 'inputBytes', 'invocationCount', 'costUnits', 'retryCount']);
const APPROVAL_KEYS = new Set(['approvalId', 'operationFingerprint', 'workspaceId', 'actorId', 'approverId', 'approvedAt', 'expiresAt', 'status', 'policyVersion']);
const TOOL_KEYS = new Set(['id', 'allowedRoles', 'riskClass', 'operations', 'permissions', 'timeoutMs', 'outputLimitBytes', 'approval']);
const OPERATION_KEYS = new Set(['sideEffectClass', 'filesystem', 'network', 'secretReferences', 'dataClasses', 'sandbox', 'limits']);

export const POLICY_REGISTRY = createPolicyRegistry();

export function createPolicyRegistry(overrides = {}) {
  assertPlainObject(overrides, 'policy registry overrides');
  try {
    assertNoUnknown(overrides, new Set(['schemaVersion', 'version', 'knownActions', 'resourceTypes', 'roleActions', 'dataClasses', 'sideEffectClasses', 'defaultLimits', 'externalWritesEnabled', 'approvalBinding', 'idempotencyRequiredFor']), 'policy registry');
  } catch {
    throw policyConfigError('unknown_field');
  }
  const registry = {
    ...deepClone(DEFAULT_REGISTRY),
    ...deepClone(overrides)
  };
  validatePolicyRegistry(registry);
  return deepFreeze(registry);
}

export function validatePolicyRegistry(registry) {
  assertPlainObject(registry, 'policy registry');
  assertNoUnknown(registry, new Set(['schemaVersion', 'version', 'knownActions', 'resourceTypes', 'roleActions', 'dataClasses', 'sideEffectClasses', 'defaultLimits', 'externalWritesEnabled', 'approvalBinding', 'idempotencyRequiredFor']), 'policy registry');
  if (registry.schemaVersion !== POLICY_SCHEMA_VERSION) throw policyConfigError('schemaVersion');
  if (!/^\d+\.\d+\.\d+$/.test(registry.version)) throw policyConfigError('version');
  for (const key of ['knownActions', 'resourceTypes', 'dataClasses', 'sideEffectClasses', 'idempotencyRequiredFor']) {
    if (!Array.isArray(registry[key]) || registry[key].some((value) => typeof value !== 'string' || !value)) throw policyConfigError(key);
  }
  assertPlainObject(registry.roleActions, 'policy registry roleActions');
  for (const [role, actions] of Object.entries(registry.roleActions)) {
    if (!ROLE_ACTIONS[role] || !Array.isArray(actions) || actions.some((action) => !registry.knownActions.includes(action))) throw policyConfigError(`roleActions.${role}`);
  }
  assertPlainObject(registry.defaultLimits, 'policy registry defaultLimits');
  validateLimits(registry.defaultLimits, registry.defaultLimits);
  if (typeof registry.externalWritesEnabled !== 'boolean') throw policyConfigError('externalWritesEnabled');
  if (registry.approvalBinding !== 'exact-operation-fingerprint') throw policyConfigError('approvalBinding');
  return true;
}

export function policyFingerprint(registry = POLICY_REGISTRY) {
  validatePolicyRegistry(registry);
  return `sha256:${sha256(stableStringify(registry))}`;
}

export function validatePolicyEvaluationRequest(request) {
  assertPlainObject(request, 'policy request');
  assertNoUnknown(request, REQUEST_KEYS, 'policy request');
  if (request.schemaVersion !== POLICY_SCHEMA_VERSION) throw new TypeError('policy_request_invalid:schemaVersion');
  if (request.principal !== null && request.principal !== undefined) {
    assertPlainObject(request.principal, 'policy principal');
    assertNoUnknown(request.principal, PRINCIPAL_KEYS, 'policy principal');
  }
  if (request.membership !== null && request.membership !== undefined) {
    assertPlainObject(request.membership, 'policy membership');
    assertNoUnknown(request.membership, MEMBERSHIP_KEYS, 'policy membership');
  }
  if (request.resource !== null && request.resource !== undefined) {
    assertPlainObject(request.resource, 'policy resource');
    assertNoUnknown(request.resource, RESOURCE_KEYS, 'policy resource');
  }
  if (request.environment !== null && request.environment !== undefined) {
    assertPlainObject(request.environment, 'policy environment');
    assertNoUnknown(request.environment, ENVIRONMENT_KEYS, 'policy environment');
  }
  if (request.capabilityRequest !== null && request.capabilityRequest !== undefined) validateCapabilityShape(request.capabilityRequest, 'policy capability request');
  if (request.trustedToolManifest !== null && request.trustedToolManifest !== undefined) validateToolManifestShape(request.trustedToolManifest);
  if (request.approvalContext !== null && request.approvalContext !== undefined) {
    assertPlainObject(request.approvalContext, 'policy approval context');
    assertNoUnknown(request.approvalContext, APPROVAL_KEYS, 'policy approval context');
  }
  if (request.untrustedInputs !== undefined) assertPlainObject(request.untrustedInputs, 'policy untrusted inputs');
  for (const forbidden of ['password', 'cookies', 'bearerToken', 'sessionSecret', 'csrfToken', 'secretValues', 'authorizationHeader', 'modelReasoning', 'policyText']) {
    if (Object.hasOwn(request, forbidden)) throw new TypeError(`policy_request_invalid:secret_value_not_allowed:${forbidden}`);
  }
  return request;
}

export function evaluateContextualPolicy(request, {
  registry = POLICY_REGISTRY,
  decisionIdFactory = () => `poldet_${randomUUID()}`,
  clock = () => new Date().toISOString()
} = {}) {
  const fingerprint = policyFingerprint(registry);
  let validated = null;
  const reasons = new Set();
  try {
    validated = validatePolicyEvaluationRequest(request);
  } catch {
    reasons.add('policy_configuration_invalid');
    validated = request && typeof request === 'object' ? request : {};
  }

  const principal = validated.principal ?? null;
  const membership = validated.membership ?? null;
  const resource = validated.resource ?? null;
  const environment = validated.environment ?? {};
  const capability = validated.capabilityRequest ?? null;
  const manifest = validated.trustedToolManifest ?? null;
  const action = validated.action ?? null;
  const workspaceId = validated.workspaceId ?? null;
  const evaluatedAt = validTimestamp(validated.trustedTimestamp) ? validated.trustedTimestamp : clock();

  if (!principal?.userId || principal.status !== 'active') reasons.add('missing_identity');
  if (!workspaceId) reasons.add('missing_workspace');
  if (!action || !registry.knownActions.includes(action)) reasons.add('unknown_action');

  const role = membership?.role ?? null;
  if (!membership || membership.status !== 'active' || membership.workspaceId !== workspaceId) reasons.add('membership_required');
  if (role && !Object.hasOwn(registry.roleActions, role)) reasons.add('unsupported_role');

  if (role && Object.hasOwn(registry.roleActions, role) && action && !registry.roleActions[role].includes(action)) reasons.add('resource_denied');
  if (principal?.authenticationMethod === 'bearer') {
    if (Array.isArray(principal.tokenWorkspaceIds) && workspaceId && !principal.tokenWorkspaceIds.includes(workspaceId)) reasons.add('resource_denied');
    if (Array.isArray(principal.tokenScopes) && action && !principal.tokenScopes.includes(action)) reasons.add('resource_denied');
    if (action === 'token.manage') reasons.add('resource_denied');
  }

  if (!resource?.type || !registry.resourceTypes.includes(resource.type)) reasons.add('resource_denied');
  if (resource?.workspaceId && workspaceId && resource.workspaceId !== workspaceId) reasons.add('workspace_mismatch');
  const dataClass = resource?.dataClass ?? 'workspace-private';
  if (!registry.dataClasses.includes(dataClass)) reasons.add('data_class_denied');
  if (dataClass === 'secret' && (action === 'context.compile' || resource?.type === 'context' || capability?.network?.length)) reasons.add('data_class_denied');
  if (dataClass === 'confidential' && resource?.workspaceId && workspaceId && resource.workspaceId !== workspaceId) reasons.add('data_class_denied');

  let effectiveCapability = null;
  if (capability || action === 'tool.invoke') {
    effectiveCapability = evaluateCapability({ capability, manifest, principal, environment, registry, reasons });
  }

  const sideEffectClass = capability?.sideEffectClass ?? 'read-only';
  if (sideEffectClass === 'consequential-write') {
    if (!validated.approvalContext) reasons.add('approval_required');
    if (!validated.idempotencyKey) reasons.add('idempotency_required');
    validateApproval({ request: validated, approval: validated.approvalContext, evaluatedAt, reasons });
  }

  const reasonCodes = orderedReasons(reasons);
  return sanitizeDecision({
    schemaVersion: POLICY_SCHEMA_VERSION,
    decisionId: safeId(decisionIdFactory(), 'poldet'),
    outcome: reasonCodes.length ? 'deny' : 'allow',
    action,
    principalType: principal?.principalType ?? null,
    actorId: principal?.userId ?? null,
    workspaceId: workspaceId ?? null,
    resource: {
      type: resource?.type ?? null,
      id: safeResourceId(resource?.id ?? null),
      dataClass
    },
    role,
    reasonCodes,
    matchedRules: matchedRulesFor({ action, role, capability }),
    effectiveCapability: reasonCodes.length ? null : effectiveCapability,
    policyVersion: registry.version,
    policyFingerprint: fingerprint,
    evaluatedAt,
    correlationId: typeof validated.correlationId === 'string' ? validated.correlationId : null
  });
}

export function createPolicyService({
  registry = POLICY_REGISTRY,
  auditSink = null,
  decisionIdFactory,
  clock
} = {}) {
  return {
    async evaluate(request) {
      const decision = evaluateContextualPolicy(request, { registry, decisionIdFactory, clock });
      if (!auditSink?.recordAuditEvent) return decision;
      try {
        await auditSink.recordAuditEvent(policyDecisionAuditEvent(decision, request));
        return decision;
      } catch {
        if (decision.outcome === 'deny') return decision;
        const sideEffectClass = request?.capabilityRequest?.sideEffectClass ?? 'read-only';
        if (sideEffectClass === 'read-only') return { ...decision, auditPersisted: false };
        return {
          ...decision,
          outcome: 'deny',
          reasonCodes: orderedReasons(new Set([...decision.reasonCodes, 'policy_configuration_invalid'])),
          effectiveCapability: null,
          auditPersisted: false
        };
      }
    }
  };
}

export function policyDecisionAuditEvent(decision, request = {}) {
  return {
    type: 'policy.decision',
    actorUserId: decision.actorId ?? undefined,
    workspaceId: decision.workspaceId ?? undefined,
    outcome: decision.outcome,
    correlationId: decision.correlationId ?? undefined,
    metadata: {
      decisionId: decision.decisionId,
      action: decision.action,
      resourceType: decision.resource?.type ?? null,
      resourceId: decision.resource?.id ?? null,
      reasonCodes: decision.reasonCodes.join(','),
      policyVersion: decision.policyVersion,
      policyFingerprint: decision.policyFingerprint,
      evaluatedAt: decision.evaluatedAt,
      operationId: safeString(request?.operationId, 128)
    }
  };
}

export function canonicalOperationFingerprint(request) {
  const principal = request?.principal ?? {};
  const capability = request?.capabilityRequest ?? null;
  const stable = {
    actor: principal.userId ?? null,
    workspaceId: request?.workspaceId ?? null,
    action: request?.action ?? null,
    resource: request?.resource ? {
      type: request.resource.type ?? null,
      id: request.resource.id ?? null,
      workspaceId: request.resource.workspaceId ?? null,
      dataClass: request.resource.dataClass ?? null
    } : null,
    tool: capability ? {
      toolId: capability.toolId ?? null,
      operation: capability.operation ?? null
    } : null,
    scopes: capability ? {
      filesystem: capability.filesystem ?? null,
      network: capability.network ?? null,
      secretReferences: capability.secretReferences ?? [],
      sandbox: capability.sandbox ?? null,
      limits: capability.limits ?? null
    } : null,
    sideEffectClass: capability?.sideEffectClass ?? 'read-only',
    dataClass: request?.resource?.dataClass ?? null,
    payloadFingerprint: request?.payloadFingerprint ?? null,
    idempotencyKey: request?.idempotencyKey ?? null
  };
  return `sha256:${sha256(stableStringify(stable))}`;
}

export function actionsForRole(role) {
  return [...(ROLE_ACTIONS[role] ?? new Set())].filter((action) => action !== 'tool.invoke').sort();
}

export function authorizeWorkspaceAction({ principal, workspaceId = null, action, requireSession = false, resourceType = 'workspace', correlationId = null, now = new Date().toISOString() } = {}) {
  const activeMembership = workspaceId
    ? principal?.memberships?.find((item) => item.workspaceId === workspaceId && item.status === 'active') ?? null
    : principal?.memberships?.find((item) => item.role === 'owner' && item.status === 'active') ?? null;
  const decision = evaluateContextualPolicy({
    schemaVersion: POLICY_SCHEMA_VERSION,
    requestId: 'polreq_authorize',
    correlationId,
    operationId: `authz:${action}`,
    principal: principal?.user ? {
      userId: principal.user.id,
      principalType: 'user',
      authenticationMethod: principal.credentialType === 'bearer' ? 'bearer' : 'session',
      status: principal.user.status,
      tokenScopes: principal.apiToken?.scopes,
      tokenWorkspaceIds: principal.apiToken?.workspaceIds
    } : null,
    workspaceId,
    membership: activeMembership ? { workspaceId: activeMembership.workspaceId, role: activeMembership.role, status: activeMembership.status } : null,
    action,
    resource: { type: resourceType, id: workspaceId, workspaceId, dataClass: 'workspace-private' },
    environment: { deploymentProfile: 'local-dev', locality: 'local-only', interactive: true, externalWritesEnabled: false },
    trustedTimestamp: now
  });
  const reasons = [...decision.reasonCodes];
  if (requireSession && principal?.credentialType !== 'session') reasons.push('resource_denied');
  return {
    schemaVersion: POLICY_SCHEMA_VERSION,
    decision: reasons.length ? 'deny' : 'allow',
    action,
    workspaceId,
    actorId: principal?.user?.id ?? null,
    role: decision.role,
    reasons: [...new Set(reasons)].sort(),
    policyVersion: decision.policyVersion,
    policyFingerprint: decision.policyFingerprint
  };
}

export function evaluatePolicy(input) {
  assertPlainObject(input, 'policy input');
  const reasons = [];
  if (!input.actorId || !input.workspaceId || !input.action) reasons.push('missing_identity_or_action');
  if (input.allowedRoles && !input.allowedRoles.includes(input.role)) reasons.push('role_denied');
  if (input.allowedDomains && input.domain && !input.allowedDomains.includes(input.domain)) reasons.push('network_domain_denied');
  if (input.allowedPaths && input.path && !input.allowedPaths.some((root) => input.path === root || input.path.startsWith(`${root}/`))) reasons.push('filesystem_path_denied');
  if (input.requiredSecret && !input.allowedSecrets?.includes(input.requiredSecret)) reasons.push('secret_scope_denied');
  if (input.dataClass === 'secret') reasons.push('secret_data_denied');
  if (input.riskClass === 'consequential-write' && !input.approvalValid) reasons.push('approval_required');
  if (input.riskClass === 'consequential-write' && !input.idempotencyKey) reasons.push('idempotency_required');
  return { decision: reasons.length ? 'deny' : 'allow', reasons, policyVersion: 'bootstrap-1' };
}

function evaluateCapability({ capability, manifest, principal, environment, registry, reasons }) {
  if (!manifest || !capability?.toolId) {
    reasons.add('tool_not_registered');
    return null;
  }
  if (manifest.id !== capability.toolId) reasons.add('tool_not_registered');
  const operations = normalizeOperations(manifest);
  const operation = operations[capability.operation ?? 'invoke'];
  if (!operation) {
    reasons.add('operation_not_declared');
    return null;
  }
  if (Array.isArray(manifest.allowedRoles) && manifest.allowedRoles.length) {
    const actorRole = principal?.agentRole ?? principal?.principalType;
    if (!manifest.allowedRoles.includes(actorRole)) reasons.add('resource_denied');
  }
  if (!POLICY_SIDE_EFFECT_CLASSES.includes(capability.sideEffectClass)) reasons.add('capability_exceeds_manifest');
  if (riskRank(capability.sideEffectClass) > riskRank(operation.sideEffectClass)) reasons.add('capability_exceeds_manifest');

  const filesystem = capability.filesystem ?? { read: [], write: [] };
  const allowedFilesystem = operation.filesystem ?? { read: [], write: [] };
  if (!scopesAllowed(filesystem.read ?? [], allowedFilesystem.read ?? [])) reasons.add('filesystem_read_denied');
  if (!scopesAllowed(filesystem.write ?? [], allowedFilesystem.write ?? [])) reasons.add('filesystem_write_denied');

  if (!networksAllowed(capability.network ?? [], operation.network ?? [], environment, reasons)) reasons.add('network_denied');
  if (!secretsAllowed(capability.secretReferences ?? [], operation.secretReferences ?? [])) reasons.add('secret_scope_denied');
  if (!dataClassesAllowed(capability.dataClasses ?? [], operation.dataClasses ?? registry.dataClasses)) reasons.add('data_class_denied');
  if ((capability.sandbox ?? 'none') !== (operation.sandbox ?? 'none')) reasons.add('sandbox_denied');
  if (!validateLimits(capability.limits ?? {}, operation.limits ?? registry.defaultLimits, false)) reasons.add('budget_exceeded');

  return sanitizeCapability({
    toolId: capability.toolId,
    operation: capability.operation ?? 'invoke',
    sideEffectClass: capability.sideEffectClass,
    filesystem,
    network: capability.network ?? [],
    dataClasses: capability.dataClasses ?? [],
    sandbox: capability.sandbox ?? 'none',
    limits: capability.limits ?? {}
  });
}

function normalizeOperations(manifest) {
  if (manifest.operations && typeof manifest.operations === 'object' && !Array.isArray(manifest.operations)) return manifest.operations;
  const permissions = manifest.permissions ?? {};
  const filesystem = {
    read: permissions.filesystem?.read ?? [],
    write: permissions.filesystem?.write ?? []
  };
  const network = (permissions.network ?? []).map((host) => typeof host === 'string'
    ? { protocol: 'http', host, port: host === 'localhost' || host === '127.0.0.1' ? 80 : 443, methods: ['GET'], consequence: 'read', locality: host === 'localhost' || host === '127.0.0.1' ? 'loopback' : 'external' }
    : host);
  return {
    invoke: {
      sideEffectClass: manifest.riskClass ?? 'read-only',
      filesystem,
      network,
      secretReferences: permissions.secrets ?? [],
      dataClasses: ['public', 'workspace-private'],
      sandbox: manifest.riskClass === 'read-only' ? 'read-only' : 'workspace-write',
      limits: { ...DEFAULT_LIMITS, runtimeMs: manifest.timeoutMs ?? DEFAULT_LIMITS.runtimeMs, outputBytes: manifest.outputLimitBytes ?? DEFAULT_LIMITS.outputBytes }
    }
  };
}

function validateApproval({ request, approval, evaluatedAt, reasons }) {
  if (!approval) return;
  if (!approval.approvalId || approval.status !== 'active') reasons.add('approval_invalid');
  if (approval.workspaceId && approval.workspaceId !== request.workspaceId) reasons.add('approval_scope_mismatch');
  if (approval.actorId && approval.actorId !== request.principal?.userId) reasons.add('approval_scope_mismatch');
  if (approval.policyVersion && approval.policyVersion !== POLICY_VERSION) reasons.add('approval_scope_mismatch');
  if (approval.expiresAt && Date.parse(approval.expiresAt) <= Date.parse(evaluatedAt)) reasons.add('approval_expired');
  if (approval.operationFingerprint !== canonicalOperationFingerprint(request)) reasons.add('approval_scope_mismatch');
}

function networksAllowed(requested, allowed, environment, reasons) {
  for (const item of requested) {
    assertPlainObject(item, 'policy network request');
    assertNoUnknown(item, NETWORK_KEYS, 'policy network request');
    if (item.consequence === 'write' && item.locality === 'external' && environment.externalWritesEnabled !== true) reasons.add('external_writes_disabled');
    const match = allowed.some((candidate) => networkContains(candidate, item));
    if (!match) return false;
  }
  return true;
}

function networkContains(candidate, requested) {
  const allowed = typeof candidate === 'string'
    ? { protocol: 'http', host: candidate, port: 80, methods: ['GET'], consequence: 'read', locality: candidate === 'localhost' || candidate === '127.0.0.1' ? 'loopback' : 'external' }
    : candidate;
  if (allowed.protocol !== requested.protocol) return false;
  if (String(allowed.host).toLowerCase() !== String(requested.host).toLowerCase()) return false;
  if (Number(allowed.port) !== Number(requested.port)) return false;
  if (allowed.locality !== requested.locality) return false;
  if (allowed.consequence !== requested.consequence) return false;
  const allowedMethods = new Set(allowed.methods ?? []);
  return (requested.methods ?? []).every((method) => allowedMethods.has(method));
}

function scopesAllowed(requested, allowed) {
  return requested.every((scope) => validPolicyScope(scope) && allowed.some((root) => scopeContains(root, scope)));
}

function scopeContains(root, scope) {
  if (!validPolicyScope(root) || !validPolicyScope(scope)) return false;
  return scope === root || scope.startsWith(`${root}/`);
}

function validPolicyScope(scope) {
  return typeof scope === 'string'
    && scope.length > 0
    && scope.length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(scope)
    && !scope.split('/').includes('..')
    && !scope.split('/').includes('.')
    && !scope.includes('\\');
}

function secretsAllowed(requested, allowed) {
  return requested.every((reference) => /^secret:[a-z0-9_.:-]+$/i.test(reference) && allowed.includes(reference));
}

function dataClassesAllowed(requested, allowed) {
  return requested.every((dataClass) => POLICY_DATA_CLASSES.includes(dataClass) && allowed.includes(dataClass));
}

function validateCapabilityShape(capability, label) {
  assertPlainObject(capability, label);
  if (Object.hasOwn(capability, 'secretValues')) throw new TypeError('policy_request_invalid:secret_value_not_allowed:secretValues');
  assertNoUnknown(capability, CAPABILITY_KEYS, label);
  if (capability.filesystem !== undefined) {
    assertPlainObject(capability.filesystem, `${label}.filesystem`);
    assertNoUnknown(capability.filesystem, FILESYSTEM_KEYS, `${label}.filesystem`);
  }
  if (capability.limits !== undefined) {
    assertPlainObject(capability.limits, `${label}.limits`);
    assertNoUnknown(capability.limits, LIMIT_KEYS, `${label}.limits`);
  }
  if (capability.network !== undefined) {
    if (!Array.isArray(capability.network)) throw new TypeError('policy_request_invalid:network');
    for (const item of capability.network) {
      assertPlainObject(item, `${label}.network`);
      assertNoUnknown(item, NETWORK_KEYS, `${label}.network`);
    }
  }
}

function validateToolManifestShape(manifest) {
  assertPlainObject(manifest, 'trusted tool manifest');
  assertNoUnknown(manifest, TOOL_KEYS, 'trusted tool manifest');
  if (manifest.operations) {
    for (const [name, operation] of Object.entries(manifest.operations)) {
      if (!name) throw new TypeError('policy_request_invalid:operation');
      assertPlainObject(operation, 'trusted tool operation');
      assertNoUnknown(operation, OPERATION_KEYS, 'trusted tool operation');
    }
  }
}

function validateLimits(requested, maxima, throwOnInvalid = true) {
  try {
    for (const [key, value] of Object.entries(requested)) {
      if (!LIMIT_KEYS.has(key) || typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(key);
      if (typeof maxima[key] === 'number' && value > maxima[key]) throw new Error(key);
    }
    return true;
  } catch {
    if (throwOnInvalid) throw policyConfigError('defaultLimits');
    return false;
  }
}

function orderedReasons(reasons) {
  return POLICY_REASON_CODES.filter((reason) => reasons.has(reason)).slice(0, 16);
}

function matchedRulesFor({ action, role, capability }) {
  const rules = [];
  if (action) rules.push(`action:${action}`);
  if (role) rules.push(`role:${role}`);
  if (capability?.toolId) rules.push(`tool:${capability.toolId}:${capability.operation ?? 'invoke'}`);
  return rules.slice(0, 8);
}

function sanitizeCapability(capability) {
  return {
    toolId: safeString(capability.toolId, 128),
    operation: safeString(capability.operation, 80),
    sideEffectClass: capability.sideEffectClass,
    filesystem: {
      read: (capability.filesystem.read ?? []).map((item) => safeString(item, 256)),
      write: (capability.filesystem.write ?? []).map((item) => safeString(item, 256))
    },
    network: capability.network.map((item) => ({
      protocol: item.protocol,
      host: item.host,
      port: item.port,
      methods: item.methods,
      consequence: item.consequence,
      locality: item.locality
    })),
    dataClasses: capability.dataClasses,
    sandbox: capability.sandbox,
    limits: Object.fromEntries(Object.entries(capability.limits).filter(([key]) => LIMIT_KEYS.has(key)))
  };
}

function sanitizeDecision(decision) {
  return {
    ...decision,
    matchedRules: decision.matchedRules.map((item) => safeString(item, 160)),
    reasonCodes: decision.reasonCodes.filter((item) => POLICY_REASON_CODES.includes(item)),
    resource: {
      type: decision.resource.type,
      id: decision.resource.id,
      dataClass: decision.resource.dataClass
    }
  };
}

function safeResourceId(value) {
  if (value === null || value === undefined) return null;
  return safeString(value, 128).replace(/[^\w:.-]/g, '_');
}

function safeString(value, maxLength) {
  if (typeof value !== 'string') return null;
  return value.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, maxLength);
}

function safeId(value, prefix) {
  return typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9._:-]{1,128}$`).test(value) ? value : `${prefix}_${randomUUID()}`;
}

function validTimestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function assertNoUnknown(object, allowed, label) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) throw new TypeError(`${label}:unknown_field:${key}`);
  }
}

function policyConfigError(field) {
  return new TypeError(`policy_configuration_invalid:${field}`);
}

function riskRank(value) {
  return POLICY_SIDE_EFFECT_CLASSES.indexOf(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}
