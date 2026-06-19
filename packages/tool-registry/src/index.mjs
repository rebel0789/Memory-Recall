import { createPolicyService } from '../../policy/src/index.mjs';

export class ToolRegistry {
  #tools=new Map();
  #policy;
  constructor({policy={}}={}) {
    this.#policy=createPolicyService(policy);
  }
  register(manifest,handler) {
    if (!manifest?.id || typeof handler!=='function') throw new TypeError('tool manifest and handler are required');
    if (this.#tools.has(manifest.id)) throw new Error(`tool already registered: ${manifest.id}`);
    this.#tools.set(manifest.id,{manifest,handler});
  }
  list() { return [...this.#tools.values()].map(value=>value.manifest); }
  async invoke({toolId,actorId,role,workspaceId='ws_local',input,operation='invoke',capabilityRequest=null,approvalContext=null,idempotencyKey=null}) {
    const entry=this.#tools.get(toolId); if (!entry) throw new Error(`unregistered tool: ${toolId}`);
    const request=toolPolicyRequest({toolId,actorId,role,workspaceId,operation,manifest:entry.manifest,capabilityRequest,approvalContext,idempotencyKey});
    const policy=await this.#policy.evaluate(request);
    if (policy.outcome!=='allow') return {status:'denied',policy};
    const output=await entry.handler(input,{actorId,workspaceId,idempotencyKey});
    return {status:'completed',policy,output};
  }
}

function toolPolicyRequest({toolId,actorId,role,workspaceId,operation,manifest,capabilityRequest,approvalContext,idempotencyKey}) {
  const normalizedCapability = capabilityRequest ?? {
    toolId,
    operation,
    sideEffectClass: manifest.riskClass ?? 'read-only',
    filesystem: manifest.permissions?.filesystem ?? { read: [], write: [] },
    network: (manifest.permissions?.network ?? []).map((host) => typeof host === 'string'
      ? { protocol: 'http', host, port: host === 'localhost' || host === '127.0.0.1' ? 80 : 443, methods: ['GET'], consequence: 'read', locality: host === 'localhost' || host === '127.0.0.1' ? 'loopback' : 'external' }
      : host),
    secretReferences: manifest.permissions?.secrets ?? [],
    dataClasses: ['public', 'workspace-private'],
    sandbox: manifest.riskClass === 'read-only' ? 'read-only' : 'workspace-write',
    limits: { runtimeMs: manifest.timeoutMs ?? 30_000, outputBytes: manifest.outputLimitBytes ?? 1_000_000, costUnits: 0 }
  };
  return {
    schemaVersion: '1.0.0',
    requestId: 'polreq_tool_registry',
    correlationId: 'req_tool-registry-000000',
    operationId: `tool:${toolId}:${normalizedCapability.operation ?? operation}`,
    principal: {
      userId: actorId,
      principalType: 'agent',
      authenticationMethod: 'session',
      status: 'active',
      agentRole: role
    },
    workspaceId,
    membership: { workspaceId, role: 'owner', status: 'active' },
    action: 'tool.invoke',
    resource: { type: 'tool', id: toolId, workspaceId, dataClass: 'workspace-private' },
    environment: { deploymentProfile: 'local-dev', locality: 'local-only', interactive: true, externalWritesEnabled: false },
    capabilityRequest: normalizedCapability,
    trustedToolManifest: manifest,
    approvalContext,
    idempotencyKey,
    trustedTimestamp: '2026-06-19T00:00:00.000Z'
  };
}
