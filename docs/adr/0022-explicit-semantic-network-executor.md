# ADR 0022: Explicit semantic network executor

## Status

Accepted for the optional semantic setup flow.

## Decision

Direct semantic setup API calls live in `packages/semantic-setup`, outside the
local `packages/model-gateway`. The API executor is a one-shot, user-consented
data-egress operation and is never a hosted-model fallback for local model
execution.

Before any credential lookup or request, the caller must run
`evaluateSemanticNetworkConsent({ allowNetwork, endpoint, packet })`. Credentials
are read separately with `readSemanticApiCredential(config, env)` and are never
accepted as endpoint options, persisted, logged, or included in reports.

The executor permits HTTPS endpoints and literal loopback HTTP only
(`localhost`, `127.0.0.1`, or `[::1]`). It rejects URL credentials, queries,
fragments, non-loopback HTTP, redirects, retries, and provider fallback. Each
execution makes exactly one POST with a 30-second timeout, `stream: false`, and
at most 1,024 requested output tokens. Response bytes are bounded before JSON
parsing; provider response bodies and transport errors are replaced by fixed
local error codes.

Provider output is untrusted. The executor extracts strict JSON and passes it
through the packet-bound semantic-result schema and normalizer. The result can
only create inferred, explicit-review-only candidate facts; it cannot grant
authority, set supersession, or activate memory.

## Consequences

- Local deterministic/Ollama model behavior remains unchanged and offline by
  default.
- Network consent is explicit per invocation and cannot be inferred from an
  environment variable or provider configuration.
- API provider usage and endpoint details remain outside canonical events,
  reports, and proposal payloads.
