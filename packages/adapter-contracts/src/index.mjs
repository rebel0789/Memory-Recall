/**
 * Provider-neutral ports and conformance helpers.
 *
 * Domain packages depend on these contracts. Providers and adapters implement
 * them. No method may return an upstream SDK object directly.
 */

export class ContractViolation extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ContractViolation';
    this.code = code;
    this.details = details;
  }
}

function notImplemented(contract, method) {
  throw new ContractViolation('not_implemented', `${contract}.${method} is not implemented`);
}

export class AdapterHealthPort {
  static contract = 'AdapterHealthPort';
  static requiredMethods = ['health', 'capabilities'];
  async health() { return notImplemented(AdapterHealthPort.contract, 'health'); }
  async capabilities() { return notImplemented(AdapterHealthPort.contract, 'capabilities'); }
}

export class EventRepositoryPort {
  static contract = 'EventRepositoryPort';
  static requiredMethods = ['append', 'listByRun'];
  async append() { return notImplemented(EventRepositoryPort.contract, 'append'); }
  async listByRun() { return notImplemented(EventRepositoryPort.contract, 'listByRun'); }
}

export class ContextManifestRepositoryPort {
  static contract = 'ContextManifestRepositoryPort';
  static version = '1.0.0';
  static requiredMethods = ['health', 'capabilities', 'append', 'get', 'listByRun', 'compare', 'verify'];
  async health() { return notImplemented(ContextManifestRepositoryPort.contract, 'health'); }
  async capabilities() { return notImplemented(ContextManifestRepositoryPort.contract, 'capabilities'); }
  async append() { return notImplemented(ContextManifestRepositoryPort.contract, 'append'); }
  async get() { return notImplemented(ContextManifestRepositoryPort.contract, 'get'); }
  async listByRun() { return notImplemented(ContextManifestRepositoryPort.contract, 'listByRun'); }
  async compare() { return notImplemented(ContextManifestRepositoryPort.contract, 'compare'); }
  async verify() { return notImplemented(ContextManifestRepositoryPort.contract, 'verify'); }
}

export class ArtifactStorePort {
  static contract = 'ArtifactStorePort';
  static version = '1.1.0';
  static requiredMethods = [
    'health',
    'capabilities',
    'put',
    'putSourceSnapshot',
    'get',
    'getMetadata',
    'getBody',
    'list',
    'verifyIntegrity',
    'planRetention',
    'applyRetention',
    'removeRecord',
    'remove',
    'exportWorkspace'
  ];
  async put() { return notImplemented(ArtifactStorePort.contract, 'put'); }
  async putSourceSnapshot() { return notImplemented(ArtifactStorePort.contract, 'putSourceSnapshot'); }
  async get() { return notImplemented(ArtifactStorePort.contract, 'get'); }
  async getMetadata() { return notImplemented(ArtifactStorePort.contract, 'getMetadata'); }
  async getBody() { return notImplemented(ArtifactStorePort.contract, 'getBody'); }
  async list() { return notImplemented(ArtifactStorePort.contract, 'list'); }
  async verifyIntegrity() { return notImplemented(ArtifactStorePort.contract, 'verifyIntegrity'); }
  async planRetention() { return notImplemented(ArtifactStorePort.contract, 'planRetention'); }
  async applyRetention() { return notImplemented(ArtifactStorePort.contract, 'applyRetention'); }
  async removeRecord() { return notImplemented(ArtifactStorePort.contract, 'removeRecord'); }
  async remove() { return notImplemented(ArtifactStorePort.contract, 'remove'); }
  async exportWorkspace() { return notImplemented(ArtifactStorePort.contract, 'exportWorkspace'); }
}

