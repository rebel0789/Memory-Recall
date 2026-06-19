import { evaluatePolicy } from '../../policy/src/index.mjs';
export class ToolRegistry {
  #tools=new Map();
  register(manifest,handler) {
    if (!manifest?.id || typeof handler!=='function') throw new TypeError('tool manifest and handler are required');
    if (this.#tools.has(manifest.id)) throw new Error(`tool already registered: ${manifest.id}`);
    this.#tools.set(manifest.id,{manifest,handler});
  }
  list() { return [...this.#tools.values()].map(value=>value.manifest); }
  async invoke({toolId,actorId,role,workspaceId='ws_local',input,approvalValid=false,idempotencyKey=null}) {
    const entry=this.#tools.get(toolId); if (!entry) throw new Error(`unregistered tool: ${toolId}`);
    const policy=evaluatePolicy({actorId,role,workspaceId,action:`tool:${toolId}`,allowedRoles:entry.manifest.allowedRoles,riskClass:entry.manifest.riskClass,approvalValid,idempotencyKey});
    if (policy.decision!=='allow') return {status:'denied',policy};
    const output=await entry.handler(input,{actorId,workspaceId,idempotencyKey});
    return {status:'completed',policy,output};
  }
}
