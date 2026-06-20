import { createHash } from 'node:crypto';
import { assertJsonSchema } from '../../protocol/src/schema-validator.mjs';

export const MODEL_GATEWAY_VERSION = '1.0.0';
export const PROMPT_ASSEMBLY_VERSION = '1.0.0';
export const MODEL_OUTPUT_SCHEMA_VERSION = '1.0.0';
export const DETERMINISTIC_MODEL_PROVIDER_ID = 'provider:native:model:deterministic';

const templates = [
  { angle: 'Turn one agent failure into a checklist people can reuse', hook: 'The polished demo was not the useful part. The recovery checklist was.', evidenceTerms: ['failed tool', 'retries', 'recovery', 'checklist', 'reproducing', 'most saved'], confidence: .82 },
  { angle: 'The strongest agent story may be the most boring workflow', hook: 'Agents become understandable when they automate one repetitive job end to end.', evidenceTerms: ['boring', 'workflow', 'support triage', 'inbox', 'local-first', 'on-device'], confidence: .79 },
  { angle: 'Show the failed tool calls—not just the polished agent demo', hook: 'A trustworthy agent demo should show what it refused, retried, and excluded.', evidenceTerms: ['timeline', 'debugging', 'selected context', 'policy decision', 'failed step', 'denied permissions'], confidence: .77 }
];

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function fingerprintModelValue(value) {
  return `sha256:${createHash('sha256').update(typeof value === 'string' ? value : stableStringify(value)).digest('hex')}`;
}

function gatewayError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function jsonBytes(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value ?? null), 'utf8');
}

function assertNonEmptyString(value, name, maxBytes = 4096) {
  if (typeof value !== 'string' || !value.trim()) throw gatewayError('model_request_invalid', `${name} is required`);
  if (Buffer.byteLength(value, 'utf8') > maxBytes) throw gatewayError('model_request_too_large', `${name} exceeds ${maxBytes} bytes`);
  return value;
}

function normalizeContextManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw gatewayError('model_context_manifest_required', 'persisted context manifest reference is required');
  const ref = {
    id: assertNonEmptyString(value.id, 'contextManifest.id', 160),
    manifestFingerprint: assertNonEmptyString(value.manifestFingerprint, 'contextManifest.manifestFingerprint', 80),
    assemblyFingerprint: assertNonEmptyString(value.assemblyFingerprint, 'contextManifest.assemblyFingerprint', 80),
    compilerVersion: assertNonEmptyString(value.compilerVersion, 'contextManifest.compilerVersion', 64),
    assemblyPolicyVersion: assertNonEmptyString(value.assemblyPolicyVersion, 'contextManifest.assemblyPolicyVersion', 64),
    assemblyPolicyFingerprint: assertNonEmptyString(value.assemblyPolicyFingerprint, 'contextManifest.assemblyPolicyFingerprint', 80),
    selectedCount: Number.isInteger(value.selectedCount) ? value.selectedCount : null,
    excludedCount: Number.isInteger(value.excludedCount) ? value.excludedCount : null
  };
  for (const key of ['manifestFingerprint', 'assemblyFingerprint', 'assemblyPolicyFingerprint']) {
    if (!/^sha256:[a-f0-9]{64}$/.test(ref[key])) throw gatewayError('model_context_manifest_invalid', `${key} must be a sha256 fingerprint`);
  }
  return ref;
}

function deriveCapabilityIds(profile) {
  const ids = new Set(profile.capabilityIds ?? []);
  const capabilities = profile.capabilities ?? {};
  if (capabilities.structuredOutput) ids.add('model.structured-output');
  if (capabilities.jsonMode) ids.add('model.json-mode');
  if (capabilities.toolUse) ids.add('model.tool-use');
  if (capabilities.vision) ids.add('model.vision');
  if (capabilities.network) ids.add('model.network');
  if (profile.locality === 'loopback-process') ids.add('model.local-loopback');
  return [...ids].sort();
}

function normalizeProviderProfile(provider) {
  if (!provider || typeof provider !== 'object') throw gatewayError('model_provider_invalid', 'model provider must be an object');
  if (typeof provider.profile !== 'function' || typeof provider.generate !== 'function') {
    throw gatewayError('model_provider_invalid', 'model provider must implement profile and generate');
  }
  const profile = provider.profile();
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw gatewayError('model_provider_invalid', 'model provider profile must be an object');
  assertNonEmptyString(profile.providerId, 'providerId', 160);
  assertNonEmptyString(profile.model, 'model', 160);
  if (!['in-process', 'loopback-process'].includes(profile.locality)) throw gatewayError('model_provider_invalid', 'unsupported provider locality');
  return Object.freeze({
    schemaVersion: '1.0.0',
    enabledByDefault: false,
    ...profile,
    capabilityIds: deriveCapabilityIds(profile)
  });
}