export class MemoryBackendPort {
  static contract = 'MemoryBackendPort';
  static requiredMethods = ['health', 'capabilities', 'put', 'get', 'queryCandidates', 'supersede', 'forget', 'export'];
  async health() { return notImplemented(MemoryBackendPort.contract, 'health'); }
  async capabilities() { return notImplemented(MemoryBackendPort.contract, 'capabilities'); }
  async put() { return notImplemented(MemoryBackendPort.contract, 'put'); }
  async get() { return notImplemented(MemoryBackendPort.contract, 'get'); }
  async queryCandidates() { return notImplemented(MemoryBackendPort.contract, 'queryCandidates'); }
  async supersede() { return notImplemented(MemoryBackendPort.contract, 'supersede'); }
  async forget() { return notImplemented(MemoryBackendPort.contract, 'forget'); }
  async export() { return notImplemented(MemoryBackendPort.contract, 'export'); }
}

export class ModelGatewayPort {
  static contract = 'ModelGatewayPort';
  static version = '1.0.0';
  static requiredMethods = ['health', 'capabilities', 'profile', 'generate'];
  async health() { return notImplemented(ModelGatewayPort.contract, 'health'); }
  async capabilities() { return notImplemented(ModelGatewayPort.contract, 'capabilities'); }
  profile() { return notImplemented(ModelGatewayPort.contract, 'profile'); }
  async generate() { return notImplemented(ModelGatewayPort.contract, 'generate'); }
}

export class WorkflowRuntimePort {
  static contract = 'WorkflowRuntimePort';
  static version = '1.1.0';
  static requiredMethods = ['health', 'capabilities', 'registerWorkflow', 'start', 'get', 'list', 'cancel', 'signal', 'resolveApproval', 'tick', 'runWorker', 'history', 'close'];
  async health() { return notImplemented(WorkflowRuntimePort.contract, 'health'); }
  async capabilities() { return notImplemented(WorkflowRuntimePort.contract, 'capabilities'); }
  async registerWorkflow() { return notImplemented(WorkflowRuntimePort.contract, 'registerWorkflow'); }
  async start() { return notImplemented(WorkflowRuntimePort.contract, 'start'); }
  async get() { return notImplemented(WorkflowRuntimePort.contract, 'get'); }
  async list() { return notImplemented(WorkflowRuntimePort.contract, 'list'); }
  async cancel() { return notImplemented(WorkflowRuntimePort.contract, 'cancel'); }
  async signal() { return notImplemented(WorkflowRuntimePort.contract, 'signal'); }
  async resolveApproval() { return notImplemented(WorkflowRuntimePort.contract, 'resolveApproval'); }
  async tick() { return notImplemented(WorkflowRuntimePort.contract, 'tick'); }
  async runWorker() { return notImplemented(WorkflowRuntimePort.contract, 'runWorker'); }
  async history() { return notImplemented(WorkflowRuntimePort.contract, 'history'); }
  close() { return notImplemented(WorkflowRuntimePort.contract, 'close'); }
}

export class PolicyEvaluatorPort {
  static contract = 'PolicyEvaluatorPort';
  static requiredMethods = ['evaluate'];
  async evaluate() { return notImplemented(PolicyEvaluatorPort.contract, 'evaluate'); }
}

export class ToolExecutionPort {
  static contract = 'ToolExecutionPort';
  static version = '1.0.0';
  static requiredMethods = ['health', 'capabilities', 'execute', 'close'];
  async health() { return notImplemented(ToolExecutionPort.contract, 'health'); }
  async capabilities() { return notImplemented(ToolExecutionPort.contract, 'capabilities'); }
  async execute() { return notImplemented(ToolExecutionPort.contract, 'execute'); }
  close() { return notImplemented(ToolExecutionPort.contract, 'close'); }
}

