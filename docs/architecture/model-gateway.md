# Model Gateway

`packages/model-gateway` owns provider-neutral local model orchestration. It is
not a hosted router and it does not grant tools, filesystem access, network
access, memory writes, or publishing authority.

## Implemented Local Contract

OAF-013 implements:

- deterministic provider selection from capability profiles;
- structured-output validation with the dependency-free protocol schema
  validator;
- one bounded repair call to the same selected provider and model;
- timeout and cancellation propagation into providers;
- safe model request, completion, and failure events;
- prompt, output-schema, output, and context-manifest fingerprints.

The gateway requires every structured call to reference a persisted OAF-012
context manifest by manifest ID, manifest fingerprint, assembly fingerprint,
compiler version, and assembly policy version.

## Native Providers

The deterministic native provider remains the offline default. It is an
in-process fixture generator for demos and regression tests, not a general
language model.

The Ollama provider is explicit, disabled by default, loopback HTTP only, and
requires a separately installed Ollama process plus a named local model. A
missing model or unavailable process returns a local error; there is no hosted
fallback. Health checks expose bounded local model metadata from Ollama's tag
list, including family, parameter size, and quantization level when Ollama
reports them; OAF does not train, download, auto-select, inspect, certify, or
change model weights.

## Event Safety

Model events record provider ID, model name, prompt fingerprint, output-schema
fingerprint, context-manifest reference, usage, validation result, and repair
attempt count. They do not record raw prompts, selected context bodies, model
outputs, credentials, provider URLs, local paths, or hidden reasoning.

## Unsupported

Hosted providers, cloud API keys, LiteLLM deployment, silent fallback, model
downloads, embeddings, vector databases, graph databases, browser automation,
tool calling, external connectors, and publishing remain unsupported.

Optional semantic setup API calls are a separate, explicit user-owned network
executor in `packages/semantic-setup`; they are not `OAF_MODEL_MODE`, do not
extend this local gateway, and never act as a silent fallback. That executor
requires per-run network consent, reads credentials only through its dedicated
environment-reference helper, bounds the request/response, and normalizes
untrusted output into source-bound pending candidates.
