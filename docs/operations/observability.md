# Observability

Instrument API, workflow, context, model, tool, policy, storage, and adapter boundaries. Propagate workspace-safe correlation and trace IDs.

## Record

- operation and version;
- run, step, attempt, workflow version;
- duration, status, retry, timeout;
- context tokens selected/excluded, not private bodies;
- model capabilities, usage, validation, not prompts by default;
- tool ID, policy decision, side-effect class, not secret values;
- storage operation and result, not database URLs.

## Redaction

Credentials, cookies, authorization headers, source bodies, private prompts, and user personal data are excluded. Debug capture is explicit, time-limited, classified, and local by default.

OpenTelemetry export is optional. The offline profile uses no-op or console summaries.

## OAF-025 implementation

`packages/observability` provides dependency-free OpenTelemetry-compatible span
records. The default telemetry sink is no-op, so standard bootstrap and CI stay
offline. Tests use the in-memory exporter. The optional OTLP HTTP exporter is
explicit and loopback-only; set `OAF_OTEL_EXPORTER=otlp-http` and
`OAF_OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318` to send JSON traces to
the local collector in `deploy/otel/collector.yaml`.

Implemented boundaries:

- Control API route spans include route, method, status, operation,
  correlation ID, and workspace ID.
- Workflow spans propagate one run trace into child step spans.
- Model spans include provider/model, context manifest reference, output schema,
  validation, repair attempts, and token usage.
- Tool spans include tool/version/operation, side-effect class, sandbox, policy
  decision, and status.

Redaction is enforced before export. Attribute keys for prompts, bodies, source
content, text, credentials, cookies, authorization, secrets, tokens, local
paths, URLs, SQL, and hidden reasoning are dropped. Secret-shaped and local-path
values are redacted.

## OAF-029 diagnostics

`packages/operations` provides a local diagnostics report helper for backup,
restore, upgrade, rollback, and incident workflows. It records bounded health,
incident, and log summaries only after redaction. It does not include raw
prompts, outputs, source bodies, credentials, provider URLs, local paths, SQL,
cookies, tokens, authorization headers, or hidden reasoning.