export class IdentityStorePort {
  static contract = 'IdentityStorePort';
  static version = '1.0.0';
  static requiredMethods = [
    'isBootstrapped',
    'bootstrapOwner',
    'verifyPassword',
    'createSession',
    'authenticateSession',
    'revokeSession',
    'createApiToken',
    'listApiTokens',
    'authenticateApiToken',
    'revokeApiToken',
    'listMemberships',
    'recordAuditEvent'
  ];
  async isBootstrapped() { return notImplemented(IdentityStorePort.contract, 'isBootstrapped'); }
  async bootstrapOwner() { return notImplemented(IdentityStorePort.contract, 'bootstrapOwner'); }
  async verifyPassword() { return notImplemented(IdentityStorePort.contract, 'verifyPassword'); }
  async createSession() { return notImplemented(IdentityStorePort.contract, 'createSession'); }
  async authenticateSession() { return notImplemented(IdentityStorePort.contract, 'authenticateSession'); }
  async revokeSession() { return notImplemented(IdentityStorePort.contract, 'revokeSession'); }
  async createApiToken() { return notImplemented(IdentityStorePort.contract, 'createApiToken'); }
  async listApiTokens() { return notImplemented(IdentityStorePort.contract, 'listApiTokens'); }
  async authenticateApiToken() { return notImplemented(IdentityStorePort.contract, 'authenticateApiToken'); }
  async revokeApiToken() { return notImplemented(IdentityStorePort.contract, 'revokeApiToken'); }
  async listMemberships() { return notImplemented(IdentityStorePort.contract, 'listMemberships'); }
  async recordAuditEvent() { return notImplemented(IdentityStorePort.contract, 'recordAuditEvent'); }
}

export class AuthenticationServicePort {
  static contract = 'AuthenticationServicePort';
  static requiredMethods = ['authenticateRequest', 'login', 'logout'];
  async authenticateRequest() { return notImplemented(AuthenticationServicePort.contract, 'authenticateRequest'); }
  async login() { return notImplemented(AuthenticationServicePort.contract, 'login'); }
  async logout() { return notImplemented(AuthenticationServicePort.contract, 'logout'); }
}

export class AuthorizationServicePort {
  static contract = 'AuthorizationServicePort';
  static requiredMethods = ['authorize'];
  async authorize() { return notImplemented(AuthorizationServicePort.contract, 'authorize'); }
}

export class SecurityAuditSinkPort {
  static contract = 'SecurityAuditSinkPort';
  static requiredMethods = ['recordAuditEvent'];
  async recordAuditEvent() { return notImplemented(SecurityAuditSinkPort.contract, 'recordAuditEvent'); }
}

export class CandidateSourcePort {
  static contract = 'CandidateSourcePort';
  static version = '1.0.0';
  static requiredMethods = ['descriptor', 'health', 'query'];
  async descriptor() { return notImplemented(CandidateSourcePort.contract, 'descriptor'); }
  async health() { return notImplemented(CandidateSourcePort.contract, 'health'); }
  async query() { return notImplemented(CandidateSourcePort.contract, 'query'); }
}

export class RepositoryGraphPort {
  static contract = 'RepositoryGraphPort';
  static requiredMethods = ['health', 'capabilities', 'build', 'query', 'export'];
  async health() { return notImplemented(RepositoryGraphPort.contract, 'health'); }
  async capabilities() { return notImplemented(RepositoryGraphPort.contract, 'capabilities'); }
  async build() { return notImplemented(RepositoryGraphPort.contract, 'build'); }
  async query() { return notImplemented(RepositoryGraphPort.contract, 'query'); }
  async export() { return notImplemented(RepositoryGraphPort.contract, 'export'); }
}

export class CodeIntelligencePort {
  static contract = 'CodeIntelligencePort';
  static version = '1.0.0';
  static requiredMethods = ['health', 'capabilities', 'buildGraph'];
  async health() { return notImplemented(CodeIntelligencePort.contract, 'health'); }
  async capabilities() { return notImplemented(CodeIntelligencePort.contract, 'capabilities'); }
  async buildGraph() { return notImplemented(CodeIntelligencePort.contract, 'buildGraph'); }
}

