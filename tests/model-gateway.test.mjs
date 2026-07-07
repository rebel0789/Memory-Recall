import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LocalModelGateway,
  MODEL_GATEWAY_VERSION,
  createModelProviderRegistry,
  fingerprintModelValue,
  modelFromEnv
} from '../packages/model-gateway/src/index.mjs';

const fixedNow = '2026-06-20T00:00:00.000Z';

function manifestRef(overrides = {}) {
  return {
    id: 'ctx_oaf013_manifest',
    manifestFingerprint: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    assemblyFingerprint: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    compilerVersion: '0.2.0',
    assemblyPolicyVersion: '1.0.0',
    assemblyPolicyFingerprint: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    selectedCount: 3,
    excludedCount: 2,
    ...overrides
  };
}

function schema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['answer'],
    properties: {
      answer: { type: 'string', minLength: 1 }
    }
  };
}

function fakeProvider({ providerId = 'provider:native:model:fake', model = 'fake-local', outputs = [] } = {}) {
  const calls = [];
  return {
    calls,
    async health() {
      return { status: 'healthy', local: true };
    },
    async capabilities() {
      return ['model.generate.text', 'model.structured-output', 'model.local-loopback'];
    },
    profile() {
      return {
        schemaVersion: '1.0.0',
        providerId,
        model,
        locality: 'in-process',
        enabledByDefault: false,
        capabilities: {
          structuredOutput: true,
          jsonMode: true,
          toolUse: false,
          vision: false,
          network: false
        },
        limits: {
          maxInputBytes: 100000,
          maxOutputBytes: 100000,
          defaultTimeoutMs: 1000
        }
      };
    },
    async generate(request) {
      calls.push(request);
      return {
        schemaVersion: '1.0.0',
        provider: providerId,
        model,
        output: outputs.length ? outputs.shift() : { answer: 'ok' },
        usage: { inputTokens: 4, outputTokens: 2, durationMs: 1 }
      };
    }
  };
}

