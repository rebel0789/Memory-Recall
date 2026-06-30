# Local-First Contract

Local-first means the useful core runs without an account, API key, or network. It does not mean every optional integration is offline.

## Requirements

- deterministic model mode works offline;
- network defaults to denied;
- any networked model or adapter is explicit in UI and events;
- no silent fallback from local to hosted inference;
- workspace export is complete and provider-neutral;
- local state paths and retention are visible;
- uninstall does not strand data in a proprietary format.

## Local model strategy

Support explicit local endpoints and native adapters only behind
`ModelGateway`. Capability discovery, structured-output limitations, context
length, tool support, latency, and resource requirements are recorded. A
missing local model yields an actionable error, not a cloud call.

OAF-013 keeps deterministic mode as the offline default and adds a
capability-aware local gateway contract. Structured calls require a persisted
context manifest reference and emit safe fingerprints instead of raw prompts or
outputs. The Ollama provider remains explicit, disabled by default,
loopback-only, and never falls back to hosted inference.

## Local durable workflows

OAF-014 adds an explicit local durable workflow mode backed by Node 22
`node:sqlite`. The default product path remains offline and deterministic; the
durable provider adds `.local/workflows.sqlite` only when selected by tests,
smoke commands, or composition. It does not probe the network, start a hosted
orchestration service, download workflow code, or enable external writes.