export class ResearchSourcePort {
  static contract = 'ResearchSourcePort';
  static requiredMethods = ['health', 'capabilities', 'collect'];
  async health() { return notImplemented(ResearchSourcePort.contract, 'health'); }
  async capabilities() { return notImplemented(ResearchSourcePort.contract, 'capabilities'); }
  async collect() { return notImplemented(ResearchSourcePort.contract, 'collect'); }
}

export class DesignArtifactPort {
  static contract = 'DesignArtifactPort';
  static requiredMethods = ['health', 'capabilities', 'render'];
  async health() { return notImplemented(DesignArtifactPort.contract, 'health'); }
  async capabilities() { return notImplemented(DesignArtifactPort.contract, 'capabilities'); }
  async render() { return notImplemented(DesignArtifactPort.contract, 'render'); }
}

export class AdvisoryPanelPort {
  static contract = 'AdvisoryPanelPort';
  static requiredMethods = ['health', 'capabilities', 'consult'];
  async health() { return notImplemented(AdvisoryPanelPort.contract, 'health'); }
  async capabilities() { return notImplemented(AdvisoryPanelPort.contract, 'capabilities'); }
  async consult() { return notImplemented(AdvisoryPanelPort.contract, 'consult'); }
}

export class CollaborationPort {
  static contract = 'CollaborationPort';
  static requiredMethods = ['health', 'capabilities', 'send', 'listObligations'];
  async health() { return notImplemented(CollaborationPort.contract, 'health'); }
  async capabilities() { return notImplemented(CollaborationPort.contract, 'capabilities'); }
  async send() { return notImplemented(CollaborationPort.contract, 'send'); }
  async listObligations() { return notImplemented(CollaborationPort.contract, 'listObligations'); }
}

export class PublisherPort {
  static contract = 'PublisherPort';
  static requiredMethods = ['health', 'capabilities', 'preview', 'publish'];
  async health() { return notImplemented(PublisherPort.contract, 'health'); }
  async capabilities() { return notImplemented(PublisherPort.contract, 'capabilities'); }
  async preview() { return notImplemented(PublisherPort.contract, 'preview'); }
  async publish() { return notImplemented(PublisherPort.contract, 'publish'); }
}

export class SkillSourcePort {
  static contract = 'SkillSourcePort';
  static requiredMethods = ['health', 'capabilities', 'inspect', 'importProposal'];
  async health() { return notImplemented(SkillSourcePort.contract, 'health'); }
  async capabilities() { return notImplemented(SkillSourcePort.contract, 'capabilities'); }
  async inspect() { return notImplemented(SkillSourcePort.contract, 'inspect'); }
  async importProposal() { return notImplemented(SkillSourcePort.contract, 'importProposal'); }
}

export class AgentPackRegistryPort {
  static contract = 'AgentPackRegistryPort';
  static requiredMethods = ['put', 'get', 'list', 'resolve'];
  async put() { return notImplemented(AgentPackRegistryPort.contract, 'put'); }
  async get() { return notImplemented(AgentPackRegistryPort.contract, 'get'); }
  async list() { return notImplemented(AgentPackRegistryPort.contract, 'list'); }
  async resolve() { return notImplemented(AgentPackRegistryPort.contract, 'resolve'); }
}

export class ReplayRepositoryPort {
  static contract = 'ReplayRepositoryPort';
  static requiredMethods = ['createPlan', 'recordComparison', 'get'];
  async createPlan() { return notImplemented(ReplayRepositoryPort.contract, 'createPlan'); }
  async recordComparison() { return notImplemented(ReplayRepositoryPort.contract, 'recordComparison'); }
  async get() { return notImplemented(ReplayRepositoryPort.contract, 'get'); }
}

export const PORTS = Object.freeze({
  AdapterHealthPort,
  EventRepositoryPort,
  ContextManifestRepositoryPort,
  ArtifactStorePort,
  MemoryBackendPort,
  ModelGatewayPort,
  WorkflowRuntimePort,
  PolicyEvaluatorPort,
  ToolExecutionPort,
  IdentityStorePort,
  AuthenticationServicePort,
  AuthorizationServicePort,
  SecurityAuditSinkPort,
  CandidateSourcePort,
  RepositoryGraphPort,
  ResearchSourcePort,
  DesignArtifactPort,
  AdvisoryPanelPort,
  CollaborationPort,
  PublisherPort,
  SkillSourcePort,
  AgentPackRegistryPort,
  ReplayRepositoryPort
});

