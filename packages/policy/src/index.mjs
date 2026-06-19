import { assertPlainObject } from '../../protocol/src/index.mjs';
export function evaluatePolicy(input) {
  assertPlainObject(input,'policy input');
  const reasons=[];
  if (!input.actorId || !input.workspaceId || !input.action) reasons.push('missing_identity_or_action');
  if (input.allowedRoles && !input.allowedRoles.includes(input.role)) reasons.push('role_denied');
  if (input.allowedDomains && input.domain && !input.allowedDomains.includes(input.domain)) reasons.push('network_domain_denied');
  if (input.allowedPaths && input.path && !input.allowedPaths.some(root=>input.path===root||input.path.startsWith(`${root}/`))) reasons.push('filesystem_path_denied');
  if (input.requiredSecret && !input.allowedSecrets?.includes(input.requiredSecret)) reasons.push('secret_scope_denied');
  if (input.dataClass==='secret') reasons.push('secret_data_denied');
  if (input.riskClass==='consequential-write' && !input.approvalValid) reasons.push('approval_required');
  if (input.riskClass==='consequential-write' && !input.idempotencyKey) reasons.push('idempotency_required');
  return {decision:reasons.length?'deny':'allow',reasons,policyVersion:'bootstrap-1'};
}

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

const ROLE_ACTIONS = Object.freeze({
  owner: new Set(AUTHZ_ACTIONS),
  builder: new Set(['workspace.read', 'dashboard.read', 'run.read', 'run.execute', 'context.compile', 'stream.read']),
  operator: new Set(['workspace.read', 'dashboard.read', 'run.read', 'run.execute', 'stream.read']),
  auditor: new Set(['workspace.read', 'dashboard.read', 'run.read', 'stream.read', 'audit.read'])
});

export function actionsForRole(role) {
  return [...(ROLE_ACTIONS[role] ?? new Set())].sort();
}

export function authorizeWorkspaceAction({ principal, workspaceId = null, action, requireSession = false } = {}) {
  const reasons = [];
  if (!principal?.user?.id) reasons.push('authentication_required');
  if (!AUTHZ_ACTIONS.includes(action)) reasons.push('unknown_action');
  if (requireSession && principal?.credentialType !== 'session') reasons.push('session_required');

  let membership = null;
  if (workspaceId) {
    membership = principal?.memberships?.find((item) => item.workspaceId === workspaceId && item.status === 'active') ?? null;
    if (!membership) reasons.push('workspace_membership_required');
  } else if (principal?.memberships?.some((item) => item.role === 'owner' && item.status === 'active')) {
    membership = principal.memberships.find((item) => item.role === 'owner' && item.status === 'active');
  }

  const role = membership?.role ?? null;
  if (role && !ROLE_ACTIONS[role]?.has(action)) reasons.push('role_denied');

  if (principal?.credentialType === 'bearer') {
    if (action === 'token.manage') reasons.push('token_cannot_manage_tokens');
    if (workspaceId && !principal.apiToken?.workspaceIds?.includes(workspaceId)) reasons.push('token_workspace_denied');
    if (action && !principal.apiToken?.scopes?.includes(action)) reasons.push('token_scope_denied');
  }

  return {
    schemaVersion: '1.0.0',
    decision: reasons.length ? 'deny' : 'allow',
    action,
    workspaceId,
    actorId: principal?.user?.id ?? null,
    role,
    reasons,
    policyVersion: 'authz-1'
  };
}
