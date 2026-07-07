import { nowIso } from '../../../../packages/protocol/src/index.mjs';
import { MODEL_GATEWAY_VERSION, MODEL_OUTPUT_SCHEMA_VERSION, PROMPT_ASSEMBLY_VERSION } from '../../../../packages/model-gateway/src/index.mjs';

const PROVIDER_ID = 'provider:native:model:ollama';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const MAX_MODEL_BYTES = 2_000_000;

function validateBaseUrl(value, allowNonLoopback) {
  const url = new URL(value);
  if (url.protocol !== 'http:') throw new Error('Ollama base URL must use http');
  if (!allowNonLoopback && !LOOPBACK_HOSTS.has(url.hostname)) throw new Error('Ollama base URL must be loopback unless allowNonLoopback is explicitly enabled');
  url.pathname = url.pathname.replace(/\/$/, '');
  return url;
}

function linkedSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs);
  let parentListener;
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort(parentSignal.reason);
    else {
      parentListener = () => controller.abort(parentSignal.reason);
      parentSignal.addEventListener('abort', parentListener, { once: true });
    }
  }
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      if (parentListener) parentSignal.removeEventListener('abort', parentListener);
    }
  };
}

async function withTimeout(fetchImpl, url, options, timeoutMs, parentSignal = null) {
  const linked = linkedSignal(parentSignal, timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: linked.signal });
  } finally {
    linked.dispose();
  }
}

function outputTooLarge(operation) {
  const error = new Error(`${operation} exceeds 2 MB`);
  error.code = 'model_output_too_large';
  return error;
}

function safeString(value, maxLength = 160) {
  return typeof value === 'string' && value.trim() ? value.slice(0, maxLength) : null;
}

function safeOllamaModelMetadata(model) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) return null;
  const details = model.details && typeof model.details === 'object' && !Array.isArray(model.details) ? model.details : {};
  return {
    name: safeString(model.name),
    digest: safeString(model.digest, 256),
    sizeBytes: Number.isFinite(model.size) ? model.size : null,
    modifiedAt: safeString(model.modified_at),
    format: safeString(details.format),
    family: safeString(details.family),
    families: Array.isArray(details.families) ? details.families.map((item) => safeString(item)).filter(Boolean).slice(0, 16) : [],
    parameterSize: safeString(details.parameter_size),
    quantizationLevel: safeString(details.quantization_level)
  };
}

async function readResponseText(response, operation, maxBytes = MAX_MODEL_BYTES) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw outputTooLarge(operation);
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => {});
      throw outputTooLarge(operation);
    }
    text += decoder.decode(value, { stream: true });
  }
  return `${text}${decoder.decode()}`;
}

async function readJsonResponse(response, operation) {
  const text = await readResponseText(response, operation);
  let value;
  try { value = text ? JSON.parse(text) : {}; } catch { throw new Error(`${operation} returned invalid JSON`); }
  if (!response.ok) {
    const error = new Error(`${operation} failed with HTTP ${response.status}`);
    error.code = 'model_provider_error';
    error.details = { status: response.status, message: typeof value.error === 'string' ? value.error : undefined };
    throw error;
  }
  return value;
}

export class OllamaModelProvider {
  constructor({ baseUrl = 'http://127.0.0.1:11434', model, fetchImpl = globalThis.fetch, timeoutMs = 120000, allowNonLoopback = false, clock = nowIso } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');
    if (typeof model !== 'string' || !model.trim()) throw new Error('an explicit Ollama model is required');
    this.baseUrl = validateBaseUrl(baseUrl, allowNonLoopback);
    this.model = model;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.clock = clock;
  }

  async health() {
    try {
      const response = await withTimeout(this.fetchImpl, new URL('/api/tags', this.baseUrl), { method: 'GET', headers: { accept: 'application/json' } }, Math.min(this.timeoutMs, 5000));
      const value = await readJsonResponse(response, 'Ollama health check');
      const installed = Array.isArray(value.models) ? value.models : [];
      const selected = installed.find((item) => item?.name === this.model) ?? null;
      return {
        status: selected ? 'healthy' : 'degraded',
        local: true,
        details: {
          provider: PROVIDER_ID,
          model: this.model,
          modelAvailable: Boolean(selected),
          installedModels: installed.filter((item) => typeof item?.name === 'string' && item.name).length,
          modelMetadata: safeOllamaModelMetadata(selected)
        }
      };
    } catch (error) {
      return { status: 'unavailable', local: true, details: { provider: PROVIDER_ID, model: this.model, error: error.code ?? 'ollama_unavailable' } };
    }
  }

  async capabilities() {
    return ['model.generate.text', 'model.structured-output', 'model.local-loopback', 'model.local-metadata', 'model.safe-events', 'model.bounded-repair'];
  }

  profile() {
    return {
      schemaVersion: '1.0.0',
      providerId: PROVIDER_ID,
      model: this.model,
      locality: 'loopback-process',
      enabledByDefault: false,
      capabilities: {
        structuredOutput: true,
        jsonMode: true,
        toolUse: false,
        vision: false,
        network: false,
        safeEvents: true,
        boundedRepair: true
      },
      capabilityIds: ['model.generate.text', 'model.structured-output', 'model.local-loopback', 'model.local-metadata', 'model.safe-events', 'model.bounded-repair'],
      limits: {
        maxInputBytes: MAX_MODEL_BYTES,
        maxOutputBytes: MAX_MODEL_BYTES,
        defaultTimeoutMs: this.timeoutMs,
        baseUrlPolicy: 'loopback-http-only',
        silentFallback: false
      },
      versions: {
        gateway: MODEL_GATEWAY_VERSION,
        prompt: PROMPT_ASSEMBLY_VERSION,
        outputSchema: MODEL_OUTPUT_SCHEMA_VERSION
      }
    };
  }

  async generate({ prompt, system = null, format = null, options = {}, metadata = {}, signal = null }) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt is required');
    if (Buffer.byteLength(prompt, 'utf8') > MAX_MODEL_BYTES) throw new Error('prompt exceeds 2 MB');
    const body = {
      model: this.model,
      prompt,
      stream: false,
      options: options && typeof options === 'object' && !Array.isArray(options) ? options : {}
    };
    if (system) body.system = String(system);
    if (format) body.format = format;
    const startedAt = this.clock();
    const response = await withTimeout(this.fetchImpl, new URL('/api/generate', this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body)
    }, this.timeoutMs, signal);
    const value = await readJsonResponse(response, 'Ollama generation');
    if (typeof value.response !== 'string') throw new Error('Ollama generation response is missing text');
    if (Buffer.byteLength(value.response, 'utf8') > MAX_MODEL_BYTES) throw outputTooLarge('Ollama generation output');
    return {
      schemaVersion: '1.0.0',
      provider: PROVIDER_ID,
      model: this.model,
      output: value.response,
      done: value.done === true,
      startedAt,
      completedAt: this.clock(),
      usage: {
        inputTokens: Number.isFinite(value.prompt_eval_count) ? value.prompt_eval_count : null,
        outputTokens: Number.isFinite(value.eval_count) ? value.eval_count : null,
        durationNs: Number.isFinite(value.total_duration) ? value.total_duration : null
      },
      metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}
    };
  }
}

export { PROVIDER_ID as OLLAMA_MODEL_PROVIDER_ID };