export function assertPortImplementation(instance, PortClass) {
  if (!instance || typeof instance !== 'object') {
    throw new ContractViolation('invalid_provider', `${PortClass.contract} implementation must be an object`);
  }
  const missing = PortClass.requiredMethods.filter((method) => typeof instance[method] !== 'function');
  if (missing.length) {
    throw new ContractViolation('missing_methods', `${PortClass.contract} implementation is missing methods`, { missing });
  }
  return instance;
}

export function normalizeHealthResult(value, providerId = 'unknown') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContractViolation('invalid_health', `${providerId} returned a non-object health result`);
  }
  if (!['healthy', 'degraded', 'unavailable'].includes(value.status)) {
    throw new ContractViolation('invalid_health', `${providerId} returned an unsupported health status`);
  }
  return {
    schemaVersion: '1.0.0',
    providerId,
    status: value.status,
    local: value.local !== false,
    checkedAt: value.checkedAt ?? new Date().toISOString(),
    details: value.details && typeof value.details === 'object' ? value.details : {}
  };
}

export function normalizeCapabilities(value, providerId = 'unknown') {
  const list = Array.isArray(value) ? value : value?.capabilities;
  if (!Array.isArray(list) || list.some((item) => typeof item !== 'string' || !item)) {
    throw new ContractViolation('invalid_capabilities', `${providerId} returned invalid capabilities`);
  }
  return Object.freeze([...new Set(list)].sort());
}

export function createProviderEnvelope({ providerId, operation, payload, upstream = null, warnings = [] }) {
  if (!providerId || !operation) throw new ContractViolation('invalid_envelope', 'providerId and operation are required');
  if (payload === undefined) throw new ContractViolation('invalid_envelope', 'payload is required');
  return {
    schemaVersion: '1.0.0',
    providerId,
    operation,
    observedAt: new Date().toISOString(),
    upstream,
    warnings: [...new Set(warnings)],
    payload
  };
}

export function assertCanonicalEnvelope(envelope, expectedProviderId = null) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new ContractViolation('invalid_provider_output', 'provider output must be an envelope object');
  }
  for (const key of ['schemaVersion', 'providerId', 'operation', 'observedAt', 'payload']) {
    if (envelope[key] === undefined || envelope[key] === null) {
      throw new ContractViolation('invalid_provider_output', `provider envelope missing ${key}`);
    }
  }
  if (envelope.schemaVersion !== '1.0.0') {
    throw new ContractViolation('unsupported_provider_schema', `unsupported provider envelope schema ${envelope.schemaVersion}`);
  }
  if (expectedProviderId && envelope.providerId !== expectedProviderId) {
    throw new ContractViolation('provider_identity_mismatch', `expected ${expectedProviderId}, received ${envelope.providerId}`);
  }
  return envelope;
}

/**
 * Small executable smoke suite used by native providers and promoted adapters.
 * This checks contract shape only; category-specific suites add behavior tests.
 */
export async function runProviderSmokeConformance({ provider, PortClass, providerId, expectedCapabilities = [] }) {
  assertPortImplementation(provider, PortClass);
  const health = normalizeHealthResult(await provider.health(), providerId);
  const capabilities = normalizeCapabilities(await provider.capabilities(), providerId);
  const missingCapabilities = expectedCapabilities.filter((capability) => !capabilities.includes(capability));
  if (missingCapabilities.length) {
    throw new ContractViolation('missing_capabilities', `${providerId} is missing declared capabilities`, { missingCapabilities });
  }
  return { providerId, contract: PortClass.contract, health, capabilities, passed: true };
}
