import { nowIso } from '../../../../packages/protocol/src/index.mjs';

const PROVIDER_ID = 'provider:native:model:ollama';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function validateBaseUrl(value, allowNonLoopback) {
  const url = new URL(value);
  if (url.protocol !== 'http:') throw new Error('Ollama base URL must use http');
  if (!allowNonLoopback && !LOOPBACK_HOSTS.has(url.hostname)) throw new Error('Ollama base URL must be loopback unless allowNonLoopback is explicitly enabled');
  url.pathname = url.pathname.replace(/\/$/, '');
  return url;
}

async function withTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonResponse(response, operation) {
  const text = await response.text();
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
      const models = Array.isArray(value.models) ? value.models.map((item) => item.name).filter(Boolean) : [];
      return { status: models.includes(this.model) ? 'healthy' : 'degraded', local: true, details: { provider: PROVIDER_ID, model: this.model, modelAvailable: models.includes(this.model), installedModels: models.length } };
    } catch (error) {
      return { status: 'unavailable', local: true, details: { provider: PROVIDER_ID, model: this.model, error: error.code ?? 'ollama_unavailable' } };
    }
  }

  async capabilities() {
    return ['model.generate.text', 'model.structured-output', 'model.local-loopback'];
  }

  async generate({ prompt, system = null, format = null, options = {}, metadata = {} }) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt is required');
    if (Buffer.byteLength(prompt, 'utf8') > 2_000_000) throw new Error('prompt exceeds 2 MB');
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
    }, this.timeoutMs);
    const value = await readJsonResponse(response, 'Ollama generation');
    if (typeof value.response !== 'string') throw new Error('Ollama generation response is missing text');
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
