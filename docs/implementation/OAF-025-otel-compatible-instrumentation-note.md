# OAF-025 OpenTelemetry-Compatible Instrumentation Note

OAF-025 adds dependency-free, privacy-safe telemetry primitives that emit
OpenTelemetry-compatible span records without changing the offline default.

## Instrumentation

- `packages/observability` defines trace contexts, child span propagation,
  stable attribute builders, redaction, no-op telemetry, in-memory test export,
  and an explicit loopback-only OTLP HTTP JSON exporter.
- Control API route spans include route, method, status code, operation,
  workspace ID, and correlation ID.
- Workflow runtime spans propagate one run trace into child step spans.
- Content Intelligence passes workflow step trace context into the model
  gateway.
- Model gateway spans include provider/model, context manifest reference,
  output schema metadata, validation state, repair attempts, and token usage.
- Tool registry spans include tool/version/operation, side-effect class,
  sandbox, policy decision metadata, and status.

## Redaction

Telemetry drops attribute keys for prompts, request or source bodies, content,
text, credentials, cookies, authorization, secrets, tokens, local paths, URLs,
SQL, and hidden reasoning. Secret-shaped and local-path values are redacted
before export.

## Export Modes

The default exporter is no-op. Tests use `InMemorySpanExporter`. OTLP HTTP
export requires explicit local configuration and only accepts loopback
endpoints such as `http://127.0.0.1:4318`.

## Boundaries

OAF-025 does not add hosted telemetry, default network export, external
collectors, raw body capture, prompt or output capture, browser automation,
external adapters, external writes, publishing, or production monitoring.
