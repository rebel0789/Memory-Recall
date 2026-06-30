# Canonical Event Model

Events are append-only records of transitions, not mutable application rows.

## Envelope

Every event includes schema version, event ID, workspace ID, run ID when applicable, type, actor ID, sequence, occurred time, correlation ID, causation ID, data classification, payload, and producer version.

## Rules

- Sequence is monotonic within a run.
- Event type uses lowercase dot notation.
- Payload is versioned and bounded.
- Secrets, raw credentials, cookies, and private source bodies are forbidden.
- Large data becomes an artifact reference.
- Retried external actions retain one idempotency identity.
- Events are not edited; corrective events are appended.

## Core event families

- `run.*`
- `step.*`
- `timer.*`
- `context.*`
- `memory.*`
- `tool.*`
- `approval.*`
- `artifact.*`
- `evaluation.*`
- `adapter.*`
- `policy.*`

## Durable workflow events

The durable SQLite runtime appends projection changes and events in one SQLite
transaction. Recovery uses monotonic workspace/run sequence numbers and never
re-emits `run.created` or completed-step events after restart.

OAF-014 adds `run.suspended`, `run.resumed`, `step.retry_scheduled`,
`timer.scheduled`, and `timer.fired`. Payloads contain bounded IDs, state
reasons, due times, attempts, and fingerprints only. They do not contain raw
workflow outputs, prompts, context bodies, credentials, local paths, SQL, stack
traces, or hidden reasoning.

## Compatibility

Readers reject unknown major versions clearly and preserve unknown additive fields. Schema changes follow RFC 0001. Projection migrations are separate from event schema compatibility.