export function createModelProviderRegistry(providers = []) {
  if (!Array.isArray(providers) || !providers.length) throw gatewayError('model_provider_unavailable', 'at least one model provider is required');
  const entries = providers.map((provider) => ({ provider, profile: normalizeProviderProfile(provider) }));
  const byProvider = new Map();
  for (const entry of entries) {
    if (byProvider.has(entry.profile.providerId)) throw gatewayError('model_provider_invalid', `duplicate model provider ${entry.profile.providerId}`);
    byProvider.set(entry.profile.providerId, entry);
  }
  return Object.freeze({
    list() {
      return entries.map((entry) => entry.profile);
    },
    get(providerId) {
      return byProvider.get(providerId)?.provider ?? null;
    },
    select({ providerId = null, model = null, requiredCapabilities = [] } = {}) {
      const candidates = providerId ? [byProvider.get(providerId)].filter(Boolean) : entries;
      if (!candidates.length) throw gatewayError('model_provider_unavailable', `model provider ${providerId} is unavailable`);
      const selected = candidates.find((entry) => {
        if (model && entry.profile.model !== model) return false;
        return requiredCapabilities.every((capability) => entry.profile.capabilityIds.includes(capability));
      });
      if (!selected) throw gatewayError('model_provider_unavailable', 'no model provider satisfies the requested model capabilities');
      return selected;
    }
  });
}

function evidenceScore(item, terms) {
  const text = String(item.text ?? '').toLowerCase();
  return terms.reduce((score, term) => score + (text.includes(term) ? 1 : 0), 0) + (Number(item.score) || 0) / 100;
}

function selectEvidence(evidence, terms, count = 2) {
  return [...evidence]
    .sort((a, b) => evidenceScore(b, terms) - evidenceScore(a, terms) || a.id.localeCompare(b.id))
    .slice(0, count)
    .map((item) => item.id);
}

function deterministicRecommendations({ objective, context }) {
  const evidence = (context?.selected ?? []).filter((item) => item.kind === 'observation');
  if (evidence.length < 2) {
    const error = new Error('At least two selected observations are required for deterministic recommendations');
    error.code = 'model_context_insufficient';
    throw error;
  }
  return templates.map((template, index) => ({
    rank: index + 1,
    angle: template.angle,
    hook: template.hook,
    targetReader: 'builders shipping reliable local agents',
    whyNow: objective,
    evidenceIds: selectEvidence(evidence, template.evidenceTerms),
    proofNeeded: 'A concrete run trace or workflow result',
    copyingRisk: 'low: mechanism only',
    confidence: template.confidence,
    uncertainty: 'Synthetic fixtures and deterministic generation; validate with real evidence before publication.'
  }));
}

export class DeterministicModel {
  constructor({ model = 'deterministic-v1', clock = () => new Date().toISOString() } = {}) {
    this.name = model;
    this.model = model;
    this.clock = clock;
  }

  profile() {
    return {
      schemaVersion: '1.0.0',
      providerId: DETERMINISTIC_MODEL_PROVIDER_ID,
      model: this.model,
      locality: 'in-process',
      enabledByDefault: true,
      capabilities: {
        structuredOutput: true,
        jsonMode: true,
        toolUse: false,
        vision: false,
        network: false,
        deterministic: true,
        safeEvents: true,
        boundedRepair: true
      },
      capabilityIds: ['model.generate.synthetic', 'model.structured-output', 'model.deterministic', 'model.safe-events', 'model.bounded-repair'],
      limits: {
        maxInputBytes: 256000,
        maxOutputBytes: 256000,
        defaultTimeoutMs: 5000
      },
      versions: {
        gateway: MODEL_GATEWAY_VERSION,
        prompt: PROMPT_ASSEMBLY_VERSION,
        outputSchema: MODEL_OUTPUT_SCHEMA_VERSION
      }
    };
  }

  async health() {
    return { status: 'healthy', local: true, details: { provider: DETERMINISTIC_MODEL_PROVIDER_ID, deterministic: true } };
  }

