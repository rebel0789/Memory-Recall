import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { LocalModelGateway } from '../packages/model-gateway/src/index.mjs';
import { OllamaModelProvider } from '../providers/native/model-ollama/src/index.mjs';

const fixedNow = '2026-06-20T00:00:00.000Z';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function requestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

test('loopback Ollama provider integrates through the local model gateway without fallback', async () => {
  const seen = [];
  const server = http.createServer(async (request, response) => {
    seen.push({ method: request.method, url: request.url });
    if (request.url === '/api/tags') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ models: [{ name: 'oaf-local-test' }] }));
      return;
    }
    if (request.url === '/api/generate') {
      const body = JSON.parse(await requestBody(request));
      assert.equal(body.model, 'oaf-local-test');
      assert.equal(body.stream, false);
      assert.equal(body.format, 'json');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        response: JSON.stringify({ answer: 'from loopback ollama' }),
        done: true,
        prompt_eval_count: 11,
        eval_count: 5,
        total_duration: 1000
      }));
      return;
    }
    response.writeHead(404);
    response.end();
  });

  const address = await listen(server);
  try {
    const provider = new OllamaModelProvider({
      baseUrl: `http://127.0.0.1:${address.port}`,
      model: 'oaf-local-test',
      timeoutMs: 1000,
      clock: () => fixedNow
    });
    const gateway = new LocalModelGateway({
      providers: [provider],
      defaultProviderId: 'provider:native:model:ollama',
      clock: () => fixedNow
    });

    const health = await provider.health();
    assert.equal(health.status, 'healthy');

    const result = await gateway.generateStructured({
      requestId: 'modelreq_oaf013_ollama',
      correlationId: 'req_oaf013_ollama',
      workspaceId: 'ws_local',
      actorId: 'agent:researcher',
      objective: 'Exercise loopback Ollama',
      prompt: 'Return a JSON object with an answer field.',
      providerId: 'provider:native:model:ollama',
      model: 'oaf-local-test',
      contextManifest: {
        id: 'ctx_oaf013_ollama',
        manifestFingerprint: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        assemblyFingerprint: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        compilerVersion: '0.2.0',
        assemblyPolicyVersion: '1.0.0',
        assemblyPolicyFingerprint: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        selectedCount: 1,
        excludedCount: 0
      },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['answer'],
        properties: {
          answer: { type: 'string' }
        }
      },
      repair: { enabled: true, maxAttempts: 1 }
    });

    assert.equal(result.provider, 'provider:native:model:ollama');
    assert.equal(result.model, 'oaf-local-test');
    assert.deepEqual(result.output, { answer: 'from loopback ollama' });
    assert.equal(result.validation.valid, true);
    assert.equal(result.repair.attempts, 0);
    assert.deepEqual(seen.map((item) => item.url), ['/api/tags', '/api/generate']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
