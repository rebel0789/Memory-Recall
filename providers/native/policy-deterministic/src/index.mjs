import {
  POLICY_REGISTRY,
  createPolicyService,
  evaluateContextualPolicy,
  policyFingerprint
} from '../../../../packages/policy/src/index.mjs';
import { randomUUID } from 'node:crypto';

export class DeterministicPolicyProvider {
  constructor({
    registry = POLICY_REGISTRY,
    auditSink = null,
    clock = () => new Date().toISOString(),
    decisionIdFactory = () => `poldet_${randomUUID()}`
  } = {}) {
    this.registry = registry;
    this.clock = clock;
    this.decisionIdFactory = decisionIdFactory;
    this.service = createPolicyService({ registry, auditSink, clock, decisionIdFactory });
  }

  async health() {
    return {
      status: 'healthy',
      providerId: 'provider:native:policy:deterministic',
      policyVersion: this.registry.version,
      policyFingerprint: policyFingerprint(this.registry),
      network: false,
      model: false
    };
  }

  async capabilities() {
    return {
      providerId: 'provider:native:policy:deterministic',
      capabilities: [
        'policy.evaluate.resource',
        'policy.evaluate.tool',
        'policy.evaluate.data-class',
        'policy.evaluate.side-effect',
        'policy.evaluate.approval',
        'policy.evaluate.budget',
        'policy.default-deny',
        'policy.deterministic'
      ],
      policyVersion: this.registry.version,
      policyFingerprint: policyFingerprint(this.registry)
    };
  }

  async evaluate(request) {
    return this.service.evaluate(request);
  }

  evaluateSync(request) {
    return evaluateContextualPolicy(request, {
      registry: this.registry,
      clock: this.clock,
      decisionIdFactory: this.decisionIdFactory
    });
  }
}