test('gateway requires persisted context manifest reference and emits safe model events', async () => {
  const provider = fakeProvider();
  const events = [];
  const gateway = new LocalModelGateway({
    providers: [provider],
    defaultProviderId: 'provider:native:model:fake',
    clock: () => fixedNow
  });

  const result = await gateway.generateStructured({
    requestId: 'modelreq_oaf013_safe',
    correlationId: 'req_oaf013_safe',
    workspaceId: 'ws_local',
    actorId: 'agent:researcher',
    objective: 'Summarize persisted context',
    prompt: 'Use local context only. Do not leak /Users/example/private or TOKEN_REDACTED.',
    contextManifest: manifestRef(),
    outputSchema: schema(),
    outputSchemaName: 'oaf.test.answer',
    outputSchemaVersion: '1.0.0',
    promptVersion: 'content-intelligence.generate-angles.v1'
  }, {
    emitEvent: async (type, payload) => events.push({ type, payload })
  });

  assert.equal(result.schemaVersion, '1.0.0');
  assert.equal(result.gatewayVersion, MODEL_GATEWAY_VERSION);
  assert.equal(result.provider, 'provider:native:model:fake');
  assert.equal(result.model, 'fake-local');
  assert.deepEqual(result.output, { answer: 'ok' });
  assert.equal(result.validation.valid, true);
  assert.equal(result.contextManifest.id, 'ctx_oaf013_manifest');
  assert.match(result.promptFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.match(result.outputSchemaFingerprint, /^sha256:[a-f0-9]{64}$/);

  assert.deepEqual(events.map((event) => event.type), ['model.requested', 'model.completed']);
  assert.equal(events[0].payload.contextManifest.id, 'ctx_oaf013_manifest');
  assert.equal(events[0].payload.promptFingerprint, result.promptFingerprint);
  assert.equal(events[1].payload.outputFingerprint, result.outputFingerprint);
  const serializedEvents = JSON.stringify(events);
  assert(!serializedEvents.includes('Use local context only'));
  assert(!serializedEvents.includes('/Users/example/private'));
  assert(!serializedEvents.includes('TOKEN_REDACTED'));
});

test('structured output repair is bounded to one call on the same provider and model', async () => {
  const provider = fakeProvider({ outputs: [{ nope: true }, JSON.stringify({ answer: 'repaired' })] });
  const gateway = new LocalModelGateway({
    providers: [provider],
    defaultProviderId: 'provider:native:model:fake',
    clock: () => fixedNow
  });

  const result = await gateway.generateStructured({
    requestId: 'modelreq_oaf013_repair',
    correlationId: 'req_oaf013_repair',
    workspaceId: 'ws_local',
    actorId: 'agent:researcher',
    objective: 'Return valid JSON',
    prompt: 'Return an answer object',
    contextManifest: manifestRef(),
    outputSchema: schema(),
    repair: { enabled: true, maxAttempts: 1 }
  });

  assert.deepEqual(result.output, { answer: 'repaired' });
  assert.equal(result.repair.attempts, 1);
  assert.equal(provider.calls.length, 2);
  assert.equal(provider.calls[0].providerId, provider.calls[1].providerId);
  assert.equal(provider.calls[0].model, provider.calls[1].model);
  assert.equal(provider.calls[1].repairOf.requestId, 'modelreq_oaf013_repair');
});

test('structured output repair stops after one failed repair', async () => {
  const provider = fakeProvider({ outputs: [{ nope: true }, { stillNope: true }, { answer: 'too late' }] });
  const gateway = new LocalModelGateway({
    providers: [provider],
    defaultProviderId: 'provider:native:model:fake',
    clock: () => fixedNow
  });

  await assert.rejects(
    gateway.generateStructured({
      requestId: 'modelreq_oaf013_repair_fail',
      correlationId: 'req_oaf013_repair_fail',
      workspaceId: 'ws_local',
      actorId: 'agent:researcher',
      objective: 'Return valid JSON',
      prompt: 'Return an answer object',
      contextManifest: manifestRef(),
      outputSchema: schema(),
      repair: { enabled: true, maxAttempts: 1 }
    }),
    (error) => error.code === 'model_output_schema_invalid' && error.repairAttempts === 1
  );
  assert.equal(provider.calls.length, 2);
});

test('provider request mutation cannot corrupt caller request or validation schema', async () => {
  const provider = fakeProvider();
  provider.generate = async (request) => {
    provider.calls.push(request);
    request.outputSchema.properties.answer.type = 'number';
    request.context.selected[0].text = 'mutated by provider';
    request.contextManifest.selectedCount = 999;
    return {
      schemaVersion: '1.0.0',
      provider: request.providerId,
      model: request.model,
      output: { answer: 'ok' },
      usage: { inputTokens: 4, outputTokens: 2, durationMs: 1 }
    };
  };
  const gateway = new LocalModelGateway({
    providers: [provider],
    defaultProviderId: 'provider:native:model:fake',
    clock: () => fixedNow
  });
  const request = {
    requestId: 'modelreq_oaf013_provider_mutation',
    correlationId: 'req_oaf013_provider_mutation',
    workspaceId: 'ws_local',
    actorId: 'agent:researcher',
    objective: 'Resist provider mutation',
    prompt: 'Return an answer object',
    contextManifest: manifestRef(),
    context: { selected: [{ id: 'obs_safe', kind: 'observation', text: 'original context' }] },
    outputSchema: schema()
  };
  const before = structuredClone(request);

  const result = await gateway.generateStructured(request);

  assert.deepEqual(result.output, { answer: 'ok' });
  assert.deepEqual(request, before);
  assert.equal(result.contextManifest.selectedCount, 3);
  assert.equal(provider.calls[0].outputSchema.properties.answer.type, 'number');
});

test('gateway timeout and cancellation reach the selected provider', async () => {
  let observedSignal = null;
  const provider = fakeProvider();
  provider.generate = async (request) => {
    observedSignal = request.signal;
    return new Promise((resolve, reject) => {
      request.signal.addEventListener('abort', () => {
        const error = new Error('provider observed abort');
        error.code = 'provider_aborted';
        reject(error);
      }, { once: true });
      setTimeout(() => resolve({ provider: request.providerId, model: request.model, output: { answer: 'late' } }), 100);
    });
  };
  const gateway = new LocalModelGateway({
    providers: [provider],
    defaultProviderId: 'provider:native:model:fake',
    clock: () => fixedNow
  });

  await assert.rejects(
    gateway.generateStructured({
      requestId: 'modelreq_oaf013_timeout',
      correlationId: 'req_oaf013_timeout',
      workspaceId: 'ws_local',
      actorId: 'agent:researcher',
      objective: 'Time out',
      prompt: 'Return slowly',
      contextManifest: manifestRef(),
      outputSchema: schema(),
      timeoutMs: 5
    }),
    (error) => error.code === 'model_timeout'
  );
  assert.equal(observedSignal?.aborted, true);
});

test('modelFromEnv keeps deterministic default and rejects hosted fallback', () => {
  assert.equal(modelFromEnv({}).profile().providerId, 'provider:native:model:deterministic');
  assert.throws(
    () => modelFromEnv({ OAF_MODEL_MODE: 'openai' }),
    /No cloud fallback occurred/
  );
  assert.throws(
    () => modelFromEnv({ OAF_MODEL_MODE: 'ollama', OAF_OLLAMA_MODEL: 'local' }),
    /explicit Ollama provider factory/
  );
});

test('model provider registry selects by capability without silent fallback', () => {
  const provider = fakeProvider();
  const registry = createModelProviderRegistry([provider]);
  assert.equal(registry.select({ requiredCapabilities: ['model.structured-output'] }).provider, provider);
  assert.throws(
    () => registry.select({ providerId: 'provider:native:model:missing' }),
    (error) => error.code === 'model_provider_unavailable'
  );
});

test('model fingerprints are stable and order independent', () => {
  assert.equal(fingerprintModelValue({ b: 2, a: 1 }), fingerprintModelValue({ a: 1, b: 2 }));
});
