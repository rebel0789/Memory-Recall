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

Support explicit OpenAI-compatible local endpoints and native adapters only behind `ModelGateway`. Capability discovery, structured-output limitations, context length, tool support, latency, and resource requirements are recorded. A missing local model yields an actionable error, not a cloud call.