  async capabilities() {
    return ['model.generate.synthetic', 'model.structured-output', 'model.deterministic', 'model.safe-events', 'model.bounded-repair'];
  }

  async generate(request = {}) {
    const objective = request.objective;
    const context = request.context;
    const output = deterministicRecommendations({ objective, context });
    return {
      schemaVersion: '1.0.0',
      provider: DETERMINISTIC_MODEL_PROVIDER_ID,
      model: this.model,
      output,
      usage: {
        inputTokens: context?.budget?.used ?? null,
        outputTokens: Math.ceil(JSON.stringify(output).length / 4),
        durationMs: 0
      },
      completedAt: this.clock()
    };
  }
}

function normalizeStructuredOutput(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    const parseError = gatewayError('model_output_json_invalid', 'model output is not valid JSON');
    parseError.cause = error;
    throw parseError;
  }
}

function schemaValidation(outputSchema, output) {
  try {
    assertJsonSchema(outputSchema, output, 'model output');
    return { valid: true, errorCode: null, errors: [] };
  } catch (error) {
    return { valid: false, errorCode: error.code ?? 'schema_validation_failed', errors: error.errors ?? [] };
  }
}

async function callProviderWithTimeout(provider, request, { timeoutMs, parentSignal }) {
  const controller = new AbortController();
  let timer;
  let parentListener;
  let timedOut = false;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      const error = gatewayError('model_timeout', `model request timed out after ${timeoutMs}ms`, { retryable: true });
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  const cancellation = parentSignal
    ? new Promise((_, reject) => {
        parentListener = () => {
          const error = gatewayError('model_cancelled', 'model request cancelled', { retryable: false });
          controller.abort(error);
          reject(error);
        };
        parentSignal.addEventListener('abort', parentListener, { once: true });
      })
    : new Promise(() => {});
  try {
    if (parentSignal?.aborted) throw gatewayError('model_cancelled', 'model request cancelled', { retryable: false });
    return await Promise.race([
      provider.generate({ ...request, signal: controller.signal }),
      timeout,
      cancellation
    ]);
  } catch (error) {
    if (timedOut) throw gatewayError('model_timeout', `model request timed out after ${timeoutMs}ms`, { retryable: true });
    throw error;
  } finally {
    clearTimeout(timer);
    if (parentListener) parentSignal.removeEventListener('abort', parentListener);
  }
}

function safeRequestPayload({ request, profile, promptFingerprint, outputSchemaFingerprint, outputSchemaName, outputSchemaVersion, contextManifest, timeoutMs, repairLimit }) {
  return {
    schemaVersion: '1.0.0',
    gatewayVersion: MODEL_GATEWAY_VERSION,
    requestId: request.requestId,
    correlationId: request.correlationId,
    workspaceId: request.workspaceId,
    provider: profile.providerId,
    model: profile.model,
    promptFingerprint,
    outputSchemaFingerprint,
    prompt: {
      version: request.promptVersion ?? PROMPT_ASSEMBLY_VERSION,
      fingerprint: promptFingerprint,
      assemblyVersion: PROMPT_ASSEMBLY_VERSION,
      byteLength: jsonBytes(request.prompt)
    },
    outputSchema: {
      name: outputSchemaName,
      version: outputSchemaVersion,
      fingerprint: outputSchemaFingerprint
    },
    contextManifest,
    timeoutMs,
    repair: { maxAttempts: repairLimit },
    occurredAt: null
  };
}

function safeCompletedPayload({ request, result, validation, repairAttempts, outputFingerprint }) {
  return {
    schemaVersion: '1.0.0',
    gatewayVersion: MODEL_GATEWAY_VERSION,
    requestId: request.requestId,
    correlationId: request.correlationId,
    provider: result.provider,
    model: result.model,
    contextManifest: result.contextManifest,
    outputFingerprint,
    validation: { valid: validation.valid, errorCode: validation.errorCode },
    repair: { attempts: repairAttempts },
    usage: result.usage,
    occurredAt: null
  };
}

function safeFailedPayload({ request, profile, contextManifest, error, repairAttempts = 0 }) {
  return {
    schemaVersion: '1.0.0',
    gatewayVersion: MODEL_GATEWAY_VERSION,
    requestId: request.requestId,
    correlationId: request.correlationId,
    provider: profile?.providerId ?? request.providerId ?? null,
    model: profile?.model ?? request.model ?? null,
    contextManifest,
    error: { code: error.code ?? 'model_generation_failed', retryable: error.retryable === true },
    repair: { attempts: repairAttempts }
  };
}

