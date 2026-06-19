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
- `context.*`
- `memory.*`
- `tool.*`
- `approval.*`
- `artifact.*`
- `evaluation.*`
- `adapter.*`
- `policy.*`

## Compatibility

Readers reject unknown major versions clearly and preserve unknown additive fields. Schema changes follow RFC 0001. Projection migrations are separate from event schema compatibility.
