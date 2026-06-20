# OAF-013 Local Model Gateway Implementation Note

## Current State

OAF-012 persists a durable context manifest before model work. The current
model surface is still a thin deterministic generator in
`packages/model-gateway` plus an explicit loopback Ollama native provider.
The content workflow passes selected context directly to that generator.

The existing deterministic path is useful as an offline conformance baseline,
but the gateway boundary does not yet own provider selection, structured output
validation, bounded repair, timeout propagation, safe model events, or stable
model-call metadata.

## Target Split

OAF-013 keeps provider implementations behind `ModelGatewayPort` and moves
shared orchestration into `packages/model-gateway`:

- provider capability profiles and deterministic provider selection;
- canonical generation request and result envelopes;
- stable prompt, schema, output, and context-manifest fingerprints;
- structured output parsing and schema validation;
- at most one repair call to the same selected provider and model;
- timeout and cancellation propagation into the selected provider;
- safe model request/completion/failure event payloads.

Native deterministic and Ollama providers remain conformance baselines. The
deterministic provider stays enabled by default for offline bootstrap. Ollama
stays disabled by default and can be selected only explicitly with a loopback
HTTP base URL and a named local model.

## Context Manifest Linkage

Every structured model call must reference the persisted OAF-012 manifest by
ID, manifest fingerprint, assembly fingerprint, compiler version, and assembly
policy version. The provider may receive the assembled prompt needed for local
generation, but events and gateway metadata record only safe fingerprints,
counts, versions, provider/model IDs, and validation outcomes.

## Non-Goals

This task does not add hosted model providers, cloud API keys, LiteLLM
deployment, silent fallback, model downloads, publishing, external connectors,
vector databases, graph databases, embeddings, browser automation, tool calling,
or unrelated UI work.
