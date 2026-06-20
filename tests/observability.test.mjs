import test from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemorySpanExporter,
  OtlpHttpJsonExporter,
  createTelemetry,
  createTraceContext,
  modelSpanAttributes,
  routeSpanAttributes,
  sanitizeAttributes
} from '../packages/observability/src/index.mjs';
import { executeSteps } from '../packages/workflow-runtime/src/index.mjs';
import { DeterministicModel, LocalModelGateway } from '../packages/model-gateway/src/index.mjs';

const contextManifest = {
  id: 'ctx_observe',
  manifestFingerprint: `sha256:${'a'.repeat(64)}`,
  assemblyFingerprint: `sha256:${'b'.repeat(64)}`,
  compilerVersion: '0.2.0',
  assemblyPolicyVersion: '1.0.0',
  assemblyPolicyFingerprint: `sha256:${'c'.repeat(64)}`,
  selectedCount: 2,
  excludedCount: 1
};
const tokenLikeFixture = ['sk', 'abcdefghijklmnopqrstuvwxyz'].join('-');

const outputSchema = {
  type: 'array',
  minItems: 3,
  items: {
    type: 'object',
    required: ['rank', 'angle', 'hook', 'evidenceIds'],
    properties: {
      rank: { type: 'integer' },
      angle: { type: 'string' },
      hook: { type: 'string' },
      evidenceIds: { type: 'array', items: { type: 'string' } }
    }
  }
};

test('observability attributes are stable and redact private bodies, paths, and secret-shaped values', () => {
  const attrs = sanitizeAttributes({
    correlationId: 'req_observe_000000',
    prompt: 'do not emit',
    requestBody: 'do not emit',
    localPath: '/Users/rebel/private.txt',
    apiToken: tokenLikeFixture,
    'model.provider': 'provider:native:model:deterministic',
    'context.selected_count': 2
  });
  assert.equal(attrs.prompt, undefined);
  assert.equal(attrs.requestBody, undefined);
  assert.equal(attrs.localPath, undefined);
  assert.equal(attrs.apiToken, undefined);
  assert.equal(attrs['model.provider'], 'provider:native:model:deterministic');
  assert.equal(attrs['context.selected_count'], 2);
});

test('workflow runtime emits one trace with child step spans and safe attributes', async () => {
  const exporter = new InMemorySpanExporter();
  const telemetry = createTelemetry({ exporter, clock: () => '2026-06-20T00:00:00.000Z' });
  const traceContext = createTraceContext({ correlationId: 'req_trace_000000', runId: 'run_trace', workspaceId: 'ws_local' });
  const result = await executeSteps({
    runId: 'run_trace',
    workspaceId: 'ws_local',
    workflowId: 'workflow:test',
    workflowVersion: '0.1.0',
    correlationId: 'req_trace_000000',
    traceContext,
    telemetry,
    steps: [
      {
        id: 'collect',
        kind: 'deterministic',
        timeoutMs: 50,
        retry: { maxAttempts: 1 },
        run: async ({ traceContext: stepTraceContext }) => ({ traceId: stepTraceContext.traceId })
      }
    ]
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.traceContext.traceId, traceContext.traceId);
  assert.equal(exporter.spans.length, 2);
  assert.equal(new Set(exporter.spans.map((span) => span.traceId)).size, 1);
  assert(exporter.spans.some((span) => span.name === 'oaf.workflow.run'));
  assert(exporter.spans.some((span) => span.name === 'oaf.workflow.step'));
  assert(!JSON.stringify(exporter.spans).includes('/Users/rebel'));
});

test('model gateway emits safe OpenTelemetry-compatible spans without prompt or output bodies', async () => {
  const exporter = new InMemorySpanExporter();
  const telemetry = createTelemetry({ exporter, clock: () => '2026-06-20T00:00:00.000Z' });
  const gateway = new LocalModelGateway({
    providers: [new DeterministicModel({ clock: () => '2026-06-20T00:00:00.000Z' })],
    clock: () => '2026-06-20T00:00:00.000Z'
  });
  const result = await gateway.generateStructured({
    requestId: 'modelreq_observe',
    correlationId: 'req_model_observe',
    workspaceId: 'ws_local',
    actorId: 'agent:test',
    objective: 'Observe model boundary',
    prompt: `Do not leak ${tokenLikeFixture} or raw context bodies.`,
    contextManifest,
    context: {
      budget: { used: 10 },
      selected: [
        { id: 'obs_a', kind: 'observation', text: 'failed tool retries recovery checklist', score: 1 },
        { id: 'obs_b', kind: 'observation', text: 'boring workflow support triage local-first', score: 1 }
      ]
    },
    outputSchema,
    outputSchemaName: 'test.recommendations',
    outputSchemaVersion: '1.0.0'
  }, { telemetry, traceContext: createTraceContext({ correlationId: 'req_model_observe', workspaceId: 'ws_local' }) });
  assert.equal(result.validation.valid, true);
  assert.equal(exporter.spans.length, 1);
  assert.equal(exporter.spans[0].attributes['model.provider'], 'provider:native:model:deterministic');
  assert.equal(exporter.spans[0].attributes['context.manifest_id'], 'ctx_observe');
  const serialized = JSON.stringify(exporter.spans);
  assert(!serialized.includes('Do not leak'));
  assert(!serialized.includes('raw context bodies'));
  assert(!serialized.includes(tokenLikeFixture));
});

test('optional OTLP HTTP exporter is explicit loopback-only and serializes OTEL JSON shape', async () => {
  assert.throws(() => new OtlpHttpJsonExporter({ endpoint: 'https://collector.example.test' }), /loopback/);
  const calls = [];
  const exporter = new OtlpHttpJsonExporter({
    endpoint: 'http://127.0.0.1:4318',
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 200 };
    }
  });
  const telemetry = createTelemetry({ exporter, clock: () => '2026-06-20T00:00:00.000Z' });
  const span = telemetry.startSpan('oaf.control-api.route', routeSpanAttributes({
    operationId: 'getDashboard',
    method: 'GET',
    route: '/api/dashboard',
    statusCode: 200,
    workspaceId: 'ws_local',
    correlationId: 'req_route_000000'
  }), createTraceContext({ correlationId: 'req_route_000000', workspaceId: 'ws_local' }));
  span.end('ok', modelSpanAttributes({ provider: 'provider:native:model:deterministic' }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls[0].url, 'http://127.0.0.1:4318/v1/traces');
  assert.equal(calls[0].body.resourceSpans[0].scopeSpans[0].spans[0].name, 'oaf.control-api.route');
});
