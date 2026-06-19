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
