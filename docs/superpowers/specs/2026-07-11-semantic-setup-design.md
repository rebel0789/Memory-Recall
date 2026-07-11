# Semantic Setup Design

## Outcome

Memory Recall gains an optional semantic setup flow that turns a bounded set of high-signal workspace documents into **pending**, source-bound memory proposals. It supports two executor paths:

1. A task packet for the active coding-agent harness (Codex, Claude Code, Cursor, or a generic agent).
2. An explicit user-owned API call through a Gemini preset or a supplied OpenAI-compatible endpoint.

Neither path activates a fact, installs a harness configuration, stores an API key, or changes the existing local-only default. \`recall setup\` remains an initialization command that does not scan or send repository material.

## Why this shape

Graphify separates local structural extraction from optional semantic work. Recall already owns the stronger downstream boundary: temporal fact proposals, review, source provenance, and explicit activation. The new feature keeps structural mapping local and deterministic, then treats all LLM output as untrusted candidate data.

The direct API executor is deliberately separate from \`packages/model-gateway\`. That gateway remains the local deterministic/Ollama model path; semantic setup is a narrow, one-shot, user-consented network operation, not a silent cloud fallback or a general hosted-model router.

## User flows

### Harness path

\`\`\`text
recall semantic plan --harness codex --root . --dry-run
recall semantic task --harness codex --root .
active harness reads the bounded task and returns JSON
recall semantic import --input semantic-result.json --root . --sqlite .local/memory.sqlite
recall memory review --root . --sqlite .local/memory.sqlite
recall memory approve <mpq_id> --root . --sqlite .local/memory.sqlite
\`\`\`

\`semantic task\` generates a self-contained task packet. It does not claim that the CLI can inherit or invoke an already-running Codex or Claude session. The harness itself chooses how to execute the task, including subagent fan-out.

### Direct API path

\`\`\`text
GEMINI_API_KEY=... recall semantic run \
  --provider gemini \
  --allow-network \
  --root . \
  --sqlite .local/memory.sqlite
\`\`\`

For an OpenAI-compatible endpoint, the user supplies a model, endpoint, and the **name** of an environment variable containing the key. The key is never accepted as an argument, written to disk, included in reports, events, errors, or proposal payloads.

\`\`\`text
MY_KEY=... recall semantic run \
  --provider openai-compatible \
  --endpoint https://example.invalid/v1/chat/completions \
  --model example-small \
  --api-key-env MY_KEY \
  --allow-network \
  --root . \
  --sqlite .local/memory.sqlite
\`\`\`

The API mode always requires \`--allow-network\`; without it, Recall fails before reading a credential or making a request. It has a bounded source packet, bounded output token request, one request, one timeout, no automatic retry, and no fallback to another provider.

## Architecture

\`\`\`text
deterministic document selection
        |
        v
source packet (locators, byte hashes, bounded bodies, fingerprint)
        |
        +--> harness task --------------------+
        |                                     |
        +--> direct API executor ------------+|
                                              vv
                         schema-validated semantic result
                                              |
                                              v
                       source-id binding + secret/path checks
                                              |
                                              v
                   pending temporal fact proposals only
                                              |
                                              v
                     explicit ID review and source recheck
                                              |
                                              v
                                   active temporal fact
\`\`\`

### Source packet

The new \`packages/semantic-setup\` package owns packet construction and result normalization. Its v1 selection is documents/config only: high-signal root files plus bounded \`docs/adr\` and \`docs/architecture\` Markdown. Code structure continues to come from the existing deterministic source graph; raw source code does not leave the machine through semantic setup v1.

Each selected source has a stable \`sourceId\`, a \`workspace://\` locator, its full-file SHA-256 byte hash, and a bounded body. Symlink escapes, non-regular files, files over the cap, secret-shaped material, generated Recall outputs, and unsupported encodings are skipped with a reason. Default ceilings are:

- 8 source files;
- 16 KiB per source;
- 64 KiB total packet body;
- 24 normalized facts;
- 1,024 requested output tokens;
- 30 seconds for a direct API request.

The packet fingerprint covers packet version, source IDs, locators, hashes, and selected content. It never appears with raw bodies in a normal report.

### Executors

\`harness\` and \`api\` implement one small executor contract: produce a JSON result with the packet fingerprint and facts that reference only packet \`sourceId\` values. The result cannot provide source locators, hashes, absolute paths, supersession instructions, policy changes, or authority grants.

The harness executor is a generated task, not a subprocess. It tells an active agent to treat document text as untrusted data, return JSON only, use bounded parallel subagents where supported, and leave facts as candidate claims.

The API executor uses the standard OpenAI-compatible chat-completions shape. It supports a pinned Gemini endpoint preset and a user-supplied compatible HTTPS endpoint (or loopback HTTP endpoint). It parses the response defensively, does not echo provider response bodies on failure, and records only bounded usage/model metadata when supplied by the response. Cost is intentionally reported as unknown rather than estimated or claimed.

### Proposal normalization and activation

The normalizer resolves every output \`sourceId\` through the locally-built packet. It recomputes source hashes from the workspace before enqueueing and rejects the entire result if the packet or any bound source changed.

Every resulting queue record uses:

- \`proposalOrigin: "semantic-setup"\`;
- \`approvalMode: "explicit-id-only"\`;
- \`extractionConfidence: "inferred"\`;
- scalar executor, model, input/output fingerprint, schema-version, and bounded usage metadata.

No raw prompt, source body, model output, endpoint URL, API key, provider SDK object, or model reasoning is persisted. Semantic output cannot supersede an existing active fact. A human must make that later temporal decision.

\`memory approve --all\` and \`--all-from\` exclude explicit-ID-only semantic proposals. An explicit \`memory approve <mpq_id>\` re-reads the source and requires its bytes to match the stored hash before the SQLite transaction can materialize a fact. A changed or deleted source leaves the proposal pending and creates no active memory.

## Safety and failure behavior

- Local-only is still the default: plan/task paths make zero model and network calls.
- Direct API mode is an interactive, user-owned consent boundary. It requires \`--allow-network\`, has no retry, and never silently changes executor/provider.
- API credentials are environment-only references; no plaintext key path is introduced.
- Source text is untrusted prompt material. The task and API prompt delimit it as data and request strict JSON only.
- Invalid output, missing keys, endpoint violations, timeouts, provider errors, stale sources, or rejected schema output produce a typed local failure and no proposal/fact write.
- MCP remains read-only and receives no semantic write tool.
- Existing generic dashboard intake is not used because it cannot prove a workspace file's byte-level provenance.

## Observability and reports

\`semantic plan\`, \`semantic run\`, and \`semantic import\` emit a schema-validated report with packet fingerprint, source counts/locators/hashes, executor kind, proposal IDs/counts, model-call/network-call counts, source bytes sent, usage when provider-supplied, and safeguards. Reports omit raw bodies, endpoint URLs, keys, prompts, model response text, and absolute paths.

No semantic-output cache is added in v1. Proposal queue fingerprints already make repeated imports idempotent, and a cache is premature until a measured repeat-run cost justifies one.

## Test strategy

- Pure package tests for source selection, packet determinism, secret/path exclusion, prompt/result schema validation, source-ID binding, and direct executor request/error behavior using a fake fetch.
- CLI integration tests for harness task/report output, API consent denial, import-to-pending behavior, bulk-approval exclusion, source-change denial, and explicit approval success.
- Protocol fixtures for safe reports and rejection of forbidden/raw fields.
- Existing MCP integrity tests remain the proof that pending semantic proposals do not appear in ordinary recall.

## Non-goals for v1

- Automatic current-session Codex/Claude invocation.
- Hidden transcript capture, automatic facts, write-capable MCP, or model fallback.
- Raw code/doc/media upload beyond the bounded document packet.
- General hosted model routing, provider billing, cache storage, embeddings, vector/graph databases, or provider-specific canonical IDs.
