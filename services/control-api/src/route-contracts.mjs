const id = (prefix) => `^${prefix}_[A-Za-z0-9._:-]{1,120}$`;
const boundedString = (maxLength) => ({ type: 'string', minLength: 1, maxLength });
const correlationId = { type: 'string', pattern: '^req_[A-Za-z0-9._:-]{8,96}$', maxLength: 100 };
const runId = { type: 'string', pattern: id('run'), maxLength: 128 };
const tokenId = { type: 'string', pattern: id('tok'), maxLength: 128 };
const workspaceId = { type: 'string', pattern: id('ws'), maxLength: 128 };
const username = { type: 'string', pattern: '^[a-zA-Z0-9._:-]{1,80}$', maxLength: 80 };
const password = { type: 'string', minLength: 1, maxLength: 256 };
const workspaceLocatorInput = {
  type: 'string',
  minLength: 1,
  maxLength: 512,
  pattern: "^(workspace://)?(?!/)(?!.*\\.\\.)(?!.*\\\\)(?!.*\\s)(?!.*(?:^|/)Users(?:/|$))(?!.*(?:^|/)private(?:/|$))(?!.*(?:^|/)var/folders(?:/|$))[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,512}$"
};
const event = {
  type: 'object',
  additionalProperties: true,
  required: ['schemaVersion', 'id', 'workspaceId', 'type', 'runId', 'actorId', 'sequence', 'occurredAt', 'correlationId', 'dataClass', 'producerVersion', 'payload'],
  properties: {
    schemaVersion: { const: '1.0.0' },
    id: { type: 'string', pattern: id('evt'), maxLength: 128 },
    workspaceId: boundedString(128),
    type: boundedString(128),
    runId,
    actorId: boundedString(128),
    sequence: { type: 'integer', minimum: 0 },
    occurredAt: { type: 'string', format: 'date-time' },
    correlationId,
    causationId: { type: ['string', 'null'], maxLength: 128 },
    dataClass: { enum: ['public', 'workspace-private', 'sensitive'] },
    producerVersion: boundedString(64),
    payload: { type: 'object', maxProperties: 64, additionalProperties: true }
  }
};

const run = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'workspaceId', 'workflowId', 'workflowVersion', 'objective', 'status', 'residency', 'createdAt', 'completedAt', 'output', 'verification'],
  properties: {
    id: runId,
    workspaceId,
    workflowId: { const: 'workflow:content-intelligence' },
    workflowVersion: boundedString(64),
    objective: boundedString(2000),
    status: { enum: ['completed', 'failed', 'cancelled', 'running'] },
    residency: { const: 'local-only' },
    createdAt: { type: 'string', format: 'date-time' },
    completedAt: { type: ['string', 'null'], format: 'date-time' },
    output: { type: ['object', 'array', 'null'], additionalProperties: true, maxItems: 16 },
    verification: { type: ['object', 'null'], additionalProperties: true }
  }
};

const errorEnvelope = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'error'],
  properties: {
    schemaVersion: { const: '1.0.0' },
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message', 'correlationId'],
      properties: {
        code: {
          enum: [
            'invalid_json',
            'request_validation_failed',
            'invalid_path_parameter',
            'route_not_found',
            'method_not_allowed',
            'request_too_large',
            'unsupported_media_type',
            'unsupported_content_encoding',
            'authentication_required',
            'invalid_credentials',
            'invalid_authentication',
            'csrf_failed',
            'forbidden',
            'resource_not_found',
            'already_bootstrapped',
            'workspace_context_conflict',
            'rate_limited',
            'bootstrap_required',
            'internal_error'
          ]
        },
        message: boundedString(240),
        correlationId,
        issues: {
          type: 'array',
          maxItems: 32,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['path', 'code'],
            properties: {
              path: { type: 'string', minLength: 1, maxLength: 256 },
              code: { type: 'string', minLength: 1, maxLength: 64 }
            }
          }
        }
      }
    }
  }
};

