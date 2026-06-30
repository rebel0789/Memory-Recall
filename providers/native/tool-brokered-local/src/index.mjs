import { BROKERED_LOCAL_TOOL_PROVIDER_ID, ToolRegistry, loadReviewedToolCatalog } from '../../../../packages/tool-registry/src/index.mjs';

export class BrokeredLocalToolProvider {
  constructor({ catalog = null, registry = null, ...options } = {}) {
    this.registry = registry ?? new ToolRegistry({ catalog, ...options });
  }

  static async fromCatalog({ catalogPath = 'tools/catalog.json', manifestRoot = process.cwd(), ...options } = {}) {
    const catalog = await loadReviewedToolCatalog({ catalogPath, manifestRoot });
    return new BrokeredLocalToolProvider({ catalog, ...options });
  }

  async health() {
    return {
      status: 'healthy',
      local: true,
      details: {
        provider: BROKERED_LOCAL_TOOL_PROVIDER_ID,
        reviewedCatalog: true,
        externalWrites: false,
        network: 'loopback-only',
        arbitraryShell: false,
        downloadedCode: false
      }
    };
  }

  async capabilities() {
    return [
      'tool.reviewed-catalog',
      'tool.one-use-grants',
      'tool.brokered-filesystem',
      'tool.loopback-egress',
      'tool.secret-references',
      'tool.idempotent-local-writes'
    ];
  }

  async execute(request) {
    return this.registry.execute(request);
  }

  close() {
    return undefined;
  }
}