function normalizeUsage(value = {}) {
  return {
    inputTokens: Number.isFinite(value.inputTokens) ? value.inputTokens : Number.isFinite(value.inputEstimated) ? value.inputEstimated : null,
    outputTokens: Number.isFinite(value.outputTokens) ? value.outputTokens : Number.isFinite(value.outputEstimated) ? value.outputEstimated : null,
    durationMs: Number.isFinite(value.durationMs) ? value.durationMs : Number.isFinite(value.durationNs) ? Math.round(value.durationNs / 1_000_000) : null
  };
}

export class LocalModelGateway {
  constructor({ providers, defaultProviderId = null, clock = () => new Date().toISOString() } = {}) {
    this.registry = createModelProviderRegistry(providers);
    this.defaultProviderId = defaultProviderId;
    this.clock = clock;
  }

  profile() {
    return this.registry.select({ providerId: this.defaultProviderId }).profile;
  }

  async health() {
    const profiles = this.registry.list();
    return {
      status: profiles.length ? 'healthy' : 'unavailable',
      local: true,
      details: { gatewayVersion: MODEL_GATEWAY_VERSION, providers: profiles.map((profile) => profile.providerId) }
    };
  }

  async capabilities() {
    return [...new Set(this.registry.list().flatMap((profile) => profile.capabilityIds))].sort();
  }

  async generate(request, options = {}) {
    return this.generateStructured(request, options);
  }

