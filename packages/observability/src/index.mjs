import { createHash, randomUUID } from 'node:crypto';

export const OBSERVABILITY_VERSION = '1.0.0';
export const DEFAULT_SERVICE_NAME = 'open-agent-fabric';
export const DEFAULT_SERVICE_VERSION = '0.2.0-dev';

const BLOCKED_KEY_SEGMENTS = new Set(['authorization', 'body', 'content', 'cookie', 'credential', 'credentials', 'database', 'dsn', 'header', 'headers', 'hidden', 'localpath', 'password', 'path', 'prompt', 'reasoning', 'secret', 'secrets', 'sql', 'text', 'token', 'tokens', 'url', 'urls']);
const SECRET_VALUE = /sk-[A-Za-z0-9_-]{12,}|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|AKIA[0-9A-Z]{16}|gho_[A-Za-z0-9_]{12,}/;
const LOCAL_PATH = /(?:^|[\s"'=])\/Users\/|(?:^|[\s"'=])\/private\/|(?:^|[\s"'=])\/var\/folders\//;
const TRACE_ID = /^[a-f0-9]{32}$/;
const SPAN_ID = /^[a-f0-9]{16}$/;

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function hashHex(value, length) {
  return createHash('sha256').update(typeof value === 'string' ? value : stableStringify(value)).digest('hex').slice(0, length);
}

function randomHex(bytes) {
  return randomUUID().replace(/-/g, '').slice(0, bytes * 2);
}

function safeString(value, max = 160) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, max);
}

function safeValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.slice(0, 16).map(safeValue).filter((item) => item !== null);
  const text = safeString(value);
  if (SECRET_VALUE.test(text) || LOCAL_PATH.test(text)) return '[redacted]';
  return text;
}

export function sanitizeAttributes(attributes = {}) {
  const output = {};
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (blockedAttributeKey(key)) continue;
    const sanitized = safeValue(value);
    if (sanitized !== null) output[key] = sanitized;
  }
  return Object.freeze(output);
}

function blockedAttributeKey(key) {
  return String(key ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1.$2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .some((segment) => BLOCKED_KEY_SEGMENTS.has(segment.toLowerCase()));
}

export function createTraceContext({ traceId = null, spanId = null, parentSpanId = null, correlationId = null, runId = null, workspaceId = null } = {}) {
  const derivedTraceId = traceId && TRACE_ID.test(traceId) ? traceId : hashHex({ correlationId, runId, workspaceId, seed: traceId ?? 'oaf-trace' }, 32);
  const derivedSpanId = spanId && SPAN_ID.test(spanId) ? spanId : hashHex({ traceId: derivedTraceId, parentSpanId, seed: spanId ?? randomHex(8) }, 16);
  return Object.freeze({
    traceId: derivedTraceId,
    spanId: derivedSpanId,
    parentSpanId: parentSpanId && SPAN_ID.test(parentSpanId) ? parentSpanId : null,
    correlationId: correlationId ? safeString(correlationId, 128) : null,
    runId: runId ? safeString(runId, 128) : null,
    workspaceId: workspaceId ? safeString(workspaceId, 128) : null
  });
}

export function childTraceContext(parent = {}, attributes = {}) {
  return createTraceContext({
    traceId: parent.traceId,
    parentSpanId: parent.spanId,
    correlationId: attributes.correlationId ?? parent.correlationId,
    runId: attributes.runId ?? parent.runId,
    workspaceId: attributes.workspaceId ?? parent.workspaceId
  });
}

export class NoopSpanExporter {
  async export() {
    return { status: 'dropped', count: 0 };
  }
}

export class InMemorySpanExporter {
  constructor() {
    this.spans = [];
  }

  async export(spans = []) {
    this.spans.push(...spans.map((span) => structuredClone(span)));
    return { status: 'stored', count: spans.length };
  }

  reset() {
    this.spans.length = 0;
  }
}

export class OtlpHttpJsonExporter {
  constructor({ endpoint, fetchImpl = globalThis.fetch } = {}) {
    const parsed = parseLoopbackHttpEndpoint(endpoint);
    if (!parsed) {
      throw new Error('otlp exporter endpoint must be explicit loopback HTTP');
    }
    if (typeof fetchImpl !== 'function') throw new Error('otlp exporter requires fetch');
    this.endpoint = parsed.href.endsWith('/v1/traces') ? parsed.href : `${parsed.href.replace(/\/$/, '')}/v1/traces`;
    this.fetchImpl = fetchImpl;
  }

  async export(spans = []) {
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(toOtlpJson(spans))
    });
    return { status: response.ok ? 'exported' : 'failed', count: spans.length, statusCode: response.status };
  }
}