function contextRequestSchema(limits) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'id', 'workspaceId', 'actorId', 'taskId', 'step', 'objective', 'tokenBudget', 'allowedScopes'],
    properties: {
      schemaVersion: { const: '1.0.0' },
      id: { type: 'string', pattern: id('ctxreq'), maxLength: 128 },
      workspaceId: boundedString(128),
      actorId: boundedString(128),
      taskId: boundedString(128),
      step: boundedString(128),
      objective: boundedString(limits.objectiveLength),
      requiredIds: { type: 'array', maxItems: limits.jsonArrayItems, uniqueItems: true, items: boundedString(128) },
      requiredEntities: { type: 'array', maxItems: limits.jsonArrayItems, uniqueItems: true, items: boundedString(128) },
      tokenBudget: { type: 'integer', minimum: 1, maximum: 100000 },
      allowedScopes: { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true, items: { enum: ['public', 'workspace-private', 'sensitive'] } },
      now: { type: 'string', format: 'date-time' },
      profile: boundedString(64)
    }
  };
}

function recordSchema(limits) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'kind', 'text'],
    properties: {
      id: boundedString(128),
      kind: boundedString(64),
      text: boundedString(5000),
      scope: { enum: ['public', 'workspace-private', 'sensitive'] },
      status: boundedString(64),
      source: boundedString(256),
      tokens: { type: 'integer', minimum: 0, maximum: 100000 },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      authority: { type: 'number', minimum: 0, maximum: 1 },
      supersedes: { type: ['string', 'null'], maxLength: 128 },
      metadata: { type: 'object', maxProperties: limits.jsonObjectKeys, additionalProperties: true }
    }
  };
}

