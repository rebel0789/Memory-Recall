import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelGatewayPort, runProviderSmokeConformance } from '../packages/adapter-contracts/src/index.mjs';
import { OllamaModelProvider } from '../providers/native/model-ollama/src/index.mjs';

test('Ollama provider is loopback-only and never silently falls back', async () => {
  assert.throws(() => new OllamaModelProvider({ baseUrl: 'https://example.com', model: 'local-model' }), /must use http/);
  assert.throws(() => new OllamaModelProvider({ baseUrl: 'http://192.0.2.10:11434', model: 'local-model' }), /loopback/);
});

test('Ollama provider reports health and normalizes generation', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{
      name: 'qwen-local',
      digest: 'sha256:abc123',
      size: 2147483648,
      modified_at: '2026-06-19T09:59:00.000Z',
      details: {
        format: 'gguf',
        family: 'qwen2',
        families: ['qwen2'],
        parameter_size: '7B',
        quantization_level: 'Q4_K_M'
      }
    }] }), { status: 200 });
    return new Response(JSON.stringify({ response: '{"answer":"local"}', done: true, prompt_eval_count: 8, eval_count: 4, total_duration: 42 }), { status: 200 });
  };
  const provider = new OllamaModelProvider({ model: 'qwen-local', fetchImpl, clock: () => '2026-06-19T10:00:00.000Z' });
  const conformance = await runProviderSmokeConformance({ provider, PortClass: ModelGatewayPort, providerId: 'provider:native:model:ollama', expectedCapabilities: ['model.local-loopback', 'model.local-metadata'] });
  assert.equal(conformance.health.status, 'healthy');
  assert.deepEqual(conformance.health.details.modelMetadata, {
    name: 'qwen-local',
    digest: 'sha256:abc123',
    sizeBytes: 2147483648,
    modifiedAt: '2026-06-19T09:59:00.000Z',
    format: 'gguf',
    family: 'qwen2',
    families: ['qwen2'],
    parameterSize: '7B',
    quantizationLevel: 'Q4_K_M'
  });
  const result = await provider.generate({ prompt: 'Return JSON', format: 'json' });
  assert.equal(result.provider, 'provider:native:model:ollama');
  assert.equal(result.output, '{"answer":"local"}');
  assert.equal(result.usage.inputTokens, 8);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.url.startsWith('http://127.0.0.1:11434/')));
});

test('Ollama provider enforces advertised output limit', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ response: 'x'.repeat(2_000_001), done: true }), { status: 200 });
  const provider = new OllamaModelProvider({ model: 'qwen-local', fetchImpl });
  await assert.rejects(
    provider.generate({ prompt: 'Return too much' }),
    (error) => error.code === 'model_output_too_large'
  );
});

test('Ollama health failure remains local and unavailable', async () => {
  const provider = new OllamaModelProvider({ model: 'missing', fetchImpl: async () => { throw new Error('connection refused'); } });
  const health = await provider.health();
  assert.equal(health.status, 'unavailable');
  assert.equal(health.local, true);
});