export function createTelemetry({ serviceName = DEFAULT_SERVICE_NAME, serviceVersion = DEFAULT_SERVICE_VERSION, resource = {}, exporter = null, clock = () => new Date().toISOString() } = {}) {
  const spanExporter = exporter ?? new NoopSpanExporter();
  const safeResource = sanitizeAttributes({
    'service.name': serviceName,
    'service.version': serviceVersion,
    'telemetry.sdk.name': 'open-agent-fabric',
    'telemetry.sdk.version': OBSERVABILITY_VERSION,
    ...resource
  });
  return Object.freeze({
    resource: safeResource,
    startSpan(name, attributes = {}, parentContext = {}) {
      const context = childTraceContext(parentContext, attributes);
      const startedAt = clock();
      const baseAttributes = sanitizeAttributes({
        'oaf.observability.version': OBSERVABILITY_VERSION,
        ...attributes,
        'oaf.correlation_id': attributes.correlationId ?? parentContext.correlationId,
        'oaf.run_id': attributes.runId ?? parentContext.runId,
        'oaf.workspace_id': attributes.workspaceId ?? parentContext.workspaceId
      });
      let ended = false;
      return {
        traceContext: context,
        end(status = 'ok', endAttributes = {}) {
          if (ended) return null;
          ended = true;
          const endedAt = clock();
          const span = Object.freeze({
            schemaVersion: '1.0.0',
            name: safeString(name, 160),
            kind: 'internal',
            traceId: context.traceId,
            spanId: context.spanId,
            parentSpanId: context.parentSpanId,
            startTimeUnixNano: isoToUnixNano(startedAt),
            endTimeUnixNano: isoToUnixNano(endedAt),
            status: status === 'error' ? { code: 'ERROR' } : { code: 'OK' },
            attributes: sanitizeAttributes({ ...baseAttributes, ...endAttributes, 'oaf.status': status }),
            resource: safeResource
          });
          void spanExporter.export([span]).catch(() => {});
          return span;
        }
      };
    },
    async flush() {
      return spanExporter.flush?.() ?? { status: 'noop' };
    },
    exporter: spanExporter
  });
}

export function createTelemetryFromEnv(env = process.env, options = {}) {
  if (env.OAF_OTEL_EXPORTER === 'otlp-http') {
    return createTelemetry({
      ...options,
      exporter: new OtlpHttpJsonExporter({ endpoint: env.OAF_OTEL_EXPORTER_OTLP_ENDPOINT, fetchImpl: options.fetchImpl })
    });
  }
  if (options.exporter) return createTelemetry(options);
  return createTelemetry(options);
}

export function routeSpanAttributes({ operationId, method, route, statusCode, workspaceId, correlationId }) {
  return sanitizeAttributes({
    'oaf.boundary': 'control-api',
    'oaf.operation': operationId,
    'http.request.method': method,
    'http.route': route,
    'http.response.status_code': statusCode,
    workspaceId,
    correlationId
  });
}

export function workflowSpanAttributes({ runId, workflowId, workflowVersion, stepId, attempt, kind, status, workspaceId, correlationId }) {
  return sanitizeAttributes({
    'oaf.boundary': stepId ? 'workflow.step' : 'workflow.run',
    'oaf.operation': stepId ?? workflowId ?? 'workflow',
    'workflow.id': workflowId,
    'workflow.version': workflowVersion,
    'workflow.step_id': stepId,
    'workflow.step_kind': kind,
    'workflow.attempt': attempt,
    status,
    runId,
    workspaceId,
    correlationId
  });
}

export function modelSpanAttributes({ provider, model, contextManifest, outputSchema, validation, repair, usage, correlationId, workspaceId }) {
  return sanitizeAttributes({
    'oaf.boundary': 'model.gateway',
    'model.provider': provider,
    'model.name': model,
    'context.manifest_id': contextManifest?.id,
    'context.manifest_fingerprint': contextManifest?.manifestFingerprint,
    'context.selected_count': contextManifest?.selectedCount,
    'context.excluded_count': contextManifest?.excludedCount,
    'model.output_schema_name': outputSchema?.name,
    'model.output_schema_version': outputSchema?.version,
    'model.validation_valid': validation?.valid,
    'model.repair_attempts': repair?.attempts,
    'model.input_tokens': usage?.inputTokens,
    'model.output_tokens': usage?.outputTokens,
    workspaceId,
    correlationId
  });
}

export function toolSpanAttributes({ toolId, toolVersion, operation, sideEffectClass, sandbox, policyDecisionId, policyVersion, status, correlationId, workspaceId, runId, stepId }) {
  return sanitizeAttributes({
    'oaf.boundary': 'tool.registry',
    'tool.id': toolId,
    'tool.version': toolVersion,
    'tool.operation': operation,
    'tool.side_effect_class': sideEffectClass,
    'tool.sandbox': sandbox,
    'policy.decision_id': policyDecisionId,
    'policy.version': policyVersion,
    status,
    correlationId,
    workspaceId,
    runId,
    stepId
  });
}

export function toOtlpJson(spans = []) {
  return {
    resourceSpans: [{
      resource: { attributes: Object.entries(spans[0]?.resource ?? {}).map(([key, value]) => ({ key, value: otlpValue(value) })) },
      scopeSpans: [{
        scope: { name: 'open-agent-fabric', version: OBSERVABILITY_VERSION },
        spans: spans.map((span) => ({
          traceId: span.traceId,
          spanId: span.spanId,
          parentSpanId: span.parentSpanId ?? undefined,
          name: span.name,
          kind: 1,
          startTimeUnixNano: span.startTimeUnixNano,
          endTimeUnixNano: span.endTimeUnixNano,
          status: { code: span.status.code === 'ERROR' ? 2 : 1 },
          attributes: Object.entries(span.attributes ?? {}).map(([key, value]) => ({ key, value: otlpValue(value) }))
        }))
      }]
    }]
  };
}

function parseLoopbackHttpEndpoint(endpoint) {
  if (typeof endpoint !== 'string') return null;
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== 'http:') return null;
    if (!['127.0.0.1', 'localhost'].includes(parsed.hostname)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function otlpValue(value) {
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number' && Number.isInteger(value)) return { intValue: String(value) };
  if (typeof value === 'number') return { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(otlpValue) } };
  return { stringValue: safeString(value, 512) };
}

function isoToUnixNano(value) {
  const ms = Date.parse(value);
  return String(BigInt(Number.isFinite(ms) ? ms : Date.now()) * 1_000_000n);
}