export function createApiRouteContracts(limits = {}) {
  const routeBodyBytes = {
    bootstrapOwner: Math.min(limits.bodyBytes ?? 1_000_000, 8 * 1024),
    login: Math.min(limits.bodyBytes ?? 1_000_000, 4 * 1024),
    createApiToken: Math.min(limits.bodyBytes ?? 1_000_000, 8 * 1024),
    startRun: Math.min(limits.bodyBytes ?? 1_000_000, 32 * 1024),
    compileContext: Math.min(limits.bodyBytes ?? 1_000_000, 256 * 1024),
    buildContextPack: Math.min(limits.bodyBytes ?? 1_000_000, 16 * 1024),
    previewContextGraph: Math.min(limits.bodyBytes ?? 1_000_000, 16 * 1024),
    planHarnessSetup: Math.min(limits.bodyBytes ?? 1_000_000, 4 * 1024),
    resetBootstrap: 0
  };
  const limitShape = {
    objectiveLength: limits.objectiveLength ?? 2000,
    jsonArrayItems: limits.jsonArrayItems ?? 100,
    jsonObjectKeys: limits.jsonObjectKeys ?? 100
  };
  const startRunRequest = {
    type: 'object',
    additionalProperties: false,
    required: ['workspaceId'],
    maxProperties: 3,
    properties: {
      workspaceId,
      workflowId: { const: 'workflow:content-intelligence' },
      objective: boundedString(limitShape.objectiveLength)
    }
  };
  const loginRequest = {
    type: 'object',
    additionalProperties: false,
    required: ['username', 'password'],
    properties: { username, password }
  };
  const bootstrapOwnerRequest = {
    type: 'object',
    additionalProperties: false,
    required: ['username', 'displayName', 'password'],
    properties: {
      username,
      displayName: boundedString(120),
      password,
      workspaceId,
      workspaceName: boundedString(160)
    }
  };
  const userSummary = {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'username', 'displayName', 'status', 'createdAt', 'updatedAt'],
    properties: {
      id: { type: 'string', pattern: id('usr'), maxLength: 128 },
      username,
      displayName: boundedString(120),
      status: { enum: ['active', 'disabled'] },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' }
    }
  };
  const membershipSummary = {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'userId', 'workspaceId', 'role', 'status', 'createdAt', 'updatedAt'],
    properties: {
      id: { type: 'string', pattern: id('wsm'), maxLength: 128 },
      userId: { type: 'string', pattern: id('usr'), maxLength: 128 },
      workspaceId,
      role: { enum: ['owner', 'builder', 'operator', 'auditor'] },
      status: { enum: ['active', 'disabled'] },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' }
    }
  };
  const sessionResponse = {
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'authenticated', 'user', 'memberships', 'actions'],
    properties: {
      schemaVersion: { const: '1.0.0' },
      authenticated: { const: true },
      user: userSummary,
      memberships: { type: 'array', maxItems: 32, items: membershipSummary },
      actions: { type: 'array', maxItems: 32, uniqueItems: true, items: boundedString(80) }
    }
  };
  const apiTokenSummary = {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'userId', 'name', 'tokenPrefix', 'workspaceIds', 'scopes', 'createdAt', 'expiresAt', 'revokedAt'],
    properties: {
      id: tokenId,
      userId: { type: 'string', pattern: id('usr'), maxLength: 128 },
      name: boundedString(120),
      tokenPrefix: { type: 'string', minLength: 8, maxLength: 64 },
      workspaceIds: { type: 'array', minItems: 1, maxItems: 16, uniqueItems: true, items: workspaceId },
      scopes: { type: 'array', maxItems: 16, uniqueItems: true, items: boundedString(80) },
      createdAt: { type: 'string', format: 'date-time' },
      expiresAt: { type: ['string', 'null'], format: 'date-time' },
      revokedAt: { type: ['string', 'null'], format: 'date-time' }
    }
  };
  const createApiTokenRequest = {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'workspaceIds', 'scopes'],
    properties: {
      name: boundedString(120),
      workspaceIds: { type: 'array', minItems: 1, maxItems: 16, uniqueItems: true, items: workspaceId },
      scopes: { type: 'array', minItems: 1, maxItems: 16, uniqueItems: true, items: { enum: ['run.read', 'run.execute', 'context.compile', 'stream.read', 'dashboard.read', 'workspace.read'] } },
      expiresAt: { type: ['string', 'null'], format: 'date-time' }
    }
  };
  const contextCompileRequest = {
    type: 'object',
    additionalProperties: false,
    required: ['request', 'records'],
    properties: {
      request: contextRequestSchema(limitShape),
      records: { type: 'array', maxItems: limitShape.jsonArrayItems, items: recordSchema(limitShape) }
    }
  };
  const contextPackRequest = {
    type: 'object',
    additionalProperties: false,
    required: ['workspaceId', 'objective', 'step'],
    properties: {
      workspaceId,
      objective: boundedString(limitShape.objectiveLength),
      step: boundedString(256),
      targetHarness: { enum: ['codex', 'claude-code', 'claude', 'cursor', 'generic'] },
      from: {
        type: 'string',
        minLength: 1,
        maxLength: 80,
        pattern: '^(all|(?:codex|claude|claude-code|cursor)(?:\\s*,\\s*(?:codex|claude|claude-code|cursor))*)$'
      },
      userSelectedFiles: { type: 'array', maxItems: 16, uniqueItems: true, items: boundedString(240) },
      changedLocators: { type: 'array', maxItems: 16, uniqueItems: true, items: workspaceLocatorInput },
      tokenBudget: { type: 'integer', minimum: 1, maximum: 100000 }
    }
  };
  const contextGraphPreviewRequest = {
    type: 'object',
    additionalProperties: false,
    required: ['workspaceId'],
    properties: {
      workspaceId,
      query: boundedString(512),
      startName: boundedString(240),
      startNodeId: boundedString(128),
      changedLocators: { type: 'array', maxItems: 100, uniqueItems: true, items: workspaceLocatorInput },
      nodeKinds: { type: 'array', maxItems: 4, uniqueItems: true, items: { enum: ['file', 'chunk', 'symbol', 'module'] } },
      edgeKinds: { type: 'array', maxItems: 6, uniqueItems: true, items: { enum: ['contains', 'defined_in', 'imports', 'exports', 'references', 'calls'] } },
      labelPattern: boundedString(240),
      locatorPrefix: boundedString(512),
      direction: { enum: ['outbound', 'inbound', 'both'] },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      offset: { type: 'integer', minimum: 0, maximum: 10000 },
      depth: { type: 'integer', minimum: 1, maximum: 5 },
      sampleLimit: { type: 'integer', minimum: 1, maximum: 50 },
      maxFiles: { type: 'integer', minimum: 1, maximum: 1000 },
      maxFileBytes: { type: 'integer', minimum: 1024, maximum: 1048576 }
    }
  };
  const harnessSetupPlanRequest = {
    type: 'object',
    additionalProperties: false,
    required: ['workspaceId', 'client'],
    maxProperties: 2,
    properties: {
      workspaceId,
      client: {
        enum: ['codex', 'cursor', 'claude-code', 'opencode', 'openclaw', 'gemini-cli', 'zed', 'aider', 'goose', 'vscode', 'cline', 'roo', 'windsurf', 'generic-mcp']
      }
    }
  };
  const contextPackResponse = {
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'pack', 'markdown'],
    properties: {
      schemaVersion: { const: '1.0.0' },
      pack: {
        type: 'object',
        additionalProperties: true,
        required: ['schemaVersion', 'id', 'workspaceId', 'targetHarness', 'sourceHarnesses', 'readFirst', 'excluded', 'omissions', 'memoryPlan', 'sourceGraph', 'warnings', 'delivery', 'safeguards', 'contextPackFingerprint'],
        properties: {
          schemaVersion: { const: '1.0.0' },
          id: { type: 'string', pattern: id('ctxpack'), maxLength: 128 },
          workspaceId,
          targetHarness: boundedString(32),
          sourceHarnesses: { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true, items: { enum: ['codex', 'claude-code', 'cursor'] } },
          readFirst: { type: 'array', maxItems: 128, items: { type: 'object', additionalProperties: true } },
          excluded: { type: 'array', maxItems: 128, items: { type: 'object', additionalProperties: true } },
          omissions: { type: 'object', additionalProperties: true },
          memoryPlan: { type: 'object', additionalProperties: true },
          sourceGraph: { type: 'object', additionalProperties: true },
          warnings: { type: 'array', maxItems: 128, items: boundedString(512) },
          delivery: { type: 'object', additionalProperties: true },
          safeguards: { type: 'object', additionalProperties: true },
          contextPackFingerprint: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' }
        }
      },
      markdown: { type: 'string', minLength: 1, maxLength: 200000 }
    }
  };
  const contextGraphPreviewResponse = {
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'previewVersion', 'workspaceId', 'generatedAt', 'graph', 'search', 'trace', 'impact', 'safeguards'],
    properties: {
      schemaVersion: { const: '1.0.0' },
      previewVersion: { const: 'oaf-source-graph-preview-1.0.0' },
      workspaceId,
      generatedAt: { type: 'string', format: 'date-time' },
      graph: { type: 'object', additionalProperties: true, required: ['graphFingerprint', 'summary', 'sampleNodes', 'sampleEdges'], properties: {} },
      search: { type: 'object', additionalProperties: true, required: ['queryFingerprint', 'results'], properties: {} },
      trace: { type: ['object', 'null'], additionalProperties: true, properties: {} },
      impact: { type: ['object', 'null'], additionalProperties: true, properties: {} },
      safeguards: {
        type: 'object',
        additionalProperties: false,
        required: ['dryRun', 'persisted', 'canonicalStateMutated', 'localFilesWritten', 'modelCalls', 'networkCalls', 'externalAdaptersEnabled', 'externalWritesEnabled', 'graphDatabaseUsed', 'rawBodyIncluded', 'sourceSlicesRead'],
        properties: {
          dryRun: { const: true },
          persisted: { const: false },
          canonicalStateMutated: { const: false },
          localFilesWritten: { const: 0 },
          modelCalls: { const: 0 },
          networkCalls: { const: 0 },
          externalAdaptersEnabled: { const: 0 },
          externalWritesEnabled: { const: false },
          graphDatabaseUsed: { const: false },
          rawBodyIncluded: { const: false },
          sourceSlicesRead: { const: false }
        }
      }
    }
  };
  const harnessSetupPlanResponse = {
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'plannerVersion', 'command', 'dryRun', 'generatedAt', 'client', 'clientLabel', 'server', 'config', 'status', 'desiredServer', 'diff', 'safeguards', 'planFingerprint'],
    properties: {
      schemaVersion: { const: '1.0.0' },
      plannerVersion: boundedString(32),
      command: { const: 'harness setup plan' },
      dryRun: { const: true },
      generatedAt: { type: 'string', format: 'date-time' },
      client: boundedString(32),
      clientLabel: boundedString(80),
      server: { const: 'oaf' },
      config: {
        type: 'object',
        additionalProperties: false,
        required: ['ref', 'format', 'exists', 'serverCount'],
        properties: {
          ref: { type: 'string', pattern: '^home://[A-Za-z0-9._/-]{1,240}$', maxLength: 256 },
          format: { enum: ['json', 'jsonc', 'toml', 'yaml'] },
          exists: { type: 'boolean' },
          serverCount: { type: 'integer', minimum: 0, maximum: 1000 }
        }
      },
      status: {
        type: 'object',
        additionalProperties: false,
        required: ['config', 'server'],
        properties: {
          config: { enum: ['present', 'absent'] },
          server: { enum: ['installed', 'absent', 'drifted'] }
        }
      },
      desiredServer: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'transport', 'command', 'args', 'environmentKeys', 'resourceMode', 'externalWrites'],
        properties: {
          name: { const: 'oaf' },
          transport: { const: 'stdio' },
          command: { const: 'npm' },
          args: {
            type: 'array',
            minItems: 7,
            maxItems: 7,
            items: boundedString(32)
          },
          environmentKeys: { type: 'array', maxItems: 0 },
          resourceMode: { const: 'read-only' },
          externalWrites: { const: false }
        }
      },
      diff: {
        type: 'object',
        additionalProperties: false,
        required: ['redacted', 'operations', 'preview'],
        properties: {
          redacted: { const: true },
          operations: {
            type: 'array',
            maxItems: 1,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['op', 'target', 'before', 'after', 'summary'],
              properties: {
                op: { enum: ['add', 'replace', 'remove'] },
                target: { const: 'mcpServers.oaf' },
                before: { enum: ['installed', 'absent', 'drifted'] },
                after: { enum: ['read-only-oaf-mcp-stdio', 'absent'] },
                summary: boundedString(160)
              }
            }
          },
          preview: { type: 'array', maxItems: 1, items: boundedString(160) }
        }
      },
      safeguards: {
        type: 'object',
        additionalProperties: false,
        required: ['localFilesWritten', 'canonicalStateMutated', 'homeConfigMutated', 'externalWritesEnabled', 'externalAdaptersEnabled', 'networkCalls', 'modelCalls', 'rawConfigBodyIncluded', 'absoluteFilesystemLocationsIncluded', 'credentialsIncluded'],
        properties: {
          localFilesWritten: { const: 0 },
          canonicalStateMutated: { const: false },
          homeConfigMutated: { const: false },
          externalWritesEnabled: { const: false },
          externalAdaptersEnabled: { const: 0 },
          networkCalls: { const: 0 },
          modelCalls: { const: 0 },
          rawConfigBodyIncluded: { const: false },
          absoluteFilesystemLocationsIncluded: { const: false },
          credentialsIncluded: { const: false }
        }
      },
      planFingerprint: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$', maxLength: 80 }
    }
  };
  const contextManifest = {
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'id', 'workspaceId', 'compilerVersion', 'createdAt', 'budget', 'selected', 'excluded', 'conflicts'],
    properties: {
      schemaVersion: { const: '1.0.0' },
      id: { type: 'string', pattern: id('ctx'), maxLength: 128 },
      workspaceId: boundedString(128),
      requestId: { type: ['string', 'null'], maxLength: 128 },
      runId: { type: ['string', 'null'], maxLength: 128 },
      compilerVersion: boundedString(64),
      createdAt: { type: 'string', format: 'date-time' },
      manifestFingerprint: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$', maxLength: 80 },
      budget: {
        type: 'object',
        additionalProperties: false,
        required: ['available', 'used'],
        properties: { available: { type: 'integer', minimum: 1 }, used: { type: 'integer', minimum: 0 } }
      },
      selected: { type: 'array', maxItems: limitShape.jsonArrayItems, items: { type: 'object', additionalProperties: true } },
      excluded: { type: 'array', maxItems: limitShape.jsonArrayItems, items: { type: 'object', additionalProperties: true } },
      conflicts: { type: 'array', maxItems: limitShape.jsonArrayItems, items: { type: 'object', additionalProperties: true } },
      warnings: { type: 'array', maxItems: limitShape.jsonArrayItems, items: boundedString(256) },
      assembly: {
        type: 'object',
        additionalProperties: true,
        required: ['assemblyPolicyVersion', 'assemblyPolicyFingerprint', 'selectedRecordIds', 'totalTokens', 'sections', 'assemblyFingerprint'],
        properties: {
          assemblyPolicyVersion: boundedString(32),
          assemblyPolicyFingerprint: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$', maxLength: 80 },
          selectedRecordIds: { type: 'array', maxItems: limitShape.jsonArrayItems, items: boundedString(128) },
          totalTokens: { type: 'integer', minimum: 0 },
          sections: { type: 'array', maxItems: 16, items: { type: 'object', additionalProperties: true } },
          assemblyFingerprint: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$', maxLength: 80 }
        }
      },
      selectionSummary: { type: ['object', 'null'], additionalProperties: true },
      selectionPolicy: { type: ['object', 'null'], additionalProperties: true },
      candidateGeneration: { type: 'object', additionalProperties: true },
      tokenAccounting: { type: 'object', additionalProperties: true },
      fingerprintAlgorithm: boundedString(32),
      persisted: { type: 'boolean' },
      manifestVerification: { type: 'object', additionalProperties: true }
    }
  };

  return Object.freeze([
    {
      method: 'GET',
      path: '/api/health',
      operationId: 'getHealth',
      security: { public: true },
      pathParameters: {},
      query: { additionalProperties: false, properties: {} },
      headers: {},
      requestMediaType: null,
      requestBodySchema: null,
      maxBodyBytes: 0,
      allowsBody: false,
      streams: false,
      responses: {
        200: {
          type: 'object',
          additionalProperties: false,
          required: ['schemaVersion', 'status', 'mode', 'version', 'residency', 'externalWrites', 'time'],
          properties: {
            schemaVersion: { const: '1.0.0' },
            status: { const: 'ok' },
            mode: { const: 'local-bootstrap' },
            version: boundedString(64),
            residency: { const: 'local-only' },
            externalWrites: { const: false },
            time: { type: 'string', format: 'date-time' }
          }
        }
      }
    },
    {
      method: 'GET',
      path: '/api/auth/bootstrap-status',
      operationId: 'getBootstrapStatus',
      security: { public: true },
      pathParameters: {},
      query: { additionalProperties: false, properties: {} },
      headers: {},
      requestMediaType: null,
      requestBodySchema: null,
      maxBodyBytes: 0,
      allowsBody: false,
      streams: false,
      responses: {
        200: {
          type: 'object',
          additionalProperties: false,
          required: ['schemaVersion', 'bootstrapRequired'],
          properties: {
            schemaVersion: { const: '1.0.0' },
            bootstrapRequired: { type: 'boolean' }
          }
        }
      }
    },
    {
      method: 'POST',
      path: '/api/auth/bootstrap',
      operationId: 'bootstrapOwner',
      security: { public: true, origin: true },
      pathParameters: {},
      query: { additionalProperties: false, properties: {} },
      headers: { contentType: 'application/json' },
      requestMediaType: 'application/json',
      requestBodySchema: bootstrapOwnerRequest,
      maxBodyBytes: routeBodyBytes.bootstrapOwner,
      allowsBody: true,
      bodyRequired: true,
      streams: false,
      responses: { 201: sessionResponse }
    },
    {
      method: 'POST',
      path: '/api/auth/login',
      operationId: 'login',
      security: { public: true, origin: true },
      pathParameters: {},
      query: { additionalProperties: false, properties: {} },
      headers: { contentType: 'application/json' },
      requestMediaType: 'application/json',
      requestBodySchema: loginRequest,
      maxBodyBytes: routeBodyBytes.login,
      allowsBody: true,
      bodyRequired: true,
      streams: false,
      responses: { 200: sessionResponse }
    },
    {
      method: 'GET',
      path: '/api/auth/session',
      operationId: 'getSession',
      security: { authenticated: true },
      pathParameters: {},
      query: { additionalProperties: false, properties: {} },
      headers: {},
      requestMediaType: null,
      requestBodySchema: null,
      maxBodyBytes: 0,
      allowsBody: false,
      streams: false,
      responses: { 200: sessionResponse }
    },
    {
      method: 'POST',
      path: '/api/auth/logout',
      operationId: 'logout',
      security: { authenticated: true },
      pathParameters: {},
      query: { additionalProperties: false, properties: {} },
      headers: {},
      requestMediaType: null,
      requestBodySchema: null,
      maxBodyBytes: 0,
      allowsBody: false,
      streams: false,
      responses: { 200: { type: 'object', additionalProperties: false, required: ['schemaVersion', 'loggedOut'], properties: { schemaVersion: { const: '1.0.0' }, loggedOut: { const: true } } } }
    },
    {
      method: 'POST',
      path: '/api/auth/tokens',
      operationId: 'createApiToken',
      security: { authenticated: true, sessionOnly: true, csrf: true, action: 'token.manage' },
      pathParameters: {},
      query: { additionalProperties: false, properties: {} },
      headers: { contentType: 'application/json' },
      requestMediaType: 'application/json',
      requestBodySchema: createApiTokenRequest,
      maxBodyBytes: routeBodyBytes.createApiToken,
      allowsBody: true,
      bodyRequired: true,
      streams: false,
      responses: { 201: { type: 'object', additionalProperties: false, required: ['schemaVersion', 'apiToken', 'token'], properties: { schemaVersion: { const: '1.0.0' }, apiToken: apiTokenSummary, token: boundedString(256) } } }
    },
    {
      method: 'GET',
      path: '/api/auth/tokens',
      operationId: 'listApiTokens',
      security: { authenticated: true, sessionOnly: true, action: 'token.manage' },
      pathParameters: {},
      query: { additionalProperties: false, properties: {} },
      headers: {},
      requestMediaType: null,
      requestBodySchema: null,
      maxBodyBytes: 0,
      allowsBody: false,
      streams: false,
      responses: { 200: { type: 'object', additionalProperties: false, required: ['schemaVersion', 'items'], properties: { schemaVersion: { const: '1.0.0' }, items: { type: 'array', maxItems: 100, items: apiTokenSummary } } } }
    },
    {
      method: 'DELETE',
      path: '/api/auth/tokens/{tokenId}',
      operationId: 'deleteApiToken',
      security: { authenticated: true, sessionOnly: true, csrf: true, action: 'token.manage' },
      pathParameters: { tokenId },
      query: { additionalProperties: false, properties: {} },
      headers: {},
      requestMediaType: null,
      requestBodySchema: null,
      maxBodyBytes: 0,
      allowsBody: false,
      streams: false,
      responses: { 200: { type: 'object', additionalProperties: false, required: ['schemaVersion', 'revoked'], properties: { schemaVersion: { const: '1.0.0' }, revoked: { type: 'boolean' } } } }
    },
    {
      method: 'GET',
      path: '/api/status',
      operationId: 'getProjectStatus',
      security: { authenticated: true, action: 'system.status.read' },
      pathParameters: {},
      query: { additionalProperties: false, properties: {} },
      headers: {},
      requestMediaType: null,
      requestBodySchema: null,
      maxBodyBytes: 0,
      allowsBody: false,
      streams: false,
      responses: { 200: { type: 'object', additionalProperties: true, required: ['schemaVersion', 'project', 'release', 'nextTask'], properties: { schemaVersion: { const: '1.0.0' }, project: boundedString(128), release: boundedString(64), nextTask: { type: ['string', 'null'], minLength: 1, maxLength: 32 } } } }
    },
    {
      method: 'GET',
      path: '/api/dashboard',
      operationId: 'getDashboard',
      security: { authenticated: true, action: 'dashboard.read', workspace: 'query' },
      pathParameters: {},
      query: { additionalProperties: false, properties: { workspaceId }, required: ['workspaceId'] },
      headers: {},
      requestMediaType: null,
      requestBodySchema: null,
      maxBodyBytes: 0,
      allowsBody: false,
      streams: false,
      responses: { 200: { type: 'object', additionalProperties: true, required: ['metrics', 'latestRun', 'latestManifest', 'runs'], properties: { metrics: { type: 'object', additionalProperties: true }, latestRun: { type: ['object', 'null'], additionalProperties: true }, latestManifest: { type: ['object', 'null'], additionalProperties: true }, runs: { type: 'array', maxItems: 100, items: { type: 'object', additionalProperties: true } } } } }
    },
    {
      method: 'GET',
      path: '/api/runs',
      operationId: 'listRuns',
      security: { authenticated: true, action: 'run.read', workspace: 'query' },
      pathParameters: {},
      query: { additionalProperties: false, properties: { workspaceId }, required: ['workspaceId'] },
      headers: {},
      requestMediaType: null,
      requestBodySchema: null,
      maxBodyBytes: 0,
      allowsBody: false,
      streams: false,
      responses: { 200: { type: 'object', additionalProperties: false, required: ['schemaVersion', 'items'], properties: { schemaVersion: { const: '1.0.0' }, items: { type: 'array', maxItems: 1000, items: run } } } }
    },
    {
      method: 'POST',
      path: '/api/runs',
      operationId: 'startRun',
      security: { authenticated: true, action: 'run.execute', workspace: 'body', csrf: true },
      pathParameters: {},
      query: { additionalProperties: false, properties: { workspaceId } },
      headers: { contentType: 'application/json' },
      requestMediaType: 'application/json',
      requestBodySchema: startRunRequest,
      maxBodyBytes: routeBodyBytes.startRun,
      allowsBody: true,
      bodyRequired: true,
      streams: false,
      responses: { 201: { type: 'object', additionalProperties: false, required: ['schemaVersion', 'run', 'events'], properties: { schemaVersion: { const: '1.0.0' }, run, events: { type: 'array', maxItems: 128, items: event } } } }
    },
    {
      method: 'GET',
      path: '/api/runs/{runId}',
      operationId: 'getRun',
      security: { authenticated: true, action: 'run.read', workspace: 'query', resourceLookup: true },
      pathParameters: { runId },
      query: { additionalProperties: false, properties: { workspaceId }, required: ['workspaceId'] },
      headers: {},
      requestMediaType: null,
      requestBodySchema: null,
      maxBodyBytes: 0,
      allowsBody: false,
      streams: false,
      responses: { 200: { type: 'object', additionalProperties: false, required: ['schemaVersion', 'run', 'events'], properties: { schemaVersion: { const: '1.0.0' }, run, events: { type: 'array', maxItems: 128, items: event } } } }
    },
    {
      method: 'POST',
      path: '/api/context/compile',
      operationId: 'compileContext',
      security: { authenticated: true, action: 'context.compile', workspace: 'contextRequest', csrf: true },
      pathParameters: {},
      query: { additionalProperties: false, properties: {} },
      headers: { contentType: 'application/json' },
      requestMediaType: 'application/json',
      requestBodySchema: contextCompileRequest,
      maxBodyBytes: routeBodyBytes.compileContext,
      allowsBody: true,
      bodyRequired: true,
      streams: false,
      responses: { 200: contextManifest }
    },
    {
      method: 'POST',
      path: '/api/context/pack',
      operationId: 'buildContextPack',
      security: { authenticated: true, action: 'context.compile', workspace: 'body', csrf: true },
      pathParameters: {},
      query: { additionalProperties: false, properties: {} },
      headers: { contentType: 'application/json' },
      requestMediaType: 'application/json',
      requestBodySchema: contextPackRequest,
      maxBodyBytes: routeBodyBytes.buildContextPack,
      allowsBody: true,
      bodyRequired: true,
      streams: false,
      responses: { 200: contextPackResponse }
    },
    {
      method: 'POST',
      path: '/api/context/graph/preview',
      operationId: 'previewContextGraph',
      security: { authenticated: true, action: 'context.compile', workspace: 'body', csrf: true },
      pathParameters: {},
      query: { additionalProperties: false, properties: {} },
      headers: { contentType: 'application/json' },
      requestMediaType: 'application/json',
      requestBodySchema: contextGraphPreviewRequest,
      maxBodyBytes: routeBodyBytes.previewContextGraph,
      allowsBody: true,
      bodyRequired: true,
      streams: false,
      responses: { 200: contextGraphPreviewResponse }
    },
    {
      method: 'POST',
      path: '/api/harness/setup/plan',
      operationId: 'planHarnessSetup',
      security: { authenticated: true, sessionOnly: true, action: 'workspace.read', workspace: 'body', csrf: true },
      pathParameters: {},
      query: { additionalProperties: false, properties: {} },
      headers: { contentType: 'application/json' },
      requestMediaType: 'application/json',
      requestBodySchema: harnessSetupPlanRequest,
      maxBodyBytes: routeBodyBytes.planHarnessSetup,
      allowsBody: true,
      bodyRequired: true,
      streams: false,
      responses: { 200: harnessSetupPlanResponse }
    },
    {
      method: 'POST',
      path: '/api/reset',
      operationId: 'resetBootstrap',
      security: { authenticated: true, action: 'workspace.reset', workspace: 'query', csrf: true },
      pathParameters: {},
      query: { additionalProperties: false, properties: { workspaceId }, required: ['workspaceId'] },
      headers: {},
      requestMediaType: null,
      requestBodySchema: null,
      maxBodyBytes: 0,
      allowsBody: false,
      streams: false,
      responses: { 200: { type: 'object', additionalProperties: false, required: ['schemaVersion', 'reset', 'time'], properties: { schemaVersion: { const: '1.0.0' }, reset: { const: true }, time: { type: 'string', format: 'date-time' } } } }
    },
    {
      method: 'GET',
      path: '/api/stream',
      operationId: 'streamEvents',
      security: { authenticated: true, action: 'stream.read', workspace: 'query' },
      pathParameters: {},
      query: { additionalProperties: false, properties: { workspaceId }, required: ['workspaceId'] },
      headers: {},
      requestMediaType: null,
      requestBodySchema: null,
      maxBodyBytes: 0,
      allowsBody: false,
      streams: true,
      responses: {}
    }
  ]);
}

export const API_ERROR_SCHEMA = errorEnvelope;
export const API_ROUTE_CONTRACTS = createApiRouteContracts();