  async generateStructured(request = {}, { emitEvent = async () => {}, signal = null } = {}) {
    assertNonEmptyString(request.requestId, 'requestId', 160);
    assertNonEmptyString(request.correlationId, 'correlationId', 160);
    assertNonEmptyString(request.workspaceId, 'workspaceId', 160);
    assertNonEmptyString(request.actorId, 'actorId', 160);
    assertNonEmptyString(request.objective, 'objective', 4096);
    assertNonEmptyString(request.prompt, 'prompt', 1_000_000);
    if (!request.outputSchema || typeof request.outputSchema !== 'object' || Array.isArray(request.outputSchema)) {
      throw gatewayError('model_output_schema_required', 'outputSchema is required');
    }
    const contextManifest = normalizeContextManifest(request.contextManifest);
    const selected = this.registry.select({
      providerId: request.providerId ?? this.defaultProviderId,
      model: request.model ?? null,
      requiredCapabilities: ['model.structured-output']
    });
    const { provider, profile } = selected;
    const timeoutMs = Math.max(1, Math.min(Number(request.timeoutMs ?? profile.limits?.defaultTimeoutMs ?? 30000), 300000));
    const repairLimit = Math.min(1, Math.max(0, Number(request.repair?.enabled === false ? 0 : request.repair?.maxAttempts ?? 1)));
    const promptFingerprint = fingerprintModelValue({
      prompt: request.prompt,
      promptVersion: request.promptVersion ?? PROMPT_ASSEMBLY_VERSION,
      contextManifest
    });
    const outputSchemaFingerprint = fingerprintModelValue(request.outputSchema);
    const outputSchemaName = request.outputSchemaName ?? 'anonymous';
    const outputSchemaVersion = request.outputSchemaVersion ?? MODEL_OUTPUT_SCHEMA_VERSION;
    const requestedPayload = safeRequestPayload({
      request,
      profile,
      promptFingerprint,
      outputSchemaFingerprint,
      outputSchemaName,
      outputSchemaVersion,
      contextManifest,
      timeoutMs,
      repairLimit
    });
    requestedPayload.occurredAt = this.clock();
    await emitEvent('model.requested', requestedPayload);

    let repairAttempts = 0;
    try {
      const baseProviderRequest = {
        schemaVersion: '1.0.0',
        gatewayVersion: MODEL_GATEWAY_VERSION,
        requestId: request.requestId,
        correlationId: request.correlationId,
        workspaceId: request.workspaceId,
        actorId: request.actorId,
        objective: request.objective,
        providerId: profile.providerId,
        model: profile.model,
        prompt: request.prompt,
        promptVersion: request.promptVersion ?? PROMPT_ASSEMBLY_VERSION,
        promptFingerprint,
        contextManifest,
        context: request.context ?? null,
        outputSchema: request.outputSchema,
        outputSchemaFingerprint,
        outputSchemaName,
        outputSchemaVersion,
        format: 'json',
        metadata: {
          gatewayVersion: MODEL_GATEWAY_VERSION,
          promptAssemblyVersion: PROMPT_ASSEMBLY_VERSION,
          outputSchemaVersion
        }
      };
      let providerResult = await callProviderWithTimeout(provider, baseProviderRequest, { timeoutMs, parentSignal: signal });
      let output;
      let validation;
      try {
        output = normalizeStructuredOutput(providerResult.output);
        validation = schemaValidation(request.outputSchema, output);
      } catch (error) {
        validation = { valid: false, errorCode: error.code ?? 'model_output_invalid', errors: [] };
      }

      if (!validation.valid && repairLimit > 0) {
        repairAttempts = 1;
        const repairRequest = {
          ...baseProviderRequest,
          requestId: `${request.requestId}_repair1`,
          prompt: [
            request.prompt,
            '',
            'Return only JSON that validates against the provided output schema.',
            `Output schema fingerprint: ${outputSchemaFingerprint}.`
          ].join('\n'),
          repairOf: {
            requestId: request.requestId,
            providerId: profile.providerId,
            model: profile.model,
            outputFingerprint: fingerprintModelValue(providerResult.output ?? null),
            validationErrorCode: validation.errorCode
          }
        };
        providerResult = await callProviderWithTimeout(provider, repairRequest, { timeoutMs, parentSignal: signal });
        try {
          output = normalizeStructuredOutput(providerResult.output);
          validation = schemaValidation(request.outputSchema, output);
        } catch (error) {
          validation = { valid: false, errorCode: error.code ?? 'model_output_invalid', errors: [] };
        }
      }

      if (!validation.valid) {
        throw gatewayError('model_output_schema_invalid', 'model output failed schema validation', { validation, repairAttempts, retryable: false });
      }

      const outputFingerprint = fingerprintModelValue(output);
      const result = {
        schemaVersion: '1.0.0',
        gatewayVersion: MODEL_GATEWAY_VERSION,
        provider: providerResult.provider ?? profile.providerId,
        model: providerResult.model ?? profile.model,
        requestId: request.requestId,
        correlationId: request.correlationId,
        workspaceId: request.workspaceId,
        promptFingerprint,
        promptVersion: request.promptVersion ?? PROMPT_ASSEMBLY_VERSION,
        outputSchema: {
          name: outputSchemaName,
          version: outputSchemaVersion,
          fingerprint: outputSchemaFingerprint
        },
        outputSchemaFingerprint,
        contextManifest,
        output,
        outputFingerprint,
        validation,
        repair: { attempts: repairAttempts, maxAttempts: repairLimit },
        usage: normalizeUsage(providerResult.usage),
        versions: {
          gateway: MODEL_GATEWAY_VERSION,
          promptAssembly: PROMPT_ASSEMBLY_VERSION,
          outputSchema: outputSchemaVersion,
          contextCompiler: contextManifest.compilerVersion,
          contextAssemblyPolicy: contextManifest.assemblyPolicyVersion
        },
        completedAt: this.clock()
      };
      const completedPayload = safeCompletedPayload({ request, result, validation, repairAttempts, outputFingerprint });
      completedPayload.occurredAt = result.completedAt;
      await emitEvent('model.completed', completedPayload);
      return result;
    } catch (error) {
      await emitEvent('model.failed', safeFailedPayload({ request, profile, contextManifest, error, repairAttempts }));
      if (error.code) throw error;
      throw gatewayError('model_generation_failed', 'model generation failed', { cause: error, retryable: error.retryable === true });
    }
  }
}

export function modelFromEnv(env = process.env, { ollamaProviderFactory = null, clock = () => new Date().toISOString() } = {}) {
  const mode = env.OAF_MODEL_MODE ?? 'deterministic';
  if (mode === 'deterministic') {
    return new LocalModelGateway({
      providers: [new DeterministicModel({ clock })],
      defaultProviderId: DETERMINISTIC_MODEL_PROVIDER_ID,
      clock
    });
  }
  if (mode === 'ollama') {
    if (typeof ollamaProviderFactory !== 'function') {
      throw new Error('Ollama mode requires an explicit Ollama provider factory. No cloud fallback occurred.');
    }
    const provider = ollamaProviderFactory({ env, clock });
    return new LocalModelGateway({
      providers: [provider],
      defaultProviderId: 'provider:native:model:ollama',
      clock
    });
  }
  throw new Error(`Model mode ${mode} is specified but not implemented in the bootstrap. No cloud fallback occurred.`);
}
