import { DeterministicModel } from '../../../../packages/model-gateway/src/index.mjs';

const PROVIDER_ID = 'provider:native:model:deterministic';

export class DeterministicModelProvider extends DeterministicModel {
  async health() {
    return { status: 'healthy', local: true, details: { provider: PROVIDER_ID, deterministic: true } };
  }

  async capabilities() {
    return ['model.generate.synthetic', 'model.structured-output', 'model.deterministic'];
  }
}

export { PROVIDER_ID as DETERMINISTIC_MODEL_PROVIDER_ID };
